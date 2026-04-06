// content.js — Sentinel v3
// Injects floating bubble + sidebar panel into every page

const API_URL = "https://sentinel-xxxx.onrender.com/api/analyze-text";
const MAX_CHARS = 5000;
const DEBOUNCE_MS = 1500;

// ── State ─────────────────────────────────────────────────────────────────────
let activeMode   = null;   // "toxicity" | "misinfo" | "aidetect"
let sidebarOpen  = false;
let lastFlags    = [];
let debounceTimer = null;

// ── Inject sidebar HTML ───────────────────────────────────────────────────────
function injectUI() {
  if (document.getElementById("sentinel-root")) return;

  const root = document.createElement("div");
  root.id = "sentinel-root";
  root.innerHTML = `
    <!-- Floating bubble -->
    <div id="sentinel-bubble" title="Sentinel">
      <svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">
        <!-- 4-point star -->
        <polygon points="20,4 23,17 36,20 23,23 20,36 17,23 4,20 17,17"
                 fill="#E8253A"/>
        <!-- green ring -->
        <circle cx="20" cy="20" r="15" fill="none" stroke="#5DD879" stroke-width="2.5"/>
      </svg>
    </div>

    <!-- Sidebar panel -->
    <div id="sentinel-panel" class="sentinel-closed">
      <!-- Header -->
      <div id="sentinel-header">
        <div id="sentinel-logo">
          <svg viewBox="0 0 24 24" width="18" height="18">
            <polygon points="12,2 14,10 22,12 14,14 12,22 10,14 2,12 10,10"
                     fill="#E8253A"/>
            <circle cx="12" cy="12" r="9" fill="none" stroke="#5DD879" stroke-width="1.5"/>
          </svg>
          <span>Sentinel</span>
        </div>
        <button id="sentinel-close">✕</button>
      </div>

      <!-- Mode tabs -->
      <div id="sentinel-tabs">
        <button class="sentinel-tab" data-mode="toxicity">
          <span class="tab-icon">🛑</span>
          <span class="tab-label">Toxicity</span>
        </button>
        <button class="sentinel-tab" data-mode="misinfo">
          <span class="tab-icon">⚠️</span>
          <span class="tab-label">Misinfo</span>
        </button>
        <button class="sentinel-tab" data-mode="aidetect">
          <span class="tab-icon">🤖</span>
          <span class="tab-label">AI Text</span>
        </button>
      </div>

      <!-- Score display -->
      <div id="sentinel-scores">
        <div class="sentinel-score-row" id="score-row-toxicity">
          <span class="score-label">Toxicity</span>
          <div class="score-bar-wrap"><div class="score-bar" id="bar-toxicity"></div></div>
          <span class="score-val" id="val-toxicity">—</span>
        </div>
        <div class="sentinel-score-row" id="score-row-misinfo">
          <span class="score-label">Misinfo</span>
          <div class="score-bar-wrap"><div class="score-bar" id="bar-misinfo"></div></div>
          <span class="score-val" id="val-misinfo">—</span>
        </div>
        <div class="sentinel-score-row" id="score-row-aidetect">
          <span class="score-label">AI text</span>
          <div class="score-bar-wrap"><div class="score-bar" id="bar-aidetect"></div></div>
          <span class="score-val" id="val-aidetect">—</span>
        </div>
      </div>

      <!-- Status -->
      <div id="sentinel-status">Select a mode above to begin scanning</div>

      <!-- Flags log -->
      <div id="sentinel-log-header">Flagged content</div>
      <div id="sentinel-log">
        <div class="sentinel-empty">No flags yet — run a scan</div>
      </div>

      <!-- Footer -->
      <div id="sentinel-footer">
        <button id="sentinel-scan-btn">Scan page now</button>
        <button id="sentinel-clear-btn">Clear highlights</button>
      </div>
    </div>
  `;

  document.body.appendChild(root);

  // Events
  document.getElementById("sentinel-bubble").addEventListener("click", toggleSidebar);
  document.getElementById("sentinel-close").addEventListener("click", closeSidebar);
  document.getElementById("sentinel-scan-btn").addEventListener("click", runScan);
  document.getElementById("sentinel-clear-btn").addEventListener("click", clearHighlights);

  document.querySelectorAll(".sentinel-tab").forEach(btn => {
    btn.addEventListener("click", () => setMode(btn.dataset.mode));
  });
}

// ── Sidebar open/close ────────────────────────────────────────────────────────
function toggleSidebar() {
  sidebarOpen ? closeSidebar() : openSidebar();
}

function openSidebar() {
  sidebarOpen = true;
  document.getElementById("sentinel-panel").classList.remove("sentinel-closed");
  document.getElementById("sentinel-bubble").classList.add("sentinel-bubble-active");
}

function closeSidebar() {
  sidebarOpen = false;
  document.getElementById("sentinel-panel").classList.add("sentinel-closed");
  document.getElementById("sentinel-bubble").classList.remove("sentinel-bubble-active");
}

// ── Mode switching ────────────────────────────────────────────────────────────
function setMode(mode) {
  activeMode = mode;

  // Update tab styles
  document.querySelectorAll(".sentinel-tab").forEach(btn => {
    btn.classList.toggle("sentinel-tab-active", btn.dataset.mode === mode);
  });

  // Show only relevant score row
  ["toxicity","misinfo","aidetect"].forEach(m => {
    const row = document.getElementById(`score-row-${m}`);
    if (row) row.style.display = (m === mode) ? "flex" : "none";
  });

  setStatus(`${modeLabel(mode)} mode active — click Scan or wait for auto-scan`);
  refilterLog();
  clearHighlights();
  runScan();
}

function modeLabel(mode) {
  return { toxicity: "Toxicity", misinfo: "Misinfo", aidetect: "AI detection" }[mode] || mode;
}

// ── Text extraction ───────────────────────────────────────────────────────────
function getTextNodes() {
  const walker = document.createTreeWalker(
    document.body, NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        const p = node.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (["SCRIPT","STYLE","NOSCRIPT","TEXTAREA"].includes(p.tagName))
          return NodeFilter.FILTER_REJECT;
        if (p.closest("#sentinel-root")) return NodeFilter.FILTER_REJECT;
        if (p.closest(".sentinel-highlight")) return NodeFilter.FILTER_REJECT;
        if (!node.textContent.trim()) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );
  const nodes = [];
  let chars = 0;
  let node;
  while ((node = walker.nextNode()) && chars < MAX_CHARS) {
    nodes.push(node);
    chars += node.textContent.length;
  }
  return nodes;
}

// ── API call ──────────────────────────────────────────────────────────────────
async function runScan() {
  if (!activeMode) {
    setStatus("Pick a mode first");
    return;
  }
  setStatus("Scanning…");

  const textNodes = getTextNodes();
  const text = textNodes.map(n => n.textContent).join(" ").slice(0, MAX_CHARS);
  if (text.trim().length < 20) { setStatus("Not enough text on page"); return; }

  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    lastFlags = data.flags || [];
    updateScores(data);
    clearHighlights();
    applyHighlights(lastFlags);
    renderLog(lastFlags);

    const count = lastFlags.filter(f => f.type === activeMode || activeMode === "aidetect").length;
    setStatus(count > 0 ? `${count} flag(s) found` : "No flags detected on this page");
  } catch (e) {
    setStatus("Backend unreachable — is Render running?");
  }
}

// ── Score bars ────────────────────────────────────────────────────────────────
function updateScores(data) {
  const set = (id, val) => {
    const pct = Math.round((val || 0) * 100);
    const bar = document.getElementById(`bar-${id}`);
    const lbl = document.getElementById(`val-${id}`);
    if (bar) { bar.style.width = pct + "%"; bar.style.background = scoreColor(pct); }
    if (lbl) lbl.textContent = pct + "%";
  };
  set("toxicity", data.toxicity);
  set("misinfo",  data.misinfo);
  set("aidetect", data.manipulation); // reuse manipulation as proxy
}

function scoreColor(pct) {
  if (pct > 65) return "#E8253A";
  if (pct > 35) return "#F5A623";
  return "#5DD879";
}

// ── Highlight DOM ─────────────────────────────────────────────────────────────
const TYPE_COLOR = {
  toxicity:     "sentinel-red",
  manipulation: "sentinel-yellow",
  misinfo:      "sentinel-blue",
};

function applyHighlights(flags) {
  const relevant = flags.filter(f => {
    if (activeMode === "toxicity")  return f.type === "toxicity";
    if (activeMode === "misinfo")   return f.type === "misinfo" || f.type === "manipulation";
    if (activeMode === "aidetect")  return true;
    return true;
  });

  const textNodes = getTextNodes();
  for (const flag of relevant) {
    const cls    = TYPE_COLOR[flag.type] || "sentinel-yellow";
    const reason = flag.type.charAt(0).toUpperCase() + flag.type.slice(1) + " detected";
    for (const node of textNodes) {
      highlightInNode(node, flag.phrase, cls, reason);
    }
  }
}

function highlightInNode(textNode, phrase, cssClass, reason) {
  const text = textNode.textContent;
  const idx  = text.toLowerCase().indexOf(phrase.toLowerCase());
  if (idx === -1) return;

  const before = document.createTextNode(text.slice(0, idx));
  const span   = document.createElement("span");
  span.className = `sentinel-highlight ${cssClass}`;
  span.textContent = text.slice(idx, idx + phrase.length);

  const tip = document.createElement("span");
  tip.className = "sentinel-tooltip";
  tip.textContent = reason;
  span.appendChild(tip);

  const after  = document.createTextNode(text.slice(idx + phrase.length));
  const parent = textNode.parentNode;
  parent.insertBefore(before, textNode);
  parent.insertBefore(span, textNode);
  parent.insertBefore(after, textNode);
  parent.removeChild(textNode);
}

function clearHighlights() {
  document.querySelectorAll(".sentinel-highlight").forEach(el => {
    const parent = el.parentNode;
    while (el.firstChild && el.firstChild.className !== "sentinel-tooltip") {
      parent.insertBefore(el.firstChild, el);
    }
    parent.removeChild(el);
    parent.normalize();
  });
}

// ── Flags log ─────────────────────────────────────────────────────────────────
function renderLog(flags) {
  const log = document.getElementById("sentinel-log");
  const relevant = flags.filter(f => {
    if (activeMode === "toxicity") return f.type === "toxicity";
    if (activeMode === "misinfo")  return f.type === "misinfo" || f.type === "manipulation";
    return true;
  });

  if (relevant.length === 0) {
    log.innerHTML = `<div class="sentinel-empty">No flags for this mode</div>`;
    return;
  }

  log.innerHTML = relevant.map(f => `
    <div class="sentinel-flag-item sentinel-flag-${f.type}">
      <div class="flag-type">${f.type.toUpperCase()}</div>
      <div class="flag-phrase">"${f.phrase.slice(0, 80)}${f.phrase.length > 80 ? '…' : ''}"</div>
      <div class="flag-reason">${flagReason(f)}</div>
    </div>
  `).join("");
}

function refilterLog() {
  renderLog(lastFlags);
}

function flagReason(flag) {
  const reasons = {
    toxicity:     "Harmful or aggressive language targeting a person",
    manipulation: "Emotionally charged language designed to manipulate",
    misinfo:      "Language associated with misinformation patterns",
  };
  return reasons[flag.type] || "Flagged by Sentinel";
}

// ── Status ────────────────────────────────────────────────────────────────────
function setStatus(msg) {
  const el = document.getElementById("sentinel-status");
  if (el) el.textContent = msg;
}

// ── Auto-scan on DOM changes ──────────────────────────────────────────────────
const observer = new MutationObserver(() => {
  if (!activeMode) return;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(runScan, DEBOUNCE_MS);
});

// ── Init ──────────────────────────────────────────────────────────────────────
injectUI();
observer.observe(document.body, { childList: true, subtree: true });
