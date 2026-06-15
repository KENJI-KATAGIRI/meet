
require('dotenv').config({ path: '/home/ubuntu/meet/.env' });
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');
const nodemailer = require('nodemailer');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const mailer = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASS }
});

function isHallucination(text) {
  if (!text || text.length < 3) return true;
  const words = text.split(/[\s、。！？]+/).filter(w => w.length > 0);
  if (words.length < 4) return false;
  const unique = new Set(words);
  if (unique.size / words.length < 0.2) return true;
  return false;
}

async function main() {
  const tmpDir = '/tmp/webm-recover';
  const files = fs.readdirSync(tmpDir).filter(f => f.endsWith('.webm')).sort();
  console.log('処理するファイル数:', files.length);
  
  const parts = [];
  for (const f of files) {
    const fpath = path.join(tmpDir, f);
    const fsize = fs.statSync(fpath).size;
    if (fsize < 1000) { console.log('skip tiny:', f); continue; }
    try {
      console.log('Whisper処理中:', f, fsize, 'bytes...');
      const result = await openai.audio.transcriptions.create({
        file: fs.createReadStream(fpath),
        model: 'whisper-1',
        language: 'ja',
        prompt: '以下は日本語のビデオ会議の音声です。会話を正確に文字起こしてください。',
      });
      const text = result.text?.trim();
      if (text && !isHallucination(text)) {
        parts.push(text);
        console.log('OK:', text.slice(0, 60));
      } else {
        console.log('スキップ（無音/幻覚）:', f, '->', text?.slice(0,40));
      }
    } catch(e) {
      console.error('失敗:', f, e.message);
    }
  }
  
  const transcript = parts.join('\n');
  console.log('\n===文字起こし結果===\n' + transcript.slice(0,500));
  
  if (!transcript) {
    console.log('文字起こし結果なし');
    return;
  }
  
  // GPTで要約
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: '以下の会議の文字起こしを日本語で要約してください。箇条書きで主要な議題、決定事項、アクションアイテムをまとめてください。' },
      { role: 'user', content: transcript }
    ]
  });
  const summary = completion.choices[0].message.content;
  
  const emailText = '【NiceMeet 会議記録（復元版）】\n\n' + '=== 要約 ===\n' + summary + '\n\n=== 文字起こし全文 ===\n' + transcript;
  
  await mailer.sendMail({
    from: '"NiceMeet" <' + process.env.GMAIL_USER + '>',
    to: 'kenji.kys@gmail.com',
    subject: '【NiceMeet】2026-06-14 会議の文字起こし・要約（復元）',
    text: emailText
  });
  console.log('\nメール送信完了！');
}

main().catch(e => { console.error(e); process.exit(1); });
