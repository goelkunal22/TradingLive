const UNIVERSE = [
  "AAPL","MSFT","NVDA","AMZN","META","GOOGL","TSLA","AVGO","JPM","V",
  "AMD","NFLX","CRM","ORCL","ADBE","QCOM","INTC","MU","AMAT","LRCX",
  "GS","MS","BAC","WFC","C","MA","PYPL","COIN","SQ","HOOD",
  "COST","WMT","NKE","SBUX","MCD","HD","TGT","LOW",
  "LLY","UNH","JNJ","PFE","MRK","ABBV","MRNA","REGN","GILD",
  "XOM","CVX","OXY","COP","SLB",
  "SPY","QQQ","IWM","GLD","TLT","XLF","XLE","XLK","SMH",
  "PLTR","MSTR","RBLX","SOFI","HIMS","RIVN","LCID","F","GM","BA",
  "DIS","BABA","TSM","ARM","SMCI","MRVL","ASML","ON",
  "GME","AMC","BBBY","SNDL","SPCE",
];

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  const { filter = "all", minPremium = 25000, limit = 100 } = req.body;

  try {
    const cookieRes = await fetch("https://fc.yahoo.com", {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
    });
    const cookie = cookieRes.headers.get("set-cookie") || "";
    const crumbRes = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
      headers: { "User-Agent": "Mozilla/5.0", "Cookie": cookie },
    });
    const crumb = await crumbRes.text();

    const yhHeaders = {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      "Accept": "application/json",
      "Cookie": cookie,
      "Referer": "https://finance.yahoo.com",
    };

    const safeNum = v => v?.raw ?? v ?? 0;
    const fmt$ = n => n >= 1e6 ? "$" + (n/1e6).toFixed(2) + "M"
      : n >= 1e3 ? "$" + (n/1e3).toFixed(0) + "K"
      : "$" + Math.round(n);

    async function scanTicker(ticker) {
      try {
        const url = `https://query1.finance.yahoo.com/v7/finance/options/${ticker}?crumb=${encodeURIComponent(crumb)}`;
        const r   = await fetch(url, { headers: yhHeaders });
        if (!r.ok) return [];
        const json   = await r.json();
        const result = json?.optionChain?.result?.[0];
        if (!result) return [];

        const spot    = result.quote?.regularMarketPrice || 0;
        const options = result.options?.[0];
        if (!options) return [];

        const expiry  = new Date(options.expirationDate * 1000).toISOString().split("T")[0];
        const daysOut = Math.round((options.expirationDate * 1000 - Date.now()) / 86400000);
        const events  = [];

        const process = (contracts, type) => {
          for (const c of contracts) {
            const vol    = safeNum(c.volume);
            const oi     = safeNum(c.openInterest) || 1;
            const bid    = safeNum(c.bid);
            const ask    = safeNum(c.ask);
            const last   = safeNum(c.lastPrice);
            const mid    = bid && ask ? (bid + ask) / 2 : last;
            const strike = safeNum(c.strike);
            const iv     = safeNum(c.impliedVolatility);
            const prem   = vol * mid * 100;
            if (vol < 10 || mid < 0.05 || prem < minPremium) continue;

            const volOiRatio = vol / oi;
            const otm        = type === "CALL" ? strike > spot : strike < spot;
            const pctOtm     = parseFloat(((strike - spot) / spot * 100).toFixed(1));

            // Classify fill type like Ghostboard
            // (A) = at ask = aggressive buyer
            // (B) = at bid = aggressive seller
            // (BB) = below bid = very aggressive seller
            // (AA) = above ask = very aggressive buyer
            let fillType = "M"; // at mid
            if (last >= ask * 0.99)        fillType = last > ask ? "AA" : "A";
            else if (last <= bid * 1.01)   fillType = last < bid ? "BB" : "B";

            // Classify trade type
            let tradeType = "UNUSUAL";
            if (prem >= 500000)            tradeType = "BLOCK";
            else if (volOiRatio > 5)       tradeType = "SWEEP";
            else if (volOiRatio > 2)       tradeType = "UNUSUAL";

            // If repeated (vol >> oi significantly) could be repeat
            if (vol > oi * 10 && vol > 500) tradeType = "SWEEP";

            // Aggression score
            const aggrScore = (
              (fillType === "AA" || fillType === "A" ? 2 : fillType === "BB" || fillType === "B" ? 1 : 0) +
              (volOiRatio > 10 ? 4 : volOiRatio > 5 ? 3 : volOiRatio > 2 ? 2 : 1) +
              (prem >= 1e6 ? 5 : prem >= 500000 ? 4 : prem >= 100000 ? 3 : prem >= 50000 ? 2 : 1) +
              (otm && daysOut < 14 ? 3 : otm ? 1 : 0) +
              (daysOut <= 7 ? 3 : daysOut <= 14 ? 2 : daysOut <= 30 ? 1 : 0)
            );

            // Sentiment — calls at ask = very bullish, puts at ask = very bearish
            const sentiment = type === "CALL"
              ? (fillType === "A" || fillType === "AA" ? "BULLISH" : "NEUTRAL-BULL")
              : (fillType === "A" || fillType === "AA" ? "BEARISH" : "NEUTRAL-BEAR");

            events.push({
              ticker, type, strike, expiry, daysOut,
              spot:       parseFloat(spot.toFixed(2)),
              vol, oi,
              volOiRatio: parseFloat(volOiRatio.toFixed(1)),
              bid:        parseFloat(bid.toFixed(2)),
              ask:        parseFloat(ask.toFixed(2)),
              last:       parseFloat(last.toFixed(2)),
              mid:        parseFloat(mid.toFixed(2)),
              premium:    Math.round(prem),
              premiumFmt: fmt$(prem),
              iv:         parseFloat((iv * 100).toFixed(1)),
              otm, pctOtm, fillType, tradeType, aggrScore, sentiment,
              // Details string like Ghostboard: "1237 @ 3.57 (A)"
              details:    `${vol.toLocaleString()} @ ${last.toFixed(2)} (${fillType})`,
            });
          }
        };

        process(options.calls || [], "CALL");
        process(options.puts  || [], "PUT");
        return events;
      } catch { return []; }
    }

    // Scan in batches of 8
    const allEvents = [];
    for (let i = 0; i < UNIVERSE.length; i += 8) {
      const batch   = UNIVERSE.slice(i, i + 8);
      const results = await Promise.all(batch.map(t => scanTicker(t)));
      for (const r of results) allEvents.push(...r);
    }

    // Apply filter
    let filtered = allEvents;
    if (filter === "bullish") filtered = allEvents.filter(e => e.type === "CALL");
    if (filter === "bearish") filtered = allEvents.filter(e => e.type === "PUT");
    if (filter === "sweeps")  filtered = allEvents.filter(e => e.tradeType === "SWEEP");
    if (filter === "blocks")  filtered = allEvents.filter(e => e.tradeType === "BLOCK");

    filtered.sort((a, b) => b.aggrScore - a.aggrScore || b.premium - a.premium);

    // Market tide — bucket events by aggression for the chart
    // Positive = net call premium, negative = net put premium
    const callPremium  = allEvents.filter(e => e.type === "CALL").reduce((s, e) => s + e.premium, 0);
    const putPremium   = allEvents.filter(e => e.type === "PUT").reduce((s, e)  => s + e.premium, 0);
    const netPremium   = callPremium - putPremium;
    const pcRatio      = putPremium / (callPremium || 1);
    const marketBias   = pcRatio < 0.7 ? "BULLISH" : pcRatio > 1.3 ? "BEARISH" : "NEUTRAL";

    // Build market tide data (simple bucketing by premium)
    const sweepCount   = allEvents.filter(e => e.tradeType === "SWEEP").length;
    const blockCount   = allEvents.filter(e => e.tradeType === "BLOCK").length;
    const unusualCount = allEvents.filter(e => e.tradeType === "UNUSUAL").length;

  

    res.status(200).json({
      events:    filtered.slice(0, limit),
      total:     filtered.length,
      scanned:   UNIVERSE.length,
      timestamp: new Date().toISOString(),
      market: {
        bias:          marketBias,
        pcRatio:       parseFloat(pcRatio.toFixed(2)),
        callPremium:   Math.round(callPremium),
        putPremium:    Math.round(putPremium),
        netPremium:    Math.round(netPremium),
        callPremiumFmt: fmt$(callPremium),
        putPremiumFmt:  fmt$(putPremium),
        netPremiumFmt:  (netPremium >= 0 ? "+" : "") + fmt$(Math.abs(netPremium)),
        bullishCount:  allEvents.filter(e => e.type === "CALL").length,
        bearishCount:  allEvents.filter(e => e.type === "PUT").length,
        sweepCount, blockCount, unusualCount,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
