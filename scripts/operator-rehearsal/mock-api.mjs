// UI rehearsal only. All data is fictional, memory-only, and reset on restart.
// This is NOT a worker/LINE emulator or evidence of real delivery.
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const port = 8341;
const webOrigin = 'http://127.0.0.1:8342';
const now = () => new Date().toISOString();
const accountId = 'rehearsal-account';
const account = { id: accountId, channelId: 'DUMMY-NO-LINE', name: '練習用｜本番送信なし', displayName: '練習用｜本番送信なし', basicId: '@dummy', isActive: true, createdAt: now(), updatedAt: now(), stats: { friendCount: 2, activeScenarios: 0, messagesThisMonth: 0 } };
const tags = [{ id: 'tag-type-a', name: '練習：聞き上手タイプ', color: '#b65b80', createdAt: now() }, { id: 'tag-interview', name: '練習：面談希望', color: '#26719b', createdAt: now() }];
const friends = ['A', 'B'].map((v, i) => ({ id: `friend-${v}`, lineUserId: `DUMMY-${v}`, displayName: `練習ユーザー${v}`, pictureUrl: null, statusMessage: null, lineAccountId: accountId, isFollowing: true, createdAt: now(), updatedAt: now(), tags: i ? [] : [tags[0]] }));
const chats = [{ id: 'chat-A', friendId: friends[0].id, friendName: friends[0].displayName, friendPictureUrl: null, operatorId: null, status: 'unread', notes: null, lastMessageAt: now(), createdAt: now(), updatedAt: now(), messages: [{ id: 'msg-A', direction: 'incoming', messageType: 'text', content: '【架空の練習データ】面談について相談したいです。', createdAt: now() }] }];
const scenarios = [{ id: 'scenario-demo', name: '練習：面談のご案内', description: '架空データ。実際の配信は行いません。', triggerType: 'manual', triggerTagId: null, isActive: false, lineAccountId: accountId, createdAt: now(), updatedAt: now(), steps: [{ id: 'step-demo', scenarioId: 'scenario-demo', stepOrder: 1, delayMinutes: 0, messageType: 'text', messageContent: '【練習】相談へのお礼。', createdAt: now() }] }];
const stores = { scenarios, broadcasts: [], automations: [], reminders: [], templates: [], affiliates: [], users: [] };
const requests = [];
const ledger = '/tmp/line-harness-operator-rehearsal-20261009.jsonl';
const ok = (data) => ({ success: true, data });

createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (origin === webOrigin) {
    res.setHeader('Access-Control-Allow-Origin', webOrigin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const u = new URL(req.url, `http://127.0.0.1:${port}`);
  const parts = u.pathname.split('/').filter(Boolean);
  let body = {};
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    if (raw) body = JSON.parse(raw);
  } catch { res.writeHead(400); res.end(JSON.stringify({ success: false, error: 'Invalid JSON' })); return; }
  const record = { at: now(), method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), ...(req.method !== 'GET' ? { body } : {}) };
  requests.push(record);
  appendFileSync(ledger, JSON.stringify(record) + '\n', { mode: 0o600 });
  let result;
  if (u.pathname === '/rehearsal/requests') result = requests;
  else if (u.pathname === '/rehearsal/state') result = { account, stores, chats, friends };
  else if (u.pathname === '/api/line-accounts' && req.method === 'GET') result = ok([account]);
  else if (u.pathname === '/api/staff/me') result = ok({ name: '練習スタッフ', role: 'owner', permissions: {} });
  else if (u.pathname === '/api/friends/count') result = ok({ count: friends.length });
  else if (u.pathname === '/api/friends' && req.method === 'GET') {
    const list = u.searchParams.get('tagId') ? friends.filter(f => f.tags.some(t => t.id === u.searchParams.get('tagId'))) : friends;
    result = ok({ items: list, total: list.length, hasNextPage: false, offset: 0, limit: 20 });
  } else if (parts[1] === 'friends' && parts[2]) {
    const f = friends.find(f => f.id === parts[2]);
    if (parts[3] === 'tags' && req.method === 'POST') f?.tags.push(tags.find(t => t.id === body.tagId));
    if (parts[3] === 'tags' && req.method === 'DELETE' && f) f.tags = f.tags.filter(t => t.id !== parts[4]);
    result = ok(parts[3] === 'messages' ? chats[0].messages : parts[3] === 'score' ? { totalScore: 0, history: [] } : f);
  } else if (u.pathname === '/api/tags') result = ok(tags);
  else if (parts[1] === 'chats') {
    const chat = chats.find(c => c.id === parts[2]);
    if (!parts[2]) result = ok(chats.filter(c => !u.searchParams.get('status') || c.status === u.searchParams.get('status')));
    else if (parts[3] === 'send') {
      chat.messages.push({ id: randomUUID(), direction: 'outgoing', messageType: body.messageType || 'text', content: body.content, createdAt: now() });
      result = ok({ simulated: true, deliveredToLine: false });
    } else if (req.method === 'PUT') { Object.assign(chat, body); result = ok(chat); }
    else result = ok(chat);
  } else if (stores[parts[1]]) {
    const name = parts[1];
    const list = stores[name];
    const item = list.find(v => v.id === parts[2]);
    if (!parts[2] && req.method === 'GET') {
      // Match the source's exact account-filter behavior, including missing-save scope.
      const aid = u.searchParams.get('lineAccountId');
      result = ok(list.filter(v => !aid || v.lineAccountId === aid).map(v => ({ ...v, stepCount: v.steps?.length || 0 })));
    } else if (!parts[2] && req.method === 'POST') {
      const created = { ...body, id: randomUUID(), createdAt: now(), updatedAt: now(), lineAccountId: body.lineAccountId || null, steps: [], isActive: body.isActive ?? true };
      if (name === 'broadcasts') Object.assign(created, { status: body.scheduledAt ? 'scheduled' : 'draft', totalCount: 0, successCount: 0 });
      list.push(created); result = ok(created);
    } else if (parts[3] === 'steps' && req.method === 'POST') {
      const step = { ...body, id: randomUUID(), scenarioId: item.id, createdAt: now() };
      item.steps.push(step); result = ok(step);
    } else if (parts[3] === 'steps' && req.method === 'DELETE') { item.steps = item.steps.filter(s => s.id !== parts[4]); result = ok(null); }
    else if (parts[3] === 'send') { item.status = 'sent'; result = ok({ ...item, simulated: true, deliveredToLine: false }); }
    else if (req.method === 'PUT') { Object.assign(item, body); result = ok(item); }
    else if (req.method === 'DELETE') { list.splice(list.indexOf(item), 1); result = ok(null); }
    else result = ok(item);
  } else if (u.pathname.includes('/report') || u.pathname.includes('/rules') || u.pathname.includes('/notifications') || u.pathname.includes('/webhooks') || u.pathname.includes('/form-submissions')) result = ok([]);
  else { res.writeHead(404); res.end(JSON.stringify({ success: false, error: `Fixture endpoint unavailable: ${u.pathname}` })); return; }
  res.end(JSON.stringify(result));
}).listen(port, '127.0.0.1', () => console.log(`Dummy UI API: http://127.0.0.1:${port}; no outbound network code; ledger ${ledger}`));
