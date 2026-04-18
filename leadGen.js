require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
// Notice we import SchemaType to force strict JSON outputs
const { GoogleGenerativeAI, SchemaType } = require('@google/generative-ai');

const app = express();
app.use(express.json()); 
app.use(express.static(path.join(__dirname, 'public')));

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const SERPAPI_KEY = process.env.SERPAPI_KEY;

const MAX_TARGETS = 10; 
const MAX_PER_ZIP = 20; 
const MAX_TOTAL_LEADS = 200; 

// --- Core Helper Functions ---

async function getTargetLeads({ country, city, zip, industry }) {
    const locationParts = [...new Set([city, zip, country].filter(Boolean).map(part => part.toString().trim().toLowerCase()))]
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
            return reviewsCount >= 0 && reviewsCount <= 2000;
        });
    } catch (error) { 
        console.error("❌ SerpApi Error:", error.message);
        throw error; 
    }
}

// 🚀 THE UPGRADE: Replacing Axios/Cheerio with Search Grounding
async function enrichLeadWithGrounding(businessName, city, zip, knownWebsite) {
    // We enforce a strict schema so the React UI never breaks
    const schema = {
        type: SchemaType.OBJECT,
        properties: {
            email: { type: SchemaType.STRING, description: "Primary contact email address. Search social media and directories if not on website. Return 'Not Found' if totally unavailable." },
            phone: { type: SchemaType.STRING, description: "Primary contact phone number. Return 'Not Found' if unavailable." },
            website: { type: SchemaType.STRING, description: "Official website URL. Return 'Not Found' if unavailable." },
            vibe: { type: SchemaType.STRING, description: "2-3 word description of their brand vibe." },
            overview: { type: SchemaType.STRING, description: "2 sentences analyzing their current online presence, strengths, or gaps." },
            icebreaker: { type: SchemaType.STRING, description: "First 2 sentences of a highly personalized cold email pitch offering web agency services." }
        },
        required: ["email", "phone", "website", "vibe", "overview", "icebreaker"]
    };

    const model = genAI.getGenerativeModel({
        model: 'gemini-2.5-flash',
        // This is the magic bullet: Enables live web searching
        tools: [{ googleSearch: {} }], 
        generationConfig: {
            responseMimeType: "application/json",
            responseSchema: schema,
        }
    });

    const prompt = `Research the local business: "${businessName}" located in ${city}, ${zip}.
    ${knownWebsite ? `They might be associated with this URL: ${knownWebsite}` : ''}

    Act as a web agency lead researcher.
    1. Actively search the web to find their actual contact email, verified phone number, and official website.
    2. Analyze their online footprint.
    3. Generate a personalized sales pitch.`;

    try {
        const result = await model.generateContent(prompt);
        return JSON.parse(result.response.text());
    } catch (error) {
        console.error(`⚠️ Grounding failed for ${businessName}:`, error.message);
        return null;
    }
}

async function generateCityZipList(country) {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const prompt = `Country: ${country}
Return a JSON array with up to ${MAX_TARGETS} major cities and representative postal/ZIP codes.
Format: [{"city":"City Name","zip":"ZIP or Postcode"}]`;

    try {
        const result = await model.generateContent(prompt);
        const text = result.response.text().trim();
        const jsonText = text.startsWith('[') ? text : text.substring(text.indexOf('['));
        const parsed = JSON.parse(jsonText);
        return Array.isArray(parsed) ? parsed.slice(0, MAX_TARGETS) : [];
    } catch (error) {
        return [];
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

    let cityZipList = await generateCityZipList(country);
    if (!cityZipList.length) cityZipList = [{ city: country, zip: '' }];

    const timestamp = Date.now();
    const outputFile = `leads_${country.replace(/\s+/g, '_')}_${timestamp}.csv`;
    const outputFilePath = path.join(__dirname, 'public', outputFile);
    
    fs.writeFileSync(outputFilePath, '"Business Name","Phone","Email","Website","Reviews","Vibe","Overview","Icebreaker","Source City","Source ZIP"\n');

    const seenBrands = new Set();
    let processedCount = 0;
    const processedLeads = [];

    for (const target of cityZipList) {
        if (processedCount >= MAX_TOTAL_LEADS) break;

        let leadsForTarget = [];
        try {
            leadsForTarget = await getTargetLeads({ country, city: target.city, zip: target.zip, industry });
        } catch (err) { continue; }

        let perZipCount = 0;
        for (const lead of leadsForTarget) {
            if (processedCount >= MAX_TOTAL_LEADS || perZipCount >= MAX_PER_ZIP) break;

            const name = lead.title || 'N/A';
            const normalizedBrand = name.toLowerCase().split(/[-|()]/)[0].trim();

            if (seenBrands.has(normalizedBrand) || normalizedBrand.includes('mcdonalds')) continue;
            seenBrands.add(normalizedBrand);

            console.log(`🤖 Grounding AI Agent researching: ${name}`);
            
            // Execute the AI Researcher
            const aiData = await enrichLeadWithGrounding(name, target.city, target.zip, lead.website);

            const leadData = {
                name,
                phone: aiData?.phone !== 'Not Found' ? (aiData?.phone || lead.phone || 'N/A') : (lead.phone || 'N/A'),
                email: aiData?.email || 'Not Found',
                website: aiData?.website !== 'Not Found' ? (aiData?.website || lead.website || 'N/A') : (lead.website || 'N/A'),
                reviews: lead.reviews,
                rating: lead.rating,
                vibe: aiData?.vibe || 'N/A',
                overview: aiData?.overview || 'N/A',
                icebreaker: aiData?.icebreaker || 'N/A',
                sourceCity: target.city,
                sourceZip: target.zip || 'N/A'
            };
            
            processedLeads.push(leadData);

            // CSV Formatting
            const safe = (str) => `"${(str || '').toString().replace(/"/g, '""')}"`;
            const ratingStr = `${lead.rating || 'N/A'} (${lead.reviews || lead.user_ratings_total || 'N/A'})`;
            
            const csvRow = `${safe(name)},${safe(leadData.phone)},${safe(leadData.email)},${safe(leadData.website)},"${ratingStr}",${safe(leadData.vibe)},${safe(leadData.overview)},${safe(leadData.icebreaker)},${safe(target.city)},${safe(target.zip)}\n`;
            fs.appendFileSync(outputFilePath, csvRow);

            processedCount++;
            perZipCount++;
        }
    }

    if (processedLeads.length === 0) return res.status(404).json({ error: "No leads found." });

    res.json({
        success: true,
        downloadUrl: `/${outputFile}`,
        count: processedCount,
        leads: processedLeads,
        targets: cityZipList
    });
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`\n🚀 Redmun Lead Generator (AI Grounded Edition) running on http://localhost:${PORT}`);
});