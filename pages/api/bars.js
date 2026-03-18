export default async function handler(req, res) {
  const { ticker } = req.query;
  if (!ticker) return res.status(400).json({ error: "ticker required" });

  const apiKey = process.env.ALPACA_API_KEY;
  const apiSecret = process.env.ALPACA_API_SECRET;
  if (!apiKey || !apiSecret) return res.status(500).json({ error: "Alpaca API keys not set." });

  const headers = {
    "APCA-API-KEY-ID": apiKey,
    "APCA-API-SECRET-KEY": apiSecret,
  };

  try {
    const sym = ticker.toUpperCase();
    const now = new Date();
    const s7 = new Date(now); s7.setDate(now.getDate() - 7);
    const s30 = new Date(now); s30.setDate(now.getDate() - 30);
    const s90 = new Date(now); s90.setDate(now.getDate() - 90);
    const fmt = d => d.toISOString().split("T")[0];

    const [res1m, res5m, res10m, res30m, resDay, resTrade] = await Promise.all([
      fetch(`https://data.alpaca.markets/v2/stocks/${sym}/bars?timeframe=1Min&start=${fmt(s7)}&limit=400&sort=asc`, { headers }),
      fetch(`https://data.alpaca.markets/v2/stocks/${sym}/bars?timeframe=5Min&start=${fmt(s7)}&limit=400&sort=asc`, { headers }),
      fetch(`https://data.alpaca.markets/v2/stocks/${sym}/bars?timeframe=10Min&start=${fmt(s30)}&limit=400&sort=asc`, { headers }),
      fetch(`https://data.alpaca.markets/v2/stocks/${sym}/bars?timeframe=30Min&start=${fmt(s30)}&limit=400&sort=asc`, { headers }),
      fetch(`https://data.alpaca.markets/v2/stocks/${sym}/bars?timeframe=1Day&start=${fmt(s90)}&limit=100&sort=asc`, { headers }),
      fetch(`https://data.alpaca.markets/v2/stocks/${sym}/trades/latest`, { headers }),
    ]);

    const parse = async (r, label) => {
      if (!r.ok) { console.warn(`${label} failed: ${r.status}`); return []; }
      const d = await r.json();
      return (d.bars || []).map(b => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
    };

    const [bars1m, bars5m, bars10m, bars30m, barsDay] = await Promise.all([
      parse(res1m, "1m"), parse(res5m, "5m"), parse(res10m, "10m"),
      parse(res30m, "30m"), parse(resDay, "Day"),
    ]);

    if (!bars10m.length) throw new Error("No 10m bars returned. Market may be closed.");

    let livePrice = null;
    if (resTrade.ok) {
      const td = await resTrade.json();
      livePrice = td?.trade?.p || null;
    }

    const patchLive = (bars) => {
      if (!livePrice || !bars.length) return bars;
      const last = { ...bars[bars.length - 1] };
      last.c = livePrice;
      if (livePrice > last.h) last.h = livePrice;
      if (livePrice < last.l) last.l = livePrice;
      return [...bars.slice(0, -1), last];
    };

    res.status(200).json({
      bars1m: patchLive(bars1m),
      bars5m: patchLive(bars5m),
      bars10m: patchLive(bars10m),
      bars30m: patchLive(bars30m),
      barsDay,
      livePrice,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
