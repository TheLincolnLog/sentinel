# backend.py — Sentinel FastAPI backend (ML edition)
# Run with: uvicorn backend:app --reload
# Install:  pip install fastapi uvicorn scikit-learn joblib pandas

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

# ── Load ML model (if available) ──────────────────────────────────────────────
MODEL_PATH = "model.pkl"
ml_model = None

if os.path.exists(MODEL_PATH):
    try:
        ml_model = joblib.load(MODEL_PATH)
        print(f"✓  ML model loaded from {MODEL_PATH}")
    except Exception as e:
        print(f"⚠  Could not load model.pkl: {e} — falling back to keywords")
else:
    print("⚠  model.pkl not found — using keyword detection only")
    print("   Run train.py to generate the model, then copy model.pkl here.")


# ── Keyword lists (fallback + manipulation/misinfo, which ML doesn't cover) ───

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


# ── Text cleaning (must match train.py) ───────────────────────────────────────

def clean(text: str) -> str:
    text = text.lower()
    text = re.sub(r"http\S+", "", text)
    text = re.sub(r"@\w+", "", text)
    text = re.sub(r"[^a-z0-9\s!?.,']", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


# ── Keyword scorer ────────────────────────────────────────────────────────────

def keyword_score(text: str, phrases: list[str]) -> tuple[float, list[str]]:
    text_lower = text.lower()
    matched = [p for p in phrases if p.lower() in text_lower]
    caps_count = len(re.findall(r'\b[A-Z]{4,}\b', text))
    weight = len(matched) + caps_count * 0.5
    score = min(weight / max(len(phrases) * 0.3, 1), 1.0)
    return round(score, 3), matched


def build_flags(phrases: list[str], flag_type: str) -> list[dict]:
    return [{"phrase": p, "type": flag_type} for p in phrases]


# ── Split text into sentences for per-sentence highlighting ───────────────────

def split_sentences(text: str) -> list[str]:
    """Split on sentence boundaries, filter short fragments."""
    parts = re.split(r'(?<=[.!?])\s+', text)
    return [p.strip() for p in parts if len(p.strip()) > 8]


# ── ML toxicity scoring ───────────────────────────────────────────────────────

def ml_toxicity_score(text: str) -> tuple[float, list[dict]]:
    """
    Uses the trained model to score the full text AND each sentence.
    Returns (overall_score, list of flagged sentence dicts).
    """
    if ml_model is None:
        return 0.0, []

    # Overall score
    overall = float(ml_model.predict_proba([clean(text)])[0][1])

    # Per-sentence to find which parts are toxic for highlighting
    sentences = split_sentences(text)
    flags = []
    for sent in sentences:
        score = float(ml_model.predict_proba([clean(sent)])[0][1])
        if score > 0.6:   # threshold: flag if >60% probability
            flags.append({
                "phrase": sent[:120],  # cap length for DOM matching
                "type": "toxicity",
                "score": round(score, 3),
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


# ── Main endpoint ─────────────────────────────────────────────────────────────

@app.post("/api/analyze-text", response_model=AnalyzeResponse)
def analyze_text(req: AnalyzeRequest):
    text = req.text[:5000]

    # Manipulation + misinfo — keyword based (works without ML model)
    manip_score, manip_matches = keyword_score(text, MANIPULATION_PHRASES)
    mis_score,   mis_matches   = keyword_score(text, MISINFO_PHRASES)

    flags = (
        build_flags(manip_matches, "manipulation") +
        build_flags(mis_matches,   "misinfo")
    )

    # Toxicity — ML model if available, keywords as fallback
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


# ── Health check ──────────────────────────────────────────────────────────────

@app.get("/")
def health():
    return {
        "status": "Sentinel backend running",
        "ml_model": "loaded" if ml_model else "not found — keyword mode",
    }
