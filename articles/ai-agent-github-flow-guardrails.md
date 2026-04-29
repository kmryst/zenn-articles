---
title: "AI Agentが雑にIssue/PRを作っても壊れないGitHubフローを作った"
emoji: "🧱"
type: "tech"
topics: ["github", "githubactions", "devops", "ai", "platformengineering"]
published: true
---

AI Agent に Issue や PR を作らせると、思っていたより簡単に運用が壊れます。Issue テンプレを使ったり使わなかったりする。必須ラベルを付け忘れる。PR 本文に Issue リンクがない。しかも、人間が GitHub Web UI から起票する経路、CLI で作る経路、Agent がヘルパー経由で作る経路が混ざると、「どの経路なら何が保証されるのか」がすぐ曖昧になります。

最初は README や CONTRIBUTING にルールを書けば回ると思っていました。ですが実際には、それだけでは足りませんでした。人間は忘れますし、Agent は「だいたい合っているが少しずれる」出力を普通に返します。運用を壊さないために必要だったのは、書かれたルールではなく、逸脱しても戻せるガードレールでした。

この記事は、GitHub で Issue 駆動開発を回したい個人開発者・少人数開発者と、AI Agent や CLI を使いながらも Issue / PR 運用を壊したくない人を対象にしています。特に、Web UI、CLI、Agent で起票経路が分かれていて、テンプレ・ラベル・チェックのどこで強制すべきか迷っている場合に参考になるはずです。

:::message
本記事の前提は次の通りです。

- 個人開発または少人数運用を主対象にしている
- Web UI / CLI / Agent の複数経路が混在する
- formal approval は常時必須にしていない
- 主に `dev` 相当の運用フロー整流を対象にしている
- Terraform `plan` や本番反映時の強い権限境界は別フェーズで扱う
:::

## 運用コンテキスト

この構成は、個人開発または少人数運用を前提にしています。主対象は `terraform-hannibal` のような、GitHub 上で Issue 駆動開発を回しつつ、Web UI / CLI / Agent の複数経路が混在する repository です。

前提として置いていた条件は次の通りです。

- formal approval は常時必須にしない
- まず整えたいのは `Issue / PR` の入力品質とフロー整流
- Terraform `plan` や本番反映時の権限境界は別フェーズで強化する
- 少人数でも詰まりにくく、Agent が混ざっても壊れにくいことを優先する

つまり、本記事のガードレールは「大規模組織の厳格な変更管理」よりも、「少人数でも回る実効的な制約」を狙ったものです。この前提が変われば、`approval` や `CODEOWNERS` の扱いも変わり得ます。

## 先に結論

最終的に採った構成はシンプルです。人間が GitHub Web UI から起票する時は `Issue Forms` を使い、AI Agent や CLI から起票する時は `helper scripts` を使う。どの経路から入っても、最後は `GitHub Actions` が本文とラベルを検査して、基準を満たさない Issue / PR は先へ進ませないようにしました。

具体的には、Issue 側では `目的 / 対象 / 受け入れ条件` と `type / area / risk / cost` を揃え、未整備なら `needs-template` を付けます。PR 側では Issue リンク、必須ラベル、厳密運用時の `ロールバック` をチェックします。さらに、CLI や Agent からの作成時にラベル漏れを起こしにくくするため、Issue / PR の作成ヘルパーも追加しました。

この構成にした理由は、単一の仕組みだけでは経路差を吸収しきれなかったからです。`Issue Forms` だけでは CLI / Agent に弱く、`GitHub Actions` だけでは入口のミスが多く、`helper scripts` だけでは最後の強制力が足りませんでした。そこで、入口・補助・最終強制を分担させる形に落ち着きました。

## 評価軸

複数の施策を比較するために、本記事では次の5つの評価軸を使います。

- `Enforceability（強制力）`
  - 運用ルールを、推奨ではなく実効的な制約として適用できる度合い
- `Operational Overhead（運用負荷）`
  - 運用維持に必要な人的手順、認知負荷、保守コストの総量
- `Flow Availability（フロー可用性）`
  - 開発フローが不要な待ちや詰まりを起こさず継続できる度合い
- `Consistency（一貫性）`
  - Web UI / CLI / Agent など複数の起票経路で同じルールを維持できる度合い
- `Observability（観測可能性）`
  - 失敗要因や不足条件を利用者が把握し、次の修正行動へつなげやすい度合い

ここでいう `Flow Availability` は、システムの稼働率ではなく、開発フローが手続き上の詰まりで止まりにくいかを意味します。また `Observability` は監視基盤の話ではなく、「なぜその Issue / PR が止まったのか」を人間や Agent が理解しやすいか、という意味で使います。以後の表では、見出しは英語表記だけにしています。

## 採用した改善を段階ごとに比較する

今回の改善は、最初から `Issue Forms + GitHub Actions + helper scripts` の完成形を選んだわけではありません。実際には、人間運用だけの状態から出発し、どこで強制し、どこで補助し、どこを最後のゲートにするかを少しずつ積み上げています。

そこでまず、採用した改善を4段階に分けて比較します。ここでの `High / Medium / Low` は絶対評価ではなく、上の運用コンテキストにおける相対評価です。たとえば `Flow Availability` はシステム稼働率ではなく、少人数の開発フローが不要な待ちや手戻りで詰まりにくいか、という意味で置いています。

なお、この段階では before / after の厳密な運用メトリクスまでは取れていません。ここでの比較は、実際に詰まったポイント、減った手戻り、追加された強制点をもとにした設計上の相対評価です。

| Stage | Enforceability | Operational Overhead | Flow Availability | Consistency | Observability |
| --- | --- | --- | --- | --- | --- |
| 人間運用のみ | Low | Low | Medium | Low | Low |
| Issue Forms | Medium | Low | High | Low | Low |
| Issue Forms + Actions | High | Medium | Medium | Medium | High |
| Issue Forms + Actions + Helper scripts | High | Low | High | High | High |

まず分かりやすいのは、`Issue Forms` だけでは `Consistency` が上がり切らないことです。Web UI で起票する人に対しては強い一方で、CLI や AI Agent を使う経路までは揃えられません。フォーム自体は有効でも、それだけで運用全体を正せるわけではありませんでした。

次に大きかったのは、`GitHub Actions` を入れた段階で `Enforceability` と `Observability` が一気に上がったことです。本文やラベルに不足があれば `needs-template` で止められるようになり、さらに不足理由をコメントで具体表示することで、「なぜ止まったのか」が分かるようになりました。ここで初めて、「お願い」ではなくガードレールとして機能し始めたと言えます。

一方で、`Actions` だけでは入口のミスが減りません。実際に運用してみると、PR ラベル漏れや Issue ラベル漏れは普通に起きました。そこで `helper scripts` を入れると、CLI / Agent 経由でも Web UI に近い形で必要項目を揃えられるようになり、`Flow Availability` と `Consistency` が改善しました。ここでようやく、複数経路が混在しても大きく崩れにくい状態になりました。

ここでいう `Operational Overhead` が `Issue Forms + Actions + Helper scripts` で `Low` に戻っているのは、工程数が減ったからではありません。必要な工程は増えていますが、作成ヘルパーと具体的なフィードバックによって「毎回同じミスを手で直す負荷」が下がったためです。今回の文脈では、工程の少なさではなく、日常運用での認知負荷の低さを重視しています。

重要なのは、どれか1つの施策が決定打だったわけではないことです。`Issue Forms` は入口の整流、`GitHub Actions` は最終強制、`helper scripts` は経路差の吸収、という役割分担をさせたことで、少人数でも回るバランスに落ち着きました。

## 採用しなかった選択肢も比較する

採用した改善だけを並べると、「最初からその構成を選べばよかったのでは」と見えやすくなります。ですが実際には、もっと軽い案も、もっと強い案もありました。問題は、それぞれが一部の痛みには効いても、今回の制約と優先順位には合い切らなかったことです。

そこで次に、採用しなかった選択肢も比較します。ここで見たいのは「なぜその案が間違っていたか」ではなく、「今回の repo と運用条件では、どの限界が先に来たか」です。

| Option | Strength | Limitation | Why Not Adopted |
| --- | --- | --- | --- |
| README / Wiki にルールを書くのみ | 導入コストが最小 | 強制力がない | AI / CLI 経由の逸脱を防げず、運用依存が強すぎた |
| Issue Forms のみ | Web UI では入力を強制できる | CLI / Agent 起票に弱い | 起票経路が複数あるため、Web UI だけを正としても一貫性が足りなかった |
| Actions checks のみ | 全経路に対して強制できる | 作成後に止まるためノイズが出る | 強制力は高いが、入口でのミス削減が弱く、UX が悪化しやすかった |
| Helper scripts のみ | ラベル漏れや本文ミスを減らしやすい | 使わない経路を止められない | 正規コマンドとしては有効だが、最終的な強制は CI に委ねる必要があった |
| approval / CODEOWNERS を先に重くする | レビューの厳格性は上がる | 少人数運用では詰まりやすい | まず解くべき問題は Issue / PR 作成品質であり、入口と出口の整流が先だった |

特に `approval / CODEOWNERS` を早い段階で重くしなかったのは、緩くしたかったからではありません。先に解くべきボトルネックが別にあったからです。Issue や PR の入力品質が揃っていない段階でレビューだけ厳格にしても、止まる場所が増えるだけで、入力の揺れそのものは解消しませんでした。

## 実装したガードレール

実際に入れたものは、大きく4つです。

実装の起点になった主なファイルは次の通りです。

- `pr-check.yml`
  - <https://github.com/kmryst/terraform-hannibal/blob/main/.github/workflows/pr-check.yml>
- `issue-template-check.yml`
  - <https://github.com/kmryst/terraform-hannibal/blob/main/.github/workflows/issue-template-check.yml>
- `create-issue-with-labels.sh`
  - <https://github.com/kmryst/terraform-hannibal/blob/main/scripts/github/create-issue-with-labels.sh>
- `create-pr-with-labels.sh`
  - <https://github.com/kmryst/terraform-hannibal/blob/main/scripts/github/create-pr-with-labels.sh>
- `feature_request.yml`
  - <https://github.com/kmryst/terraform-hannibal/blob/main/.github/ISSUE_TEMPLATE/feature_request.yml>

### 1. PR 側の最低限を強制する

PR には、少なくとも次を必須にしました。

- Issue リンク
  - `Closes #xx` / `Fixes #xx` / `Refs #xx`
- 必須ラベル
  - `type / area / risk / cost`

さらに `.github/workflows/**` や `terraform/**` のような高リスク変更は、厳密運用PRとして `ロールバック` も必須にしています。

### 2. Issue 側の品質ゲートを置く

Issue には、最低限として次を要求しています。

- `目的`
- `対象`
- `受け入れ条件`
- `type / area / risk / cost`

足りなければ `needs-template` を付けます。重要だったのは、単に止めるだけでなく、「何が足りないか」を具体的に見せることでした。最初は generic な説明を返していましたが、それでは修正行動に直結しませんでした。最終的には次のように改善しました。

- `見出し不足`
- `中身が空`
- `ラベル不足`

を分けてコメントする。

これにより `Observability` がかなり上がりました。

### 3. Issue / PR 作成ヘルパーを追加する

CLI や Agent が GitHub を触る時の正規コマンドとして、次を追加しました。

- `scripts/github/create-issue-with-labels.sh`
- `scripts/github/create-pr-with-labels.sh`

典型的な呼び方はこうです。

```bash
./scripts/github/create-issue-with-labels.sh \
  --title "[DX] PR作成時の必須ラベル付与を自動化" \
  --body-file /tmp/issue.md \
  --type type:infra \
  --area area:ci-cd \
  --area area:docs \
  --risk risk:low \
  --cost cost:none
```

これで、少なくとも次の初歩的な漏れはかなり減りました。

- Issue ラベル漏れ
- PR ラベル漏れ
- PR 本文の `Closes #xx` 漏れ

CI だけでは、違反を止められても、入口のミス自体は減りません。ヘルパーはそこを埋める役割でした。

### 4. Web UI / CLI / Agent の3経路を同じルールへ寄せた

最終的には、経路ごとの役割をこう分けました。

- 人間
  - 基本は GitHub Web UI の `Issue Forms`
- AI Agent / CLI
  - 基本は helper scripts
- 最終強制
  - GitHub Actions

この役割分担が決まってから、ルールがかなり壊れにくくなりました。

## 失敗時にどう戻せるようにしたか

DevOps の運用改善では、「どう止めるか」だけでなく「どう戻せるか」も同じくらい重要でした。今回のガードレールでは、少なくとも次の3点を意識しています。

- 厳密運用PRでは `ロールバック` を必須にする
- `needs-template` は不足理由を具体表示し、修正後は自動で外れるようにする
- Issue 作成ヘルパーでは、作成時点でラベルを付けて不要な誤判定を減らす

特に `needs-template` まわりは、最初は「止まるが、なぜ止まったかが分かりにくい」状態でした。これでは `Enforceability` は上がっても `Flow Availability` が落ちます。そこで、見出し不足・中身が空・ラベル不足を分けて表示し、修正後に自動で解除するようにしました。結果として、失敗時の blast radius を局所化し、復旧までの手戻りを小さくできました。

実際のコメントは、最終的に次のような形へ寄せました。

```md
## 要修正

このIssueは次を修正すると通ります:

- 見出し不足: `受け入れ条件`
```

先頭の generic な説明を削り、最初に「何を直せば通るか」だけが見えるようにしたのがポイントです。

## 運用して初めて分かったこと

実装して初めて分かったのは、ガードレールは「強く止める」だけでは足りないということです。止めた後に、利用者がすぐ直せる必要があります。`needs-template` が付くこと自体よりも、「何を直せば外れるのか」が分からない方が運用を詰まらせました。

もう1つ大きかったのは、複数経路を前提に設計しないと、どこかで必ず運用が人間依存に戻ることです。Web UI だけを整えても CLI / Agent がずれますし、CI だけを強くしても入口のミスは減りません。結果として、入口・補助・最終強制を分ける設計が一番安定しました。

つまり、今回の改善の本質は、GitHub の機能を増やしたことではありません。**人間が覚えて守る運用から、忘れても戻せる運用に置き換えたこと**です。

一方で、このガードレールはあくまで Issue / PR メタデータと入力品質を整えるためのものです。シークレット保護、supply chain 対策、workflow 実行権限の分離そのものを置き換えるものではありません。その線引きを意識したうえで、責務を分けて積み上げる必要があります。

## 今回あえてスコープ外にしたもの

今回の記事では、次のものは扱っていません。

- Terraform `plan` の PR 自動実行
- plan 用 read-only role
- deploy / destroy の追加承認
- approval 常時必須化
- CODEOWNERS の本格導入

これらは重要ですが、テーマが少し変わります。今回の主題はあくまで「Issue / PR フローを、AI Agent 混在でも壊れにくくすること」でした。IaC の本番ガードは、その次の層として切り出した方がきれいです。

## まとめ

AI Agent を混ぜた GitHub 運用で問題になるのは、Agent 自体の賢さより、起票経路の増加による揺れでした。Web UI、CLI、Agent のどれか1つに最適化しても、他の経路で簡単に崩れます。

そのために必要だったのは、1つの万能策ではなく、役割分担されたガードレールでした。

- Web UI は `Issue Forms`
- CLI / Agent は `helper scripts`
- 最終強制は `GitHub Actions`

この3層を揃えると、少人数でも、AI Agent を使っても、Issue 駆動開発をかなり安定して回せるようになります。次はこの上に、Terraform `plan` や権限境界のガードレールを重ねていく予定です。
