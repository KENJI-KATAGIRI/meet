'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const { execSync, spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

// ── 設定 ──────────────────────────────────────────────
const ADMIN_EMAIL  = process.env.ADMIN_EMAIL || process.env.GMAIL_USER;
const GMAIL_USER   = process.env.GMAIL_USER;
const GMAIL_PASS   = process.env.GMAIL_PASS;
const SUDO_PASS    = process.env.SUDO_PASS || 'makana-1127';
const SERVICE      = 'meet';
const APP_DIR      = __dirname;
const REC_DIR      = path.join(APP_DIR, 'recordings');
const DB_PATH      = path.join(APP_DIR, 'data', 'booking.db');

const THRESHOLDS = {
  recDirWarnMB:     3000,   // 警告
  recDirMaxMB:      5000,   // 緊急クリーンアップ
  dbWarnMB:          300,
  dbMaxMB:           500,
  diskWarnPct:        80,
  diskCriticalPct:    90,
  authFailBan:        20,   // この回数失敗したらBAN
  authFailWindowMin:  15,   // スライディングウィンドウ（分）
  maxRestarts:         3,   // この回数を超えたら緊急アラート
  restartWindowMin:   30,
};

// ── 状態 ─────────────────────────────────────────────
const state = {
  bannedIps:    new Map(),  // ip -> { bannedAt, reason }
  authFailures: new Map(),  // ip -> [timestamp, ...]
  restarts:     [],         // [timestamp, ...]
  events:       [],         // { time, level, msg }
  storageAlerted: new Set(),
};

// ── ログ ─────────────────────────────────────────────
function log(level, msg) {
  const entry = { time: new Date().toISOString(), level, msg };
  state.events.push(entry);
  if (state.events.length > 2000) state.events.shift();
  const label = { INFO: '\x1b[32mINFO\x1b[0m', WARN: '\x1b[33mWARN\x1b[0m', ERROR: '\x1b[31mERROR\x1b[0m' }[level] || level;
  console.log(`[${label}] ${entry.time} ${msg}`);
}

// ── メール ────────────────────────────────────────────
const mailer = (GMAIL_USER && GMAIL_PASS)
  ? nodemailer.createTransport({ service: 'gmail', auth: { user: GMAIL_USER, pass: GMAIL_PASS } })
  : null;

async function sendAlert(subject, text) {
  if (!mailer || !ADMIN_EMAIL) { log('WARN', `メール未設定 アラート: ${subject}`); return; }
  try {
    await mailer.sendMail({ from: `"NiceMeet Monitor" <${GMAIL_USER}>`, to: ADMIN_EMAIL, subject, text });
    log('INFO', `アラート送信: ${subject}`);
  } catch(e) { log('ERROR', `メール送信エラー: ${e.message}`); }
}

// ── sudo ─────────────────────────────────────────────
function sudoRun(cmd) {
  return execSync(`echo ${SUDO_PASS} | sudo -S ${cmd} 2>/dev/null`, { timeout: 10000 }).toString().trim();
}

// ═══════════════════════════════════════════════════════
// 1. サービス死活監視 + 自動再起動
// ═══════════════════════════════════════════════════════
function checkService() {
  let status;
  try {
    status = execSync(`systemctl is-active ${SERVICE} 2>/dev/null`).toString().trim();
  } catch(e) {
    status = e.stdout?.toString().trim() || 'unknown';
  }

  if (status === 'active') return;

  log('WARN', `${SERVICE} が停止しています (${status})。自動再起動を試みます`);
  const now = Date.now();
  state.restarts.push(now);
  state.restarts = state.restarts.filter(t => now - t < THRESHOLDS.restartWindowMin * 60 * 1000);

  try {
    sudoRun(`systemctl restart ${SERVICE}`);
    log('INFO', `${SERVICE} を再起動しました`);
    sendAlert(
      `[NiceMeet Monitor] サービス自動再起動`,
      `${SERVICE} が停止していたため自動再起動しました。\n時刻: ${new Date().toLocaleString('ja-JP')}\n` +
      `直近${THRESHOLDS.restartWindowMin}分の再起動回数: ${state.restarts.length}回`
    );
  } catch(err) {
    log('ERROR', `再起動失敗: ${err.message}`);
    sendAlert(
      `[NiceMeet Monitor] 🚨 再起動失敗 手動確認が必要です`,
      `${SERVICE} の再起動に失敗しました。\nエラー: ${err.message}\n時刻: ${new Date().toLocaleString('ja-JP')}`
    );
    return;
  }

  if (state.restarts.length >= THRESHOLDS.maxRestarts) {
    sendAlert(
      `[NiceMeet Monitor] 🚨 連続再起動アラート`,
      `${THRESHOLDS.restartWindowMin}分以内に ${state.restarts.length} 回再起動しました。\nサーバの状態を確認してください。`
    );
  }
}

// ═══════════════════════════════════════════════════════
// 2. ストレージ監視
// ═══════════════════════════════════════════════════════
function getDirSizeMB(dir) {
  try { return parseInt(execSync(`du -sm ${dir} 2>/dev/null`).toString().split('\t')[0], 10) || 0; }
  catch(e) { return 0; }
}
function getFileSizeMB(fp) {
  try { return Math.round(fs.statSync(fp).size / 1024 / 1024); } catch(e) { return 0; }
}
function getDiskUsagePct() {
  try {
    const out = execSync(`df -h ${APP_DIR} 2>/dev/null | tail -1`).toString();
    const m = out.match(/(\d+)%/);
    return m ? parseInt(m[1], 10) : 0;
  } catch(e) { return 0; }
}

function cleanOldRecordings(ageHours) {
  try {
    const cutoff = Date.now() - ageHours * 3600 * 1000;
    let count = 0;
    for (const f of fs.readdirSync(REC_DIR)) {
      const fp = path.join(REC_DIR, f);
      try { if (fs.statSync(fp).mtimeMs < cutoff) { fs.unlinkSync(fp); count++; } } catch(e) {}
    }
    log('INFO', `緊急クリーンアップ: ${count}ファイル削除`);
    return count;
  } catch(e) { log('ERROR', `クリーンアップエラー: ${e.message}`); return 0; }
}

async function checkStorage() {
  const recMB   = getDirSizeMB(REC_DIR);
  const dbMB    = getFileSizeMB(DB_PATH);
  const diskPct = getDiskUsagePct();

  // ディスク全体
  if (diskPct >= THRESHOLDS.diskCriticalPct && !state.storageAlerted.has(`disk-critical-${Math.floor(diskPct/5)}`)) {
    state.storageAlerted.add(`disk-critical-${Math.floor(diskPct/5)}`);
    log('ERROR', `ディスク危機: ${diskPct}%`);
    await sendAlert(
      `[NiceMeet Monitor] 🚨 ディスク残量危機: ${diskPct}%`,
      `ディスク使用率が ${diskPct}% に達しました。緊急対応が必要です。\n録画: ${recMB}MB / DB: ${dbMB}MB`
    );
  } else if (diskPct >= THRESHOLDS.diskWarnPct && !state.storageAlerted.has(`disk-warn`)) {
    state.storageAlerted.add('disk-warn');
    log('WARN', `ディスク警告: ${diskPct}%`);
    await sendAlert(
      `[NiceMeet Monitor] ⚠️ ディスク残量警告: ${diskPct}%`,
      `ディスク使用率が ${diskPct}% です。\n録画: ${recMB}MB / DB: ${dbMB}MB`
    );
  } else if (diskPct < THRESHOLDS.diskWarnPct) {
    state.storageAlerted.delete('disk-warn');
  }

  // 録画ディレクトリ
  if (recMB >= THRESHOLDS.recDirMaxMB) {
    log('WARN', `録画ディレクトリ緊急: ${recMB}MB → 6時間以上経過ファイルを削除`);
    const deleted = cleanOldRecordings(6);
    await sendAlert(
      `[NiceMeet Monitor] 録画ディレクトリ緊急クリーンアップ`,
      `録画が ${recMB}MB に達したため 6時間以上経過ファイルを ${deleted} 件削除しました。`
    );
  } else if (recMB >= THRESHOLDS.recDirWarnMB) {
    log('WARN', `録画ディレクトリ警告: ${recMB}MB`);
  }

  // DB
  if (dbMB >= THRESHOLDS.dbMaxMB && !state.storageAlerted.has('db-max')) {
    state.storageAlerted.add('db-max');
    log('ERROR', `DB危機: ${dbMB}MB`);
    await sendAlert(
      `[NiceMeet Monitor] 🚨 DBサイズ警告: ${dbMB}MB`,
      `booking.db が ${dbMB}MB に達しました。古いレコードの整理をご検討ください。`
    );
  } else if (dbMB >= THRESHOLDS.dbWarnMB && !state.storageAlerted.has('db-warn')) {
    state.storageAlerted.add('db-warn');
    log('WARN', `DB警告: ${dbMB}MB`);
  }
}

// ═══════════════════════════════════════════════════════
// 3. 不正アクセス検知 + 自動IP BAN
// ═══════════════════════════════════════════════════════
function isValidIp(ip) {
  if (!ip) return false;
  // IPv4 or IPv6、ローカルIPは除外
  if (/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fe80:)/.test(ip)) return false;
  return /^[\d.]+$/.test(ip) || /^[0-9a-f:]+$/i.test(ip);
}

function recordAuthFailure(ip) {
  if (!isValidIp(ip)) return;
  const now = Date.now();
  const windowMs = THRESHOLDS.authFailWindowMin * 60 * 1000;
  const times = (state.authFailures.get(ip) || []).filter(t => now - t < windowMs);
  times.push(now);
  state.authFailures.set(ip, times);

  if (times.length >= THRESHOLDS.authFailBan && !state.bannedIps.has(ip)) {
    banIp(ip, `${times.length}回認証失敗 / ${THRESHOLDS.authFailWindowMin}分以内`);
  }
}

function banIp(ip, reason) {
  if (!isValidIp(ip)) return;
  try {
    sudoRun(`ufw deny from ${ip} to any`);
    state.bannedIps.set(ip, { bannedAt: Date.now(), reason });
    log('WARN', `IP BAN: ${ip} (${reason})`);
    sendAlert(
      `[NiceMeet Monitor] IP自動BAN: ${ip}`,
      `BAN理由: ${reason}\nBAN時刻: ${new Date().toLocaleString('ja-JP')}\n\n手動解除: sudo ufw delete deny from ${ip} to any`
    );
  } catch(e) { log('ERROR', `BAN失敗 ${ip}: ${e.message}`); }
}

function unbanExpiredIps() {
  const BAN_TTL = 24 * 60 * 60 * 1000;
  const now = Date.now();
  for (const [ip, info] of state.bannedIps) {
    if (now - info.bannedAt > BAN_TTL) {
      try {
        sudoRun(`ufw delete deny from ${ip} to any`);
        state.bannedIps.delete(ip);
        log('INFO', `IP BAN解除: ${ip} (24時間経過)`);
      } catch(e) { log('ERROR', `BAN解除失敗 ${ip}: ${e.message}`); }
    }
  }
}

// ── ログ監視（journalctl tail） ──────────────────────
function startLogWatcher() {
  const child = spawn('journalctl', ['-u', SERVICE, '-f', '--no-pager', '-o', 'cat']);
  child.stdout.on('data', (data) => {
    for (const line of data.toString().split('\n')) {
      const m1 = line.match(/\[auth-fail\] ip=([\da-fA-F:.]+)/);
      if (m1) recordAuthFailure(m1[1]);
      const m2 = line.match(/\[bni-auth-fail\] ip=([\da-fA-F:.]+)/);
      if (m2) recordAuthFailure(m2[1]);
    }
  });
  child.on('exit', (code) => {
    log('WARN', `journalctl watcher 終了 (${code})、5秒後に再起動`);
    setTimeout(startLogWatcher, 5000);
  });
}

// ═══════════════════════════════════════════════════════
// 4. 日次レポート
// ═══════════════════════════════════════════════════════
async function sendDailyReport() {
  const recMB   = getDirSizeMB(REC_DIR);
  const dbMB    = getFileSizeMB(DB_PATH);
  const diskPct = getDiskUsagePct();

  let serviceStatus = 'unknown';
  try { serviceStatus = execSync(`systemctl is-active ${SERVICE} 2>/dev/null`).toString().trim(); } catch(e) {}

  const since24h = Date.now() - 86400 * 1000;
  const recentErrors = state.events.filter(e => e.level === 'ERROR' && new Date(e.time).getTime() > since24h);
  const recentWarns  = state.events.filter(e => e.level === 'WARN'  && new Date(e.time).getTime() > since24h);
  const recentRestarts = state.restarts.filter(t => t > since24h).length;

  const bannedList = Array.from(state.bannedIps.entries())
    .map(([ip, i]) => `  • ${ip} — ${i.reason}`)
    .join('\n') || '  なし';

  const errorList = recentErrors.slice(-5)
    .map(e => `  [${e.time.slice(11,19)}] ${e.msg}`)
    .join('\n') || '  なし';

  const report = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━
NiceMeet 日次レポート
${new Date().toLocaleString('ja-JP')}
━━━━━━━━━━━━━━━━━━━━━━━━━━━

【サービス状態】
  ${SERVICE}.service : ${serviceStatus}
  直近24hの自動再起動  : ${recentRestarts} 回

【ストレージ】
  ディスク使用率  : ${diskPct}%
  録画ディレクトリ : ${recMB} MB
  booking.db      : ${dbMB} MB

【セキュリティ】
  BAN中のIP (${state.bannedIps.size}件):
${bannedList}

【直近24hのイベント】
  ERROR : ${recentErrors.length}件
  WARN  : ${recentWarns.length}件
  最近のエラー:
${errorList}
━━━━━━━━━━━━━━━━━━━━━━━━━━━
`.trim();

  await sendAlert(`[NiceMeet Monitor] 日次レポート ${new Date().toLocaleDateString('ja-JP')}`, report);
}

// ═══════════════════════════════════════════════════════
// メインループ
// ═══════════════════════════════════════════════════════
log('INFO', 'NiceMeet Monitor 起動');

if (!ADMIN_EMAIL) log('WARN', 'ADMIN_EMAIL が未設定です。.env に ADMIN_EMAIL=your@email を追加してください');

startLogWatcher();

setInterval(checkService, 2 * 60 * 1000);       // 2分ごとに死活確認
setInterval(checkStorage, 10 * 60 * 1000);       // 10分ごとにストレージ確認
setInterval(unbanExpiredIps, 60 * 60 * 1000);    // 1時間ごとにBAN期限確認
setInterval(sendDailyReport, 24 * 60 * 60 * 1000); // 24時間ごとにレポート

// 起動直後に一度チェック（設定確認も兼ねる）
checkService();
checkStorage();
setTimeout(sendDailyReport, 60 * 1000); // 1分後に初回レポート送信
