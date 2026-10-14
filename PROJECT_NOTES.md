# Pocket Coach (rehearsal build, NOT for submission)
Cash spending tracker + "want list" cool-off before online purchases + weekly AI coach.
Stack: static index.html (no build step) + Cloudflare Pages Function functions/api/ai.js (Gemini). qrcode.js = qrcode-generator library (MIT) for the share QR.
Env: GEMINI_API_KEY (secret), optional GEMINI_MODEL (default gemini-3.5-flash-lite), GEMINI_FALLBACK_MODEL (default gemini-3.8-flash). Optional ANTHROPIC_API_KEY (secret) adds Claude (CLAUDE_MODEL, default claude-haiku-5-5) as the second try.
API: POST /api/ai {mode: receipt|wish|weekly, lang: en|zh|th, image?: base64 jpeg, summary?: text}
  receipt -> {readable, amount, currency, merchant, category, items[{name,price}], note}
  wish    -> {item, price, currency, store, category, questions[3], tip}
  weekly  -> {headline, tips[]}
Model order: main -> backup -> main again; main gets up to 30s; asks for low thinking, drops it if the model rejects it.
Storage (localStorage): pc_exp, pc_wish, pc_coach, pc_lang, pc_theme, pc_wage. Categories: food, drink, groceries, transport, shopping, bills, health, fun, other.
Event day: rebuild from a blank project. Do not deploy this one as the entry.
