# Legacy Residue

## Live, Not Residue

### `apps/worker/wrangler.toml`

primary worker の live config です。
削除候補ではありません。

### `apps/worker/wrangler.hinatama.toml`

tenant-scoped variant の live config です。
webhook の primary receiver ではありませんが、運用中の config です。

### `workers.dev` / `wrangler` / `cloudflare` 参照

この repo では current runtime です。
Cloudflare 参照を見ても residue 扱いしないでください。

## Examples, Not Secrets

### `.env.example`

template です。実シークレットではありません。

### `docs/.env.example`

documentation / onboarding 用の example です。
実運用の secret source ではありません。

## Non-Production But Intentional

### `packages/plugin-template/wrangler.toml`

plugin template の sample config です。
production worker の truth ではありませんが、template として現役です。

### `docs/wiki/**`

placeholder URL や example endpoint を多く含みます。
本番 inventory ではなく、OSS 向け reference docs です。

## Local-Only Artifacts

### `restart.md`

local handoff 用メモです。canonical truth ではありません。

### `.env.hinatama`, `.env.production.local`, `apps/web/--full-page`

ローカル運用や誤生成物の可能性が高いので、まず inventory の対象です。
今回の onboarding 整備では触りません。

### `apps/web/tsconfig.tsbuildinfo`

ローカル生成物です。repo truth ではありません。

## Cleanup Rule

この repo は shared runtime なので、Cloudflare 系ファイルを first pass で消さないでください。
cleanup が必要なのは local-only artifacts と accidental outputs で、runtime config ではありません。
