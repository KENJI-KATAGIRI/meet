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
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: 'auto', httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

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
  const u = db.prepare('SELECT id, name, email, slug, slot_duration FROM users WHERE id=?').get(req.session.userId);
  res.json(u);
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
  try {
    const chunkFiles = fs.readdirSync(recDir)
      .filter(f => f.startsWith(`audio-${sessionId}-`) && /\.(webm|mp4|ogg|m4a)$/.test(f) && !f.includes('-final'))
      .sort();
    console.log(`[audio-finalize] chunks found: ${chunkFiles.length}`);
    if (chunkFiles.length === 0) {
      await sendMail(email, '【NiceMeet】会議終了（音声データなし）', '会議が終了しましたが、音声データが検出されませんでした。\n無音や短時間の場合は録音されないことがあります。');
      return;
    }
    const chunkExt = require('path').extname(chunkFiles[0]) || '.webm';
    const combined = Buffer.concat(chunkFiles.map(f => fs.readFileSync(path.join(recDir, f))));
    const finalPath = path.join(recDir, `audio-${sessionId}-final${chunkExt}`);
    fs.writeFileSync(finalPath, combined);
    console.log(`[audio-finalize] final: ${require('path').basename(finalPath)} (${combined.length} bytes)`);

    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(finalPath),
      model: 'whisper-1',
      language: 'ja',
    });
    const transcript = transcription.text?.trim();

    chunkFiles.forEach(f => fs.unlink(path.join(recDir, f), () => {}));
    fs.unlink(finalPath, () => {});

    if (!transcript) {
      await sendMail(email, '【NiceMeet】会議の文字起こし', '音声が検出されませんでした。');
      return;
    }

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: '以下の会議の文字起こしを日本語で要約してください。箇条書きで主要な議題、決定事項、アクションアイテムをまとめてください。' },
        { role: 'user', content: transcript }
      ]
    });
    const summary = completion.choices[0].message.content;

    await sendMail(email, '【NiceMeet】会議の文字起こし・要約',
`━━━━━━━━━━━━━━━━━━
【AI要約】
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
app.get('/booking/dashboard', (req, res) => {
  if (!req.session.userId) return res.redirect('/auth/google');
  res.sendFile(path.join(__dirname, 'public', 'booking', 'dashboard.html'));
});
app.get('/booking', (req, res) => res.sendFile(path.join(__dirname, 'public', 'booking', 'index.html')));

// ---- Socket.io (video chat) ----
const rooms = new Map();
const breakouts = new Map();
io.on('connection', (socket) => {
  socket.on('join-room', ({ roomId, password, userName, transcribeMode }) => {
    const room = rooms.get(roomId);
    if (room && room.password && room.password !== password) {
      socket.emit('join-error', 'パスワードが違います'); return;
    }
    if (!room) rooms.set(roomId, { password: password || '', users: new Map(), transcribeMode: transcribeMode || 'host_only', hostId: socket.id, coHosts: new Set() });
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
    socket.emit('room-joined', { existingUsers: existing, transcribeMode: cur.transcribeMode, isHost: cur.hostId === socket.id, isCoHost: cur.coHosts.has(socket.id), source: 'main' });
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
      if (room.users.size === 0) rooms.delete(curRoomId);
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
