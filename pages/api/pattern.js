// Pattern Similarity Engine
// Takes last N candles, finds similar historical patterns, shows what happened next

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  const { ticker, lookback = 10, forward = 5 } = req.body;
  if (!ticker) return res.status(400).json({ error: "ticker required" });

  const apiKey    = process.env.ALPACA_API_KEY;
  const apiSecret = process.env.ALPACA_API_SECRET;
  if (!apiKey || !apiSecret) return res.status(500).json({ error: "Alpaca keys not set" });

  const headers = { "APCA-API-KEY-ID": apiKey, "APCA-API-SECRET-KEY": apiSecret };

  try {
    // Fetch 6 months of 10-min bars for pattern matching
    const now   = new Date();
    const start = new Date(now); start.setDate(now.getDate() - 180);
    const startStr = start.toISOString().split("T")[0];

    const r = await fetch(
      `https://data.alpaca.markets/v2/stocks/${ticker}/bars?timeframe=10Min&start=${startStr}&limit=2000&sort=asc&feed=sip`,
      { headers }
    );
    if (!r.ok) throw new Error(`Alpaca error ${r.status}`);
    const d    = await r.json();
    const bars = (d.bars || []).map(b => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));

    if (bars.length < lookback + forward + 10) {
      throw new Error("Not enough historical data for pattern matching");
    }

    // Normalize a window of bars to percentage changes relative to first bar
    function normalize(window) {
      const base = window[0].c;
      return window.map(b => ({
        c: (b.c - base) / base,
        h: (b.h - base) / base,
        l: (b.l - base) / base,
        body: (b.c - b.o) / base,
        vol: b.v,
      }));
    }

    // Euclidean distance between two normalized patterns
    function distance(a, b) {
      let sum = 0;
      for (let i = 0; i < a.length; i++) {
        const dc = (a[i].c - b[i].c) ** 2;
        const db = (a[i].body - b[i].body) ** 2;
        sum += dc * 2 + db; // weight close price more
      }
      return Math.sqrt(sum / a.length);
    }

    // Volume ratio similarity (normalized 0-1)
    function volSimilarity(a, b) {
      const avgA = a.reduce((s, x) => s + x.vol, 0) / a.length;
      const avgB = b.reduce((s, x) => s + x.vol, 0) / b.length;
      const ratio = Math.min(avgA, avgB) / Math.max(avgA, avgB);
      return ratio; // 1 = identical volume profile
    }

    // Current pattern = last `lookback` bars
    const currentWindow = bars.slice(-lookback);
    const currentNorm   = normalize(currentWindow);
    const currentPrice  = currentWindow[currentWindow.length - 1].c;

    // Scan all historical windows (skip last lookback+forward bars to avoid using current)
    const matches = [];
    const searchEnd = bars.length - lookback - forward - 1;

    for (let i = lookback; i < searchEnd; i++) {
      const histWindow = bars.slice(i - lookback, i);
      const histNorm   = normalize(histWindow);
      const dist       = distance(currentNorm, histNorm);
      const volSim     = volSimilarity(currentNorm, histNorm);

      // Combined similarity score (lower distance = more similar)
      const similarity = (1 / (1 + dist * 10)) * 0.7 + volSim * 0.3;

      matches.push({ i, dist, similarity, volSim });
    }

    // Sort by similarity, take top 20
    matches.sort((a, b) => b.similarity - a.similarity);
    const top = matches.slice(0, 20);

    // For each match, look at what happened in the next `forward` bars
    const outcomes = top.map(({ i, similarity, dist }) => {
      const entryBar    = bars[i];
      const futureSlice = bars.slice(i, i + forward);
      const entryPrice  = entryBar.c;
      const exitPrice   = futureSlice[futureSlice.length - 1].c;
      const maxHigh     = Math.max(...futureSlice.map(b => b.h));
      const minLow      = Math.min(...futureSlice.map(b => b.l));
      const pnlPct      = ((exitPrice - entryPrice) / entryPrice) * 100;
      const maxUp       = ((maxHigh - entryPrice) / entryPrice) * 100;
      const maxDown     = ((minLow - entryPrice) / entryPrice) * 100;

      return {
        date: entryBar.t.substring(0, 10),
        time: entryBar.t.substring(11, 16),
        entryPrice: parseFloat(entryPrice.toFixed(2)),
        exitPrice:  parseFloat(exitPrice.toFixed(2)),
        pnlPct:     parseFloat(pnlPct.toFixed(2)),
        maxUp:      parseFloat(maxUp.toFixed(2)),
        maxDown:    parseFloat(maxDown.toFixed(2)),
        similarity: parseFloat((similarity * 100).toFixed(1)),
        bullish:    pnlPct > 0,
      };
    });

    // Stats
    const bullishCount = outcomes.filter(o => o.bullish).length;
    const bearishCount = outcomes.length - bullishCount;
    const winRate      = (bullishCount / outcomes.length) * 100;
    const avgPnl       = outcomes.reduce((s, o) => s + o.pnlPct, 0) / outcomes.length;
    const avgMaxUp     = outcomes.reduce((s, o) => s + o.maxUp, 0) / outcomes.length;
    const avgMaxDown   = outcomes.reduce((s, o) => s + o.maxDown, 0) / outcomes.length;
    const bestCase     = Math.max(...outcomes.map(o => o.maxUp));
    const worstCase    = Math.min(...outcomes.map(o => o.maxDown));
    const avgSimilarity = outcomes.reduce((s, o) => s + o.similarity, 0) / outcomes.length;

    // Grade the pattern
    const patternGrade = winRate >= 70 && avgPnl > 0.3 ? "A+"
      : winRate >= 60 && avgPnl > 0.1 ? "A"
      : winRate >= 50 ? "B"
      : winRate >= 40 ? "C"
      : "No Edge";

    const bias = winRate >= 55 ? "BULLISH" : winRate <= 45 ? "BEARISH" : "NEUTRAL";

    res.status(200).json({
      ticker,
      currentPrice: parseFloat(currentPrice.toFixed(2)),
      lookback,
      forward,
      patternsFound: outcomes.length,
      avgSimilarity: parseFloat(avgSimilarity.toFixed(1)),
      stats: {
        winRate:    parseFloat(winRate.toFixed(1)),
        avgPnl:     parseFloat(avgPnl.toFixed(2)),
        avgMaxUp:   parseFloat(avgMaxUp.toFixed(2)),
        avgMaxDown: parseFloat(avgMaxDown.toFixed(2)),
        bestCase:   parseFloat(bestCase.toFixed(2)),
        worstCase:  parseFloat(worstCase.toFixed(2)),
        bullishCount, bearishCount,
      },
      patternGrade,
      bias,
      topMatches: outcomes.slice(0, 10),
      historicalBarsUsed: bars.length,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
