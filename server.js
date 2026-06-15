require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const session = require('express-session');
const { google } = require('googleapis');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const multer = require('multer');
const fs = require('fs');
const OpenAI = require('openai');
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
const Stripe = (() => { try { return require('stripe'); } catch(e) { return null; } })();
const stripe = (Stripe && process.env.STRIPE_SECRET_KEY) ? Stripe(process.env.STRIPE_SECRET_KEY) : null;

const mailer = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASS }
});

async function sendMail(to, subject, text) {
  try {
    await mailer.sendMail({ from: `"NiceMeet" <${process.env.GMAIL_USER}>`, to, subject, text });
  } catch(e) { console.error('mail error:', e.message); }
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// DB setup
const db = new Database(path.join(__dirname, 'data', 'booking.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    google_id TEXT UNIQUE,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    access_token TEXT,
    refresh_token TEXT,
    password_hash TEXT,
    slug TEXT UNIQUE NOT NULL,
    slot_duration INTEGER DEFAULT 30
  );
  CREATE TABLE IF NOT EXISTS availability (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    day_of_week INTEGER NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    UNIQUE(user_id, day_of_week)
  );
  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    booker_name TEXT NOT NULL,
    booker_email TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    purpose TEXT,
    meet_room TEXT NOT NULL,
    google_event_id TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);
// 既存DBへのマイグレーション: google_idをNULL許容に変更
try {
  const cols = db.prepare('PRAGMA table_info(users)').all();
  const gCol = cols.find(c => c.name === 'google_id');
  if (gCol && gCol.notnull === 1) {
    db.exec(`
      BEGIN;
      CREATE TABLE users_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        google_id TEXT UNIQUE,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        access_token TEXT,
        refresh_token TEXT,
        password_hash TEXT,
        slug TEXT UNIQUE NOT NULL,
        slot_duration INTEGER DEFAULT 30
      );
      INSERT INTO users_new (id,google_id,name,email,access_token,refresh_token,slug,slot_duration)
        SELECT id,google_id,name,email,access_token,refresh_token,slug,slot_duration FROM users;
      DROP TABLE users;
      ALTER TABLE users_new RENAME TO users;
      COMMIT;
    `);
    console.log('DB migration: google_id is now nullable');
  }
} catch(e) { console.error('migration error:', e.message); }
try { db.exec('ALTER TABLE users ADD COLUMN password_hash TEXT'); } catch(e) {}
try { db.exec('ALTER TABLE bookings ADD COLUMN cancel_token TEXT'); } catch(e) {}
try { db.exec('ALTER TABLE bookings ADD COLUMN cancelled INTEGER DEFAULT 0'); } catch(e) {}
try { db.exec("ALTER TABLE users ADD COLUMN plan TEXT DEFAULT 'free'"); } catch(e) {}
try { db.exec('ALTER TABLE users ADD COLUMN plan_expires TEXT'); } catch(e) {}
try { db.exec('ALTER TABLE users ADD COLUMN stripe_customer_id TEXT'); } catch(e) {}

// ── 施設サブスク管理テーブル ──────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS nm_facilities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    admin_email TEXT NOT NULL,
    contact_name TEXT,
    phone TEXT,
    trial_started_at TEXT DEFAULT (datetime('now')),
    trial_status TEXT DEFAULT 'trial',
    early_adopter INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS nm_locations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    facility_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS nm_location_count_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    facility_id INTEGER NOT NULL,
    location_count INTEGER NOT NULL,
    changed_at TEXT DEFAULT (datetime('now')),
    note TEXT
  );
  CREATE TABLE IF NOT EXISTS nm_meetings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    facility_id INTEGER,
    room_id TEXT,
    host_email TEXT,
    started_at TEXT,
    ended_at TEXT,
    duration_minutes REAL DEFAULT 0,
    ai_summary_used INTEGER DEFAULT 0,
    summary_text TEXT
  );
  CREATE TABLE IF NOT EXISTS nm_call_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    facility_id INTEGER,
    room_id TEXT,
    welfare_system TEXT,
    record_type TEXT,
    member_name TEXT,
    staff_name TEXT,
    interview_date TEXT DEFAULT (date('now')),
    summary_text TEXT,
    raw_transcript TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS nm_inquiries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    facility_id INTEGER,
    name TEXT,
    email TEXT,
    message TEXT,
    submitted_at TEXT DEFAULT (datetime('now')),
    status TEXT DEFAULT 'new'
  );
`);
try { db.exec('ALTER TABLE users ADD COLUMN facility_id INTEGER'); } catch(e) {}
try { db.exec("ALTER TABLE users ADD COLUMN ui_mode TEXT DEFAULT 'simple'"); } catch(e) {}
try { db.exec("ALTER TABLE nm_call_records ADD COLUMN status TEXT DEFAULT 'confirmed'"); } catch(e) {}
try { db.exec("ALTER TABLE nm_call_records ADD COLUMN source TEXT DEFAULT 'video'"); } catch(e) {}

// ── 施設サブスク ヘルパー ────────────────────────────────────────
function calcMonthlyAmount(locationCount, isEarlyAdopter) {
  const unit = locationCount === 1
    ? (isEarlyAdopter ? 2980 : 4980)
    : locationCount <= 3 ? 2480 : 1980;
  return { unit, total: locationCount * unit };
}
function getFacilityStatus(facility) {
  if (!facility) return 'none';
  if (facility.trial_status === 'active') return 'active';
  const daysSince = (Date.now() - new Date(facility.trial_started_at).getTime()) / 86400000;
  return daysSince > 30 ? 'expired' : 'trial';
}
function getMonthlyUsageMinutes(facilityId) {
  const ym = new Date().toISOString().slice(0, 7);
  const row = db.prepare(
    "SELECT COALESCE(SUM(duration_minutes),0) as total FROM nm_meetings WHERE facility_id=? AND substr(started_at,1,7)=?"
  ).get(facilityId, ym);
  return row?.total || 0;
}
function getTrialDaysLeft(facility) {
  const daysSince = (Date.now() - new Date(facility.trial_started_at).getTime()) / 86400000;
  return Math.max(0, Math.ceil(30 - daysSince));
}
// ─────────────────────────────────────────────────────────────────

// ── 福祉記録プロンプトテンプレート ───────────────────────────────
const WELFARE_RECORD_TYPES = {
  houdei: {
    label: '放課後等デイサービス',
    types: ['個別支援計画モニタリング記録', '保護者面談記録', 'サービス担当者会議記録']
  },
  houmon: {
    label: '訪問介護',
    types: ['モニタリング記録', 'サービス担当者会議記録']
  },
  shuro: {
    label: '就労継続支援',
    types: ['個別支援計画モニタリング記録', 'サービス担当者会議記録', '就労移行支援会議記録']
  },
  kaigo: {
    label: '介護グループホーム',
    types: ['モニタリング記録', '家族面談記録', '運営推進会議記録', 'サービス担当者会議記録']
  }
};

const WELFARE_PROMPTS = {
  houdei: {
    '個別支援計画モニタリング記録': `以下は放課後等デイサービスにおける個別支援計画モニタリング面談の文字起こしです。「個別支援計画モニタリング記録」として業務記録文体（〜が見られた／〜に取り組んだ／〜が確認された）で作成してください。
禁止表現：「問題行動」→「気になる行動」「支援が必要な場面」に言い換え。「できない」ではなく「〜に向けて支援中」。
以下の見出しで記述してください：
【本人の様子・心身の状態】
【5領域別の現況】健康・生活 / 運動・感覚 / 認知・行動 / 言語・コミュニケーション / 人間関係・社会性
【短期目標の達成状況】目標ごとに「達成／概ね達成／取組中」で評価
【保護者からの意見・要望】「保護者より〜との申し出あり」形式で
【今後の支援方針】
【計画変更の要否と内容】
【次回モニタリング予定】`,

    '保護者面談記録': `以下は放課後等デイサービスにおける保護者面談の文字起こしです。「保護者面談記録」として業務記録文体で作成してください。
以下の見出しで記述してください：
【面談目的・経緯】
【家庭での様子（保護者報告）】「保護者より〜との報告あり」形式で
【本人の状態・変化】
【保護者の主な意見・要望】
【合意事項・決定内容】
【次回連絡・面談予定】`,

    'サービス担当者会議記録': `以下は放課後等デイサービスにおけるサービス担当者会議の文字起こしです。「サービス担当者会議記録」として業務記録文体で作成してください。
以下の見出しで記述してください：
【開催目的・参加者】（職種・続柄で記載）
【各担当者からの情報共有】
【本人・家族の意向】
【支援方針の合意内容】
【役割分担・対応事項】
【次回開催予定】`
  },

  houmon: {
    'モニタリング記録': `以下は訪問介護におけるモニタリング面談の文字起こしです。「モニタリング記録」として介護保険事業所の業務記録文体（〜を実施した／〜が見られた／〜の申し出があった）で作成してください。
禁止表現：「いつものように」「特に問題なし」だけの記録は避け、具体的な内容を記述すること。「〜させた」という強制表現は使わない。
以下の見出しで記述してください：
【利用者の現状（身体・生活状況の変化）】
【訪問介護サービスの実施状況】
【本人・家族の意向・要望】「ご本人より〜との意向が示された」「ご家族より〜との申し出があった」形式で
【問題点・特記事項】
【ケアプランとの整合性・変更の要否】
【次回モニタリング予定・対応事項】`,

    'サービス担当者会議記録': `以下は訪問介護におけるサービス担当者会議の文字起こしです。「サービス担当者会議記録」として業務記録文体で作成してください。
以下の見出しで記述してください：
【開催目的・参加者】（職種・事業所名を記載）
【利用者・家族の状況報告】
【各サービス事業所からの情報共有】
【課題・検討事項】
【ケアプランの変更内容・合意事項】
【役割分担・次回確認事項】`
  },

  shuro: {
    '個別支援計画モニタリング記録': `以下は就労継続支援におけるモニタリング面談の文字起こしです。「個別支援計画モニタリング記録」としてサービス管理責任者（サビ管）が作成する業務記録文体（〜に取り組んだ／〜の意向が示された／〜が確認された）で作成してください。
禁止表現：「就労が困難な利用者」「問題利用者」等の否定的・差別的表現は使わない。自己決定を尊重する表現を使用。
以下の見出しで記述してください：
【利用者の現状（作業・生活状況・健康状態）】
【就労意欲・将来の目標（本人の言葉を中心に）】「ご本人より〜との意向が示された」形式で
【作業能力・対人関係の変化】
【短期目標・長期目標の達成状況】
【課題と支援内容】
【今後の支援方針・計画変更の要否】
【関係機関との連携事項】
【次回面談予定】`,

    'サービス担当者会議記録': `以下は就労継続支援におけるサービス担当者会議の文字起こしです。「サービス担当者会議記録」として業務記録文体で作成してください。
以下の見出しで記述してください：
【開催目的・参加者】（職種・関係機関を記載）
【利用者の現状報告】
【各担当者からの意見・情報提供】
【本人・家族の意向】
【支援方針の決定・合意内容】
【次回開催予定・対応事項】`,

    '就労移行支援会議記録': `以下は就労継続支援における就労移行・関係機関との会議の文字起こしです。「就労移行支援会議記録」として業務記録文体で作成してください。
以下の見出しで記述してください：
【開催目的・参加者】（ハローワーク・就労支援センター等の外部機関も明記）
【就労状況・職場環境の報告】
【本人の状態・意向】
【職場・支援機関からのフィードバック】
【今後の支援方針・役割分担】
【次回確認事項・予定】`
  },

  kaigo: {
    'モニタリング記録': `以下は介護グループホームにおけるモニタリング面談の文字起こしです。「モニタリング記録」として介護事業所の業務記録文体（〜の様子であった／〜が確認された／〜が見られた）で作成してください。
禁止表現：「徘徊」→「ひとり歩き」、「問題行動」→「BPSD」「気になる言動」、「意思疎通困難」→「本人なりのコミュニケーションが見られる」に言い換え。
以下の見出しで記述してください：
【入居者の様子・心身状態の変化】（ADL・認知機能・BPSD含む）
【日常生活・活動への参加状況】
【ケアプランの目標達成状況】
【家族の意向・来訪時の様子】「ご家族より〜の申し出あり」形式で
【医療・看護との連携状況】
【課題と今後のケア方針】
【計画変更の要否と内容】
【次回モニタリング予定】`,

    '家族面談記録': `以下は介護グループホームにおける家族面談の文字起こしです。「家族面談記録」として業務記録文体で作成してください。
以下の見出しで記述してください：
【面談目的・参加者】（続柄を記載）
【入居者の近況報告】
【家族からの意見・要望・確認事項】
【共有した事項・説明内容】
【合意事項・今後の対応】
【次回連絡・面談予定】`,

    '運営推進会議記録': `以下は介護グループホームにおける運営推進会議の文字起こしです。「運営推進会議記録」として業務記録文体で作成してください。地域住民等への開示を前提とした表現を使用してください。
以下の見出しで記述してください：
【開催日時・場所・参加者】（地域住民・行政担当者・家族代表等の立場を明記）
【事業所の活動状況報告】
【利用者の状況（個人が特定されない形で）】
【地域との連携・意見交換内容】
【決定事項・対応事項】
【次回開催予定】`,

    'サービス担当者会議記録': `以下は介護グループホームにおけるサービス担当者会議の文字起こしです。「サービス担当者会議記録」として業務記録文体で作成してください。
以下の見出しで記述してください：
【開催目的・参加者】（職種・事業所を記載）
【入居者の現状・各職種からの評価】
【家族の意向】
【ケアプランの変更内容・合意事項】
【役割分担・次回確認事項】`
  }
};
// ─────────────────────────────────────────────────────────────────

// パスワードハッシュ
async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await new Promise((res, rej) =>
    crypto.scrypt(password, salt, 64, (e, k) => e ? rej(e) : res(k.toString('hex')))
  );
  return salt + ':' + hash;
}
async function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const attempt = await new Promise((res, rej) =>
    crypto.scrypt(password, salt, 64, (e, k) => e ? rej(e) : res(k.toString('hex')))
  );
  return attempt === hash;
}

app.set('trust proxy', 1);
app.use(express.json({
  verify: (req, res, buf) => { if (req.path === '/api/stripe/webhook') req.rawBody = buf; }
}));
app.use(express.static(path.join(__dirname, 'public')));
const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: 'auto', httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 }
});
app.use(sessionMiddleware);
io.use((socket, next) => {
  sessionMiddleware(socket.request, socket.request.res || {}, next);
});

const REDIRECT_URI = 'https://meet.gaiaarts.org/auth/google/callback';

function getOAuthClient(tokens) {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    REDIRECT_URI
  );
  if (tokens) client.setCredentials(tokens);
  return client;
}

// サービスアカウントでカレンダー操作
const serviceAuth = new google.auth.GoogleAuth({
  keyFile: path.join(__dirname, 'service-account.json'),
  scopes: ['https://www.googleapis.com/auth/calendar']
});
function getCalendarClient() {
  return google.calendar({ version: 'v3', auth: serviceAuth });
}

// ---- Auth ----
// Whisperハルシネーション検出（同じ単語の繰り返しを除外）
const HALLUCINATION_PHRASES = [
  'ご視聴ありがとうございました',
  'チャンネル登録',
  'いいねボタン',
  'サブスクライブ',
  '次の動画でお会いしましょう',
  'この動画が良かったら',
  'ご覧いただきありがとうございました',
  '字幕を使用することで',
  'ビデオの字幕を読む',
  '日本語のビデオの字幕',
  '以下は日本語のビデオ',
  'かわいい かわいい',
];
function isWhisperHallucination(text) {
  if (!text || text.length < 3) return true;
  // 既知の幻覚フレーズ
  for (const phrase of HALLUCINATION_PHRASES) {
    if (text.includes(phrase)) return true;
  }
  // 句読点単位の繰り返し（「。」「、」で分割）
  const segs = text.split(/[。！？\n]+/).map(s => s.trim()).filter(s => s.length > 2);
  if (segs.length >= 3) {
    const uniqSegs = new Set(segs);
    if (uniqSegs.size / segs.length < 0.5) return true;
  }
  // 単語単位の繰り返し
  const words = text.split(/[\s、。！？]+/).filter(w => w.length > 0);
  if (words.length >= 4) {
    const unique = new Set(words);
    if (unique.size / words.length < 0.3) return true;
  }
  return false;
}

app.get('/auth/google', (req, res) => {
  const url = getOAuthClient().generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/userinfo.email'
    ],
    prompt: 'consent'
  });
  res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
  try {
    const client = getOAuthClient();
    const { tokens } = await client.getToken(req.query.code);
    client.setCredentials(tokens);
    const { data } = await google.oauth2({ version: 'v2', auth: client }).userinfo.get();

    const existing = db.prepare('SELECT id, slug, refresh_token FROM users WHERE google_id = ?').get(data.id);
    if (existing) {
      const rt = tokens.refresh_token || existing.refresh_token;
      db.prepare('UPDATE users SET name=?, email=?, access_token=?, refresh_token=? WHERE google_id=?')
        .run(data.name, data.email, tokens.access_token, rt, data.id);
      req.session.userId = existing.id;
      req.session.slug = existing.slug;
    } else {
      let slug = data.name.toLowerCase().replace(/[^a-z0-9]/g, '') || 'user';
      let base = slug, i = 1;
      while (db.prepare('SELECT id FROM users WHERE slug=?').get(slug)) slug = base + i++;
      const r = db.prepare('INSERT INTO users (google_id, name, email, access_token, refresh_token, slug) VALUES (?,?,?,?,?,?)')
        .run(data.id, data.name, data.email, tokens.access_token, tokens.refresh_token, slug);
      req.session.userId = r.lastInsertRowid;
      req.session.slug = slug;
    }
    res.redirect('/booking/dashboard');
  } catch (e) {
    console.error(e);
    res.redirect('/booking?error=1');
  }
});

app.get('/auth/logout', (req, res) => { req.session.destroy(); res.redirect('/booking'); });

// ---- メール＋パスワード登録 ----
app.post('/auth/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.json({ error: '全項目を入力してください' });
  if (password.length < 8) return res.json({ error: 'パスワードは8文字以上にしてください' });
  if (db.prepare('SELECT id FROM users WHERE email=?').get(email))
    return res.json({ error: 'このメールアドレスはすでに登録されています' });
  let slug = name.toLowerCase().replace(/[^a-z0-9]/g, '') || 'user';
  let base = slug, i = 1;
  while (db.prepare('SELECT id FROM users WHERE slug=?').get(slug)) slug = base + i++;
  const password_hash = await hashPassword(password);
  const r = db.prepare('INSERT INTO users (name, email, password_hash, slug) VALUES (?,?,?,?)')
    .run(name, email, password_hash, slug);
  req.session.userId = r.lastInsertRowid;
  req.session.slug = slug;
  res.json({ ok: true });
});

// ---- メール＋パスワードログイン ----
app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.json({ error: 'メールアドレスとパスワードを入力してください' });
  const user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  if (!user || !user.password_hash) return res.json({ error: 'メールアドレスまたはパスワードが違います' });
  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) return res.json({ error: 'メールアドレスまたはパスワードが違います' });
  req.session.userId = user.id;
  req.session.slug = user.slug;
  res.json({ ok: true });
});

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'unauthorized' });
  next();
}


// ---- API: me ----
app.get('/api/me', requireAuth, (req, res) => {
  const u = db.prepare('SELECT id, name, email, slug, slot_duration, ui_mode FROM users WHERE id=?').get(req.session.userId);
  res.json(u);
});

// ---- API: my-plan ----
app.get('/api/my-plan', requireAuth, (req, res) => {
  const u = db.prepare('SELECT plan, plan_expires FROM users WHERE id=?').get(req.session.userId);
  res.json({ plan: u?.plan || 'free', plan_expires: u?.plan_expires || null });
});

// ---- UTAGE/UnivaPay Webhook ----
app.post('/api/utage-webhook', async (req, res) => {
  res.json({ ok: true });
  try {
    const data = req.body;
    const inner = data.data || {};
    const email = (
      (inner.metadata || {}).email ||
      (inner.metadata || {}).mail ||
      (inner.transaction_token || {}).email ||
      ((inner.subscription || {}).metadata || {}).email ||
      inner.email || data.mail || data.email || ''
    );
    if (!email) { console.log('[utage-webhook] no email found'); return; }
    const eventType = data.type || '';
    const status = inner.status || '';
    const body = JSON.stringify(data);
    const isDeactivate = /fail|suspend|cancel/.test(eventType) || /failed|suspended|cancelled|terminated/.test(status) || /停止|失敗/.test(body);
    if (isDeactivate) {
      db.prepare("UPDATE users SET plan='free', plan_expires=NULL WHERE email=?").run(email);
      console.log('[utage-webhook] plan deactivated:', email);
    } else {
      db.prepare("UPDATE users SET plan='paid', plan_expires=NULL WHERE email=?").run(email);
      console.log('[utage-webhook] plan activated paid:', email);
    }
  } catch(e) { console.error('utage-webhook error:', e.message); }
});

// ---- Stripe 決済 ----
app.post('/api/stripe/checkout', requireAuth, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.session.userId);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  try {
    let customerId = user.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email, name: user.name,
        metadata: { user_id: String(user.id) }
      });
      customerId = customer.id;
      db.prepare('UPDATE users SET stripe_customer_id=? WHERE id=?').run(customerId, user.id);
    }
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      mode: 'subscription',
      success_url: 'https://meet.gaiaarts.org/booking/dashboard?plan=success',
      cancel_url: 'https://meet.gaiaarts.org/booking/dashboard',
      locale: 'ja'
    });
    res.json({ url: session.url });
  } catch(e) { console.error('stripe checkout error:', e.message); res.status(500).json({ error: e.message }); }
});

app.get('/api/stripe/portal', requireAuth, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });
  const user = db.prepare('SELECT stripe_customer_id FROM users WHERE id=?').get(req.session.userId);
  if (!user?.stripe_customer_id) return res.status(400).json({ error: 'no subscription' });
  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripe_customer_id,
      return_url: 'https://meet.gaiaarts.org/booking/dashboard'
    });
    res.redirect(session.url);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/stripe/webhook', async (req, res) => {
  if (!stripe) return res.status(503).send('Stripe not configured');
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch(e) { return res.status(400).send('Webhook Error: ' + e.message); }
  res.json({ received: true });
  try {
    const obj = event.data.object;
    const customerId = obj.customer;
    if (!customerId) return;
    const user = db.prepare('SELECT id FROM users WHERE stripe_customer_id=?').get(customerId);
    if (!user) return;
    if (['customer.subscription.created','customer.subscription.updated','invoice.payment_succeeded'].includes(event.type)) {
      const subStatus = obj.status;
      if (!subStatus || subStatus === 'active' || subStatus === 'trialing') {
        db.prepare("UPDATE users SET plan='paid' WHERE id=?").run(user.id);
        console.log('[stripe-webhook] plan=paid:', user.id);
      }
    } else if (['customer.subscription.deleted','customer.subscription.paused'].includes(event.type)) {
      db.prepare("UPDATE users SET plan='free' WHERE id=?").run(user.id);
      console.log('[stripe-webhook] plan=free:', user.id);
    } else if (event.type === 'invoice.payment_failed') {
      console.log('[stripe-webhook] payment failed, customer:', customerId);
    }
  } catch(e) { console.error('stripe webhook error:', e.message); }
});

// ---- API: availability ----
app.get('/api/availability', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT day_of_week, start_time, end_time FROM availability WHERE user_id=?').all(req.session.userId);
  res.json(rows);
});

app.post('/api/availability', requireAuth, (req, res) => {
  const { availability, slot_duration } = req.body;
  const uid = req.session.userId;
  db.prepare('DELETE FROM availability WHERE user_id=?').run(uid);
  const stmt = db.prepare('INSERT INTO availability (user_id, day_of_week, start_time, end_time) VALUES (?,?,?,?)');
  for (const a of (availability || [])) stmt.run(uid, a.day_of_week, a.start_time, a.end_time);
  if (slot_duration) db.prepare('UPDATE users SET slot_duration=? WHERE id=?').run(slot_duration, uid);
  res.json({ ok: true });
});

// ---- API: bookings ----
app.get('/api/bookings', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM bookings WHERE user_id=? AND (cancelled IS NULL OR cancelled=0) ORDER BY start_time ASC').all(req.session.userId);
  res.json(rows);
});

app.delete('/api/bookings/:id', requireAuth, async (req, res) => {
  const booking = db.prepare('SELECT * FROM bookings WHERE id=? AND user_id=?').get(req.params.id, req.session.userId);
  if (!booking) return res.status(404).json({ error: 'not found' });
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.session.userId);
  if (booking.google_event_id) {
    getCalendarClient().events.delete({
      calendarId: user.email, eventId: booking.google_event_id, sendUpdates: 'all'
    }).catch(() => {});
  }
  db.prepare('DELETE FROM bookings WHERE id=?').run(req.params.id);

  // キャンセルメール
  const startDt = new Date(booking.start_time);
  const fmtDate = startDt.toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
  const fmtTime = startDt.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
  if (booking.booker_email) {
    await sendMail(booking.booker_email, `【キャンセル】${user.name}さんとのミーティング`,
`${booking.booker_name} 様

誠に申し訳ありませんが、以下のミーティングをキャンセルさせていただきます。

日時：${fmtDate} ${fmtTime}
相手：${user.name}

再度のご予約はこちらから：
https://meet.gaiaarts.org/b/${user.slug}

よろしくお願いします。
`);
  }
  res.json({ ok: true });
});

// ---- Public: slots ----
function generateSlots(date, startTime, endTime, duration) {
  const slots = [];
  const [sh, sm] = startTime.split(':').map(Number);
  const [eh, em] = endTime.split(':').map(Number);
  let cur = sh * 60 + sm;
  const end = eh * 60 + em;
  while (cur + duration <= end) {
    const h1 = Math.floor(cur / 60), m1 = cur % 60;
    const h2 = Math.floor((cur + duration) / 60), m2 = (cur + duration) % 60;
    const pad = n => String(n).padStart(2, '0');
    slots.push({
      start: `${date}T${pad(h1)}:${pad(m1)}:00+09:00`,
      end: `${date}T${pad(h2)}:${pad(m2)}:00+09:00`,
      label: `${pad(h1)}:${pad(m1)} 〜 ${pad(h2)}:${pad(m2)}`
    });
    cur += duration;
  }
  return slots;
}

app.get('/api/b/:slug/slots', async (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE slug=?').get(req.params.slug);
  if (!user) return res.status(404).json({ error: 'not found' });

  const date = req.query.date;
  const dow = new Date(date + 'T12:00:00+09:00').getDay();
  const avail = db.prepare('SELECT * FROM availability WHERE user_id=? AND day_of_week=?').get(user.id, dow);
  if (!avail) return res.json({ slots: [], hostName: user.name });

  const allSlots = generateSlots(date, avail.start_time, avail.end_time, user.slot_duration || 30);

  // Filter already booked
  const booked = db.prepare("SELECT start_time FROM bookings WHERE user_id=? AND start_time LIKE ? AND (cancelled IS NULL OR cancelled=0)").all(user.id, date + '%');
  const bookedTimes = new Set(booked.map(b => b.start_time));

  // Filter past times
  const now = new Date();
  let filtered = allSlots.filter(s => new Date(s.start) > now && !bookedTimes.has(s.start));

  // Check Google Calendar busy times
  try {
    const tMin = `${date}T00:00:00+09:00`;
    const tMax = `${date}T23:59:59+09:00`;
    const fb = await getCalendarClient().freebusy.query({
      requestBody: { timeMin: tMin, timeMax: tMax, timeZone: 'Asia/Tokyo', items: [{ id: user.email }] }
    });
    const busy = (fb.data.calendars[user.email] || fb.data.calendars.primary || {}).busy || [];
    filtered = filtered.filter(s => {
      const ss = new Date(s.start).getTime(), se = new Date(s.end).getTime();
      return !busy.some(b => ss < new Date(b.end).getTime() && se > new Date(b.start).getTime());
    });
  } catch (e) { console.error('freebusy error:', e.message); }

  res.json({ slots: filtered, hostName: user.name });
});

// ---- Public: book ----
app.post('/api/b/:slug/book', async (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE slug=?').get(req.params.slug);
  if (!user) return res.status(404).json({ error: 'not found' });

  const { booker_name, booker_email, start_time, end_time, purpose } = req.body;
  if (db.prepare('SELECT id FROM bookings WHERE user_id=? AND start_time=? AND (cancelled IS NULL OR cancelled=0)').get(user.id, start_time))
    return res.status(409).json({ error: 'この時間はすでに予約されています' });

  const meetRoom = crypto.randomBytes(4).toString('hex');
  const meetUrl = `https://meet.gaiaarts.org/?room=${meetRoom}`;
  const cancelToken = crypto.randomBytes(16).toString('hex');
  const cancelUrl = `https://meet.gaiaarts.org/cancel?token=${cancelToken}`;

  let googleEventId = null;
  try {
    const event = await getCalendarClient().events.insert({
      calendarId: user.email,
      sendUpdates: 'all',
      requestBody: {
        summary: `${booker_name}さんとのミーティング`,
        description: `用件: ${purpose || 'なし'}\n\nビデオ通話URL: ${meetUrl}\n予約者: ${booker_name}${booker_email ? ` (${booker_email})` : ''}`,
        start: { dateTime: start_time, timeZone: 'Asia/Tokyo' },
        end: { dateTime: end_time, timeZone: 'Asia/Tokyo' }
      }
    });
    googleEventId = event.data.id;
  } catch (e) { console.error('calendar insert error:', e.message); }

  db.prepare('INSERT INTO bookings (user_id, booker_name, booker_email, start_time, end_time, purpose, meet_room, google_event_id, cancel_token) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(user.id, booker_name, booker_email, start_time, end_time, purpose || '', meetRoom, googleEventId, cancelToken);

  // メール送信
  const startDt = new Date(start_time);
  const endDt = new Date(end_time);
  const fmtDate = startDt.toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
  const fmtTime = `${startDt.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })} 〜 ${endDt.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}`;

  // 予約者へ
  if (booker_email) {
    await sendMail(booker_email, `【予約確認】${user.name}さんとのミーティング`,
`${booker_name} 様

ミーティングのご予約が完了しました。

━━━━━━━━━━━━━━━━━━
日時：${fmtDate} ${fmtTime}
相手：${user.name}
用件：${purpose || 'なし'}
━━━━━━━━━━━━━━━━━━

■ ビデオ通話URL
${meetUrl}

当日は上記URLをクリックするだけで参加できます。
（ブラウザのみ対応・アプリ不要）

■ 予約をキャンセルする場合
${cancelUrl}

よろしくお願いします。
`);
  }

  // ホストへ
  await sendMail(user.email, `【新規予約】${booker_name}さんから予約が入りました`,
`新しいミーティングの予約が入りました。

━━━━━━━━━━━━━━━━━━
日時：${fmtDate} ${fmtTime}
予約者：${booker_name}${booker_email ? ` (${booker_email})` : ''}
用件：${purpose || 'なし'}
━━━━━━━━━━━━━━━━━━

■ ビデオ通話URL
${meetUrl}

■ 予約管理
https://meet.gaiaarts.org/booking/dashboard
`);

  res.json({ ok: true, meet_url: meetUrl });
});

// ---- 録画アップロード ----
const recDir = path.join(__dirname, 'recordings');
if (!fs.existsSync(recDir)) fs.mkdirSync(recDir);
app.use('/recordings', express.static(recDir));


// ---- 対面録音モード専用：記録種別 ----
const FACE_RECORD_TYPES = {
  houmon: ['訪問記録（サービス提供記録）', 'モニタリング面談記録', 'サービス担当者会議記録'],
  houdei: ['保護者面談記録', '個別支援計画モニタリング記録', '個別支援会議記録'],
  kaigo:  ['日常生活支援記録', '家族・入居者面談記録', '月次モニタリング記録', '運営推進会議記録'],
  shuro:  ['個別面談記録', '個別支援計画モニタリング記録', '就労移行支援面談記録', '個別支援会議記録']
};

// ---- 対面録音モード専用：GPTプロンプト ----
const BNI_PROMPT = `あなたはBNI（Business Network International）の1-2-1ミーティング専門の記録アシスタントです。
以下の会話からGAINS情報と紹介機会を抽出してください。

GAINS:
G - Goals（目標）: ビジネス目標・人生の夢・達成したいこと
A - Accomplishments（実績）: 最近の成功・受賞・成果・誤れること
I - Interests（趣味・関心）: 趣味・プライベートの関心・ライフスタイル
N - Networks（人脈）: 所属団体・コミュニティ・業界つながり
S - Skills（スキル）: 専門スキル・資格・得意分野

必ずJSON形式のみで出力すること（他のテキストは一切含めない）:
{
  "summary": "1-2-1全体の要約（3-4文）",
  "gains": {
    "goals": "目標に関する情報",
    "accomplishments": "実績に関する情報",
    "interests": "趣味・関心に関する情報",
    "networks": "人脈に関する情報",
    "skills": "スキルに関する情報"
  },
  "referral_hints": "紹介につながりそうなキーワード・ニーズ・状況",
  "follow_up": "次回までのフォローアップ・約束事項"
}`;

const FACE_PROMPTS = {
  houmon: {
    '訪問記録（サービス提供記録）': `以下は訪問介護のヘルパーと利用者・家族の対面会話の文字起こしです。介護保険法指定基準第19条に基づく「サービス提供記録（実施記録）」として業務記録文体（〜が見られた／〜を実施した／〜が確認された）で作成してください。

【必須記載セクション】
■ 利用者の状態（体調・気分・訴え・バイタル関連発言）
■ 提供したサービス内容（身体介護または生活援助の区分と具体的内容）
■ 家族からの申し送り・連絡事項（言及があれば）
■ 特記事項（体調変化・転倒リスク・服薬確認・気になる言動）
■ 次回への引継ぎ事項

【禁止表現】「〜と思います」「〜ではないでしょうか」等の推測表現は使用しない。観察事実のみ記録。
【注意】利用者本人の発言は「〜と述べた」「〜と訴えた」と客観的に記録すること。`,

    'モニタリング面談記録': `以下は訪問介護のサービス提供責任者と利用者・家族が行ったモニタリング面談の文字起こしです。居宅サービス計画に基づく「モニタリング記録」として業務記録文体で作成してください。月1回の義務的モニタリングとして法的証拠となる記録です。

【必須記載セクション】
■ 現在のサービス提供状況（計画通りか・変更点）
■ 利用者本人の意向・満足度・不満・要望
■ 家族の意向・満足度・要望（同席の場合）
■ 心身状態の変化（前回比較）
■ 目標達成度の評価
■ 新たな課題・ニーズ
■ 計画変更の要否と方向性

【必須フォーマット】「〇〇について利用者より〜との申し出があった。」等のように情報源を明記すること。`,

    'サービス担当者会議記録': `以下は訪問介護に関するサービス担当者会議（居宅ケアマネ主催）の文字起こしです。「サービス担当者会議の要点（第4表に相当）」として業務記録文体で作成してください。

【必須記載セクション】
■ 参加者（氏名・職種）
■ 利用者・家族の意向
■ 各専門職からの意見・情報提供
■ 訪問介護サービスに関する検討内容
■ 決定事項・今後の役割分担
■ 次回会議の予定`
  },

  houdei: {
    '保護者面談記録': `以下は放課後等デイサービスの職員と保護者の対面面談（送迎時・来所時等）の文字起こしです。「保護者面談記録」として業務記録文体（〜が確認された／〜との意向が示された）で作成してください。令和6年度改定で強化された保護者連携の証拠記録となります。

【必須記載セクション】
■ 保護者からの申し送り（家庭・学校での様子・体調・服薬・前夜の状況）
■ 保護者の意向・要望・質問内容
■ 子どもの様子・変化（5領域の観点から：健康生活/運動感覚/認知行動/言語コミュニケーション/人間関係社会性）
■ 事業所からの説明・報告内容
■ 合意事項・申し送り事項
■ 次回面談または連絡の予定

【注意】保護者の発言は「〜との申し出があった」「〜との意向が示された」と記録。子どもの発言・行動は具体的に記述。`,

    '個別支援計画モニタリング記録': `以下は放課後等デイサービスにおける個別支援計画のモニタリング面談（保護者同席）の文字起こしです。障害者総合支援法・児童福祉法指定基準第22条に基づく「個別支援計画モニタリング記録」として業務記録文体で作成してください。6か月ごとの法定義務記録です。

【必須記載セクション】
■ 参加者（本人・保護者・サービス管理責任者・担当職員）
■ 前回計画からの変化・経過（各目標別）
■ 5領域別達成度評価
  - 健康・生活（睡眠・食事・健康管理）
  - 運動・感覚（身体活動・感覚調整）
  - 認知・行動（学習・問題解決・自己調整）
  - 言語・コミュニケーション（表現・理解・対人関係）
  - 人間関係・社会性（集団参加・ルール理解・社会スキル）
■ 保護者の意向・評価
■ 本人の意向（言語化できる場合）
■ 計画変更の要否・変更方向性
■ 次回モニタリング予定

【注意】日付順序（原案作成日 ≦ 会議日 ≦ 本作成日 ≦ 保護者同意日）は必ず別途確認すること。`,

    '個別支援会議記録': `以下は放課後等デイサービスにおける個別支援会議（令和6年度改定で本人参加原則化）の文字起こしです。「個別支援会議議事録」として業務記録文体で作成してください。

【必須記載セクション】
■ 開催日・場所・出席者（本人・保護者・サービス管理責任者・担当職員・相談支援専門員等）
■ 本人の意向・発言内容
■ 保護者の意向・発言内容（本人と分けて記載）
■ 各出席者からの意見・提言
■ 合意した支援内容・目標
■ 次回会議予定

【注意】本人が参加できなかった場合は理由を必ず記録すること（法定義務）。`
  },

  kaigo: {
    '日常生活支援記録': `以下は介護グループホーム（認知症対応型共同生活介護）における職員と入居者の対面会話・日常的やりとりの文字起こしです。「日常生活記録（ケア記録）」として業務記録文体（〜が見られた／〜を実施した）で作成してください。

【必須記載セクション】
■ 心身状態（体温・血圧等の言及があれば記録。口腔・皮膚状態の観察事実）
■ 食事状況（摂取量・食欲・好み・拒否）
■ 排泄状況（頻度・性状等の言及）
■ 睡眠状況（夜間の様子・日中傾眠）
■ 入居者の言動・気分・訴え（認知症症状に関連する言動を含む）
■ 実施したケア内容
■ 特記事項（転倒リスク・BPSD・急変・家族への連絡要否）

【注意】入居者の発言は「〜と述べた」「〜と訴えた」と客観的に記録。「〜だと思う」等の推測は書かない。認知症症状由来の言動も否定せず事実として記録。`,

    '家族・入居者面談記録': `以下は介護グループホームにおける職員と家族・入居者の面談（来訪時・電話相談含む）の文字起こしです。「家族連絡記録／支援経過記録」として業務記録文体で作成してください。

【必須記載セクション】
■ 面談日・参加者（家族氏名・続柄・入居者本人の参加有無）
■ 入居者の近況報告内容（心身状態・ADL・認知症症状・日常生活の様子）
■ 家族からの要望・質問・心配事
■ 施設からの説明・回答内容
■ 今後の方針・ケア内容の変更（合意内容）
■ 次回連絡・面談の予定

【注意】家族への説明内容と同意の確認は必ず記録すること。身体拘束・医療的判断に関する説明は特に詳細に記録。`,

    '月次モニタリング記録': `以下は介護グループホームの計画作成担当者と入居者のモニタリング面談（月1回義務）の文字起こしです。居宅サービス計画に基づく「月次モニタリング記録」として業務記録文体で作成してください。

【必須記載セクション】
■ 実施日・計画作成担当者名
■ 入居者の心身状態の変化（前月比）
■ 現在の支援が計画通りか（各目標の達成度）
■ 入居者本人の意向・訴え（認知症があっても本人の言葉を記録）
■ 新たなニーズ・課題
■ 計画変更の要否
■ 家族への報告事項

【注意】月1回の訪問実施が法定義務のため、この記録が実施証拠となる。日付と担当者名の記載を最優先で確認すること。`,

    '運営推進会議記録': `以下は介護グループホームの運営推進会議（2か月に1回以上義務）の文字起こしです。「運営推進会議議事録」として業務記録文体で作成してください。この記録は外部への公表義務があります。

【必須記載セクション】
■ 開催日・場所・出席者（入居者・家族・地域住民代表・市町村担当者・第三者評価機関等）
■ サービス提供状況の報告内容
■ 外部委員からの意見・提言・質問
■ 事業所の取り組み・改善策
■ 次回開催予定

【注意】議事録は地域への情報開示が義務付けられているため、個人情報（氏名・住所等）の取り扱いに十分注意すること。`
  },

  shuro: {
    '個別面談記録': `以下は就労継続支援（A型・B型）におけるサービス管理責任者または支援員と利用者の個別面談の文字起こしです。「個別相談記録・面談記録」として業務記録文体（〜との訴えがあった／〜が確認された）で作成してください。

【必須記載セクション】
■ 就労・訓練状況（出勤率・作業能率・職場環境への適応状況）
■ 利用者の困りごと・相談内容・悩み
■ 体調・精神状態・生活状況（家庭環境含む）
■ 就労意欲・将来の目標・希望の変化
■ 支援員からの提案・助言内容
■ 合意した取り組み・次のステップ
■ 次回面談の予定・フォローアップ事項

【注意】A型は雇用契約に基づくため、就労条件や賃金に関する発言は特に正確に記録すること。工賃・賃金の具体的数値はAI生成ではなく担当者が確認・補足すること。`,

    '個別支援計画モニタリング記録': `以下は就労継続支援の個別支援計画モニタリング面談（6か月ごとに法定義務）の文字起こしです。障害者総合支援法指定基準第58条に基づく「個別支援計画モニタリング記録」として業務記録文体で作成してください。

【必須記載セクション】
■ 参加者（利用者本人・サービス管理責任者・担当支援員）
■ 前回計画からの変化・経過
■ 各目標の達成度評価（長期目標・短期目標別）
■ 就労状況の変化（出勤率・作業能率・工賃推移の言及）
■ 利用者の意向・希望
■ 計画変更の要否・変更内容

【注意】日付順序（原案作成日 ≦ 会議日 ≦ 本作成日 ≦ 同意日）を必ず確認すること。これは実地指導で最頻出の指摘事項です。`,

    '就労移行支援面談記録': `以下は就労継続支援における就労移行・一般就労に向けた面談の文字起こしです。「就労支援記録（移行支援面談）」として業務記録文体で作成してください。

【必須記載セクション】
■ 利用者の就労への意向・希望職種・条件
■ 現在の就労能力・課題（集中力・対人スキル・体力等）
■ 就労先探し・職場体験等の進捗
■ 支援機関（ハローワーク・就労支援機関）との連携状況
■ 今後の就労移行に向けたアクションプラン
■ 次回面談予定`,

    '個別支援会議記録': `以下は就労継続支援の個別支援会議（令和6年度改定で本人参加原則化）の文字起こしです。「個別支援会議議事録（担当者会議意見聴取記録）」として業務記録文体で作成してください。

【必須記載セクション】
■ 開催日・出席者（利用者本人・サービス管理責任者・担当支援員・相談支援専門員・家族等）
■ 利用者本人の意向・発言内容
■ 各出席者の意見・提言
■ アセスメント結果の共有
■ 計画内容の合意事項
■ 次回会議予定

【注意】本人が参加できなかった場合は必ずその理由を記録すること（法定義務）。日付順序（原案 ≦ 会議 ≦ 本作成 ≦ 同意）を必ず確認すること。`
  }
};

const storage = multer.diskStorage({
  destination: recDir,
  filename: (req, file, cb) => cb(null, file.originalname)
});
const upload = multer({ storage, limits: { fileSize: 2 * 1024 * 1024 * 1024 } }); // 2GB

async function transcribeAndSummarize(filepath, filename, roomId) {
  try {
    if (roomId) io.to(roomId).emit('transcription-status', { status: 'transcribing' });
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(filepath),
      model: 'whisper-1',
      language: 'ja',
    });
    const transcript = transcription.text;
    const transcriptFilename = filename.replace(/\.[^.]+$/, '-transcript.txt');
    fs.writeFileSync(path.join(recDir, transcriptFilename), transcript, 'utf8');

    if (roomId) io.to(roomId).emit('transcription-status', { status: 'summarizing' });
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: '以下の会議の文字起こしを日本語で要約してください。箇条書きで主要な議題、決定事項、アクションアイテムをまとめてください。文字起こしが空または短すぎる場合はその旨を記載してください。' },
        { role: 'user', content: transcript }
      ]
    });
    const summary = completion.choices[0].message.content;
    const summaryFilename = filename.replace(/\.[^.]+$/, '-summary.txt');
    fs.writeFileSync(path.join(recDir, summaryFilename), summary, 'utf8');

    if (roomId) {
      io.to(roomId).emit('transcription-ready', {
        transcriptUrl: `https://meet.gaiaarts.org/recordings/${transcriptFilename}`,
        summaryUrl: `https://meet.gaiaarts.org/recordings/${summaryFilename}`,
        transcriptFilename,
        summaryFilename,
      });
    }
  } catch (e) {
    console.error('transcription error:', e.message);
    if (roomId) io.to(roomId).emit('transcription-status', { status: 'error' });
  }
}

app.post('/api/upload-recording', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file' });
  const url = `https://meet.gaiaarts.org/recordings/${req.file.filename}`;
  const roomId = req.body.roomId;
  if (roomId) {
    io.to(roomId).emit('recording-ready', {
      url,
      filename: req.file.filename,
      uploader: req.body.uploaderName || '参加者'
    });
  }
  res.json({ ok: true, url });
  if (openai) transcribeAndSummarize(req.file.path, req.file.filename, roomId);
});

// 録画ファイルを24時間後に自動削除（1時間ごとにチェック）
const REC_TTL = 24 * 60 * 60 * 1000;
setInterval(() => {
  fs.readdir(recDir, (err, files) => {
    if (err) return;
    const now = Date.now();
    files.forEach(file => {
      const fp = path.join(recDir, file);
      fs.stat(fp, (err, stat) => {
        if (!err && now - stat.mtimeMs > REC_TTL) {
          fs.unlink(fp, () => console.log('録画自動削除:', file));
        }
      });
    });
  });
}, 60 * 60 * 1000);


// ---- ファイルアップロード (チャット) ----
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
app.use('/uploads', express.static(uploadDir));

const uploadStorage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, Date.now() + '-' + base + ext);
  }
});
const uploadFileMiddleware = multer({ storage: uploadStorage, limits: { fileSize: 50 * 1024 * 1024 } });

app.post('/api/upload-file', uploadFileMiddleware.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file' });
  const url = '/uploads/' + req.file.filename;
  const origName = req.file.originalname;
  const isImage = req.file.mimetype.startsWith('image/');
  const roomId = req.body.roomId;
  const senderName = req.body.senderName || '参加者';
  const time = new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
  const msgHtml = isImage
    ? `<img src="${url}" alt="${origName}" class="chat-img" onclick="window.open('${url}','_blank')">`
    : `<a href="${url}" download="${origName}" target="_blank" class="chat-file-link">📎 ${origName}</a>`;
  if (roomId) io.to(roomId).emit('chat-file', { from: senderName, message: msgHtml, time });
  res.json({ ok: true, url, origName, isImage });
});

setInterval(() => {
  fs.readdir(uploadDir, (err, files) => {
    if (err) return;
    const now = Date.now();
    files.forEach(file => {
      const fp = path.join(uploadDir, file);
      fs.stat(fp, (err, stat) => { if (!err && now - stat.mtimeMs > 24*60*60*1000) fs.unlink(fp, ()=>{}); });
    });
  });
}, 60 * 60 * 1000);

// ---- 音声チャンクアップロード ----
const audioChunkUpload = multer({
  storage: multer.diskStorage({
    destination: recDir,
    filename: (req, file, cb) => cb(null, 'tmpaudio-' + Date.now() + '-' + Math.random().toString(36).slice(2,8) + '.webm')
  }),
  limits: { fileSize: 200 * 1024 * 1024 }
});

app.post('/api/audio-chunk', audioChunkUpload.single('chunk'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file' });
  const { sessionId, chunkIndex } = req.body;
  if (!sessionId) { fs.unlink(req.file.path, () => {}); return res.status(400).json({ error: 'no sessionId' }); }
  const ext = req.body.audioExt || 'webm';
  const finalName = `audio-${sessionId}-${String(chunkIndex).padStart(4,'0')}.${ext}`;
  console.log(`[audio-chunk] session=${sessionId} idx=${chunkIndex} size=${req.file.size}bytes ext=${ext}`);
  fs.rename(req.file.path, path.join(recDir, finalName), () => {});
  res.json({ ok: true });
});

const formParser = multer().none();
app.post('/api/audio-finalize', formParser, async (req, res) => {
  res.json({ ok: true });
  const { sessionId, email } = req.body;
  console.log(`[audio-finalize] session=${sessionId} email=${email} openai=${!!openai}`);
  if (!email || !sessionId || !openai) return;
  const fUser = db.prepare('SELECT plan, facility_id FROM users WHERE email=?').get(email);
  const recordMode = req.body.recordMode || '';
  const welfareSystem = req.body.welfareSystem || '';
  const welfareRecordType = req.body.welfareRecordType || '';
  const memberName = req.body.memberName || '';
  const staffName = req.body.staffName || '';
  const isWelfareRecord = recordMode === 'welfare' && welfareSystem && welfareRecordType;
  const isBniRecord = recordMode === 'bni';
  const bniContactId = req.body.bniContactId ? parseInt(req.body.bniContactId) || null : null;
  if (recordMode === 'none') { console.log('[audio-finalize] mode=none, skip'); return; }
  let canUseAI = false;
  if (isBniRecord) {
    canUseAI = true;
  } else if (fUser?.facility_id) {
    const fac = db.prepare('SELECT * FROM nm_facilities WHERE id=?').get(fUser.facility_id);
    const lc = db.prepare('SELECT COUNT(*) as cnt FROM nm_locations WHERE facility_id=?').get(fUser.facility_id)?.cnt || 0;
    const facStatus = getFacilityStatus(fac);
    if (facStatus !== 'expired') {
      const usedMin = getMonthlyUsageMinutes(fUser.facility_id);
      const limitMin = lc * 50 * 60;
      canUseAI = usedMin < limitMin;
      if (!canUseAI) console.log(`[audio-finalize] usage limit: ${usedMin}/${limitMin}min facility=${fUser.facility_id}`);
    } else {
      console.log('[audio-finalize] facility expired:', email);
    }
  } else {
    canUseAI = fUser?.plan === 'paid';
  }
  if (!canUseAI) {
    console.log('[audio-finalize] no AI access for:', email);
    return;
  }
  try {
    const chunkFiles = fs.readdirSync(recDir)
      .filter(f => f.startsWith(`audio-${sessionId}-`) && /\.(webm|mp4|ogg|m4a)$/.test(f) && !f.includes('-final'))
      .sort();
    console.log(`[audio-finalize] chunks found: ${chunkFiles.length}`);
    if (chunkFiles.length === 0) {
      await sendMail(email, '【NiceMeet】会議終了（音声データなし）', '会議が終了しましたが、音声データが検出されませんでした。\n無音や短時間の場合は録音されないことがあります。');
      return;
    }
    // WebMはMediaRecorder.start(timeslice)でchunk-0000だけ完全なヘッダーを持ち、
    // chunk-0001以降はClusterデータのみ（ヘッダーなし）なのでWhisper用にヘッダーを付与する
    const firstChunkBuf = fs.readFileSync(path.join(recDir, chunkFiles[0]));
    let webmHeader = null;
    if (firstChunkBuf[0] === 0x1a && firstChunkBuf[1] === 0x45 && firstChunkBuf[2] === 0xdf && firstChunkBuf[3] === 0xa3) {
      // 最初のCluster(1f43b675)の位置を検索してヘッダー部を切り出す
      for (let i = 0; i < firstChunkBuf.length - 3; i++) {
        if (firstChunkBuf[i] === 0x1f && firstChunkBuf[i+1] === 0x43 && firstChunkBuf[i+2] === 0xb6 && firstChunkBuf[i+3] === 0x75) {
          webmHeader = firstChunkBuf.slice(0, i);
          console.log(`[audio-finalize] webmHeader extracted: ${webmHeader.length} bytes`);
          break;
        }
      }
    }

    const tmpDir = require('os').tmpdir();
    const CHUNK_DURATION = 2 * 60; // 2分チャンク（秒）
    const SPEAKER_CHANGE_GAP = 2.0; // 話者切替と判定する無音秒数
    console.log(`[audio-finalize] transcribing ${chunkFiles.length} chunks individually...`);
    const allSegments = []; // { start, end, text } 絶対時刻
    for (let ci = 0; ci < chunkFiles.length; ci++) {
      const f = chunkFiles[ci];
      const fpath = path.join(recDir, f);
      const fsize = fs.statSync(fpath).size;
      if (fsize < 1000) { console.log(`[audio-finalize] skip tiny chunk ${f} (${fsize}bytes)`); continue; }
      let sendPath = fpath;
      let tmpFile = null;
      const chunkOffset = ci * CHUNK_DURATION;
      try {
        const buf = fs.readFileSync(fpath);
        const isComplete = buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3;
        if (!isComplete && webmHeader) {
          tmpFile = path.join(tmpDir, 'nicemeet-' + Date.now() + '-' + f);
          fs.writeFileSync(tmpFile, Buffer.concat([webmHeader, buf]));
          sendPath = tmpFile;
        }
        const result = await openai.audio.transcriptions.create({
          file: fs.createReadStream(sendPath),
          model: 'whisper-1',
          language: 'ja',
          prompt: 'はい。',
          response_format: 'verbose_json',
        });
        const segs = result.segments || [];
        for (const seg of segs) {
          const text = seg.text?.trim();
          if (text && !isWhisperHallucination(text)) {
            allSegments.push({ start: chunkOffset + seg.start, end: chunkOffset + seg.end, text });
          }
        }
        console.log(`[audio-finalize] chunk ${f}: ${segs.length} segments, kept ${allSegments.length} total`);
      } catch(e) {
        console.error(`[audio-finalize] chunk ${f} failed:`, e.message);
      } finally {
        if (tmpFile) fs.unlink(tmpFile, () => {});
      }
    }

    // 話者分離：無音ギャップ > SPEAKER_CHANGE_GAP 秒で話者切替
    const turns = [];
    let currentSpeaker = 'A';
    let lastEnd = 0;
    let currentTexts = [];
    for (const seg of allSegments) {
      const gap = seg.start - lastEnd;
      if (gap > SPEAKER_CHANGE_GAP && currentTexts.length > 0) {
        turns.push({ speaker: currentSpeaker, text: currentTexts.join(' ') });
        currentSpeaker = currentSpeaker === 'A' ? 'B' : 'A';
        currentTexts = [];
      }
      currentTexts.push(seg.text);
      lastEnd = seg.end;
    }
    if (currentTexts.length > 0) turns.push({ speaker: currentSpeaker, text: currentTexts.join(' ') });

    const transcript = turns.map(t => `【話者${t.speaker}】${t.text}`).join('\n');

    chunkFiles.forEach(f => fs.unlink(path.join(recDir, f), () => {}));

    if (!transcript) {
      await sendMail(email, '【NiceMeet】会議の文字起こし', '音声が検出されませんでした。');
      return;
    }

    const welfarePrompt = isWelfareRecord ? (WELFARE_PROMPTS[welfareSystem]?.[welfareRecordType] || null) : null;
    const systemPrompt = isBniRecord
      ? BNI_PROMPT
      : welfarePrompt
        ? `${welfarePrompt}

対象者: ${memberName || '（記載なし）'} / 担当: ${staffName || '（記載なし）'}`
        : '以下はビデオ会議の文字起こしです（話者A・話者Bは異なる参加者です）。日本語で要約してください。箇条書きで主要な議題、決定事項、アクションアイテムをまとめてください。';
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: transcript }
      ]
    });
    const summary = completion.choices[0].message.content;

    const durMin = chunkFiles.length * 2;
    if (isBniRecord) {
      let bniData = { summary, gains: {}, referral_hints: '', follow_up: '' };
      try { bniData = Object.assign(bniData, JSON.parse(summary)); } catch(e) {}
      const bniWebhookUrl = process.env.BNI_WEBHOOK_URL || 'http://localhost:8300/api/nicemeet-webhook';
      const bniSecret = process.env.BNI_WEBHOOK_SECRET || 'nicemeet-bni-2026';
      try {
        await fetch(bniWebhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-nicemeet-secret': bniSecret },
          body: JSON.stringify({
            bni_user: staffName,
            contact_id: bniContactId,
            contact_name: memberName,
            duration_minutes: durMin,
            transcript,
            summary: bniData.summary || summary,
            gains: bniData.gains || {},
            referral_hints: bniData.referral_hints || '',
            follow_up: bniData.follow_up || ''
          })
        });
        console.log(`[audio-finalize] BNI 1-2-1 sent to BNI app user=${staffName} contact=${memberName}`);
      } catch(e) { console.error('[audio-finalize] BNI webhook error:', e.message); }
    } else if (fUser?.facility_id) {
      if (isWelfareRecord) {
        db.prepare(
          'INSERT INTO nm_call_records (facility_id, room_id, welfare_system, record_type, member_name, staff_name, summary_text, raw_transcript) VALUES (?,?,?,?,?,?,?,?)'
        ).run(fUser.facility_id, sessionId, welfareSystem, welfareRecordType, memberName, staffName, summary, transcript);
        console.log(`[audio-finalize] saved to nm_call_records: ${welfareSystem}/${welfareRecordType} member=${memberName}`);
      } else {
        db.prepare(
          'INSERT INTO nm_meetings (facility_id, room_id, host_email, started_at, ended_at, duration_minutes, ai_summary_used, summary_text) VALUES (?,?,?,datetime(\'now\',?),datetime(\'now\'),?,1,?)'
        ).run(fUser.facility_id, sessionId, email, `-${durMin} minutes`, durMin, summary);
      }
    }

    const mailSubject = isBniRecord
      ? `【NiceMeet BNI】1-2-1ミーティング記録${memberName ? '（' + memberName + 'さん）' : ''}`
      : isWelfareRecord
      ? `【NiceMeet】${welfareRecordType}${memberName ? '（' + memberName + '）' : ''}`
      : '【NiceMeet】会議の文字起こし・要約';
    const mailHeader = isWelfareRecord
      ? `【${welfareRecordType}】
対象: ${memberName || '（記載なし）'} / 担当: ${staffName || '（記載なし）'} / 面談日: ${new Date().toLocaleDateString('ja-JP')}`
      : '【AI要約】';

    await sendMail(email, mailSubject,
`━━━━━━━━━━━━━━━━━━
${mailHeader}
━━━━━━━━━━━━━━━━━━
${summary}

━━━━━━━━━━━━━━━━━━
【文字起こし（全文）】
━━━━━━━━━━━━━━━━━━
${transcript}
`);
  } catch(e) {
    console.error('audio finalize error:', e.message);
    sendMail(email, '【NiceMeet】文字起こしエラー', '処理中にエラーが発生しました。').catch(() => {});
  }
});

// ---- Public: cancel by token ----
app.get('/api/cancel-info', (req, res) => {
  const token = req.query.token;
  if (!token) return res.json({ found: false });
  const booking = db.prepare(
    'SELECT b.booker_name, b.start_time, b.end_time, b.cancelled, u.name as host_name, u.slug FROM bookings b JOIN users u ON b.user_id = u.id WHERE b.cancel_token=?'
  ).get(token);
  if (!booking) return res.json({ found: false });
  res.json({ found: true, ...booking });
});

app.post('/api/cancel', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: '無効なリクエストです' });
  const booking = db.prepare(
    'SELECT b.*, u.name as host_name, u.email as host_email, u.slug FROM bookings b JOIN users u ON b.user_id = u.id WHERE b.cancel_token=?'
  ).get(token);
  if (!booking) return res.status(404).json({ error: '予約が見つかりません' });
  if (booking.cancelled) return res.status(409).json({ error: 'すでにキャンセル済みです' });

  db.prepare('UPDATE bookings SET cancelled=1 WHERE cancel_token=?').run(token);

  if (booking.google_event_id) {
    getCalendarClient().events.delete({
      calendarId: booking.host_email, eventId: booking.google_event_id, sendUpdates: 'all'
    }).catch(() => {});
  }

  const startDt = new Date(booking.start_time);
  const endDt = new Date(booking.end_time);
  const fmtDate = startDt.toLocaleDateString('ja-JP', { year:'numeric', month:'long', day:'numeric', weekday:'short' });
  const fmtTime = `${startDt.toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit'})} 〜 ${endDt.toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit'})}`;

  if (booking.booker_email) {
    await sendMail(booking.booker_email, `【キャンセル完了】${booking.host_name}さんとのミーティング`,
`${booking.booker_name} 様

以下のミーティングのキャンセルを受け付けました。

━━━━━━━━━━━━━━━━━━
日時：${fmtDate} ${fmtTime}
相手：${booking.host_name}
━━━━━━━━━━━━━━━━━━

再度のご予約はこちらから：
https://meet.gaiaarts.org/b/${booking.slug}

よろしくお願いします。
`);
  }

  await sendMail(booking.host_email, `【キャンセル】${booking.booker_name}さんが予約をキャンセルしました`,
`${booking.booker_name}さんが予約をキャンセルしました。

━━━━━━━━━━━━━━━━━━
日時：${fmtDate} ${fmtTime}
予約者：${booking.booker_name}${booking.booker_email ? ` (${booking.booker_email})` : ''}
━━━━━━━━━━━━━━━━━━

■ 予約管理
https://meet.gaiaarts.org/booking/dashboard
`);

  res.json({ ok: true });
});

// ---- Public: room info (time check) ----
app.get('/api/room-info', (req, res) => {
  const room = req.query.room;
  if (!room) return res.json({ found: false });
  const booking = db.prepare(
    'SELECT b.booker_name, b.start_time, b.end_time, u.name as host_name FROM bookings b JOIN users u ON b.user_id = u.id WHERE b.meet_room=?'
  ).get(room);
  if (!booking) return res.json({ found: false });
  const now = new Date();
  const start = new Date(booking.start_time);
  const end = new Date(booking.end_time);
  res.json({
    found: true,
    booker_name: booking.booker_name,
    host_name: booking.host_name,
    start_time: booking.start_time,
    end_time: booking.end_time,
    is_on_time: now >= start && now <= end,
    is_too_early: now < start,
    is_too_late: now > end
  });
});

// ---- Pages ----
app.get('/cancel', (req, res) => res.sendFile(path.join(__dirname, 'public', 'cancel.html')));
app.get('/b/:slug', (req, res) => res.sendFile(path.join(__dirname, 'public', 'booking', 'book.html')));
app.get('/record', (req, res) => res.sendFile(path.join(__dirname, 'public', 'record.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/booking/dashboard', (req, res) => {
  if (!req.session.userId) return res.redirect('/auth/google');
  res.sendFile(path.join(__dirname, 'public', 'booking', 'dashboard.html'));
});
app.get('/booking', (req, res) => res.sendFile(path.join(__dirname, 'public', 'booking', 'index.html')));

// ── 施設サブスク API ─────────────────────────────────────────────

// 施設登録（トライアル開始）
app.post('/api/facility/register', requireAuth, async (req, res) => {
  const { facility_name, contact_name, phone, locations } = req.body;
  if (!facility_name || !Array.isArray(locations) || !locations.length)
    return res.status(400).json({ error: '施設名と拠点名は必須です' });
  const u = db.prepare('SELECT email, facility_id FROM users WHERE id=?').get(req.session.userId);
  if (!u) return res.status(404).json({ error: 'user not found' });
  if (u.facility_id) return res.status(409).json({ error: 'already registered' });
  const fac = db.prepare(
    'INSERT INTO nm_facilities (name, admin_email, contact_name, phone) VALUES (?,?,?,?)'
  ).run(facility_name, u.email, contact_name || '', phone || '');
  const facilityId = fac.lastInsertRowid;
  for (const loc of locations) {
    db.prepare('INSERT INTO nm_locations (facility_id, name) VALUES (?,?)').run(facilityId, loc);
  }
  db.prepare('INSERT INTO nm_location_count_history (facility_id, location_count, note) VALUES (?,?,?)').run(facilityId, locations.length, '初回登録');
  db.prepare('UPDATE users SET facility_id=?, ui_mode=\'welfare\' WHERE id=?').run(facilityId, req.session.userId);
  const amount = calcMonthlyAmount(locations.length, 1);
  await sendMail(process.env.GMAIL_USER || '',
    `【NiceMeet】新規施設トライアル開始: ${facility_name}`,
    `施設名: ${facility_name}\n担当者: ${contact_name}\nメール: ${u.email}\n拠点数: ${locations.length}\n月額(先行): ¥${amount.total.toLocaleString()}\n登録日: ${new Date().toLocaleString('ja-JP')}`
  );
  res.json({ ok: true, facilityId });
});

// 施設ステータス取得
app.get('/api/facility/status', requireAuth, (req, res) => {
  const u = db.prepare('SELECT email, facility_id FROM users WHERE id=?').get(req.session.userId);
  if (!u?.facility_id) return res.json({ registered: false });
  const fac = db.prepare('SELECT * FROM nm_facilities WHERE id=?').get(u.facility_id);
  if (!fac) return res.json({ registered: false });
  const locs = db.prepare('SELECT * FROM nm_locations WHERE facility_id=? ORDER BY id').all(fac.id);
  const lc = locs.length;
  const status = getFacilityStatus(fac);
  const daysLeft = getTrialDaysLeft(fac);
  const amount = calcMonthlyAmount(lc, fac.early_adopter);
  const usedMin = getMonthlyUsageMinutes(fac.id);
  const limitMin = lc * 50 * 60;
  res.json({
    registered: true,
    facility: { id: fac.id, name: fac.name, admin_email: fac.admin_email, contact_name: fac.contact_name, early_adopter: fac.early_adopter, trial_started_at: fac.trial_started_at },
    locations: locs,
    status,
    daysLeft,
    amount,
    usage: { minutes: Math.round(usedMin), limit: limitMin, hours: Math.round(usedMin/60*10)/10, limitHours: Math.round(limitMin/60), percent: Math.min(100, Math.round(usedMin / limitMin * 100)) }
  });
});

// 拠点追加
app.post('/api/facility/location', requireAuth, (req, res) => {
  const u = db.prepare('SELECT facility_id FROM users WHERE id=?').get(req.session.userId);
  if (!u?.facility_id) return res.status(400).json({ error: 'no facility' });
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: '拠点名は必須です' });
  db.prepare('INSERT INTO nm_locations (facility_id, name) VALUES (?,?)').run(u.facility_id, name);
  const lc = db.prepare('SELECT COUNT(*) as cnt FROM nm_locations WHERE facility_id=?').get(u.facility_id).cnt;
  db.prepare('INSERT INTO nm_location_count_history (facility_id, location_count, note) VALUES (?,?,?)').run(u.facility_id, lc, '拠点追加: ' + name);
  res.json({ ok: true, locationCount: lc });
});

// 拠点削除
app.delete('/api/facility/location/:id', requireAuth, (req, res) => {
  const u = db.prepare('SELECT facility_id FROM users WHERE id=?').get(req.session.userId);
  if (!u?.facility_id) return res.status(400).json({ error: 'no facility' });
  const loc = db.prepare('SELECT * FROM nm_locations WHERE id=? AND facility_id=?').get(req.params.id, u.facility_id);
  if (!loc) return res.status(404).json({ error: 'not found' });
  const lc = db.prepare('SELECT COUNT(*) as cnt FROM nm_locations WHERE facility_id=?').get(u.facility_id).cnt;
  if (lc <= 1) return res.status(400).json({ error: '最低1拠点は必要です' });
  db.prepare('DELETE FROM nm_locations WHERE id=?').run(req.params.id);
  const newLc = lc - 1;
  db.prepare('INSERT INTO nm_location_count_history (facility_id, location_count, note) VALUES (?,?,?)').run(u.facility_id, newLc, '拠点削除: ' + loc.name);
  res.json({ ok: true, locationCount: newLc });
});

// 有料申込フォーム
app.post('/api/facility/inquiry', requireAuth, async (req, res) => {
  const u = db.prepare('SELECT email, facility_id FROM users WHERE id=?').get(req.session.userId);
  const { message } = req.body;
  const fac = u?.facility_id ? db.prepare('SELECT name FROM nm_facilities WHERE id=?').get(u.facility_id) : null;
  db.prepare('INSERT INTO nm_inquiries (facility_id, name, email, message) VALUES (?,?,?,?)').run(u?.facility_id || null, fac?.name || '', u?.email || '', message || '');
  await sendMail(process.env.GMAIL_USER || '',
    `【NiceMeet】有料プラン申込: ${fac?.name || u?.email}`,
    `施設名: ${fac?.name || '未登録'}\nメール: ${u?.email}\nメッセージ: ${message || '(なし)'}\n申込日時: ${new Date().toLocaleString('ja-JP')}`
  );
  res.json({ ok: true });
});

// CSV エクスポート（会議記録）
app.get('/api/facility/export/csv', requireAuth, (req, res) => {
  const u = db.prepare('SELECT facility_id FROM users WHERE id=?').get(req.session.userId);
  if (!u?.facility_id) return res.status(400).json({ error: 'no facility' });
  const rows = db.prepare('SELECT * FROM nm_meetings WHERE facility_id=? ORDER BY started_at DESC').all(u.facility_id);
  const header = '会議ID,ルームID,ホストメール,開始日時,終了日時,通話時間(分),AI要約\n';
  const body = rows.map(r => [
    r.id, r.room_id || '', r.host_email || '',
    r.started_at || '', r.ended_at || '',
    Math.round(r.duration_minutes || 0),
    r.ai_summary_used ? 'あり' : 'なし'
  ].join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="nicemeet_meetings.csv"');
  res.send('\ufeff' + header + body);
});

// 面談記録一覧
app.get('/api/facility/call-records', requireAuth, (req, res) => {
  const u = db.prepare('SELECT facility_id FROM users WHERE id=?').get(req.session.userId);
  if (!u?.facility_id) return res.status(400).json({ error: 'no facility' });
  const { system, member } = req.query;
  let sql = 'SELECT * FROM nm_call_records WHERE facility_id=?';
  const params = [u.facility_id];
  if (system) { sql += ' AND welfare_system=?'; params.push(system); }
  if (member) { sql += ' AND member_name LIKE ?'; params.push('%' + member + '%'); }
  sql += ' ORDER BY created_at DESC LIMIT 200';
  const rows = db.prepare(sql).all(...params);
  res.json({ records: rows });
});

// 面談記録の要約CSV
app.get('/api/facility/call-records/csv', requireAuth, (req, res) => {
  const u = db.prepare('SELECT facility_id FROM users WHERE id=?').get(req.session.userId);
  if (!u?.facility_id) return res.status(400).json({ error: 'no facility' });
  const rows = db.prepare('SELECT * FROM nm_call_records WHERE facility_id=? ORDER BY created_at DESC').all(u.facility_id);
  const header = '記録ID,業態,記録種別,対象者,担当職員,面談日,要約内容\n';
  const body = rows.map(r => [
    r.id,
    WELFARE_RECORD_TYPES[r.welfare_system]?.label || r.welfare_system,
    r.record_type || '',
    r.member_name || '',
    r.staff_name || '',
    r.interview_date || '',
    '"' + (r.summary_text || '').replace(/"/g, '""'). replace(/\n/g, ' ') + '"'
  ].join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="call_records.csv"');
  res.send('﻿' + header + body);
});


// ---- 対面録音モード ----
const faceRecordUpload = multer({
  storage: multer.diskStorage({
    destination: recDir,
    filename: (req, file, cb) => {
      const uid = req.session?.userId || 'anon';
      cb(null, `face-${uid}-${Date.now()}.webm`);
    }
  }),
  limits: { fileSize: 30 * 1024 * 1024 } // 30MB
});

app.post('/api/face-record/upload', requireAuth, faceRecordUpload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no audio file' });
  if (!openai) return res.status(503).json({ error: 'AI unavailable' });
  const u = db.prepare('SELECT plan, facility_id FROM users WHERE id=?').get(req.session.userId);
  const { memberName='', staffName='', welfareSystem='', welfareRecordType='', interviewDate='' } = req.body;
  if (!welfareSystem || !welfareRecordType) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'welfareSystem and welfareRecordType required' });
  }
  // AI eligibility check
  let canUseAI = false;
  if (u?.facility_id) {
    const fac = db.prepare('SELECT * FROM nm_facilities WHERE id=?').get(u.facility_id);
    const lc = db.prepare('SELECT COUNT(*) as cnt FROM nm_locations WHERE facility_id=?').get(u.facility_id)?.cnt || 0;
    const facStatus = getFacilityStatus(fac);
    if (facStatus !== 'expired') {
      const usedMin = getMonthlyUsageMinutes(u.facility_id);
      const limitMin = lc * 50 * 60;
      canUseAI = usedMin < limitMin;
    }
  } else {
    canUseAI = u?.plan === 'paid';
  }
  if (!canUseAI) {
    fs.unlink(req.file.path, () => {});
    return res.status(403).json({ error: 'AI not available for your plan' });
  }
  try {
    // Whisper transcription
    const result = await openai.audio.transcriptions.create({
      file: fs.createReadStream(req.file.path),
      model: 'whisper-1',
      language: 'ja',
      prompt: 'はい。',
      response_format: 'verbose_json',
    });
    fs.unlink(req.file.path, () => {});
    const segs = (result.segments || []).filter(s => s.text?.trim() && !isWhisperHallucination(s.text.trim()));
    // Speaker diarization
    const SPEAKER_GAP = 2.0;
    const turns = [];
    let speaker = 'A', lastEnd = 0, buf = [];
    for (const seg of segs) {
      if (seg.start - lastEnd > SPEAKER_GAP && buf.length) {
        turns.push({ speaker, text: buf.join(' ') });
        speaker = speaker === 'A' ? 'B' : 'A';
        buf = [];
      }
      buf.push(seg.text.trim());
      lastEnd = seg.end;
    }
    if (buf.length) turns.push({ speaker, text: buf.join(' ') });
    const transcript = turns.map(t => `【話者${t.speaker}】${t.text}`).join('\n');
    if (!transcript) return res.status(422).json({ error: 'no speech detected' });
    // GPT summary with welfare prompt
    const welfarePrompt = FACE_PROMPTS[welfareSystem]?.[welfareRecordType] || WELFARE_PROMPTS[welfareSystem]?.[welfareRecordType] || null;
    const systemPrompt = welfarePrompt
      ? `${welfarePrompt}\n\n対象者: ${memberName || '（記載なし）'} / 担当: ${staffName || '（記載なし）'}`
      : '以下は対面会話の文字起こしです。日本語で業務記録文体（〜が見られた／〜が確認された）で要約してください。主要な内容・意向・特記事項を箇条書きでまとめてください。';
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: transcript }]
    });
    const summary = completion.choices[0].message.content;
    // Save as draft
    const idate = interviewDate || new Date().toISOString().substring(0, 10);
    const info = db.prepare(
      'INSERT INTO nm_call_records (facility_id, room_id, welfare_system, record_type, member_name, staff_name, interview_date, summary_text, raw_transcript, status, source) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
    ).run(u.facility_id, null, welfareSystem, welfareRecordType, memberName, staffName, idate, summary, transcript, 'draft', 'face');
    console.log(`[face-record] draft saved id=${info.lastInsertRowid} system=${welfareSystem} member=${memberName}`);
    res.json({ ok: true, id: info.lastInsertRowid, summary, transcript });
  } catch(e) {
    fs.unlink(req.file.path, () => {});
    console.error('[face-record] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/face-record/confirm/:id', requireAuth, express.json(), (req, res) => {
  const u = db.prepare('SELECT facility_id FROM users WHERE id=?').get(req.session.userId);
  if (!u?.facility_id) return res.status(403).json({ error: 'no facility' });
  const id = parseInt(req.params.id);
  const rec = db.prepare('SELECT * FROM nm_call_records WHERE id=? AND facility_id=? AND status=?').get(id, u.facility_id, 'draft');
  if (!rec) return res.status(404).json({ error: 'draft not found' });
  const summary = req.body.summary || rec.summary_text;
  db.prepare("UPDATE nm_call_records SET summary_text=?, status='confirmed' WHERE id=?").run(summary, id);
  res.json({ ok: true });
});

app.delete('/api/face-record/draft/:id', requireAuth, (req, res) => {
  const u = db.prepare('SELECT facility_id FROM users WHERE id=?').get(req.session.userId);
  if (!u?.facility_id) return res.status(403).json({ error: 'no facility' });
  const id = parseInt(req.params.id);
  const rec = db.prepare("SELECT * FROM nm_call_records WHERE id=? AND facility_id=? AND status='draft'").get(id, u.facility_id);
  if (!rec) return res.status(404).json({ error: 'draft not found' });
  db.prepare('DELETE FROM nm_call_records WHERE id=?').run(id);
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────
// ── 管理者用エンドポイント ────────────────────────────────────────
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'nicemeet-admin-2026';

app.post('/api/admin/set-mode', (req, res) => {
  const { secret, email, mode } = req.body;
  if (secret !== ADMIN_SECRET) return res.status(403).json({ error: 'forbidden' });
  if (!['simple', 'welfare'].includes(mode)) return res.status(400).json({ error: 'invalid mode' });
  const u = db.prepare('SELECT id FROM users WHERE email=?').get(email);
  if (!u) return res.status(404).json({ error: 'user not found' });
  db.prepare("UPDATE users SET ui_mode=? WHERE email=?").run(mode, email);
  console.log(`[admin] ui_mode=${mode} set for ${email}`);
  res.json({ ok: true, email, mode });
});

app.get('/api/admin/users', (req, res) => {
  const { secret } = req.query;
  if (secret !== ADMIN_SECRET) return res.status(403).json({ error: 'forbidden' });
  const rows = db.prepare('SELECT id, name, email, ui_mode, facility_id FROM users ORDER BY id DESC').all();
  res.json({ records: rows });
});

app.get('/api/admin/drafts', (req, res) => {
  const { secret } = req.query;
  if (secret !== ADMIN_SECRET) return res.status(403).json({ error: 'forbidden' });
  const rows = db.prepare("SELECT * FROM nm_call_records WHERE status='draft' ORDER BY created_at DESC").all();
  res.json({ records: rows });
});

app.patch('/api/admin/confirm-draft/:id', express.json(), (req, res) => {
  const { secret } = req.body;
  if (secret !== ADMIN_SECRET) return res.status(403).json({ error: 'forbidden' });
  const id = parseInt(req.params.id);
  const rec = db.prepare("SELECT * FROM nm_call_records WHERE id=? AND status='draft'").get(id);
  if (!rec) return res.status(404).json({ error: 'draft not found' });
  db.prepare("UPDATE nm_call_records SET status='confirmed' WHERE id=?").run(id);
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────
// ---- Socket.io (video chat) ----
const rooms = new Map();
const breakouts = new Map();
io.on('connection', (socket) => {
  socket.on('join-room', ({ roomId, password, userName, transcribeMode }) => {
    const room = rooms.get(roomId);
    if (room && room.password && room.password !== password) {
      socket.emit('join-error', 'パスワードが違います'); return;
    }
    if (!room) {
      const userId = socket.request.session?.userId;
      let hostPlan = 'free';
      let hostFacilityId = null;
      let hostEmail = null;
      let hostUiMode = 'simple';
      if (userId) {
        const hu = db.prepare('SELECT plan, facility_id, email, ui_mode FROM users WHERE id=?').get(userId);
        hostPlan = hu?.plan || 'free';
        hostFacilityId = hu?.facility_id || null;
        hostEmail = hu?.email || null;
        hostUiMode = hu?.ui_mode || 'simple';
      }
      const newRoom = { password: password || '', users: new Map(), transcribeMode: transcribeMode || 'host_only', hostId: socket.id, coHosts: new Set(), hostPlan, startedAt: Date.now(), facilityId: hostFacilityId, hostEmail, hostUiMode };
      rooms.set(roomId, newRoom);
      if (hostPlan === 'free') {
        newRoom.warnTimer = setTimeout(() => { io.to(roomId).emit('time-warning', { minutesLeft: 5 }); }, 40 * 60 * 1000);
        newRoom.endTimer = setTimeout(() => { io.to(roomId).emit('time-limit', {}); }, 45 * 60 * 1000);
      }
    }
    const cur = rooms.get(roomId);
    for (const [id] of cur.users) {
      if (!io.sockets.sockets.get(id)) cur.users.delete(id);
    }
    // ホストが切断済みなら参加者をホストにする（リフレッシュ時の競合対策）
    if (!io.sockets.sockets.get(cur.hostId) || !cur.users.has(cur.hostId)) {
      cur.hostId = socket.id;
    }
    cur.users.set(socket.id, { name: userName });
    socket.join(roomId);
    socket.roomId = roomId;
    socket.mainRoomId = null;
    socket.userName = userName;
    const existing = [...cur.users.entries()].filter(([id]) => id !== socket.id).map(([id, d]) => ({ id, name: d.name }));
    socket.emit('room-joined', { existingUsers: existing, transcribeMode: cur.transcribeMode, isHost: cur.hostId === socket.id, isCoHost: cur.coHosts.has(socket.id), source: 'main', isFreeRoom: cur.hostPlan === 'free', roomStartedAt: cur.startedAt || Date.now(), hostUiMode: cur.hostUiMode || 'simple' });
    socket.to(roomId).emit('user-joined', { id: socket.id, name: userName });
  });
  socket.on('offer', ({ to, offer }) => io.to(to).emit('offer', { from: socket.id, fromName: socket.userName, offer }));
  socket.on('answer', ({ to, answer }) => io.to(to).emit('answer', { from: socket.id, answer }));
  socket.on('ice-candidate', ({ to, candidate }) => io.to(to).emit('ice-candidate', { from: socket.id, candidate }));
  socket.on('screen-share-start', () => { socket.to(socket.roomId).emit('screen-share-start', { id: socket.id, name: socket.userName }); });
  socket.on('screen-share-stop', () => { socket.to(socket.roomId).emit('screen-share-stop', { id: socket.id }); });
  socket.on('chat-message', ({ message }) => {
    if (!socket.roomId) return;
    console.log('[chat] from=' + socket.userName + ' room=' + socket.roomId + ' len=' + (message||'').length);
    socket.to(socket.roomId).emit('chat-message', { from: socket.userName, message, time: new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }) });
  });
  socket.on('disconnect', () => {
    if (!socket.roomId) return;
    const curRoomId = socket.roomId;
    const room = rooms.get(curRoomId);
    if (room) {
      room.users.delete(socket.id);
      const mainId = socket.mainRoomId || curRoomId;
      const mainRoom = rooms.get(mainId);
      if (mainRoom && mainRoom.hostId === socket.id && mainRoom.users.size > 0) {
        let newHostId = null;
        for (const cid of mainRoom.coHosts) { if (mainRoom.users.has(cid)) { newHostId = cid; break; } }
        if (!newHostId) newHostId = [...mainRoom.users.keys()][0];
        if (newHostId) {
          mainRoom.hostId = newHostId;
          mainRoom.coHosts.delete(newHostId);
          io.to(newHostId).emit('host-assigned', {});
          io.to(mainId).emit('host-changed', { newHostId, newHostName: mainRoom.users.get(newHostId)?.name });
        }
      }
      if (room.users.size === 0) {
        if (room.warnTimer) clearTimeout(room.warnTimer);
        if (room.endTimer) clearTimeout(room.endTimer);
        if (room.facilityId && room.startedAt) {
          const durMin = (Date.now() - room.startedAt) / 60000;
          db.prepare(
            'INSERT INTO nm_meetings (facility_id, room_id, host_email, started_at, ended_at, duration_minutes, ai_summary_used) VALUES (?,?,?,?,?,?,0)'
          ).run(room.facilityId, curRoomId, room.hostEmail || '', new Date(room.startedAt).toISOString(), new Date().toISOString(), durMin);
        }
        rooms.delete(curRoomId);
      }
    }
    socket.to(curRoomId).emit('user-left', { id: socket.id, name: socket.userName });
    const bsRoomId = socket.mainRoomId || curRoomId;
    const bs = breakouts.get(bsRoomId);
    if (bs) {
      bs.rooms.forEach(r => { r.participants = r.participants.filter(id => id !== socket.id); });
      bs.assignments.delete(socket.id);
    }
  });

  // ---- ルーム切替（ブレイクアウト用）----
  socket.on('switch-room', ({ newRoomId, mainRoomId }) => {
    const oldRoomId = socket.roomId;
    if (oldRoomId) {
      const oldRoom = rooms.get(oldRoomId);
      if (oldRoom) {
        oldRoom.users.delete(socket.id);
        socket.to(oldRoomId).emit('user-left', { id: socket.id, name: socket.userName });
        if (oldRoom.users.size === 0 && oldRoomId !== mainRoomId) rooms.delete(oldRoomId);
      }
      socket.leave(oldRoomId);
    }
    socket.mainRoomId = mainRoomId || null;
    if (!rooms.has(newRoomId)) rooms.set(newRoomId, { password: '', users: new Map(), transcribeMode: 'none', hostId: socket.id, coHosts: new Set() });
    const nr = rooms.get(newRoomId);
    nr.users.set(socket.id, { name: socket.userName });
    socket.join(newRoomId);
    socket.roomId = newRoomId;
    const existing2 = [...nr.users.entries()].filter(([id]) => id !== socket.id).map(([id, d]) => ({ id, name: d.name }));
    socket.emit('room-joined', { existingUsers: existing2, transcribeMode: 'none', source: 'breakout' });
    socket.to(newRoomId).emit('user-joined', { id: socket.id, name: socket.userName });
  });

  // ---- サブホスト管理 ----
  socket.on('grant-cohost', ({ targetId }) => {
    const mainId = socket.mainRoomId || socket.roomId;
    const room = rooms.get(mainId);
    if (!room || room.hostId !== socket.id) return;
    room.coHosts.add(targetId);
    io.to(targetId).emit('cohost-granted', { by: socket.userName });
    io.to(mainId).emit('cohost-list', { coHosts: [...room.coHosts], hostId: room.hostId });
  });
  socket.on('revoke-cohost', ({ targetId }) => {
    const mainId = socket.mainRoomId || socket.roomId;
    const room = rooms.get(mainId);
    if (!room || room.hostId !== socket.id) return;
    room.coHosts.delete(targetId);
    io.to(targetId).emit('cohost-revoked', {});
    io.to(mainId).emit('cohost-list', { coHosts: [...room.coHosts], hostId: room.hostId });
  });

  // ---- ブレイクアウトルーム ----
  socket.on('breakout:setup', ({ numRooms, timerSeconds }) => {
    const mainId = socket.mainRoomId || socket.roomId;
    const room = rooms.get(mainId);
    if (!room || (room.hostId !== socket.id && !room.coHosts.has(socket.id))) return;
    if (breakouts.has(mainId) && breakouts.get(mainId).active) return;
    breakouts.set(mainId, {
      numRooms, timerSeconds: timerSeconds||0, timerEnd: null, active: false, timerTimeout: null,
      rooms: Array.from({length:numRooms}, (_,i) => ({id:i+1, name:'部屋 '+(i+1), participants:[]})),
      assignments: new Map()
    });
    const pList = [...room.users.entries()].map(([id,d]) => ({id, name:d.name}));
    socket.emit('breakout:ready', {
      rooms: Array.from({length:numRooms}, (_,i) => ({id:i+1, name:'部屋 '+(i+1), participants:[]})),
      participants: pList, numRooms, timerSeconds: timerSeconds||0
    });
  });

  socket.on('breakout:assign', ({ targetId, roomNum }) => {
    const mainId = socket.mainRoomId || socket.roomId;
    const bs = breakouts.get(mainId);
    const room = rooms.get(mainId);
    if (!bs||!room||(room.hostId!==socket.id&&!room.coHosts.has(socket.id))) return;
    bs.rooms.forEach(r => { r.participants = r.participants.filter(id => id!==targetId); });
    if (roomNum>=1&&roomNum<=bs.numRooms) { bs.rooms[roomNum-1].participants.push(targetId); bs.assignments.set(targetId,roomNum); }
    else bs.assignments.delete(targetId);
    socket.emit('breakout:update', { rooms:bs.rooms.map(r=>({...r})), assignments:[...bs.assignments.entries()].map(([k,v])=>({id:k,room:v})) });
  });

  socket.on('breakout:auto-assign', () => {
    const mainId = socket.mainRoomId || socket.roomId;
    const bs = breakouts.get(mainId);
    const room = rooms.get(mainId);
    if (!bs||!room||(room.hostId!==socket.id&&!room.coHosts.has(socket.id))) return;
    bs.rooms.forEach(r => r.participants=[]);
    bs.assignments.clear();
    const all = [...room.users.keys()].filter(id=>id!==socket.id);
    for (let i=all.length-1;i>0;i--) { const j=Math.floor(Math.random()*(i+1)); [all[i],all[j]]=[all[j],all[i]]; }
    all.forEach((id,idx) => { const rn=(idx%bs.numRooms)+1; bs.rooms[rn-1].participants.push(id); bs.assignments.set(id,rn); });
    socket.emit('breakout:update', { rooms:bs.rooms.map(r=>({...r})), assignments:[...bs.assignments.entries()].map(([k,v])=>({id:k,room:v})) });
  });

  socket.on('breakout:open', () => {
    const mainId = socket.mainRoomId || socket.roomId;
    const bs = breakouts.get(mainId);
    const room = rooms.get(mainId);
    if (!bs||!room||(room.hostId!==socket.id&&!room.coHosts.has(socket.id))) return;
    bs.active=true;
    bs.timerEnd = bs.timerSeconds>0 ? Date.now()+bs.timerSeconds*1000 : null;
    bs.assignments.forEach((rn,sid) => {
      io.to(sid).emit('breakout:invited', {
        roomNum:rn, roomName:bs.rooms[rn-1].name,
        brRoomId:mainId+'__br__'+rn, mainRoomId:mainId, timerEnd:bs.timerEnd
      });
    });
    if (bs.timerEnd) {
      if (bs.timerTimeout) clearTimeout(bs.timerTimeout);
      bs.timerTimeout = setTimeout(() => {
        const b=breakouts.get(mainId); if(!b||!b.active) return;
        b.active=false;
        io.to(mainId).emit('breakout:ended',{mainRoomId:mainId});
        b.rooms.forEach((_,i) => io.to(mainId+'__br__'+(i+1)).emit('breakout:ended',{mainRoomId:mainId}));
        breakouts.delete(mainId);
      }, bs.timerSeconds*1000);
    }
    socket.emit('breakout:opened', { timerEnd:bs.timerEnd, rooms:bs.rooms.map(r=>({...r})) });
  });

  socket.on('breakout:close', () => {
    const mainId = socket.mainRoomId || socket.roomId;
    const bs = breakouts.get(mainId);
    const room = rooms.get(mainId);
    if (!bs||!room||(room.hostId!==socket.id&&!room.coHosts.has(socket.id))) return;
    if (bs.timerTimeout) clearTimeout(bs.timerTimeout);
    bs.active=false;
    io.to(mainId).emit('breakout:ended',{mainRoomId:mainId});
    bs.rooms.forEach((_,i) => io.to(mainId+'__br__'+(i+1)).emit('breakout:ended',{mainRoomId:mainId}));
    breakouts.delete(mainId);
  });

  socket.on('breakout:broadcast', ({ message }) => {
    const mainId = socket.mainRoomId || socket.roomId;
    const bs = breakouts.get(mainId);
    if (!bs) return;
    const t = new Date().toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit'});
    io.to(mainId).emit('breakout:broadcast-msg',{from:socket.userName,message,time:t});
    bs.rooms.forEach((_,i) => io.to(mainId+'__br__'+(i+1)).emit('breakout:broadcast-msg',{from:socket.userName,message,time:t}));
  });

});

server.listen(3100, () => console.log('Meet+Booking server on port 3100'));
