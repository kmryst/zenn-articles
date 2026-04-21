---
title: "TerraformのPR失敗をpre-commitで手前に寄せた：fmt/tflint/gitleaksの品質ゲート"
emoji: "🚧"
type: "tech"
topics: ["terraform", "precommit", "tflint", "gitleaks", "githubactions"]
published: false
---

## 対象読者

- Terraform を触っていて、PR を出してから `fmt` や `lint` で落ちる手戻りがつらい人
- 「CI はあるがローカルが弱い」と言われがちな構成を、**仕組みで改善したい**人
- 秘密情報（トークン/キー）の混入を、コミット前に止めたい人

## 先に結論

- `pre-commit` を使うと、`git commit` の直前に **Terraform の整形（fmt）・lint（tflint）・秘密検知（gitleaks）**を自動実行できます
- ローカルに品質ゲートを置くことで、**PR を赤くする前に落とせる**ようになります
- ただし gitleaks は **作業ツリー全体のスキャンと staged 差分のスキャンで挙動が違う**ため、最終防衛線は CI で `gitleaks git` もしくは GitHub Action を回すのが堅いです（後述）

:::message
この記事は「作業ログ」ではなく、**詰まった点（gitleaks）と、捨てた選択肢**まで含めて判断材料を残します。
:::

## なぜローカル品質ゲートが必要だったか

CI（GitHub Actions）で `terraform fmt -check` や `tflint` を回すのは正しい一方で、次の痛みがありました。

- PR を出してから落ちるので、手戻りが遅い
- 「ローカルでは気づけたはずのミス」が CI を赤くしてしまう
- 秘密情報の混入は、**リモートに出る前**に止めたい

そこで「コミットの直前」を関所にして、**落とすべきものを落とす**ようにしました。

## 用語の整理（最小限）

- **Git hook**: `git commit` など特定タイミングで自動実行されるスクリプト
- **pre-commit**: hook を管理して、複数チェックをまとめて実行する仕組み
- **品質ゲート**: これを通らないと先に進めない関所（ここでは「コミットできない」）

## やったこと（最終形）

### 追加したファイル

- `.pre-commit-config.yaml`（pre-commit の設定）
- `.tflint.hcl`（tflint の設定）
- `.gitleaks.toml`（gitleaks の設定。既存なら修正点あり）

### `.pre-commit-config.yaml`

ポイントは以下です。

- `terraform fmt` は **自動修正**（`-write=true`）に寄せる
- `tflint` と `gitleaks` は **落ちたらコミットを止める**
- `tflint` は `.tflint.hcl` を明示的に参照する

```yaml
repos:
  - repo: https://github.com/antonbabenko/pre-commit-terraform
    rev: v1.99.4
    hooks:
      - id: terraform_fmt
        args:
          - --args=-diff
          - --args=-write=true
      - id: terraform_tflint
        args:
          - --args=--config=__GIT_WORKING_DIR__/.tflint.hcl

  - repo: https://github.com/gitleaks/gitleaks
    rev: v8.30.1
    hooks:
      - id: gitleaks
```

### `.tflint.hcl`

AWS の ruleset を入れた上で、今回は **ローカルモジュール運用ではノイズになったルール**を無効化しました。

このリポジトリでは、root module から呼ぶ child module にも `terraform_required_version` / `terraform_required_providers` が出ていました。すべてのローカルモジュールに同じ定義を強制すると、今回の目的である「コミット前に直すべきものを素早く見つける」にはノイズが増えます。

ただし、Terraform 公式では各 module が provider requirements を宣言する前提です。再利用する shared module では、`required_providers` を明示するほうが安全です。今回は **ローカルモジュール運用でのノイズ削減**を優先して、この2ルールを無効化しました。

```hcl
plugin "aws" {
  enabled = true
  version = "0.40.0"
  source  = "github.com/terraform-linters/tflint-ruleset-aws"
}

config {
  call_module_type = "local"
}

rule "terraform_required_version" {
  enabled = false
}

rule "terraform_required_providers" {
  enabled = false
}
```

### `.gitleaks.toml`（詰まった点）

gitleaks は v8.25.0 以降で、global allowlist の書き方が `[allowlist]` から `[[allowlists]]` に変わっています。最初に古い書き方を置くとエラーになります。

- NG（例）: `[allowlists] files = [...]`
- OK: `[[allowlists]] paths = [...]` のように **配列で定義**し、`paths/regexes/commits/stopwords` のいずれかを必ず指定する

```toml
[[allowlists]]
description = "dist成果物は検査対象外"
paths = [
  '''client/dist/assets/.*''',
]
```

## 使い方

### 初回だけやること

事前に、少なくとも `pre-commit`、`terraform`、`tflint` がローカルで実行できる状態にしておきます。

```bash
pre-commit --version
terraform version
tflint --version
```

`pre-commit install` で hook を登録します。

```bash
pre-commit install
```

これで `.git/hooks/pre-commit` が作られ、`git commit` 時に自動実行されます。

### 手動で全チェックしたいとき

```bash
pre-commit run --all-files
```

## 検証（正常系・異常系）

### 正常系

`pre-commit run --all-files` がすべて `Passed` になることを確認しました。

```text
Terraform fmt............................................................Passed
Terraform validate with tflint............................................Passed
Detect hardcoded secrets..................................................Passed
```

### 異常系（ここが重要）

#### 1. terraform fmt は「落とす」より「直す」

整形が崩れている `.tf` を用意すると、`terraform fmt` は **自動修正して Passed** になります。

- 良い点: 整形の議論が減る（人間が直さなくていい）
- 注意点: 直されたファイルは再 `git add` が必要（コミットは一度止まる）

#### 2. tflint はちゃんと止める

未使用の `variable` / `local` を意図的に作ると、`terraform_unused_declarations` で `Failed` になりコミットを止められます。

#### 3. gitleaks は「全体スキャンでは落ちるが、staged 差分だと落ちない」ケースがあった

ここがいちばん詰まったポイントです。

- `gitleaks dir`（作業ツリー上のファイルを直接スキャン）では **leak を検知**できる
- しかし pre-commit hook 経由では `gitleaks git --pre-commit --staged` 相当の差分検査になり、**スルー**するケースがありました

:::message alert
「ローカルの pre-commit だけで secrets を完全に防ぐ」は、スキャン対象の差分で穴が空く可能性があります。
:::

## 捨てた選択肢と理由

### 捨てた案: 「ローカルだけで secrets を完結させる」

- ねらい: リモートに出る前に全部止める
- 捨てた理由: staged 差分の検査だけだと、ローカルだけでは **見逃しが残る**可能性がある

## 最終的な落とし所（恒久策）

- ローカルは **fmt/tflint を強く**して、手戻りを最小化する
- secrets はローカルでも見るが、**最終防衛線は CI で `gitleaks git` もしくは GitHub Action を回す**（ここは次の改善）

## 学び

- 品質ゲートは CI だけでなく、**コミット前に置ける**。手戻りの体感が変わる
- `terraform fmt` は「落とす」より「直す」に寄せると運用が楽
- secrets 検知は **スキャン対象の差分**を理解して設計しないと、安心を買い損ねる

## 今後の改善（今回のスコープ外）

- GitHub Actions に `gitleaks git` もしくは `gitleaks/gitleaks-action` を追加して、**リモート側でも確実に止める**
- `checkov` を追加して IaC のセキュリティルールを増やす（ただしローカル実行は重いので、CI 優先でもよい）
- `pre-commit` の導入手順（PATH、初回セットアップ）を README に明記して、再現性を上げる

## 参考資料

- [pre-commit-terraform](https://github.com/antonbabenko/pre-commit-terraform)
- [Gitleaks](https://github.com/gitleaks/gitleaks)
- [Terraform: Provider Requirements](https://developer.hashicorp.com/terraform/language/providers/requirements)
- [Terraform: Providers Within Modules](https://developer.hashicorp.com/terraform/language/modules/develop/providers)
