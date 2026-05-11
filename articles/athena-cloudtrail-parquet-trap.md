---

title: "Athena で CloudTrail ログを読もうとしたら2段階でハマった"
emoji: "🪤"
type: "tech"
topics: ["aws", "terraform", "athena", "cloudtrail", "cloudwatch"]
published: true
---

## はじめに

この記事は、AWS CloudTrail のログを Athena で分析しようとしている AWS / Terraform エンジニア向けです。

CloudTrail 監視基盤（CloudWatch Logs 連携・alarm・SNS）を実装してテストしたところ、CloudTrail と CloudWatch は正常に動作したのに Athena だけ常に 0 件を返すという問題に遭遇しました。

原因を調査したところ、独立した2つのバグが重なっていました。どちらも Athena がエラーを返さず SUCCEEDED で 0 件を返すため、「データがないのか」「設定が悪いのか」の切り分けが難しい類の問題でした。

この記事では、次を扱います。

* Athena が 0 件を返した原因1：`STORED AS PARQUET` は生の CloudTrail ログに使えない
* 原因2：partition projection の month/day にゼロパディング設定が必要
* 各修正の内容と、修正後の検証結果

## 運用コンテキストと確認環境

個人開発の DevOps ポートフォリオ `terraform-hannibal` の `foundation` レイヤで作業しました。対象は `dev` 相当の AWS 環境です。

確認環境は次の通りです。

| 項目           | 値                 |
| ------------ | ----------------- |
| Terraform    | `1.14.8`          |
| AWS Provider | `6.7.0`           |
| AWS CLI      | `aws-cli/2.34.22` |
| 対象リージョン      | `ap-northeast-1`  |
| 確認時点         | 2026年5月           |

## 先に結論

* CloudTrail の生ログ（`.json.gz`）を Athena で読むには `CloudTrailInputFormat + JsonSerDe` が必要。`STORED AS PARQUET` は Glue ETL で変換した後に使う形式であり、生ログには使えない
* partition projection で month/day を S3 実パス（`05/`, `11/`）に合わせるには `projection.month.digits=2` / `projection.day.digits=2` が必要
* どちらのバグも Athena が SUCCEEDED を返しながら 0 件になるため、エラーログだけ見ていると気づけない

## Athena でログ確認しようとして問題が発覚した

CloudTrail → CloudWatch Logs 連携・監視アラームの実装後、各コンポーネントの動作確認をしました。CloudTrail と CloudWatch は正常でしたが、Athena だけ問題がありました。

## Athena が 0 件を返した

次のクエリを実行したところ、SUCCEEDED が返ったにもかかわらず結果が 0 件でした。

```sql
SELECT COUNT(*) AS log_count
FROM hannibal_cloudtrail_db.cloudtrail_logs_partitioned
WHERE year='2026' AND month='5'
```

S3 のログ出力先を確認すると、データは届いていました。

```
AWSLogs/xxxxxxxxxxxx/CloudTrail/ap-northeast-1/2026/05/11/
  xxxxxxxxxxxx_CloudTrail_ap-northeast-1_20260511T...json.gz
  ...
```

データはある。クエリも SUCCEEDED。しかし 0 件。この組み合わせが問題の切り分けを難しくする原因でした。

## ハマり1：`STORED AS PARQUET` は生の CloudTrail ログに使えない

### 原因

テーブルの CREATE 文を確認したところ、次のように定義されていました。

```sql
STORED AS PARQUET
```

Parquet は列指向の圧縮フォーマットです。Athena クエリの高速化に有効ですが、**Glue ETL などで変換した後のデータに使う形式**です。

CloudTrail が S3 に保存するのは `.json.gz`（JSON を gzip 圧縮したもの）です。Athena は `STORED AS PARQUET` の宣言を信じてファイルを Parquet として読もうとしますが、実際は JSON なので読み取れず、エラーなしで 0 件を返します。

### 修正

CloudTrail ログを直接読み取るには、AWS が提供する `CloudTrailInputFormat` を使います。

```sql
ROW FORMAT SERDE 'org.openx.data.jsonserde.JsonSerDe'
WITH SERDEPROPERTIES (
  'serialization.format' = '1'
)
STORED AS INPUTFORMAT  'com.amazon.emr.cloudtrail.CloudTrailInputFormat'
           OUTPUTFORMAT 'org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat'
```

`CloudTrailInputFormat` は `Records` 配列を自動で展開するため、テーブルスキーマはフラット構造で定義できます。これに伴い `CROSS JOIN UNNEST(Records)` を使っていた分析クエリも不要になります。

```sql
-- 修正前
FROM cloudtrail_logs_partitioned
CROSS JOIN UNNEST(Records) AS t(record)
WHERE record.userIdentity.arn LIKE '...'

-- 修正後
FROM cloudtrail_logs_partitioned
WHERE useridentity.arn LIKE '...'
```

テーブルを DROP して CREATE し直したところ、クエリが 0 件を返さなくなりました。ただし、まだ問題が残っていました。

## ハマり2：partition projection の month がゼロパディング不一致

### 原因

`CloudTrailInputFormat` への修正後、`month='05'` で 192 件取得できました。しかし `month='5'` では依然 0 件でした。

S3 の実パスを確認すると `2026/05/11/`（ゼロパディングあり）になっていました。

```
AWSLogs/.../CloudTrail/.../2026/05/11/
```

partition projection の設定を確認すると、次のようになっていました。

```sql
TBLPROPERTIES (
  'projection.month.type'='integer',
  'projection.month.range'='01,12',
  -- digits 未設定
  ...
  'storage.location.template'='.../ap-northeast-1/$${year}/$${month}/$${day}/'
)
```

`type=integer` かつ `digits` 未設定の場合、Athena は month の値を `1`, `2`, ... `12` として生成します。`storage.location.template` の `$${month}` にはこの値が入るため、Athena が参照するパスは `.../2026/5/` になります。しかし S3 の実パスは `.../2026/05/` なのでデータが見つからず、0 件になります。

### 修正

`projection.month.digits=2` / `projection.day.digits=2` を追加します。

```sql
TBLPROPERTIES (
  'projection.month.type'='integer',
  'projection.month.range'='01,12',
  'projection.month.digits'='2',
  'projection.day.type'='integer',
  'projection.day.range'='01,31',
  'projection.day.digits'='2',
  ...
)
```

`digits=2` により Athena は `01`, `02`, ... `12` のようにゼロパディングした値を生成します。S3 実パスの `05/` と一致するようになり、クエリが正常にデータを取得できます。

:::message
`digits=2` を追加した後も `month='5'`（ゼロパディングなし）では 0 件になります。projection が `05` を生成するため、クエリでは `month='05'` の形式が必要です。
:::

テーブルを再度 DROP → CREATE し直したところ、`month='05'` で 278 件取得できました。

## なぜ Glue ETL で Parquet に変換しなかったか

Parquet 形式自体は Athena クエリの高速化に有効です。Glue ETL で CloudTrail ログを Parquet に変換してから Athena で読む構成も選択肢としてあります。ただし Glue ジョブのコスト・スケジュール管理が増えるため、dev 環境での分析用途には過剰と判断しました。生ログを `CloudTrailInputFormat` で直接読む構成の方がシンプルです。

## 検証結果

| 段階 | 確認内容 | 結果 |
| --- | --- | --- |
| Athena（PARQUET 修正前） | `SELECT COUNT(*)` | SUCCEEDED / 0件 |
| Athena（CloudTrailInputFormat 修正後） | `SELECT COUNT(*) WHERE year='2026' AND month='05'` | SUCCEEDED / 192件 |
| Athena（digits 修正後） | `SELECT COUNT(*) WHERE year='2026' AND month='05'` | SUCCEEDED / 278件 |

## まとめ

どちらのバグも Athena がエラーを返さず SUCCEEDED で 0 件を返すため、「データがないのか設定が悪いのか」の切り分けに時間がかかります。

Athena で CloudTrail ログが取れないとき、まずテーブルの `STORED AS` と `projection.*.digits` を確認してください。

## 参考リンク

* [AWS CloudTrail User Guide: Querying logs with Athena](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-query-tables.html) — CloudTrail + Athena の公式リファレンス構成
* [Amazon Athena: Partition projection](https://docs.aws.amazon.com/athena/latest/ug/partition-projection.html) — digits プロパティの仕様
* [com.amazon.emr.cloudtrail.CloudTrailInputFormat](https://docs.aws.amazon.com/athena/latest/ug/cloudtrail-logs.html) — CloudTrail 専用 InputFormat の説明
