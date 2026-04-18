require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const cheerio = require('cheerio');
const { GoogleGenerativeAI, SchemaType } = require('@google/generative-ai');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const SERPAPI_KEY = process.env.SERPAPI_KEY;
const MAX_TOTAL_LEADS = 200;
const MAX_PER_ZIP = 20;

// --- Core Helper Functions ---
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function normalizeLead(candidate) {
    const asString = (value, fallback = 'Not Found') => {
        const str = typeof value === 'string' ? value.trim() : '';
        return str || fallback;
    };

    const parsedReviews = Number.parseInt(candidate?.reviews, 10);
    const parsedRating = candidate?.rating == null ? '' : String(candidate.rating).trim();

    return {
        name: asString(candidate?.name, 'N/A'),
        phone: asString(candidate?.phone),
        email: asString(candidate?.email),
        website: asString(candidate?.website),
        rating: parsedRating || 'N/A',
        reviews: Number.isFinite(parsedReviews) && parsedReviews >= 0 ? parsedReviews : 0,
        vibe: asString(candidate?.vibe, 'N/A'),
        overview: asString(candidate?.overview, 'N/A'),
        icebreaker: asString(candidate?.icebreaker, 'N/A'),
        sourceCity: asString(candidate?.sourceCity, 'N/A'),
        sourceZip: asString(candidate?.sourceZip, 'N/A')
    };
}

// Helper to generate a chunking list first
async function generateCityZipList(country) {
    const schema = {
        type: SchemaType.ARRAY,
        items: {
            type: SchemaType.OBJECT,
            properties: {
                city: { type: SchemaType.STRING },
                zip: { type: SchemaType.STRING }
            },
            required: ["city", "zip"]
        }
    };

    const model = genAI.getGenerativeModel({
        model: 'gemini-3.1-flash-lite-preview',
        generationConfig: {
            responseMimeType: "application/json",
            responseSchema: schema,
        }
    });

    const prompt = `Return a JSON array of exactly 5 major cities and representative ZIP codes for the country: ${country}. Format: [{"city": "City Name", "zip": "ZIP/Postal Code"}]`;

    try {
        const result = await model.generateContent(prompt);
        const parsed = JSON.parse(result.response.text());
        return Array.isArray(parsed) ? parsed.slice(0, 5) : [];
    } catch (e) {
        console.error("❌ Failed to generate city/zip list:", e.message);
        return [];
    }
}

// Gemini-first lead researcher with Google Search grounding.
async function getTargetLeads({ country, city, zip, industry }) {
    const locationParts = [...new Set([city, zip, country].filter(Boolean).map(part => String(part).trim().toLowerCase()))]
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
    const query = `${industry} in ${locationParts}`;
    const url = `https://serpapi.com/search.json?engine=google_local&q=${encodeURIComponent(query)}&api_key=${SERPAPI_KEY}`;
    
    console.log(`🔍 Discovery Phase: Searching for "${query}"`);
    
    try {
        const response = await axios.get(url);
        const data = response.data;

        if (data.error) throw new Error(data.error);
        if (!data.local_results) return [];
        
        return data.local_results.filter(biz => {
            const reviewsCount = typeof biz.reviews === 'number' ? biz.reviews : (biz.user_ratings_total || 0);
            return reviewsCount >= 0 && reviewsCount <= 2000; // E.g., not massive corporations setup
        });
    } catch (error) { 
        console.error("❌ SerpApi Error:", error.message);
        throw error; 
    }
}

async function scrapeWebsiteData(url) {
    if (!url) return { text: '', email: null };
    try {
        const response = await axios.get(url, { timeout: 10000 });
        const html = response.data;
        const $ = cheerio.load(html);
        
        $('script, style, noscript').remove();
        const text = $('body').text().replace(/\s+/g, ' ').trim().substring(0, 3000); // 3000 chars should be plenty context
        
        const emailMatch = html.match(/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/);
        const email = emailMatch ? emailMatch[0] : null;

        return { text, email };
    } catch (error) {
        return { text: '', email: null };
    }
}

async function generateAgencyPitch(businessName, websiteText) {
    const schema = {
        type: SchemaType.OBJECT,
        properties: {
            vibe: { type: SchemaType.STRING, description: "2-3 word vibe description" },
            overview: { type: SchemaType.STRING, description: "2 sentence overview of their business based on website text" },
            icebreaker: { type: SchemaType.STRING, description: "2 sentence personalized agency cold outreach pitch" }
        },
        required: ["vibe", "overview", "icebreaker"]
    };

    const model = genAI.getGenerativeModel({
        model: 'gemini-3.1-flash-lite-preview',
        generationConfig: {
            responseMimeType: "application/json",
            responseSchema: schema,
        }
    });

    const prompt = `You are a B2B sales development representative pitching an agency service to: "${businessName}".
Here is some extracted text from their website:
"""
${websiteText || 'No website text available.'}
"""

Based on this, return a JSON object evaluating their brand. Include a 2-sentence overview acknowledging what they do well or what they lack. Then, generate a cold outreach icebreaker (2 sentences) uniquely tied to their business that transitions into a standard web agency pitch.`;

    try {
        const result = await model.generateContent(prompt);
        return JSON.parse(result.response.text());
    } catch (error) {
        console.error(`⚠️ Pitch generation failed for ${businessName}:`, error.message);
        return null;
    }
}

// --- The Main API Endpoint ---
app.post('/api/generate-leads', async (req, res) => {
    const { country, industry } = req.body;

    if (!country || !industry) return res.status(400).json({ error: "Country and industry are required." });

    const restrictedRegions = ['bangladesh', 'bd', 'india', 'in'];
    if (restrictedRegions.some(region => new RegExp(`\\b${region}\\b`, 'i').test(country.toLowerCase()))) {
        return res.status(400).json({ error: "Target region restricted by agency policy." });
    }

    if (!process.env.GEMINI_API_KEY) {
        return res.status(500).json({ error: 'Missing GEMINI_API_KEY in environment variables.' });
    }

    let cityZipList = await generateCityZipList(country);
    if (!cityZipList || cityZipList.length === 0) {
        cityZipList = [{ city: country, zip: '' }];
    }

    const seenBrands = new Set();
    const processedLeads = [];

    for (const target of cityZipList) {
        if (processedLeads.length >= MAX_TOTAL_LEADS) break;

        let leadsForTarget = [];
        try {
            leadsForTarget = await getTargetLeads({ country, city: target.city, zip: target.zip, industry });
            console.log(`🤖 Prospecting chunk: ${target.city}, ${target.zip} -> Found ${leadsForTarget.length} raw leads`);
        } catch (err) { continue; }

        let perZipCount = 0;
        for (const lead of leadsForTarget) {
            if (processedLeads.length >= MAX_TOTAL_LEADS || perZipCount >= MAX_PER_ZIP) break;

            const name = lead.title || 'N/A';
            const normalizedBrand = name.toLowerCase().split(/[-|()]/)[0].trim();

            if (!normalizedBrand || seenBrands.has(normalizedBrand) || normalizedBrand.includes('mcdonalds')) continue;
            seenBrands.add(normalizedBrand);

            console.log(`   - Scraping/Pitching: ${name}`);
            const siteData = await scrapeWebsiteData(lead.website);
            const aiData = await generateAgencyPitch(name, siteData.text);

            // Add an artificial processing delay to respect Gemini's 15 RPM Free Tier quota
            await delay(4500);

            const normalizedLead = normalizeLead({
                name,
                phone: lead.phone || 'N/A',
                email: siteData.email || 'Not Found',
                website: lead.website || 'N/A',
                reviews: lead.reviews,
                rating: lead.rating,
                vibe: aiData?.vibe || 'N/A',
                overview: aiData?.overview || 'N/A',
                icebreaker: aiData?.icebreaker || 'N/A',
                sourceCity: target.city,
                sourceZip: target.zip || 'N/A'
            });

            processedLeads.push(normalizedLead);
            perZipCount++;
        }
    }

    if (processedLeads.length === 0) return res.status(404).json({ error: 'No leads found.' });

    const timestamp = Date.now();
    const outputFile = `leads_${country.replace(/\s+/g, '_')}_${timestamp}.csv`;
    const outputFilePath = path.join(__dirname, 'public', outputFile);

    fs.writeFileSync(outputFilePath, '"Business Name","Phone","Email","Website","Reviews","Vibe","Overview","Icebreaker","Source City","Source ZIP"\n');

    for (const lead of processedLeads) {
        // CSV formatting is intentionally kept aligned with the existing export style.
        const safe = (str) => `"${(str || '').toString().replace(/"/g, '""')}"`;
        const ratingStr = `${lead.rating || 'N/A'} (${Number.isInteger(lead.reviews) ? lead.reviews : 'N/A'})`;

        const csvRow = `${safe(lead.name)},${safe(lead.phone)},${safe(lead.email)},${safe(lead.website)},"${ratingStr}",${safe(lead.vibe)},${safe(lead.overview)},${safe(lead.icebreaker)},${safe(lead.sourceCity)},${safe(lead.sourceZip)}\n`;
        fs.appendFileSync(outputFilePath, csvRow);
    }

    const targets = [...new Map(
        processedLeads.map(lead => [`${lead.sourceCity}|${lead.sourceZip}`, { city: lead.sourceCity, zip: lead.sourceZip }])
    ).values()];

    res.json({
        success: true,
        downloadUrl: `/${outputFile}`,
        count: processedLeads.length,
        leads: processedLeads,
        targets
    });
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`\n🚀 Redmun Lead Generator (AI Grounded Edition) running on http://localhost:${PORT}`);
});