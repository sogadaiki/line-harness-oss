# 14. オートメーション (Automation / IF-THEN ルール)

## 概要

オートメーション機能は、イベント駆動のIF-THENルールエンジン。特定のイベントが発生した時に、条件を満たせば自動的にアクションを実行する。タグ付与、シナリオ登録、メッセージ送信、リッチメニュー切替、Webhook送信、メタデータ更新の6種のアクションをサポート。

L社の「アクション管理」「条件分岐」に相当する機能を、より汎用的なルールエンジンとして実装。

## アーキテクチャ

```
イベント発生（follow, message, tag_change 等）
    ↓
イベントバス (event-bus.ts) の fireEvent()
    ↓
processAutomations()
    ↓ 並列実行
    ├── 送信Webhook通知 (fireOutgoingWebhooks)
    ├── スコアリング適用 (processScoring)
    ├── オートメーション実行 (processAutomations) ← ここ
    └── 通知ルール処理 (processNotifications)
```

## データモデル

### automations テーブル

```sql
CREATE TABLE automations (
  id TEXT PRIMARY KEY,           -- UUID
  name TEXT NOT NULL,            -- ルール名
  description TEXT,              -- 説明
  event_type TEXT NOT NULL,      -- トリガーイベントタイプ
  conditions TEXT NOT NULL DEFAULT '{}',  -- JSON: マッチ条件
  actions TEXT NOT NULL DEFAULT '[]',     -- JSON配列: 実行アクション
  is_active INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 0,    -- 実行順序（大きい方が先に実行）
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_automations_event ON automations (event_type);
CREATE INDEX idx_automations_active ON automations (is_active);
```

### automation_logs テーブル

```sql
CREATE TABLE automation_logs (
  id TEXT PRIMARY KEY,                                                -- UUID
  automation_id TEXT NOT NULL REFERENCES automations (id) ON DELETE CASCADE,
  friend_id TEXT REFERENCES friends (id) ON DELETE SET NULL,
  event_data TEXT,           -- JSON: トリガーイベントのデータ
  actions_result TEXT,       -- JSON: 各アクションの実行結果
  status TEXT NOT NULL DEFAULT 'success' CHECK (status IN ('success', 'partial', 'failed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_automation_logs_automation ON automation_logs (automation_id);
```

## イベントタイプ（7種）

| event_type | 発生タイミング | payload に含まれるデータ |
|---|---|---|
| `friend_add` | 友だち追加 | `friendId`, `eventData.displayName` |
| `message_received` | テキストメッセージ受信 | `friendId`, `eventData.text`, `eventData.matched` |
| `tag_change` | タグ付与/削除 | `friendId`, `eventData.tagId` |
| `score_threshold` | スコア閾値到達 | `friendId`, `eventData.currentScore` |
| `cv_fire` | コンバージョン発生 | `friendId`, `eventData` |
| `calendar_booked` | カレンダー予約 | `friendId`, `eventData` |
| `incoming_webhook.*` | 外部Webhook受信 | `eventData.webhookId`, `eventData.source`, `eventData.payload` |

## アクションタイプ（10種）

| type | params | 説明 |
|---|---|---|
| `add_tag` | `{ tagId: string }` | タグを付与 |
| `remove_tag` | `{ tagId: string }` | タグを削除 |
| `start_scenario` | `{ scenarioId: string }` | シナリオに登録 |
| `pause_scenario` | `{ scenarioId: string }` | 指定シナリオの active な friend_scenario を paused に更新。既に paused/completed の場合は no-op |
| `complete_scenario` | `{ scenarioId: string }` | 指定シナリオの active または paused な friend_scenario を completed に更新。既に completed の場合は no-op |
| `send_message` | `{ content: string, messageType?: string, altText?: string }` | LINE メッセージ送信。`messageType` は `text`（デフォルト）または `flex` |
| `send_webhook` | `{ url: string }` | 外部URLにPOSTリクエスト |
| `switch_rich_menu` | `{ richMenuId: string }` | リッチメニューを切替 |
| `remove_rich_menu` | `{}` | リッチメニューのアサインを解除 |
| `set_metadata` | `{ data: string }` | friends.metadataにJSONをマージ |

## 条件 (Conditions) のJSON形式

`conditions` はJSONオブジェクトで、以下のキーをサポート:

### 空条件（常にマッチ）

```json
{}
```

条件が空の場合、そのイベントタイプの全イベントでアクションが実行される。

### score_threshold 条件

```json
{ "score_threshold": 50 }
```

`payload.eventData.currentScore` が指定値以上の場合にマッチ。

### tag_id 条件

```json
{ "tag_id": "specific-tag-uuid" }
```

`payload.eventData.tagId` が指定値と一致する場合にマッチ。`tag_change` イベントで使用。

### 条件の組み合わせ

現在の実装では条件はAND結合（全条件を満たす必要がある）:

```json
{
  "score_threshold": 100,
  "tag_id": "premium-tag-uuid"
}
```

## 優先順位 (Priority)

`priority` フィールドで実行順序を制御する。**値が大きいほど先に実行**される。

```
priority: 100  → 最初に実行
priority: 50   → 次に実行
priority: 0    → 最後に実行（デフォルト）
```

同じイベントタイプに複数のオートメーションが登録されている場合、priorityの降順で順次実行される。

## 実行ログ

オートメーションが実行されるたびに `automation_logs` にログが記録される。

### ログのステータス

| status | 意味 |
|---|---|
| `success` | 全アクションが成功 |
| `partial` | 一部のアクションが成功、一部が失敗 |
| `failed` | 全アクションが失敗 |

### ログの actions_result 形式

```json
[
  { "action": "add_tag", "success": true },
  { "action": "send_message", "success": true },
  { "action": "send_webhook", "success": false, "error": "Network timeout" }
]
```

---

## APIエンドポイント

### オートメーション一覧取得

```bash
curl -X GET "https://your-worker.your-subdomain.workers.dev/api/automations" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

**レスポンス:**

```json
{
  "success": true,
  "data": [
    {
      "id": "auto-uuid-1",
      "name": "新規友だち歓迎フロー",
      "description": "友だち追加時にウェルカムタグ+シナリオ登録",
      "eventType": "friend_add",
      "conditions": {},
      "actions": [
        { "type": "add_tag", "params": { "tagId": "welcome-tag-uuid" } },
        { "type": "start_scenario", "params": { "scenarioId": "welcome-scenario-uuid" } }
      ],
      "isActive": true,
      "priority": 10,
      "createdAt": "2026-03-20T10:00:00.000",
      "updatedAt": "2026-03-20T10:00:00.000"
    }
  ]
}
```

### オートメーション詳細取得（ログ付き）

```bash
curl -X GET "https://your-worker.your-subdomain.workers.dev/api/automations/AUTO_UUID" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

**レスポンス:**

```json
{
  "success": true,
  "data": {
    "id": "auto-uuid-1",
    "name": "新規友だち歓迎フロー",
    "description": null,
    "eventType": "friend_add",
    "conditions": {},
    "actions": [
      { "type": "add_tag", "params": { "tagId": "welcome-tag-uuid" } }
    ],
    "isActive": true,
    "priority": 10,
    "createdAt": "2026-03-20T10:00:00.000",
    "updatedAt": "2026-03-20T10:00:00.000",
    "logs": [
      {
        "id": "log-uuid-1",
        "friendId": "friend-uuid-1",
        "eventData": { "displayName": "田中太郎" },
        "actionsResult": [
          { "action": "add_tag", "success": true }
        ],
        "status": "success",
        "createdAt": "2026-03-22T14:00:00.000"
      }
    ]
  }
}
```

### オートメーション作成

```bash
curl -X POST "https://your-worker.your-subdomain.workers.dev/api/automations" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "VIP昇格フロー",
    "description": "スコア100以上でVIPタグ付与+専用メニュー+通知メッセージ",
    "eventType": "score_threshold",
    "conditions": { "score_threshold": 100 },
    "actions": [
      { "type": "add_tag", "params": { "tagId": "vip-tag-uuid" } },
      { "type": "switch_rich_menu", "params": { "richMenuId": "richmenu-vip-xxx" } },
      { "type": "send_message", "params": { "content": "VIP会員に昇格しました！特別特典をご確認ください。", "messageType": "text" } }
    ],
    "priority": 50
  }'
```

**レスポンス (201):**

```json
{
  "success": true,
  "data": {
    "id": "new-auto-uuid",
    "name": "VIP昇格フロー",
    "eventType": "score_threshold",
    "actions": [
      { "type": "add_tag", "params": { "tagId": "vip-tag-uuid" } },
      { "type": "switch_rich_menu", "params": { "richMenuId": "richmenu-vip-xxx" } },
      { "type": "send_message", "params": { "content": "VIP会員に昇格しました！...", "messageType": "text" } }
    ],
    "isActive": true,
    "priority": 50,
    "createdAt": "2026-03-22T10:00:00.000"
  }
}
```

### オートメーション更新

```bash
curl -X PUT "https://your-worker.your-subdomain.workers.dev/api/automations/AUTO_UUID" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "isActive": false,
    "priority": 100,
    "conditions": { "score_threshold": 200 }
  }'
```

### オートメーション削除

```bash
curl -X DELETE "https://your-worker.your-subdomain.workers.dev/api/automations/AUTO_UUID" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

### 実行ログ取得

```bash
# 特定オートメーションのログ
curl -X GET "https://your-worker.your-subdomain.workers.dev/api/automations/AUTO_UUID/logs?limit=50" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

**レスポンス:**

```json
{
  "success": true,
  "data": [
    {
      "id": "log-uuid",
      "automationId": "AUTO_UUID",
      "friendId": "friend-uuid",
      "eventData": { "text": "こんにちは", "matched": false },
      "actionsResult": [
        { "action": "add_tag", "success": true },
        { "action": "send_message", "success": true }
      ],
      "status": "success",
      "createdAt": "2026-03-22T14:00:00.000"
    }
  ]
}
```

---

## オートメーションチェーニングパターン

### パターン1: 友だち追加 → タグ → メニュー → シナリオ

```bash
curl -X POST ".../api/automations" -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "新規友だち完全セットアップ",
    "eventType": "friend_add",
    "conditions": {},
    "actions": [
      { "type": "add_tag", "params": { "tagId": "new-friend-tag" } },
      { "type": "switch_rich_menu", "params": { "richMenuId": "richmenu-welcome" } },
      { "type": "start_scenario", "params": { "scenarioId": "welcome-scenario" } },
      { "type": "set_metadata", "params": { "data": "{\"source\":\"organic\",\"status\":\"new\"}" } }
    ],
    "priority": 100
  }'
```

### パターン2: キーワード検知 → アクション

```bash
# 「資料請求」メッセージ受信時
curl -X POST ".../api/automations" -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "資料請求処理",
    "eventType": "message_received",
    "conditions": {},
    "actions": [
      { "type": "add_tag", "params": { "tagId": "document-requested-tag" } },
      { "type": "start_scenario", "params": { "scenarioId": "document-delivery-scenario" } },
      { "type": "send_webhook", "params": { "url": "https://hooks.slack.com/services/xxx/yyy/zzz" } }
    ]
  }'
```

### パターン3: 外部Webhook → LINE内アクション

```bash
# Stripe決済完了Webhook受信時
curl -X POST ".../api/automations" -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "決済完了処理",
    "eventType": "incoming_webhook.stripe",
    "conditions": {},
    "actions": [
      { "type": "add_tag", "params": { "tagId": "paid-customer-tag" } },
      { "type": "switch_rich_menu", "params": { "richMenuId": "richmenu-customer" } },
      { "type": "send_message", "params": { "content": "ご購入ありがとうございます！", "messageType": "text" } }
    ]
  }'
```

### パターン4: チェーニング（イベント → アクション → 新イベント → アクション）

オートメーションの `add_tag` アクションが `tag_change` イベントを発火し、別のオートメーションがトリガーされるチェーニングが可能:

```
friend_add → [auto-1: add_tag "セミナー参加者"]
    → tag_change → [auto-2: switch_rich_menu "セミナーメニュー"]
```

ただし無限ループに注意。循環参照する条件を設定しないこと。

### パターン5: タグ付与でシナリオを停止する

特定タグが付与された時点で、進行中のナーチャリングシナリオを自動停止する。ECの「購入済タグ」でマーケメール停止、求人の「面談予約済タグ」でフォローシナリオ停止など汎用的に使える。

```bash
# タグ付与 → シナリオ一時停止（paused: 後で再開可能）
curl -X POST ".../api/automations" -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "特定タグ付与→シナリオ停止",
    "eventType": "tag_change",
    "conditions": { "tag_id": "your-tag-uuid" },
    "actions": [
      { "type": "pause_scenario", "params": { "scenarioId": "your-scenario-uuid" } }
    ],
    "priority": 50
  }'

# タグ付与 → シナリオ完了（completed: 同一シナリオへの再登録が可能）
curl -X POST ".../api/automations" -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "特定タグ付与→シナリオ完了",
    "eventType": "tag_change",
    "conditions": { "tag_id": "your-tag-uuid" },
    "actions": [
      { "type": "complete_scenario", "params": { "scenarioId": "your-scenario-uuid" } }
    ],
    "priority": 50
  }'
```

**`pause_scenario` と `complete_scenario` の使い分け:**
- `pause_scenario`: 対象の `status='active'` な friend_scenario を `paused` に変更。後で手動での復帰余地を残したい場合に使う
- `complete_scenario`: 対象の `status` が `active` または `paused` な friend_scenario を `completed` に変更。`completed` になると同一シナリオへの新規登録（`start_scenario`）が再び可能になる

**注意:** `conditions.tag_id` はタグ付与・タグ削除の両方で発火する `tag_change` イベントを対象にする。現時点の実装は `tag_id` 一致のみ判定し `action: 'add'|'remove'` の区別を行わない。タグ削除運用がある場合は別途オートメーション設計を検討すること。

## ソースコード参照

- Worker APIルート: `apps/worker/src/routes/automations.ts`
- DB クエリ: `packages/db/src/automations.ts`
- イベントバス: `apps/worker/src/services/event-bus.ts` (`processAutomations`, `matchConditions`, `executeAction`)
- マイグレーション: `packages/db/migrations/002_round3.sql` (258-289行目)
