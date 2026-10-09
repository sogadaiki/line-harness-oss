# 操作理解に伴う技術監査

調査日: 2026-10-09。参照ソース: `dba7acd94d3ffcfbe398fcfbaef147da6d1bd356`。本番の設定変更・送信・デプロイは実施していない。

「画面確認」は実ブラウザ、「練習」は同じフロントの架空API、「関数確認」は実ソースの関数に架空イベントを渡した結果、「コード確認」は静的な追跡。稼働中バックエンドの完全一致と、過去の個別誤作動原因は未確定。顧客固有のデータ集計は共有プロジェクト記録だけに保存し、この文書やGitへ含めない。

## 修正順序

アカウント分離・条件判定・停止を先に直し、その後に店舗向けの画面を簡略化する。手順の暗記や注意書きだけでは誤作動を防げない。

### P0-1 新規保存で所属アカウントを落とす

確認: シナリオ・一斉配信を練習環境で作成。どちらもPOSTに `lineAccountId` がなく、アカウント指定付きの再取得では表示されなかった。バックエンドのシナリオ・配信作成コードも、bodyに指定がある場合だけ所属を保存する。オートメーション・リマインダも同じ入力不足をコードで確認。

影響: 保存できていないと誤認して重複作成する。所属未指定のルールとして扱われ、送信側の既定アカウント・グローバル互換処理へ進む可能性。

ソース:

- `apps/web/src/app/scenarios/page.tsx` の `handleCreate`
- `apps/web/src/components/broadcasts/broadcast-form.tsx` の `handleSave`
- `apps/web/src/app/automations/page.tsx`、`apps/web/src/app/reminders/page.tsx`
- `apps/worker/src/routes/scenarios.ts`、`broadcasts.ts`、`automations.ts`、`reminders.ts`

修正確認: 所属はサーバーの認可済み対象から確定。未指定・別アカウント指定を拒否。保存→再読込で同じ対象に一つだけ表示。他アカウントの一覧・ルール・送信を変えない。

### P0-2 表示上の限定は全ルートの認可ではない

確認: 稼働中アカウント画面では一覧と左上の操作対象が違う。`AccountProvider` は `NEXT_PUBLIC_ALLOWED_ACCOUNT_IDS` で表示リストだけを絞るが、accountsページはAPIの全リストをそのまま表示する。

`authMiddleware` は `SCOPED_LINE_ACCOUNT_ID` をcontextへ入れる。`getScope()` を使う一覧ルートには適用されるが、個別IDの取得・更新・削除・送信はそれぞれ所属を検証しない例がある。コメント上の「hardlock」を全機能の保証として扱えない。

ソース:

- `apps/web/src/contexts/account-context.tsx`、`apps/web/src/app/accounts/page.tsx`
- `apps/worker/src/middleware/auth.ts`、`apps/worker/src/utils/scope.ts`
- `apps/worker/src/routes/scenarios.ts` の詳細・更新・削除・enroll
- `apps/worker/src/routes/broadcasts.ts` の詳細・更新・削除・send
- `apps/worker/src/routes/auto-replies.ts` の作成・ID操作
- `apps/worker/src/routes/rich-menus.ts` のquery/defaultによるclient解決

修正確認: 認証→アカウント認可→全リソース所属検証を統一。別のID、所属未指定、query省略、body差替え、スタッフ権限の各ケースで拒否。LINE clientの既定値へのfallbackは対象限定処理で禁止。

### P0-3 条件入力例が処理側と違い、制限を無視する

画面確認: 条件欄の入力例は `tagId` と `operator=equals`。処理側の `tag_id` とは異なる。

関数確認: 実ソースの `matchConditions` を取り出し、TypeScriptを変換して架空イベントで実行。

| 条件 | イベント | 実際の一致 | 意図 |
| --- | --- | --- | --- |
| `tagId=A, operator=equals` | `tagId=B` | true | false |
| `tag_id=A` | `tagId=B` | false | false |
| `tag_id=A` | `tagId=A` | true | true |
| 未対応キーだけ | 空イベント | true | 拒否すべき |

ソース: `apps/web/src/app/automations/page.tsx`、`apps/worker/src/services/event-bus.ts`。

再現: `node scripts/operator-rehearsal/probe-conditions.mjs`。これは障害の観測用であり、安全な判定の合格テストではない。

修正確認: 条件schemaを入力・保存・実行で共通化。未知のキー・型・イベントに不適切な条件を拒否。未知条件を無条件一致にしない。空条件の意味と対象者を画面で確認可能にする。

### P0-4 イベントの所属欠落で他アカウントの自動化も候補になる

コード確認: `processAutomations` は `!a.line_account_id || !lineAccountId || a.line_account_id === lineAccountId` を許す。タグ付与APIは `fireEvent` にアカウントを渡さない。タグ付与時のシナリオ登録にも所属の比較がない。

影響: 所属を持つルールでも、イベント側の所属が空なら他アカウントの候補になる。未指定ルールが今存在しないだけでは、この経路を除去できない。

ソース: `apps/worker/src/routes/friends.ts`、`apps/worker/src/services/event-bus.ts`、`apps/worker/src/routes/webhook.ts`。

修正確認: イベントの所属をfriendなどの確定したリソースから解決し必須化。同じ所属のルールだけ実行。許可していないグローバル互換を無効化。通知・送信Webhook・スコアの範囲も同時に検証。

### P0-5 親シナリオ無効化は登録済みの送信を止めない

コード確認: `getFriendScenariosDueForDelivery` は `friend_scenarios.status='active'` と時刻を見る。親の `scenarios.is_active` を確認せず、後続の送信処理も親無効化を停止条件としていない。

ソース: `packages/db/src/scenarios.ts`、`apps/worker/src/services/step-delivery.ts`。

修正確認: 親停止、個人停止、アカウント停止を送信直前にも判定。停止後に到来する予約が送られないこと、再開時に古い予約がまとめて送られないことを確認。保留中・失敗・進行中も読み戻す。

### P0-6 タグ一斉配信はアカウントを横断できる

コード確認: `processBroadcastSend` のtag経路は `getFriendsByTag` の結果をアカウントごとに分け、各アカウントのclientで送る。配信の所属に限定するフィルタがない。

ソース: `apps/worker/src/services/broadcast.ts`、`apps/worker/src/routes/broadcasts.ts`。

修正確認: tag、friend、broadcastの所属が同一であることをサーバーで限定。対象件数・対象アカウントをプレビュー。空対象・混在対象では送信しない。

### P0-7 一括停止は広すぎ、停止成功の表示は弱い

コード・練習確認: emergency画面はaccountIdなしで配信・シナリオを取得。`Promise.allSettled` の失敗を集計せず、完了を表示する。全配信停止は予約配信だけ、シナリオ停止は親だけ。自動応答・automation・個人reminderの停止を含まない。

ソース: `apps/web/src/app/emergency/page.tsx`。練習の停止操作でもaccount指定なしのGETを確認。

修正確認: アカウントと停止する機能を明示。失敗・残存件数を表示。処理後の状態をサーバーで再取得し、完了の範囲を正確に示す。既に外部へ送信済みのものは取消扱いにしない。

## P1 操作の理解・到達確認を妨げる問題

| 問題 | 根拠 | 改善・検証 |
| --- | --- | --- |
| 後続ステップの時刻を期待しづらい | `wrangler.toml` は1日2回、step-deliveryは9～23時の制限 | 稼働中cronを照合し、面談通知の許容遅延に合う構成へ |
| 指標が別アカウントを含み得る | dashboardはfriendCount以外の一部一覧にaccountIdなし | 全指標に対象・期間・集計定義を付ける |
| 「今月送信」の意味が違う | line-accounts.tsは直近30日・push相当 | 表示名と集計を一致。reply/pushを区別 |
| フォーム回答の対象不足 | selectedAccount変更でreloadするがrequestにaccountIdなし | フォーム・回答の所属を検証 |
| 自動応答・予約・リッチメニューのGUI不足 | APIルートはあるが専用pageがない | 日常業務に必要な編集だけ画面化 |
| 画像・Flexの入力がJSON中心 | 実画面の種別・内容欄 | 画像選択、カード編集、事前表示、サイズ・schema検証 |
| ロールとアカウント範囲が混同される | authはroleを設定、scopeはenv依存 | スタッフの許可アカウントを認可に使用、別対象を拒否 |
| 同じLINE user IDの所属更新 | webhook followとfriend upsertの構造 | 同一provider内の複数OA追加を試し、所属・履歴を上書きしない |
| 応答の優先順が分かりにくい | webhookはcreated_at ASC、最初の一致でbreak | 明示優先度と競合表示。textとpostbackを別検証 |
| 通知の存在とスマホ到達が違う | event-busはDB通知作成、emailは未実装 | 送信処理と受信を別にテスト、未対応チャネルを選択不可に |
| 「CCに依頼」が実行に見える | 実画面はコピー用モーダル | コピー用と明示、対象アカウントを依頼文に含める |
| アカウント無効化だけでは送信を保証停止しない | 個別send・step送信のclient解決にis_active条件なし | すべての送信入口でアカウント有効状態を確認 |
| 全員配信の0件が未計測と混同 | broadcast.tsは人数不明の場合0を保存 | 未計測・不明・実測0を区別 |
| BAN移行ボタンが完成移行に見える | health.tsは移行レコードをin_progressで作成、対象countは全following | 対象を限定し、本人の新OA追加・対応付け成立を別状態に |

## 最小の使いやすい運用画面

店舗スタッフには「対象アカウント」「未対応相談」「相談内容・診断タイプ」「返信」「担当メモ」「面談の状態」を中心にする。面談申込で追客を止める動作と、日時変更・取消によるリマインダ変更を結び付ける。

配信設定担当者には、応答内容・対象・条件・開始・停止・テスト受信を一画面で確認できる構成が必要。複数アカウントの切替・削除・認証情報は日常の相談画面から分離する。

## 再開時の確認

1. 実際に配布されているworker/管理画面のrevisionとcronを確定。
2. 新規保存・全ID操作・イベント・配信・停止にアカウント制約を適用。
3. 条件schemaを統一し、対象外イベントの否定テストを実施。
4. 親停止・個人停止・アカウント停止後の送信ゼロを確認。
5. 既存データの所属未指定・登録の残存を対象限定で確認。復旧できる記録を取って扱う。
6. 本人端末で診断→新規追加→画像と解説→面談希望→店舗対応→追客停止を確認。
7. 他アカウントへの書込・送信がないことを確認してから有効化。

この調査だけでは、既存アカウントの安全な停止や新アカウントの連携完了は成立していない。
