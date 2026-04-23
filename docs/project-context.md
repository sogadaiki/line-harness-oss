# Project Context

## Product

LINE Harness は、LINE公式アカウント向けの OSS CRM / marketing automation runtime です。

repo には次の 3 層があります。

- `apps/worker`: Cloudflare Worker / Hono API / webhook receiver
- `apps/web`: Next.js 管理画面
- `packages/*`: DB, SDK, shared types, LINE SDK

## Current Operating Shape

この fork は upstream OSS の mirror ではなく、`sadame/local-customizations` branch 上で実運用も抱えています。

重要な前提:

- primary traffic receiver は `line-crm-worker`
- `hinatama-line-worker` は tenant-scoped variant
- 複数 LINE アカウントを 1 runtime / 1 D1 で運用している
- `sadame`, `hinatama`, `shusei` など複数 tenant が live

## Stakeholders

- Shudesu / upstream maintainer
  - OSS 本家
  - public docs / OSS sync の起点
- 曽我さん / sadame
  - fork 側の運用と顧客連携
- パダワン（ヒナタマ）
  - live tenant のひとつ
- HackJapan 系導線
  - linked project 側でこの runtime を利用

## Decision Boundaries

- Worker / admin / package 実装の truth はこの repo
- 顧客別の運用文脈や提案は `sadame-ops`
- upstream への同期判断は `docs/OSS-SYNC-CHARTER.md`
- LINE Developers Console / webhook endpoint / Cloudflare deploy の実変更は live impact を持つ

## Current Risks

- webhook 修正時に、実際にどの worker が traffic を受けているかを取り違えやすい
- fork / upstream の同期順序を誤ると OSS 側の差分が消える
- local env files を accidental commit しやすい

## Practical Read

初見の contributor は、まず `docs/architecture.md` で worker 実体を掴み、その後 `docs/OSS-SYNC-CHARTER.md` で upstream / fork の境界を理解すると安全です。
