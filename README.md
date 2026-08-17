# Dating Coach Bot — Arunav

WhatsApp dating coach bot powered by Claude Haiku, with Razorpay payment gating, Google Sheets logging, and 30-day per-user memory.

## Architecture

```
Instagram Ad → Landing Page → Razorpay → Webhook → SQLite + Sheet
                                                        ↓
                                              wa.me redirect
                                                        ↓
                                          User WhatsApp → Baileys
                                                        ↓
                              Memory (profile + summaries + recent)
                                                        ↓
                                                   Claude Haiku
                                                        ↓
                                            Reply via Baileys
```

## Quick start

### 1. Install
```bash
npm install
cp .env.example .env
# Fill in .env with your keys
```

### 2. Get API keys
- **Anthropic**: https://console.anthropic.com → API Keys
- **Razorpay**: Dashboard → Settings → API Keys + Webhooks
- **Google Sheets**: Cloud Console → Service Account → JSON key. Share your sheet with the service account email.

### 3. Landing page integration
On your existing landing page, when creating the Razorpay order, include the user's phone in `notes`:

```javascript
const order = await razorpay.orders.create({
  amount: 99900, // 999 INR in paisa
  currency: 'INR',
  notes: {
    phone: userPhone,    // REQUIRED — used to match WhatsApp
    name: userName,
    email: userEmail
  }
});
```

After successful payment, redirect to:
```
https://wa.me/<YOUR_BOT_NUMBER>?text=Hi%20Arunav
```

### 4. Run locally
```bash
npm start
```

On first run, scan the QR code with your bot's WhatsApp number (NOT your personal one — get a dedicated number).

The auth/ folder will save the session — don't delete it or you'll need to re-scan.

### 5. Test the flow
```bash
# Grant yourself access manually for testing
curl -X POST http://localhost:3000/api/user/grant \
  -H "Content-Type: application/json" \
  -d '{"phone":"919876543210","name":"Test","days":30,"secret":"YOUR_RAZORPAY_WEBHOOK_SECRET"}'

# Then message the bot from that phone on WhatsApp
```

### 6. Deploy to Railway
```bash
git init && git add . && git commit -m "initial"
# Push to GitHub
# Connect repo on railway.app
# Add environment variables (copy from .env)
# Add 2 volumes:
#   - /app/auth (5GB) for WhatsApp session
#   - /app/data (1GB) for SQLite
```

After deploy:
1. Check Railway logs for QR code on first boot.
2. Scan with bot's WhatsApp.
3. Set Razorpay webhook URL to: `https://<your-app>.railway.app/webhook/razorpay`
4. Subscribe to events: `payment.captured`, `order.paid`

## File structure

```
src/
  server.js              ← Express + cron + bot launcher
  bot.js                 ← Baileys WhatsApp socket
  claude.js              ← Claude API wrapper
  knowledge.js           ← Arunav system prompt (EDIT THIS!)
  db.js                  ← SQLite schema and queries
  sheets.js              ← Google Sheets sync
  jobs/
    dailyMemoryUpdate.js ← Nightly summarizer + profile updater
auth/                    ← Baileys session (gitignored)
data/                    ← SQLite db (gitignored)
```

## Customizing the bot voice

Edit `src/knowledge.js` → `ARUNAV_PERSONA`. The example exchanges are the most important part — add 8-15 real examples of how Arunav actually replies. Each example teaches Claude better than any rule.

## Memory model

Each user has 3 layers of memory:
1. **User profile** — JSON of facts (name, situation, key people, patterns). Updated nightly.
2. **Daily summaries** — last 7 days of 2-3 sentence summaries. Updated nightly.
3. **Recent messages** — last 20 messages verbatim. Real-time.

All 3 are sent to Claude on every message. Total context: ~2-4k tokens.

## Cost estimate (500 active users)

- Per chat message: ~₹0.05-0.10 (Haiku)
- Nightly memory job: ~₹3,000/month
- Railway hosting: ₹500/month
- **Total: ~₹5,000-8,000/month at full load**

## Important warnings

⚠️ **Baileys is unofficial.** Meta can ban your number. Mitigations baked in:
- 2-5 sec random reply delays
- Marks messages as read normally
- Shows typing indicator
- Never sends first

If you scale past 500-1000 users, switch to WhatsApp Cloud API (official).

⚠️ **Use a dedicated WhatsApp number.** Never your personal number.

⚠️ **Phone matching is critical.** If Razorpay collects "+91 98765 43210" but your DB stores "919876543210", lookup fails. The `normalizePhone()` function handles this — test it with your formats.

## Troubleshooting

**QR keeps appearing** → auth/ folder isn't persisted. Check Railway volume mount.
**"Please complete payment" loop** → phone mismatch between Razorpay notes and WhatsApp JID. Add `console.log(phone)` in webhook + bot to compare.
**Empty replies** → check ANTHROPIC_API_KEY and credit balance.
**Sheets not updating** → service account needs Editor access on the sheet.
