import express from 'express';
import mongoose from 'mongoose';
import axios from 'axios';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json());

// =============================================
// 📦 MONGO DB
// =============================================
const MONGO_URI = process.env.MONGO_URL || process.env.DATABASE_URL;
if (!MONGO_URI) {
  console.error('❌ FATAL: MONGO_URL is MISSING!');
  process.exit(1);
}

const connectDB = async (retries = 5, delay = 3000) => {
  for (let i = 0; i < retries; i++) {
    try {
      await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
      console.log('✅ MongoDB Connected');
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
// 📝 SCHEMA
// =============================================
const campaignSchema = new mongoose.Schema({
  product_name: String,
  country: { type: String, default: 'us' },
  affiliate_link: { type: String, default: '' },
  image_url: { type: String, default: '' },
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

// =============================================
// 🖼️ OKSLOP IMAGE FETCHER (With Better Fallback)
// =============================================
async function fetchProductImage(productName) {
  try {
    const res = await axios.get('https://okslop.com/api/v1/search/photos', {
      params: {
        query: `${productName} app software`,
        per_page: 1,
        client_id: process.env.OKSLOP_API_KEY,
      },
      timeout: 5000,
    });
    
    if (res.data.results && res.data.results.length > 0) {
      return res.data.results[0].urls.regular;
    }
    // Better fallback: Product-specific picsum seed
    return `https://picsum.photos/seed/${encodeURIComponent(productName)}/800/400`;
  } catch (e) {
    console.log('⚠️ OKSLOP fallback used');
    return `https://picsum.photos/seed/${encodeURIComponent(productName)}/800/400`;
  }
}

// =============================================
// 🤖 GROQ SETUP
// =============================================
async function callGroq(messages) {
  const url = 'https://api.groq.com/openai/v1/chat/completions';
  const response = await axios.post(url, {
    messages: messages,
    model: 'llama-3.1-8b-instant',
    response_format: { type: "json_object" },
    temperature: 0.75,
  }, {
    headers: {
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    timeout: 60000,
  });
  return response.data;
}

async function callGroqWithRetry(messages, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try { return await callGroq(messages); } 
    catch (e) {
      console.log(`⚠️ Groq attempt ${i+1} failed. Retrying...`);
      if (i === maxRetries - 1) throw e;
      await new Promise(res => setTimeout(res, 3000));
    }
  }
}

// =============================================
// 📥 HELPER: Extract String (Handles Nested JSON)
// =============================================
function extractString(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null) {
    // Agar nested object hai toh usme se content dhoondho
    if (value.content) return value.content;
    if (value.text) return value.text;
    if (value.article) return value.article;
    if (value.product_image) return value.product_image; // <- Naya fix
    // Agar kuch na mile toh poori object ko string bana do
    return JSON.stringify(value);
  }
  return String(value || '');
}

// =============================================
// 📨 TELEGRAM
// =============================================
async function sendToMobile(text) {
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) return;
  try {
    await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: process.env.TELEGRAM_CHAT_ID,
      text: text.substring(0, 4096),
      parse_mode: 'HTML'
    });
  } catch (e) { console.log('Telegram error:', e.message); }
}

// =============================================
// ⚙️ MAIN ENGINE V4.1 (FORCEFUL FIX)
// =============================================
async function processCampaign(id) {
  try {
    await Campaign.findByIdAndUpdate(id, { status: 'processing' });
    const campaign = await Campaign.findById(id);
    if (!campaign) throw new Error('Not found');

    console.log(`🔄 Killing ads for: ${campaign.product_name}`);

    // 1. Fetch Image (OKSLOP)
    const imageUrl = await fetchProductImage(campaign.product_name);
    await Campaign.findByIdAndUpdate(id, { image_url: imageUrl });

    // 2. SERPAPI Data
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

    // 3. AI: ULTRA-STRICT PROMPT (For Pure String Article)
    const aiResponse = await callGroqWithRetry([
      { 
        role: 'system', 
        content: `You are a rebellious, brutally honest consumer advocate. 
        Tone: Bold, punchy, short sentences. Use emojis like ⚠️, 🔥, ❌, ✅.
        CRITICAL RULES FOR JSON OUTPUT:
        - "google_article" MUST be a SINGLE CONTINUOUS STRING of raw HTML. Start with <h1> and end with </html>. DO NOT use nested JSON objects inside this field. NO { } brackets inside this field.
        - "twitter_thread" MUST be a SINGLE STRING with newlines (\n) between tweets.
        - All other fields ("linkedin_post", "reddit_post", "reels_script", "meta_title", "meta_description") MUST be plain strings.

        AFFILIATE LINK RULE (${campaign.affiliate_link || 'No link'}):
        If link is provided, ALWAYS embed it as HTML <a href="LINK" target="_blank">Click Here to Check Deal</a> or "Click Here". NEVER show the raw URL.
        `
      },
      { 
        role: 'user', 
        content: `
        Product: ${campaign.product_name}
        Competitor Data: ${snippets.substring(0, 3000)}
        People Also Ask: ${JSON.stringify(peopleAlsoAsk)}
        Affiliate Link: ${campaign.affiliate_link || 'No link'}

        Generate these 7 fields as STRINGS:
        1. trending_hook: "⚠️ STOP! Don't buy ${campaign.product_name} before reading this" (or similar).
        2. google_article: 1500-word detailed HTML review. Start with <h1>Review of ${campaign.product_name}</h1>. Add <h2>Why Ads Lie</h2>. Add <h2>Comparison Table</h2>.
        3. twitter_thread: 15 tweets with newlines. Tweet 1 = hook. Tweet 15 = "Click Here" CTA.
        4. linkedin_post: 400 words professional story.
        5. reddit_post: "I tested ${campaign.product_name} for 30 days (Honest Review)". TL;DR.
        6. reels_script: 60-second script (Scene 1 to 5).
        7. meta_title: Under 60 chars.
        8. meta_description: Under 160 chars.
        `
      }
    ]);

    const result = JSON.parse(aiResponse.choices[0].message.content);

    // 4. Extract & Fix Google Article (Inject Image forcefully)
    let articleContent = extractString(result.google_article);
    
    // Agar article empty hai toh default create karo
    if (!articleContent || articleContent.length < 50) {
      articleContent = `<h1>${campaign.product_name} Review 2026</h1><p>Detailed review coming soon...</p>`;
    }

    // 🔥 FORCEFUL IMAGE INJECTION (Backend se hi daal rahe hain)
    const imageHtml = `<img src="${imageUrl}" alt="${campaign.product_name} Review 2026" style="width:100%; max-width:800px; height:auto; border-radius:12px; margin:20px 0;" />`;
    
    // Agar article mein pehle se image hai toh replace kar do, warna top par add kar do
    if (articleContent.includes('<img')) {
      // Pehle image ko replace kar do
      articleContent = articleContent.replace(/<img[^>]*>/i, imageHtml);
    } else {
      // Top par image daal do
      articleContent = imageHtml + articleContent;
    }

    // 🔥 FORCEFUL LINK FIX (Agar AI ne raw URL dikha diya toh replace kar do)
    const affiliateLink = campaign.affiliate_link || '';
    if (affiliateLink) {
      // Raw URL ko "Click Here" mein badal do
      const clickHereHtml = `<a href="${affiliateLink}" target="_blank" rel="nofollow sponsored">Click Here to Check the Best Deal</a>`;
      // Agar article mein raw URL hai toh replace karo, nahi toh naturally embed ho chuka hoga
      articleContent = articleContent.replace(new RegExp(affiliateLink.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), clickHereHtml);
    }

    // Twitter thread mein bhi raw URL replace karo
    let twitterThread = extractString(result.twitter_thread);
    if (affiliateLink && twitterThread.includes(affiliateLink)) {
      twitterThread = twitterThread.replace(new RegExp(affiliateLink.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), 'Click Here');
    }

    // 5. Final Data
    const finalData = {
      trending_hook: extractString(result.trending_hook),
      google_article: articleContent, // Forcefully injected image
      twitter_thread: twitterThread,
      linkedin_post: extractString(result.linkedin_post),
      reddit_post: extractString(result.reddit_post),
      reels_script: extractString(result.reels_script),
      meta_title: extractString(result.meta_title),
      meta_description: extractString(result.meta_description),
    };

    // 6. Save to DB
    await Campaign.findByIdAndUpdate(id, {
      trending_hook: finalData.trending_hook,
      google_article: finalData.google_article,
      twitter_thread: finalData.twitter_thread,
      linkedin_post: finalData.linkedin_post,
      reddit_post: finalData.reddit_post,
      reels_script: finalData.reels_script,
      meta_title: finalData.meta_title,
      meta_description: finalData.meta_description,
      status: 'completed'
    });

    // 7. Telegram Alert
    await sendToMobile(`
🚀 <b>${campaign.product_name}</b> V4.1 Ready!

🔥 <b>Hook:</b> ${finalData.trending_hook}

🖼️ <b>Image Injected:</b> ✅ (Forced at top of article)
🔗 <b>Link Cleaned:</b> ✅ (Raw URL hidden)

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
// 🌐 ROUTES
// =============================================
app.post('/api/start', async (req, res) => {
  const { product, country, affiliateLink } = req.body;
  if (!product) return res.status(400).json({ error: 'Product required' });
  
  const newCampaign = new Campaign({
    product_name: product,
    country: country || 'us',
    affiliate_link: affiliateLink || '',
    status: 'pending'
  });
  const saved = await newCampaign.save();
  processCampaign(saved._id).catch(console.error);
  res.json({ success: true, id: saved._id });
});

app.get('/api/status/:id', async (req, res) => {
  const data = await Campaign.findById(req.params.id);
  res.json(data);
});

app.get('/api/download/:id', async (req, res) => {
  const data = await Campaign.findById(req.params.id);
  res.json(data);
});

app.get('/health', (req, res) => res.send('OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🔥 Ad-Killer V4.1 running on port ${PORT}`));
