// NiceMeet finalize ワーカー（シグナリングとは別プロセス）
// jobs.db をポーリングし、文字起こし→要約→webhook/DB保存を実行する。
// 落ちても未処理ジョブは jobs.db に残り、再起動後に再開される。
require('dotenv').config({ override: true });
const path = require('path');
const Database = require('better-sqlite3');
const OpenAI = require('openai');
const nodemailer = require('nodemailer');

const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
const groqWhisper = process.env.GROQ_API_KEY ? new OpenAI({ apiKey: process.env.GROQ_API_KEY, baseURL: 'https://api.groq.com/openai/v1' }) : null;
const whisperClient = groqWhisper || openai;

// booking.db は Web プロセスと共有するため WAL + busy_timeout 必須
const db = new Database(path.join(__dirname, 'data', 'booking.db'));
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

const bniDb = (() => {
  try { return new Database('/home/ubuntu/apps/bni-app/data/bni.db', { readonly: true, timeout: 2000 }); }
  catch (e) { console.warn('[bniDb] could not open BNI Manager DB:', e.message); return null; }
})();

const recDir = path.join(__dirname, 'recordings');

const mailer = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASS }
});
async function sendMail(to, subject, text) {
  try {
    await mailer.sendMail({ from: `"NiceMeet" <${process.env.GMAIL_USER}>`, to, subject, text });
  } catch (e) { console.error('mail error:', e.message); }
}

const createFinalizer = require('./lib/finalize');
const { processFinalizeJob } = createFinalizer({ db, bniDb, openai, whisperClient, recDir, sendMail });
const queue = require('./lib/queue');

const POLL_MS = 3000;
const STALE_MS = 15 * 60 * 1000;
let running = true;
let active = false;

async function tick() {
  queue.reapStale(STALE_MS);
  const job = queue.claimNext(STALE_MS);
  if (!job) return;
  active = true;
  console.log(`[worker] start job id=${job.id} session=${job.session_id} attempt=${job.attempts}`);
  try {
    const payload = JSON.parse(job.payload);
    await processFinalizeJob(payload);
    queue.completeJob(job.id);
    console.log(`[worker] done  job id=${job.id} session=${job.session_id}`);
  } catch (e) {
    const st = queue.failJob(job.id, e.message);
    console.error(`[worker] FAIL  job id=${job.id} session=${job.session_id} -> ${st}:`, e.message);
  } finally {
    active = false;
  }
}

async function loop() {
  while (running) {
    try { await tick(); }
    catch (e) { console.error('[worker] tick error:', e.message); }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
  console.log('[worker] stopped');
  process.exit(0);
}

function shutdown() {
  console.log('[worker] shutdown requested, finishing current job...');
  running = false;
  // 処理中でなければ即終了、処理中なら loop が抜けるのを待つ
  if (!active) process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

console.log(`[worker] started. polling ${POLL_MS}ms, stale=${STALE_MS}ms. stats:`, queue.stats());
loop();
