    // 3. AI Content - ULTIMATE SEO + UNIQUENESS ENGINE
    const aiResponse = await callGroqWithRetry([
      { 
        role: 'system', 
        content: `You are a world-class SEO journalist and consumer advocate. 
        
        YOUR MANDATE:
        - Write 2500+ words of deeply researched, brutally honest content.
        - EVERY article must have a COMPLETELY DIFFERENT structure. Never repeat the same H2/H3 pattern twice.
        - SEO BASICS ARE FIXED: Always include proper H1, H2, H3 hierarchy, meta title, meta description, and one comparison table. But the story angle and section flow must change every time.
        
        UNIQUENESS RULES (Strict):
        1. RANDOM NARRATIVE STARTER: Randomly choose one of these starter styles:
           - "The [Product] Paradox: Why [Claim] Doesn't Match Reality"
           - "[Number] Things [Product] Users Wish They Knew Before Buying"
           - "The $[Price] Question: Is [Product] Actually Worth It?"
           - "Why [Product]'s Biggest Competitors Are [Competitor1] and [Competitor2]"
           - "The Hidden [Product] Feature That Changes Everything"
        2. VARIED SECTIONS: Rotate between these section types:
           - "The Marketing vs Reality Check"
           - "What the [Year] Update Actually Broke/Fixed"
           - "Real User Stories: The Good, The Bad, The Ugly"
           - "Technical Deep Dive: [Product] Under the Hood"
           - "The Financial Impact: ROI Analysis"
           - "Who Should ABSOLUTELY Buy [Product]"
           - "The Alternatives Nobody Talks About"
        3. NEVER repeat the same combination of sections.
        4. FIXED SEO ELEMENTS (Always present):
           - One H1 (The main title)
           - 3-5 H2s (Main sections)
           - 2-3 H3s under each H2
           - One comparison table (with at least 3 competitors)
           - FAQ section with 3 questions minimum
           - Meta title (50-60 chars)
           - Meta description (150-160 chars)
        5. ZERO EMOJIS in google_article. Professional, authoritative tone.
        6. KEYWORD VARIATION: Use synonyms of the product name naturally throughout.`
      },
      { 
        role: 'user', 
        content: `
        PRODUCT: ${campaign.product_name}
        COMPETITOR DATA: ${snippets.substring(0, 2500)}
        USER QUESTIONS: ${JSON.stringify(peopleAlsoAsk)}
        AFFILIATE LINK: ${campaign.affiliate_link || 'No link provided'}

        ============================================
        🎯 THIS ARTICLE'S UNIQUE ASSIGNMENT:
        ============================================
        - Choose a completely fresh angle that has NOT been used before.
        - Build the article around that angle.
        - Ensure ALL SEO elements are included naturally.
        - The comparison table MUST include ${campaign.product_name} vs at least 2 competitors from the data.
        - If affiliate link is provided, embed it ONCE naturally in a relevant section using: <a href="LINK" target="_blank">Click Here to Grab the Deal</a>
        - Do NOT put the affiliate link in the FAQ section.

        ============================================
        OUTPUT FORMAT (7 FIELDS):
        ============================================
        1. trending_hook: A powerful 1-line clickbait headline (no emoji)
        2. google_article: 2500+ words of pure HTML. Start with <h1>.
        3. twitter_thread: 15 tweets, professional tone (max 2 emojis total)
        4. linkedin_post: 400 words, no emojis
        5. reddit_post: 500 words, casual but honest
        6. reels_script: 60-second script
        7. meta_title: 50-60 characters
        8. meta_description: 150-160 characters
        `
      }
    ], 'llama-3.1-8b-instant');
