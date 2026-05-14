---
title: "Terraform importだけでは終わらない、既存Glue TableをNo changesまで持っていく"
emoji: "🧭"
type: "tech"
topics: ["terraform", "aws", "glue", "athena", "iac"]
published: true
---

## はじめに

対象読者は次のような方です。

- 既存リソースを `terraform import` したことはあるが、なぜその順番が必要なのか腹落ちしていない
- import 後に差分が残る理由と、どこまで確認すれば「完了」と言えるのかを知りたい
- `-target` を使うべき場面と、使いすぎてはいけない理由を整理したい

今回扱う具体例は、CloudTrail ログを Athena で読むための Glue Catalog Table を `aws_glue_catalog_table` として Terraform 管理に移した作業です。

:::message
この記事は「Terraform import の基本操作」ではなく、**既存リソース・tfstate・Terraform定義を安全に揃えて `No changes` まで持っていく**ことに焦点を当てます。
:::

## 先に結論

既存リソースを Terraform 管理へ移すときは、`.tf` に resource block を書くだけでは不十分です。`tfstate` に対応関係がなければ、AWS 上に存在するリソースでも `plan` では `create` として扱われます。

今回の安全な流れは次の順番でした。

1. Terraform 定義に `aws_glue_catalog_table` を追加する
2. `plan` で、既存 Glue table が `create` 扱いになることを確認する
3. 先に必要な IAM 権限だけを `-target` で適用する
4. 既存 Glue table を `terraform import` で state に紐づける
5. `plan` で import 後に残る微差分を確認する
6. 必要な差分だけ apply する
7. 最後に `-target` なしの full plan で `No changes` を確認する

ゴールは `import 成功` ではなく、**Terraform 定義・tfstate・AWS 上の既存リソースが一致した状態**です。

## 3つを分けて考える

既存リソースの取り込みで混乱しやすいのは、Terraform が見ているものが1つではないからです。

| 観点 | 役割 |
|---|---|
| Terraform 定義 | `.tf` ファイルに書いた「こう管理したい」という宣言 |
| tfstate | Terraform が「この resource block はこの AWS 上のリソースに対応する」と記録する管理台帳 |
| AWS 上の既存リソース | 実際に AWS アカウント上に存在している Glue table や S3 bucket など |

今回の作業前は、3つの状態が次のようにずれていました。

| 観点 | 状態 |
|---|---|
| Terraform 定義 | `aws_glue_catalog_table.cloudtrail_logs_partitioned` はまだない |
| tfstate | Glue table は登録されていない |
| AWS 上の既存リソース | `cloudtrail_logs_partitioned` は存在している |

PR で Terraform 定義を追加した直後は `aws_glue_catalog_table.cloudtrail_logs_partitioned` の対応関係だけが `tfstate` に未登録のまま残ります。この状態で `terraform plan` を実行すると、Terraform は `create` として表示します。反射的に `apply` しないことが大事で、リソース種別によっては `AlreadyExists` エラーになるか、意図しない別リソースが作られます。

## 今回やりたかったこと

CloudTrail ログは S3 に保存されます。Athena は Glue Data Catalog の table 定義を見て「どこにあるデータを、どんな列として読むか」を判断します。

以前は、Terraform で管理していたのは table 本体ではなく、CREATE TABLE 用の Athena named query だけでした。

```hcl
resource "aws_athena_named_query" "create_partitioned_table" {
  name      = "create-partitioned-cloudtrail-table"
  database  = aws_athena_database.hannibal_logs.name
  workgroup = aws_athena_workgroup.hannibal_analysis.name

  query = <<EOF
CREATE EXTERNAL TABLE IF NOT EXISTS ...
EOF
}
```

これは「テーブルを作るためのSQL」を保存しているだけで、table 本体は state 外にあります。設定変更のたびに DDL を手動実行する必要がありました。

今回の変更で、テーブル本体を `aws_glue_catalog_table` として定義しました。以下は主要部分の抜粋です（実際には `month`/`day` の `partition_keys` と `columns` も定義しています）。

```hcl
resource "aws_glue_catalog_table" "cloudtrail_logs_partitioned" {
  name          = "cloudtrail_logs_partitioned"
  database_name = aws_athena_database.hannibal_logs.name
  table_type    = "EXTERNAL_TABLE"

  parameters = {
    EXTERNAL                    = "TRUE"
    "projection.enabled"        = "true"
    "projection.month.digits"   = "2"
    "projection.day.digits"     = "2"
    "storage.location.template" = "s3://${aws_s3_bucket.cloudtrail_logs.bucket}/AWSLogs/${var.aws_account_id}/CloudTrail/ap-northeast-1/$${year}/$${month}/$${day}/"
  }

  partition_keys {
    name = "year"
    type = "string"
  }

  storage_descriptor {
    input_format  = "com.amazon.emr.cloudtrail.CloudTrailInputFormat"
    output_format = "org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat"

    ser_de_info {
      serialization_library = "org.openx.data.jsonserde.JsonSerDe"
    }
  }

  lifecycle {
    prevent_destroy = true
  }
}
```

## PR時点の plan は意図どおり `create` だった

PR で Terraform 定義を追加した時点の plan は次のような結果でした。

| 対象 | plan |
|---|---|
| `aws_glue_catalog_table.cloudtrail_logs_partitioned` | `create` |
| `aws_athena_named_query.create_partitioned_table` | `destroy` |
| `aws_iam_policy.hannibal_foundation_services_policy` | `update in-place` |

```text
Plan: 1 to add, 1 to change, 1 to destroy.
```

この `1 to add` は「Terraform 定義と state の対応がまだないため新規作成に見えている」だけです。apply せず import が必要とわかっています。

## なぜIAM権限だけ先に `-target` apply したか

Glue table を import するには、Terraform 実行 Role が Glue table を読める必要があります。今回は Foundation 用 IAM policy に Glue table 用の action が不足していました。

```diff
 "glue:CreateDatabase",
+"glue:CreateTable",
 "glue:DeleteDatabase",
+"glue:DeleteTable",
 "glue:GetDatabase",
 "glue:GetDatabases",
+"glue:GetTable",
+"glue:GetTables",
 "glue:UpdateDatabase",
+"glue:UpdateTable",
```

この状態でいきなり import / apply に進むと、Terraform 実行 Role が必要な API を呼べません。そこで IAM policy だけを先に target apply しました。

```bash
terraform -chdir=terraform/foundation apply \
  -target=aws_iam_policy.hannibal_foundation_services_policy
```

`-target` を使った理由は明確です。「部分適用で終わらせるため」ではなく、「依存する操作を安全に進めるための段階分け」として使っています。Terraform も target 使用時に警告を出すため、通常運用での多用には適しません。

:::message alert
`-target` を使った後は、必ず target なしの full plan を実行して、取りこぼした差分がないか確認します。
:::

## 既存Glue tableをimportする

IAM policy を更新したあと、既存 Glue table を Terraform state に import しました。

```bash
terraform -chdir=terraform/foundation import \
  aws_glue_catalog_table.cloudtrail_logs_partitioned \
  <account-id>:hannibal_cloudtrail_db:cloudtrail_logs_partitioned
```

import が成功すると、Terraform は `aws_glue_catalog_table.cloudtrail_logs_partitioned` と AWS 上の `hannibal_cloudtrail_db.cloudtrail_logs_partitioned` の対応を state に記録します。

:::message
Terraform 1.5以降では `import` block を使って、import 操作自体を configuration に含める方法もあります。CI/CD で import までレビューしたい場合は import block が向いています。今回は既に書いた resource block に対して CLI の `terraform import` を実行しました。
:::

## import後にも微差分は残る

import は AWS 上の既存リソースを state に紐づける操作です。Terraform 定義が既存リソースの全属性と完全に一致していることまでは保証しません。

今回も import 後の plan では、Glue table に小さな差分が残りました。

```text
# aws_glue_catalog_table.cloudtrail_logs_partitioned will be updated in-place
~ resource "aws_glue_catalog_table" "cloudtrail_logs_partitioned" {
    - owner = "hadoop" -> null
  ~ parameters = {
      - "transient_lastDdlTime" = "..." -> null
    }

  ~ storage_descriptor {
      - skewed_info { ... } -> null
    }
}
```

Athena の DDL 実行で付与された一時的なメタデータや、Terraform 定義では明示しない空の `skewed_info` が差分として出たものです。

ここで見るべきポイントは、差分が **destroy / recreate ではなく in-place update か**、また **消して問題ないメタデータか** です。今回は table metadata の正規化だったため、旧 named query の削除とあわせて target apply しました。

```bash
terraform -chdir=terraform/foundation apply \
  -target=aws_glue_catalog_table.cloudtrail_logs_partitioned \
  -target=aws_athena_named_query.create_partitioned_table
```

```text
Apply complete! Resources: 0 added, 1 changed, 1 destroyed.
```

`1 destroyed` は Glue table ではなく、不要になった `aws_athena_named_query.create_partitioned_table` です。

## 最後は必ず full plan で `No changes`

target apply は一部だけを対象にするため、成功しても全体が揃ったとは限りません。最後に target なしで full plan を実行しました。

```bash
terraform -chdir=terraform/foundation plan \
  -refresh=true \
  -lock=false \
  -input=false \
  -no-color \
  -detailed-exitcode
```

```text
No changes. Your infrastructure matches the configuration.
```

:::message
この環境では確認用 plan を `-lock=false` で実行していますが、通常の apply では state lock を取る運用を推奨します。`-lock=false` は例外的なオプションであり、常用する前提のものではありません。
:::

| 段階 | 確認内容 | 結果 |
|---|---|---|
| PR時点の plan | 追加される resource / 削除される named query / IAM 更新を確認 | `1 add, 1 change, 1 destroy` |
| IAM target apply | Glue table 管理に必要な IAM action を先に反映 | `0 added, 1 changed, 0 destroyed` |
| import | 既存 Glue table を state に登録 | import successful |
| table / named query target apply | Glue table の微差分を正規化し、旧 named query を削除 | `0 added, 1 changed, 1 destroyed` |
| full plan | target なしで全体の残差分を確認 | `No changes` |

## 採用しなかった選択肢

### そのまま apply する

Terraform 定義に Glue table resource を追加しただけの状態では、state に対応関係がありません。apply すると同名 Glue table の `AlreadyExists` エラーになるか、意図しない別リソースが作られます。既存リソースを管理下に置くなら先に import します。

### 旧 named query を残す

Glue table 本体を `aws_glue_catalog_table` で管理するなら、CREATE TABLE 用の saved query は同じ責務を二重に持ちます。このリポジトリには CloudTrail ログを検索・分析する SELECT クエリも named query として別途保存しています。そちらは残し、テーブル作成用の named query だけを削除しました。

### 全部まとめて full apply する

Glue table 操作に必要な IAM action が先に必要だったため、段階的に apply しました。IAM 更新と Glue table import をまとめて扱うより、実行 Role の権限を整えてから import する方が、失敗時の切り分けが簡単です。

## ロールバックをどう考えたか

既存リソースを Terraform 管理に移す作業では、ロールバックも3つに分けて考えます。

| 観点 | 戻す内容 |
|---|---|
| Terraform 定義 | PR の commit を revert する |
| tfstate | import 済み resource address を必要に応じて `terraform state rm` する |
| AWS 上の既存リソース | Glue table 本体は削除しない |

今回の Glue table は既存の分析基盤で使う永続リソースです。Terraform 管理から外す必要がある場合は state から外す考え方になります。

```bash
terraform -chdir=terraform/foundation state rm \
  aws_glue_catalog_table.cloudtrail_logs_partitioned
```

`state rm` は AWS 上のリソースを削除しません。Terraform の管理台帳から外す操作です。実行すると Terraform はそのリソースを管理対象として認識しなくなります。「Terraform 管理から外す」ことが意図どおりか確認してから実行します。

## まとめ

`terraform import` は、既存リソースを Terraform 管理に入れるための入口です。しかし import 自体はゴールではありません。

- `.tf` に resource block を書いただけでは、Terraform は既存リソースとの対応を知りません
- import は state に対応を登録する操作で、定義と実態の完全一致は保証しません
- import 後の差分が `destroy / recreate` か `in-place update` かを読む。これが一番慎重に見るべき点です
- `-target` は「依存する操作を段階分けするため」に使い、使った後は必ず full plan で確認します
- `No changes` になって初めて管理化が完了したと判断します

「import したから終わり」ではなく、「No changes まで持っていく」。この感覚が既存リソースの IaC 化を安全に進める軸になります。

## 参考リンク

- [Terraform: Import existing resources](https://developer.hashicorp.com/terraform/cli/import)
- [Terraform: Import a single resource](https://developer.hashicorp.com/terraform/language/import/single-resource)
- [Terraform: State](https://developer.hashicorp.com/terraform/language/state)
- [Terraformのimportコマンドとimportブロックを試してみた | DevelopersIO](https://dev.classmethod.jp/articles/terraform-import-command-and-import-block/)
- [既存 AWS リソースを Terraform 化するハンズオン | Zenn](https://zenn.dev/y_u_t_a/articles/052b9f6621a148)

<!-- redeploy: 2026-05-14 -->
