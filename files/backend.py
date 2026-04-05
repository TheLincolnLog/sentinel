# backend.py — Sentinel FastAPI backend (v2, whitelist-aware)
# Run:     uvicorn backend:app --reload
# Install: pip install fastapi uvicorn scikit-learn joblib pandas

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import re, os, joblib

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["POST"],
    allow_headers=["Content-Type"],
)

# ── Load model + whitelist ────────────────────────────────────────────────────
MODEL_PATH = "model.pkl"
ml_model  = None
whitelist = []

if os.path.exists(MODEL_PATH):
    try:
        bundle = joblib.load(MODEL_PATH)
        # Support both old (just model) and new (dict with whitelist) format
        if isinstance(bundle, dict):
            ml_model  = bundle["model"]
            whitelist = bundle.get("whitelist", [])
        else:
            ml_model = bundle
        print(f"✓  ML model loaded  |  whitelist: {len(whitelist)} phrases")
    except Exception as e:
        print(f"⚠  Could not load model.pkl: {e}")
else:
    print("⚠  model.pkl not found — keyword mode only")


# ── Keyword lists ─────────────────────────────────────────────────────────────

MANIPULATION_PHRASES = [
    "shocking", "shocking truth", "they don't want you to know",
    "act now", "you won't believe", "breaking", "urgent",
    "limited time", "exclusive", "secret", "what they're hiding",
    "wake up", "open your eyes", "share before it's deleted",
    "doctors hate", "one weird trick", "miracle", "guaranteed",
]

MISINFO_PHRASES = [
    "100%", "proven fact", "scientists confirm", "definitive proof",
    "nobody is talking about", "mainstream media won't report",
    "cover-up", "the truth is", "hoax", "fake news",
    "they're lying", "completely safe", "totally harmless",
    "cure for", "eliminate", "eradicate",
]

TOXICITY_KEYWORDS = [
    "idiot", "moron", "stupid", "dumb", "loser", "pathetic",
    "worthless", "disgusting", "hate", "garbage", "trash",
    "scum", "filth", "evil", "destroy", "kill yourself",
]


# ── Helpers ───────────────────────────────────────────────────────────────────

def clean(text: str) -> str:
    text = text.lower()
    text = re.sub(r"http\S+", "", text)
    text = re.sub(r"@\w+", "", text)
    text = re.sub(r"[^a-z0-9\s!?.,']", " ", text)
    return re.sub(r"\s+", " ", text).strip()

def is_whitelisted(text: str) -> bool:
    """Return True if the text contains any whitelist phrase."""
    text_lower = text.lower()
    return any(phrase in text_lower for phrase in whitelist)

def keyword_score(text: str, phrases: list[str]) -> tuple[float, list[str]]:
    text_lower = text.lower()
    matched = [p for p in phrases if p.lower() in text_lower]
    caps = len(re.findall(r'\b[A-Z]{4,}\b', text))
    weight = len(matched) + caps * 0.5
    score = min(weight / max(len(phrases) * 0.3, 1), 1.0)
    return round(score, 3), matched

def build_flags(phrases: list[str], flag_type: str) -> list[dict]:
    return [{"phrase": p, "type": flag_type} for p in phrases]

def split_sentences(text: str) -> list[str]:
    parts = re.split(r'(?<=[.!?])\s+', text)
    return [p.strip() for p in parts if len(p.strip()) > 8]

def ml_toxicity_score(text: str) -> tuple[float, list[dict]]:
    if ml_model is None:
        return 0.0, []

    overall = float(ml_model.predict_proba([clean(text)])[0][1])

    flags = []
    for sent in split_sentences(text):
        # Skip whitelisted sentences entirely
        if is_whitelisted(sent):
            continue
        score = float(ml_model.predict_proba([clean(sent)])[0][1])
        if score > 0.6:
            flags.append({
                "phrase": sent[:120],
                "type":   "toxicity",
                "score":  round(score, 3),
            })

    return round(overall, 3), flags


# ── Models ────────────────────────────────────────────────────────────────────

class AnalyzeRequest(BaseModel):
    text: str

class AnalyzeResponse(BaseModel):
    toxicity:     float
    manipulation: float
    misinfo:      float
    ml_active:    bool
    flags:        list[dict]


# ── Endpoint ──────────────────────────────────────────────────────────────────

@app.post("/api/analyze-text", response_model=AnalyzeResponse)
def analyze_text(req: AnalyzeRequest):
    text = req.text[:5000]

    manip_score, manip_matches = keyword_score(text, MANIPULATION_PHRASES)
    mis_score,   mis_matches   = keyword_score(text, MISINFO_PHRASES)

    flags = (
        build_flags(manip_matches, "manipulation") +
        build_flags(mis_matches,   "misinfo")
    )

    if ml_model is not None:
        tox_score, tox_flags = ml_toxicity_score(text)
        flags += tox_flags
        ml_active = True
    else:
        tox_score, tox_matches = keyword_score(text, TOXICITY_KEYWORDS)
        flags += build_flags(tox_matches, "toxicity")
        ml_active = False

    return AnalyzeResponse(
        toxicity=tox_score,
        manipulation=manip_score,
        misinfo=mis_score,
        ml_active=ml_active,
        flags=flags,
    )


# ── Health ────────────────────────────────────────────────────────────────────

@app.get("/")
def health():
    return {
        "status":     "Sentinel backend running",
        "ml_model":   "loaded" if ml_model else "not found",
        "whitelist":  f"{len(whitelist)} phrases protected",
    }
