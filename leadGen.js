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
const MIN_REQUIRED_LEADS = 10;

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
        model: 'gemini-2.5-flash',
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
// Gemini-first lead researcher with Google Search grounding.
async function generateGroundedLeads(city, zip, country, industry) {
    const schema = {
        type: SchemaType.ARRAY,
        description: "A list of generated business leads.",
        items: {
            type: SchemaType.OBJECT,
            properties: {
                name: { type: SchemaType.STRING, description: "Business name" },
                phone: { type: SchemaType.STRING, description: "Contact phone number or 'N/A'" },
                email: { type: SchemaType.STRING, description: "Contact email or 'Not Found'" },
                website: { type: SchemaType.STRING, description: "Website URL or 'Not Found'" },
                rating: { type: SchemaType.STRING, description: "Star rating, e.g., '4.5'" },
                reviews: { type: SchemaType.INTEGER, description: "Number of reviews" },
                vibe: { type: SchemaType.STRING, description: "2-3 word vibe description" },
                overview: { type: SchemaType.STRING, description: "2 sentence overview" },
                icebreaker: { type: SchemaType.STRING, description: "2 sentence cold outreach icebreaker" },
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
        model: 'gemini-2.5-flash',
        tools: [{ googleSearch: {} }],
        // CRITICAL FIX: Forcing JSON output directly stops the markdown backticks
        generationConfig: {
            responseMimeType: "application/json",
            responseSchema: schema,
        }
    });

    const prompt = `You are an expert web researcher for B2B lead generation.
Find exactly 25 real businesses in ${city}, ${zip}, ${country} for the industry: ${industry}.

Requirements:
1) Use web search to discover and verify real local businesses.
2) Return exactly 25 unique businesses.
3) Each object must include exact keys only.
4) phone/email/website must be real if available; otherwise return "Not Found".
5) rating must be a string like "4.5". reviews must be an integer.
6) vibe must be 2-3 words.
7) overview must be exactly 2 sentences describing online presence.
8) icebreaker must be exactly 2 sentences, personalized as a cold outreach opener.
9) sourceCity and sourceZip must correspond to where the business operates.`;

    const result = await model.generateContent(prompt);
    
    // Because we forced JSON MIME type, we don't need the brittle replace/split logic anymore
    const rawText = result.response.text().trim();
    const parsed = JSON.parse(rawText);

    if (!Array.isArray(parsed)) {
        throw new Error('Gemini response was not a JSON array.');
    }

    return parsed;
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

    let isFirstChunk = true;

    for (const target of cityZipList) {
        if (processedLeads.length >= MAX_TOTAL_LEADS) break;

        if (!isFirstChunk) {
            console.log(`⏳ Waiting 15 seconds to respect Gemini API rate limits...`);
            await delay(15000);
        }
        isFirstChunk = false;

        console.log(`🤖 Prospecting chunk: ${target.city}, ${target.zip} ...`);

        try {
            const aiLeads = await generateGroundedLeads(target.city, target.zip, country, industry);
            for (const candidate of aiLeads) {
                if (processedLeads.length >= MAX_TOTAL_LEADS) break;

                const normalized = normalizeLead(candidate);
                const normalizedBrand = normalized.name.toLowerCase().split(/[-|()]/)[0].trim();

                if (!normalizedBrand || seenBrands.has(normalizedBrand) || normalizedBrand.includes('mcdonalds')) continue;

                seenBrands.add(normalizedBrand);
                processedLeads.push(normalized);
            }
        } catch (error) {
            console.error(`❌ Gemini lead generation failed for ${target.city}:`, error.message);
            // Continue onto the next target chunk without failing the whole request
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