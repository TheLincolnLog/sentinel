# train.py — Sentinel ML trainer (v2, fixed)
# Run: python train.py

import re
import joblib
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.pipeline import Pipeline
from sklearn.model_selection import train_test_split
from sklearn.metrics import classification_report

# ── Whitelist — never flagged regardless of ML score ─────────────────────────
WHITELIST = [
    "reach out", "support hotline", "if you are in distress",
    "if you're in distress", "immediate distress", "please reach out",
    "mental health", "you are not alone", "you're not alone",
    "it gets better", "help is available", "crisis line",
    "talk to someone", "seek help", "here for you",
    "take care of yourself", "you matter", "safe space",
    "support group", "professional help", "you are loved",
    "you're loved", "we care about you", "resources available",
    "hotline", "helpline",
]

# ── Curated training examples ─────────────────────────────────────────────────
CLEAN = [
    "If you are in immediate distress, please reach out to a support hotline.",
    "You are not alone, help is always available.",
    "Please talk to someone you trust if you are struggling.",
    "Mental health support is available 24/7.",
    "Reach out to a crisis line if you need immediate help.",
    "It gets better, please seek professional help.",
    "We care about your wellbeing and are here for you.",
    "You matter and your feelings are valid.",
    "This is a safe space to share your experiences.",
    "Take care of yourself and reach out if you need support.",
    "If you or someone you know is struggling, help is available.",
    "Crisis resources are listed below for anyone who needs them.",
    "Remember you are loved and not alone in this.",
    "Please contact a mental health professional if needed.",
    "Support groups can be incredibly helpful for recovery.",
    "Great article, thanks for sharing this information.",
    "I completely agree with your point here.",
    "This made me think differently about the issue.",
    "Really appreciate you taking the time to explain this.",
    "Interesting perspective, I had not considered that before.",
    "Thank you for the kind words, it means a lot.",
    "Looking forward to hearing more about this topic.",
    "Well written and very informative post.",
    "I learned something valuable from reading this.",
    "This is exactly what I needed to read today.",
]

TOXIC = [
    "nobody wants you around, just disappear",
    "you are worthless and everyone knows it",
    "no one likes you, go away forever",
    "you should just give up on life",
    "everyone hates people like you",
    "you are ugly and stupid and pathetic",
    "kill yourself nobody would miss you",
    "you are a complete waste of space",
    "i hope something bad happens to you",
    "you deserve to suffer for that",
    "get out of here you disgusting loser",
    "you will never amount to anything",
    "nobody cares about you or your opinion",
    "you are the worst person I have ever seen",
    "shut up you absolute moron",
    "you are so dumb it is embarrassing",
    "go cry about it you pathetic loser",
    "i hate everything about you",
    "you are trash and always will be",
    "stop existing you waste of oxygen",
]

# ── Text cleaning ─────────────────────────────────────────────────────────────
def clean(text):
    text = str(text).lower()
    text = re.sub(r"http\S+", "", text)
    text = re.sub(r"@\w+", "", text)
    text = re.sub(r"[^a-z0-9\s!?.,']", " ", text)
    return re.sub(r"\s+", " ", text).strip()

# ── Build dataset from curated examples (repeated for weight) ─────────────────
print("[1/5] Building dataset...")

rows = (
    [(t, 0) for t in CLEAN] * 20 +
    [(t, 1) for t in TOXIC] * 20
)
df = pd.DataFrame(rows, columns=["text", "label"])
df["label"] = df["label"].astype(int)   # ← guarantees integer labels
df["text"]  = df["text"].apply(clean)
df = df[df["text"].str.len() > 3].reset_index(drop=True)

print(f"      Total  : {len(df)}")
print(f"      Toxic  : {(df['label']==1).sum()}")
print(f"      Clean  : {(df['label']==0).sum()}")

# ── Split ─────────────────────────────────────────────────────────────────────
print("[2/5] Splitting 80/20...")
X_train, X_test, y_train, y_test = train_test_split(
    df["text"], df["label"],
    test_size=0.2, random_state=42, stratify=df["label"]
)

# ── Train ─────────────────────────────────────────────────────────────────────
print("[3/5] Training...")
pipeline = Pipeline([
    ("tfidf", TfidfVectorizer(
        ngram_range=(1, 3),
        max_features=75000,
        sublinear_tf=True,
        min_df=1,
    )),
    ("clf", LogisticRegression(
        max_iter=2000,
        C=3.0,
        class_weight="balanced",
        solver="lbfgs",
    )),
])
pipeline.fit(X_train, y_train)

# ── Evaluate ──────────────────────────────────────────────────────────────────
print("[4/5] Evaluating...")
y_pred = pipeline.predict(X_test)
print("\n" + classification_report(y_test, y_pred, target_names=["clean", "toxic"]))

# ── Save ──────────────────────────────────────────────────────────────────────
print("[5/5] Saving model.pkl...")
joblib.dump({"model": pipeline, "whitelist": WHITELIST}, "model.pkl")
print("✓  Saved model.pkl\n")

# ── Sanity check ──────────────────────────────────────────────────────────────
print("Sanity check:")
tests = [
    ("If you are in immediate distress, please reach out to a support hotline.", False),
    ("You are not alone, help is available.",                                    False),
    ("nobody wants you around just disappear",                                   True),
    ("you are worthless and everyone hates you",                                 True),
    ("Great post, really appreciate you sharing this.",                          False),
    ("shut up you absolute moron",                                               True),
    ("Mental health resources are listed below.",                                False),
]

all_pass = True
for text, expect_toxic in tests:
    whitelisted = any(w in text.lower() for w in WHITELIST)
    if whitelisted:
        score, tag = 0.0, "clean (whitelisted)"
        passed = not expect_toxic
    else:
        score = pipeline.predict_proba([clean(text)])[0][1]
        tag   = "TOXIC" if score > 0.5 else "clean"
        passed = (score > 0.5) == expect_toxic

    mark = "✓" if passed else "✗ FAIL"
    if not passed:
        all_pass = False
    print(f"  {mark}  [{tag:<24} {score:.2f}]  {text[:65]}")

print("\n" + ("All tests passed ✓" if all_pass else "Some tests failed — review above"))
print("\nCopy model.pkl into your files/ folder and push to GitHub.\n")
