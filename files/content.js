// content.js — Sentinel v7
// New: Social media creator scanner with inline post banners
// Analyzes creator bio, caption, hashtags, comments for harmful habit promotion

const API_URL         = "https://projectoverlay.onrender.com/api/analyze-text";
const CREATOR_API_URL = "https://projectoverlay.onrender.com/api/analyze-creator";
const DASHBOARD_URL   = "http://localhost:3000";
const MAX_CHARS       = 5000;
const DEBOUNCE_MS     = 2500;
const CACHE_TTL_MS    = 5 * 60 * 1000; // 5 minutes

// ── State ─────────────────────────────────────────────────────────────────────
let activeMode      = null;
let sidebarOpen     = false;
let lastFlags       = [];
let lastPageSelection = null;
let debounceTimer   = null;
let isScanning      = false;
let observerPaused  = false;
let imageDetectOn   = false;
let textAiOn        = false;

// Scan result cache: url+mode → { data, timestamp }
const scanCache = new Map();

// Creator scan state
let creatorScanDone   = false;   // only scan once per page load
let creatorBannerEl   = null;    // reference to injected banner

// ── Dashboard bridge ──────────────────────────────────────────────────────────
let dashChannel = null;
try {
  dashChannel = new BroadcastChannel("sentinel-dashboard");
} catch(e) {
  console.warn("[Sentinel] BroadcastChannel not available:", e);
}

function postToDashboard(payload) {
  if (!dashChannel) return;
  try {
    dashChannel.postMessage({ type: "SENTINEL_SCAN", payload });
  } catch(e) {
    console.warn("[Sentinel] BroadcastChannel post failed:", e);
  }
}

// Open dashboard in background tab (once per session)
let dashOpened = false;
function ensureDashboardOpen() {
  if (dashOpened) return;
  dashOpened = true;
  // Use chrome.tabs if available (MV3 service worker context won't have this here,
  // but content scripts can use window.open with noopener)
  try {
    const w = window.open(DASHBOARD_URL, "sentinel-dashboard",
      "noopener,noreferrer,toolbar=0,menubar=0,width=1200,height=800");
    if (!w) {
      // Blocked by popup blocker — that's fine, the broadcast still works
      // if the user already has the tab open
      console.info("[Sentinel] Dashboard auto-open blocked — open manually at", DASHBOARD_URL);
    }
  } catch(e) {}
}

// ── Social media content extractors ──────────────────────────────────────────
const SOCIAL_EXTRACTORS = {
  "youtube.com": extractYouTube,
  "youtu.be":    extractYouTube,
  "instagram.com": extractInstagram,
  "tiktok.com":  extractTikTok,
  "discord.com": extractDiscord,
  "reddit.com":  extractReddit,
  "twitter.com": extractTwitter,
  "x.com":       extractTwitter,
  "threads.net": extractThreads,
};

function getExtractor() {
  const host = location.hostname.replace(/^www\./, "");
  for (const [domain, fn] of Object.entries(SOCIAL_EXTRACTORS)) {
    if (host.includes(domain)) return fn;
  }
  return null;
}

function extractYouTube() {
  const isShort = location.pathname.startsWith("/shorts");

  const title = (
    document.querySelector("#above-the-fold #title h1")?.textContent ||
    document.querySelector("yt-formatted-string.ytd-watch-metadata")?.textContent ||
    document.querySelector(".reel-player-overlay-renderer h2")?.textContent ||
    document.title.replace(" - YouTube", "")
  )?.trim();

  const description = (
    document.querySelector("#description-inline-expander")?.textContent ||
    document.querySelector("#snippet-text")?.textContent ||
    ""
  )?.trim().slice(0, 500);

  const channelName = (
    document.querySelector("#channel-name a")?.textContent ||
    document.querySelector("ytd-channel-name a")?.textContent ||
    ""
  )?.trim();

  // Bio / about snippet shown under video
  const channelBio = (
    document.querySelector("#description-container")?.textContent ||
    document.querySelector("ytd-channel-about-metadata-renderer #description-container")?.textContent ||
    ""
  )?.trim().slice(0, 300);

  // Subscriber count as a theme signal
  const subCount = (
    document.querySelector("#owner-sub-count")?.textContent ||
    document.querySelector("yt-formatted-string#subscribers")?.textContent ||
    ""
  )?.trim();

  // Hashtags in description
  const hashtags = [...(description + " " + title).matchAll(/#\w+/g)]
    .map(m => m[0]).slice(0, 15).join(" ");

  const comments = [...document.querySelectorAll("#content-text")]
    .slice(0, 10)
    .map(el => el.textContent?.trim())
    .filter(Boolean)
    .join("\n");

  // Infer channel theme from title + description + hashtags
  const themeText = [title, description, hashtags].join(" ").toLowerCase();
  const theme = inferTheme(themeText);

  return {
    contentType:  isShort ? "short" : "post",
    contentTitle: title,
    text: [title, description, channelName, comments].filter(Boolean).join("\n"),
    platform: "youtube",
    // Creator profile fields
    creator_name: channelName,
    bio:          channelBio || description.slice(0, 200),
    caption:      title,
    hashtags,
    theme,
    comments,
  };
}

function extractInstagram() {
  const isReel = location.pathname.startsWith("/reel");

  const caption = (
    document.querySelector("h1")?.textContent ||
    document.querySelector("[class*='Caption']")?.textContent ||
    document.querySelector("article span")?.textContent ||
    ""
  )?.trim().slice(0, 500);

  const creatorHandle = (
    document.querySelector("header a[href*='/']")?.textContent ||
    document.querySelector("[class*='Username']")?.textContent ||
    ""
  )?.trim();

  // Bio visible on post page (shown in header area)
  const bio = (
    document.querySelector("[class*='Biography']")?.textContent ||
    document.querySelector("header section > div > span")?.textContent ||
    ""
  )?.trim().slice(0, 300);

  const hashtags = [...caption.matchAll(/#\w+/g)]
    .map(m => m[0]).slice(0, 15).join(" ");

  const altTexts = [...document.querySelectorAll("img[alt]")]
    .filter(img => !img.closest("#sentinel-root"))
    .map(img => img.alt)
    .filter(a => a && a.length > 10)
    .slice(0, 3)
    .join(" ");

  const comments = [...document.querySelectorAll("[class*='CommentContent'], ul li span")]
    .slice(0, 8)
    .map(el => el.textContent?.trim())
    .filter(Boolean)
    .join("\n");

  const themeText = [caption, hashtags, bio].join(" ").toLowerCase();
  const theme = inferTheme(themeText);

  return {
    contentType:  isReel ? "reel" : "post",
    contentTitle: caption.slice(0, 100),
    text: [caption, altTexts, comments].filter(Boolean).join("\n"),
    platform: "instagram",
    creator_name: creatorHandle,
    bio,
    caption,
    hashtags,
    theme,
    comments,
  };
}

function extractTikTok() {
  const desc = (
    document.querySelector('[data-e2e="browse-video-desc"]')?.textContent ||
    document.querySelector('[class*="video-desc"]')?.textContent ||
    document.querySelector("h1")?.textContent ||
    ""
  )?.trim();

  const author = (
    document.querySelector('[data-e2e="browse-username"]')?.textContent ||
    document.querySelector('[class*="author-uniqueId"]')?.textContent ||
    ""
  )?.trim();

  // Bio from author panel
  const bio = (
    document.querySelector('[data-e2e="user-bio"]')?.textContent ||
    document.querySelector('[class*="user-bio"]')?.textContent ||
    ""
  )?.trim().slice(0, 300);

  const hashtags = [...desc.matchAll(/#\w+/g)]
    .map(m => m[0]).slice(0, 15).join(" ");

  const comments = [...document.querySelectorAll('[data-e2e="comment-level-1"] p, [class*="comment-text"]')]
    .slice(0, 10)
    .map(el => el.textContent?.trim())
    .filter(Boolean)
    .join("\n");

  const themeText = [desc, hashtags, bio].join(" ").toLowerCase();
  const theme = inferTheme(themeText);

  return {
    contentType:  "short",
    contentTitle: desc?.slice(0, 100),
    text: [desc, author ? `By @${author}` : "", comments].filter(Boolean).join("\n"),
    platform: "tiktok",
    creator_name: author,
    bio,
    caption: desc,
    hashtags,
    theme,
    comments,
  };
}

function extractDiscord() {
  // Get all visible messages
  const messages = [...document.querySelectorAll('[class*="messageContent"]')]
    .slice(0, 30)
    .map(el => el.textContent?.trim())
    .filter(Boolean);

  const channelName = (
    document.querySelector('[class*="channelName"]')?.textContent ||
    document.title
  )?.trim();

  return {
    contentType: "message",
    contentTitle: channelName?.slice(0, 80),
    text: messages.join("\n"),
    platform: "discord",
  };
}

function extractReddit() {
  const isPost = location.pathname.includes("/comments/");
  const title = (
    document.querySelector('[data-test-id="post-content"] h1')?.textContent ||
    document.querySelector("h1")?.textContent ||
    document.title.replace(" : reddit", "").replace(" • r/", " r/")
  )?.trim();

  const body = (
    document.querySelector('[data-click-id="text"] .md')?.textContent ||
    document.querySelector("[slot='text-body']")?.textContent ||
    ""
  )?.trim().slice(0, 800);

  const comments = [...document.querySelectorAll('[data-testid="comment"] p, shreddit-comment p')]
    .slice(0, 15)
    .map(el => el.textContent?.trim())
    .filter(Boolean)
    .join("\n");

  return {
    contentType: "post",
    contentTitle: title?.slice(0, 120),
    text: [title, body, comments].filter(Boolean).join("\n"),
    platform: "reddit",
  };
}

function extractTwitter() {
  const tweets = [...document.querySelectorAll('[data-testid="tweetText"]')]
    .slice(0, 20)
    .map(el => el.textContent?.trim())
    .filter(Boolean);

  const firstTweet = tweets[0];
  return {
    contentType: "post",
    contentTitle: firstTweet?.slice(0, 100),
    text: tweets.join("\n"),
    platform: location.hostname.includes("twitter") ? "twitter" : "twitter",
  };
}

function extractThreads() {
  const posts = [...document.querySelectorAll('[data-pressable-container] span')]
    .slice(0, 20)
    .map(el => el.textContent?.trim())
    .filter(Boolean);
  return {
    contentType: "post",
    contentTitle: posts[0]?.slice(0, 100),
    text: posts.join("\n"),
    platform: "unknown",
  };
}

// ── Theme inference (fast local pass) ────────────────────────────────────────
function inferTheme(text) {
  const t = text.toLowerCase();
  if (/\b(diet|weight loss|calories|keto|fasting|fitness|gym|workout|shred|bulk|lean|muscle|protein)\b/.test(t)) return "fitness / diet";
  if (/\b(crypto|bitcoin|nft|invest|trading|forex|stocks|passive income|financial freedom|make money)\b/.test(t)) return "finance / crypto";
  if (/\b(gambling|casino|betting|slots|poker|odds|wager)\b/.test(t)) return "gambling";
  if (/\b(alcohol|drinking|party|nightlife|drunk|shots|hangover)\b/.test(t)) return "nightlife / alcohol";
  if (/\b(mental health|anxiety|depression|therapy|self-love|healing|trauma|mindset)\b/.test(t)) return "mental health / wellness";
  if (/\b(beauty|makeup|skincare|fashion|style|outfit|aesthetic)\b/.test(t)) return "beauty / fashion";
  if (/\b(gaming|twitch|stream|esports|minecraft|fortnite|valorant)\b/.test(t)) return "gaming";
  if (/\b(politics|news|current events|government|election|liberal|conservative)\b/.test(t)) return "politics / news";
  if (/\b(comedy|funny|memes|humor|satire|prank|skit)\b/.test(t)) return "comedy / entertainment";
  if (/\b(food|recipe|cooking|restaurant|chef|baking|meal prep)\b/.test(t)) return "food";
  if (/\b(travel|vlog|adventure|explore|destination|trip)\b/.test(t)) return "travel / lifestyle";
  return "general / unknown";
}

// ── Creator health scan ───────────────────────────────────────────────────────
const creatorScanCache = new Map(); // creatorName+platform → { data, timestamp }

async function runCreatorScan(extracted) {
  // Only run on social media platforms with enough data
  const socialPlatforms = ["youtube", "instagram", "tiktok", "twitter", "reddit", "tiktok", "threads"];
  if (!socialPlatforms.includes(extracted.platform)) return;
  if (!extracted.caption && !extracted.bio && !extracted.creator_name) return;
  if (creatorScanDone) return;
  creatorScanDone = true;

  // Cache by post details so different posts from the same creator get their own safety score.
  const cacheKey = `${location.href}:${extracted.creator_name}:${extracted.platform}:${(extracted.caption || extracted.contentTitle || "").slice(0, 120)}`;
  const cached = creatorScanCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    injectCreatorBanner(cached.data, extracted);
    return;
  }

  try {
    const res = await fetch(CREATOR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        platform:     extracted.platform,
        creator_name: extracted.creator_name || "",
        bio:          extracted.bio          || "",
        caption:      extracted.caption      || "",
        hashtags:     extracted.hashtags     || "",
        theme:        extracted.theme        || "",
        comments:     extracted.comments     || "",
        url:          location.href,
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    creatorScanCache.set(cacheKey, { data, timestamp: Date.now() });
    injectCreatorBanner(data, extracted);

    // Also post to dashboard social alerts tab
    postToDashboard({
      type:           "CREATOR_SCAN",
      platform:       extracted.platform,
      pageUrl:        location.href,
      pageTitle:      document.title,
      creator_name:   extracted.creator_name,
      creator_theme:  data.creator_theme,
      overall_health: data.overall_health,
      health_score:   data.health_score,
      post_safety_score: data.post_safety_score,
      post_summary:   data.post_summary,
      scanned_details: data.scanned_details,
      risk_breakdown: data.risk_breakdown,
      evidence:       data.evidence,
      summary:        data.summary,
      recommendation: data.recommendation,
      flags:          data.flags,
      habits_promoted: data.habits_promoted,
    });
  } catch(e) {
    console.warn("[Sentinel] Creator scan failed:", e);
  }
}

// ── Inline banner injector ────────────────────────────────────────────────────
function sEscapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch]));
}

function sSeverityMeta(severity, score = 0) {
  const sev = severity || (score > 65 ? "high" : score > 35 ? "medium" : score > 12 ? "low" : "none");
  return {
    high:   { label: "High",   color: "#DC2626", bg: "#FEF2F2", border: "#FCA5A5" },
    medium: { label: "Medium", color: "#D97706", bg: "#FFFBEB", border: "#FCD34D" },
    low:    { label: "Low",    color: "#4F46E5", bg: "#EEF2FF", border: "#C7D2FE" },
    none:   { label: "Clear",  color: "#059669", bg: "#ECFDF5", border: "#A7F3D0" },
  }[sev] || { label: "Clear", color: "#059669", bg: "#ECFDF5", border: "#A7F3D0" };
}

function buildPostRiskBreakdown(data, flags) {
  if (Array.isArray(data.risk_breakdown) && data.risk_breakdown.length) {
    return data.risk_breakdown.slice(0, 4);
  }
  const flagValues = Object.values(flags || {}).filter(Boolean);
  const scoreFor = key => {
    const item = flagValues.find(v => String(v.detail || "").toLowerCase().includes(key));
    if (!item?.detected) return 0;
    return item.severity === "high" ? 82 : item.severity === "medium" ? 54 : 26;
  };
  return [
    { label: "Scam / phishing", score: scoreFor("scam"), severity: "none", detail: "Checked for payment pressure, prize hooks, and credential requests." },
    { label: "Toxicity / bullying", score: scoreFor("mental"), severity: "none", detail: "Checked visible comments and caption for harassment patterns." },
    { label: "Misinformation", score: 0, severity: "none", detail: "Checked for unsupported certainty and misleading claim patterns." },
    { label: "Harmful habits", score: Math.max(scoreFor("diet"), scoreFor("addiction")), severity: "none", detail: "Checked whether the post promotes unsafe behavior." },
  ];
}

function injectCreatorBannerLegacy(data, extracted) {
  // Remove any existing banner
  document.getElementById("sentinel-creator-banner")?.remove();
  creatorBannerEl = null;

  const health    = data.overall_health || "caution";
  const score     = data.health_score   ?? 50;
  const summary   = data.summary        || "";
  const rec       = data.recommendation || "";
  const theme     = data.creator_theme  || extracted.theme || "";
  const habits    = (data.habits_promoted || []).slice(0, 4);
  const flags     = data.flags          || {};
  const creator   = extracted.creator_name || "This creator";

  const colorMap = {
    healthy: { bar: "#22c55e", bg: "#f0fdf4", border: "#bbf7d0", text: "#15803d", icon: "✅", label: "HEALTHY CONTENT" },
    caution: { bar: "#f59e0b", bg: "#fffbeb", border: "#fde68a", text: "#b45309", icon: "⚠️", label: "USE CAUTION" },
    harmful: { bar: "#ef4444", bg: "#fef2f2", border: "#fecaca", text: "#b91c1c", icon: "🚨", label: "POTENTIALLY HARMFUL" },
  };
  const c = colorMap[health] || colorMap.caution;

  // Active flags with detail
  const FLAG_LABELS = {
    dangerous_diet_fitness: "🥗 Diet / Fitness Advice",
    financial_scam:         "💸 Financial / Scam Risk",
    addiction_promotion:    "🎰 Addiction-Promoting",
    mental_health_harm:     "🧠 Mental Health Harm",
  };
  const activeFlags = Object.entries(flags)
    .filter(([, v]) => v.detected && v.severity !== "none")
    .map(([k, v]) => ({
      label:    FLAG_LABELS[k] || k,
      severity: v.severity,
      detail:   v.detail || "",
    }));

  const severityDot = s => ({
    high:   '<span style="color:#ef4444;font-weight:700">●</span>',
    medium: '<span style="color:#f59e0b;font-weight:700">●</span>',
    low:    '<span style="color:#3b82f6;font-weight:700">●</span>',
  }[s] || "");

  const habitsHtml = habits.length
    ? `<div style="display:flex;flex-wrap:wrap;gap:5px;margin-top:6px">
        ${habits.map(h => `<span style="font-size:10px;padding:2px 8px;border-radius:99px;background:${c.border};color:${c.text};font-weight:600">${h}</span>`).join("")}
       </div>`
    : "";

  const flagsHtml = activeFlags.length
    ? `<div style="margin-top:8px;display:flex;flex-direction:column;gap:4px">
        ${activeFlags.map(f => `
          <div style="font-size:10px;display:flex;align-items:flex-start;gap:6px">
            ${severityDot(f.severity)}
            <span><strong>${f.label}</strong>${f.detail ? ` — ${f.detail}` : ""}</span>
          </div>`).join("")}
       </div>`
    : "";

  const geminiTag = data.gemini_active
    ? `<span style="font-size:9px;font-weight:700;padding:1px 6px;border-radius:99px;background:#dbeafe;color:#1d4ed8;margin-left:6px">⚡ AI Enhanced</span>`
    : `<span style="font-size:9px;font-weight:700;padding:1px 6px;border-radius:99px;background:#f3f4f6;color:#6b7280;margin-left:6px">ML</span>`;

  const banner = document.createElement("div");
  banner.id = "sentinel-creator-banner";
  banner.setAttribute("data-sentinel", "true");
  banner.style.cssText = `
    all: initial;
    display: block;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    box-sizing: border-box;
    margin: 10px 0;
    border-radius: 12px;
    border: 1.5px solid ${c.border};
    background: ${c.bg};
    overflow: hidden;
    z-index: 9998;
    animation: sentinelFadeIn 0.3s ease;
  `;

  banner.innerHTML = `
    <style>
      @keyframes sentinelFadeIn { from { opacity:0; transform:translateY(-4px); } to { opacity:1; transform:translateY(0); } }
      #sentinel-creator-banner * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
      #sentinel-creator-banner .s-cb-toggle { cursor:pointer; user-select:none; }
      #sentinel-creator-banner .s-cb-body { overflow:hidden; transition: max-height 0.3s ease; max-height: 0; }
      #sentinel-creator-banner .s-cb-body.open { max-height: 400px; }
    </style>

    <!-- Header row (always visible) -->
    <div class="s-cb-toggle" style="display:flex;align-items:center;gap:10px;padding:10px 14px;cursor:pointer"
         onclick="this.closest('#sentinel-creator-banner').querySelector('.s-cb-body').classList.toggle('open');
                  this.querySelector('.s-cb-chevron').style.transform = this.closest('#sentinel-creator-banner').querySelector('.s-cb-body').classList.contains('open') ? 'rotate(90deg)' : 'rotate(0deg)'">

      <!-- Health score ring -->
      <div style="position:relative;width:38px;height:38px;shrink:0">
        <svg width="38" height="38" viewBox="0 0 38 38">
          <circle cx="19" cy="19" r="15" fill="none" stroke="#e5e7eb" stroke-width="4"/>
          <circle cx="19" cy="19" r="15" fill="none" stroke="${c.bar}" stroke-width="4"
            stroke-dasharray="${Math.round(score * 0.942)} 94.2"
            stroke-linecap="round" transform="rotate(-90 19 19)"/>
        </svg>
        <span style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:800;color:${c.text}">${score}</span>
      </div>

      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap">
          <span style="font-size:10px;font-weight:800;letter-spacing:0.08em;color:${c.text}">${c.icon} ${c.label}</span>
          ${geminiTag}
        </div>
        <div style="font-size:10px;color:#6b7280;margin-top:1px">
          <strong style="color:#374151">${creator}</strong>${theme ? ` · ${theme}` : ""}
        </div>
      </div>

      <div style="display:flex;align-items:center;gap:6px">
        ${activeFlags.length ? `<span style="font-size:9px;font-weight:700;padding:2px 7px;border-radius:99px;background:${c.bar};color:#fff">${activeFlags.length} flag${activeFlags.length > 1 ? "s" : ""}</span>` : ""}
        <svg class="s-cb-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="${c.text}" stroke-width="2.5" stroke-linecap="round" style="transition:transform 0.2s;flex-shrink:0">
          <polyline points="9 18 15 12 9 6"/>
        </svg>
      </div>
    </div>

    <!-- Expandable body -->
    <div class="s-cb-body">
      <div style="padding:0 14px 12px;border-top:1px solid ${c.border}">

        ${habitsHtml ? `<div style="margin-top:10px"><div style="font-size:9px;font-weight:700;letter-spacing:0.1em;color:#9ca3af;margin-bottom:2px">HABITS PROMOTED</div>${habitsHtml}</div>` : ""}

        ${flagsHtml ? `<div style="margin-top:10px"><div style="font-size:9px;font-weight:700;letter-spacing:0.1em;color:#9ca3af;margin-bottom:4px">CONCERNS DETECTED</div>${flagsHtml}</div>` : ""}

        <div style="margin-top:10px">
          <div style="font-size:9px;font-weight:700;letter-spacing:0.1em;color:#9ca3af;margin-bottom:3px">ANALYSIS</div>
          <p style="font-size:11px;color:#374151;line-height:1.5;margin:0">${summary}</p>
        </div>

        ${rec ? `<div style="margin-top:8px;padding:7px 10px;border-radius:8px;background:rgba(0,0,0,0.04);font-size:10px;color:#6b7280;line-height:1.4">
          💡 ${rec}
        </div>` : ""}

        <div style="margin-top:8px;text-align:right;font-size:8px;color:#d1d5db">Sentinel · Creator Safety Scanner</div>
      </div>
    </div>
  `;

  // Inject banner after the post's primary content block
  const insertTarget = findPostInsertionPoint(extracted.platform);
  if (insertTarget) {
    insertTarget.parentNode.insertBefore(banner, insertTarget.nextSibling);
  } else {
    // Fallback: fixed bottom-right corner
    banner.style.position  = "fixed";
    banner.style.bottom    = "80px";
    banner.style.right     = "20px";
    banner.style.width     = "340px";
    banner.style.zIndex    = "99999";
    banner.style.boxShadow = "0 8px 32px rgba(0,0,0,0.15)";
    document.body.appendChild(banner);
  }
  creatorBannerEl = banner;
}

function injectCreatorBanner(data, extracted) {
  document.getElementById("sentinel-creator-banner")?.remove();
  creatorBannerEl = null;

  const health = data.overall_health || "caution";
  const score = Math.max(0, Math.min(100, Number(data.post_safety_score ?? data.health_score ?? 50)));
  const riskScore = 100 - score;
  const scoreMeta = sSeverityMeta(health === "harmful" ? "high" : health === "caution" ? "medium" : "none", riskScore);
  const creator = extracted.creator_name || data.scanned_details?.creator || "This creator";
  const platform = extracted.platform || data.scanned_details?.platform || "social";
  const theme = data.creator_theme || extracted.theme || data.scanned_details?.topic || "general";
  const summary = data.post_summary || data.summary || "Sentinel scanned the post details and visible discussion for safety signals.";
  const recommendation = data.recommendation || "Review the signals before acting on this post.";
  const flags = data.flags || {};
  const risks = buildPostRiskBreakdown(data, flags);
  const evidence = Array.isArray(data.evidence) ? data.evidence.slice(0, 4) : [];
  const habits = (data.habits_promoted || []).slice(0, 4);
  const signals = data.scanned_details?.signals_checked || ["caption", "profile", "hashtags", "comments"];
  const activeCount = risks.filter(r => (r.severity && r.severity !== "none") || Number(r.score || 0) > 12).length;

  const riskRows = risks.map(r => {
    const pct = Math.max(0, Math.min(100, Number(r.score || 0)));
    const meta = sSeverityMeta(r.severity, pct);
    return `
      <div class="s-post-risk-row">
        <div class="s-post-risk-top">
          <span>${sEscapeHtml(r.label)}</span>
          <span style="color:${meta.color};background:${meta.bg};border-color:${meta.border}">${meta.label}</span>
        </div>
        <div class="s-post-risk-track"><div style="width:${pct}%;background:${meta.color}"></div></div>
        <div class="s-post-risk-detail">${sEscapeHtml(r.detail || "No notable signal in this category.")}</div>
      </div>`;
  }).join("");

  const evidenceHtml = evidence.length
    ? evidence.map(e => `
        <div class="s-post-evidence">
          <div>${sEscapeHtml(e.quote || e.phrase || "")}</div>
          <span>${sEscapeHtml(e.reason || e.type || "Signal reviewed")}</span>
        </div>`).join("")
    : `<div class="s-post-empty">No strong evidence snippets were found in the visible post details.</div>`;

  const habitHtml = habits.length
    ? `<div class="s-post-chip-row">${habits.map(h => `<span>${sEscapeHtml(h)}</span>`).join("")}</div>`
    : "";

  const banner = document.createElement("div");
  banner.id = "sentinel-creator-banner";
  banner.setAttribute("data-sentinel", "true");
  banner.style.cssText = `
    all: initial;
    display: block;
    box-sizing: border-box;
    margin: 12px 0;
    width: min(420px, 100%);
    font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    color: #111827;
    border: 1px solid #E5E7EB;
    border-radius: 12px;
    background: #FFFFFF;
    box-shadow: 0 12px 30px rgba(17,24,39,0.12);
    overflow: hidden;
    z-index: 9998;
    animation: sentinelFadeIn 0.25s ease;
  `;

  banner.innerHTML = `
    <style>
      @keyframes sentinelFadeIn { from { opacity:0; transform:translateY(-6px); } to { opacity:1; transform:translateY(0); } }
      #sentinel-creator-banner, #sentinel-creator-banner * { box-sizing: border-box; font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
      #sentinel-creator-banner .s-post-top { padding: 14px; background: linear-gradient(180deg, #F9FAFB 0%, #FFFFFF 100%); border-bottom: 1px solid #E5E7EB; }
      #sentinel-creator-banner .s-post-head { display:flex; align-items:center; gap:12px; cursor:pointer; user-select:none; }
      #sentinel-creator-banner .s-post-score { position:relative; width:58px; height:58px; flex-shrink:0; }
      #sentinel-creator-banner .s-post-score svg { transform: rotate(-90deg); }
      #sentinel-creator-banner .s-post-score-num { position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; color:${scoreMeta.color}; }
      #sentinel-creator-banner .s-post-score-num strong { font-size:18px; line-height:1; }
      #sentinel-creator-banner .s-post-score-num span { font-size:7px; letter-spacing:.08em; font-weight:800; color:#6B7280; }
      #sentinel-creator-banner .s-post-title { flex:1; min-width:0; }
      #sentinel-creator-banner .s-post-kicker { display:flex; align-items:center; gap:6px; flex-wrap:wrap; font-size:9px; font-weight:800; letter-spacing:.08em; color:${scoreMeta.color}; text-transform:uppercase; }
      #sentinel-creator-banner .s-post-pill { padding:2px 7px; border-radius:999px; background:${scoreMeta.bg}; border:1px solid ${scoreMeta.border}; color:${scoreMeta.color}; }
      #sentinel-creator-banner .s-post-name { margin-top:4px; font-size:13px; font-weight:750; color:#111827; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      #sentinel-creator-banner .s-post-sub { margin-top:2px; font-size:10px; color:#6B7280; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      #sentinel-creator-banner .s-post-chevron { transition: transform .18s ease; flex-shrink:0; color:#6B7280; }
      #sentinel-creator-banner .s-post-body { max-height:0; overflow:hidden; transition:max-height .25s ease; }
      #sentinel-creator-banner .s-post-body.open { max-height:720px; }
      #sentinel-creator-banner .s-post-section { padding:12px 14px; border-top:1px solid #F3F4F6; }
      #sentinel-creator-banner .s-post-label { font-size:9px; font-weight:800; letter-spacing:.1em; color:#9CA3AF; text-transform:uppercase; margin-bottom:7px; }
      #sentinel-creator-banner .s-post-summary { font-size:12px; color:#374151; line-height:1.55; margin:0; }
      #sentinel-creator-banner .s-post-scanline { display:flex; flex-wrap:wrap; gap:5px; margin-top:9px; }
      #sentinel-creator-banner .s-post-scanline span, #sentinel-creator-banner .s-post-chip-row span { font-size:10px; font-weight:650; color:#374151; background:#F3F4F6; border:1px solid #E5E7EB; border-radius:999px; padding:3px 8px; }
      #sentinel-creator-banner .s-post-risk-row { margin-bottom:10px; }
      #sentinel-creator-banner .s-post-risk-row:last-child { margin-bottom:0; }
      #sentinel-creator-banner .s-post-risk-top { display:flex; justify-content:space-between; gap:8px; font-size:11px; font-weight:700; color:#374151; margin-bottom:5px; }
      #sentinel-creator-banner .s-post-risk-top span:last-child { font-size:9px; padding:1px 6px; border:1px solid; border-radius:999px; text-transform:uppercase; letter-spacing:.05em; }
      #sentinel-creator-banner .s-post-risk-track { height:6px; background:#E5E7EB; border-radius:999px; overflow:hidden; }
      #sentinel-creator-banner .s-post-risk-track div { height:100%; border-radius:999px; }
      #sentinel-creator-banner .s-post-risk-detail { margin-top:4px; font-size:10px; line-height:1.45; color:#6B7280; }
      #sentinel-creator-banner .s-post-evidence { border:1px solid #E5E7EB; background:#F9FAFB; border-radius:8px; padding:8px; margin-bottom:6px; }
      #sentinel-creator-banner .s-post-evidence div { font-size:11px; color:#374151; line-height:1.4; font-style:italic; }
      #sentinel-creator-banner .s-post-evidence span, #sentinel-creator-banner .s-post-empty { display:block; margin-top:4px; font-size:10px; color:#6B7280; line-height:1.4; }
      #sentinel-creator-banner .s-post-rec { margin-top:8px; padding:9px 10px; border-radius:8px; background:${scoreMeta.bg}; border:1px solid ${scoreMeta.border}; color:#374151; font-size:11px; line-height:1.45; }
      #sentinel-creator-banner .s-post-foot { padding:9px 14px 11px; display:flex; justify-content:space-between; align-items:center; font-size:9px; color:#9CA3AF; background:#F9FAFB; }
    </style>
    <div class="s-post-top">
      <div class="s-post-head" role="button" tabindex="0">
        <div class="s-post-score">
          <svg width="58" height="58" viewBox="0 0 58 58">
            <circle cx="29" cy="29" r="23" fill="none" stroke="#E5E7EB" stroke-width="7"/>
            <circle cx="29" cy="29" r="23" fill="none" stroke="${scoreMeta.color}" stroke-width="7" stroke-linecap="round"
              stroke-dasharray="${Math.round(score * 1.445)} 144.5"/>
          </svg>
          <div class="s-post-score-num"><strong>${Math.round(score)}</strong><span>SAFE</span></div>
        </div>
        <div class="s-post-title">
          <div class="s-post-kicker">
            <span>Post safety scan</span>
            <span class="s-post-pill">${scoreMeta.label} risk</span>
            ${data.gemini_active ? `<span class="s-post-pill">AI enhanced</span>` : `<span class="s-post-pill">Local scan</span>`}
          </div>
          <div class="s-post-name">${sEscapeHtml(creator)}</div>
          <div class="s-post-sub">${sEscapeHtml(platform)} · ${sEscapeHtml(theme)} · ${activeCount} active signal${activeCount === 1 ? "" : "s"}</div>
        </div>
        <svg class="s-post-chevron" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
      </div>
    </div>
    <div class="s-post-body open">
      <div class="s-post-section">
        <div class="s-post-label">Summary</div>
        <p class="s-post-summary">${sEscapeHtml(summary)}</p>
        <div class="s-post-scanline">${signals.map(s => `<span>${sEscapeHtml(s)}</span>`).join("")}</div>
      </div>
      ${habitHtml ? `<div class="s-post-section"><div class="s-post-label">Habits or Behaviors Promoted</div>${habitHtml}</div>` : ""}
      <div class="s-post-section">
        <div class="s-post-label">Risk Breakdown</div>
        ${riskRows}
      </div>
      <div class="s-post-section">
        <div class="s-post-label">Evidence</div>
        ${evidenceHtml}
        <div class="s-post-rec">${sEscapeHtml(recommendation)}</div>
      </div>
      <div class="s-post-foot"><span>Sentinel social post scanner</span><span>${sEscapeHtml(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))}</span></div>
    </div>
  `;

  const header = banner.querySelector(".s-post-head");
  const body = banner.querySelector(".s-post-body");
  const chevron = banner.querySelector(".s-post-chevron");
  const toggle = () => {
    body.classList.toggle("open");
    chevron.style.transform = body.classList.contains("open") ? "rotate(90deg)" : "rotate(0deg)";
  };
  header.addEventListener("click", toggle);
  header.addEventListener("keydown", e => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggle();
    }
  });
  chevron.style.transform = "rotate(90deg)";

  const insertTarget = findPostInsertionPoint(extracted.platform);
  if (insertTarget) {
    insertTarget.parentNode.insertBefore(banner, insertTarget.nextSibling);
  } else {
    banner.style.position = "fixed";
    banner.style.bottom = "84px";
    banner.style.right = "20px";
    banner.style.width = "380px";
    banner.style.maxWidth = "calc(100vw - 40px)";
    banner.style.zIndex = "99999";
    document.body.appendChild(banner);
  }
  creatorBannerEl = banner;
  incrementStat("creators");
}

function findPostInsertionPoint(platform) {
  const selectors = {
    youtube:   ["#above-the-fold", "#primary-inner ytd-watch-metadata", ".ytd-watch-metadata"],
    instagram: ["article div[role='presentation']", "article", "main article"],
    tiktok:    ["[data-e2e='browse-video-desc']", "[class*='DivVideoInfoContainer']", "[class*='video-info']"],
    twitter:   ["[data-testid='tweetText']", "article [lang]"],
    reddit:    ["[data-test-id='post-content']", "shreddit-post", "[slot='text-body']"],
    threads:   ["[data-pressable-container]"],
  };
  const targets = selectors[platform] || [];
  for (const sel of targets) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}
const PLATFORM_SELECTORS = {
  "twitter.com":   '[data-testid="tweetText"]',
  "x.com":         '[data-testid="tweetText"]',
  "reddit.com":    '[data-testid="comment"], [slot="text-body"]',
  "discord.com":   '[class*="messageContent"]',
  "facebook.com":  '[data-ad-comet-preview="message"]',
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
  // Try social media extractor first
  const extractor = getExtractor();
  if (extractor) {
    const social = extractor();
    if (social.text && social.text.length > 10) return social;
  }

  // Generic fallback
  const sel = getPlatformSelector();
  if (sel) {
    const els = [...document.querySelectorAll(sel)]
      .filter(el => !el.closest("#sentinel-root")).slice(0, 40);
    if (els.length) return {
      text: els.map(e => e.innerText?.trim()).filter(Boolean).join("\n\n"),
      elements: els,
      platform: "unknown",
  };
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
function capturePageSelection() {
  const sel = window.getSelection?.();
  const text = sel?.toString().trim();
  if (!text || text.length < 20) return null;
  const anchorEl = sel.anchorNode?.nodeType === Node.TEXT_NODE
    ? sel.anchorNode.parentElement
    : sel.anchorNode;
  if (anchorEl?.closest?.("#sentinel-root, #sentinel-creator-banner")) return null;
  lastPageSelection = {
    text: text.slice(0, MAX_CHARS),
    pageTitle: document.title,
    pageUrl: location.href,
    capturedAt: Date.now(),
  };
  return lastPageSelection;
}

function getSelectionScanTarget(baseExtracted) {
  const current = capturePageSelection();
  const cached = lastPageSelection && Date.now() - lastPageSelection.capturedAt < 30000
    ? lastPageSelection
    : null;
  const selected = current || cached;
  if (!selected) return { extracted: baseExtracted, text: baseExtracted.text, isSelection: false };
  return {
    text: selected.text,
    isSelection: true,
    extracted: {
      ...baseExtracted,
      text: selected.text,
      contentType: "selected text",
      contentTitle: selected.text.slice(0, 90),
      selection: true,
    },
  };
}

function injectUI() {
  if (document.getElementById("sentinel-root")) return;

  // ── Lucide icon SVGs (inline, no external dependency) ────────────────────
  const IC = {
    shield:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`,
    check:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
    x:        `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
    chevLeft: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>`,
    chevRight:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`,
    alertTri: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
    eye:      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`,
    search:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`,
    lock:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>`,
    scan:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg>`,
    settings: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/></svg>`,
    play:     `<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>`,
    trash:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>`,
    image:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`,
    type:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg>`,
    info:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`,
    frown:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M16 16s-1.5-2-4-2-4 2-4 2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>`,
    meh:      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="8" y1="15" x2="16" y2="15"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>`,
    smile:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 13s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>`,
    activity: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>`,
    zap:      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`,
    sparks:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L9.5 9.5 2 12l7.5 2.5L12 22l2.5-7.5L22 12l-7.5-2.5z"/></svg>`,
    link:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>`,
    dashboard:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>`,
    thumbUp:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 9V5a3 3 0 00-3-3l-4 9v11h11.28a2 2 0 002-1.7l1.38-9a2 2 0 00-2-2.3H14z"/><path d="M7 22H4a2 2 0 01-2-2v-7a2 2 0 012-2h3"/></svg>`,
    bell:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></svg>`,
    dollar:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>`,
    cpu:      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/></svg>`,
    clock:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
    mouse:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="7"/><line x1="12" y1="6" x2="12" y2="10"/></svg>`,
    salad:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 21h10"/><path d="M12 21a9 9 0 009-9H3a9 9 0 009 9z"/><path d="M11.38 12a2.4 2.4 0 01-.4-4.77 2.4 2.4 0 013.2-3.19 2.4 2.4 0 013.47-.63 2.4 2.4 0 013.37 3.37 2.4 2.4 0 01-1.1 3.7 2.51 2.51 0 01.03 1.1"/><line x1="13" y1="12" x2="13.01" y2="12"/></svg>`,
    brain:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2A2.5 2.5 0 017 4.5v0A2.5 2.5 0 014.5 7v0A2.5 2.5 0 012 9.5v5A2.5 2.5 0 004.5 17v0A2.5 2.5 0 007 19.5v0A2.5 2.5 0 009.5 22h5a2.5 2.5 0 002.5-2.5v0A2.5 2.5 0 0019.5 17v0A2.5 2.5 0 0022 14.5v-5A2.5 2.5 0 0019.5 7v0A2.5 2.5 0 0017 4.5v0A2.5 2.5 0 0014.5 2z"/></svg>`,
    vote:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>`,
    dice:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="2"/><circle cx="8" cy="8" r="1" fill="currentColor"/><circle cx="16" cy="8" r="1" fill="currentColor"/><circle cx="8" cy="16" r="1" fill="currentColor"/><circle cx="16" cy="16" r="1" fill="currentColor"/></svg>`,
    chart:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>`,
  };

  const root = document.createElement("div");
  root.id = "sentinel-root";
  root.innerHTML = `

    <!-- Toast container -->
    <div id="s-toast-container"></div>

    <!-- Floating bubble -->
    <div id="s-bubble" title="Sentinel">
      <div id="s-bubble-dot"></div>
      ${IC.shield}
    </div>

    <!-- Main panel -->
    <div id="s-panel" class="s-closed">

      <!-- HOME -->
      <div id="s-home" class="s-screen s-active">
        <div class="s-home-header">
          <div class="s-logo-lockup">
            <div class="s-logo-badge">${IC.shield}</div>
            <div>
              <div class="s-brand-name">Sentinel</div>
              <div class="s-brand-tag">YOUR SAFETY COMPANION</div>
            </div>
          </div>
          <div class="s-header-actions">
            <button class="s-dash-btn" id="s-open-dash">${IC.dashboard} Dashboard</button>
            <button class="s-icon-btn" id="s-close">${IC.x}</button>
          </div>
        </div>

        <div class="s-stats-bar">
          <div class="s-stat-item">
            <div class="s-stat-val" id="home-scans-today">0</div>
            <div class="s-stat-lbl">Scans</div>
          </div>
          <div class="s-stat-item">
            <div class="s-stat-val" id="home-flags-total">0</div>
            <div class="s-stat-lbl">Flags</div>
          </div>
          <div class="s-stat-item">
            <div class="s-stat-val" id="home-reactions">0</div>
            <div class="s-stat-lbl">Reactions</div>
          </div>
        </div>

        <div class="s-section-label">Scan Mode</div>

        <div class="s-mode-grid">
          <button class="s-mode-card s-mode-tox" data-mode="toxicity">
            <div class="s-mode-icon-wrap">${IC.alertTri}</div>
            <div class="s-mode-info">
              <div class="s-mode-name">Toxicity Check</div>
              <div class="s-mode-desc">Cyberbullying · Hate speech · Harassment</div>
            </div>
            <div class="s-mode-arrow">${IC.chevRight}</div>
          </button>
          <button class="s-mode-card s-mode-mis" data-mode="misinfo">
            <div class="s-mode-icon-wrap">${IC.search}</div>
            <div class="s-mode-info">
              <div class="s-mode-name">Fact Check</div>
              <div class="s-mode-desc">Misinformation · Manipulation · AI text</div>
            </div>
            <div class="s-mode-arrow">${IC.chevRight}</div>
          </button>
          <button class="s-mode-card s-mode-scam" data-mode="scam">
            <div class="s-mode-icon-wrap">${IC.lock}</div>
            <div class="s-mode-info">
              <div class="s-mode-name">Scam Shield</div>
              <div class="s-mode-desc">Phishing · Fraud · Malicious links</div>
            </div>
            <div class="s-mode-arrow">${IC.chevRight}</div>
          </button>
        </div>

        <div class="s-bottom-row">
          <button class="s-settings-btn" id="s-open-settings">${IC.settings} Sensitivity settings</button>
          <div class="s-version-tag">v8.0</div>
        </div>
      </div>

      <!-- TOXICITY SCREEN -->
      <div id="s-screen-toxicity" class="s-screen s-scan-screen">
        <div class="s-scan-header">
          <button class="s-back-btn" data-back="toxicity">${IC.chevLeft} Back</button>
          <div class="s-screen-label">${IC.alertTri} Toxicity Check</div>
          <button class="s-close-btn" id="s-close-tox">${IC.x}</button>
        </div>
        <div class="s-score-card-v2">
          <div class="s-gauge-wrap">
            <svg class="s-gauge-svg" width="160" height="88" viewBox="0 0 160 88">
              <path class="s-gauge-bg" d="M 16,80 A 64,64 0 0,1 144,80" stroke-dasharray="201.1" stroke-dashoffset="0"/>
              <path class="s-gauge-fg" id="tox-gauge" d="M 16,80 A 64,64 0 0,1 144,80"
                stroke="#DC2626" stroke-dasharray="201.1" stroke-dashoffset="201.1"/>
            </svg>
            <div class="s-gauge-pct" id="tox-pct" style="margin-top:-52px">0%</div>
            <div class="s-gauge-label">RISK LEVEL</div>
          </div>
          <div class="s-score-verdict-v2" id="tox-verdict">Ready to scan</div>
          <div class="s-score-detail-v2" id="tox-detail">Scan this page for toxic content, hate speech, and cyberbullying.</div>
        </div>
        <div class="s-actions">
          <button class="s-scan-btn s-btn-tox" id="tox-scan">${IC.play} Scan Page</button>
          <button class="s-clear-btn" id="tox-clear">${IC.x} Clear</button>
        </div>
        <div class="s-analysis-box">
          <div class="s-analysis-label">${IC.zap} AI Analysis</div>
          <div class="s-analysis-text" id="tox-writeup-text">Run a scan to see the AI analysis.</div>
        </div>
        <div class="s-flags-section">
          <div class="s-flags-header">
            <div class="s-flags-title">Flagged Content</div>
            <div class="s-flags-count" id="tox-flag-count">0</div>
          </div>
          <div class="s-flags-list" id="tox-flags">
            <div class="s-no-flags">${IC.check} Nothing flagged yet</div>
          </div>
        </div>
        <div class="s-status">
          <div class="s-status-dot" id="tox-dot"></div>
          <div class="s-status-text" id="tox-status">Ready</div>
        </div>
      </div>

      <!-- MISINFO SCREEN -->
      <div id="s-screen-misinfo" class="s-screen s-scan-screen">
        <div class="s-scan-header">
          <button class="s-back-btn" data-back="misinfo">${IC.chevLeft} Back</button>
          <div class="s-screen-label">${IC.search} Fact Check</div>
          <button class="s-close-btn" id="s-close-mis">${IC.x}</button>
        </div>
        <div class="s-score-card-v2">
          <div class="s-gauge-wrap">
            <svg class="s-gauge-svg" width="160" height="88" viewBox="0 0 160 88">
              <path class="s-gauge-bg" d="M 16,80 A 64,64 0 0,1 144,80" stroke-dasharray="201.1" stroke-dashoffset="0"/>
              <path class="s-gauge-fg" id="mis-gauge" d="M 16,80 A 64,64 0 0,1 144,80"
                stroke="#D97706" stroke-dasharray="201.1" stroke-dashoffset="201.1"/>
            </svg>
            <div class="s-gauge-pct" id="mis-pct" style="margin-top:-52px">0%</div>
            <div class="s-gauge-label">RISK LEVEL</div>
          </div>
          <div class="s-score-verdict-v2" id="mis-verdict">Ready to scan</div>
          <div class="s-score-detail-v2" id="mis-detail">Check for misinformation, manipulation tactics, and AI-generated text.</div>
        </div>
        <div class="s-toggles-box">
          <div class="s-toggle-row">
            <div class="s-toggle-icon">${IC.image}</div>
            <div class="s-toggle-name">AI Image Detection
              <span class="s-toggle-hint">Hover over any image on the page</span>
            </div>
            <label class="s-toggle"><input type="checkbox" id="img-detect-toggle"><div class="s-toggle-track"></div></label>
          </div>
          <div class="s-toggle-row">
            <div class="s-toggle-icon">${IC.type}</div>
            <div class="s-toggle-name">AI Text Detector
              <span class="s-toggle-hint">Highlight any text to analyze</span>
            </div>
            <label class="s-toggle"><input type="checkbox" id="text-ai-toggle"><div class="s-toggle-track"></div></label>
          </div>
        </div>
        <div class="s-bars-box">
          <div class="s-bar-row">
            <div class="s-bar-label">Misinformation</div>
            <div class="s-bar-track"><div class="s-bar-fill s-fill-mis" id="mis-bar"></div></div>
            <div class="s-bar-pct" id="mis-bar-pct">—</div>
          </div>
          <div class="s-bar-row">
            <div class="s-bar-label">Manipulation</div>
            <div class="s-bar-track"><div class="s-bar-fill s-fill-manip" id="manip-bar"></div></div>
            <div class="s-bar-pct" id="manip-pct">—</div>
          </div>
        </div>
        <div class="s-actions">
          <button class="s-scan-btn s-btn-mis" id="mis-scan">${IC.play} Scan Page</button>
          <button class="s-clear-btn" id="mis-clear">${IC.x} Clear</button>
        </div>
        <div class="s-ai-result-box" id="ai-text-result">
          <div class="s-ai-result-label">Selected Text — AI Analysis</div>
          <div class="s-ai-meter">
            <div class="s-ai-track"><div class="s-ai-bar" id="ai-text-bar"></div></div>
            <div class="s-ai-pct" id="ai-text-pct">—</div>
          </div>
          <div class="s-ai-verdict" id="ai-text-verdict"></div>
          <div class="s-ai-signals" id="ai-text-signals"></div>
        </div>
        <div class="s-analysis-box">
          <div class="s-analysis-label">${IC.zap} AI Analysis</div>
          <div class="s-analysis-text" id="mis-writeup-text">Run a scan to see the AI analysis.</div>
        </div>
        <div class="s-flags-section">
          <div class="s-flags-header">
            <div class="s-flags-title">Flagged Content</div>
            <div class="s-flags-count" id="mis-flag-count">0</div>
          </div>
          <div class="s-flags-list" id="mis-flags">
            <div class="s-no-flags">${IC.check} Nothing flagged yet</div>
          </div>
        </div>
        <div class="s-status">
          <div class="s-status-dot" id="mis-dot"></div>
          <div class="s-status-text" id="mis-status">Ready</div>
        </div>
      </div>

      <!-- SCAM SCREEN -->
      <div id="s-screen-scam" class="s-screen s-scan-screen">
        <div class="s-scan-header">
          <button class="s-back-btn" data-back="scam">${IC.chevLeft} Back</button>
          <div class="s-screen-label">${IC.lock} Scam Shield</div>
          <button class="s-close-btn" id="s-close-scam">${IC.x}</button>
        </div>
        <div class="s-score-card-v2">
          <div class="s-gauge-wrap">
            <svg class="s-gauge-svg" width="160" height="88" viewBox="0 0 160 88">
              <path class="s-gauge-bg" d="M 16,80 A 64,64 0 0,1 144,80" stroke-dasharray="201.1" stroke-dashoffset="0"/>
              <path class="s-gauge-fg" id="scam-gauge" d="M 16,80 A 64,64 0 0,1 144,80"
                stroke="#7C3AED" stroke-dasharray="201.1" stroke-dashoffset="201.1"/>
            </svg>
            <div class="s-gauge-pct" id="scam-gauge-pct" style="margin-top:-52px">0%</div>
            <div class="s-gauge-label">THREAT LEVEL</div>
          </div>
          <div class="s-score-verdict-v2" id="scam-verdict">Ready to scan</div>
          <div class="s-score-detail-v2" id="scam-detail">Detect phishing, fraud, and malicious links on this page.</div>
        </div>
        <div class="s-url-box">
          <div class="s-url-label">Current Page</div>
          <div class="s-url-val" id="scam-url-val">${location.hostname}</div>
          <div class="s-chips-row" id="scam-threat-indicators">
            <div class="s-url-chip" id="chip-https"><div class="s-chip-dot"></div>HTTPS</div>
            <div class="s-url-chip" id="chip-typo"><div class="s-chip-dot"></div>Typosquat</div>
            <div class="s-url-chip" id="chip-urgent"><div class="s-chip-dot"></div>Urgency</div>
            <div class="s-url-chip" id="chip-data"><div class="s-chip-dot"></div>Data harvest</div>
          </div>
        </div>
        <div class="s-bars-box">
          <div class="s-bar-row">
            <div class="s-bar-label">Phishing risk</div>
            <div class="s-bar-track"><div class="s-bar-fill s-fill-scam" id="scam-bar"></div></div>
            <div class="s-bar-pct" id="scam-pct">—</div>
          </div>
          <div class="s-bar-row">
            <div class="s-bar-label">Social eng.</div>
            <div class="s-bar-track"><div class="s-bar-fill s-fill-phish" id="social-eng-bar"></div></div>
            <div class="s-bar-pct" id="social-eng-pct">—</div>
          </div>
        </div>
        <div class="s-actions">
          <button class="s-scan-btn s-btn-scam" id="scam-scan">${IC.play} Scan Page</button>
          <button class="s-clear-btn" id="scam-clear">${IC.x} Clear</button>
        </div>
        <div class="s-analysis-box">
          <div class="s-analysis-label">${IC.zap} AI Threat Analysis</div>
          <div class="s-analysis-text" id="scam-writeup-text">Run a scan to detect threats.</div>
        </div>
        <div class="s-flags-section">
          <div class="s-flags-header">
            <div class="s-flags-title">Suspicious Links</div>
            <div class="s-flags-count" id="scam-link-count">0</div>
          </div>
          <div class="s-flags-list" id="scam-links">
            <div class="s-no-flags">${IC.link} No suspicious links found</div>
          </div>
          <div class="s-flags-header" style="margin-top:10px">
            <div class="s-flags-title">Flagged Content</div>
            <div class="s-flags-count" id="scam-flag-count">0</div>
          </div>
          <div class="s-flags-list" id="scam-flags">
            <div class="s-no-flags">${IC.check} Nothing flagged yet</div>
          </div>
        </div>
        <div class="s-status">
          <div class="s-status-dot" id="scam-dot"></div>
          <div class="s-status-text" id="scam-status">Ready</div>
        </div>
      </div>

      <!-- SETTINGS SCREEN -->
      <div id="s-screen-settings" class="s-screen">
        <div class="s-settings-header">
          <button class="s-back-btn" id="s-settings-back">${IC.chevLeft} Back</button>
          <div class="s-settings-title">Preferences</div>
          <button class="s-close-btn" id="s-close-settings">${IC.x}</button>
        </div>
        <div class="s-settings-body">

          <div class="s-settings-group">
            <div class="s-settings-group-title">Sensitivity — flag earlier for</div>
            <div class="s-pref-row">
              <div class="s-pref-icon">${IC.salad}</div>
              <div class="s-pref-info">
                <div class="s-pref-name">Diet & Fitness Content</div>
                <div class="s-pref-hint">Flag extreme diet/workout advice sooner</div>
              </div>
              <label class="s-toggle"><input type="checkbox" id="pref-diet"><div class="s-toggle-track"></div></label>
            </div>
            <div class="s-pref-row">
              <div class="s-pref-icon">${IC.dollar}</div>
              <div class="s-pref-info">
                <div class="s-pref-name">Financial & Crypto</div>
                <div class="s-pref-hint">Lower threshold for get-rich-quick signals</div>
              </div>
              <label class="s-toggle"><input type="checkbox" id="pref-finance"><div class="s-toggle-track"></div></label>
            </div>
            <div class="s-pref-row">
              <div class="s-pref-icon">${IC.vote}</div>
              <div class="s-pref-info">
                <div class="s-pref-name">Political Content</div>
                <div class="s-pref-hint">Heightened misinfo detection on politics</div>
              </div>
              <label class="s-toggle"><input type="checkbox" id="pref-politics"><div class="s-toggle-track"></div></label>
            </div>
            <div class="s-pref-row">
              <div class="s-pref-icon">${IC.dice}</div>
              <div class="s-pref-info">
                <div class="s-pref-name">Gambling & Substances</div>
                <div class="s-pref-hint">Flag addiction-promoting content</div>
              </div>
              <label class="s-toggle"><input type="checkbox" id="pref-addiction"><div class="s-toggle-track"></div></label>
            </div>
            <div class="s-pref-row">
              <div class="s-pref-icon">${IC.brain}</div>
              <div class="s-pref-info">
                <div class="s-pref-name">Mental Health Content</div>
                <div class="s-pref-hint">Alert on self-esteem attacks & doom bait</div>
              </div>
              <label class="s-toggle"><input type="checkbox" id="pref-mental"><div class="s-toggle-track"></div></label>
            </div>
          </div>

          <div class="s-settings-group">
            <div class="s-settings-group-title">Alert Threshold</div>
            <div class="s-pref-row">
              <div class="s-pref-icon">${IC.bell}</div>
              <div class="s-pref-info">
                <div class="s-pref-name">Show warnings at</div>
                <div class="s-pref-hint">Minimum risk level to trigger alerts</div>
              </div>
              <select class="s-threshold-select" id="pref-threshold">
                <option value="low">Low risk</option>
                <option value="medium" selected>Medium risk</option>
                <option value="high">High risk only</option>
              </select>
            </div>
          </div>

          <div class="s-settings-group">
            <div class="s-settings-group-title">Behavior Tracking</div>
            <div class="s-pref-row">
              <div class="s-pref-icon">${IC.clock}</div>
              <div class="s-pref-info">
                <div class="s-pref-name">Dwell Time Tracking</div>
                <div class="s-pref-hint">Logs time spent on flagged pages</div>
              </div>
              <label class="s-toggle"><input type="checkbox" id="pref-dwell" checked><div class="s-toggle-track"></div></label>
            </div>
            <div class="s-pref-row">
              <div class="s-pref-icon">${IC.mouse}</div>
              <div class="s-pref-info">
                <div class="s-pref-name">Scroll Behavior</div>
                <div class="s-pref-hint">Detect rapid scroll-away from content</div>
              </div>
              <label class="s-toggle"><input type="checkbox" id="pref-behavior" checked><div class="s-toggle-track"></div></label>
            </div>
          </div>

          <div class="s-stats-box">
            <div class="s-stats-title">Session Stats</div>
            <div class="s-stats-grid">
              <div class="s-stat-chip">
                <div class="s-stat-chip-val" id="stat-scans">0</div>
                <div class="s-stat-chip-lbl">Total Scans</div>
              </div>
              <div class="s-stat-chip">
                <div class="s-stat-chip-val" id="stat-flags">0</div>
                <div class="s-stat-chip-lbl">Flags Caught</div>
              </div>
              <div class="s-stat-chip">
                <div class="s-stat-chip-val" id="stat-reactions">0</div>
                <div class="s-stat-chip-lbl">Reactions</div>
              </div>
              <div class="s-stat-chip">
                <div class="s-stat-chip-val" id="stat-creators">0</div>
                <div class="s-stat-chip-lbl">Creators</div>
              </div>
            </div>
            <button class="s-clear-data-btn" id="s-clear-data">${IC.trash} Clear My Data</button>
          </div>
        </div>
      </div>

    </div>

    <!-- Image hover tooltip -->
    <div id="s-img-tooltip" style="display:none">
      <div class="s-img-tip-header">${IC.image} AI Image Analysis</div>
      <div class="s-img-tip-track"><div class="s-img-tip-bar" id="img-tip-bar"></div></div>
      <div class="s-img-tip-verdict" id="img-tip-verdict">Analyzing…</div>
      <div class="s-img-tip-signals" id="img-tip-signals"></div>
    </div>

    <!-- Left-side score sidebar (slides in after any scan) -->
    <div id="s-score-sidebar">
      <div class="s-sb-header">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
      </div>
      <div class="s-sb-item" id="sb-tox" title="Toxicity">
        <svg class="s-sb-gauge-svg" width="52" height="30" viewBox="0 0 52 30">
          <path class="s-sb-gauge-bg" d="M 4,27 A 22,22 0 0,1 48,27" stroke-dasharray="69.1" stroke-dashoffset="0"/>
          <path class="s-sb-gauge-fg" id="sb-tox-gauge" d="M 4,27 A 22,22 0 0,1 48,27" stroke="#DC2626" stroke-dasharray="69.1" stroke-dashoffset="69.1"/>
        </svg>
        <div class="s-sb-val" id="sb-tox-val">—</div>
        <div class="s-sb-lbl">Toxic</div>
        <div class="s-sb-dot s-sb-dot-clean" id="sb-tox-dot"></div>
        <div class="s-sb-tooltip" id="sb-tox-tip">Toxicity: —</div>
      </div>
      <div class="s-sb-item" id="sb-mis" title="Misinfo">
        <svg class="s-sb-gauge-svg" width="52" height="30" viewBox="0 0 52 30">
          <path class="s-sb-gauge-bg" d="M 4,27 A 22,22 0 0,1 48,27" stroke-dasharray="69.1" stroke-dashoffset="0"/>
          <path class="s-sb-gauge-fg" id="sb-mis-gauge" d="M 4,27 A 22,22 0 0,1 48,27" stroke="#D97706" stroke-dasharray="69.1" stroke-dashoffset="69.1"/>
        </svg>
        <div class="s-sb-val" id="sb-mis-val">—</div>
        <div class="s-sb-lbl">Misinfo</div>
        <div class="s-sb-dot s-sb-dot-clean" id="sb-mis-dot"></div>
        <div class="s-sb-tooltip" id="sb-mis-tip">Misinfo: —</div>
      </div>
      <div class="s-sb-item" id="sb-scam" title="Scam">
        <svg class="s-sb-gauge-svg" width="52" height="30" viewBox="0 0 52 30">
          <path class="s-sb-gauge-bg" d="M 4,27 A 22,22 0 0,1 48,27" stroke-dasharray="69.1" stroke-dashoffset="0"/>
          <path class="s-sb-gauge-fg" id="sb-scam-gauge" d="M 4,27 A 22,22 0 0,1 48,27" stroke="#7C3AED" stroke-dasharray="69.1" stroke-dashoffset="69.1"/>
        </svg>
        <div class="s-sb-val" id="sb-scam-val">—</div>
        <div class="s-sb-lbl">Scam</div>
        <div class="s-sb-dot s-sb-dot-clean" id="sb-scam-dot"></div>
        <div class="s-sb-tooltip" id="sb-scam-tip">Scam: —</div>
      </div>
      <div class="s-sb-item" id="sb-ai" title="AI Content">
        <svg class="s-sb-gauge-svg" width="52" height="30" viewBox="0 0 52 30">
          <path class="s-sb-gauge-bg" d="M 4,27 A 22,22 0 0,1 48,27" stroke-dasharray="69.1" stroke-dashoffset="0"/>
          <path class="s-sb-gauge-fg" id="sb-ai-gauge" d="M 4,27 A 22,22 0 0,1 48,27" stroke="#059669" stroke-dasharray="69.1" stroke-dashoffset="69.1"/>
        </svg>
        <div class="s-sb-val" id="sb-ai-val">—</div>
        <div class="s-sb-lbl">AI Text</div>
        <div class="s-sb-dot s-sb-dot-clean" id="sb-ai-dot"></div>
        <div class="s-sb-tooltip" id="sb-ai-tip">AI Score: —</div>
      </div>
      <div class="s-sb-item" id="sb-manip" title="Manipulation">
        <svg class="s-sb-gauge-svg" width="52" height="30" viewBox="0 0 52 30">
          <path class="s-sb-gauge-bg" d="M 4,27 A 22,22 0 0,1 48,27" stroke-dasharray="69.1" stroke-dashoffset="0"/>
          <path class="s-sb-gauge-fg" id="sb-manip-gauge" d="M 4,27 A 22,22 0 0,1 48,27" stroke="#EA580C" stroke-dasharray="69.1" stroke-dashoffset="69.1"/>
        </svg>
        <div class="s-sb-val" id="sb-manip-val">—</div>
        <div class="s-sb-lbl">Manip.</div>
        <div class="s-sb-dot s-sb-dot-clean" id="sb-manip-dot"></div>
        <div class="s-sb-tooltip" id="sb-manip-tip">Manipulation: —</div>
      </div>
      <button class="s-sb-dismiss" id="sb-dismiss" title="Hide sidebar">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="12" height="12"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
  `;

  document.body.appendChild(root);

  // ── Wire events ─────────────────────────────────────────────────────────
  document.getElementById("s-bubble").addEventListener("click", toggleSidebar);
  document.querySelectorAll(".s-close-btn, #s-close").forEach(b => b.addEventListener("click", closeSidebar));
  document.querySelectorAll(".s-mode-card").forEach(b => b.addEventListener("click", () => goMode(b.dataset.mode)));
  document.querySelectorAll(".s-back-btn[data-back]").forEach(b => b.addEventListener("click", goHome));
  document.getElementById("s-open-settings").addEventListener("click", goSettings);
  document.getElementById("s-settings-back").addEventListener("click", goHome);
  document.getElementById("tox-scan").addEventListener("click",  () => runScan("toxicity"));
  document.getElementById("tox-clear").addEventListener("click", clearHighlights);
  document.getElementById("mis-scan").addEventListener("click",  () => runScan("misinfo"));
  document.getElementById("mis-clear").addEventListener("click", clearHighlights);
  document.getElementById("scam-scan").addEventListener("click", () => runScan("scam"));
  document.getElementById("scam-clear").addEventListener("click", clearHighlights);
  document.getElementById("img-detect-toggle").addEventListener("change", e => { imageDetectOn = e.target.checked; toggleImageDetect(imageDetectOn); });
  document.getElementById("text-ai-toggle").addEventListener("change",   e => { textAiOn = e.target.checked; toggleTextAi(textAiOn); });
  document.getElementById("s-open-dash").addEventListener("click", () => window.open(DASHBOARD_URL, "sentinel-dashboard"));
  document.getElementById("s-clear-data").addEventListener("click", () => {
    if (confirm("Clear all Sentinel data?")) {
      behaviorLog = []; saveBehaviorLog();
      try { chrome.storage.local.remove(["sentinelStats"]); } catch {}
      updateStats();
    }
  });

  bindSettingsEvents();
  syncSettingsUI();
  updateStats();
  runUrlChecks();
  loadStats();

  // Score sidebar dismiss
  document.getElementById("sb-dismiss")?.addEventListener("click", () => {
    document.getElementById("s-score-sidebar")?.classList.remove("visible");
  });
  // Click sidebar items to open matching scan mode
  [["sb-tox","toxicity"],["sb-mis","misinfo"],["sb-scam","scam"]].forEach(([id, mode]) => {
    document.getElementById(id)?.addEventListener("click", () => {
      openSidebar(); goMode(mode);
    });
  });
}


// ── Navigation ────────────────────────────────────────────────────────────────
function toggleSidebar() { sidebarOpen ? closeSidebar() : openSidebar(); }
function openSidebar() {
  sidebarOpen = true;
  document.getElementById("s-panel").classList.remove("s-closed");
  document.getElementById("s-bubble").classList.add("s-bubble-on");
  ensureDashboardOpen();
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
function goSettings() {
  document.querySelectorAll(".s-screen").forEach(s => s.classList.remove("s-active"));
  document.getElementById("s-screen-settings").classList.add("s-active");
  syncSettingsUI();
  loadStats();
}

// ── Stats helpers ─────────────────────────────────────────────────────────────
let sessionStats = { scans: 0, flags: 0, reactions: 0, creators: 0 };

function loadStats() {
  try {
    chrome.storage.local.get("sentinelStats", (res) => {
      if (res.sentinelStats) sessionStats = { ...sessionStats, ...res.sentinelStats };
      updateStats();
    });
  } catch { updateStats(); }
}

function incrementStat(key, amount = 1) {
  sessionStats[key] = (sessionStats[key] || 0) + amount;
  try { chrome.storage.local.set({ sentinelStats: sessionStats }); } catch {}
  updateStats();
}

function updateStats() {
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set("home-scans-today", sessionStats.scans     || 0);
  set("home-flags-total", sessionStats.flags     || 0);
  set("home-reactions",   sessionStats.reactions || 0);
  set("stat-scans",       sessionStats.scans     || 0);
  set("stat-flags",       sessionStats.flags     || 0);
  set("stat-reactions",   sessionStats.reactions || 0);
  set("stat-creators",    sessionStats.creators  || 0);
  const dot = document.getElementById("s-bubble-dot");
  if (dot) dot.classList.toggle("visible", (sessionStats.flags || 0) > 0);
}

// ── Scan ──────────────────────────────────────────────────────────────────────
async function runScan(mode) {
  if (isScanning) return;
  isScanning = true;
  setStatus(mode, "Scanning…");

  const baseExtracted = extractText();
  const target = getSelectionScanTarget(baseExtracted);
  const extracted = target.extracted;
  const text = target.text;

  // Trigger creator health scan on social platforms (runs in parallel, non-blocking)
  if (!target.isSelection && extracted.platform && extracted.platform !== "unknown") {
    runCreatorScan(extracted).catch(e => console.warn("[Sentinel] Creator scan error:", e));
  }

  if (!text || text.trim().length < 20) {
    setStatus(mode, "Not enough text on page");
    isScanning = false;
    return;
  }

  // Check cache first
  const cacheKey = target.isSelection
    ? `${location.href}:${mode}:selection:${text.slice(0, 160)}`
    : `${location.href}:${mode}`;
  const cached = scanCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    const data = cached.data;
    lastFlags = data.flags || [];
    applyResultsToUI(mode, data, lastFlags, extracted);
    setStatus(mode, `${lastFlags.length} flag(s) — cached result`);
    isScanning = false;
    return;
  }

  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        mode,
        url: location.href,
        pageTitle: target.isSelection ? `${document.title} (selected text)` : document.title,
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    let data = await res.json();
    lastFlags = data.flags || [];

    // Cache the result
    scanCache.set(cacheKey, { data, timestamp: Date.now() });

    // Apply sensitivity profile — may escalate severity
    data = applySensitivityFilter(data, extracted);

    // Start dwell tracking for flagged pages
    startDwellTracking(data, extracted);

    observerPaused = true;
    clearHighlights();
    applyResultsToUI(mode, data, lastFlags, extracted);
    observerPaused = false;

    // Post to dashboard
    postToDashboard({
      text: text.slice(0, 300),
      flags: lastFlags,
      toxicity:         data.toxicity     || 0,
      manipulation:     data.manipulation || 0,
      misinfo:          data.misinfo      || 0,
      scam_score:       data.scam_score   || 0,
      ai_score:         data.ai_score     || 0,
      overall_severity: data.overall_severity || "clean",
      platform:         extracted.platform || "",
      pageTitle:        document.title,
      pageUrl:          location.href,
      contentType:      extracted.contentType || "unknown",
      contentTitle:     extracted.contentTitle || "",
      selection:        !!target.isSelection,
    });

    const count = lastFlags.length;
    const boosted = data._sensitivity_boosted ? " (sensitivity active)" : "";
    const scope = target.isSelection ? " in selection" : "";
    setStatus(mode, count > 0 ? `${count} flag(s) detected${scope}${boosted}` : `All clear${scope}!`);

    // Track stats
    incrementStat("scans");
    if (count > 0) incrementStat("flags", count);

    // Fire toast notification for medium/high severity
    maybeToastScanResult(data, mode);

    // Inject reaction buttons into the active scan panel
    const panelFlagsId = mode === "toxicity" ? "tox-flags" : mode === "misinfo" ? "mis-flags" : "scam-flags";
    injectReactionButton(panelFlagsId, data, extracted);
  } catch(e) {
    setStatus(mode, "Backend unreachable");
    console.warn("[Sentinel]", e);
  }
  isScanning = false;
}

function applyResultsToUI(mode, data, flags, extracted) {
  if (mode === "toxicity") {
    updateToxicityUI(data);
    applyHighlights(flags.filter(f => f.type === "toxicity"), "s-hl-red");
  } else if (mode === "misinfo") {
    updateMisinfoUI(data);
    applyHighlights(flags.filter(f => f.type === "misinfo" || f.type === "manipulation"), "s-hl-amber");
    applyHighlights(flags.filter(f => f.type === "ai"), "s-hl-purple");
  } else if (mode === "scam") {
    updateScamUI(data);
    applyHighlights(flags.filter(f => f.type === "scam" || f.type === "phishing"), "s-hl-orange");
  }
}

// ── UI updaters ───────────────────────────────────────────────────────────────
// ── Gauge animation ───────────────────────────────────────────────────────────
// Semicircle arc length: π × r
// For main gauges: r=64, arc = π×64 ≈ 201.1
// For sidebar mini: r=22, arc = π×22 ≈ 69.1

function animateGauge(id, pct, color) {
  const el = document.getElementById(id);
  if (!el) return;
  // Works for both <circle> (full ring) and <path> (semicircle)
  const total = parseFloat(el.getAttribute("stroke-dasharray")) || 201.1;
  const offset = total - (total * Math.min(pct, 100) / 100);
  el.style.strokeDashoffset = offset;
  if (color) el.style.stroke = color;
}

// Legacy alias — keeps older calls working
function animateRing(ringId, pct, color) { animateGauge(ringId, pct, color); }

function scoreColor(pct) {
  return pct > 65 ? "#DC2626" : pct > 35 ? "#D97706" : "#059669";
}

function dotClass(pct) {
  return pct > 65 ? "s-sb-dot-high" : pct > 35 ? "s-sb-dot-medium" : pct > 10 ? "s-sb-dot-low" : "s-sb-dot-clean";
}

// ── Score sidebar update ──────────────────────────────────────────────────────
function updateScoreSidebar(data) {
  const scores = {
    tox:   Math.round((data.toxicity     || 0) * 100),
    mis:   Math.round((data.misinfo      || 0) * 100),
    scam:  Math.round((data.scam_score   || 0) * 100),
    ai:    Math.round((data.ai_score     || 0) * 100),
    manip: Math.round((data.manipulation || 0) * 100),
  };
  const labels = { tox:"Toxicity", mis:"Misinfo", scam:"Scam", ai:"AI Text", manip:"Manipulation" };

  Object.entries(scores).forEach(([key, pct]) => {
    const color = scoreColor(pct);
    animateGauge(`sb-${key}-gauge`, pct, color);

    const valEl = document.getElementById(`sb-${key}-val`);
    if (valEl) valEl.textContent = pct + "%";

    const dotEl = document.getElementById(`sb-${key}-dot`);
    if (dotEl) dotEl.className = `s-sb-dot ${dotClass(pct)}`;

    const tipEl = document.getElementById(`sb-${key}-tip`);
    if (tipEl) tipEl.textContent = `${labels[key]}: ${pct}%`;
  });

  // Slide sidebar in
  const sb = document.getElementById("s-score-sidebar");
  if (sb) sb.classList.add("visible");
}

function setVerdict(verdictId, detailId, pct, labels) {
  const vEl = document.getElementById(verdictId);
  const dEl = document.getElementById(detailId);
  const { safe, low, medium, high } = labels;
  if (pct > 65)      { if (vEl) vEl.textContent = high.title;   if (dEl) dEl.textContent = high.detail; }
  else if (pct > 35) { if (vEl) vEl.textContent = medium.title; if (dEl) dEl.textContent = medium.detail; }
  else if (pct > 10) { if (vEl) vEl.textContent = low.title;    if (dEl) dEl.textContent = low.detail; }
  else               { if (vEl) vEl.textContent = safe.title;   if (dEl) dEl.textContent = safe.detail; }
}

function updateToxicityUI(data) {
  const pct = Math.round((data.toxicity || 0) * 100);
  animateGauge("tox-gauge", pct, scoreColor(pct));
  const pctEl = document.getElementById("tox-pct");
  if (pctEl) pctEl.textContent = pct + "%";
  setVerdict("tox-verdict", "tox-detail", pct, {
    safe:   { title: "All clear",           detail: "No toxic language detected on this page." },
    low:    { title: "Minor signals",        detail: "A few potentially unkind phrases — nothing serious." },
    medium: { title: "Toxic content found", detail: "Harmful language patterns detected. Approach with caution." },
    high:   { title: "High toxicity",        detail: "Strong harassment or hate speech patterns present." },
  });
  const tflags = lastFlags.filter(f => f.type === "toxicity");
  renderFlags("tox-flags", "tox-flag-count", tflags);
  generateWriteup("tox-writeup-text", data, tflags, "toxicity", pct);
  updateScoreSidebar(data);
}

function updateMisinfoUI(data) {
  const misPct   = Math.round((data.misinfo      || 0) * 100);
  const manipPct = Math.round((data.manipulation || 0) * 100);
  const aiPct    = Math.round((data.ai_score     || 0) * 100);
  setBar("mis-bar",   "mis-bar-pct",  misPct);
  setBar("manip-bar", "manip-pct",    manipPct);
  const topPct = Math.max(misPct, manipPct);
  animateGauge("mis-gauge", topPct, scoreColor(topPct));
  const misPctEl = document.getElementById("mis-pct");
  if (misPctEl) misPctEl.textContent = topPct + "%";
  setVerdict("mis-verdict", "mis-detail", topPct, {
    safe:   { title: "Looks legitimate",    detail: "No significant misinformation patterns found." },
    low:    { title: "Some spin detected",  detail: "A few persuasion tactics — check sources independently." },
    medium: { title: "Misleading content", detail: "Manipulation or unverified claims detected." },
    high:   { title: "High misinfo risk",   detail: "Strong indicators of false or manipulative content." },
  });
  const rel = lastFlags.filter(f => ["misinfo","manipulation","ai"].includes(f.type));
  renderFlags("mis-flags", "mis-flag-count", rel);
  generateWriteup("mis-writeup-text", data, rel, "misinfo", topPct);
  if (aiPct > 20) {
    const aiBox = document.getElementById("ai-text-result");
    if (aiBox) aiBox.style.display = "block";
    setBar("ai-text-bar", "ai-text-pct", aiPct);
    const aiVerdict = document.getElementById("ai-text-verdict");
    if (aiVerdict) aiVerdict.textContent = aiPct > 65
      ? "Strong signals of AI-generated text."
      : aiPct > 35 ? "Possibly AI-assisted writing." : "Mostly human-written.";
  }
  updateScoreSidebar(data);
}

function updateScamUI(data) {
  const scamPct  = Math.round((data.scam_score   || 0) * 100);
  const manipPct = Math.round((data.manipulation || 0) * 100);
  animateGauge("scam-gauge", scamPct, scoreColor(scamPct));
  const scamGaugePct = document.getElementById("scam-gauge-pct");
  if (scamGaugePct) scamGaugePct.textContent = scamPct + "%";
  setVerdict("scam-verdict", "scam-detail", scamPct, {
    safe:   { title: "No threats detected",  detail: "This page looks safe." },
    low:    { title: "Minor signals",         detail: "Some low-level signals — stay alert." },
    medium: { title: "Suspicious page",      detail: "Scam patterns detected. Do not share personal info." },
    high:   { title: "High threat",           detail: "Strong phishing indicators. Leave this page." },
  });
  setBar("scam-bar",       "scam-pct",       scamPct);
  setBar("social-eng-bar", "social-eng-pct", manipPct);
  const scamFlags = lastFlags.filter(f => ["scam","phishing"].includes(f.type));
  renderFlags("scam-flags", "scam-flag-count", scamFlags);
  renderLinks("scam-links");
  generateWriteup("scam-writeup-text", data, scamFlags, "scam", scamPct);
  updateScoreSidebar(data);
}

function setBar(barId, pctId, pct) {
  const bar = document.getElementById(barId);
  const lbl = document.getElementById(pctId);
  if (bar) { bar.style.width = pct + "%"; bar.style.opacity = "1"; }
  if (lbl) lbl.textContent = pct + "%";
}

function generateWriteup(elId, data, flags, mode, score) {
  const el = document.getElementById(elId);
  if (!el) return;

  // Use Gemini reasoning if available
  const reasoning = data.reasoning || {};
  const geminiText = reasoning[mode === "toxicity" ? "toxicity" : mode === "misinfo" ? "misinfo" : "scam_score"] || reasoning.summary;
  if (geminiText) { el.textContent = geminiText; return; }

  // Friendly fallback writeups
  if (!flags.length || score < 10) {
    el.textContent = "Everything looks good here! No significant issues detected on this page.";
    return;
  }
  const highFlags = flags.filter(f => f.severity === "high");
  const topFlags  = (highFlags.length ? highFlags : flags).slice(0, 2);
  const phrases   = topFlags.map(f => `"${f.phrase.slice(0, 35)}"`).join(" and ");
  const writeups  = {
    toxicity: score > 65
      ? `⚠️ Flagged ${flags.length} harmful pattern(s) including ${phrases}. This page contains strong harassment or hate speech signals.`
      : `Found ${flags.length} potentially unkind phrase(s) including ${phrases}. Worth being cautious engaging here.`,
    misinfo:  score > 65
      ? `🔍 Detected ${flags.length} misinformation signal(s) including ${phrases}. This content may be misleading — verify with trusted sources.`
      : `Spotted ${flags.length} persuasion tactic(s) including ${phrases}. Some claims may be unverified.`,
    scam:     score > 65
      ? `🚨 ${flags.length} threat indicator(s) found including ${phrases}. Do not enter personal information on this page!`
      : `Found ${flags.length} suspicious pattern(s) including ${phrases}. Proceed with caution.`,
  };
  el.textContent = writeups[mode] || "Scan complete — review flagged items above.";
}

function renderFlags(containerId, countId, flags) {
  const el    = document.getElementById(containerId);
  const cntEl = document.getElementById(countId);
  if (!el) return;
  if (cntEl) cntEl.textContent = flags.length;

  if (!flags.length) {
    el.innerHTML = `
      <div class="s-no-flags">
        <div class="s-no-flags-emoji">✨</div>
        <div class="s-no-flags-text">Nothing flagged — looking clean!</div>
      </div>`;
    return;
  }

  const esc = s => s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  const sorted = [...flags].sort((a, b) => (b.score || 0) - (a.score || 0));

  el.innerHTML = sorted.map((f, i) => {
    const typeClass = `s-type-${f.type || "unknown"}`;
    const sevClass  = f.severity ? `s-sev-${f.severity}` : "";
    const sevLabel  = f.severity ? f.severity.toUpperCase() : "";
    const conf      = f.score ? `<div class="s-flag-conf">Confidence: ${Math.round(f.score*100)}%</div>` : "";
    const source    = f.source === "gemini"
      ? `<span style="font-size:8px;font-weight:800;color:#6366F1;margin-left:auto">⚡ AI</span>`
      : "";
    return `
      <div class="s-flag-card" style="animation-delay:${i * 0.04}s">
        <div class="s-flag-card-top">
          <span class="s-flag-type-chip ${typeClass}">${esc(f.type.toUpperCase())}</span>
          ${sevLabel ? `<span class="s-flag-sev ${sevClass}">${sevLabel}</span>` : ""}
          ${source}
        </div>
        <div class="s-flag-phrase">"${esc(f.phrase.slice(0,70))}${f.phrase.length > 70 ? "…" : ""}"</div>
        ${conf}
      </div>`;
  }).join("");
}

function renderLinks(containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const links = [...document.querySelectorAll("a[href]")]
    .filter(a => !a.closest("#sentinel-root"))
    .map(a => ({ href: a.href, text: a.textContent.trim().slice(0,40) }))
    .filter(l => isSuspiciousLink(l.href)).slice(0, 8);
  const cntEl = document.getElementById("scam-link-count");
  if (cntEl) cntEl.textContent = links.length;
  if (!links.length) {
    el.innerHTML = `<div class="s-no-flags"><div class="s-no-flags-emoji">🔗</div><div class="s-no-flags-text">No suspicious links found</div></div>`;
    return;
  }
  const esc = s => s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  el.innerHTML = links.map(l => `
    <div class="s-flag-card">
      <div class="s-flag-card-top">
        <span class="s-flag-type-chip s-type-phishing">SUSPICIOUS LINK</span>
        <span class="s-flag-sev s-sev-high">HIGH</span>
      </div>
      <div class="s-flag-phrase">${esc(l.text || l.href.slice(0,50))}</div>
      <div class="s-flag-conf">${esc(l.href.slice(0,60))}</div>
    </div>`).join("");
}

// ── Preferences ───────────────────────────────────────────────────────────────
const DEFAULT_PREFS = {
  sensitive_diet: false, sensitive_finance: false, sensitive_politics: false,
  sensitive_addiction: false, sensitive_mental: false,
  alert_threshold: "medium", dwell_tracking: true, behavior_tracking: true,
};
let userPrefs = { ...DEFAULT_PREFS };

function loadPrefs() {
  try { chrome.storage.local.get("sentinelPrefs", r => { if (r.sentinelPrefs) userPrefs = { ...DEFAULT_PREFS, ...r.sentinelPrefs }; }); }
  catch { try { const s = localStorage.getItem("sentinelPrefs"); if (s) userPrefs = { ...DEFAULT_PREFS, ...JSON.parse(s) }; } catch {} }
}
function savePrefs() {
  try { chrome.storage.local.set({ sentinelPrefs: userPrefs }); }
  catch { try { localStorage.setItem("sentinelPrefs", JSON.stringify(userPrefs)); } catch {} }
}

function syncSettingsUI() {
  const map = { "pref-diet":"sensitive_diet","pref-finance":"sensitive_finance","pref-politics":"sensitive_politics","pref-addiction":"sensitive_addiction","pref-mental":"sensitive_mental","pref-dwell":"dwell_tracking","pref-behavior":"behavior_tracking" };
  Object.entries(map).forEach(([id,key]) => { const el = document.getElementById(id); if (el) el.checked = !!userPrefs[key]; });
  const t = document.getElementById("pref-threshold"); if (t) t.value = userPrefs.alert_threshold || "medium";
}
function bindSettingsEvents() {
  const map = { "pref-diet":"sensitive_diet","pref-finance":"sensitive_finance","pref-politics":"sensitive_politics","pref-addiction":"sensitive_addiction","pref-mental":"sensitive_mental","pref-dwell":"dwell_tracking","pref-behavior":"behavior_tracking" };
  Object.entries(map).forEach(([id,key]) => { const el = document.getElementById(id); if (el) el.addEventListener("change", () => { userPrefs[key] = el.checked; savePrefs(); }); });
  const t = document.getElementById("pref-threshold"); if (t) t.addEventListener("change", () => { userPrefs.alert_threshold = t.value; savePrefs(); });
}

// ── Behavior tracking ─────────────────────────────────────────────────────────
let dwellStart = null, lastScrollY = window.scrollY, behaviorLog = [];
const MAX_BEHAVIOR_LOG = 100;

function loadBehaviorLog() {
  try { chrome.storage.local.get("sentinelBehavior", r => { if (r.sentinelBehavior) behaviorLog = r.sentinelBehavior; }); }
  catch { try { const s = localStorage.getItem("sentinelBehavior"); if (s) behaviorLog = JSON.parse(s); } catch {} }
}
function saveBehaviorLog() {
  const t = behaviorLog.slice(-MAX_BEHAVIOR_LOG);
  try { chrome.storage.local.set({ sentinelBehavior: t }); }
  catch { try { localStorage.setItem("sentinelBehavior", JSON.stringify(t)); } catch {} }
}

function logBehaviorSignal(signal) {
  if (!userPrefs.behavior_tracking) return;
  behaviorLog.push({ ...signal, timestamp: Date.now(), url: location.href });
  saveBehaviorLog();
  postToDashboard({ type: "BEHAVIOR_SIGNAL", payload: signal });
}

function startDwellTracking(scanData, extracted) {
  if (!userPrefs.dwell_tracking) return;
  dwellStart = Date.now();
  if ((scanData.overall_severity || "clean") === "clean") return;
  setTimeout(() => {
    if (!dwellStart) return;
    const elapsed = (Date.now() - dwellStart) / 1000;
    if (elapsed >= 7) logBehaviorSignal({ type:"dwell", signal:"prolonged_exposure", seconds:Math.round(elapsed), severity:scanData.overall_severity, contentTheme:extracted.theme||"unknown", platform:extracted.platform||"unknown", flags:(scanData.flags||[]).slice(0,3).map(f=>f.type) });
  }, 8000);
  window.addEventListener("beforeunload", () => {
    if (!dwellStart) return;
    const elapsed = (Date.now() - dwellStart) / 1000;
    if (elapsed >= 3) logBehaviorSignal({ type:"dwell", signal:"page_exit", seconds:Math.round(elapsed), severity:scanData.overall_severity, contentTheme:extracted.theme||"unknown", platform:extracted.platform||"unknown" });
    dwellStart = null;
  }, { once: true });
}

let _scrollThrottle = null;
window.addEventListener("scroll", () => {
  if (!userPrefs.behavior_tracking) return;
  clearTimeout(_scrollThrottle);
  _scrollThrottle = setTimeout(() => {
    const delta = Math.abs(window.scrollY - lastScrollY);
    lastScrollY = window.scrollY;
    if (delta > 600 && dwellStart) logBehaviorSignal({ type:"scroll", signal:"rapid_scroll_away", pixels:Math.round(delta), url:location.href });
  }, 150);
}, { passive: true });

function applySensitivityFilter(scanData, extracted) {
  const theme = (extracted.theme || "").toLowerCase();
  let boost = false;
  if (userPrefs.sensitive_diet     && theme.includes("fitness"))  boost = true;
  if (userPrefs.sensitive_finance  && theme.includes("finance"))  boost = true;
  if (userPrefs.sensitive_politics && theme.includes("politics")) boost = true;
  if (userPrefs.sensitive_addiction && (theme.includes("gambling") || theme.includes("alcohol"))) boost = true;
  if (userPrefs.sensitive_mental   && theme.includes("mental"))   boost = true;
  if (boost) {
    const top = Math.max(scanData.toxicity||0, scanData.misinfo||0, scanData.scam_score||0, scanData.manipulation||0);
    if (top > 0.15 && scanData.overall_severity === "clean")  return { ...scanData, overall_severity:"low",    _sensitivity_boosted:true };
    if (top > 0.25 && scanData.overall_severity === "low")    return { ...scanData, overall_severity:"medium", _sensitivity_boosted:true };
  }
  return scanData;
}

// ── Reaction button ───────────────────────────────────────────────────────────
function injectReactionButton(containerId, scanData, extracted) {
  const container = document.getElementById(containerId);
  if (!container || container.querySelector(".s-reaction-row")) return;
  const row = document.createElement("div");
  row.className = "s-reaction-row";
  row.innerHTML = `
    <span class="s-reaction-label">HOW'D THIS MAKE YOU FEEL?</span>
    <button class="s-react-emoji" data-reaction="upset"   title="Upset me">😟</button>
    <button class="s-react-emoji" data-reaction="anxious" title="Anxious">😰</button>
    <button class="s-react-emoji" data-reaction="angry"   title="Angry">😡</button>
    <button class="s-react-emoji" data-reaction="fine"    title="Fine">😌</button>
  `;
  row.querySelectorAll(".s-react-emoji").forEach(btn => {
    btn.addEventListener("click", () => {
      const reaction = btn.dataset.reaction;
      logBehaviorSignal({ type:"reaction", signal:"explicit_reaction", reaction, severity:scanData.overall_severity||"unknown", contentTheme:extracted.theme||"unknown", platform:extracted.platform||"unknown", flagTypes:[...new Set((scanData.flags||[]).map(f=>f.type))] });
      incrementStat("reactions");
      row.querySelectorAll(".s-react-emoji").forEach(b => { b.style.opacity="0.2"; b.disabled=true; });
      btn.style.opacity="1"; btn.style.transform="scale(1.4)";
      const thanks = document.createElement("span");
      thanks.className = "s-react-thanks"; thanks.textContent = "Noted ✓";
      row.appendChild(thanks);
      if (["upset","anxious","angry"].includes(reaction) && extracted.theme) showSensitivityHint(extracted.theme);
    });
  });
  container.appendChild(row);
}

function showSensitivityHint(theme) {
  const themeToKey = { "fitness / diet":"sensitive_diet","finance / crypto":"sensitive_finance","politics / news":"sensitive_politics","gambling":"sensitive_addiction","nightlife / alcohol":"sensitive_addiction","mental health / wellness":"sensitive_mental" };
  const prefKey = themeToKey[theme];
  if (!prefKey || userPrefs[prefKey]) return;
  const hint = document.createElement("div");
  hint.style.cssText = "position:fixed;bottom:100px;left:28px;z-index:99999;background:#fff;color:#1E1B4B;font-size:11px;padding:14px 16px;border-radius:14px;border:1.5px solid #DDD6FE;max-width:260px;font-family:'Nunito',sans-serif;box-shadow:0 8px 30px rgba(99,102,241,0.18);animation:s-slide-in 0.3s ease;";
  const label = theme.split("/")[0].trim();
  hint.innerHTML = `<div style="font-weight:900;margin-bottom:6px;font-size:13px">💡 Sensitivity tip</div><div style="color:#6B7280;line-height:1.5">You seem affected by <strong style="color:#1E1B4B">${label}</strong> content. Enable enhanced sensitivity to get earlier warnings.</div><div style="display:flex;gap:8px;margin-top:10px"><button id="s-hint-enable" style="background:#6366F1;color:#fff;border:none;border-radius:8px;padding:6px 12px;font-size:11px;font-weight:800;cursor:pointer;font-family:'Nunito',sans-serif">Enable</button><button id="s-hint-dismiss" style="background:none;color:#9CA3AF;border:1.5px solid #E5E7EB;border-radius:8px;padding:6px 12px;font-size:11px;font-weight:700;cursor:pointer;font-family:'Nunito',sans-serif">Dismiss</button></div>`;
  document.body.appendChild(hint);
  hint.querySelector("#s-hint-enable").addEventListener("click", () => { userPrefs[prefKey]=true; savePrefs(); syncSettingsUI(); hint.remove(); });
  hint.querySelector("#s-hint-dismiss").addEventListener("click", () => hint.remove());
  setTimeout(() => hint.remove(), 12000);
}

function isSuspiciousLink(href) {
  if (!href) return false;
  try {
    const url = new URL(href);
    if (/bit\.ly|tinyurl|t\.co|goo\.gl/i.test(url.hostname)) return true;
    if (/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(url.hostname)) return true;
    if (/login|signin|verify|confirm|update|secure|account|password/i.test(url.pathname)) return true;
    const known = ["paypal.com","amazon.com","apple.com","google.com","microsoft.com","netflix.com"];
    if (/paypal|amazon|apple|google|microsoft|netflix/i.test(url.hostname) && !known.some(d => url.hostname.endsWith(d))) return true;
  } catch { return false; }
  return false;
}

function runUrlChecks() {
  const checks = {
    "chip-https":  location.protocol === "https:",
    "chip-typo":   !isTyposquat(location.hostname),
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
  const base = hostname.replace(/\.[^.]+$/, "");
  return targets.some(t => t !== base && levenshtein(base, t) <= 2);
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({length:m+1},(_,i)=>Array.from({length:n+1},(_,j)=>i===0?j:j===0?i:0));
  for(let i=1;i<=m;i++) for(let j=1;j<=n;j++) dp[i][j]=a[i-1]===b[j-1]?dp[i-1][j-1]:1+Math.min(dp[i-1][j],dp[i][j-1],dp[i-1][j-1]);
  return dp[m][n];
}

function hasUrgencyPatterns() {
  const t = document.body.innerText.toLowerCase();
  return ["act now","limited time","expires today","account suspended","verify immediately","urgent action required"].some(p => t.includes(p));
}

function hasDataHarvestForms() {
  for (const f of document.querySelectorAll("form")) {
    if (f.querySelectorAll('input[type="password"],input[name*="card"],input[name*="ssn"]').length > 0) return true;
  }
  return false;
}

// ── Highlights ────────────────────────────────────────────────────────────────
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
    span.setAttribute("data-sentinel","1");
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
  return { toxicity:"Toxic language", manipulation:"Manipulation tactic", misinfo:"Misinfo pattern", ai:"AI-generated text", scam:"Scam pattern", phishing:"Phishing attempt" }[type] || "Flagged";
}

function clearHighlights() {
  [...document.querySelectorAll(".sentinel-hl[data-sentinel]")].forEach(el => {
    const parent = el.parentNode;
    if (!parent) return;
    parent.replaceChild(document.createTextNode(el.childNodes[0]?.textContent || el.textContent), el);
  });
  document.body.normalize();
  document.querySelectorAll(".s-post-outline").forEach(el => el.classList.remove("s-post-outline","s-post-harmful","s-post-clean"));
  document.querySelectorAll(".s-img-overlay").forEach(el => el.remove());
}

function setStatus(mode, msg) {
  const map = { toxicity: ["tox-status","tox-dot"], misinfo: ["mis-status","mis-dot"], scam: ["scam-status","scam-dot"] };
  const [statusId, dotId] = map[mode] || [];
  const el  = document.getElementById(statusId);
  const dot = document.getElementById(dotId);
  if (el) el.textContent = msg;
  if (dot) {
    const isScanning = msg.includes("Scanning");
    const hasFlags   = msg.includes("flag");
    dot.className = "s-status-dot" + (isScanning ? " s-dot-active" : hasFlags ? " s-dot-warn" : "");
  }
}

// ── Image detection ───────────────────────────────────────────────────────────
let imgHoverTimer = null, currentImgEl = null;
function toggleImageDetect(on) {
  if (on) { document.addEventListener("mouseover", onImgHover); document.addEventListener("mouseout", onImgOut); }
  else    { document.removeEventListener("mouseover", onImgHover); document.removeEventListener("mouseout", onImgOut); hideImgTooltip(); }
}
function onImgHover(e) {
  const img = e.target.closest("img");
  if (!img || img.closest("#sentinel-root") || img === currentImgEl) return;
  currentImgEl = img; clearTimeout(imgHoverTimer);
  imgHoverTimer = setTimeout(() => analyzeImage(img), 600);
}
function onImgOut(e) {
  clearTimeout(imgHoverTimer);
  if (e.relatedTarget?.closest("#s-img-tooltip") || e.relatedTarget === currentImgEl) return;
  currentImgEl = null; hideImgTooltip();
}
function hideImgTooltip() { const t = document.getElementById("s-img-tooltip"); if (t) t.style.display = "none"; }

async function analyzeImage(img) {
  const tip = document.getElementById("s-img-tooltip");
  if (!tip) return;

  // Show tooltip immediately with loading state
  const rect = img.getBoundingClientRect();
  tip.style.display = "block";
  tip.style.left = Math.min(rect.left + window.scrollX, window.innerWidth - 250) + "px";
  tip.style.top  = (rect.bottom + window.scrollY + 8) + "px";
  document.getElementById("img-tip-verdict").textContent = "Scanning image…";
  document.getElementById("img-tip-bar").style.width = "15%";
  document.getElementById("img-tip-signals").innerHTML = "";

  try {
    // Convert image to base64 via canvas
    const canvas  = document.createElement("canvas");
    const MAX_DIM = 800;
    const w = Math.min(img.naturalWidth  || img.width  || 400, MAX_DIM);
    const h = Math.min(img.naturalHeight || img.height || 400, MAX_DIM);
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, w, h);

    let b64 = "", mediaType = "image/jpeg";
    try {
      b64 = canvas.toDataURL("image/jpeg", 0.75).split(",")[1];
    } catch(corsErr) {
      // Cross-origin image — send URL + context instead
      console.info("[Sentinel] Cross-origin image, sending URL to Gemini");
    }

    // Gather surrounding context for extra signal
    const context = [
      img.alt || "",
      img.title || "",
      img.parentElement?.innerText?.slice(0, 150) || "",
    ].join(" ").trim();

    const resp = await fetch(CREATOR_API_URL.replace("analyze-creator", "analyze-image"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image_b64:  b64,
        media_type: mediaType,
        image_url:  b64 ? "" : (img.src || img.currentSrc || ""),
        context,
      }),
    });

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();

    const pct = Math.round((data.ai_probability || 0) * 100);
    const bar = document.getElementById("img-tip-bar");
    if (bar) {
      bar.style.width      = pct + "%";
      bar.style.background = pct > 65 ? "#7C3AED" : pct > 35 ? "#D97706" : "#059669";
    }

    const verdictMap = {
      ai_generated:  "AI-generated image",
      likely_ai:     "Likely AI-generated",
      uncertain:     "Uncertain — could be either",
      likely_real:   "Likely a real photograph",
      real:          "Real photograph / human-made",
    };
    document.getElementById("img-tip-verdict").textContent =
      `${verdictMap[data.verdict] || data.verdict} (${pct}% AI)` +
      (data.explanation ? `\n${data.explanation}` : "");

    const sigEl = document.getElementById("img-tip-signals");
    if (sigEl && data.signals?.length) {
      sigEl.innerHTML = data.signals.map(s => `<span class="s-sig-chip">${s}</span>`).join("");
    }

    // Fire toast for high-confidence AI images
    if (pct > 65 && data.confidence !== "low") {
      showToast({
        level:   "medium",
        title:   "AI-Generated Image Detected",
        message: data.explanation || `This image is ${pct}% likely AI-generated.`,
        icon:    "image",
      });
    }

  } catch(e) {
    console.warn("[Sentinel] Image analysis error:", e);
    // Fallback to heuristics
    const signals = detectImageSignals(img);
    const pct = Math.round(signals.aiScore * 100);
    const bar = document.getElementById("img-tip-bar");
    if (bar) bar.style.width = pct + "%";
    document.getElementById("img-tip-verdict").textContent =
      signals.aiScore > 0.65 ? "Likely AI-generated (heuristic)" :
      signals.aiScore > 0.35 ? "Possibly AI-generated (heuristic)" : "Likely real photograph";
    const sigEl = document.getElementById("img-tip-signals");
    if (sigEl) sigEl.innerHTML = signals.labels.map(s => `<span class="s-sig-chip">${s}</span>`).join("");
  }
}

function detectImageSignals(img) {
  const labels = []; let score = 0;
  const src = (img.src || img.currentSrc || "").toLowerCase();
  if (["thispersondoesnotexist","midjourney","stable-diffusion","dall-e","firefly","civitai","leonardo.ai","artbreeder"]
      .some(s => src.includes(s))) { score += 0.6; labels.push("AI source URL"); }
  const w = img.naturalWidth, h = img.naturalHeight;
  if (w && h) {
    if ([512,768,1024,1280,1536,2048].includes(w) || [512,768,1024,1280,1536,2048].includes(h))
      { score += 0.25; labels.push("AI-standard resolution"); }
  }
  const alt = (img.alt || img.title || "").toLowerCase();
  if (["generated","ai art","prompt","diffusion","midjourney","dall-e","made with ai"].some(p => alt.includes(p)))
    { score += 0.35; labels.push("AI descriptor in alt text"); }
  const ctx = (img.parentElement?.innerText || "").toLowerCase();
  if (["ai generated","stable diffusion","midjourney","made with ai"].some(p => ctx.includes(p)))
    { score += 0.4; labels.push("AI context on page"); }
  if (["photo by","©","canon","nikon","shot on iphone","f/","iso "].some(p => ctx.includes(p)))
    { score -= 0.2; labels.push("Camera metadata nearby"); }
  if (!labels.length) labels.push("No strong signals detected");
  return { aiScore: Math.max(0, Math.min(1, score)), labels };
}

function showImgTooltip(img, score, verdict, signals) {
  const tip = document.getElementById("s-img-tooltip"); if (!tip) return;
  const pct = Math.round(score * 100);
  const bar = document.getElementById("img-tip-bar");
  if (bar) { bar.style.width = pct+"%"; bar.style.background = pct > 65 ? "#7C3AED" : pct > 35 ? "#D97706" : "#059669"; }
  const vEl = document.getElementById("img-tip-verdict"); if (vEl) vEl.textContent = verdict;
  const sEl = document.getElementById("img-tip-signals"); if (sEl) sEl.innerHTML = signals.map(s => `<span class="s-sig-chip">${s}</span>`).join("");
}

// ── Text AI checker — powered by Gemini ──────────────────────────────────────
const TEXT_AI_API = API_URL.replace("analyze-text", "analyze-text-ai");
let selTimer = null;

function toggleTextAi(on) {
  if (on) document.addEventListener("mouseup", onTextSelect);
  else {
    document.removeEventListener("mouseup", onTextSelect);
    const r = document.getElementById("ai-text-result");
    if (r) r.style.display = "none";
  }
}

function onTextSelect() {
  clearTimeout(selTimer);
  selTimer = setTimeout(async () => {
    const sel  = window.getSelection();
    const text = sel?.toString().trim();
    if (!text || text.length < 60) return;
    if (sel.anchorNode?.parentElement?.closest("#sentinel-root")) return;

    const res = document.getElementById("ai-text-result"); if (!res) return;
    res.style.display = "block";
    const bar     = document.getElementById("ai-text-bar");
    const pctEl   = document.getElementById("ai-text-pct");
    const verdict = document.getElementById("ai-text-verdict");
    const sigEl   = document.getElementById("ai-text-signals");
    if (pctEl)   pctEl.textContent   = "…";
    if (verdict) verdict.textContent = "Identifying flags…";
    if (bar)     bar.style.width     = "10%";
    if (sigEl)   sigEl.innerHTML     = "";

    try {
      const resp = await fetch(TEXT_AI_API, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ text, context: `Selected from: ${document.title} (${location.hostname})` }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();

      const pct = Math.round((data.ai_probability || 0) * 100);
      if (bar) {
        bar.style.width      = pct + "%";
        bar.style.background = pct > 65 ? "#7C3AED" : pct > 35 ? "#D97706" : "#059669";
      }
      if (pctEl)   pctEl.textContent   = pct + "%";

      const verdictMap = {
        ai_generated:  "Very likely written by AI",
        likely_ai:     "Likely AI-generated text",
        uncertain:     "Uncertain — mixed signals",
        likely_human:  "Likely written by a human",
        human:         "Almost certainly human-written",
      };
      if (verdict) verdict.textContent =
        (verdictMap[data.verdict] || data.verdict) +
        (data.explanation ? ` — ${data.explanation}` : "");

      if (sigEl && data.signals?.length) {
        sigEl.innerHTML = data.signals.map(s => `<span class="s-ai-signal-chip">${s}</span>`).join("");
      }

      // Toast for high-confidence AI text
      if (pct > 70 && data.confidence !== "low") {
        showToast({
          level:   "medium",
          title:   "AI-Written Text Detected",
          message: `${pct}% likely AI-generated. ${data.signals?.[0] || ""}`,
          icon:    "cpu",
        });
      }
    } catch(e) {
      if (verdict) verdict.textContent = "Could not reach backend.";
      console.warn("[Sentinel] Text AI error:", e);
    }
  }, 500);
}

// ── Toast notification system ─────────────────────────────────────────────────
const TOAST_ICONS = {
  alertTri: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
  shield:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`,
  check:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><polyline points="20 6 9 17 4 12"/></svg>`,
  image:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`,
  cpu:      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/></svg>`,
  lock:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>`,
  x:        `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
};

function showToast({ level = "medium", title, message, icon = "alertTri", duration = 6000 }) {
  // Respect threshold preference — don't show "low" toasts if user wants medium+
  const thresholdMap = { low: 0, medium: 1, high: 2 };
  const levelMap     = { low: 0, medium: 1, high: 2 };
  const userThresh   = thresholdMap[userPrefs?.alert_threshold || "medium"] || 1;
  if (levelMap[level] < userThresh) return;

  let container = document.getElementById("s-toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "s-toast-container";
    document.body.appendChild(container);
  }

  const toast = document.createElement("div");
  toast.className = `s-toast s-toast-${level}`;
  toast.innerHTML = `
    <div class="s-toast-icon">${TOAST_ICONS[icon] || TOAST_ICONS.alertTri}</div>
    <div class="s-toast-body">
      <div class="s-toast-title">${title}</div>
      <div class="s-toast-msg">${message}</div>
      <div class="s-toast-bar" style="animation-duration:${duration}ms"></div>
    </div>
    <button class="s-toast-close" aria-label="Dismiss">${TOAST_ICONS.x}</button>
  `;

  container.appendChild(toast);

  const dismiss = () => {
    toast.classList.add("s-toast-out");
    toast.addEventListener("animationend", () => toast.remove(), { once: true });
  };
  toast.querySelector(".s-toast-close").addEventListener("click", dismiss);
  setTimeout(dismiss, duration);
}

// Call showToast after scan results for high/medium severity
function maybeToastScanResult(data, mode) {
  const sev = data.overall_severity || "clean";
  if (sev === "clean" || sev === "low") return;

  const modeConfig = {
    toxicity: { icon: "alertTri", title: "Toxic Content Detected" },
    misinfo:  { icon: "shield",   title: "Misinformation Detected" },
    scam:     { icon: "lock",     title: "Scam / Phishing Detected" },
  };
  const cfg = modeConfig[mode] || { icon: "alertTri", title: "Issue Detected" };
  const summary = data.reasoning?.summary || `${lastFlags.length} flag(s) found on this page.`;

  showToast({
    level:   sev === "high" ? "high" : "medium",
    title:   cfg.title,
    message: summary.slice(0, 120),
    icon:    cfg.icon,
    duration: sev === "high" ? 9000 : 6000,
  });
}

// ── MutationObserver ──────────────────────────────────────────────────────────
const observer = new MutationObserver(() => {
  if (observerPaused || !activeMode) return;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => runScan(activeMode), DEBOUNCE_MS);
});

// ── SPA URL change watcher ────────────────────────────────────────────────────
// Resets creator scan state when navigating to a new post (YouTube, TikTok, IG)
let _lastHref = location.href;
const urlWatcher = new MutationObserver(() => {
  if (location.href !== _lastHref) {
    _lastHref = location.href;
    creatorScanDone = false;
    document.getElementById("sentinel-creator-banner")?.remove();
    creatorBannerEl = null;
    // Re-run creator scan after DOM settles on new page
    setTimeout(() => {
      const extracted = extractText();
      if (extracted.platform && extracted.platform !== "unknown") {
        runCreatorScan(extracted).catch(() => {});
      }
    }, 2000);
  }
});
urlWatcher.observe(document.body, { childList: true, subtree: true });

loadPrefs();
loadBehaviorLog();
injectUI();
document.addEventListener("mouseup", () => setTimeout(capturePageSelection, 0), true);
document.addEventListener("keyup", () => setTimeout(capturePageSelection, 0), true);
observer.observe(document.body, { childList: true, subtree: true });

// Auto-run creator scan on social platforms immediately on page load
setTimeout(() => {
  const extracted = extractText();
  if (extracted.platform && extracted.platform !== "unknown") {
    runCreatorScan(extracted).catch(() => {});
  }
}, 3000);
