# backend.py — Sentinel v4 (updated for SGD bundle)
# Run:     uvicorn backend:app --reload
# Install: pip install fastapi uvicorn scikit-learn joblib

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional
import re, os, math, joblib

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["POST"],
    allow_headers=["Content-Type"],
)

MODEL_PATH = "model.pkl"
ml_features   = None
ml_classifier = None
whitelist     = []
model_info    = {}

if os.path.exists(MODEL_PATH):
    try:
        bundle = joblib.load(MODEL_PATH)
        if isinstance(bundle, dict):
            if "features" in bundle:
                ml_features   = bundle["features"]
                ml_classifier = bundle["model"]
                whitelist     = bundle.get("whitelist", [])
                model_info    = {"epochs": bundle.get("epochs","?"), "val_acc": bundle.get("val_acc","?")}
            else:
                ml_classifier = bundle["model"]
                whitelist     = bundle.get("whitelist", [])
        else:
            ml_classifier = bundle
        print(f"✓  Model loaded  val_acc={model_info.get('val_acc','?')}")
    except Exception as e:
        print(f"⚠  model.pkl error: {e}")
else:
    print("⚠  model.pkl not found")

def predict_toxic(text):
    if ml_classifier is None: return 0.0
    c = clean(text)
    try:
        if ml_features is not None:
            feat = ml_features.transform([c])
            return float(ml_classifier.predict_proba(feat)[0][1])
        else:
            return float(ml_classifier.predict_proba([c])[0][1])
    except: return 0.0

MANIPULATION_PHRASES = ["shocking","shocking truth","they don't want you to know","act now","you won't believe","breaking","urgent","limited time","exclusive","secret","what they're hiding","wake up","open your eyes","share before it's deleted","doctors hate","one weird trick","miracle","guaranteed","what the media won't tell you","do your own research","sheeple"]
MISINFO_PHRASES = ["100%","proven fact","scientists confirm","definitive proof","nobody is talking about","mainstream media won't report","cover-up","the truth is","hoax","fake news","they're lying","completely safe","totally harmless","cure for","deep state","plandemic","staged","crisis actor","false flag"]
TOXICITY_KEYWORDS = ["idiot","moron","stupid","dumb","loser","pathetic","worthless","disgusting","trash","scum","filth","kill yourself","kys","go die","nobody likes you","waste of space"]
SOCIAL_HARMFUL = ["ratio","nobody asked","get ratio'd","cope harder","stay mad","you're irrelevant","delete this","get off the internet","nobody cares about you","touch grass loser","imagine being this dumb"]
AI_TRANSITIONS = ["furthermore","moreover","in conclusion","it is worth noting","it's worth noting","it is important to","in summary","to summarize","in addition","as a result","consequently","nevertheless","on the other hand","it should be noted","this highlights","this demonstrates","this underscores","plays a crucial role","it is essential","needless to say","in the realm of","dive into","delve into","leverage","game-changer","at the end of the day","moving forward","going forward","in terms of"]
AI_HEDGES = ["it is worth noting","it should be noted","importantly","significantly","ultimately","essentially","fundamentally","in essence","at its core","by and large","for the most part","in many ways","in a sense","to some extent"]

def compute_ai_score(text):
    if len(text.strip()) < 80: return 0.0, []
    signals, flags = {}, []
    text_lower = text.lower()
    word_count = max(len(text.split()), 1)
    sentences = [s.strip() for s in re.split(r'[.!?]+', text) if len(s.strip()) > 5]
    if len(sentences) >= 4:
        lengths = [len(s.split()) for s in sentences]
        mean_l = sum(lengths)/len(lengths)
        variance = sum((l-mean_l)**2 for l in lengths)/len(lengths)
        cv = math.sqrt(variance)/mean_l if mean_l > 0 else 1.0
        signals["low_burstiness"] = max(0.0, 1.0 - cv*2)
    hits = [p for p in AI_TRANSITIONS if p in text_lower]
    density = len(hits)/(word_count/100)
    signals["transitions"] = min(density/3, 1.0)
    for p in hits[:4]: flags.append({"phrase": p, "type": "ai", "score": round(signals["transitions"],3)})
    hedges = [p for p in AI_HEDGES if p in text_lower]
    signals["hedges"] = min(len(hedges)/(word_count/100)/2, 1.0)
    words = re.findall(r'\b[a-z]+\b', text_lower)
    if len(words) > 20:
        ttr = len(set(words))/len(words)
        signals["vocab"] = max(0.0, 1.0 - abs(ttr-0.5)*4)
    informal = text.count("—")+text.count("–")+text.count("…")+text.count("!")+len(re.findall(r'\.\.\.', text))
    signals["no_informal"] = max(0.0, 1.0 - informal/(word_count/50))
    caps = len(re.findall(r'\b[A-Z]{3,}\b', text))
    signals["no_caps"] = 1.0 if caps == 0 else max(0.0, 1.0-caps*0.2)
    weights = {"low_burstiness":0.30,"transitions":0.25,"hedges":0.15,"vocab":0.15,"no_informal":0.10,"no_caps":0.05}
    total_w = sum(weights[k] for k in signals)
    if total_w == 0: return 0.0, []
    score = sum(signals[k]*weights[k] for k in signals)/total_w
    return round(min(score,1.0),3), flags

def clean(text):
    text = text.lower()
    text = re.sub(r"http\S+","",text); text = re.sub(r"@\w+","",text)
    text = re.sub(r"[^a-z0-9\s!?.,']"," ",text)
    return re.sub(r"\s+"," ",text).strip()

def is_whitelisted(text):
    t = text.lower()
    return any(w in t for w in whitelist)

def keyword_score(text, phrases):
    t = text.lower()
    matched = [p for p in phrases if p.lower() in t]
    caps = len(re.findall(r'\b[A-Z]{4,}\b', text))
    weight = len(matched) + caps*0.5
    score = min(weight/max(len(phrases)*0.3,1), 1.0)
    return round(score,3), matched

def build_flags(phrases, flag_type):
    return [{"phrase": p, "type": flag_type} for p in phrases]

def split_sentences(text):
    return [p.strip() for p in re.split(r'(?<=[.!?])\s+', text) if len(p.strip()) > 8]

def ml_toxicity(text):
    overall = predict_toxic(text)
    flags = []
    for sent in split_sentences(text):
        if is_whitelisted(sent): continue
        score = predict_toxic(sent)
        if score > 0.6:
            flags.append({"phrase": sent[:120], "type": "toxicity", "score": round(score,3)})
    return round(overall,3), flags

class AnalyzeRequest(BaseModel):
    text: str
    mode: Optional[str] = None

class AnalyzeResponse(BaseModel):
    toxicity: float; manipulation: float; misinfo: float
    ai_score: float; ml_active: bool; flags: list

@app.post("/api/analyze-text", response_model=AnalyzeResponse)
def analyze_text(req: AnalyzeRequest):
    text = req.text[:5000]
    manip_score, manip_matches = keyword_score(text, MANIPULATION_PHRASES)
    mis_score,   mis_matches   = keyword_score(text, MISINFO_PHRASES)
    _,           social_matches= keyword_score(text, SOCIAL_HARMFUL)
    flags = build_flags(manip_matches,"manipulation")+build_flags(mis_matches,"misinfo")+build_flags(social_matches,"toxicity")
    if ml_classifier is not None:
        tox_score, tox_flags = ml_toxicity(text); flags += tox_flags; ml_active = True
    else:
        tox_score, tox_matches = keyword_score(text, TOXICITY_KEYWORDS); flags += build_flags(tox_matches,"toxicity"); ml_active = False
    ai_score, ai_flags = compute_ai_score(text); flags += ai_flags
    return AnalyzeResponse(toxicity=tox_score,manipulation=manip_score,misinfo=mis_score,ai_score=ai_score,ml_active=ml_active,flags=flags)

@app.get("/")
def health():
    return {"status":"Sentinel backend running","ml_model":"loaded" if ml_classifier else "keyword mode","val_acc":model_info.get("val_acc","n/a"),"epochs":model_info.get("epochs","n/a"),"whitelist":f"{len(whitelist)} phrases protected"}
