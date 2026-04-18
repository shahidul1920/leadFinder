require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const { GoogleGenerativeAI, SchemaType } = require('@google/generative-ai');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const MAX_TOTAL_LEADS = 200;

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

async function generateGroundedLeads(city, zip, country, industry) {
    const schema = {
        type: SchemaType.ARRAY,
        items: {
            type: SchemaType.OBJECT,
            properties: {
                name: { type: SchemaType.STRING },
                phone: { type: SchemaType.STRING },
                email: { type: SchemaType.STRING },
                website: { type: SchemaType.STRING },
                rating: { type: SchemaType.STRING },
                reviews: { type: SchemaType.INTEGER },
                vibe: { type: SchemaType.STRING },
                overview: { type: SchemaType.STRING },
                icebreaker: { type: SchemaType.STRING },
                sourceCity: { type: SchemaType.STRING },
                sourceZip: { type: SchemaType.STRING }
            },
            required: [
                "name", "phone", "email", "website", "rating",
                "reviews", "vibe", "overview", "icebreaker",
                "sourceCity", "sourceZip"
            ]
        }
    };

    const model = genAI.getGenerativeModel({
        model: 'gemini-3.1-flash-lite-preview',
        tools: [{ googleSearch: {} }],
        generationConfig: {
            responseMimeType: "application/json",
            responseSchema: schema,
        }
    });

    const prompt = `Act as a Google Maps directory extractor. Search Google Maps for exactly 15 local businesses in ${city}, ${zip}, ${country} matching the industry: ${industry}. 
Requirements:
1) Use map data to find their real phone number and official website URL.
2) Return exactly 15 unique businesses.
3) Set the email field to 'Not Found'.
4) rating must be a string (e.g., '4.5'). reviews must be an integer.
5) Generate a 2-3 word vibe, a 2 sentence overview of their brand, and a 2 sentence cold outreach icebreaker.
6) Return ONLY the JSON array matching the schema.`;

    try {
        const result = await model.generateContent(prompt);
        return JSON.parse(result.response.text());
    } catch (error) {
        console.error(`⚠️ Grounded lead generation failed for ${city}:`, error.message);
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

        console.log(`🤖 Map Grounding chunk: ${target.city}, ${target.zip} ...`);

        const aiLeads = await generateGroundedLeads(target.city, target.zip, country, industry);

        for (const candidate of aiLeads) {
            if (processedLeads.length >= MAX_TOTAL_LEADS) break;

            const normalizedBrand = (candidate.name || 'N/A').toLowerCase().split(/[-|()]/)[0].trim();

            if (!normalizedBrand || seenBrands.has(normalizedBrand) || normalizedBrand.includes('mcdonalds')) continue;
            seenBrands.add(normalizedBrand);

            const normalizedLead = normalizeLead(candidate);
            normalizedLead.sourceCity = target.city;
            normalizedLead.sourceZip = target.zip || 'N/A';

            processedLeads.push(normalizedLead);
        }
        
        // Add an artificial processing delay between location chunks to respect 15 RPM
        await delay(4500);
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