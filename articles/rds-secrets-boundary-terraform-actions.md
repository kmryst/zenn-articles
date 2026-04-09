---
title: "RDS管理シークレットに寄せたかったが撤退した話: Permission BoundaryとTerraform"
emoji: "🔐"
type: "tech"
topics: ["aws", "terraform", "rds", "githubactions", "secretsmanager"]
published: true
---

NestJS API を ECS Fargate で動かしていて、DB には RDS for PostgreSQL を使っています。

今回やりたかったのは、RDS のマスター資格情報を `manage_master_user_password = true` で Secrets Manager に寄せ、ECS タスク定義の `secrets` から `DB_USER` / `DB_PASSWORD` を読む構成にすることでした。

構成としては素直ですが、実際にはそこで終わりませんでした。詰まったのは Secrets Manager の参照記法そのものではなく、運用権限と Terraform apply の周辺です。ぶつかったのは主に次の2つでした。

- CI/CD ロールの Permission Boundary と、RDS が裏で作る管理シークレットの前提権限
- GitHub Actions 上の Terraform apply で見えた state drift

ここで用語だけ先にそろえておくと、この記事でいう **Permission Boundary** は「IAM ロールやユーザーに対して、最終的に使える権限の上限を決める仕組み」です。**state drift** は「AWS 上の実体と Terraform state の認識がズレている状態」を指します。

その結果、一度は **Terraform 管理の Secret + GitHub Secrets 経由のパスワード注入** に退避し、あとで CI/CD 側の権限を直してから、RDS 管理シークレット構成へ戻しました。

ここで先に整理しておくと、GitHub Actions から AWS へ入る認証と、アプリケーションが DB に入る認証は別の話です。

- CI/CD の AWS 認証は OIDC で一時クレデンシャル化する
- DB 認証情報は Secrets Manager で管理する

今回詰まったのは、主に後者です。

想定読者としては、AWS と Terraform を普段触っていて、ECS への Secret 注入や Permission Boundary 配下の CI/CD で一度は似た詰まり方をしそうな人を置いています。

この記事では、その過程で考えたことを整理します。

## 先に結論

いまの着地点はこうです。

- RDS がマスターユーザー用の Secret を Secrets Manager に持つ
- ECS は `${secret_arn}:username::` / `${secret_arn}:password::` を `secrets` で読む
- 今回の構成では `DB_HOST` / `DB_PORT` は RDS endpoint を分解して通常の `environment` で渡す
- Secret を読む権限は **タスクロールではなくタスク実行ロール** に付ける
- ただし、推奨としてはアプリケーション用 DB ユーザーを管理用ユーザーと分け、アプリは最小権限ユーザーで接続する

つまり、アプリケーションから見える接続情報のうち、

- 機密: `DB_USER`, `DB_PASSWORD`
- 資格情報ではない: `DB_HOST`, `DB_PORT`, `DB_NAME`

を分けて扱う形です。

`${secret_arn}:username::` の形式は `secret_id:key:version_stage:version_id` という4パートの構造です。今回は特定バージョンを指定しないため、後ろ2つは空文字にして `username::` とします。

AWS のドキュメント上の JSON 構造も確認しておくと安心です。

[Secret JSON 構造リファレンス（AWS ドキュメント）](https://docs.aws.amazon.com/secretsmanager/latest/userguide/reference_secret_json_structure.html)

長期の認証情報を専用のシークレットストアで扱う、という考え方自体は AWS Well-Architected の方向性とも合っています。

[SEC09-BP02: Secrets の保護（AWS Well-Architected）](https://docs.aws.amazon.com/wellarchitected/latest/framework/sec_identities_secrets.html)

さらに、この記事で最終的に落ち着いたのは「RDS が管理するマスター資格情報を ECS から参照する」構成です。これは資格情報を GitHub Secrets や Terraform 変数から外すという意味では前進ですが、推奨構成としては一段妥協があります。運用としてより望ましいのは、アプリケーションが管理用ユーザーそのものを常用しないことです。可能なら、アプリ用の最小権限ユーザーを別で用意し、その資格情報を Secrets Manager で管理するほうが、責務分離の観点では自然です。

なお、`manage_master_user_password = true` を有効にすると RDS が自動でパスワードをローテーションします。自前で Secret を作る構成では手動または Lambda ローテーターが必要になりますが、RDS 管理シークレットでは AWS 側がこれを担ってくれます。長期間同一パスワードが使われ続けるリスクを減らせる点も、この構成を選んだ理由のひとつです。

## どこで詰まったか

最初は「RDS にシークレット管理を任せればきれいに終わる」と思っていました。

実際、設計としてはかなり素直です。

- DB パスワードを Terraform 変数や GitHub Secrets に常駐させたくない
- RDS が実際に使う資格情報と、ECS が読む資格情報を一致させたい

なので `manage_master_user_password = true` は本命でした。

ただ、この設定を有効にした apply だけが CI で通りませんでした。

理由は単純で、今回の構成では RDS が管理シークレットを扱う裏側で Secrets Manager 関連の操作が発生し、Terraform を回すロールに Permission Boundary があることで、その境界側で止まっていたからです。

つまり、

- IAM ポリシーでは許可したつもり
- でも Boundary 側で IAM 更新や Secrets Manager 操作が止まる
- 結果として `manage_master_user_password = true` の apply だけ失敗

という形です。

実際の GitHub Actions ログでも、同じ apply の中で次の2種類が出ていました。

```text
Error: putting IAM Role (...) Policy (...): ... AccessDenied: ... no permissions boundary allows the iam:PutRolePolicy action
Error: creating RDS DB Instance (...): ... AccessDenied: The user isn't authorized to create a secret in AWS Secrets Manager
```

ここでの学びは、**RDS の設定変更に見えても、実際は IAM 更新と Secrets Manager の両方まで見ないといけない**ということでした。

## 一度撤退した構成

この時点で無理に押し切るより、まずはデプロイ経路を生かすことを優先しました。

そこで一度、構成をこう変えています。

- `manage_master_user_password` をオフにする
- Terraform で `aws_secretsmanager_secret` を自前で作る
- Secret の JSON に `username` / `password` を詰める
- `db_password` だけは GitHub Secrets から `-var` で渡す
- ECS はその Terraform 管理 Secret を `valueFrom` で読む

実装としてはこんな形です。

```hcl
resource "aws_secretsmanager_secret" "db_credentials" {
  name = "${var.project_name}-db-credentials"
}

resource "aws_secretsmanager_secret_version" "db_credentials" {
  secret_id = aws_secretsmanager_secret.db_credentials.id
  secret_string = jsonencode({
    username = var.db_username
    password = var.db_password  # GitHub Secrets から -var 経由で受け取る
  })
}
```

きれいではないですが、Boundary の修正を待たずに前進できるという点ではかなり有効でした。

ただし、これはあくまで暫定退避です。GitHub Secrets に置いた値を CI から Terraform へ渡す形は、Secrets Manager に集約する構成よりも運用上の注意点が増えます。Terraform state や plan / apply 周辺の扱いまで含めて慎重に見る必要があるため、恒久策にはしませんでした。

この手の詰まり方では、「理想形に固執して全体を止める」よりも、「一時退避してから戻す」ほうが早いことがあります。

## どうやって本命構成に戻したか

のちに CI/CD 用の Boundary とポリシーを見直し、Secrets Manager を扱えるようにしたうえで、構成を元に戻しました。

やったことは次のとおりです。

- CI/CD ロール側で少なくとも `secretsmanager:CreateSecret` / `secretsmanager:TagResource` / `kms:DescribeKey` を含む関連アクションを許可する
- `manage_master_user_password = true` を再度有効化する
- workaround 用の Terraform 管理 Secret を撤去する
- deploy workflow から `db_password` の `-var` を外す
- ECS は RDS 管理シークレットの ARN を参照する

ポイントは、**ポリシーと Boundary の両方に必要なアクションを通す**ことです。AWS の有効権限は「アイデンティティポリシーの許可」と「Permission Boundary の許可」の積集合になるため、片方だけ足しても通りません。今回はポリシーへの追加が実質的に効いた部分でした。

```
# HannibalCICDPolicy の変更（概略）

# Before: secretsmanager 関連アクションが存在しなかった
"rds:*",
# secretsmanager:* なし → manage_master_user_password=true の apply で AccessDenied

# After: 必要な secretsmanager アクションを追加
"rds:*",
"secretsmanager:*",
```

Boundary 側も同様で、Boundary に必要なアクションが含まれていなければ、ポリシーで許可していても有効権限としては拒否されます。今回のように広めに `secretsmanager:*` を許可することもできますが、実運用では必要アクションに絞れるならそのほうが自然です。

整理すると、最終的な方針は次の切り分けです。

- GitHub Actions から AWS への認証は OIDC で一時クレデンシャル化する
- DB パスワードは GitHub Secrets に長居させず、Secrets Manager 側で管理する
- ECS は Secrets Manager から必要な値だけを受け取る

この流れを通して感じたのは、**Permission Boundary は強いガードレールだが、AWS のマネージド機能と組み合わせると「どこまでの権限が波及するか」を先に読んでおかないと実装速度が落ちる**ということでした。

## ECS 側で地味にハマった点

RDS 管理シークレットを使えば、接続情報が全部そこに入っている気がしてしまいます。

ただし、`manage_master_user_password = true` で作られる `rds!` プレフィックスのシークレットは、`username` と `password` のみを格納する仕様です。`host` や `port` は含まれません。Secrets Manager のローテーション機能で自前作成する RDS シークレットとは JSON 構造が異なります。

そのため今回の構成では、ECS 側は `username` / `password` だけを Secret から取り、`host` / `port` は RDS endpoint から分解して環境変数で渡しています。

実装としてはこういう形です。

```hcl
secrets = [
  { name = "DB_USER", valueFrom = "${var.db_credentials_secret_arn}:username::" },
  { name = "DB_PASSWORD", valueFrom = "${var.db_credentials_secret_arn}:password::" }
]

environment = [
  { name = "DB_HOST", value = local.rds_host },
  { name = "DB_PORT", value = local.rds_port },
  { name = "DB_NAME", value = var.db_name }
]
```

このとき Secret を読むのは **タスク実行ロール** です。アプリケーションコードが AWS API を叩くための **タスクロール** とは役割が違います。

ここを混ぜると、あとで IAM の切り分けがかなりつらくなります。

加えて、もし運用を詰めるなら、アプリケーションが使う DB ユーザーは管理用ユーザーと分けたほうが安全です。Secrets の保管場所を改善することと、DB 権限を最小化することは別の論点なので、両方を意識しておくと設計が安定します。

今回のように、まずは RDS 管理シークレットで一本化する構成は、資格情報を GitHub Secrets や Terraform 変数から外すという意味では十分に前進です。ただし、公開向けに正確に言うなら、これは「Secret の保管と受け渡しを改善した」のであって、「DB 権限分離まで完了した」こととは別です。ここは今回の着地点であって、推奨構成そのものとは切り分けて考えたほうが安全です。

## Terraform 的な罠: unknown ARN

RDS 管理シークレットの ARN は apply 後に確定します。

なので、この ARN をもとに別リソースの `count` を決めるような書き方をすると、plan 時点で unknown 扱いになって失敗することがあります。

たとえばこういう発想です。

```hcl
count = var.db_secret_arn != null ? 1 : 0
```

`var.db_secret_arn` が apply まで確定しないなら、count そのものが決まりません。

この問題にぶつかったときは、次を先に見ると調査が早いです。

- unknown な値を個数判定に使っていないか確認する
- `count` ではなく `for_each` のほうが表現しやすくないか見る
- `try()` を使う場所と使えない場所を切り分ける
- late-bound な値だと前提して module input を組み直す

たとえば、plan のどこが unknown になっているかをまず見たいときは、出力をそのまま読むだけでもかなり絞れます。

```bash
terraform plan
```

`(known after apply)` が連鎖している場所で `count` や分岐に使っていないかを見ると、原因に当たりやすいです。

## GitHub Actions では別の問題も混ざった

今回ややこしかったのは、Secrets 周りをいじった直後に apply が落ちたので、「原因も Secret 周りだろう」と思ってしまったことです。

でも実際のエラーログをよく読むと、並んでいたのは次のような 409 でした。

- IAM の `CreateRole` / `CreatePolicy` が `EntityAlreadyExists`
- Route 53 の `InvalidChangeBatch` で同名 A レコードが既に存在

ここには、今回追加した「ECS 実行ロール向けの Secret 読み取りポリシー」の 409 も含まれていました。

見た目としては「今回の Secret 実装が悪い」ように見えますが、実際には **AWS 側に同名リソースが残っているのに、Terraform state 側は未管理扱い** という drift の典型でした。

実際のログでも、たとえばこんな 409 がまとめて出ていました。

```text
Error: creating IAM Role (...): ... EntityAlreadyExists: Role with name ... already exists.
Error: creating Route53 Record: ... InvalidChangeBatch: [Tried to create resource record set ... but it already exists]
Error: creating IAM Policy (...): ... EntityAlreadyExists: A policy called ... already exists.
```

つまり構図としては、

- AWS には既にある
- state には無い
- Terraform が新規作成しようとして 409 を踏む

でした。

この切り分けができるまではかなり遠回りしました。

## じゃあどう復旧するか

こういう 409 が束で出ているときは、Secret の定義だけを疑うより先に state drift を見たほうが早いです。

対応の型はだいたい次の2つです。

- `terraform import` で実体を state に取り込む
- AWS 側の重複実体を整理してから apply し直す

本番に近い環境なら、安易な削除より import を先に検討したくなります。

ざっくりした判断基準としては、既存リソースを残したい本番寄りの環境では import を優先し、検証環境で不要な重複実体だと確認できているなら整理して作り直す、という切り分けが取りやすいです。

たとえば調査の入口としては、まず state に何が載っているかを確認し、足りない実体だけ import する流れが取りやすいです。

```bash
terraform state list
terraform import aws_iam_role.ecs_task_execution_role hannibal-ecs-task-execution-role
terraform import aws_iam_policy.ecs_secrets_policy arn:aws:iam::123456789012:policy/hannibal-ecs-secrets-policy
terraform plan
```

import のアドレスは module 配下なら `module.<name>.aws_...` の形になるので、実際には state の構造に合わせて読み替えてください。

## CI の順序でも地味に落ちる

このリポジトリでは、フロントエンド成果物を `fileset()` で拾って `aws_s3_object` を作っています。

なので Terraform apply より前にフロントエンドを build して `client/dist` を存在させておかないと、S3 オブジェクト周りでも state と実体がズレやすくなります。

実際の deploy の流れは、概ねこうです。

1. テスト
2. フロントエンド build
3. CI/CD Role を Assume
4. Terraform plan / apply
5. apply の output を使って S3 sync と CloudFront invalidation
6. ECR build / push と CodeDeploy

さらに、フロント用 S3 バケット自体は手動作成で Terraform は data source 参照、destroy 系ではバケット本体は消さずオブジェクトだけ掃除、という前提もあります。

実際、別の失敗 run では `reading S3 Bucket (...): couldn't find resource` も出ていて、Secrets の実装とは別に S3 側の前提崩れでも apply は落ちました。

この運用に別ブランチ作業や state リセットが重なると、Secrets とは別筋で `couldn't find resource` 系のエラーも起きやすくなります。

## 学び

- Permission Boundary がある環境では「このマネージド機能が裏で何の AWS API を叩くか」を先に洗い出す習慣をつけておくと、Boundary 違反に直後で気づける。設定一つに見えても IAM や Secrets Manager まで波及することがある
- ポリシーと Boundary は片方だけ直しても有効権限は変わらない。有効権限はその積集合なので、両方を見る視点がないと原因特定が遠回りになる
- 本命構成に固執して全体を止めるより、一時退避してから戻すほうが結果的に早いことがある。ただし退避策のトレードオフは明示しておかないとそのまま定着する
- Secret ARN は late-bound なので、Terraform の `count` や依存関係の組み方でハマりやすい。`for_each` や module input の分離でカバーする
- apply で 409 が束になっているときは、今回の差分だけでなく state drift を先に疑う。エラーログの件名だけ見て「今の変更のせいだ」と断定すると原因調査が遠回りになる
- ECS では Secret を読む主体がタスク実行ロールであることを意識すると、IAM の切り分けがしやすい
- Secret の管理方式を改善することと、DB ユーザーの権限分離は別論点。両方やらないと「どこまで終わったか」が曖昧になる
- CI の AWS 認証（OIDC）と DB の認証情報（Secrets Manager）は別レイヤーの話。混ぜて考えると設計の整理がつきにくくなる

## まとめ

最終形だけ見ると、やっていることはそこまで複雑ではありません。

- RDS が Secret を管理する
- ECS がそれを読む
- 実行ロールに最小限の読み取り権限を付ける
- 可能ならアプリ用 DB ユーザーを分けて、最小権限で接続する

でも実際に時間を使ったのは、その周辺でした。

- Permission Boundary とマネージド機能の前提権限
- Terraform の unknown 値と依存解決
- GitHub Actions の build 順序
- partial apply 後の state drift

Secrets Manager を実装した話というより、**マネージド機能を CI/CD と Terraform の現実に接続したとき、どこで引っかかるのかを学んだ話**だったと思っています。

そして、もし次にもう一段整えるなら、論点は「Secret をどこに置くか」ではなく、「アプリがどの DB ユーザーで入るか」に移ります。そこまで進めると、認証情報の保管と権限最小化の両方がそろいます。

## 今後の改善

今回の修正で改善できたのは、主に「CI/CD から長期の DB パスワードを外し、Secrets Manager に寄せること」でした。一方で、まだやり切れていない点もあります。

- アプリケーション用 DB ユーザーを管理用ユーザーから分離する
- Secrets Manager と IAM の権限を、必要アクションベースでもう少し絞り込む
- 必要なら IAM DB 認証の適用可否も検討する

この記事のスコープではここまで踏み込みませんでしたが、公開向けに正確に言うなら、このあたりまで進めてはじめて「Secret の保管」だけでなく「DB 権限設計」まで含めて改善できたと言えます。

もし同じように、

- CI ロールに Permission Boundary がある
- ECS で Secret 注入したい
- `manage_master_user_password` を試している
- apply で 409 や AlreadyExists が混ざって見える

という状況なら、Secret の定義だけでなく **Boundary と state drift を分けて診る**ところから始めるのがおすすめです。
