import express from 'express';
import pkg from 'pg';
const { Pool } = pkg;
import axios from 'axios';
import OpenAI from 'openai';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json());

// =============================================
// 🚨 FIX 1: Database URL Check (Crash se bachayega)
// =============================================
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('❌ FATAL ERROR: DATABASE_URL environment variable is MISSING!');
  console.error('👉 Please add PostgreSQL plugin in Railway or set DATABASE_URL manually.');
  process.exit(1); // Crash intentionally taki Railway logs mein clear dikhe
}

// =============================================
// 🚨 FIX 2: Pool with Retry & SSL
// =============================================
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 5000,
  max: 5
});

// ========== OPENAI & TELEGRAM SETUP ==========
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// ========== TELEGRAM SENDER ==========
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
// 🚨 FIX 3: Database Init with RETRY (3 attempts)
// =============================================
async function initDB(retries = 3, delay = 2000) {
  for (let i = 0; i < retries; i++) {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS campaigns (
          id SERIAL PRIMARY KEY,
          product_name TEXT NOT NULL,
          country TEXT DEFAULT 'us',
          status TEXT DEFAULT 'pending',
          google_article TEXT,
          twitter_thread TEXT,
          linkedin_post TEXT,
          reddit_post TEXT,
          reels_script TEXT,
          meta_title TEXT,
          meta_description TEXT,
          trending_hook TEXT,
          error_log TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);
      console.log('✅ Database Table Ready');
      return;
    } catch (err) {
      console.log(`⚠️ DB Connection attempt ${i + 1} failed. Retrying in ${delay/1000}s...`);
      if (i < retries - 1) {
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        console.error('❌ All DB connection attempts failed:', err.message);
        process.exit(1);
      }
    }
  }
}
initDB();

// ========== THE MAIN AD-KILLER WORKER ==========
async function processCampaign(id) {
  try {
    await pool.query('UPDATE campaigns SET status = $1 WHERE id = $2', ['processing', id]);
    const { rows } = await pool.query('SELECT * FROM campaigns WHERE id = $1', [id]);
    const campaign = rows[0];
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

    // STEP 2: Trending Hook
    const hookCompletion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: 'Return ONLY JSON {"hook": "..."}' },
        { role: 'user', content: `Based on these queries: ${JSON.stringify(peopleAlsoAsk)}. What is the single biggest complaint or question about ${campaign.product_name} right now? Write a 1-line aggressive hook.` }
      ],
      response_format: { type: "json_object" }
    });
    const trendingHook = JSON.parse(hookCompletion.choices[0].message.content).hook;

    // STEP 3: AI Content Generation
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

    // STEP 4: Save to Database
    await pool.query(`
      UPDATE campaigns SET
        google_article = $1, twitter_thread = $2, linkedin_post = $3,
        reddit_post = $4, reels_script = $5, meta_title = $6,
        meta_description = $7, trending_hook = $8, status = 'completed'
      WHERE id = $9
    `, [
      result.google_article, result.twitter_thread, result.linkedin_post,
      result.reddit_post, result.reels_script, result.meta_title,
      result.meta_description, trendingHook, id
    ]);

    // STEP 5: Telegram Notification
    await sendToMobile(`
🚀 <b>${campaign.product_name}</b> Ready!

🔥 <b>Hook:</b> ${trendingHook}

🐦 <b>Twitter Start:</b>
${result.twitter_thread.split('\n').slice(0, 3).join('\n')}...

📥 Download full content from Dashboard.
    `);

    console.log(`✅ Campaign ${id} complete!`);

  } catch (error) {
    console.error('❌ Worker Error:', error);
    await pool.query('UPDATE campaigns SET status = $1, error_log = $2 WHERE id = $3', 
      ['failed', error.message || 'Unknown error', id]);
  }
}

// ========== EXPRESS ROUTES ==========
app.post('/api/start', async (req, res) => {
  const { product, country } = req.body;
  if (!product) return res.status(400).json({ error: 'Product name required' });
  
  const { rows } = await pool.query(
    'INSERT INTO campaigns (product_name, country) VALUES ($1, $2) RETURNING id',
    [product, country || 'us']
  );
  const id = rows[0].id;
  
  processCampaign(id).catch(console.error);
  res.json({ success: true, id, message: 'Started. Check Dashboard in 2 mins!' });
});

app.get('/api/status/:id', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM campaigns WHERE id = $1', [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
  res.json(rows[0]);
});

app.get('/api/download/:id', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM campaigns WHERE id = $1', [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
  res.json(rows[0]);
});

app.get('/health', (req, res) => res.send('OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🔥 Ad-Killer Backend running on port ${PORT}`));
