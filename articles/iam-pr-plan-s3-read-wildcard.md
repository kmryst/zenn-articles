---
title: "terraform plan の S3 AccessDenied を IAM で解消した話"
emoji: "🪣"
type: "tech"
topics: ["aws", "iam", "terraform", "githubactions"]
published: true
---

PR を出すたびに GitHub Actions の「Terraform Plan Artifact」チェックが落ちる状態が続きました。直しては落ちる、また直しては落ちる。この記事は、そのループから抜け出すまでの記録です。

想定読者は、Terraform の PR Check に IAM で保護した `terraform plan` を組み込もうとしていて、S3 の権限不足に次々とぶつかっている方です。

## 先に結論

`HannibalPRPlanRole-Dev`（PR plan 専用の read-only IAM Role）の S3 権限を、**個別 API 列挙から `s3:Get*` / `s3:List*` ワイルドカードにまとめた**ことで安定しました。

変更前後の差分はこうです。

```diff
 {
   "Effect": "Allow",
   "Action": [
-    "s3:GetBucketLocation",
-    "s3:GetBucketPolicy",
-    "s3:GetBucketPublicAccessBlock",
-    "s3:GetBucketVersioning",
-    "s3:GetBucketCORS",
-    "s3:GetBucketWebsite",
-    "s3:GetObjectTagging",
-    "s3:ListBucket"
+    "s3:Get*",
+    "s3:List*"
   ],
   "Resource": "*"
 }
```

read-only 用途に限定された Role なので、`Get*` / `List*` の一括許可は許容できる、という判断です。`Get*` / `List*` は「最も細かい最小権限」ではありません。この記事での主張は、read-only plan Role では **API 個別列挙の厳密さより、provider refresh に追従できる安定性を優先した**というものです。

前提として、この Role は PR plan 専用で、apply / destroy には使いません。OIDC Trust Policy や fork PR の skip 条件など、PR plan 全体の実装前チェックは別記事「[GitHub Actions の PR Check に terraform plan を追加する前に確認すること](/articles/terraform-plan-pr-check-precheck)」で扱っています。

:::message
この記事は個人開発ポートフォリオ [terraform-hannibal](https://github.com/kmryst/terraform-hannibal)（ECS Fargate + Terraform + GitHub Actions）での実装記録です。dev 環境のみ・1人運用・停止運用という前提で設計しています。
:::

## 登場する IAM Role

| Role 名 | 用途 |
|---|---|
| `HannibalPRPlanRole-Dev` | PR の terraform plan 専用。read-only |
| `HannibalDeveloperRole-Dev` | ローカルからの foundation apply |

この記事での主役は `HannibalPRPlanRole-Dev` です。

## 背景

IAM 最小権限化の取り組みで、PR Check に `terraform plan` の実行結果（Plan Artifact）を追加しました。plan を実行するには AWS 認証が必要なので、PR 専用の IAM Role を作り、GitHub OIDC で assume する設計にしました。

この Role に付与する `HannibalPRPlanPolicy-Dev` は、`terraform plan` が必要とする read 権限だけに絞るのが目的です。

## どこで詰まったか

### 問題1: PR Check が落ち続ける（apply 順序依存）

`HannibalPRPlanPolicy-Dev` の内容を変更した PR を出しても、Plan Artifact が赤いまま変わりませんでした。

原因は **apply の順序依存**でした。状況を整理するとこうなります。

| PR | 内容 | 状態 | 詰まっていた理由 |
|---|---|---|---|
| #174 | `HannibalDeveloperPolicy-Dev` 更新（DynamoDB lock + IAM policy 権限追加） | Plan Artifact が赤い | PRPlanRole の S3 権限不足（#172 未反映）|
| #173 | `HannibalPRPlanPolicy-Dev` 更新（S3 権限追加） | Plan Artifact が赤い | #174 と同じ原因 |
| #170 | CICD candidate policy 修正 | Plan Artifact が赤い | 同上 |

全 PR の Plan Artifact が、同じ「PRPlanRole の S3 権限不足」で落ちていました。

解決するには、まず `HannibalPRPlanPolicy-Dev` を AWS に apply する必要があります。しかし apply を実行する Developer ロール自体も、DynamoDB lock 権限が不足していて apply できない状態でした（PR #174 が未反映）。

実行順序はこうなります。

```text
1. HannibalDeveloperPolicy-Dev を apply（#174 のブランチから。Admin権限で実施）
         ↓ Developer ロールが DynamoDB lock + IAM policy 操作権限を得る
2. HannibalPRPlanPolicy-Dev を apply（#173 のブランチから。Developer ロールで実施）
         ↓ PRPlanRole が S3 read 権限を得る
3. 全 PR の Plan Artifact を rerun
         ↓ 今度こそ認証は通る（が、ここで次の問題が出た）
```

Terraform は IAM ポリシーを宣言的に管理しますが、apply の実行はどの PR でも自動ではありません。「PR を出した＝AWS に反映された」ではないため、依存関係のある変更は apply の順序を明示的に制御する必要があります。

### 問題2: 直したらまた別の API で落ちた（whack-a-mole の始まり）

`HannibalPRPlanPolicy-Dev` を apply した直後に rerun した結果、**今度は別の S3 API で AccessDenied** が出ました。

```text
Error: AccessDenied: User: arn:aws:sts::xxxxxxxxxxxx:assumed-role/HannibalPRPlanRole-Dev/...
       is not authorized to perform: s3:GetBucketWebsite
```

その前の run では `GetBucketLocation` や `GetBucketPolicy` を追加して成功したはずなのに、今度は `GetBucketWebsite` が不足しています。

Terraform の AWS provider は `terraform plan` の refresh フェーズで S3 バケットの属性を取得します。このとき呼ばれる API は、バケットに設定されている属性によって変わります。たとえば静的ウェブサイトホスティングを有効にしているバケットがあれば `GetBucketWebsite` が呼ばれ、タグが付いたオブジェクトがあれば `GetObjectTagging` が呼ばれます。

今回は `GetBucketWebsite` と `GetObjectTagging` を追加して apply し直しました。

### 問題3: まだ次の API が出てきた

rerun を走らせると、またエラーです。

```text
Error: AccessDenied: User: arn:aws:sts::xxxxxxxxxxxx:assumed-role/HannibalPRPlanRole-Dev/...
       is not authorized to perform: s3:GetAccelerateConfiguration
```

`GetBucketWebsite` と `GetObjectTagging` を直したのに、今度は `GetAccelerateConfiguration` です。

これで「このまま個別 API を足し続けても終わらない」と判断しました。

Terraform の S3 provider が refresh で呼ぶ API は `GetBucketLocation`、`GetBucketPolicy`、`GetBucketVersioning`、`GetBucketCORS`、`GetBucketWebsite`、`GetBucketLogging`、`GetBucketReplication`、`GetAccelerateConfiguration`、`GetObjectACL`... と多数あります。「どれが呼ばれるか」はリソースの構成次第で変わるため、事前に完全なリストを作ることは難しいです。

## 採用しなかった選択肢

### 個別 API を足し続ける

- **メリット**: 権限が最も細かく絞れる
- **やめた理由**: Terraform provider のアップデートや S3 リソースの設定変更のたびに API が増減するため、保守コストが高すぎる。実際に3回連続でぶつかっており、終わりが見えなかった

### Resource を ARN で絞って個別 API を許可する

- **メリット**: バケットごとに許可する API を変えられる
- **やめた理由**: バケット数が複数あるため管理が複雑になる。また read-only の用途でバケット単位に細かくする実益が薄い

## 採用した構成と判断基準

S3 の権限を `s3:Get*` / `s3:List*` のワイルドカードにまとめました。

```hcl
statement {
  sid    = "S3BucketRead"
  effect = "Allow"
  actions = [
    "s3:Get*",
    "s3:List*",
  ]
  resources = ["*"]
}
```

判断基準は「read-only の用途かどうか」です。

`HannibalPRPlanRole-Dev` は `terraform plan` だけを実行する Role です。`plan` は infrastructure の変更を**実行しない**ので、S3 の write 権限（`Put*`、`Delete*`、`Create*` など）は一切不要です。`Get*` と `List*` を許可しても write はできないため、read-only という前提が崩れません。

トレードオフは「個別列挙より広い Read が付く」点です。たとえば `GetBucketAcl` や `GetObjectAcl` を個別に許可したわけではないが、`Get*` で許可されています。これは、PR plan role がアカウント内の S3 情報を読める範囲が広がることを意味します。

今回は **1人開発・dev 環境のみ・PR plan は apply をしない**という前提で、このトレードオフは許容できると判断しました。本番環境や複数人が使う環境では、別途検討が必要です。

## Terraform コードの最終形

```hcl
resource "aws_iam_policy" "pr_plan_policy" {
  name = "HannibalPRPlanPolicy-Dev"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "S3BucketRead"
        Effect = "Allow"
        Action = [
          "s3:Get*",
          "s3:List*",
        ]
        Resource = "*"
      },
      {
        Sid    = "TerraformStateRead"
        Effect = "Allow"
        Action = ["s3:GetObject"]
        Resource = "arn:aws:s3:::xxxxxxxxxxxx-terraform-state/*"
      },
      # ... その他 EC2/RDS/ECS 等の Describe 権限
    ]
  })
}
```

state バケットへの `GetObject`（state ファイルの読み取り）は ARN を絞ったステートメントで別管理にしています。

## 検証したこと

変更後は次の順序で確認しました。

```bash
# 1. foundation 側で PR plan policy を apply
terraform plan
terraform apply

# 2. 失敗していた PR Check を rerun
gh run rerun <run-id>

# 3. Terraform Plan Artifact が success になることを確認
gh pr checks <pr-number>
```

見たかったのは「S3 の AccessDenied が消えたか」だけではありません。次の2点を合わせて確認しました。

| 観点 | 確認内容 |
|---|---|
| 権限 | S3 refresh で `AccessDenied` が出ない |
| 影響範囲 | plan は成功するが、apply / destroy に必要な write 権限は増えていない |

`terraform plan` は差分を出すだけなので、plan が成功しても「変更してよい」ことの証明にはなりません。ここで確認しているのは、PR review の材料として plan を生成できることです。

## 戻す場合

もし `s3:Get*` / `s3:List*` が広すぎると判断した場合は、次の順序で戻します。

1. 失敗ログから実際に呼ばれている S3 API を集める
2. `Get*` / `List*` を個別 API 列挙に戻した candidate policy を作る
3. foundation の `terraform plan` で差分が S3 read 権限だけであることを確認する
4. apply 後に PR Check を rerun して、必要な API が不足していないか確認する

この rollback は「安全性を上げる代わりに、provider refresh への追従コストを受け入れる」判断です。つまり、戻すこと自体は可能ですが、以前の whack-a-mole に戻る可能性があります。

## 学び

- **Terraform provider の refresh は予測しにくい S3 API を呼ぶ**: バケットの属性構成次第でどの API が呼ばれるかが変わる。read-only Role の S3 権限を個別列挙で管理するのは保守コストが高い
- **whack-a-mole と判断するタイミング**: 同じパターンで2〜3回連続してぶつかったら、個別対処より設計を見直す方が早い
- **read-only Role の `Get*/List*` は許容できる場合が多い**: write 権限が混入しない前提であれば、S3 の read 系をまとめても最小権限の「意図」は維持できる

## 今後の改善

- `HannibalPRPlanRole-Dev` に Permission Boundary を付与することで、将来 policy の変更ミスで write が混入した場合にも防御できるようにする（Issue として積み残し中）
- Terraform provider のバージョンアップ時に呼ばれる API が増えることがあるので、CI の失敗を「設計の見直しサイン」として扱う運用を維持する

## 参考リンク

- [Terraform: S3 backend](https://developer.hashicorp.com/terraform/language/backend/s3)
- [Terraform: plan command](https://developer.hashicorp.com/terraform/cli/commands/plan)
- [AWS IAM: Actions, resources, and condition keys for Amazon S3](https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazons3.html)
