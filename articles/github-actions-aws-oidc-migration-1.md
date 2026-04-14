---
title: "GitHub ActionsにAWSキーを置くのをやめた：OIDC移行で長期クレデンシャルを0本にした"
emoji: "🔑"
type: "tech"
topics: ["githubactions", "aws", "iam", "oidc", "terraform"]
published: true
---

個人開発のポートフォリオプロジェクト [terraform-hannibal](https://github.com/kmryst/terraform-hannibal)（ECS Fargate + Terraform + GitHub Actions）の CI/CD パイプラインで、GitHub Secrets に保管していた AWS アクセスキー 2本を削除しました。OIDC（OpenID Connect）を使った短期トークン認証に移行し、長期クレデンシャルをなくした記録です。

想定読者は、GitHub Actions から AWS を操作していて Secrets に `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` を入れている方です。特に、Permission Boundary や AssumeRole を導入済みで「それなりに安全にしているつもり」の構成から次のステップを考えている方の判断材料になればと思います。

:::message
**この記事の前提**

- Terraform の `foundation` ディレクトリの IAM リソースは `terraform state rm` で state 管理外になっています。そのため今回の変更は Terraform apply ではなく AWS CLI で直接適用しています。
- 移行後も IAMユーザー `hannibal-cicd` は AWS に残存しています（今回はキーの無効化のみ対応済み、ユーザー削除は別途検討）。
:::

## 先に結論

- **GitHub Secrets の AWS キー: 2本 → 0本**
- **認証ステップ: 2（長期キー認証 + 手動 AssumeRole）→ 1（OIDC → 直接 AssumeRoleWithWebIdentity）**
- 許可範囲は `repo:kmryst/terraform-hannibal:ref:refs/heads/main` のみ（最小権限）

変更前後の認証フローを図にすると次のようになります。

**変更前**
```text
GitHub Actions
  → secrets.AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY（長期キー）
  → IAMユーザー hannibal-cicd として認証
  → aws sts assume-role（手動ステップ）
  → HannibalCICDRole-Dev の権限で AWS 操作
```

**変更後**
```text
GitHub Actions
  → GitHub OIDC エンドポイントから JWT 発行（短期・実行中のみ有効）
  → sts:AssumeRoleWithWebIdentity
  → HannibalCICDRole-Dev の権限で AWS 操作
```

## 用語の整理

記事内で使う用語を先に定義します。

- **OIDC（OpenID Connect）**: OAuth 2.0 の上に本人確認の仕組みを足した認証プロトコル。「誰が実行しているか」を証明するトークンを発行する。
- **JWT（JSON Web Token）**: 署名付きの短期トークン。OIDC が発行する身分証にあたる。改ざんできないよう署名が付いている。
- **AssumeRoleWithWebIdentity**: OIDC トークンを提示して IAM ロールを引き受ける AWS STS の API。通常の `AssumeRole`（IAM ユーザーが使う）とは別のエンドポイント。
- **Permission Boundary**: IAM ロールが持てる権限の上限を別ポリシーで制限する仕組み。ロールに広い権限を付けても、Boundary で実際に使える権限を絞れる。

## なぜ長期キー＋AssumeRole の構成だったか

「長期キーを置いているのはわかっているが、なぜ最初からOIDCにしなかったのか」という疑問に答えておきます。

:::details 設計の変遷（コミットログから）

このプロジェクトの IAM 設計は次のように変遷しています。

| 時期 | 認証構成 | 背景 |
|------|----------|------|
| 2025年5月〜 | 長期キーで直接 AWS 操作 | まず動かすことを優先 |
| 2025年7月〜 | IAMユーザー → AssumeRole の二段階 | Permission Boundary 導入、責務分離設計へ（「IAM 権限分析中1〜14」） |
| 2026年4月8日 | `Assume CICD Role` ステップを明示化 | AssumeRole をワークフロー上で可視化 |
| 2026年4月14日 | OIDC → 直接 AssumeRoleWithWebIdentity | 長期キー廃止（今回） |

:::

2025年7月に IAM 設計を見直したとき、次の考え方で「IAMユーザー + AssumeRole」構成を選んでいます。

- IAMユーザー `hannibal-cicd` には最小権限（AssumeRole できるだけ）
- 実際のデプロイ権限は `HannibalCICDRole-Dev` に集約
- Permission Boundary でロールの上限を制限

これは当時の選択肢の中では合理的でした。しかし**長期キーを GitHub に置いている以上、漏洩した場合のリスクは残ります**。キーが流出すれば、有効期限なく IAMユーザーとして認証できます。AssumeRole で二段階にしても、踏み台のキーが取られれば変わりません。

OIDC を使えばキー自体をなくせる、という認識が「次の一手」として明確になったのが今回の移行のきっかけです。

## 何が課題だったか

長期キー構成の問題点を整理します。

**漏洩時の影響範囲**  
GitHub Secrets に保管された長期キーが漏洩した場合、攻撃者はそのキーを使って AWS に無期限でアクセスできます。発覚が遅れるほど被害が拡大します。OIDC の短期トークンは実行が終われば失効するため、仮に傍受されても再利用できません。

**ローテーション運用の手間**  
長期キーは定期的にローテーションするのがベストプラクティスです。しかし実際には「AWS でキーを作り直す → GitHub Secrets を更新する」という作業が必要で、属人的な運用タスクになります。

**許可範囲の粒度**  
長期キー方式では「このキーを持っている者が AWS に触れる」という制御になります。OIDC では trust policy の `sub` 条件で「どの repo の、どのブランチの実行か」まで指定できます。さらに細かい制御をしたい場合は、reusable workflow や subject claim のカスタマイズを組み合わせる設計もありますが、本記事の構成ではそこまでは扱いません。

## やったこと

### 1. AWS 側：GitHub OIDC Provider の作成

AWS IAM に GitHub（`token.actions.githubusercontent.com`）を「信頼できるトークン発行元」として登録します。これにより AWS が GitHub 発行の JWT を検証できるようになります。

```bash
aws iam create-open-id-connect-provider \
  --url "https://token.actions.githubusercontent.com" \
  --client-id-list "sts.amazonaws.com" \
  --thumbprint-list "6938fd4d98bab03faadb97b34396831e3780aea1"
```

作成確認：

```bash
aws iam list-open-id-connect-providers
# {
#   "OpenIDConnectProviderList": [
#     { "Arn": "arn:aws:iam::xxxx:oidc-provider/token.actions.githubusercontent.com" }
#   ]
# }
```

`thumbprint_list` は GitHub の OIDC エンドポイントの TLS 証明書チェーンのフィンガープリントです。[公式ドキュメント](https://docs.github.com/en/actions/security-for-github-actions/security-hardening-your-deployments/configuring-openid-connect-in-amazon-web-services)に記載されている値を使います。

:::message
AWS は 2023年7月以降、GitHub・Google など一部の主要 OIDC プロバイダーに対して thumbprint の検証を AWS 側で自動管理するようになりました。そのため、GitHub の OIDC Provider に限っては **ユーザーが指定した thumbprint の値は実質的に検証に使われず、任意の値を入れても動作します**。`6938fd4d98bab03faadb97b34396831e3780aea1` は現在も広く使われているサンプル値ですが、この値の正確性はセキュリティ上の意味を持ちません。詳細は[公式ドキュメント](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_providers_create_oidc.html)を参照してください。
:::

### 2. AWS 側：HannibalCICDRole-Dev の信頼ポリシーを変更

`HannibalCICDRole-Dev` の信頼ポリシーを、IAMユーザーからの `AssumeRole` を許可する設定から、GitHub OIDC からの `AssumeRoleWithWebIdentity` を許可する設定に変更します。

**変更前の信頼ポリシー**

```json
{
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "AWS": "arn:aws:iam::xxxx:user/hannibal-cicd" },
    "Action": "sts:AssumeRole",
    "Condition": {
      "StringEquals": { "aws:RequestedRegion": "ap-northeast-1" }
    }
  }]
}
```

**変更後の信頼ポリシー**

```json
{
  "Statement": [{
    "Effect": "Allow",
    "Principal": {
      "Federated": "arn:aws:iam::xxxx:oidc-provider/token.actions.githubusercontent.com"
    },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {
        "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
      },
      "StringLike": {
        "token.actions.githubusercontent.com:sub": "repo:kmryst/terraform-hannibal:ref:refs/heads/main"
      }
    }
  }]
}
```

`Condition` の `StringEquals` と `StringLike` の使い分けについては後述します。

IAM リソースがまだ Terraform 管理下にある構成なら、OIDC Provider と trust policy の変更も Terraform で適用するのが自然です。今回は Terraform の Foundation state が空のため、`terraform apply` ではなく AWS CLI で直接適用しました。

```bash
aws iam update-assume-role-policy \
  --role-name HannibalCICDRole-Dev \
  --policy-document file://trust-policy.json
```

適用後の確認：

```bash
aws iam get-role \
  --role-name HannibalCICDRole-Dev \
  --query 'Role.AssumeRolePolicyDocument'
```

### 3. GitHub Actions 側：ワークフローの変更

`deploy.yml` と `destroy.yml` の両方に同じ変更を加えます。

**変更前（deploy.yml 抜粋）**

```yaml
# ジョブに permissions なし

steps:
  # 長期キーで IAMユーザーとして認証
  - uses: aws-actions/configure-aws-credentials@v4
    with:
      aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
      aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
      aws-region: ${{ env.AWS_REGION }}

  # 手動で CICDロールに Assume
  - name: Assume CICD Role
    run: |
      CREDS=$(aws sts assume-role \
        --role-arn "arn:aws:iam::${{ env.AWS_ACCOUNT_ID }}:role/HannibalCICDRole-Dev" \
        --role-session-name "github-actions-deploy-$(date +%s)" \
        --output json)
      echo "AWS_ACCESS_KEY_ID=$(echo "$CREDS" | jq -r '.Credentials.AccessKeyId')" >> $GITHUB_ENV
      echo "AWS_SECRET_ACCESS_KEY=$(echo "$CREDS" | jq -r '.Credentials.SecretAccessKey')" >> $GITHUB_ENV
      echo "AWS_SESSION_TOKEN=$(echo "$CREDS" | jq -r '.Credentials.SessionToken')" >> $GITHUB_ENV
```

**変更後（deploy.yml 抜粋）**

```yaml
deploy:
  runs-on: ubuntu-latest
  permissions:
    id-token: write   # GitHub OIDC トークン発行に必須
    contents: read
  steps:
    # OIDC で直接 CICDロールを引き受ける（1ステップに統合）
    - uses: aws-actions/configure-aws-credentials@v4
      with:
        role-to-assume: arn:aws:iam::${{ env.AWS_ACCOUNT_ID }}:role/HannibalCICDRole-Dev
        aws-region: ${{ env.AWS_REGION }}
```

`permissions: id-token: write` がないと GitHub が OIDC トークンを発行しないため、`configure-aws-credentials` の `role-to-assume` が機能しません。この設定を忘れやすいので注意が必要です。

### 4. GitHub Secrets の長期キーを削除

疎通確認（後述）が取れてから削除します。

```bash
gh secret delete AWS_ACCESS_KEY_ID --repo kmryst/terraform-hannibal
gh secret delete AWS_SECRET_ACCESS_KEY --repo kmryst/terraform-hannibal

# 確認
gh secret list --repo kmryst/terraform-hannibal
# DB_SECRET_ARN   2026-04-07T13:19:23Z
# （AWS キー 2本が消えていることを確認）
```

## 設計の判断（選ばなかった選択肢）

### PR からも AWS を触る設計は取らなかった

AWS 側の trust policy では `sub` を `repo:kmryst/terraform-hannibal:ref:refs/heads/main` に固定し、GitHub Actions 側では `deploy.yml` / `destroy.yml` を `workflow_dispatch` のみで動かす構成にしました。つまり、`main` ブランチ制限は AWS 側、手動実行限定は GitHub Actions 側で担保しています。PR で `terraform plan`（S3 backend ありで実行）を CI に組み込む設計も選択肢としてありますが、今回は取りませんでした。

理由は次のとおりです。

- 現在の PR Check は `terraform validate` を `-backend=false` で実行しており、構文チェックとしては十分機能している
- deploy / destroy どちらも手動実行前提の運用なので、PR 段階で AWS に触る必要がない
- PR は外部入力（レビュー前のコード）を含む可能性があり、AWS への権限を持たせると事故リスクが上がる

「PR でも `terraform plan` を見たい」場合は、許可範囲を広げて GitHub Environments の承認を挟む設計が一般的です。

### 新規ロールを作らず既存ロールの trust policy を付け替えた

OIDC 専用ロールを新しく作る案もありますが、既存の `HannibalCICDRole-Dev` の trust policy を付け替える方針にしました。

理由：
- Permission Boundary や附属ポリシーをそのまま継承できる
- ワークフロー側で参照しているロール ARN を変更しなくてよい
- 移行期間中の並走（新旧ロール共存）が不要

### `StringEquals` と `StringLike` の使い分け

trust policy の `Condition` で `StringEquals` と `StringLike` を使い分けています。

```json
"Condition": {
  "StringEquals": {
    "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
  },
  "StringLike": {
    "token.actions.githubusercontent.com:sub": "repo:kmryst/terraform-hannibal:ref:refs/heads/main"
  }
}
```

- `aud`（audience）は `sts.amazonaws.com` 固定で完全一致でよいため `StringEquals`
- `sub`（subject）は将来タグ指定や別ブランチへの拡張を考えてワイルドカード（`*`）が使える `StringLike` にしています。現状の値 `repo:kmryst/terraform-hannibal:ref:refs/heads/main` にはワイルドカードが含まれていないため、この条件に限れば `StringEquals` でも同じ動作になります。`StringLike` を選んでいるのは、将来 `repo:kmryst/terraform-hannibal:*`（全ブランチ許可）のようにワイルドカードで拡張する際に条件演算子を変える手間を省くためです。

### Terraform apply ではなく AWS CLI で直接適用した理由

今回の変更対象（OIDC Provider と HannibalCICDRole-Dev の trust policy）は、`terraform state rm` で state 外に出ているリソースです。空の state に対して apply を実行すると、Terraform は「このリソースが存在しない」と判断して新規作成を試み、すでに AWS に存在するリソースと衝突してエラーになります。ここは「OIDC では CLI が推奨」という意味ではなく、「state 外に出した既存 IAM を今回だけ直接更新した」という位置づけです。

そのため、`aws iam create-open-id-connect-provider` と `aws iam update-assume-role-policy` で直接適用しました。コードとしては `terraform/foundation/iam.tf` に定義を残し、ドキュメントと再現性の担保として機能させています。

## 検証

変更後、`deploy.yml` を `workflow_dispatch` で手動実行し、OIDC 認証が通ることを確認しました。あわせて、認証直後に `aws sts get-caller-identity` を実行し、IAMユーザーではなく `HannibalCICDRole-Dev` の一時クレデンシャルで動いていることを確認しています。

```bash
aws sts get-caller-identity
# {
#   "UserId": "AROAXXXXXXXXXXXX:GitHubActions",
#   "Account": "xxxxxxxxxxxx",
#   "Arn": "arn:aws:sts::xxxxxxxxxxxx:assumed-role/HannibalCICDRole-Dev/GitHubActions"
# }
```

`Arn` が `assumed-role/HannibalCICDRole-Dev/...` になっていれば、長期キーの IAMユーザーではなく OIDC 経由でロールを引き受けられています。

```text
✓ Post Run aws-actions/configure-aws-credentials@v4
✓ Post Setup Node.js for frontend build
✓ Post Run actions/checkout@v4
✓ Complete job
```

`configure-aws-credentials` のステップが正常完了し、後続の Terraform / ECR / ECS / CodeDeploy の操作もすべて成功しています（exit code 0）。

## 学び

**「AssumeRole で二段階にすれば安全」ではキー自体のリスクは残る**  
Permission Boundary と AssumeRole の組み合わせは「権限の絞り込み」には有効ですが、長期キーを置いている限り、そのキーが漏洩した場合の影響は消えません。OIDC はキー自体をなくすアプローチで、これによって初めて「GitHub に AWS キーを置かない」状態が実現します。

**許可範囲はキー単位よりトークン条件の方が細かく制御できる**  
長期キー方式は「このキーを持っている実行者」という粒度でしか絞れません。今回の OIDC 構成では `sub` 条件で「この repo の、この branch の実行」まで絞れます。workflow 単位まで絞りたい場合は、reusable workflow や subject claim のカスタマイズを含めて別途設計する必要があります。

**設計を変えるたびに trust policy に意図が残る**  
IAM の trust policy はそのロールが「誰に、何を許可しているか」の記録になります。今回の変更で `Principal` が IAMユーザーから Federated（OIDC Provider）に変わり、`Condition` に repo と branch が明示されました。コードを見るだけで設計意図が伝わる状態になっています。

## 今後の改善

- **Node.js 20 アクションの非推奨警告**: `actions/checkout@v4`、`actions/setup-node@v4`、`aws-actions/configure-aws-credentials@v4` が Node.js 20 ベースで動作しており、2026年6月2日以降に影響が出ます。各アクションの Node.js 24 対応版への更新が必要です。
- **IAMユーザー `hannibal-cicd` の整理**: 長期キーは削除済みですが、IAMユーザー自体はまだ AWS に残っています。不要であればユーザーごと削除するか、キーの無効化のみで残しておくかを判断する必要があります。
- **Permission Boundary との整合**: 今回は `HannibalCICDRole-Dev` の trust policy のみを変更し、ロールにアタッチされたポリシーや Permission Boundary は変更していません。OIDC 移行後の権限範囲は移行前と同一です。

## 参考リンク

- [GitHub Actions: Configuring OpenID Connect in Amazon Web Services](https://docs.github.com/en/actions/security-for-github-actions/security-hardening-your-deployments/configuring-openid-connect-in-amazon-web-services)
- [GitHub Actions: OpenID Connect reference](https://docs.github.com/actions/reference/openid-connect-reference)
- [AWS: Creating OpenID Connect (OIDC) identity providers](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_providers_create_oidc.html)
- [aws-actions/configure-aws-credentials: OIDC support](https://github.com/aws-actions/configure-aws-credentials#assuming-a-role)
