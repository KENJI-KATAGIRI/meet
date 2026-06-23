# NiceMeet — Claude Code コンテキスト

## プロジェクト概要
BNI向けビデオ通話システム。URL: meet.gaiaarts.org  
BNI Manager（連携先）: gaiaarts.org/bni/

## サーバー構成
- Meetサーバー: Node.js/Express + Socket.io、ポート3100
- BNI Manager: Python FastAPI/uvicorn、ポート8300（サービス名: bni-manager）
- Meetサービス再起動: `sudo -n systemctl restart meet`（NOPASSWD設定済み）
- VPS: ubuntu@49.212.179.11

## 主要ファイル
- `server.js` — メインサーバー（約3300行）
- `public/index.html` — フロントエンド（大きなシングルファイル）
- `/home/ubuntu/apps/bni-app/main.py` — BNI Manager
- `/home/ubuntu/apps/bni-app/data/bni.db` — BNI DB（実データ）
  - 注意: `/home/ubuntu/apps/bni-app/bni.db` は0バイトの空ファイル（使わない）

## BNI 1-2-1フロー
通話終了 → MediaRecorder chunked upload → Whisper（Groq API）文字起こし
→ GPT-4o GAINS抽出 → BNI Manager webhook（/api/nicemeet-webhook）自動書き込み

## 実装済み機能（2026-06時点）

### ホスト管理（BNIモード）
- 匿名クライアントが先に入室→BNIメンバー入室時に自動ホスト引き継ぎ
- ホスト退出時: 自動昇格なし、「渡して退出」モーダル（`transfer-host`イベント）
- `host-revoked` イベントでクライアントにホスト剥奪を通知

### タイマー
- 45分制限タイマー廃止 → 経過時間表示（カウントアップ）

### 待機室
- 入室前プレビュー画面に「待機室を有効にする」チェックボックス
- `join-room`に`waitingRoom`パラメータ追加、ルーム作成時のみ有効
- 待機パネルはトグル削除済み（承認/拒否リストのみ表示）

### 画面共有
- `screenShareAllowed`で参加者の画面共有許可を管理
- 🚪ボタン → 待機パネル内「参加者の画面共有を許可」トグル（ホストのみ）

### ハルシネーション対策
- `HALLUCINATION_PHRASES`に日本語フレーズ追加済み
- GPT「会話なし」判定で早期returnあり

## SSH作業メモ
- SSH heredocにPythonを直接埋め込むと括弧でsyntax error
- → `cat > /tmp/patch.py << 'SHELLEOF'` でファイル書き込み後 `python3 /tmp/patch.py` で実行
