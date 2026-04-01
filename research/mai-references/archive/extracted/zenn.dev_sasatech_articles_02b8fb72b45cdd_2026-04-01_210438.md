---
source: zenn.dev
type: generic
url: https://zenn.dev/sasatech/articles/02b8fb72b45cdd
extracted_at: 2026-04-01T12:04:38.380Z
published_at: 2026-03-31T06:46:10+00:00
---

# SupabaseにCustom OAuth/OIDC Providersが導入されたぞ！LINEログインを導入するぞ！

[SasaTech Engineer Blog](https://zenn.dev/p/sasatech)[Publicationへの投稿](https://zenn.dev/faq/what-is-publication)🐙

# SupabaseにCustom OAuth/OIDC Providersが導入されたぞ！LINEログインを導入するぞ！

![image](../images/zenn.dev_sasatech_articles_02b8fb72b45cdd_2026-04-01_210438/img_001.jpg)

[Ryuki Sasaki](https://zenn.dev/sasatech_sasaki)2026/03/31に公開[LINE](https://zenn.dev/topics/line)[Supabase](https://zenn.dev/topics/supabase)[tech](https://zenn.dev/tech-or-idea)

こんにちは。株式会社SasaTechの佐々木です。

SasaTechは、SupabaseとVercelをインフラとしたWEBアプリケーションの開発を得意としています。

Supabaseで、Custom OAuth/OIDC Providersが導入されました🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉

いままでのSupabaseは、OAuth / OIDCは、Supabaseが公式で提供しているProviderしか使用出来ませんでしたが、自由にProviderを設定することが出来るようになり、Auth0等に認証認可を逃す必要がなくなりました。

今回は、Custom OAuth/OIDC Providersを使用して、LINEログインを導入する際にハマったポイントと、解消方法を記載します。

## 供養

SupabaseにPRを送っていたけど、Supabaseチームに反応されなかったのでここに供養します🪦
[https://github.com/supabase/auth/pull/2236](https://github.com/supabase/auth/pull/2236)

## 前提

Supabaseの環境や、LINEログインに必要な情報を取得していることを前提とします。

## ⚠️ SupabaseとLINEログインのOIDCの署名アルゴリズムが違う

LINEログインの署名アルゴリズムは、ネイティブアプリ / LINE SDK / LIFFでは、**ES256**、Webログインでは、**HS256**に対応しています。

一方、SupabaseのCustom OAuth/OIDC Providersが対応している署名アルゴリズムは、**ES256**のみです。

そのため、LINEログインを使用したOIDCを使用しようとすると、署名アルゴリズムが違うため、OIDCが失敗します。

## 解決策

Configuration Methodを「Manual configuration」で登録します。

項目値Issuer URL`https://access.line.me`Authorization URL`https://access.line.me/oauth2/v2.1/authorize`Token URL`https://api.line.me/oauth2/v2.1/token`Userinfo URL`https://api.line.me/oauth2/v2.1/userinfo`JWKS URI未入力（Issuer URL を入れると自動入力される想定）Scopesお好みでAllow users without emailON（LINE はメール未登録のユーザーもいるため）

![image](../images/zenn.dev_sasatech_articles_02b8fb72b45cdd_2026-04-01_210438/img_002.png)

![SasaTech Engineer Blog](../images/zenn.dev_sasatech_articles_02b8fb72b45cdd_2026-04-01_210438/img_003.jpg)

[SasaTech Engineer Blog](https://zenn.dev/p/sasatech)[Publication](https://zenn.dev/faq/what-is-publication)

SasaTechは節度ある革新を掲げるテクノロジーサービス企業です。
事業内容 → コンサルティング事業 / WEBアプリケーション開発事業 / SES事業

フォロー

### Discussion

![image](../images/zenn.dev_sasatech_articles_02b8fb72b45cdd_2026-04-01_210438/img_004.png)

ログインするとコメントできますLogin

---

## Images (local paths)

- ../images/zenn.dev_sasatech_articles_02b8fb72b45cdd_2026-04-01_210438/img_001.jpg
- ../images/zenn.dev_sasatech_articles_02b8fb72b45cdd_2026-04-01_210438/img_002.png
- ../images/zenn.dev_sasatech_articles_02b8fb72b45cdd_2026-04-01_210438/img_003.jpg
- ../images/zenn.dev_sasatech_articles_02b8fb72b45cdd_2026-04-01_210438/img_004.png
