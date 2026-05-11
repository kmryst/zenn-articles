---

title: "CloudTrail と depends On and On and On……"
emoji: "🧩"
type: "tech"
topics: ["aws", "terraform", "cloudtrail", "iam", "s3"]
published: true
---

## はじめに

`aws_cloudtrail` を追加するだけのつもりが、bucket policy、IAM policy、Permission Boundary まで依存関係が連鎖しました。

この記事では次を扱います。

- CloudTrail が S3 に書き込むために必要な bucket policy と `depends_on` による依存順序の明示
- `terraform plan` の change 数で IAM statement 配置ミスを検知した near-miss

CloudWatch Logs 連携・監視通知は別 Issue に分離したため扱いません。

確認環境: Terraform `1.14.8` / AWS Provider `6.7.0` / `ap-northeast-1` / 2026年5月

## 先に結論

CloudTrail trail を Terraform 管理に追加する場合、trail 本体だけでは完結しません。

- CloudTrail が S3 にログを書き込むには、ログ出力先バケットの bucket policy が必要
- その bucket policy を Terraform で管理するには、Terraform 実行 Role の identity policy と Permission Boundary の両方に `s3:GetBucketPolicy` / `s3:PutBucketPolicy` が必要
- そのため `depends_on` で IAM policy → S3 bucket policy → CloudTrail trail の適用順序を明示した

## IAM policy → S3 bucket policy → CloudTrail trail の依存順序

依存関係を trail から逆向きに辿ると整理できます。

```text
IAM policy / Permission Boundary
  ↓ (Terraform 実行 Role が bucket policy を操作できる)
S3 bucket policy
  ↓ (CloudTrail が S3 に書き込める)
CloudTrail trail
```

一般化すると、Terraform 実行主体の identity policy と permission boundary の両方を整理する必要がある話です。

Permission Boundary を設定している場合、identity policy だけ更新しても不十分です。

- identity policy：その Role に許可する操作
- Permission Boundary：その Role が最大で実行できる操作の上限

両方に `s3:GetBucketPolicy` / `s3:PutBucketPolicy` を許可する必要があります（Terraform は apply のたびに現状を read してから write するため、Get 権限も必要です）。

:::message
`depends_on` は Terraform の適用順序を制御するだけです。IAM ポリシーの伝播待ちや、実行者自身の権限不足を魔法のように解決するものではありません。
:::

完全なリソース定義は次の通りです。

```hcl
resource "aws_s3_bucket_policy" "cloudtrail_logs" {
  bucket = "nestjs-hannibal-3-cloudtrail-logs"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AWSCloudTrailAclCheck"
        Effect    = "Allow"
        Principal = { Service = "cloudtrail.amazonaws.com" }
        Action    = "s3:GetBucketAcl"
        Resource  = "arn:aws:s3:::nestjs-hannibal-3-cloudtrail-logs"
        Condition = {
          StringEquals = {
            "aws:SourceArn" = "arn:aws:cloudtrail:ap-northeast-1:xxxxxxxxxxxx:trail/nestjs-hannibal-3"
          }
        }
      },
      {
        Sid       = "AWSCloudTrailWrite"
        Effect    = "Allow"
        Principal = { Service = "cloudtrail.amazonaws.com" }
        Action    = "s3:PutObject"
        Resource  = "arn:aws:s3:::nestjs-hannibal-3-cloudtrail-logs/AWSLogs/xxxxxxxxxxxx/*"
        Condition = {
          StringEquals = {
            "s3:x-amz-acl"  = "bucket-owner-full-control"
            "aws:SourceArn" = "arn:aws:cloudtrail:ap-northeast-1:xxxxxxxxxxxx:trail/nestjs-hannibal-3"
          }
        }
      }
    ]
  })

  depends_on = [
    aws_iam_policy.foundation_services_policy
  ]
}

resource "aws_cloudtrail" "hannibal_trail" {
  name           = "nestjs-hannibal-3"
  s3_bucket_name = "nestjs-hannibal-3-cloudtrail-logs"

  depends_on = [
    aws_s3_bucket_policy.cloudtrail_logs
  ]
}
```

`xxxxxxxxxxxx` は AWS アカウント ID に置き換えてください。`aws:SourceArn` で指定した trail からの書き込みだけに絞れます。

:::message
このプロジェクトでは Permission Boundary の変更を Terraform 実行 Role に許可しない設計のため、今回の apply は IAM User で実行しました。Boundary 更新を含む apply の実行者は、設計によって変わります。
:::

## near-miss：plan の change 数で statement 配置ミスを検知した

今回の実装で、`terraform plan` の change 数が想定と違ったことで IAM statement の配置ミスを検知できました。

事前に想定していた plan：

```text
2 to add, 2 to change, 0 to destroy
```

| 種別     | 対象                         |
| ------ | -------------------------- |
| add    | CloudTrail trail           |
| add    | S3 bucket policy           |
| change | Foundation Services Policy |
| change | Foundation Boundary        |

最初に出た plan：

```text
2 to add, 1 to change, 0 to destroy
```

`1 to change` の時点で Services Policy 側への反映漏れを疑えました。確認すると、`s3:GetBucketPolicy` / `s3:PutBucketPolicy` の statement が Services Policy 用の locals ではなく Boundary 側だけに入っていました。隣接して定義されている2つのリストの追記先を間違えた形です。

`terraform plan` は「apply 前に流すコマンド」ではなく、「想定する差分構造と照合するレビュー材料」として使う。apply 前に変更対象リソースと変更種別を PR description に書き出しておくと、このズレを確実に検知でき、レビュアーとの認識合わせにもなります。

## 検証結果

| 段階              | 確認内容                                                     | 結果                                              |
| --------------- | -------------------------------------------------------- | ----------------------------------------------- |
| 静的検証            | `terraform fmt -check -recursive` / `terraform validate` | Pass                                            |
| plan 確認         | `terraform plan` の差分                                     | `2 to add, 2 to change, 0 to destroy`           |
| apply           | foundation への反映                                          | `2 added, 2 changed, 0 destroyed`               |
| CloudTrail 状態確認 | `aws cloudtrail get-trail-status`                        | `IsLogging: true` / `LatestDeliveryError: null` |
| 運用 Role 検証      | Foundation Role assume 後の `terraform plan`               | `No changes`                                    |

apply 後に通常運用 Role で `No changes` になることを確認することで、次回以降の apply が IAM User なしで完結することを担保しています。

## 自分の環境で確認するチェックリスト

- [ ] ログ出力先 S3 バケットが存在するか
- [ ] bucket policy に `s3:GetBucketAcl` と `s3:PutObject` の statement が含まれているか
- [ ] `aws:SourceArn` が自分の trail ARN になっているか
- [ ] Terraform 実行 Role の identity policy に `s3:GetBucketPolicy` / `s3:PutBucketPolicy` が含まれているか
- [ ] Permission Boundary を使っている場合、そちらにも同じ s3 権限が含まれているか（identity policy だけでは不十分）
- [ ] apply 前に `terraform plan` の想定変更を書き出しているか
- [ ] apply 後に通常運用 Role での `terraform plan` が `No changes` になるか
- [ ] `aws cloudtrail get-trail-status` で `IsLogging: true` / `LatestDeliveryError: null` になっているか

## まとめ

CloudTrail trail を Terraform で管理するとき、trail だけを見ていると bucket policy や IAM 権限という「trail の前提」が Terraform 外に残ります。`depends_on` で IAM policy → S3 bucket policy → CloudTrail trail の連鎖を明示することで、その前提を PR 差分としてレビューできる形にできます。

`terraform plan` は想定する差分構造と照合するレビュー材料として使う。この照合習慣は CloudTrail に限らず、IAM 変更を伴う Terraform 操作全般で有効です。

## 参考リンク

- [AWS CloudTrail User Guide](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-user-guide.html) — trail / management events / log file validation
- [Amazon S3 bucket policy for CloudTrail](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/create-s3-bucket-policy-for-cloudtrail.html) — CloudTrail ログ用 bucket policy の要件
- [IAM Permission Boundaries](https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies_boundaries.html) — identity policy と Boundary の関係
- [Terraform: depends_on Meta-Argument](https://developer.hashicorp.com/terraform/language/meta-arguments/depends_on) — 暗黙的に解決できない依存関係の明示方法
