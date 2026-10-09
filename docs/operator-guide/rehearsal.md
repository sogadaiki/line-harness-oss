# 架空データで修正版を確認する

実際のworkerと管理画面、メモリ内SQLiteを使います。実LINEアカウント・本番D1・実キーは不要です。LINEへの外部通信は架空応答へ置き換えます。練習欄へ実データや実キーを入力しないでください。

## 起動

リポジトリのルートで依存関係を用意します。Node.js 22.17以上が必要です。

```sh
pnpm install --frozen-lockfile --prefer-offline
```

一つ目のターミナル:

```sh
node scripts/operator-rehearsal/start-worker-fixture.mjs
```

二つ目のターミナル:

```sh
NEXT_PUBLIC_API_URL=http://127.0.0.1:8344 NEXT_PUBLIC_ALLOWED_ACCOUNT_IDS=a pnpm --filter web exec next dev --hostname 127.0.0.1 --port 8345
```

[練習ログイン](http://127.0.0.1:8345/login) で「APIキーでログイン」を選び `fixture-owner-key` を入力します。これは架空値です。画面に「架空LINE・外部送信なし」、URLに127.0.0.1が表示されることを確認します。

APIには架空AとBを用意し、画面ではAだけ表示します。これは表示設定の検証です。サーバーの所属検証は、以下の回帰テストで別途確認します。

## 保存・再読込・停止の確認

1. 「LINEアカウント」で表示対象が1つであることを確認する。
2. 「シナリオ配信」→「+ 新規シナリオ」で名前を入れる。「作成後すぐに有効にする」は未選択のまま保存する。
3. 一覧に「無効」で出て、再読込しても残ることを確認する。
4. 「オートメーション」→「+ 新規ルール」で名前を入れ、動作JSONを `[{"type":"add_tag","params":{"tagId":"tag-a"}}]` にする。条件 `{}` のまま保存すると「無効」で出る。
5. 新規ルールで条件 `{"tagId":"tag-a","operator":"equals"}` を入れて保存する。未対応条件のエラーが出て、保存されないことを確認する。
6. 「緊急コントロール」で停止対象「練習LINE a」を読み、「自動送信を停止」→対象名付きの確認→「実行」と進む。
7. 完了表示に「停止後の残存件数を確認しました」と出ることを確認する。
8. [架空DBの状態](http://127.0.0.1:8344/fixture/state) で、Aがpaused／次の予約なし、Bがactive／将来予約ありのまま確認する。

## 自動検証

```sh
pnpm --filter worker test:account-isolation
node scripts/operator-rehearsal/probe-conditions.mjs
```

前者は23項目の実SQL・API・イベント・送信処理テストです。後者は修正版の条件関数の確認です。期待外の結果は非0で終了します。実際のLINEサーバー・本番設定・端末受信の合格を意味しません。

## 初回監査の練習との違い

旧 `mock-api.mjs` とポート8341／8342の練習は、修正前のUIと架空APIで保存先欠落を観測した資料です。現在の修正版の確認には上記8344／8345を使います。旧観測は [技術監査](technical-audit.md)、修正結果は [検証記録](repair-verification.md) に分けています。

## 終了

Ctrl+Cで両ターミナルを止めます。DBはメモリ内で、再起動すると初期状態へ戻ります。サービス登録・自動起動・課金・本番LINE接続は行いません。
