// Options Flow API - uses Yahoo Finance options chain
// Shows put/call ratio, unusual activity, net premium flow, flow sentiment

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  const { ticker } = req.body;
  if (!ticker) return res.status(400).json({ error: "ticker required" });

  try {
    const sym = ticker.toUpperCase();

    // Step 1: Get cookie + crumb from Yahoo
    const cookieRes = await fetch("https://fc.yahoo.com", {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
      },
    });
    const cookie = cookieRes.headers.get("set-cookie") || "";

    const crumbRes = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Cookie": cookie,
      },
    });
    const crumb = await crumbRes.text();

    // Step 2: Fetch options chain (nearest expiry + next expiry)
    const optUrl = `https://query1.finance.yahoo.com/v7/finance/options/${sym}?crumb=${encodeURIComponent(crumb)}`;
    const optRes = await fetch(optUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Accept": "application/json",
        "Cookie": cookie,
        "Referer": "https://finance.yahoo.com",
      },
    });

    if (!optRes.ok) throw new Error(`Yahoo options error: ${optRes.status}`);
    const optData = await optRes.json();

    const result   = optData?.optionChain?.result?.[0];
    if (!result)   throw new Error("No options data returned");

    const quote    = result.quote;
    const spotPrice = quote?.regularMarketPrice || 0;
    const options  = result.options?.[0];
    if (!options)  throw new Error("No options contracts found");

    const calls = options.calls || [];
    const puts  = options.puts  || [];
    const expiry = new Date(options.expirationDate * 1000).toISOString().split("T")[0];

    // Also fetch next expiry if available
    let calls2 = [], puts2 = [], expiry2 = null;
    if (result.expirationDates?.length > 1) {
      const nextExp = result.expirationDates[1];
      const opt2Url = `https://query1.finance.yahoo.com/v7/finance/options/${sym}?date=${nextExp}&crumb=${encodeURIComponent(crumb)}`;
      const opt2Res = await fetch(opt2Url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
          "Cookie": cookie,
          "Referer": "https://finance.yahoo.com",
        },
      });
      if (opt2Res.ok) {
        const opt2Data = await opt2Res.json();
        const opt2     = opt2Data?.optionChain?.result?.[0]?.options?.[0];
        if (opt2) {
          calls2  = opt2.calls || [];
          puts2   = opt2.puts  || [];
          expiry2 = new Date(nextExp * 1000).toISOString().split("T")[0];
        }
      }
    }

    // ── ANALYSIS FUNCTIONS ──────────────────────────────────────────────────

    const safeNum = v => (v?.raw ?? v ?? 0);

    function analyzeContracts(calls, puts, label) {
      let totalCallVol = 0, totalPutVol  = 0;
      let totalCallOI  = 0, totalPutOI   = 0;
      let callPremium  = 0, putPremium   = 0;
      const unusual    = [];
      const sweeps     = [];

      for (const c of calls) {
        const vol   = safeNum(c.volume);
        const oi    = safeNum(c.openInterest) || 1;
        const mid   = (safeNum(c.bid) + safeNum(c.ask)) / 2 || safeNum(c.lastPrice);
        const prem  = vol * mid * 100;
        const strike = safeNum(c.strike);
        const iv    = safeNum(c.impliedVolatility);

        totalCallVol += vol;
        totalCallOI  += oi;
        callPremium  += prem;

        // Unusual = volume > 2x OI and vol > 100
        if (vol > oi * 2 && vol > 100) {
          unusual.push({
            type: "CALL", strike, vol, oi, ratio: parseFloat((vol / oi).toFixed(1)),
            mid: parseFloat(mid.toFixed(2)), premium: Math.round(prem),
            iv: parseFloat((iv * 100).toFixed(1)),
            otm: strike > spotPrice,
            expiry: label,
          });
        }
        if (prem > 50000) {
          sweeps.push({
            type: "CALL", strike, vol, premium: Math.round(prem),
            mid: parseFloat(mid.toFixed(2)), iv: parseFloat((iv * 100).toFixed(1)),
            sentiment: "BULLISH", expiry: label,
          });
        }
      }

      for (const p of puts) {
        const vol   = safeNum(p.volume);
        const oi    = safeNum(p.openInterest) || 1;
        const mid   = (safeNum(p.bid) + safeNum(p.ask)) / 2 || safeNum(p.lastPrice);
        const prem  = vol * mid * 100;
        const strike = safeNum(p.strike);
        const iv    = safeNum(p.impliedVolatility);

        totalPutVol  += vol;
        totalPutOI   += oi;
        putPremium   += prem;

        if (vol > oi * 2 && vol > 100) {
          unusual.push({
            type: "PUT", strike, vol, oi, ratio: parseFloat((vol / oi).toFixed(1)),
            mid: parseFloat(mid.toFixed(2)), premium: Math.round(prem),
            iv: parseFloat((iv * 100).toFixed(1)),
            otm: strike < spotPrice,
            expiry: label,
          });
        }
        if (prem > 50000) {
          sweeps.push({
            type: "PUT", strike, vol, premium: Math.round(prem),
            mid: parseFloat(mid.toFixed(2)), iv: parseFloat((iv * 100).toFixed(1)),
            sentiment: "BEARISH", expiry: label,
          });
        }
      }

      return { totalCallVol, totalPutVol, totalCallOI, totalPutOI, callPremium, putPremium, unusual, sweeps };
    }

    const near = analyzeContracts(calls,  puts,  expiry);
    const next = analyzeContracts(calls2, puts2, expiry2 || "next");

    // Combine both expiries
    const totalCallVol = near.totalCallVol + next.totalCallVol;
    const totalPutVol  = near.totalPutVol  + next.totalPutVol;
    const totalCallOI  = near.totalCallOI  + next.totalCallOI;
    const totalPutOI   = near.totalPutOI   + next.totalPutOI;
    const callPremium  = near.callPremium  + next.callPremium;
    const putPremium   = near.putPremium   + next.putPremium;
    const netPremium   = callPremium - putPremium;

    const pcRatio      = totalPutVol / (totalCallVol || 1);
    const pcOIRatio    = totalPutOI  / (totalCallOI  || 1);

    const allUnusual   = [...near.unusual, ...next.unusual]
      .sort((a, b) => b.premium - a.premium).slice(0, 15);
    const allSweeps    = [...near.sweeps, ...next.sweeps]
      .sort((a, b) => b.premium - a.premium).slice(0, 10);

    // Flow sentiment
    const bullishScore = (
      (pcRatio < 0.7 ? 2 : pcRatio < 1.0 ? 1 : 0) +
      (netPremium > 0 ? 2 : 0) +
      (callPremium > putPremium * 1.5 ? 1 : 0)
    );
    const bearishScore = (
      (pcRatio > 1.3 ? 2 : pcRatio > 1.0 ? 1 : 0) +
      (netPremium < 0 ? 2 : 0) +
      (putPremium > callPremium * 1.5 ? 1 : 0)
    );

    const flowSentiment = bullishScore > bearishScore + 1 ? "BULLISH"
      : bearishScore > bullishScore + 1 ? "BEARISH"
      : "NEUTRAL";

    const flowStrength = Math.max(bullishScore, bearishScore) >= 4 ? "STRONG"
      : Math.max(bullishScore, bearishScore) >= 2 ? "MODERATE"
      : "WEAK";

    // Format big numbers
    const fmt$ = n => n >= 1e6 ? "$" + (n / 1e6).toFixed(1) + "M"
      : n >= 1e3 ? "$" + (n / 1e3).toFixed(0) + "K"
      : "$" + n.toFixed(0);

    res.status(200).json({
      ticker: sym,
      spotPrice,
      expiry,
      expiry2,
      flow: {
        sentiment: flowSentiment,
        strength:  flowStrength,
        pcRatio:   parseFloat(pcRatio.toFixed(2)),
        pcOIRatio: parseFloat(pcOIRatio.toFixed(2)),
        totalCallVol, totalPutVol,
        totalCallOI,  totalPutOI,
        callPremium:  Math.round(callPremium),
        putPremium:   Math.round(putPremium),
        netPremium:   Math.round(netPremium),
        callPremiumFmt: fmt$(callPremium),
        putPremiumFmt:  fmt$(putPremium),
        netPremiumFmt:  (netPremium >= 0 ? "+" : "") + fmt$(Math.abs(netPremium)),
        bullishScore, bearishScore,
      },
      unusual:  allUnusual,
      sweeps:   allSweeps,
      nearExpiry: {
        expiry,
        callVol: near.totalCallVol, putVol: near.totalPutVol,
        callPremium: Math.round(near.callPremium), putPremium: Math.round(near.putPremium),
      },
      nextExpiry: expiry2 ? {
        expiry: expiry2,
        callVol: next.totalCallVol, putVol: next.totalPutVol,
        callPremium: Math.round(next.callPremium), putPremium: Math.round(next.putPremium),
      } : null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
