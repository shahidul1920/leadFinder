require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const cheerio = require('cheerio');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(express.json()); 
// THIS IS THE FIX: Locks the public folder path securely
app.use(express.static(path.join(__dirname, 'public')));

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const SERPAPI_KEY = process.env.SERPAPI_KEY;

// --- Helper Functions ---
async function getTargetLeads(location, industry) {
    const query = `${industry} in ${location}`;
    const url = `https://serpapi.com/search.json?engine=google_local&q=${encodeURIComponent(query)}&api_key=${SERPAPI_KEY}`;
    
    console.log(`🔍 Searching for: "${query}"`);
    console.log(`📡 SERPAPI_KEY defined: ${!!SERPAPI_KEY}`);
    
    try {
        const response = await axios.get(url);
        const data = response.data;

        if (data.error) {
            // SerpAPI returns error field for invalid key/credits, surface it
            console.error(`❌ SerpAPI error field: ${data.error}`);
            throw new Error(data.error);
        }

        console.log(`✅ SerpAPI HTTP status: ${response.status}`);
        console.log(`📊 Local results found: ${data.local_results ? data.local_results.length : 0}`);
        
        if (!data.local_results) {
            console.log(`⚠️ No local_results in response. Full response keys:`, Object.keys(data));
            return [];
        }
        
        // Loosen filters: keep anything with a site/link; ignore review count requirement
            // Loosen review filter and accept link fallback when website missing
            const filtered = data.local_results.filter(biz => {
                const reviewsCount = typeof biz.reviews === 'number' ? biz.reviews : (biz.user_ratings_total || 0);
                const hasSite = !!(biz.website || biz.link);
                return hasSite && reviewsCount >= 0 && reviewsCount <= 2000;
            });
            console.log(`✅ Filtered results (has site/link, 0-2000 reviews): ${filtered.length}`);
        return filtered;
    } catch (error) { 
        console.error("❌ SerpApi Error:", error.message);
        if (error.response) {
            console.error("Status:", error.response.status);
            console.error("Body:", error.response.data);
        }
        throw error; 
    }
}

async function scrapeWebsiteData(url) {
    try {
        const { data } = await axios.get(url, { timeout: 7000 });
        const $ = cheerio.load(data);
        let pageText = $('body').text().replace(/\s+/g, ' ').trim().substring(0, 3000);
        
        let email = 'Not Found';
        const extractedEmails = data.match(/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/gi);
        if (extractedEmails) {
            const validEmails = extractedEmails.filter(e => !e.endsWith('.png') && !e.endsWith('.jpg'));
            if (validEmails.length > 0) email = validEmails[0];
        }
        return { pageText, email };
    } catch (error) { return { pageText: '', email: 'Not Found' }; }
}

async function generateAgencyPitch(businessName, websiteText) {
    if (!websiteText || websiteText.length < 50) return { vibe: 'Unknown', angle: 'Standard Web Audit', icebreaker: 'Loved checking out your local presence.' };
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const prompt = `You are a strategic sales partner for a web agency called Redmun. Analyze this text for ${businessName}:\n${websiteText}\nTask: 1. Vibe (2-3 words) 2. Pitch Angle 3. Icebreaker (2 sentences). Format strictly: [Vibe] | [Pitch Angle] | [Icebreaker]`;
    try {
        const result = await model.generateContent(prompt);
        const parts = result.response.text().trim().split('|');
        return { vibe: parts[0]?.trim() || 'N/A', angle: parts[1]?.trim() || 'N/A', icebreaker: parts[2]?.trim() || 'N/A' };
    } catch (error) { return { vibe: 'Error', angle: 'Error', icebreaker: 'Error' }; }
}

// --- The Main API Endpoint ---
app.post('/api/generate-leads', async (req, res) => {
    const { location, industry } = req.body;
    
    console.log(`\n🚀 API Request: location="${location}", industry="${industry}"`);
    
    // Security/Validation: Prevent targeting UK agency's restricted regions
    const restrictedRegions = ['bangladesh', 'bd', 'india', 'in'];
    if (restrictedRegions.some(region => location.toLowerCase().includes(region))) {
        return res.status(400).json({ error: "Target region restricted by agency policy." });
    }

    const outputFile = `leads_${location.replace(/\s+/g, '_')}_${Date.now()}.csv`;
    const outputFilePath = path.join(__dirname, 'public', outputFile);
    
    fs.writeFileSync(outputFilePath, '"Business Name","Phone","Email","Website","Reviews","Vibe","Pitch Angle","Icebreaker"\n');

    let leads;
    try {
        leads = await getTargetLeads(location, industry);
    } catch (err) {
        console.error('❌ Failed to fetch leads from SerpAPI');
        return res.status(502).json({ error: err.message || 'SerpAPI request failed' });
    }
    
    console.log(`📋 Total leads returned from SerpAPI: ${leads.length}`);
    
    if (leads.length === 0) {
        console.log(`⚠️ No leads found after filtering`);
        return res.status(404).json({ error: "No leads found in this area." });
    }

    const seenBrands = new Set();
    let processedCount = 0;
    const processedLeads = [];

    for (const lead of leads) {
        if (processedCount >= 10) break; // Hard cap at 10 for testing via UI to avoid timeouts
        const name = lead.title || 'N/A';
        const normalizedBrand = name.toLowerCase().split(/[-|()]/)[0].trim();

        if (seenBrands.has(normalizedBrand) || normalizedBrand.includes('mcdonalds')) continue;
        seenBrands.add(normalizedBrand);

        const websiteUrl = lead.website || lead.link || lead.canonical_page_url || 'N/A';

        const scrapeUrl = websiteUrl.startsWith('http') ? websiteUrl : null;
        const { pageText, email } = scrapeUrl ? await scrapeWebsiteData(scrapeUrl) : { pageText: '', email: 'Not Found' };
        const strategy = await generateAgencyPitch(name, pageText);

        // Prepare lead data for response
        const leadData = {
            name,
            phone: lead.phone || 'N/A',
            email,
            website: websiteUrl,
            reviews: lead.reviews,
            rating: lead.rating,
            vibe: strategy.vibe,
            angle: strategy.angle,
            icebreaker: strategy.icebreaker
        };
        processedLeads.push(leadData);

        // Save to CSV
        const safeName = `"${name.replace(/"/g, '""')}"`;
        const phone = lead.phone || 'N/A';
        const ratingStr = `${lead.rating} (${lead.reviews})`;
        const safeVibe = `"${strategy.vibe.replace(/"/g, '""')}"`;
        const safeAngle = `"${strategy.angle.replace(/"/g, '""')}"`;
        const safeIcebreaker = `"${strategy.icebreaker.replace(/"/g, '""')}"`;

        const csvRow = `${safeName},"${phone}","${email}","${websiteUrl}","${ratingStr}",${safeVibe},${safeAngle},${safeIcebreaker}\n`;
        fs.appendFileSync(outputFilePath, csvRow);
        processedCount++;
    }

    // Return the leads data and download URL
    res.json({ success: true, downloadUrl: `/${outputFile}`, count: processedCount, leads: processedLeads });
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`\n🚀 Redmun Lead Generator running on http://localhost:${PORT}`);
    console.log(`✅ GEMINI_API_KEY: ${process.env.GEMINI_API_KEY ? '✓ Configured' : '❌ MISSING'}`);
    console.log(`✅ SERPAPI_KEY: ${process.env.SERPAPI_KEY ? '✓ Configured' : '❌ MISSING'}`);
    console.log(`📖 Open your browser and navigate to http://localhost:${PORT}\n`);
});