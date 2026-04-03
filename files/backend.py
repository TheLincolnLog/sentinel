# backend.py — Sentinel FastAPI backend
# Run with: uvicorn backend:app --reload
# Install: pip install fastapi uvicorn

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import re

app = FastAPI()

# Allow requests from Chrome extensions and localhost
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["POST"],
    allow_headers=["Content-Type"],
)

# ── Keyword lists ─────────────────────────────────────────────────────────────

MANIPULATION_PHRASES = [
    "shocking", "shocking truth", "they don't want you to know",
    "act now", "you won't believe", "breaking", "urgent",
    "limited time", "exclusive", "secret", "what they're hiding",
    "wake up", "open your eyes", "share before it's deleted",
    "doctors hate", "one weird trick", "miracle", "guaranteed",
]

TOXICITY_WORDS = [
    "idiot", "moron", "stupid", "dumb", "loser", "pathetic",
    "worthless", "disgusting", "hate", "garbage", "trash",
    "scum", "filth", "evil", "destroy",
]

MISINFO_PHRASES = [
    "100%", "proven fact", "scientists confirm", "definitive proof",
    "nobody is talking about", "mainstream media won't report",
    "cover-up", "the truth is", "hoax", "fake news",
    "they're lying", "completely safe", "totally harmless",
    "cure", "cure for", "eliminate", "eradicate",
]


def score_text(text: str, phrases: list[str]) -> tuple[float, list[str]]:
    """
    Returns (score 0-1, list of matched phrases).
    Score = matched_weight / len(phrases), capped at 1.0.
    """
    text_lower = text.lower()
    matched = []
    weight = 0

    for phrase in phrases:
        if phrase.lower() in text_lower:
            matched.append(phrase)
            weight += 1

    # Also count ALL-CAPS words as a misinfo/manipulation signal
    caps_words = re.findall(r'\b[A-Z]{4,}\b', text)
    weight += len(caps_words) * 0.5

    score = min(weight / max(len(phrases) * 0.3, 1), 1.0)
    return round(score, 3), matched


def build_flags(matched_phrases: list[str], flag_type: str) -> list[dict]:
    return [{"phrase": p, "type": flag_type} for p in matched_phrases]


# ── Request / Response models ─────────────────────────────────────────────────

class AnalyzeRequest(BaseModel):
    text: str

class AnalyzeResponse(BaseModel):
    toxicity:     float
    manipulation: float
    misinfo:      float
    flags:        list[dict]


# ── Endpoint ──────────────────────────────────────────────────────────────────

@app.post("/api/analyze-text", response_model=AnalyzeResponse)
def analyze_text(req: AnalyzeRequest):
    text = req.text[:4000]  # hard cap

    manip_score, manip_matches = score_text(text, MANIPULATION_PHRASES)
    tox_score,   tox_matches   = score_text(text, TOXICITY_WORDS)
    mis_score,   mis_matches   = score_text(text, MISINFO_PHRASES)

    flags = (
        build_flags(manip_matches, "manipulation") +
        build_flags(tox_matches,   "toxicity") +
        build_flags(mis_matches,   "misinfo")
    )

    return AnalyzeResponse(
        toxicity=tox_score,
        manipulation=manip_score,
        misinfo=mis_score,
        flags=flags,
    )


# ── Health check ──────────────────────────────────────────────────────────────

@app.get("/")
def health():
    return {"status": "Sentinel backend running"}
