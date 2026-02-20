const express = require("express");
const app = express();

app.use(express.json({ limit: "200kb" }));

app.get("/", (req, res) => res.send("OK"));

function pickArray(obj) {
  // Try common shapes
  return obj?.searchResults || obj?.results || obj?.data || obj?.items || [];
}

function getName(x) {
  return (x?.name || x?.title || x?.displayName || x?.contentName || "").toString();
}

function getPlaceId(x) {
  const v = x?.placeId ?? x?.rootPlaceId ?? x?.id ?? x?.contentId ?? x?.place?.id;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function getUniverseId(x) {
  const v = x?.universeId ?? x?.universe?.id ?? x?.universe?.universeId;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

app.post("/api/oldest", async (req, res) => {
  try {
    const qRaw = (req.body?.q ?? "").toString().trim();
    const q = qRaw.toLowerCase();
    if (!q) return res.json({ ok: false, error: "Empty query" });
    if (q.length > 40) return res.json({ ok: false, error: "Query too long" });

    // 1) Omni search (games)
    // Roblox devforum: use omni-search for search results content
    const searchUrl =
      "https://apis.roblox.com/search-api/omni-search" +
      `?SearchQuery=${encodeURIComponent(qRaw)}` +
      `&SessionId=0` +
      `&pageType=games`;

    const s = await fetch(searchUrl, { headers: { "User-Agent": "oldest-game-finder/1.0" } });
    if (!s.ok) return res.json({ ok: false, error: `Roblox search error: ${s.status}` });
    const sData = await s.json();

    const arr = pickArray(sData);
    if (!Array.isArray(arr) || arr.length === 0) {
      return res.json({ ok: false, error: "No search results" });
    }

    // Extract candidates
    const candidates = [];
    for (const r of arr) {
      const name = getName(r);
      if (!name) continue;
      if (!name.toLowerCase().includes(q)) continue; // must be in title

      const placeId = getPlaceId(r);
      const universeId = getUniverseId(r);

      // Need at least one to continue
      if (!placeId && !universeId) continue;

      candidates.push({ name, placeId, universeId });
      if (candidates.length >= 40) break; // keep it light
    }

    if (candidates.length === 0) {
      return res.json({ ok: false, error: "No matching titles in results" });
    }

    // 2) Fill universeIds (if missing) using placeId -> universe endpoint
    for (const c of candidates) {
      if (!c.universeId && c.placeId) {
        const uUrl = `https://apis.roblox.com/universes/v1/places/${c.placeId}/universe`;
        const uRes = await fetch(uUrl, { headers: { "User-Agent": "oldest-game-finder/1.0" } });
        if (uRes.ok) {
          const uJson = await uRes.json();
          const uId = Number(uJson?.universeId);
          if (Number.isFinite(uId)) c.universeId = uId;
        }
      }
    }

    const universeIds = [...new Set(candidates.map(c => c.universeId).filter(Boolean))];
    if (universeIds.length === 0) {
      return res.json({ ok: false, error: "Could not resolve universeIds" });
    }

    // 3) Get game details (includes created + rootPlaceId)
    const infoUrl = `https://games.roblox.com/v1/games?universeIds=${universeIds.join(",")}`;
    const gRes = await fetch(infoUrl, { headers: { "User-Agent": "oldest-game-finder/1.0" } });
    if (!gRes.ok) return res.json({ ok: false, error: `Roblox games info error: ${gRes.status}` });
    const gJson = await gRes.json();

    const games = gJson?.data || [];
    if (!Array.isArray(games) || games.length === 0) {
      return res.json({ ok: false, error: "No game info returned" });
    }

    // 4) Pick oldest by created date, still enforcing keyword in title
    let oldest = null;
    for (const g of games) {
      const name = (g?.name || "").toString();
      if (!name || !name.toLowerCase().includes(q)) continue;

      const created = g?.created || g?.createdAt || g?.createDate || null;
      if (!created) continue;

      const t = Date.parse(created);
      if (!Number.isFinite(t)) continue;

      const placeId = Number(g?.rootPlaceId) || null;
      const creator = (g?.creator?.name || "Unknown").toString();

      if (!placeId) continue;

      if (!oldest || t < Date.parse(oldest.created)) {
        oldest = { placeId, name, creator, created };
      }
    }

    if (!oldest) {
      return res.json({ ok: false, error: "Not found (no created dates matched)" });
    }

    return res.json({ ok: true, ...oldest });
  } catch (e) {
    return res.json({ ok: false, error: String(e?.message || e) });
  }
});

// Bind to all interfaces for tunneling
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log("Listening on http://127.0.0.1:" + PORT));
