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
const MAX_TARGETS = 10; // cap city/ZIP targets from Gemini
const MAX_PER_ZIP = 20; // per ZIP/area lead cap
const MAX_TOTAL_LEADS = 200; // global guardrail for free-tier limits

function normalizeUrl(url) {
    if (!url || typeof url !== 'string') return null;
    const trimmed = url.trim();
    if (!trimmed) return null;
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    if (/^(mailto:|tel:|javascript:)/i.test(trimmed)) return null;
    return `https://${trimmed}`;
}

function isGoogleDomain(url) {
    if (!url || typeof url !== 'string') return false;
    try {
        const parsed = new URL(normalizeUrl(url));
        return /(^|\.)google\./i.test(parsed.hostname);
    } catch {
        return false;
    }
}

function extractEmailsFromHtml(html) {
    if (!html || typeof html !== 'string') return [];

    const directMatches = html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
    const mailtoMatches = Array.from(html.matchAll(/mailto:([^"'\s>]+)/gi)).map(m => m[1]);
    const obfuscated = html.match(/[a-zA-Z0-9._%+-]+\s*(?:\[at\]|\(at\)|\sat\s)\s*[a-zA-Z0-9.-]+\s*(?:\[dot\]|\(dot\)|\sdot\s)\s*[a-zA-Z]{2,}/gi) || [];

    const decodedObfuscated = obfuscated.map(item =>
        item
            .replace(/\s*(\[at\]|\(at\)|\sat\s)\s*/gi, '@')
            .replace(/\s*(\[dot\]|\(dot\)|\sdot\s)\s*/gi, '.')
            .replace(/\s+/g, '')
    );

    return [...directMatches, ...mailtoMatches, ...decodedObfuscated]
        .map(e => e.trim().toLowerCase())
        .filter(e => /@/.test(e) && /\.[a-z]{2,}$/i.test(e))
        .filter(e => !/\.(png|jpg|jpeg|gif|webp|svg)$/i.test(e));
}

function pickBestEmail(emails) {
    if (!Array.isArray(emails) || emails.length === 0) return 'Not Found';
    const blacklist = ['example.com', 'email.com', 'domain.com', 'sentry.io'];
    const cleaned = [...new Set(emails)].filter(e => !blacklist.some(b => e.includes(b)));
    return cleaned[0] || 'Not Found';
}

async function getPlaceDetails(placeId) {
    if (!placeId) return null;
    const url = `https://serpapi.com/search.json?engine=google_maps_place&place_id=${encodeURIComponent(placeId)}&api_key=${SERPAPI_KEY}`;
    try {
        const response = await axios.get(url, { timeout: 8000 });
        return response.data?.place_results || null;
    } catch (error) {
        console.error(`⚠️ Place details lookup failed for place_id=${placeId}: ${error.message}`);
        return null;
    }
}

async function getTargetLeads({ country, city, zip, industry }) {
    const locationParts = [city, zip, country].filter(Boolean).join(' ');
    const query = `${industry} in ${locationParts}`;
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
        
        // Loosen filters: accept Google Maps fallbacks so we don't lose leads when SerpAPI omits website
        const filtered = data.local_results
            .map(biz => {
                const reviewsCount = typeof biz.reviews === 'number' ? biz.reviews : (biz.user_ratings_total || 0);
                const websiteUrl = normalizeUrl(
                    biz.website
                    || biz.link
                    || (biz.links && biz.links.website)
                    || biz.google_maps_link
                    || biz.share_link
                    || (biz.place_id ? `https://www.google.com/maps/place/?q=place_id:${biz.place_id}` : null)
                    || (biz.cid ? `https://www.google.com/maps?cid=${biz.cid}` : null)
                );

                // Normalize so downstream code always has something usable
                return { ...biz, reviewsCount, website: websiteUrl };
            })
            .filter(biz => {
                const hasUrl = !!biz.website;
                return hasUrl && biz.reviewsCount >= 0 && biz.reviewsCount <= 2000;
            });
        console.log(`✅ Filtered results (has site/link/maps, 0-2000 reviews): ${filtered.length}`);
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
        const normalized = normalizeUrl(url);
        if (!normalized) return { pageText: '', email: 'Not Found' };

        const { data } = await axios.get(normalized, {
            timeout: 9000,
            maxRedirects: 5,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
            }
        });

        const $ = cheerio.load(data);
        const pageText = $('body').text().replace(/\s+/g, ' ').trim().substring(0, 3000);

        let foundEmails = extractEmailsFromHtml(data);

        // Fallback: crawl one likely contact page on the same site when homepage has no email.
        if (foundEmails.length === 0) {
            const contactHref = $('a[href]').toArray()
                .map(el => $(el).attr('href'))
                .find(href => href && /(contact|about|support|get-in-touch|impressum)/i.test(href));

            if (contactHref) {
                try {
                    const contactUrl = new URL(contactHref, normalized).toString();
                    const { data: contactHtml } = await axios.get(contactUrl, {
                        timeout: 7000,
                        maxRedirects: 5,
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
                        }
                    });
                    foundEmails = extractEmailsFromHtml(contactHtml);
                } catch {
                    // Ignore contact-page fetch errors and keep Not Found fallback.
                }
            }
        }

        const email = pickBestEmail(foundEmails);
        return { pageText, email };
    } catch (error) { return { pageText: '', email: 'Not Found' }; }
}

async function generateAgencyPitch(businessName, websiteText) {
    if (!websiteText || websiteText.length < 50) return { vibe: 'Unknown', overview: 'Quick scan suggests an online presence that could benefit from a fresh audit.', icebreaker: 'Loved checking out your local presence.' };
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const prompt = `You are a strategic sales partner for a web agency called Redmun. Analyze this text for ${businessName}:\n${websiteText}\nTask: 1. Vibe (2-3 words) 2. Overview (2 sentences about their current online stage/strengths/gaps) 3. Icebreaker (2 sentences). Format strictly: [Vibe] | [Overview] | [Icebreaker]`;
    try {
        const result = await model.generateContent(prompt);
        const parts = result.response.text().trim().split('|');
        return { vibe: parts[0]?.trim() || 'N/A', overview: parts[1]?.trim() || 'N/A', icebreaker: parts[2]?.trim() || 'N/A' };
    } catch (error) { return { vibe: 'Error', overview: 'Error', icebreaker: 'Error' }; }
}

async function generateCityZipList(country) {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const prompt = `Country: ${country}
Return a JSON array (no prose) with up to ${MAX_TARGETS} major cities and representative postal/ZIP codes.
Format: [{"city":"City Name","zip":"ZIP or Postcode"}]
Use real, valid postal codes; if unavailable, set zip to "".`;

    try {
        const result = await model.generateContent(prompt);
        const text = result.response.text().trim();
        const jsonText = text.startsWith('[') ? text : text.substring(text.indexOf('['));
        const parsed = JSON.parse(jsonText);
        if (Array.isArray(parsed)) {
            return parsed
                .slice(0, MAX_TARGETS)
                .map(item => ({
                    city: (item.city || '').toString().trim(),
                    zip: (item.zip || '').toString().trim()
                }))
                .filter(item => item.city);
        }
    } catch (error) {
        console.error('❌ Gemini city/ZIP parse error:', error.message);
    }

    return [];
}

// --- The Main API Endpoint ---
app.post('/api/generate-leads', async (req, res) => {
    const { country, industry } = req.body;
    
    console.log(`\n🚀 API Request: country="${country}", industry="${industry}"`);
    
    if (!country || !industry) {
        return res.status(400).json({ error: "Country and industry are required." });
    }

    // Security/Validation: Prevent targeting UK agency's restricted regions
    const restrictedRegions = ['bangladesh', 'bd', 'india', 'in'];
    const loweredCountry = country.toLowerCase();
    if (restrictedRegions.some(region => new RegExp(`\\b${region}\\b`, 'i').test(loweredCountry))) {
        return res.status(400).json({ error: "Target region restricted by agency policy." });
    }

    let cityZipList = await generateCityZipList(country);
    if (!cityZipList.length) {
        console.log('⚠️ Gemini returned no city/ZIP pairs, falling back to country-level search');
        cityZipList = [{ city: country, zip: '' }];
    }

    const timestamp = Date.now();
    const outputFile = `leads_${country.replace(/\s+/g, '_')}_${timestamp}.csv`;
    const outputFilePath = path.join(__dirname, 'public', outputFile);
    const locationsFile = `searched_locations_${country.replace(/\s+/g, '_')}_${timestamp}.csv`;
    const locationsFilePath = path.join(__dirname, 'public', locationsFile);
    
    fs.writeFileSync(outputFilePath, '"Business Name","Phone","Email","Website","Reviews","Vibe","Overview","Icebreaker","Source City","Source ZIP"\n');
    fs.writeFileSync(locationsFilePath, '"City","ZIP/Postcode"\n');

    const seenBrands = new Set();
    let processedCount = 0;
    const processedLeads = [];

    for (const target of cityZipList) {
        if (processedCount >= MAX_TOTAL_LEADS) break;

        fs.appendFileSync(locationsFilePath, `"${target.city.replace(/"/g, '""')}","${(target.zip || 'N/A').replace(/"/g, '""')}"\n`);

        let leadsForTarget = [];
        try {
            leadsForTarget = await getTargetLeads({ country, city: target.city, zip: target.zip, industry });
        } catch (err) {
            console.error(`❌ SerpAPI error for ${target.city} ${target.zip}:`, err.message);
            continue;
        }

        let perZipCount = 0;
        for (const lead of leadsForTarget) {
            if (processedCount >= MAX_TOTAL_LEADS || perZipCount >= MAX_PER_ZIP) break;

            const name = lead.title || 'N/A';
            const normalizedBrand = name.toLowerCase().split(/[-|()]/)[0].trim();

            if (seenBrands.has(normalizedBrand) || normalizedBrand.includes('mcdonalds')) continue;
            seenBrands.add(normalizedBrand);

            const mapsFallback = normalizeUrl(
                lead.google_maps_link
                || lead.share_link
                || (lead.place_id ? `https://www.google.com/maps/place/?q=place_id:${lead.place_id}` : null)
                || (lead.cid ? `https://www.google.com/maps?cid=${lead.cid}` : null)
            );

            let websiteUrl = normalizeUrl(
                lead.website
                || lead.link
                || (lead.links && lead.links.website)
                || lead.canonical_page_url
            );

            // If the only URL is a Google URL, request place details and try to recover the business website.
            if ((!websiteUrl || isGoogleDomain(websiteUrl)) && lead.place_id) {
                const placeDetails = await getPlaceDetails(lead.place_id);
                const detailWebsite = normalizeUrl(
                    placeDetails?.website
                    || placeDetails?.link
                    || placeDetails?.url
                );
                if (detailWebsite && !isGoogleDomain(detailWebsite)) {
                    websiteUrl = detailWebsite;
                }
            }

            if (!websiteUrl && mapsFallback) {
                websiteUrl = mapsFallback;
            }

            const finalWebsite = websiteUrl || 'N/A';

            const scrapeUrl = finalWebsite !== 'N/A' ? normalizeUrl(finalWebsite) : null;
            const { pageText, email } = scrapeUrl ? await scrapeWebsiteData(scrapeUrl) : { pageText: '', email: 'Not Found' };
            const strategy = await generateAgencyPitch(name, pageText);

            const leadData = {
                name,
                phone: lead.phone || 'N/A',
                email,
                website: finalWebsite,
                reviews: lead.reviews,
                rating: lead.rating,
                vibe: strategy.vibe,
                overview: strategy.overview,
                icebreaker: strategy.icebreaker,
                sourceCity: target.city,
                sourceZip: target.zip || 'N/A'
            };
            processedLeads.push(leadData);

            const safeName = `"${name.replace(/"/g, '""')}"`;
            const phone = lead.phone || 'N/A';
            const ratingStr = `${lead.rating || 'N/A'} (${lead.reviews || lead.user_ratings_total || 'N/A'})`;
            const safeVibe = `"${(strategy.vibe || '').replace(/"/g, '""')}"`;
            const safeOverview = `"${(strategy.overview || '').replace(/"/g, '""')}"`;
            const safeIcebreaker = `"${(strategy.icebreaker || '').replace(/"/g, '""')}"`;
            const safeCity = `"${target.city.replace(/"/g, '""')}"`;
            const safeZip = `"${(target.zip || 'N/A').replace(/"/g, '""')}"`;

            const csvRow = `${safeName},"${phone}","${email}","${finalWebsite}","${ratingStr}",${safeVibe},${safeOverview},${safeIcebreaker},${safeCity},${safeZip}\n`;
            fs.appendFileSync(outputFilePath, csvRow);

            processedCount++;
            perZipCount++;
        }
    }

    if (processedLeads.length === 0) {
        return res.status(404).json({ error: "No leads found for the generated city/ZIP list." });
    }

    res.json({
        success: true,
        downloadUrl: `/${outputFile}`,
        locationsDownload: `/${locationsFile}`,
        count: processedCount,
        leads: processedLeads,
        targets: cityZipList
    });
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`\n🚀 Redmun Lead Generator running on http://localhost:${PORT}`);
    console.log(`✅ GEMINI_API_KEY: ${process.env.GEMINI_API_KEY ? '✓ Configured' : '❌ MISSING'}`);
    console.log(`✅ SERPAPI_KEY: ${process.env.SERPAPI_KEY ? '✓ Configured' : '❌ MISSING'}`);
    console.log(`📖 Open your browser and navigate to http://localhost:${PORT}\n`);
});