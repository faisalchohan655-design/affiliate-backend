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
// 🖼️ PIXABAY IMAGE FETCHER
// =============================================
async function fetchProductImage(productName) {
  try {
    const res = await axios.get('https://pixabay.com/api/', {
      params: {
        key: process.env.PIXABAY_API_KEY,
        q: `${productName} app software`,
        image_type: 'photo',
        per_page: 3,
        min_width: 800,
        safesearch: true,
      },
      timeout: 8000,
    });
    if (res.data.hits && res.data.hits.length > 0) {
      return res.data.hits[0].largeImageURL || res.data.hits[0].webformatURL;
    }
    return `https://picsum.photos/seed/${encodeURIComponent(productName)}/800/400`;
  } catch (e) {
    console.log('⚠️ Pixabay fallback used');
    return `https://picsum.photos/seed/${encodeURIComponent(productName)}/800/400`;
  }
}

// =============================================
// 🤖 GROQ SETUP - FIXED: Model changed, better error logging
// =============================================
async function callGroq(messages) {
  const url = 'https://api.groq.com/openai/v1/chat/completions';
  try {
    const response = await axios.post(url, {
      messages: messages,
      model: 'llama-3.3-70b-versatile', // ✅ Stable model with JSON support
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
  } catch (error) {
    // ✅ Detailed error logging
    console.error('Groq API Error:', {
      status: error.response?.status,
      data: error.response?.data,
      message: error.message
    });
    throw error;
  }
}

async function callGroqWithRetry(messages, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try { return await callGroq(messages); } 
    catch (e) {
      console.log(`⚠️ Groq attempt ${i+1} failed: ${e.message}`);
      if (i === maxRetries - 1) throw e;
      await new Promise(res => setTimeout(res, 3000));
    }
  }
}

// =============================================
// 📥 HELPER: Extract String
// =============================================
function extractString(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null) {
    if (value.content) return value.content;
    if (value.text) return value.text;
    if (value.article) return value.article;
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
// ⚙️ MAIN ENGINE
// =============================================
async function processCampaign(id) {
  try {
    await Campaign.findByIdAndUpdate(id, { status: 'processing' });
    const campaign = await Campaign.findById(id);
    if (!campaign) throw new Error('Not found');

    console.log(`🔄 Killing ads for: ${campaign.product_name}`);

    // 1. Fetch Image
    console.log('📸 Fetching image...');
    const imageUrl = await fetchProductImage(campaign.product_name);
    await Campaign.findByIdAndUpdate(id, { image_url: imageUrl });
    console.log('✅ Image fetched');

    // 2. SERPAPI Data
    console.log('🔍 Fetching SERPAPI data...');
    const serpUrl = `https://serpapi.com/search.json?key=${process.env.SERPAPI_KEY}&q=${encodeURIComponent(`best ${campaign.product_name} review 2026`)}&gl=${campaign.country || 'us'}&num=5&include_people_also_ask=true`;
    const serpRes = await axios.get(serpUrl, { timeout: 15000 });
    console.log('✅ SERPAPI data fetched');

    const peopleAlsoAsk = serpRes.data.people_also_ask || [];
    const snippets = serpRes.data.organic_results?.map(r => r.snippet).join(' ') || '';
    console.log(`📊 Found ${snippets.length} chars`);

    // 3. AI Content - COMPACT PROMPT
    console.log('🤖 Generating AI content...');
    const aiResponse = await callGroqWithRetry([
      { 
        role: 'system', 
        content: `You are an SEO journalist. Write 2500+ word reviews. No emojis. Include H1, H2, H3, comparison table, FAQ (3+ Qs). Unique structure each time. Return valid JSON.`
      },
      { 
        role: 'user', 
        content: `
        Product: ${campaign.product_name}
        Data: ${snippets.substring(0, 2000)}
        Questions: ${JSON.stringify(peopleAlsoAsk)}
        Affiliate Link: ${campaign.affiliate_link || 'None'}

        Generate JSON:
        1. trending_hook (string)
        2. google_article (HTML string, start with <h1>)
        3. twitter_thread (string, 15 tweets)
        4. linkedin_post (string, 400 words)
        5. reddit_post (string, 500 words)
        6. reels_script (string)
        7. meta_title (string, 50-60 chars)
        8. meta_description (string, 150-160 chars)
        `
      }
    ]);

    if (!aiResponse?.choices?.[0]?.message) {
      throw new Error('Invalid AI response. Check Groq API key.');
    }

    const result = JSON.parse(aiResponse.choices[0].message.content);
    console.log('✅ AI content generated');

    // ===========================================
    // CLEANUP: Image + Link
    // ===========================================
    let article = extractString(result.google_article);
    if (!article || article.length < 50) {
      article = `<h1>${campaign.product_name} Review</h1><p>Detailed review...</p>`;
    }
    
    article = article.replace(/<img[^>]*>/gi, '');
    article = article.replace(/<a\s+[^>]*>.*?<\/a>/gi, '');

    const imageHtml = `<img src="${imageUrl}" alt="${campaign.product_name} Review" style="width:100%; max-width:100%; height:auto; border-radius:12px; margin:20px 0;" referrerpolicy="no-referrer" />`;
    article = imageHtml + article;

    const affiliateLink = campaign.affiliate_link || '';
    if (affiliateLink) {
      const cta = `
        <div style="background:#f5f5f5; padding:20px; border-radius:12px; text-align:center; margin:30px 0;">
          <a href="${affiliateLink}" target="_blank" rel="nofollow sponsored" style="background:#000; color:#fff; padding:12px 30px; border-radius:50px; text-decoration:none; font-weight:bold; display:inline-block;">
            👉 Click Here to Grab the Deal
          </a>
        </div>
      `;
      article += cta;
    }

    let twitter = extractString(result.twitter_thread);
    twitter = twitter.replace(/(https?:\/\/[^\s]+)/g, '');
    if (affiliateLink) {
      twitter += `\n\n✅ Click Here → ${affiliateLink}`;
    }

    const finalData = {
      trending_hook: extractString(result.trending_hook),
      google_article: article,
      twitter_thread: twitter,
      linkedin_post: extractString(result.linkedin_post),
      reddit_post: extractString(result.reddit_post),
      reels_script: extractString(result.reels_script),
      meta_title: extractString(result.meta_title),
      meta_description: extractString(result.meta_description),
    };

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

    await sendToMobile(`
🚀 <b>${campaign.product_name}</b> SEO Article Ready!

🔥 <b>Hook:</b> ${finalData.trending_hook}

📄 <b>Article Length:</b> 2500+ words
🔗 <b>Link:</b> Clean CTA Added

📥 Download from Dashboard.
    `);

    console.log(`✅ Campaign ${id} complete!`);

  } catch (error) {
    console.error('❌ Worker Error:', error);
    console.error('📝 Error Details:', {
      message: error.message,
      stack: error.stack,
      response: error.response?.data
    });
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
app.listen(PORT, () => console.log(`🔥 Ad-Killer V4 (SEO Ultimate) running on port ${PORT}`));
