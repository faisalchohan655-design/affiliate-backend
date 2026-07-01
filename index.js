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
// 📝 MONGO SCHEMA
// =============================================
const campaignSchema = new mongoose.Schema({
  product_name: { type: String, required: true },
  country: { type: String, default: 'us' },
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
    timeout: 60000, // 60 second timeout
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
// 📥 STRING EXTRACTOR (Groq se object aaye toh handle kare)
// =============================================
function extractStringContent(value, fieldName) {
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null) {
    // Agar object hai toh pehle content, article, ya body nikaalein
    if (value.content) return value.content;
    if (value.article) return value.article;
    if (value.body) return value.body;
    // Agar kuch nahi mila toh poori object ko string bana dein
    return JSON.stringify(value);
  }
  return String(value || '');
}

// =============================================
// ⚙️ THE MAIN AD-KILLER WORKER
// =============================================
async function processCampaign(id) {
  try {
    await Campaign.findByIdAndUpdate(id, { status: 'processing' });
    const campaign = await Campaign.findById(id);
    if (!campaign) throw new Error('Campaign not found');

    console.log(`🔄 Killing ads for: ${campaign.product_name}`);

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

    // STEP 3: MEGA CONTENT (Strict Prompt)
    const aiResponse = await callGroqWithRetry([
      { role: 'system', content: `Return ONLY valid JSON with EXACT keys:
        - "google_article": (MUST be a plain HTML string, NOT an object. Example: "<h1>Title</h1><p>Content...</p>")
        - "twitter_thread": (MUST be a plain string, tweets separated by newline)
        - "linkedin_post": (MUST be a plain string)
        - "reddit_post": (MUST be a plain string)
        - "reels_script": (MUST be a plain string)
        - "meta_title": (plain string, max 60 chars)
        - "meta_description": (plain string, max 160 chars)
        All values must be strings, NOT objects.` },
      { role: 'user', content: `
        Product: ${campaign.product_name}
        Hook: "${trendingHook}"
        Competitor Data: ${snippets.substring(0, 3000)}

        Generate:
        1. google_article: 1200-word HTML article as a SINGLE STRING. Include <h2> "Why Ads Lie" and <h3> sections.
        2. twitter_thread: 15 tweets as a SINGLE STRING (1/15 to 15/15).
        3. linkedin_post: 300-word professional post as a SINGLE STRING.
        4. reddit_post: "I tested ${campaign.product_name} for 30 days" as a SINGLE STRING.
        5. reels_script: 60-second script (Scene 1-5) as a SINGLE STRING.
        6. meta_title: Under 60 chars.
        7. meta_description: Under 160 chars.

        IMPORTANT: All 7 values MUST be strings. Do NOT use objects.` }
    ], 'llama-3.1-8b-instant');

    const result = JSON.parse(aiResponse.choices[0].message.content);

    // STEP 4: ✅ EXTRACT STRINGS (Agar object aaya toh handle kar lo)
    const finalData = {
      google_article: extractStringContent(result.google_article, 'google_article'),
      twitter_thread: extractStringContent(result.twitter_thread, 'twitter_thread'),
      linkedin_post: extractStringContent(result.linkedin_post, 'linkedin_post'),
      reddit_post: extractStringContent(result.reddit_post, 'reddit_post'),
      reels_script: extractStringContent(result.reels_script, 'reels_script'),
      meta_title: extractStringContent(result.meta_title, 'meta_title'),
      meta_description: extractStringContent(result.meta_description, 'meta_description'),
    };

    // STEP 5: Save to MongoDB
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
  const { product, country } = req.body;
  if (!product) return res.status(400).json({ error: 'Product name required' });
  
  const newCampaign = new Campaign({
    product_name: product,
    country: country || 'us',
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
