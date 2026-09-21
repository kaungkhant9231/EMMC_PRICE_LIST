const DAILY_URL = "https://emmc-3-618fd-default-rtdb.asia-southeast1.firebasedatabase.app/daily_prices.json";
const REGIONAL_BASE = "https://emmc-pro-default-rtdb.firebaseio.com";
const REFRESH_MS = 15000;
const PLACEHOLDER_TEXT = "ဒေသအသစ်များဆတ်လက်ထဲ့သွင်းသွားမည်";
const PRICE_UNIT = "MMK";
const DAILY_ID = "__daily__";
const DAILY_NAME = "Pyone Lay Apk";
// Public read-only chip database (same project as the regional board).
const CHIPS_URL = `${REGIONAL_BASE}/chips_data.json`;
// Group 3 lives in the daily-price project as a flat push-id list of chip records.
const GROUP3_URL = "https://emmc-3-618fd-default-rtdb.asia-southeast1.firebasedatabase.app/emmc_list.json";
const GROUP3_ID = "group3";
// Group 4 is a static JSON list of { ic, group } hosted on GitHub.
const GROUP4_URL = "https://raw.githubusercontent.com/kaungkhant9231/my-tool-security/refs/heads/main/ic_data.json";
const GROUP4_ID = "group4";
const EXTRA_GROUP_IDS = [GROUP3_ID, GROUP4_ID];
// Some code/brand values carry zero-width characters — strip them before showing or searching.
const ZERO_WIDTH_RE = /[\u200b-\u200d\ufeff]/g;

let priceRows = [];                // daily list rows
let regions = [];                  // [{id, name}]
let selectedId = DAILY_ID;         // DAILY_ID or a region id
let regionItems = [];              // rows for the selected region
let regionMeta = { date: null, notice: null };

// "Has this source ever rendered real data" flags — used for honest empty states.
const loaded = { daily: false, regional: false };

let inFlight = 0;                  // 0 = no request running
let pendingRefresh = false;
let railSignature = "";            // avoid rebuilding chips (and losing hover) every 15s
let selectionToken = 0;            // guards against out-of-order responses when switching chips

// Chip code database
let mode = "price";                // "price" | "chips"
let chipIndex = null;              // { keys, byKey, all, dropped } or null before the first load
let chipLoaded = false;
let activeChipGroup = null;        // e.g. "group1"
let activeChipKeyId = null;        // e.g. "group1/Mi-128"
let chipRailSignature = "";
let chipSegSignature = "";

const el = {
  search: document.getElementById("search"),
  themeBtn: document.getElementById("themeBtn"),
  modeBar: document.getElementById("modeBar"),
  pricePicker: document.getElementById("pricePicker"),
  chipPicker: document.getElementById("chipPicker"),
  chipGroupSeg: document.getElementById("chipGroupSeg"),
  chipRail: document.getElementById("chipRail"),
  thA: document.getElementById("thA"),
  thB: document.getElementById("thB"),
  refreshBtn: document.getElementById("refreshBtn"),
  dot: document.getElementById("dot"),
  statusText: document.getElementById("statusText"),
  errorBox: document.getElementById("errorBox"),
  subLabel: document.getElementById("subLabel"),
  noticeBox: document.getElementById("noticeBox"),
  regionRail: document.getElementById("regionRail"),
  priceBody: document.getElementById("priceBody"),
};

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// Collapse runs of whitespace (incl. newlines/tabs) into single spaces and trim.
function oneLine(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function loadingRow() {
  return '<tr><td colspan="2" class="empty">Loading…</td></tr>';
}

function loadedKey() {
  return selectedId === DAILY_ID ? "daily" : "regional";
}

// ---------- Daily List (emmc-3-618fd) ----------

function parseDailyText(text) {
  const lines = String(text || "").split(/\r\n|\r|\n/);
  const rows = [];
  let sawContent = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "") {
      if (sawContent && rows.length && rows[rows.length - 1].type !== "divider") {
        rows.push({ type: "divider" });
      }
      continue;
    }
    sawContent = true;
    const m = line.match(/^(.*\S)\s+([\d,]+)$/);
    if (m) {
      rows.push({ type: "item", name: m[1].trim(), price: m[2].replace(/,/g, "") });
    } else {
      rows.push({ type: "item", name: line, price: null });
    }
  }
  while (rows.length && rows[rows.length - 1].type === "divider") rows.pop();
  return rows;
}

async function fetchDaily() {
  const res = await fetch(DAILY_URL, { cache: "no-store" });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const data = await res.json();

  // Normal case is a raw text blob; stay tolerant if the node ever becomes structured.
  let text = data;
  if (data && typeof data === "object") {
    text = [data.text, data.list, data.value].find((v) => typeof v === "string") || "";
  }
  priceRows = parseDailyText(text);
}

// ---------- Regional Board (emmc-pro) ----------

// Region names are free text: "ကိုနောင်( မကွေး )", "တောင်ကြီးမြို့နယ် (ရွှေညောင်မြို့)\nကိုအိစ်လန်း",
// "(မန္တလေးမြို့)ပစ်တိုင်းထောင်", "ပဲခူးမြို့=K3". Normalise into {main, city} so every chip
// can show the same two pieces of information instead of a mix of names and towns.
function splitAgentName(name) {
  const clean = oneLine(name);
  const m = clean.match(/[（(]([^（）()]+)[）)]/);
  if (m) {
    const city = oneLine(m[1]);
    const main = oneLine(clean.replace(m[0], "")) || city;
    return { main, city: main === city ? null : city };
  }
  const parts = clean.split("=").map(oneLine);
  if (parts.length === 2 && parts[0] && parts[1]) {
    return { main: parts[1], city: parts[0] };
  }
  return { main: clean, city: null };
}

async function fetchRegionList() {
  const res = await fetch(`${REGIONAL_BASE}/price_group.json`, { cache: "no-store" });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const data = await res.json();

  const list = [];
  const push = (id, entry) => {
    if (!entry) return;
    const raw = entry && typeof entry === "object" ? (entry.name ?? entry.title) : entry;
    const name = oneLine(raw);
    if (!name || name === PLACEHOLDER_TEXT) return;
    list.push({ id: String(id), name });
  };

  if (Array.isArray(data)) {
    data.forEach((entry, id) => push(id, entry));
  } else if (data && typeof data === "object") {
    Object.entries(data).forEach(([id, entry]) => push(id, entry));
  }

  regions = list;
}

async function fetchRegionItems(regionId) {
  const res = await fetch(`${REGIONAL_BASE}/price_data/${regionId}.json`, { cache: "no-store" });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const data = await res.json();

  const items = [];
  let meta = { date: null, notice: null };

  if (data && typeof data === "object" && data.items && typeof data.items === "object") {
    meta = { date: data.date ?? null, notice: data.notice ?? null };
    for (const [name, price] of Object.entries(data.items)) {
      if (name == null) continue;
      items.push({ type: "item", name: String(name), price: price == null ? null : String(price) });
    }
  }

  regionItems = items;
  regionMeta = meta;
}

function renderRail(force = false) {
  const chips = [{ id: DAILY_ID, name: DAILY_NAME }, ...regions];
  const sig = chips.map((c) => `${c.id}|${c.name}`).join("~");
  if (!force && sig === railSignature) return;
  railSignature = sig;

  el.regionRail.innerHTML = chips.map((c) => {
    const { main, city } = splitAgentName(c.name);
    const cls = "region-chip" + (c.id === selectedId ? " active" : "");
    const cityHtml = city ? `<span class="city">${escapeHtml(city)}</span>` : "";
    return `<button type="button" class="${cls}" data-id="${escapeHtml(c.id)}">${escapeHtml(main)}${cityHtml}</button>`;
  }).join("");

  el.regionRail.querySelectorAll(".region-chip").forEach((btn) => {
    btn.addEventListener("click", () => selectChip(btn.dataset.id));
  });
}

async function selectChip(id) {
  if (id === selectedId) return;
  selectedId = id;
  renderRail(true);

  if (id !== DAILY_ID) {
    // Never keep another region's prices on screen under a newly selected chip.
    regionItems = [];
    regionMeta = { date: null, notice: null };
  }

  el.priceBody.innerHTML = loadingRow();
  renderHeaderMeta();

  const token = ++selectionToken;
  inFlight++;
  syncBusyUI();
  try {
    if (id === DAILY_ID) {
      await fetchDaily();
      if (token !== selectionToken) return;
      loaded.daily = true;
    } else {
      await fetchRegionItems(id);
      if (token !== selectionToken) return;
      loaded.regional = true;
    }
    renderActive();
    setLive();
  } catch (err) {
    if (token !== selectionToken) return;
    renderActive();
    setStale();
  } finally {
    inFlight--;
    syncBusyUI();
  }
}

// ---------- Chip code database (emmc-pro/chips_data) ----------
//
// Shape: { group1: { "<gb key>": { chips: <rows> } }, group2: { ... } }
// Careful: Firebase returns an ARRAY when a node's children are exactly ids 0..n-1 and an
// object map otherwise — group2 comes back as arrays, most of group1 as maps (and 256_B as an
// array with gaps). Both shapes are read here.
// Two traps in the data, both handled in parseChips():
//   * some code/brand values contain zero-width characters (breaks display + search);
//   * some rows are notes, not chips — their code and brand are the same string (e.g. 515-A).

function cleanField(value) {
  return oneLine(String(value ?? "").replace(ZERO_WIDTH_RE, ""));
}

function parseChips(data) {
  const keys = [];
  const byKey = new Map();
  const all = [];
  let dropped = 0;

  if (!data || typeof data !== "object") return { keys, byKey, all, dropped };

  for (const group of Object.keys(data)) {
    const node = data[group];
    if (!node || typeof node !== "object" || Array.isArray(node)) continue;

    for (const [key, entry] of Object.entries(node)) {
      if (!entry || typeof entry !== "object") continue;
      const raw = entry.chips;
      if (raw == null) continue;

      const records = Array.isArray(raw) ? raw : Object.keys(raw).map((k) => raw[k]);
      const id = `${group}/${key}`;
      const seen = new Set();
      const rows = [];

      for (const rec of records) {
        if (!rec || typeof rec !== "object") continue;
        const code = cleanField(rec.code);
        const brand = cleanField(rec.brand);
        if (!code && !brand) continue;
        if (code && code === brand) { dropped += 1; continue; }   // note row, not a chip

        // Case-insensitive: the feed holds the same code twice with "SK hynix" / "SK Hynix".
        const dedupe = `${code}\u0000${brand}`.toLowerCase();
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);

        const row = { type: "chip", code, brand, group, key, keyId: id };
        rows.push(row);
        all.push(row);
      }

      keys.push({ id, group, key, count: rows.length });
      byKey.set(id, rows);
    }
  }

  return { keys, byKey, all, dropped };
}

// ---------- Group 3 (emmc-3-618fd/emmc_list) ----------
//
// Flat map of push-id -> { model, brand, capacityGb, groupName, ram, notes }. The typed-in
// fields are inconsistent ("Mi 32" / "Mi32" / "MI 32", "32" / "32 GB", ram "0" / "O" / "."),
// so group labels and capacities are normalised before being turned into chip keys.

function capacityNum(value) {
  const m = cleanField(value).match(/(\d+(?:\.\d+)?)\s*(t)?/i);
  if (!m) return 0;
  return Number(m[1]) * (m[2] ? 1024 : 1);
}

function formatCapacity(n) {
  if (!n) return "";
  return n >= 1024 ? `${n / 1024} TB` : `${n} GB`;
}

function group3Label(rec) {
  const g = cleanField(rec.groupName).replace(/အုပ်စု/g, "").replace(/[.\-_]/g, " ").replace(/\s+/g, " ").trim();
  let m = g.match(/^mi\s*(\d+)$/i);
  if (m) return `Mi ${m[1]}`;
  m = g.match(/^(\d{3})\s*([a-c])$/i);
  if (m) return `${m[1]} ${m[2].toUpperCase()}`;
  m = g.match(/^(tq|tp)\s*(\d+)$/i);
  if (m) return `${m[1].toUpperCase()} ${m[2]}`;
  if (/^(\d{3,4}|6580A|MT6580A ?\+? ?TP|TP|17BA|1 ?TB)$/i.test(g)) return g.toUpperCase();
  // Empty / "0" / "." / "-" group names: fall back to the capacity so the rows stay findable.
  return `Other · ${formatCapacity(capacityNum(rec.capacityGb)) || "?"}`;
}

function group3Detail(rec) {
  const parts = [];
  const cap = formatCapacity(capacityNum(rec.capacityGb));
  if (cap) parts.push(cap);
  const ram = cleanField(rec.ram);
  if (/^[1-9]\d*(\.\d+)?(\s*gb)?$/i.test(ram)) parts.push(`RAM ${parseFloat(ram)} GB`);
  const notes = cleanField(rec.notes);
  if (notes && notes !== "Bulk Import") parts.push(notes);
  return parts.join(" · ");
}

// entries: [{ key, code, brand, detail, cap }] -> the same { keys, byKey, all } shape parseChips returns.
function buildFlatGroup(groupId, entries) {
  const keys = [];
  const byKey = new Map();
  const all = [];

  const buckets = new Map();
  for (const e of entries) {
    if (!e.code) continue;
    if (!buckets.has(e.key)) buckets.set(e.key, { cap: 0, seen: new Set(), rows: [] });
    const b = buckets.get(e.key);

    const dedupe = `${e.code}\u0000${e.brand}`.toLowerCase();
    if (b.seen.has(dedupe)) continue;
    b.seen.add(dedupe);

    b.cap = Math.max(b.cap, e.cap || 0);
    const row = { type: "chip", code: e.code, brand: e.brand, detail: e.detail, group: groupId, key: e.key, keyId: `${groupId}/${e.key}` };
    b.rows.push(row);
    all.push(row);
  }

  // Smallest capacity first, "Other" buckets last, then natural name order.
  const order = [...buckets.entries()].sort(([ka, a], [kb, b]) => {
    const oa = ka.startsWith("Other") ? 1 : 0;
    const ob = kb.startsWith("Other") ? 1 : 0;
    return oa - ob || a.cap - b.cap || ka.localeCompare(kb, "en", { numeric: true });
  });
  for (const [key, b] of order) {
    const id = `${groupId}/${key}`;
    keys.push({ id, group: groupId, key, count: b.rows.length });
    byKey.set(id, b.rows);
  }
  return { keys, byKey, all };
}

function parseGroup3(data) {
  if (!data || typeof data !== "object") return buildFlatGroup(GROUP3_ID, []);
  const entries = Object.values(data)
    .filter((rec) => rec && typeof rec === "object")
    .map((rec) => ({
      key: group3Label(rec),
      code: cleanField(rec.model),
      brand: cleanField(rec.brand),
      detail: group3Detail(rec),
      cap: capacityNum(rec.capacityGb),
    }));
  return buildFlatGroup(GROUP3_ID, entries);
}

// ---------- Group 4 (GitHub ic_data.json) ----------
//
// Flat array of { ic, group }. Group names are free text: "Mi (128) group", "Mi-64GB (group)",
// "515 64GB (A group)", "B705 (B group)", "TQ-17 group", "6580A (A group)" vs "6580 (A group)".

function group4Label(name) {
  const g = cleanField(name);
  let m = g.match(/^mi[\s\-]*\(?\s*(\d+)/i);
  if (m) return `Mi ${m[1]}`;
  m = g.match(/^tq[\s\-]*(\d+)/i);
  if (m) return `TQ ${m[1]}`;
  if (/^tp\b/i.test(g)) return "TP";
  if (/^17ba/i.test(g)) return "17BA";
  m = g.match(/^b?(6580)a?\s*\(?\s*([abc])\s*group/i);
  if (m) return `${m[1]} ${m[2].toUpperCase()}`;
  m = g.match(/^b?(\d{3})\b.*?\(?\s*([abc])\s*group/i);
  if (m) return `${m[1]} ${m[2].toUpperCase()}`;
  m = g.match(/^(\d{3})\b/);
  if (m) return m[1];
  m = g.match(/^(\d+)\s*gb/i);
  if (m) return `Other · ${m[1]} GB`;
  return "Other · ?";
}

function parseGroup4(data) {
  const list = Array.isArray(data) ? data : [];
  const entries = list
    .filter((rec) => rec && typeof rec === "object")
    .map((rec) => {
      const key = group4Label(rec.group);
      const gb = key.match(/(\d+) GB$/);
      const mi = key.match(/^Mi (\d+)$/);
      return { key, code: cleanField(rec.ic), brand: "", detail: "", cap: gb ? Number(gb[1]) : mi ? Number(mi[1]) : 0 };
    });
  return buildFlatGroup(GROUP4_ID, entries);
}

function fetchJson(url) {
  return fetch(url, { cache: "no-store" }).then((r) => {
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  });
}

async function fetchChips() {
  // The databases are independent: one being down must not hide the others.
  const sources = [
    { ids: null, url: CHIPS_URL, parse: parseChips },
    { ids: [GROUP3_ID], url: GROUP3_URL, parse: parseGroup3 },
    { ids: [GROUP4_ID], url: GROUP4_URL, parse: parseGroup4 },
  ];
  const results = await Promise.allSettled(sources.map((s) => fetchJson(s.url)));
  if (results.every((r) => r.status === "rejected")) throw results[0].reason;

  // A failed source keeps whatever was last loaded for its groups.
  const owns = (src, group) => (src.ids ? src.ids.includes(group) : !EXTRA_GROUP_IDS.includes(group));
  const allKeys = [];
  const byKey = new Map();
  const all = [];
  let dropped = chipIndex ? chipIndex.dropped : 0;

  sources.forEach((src, i) => {
    if (results[i].status === "fulfilled") {
      const part = src.parse(results[i].value);
      allKeys.push(...part.keys);
      part.byKey.forEach((rows, id) => byKey.set(id, rows));
      all.push(...part.all);
      if (part.dropped != null) dropped = part.dropped;
    } else if (chipIndex) {
      for (const k of chipIndex.keys) {
        if (!owns(src, k.group)) continue;
        allKeys.push(k);
        byKey.set(k.id, chipIndex.byKey.get(k.id));
      }
      all.push(...chipIndex.all.filter((r) => owns(src, r.group)));
    }
  });

  chipIndex = { keys: allKeys, byKey, all, dropped };
  chipLoaded = true;

  const groups = chipGroups();
  if (!activeChipGroup || !groups.includes(activeChipGroup)) activeChipGroup = groups[0] || null;
  const keys = chipKeysOf(activeChipGroup);
  if (!activeChipKeyId || !keys.some((k) => k.id === activeChipKeyId)) {
    activeChipKeyId = keys.length ? keys[0].id : null;
  }
}

function serverName(group) {
  return String(group).replace(/^group(\d+)$/i, "Server $1");
}

function chipGroups() {
  const out = [];
  if (!chipIndex) return out;
  for (const k of chipIndex.keys) if (!out.includes(k.group)) out.push(k.group);
  return out;
}

function chipKeysOf(group) {
  if (!chipIndex || !group) return [];
  return chipIndex.keys.filter((k) => k.group === group);
}

// Two small selectors: the group (group1/group2) and, inside it, one GB key at a time.
function renderChipGroupSeg(force = false) {
  const groups = chipGroups();
  const sig = groups.map((g) => `${g}:${chipKeysOf(g).reduce((n, k) => n + k.count, 0)}`).join("~");
  if (!force && sig === chipSegSignature) return;
  chipSegSignature = sig;

  el.chipGroupSeg.innerHTML = groups.map((g) => {
    const n = chipKeysOf(g).reduce((a, k) => a + k.count, 0);
    const cls = "seg-btn" + (g === activeChipGroup ? " active" : "");
    return `<button type="button" class="${cls}" data-group="${escapeHtml(g)}">${escapeHtml(serverName(g))}<span class="seg-count">${n}</span></button>`;
  }).join("");

  el.chipGroupSeg.querySelectorAll(".seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => selectChipGroup(btn.dataset.group));
  });
}

function renderChipRail(force = false) {
  const keys = chipKeysOf(activeChipGroup);
  const sig = `${activeChipGroup}~` + keys.map((k) => `${k.id}|${k.count}`).join("~");
  if (!force && sig === chipRailSignature) return;
  chipRailSignature = sig;

  el.chipRail.innerHTML = keys.map((k) => {
    const cls = "region-chip compact" + (k.id === activeChipKeyId ? " active" : "");
    return `<button type="button" class="${cls}" data-key="${escapeHtml(k.id)}">${escapeHtml(k.key)}<span class="city">${k.count}</span></button>`;
  }).join("");

  el.chipRail.querySelectorAll(".region-chip").forEach((btn) => {
    btn.addEventListener("click", () => selectChipKey(btn.dataset.key));
  });
}

function selectChipGroup(group) {
  if (group === activeChipGroup) return;
  activeChipGroup = group;
  const keys = chipKeysOf(group);
  activeChipKeyId = keys.length ? keys[0].id : null;
  renderChipGroupSeg(true);   // forced: the signature can be unchanged while the active group is not
  renderChipRail(true);
  renderActive();
}

function selectChipKey(id) {
  if (id === activeChipKeyId) return;
  activeChipKeyId = id;
  renderChipRail(true);
  renderActive();
}

// Browsing = one section for the selected key. Searching = sections for every key that matches,
// across both groups, so a code can be looked up without knowing which group it lives in.
function chipSections() {
  if (!chipIndex) return [];
  const q = cleanField(el.search.value).toLowerCase();
  const out = [];

  for (const k of chipIndex.keys) {
    if (!q && k.id !== activeChipKeyId) continue;
    const rows = chipIndex.byKey.get(k.id) || [];
    const matched = q
      ? rows.filter((r) => `${r.code} ${r.brand} ${r.detail || ""}`.toLowerCase().includes(q))
      : rows;
    if (!matched.length) continue;
    out.push({ label: `${serverName(k.group)} · ${k.key}`, count: matched.length, rows: matched });
  }

  return out;
}

function renderChips() {
  const searching = cleanField(el.search.value).length > 0;
  const sections = chipSections();
  const total = sections.reduce((n, s) => n + s.rows.length, 0);

  if (!total) {
    el.priceBody.innerHTML = `<tr><td colspan="2" class="empty">${escapeHtml(emptyMessage(searching))}</td></tr>`;
    return;
  }

  el.priceBody.innerHTML = sections.map((s) => {
    const head = `<tr class="row-head"><td colspan="2">${escapeHtml(s.label)}<span class="sec-count">${s.count} code${s.count === 1 ? "" : "s"}</span></td></tr>`;
    const body = s.rows.map((r) => {
      const info = [r.brand, r.detail].filter(Boolean).join(" · ");
      const brand = info ? escapeHtml(info) : "—";
      return `<tr><td class="code"><button type="button" class="code-btn" data-code="${escapeHtml(r.code)}">${escapeHtml(r.code)}</button></td><td class="brand">${brand}</td></tr>`;
    }).join("");
    return head + body;
  }).join("");
}

// Tap a code to copy it (clipboard API needs https/localhost; file:// falls back to execCommand).
function fallbackCopy(text) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.top = "-1000px";
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand("copy"); } catch (e) { /* ignore */ }
  document.body.removeChild(ta);
}

function copyCode(btn) {
  const code = btn.dataset.code || "";
  const done = () => {
    btn.classList.add("copied");
    setTimeout(() => btn.classList.remove("copied"), 1000);
  };
  const fallback = () => { try { fallbackCopy(code); done(); } catch (e) { /* ignore */ } };

  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(code).then(done).catch(fallback);
  } else {
    fallback();
  }
}

// ---------- shared render / refresh ----------

function currentRows() {
  return selectedId === DAILY_ID ? priceRows : regionItems;
}

function countItems(rows) {
  return rows.filter((r) => r.type === "item").length;
}

// Prices arrive either as plain numbers ("116000") or with a trailing note ("49000 3ic").
// Always render one consistent unit and keep the note as a separate, muted suffix.
function formatPrice(raw) {
  if (raw === null || raw === undefined) return { text: "—", note: null };
  const s = oneLine(raw);
  if (!s) return { text: "—", note: null };

  const m = s.match(/^(-?\d[\d,]*(?:\.\d+)?)\s*(.*)$/);
  if (!m) return { text: s, note: null };

  const num = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(num)) return { text: s, note: null };

  return { text: num.toLocaleString("en-US") + " " + PRICE_UNIT, note: m[2] || null };
}

function normalizeNotice(raw) {
  return String(raw ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function renderTableHead() {
  const chips = mode === "chips";
  el.thA.textContent = chips ? "Code" : "Item";
  el.thB.textContent = chips ? "Brand / note" : "Price";
  el.thB.classList.toggle("right", !chips);
}

function renderHeaderMeta() {
  if (mode === "chips") {
    el.subLabel.textContent = activeChipGroup ? `IC List · ${serverName(activeChipGroup)}` : "IC List";
    el.noticeBox.textContent = "";
    el.noticeBox.hidden = true;
    return;
  }

  if (selectedId === DAILY_ID) {
    el.subLabel.textContent = "Live price board";
    el.noticeBox.textContent = "";
    el.noticeBox.hidden = true;
    return;
  }

  const agent = regions.find((r) => r.id === selectedId) || null;
  const { main, city } = splitAgentName(agent ? agent.name : "");
  const date = oneLine(regionMeta.date);
  const title = [main, city].filter(Boolean).join(" · ");

  el.subLabel.textContent = [title, date].filter(Boolean).join("  —  ") || "Live price board";

  const notice = normalizeNotice(regionMeta.notice);
  el.noticeBox.textContent = notice;
  el.noticeBox.hidden = !notice;
}

function emptyMessage(searching) {
  if (mode === "chips") {
    if (!chipLoaded) return "Couldn't load the IC List — tap 🔄 Refresh to try again.";
    return searching ? "No IC code matches that search." : "No ICs on this server yet.";
  }

  if (!loaded[loadedKey()]) {
    return "Couldn't load the price feed — tap 🔄 Refresh to try again.";
  }
  return searching ? "No matching items" : "This price list is empty right now.";
}

function renderActive() {
  if (mode === "chips") {
    renderHeaderMeta();
    renderChips();
    return;
  }

  const q = oneLine(el.search.value).toLowerCase();
  const searching = q.length > 0;
  const rows = currentRows();
  const filtered = searching
    ? rows.filter((r) => r.type === "item" && r.name.toLowerCase().includes(q))
    : rows;

  renderHeaderMeta();

  if (!filtered.length) {
    el.priceBody.innerHTML = `<tr><td colspan="2" class="empty">${escapeHtml(emptyMessage(searching))}</td></tr>`;
    return;
  }

  el.priceBody.innerHTML = filtered.map((r) => {
    if (r.type === "divider") return '<tr class="divider"><td colspan="2"></td></tr>';
    const { text, note } = formatPrice(r.price);
    const noteHtml = note ? `<span class="price-note">${escapeHtml(note)}</span>` : "";
    return `<tr><td>${escapeHtml(r.name)}</td><td class="amt">${escapeHtml(text)}${noteHtml}</td></tr>`;
  }).join("");
}

function setLive() {
  el.dot.classList.remove("stale");
  el.errorBox.style.display = "none";

  if (mode === "chips") {
    // The chip database is not polled, so the dot stays steady instead of pulsing.
    el.dot.classList.add("static");
    const codes = chipIndex ? chipIndex.all.length : 0;
    const groups = chipIndex ? chipIndex.keys.filter((k) => k.count > 0).length : 0;
    el.statusText.textContent =
      `IC List — ${codes.toLocaleString("en-US")} codes in ${groups} groups · read ${new Date().toLocaleTimeString()}`;
    return;
  }

  el.dot.classList.remove("static");
  const n = countItems(currentRows());
  el.statusText.textContent = `Live — updated ${new Date().toLocaleTimeString()} · ${n} item${n === 1 ? "" : "s"}`;
}

function setStale(message) {
  el.dot.classList.add("stale");
  el.errorBox.style.display = "block";
  el.errorBox.textContent = message ||
    (mode === "chips"
      ? "Couldn't reach the IC List — showing the last data received."
      : "Couldn't reach the price feed — showing the last data received.");
  el.statusText.textContent = "Disconnected — retrying…";
}

function syncBusyUI() {
  el.refreshBtn.disabled = inFlight > 0;
}

async function refresh() {
  if (inFlight > 0) {          // something else is already talking to the feed
    pendingRefresh = true;
    return;
  }

  const id = selectedId;
  const m = mode;
  inFlight++;
  syncBusyUI();
  try {
    if (m === "chips") {
      await fetchChips();
      if (m !== mode) return;
      renderChipGroupSeg(true);
      renderChipRail(true);
    } else {
      await fetchRegionList();
      renderRail();
      if (id === DAILY_ID) {
        await fetchDaily();
        loaded.daily = true;
      } else if (regions.some((r) => r.id === id)) {
        await fetchRegionItems(id);
        loaded.regional = true;
      }
      if (id !== selectedId) return;   // user switched chips mid-fetch
    }
    renderActive();
    setLive();
  } catch (err) {
    if (m === mode) {
      renderActive();
      setStale();
    }
  } finally {
    inFlight--;
    syncBusyUI();
    if (pendingRefresh) {
      pendingRefresh = false;
      refresh();
    }
  }
}

// ---------- theme toggle ----------

function currentTheme() {
  const attr = document.documentElement.getAttribute("data-theme");
  if (attr === "light" || attr === "dark") return attr;
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyThemeIcon() {
  el.themeBtn.textContent = currentTheme() === "dark" ? "☀️" : "🌙";
}

el.themeBtn.addEventListener("click", () => {
  const next = currentTheme() === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  try { localStorage.setItem("theme", next); } catch (e) {}
  applyThemeIcon();
});

applyThemeIcon();

// ---------- price board <-> chip database ----------

async function setMode(next) {
  if (next !== "price" && next !== "chips") return;
  if (next === mode) return;
  mode = next;

  el.modeBar.querySelectorAll(".mode-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === mode);
  });
  el.pricePicker.hidden = mode !== "price";
  el.chipPicker.hidden = mode !== "chips";

  // Different dataset — a leftover query would just show an empty board.
  el.search.value = "";
  el.search.placeholder = mode === "chips" ? "Search code or brand…" : "Search item…";

  el.priceBody.innerHTML = loadingRow();
  renderTableHead();
  renderHeaderMeta();

  await refresh();
}

el.modeBar.addEventListener("click", (ev) => {
  const btn = ev.target.closest(".mode-btn");
  if (btn) setMode(btn.dataset.mode);
});

el.priceBody.addEventListener("click", (ev) => {
  const btn = ev.target.closest(".code-btn");
  if (btn) copyCode(btn);
});

el.search.addEventListener("input", renderActive);
el.refreshBtn.addEventListener("click", () => {
  pendingRefresh = false;
  refresh();
});

renderTableHead();
renderHeaderMeta();
refresh();
// Price data is polled; the IC List is only re-read on demand or when the mode is opened.
setInterval(() => {
  if (mode === "price") refresh();
}, REFRESH_MS);
