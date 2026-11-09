#!/bin/bash
# ── Vitals build ──────────────────────────────────────────────

set -euo pipefail

cd "$(dirname "$0")"
dist="$HOME/.local/share/vitals/dist"
go_version="1.26.10"
mkdir -p "$dist"

export GOTOOLCHAIN=local CGO_ENABLED=0

# ── Binaries ──────────────────────────────────────────────────
for arch in amd64 arm64; do
  GOOS=linux GOARCH=$arch mise exec "go@$go_version" -- go build -trimpath -ldflags "-s -w -X main.appVersion=dev" -o "$dist/vitals-linux-$arch.new" .
  mv "$dist/vitals-linux-$arch.new" "$dist/vitals-linux-$arch"
done

sha256sum "$dist"/vitals-linux-*
