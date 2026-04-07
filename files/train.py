# train.py — Sentinel ML trainer v4 (Windows-compatible)
# Run:     python train.py
# Run more epochs: python train.py --epochs 50

import re, argparse, joblib, urllib.request, os, time, copy, tempfile
import pandas as pd
import numpy as np
from pathlib import Path
from sklearn.linear_model import SGDClassifier
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.pipeline import FeatureUnion
from sklearn.model_selection import train_test_split
from sklearn.metrics import classification_report, confusion_matrix
from sklearn.base import BaseEstimator, TransformerMixin

# ── Args ──────────────────────────────────────────────────────────────────────
parser = argparse.ArgumentParser()
parser.add_argument("--epochs",      type=int,  default=30)
parser.add_argument("--no-download", action="store_true")
args = parser.parse_args()

EPOCHS  = args.epochs
TMP_DIR = Path(tempfile.gettempdir())  # works on Windows, Mac, Linux

# ── Whitelist ─────────────────────────────────────────────────────────────────
WHITELIST = [
    "reach out", "support hotline", "if you are in distress",
    "if you're in distress", "immediate distress", "please reach out",
    "mental health", "you are not alone", "you're not alone",
    "it gets better", "help is available", "crisis line",
    "talk to someone", "seek help", "here for you",
    "take care of yourself", "you matter", "safe space",
    "support group", "professional help", "you are loved",
    "you're loved", "we care about you", "resources available",
    "hotline", "helpline", "counselor", "therapist", "therapy",
    "reach out to", "call for help", "crisis support",
]

# ── Curated examples ──────────────────────────────────────────────────────────
CLEAN_EXAMPLES = [
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
    "Happy to help you with that question.",
    "The weather today is absolutely beautiful.",
    "I just finished reading a great book last night.",
    "We should get together for lunch sometime.",
    "Congratulations on your achievement, you worked hard for it.",
    "This recipe looks delicious, I am going to try it.",
    "The game last night was really exciting.",
    "I appreciate your patience and understanding.",
    "Great job on the project, the team did amazing work.",
    "Looking forward to the weekend, have a good one.",
    "The presentation went really well, everyone loved it.",
]

TOXIC_EXAMPLES = [
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
    "shut up you absolute moron",
    "you are so dumb it is embarrassing",
    "go cry about it you pathetic loser",
    "i hate everything about you",
    "you are trash and always will be",
    "stop existing you waste of oxygen",
    "nobody asked for your worthless opinion",
    "you are a failure at everything you do",
    "i hope you get what you deserve you piece of trash",
    "this is why no one likes you",
    "you are the stupidest person i have ever seen",
    "get lost you absolute idiot",
    "you are such a disgusting human being",
    "nobody will ever love someone like you",
    "you should be embarrassed to even exist",
    "you are beyond pathetic and everyone sees it",
    "crawl back under the rock you came from",
    "you are the worst and i hope you know it",
    "just leave already no one wants you here",
    "you are a joke and everyone is laughing at you",
    "you have always been worthless and you always will be",
    "i have never seen someone so completely useless",
]

# ── Text cleaning ─────────────────────────────────────────────────────────────
def clean(text: str) -> str:
    text = str(text).lower()
    text = re.sub(r"http\S+",           "", text)
    text = re.sub(r"@\w+",              "", text)
    text = re.sub(r"[^a-z0-9\s!?.,']", " ", text)
    return re.sub(r"\s+",              " ", text).strip()

# ── Dataset download ──────────────────────────────────────────────────────────
def try_download_datasets():
    rows = []

    try:
        print("      Trying Davidson dataset...")
        url  = ("https://raw.githubusercontent.com/t-davidson/"
                "hate-speech-and-offensive-language/master/data/labeled_data.csv")
        path = str(TMP_DIR / "davidson.csv")
        urllib.request.urlretrieve(url, path)
        raw = pd.read_csv(path)
        raw["label"] = (raw["class"] < 2).astype(int)
        df = raw[["tweet", "label"]].rename(columns={"tweet": "text"}).copy()
        df["label"] = df["label"].astype(int)
        print(f"      Davidson: {len(df)} rows ✓")
        rows.append(df)
    except Exception as e:
        print(f"      Davidson failed: {e}")

    try:
        print("      Trying TweetEval dataset...")
        text_path  = str(TMP_DIR / "te_text.txt")
        label_path = str(TMP_DIR / "te_labels.txt")
        urllib.request.urlretrieve(
            "https://raw.githubusercontent.com/cardiffnlp/tweeteval"
            "/main/datasets/offensive/train_text.txt", text_path)
        urllib.request.urlretrieve(
            "https://raw.githubusercontent.com/cardiffnlp/tweeteval"
            "/main/datasets/offensive/train_labels.txt", label_path)
        with open(text_path,  encoding="utf-8") as f: texts  = [l.rstrip() for l in f]
        with open(label_path, encoding="utf-8") as f: labels = [l.rstrip() for l in f]
        # Keep only rows where both lists align and label is valid
        paired = [(t, int(l)) for t, l in zip(texts, labels) if l.strip().isdigit()]
        df = pd.DataFrame(paired, columns=["text", "label"])
        df["label"] = df["label"].astype(int)
        print(f"      TweetEval: {len(df)} rows ✓")
        rows.append(df)
    except Exception as e:
        print(f"      TweetEval failed: {e}")

    if not rows:
        return None

    out = pd.concat(rows, ignore_index=True)
    out["label"] = out["label"].astype(int)
    return out

# ── Build curated DataFrame ───────────────────────────────────────────────────
def build_curated_df(repeat: int = 15) -> pd.DataFrame:
    rows = (
        [(t, 0) for t in CLEAN_EXAMPLES] * repeat +
        [(t, 1) for t in TOXIC_EXAMPLES] * repeat
    )
    df = pd.DataFrame(rows, columns=["text", "label"])
    df["label"] = df["label"].astype(int)
    return df

# ── Load ──────────────────────────────────────────────────────────────────────
print("[1/6] Loading datasets...")

curated_df    = build_curated_df(repeat=15)
downloaded_df = None if args.no_download else try_download_datasets()

if downloaded_df is not None:
    df = pd.concat([downloaded_df, curated_df], ignore_index=True)
    print(f"      Combined: {len(df)} rows "
          f"({len(downloaded_df)} downloaded + {len(curated_df)} curated)")
else:
    df = curated_df.copy()
    print(f"      Using curated only: {len(df)} rows")

# Ensure types are correct before any access
df["text"]  = df["text"].apply(clean)
df["label"] = df["label"].astype(int)
df = df[df["text"].str.len() > 5].dropna(subset=["text", "label"]).reset_index(drop=True)

# Balance
min_count = df["label"].value_counts().min()

# Using the native .sample() on the GroupBy object is safer and faster
df = df.groupby("label").sample(n=min_count, random_state=42).reset_index(drop=True)

print(f"      Balanced: {len(df)} rows — "
      f"toxic={df['label'].sum()}, clean={(df['label']==0).sum()}")
# ── Features ──────────────────────────────────────────────────────────────────
word_vec = TfidfVectorizer(
    analyzer="word", ngram_range=(1, 3),
    max_features=80000, sublinear_tf=True, min_df=2, strip_accents="unicode",
)
char_vec = TfidfVectorizer(
    analyzer="char_wb", ngram_range=(2, 5),
    max_features=40000, sublinear_tf=True, min_df=3,
)
features = FeatureUnion([("word", word_vec), ("char", char_vec)])

# ── Split ─────────────────────────────────────────────────────────────────────
print("\n[2/6] Splitting 85/15...")
X_train, X_test, y_train, y_test = train_test_split(
    df["text"], df["label"],
    test_size=0.15, random_state=42, stratify=df["label"]
)

# ── Vectorize ─────────────────────────────────────────────────────────────────
print("[3/6] Fitting vectorizers...")
X_train_feat = features.fit_transform(X_train)
X_test_feat  = features.transform(X_test)
y_train_arr  = np.array(y_train)
y_test_arr   = np.array(y_test)

# ── Train ─────────────────────────────────────────────────────────────────────
classifier = SGDClassifier(
    loss="log_loss", alpha=1e-4, max_iter=1,
    warm_start=True,
    random_state=42, tol=None,
)

print(f"\n[4/6] Training — {EPOCHS} epochs")
print(f"  {'Epoch':<8} {'Train acc':<12} {'Val acc':<12} {'Time'}")
print(f"  {'-'*8} {'-'*12} {'-'*12} {'-'*8}")

rng = np.random.RandomState(42)
n   = X_train_feat.shape[0]
best_val_acc = 0.0
best_state   = None

for epoch in range(1, EPOCHS + 1):
    t0  = time.time()
    idx = rng.permutation(n)
    classifier.partial_fit(X_train_feat[idx], y_train_arr[idx], classes=[0, 1])
    train_acc = (classifier.predict(X_train_feat) == y_train_arr).mean()
    val_acc   = (classifier.predict(X_test_feat)  == y_test_arr).mean()
    print(f"  {epoch:<8} {train_acc:<12.4f} {val_acc:<12.4f} {time.time()-t0:.2f}s")
    if val_acc > best_val_acc:
        best_val_acc = val_acc
        best_state   = copy.deepcopy(classifier)

print(f"\n  Best val accuracy: {best_val_acc:.4f}")
classifier = best_state

# ── Evaluate ──────────────────────────────────────────────────────────────────
print("\n[5/6] Final evaluation...")
y_pred = classifier.predict(X_test_feat)
print("\n" + classification_report(y_test_arr, y_pred, target_names=["clean", "toxic"]))
cm = confusion_matrix(y_test_arr, y_pred)
print(f"Confusion matrix:")
print(f"  True clean → predicted clean : {cm[0][0]}")
print(f"  True clean → predicted toxic : {cm[0][1]}  ← false positives")
print(f"  True toxic → predicted clean : {cm[1][0]}  ← false negatives")
print(f"  True toxic → predicted toxic : {cm[1][1]}")

# ── Save ──────────────────────────────────────────────────────────────────────
print("\n[6/6] Saving model.pkl...")
joblib.dump({
    "features":  features,
    "model":     classifier,
    "whitelist": WHITELIST,
    "epochs":    EPOCHS,
    "val_acc":   best_val_acc,
}, "model.pkl")
print(f"✓  Saved model.pkl  (val_acc={best_val_acc:.4f}, epochs={EPOCHS})")

# ── Sanity check ──────────────────────────────────────────────────────────────
print("\nSanity check:")
TESTS = [
    ("If you are in immediate distress, please reach out to a support hotline.", False),
    ("You are not alone, help is available.",                                    False),
    ("nobody wants you around just disappear",                                   True),
    ("you are worthless and everyone hates you",                                 True),
    ("Great post, really appreciate you sharing this.",                          False),
    ("shut up you absolute moron nobody likes you",                              True),
    ("Mental health resources are listed below.",                                False),
    ("you should just stop existing waste of space",                             True),
    ("Looking forward to seeing everyone at the event.",                         False),
    ("i hope bad things happen to you every single day",                         True),
]

all_pass = True
for text, expect_toxic in TESTS:
    whitelisted = any(w in text.lower() for w in WHITELIST)
    if whitelisted:
        score, tag = 0.0, "clean (whitelisted)"
        passed = not expect_toxic
    else:
        feat  = features.transform([clean(text)])
        score = float(classifier.predict_proba(feat)[0][1])
        tag   = "TOXIC" if score > 0.5 else "clean"
        passed = (score > 0.5) == expect_toxic
    mark = "✓" if passed else "✗ FAIL"
    if not passed: all_pass = False
    print(f"  {mark}  [{tag:<26} {score:.2f}]  {text[:60]}")

print("\n" + ("All passed ✓" if all_pass else "Some failed — check above"))
print(f"\nDone. Copy model.pkl → your files/ folder and push to GitHub.\n")
