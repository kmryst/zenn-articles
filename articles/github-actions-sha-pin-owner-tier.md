---
title: "仮タイトル"
emoji: "🔒"
type: "tech"
topics: ["githubactions", "dependabot", "cicd", "devops", "security"]
published: false
---

## 対象読者

前回記事（Dependabotに任せよ？）を読んでいる、または GitHub Actions の action バージョン管理方針を設計判断したい人。SHA pin の可読性問題が気になって踏み切れていない、あるいは「とりあえず SHA pin すればよい」と思っているが詰めに自信がない人。

## 先に結論

- `uses: owner/action@<sha> # vX.Y.Z` 形式なら Dependabot が SHA と同一行コメントを同時に更新してくれる。「diff が SHA の羅列で読めない」という前回の不採用理由は、この形式を知らなかったことが原因だった
- GitHub-owned（`actions/*`, `github/codeql-action/*`）は `@vX.Y.Z`、それ以外は `@<sha> # vX.Y.Z` の 2-tier で整理すると、Dependabot alerts の維持と改ざん耐性をアクション種別で分担できる。ただし「Tier A は alerts を維持できる」は **repo 側の vulnerability alerts 設定が有効であること**が前提になる
- pin 先は「floating major tag（`@vX`）が今この瞬間に指している commit」が起点。最新版への更新ではなく pin と upgrade を分離する。ただし **active advisory がある場合は known-safe な commit を確認してから pin する**。SHA pin は固定であって浄化ではない

:::message
この記事は terraform-hannibal（個人の DevOps ポートフォリオ）を題材にしています。チーム規模は1人、対象環境は dev 環境のみ、権限境界は OIDC + Permission Boundary で管理しています。
:::

## 前回記事の判断：SHA pin 不採用

前回記事（Dependabotに任せよ？）で、action バージョン管理の選択肢をこう整理した。

| 選択肢 | 不採用理由 |
|---|---|
| 手動管理 | version drift の見落としリスクが残る |
| SHA ピン | PR の diff が SHA の羅列になり可読性が下がる |
| **Dependabot（採用）** | — |

この判断軸はポートフォリオ / dev 環境 / 可読性 / 運用負荷だった。SHA pin のサプライチェーンリスク低減は認めつつも、可読性のコストがメリットを上回ると判断して不採用にした。

その記事に読者からコメントが届いた。

## コメントが判断を変えた

前回記事の「SHA の羅列で可読性が下がる」という箇所に対して、`@sha # vX.Y.Z` 形式でインラインコメントにバージョンを書けば Dependabot がコメントも更新してくれるので安全性と可読性を両立できる、という趣旨のコメントが届いた。参考記事のリンクも添えてあった。

確認すると、この形式のことだった。

```yaml
- uses: aws-actions/configure-aws-credentials@e7f100cf4c008499ea8adda475de1042d6975c7b # v6.2.0
```

Dependabot version updates は、`uses:` 行の末尾に `# vX.Y.Z` 形式のインラインコメントがあると、更新 PR でハッシュとコメントを**同時に書き換えてくれる**。PR の diff は SHA が別の SHA に変わるが、コメントで `# v6.2.0 → # v6.3.0` という意味が読める。

「SHA の羅列で意味がわからない」という前回の不採用理由は、この形式を知らなかったことが原因だった。

## 2026年3月の trivy-action インシデント

コメントをもらったタイミングで、もう一つの文脈が重なっていた。

2026年3月19日、攻撃者が漏洩した credentials を使い、`aquasecurity/trivy-action` の version tags を悪性コミットへ書き換えた。`trivy-action` の exposure window は約12時間。CI 上で SSH keys・cloud credentials・Kubernetes tokens などを窃取するマルウェアが実行される状態が続いた。

公式 advisory（GHSA-69fq-xp46-6x23）に記載されている `trivy-action` の affected range は **v0.35.0 より前**のタグだ。`trivy-action` が内部で呼ぶ `aquasecurity/setup-trivy` や、実行時に取得する Trivy binary はそれぞれ別コンポーネントで、affected range と exposure window が異なる。これらを混同すると影響範囲の評価がずれる。

**semver tag が可変参照であることの意味**

この事案で確認すべき核心は「semver tag は一般に immutable とは限らない」という事実だ。リポジトリ側で tag を別の commit に書き換えることは技術的に可能であり、攻撃者が悪用すれば CI はその内容を実行する。SHA pin はこの書き換えに対して耐性がある。`uses:` に書いた full-length SHA が指す commit の内容は変わらないからだ。

**「SHA pin なら常に安全」ではない**

SHA pin は固定であって浄化ではない。インシデント前に非悪性コミットに固定済みのワークフローは影響を受けなかったが、advisory 発令後に今の参照先を確認せずに pin した場合、悪性コミットの SHA をそのまま固定してしまう可能性がある。advisory がある状況で pin する場合は known-safe な commit を確認してから行う。

この事案が示すのは「SHA pin は semver tag より改ざんに強い」という事実であり、「SHA pin さえすれば完全に安全」という保証ではない。

## 2-tier 方針の設計

可読性の問題が解消し、実害事例もある。ただし「全 action を SHA pin する」という選択肢は採らなかった。

検討した選択肢：

| 選択肢 | 問題点 |
|---|---|
| 全 action を `@vX` のまま | 実行内容がサイレントに変わる |
| 全 action を `@vX.Y.Z` に固定 | semver tag も可変参照。改ざん耐性は上がらない |
| 全 action を SHA pin | GitHub-owned の Dependabot alerts も失う |
| **GitHub-owned / 非 GitHub-owned で 2-tier（採択）** | alerts 維持と改ざん耐性を分担できる |

採択した方針：

- **Tier A（`actions/*`, `github/codeql-action/*`）**：`@vX.Y.Z` に固定。Dependabot alerts と security updates を維持する
- **Tier B（それ以外の全外部 action）**：`@<sha> # vX.Y.Z` に固定。改ざん耐性を優先する

**GitHub-owned を semver tag にした理由**

GitHub-owned actions は GitHub Actions platform に近い trust boundary として扱える。ここでの判断は「GitHub-owned だから改ざんリスクがない」という信頼ではない。「semver tag が可変参照であるリスクを受容する代わりに、Dependabot alerts（特に CodeQL の脆弱性通知）を維持する」という選択だ。GitHub-owned でも semver tag は immutable ではない。それでも alerts を残す価値と trust boundary を考えて、今回はそのリスクを受容した。

非 GitHub-owned action は大手ベンダーであっても外部依存だ。AWS credentials・Terraform・container build/push など CI/CD の重要処理を担う action が多く、trivy-action のインシデントが示すように大手 org も攻撃対象になる。「GitHub-owned 以外は SHA pin」という単純なルールで action を追加するときの判断をブレなくする。

**SHA pin で得るもの / 失うもの / 補完策**

| | Tier A（GitHub-owned） | Tier B（非 GitHub-owned） |
|---|---|---|
| Dependabot alerts（脆弱性通知） | ✅（repo 設定が有効なら） | ❌ 無効 |
| Dependabot version updates（定期更新 PR） | ✅ | ✅（SHA + コメントを同時更新） |
| タグ移動・改ざんへの耐性 | ❌ semver tag は可変参照 | ✅ SHA は不変 |

Tier B では脆弱性通知が届かなくなる。定期的な更新 PR（version updates）は引き続き機能するが、alerts の代替ではない。この欠落は PR review 時の release notes 確認と GitHub Advisory Database の定期確認で補完する。

Tier A の「Dependabot alerts を維持する」は、参照形式を `@vX.Y.Z` にするだけでは成立しない。**repo 側の vulnerability alerts 設定が有効でなければ alerts は届かない**。この点は後述する。

**この方針を採る条件 / 採らない条件**

2-tier 方針が合う条件：

- GitHub-owned action の Dependabot alerts を維持したい（特に CodeQL の通知）
- 管理できる範囲の action 数（初回の SHA 確定にコストがかかる）
- 個人〜小規模チームで、PR で action の変更を人間が確認できる体制がある

より厳しい対応（全 SHA pin）を検討する条件：

- prod secrets を扱う action が多く、GitHub-owned でも改ざんリスクを最小化したい
- compliance 要件や org policy で full SHA が必須
- self-hosted runner でサプライチェーンリスクが高い
- Dependabot alerts の代替手段（別ルートの脆弱性通知）がある

2-tier より軽い方針（semver patch + Dependabot）で十分な条件：

- secrets を持たない CI（lint・test のみで、cloud credentials を渡さず、`GITHUB_TOKEN` の権限も `permissions: contents: read` 程度に最小化している）
- GitHub 公式 action が中心で、外部 action の数が少ない
- org policy や compliance 要件がない個人 repo
- 運用負荷を優先し、Dependabot alerts + version updates の組み合わせで補完できると判断した場合

## 実装：floating tag 起点で pin 先を決める

**通常の原則：floating tag が今指す commit に pin する**

「最新 patch version に上げておく」という考え方は pin と upgrade を混同している。pin の目的は「今動いている状態を固定すること」だ。`@vX` で動いていたワークフローは今この瞬間に `@vX` が指す commit で動いている。その commit に pin すれば、確実に動くことが証明された状態で固定できる。未知の patch バージョンへの更新は Dependabot に任せる別の操作として分離する。

**active advisory がある場合の例外**

ただし advisory が発令中の場合は例外だ。SHA pin は固定であって浄化ではない。今の参照先が悪性コミットを指している可能性がある。

本来の手順：

1. 対象 action に active advisory / GHSA がないかを確認する（GitHub Advisory Database、または `gh api` で GHSA を検索する）
2. composite action（`action.yml` に `runs.using: composite` があり内部で別 `uses:` を呼ぶ形式）の場合は `action.yml` を確認し、内部でさらに `uses:` している action や、実行時に取得する binary / image の version も確認対象に含める。trivy-action が `setup-trivy` を呼び Trivy binary を取得するのがこの例にあたる
3. advisory がなければ floating tag が今指す commit に pin する
4. advisory があれば patched / safe とされているバージョンの commit SHA を確認してから pin する

terraform-hannibal の初回 pin（PR #355）では、この advisory の確認を明示的には実施していなかった。事後に確認した範囲では差し替えるべき advisory は見つからなかったが、本来は pin 前に確認すべき手順だ。事後確認の結果は次のセクションに記録する。

### SHA の取得方法

floating major tag が今指す commit SHA を調べる。

```bash
git ls-remote https://github.com/aws-actions/configure-aws-credentials.git \
  refs/tags/v6 'refs/tags/v6^{}'
```

返り値は2パターンある。

**annotated tag（2行返る）**

```text
aaaa...  refs/tags/v6
e7f1...  refs/tags/v6^{}
```

`^{}` がついた行が実際の commit を指す。`uses:` に書くのはこちらだ。`aaaa...` の tag object SHA を使うと action が動かない。

**lightweight tag（1行だけ返る）**

```text
e7f1...  refs/tags/v6
```

1行しか返らない場合、その SHA が commit SHA だ。

commit SHA が決まったら、対応する semver tag を逆引きしてインラインコメントに書く。

```bash
git ls-remote --tags https://github.com/aws-actions/configure-aws-credentials.git \
  | grep e7f100cf4c008499ea8adda475de1042d6975c7b
```

full-length SHA で照合すること。短縮 SHA は別コミットと衝突する可能性がある。また、結果が action の本家リポジトリの commit であることを確認してから使う。

`refs/tags/v6.2.0` が見つかれば、こう書く。

```yaml
- uses: aws-actions/configure-aws-credentials@e7f100cf4c008499ea8adda475de1042d6975c7b # v6.2.0
```

### near-miss：annotated tag の SHA を間違えた

`github/codeql-action`（Tier A）の固定で最初に間違えた。

「最新の patch は v4.36.0 だろう」と決め打ちして `@v4.36.0` と書いた。`git ls-remote` で実際に確認すると、`@v4` が指していたのは `v4.36.2` だった。floating tag が指すバージョンと「最新版」は一致しない。この確認を省くと、pin と実態がズれる。

加えて `github/codeql-action` の `@v4` は annotated tag だった。`git ls-remote` が2行返してきたとき、tag object SHA（上の行）を `uses:` に書いていた。action は動かなかった。`^{}` 行の commit SHA を使う必要がある。

## 初回 pin 後の安全性確認

初回 pin では advisory の確認を省いていた。後から確認した結果を以下に記録する。

**この記事執筆時点（2026年6月）での確認結果であり、時点によって状況は変わる。実際に運用する環境では自分のリポジトリで改めて確認すること。**

| 確認対象 | pin した version / SHA | 確認結果 |
|---|---|---|
| `github/codeql-action` | v4.36.2 | 過去に GHSA があるが、v4.36.2 は affected range 外 |
| `aquasecurity/trivy-action` | v0.36.0（SHA: `ed142fd0...`） | GHSA-69fq-xp46-6x23 の affected range（v0.35.0 より前）の外 |
| `trivy-action` 内の `setup-trivy` | `aquasecurity/setup-trivy@3fb12ec12f41e471780db15c232d5dd185dcb514 # v0.2.6` | patched version。transitive action の SHA も確認できる |
| Trivy CLI（`trivy-action` の default） | v0.70.0 相当 | インシデントで affected とされた v0.69.4 とは別 |
| SHA と `# vX.Y.Z` コメントの一致 | 全 Tier B action | 逆引きで一致を確認済み |

**repo 設定の確認：Dependabot alerts が機能する前提条件**

確認の過程で重要な気づきがあった。terraform-hannibal では API 上で vulnerability alerts（Dependabot alerts）が disabled になっていた。

```bash
$ gh api repos/kmryst/terraform-hannibal/vulnerability-alerts -i
HTTP/2.0 404 Not Found   # 404 = disabled
```

2-tier の設計では「Tier A は Dependabot alerts を維持する」としている。しかし参照形式を `@vX.Y.Z` にするだけでは不十分だ。**repo の vulnerability alerts 設定が有効でないと alerts は届かない**。設計と repo 設定が噛み合っていなかった。

Dependabot alerts を Tier A の補完として機能させる場合は、repo の Settings > Code security and analysis で「Dependabot alerts」が有効かを確認すること。参照形式の設計だけで判断せず、repo 側の設定も合わせて確認する必要がある。

## 実装結果

**Tier A（semver patch tag）**

```yaml
- uses: actions/checkout@v6.0.3
- uses: actions/setup-node@v6.4.0
- uses: actions/upload-artifact@v7.0.1
- uses: github/codeql-action/init@v4.36.2
```

**Tier B（SHA pin + inline comment）**

```yaml
- uses: aws-actions/configure-aws-credentials@e7f100cf4c008499ea8adda475de1042d6975c7b # v6.2.0
- uses: hashicorp/setup-terraform@dfe3c3f87815947d99a8997f908cb6525fc44e9e # v4.0.1
- uses: aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25 # v0.36.0
- uses: docker/setup-buildx-action@d7f5e7f509e45cec5c76c4d5afdd7de93d0b3df5 # v4.1.0
- uses: docker/build-push-action@f9f3042f7e2789586610d6e8b85c8f03e5195baf # v7.2.0
- uses: aws-actions/amazon-ecr-login@fa648b43de3d4d023bcb3f89ed6940096949c419 # v2.1.5
- uses: terraform-linters/setup-tflint@b480b8fcdaa6f2c577f8e4fa799e89e756bb7c93 # v6.2.2
- uses: micnncim/action-label-syncer@3abd5ab72fda571e69fffd97bd4e0033dd5f495c # v1.3.0
```

`dependabot.yml` には groups を追加して、更新 PR が action ごとに分裂しないようにした。

```yaml
    open-pull-requests-limit: 5
    groups:
      github-actions:
        patterns:
          - "*"
```

`open-pull-requests-limit: 5` は GitHub のデフォルト値と同じだ。「方針として明示する」意図で書いており、動作の変化はない。

## まとめ

前回記事で「PR の diff が SHA の羅列になる」として不採用にした判断は、`@<sha> # vX.Y.Z` 形式と Dependabot の inline comment 同時更新という情報で更新できた。

2-tier の判断軸はシンプルだ。「GitHub-owned かどうか」で「semver tag のリスクを受容して alerts を維持するか」「改ざん耐性を取るか」を切り分ける。ただしこの設計が機能するには、参照形式だけでなく repo の vulnerability alerts 設定も有効である必要がある。

pin と upgrade は別操作として分離する。floating tag が今指す commit を起点に pin する。ただし pin 前に advisory を確認するのが本来の手順だ。今の参照先を確認せずに pin しても、その参照先が安全である保証はない。SHA pin は固定であって浄化ではない。

trivy-action 2026年3月のインシデントは、大手ベンダーの action も攻撃対象になること、そして semver tag は可変参照であることを実際の事案で示した。SHA pin が完全な解決策ではないが、semver tag より改ざんに強いという実証が得られた。

---

## 参考

- [GitHub Docs — Security hardening for GitHub Actions](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions)
- [aquasecurity/trivy discussions #10425 — Security Incident 2026-03-19](https://github.com/aquasecurity/trivy/discussions/10425)
- [GHSA-69fq-xp46-6x23 — trivy-action security advisory](https://github.com/advisories/GHSA-69fq-xp46-6x23)
- [GitHub Actions のコミットハッシュ指定（ピン留め）を Dependabot で自動的に更新する — kakakakakku.hatenablog.com](https://kakakakakku.hatenablog.com/entry/2026/03/24/123518)
- [pinact — suzuki-shunsuke/pinact](https://github.com/suzuki-shunsuke/pinact)（workflow ファイル内の `uses:` を自動的に SHA pin 形式に変換するツール）
