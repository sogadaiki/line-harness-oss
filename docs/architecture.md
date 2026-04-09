# line-harness-oss — Worker Runtime Architecture

> Last updated: 2026-04-10
> Purpose: Single source of truth for how webhooks are routed, which worker runs in production, and where multi-tenant state lives. This document exists because we burned 30+ minutes chasing a bug in a worker that wasn't actually receiving traffic.

## TL;DR

- **One webhook URL in LINE Developers Console → `https://line-crm-worker.sogadaiki.workers.dev/webhook`**
- **`line-crm-worker` serves ALL LINE accounts** (sadame, hinatama, shusei-club, ...). Multi-tenant via destination channel ID lookup.
- **`hinatama-line-worker` exists but does NOT receive webhook traffic.** It is a scoped-tenant variant built from the same codebase, used for internal/testing cron jobs.
- **Both workers share the same D1** (`sadame-line-crm`, id `973f09e0-a762-434e-9861-07279a28510e`).
- **Account isolation is soft**: every table has `line_account_id TEXT` (nullable), queries use `WHERE line_account_id IS NULL OR line_account_id = ?` pattern.

## 1. Worker deployment variants

Both workers build from the same code (`apps/worker/src/index.ts`), just different wrangler configs.

### `line-crm-worker` — PRIMARY TRAFFIC RECEIVER

- Config: `apps/worker/wrangler.toml`
- Deploy: `pnpm deploy` or `npx wrangler deploy` (default config)
- `WORKER_URL` = `https://line-crm-worker.sogadaiki.workers.dev`
- D1 binding `DB` → `sadame-line-crm`
- Cron: `0 0,12 * * *` (00:00 & 12:00 JST)
- No `SCOPED_LINE_ACCOUNT_ID` var → multi-tenant mode
- **This is the worker whose URL is registered in LINE Developers Console** for every LINE official account in this repo's scope.
- Resolves account identity per webhook by iterating `line_accounts` and verifying the `X-Line-Signature` header against each account's `channel_secret`.

### `hinatama-line-worker` — TENANT-SCOPED VARIANT (NOT RECEIVING WEBHOOKS)

- Config: `apps/worker/wrangler.hinatama.toml`
- Deploy: `npx wrangler deploy --config wrangler.hinatama.toml`
- `WORKER_URL` = `https://hinatama-line-worker.sogadaiki.workers.dev`
- Same D1 database as line-crm-worker
- Cron: `*/5 * * * *` (every 5 min)
- `SCOPED_LINE_ACCOUNT_ID = "22920358-e4eb-4878-bfa2-f6bf97fcb4fa"` hardcoded in `[vars]` → all queries are implicitly scoped to hinatama
- **LINE Developers Console does NOT point webhooks here.** Intended for account-isolated cron jobs (health check, token refresh) or as a failover, but not currently the webhook receiver.
- Verification command:
  ```bash
  curl -H "Authorization: Bearer $TOKEN" https://api.line.me/v2/bot/channel/webhook/endpoint
  # → {"endpoint":"https://line-crm-worker.sogadaiki.workers.dev/webhook",...}
  ```

### Deployment gotcha

**When fixing webhook-path code, always deploy BOTH or confirm which worker actually receives traffic.**
- `pnpm build && pnpm deploy` → only deploys line-crm-worker
- `npx wrangler deploy --config wrangler.hinatama.toml` → only deploys hinatama-line-worker
- The bundle is identical (`dist/line_crm_worker/assets/worker-entry-*.js`), only the worker name/URL/cron differ.

If you only deploy hinatama-line-worker and test via production LINE webhook, **the old code is still running** because LINE's webhook URL targets line-crm-worker.

## 2. Webhook event flow (`apps/worker/src/routes/webhook.ts`)

Entry: `POST /webhook` (line 28). Auth-skipped in middleware (signature verification instead).

### 2.1 Multi-account resolution (lines 41–68)

```
POST /webhook {destination, signature, events}
  → for each line_accounts row with is_active=1:
      verifySignature(account.channel_secret, body, signature)
      if valid:
          channelAccessToken = account.channel_access_token
          matchedAccountId   = account.id
          break
  → construct LineClient(channelAccessToken)
```

This is why one worker can serve N LINE accounts. The `destination` field in the webhook body is the channel user ID, which uniquely identifies the target account.

### 2.2 Event handler precedence

For each event in `body.events`:

**1. `follow` event** (lines 94–283)
  1. `getProfile(userId)` via LINE API
  2. `upsertFriend()` + set `line_account_id = matchedAccountId`
  3. Enroll friend in `friend_add`-triggered scenarios (line 128)
     - If step 1 has `delay_minutes=0`, immediately `replyMessage(replyToken, [step1])` ← **consumes replyToken**
  4. Run `follow`-event automations (line 201)
     - Actions: `reply` (may consume replyToken), `addTag`
  5. Entry route tracking (follow.ref → entry_routes)
  6. `fireEvent(db, 'friend_add', ...)`

**2. `message` event** (lines 341–592)
  1. Extract text, upsert friend if missing
  2. Log incoming message to `messages_log`
  3. Upsert chat record (skip if auto-keyword to prevent clutter)
  4. Delivery time detection (`○時に届けて`)
  5. Cross-account UUID trigger (`体験を完了する` → push to sibling account)
  6. `processInterviewDateDetection()` (may consume replyToken)
  7. **Auto-reply matching (lines 492–582)** — see §3 below
  8. `fireEvent(db, 'message_received', { replyToken: unless-consumed })`

**3. `postback` event** (lines 295–339)
  - Same auto_replies lookup as message event, but matches `event.postback.data` instead of text
  - ⚠️ Uses `buildMessage(rule.response_type, expandedContent)` directly without JSON normalization — **has same JSON-in-text pitfall** as auto-reply had before the fix. If rich menu uses postback actions with structured payloads, this path needs the same normalization.

**4. `unfollow` event** (lines 286–293)
  - `updateFriendFollowStatus(line_user_id, false)`

### 2.3 replyToken lifecycle

- `event.replyToken` is single-use and expires ~1 minute after the event.
- Webhook handlers mark `replyTokenUsed` / `replyTokenConsumed` to prevent double-use.
- `fireEvent()` is called at the end of each event handler and is passed `replyToken` only if unused. `event-bus.send_message` actions use it if available, else fall back to `pushMessage` (event-bus.ts lines 307–325).

## 3. Auto-reply payload normalization (the bug we just fixed)

### Supported `response_content` shapes (webhook.ts lines 526–548)

| Shape | Interpretation |
|---|---|
| `plain text` | single text message (fallback) |
| `["foo", "bar"]` | multiple text messages (legacy multi-bubble) |
| `{"text": "...", "quickReply": {...}}` | text message with quickReply buttons (legacy shape, no explicit `type`) |
| `{"type": "text"|"flex"|"image"|..., ...}` | typed message pass-through |
| `[{...}, {...}]` | array of typed messages |

### `normalizeAutoReplyMessage` helper (webhook.ts lines 597–616)

```ts
function normalizeAutoReplyMessage(raw: unknown, fallbackType: string): Message {
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    // Legacy: {text, quickReply?} without type field → treat as text
    if (typeof obj.type !== 'string' && typeof obj.text === 'string') {
      const msg: Record<string, unknown> = { type: 'text', text: obj.text };
      if (obj.quickReply) msg.quickReply = obj.quickReply;
      return msg as Message;
    }
    // Already typed → pass-through
    if (typeof obj.type === 'string') return obj as Message;
  }
  return buildMessage(fallbackType, typeof raw === 'string' ? raw : JSON.stringify(raw));
}
```

### Why it mattered

Previously, any `response_content` that was a JSON object (not a string or string array) would be passed to `buildMessage('text', expandedContent)`, which just wraps it in `{type:'text', text: expandedContent}`. The result: users received the raw JSON string as a chat message.

This affected the hinatama booking flow (面接予約 → 平日 → 時間帯 → 年齢) where each step had a `{text, quickReply}` legacy payload. See `knowledge: JSON-in-text in LINE auto_reply` in the sadame-ops memory.

## 4. Known parallel bug: `event-bus.ts send_message` action

**Location**: `apps/worker/src/services/event-bus.ts` lines 290–326

```ts
case 'send_message': {
  const msgType = action.params.messageType || 'text';
  let msg: Message;
  if (msgType === 'flex') {
    const contents = JSON.parse(action.params.content);
    msg = { type: 'flex', altText: action.params.altText || ..., contents };
  } else {
    msg = { type: 'text', text: action.params.content };   // ← same pattern as the webhook bug
  }
  ...
}
```

If an automation's `send_message` action has `params.content = '{"text":"...","quickReply":{...}}'` and `messageType !== 'flex'`, it will emit the raw JSON as text.

**Current impact**: low. All hinatama automations with `event_type='message'` or `event_type='message_received'` are `is_active=0`. Other accounts are not known to use this shape. **But this is the same bug class and should be closed**. Proposed fix: import `normalizeAutoReplyMessage` (or replicate it) and call it on `action.params.content` when `messageType !== 'flex'`.

## 5. Packages

| Package | Path | Purpose | Consumed by |
|---|---|---|---|
| `@line-crm/db` | `packages/db/` | D1 CRUD helpers (friends, tags, scenarios, broadcasts, auto_replies, automations, reminders, forms, chats, ...) | worker routes + services |
| `@line-crm/line-sdk` | `packages/line-sdk/` | `LineClient` wrapper, `verifySignature`, `Message` types | webhook.ts, event-bus.ts, step-delivery.ts |
| `@line-crm/shared` | `packages/shared/` | shared constants/types | all packages |

Workspace is pnpm-managed (`pnpm-workspace.yaml`). `pnpm install` must run at the repo root after pull; individual `apps/worker/node_modules` contain symlinks into `../../../node_modules/.pnpm/`.

## 6. D1 schema: account scoping

Every first-class entity table has a nullable `line_account_id TEXT` column. Migration `008_multi_account.sql` introduced it for the core tables (friends, scenarios, broadcasts, reminders, automations, chats), and `020_account_scope.sql` extended it to the long tail (templates, message_templates, scoring_rules, tracked_links, forms, incoming_webhooks, outgoing_webhooks, conversion_points, tags).

### Query pattern

```sql
WHERE is_active = 1
  AND (line_account_id IS NULL OR line_account_id = ?)
```

- `NULL` → global rule, applies to all accounts
- specific UUID → scoped to that account

### Identity table

```sql
CREATE TABLE line_accounts (
  id                    TEXT PRIMARY KEY,
  channel_id            TEXT NOT NULL,
  name                  TEXT NOT NULL,
  channel_access_token  TEXT NOT NULL,
  channel_secret        TEXT NOT NULL,
  is_active             INTEGER NOT NULL DEFAULT 1,
  ...
)
```

As of 2026-04-10 there are three active accounts:

| name | id (prefix) | channel_id |
|---|---|---|
| 株式会社さだめ | `ed7b99b0` | 1660960833 |
| ヒナタマ熊本 | `22920358` | 2009555191 |
| 守成クラブ熊本ヒルノ | `58288382` | 2009554652 |

**Do NOT delete the Messaging API channels in LINE Developers Console.** Deletion = deleting the underlying LINE Official Account (friends, QR, ad routing all lost). See sadame-ops memory `feedback_line_channel_delete_equals_account.md`.

## 7. Cron jobs

Both workers export a `scheduled` handler in `src/index.ts` (lines ~235–289).

| Worker | Schedule | Behavior |
|---|---|---|
| line-crm-worker | `0 0,12 * * *` | Runs multi-tenant. Fetches all active accounts, runs `processStepDeliveries`, `processScheduledBroadcasts`, `processReminderDeliveries`, `checkAccountHealth`, `refreshLineAccessTokens`, `processInsightFetch`. Each function resolves the correct LINE client per friend's `line_account_id`. |
| hinatama-line-worker | `*/5 * * * *` | Same functions, but `SCOPED_LINE_ACCOUNT_ID` env forces scoping to a single account. Used for high-frequency health checks or account-specific jobs. |

`account_health_logs` records `risk_level` and `error_count` per 5-min interval; recent `normal` entries confirm the cron is healthy.

## 8. Known pitfalls & gotchas

1. **Webhook URL confusion** — `line-crm-worker` vs `hinatama-line-worker`. Always run the verification curl before assuming a deploy target (see §1). LINE Developers Console → LINE Login channel → LINE Login settings → Callback URL must also include the *actual* worker URL receiving traffic.

2. **Messaging API channel deletion = account deletion** — never delete; always re-configure the existing channel.

3. **D1 `UNION ALL` has a low term limit** — ~4–5 in one query, else `too many terms in compound SELECT`. Split into multiple queries.

4. **`wrangler d1 execute` does not stream output** — use `--json` and pipe through `python3 -c "import sys,json; ..."` when you need specific fields.

5. **`wrangler tail` disconnects after a few minutes** — not suitable for long-running log monitoring. Prefer short `wrangler tail` runs + check `account_health_logs` / `automation_logs` for persistent evidence.

6. **Next.js 15 static export + `useSearchParams`** requires a Suspense boundary at every consumer (including AuthGuard layouts). See `apps/web/` → login page rewrite 2026-04-09.

7. **`friends.metadata` migration 004** was left unapplied on hinatama D1 for a long time, causing cron to error every 5 min. Always verify all migrations are applied after importing an old D1 snapshot.

8. **`destination` fallback** — if the webhook body has no `destination` field (legacy LINE API behavior), the handler falls back to env-var `LINE_CHANNEL_SECRET`/`LINE_CHANNEL_ACCESS_TOKEN`. This is per-worker, so isolated workers like `hinatama-line-worker` can still process signed events for their single account via env.

9. **Messages_log content field stores `rule.response_content` (the raw D1 row), not the actual LINE API payload** (webhook.ts line 550). Do not use messages_log to verify whether the normalized payload was sent correctly — use `wrangler tail` or LINE's own delivery logs.

## 9. Operational checklists

### Before deploying a webhook-handler change

1. `pnpm -F worker typecheck` (may show pre-existing errors; check that YOUR file is clean)
2. `pnpm -F worker build`
3. Confirm which worker receives webhook traffic:
   ```bash
   TOKEN=$(npx wrangler d1 execute sadame-line-crm --remote --config wrangler.hinatama.toml \
     --command "SELECT channel_access_token FROM line_accounts WHERE id='22920358-e4eb-4878-bfa2-f6bf97fcb4fa';" \
     --json | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['results'][0]['channel_access_token'])")
   curl -H "Authorization: Bearer $TOKEN" https://api.line.me/v2/bot/channel/webhook/endpoint
   ```
4. Record current version for rollback:
   ```bash
   npx wrangler deployments status                         # line-crm-worker
   npx wrangler deployments status --config wrangler.hinatama.toml
   ```
5. Deploy to the worker that actually receives traffic (line-crm-worker by default):
   ```bash
   npx wrangler deploy
   ```
6. Smoke test via CEO's personal LINE account (曽我大樹 is already a friend of hinatama, see `friends` table).
7. If broken, rollback with `npx wrangler rollback <old-version-id>`.

### When changing auto_reply or automation payload shapes

- Shape changes must match `normalizeAutoReplyMessage` in webhook.ts — if you introduce a new shape (e.g., carousel), update the normalizer.
- Remember the `event-bus.ts send_message` action (see §4) — it's the second place the same normalization is needed.

## Appendix A — File reference (as of 2026-04-10)

| File | Role |
|---|---|
| `apps/worker/wrangler.toml` | line-crm-worker config (primary) |
| `apps/worker/wrangler.hinatama.toml` | hinatama-line-worker config (scoped variant) |
| `apps/worker/src/index.ts` | Hono app assembly + cron scheduled handler |
| `apps/worker/src/routes/webhook.ts` | LINE webhook event processor (follow/message/postback/unfollow) |
| `apps/worker/src/routes/auth.ts` | LINE Login + staff invite flow |
| `apps/worker/src/routes/rich-menus.ts` | Rich menu CRUD (proxy to LINE API) |
| `apps/worker/src/middleware/auth.ts` | Bearer token / cookie JWT auth |
| `apps/worker/src/services/event-bus.ts` | Post-event automation + scoring + outgoing webhooks |
| `apps/worker/src/services/step-delivery.ts` | Scenario step scheduling + `buildMessage()` canonical impl |
| `apps/worker/src/services/broadcast.ts` | Broadcast delivery (has its own copy of buildMessage) |
| `apps/worker/src/services/segment-send.ts` | Segmented push delivery (also has buildMessage) |
| `apps/worker/src/services/reminder-delivery.ts` | Reminder step scheduling (also has buildMessage) |
| `packages/db/migrations/` | D1 schema migrations (numbered SQL files) |
| `packages/db/src/index.ts` | DB helper re-exports |

## Appendix B — Known BuildMessage duplication

There are **four copies** of `buildMessage()` with similar signatures:

- `apps/worker/src/services/step-delivery.ts:354` (exported, canonical — used by webhook.ts)
- `apps/worker/src/services/reminder-delivery.ts:67`
- `apps/worker/src/services/segment-send.ts:106`
- `apps/worker/src/services/broadcast.ts:144`

They all implement the same `(messageType, messageContent, altText?) → Message` logic. Consider deduplicating into `@line-crm/shared` in the future. For now, any change to message shape handling must touch all four files.
