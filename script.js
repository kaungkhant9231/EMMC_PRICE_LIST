const DAILY_URL = "https://emmc-3-618fd-default-rtdb.asia-southeast1.firebasedatabase.app/daily_prices.json";
const REGIONAL_BASE = "https://emmc-pro-default-rtdb.firebaseio.com";
const REFRESH_MS = 15000;
const PLACEHOLDER_TEXT = "ဒေသအသစ်များဆတ်လက်ထဲ့သွင်းသွားမည်";
const PRICE_UNIT = "MMK";
const DAILY_ID = "__daily__";
const DAILY_NAME = "From Pyone Lay";

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

const el = {
  search: document.getElementById("search"),
  themeBtn: document.getElementById("themeBtn"),
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

function renderHeaderMeta() {
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
  if (!loaded[loadedKey()]) {
    return "Couldn't load the price feed — tap 🔄 Refresh to try again.";
  }
  return searching ? "No matching items" : "This price list is empty right now.";
}

function renderActive() {
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
  const n = countItems(currentRows());
  el.dot.classList.remove("stale");
  el.errorBox.style.display = "none";
  el.statusText.textContent = `Live — updated ${new Date().toLocaleTimeString()} · ${n} item${n === 1 ? "" : "s"}`;
}

function setStale() {
  el.dot.classList.add("stale");
  el.errorBox.style.display = "block";
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
  inFlight++;
  syncBusyUI();
  try {
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
    renderActive();
    setLive();
  } catch (err) {
    if (id === selectedId) {
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

el.search.addEventListener("input", renderActive);
el.refreshBtn.addEventListener("click", () => {
  pendingRefresh = false;
  refresh();
});

renderHeaderMeta();
refresh();
setInterval(refresh, REFRESH_MS);
