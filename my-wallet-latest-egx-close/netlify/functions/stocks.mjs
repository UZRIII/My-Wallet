const TICKERS = [
  "ATLC","MBSC","MPCI","NINH","MICH","EGAL","ABUK","ATQA","ISMA","EFID",
  "ISMQ","CLHO","ETRS","RUBX","CPCI","AMOC","EFIH","SUGR","PHDC","POUL",
  "MASR","SWDY","ADIB","RMDA","ISPH","ORHD","MCQE","ORAS","OCDI","SAUD",
  "ORWE","FAIT","RACC","ZMID","ETEL","ARCC","TMGH","JUFO"
];

function toNumber(v) {
  if (typeof v === "string") v = v.replace(/,/g, "").trim();
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function getText(url) {
  const response = await fetch(url, {
    headers: {
      "Accept": "text/html,application/xhtml+xml",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36"
    }
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.text();
}

/*
  DO NOT use Yahoo here.
  Yahoo's ORAS.CA feed is stale for this EGX listing and can return 71.05,
  while the actual latest EGX close is 850.02.

  Primary source:
  StockAnalysis historical daily table.
  We take the CLOSE column from the newest completed trading-day row.
*/
async function stockAnalysisClose(symbol) {
  const url = `https://stockanalysis.com/quote/egx/${symbol}/history/`;
  const html = await getText(url);

  // StockAnalysis renders rows like:
  // <tr><td>Sep 3, 2026</td><td>831.50</td><td>890.00</td>...
  const rowRegex =
    /<tr[^>]*>\s*<td[^>]*>([A-Z][a-z]{2}\s+\d{1,2},\s+\d{4})<\/td>([\s\S]*?)<\/tr>/gi;

  const rows = [];
  let match;

  while ((match = rowRegex.exec(html)) !== null) {
    const dateText = match[1];
    const cells = [...match[2].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
      .map(m => m[1].replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim());

    // Daily table columns: Date, Open, High, Low, Close, Adj Close, Change, Volume
    const close = toNumber(cells[4]);
    if (close) {
      rows.push({ date: dateText, close });
    }
  }

  if (!rows.length) {
    // Some deployments serialize the table differently; use the visible
    // text as a second parser and look for the first date + OHLC sequence.
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ");

    const textRegex =
      /([A-Z][a-z]{2}\s+\d{1,2},\s+\d{4})\s+([\d,]+(?:\.\d+)?)\s+([\d,]+(?:\.\d+)?)\s+([\d,]+(?:\.\d+)?)\s+([\d,]+(?:\.\d+)?)/g;

    while ((match = textRegex.exec(text)) !== null) {
      const close = toNumber(match[5]);
      if (close) rows.push({ date: match[1], close });
    }
  }

  if (!rows.length) {
    throw new Error("StockAnalysis history table could not be parsed");
  }

  return rows[0]; // newest daily row
}

async function investingClose(symbol) {
  const url = `https://www.investing.com/equities/${symbol.toLowerCase()}-historical-data`;
  const html = await getText(url);

  // Fallback only. Prefer StockAnalysis because its page explicitly exposes
  // daily OHLC history with a Close column.
  const patterns = [
    /"close"\s*:\s*"?([\d,]+(?:\.\d+)?)"?/i,
    /"last_close"\s*:\s*"?([\d,]+(?:\.\d+)?)"?/i
  ];

  for (const pattern of patterns) {
    const m = html.match(pattern);
    const n = m && toNumber(m[1]);
    if (n) return { date: null, close: n };
  }

  throw new Error("Investing fallback returned no close");
}

async function getClose(symbol) {
  try {
    return { ...(await stockAnalysisClose(symbol)), source: "StockAnalysis daily history" };
  } catch (primaryError) {
    try {
      return { ...(await investingClose(symbol)), source: "Investing fallback" };
    } catch (fallbackError) {
      throw new Error(
        `history unavailable; primary=${primaryError.message}; fallback=${fallbackError.message}`
      );
    }
  }
}

export default async () => {
  const prices = {};
  const dates = {};
  const sources = {};
  const errors = [];

  // Batch requests to stay friendly to the data providers.
  for (let i = 0; i < TICKERS.length; i += 6) {
    const batch = TICKERS.slice(i, i + 6);

    const results = await Promise.allSettled(
      batch.map(async symbol => [symbol, await getClose(symbol)])
    );

    for (let j = 0; j < results.length; j++) {
      const r = results[j];

      if (r.status === "fulfilled") {
        const [symbol, quote] = r.value;
        prices[symbol] = quote.close;
        sources[symbol] = quote.source;
        if (quote.date) dates[symbol] = quote.date;
      } else {
        errors.push(`${batch[j]}: ${r.reason?.message || r.reason}`);
      }
    }
  }

  if (!Object.keys(prices).length) {
    return new Response(JSON.stringify({
      ok: false,
      prices: {},
      count: 0,
      total: TICKERS.length,
      mode: "LATEST_COMPLETED_DAILY_CLOSE",
      updatedAt: new Date().toISOString(),
      errors
    }), {
      status: 502,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store"
      }
    });
  }

  return new Response(JSON.stringify({
    ok: true,
    prices,
    count: Object.keys(prices).length,
    total: TICKERS.length,
    mode: "LATEST_COMPLETED_DAILY_CLOSE",
    updatedAt: new Date().toISOString(),
    dates,
    sources,
    errors: errors.slice(0, 20)
  }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store, max-age=0, must-revalidate"
    }
  });
};
