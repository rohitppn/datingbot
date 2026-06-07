// Local REPL for testing Arunav's replies without WhatsApp, Sheets, or the DB.
// Usage from project root:
//   node src/chat.js
//
// Ctrl+C to quit. History is in-memory only — nothing is saved.

import 'dotenv/config';
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { generateReply } from './claude.js';
import { transcribeAudio, transcriptionEnabled } from './transcribe.js';

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('❌ ANTHROPIC_API_KEY missing from .env');
  process.exit(1);
}

// Optional: pass a fake profile via CLI arg for testing memory behavior.
// e.g. node src/chat.js '{"name":"Rohit","city":"Delhi","current_situation":"dating Priya since 2 weeks"}'
let profile = {};
if (process.argv[2]) {
  try { profile = JSON.parse(process.argv[2]); }
  catch { console.error('⚠️  profile arg is not valid JSON, ignoring'); }
}

const history = [];
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

const MIME_BY_EXT = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp'
};

console.log('💬 local chat with arunav (ctrl+c to exit)');
console.log('   commands:');
console.log('     /img <path> [optional caption]  — send a screenshot');
console.log('     /voice <path>                   — send an audio file (needs GROQ_API_KEY)');
if (Object.keys(profile).length) console.log('   profile:', profile);
console.log('');

async function callClaude(text, images = []) {
  const t0 = Date.now();
  const reply = await generateReply({
    profile,
    summaries: [],
    recentMessages: history,
    newMessage: text,
    images
  });
  const ms = Date.now() - t0;
  const userStored = images.length ? `[image] ${text}` : text;
  history.push({ role: 'user', content: userStored });
  history.push({ role: 'assistant', content: reply });
  console.log(`arunav (${ms}ms): ${reply}\n`);
}

const ask = () => rl.question('you: ', async (raw) => {
  const input = raw.trim();
  if (!input) return ask();

  try {
    if (input.startsWith('/img ')) {
      const rest = input.slice(5).trim();
      const [filePath, ...captionParts] = rest.split(/\s+/);
      const caption = captionParts.join(' ');
      const abs = path.resolve(filePath);
      if (!fs.existsSync(abs)) { console.log('file not found:', abs); return ask(); }
      const ext = path.extname(abs).toLowerCase();
      const mimeType = MIME_BY_EXT[ext];
      if (!mimeType) { console.log('unsupported image type:', ext); return ask(); }
      const base64 = fs.readFileSync(abs).toString('base64');
      await callClaude(caption || 'read this screenshot and coach me on what to reply', [{ base64, mimeType }]);
    } else if (input.startsWith('/voice ')) {
      if (!transcriptionEnabled) { console.log('GROQ_API_KEY not set in .env'); return ask(); }
      const abs = path.resolve(input.slice(7).trim());
      if (!fs.existsSync(abs)) { console.log('file not found:', abs); return ask(); }
      const buffer = fs.readFileSync(abs);
      const transcript = await transcribeAudio(buffer, 'audio/' + path.extname(abs).slice(1));
      console.log(`   (transcribed: ${transcript})`);
      await callClaude(transcript);
    } else {
      await callClaude(input);
    }
  } catch (err) {
    console.error('error:', err.message);
  }
  ask();
});

ask();
