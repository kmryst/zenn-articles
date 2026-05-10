---
title: "IAM managed policy が 6144 文字に近づいたので Terraform で3分割した"
emoji: "🧩"
type: "tech"
topics: ["aws", "iam", "terraform", "devops"]
published: true
---

Terraform で IAM policy を管理していると、最小権限化のために action を列挙するほど、1つの managed policy が大きくなります。

この記事では、`terraform/foundation` を apply するための IAM Role に付けていた managed policy が AWS IAM の 6144 文字上限に近づいたため、責務別に3分割した話を書きます。

想定読者は、次のような人です。

- IAM policy の文字数上限に近づいている
- policy をどういう粒度で分けるか迷っている
- Terraform apply 後にどこまで動的検証すべきか知りたい

:::message
個人開発ポートフォリオの dev 環境での実装記録です。運用者は1人で、対象は IAM / OIDC / Permission Boundary を扱う `terraform/foundation` の apply 用 Role です。

Terraform v1.14.8、AWS provider v6.7.0、AWS CLI v2.34.22、2026年5月時点の確認に基づきます。
:::

## 先に結論

`HannibalFoundationPolicy-Dev` という単一の managed policy を、次の3つに分けました。

| Policy | 責務 | policy JSON size |
|---|---|---:|
| `HannibalFoundationPolicy-Dev` | IAM / OIDC / Permission Boundary | 2823 |
| `HannibalFoundationStatePolicy-Dev` | backend state / lock | 999 |
| `HannibalFoundationServicesPolicy-Dev` | Athena / CloudTrail / GuardDuty / Budgets | 1839 |

分割前は `5564 / 6144` 文字でした。分割後は、それぞれ 6144 文字から十分に離れました。

```text
before: 5564 / 6144

after:
  core:     2823 / 6144
  state:     999 / 6144
  services: 1839 / 6144
```

ただし、静的な `terraform plan` だけでは不十分でした。apply 後に実際の `HannibalFoundationRole-Dev` を assume して `terraform plan` したところ、`athena:GetDatabase` 不足が見つかりました。

最終的には `athena:GetDatabase` を追加し、Foundation Role 自身で `terraform/foundation plan` が `No changes` になることまで確認しました。

## 前提と運用コンテキスト

AWS IAM の customer managed policy は、1つの managed policy あたり 6144 文字までです。AWS 公式ドキュメントでは、policy size の計算で空白はカウントされないと説明されています。

https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_iam-quotas.html

今回扱う `HannibalFoundationRole-Dev` は、`terraform/foundation` を手動 apply するためのプロジェクト内 Role です。IAM Role / managed policy / OIDC provider / Permission Boundary / CloudTrail / Athena / GuardDuty / Budgets など、「インフラを管理するためのインフラ」を扱います。

| 項目 | 内容 |
|---|---|
| チーム規模 | 1人 |
| 対象環境 | dev |
| 通常の実行者 | IAM User から `HannibalFoundationRole-Dev` を assume |
| 今回の apply 実行者 | `HannibalFoundationRole-Dev` より広い権限を持つ実行者（policy 分割という一回限りの操作のため） |
| 権限境界 | `HannibalFoundationBoundary-Dev` |
| 失敗時の影響 | foundation apply / plan が止まる。アプリ本体のランタイム停止ではない |

この Role には Permission Boundary を付けています。Boundary は権限を付与するものではなく、identity-based policy が付与した権限の上限を定義するものです。

https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies.html#access_policies_boundaries

## なぜ三分割にしたか

既存 policy が大きくなった理由は、`terraform/foundation` の責務が増えたためです。最初は IAM と OIDC まわりだけで足りていましたが、そこへ S3 backend state / lock、DynamoDB lock 移行、Athena / Glue、CloudTrail / GuardDuty / Budgets の管理権限が追加されました。

この時点で `HannibalFoundationPolicy-Dev` は `5564` 文字になり、残りは約580文字でした。

最初に考えたのは、既存 policy から managed service 権限だけを切り出す二分割です。しかし state 権限と service 権限が同じ policy に残るため、レビュー時に「次回 apply の生存に必要な権限」と「管理対象サービスの権限」が混ざります。

最終的には、次の比較で三分割にしました。

| 案 | 内容 | 判断 |
|---|---|---|
| 二分割 | core + state/services | 上限回避はできるが、state と service が混ざる |
| 三分割 | core / state / services | 責務が分かれ、レビューしやすい |
| inline policy 化 | Role に inline policy として移す | managed policy より再利用性・差分レビューの見通しが落ちる |
| wildcard 化 | `athena:*` などで短くする | 文字数は減るが、action 列挙の最小権限方針から外れる |
| 何もしない | 上限に当たるまで待つ | 後続の IAM 変更が詰まるリスクを残す |

分割後の構成はこうです。

```text
HannibalFoundationRole-Dev
├── HannibalFoundationPolicy-Dev
│   └── IAM / OIDC / Permission Boundary
├── HannibalFoundationStatePolicy-Dev
│   └── S3 state / S3 lockfile / DynamoDB lock
└── HannibalFoundationServicesPolicy-Dev
    └── Athena / Glue / CloudTrail / GuardDuty / Budgets
```

identity policy は3分割しましたが、Permission Boundary は分割していません。IAM Role に設定できる permissions boundary は1つだけであり、Boundary の責務は「詳細な許可」ではなく「この Role が超えてはいけない最大権限の外枠」だからです。

`athena:GetDatabase` が identity policy にない状態で Boundary だけを広げても、Role はその action を実行できません。Boundary は identity policy と AND 条件で評価されるためです。

## 実装で気をつけたこと

実装では、全 statement を1つの local に集め、Sid のリストで core / state / services に振り分けました。

重要だったのは、既存 policy を縮小する順序です。

既存の `HannibalFoundationPolicy-Dev` から state 権限を外す前に、新しい `HannibalFoundationStatePolicy-Dev` を Role に attach しておかないと、apply 中に Role が一時的に state 権限を失います。

Terraform の依存グラフはリソース間の参照から構築されます。新しい policy attachment と既存 policy の更新の間には、コード上の参照関係がありません。そのため、既存 policy の更新側に `depends_on` を置きました。

```hcl
resource "aws_iam_policy" "hannibal_foundation_policy" {
  name        = "HannibalFoundationPolicy-Dev"
  description = "Permissions for terraform/foundation apply only"

  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = local.hannibal_foundation_policy_statements
  })

  depends_on = [
    aws_iam_role_policy_attachment.hannibal_foundation_state_policy_attachment,
    aws_iam_role_policy_attachment.hannibal_foundation_services_policy_attachment
  ]
}
```

これで、Terraform apply の順序は次のようになります。

```text
1. state/services policy を作る
2. Foundation Role に attach する
3. 既存 HannibalFoundationPolicy-Dev を core 権限へ縮小する
```

既存 policy の `description` は変えませんでした。Terraform AWS provider では `aws_iam_policy.description` が `Forces new resource` なので、変更すると managed policy の置き換えになります。

https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_policy

今回の目的は policy document の責務分割であり、既存 policy の置き換えではありません。`name` と `description` は維持し、policy document だけを in-place update しました。

## 検証で見つかった不足

まず、ローカルで静的検証を行いました。

```bash
terraform -chdir=terraform/foundation fmt -check
terraform -chdir=terraform/foundation validate -no-color
terraform -chdir=terraform/foundation plan -no-color -input=false
```

plan は想定通りでした。

```text
Plan: 4 to add, 1 to change, 0 to destroy.
```

内訳は、state/services policy の作成、2つの Role attachment 作成、既存 `HannibalFoundationPolicy-Dev` の in-place update です。destroy がないことを確認してから apply しました。

```text
Apply complete! Resources: 4 added, 1 changed, 0 destroyed.
```

ただし、ここで終わらせると危ないです。

apply は Foundation Role より広い権限を持つ実行者で行いました。これは「AWS に反映できた」確認にはなりますが、分割後の Foundation Role 自身が次回以降の plan を実行できることまでは証明しません。

そこで、Foundation Role を assume した一時認証情報で plan を実行しました。

```bash
read AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN < <(
  aws sts assume-role \
    --role-arn arn:aws:iam::xxxxxxxxxxxx:role/HannibalFoundationRole-Dev \
    --role-session-name foundation-post-apply-check \
    --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' \
    --output text
)

AWS_ACCESS_KEY_ID="$AWS_ACCESS_KEY_ID" \
AWS_SECRET_ACCESS_KEY="$AWS_SECRET_ACCESS_KEY" \
AWS_SESSION_TOKEN="$AWS_SESSION_TOKEN" \
terraform -chdir=terraform/foundation plan -no-color -input=false
```

結果は `athena:GetDatabase` 不足でした。

```text
Error: reading Athena Database (hannibal_cloudtrail_db):
AccessDeniedException: You are not authorized to perform: athena:GetDatabase
```

今回の apply は IAM policy の作成・attachment が中心で、Athena database の refresh は発生していませんでした。しかし次回以降の plan では `aws_athena_database` の refresh が走り、`athena:GetDatabase` が必要になります。

修正は `HannibalFoundationServicesPolicy-Dev` に `athena:GetDatabase` を追加するだけでした。

```diff
 Action = [
   "athena:CreateNamedQuery",
   "athena:DeleteNamedQuery",
+  "athena:GetDatabase",
   "athena:GetNamedQuery",
   "athena:BatchGetNamedQuery",
 ]
```

この修正後の services policy size は `1839 / 6144` です。plan は `0 to add, 1 to change, 0 to destroy` で、services policy の in-place update だけでした。

apply 後、もう一度 Foundation Role を assume して plan しました。

```text
No changes. Your infrastructure matches the configuration.
```

ここまで確認して、分割後の Role 自身が次回以降の `terraform/foundation plan` を実行できる状態になりました。

## 検証は3段階に分ける

IAM policy の変更では、検証を3段階に分けるのがよさそうです。

| 段階 | 目的 | 今回の確認 |
|---|---|---|
| 静的検証 | Terraform 構文・差分の確認 | `fmt` / `validate` / `plan` |
| apply 検証 | AWS に意図通り反映できるか | `4 add, 1 change, 0 destroy` |
| 実 Role 検証 | 変更後の Role が次回も運用できるか | assume role 後の `plan` |

特に最後の「実 Role 検証」が重要でした。apply した実行者の権限と、次回以降に運用する Role の権限は別物です。

## 戻す場合

変更 PR を revert して `terraform/foundation` で plan / apply します。

三分割全体を戻す場合は、state/services policy の削除・attachment 削除・core policy への権限戻しが一連の操作になります。分割時と同じく、Role が一時的に state 権限を失わない順序で戻す必要があります。

`athena:GetDatabase` だけを戻すことはできますが、動的検証で必要と確認済みのため、外すと Foundation Role の次回 plan が再び失敗します。

## まとめ

IAM managed policy の文字数上限に近づいたとき、wildcard 化すれば短くできます。しかし、それは最小権限の方針やレビューの見通しと引き換えになります。

今回のポイントは次の3つです。

- managed policy は責務で分割する。state 権限は Terraform apply の生存に関わるため、他の管理サービス権限とは独立させる
- 既存 policy を縮小する場合は `depends_on` で順序を明示する。参照関係がない依存は Terraform に自動では伝わらない
- apply 後は運用 Role を assume して plan する。「apply が通った」と「その Role が次回も運用できる」は別の問題

静的な `terraform plan` が通り、apply が成功しても、その Role 自身が必要な権限を持っているとは限りません。IAM policy の変更後は、実際の運用 Role で次回の plan が通るかを確認するのが確実です。
