---
title: "AWS IAM を「広すぎる権限」から最小権限に絞った — 個人開発ポートフォリオでの設計と試行錯誤"
emoji: "🔑"
type: "tech"
topics: ["aws", "iam", "terraform", "security", "devops"]
published: true
---

個人開発のポートフォリオプロジェクトで使っている AWS IAM の権限が、いつの間にか必要以上に広くなっていました。`iam:*` を含むワイルドカード、`Resource: "*"` のままの service:* 系ポリシー、Permission Boundary なし。「動いているから問題ない」と後回しにしていたものを、今回本格的に整理しました。

この記事は、現状の調査から提案・実装まで一通りやってみた記録です。

想定読者は、個人開発や小規模チームで AWS を使っていて、「IAM の権限が広すぎるのはわかっているが、どこから手をつければいいかわからない」という方です。

:::message
この記事は個人開発ポートフォリオ [terraform-hannibal](https://github.com/kmryst/terraform-hannibal)（ECS Fargate + Terraform + GitHub Actions）での実装記録です。dev 環境のみ・1人運用・停止運用という前提です。本番環境や複数人が使う環境では、別途検討が必要な点があります。
:::

## 先に結論

今回の作業で整理・変更した内容をまとめます。

| Role | 変更前の問題 | 今回やったこと | 残課題 |
|---|---|---|---|
| `HannibalCICDRole-Dev` | `service:*` 系 wildcard が19種類、Boundary が緩い | candidate policy を適用し、deploy / destroy の不足権限を検証 | 本体 policy への切り替えが残り |
| `HannibalDeveloperRole-Dev` | `iam:*` 等のワイルドカード、Boundary なし | DynamoDB lock + IAM policy 操作権限を追加。state 管理下に | Boundary 付与・policy の細かい絞り込みが残り |
| `HannibalPRPlanRole-Dev` | S3 refresh の API が不足で PR plan が常時落ちていた | S3 権限を `Get*/List*` に統合して安定化 | Permission Boundary の付与が残り |
| `CacooAWSIntegrationRole` | 使わなくなった外部連携 Role が残っていた | Role / Policy / attachment を削除 | なし |
| ECS Task Execution Role | 課題なし | 変更なし | 任意で Terraform 管理化 |

今回 apply まで完了したのは `HannibalDeveloperRole-Dev` の DynamoDB lock 権限追加、`HannibalPRPlanRole-Dev` の S3 権限統合、使わなくなった `CacooAWSIntegrationRole` の削除です。CICD Role の本体切り替えと各 Role の Permission Boundary 付与は残課題として積み残しています。

## 運用コンテキスト

- **チーム規模**: 1人（個人開発）
- **実行者**: 人間は IAM User → AssumeRole で作業、CI/CD は GitHub OIDC → AssumeRole
- **対象環境**: dev のみ（prod 未稼働）
- **停止運用**: 不要なときは `terraform destroy` でリソースを削除し、コストを月 $5 以下に抑えている
- **権限境界**: CICD Role には `HannibalCICDBoundary`、ECS Role には `HannibalECSBoundary` が既存。Developer と PR Plan には Boundary なし（今回の課題の一つ）

## なぜこの状態になっていたか

最初に IAM Role を作ったとき、「とりあえず動かす」を優先しました。Terraform + ECS + CodeDeploy + S3 + CloudFront + RDS をまとめて動かすには、試行錯誤で権限を追加し続ける工程が避けられません。`AccessDenied` が出るたびに `resource:*` や `service:*` を追加する判断は、当時の制約（早く動かしたい・権限設計の詳細が不明）の中では合理的でした。

問題は「動いたら直す」サイクルを後回しにし続けた点です。ポートフォリオとして公開する前に、権限の棚卸しが必要でした。

## 登場するRole

| Role 名 | Trust | 用途 |
|---|---|---|
| `HannibalCICDRole-Dev` | GitHub OIDC `refs/heads/main` | deploy / destroy ワークフロー |
| `HannibalDeveloperRole-Dev` | IAM User（AssumeRole）| ローカルからの foundation apply・開発作業 |
| `HannibalPRPlanRole-Dev` | GitHub OIDC `pull_request` event | PR の terraform plan |
| `CacooAWSIntegrationRole` | 外部 AWS Account | 旧 Cacoo 構成図連携 |
| ECS Task Execution Role | `ecs-tasks.amazonaws.com` | ECS コンテナの起動・Secrets 取得 |

この記事では上3つが主役です。加えて、使われなくなった外部連携 Role を削除する例として `CacooAWSIntegrationRole` も扱います。ECS Task Execution Role は既存設計が問題なかったため変更しませんでした。

## 調査の進め方

### ステップ1: 現状の権限を可視化する

AWS CLI で現在アタッチされているポリシーの内容を取得し、各 Action と Resource を一覧化しました。

```bash
# ポリシーの現在バージョンを取得
aws iam get-policy-version \
  --policy-arn arn:aws:iam::xxxxxxxxxxxx:policy/HannibalCICDPolicy-Dev \
  --version-id v13
```

Access Advisor も併用しました。「過去90日間に実際に使われた Action はどれか」を確認することで、「定義されているが使われていない Action」を特定できます。

```bash
aws iam generate-service-last-accessed-details \
  --arn arn:aws:iam::xxxxxxxxxxxx:role/HannibalCICDRole-Dev
```

### ステップ2: 現状 vs 理想を比較する

取得した現状ポリシーと、deploy.yml / destroy.yml が実際に必要とする Action を並べて比較表（CSV）を作りました。

| Action | 現状 | 理想 | 理由 |
|---|---|---|---|
| `ecs:*` | 許可 | 最小 8 Action のみ | deploy に必要な操作は限定的 |
| `iam:*` | 許可 | 特定操作のみ | ECS Task Role の pass/attach のみ必要 |
| `s3:*` | 許可 | Get*/List* + 特定 Put | state 読み取りと artifacts の Put のみ |

ここで重要だったのは、`deploy.yml` だけでなく `destroy.yml` も同じ Role を使うことです。作成できる権限と削除できる権限は対称ではありません。特に S3 は、通常の object 削除に加えて Versioning 有効バケットの version 削除も考える必要があります。

| workflow | 見落としやすかった権限 | 理由 |
|---|---|---|
| `deploy.yml` | `s3:PutBucketTagging`、`logs:DescribeLogGroups`、`rds:DescribeDBInstances` | Terraform provider が内部で呼ぶ API や、`Resource: "*"` が必要な read API がある |
| `destroy.yml` | `s3:ListBucketVersions`、`s3:DeleteObjectVersion` | Versioning 有効バケットは object 本体だけでなく version も削除対象になる |

### ステップ3: 提案 JSON を作る

現状と理想の差分をもとに「vNext」ポリシーの JSON を事前に用意しました。すぐに apply するのではなく、一度ファイルとして保存してレビューしてから適用する手順にしています。

```text
investigations/
├── proposed/
│   ├── HannibalCICDPolicy-Dev-vNext.json
│   ├── HannibalCICDBoundary-vNext.json
│   ├── HannibalDeveloperPolicy-Dev-vNext.json
│   └── HannibalPRPlanBoundary-Dev.json
└── summary.md
```

## 今回実施した変更

### HannibalDeveloperPolicy-Dev: DynamoDB lock + IAM policy 操作権限の追加

Developer ロールで foundation の `terraform apply` を実行するには、state lock の取得・解放（DynamoDB）と IAM ポリシーのバージョン管理が必要です。これらが不足していたため、Admin 権限を使う場面が生じていました。

追加した権限は次の2グループに絞りました。

| 権限グループ | 目的 | 判断 |
|---|---|---|
| DynamoDB lock 操作 | S3 backend の lock 取得・解放・Digest 復旧 | foundation apply を Developer ロールで完結させるために必要 |
| IAM policy version 管理 | `Hannibal*` policy のバージョン作成・切り替え | IAM policy を Terraform 管理で更新するために必要 |

この変更は `terraform import` で既存ポリシーを state に取り込んでから apply しました。詳細は別記事「[terraform plan が突然止まった — DynamoDB state lock の Digest 不整合と復旧手順](/articles/terraform-state-lock-digest-mismatch)」で扱っています。

### HannibalPRPlanPolicy-Dev: S3 権限を Get*/List* に統合

PR の `terraform plan` を実行する Role の S3 権限が不足しており、PR Check が何度直しても落ち続ける状態でした。個別 API を追加するたびに別の API で落ちる whack-a-mole 状態に陥ったため、read-only を前提に `s3:Get*/List*` にまとめました。

詳細は別記事「[terraform plan が PR のたびに AccessDenied で止まり続けた — IAM の S3 権限を個別列挙からやめた理由](/articles/iam-pr-plan-s3-read-wildcard)」で扱っています。

### CacooAWSIntegrationRole: 使わなくなった外部連携 Role を削除

最小権限化では「権限を細かく絞る」だけでなく、**そもそも不要になった信頼関係を消す**ことも重要です。

このプロジェクトには、過去に Cacoo で AWS 構成図を生成するための `CacooAWSIntegrationRole` が残っていました。Cacoo 側の AWS Account から `sts:AssumeRole` できる read-only Role です。現在は Cacoo 連携を使っておらず、構成図はリポジトリ内のスクリプトと静的ファイルで管理しています。

削除対象は次の3つでした。

| Terraform address | AWS リソース | 役割 |
|---|---|---|
| `aws_iam_role.cacoo_integration_role` | `CacooAWSIntegrationRole` | 外部 AWS Account から assume される Role |
| `aws_iam_policy.cacoo_readonly_policy` | `CacooReadOnlyPolicy` | Cacoo 用 read-only policy |
| `aws_iam_role_policy_attachment.cacoo_policy_attachment` | Role と Policy の attachment | Role に policy を付与 |

最初は「Terraform コードから削除して PR をマージすれば、次の apply で消える」と考えていました。しかし実際には、foundation の Terraform state に Cacoo 系リソースが残っていませんでした。state にないリソースは Terraform が削除対象として認識できないため、そのまま `-target` を指定しても削除できません。

対処の要点は、**一時的に import して Terraform に削除対象として認識させる**ことでした。

| 手順 | 目的 | 重要な点 |
|---|---|---|
| 一時定義を置く | import 先の address を用意する | import は AWS リソースを変更しない |
| `terraform import` | AWS 上の既存 Role / Policy / attachment を state に入れる | state に入って初めて削除対象として扱える |
| 一時定義を削除 | 現在の Terraform コードと同じ状態に戻す | ここで plan すると destroy 差分になる |
| target apply | attachment → Role / Policy の順に削除する | policy attachment を先に外す |

Role に policy が付いたままだと managed policy を削除できないため、先に attachment を外し、その後で Role と Policy 本体を削除しました。ここで `-target` を使ったのは、削除対象を Cacoo の3リソースに限定して確認するためです。

最後に AWS API と Terraform state の両方で確認しました。

```bash
aws iam get-role --role-name CacooAWSIntegrationRole
# NoSuchEntity

aws iam get-policy \
  --policy-arn arn:aws:iam::xxxxxxxxxxxx:policy/CacooReadOnlyPolicy
# NoSuchEntity

terraform state list | grep -i cacoo
# 出力なし
```

この作業で学んだのは、IAM 棚卸しでは policy の Action だけを見ても不十分だということです。外部アカウントから assume できる Role は、read-only であっても信頼関係そのものが attack surface になります。使っていない外部連携は、権限を絞るより削除する方が明確です。

### HannibalCICDPolicy-Dev: candidate policy を適用・検証

CICD Role のポリシーは `service:*` 系のワイルドカードが19種類あり、実質フルアクセスに近い状態でした。`service:*` ではなく具体的な Action と ARN に絞った candidate policy（`HannibalCICDPolicy-Dev-Minimal`）を段階的に検証し、deploy が正常に動くことを確認しました。

candidate の内容のポイントは次の3点です。

1. `ecs:*` → deploy に必要な8 Action（`RegisterTaskDefinition`、`UpdateService`、`DescribeServices` 等）のみ
2. `iam:*` → ECS Task Role の操作に絞った 12 Action + PassRole
3. `codedeploy:*` → 実際の deploy オペレーションに必要な Action のみ

ただし、deploy が通っただけでは完了ではありませんでした。`destroy.yml` で `terraform destroy` を実行すると、Versioning 有効な S3 バケットの削除で `s3:ListBucketVersions` と `s3:DeleteObjectVersion` が不足して 403 AccessDenied になりました。

これは「作成時に必要な権限」と「削除時に必要な権限」は別に検証しないと見落とす、という典型例でした。`s3:DeleteObject` があっても、version 付き object の削除には `s3:DeleteObjectVersion` が必要です。停止運用で destroy を日常的に使うなら、deploy 成功だけを受け入れ条件にしない方が安全です。

本体ポリシーへの切り替えはこの記事執筆時点で残課題です。

## 採用しなかった選択肢

### 一括切り替え（全 Role を同時に更新する）

- **やめた理由**: 複数の Role を同時に変更すると、deploy が止まったときの原因特定が難しくなる。1つずつ変更して検証する段階的アプローチの方が安全

### Permission Boundary を先に付与する

- **メリット**: 万が一 policy に write が混入しても Boundary で防御できる
- **やめた理由**: Boundary は「最大権限の上限」を設定するものであり、現状の policy が広い状態で Boundary だけ付与しても、実際の権限は変わらない。policy の絞り込みと Boundary の付与はセットで進める必要がある。今回は policy の整理を先行させた

### AWS Console で手作業で変更する

- **やめた理由**: Terraform 管理の IAM ポリシーを Console で変更すると、次回 `terraform plan` で差分が出て state が汚染される。ポートフォリオとして「すべてが IaC 管理」であることを示したかったため、Terraform 経由での変更に統一した

### Cacoo Role を手動削除する

- **メリット**: AWS CLI だけで `detach-role-policy` → `delete-role` → `delete-policy` を実行できるため早い
- **やめた理由**: Terraform コードから削除したリソースの実体が state にないことも含めて、IaC 管理の状態を修復したかった。import → target apply にすることで、削除操作の対象と順序を plan で確認できる

## 詰まった場面と参照記事

作業中に4つの独立したトラブルに遭遇しました。

**トラブル1: PR Check が何度直しても落ち続ける**

`HannibalPRPlanPolicy-Dev` の S3 権限不足で、`GetBucketWebsite` → `GetObjectTagging` → `GetAccelerateConfiguration` と次々に AccessDenied が出続けました。

→ 詳細: [terraform plan が PR のたびに AccessDenied で止まり続けた](/articles/iam-pr-plan-s3-read-wildcard)

**トラブル2: terraform plan が突然止まる**

過去の `-lock=false` apply で DynamoDB の Digest が古いままになり、plan が止まる状態になりました。Admin 権限での手動修復と、Developer ポリシーへの DynamoDB lock 権限追加で解消しました。

→ 詳細: [terraform plan が突然止まった — DynamoDB state lock の Digest 不整合と復旧手順](/articles/terraform-state-lock-digest-mismatch)

**トラブル3: 削除したい IAM Role が Terraform state にいない**

使わなくなった `CacooAWSIntegrationRole` を削除しようとしたところ、AWS 上には存在するのに Terraform state にはありませんでした。削除対象として Terraform に認識させるため、一時定義を置いて import し、その後 target apply で削除しました。

**トラブル4: deploy は通ったのに destroy で落ちる**

CICD candidate policy で deploy は成功しましたが、`destroy.yml` の `terraform destroy` では S3 Versioning 関連の権限不足が出ました。`s3:ListBucketVersions` と `s3:DeleteObjectVersion` を追加して、Versioning 有効バケットの破棄に対応しました。

## state 管理で迷った判断基準

`terraform/foundation/iam.tf` には、過去に `terraform state rm` を使った経緯がコメントとして残っていました。これは現在の運用指針ではなく、手動作成済みリソースを Terraform コードに寄せる途中の歴史的なメモです。

今回の作業で使った判断基準はシンプルです。

- **最初から Terraform で作成するリソース** → state に残す（`state rm` しない）
- **手動作成済みのリソースを Terraform に移行** → `import` してから `apply`（`state rm` は不要）

`HannibalPRPlanRole-Dev` は最初から Terraform で作成したため、state に残して継続管理しています。一方、Cacoo Role は AWS 上には存在するが state には無い状態だったため、削除前に import が必要でした。

## 残課題

### Permission Boundary の付与（各 Role）

`HannibalDeveloperRole-Dev` と `HannibalPRPlanRole-Dev` には Boundary が未設定です。policy を絞っても「将来の policy 変更ミス」への防御がありません。Boundary を付与することで、誤って write 権限が混入した場合の防御深度を追加できます。

### HannibalCICDPolicy-Dev 本体の切り替え

Candidate policy の検証は完了しています。本体ポリシーへの切り替えと旧ポリシーの整理が残っています。

### HannibalDeveloperPolicy-Dev の細かい絞り込み

現状は「動かすために必要な最小限」を追加した段階です。長期的には Access Advisor のデータをもとに、実際に使われていない Action を除去する fine-tuning が必要です。

## 学び

- **「動いたら直す」サイクルを後回しにすると負債になる**: 開発序盤に広くした権限は、後で絞るのが大変。最初から理由のある権限だけを追加する習慣が重要
- **調査 → 提案 → 段階的 apply のサイクルが安全**: 「いきなり正解を作る」より、現状を把握して提案を作り、1 Role ずつ検証しながら進む方がリスクが低い
- **個人開発でも Role 設計の考え方は本番と同じ**: CICD / Developer / PR plan / アプリ実行の4種類を適切に分離することで、blast radius（障害や誤操作の影響範囲）を小さくできる
- **Permission Boundary は policy と合わせて設計する**: Boundary だけ付けても意味がなく、policy だけ絞っても将来の変更ミスに弱い。両方を組み合わせることで防御深度が上がる
- **deploy 成功と destroy 成功は別物**: 作成時に使う API と削除時に使う API は完全には一致しない。特に S3 Versioning のように、削除フェーズでだけ必要になる権限は実行して初めて見える
- **使っていない trust relationship は削除する**: read-only Role でも、外部 AWS Account から assume できる入口は残す理由がなければ消す。最小権限化は「許可 Action を減らす」だけでなく「不要な入口を閉じる」作業でもある

## 参考リンク

- [AWS IAM: Roles terms and concepts](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_terms-and-concepts.html)
- [AWS IAM: Policies and permissions](https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies.html)
- [Terraform: import command](https://developer.hashicorp.com/terraform/cli/commands/import)
- [Terraform: Resource targeting](https://developer.hashicorp.com/terraform/cli/commands/plan#resource-targeting)
