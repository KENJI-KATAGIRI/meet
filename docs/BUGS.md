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
- audio-finalizeはレスポンス先行・処理非同期のため、
  終了直後にサーバー再起動すると文字起こしが失われる

## 解決済み（再発注意）

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
