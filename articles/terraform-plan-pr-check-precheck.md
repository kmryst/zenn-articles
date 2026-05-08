---
title: "GitHub Actions の PR Check に terraform plan を追加する前に確認すること"
emoji: "📋"
type: "tech"
topics: ["terraform", "githubactions", "aws", "iam", "oidc"]
published: true
---

PR Check に `terraform plan` を追加しようとするとき、「ワークフローを書けばいいだけでは？」と思いがちですが、実際には確認すべき前提が多数あります。

この記事は、PR Check に `terraform plan` を安全に組み込むために**実装前に確認すべき5つの観点**を整理したものです。「何から手をつけるかわからない」「やってみたら詰まった」という方に向けて、設計上の判断ポイントをまとめています。

想定読者は、Terraform + GitHub Actions + AWS OIDC の構成で PR 連動 plan を組もうとしている方です。

特に、deploy / destroy 用の強い Role を PR から使い回さず、plan 専用 Role を分けたい場合の事前チェックリストとして読めるようにしています。

:::message
この記事は個人開発ポートフォリオ [terraform-hannibal](https://github.com/kmryst/terraform-hannibal)（ECS Fargate + Terraform + GitHub Actions）での実装前調査をもとにしています。
:::

## この記事での前提

同じ `terraform plan` の PR Check でも、運用前提によって設計は変わります。この記事では次の前提で考えます。

| 観点 | 前提 |
|---|---|
| チーム規模 | 1人開発・小規模運用 |
| 対象環境 | dev 環境のみ。通常は destroy 済み |
| 実行者 | GitHub Actions が PR plan 専用 Role を OIDC で assume |
| plan の位置づけ | レビュー補助。apply / destroy の代替ではない |
| 失敗時の扱い | plan 失敗は原因を確認するが、環境変更は実行しない |

本番環境や共有 staging で使う場合は、plan 用 Role の権限、artifact の保存範囲、required status check 化の方針をより厳しく見直す必要があります。

## 先に結論

PR plan を安全に動かすには、ワークフローを書く前に次の5つが揃っていることを確認します。

| # | 観点 | 確認内容 |
|---|---|---|
| 1 | **backend/state** | S3 backend に接続できる IAM 権限があるか |
| 2 | **OIDC 認証** | PR 専用の IAM Role が存在するか（`pull_request` event 限定の Trust Policy） |
| 3 | **IAM 権限** | plan に必要な read 系権限のみに絞った policy があるか |
| 4 | **fork PR** | fork からの PR で plan を skip する条件が書けているか |
| 5 | **plan 結果の秘匿情報** | sensitive 変数や ARN がログに出ないように制御できているか |

以下でそれぞれを詳しく説明します。

この5つは「全部そろったら安全」というより、**どこで止めるかを事前に決めるための確認項目**です。たとえば fork PR は plan job を skip する、state 読み取り権限がない場合は OIDC 認証より前に設計を戻す、binary plan は artifact に上げない、というように failure mode（失敗時の止まり方）を決めておきます。

## 1. backend/state の確認

`terraform plan` は必ず S3 backend に接続して state を読みます。既存の validate ステップが `-backend=false` を使っていても、plan では backend 接続が必要です。

また、S3 backend の state locking は今は S3 lockfile（`use_lockfile = true`）が推奨です。既存構成で `dynamodb_table` を使っている場合は、その方式が deprecated であることを前提に、PR plan 実装とあわせて移行方針も確認しておきます。

```hcl
terraform {
  backend "s3" {
    bucket       = "YOUR_TERRAFORM_STATE_BUCKET"
    key          = "environments/dev/terraform.tfstate"
    region       = "ap-northeast-1"
    use_lockfile = true
    encrypt      = true
  }
}
```

```yaml
# validate（backend不要）
- run: terraform validate -no-color
  working-directory: terraform/environments/dev

# plan（backend接続が必要）
- run: |
    terraform init -input=false
    terraform plan -lock=false -refresh=false -out=tfplan
```

`-input=false` は CI で対話プロンプトを無効にするために必要です。省略すると backend 設定が不完全な場合にハングします。

`-refresh=false` については次の項で説明します。

確認すべき点は次の3つです。

### backend の locking 方式を確認する

S3 backend で lock を取る方式は、主に次の2つです。

| 方式 | 設定 | 状態 |
|---|---|---|
| S3 lockfile | `use_lockfile = true` | 現在の推奨 |
| DynamoDB-based locking | `dynamodb_table = "..."` | deprecated |

新規に組む場合は S3 lockfile を使います。既存構成が DynamoDB-based locking の場合は、すぐに plan workflow へ進む前に「既存のまま一旦組むのか」「先に S3 lockfile へ移行するのか」を決めておくと、IAM 権限と障害時の見方がぶれません。

### PR plan で lock を取るか、refresh するかを決める

`terraform plan` は state を読みます。通常の手元実行や apply 前の最終確認では lock を取る意味がありますが、PR Check ではレビュー補助として扱い、deploy / destroy とぶつかった時に CI を詰まらせないため `-lock=false` を選ぶ設計もあります。

この記事では、PR plan を「最終確定値」ではなくレビュー補助として扱うため、`-lock=false` を前提にします。この場合、lock 取得用の write 権限は plan 専用 Role に付与しません。

`-refresh` についても同様に設計方針を決めます。デフォルトは `-refresh=true` で、Terraform は plan 実行前に state 内の全リソースに対して read 系 API を呼び出して実態と同期します。これは plan の精度が上がる一方、**state に含まれる全リソースへの describe/list/get 権限が plan Role に必要になります**。

| 設定 | 挙動 | PR plan での推奨 |
|---|---|---|
| `-refresh=true`（デフォルト） | 全リソースに read API を叩いて state を最新化してから差分を計算 | apply 前の最終確認向き |
| `-refresh=false` | state ファイルの内容をそのまま使って差分を計算 | PR レビュー補助向き（権限が少なくて済む） |

この記事では `-refresh=false` を前提にします。PR plan はあくまで「このコードを apply したら何が変わるか」を確認するためのものであり、インフラの現在状態との乖離（ドリフト）検出は apply 直前の plan に任せます。

```bash
# PR plan を -lock=false で実行するなら含めない
s3:PutObject       # state 書き込み
s3:DeleteObject    # state 削除
s3:PutObject       # .tflock 作成
s3:DeleteObject    # .tflock 削除
dynamodb:PutItem   # DynamoDB lock 取得
dynamodb:DeleteItem # DynamoDB lock 解放
```

逆に、PR plan でも厳密に lock を取る設計にするなら、S3 lockfile では `terraform.tfstate.tflock` への `s3:GetObject` / `s3:PutObject` / `s3:DeleteObject` が必要です。DynamoDB-based locking を使い続ける場合は、DynamoDB の lock 操作権限が必要になります。

### state ファイルには機密値が含まれる場合がある

S3 の state ファイルには RDS パスワードや ARN などの機密値が含まれることがあります。plan Role が state を読める以上、この Role を使う PR は「信頼できるもの」に限定する必要があります（fork PR の対応は後述）。

## 2. OIDC 認証の確認

既存のデプロイ用 Role（`refs/heads/main` 限定）は PR Check から assume できません。**PR 専用の IAM Role** を別途作成する必要があります。

workflow 側では、OIDC token を発行するために `id-token: write` が必要です。

```yaml
permissions:
  contents: read
  id-token: write
```

### Trust Policy の Subject は `pull_request` event に限定する

```json
{
  "Condition": {
    "StringLike": {
      "token.actions.githubusercontent.com:sub":
        "repo:YOUR_ORG/YOUR_REPO:pull_request"
    }
  }
}
```

`repo:YOUR_ORG/YOUR_REPO:*`（ワイルドカード）は使いません。これを許可するとすべての ref（push/tag/workflow_dispatch 等）から assume できてしまいます。

:::message alert
`pull_request` をワイルドカードの `*` で代用しないでください。Subject を `pull_request` event に絞ることが、plan Role のセキュリティの出発点です。
:::

### GitHub Environment と OIDC Subject の関係

plan job に GitHub Environment を設定すると OIDC Subject が変わります。

| 設定 | Subject の形 |
|---|---|
| Environment なし | `repo:org/repo:pull_request` |
| Environment あり | `repo:org/repo:environment:staging` |

plan job に Environment を付けると Trust Policy の Subject が一致しなくなるため、**plan job には Environment を設定しない**のが通常の設計です。

## 3. IAM 権限の確認

この記事のように `terraform plan -lock=false` を前提にする場合、plan に必要な権限は `read/describe/list/get` 系を中心に設計します。

**含めるもの（plan に必要な read 系）**:
- `terraform init` 用の S3 state 読み取り（`s3:GetObject`、`s3:ListBucket`）
- terraform refresh が呼ぶ describe/list/get 系
- S3 バケット属性の読み取り（注意点は後述）

**PR plan でも lock を取る場合だけ含めるもの**:
- S3 lockfile 方式: `.tflock` への `s3:GetObject` / `s3:PutObject` / `s3:DeleteObject`
- DynamoDB-based locking 方式: DynamoDB の lock 操作用権限

**含めないもの（plan には不要）**:
- `iam:PassRole`
- `s3:PutObject`/`s3:DeleteObject`（state への書き込み）
- `s3:PutObject`/`s3:DeleteObject`（`-lock=false` で実行する場合の `.tflock` 作成・削除）
- `dynamodb:PutItem`/`dynamodb:DeleteItem`（`-lock=false` で実行する場合の lock の取得・解放）
- `secretsmanager:GetSecretValue`

### S3 バケット属性の read 権限について

`terraform plan` の refresh フェーズでは、S3 バケット属性の read 権限不足で AccessDenied になることがあります。実装前には、個別 API を列挙するのか、PR plan 専用の read-only Role として `s3:Get*` / `s3:List*` まで許容するのかを決めておきます。

詳細は別記事「[terraform plan が PR のたびに AccessDenied で止まり続けた — IAM の S3 権限を個別列挙からやめた理由](/articles/iam-pr-plan-s3-read-wildcard)」で扱っています。

## 4. fork PR の確認

Trust Policy の Subject を `pull_request` event に限定しても、fork からの PR が完全にブロックされるわけではありません。**workflow 側の `if` 条件でも fork PR を skip する**必要があります。

```yaml
jobs:
  terraform-plan:
    # fork PR では skip する
    if: github.event.pull_request.head.repo.full_name == github.repository
    steps:
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ vars.PR_PLAN_ROLE_ARN }}
```

`if` 条件を書かないと、fork PR で `aws-actions/configure-aws-credentials` が実行され、OIDC token の生成を試みます（失敗しますが、不要なエラーが出る）。

:::message alert
`pull_request_target` は fork PR のコードをリポジトリの write 権限と secrets を持った状態で実行できます。悪意ある fork PR が `pull_request_target` をトリガーにすると、OIDC token の取得や secrets の漏洩につながります。plan workflow には `pull_request` を使い、`pull_request_target` は使いません。
:::

## 5. plan 結果の秘匿情報の確認

`terraform plan` の出力には、sensitive 変数の値が含まれることがあります。

### sensitive 変数は完全にはマスクされない

Terraform は `sensitive = true` の変数を `(sensitive value)` と表示しますが、**すべてのケースで完全にマスクされるわけではありません**。また、binary plan ファイル（`tfplan`）には未マスクの値が含まれます。

設計上の対処は次の2点です。

1. **binary plan ファイルは artifact に保存しない**。テキスト出力のみ保存する
2. **Job Summary に sensitive 値を出力するステップを書かない**

```yaml
- name: Save plan output
  run: |
    # テキスト出力のみ保存（binary は保存しない）
    terraform show -no-color tfplan > plan_output.txt

    # PR 上で直接 plan を確認できるように Job Summary に書き出す
    echo '```' >> "$GITHUB_STEP_SUMMARY"
    cat plan_output.txt >> "$GITHUB_STEP_SUMMARY"
    echo '```' >> "$GITHUB_STEP_SUMMARY"

# tfplan（binary）を artifact に上げない
- uses: actions/upload-artifact@v4
  with:
    name: plan-output
    path: plan_output.txt  # binary の tfplan は含めない
```

`GITHUB_STEP_SUMMARY` に書き出すと、PR の Checks タブから plan 結果を直接確認できます。artifact のダウンロードが不要になるため、レビュー補助としての実用性が上がります。sensitive 値の混入確認は `GITHUB_STEP_SUMMARY` への書き出し前に行います。

### コマンド出力の機密情報に注意する

`terraform init` や `terraform show` の出力に ARN やアカウント ID が含まれることがあります。Job Summary に出力する前に機密値が含まれていないか確認してください。

## 実装の依存関係

ワークフローを書く前に、IAM Role の作成が必要です。実装の順序は次のようになります。

```text
[前提] OIDC Provider が foundation に存在すること

1. terraform/foundation に PR plan 専用 Role を追加
   - aws_iam_role（Trust Policy: pull_request event 限定）
   - aws_iam_policy（read 系権限のみ）
   - aws_iam_role_policy_attachment
   → foundation の terraform apply を手動実行

2. pr-check.yml に plan job を追加
   - AWS 認証（OIDC）
   - terraform init（`-input=false`）
   - terraform plan（`-lock=false -refresh=false -detailed-exitcode`）
   - テキスト出力の Job Summary への書き出しと artifact 保存

`-detailed-exitcode` は CI 向けのフラグで、exit code の意味を変えます。

| exit code | 意味 |
|---|---|
| `0` | 成功・変更なし |
| `1` | エラー |
| `2` | 成功・変更あり |

このフラグがないと変更ありの plan も `0` で返るため、「差分があるか」を CI が判定できません。gate job の設計とセットで使います。

3. Job Summary に plan 結果を整形出力（後続）

4. 危険シグナルの抽出（IAM/SG/destroy/replace の検出）（後続）
```

IAM Role の作成（1）を先にやらないと、plan workflow（2）は必ず OIDC 認証で失敗します。ワークフローとインフラ変更を同じ PR に混在させると原因特定が難しくなるため、**Role の作成と workflow の実装は PR を分ける**のが安全です。

## required status check にする前に確認すること

PR plan job を追加すると、すぐに branch protection の required status check に入れたくなります。しかし、plan job は skip が正常系になる場面があります。

| ケース | plan job の扱い | required 化で起きる問題 |
|---|---|---|
| Terraform 変更なし | plan job を skip | required check が `skipped` のままだとマージできない場合がある |
| fork PR | AWS 認証を skip | セキュリティ上は正しいが、required check とは相性が悪い |
| AWS/OIDC 障害 | plan job が fail | レビュー補助なのか、マージブロックなのか判断が必要 |

この問題を避けるには、生の plan job をそのまま required にせず、**gate job** を別に置く設計が扱いやすいです。

```yaml
jobs:
  terraform-plan:
    if: github.event.pull_request.head.repo.full_name == github.repository
    # terraform plan を実行

  terraform-plan-gate:
    if: always()
    needs: terraform-plan
    runs-on: ubuntu-latest
    steps:
      - run: |
          case "${{ needs.terraform-plan.result }}" in
            success|skipped)
              exit 0
              ;;
            *)
              exit 1
              ;;
          esac
```

この gate job を required にすれば、正常な skip を success として扱いつつ、本当に plan が失敗した場合だけ止められます。

:::message
最初から required 化しない判断も有効です。運用実績が浅い段階では、plan を artifact と Job Summary のレビュー補助に留め、失敗パターンが見えてから required 化する方が安全です。
:::

## チェックリスト（実装前確認用）

```text
[ ] OIDC Provider が foundation に存在する
[ ] PR 専用 IAM Role が存在する（pull_request event の Trust Policy）
[ ] workflow に `permissions: id-token: write` がある
[ ] S3 backend の locking 方式を確認した（S3 lockfile / deprecated DynamoDB-based locking）
[ ] Role の policy に state / lock の write 系権限が含まれていない
[ ] S3 state の GetObject が policy に含まれている
[ ] terraform plan は -lock=false -refresh=false で実行する方針にした
[ ] fork PR を skip する if 条件が書いてある
[ ] binary plan ファイルを artifact に保存しない設計になっている
[ ] Job Summary に sensitive 値が混入しないことを確認した
[ ] required status check にする場合、skip を吸収する gate job を設計した
```

## ワークフロー全体像

チェックリストの項目をすべて含んだ `pr-check.yml` の骨格です。

```yaml
name: PR Check

on:
  pull_request:
    branches: [main]

jobs:
  terraform-plan:
    name: terraform plan
    runs-on: ubuntu-latest
    # fork PR は skip
    if: github.event.pull_request.head.repo.full_name == github.repository
    permissions:
      contents: read
      id-token: write  # OIDC token の発行に必要

    steps:
      - uses: actions/checkout@v4

      - uses: hashicorp/setup-terraform@v3

      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ vars.PR_PLAN_ROLE_ARN }}
          aws-region: ap-northeast-1

      - name: terraform init
        run: terraform init -input=false
        working-directory: terraform/environments/dev

      - name: terraform plan
        id: plan
        run: |
          set +e
          terraform plan \
            -lock=false \
            -refresh=false \
            -detailed-exitcode \
            -out=tfplan \
            -no-color
          PLAN_EXIT=$?
          echo "exit_code=$PLAN_EXIT" >> "$GITHUB_OUTPUT"
          # exit 0: 変更なし / exit 2: 変更あり → どちらも step は成功
          # exit 1: エラー → step を失敗させる
          [ "$PLAN_EXIT" -ne 1 ]
        working-directory: terraform/environments/dev

      - name: Save plan output
        if: steps.plan.outputs.exit_code != '1'
        run: |
          terraform show -no-color tfplan > plan_output.txt
          # Checks タブから直接確認できるように Job Summary に書き出す
          echo '```' >> "$GITHUB_STEP_SUMMARY"
          cat plan_output.txt >> "$GITHUB_STEP_SUMMARY"
          echo '```' >> "$GITHUB_STEP_SUMMARY"
        working-directory: terraform/environments/dev

      - name: Upload plan text
        if: steps.plan.outputs.exit_code != '1'
        uses: actions/upload-artifact@v4
        with:
          name: plan-output
          path: terraform/environments/dev/plan_output.txt
          # binary の tfplan は含めない

  # required status check に設定するのはこちら
  terraform-plan-gate:
    name: terraform plan (gate)
    runs-on: ubuntu-latest
    if: always()
    needs: terraform-plan
    steps:
      - run: |
          case "${{ needs.terraform-plan.result }}" in
            success|skipped) exit 0 ;;
            *) exit 1 ;;
          esac
```

`vars.PR_PLAN_ROLE_ARN` は GitHub Actions の Variables に設定します（Secrets ではなく Variables で問題ありません。ARN 自体は機密情報ではないため）。

:::message
このワークフローは「plan のみ・apply なし」の構成です。apply / destroy は別の workflow（`push: branches: [main]`）で管理し、PR Check と混在させません。
:::

## 実装後の確認観点

実装後は「job が green になった」だけで終わらせず、次の観点を確認します。

```bash
# PR のチェック一覧を見る
gh pr checks <pr-number>

# plan job のログを見る
gh run view <run-id> --job <job-id> --log
```

| 観点 | 確認内容 |
|---|---|
| 権限 | plan Role に write 系権限が入っていない |
| skip | Terraform 変更なし PR と fork PR が意図どおり skip される |
| 出力 | artifact / Job Summary に secret や binary plan が含まれない |
| レビュー補助 | plan の差分が PR 上で追える形になっている |

plan job は「動けば終わり」ではなく、レビュー時に安全な判断材料として使えることが目的です。

## まとめ

PR Check に `terraform plan` を組み込む前に確認すべき5つの観点を整理しました。

ワークフローの実装より先に **PR 専用の IAM Role を作成する**のが最初の一歩です。Role がなければ何をしても OIDC 認証で落ちます。

実装順序に迷ったら「Role 作成 → plan workflow → Job Summary 整形 → 危険シグナル抽出」の順で進めるのが安全です。最初の2つが安定してから、後続のステップを足していきます。

required status check 化は、plan job の skip 条件が整理できてからで十分です。PR plan は強力なレビュー補助になりますが、先に止まり方を設計しておくことで、CI 自体が開発フローを詰まらせるリスクを減らせます。

## 参考リンク

- [GitHub Docs: Security hardening for GitHub Actions](https://docs.github.com/en/actions/security-guides/security-hardening-for-github-actions)
- [GitHub Docs: OpenID Connect in AWS](https://docs.github.com/en/actions/how-tos/security-for-github-actions/security-hardening-your-deployments/configuring-openid-connect-in-amazon-web-services)
- [Terraform: S3 backend](https://developer.hashicorp.com/terraform/language/backend/s3)
- [Terraform: plan command](https://developer.hashicorp.com/terraform/cli/commands/plan)
