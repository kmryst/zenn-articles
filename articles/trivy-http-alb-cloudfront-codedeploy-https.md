---
title: "Trivy の HTTP 検出で整理する ALB・CloudFront・CodeDeploy の HTTPS 設計判断"
emoji: "🔒"
type: "tech"
topics: ["terraform", "aws", "cloudfront", "codedeploy", "iac"]
published: true
---

## はじめに

ポートフォリオ用 AWS 構成に Trivy Config（IaC セキュリティスキャン）を導入したところ、ALB listener と CloudFront origin の HTTP 設定が検出されました。初期構築時は Blue/Green の動作確認を優先していたため、外部公開フェーズで見直しが必要な箇所として残っていました。

この記事では、ALB / CloudFront / CodeDeploy 構成で Trivy の HTTP 検出に対応するときの**設計判断の軸**と**見落としやすい連鎖変更**を整理します。

**対象読者:** Terraform で ALB + CloudFront + CodeDeploy Blue/Green を構築している、またはこれから構築するエンジニア。

:::message
動作確認は Terraform 1.12.1 / AWS provider 5.x で行っています（2026年5月時点）。
:::

---

## 運用コンテキスト

| 項目 | 内容 |
|---|---|
| 規模 | 個人開発（1人） |
| 対象環境 | dev（deploy/destroy で管理。常時稼働なし） |
| 実行者 | GitHub Actions（OIDC → IAM Role assume） |
| 変更失敗時 | destroy → deploy で再構築可能 |
| 権限境界 | Permission Boundary 付き IAM Role |

**通信経路:**

```
ユーザー
  ↓ HTTP → ALB (port 80) → 301 redirect → HTTPS
  ↓ HTTPS
CloudFront
  ↓ Before: HTTP (http-only)
  ↓ After:  HTTPS (https-only)
ALB
  ↓ HTTP
ECS Service

CodeDeploy:
- production traffic route: ALB 443 listener
- test traffic route:       ALB 8080 listener (HTTPS)
```

リソース単位ではなく「誰から誰への通信か」で考えると、どこを HTTPS 化すべきかが整理しやすくなります。

---

## 先に結論

### 判断フロー

- 外部ユーザーが直接入る HTTP か → **redirect**
- CloudFront / ALB / ECS / CodeDeploy 間の通信か → **原則 HTTPS 化**
- テスト経路だが本番相当の通信を流すか → **HTTPS 化**
- HTTPS 化の前提リソースが揃っているか → カスタムドメイン・ACM 証明書・Route53 alias・listener ARN を確認
- コスト・dev 環境・短時間稼働などの制約が大きいか → **accepted risk として記録**

### 変更前後

| 箇所 | Before | After | 判断 |
|---|---|---|---|
| ALB port 80（HTTP listener） | HTTP で target group へ forward | HTTPS への redirect 専用に変更（forwarding rule 削除） | redirect |
| ALB port 8080（テスト） | HTTP | HTTPS（同一証明書） | HTTPS 化 |
| CloudFront API origin | http-only / ALB DNS 直接 | https-only / カスタムドメイン | HTTPS 化 |
| Route53 | API alias なし | API サブドメイン → ALB alias 追加 | https-only の前提条件 |
| CodeDeploy prod route | HTTP listener ARN | HTTPS 443 listener ARN | redirect の連鎖変更 |

---

## 各箇所の判断と実装

### ALB port 80 → redirect

外部ユーザーが `http://` でアクセスしてきたときに 301 で `https://` へ転送します。port 80 はアプリケーションへ forward する入口ではなく、HTTPS URL へ再アクセスさせるための redirect 専用 listener として扱います。

```hcl
# Before
default_action {
  type = "fixed-response"
  fixed_response {
    content_type = "text/plain"
    message_body = "Not Found"
    status_code  = "404"
  }
}

# After
default_action {
  type = "redirect"
  redirect {
    port        = "443"
    protocol    = "HTTPS"
    status_code = "HTTP_301"
  }
}
```

### ALB port 8080（テスト） → HTTPS

CodeDeploy Blue/Green のテストトラフィックが通る経路です。本番（443）を HTTPS 化するなら、テスト経路にも平文通信を残さない方が一貫性があります。証明書 ARN を複数の listener で参照するため `locals` で切り出します。

```hcl
locals {
  alb_certificate_arn = "arn:aws:acm:ap-northeast-1:xxxxxxxxxxxx:certificate/..."
}

resource "aws_lb_listener" "test" {
  port            = 8080
  protocol        = "HTTPS"
  ssl_policy      = "ELBSecurityPolicy-TLS-1-2-2017-01"
  certificate_arn = local.alb_certificate_arn
  ...
}
```

### CloudFront API origin → https-only

`origin_protocol_policy = "https-only"` に変えるだけでは不十分です。`domain_name` に ALB の DNS 名（`xxx.ap-northeast-1.elb.amazonaws.com`）を指定したままだと、CloudFront が HTTPS で origin に接続する際、origin に指定したホスト名と ALB listener に設定した ACM 証明書の名前が一致せず、TLS エラーになります。

**対応:** ACM 証明書を紐付けたカスタムドメイン（`api.example.com`）を origin に指定し、Route53 alias でそのドメインを ALB に向けます。カスタムドメイン・ACM 証明書・Route53 alias・ALB HTTPS listener の4つをセットで設計する必要があります。

```hcl
# Before
origin {
  domain_name = var.api_alb_dns_name       # ALB DNS 名を直接指定
  custom_origin_config {
    origin_protocol_policy = "http-only"
  }
}

# After
origin {
  domain_name = var.api_origin_domain_name  # カスタムドメインに変更
  custom_origin_config {
    origin_protocol_policy = "https-only"
  }
}
```

```hcl
# Route53: カスタムドメイン → ALB alias（https-only の前提条件）
resource "aws_route53_record" "api" {
  count   = var.api_domain_name != "" ? 1 : 0
  zone_id = var.hosted_zone_id
  name    = var.api_domain_name
  type    = "A"
  alias {
    name                   = var.api_alb_dns_name
    zone_id                = var.api_alb_zone_id
    evaluate_target_health = false
  }
}
```

### WAF・public ALB → accepted risk

WAF はコスト（月額固定費）を考慮して別途判断します。public ALB については直接アクセスの制限は別途検討対象ですが、今回は dev 環境・短時間稼働の前提で accepted risk として記録します（本番相当では CloudFront managed prefix list を使った Security Group 制限などを検討してください）。

---

## 見落としやすい連鎖変更

### port 80 を redirect にすると CodeDeploy prod route も変える必要がある

変更前、CodeDeploy の `prod_traffic_route` は port 80（HTTP）の listener ARN を参照していました。port 80 を redirect に変えると application traffic が届かなくなり、Blue/Green が機能しません。

```hcl
# Before: HTTP listener（port 80）を参照
prod_traffic_route {
  listener_arns = [var.alb_listener_http_arn]
}

# After: HTTPS listener（port 443）を参照
prod_traffic_route {
  listener_arns = [var.alb_listener_production_arn]
}
```

変数名も `alb_listener_http_arn`（プロトコル指定）→ `alb_listener_production_arn`（役割指定）に変更しています。プロトコル名を変数名に含めると HTTP → HTTPS のような変更で意味が崩れるため、CodeDeploy から見た役割で命名した方が保守しやすくなります。ECS module も同じ変数を参照しているため、横断して確認が必要です。

### redirect listener の forwarding rule は削除が必要

変更前の port 80 には、default_action に加えて Blue/Green へ forwarding する listener rule（`aws_lb_listener_rule.production_http`）が存在していました。port 80 を redirect に変えた時点でこの rule は不要です。redirect が先に適用されるため rule は動作せず、Terraform の state にも残るため明示的に削除します。

```hcl
# 削除する resource
resource "aws_lb_listener_rule" "production_http" {
  listener_arn = aws_lb_listener.http.arn
  action { type = "forward" ... }  # redirect listener には不要
}
```

:::message alert
**避けたい対応**
- ALB port 80 を redirect にしただけで終わる → CodeDeploy が port 80 listener を参照していると traffic が届かなくなる
- CloudFront origin を https-only にするだけで終わる → ALB DNS 名と証明書名が一致せず SSL エラーになる
- Trivy を黙らせるためだけに `#trivy:ignore` を付ける → 通信経路ごとの判断が残らない
:::

---

## 検証

deploy → 疎通確認 → CodeDeploy Blue/Green → destroy の順で確認しました。

| 確認項目 | 結果 |
|---|---|
| `curl -sI http://example.com` → 301 Moved Permanently | ✅ |
| `curl -X POST https://example.com/graphql` → 200 OK | ✅ |
| CodeDeploy prod route が HTTPS 443 listener を参照 | ✅ |
| Blue/Green deployment Succeeded | ✅ |

---

## 残課題と accepted risk

| 検出項目 | 判断 | 理由 |
|---|---|---|
| WAF 未設定 | accepted risk | 月額固定費が発生するため別途判断 |
| public ALB | accepted risk | dev 環境のため今回は許容。本番相当では CloudFront 経由に制限する SG 設計を検討 |
| security group egress | accepted risk | アーキテクチャ上の制約 |

accepted risk は「放置」ではなく、**理由・影響範囲・再検討条件を記録して管理する**という扱いです。今回は個人開発 / dev / 短時間稼働 / destroy 可能という前提での判断です。本番環境・顧客データを扱う環境・常時公開環境では同じ判断をそのまま適用しないでください。

---

## おわりに

- **外部入口は redirect、内部通信は HTTPS 化**が基本の判断軸
- **CloudFront https-only はカスタムドメイン + Route53 alias が前提条件**。ALB DNS 直接は SNI ミスマッチで繋がらない
- **port 80 を redirect にすると CodeDeploy prod route も連鎖して変わる**。同じ listener ARN を参照するモジュールを横断して確認する

Trivy の出力を「通過か失敗か」だけで見るのではなく、各検出を設計判断の起点として扱う運用が有効です。
