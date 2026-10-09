"""Render the self-contained operator guide without network or dependencies."""
from html import escape
from pathlib import Path
import re

root = Path(__file__).resolve().parents[2]
folder = root / 'docs/operator-guide'

def inline(text):
    text = escape(text)
    text = re.sub(r'!\[([^\]]*)\]\(([^)]+)\)', r'<img loading="lazy" src="\2" alt="\1">', text)
    text = re.sub(r'\]\(technical-audit\.md\)', '](#audit)', text)
    text = re.sub(r'\]\(rehearsal\.md\)', '](#practice)', text)
    text = re.sub(r'\[([^\]]*)\]\(([^)]+)\)', r'<a href="\2">\1</a>', text)
    text = re.sub(r'`([^`]+)`', r'<code>\1</code>', text)
    text = re.sub(r'\*\*([^*]+)\*\*', r'<strong>\1</strong>', text)
    return text

def render(markdown, prefix):
    output, toc = [], []
    lines = markdown.splitlines()
    i = 0
    heading_count = 0
    while i < len(lines):
        line = lines[i]
        if not line.strip(): i += 1; continue
        if line.startswith('```'):
            code = []; i += 1
            while i < len(lines) and not lines[i].startswith('```'):
                code.append(lines[i]); i += 1
            output.append('<pre><code>' + escape('\n'.join(code)) + '</code></pre>')
        elif line.startswith('#'):
            level = len(line) - len(line.lstrip('#'))
            label = line[level:].strip(); anchor = f'{prefix}-{heading_count}'
            heading_count += 1
            output.append(f'<h{min(level+1,6)} id="{anchor}">{inline(label)}</h{min(level+1,6)}>')
            if level == 2: toc.append((anchor, label))
        elif line.startswith('|'):
            rows = []
            while i < len(lines) and lines[i].startswith('|'):
                cells = [c.strip() for c in lines[i].strip('|').split('|')]
                if not all(re.fullmatch(r':?-+:?', c) for c in cells): rows.append(cells)
                i += 1
            output.append('<div class="table-wrap"><table><thead><tr>' + ''.join('<th>' + inline(c) + '</th>' for c in rows[0]) + '</tr></thead><tbody>')
            for row in rows[1:]: output.append('<tr>' + ''.join('<td>' + inline(c) + '</td>' for c in row) + '</tr>')
            output.append('</tbody></table></div>'); continue
        elif re.match(r'(- |\d+\. )', line):
            ordered = bool(re.match(r'\d+\. ', line)); tag = 'ol' if ordered else 'ul'
            output.append(f'<{tag}>')
            while i < len(lines) and re.match(r'\d+\. ' if ordered else r'- ', lines[i]):
                output.append('<li>' + inline(re.sub(r'^(- |\d+\. )', '', lines[i])) + '</li>'); i += 1
            output.append(f'</{tag}>'); continue
        else:
            output.append('<p>' + inline(line) + '</p>')
        i += 1
    return '\n'.join(output), toc

sections = []
navigation = []
for name, title, prefix in [('README.md','操作ガイド','guide'),('technical-audit.md','問題と修正確認','audit'),('rehearsal.md','練習環境','practice')]:
    content, toc = render((folder / name).read_text(), prefix)
    sections.append(f'<section id="{prefix}" aria-label="{title}">{content}</section>')
    navigation.append(f'<a class="chapter" href="#{prefix}">{title}</a>')
    if prefix == 'guide': navigation += [f'<a href="#{a}">{escape(t)}</a>' for a,t in toc]

html = '''<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>LINE Harness 操作ガイド</title><style>
:root{color-scheme:light;--ink:#24313d;--accent:#315c86}*{box-sizing:border-box}body{margin:0;background:#f5f5f2;color:var(--ink);font:16px/1.85 -apple-system,BlinkMacSystemFont,"Hiragino Kaku Gothic ProN",sans-serif}a{color:var(--accent);text-underline-offset:3px}header{padding:28px 36px;background:#24394d;color:white}header p{margin:6px 0 0;color:#dce4ec}h1{font-size:28px;margin:0;line-height:1.5}.layout{display:grid;grid-template-columns:260px minmax(0,960px);max-width:1260px;margin:auto;gap:28px;padding:28px}nav{position:sticky;top:16px;align-self:start;max-height:calc(100vh - 32px);overflow:auto;padding:8px 0}nav a{display:block;color:#435567;text-decoration:none;font-size:13px;padding:7px 10px;border-left:2px solid transparent}nav a:hover{border-color:#315c86;background:#e8eef3}.chapter{font-weight:700;margin:10px 0;font-size:16px}main{min-width:0}section{background:white;border:1px solid #dde2e6;border-radius:8px;padding:28px 36px;margin-bottom:28px}h2{font-size:24px;margin-top:0}h3{font-size:21px;border-top:1px solid #e1e6ea;padding-top:26px;margin-top:38px;scroll-margin-top:18px}h4{font-size:18px;margin:24px 0 12px}p{margin:12px 0}strong{color:#812c41}code{background:#f0f3f6;border-radius:4px;padding:2px 4px;font:13px/1.6 ui-monospace,monospace;overflow-wrap:anywhere}pre{overflow:auto;background:#f0f3f6;padding:18px;border-radius:6px}pre code{padding:0}.table-wrap{overflow-x:auto;margin:20px 0}table{border-collapse:collapse;font-size:14px;width:100%;min-width:560px}th,td{padding:11px 12px;vertical-align:top;text-align:left;border:1px solid #dce2e7}th{background:#eef2f5}img{max-width:100%;height:auto;border:1px solid #dce2e7;border-radius:6px}li{padding:3px 0}footer{padding:24px;font-size:13px;color:#607080;text-align:center}a:focus-visible{outline:3px solid #9ab9d6;outline-offset:3px}@media(max-width:900px){.layout{display:block;padding:16px}nav{position:static;max-height:none;display:flex;flex-wrap:wrap;gap:6px;margin-bottom:18px}nav a:not(.chapter){display:none}section{padding:22px 20px}header{padding:22px}h1{font-size:23px}h2{font-size:21px}h3{font-size:19px}}@media print{nav,header,footer{display:none}.layout{display:block;padding:0}section{border:0;padding:0;break-after:page}a{color:inherit}h3{break-after:avoid}.table-wrap{overflow:visible}table{min-width:0}img{max-height:350px;object-fit:contain}}
</style></head><body><header><h1>LINE Harness 操作ガイド</h1><p>個別相談・診断連携・配信設定・停止の使い方と、運用前に直す問題</p></header><div class="layout"><nav aria-label="目次">'''
html += '\n'.join(navigation) + '</nav><main>' + '\n'.join(sections) + '</main></div><footer>確認日 2026-10-09 · 画像はすべて架空データの練習画面 · ローカル閲覧用</footer></body></html>'
(folder / 'index.html').write_text(html)
print('Built docs/operator-guide/index.html')
