---
title: "Dependabotに任せよ？"
emoji: "🤖"
type: "tech"
topics: ["githubactions", "dependabot", "cicd", "devops"]
published: true
---

## 対象読者

GitHub Actions で CI/CD を運用していて、Dependabot の導入を検討しているか、あるいは PR ガバナンスルール（必須ラベル・Issue リンクなど）をすでに整備している人。

## 先に結論

- ポートフォリオ / dev 環境 / 公式 action 中心という前提では、GitHub Actions の action バージョン管理に Dependabot（メジャータグ + 週次 PR）を使うのは正しい選択
- ただし、人間向けのガバナンスルール（Issue 連携・ラベル体系・ロールバック計画）をそのまま Bot の PR に適用すると CI が全落ちする
- 根本対応は、**人間の説明責任を検査するジョブのみ** `if: github.actor != 'dependabot[bot]'` で除外すること。lint・test・build・secret scan など技術的チェックは Bot PR でも継続実行する
- `skipped` になるのは job-level の `if:` で条件が false のとき。この場合 GitHub は required status check を充足したとみなす。branch protection の設定変更は不要
- `dependabot.yml` の `labels:` は既定ラベル（`dependencies` / `github_actions`）への追加ではなく**置き換え**のため、人間ガバナンス用ラベルを設定すると Dependabot 標準の分類ラベルが失われる

:::message
この記事は terraform-hannibal（個人の DevOps ポートフォリオ）を題材にしています。チーム規模は1人、対象環境は dev 環境のみ、権限境界は OIDC + Permission Boundary で管理しています。
:::

## 経緯：閉じた Issue を DevOps 観点でレビューした

GitHub Actions の Node 20 runtime deprecation と CodeQL Action v3 deprecation に対応する Issue を実装・クローズした後、「DevOps / SRE / Platform Engineering として適切な実装になっているか」という観点で改めてレビューした。

本来は PR の段階でこのレビューができていれば理想だった。それができなかった場合でも、クローズ後にレビューすることで改善点が見つかる。「実装完了」と思った瞬間が次の改善の入口になる。

レビューで見つかった改善点は3つだった。

| 指摘 | 内容 |
|---|---|
| ① | action を `@vX` メジャータグで固定しているが、バージョン追跡が手動になっている |
| ② | `security-scan.yml` に `concurrency:` 設定がなく、手動実行の連打で並走が起きうる |
| ③ | `micnncim/action-label-syncer@v1` が外部メンテナの Docker action で、メンテ停止リスクがある |

②と③は迷う余地がなかった。`concurrency:` は CI/CD の基本なので即対応、③は今すぐ対処する必要はないためバックログに記録した。

問題は①だった。

## ①の対応：Dependabot を有効化する

action のバージョン追跡には3つの選択肢がある。

| 選択肢 | 内容 | 不採用理由 |
|---|---|---|
| 手動管理 | 現状維持 | version drift の見落としリスクが残る |
| SHA ピン | `uses: actions/checkout@abc1234` 形式 | PR の diff が SHA の羅列になり可読性が下がる。ポートフォリオ文脈では採用しない |
| **Dependabot** | `.github/dependabot.yml` で週次 PR を自動生成 | **採用** |

SHA ピンはサプライチェーンリスクをさらに下げる。ただし今回の判断軸は「ポートフォリオ / dev 環境 / 可読性 / 運用負荷」であり、PR の diff が SHA の羅列になるコストがメリットを上回ると判断した。本番環境・監査要件がある環境・外部メンテナの action を多用する場合は SHA ピンを検討する。

`.github/dependabot.yml` をこう設定した。

```yaml
version: 2
updates:
  - package-ecosystem: "github-actions"
    directory: "/"
    schedule:
      interval: "weekly"
      day: "monday"
      time: "09:00"
      timezone: "Asia/Tokyo"
```

## CI が全落ちした

マージした直後、Dependabot が自動で4件の PR を生成してきた。

```
chore(deps): bump actions/setup-node from 5 to 6
chore(deps): bump actions/github-script from 8 to 9
chore(deps): bump actions/upload-artifact from 6 to 7
chore(deps): bump actions/checkout from 5 to 6
```

4件すべてで PR Policy Check が落ちた。

```
Current PR labels: ["dependencies","github_actions"]
Error: type:* ラベルがちょうど1つ必要です（現在: 0件）
Error: area:* ラベルが1つ以上必要です（現在: 0件）
Error: risk:* ラベルがちょうど1つ必要です（現在: 0件）
Error: cost:* ラベルがちょうど1つ必要です（現在: 0件）
Error: PR本文にIssueリンクが必要です（例: Closes #123）
Error: 厳密運用PRにはロールバック欄への記載が必要です
```

## 最初に疑ったこと：ラベルを足せばいい

最初の判断は「`dependabot.yml` に `labels:` を追加してラベルを自動付与すればいい」だった。

```yaml
    labels:
      - "type:chore"
      - "area:ci-cd"
      - "risk:low"
      - "cost:none"
```

実際にこの PR を作った。しかし2つの問題があった。

1つ目。**`dependabot.yml` の `labels:` は既定ラベル（`dependencies` / `github_actions`）を置き換える。** 追加ではない。設定すると Dependabot 標準の分類ラベルが失われ、人間ガバナンス用の分類ラベルに上書きされる。意味の異なる分類を同じ軸に押し込む設計になる。

2つ目。**Issue リンクとロールバック欄は `dependabot.yml` では解決できない。** Dependabot PR の本文は自動生成されるため、`Closes #123` も rollback セクションも構造的に存在しない。

ラベルを足すのは「ラベルエラーを消す」だけの暫定対応であり、根本原因への対処ではなかった。

## 実際の原因：人間向けのルールを Bot に適用していた

PR Policy Check が検査していたのは「人間のワークフローガバナンス」だった。

- Issue 連携 → 誰が・なぜ変更するかの説明責任
- ラベル体系 → 変更の性質を分類する
- ロールバック計画 → 失敗時にどう戻すかを人間が考える

Dependabot PR はこれらの「PR 本文に人間が書く」対象ではない。「誰が・なぜ・どう戻すか」は自明だ。

| 問い | Dependabot PR の答え |
|---|---|
| 誰が | GitHub が自動生成 |
| なぜ | 依存バージョンの更新 |
| どう戻すか | バージョンを戻す（PR を revert すれば完結）。ロールバック計画を PR 本文に書く必要がない、ということであり、ロールバックを考えなくていいわけではない |

ガバナンスルールは人間が書く PR を対象として設計されていた。Bot の PR にそれを適用したのが設計ミスだった。

ただし、これは「Bot PR を無審査にする」話ではない。lint・test・build・secret scan などの技術的チェックは Bot PR でも通す。変更リスクの評価やメジャーバージョン更新のレビューも人間が行う。除外するのは「人間の説明責任を求める」ジョブのみだ。

## 根本対応：チェックの適用範囲を正しく設計する

`pr-policy-check` ジョブに1行追加した。

```yaml
  pr-policy-check:
    name: PR Policy Check
    if: github.actor != 'dependabot[bot]'
    runs-on: ubuntu-latest
```

これで Dependabot PR は PR Policy Check をスキップし、lint・test・build などの技術的チェックは引き続き実行される。

### `skipped` は required status check を充足するか

PR Policy Check はこのリポジトリの required status check に設定されている。`if:` 条件が false のときジョブの結論は `skipped` になるが、**job-level の `if:` による `skipped` は GitHub の required status check を充足したとみなされる。** branch protection の設定変更は不要だった。

:::message
`skipped` の扱いは条件によって異なる。job-level の `if:` による skip は success 相当だが、paths フィルタや branches フィルタによって workflow 自体が実行されなかった場合は required check が pending のままになることがある。`if: github.actor != 'dependabot[bot]'` のような actor 条件は job-level の skip のため、前者に該当する。

参考: [Troubleshooting required status checks - GitHub Docs](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/troubleshooting-required-status-checks)
:::

### ラベルを `dependabot.yml` に追加する必要はあるか

改めて判断した。不要。

Dependabot PR には GitHub が自動で `dependencies` / `github_actions` ラベルを付ける。これが Dependabot PR を識別するための本来の分類だ。`labels:` に人間ガバナンス用ラベルを設定すると、この標準分類ラベルが失われる。作りかけていた PR はクローズした。

## near-miss

`gh run rerun --failed` で失敗した CI を再実行したが、PR Policy Check が通らなかった。`gh run rerun` は**元の run と同じワークフロー定義を使う**ため、`pr-check.yml` を更新した後の再実行では新しい `if:` 条件が反映されなかった。

既存の failed run を再実行するのではなく、**Dependabot のブランチに最新のワークフロー定義を読ませる**必要があった。Dependabot PR に `@dependabot rebase` コメントを送ることで Dependabot がブランチをリベースし、最新の `pr-check.yml` を参照した新しい run が走った。

## まとめ

このプロジェクトの前提では Dependabot を入れる判断は正しかった。問題は「入れ方」ではなく「既存のルールが Bot を想定していなかった」ことにあった。

ガバナンスルールを設計するとき、それが「人間の説明責任」を求めるものであれば、自動化された PR には適用しないことを最初から設計に織り込む。今回は後から気づいたが、PR Policy Check を実装する段階で `dependabot[bot]` の除外を書いておくのが本来の順序だった。

判断軸はシンプルだ。**「そのチェックは人間の説明責任を検査しているのか、変更の安全性を検査しているのか」で分ける。** 前者は Bot PR に適用しない。後者は Bot PR でも通す。この境界を引くことが、required check の意味を壊さず不要な赤を減らす、運用品質の設計になる。
