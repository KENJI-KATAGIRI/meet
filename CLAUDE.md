# NiceMeet — Claude作業ガイド

## 必ず最初に読むこと
- docs/REQUIREMENTS.md — 何を作るか
- docs/DESIGN.md       — 構造・DB・API設計
- docs/BUGS.md         — 既知バグ（再発させるな）
- docs/DONE.md         — 完了済み（再実装・破壊するな）

## 基本情報
- Port: 3100
- URL: https://meet.gaiaarts.org
- メインファイル: server.js
- DB: data/booking.db（better-sqlite3）
- プロセス管理: systemd（meet.service）

## よく使うコマンド
```bash
# 再起動
sudo systemctl restart meet && systemctl is-active meet

# ログ確認
journalctl -u meet -n 50 --no-pager

# DB確認
sqlite3 data/booking.db '.tables'

# 構文チェック
node --check server.js
```

## 作業ルール
1. 変更前に必ずバックアップ: `cp server.js server.js.bak_$(date +%Y%m%d)`
2. 変更後は必ず `node --check server.js` で構文確認
3. 再起動後に `systemctl is-active meet` でactive確認
4. セキュリティ修正は1件ずつ、動作確認してから次へ
5. 完了したらgit commit & push（VPS上で実行）

## 重要な実装メモ
- 仮想背景キャンバスは**正常方向**で描画（CSS scaleX(-1)が表示のみ担当）
- 予約URLは必ず `?system=bni&bu=ホスト名&bn=相手名` を含めること
- CSVはcsvCell()を必ず使う（数式インジェクション対策）
- audio-chunkはゲストも使うのでrequireAuthは付けない

## 🔒 全作業共通ルール（必須ルーティン）

このシステムでどんな作業を行う場合も、以下を必ず順守すること。

1. **セキュリティ対策を講じた上で実行する**
   - 認証・権限（テナント/施設の所有権）チェックを必ず通す。他テナントのデータに触れさせない。
   - 入力値の検証・サニタイズ（SQLインジェクション・XSS・パストラバーサル対策）。
   - 秘密情報（`.env` / `SECRET_KEY` / `WELFARE_SSO_SECRET` / トークン / パスワード等）を出力・ログ・レスポンスに露出させない。
   - 既存のセキュリティ機構（JWT検証・レート制限・HMAC署名など）を弱めない・回避しない。

2. **実行 → 検証 → バグチェックまでをルーティン化する**
   - 変更後は必ず構文チェック（例: `python3 -m py_compile main.py`）を通す。
   - エンドポイント／画面の動作を検証し、想定外挙動・回帰バグがないか確認する。
   - 検証していないものを「完了」と報告しない。未検証・スキップした点は正直に明示する。

3. **破壊的操作は影響範囲を確認してから**
   - DBスキーマ変更・削除・再起動は影響範囲を確認し、必要に応じてバックアップを取ってから行う。
   - サービス再起動には sudo が必要（`keihi` 以外は要パスワード）→ 原則ユーザーに依頼する。
