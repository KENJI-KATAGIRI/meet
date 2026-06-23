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
