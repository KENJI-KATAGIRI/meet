// NiceMeet finalize ジョブの永続キュー（SQLite / better-sqlite3）
// server.js(Webプロセス)が enqueue し、worker.js(別プロセス)が claim/処理する。
// WAL + busy_timeout で2プロセスからの同時アクセスを安全化する。
const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '..', 'data', 'jobs.db');
const qdb = new Database(dbPath);
qdb.pragma('journal_mode = WAL');
qdb.pragma('busy_timeout = 5000');

qdb.exec(`
CREATE TABLE IF NOT EXISTS finalize_jobs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   TEXT UNIQUE NOT NULL,
  payload      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  locked_at    INTEGER,
  last_error   TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
`);

// 二重enqueue防止: session_id UNIQUE + INSERT OR IGNORE
function enqueueFinalize(payload) {
  const now = Date.now();
  const info = qdb.prepare(
    `INSERT OR IGNORE INTO finalize_jobs (session_id, payload, status, created_at, updated_at)
     VALUES (?, ?, 'pending', ?, ?)`
  ).run(payload.sessionId, JSON.stringify(payload), now, now);
  return info.changes > 0; // false = 既に同一sessionのジョブあり
}

// 1件を原子的に奪取（pending、または上限未満でstaleなprocessing=クラッシュ再開）
function claimNext(staleMs = 15 * 60 * 1000) {
  const now = Date.now();
  const staleBefore = now - staleMs;
  const row = qdb.prepare(
    `SELECT * FROM finalize_jobs
      WHERE (status='pending' OR (status='processing' AND locked_at < ?))
        AND attempts < max_attempts
      ORDER BY id LIMIT 1`
  ).get(staleBefore);
  if (!row) return null;
  const upd = qdb.prepare(
    `UPDATE finalize_jobs SET status='processing', locked_at=?, attempts=attempts+1, updated_at=?
      WHERE id=? AND (status='pending' OR (status='processing' AND locked_at < ?))`
  ).run(now, now, row.id, staleBefore);
  if (upd.changes === 0) return null; // 競合で他ワーカーが先に取得
  return qdb.prepare(`SELECT * FROM finalize_jobs WHERE id=?`).get(row.id);
}

function completeJob(id) {
  qdb.prepare(`UPDATE finalize_jobs SET status='done', locked_at=NULL, last_error=NULL, updated_at=? WHERE id=?`)
     .run(Date.now(), id);
}

// 失敗時: 上限未満なら pending に戻して再試行、上限到達で failed
function failJob(id, errMsg) {
  const job = qdb.prepare(`SELECT attempts, max_attempts FROM finalize_jobs WHERE id=?`).get(id);
  const status = (job && job.attempts >= job.max_attempts) ? 'failed' : 'pending';
  qdb.prepare(`UPDATE finalize_jobs SET status=?, locked_at=NULL, last_error=?, updated_at=? WHERE id=?`)
     .run(status, String(errMsg || '').slice(0, 500), Date.now(), id);
  return status;
}

// クラッシュで放置され、かつ上限到達済みの processing を failed に確定させる
function reapStale(staleMs = 15 * 60 * 1000) {
  const staleBefore = Date.now() - staleMs;
  qdb.prepare(
    `UPDATE finalize_jobs SET status='failed', locked_at=NULL,
        last_error=COALESCE(last_error,'max attempts exceeded (stale)'), updated_at=?
      WHERE status='processing' AND locked_at < ? AND attempts >= max_attempts`
  ).run(Date.now(), staleBefore);
}

function listFailed() {
  return qdb.prepare(
    `SELECT id, session_id, attempts, last_error, datetime(updated_at/1000,'unixepoch','localtime') AS updated
       FROM finalize_jobs WHERE status='failed' ORDER BY id`
  ).all();
}

function stats() {
  return qdb.prepare(`SELECT status, COUNT(*) AS n FROM finalize_jobs GROUP BY status`).all();
}

module.exports = { enqueueFinalize, claimNext, completeJob, failJob, reapStale, listFailed, stats, _db: qdb };
