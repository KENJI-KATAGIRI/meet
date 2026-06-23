#!/usr/bin/env node
// finalize ジョブキューの状態確認ツール
//   node queue-status.js          … 件数サマリ + 失敗ジョブ一覧
//   node queue-status.js --retry  … 失敗ジョブを pending に戻して再試行
const q = require('./lib/queue');

const stats = q.stats();
console.log('=== finalize_jobs 件数 ===');
if (stats.length === 0) console.log('  (ジョブなし)');
else stats.forEach(s => console.log(`  ${s.status}: ${s.n}`));

const failed = q.listFailed();
console.log(`\n=== 失敗ジョブ (${failed.length}件) ===`);
if (failed.length === 0) {
  console.log('  なし');
} else {
  failed.forEach(f => {
    console.log(`  [id=${f.id}] session=${f.session_id} attempts=${f.attempts} updated=${f.updated}`);
    console.log(`     last_error: ${f.last_error}`);
  });
}

if (process.argv.includes('--retry') && failed.length > 0) {
  const now = Date.now();
  const info = q._db.prepare(
    "UPDATE finalize_jobs SET status='pending', attempts=0, locked_at=NULL, updated_at=? WHERE status='failed'"
  ).run(now);
  console.log(`\n${info.changes}件を pending に戻しました（ワーカーが順次再試行します）。`);
}
