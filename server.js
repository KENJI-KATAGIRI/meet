require('dotenv').config({ override: true });
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
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
const groqWhisper = process.env.GROQ_API_KEY ? new OpenAI({ apiKey: process.env.GROQ_API_KEY, baseURL: "https://api.groq.com/openai/v1" }) : null;
const whisperClient = groqWhisper || openai;
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

// ---- セキュリティヘッダー ----
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'wasm-unsafe-eval'", "cdn.jsdelivr.net", "cdn.tailwindcss.com", "https://connect.facebook.net"],
      styleSrc: ["'self'", "'unsafe-inline'", "cdn.tailwindcss.com", "fonts.googleapis.com"],
      mediaSrc: ["'self'", "blob:", "data:"],
      connectSrc: ["'self'", "wss:", "ws:", "https://storage.googleapis.com", "https://www.facebook.com", "https://connect.facebook.net"],
      imgSrc: ["'self'", "data:", "blob:", "https://www.facebook.com"],
      workerSrc: ["'self'", "blob:"],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
      scriptSrcAttr: ["'unsafe-inline'"],
    }
  },
  crossOriginEmbedderPolicy: false, // WebRTC/MediaPipeに必要
}));

// ---- レートリミット ----
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false,
  message: { error: 'リクエストが多すぎます。15分後に再度お試しください。' }
});
const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 100, standardHeaders: true, legacyHeaders: false });
// アップロード系は厳しく制限（ディスク枯渇・AI費用乱用防止）
const uploadLimiter = rateLimit({ windowMs: 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false, message: { error: 'アップロード回数が多すぎます' } });
app.use('/auth/', authLimiter);
app.use('/api/', apiLimiter);

// SQLite永続セッションストア（再起動してもセッションが切れない）
const sessionDb = new Database(path.join(__dirname, 'data', 'sessions.db'));
sessionDb.exec(`CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  expires INTEGER NOT NULL
)`);
// 期限切れセッションを1時間ごとに削除
setInterval(() => {
  try { sessionDb.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now()); } catch(e) {}
}, 3600000);
const Store = require('express-session').Store;
class BetterSqliteStore extends Store {
  get(sid, cb) {
    try {
      const row = sessionDb.prepare('SELECT data, expires FROM sessions WHERE sid=?').get(sid);
      if (!row) return cb(null, null);
      if (row.expires < Date.now()) { this.destroy(sid, ()=>{}); return cb(null, null); }
      cb(null, JSON.parse(row.data));
    } catch(e) { cb(e); }
  }
  set(sid, sess, cb) {
    try {
      const exp = sess.cookie?.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 30 * 86400000;
      sessionDb.prepare('INSERT OR REPLACE INTO sessions (sid,data,expires) VALUES (?,?,?)').run(sid, JSON.stringify(sess), exp);
      cb(null);
    } catch(e) { cb(e); }
  }
  destroy(sid, cb) {
    try { sessionDb.prepare('DELETE FROM sessions WHERE sid=?').run(sid); cb(null); } catch(e) { cb(e); }
  }
  touch(sid, sess, cb) { this.set(sid, sess, cb); }
}

// BNI Manager DB（既存データをそのまま使用）

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
try { db.exec("ALTER TABLE bookings ADD COLUMN meet_system TEXT DEFAULT ''"); } catch(e) {}
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
try { db.exec('ALTER TABLE users ADD COLUMN registered_at TEXT'); } catch(e) {}
try { db.exec("ALTER TABLE nm_call_records ADD COLUMN status TEXT DEFAULT 'confirmed'"); } catch(e) {}
try { db.exec("ALTER TABLE nm_call_records ADD COLUMN source TEXT DEFAULT 'video'"); } catch(e) {}
try { db.exec("ALTER TABLE users ADD COLUMN booking_horizon_days INTEGER DEFAULT 14"); } catch(e) {}
try { db.exec("ALTER TABLE nm_facilities ADD COLUMN admin_notes TEXT DEFAULT ''"); } catch(e) {}
try { db.exec("ALTER TABLE users ADD COLUMN last_login_at TEXT"); } catch(e) {}

// ── 施設サブスク ヘルパー ────────────────────────────────────────
function calcMonthlyAmount(locationCount, isEarlyAdopter) {
  const unit = locationCount === 1
    ? (isEarlyAdopter ? 2980 : 4980)
    : locationCount <= 3 ? 2480 : 1980;
  return { unit, total: locationCount * unit };
}
function getFacilityStatus(facility) {
  if (!facility) return 'none';
  if (facility.trial_status === 'custom') return 'custom';
  if (facility.trial_status === 'active') return 'active';
  if (facility.trial_status === 'expired') return 'expired';
  if (!facility.trial_started_at) return 'expired';
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
  if (!facility) return 0;
  if (facility.trial_status === 'custom' || facility.trial_status === 'active') return null;
  if (!facility.trial_started_at) return 0;
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
  },
  seikatsu: {
    label: '生活訓練',
    types: ['モニタリング記録', '個別支援計画会議記録', 'サービス担当者会議記録', '家族面談記録', 'スタッフ間ミーティング']
  },
  keikaku: {
    label: '計画相談支援',
    types: ['サービス担当者会議記録', 'モニタリング記録', '個別支援計画作成会議記録', '家族面談記録', '関係機関連絡調整']
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
,
  seikatsu: {
    'モニタリング記録': `以下は生活訓練事業所におけるモニタリング面談の文字起こしです。「モニタリング記録」として業務記録文体で作成してください。
以下の見出しで記述してください：
【本人の状況・生活状況の変化】
【生活訓練の実施状況・達成度】
【本人の意向・希望】「ご本人より〜との意向が示された」形式で
【課題と今後の支援方針】
【計画変更の要否】
【次回面談予定】`,
    'サービス担当者会議記録': `以下は生活訓練事業所におけるサービス担当者会議の文字起こしです。「サービス担当者会議記録」として業務記録文体で作成してください。
以下の見出しで記述してください：
【参加者】（役職・事業所名を記載）
【本人・家族の意向】
【各担当者からの情報提供】
【合意事項・支援方針】
【役割分担・対応事項】
【次回開催予定】`,
    '家族面談記録': `以下は生活訓練事業所における家族面談の文字起こしです。「家族面談記録」として業務記録文体で作成してください。
以下の見出しで記述してください：
【面談目的・参加者】（続柄を記載）
【家庭での様子（家族報告）】
【本人の状態・変化】
【家族の意向・要望】「ご家族より〜との申し出あり」形式で
【合意事項・対応内容】
【次回連絡・面談予定】`
  },
  keikaku: {
    'サービス担当者会議記録': `以下は計画相談支援事業所におけるサービス担当者会議の文字起こしです。「サービス担当者会議記録」として業務記録文体で作成してください。
以下の見出しで記述してください：
【参加者】（役職・事業所名を記載）
【本人・家族の現状と意向】
【各サービス担当者からの情報共有】
【ニーズ・課題の整理】
【サービス等利用計画の変更内容・合意事項】
【役割分担・対応事項】
【次回開催予定】`,
    'モニタリング記録': `以下は計画相談支援事業所におけるモニタリング面談の文字起こしです。「モニタリング記録」として相談支援専門員が作成する業務記録文体で作成してください。
以下の見出しで記述してください：
【利用者の現状（生活状況・健康状態・障害の状況）】
【各サービスの利用状況】
【計画目標の達成状況】
【本人・家族の意向・要望】
【課題と今後の支援方針】
【計画変更の要否と内容】
【次回モニタリング予定】`,
    '家族面談記録': `以下は計画相談支援事業所における家族面談の文字起こしです。「家族面談記録」として業務記録文体で作成してください。
以下の見出しで記述してください：
【面談目的・参加者】（続柄を記載）
【家庭での様子（家族報告）】
【本人の状態・変化】
【家族の意向・要望】「ご家族より〜との申し出あり」形式で
【合意事項・対応内容】
【次回連絡・面談予定】`
  }};
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
  try {
    const [salt, hash] = stored.split(':');
    if (!salt || !hash || hash.length !== 128) return false;
    const attempt = await new Promise((res, rej) =>
      crypto.scrypt(password, salt, 64, (e, k) => e ? rej(e) : res(k.toString('hex')))
    );
    return crypto.timingSafeEqual(Buffer.from(attempt, 'hex'), Buffer.from(hash, 'hex'));
  } catch (e) {
    console.error('[verifyPassword] format error:', e.message);
    return false;
  }
}

// ---- 入力検証ユーティリティ ----
function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}
function safeStr(s, max = 200) {
  return typeof s === 'string' ? s.trim().slice(0, max) : '';
}
function isValidISODate(s) {
  if (typeof s !== 'string') return false;
  return !isNaN(new Date(s).getTime());
}
// セッション再生成（セッション固定化攻撃対策）
function regenerateSession(req) {
  return new Promise((resolve, reject) => req.session.regenerate(e => e ? reject(e) : resolve()));
}
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

app.set('trust proxy', 1);
app.use(express.json({
  limit: '50kb',
  verify: (req, res, buf) => { if (req.path === '/api/stripe/webhook') req.rawBody = buf; }
}));
const WELFARE_SYSTEMS = new Set(['shuro','kaigo','houmon','houdei','roukin','beauty','seikatsu','keikaku','booking']);
app.get('/', (req, res, next) => {
  const sys = req.query.system;
  if (sys && WELFARE_SYSTEMS.has(sys)) {
    return res.sendFile(path.join(__dirname, 'public', 'welfare-call.html'));
  }
  if (!req.query.room) return res.redirect('/bni.html');
  next(); // static serves index.html (BNI用)
});
app.use(express.static(path.join(__dirname, 'public')));
if (!process.env.SESSION_SECRET) { console.error('[FATAL] SESSION_SECRET is not set in .env — exiting'); process.exit(1); }
const sessionMiddleware = session({
  name: 'sid',
  store: new BetterSqliteStore(),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: 'auto', httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000, sameSite: 'lax' }
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

function getUserCalendarClient(user) {
  if (!user || !user.refresh_token) return null;
  const auth = getOAuthClient();
  auth.setCredentials({ access_token: user.access_token, refresh_token: user.refresh_token });
  return google.calendar({ version: 'v3', auth });
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
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;
  req.session.save(() => {});
  const url = getOAuthClient().generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/calendar'
    ],
    prompt: 'consent',
    state
  });
  res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!state || !req.session.oauthState || state !== req.session.oauthState) return res.redirect('/booking?error=1');
    delete req.session.oauthState;
    const client = getOAuthClient();
    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);
    const { data } = await google.oauth2({ version: 'v2', auth: client }).userinfo.get();

    let isNewUser = false;
    const existing = db.prepare('SELECT id, slug, refresh_token FROM users WHERE google_id = ?').get(data.id);
    if (existing) {
      const rt = tokens.refresh_token || existing.refresh_token;
      db.prepare('UPDATE users SET name=?, email=?, access_token=?, refresh_token=? WHERE google_id=?')
        .run(data.name, data.email, tokens.access_token, rt, data.id);
      await regenerateSession(req);
      req.session.userId = existing.id;
      req.session.slug = existing.slug;
    } else {
      let slug = data.name.toLowerCase().replace(/[^a-z0-9]/g, '') || 'user';
      let base = slug, i = 1;
      while (db.prepare('SELECT id FROM users WHERE slug=?').get(slug)) slug = base + i++;
      const r = db.prepare("INSERT INTO users (google_id, name, email, access_token, refresh_token, slug, registered_at, plan, plan_expires) VALUES (?,?,?,?,?,?,datetime('now'),'trial',datetime('now','+30 days'))")
        .run(data.id, data.name, data.email, tokens.access_token, tokens.refresh_token, slug);
      await regenerateSession(req);
      req.session.userId = r.lastInsertRowid;
      isNewUser = true;
      req.session.slug = slug;
    }
    res.redirect(isNewUser ? "/booking/dashboard?registered=1" : "/booking/dashboard");
  } catch (e) {
    console.error(e);
    res.redirect('/booking?error=1');
  }
});

app.get('/auth/logout', (req, res) => { req.session.destroy(() => res.redirect('/booking')); });

// ---- メール＋パスワード登録 ----
app.post('/auth/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.json({ error: '全項目を入力してください' });
  const cleanName = safeStr(name, 50);
  if (!cleanName) return res.json({ error: '名前を入力してください' });
  if (!isValidEmail(email)) return res.json({ error: 'メールアドレスが正しくありません' });
  if (typeof password !== 'string' || password.length < 8 || password.length > 128)
    return res.json({ error: 'パスワードは8〜128文字で入力してください' });
  if (db.prepare('SELECT id FROM users WHERE email=?').get(email))
    return res.json({ error: 'このメールアドレスはすでに登録されています' });
  let slug = cleanName.toLowerCase().replace(/[^a-z0-9]/g, '') || 'user';
  let base = slug, i = 1;
  while (db.prepare('SELECT id FROM users WHERE slug=?').get(slug)) slug = base + i++;
  const password_hash = await hashPassword(password);
  const r = db.prepare("INSERT INTO users (name, email, password_hash, slug, registered_at, plan, plan_expires) VALUES (?,?,?,?,datetime('now'),'trial',datetime('now','+30 days'))")
    .run(cleanName, email, password_hash, slug);
  await regenerateSession(req);
  req.session.userId = r.lastInsertRowid;
  req.session.slug = slug;
  res.json({ ok: true });
});

// ---- メール＋パスワードログイン ----
app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.json({ error: 'メールアドレスとパスワードを入力してください' });
  if (!isValidEmail(email) || typeof password !== 'string')
    return res.json({ error: 'メールアドレスまたはパスワードが違います' });
  const user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  if (!user || !user.password_hash) return res.json({ error: 'メールアドレスまたはパスワードが違います' });
  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) {
    console.warn(`[auth-fail] ip=${(req.ip || '').replace(/[^0-9a-f:.]/gi, '')}`);
    return res.json({ error: 'メールアドレスまたはパスワードが違います' });
  }
  await regenerateSession(req);
  req.session.userId = user.id;
  req.session.slug = user.slug;
  db.prepare("UPDATE users SET last_login_at=datetime('now') WHERE id=?").run(user.id);
  res.json({ ok: true });
});

function isActivePlan(u) {
  if (!u) return false;
  if (u.plan === 'paid') return true;
  if (u.plan === 'trial' && u.plan_expires) {
    const exp = new Date(String(u.plan_expires).replace(' ', 'T') + 'Z');
    if (exp > new Date()) return true;
  }
  return false;
}

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'unauthorized' });
  next();
}


// ---- API: me ----
const OWNER_EMAIL = process.env.OWNER_EMAIL || 'kenji.kys@gmail.com';

app.get('/api/me', requireAuth, (req, res) => {
  const u = db.prepare('SELECT id, name, email, slug, slot_duration, ui_mode, registered_at, stripe_customer_id, plan, booking_horizon_days, CASE WHEN google_id IS NOT NULL THEN 1 ELSE 0 END as has_google FROM users WHERE id=?').get(req.session.userId);
  if (!u) return res.status(404).json({ error: 'not found' });
  const isOwner = u.email === OWNER_EMAIL;
  // オーナーのみ: セッションレベルのモードオーバーライドを適用
  const result = { ...u, isOwner };
  if (isOwner && req.session.uiModeOverride) {
    result.ui_mode = req.session.uiModeOverride;
  }
  res.json(result);
});

// オーナー専用: セッション内モード切替（DBは変更しない）
app.post('/api/me/preview-mode', requireAuth, express.json({ limit: '1kb' }), (req, res) => {
  const u = db.prepare('SELECT email FROM users WHERE id=?').get(req.session.userId);
  if (!u || u.email !== OWNER_EMAIL) return res.status(403).json({ error: 'forbidden' });
  const { mode } = req.body;
  if (!['simple', 'welfare'].includes(mode)) return res.status(400).json({ error: 'invalid mode' });
  req.session.uiModeOverride = mode;
  req.session.save(() => res.json({ ok: true, mode }));
});

// ---- API: my-plan ----
app.get('/api/my-plan', requireAuth, async (req, res) => {
  const u = db.prepare('SELECT plan, plan_expires, stripe_customer_id FROM users WHERE id=?').get(req.session.userId);
  const result = { plan: u?.plan || 'free', plan_expires: u?.plan_expires || null };
  if (u?.plan === 'trial' && u?.plan_expires) {
    const exp = new Date(String(u.plan_expires).replace(' ', 'T') + 'Z');
    result.trial_days_left = Math.max(0, Math.ceil((exp - Date.now()) / 86400000));
    result.is_trial_active = exp > new Date();
  }
  if (stripe && u?.stripe_customer_id) {
    try {
      const subs = await stripe.subscriptions.list({ customer: u.stripe_customer_id, limit: 1, status: 'all' });
      const sub = subs.data[0];
      if (sub) {
        result.stripe_status = sub.status;
        result.current_period_end = sub.current_period_end;
        result.trial_end = sub.trial_end;
        result.amount = sub.items?.data?.[0]?.price?.unit_amount;
        result.interval = sub.items?.data?.[0]?.price?.recurring?.interval;
      }
    } catch(e) { console.error('my-plan stripe error:', e.message); }
  }
  res.json(result);
});

// ---- UTAGE/UnivaPay Webhook ----
app.post('/api/utage-webhook', async (req, res) => {
  const utageSecret = process.env.UTAGE_WEBHOOK_SECRET || '';
  if (!utageSecret) return res.status(503).json({ error: 'webhook not configured' });
  const provided = req.headers['x-utage-secret'] || '';
  const ok = provided.length === utageSecret.length &&
    crypto.timingSafeEqual(Buffer.from(provided, 'utf8'), Buffer.from(utageSecret, 'utf8'));
  if (!ok) return res.status(403).json({ error: 'forbidden' });
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
    if (!email || !isValidEmail(email)) { console.log('[utage-webhook] no valid email found'); return; }
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

// ---- BNI Manager SSO ----

const TURN_SECRET = process.env.TURN_SECRET || '';
app.get('/api/ice-credentials', (req, res) => {
  const expiry = Math.floor(Date.now() / 1000) + 3600; // 1時間有効
  const username = `${expiry}:nicemeet`;
  const servers = [{ urls: ['stun:stun.l.google.com:19302'] }];
  if (TURN_SECRET) {
    const credential = require('crypto').createHmac('sha1', TURN_SECRET).update(username).digest('base64');
    servers.push({
      urls: ['turn:49.212.179.11:3478'],
      username,
      credential
    });
  }
  res.json({ iceServers: servers });
});

app.get('/api/bni-sso-token', requireAuth, (req, res) => {
  const user = db.prepare('SELECT name, email FROM users WHERE id=?').get(req.session.userId);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  const secret = process.env.BNI_SSO_SECRET || (() => { console.warn('[SECURITY] BNI_SSO_SECRET not set'); return crypto.randomBytes(32).toString('hex'); })();
  const payload = JSON.stringify({ name: user.name, email: user.email || '', exp: Date.now() + 5 * 60 * 1000 });
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const token = Buffer.from(payload).toString('base64url') + '.' + sig;
  res.json({ url: `https://gaiaarts.org/bni/?sso_token=${encodeURIComponent(token)}` });
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
      payment_method_collection: 'always',
      success_url: 'https://meet.gaiaarts.org/booking/dashboard?plan=success',
      cancel_url: 'https://meet.gaiaarts.org/booking/dashboard',
      locale: 'ja'
    });
    res.json({ url: session.url });
  } catch(e) { console.error('stripe checkout error:', e.message); res.status(500).json({ error: '決済処理に失敗しました' }); }
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
  } catch(e) { console.error('stripe portal error:', e.message); res.status(500).json({ error: 'ポータルの取得に失敗しました' }); }
});

app.post('/api/stripe/webhook', async (req, res) => {
  if (!stripe) return res.status(503).send('Stripe not configured');
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch(e) { console.error('stripe webhook error:', e.message); return res.status(400).send('Webhook Error'); }
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
  const { availability, slot_duration, booking_horizon_days } = req.body;
  const uid = req.session.userId;
  const avArr = Array.isArray(availability) ? availability.slice(0, 100) : [];
  db.prepare('DELETE FROM availability WHERE user_id=?').run(uid);
  const stmt = db.prepare('INSERT INTO availability (user_id, day_of_week, start_time, end_time) VALUES (?,?,?,?)');
  const timeRe = /^\d{2}:\d{2}$/;
  for (const a of avArr) {
    const dow = parseInt(a.day_of_week, 10);
    if (isNaN(dow) || dow < 0 || dow > 6) continue;
    if (typeof a.start_time !== 'string' || !timeRe.test(a.start_time)) continue;
    if (typeof a.end_time !== 'string' || !timeRe.test(a.end_time)) continue;
    stmt.run(uid, dow, a.start_time, a.end_time);
  }
  const sdVal = parseInt(slot_duration, 10);
  if (!isNaN(sdVal) && sdVal >= 15 && sdVal <= 240) db.prepare('UPDATE users SET slot_duration=? WHERE id=?').run(sdVal, uid);
  const hdVal = parseInt(booking_horizon_days, 10);
  if (!isNaN(hdVal) && hdVal >= 1 && hdVal <= 365) db.prepare('UPDATE users SET booking_horizon_days=? WHERE id=?').run(hdVal, uid);
  res.json({ ok: true });
});

// ---- API: bookings ----
app.get('/api/bookings', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM bookings WHERE user_id=? AND (cancelled IS NULL OR cancelled=0) ORDER BY start_time ASC').all(req.session.userId);
  res.json(rows);
});

app.patch('/api/bookings/:id/system', requireAuth, (req, res) => {
  const { system } = req.body;
  if (!['bni', ''].includes(system)) return res.status(400).json({ error: 'invalid system' });
  const booking = db.prepare('SELECT id FROM bookings WHERE id=? AND user_id=?').get(req.params.id, req.session.userId);
  if (!booking) return res.status(404).json({ error: 'not found' });
  db.prepare('UPDATE bookings SET meet_system=? WHERE id=?').run(system, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/bookings/:id', requireAuth, async (req, res) => {
  const booking = db.prepare('SELECT * FROM bookings WHERE id=? AND user_id=?').get(req.params.id, req.session.userId);
  if (!booking) return res.status(404).json({ error: 'not found' });
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.session.userId);
  if (booking.google_event_id) {
    const cal = getUserCalendarClient(user);
    if (cal) cal.events.delete({ calendarId: user.email, eventId: booking.google_event_id, sendUpdates: 'all' }).catch(() => {});
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

  const horizonDays = user.booking_horizon_days || 14;
  const date = req.query.date;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'invalid date' });

  // 予約受付期間チェック
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const targetDate = new Date(date + 'T00:00:00+09:00');
  const diffDays = Math.floor((targetDate - today) / (1000 * 60 * 60 * 24));
  if (diffDays >= horizonDays) return res.json({ slots: [], hostName: user.name, horizonDays });

  const dow = new Date(date + 'T12:00:00+09:00').getDay();
  const avail = db.prepare('SELECT * FROM availability WHERE user_id=? AND day_of_week=?').get(user.id, dow);
  if (!avail) return res.json({ slots: [], hostName: user.name, horizonDays });

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
    const cal = getUserCalendarClient(user);
    if (!cal) throw new Error('no calendar client');
    const fb = await cal.freebusy.query({
      requestBody: { timeMin: tMin, timeMax: tMax, timeZone: 'Asia/Tokyo', items: [{ id: user.email }] }
    });
    const busy = (fb.data.calendars[user.email] || fb.data.calendars.primary || {}).busy || [];
    filtered = filtered.filter(s => {
      const ss = new Date(s.start).getTime(), se = new Date(s.end).getTime();
      return !busy.some(b => ss < new Date(b.end).getTime() && se > new Date(b.start).getTime());
    });
  } catch (e) { console.error('freebusy error:', e.message); }

  res.json({ slots: filtered, hostName: user.name, horizonDays });
});

// ---- Public: book ----
app.post('/api/b/:slug/book', async (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE slug=?').get(req.params.slug);
  if (!user) return res.status(404).json({ error: 'not found' });

  const { booker_name, booker_email, start_time, end_time, purpose } = req.body;
  const cleanName = safeStr(booker_name, 100);
  const cleanEmail = safeStr(booker_email, 254);
  const cleanPurpose = safeStr(purpose, 500);
  if (!cleanName) return res.status(400).json({ error: '名前を入力してください' });
  if (cleanEmail && !isValidEmail(cleanEmail)) return res.status(400).json({ error: 'メールアドレスが正しくありません' });
  if (!start_time || !end_time || !isValidISODate(start_time) || !isValidISODate(end_time))
    return res.status(400).json({ error: '日時が正しくありません' });
  if (db.prepare('SELECT id FROM bookings WHERE user_id=? AND start_time=? AND (cancelled IS NULL OR cancelled=0)').get(user.id, start_time))
    return res.status(409).json({ error: 'この時間はすでに予約されています' });

  const meetRoom = crypto.randomBytes(4).toString('hex');
  const meetUrl = `https://meet.gaiaarts.org/?room=${meetRoom}&system=bni`;
  const cancelToken = crypto.randomBytes(16).toString('hex');
  const cancelUrl = `https://meet.gaiaarts.org/cancel?token=${cancelToken}`;

  let googleEventId = null;
  try {
    const calClient = getUserCalendarClient(user);
    if (!calClient) throw new Error('no calendar client');
    const event = await calClient.events.insert({
      calendarId: user.email,
      sendUpdates: 'all',
      requestBody: {
        summary: `${cleanName}さんとのミーティング`,
        description: `用件: ${cleanPurpose || 'なし'}\n\nビデオ通話URL: ${meetUrl}\n予約者: ${cleanName}${cleanEmail ? ` (${cleanEmail})` : ''}`,
        start: { dateTime: start_time, timeZone: 'Asia/Tokyo' },
        end: { dateTime: end_time, timeZone: 'Asia/Tokyo' }
      }
    });
    googleEventId = event.data.id;
  } catch (e) { console.error('calendar insert error:', e.message); }

  db.prepare('INSERT INTO bookings (user_id, booker_name, booker_email, start_time, end_time, purpose, meet_room, google_event_id, cancel_token, meet_system) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(user.id, cleanName, cleanEmail, start_time, end_time, cleanPurpose, meetRoom, googleEventId, cancelToken, 'bni');

  // メール送信
  const startDt = new Date(start_time);
  const endDt = new Date(end_time);
  const fmtDate = startDt.toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
  const fmtTime = `${startDt.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })} 〜 ${endDt.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}`;

  // 予約者へ
  if (cleanEmail) {
    await sendMail(cleanEmail, `【予約確認】${user.name}さんとのミーティング`,
`${cleanName} 様

ミーティングのご予約が完了しました。

━━━━━━━━━━━━━━━━━━
日時：${fmtDate} ${fmtTime}
相手：${user.name}
用件：${cleanPurpose || 'なし'}
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
  await sendMail(user.email, `【新規予約】${cleanName}さんから予約が入りました`,
`新しいミーティングの予約が入りました。

━━━━━━━━━━━━━━━━━━
日時：${fmtDate} ${fmtTime}
予約者：${cleanName}${cleanEmail ? ` (${cleanEmail})` : ''}
用件：${cleanPurpose || 'なし'}
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

// 録画ファイルはトークン認証でのみ配信（公開URL廃止）
const REC_TTL = 24 * 60 * 60 * 1000;
const recordingTokens = new Map(); // token -> { filename, expires }
function createRecordingToken(filename) {
  const token = crypto.randomBytes(32).toString('hex');
  recordingTokens.set(token, { filename, expires: Date.now() + REC_TTL });
  return `https://meet.gaiaarts.org/api/recording/${token}`;
}
app.get('/api/recording/:token', (req, res) => {
  const { token } = req.params;
  if (!/^[a-f0-9]{64}$/.test(token)) return res.status(404).send('not found');
  const entry = recordingTokens.get(token);
  if (!entry || Date.now() > entry.expires) return res.status(404).send('not found');
  const filepath = path.join(recDir, entry.filename);
  if (!fs.existsSync(filepath)) return res.status(404).send('not found');
  res.sendFile(filepath);
});


// ---- 対面録音モード専用：記録種別 ----
const FACE_RECORD_TYPES = {
  houmon: ['訪問記録（サービス提供記録）', 'モニタリング面談記録', 'サービス担当者会議記録'],
  houdei: ['保護者面談記録', '個別支援計画モニタリング記録', '個別支援会議記録'],
  kaigo:  ['日常生活支援記録', '家族・入居者面談記録', '月次モニタリング記録', '運営推進会議記録'],
  shuro:  ['個別面談記録', '個別支援計画モニタリング記録', '就労移行支援面談記録', '個別支援会議記録', '見学・視察メモ', 'スタッフ情報共有']
};

// ---- 対面録音モード専用：GPTプロンプト ----
const BNI_PROMPT = `あなたはBNI（Business Network International）の1-2-1ミーティング専門の記録アシスタントです。
以下の会話からGAINS情報と紹介機会を抽出してください。

【重要：文字起こしの品質について】
- 音声認識（Whisper）による自動文字起こしのため、誤認識・ノイズ文字列が含まれる場合があります
- 「ブーブー」「パップ」「ぬー」などの意味不明な断片は無視し、前後の文脈から会話の意図を読み取ること
- 多少garbledでも、会話全体から合理的に読み取れる内容は積極的に抽出すること

【守るルール】
- 会話の文脈・流れから合理的に読み取れる内容を記録すること
- 明らかに存在しない情報の創作・捏造は絶対にしないこと
- 会話に一切出てきていない情報は空文字 "" にすること
- 文字数が極端に少ない（実質30文字未満）か、挨拶のみで会話が全くない場合だけ、summaryに「会話が短すぎるか、1-2-1の内容ではありませんでした」と入れ、他フィールドは全て "" にすること

GAINS:
G - Goals（目標）: ビジネス目標・人生の夢・達成したいこと
A - Accomplishments（実績）: 最近の成功・受賞・成果
I - Interests（趣味・関心）: 趣味・プライベートの関心・ライフスタイル
N - Networks（人脈）: 所属団体・コミュニティ・業界つながり
S - Skills（スキル）: 専門スキル・資格・得意分野

必ずJSON形式のみで出力すること（他のテキストは一切含めない）:
{
  "summary": "1-2-1全体の要約（3-4文）",
  "gains": {
    "goals": "会話から読み取れた目標。なければ空文字",
    "accomplishments": "会話から読み取れた実績。なければ空文字",
    "interests": "会話から読み取れた趣味・関心。なければ空文字",
    "networks": "会話から読み取れた人脈。なければ空文字",
    "skills": "会話から読み取れたスキル。なければ空文字"
  },
  "referral_hints": "会話から読み取れた紹介機会。なければ空文字",
  "follow_up": "会話から読み取れたフォローアップ。なければ空文字"
}`;

// ---- ビデオ通話モード専用：記録種別・GPTプロンプト ----
const VIDEO_CALL_RECORD_TYPES = {
  shuro: ['家族・保護者との面談', '就労先企業との連絡調整', '相談支援専門員・ハローワーク連絡', '関係機関との担当者会議', 'スタッフ間ミーティング', '利用者本人との面談（リモート）'],
  houmon: ['利用者・家族との連絡', 'ケアマネージャーとの連絡', 'サービス担当者会議（オンライン）', 'スタッフ間ミーティング'],
  houdei: ['保護者との面談', '学校・教育機関との連絡', '専門家（PT・OT・ST等）との連絡', '関係機関との担当者会議', 'スタッフ間ミーティング'],
  kaigo:  ['家族との面談', 'ケアマネージャーとの連絡', '医療機関との連絡', 'サービス担当者会議（オンライン）', 'スタッフ間ミーティング'],
  roukin: ['家族との面談', 'ケアマネ・医療機関との連絡', '担当者会議（オンライン）', 'スタッフ間ミーティング'],
  beauty: ['顧客カウンセリング（オンライン）', 'メーカー・仕入先との商談', 'スタッフミーティング']
};

const VIDEO_CALL_PROMPTS = {
  shuro: {
    "家族・保護者との面談": `以下は就労継続支援スタッフと利用者の家族・保護者とのビデオ通話の文字起こしです。「家族・保護者連絡記録」として業務記録文体（〜との報告があった／〜の意向が示された）で作成してください。
以下の見出しで記述してください：
【家族・保護者の報告事項】「〜より〜との報告あり」形式で
【利用者の状況についての情報共有】
【家族・保護者の意向・要望】
【施設側からの説明・合意内容】
【次回連絡予定・対応事項】`,
    "就労先企業との連絡調整": `以下は就労継続支援スタッフと就労先企業担当者とのビデオ通話の文字起こしです。「就労先連絡記録」として業務記録文体で作成してください。
以下の見出しで記述してください：
【連絡目的・経緯】
【就労先からの報告・意見】
【利用者の職場での状況】
【調整・合意内容】
【次回連絡予定・フォローアップ事項】`,
    "相談支援専門員・ハローワーク連絡": `以下は就労継続支援スタッフと相談支援専門員またはハローワーク担当者とのビデオ通話の文字起こしです。「関係機関連絡記録」として業務記録文体で作成してください。
以下の見出しで記述してください：
【連絡目的・経緯】
【相談支援専門員・ハローワークからの情報提供】
【利用者に関する情報共有】
【今後の支援方針・役割分担の確認】
【次回連絡・会議予定】`,
    "関係機関との担当者会議": `以下は就労継続支援事業所を含む複数の関係機関によるオンライン担当者会議の文字起こしです。「担当者会議記録（オンライン）」として業務記録文体で作成してください。
以下の見出しで記述してください：
【参加機関・参加者】
【協議事項・各機関からの報告】
【利用者の現状・ニーズ】
【支援方針・役割分担の合意内容】
【アクションアイテム・担当者】
【次回会議予定】`,
    "スタッフ間ミーティング": `以下は就労継続支援スタッフ間のオンラインミーティングの文字起こしです。「スタッフミーティング記録」として業務記録文体で作成してください。
以下の見出しで記述してください：
【議題・確認事項】
【利用者に関する情報共有・申し送り事項】
【運営・業務に関する決定事項】
【課題・対応策】
【次回ミーティング予定・TODO】`,
    "利用者本人との面談（リモート）": `以下は就労継続支援スタッフと利用者本人とのビデオ通話による個別面談の文字起こしです。「個別面談記録（リモート）」として業務記録文体（〜との訴えあり／〜が確認された）で作成してください。
以下の見出しで記述してください：
【利用者の現在の状況・体調】
【訴え・相談内容】
【就労・生活に関する状況】
【支援内容・アドバイス】
【次回面談予定・対応事項】`,
  },
  houmon: {
    "利用者・家族との連絡": `以下は訪問介護事業所スタッフと利用者または家族とのビデオ通話の文字起こしです。「利用者・家族連絡記録」として業務記録文体で作成してください。
以下の見出しで記述してください：
【連絡目的・経緯】
【利用者・家族からの報告・要望】「〜より〜との申し出あり」形式で
【サービスに関する確認事項】
【合意・決定内容】
【次回連絡・訪問予定】`,
    "ケアマネージャーとの連絡": `以下は訪問介護スタッフとケアマネージャーとのビデオ通話の文字起こしです。「ケアマネージャー連絡記録」として業務記録文体で作成してください。
以下の見出しで記述してください：
【連絡内容・目的】
【ケアマネージャーからの情報・指示】
【利用者状況の共有】
【ケアプランに関する調整・確認事項】
【次回連絡予定・対応事項】`,
    "サービス担当者会議（オンライン）": `以下は訪問介護サービスに関するオンライン担当者会議の文字起こしです。「サービス担当者会議記録（オンライン）」として業務記録文体で作成してください。
以下の見出しで記述してください：
【参加者】
【協議事項・各担当者からの報告】
【利用者の現状・ニーズ】
【支援方針・役割分担の合意内容】
【次回開催予定】`,
    "スタッフ間ミーティング": `以下は訪問介護事業所スタッフ間のオンラインミーティングの文字起こしです。「スタッフミーティング記録」として業務記録文体で作成してください。
以下の見出しで記述してください：
【議題・確認事項】
【利用者に関する申し送り事項】
【業務・運営に関する決定事項】
【課題・対応策】
【次回ミーティング予定・TODO】`,
  },
  houdei: {
    "保護者との面談": `以下は放課後等デイサービスの職員と保護者とのビデオ通話の文字起こしです。「保護者連絡記録（ビデオ面談）」として業務記録文体で作成してください。
以下の見出しで記述してください：
【面談目的・経緯】
【保護者からの報告・要望】「保護者より〜との報告あり」形式で
【お子さんの状態・変化の共有】
【合意事項・次回対応】
【次回連絡・面談予定】`,
    "学校・教育機関との連絡": `以下は放課後等デイサービスと学校・教育機関とのビデオ通話の文字起こしです。「学校連携記録」として業務記録文体で作成してください。
以下の見出しで記述してください：
【連絡目的・経緯】
【学校側からの情報・報告】
【お子さんの状況共有】
【連携内容・合意事項】
【次回連絡予定】`,
    "専門家（PT・OT・ST等）との連絡": `以下は放課後等デイサービスと専門家（理学療法士・作業療法士・言語聴覚士等）とのビデオ通話の文字起こしです。「専門家連携記録」として業務記録文体で作成してください。
以下の見出しで記述してください：
【連絡目的・専門家の氏名・職種】
【専門家からの評価・アドバイス】
【支援への反映事項】
【保護者への情報共有内容】
【次回連絡・評価予定】`,
    "関係機関との担当者会議": `以下は放課後等デイサービスが参加したオンライン担当者会議の文字起こしです。「担当者会議記録（オンライン）」として業務記録文体で作成してください。
以下の見出しで記述してください：
【参加者・機関名】
【各機関からの報告・情報共有】
【お子さんの現状・ニーズ】
【支援方針・役割分担の合意内容】
【次回会議予定】`,
    "スタッフ間ミーティング": `以下は放課後等デイサービスのスタッフ間オンラインミーティングの文字起こしです。「スタッフミーティング記録」として業務記録文体で作成してください。
以下の見出しで記述してください：
【議題・確認事項】
【お子さんに関する情報共有・申し送り】
【運営・業務の決定事項】
【課題・対応策】
【次回ミーティング予定・TODO】`,
  },
  kaigo: {
    "家族との面談": `以下は介護グループホームの職員と入居者家族とのビデオ通話の文字起こしです。「家族連絡記録（ビデオ面談）」として業務記録文体で作成してください。
以下の見出しで記述してください：
【面談目的・経緯】
【家族からの報告・意向・要望】「ご家族より〜との申し出あり」形式で
【入居者の状態共有】
【合意事項・施設側の対応】
【次回連絡・面談予定】`,
    "ケアマネージャーとの連絡": `以下は介護グループホームの職員とケアマネージャーとのビデオ通話の文字起こしです。「ケアマネージャー連絡記録」として業務記録文体で作成してください。
以下の見出しで記述してください：
【連絡内容・目的】
【ケアマネージャーからの情報・指示】
【入居者状況の共有】
【ケアプランに関する調整・確認事項】
【次回連絡・モニタリング予定】`,
    "医療機関との連絡": `以下は介護グループホームの職員と医療機関とのビデオ通話の文字起こしです。「医療機関連絡記録」として業務記録文体で作成してください。
以下の見出しで記述してください：
【連絡目的・入居者名】
【医療機関からの情報・指示】
【入居者の状態・症状の報告】
【対応内容・処置・投薬変更等】
【次回受診・連絡予定】`,
    "サービス担当者会議（オンライン）": `以下は介護グループホームが参加したオンラインサービス担当者会議の文字起こしです。「サービス担当者会議記録（オンライン）」として業務記録文体で作成してください。
以下の見出しで記述してください：
【参加者・機関名】
【各担当者からの報告・情報共有】
【入居者の現状・ニーズ】
【ケアプランの合意・変更内容】
【次回開催予定】`,
    "スタッフ間ミーティング": `以下は介護グループホームのスタッフ間オンラインミーティングの文字起こしです。「スタッフミーティング記録」として業務記録文体で作成してください。
以下の見出しで記述してください：
【議題・確認事項】
【入居者に関する情報共有・申し送り】
【業務・運営の決定事項】
【課題・対応策】
【次回ミーティング予定・TODO】`,
  },
  roukin: {
    "家族との面談": `以下は老人ホームの職員と入居者家族とのビデオ通話の文字起こしです。「家族連絡記録（ビデオ面談）」として業務記録文体で作成してください。
以下の見出しで記述してください：
【面談目的・経緯】
【家族からの報告・意向・要望】「ご家族より〜との申し出あり」形式で
【入居者の状態共有】
【合意事項・施設側の対応】
【次回連絡・面談予定】`,
    "ケアマネ・医療機関との連絡": `以下は老人ホームの職員とケアマネージャーまたは医療機関とのビデオ通話の文字起こしです。「専門家連絡記録」として業務記録文体で作成してください。
以下の見出しで記述してください：
【連絡目的・相手の職種・機関】
【相手側からの情報・指示・アドバイス】
【入居者状況の報告】
【対応・合意内容】
【次回連絡予定】`,
    "担当者会議（オンライン）": `以下は老人ホームが参加したオンライン担当者会議の文字起こしです。「担当者会議記録（オンライン）」として業務記録文体で作成してください。
以下の見出しで記述してください：
【参加者・機関名】
【各担当者からの報告・情報共有】
【入居者の現状・ニーズ】
【支援方針・役割分担の合意内容】
【次回会議予定】`,
    "スタッフ間ミーティング": `以下は老人ホームのスタッフ間オンラインミーティングの文字起こしです。「スタッフミーティング記録」として業務記録文体で作成してください。
以下の見出しで記述してください：
【議題・確認事項】
【入居者に関する情報共有・申し送り】
【業務・運営の決定事項】
【課題・対応策】
【次回ミーティング予定・TODO】`,
  },
  beauty: {
    "顧客カウンセリング（オンライン）": `以下は美容事業スタッフと顧客とのビデオカウンセリングの文字起こしです。「オンラインカウンセリング記録」として業務記録文体で作成してください。
以下の見出しで記述してください：
【顧客の相談内容・ニーズ】
【現状の確認（肌・髪・ライフスタイル等）】
【提案内容・説明事項】
【お客様の反応・意向】
【次回アクション・フォローアップ】`,
    "メーカー・仕入先との商談": `以下は美容事業スタッフとメーカーまたは仕入先とのビデオ商談の文字起こしです。「商談記録」として業務記録文体で作成してください。
以下の見出しで記述してください：
【商談目的・相手会社名・担当者名】
【製品・サービスの説明内容】
【価格・条件・納期の確認事項】
【合意内容・発注事項】
【次回連絡・フォローアップ予定】`,
    "スタッフミーティング": `以下は美容事業のスタッフ間オンラインミーティングの文字起こしです。「スタッフミーティング記録」として業務記録文体で作成してください。
以下の見出しで記述してください：
【議題・確認事項】
【業務・顧客対応の情報共有】
【決定事項・方針】
【課題・改善案】
【次回ミーティング予定・TODO】`,
  }
};

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

【注意】A型は雇用契約に基づくため、就労条件や賃金に関する発言は特に正確に記録すること。工賃・賃金の具体的数値はAI生成ではなく担当者が確認・補足すること。

【必須制約】文字起こしに記載されていない事実・数値・発言は絶対に作成しないこと。該当するセクションの内容が文字起こしにない場合は「（本日の面談では言及なし）」と記載すること。`,

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

【注意】本人が参加できなかった場合は必ずその理由を記録すること（法定義務）。日付順序（原案 ≦ 会議 ≦ 本作成 ≦ 同意）を必ず確認すること。`,

    '見学・視察メモ': `以下は就労継続支援事業所の見学・視察時の会話・メモの文字起こしです。見学・視察の記録として要点をまとめてください。

【記載項目（文字起こしに内容がある項目のみ）】
■ 見学先・視察場所
■ 作業内容・サービス内容の概要
■ 気づき・印象・特記事項
■ 質疑応答の内容
■ 今後の検討事項・参考にする点

【必須制約】文字起こしに記載されていない事実・数値・発言は絶対に作成しないこと。該当する項目の内容が文字起こしにない場合は「（記録なし）」と記載すること。`,

    'スタッフ情報共有': `以下はスタッフ間の情報共有・申し送り・ミーティングの文字起こしです。スタッフ向けの情報共有メモとして要点をまとめてください。

【記載項目（文字起こしに内容がある項目のみ）】
■ 共有された利用者情報・状況変化
■ 業務連絡・申し送り事項
■ 課題・検討事項
■ 決定事項・対応方針
■ 次回確認事項

【必須制約】文字起こしに記載されていない事実・数値・発言は絶対に作成しないこと。該当する項目の内容が文字起こしにない場合は「（記録なし）」と記載すること。`
  }
};

const storage = multer.diskStorage({
  destination: recDir,
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname) || '.webm').toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 8);
    cb(null, 'rec-' + Date.now() + '-' + crypto.randomBytes(8).toString('hex') + ext);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['video/webm', 'video/mp4', 'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'application/octet-stream'];
    cb(null, allowed.includes(file.mimetype));
  }
}); // 2GB

async function transcribeAndSummarize(filepath, filename, roomId) {
  try {
    if (roomId) io.to(roomId).emit('transcription-status', { status: 'transcribing' });
    const transcription = await whisperClient.audio.transcriptions.create({
      file: fs.createReadStream(filepath),
      model: 'whisper-large-v3',
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
        transcriptUrl: createRecordingToken(transcriptFilename),
        summaryUrl: createRecordingToken(summaryFilename),
        transcriptFilename,
        summaryFilename,
      });
    }
  } catch (e) {
    console.error('transcription error:', e.message);
    if (roomId) io.to(roomId).emit('transcription-status', { status: 'error' });
  }
}

app.post('/api/upload-recording', uploadLimiter, requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file' });
  const url = createRecordingToken(req.file.filename);
  const roomId = typeof req.body.roomId === 'string' ? req.body.roomId.slice(0, 128) : '';
  const isActiveRoom = roomId && rooms && rooms.has(roomId);
  if (isActiveRoom) {
    io.to(roomId).emit('recording-ready', {
      url,
      filename: req.file.filename,
      uploader: req.body.uploaderName ? String(req.body.uploaderName).trim().slice(0, 50) : '参加者'
    });
  }
  res.json({ ok: true, url });
  // アクティブなルームのみ AI 処理（費用乱用防止）
  if (openai && isActiveRoom) transcribeAndSummarize(req.file.path, req.file.filename, roomId);
});

// 録画ファイルとトークンを24時間後に自動削除（1時間ごとにチェック）
setInterval(() => {
  const now = Date.now();
  // 期限切れトークンを削除
  for (const [tok, entry] of recordingTokens) {
    if (now > entry.expires) recordingTokens.delete(tok);
  }
  // 期限切れファイルを削除
  fs.readdir(recDir, (err, files) => {
    if (err) return;
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
    const ext = (path.extname(file.originalname) || '').toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 8);
    cb(null, Date.now() + '-' + require('crypto').randomBytes(8).toString('hex') + ext);
  }
});
const ALLOWED_CHAT_TYPES = new Set([
  'image/jpeg','image/png','image/gif','image/webp',
  'application/pdf',
  'text/plain','text/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);
const uploadFileMiddleware = multer({
  storage: uploadStorage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, ALLOWED_CHAT_TYPES.has(file.mimetype))
});

app.post('/api/upload-file', uploadLimiter, requireAuth, uploadFileMiddleware.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file' });
  const url = '/uploads/' + req.file.filename;
  const origName = req.file.originalname;
  const safeOrigName = escHtml(origName);
  const safeUrl = escHtml(url);
  const isImage = req.file.mimetype.startsWith('image/');
  const roomId = typeof req.body.roomId === 'string' ? req.body.roomId.slice(0, 128) : '';
  const senderName = req.body.senderName ? String(req.body.senderName).trim().slice(0, 50) : '参加者';
  const time = new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
  const msgHtml = isImage
    ? `<img src="${safeUrl}" alt="${safeOrigName}" class="chat-img" onclick="window.open('${safeUrl}','_blank')">`
    : `<a href="${safeUrl}" download="${safeOrigName}" target="_blank" class="chat-file-link">📎 ${safeOrigName}</a>`;
  if (roomId && rooms.has(roomId)) io.to(roomId).emit('chat-file', { from: senderName, message: msgHtml, time });
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

app.post('/api/audio-chunk', uploadLimiter, audioChunkUpload.single('chunk'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file' });
  const { sessionId, chunkIndex } = req.body;
  if (!sessionId || !/^[\w-]{5,60}$/.test(sessionId)) {
    fs.unlink(req.file.path, () => {}); return res.status(400).json({ error: 'invalid sessionId' });
  }
  const chunkRoomId = typeof req.body.roomId === 'string' ? req.body.roomId : '';
  if (!chunkRoomId || !rooms.has(chunkRoomId)) {
    fs.unlink(req.file.path, () => {}); return res.status(403).json({ error: 'invalid room' });
  }
  const chunkIdx = parseInt(chunkIndex, 10);
  if (isNaN(chunkIdx) || chunkIdx < 0 || chunkIdx > 9999) {
    fs.unlink(req.file.path, () => {}); return res.status(400).json({ error: 'invalid chunkIndex' });
  }
  const ext = (req.body.audioExt || 'webm').replace(/[^a-z0-9]/g, '').slice(0, 4) || 'webm';
  const finalName = `audio-${sessionId}-${String(chunkIdx).padStart(4,'0')}.${ext}`;
  console.log(`[audio-chunk] session=${sessionId} idx=${chunkIdx} size=${req.file.size}bytes ext=${ext}`);
  fs.rename(req.file.path, path.join(recDir, finalName), () => {});
  res.json({ ok: true });
});

const formParser = multer().none();
app.post('/api/audio-finalize', uploadLimiter, formParser, async (req, res) => {
  res.json({ ok: true });
  const { sessionId } = req.body;
  let email = req.body.email || '';
  // セッションログイン中は登録メールアドレスを優先
  if (req.session?.userId) {
    const su = db.prepare('SELECT email FROM users WHERE id=?').get(req.session.userId);
    if (su?.email) email = su.email;
  }
  console.log(`[audio-finalize] session=${sessionId} email=${email} openai=${!!openai}`);
  if (!email || !sessionId || !openai) return;
  if (!isValidEmail(email) || !/^[\w-]{5,60}$/.test(sessionId)) return;
  const fUser = db.prepare('SELECT plan, plan_expires, facility_id FROM users WHERE email=?').get(email);
  const recordMode = safeStr(req.body.recordMode, 20);
  const welfareSystem = safeStr(req.body.welfareSystem, 20);
  const welfareRecordType = safeStr(req.body.welfareRecordType, 50);
  const memberName = safeStr(req.body.memberName, 100);
  const staffName = safeStr(req.body.staffName, 100);
  const isWelfareRecord = recordMode === 'welfare' && welfareSystem && welfareRecordType;
  const isBniRecord = recordMode === 'bni';
  const _cid = parseInt(req.body.bniContactId, 10);
  const bniContactId = (!isNaN(_cid) && _cid > 0) ? _cid : null;
  if (recordMode === 'none') { console.log('[audio-finalize] mode=none, skip'); return; }
  let canUseAI = false;
  if (isBniRecord) {
    canUseAI = !!(req.session?.userId || req.session?.bniUserId);
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
    canUseAI = isActivePlan(fUser);
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
        const result = await whisperClient.audio.transcriptions.create({
          file: fs.createReadStream(sendPath),
          model: 'whisper-large-v3',
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

    // 話者タグを除いた実テキスト文字数で有効な会話かチェック
    const transcriptTextOnly = transcript.replace(/【話者[A-Z]】/g, '').trim();
    if (!transcriptTextOnly || transcriptTextOnly.length < 30) {
      if (isBniRecord) {
        // BNIモード：チェックイン等の誤入室でメールを送らない
        console.log(`[audio-finalize] BNI: transcript too short (${transcriptTextOnly.length} chars), skip mail`);
      } else {
        // 施設モード：短くても通知する
        await sendMail(email, '【NiceMeet】会議の文字起こし', '音声が短すぎるか検出されませんでした。');
      }
      return;
    }

    const welfarePrompt = isWelfareRecord ? (VIDEO_CALL_PROMPTS[welfareSystem]?.[welfareRecordType] || WELFARE_PROMPTS[welfareSystem]?.[welfareRecordType] || null) : null;
    const systemPrompt = isBniRecord
      ? BNI_PROMPT + (staffName || memberName
          ? `\n\n【参加者情報】\nBNIメンバー（記録者）: ${staffName || '不明'} / コンタクト（相手方）: ${memberName || '不明'}\n話者A・話者Bのどちらがどちらかは文脈（名前の呼び合い・職業紹介等）から判断し、それぞれの情報を統合してGAINSを抽出してください。`
          : '')
      : welfarePrompt
        ? `${welfarePrompt}

対象者: ${memberName || '（記載なし）'} / 担当: ${staffName || '（記載なし）'}`
        : '以下はビデオ会議の文字起こしです（話者A・話者Bは異なる参加者です）。日本語で要約してください。箇条書きで主要な議題、決定事項、アクションアイテムをまとめてください。';
    const completion = await openai.chat.completions.create({
      model: isBniRecord ? 'gpt-4o' : 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: transcript }
      ]
    });
    const summary = completion.choices[0].message.content;

    const durMin = chunkFiles.length * 2;
    // モード別処理：各関数は完全独立。片方を修正しても他方に影響しない。
    if (isBniRecord) {
      await handleBniFinalize({ email, sessionId, staffName, memberName, bniContactId, durMin, transcript, summary });
    } else {
      await handleFacilityFinalize({ email, sessionId, fUser, welfareSystem, welfareRecordType, memberName, staffName, durMin, transcript, summary, isWelfareRecord });
    }
  } catch(e) {
    console.error('audio finalize error:', e.message);
    sendMail(email, '【NiceMeet】文字起こしエラー', '処理中にエラーが発生しました。').catch(() => {});
  }
});

// ================================================================
// BNIモード専用処理
// このファイルで BNI に関わる変更はここだけ修正する。施設モードには触れない。
// ================================================================
async function handleBniFinalize({ email, sessionId, staffName, memberName, bniContactId, durMin, transcript, summary }) {
  let bniData = { summary, gains: {}, referral_hints: '', follow_up: '' };
  try {
    const cleaned = summary.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    bniData = Object.assign(bniData, JSON.parse(cleaned));
    console.log('[bni-finalize] JSON parse OK, gains keys:', Object.keys(bniData.gains || {}));
  } catch(e) { console.warn('[bni-finalize] JSON parse failed:', e.message, '| raw:', summary.slice(0, 100)); }

  const bniWebhookUrl = process.env.BNI_WEBHOOK_URL || 'http://localhost:8300/api/nicemeet-webhook';
  const bniSecret = process.env.BNI_WEBHOOK_SECRET || (console.warn('[SECURITY] BNI_WEBHOOK_SECRET not set, using default'), 'nicemeet-bni-2026');
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
    console.log(`[bni-finalize] sent to BNI app user=${staffName} contact=${memberName}`);

    // R2バックアップ保存
    const driveUrl = process.env.DRIVE_INTERNAL_URL || 'http://localhost:8309/api/internal/upload-json';
    const driveSecret = process.env.DRIVE_INTERNAL_SECRET || (console.warn('[SECURITY] DRIVE_INTERNAL_SECRET not set, using default'), 'gaia-internal-2026');
    const r2Date = new Date().toISOString().slice(0, 10);
    const r2Name = (memberName || 'unknown').replace(/[^\w぀-鿿]/g, '_');
    const r2Key = `nicemeet/bni/${r2Date}/${sessionId}-${r2Name}.json`;
    const r2Body = JSON.stringify({
      date: r2Date, bni_user: staffName, contact_name: memberName,
      duration_minutes: durMin, transcript,
      summary: bniData.summary || summary,
      gains: bniData.gains || {},
      referral_hints: bniData.referral_hints || '',
      follow_up: bniData.follow_up || ''
    }, null, 2);
    fetch(driveUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-secret': driveSecret },
      body: JSON.stringify({ key: r2Key, content: r2Body })
    }).then(() => console.log('[bni-finalize] R2 saved:', r2Key))
      .catch(e => console.error('[bni-finalize] R2 error:', e.message));
  } catch(e) {
    console.error('[bni-finalize] webhook error:', e.message);
  }

  await sendMail(email,
    `【NiceMeet BNI】1-2-1ミーティング記録${memberName ? '（' + memberName + 'さん）' : ''}`,
`━━━━━━━━━━━━━━━━━━
【AI要約】
━━━━━━━━━━━━━━━━━━
${summary}

━━━━━━━━━━━━━━━━━━
【文字起こし（全文）】
━━━━━━━━━━━━━━━━━━
${transcript}
`);
}

// ================================================================
// 施設モード専用処理
// このファイルで 施設モード に関わる変更はここだけ修正する。BNIモードには触れない。
// ================================================================
async function handleFacilityFinalize({ email, sessionId, fUser, welfareSystem, welfareRecordType, memberName, staffName, durMin, transcript, summary, isWelfareRecord }) {
  if (fUser?.facility_id) {
    if (isWelfareRecord) {
      db.prepare(
        'INSERT INTO nm_call_records (facility_id, room_id, welfare_system, record_type, member_name, staff_name, summary_text, raw_transcript, source) VALUES (?,?,?,?,?,?,?,?,?)'
      ).run(fUser.facility_id, sessionId, welfareSystem, welfareRecordType, memberName, staffName, summary, transcript, 'video');
      console.log(`[facility-finalize] saved to nm_call_records: ${welfareSystem}/${welfareRecordType} member=${memberName}`);
    } else {
      db.prepare(
        'INSERT INTO nm_meetings (facility_id, room_id, host_email, started_at, ended_at, duration_minutes, ai_summary_used, summary_text) VALUES (?,?,?,datetime(\'now\',?),datetime(\'now\'),?,1,?)'
      ).run(fUser.facility_id, sessionId, email, `-${durMin} minutes`, durMin, summary);
    }
  }

  const mailSubject = isWelfareRecord
    ? `【NiceMeet】${welfareRecordType}${memberName ? '（' + memberName + '）' : ''}`
    : '【NiceMeet】会議の文字起こし・要約';
  const mailHeader = isWelfareRecord
    ? `【${welfareRecordType}】\n対象: ${memberName || '（記載なし）'} / 担当: ${staffName || '（記載なし）'} / 面談日: ${new Date().toLocaleDateString('ja-JP')}`
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
}

// ---- Public: cancel by token ----
app.get('/api/cancel-info', (req, res) => {
  const token = req.query.token;
  if (!token || !/^[a-f0-9]{32}$/.test(token)) return res.json({ found: false });
  const booking = db.prepare(
    'SELECT b.booker_name, b.start_time, b.end_time, b.cancelled, u.name as host_name, u.slug FROM bookings b JOIN users u ON b.user_id = u.id WHERE b.cancel_token=?'
  ).get(token);
  if (!booking) return res.json({ found: false });
  res.json({ found: true, ...booking });
});

app.post('/api/cancel', async (req, res) => {
  const { token } = req.body;
  if (!token || !/^[a-f0-9]{32}$/.test(token)) return res.status(400).json({ error: '無効なリクエストです' });
  const booking = db.prepare(
    'SELECT b.*, u.name as host_name, u.email as host_email, u.slug FROM bookings b JOIN users u ON b.user_id = u.id WHERE b.cancel_token=?'
  ).get(token);
  if (!booking) return res.status(404).json({ error: '予約が見つかりません' });
  if (booking.cancelled) return res.status(409).json({ error: 'すでにキャンセル済みです' });

  db.prepare('UPDATE bookings SET cancelled=1 WHERE cancel_token=?').run(token);

  if (booking.google_event_id) {
    const host = db.prepare('SELECT * FROM users WHERE email=?').get(booking.host_email);
    const cal = getUserCalendarClient(host);
    if (cal) cal.events.delete({ calendarId: booking.host_email, eventId: booking.google_event_id, sendUpdates: 'all' }).catch(() => {});
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
  if (!room || typeof room !== 'string' || room.length > 64) return res.json({ found: false });
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
// BNI事前情報キャプチャ → BNIアプリに連絡先登録
app.post('/api/bni/contact-capture', async (req, res) => {
  res.json({ ok: true });
  const { bni_user, name, email, is_bni_member, category, chapter } = req.body;
  if (!bni_user || !name || !email || !isValidEmail(email)) return;
  const bniWebhookUrl = process.env.BNI_WEBHOOK_URL?.replace('/api/nicemeet-webhook', '/api/nicemeet-contact')
    || 'http://localhost:8300/api/nicemeet-contact';
  const bniSecret = process.env.BNI_WEBHOOK_SECRET || (console.warn('[SECURITY] BNI_WEBHOOK_SECRET not set, using default'), 'nicemeet-bni-2026');
  try {
    await fetch(bniWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-nicemeet-secret': bniSecret },
      body: JSON.stringify({ bni_user, name, email, is_bni_member, category, chapter })
    });
    console.log(`[bni-contact-capture] user=${bni_user} contact=${name} bni=${is_bni_member}`);
  } catch(e) { console.error('[bni-contact-capture] error:', e.message); }
});


// ── 福祉SaaS 施設モードSSO ───────────────────────────────────────────
app.get('/api/welfare-sso', async (req, res) => {
  const { token, dest } = req.query;
  if (!token) return res.redirect('/');

  try {
    const [payloadB64, sig] = token.split('.');
    if (!payloadB64 || !sig || !/^[a-f0-9]{64}$/.test(sig)) return res.redirect('/');

    const welfareSecret = process.env.WELFARE_SSO_SECRET || '';
    if (!welfareSecret) { console.warn('[welfare-sso] WELFARE_SSO_SECRET not set — rejecting'); return res.redirect('/'); }
    const expectedSig = crypto.createHmac('sha256', welfareSecret)
      .update(payloadB64).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expectedSig, 'hex'))) {
      console.warn('[welfare-sso] invalid signature');
      return res.redirect('/');
    }

    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
    if (!payload.exp || Date.now() / 1000 > payload.exp) {
      console.warn('[welfare-sso] token expired');
      return res.redirect('/');
    }

    const email = payload.email;
    const officeName = payload.office_name || 'welfare';

    let user = db.prepare('SELECT * FROM users WHERE email=?').get(email);

    // nm_facilities に事業所を登録（なければ作成）
    let facility = db.prepare('SELECT * FROM nm_facilities WHERE admin_email=?').get(email);
    if (!facility) {
      db.prepare(
        'INSERT INTO nm_facilities (name, admin_email, contact_name, trial_status) VALUES (?,?,?,?)'
      ).run(officeName, email, officeName, 'active');
      facility = db.prepare('SELECT * FROM nm_facilities WHERE admin_email=?').get(email);
    }
    // 拠点が0件の場合はデフォルト1拠点を自動作成（AI利用時間計算のため）
    const locCount = db.prepare('SELECT COUNT(*) as cnt FROM nm_locations WHERE facility_id=?').get(facility.id)?.cnt || 0;
    if (locCount === 0) {
      db.prepare('INSERT INTO nm_locations (facility_id, name) VALUES (?,?)').run(facility.id, officeName || '本事業所');
    }

    if (!user) {
      let slug = officeName.toLowerCase().replace(/[^a-z0-9]/g, '') || 'welfare';
      let slugBase = slug, slugI = 1;
      while (db.prepare('SELECT id FROM users WHERE slug=?').get(slug)) slug = slugBase + slugI++;
      db.prepare(
        "INSERT INTO users (name, email, plan, ui_mode, facility_id, slug, registered_at) VALUES (?,?,?,?,?,?,datetime('now'))"
      ).run(officeName, email, 'free', 'welfare', facility.id, slug);
      user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
    } else {
      db.prepare('UPDATE users SET ui_mode=?, name=?, facility_id=? WHERE id=?').run(
        'welfare', officeName, facility.id, user.id
      );
    }

    await regenerateSession(req);
    req.session.userId = user.id;
    req.session.save((err) => {
      if (err) { console.error('[welfare-sso] session save error:', err); return res.redirect('/'); }
      const destination = (dest && typeof dest === 'string' && /^\/[^/\\]/.test(dest) && !dest.startsWith('//')) ? dest : '/record';
      console.log('[welfare-sso] login OK:', email, '->', destination);
      res.redirect(destination);
    });
  } catch(e) {
    console.error('[welfare-sso] error:', e);
    res.redirect('/');
  }
});

app.get('/record', (req, res) => res.sendFile(path.join(__dirname, 'public', 'record.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/booking/dashboard', (req, res) => {
  if (!req.session.userId) return res.redirect('/auth/google');
  const u = db.prepare('SELECT ui_mode FROM users WHERE id=?').get(req.session.userId);
  const mode = req.session.uiModeOverride || (u && u.ui_mode) || 'simple';
  if (mode === 'welfare') return res.redirect('/booking/welfare');
  res.sendFile(path.join(__dirname, 'public', 'booking', 'dashboard.html'));
});
app.get('/booking/welfare', (req, res) => {
  if (!req.session.userId) return res.redirect('/auth/google');
  res.sendFile(path.join(__dirname, 'public', 'booking', 'welfare.html'));
});
app.get('/', (req, res) => res.redirect('/bni.html'));
app.get('/booking', (req, res) => res.sendFile(path.join(__dirname, 'public', 'booking', 'index.html')));

// ── 施設サブスク API ─────────────────────────────────────────────

// 施設登録（トライアル開始）
app.post('/api/facility/register', requireAuth, async (req, res) => {
  if (Buffer.byteLength(JSON.stringify(req.body), 'utf8') > 20000)
    return res.status(400).json({ error: 'リクエストが大きすぎます（20KB以内）' });
  const { facility_name, contact_name, phone, locations } = req.body;
  const cleanFacName = safeStr(facility_name, 100);
  const cleanContact = safeStr(contact_name, 50);
  const cleanPhone = safeStr(phone, 20);
  if (!cleanFacName || !Array.isArray(locations) || !locations.length || locations.length > 50)
    return res.status(400).json({ error: '施設名と拠点名は必須です' });
  const cleanLocs = locations.map(l => safeStr(l, 100)).filter(l => l);
  if (!cleanLocs.length) return res.status(400).json({ error: '有効な拠点名を入力してください' });
  const u = db.prepare('SELECT email, facility_id FROM users WHERE id=?').get(req.session.userId);
  if (!u) return res.status(404).json({ error: 'user not found' });
  if (u.facility_id) return res.status(409).json({ error: 'already registered' });
  const fac = db.prepare(
    'INSERT INTO nm_facilities (name, admin_email, contact_name, phone) VALUES (?,?,?,?)'
  ).run(cleanFacName, u.email, cleanContact, cleanPhone);
  const facilityId = fac.lastInsertRowid;
  for (const loc of cleanLocs) {
    db.prepare('INSERT INTO nm_locations (facility_id, name) VALUES (?,?)').run(facilityId, loc);
  }
  db.prepare('INSERT INTO nm_location_count_history (facility_id, location_count, note) VALUES (?,?,?)').run(facilityId, cleanLocs.length, '初回登録');
  db.prepare('UPDATE users SET facility_id=?, ui_mode=\'welfare\' WHERE id=?').run(facilityId, req.session.userId);
  const amount = calcMonthlyAmount(cleanLocs.length, 1);
  await sendMail(process.env.GMAIL_USER || '',
    `【NiceMeet】新規施設トライアル開始: ${cleanFacName}`,
    `施設名: ${cleanFacName}\n担当者: ${cleanContact}\nメール: ${u.email}\n拠点数: ${cleanLocs.length}\n月額(先行): ¥${amount.total.toLocaleString()}\n登録日: ${new Date().toLocaleString('ja-JP')}`
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
  if (Buffer.byteLength(JSON.stringify(req.body), 'utf8') > 2000)
    return res.status(400).json({ error: 'リクエストが大きすぎます（2KB以内）' });
  const u = db.prepare('SELECT facility_id FROM users WHERE id=?').get(req.session.userId);
  if (!u?.facility_id) return res.status(400).json({ error: 'no facility' });
  const cleanLocName = safeStr(req.body.name, 100);
  if (!cleanLocName) return res.status(400).json({ error: '拠点名は必須です' });
  db.prepare('INSERT INTO nm_locations (facility_id, name) VALUES (?,?)').run(u.facility_id, cleanLocName);
  const lc = db.prepare('SELECT COUNT(*) as cnt FROM nm_locations WHERE facility_id=?').get(u.facility_id).cnt;
  db.prepare('INSERT INTO nm_location_count_history (facility_id, location_count, note) VALUES (?,?,?)').run(u.facility_id, lc, '拠点追加: ' + cleanLocName);
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
  if (Buffer.byteLength(JSON.stringify(req.body), 'utf8') > 20000)
    return res.status(400).json({ error: 'リクエストが大きすぎます（20KB以内）' });
  const u = db.prepare('SELECT email, facility_id FROM users WHERE id=?').get(req.session.userId);
  const cleanMsg = safeStr(req.body.message, 2000);
  const fac = u?.facility_id ? db.prepare('SELECT name FROM nm_facilities WHERE id=?').get(u.facility_id) : null;
  db.prepare('INSERT INTO nm_inquiries (facility_id, name, email, message) VALUES (?,?,?,?)').run(u?.facility_id || null, fac?.name || '', u?.email || '', cleanMsg);
  await sendMail(process.env.GMAIL_USER || '',
    `【NiceMeet】有料プラン申込: ${fac?.name || u?.email}`,
    `施設名: ${fac?.name || '未登録'}\nメール: ${u?.email}\nメッセージ: ${cleanMsg || '(なし)'}\n申込日時: ${new Date().toLocaleString('ja-JP')}`
  );
  res.json({ ok: true });
});

// CSV エクスポート（会議記録）
app.get('/api/facility/export/csv', requireAuth, (req, res) => {
  const u = db.prepare('SELECT facility_id FROM users WHERE id=?').get(req.session.userId);
  if (!u?.facility_id) return res.status(400).json({ error: 'no facility' });
  const rows = db.prepare('SELECT * FROM nm_meetings WHERE facility_id=? ORDER BY started_at DESC').all(u.facility_id);
  const header = '会議ID,ルームID,ホストメール,開始日時,終了日時,通話時間(分),AI要約\n';
  const csvQ = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const body = rows.map(r => [
    r.id, csvQ(r.room_id), csvQ(r.host_email),
    csvQ(r.started_at), csvQ(r.ended_at),
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
  if (system && typeof system === 'string') { sql += ' AND welfare_system=?'; params.push(system.slice(0, 20)); }
  if (member && typeof member === 'string') { sql += ' AND member_name LIKE ?'; params.push('%' + member.slice(0, 100) + '%'); }
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
  const csvQ2 = v => '"' + String(v ?? '').replace(/"/g, '""').replace(/\n/g, ' ') + '"';
  const body = rows.map(r => [
    r.id,
    csvQ2(WELFARE_RECORD_TYPES[r.welfare_system]?.label || r.welfare_system),
    csvQ2(r.record_type),
    csvQ2(r.member_name),
    csvQ2(r.staff_name),
    csvQ2(r.interview_date),
    csvQ2(r.summary_text)
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
      cb(null, `face-${Date.now()}-${crypto.randomBytes(8).toString('hex')}.webm`);
    }
  }),
  limits: { fileSize: 30 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'video/webm', 'audio/wav', 'application/octet-stream'];
    cb(null, allowed.includes(file.mimetype));
  }
});

app.post('/api/face-record/upload', requireAuth, faceRecordUpload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no audio file' });
  if (!openai) return res.status(503).json({ error: 'AI unavailable' });
  const u = db.prepare('SELECT plan, plan_expires, facility_id FROM users WHERE id=?').get(req.session.userId);
  const memberName = safeStr(req.body.memberName, 100);
  const staffName = safeStr(req.body.staffName, 100);
  const welfareSystem = safeStr(req.body.welfareSystem, 20);
  const welfareRecordType = safeStr(req.body.welfareRecordType, 50);
  const interviewDate = (req.body.interviewDate && /^\d{4}-\d{2}-\d{2}$/.test(req.body.interviewDate)) ? req.body.interviewDate : '';
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
    canUseAI = isActivePlan(u);
  }
  if (!canUseAI) {
    fs.unlink(req.file.path, () => {});
    return res.status(403).json({ error: 'AI not available for your plan' });
  }
  try {
    // Whisper transcription
    const result = await whisperClient.audio.transcriptions.create({
      file: fs.createReadStream(req.file.path),
      model: 'whisper-large-v3',
      language: 'ja',
      prompt: 'はい。',
      response_format: 'verbose_json',
    });
    fs.unlink(req.file.path, () => {});
    const segs = (result.segments || []).filter(s => s.text?.trim() && !isWhisperHallucination(s.text.trim()));
    if (!segs.length) return res.status(422).json({ error: 'no speech detected' });

    // Step1: 沈黙ギャップで粗くターン分割
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
    const rawTranscript = turns.map(t => `【話者${t.speaker}】${t.text}`).join('\n');

    // Step2: GPT-4o-miniで話者境界を再推定（要約精度向上のため）
    let transcript = rawTranscript;
    try {
      const diarRes = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0,
        messages: [
          {
            role: 'system',
            content: `あなたは日本語会話の話者分離の専門家です。以下のルールで文字起こしを【話者A】【話者B】に再ラベリングしてください。

【ルール】
- 返答・相槌（「そうですね」「なるほど」「えー」等）は直前と別話者にする
- 質問に対する回答は別話者にする
- 話題の転換や間投詞を話者切り替えのヒントにする
- 【話者A】【話者B】の2名のみ使用
- 元のテキスト内容は一切変えず、ラベルだけ変える
- 出力形式：【話者A】テキスト\n【話者B】テキスト\n... のみ`
          },
          { role: 'user', content: rawTranscript }
        ]
      });
      const diarText = diarRes.choices[0].message.content.trim();
      if (diarText.includes('【話者A】') || diarText.includes('【話者B】')) {
        transcript = diarText;
      }
    } catch(e) {
      console.warn('[face-record] diarization GPT failed, fallback to gap-based:', e.message);
    }

    if (!transcript) return res.status(422).json({ error: 'no speech detected' });
    // GPT summary with welfare prompt
    const welfarePrompt = FACE_PROMPTS[welfareSystem]?.[welfareRecordType] || WELFARE_PROMPTS[welfareSystem]?.[welfareRecordType] || null;
    const systemPrompt = welfarePrompt
      ? `${welfarePrompt}\n\n対象者: ${memberName || '（記載なし）'} / 担当: ${staffName || '（記載なし）'}`
      : '以下は対面会話の文字起こしです。日本語で業務記録文体（〜が見られた／〜が確認された）で要約してください。主要な内容・意向・特記事項を箇条書きでまとめてください。';
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: '【文字起こし本文（この内容のみを根拠に記録すること）】\n' + transcript }
      ]
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
    res.status(500).json({ error: '処理中にエラーが発生しました' });
  }
});

app.patch('/api/face-record/confirm/:id', requireAuth, express.json(), (req, res) => {
  const u = db.prepare('SELECT facility_id FROM users WHERE id=?').get(req.session.userId);
  if (!u?.facility_id) return res.status(403).json({ error: 'no facility' });
  const id = parseInt(req.params.id, 10);
  const rec = db.prepare('SELECT * FROM nm_call_records WHERE id=? AND facility_id=? AND status=?').get(id, u.facility_id, 'draft');
  if (!rec) return res.status(404).json({ error: 'draft not found' });
  const summary = safeStr(req.body.summary !== undefined ? req.body.summary : (rec.summary_text || ''), 50000);
  db.prepare("UPDATE nm_call_records SET summary_text=?, status='confirmed' WHERE id=?").run(summary, id);
  res.json({ ok: true });
});

app.delete('/api/face-record/draft/:id', requireAuth, (req, res) => {
  const u = db.prepare('SELECT facility_id FROM users WHERE id=?').get(req.session.userId);
  if (!u?.facility_id) return res.status(403).json({ error: 'no facility' });
  const id = parseInt(req.params.id, 10);
  const rec = db.prepare("SELECT * FROM nm_call_records WHERE id=? AND facility_id=? AND status='draft'").get(id, u.facility_id);
  if (!rec) return res.status(404).json({ error: 'draft not found' });
  db.prepare('DELETE FROM nm_call_records WHERE id=?').run(id);
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────
// ── 管理者用エンドポイント ────────────────────────────────────────
const ADMIN_SECRET = process.env.ADMIN_SECRET || (() => {
  const r = require('crypto').randomBytes(32).toString('hex');
  console.warn('[SECURITY] ADMIN_SECRET not set — using random value (admin API unavailable until env is set)');
  return r;
})();

function getAdminToken(req) {
  const auth = req.headers['authorization'];
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7);
  return (req.body && typeof req.body.secret === 'string') ? req.body.secret : null;
}

function checkAdminSecret(provided) {
  if (typeof provided !== 'string' || provided.length !== ADMIN_SECRET.length) return false;
  return crypto.timingSafeEqual(Buffer.from(provided, 'utf8'), Buffer.from(ADMIN_SECRET, 'utf8'));
}

app.post('/api/admin/set-mode', (req, res) => {
  if (!checkAdminSecret(getAdminToken(req))) return res.status(403).json({ error: 'forbidden' });
  const { email, mode } = req.body;
  if (!['simple', 'welfare'].includes(mode)) return res.status(400).json({ error: 'invalid mode' });
  const u = db.prepare('SELECT id FROM users WHERE email=?').get(email);
  if (!u) return res.status(404).json({ error: 'user not found' });
  db.prepare("UPDATE users SET ui_mode=? WHERE email=?").run(mode, email);
  console.log(`[admin] ui_mode=${mode} set for ${email}`);
  res.json({ ok: true, email, mode });
});

app.get('/api/admin/users', (req, res) => {
  if (!checkAdminSecret(getAdminToken(req))) return res.status(403).json({ error: 'forbidden' });
  const rows = db.prepare('SELECT id, name, email, ui_mode, facility_id FROM users ORDER BY id DESC').all();
  res.json({ records: rows });
});

app.get('/api/admin/users.csv', (req, res) => {
  if (!checkAdminSecret(getAdminToken(req))) return res.status(403).send('forbidden');
  const rows = db.prepare('SELECT id, name, email, plan, plan_expires, stripe_customer_id FROM users ORDER BY id DESC').all();
  const header = 'ID,名前,メール,プラン,プラン期限,Stripe顧客ID';
  const csv = [header, ...rows.map(r =>
    [r.id, r.name, r.email, r.plan||'free', r.plan_expires||'', r.stripe_customer_id||'']
      .map(v => '"' + String(v).replace(/"/g, '""') + '"').join(',')
  )].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename=nicemeet-users.csv');
  res.send('﻿' + csv);
});

app.get('/api/admin/drafts', (req, res) => {
  if (!checkAdminSecret(getAdminToken(req))) return res.status(403).json({ error: 'forbidden' });
  const rows = db.prepare("SELECT * FROM nm_call_records WHERE status='draft' ORDER BY created_at DESC").all();
  res.json({ records: rows });
});

app.patch('/api/admin/confirm-draft/:id', express.json(), (req, res) => {
  if (!checkAdminSecret(getAdminToken(req))) return res.status(403).json({ error: 'forbidden' });
  const id = parseInt(req.params.id, 10);
  const rec = db.prepare("SELECT * FROM nm_call_records WHERE id=? AND status='draft'").get(id);
  if (!rec) return res.status(404).json({ error: 'draft not found' });
  db.prepare("UPDATE nm_call_records SET status='confirmed' WHERE id=?").run(id);
  res.json({ ok: true });
});


// ─────────────────────────────────────────────────────────────────
// ── 施設管理 Admin API ────────────────────────────────────────────

// ── 施設プラン 公開問い合わせ ────────────────────────────────────
app.post('/api/public/facility-inquiry', apiLimiter, express.json({ limit: '10kb' }), async (req, res) => {
  const { name, email, facility_name, phone, location_count, message } = req.body;
  if (!name || !email || !facility_name) return res.status(400).json({ error: '必須項目を入力してください' });
  if (!isValidEmail(email)) return res.status(400).json({ error: '無効なメールアドレスです' });
  const lc = Math.min(Math.max(parseInt(location_count) || 1, 1), 99);
  const unit = lc === 1 ? 2980 : lc <= 3 ? 2480 : 1980;
  await sendMail(process.env.GMAIL_USER || '',
    `【NiceMeet施設プラン】お申込み: ${safeStr(facility_name, 100)}`,
    `施設名: ${safeStr(facility_name, 100)}\n担当者: ${safeStr(name, 50)}\nメール: ${email}\n電話: ${safeStr(phone||'',20)}\n拠点数: ${lc}拠点\n月額目安: ¥${(lc * unit).toLocaleString()}\nメッセージ: ${safeStr(message||'',500)}\n申込日時: ${new Date().toLocaleString('ja-JP')}`
  );
  console.log(`[facility-inquiry] ${email} ${safeStr(facility_name,100)} ${lc}拠点`);
  res.json({ ok: true });
});

app.get('/api/admin/summary', (req, res) => {
  if (!checkAdminSecret(getAdminToken(req))) return res.status(403).json({ error: 'forbidden' });
  const facs = db.prepare('SELECT * FROM nm_facilities').all();
  const counts = { trial: 0, active: 0, custom: 0, expired: 0, total: facs.length };
  for (const f of facs) {
    const s = getFacilityStatus(f);
    if (s in counts) counts[s]++; else counts.expired++;
  }
  const nmUsers = db.prepare("SELECT COUNT(*) as cnt FROM users WHERE facility_id IS NULL").get().cnt;
  res.json({ facilities: counts, nmUsers });
});

app.get('/api/admin/facilities', (req, res) => {
  if (!checkAdminSecret(getAdminToken(req))) return res.status(403).json({ error: 'forbidden' });
  const facs = db.prepare('SELECT * FROM nm_facilities ORDER BY id DESC').all();
  const result = facs.map(f => {
    const user = db.prepare('SELECT last_login_at FROM users WHERE facility_id=? ORDER BY id LIMIT 1').get(f.id);
    const lc   = db.prepare('SELECT COUNT(*) as cnt FROM nm_locations WHERE facility_id=?').get(f.id)?.cnt || 0;
    const status   = getFacilityStatus(f);
    const daysLeft = getTrialDaysLeft(f);
    const uid = db.prepare('SELECT id FROM users WHERE facility_id=? ORDER BY id LIMIT 1').get(f.id);
    return {
      id: f.id, name: f.name, admin_email: f.admin_email, contact_name: f.contact_name,
      status, daysLeft, locationCount: lc,
      usedMinThisMonth: Math.round(getMonthlyUsageMinutes(f.id)),
      admin_notes: f.admin_notes || '',
      last_login_at: user?.last_login_at || null,
      trial_started_at: f.trial_started_at,
      user_id: uid?.id || null
    };
  });
  res.json({ facilities: result });
});

app.patch('/api/admin/facility/:id', express.json({ limit: '10kb' }), (req, res) => {
  if (!checkAdminSecret(getAdminToken(req))) return res.status(403).json({ error: 'forbidden' });
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'invalid id' });
  if (!db.prepare('SELECT id FROM nm_facilities WHERE id=?').get(id)) return res.status(404).json({ error: 'not found' });
  const { status, notes } = req.body;
  if (status !== undefined) {
    if (!['trial', 'active', 'custom', 'expired'].includes(status)) return res.status(400).json({ error: 'invalid status' });
    db.prepare('UPDATE nm_facilities SET trial_status=? WHERE id=?').run(status, id);
    console.log(`[admin] facility ${id} status -> ${status}`);
  }
  if (notes !== undefined) db.prepare('UPDATE nm_facilities SET admin_notes=? WHERE id=?').run(String(notes).slice(0, 1000), id);
  res.json({ ok: true });
});

app.post('/api/admin/facility', express.json({ limit: '10kb' }), async (req, res) => {
  if (!checkAdminSecret(getAdminToken(req))) return res.status(403).json({ error: 'forbidden' });
  const { name, email, contact_name, phone, status, notes, location_name } = req.body;
  if (!name || !email) return res.status(400).json({ error: '施設名とメールは必須です' });
  if (!isValidEmail(email)) return res.status(400).json({ error: '無効なメールアドレスです' });
  const cleanName   = safeStr(name, 100);
  const cleanEmail  = email.toLowerCase().trim();
  const cleanStatus = ['trial', 'active', 'custom'].includes(status) ? status : 'trial';
  if (db.prepare('SELECT id FROM users WHERE email=?').get(cleanEmail))
    return res.status(409).json({ error: 'このメールアドレスは既に登録されています' });
  const fac = db.prepare(
    "INSERT INTO nm_facilities (name, admin_email, contact_name, phone, admin_notes, trial_status, trial_started_at) VALUES (?,?,?,?,?,?,datetime('now'))"
  ).run(cleanName, cleanEmail, safeStr(contact_name||'',50), safeStr(phone||'',20), safeStr(notes||'',1000), cleanStatus);
  const facilityId = fac.lastInsertRowid;
  const cleanLoc = safeStr(location_name || '本事業所', 100);
  db.prepare('INSERT INTO nm_locations (facility_id, name) VALUES (?,?)').run(facilityId, cleanLoc);
  db.prepare('INSERT INTO nm_location_count_history (facility_id, location_count, note) VALUES (?,?,?)').run(facilityId, 1, '管理者作成');
  const pw = crypto.randomBytes(8).toString('hex');
  const pwHash = await hashPassword(pw);
  let slug = cleanName.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20) || 'facility';
  if (db.prepare('SELECT id FROM users WHERE slug=?').get(slug)) slug = slug + facilityId;
  db.prepare(
    "INSERT INTO users (name, email, password_hash, plan, ui_mode, facility_id, slug, registered_at) VALUES (?,?,?,'free','welfare',?,?,datetime('now'))"
  ).run(cleanName, cleanEmail, pwHash, facilityId, slug);
  console.log(`[admin] created facility: ${cleanName} <${cleanEmail}> status=${cleanStatus}`);
  res.json({ ok: true, facilityId, email: cleanEmail, password: pw, message: `施設「${cleanName}」を作成しました` });
});

// 管理者ワンクリックログイン（トークン発行→セッション作成）
const adminLoginTokens = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [t, v] of adminLoginTokens) { if (v.expires < now) adminLoginTokens.delete(t); }
}, 60 * 60 * 1000);

app.get('/api/admin/login-link/:userId', async (req, res) => {
  if (!checkAdminSecret(getAdminToken(req))) return res.status(403).json({ error: 'forbidden' });
  const userId = parseInt(req.params.userId, 10);
  const user = db.prepare('SELECT id, slug, facility_id FROM users WHERE id=?').get(userId);
  if (!user || !user.facility_id) return res.status(404).json({ error: 'facility user not found' });
  const token = crypto.randomBytes(24).toString('hex');
  adminLoginTokens.set(token, { userId, expires: Date.now() + 30 * 60 * 1000 }); // 30分有効
  res.json({ url: '/auth/admin-login?t=' + token });
});

app.get('/auth/admin-login', async (req, res) => {
  const token = String(req.query.t || '').replace(/[^a-f0-9]/g, '');
  const entry = adminLoginTokens.get(token);
  if (!entry || entry.expires < Date.now()) { adminLoginTokens.delete(token); return res.redirect('/booking/'); }
  adminLoginTokens.delete(token);
  const user = db.prepare('SELECT id, slug FROM users WHERE id=?').get(entry.userId);
  if (!user) return res.redirect('/booking/');
  await regenerateSession(req);
  req.session.userId = user.id;
  req.session.slug = user.slug;
  req.session.save(err => res.redirect(err ? '/booking/' : '/booking/dashboard'));
});

app.get('/api/admin/nm-users', (req, res) => {
  if (!checkAdminSecret(getAdminToken(req))) return res.status(403).json({ error: 'forbidden' });
  const users = db.prepare(
    "SELECT id, name, email, plan, plan_expires, ui_mode, registered_at, last_login_at FROM users WHERE facility_id IS NULL ORDER BY id DESC LIMIT 300"
  ).all();
  res.json({ users });
});

app.patch('/api/admin/user/:id/plan', express.json({ limit: '2kb' }), (req, res) => {
  if (!checkAdminSecret(getAdminToken(req))) return res.status(403).json({ error: 'forbidden' });
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'invalid id' });
  const user = db.prepare('SELECT id, email FROM users WHERE id=? AND facility_id IS NULL').get(id);
  if (!user) return res.status(404).json({ error: 'not found' });
  const { plan, plan_expires } = req.body;
  if (!['free', 'trial', 'paid'].includes(plan)) return res.status(400).json({ error: 'invalid plan' });
  if (plan === 'trial') {
    const exp = plan_expires ? String(plan_expires).slice(0, 10) : null;
    if (!exp || isNaN(new Date(exp).getTime())) return res.status(400).json({ error: 'trial には plan_expires (YYYY-MM-DD) が必要です' });
    db.prepare("UPDATE users SET plan='trial', plan_expires=? WHERE id=?").run(exp + ' 00:00:00', id);
  } else {
    db.prepare('UPDATE users SET plan=?, plan_expires=NULL WHERE id=?').run(plan, id);
  }
  console.log(`[admin] user ${id} (${user.email}) plan -> ${plan}${plan_expires ? ' until ' + plan_expires : ''}`);
  res.json({ ok: true });
});

app.patch('/api/admin/user/:id/mode', express.json({ limit: '1kb' }), (req, res) => {
  if (!checkAdminSecret(getAdminToken(req))) return res.status(403).json({ error: 'forbidden' });
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'invalid id' });
  const { mode } = req.body;
  if (!['simple', 'welfare'].includes(mode)) return res.status(400).json({ error: 'invalid mode' });
  const user = db.prepare('SELECT id, email FROM users WHERE id=?').get(id);
  if (!user) return res.status(404).json({ error: 'not found' });
  db.prepare('UPDATE users SET ui_mode=? WHERE id=?').run(mode, id);
  console.log(`[admin] user ${id} (${user.email}) mode -> ${mode}`);
  res.json({ ok: true });
});

app.delete('/api/admin/user/:id', (req, res) => {
  if (!checkAdminSecret(getAdminToken(req))) return res.status(403).json({ error: 'forbidden' });
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'invalid id' });
  const user = db.prepare('SELECT id, email, facility_id FROM users WHERE id=?').get(id);
  if (!user) return res.status(404).json({ error: 'not found' });
  if (user.facility_id) return res.status(400).json({ error: '施設ユーザーは施設削除から行ってください' });
  const meetingCount = db.prepare('SELECT COUNT(*) as cnt FROM nm_meetings WHERE host_email=?').get(user.email)?.cnt || 0;
  if (meetingCount > 0 && !req.query.force) {
    return res.status(409).json({ error: `${meetingCount}件の会議記録があります`, meetingCount, requireForce: true });
  }
  db.prepare('DELETE FROM users WHERE id=?').run(id);
  console.log(`[admin] deleted user id=${id} email=${user.email}`);
  res.json({ ok: true, email: user.email });
});

// ─────────────────────────────────────────────────────────────────
// ---- Socket.io (video chat) ----
const rooms = new Map();
const breakouts = new Map();
// プロトタイプ汚染防止: Socket.IO 受信データから危険キーを除去
function sanitizeSocketData(data) {
  if (data === null || typeof data !== 'object') return data;
  if (Array.isArray(data)) return data.map(sanitizeSocketData);
  const DANGEROUS = new Set(['__proto__', 'constructor', 'prototype']);
  const out = {};
  for (const key of Object.keys(data)) {
    if (DANGEROUS.has(key)) continue;
    out[key] = sanitizeSocketData(data[key]);
  }
  return out;
}

io.on('connection', (socket) => {
  // 全イベントの引数をサニタイズ（プロトタイプ汚染対策）
  socket.use(([event, ...args], next) => {
    try {
      const sanitized = args.map(sanitizeSocketData);
      args.splice(0, args.length, ...sanitized);
    } catch (e) {
      console.warn('[socket] sanitize error:', e.message);
    }
    next();
  });
  socket.on('join-room', ({ roomId, password, userName, transcribeMode, system }) => {
    if (typeof roomId !== 'string' || roomId.length > 128 || typeof userName !== 'string') return;
    const safeRoomId = roomId.trim();
    const safeUserName = userName.trim().slice(0, 50);
    if (!safeRoomId || !safeUserName) return;
    const room = rooms.get(safeRoomId);
    // BNIモードはルームIDがUUID形式で十分安全なのでパスワードチェックをスキップ
    if (room && room.password && room.password !== password && system !== 'bni') {
      socket.emit('join-error', 'パスワードが違います'); return;
    }
    if (!room) {
      const userId = socket.request.session?.userId;
      let hostPlan = 'free';
      let hostFacilityId = null;
      let hostEmail = null;
      let hostUiMode = 'simple';
      if (userId) {
        const hu = db.prepare('SELECT plan, plan_expires, facility_id, email, ui_mode FROM users WHERE id=?').get(userId);
        hostPlan = (hu && isActivePlan(hu)) ? 'paid' : 'free';
        hostFacilityId = hu?.facility_id || null;
        hostEmail = hu?.email || null;
        hostUiMode = hu?.ui_mode || 'simple';
      }
      const newRoom = { password: password || '', users: new Map(), transcribeMode: transcribeMode || 'host_only', hostId: socket.id, coHosts: new Set(), hostPlan, startedAt: Date.now(), facilityId: hostFacilityId, hostEmail, hostUiMode, waitingRoom: false, waitingList: new Map(), screenShareAllowed: false };
      rooms.set(safeRoomId, newRoom);
      if (hostPlan === 'free') {
        newRoom.warnTimer = setTimeout(() => { io.to(safeRoomId).emit('time-warning', { minutesLeft: 5 }); }, 40 * 60 * 1000);
        newRoom.endTimer = setTimeout(() => { io.to(safeRoomId).emit('time-limit', {}); }, 45 * 60 * 1000);
      }
    }
    const cur = rooms.get(safeRoomId);
    for (const [id] of cur.users) {
      if (!io.sockets.sockets.get(id)) cur.users.delete(id);
    }
    // ホストが切断済みの場合の復帰処理
    if (!io.sockets.sockets.get(cur.hostId) || !cur.users.has(cur.hostId)) {
      // ログイン済み: 元ホストと同じアカウントの時のみ昇格
      // 匿名: 部屋がホストなしのままなら昇格（既存の挙動を維持）
      const joiningUserId = socket.request.session?.userId;
      const joiningEmail = joiningUserId
        ? db.prepare('SELECT email FROM users WHERE id=?').get(joiningUserId)?.email
        : null;
      if (!cur.hostEmail || (joiningEmail && joiningEmail === cur.hostEmail)) {
        cur.hostId = socket.id;
      }
    }
    // 待機室チェック
    if (cur.waitingRoom && cur.hostId !== socket.id) {
      if (!cur.waitingList) cur.waitingList = new Map();
      cur.waitingList.set(socket.id, { name: safeUserName });
      socket.waitingRoomId = safeRoomId;
      socket.emit('in-waiting-room', { roomId: safeRoomId });
      const targets = [cur.hostId, ...cur.coHosts].filter(Boolean);
      targets.forEach(tid => { if (io.sockets.sockets.get(tid)) io.to(tid).emit('waiting-participant', { id: socket.id, name: safeUserName }); });
      return;
    }
    cur.users.set(socket.id, { name: safeUserName });
    socket.join(safeRoomId);
    socket.roomId = safeRoomId;
    socket.mainRoomId = null;
    socket.userName = safeUserName;
    const existing = [...cur.users.entries()].filter(([id]) => id !== socket.id).map(([id, d]) => ({ id, name: d.name }));
    socket.emit('room-joined', { existingUsers: existing, transcribeMode: cur.transcribeMode, isHost: cur.hostId === socket.id, isCoHost: cur.coHosts.has(socket.id), source: 'main', isFreeRoom: cur.hostPlan === 'free', roomStartedAt: cur.startedAt || Date.now(), hostUiMode: cur.hostUiMode || 'simple', screenShareAllowed: cur.screenShareAllowed || false });
    socket.to(safeRoomId).emit('user-joined', { id: socket.id, name: safeUserName });
  });
  function isPeerInRoom(to) {
    if (typeof to !== 'string' || to.length === 0 || to.length > 64) return false;
    const room = rooms.get(socket.roomId);
    return room ? room.users.has(to) : false;
  }
  socket.on('offer', ({ to, offer }) => { if (isPeerInRoom(to)) io.to(to).emit('offer', { from: socket.id, fromName: socket.userName, offer }); });
  socket.on('answer', ({ to, answer }) => { if (isPeerInRoom(to)) io.to(to).emit('answer', { from: socket.id, answer }); });
  socket.on('ice-candidate', ({ to, candidate }) => { if (isPeerInRoom(to)) io.to(to).emit('ice-candidate', { from: socket.id, candidate }); });
  socket.on('screen-share-start', () => { socket.to(socket.roomId).emit('screen-share-start', { id: socket.id, name: socket.userName }); });
  socket.on('screen-share-stop', () => { socket.to(socket.roomId).emit('screen-share-stop', { id: socket.id }); });
  socket.on('chat-message', ({ message }) => {
    if (!socket.roomId || typeof message !== 'string' || message.length === 0 || message.length > 2000) return;
    console.log('[chat] from=' + socket.userName + ' room=' + socket.roomId + ' len=' + message.length);
    socket.to(socket.roomId).emit('chat-message', { from: socket.userName, message, time: new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }) });
  });
  socket.on('set-waiting-room', ({ enabled }) => {
    if (typeof enabled !== 'boolean') return;
    const room = rooms.get(socket.roomId);
    if (!room || room.hostId !== socket.id) return;
    room.waitingRoom = enabled;
    socket.emit('waiting-room-changed', { enabled });
  });

  socket.on('admit-participant', ({ participantId }) => {
    if (typeof participantId !== 'string' || participantId.length > 64) return;
    const room = rooms.get(socket.roomId);
    if (!room || (room.hostId !== socket.id && !room.coHosts.has(socket.id))) return;
    if (!room.waitingList || !room.waitingList.has(participantId)) return;
    const waiting = room.waitingList.get(participantId);
    const pSocket = io.sockets.sockets.get(participantId);
    room.waitingList.delete(participantId);
    if (!pSocket) return;
    const safeRoomId = socket.roomId;
    room.users.set(participantId, { name: waiting.name });
    pSocket.join(safeRoomId);
    pSocket.roomId = safeRoomId;
    pSocket.mainRoomId = null;
    pSocket.userName = waiting.name;
    delete pSocket.waitingRoomId;
    const existing = [...room.users.entries()].filter(([id]) => id !== participantId).map(([id, d]) => ({ id, name: d.name }));
    pSocket.emit('admitted', { existingUsers: existing, transcribeMode: room.transcribeMode, isHost: false, isCoHost: room.coHosts.has(participantId), isFreeRoom: room.hostPlan === 'free', roomStartedAt: room.startedAt || Date.now(), hostUiMode: room.hostUiMode || 'simple', screenShareAllowed: room.screenShareAllowed || false });
    pSocket.to(safeRoomId).emit('user-joined', { id: participantId, name: waiting.name });
    socket.emit('participant-admitted', { id: participantId });
  });

  socket.on('reject-participant', ({ participantId }) => {
    if (typeof participantId !== 'string' || participantId.length > 64) return;
    const room = rooms.get(socket.roomId);
    if (!room || (room.hostId !== socket.id && !room.coHosts.has(socket.id))) return;
    if (!room.waitingList || !room.waitingList.has(participantId)) return;
    room.waitingList.delete(participantId);
    io.to(participantId).emit('rejected');
    socket.emit('participant-rejected', { id: participantId });
  });

  socket.on('set-screen-share-permission', ({ enabled }) => {
    if (typeof enabled !== 'boolean') return;
    const room = rooms.get(socket.roomId);
    if (!room || (room.hostId !== socket.id && !room.coHosts.has(socket.id))) return;
    room.screenShareAllowed = enabled;
    io.to(socket.roomId).emit('screen-share-permission-changed', { enabled });
  });

  socket.on('disconnect', () => {
    if (socket.waitingRoomId) {
      const wr = rooms.get(socket.waitingRoomId);
      if (wr && wr.waitingList) {
        wr.waitingList.delete(socket.id);
        [wr.hostId, ...wr.coHosts].filter(Boolean).forEach(tid => {
          if (io.sockets.sockets.get(tid)) io.to(tid).emit('waiting-participant-left', { id: socket.id });
        });
      }
      return;
    }
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
        if (room.waitingList && room.waitingList.size > 0) {
          room.waitingList.forEach((_, wid) => io.to(wid).emit('rejected'));
        }
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
    if (typeof newRoomId !== 'string' || newRoomId.length === 0 || newRoomId.length > 128) return;
    if (mainRoomId !== null && mainRoomId !== undefined && (typeof mainRoomId !== 'string' || mainRoomId.length > 128)) return;
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
  socket.on('set-transcribe-mode', ({ mode }) => {
    const roomId = socket.roomId;
    const room = rooms.get(roomId);
    if (!room || room.hostId !== socket.id) return;
    if (!['all', 'host_only', 'none'].includes(mode)) return;
    room.transcribeMode = mode;
    io.to(roomId).emit('transcribe-mode-changed', { mode });
  });

  socket.on('grant-cohost', ({ targetId }) => {
    if (typeof targetId !== 'string' || targetId.length > 64) return;
    const mainId = socket.mainRoomId || socket.roomId;
    const room = rooms.get(mainId);
    if (!room || room.hostId !== socket.id) return;
    if (!room.users.has(targetId)) return;
    room.coHosts.add(targetId);
    io.to(targetId).emit('cohost-granted', { by: socket.userName });
    io.to(mainId).emit('cohost-list', { coHosts: [...room.coHosts], hostId: room.hostId });
  });
  socket.on('revoke-cohost', ({ targetId }) => {
    if (typeof targetId !== 'string' || targetId.length > 64) return;
    const mainId = socket.mainRoomId || socket.roomId;
    const room = rooms.get(mainId);
    if (!room || room.hostId !== socket.id) return;
    room.coHosts.delete(targetId);
    io.to(targetId).emit('cohost-revoked', {});
    io.to(mainId).emit('cohost-list', { coHosts: [...room.coHosts], hostId: room.hostId });
  });

  // ---- ブレイクアウトルーム ----
  socket.on('breakout:setup', ({ numRooms, timerSeconds }) => {
    if (typeof numRooms !== 'number' || !Number.isInteger(numRooms) || numRooms < 2 || numRooms > 50) return;
    const safeTimer = (typeof timerSeconds === 'number' && Number.isFinite(timerSeconds) && timerSeconds >= 0 && timerSeconds <= 3600) ? Math.floor(timerSeconds) : 0;
    const mainId = socket.mainRoomId || socket.roomId;
    const room = rooms.get(mainId);
    if (!room || (room.hostId !== socket.id && !room.coHosts.has(socket.id))) return;
    if (breakouts.has(mainId) && breakouts.get(mainId).active) return;
    breakouts.set(mainId, {
      numRooms, timerSeconds: safeTimer, timerEnd: null, active: false, timerTimeout: null,
      rooms: Array.from({length:numRooms}, (_,i) => ({id:i+1, name:'部屋 '+(i+1), participants:[]})),
      assignments: new Map()
    });
    const pList = [...room.users.entries()].map(([id,d]) => ({id, name:d.name}));
    socket.emit('breakout:ready', {
      rooms: Array.from({length:numRooms}, (_,i) => ({id:i+1, name:'部屋 '+(i+1), participants:[]})),
      participants: pList, numRooms, timerSeconds: safeTimer
    });
  });

  socket.on('breakout:assign', ({ targetId, roomNum }) => {
    if (typeof targetId !== 'string' || targetId.length > 64) return;
    if (typeof roomNum !== 'number' || !Number.isInteger(roomNum)) return;
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
    if (typeof message !== 'string' || message.length === 0 || message.length > 500) return;
    const mainId = socket.mainRoomId || socket.roomId;
    const bs = breakouts.get(mainId);
    const room = rooms.get(mainId);
    if (!bs || !room || (room.hostId !== socket.id && !room.coHosts.has(socket.id))) return;
    const t = new Date().toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit'});
    io.to(mainId).emit('breakout:broadcast-msg',{from:socket.userName,message,time:t});
    bs.rooms.forEach((_,i) => io.to(mainId+'__br__'+(i+1)).emit('breakout:broadcast-msg',{from:socket.userName,message,time:t}));
  });

});


// グローバルエラーハンドラー（スタックトレース漏洩防止）
app.use((err, req, res, next) => {
  console.error('[500]', req.method, req.path, err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'サーバーエラーが発生しました' });
});

server.listen(3100, () => console.log('Meet+Booking server on port 3100'));
