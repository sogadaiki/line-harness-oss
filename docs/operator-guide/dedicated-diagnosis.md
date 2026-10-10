# Dedicated diagnosis receiver

Use this entry for a newly provisioned account and a separate empty D1 database. It is not a migration or deployment instruction for a shared legacy database.

## Runtime boundaries

- `apps/worker/src/hinatama-entry.ts` exposes diagnosis routes, scoped authenticated administration, staff login and tracked links. The generic webhook and generic customer login are not exposed. No scheduled handler or cron is installed.
- Set all `HINATAMA_*` account/Login/bot variables explicitly. No generic credential fallback is used. `SCOPED_LINE_ACCOUNT_ID` must match the active diagnosis account.
- `/api/diagnosis/status` requires authenticated access to the dedicated account. Counts distinguish registered friends, LINE-accepted result sends, unread chats, current failures and pause state. Provider acceptance does not establish receipt, read status or an interview.
- Build the admin with `NEXT_PUBLIC_DIAGNOSIS_ONLY=true`, a single allowed account ID, its dedicated worker URL and the public diagnosis LP URL. It displays only diagnosis, friends, chat, staff, account and diagnosis pause controls.

## Install and update

Generate a current empty schema with `node scripts/build-fresh-db-schema.mjs <private-output.sql>`. It includes receipts for every SQL migration, including date-named files, so a later `wrangler d1 migrations apply` does not repeat historical statements. Import it only after verifying zero existing application tables. Seed account credentials, an owner grant and reviewed content through private files outside Git. Never copy legacy friend/chat data as a bootstrap shortcut.

For an existing dedicated installation, apply only pending numeric migrations to that exact database before deploying the worker. Migration027 adds a pause table without changing any account's state. Keep actual deployment configuration, credential references and seed payloads in the user's private recovery store. The tracked standalone config contains placeholders.

## Pause and resume

The dedicated emergency screen uses owner/admin-only `POST /api/diagnosis/pause` and `/resume`. Pause atomically records the account flag and cancels pending, awaiting-friend, failed and sending sessions. It clears OAuth transient values and prevents those cancelled sessions from sending after resume. New starts, result pushes and keyword replies check the flag. Incoming messages still enter unread staff chats; manual staff replies remain available.

The generic `/api/account-stop` is rejected by this entry because it does not control the custom receiver. A stop cannot recall a request already handed to LINE. Resume permits new diagnostics and new keyword replies; it does not replay cancelled sessions. There are no live stop/resume actions in the regression suite.

## Acceptance and recovery

Receipt URLs identify the exact diagnosis with a hashed attempt ID. An attempt also requires its own short-lived HttpOnly/Secure browser cookie, matching account and non-expired session. Another attempt cannot replace a sent receipt's status; an ID alone never authorizes reading or retrying it. The callback, HTML, JSON poll and retry all use the same attempt. In-flight pre-release fixed cookies are accepted only when they match that exact session.

Render the recorded state before JavaScript polling. Sent means LINE accepted the request, not proof of human receipt/read. Unfinished consent does not claim that the visitor deliberately cancelled: offer reconnection for the same diagnosis code without repeating eight questions. Failed Login reconnects; failed delivery retries with the same idempotency key. Do not retry a cancelled or expired session as a new send.

After confirming sent, mobile receipts attempt the account's official HTTPS chat link once per attempt/tab. Keep the visible tap link, do not auto-open unfinished/failed receipts, and do not loop on browser return/reload. This is navigation only, never another message send. Actual app launch depends on the OS/browser and needs iPhone verification; a JavaScript test proves routing/once-only behavior, not native app opening. See [LINE's app-launch limits](https://developers.line.biz/ja/tips/2026/05/07/line-launch-issue/).

Run worker typecheck, account-isolation tests, diagnosis tests and the diagnostic admin production build. Their provider calls are stubbed; no real messages are sent. Then check the deployed health, owner-scoped status, unauthenticated rejection, foreign-account rejection, LINE Login publication and webhook status. Finally use an owner iPhone for public LP → eight answers → new account → automatic matching image and explanation → interview keyword → staff unread chat. Record the human receipt separately.

If receipt fails, inspect session error/status and webhook event aggregates in the dedicated DB. Preserve incoming chats. A provider quota, rejected authentication or failed message is not success. Use the current account's private recovery guide to restore reviewed content/configuration; do not reset a shared DB or activate duplicate native replies.
