// content.js — Sentinel v5
// Home screen → 3 mode pages, each with full feature layout

const API_URL = "https://projectoverlay.onrender.com/api/analyze-text";
const MAX_CHARS = 5000;
const DEBOUNCE_MS = 2000;

// ── State ─────────────────────────────────────────────────────────────────────
let activeMode      = null;   // "toxicity" | "misinfo" | "scam"
let sidebarOpen     = false;
let lastFlags       = [];
let debounceTimer   = null;
let isScanning      = false;
let observerPaused  = false;

// Feature toggles
let imageDetectOn   = false;
let textAiOn        = false;

// ── Platform selectors ────────────────────────────────────────────────────────
const PLATFORM_SELECTORS = {
  "twitter.com":   '[data-testid="tweetText"]',
  "x.com":         '[data-testid="tweetText"]',
  "reddit.com":    '[data-testid="comment"], [slot="text-body"]',
  "discord.com":   '[class*="messageContent"]',
  "facebook.com":  '[data-ad-comet-preview="message"], [data-testid="post_message"]',
  "instagram.com": 'h1, [class*="Caption"]',
  "youtube.com":   '#content-text, #comment-content',
  "tiktok.com":    '[data-e2e="browse-video-desc"]',
  "linkedin.com":  '.feed-shared-update-v2__description',
  "threads.net":   '[data-pressable-container] span',
  "twitch.tv":     '.chat-line__message',
  "bluesky.app":   '[data-testid="postText"]',
};

function getPlatformSelector() {
  const host = location.hostname.replace(/^www\./, "");
  for (const [d, s] of Object.entries(PLATFORM_SELECTORS))
    if (host.includes(d)) return s;
  return null;
}

function extractText() {
  const sel = getPlatformSelector();
  if (sel) {
    const els = [...document.querySelectorAll(sel)]
      .filter(el => !el.closest("#sentinel-root")).slice(0, 40);
    return { text: els.map(e => e.innerText.trim()).filter(Boolean).join("\n\n"), elements: els };
  }
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const p = node.parentElement;
      if (!p) return NodeFilter.FILTER_REJECT;
      if (["SCRIPT","STYLE","NOSCRIPT","TEXTAREA","INPUT"].includes(p.tagName)) return NodeFilter.FILTER_REJECT;
      if (p.closest("#sentinel-root") || p.closest(".sentinel-hl")) return NodeFilter.FILTER_REJECT;
      if (!node.textContent.trim()) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  const nodes = []; let chars = 0, node;
  while ((node = walker.nextNode()) && chars < MAX_CHARS) { nodes.push(node); chars += node.textContent.length; }
  return { text: nodes.map(n => n.textContent).join(" ").slice(0, MAX_CHARS), elements: null };
}

// ── UI INJECTION ──────────────────────────────────────────────────────────────
function injectUI() {
  if (document.getElementById("sentinel-root")) return;
  const root = document.createElement("div");
  root.id = "sentinel-root";
  root.innerHTML = `
    <div id="s-bubble" title="Sentinel">
      <svg viewBox="0 0 40 40"><polygon points="20,4 23,17 36,20 23,23 20,36 17,23 4,20 17,17" fill="#E8253A"/><circle cx="20" cy="20" r="15" fill="none" stroke="#5DD879" stroke-width="2.5"/></svg>
    </div>

    <div id="s-panel" class="s-closed">

      <!-- ═══ HOME SCREEN ═══ -->
      <div id="s-home" class="s-screen s-active">
        <div class="s-panel-header">
          <div class="s-logo-row">
            <svg viewBox="0 0 24 24" width="14" height="14"><polygon points="12,2 14,10 22,12 14,14 12,22 10,14 2,12 10,10" fill="#E8253A"/><circle cx="12" cy="12" r="9" fill="none" stroke="#5DD879" stroke-width="1.5"/></svg>
            <span class="s-wordmark">SENTINEL</span>
          </div>
          <button class="s-close-btn" id="s-close">✕</button>
        </div>
        <div class="s-home-subtitle">SELECT SCAN MODE</div>
        <div class="s-home-modes">
          <button class="s-mode-card s-mode-tox" data-mode="toxicity">
            <div class="s-mode-icon">🛑</div>
            <div class="s-mode-name">Toxicity</div>
            <div class="s-mode-desc">Cyberbullying · Hate speech · Harmful language</div>
            <div class="s-mode-arrow">→</div>
          </button>
          <button class="s-mode-card s-mode-mis" data-mode="misinfo">
            <div class="s-mode-icon">⚠️</div>
            <div class="s-mode-name">Misinformation</div>
            <div class="s-mode-desc">Fake news · AI image detection · AI text detection</div>
            <div class="s-mode-arrow">→</div>
          </button>
          <button class="s-mode-card s-mode-scam" data-mode="scam">
            <div class="s-mode-icon">🔒</div>
            <div class="s-mode-name">Scam / Malware</div>
            <div class="s-mode-desc">Phishing links · Social engineering · Fraud patterns</div>
            <div class="s-mode-arrow">→</div>
          </button>
        </div>
        <div class="s-home-footer">v5.0 · projectoverlay.onrender.com</div>
      </div>

      <!-- ═══ TOXICITY SCREEN ═══ -->
      <div id="s-screen-toxicity" class="s-screen">
        <div class="s-panel-header s-header-tox">
          <button class="s-back-btn" data-back="toxicity">← Back</button>
          <span class="s-screen-title">🛑 TOXICITY</span>
          <button class="s-close-btn" id="s-close-tox">✕</button>
        </div>
        <div class="s-tox-score-ring">
          <svg viewBox="0 0 80 80" width="80" height="80">
            <circle cx="40" cy="40" r="34" fill="none" stroke="#1a1a1a" stroke-width="6"/>
            <circle id="tox-ring" cx="40" cy="40" r="34" fill="none" stroke="#E8253A" stroke-width="6"
                    stroke-dasharray="213.6" stroke-dashoffset="213.6"
                    stroke-linecap="round" transform="rotate(-90 40 40)"
                    style="transition:stroke-dashoffset 0.8s ease"/>
          </svg>
          <div class="s-ring-label"><span id="tox-pct">0%</span><small>RISK</small></div>
        </div>
        <div class="s-action-row">
          <button class="s-scan-btn s-btn-tox" id="tox-scan">▶ Scan Page</button>
          <button class="s-clear-btn" id="tox-clear">Clear</button>
        </div>
        <div class="s-writeup-box" id="tox-writeup">
          <div class="s-writeup-label">AI ANALYSIS</div>
          <div class="s-writeup-text" id="tox-writeup-text">Run a scan to see an analysis of detected content.</div>
        </div>
        <div class="s-flags-label">FLAGGED CONTENT</div>
        <div class="s-flags-list" id="tox-flags"></div>
        <div class="s-status-bar" id="tox-status">Ready</div>
      </div>

      <!-- ═══ MISINFO SCREEN ═══ -->
      <div id="s-screen-misinfo" class="s-screen">
        <div class="s-panel-header s-header-mis">
          <button class="s-back-btn" data-back="misinfo">← Back</button>
          <span class="s-screen-title">⚠️ MISINFO</span>
          <button class="s-close-btn" id="s-close-mis">✕</button>
        </div>

        <!-- Toggles -->
        <div class="s-toggle-group">
          <div class="s-toggle-row">
            <div class="s-toggle-info">
              <span class="s-toggle-name">🖼 AI Image Detection</span>
              <span class="s-toggle-hint">Hover over any image to analyze</span>
            </div>
            <label class="s-toggle-switch">
              <input type="checkbox" id="img-detect-toggle">
              <span class="s-toggle-track"></span>
            </label>
          </div>
          <div class="s-toggle-row">
            <div class="s-toggle-info">
              <span class="s-toggle-name">✍️ AI Text Checker</span>
              <span class="s-toggle-hint">Select any text to test it</span>
            </div>
            <label class="s-toggle-switch">
              <input type="checkbox" id="text-ai-toggle">
              <span class="s-toggle-track"></span>
            </label>
          </div>
        </div>

        <!-- Image result popup (injected into page, shown on hover) -->
        <div class="s-mis-scores">
          <div class="s-mini-score">
            <span class="s-mini-label">Misinfo</span>
            <div class="s-mini-bar-wrap"><div class="s-mini-bar s-bar-mis" id="mis-bar"></div></div>
            <span class="s-mini-pct" id="mis-pct">—</span>
          </div>
          <div class="s-mini-score">
            <span class="s-mini-label">Manipulation</span>
            <div class="s-mini-bar-wrap"><div class="s-mini-bar s-bar-manip" id="manip-bar"></div></div>
            <span class="s-mini-pct" id="manip-pct">—</span>
          </div>
        </div>

        <div class="s-action-row">
          <button class="s-scan-btn s-btn-mis" id="mis-scan">▶ Scan Page</button>
          <button class="s-clear-btn" id="mis-clear">Clear</button>
        </div>

        <!-- AI text checker result -->
        <div class="s-ai-text-result" id="ai-text-result" style="display:none">
          <div class="s-writeup-label">SELECTED TEXT — AI ANALYSIS</div>
          <div class="s-ai-meter">
            <div class="s-ai-bar-track"><div class="s-ai-bar" id="ai-text-bar"></div></div>
            <span class="s-ai-pct" id="ai-text-pct">—</span>
          </div>
          <div class="s-writeup-text" id="ai-text-verdict"></div>
        </div>

        <div class="s-writeup-box" id="mis-writeup">
          <div class="s-writeup-label">AI ANALYSIS</div>
          <div class="s-writeup-text" id="mis-writeup-text">Run a scan to see misinformation analysis.</div>
        </div>
        <div class="s-flags-label">FLAGGED CONTENT</div>
        <div class="s-flags-list" id="mis-flags"></div>
        <div class="s-status-bar" id="mis-status">Ready</div>
      </div>

      <!-- ═══ SCAM SCREEN ═══ -->
      <div id="s-screen-scam" class="s-screen">
        <div class="s-panel-header s-header-scam">
          <button class="s-back-btn" data-back="scam">← Back</button>
          <span class="s-screen-title">🔒 SCAM / MALWARE</span>
          <button class="s-close-btn" id="s-close-scam">✕</button>
        </div>

        <!-- Live URL threat check -->
        <div class="s-url-check">
          <div class="s-url-display" id="scam-url-display">
            <span class="s-url-label">CURRENT PAGE</span>
            <span class="s-url-value" id="scam-url-val">${location.hostname}</span>
          </div>
          <div class="s-threat-indicators" id="scam-threat-indicators">
            <div class="s-threat-chip" id="chip-https">
              <span class="s-chip-dot"></span><span>HTTPS</span>
            </div>
            <div class="s-threat-chip" id="chip-typo">
              <span class="s-chip-dot"></span><span>Typosquat</span>
            </div>
            <div class="s-threat-chip" id="chip-urgent">
              <span class="s-chip-dot"></span><span>Urgency</span>
            </div>
            <div class="s-threat-chip" id="chip-data">
              <span class="s-chip-dot"></span><span>Data harvest</span>
            </div>
          </div>
        </div>

        <div class="s-scam-scores">
          <div class="s-mini-score">
            <span class="s-mini-label">Phishing risk</span>
            <div class="s-mini-bar-wrap"><div class="s-mini-bar s-bar-scam" id="scam-bar"></div></div>
            <span class="s-mini-pct" id="scam-pct">—</span>
          </div>
          <div class="s-mini-score">
            <span class="s-mini-label">Social engineering</span>
            <div class="s-mini-bar-wrap"><div class="s-mini-bar s-bar-social" id="social-eng-bar"></div></div>
            <span class="s-mini-pct" id="social-eng-pct">—</span>
          </div>
        </div>

        <div class="s-action-row">
          <button class="s-scan-btn s-btn-scam" id="scam-scan">▶ Scan Page</button>
          <button class="s-clear-btn" id="scam-clear">Clear</button>
        </div>

        <div class="s-writeup-box" id="scam-writeup">
          <div class="s-writeup-label">THREAT ANALYSIS</div>
          <div class="s-writeup-text" id="scam-writeup-text">Run a scan to detect phishing and scam patterns.</div>
        </div>

        <!-- Link scanner -->
        <div class="s-link-scan-section">
          <div class="s-flags-label">SUSPICIOUS LINKS FOUND</div>
          <div class="s-flags-list" id="scam-links"></div>
        </div>
        <div class="s-flags-label">FLAGGED CONTENT</div>
        <div class="s-flags-list" id="scam-flags"></div>
        <div class="s-status-bar" id="scam-status">Ready</div>
      </div>

    </div><!-- end s-panel -->

    <!-- Image hover tooltip (appended to body, positioned by JS) -->
    <div id="s-img-tooltip" style="display:none">
      <div class="s-img-tip-header">🖼 IMAGE ANALYSIS</div>
      <div class="s-img-tip-bar-wrap"><div class="s-img-tip-bar" id="img-tip-bar"></div></div>
      <div class="s-img-tip-verdict" id="img-tip-verdict">Analyzing…</div>
      <div class="s-img-tip-signals" id="img-tip-signals"></div>
    </div>
  `;
  document.body.appendChild(root);

  // Wire events
  document.getElementById("s-bubble").addEventListener("click", toggleSidebar);
  document.querySelectorAll(".s-close-btn").forEach(b => b.addEventListener("click", closeSidebar));
  document.querySelectorAll(".s-mode-card").forEach(b =>
    b.addEventListener("click", () => goMode(b.dataset.mode))
  );
  document.querySelectorAll(".s-back-btn").forEach(b =>
    b.addEventListener("click", goHome)
  );

  // Toxicity
  document.getElementById("tox-scan").addEventListener("click",  () => runScan("toxicity"));
  document.getElementById("tox-clear").addEventListener("click", clearHighlights);

  // Misinfo
  document.getElementById("mis-scan").addEventListener("click",  () => runScan("misinfo"));
  document.getElementById("mis-clear").addEventListener("click", clearHighlights);
  document.getElementById("img-detect-toggle").addEventListener("change", e => {
    imageDetectOn = e.target.checked;
    toggleImageDetect(imageDetectOn);
  });
  document.getElementById("text-ai-toggle").addEventListener("change", e => {
    textAiOn = e.target.checked;
    toggleTextAi(textAiOn);
  });

  // Scam
  document.getElementById("scam-scan").addEventListener("click",  () => runScan("scam"));
  document.getElementById("scam-clear").addEventListener("click", clearHighlights);

  // Run URL checks immediately
  runUrlChecks();
}

// ── Navigation ────────────────────────────────────────────────────────────────
function toggleSidebar() { sidebarOpen ? closeSidebar() : openSidebar(); }

function openSidebar() {
  sidebarOpen = true;
  document.getElementById("s-panel").classList.remove("s-closed");
  document.getElementById("s-bubble").classList.add("s-bubble-on");
}

function closeSidebar() {
  sidebarOpen = false;
  document.getElementById("s-panel").classList.add("s-closed");
  document.getElementById("s-bubble").classList.remove("s-bubble-on");
}

function goMode(mode) {
  activeMode = mode;
  document.querySelectorAll(".s-screen").forEach(s => s.classList.remove("s-active"));
  document.getElementById(`s-screen-${mode}`).classList.add("s-active");
  clearHighlights();
}

function goHome() {
  activeMode = null;
  document.querySelectorAll(".s-screen").forEach(s => s.classList.remove("s-active"));
  document.getElementById("s-home").classList.add("s-active");
  clearHighlights();
}

// ── Scan ──────────────────────────────────────────────────────────────────────
async function runScan(mode) {
  if (isScanning) return;
  isScanning = true;
  setStatus(mode, "Scanning…");

  const { text } = extractText();
  if (!text || text.trim().length < 20) {
    setStatus(mode, "Not enough text on page");
    isScanning = false;
    return;
  }

  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, mode }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    lastFlags = data.flags || [];

    observerPaused = true;
    clearHighlights();

    if (mode === "toxicity") {
      updateToxicityUI(data);
      applyHighlights(lastFlags.filter(f => f.type === "toxicity"), "s-hl-red");
    } else if (mode === "misinfo") {
      updateMisinfoUI(data);
      applyHighlights(lastFlags.filter(f => f.type === "misinfo" || f.type === "manipulation"), "s-hl-amber");
      applyHighlights(lastFlags.filter(f => f.type === "ai"), "s-hl-purple");
    } else if (mode === "scam") {
      updateScamUI(data);
      applyHighlights(lastFlags.filter(f => f.type === "scam" || f.type === "phishing"), "s-hl-orange");
    }

    observerPaused = false;
    const count = lastFlags.length;
    setStatus(mode, count > 0 ? `${count} flag(s) detected` : "No issues found");
  } catch(e) {
    setStatus(mode, "Backend unreachable");
    console.warn("[Sentinel]", e);
  }
  isScanning = false;
}

// ── Toxicity UI ───────────────────────────────────────────────────────────────
function updateToxicityUI(data) {
  const pct = Math.round((data.toxicity || 0) * 100);
  // Ring: circumference = 2π×34 ≈ 213.6
  const offset = 213.6 - (213.6 * pct / 100);
  const ring = document.getElementById("tox-ring");
  if (ring) {
    ring.style.strokeDashoffset = offset;
    ring.style.stroke = pct > 65 ? "#E8253A" : pct > 35 ? "#F5A623" : "#5DD879";
  }
  const pctEl = document.getElementById("tox-pct");
  if (pctEl) pctEl.textContent = pct + "%";

  renderFlags("tox-flags", lastFlags.filter(f => f.type === "toxicity"), "toxicity");
  generateWriteup("tox-writeup-text", lastFlags.filter(f => f.type === "toxicity"), "toxicity", pct);
}

// ── Misinfo UI ────────────────────────────────────────────────────────────────
function updateMisinfoUI(data) {
  const mis   = Math.round((data.misinfo || 0) * 100);
  const manip = Math.round((data.manipulation || 0) * 100);
  setBar("mis-bar",   "mis-pct",       mis);
  setBar("manip-bar", "manip-pct",     manip);
  const relevant = lastFlags.filter(f => f.type === "misinfo" || f.type === "manipulation" || f.type === "ai");
  renderFlags("mis-flags", relevant, "misinfo");
  generateWriteup("mis-writeup-text", relevant, "misinfo", mis);
}

// ── Scam UI ───────────────────────────────────────────────────────────────────
function updateScamUI(data) {
  const scamPct      = Math.round((data.scam_score || 0) * 100);
  const socialPct    = Math.round((data.manipulation || 0) * 100);
  setBar("scam-bar",       "scam-pct",       scamPct);
  setBar("social-eng-bar", "social-eng-pct", socialPct);
  renderFlags("scam-flags", lastFlags.filter(f => f.type === "scam" || f.type === "phishing"), "scam");
  renderLinks("scam-links");
  generateWriteup("scam-writeup-text", lastFlags, "scam", scamPct);
}

// ── Bar helper ────────────────────────────────────────────────────────────────
function setBar(barId, pctId, pct) {
  const bar = document.getElementById(barId);
  const lbl = document.getElementById(pctId);
  if (bar) { bar.style.width = pct + "%"; bar.style.opacity = "1"; }
  if (lbl) lbl.textContent = pct + "%";
}

// ── AI Writeup generator ──────────────────────────────────────────────────────
function generateWriteup(elId, flags, mode, score) {
  const el = document.getElementById(elId);
  if (!el) return;

  if (flags.length === 0) {
    el.textContent = score < 20
      ? "No significant patterns detected. Content appears clean."
      : "Low-level signals detected. Exercise standard caution.";
    return;
  }

  const phrases = flags.slice(0, 3).map(f => `"${f.phrase.slice(0, 40)}"`).join(", ");

  const writeups = {
    toxicity: `Sentinel detected ${flags.length} instance(s) of potentially harmful language on this page. ` +
      `Flagged content includes: ${phrases}. ` +
      (score > 65
        ? "Risk level is HIGH. This content contains language consistent with targeted harassment or cyberbullying."
        : score > 35
        ? "Risk level is MODERATE. Some language may be aggressive or harmful depending on context."
        : "Risk level is LOW. Flagged phrases may be context-dependent."),

    misinfo: `${flags.length} misinformation signal(s) found. Detected phrases: ${phrases}. ` +
      (score > 65
        ? "HIGH likelihood of misleading content. Patterns match known misinformation tactics: emotional manipulation, false certainty, and appeal to conspiracy."
        : score > 35
        ? "MODERATE signals. Content uses persuasion tactics common in misleading articles. Cross-reference with trusted sources."
        : "LOW risk. Minor signals detected — may be coincidental language patterns."),

    scam: `${flags.length} threat indicator(s) identified. Flagged: ${phrases}. ` +
      (score > 65
        ? "HIGH threat level. This page exhibits multiple phishing and social engineering markers. Do not submit personal information."
        : score > 35
        ? "MODERATE threat. Some pressure tactics and suspicious patterns detected. Proceed with caution."
        : "LOW risk. A few minor signals found. Stay alert for follow-up requests for personal data."),
  };

  el.textContent = writeups[mode] || "Analysis complete.";
}

// ── Flag renderer ─────────────────────────────────────────────────────────────
function renderFlags(containerId, flags, mode) {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (!flags.length) {
    el.innerHTML = `<div class="s-no-flags">No flags detected</div>`;
    return;
  }
  const esc = s => s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  const colorMap = { toxicity: "#E8253A", manipulation: "#F5A623", misinfo: "#4A8FE8", ai: "#9B5CF6", scam: "#FF6B35", phishing: "#FF6B35" };
  el.innerHTML = flags.map(f => `
    <div class="s-flag-row" style="border-left-color:${colorMap[f.type]||"#555"}">
      <div class="s-fr-type">${esc(f.type.toUpperCase())}</div>
      <div class="s-fr-phrase">"${esc(f.phrase.slice(0,70))}${f.phrase.length>70?"…":""}"</div>
      ${f.score ? `<div class="s-fr-conf">Confidence: ${Math.round(f.score*100)}%</div>` : ""}
    </div>
  `).join("");
}

// ── Link scanner ──────────────────────────────────────────────────────────────
function renderLinks(containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const links = [...document.querySelectorAll("a[href]")]
    .filter(a => !a.closest("#sentinel-root"))
    .map(a => ({ href: a.href, text: a.textContent.trim().slice(0,40) }))
    .filter(l => isSuspiciousLink(l.href))
    .slice(0, 8);

  if (!links.length) { el.innerHTML = `<div class="s-no-flags">No suspicious links found</div>`; return; }
  const esc = s => s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  el.innerHTML = links.map(l => `
    <div class="s-flag-row" style="border-left-color:#FF6B35">
      <div class="s-fr-type">SUSPICIOUS LINK</div>
      <div class="s-fr-phrase">${esc(l.text || l.href.slice(0,50))}</div>
      <div class="s-fr-conf">${esc(l.href.slice(0,60))}</div>
    </div>
  `).join("");
}

function isSuspiciousLink(href) {
  if (!href) return false;
  const suspicious = [
    /bit\.ly|tinyurl|t\.co|goo\.gl|ow\.ly/i,
    /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/,
    /login|signin|verify|confirm|update|secure|account|password/i,
    /paypal|amazon|apple|google|microsoft|netflix/i,
  ];
  try {
    const url = new URL(href);
    if (suspicious[0].test(url.hostname)) return true;
    if (suspicious[1].test(url.hostname)) return true;
    if (suspicious[2].test(url.pathname)) return true;
    const knownDomains = ["paypal.com","amazon.com","apple.com","google.com","microsoft.com","netflix.com"];
    if (suspicious[3].test(url.hostname) && !knownDomains.some(d => url.hostname.endsWith(d))) return true;
  } catch { return false; }
  return false;
}

// ── URL threat checks ─────────────────────────────────────────────────────────
function runUrlChecks() {
  const url = location.href;
  const hostname = location.hostname;

  const checks = {
    "chip-https":  location.protocol === "https:",
    "chip-typo":   !isTyposquat(hostname),
    "chip-urgent": !hasUrgencyPatterns(),
    "chip-data":   !hasDataHarvestForms(),
  };

  for (const [id, safe] of Object.entries(checks)) {
    const chip = document.getElementById(id);
    if (!chip) continue;
    chip.classList.toggle("s-chip-safe",   safe);
    chip.classList.toggle("s-chip-danger", !safe);
  }
}

function isTyposquat(hostname) {
  const targets = ["paypal","amazon","google","microsoft","apple","netflix","facebook","instagram"];
  for (const t of targets) {
    if (hostname.includes(t)) continue;
    for (const known of targets) {
      if (levenshtein(hostname.replace(/\.[^.]+$/, ""), known) <= 2) return true;
    }
  }
  return false;
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({length: m+1}, (_, i) => Array.from({length: n+1}, (_, j) => i === 0 ? j : j === 0 ? i : 0));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

function hasUrgencyPatterns() {
  const text = document.body.innerText.toLowerCase();
  return ["act now","limited time","expires today","account suspended","verify immediately","urgent action required"].some(p => text.includes(p));
}

function hasDataHarvestForms() {
  const forms = document.querySelectorAll("form");
  for (const f of forms) {
    const inputs = f.querySelectorAll('input[type="password"], input[name*="card"], input[name*="ssn"]');
    if (inputs.length > 0) return true;
  }
  return false;
}

// ── Highlight DOM ─────────────────────────────────────────────────────────────
function snapshotTextNodes() {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const p = node.parentElement;
      if (!p) return NodeFilter.FILTER_REJECT;
      if (["SCRIPT","STYLE","NOSCRIPT","TEXTAREA","INPUT"].includes(p.tagName)) return NodeFilter.FILTER_REJECT;
      if (p.closest("#sentinel-root") || p.closest(".sentinel-hl")) return NodeFilter.FILTER_REJECT;
      if (!node.textContent.trim()) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  const nodes = []; let node;
  while ((node = walker.nextNode())) nodes.push(node);
  return nodes;
}

function applyHighlights(flags, cssClass) {
  if (!flags.length) return;
  const textNodes = snapshotTextNodes();
  for (const flag of flags) highlightPhrase(textNodes, flag.phrase, cssClass, flag.type);
}

function highlightPhrase(textNodes, phrase, cssClass, type) {
  const lower = phrase.toLowerCase();
  for (const textNode of textNodes) {
    const text = textNode.textContent;
    const idx  = text.toLowerCase().indexOf(lower);
    if (idx === -1) continue;
    const parent = textNode.parentNode;
    if (!parent) continue;
    const span = document.createElement("span");
    span.className = `sentinel-hl ${cssClass}`;
    span.setAttribute("data-sentinel", "1");
    span.textContent = text.slice(idx, idx + phrase.length);
    const tip = document.createElement("span");
    tip.className = "s-tip";
    tip.textContent = buildTip(type);
    span.appendChild(tip);
    parent.insertBefore(document.createTextNode(text.slice(0, idx)), textNode);
    parent.insertBefore(span, textNode);
    parent.insertBefore(document.createTextNode(text.slice(idx + phrase.length)), textNode);
    parent.removeChild(textNode);
    break;
  }
}

function buildTip(type) {
  return {
    toxicity:     "Toxic: harmful language targeting a person",
    manipulation: "Manipulation: emotionally charged persuasion",
    misinfo:      "Misinfo: pattern associated with false information",
    ai:           "AI-generated text pattern detected",
    scam:         "Scam: social engineering or phishing pattern",
    phishing:     "Phishing: credential or data harvest attempt",
  }[type] || "Flagged by Sentinel";
}

function clearHighlights() {
  [...document.querySelectorAll(".sentinel-hl[data-sentinel]")].forEach(el => {
    const parent = el.parentNode;
    if (!parent) return;
    parent.replaceChild(document.createTextNode(el.childNodes[0]?.textContent || el.textContent), el);
  });
  document.body.normalize();
  document.querySelectorAll(".s-post-outline").forEach(el =>
    el.classList.remove("s-post-outline","s-post-harmful","s-post-clean")
  );
  // Clear image overlays
  document.querySelectorAll(".s-img-overlay").forEach(el => el.remove());
}

// ── Status helper ─────────────────────────────────────────────────────────────
function setStatus(mode, msg) {
  const map = { toxicity: "tox-status", misinfo: "mis-status", scam: "scam-status" };
  const el = document.getElementById(map[mode]);
  if (el) el.textContent = msg;
}

// ── IMAGE HOVER DETECTION ─────────────────────────────────────────────────────
let imgHoverTimer = null;
let currentImgEl  = null;

function toggleImageDetect(on) {
  if (on) {
    document.addEventListener("mouseover", onImgHover);
    document.addEventListener("mouseout",  onImgOut);
  } else {
    document.removeEventListener("mouseover", onImgHover);
    document.removeEventListener("mouseout",  onImgOut);
    hideImgTooltip();
  }
}

function onImgHover(e) {
  const img = e.target.closest("img");
  if (!img || img.closest("#sentinel-root")) return;
  if (img === currentImgEl) return;
  currentImgEl = img;
  clearTimeout(imgHoverTimer);
  imgHoverTimer = setTimeout(() => analyzeImage(img), 600);
}

function onImgOut(e) {
  clearTimeout(imgHoverTimer);
  const related = e.relatedTarget;
  if (related && (related.closest("#s-img-tooltip") || related === currentImgEl)) return;
  currentImgEl = null;
  hideImgTooltip();
}

function hideImgTooltip() {
  const tip = document.getElementById("s-img-tooltip");
  if (tip) tip.style.display = "none";
}

function showImgTooltip(img, score, verdict, signals) {
  const tip = document.getElementById("s-img-tooltip");
  if (!tip) return;
  const bar = document.getElementById("img-tip-bar");
  const v   = document.getElementById("img-tip-verdict");
  const sig = document.getElementById("img-tip-signals");

  const pct = Math.round(score * 100);
  if (bar) { bar.style.width = pct + "%"; bar.style.background = pct > 65 ? "#9B5CF6" : pct > 35 ? "#F5A623" : "#5DD879"; }
  if (v)   v.textContent = verdict;
  if (sig) sig.innerHTML = signals.map(s => `<span class="s-sig-chip">${s}</span>`).join("");

  const rect = img.getBoundingClientRect();
  tip.style.display = "block";
  tip.style.left = Math.min(rect.left + window.scrollX, window.innerWidth - 240) + "px";
  tip.style.top  = (rect.bottom + window.scrollY + 8) + "px";
}

async function analyzeImage(img) {
  const tip = document.getElementById("s-img-tooltip");
  if (!tip) return;

  // Show loading state
  const bar = document.getElementById("img-tip-bar");
  const v   = document.getElementById("img-tip-verdict");
  const sig = document.getElementById("img-tip-signals");
  if (bar) { bar.style.width = "30%"; bar.style.background = "#444"; }
  if (v)   v.textContent = "Analyzing image…";
  if (sig) sig.innerHTML = "";

  const rect = img.getBoundingClientRect();
  tip.style.display = "block";
  tip.style.left = Math.min(rect.left + window.scrollX, window.innerWidth - 240) + "px";
  tip.style.top  = (rect.bottom + window.scrollY + 8) + "px";

  // Heuristic analysis (no backend needed for basic signals)
  const signals = detectImageSignals(img);
  const score   = signals.aiScore;
  const verdict = score > 0.65
    ? "Likely AI-generated"
    : score > 0.35
    ? "Possibly AI-generated"
    : "Likely real photograph";

  showImgTooltip(img, score, verdict, signals.labels);
}

function detectImageSignals(img) {
  const labels = [];
  let score = 0;

  // Signal 1: src patterns (known AI image CDNs/generators)
  const src = (img.src || img.currentSrc || "").toLowerCase();
  const aiSources = ["thispersondoesnotexist","generated","ai-generated","midjourney","stable-diffusion","dall-e","firefly","imagen","nightcafe","artbreeder","civitai","leonardo.ai"];
  if (aiSources.some(s => src.includes(s))) { score += 0.5; labels.push("AI source URL"); }

  // Signal 2: perfect aspect ratios (AI tends toward 1:1, 16:9 exactly)
  const w = img.naturalWidth, h = img.naturalHeight;
  if (w && h) {
    const ratio = w / h;
    const perfectRatios = [1.0, 16/9, 4/3, 3/2, 9/16];
    if (perfectRatios.some(r => Math.abs(ratio - r) < 0.01)) { score += 0.15; labels.push("Perfect aspect ratio"); }
    // AI images are often exactly 512, 768, 1024px
    if ([512,768,1024,1280,1536,2048].includes(w) || [512,768,1024,1280,1536,2048].includes(h)) {
      score += 0.2; labels.push("AI-standard resolution");
    }
  }

  // Signal 3: alt text patterns
  const alt = (img.alt || img.title || "").toLowerCase();
  const aiAltPatterns = ["generated","artificial","ai art","prompt","render","3d","cgi","illustration","digital art"];
  if (aiAltPatterns.some(p => alt.includes(p))) { score += 0.3; labels.push("AI alt text"); }

  // Signal 4: no EXIF-like metadata in surrounding context
  const parent = img.parentElement;
  const context = parent ? parent.innerText?.toLowerCase() || "" : "";
  if (["photo by","©","camera","canon","nikon","shot on","f/","iso "].some(p => context.includes(p))) {
    score -= 0.2; labels.push("Camera metadata found");
  }

  // Signal 5: surrounding page context
  if (["ai generated","generated by ai","made with ai","created with ai","stable diffusion","midjourney"].some(p => context.includes(p))) {
    score += 0.4; labels.push("AI context on page");
  }

  if (!labels.length) labels.push("No strong signals");

  return { aiScore: Math.max(0, Math.min(1, score)), labels };
}

// ── TEXT SELECTION AI CHECKER ─────────────────────────────────────────────────
let selectionTimer = null;

function toggleTextAi(on) {
  if (on) {
    document.addEventListener("mouseup", onTextSelect);
  } else {
    document.removeEventListener("mouseup", onTextSelect);
    const res = document.getElementById("ai-text-result");
    if (res) res.style.display = "none";
  }
}

function onTextSelect() {
  clearTimeout(selectionTimer);
  selectionTimer = setTimeout(async () => {
    const sel  = window.getSelection();
    const text = sel?.toString().trim();
    if (!text || text.length < 40) return;
    if (sel.anchorNode?.parentElement?.closest("#sentinel-root")) return;

    const res = document.getElementById("ai-text-result");
    if (!res) return;
    res.style.display = "block";

    const bar     = document.getElementById("ai-text-bar");
    const pctEl   = document.getElementById("ai-text-pct");
    const verdict = document.getElementById("ai-text-verdict");

    if (pctEl)   pctEl.textContent = "…";
    if (verdict) verdict.textContent = "Analyzing selected text…";
    if (bar)     { bar.style.width = "20%"; bar.style.background = "#333"; }

    try {
      const resp = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, mode: "aidetect" }),
      });
      const data = await resp.json();
      const pct  = Math.round((data.ai_score || 0) * 100);

      if (bar)   { bar.style.width = pct + "%"; bar.style.background = pct > 65 ? "#9B5CF6" : pct > 35 ? "#F5A623" : "#5DD879"; }
      if (pctEl) pctEl.textContent = pct + "%";
      if (verdict) verdict.textContent = pct > 65
        ? "Likely AI-generated. High density of AI writing patterns detected."
        : pct > 35
        ? "Possibly AI-generated. Some machine-writing signals present."
        : "Likely human-written. Low AI pattern density.";
    } catch {
      if (verdict) verdict.textContent = "Could not reach backend.";
    }
  }, 400);
}

// ── MutationObserver ──────────────────────────────────────────────────────────
const observer = new MutationObserver(() => {
  if (observerPaused || !activeMode) return;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => runScan(activeMode), DEBOUNCE_MS);
});

// ── Init ──────────────────────────────────────────────────────────────────────
injectUI();
observer.observe(document.body, { childList: true, subtree: true });
