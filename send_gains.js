require("dotenv").config({ path: "/home/ubuntu/meet/.env" });
const OpenAI = require("openai");
const nodemailer = require("nodemailer");
const fs = require("fs");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const mailer = nodemailer.createTransport({
  service: "gmail",
  auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASS }
});

const transcript = fs.readFileSync("/tmp/retranscript-1781589968458-6vjap1.txt", "utf8");

const prompt = `以下の1-2-1ミーティングの文字起こしからGAINS情報と紹介機会を抽出してください。

GAINS:
- Goals（目標・夢）
- Accomplishments（実績・成果）
- Interests（趣味・関心）
- Networks（人脈・つながり）
- Skills（スキル・専門性）

以下のJSON形式で返してください：
{
  "summary": "1-2-1全体の要約（3-4文）",
  "gains": {
    "goals": "相手の目標・夢",
    "accomplishments": "相手の実績・成果",
    "interests": "相手の趣味・関心",
    "networks": "相手の人脈・つながり",
    "skills": "相手のスキル・専門性"
  },
  "referral_hints": "紹介できそうな人・機会",
  "follow_up": "次のアクション"
}

文字起こし：
` + transcript.substring(0, 6000);

async function main() {
  console.log("GAINS生成中...");
  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" }
  });
  const gains = res.choices[0].message.content;
  const gainsObj = JSON.parse(gains);

  const emailBody = `━━━━━━━━━━━━━━━━━━
【1-2-1 GAINS要約】（再送・文字起こし回復版）
━━━━━━━━━━━━━━━━━━

■ 全体要約
${gainsObj.summary}

■ GAINS情報
・Goals（目標）: ${gainsObj.gains.goals}
・Accomplishments（実績）: ${gainsObj.gains.accomplishments}
・Interests（趣味・関心）: ${gainsObj.gains.interests}
・Networks（人脈）: ${gainsObj.gains.networks}
・Skills（スキル）: ${gainsObj.gains.skills}

■ 紹介ヒント
${gainsObj.referral_hints}

■ 次のアクション
${gainsObj.follow_up}

━━━━━━━━━━━━━━━━━━
【文字起こし（全文）】
━━━━━━━━━━━━━━━━━━
` + transcript;

  await mailer.sendMail({
    from: '"NiceMeet" <' + process.env.GMAIL_USER + '>',
    to: "kenji.kys@gmail.com",
    subject: "【NiceMeet】1-2-1 GAINS要約（回復版）",
    text: emailBody
  });
  console.log("送信完了: kenji.kys@gmail.com");
}

main().catch(console.error);
