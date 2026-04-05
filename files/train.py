# train.py — Sentinel ML trainer (improved)
# Changes from v1:
#   - Added mental health / support language as clean examples
#   - Added whitelist phrases that are never flagged regardless of score
#   - More balanced training data to reduce false positives
#
# Install: pip install scikit-learn pandas joblib
# Run:     python train.py

import os
import re
import joblib
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.pipeline import Pipeline
from sklearn.model_selection import train_test_split
from sklearn.metrics import classification_report

# ── Whitelist — these phrases are NEVER flagged regardless of ML score ────────
# Saved alongside the model so backend.py can use it too.
WHITELIST = [
    "reach out",
    "support hotline",
    "if you are in distress",
    "if you're in distress",
    "immediate distress",
    "please reach out",
    "mental health",
    "you are not alone",
    "you're not alone",
    "it gets better",
    "help is available",
    "crisis line",
    "talk to someone",
    "seek help",
    "here for you",
    "take care of yourself",
    "you matter",
    "safe space",
    "support group",
    "professional help",
    "you are loved",
    "you're loved",
    "we care about you",
    "resources available",
    "hotline",
    "helpline",
]

# ── Extra training examples (manually curated) ────────────────────────────────
# These supplement the downloaded dataset with edge cases the model
# needs to learn — especially support/mental health language as clean.

EXTRA_CLEAN = [
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

EXTRA_TOXIC = [
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

def clean(text: str) -> str:
    text = str(text).lower()
    text = re.sub(r"http\S+", "", text)
    text = re.sub(r"@\w+", "", text)
    text = re.sub(r"[^a-z0-9\s!?.,']", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


# ── Load dataset ──────────────────────────────────────────────────────────────
print("[1/5] Loading dataset...")

df = None
FALLBACK_JIGSAW_PATH = "train.csv"

if os.path.exists(FALLBACK_JIGSAW_PATH):
    print(f"      Found local Jigsaw file.")
    raw = pd.read_csv(FALLBACK_JIGSAW_PATH)
    toxic_cols = ["toxic","severe_toxic","obscene","threat","insult","identity_hate"]
    raw["label"] = (raw[toxic_cols].sum(axis=1) > 0).astype(int)
    df = raw[["comment_text","label"]].rename(columns={"comment_text":"text"})
    print(f"      Rows: {len(df)}")

if df is None:
    print("      Downloading cyberbullying dataset...")
    try:
        import urllib.request
        url = (
            "https://raw.githubusercontent.com/nicholasgasior/csv-datasets/"
            "master/cyberbullying_tweets.csv"
        )
        urllib.request.urlretrieve(url, "cyberbullying_tweets.csv")
        raw = pd.read_csv("cyberbullying_tweets.csv")
        if "tweet_text" in raw.columns and "cyberbullying_type" in raw.columns:
            raw["label"] = (raw["cyberbullying_type"] != "not_cyberbullying").astype(int)
            df = raw[["tweet_text","label"]].rename(columns={"tweet_text":"text"})
        elif "Text" in raw.columns and "oh_label" in raw.columns:
            df = raw[["Text","oh_label"]].rename(columns={"Text":"text","oh_label":"label"})
        print(f"      Rows: {len(df)}")
    except Exception as e:
        print(f"      Download failed: {e} — using built-in data only")
        df = pd.DataFrame(columns=["text","label"])

# ── Merge with curated examples ───────────────────────────────────────────────
print("[2/5] Merging curated examples...")

extra = pd.DataFrame(
    [(t, 0) for t in EXTRA_CLEAN] + [(t, 1) for t in EXTRA_TOXIC],
    columns=["text","label"]
)

# Repeat curated examples several times so they have meaningful weight
# against a large downloaded dataset
extra_weighted = pd.concat([extra] * 20, ignore_index=True)

df = pd.concat([df, extra_weighted], ignore_index=True)
df["text"] = df["text"].apply(clean)
df = df.dropna(subset=["text"])
df = df[df["text"].str.len() > 3]

print(f"      Total samples : {len(df)}")
print(f"      Toxic (1)     : {df['label'].sum()}")
print(f"      Clean (0)     : {(df['label']==0).sum()}")

# ── Split ─────────────────────────────────────────────────────────────────────
print("[3/5] Splitting 80/20...")
X_train, X_test, y_train, y_test = train_test_split(
    df["text"], df["label"],
    test_size=0.2, random_state=42, stratify=df["label"]
)

# ── Train ─────────────────────────────────────────────────────────────────────
print("[4/5] Training (TF-IDF + Logistic Regression)...")

pipeline = Pipeline([
    ("tfidf", TfidfVectorizer(
        ngram_range=(1, 3),     # up to trigrams for better context
        max_features=75000,     # more features than before
        sublinear_tf=True,
        min_df=2,
    )),
    ("clf", LogisticRegression(
        max_iter=2000,          # more iterations
        C=3.0,                  # slightly stronger regularization vs v1
        class_weight="balanced",
        solver="lbfgs",
        n_jobs=-1,
    )),
])

pipeline.fit(X_train, y_train)

# ── Evaluate ──────────────────────────────────────────────────────────────────
print("[5/5] Evaluating...")
y_pred = pipeline.predict(X_test)
print("\n" + classification_report(y_test, y_pred, target_names=["clean","toxic"]))

# ── Save model + whitelist together ──────────────────────────────────────────
bundle = {"model": pipeline, "whitelist": WHITELIST}
joblib.dump(bundle, "model.pkl")
print("✓  Saved model + whitelist to model.pkl")

# ── Sanity check ──────────────────────────────────────────────────────────────
print("\nSanity check (should all pass):")
tests = [
    ("If you are in immediate distress, please reach out to a support hotline.", "clean"),
    ("You are not alone, help is available.",                                    "clean"),
    ("nobody wants you around just disappear",                                   "TOXIC"),
    ("you are worthless and everyone hates you",                                 "TOXIC"),
    ("Great post, really appreciate you sharing this.",                          "clean"),
    ("go kill yourself nobody would miss you",                                   "TOXIC"),
    ("Mental health resources are listed below.",                                "clean"),
    ("shut up you absolute moron",                                               "TOXIC"),
]

all_pass = True
for text, expected in tests:
    cleaned = clean(text)
    # Check whitelist first
    is_whitelisted = any(w in text.lower() for w in WHITELIST)
    if is_whitelisted:
        score = 0.0
        tag = "clean (whitelisted)"
    else:
        score = pipeline.predict_proba([cleaned])[0][1]
        tag = "TOXIC" if score > 0.5 else "clean"

    expected_tag = expected.lower().replace("toxic", "TOXIC")
    passed = (tag.startswith(expected.split()[0]))
    status = "✓" if passed else "✗ FAIL"
    if not passed:
        all_pass = False
    print(f"  {status}  [{tag:<24} {score:.2f}]  {text[:60]}")

print("\n" + ("All tests passed ✓" if all_pass else "Some tests failed — check your data"))
print("\nNext: copy model.pkl into your files/ folder and push to GitHub.\n")
