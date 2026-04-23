# Repo Guide

## Read Order

1. `README.md`
2. `AGENTS.md`
3. `docs/project-context.md`
4. `docs/legacy-residue.md`
5. `docs/architecture.md`
6. `docs/OSS-SYNC-CHARTER.md`
7. `restart.md`

## Scope Boundary

- この repo は upstream OSS を fork した shared runtime です
- live runtime は `apps/worker` と `apps/web`
- `sadame-ops` は顧客文脈と cross-repo routing を持つだけで、実装 truth ではありません
- upstream (`origin`) と fork (`fork`) の両方があるので、push 先と同期方向を必ず確認してください

## Truth-Source Precedence

When files disagree, trust them in this order:

1. `apps/worker/src/**`, `apps/web/src/**`, `packages/**`
2. `apps/worker/wrangler.toml` と `apps/worker/wrangler.hinatama.toml`
3. `docs/architecture.md`
4. `docs/OSS-SYNC-CHARTER.md`
5. `docs/project-context.md`
6. `README.md` / this file
7. `restart.md`

## Operational Guardrails

- Cloudflare / wrangler / workers.dev 参照はこの repo では live runtime です
- `apps/worker/wrangler.toml` と `apps/worker/wrangler.hinatama.toml` は削除候補ではありません
- `.env.example` と `docs/.env.example` は example であり、シークレット実体ではありません
- `packages/plugin-template/wrangler.toml` は plugin template の sample で、production worker ではありません
- `restart.md` は local handoff。canonical truth ではありません
- 現在の branch は `sadame/local-customizations`。upstream に戻す時は `docs/OSS-SYNC-CHARTER.md` の同期ルールを先に読む

## Safe First Checks

```bash
pnpm install
pnpm dev:worker
pnpm dev:web
pnpm build
pnpm --filter worker typecheck
```

ただし deploy や LINE Developers Console の変更は live 影響があるので、着手前に worker 実体を確認してください。
