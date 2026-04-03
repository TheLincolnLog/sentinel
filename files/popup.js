// popup.js
chrome.storage.local.get("sentinelScores", ({ sentinelScores }) => {
  if (!sentinelScores) return;

  const pct = v => Math.round((v || 0) * 100);

  const m = pct(sentinelScores.manipulation);
  const t = pct(sentinelScores.toxicity);
  const i = pct(sentinelScores.misinfo);

  document.getElementById("bar-m").style.width = m + "%";
  document.getElementById("bar-t").style.width = t + "%";
  document.getElementById("bar-i").style.width = i + "%";

  document.getElementById("val-m").textContent = m + "%";
  document.getElementById("val-t").textContent = t + "%";
  document.getElementById("val-i").textContent = i + "%";

  document.getElementById("status").textContent =
    m > 60 || t > 60 || i > 60
      ? "⚠️ High risk content detected"
      : m > 30 || t > 30 || i > 30
      ? "🟡 Some risk signals found"
      : "✅ Page looks relatively clean";
});
