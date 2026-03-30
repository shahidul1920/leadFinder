# 🚀 Redmun Lead Generator

An AI-powered lead generation tool that finds local businesses and generates personalized sales pitches using Google's Gemini AI.

## 📋 Features

- **Local Business Search**: Find businesses in any location and industry using SerpAPI
- **AI-Powered Analysis**: Analyze websites and generate personalized pitches with Gemini AI
- **Web UI Dashboard**: Beautiful, responsive web interface for easy lead discovery
- **CSV Export**: Download all leads as a CSV file for further analysis
- **Real-time Processing**: See leads populate as they're being analyzed
- **Email Extraction**: Automatically extract contact emails from websites
- **Custom Pitch Generation**: Get unique vibes, pitch angles, and icebreakers for each lead

## 🎯 How It Works

1. **Search Query**: Enter a location and industry (e.g., "restaurants in Cardiff")
2. **Find Businesses**: SerpAPI finds local businesses matching your criteria (30-400 reviews)
3. **Website Analysis**: Tools scrape website content to understand the business
4. **AI Generation**: Gemini AI generates:
   - **Vibe**: 2-3 word description of the business
   - **Pitch Angle**: Identified weakness or opportunity
   - **Icebreaker**: First two sentences of a personalized cold email
5. **Export**: Download results as CSV or view in the web dashboard

## 🛠 Installation

### Prerequisites
- Node.js (v14+)
- npm or yarn
- API Keys:
  - [SerpAPI Key](https://serpapi.com/) - For local business search
  - [Google Gemini API Key](https://makersuite.google.com/app/apikey) - For AI analysis

### Setup

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd leadFinder
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Create `.env` file**
   ```bash
   cp .env.example .env
   ```

4. **Add your API keys to `.env`**
   ```
   GEMINI_API_KEY=your_gemini_api_key_here
   SERPAPI_KEY=your_serpapi_key_here
   ```

## 🚀 Usage

### Web UI (Recommended)

Start the web server:
```bash
npm start
```

Open your browser and navigate to:
```
http://localhost:3000
```

Then:
1. Enter a location (e.g., "Cardiff", "London")
2. Enter an industry (e.g., "restaurants", "hotels", "fitness")
3. Click "Generate Leads"
4. View results in real-time
5. Download CSV when complete

### Command Line (Legacy)

```bash
npm run cli "Location" "Industry"

# Example:
npm run cli "Cardiff" "restaurants"
```

This generates a file like `redmun_leads_Cardiff.csv`

## 📁 Project Structure

```
leadFinder/
├── server.js           # Express server (if separate file exists)
├── leadGen.js          # Main server and API logic
├── public/
│   ├── index.html      # Web UI
│   ├── style.css       # Styling
│   ├── script.js       # Frontend logic
│   └── [generated CSV files]
├── .env                # API keys (not in git)
├── .gitignore          # Git ignore rules
├── package.json        # Dependencies
└── README.md           # This file
```

## 🔑 Environment Variables

Create a `.env` file in the root directory:

```
GEMINI_API_KEY=your_key_here
SERPAPI_KEY=your_key_here
```

## 📊 CSV Output Format

The generated CSV includes these columns:
- **Business Name**: Name of the business
- **Phone**: Contact phone number
- **Email**: Extracted email address
- **Website**: Business website URL
- **Reviews**: Rating and review count (e.g., "4.5 (285)")
- **Vibe**: AI-determined business vibe
- **Pitch Angle**: Identified improvement opportunity
- **Icebreaker**: First two sentences of personalized pitch

## ⚙️ Configuration

### Filtering Criteria
The tool filters businesses for:
- **Review Range**: 30 to 400 reviews (excludes new and massive franchises)
- **Website Required**: Only businesses with listed websites
- **Franchise Exclusion**: Skips major franchises (McDonald's, Subway, KFC, etc.)

### Rate Limiting
- 2-second delay between API calls to be respectful to servers
- Max 10 leads per search in web UI (to prevent timeouts)
- No limit in CLI mode

## 🛡 Security & Restrictions

- UK agency policy: Some regions are restricted (Bangladesh, India)
- Email validation: Filters out fake email addresses
- All data is processed locally and not stored permanently

## 🐛 Troubleshooting

### "No leads found"
- Try a larger or different location
- Verify the industry name is spelled correctly
- Check if the region is restricted

### "Email not found"
- Not all businesses have their email on their website
- Manual research may be needed

### API Errors
- Verify your API keys are correct in `.env`
- Check SerpAPI and Gemini API billing/rate limits
- Ensure you have internet connectivity

## 📈 Performance Tips

- Search in larger cities for more results
- Use specific industries (e.g., "dental offices" not "health")
- The process takes 20-100 seconds depending on scraping speed

## 🤝 Contributing

Contributions welcome! Feel free to:
- Report bugs
- Suggest features
- Submit pull requests

## 📄 License

MIT License - See LICENSE file for details

## 📧 Support

For issues or questions:
1. Check the Troubleshooting section
2. Review API documentation:
   - [SerpAPI Docs](https://serpapi.com/docs)
   - [Google Gemini API Docs](https://ai.google.dev/docs)
3. Create an issue in the repository

---

**Built by Redmun** - Your lead generation partner 🎯
