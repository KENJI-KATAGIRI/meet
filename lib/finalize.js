// NiceMeet finalize 処理（ワーカープロセス用に server.js から移設）
// server.js も isWhisperHallucination / WELFARE_PROMPTS をこのモジュールから require する（DRY）。
// 重いI/O・Whisper・GPT・webhook はすべてここで実行され、別プロセス(worker.js)から呼ばれる。
const fs = require('fs');
const path = require('path');

const HALLUCINATION_PHRASES = [
  'ご視聴ありがとうございました',
  'チャンネル登録',
  'いいねボタン',
  'サブスクライブ',
  '次の動画でお会いしましょう',
  'この動画が良かったら',
  'ご覧いただきありがとうございました',
  '字幕を使用することで',
  'ビデオの字幕を読む',
  '日本語のビデオの字幕',
  '以下は日本語のビデオ',
  'かわいい かわいい',
  // 無音・短時間録音時のWhisper日本語ハルシネーション
  'おやすみなさい',
  'お休みなさい',
  'この動画は',
  'この動画では',
  'スタイルの動画',
  'またお会いしましょう',
  'バイバイ',
];
function isWhisperHallucination(text) {
  if (!text || text.length < 3) return true;
  // 既知の幻覚フレーズ
  for (const phrase of HALLUCINATION_PHRASES) {
    if (text.includes(phrase)) return true;
  }
  // 句読点単位の繰り返し（「。」「、」で分割）
  const segs = text.split(/[。！？\n]+/).map(s => s.trim()).filter(s => s.length > 2);
  if (segs.length >= 3) {
    const uniqSegs = new Set(segs);
    if (uniqSegs.size / segs.length < 0.5) return true;
  }
  // 単語単位の繰り返し
  const words = text.split(/[\s、。！？]+/).filter(w => w.length > 0);
  if (words.length >= 4) {
    const unique = new Set(words);
    if (unique.size / words.length < 0.3) return true;
  }
  return false;
}

const WELFARE_PROMPTS = {
  houdei: {
    '個別支援計画モニタリング記録': `以下は放課後等デイサービスにおける個別支援計画モニタリング面談の文字起こしです。「個別支援計画モニタリング記録」として業務記録文体（〜が見られた／〜に取り組んだ／〜が確認された）で作成してください。
禁止表現：「問題行動」→「気になる行動」「支援が必要な場面」に言い換え。「できない」ではなく「〜に向けて支援中」。
以下の見出しで記述してください：
【本人の様子・心身の状態】
【5領域別の現況】健康・生活 / 運動・感覚 / 認知・行動 / 言語・コミュニケーション / 人間関係・社会性
【短期目標の達成状況】目標ごとに「達成／概ね達成／取組中」で評価
【保護者からの意見・要望】「保護者より〜との申し出あり」形式で
【今後の支援方針】
【計画変更の要否と内容】
【次回モニタリング予定】`,

    '保護者面談記録': `以下は放課後等デイサービスにおける保護者面談の文字起こしです。「保護者面談記録」として業務記録文体で作成してください。
以下の見出しで記述してください：
【面談目的・経緯】
【家庭での様子（保護者報告）】「保護者より〜との報告あり」形式で
【本人の状態・変化】
【保護者の主な意見・要望】
【合意事項・決定内容】
【次回連絡・面談予定】`,

    'サービス担当者会議記録': `以下は放課後等デイサービスにおけるサービス担当者会議の文字起こしです。「サービス担当者会議記録」として業務記録文体で作成してください。
以下の見出しで記述してください：
【開催目的・参加者】（職種・続柄で記載）
【各担当者からの情報共有】
【本人・家族の意向】
【支援方針の合意内容】
【役割分担・対応事項】
【次回開催予定】`
  },

  houmon: {
    'モニタリング記録': `以下は訪問介護におけるモニタリング面談の文字起こしです。「モニタリング記録」として介護保険事業所の業務記録文体（〜を実施した／〜が見られた／〜の申し出があった）で作成してください。
禁止表現：「いつものように」「特に問題なし」だけの記録は避け、具体的な内容を記述すること。「〜させた」という強制表現は使わない。
以下の見出しで記述してください：
【利用者の現状（身体・生活状況の変化）】
【訪問介護サービスの実施状況】
【本人・家族の意向・要望】「ご本人より〜との意向が示された」「ご家族より〜との申し出があった」形式で
【問題点・特記事項】
【ケアプランとの整合性・変更の要否】
【次回モニタリング予定・対応事項】`,

    'サービス担当者会議記録': `以下は訪問介護におけるサービス担当者会議の文字起こしです。「サービス担当者会議記録」として業務記録文体で作成してください。
以下の見出しで記述してください：
【開催目的・参加者】（職種・事業所名を記載）
【利用者・家族の状況報告】
【各サービス事業所からの情報共有】
【課題・検討事項】
【ケアプランの変更内容・合意事項】
【役割分担・次回確認事項】`
  },

  shuro: {
    '個別支援計画モニタリング記録': `以下は就労継続支援におけるモニタリング面談の文字起こしです。「個別支援計画モニタリング記録」としてサービス管理責任者（サビ管）が作成する業務記録文体（〜に取り組んだ／〜の意向が示された／〜が確認された）で作成してください。
禁止表現：「就労が困難な利用者」「問題利用者」等の否定的・差別的表現は使わない。自己決定を尊重する表現を使用。
以下の見出しで記述してください：
【利用者の現状（作業・生活状況・健康状態）】
【就労意欲・将来の目標（本人の言葉を中心に）】「ご本人より〜との意向が示された」形式で
【作業能力・対人関係の変化】
【短期目標・長期目標の達成状況】
【課題と支援内容】
【今後の支援方針・計画変更の要否】
【関係機関との連携事項】
【次回面談予定】`,

    'サービス担当者会議記録': `以下は就労継続支援におけるサービス担当者会議の文字起こしです。「サービス担当者会議記録」として業務記録文体で作成してください。
以下の見出しで記述してください：
【開催目的・参加者】（職種・関係機関を記載）
【利用者の現状報告】
【各担当者からの意見・情報提供】
【本人・家族の意向】
【支援方針の決定・合意内容】
【次回開催予定・対応事項】`,

    '就労移行支援会議記録': `以下は就労継続支援における就労移行・関係機関との会議の文字起こしです。「就労移行支援会議記録」として業務記録文体で作成してください。
以下の見出しで記述してください：
【開催目的・参加者】（ハローワーク・就労支援センター等の外部機関も明記）
【就労状況・職場環境の報告】
【本人の状態・意向】
【職場・支援機関からのフィードバック】
【今後の支援方針・役割分担】
【次回確認事項・予定】`
  },

  kaigo: {
    'モニタリング記録': `以下は介護グループホームにおけるモニタリング面談の文字起こしです。「モニタリング記録」として介護事業所の業務記録文体（〜の様子であった／〜が確認された／〜が見られた）で作成してください。
禁止表現：「徘徊」→「ひとり歩き」、「問題行動」→「BPSD」「気になる言動」、「意思疎通困難」→「本人なりのコミュニケーションが見られる」に言い換え。
以下の見出しで記述してください：
【入居者の様子・心身状態の変化】（ADL・認知機能・BPSD含む）
【日常生活・活動への参加状況】
【ケアプランの目標達成状況】
【家族の意向・来訪時の様子】「ご家族より〜の申し出あり」形式で
【医療・看護との連携状況】
【課題と今後のケア方針】
【計画変更の要否と内容】
【次回モニタリング予定】`,

    '家族面談記録': `以下は介護グループホームにおける家族面談の文字起こしです。「家族面談記録」として業務記録文体で作成してください。
以下の見出しで記述してください：
【面談目的・参加者】（続柄を記載）
【入居者の近況報告】
【家族からの意見・要望・確認事項】
【共有した事項・説明内容】
【合意事項・今後の対応】
【次回連絡・面談予定】`,

    '運営推進会議記録': `以下は介護グループホームにおける運営推進会議の文字起こしです。「運営推進会議記録」として業務記録文体で作成してください。地域住民等への開示を前提とした表現を使用してください。
以下の見出しで記述してください：
【開催日時・場所・参加者】（地域住民・行政担当者・家族代表等の立場を明記）
【事業所の活動状況報告】
【利用者の状況（個人が特定されない形で）】
【地域との連携・意見交換内容】
【決定事項・対応事項】
【次回開催予定】`,

    'サービス担当者会議記録': `以下は介護グループホームにおけるサービス担当者会議の文字起こしです。「サービス担当者会議記録」として業務記録文体で作成してください。
以下の見出しで記述してください：
【開催目的・参加者】（職種・事業所を記載）
【入居者の現状・各職種からの評価】
【家族の意向】
【ケアプランの変更内容・合意事項】
【役割分担・次回確認事項】`
  }
,
  seikatsu: {
    'モニタリング記録': `以下は生活訓練事業所におけるモニタリング面談の文字起こしです。「モニタリング記録」として業務記録文体で作成してください。
以下の見出しで記述してください：
【本人の状況・生活状況の変化】
【生活訓練の実施状況・達成度】
【本人の意向・希望】「ご本人より〜との意向が示された」形式で
【課題と今後の支援方針】
【計画変更の要否】
【次回面談予定】`,
    'サービス担当者会議記録': `以下は生活訓練事業所におけるサービス担当者会議の文字起こしです。「サービス担当者会議記録」として業務記録文体で作成してください。
以下の見出しで記述してください：
【参加者】（役職・事業所名を記載）
【本人・家族の意向】
【各担当者からの情報提供】
【合意事項・支援方針】
【役割分担・対応事項】
【次回開催予定】`,
    '家族面談記録': `以下は生活訓練事業所における家族面談の文字起こしです。「家族面談記録」として業務記録文体で作成してください。
以下の見出しで記述してください：
【面談目的・参加者】（続柄を記載）
【家庭での様子（家族報告）】
【本人の状態・変化】
【家族の意向・要望】「ご家族より〜との申し出あり」形式で
【合意事項・対応内容】
【次回連絡・面談予定】`
  },
  keikaku: {
    'サービス担当者会議記録': `以下は計画相談支援事業所におけるサービス担当者会議の文字起こしです。「サービス担当者会議記録」として業務記録文体で作成してください。
以下の見出しで記述してください：
【参加者】（役職・事業所名を記載）
【本人・家族の現状と意向】
【各サービス担当者からの情報共有】
【ニーズ・課題の整理】
【サービス等利用計画の変更内容・合意事項】
【役割分担・対応事項】
【次回開催予定】`,
    'モニタリング記録': `以下は計画相談支援事業所におけるモニタリング面談の文字起こしです。「モニタリング記録」として相談支援専門員が作成する業務記録文体で作成してください。
以下の見出しで記述してください：
【利用者の現状（生活状況・健康状態・障害の状況）】
【各サービスの利用状況】
【計画目標の達成状況】
【本人・家族の意向・要望】
【課題と今後の支援方針】
【計画変更の要否と内容】
【次回モニタリング予定】`,
    '家族面談記録': `以下は計画相談支援事業所における家族面談の文字起こしです。「家族面談記録」として業務記録文体で作成してください。
以下の見出しで記述してください：
【面談目的・参加者】（続柄を記載）
【家庭での様子（家族報告）】
【本人の状態・変化】
【家族の意向・要望】「ご家族より〜との申し出あり」形式で
【合意事項・対応内容】
【次回連絡・面談予定】`
  }};

const BNI_PROMPT = `あなたはBNI（Business Network International）の1-2-1ミーティング専門の記録アシスタントです。
以下の会話からGAINS情報と紹介機会を抽出してください。

【重要：文字起こしの品質について】
- 音声認識（Whisper）による自動文字起こしのため、誤認識・ノイズ文字列が含まれる場合があります
- 「ブーブー」「パップ」「ぬー」などの意味不明な断片は無視し、前後の文脈から会話の意図を読み取ること
- 多少garbledでも、会話全体から合理的に読み取れる内容は積極的に抽出すること

【守るルール】
- 会話の文脈・流れから合理的に読み取れる内容を記録すること
- 明らかに存在しない情報の創作・捏造は絶対にしないこと
- 会話に一切出てきていない情報は空文字 "" にすること
- 文字数が極端に少ない（実質30文字未満）か、挨拶のみで会話が全くない場合だけ、summaryに「会話が短すぎるか、1-2-1の内容ではありませんでした」と入れ、他フィールドは全て "" にすること

GAINS:
G - Goals（目標）: ビジネス目標・人生の夢・達成したいこと
A - Accomplishments（実績）: 最近の成功・受賞・成果
I - Interests（趣味・関心）: 趣味・プライベートの関心・ライフスタイル
N - Networks（人脈）: 所属団体・コミュニティ・業界つながり
S - Skills（スキル）: 専門スキル・資格・得意分野

必ずJSON形式のみで出力すること（他のテキストは一切含めない）:
{
  "summary": "1-2-1全体の要約（3-4文）",
  "gains": {
    "goals": "会話から読み取れた目標。なければ空文字",
    "accomplishments": "会話から読み取れた実績。なければ空文字",
    "interests": "会話から読み取れた趣味・関心。なければ空文字",
    "networks": "会話から読み取れた人脈。なければ空文字",
    "skills": "会話から読み取れたスキル。なければ空文字"
  },
  "referral_hints": "会話から読み取れた紹介機会。なければ空文字",
  "follow_up": "会話から読み取れたフォローアップ。なければ空文字"
}`;

const VIDEO_CALL_PROMPTS = {
  shuro: {
    "家族・保護者との面談": `以下は就労継続支援スタッフと利用者の家族・保護者とのビデオ通話の文字起こしです。「家族・保護者連絡記録」として業務記録文体（〜との報告があった／〜の意向が示された）で作成してください。
以下の見出しで記述してください：
【家族・保護者の報告事項】「〜より〜との報告あり」形式で
【利用者の状況についての情報共有】
【家族・保護者の意向・要望】
【施設側からの説明・合意内容】
【次回連絡予定・対応事項】`,
    "就労先企業との連絡調整": `以下は就労継続支援スタッフと就労先企業担当者とのビデオ通話の文字起こしです。「就労先連絡記録」として業務記録文体で作成してください。
以下の見出しで記述してください：
【連絡目的・経緯】
【就労先からの報告・意見】
【利用者の職場での状況】
【調整・合意内容】
【次回連絡予定・フォローアップ事項】`,
    "相談支援専門員・ハローワーク連絡": `以下は就労継続支援スタッフと相談支援専門員またはハローワーク担当者とのビデオ通話の文字起こしです。「関係機関連絡記録」として業務記録文体で作成してください。
以下の見出しで記述してください：
【連絡目的・経緯】
【相談支援専門員・ハローワークからの情報提供】
【利用者に関する情報共有】
【今後の支援方針・役割分担の確認】
【次回連絡・会議予定】`,
    "関係機関との担当者会議": `以下は就労継続支援事業所を含む複数の関係機関によるオンライン担当者会議の文字起こしです。「担当者会議記録（オンライン）」として業務記録文体で作成してください。
以下の見出しで記述してください：
【参加機関・参加者】
【協議事項・各機関からの報告】
【利用者の現状・ニーズ】
【支援方針・役割分担の合意内容】
【アクションアイテム・担当者】
【次回会議予定】`,
    "スタッフ間ミーティング": `以下は就労継続支援スタッフ間のオンラインミーティングの文字起こしです。「スタッフミーティング記録」として業務記録文体で作成してください。
以下の見出しで記述してください：
【議題・確認事項】
【利用者に関する情報共有・申し送り事項】
【運営・業務に関する決定事項】
【課題・対応策】
【次回ミーティング予定・TODO】`,
    "利用者本人との面談（リモート）": `以下は就労継続支援スタッフと利用者本人とのビデオ通話による個別面談の文字起こしです。「個別面談記録（リモート）」として業務記録文体（〜との訴えあり／〜が確認された）で作成してください。
以下の見出しで記述してください：
【利用者の現在の状況・体調】
【訴え・相談内容】
【就労・生活に関する状況】
【支援内容・アドバイス】
【次回面談予定・対応事項】`,
  },
  houmon: {
    "利用者・家族との連絡": `以下は訪問介護事業所スタッフと利用者または家族とのビデオ通話の文字起こしです。「利用者・家族連絡記録」として業務記録文体で作成してください。
以下の見出しで記述してください：
【連絡目的・経緯】
【利用者・家族からの報告・要望】「〜より〜との申し出あり」形式で
【サービスに関する確認事項】
【合意・決定内容】
【次回連絡・訪問予定】`,
    "ケアマネージャーとの連絡": `以下は訪問介護スタッフとケアマネージャーとのビデオ通話の文字起こしです。「ケアマネージャー連絡記録」として業務記録文体で作成してください。
以下の見出しで記述してください：
【連絡内容・目的】
【ケアマネージャーからの情報・指示】
【利用者状況の共有】
【ケアプランに関する調整・確認事項】
【次回連絡予定・対応事項】`,
    "サービス担当者会議（オンライン）": `以下は訪問介護サービスに関するオンライン担当者会議の文字起こしです。「サービス担当者会議記録（オンライン）」として業務記録文体で作成してください。
以下の見出しで記述してください：
【参加者】
【協議事項・各担当者からの報告】
【利用者の現状・ニーズ】
【支援方針・役割分担の合意内容】
【次回開催予定】`,
    "スタッフ間ミーティング": `以下は訪問介護事業所スタッフ間のオンラインミーティングの文字起こしです。「スタッフミーティング記録」として業務記録文体で作成してください。
以下の見出しで記述してください：
【議題・確認事項】
【利用者に関する申し送り事項】
【業務・運営に関する決定事項】
【課題・対応策】
【次回ミーティング予定・TODO】`,
  },
  houdei: {
    "保護者との面談": `以下は放課後等デイサービスの職員と保護者とのビデオ通話の文字起こしです。「保護者連絡記録（ビデオ面談）」として業務記録文体で作成してください。
以下の見出しで記述してください：
【面談目的・経緯】
【保護者からの報告・要望】「保護者より〜との報告あり」形式で
【お子さんの状態・変化の共有】
【合意事項・次回対応】
【次回連絡・面談予定】`,
    "学校・教育機関との連絡": `以下は放課後等デイサービスと学校・教育機関とのビデオ通話の文字起こしです。「学校連携記録」として業務記録文体で作成してください。
以下の見出しで記述してください：
【連絡目的・経緯】
【学校側からの情報・報告】
【お子さんの状況共有】
【連携内容・合意事項】
【次回連絡予定】`,
    "専門家（PT・OT・ST等）との連絡": `以下は放課後等デイサービスと専門家（理学療法士・作業療法士・言語聴覚士等）とのビデオ通話の文字起こしです。「専門家連携記録」として業務記録文体で作成してください。
以下の見出しで記述してください：
【連絡目的・専門家の氏名・職種】
【専門家からの評価・アドバイス】
【支援への反映事項】
【保護者への情報共有内容】
【次回連絡・評価予定】`,
    "関係機関との担当者会議": `以下は放課後等デイサービスが参加したオンライン担当者会議の文字起こしです。「担当者会議記録（オンライン）」として業務記録文体で作成してください。
以下の見出しで記述してください：
【参加者・機関名】
【各機関からの報告・情報共有】
【お子さんの現状・ニーズ】
【支援方針・役割分担の合意内容】
【次回会議予定】`,
    "スタッフ間ミーティング": `以下は放課後等デイサービスのスタッフ間オンラインミーティングの文字起こしです。「スタッフミーティング記録」として業務記録文体で作成してください。
以下の見出しで記述してください：
【議題・確認事項】
【お子さんに関する情報共有・申し送り】
【運営・業務の決定事項】
【課題・対応策】
【次回ミーティング予定・TODO】`,
  },
  kaigo: {
    "家族との面談": `以下は介護グループホームの職員と入居者家族とのビデオ通話の文字起こしです。「家族連絡記録（ビデオ面談）」として業務記録文体で作成してください。
以下の見出しで記述してください：
【面談目的・経緯】
【家族からの報告・意向・要望】「ご家族より〜との申し出あり」形式で
【入居者の状態共有】
【合意事項・施設側の対応】
【次回連絡・面談予定】`,
    "ケアマネージャーとの連絡": `以下は介護グループホームの職員とケアマネージャーとのビデオ通話の文字起こしです。「ケアマネージャー連絡記録」として業務記録文体で作成してください。
以下の見出しで記述してください：
【連絡内容・目的】
【ケアマネージャーからの情報・指示】
【入居者状況の共有】
【ケアプランに関する調整・確認事項】
【次回連絡・モニタリング予定】`,
    "医療機関との連絡": `以下は介護グループホームの職員と医療機関とのビデオ通話の文字起こしです。「医療機関連絡記録」として業務記録文体で作成してください。
以下の見出しで記述してください：
【連絡目的・入居者名】
【医療機関からの情報・指示】
【入居者の状態・症状の報告】
【対応内容・処置・投薬変更等】
【次回受診・連絡予定】`,
    "サービス担当者会議（オンライン）": `以下は介護グループホームが参加したオンラインサービス担当者会議の文字起こしです。「サービス担当者会議記録（オンライン）」として業務記録文体で作成してください。
以下の見出しで記述してください：
【参加者・機関名】
【各担当者からの報告・情報共有】
【入居者の現状・ニーズ】
【ケアプランの合意・変更内容】
【次回開催予定】`,
    "スタッフ間ミーティング": `以下は介護グループホームのスタッフ間オンラインミーティングの文字起こしです。「スタッフミーティング記録」として業務記録文体で作成してください。
以下の見出しで記述してください：
【議題・確認事項】
【入居者に関する情報共有・申し送り】
【業務・運営の決定事項】
【課題・対応策】
【次回ミーティング予定・TODO】`,
  },
  roukin: {
    "家族との面談": `以下は老人ホームの職員と入居者家族とのビデオ通話の文字起こしです。「家族連絡記録（ビデオ面談）」として業務記録文体で作成してください。
以下の見出しで記述してください：
【面談目的・経緯】
【家族からの報告・意向・要望】「ご家族より〜との申し出あり」形式で
【入居者の状態共有】
【合意事項・施設側の対応】
【次回連絡・面談予定】`,
    "ケアマネ・医療機関との連絡": `以下は老人ホームの職員とケアマネージャーまたは医療機関とのビデオ通話の文字起こしです。「専門家連絡記録」として業務記録文体で作成してください。
以下の見出しで記述してください：
【連絡目的・相手の職種・機関】
【相手側からの情報・指示・アドバイス】
【入居者状況の報告】
【対応・合意内容】
【次回連絡予定】`,
    "担当者会議（オンライン）": `以下は老人ホームが参加したオンライン担当者会議の文字起こしです。「担当者会議記録（オンライン）」として業務記録文体で作成してください。
以下の見出しで記述してください：
【参加者・機関名】
【各担当者からの報告・情報共有】
【入居者の現状・ニーズ】
【支援方針・役割分担の合意内容】
【次回会議予定】`,
    "スタッフ間ミーティング": `以下は老人ホームのスタッフ間オンラインミーティングの文字起こしです。「スタッフミーティング記録」として業務記録文体で作成してください。
以下の見出しで記述してください：
【議題・確認事項】
【入居者に関する情報共有・申し送り】
【業務・運営の決定事項】
【課題・対応策】
【次回ミーティング予定・TODO】`,
  },
  beauty: {
    "顧客カウンセリング（オンライン）": `以下は美容事業スタッフと顧客とのビデオカウンセリングの文字起こしです。「オンラインカウンセリング記録」として業務記録文体で作成してください。
以下の見出しで記述してください：
【顧客の相談内容・ニーズ】
【現状の確認（肌・髪・ライフスタイル等）】
【提案内容・説明事項】
【お客様の反応・意向】
【次回アクション・フォローアップ】`,
    "メーカー・仕入先との商談": `以下は美容事業スタッフとメーカーまたは仕入先とのビデオ商談の文字起こしです。「商談記録」として業務記録文体で作成してください。
以下の見出しで記述してください：
【商談目的・相手会社名・担当者名】
【製品・サービスの説明内容】
【価格・条件・納期の確認事項】
【合意内容・発注事項】
【次回連絡・フォローアップ予定】`,
    "スタッフミーティング": `以下は美容事業のスタッフ間オンラインミーティングの文字起こしです。「スタッフミーティング記録」として業務記録文体で作成してください。
以下の見出しで記述してください：
【議題・確認事項】
【業務・顧客対応の情報共有】
【決定事項・方針】
【課題・改善案】
【次回ミーティング予定・TODO】`,
  }
};

// ctx で server.js / worker.js 双方の依存(db, openai 等)を注入する
function createFinalizer(ctx) {
  const { db, bniDb, openai, whisperClient, recDir, sendMail } = ctx;

async function handleBniFinalize({ email, sessionId, staffName, memberName, bniContactId, durMin, transcript, summary }) {
  let bniData = { summary, gains: {}, referral_hints: '', follow_up: '' };
  try {
    const cleaned = summary.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    bniData = Object.assign(bniData, JSON.parse(cleaned));
    console.log('[bni-finalize] JSON parse OK, gains keys:', Object.keys(bniData.gains || {}));
  } catch(e) { console.warn('[bni-finalize] JSON parse failed:', e.message, '| raw:', summary.slice(0, 100)); }

  // GPTが「会話なし・ハルシネーションのみ」と判定した場合はBNI書き込みもメールも送らない
  if ((bniData.summary || '').includes('会話が短すぎるか')) {
    console.log('[bni-finalize] GPT判定: 会話なし or ハルシネーションのみ → スキップ');
    return;
  }

  const bniWebhookUrl = process.env.BNI_WEBHOOK_URL || 'http://localhost:8300/api/nicemeet-webhook';
  const bniSecret = process.env.BNI_WEBHOOK_SECRET; if (!bniSecret) { console.error('[FATAL] BNI_WEBHOOK_SECRET not set'); return; }
  try {
    await fetch(bniWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-nicemeet-secret': bniSecret },
      body: JSON.stringify({
        bni_user: staffName,
        bni_email: email,
        contact_id: bniContactId,
        contact_name: memberName,
        duration_minutes: durMin,
        transcript,
        summary: bniData.summary || summary,
        gains: bniData.gains || {},
        referral_hints: bniData.referral_hints || '',
        follow_up: bniData.follow_up || ''
      })
    });
    console.log(`[bni-finalize] sent to BNI app user=${staffName} contact=${memberName}`);

    // R2バックアップ保存
    const driveUrl = process.env.DRIVE_INTERNAL_URL || 'http://localhost:8309/api/internal/upload-json';
    const driveSecret = process.env.DRIVE_INTERNAL_SECRET; if (!driveSecret) { console.warn('[INFO] DRIVE_INTERNAL_SECRET not set, skipping R2 backup'); return; }
    const r2Date = new Date().toISOString().slice(0, 10);
    const r2Name = (memberName || 'unknown').replace(/[^\w぀-鿿]/g, '_');
    const r2Key = `nicemeet/bni/${r2Date}/${sessionId}-${r2Name}.json`;
    const r2Body = JSON.stringify({
      date: r2Date, bni_user: staffName, contact_name: memberName,
      duration_minutes: durMin, transcript,
      summary: bniData.summary || summary,
      gains: bniData.gains || {},
      referral_hints: bniData.referral_hints || '',
      follow_up: bniData.follow_up || ''
    }, null, 2);
    fetch(driveUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-secret': driveSecret },
      body: JSON.stringify({ key: r2Key, content: r2Body })
    }).then(() => console.log('[bni-finalize] R2 saved:', r2Key))
      .catch(e => console.error('[bni-finalize] R2 error:', e.message));
  } catch(e) {
    console.error('[bni-finalize] webhook error:', e.message);
  }

  await sendMail(email,
    `【NiceMeet BNI】1-2-1ミーティング記録${memberName ? '（' + memberName + 'さん）' : ''}`,
`━━━━━━━━━━━━━━━━━━
【AI要約】
━━━━━━━━━━━━━━━━━━
${summary}

━━━━━━━━━━━━━━━━━━
【文字起こし（全文）】
━━━━━━━━━━━━━━━━━━
${transcript}
`);
}

async function handleFacilityFinalize({ email, sessionId, fUser, welfareSystem, welfareRecordType, memberName, staffName, durMin, transcript, summary, isWelfareRecord }) {
  if (fUser?.facility_id) {
    if (isWelfareRecord) {
      db.prepare(
        'INSERT INTO nm_call_records (facility_id, room_id, welfare_system, record_type, member_name, staff_name, summary_text, raw_transcript, source) VALUES (?,?,?,?,?,?,?,?,?)'
      ).run(fUser.facility_id, sessionId, welfareSystem, welfareRecordType, memberName, staffName, summary, transcript, 'video');
      console.log(`[facility-finalize] saved to nm_call_records: ${welfareSystem}/${welfareRecordType} member=${memberName}`);
    } else {
      db.prepare(
        'INSERT INTO nm_meetings (facility_id, room_id, host_email, started_at, ended_at, duration_minutes, ai_summary_used, summary_text) VALUES (?,?,?,datetime(\'now\',?),datetime(\'now\'),?,1,?)'
      ).run(fUser.facility_id, sessionId, email, `-${durMin} minutes`, durMin, summary);
    }
  }

  const mailSubject = isWelfareRecord
    ? `【NiceMeet】${welfareRecordType}${memberName ? '（' + memberName + '）' : ''}`
    : '【NiceMeet】会議の文字起こし・要約';
  const mailHeader = isWelfareRecord
    ? `【${welfareRecordType}】\n対象: ${memberName || '（記載なし）'} / 担当: ${staffName || '（記載なし）'} / 面談日: ${new Date().toLocaleDateString('ja-JP')}`
    : '【AI要約】';

  await sendMail(email, mailSubject,
`━━━━━━━━━━━━━━━━━━
${mailHeader}
━━━━━━━━━━━━━━━━━━
${summary}

━━━━━━━━━━━━━━━━━━
【文字起こし（全文）】
━━━━━━━━━━━━━━━━━━
${transcript}
`);
}

  async function processFinalizeJob(payload) {
    const { sessionId, email, recordMode, welfareSystem, welfareRecordType,
            memberName, staffName, isWelfareRecord, isBniRecord, bniContactId, fUser } = payload;
  try {
    const chunkFiles = fs.readdirSync(recDir)
      .filter(f => f.startsWith(`audio-${sessionId}-`) && /\.(webm|mp4|ogg|m4a)$/.test(f) && !f.includes('-final'))
      .sort();
    console.log(`[audio-finalize] chunks found: ${chunkFiles.length}`);
    if (chunkFiles.length === 0) {
      await sendMail(email, '【NiceMeet】会議終了（音声データなし）', '会議が終了しましたが、音声データが検出されませんでした。\n無音や短時間の場合は録音されないことがあります。');
      return;
    }
    // WebMはMediaRecorder.start(timeslice)でchunk-0000だけ完全なヘッダーを持ち、
    // chunk-0001以降はClusterデータのみ（ヘッダーなし）なのでWhisper用にヘッダーを付与する
    const firstChunkBuf = fs.readFileSync(path.join(recDir, chunkFiles[0]));
    let webmHeader = null;
    if (firstChunkBuf[0] === 0x1a && firstChunkBuf[1] === 0x45 && firstChunkBuf[2] === 0xdf && firstChunkBuf[3] === 0xa3) {
      // 最初のCluster(1f43b675)の位置を検索してヘッダー部を切り出す
      for (let i = 0; i < firstChunkBuf.length - 3; i++) {
        if (firstChunkBuf[i] === 0x1f && firstChunkBuf[i+1] === 0x43 && firstChunkBuf[i+2] === 0xb6 && firstChunkBuf[i+3] === 0x75) {
          webmHeader = firstChunkBuf.slice(0, i);
          console.log(`[audio-finalize] webmHeader extracted: ${webmHeader.length} bytes`);
          break;
        }
      }
    }

    const tmpDir = require('os').tmpdir();
    const CHUNK_DURATION = 2 * 60; // 2分チャンク（秒）
    const SPEAKER_CHANGE_GAP = 2.0; // 話者切替と判定する無音秒数
    console.log(`[audio-finalize] transcribing ${chunkFiles.length} chunks individually...`);
    const allSegments = []; // { start, end, text } 絶対時刻
    for (let ci = 0; ci < chunkFiles.length; ci++) {
      const f = chunkFiles[ci];
      const fpath = path.join(recDir, f);
      const fsize = fs.statSync(fpath).size;
      if (fsize < 1000) { console.log(`[audio-finalize] skip tiny chunk ${f} (${fsize}bytes)`); continue; }
      let sendPath = fpath;
      let tmpFile = null;
      const chunkOffset = ci * CHUNK_DURATION;
      try {
        const buf = fs.readFileSync(fpath);
        const isComplete = buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3;
        if (!isComplete && webmHeader) {
          tmpFile = path.join(tmpDir, 'nicemeet-' + Date.now() + '-' + f);
          fs.writeFileSync(tmpFile, Buffer.concat([webmHeader, buf]));
          sendPath = tmpFile;
        }
        const result = await whisperClient.audio.transcriptions.create({
          file: fs.createReadStream(sendPath),
          model: 'whisper-large-v3',
          language: 'ja',
          prompt: 'はい。',
          response_format: 'verbose_json',
        });
        const segs = result.segments || [];
        for (const seg of segs) {
          const text = seg.text?.trim();
          if (text && !isWhisperHallucination(text)) {
            allSegments.push({ start: chunkOffset + seg.start, end: chunkOffset + seg.end, text });
          }
        }
        console.log(`[audio-finalize] chunk ${f}: ${segs.length} segments, kept ${allSegments.length} total`);
      } catch(e) {
        console.error(`[audio-finalize] chunk ${f} failed:`, e.message);
      } finally {
        if (tmpFile) fs.unlink(tmpFile, () => {});
      }
    }

    // 話者分離：無音ギャップ > SPEAKER_CHANGE_GAP 秒で話者切替
    const turns = [];
    let currentSpeaker = 'A';
    let lastEnd = 0;
    let currentTexts = [];
    for (const seg of allSegments) {
      const gap = seg.start - lastEnd;
      if (gap > SPEAKER_CHANGE_GAP && currentTexts.length > 0) {
        turns.push({ speaker: currentSpeaker, text: currentTexts.join(' ') });
        currentSpeaker = currentSpeaker === 'A' ? 'B' : 'A';
        currentTexts = [];
      }
      currentTexts.push(seg.text);
      lastEnd = seg.end;
    }
    if (currentTexts.length > 0) turns.push({ speaker: currentSpeaker, text: currentTexts.join(' ') });

    const transcript = turns.map(t => `【話者${t.speaker}】${t.text}`).join('\n');

    const cleanupChunks = () => chunkFiles.forEach(f => fs.unlink(path.join(recDir, f), () => {}));

    // 話者タグを除いた実テキスト文字数で有効な会話かチェック
    const transcriptTextOnly = transcript.replace(/【話者[A-Z]】/g, '').trim();
    if (!transcriptTextOnly || transcriptTextOnly.length < 30) {
      if (isBniRecord) {
        // BNIモード：チェックイン等の誤入室でメールを送らない
        console.log(`[audio-finalize] BNI: transcript too short (${transcriptTextOnly.length} chars), skip mail`);
      } else {
        // 施設モード：短くても通知する
        await sendMail(email, '【NiceMeet】会議の文字起こし', '音声が短すぎるか検出されませんでした。');
      }
      cleanupChunks();
      return;
    }

    const welfarePrompt = isWelfareRecord ? (VIDEO_CALL_PROMPTS[welfareSystem]?.[welfareRecordType] || WELFARE_PROMPTS[welfareSystem]?.[welfareRecordType] || null) : null;

    // BNIモード: 記録者自身のGAINSプロフィールを読み込み（コンタクトのGAINSと混同しないため）
    let hostGainsSection = '';
    if (isBniRecord) {
      // BNI Managerのprofile_dataを優先、なければmeet DBのown_gainsを使用
      let hostGains = {};
      try {
        const bniUser = bniDb.prepare('SELECT profile_data FROM users WHERE email=? OR username=?').get(email, email);
        const pd = JSON.parse(bniUser?.profile_data || '{}');
        // BNI Managerのマイプロフィール GAINS（gains_* キー）
        if (pd.gains_goals || pd.gains_accomplishments || pd.gains_interests || pd.gains_networks || pd.gains_skills) {
          hostGains = { goals: pd.gains_goals, accomplishments: pd.gains_accomplishments, interests: pd.gains_interests, networks: pd.gains_networks, skills: pd.gains_skills };
        }
      } catch(e) {}
      // フォールバック: meet DBのown_gains
      if (!Object.values(hostGains).some(v => v && v.trim())) {
        try {
          const hostUser = db.prepare('SELECT own_gains FROM users WHERE email=?').get(email);
          hostGains = JSON.parse(hostUser?.own_gains || '{}');
        } catch(e) {}
      }
      const hasHostGains = Object.values(hostGains).some(v => v && v.trim());
      if (hasHostGains) {
        hostGainsSection = `\n\n【記録者（${staffName || 'BNIメンバー'}）自身のGAINS（参考情報・GAINSに含めないこと）】\n`
          + (hostGains.goals ? `G-Goals: ${hostGains.goals}\n` : '')
          + (hostGains.accomplishments ? `A-Accomplishments: ${hostGains.accomplishments}\n` : '')
          + (hostGains.interests ? `I-Interests: ${hostGains.interests}\n` : '')
          + (hostGains.networks ? `N-Networks: ${hostGains.networks}\n` : '')
          + (hostGains.skills ? `S-Skills: ${hostGains.skills}\n` : '')
          + `上記は記録者自身の情報です。コンタクト（${memberName || '相手方'}）のGAINSとして記録しないこと。`;
        console.log('[bni-finalize] host gains loaded from BNI Manager profile');
      }
    }

    const systemPrompt = isBniRecord
      ? BNI_PROMPT + (staffName || memberName
          ? `\n\n【参加者情報】\nBNIメンバー（記録者・自分）: ${staffName || '不明'}\nコンタクト（相手方・GAINSの対象）: ${memberName || '不明'}\n\n【重要】GAINSはコンタクト（${memberName || '相手方'}）の情報のみを抽出してください。BNIメンバー自身の情報はGAINSに含めないこと。話者A・話者Bのどちらがコンタクトかは、職業や自己紹介の文脈から判断してください。`
          : '') + hostGainsSection
      : welfarePrompt
        ? `${welfarePrompt}

対象者: ${memberName || '（記載なし）'} / 担当: ${staffName || '（記載なし）'}`
        : '以下はビデオ会議の文字起こしです（話者A・話者Bは異なる参加者です）。日本語で要約してください。箇条書きで主要な議題、決定事項、アクションアイテムをまとめてください。';
    const completion = await openai.chat.completions.create({
      model: isBniRecord ? 'gpt-4o' : 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: transcript }
      ]
    });
    const summary = completion.choices[0].message.content;

    const durMin = chunkFiles.length * 2;
    // モード別処理：各関数は完全独立。片方を修正しても他方に影響しない。
    if (isBniRecord) {
      await handleBniFinalize({ email, sessionId, staffName, memberName, bniContactId, durMin, transcript, summary });
    } else {
      await handleFacilityFinalize({ email, sessionId, fUser, welfareSystem, welfareRecordType, memberName, staffName, durMin, transcript, summary, isWelfareRecord });
    }
    cleanupChunks();
  } catch(e) {
    console.error('audio finalize error:', e.message);
    sendMail(email, '【NiceMeet】文字起こしエラー', '処理中にエラーが発生しました。').catch(() => {});
  }
  }

  return { processFinalizeJob };
}

module.exports = createFinalizer;
module.exports.isWhisperHallucination = isWhisperHallucination;
module.exports.WELFARE_PROMPTS = WELFARE_PROMPTS;
module.exports.BNI_PROMPT = BNI_PROMPT;
module.exports.VIDEO_CALL_PROMPTS = VIDEO_CALL_PROMPTS;
