---
title: "仮タイトル"
emoji: "🔒"
type: "tech"
topics: ["githubactions", "dependabot", "cicd", "devops", "security"]
published: false
---

## 対象読者

前回記事（Dependabotに任せよ？）を読んでいる、または GitHub Actions の action バージョン管理方針を検討している人。SHA pin の可読性問題が気になって踏み切れていない人。

## 先に結論

- `uses: owner/action@<sha> # vX.Y.Z` 形式なら Dependabot が SHA と同一行コメントを同時に更新してくれる。「diff が SHA の羅列で読めない」という前回の不採用理由は、この形式を知らなかったことが原因だった
- GitHub-owned（`actions/*`, `github/codeql-action/*`）は `@vX.Y.Z`、それ以外は `@<sha> # vX.Y.Z` の 2-tier で整理すると、Dependabot alerts の維持と改ざん耐性をアクション種別で分担できる
- pin 先は「floating major tag（`@vX`）が今この瞬間に指している commit」が起点。最新版への更新ではなく、pin と upgrade を別操作として分離する

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

2026年3月19日、`aquasecurity/trivy-action` に悪意ある releases が公開された。攻撃者は漏洩した credentials を使い、GHCR・ECR Public・Docker Hub 上のイメージを差し替えた。CI 上で SSH keys・cloud credentials・Kubernetes tokens などを窃取するマルウェアが実行される状態が約12時間続いた。

**フローティングタグ（`@v0` など）や semver tag（`@v0.35.0` 以前）で参照していたワークフローが影響を受けた。`@<commit-sha>` でピン留めしていたユーザーは影響を受けなかった。**

terraform-hannibal のワークフローでは `aquasecurity/trivy-action` を security scan で使っていた。このとき `@v0.36.0` の semver tag 指定だった。タグが差し替えられていた場合、その時間帯に CI が走れば悪性コードが実行されていた。

SHA pin はサプライチェーン攻撃に対して「理論的なリスク軽減策」ではなく、「実害を防いだ対策」だという実証があった。

## 2-tier 方針の設計

可読性の問題が解消し、実害事例もある。ただし「全 action を SHA pin する」という選択肢は採らなかった。

検討した選択肢と判断：

| 選択肢 | 問題点 |
|---|---|
| 全 action を `@vX` のまま | 実行内容がサイレントに変わる |
| 全 action を `@vX.Y.Z` に固定 | semver tag も可変参照。改ざん耐性は上がらない |
| 全 action を SHA pin | GitHub-owned の Dependabot alerts も失う |
| **GitHub-owned / 非 GitHub-owned で 2-tier（採択）** | alerts 維持と改ざん耐性を分担できる |

採択した方針：

- **Tier A（`actions/*`, `github/codeql-action/*`）**：`@vX.Y.Z` に固定。Dependabot alerts と security updates を維持する
- **Tier B（それ以外の全外部 action）**：`@<sha> # vX.Y.Z` に固定。改ざん耐性を優先する

GitHub-owned actions は GitHub Actions platform に近い trust boundary として扱える。改ざん確率が相対的に低く、CodeQL を含め Dependabot alerts の価値が高い。一方、AWS・Docker・HashiCorp などの外部 action は、大手ベンダーであっても自リポジトリから見れば外部依存だ。trivy-action のインシデントが示すように、大手 org が攻撃対象にならないという前提は成立しない。

「GitHub-owned かどうか」という単純なルールで分けることで、action を追加するときの判断軸がブレない。

不採用にした「全 action を SHA pin」について補足すると、GitHub-owned の Dependabot alerts（特に CodeQL の脆弱性通知）まで捨てるのは過剰と判断した。Tier A は「実行内容の変化を PR の diff として可視化すること」と「alerts の維持」を目的に置く。immutable 参照が必要な改ざん耐性は Tier B の SHA pin が担う、という役割分担にした。

## 実装：floating tag 起点で pin 先を決める

SHA pin の実装で最初に迷ったのが「どの SHA を使うか」だった。

「最新 patch version に上げておく」という考え方は pin と upgrade を混同している。pin の目的は「今動いている状態を固定すること」だ。`@vX` で動いていたワークフローは今この瞬間に `@vX` が指す commit で動いている。その commit に pin すれば、確実に動くことが証明された状態で固定できる。未知の patch バージョンへの更新は Dependabot に任せる別の操作として分離する。

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
  | grep e7f100cf
```

`refs/tags/v6.2.0` が見つかれば、こう書く。

```yaml
- uses: aws-actions/configure-aws-credentials@e7f100cf4c008499ea8adda475de1042d6975c7b # v6.2.0
```

### near-miss：annotated tag の SHA を間違えた

`github/codeql-action`（Tier A）の固定で最初に間違えた。

「最新の patch は v4.36.0 だろう」と決め打ちして `@v4.36.0` と書いた。`git ls-remote` で実際に確認すると、`@v4` が指していたのは `v4.36.2` だった。floating tag が指すバージョンと「最新版」は一致しない。この確認を省くと、pin と実態がズレる。

加えて `github/codeql-action` の `@v4` は annotated tag だった。`git ls-remote` が2行返してきたとき、tag object SHA（上の行）を使って `uses:` に書いていた。action は動かなかった。`^{}` 行の commit SHA を使う必要がある。

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

前回記事で「PR の diff が SHA の羅列になる」として不採用にした判断は、`@<sha> # vX.Y.Z` 形式と Dependabot の inline comment 同時更新という情報で更新できた。判断変更のきっかけはコメントだった。設計判断を記事として公開することは、それ自体がレビューの機会になる。

2-tier の判断軸はシンプルだ。「GitHub-owned かどうか」で Dependabot alerts を維持するか改ざん耐性を優先するかを切り分ける。このルールで action を追加するときの判断がブレなくなる。

trivy-action 2026年3月のインシデントは「SHA pin が実害を防いだ」という実証だ。大手ベンダーの action を使っていれば安全、という前提は成立しない。supply chain のリスクを「理論的に存在する」ではなく「実際に起きる」として扱う根拠になっている。

pin と upgrade は別操作として分離する。floating tag が今指す commit に pin する。その後の更新は Dependabot に任せる。この順序が崩れると、pin の意味がなくなる。

---

## 参考

- [GitHub Docs — Keeping your GitHub Actions and workflows secure Part 1: Preventing pwn requests](https://securitylab.github.com/resources/github-actions-preventing-pwn-requests/)
- [GitHub Docs — Security hardening for GitHub Actions](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions)
- [aquasecurity/trivy discussions #10425 — Security Incident 2026-03-19](https://github.com/aquasecurity/trivy/discussions/10425)
- [GitHub Actions のコミットハッシュ指定（ピン留め）を Dependabot で自動的に更新する — kakakakakku.hatenablog.com](https://kakakakakku.hatenablog.com/entry/2026/03/24/123518)
- [pinact — suzuki-shunsuke/pinact](https://github.com/suzuki-shunsuke/pinact)（workflow ファイル内の `uses:` を自動的に SHA pin 形式に変換するツール）
