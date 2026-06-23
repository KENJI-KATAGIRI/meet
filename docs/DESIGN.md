# NiceMeet 設計書

## 技術スタック
- Runtime: Node.js / Express
- リアルタイム: Socket.io
- DB: better-sqlite3
  - booking.db — ユーザー・予約・施設・面談記録
  - sessions.db — セッション永続化（express-session）
- 認証: express-session（30日）+ Google OAuth2
- 決済: Stripe + UTAGE/UnivaPay Webhook
- AI: Groq Whisper（文字起こし）+ OpenAI GPT-4o（要約・GAINS抽出）
- メール: Gmail SMTP（nodemailer）

## ポート・パス
- Port: 3100
- 公開URL: https://meet.gaiaarts.org
- Nginx: リバースプロキシ（/bni.htmlへのリダイレクトあり）
- プロセス管理: systemd（meet.service）
- 再起動: sudo systemctl restart meet

## ディレクトリ構成
```
/home/ubuntu/meet/
├── server.js          # メインサーバー（全API）
├── data/
│   ├── booking.db     # メインDB
│   └── sessions.db    # セッションDB
├── recordings/        # 録音ファイル・文字起こし保存先
├── uploads/           # チャットファイルアップロード
└── public/
    ├── index.html     # ビデオ通話画面
    ├── record.html    # 対面録音モード
    ├── admin.html     # 管理画面
    └── booking/
        ├── index.html      # ログイン・登録
        ├── dashboard.html  # ユーザーダッシュボード
        ├── book.html       # 予約ページ（公開）
        └── welfare.html    # 福祉施設ダッシュボード
```

## DBスキーマ（booking.db）
- users: id, name, email, slug, plan, stripe_customer_id, google_id, facility_id
- bookings: id, user_id, booker_name, booker_email, start_at, meet_room, system
- availability: user_id, day_of_week, start_time, end_time
- nm_facilities: id, name, plan, location_count
- nm_meetings: facility_id, room_id, host_email, started_at, duration_minutes
- nm_call_records: facility_id, welfare_system, member_name, staff_name, summary_text
- nm_locations: facility_id, name, address

## 認証フロー
- Google OAuth: /auth/google → callback → session保存
- パスワード: /auth/login → session保存
- BNI SSO: /api/bni-sso-token → HMAC署名トークン → gaiaarts.org/bni/?sso_token=

## 音声処理パイプライン
```
録音(MediaRecorder) → /api/audio-chunk（30MB制限）
→ /api/audio-finalize
→ Groq Whisper（文字起こし）
→ GPT-4o（GAINS抽出 or 要約）
→ BNI Webhook or 福祉記録保存
```

## セキュリティ
- Rate limit: auth 20回/15分、API 100回/分、admin 20回/15分（authLimiter二重適用）
- セッション: sessions.db永続化
- 録音ファイルアクセス: 一時トークン（64hex、1時間TTL）
- path traversal対策: path.resolve + startsWith確認
- SSRF対策: BNI main.pyのextract-contact-url
- CSVインジェクション: csvCell()ヘルパー（=+-@プレフィックス対策）
- Webhook: hmac.compare_digest による定数時間比較

## 環境変数（.env）
SESSION_SECRET, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
OPENAI_API_KEY, GROQ_API_KEY, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
BNI_SSO_SECRET, BNI_WEBHOOK_SECRET, BNI_WEBHOOK_URL,
GMAIL_USER, GMAIL_PASS, ADMIN_SECRET, WELFARE_SSO_SECRET,
TURN_SECRET, UTAGE_WEBHOOK_SECRET
