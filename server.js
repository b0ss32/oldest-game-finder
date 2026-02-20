const express = require("express");
const app = express();

app.use(express.json({ limit: "200kb" }));

app.get("/", (req, res) => res.send("OK"));

function isArr(x){ return Array.isArray(x); }
function toStr(x){ return (x ?? "").toString(); }
function low(x){ return toStr(x).toLowerCase(); }
function num(x){ const n = Number(x); return Number.isFinite(n) ? n : null; }

// Pull titles + ids from lots of possible shapes
function extractCandidates(sData) {
  const out = [];

  // Common containers
  const buckets = [];

  // 1) direct arrays
  if (isArr(sData?.searchResults)) buckets.push(sData.searchResults);
  if (isArr(sData?.results)) buckets.push(sData.results);
  if (isArr(sData?.data)) buckets.push(sData.data);
  if (isArr(sData?.items)) buckets.push(sData.items);

  // 2) nested: searchResults[].contents / searchResults[].results
  if (isArr(sData?.searchResults)) {
    for (const b of sData.searchResults) {
      if (isArr(b?.contents)) buckets.push(b.contents);
      if (isArr(b?.results)) buckets.push(b.results);
      if (isArr(b?.items)) buckets.push(b.items);
    }
  }

  // Flatten buckets into candidates
  for (const arr of buckets) {
    for (const r of arr) {
      const name =
        toStr(r?.name) ||
        toStr(r?.title) ||
        toStr(r?.displayName) ||
        toStr(r?.contentName) ||
        toStr(r?.content?.name) ||
        toStr(r?.content?.title);

      const placeId =
        num(r?.placeId) ??
        num(r?.rootPlaceId) ??
        num(r?.contentId) ??
        num(r?.id) ??
        num(r?.content?.placeId) ??
        num(r?.content?.rootPlaceId) ??
        num(r?.content?.id);

      const universeId =
        num(r?.universeId) ??
        num(r?.content?.universeId) ??
        num(r?.universe?.id);

      if (name || placeId || universeId) {
        out.push({ name, placeId, universeId, raw: r });
      }
      if (out.length >= 200) return out;
    }
  }

  return out;
}

// UniverseId from PlaceId (newer endpoint we used earlier is fine)
async function universeFromPlace(placeId) {
  const url = `https://apis.roblox.com/universes/v1/places/${placeId}/universe`;
  const r = await fetch(url, { headers: { "User-Agent": "oldest-game-finder/1.0" } });
  if (!r.ok) return null;
  const j = await r.json();
  return num(j?.universeId);
}

app.get("/api/debug", async (req, res) => {
  try {
    const qRaw = toStr(req.query.q).trim();
    if (!qRaw) return res.json({ ok:false, error:"Missing ?q=" });

    // IMPORTANT: correct param casing per devforum examples
    const searchUrl =
      "https://apis.roblox.com/search-api/omni-search" +
      `?searchQuery=${encodeURIComponent(qRaw)}` +
      `&sessionId=0` +
      `&pageType=all`;

    const s = await fetch(searchUrl, { headers: { "User-Agent": "oldest-game-finder/1.0" } });
    const text = await s.text();

    let sData = null;
    try { sData = JSON.parse(text); } catch {}

    const candidates = sData ? extractCandidates(sData) : [];
    const preview = candidates.slice(0, 20).map(c => ({
      name: c.name,
      placeId: c.placeId,
      universeId: c.universeId
    }));

    return res.json({
      ok: true,
      status: s.status,
      searchUrl,
      topLevelKeys: sData ? Object.keys(sData) : null,
      previewCount: preview.length,
      preview
    });
  } catch (e) {
    return res.json({ ok:false, error:String(e?.message || e) });
  }
});

app.post("/api/oldest", async (req, res) => {
  try {
    const qRaw = toStr(req.body?.q).trim();
    const q = low(qRaw);

    if (!qRaw) return res.json({ ok:false, error:"Empty query" });
    if (qRaw.length > 40) return res.json({ ok:false, error:"Query too long" });

    // Correct param casing
    const searchUrl =
      "https://apis.roblox.com/search-api/omni-search" +
      `?searchQuery=${encodeURIComponent(qRaw)}` +
      `&sessionId=0` +
      `&pageType=all`;

    const s = await fetch(searchUrl, { headers: { "User-Agent": "oldest-game-finder/1.0" } });
    if (!s.ok) return res.json({ ok:false, error:`Roblox search error: ${s.status}` });

    const sData = await s.json();
    const all = extractCandidates(sData);

    // Keep only ones whose TITLE includes keyword
    const matches = all.filter(c => c.name && low(c.name).includes(q));

    if (matches.length === 0) {
      return res.json({
        ok: false,
        error: "No matching titles in results",
        sampleTitles: all.slice(0, 15).map(x => x.name).filter(Boolean)
      });
    }

    // Fill universeIds if missing
    for (const c of matches) {
      if (!c.universeId && c.placeId) {
        c.universeId = await universeFromPlace(c.placeId);
      }
    }

    const universeIds = [...new Set(matches.map(m => m.universeId).filter(Boolean))];
    if (universeIds.length === 0) {
      return res.json({ ok:false, error:"Could not resolve universeIds" });
    }

    // Fetch game info (created, creator, rootPlaceId)
    const infoUrl = `https://games.roblox.com/v1/games?universeIds=${universeIds.join(",")}`;
    const g = await fetch(infoUrl, { headers: { "User-Agent": "oldest-game-finder/1.0" } });
    if (!g.ok) return res.json({ ok:false, error:`Roblox games info error: ${g.status}` });

    const gJson = await g.json();
    const games = gJson?.data || [];
    if (!isArr(games) || games.length === 0) return res.json({ ok:false, error:"No game info returned" });

    let oldest = null;
    for (const game of games) {
      const name = toStr(game?.name);
      if (!name || !low(name).includes(q)) continue;

      const created = toStr(game?.created || game?.createdAt || game?.createDate);
      const t = Date.parse(created);
      if (!Number.isFinite(t)) continue;

      const placeId = num(game?.rootPlaceId);
      if (!placeId) continue;

      const creator = toStr(game?.creator?.name || "Unknown");

      if (!oldest || t < Date.parse(oldest.created)) {
        oldest = { placeId, name, creator, created };
      }
    }

    if (!oldest) return res.json({ ok:false, error:"Not found (no created dates matched)" });
    return res.json({ ok:true, ...oldest });
  } catch (e) {
    return res.json({ ok:false, error:String(e?.message || e) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log("Listening on " + PORT));
