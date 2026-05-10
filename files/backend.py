# backend.py — Sentinel v8
# Architecture:
#   1. ML model + keyword lists → instant flags for page highlighting (fast first-pass)
#   2. Groq (llama-3.3-70b)    → primary text scores + reasoning (authoritative judge)
#   3. Groq vision via GPT-4o  → AI image detection
#   4. Groq text-AI detector   → dedicated AI text detection
#
# Run:     uvicorn backend:app --reload
# Install: pip install fastapi uvicorn scikit-learn joblib httpx
# Set env: export GROQ_API_KEY="your-key-here"
# Get key: console.groq.com (free, no credit card)

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional
import re, os, math, joblib, hashlib, json
import httpx

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["POST", "GET"],
    allow_headers=["Content-Type"],
)

# ── AI config — Groq (free tier: 14,400 req/day, 30 RPM, no card needed) ─────
GROQ_API_KEY  = os.environ.get("GROQ_API_KEY", "")
GROQ_URL      = "https://api.groq.com/openai/v1/chat/completions"
GROQ_MODEL    = "llama-3.3-70b-versatile"   # best free model on Groq
GROQ_RPM_LIMIT = 25   # safely under Groq's 30 RPM free limit

# OpenAI fallback. Used when Groq/Gemini are unset, rate-limited, or fail.
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
OPENAI_URL     = "https://api.openai.com/v1/chat/completions"
OPENAI_MODEL   = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")

# Keep GEMINI_API_KEY as fallback if user still has it set
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_BASE    = "https://generativelanguage.googleapis.com/v1/models"
GEMINI_URL     = f"{GEMINI_BASE}/gemini-2.0-flash:generateContent"
GEMINI_VIS_URL = f"{GEMINI_BASE}/gemini-2.0-flash:generateContent"

# Primary key — use Groq if available, fall back to Gemini
USE_GROQ = bool(GROQ_API_KEY)

# ── Rate limiter ──────────────────────────────────────────────────────────────
import asyncio, time, hashlib as _hs
from collections import deque

_request_times: deque = deque()
_rate_lock = asyncio.Lock()

async def _rate_wait():
    """Block until safely under RPM limit for whichever provider is active."""
    limit = GROQ_RPM_LIMIT if USE_GROQ else 10
    async with _rate_lock:
        now = time.monotonic()
        while _request_times and now - _request_times[0] > 60:
            _request_times.popleft()
        if len(_request_times) >= limit:
            wait_for = 61 - (now - _request_times[0])
            if wait_for > 0:
                await asyncio.sleep(wait_for)
        _request_times.append(time.monotonic())

# ── Response cache — avoid re-calling Gemini for identical content ────────────
# Key: sha256 of (prompt_type + first 500 chars of content)
# TTL: 10 minutes
_response_cache: dict = {}
CACHE_TTL = 600  # seconds

def _cache_key(prefix: str, content: str) -> str:
    return _hs.sha256(f"{prefix}:{content[:500]}".encode()).hexdigest()

def _cache_get(key: str):
    entry = _response_cache.get(key)
    if entry and time.monotonic() - entry["ts"] < CACHE_TTL:
        return entry["val"]
    return None

def _cache_set(key: str, val):
    _response_cache[key] = {"val": val, "ts": time.monotonic()}
    # Prune if cache grows large
    if len(_response_cache) > 200:
        oldest = min(_response_cache, key=lambda k: _response_cache[k]["ts"])
        del _response_cache[oldest]

# ── Load ML model ─────────────────────────────────────────────────────────────
MODEL_PATH = os.path.join(os.path.dirname(__file__), "model.pkl")
ml_features = ml_classifier = None
whitelist = []
model_info = {}

if os.path.exists(MODEL_PATH):
    try:
        bundle = joblib.load(MODEL_PATH)
        if isinstance(bundle, dict):
            if "features" in bundle:
                ml_features   = bundle["features"]
                ml_classifier = bundle["model"]
                whitelist     = bundle.get("whitelist", [])
                model_info    = {"epochs": bundle.get("epochs", "?"), "val_acc": bundle.get("val_acc", "?")}
            else:
                ml_classifier = bundle["model"]
                whitelist     = bundle.get("whitelist", [])
        else:
            ml_classifier = bundle
        print(f"✓  ML model loaded  val_acc={model_info.get('val_acc', '?')}")
    except Exception as e:
        print(f"⚠  model.pkl error: {e}")
else:
    print("⚠  model.pkl not found — keyword fallback only")

def predict_toxic(text):
    if ml_classifier is None: return 0.0
    c = clean(text)
    try:
        if ml_features is not None:
            return float(ml_classifier.predict_proba(ml_features.transform([c]))[0][1])
        return float(ml_classifier.predict_proba([c])[0][1])
    except: return 0.0

# ── Keyword lists (used for highlight flags only, NOT for final scores) ────────
MANIPULATION_PHRASES = [
    "shocking","shocking truth","they don't want you to know","act now",
    "you won't believe","breaking","urgent","limited time","exclusive",
    "secret","what they're hiding","wake up","open your eyes",
    "share before it's deleted","doctors hate","one weird trick",
    "miracle","guaranteed","what the media won't tell you",
    "do your own research","sheeple",
]
MISINFO_PHRASES = [
    "100%","proven fact","scientists confirm","definitive proof",
    "nobody is talking about","mainstream media won't report",
    "cover-up","the truth is","hoax","fake news","they're lying",
    "completely safe","totally harmless","cure for","deep state",
    "plandemic","staged","crisis actor","false flag",
]
TOXICITY_KEYWORDS = [
    "idiot","moron","stupid","dumb","loser","pathetic","worthless",
    "disgusting","trash","scum","filth","kill yourself","kys","go die",
    "nobody likes you","waste of space",
]
SOCIAL_HARMFUL = [
    "ratio","nobody asked","get ratio'd","cope harder","stay mad",
    "you're irrelevant","delete this","get off the internet",
    "nobody cares about you","touch grass loser","imagine being this dumb",
]
SCAM_PHRASES = [
    "act immediately","your account has been suspended","verify your account",
    "unusual activity detected","confirm your identity","click here to verify",
    "your account will be closed","immediate action required",
    "failure to verify","login attempt","security alert",
    "you have been selected","congratulations you won","claim your prize",
    "free gift","you are the winner","send your details",
    "wire transfer","western union","gift card","bitcoin payment",
    "nigerian prince","inheritance funds","lottery winner",
    "enter your password","confirm your password","social security",
    "credit card number","bank account number","date of birth",
    "mother's maiden name","security question",
    "irs notice","irs final notice","fbi warning","microsoft support",
    "apple support","amazon security","paypal security",
    "your computer is infected","technical support","call this number",
    "make money fast","work from home","earn $","passive income",
    "no experience needed","financial freedom","risk free",
    "double your investment","100% profit",
]
PHISHING_PATTERNS = [
    "click the link below","click here now","verify now","confirm now",
    "download the attachment","open the attached","enable macros",
    "your package is waiting","tracking number","failed delivery",
    "update your billing","payment failed","subscription cancelled",
    "your netflix","your amazon prime","your apple id",
]

# Stronger local detectors used when Groq/Gemini are unavailable, and as a
# safety floor when the cloud model under-scores obvious threats.
TOXIC_REGEX_PATTERNS = [
    r"\b(kill yourself|kys|go die|end your life)\b",
    r"\b(nobody|no one)\s+(likes|loves|cares about|wants)\s+you\b",
    r"\byou\s+(are|re|look|sound)\s+(worthless|pathetic|disgusting|trash|stupid|ugly|useless)\b",
    r"\b(shut up|delete this|get lost|go away)\b.*\b(idiot|moron|loser|freak)\b",
    r"\b(i hope|hope you)\b.*\b(suffer|die|fail|get hurt|bad things happen)\b",
]
SCAM_REGEX_PATTERNS = [
    r"\b(verify|confirm|update|unlock|secure)\s+(your\s+)?(account|identity|wallet|billing|payment)\b",
    r"\b(account|card|wallet|subscription)\s+(has been\s+)?(suspended|locked|limited|cancelled|restricted)\b",
    r"\b(send|provide|enter|confirm)\s+(your\s+)?(password|pin|otp|2fa|ssn|social security|credit card|bank)\b",
    r"\b(gift card|wire transfer|western union|moneygram|bitcoin|crypto)\b.*\b(pay|payment|fee|release|unlock)\b",
    r"\b(guaranteed|risk free|double your|100% profit|no risk)\b.*\b(invest|return|income|profit|money)\b",
    r"\b(urgent|immediate|within 24 hours|final notice|act now)\b.*\b(account|payment|verify|respond)\b",
]
MISINFO_REGEX_PATTERNS = [
    r"\b(doctors|scientists|experts)\s+(hate|are hiding|don't want you to know)\b",
    r"\b(cure|treatment)\s+for\s+(cancer|diabetes|autism|covid|all diseases)\b",
    r"\b(vaccines?|5g|climate change|election)\s+(are|is)\s+(a\s+)?(hoax|fake|scam|plandemic)\b",
    r"\b(100%|guaranteed|proven)\s+(safe|harmless|effective|truth|fact)\b",
    r"\b(mainstream media|government|deep state|they)\s+(won't|will not|don't|do not)\s+(tell|report|admit)\b",
    r"\b(studies show|research proves|data confirms)\b(?![^.?!]{0,120}\bhttps?://)",
]
MANIPULATION_REGEX_PATTERNS = [
    r"\b(act now|limited time|last chance|before it's deleted|share before)\b",
    r"\b(they don't want you to know|what they are hiding|wake up|open your eyes)\b",
    r"\b(secret|exclusive|shocking truth|you won't believe|miracle)\b",
]
AI_TRANSITIONS = [
    "furthermore","moreover","in conclusion","it is worth noting",
    "it's worth noting","it is important to","in summary","to summarize",
    "in addition","as a result","consequently","nevertheless",
    "on the other hand","it should be noted","this highlights",
    "this demonstrates","this underscores","plays a crucial role",
    "it is essential","needless to say","in the realm of",
    "dive into","delve into","leverage","game-changer",
    "at the end of the day","moving forward","going forward","in terms of",
]
AI_HEDGES = [
    "it is worth noting","it should be noted","importantly","significantly",
    "ultimately","essentially","fundamentally","in essence","at its core",
    "by and large","for the most part","in many ways","in a sense","to some extent",
]

# ── Helpers ───────────────────────────────────────────────────────────────────
def clean(text):
    text = text.lower()
    text = re.sub(r"http\S+", "", text)
    text = re.sub(r"@\w+", "", text)
    text = re.sub(r"[^a-z0-9\s!?.,']", " ", text)
    return re.sub(r"\s+", " ", text).strip()

def is_whitelisted(text):
    return any(w in text.lower() for w in whitelist)

def keyword_score(text, phrases):
    t = text.lower()
    word_count = max(len(t.split()), 1)
    matched = [p for p in phrases if p.lower() in t]
    caps = len(re.findall(r'\b[A-Z]{4,}\b', text))
    density_bonus = min(len(matched) / (word_count / 50), 0.3)
    weight = len(matched) + caps * 0.5 + density_bonus
    return round(min(weight / max(len(phrases) * 0.3, 1), 1.0), 3), matched

def build_flags(phrases, flag_type, base_score=None):
    seen = set()
    flags = []
    for p in phrases:
        key = hashlib.md5(f"{flag_type}:{p.lower()}".encode()).hexdigest()
        if key in seen: continue
        seen.add(key)
        score = base_score or round(min(0.5 + len(p) / 200, 0.95), 3)
        severity = "high" if score > 0.7 else "medium" if score > 0.4 else "low"
        flags.append({"phrase": p, "type": flag_type, "score": score, "severity": severity})
    return flags

def regex_matches(text, patterns):
    matches = []
    for pattern in patterns:
        for match in re.finditer(pattern, text, flags=re.IGNORECASE):
            phrase = re.sub(r"\s+", " ", match.group(0)).strip()
            if phrase:
                matches.append(phrase[:120])
    return matches

def score_from_signals(text, phrase_hits=None, regex_hits=None, url_hits=0):
    phrase_hits = phrase_hits or []
    regex_hits = regex_hits or []
    word_count = max(len(text.split()), 1)
    density = (len(phrase_hits) * 0.18 + len(regex_hits) * 0.32 + url_hits * 0.24)
    length_bonus = 0.08 if word_count < 80 and (phrase_hits or regex_hits or url_hits) else 0.0
    repeated_bonus = min(max(len(phrase_hits) + len(regex_hits) - 2, 0) * 0.08, 0.22)
    return round(min(density + length_bonus + repeated_bonus, 0.98), 3)

def local_risk_analysis(text, url=""):
    """Category-aware local risk model for offline accuracy and cloud-score floors."""
    t = text or ""
    lowered = t.lower()

    _, manip_phrase_hits = keyword_score(t, MANIPULATION_PHRASES)
    _, mis_phrase_hits = keyword_score(t, MISINFO_PHRASES)
    _, scam_phrase_hits = keyword_score(t, SCAM_PHRASES + PHISHING_PATTERNS)
    _, tox_phrase_hits = keyword_score(t, TOXICITY_KEYWORDS + SOCIAL_HARMFUL)

    tox_regex_hits = regex_matches(t, TOXIC_REGEX_PATTERNS)
    scam_regex_hits = regex_matches(t, SCAM_REGEX_PATTERNS)
    mis_regex_hits = regex_matches(t, MISINFO_REGEX_PATTERNS)
    manip_regex_hits = regex_matches(t, MANIPULATION_REGEX_PATTERNS)

    url_hits = 0
    if url:
        url_lower = url.lower()
        if re.search(r"\d{1,3}(?:\.\d{1,3}){3}", url_lower): url_hits += 2
        if re.search(r"bit\.ly|tinyurl|t\.co|goo\.gl|ow\.ly|short\.|rebrand\.ly", url_lower): url_hits += 1
        if re.search(r"(login|signin|verify|confirm|secure|account|wallet)", url_lower): url_hits += 1
        if re.search(r"paypal|apple|amazon|microsoft|netflix|bank|irs", url_lower) and re.search(r"[-_].*[-_]|\.xyz|\.top|\.click|\.info", url_lower):
            url_hits += 1

    sentence_scores = []
    if ml_classifier is not None:
        for sent in split_sentences(t):
            if not is_whitelisted(sent):
                sentence_scores.append(predict_toxic(sent))
    ml_toxic_floor = max(sentence_scores) if sentence_scores else predict_toxic(t)

    toxicity = max(
        ml_toxic_floor,
        score_from_signals(t, tox_phrase_hits, tox_regex_hits),
    )
    scam = score_from_signals(t, scam_phrase_hits, scam_regex_hits, url_hits=url_hits)
    misinfo = score_from_signals(t, mis_phrase_hits, mis_regex_hits)
    manipulation = score_from_signals(t, manip_phrase_hits, manip_regex_hits)
    ai_score, ai_flags = compute_ai_signals(t)

    if any(re.search(r"\b(kill yourself|kys|go die|end your life)\b", h, re.I) for h in tox_regex_hits + tox_phrase_hits):
        toxicity = max(toxicity, 0.88)
    if any(re.search(r"\b(password|pin|otp|2fa|ssn|social security|credit card|bank)\b", h, re.I) for h in scam_regex_hits + scam_phrase_hits):
        scam = max(scam, 0.86)
    if any(re.search(r"\b(account|wallet|billing|payment)\b", h, re.I) for h in scam_regex_hits + scam_phrase_hits) and url_hits:
        scam = max(scam, 0.78)
    if any(re.search(r"\b(cure for|hoax|plandemic|false flag|crisis actor)\b", h, re.I) for h in mis_regex_hits + mis_phrase_hits):
        misinfo = max(misinfo, 0.72)

    # Source links reduce misinformation uncertainty; scam/toxicity should not be softened.
    if re.search(r"https?://", t) and misinfo < 0.7:
        misinfo = round(max(0.0, misinfo - 0.12), 3)

    flags = []
    flags += build_flags(tox_phrase_hits + tox_regex_hits, "toxicity", toxicity)
    flags += build_flags(scam_phrase_hits + scam_regex_hits, "scam", scam)
    flags += build_flags([h for h in scam_phrase_hits + scam_regex_hits if "verify" in h.lower() or "password" in h.lower() or "account" in h.lower()], "phishing", max(scam, 0.65))
    flags += build_flags(mis_phrase_hits + mis_regex_hits, "misinfo", misinfo)
    flags += build_flags(manip_phrase_hits + manip_regex_hits, "manipulation", manipulation)
    flags += ai_flags

    if "http" in lowered and re.search(r"\b(password|account|billing|wallet|verify|confirm)\b", lowered):
        flags.append({"phrase": "Link asks for account or payment action", "type": "phishing", "score": max(scam, 0.7), "severity": "high"})

    return {
        "toxicity": min(float(toxicity), 0.98),
        "manipulation": min(float(manipulation), 0.98),
        "misinfo": min(float(misinfo), 0.98),
        "ai_score": min(float(ai_score), 0.98),
        "scam_score": min(float(scam), 0.98),
        "flags": deduplicate_flags(flags)[:25],
    }

def split_sentences(text):
    return [p.strip() for p in re.split(r'(?<=[.!?])\s+', text) if len(p.strip()) > 8]

def deduplicate_flags(flags):
    seen = set()
    out = []
    for f in flags:
        key = re.sub(r'\s+', ' ', f["phrase"].lower().strip())[:60]
        if key not in seen:
            seen.add(key)
            out.append(f)
    return out

def compute_ai_signals(text):
    """Heuristic AI text detection — for highlight flags only, Gemini score overrides."""
    if len(text.strip()) < 80: return 0.0, []
    signals, flags = {}, []
    text_lower = text.lower()
    word_count = max(len(text.split()), 1)
    sentences = [s.strip() for s in re.split(r'[.!?]+', text) if len(s.strip()) > 5]
    if len(sentences) >= 4:
        lengths = [len(s.split()) for s in sentences]
        mean_l = sum(lengths) / len(lengths)
        variance = sum((l - mean_l) ** 2 for l in lengths) / len(lengths)
        cv = math.sqrt(variance) / mean_l if mean_l > 0 else 1.0
        signals["low_burstiness"] = max(0.0, 1.0 - cv * 2)
    hits = [p for p in AI_TRANSITIONS if p in text_lower]
    density = len(hits) / (word_count / 100)
    signals["transitions"] = min(density / 3, 1.0)
    for p in hits[:4]:
        flags.append({"phrase": p, "type": "ai", "score": round(min(density / 3, 1.0), 3), "severity": "low"})
    hedges = [p for p in AI_HEDGES if p in text_lower]
    signals["hedges"] = min(len(hedges) / (word_count / 100) / 2, 1.0)
    weights = {"low_burstiness": 0.35, "transitions": 0.35, "hedges": 0.30}
    total_w = sum(weights[k] for k in signals)
    if total_w == 0: return 0.0, []
    score = sum(signals[k] * weights[k] for k in signals) / total_w
    return round(min(score, 1.0), 3), flags

def compute_overall_severity(tox, mis, scam, manip):
    top = max(tox, mis, scam, manip)
    if top > 0.65: return "high"
    if top > 0.35: return "medium"
    if top > 0.1:  return "low"
    return "clean"

# ── Fast first-pass: ML + keywords → flags for page highlighting ──────────────
def run_fast_pass(text, url=""):
    """
    Runs instantly. Produces flags used for highlight overlays on the page.
    Does NOT determine final scores — Gemini handles that.
    """
    flags = []

    # ML toxicity: sentence-level detection
    if ml_classifier is not None:
        seen = set()
        for sent in split_sentences(text):
            if is_whitelisted(sent): continue
            score = predict_toxic(sent)
            if score > 0.55:
                phrase = sent[:120]
                key = phrase.lower().strip()
                if key in seen: continue
                seen.add(key)
                severity = "high" if score > 0.75 else "medium" if score > 0.6 else "low"
                flags.append({"phrase": phrase, "type": "toxicity",
                               "score": round(score, 3), "severity": severity})
    else:
        _, tox_m = keyword_score(text, TOXICITY_KEYWORDS)
        flags += build_flags(tox_m, "toxicity")

    # Keyword-based flags
    _, manip_m  = keyword_score(text, MANIPULATION_PHRASES)
    _, mis_m    = keyword_score(text, MISINFO_PHRASES)
    _, social_m = keyword_score(text, SOCIAL_HARMFUL)
    _, scam_m   = keyword_score(text, SCAM_PHRASES)
    _, phish_m  = keyword_score(text, PHISHING_PATTERNS)

    flags += build_flags(manip_m,  "manipulation")
    flags += build_flags(mis_m,    "misinfo")
    flags += build_flags(social_m, "toxicity")
    flags += build_flags(scam_m,   "scam")
    flags += build_flags(phish_m,  "phishing")

    # AI text heuristic flags
    _, ai_flags = compute_ai_signals(text)
    flags += ai_flags

    # URL-based signals
    if url:
        url_lower = url.lower()
        if re.search(r'\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}', url_lower):
            flags.append({"phrase": "IP address used as domain", "type": "scam", "score": 0.85, "severity": "high"})
        if re.search(r'bit\.ly|tinyurl|t\.co|goo\.gl|short\.|ow\.ly', url_lower):
            flags.append({"phrase": "URL shortener detected", "type": "scam", "score": 0.65, "severity": "medium"})
        if re.search(r'(login|signin|verify|confirm|secure|account)\b', url_lower):
            flags.append({"phrase": "Credential-harvesting URL pattern", "type": "phishing", "score": 0.7, "severity": "high"})

    return deduplicate_flags(flags)[:25]

# ── Gemini primary scan ───────────────────────────────────────────────────────
GEMINI_SYSTEM_PROMPT = """You are Sentinel, an expert cybersecurity and content integrity AI with deep knowledge of misinformation, AI-generated content, manipulation tactics, and online scams.

Analyze the content below with HIGH SCRUTINY. You must be accurate and not under-score threats.

SOURCE URL: {url}
PAGE TITLE: {title}

CONTENT:
\"\"\"
{text}
\"\"\"

Return ONLY a raw JSON object — no markdown, no code fences, no preamble:
{{
  "toxicity": <0.0-1.0>,
  "manipulation": <0.0-1.0>,
  "misinfo": <0.0-1.0>,
  "ai_score": <0.0-1.0>,
  "scam_score": <0.0-1.0>,
  "overall_severity": "clean|low|medium|high",
  "reasoning": {{
    "toxicity": "<what toxic language or harassment was or was not found>",
    "manipulation": "<what persuasion or manipulation tactics were or were not found>",
    "misinfo": "<what false, unverified, or misleading claims were or were not found>",
    "ai_score": "<specific linguistic evidence this was or was not AI-generated>",
    "scam_score": "<what scam, phishing, or fraud patterns were or were not found>",
    "summary": "<2-3 sentence plain-English verdict for a non-technical user>"
  }},
  "gemini_flags": [
    {{"phrase": "<exact quote, max 80 chars>", "type": "toxicity|manipulation|misinfo|ai|scam|phishing", "severity": "low|medium|high"}}
  ]
}}

CRITICAL SCORING INSTRUCTIONS — READ CAREFULLY:

ai_score (is this text AI-generated?):
- Score 0.7-1.0 if: unnaturally perfect grammar, no typos, formulaic paragraph structure, AI phrases like "it is worth noting / furthermore / in conclusion / delve into / leverage / it is important to note", overly balanced viewpoints, no personal voice, generic examples, seamless transitions
- Score 0.4-0.6 if: some AI patterns but also human signals
- Score 0.0-0.3 if: typos, strong personal voice, slang, emotional language, specific personal anecdotes
- NOTE: An entire webpage that reads like a perfectly written article with no author personality is almost certainly AI-generated. Score it 0.7+

misinfo (false or misleading claims):
- Score 0.7-1.0 if: specific factual claims without sources, health/medical misinformation, political disinformation, statistics that seem fabricated, "studies show" without citation
- Score 0.3-0.6 if: some unverified claims but mostly opinion
- Score 0.0-0.2 if: clearly labeled opinion, satire with obvious markers, verified factual content
- DO NOT confuse AI-generated with misinformation — they are separate scores

manipulation (psychological manipulation tactics):
- Score 0.7-1.0 if: urgency/scarcity language, fear appeals, false authority, "they don't want you to know", emotional manipulation, clickbait patterns
- Score 0.3-0.6 if: mild persuasion language
- Score 0.0-0.2 if: neutral informational content

overall_severity rules:
- "high" if ANY score > 0.65
- "medium" if ANY score > 0.40
- "low" if ANY score > 0.15
- "clean" only if ALL scores < 0.15

Return at most 8 gemini_flags, only for scores > 0.35."""

async def _call_groq(prompt: str, max_tokens: int = 1024) -> str | None:
    """Call Groq API (OpenAI-compatible). Returns raw text or None."""
    if not GROQ_API_KEY:
        return None
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                GROQ_URL,
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {GROQ_API_KEY}",
                },
                json={
                    "model": GROQ_MODEL,
                    "messages": [
                        {
                            "role": "system",
                            "content": "You are a JSON-only response bot. You MUST respond with valid JSON only — no markdown, no explanation, no code fences. Raw JSON only."
                        },
                        {"role": "user", "content": prompt}
                    ],
                    "temperature": 0.1,
                    "max_tokens": max_tokens,
                },
            )
        resp.raise_for_status()
        return resp.json()["choices"][0]["message"]["content"]
    except httpx.HTTPStatusError as e:
        print(f"⚠  Groq HTTP {e.response.status_code}: {e.response.text[:300]}")
        return None
    except Exception as e:
        print(f"⚠  Groq call failed: {e}")
        return None


async def _call_gemini_text(prompt: str, max_tokens: int = 1024) -> str | None:
    """Call Gemini REST API. Returns raw text or None."""
    if not GEMINI_API_KEY:
        return None
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                f"{GEMINI_URL}?key={GEMINI_API_KEY}",
                headers={"Content-Type": "application/json"},
                json={
                    "contents": [{"parts": [{"text": prompt}]}],
                    "generationConfig": {"temperature": 0.1, "maxOutputTokens": max_tokens},
                },
            )
        resp.raise_for_status()
        return resp.json()["candidates"][0]["content"]["parts"][0]["text"]
    except Exception as e:
        print(f"⚠  Gemini text call failed: {e}")
        return None


async def _call_openai(prompt: str, max_tokens: int = 1024) -> str | None:
    """Call OpenAI Chat Completions as the final text-analysis fallback."""
    if not OPENAI_API_KEY:
        return None
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                OPENAI_URL,
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {OPENAI_API_KEY}",
                },
                json={
                    "model": OPENAI_MODEL,
                    "messages": [
                        {
                            "role": "system",
                            "content": "You are a JSON-only response bot. Return valid JSON only, with no markdown, prose, or code fences."
                        },
                        {"role": "user", "content": prompt},
                    ],
                    "temperature": 0.1,
                    "max_tokens": max_tokens,
                    "response_format": {"type": "json_object"},
                },
            )
        resp.raise_for_status()
        return resp.json()["choices"][0]["message"]["content"]
    except httpx.HTTPStatusError as e:
        print(f"OpenAI HTTP {e.response.status_code}: {e.response.text[:300]}")
        return None
    except Exception as e:
        print(f"OpenAI call failed: {e}")
        return None


async def call_ai(prompt: str, cache_key_str: str = "", max_tokens: int = 1024) -> dict | None:
    """
    Primary AI call — tries Groq first, falls back to Gemini.
    Includes caching and rate limiting.
    """
    # Cache check
    if cache_key_str:
        ck = _cache_key("ai", cache_key_str)
        cached = _cache_get(ck)
        if cached:
            print("✓  AI cache hit")
            return cached

    await _rate_wait()

    raw_text = None
    if USE_GROQ:
        raw_text = await _call_groq(prompt, max_tokens)
        if raw_text is None:
            print("⚠  Groq failed — trying Gemini fallback")
            raw_text = await _call_gemini_text(prompt, max_tokens)
    else:
        raw_text = await _call_gemini_text(prompt, max_tokens)

    if raw_text is None:
        print("Groq/Gemini unavailable - trying OpenAI fallback")
        raw_text = await _call_openai(prompt, max_tokens)

    if not raw_text:
        return None

    try:
        clean = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw_text.strip())
        result = json.loads(clean)
        if cache_key_str:
            _cache_set(ck, result)
        return result
    except json.JSONDecodeError as e:
        print(f"⚠  AI JSON parse error: {e}\nRaw: {raw_text[:200]}")
        return None


# Alias for backward compat with any code still calling call_gemini
async def call_gemini(text: str, url: str = "", title: str = "") -> dict | None:
    prompt = GEMINI_SYSTEM_PROMPT.format(
        url=url or "unknown",
        title=title or "unknown",
        text=text[:7000],
    )
    return await call_ai(prompt, cache_key_str=text[:500] + url)

# ── Pydantic models ───────────────────────────────────────────────────────────
class AnalyzeRequest(BaseModel):
    text:      str
    mode:      Optional[str] = None
    url:       Optional[str] = ""
    pageTitle: Optional[str] = ""

class AnalyzeResponse(BaseModel):
    # Scores — Gemini is authoritative; ML fallback if Gemini unavailable
    toxicity:         float
    manipulation:     float
    misinfo:          float
    ai_score:         float
    scam_score:       float
    overall_severity: str
    # Status flags
    ml_active:        bool
    gemini_active:    bool
    # Gemini reasoning (empty if unavailable)
    reasoning:        dict
    # Combined flags: Gemini semantic flags + ML/keyword highlight flags
    flags:            list

# ── Main endpoint ─────────────────────────────────────────────────────────────
@app.post("/api/analyze-text", response_model=AnalyzeResponse)
async def analyze_text(req: AnalyzeRequest):
    text  = req.text[:5000]
    url   = req.url or ""
    title = req.pageTitle or ""

    # ── Step 1: Fast ML/keyword pass (always runs, no latency) ───────────────
    ml_flags  = run_fast_pass(text, url)
    ml_active = ml_classifier is not None
    local = local_risk_analysis(text, url)
    ml_flags = deduplicate_flags(ml_flags + local["flags"])[:25]

    # Fallback scores (used only if Gemini fails)
    fb_manip = local["manipulation"]
    fb_mis   = local["misinfo"]
    fb_scam  = local["scam_score"]
    fb_ai    = local["ai_score"]
    fb_tox   = local["toxicity"]

    # ── Step 2: Gemini primary scan (async — authoritative judge) ─────────────
    gemini_result = await call_gemini(text, url, title)
    gemini_active = gemini_result is not None

    if gemini_active:
        # Cloud scores are primary, but local detectors provide a floor for
        # clear scam/phishing, bullying, and misinfo patterns that should not
        # be under-scored.
        toxicity     = max(float(gemini_result.get("toxicity",     fb_tox)), fb_tox)
        manipulation = max(float(gemini_result.get("manipulation", fb_manip)), fb_manip)
        misinfo      = max(float(gemini_result.get("misinfo",      fb_mis)), fb_mis)
        ai_score     = max(float(gemini_result.get("ai_score",     fb_ai)), fb_ai)
        scam_score   = max(float(gemini_result.get("scam_score",   fb_scam)), fb_scam)
        severity     = gemini_result.get(
            "overall_severity",
            compute_overall_severity(toxicity, misinfo, scam_score, manipulation)
        )
        severity = compute_overall_severity(toxicity, misinfo, scam_score, manipulation)
        reasoning = gemini_result.get("reasoning", {})

        # Build Gemini flags with scores attached
        score_map = {
            "toxicity":     toxicity,
            "manipulation": manipulation,
            "misinfo":      misinfo,
            "ai":           ai_score,
            "scam":         scam_score,
            "phishing":     scam_score,
        }
        gemini_flags = []
        for gf in gemini_result.get("gemini_flags", [])[:8]:
            ftype  = gf.get("type", "unknown")
            fscore = score_map.get(ftype, 0.5)
            gemini_flags.append({
                "phrase":   gf.get("phrase", "")[:80],
                "type":     ftype,
                "score":    round(fscore, 3),
                "severity": gf.get("severity", "medium"),
                "source":   "gemini",   # frontend uses this for display priority
            })

        # Merge: Gemini flags first (richer, used in panel display)
        # then ML flags (used for page highlight overlays)
        tagged_ml = [{**f, "source": "ml"} for f in ml_flags]
        all_flags = deduplicate_flags(gemini_flags + tagged_ml)[:25]

    else:
        # Gemini unavailable — fall back entirely to ML/keyword scores
        toxicity     = fb_tox
        manipulation = fb_manip
        misinfo      = fb_mis
        ai_score     = fb_ai
        scam_score   = fb_scam
        severity     = compute_overall_severity(toxicity, misinfo, scam_score, manipulation)
        reasoning    = {
            "summary":      "AI provider unavailable; Sentinel used the local threat model and category-specific safety rules.",
            "toxicity":     "Checked for harassment, direct insults, self-harm encouragement, and cyberbullying patterns.",
            "manipulation": "Checked for urgency, fear appeals, clickbait, and hidden-truth framing.",
            "misinfo":      "Checked for conspiracy framing, unsupported certainty, miracle-cure claims, and unverifiable factual claims.",
            "ai_score":     "Checked for formulaic wording, repeated transitions, and unusually uniform writing.",
            "scam_score":   "Checked for account verification, credential requests, payment pressure, prize fraud, and phishing URL patterns.",
        }
        all_flags = [{**f, "source": "ml"} for f in ml_flags]

    return AnalyzeResponse(
        toxicity=round(toxicity, 3),
        manipulation=round(manipulation, 3),
        misinfo=round(misinfo, 3),
        ai_score=round(ai_score, 3),
        scam_score=round(scam_score, 3),
        overall_severity=severity,
        ml_active=ml_active,
        gemini_active=gemini_active,
        reasoning=reasoning,
        flags=all_flags,
    )

# ── Creator / Social Media Health Analysis ───────────────────────────────────
CREATOR_PROMPT = """You are Sentinel, a content safety AI analyzing a social media creator's profile and post for potentially harmful habits they are promoting to their audience.

PLATFORM: {platform}
CREATOR NAME: {creator_name}
CREATOR BIO: {bio}
POST CAPTION / DESCRIPTION: {caption}
HASHTAGS: {hashtags}
CHANNEL THEME (inferred): {theme}
COMMENT SAMPLES: {comments}

Analyze this creator profile and return ONLY a valid JSON object — no markdown, no preamble.

{{
  "overall_health": "healthy" | "caution" | "harmful",
  "health_score": <0-100, where 100 = fully healthy, 0 = extremely harmful>,
  "post_safety_score": <0-100, where 100 = safe and 0 = high-risk>,
  "creator_theme": "<2-5 word description of what this creator is about>",
  "post_summary": "<2 sentence summary of what the post is about and why it may be safe or risky>",
  "scanned_details": {{
    "platform": "<platform>",
    "creator": "<creator name or unknown>",
    "content_type": "post",
    "topic": "<short topic>",
    "signals_checked": ["caption", "bio", "hashtags", "comments"]
  }},
  "risk_breakdown": [
    {{"label": "Scam / phishing", "score": <0-100>, "severity": "none|low|medium|high", "detail": "<specific reason>"}},
    {{"label": "Toxicity / bullying", "score": <0-100>, "severity": "none|low|medium|high", "detail": "<specific reason>"}},
    {{"label": "Misinformation", "score": <0-100>, "severity": "none|low|medium|high", "detail": "<specific reason>"}},
    {{"label": "Harmful habits", "score": <0-100>, "severity": "none|low|medium|high", "detail": "<specific reason>"}}
  ],
  "evidence": [
    {{"quote": "<short exact phrase from the post>", "type": "caption|bio|hashtag|comment", "reason": "<why it matters>"}}
  ],
  "habits_promoted": [
    "<specific habit or behavior the creator promotes, e.g. 'extreme calorie restriction'>",
    "<another habit>"
  ],
  "flags": {{
    "dangerous_diet_fitness": {{
      "detected": true | false,
      "severity": "none" | "low" | "medium" | "high",
      "detail": "<1 sentence explanation, or empty string if not detected>"
    }},
    "financial_scam": {{
      "detected": true | false,
      "severity": "none" | "low" | "medium" | "high",
      "detail": "<1 sentence explanation, or empty string if not detected>"
    }},
    "addiction_promotion": {{
      "detected": true | false,
      "severity": "none" | "low" | "medium" | "high",
      "detail": "<1 sentence explanation, or empty string if not detected>"
    }},
    "mental_health_harm": {{
      "detected": true | false,
      "severity": "none" | "low" | "medium" | "high",
      "detail": "<1 sentence explanation, or empty string if not detected>"
    }}
  }},
  "summary": "<2-3 sentence plain-English verdict about whether this creator promotes healthy or harmful habits. Be specific about what they promote.>",
  "recommendation": "<1 sentence advice for the viewer, e.g. 'Follow trusted medical professionals before adopting any dietary advice from this creator.'>"
}}

SEVERITY GUIDE:
- none: No signal detected
- low: Mild or ambiguous signals — could be innocent
- medium: Clear pattern of potentially harmful messaging
- high: Dangerous, predatory, or exploitative content

IMPORTANT RULES:
- Be fair and balanced — fitness creators are NOT automatically harmful
- Only flag dangerous_diet_fitness if you see extreme/unhealthy diet advice, not general fitness
- Only flag financial_scam if there are get-rich-quick patterns, not all financial content
- Satire, comedy, and opinions are NOT automatically harmful
- If the content is normal and healthy, say so clearly in the summary
"""

class CreatorRequest(BaseModel):
    platform:     str
    creator_name: Optional[str] = ""
    bio:          Optional[str] = ""
    caption:      Optional[str] = ""
    hashtags:     Optional[str] = ""
    theme:        Optional[str] = ""
    comments:     Optional[str] = ""
    url:          Optional[str] = ""

class CreatorResponse(BaseModel):
    overall_health:  str   # "healthy" | "caution" | "harmful"
    health_score:    int   # 0-100
    post_safety_score: int = 50
    creator_theme:   str
    post_summary:    str = ""
    scanned_details: dict = {}
    risk_breakdown:  list = []
    evidence:        list = []
    habits_promoted: list
    flags:           dict
    summary:         str
    recommendation:  str
    gemini_active:   bool

@app.post("/api/analyze-creator", response_model=CreatorResponse)
async def analyze_creator(req: CreatorRequest):
    # Keyword fast-pass for instant signal detection
    combined_text = " ".join(filter(None, [
        req.bio, req.caption, req.hashtags, req.comments
    ]))

    # Fast keyword pre-checks (used as fallback if Gemini fails)
    DIET_KEYWORDS = [
        "lose weight fast","drop 30 lbs","eat 500 calories","no carbs","detox tea",
        "skinny","thinspo","flat tummy","waist training","diet pills","fat burner",
        "cleanse","juice fast","starvation","extreme cut","shred fast",
    ]
    ADDICTION_KEYWORDS = [
        "gambling","bet now","casino","slots","crypto pump","nft drop","place your bet",
        "alcohol","drunk","wasted","high all day","party every night","substances",
        "daily drinking","always lit",
    ]
    MENTAL_HARM_KEYWORDS = [
        "nobody loves you","you're worthless","everyone hates","you'll never be enough",
        "doom","nothing matters","give up","hopeless","doomscroll","rage bait",
        "you're ugly","you'll always be fat","nobody cares",
    ]
    FINANCE_SCAM_KEYWORDS = [
        "make money fast","passive income","financial freedom","quit your job",
        "100x returns","guaranteed profit","crypto millionaire","get rich",
        "no experience needed","work from home","drop shipping","my course",
        "dm me for access","secret strategy","forex signals",
    ]

    diet_score,    _ = keyword_score(combined_text, DIET_KEYWORDS)
    addiction_score,_ = keyword_score(combined_text, ADDICTION_KEYWORDS)
    mental_score,  _ = keyword_score(combined_text, MENTAL_HARM_KEYWORDS)
    finance_score, _ = keyword_score(combined_text, FINANCE_SCAM_KEYWORDS)
    post_local = local_risk_analysis(combined_text, req.url or "")

    def sev_from_score(score):
        if score >= 0.65: return "high"
        if score >= 0.35: return "medium"
        if score >= 0.15: return "low"
        return "none"

    harmful_habit_score = max(diet_score, addiction_score, mental_score, finance_score)
    fallback_breakdown = [
        {"label": "Scam / phishing", "score": int(post_local["scam_score"] * 100), "severity": sev_from_score(post_local["scam_score"]), "detail": "Checked for credential requests, prize fraud, payment pressure, and suspicious links."},
        {"label": "Toxicity / bullying", "score": int(post_local["toxicity"] * 100), "severity": sev_from_score(post_local["toxicity"]), "detail": "Checked comments and caption for harassment, insults, and self-harm pressure."},
        {"label": "Misinformation", "score": int(post_local["misinfo"] * 100), "severity": sev_from_score(post_local["misinfo"]), "detail": "Checked for unsupported certainty, conspiracy framing, and miracle-cure claims."},
        {"label": "Harmful habits", "score": int(harmful_habit_score * 100), "severity": sev_from_score(harmful_habit_score), "detail": "Checked for dangerous diet, addiction, finance, and mental-health behavior cues."},
    ]
    fallback_evidence = [
        {"quote": f.get("phrase", "")[:90], "type": f.get("type", "signal"), "reason": f.get("severity", "low")}
        for f in post_local.get("flags", [])[:4]
    ]

    # Gemini primary analysis
    prompt = CREATOR_PROMPT.format(
        platform=req.platform or "unknown",
        creator_name=req.creator_name or "unknown",
        bio=req.bio[:300] if req.bio else "not available",
        caption=req.caption[:500] if req.caption else "not available",
        hashtags=req.hashtags[:200] if req.hashtags else "none",
        theme=req.theme or "unknown",
        comments=req.comments[:400] if req.comments else "none available",
    )

    gemini_result = None
    if GROQ_API_KEY or GEMINI_API_KEY or OPENAI_API_KEY:
        ck = _cache_key("creator", (req.creator_name or "") + (req.caption or "") + req.platform)
        gemini_result = _cache_get(ck)
        if gemini_result:
            print("✓  Creator AI cache hit")
        else:
            gemini_result = await call_ai(
                prompt,
                cache_key_str=(req.creator_name or "") + (req.caption or "") + req.platform,
            )

    if gemini_result:
        post_safety_score = int(gemini_result.get("post_safety_score", gemini_result.get("health_score", 50)))
        return CreatorResponse(
            overall_health=gemini_result.get("overall_health", "caution"),
            health_score=int(gemini_result.get("health_score", 50)),
            post_safety_score=max(0, min(100, post_safety_score)),
            creator_theme=gemini_result.get("creator_theme", "unknown"),
            post_summary=gemini_result.get("post_summary", gemini_result.get("summary", "")),
            scanned_details=gemini_result.get("scanned_details", {
                "platform": req.platform or "unknown",
                "creator": req.creator_name or "unknown",
                "content_type": "post",
                "topic": req.theme or "unknown",
                "signals_checked": ["caption", "bio", "hashtags", "comments"],
            }),
            risk_breakdown=gemini_result.get("risk_breakdown", fallback_breakdown),
            evidence=gemini_result.get("evidence", fallback_evidence)[:6],
            habits_promoted=gemini_result.get("habits_promoted", []),
            flags=gemini_result.get("flags", {}),
            summary=gemini_result.get("summary", ""),
            recommendation=gemini_result.get("recommendation", ""),
            gemini_active=True,
        )
    else:
        # Keyword fallback verdict
        max_score = max(diet_score, addiction_score, mental_score, finance_score)
        max_post_score = max(max_score, post_local["toxicity"], post_local["misinfo"], post_local["scam_score"])
        overall = "harmful" if max_score > 0.6 else "caution" if max_score > 0.25 else "healthy"
        health_score = max(0, min(100, int((1 - max_score) * 100)))
        post_safety_score = max(0, min(100, int((1 - max_post_score) * 100)))
        return CreatorResponse(
            overall_health=overall,
            health_score=health_score,
            post_safety_score=post_safety_score,
            creator_theme="unknown",
            post_summary="Sentinel scanned the post caption, profile context, hashtags, and visible comments with local safety rules.",
            scanned_details={
                "platform": req.platform or "unknown",
                "creator": req.creator_name or "unknown",
                "content_type": "post",
                "topic": req.theme or "unknown",
                "signals_checked": ["caption", "bio", "hashtags", "comments"],
            },
            risk_breakdown=fallback_breakdown,
            evidence=fallback_evidence,
            habits_promoted=[],
            flags={
                "dangerous_diet_fitness": {"detected": diet_score > 0.25, "severity": "medium" if diet_score > 0.5 else "low" if diet_score > 0.25 else "none", "detail": ""},
                "financial_scam":         {"detected": finance_score > 0.25, "severity": "medium" if finance_score > 0.5 else "low" if finance_score > 0.25 else "none", "detail": ""},
                "addiction_promotion":    {"detected": addiction_score > 0.25, "severity": "medium" if addiction_score > 0.5 else "low" if addiction_score > 0.25 else "none", "detail": ""},
                "mental_health_harm":     {"detected": mental_score > 0.25, "severity": "medium" if mental_score > 0.5 else "low" if mental_score > 0.25 else "none", "detail": ""},
            },
            summary="Gemini unavailable — keyword-based analysis only.",
            recommendation="Consider verifying this content with trusted sources.",
            gemini_active=False,
        )


# ── Gemini Vision — AI Image Detection ───────────────────────────────────────
IMAGE_PROMPT = """You are an AI image forensics expert with deep knowledge of generative AI artifacts. Analyze this image with HIGH SCRUTINY and determine if it was AI-generated.

Return ONLY raw JSON — no markdown, no code fences:
{
  "ai_probability": <0.0-1.0>,
  "verdict": "real" | "likely_real" | "uncertain" | "likely_ai" | "ai_generated",
  "confidence": "low" | "medium" | "high",
  "signals": ["<specific visual artifact observed>"],
  "explanation": "<2 sentence explanation citing specific visual evidence>"
}

SCORE HIGH (0.7-1.0) if you see ANY of:
- Unnaturally smooth or waxy skin texture
- Perfect symmetry in faces or backgrounds
- Blurred or incoherent background details
- Warped, misspelled, or illegible text in the image
- Extra or missing fingers, limbs, teeth, ears
- Dreamlike sharpness with no film grain or noise
- Lighting that is too perfect or comes from impossible angles
- Hair that blends unnaturally into the background
- Eyes that are slightly asymmetric or have unnatural catchlights
- Clothing patterns that don't tile correctly
- Known AI generator watermarks or metadata

SCORE LOW (0.0-0.3) if you see:
- Natural film grain, lens aberration, or compression artifacts
- Authentic motion blur or depth of field
- Real-world imperfections (stains, wear, uneven lighting)
- Consistent shadows and reflections
- Natural skin pores and texture detail

Be specific. Name the exact artifacts you see. Do not say "no artifacts detected" unless you are highly confident."""

class ImageAnalyzeRequest(BaseModel):
    image_b64:  str            # base64-encoded image
    media_type: str = "image/jpeg"  # image/jpeg | image/png | image/webp
    image_url:  Optional[str] = ""  # fallback: public URL if base64 not available
    context:    Optional[str] = ""  # surrounding page text/alt text for extra signal

class ImageAnalyzeResponse(BaseModel):
    ai_probability: float
    verdict:        str
    confidence:     str
    signals:        list
    explanation:    str
    gemini_active:  bool

@app.post("/api/analyze-image", response_model=ImageAnalyzeResponse)
async def analyze_image(req: ImageAnalyzeRequest):
    if not GEMINI_API_KEY and not GROQ_API_KEY and not OPENAI_API_KEY:
        return ImageAnalyzeResponse(ai_probability=0.5, verdict="uncertain",
            confidence="low", signals=["No AI API key set"],
            explanation="Cannot analyze without an API key.", gemini_active=False)

    # ── Gemini Vision (best — uses actual image pixels) ───────────────────────
    if GEMINI_API_KEY and (req.image_b64 or req.image_url):
        parts = [{"text": IMAGE_PROMPT}]
        if req.image_b64:
            parts.append({"inline_data": {"mime_type": req.media_type, "data": req.image_b64}})
        elif req.image_url:
            parts.append({"file_data": {"file_uri": req.image_url, "mime_type": req.media_type}})
        if req.context:
            parts.append({"text": f"\nPage context: {req.context[:300]}"})

        await _rate_wait()
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.post(
                    f"{GEMINI_VIS_URL}?key={GEMINI_API_KEY}",
                    headers={"Content-Type": "application/json"},
                    json={
                        "contents": [{"parts": parts}],
                        "generationConfig": {"temperature": 0.1, "maxOutputTokens": 512},
                    },
                )
            resp.raise_for_status()
            raw      = resp.json()
            text_out = raw["candidates"][0]["content"]["parts"][0]["text"]
            text_out = re.sub(r"^```(?:json)?\s*|\s*```$", "", text_out.strip())
            result   = json.loads(text_out)
            return ImageAnalyzeResponse(
                ai_probability = float(result.get("ai_probability", 0.5)),
                verdict        = result.get("verdict", "uncertain"),
                confidence     = result.get("confidence", "low"),
                signals        = result.get("signals", [])[:6],
                explanation    = result.get("explanation", ""),
                gemini_active  = True,
            )
        except Exception as e:
            print(f"⚠  Gemini Vision error: {e} — trying Groq text fallback")

    # ── Groq text fallback (uses context/alt text only, no pixels) ────────────
    if GROQ_API_KEY or OPENAI_API_KEY:
        context_prompt = f"""Analyze whether this image is likely AI-generated based on the following contextual information:
URL/source: {req.image_url or 'unknown'}
Alt text / surrounding context: {req.context or 'none provided'}
Image dimensions hint: base64 data {'provided' if req.image_b64 else 'not provided'}

Based on the source URL and any context clues, estimate the probability this is AI-generated.
Known AI image sources: thispersondoesnotexist.com, midjourney.com, civitai.com, lexica.art, playground.ai, ideogram.ai, firefly.adobe.com, dall-e, stable-diffusion, nightcafe, artbreeder.

{IMAGE_PROMPT}"""
        result = await call_ai(context_prompt, cache_key_str=req.image_url or req.context or "", max_tokens=512)
        if result:
            return ImageAnalyzeResponse(
                ai_probability = float(result.get("ai_probability", 0.5)),
                verdict        = result.get("verdict", "uncertain"),
                confidence     = "low",  # always low for text-only analysis
                signals        = result.get("signals", []) + ["Note: context-only analysis, no pixel data"],
                explanation    = result.get("explanation", "") + " (Groq text-based analysis — no image pixels available)",
                gemini_active  = True,
            )

    # Final fallback — heuristics only
    return ImageAnalyzeResponse(ai_probability=0.5, verdict="uncertain",
        confidence="low", signals=["AI vision unavailable"],
        explanation="Could not analyze image — set GEMINI_API_KEY for visual analysis.", gemini_active=False)


# ── Gemini AI Text Detection ──────────────────────────────────────────────────
AI_TEXT_PROMPT = """You are an expert AI text detector trained to identify content written by language models like ChatGPT, Claude, Gemini, and Llama. You must be highly accurate and not under-score AI-generated text.

TEXT TO ANALYZE:
\"\"\"
{text}
\"\"\"

Return ONLY raw JSON — no markdown, no code fences:
{{
  "ai_probability": <0.0-1.0>,
  "verdict": "human" | "likely_human" | "uncertain" | "likely_ai" | "ai_generated",
  "confidence": "low" | "medium" | "high",
  "signals": ["<specific linguistic signal observed>"],
  "explanation": "<2 sentence explanation citing specific phrases or patterns>"
}}

SCORE HIGH (0.7-1.0) — strong AI signals:
- Uses phrases: "it is worth noting", "furthermore", "moreover", "in conclusion", "it is important to", "plays a crucial role", "delve into", "leverage", "comprehensive overview", "multifaceted", "it should be noted", "in the realm of", "at the end of the day", "moving forward"
- Perfectly structured paragraphs with topic sentence + body + transition
- Every sentence is grammatically perfect with no colloquialisms
- Unnaturally consistent sentence length (no very short or very long sentences)
- Hedging on every claim: "may", "could", "might", "some argue"
- Lists everything in sets of three
- No specific personal anecdotes, no strong opinions, no humor
- Overly balanced "on one hand / on the other hand" framing
- Generic placeholders instead of specific examples

SCORE LOW (0.0-0.3) — strong human signals:
- Typos, grammatical errors, run-on sentences
- Specific named people, places, dates from personal experience
- Strong one-sided opinions without hedging
- Slang, contractions, casual language
- Emotional outbursts, frustration, excitement
- Inconsistent style or register changes
- Stream of consciousness writing

IMPORTANT: Short texts under 80 words are unreliable — set confidence to "low".
IMPORTANT: Academic or formal writing is NOT automatically AI — look for the specific phrases above."""

class TextAiRequest(BaseModel):
    text: str
    context: Optional[str] = ""   # e.g. "comment on Reddit", "news article"

class TextAiResponse(BaseModel):
    ai_probability: float
    verdict:        str
    confidence:     str
    signals:        list
    explanation:    str
    gemini_active:  bool

@app.post("/api/analyze-text-ai", response_model=TextAiResponse)
async def analyze_text_ai(req: TextAiRequest):
    text = req.text.strip()[:6000]
    if len(text) < 20:
        return TextAiResponse(ai_probability=0.0, verdict="uncertain", confidence="low",
            signals=["Text too short"], explanation="Not enough text to analyze.", gemini_active=False)

    if not GEMINI_API_KEY and not GROQ_API_KEY and not OPENAI_API_KEY:
        # Heuristic fallback
        score, _ = compute_ai_signals(text)
        verdict = "likely_ai" if score > 0.6 else "uncertain" if score > 0.3 else "likely_human"
        return TextAiResponse(ai_probability=score, verdict=verdict, confidence="low",
            signals=["Gemini unavailable — keyword heuristics only"],
            explanation="Using keyword-based detection. Set GEMINI_API_KEY for accurate results.",
            gemini_active=False)

    prompt = AI_TEXT_PROMPT.format(text=text)
    if req.context:
        prompt += f"\n\nContext about where this text appeared: {req.context}"

    result = await call_ai(prompt, cache_key_str=text[:300], max_tokens=512)

    if result:
        return TextAiResponse(
            ai_probability = float(result.get("ai_probability", 0.5)),
            verdict        = result.get("verdict", "uncertain"),
            confidence     = result.get("confidence", "low"),
            signals        = result.get("signals", [])[:6],
            explanation    = result.get("explanation", ""),
            gemini_active  = True,
        )
    else:
        score, _ = compute_ai_signals(text)
        verdict = "likely_ai" if score > 0.6 else "uncertain" if score > 0.3 else "likely_human"
        return TextAiResponse(ai_probability=score, verdict=verdict, confidence="low",
            signals=["AI unavailable — heuristic fallback"],
            explanation="Using keyword heuristics — set GROQ_API_KEY for accurate results.",
            gemini_active=False)


@app.get("/")
def health():
    ai_provider = "groq" if USE_GROQ else ("gemini" if GEMINI_API_KEY else ("openai" if OPENAI_API_KEY else "none"))
    return {
        "status":       "Sentinel v8 running",
        "ai_provider":  ai_provider,
        "groq":         "active" if GROQ_API_KEY else "not set",
        "gemini":       "active" if GEMINI_API_KEY else "not set (image fallback only)",
        "openai":       "active" if OPENAI_API_KEY else "not set",
        "ml_model":     "loaded" if ml_classifier else "keyword fallback",
        "val_acc":      model_info.get("val_acc", "n/a"),
        "whitelist":    f"{len(whitelist)} phrases protected",
    }
