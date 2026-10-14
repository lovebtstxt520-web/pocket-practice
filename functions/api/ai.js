// Cloudflare Pages Function: POST /api/ai
// Settings (Cloudflare project, Variables and secrets): GEMINI_API_KEY (secret), GEMINI_MODEL (optional), GEMINI_FALLBACK_MODEL (optional)
// Optional backup from another company: ANTHROPIC_API_KEY (secret), CLAUDE_MODEL (optional, default claude-haiku-5-5)
//
// Request JSON: { mode: "receipt" | "wish" | "weekly", lang: "en" | "zh" | "th", image?: base64 jpeg (no data: prefix), summary?: string }
// Response 200 (receipt): { readable, amount, currency, merchant, category, items:[{name,price}], note }
// Response 200 (wish):    { item, price, currency, store, category, questions[], tip }
// Response 200 (weekly):  { headline, tips[] }
// Response error: { error: string }

const LANG = { en: 'English', zh: 'Traditional Chinese', th: 'Thai' };
const CATS = ['food', 'drink', 'groceries', 'transport', 'shopping', 'bills', 'health', 'fun', 'other'];

const SYSTEM = {
  receipt: [
    'You read photos of receipts, bills, price tags, menus with prices, or handwritten notes of cash spending, mostly in Bangkok, Thailand (text may be Thai, English or Chinese).',
    'Answer ONLY with a JSON object with keys:',
    'readable (boolean: false if there is no price you can read), amount (number: the TOTAL paid; if several items and no total, add them up), currency (3-letter code, default THB),',
    'merchant (short shop name, or empty string), category (one of: ' + CATS.join(', ') + '),',
    'items (array of up to 6 objects {name, price} for the main lines, empty if unclear), note (one short sentence, e.g. what you were unsure about, or empty).',
    'Never invent numbers you cannot see. If unsure about the total, give your best reading and say so in note.'
  ].join(' '),
  wish: [
    'You read a screenshot of an online shop product page or cart (Shopee, Lazada, TikTok Shop, Amazon and similar) or a photo of an item in a store.',
    'The user wants to pause before buying. Answer ONLY with a JSON object with keys:',
    'item (short product name), price (number, the price the user would pay; 0 if not visible), currency (3-letter code, default THB), store (shop or platform name, or empty),',
    'category (one of: ' + CATS.join(', ') + '),',
    'questions (array of exactly 3 short, kind, specific questions that help the user decide if they really need THIS item, e.g. whether they own something similar, how often they would use it),',
    'tip (one short sentence: a practical money tip for this kind of purchase, e.g. wait for a sale, check reviews, consider second-hand). Never shame the user.'
  ].join(' '),
  weekly: [
    'You are a friendly, practical money coach for someone who tracks their cash spending in Bangkok, Thailand.',
    'You get a short summary of their numbers. Answer ONLY with a JSON object with keys:',
    'headline (one short sentence about the most important pattern this week), tips (array of 2 or 3 short, concrete, kind suggestions based ONLY on the numbers given).',
    'Do not invent numbers. If there is very little data, say so kindly and suggest keeping logging.'
  ].join(' ')
};

export async function onRequestPost({ request, env }) {
  const key = env.GEMINI_API_KEY;
  const claudeKey = env.ANTHROPIC_API_KEY;
  if (!key && !claudeKey) return reply(500, { error: 'GEMINI_API_KEY is not set in Cloudflare.' });
  let body;
  try { body = await request.json(); } catch (e) { return reply(400, { error: 'Bad request.' }); }
  const mode = ['receipt', 'wish', 'weekly'].includes(body.mode) ? body.mode : null;
  if (!mode) return reply(400, { error: 'Unknown mode.' });
  const lang = LANG[body.lang] ? body.lang : 'en';

  const parts = [];
  if (mode === 'weekly') {
    if (!body.summary) return reply(400, { error: 'No summary.' });
    parts.push({ text: String(body.summary).slice(0, 4000) });
  } else {
    if (!body.image) return reply(400, { error: 'No image.' });
    parts.push({ inline_data: { mime_type: 'image/jpeg', data: body.image } });
  }
  parts.push({ text: 'IMPORTANT: write every sentence (note, questions, tip, headline, tips) and item names in ' + LANG[lang] + ', even if the photo is in another language. Keep shop and brand names as printed.' });

  // tried in order: main model, backup model, then the main model once more (busy spikes are often short)
  const main = env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
  const backup = env.GEMINI_FALLBACK_MODEL || 'gemini-3.8-flash';
  let queue = (main === backup ? [main, main, main] : [main, backup, main]).map((m) => ({ p: 'gemini', m }));
  // with a Claude key: Gemini once, then Claude (different servers, so a Gemini rush does not affect it), then Gemini backup
  if (claudeKey) queue = [{ p: 'gemini', m: main }, { p: 'claude', m: env.CLAUDE_MODEL || 'claude-haiku-5-5' }, { p: 'gemini', m: backup }];
  if (!key) queue = queue.filter((q) => q.p === 'claude');
  const started = Date.now();
  const deadline = started + 50000;
  const notes = [];
  let lowThink = true; // ask the model to think less so it answers faster

  for (let i = 0; i < queue.length; i++) {
    const left = deadline - Date.now();
    if (left < 3000) break;
    const q = queue[i];
    const limit = claudeKey ? (i < queue.length - 1 ? Math.min(left, q.p === 'claude' ? 25000 : 15000) : left)
      : (i === 0 ? Math.min(left, 30000) : i < queue.length - 1 ? Math.min(left, 12000) : left);
    try {
      let text = '';
      if (q.p === 'claude') {
        const content = [];
        parts.forEach((pt) => {
          if (pt.inline_data) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: pt.inline_data.data } });
          else content.push({ type: 'text', text: pt.text });
        });
        content.push({ type: 'text', text: 'Reply with the JSON object only, no other text.' });
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': claudeKey, 'anthropic-version': '2023-06-01' },
          signal: AbortSignal.timeout(limit),
          body: JSON.stringify({ model: q.m, max_tokens: 1024, system: SYSTEM[mode], messages: [{ role: 'user', content }] })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          const msg = (data.error && data.error.message) || 'request failed';
          console.error('Claude error', q.m, res.status, msg);
          notes.push(q.m + ' (' + res.status + '): ' + String(msg).slice(0, 90));
          continue;
        }
        text = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
      } else {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${q.m}:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          signal: AbortSignal.timeout(limit),
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: SYSTEM[mode] }] },
            contents: [{ parts }],
            generationConfig: Object.assign({ responseMimeType: 'application/json', temperature: 0.2 },
              lowThink ? { thinkingConfig: { thinkingLevel: 'low' } } : {})
          })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          const msg = (data.error && data.error.message) || 'request failed';
          console.error('Gemini error', q.m, res.status, msg);
          if (res.status === 400 && lowThink && /think/i.test(msg)) { lowThink = false; i--; continue; } // setting not accepted: retry without it
          notes.push(q.m + ' (' + res.status + '): ' + String(msg).slice(0, 90));
          if (res.status === 429 || res.status === 503 || res.status === 500) { await sleep(claudeKey ? 300 : 1500); continue; }
          if (claudeKey) continue; // let Claude try anyway
          break;
        }
        const cand = data.candidates && data.candidates[0];
        text = cand && cand.content && cand.content.parts
          ? cand.content.parts.filter((p) => p.text && !p.thought).map((p) => p.text).join('') : '';
      }
      if (!text) { notes.push(q.m + ': no text'); continue; }
      let o;
      try { o = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); }
      catch (e) { notes.push(q.m + ': unreadable answer'); continue; }
      const out = clean(mode, o);
      out.by = q.m; // which model answered (handy when testing)
      return reply(200, out);
    } catch (e) {
      console.error('ai failed', q.m, e && e.name, e && e.message);
      notes.push(q.m + ': ' + (e && e.name === 'TimeoutError' ? 'no answer in ' + Math.round((Date.now() - started) / 1000) + 's' : String((e && e.message) || e).slice(0, 100)));
    }
  }
  return reply(502, { error: notes.join(' | ') || 'Gemini is busy. Try again in a moment.' });
}

export async function onRequest() { return reply(405, { error: 'Use POST.' }); }

function num(v) { const n = Number(String(v).replace(/[^0-9.\-]/g, '')); return isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : 0; }
function str(v, n) { return String(v == null ? '' : v).slice(0, n); }
function cat(v) { return CATS.includes(v) ? v : 'other'; }
function cur(v) { const c = String(v || '').toUpperCase(); return /^[A-Z]{3}$/.test(c) ? c : 'THB'; }
function clean(mode, o) {
  if (mode === 'receipt') return {
    readable: o.readable !== false && num(o.amount) > 0,
    amount: num(o.amount), currency: cur(o.currency), merchant: str(o.merchant, 60), category: cat(o.category),
    items: (Array.isArray(o.items) ? o.items : []).slice(0, 6).map((x) => ({ name: str(x && x.name, 60), price: num(x && x.price) })).filter((x) => x.name),
    note: str(o.note, 200)
  };
  if (mode === 'wish') return {
    item: str(o.item, 80), price: num(o.price), currency: cur(o.currency), store: str(o.store, 40), category: cat(o.category),
    questions: (Array.isArray(o.questions) ? o.questions : []).map((q) => str(q, 160)).filter(Boolean).slice(0, 3),
    tip: str(o.tip, 200)
  };
  return { headline: str(o.headline, 200), tips: (Array.isArray(o.tips) ? o.tips : []).map((q) => str(q, 200)).filter(Boolean).slice(0, 3) };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function reply(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
