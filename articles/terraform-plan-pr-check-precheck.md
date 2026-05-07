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

```yaml
# validate（backend不要）
- run: terraform validate -no-color
  working-directory: terraform/environments/dev

# plan（backend接続が必要）
- run: |
    terraform init -backend=true  # S3 + DynamoDB に接続
    terraform plan -lock=false -out=tfplan
```

確認すべき点は次の2つです。

### plan は `-lock=false` で実行する

`terraform plan` は state を読むだけで書きません。DynamoDB ロックを取得する必要はないため、`-lock=false` をつけます。DynamoDB への `PutItem`/`DeleteItem` は plan 専用 Role に付与しません。

```bash
# plan Roleに不要な権限（含めない）
dynamodb:PutItem    # lock取得
dynamodb:DeleteItem # lock解放
```

### state ファイルには機密値が含まれる場合がある

S3 の state ファイルには RDS パスワードや ARN などの機密値が含まれることがあります。plan Role が state を読める以上、この Role を使う PR は「信頼できるもの」に限定する必要があります（fork PR の対応は後述）。

## 2. OIDC 認証の確認

既存のデプロイ用 Role（`refs/heads/main` 限定）は PR Check から assume できません。**PR 専用の IAM Role** を別途作成する必要があります。

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

plan に必要な権限は `read/describe/list/get` 系のみです。次を原則として policy を設計します。

**含めるもの（plan に必要な read 系）**:
- `terraform init` 用の S3 state 読み取り（`s3:GetObject`、`s3:ListBucket`）
- terraform refresh が呼ぶ describe/list/get 系
- S3 バケット属性の読み取り（注意点は後述）

**含めないもの（plan には不要）**:
- `iam:PassRole`
- `s3:PutObject`/`s3:DeleteObject`（state への書き込み）
- `dynamodb:PutItem`/`dynamodb:DeleteItem`（lock の取得・解放）
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

:::message
`pull_request` event と `pull_request_target` event は挙動が異なります。fork PR のコードを実行できるのは `pull_request_target` のみです。plan には `pull_request` を使い、`pull_request_target` は使いません。
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

# tfplan（binary）を artifact に上げない
- uses: actions/upload-artifact@v4
  with:
    name: plan-output
    path: plan_output.txt  # binary の tfplan は含めない
```

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
   - terraform init（backend=true）
   - terraform plan（-lock=false -detailed-exitcode）
   - テキスト artifact の保存

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
[ ] Role の policy に write 系が含まれていない
[ ] S3 state の GetObject が policy に含まれている
[ ] terraform plan は -lock=false で実行する
[ ] fork PR を skip する if 条件が書いてある
[ ] binary plan ファイルを artifact に保存しない設計になっている
[ ] Job Summary に sensitive 値が混入しないことを確認した
[ ] required status check にする場合、skip を吸収する gate job を設計した
```

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
- [Terraform: plan command](https://developer.hashicorp.com/terraform/cli/commands/plan)

