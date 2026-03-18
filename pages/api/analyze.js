const SYSTEM = `You are Ripster's AI trading co-pilot. You analyze MULTI-TIMEFRAME live data using the full Ripster EMA Cloud strategy. Be direct and decisive.

FULL RIPSTER STRATEGY:

1. DAILY BIAS:
   - Daily EMA cloud direction (34/50): bullish above, bearish below
   - Gap up/down from previous close
   - Price vs PDH/PDL and PMH/PML
   - Pre-market volume gives conviction clues

2. MULTI-TIMEFRAME EMA CLOUD ANALYSIS:
   - Daily: Macro trend. Sets overall bias.
   - 30-min: Intermediate trend. Confirms daily.
   - 10-min: PRIMARY timeframe. Main signal.
   - 5-min: Entry refinement.
   - 1-min: Entry timing only.

3. MTF CONFLUENCE SCORE (0-5):
   5/5 = A+, 4/5 = A, 3/5 = B, 2/5 = C, 1/5 or less = No Trade
   Always evaluate both LONG and SHORT independently.

4. VWAP: If VWAP data is unavailable, score it NEUTRAL (5/10). Do NOT score 0/10. Use EMA clouds and key levels as primary bias.

5. VOLUME:
   - RVOL > 2x = strong conviction
   - RVOL 1.5-2x = good
   - RVOL 1.0-1.5x = average, proceed with caution
   - RVOL < 1x = weak, reduce size but do NOT block the signal

6. LONG SETUP — score each, signal if 4+ met:
   - Price ABOVE 34/50 cloud on 10m (non-negotiable, worth 2 points)
   - 34/50 cloud is GREEN (34 EMA > 50 EMA)
   - 5/13 cloud bullish on 10m
   - 8 EMA above 9 EMA
   - Price above VWAP (skip scoring if no VWAP)
   - RVOL > 1.0x
   - PMH or PDH break with volume = bonus A+ trigger
   Score 4+ = LONG. Score 3 = C grade LONG. Score 2 or less = No Trade.

7. SHORT SETUP — score each, signal if 4+ met:
   - Price BELOW 34/50 cloud on 10m (non-negotiable, worth 2 points)
   - 34/50 cloud is RED (50 EMA > 34 EMA)
   - 5/13 cloud bearish on 10m
   - 8 EMA below 9 EMA
   - Price below VWAP (skip scoring if no VWAP)
   - RVOL > 1.0x
   - PML or PDL break with volume = bonus A+ trigger
   Score 4+ = SHORT. Score 3 = C grade SHORT. Score 2 or less = No Trade.

8. MIXED SIGNALS RULE:
   - If LONG score and SHORT score within 1 point = No Trade (chop)
   - If one direction leads by 2+ points = call that direction even if imperfect
   - Price INSIDE the 34/50 cloud on 10m = always No Trade
   - NEVER default to No Trade just because one indicator is missing data

9. POSITION SIZING: A+ = Full, A = Full, B = Half, C = Quarter, No Trade = No Trade

WIN PROBABILITY:
- A+ (5/5 MTF + strong volume + clean price action) = 85-95%
- A  (4/5 MTF + good volume) = 70-84%
- B  (3/5 MTF or weak volume) = 55-69%
- C  (2/5 MTF, marginal setup) = 35-54%
- No Trade = 0-34%

Respond ONLY with valid JSON, zero markdown:
{
  "probability": <0-100>,
  "grade": "<A+|A|B|C|No Trade>",
  "direction": "<LONG|SHORT|NO TRADE>",
  "signal": "<punchy one-liner — what is this setup RIGHT NOW>",
  "action": "<exact action to take right now>",
  "entry": "<entry condition or price>",
  "stop": "<stop loss level>",
  "target1": "<first target>",
  "target2": "<second target>",
  "rr": "<risk:reward>",
  "sizing": "<Full|Half|Quarter|No Trade>",
  "dailyBias": "<BULLISH|BEARISH|NEUTRAL>",
  "longScore": <0-7>,
  "shortScore": <0-7>,
  "mtfAlignment": {
    "daily": "<BULL|BEAR|NEUTRAL|MIXED>",
    "thirtyMin": "<BULL|BEAR|NEUTRAL|MIXED>",
    "tenMin": "<BULL|BEAR|NEUTRAL|MIXED>",
    "fiveMin": "<BULL|BEAR|NEUTRAL|MIXED>",
    "oneMin": "<BULL|BEAR|NEUTRAL|MIXED>",
    "score": <0-5>
  },
  "scores": {
    "dailyTrend": <0-10>,
    "cloud3450_10m": <0-10>,
    "cloud513_10m": <0-10>,
    "cross89": <0-10>,
    "vwap": <0-10>,
    "volume": <0-10>,
    "priceAction": <0-10>,
    "keyLevels": <0-10>,
    "mtfConfluence": <0-10>
  },
  "keyLevels": {
    "pdh": "<price or N/A>",
    "pdl": "<price or N/A>",
    "pmh": "<price or N/A>",
    "pml": "<price or N/A>",
    "hod": "<price>",
    "lod": "<price>",
    "vwap": "<price or N/A>",
    "resistance": "<nearest resistance>",
    "support": "<nearest support>"
  },
  "volumeAnalysis": "<one sentence on volume story>",
  "verdict": "<3-4 sentences in Ripster voice — explain exactly why LONG or SHORT or No Trade, be specific>",
  "risks": ["<risk>", "<risk>", "<risk>"],
  "nextWatch": "<what to watch on the NEXT candle>"
}`;

// ─── CALCULATIONS ─────────────────────────────────────────────────────────────

function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}

function calcVWAP(bars) {
  if (!bars || !bars.length) return {};
  let cumTPV = 0, cumVol = 0, cumTPV2 = 0;
  for (const b of bars) {
    const tp = (b.h + b.l + b.c) / 3;
    cumTPV += tp * b.v;
    cumVol += b.v;
    cumTPV2 += tp * tp * b.v;
  }
  const vwap = cumVol ? cumTPV / cumVol : null;
  const sd = Math.sqrt(Math.max(0, cumVol ? cumTPV2 / cumVol - vwap * vwap : 0));
  return { vwap, upper1: vwap + sd, lower1: vwap - sd, upper2: vwap + 2 * sd, lower2: vwap - 2 * sd };
}

function getTodayBars(bars) {
  if (!bars || !bars.length) return [];
  // Use the last bar's date as session date to avoid UTC timezone issues
  const lastBar = bars[bars.length - 1];
  const sessionDate = lastBar.t.substring(0, 10);
  // Only include bars from session date AND after 9:30 AM ET (13:30 UTC)
  return bars.filter(b => {
    if (!b.t.startsWith(sessionDate)) return false;
    const hour = parseInt(b.t.substring(11, 13));
    const min  = parseInt(b.t.substring(14, 16));
    return hour > 13 || (hour === 13 && min >= 30);
  });
}

function calcTFIndicators(bars) {
  if (!bars || !bars.length) return null;
  const closes = bars.map(b => b.c);
  const latest = bars[bars.length - 1];
  const prev   = bars.length > 1 ? bars[bars.length - 2] : null;

  const ema8  = calcEMA(closes, 8);
  const ema9  = calcEMA(closes, 9);
  const ema5  = calcEMA(closes, 5);
  const ema13 = calcEMA(closes, 13);
  const ema34 = calcEMA(closes, 34);
  const ema50 = calcEMA(closes, 50);

  const cloudTop = ema34 && ema50 ? Math.max(ema34, ema50) : null;
  const cloudBot = ema34 && ema50 ? Math.min(ema34, ema50) : null;

  const avgVol = bars.length > 2
    ? bars.slice(-Math.min(21, bars.length) - 1, -1).reduce((a, b) => a + b.v, 0) / Math.min(20, bars.length - 1)
    : null;

  return {
    price: latest.c, open: latest.o, high: latest.h, low: latest.l,
    volume: latest.v, time: latest.t,
    priceChange: prev ? latest.c - prev.c : 0,
    pricePct:    prev ? ((latest.c - prev.c) / prev.c) * 100 : 0,
    ema8, ema9, ema5, ema13, ema34, ema50,
    cloud3450: ema34 && ema50 ? (ema34 > ema50 ? "BULLISH" : "BEARISH") : "UNKNOWN",
    priceVsCloud: cloudTop && cloudBot
      ? (latest.c > cloudTop ? "ABOVE" : latest.c < cloudBot ? "BELOW" : "INSIDE")
      : "UNKNOWN",
    cloud513: ema5 && ema13 ? (ema5 > ema13 ? "BULLISH" : "BEARISH") : "UNKNOWN",
    cross89:  ema8 && ema9  ? (ema8  > ema9  ? "BULLISH" : "BEARISH") : "UNKNOWN",
    avgVol,
    rvol: avgVol && latest.v ? latest.v / avgVol : null,
    bodyRatio: Math.abs(latest.c - latest.o) / ((latest.h - latest.l) || 0.0001),
    isBull: latest.c >= latest.o,
  };
}

const f = (n, d = 2) => n != null && !isNaN(n) ? Number(n).toFixed(d) : "N/A";

// ─── HANDLER ──────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const { allBars, ticker, livePrice } = req.body;
  if (!allBars) return res.status(400).json({ error: "allBars required" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set." });

  const { bars1m, bars5m, bars10m, bars30m, barsDay } = allBars;

  // Pre-market levels
  const preMarket = allBars.preMarket || {};
  const pmHigh = preMarket.high   ? f(preMarket.high)                         : "N/A";
  const pmLow  = preMarket.low    ? f(preMarket.low)                          : "N/A";
  const pmVol  = preMarket.volume ? Number(preMarket.volume).toLocaleString() : "N/A";
  const pmBars = preMarket.bars   || 0;

  // Indicators for all timeframes
  const tf1m  = calcTFIndicators(bars1m);
  const tf5m  = calcTFIndicators(bars5m);
  const tf10m = calcTFIndicators(bars10m);
  const tf30m = calcTFIndicators(bars30m);
  const tfDay = calcTFIndicators(barsDay);

  // VWAP from today's regular session bars only
  const todayBars = getTodayBars(bars10m);
  const { vwap, upper1, lower1, upper2, lower2 } = calcVWAP(todayBars);
  const vwapValid = vwap && !isNaN(vwap) && vwap > 0;

  // Key levels
  const pdh       = barsDay && barsDay.length > 1 ? f(barsDay[barsDay.length - 2].h) : "N/A";
  const pdl       = barsDay && barsDay.length > 1 ? f(barsDay[barsDay.length - 2].l) : "N/A";
  const prevClose = barsDay && barsDay.length > 1 ? f(barsDay[barsDay.length - 2].c) : "N/A";
  const todayOpen = todayBars.length ? f(todayBars[0].o) : "N/A";
  const hod       = todayBars.length ? f(Math.max(...todayBars.map(b => b.h))) : "N/A";
  const lod       = todayBars.length ? f(Math.min(...todayBars.map(b => b.l))) : "N/A";

  const gap = barsDay && barsDay.length > 1
    ? ((barsDay[barsDay.length - 1].o - barsDay[barsDay.length - 2].c) / barsDay[barsDay.length - 2].c * 100).toFixed(2)
    : "0";

  // Volume trend
  const last5Vol = (bars10m || []).slice(-5).map(b => b.v);
  const volTrend = last5Vol.length > 1
    ? last5Vol[last5Vol.length - 1] > last5Vol[0] ? "INCREASING" : "DECREASING"
    : "UNKNOWN";

  const currentPrice = livePrice || tf10m?.price;

  const priceVsPMH = preMarket.high && currentPrice
    ? currentPrice > preMarket.high ? "ABOVE PMH ✓" : currentPrice < preMarket.high ? "BELOW PMH" : "AT PMH"
    : "N/A";
  const priceVsPML = preMarket.low && currentPrice
    ? currentPrice < preMarket.low ? "BELOW PML ✓" : currentPrice > preMarket.low ? "ABOVE PML" : "AT PML"
    : "N/A";

  const tfBlock = (label, tf) => {
    if (!tf) return `${label}: NO DATA`;
    return `${label}:
  Price: $${f(tf.price)} (${tf.isBull ? "BULL" : "BEAR"} candle, body ${f(tf.bodyRatio * 100, 0)}%)
  34/50 Cloud: ${tf.cloud3450} — Price ${tf.priceVsCloud} cloud (34 EMA: ${f(tf.ema34)} / 50 EMA: ${f(tf.ema50)})
  5/13 Cloud:  ${tf.cloud513} (5 EMA: ${f(tf.ema5)} / 13 EMA: ${f(tf.ema13)})
  8/9 Cross:   ${tf.cross89} (8 EMA: ${f(tf.ema8)} / 9 EMA: ${f(tf.ema9)})
  RVOL: ${tf.rvol ? f(tf.rvol) + "x avg" : "N/A"} | Volume: ${tf.volume?.toLocaleString() || "N/A"}`;
  };

  const vwapBlock = vwapValid
    ? `VWAP: $${f(vwap)}
Upper 1σ: $${f(upper1)} | Lower 1σ: $${f(lower1)}
Upper 2σ: $${f(upper2)} | Lower 2σ: $${f(lower2)}
Price vs VWAP: ${currentPrice > vwap ? "ABOVE by $" + f(currentPrice - vwap) : "BELOW by $" + f(vwap - currentPrice)}`
    : `VWAP: NOT AVAILABLE — score this factor NEUTRAL (5/10). Do NOT score 0/10. Use EMA cloud position and PDH/PDL/PMH/PML as primary bias instead.`;

  const prompt = `FULL MTF RIPSTER ANALYSIS — ${ticker}
Live Price: $${currentPrice ? f(currentPrice) : "N/A"}
Time: ${new Date().toLocaleTimeString()}

═══ DAILY CONTEXT ═══
Previous Close: $${prevClose}
Today Open:     $${todayOpen}
Gap:            ${gap}% ${parseFloat(gap) > 0.1 ? "▲ GAP UP" : parseFloat(gap) < -0.1 ? "▼ GAP DOWN" : "FLAT"}
PDH: $${pdh}  |  PDL: $${pdl}
HOD: $${hod}  |  LOD: $${lod}

═══ PRE-MARKET DATA ═══
Pre-Market High (PMH): $${pmHigh}
Pre-Market Low  (PML): $${pmLow}
Pre-Market Volume:     ${pmVol} (${pmBars} bars)
Price vs PMH: ${priceVsPMH}
Price vs PML: ${priceVsPML}
${preMarket.high ? "PMH break with volume = A+ long | PML break with volume = A+ short" : "No pre-market data — use PDH/PDL as opening range levels"}

═══ MULTI-TIMEFRAME EMA CLOUDS ═══
${tfBlock("DAILY", tfDay)}

${tfBlock("30-MINUTE", tf30m)}

${tfBlock("10-MINUTE (PRIMARY)", tf10m)}

${tfBlock("5-MINUTE", tf5m)}

${tfBlock("1-MINUTE", tf1m)}

═══ VWAP — Today's Session ═══
${vwapBlock}

═══ VOLUME ANALYSIS ═══
10m RVOL: ${tf10m?.rvol ? f(tf10m.rvol) + "x" : "N/A"} ${tf10m?.rvol > 2 ? "✓ STRONG" : tf10m?.rvol > 1.5 ? "✓ GOOD" : tf10m?.rvol > 1 ? "AVERAGE" : "✗ WEAK"}
5m  RVOL: ${tf5m?.rvol  ? f(tf5m.rvol)  + "x" : "N/A"}
1m  RVOL: ${tf1m?.rvol  ? f(tf1m.rvol)  + "x" : "N/A"}
Volume Trend (last 5 x 10m bars): ${volTrend}
Last 5 bar volumes: ${last5Vol.map(v => v.toLocaleString()).join(" → ")}

CRITICAL INSTRUCTIONS:
1. Evaluate BOTH long AND short independently. Report longScore and shortScore.
2. Call the direction with the higher score.
3. Only say No Trade if: price is INSIDE the 10m cloud, OR both scores are 2 or less.
4. If VWAP is unavailable, score it 5/10 neutral — never 0.
5. A missing indicator is not a reason for No Trade — use what you have.`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1500,
        system: SYSTEM,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const data = await response.json();
    if (data.error) throw new Error(data.error.message);

    const text  = data.content?.map(b => b.text || "").join("") || "";
    const clean = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);

    parsed._indicators = {
      tf1m, tf5m, tf10m, tf30m, tfDay,
      vwap, upper1, lower1, upper2, lower2,
      pdh, pdl, hod, lod, prevClose, gap,
      pmHigh, pmLow, pmVol,
    };

    res.status(200).json(parsed);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
