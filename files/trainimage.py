# train_image_detector.py — Sentinel AI Image Detector
#
# Downloads real datasets of AI-generated vs real images,
# trains a ResNet-based binary classifier, saves image_model.pkl
#
# Install: pip install torch torchvision scikit-learn Pillow requests tqdm
# Run:     python train_image_detector.py
# Run more epochs: python train_image_detector.py --epochs 20

import argparse, os, urllib.request, zipfile, shutil, time, json
import numpy as np
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--epochs",    type=int, default=10)
parser.add_argument("--batch-size",type=int, default=32)
parser.add_argument("--data-dir",  type=str, default="./image_data")
parser.add_argument("--no-download", action="store_true")
args = parser.parse_args()

# Change this line (around line 20)
# If your folders are directly in the project root:
DATA_DIR = Path(".")
# If they are inside another folder (like 'data/REAL'), use Path("./data")
MODEL_OUT = "image_model.pt"

# ── Dataset sources ───────────────────────────────────────────────────────────
# These are all freely available, no login required
DATASETS = [
    {
        "name": "CIFAKE subset (real vs AI-generated CIFAR-10 style)",
        "info": "https://www.kaggle.com/datasets/birdy654/cifake-real-and-ai-generated-synthetic-images",
        "note": "Download manually from Kaggle — requires free account",
        "manual": True,
    },
    {
        "name": "ThisPersonDoesNotExist samples",
        "info": "AI faces from StyleGAN2. Download script included below.",
        "manual": True,
    },
]

# ── What we actually auto-download ────────────────────────────────────────────
# Tiny but real: samples from a public GitHub repo with pre-labelled images


import torch
import torch.nn as nn
import torch.optim as optim
from torch.utils.data import Dataset, DataLoader
import torchvision.transforms as T
import torchvision.models as models
from PIL import Image
import requests
from sklearn.metrics import classification_report, roc_auc_score
import joblib

DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")
print(f"Using device: {DEVICE}")


# ── Dataset preparation ───────────────────────────────────────────────────────
def prepare_data():
    # --- CONFIGURATION ---
    MAX_SAMPLES_PER_CLASS = 1000  # Set this to 50000 for full training, or 1000 for a quick test
    # ---------------------

    real_dir = DATA_DIR / "REAL"
    fake_dir = DATA_DIR / "FAKE"

    print(f"\n[1/5] Checking local datasets in: {DATA_DIR.absolute()}")

    if not real_dir.exists() or not fake_dir.exists():
        print(f"  ❌ ERROR: Could not find folders '{real_dir}' or '{fake_dir}'")
        raise SystemExit(1)

    exts = ["*.jpg", "*.jpeg", "*.png", "*.bmp", "*.webp"]

    # Helper to collect limited samples
    def get_limited_paths(folder):
        paths = []
        for e in exts:
            paths.extend(list(folder.glob(e)))
            if len(paths) >= MAX_SAMPLES_PER_CLASS:
                break
        return paths[:MAX_SAMPLES_PER_CLASS]

    real_images = get_limited_paths(real_dir)
    fake_images = get_limited_paths(fake_dir)

    print(f"      Found total images on disk, but LIMITING to:")
    print(f"      -> {len(real_images)} real images")
    print(f"      -> {len(fake_images)} fake images")

    return real_dir, fake_dir  # We return the dirs, but we need to fix the Dataset class next!

def print_dataset_instructions():
    print("""
╔══════════════════════════════════════════════════════════════════════╗
║           HOW TO GET A REAL AI IMAGE DETECTION DATASET              ║
╠══════════════════════════════════════════════════════════════════════╣
║                                                                      ║
║  OPTION 1 — CIFAKE (best, free, 60k images) ★ RECOMMENDED          ║
║  ─────────────────────────────────────────────────────────────────  ║
║  1. Go to: https://kaggle.com/datasets/birdy654/                    ║
║             cifake-real-and-ai-generated-synthetic-images           ║
║  2. Sign in (free account)                                          ║
║  3. Download the ZIP (≈300MB)                                       ║
║  4. Unzip and place:                                                 ║
║       real images → ./image_data/real/                              ║
║       fake images → ./image_data/fake/                              ║
║  5. Run: python train_image_detector.py                              ║
║                                                                      ║
║  OPTION 2 — ArtiFact dataset (higher quality, 2.5M images)         ║
║  ─────────────────────────────────────────────────────────────────  ║
║  https://github.com/awsaf49/artifact                                ║
║  Covers: GAN, diffusion, deepfake, Adobe Firefly, DALL-E            ║
║                                                                      ║
║  OPTION 3 — FaceForensics++ (video/deepfake focused)                ║
║  ─────────────────────────────────────────────────────────────────  ║
║  https://github.com/ondyari/FaceForensics                           ║
║                                                                      ║
║  OPTION 4 — GenImage (1M+ images, 8 generators)                     ║
║  ─────────────────────────────────────────────────────────────────  ║
║  https://github.com/GenImage-Dataset/GenImage                       ║
║  Covers: Stable Diffusion, Midjourney, DALL-E 2, Wukong              ║
║                                                                      ║
╚══════════════════════════════════════════════════════════════════════╝
""")


# ── PyTorch Dataset ───────────────────────────────────────────────────────────
class ImageDataset(Dataset):
    def __init__(self, real_dir, fake_dir, transform, augment=False, limit=1000):
        exts = ["*.jpg", "*.jpeg", "*.png", "*.bmp", "*.webp"]

        # Collect paths with the limit applied
        real_paths = []
        for e in exts:
            real_paths.extend(list(real_dir.glob(e)))
            if len(real_paths) >= limit: break
        real_paths = real_paths[:limit]

        fake_paths = []
        for e in exts:
            fake_paths.extend(list(fake_dir.glob(e)))
            if len(fake_paths) >= limit: break
        fake_paths = fake_paths[:limit]

        self.paths = [(p, 0) for p in real_paths] + [(p, 1) for p in fake_paths]
        # ... the rest of your existing __init__ code ...
        self.transform = transform
        self.augment_transform = T.Compose([
            T.RandomHorizontalFlip(),
            T.RandomRotation(10),
            T.ColorJitter(brightness=0.2, contrast=0.2),
            transform,
        ]) if augment else transform

    def __len__(self): return len(self.paths)

    def __getitem__(self, idx):
        path, label = self.paths[idx]
        try:
            img = Image.open(path).convert("RGB")
            return self.augment_transform(img), label
        except Exception:
            # Return a black image if file is corrupt
            return self.transform(Image.new("RGB", (224,224))), label


# ── Model ─────────────────────────────────────────────────────────────────────
def build_model():
    # EfficientNet-B0: smaller than ResNet50, better accuracy for this task
    # Falls back to ResNet18 if torchvision version doesn't have EfficientNet
    try:
        model = models.efficientnet_b0(weights=models.EfficientNet_B0_Weights.IMAGENET1K_V1)
        model.classifier[1] = nn.Linear(model.classifier[1].in_features, 2)
        print("      Using EfficientNet-B0 backbone")
    except AttributeError:
        model = models.resnet18(weights=models.ResNet18_Weights.IMAGENET1K_V1)
        model.fc = nn.Linear(model.fc.in_features, 2)
        print("      Using ResNet18 backbone (EfficientNet not available)")
    return model.to(DEVICE)


# ── Training ──────────────────────────────────────────────────────────────────
def train():
    print_dataset_instructions()

    real_dir, fake_dir = prepare_data()

    transform = T.Compose([
        T.Resize((224, 224)),
        T.ToTensor(),
        T.Normalize(mean=[0.485,0.456,0.406], std=[0.229,0.224,0.225]),
    ])

    print("\n[2/5] Building datasets...")
    full_ds = ImageDataset(real_dir, fake_dir, transform, augment=False)
    n = len(full_ds)
    n_val = max(2, int(n * 0.2))
    n_train = n - n_val

    train_ds, val_ds = torch.utils.data.random_split(
        full_ds, [n_train, n_val],
        generator=torch.Generator().manual_seed(42)
    )
    # Augment training set
    train_ds.dataset.augment_transform = ImageDataset(
        real_dir, fake_dir, transform, augment=True
    ).augment_transform

    train_loader = DataLoader(train_ds, batch_size=args.batch_size,
                              shuffle=True,  num_workers=0, pin_memory=False)
    val_loader   = DataLoader(val_ds,   batch_size=args.batch_size,
                              shuffle=False, num_workers=0)

    print(f"      Train: {n_train}, Val: {n_val}")

    print("\n[3/5] Building model...")
    model = build_model()

    # Freeze backbone, only train classifier head first
    for name, param in model.named_parameters():
        if "classifier" not in name and "fc" not in name:
            param.requires_grad = False

    optimizer = optim.AdamW(
        filter(lambda p: p.requires_grad, model.parameters()),
        lr=1e-3, weight_decay=1e-4
    )
    scheduler = optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=args.epochs)
    criterion = nn.CrossEntropyLoss()

    print(f"\n[4/5] Training — {args.epochs} epochs")
    print(f"      {'Epoch':<8} {'Train Loss':<12} {'Val Acc':<10} {'Time'}")
    print(f"      {'-'*8} {'-'*12} {'-'*10} {'-'*8}")

    best_val_acc = 0.0
    best_state   = None

    # After 3 epochs, unfreeze full model for fine-tuning
    UNFREEZE_AT = 3

    for epoch in range(1, args.epochs + 1):
        t0 = time.time()

        # Unfreeze full model
        if epoch == UNFREEZE_AT:
            for param in model.parameters():
                param.requires_grad = True
            optimizer = optim.AdamW(model.parameters(), lr=1e-4, weight_decay=1e-4)
            scheduler = optim.lr_scheduler.CosineAnnealingLR(
                optimizer, T_max=args.epochs - UNFREEZE_AT + 1
            )

        # Train
        model.train()
        total_loss = 0.0
        for images, labels in train_loader:
            images, labels = images.to(DEVICE), labels.to(DEVICE)
            optimizer.zero_grad()
            outputs = model(images)
            loss = criterion(outputs, labels)
            loss.backward()
            optimizer.step()
            total_loss += loss.item()
        avg_loss = total_loss / max(len(train_loader), 1)

        # Validate
        model.eval()
        correct = total = 0
        all_probs, all_labels = [], []
        with torch.no_grad():
            for images, labels in val_loader:
                images, labels = images.to(DEVICE), labels.to(DEVICE)
                outputs = model(images)
                probs = torch.softmax(outputs, dim=1)[:, 1].cpu().numpy()
                preds = outputs.argmax(dim=1)
                correct += (preds == labels).sum().item()
                total   += labels.size(0)
                all_probs.extend(probs)
                all_labels.extend(labels.cpu().numpy())

        val_acc = correct / max(total, 1)
        elapsed = time.time() - t0
        print(f"      {epoch:<8} {avg_loss:<12.4f} {val_acc:<10.4f} {elapsed:.1f}s")
        scheduler.step()

        if val_acc > best_val_acc:
            best_val_acc = val_acc
            best_state = {k: v.clone() for k, v in model.state_dict().items()}

    # Restore best
    model.load_state_dict(best_state)

    print(f"\n      Best val accuracy: {best_val_acc:.4f}")

    # Final eval
    print("\n[5/5] Saving model...")
    torch.save({
        "model_state":  model.state_dict(),
        "model_arch":   model.__class__.__name__,
        "val_acc":      best_val_acc,
        "epochs":       args.epochs,
        "transform":    str(transform),
        "classes":      ["real", "ai_generated"],
        "threshold":    0.5,
    }, MODEL_OUT)
    print(f"✓  Saved {MODEL_OUT}  (val_acc={best_val_acc:.4f})")
    print(f"\nCopy {MODEL_OUT} to your files/ folder.")
    print("The backend will use it for AI image detection.")


if __name__ == "__main__":
    train()
