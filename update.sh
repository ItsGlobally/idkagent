#!/bin/bash
# ─── idkagent Update Script ───────────────────────────────────
# Pulls latest changes and rebuilds the project.

set -e

cd "$(dirname "$0")"

echo "📦 Pulling latest changes..."
git pull origin main

echo "🔧 Installing dependencies..."
npm install

echo "🏗️  Building TypeScript..."
npx tsc

echo "✅ Update complete!"
