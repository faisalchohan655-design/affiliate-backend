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
// 🚀 GROQ API CALL (Direct Axios - No SDK)
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
    timeout: 45000, // 45 second timeout
  });

  return response.data;
}

async function callGroqWithRetry(messages, model, maxRetries = 3) {
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

    // STEP 3: MEGA CONTENT
    const aiResponse = await callGroqWithRetry([
      { role: 'system', content: 'Return ONLY valid JSON. Keys: google_article, twitter_thread, linkedin_post, reddit_post, reels_script, meta_title, meta_description.' },
      { role: 'user', content: `
        Product: ${campaign.product_name}
        Hook: "${trendingHook}"
        Data: ${snippets}

        Output:
        1. google_article: 1200 words HTML. Add <h2> "Why Ads Lie".
        2. twitter_thread: 15 tweets (1/15 to 15/15).
        3. linkedin_post: 300 words professional.
        4. reddit_post: "I tested ${campaign.product_name} for 30 days" - neutral.
        5. reels_script: 60-second script (Scene 1-5).
        6. meta_title: Under 60 chars.
        7. meta_description: Under 160 chars.
      `}
    ]);

    const result = JSON.parse(aiResponse.choices[0].message.content);

    // STEP 4: Save
    await Campaign.findByIdAndUpdate(id, {
      google_article: result.google_article,
      twitter_thread: result.twitter_thread,
      linkedin_post: result.linkedin_post,
      reddit_post: result.reddit_post,
      reels_script: result.reels_script,
      meta_title: result.meta_title,
      meta_description: result.meta_description,
      trending_hook: trendingHook,
      status: 'completed'
    });

    // STEP 5: Telegram
    await sendToMobile(`
🚀 <b>${campaign.product_name}</b> Ready!

🔥 <b>Hook:</b> ${trendingHook}

🐦 <b>Twitter Start:</b>
${result.twitter_thread.split('\n').slice(0, 3).join('\n')}...

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
