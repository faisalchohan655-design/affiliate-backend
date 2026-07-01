import express from 'express';
import mongoose from 'mongoose';
import axios from 'axios';
import OpenAI from 'openai';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json());

// =============================================
// 📦 MONGO DB CONNECTION (No ECONNREFUSED)
// =============================================
const MONGO_URI = process.env.MONGO_URL || process.env.DATABASE_URL; // Railway MongoDB plugin se MONGO_URL aata hai

if (!MONGO_URI) {
  console.error('❌ FATAL: MONGO_URL or DATABASE_URL is MISSING!');
  console.error('👉 Please add MongoDB plugin in Railway or set MONGO_URL manually.');
  process.exit(1);
}

// Retry logic ke saath connect
const connectDB = async (retries = 5, delay = 3000) => {
  for (let i = 0; i < retries; i++) {
    try {
      await mongoose.connect(MONGO_URI, {
        useNewUrlParser: true,
        useUnifiedTopology: true,
        serverSelectionTimeoutMS: 5000,
      });
      console.log('✅ MongoDB Connected Successfully!');
      return;
    } catch (err) {
      console.log(`⚠️ DB attempt ${i+1} failed. Retrying in ${delay/1000}s...`);
      if (i < retries - 1) await new Promise(res => setTimeout(res, delay));
      else {
        console.error('❌ All DB attempts failed:', err.message);
        process.exit(1);
      }
    }
  }
};
connectDB();

// =============================================
// 📝 MONGO SCHEMA (Clean & Simple)
// =============================================
const campaignSchema = new mongoose.Schema({
  product_name: { type: String, required: true },
  country: { type: String, default: 'us' },
  status: { type: String, default: 'pending' }, // pending, processing, completed, failed
  google_article: String,
  twitter_thread: String,
  linkedin_post: String,
  reddit_post: String,
  reels_script: String,
  meta_title: String,
  meta_description: String,
  trending_hook: String,
  error_log: String,
}, { timestamps: true }); // createdAt aur updatedAt auto add ho jayenge

const Campaign = mongoose.model('Campaign', campaignSchema);

// ========== TELEGRAM SETUP (Optional) ==========
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
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
// ⚙️ THE MAIN AD-KILLER WORKER
// =============================================
async function processCampaign(id) {
  try {
    // Status update
    await Campaign.findByIdAndUpdate(id, { status: 'processing' });
    const campaign = await Campaign.findById(id);
    if (!campaign) throw new Error('Campaign not found');

    console.log(`🔄 Killing ads for: ${campaign.product_name}`);

    // STEP 1: SERPAPI Fetch
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

    // STEP 2: AI - Trending Hook
    const hookCompletion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: 'Return ONLY JSON {"hook": "..."}' },
        { role: 'user', content: `Based on these queries: ${JSON.stringify(peopleAlsoAsk)}. What is the single biggest complaint or question about ${campaign.product_name} right now? Write a 1-line aggressive hook.` }
      ],
      response_format: { type: "json_object" }
    });
    const trendingHook = JSON.parse(hookCompletion.choices[0].message.content).hook;

    // STEP 3: AI - Mega Content Generate
    const aiResponse = await openai.chat.completions.create({
      model: 'gpt-4-turbo-preview',
      messages: [
        { role: 'system', content: 'Return ONLY valid JSON. Keys: google_article, twitter_thread, linkedin_post, reddit_post, reels_script, meta_title, meta_description.' },
        { role: 'user', content: `
          Product: ${campaign.product_name}
          Trending Hook: "${trendingHook}"
          Competitor Snippets: ${snippets}

          Instructions:
          1. google_article: 2000 words HTML. Add <h2> "Why Ads Won't Tell You About ${campaign.product_name}".
          2. twitter_thread: 20 tweets (1/20 to 20/20). Start with the hook.
          3. linkedin_post: 400 words professional style.
          4. reddit_post: "I tested ${campaign.product_name} for 30 days" - totally unbiased.
          5. reels_script: 60-second Instagram Reel script. Scene 1 to Scene 5. Add text overlays.
          6. meta_title: Under 60 chars.
          7. meta_description: Under 160 chars.
        `}
      ],
      response_format: { type: "json_object" },
      temperature: 0.8
    });

    const result = JSON.parse(aiResponse.choices[0].message.content);

    // STEP 4: MongoDB mein Save (Bohat easy)
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

    // STEP 5: Telegram Notification
    await sendToMobile(`
🚀 <b>${campaign.product_name}</b> Ready!

🔥 <b>Hook:</b> ${trendingHook}

🐦 <b>Twitter Start:</b>
${result.twitter_thread.split('\n').slice(0, 3).join('\n')}...

📥 Download from Dashboard.
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
  
  // Background mein process karein
  processCampaign(saved._id).catch(console.error);
  
  res.json({ success: true, id: saved._id, message: 'Started! Check dashboard in 2 mins.' });
});

app.get('/api/status/:id', async (req, res) => {
  try {
    const data = await Campaign.findById(req.params.id);
    if (!data) return res.status(404).json({ error: 'Not found' });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/download/:id', async (req, res) => {
  try {
    const data = await Campaign.findById(req.params.id);
    if (!data) return res.status(404).json({ error: 'Not found' });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/health', (req, res) => res.send('OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🔥 Ad-Killer Backend running on port ${PORT}`));
