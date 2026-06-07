import 'dotenv/config';
import {
  getActiveUsers, getMessagesForDate,
  saveDailySummary, getRecentSummaries,
  updateUserProfile, cleanupOldMessages
} from '../db.js';
import { summarizeDay, updateProfile } from '../claude.js';

function yesterdayISO() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}

export async function runDailyMemoryUpdate() {
  const date = yesterdayISO();
  const users = getActiveUsers();
  console.log(`📊 Processing ${users.length} active users for ${date}`);

  let processed = 0;
  let summarized = 0;
  let profileUpdated = 0;

  for (const user of users) {
    try {
      // 1. Summarize yesterday's chat
      const messages = getMessagesForDate(user.phone, date);
      if (messages.length >= 2) {
        const summary = await summarizeDay(messages);
        if (summary) {
          saveDailySummary(user.phone, date, summary);
          summarized++;
        }
      }

      // 2. Update profile based on last 7 days of summaries
      const summaries = getRecentSummaries(user.phone, 7);
      if (summaries.length > 0) {
        let currentProfile = {};
        try {
          currentProfile = JSON.parse(user.profile_json || '{}');
        } catch {}

        const updated = await updateProfile(currentProfile, summaries);
        updateUserProfile(user.phone, updated);
        profileUpdated++;
      }

      processed++;
      // Rate limit: ~10 users/sec to avoid Claude API limits
      await new Promise(r => setTimeout(r, 100));
    } catch (err) {
      console.error(`Failed for ${user.phone}:`, err.message);
    }
  }

  // 3. Cleanup messages older than 30 days
  const deleted = cleanupOldMessages(30);

  console.log(`✅ Memory update done. Processed: ${processed}, Summarized: ${summarized}, Profiles updated: ${profileUpdated}, Old messages deleted: ${deleted}`);
}

// Allow running standalone: `npm run summarize`
if (import.meta.url === `file://${process.argv[1]}`) {
  runDailyMemoryUpdate()
    .then(() => process.exit(0))
    .catch(err => {
      console.error(err);
      process.exit(1);
    });
}
