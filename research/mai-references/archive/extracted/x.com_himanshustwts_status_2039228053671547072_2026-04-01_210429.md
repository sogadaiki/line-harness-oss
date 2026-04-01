---
source: x.com
type: thread
author: "himanshu@himanshustwts"
url: https://x.com/himanshustwts/status/2039228053671547072?s=53&t=V0o3YOm7LyCUzT9aPsn5ng
extracted_at: 2026-04-01T12:04:28.989Z
---

# Xユーザーのhimanshuさん: 「Claude Code has an interesting recipe for "Compaction". This is how it works: [again, shared by claude code] Claude Code is not doing “one compaction”. It has three layers and each layer handles a different kind of overload. &gt; Layers + MicroCompact (Cheap, Every Turn) + https://t.co/vNLTOikWRH」

**himanshu@himanshustwts** - 2026-04-01T06:27:09.000Z

クリックしてhimanshustwtsさんを購入する

Claude Codeには「Compaction（圧縮）」のための興味深いレシピがあります。これがその仕組みです：

[再び、claude codeが共有]

Claude Codeは「1回の圧縮」だけを行っているわけではありません。3つのレイヤーがあり、それぞれのレイヤーが異なる種類のオーバーロードを処理します。

> レイヤー
+ MicroCompact（安価、毎ターン）
+ Session Memory Compact（中程度、APIコールなし）
+ Legacy Compact（高価、完全要約）

+ 有効ウィンドウ = モデルウィンドウ（予約済み）
+ 自動圧縮トリガー = 有効ウィンドウ（13Kトークン）
+ 手動ブロック制限 = 有効ウィンドウ（3Kトークン）
+ システムはハードなプロンプトが長すぎる壁にぶつかる*前に*圧縮を試みた

> すべてのターンに「安価な圧縮」パスがある
+ すべてのAPIリクエストの前に実行
+ 実際の会話構造を変えずにトークンを節約

> 本当の圧縮パスは境界ベース
+ Claudeに以前の会話を要約するよう依頼
+ 古いトランスクリプトは書き換えられず削除もされない

> Session memory compactionが*最初に*試される
+ そのファイル + 最近のメッセージからコンテキストを再構築
+ モデルコールは不要
+ それが失敗した場合にのみ完全要約にフォールバック

> Resumeは最後の境界*の後*のワールドのみをロード
+ 一度見つかると、境界前のペイロードはメモリ内ロードバッファからドロップ
+ 再開時、Claudeは境界後のコンテキストのみを見る

> 最も賢いトリックはpreserved-tail relinking（保存テールの再リンク）
+ 圧縮は要約を保持するだけではない
+ 最近のライブメッセージの保存テールも保持
+ 再開時、そのテールは要約チェーンに縫い付け直される

> つまり「圧縮」はパイプラインのトリム、安価なツール結果の膨張を扱う
+ 閾値チェック → 完全圧縮が必要か決定
+ まずディスク裏付けの要約
+ legacy compact → 必要ならClaudeに要約を依頼
+ compact boundaryを追加 → 将来のロードはそこから開始

> ユーザーが経験した「Claudeが忘れた」
+ は通常削除ではない
+ それは境界の切り詰め
+ 要約の置換
+ そしてアクティブなワーキングセットを生かそうとするテールの保存

![image](../images/x.com_himanshustwts_status_2039228053671547072_2026-04-01_210428/img_001.jpg)

---

## Replies

**Trevor I. Lasn@trevorlasn·52分** - 2026-04-01T11:12:21.000Z

コンパクションが始まるのがわかるよ、笑。セッションの早い段階の詳細が少しぼやけるけど、全体像はしっかり保ってる。コンパクションが始まるのがわかるよ、笑。セッションの早い段階の詳細が少しぼやけるけど、全体像はしっかり保ってる。

---

**kai Nakamura@kaiNakamur78644·1時間** - 2026-04-01T10:46:51.000Z

これはエージェントの状態に対するガベージコレクションです。トレードオフは常に、サマライザーが3ターン後にツール呼び出しの依存関係であることが判明する詳細を落とす前に、「ノイズ」と「シグナル」のどちらかを決めることです。

---

**Bakhtier Gaibulloev@slashmsu·4時間** - 2026-04-01T07:20:10.000Z

3つの圧縮レイヤーは、基本的に会話のためのガベージコレクションです。本当の強みはサーキットブレーカー - 3回失敗したら試行を停止するんです。ほとんどのシステムは、リトライループとゼロのバックオフ戦略を持つ新人開発者のように、ただAPIを叩き続けるだけです。

---

## Images (local paths)

- ../images/x.com_himanshustwts_status_2039228053671547072_2026-04-01_210428/img_001.jpg
