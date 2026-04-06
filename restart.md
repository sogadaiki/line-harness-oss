# Restart Notes

## Session: 2026-04-01
Branch: sadame/local-customizations

### 完了したこと
- ingest-references パイプライン実行（7件処理）
  - ナレッジ5ファイル更新: web-security.md, claude-code-core-patterns.md, business.md, tech-stack-rules.md, design-references.md
  - ベンチマーク2件作成: sankey-flow-viz, conversation-style-manual
  - sogadaiki/sadame-ops#227 作成→実装→クローズ
- docs/wiki/24-Supabase-LINE-Auth.md 新規作成（Supabase Custom OAuth/OIDC + LINE Login連携ガイド）
- research/ ディレクトリ構造を初期化（mai-references/INDEX.md, benchmarks/）

### 次にやること
1. claude-code-core-patterns.md の分割（1101行→500行以下に）— 参照関係を考慮して慎重に
2. 保険AI: 掛け合い形式UIの設計（research/benchmarks/conversation-style-manual/ 参照）
3. サンキー図パターンのスライド適用（research/benchmarks/sankey-flow-viz/ 参照）

### 注意点
- このブランチはlocal-customizations（アップストリームしない前提）。ドキュメント変更のみアップストリーム対象
- fork remoteにpush済み（origin=Shudesu、fork=sogadaiki）
