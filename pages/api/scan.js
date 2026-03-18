export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  const { tickers } = req.body;
  if (!tickers?.length) return res.status(400).json({ error: "tickers required" });

  const apiKey    = process.env.ALPACA_API_KEY;
  const apiSecret = process.env.ALPACA_API_SECRET;
  if (!apiKey || !apiSecret) return res.status(500).json({ error: "Alpaca keys not set" });

  const headers = { "APCA-API-KEY-ID": apiKey, "APCA-API-SECRET-KEY": apiSecret };

  function calcEMA(closes, period) {
    if (closes.length < period) return null;
    const k = 2 / (period + 1);
    let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
    return ema;
  }

  function scoreSetup(bars) {
    if (!bars || bars.length < 20) return null;
    const closes  = bars.map(b => b.c);
    const latest  = bars[bars.length - 1];
    const prev    = bars[bars.length - 2];
    const ema8    = calcEMA(closes, 8);
    const ema9    = calcEMA(closes, 9);
    const ema5    = calcEMA(closes, 5);
    const ema13   = calcEMA(closes, 13);
    const ema34   = calcEMA(closes, 34);
    const ema50   = calcEMA(closes, 50);
    if (!ema34 || !ema50) return null;

    const cloudTop     = Math.max(ema34, ema50);
    const cloudBot     = Math.min(ema34, ema50);
    const priceVsCloud = latest.c > cloudTop ? "ABOVE" : latest.c < cloudBot ? "BELOW" : "INSIDE";
    const cloud3450    = ema34 > ema50 ? "BULLISH" : "BEARISH";
    const cloud513     = ema5 && ema13 ? (ema5 > ema13 ? "BULLISH" : "BEARISH") : null;
    const cross89      = ema8 && ema9  ? (ema8  > ema9  ? "BULLISH" : "BEARISH") : null;

    // VWAP from today's session
    const today = latest.t.substring(0, 10);
    const todayBars = bars.filter(b => {
      if (!b.t.startsWith(today)) return false;
      const h = parseInt(b.t.substring(11, 13));
      const m = parseInt(b.t.substring(14, 16));
      return h > 13 || (h === 13 && m >= 30);
    });
    let vwap = null;
    if (todayBars.length) {
      let tv = 0, vol = 0;
      for (const b of todayBars) { const tp = (b.h + b.l + b.c) / 3; tv += tp * b.v; vol += b.v; }
      vwap = vol ? tv / vol : null;
    }

    const avgVol     = bars.slice(-21, -1).reduce((a, b) => a + b.v, 0) / 20;
    const rvol       = avgVol ? latest.v / avgVol : null;
    const priceChange = prev ? ((latest.c - prev.c) / prev.c) * 100 : 0;
    const bodyRatio  = Math.abs(latest.c - latest.o) / ((latest.h - latest.l) || 0.001);

    // 10m is king — score direction
    let longScore = 0, shortScore = 0;

    // Long scoring
    if (priceVsCloud === "ABOVE") longScore += 2;
    if (cloud3450    === "BULLISH") longScore += 1;
    if (cloud513     === "BULLISH") longScore += 1;
    if (cross89      === "BULLISH") longScore += 1;
    if (vwap && latest.c > vwap)    longScore += 1;
    if (rvol && rvol > 1.0)         longScore += 1;

    // Short scoring
    if (priceVsCloud === "BELOW")  shortScore += 2;
    if (cloud3450    === "BEARISH") shortScore += 1;
    if (cloud513     === "BEARISH") shortScore += 1;
    if (cross89      === "BEARISH") shortScore += 1;
    if (vwap && latest.c < vwap)    shortScore += 1;
    if (rvol && rvol > 1.0)         shortScore += 1;

    if (priceVsCloud === "INSIDE") return null; // always no trade inside cloud

    const direction = longScore > shortScore + 1 ? "LONG"
      : shortScore > longScore + 1 ? "SHORT"
      : null;

    if (!direction) return null; // chop

    const score = Math.max(longScore, shortScore);
    const grade = score >= 6 ? "A+" : score >= 5 ? "A" : score >= 4 ? "B" : "C";
    const probability = score >= 6 ? 88 : score >= 5 ? 76 : score >= 4 ? 62 : 45;

    if (probability < 45) return null;

    return {
      price: latest.c,
      priceChange: priceChange.toFixed(2),
      direction, grade, probability,
      longScore, shortScore,
      rvol: rvol ? parseFloat(rvol.toFixed(1)) : null,
      cloud3450, priceVsCloud, cloud513, cross89,
      vwap: vwap ? parseFloat(vwap.toFixed(2)) : null,
      bodyRatio: parseFloat(bodyRatio.toFixed(2)),
      ema34: parseFloat(ema34.toFixed(2)),
      ema50: parseFloat(ema50.toFixed(2)),
      ema8:  ema8  ? parseFloat(ema8.toFixed(2))  : null,
      ema9:  ema9  ? parseFloat(ema9.toFixed(2))  : null,
    };
  }

  const now     = new Date();
  const start   = new Date(now); start.setDate(now.getDate() - 30);
  const startStr = start.toISOString().split("T")[0];
  const results = [];

  // Process in batches of 5 to avoid rate limits
  const batchSize = 5;
  for (let i = 0; i < tickers.length; i += batchSize) {
    const batch = tickers.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(async (ticker) => {
      try {
        const r = await fetch(
          `https://data.alpaca.markets/v2/stocks/${ticker}/bars?timeframe=10Min&start=${startStr}&limit=200&sort=asc&feed=sip`,
          { headers }
        );
        if (!r.ok) return null;
        const d    = await r.json();
        const bars = (d.bars || []).map(b => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
        const setup = scoreSetup(bars);
        if (!setup) return null;
        return { ticker, ...setup };
      } catch { return null; }
    }));
    results.push(...batchResults.filter(Boolean));
  }

  const setups = results.sort((a, b) => b.probability - a.probability);
  res.status(200).json({ setups, scanned: tickers.length, found: setups.length });
}
