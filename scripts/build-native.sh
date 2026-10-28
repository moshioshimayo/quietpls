#!/bin/bash
# Builds the native helpers (universal arm64 + x86_64) into bin/:
#   mic-users  which apps use the mic (meeting-detector.js), macOS 14+
#   capture    Capture (beta) stereo recorder: mic + system-audio tap, macOS 14.4+
# Skips a helper when its binary is already newer than its source.
set -euo pipefail
cd "$(dirname "$0")/.."
build() {
  local name=$1 target=$2
  local src=native/$name.swift out=bin/$name
  [ "$out" -nt "$src" ] && return 0
  mkdir -p bin
  local tmp
  tmp=$(mktemp -d)
  for arch in arm64 x86_64; do
    swiftc -O -target "$arch-apple-macos$target" -o "$tmp/$arch" "$src"
  done
  lipo -create "$tmp/arm64" "$tmp/x86_64" -output "$out"
  rm -rf "$tmp"
}
build mic-users 14.0
build capture 14.4
