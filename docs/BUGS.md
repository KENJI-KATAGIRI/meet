# NiceMeet 既知バグ・未解決事項

## 未解決

### 機能未実装
- [ ] Google Calendar スコープ審査待ち（OAuth審査中のため本番未使用）
- [ ] ZIPインポート機能（設計済み・未実装）
- [ ] 90日キャンセル後データ自動削除
- [ ] チャット履歴のセッション跨ぎ保持
- [ ] モバイルUI改善（レスポンシブ対応不完全）
- [ ] サブスクモデル開発（NiceMeet単体の月額プラン）

### 注意が必要な挙動
- 仮想背景使用中に録画すると自分の映像は正常だが、
  相手からの録画は鏡像になる場合がある（WebRTC側の仕様）

### 既知の軽微事項・今後の課題
- `meet-worker.service` の `StartLimitIntervalSec` は本来 `[Unit]` セクション指定のため
  systemdに無視されている（既存 meet.service も同様）。`Restart=always` は有効で自動復帰は機能する。
- finalize処理のワーカー内同期I/O（readFileSync・WebMヘッダのバイト走査ループ）は未最適化。
  別プロセス化でシグナリングへの影響は解消済みのため優先度低（将来 Buffer.indexOf / fs.promises 化）。
- BNI Manager webhookの冪等化（bni-app側で session_id による二重着信防止）は別タスク。
  現状、ジョブ再試行時に同一録音のwebhookが二重着信する可能性あり（max_attempts=3で抑制）。
- 失敗ジョブの確認: `cd /home/ubuntu/meet && node queue-status.js`（`--retry`で再投入）。

## 解決済み（再発注意）

### 仮想背景の画像が自分の画面で左右反転して見える（2026-06-24）
- **症状**: 自分の表示で人物はミラーで自然だが、背景画像（文字・ロゴ等）が反転。相手側・録画は正対で正常。
- **原因**: 自分プレビュー(previewCanvas / 入室前previewFxCanvas)を全て正常方向で描画していたため、
  タイルのCSS `scaleX(-1)` が人物だけでなく背景画像まで反転させていた。
- **対処**: 自分プレビューの**背景だけを事前に左右反転**して描画（CSS反転後に背景が正向きに戻る）。
  人物・マスクは正常方向のまま（CSSでミラー）。入室前プレビューも `#preview-video` にミラーCSSを追加し同方針に統一。
  相手送出/録画の `effectsCanvas` は無変更（正対のまま）。
- **確認場所**: public/index.html `updatePreviewCanvas`、`previewFx`描画、CSS `#tile-local video,#preview-video`

### audio-finalize処理中のシグナリング固まり / 再起動で文字起こし消失（2026-06-24）
- **原因**: finalizeが即レス後、同一Nodeプロセス(イベントループ)で文字起こし・要約・webhookを同期実行。
  同期I/O中に全ユーザーのSocket.ioシグナリングが固まり、ジョブ永続化が無いため処理中の再起動で消失。
- **対処**: 永続ジョブキュー(SQLite/`data/jobs.db`)＋別プロセスワーカー(`worker.js`/systemd `meet-worker`)に分離。
  Webプロセスはenqueueのみ。落ちてもjobは残り再開。詳細は DESIGN.md「音声処理パイプライン」。
- **確認場所**: server.js `/api/audio-finalize`、lib/queue.js、lib/finalize.js、worker.js

### 文字起こしがBNI Managerに保存されない
- **原因**: ダッシュボードから開くURLに `?system=bni&bu=名前&bn=相手名` が含まれていなかった
- **対処**: server.js の meetUrl 生成箇所（booking作成・dashboard表示）両方に追加済み
- **確認場所**: server.js L1094、booking/dashboard.html L607

### 録画ファイルへの不正アクセス（パストラバーサル）
- **対処**: path.resolve + startsWith チェック追加済み（server.js L1187）

### チャットXSS
- **対処**: recording-ready / transcription-ready のURL・ファイル名を escHtml() 済み

### audio-chunk DoS
- **対処**: fileSize制限 200MB → 30MB に変更済み

### Stripe顧客ID不整合エラー
- **症状**: `my-plan stripe error: No such customer: 'cus_UhdWY3LvC0XDTs'` が毎回ログに出る
- **対処**: booking.dbのstripe_customer_idをNULLクリア済み＋コードにauto-clear追加済み
