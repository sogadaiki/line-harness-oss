# Supabase Custom OAuth/OIDC + LINE Login 連携ガイド

> LINE Harness は Cloudflare D1 + 独自認証を標準構成としていますが、Supabase をデータベースやユーザー認証基盤として併用するケースもあります。本ガイドでは Supabase の Custom OAuth/OIDC Providers を使って LINE Login を統合する手順を解説します。

## 背景

Supabase に Custom OAuth/OIDC Providers が導入され、公式 Provider 以外の OIDC プロバイダーを自由に設定できるようになりました。これにより Auth0 等の外部認証サービスを経由せず、Supabase から直接 LINE Login を利用可能です。

## 注意: 署名アルゴリズムの不一致

LINE Login と Supabase Custom OIDC の間に署名アルゴリズムの不一致があります。

| 環境 | 署名アルゴリズム |
|------|----------------|
| LINE Login (ネイティブアプリ / LINE SDK / LIFF) | **ES256** |
| LINE Login (Webログイン) | **HS256** |
| Supabase Custom OAuth/OIDC | **ES256 のみ** |

Web ログインで OIDC を使おうとすると、署名アルゴリズムの不一致で認証が失敗します。

### 解決策: Manual Configuration

Auto Discovery（`.well-known/openid-configuration` からの自動取得）ではなく、**Manual Configuration** で各エンドポイントを手動設定します。

## セットアップ手順

### 1. LINE Developers Console

LINE Login チャネルが未作成の場合は [Getting-Started.md](Getting-Started.md) のセクション 1.2 を参照して作成してください。

### 2. Supabase Dashboard で Custom Provider 追加

Supabase Dashboard → Authentication → Providers → Add Custom Provider

Configuration Method: **Manual configuration** を選択し、以下を入力:

| 項目 | 値 |
|------|-----|
| Provider ID | `line`（任意の識別名） |
| Client ID | LINE Login チャネルの Channel ID |
| Client Secret | LINE Login チャネルの Channel Secret |
| Issuer URL | `https://access.line.me` |
| Authorization URL | `https://access.line.me/oauth2/v2.1/authorize` |
| Token URL | `https://api.line.me/oauth2/v2.1/token` |
| Userinfo URL | `https://api.line.me/oauth2/v2.1/userinfo` |
| JWKS URI | **空欄のまま**（Issuer URL を入れると自動入力される場合があるが削除） |
| Scopes | `profile openid`（必要に応じて `email` を追加） |
| Allow users without email | **ON** |

> **Allow users without email を ON にする理由**: LINE はメールアドレス未登録のユーザーが多いため、OFF のままだとメール未登録ユーザーの認証が失敗します。

### 3. Callback URL の設定

Supabase が発行する Callback URL を LINE Developers Console に登録:

1. Supabase Dashboard で表示される Callback URL をコピー
   - 形式: `https://<project-ref>.supabase.co/auth/v1/callback`
2. LINE Developers Console → LINE Login チャネル → LINE Login 設定
3. Callback URL に上記を追加

### 4. クライアント側の実装

```typescript
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

// LINE Login 開始
const { data, error } = await supabase.auth.signInWithOAuth({
  provider: 'line',  // Provider ID と一致させる
  options: {
    redirectTo: 'https://your-app.com/callback',
    scopes: 'profile openid',
  },
})
```

### 5. LINE Harness との連携

Supabase Auth で取得した LINE ユーザー情報を LINE Harness の `users` テーブルと紐づける:

```typescript
// Supabase Auth のセッションから LINE プロフィールを取得
const { data: { user } } = await supabase.auth.getUser()
const lineUserId = user?.user_metadata?.sub  // LINE の userId

// LINE Harness API で友だち情報と紐づけ
await fetch(`${LINE_HARNESS_API}/api/friends/by-line-uid/${lineUserId}`, {
  headers: { 'X-API-Key': API_KEY },
})
```

## 将来的な改善

Supabase が HS256 署名アルゴリズムに対応した場合、Auto Discovery（Issuer URL のみ指定）で設定が簡略化される可能性があります。進捗は以下で確認:

- [supabase/auth#2236](https://github.com/supabase/auth/pull/2236) — LINE Login 対応 PR（未マージ）

## トラブルシューティング

| 症状 | 原因 | 対処 |
|------|------|------|
| OIDC 認証エラー（署名検証失敗） | Auto Discovery で JWKS URI が自動設定されている | Manual Configuration に切り替え、JWKS URI を空欄に |
| メール未登録ユーザーが認証失敗 | Allow users without email が OFF | ON に変更 |
| Callback URL エラー | LINE Developers Console に Supabase の Callback URL が未登録 | `https://<ref>.supabase.co/auth/v1/callback` を追加 |
| `user_metadata` に LINE 情報がない | Scopes に `profile openid` が含まれていない | Scopes を確認 |

## 参考

- [Supabase Custom OAuth/OIDC Providers ドキュメント](https://supabase.com/docs/guides/auth/social-login/auth-custom-oidc)
- [LINE Login v2.1 API リファレンス](https://developers.line.biz/ja/reference/line-login/)
- 出典: SasaTech 佐々木氏, Zenn, 2026-03-31
