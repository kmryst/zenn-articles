---
title: "本番IAMロールを壊さずに最小権限化した — candidateロールで検証してから切り替える戦略"
emoji: "🔐"
type: "tech"
topics: ["terraform", "aws", "iam", "devops"]
published: false
---

IAM ロールの最小権限化をいきなり本番ロールで試みると、権限を削りすぎて日常オペレーションが止まるリスクがあります。この記事では、candidate ロールを使って安全に検証してから本体に反映する戦略と、Terraform apply で実際に踏んだ落とし穴を記録します。

想定読者は、Terraform で IAM を管理していて「wildcard 権限を減らしたいが、本番ロールを直接いじるのが怖い」と感じている方です。

:::message
この記事は個人開発ポートフォリオ [terraform-hannibal](https://github.com/kmryst/terraform-hannibal)（ECS Fargate + Terraform + GitHub Actions）での実装記録です。dev 環境のみ・1人運用という前提です。Terraform 1.12.1、2026年5月時点の動作確認に基づきます。
:::

## 先に結論

| 項目 | 変更前 | 変更後 |
|---|---|---|
| 権限スタイル | wildcard（`ecr:*` / `ecs:*` / `s3:*` 等） | action 列挙（必要な操作だけ） |
| Permission Boundary | なし | `HannibalDeveloperBoundary-Dev` を付与 |
| 移行方式 | — | candidate ロールで検証 → 本体に反映 |
| 本番ロールへの影響 | — | 検証完了まで変更なし |

candidate-first 戦略の流れ:

1. candidate Role / Policy / Boundary を別リソースとして作成
2. candidate Role で動作検証（ECS exec、ログ確認、ECR push、Secrets 参照）
3. 検証通過後、本体 Policy と Role Boundary に反映
4. candidate リソースを削除

## 運用コンテキスト

- **チーム規模**: 1人
- **対象環境**: dev のみ
- **実行者**: `hannibal` IAM User → Role assume で操作
- **権限境界**: `HannibalFoundationRole-Dev`（IAM 管理）と `HannibalDeveloperRole-Dev`（日常開発）を分離済み
- **変更失敗時の影響**: 日常開発の操作が止まる。rollback は前バージョンの policy を apply

## なぜ直接縮小しないのか

wildcard の削除は「何を消したか」より「何を消し忘れたか」が問題になります。本番ロールを直接縮小すると、削りすぎた瞬間に ECS exec やログ確認が止まり、その状態での切り戻しを本番ロールを使って行う必要があります。

候補権限を別 Role で試してから、問題がなければ本体に反映する。この順序が IAM 縮小では堅いです。

## candidate の構成

candidate は 3 リソースをセットで用意します。

```hcl
# Boundary（本番 Role に付与する予定の候補）
resource "aws_iam_policy" "hannibal_developer_boundary_candidate" {
  name   = "HannibalDeveloperBoundary-Dev-candidate"
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = local.hannibal_developer_policy_statements
  })
}

# 検証用 Role（本番 Role は触らない）
resource "aws_iam_role" "hannibal_developer_role_candidate" {
  name                 = "HannibalDeveloperRole-Dev-candidate"
  permissions_boundary = aws_iam_policy.hannibal_developer_boundary_candidate.arn
  assume_role_policy   = jsonencode({ /* hannibal user が assume できる trust policy */ })
}

# 最小権限候補の Policy
resource "aws_iam_policy" "hannibal_developer_policy_candidate" {
  name   = "HannibalDeveloperPolicy-Dev-candidate"
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = local.hannibal_developer_policy_statements
  })
}
```

Policy と Boundary が同じ `local.hannibal_developer_policy_statements` を参照しています。Boundary は identity policy の上限なので、identity policy より広い内容にする意味がありません。同一 statements にすることで「Boundary が policy の裏をかく」状態を構造的に防げます。

## 検証プロセス

### deploy なし検証（AWS 変更なし）

まず IAM simulation と既存リソースへのアクセスで確認します。

```bash
# candidate role を assume
CREDS=$(aws sts assume-role \
  --role-arn arn:aws:iam::xxxxxxxxxxxx:role/HannibalDeveloperRole-Dev-candidate \
  --role-session-name candidate-test)
export AWS_ACCESS_KEY_ID=$(echo $CREDS | jq -r .Credentials.AccessKeyId)
# ...

# deny 確認: foundation state は読めてはいけない
aws iam simulate-principal-policy \
  --policy-source-arn arn:aws:iam::xxxxxxxxxxxx:role/HannibalDeveloperRole-Dev-candidate \
  --action-names "s3:GetObject" \
  --resource-arns "arn:aws:s3:::your-state-bucket/foundation/terraform.tfstate"
# → explicitDeny が返ることを確認

# 特権昇格テスト: Foundation Role を assume できてはいけない
aws sts assume-role \
  --role-arn arn:aws:iam::xxxxxxxxxxxx:role/HannibalFoundationRole-Dev \
  --role-session-name escalation-test
# → AccessDenied が返ることを確認
```

確認した項目:

| テスト | 確認方法 | 期待値 |
|---|---|---|
| ECR push / pull 系 | IAM simulation | allowed |
| S3 frontend put / delete | 実操作 | OK |
| foundation state 読み取り | IAM simulation | explicitDeny |
| IAM 危険操作（CreateRole 等） | IAM simulation | implicitDeny |
| Foundation Role assume | 実操作 | AccessDenied |

### dev deploy 後の検証

ECS exec と Secrets 参照は実際のリソースがないと確認できないため、dev 環境を一時 deploy して検証します。

```bash
# CloudWatch Logs の実読み取り
aws logs get-log-events \
  --log-group-name /ecs/your-app \
  --log-stream-name ecs/your-container/TASK_ID \
  --limit 5

# Secrets Manager: RDS managed secret（rds!* prefix）の参照
aws secretsmanager get-secret-value \
  --secret-id arn:aws:secretsmanager:ap-northeast-1:xxxxxxxxxxxx:secret:rds!db-xxxx

# terraform/environments/dev の state 読み取り
terraform -chdir=terraform/environments/dev plan -lock=false -input=false
```

ECS exec はローカルに Session Manager Plugin が必要です。Plugin がない環境では IAM simulation で代替できますが、実際にコンテナに入る検証は Plugin をインストールして確認することを推奨します。

deploy 後の検証が終わったらすぐ destroy することでコストを最小化します。

## 本体に反映する

candidate での検証が通ったら、本体に反映します。

```hcl
# 本体 Role に Boundary を付与
resource "aws_iam_role" "hannibal_developer_role" {
  name                 = "HannibalDeveloperRole-Dev"
  permissions_boundary = aws_iam_policy.hannibal_developer_boundary.arn
  # ...
}

# Boundary policy を新設（candidateと同じ statements）
resource "aws_iam_policy" "hannibal_developer_boundary" {
  name   = "HannibalDeveloperBoundary-Dev"
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = local.hannibal_developer_policy_statements
  })
}

# 本体 Policy を wildcard から action 列挙に更新
resource "aws_iam_policy" "hannibal_developer_policy" {
  name   = "HannibalDeveloperPolicy-Dev"
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = local.hannibal_developer_policy_statements
  })
}
```

candidate の 3 リソースは同時に削除します。

## 危なかったところ（near-miss）

### `aws_iam_policy` の `description` は ForceNew

本体反映 PR で `description` を「最小権限化済み」の内容に更新しました。これが罠でした。

Terraform の `aws_iam_policy` では `description` が ForceNew 属性です。変更すると、リソースが destroy → create（置き換え）になります。置き換えの際、Terraform は既存ポリシーをロールから detach しようとします。

このプロジェクトでは Foundation Policy に次の条件があります。

```json
{
  "Sid": "ManageApprovedHannibalPolicyAttachments",
  "Effect": "Allow",
  "Action": ["iam:AttachRolePolicy", "iam:DetachRolePolicy"],
  "Resource": "arn:aws:iam::xxxxxxxxxxxx:role/Hannibal*",
  "Condition": {
    "ArnLike": {
      "iam:PermissionsBoundary": "arn:aws:iam::xxxxxxxxxxxx:policy/Hannibal*Boundary*"
    }
  }
}
```

この条件は「detach 対象のロールがすでに `Hannibal*Boundary*` の Boundary を持っているときだけ許可」という意味です。`HannibalDeveloperRole-Dev` はまだ Boundary を持っていなかったため、detach が AccessDenied で止まりました。

**エラーメッセージ**:

```text
Error: detaching IAM Policy from IAM Role HannibalDeveloperRole-Dev:
AccessDenied: User: .../HannibalFoundationRole-Dev/... is not authorized to
perform: iam:DetachRolePolicy on resource: role HannibalDeveloperRole-Dev
because no identity-based policy allows the iam:DetachRolePolicy action
```

`iam:DetachRolePolicy` の権限はあるはずなのに AccessDenied になるので、最初は permission 不足を疑いました。実際は Condition の `iam:PermissionsBoundary` チェックで弾かれていました。

**解決**: `description` を変えなければ policy は in-place update（新バージョン作成）になり、detach が不要になります。

```hcl
resource "aws_iam_policy" "hannibal_developer_policy" {
  name        = "HannibalDeveloperPolicy-Dev"
  description = "変更しない"  # ← ForceNew なので触らない
  policy      = jsonencode({ ... })
}
```

この制約を `docs/operations/iam-management.md` に記録しておきました。同様のケースで同じ罠を踏まないようにするためです。

### Boundary を持たないロールへの最初の apply

「Boundary を付与する apply」と「ポリシーを置き換える apply」を同一 apply で実行しようとすると上記と同じ問題が起きます。

安全な順序は 2 通りあります。

- **案1**: Boundary 付与を先に apply → 次の apply でポリシーを操作
- **案2**: `description` を変えずに in-place update にとどめ、1 回の apply で通す

今回は案2 を採用しました。

## 選ばなかった選択肢

### 本体 Policy を直接縮小する

- **やめた理由**: 削りすぎた瞬間に日常オペレーションが止まる。回復作業を「壊れた権限のロール」で行う状況になりうる

### candidate Policy だけ作り、Role は作らない

- **やめた理由**: policy が存在しても実際に assume して動作確認できなければ検証の意味が薄い。Boundary の条件漏れなど、policy 単体ではわからない問題が残る

### `-target` で一部リソースだけ apply

- **採用場面**: Athena の既存エラーが apply 全体を止めていたため、IAM リソースだけ `-target` で適用した。本来は `-target` は応急措置であり、全体 apply が通る状態を別途修正する必要がある

## まとめ

candidate-first 戦略の核心は「本番ロールを壊さずに仮説を検証する」ことです。

3 リソースのセット（Role / Policy / Boundary）を別名で作り、実際に assume してテストを通してから本体に反映する。この手順を踏めば、最小権限化は「権限削除の作業」ではなく「動作を維持したまま不要権限を取り除くプロセス」になります。

今回の apply で踏んだ `description` の ForceNew と Boundary 条件の組み合わせは、エラーメッセージから原因にたどり着きにくい問題でした。`iam:DetachRolePolicy` の権限を持っているのに AccessDenied になる場合、Condition キー（特に `iam:PermissionsBoundary`）を確認するのが早道です。

## 参考リンク

- [AWS IAM: Condition keys for IAM](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_actions-resources-contextkeys.html)
- [AWS IAM: iam:PermissionsBoundary condition key](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_iam-condition-keys.html#ck_PermissionsBoundary)
- [Terraform: aws_iam_policy resource](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_policy)
