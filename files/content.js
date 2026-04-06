// content.js — Sentinel v4
// Fixes: highlight blinking, infinite observer loop, broken clearHighlights,
//        dead AI detection, missing social media selectors

const API_URL = "https://projectoverlay.onrender.com/api/analyze-text";
const MAX_CHARS = 5000;
const DEBOUNCE_MS = 2000;

// ── State ─────────────────────────────────────────────────────────────────────
let activeMode    = null;
let sidebarOpen   = false;
let lastFlags     = [];
let debounceTimer = null;
let isScanning    = false;   // prevents overlapping scans
let observerPaused = false;  // paused while we mutate DOM for highlights

// ── Social media platform selectors ──────────────────────────────────────────
// Maps hostname patterns to CSS selectors for individual posts/messages
const PLATFORM_SELECTORS = {
  "twitter.com":        '[data-testid="tweetText"]',
  "x.com":              '[data-testid="tweetText"]',
  "reddit.com":         '[data-testid="comment"], .Post, [slot="text-body"]',
  "discord.com":        '[class*="messageContent"]',
  "facebook.com":       '[data-ad-comet-preview="message"], [data-testid="post_message"]',
  "instagram.com":      'h1, [class*="Caption"]',
  "youtube.com":        '#content-text, #comment-content',
  "tiktok.com":         '[data-e2e="browse-video-desc"], [class*="comment-text"]',
  "linkedin.com":       '.feed-shared-update-v2__description, .comments-comment-item__main-content',
  "threads.net":        '[data-pressable-container] span',
  "tumblr.com":         '.npf-text-block, .post-body',
  "twitch.tv":          '.chat-line__message',
  "mastodon.social":    '.status__content',
  "bluesky.app":        '[data-testid="postText"]',
};

function getPlatformSelector() {
  const host = location.hostname.replace(/^www\./, "");
  for (const [domain, sel] of Object.entries(PLATFORM_SELECTORS)) {
    if (host.includes(domain)) return sel;
  }
  return null;
}

function isSocialMedia() {
  return getPlatformSelector() !== null;
}

// ── Extract text — platform-aware ─────────────────────────────────────────────
function extractText() {
  const sel = getPlatformSelector();

  if (sel) {
    // Social media: grab individual post/message elements
    const els = [...document.querySelectorAll(sel)]
      .filter(el => !el.closest("#sentinel-root"))
      .slice(0, 40); // cap at 40 posts to avoid huge payloads
    return {
      text: els.map(el => el.innerText.trim()).filter(Boolean).join("\n\n"),
      elements: els,
    };
  }

  // Generic page: walk text nodes
  const walker = document.createTreeWalker(
    document.body, NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        const p = node.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (["SCRIPT","STYLE","NOSCRIPT","TEXTAREA","INPUT"].includes(p.tagName))
          return NodeFilter.FILTER_REJECT;
        if (p.closest("#sentinel-root")) return NodeFilter.FILTER_REJECT;
        if (p.closest(".sentinel-hl"))   return NodeFilter.FILTER_REJECT;
        if (!node.textContent.trim())    return NodeFilter.FILTER_REJECT;
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
  return {
    text: nodes.map(n => n.textContent).join(" ").slice(0, MAX_CHARS),
    elements: null,
  };
}

// ── Inject UI ─────────────────────────────────────────────────────────────────
function injectUI() {
  if (document.getElementById("sentinel-root")) return;

  const root = document.createElement("div");
  root.id = "sentinel-root";
  root.innerHTML = `
    <div id="sentinel-bubble" title="Open Sentinel">
      <svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">
        <polygon points="20,4 23,17 36,20 23,23 20,36 17,23 4,20 17,17" fill="#E8253A"/>
        <circle cx="20" cy="20" r="15" fill="none" stroke="#5DD879" stroke-width="2.5"/>
      </svg>
    </div>

    <div id="sentinel-panel" class="s-closed">
      <div id="s-header">
        <div id="s-logo">
          <svg viewBox="0 0 24 24" width="16" height="16">
            <polygon points="12,2 14,10 22,12 14,14 12,22 10,14 2,12 10,10" fill="#E8253A"/>
            <circle cx="12" cy="12" r="9" fill="none" stroke="#5DD879" stroke-width="1.5"/>
          </svg>
          <span>Sentinel</span>
          <span id="s-platform-badge"></span>
        </div>
        <button id="s-close" aria-label="Close">✕</button>
      </div>

      <div id="s-tabs">
        <button class="s-tab" data-mode="toxicity">
          <span>🛑</span><span>Toxicity</span>
        </button>
        <button class="s-tab" data-mode="misinfo">
          <span>⚠️</span><span>Misinfo</span>
        </button>
        <button class="s-tab" data-mode="aidetect">
          <span>🤖</span><span>AI Text</span>
        </button>
      </div>

      <div id="s-score-wrap">
        <div class="s-score-row" id="srow-toxicity">
          <span class="s-score-label">Toxicity</span>
          <div class="s-bar-track"><div class="s-bar" id="sbar-toxicity"></div></div>
          <span class="s-score-pct" id="spct-toxicity">—</span>
        </div>
        <div class="s-score-row" id="srow-misinfo">
          <span class="s-score-label">Misinfo</span>
          <div class="s-bar-track"><div class="s-bar" id="sbar-misinfo"></div></div>
          <span class="s-score-pct" id="spct-misinfo">—</span>
        </div>
        <div class="s-score-row" id="srow-aidetect">
          <span class="s-score-label">AI likelihood</span>
          <div class="s-bar-track"><div class="s-bar" id="sbar-aidetect"></div></div>
          <span class="s-score-pct" id="spct-aidetect">—</span>
        </div>
      </div>

      <div id="s-status">Select a mode to begin</div>

      <div id="s-log-label">Flagged content</div>
      <div id="s-log"><div class="s-empty">No flags yet</div></div>

      <div id="s-footer">
        <button id="s-scan">Scan now</button>
        <button id="s-clear">Clear</button>
      </div>
    </div>
  `;

  document.body.appendChild(root);

  // Badge for social media
  const badge = document.getElementById("s-platform-badge");
  if (isSocialMedia()) {
    const host = location.hostname.replace(/^www\./, "").split(".")[0];
    badge.textContent = host;
    badge.style.display = "inline-block";
  }

  document.getElementById("sentinel-bubble").addEventListener("click", toggleSidebar);
  document.getElementById("s-close").addEventListener("click", closeSidebar);
  document.getElementById("s-scan").addEventListener("click", () => runScan(true));
  document.getElementById("s-clear").addEventListener("click", clearHighlights);
  document.querySelectorAll(".s-tab").forEach(btn =>
    btn.addEventListener("click", () => setMode(btn.dataset.mode))
  );
}

// ── Sidebar ───────────────────────────────────────────────────────────────────
function toggleSidebar() { sidebarOpen ? closeSidebar() : openSidebar(); }

function openSidebar() {
  sidebarOpen = true;
  document.getElementById("sentinel-panel").classList.remove("s-closed");
  document.getElementById("sentinel-bubble").classList.add("s-bubble-on");
}

function closeSidebar() {
  sidebarOpen = false;
  document.getElementById("sentinel-panel").classList.add("s-closed");
  document.getElementById("sentinel-bubble").classList.remove("s-bubble-on");
}

// ── Mode ──────────────────────────────────────────────────────────────────────
function setMode(mode) {
  activeMode = mode;
  document.querySelectorAll(".s-tab").forEach(b =>
    b.classList.toggle("s-tab-on", b.dataset.mode === mode)
  );
  // Show only the relevant score row
  ["toxicity","misinfo","aidetect"].forEach(m => {
    const row = document.getElementById(`srow-${m}`);
    if (row) row.style.cssText = (m === mode) ? "display:flex" : "display:none";
  });
  clearHighlights();
  refilterLog();
  runScan(true);
}

// ── Scan ──────────────────────────────────────────────────────────────────────
async function runScan(force = false) {
  if (!activeMode) { setStatus("Pick a mode first"); return; }
  if (isScanning && !force) return;
  isScanning = true;
  setStatus("Scanning…");

  const { text } = extractText();
  if (!text || text.trim().length < 20) {
    setStatus("Not enough text on page");
    isScanning = false;
    return;
  }

  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, mode: activeMode }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    lastFlags = data.flags || [];
    updateScores(data);

    // Pause observer before touching DOM to prevent re-trigger loop
    observerPaused = true;
    clearHighlights();
    applyHighlights(lastFlags);
    observerPaused = false;

    renderLog(lastFlags);

    const relevant = lastFlags.filter(f => flagMatchesMode(f, activeMode));
    setStatus(relevant.length > 0
      ? `${relevant.length} flag(s) found`
      : "No issues detected");
  } catch (e) {
    setStatus("Backend unreachable");
    console.warn("[Sentinel]", e);
  }

  isScanning = false;
}

function flagMatchesMode(flag, mode) {
  if (mode === "toxicity") return flag.type === "toxicity";
  if (mode === "misinfo")  return flag.type === "misinfo" || flag.type === "manipulation";
  if (mode === "aidetect") return flag.type === "ai";
  return true;
}

// ── Score bars ────────────────────────────────────────────────────────────────
function updateScores(data) {
  const setBar = (id, val) => {
    const pct = Math.round((val || 0) * 100);
    const bar = document.getElementById(`sbar-${id}`);
    const lbl = document.getElementById(`spct-${id}`);
    if (bar) { bar.style.width = pct + "%"; bar.style.background = pctColor(pct); }
    if (lbl) lbl.textContent = pct + "%";
  };
  setBar("toxicity", data.toxicity);
  setBar("misinfo",  data.misinfo);
  setBar("aidetect", data.ai_score || 0);
}

function pctColor(p) {
  if (p > 65) return "#E8253A";
  if (p > 35) return "#F5A623";
  return "#5DD879";
}

// ── Highlights — fixed DOM surgery ────────────────────────────────────────────
// Bug fix: old version tried to unwrap children while iterating, which
// broke when tooltip was a child node. New approach: replace span with
// a plain text node using outerText, never touch children directly.

const TYPE_CLS = {
  toxicity:     "s-hl-red",
  manipulation: "s-hl-yellow",
  misinfo:      "s-hl-blue",
  ai:           "s-hl-purple",
};

function applyHighlights(flags) {
  const relevant = flags.filter(f => flagMatchesMode(f, activeMode));
  if (!relevant.length) return;

  // Snapshot text nodes ONCE before modifying anything
  const { elements } = extractText();
  const textNodes = snapshotTextNodes();

  for (const flag of relevant) {
    const cls    = TYPE_CLS[flag.type] || "s-hl-yellow";
    const tip    = buildTip(flag);
    highlightPhrase(textNodes, flag.phrase, cls, tip);
  }

  // Social media: also outline the whole post container if harmful
  if (elements && isSocialMedia()) {
    outlinePosts(elements, flags);
  }
}

function snapshotTextNodes() {
  // Returns a static array — safe to modify DOM while iterating
  const walker = document.createTreeWalker(
    document.body, NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        const p = node.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (["SCRIPT","STYLE","NOSCRIPT","TEXTAREA","INPUT"].includes(p.tagName))
          return NodeFilter.FILTER_REJECT;
        if (p.closest("#sentinel-root")) return NodeFilter.FILTER_REJECT;
        if (p.closest(".sentinel-hl"))   return NodeFilter.FILTER_REJECT;
        if (!node.textContent.trim())    return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );
  const nodes = [];
  let node;
  while ((node = walker.nextNode())) nodes.push(node);
  return nodes; // static snapshot, safe to iterate
}

function highlightPhrase(textNodes, phrase, cssClass, tipText) {
  const lowerPhrase = phrase.toLowerCase();

  for (const textNode of textNodes) {
    const text  = textNode.textContent;
    const lower = text.toLowerCase();
    const idx   = lower.indexOf(lowerPhrase);
    if (idx === -1) continue;

    const parent = textNode.parentNode;
    if (!parent) continue;

    const before = document.createTextNode(text.slice(0, idx));
    const after  = document.createTextNode(text.slice(idx + phrase.length));

    const span = document.createElement("span");
    span.className = `sentinel-hl ${cssClass}`;
    span.setAttribute("data-sentinel", "1");
    span.textContent = text.slice(idx, idx + phrase.length);

    const tooltip = document.createElement("span");
    tooltip.className = "s-tip";
    tooltip.textContent = tipText;
    span.appendChild(tooltip);

    parent.insertBefore(before, textNode);
    parent.insertBefore(span, textNode);
    parent.insertBefore(after, textNode);
    parent.removeChild(textNode);

    // Update the reference so subsequent phrases search in fresh nodes
    // (textNode is now removed from DOM — stop searching this node)
    break;
  }
}

function buildTip(flag) {
  const labels = {
    toxicity:     "Toxic: harmful language targeting a person",
    manipulation: "Manipulation: emotionally charged persuasion",
    misinfo:      "Misinfo: pattern associated with false information",
    ai:           "AI-generated: statistical patterns of machine-written text",
  };
  return labels[flag.type] || "Flagged by Sentinel";
}

// Bug fix: old clearHighlights tried to unwrap .firstChild while tooltip
// was still attached, corrupting the DOM. New approach: replace each
// highlight span with a plain text node of its visible text content.
function clearHighlights() {
  // Use querySelectorAll snapshot — safe to modify while iterating
  const highlights = [...document.querySelectorAll(".sentinel-hl[data-sentinel]")];
  for (const el of highlights) {
    const parent = el.parentNode;
    if (!parent) continue;
    // Replace span with just its text content (drops tooltip child automatically)
    const text = el.childNodes[0]?.textContent || el.textContent;
    parent.replaceChild(document.createTextNode(text), el);
  }
  // Merge adjacent text nodes to keep DOM clean
  document.body.normalize();

  // Clear social media post outlines too
  document.querySelectorAll(".s-post-outline").forEach(el =>
    el.classList.remove("s-post-outline", "s-post-harmful", "s-post-clean")
  );
}

// ── Social media post outlines ────────────────────────────────────────────────
function outlinePosts(postEls, flags) {
  const flaggedPhrases = new Set(flags.map(f => f.phrase.toLowerCase()));

  postEls.forEach(el => {
    const text = el.innerText?.toLowerCase() || "";
    const isHarmful = [...flaggedPhrases].some(p => text.includes(p));
    el.classList.add("s-post-outline");
    el.classList.toggle("s-post-harmful", isHarmful);
    el.classList.toggle("s-post-clean",   !isHarmful);
  });
}

// ── Flags log ─────────────────────────────────────────────────────────────────
function renderLog(flags) {
  const log = document.getElementById("s-log");
  const relevant = flags.filter(f => flagMatchesMode(f, activeMode));

  if (!relevant.length) {
    log.innerHTML = `<div class="s-empty">No flags for this mode</div>`;
    return;
  }

  // Escape HTML to prevent XSS from page content
  const esc = s => s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");

  log.innerHTML = relevant.map(f => `
    <div class="s-flag s-flag-${f.type}">
      <div class="s-flag-type">${esc(f.type.toUpperCase())}</div>
      <div class="s-flag-phrase">"${esc(f.phrase.slice(0,90))}${f.phrase.length>90?"…":""}"</div>
      <div class="s-flag-why">${esc(buildTip(f))}</div>
      ${f.score ? `<div class="s-flag-score">Confidence: ${Math.round(f.score*100)}%</div>` : ""}
    </div>
  `).join("");
}

function refilterLog() { renderLog(lastFlags); }

// ── Status ────────────────────────────────────────────────────────────────────
function setStatus(msg) {
  const el = document.getElementById("s-status");
  if (el) el.textContent = msg;
}

// ── MutationObserver — pauses during DOM edits to prevent infinite loop ───────
// Bug fix: old observer fired on every highlight insertion → triggered
// another scan → which injected more highlights → infinite loop → blinking
const observer = new MutationObserver(() => {
  if (observerPaused) return;  // ← key fix
  if (!activeMode) return;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => runScan(false), DEBOUNCE_MS);
});

// ── Init ──────────────────────────────────────────────────────────────────────
injectUI();
observer.observe(document.body, { childList: true, subtree: true });
