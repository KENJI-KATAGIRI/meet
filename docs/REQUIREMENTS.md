# NiceMeet 要件定義

## サービス概要
WebRTCビデオ通話 + AI文字起こし・要約 + 予約管理システム
URL: https://meet.gaiaarts.org

## 主要機能

### ビデオ通話
- WebRTC P2P通話（複数人対応）
- 仮想背景（ぼかし・単色・画像）
- セルフビュー鏡像表示（CSS scaleX(-1)、ストリームには影響しない）
- チャット・ファイル共有（50MB以下、許可MIME限定）
- 画面共有
- ウェイティングルーム（ホスト許可制）

### AI機能
- 録音 → Groq Whisper で文字起こし
- 文字起こし → OpenAI GPT-4o で要約生成
- BNIモード: GAINS情報抽出 → BNI Manager Webhook送信
- 福祉モード: 支援記録の構造化

### 予約管理（Booking）
- ユーザー登録（Google OAuth / メール+パスワード）
- 予約枠設定・公開ページ（/b/:slug）
- 予約者によるセルフ予約・キャンセル
- Google Calendar連携（OAuth）
- BNI Manager へのSSO連携

### 施設管理（福祉SaaS向け）
- 複数拠点管理
- 面談記録・CSV出力
- UTAGE/UnivaPay Webhook受信 → プラン管理

### 管理者
- /admin ページ（ADMIN_SECRET認証）
- ユーザー一覧・CSV・プランドラフト確認

## ターゲット
- BNIメンバー（1-2-1ミーティング）
- 福祉施設（介護・就労支援等）
- 一般ユーザー（将来的なサブスク）

## 料金プラン
- free / trial / paid（Stripe連携）
- 施設プラン（複数拠点）
