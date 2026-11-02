#!/bin/sh
# Build a clean, shareable copy of the Smart Retry MVP for the public GitHub repo.
# Usage: scripts/export_repo.sh TARGET_DIR
# Copies only the MVP, its data, specs and deliverables. Never copies local data, credentials,
# virtual environments, node_modules, build output or unrelated files from the home folder.
set -e
SRC="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:?usage: export_repo.sh TARGET_DIR}"
mkdir -p "$DEST"
rsync -a --delete \
  --exclude '.git' --exclude '.venv' --exclude 'node_modules' --exclude 'dist' --exclude 'dist-demo' --exclude '.local-data' \
  --exclude 'tests/artifacts' --exclude '__pycache__' --exclude '*.pyc' --exclude '.DS_Store' \
  --exclude 'tsconfig.tsbuildinfo' --exclude 'test-results' \
  "$SRC/app" "$DEST/"
mkdir -p "$DEST/scripts" "$DEST/docs" "$DEST/deliverables" "$DEST/data"
rsync -a --delete "$SRC/scripts/deck" "$DEST/scripts/"
cp "$SRC/scripts/md_to_docx.py" "$SRC/scripts/export_repo.sh" "$DEST/scripts/"
rsync -a --delete --exclude '.DS_Store' "$SRC/wireframes" "$DEST/"
# Specs live at the project root because the app fingerprints the master spec there.
cp "$SRC/Belvo_Payments_Data_Analysis.md" "$SRC/Belvo_Smart_Retry_Decision_Log.md" "$SRC/Belvo_Challenge_Payments_Product.md" "$DEST/"
sed "s#/Users/[^']*/Belvo Retry System MVP#<project folder>#g" "$SRC/Belvo_Smart_Retry_Analytical_Diagnostic.md" > "$DEST/Belvo_Smart_Retry_Analytical_Diagnostic.md"
# The app reads the two challenge CSVs from the project root.
cp "$SRC/PaymentsPM_Challenge_loan_info.csv" "$SRC/PaymentsPM_Challenge_payment_requests.csv" "$DEST/"
for f in Summary.md Summary.docx Presentation.pptx Presentation_Short.pptx PRD.md PRD.docx User_Guide.md User_Guide.docx \
         Demo_Happy_Path.mp4 Demo_Edge_Cases.mp4 Results.csv Payment_Requests.csv Testing.csv Deliverables.md; do
  cp "$SRC/Belvo_Smart_Retry_$f" "$DEST/deliverables/"
done
rmdir "$DEST/docs" "$DEST/data" 2>/dev/null || true
echo "Exported to $DEST"
