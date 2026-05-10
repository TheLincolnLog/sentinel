# backend.py — Sentinel v8
# Architecture:
#   1. ML model + keyword lists → instant flags for page highlighting (fast first-pass)
#   2. Gemini 1.5 Flash        → primary text scores + reasoning (authoritative judge)
#   3. Gemini Vision           → AI image detection (real model, not heuristics)
#   4. Gemini text-AI detector → dedicated AI text detection with strict prompt
#
# Run:     uvicorn backend:app --reload
# Install: pip install fastapi uvicorn scikit-learn joblib httpx
# Set env: export GEMINI_API_KEY="your-key-here"

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

# ── Gemini config ─────────────────────────────────────────────────────────────
GEMINI_API_KEY  = os.environ.get("GEMINI_API_KEY", "")
GEMINI_BASE     = "https://generativelanguage.googleapis.com/v1beta/models"
GEMINI_URL      = f"{GEMINI_BASE}/gemini-1.5-flash-latest:generateContent"
GEMINI_VIS_URL  = f"{GEMINI_BASE}/gemini-1.5-flash-latest:generateContent"

# ── Load ML model ─────────────────────────────────────────────────────────────
MODEL_PATH = "model.pkl"
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
GEMINI_SYSTEM_PROMPT = """You are Sentinel, a professional cybersecurity and content safety AI.
Analyze the content below and return ONLY a valid JSON object — no markdown, no preamble.

SOURCE URL: {url}
PAGE TITLE: {title}

CONTENT:
\"\"\"
{text}
\"\"\"

Return this exact JSON structure:
{{
  "toxicity": <0.0-1.0>,
  "manipulation": <0.0-1.0>,
  "misinfo": <0.0-1.0>,
  "ai_score": <0.0-1.0>,
  "scam_score": <0.0-1.0>,
  "overall_severity": "clean|low|medium|high",
  "reasoning": {{
    "toxicity": "<1-2 sentence explanation>",
    "manipulation": "<1-2 sentence explanation>",
    "misinfo": "<1-2 sentence explanation>",
    "ai_score": "<1-2 sentence explanation>",
    "scam_score": "<1-2 sentence explanation>",
    "summary": "<2-3 sentence overall safety verdict a non-technical user can understand>"
  }},
  "gemini_flags": [
    {{"phrase": "<exact short quote from content, max 80 chars>", "type": "toxicity|manipulation|misinfo|ai|scam|phishing", "severity": "low|medium|high"}}
  ]
}}

SCORING GUIDE:
- 0.00-0.25: Safe / not present
- 0.26-0.50: Minor signals, low concern
- 0.51-0.75: Suspicious, warrants caution
- 0.76-1.00: Strong evidence of threat

RULES:
- Satire, opinion, dark humor are NOT misinformation — be conservative
- ai_score = likelihood the text was AI-generated, not whether that is harmful
- gemini_flags must only quote phrases actually present in the content
- Return at most 8 gemini_flags, only for issues with score > 0.3
- overall_severity must reflect the single highest concern
"""

async def call_gemini(text: str, url: str = "", title: str = "") -> dict | None:
    """Call Gemini 1.5 Flash and return parsed JSON result, or None on failure."""
    if not GEMINI_API_KEY:
        print("⚠  GEMINI_API_KEY not set — skipping Gemini scan")
        return None

    prompt = GEMINI_SYSTEM_PROMPT.format(
        url=url or "unknown",
        title=title or "unknown",
        text=text[:7000],
    )

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                f"{GEMINI_URL}?key={GEMINI_API_KEY}",
                headers={"Content-Type": "application/json"},
                json={
                    "contents": [{"parts": [{"text": prompt}]}],
                    "generationConfig": {
                        "temperature": 0.1,
                        "maxOutputTokens": 1024,
                    },
                },
            )
        resp.raise_for_status()
        raw      = resp.json()
        text_out = raw["candidates"][0]["content"]["parts"][0]["text"]
        # Strip markdown fences if Gemini wraps response
        text_out = re.sub(r"^```(?:json)?\s*|\s*```$", "", text_out.strip())
        return json.loads(text_out)
    except json.JSONDecodeError as e:
        print(f"⚠  Gemini JSON parse error: {e}")
        return None
    except httpx.HTTPStatusError as e:
        print(f"⚠  Gemini HTTP {e.response.status_code}: {e.response.text[:300]}")
        return None
    except Exception as e:
        print(f"⚠  Gemini call failed: {e}")
        return None

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

    # Fallback scores (used only if Gemini fails)
    fb_manip, _ = keyword_score(text, MANIPULATION_PHRASES)
    fb_mis,   _ = keyword_score(text, MISINFO_PHRASES)
    fb_scam,  _ = keyword_score(text, SCAM_PHRASES)
    fb_ai,    _ = compute_ai_signals(text)
    fb_tox      = predict_toxic(text) if ml_active else keyword_score(text, TOXICITY_KEYWORDS)[0]

    # ── Step 2: Gemini primary scan (async — authoritative judge) ─────────────
    gemini_result = await call_gemini(text, url, title)
    gemini_active = gemini_result is not None

    if gemini_active:
        # Gemini scores are the source of truth
        toxicity     = float(gemini_result.get("toxicity",     fb_tox))
        manipulation = float(gemini_result.get("manipulation", fb_manip))
        misinfo      = float(gemini_result.get("misinfo",      fb_mis))
        ai_score     = float(gemini_result.get("ai_score",     fb_ai))
        scam_score   = float(gemini_result.get("scam_score",   fb_scam))
        severity     = gemini_result.get(
            "overall_severity",
            compute_overall_severity(toxicity, misinfo, scam_score, manipulation)
        )
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
            "summary":      "Gemini unavailable — results based on ML model and keyword analysis only.",
            "toxicity":     "",
            "manipulation": "",
            "misinfo":      "",
            "ai_score":     "",
            "scam_score":   "",
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
  "creator_theme": "<2-5 word description of what this creator is about>",
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
    creator_theme:   str
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
    if GEMINI_API_KEY:
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.post(
                    f"{GEMINI_URL}?key={GEMINI_API_KEY}",
                    headers={"Content-Type": "application/json"},
                    json={
                        "contents": [{"parts": [{"text": prompt}]}],
                        "generationConfig": {
                            "temperature": 0.1,
                            "maxOutputTokens": 1024,
                        },
                    },
                )
            resp.raise_for_status()
            raw      = resp.json()
            text_out = raw["candidates"][0]["content"]["parts"][0]["text"]
            text_out = re.sub(r"^```(?:json)?\s*|\s*```$", "", text_out.strip())
            gemini_result = json.loads(text_out)
        except Exception as e:
            print(f"⚠  Gemini creator scan error: {e}")

    if gemini_result:
        return CreatorResponse(
            overall_health=gemini_result.get("overall_health", "caution"),
            health_score=int(gemini_result.get("health_score", 50)),
            creator_theme=gemini_result.get("creator_theme", "unknown"),
            habits_promoted=gemini_result.get("habits_promoted", []),
            flags=gemini_result.get("flags", {}),
            summary=gemini_result.get("summary", ""),
            recommendation=gemini_result.get("recommendation", ""),
            gemini_active=True,
        )
    else:
        # Keyword fallback verdict
        max_score = max(diet_score, addiction_score, mental_score, finance_score)
        overall = "harmful" if max_score > 0.6 else "caution" if max_score > 0.25 else "healthy"
        health_score = max(0, min(100, int((1 - max_score) * 100)))
        return CreatorResponse(
            overall_health=overall,
            health_score=health_score,
            creator_theme="unknown",
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
IMAGE_PROMPT = """You are an AI image forensics expert. Analyze this image and determine whether it was generated by AI (e.g. Stable Diffusion, Midjourney, DALL-E, Firefly, Sora, Flux) or is a real photograph/human-made artwork.

Return ONLY valid JSON — no markdown, no preamble:
{
  "ai_probability": <0.0-1.0>,
  "verdict": "real" | "likely_real" | "uncertain" | "likely_ai" | "ai_generated",
  "confidence": "low" | "medium" | "high",
  "signals": ["<specific visual signal observed>", ...],
  "explanation": "<2 sentence plain-English explanation of your reasoning>"
}

WHAT TO LOOK FOR:
- AI tells: unnatural skin texture, too-perfect lighting, background inconsistencies, warped text/fingers/teeth, dreamlike sharpness, missing film grain, impossible reflections, symmetry artifacts
- Real tells: natural noise/grain, lens distortion, chromatic aberration, real-world imperfections, EXIF-style compression artifacts, authentic motion blur
- Context tells: watermarks from known AI generators, AI platform hosting URLs, alt text mentioning AI

Be specific about signals you actually see. Do not guess blindly — if the image is ambiguous, say so."""

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
    if not GEMINI_API_KEY:
        return ImageAnalyzeResponse(ai_probability=0.5, verdict="uncertain",
            confidence="low", signals=["Gemini API key not set"],
            explanation="Cannot analyze without Gemini API key.", gemini_active=False)

    # Build Gemini Vision request
    parts = [{"text": IMAGE_PROMPT}]

    if req.image_b64:
        parts.append({
            "inline_data": {
                "mime_type": req.media_type,
                "data": req.image_b64,
            }
        })
    elif req.image_url:
        # Use URL directly via Gemini's file URI support
        parts.append({"file_data": {"file_uri": req.image_url, "mime_type": req.media_type}})
    else:
        return ImageAnalyzeResponse(ai_probability=0.5, verdict="uncertain",
            confidence="low", signals=["No image data provided"],
            explanation="No image data received.", gemini_active=False)

    if req.context:
        parts.append({"text": f"\nAdditional context from the surrounding page: {req.context[:300]}"})

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                f"{GEMINI_VIS_URL}?key={GEMINI_API_KEY}",
                headers={"Content-Type": "application/json"},
                json={
                    "contents": [{"parts": parts}],
                    "generationConfig": {
                        "temperature": 0.1,
                        "maxOutputTokens": 512,
                    },
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
        print(f"⚠  Gemini Vision error: {e}")
        return ImageAnalyzeResponse(ai_probability=0.5, verdict="uncertain",
            confidence="low", signals=[str(e)[:80]],
            explanation="Gemini Vision analysis failed.", gemini_active=False)


# ── Gemini AI Text Detection ──────────────────────────────────────────────────
AI_TEXT_PROMPT = """You are an expert AI text detector. Your job is to determine whether the following text was written by an AI language model (ChatGPT, Claude, Gemini, Llama, etc.) or by a human.

TEXT TO ANALYZE:
\"\"\"
{text}
\"\"\"

Return ONLY valid JSON — no markdown, no preamble:
{{
  "ai_probability": <0.0-1.0>,
  "verdict": "human" | "likely_human" | "uncertain" | "likely_ai" | "ai_generated",
  "confidence": "low" | "medium" | "high",
  "signals": ["<specific linguistic signal>", ...],
  "explanation": "<2 sentence explanation of key signals that led to this verdict>"
}}

KEY AI SIGNALS TO DETECT:
- Structural: perfect paragraph transitions, formulaic intro/conclusion, numbered lists without being asked
- Lexical: "it's worth noting", "furthermore", "in conclusion", "it is important to", "plays a crucial role", "delve into", "leverage", "comprehensive", "multifaceted"
- Stylistic: unnaturally consistent sentence length, no typos or colloquialisms, overly balanced "on one hand / on the other", hedge stacking
- Content: generic examples, lack of personal voice, no specific dates/names/places, safely neutral on all topics
- Formatting: bullet points where prose would be natural, bold headers in casual contexts

KEY HUMAN SIGNALS:
- Typos, grammatical quirks, run-on sentences
- Specific personal anecdotes, strong opinions
- Informal contractions, slang, humor
- Inconsistent style or register
- Emotional language, frustration, excitement

Be calibrated: short texts under 100 words are harder to classify reliably. Say so in confidence."""

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

    if not GEMINI_API_KEY:
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

    try:
        async with httpx.AsyncClient(timeout=25.0) as client:
            resp = await client.post(
                f"{GEMINI_URL}?key={GEMINI_API_KEY}",
                headers={"Content-Type": "application/json"},
                json={
                    "contents": [{"parts": [{"text": prompt}]}],
                    "generationConfig": {
                        "temperature": 0.05,
                        "maxOutputTokens": 512,
                    },
                },
            )
        resp.raise_for_status()
        raw      = resp.json()
        text_out = raw["candidates"][0]["content"]["parts"][0]["text"]
        text_out = re.sub(r"^```(?:json)?\s*|\s*```$", "", text_out.strip())
        result   = json.loads(text_out)
        return TextAiResponse(
            ai_probability = float(result.get("ai_probability", 0.5)),
            verdict        = result.get("verdict", "uncertain"),
            confidence     = result.get("confidence", "low"),
            signals        = result.get("signals", [])[:6],
            explanation    = result.get("explanation", ""),
            gemini_active  = True,
        )
    except Exception as e:
        print(f"⚠  Gemini text-AI error: {e}")
        score, _ = compute_ai_signals(text)
        verdict = "likely_ai" if score > 0.6 else "uncertain" if score > 0.3 else "likely_human"
        return TextAiResponse(ai_probability=score, verdict=verdict, confidence="low",
            signals=["Gemini call failed — heuristic fallback"],
            explanation=f"Gemini error: {str(e)[:60]}. Using keyword heuristics.",
            gemini_active=False)


@app.get("/")
def health():
    return {
        "status":       "Sentinel v8 running",
        "architecture": "Gemini primary judge + ML/keyword first-pass",
        "gemini":       "active" if GEMINI_API_KEY else "⚠ GEMINI_API_KEY not set",
        "ml_model":     "loaded" if ml_classifier else "keyword fallback",
        "val_acc":      model_info.get("val_acc", "n/a"),
        "whitelist":    f"{len(whitelist)} phrases protected",
    }
