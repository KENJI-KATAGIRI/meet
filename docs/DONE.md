# NiceMeet 完了済み機能（再実装・破壊禁止）

## audio-finalize ジョブキュー化（2026-06-24）
- [x] finalizeの重い処理(文字起こし/要約/webhook)を別プロセスワーカーに分離
- [x] 永続ジョブキュー `lib/queue.js`（SQLite/WAL、session_id UNIQUEで冪等、max_attempts=3）
- [x] finalize処理本体を `lib/finalize.js`（ファクトリ`createFinalizer(ctx)`）に移設＝挙動不変
  - server.js / worker.js 双方が require（プロンプト・isWhisperHallucination共有でDRY）
- [x] `worker.js`（systemd `meet-worker.service`、Restart=always）でjobs.dbをポーリング処理
- [x] server.js の finalize はenqueueのみにスリム化（res.json即返し・検証/権限チェックは維持）
- [x] booking.db を WAL化＋busy_timeout（server/worker両接続）で2プロセス同時アクセス安全化
- [x] chunk削除を「成功時のみ」に変更＝失敗時は再試行で頭から再処理可能（冪等）
- [x] PII保護: jobs.db / booking.db / *-wal / *-shm を 0600
- [x] 運用ツール `queue-status.js`（件数/失敗一覧、`--retry`で再投入）
- ※ server.jsはバックアップ後に差し替え（backups/deploy_*）。シグナリング(Socket.io)は無変更。

## ビデオ通話
- [x] WebRTC P2P接続（複数人）
- [x] セルフビュー鏡像表示（CSS scaleX(-1) のみ、ストリーム非影響）
  - 自分の表示=人物ミラー＋背景は正向き。相手送出/録画(effectsCanvas)は正対。
  - 自分プレビューは背景だけ事前左右反転 → CSS scaleX(-1)で背景が正向きに戻る（2026-06-24修正）
  - 入室前プレビュー(#preview-video)も同方針でミラー化（人物ミラー・背景正向き）
- [x] 仮想背景（ぼかし・単色・画像）※effectsCanvasは正常方向描画、自分プレビューのみ背景事前反転
- [x] ウェイティングルーム（admit/reject）
- [x] チャット・ファイル送受信
- [x] 画面共有
- [x] 録画・ダウンロード（トークン制URL）

## AI・音声処理
- [x] Groq Whisper 文字起こし
- [x] GPT-4o GAINS抽出（BNIモード）
- [x] GPT-4o 要約生成（一般・福祉モード）
- [x] audio-chunk 分割アップロード（30MB/chunk制限）
- [x] BNI Manager Webhook送信（HMAC認証）

## 予約システム
- [x] ユーザー登録（Google OAuth / パスワード）
- [x] 予約枠設定（曜日・時間・スロット）
- [x] 公開予約ページ（/b/:slug）
- [x] 予約リンクにsystem=bni&bu=&bn=パラメータ付与（文字起こし保存に必須）
- [x] メール通知（予約確定・キャンセル）
- [x] キャンセルページ（/cancel）

## BNI連携
- [x] BNI Manager SSO（HMAC署名トークン、5分TTL）
- [x] ダッシュボードからBNI Manager直接オープン
- [x] 文字起こし → BNI Manager 自動保存

## 福祉SaaS連携
- [x] 福祉SSO（welfare-sso endpoint）
- [x] 面談記録保存（nm_call_records）
- [x] 施設管理（nm_facilities・拠点管理）
- [x] CSV出力（会議記録・面談記録）

## セキュリティ（実装済み・変更注意）
- [x] セッション永続化（sessions.db）
- [x] パストラバーサル対策（path.resolve + startsWith）
- [x] チャットXSS対策（escHtml on socket payloads）
- [x] CSVインジェクション対策（csvCell()ヘルパー）
- [x] audio-chunk DoS対策（30MB制限 + uploadLimiter）
- [x] admin rate limit（authLimiter 20回/15分）
- [x] Stripe顧客ID auto-clear（resource_missing時）
- [x] Webhook HMAC定数時間比較
- [x] 録音ファイル一時トークンアクセス
