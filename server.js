// Don't Block Me: backend (Express + libSQL/Turso + Razorpay)
const express = require('express');
const { createClient } = require('@libsql/client');
const crypto = require('crypto');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const {
  PAYMENT_MODE: MODE = 'razorpay',
  PRICE_RS = '10',
  RAZORPAY_KEY_ID: KEY, RAZORPAY_KEY_SECRET: SECRET,
  ADMIN_PASSWORD: ADMIN, PORT = 3000,
  DB_URL = 'file:data.db', DB_TOKEN,
  UPI_ID = 'yourname@paytm',
} = process.env;

// Non-crashing warnings if keys are missing
if (!process.env.ADMIN_PASSWORD) {
  console.warn('⚠️ WARNING: ADMIN_PASSWORD environment variable is not set. Using default fallback.');
}
if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
  console.warn('⚠️ WARNING: Razorpay keys are missing. Payments will fail until you add them in Render.');
}

const PRICE = Math.round(Number(PRICE_RS) * 100); // paise

const db = createClient({ url: DB_URL, authToken: DB_TOKEN });
const q = (sql, args = []) => db.execute({ sql, args }).then((r) => r.rows);
const one = async (sql, args = []) => (await q(sql, args))[0];
const plain = (rows, cols) => rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]])));

const now = () => Date.now();
const uid = () => crypto.randomBytes(6).toString('base64url');
const vid = (req) => String(req.get('x-visitor') || 'anon').slice(0, 64);
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const bad = (res, msg = 'Bad request', code = 400) => res.status(code).json({ error: msg });
const ah = (fn) => (req, res) => fn(req, res).catch((e) => { console.error(e); bad(res, 'Server error', 500); });

const app = express();
app.set('trust proxy', 1);
app.use(helmet({
  upgradeInsecureRequests: null,
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
  contentSecurityPolicy: { directives: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", "'unsafe-inline'", 'https://checkout.razorpay.com'],
    frameSrc: ['https://api.razorpay.com', 'https://checkout.razorpay.com'],
    connectSrc: ["'self'", 'https://lumberjack.razorpay.com', 'https://api.razorpay.com'],
    imgSrc: ["'self'", 'data:', 'https://*.razorpay.com'],
    styleSrc: ["'self'", "'unsafe-inline'"],
  } },
}));
app.use(express.json({ limit: '100kb' }));
app.use('/api/', rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false }));
app.use(express.static('public'));

app.get('/api/config', (_req, res) => res.json({
  mode: MODE,
  price: PRICE / 100,
  keyId: KEY,
  upiId: UPI_ID,
}));

// ---------- tracking (anonymous visitor id only) ----------
app.post('/api/track', ah(async (req, res) => {
  const { event, quiz } = req.body || {};
  if (!['open', 'start_create', 'start_play', 'pay_click'].includes(event)) return bad(res);
  const v = vid(req), t = now(), qz = quiz ? String(quiz).slice(0, 20) : null;
  const dev = /mobile|android|iphone/i.test(req.get('user-agent') || '') ? 'mobile' : 'desktop';
  await q(`INSERT INTO visitors(id,first_seen,last_seen,device,ref_quiz,opens) VALUES(?,?,?,?,?,0)
            ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen`, [v, t, t, dev, qz]);
  if (event === 'open') await q('UPDATE visitors SET opens=opens+1 WHERE id=?', [v]);
  await q('INSERT INTO events(ts,visitor,event,quiz) VALUES(?,?,?,?)', [t, v, event, qz]);
  res.json({ ok: true });
}));

// ---------- payments: Razorpay (automatic, signature-verified) ----------
app.post('/api/order', ah(async (req, res) => {
  const { kind, quiz } = req.body || {};
  if (!['create', 'play'].includes(kind)) return bad(res);
  if (kind === 'play' && !(await one('SELECT 1 x FROM quizzes WHERE id=?', [String(quiz)]))) return bad(res, 'Quiz not found', 404);
  const r = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + Buffer.from(KEY + ':' + SECRET).toString('base64') },
    body: JSON.stringify({ amount: PRICE, currency: 'INR', receipt: 'r_' + uid(), notes: { kind, quiz: quiz || '' } }),
  });
  const o = await r.json();
  if (!r.ok) { console.error(o); return bad(res, 'Could not start payment', 500); }
  await q('INSERT INTO payments(order_id,kind,quiz,status,used,amount,created,visitor,method) VALUES(?,?,?,?,0,?,?,?,?)',
    [o.id, kind, kind === 'play' ? String(quiz) : null, 'created', PRICE, now(), vid(req), 'razorpay']);
  res.json({ orderId: o.id, amount: PRICE, keyId: KEY });
}));

app.post('/api/verify', ah(async (req, res) => {
  const { razorpay_order_id: o, razorpay_payment_id: p, razorpay_signature: s } = req.body || {};
  if (!o || !p || !s) return bad(res);
  const expected = crypto.createHmac('sha256', SECRET).update(o + '|' + p).digest('hex');
  if (!safeEq(expected, s)) return bad(res, 'Invalid payment signature');
  
  const row = await one('SELECT * FROM payments WHERE order_id=?', [o]);
  if (!row) return bad(res, 'Order not found', 404);
  if (row.status === 'revoked') return bad(res, 'Payment has been revoked', 400);

  if (row.status !== 'paid') {
    await q("UPDATE payments SET status='paid', payment_id=?, pass=?, paid_at=? WHERE order_id=?", 
      [String(p), crypto.randomBytes(16).toString('hex'), now(), o]);
  }
  res.json({ pass: (await one('SELECT pass FROM payments WHERE order_id=?', [o])).pass });
}));

// A "pass" proves one payment and works once.
const passRow = async (req, kind) => {
  const p = req.get('x-pass');
  return p ? await one("SELECT * FROM payments WHERE pass=? AND status='paid' AND used=0 AND kind=?", [String(p), kind]) : undefined;
};

const usePass = async (orderId) => {
  const result = await db.execute({ sql: 'UPDATE payments SET used=1 WHERE order_id=? AND used=0', args: [orderId] });
  return Number(result.rowsAffected) === 1;
};

// ---------- quizzes ----------
function clean(name, questions, answers) {
  name = String(name || '').trim().slice(0, 15);
  if (!name || !Array.isArray(questions) || questions.length < 3 || questions.length > 40) return null;
  if (!Array.isArray(answers) || answers.length !== questions.length) return null;
  const qs = [];
  for (const x of questions) {
    if (!Array.isArray(x) || !Array.isArray(x[1])) return null;
    const t = String(x[0] || '').trim().slice(0, 80);
    const o = x[1].map((y) => String(y).trim().slice(0, 24)).filter(Boolean).slice(0, 4);
    if (!t || o.length < 2) return null;
    qs.push([t, o]);
  }
  const ans = answers.map(Number);
  if (ans.some((a, i) => !Number.isInteger(a) || a < 0 || a >= qs[i][1].length)) return null;
  return { name, qs, ans };
}

app.post('/api/quiz', ah(async (req, res) => {
  const row = await passRow(req, 'create');
  if (!row) return bad(res, 'Payment required', 402);
  const c = clean(req.body.name, req.body.questions, req.body.answers);
  if (!c) return bad(res, 'Invalid quiz');
  if (!(await usePass(row.order_id))) return bad(res, 'Payment already used', 402);
  const id = uid(), key = crypto.randomBytes(12).toString('base64url');
  await q('INSERT INTO quizzes(id,key,name,questions,answers,created,visitor) VALUES(?,?,?,?,?,?,?)',
    [id, key, c.name, JSON.stringify(c.qs), JSON.stringify(c.ans), now(), vid(req)]);
  res.json({ id, key });
}));

app.get('/api/quiz/:id', ah(async (req, res) => {
  const r = await one('SELECT id,name,questions FROM quizzes WHERE id=?', [req.params.id]);
  if (!r) return bad(res, 'Quiz not found', 404);
  res.json({ id: r.id, n: r.name, q: JSON.parse(r.questions) });
}));

app.post('/api/quiz/:id/play', ah(async (req, res) => {
  const r = await one('SELECT * FROM quizzes WHERE id=?', [req.params.id]);
  if (!r) return bad(res, 'Quiz not found', 404);
  const row = await passRow(req, 'play');
  if (!row || row.quiz !== r.id) return bad(res, 'Payment required', 402);
  const player = String((req.body || {}).player || '').trim().slice(0, 15);
  const g = (req.body || {}).guesses, a = JSON.parse(r.answers);
  if (!player || !Array.isArray(g) || g.length !== a.length) return bad(res);
  if (!(await usePass(row.order_id))) return bad(res, 'Payment already used', 402);
  const score = a.reduce((s, x, i) => s + (Number(g[i]) === x ? 1 : 0), 0);
  await q('INSERT INTO plays(quiz,player,score,total,ts,visitor) VALUES(?,?,?,?,?,?)', [r.id, player, score, a.length, now(), vid(req)]);
  res.json({ score, total: a.length });
}));

app.get('/api/quiz/:id/scores', ah(async (req, res) => {
  const r = await one('SELECT * FROM quizzes WHERE id=?', [req.params.id]);
  if (!r || !safeEq(req.get('x-key') || '', r.key)) return bad(res, 'Forbidden', 403);
  const rows = await q('SELECT player,score,total,ts FROM plays WHERE quiz=? ORDER BY score*1.0/total DESC, ts ASC', [r.id]);
  res.json({ name: r.name, scores: plain(rows, ['player', 'score', 'total', 'ts']) });
}));

// ---------- admin ----------
const adminOnly = (req, res, next) => (safeEq(req.get('x-admin') || '', ADMIN) ? next() : bad(res, 'Unauthorized', 401));
app.get('/api/admin/stats', adminOnly, ah(async (_req, res) => {
  const n = async (sql, a = []) => Number((await one(sql, a)).c);
  const t = now(), DAY = 864e5, ev = (e) => n('SELECT COUNT(*) c FROM events WHERE event=?', [e]);
  const paid = await one("SELECT COUNT(*) c, COALESCE(SUM(amount),0) s FROM payments WHERE status='paid'");
  res.json({
    mode: MODE,
    visitors: await n('SELECT COUNT(*) c FROM visitors'),
    newVisitors24h: await n('SELECT COUNT(*) c FROM visitors WHERE first_seen>?', [t - DAY]),
    active24h: await n('SELECT COUNT(*) c FROM visitors WHERE last_seen>?', [t - DAY]),
    mobile: await n("SELECT COUNT(*) c FROM visitors WHERE device='mobile'"),
    opens: await ev('open'), startCreate: await ev('start_create'), startPlay: await ev('start_play'), payClicks: await ev('pay_click'),
    quizzes: await n('SELECT COUNT(*) c FROM quizzes'),
    plays: await n('SELECT COUNT(*) c FROM plays'),
    paidCount: Number(paid.c), revenueRs: Number(paid.s) / 100,
    daily: plain(await q("SELECT date(ts/1000,'unixepoch','+330 minutes') d, COUNT(*) opens, COUNT(DISTINCT visitor) users FROM events WHERE event='open' AND ts>? GROUP BY d ORDER BY d", [t - 14 * DAY]), ['d', 'opens', 'users']),
    recentPayments: plain(await q("SELECT order_id,payment_id,kind,amount,paid_at,method,status,used FROM payments WHERE status IN ('paid','revoked') ORDER BY paid_at DESC LIMIT 40"), ['order_id', 'payment_id', 'kind', 'amount', 'paid_at', 'method', 'status', 'used']),
    recentPlays: plain(await q('SELECT p.player,p.score,p.total,p.ts,q.name creator FROM plays p JOIN quizzes q ON q.id=p.quiz ORDER BY p.ts DESC LIMIT 30'), ['player', 'score', 'total', 'ts', 'creator']),
    recentVisitors: plain(await q('SELECT substr(id,1,8) id,first_seen,last_seen,device,opens,ref_quiz FROM visitors ORDER BY last_seen DESC LIMIT 30'), ['id', 'first_seen', 'last_seen', 'device', 'opens', 'ref_quiz']),
  });
}));

app.post('/api/admin/revoke', adminOnly, ah(async (req, res) => {
  await q("UPDATE payments SET status='revoked' WHERE order_id=?", [String((req.body || {}).order_id || '')]);
  res.json({ ok: true });
}));

app.get('/healthz', (_req, res) => res.send('ok'));

(async () => {
  await db.batch([
    'CREATE TABLE IF NOT EXISTS visitors(id TEXT PRIMARY KEY, first_seen INTEGER, last_seen INTEGER, device TEXT, ref_quiz TEXT, opens INTEGER DEFAULT 0)',
    'CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, visitor TEXT, event TEXT, quiz TEXT)',
    'CREATE TABLE IF NOT EXISTS quizzes(id TEXT PRIMARY KEY, key TEXT, name TEXT, questions TEXT, answers TEXT, created INTEGER, visitor TEXT)',
    'CREATE TABLE IF NOT EXISTS plays(id INTEGER PRIMARY KEY AUTOINCREMENT, quiz TEXT, player TEXT, score INTEGER, total INTEGER, ts INTEGER, visitor TEXT)',
    'CREATE TABLE IF NOT EXISTS payments(order_id TEXT PRIMARY KEY, payment_id TEXT, kind TEXT, quiz TEXT, status TEXT, pass TEXT, used INTEGER DEFAULT 0, amount INTEGER, created INTEGER, paid_at INTEGER, visitor TEXT, method TEXT)',
    'CREATE INDEX IF NOT EXISTS ev_ts ON events(ts)',
    'CREATE INDEX IF NOT EXISTS pl_quiz ON plays(quiz)',
  ], 'write');
  app.listen(PORT, () => console.log(`Listening on ${PORT} · payments: ${MODE} · price ₹${PRICE / 100}`));
})();