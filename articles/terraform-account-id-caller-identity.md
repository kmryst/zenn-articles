---
title: "var.aws_account_id = \"123456789012\" はハードコードと同じ"
emoji: "🪪"
type: "tech"
topics: ["terraform", "githubactions", "aws", "iam", "devops"]
published: true
---

:::message
この記事は個人ポートフォリオ用のpublicリポジトリ（Terraform + GitHub Actions、個人1人で運用）での対応を扱います。チーム規模や権限設計が異なる環境では判断が変わる可能性があります。Terraform 1.12.1、2026年6月時点の内容です。
:::

## 先に結論

publicリポジトリのTerraform・workflow・補助スクリプトに、AWSアカウントIDが複数の形で残っていた。Terraformを起点に、workflowと補助スクリプトも棚卸しした。それぞれ動的化の方法が違った。

| 場所 | 変更前 | 変更後 |
|---|---|---|
| Terraform variable | `default = "123456789012"` | `data "aws_caller_identity"` で実行時取得 |
| Permission Boundary JSON | `file()` + 固定値 | `templatefile()` + `${account_id}` プレースホルダー |
| GitHub Actions workflow | ARNとアカウントID直書き | `${{ vars.AWS_CICD_ROLE_ARN }}`（GitHub Variables） |

3つで判断軸が違う背景として、「値の種類が違う」ことがある。

| 種類 | 例 | 扱い | 判断理由 |
|---|---|---|---|
| secret | アクセスキー、トークン | GitHub Secrets | 単体で悪用できる認証情報 |
| configuration | ロールARN、リージョン | GitHub Variables | secretではないが環境ごとに変わる設定値 |
| runtime-derived | アカウントID、ECR registry URI | data source / CLI output | 実行時に正しい値を取得できる |
| source-controlled template | IAM policy JSON | `templatefile()` | ファイル構造は残し、値だけ注入する |

この分類が今回の3つの判断の根拠になっている。それぞれの詳細を以降で説明する。

## なぜそうなっていたか

もともとアカウントIDをmodule間で渡すため `variable "aws_account_id"` を作り、`terraform.tfvars` で明示的に渡していた。コードが増えるにつれて「毎回tfvarsに書くのが面倒」という理由で `default = "123456789012"` を追加した。

Permission BoundaryのJSONはTerraformの管理外として手動で書いたファイルで、アカウントIDをそのまま含んでいた。workflowのロールARNは変更頻度が低かったため、コードへの直書きがそのまま残っていた。

## 棚卸しを先にやった

対応前に、まず主要なTerraform・workflow・JSON上のアカウントID参照を棚卸しした。その結果、3種類に分類できた。

| 分類 | 対応方針 |
|---|---|
| Terraform variable の `default` 値 | 即対応（`aws_caller_identity`） |
| Permission Boundary JSONの固定値 | 別PR（`templatefile()` が必要） |
| workflowのロールARN・アカウントID | 別PR（GitHub Variables化） |

Permission Boundary JSONとworkflowを後回しにしたのは、対応方法がそれぞれ異なるため一括でできなかったからだ。Terraform variableへの対応だけ先行させ、残りは別PRで対応した。先に棚卸しをしたことで、workflowのECR URLにもアカウントIDが入っていることに気づき、対応漏れを防げた（後述）。

## 判断① `default` に書くのはハードコードと同じ

変更前：

```hcl
variable "aws_account_id" {
  description = "AWS account ID"
  type        = string
  default     = "123456789012"
}
```

`default` に実値を書いている場合、git履歴に残り、リポジトリをcloneした誰でも読める。「tfvarsで渡す前提だが念のためdefaultを書いた」という意図でも、コードに書いた時点で公開される。tfvarsで渡す方式でも、書き忘れたときにデフォルト値として過去の実値が使われるリスクがある。

`aws_caller_identity` に切り替えると、アカウントIDはplan/apply時にAWS APIから取得する。コードに値を持たない。

```hcl
data "aws_caller_identity" "current" {}

resource "aws_iam_role" "example" {
  permissions_boundary = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:policy/HannibalECSBoundary"
  # ...
}
```

`data "aws_caller_identity"` はplan/apply時にAWS認証が必要になる。`terraform validate`（認証不要の静的検証）では解決されないが、これは許容している。

:::message alert
`aws_caller_identity` はplan/apply時のAWS認証先のアカウントIDを返す。実行環境のAWS認証が意図しないアカウントを向いている場合、間違ったアカウントIDでARNが組まれる。事前確認として `aws sts get-caller-identity` でアカウントIDとRoleを確認する習慣を持つとよい。

複数アカウントを扱う環境では、`provider` ブロックに `allowed_account_ids` を設定することで、誤ったアカウントへのapplyを防ぐことができる。
:::

**選ばなかった選択肢**: `variable "aws_account_id"` をtfvarsのみで渡す方式。書き忘れ時のフォールバックリスクを消すため、変数自体を廃止した。

## 判断② `file()` はdata sourceを受け取れない → `templatefile()` に切り替える

Permission BoundaryはJSONファイルで管理し、Terraformのresourceで `file()` を使って読み込んでいた。

```hcl
# 変更前
resource "aws_iam_policy" "hannibal_ecs_boundary" {
  policy = file("${path.module}/HannibalECSBoundary.json")
}
```

JSONの中にはアカウントIDが直書きされていた：

```json
"Resource": "arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:nestjs-hannibal-3/*"
```

`file()` 関数はファイルをそのまま文字列として読むだけで、Terraformのdata sourceや変数を埋め込む仕組みがない。JSONに `${data.aws_caller_identity.current.account_id}` のような参照を書いても、Terraformの式として評価されない。

`templatefile()` に切り替えることで、変数を渡せるようになる。

```hcl
# 変更後
resource "aws_iam_policy" "hannibal_ecs_boundary" {
  policy = templatefile(
    "${path.module}/HannibalECSBoundary.json",
    { account_id = data.aws_caller_identity.current.account_id }
  )
}
```

JSONのプレースホルダーは `${account_id}` で書く：

```json
"Resource": "arn:aws:secretsmanager:ap-northeast-1:${account_id}:secret:nestjs-hannibal-3/*"
```

:::message
`${account_id}` はJSON文字列の内側に書かれるため、JSON構文としては有効だ。問題は「IAMポリシーとして利用する前にTerraformのテンプレートエンジンでレンダリングする必要がある」ことであり、`file()` との違いはそこにある。

なお、テンプレートファイルに `.json.tftpl` という拡張子を使うと、Terraformのテンプレートであることをファイル名で明示できる。今回は既存ファイルの拡張子変更を避けたため `.json` のままにしたが、新規作成時は `.json.tftpl` を選択肢に入れてよい。
:::

ポリシーの実効内容は変更前後で変わらない。AWSに渡されるJSONは以前と同じになる。

## 判断③ ロールARNはSecretsではなくVariables

workflowの変更前：

```yaml
env:
  AWS_ACCOUNT_ID: "123456789012"

- uses: aws-actions/configure-aws-credentials@v4
  with:
    role-to-assume: arn:aws:iam::${{ env.AWS_ACCOUNT_ID }}:role/HannibalCICDRole-Dev
    aws-region: ap-northeast-1
```

変更後：

```yaml
- uses: aws-actions/configure-aws-credentials@v4
  with:
    role-to-assume: ${{ vars.AWS_CICD_ROLE_ARN }}
    aws-region: ${{ vars.AWS_REGION }}
```

`vars.*` はGitHub Variables（平文保存・ログに表示される）、`secrets.*` はGitHub Secrets（暗号化保存・ログでマスクされる）だ。

ロールARNをSecretsに入れなかった理由は、AWSのセキュリティモデルではロールARNは認証情報ではなく識別子として扱われるからだ。AWSコンソールのURLやCloudTrailのログにも含まれる情報であり、「漏洩したら即座に悪用できる認証情報」とは区別される。ただしロールの存在を知られることにはなるため、機密要件が高い環境では判断が変わる可能性がある。

このプロジェクトではOIDCによる短期トークン認証を使っており、ロールARNを知っても認証情報を取得することはできない（OIDC trust policyで対象リポジトリとブランチを限定している）。このプロジェクトに限って言えば、Secretsに入れるべき情報は「それ単体で悪用できるもの」に絞り、rotate・revokeの管理対象を最小限にする方針をとっている。

ロールARNとリージョンは、冒頭の分類表でいう "configuration"（secretではないが環境ごとに変わる設定値）にあたる。Secretsではなく Variables に置き、コードと設定を分離する。

:::message
`vars.*` はVariableが未設定の場合に空文字を返す。`role-to-assume` が空文字だとOIDC認証が失敗する。必須のVariableは `gh variable list` で登録状況を確認するか、セットアップドキュメントで登録必須として明示しておく必要がある。
:::

## near-miss: 棚卸しをしても一度では終わらなかった

最初の棚卸し（Terraform variable対応のPR）では「後回し」に分類したものを除き、対象範囲をTerraform・workflow・JSONに絞った。しかし後続の対応中や、改めて全体をgrepした段階で、さらに3箇所の残存が見つかった。

**workflowのECR URL（workflow対応PR中に発見）**

```yaml
# 変更前
REPO="${{ env.AWS_ACCOUNT_ID }}.dkr.ecr.ap-northeast-1.amazonaws.com/${{ env.PROJECT_NAME }}"
```

`AWS_ACCOUNT_ID` の参照を全検索したときに見つかった。`amazon-ecr-login@v2` のoutputとして `registry` が提供されているため、そちらに切り替えた：

```yaml
# 変更後
- name: Login to Amazon ECR
  id: login-ecr
  uses: aws-actions/amazon-ecr-login@v2

- name: Build and Push ECS Image
  run: |
    REPO="${{ steps.login-ecr.outputs.registry }}/${{ env.PROJECT_NAME }}"
```

**デプロイスクリプト（後続grepで発見）**

PowerShellのCodeDeployデプロイスクリプトに `$AWS_ACCOUNT_ID = "..."` の直書きが残っていた。Terraform・workflowを対象にした棚卸しのスコープに入っていなかった。ECR repository URIを `aws ecr describe-repositories` で実行時取得する方式に切り替えた。

**Terraformモジュールのコメント行（後続grepで発見）**

`terraform/modules/compute/ecs/main.tf` のコメントに、ARNの記述例としてアカウントIDが含まれていた。コメントはgitleaksの検出対象外になりやすく、grepによる確認が有効だった。

---

教訓として、棚卸しはコードだけ見ていると「Terraform/workflowが対象」という思い込みでスコープが狭くなりやすい。最終確認として `rg "アカウントID" .` で全ファイルをgrepする手順を入れることで、コメントやスクリプトの残存を拾える。

## 検証

| 確認内容 | 結果 |
|---|---|
| `terraform fmt -check -recursive` | pass |
| `terraform validate`（foundation / dev） | pass |
| 全ファイルgrepによる残存確認（後述） | matches なし |
| pre-commit（fmt / tflint / gitleaks） | pass |
| commitlint | pass |

残存確認は以下のコマンドを使った。`-e` で複数パターンを指定することで、コメントやスクリプトの漏れも拾える。

```bash
rg -n -e "aws_account_id" -e "AWS_ACCOUNT_ID" -S .
```

アカウントID自体の残存確認は、自分のアカウントIDを直接指定してgrepする。

`terraform plan`（AWS認証あり）は3つのPRにまたがって実施し、foundation・dev ともに人間が手動確認。ポリシーの実効内容は変更前後で同一であることをplan出力で確認した。

**各変更の失敗時挙動**

| 変更点 | 失敗するケース | 気づき方 | 戻し方 |
|---|---|---|---|
| `aws_caller_identity` | 実行環境が意図しないアカウント | plan時にリソースARNが不一致、または誤アカウントへのapply | `aws sts get-caller-identity` で認証先を確認、修正後に再plan |
| `templatefile()` | プレースホルダー名のtypo | `terraform plan` がエラー終了 | JSON内のプレースホルダー名を修正 |
| GitHub Variables | 未設定または空文字 | workflow が即時エラー（OIDC認証失敗） | `gh variable list` で確認後に登録してre-run |
| ECR URI取得（スクリプト） | ECRリポジトリが存在しない | CLIエラーでスクリプトが停止 | ECRリポジトリの存在確認後に再実行 |

いずれも失敗が即時検知できる構造になっている。特に `templatefile()` のtypoと GitHub Variables 未設定は、事前に `terraform plan` と `gh variable list` で確認できる。

## まとめ

アカウントIDはシークレットではない。コンソールのURLに出るし、CLIのレスポンスにも含まれる。「漏洩したら即悪用できる認証情報」ではない。

ただし、publicリポジトリのコードに値として書く理由もない。動的取得できる場所では動的取得に切り替えることで、コードが特定のアカウントに依存しなくなる。

値の種類で扱いを決める：

- 単体で悪用できる値は `Secrets`
- secretではないが環境ごとに変わる値は `Variables`（設定値として管理する）
- 実行時に正しく取得できる値は `data source` や CLI output
- ファイル構造を残したい設定は `templatefile()` で値だけ注入する

「シークレットかどうか」と「コードに書くべきかどうか」は別の問いだ。この分類は今回の3ケース以外の識別子にも使える。
