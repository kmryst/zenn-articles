---
title: "マネーフォワードの情報流出から考える、AWSまで燃え広がらせないCI/CD設計"
emoji: "🧯"
type: "tech"
topics: ["githubactions", "aws", "oidc", "terraform", "iam"]
published: true
---

2026年5月1日、株式会社マネーフォワードが GitHub への不正アクセスに関する第一報を公開しました。

公式発表によると、同社がソフトウェア開発およびシステム管理に利用している GitHub の認証情報が漏えいし、それを用いた第三者の不正アクセスにより、GitHub 内のリポジトリがコピーされたとのことです。また、ソースコードおよびリポジトリに含まれていたファイル内の一部個人情報が流出した可能性がある、と説明されています。

この記事は、マネーフォワードの内部構成を推測するものではありません。

GitHub Actions で OIDC を使っていたのか、どの種別の認証情報が漏えいしたのか、リポジトリ内にあった認証キー・パスワードがどのサービス向けだったのかは、第一報だけでは分かりません。

この記事で扱うのは、そこではありません。

この記事の主題は、

> GitHub を完全に信頼しないことではなく、GitHub が侵害されても AWS 側へ被害が広がりにくい構成にすること

です。

自分の個人開発プロジェクト [terraform-hannibal](https://github.com/kmryst/terraform-hannibal) では、Terraform / AWS / GitHub Actions の CI/CD を次の方針で組んでいます。

- GitHub Secrets に長期 AWS アクセスキーを置かない
- GitHub Actions から AWS へは OIDC で一時認証する
- PR の `terraform plan` と main の deploy / destroy で IAM Role を分ける
- fork PR では AWS 認証を走らせない
- Terraform plan の全文は Job Log に流しっぱなしにせず、短期 artifact に逃がす
- Job Summary には判断に必要な要約と危険シグナルだけ出す

この記事では、事件の論評ではなく、この構成にしている理由と実装のポイントを整理します。

:::message
執筆時点では、マネーフォワードから公開されているのは第一報です。
未公表の侵入経路や内部構成については推測しません。
:::

## 想定読者

この記事は、次のような人向けです。

- GitHub Actions から AWS を操作している
- Terraform の `plan` / `apply` / `destroy` を GitHub Actions で実行している
- GitHub Secrets に `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` を置いている
- OIDC は聞いたことがあるが、被害範囲をどう狭める設計なのか整理したい
- PR から `terraform plan` を回したいが、deploy 用の権限を渡すのは怖い

個人開発や小規模チームの `dev` 環境を前提にしています。本番環境や大規模組織では、さらに Environment protection、承認フロー、監査ログ、職務分掌などが必要になります。

## 先に結論

自分の構成では、GitHub Actions と AWS の境界を次のように分けています。

| 用途 | GitHub event | AWS Role | AWS 権限 | 方針 |
| --- | --- | --- | --- | --- |
| deploy / destroy | `workflow_dispatch` on `main` | `HannibalCICDRole-Dev` | deploy / destroy 用 | main だけが使える |
| PR terraform plan | `pull_request` | `HannibalPRPlanRole-Dev` | read-only plan 用 | apply / destroy しない |
| fork PR | `pull_request` from fork | なし | なし | AWS 認証を実行しない |

この構成で守りたいのは、次の2つです。

1つ目は、**GitHub の中に長期 AWS キーを置く状態をなくすこと**です。

2つ目は、**PR の検証に deploy / destroy 用の強い権限を渡さないこと**です。

OIDC は万能ではありません。GitHub アカウントやリポジトリ権限が完全に奪われた場合、それだけですべてを防げるわけではありません。たとえば攻撃者が `main` に変更を入れられる状態なら、`main` から実行できる deploy Role も狙われます。

それでも、長期 AWS キーを置かないことには意味があります。リポジトリがコピーされても、コード履歴から再利用可能な AWS アクセスキーを持ち出されにくくなります。また、workflow 経路が悪用された場合でも、GitHub Secrets に長期 AWS キーがある構成より、被害範囲を狭めやすくなります。

ここで設計目標にしているのは、blast radius（侵害や誤操作が起きたときの影響範囲）を下げることです。

GitHub が侵害されたときに、すぐ AWS 側の deploy / destroy 権限まで到達される構成にしない。そのために、認証方式、Role、event、出力先を分けています。

## 何を防ぐ設計なのか

今回の公式発表で確認できるのは、GitHub の認証情報漏えいと、リポジトリのコピーです。

ここで混同しやすいのは、GitHub 側の認証情報と AWS 側の認証情報です。

GitHub の token、セッション、SSH key などが漏れること自体を、GitHub Actions の OIDC が直接防ぐわけではありません。OIDC が効くのは、GitHub Actions から AWS へ入るときです。IAM User の access key のような AWS の長期キーを GitHub Secrets に保存せず、workflow 実行時だけ短期クレデンシャルを発行します。

つまり、この記事の設計対象は次です。

```text
GitHub が侵害されること自体をゼロにする
  ではなく
GitHub が侵害されたときに、AWS 側へ再利用可能な鍵を持ち出されにくくする
```

「GitHub を信用しない」のではありません。GitHub は使います。ただし、GitHub の中に AWS へ長期間入れる鍵を置かない、という境界を作ります。

## 実装1: GitHub Secrets に長期 AWS キーを置かない

GitHub Actions から AWS に入る古典的な構成は、GitHub Secrets に次の2つを置く形です。

```text
AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY
```

この構成は分かりやすい一方で、キーが漏れたときの寿命が長くなりがちです。ローテーションするまで使えますし、どこで使われているかの把握も運用に依存します。

現在の構成では、この長期キーを置いていません。

GitHub Actions 側では、`aws-actions/configure-aws-credentials` に `role-to-assume` を渡します。

```yaml
permissions:
  id-token: write
  contents: read

steps:
  - uses: actions/checkout@v4

  - uses: aws-actions/configure-aws-credentials@v4
    with:
      role-to-assume: arn:aws:iam::<account-id>:role/HannibalCICDRole-Dev
      aws-region: ap-northeast-1
```

`id-token: write` は、GitHub Actions が OIDC token を発行するために必要です。

この token を `aws-actions/configure-aws-credentials` が AWS STS に渡し、`AssumeRoleWithWebIdentity` によって一時的な AWS クレデンシャルを取得します。

重要なのは、GitHub Secrets に AWS の長期キーを置いていないことです。

```text
GitHub Actions
  -> GitHub OIDC token
  -> AWS STS AssumeRoleWithWebIdentity
  -> 一時 AWS クレデンシャル
```

この一時クレデンシャルは workflow 実行のためのもので、長期的に再利用する前提ではありません。

## 実装2: main 用 Role と PR plan 用 Role を分ける

OIDC にしても、1つの Role に何でも許可してしまうと危険です。

たとえば、PR の `terraform plan` に deploy / destroy 用 Role を使うと、PR の検証経路に強い権限を渡すことになります。

そこで、Role を分けています。

| Role | 用途 | trust policy の subject | 権限 |
| --- | --- | --- | --- |
| `HannibalCICDRole-Dev` | main の deploy / destroy | `repo:kmryst/terraform-hannibal:ref:refs/heads/main` | deploy / destroy 用 |
| `HannibalPRPlanRole-Dev` | PR の `terraform plan` | `repo:kmryst/terraform-hannibal:pull_request` | read-only plan 用 |

main 用 Role の trust policy は、`main` ブランチに限定しています。

```json
{
  "Effect": "Allow",
  "Action": "sts:AssumeRoleWithWebIdentity",
  "Principal": {
    "Federated": "arn:aws:iam::<account-id>:oidc-provider/token.actions.githubusercontent.com"
  },
  "Condition": {
    "StringEquals": {
      "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
    },
    "StringLike": {
      "token.actions.githubusercontent.com:sub": "repo:kmryst/terraform-hannibal:ref:refs/heads/main"
    }
  }
}
```

PR plan 用 Role は、`pull_request` event 用の subject に限定しています。

```json
{
  "Effect": "Allow",
  "Action": "sts:AssumeRoleWithWebIdentity",
  "Principal": {
    "Federated": "arn:aws:iam::<account-id>:oidc-provider/token.actions.githubusercontent.com"
  },
  "Condition": {
    "StringEquals": {
      "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
      "token.actions.githubusercontent.com:sub": "repo:kmryst/terraform-hannibal:pull_request"
    }
  }
}
```

main 用では `sub` に `StringLike`、PR plan 用では `StringEquals` を使っています。

この構成では、main 用の値にもワイルドカードは含めていないため、実際の一致条件としては `StringEquals` でも同じです。`StringLike` にしているのは、将来 tag や別 branch へ明示的に拡張する可能性を考えたものです。

一方で、PR plan 用は `repo:kmryst/terraform-hannibal:pull_request` に固定しています。PR plan Role は apply / destroy に使わない前提なので、ここでは拡張余地よりも完全一致を優先しています。

もし新しく設計するなら、最初は `StringEquals` で完全一致にして、必要になったときだけ `StringLike` に変える方が読みやすいです。自分の構成も、今後整理するなら main 用を `StringEquals` に寄せる余地があります。

PR plan 用 Role の policy は、`describe` / `list` / `get` 系を中心にしています。

含めないものも明示しています。

```text
含めない権限:
- iam:PassRole
- create / update / delete / put / modify 系
- s3:PutObject / s3:DeleteObject
- dynamodb:PutItem / dynamodb:DeleteItem
- secretsmanager:GetSecretValue
- ECR push / upload 系
```

`terraform plan` には状態確認のための読み取り権限が必要です。しかし、PR の検証で `apply` や `destroy` ができる必要はありません。

この分離により、PR 経路の blast radius（事故や侵害時の影響範囲）を下げています。

## 実装3: fork PR では AWS 認証を走らせない

PR で `terraform plan` を回すと便利ですが、fork PR で AWS 認証を走らせるのは危険です。

特に `pull_request_target` は注意が必要です。base repository の権限で動くため、PR head のコードを不用意に checkout して実行すると、外部からの PR に強い権限を渡す経路になり得ます。

この構成では、PR plan は `pull_request` で動かし、さらに fork PR では job 自体をスキップします。

```yaml
terraform-plan:
  name: Terraform Plan Artifact
  needs: terraform-plan-changes
  if: >-
    needs.terraform-plan-changes.outputs.terraform_changed == 'true' &&
    github.event.pull_request.head.repo.full_name == github.repository
  permissions:
    contents: read
    id-token: write
```

この条件により、同一リポジトリ内の PR だけが AWS 認証つきの `terraform plan` を実行できます。

fork PR では、通常の lint / build / validate は動かせますが、AWS へ入る job は実行しません。

これは「外部コントリビュータを信用しない」というより、**AWS 認証を必要とする job と、外部コードを実行する経路を分ける**ための設計です。

## 実装4: Terraform plan の出し方を絞る

PR で `terraform plan` を出すと、差分確認はしやすくなります。

一方で、plan の全文を GitHub Actions の Job Log や PR コメントにそのまま出すと、情報量が多すぎます。場合によっては、リソース名、環境変数由来の値、エンドポイント、ARN など、レビューには必要だが不用意に目立たせたくない情報も含まれます。

現在の構成では、次のように分けています。

| 出し先 | 内容 | 目的 |
| --- | --- | --- |
| artifact | `terraform-plan.txt` / exit code | 必要な人が全文を確認する |
| Job Summary | add/change/destroy 件数、exit code、危険シグナル | PR 上で判断しやすくする |
| Job Log | 最小限 | ログを情報置き場にしない |

workflow では、plan の標準出力をファイルに保存しています。

```bash
terraform plan \
  -refresh=true \
  -lock=false \
  -input=false \
  -no-color \
  -detailed-exitcode \
  -out=tfplan \
  > terraform-plan.txt 2>&1

plan_exit=$?
echo "$plan_exit" > terraform-plan-exitcode.txt
```

artifact としてアップロードするのは、テキスト plan と exit code だけです。

```yaml
- name: Upload Terraform plan text artifact
  if: always()
  uses: actions/upload-artifact@v4
  with:
    name: terraform-plan-dev-${{ github.event.pull_request.number }}
    path: |
      terraform/environments/dev/terraform-plan.txt
      terraform/environments/dev/terraform-plan-exitcode.txt
    if-no-files-found: warn
    retention-days: 3
```

binary plan file はアップロードしません。

Job Summary には、plan の件数とレビューすべきシグナルだけを出します。

```text
Terraform Plan Summary

- Environment: dev
- Apply is not executed.
- Binary plan files are not uploaded.
- Text plan output artifact: terraform-plan-dev-<PR番号> (retention: 3 days)

Result
- Status
- Terraform exit code
- Add / Change / Destroy

Review Signals
- Destroy actions
- Replace actions
- IAM / OIDC / permission boundary changes
- Security group ingress changes
- Public access / external exposure changes
- Route53 / CloudFront / RDS changes
```

ここで重要なのは、危険シグナルを検出しても CI を落とす設計にはしていないことです。

このプロジェクトの `dev` 環境は普段 destroy 済みであることが多く、全作成 plan が出ること自体は異常ではありません。そこで、plan の結果は fail/pass の判定だけでなく、レビューの判断材料として出しています。

## 実装5: apply / destroy は手動実行に寄せる

このプロジェクトでは、deploy / destroy は `workflow_dispatch` にしています。

```yaml
on:
  workflow_dispatch:
    inputs:
      deployment_mode:
        description: "デプロイモードを選択"
        required: true
        default: "canary"
        type: choice
```

destroy も明示的な入力を要求します。

```yaml
on:
  workflow_dispatch:
    inputs:
      confirm:
        description: 'Type "DESTROY" to confirm'
        required: true
        type: string

jobs:
  destroy:
    if: github.event.inputs.confirm == 'DESTROY'
```

個人開発の `dev` 環境なので、完全自動デプロイよりも、AWS 変更を伴う操作は手動で明示的に起動する方針にしています。

自動トリガーにすると、merge や push がそのまま AWS 変更につながります。これは便利ですが、GitHub 側の権限侵害や workflow の誤変更が起きたときに、AWS 側まで到達する経路も短くなります。

`workflow_dispatch` に寄せることで、少なくとも `apply` / `destroy` は「PR を作る」「merge する」とは別の明示操作になります。blast radius をゼロにはできませんが、通常の開発フローから破壊的操作を少し離せます。

これは万能な安全策ではありません。GitHub への強い権限を持つユーザーが侵害されれば、workflow_dispatch を実行される可能性はあります。

それでも、PR を作っただけで `apply` や `destroy` まで到達する構成より、操作面は狭くなります。

## 採用しなかった構成

設計判断として、採用しなかった構成もあります。

| 案 | 強み | 採用しなかった理由 |
| --- | --- | --- |
| GitHub Secrets に AWS 長期キーを置く | 実装が簡単 | 漏れたときに再利用可能な鍵になる |
| PR plan でも deploy Role を使う | Role が1つで済む | PR 経路に強すぎる権限を渡す |
| `pull_request_target` で plan を動かす | fork PR でも base repo 権限を使いやすい | PR head のコード実行と組み合わせると危険 |
| plan 全文を PR コメントに貼る | レビュー画面で読める | 情報量が多く、履歴にも残りやすい |
| 既存 deploy 用 Permission Boundary を PR plan Role に流用する | Boundary を新設しなくて済む | deploy / destroy 用の上限なので、read-only plan 用の防波堤としては広すぎる。やるなら PR plan 専用 Boundary を別に作る |

PR plan Role は read-only policy に絞っていますが、現時点では Boundary を付けていません。これは「既存 Boundary を流用すればよい」とは考えていないためです。

今後さらに固めるなら、deploy 用 Boundary を流用するのではなく、PR plan 専用の read-only Boundary を作る方が筋がよいと考えています。

## この構成でも残るリスク

OIDC にしたから安全、ではありません。

残るリスクもあります。

- GitHub アカウント自体が侵害される
- `main` に push / merge できる権限が奪われる
- workflow ファイルが改ざんされる
- GitHub Actions の第三者 Action が侵害される
- AWS Role の権限が広すぎる
- Terraform state や artifact に見せたくない情報が含まれる

OIDC は、主に「長期 AWS キーを置かない」ための対策です。

GitHub が完全に安全であることを前提にするのではなく、GitHub から AWS へ渡す権限を短命化し、用途ごとに分け、PR 経路を細くする。その一部として OIDC を使っています。

つまり、この構成の要点は OIDC そのものではなく、境界の置き方です。

## 読者が自分の環境で確認するなら

同じような構成にするかどうかを判断するなら、優先順位を付けて確認するとよいです。

まず見るべきは、長期 AWS キーが GitHub 側に残っていないか、そして PR plan と apply が同じ Role になっていないかです。この2つは、侵害時に AWS 側へ燃え広がる経路に直結します。

そのうえで、OIDC trust policy の範囲、fork PR の扱い、plan の出力先を確認します。

### 1. GitHub Secrets に長期 AWS キーが残っていないか

`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` を使っている場合、OIDC に置き換えられるかを検討します。

すぐ移行できない場合でも、キーの権限、最終使用時刻、ローテーション状況を確認します。

移行途中でよく起きるのは、OIDC を追加したあとも長期キーが Secrets に残り続けることです。

この状態だと、workflow は OIDC で動いていても、GitHub 側にはまだ再利用可能な AWS キーが残っています。OIDC 移行を完了条件にするなら、「workflow が動いた」だけでなく、「長期キーを無効化し、Secrets からも消した」まで確認します。

### 2. OIDC trust policy の `sub` が広すぎないか

`repo:ORG/REPO:*` のように広くしすぎると、意図しない branch / event から Role を引き受けられる可能性があります。

main 用、PR 用、environment 用など、用途に応じて subject を分けます。

trust policy を絞りすぎると、`aws-actions/configure-aws-credentials` の段階で Role を引き受けられずに失敗します。逆に広げすぎると、意図しない branch や event から Role を使えるようになります。

失敗したときは、まず GitHub event と OIDC subject の対応を確認します。たとえば `main` 用の `ref:refs/heads/main` と、PR 用の `pull_request` は別物です。GitHub Environment を使う場合も subject が変わるため、trust policy と workflow の設計をセットで確認します。

### 3. PR plan と apply が同じ Role になっていないか

`terraform plan` と `terraform apply` は、必要な権限が違います。

plan 用の Role は、read-only に寄せられます。apply / destroy 用 Role と同じにする理由が本当にあるかを確認します。

ただし、Terraform の `plan` は完全な「何も触らない処理」ではありません。state backend の読み取り、provider が行う `describe` / `list` / `get`、場合によってはタグや policy の取得が必要になります。

最初から完璧な read-only policy を作ろうとすると、plan が権限不足で落ちます。落ちた API を見ながら足す運用にする場合でも、`create` / `update` / `delete` / `put` / `modify` 系や `iam:PassRole` を足さない、という線を先に決めておくと迷いにくくなります。

### 4. fork PR で AWS 認証が走らないか

fork PR でクラウド認証つきの job が動く場合、慎重に設計する必要があります。

特に `pull_request_target` で PR head のコードを checkout して実行する構成は避けます。

### 5. plan の全文をどこに残しているか

Job Log、PR コメント、artifact、外部ストレージのどこに plan が残るかを確認します。

「レビューしやすい」と「見せすぎない」のバランスを取ります。

## まとめ

GitHub の認証情報が漏れること自体を、個々の開発者やチームが完全にゼロにするのは難しいです。

だからこそ、漏れたときにどこまで燃え広がるかを設計します。

自分の Terraform / AWS / GitHub Actions 構成では、GitHub Secrets に長期 AWS キーを置かず、OIDC で短期認証し、PR plan と deploy / destroy の Role を分けています。さらに、fork PR では AWS 認証を走らせず、Terraform plan の出し方も artifact と Job Summary に分けています。

これは「GitHub を信用しない」という話ではありません。

GitHub を使い続けるために、GitHub の中に AWS まで燃え広がる火種を置かない、という話です。

## 参考

- [『GitHub』への不正アクセス発生に関するお知らせとお詫び（第一報）｜株式会社マネーフォワード](https://corp.moneyforward.com/news/info/20260501-mf-press-1/)
- [【重要】「GitHub」への不正アクセス発生に関するお知らせとお詫び｜マネーフォワード クラウドサービス全般サポート](https://biz.moneyforward.com/support/news/20260501.html)
- [Configuring OpenID Connect in Amazon Web Services - GitHub Docs](https://docs.github.com/en/actions/deployment/security-hardening-your-deployments/configuring-openid-connect-in-amazon-web-services)
- [aws-actions/configure-aws-credentials](https://github.com/aws-actions/configure-aws-credentials)
- [OIDC federation - AWS Identity and Access Management](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_providers_oidc.html)
- [Keeping your GitHub Actions and workflows secure Part 1: Preventing pwn requests - GitHub Security Lab](https://securitylab.github.com/resources/github-actions-preventing-pwn-requests/)
