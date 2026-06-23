require("dotenv").config({ path: "/home/ubuntu/meet/.env" });
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Groq Whisper
const groqClient = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: 'https://api.groq.com/openai/v1'
});

const SESSION_ID = '1781589968458-6vjap1';
const REC_DIR = path.join(__dirname, 'recordings');

const HALLUCINATION_PHRASES = [
  'ご視聴ありがとうございました','チャンネル登録','いいねボタン','サブスクライブ',
  '次の動画でお会いしましょう','この動画が良かったら','ご覧いただきありがとうございました',
];
function isHallucination(text) {
  if (!text || text.length < 3) return true;
  for (const p of HALLUCINATION_PHRASES) if (text.includes(p)) return true;
  const segs = text.split(/[。！？\n]+/).map(s => s.trim()).filter(s => s.length > 2);
  if (segs.length >= 3 && new Set(segs).size / segs.length < 0.5) return true;
  const words = text.split(/[\s、。！？]+/).filter(w => w.length > 0);
  if (words.length >= 4 && new Set(words).size / words.length < 0.3) return true;
  return false;
}

async function main() {
  const chunkFiles = fs.readdirSync(REC_DIR)
    .filter(f => f.startsWith(`audio-${SESSION_ID}-`) && /\.(webm|mp4|ogg|m4a)$/.test(f))
    .sort();
  console.log(`チャンク数: ${chunkFiles.length}`);

  // WebMヘッダー抽出
  const firstBuf = fs.readFileSync(path.join(REC_DIR, chunkFiles[0]));
  let webmHeader = null;
  if (firstBuf[0]===0x1a && firstBuf[1]===0x45 && firstBuf[2]===0xdf && firstBuf[3]===0xa3) {
    for (let i=0; i<firstBuf.length-3; i++) {
      if (firstBuf[i]===0x1f && firstBuf[i+1]===0x43 && firstBuf[i+2]===0xb6 && firstBuf[i+3]===0x75) {
        webmHeader = firstBuf.slice(0,i);
        console.log(`WebMヘッダー: ${webmHeader.length}bytes`);
        break;
      }
    }
  }

  const CHUNK_DURATION = 2 * 60;
  const allSegments = [];
  for (let ci=0; ci<chunkFiles.length; ci++) {
    const f = chunkFiles[ci];
    const fpath = path.join(REC_DIR, f);
    const fsize = fs.statSync(fpath).size;
    if (fsize < 1000) { console.log(`skip tiny: ${f}`); continue; }
    let sendPath = fpath, tmpFile = null;
    const chunkOffset = ci * CHUNK_DURATION;
    try {
      const buf = fs.readFileSync(fpath);
      const isComplete = buf[0]===0x1a && buf[1]===0x45 && buf[2]===0xdf && buf[3]===0xa3;
      if (!isComplete && webmHeader) {
        tmpFile = path.join(os.tmpdir(), `retranscribe-${ci}.webm`);
        fs.writeFileSync(tmpFile, Buffer.concat([webmHeader, buf]));
        sendPath = tmpFile;
      }
      const result = await groqClient.audio.transcriptions.create({
        file: fs.createReadStream(sendPath),
        model: 'whisper-large-v3',
        language: 'ja',
        prompt: 'はい。',
        response_format: 'verbose_json'
      });
      const segs = result.segments || [];
      let kept = 0;
      for (const seg of segs) {
        const text = seg.text?.trim();
        if (text && !isHallucination(text)) {
          allSegments.push({ start: chunkOffset + seg.start, end: chunkOffset + seg.end, text });
          kept++;
        }
      }
      console.log(`[${ci+1}/${chunkFiles.length}] ${f}: ${segs.length}セグメント, 保存${kept}件`);
    } catch(e) {
      console.error(`[${ci+1}/${chunkFiles.length}] ${f} エラー:`, e.message);
    } finally {
      if (tmpFile) fs.unlink(tmpFile, ()=>{});
    }
  }

  // 話者分離
  const SPEAKER_GAP = 2.0;
  const turns = [];
  let speaker = 'A', lastEnd = 0, texts = [];
  for (const seg of allSegments) {
    if (seg.start - lastEnd > SPEAKER_GAP && texts.length > 0) {
      turns.push({ speaker, text: texts.join(' ') });
      speaker = speaker==='A'?'B':'A';
      texts = [];
    }
    texts.push(seg.text);
    lastEnd = seg.end;
  }
  if (texts.length > 0) turns.push({ speaker, text: texts.join(' ') });

  const fullText = turns.map(t => `【話者${t.speaker}】${t.text}`).join('\n');
  console.log('\n=== 文字起こし結果 ===\n');
  console.log(fullText);
  console.log('\n=== セグメント数:', allSegments.length, '===');

  // ファイルに保存
  const outPath = path.join(os.tmpdir(), `retranscript-${SESSION_ID}.txt`);
  fs.writeFileSync(outPath, fullText, 'utf8');
  console.log(`\nファイル保存: ${outPath}`);
}

main().catch(console.error);
