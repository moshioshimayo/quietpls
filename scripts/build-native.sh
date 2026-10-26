#!/bin/bash
# Builds native/mic-users (universal arm64 + x86_64, macOS 14+) into bin/.
# Skips when the binary is already newer than its source.
set -euo pipefail
cd "$(dirname "$0")/.."
src=native/mic-users.swift
out=bin/mic-users
[ "$out" -nt "$src" ] && exit 0
mkdir -p bin
tmp=$(mktemp -d)
for arch in arm64 x86_64; do
  swiftc -O -target "$arch-apple-macos14.0" -o "$tmp/$arch" "$src"
done
lipo -create "$tmp/arm64" "$tmp/x86_64" -output "$out"
rm -rf "$tmp"
