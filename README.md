# Ripster Live AI Analyzer

Real-time Ripster EMA Cloud strategy analyzer using live 10-min chart data.

## Deploy to Vercel (5 minutes, free)

### Step 1 — Get your Anthropic API key
1. Go to https://console.anthropic.com
2. Sign up / log in
3. Click "API Keys" → Create new key
4. Copy it (you'll need it in Step 4)

### Step 2 — Upload to GitHub
1. Go to https://github.com/new
2. Create a new repository (name it "ripster-live")
3. Upload all files from this folder

### Step 3 — Deploy on Vercel
1. Go to https://vercel.com and sign up with GitHub
2. Click "Add New Project"
3. Import your "ripster-live" GitHub repo
4. Click Deploy (leave all settings default)

### Step 4 — Add your API key
1. In Vercel dashboard → your project → Settings → Environment Variables
2. Add: Name = `ANTHROPIC_API_KEY`, Value = your key from Step 1
3. Click Save → go to Deployments → Redeploy

Your app is live! Vercel gives you a free URL like `ripster-live.vercel.app`

## How it works
- Fetches live 10-min bar data from Yahoo Finance (server-side, no CORS)
- Calculates all indicators: 34/50 EMA cloud, 5/13 cloud, 8/9 cross, VWAP, volume ratio
- Sends to Claude AI for Ripster strategy analysis
- Auto-refreshes on each new 10-min candle
- No API keys needed in the browser — all secure on the server

## Features
- Live win probability with grade (A+/A/B/C/No Trade)
- All 6 confluence scores with weighted bars  
- Real-time trade plan: entry, stop, 2 targets, R:R
- Position sizing recommendation
- Key risks + next candle watchlist
- Session signal history

## Supported Tickers
SPY, QQQ, NVDA, AAPL, AMD, META, TSLA, MSFT, AMZN, GOOGL + any custom ticker

---
NOT FINANCIAL ADVICE. FOR EDUCATIONAL PURPOSES ONLY. ALWAYS MANAGE YOUR RISK.
