---
title: "CI/CDパイプライン進化録①: デプロイ失敗率76%→0%に至るまでの設計判断"
emoji: "🔥"
type: "tech"
topics: ["githubactions", "terraform", "aws", "ecs", "codedeploy"]
published: true
---

個人開発のポートフォリオプロジェクト [terraform-hannibal](https://github.com/kmryst/terraform-hannibal)（ECS Fargate + Terraform + GitHub Actions）の CI/CD パイプラインを、約5ヶ月かけて構築しました。GitHub Actions の実行ログが、気づけば 691 回を超えていました。そのうち 268 回が失敗です。

この記事では、約5ヶ月間のワークフロー変遷と設計判断を全体像として振り返ります。個別の技術的な深掘りは今後の連載で扱うため、ここでは「何がどう変わり、なぜ変えたか」を中心にまとめます。

想定読者は、GitHub Actions と Terraform で AWS 上の CI/CD を組んでいて、「ワークフローが安定しない」「何度も書き直している」という状況にある方です。

この記事で振り返りたいのは、単なる「修正の履歴」ではありません。設計上どの制約を優先し、どの選択肢を捨て、最終的にどんな運用原則に落ち着いたかという、**CI/CD の設計判断そのもの**です。

今回の設計で一貫して優先したのは、次の3点です。

- **再実行で壊れないこと**: 1回の成功率より、失敗後に同じ手順で立て直せることを重視する
- **デプロイ責務を分離すること**: Terraform は基盤構築、トラフィック切替は CodeDeploy に寄せる
- **コストと運用負荷を制御できること**: 個人開発でも維持できる構成を優先する

:::message
この記事は、CI/CD パイプラインの進化を振り返る連載の第1回です。全体像を俯瞰し、今後の記事で個別テーマを深掘りします。個別のエラー原因や Terraform コードの詳細はこの記事のスコープ外です。
:::

:::message alert
この記事で扱うワークフロー実行データは GitHub Actions のログ保持期間（90日）を超えているものが多く、ログ本文は一部取得できませんでした。転換点の分析はコミットログ、ワークフローメタデータ（成否・実行時間）、最終形のコードをもとに再構成しています。
:::

## 先に結論

最終的に残ったのは、`deploy.yml` と `destroy.yml` の2本です。

- Deploy は **Canary / Blue-Green / 初期構築** の3モードを `workflow_dispatch`（手動トリガー）で選択する構成
- Destroy は **CodeDeploy 停止 → ECS スケールダウン → Terraform destroy → ベストエフォート掃除** の順序で安全に解体する構成

ここでいう **Canary** は「新バージョンにまず10%のトラフィックを流し、問題がなければ100%に切り替える」デプロイ戦略、**Blue-Green** は「旧環境（Blue）と新環境（Green）を並行させ、一括で切り替える」デプロイ戦略です。どちらも **CodeDeploy**（AWS のデプロイ自動化サービス）で制御しています。
- デプロイの失敗率は **76%（6月）→ 0%（10月）** に改善
- 成功時の平均実行時間は Deploy が **約10分**、Destroy が **約14分**
- 月額コストは運用時 $30-50、Destroy で停止すると **約 $5** に削減
- その過程で Deploy ワークフローは **10世代**、Destroy ワークフローは **4世代** を経た

ここに至るまでの5ヶ月間で、ワークフロー名を10回変え、コミットメッセージは `deploy.yml修正1` から Conventional Commits（`feat:` / `fix:` / `ci:` 等のプレフィックスで変更種別を明示する規約）まで変化しました。最終形だけを見ると「普通の CI/CD」ですが、そこに至る判断の積み重ねが、この記事の本題です。

最終形の Deploy ワークフローは、`workflow_dispatch` で3つのモードを選択する構成です。

```yaml
on:
  workflow_dispatch:
    inputs:
      deployment_mode:
        description: "デプロイモードを選択"
        required: true
        default: "canary"
        type: choice
        options:
          - canary         # 1回目以降（Canary段階的切替）
          - bluegreen      # 1回目以降（Blue/Green切替）
          - provisioning   # 0回目（初期構築・Blueのみ）
```

この3モードに到達するまでの過程を、以下で振り返ります。

## プロジェクトの前提

対象は [terraform-hannibal](https://github.com/kmryst/terraform-hannibal) という個人開発のポートフォリオプロジェクトです。

- **インフラ**: ECS Fargate / RDS PostgreSQL / CloudFront / Route53 / ALB — コンテナ運用の実践とクラスタ管理不要の両立
- **IaC**: Terraform（モジュール化、S3 + DynamoDB で State 管理）— 環境の再現性確保と、destroy / re-apply を前提にした設計
- **デプロイ**: GitHub Actions → CodeDeploy（Blue/Green + Canary）— Canary の段階的トラフィック切替を AWS 側で制御するため
- **コスト設計**: 月額 $30-50 で運用し、Destroy で約 $5 に削減 — 手動トリガー（`workflow_dispatch`）で意図しないデプロイを防止

個人開発のため、設計・実装・インフラ・CI/CD をすべて一人で回しています。失敗のフィードバックが早い反面、レビューがない分だけ設計のブレも大きくなります。

この前提のもとで、今回の CI/CD 設計には次の非機能要件を置きました。

- **信頼性**: deploy / destroy を手順化し、再実行時の振る舞いを予測可能にする
- **変更容易性**: 初期構築、通常デプロイ、切替戦略をワークフロー入力で切り替えられるようにする
- **運用可能性**: 個人開発でも監視、停止、再構築を一人で回せる粒度に分ける
- **コスト制約**: 常時フル稼働を前提にせず、destroy を含めて月額コストを制御する

## 数字で見る5ヶ月の推移

GitHub Actions の月次データをまとめると、失敗率の変化がはっきり見えます。

| 月 | 総実行数 | 成功 | 失敗 | 失敗率 |
|:--|--:|--:|--:|--:|
| 2025-05 | 15 | 3 | 10 | 67% |
| 2025-06 | 46 | 8 | 35 | **76%** |
| 2025-07 | 165 | 46 | 114 | 69% |
| 2025-08 | 258 | 162 | 92 | 36% |
| 2025-09 | 27 | 26 | 1 | **4%** |
| 2025-10 | 140 | 133 | 5 | **4%** |

Deploy ワークフローだけに絞ると、推移はもっと顕著です。

| 月 | Deploy 失敗率 |
|:--|:--|
| 2025-05 | ██████████████░░░░░░ 67% |
| 2025-06 | ████████████████░░░░ **76%** |
| 2025-07 | ███████████████░░░░░ 74% |
| 2025-08 | ████████░░░░░░░░░░░░ 39% |
| 2025-09 | █░░░░░░░░░░░░░░░░░░░ 4% |
| 2025-10 | ░░░░░░░░░░░░░░░░░░░░ **0%** |

5月から7月までは **4回に3回は失敗** していた計算です。8月に一気に下がり、9月以降はほぼ安定しました。

:::details 自分のリポジトリで同じ集計をする方法
`gh` CLI を使えば、同様の集計ができます。

```bash
gh run list -R owner/repo --limit 1000 \
  --json conclusion,createdAt \
  | jq 'group_by(.createdAt[:7])
        | map({
            month: .[0].createdAt[:7],
            total: length,
            fail: [.[] | select(.conclusion=="failure")] | length
          })'
```

失敗率が高い月があれば、そこを起点にコミットログと突き合わせると、何が壊れていたかが見えてきます。
:::

## ワークフローの系譜

### Deploy: 10世代

「名前が変わった」ということは、設計方針が変わったということです。

| 初出 | 最終実行 | ワークフロー名 | 実行数 | 失敗率 |
|:--|:--|:--|--:|--:|
| 5/31 | 7/21 | Deploy NestJS Hannibal App | 110 | 🔥 73% |
| 7/24 | 8/1 | Deploy NestJS Hannibal App (Dev) | 50 | 🔥 76% |
| 8/1 | 8/1 | 🚀 Professional Blue/Green Deploy (Dev) | 1 | 0% |
| 8/1 | 8/1 | 🚀 Deploy (Dev) | 49 | 🔥 45% |
| 8/1 | 8/1 | 🚀 Deploy (Simple & Fast) | 3 | 🔥 100% |
| 8/1 | 8/11 | .github/workflows/deploy.yml | 11 | 🔥 100% |
| 8/2 | 8/11 | Deploy NestJS Hannibal (Fast) | 67 | 🔥 60% |
| 8/11 | 9/23 | Deploy NestJS Hannibal (Enterprise) | 34 | ⚠️ 24% |
| 10/7 | 現在 | Deploy NestJS Hannibal | 29 | ⚠️ 34%（※） |

`pages build and deployment`（100回・全成功）は GitHub Pages の自動生成ワークフローのため、この表には含めていません。

※ `Deploy NestJS Hannibal` の累計失敗率 34% には、Terraform モジュール構成の変更直後やインフラ再構築時の失敗を含んでいます。10月以降に限れば、月次の失敗率は 0% です。

8月1日だけで4つのワークフローが生まれています。この日に何が起きたかは、あとで触れます。

:::message
`.github/workflows/deploy.yml`（11回・全失敗）は、`name:` フィールドが未設定のままプッシュされた時期のものです。ファイル名がそのままワークフロー名として GitHub に表示されます。
:::

### Destroy: 4世代

| 初出 | 最終実行 | ワークフロー名 | 実行数 | 失敗率 |
|:--|:--|:--|--:|--:|
| 7/1 | 7/22 | 🗑️ Destroy AWS Infrastructure (Safe) | 20 | 🔥 60% |
| 7/22 | 8/2 | 🗑️ Destroy AWS Infrastructure (Dev) | 24 | 🔥 54% |
| 8/2 | 8/13 | Destroy AWS Infrastructure (Fast) | 30 | ⚠️ 20% |
| 8/13 | 現在 | Destroy AWS Infrastructure (Reliable) | 29 | ✅ **0%** |

名前の変遷に設計思想が表れています。「Safe（安全）」を目指したものが 60% 失敗し、「Fast（高速）」に振って 20% まで下がり、最終的に「Reliable（信頼性）」で 0% に到達しました。

最初から「Reliable」を目指せばよかったように見えますが、Safe の時期に何が壊れるかを知り、Fast の時期に何を削れるかを知ったからこそ、Reliable の設計が成立しています。

Reliable が 0% を維持できている理由は、**destroy 前に依存リソースを順番に片付ける設計** にあります。

```yaml
# Destroy AWS Infrastructure (Reliable) の実行順序
steps:
  # 1. CodeDeploy の進行中デプロイを停止（destroy 中に切り戻されるのを防ぐ）
  - name: Stop active CodeDeploy deployments
  # 2. ECS を desired 0 にしてタスク停止を待つ（Fargate タスクが残ると TG 削除が詰まる）
  - name: Scale down ECS service and wait stable
  # 3. ここで初めて terraform destroy（依存が片付いた状態）
  - name: Destroy Infrastructure (Modularized)
  # 4. 残骸のベストエフォート掃除（S3 オブジェクト、ECR イメージ、ELB/TG）
  - name: Cleanup S3 buckets (best-effort)
  - name: Cleanup ECR images (best-effort)
  - name: Final ELB/TG cleanup (best-effort)
```

Safe や Fast では、いきなり `terraform destroy` を実行して、CodeDeploy が裏で動いていたり ECS タスクが残っていたりして失敗するケースが多発していました。「先に依存を止めてから壊す」という順序を明確にしたことで、0% が実現しています。

## 転換点

### 5月: 最初の1回が通るまで

この段階で捨てたのは、「ローカルで動いているから CI でもそのまま動くはず」という前提です。採用した基準は、ローカル再現性ではなく、**GitHub Actions ランナー上で最初の1回を確実に通せるか** でした。

コミットログはこうなっています。

```text
deploy.yml修正1
deploy.yml修正2
deploy.yml修正3
...
deploy.yml修正16
```

5月31日の1日だけで15回の修正を重ね、「修正11」で初めてデプロイが成功しました。

Terraform init / plan / apply のパス、AWS 認証の設定、ECS タスク定義の構成、IAM ロールの権限。これらを GitHub Actions のランナー上で動く形にするまで、ローカルで動いていた構成の前提がいくつも崩れました。CI/CD パイプラインの最初の1回を通すまでが、体感では最も重い作業です。

### 6-7月: 機能追加のたびに壊れる

この時期に捨てたのは、「機能追加と CI/CD 修正を同時に進めても何とかなる」という進め方でした。採用したのは、**インフラ変更で壊れた箇所をワークフロー側の責務として切り分け、失敗点を特定しやすくする** という見方です。

6月後半から7月にかけて、インフラに Route53、RDS PostgreSQL、CloudWatch 監視を順番に追加しました。そのたびにデプロイが壊れています。

```text
Terraformなど更新10
Terraformなど更新11
...
Terraformなど更新53
```

6月27日から6月30日の4日間だけで **43回のコミット** を積んでいます。この時期に、Deploy ワークフローの **16連続失敗** も記録しました。

7月4日に「deploy.yml, destroy.yml完成」というコミットが入りますが、その翌日から Route53 の追加作業が始まり、ワークフローはまた壊れています。「完成」と書いたものが完成ではなかったことは、ログが証明しています。

:::message
この時期に Permission Boundary と Secrets Manager の権限問題にもぶつかっています。一時退避して本命構成に戻した経緯は、[別の記事](https://zenn.dev/kmryst/articles/rds-secrets-boundary-terraform-actions)で詳しく書いています。
:::

### 7月後半: IAM の壁と安定ベースライン

ここで捨てたのは、「とりあえず権限を足して通す」やり方です。採用したのは、**Permission Boundary 配下でも説明可能な最小権限に寄せ、あとから見ても責任境界が追える構成** でした。

7月22日から、IAM の設計を本格的に見直す作業が始まります。

```text
IAM 2 users and 2 roles start!
IAM 2 users and 2 roles 修正2
...
IAM 2 users and 2 roles 修正8
IAM 権限分析中1
...
IAM 権限分析中14
```

Permission Boundary 配下で CI/CD ロールの権限を通すために、14回の分析を経ています。この時期に「Permission Check」というワークフローを専用に作って検証していますが、10回中9回が失敗しました。

7月29日、「Athena 完成!」というコミットが入ります。ここで初めて、全コンポーネントが揃った安定状態ができました。次のフェーズでは、このベースラインから「どうデプロイするか」の設計に焦点が移ります。

### 8月1-2日: 1日で5つのワークフローが生まれた日

8月1日に `feature/automation` ブランチが「安定版 Athena」から作成されています。ここからデプロイ方式の実験が始まりました。

この2日間で生まれたワークフローは以下のとおりです。

- `🚀 Professional Blue/Green Deploy (Dev)` — 1回実行して終了
- `🚀 Deploy (Dev)` — 49回実行、45% 失敗
- `🚀 Deploy (Simple & Fast)` — 3回実行、全失敗
- `Deploy NestJS Hannibal (Fast)` — 67回実行、60% 失敗

同時に、コミットログには次の流れが残っています。

```text
Optimize deploy.yml for speed and simplicity
deploy.yml, destroy.yml 高速化して動く
deploy.yml, destroy.yml 高速化成功 ver.2
deploy.yml, destroy.yml 高速化成功 ver.3
deploy.yml, destroy.yml 高速化成功 ver.4
```

まず速度を最適化し、そのあと ECS Native Blue/Green（2025年7月17日にリリースされた新機能）を試みています。

```text
Add ECS Native Blue/Green Deployment rules - 2025年7月17日リリース機能対応
feat: ECS Native Blue/Green deployment
```

しかしこの方式は断念し、CodeDeploy ベースの Blue/Green に切り替えています。

```text
Amazon ECS blue/green deployments (Released July 17, 2025) はあきらめて、
CodeDeploy blue/green を実装する
```

断念した直接の理由は、AWS Provider v6.8.0 時点での Terraform サポートの制約です。ECS Native Blue/Green を試す過程で整理したルールファイルには、以下の記録が残っています。

```text
NOT supported in 6.8.0:
- advanced_configuration (invalid; use standard load_balancer block only)
- strategy = "BLUE_GREEN" (invalid; do not use)
- lifecycle_hook (not available in 6.8.0 schema)
```

ECS Native Blue/Green のルールファイル（355行）を削除し、CodeDeploy 用のルール（102行）に差し替えたのがこのコミットです。355行の設計が、実際には Provider 側の未対応で動かなかったことになります。

最終的に CodeDeploy を選んだのは、AppSpec（CodeDeploy がデプロイ先のコンテナ情報やロードバランサ設定を読み取る定義ファイル）+ `aws deploy create-deployment` による制御が明確で、Terraform 側との責務分離もしやすかったためです。

ここでの判断基準は、単に「実装できそうか」ではありませんでした。

- **Provider が現実的にサポートしているか**
- **失敗時の切り戻しと再実行の責任境界が明確か**
- **将来見返したときに、なぜその構成なのか説明できるか**

ECS Native Blue/Green は魅力的でしたが、この時点では上の基準を満たしきれませんでした。CodeDeploy は構成要素が増える一方で、責務分離と運用時の見通しを取りやすく、設計上はこちらのほうが一貫していました。

```yaml
# 最終形: CodeDeploy でモード分岐する部分
- name: Deploy with CodeDeploy Canary
  if: ${{ inputs.deployment_mode == 'canary' }}
  run: |
    DEPLOYMENT_ID=$(aws deploy create-deployment \
      --application-name "${{ env.PROJECT_NAME }}-app" \
      --deployment-group-name "${{ env.PROJECT_NAME }}-dg" \
      --s3-location bucket="$S3_BUCKET",key="$S3_KEY",bundleType="YAML" \
      --query 'deploymentId' --output text)
    aws deploy wait deployment-successful --deployment-id "$DEPLOYMENT_ID"
```

新しい公式機能に飛びつくより、要件に合う枯れた手段を選ぶほうが結果的に早い、という教訓です。

### 8月11-14日: CodeDeploy 修正115回目の突破

この転換点で捨てたのは、「CodeDeploy 固有の問題を個別修正で吸収し続ける」姿勢です。採用したのは、**PassRole、ターゲットグループ、ヘルスチェックを deployment の成立条件として整理し、成功条件を先に定義する** という進め方でした。

CodeDeploy の実装は、別の苦労を伴いました。

```text
CodeDeploy 修正80
CodeDeploy 修正81
...
CodeDeploy 修正115
```

8月11日だけで30回以上のコミットを積んでいます。IAM の PassRole 権限、ターゲットグループの順序、ヘルスチェックパスの設定など、CodeDeploy 特有の問題を1つずつ潰す作業です。

8月14日に転機が来ます。

```text
⭐️⭐️⭐️CodeDeploy blue/green deployments
feat: 完全なCanaryデプロイ対応 - Blue/Green/Canary/Provisioning全対応
```

ここで初めて、Blue/Green と Canary の両方が動く構成が完成しました。`Deploy NestJS Hannibal (Enterprise)` の失敗率は 24% まで下がっています。

同じ8月13日に、Destroy ワークフローも最終形の `Destroy AWS Infrastructure (Reliable)` が生まれ、以降 **29回の実行で失敗ゼロ** を記録しています。

### 10月: 「壊さない仕組み」への移行

この時点で捨てたのは、「deploy workflow だけを強くすれば安定する」という考え方です。採用したのは、**PR Check、Security Scan、Issue 駆動を含めて、変更が本番経路に入る前に壊れ方を制御する** という設計でした。

10月に入ると、ワークフロー自体の改修ではなく、開発プロセスの整備が中心になります。

- **PR Check 導入**（10/6）: ESLint、ビルド、`terraform fmt -check`、`terraform validate` を PR 単位で自動実行
- **Security Scan 導入**（10/7）: Trivy（依存 + コンテナ）、CodeQL（SAST）を統合
- **Issue 駆動開発への移行**: `feature/#41-github-cli-alias` のようなブランチ命名に統一
- **PR ベースのマージ**: `Merge pull request #XX` が初めてログに登場

Deploy ワークフローの名前も `Deploy NestJS Hannibal` に落ち着き、10月のデプロイ失敗率は **0%** になりました。

## コミットメッセージが示す成熟の度合い

コミットメッセージの変化は、パイプラインの安定度と相関しています。

| 時期 | コミットメッセージ例 | Deploy 失敗率 |
|:--|:--|--:|
| 5-6月 | `deploy.yml修正1`、`Terraformなど更新53` | 67-76% |
| 7月 | `IAM 権限分析中14`、`monitoring and alerting 修正8` | 74% |
| 8月前半 | `高速化成功 ver.4`、`CodeDeploy 修正115` | 39% |
| 8月後半 | `feat: 完全なCanaryデプロイ対応`、`fix: Target Group削除エラー修正` | 24% |
| 10月〜 | `ci: PR自動チェック機能を追加 (#5)`、`docs: README改善 (#22)` | 0% |

「修正N」の世界では、何を直したかがメッセージからわかりません。振り返ったときに同じ問題を繰り返していたかどうかも判別できません。Conventional Commits に移行し、Issue 番号でトラッキングするようになった時期と、パイプラインが安定した時期が一致しているのは偶然ではないと考えています。

コミットメッセージは「未来の自分への申し送り」です。CI/CD の安定性は、コードの品質だけでなく、こうした開発プロセスの成熟にも依存します。

## 選ばなかった選択肢

### ECS Native Blue/Green（2025年7月リリース）

8月2日に試み、同日中に断念しています。リリース直後の機能で情報が少なく、CodeDeploy のほうが必要な設定の柔軟性を確保できました。今後 ECS Native Blue/Green が成熟すれば再検討の余地はありますが、個人開発で「動くものが必要な今」には、枯れた手段のほうが合っていました。

### 1つのワークフローを直し続ける方針

初期は `Deploy NestJS Hannibal App` を110回実行し続けていました。途中から、設計方針が変わるたびにワークフローごと作り直す方式に切り替えています。

振り返ると、「修正を重ねた1本」より「意図を持って作り直した新しい1本」のほうが、失敗率の改善は早かったです。ワークフロー定義には設計思想が反映されるため、思想が変わったのに同じファイルを書き換え続けると、古い前提が残りやすくなります。

### 「Safe」という設計目標

Destroy ワークフローの初代は「Safe」と名付けましたが、60% 失敗しました。安全性を目標に掲げても、それだけでは安全になりません。

最終的に「Reliable」という名前にしたのは、意図の変化を反映しています。何を守りたいかではなく、何が信頼できる状態かを基準にした設計のほうが、結果として安全でした。

## 学び

最終的に安定したのは、workflow をたくさん直したからではなく、設計の単位を整理できたからです。Terraform にすべてを背負わせず、デプロイ戦略は CodeDeploy、解体順序は Destroy workflow、品質担保は PR Check / Security Scan へ分離したことで、各失敗の責任範囲が見えるようになりました。

- CI/CD の最初の1回を通すまでが最も重い。ローカルで動く構成の前提は、GitHub Actions のランナー上では通用しないことが多い
- 機能を追加するたびにパイプラインが壊れるのは、ある程度は避けられない。問題は壊れること自体ではなく、壊れたときの復旧が速いかどうか
- ワークフロー名は設計意図の記録になる。名前を変えたタイミングと理由を意識すると、あとで振り返りやすい
- 新しい公式機能に飛びつくより、枯れた手段で要件を満たすほうが個人開発では安定しやすい
- コミットメッセージの質とパイプラインの安定度は相関する。何を直したかがわからないメッセージは、同じ問題の繰り返しを招く
- 「壊さない仕組み」（PR Check、Security Scan、Issue 駆動）の導入は、ワークフロー自体の改善と同じかそれ以上に効果がある
- 失敗率の改善は「良いワークフローを書く」だけでは足りない。開発プロセス全体の成熟が必要になる

## この連載で今後扱う予定のテーマ

以下のテーマを、それぞれ独立した記事として深掘りする予定です。

- **CodeDeploy Blue/Green + Canary の実装**: 修正80〜115で何が起きていたか、AppSpec 生成の落とし穴
- **Destroy ワークフロー4世代の設計判断**: Safe → Reliable への道と、月額コスト最適化
- **Permission Boundary 配下の CI/CD 設計**: IAM で9連敗してから学んだ最小権限設計の進め方
- **セキュリティスキャンの CI 統合**: Trivy + CodeQL + Gitleaks の組み合わせで起きた問題

なお、Permission Boundary と Secrets Manager の権限問題については、[RDS管理シークレットに寄せたかったが撤退した話](https://zenn.dev/kmryst/articles/rds-secrets-boundary-terraform-actions)で詳しく書いています。
