---
title: "terraform plan が突然止まった — DynamoDB state lock の Digest 不整合と復旧手順"
emoji: "🔐"
type: "tech"
topics: ["terraform", "aws", "dynamodb", "iam"]
published: true
---

`terraform plan` を実行したら、何もしていないのに突然止まるようになりました。原因は DynamoDB の state lock テーブルにある Digest の不整合でした。この記事は、原因の特定から復旧、恒久対応までの記録です。

想定読者は、Terraform の S3 backend + DynamoDB state lock を使っていて、突然 plan や apply が止まるようになった方です。

:::message
この記事は、既存の S3 backend で `dynamodb_table` を使っている構成向けの復旧記録です。Terraform 公式では DynamoDB-based locking は deprecated とされており、新規構成では S3 lockfile（`use_lockfile = true`）を使う設計が推奨されます。
:::

## 先に結論

DynamoDB の state lock テーブルに保存されている Digest（Terraform が state 整合性確認に使う値）が、S3 の実際の state ファイルと一致していなかったことが原因でした。

対処は2段階です。

1. **応急処置**: DynamoDB の Digest を S3 state の MD5 と一致させる（AWS CLI で PutItem）
2. **恒久対応**: Developer 用 IAM ポリシーに DynamoDB lock 操作権限を追加し、Terraform 管理下に置く

復旧作業で重要なのは、`force-unlock` を反射的に打たないことです。今回壊れていたのは「ロックを持っているプロセス」ではなく、S3 state と DynamoDB Digest の整合性でした。

:::message
この記事は個人開発ポートフォリオ [terraform-hannibal](https://github.com/kmryst/terraform-hannibal)（ECS Fargate + Terraform + GitHub Actions）での実装記録です。dev 環境のみ・1人運用という前提です。Terraform 1.12.1、2026年5月時点の動作確認に基づきます。
:::

## 何が起きたか

IAM 最小権限化の作業中、`terraform plan` を実行したら処理が止まりました。エラーメッセージは次のようなものです。

```text
Error: Error acquiring the state lock

Error message: ConditionalCheckFailedException: The conditional request failed
Lock Info:
  ID:        <空またはゼロ値>
  Path:      YOUR-BUCKET/foundation/terraform.tfstate
  Operation: OperationTypePlan
  ...
```

`ConditionalCheckFailedException` は「DynamoDB の条件付き書き込みに失敗した」ことを意味します。Terraform は lock 取得時に Digest の一致を条件に PutItem を試みるため、Digest が食い違っているとこのエラーになります。

state lock の取得に失敗しています。`terraform force-unlock` で解除しようとしても効かない状況でした。

## Digest 不整合とは何か

Terraform の S3 backend は、state ファイルを S3 に置き、DynamoDB で排他ロックを管理します。

DynamoDB の lock テーブルには次のような項目が格納されます。

| 項目 | 値の例 | 役割 |
|---|---|---|
| `LockID` | `bucket-name/path/terraform.tfstate-md5` | 対象 state を一意に識別 |
| `Digest` | `3f2cf1c1acba2905e58f649ec43e7ffc` | state ファイルの MD5 ハッシュ |

`Digest` は、S3 にある state ファイルの MD5 と一致している必要があります。これが一致しないと、Terraform は「state が壊れているかもしれない」と判断して処理を止めます。

今回は次のような不整合が起きていました。

| 場所 | 値 |
|---|---|
| DynamoDB の Digest（古い） | `3f2cf1c1acba2905e58f649ec43e7ffc` |
| S3 state の実際の MD5（正しい） | `ffbe2bb9864446160499c4c500b8ec9e` |

## なぜ不整合が起きたか

原因は、過去に実行した `terraform apply -lock=false` です。

`-lock=false` を付けると、Terraform は DynamoDB のロックを取得せずに apply を実行します。apply が完了すると S3 の state ファイルは更新されますが、**DynamoDB 側の Digest は更新されません**。結果として、S3 の state と DynamoDB の Digest が乖離します。

`-lock=false` は「ロックが取得できないときの緊急回避策」として使うオプションです。便利ですが、後からこういう副作用が出ることがあります。

チーム運用・CI/CD 環境では、GitHub Actions のログを確認して `-lock=false` が使われたジョブがないかを調べると原因特定が早くなります。個人開発でも手元の shell history に残っていることがあります。

:::message alert
`-lock=false` は緊急時のみ使用し、通常の apply では使わないことを強く推奨します。使った場合は Digest の不整合が起きていないか確認してください。
:::

## 応急処置

DynamoDB の Digest を S3 state の現在の MD5 に合わせます。

### 診断フロー

最初に、何が壊れているかを分けて確認します。

| 確認 | 見るもの | 判断 |
|---|---|---|
| state ファイル | S3 の ETag | 現在の state の MD5 |
| lock テーブル | DynamoDB の Digest | Terraform が期待している MD5 |
| lock の種類 | `LockID` の末尾 | `-md5` なら Digest 管理用の項目 |

S3 と DynamoDB の値が一致していれば Digest 不整合ではありません。その場合は、別プロセスが lock を保持している（`terraform force-unlock` で解除できる可能性がある）、IAM 権限が足りない、backend 設定が違う、などを疑います。

まず S3 の state ファイルの現在の MD5 を取得します。**最も確実な方法は `terraform state pull` を使うことです。**

```bash
terraform state pull | md5sum
```

これは Terraform が backend から直接 state を取得してハッシュを計算するため、ETag の曖昧さがありません。出力された MD5 の値（末尾の ` -` を除く）を次のステップで使います。

:::message
ETag でも代替できますが注意が必要です。multipart upload や SSE-KMS / SSE-C では ETag が MD5 にならない場合があります。確認する場合は次のコマンドを使い、ETag が `"` で囲まれていればクォートを除いた値を使います。
```bash
aws s3api head-object \
  --bucket YOUR-TERRAFORM-STATE-BUCKET \
  --key foundation/terraform.tfstate \
  --query ETag \
  --output text
```
:::

次に DynamoDB 側の現在の Digest を確認します。`LockID` のパスは backend 設定の `key` に対応しているため、自分の設定に合わせて変更してください（例: `key = "foundation/terraform.tfstate"` の場合は `YOUR-BUCKET/foundation/terraform.tfstate-md5`）。

```bash
aws dynamodb get-item \
  --table-name terraform-state-lock \
  --key '{
    "LockID": {"S": "YOUR-BUCKET/foundation/terraform.tfstate-md5"}
  }' \
  --query 'Item.Digest.S' \
  --output text
```

**この値を手元に記録してから**次のステップに進みます。上書き後に問題が起きたとき、元の Digest を参照できるようにしておくためです。

次に DynamoDB の Digest を更新します。

:::message alert
`aws dynamodb put-item` は同じ primary key の item を置き換えます。対象が末尾 `-md5` の Digest 管理用 item であることを確認してから実行してください。`--condition-expression 'attribute_exists(LockID)'` を付けることで、LockID の typo による新規 item の誤作成を防げます。
:::

```bash
aws dynamodb put-item \
  --table-name terraform-state-lock \
  --item '{
    "LockID": {"S": "YOUR-BUCKET/foundation/terraform.tfstate-md5"},
    "Digest": {"S": "ここに terraform state pull | md5sum の出力値"}
  }' \
  --condition-expression 'attribute_exists(LockID)'
```

### 復旧後の確認

Digest を更新したら、すぐに apply へ進まず、まず plan が state を読めることを確認します。

```bash
terraform plan
```

見るポイントは次の3つです。

| 観点 | 確認内容 |
|---|---|
| lock | `Error acquiring the state lock` が消えている |
| state | 予期しない大量差分が出ていない |
| 権限 | Developer ロールで同じ操作を再現できる |

Digest の値を直す操作は、state ファイルの中身を変更する操作ではありません。それでも state 周辺の復旧なので、復旧後に `terraform plan` の差分を読むところまでを一連の作業として扱います。

### 復旧操作として扱った理由

Digest の修復は、新しいインフラ変更ではなく、`-lock=false` の副作用で壊れた状態を戻す復旧操作として扱いました。ただし、なぜ壊れたか、再発防止としてどの権限を足すかは記録に残しました。

本来は `HannibalDeveloperRole-Dev`（Developer ロール）で復旧したいところですが、当時の policy には `dynamodb:PutItem` が含まれていませんでした。この「復旧時だけ Admin 権限が必要になる」状態をなくすことが、恒久対応の出発点になりました。

## 恒久対応

### HannibalDeveloperPolicy-Dev に DynamoDB lock 権限を追加

Developer ロールが state lock 操作を自力でできるように、`HannibalDeveloperPolicy-Dev` に DynamoDB の権限を追加しました。

```hcl
statement {
  sid    = "TerraformStateLock"
  effect = "Allow"
  actions = [
    "dynamodb:DescribeTable",
    "dynamodb:GetItem",
    "dynamodb:PutItem",
    "dynamodb:DeleteItem",
  ]
  resources = [
    "arn:aws:dynamodb:ap-northeast-1:xxxxxxxxxxxx:table/terraform-state-lock"
  ]
}
```

`DescribeTable` と `GetItem` はロック状態の確認、`PutItem` は Digest の更新（および lock 取得）、`DeleteItem` は lock の解放に必要です。

### HannibalDeveloperPolicy-Dev が state 未管理だったことの発見

`HannibalDeveloperPolicy-Dev` を変更して apply しようとしたとき、`terraform plan` の結果が `1 to add` になっていることに気づきました。

AWS 上にはポリシーが存在するのに、Terraform の state には含まれていない状態でした。このまま apply すると、既存ポリシーを新規作成しようとして `EntityAlreadyExists` になります。

対処は `terraform import` で state に取り込んでから、改めて `plan` を確認することでした。

```bash
terraform import \
  aws_iam_policy.developer_policy \
  arn:aws:iam::xxxxxxxxxxxx:policy/HannibalDeveloperPolicy-Dev
```

import 後に `terraform plan` を実行すると `1 to change` に変わり、安全に apply できる状態になりました。

## `terraform force-unlock` との違い

`terraform force-unlock` は「別のプロセスが lock を持ったまま終了してしまった」場合に、lock レコードを強制削除するコマンドです。

今回は lock レコードの削除が目的ではなく、**Digest の値を正しい値に更新する**ことが目的でした。lock レコードを削除すると、次の plan/apply が再び lock を取得できるようになりますが、根本の Digest 不整合は解消されません。

| 操作 | 目的 | 副作用 |
|---|---|---|
| `terraform force-unlock` | lock レコードを強制削除 | Digest 不整合は残る |
| DynamoDB の Digest を手動更新 | Digest を S3 と一致させる | lock レコード自体は残る |

今回は Digest の不整合が原因だったため、`force-unlock` ではなく Digest の手動更新を選びました。

## 採用しなかった選択肢

### `-lock=false` を使い続ける

- **メリット**: その場の plan / apply は通せる可能性がある
- **やめた理由**: DynamoDB の Digest が更新されず、今回と同じ不整合を再発させる可能性がある。緊急回避には使えても、恒久運用には向かない

### state lock テーブルの項目を削除する

- **メリット**: lock が残っているだけなら解除できる
- **やめた理由**: Digest 不整合の場合、項目削除では「S3 state の現在値と Terraform が期待する値を一致させる」ことにならない。原因を取り違えると、次の plan でも別の形で詰まる可能性がある

## 学び

- **`-lock=false` の使用後は Digest を確認する習慣をつける**: 緊急時は仕方ないが、使った後は必ず DynamoDB と S3 の整合性を確認する
- **Developer ロールが「できない」操作は見逃しやすい**: 普段 Admin でやっていると、「Developer で同じことをしたら詰まる」という状況に気づきにくい。最小権限化はこういう見落としを顕在化させる効果もある
- **`terraform import` は state の整合性修復に有効**: AWS 上に存在するのに state にないリソースは、import → plan → apply の流れで安全に取り込める
- **復旧手順も権限設計の一部**: 障害時だけ Admin 権限が必要になる状態は、運用上の隠れた依存です。日常運用 Role で復旧できる範囲を明確にしておくと、次の障害対応が早くなります

## 今後の改善

- `HannibalDeveloperPolicy-Dev` の変更は以後 Terraform 管理下で行う
- `-lock=false` を使った場合の「Digest 確認と修復手順」を運用メモに追記する（再発防止）

## 参考リンク

- [Terraform: S3 backend](https://developer.hashicorp.com/terraform/language/backend/s3)
- [Terraform: force-unlock command](https://developer.hashicorp.com/terraform/cli/commands/force-unlock)
- [AWS CLI: dynamodb put-item](https://docs.aws.amazon.com/cli/latest/reference/dynamodb/put-item.html)
- [Amazon S3: Checking object integrity](https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity-upload.html)
