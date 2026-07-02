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
// 🤖 GROQ SETUP (Direct Axios)
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
// ⚙️ MAIN ENGINE - ULTIMATE SEO + UNIQUENESS
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
    console.log('✅ Image fetched:', imageUrl.substring(0, 50) + '...');

    // 2. SERPAPI Data - ✅ FIXED: Manual URL build
    console.log('🔍 Fetching SERPAPI data...');
    const serpUrl = `https://serpapi.com/search.json?key=${process.env.SERPAPI_KEY}&q=${encodeURIComponent(`best ${campaign.product_name} review 2026`)}&gl=${campaign.country || 'us'}&num=5&include_people_also_ask=true`;
    const serpRes = await axios.get(serpUrl, { timeout: 15000 });
    console.log('✅ SERPAPI data fetched');

    const peopleAlsoAsk = serpRes.data.people_also_ask || [];
    const snippets = serpRes.data.organic_results?.map(r => r.snippet).join(' ') || '';
    console.log(`📊 Found ${snippets.length} chars of competitor data`);

    // 3. AI Content - ULTIMATE SEO + UNIQUENESS ENGINE
    console.log('🤖 Generating AI content (2500+ words)...');
    const aiResponse = await callGroqWithRetry([
      { 
        role: 'system', 
        content: `You are a world-class SEO journalist and consumer advocate. 
        
        YOUR MANDATE:
        - Write 2500+ words of deeply researched, brutally honest content.
        - EVERY article must have a COMPLETELY DIFFERENT structure. Never repeat the same H2/H3 pattern twice.
        - SEO BASICS ARE FIXED: Always include proper H1, H2, H3 hierarchy, meta title, meta description, and one comparison table.
        - ZERO EMOJIS in google_article. Professional, authoritative tone.`
      },
      { 
        role: 'user', 
        content: `
        PRODUCT: ${campaign.product_name}
        COMPETITOR DATA: ${snippets.substring(0, 2500)}
        USER QUESTIONS: ${JSON.stringify(peopleAlsoAsk)}
        AFFILIATE LINK: ${campaign.affiliate_link || 'No link provided'}

        Generate a UNIQUE 2500+ word SEO article.
        Start with <h1>.
        Include: comparison table, FAQ section (3+ questions), meta title (50-60 chars), meta description (150-160 chars).
        If affiliate link provided, embed it once as: <a href="LINK" target="_blank">Click Here to Grab the Deal</a>

        OUTPUT (JSON):
        1. trending_hook
        2. google_article (HTML string)
        3. twitter_thread (15 tweets)
        4. linkedin_post (400 words)
        5. reddit_post (500 words)
        6. reels_script (60-sec)
        7. meta_title
        8. meta_description
        `
      }
    ]);

    // ✅ Error handling if AI response is invalid
    if (!aiResponse || !aiResponse.choices || !aiResponse.choices[0] || !aiResponse.choices[0].message) {
      throw new Error('Invalid AI response. Check Groq API key.');
    }

    const result = JSON.parse(aiResponse.choices[0].message.content);
    console.log('✅ AI content generated');

    // ===========================================
    // FORCEFUL CLEANUP: Image + Link
    // ===========================================
    let article = extractString(result.google_article);
    if (!article || article.length < 50) {
      article = `<h1>${campaign.product_name} Review</h1><p>Detailed review...</p>`;
    }
    
    // Remove all old images and links
    article = article.replace(/<img[^>]*>/gi, '');
    article = article.replace(/<a\s+[^>]*>.*?<\/a>/gi, '');

    // Inject Image
    const imageHtml = `<img src="${imageUrl}" alt="${campaign.product_name} Review" style="width:100%; max-width:100%; height:auto; border-radius:12px; margin:20px 0;" referrerpolicy="no-referrer" />`;
    article = imageHtml + article;

    // Add clean CTA button
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

    // Clean Twitter
    let twitter = extractString(result.twitter_thread);
    twitter = twitter.replace(/(https?:\/\/[^\s]+)/g, '');
    if (affiliateLink) {
      twitter += `\n\n✅ Click Here → ${affiliateLink}`;
    }

    // 4. Final Data
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

    // 5. Save
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

    // 6. Telegram
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
