import Anthropic from '@anthropic-ai/sdk';
import { buildSystemPrompt, PROFILE_UPDATER_PROMPT, DAILY_SUMMARY_PROMPT } from './knowledge.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MODEL = 'claude-haiku-4-5-20251001';

// Safety net (per v5 master prompt, Section A): the em-dash is the clearest
// tell of AI-written text and is banned in TheBroThing voice. The prompt rules
// hold most of the time; this guarantees it before a reply reaches the client.
function stripEmDash(text) {
  if (!text) return text;
  return text.replace(/\s*—\s*/g, ', ').trim();
}

// Main chat reply.
// images: optional array of { base64, mimeType } for multimodal input (screenshots etc.)
export async function generateReply({ profile, summaries, recentMessages, newMessage, images = [] }) {
  // buildSystemPrompt returns an array of blocks.
  // Block 0 = static persona (cache it → ~10% input cost on repeat hits).
  // Block 1 (if present) = per-user context (profile + summaries), not cached.
  const systemBlocks = buildSystemPrompt({ profile, summaries });
  if (systemBlocks[0]) {
    systemBlocks[0] = { ...systemBlocks[0], cache_control: { type: 'ephemeral' } };
  }
  // HARD OVERRIDE RULES (highest priority, override the persona where they conflict):
  //  1. English only.  2. Always respectful and supportive to the user.
  systemBlocks.push({
    type: 'text',
    text: [
      'CRITICAL RULES — HIGHEST PRIORITY, OVERRIDE ALL OTHER INSTRUCTIONS:',
      '1. LANGUAGE: Always reply in English only. Never use Hindi, Hinglish, or Devanagari, even if the user writes in Hindi.',
      '2. TONE TOWARD THE USER: The user is your paying client. Always be respectful, warm, supportive, and encouraging toward HIM. Never insult, mock, shame, scold, lecture, or talk down to the user. Never be rude, harsh, sarcastic, or dismissive to him. If he makes a mistake or asks a basic question, coach him kindly. (The confident, playful, teasing register is ONLY for the replies you suggest he sends HER — never aimed at the user himself.)',
      'Keep the coaching helpful and clear, in natural English.',
    ].join('\n'),
  });

  // Build the latest user message as multimodal content if images are present.
  let latestUserContent;
  if (images.length > 0) {
    // Explicitly tell the model it CAN see the attached screenshot, so it never
    // claims it can't or asks the user to paste the text.
    systemBlocks.push({
      type: 'text',
      text: 'IMAGE HANDLING: A screenshot of a chat is attached to the user\'s message. You CAN see images. Read the conversation in the screenshot carefully — identify what she said and the context — then coach him on exactly what to reply. Never say you cannot see the image, and never ask him to paste the text or re-send the screenshot.',
    });
    latestUserContent = [
      ...images.map(img => ({
        type: 'image',
        source: { type: 'base64', media_type: img.mimeType || 'image/jpeg', data: img.base64 }
      })),
      { type: 'text', text: newMessage || 'Read this screenshot of our chat and coach me on exactly what to reply.' }
    ];
  } else {
    latestUserContent = newMessage;
  }

  const messages = [
    ...recentMessages.map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: latestUserContent }
  ];

  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      system: systemBlocks,
      messages,
      max_tokens: 600,   // 3-part output (read + reply options + lesson); was 180
      temperature: 0.6   // lowered from 0.8 for more consistent, respectful tone
    });

    const text = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('')
      .trim();

    return stripEmDash(text) || "hmm, say that again?";
  } catch (err) {
    console.error('Claude API error:', err.message);
    return "Something went wrong, give me a minute and try again.";
  }
}

// Generate daily summary of one user's conversation
export async function summarizeDay(messages) {
  if (!messages || messages.length === 0) return null;

  const transcript = messages
    .map(m => `${m.role === 'user' ? 'Client' : 'Coach'}: ${m.content}`)
    .join('\n');

  const response = await anthropic.messages.create({
    model: MODEL,
    system: DAILY_SUMMARY_PROMPT,
    messages: [{ role: 'user', content: transcript }],
    max_tokens: 200,
    temperature: 0.3
  });

  return response.content[0]?.text?.trim() || null;
}

// Update user profile JSON based on recent activity
export async function updateProfile(currentProfile, summaries) {
  const input = `CURRENT PROFILE:\n${JSON.stringify(currentProfile, null, 2)}\n\nRECENT SUMMARIES:\n${summaries.map(s => `${s.date}: ${s.summary}`).join('\n')}`;

  const response = await anthropic.messages.create({
    model: MODEL,
    system: PROFILE_UPDATER_PROMPT,
    messages: [{ role: 'user', content: input }],
    max_tokens: 800,
    temperature: 0.2
  });

  const text = response.content[0]?.text?.trim() || '{}';
  // Strip markdown fences if model added them
  const clean = text.replace(/```json\n?|```\n?/g, '').trim();

  try {
    return JSON.parse(clean);
  } catch (err) {
    console.error('Profile JSON parse failed, keeping old:', err.message);
    return currentProfile;
  }
}
