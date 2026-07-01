import express from 'express';
import mongoose from 'mongoose';
import axios from 'axios';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json());

// =============================================
// 📦 MONGO DB CONNECTION
// =============================================
const MONGO_URI = process.env.MONGO_URL || process.env.DATABASE_URL;

if (!MONGO_URI) {
  console.error('❌ FATAL: MONGO_URL or DATABASE_URL is MISSING!');
  process.exit(1);
}

const connectDB = async (retries = 5, delay = 3000) => {
  for (let i = 0; i < retries; i++) {
    try {
      await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
      console.log('✅ MongoDB Connected Successfully!');
      return;
    } catch (err) {
      console.log(`⚠️ DB attempt ${i+1} failed. Retrying...`);
      if (i < retries - 1) await new Promise(res => setTimeout(res, delay));
      else { console.error('❌ DB Failed:', err.message); process.exit(1); }
    }
  }
};
connectDB();

// =============================================
// 📝 MONGO SCHEMA (Added: affiliate_link)
// =============================================
const campaignSchema = new mongoose.Schema({
  product_name: { type: String, required: true },
  country: { type: String, default: 'us' },
  affiliate_link: { type: String, default: '' }, // ✅ NEW FIELD
  status: { type: String, default: 'pending' },
  google_article: String,
  twitter_thread: String,
  linkedin_post: String,
  reddit_post: String,
  reels_script: String,
  meta_title: String,
  meta_description: String,
  trending_hook: String,
  error_log: String,
}, { timestamps: true });

const Campaign = mongoose.model('Campaign', campaignSchema);

// ========== TELEGRAM SETUP ==========
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function sendToMobile(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: text.substring(0, 4096),
      parse_mode: 'HTML'
    });
  } catch (e) { console.log('Telegram error:', e.message); }
}

// =============================================
// 🚀 GROQ API CALL (Direct Axios)
// =============================================
async function callGroq(messages, model = 'llama-3.1-8b-instant') {
  const url = 'https://api.groq.com/openai/v1/chat/completions';
  
  const response = await axios.post(url, {
    messages: messages,
    model: model,
    response_format: { type: "json_object" },
    temperature: 0.7,
  }, {
    headers: {
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    timeout: 60000,
  });

  return response.data;
}

async function callGroqWithRetry(messages, model = 'llama-3.1-8b-instant', maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await callGroq(messages, model);
    } catch (error) {
      console.log(`⚠️ Groq attempt ${i+1} failed: ${error.message}`);
      if (i === maxRetries - 1) throw error;
      await new Promise(res => setTimeout(res, 3000));
    }
  }
}

// =============================================
// 📥 STRING EXTRACTOR
// =============================================
function extractStringContent(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null) {
    if (value.content) return value.content;
    if (value.article) return value.article;
    if (value.body) return value.body;
    return JSON.stringify(value);
  }
  return String(value || '');
}

// =============================================
// ⚙️ THE MAIN AD-KILLER WORKER (WITH AFFILIATE LINK)
// =============================================
async function processCampaign(id) {
  try {
    await Campaign.findByIdAndUpdate(id, { status: 'processing' });
    const campaign = await Campaign.findById(id);
    if (!campaign) throw new Error('Campaign not found');

    console.log(`🔄 Killing ads for: ${campaign.product_name}`);
    const affiliateLink = campaign.affiliate_link || '';

    // STEP 1: SERPAPI
    const serpRes = await axios.get('https://serpapi.com/search.json', {
      params: {
        q: `best ${campaign.product_name} review 2026`,
        gl: campaign.country || 'us',
        api_key: process.env.SERPAPI_KEY,
        num: 5,
        include_people_also_ask: true
      },
      timeout: 15000
    });

    const peopleAlsoAsk = serpRes.data.people_also_ask || [];
    const snippets = serpRes.data.organic_results?.map(r => r.snippet).join(' ') || '';

    // STEP 2: TRENDING HOOK
    const hookResponse = await callGroqWithRetry([
      { role: 'system', content: 'Return ONLY valid JSON. {"hook": "..."}' },
      { role: 'user', content: `Based on: ${JSON.stringify(peopleAlsoAsk)}. What is the biggest complaint about ${campaign.product_name}? Write a 1-line hook.` }
    ]);
    const trendingHook = JSON.parse(hookResponse.choices[0].message.content).hook;

    // STEP 3: MEGA CONTENT (With Affiliate Link Instruction)
    const aiResponse = await callGroqWithRetry([
      { role: 'system', content: `Return ONLY valid JSON with EXACT keys:
        - "google_article": (HTML string)
        - "twitter_thread": (string)
        - "linkedin_post": (string)
        - "reddit_post": (string)
        - "reels_script": (string)
        - "meta_title": (string, max 60 chars)
        - "meta_description": (string, max 160 chars)
        All values must be strings.` },
      { role: 'user', content: `
        Product: ${campaign.product_name}
        Hook: "${trendingHook}"
        Competitor Data: ${snippets.substring(0, 3000)}
        Affiliate Link (Embed this naturally in all formats): ${affiliateLink || 'No affiliate link provided'}

        Instructions for the affiliate link:
        - If a link is provided, embed it naturally in the google_article (as a clickable HTML link), in the twitter_thread (as a call-to-action), in linkedin_post, and in reels_script.
        - Make it fit the context, e.g., "Grab your exclusive deal here [link]" or "Check out the official website [link]".
        - If no link is provided, just use generic "visit official website" text.

        Output Format:
        1. google_article: 1200-word HTML article. Include <h2> "Why Ads Lie".
        2. twitter_thread: 15 tweets (1/15 to 15/15).
        3. linkedin_post: 300-word professional post.
        4. reddit_post: "I tested ${campaign.product_name} for 30 days".
        5. reels_script: 60-second script (Scene 1-5).
        6. meta_title: Under 60 chars.
        7. meta_description: Under 160 chars.
      `}
    ], 'llama-3.1-8b-instant');

    const result = JSON.parse(aiResponse.choices[0].message.content);

    // STEP 4: Extract Strings
    const finalData = {
      google_article: extractStringContent(result.google_article),
      twitter_thread: extractStringContent(result.twitter_thread),
      linkedin_post: extractStringContent(result.linkedin_post),
      reddit_post: extractStringContent(result.reddit_post),
      reels_script: extractStringContent(result.reels_script),
      meta_title: extractStringContent(result.meta_title),
      meta_description: extractStringContent(result.meta_description),
    };

    // STEP 5: Save
    await Campaign.findByIdAndUpdate(id, {
      google_article: finalData.google_article,
      twitter_thread: finalData.twitter_thread,
      linkedin_post: finalData.linkedin_post,
      reddit_post: finalData.reddit_post,
      reels_script: finalData.reels_script,
      meta_title: finalData.meta_title,
      meta_description: finalData.meta_description,
      trending_hook: trendingHook,
      status: 'completed'
    });

    // STEP 6: Telegram
    await sendToMobile(`
🚀 <b>${campaign.product_name}</b> Ready!

🔥 <b>Hook:</b> ${trendingHook}

🐦 <b>Twitter Start:</b>
${finalData.twitter_thread.split('\n').slice(0, 3).join('\n')}...

🔗 <b>Affiliate Link:</b> ${affiliateLink || 'Not provided'}

📥 Dashboard se download karein.
    `);

    console.log(`✅ Campaign ${id} complete!`);

  } catch (error) {
    console.error('❌ Worker Error:', error);
    await Campaign.findByIdAndUpdate(id, { 
      status: 'failed', 
      error_log: error.message || 'Unknown error' 
    });
  }
}

// =============================================
// 🌐 EXPRESS ROUTES
// =============================================
app.post('/api/start', async (req, res) => {
  const { product, country, affiliateLink } = req.body; // ✅ Added affiliateLink
  if (!product) return res.status(400).json({ error: 'Product name required' });
  
  const newCampaign = new Campaign({
    product_name: product,
    country: country || 'us',
    affiliate_link: affiliateLink || '', // ✅ Save to DB
    status: 'pending'
  });
  const saved = await newCampaign.save();
  processCampaign(saved._id).catch(console.error);
  res.json({ success: true, id: saved._id, message: 'Started! Check in 2 mins.' });
});

app.get('/api/status/:id', async (req, res) => {
  try {
    const data = await Campaign.findById(req.params.id);
    if (!data) return res.status(404).json({ error: 'Not found' });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/download/:id', async (req, res) => {
  try {
    const data = await Campaign.findById(req.params.id);
    if (!data) return res.status(404).json({ error: 'Not found' });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/health', (req, res) => res.send('OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🔥 Ad-Killer (Groq Axios) running on port ${PORT}`));
