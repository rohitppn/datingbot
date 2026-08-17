// Audio transcription via Groq Whisper.
// Used for WhatsApp voice notes. Free tier: ~14k requests/day.
// Needs GROQ_API_KEY in .env. Get one free at https://console.groq.com/keys

import Groq from 'groq-sdk';
import { toFile } from 'groq-sdk';

const groq = process.env.GROQ_API_KEY
  ? new Groq({ apiKey: process.env.GROQ_API_KEY })
  : null;

export const transcriptionEnabled = !!groq;

// mimeType from Baileys audioMessage.mimetype is usually "audio/ogg; codecs=opus"
function pickExt(mimeType = '') {
  if (mimeType.includes('mp3') || mimeType.includes('mpeg')) return 'mp3';
  if (mimeType.includes('wav')) return 'wav';
  if (mimeType.includes('m4a') || mimeType.includes('mp4')) return 'm4a';
  if (mimeType.includes('webm')) return 'webm';
  return 'ogg'; // WhatsApp default
}

export async function transcribeAudio(buffer, mimeType) {
  if (!groq) throw new Error('GROQ_API_KEY not set');

  const ext = pickExt(mimeType);
  const file = await toFile(buffer, `audio.${ext}`);

  const res = await groq.audio.transcriptions.create({
    file,
    model: 'whisper-large-v3-turbo', // fast, cheap, good at Hindi/English
    response_format: 'text',
    temperature: 0
    // language omitted on purpose: autodetect handles Hinglish better
  });

  const text = typeof res === 'string' ? res : (res?.text || '');
  return text.trim();
}
