import { useState, useEffect, useRef, useCallback } from "react";
import Head from "next/head";

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const TICKERS = ["SPY","QQQ","NVDA","AAPL","AMD","META","TSLA","MSFT","AMZN","GOOGL"];

const WATCHLISTS = {
  "Ripster Favs": ["SPY","QQQ","TSLA","NVDA","AMD","META","AAPL","MSFT"],
  "Hot Movers":   ["NVDA","AMD","TSLA","META","AAPL","MSFT","AMZN","GOOGL","NFLX","AVGO"],
  "Small/Volatile": ["HIMS","HOOD","COIN","MSTR","PLTR","SOFI","RBLX","JOBY","RDDT"],
  "Custom": [],
};

// ─── HELPERS ──────────────────────────────────────────────────────────────────
const f          = (n, d = 2) => n != null && !isNaN(n) ? Number(n).toFixed(d) : "—";
const probColor  = p => p >= 80 ? "#00ff88" : p >= 65 ? "#7fff00" : p >= 50 ? "#ffcc00" : p >= 35 ? "#ff8c00" : "#ff3333";
const scoreColor = s => s >= 8 ? "#00ff88" : s >= 6 ? "#7fff00" : s >= 4 ? "#ffcc00" : s >= 2 ? "#ff8c00" : "#ff3333";
const dirColor   = d => d === "BULL" || d === "BULLISH" || d === "LONG" ? "#00ff88" : d === "BEAR" || d === "BEARISH" || d === "SHORT" ? "#ff3333" : "#ffcc00";

// ─── INDICATOR CALCS (client-side for display) ────────────────────────────────
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
    cumTPV += tp * b.v; cumVol += b.v; cumTPV2 += tp * tp * b.v;
  }
  const vwap = cumVol ? cumTPV / cumVol : null;
  const sd   = Math.sqrt(Math.max(0, cumVol ? cumTPV2 / cumVol - vwap * vwap : 0));
  return { vwap, upper1: vwap + sd, lower1: vwap - sd, upper2: vwap + 2 * sd, lower2: vwap - 2 * sd };
}

function getTodayBars(bars) {
  if (!bars || !bars.length) return [];
  const lastBar     = bars[bars.length - 1];
  const sessionDate = lastBar.t.substring(0, 10);
  return bars.filter(b => {
    if (!b.t.startsWith(sessionDate)) return false;
    const hour = parseInt(b.t.substring(11, 13));
    const min  = parseInt(b.t.substring(14, 16));
    return hour > 13 || (hour === 13 && min >= 30);
  });
}

function calcTFIndicators(bars) {
  if (!bars || !bars.length) return null;
  const closes   = bars.map(b => b.c);
  const latest   = bars[bars.length - 1];
  const prev     = bars.length > 1 ? bars[bars.length - 2] : null;
  const ema8     = calcEMA(closes, 8);
  const ema9     = calcEMA(closes, 9);
  const ema5     = calcEMA(closes, 5);
  const ema13    = calcEMA(closes, 13);
  const ema34    = calcEMA(closes, 34);
  const ema50    = calcEMA(closes, 50);
  const cloudTop = ema34 && ema50 ? Math.max(ema34, ema50) : null;
  const cloudBot = ema34 && ema50 ? Math.min(ema34, ema50) : null;
  const avgVol   = bars.length > 2
    ? bars.slice(-Math.min(21, bars.length) - 1, -1).reduce((a, b) => a + b.v, 0) / Math.min(20, bars.length - 1)
    : null;
  return {
    price: latest.c, open: latest.o, high: latest.h, low: latest.l,
    volume: latest.v, time: latest.t,
    priceChange: prev ? latest.c - prev.c : 0,
    pricePct:    prev ? ((latest.c - prev.c) / prev.c) * 100 : 0,
    ema8, ema9, ema5, ema13, ema34, ema50,
    cloud3450:    ema34 && ema50 ? (ema34 > ema50 ? "BULLISH" : "BEARISH") : "UNKNOWN",
    priceVsCloud: cloudTop && cloudBot
      ? (latest.c > cloudTop ? "ABOVE" : latest.c < cloudBot ? "BELOW" : "INSIDE")
      : "UNKNOWN",
    cloud513: ema5 && ema13 ? (ema5 > ema13 ? "BULLISH" : "BEARISH") : "UNKNOWN",
    cross89:  ema8 && ema9  ? (ema8  > ema9  ? "BULLISH" : "BEARISH") : "UNKNOWN",
    avgVol,
    rvol:      avgVol && latest.v ? latest.v / avgVol : null,
    bodyRatio: Math.abs(latest.c - latest.o) / ((latest.h - latest.l) || 0.0001),
    isBull:    latest.c >= latest.o,
  };
}




// ─── MARKET FLOW SCANNER COMPONENT ───────────────────────────────────────────
function MarketFlowTab({ onSelectTicker }) {
  const [loading,     setLoading]     = useState(false);
  const [data,        setData]        = useState(null);
  const [error,       setError]       = useState("");
  const [filter,      setFilter]      = useState("all");
  const [minPremium,  setMinPremium]  = useState(25000);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [aiReading,   setAiReading]   = useState("");
  const [aiLoading,   setAiLoading]   = useState(false);
  const timerRef = useRef(null);

  const run = async (f, mp) => {
    const useFilter  = f  ?? filter;
    const usePremium = mp ?? minPremium;
    setLoading(true); setError("");
    try {
      const res  = await fetch("/api/flowscan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filter: useFilter, minPremium: usePremium, limit: 100 }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
      setData(json);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };

  const runFlowAI = async () => {
    if (!data) return;
    setAiLoading(true); setAiReading("");
    try {
      const top10 = data.events.slice(0, 10).map(e =>
        `${e.ticker} ${e.type} $${e.strike} exp:${e.expiry} ${e.details} prem:${e.premiumFmt} ${e.tradeType} fill:${e.fillType}`
      ).join("\n");

      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          allBars: { bars1m:[], bars5m:[], bars10m:[], bars30m:[], barsDay:[], preMarket:{} },
          ticker: "MARKET",
          livePrice: null,
          flowOverride: {
            prompt: `You are an options flow expert. Analyze this real-time options flow data and give a 3-4 sentence market read. Focus on: what are the big players positioning for, is the flow bullish or bearish overall, any standout unusual bets, what does this mean for the next 1-2 hours of trading.

Market P/C Ratio: ${data.market.pcRatio}
Market Bias: ${data.market.bias}
Net Premium Flow: ${data.market.netPremiumFmt}
Call Premium: ${data.market.callPremiumFmt} | Put Premium: ${data.market.putPremiumFmt}
Sweeps: ${data.market.sweepCount} | Blocks: ${data.market.blockCount} | Unusual: ${data.market.unusualCount}

TOP 10 MOST AGGRESSIVE TRADES:
${top10}

Give your flow reading in Ripster/trader voice. Be direct and specific about what you see.`,
          },
        }),
      });
      const json = await res.json();
      setAiReading(json.verdict || json.signal || json.action || "Flow analysis complete.");
    } catch (e) { setAiReading("AI read failed: " + e.message); }
    finally { setAiLoading(false); }
  };

  useEffect(() => {
    if (autoRefresh) {
      timerRef.current = setInterval(() => run(), 5 * 60 * 1000);
    } else {
      clearInterval(timerRef.current);
    }
    return () => clearInterval(timerRef.current);
  }, [autoRefresh, filter, minPremium]);

  const biasColor = b => b === "BULLISH" ? "#00ff88" : b === "BEARISH" ? "#ff3333" : "#ffcc00";
  const typeColor = t => t === "CALL" ? "#00ff88" : "#ff3333";
  const tagStyle  = t => {
    const colors = { "SWEEP":"#ffcc00", "BLOCK":"#aa88ff", "UNUSUAL":"#00aaff" };
    const c = colors[t] || "#555";
    return { fontSize:9, padding:"2px 6px", borderRadius:3, background:c+"22", color:c, border:`1px solid ${c}44`, fontWeight:700, whiteSpace:"nowrap" };
  };
  const fillStyle = f => {
    const colors = { "AA":"#00ff00","A":"#00cc88","M":"#888","B":"#ff8c00","BB":"#ff3333" };
    return { fontSize:10, fontWeight:700, color: colors[f] || "#888" };
  };

  const FILTERS = [
    { key:"all",     label:"All Flow" },
    { key:"bullish", label:"🟢 Calls" },
    { key:"bearish", label:"🔴 Puts" },
    { key:"sweeps",  label:"⚡ Sweeps" },
    { key:"blocks",  label:"🟪 Blocks" },
  ];

  const PREMIUMS = [
    { val:25000,  label:"$25K+" },
    { val:50000,  label:"$50K+" },
    { val:100000, label:"$100K+" },
    { val:250000, label:"$250K+" },
    { val:500000, label:"$500K+" },
  ];

  return (
    <div>
      {/* Controls */}
      <div style={{ background:"#0c0c12", border:"1px solid #14141e", borderRadius:10, padding:16, marginBottom:12 }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
          <div>
            <div style={{ fontSize:10, color:"#444", letterSpacing:3, marginBottom:2 }}>MARKET FLOW SCANNER</div>
            <div style={{ fontSize:11, color:"#555" }}>Live sweeps, blocks & unusual activity across 80+ tickers</div>
          </div>
          {data && <div style={{ fontSize:10, color:"#333" }}>{data.scanned} scanned · {data.total} events · {new Date(data.timestamp).toLocaleTimeString()}</div>}
        </div>

        <div style={{ display:"flex", gap:6, flexWrap:"wrap", marginBottom:8 }}>
          {FILTERS.map(f => (
            <button key={f.key} onClick={() => setFilter(f.key)}
              style={{ padding:"5px 12px", background: filter===f.key ? "#ffcc0022":"#0a0a10", border:`1px solid ${filter===f.key ? "#ffcc00":"#1e1e2e"}`, borderRadius:6, color: filter===f.key ? "#ffcc00":"#555", fontSize:11, cursor:"pointer" }}>
              {f.label}
            </button>
          ))}
        </div>

        <div style={{ display:"flex", gap:6, flexWrap:"wrap", marginBottom:12, alignItems:"center" }}>
          <span style={{ fontSize:10, color:"#333" }}>MIN PREMIUM:</span>
          {PREMIUMS.map(p => (
            <button key={p.val} onClick={() => setMinPremium(p.val)}
              style={{ padding:"4px 10px", background: minPremium===p.val ? "#aa88ff22":"#0a0a10", border:`1px solid ${minPremium===p.val ? "#aa88ff":"#1e1e2e"}`, borderRadius:6, color: minPremium===p.val ? "#aa88ff":"#555", fontSize:10, cursor:"pointer" }}>
              {p.label}
            </button>
          ))}
        </div>

        <div style={{ display:"flex", gap:8 }}>
          <button onClick={() => run()} disabled={loading}
            style={{ flex:1, padding:"11px 0", background: loading ? "#111" : "linear-gradient(135deg,#ffcc00,#ff8c00)", border:"none", borderRadius:6, color:"#000", fontSize:13, fontWeight:700, cursor: loading ? "not-allowed" : "pointer" }}>
            {loading ? "⏳ SCANNING 80+ TICKERS..." : "💰 SCAN MARKET FLOW"}
          </button>
          <button onClick={() => setAutoRefresh(a => !a)}
            style={{ padding:"11px 14px", background: autoRefresh ? "#00ff8822":"#0a0a10", border:`1px solid ${autoRefresh ? "#00ff88":"#1e1e2e"}`, borderRadius:6, color: autoRefresh ? "#00ff88":"#555", fontSize:11, cursor:"pointer" }}>
            {autoRefresh ? "🔄 AUTO" : "🔄"}
          </button>
        </div>
        {error && <div style={{ color:"#ff5555", fontSize:11, marginTop:8 }}>⚠ {error}</div>}
      </div>

      {data && (
        <div>
          {/* Market Tide */}
          <div style={{ background:"#0c0c12", border:`1px solid ${biasColor(data.market.bias)}33`, borderTop:`3px solid ${biasColor(data.market.bias)}`, borderRadius:10, padding:18, marginBottom:12 }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", flexWrap:"wrap", gap:12, marginBottom:16 }}>
              <div>
                <div style={{ fontSize:10, color:"#444", letterSpacing:3, marginBottom:4 }}>MARKET TIDE</div>
                <div style={{ fontSize:26, fontWeight:900, color:biasColor(data.market.bias), marginBottom:4 }}>
                  {data.market.bias} <span style={{ fontSize:13, color:"#555", fontWeight:400 }}>P/C {data.market.pcRatio}</span>
                </div>
                <div style={{ fontSize:12, color:"#666" }}>
                  Net Flow: <span style={{ color: data.market.netPremium >= 0 ? "#00ff88":"#ff3333", fontWeight:700 }}>{data.market.netPremiumFmt}</span>
                </div>
              </div>
              <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
                {[
                  { label:"CALLS",   val: data.market.callPremiumFmt, count: data.market.bullishCount, color:"#00ff88" },
                  { label:"PUTS",    val: data.market.putPremiumFmt,  count: data.market.bearishCount, color:"#ff3333" },
                  { label:"SWEEPS",  val: data.market.sweepCount,     count: null,                     color:"#ffcc00" },
                  { label:"BLOCKS",  val: data.market.blockCount,     count: null,                     color:"#aa88ff" },
                ].map(({ label, val, count, color }) => (
                  <div key={label} style={{ textAlign:"center", background:color+"11", border:`1px solid ${color}33`, borderRadius:8, padding:"10px 14px", minWidth:70 }}>
                    <div style={{ fontSize:16, fontWeight:900, color }}>{val}</div>
                    {count != null && <div style={{ fontSize:9, color:"#444", marginTop:2 }}>{count} trades</div>}
                    <div style={{ fontSize:9, color:"#333", marginTop:2 }}>{label}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Premium flow bar */}
            {(() => {
              const total = (data.market.callPremium + data.market.putPremium) || 1;
              const callPct = (data.market.callPremium / total * 100).toFixed(1);
              const putPct  = (data.market.putPremium  / total * 100).toFixed(1);
              return (
                <div>
                  <div style={{ display:"flex", justifyContent:"space-between", fontSize:10, color:"#444", marginBottom:4 }}>
                    <span>🟢 CALLS {callPct}% — {data.market.callPremiumFmt}</span>
                    <span>PUTS {putPct}% — {data.market.putPremiumFmt} 🔴</span>
                  </div>
                  <div style={{ display:"flex", height:12, borderRadius:6, overflow:"hidden", background:"#0a0a10" }}>
                    <div style={{ width:`${callPct}%`, background:"linear-gradient(90deg,#00ff8866,#00ff88)", transition:"width 1.5s ease" }} />
                    <div style={{ width:`${putPct}%`,  background:"linear-gradient(90deg,#ff333366,#ff3333)", transition:"width 1.5s ease" }} />
                  </div>
                </div>
              );
            })()}
          </div>

          {/* Flow AI */}
          <div style={{ background:"#0c0c12", border:"1px solid #14141e", borderRadius:10, padding:16, marginBottom:12 }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
              <div style={{ fontSize:10, color:"#444", letterSpacing:3 }}>FLOW AI</div>
              <button onClick={runFlowAI} disabled={aiLoading}
                style={{ padding:"6px 14px", background: aiLoading ? "#111" : "#aa88ff22", border:"1px solid #aa88ff44", borderRadius:6, color:"#aa88ff", fontSize:11, cursor: aiLoading ? "not-allowed" : "pointer" }}>
                {aiLoading ? "⏳ Reading..." : "🧠 Get AI Read"}
              </button>
            </div>
            {aiReading ? (
              <div style={{ fontSize:12, color:"#ccc", lineHeight:1.8, fontStyle:"italic" }}>"{aiReading}"</div>
            ) : (
              <div style={{ fontSize:11, color:"#333" }}>Hit "Get AI Read" for an AI interpretation of the current flow</div>
            )}
          </div>

          {/* Live Feed Table — Ghostboard style */}
          <div style={{ background:"#0c0c12", border:"1px solid #14141e", borderRadius:10, padding:16 }}>
            <div style={{ fontSize:10, color:"#444", letterSpacing:3, marginBottom:14 }}>LIVE FLOW — {data.events.length} EVENTS</div>
            <div style={{ overflowX:"auto" }}>
              <table style={{ width:"100%", borderCollapse:"collapse", fontSize:11 }}>
                <thead>
                  <tr style={{ borderBottom:"2px solid #1a1a28" }}>
                    {["Symbol","Exp","Strike","C/P","Spot","Details","Value","DTE","IV","Tag"].map(h => (
                      <th key={h} style={{ padding:"8px 10px", color:"#444", fontWeight:400, textAlign: h==="Symbol" ? "left":"right", whiteSpace:"nowrap", fontSize:10, letterSpacing:1 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.events.map((e, i) => {
                    const tc = typeColor(e.type);
                    const premColor = e.premium >= 1e6 ? "#ffcc00" : e.premium >= 500000 ? "#aa88ff" : e.premium >= 100000 ? "#00aaff" : "#888";
                    return (
                      <tr key={i}
                        style={{ borderBottom:"1px solid #0a0a10", cursor:"pointer", transition:"background 0.15s" }}
                        onClick={() => onSelectTicker && onSelectTicker(e.ticker)}
                        onMouseEnter={el => el.currentTarget.style.background = "#0e0e18"}
                        onMouseLeave={el => el.currentTarget.style.background = "transparent"}>
                        <td style={{ padding:"9px 10px" }}>
                          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                            <span style={{ fontSize:13, fontWeight:900, color:"#fff" }}>{e.ticker}</span>
                            <span style={{ fontSize:9, color:"#444" }}>→ analyze</span>
                          </div>
                        </td>
                        <td style={{ padding:"9px 10px", color:"#555", textAlign:"right" }}>{e.expiry}</td>
                        <td style={{ padding:"9px 10px", color:"#ccc", fontWeight:700, textAlign:"right" }}>${e.strike}</td>
                        <td style={{ padding:"9px 10px", textAlign:"right" }}>
                          <span style={{ background:tc+"22", border:`1px solid ${tc}55`, borderRadius:4, padding:"2px 8px", color:tc, fontWeight:700, fontSize:10 }}>{e.type}</span>
                        </td>
                        <td style={{ padding:"9px 10px", color:"#888", textAlign:"right" }}>${e.spot}</td>
                        <td style={{ padding:"9px 10px", textAlign:"right" }}>
                          <span style={fillStyle(e.fillType)}>{e.details}</span>
                        </td>
                        <td style={{ padding:"9px 10px", textAlign:"right" }}>
                          <span style={{ color:premColor, fontWeight:700 }}>{e.premiumFmt}</span>
                        </td>
                        <td style={{ padding:"9px 10px", color: e.daysOut <= 7 ? "#ff8c00" : e.daysOut <= 14 ? "#ffcc00" : "#555", textAlign:"right" }}>{e.daysOut}d</td>
                        <td style={{ padding:"9px 10px", color:"#555", textAlign:"right" }}>{e.iv}%</td>
                        <td style={{ padding:"9px 10px", textAlign:"right" }}>
                          <span style={tagStyle(e.tradeType)}>{e.tradeType}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div style={{ marginTop:14, padding:12, background:"#0a0a10", borderRadius:8, fontSize:10, color:"#333", lineHeight:1.8 }}>
              <span style={{ color:"#00ff00", fontWeight:700 }}>AA</span> = Above ask (most aggressive buy) &nbsp;
              <span style={{ color:"#00cc88", fontWeight:700 }}>A</span> = At ask &nbsp;
              <span style={{ color:"#888", fontWeight:700 }}>M</span> = At mid &nbsp;
              <span style={{ color:"#ff8c00", fontWeight:700 }}>B</span> = At bid &nbsp;
              <span style={{ color:"#ff3333", fontWeight:700 }}>BB</span> = Below bid (most aggressive sell) &nbsp;·&nbsp;
              Click any row to run full Ripster MTF analysis
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── FLOW TAB COMPONENT ───────────────────────────────────────────────────────
function FlowTab({ ticker }) {
  const [loading, setLoading] = useState(false);
  const [data,    setData]    = useState(null);
  const [error,   setError]   = useState("");

  const run = async () => {
    setLoading(true); setError("");
    try {
      const res  = await fetch("/api/flow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
      setData(json);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };

  const sentColor = s => s === "BULLISH" ? "#00ff88" : s === "BEARISH" ? "#ff3333" : "#ffcc00";
  const fmtVol    = n => n >= 1e6 ? (n/1e6).toFixed(1)+"M" : n >= 1e3 ? (n/1e3).toFixed(0)+"K" : n.toLocaleString();
  const fmtPrem   = n => n >= 1e6 ? "$"+(n/1e6).toFixed(1)+"M" : n >= 1e3 ? "$"+(n/1e3).toFixed(0)+"K" : "$"+n.toLocaleString();

  return (
    <div>
      {/* Header */}
      <div style={{ background:"#0c0c12", border:"1px solid #14141e", borderRadius:10, padding:16, marginBottom:12 }}>
        <div style={{ fontSize:10, color:"#444", letterSpacing:3, marginBottom:4 }}>OPTIONS FLOW ANALYSIS</div>
        <div style={{ fontSize:11, color:"#555", marginBottom:14, lineHeight:1.6 }}>
          Real-time put/call ratio, net premium flow, unusual activity and sweep alerts for {ticker}.
          Data from options chain — updates on each refresh.
        </div>
        <button onClick={run} disabled={loading}
          style={{ width:"100%", padding:"11px 0", background: loading ? "#111" : "linear-gradient(135deg,#ffcc00,#ff8c00)", border:"none", borderRadius:6, color:"#000", fontSize:13, fontWeight:700, cursor: loading ? "not-allowed" : "pointer" }}>
          {loading ? "⏳ FETCHING OPTIONS FLOW..." : `💰 LOAD FLOW FOR ${ticker}`}
        </button>
        {error && <div style={{ color:"#ff5555", fontSize:11, marginTop:8 }}>⚠ {error}</div>}
      </div>

      {data && (
        <div>
          {/* Sentiment Hero */}
          <div style={{ background:"#0c0c12", border:`2px solid ${sentColor(data.flow.sentiment)}33`, borderTop:`3px solid ${sentColor(data.flow.sentiment)}`, borderRadius:10, padding:22, marginBottom:12, position:"relative", overflow:"hidden" }}>
            <div style={{ position:"absolute", inset:0, background:`radial-gradient(ellipse at 50% 0%, ${sentColor(data.flow.sentiment)}07, transparent 60%)`, pointerEvents:"none" }} />
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", flexWrap:"wrap", gap:16 }}>
              <div>
                <div style={{ fontSize:10, color:"#444", letterSpacing:3, marginBottom:6 }}>FLOW SENTIMENT — {data.ticker} @ ${data.spotPrice}</div>
                <div style={{ fontSize:28, fontWeight:900, color:sentColor(data.flow.sentiment), marginBottom:10 }}>
                  {data.flow.sentiment} <span style={{ fontSize:14, color:"#555" }}>{data.flow.strength}</span>
                </div>
                <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
                  <span style={{ padding:"4px 12px", borderRadius:6, background:"#1a1a1a", border:"1px solid #333", fontSize:12, color:"#aaa" }}>
                    P/C Ratio: <span style={{ color: data.flow.pcRatio < 0.7 ? "#00ff88" : data.flow.pcRatio > 1.3 ? "#ff3333" : "#ffcc00", fontWeight:700 }}>{data.flow.pcRatio}</span>
                  </span>
                  <span style={{ padding:"4px 12px", borderRadius:6, background:"#1a1a1a", border:"1px solid #333", fontSize:12, color:"#aaa" }}>
                    Net Premium: <span style={{ color: data.flow.netPremium >= 0 ? "#00ff88" : "#ff3333", fontWeight:700 }}>{data.flow.netPremiumFmt}</span>
                  </span>
                  <span style={{ padding:"4px 12px", borderRadius:6, background:"#1a1a1a", border:"1px solid #333", fontSize:12, color:"#555" }}>
                    Exp: {data.expiry}
                  </span>
                </div>
              </div>
              <div style={{ display:"flex", gap:12 }}>
                <div style={{ textAlign:"center", background:"#00ff8811", border:"1px solid #00ff8833", borderRadius:8, padding:"12px 20px" }}>
                  <div style={{ fontSize:22, fontWeight:900, color:"#00ff88" }}>{data.flow.callPremiumFmt}</div>
                  <div style={{ fontSize:10, color:"#444", marginTop:2 }}>CALL PREM</div>
                  <div style={{ fontSize:11, color:"#555" }}>{fmtVol(data.flow.totalCallVol)} vol</div>
                </div>
                <div style={{ textAlign:"center", background:"#ff333311", border:"1px solid #ff333333", borderRadius:8, padding:"12px 20px" }}>
                  <div style={{ fontSize:22, fontWeight:900, color:"#ff3333" }}>{data.flow.putPremiumFmt}</div>
                  <div style={{ fontSize:10, color:"#444", marginTop:2 }}>PUT PREM</div>
                  <div style={{ fontSize:11, color:"#555" }}>{fmtVol(data.flow.totalPutVol)} vol</div>
                </div>
              </div>
            </div>

            {/* Premium flow bar */}
            <div style={{ marginTop:16 }}>
              <div style={{ display:"flex", justifyContent:"space-between", marginBottom:4, fontSize:10, color:"#444" }}>
                <span>CALLS {data.flow.callPremiumFmt}</span>
                <span>PUTS {data.flow.putPremiumFmt}</span>
              </div>
              <div style={{ display:"flex", height:10, borderRadius:5, overflow:"hidden", background:"#0a0a10" }}>
                {(() => {
                  const total = data.flow.callPremium + data.flow.putPremium || 1;
                  const callPct = (data.flow.callPremium / total * 100).toFixed(1);
                  const putPct  = (data.flow.putPremium  / total * 100).toFixed(1);
                  return (
                    <>
                      <div style={{ width:`${callPct}%`, background:"linear-gradient(90deg,#00ff8888,#00ff88)", transition:"width 1s ease" }} />
                      <div style={{ width:`${putPct}%`,  background:"linear-gradient(90deg,#ff333388,#ff3333)", transition:"width 1s ease" }} />
                    </>
                  );
                })()}
              </div>
            </div>
          </div>

          {/* Expiry breakdown */}
          <div style={{ display:"grid", gridTemplateColumns: data.nextExpiry ? "1fr 1fr" : "1fr", gap:12, marginBottom:12 }}>
            {[data.nearExpiry, data.nextExpiry].filter(Boolean).map((exp, i) => (
              <div key={i} style={{ background:"#0c0c12", border:"1px solid #14141e", borderRadius:10, padding:14 }}>
                <div style={{ fontSize:10, color:"#444", letterSpacing:2, marginBottom:10 }}>{i === 0 ? "NEAR EXPIRY" : "NEXT EXPIRY"} — {exp.expiry}</div>
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
                  <div style={{ background:"#00ff8810", borderRadius:6, padding:"10px 12px" }}>
                    <div style={{ fontSize:10, color:"#555", marginBottom:3 }}>Call Vol</div>
                    <div style={{ fontSize:14, fontWeight:700, color:"#00ff88" }}>{fmtVol(exp.callVol)}</div>
                    <div style={{ fontSize:10, color:"#444" }}>{fmtPrem(exp.callPremium)}</div>
                  </div>
                  <div style={{ background:"#ff333310", borderRadius:6, padding:"10px 12px" }}>
                    <div style={{ fontSize:10, color:"#555", marginBottom:3 }}>Put Vol</div>
                    <div style={{ fontSize:14, fontWeight:700, color:"#ff3333" }}>{fmtVol(exp.putVol)}</div>
                    <div style={{ fontSize:10, color:"#444" }}>{fmtPrem(exp.putPremium)}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Top Sweeps (big premium) */}
          {data.sweeps.length > 0 && (
            <div style={{ background:"#0c0c12", border:"1px solid #14141e", borderRadius:10, padding:16, marginBottom:12 }}>
              <div style={{ fontSize:10, color:"#ffcc00", letterSpacing:3, marginBottom:14 }}>💰 LARGE PREMIUM FLOW (SWEEPS)</div>
              {data.sweeps.map((s, i) => {
                const c = s.type === "CALL" ? "#00ff88" : "#ff3333";
                return (
                  <div key={i} style={{ display:"flex", alignItems:"center", gap:12, padding:"10px 0", borderBottom:"1px solid #0e0e18", flexWrap:"wrap" }}>
                    <span style={{ fontSize:12, fontWeight:900, color:c, width:50 }}>{s.type}</span>
                    <span style={{ fontSize:13, color:"#fff", fontWeight:700 }}>${s.strike}</span>
                    <span style={{ fontSize:11, color:"#555" }}>{s.expiry}</span>
                    <span style={{ fontSize:11, color:"#888" }}>@${s.mid}</span>
                    <span style={{ fontSize:11, color:"#888" }}>vol: {fmtVol(s.vol)}</span>
                    <span style={{ fontSize:13, fontWeight:700, color:c, marginLeft:"auto" }}>{fmtPrem(s.premium)}</span>
                    <span style={{ fontSize:10, color:"#555" }}>IV: {s.iv}%</span>
                    <span style={{ fontSize:11, padding:"2px 8px", borderRadius:4, background:c+"22", border:`1px solid ${c}44`, color:c }}>{s.sentiment}</span>
                  </div>
                );
              })}
            </div>
          )}

          {/* Unusual Activity */}
          {data.unusual.length > 0 && (
            <div style={{ background:"#0c0c12", border:"1px solid #14141e", borderRadius:10, padding:16, marginBottom:12 }}>
              <div style={{ fontSize:10, color:"#aa88ff", letterSpacing:3, marginBottom:4 }}>⚡ UNUSUAL ACTIVITY (Vol {">"} 2x OI)</div>
              <div style={{ fontSize:10, color:"#555", marginBottom:14 }}>Contracts where today's volume far exceeds open interest — indicates fresh positioning</div>
              <div style={{ overflowX:"auto" }}>
                <table style={{ width:"100%", borderCollapse:"collapse", fontSize:11 }}>
                  <thead>
                    <tr style={{ borderBottom:"1px solid #1a1a28" }}>
                      {["Type","Strike","Expiry","Vol","OI","Vol/OI","Mid","Premium","IV","OTM","Bias"].map(h => (
                        <th key={h} style={{ padding:"6px 8px", color:"#444", fontWeight:400, textAlign:"right", whiteSpace:"nowrap" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.unusual.map((u, i) => {
                      const c = u.type === "CALL" ? "#00ff88" : "#ff3333";
                      return (
                        <tr key={i} style={{ borderBottom:"1px solid #0e0e18" }}>
                          <td style={{ padding:"7px 8px", color:c, fontWeight:700 }}>{u.type}</td>
                          <td style={{ padding:"7px 8px", color:"#fff", fontWeight:700, textAlign:"right" }}>${u.strike}</td>
                          <td style={{ padding:"7px 8px", color:"#555", textAlign:"right" }}>{u.expiry}</td>
                          <td style={{ padding:"7px 8px", color:"#aaa", textAlign:"right" }}>{fmtVol(u.vol)}</td>
                          <td style={{ padding:"7px 8px", color:"#555", textAlign:"right" }}>{fmtVol(u.oi)}</td>
                          <td style={{ padding:"7px 8px", color:"#ffcc00", fontWeight:700, textAlign:"right" }}>{u.ratio}x</td>
                          <td style={{ padding:"7px 8px", color:"#888", textAlign:"right" }}>${u.mid}</td>
                          <td style={{ padding:"7px 8px", color:c, fontWeight:700, textAlign:"right" }}>{fmtPrem(u.premium)}</td>
                          <td style={{ padding:"7px 8px", color:"#555", textAlign:"right" }}>{u.iv}%</td>
                          <td style={{ padding:"7px 8px", textAlign:"right" }}>
                            <span style={{ color: u.otm ? "#ffcc00" : "#00aaff" }}>{u.otm ? "OTM" : "ITM"}</span>
                          </td>
                          <td style={{ padding:"7px 8px", textAlign:"right" }}>
                            <span style={{ color:c }}>{u.type === "CALL" ? "BULL" : "BEAR"}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* P/C Stats */}
          <div style={{ background:"#0c0c12", border:"1px solid #14141e", borderRadius:10, padding:16 }}>
            <div style={{ fontSize:10, color:"#444", letterSpacing:3, marginBottom:14 }}>FLOW INTERPRETATION</div>
            <div style={{ display:"grid", gridTemplateColumns:"repeat(2, 1fr)", gap:10, marginBottom:14 }}>
              {[
                { label:"P/C Vol Ratio",  val: data.flow.pcRatio,   note: data.flow.pcRatio < 0.7 ? "Bullish — heavy call buying" : data.flow.pcRatio > 1.3 ? "Bearish — heavy put buying" : "Neutral", color: data.flow.pcRatio < 0.7 ? "#00ff88" : data.flow.pcRatio > 1.3 ? "#ff3333" : "#ffcc00" },
                { label:"P/C OI Ratio",   val: data.flow.pcOIRatio, note: data.flow.pcOIRatio < 0.8 ? "Bullish positioning" : data.flow.pcOIRatio > 1.2 ? "Bearish positioning" : "Balanced OI", color: data.flow.pcOIRatio < 0.8 ? "#00ff88" : data.flow.pcOIRatio > 1.2 ? "#ff3333" : "#ffcc00" },
                { label:"Total Call Vol", val: fmtVol(data.flow.totalCallVol), note: "Bullish contracts traded", color:"#00ff88" },
                { label:"Total Put Vol",  val: fmtVol(data.flow.totalPutVol),  note: "Bearish contracts traded", color:"#ff3333" },
              ].map(({ label, val, note, color }) => (
                <div key={label} style={{ background:"#0a0a10", borderRadius:8, padding:12 }}>
                  <div style={{ fontSize:10, color:"#444", marginBottom:4 }}>{label}</div>
                  <div style={{ fontSize:18, fontWeight:700, color, marginBottom:4 }}>{val}</div>
                  <div style={{ fontSize:10, color:"#555" }}>{note}</div>
                </div>
              ))}
            </div>
            <div style={{ fontSize:10, color:"#333", lineHeight:1.6 }}>
              P/C &lt; 0.7 = bullish (more calls bought) · P/C &gt; 1.3 = bearish (more puts bought) · Net premium = total call $ minus total put $ flowing in today.
              Unusual activity = strikes where today volume exceeds open interest by 2x+ indicating fresh institutional positioning.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── SCANNER COMPONENT ────────────────────────────────────────────────────────
function ScannerTab({ onSelectTicker }) {
  const [scanning,      setScanning]      = useState(false);
  const [results,       setResults]       = useState(null);
  const [selectedList,  setSelectedList]  = useState("Ripster Favs");
  const [customTickers, setCustomTickers] = useState("");
  const [lastScan,      setLastScan]      = useState(null);
  const [notifEnabled,  setNotifEnabled]  = useState(false);
  const [error,         setError]         = useState("");

  const enableNotifications = async () => {
    if (!("Notification" in window)) return alert("Browser does not support notifications");
    const perm = await Notification.requestPermission();
    setNotifEnabled(perm === "granted");
  };

  const sendAlert = (ticker, direction, grade, prob) => {
    if (!notifEnabled) return;
    new Notification(`🎯 ${ticker} — ${direction} Signal`, {
      body: `Grade: ${grade} | Win Probability: ${prob}%\nRipster MTF setup detected`,
    });
  };

  const runScan = async () => {
    setScanning(true);
    setError("");
    try {
      const tickers = selectedList === "Custom"
        ? customTickers.split(",").map(t => t.trim().toUpperCase()).filter(Boolean)
        : WATCHLISTS[selectedList];

      if (!tickers.length) throw new Error("No tickers to scan");

      const res  = await fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tickers }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setResults(data);
      setLastScan(new Date());
      data.setups?.filter(s => s.grade === "A+" || s.grade === "A")
        .forEach(s => sendAlert(s.ticker, s.direction, s.grade, s.probability));
    } catch (e) {
      setError(e.message);
    } finally {
      setScanning(false);
    }
  };

  const pc = p => probColor(p);

  return (
    <div>
      <div style={{ background: "#0c0c12", border: "1px solid #14141e", borderRadius: 10, padding: 16, marginBottom: 12 }}>
        <div style={{ fontSize: 10, color: "#444", letterSpacing: 3, marginBottom: 12 }}>RIPSTER SETUP SCANNER</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
          {Object.keys(WATCHLISTS).map(list => (
            <button key={list} onClick={() => setSelectedList(list)}
              style={{ padding: "6px 14px", background: selectedList === list ? "#00ff8822" : "#0a0a10", border: `1px solid ${selectedList === list ? "#00ff88" : "#1e1e2e"}`, borderRadius: 6, color: selectedList === list ? "#00ff88" : "#555", fontSize: 11, cursor: "pointer" }}>
              {list}
            </button>
          ))}
        </div>
        {selectedList === "Custom" && (
          <input value={customTickers} onChange={e => setCustomTickers(e.target.value)}
            placeholder="TSLA, NVDA, AMD, HIMS..."
            style={{ width: "100%", padding: "8px 12px", background: "#0a0a10", border: "1px solid #1e1e2e", borderRadius: 6, color: "#e0e0e0", fontSize: 12, outline: "none", marginBottom: 10, fontFamily: "inherit" }} />
        )}
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={runScan} disabled={scanning}
            style={{ flex: 1, padding: "10px 0", background: scanning ? "#111" : "linear-gradient(135deg,#00ff88,#00ccaa)", border: "none", borderRadius: 6, color: "#000", fontSize: 13, fontWeight: 700, cursor: scanning ? "not-allowed" : "pointer" }}>
            {scanning ? "⏳ SCANNING..." : `▶ SCAN ${selectedList === "Custom" ? "CUSTOM LIST" : WATCHLISTS[selectedList]?.length + " TICKERS"}`}
          </button>
          <button onClick={enableNotifications}
            style={{ padding: "10px 14px", background: notifEnabled ? "#00ff8822" : "#0a0a10", border: `1px solid ${notifEnabled ? "#00ff88" : "#1e1e2e"}`, borderRadius: 6, color: notifEnabled ? "#00ff88" : "#555", fontSize: 11, cursor: "pointer" }}>
            {notifEnabled ? "🔔 ON" : "🔕 Alerts"}
          </button>
        </div>
        {error && <div style={{ color: "#ff5555", fontSize: 11, marginTop: 8 }}>⚠ {error}</div>}
        {lastScan && <div style={{ fontSize: 10, color: "#333", marginTop: 8 }}>Last scan: {lastScan.toLocaleTimeString()} · {results?.scanned} scanned · {results?.found} setups found</div>}
      </div>

      {results && results.setups.length === 0 && (
        <div style={{ textAlign: "center", padding: 40, color: "#333", fontSize: 13 }}>
          No high-probability setups right now. Try again on the next 10-min candle.
        </div>
      )}

      {results?.setups.map(s => {
        const c = pc(s.probability);
        const dc = dirColor(s.direction);
        return (
          <div key={s.ticker} style={{ background: "#0c0c12", border: `1px solid ${c}22`, borderLeft: `3px solid ${c}`, borderRadius: 10, padding: 16, marginBottom: 10, cursor: "pointer" }}
            onClick={() => onSelectTicker(s.ticker)}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
              <div style={{ flex: 1 }}>
                <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 8 }}>
                  <span style={{ fontSize: 20, fontWeight: 900, color: "#fff" }}>{s.ticker}</span>
                  <span style={{ fontSize: 16, fontWeight: 700, color: parseFloat(s.priceChange) >= 0 ? "#00ff88" : "#ff3333" }}>${f(s.price)}</span>
                  <span style={{ fontSize: 12, color: parseFloat(s.priceChange) >= 0 ? "#00ff88" : "#ff3333" }}>{parseFloat(s.priceChange) >= 0 ? "+" : ""}{s.priceChange}%</span>
                  <span style={{ fontSize: 10, color: "#444", marginLeft: "auto" }}>tap to analyze →</span>
                </div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 11, padding: "3px 10px", borderRadius: 4, background: dc + "22", border: `1px solid ${dc}`, color: dc, fontWeight: 700 }}>
                    {s.direction === "LONG" ? "▲" : "▼"} {s.direction}
                  </span>
                  <span style={{ fontSize: 11, padding: "3px 10px", borderRadius: 4, background: "#1a1a1a", border: "1px solid #333", color: c }}>{s.grade}</span>
                  <span style={{ fontSize: 11, padding: "3px 10px", borderRadius: 4, background: "#1a1a1a", border: "1px solid #333", color: s.cloud3450 === "BULLISH" ? "#00ff88" : "#ff3333" }}>Cloud: {s.cloud3450}</span>
                  <span style={{ fontSize: 11, padding: "3px 10px", borderRadius: 4, background: "#1a1a1a", border: "1px solid #333", color: s.priceVsCloud === "ABOVE" ? "#00ff88" : "#ff3333" }}>Price {s.priceVsCloud}</span>
                  {s.rvol && <span style={{ fontSize: 11, padding: "3px 10px", borderRadius: 4, background: s.rvol > 1.5 ? "#00ff8822" : "#1a1a1a", border: "1px solid #333", color: s.rvol > 1.5 ? "#00ff88" : "#888" }}>RVOL {s.rvol}x</span>}
                </div>
              </div>
              <div style={{ textAlign: "center", flexShrink: 0 }}>
                <div style={{ fontSize: 32, fontWeight: 900, color: c, lineHeight: 1 }}>{s.probability}%</div>
                <div style={{ fontSize: 9, color: "#444" }}>WIN PROB</div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 12, marginTop: 8, fontSize: 10, color: "#555" }}>
              <span>L:{s.longScore}/7</span><span>S:{s.shortScore}/7</span>
              {s.vwap && <span>VWAP:${s.vwap}</span>}
              <span>8/9:{s.cross89}</span>
              <span>5/13:{s.cloud513}</span>
              <span>34:{f(s.ema34)} / 50:{f(s.ema50)}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── PATTERN ENGINE COMPONENT ─────────────────────────────────────────────────
function PatternTab({ ticker }) {
  const [loading,  setLoading]  = useState(false);
  const [result,   setResult]   = useState(null);
  const [error,    setError]    = useState("");
  const [lookback, setLookback] = useState(10);
  const [forward,  setForward]  = useState(5);

  const run = async () => {
    setLoading(true);
    setError("");
    try {
      const res  = await fetch("/api/pattern", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker, lookback, forward }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setResult(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const gradeColor = g => g === "A+" ? "#00ff88" : g === "A" ? "#7fff00" : g === "B" ? "#ffcc00" : g === "C" ? "#ff8c00" : "#ff3333";

  return (
    <div>
      <div style={{ background: "#0c0c12", border: "1px solid #14141e", borderRadius: 10, padding: 16, marginBottom: 12 }}>
        <div style={{ fontSize: 10, color: "#444", letterSpacing: 3, marginBottom: 4 }}>PATTERN SIMILARITY ENGINE</div>
        <div style={{ fontSize: 11, color: "#555", marginBottom: 16, lineHeight: 1.6 }}>
          Finds historical moments where {ticker} looked exactly like it does right now.
          Shows you what happened next — win rate, avg move, best/worst case.
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 10, color: "#555", marginBottom: 4 }}>LOOKBACK (candles to match)</div>
            <select value={lookback} onChange={e => setLookback(Number(e.target.value))}
              style={{ width: "100%", padding: "8px 12px", background: "#0a0a10", border: "1px solid #1e1e2e", borderRadius: 6, color: "#e0e0e0", fontSize: 12, fontFamily: "inherit" }}>
              {[5,8,10,15,20].map(n => <option key={n} value={n}>{n} candles ({n * 10} min lookback)</option>)}
            </select>
          </div>
          <div>
            <div style={{ fontSize: 10, color: "#555", marginBottom: 4 }}>FORWARD (candles to predict)</div>
            <select value={forward} onChange={e => setForward(Number(e.target.value))}
              style={{ width: "100%", padding: "8px 12px", background: "#0a0a10", border: "1px solid #1e1e2e", borderRadius: 6, color: "#e0e0e0", fontSize: 12, fontFamily: "inherit" }}>
              {[3,5,8,10,15].map(n => <option key={n} value={n}>{n} candles ({n * 10} min forward)</option>)}
            </select>
          </div>
        </div>
        <button onClick={run} disabled={loading}
          style={{ width: "100%", padding: "11px 0", background: loading ? "#111" : "linear-gradient(135deg,#7fff00,#00ccaa)", border: "none", borderRadius: 6, color: "#000", fontSize: 13, fontWeight: 700, cursor: loading ? "not-allowed" : "pointer" }}>
          {loading ? "🔍 SCANNING 6 MONTHS OF HISTORY..." : `▶ RUN PATTERN MATCH ON ${ticker}`}
        </button>
        {error && <div style={{ color: "#ff5555", fontSize: 11, marginTop: 8 }}>⚠ {error}</div>}
      </div>

      {result && (
        <div>
          {/* Hero result */}
          <div style={{ background: "#0c0c12", border: `1px solid ${gradeColor(result.patternGrade)}33`, borderTop: `3px solid ${gradeColor(result.patternGrade)}`, borderRadius: 10, padding: 22, marginBottom: 12, position: "relative", overflow: "hidden" }}>
            <div style={{ position: "absolute", inset: 0, background: `radial-gradient(ellipse at 50% 0%, ${gradeColor(result.patternGrade)}06, transparent 60%)`, pointerEvents: "none" }} />
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 16 }}>
              <div>
                <div style={{ fontSize: 10, color: "#444", letterSpacing: 3, marginBottom: 6 }}>PATTERN MATCH RESULT — {result.ticker}</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: "#fff", marginBottom: 10 }}>
                  {result.patternsFound} similar historical setups found
                  <span style={{ fontSize: 11, color: "#555", marginLeft: 8 }}>avg {result.avgSimilarity}% match · {result.historicalBarsUsed} bars searched</span>
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ padding: "4px 14px", borderRadius: 6, background: gradeColor(result.patternGrade) + "22", border: `1px solid ${gradeColor(result.patternGrade)}`, color: gradeColor(result.patternGrade), fontSize: 13, fontWeight: 700 }}>
                    Pattern Grade: {result.patternGrade}
                  </span>
                  <span style={{ padding: "4px 14px", borderRadius: 6, background: dirColor(result.bias) + "22", border: `1px solid ${dirColor(result.bias)}44`, color: dirColor(result.bias), fontSize: 13, fontWeight: 700 }}>
                    Historical Bias: {result.bias}
                  </span>
                </div>
              </div>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: 58, fontWeight: 900, color: probColor(result.stats.winRate), lineHeight: 1 }}>{result.stats.winRate}%</div>
                <div style={{ fontSize: 10, color: "#444" }}>HISTORICAL WIN RATE</div>
                <div style={{ fontSize: 12, color: "#555", marginTop: 2 }}>{result.stats.bullishCount}W / {result.stats.bearishCount}L</div>
              </div>
            </div>
          </div>

          {/* Stats grid */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, marginBottom: 12 }}>
            {[
              { label: "Avg P&L", val: (result.stats.avgPnl >= 0 ? "+" : "") + result.stats.avgPnl + "%", color: result.stats.avgPnl >= 0 ? "#00ff88" : "#ff3333" },
              { label: "Avg Max Up", val: "+" + result.stats.avgMaxUp + "%", color: "#00ff88" },
              { label: "Avg Max Down", val: result.stats.avgMaxDown + "%", color: "#ff3333" },
              { label: "Best Case", val: "+" + result.stats.bestCase + "%", color: "#00ff88" },
              { label: "Worst Case", val: result.stats.worstCase + "%", color: "#ff3333" },
              { label: "Lookback / Forward", val: `${result.lookback} / ${result.forward} candles`, color: "#888" },
            ].map(({ label, val, color }) => (
              <div key={label} style={{ background: "#0c0c12", border: "1px solid #14141e", borderRadius: 8, padding: "12px 14px", textAlign: "center" }}>
                <div style={{ fontSize: 10, color: "#444", marginBottom: 4 }}>{label}</div>
                <div style={{ fontSize: 18, fontWeight: 700, color }}>{val}</div>
              </div>
            ))}
          </div>

          {/* Top matches table */}
          <div style={{ background: "#0c0c12", border: "1px solid #14141e", borderRadius: 10, padding: 16 }}>
            <div style={{ fontSize: 10, color: "#444", letterSpacing: 3, marginBottom: 14 }}>TOP 10 MOST SIMILAR HISTORICAL SETUPS</div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid #1a1a28" }}>
                    {["Date","Time","Entry","Exit","P&L %","Max Up","Max Down","Match %","Result"].map(h => (
                      <th key={h} style={{ padding: "6px 10px", color: "#444", fontWeight: 400, textAlign: "right", whiteSpace: "nowrap" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.topMatches.map((m, i) => (
                    <tr key={i} style={{ borderBottom: "1px solid #0e0e18" }}>
                      <td style={{ padding: "8px 10px", color: "#666" }}>{m.date}</td>
                      <td style={{ padding: "8px 10px", color: "#555" }}>{m.time}</td>
                      <td style={{ padding: "8px 10px", color: "#aaa", textAlign: "right" }}>${m.entryPrice}</td>
                      <td style={{ padding: "8px 10px", color: "#aaa", textAlign: "right" }}>${m.exitPrice}</td>
                      <td style={{ padding: "8px 10px", color: m.pnlPct >= 0 ? "#00ff88" : "#ff3333", textAlign: "right", fontWeight: 700 }}>{m.pnlPct >= 0 ? "+" : ""}{m.pnlPct}%</td>
                      <td style={{ padding: "8px 10px", color: "#00ff88", textAlign: "right" }}>+{m.maxUp}%</td>
                      <td style={{ padding: "8px 10px", color: "#ff3333", textAlign: "right" }}>{m.maxDown}%</td>
                      <td style={{ padding: "8px 10px", color: "#7fff00", textAlign: "right" }}>{m.similarity}%</td>
                      <td style={{ padding: "8px 10px", textAlign: "right" }}>
                        <span style={{ color: m.bullish ? "#00ff88" : "#ff3333", fontWeight: 700 }}>{m.bullish ? "✓ BULL" : "✗ BEAR"}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ marginTop: 12, fontSize: 10, color: "#333", lineHeight: 1.6 }}>
              Pattern matching uses euclidean distance on normalized price changes + volume similarity across 6 months of 10-min bars.
              Lower distance = closer match. This is not a guarantee — it shows historical base rates for similar setups.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── MAIN PAGE ────────────────────────────────────────────────────────────────
export default function Home() {
  const [ticker,     setTicker]     = useState("SPY");
  const [custom,     setCustom]     = useState("");
  const [status,     setStatus]     = useState("idle");
  const [error,      setError]      = useState("");
  const [analysis,   setAnalysis]   = useState(null);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [countdown,  setCountdown]  = useState(null);
  const [history,    setHistory]    = useState([]);
  const [activeTab,  setActiveTab]  = useState("overview");
  const countdownRef = useRef(null);

  const activeTicker = custom.trim().toUpperCase() || ticker;

  const refresh = useCallback(async (sym) => {
    const t = sym || activeTicker;
    try {
      setStatus("fetching"); setError("");
      const barsRes  = await fetch(`/api/bars?ticker=${t}`);
      const barsData = await barsRes.json();
      if (!barsRes.ok) throw new Error(barsData.error);

      setStatus("analyzing");
      const aiRes = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allBars: barsData, ticker: t, livePrice: barsData.livePrice }),
      });
      const ai = await aiRes.json();
      if (!aiRes.ok) throw new Error(ai.error);

      setAnalysis(ai);
      setLastUpdate(new Date());
      setStatus("live");
      setHistory(h => [{ time: new Date(), probability: ai.probability, direction: ai.direction, grade: ai.grade }, ...h].slice(0, 12));
    } catch (e) {
      setError(e.message); setStatus("error");
    }
  }, [activeTicker]);

  useEffect(() => {
    const tick = () => {
      const now      = new Date();
      const secsLeft = (10 - now.getMinutes() % 10) * 60 - now.getSeconds();
      setCountdown(secsLeft);
      if (now.getMinutes() % 10 === 0 && now.getSeconds() === 5 && status === "live") refresh();
    };
    tick();
    countdownRef.current = setInterval(tick, 1000);
    return () => clearInterval(countdownRef.current);
  }, [status, refresh]);

  const handleSelectTicker = (t) => {
    setCustom(t);
    setActiveTab("overview");
    setAnalysis(null);
    refresh(t);
  };

  const fmtCd = s => `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
  const pc    = analysis ? probColor(analysis.probability) : "#555";
  const ind   = analysis?._indicators;

  // ── Sub-components ──────────────────────────────────────────────────────────
  const TFRow = ({ label, data }) => {
    if (!data) return (
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderBottom: "1px solid #0e0e18" }}>
        <div style={{ width: 70, fontSize: 11, color: "#444", fontWeight: 700 }}>{label}</div>
        <div style={{ fontSize: 11, color: "#333" }}>NO DATA</div>
      </div>
    );
    const cc = data.cloud3450 === "BULLISH" ? "#00ff88" : "#ff3333";
    const pc2 = data.priceVsCloud === "ABOVE" ? "#00ff88" : data.priceVsCloud === "BELOW" ? "#ff3333" : "#ffcc00";
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 0", borderBottom: "1px solid #0e0e18", flexWrap: "wrap" }}>
        <div style={{ width: 70, fontSize: 11, color: "#888", fontWeight: 700 }}>{label}</div>
        <div style={{ fontSize: 13, color: "#fff", fontWeight: 700, width: 70 }}>${f(data.price)}</div>
        <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 4, background: cc + "22", border: `1px solid ${cc}`, color: cc }}>{data.cloud3450}</span>
        <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 4, color: pc2 }}>Price {data.priceVsCloud}</span>
        <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 4, color: dirColor(data.cloud513) }}>5/13 {data.cloud513}</span>
        <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 4, color: dirColor(data.cross89) }}>8/9 {data.cross89}</span>
        {data.rvol != null && <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 4, color: data.rvol > 1.5 ? "#00ff88" : "#888" }}>RVOL {f(data.rvol)}x</span>}
      </div>
    );
  };

  const ScoreBar = ({ label, score, weight }) => (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
        <span style={{ fontSize: 11, color: "#666" }}>{label}</span>
        <div style={{ display: "flex", gap: 8 }}>
          {weight && <span style={{ fontSize: 10, color: "#333" }}>{weight}</span>}
          <span style={{ fontSize: 12, fontWeight: 700, color: scoreColor(score) }}>{score}/10</span>
        </div>
      </div>
      <div style={{ background: "#0a0a10", borderRadius: 3, height: 4 }}>
        <div style={{ width: `${score * 10}%`, height: "100%", background: scoreColor(score), borderRadius: 3, transition: "width 1s ease" }} />
      </div>
    </div>
  );

  const TABS = ["overview","mtf","levels","volume","mktflow","flow","scanner","pattern"];

  return (
    <>
      <Head>
        <title>Ripster MTF AI — {activeTicker}</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>
      <div style={{ maxWidth: 1100, margin: "0 auto", padding: 16 }}>

        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18, paddingBottom: 14, borderBottom: "1px solid #12121e" }}>
          <div>
            <div style={{ fontSize: 10, color: "#333", letterSpacing: 4 }}>RIPSTER FULL STRATEGY ENGINE</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: "#fff" }}>MTF <span style={{ color: "#00ff88" }}>AI</span> Analyzer</div>
            <div style={{ fontSize: 10, color: "#333", marginTop: 2 }}>1m · 5m · 10m · 30m · Daily · VWAP · Scanner · Pattern Engine</div>
          </div>
          <div style={{ textAlign: "right" }}>
            {status === "live" && countdown && (
              <>
                <div style={{ fontSize: 9, color: "#444", letterSpacing: 2 }}>NEXT CANDLE</div>
                <div style={{ fontSize: 22, fontWeight: 700, color: countdown < 60 ? "#ff8c00" : "#00ff88" }}>{fmtCd(countdown)}</div>
              </>
            )}
            {status === "fetching"  && <div style={{ fontSize: 11, color: "#00aaff" }}>FETCHING...</div>}
            {status === "analyzing" && <div style={{ fontSize: 11, color: "#ffcc00" }}>AI THINKING...</div>}
          </div>
        </div>

        {/* Controls */}
        <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
          <select value={ticker} onChange={e => { setTicker(e.target.value); setCustom(""); }}
            style={{ padding: "10px 12px", background: "#0c0c14", border: "1px solid #1e1e2e", borderRadius: 6, color: "#00ff88", fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
            {TICKERS.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
          <input value={custom} onChange={e => setCustom(e.target.value.toUpperCase())} placeholder="Custom ticker..."
            style={{ flex: 1, minWidth: 100, padding: "10px 12px", background: "#0c0c14", border: "1px solid #1e1e2e", borderRadius: 6, color: "#e0e0e0", fontSize: 13, outline: "none", fontFamily: "inherit" }} />
          <button onClick={() => refresh()} disabled={status === "fetching" || status === "analyzing"}
            style={{ padding: "10px 24px", background: status === "fetching" || status === "analyzing" ? "#111" : "linear-gradient(135deg,#00ff88,#00ccaa)", border: "none", borderRadius: 6, color: "#000", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
            {status === "fetching" ? "LOADING..." : status === "analyzing" ? "ANALYZING..." : "▶ ANALYZE"}
          </button>
          {status === "live" && <button onClick={() => refresh()} style={{ padding: "10px 14px", background: "#0c0c14", border: "1px solid #1e1e2e", borderRadius: 6, color: "#888", fontSize: 13, cursor: "pointer" }}>↻</button>}
        </div>

        {/* Price bar */}
        {ind?.tf10m && (
          <div style={{ display: "flex", gap: 16, alignItems: "center", marginBottom: 14, padding: "10px 14px", background: "#0c0c12", borderRadius: 8, border: "1px solid #14141e" }}>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#00ff88", boxShadow: "0 0 8px #00ff88" }} />
            <span style={{ fontSize: 13, fontWeight: 700, color: "#555" }}>{activeTicker}</span>
            <span style={{ fontSize: 22, fontWeight: 900, color: ind.tf10m.priceChange >= 0 ? "#00ff88" : "#ff3333" }}>${f(ind.tf10m.price)}</span>
            <span style={{ fontSize: 13, color: ind.tf10m.priceChange >= 0 ? "#00ff88" : "#ff3333" }}>
              {ind.tf10m.priceChange >= 0 ? "+" : ""}{f(ind.tf10m.priceChange)} ({ind.tf10m.pricePct >= 0 ? "+" : ""}{f(ind.tf10m.pricePct)}%)
            </span>
            {lastUpdate && <span style={{ fontSize: 10, color: "#222", marginLeft: "auto" }}>Updated {lastUpdate.toLocaleTimeString()}</span>}
          </div>
        )}

        {/* Error */}
        {error && <div style={{ background: "#120808", border: "1px solid #ff555533", borderRadius: 8, padding: 14, color: "#ff5555", fontSize: 12, marginBottom: 14 }}>⚠ {error}</div>}

        {/* Loading */}
        {(status === "fetching" || status === "analyzing") && !analysis && (
          <div style={{ textAlign: "center", padding: 80 }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>{status === "fetching" ? "📡" : "🧠"}</div>
            <div style={{ color: status === "fetching" ? "#00aaff" : "#ffcc00", fontSize: 14 }}>
              {status === "fetching" ? "Fetching 5 timeframes..." : "Running full MTF analysis..."}
            </div>
          </div>
        )}

        {/* Analysis hero (always visible) */}
        {analysis && (
          <div style={{ background: "#0c0c12", border: `1px solid ${pc}22`, borderTop: `3px solid ${pc}`, borderRadius: 10, padding: 22, marginBottom: 12, position: "relative", overflow: "hidden" }}>
            <div style={{ position: "absolute", inset: 0, background: `radial-gradient(ellipse at 50% 0%, ${pc}07, transparent 60%)`, pointerEvents: "none" }} />
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 16 }}>
              <div style={{ flex: 1, minWidth: 220 }}>
                <div style={{ fontSize: 10, color: "#444", letterSpacing: 3, marginBottom: 4 }}>RIPSTER SIGNAL — {activeTicker}</div>
                <div style={{ fontSize: 17, fontWeight: 700, color: "#fff", marginBottom: 10 }}>{analysis.signal}</div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ display: "inline-block", background: analysis.direction === "LONG" ? "#00ff8818" : analysis.direction === "SHORT" ? "#ff555518" : "#22222218", border: `1px solid ${analysis.direction === "LONG" ? "#00ff88" : analysis.direction === "SHORT" ? "#ff5555" : "#444"}`, borderRadius: 6, padding: "5px 14px", fontSize: 13, fontWeight: 700, color: analysis.direction === "LONG" ? "#00ff88" : analysis.direction === "SHORT" ? "#ff5555" : "#888" }}>
                    {analysis.direction === "LONG" ? "▲ LONG" : analysis.direction === "SHORT" ? "▼ SHORT" : "— STAND DOWN"}
                  </span>
                  <span style={{ display: "inline-block", background: "#1a1a1a", border: "1px solid #333", borderRadius: 6, padding: "5px 14px", fontSize: 12, color: dirColor(analysis.dailyBias) }}>Daily: {analysis.dailyBias}</span>
                  <span style={{ display: "inline-block", background: "#1a1a1a", border: "1px solid #333", borderRadius: 6, padding: "5px 14px", fontSize: 12, color: "#ffcc00" }}>MTF: {analysis.mtfAlignment?.score}/5</span>
                  {analysis.longScore != null && <span style={{ display: "inline-block", background: "#1a1a1a", border: "1px solid #333", borderRadius: 6, padding: "5px 14px", fontSize: 11, color: "#555" }}>L:{analysis.longScore} S:{analysis.shortScore}</span>}
                </div>
              </div>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: 58, fontWeight: 900, color: pc, lineHeight: 1 }}>{analysis.probability}%</div>
                <div style={{ fontSize: 10, color: "#444", marginTop: 2 }}>WIN PROBABILITY</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: pc }}>{analysis.grade} · {analysis.sizing}</div>
              </div>
            </div>
            <div style={{ background: "#0a0a10", border: "1px solid #1a1a28", borderRadius: 8, padding: 12, marginTop: 14 }}>
              <span style={{ fontSize: 10, color: "#555", letterSpacing: 2 }}>ACTION NOW → </span>
              <span style={{ fontSize: 14, color: "#fff", fontWeight: 600 }}>{analysis.action}</span>
            </div>
            <div style={{ marginTop: 12, fontSize: 12, color: "#777", lineHeight: 1.8, fontStyle: "italic" }}>"{analysis.verdict}"</div>
          </div>
        )}

        {/* Tab Nav */}
        <div style={{ display: "flex", gap: 3, marginBottom: 12, flexWrap: "wrap" }}>
          {TABS.map(tab => (
            <button key={tab} onClick={() => setActiveTab(tab)}
              style={{ flex: 1, minWidth: 60, padding: "8px 4px", background: activeTab === tab ? "#0c0c14" : "transparent", border: activeTab === tab ? "1px solid #1e1e2e" : "1px solid transparent", borderRadius: 6, color: activeTab === tab ? "#00ff88" : "#444", fontSize: 10, textTransform: "uppercase", letterSpacing: 1, cursor: "pointer" }}>
              {tab === "overview" ? "Overview" : tab === "mtf" ? "MTF Clouds" : tab === "levels" ? "Key Levels" : tab === "volume" ? "Volume" : tab === "mktflow" ? "🌊 Mkt Flow" : tab === "flow" ? "💰 Flow" : tab === "scanner" ? "🔍 Scanner" : "🧠 Pattern"}
            </button>
          ))}
        </div>

        {/* OVERVIEW */}
        {activeTab === "overview" && analysis && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div style={{ background: "#0c0c12", border: "1px solid #14141e", borderRadius: 10, padding: 16 }}>
              <div style={{ fontSize: 10, color: "#444", letterSpacing: 3, marginBottom: 14 }}>CONFLUENCE SCORES</div>
              <ScoreBar label="Daily Trend"        score={analysis.scores?.dailyTrend}    weight="—" />
              <ScoreBar label="34/50 Cloud (10m)"  score={analysis.scores?.cloud3450_10m} weight="25%" />
              <ScoreBar label="5/13 Cloud (10m)"   score={analysis.scores?.cloud513_10m}  weight="20%" />
              <ScoreBar label="VWAP"               score={analysis.scores?.vwap}          weight="15%" />
              <ScoreBar label="Volume"             score={analysis.scores?.volume}        weight="15%" />
              <ScoreBar label="8/9 Cross"          score={analysis.scores?.cross89}       weight="10%" />
              <ScoreBar label="Price Action"       score={analysis.scores?.priceAction}   weight="10%" />
              <ScoreBar label="Key Levels"         score={analysis.scores?.keyLevels}     weight="—" />
              <ScoreBar label="MTF Confluence"     score={analysis.scores?.mtfConfluence} weight="—" />
              <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid #1a1a28" }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
                  <span style={{ fontSize: 11, color: "#888" }}>OVERALL</span>
                  <span style={{ fontSize: 14, fontWeight: 900, color: pc }}>{analysis.probability}%</span>
                </div>
                <div style={{ background: "#0a0a10", borderRadius: 4, height: 8 }}>
                  <div style={{ width: `${analysis.probability}%`, height: "100%", background: `linear-gradient(90deg,${pc}88,${pc})`, borderRadius: 4, transition: "width 1.2s ease", boxShadow: `0 0 10px ${pc}44` }} />
                </div>
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ background: "#0c0c12", border: "1px solid #14141e", borderRadius: 10, padding: 16 }}>
                <div style={{ fontSize: 10, color: "#444", letterSpacing: 3, marginBottom: 14 }}>TRADE PLAN</div>
                {[
                  { label: "Entry",         val: analysis.entry,   color: "#fff" },
                  { label: "Stop Loss",     val: analysis.stop,    color: "#ff5555" },
                  { label: "Target 1",      val: analysis.target1, color: "#00ff88" },
                  { label: "Target 2",      val: analysis.target2, color: "#00cc66" },
                  { label: "Risk:Reward",   val: analysis.rr,      color: "#ffcc00" },
                  { label: "Position Size", val: analysis.sizing,  color: pc },
                ].map(({ label, val, color }) => (
                  <div key={label} style={{ display: "flex", justifyContent: "space-between", marginBottom: 9, paddingBottom: 9, borderBottom: "1px solid #0e0e18" }}>
                    <span style={{ fontSize: 11, color: "#555" }}>{label}</span>
                    <span style={{ fontSize: 12, color, fontWeight: 600, textAlign: "right", maxWidth: "60%" }}>{val}</span>
                  </div>
                ))}
              </div>
              <div style={{ background: "#0c0c12", border: "1px solid #14141e", borderRadius: 10, padding: 16, flex: 1 }}>
                <div style={{ fontSize: 10, color: "#444", letterSpacing: 3, marginBottom: 12 }}>RISKS</div>
                {analysis.risks?.map((r, i) => (
                  <div key={i} style={{ fontSize: 11, color: "#888", marginBottom: 9, paddingLeft: 10, borderLeft: "2px solid #ff555533", lineHeight: 1.5 }}>⚠ {r}</div>
                ))}
                <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid #1a1a28" }}>
                  <div style={{ fontSize: 10, color: "#444", letterSpacing: 2, marginBottom: 5 }}>WATCH NEXT BAR:</div>
                  <div style={{ fontSize: 11, color: "#00aaff", lineHeight: 1.6 }}>{analysis.nextWatch}</div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* MTF CLOUDS */}
        {activeTab === "mtf" && (
          <div style={{ background: "#0c0c12", border: "1px solid #14141e", borderRadius: 10, padding: 20 }}>
            <div style={{ fontSize: 10, color: "#444", letterSpacing: 3, marginBottom: 6 }}>MULTI-TIMEFRAME EMA CLOUD ANALYSIS</div>
            {analysis && (
              <div style={{ fontSize: 11, color: "#555", marginBottom: 16 }}>
                MTF Score: <span style={{ color: analysis.mtfAlignment?.score >= 4 ? "#00ff88" : "#ffcc00", fontWeight: 700 }}>{analysis.mtfAlignment?.score}/5</span>
              </div>
            )}
            {analysis && (
              <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
                {[
                  { label: "Daily", key: "daily" },
                  { label: "30m",   key: "thirtyMin" },
                  { label: "10m ★", key: "tenMin" },
                  { label: "5m",    key: "fiveMin" },
                  { label: "1m",    key: "oneMin" },
                ].map(({ label, key }) => {
                  const val = analysis.mtfAlignment?.[key];
                  const c   = val === "BULL" ? "#00ff88" : val === "BEAR" ? "#ff3333" : "#ffcc00";
                  return (
                    <div key={key} style={{ flex: 1, textAlign: "center", background: c + "11", border: `1px solid ${c}44`, borderRadius: 8, padding: "12px 4px" }}>
                      <div style={{ fontSize: 10, color: "#555", marginBottom: 4 }}>{label}</div>
                      <div style={{ fontSize: 12, fontWeight: 700, color: c }}>{val || "—"}</div>
                    </div>
                  );
                })}
              </div>
            )}
            {ind && (
              <>
                <TFRow label="DAILY"    data={ind.tfDay} />
                <TFRow label="30-MIN"   data={ind.tf30m} />
                <TFRow label="10-MIN ★" data={ind.tf10m} />
                <TFRow label="5-MIN"    data={ind.tf5m}  />
                <TFRow label="1-MIN"    data={ind.tf1m}  />
                <div style={{ marginTop: 20, paddingTop: 16, borderTop: "1px solid #14141e" }}>
                  <div style={{ fontSize: 10, color: "#444", letterSpacing: 3, marginBottom: 12 }}>VWAP LEVELS</div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 8 }}>
                    {[
                      { label: "VWAP",     val: f(ind.vwap),   color: "#00aaff" },
                      { label: "Upper 1σ", val: f(ind.upper1), color: "#ffcc00" },
                      { label: "Lower 1σ", val: f(ind.lower1), color: "#ffcc00" },
                      { label: "Upper 2σ", val: f(ind.upper2), color: "#ff8c00" },
                      { label: "Lower 2σ", val: f(ind.lower2), color: "#ff8c00" },
                    ].map(({ label, val, color }) => (
                      <div key={label} style={{ background: "#0a0a10", borderRadius: 6, padding: "10px 8px", textAlign: "center" }}>
                        <div style={{ fontSize: 10, color: "#444", marginBottom: 4 }}>{label}</div>
                        <div style={{ fontSize: 13, fontWeight: 700, color }}>${val}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
            {!ind && <div style={{ color: "#333", textAlign: "center", padding: 40 }}>Run analysis first</div>}
          </div>
        )}

        {/* KEY LEVELS */}
        {activeTab === "levels" && (
          <div style={{ background: "#0c0c12", border: "1px solid #14141e", borderRadius: 10, padding: 20 }}>
            <div style={{ fontSize: 10, color: "#444", letterSpacing: 3, marginBottom: 18 }}>KEY PRICE LEVELS</div>
            {analysis ? (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12 }}>
                {[
                  { label: "Prior Day High (PDH)",  val: analysis.keyLevels?.pdh,        color: "#ff3333", note: "Major resistance" },
                  { label: "Prior Day Low (PDL)",   val: analysis.keyLevels?.pdl,        color: "#00ff88", note: "Major support" },
                  { label: "Pre-Market High (PMH)", val: analysis.keyLevels?.pmh,        color: "#ff8c00", note: "Opening range resistance" },
                  { label: "Pre-Market Low (PML)",  val: analysis.keyLevels?.pml,        color: "#7fff00", note: "Opening range support" },
                  { label: "High of Day (HOD)",     val: analysis.keyLevels?.hod,        color: "#ffcc00", note: "Intraday resistance" },
                  { label: "Low of Day (LOD)",      val: analysis.keyLevels?.lod,        color: "#ffcc00", note: "Intraday support" },
                  { label: "VWAP",                  val: analysis.keyLevels?.vwap,       color: "#00aaff", note: "Institutional pivot" },
                  { label: "Nearest Resistance",    val: analysis.keyLevels?.resistance, color: "#ff8c00", note: "Target / stop area" },
                  { label: "Nearest Support",       val: analysis.keyLevels?.support,    color: "#7fff00", note: "Stop / entry area" },
                  { label: "Gap",                   val: ind?.gap ? (parseFloat(ind.gap) >= 0 ? "+" : "") + ind.gap + "%" : "—", color: ind?.gap && parseFloat(ind.gap) > 0 ? "#00ff88" : "#ff3333", note: "From prev close" },
                ].map(({ label, val, color, note }) => (
                  <div key={label} style={{ background: "#0a0a10", borderRadius: 8, padding: 14, border: `1px solid ${color}22` }}>
                    <div style={{ fontSize: 10, color: "#444", marginBottom: 4 }}>{label}</div>
                    <div style={{ fontSize: 18, fontWeight: 700, color, marginBottom: 4 }}>{val}</div>
                    <div style={{ fontSize: 10, color: "#444" }}>{note}</div>
                  </div>
                ))}
              </div>
            ) : <div style={{ color: "#333", textAlign: "center", padding: 40 }}>Run analysis first</div>}
          </div>
        )}

        {/* VOLUME */}
        {activeTab === "volume" && (
          <div style={{ background: "#0c0c12", border: "1px solid #14141e", borderRadius: 10, padding: 20 }}>
            <div style={{ fontSize: 10, color: "#444", letterSpacing: 3, marginBottom: 18 }}>VOLUME ANALYSIS</div>
            {ind ? (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 16 }}>
                  {[
                    { label: "10m RVOL", val: ind.tf10m?.rvol,  color: ind.tf10m?.rvol > 1.5 ? "#00ff88" : ind.tf10m?.rvol > 1.0 ? "#ffcc00" : "#ff3333" },
                    { label: "5m RVOL",  val: ind.tf5m?.rvol,   color: ind.tf5m?.rvol  > 1.5 ? "#00ff88" : ind.tf5m?.rvol  > 1.0 ? "#ffcc00" : "#ff3333" },
                    { label: "1m RVOL",  val: ind.tf1m?.rvol,   color: ind.tf1m?.rvol  > 1.5 ? "#00ff88" : ind.tf1m?.rvol  > 1.0 ? "#ffcc00" : "#ff3333" },
                  ].map(({ label, val, color }) => (
                    <div key={label} style={{ background: "#0a0a10", borderRadius: 8, padding: 16, textAlign: "center" }}>
                      <div style={{ fontSize: 10, color: "#444", marginBottom: 6 }}>{label}</div>
                      <div style={{ fontSize: 24, fontWeight: 900, color }}>{val ? f(val) + "x" : "—"}</div>
                    </div>
                  ))}
                </div>
                {analysis?.volumeAnalysis && (
                  <div style={{ background: "#0a0a10", borderRadius: 8, padding: 16, marginBottom: 12 }}>
                    <div style={{ fontSize: 10, color: "#444", marginBottom: 8 }}>VOLUME STORY</div>
                    <div style={{ fontSize: 13, color: "#aaa", lineHeight: 1.7 }}>{analysis.volumeAnalysis}</div>
                  </div>
                )}
                <div style={{ background: "#0a0a10", borderRadius: 8, padding: 16 }}>
                  <div style={{ fontSize: 10, color: "#444", marginBottom: 10 }}>RIPSTER VOLUME RULES</div>
                  {[
                    "RVOL > 2.0x — Full conviction, strong institutional participation",
                    "RVOL 1.5–2.0x — Good setup, proceed with normal size",
                    "RVOL 1.0–1.5x — Marginal, consider half size",
                    "RVOL < 1.0x — No conviction, reduce size significantly",
                    "Volume dry-up on pullback — Healthy, continuation likely",
                    "Volume spike at key level — Watch for reversal",
                  ].map((rule, i) => (
                    <div key={i} style={{ fontSize: 11, color: "#555", marginBottom: 7, paddingLeft: 10, borderLeft: "2px solid #1e1e2e", lineHeight: 1.5 }}>{rule}</div>
                  ))}
                </div>
              </>
            ) : <div style={{ color: "#333", textAlign: "center", padding: 40 }}>Run analysis first</div>}
          </div>
        )}


        {/* MARKET FLOW */}
        {activeTab === "mktflow" && (
          <MarketFlowTab onSelectTicker={handleSelectTicker} />
        )}

        {/* FLOW */}
        {activeTab === "flow" && (
          <FlowTab ticker={activeTicker} />
        )}

        {/* SCANNER */}
        {activeTab === "scanner" && (
          <ScannerTab onSelectTicker={handleSelectTicker} />
        )}

        {/* PATTERN ENGINE */}
        {activeTab === "pattern" && (
          <PatternTab ticker={activeTicker} />
        )}

        {/* Session history */}
        {history.length > 1 && activeTab !== "scanner" && activeTab !== "pattern" && (
          <div style={{ background: "#0c0c12", border: "1px solid #14141e", borderRadius: 10, padding: 14, marginTop: 12 }}>
            <div style={{ fontSize: 10, color: "#444", letterSpacing: 3, marginBottom: 10 }}>SESSION HISTORY</div>
            <div style={{ display: "flex", gap: 8, overflowX: "auto" }}>
              {history.map((h, i) => (
                <div key={i} style={{ flexShrink: 0, background: "#0a0a10", border: `1px solid ${probColor(h.probability)}33`, borderRadius: 6, padding: "8px 12px", textAlign: "center", minWidth: 70 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: probColor(h.probability) }}>{h.probability}%</div>
                  <div style={{ fontSize: 9, color: dirColor(h.direction), marginTop: 2 }}>{h.direction}</div>
                  <div style={{ fontSize: 9, color: "#333", marginTop: 2 }}>{h.time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {status === "idle" && activeTab === "overview" && (
          <div style={{ textAlign: "center", padding: 80, color: "#333" }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>📊</div>
            <div style={{ fontSize: 14, marginBottom: 6 }}>Select a ticker and hit Analyze</div>
            <div style={{ fontSize: 11, marginBottom: 4 }}>Or use the 🔍 Scanner tab to find live setups</div>
            <div style={{ fontSize: 11 }}>Use the 🧠 Pattern tab to see historical win rates</div>
          </div>
        )}

        <div style={{ textAlign: "center", marginTop: 20, fontSize: 9, color: "#1e1e1e" }}>
          NOT FINANCIAL ADVICE · EDUCATIONAL ONLY · ALWAYS MANAGE YOUR RISK
        </div>
      </div>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;600;700&display=swap');
        * { box-sizing: border-box; }
        body { font-family: 'IBM Plex Mono', monospace; background: #060608; color: #c8c8d0; margin: 0; }
        input, select, button, textarea { font-family: inherit; }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
        ::-webkit-scrollbar { width: 4px; height: 4px; }
        ::-webkit-scrollbar-track { background: #0a0a0c; }
        ::-webkit-scrollbar-thumb { background: #1e1e28; border-radius: 2px; }
      `}</style>
    </>
  );
}
