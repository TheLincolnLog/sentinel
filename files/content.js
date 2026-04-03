// content.js — Sentinel
// Extracts visible text, sends to backend, highlights flagged phrases

const API_URL = "http://localhost:8000/api/analyze-text";
const MAX_CHARS = 3000;   // cap per request to avoid huge payloads
const DEBOUNCE_MS = 1500; // wait before re-analyzing after DOM changes

// ── Colour mapping by flag type ──────────────────────────────────────────────
const TYPE_CLASS = {
  manipulation: "sentinel-yellow",
  toxicity:     "sentinel-red",
  misinfo:      "sentinel-blue",
};

const TYPE_LABEL = {
  manipulation: "Manipulation detected",
  toxicity:     "Toxic language detected",
  misinfo:      "Misinformation risk",
};

// ── Extract visible text nodes (skip scripts, styles, iframes) ───────────────
function getVisibleText() {
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        const tag = parent.tagName;
        if (["SCRIPT","STYLE","NOSCRIPT","TEXTAREA"].includes(tag))
          return NodeFilter.FILTER_REJECT;
        if (parent.closest(".sentinel-highlight"))
          return NodeFilter.FILTER_REJECT;  // skip already-highlighted nodes
        const text = node.textContent.trim();
        if (!text) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );

  const nodes = [];
  let totalChars = 0;
  let node;
  while ((node = walker.nextNode())) {
    nodes.push(node);
    totalChars += node.textContent.length;
    if (totalChars >= MAX_CHARS) break;
  }
  return nodes;
}

// ── Highlight a single text node for one flagged phrase ──────────────────────
function highlightInNode(textNode, phrase, cssClass, reason) {
  const text = textNode.textContent;
  const idx  = text.toLowerCase().indexOf(phrase.toLowerCase());
  if (idx === -1) return false;

  const before = document.createTextNode(text.slice(0, idx));
  const match  = text.slice(idx, idx + phrase.length);
  const after  = document.createTextNode(text.slice(idx + phrase.length));

  const span = document.createElement("span");
  span.className = `sentinel-highlight ${cssClass}`;
  span.textContent = match;
  span.dataset.reason = reason;

  // Tooltip
  const tooltip = document.createElement("span");
  tooltip.className = "sentinel-tooltip";
  tooltip.textContent = reason;
  span.appendChild(tooltip);

  const parent = textNode.parentNode;
  parent.insertBefore(before, textNode);
  parent.insertBefore(span, textNode);
  parent.insertBefore(after, textNode);
  parent.removeChild(textNode);
  return true;
}

// ── Walk all visible text nodes and apply highlights ─────────────────────────
function applyHighlights(flags) {
  if (!flags || flags.length === 0) return;

  const textNodes = getVisibleText();

  for (const flag of flags) {
    const cssClass = TYPE_CLASS[flag.type] || "sentinel-yellow";
    const reason   = TYPE_LABEL[flag.type]  || "Flagged content";
    const fullReason = `${reason}: "${flag.phrase}"`;

    for (const node of textNodes) {
      highlightInNode(node, flag.phrase, cssClass, fullReason);
    }
  }
}

// ── Call backend ──────────────────────────────────────────────────────────────
async function analyze() {
  const textNodes = getVisibleText();
  const text = textNodes.map(n => n.textContent).join(" ").slice(0, MAX_CHARS);

  if (text.trim().length < 20) return; // nothing meaningful to analyze

  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) return;
    const data = await res.json();
    applyHighlights(data.flags);

    // Store scores for popup to read
    chrome.storage.local?.set({
      sentinelScores: {
        toxicity:     data.toxicity,
        manipulation: data.manipulation,
        misinfo:      data.misinfo,
        url:          location.href,
      }
    });
  } catch (e) {
    // Backend not running — fail silently
  }
}

// ── Debounced run on DOM changes (handles SPAs) ───────────────────────────────
let debounceTimer = null;
const observer = new MutationObserver(() => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(analyze, DEBOUNCE_MS);
});
observer.observe(document.body, { childList: true, subtree: true });

// Initial run
analyze();
