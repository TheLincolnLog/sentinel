# train.py — Sentinel ML trainer
# Trains a toxicity + cyberbullying classifier and saves model.pkl
#
# Install deps first:
#   pip install scikit-learn pandas requests joblib
#
# Run:
#   python train.py
#
# Output:
#   model.pkl  — the trained classifier (used by backend.py)

import os
import re
import joblib
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.pipeline import Pipeline
from sklearn.model_selection import train_test_split
from sklearn.metrics import classification_report

# ── 1. Load dataset ───────────────────────────────────────────────────────────
# We use the Jigsaw Toxic Comment dataset from Kaggle (via a public mirror).
# It has 160k Wikipedia comments labelled for: toxic, severe_toxic,
# obscene, threat, insult, identity_hate.
#
# If you have a Kaggle account, you can also download it directly:
#   https://www.kaggle.com/competitions/jigsaw-toxic-comment-classification-challenge
#
# For convenience we also support a smaller cyberbullying dataset that
# requires no login.

DATASET_URL = (
    "https://raw.githubusercontent.com/nicholasgasior/csv-datasets/"
    "master/cyberbullying_tweets.csv"
)

FALLBACK_JIGSAW_PATH = "train.csv"  # if you downloaded Kaggle data locally

print("[1/5] Loading dataset...")

df = None

# Try local Jigsaw file first (most accurate)
if os.path.exists(FALLBACK_JIGSAW_PATH):
    print(f"      Found local Jigsaw file: {FALLBACK_JIGSAW_PATH}")
    raw = pd.read_csv(FALLBACK_JIGSAW_PATH)
    # Any of the toxic sub-labels counts as toxic
    toxic_cols = ["toxic", "severe_toxic", "obscene", "threat", "insult", "identity_hate"]
    raw["label"] = (raw[toxic_cols].sum(axis=1) > 0).astype(int)
    df = raw[["comment_text", "label"]].rename(columns={"comment_text": "text"})
    print(f"      Jigsaw rows: {len(df)}")

# Otherwise download the smaller cyberbullying CSV (no login needed)
if df is None:
    print(f"      Downloading cyberbullying dataset...")
    try:
        import urllib.request
        urllib.request.urlretrieve(DATASET_URL, "cyberbullying_tweets.csv")
        raw = pd.read_csv("cyberbullying_tweets.csv")

        # Column names vary by source — handle both common formats
        if "tweet_text" in raw.columns and "cyberbullying_type" in raw.columns:
            raw["label"] = (raw["cyberbullying_type"] != "not_cyberbullying").astype(int)
            df = raw[["tweet_text", "label"]].rename(columns={"tweet_text": "text"})
        elif "Text" in raw.columns and "oh_label" in raw.columns:
            df = raw[["Text", "oh_label"]].rename(columns={"Text": "text", "oh_label": "label"})
        else:
            raise ValueError(f"Unknown columns: {list(raw.columns)}")

        print(f"      Downloaded rows: {len(df)}")
    except Exception as e:
        print(f"      Download failed: {e}")
        print("      Falling back to built-in example data...")

        # Minimal built-in fallback so training always works
        examples = [
            ("you are so stupid and ugly", 1),
            ("I hate you, go kill yourself", 1),
            ("nobody likes you loser", 1),
            ("you're worthless garbage", 1),
            ("shut up idiot", 1),
            ("you're so dumb I can't believe it", 1),
            ("this is harassment and you know it", 1),
            ("i will find you and hurt you", 1),
            ("Great article, thanks for sharing!", 0),
            ("I disagree but respect your opinion", 0),
            ("This is really helpful information", 0),
            ("Thanks for the update everyone", 0),
            ("Looking forward to the next post", 0),
            ("Interesting perspective on the topic", 0),
            ("Well written and informative", 0),
            ("I learned something new today", 0),
        ]
        df = pd.DataFrame(examples, columns=["text", "label"])
        print(f"      Using {len(df)} built-in examples (limited accuracy)")

# ── 2. Clean text ─────────────────────────────────────────────────────────────
print("[2/5] Cleaning text...")

def clean(text: str) -> str:
    text = str(text).lower()
    text = re.sub(r"http\S+", "", text)       # remove URLs
    text = re.sub(r"@\w+", "", text)           # remove @mentions
    text = re.sub(r"[^a-z0-9\s!?.,']", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text

df["text"] = df["text"].apply(clean)
df = df.dropna(subset=["text"])
df = df[df["text"].str.len() > 3]

print(f"      Total samples : {len(df)}")
print(f"      Toxic (1)     : {df['label'].sum()}")
print(f"      Clean (0)     : {(df['label'] == 0).sum()}")

# ── 3. Split ──────────────────────────────────────────────────────────────────
print("[3/5] Splitting train/test (80/20)...")
X_train, X_test, y_train, y_test = train_test_split(
    df["text"], df["label"], test_size=0.2, random_state=42, stratify=df["label"]
)

# ── 4. Train ──────────────────────────────────────────────────────────────────
print("[4/5] Training pipeline (TF-IDF + Logistic Regression)...")

pipeline = Pipeline([
    ("tfidf", TfidfVectorizer(
        ngram_range=(1, 2),    # unigrams + bigrams
        max_features=50000,
        sublinear_tf=True,     # log scaling of term frequency
        min_df=2,
    )),
    ("clf", LogisticRegression(
        max_iter=1000,
        C=5.0,                 # regularization strength
        class_weight="balanced",  # handles imbalanced datasets
        solver="lbfgs",
        n_jobs=-1,
    )),
])

pipeline.fit(X_train, y_train)

# ── 5. Evaluate ───────────────────────────────────────────────────────────────
print("[5/5] Evaluating...")
y_pred = pipeline.predict(X_test)
print("\n" + classification_report(y_test, y_pred, target_names=["clean", "toxic"]))

# ── Save ──────────────────────────────────────────────────────────────────────
joblib.dump(pipeline, "model.pkl")
print("✓  Model saved to model.pkl")
print("   Copy model.pkl into your 'files/' folder and push to GitHub.")
print("   The backend will load it automatically on startup.\n")

# Quick sanity check
test_cases = [
    "you are so stupid nobody likes you",
    "Great post, really helpful!",
    "I will destroy you loser",
    "Thanks for sharing this article",
]
print("Sanity check:")
for t in test_cases:
    score = pipeline.predict_proba([clean(t)])[0][1]
    tag = "TOXIC" if score > 0.5 else "clean"
    print(f"  [{tag}  {score:.2f}]  {t}")
