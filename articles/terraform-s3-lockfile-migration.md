---
title: "Terraform S3 backendをS3 lockfileへ移行した：DynamoDB lockingをすぐ消さなかった理由"
emoji: "🔐"
type: "tech"
topics: ["terraform", "aws", "s3", "dynamodb", "iam"]
published: true
---

Terraform の S3 backend で使っていた DynamoDB-based locking を、S3 lockfile に移行しました。

`use_lockfile = true` を足すだけに見えますが、実際には IAM 権限、PR plan の lock 方針、移行期間、実Roleでの検証まで考える必要がありました。この記事では何を一気に変えず、どこまで確認して完了扱いにしたかを書きます。

:::message
個人開発の `dev` 環境が前提です。確認日は 2026-05-09、Terraform 1.12.1 系、AWS provider 6.x 系。
`use_lockfile = true` は Terraform 1.10 以降で使用できます。それ以前では無視されます。
本番共有環境では移行期間・承認・監視・ロールバックをより厳密に設計してください。
:::

## 先に結論

S3 backend に `use_lockfile = true` を追加し、`.tflock` に必要な S3 権限を IAM Role に付与しました。DynamoDB locking はすぐには消さず、1週間の安定確認後に外す方針にしました。

| 観点 | 変更前 | 第1段階の変更後 | 第2段階（完了後） |
| --- | --- | --- | --- |
| backend lock | DynamoDB locking | S3 lockfile + DynamoDB locking 併用 | S3 lockfile のみ |
| backend 設定 | `dynamodb_table` | `use_lockfile = true` と `dynamodb_table` | `use_lockfile = true` のみ |
| lock object | DynamoDB table item | S3 の `.tflock` object | S3 の `.tflock` object |
| IAM | DynamoDB lock 権限 | `.tflock` の S3 Get/Put/Delete 権限を追加 | DynamoDB lock 権限を削除 |
| DynamoDB table | 必須 | 移行期間中は保持 | 削除 |
| 完了判断 | plan が通る | 実Roleで `.tflock` 作成・削除、`refresh=true` plan 差分なし | S3 lockfile 単独で plan・deploy・destroy が通る |

S3 lockfile は state file と同じパスに `.tflock` 拡張子で作成されます（例: `foundation/terraform.tfstate` → `foundation/terraform.tfstate.tflock`）。IAM 権限や `s3:ListBucket` の prefix 条件でこの2つを別々に扱います。

## 運用コンテキスト

AWS / Terraform / GitHub Actions の個人開発ポートフォリオ環境（dev のみ）で、3つの Role が登場します。

| Role | 用途 |
| --- | --- |
| `HannibalCICDRole-Dev` | GitHub Actions の deploy / destroy 用 |
| `HannibalFoundationRole-Dev` | `terraform/foundation` の手動 apply 用 |
| `HannibalPRPlanRole-Dev` | PR の `terraform plan` 用。read-only |

Role ごとに lockfile の扱いが違います。

- deploy / destroy 用・foundation apply 用 Role は `.tflock` の作成・削除権限が必要
- PR plan 用 Role は `-lock=false` で実行するため、`.tflock` の write/delete 権限は付けない

PR plan 用 Role に write 権限を持たせると read-only という権限境界がぼやけます。ここは役割で分けました。

## なぜDynamoDB lockingをすぐ消さなかったか

backend の lock は Terraform 操作の入口です。変更直後に戻し先を消すのはリスクが高いため、次の判断にしました。

| 選択肢 | やめた理由 |
| --- | --- |
| `use_lockfile = true` と同時に DynamoDB を削除 | backend 変更直後に戻し先がなくなる |
| DynamoDB locking を残したまま何もしない | deprecated への対応にならない |
| **まず併用し、安定後に DynamoDB を削除** | **採用。戻し先を残しつつ移行できる** |

deprecated warning は移行期間中の警告として扱い、1週間 backend まわりが安定したことを確認してから DynamoDB locking を外します。

## backend設定の変更

:::message alert
**apply の実行主体を確認してください。**

`terraform/foundation` の apply は `HannibalFoundationRole-Dev` を assume した状態で実行します。apply 前に確認します。

```bash
aws sts get-caller-identity
```
:::

S3 backend に `use_lockfile = true` を足します。

```diff
terraform {
  backend "s3" {
    bucket         = "example-terraform-state"
    key            = "foundation/terraform.tfstate"
    region         = "ap-northeast-1"
+   use_lockfile   = true
    dynamodb_table = "terraform-state-lock"
    encrypt        = true
  }
}
```

`dynamodb_table` はこの段階では残します。

```hcl
dynamodb_table = "terraform-state-lock" # Legacy DynamoDB lock during migration
```

## IAM権限の追加

state file と lockfile を statement でも分けます。state file には `s3:GetObject` / `s3:PutObject`、lockfile には `s3:DeleteObject` も追加します。

```hcl
{
  Sid      = "TerraformFoundationStateObject"
  Effect   = "Allow"
  Action   = ["s3:GetObject", "s3:PutObject"]
  Resource = ["arn:aws:s3:::example-terraform-state/foundation/terraform.tfstate"]
}

{
  Sid      = "TerraformFoundationStateLockObject"
  Effect   = "Allow"
  Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
  Resource = ["arn:aws:s3:::example-terraform-state/foundation/terraform.tfstate.tflock"]
}
```

`s3:ListBucket` の prefix 条件にも `.tflock` を足します。

```hcl
Condition = {
  StringLike = {
    "s3:prefix" = [
      "foundation/",
      "foundation/terraform.tfstate",
      "foundation/terraform.tfstate.tflock",
    ]
  }
}
```

PR plan 用 Role には `.tflock` の write/delete 権限を付けていません。`-lock=false` で実行するため不要で、read-only Role の設計意図を保ちます。

## 移行時に確認したこと

### 1. 静的確認

```bash
terraform fmt -check -recursive
terraform -chdir=terraform/foundation init -backend=false && terraform -chdir=terraform/foundation validate
terraform -chdir=terraform/environments/dev init -backend=false && terraform -chdir=terraform/environments/dev validate
```

### 2. dev backendで `.tflock` の作成削除を確認

`terraform/environments/dev` で `-lock=true` の plan を実行し、別ターミナルで `.tflock` の存在を監視しました。

```bash
# plan 実行中に別ターミナルで 2 秒おきに確認
watch -n 2 'aws s3 ls s3://example-terraform-state/environments/dev/terraform.tfstate.tflock \
  2>&1 | grep -q tflock && echo present || echo absent'
```

```text
before_lockfile=absent
observed_lockfile=present
after_lockfile=absent
PLAN_EXIT=2
```

`PLAN_EXIT=2`（差分あり成功）。dev が通常 destroy 済みの環境なので全作成差分は正常系です。

### 3. foundation plan を絞ってから apply

:::message alert
IAM や backend まわりの apply では、plan に目的外の差分が混ざっていないかを必ず確認します。変数の渡し方だけで無関係なリソースに差分が出ることがあります。
:::

対象の2リソースだけに絞った状態で apply しました。

```text
Plan: 0 to add, 2 to change, 0 to destroy.
# aws_iam_policy.hannibal_foundation_boundary
# aws_iam_policy.hannibal_foundation_policy
```

### 4. apply後に実Roleで確認

IAM policy simulation で `.tflock` への権限を確認しました。

```bash
aws iam simulate-principal-policy \
  --policy-source-arn arn:aws:iam::xxxxxxxxxxxx:role/HannibalFoundationRole-Dev \
  --action-names s3:GetObject s3:PutObject s3:DeleteObject \
  --resource-arns arn:aws:s3:::example-terraform-state/foundation/terraform.tfstate.tflock
```

```text
s3:GetObject     allowed
s3:PutObject     allowed
s3:DeleteObject  allowed
```

実際に `HannibalFoundationRole-Dev` を assume して foundation plan を実行し、`.tflock` の作成・削除と `refresh=true` での差分なしを確認しました。

```text
before_lockfile=absent
observed_lockfile=present
after_lockfile=absent
PLAN_EXIT=0
```

## 危なかったところ

`terraform/foundation apply` の実行主体を確認しなかったことです。ローカルの AWS provider に `assume_role` 設定がなく、最初は手元の IAM User 認証で apply できる状態でした。

plan を絞ってから apply したため余計な変更は入りませんでしたが、次回からは次のどちらかを徹底します。

- apply 前に `aws sts get-caller-identity` で実行主体を確認する
- provider 側で apply 用 Role を明示する

この種のミスは、権限が強いローカル認証を使っていると見逃しやすいです。IAM policy や permission boundary を触るときは実行主体そのものも検証対象に含めます。

## ロールバック

1. `use_lockfile = true` を backend から外す
2. `.tflock` 用の S3 権限を IAM policy から外す
3. `terraform init -reconfigure` を実行する
4. `terraform plan` で DynamoDB locking に戻っていることを確認する

DynamoDB table と lock 権限はこの段階で保持しているため、戻し先があります。これが DynamoDB locking をすぐ削除しなかった最大の理由です。

## 1週間後にやること

次の条件を満たしたら第2段階（DynamoDB locking 削除）へ進みます。

- 1週間、`.tflock` 残留なし・lock 関連エラーなし
- deploy / destroy が数回通っている
- foundation plan が `refresh=true` で差分なし
- PR plan が想定通り成功している

第2段階でやること: `dynamodb_table` 削除・DynamoDB lock 用 IAM 権限削除・DynamoDB table 削除・S3 lockfile 単独での real plan 確認。

## まとめ

- `use_lockfile = true` は小さい変更だが、`.tflock` 用 IAM 権限が必要
- DynamoDB locking はすぐ消さず、短い移行期間を置くと戻しやすい
- 完了判断は validate ではなく、実Roleでの lockfile 作成・削除と `refresh=true` plan まで見る

次は1週間の安定確認後に、DynamoDB locking を外して S3 lockfile 単独運用へ進めます。
