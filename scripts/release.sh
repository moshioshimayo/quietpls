#!/bin/bash
# Build a quietpls release: dmg + zip for arm64 and x64.
#
# Everything is env-driven and skips cleanly when absent:
#   MAC_SIGNING_IDENTITY  - "Developer ID Application: ..." (falls back to CSC_NAME,
#                           then to ad-hoc signing when neither is set)
#   APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID
#                         - notarize via notarytool; skipped when unset
#   NOTARY_PROFILE        - alternative: keychain profile name for `notarytool`
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="$(node -p "require('./package.json').version")"
OUT=dist

echo "==> Building quietpls ${VERSION}"

SIGN_ARGS=()
if [ -n "${MAC_SIGNING_IDENTITY:-}" ]; then
  SIGN_ARGS=(--config.mac.identity="$MAC_SIGNING_IDENTITY")
elif [ -n "${CSC_NAME:-}" ]; then
  SIGN_ARGS=(--config.mac.identity="$CSC_NAME")
else
  echo "==> No signing identity set (MAC_SIGNING_IDENTITY/CSC_NAME); building ad-hoc signed"
fi

# When Apple credentials are present, let electron-builder notarize AND staple
# the .app itself, BEFORE the dmg/zip targets are packed — so apps extracted
# from the zips pass `stapler validate` and zip hashes match the final artifacts.
if [ -n "${APPLE_TEAM_ID:-}" ] && { [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ] || [ -n "${NOTARY_PROFILE:-}" ]; }; then
  SIGN_ARGS+=(--config.mac.notarize=true)
else
  echo "==> Skipping in-build app notarization (no Apple credentials)"
fi

npx electron-builder --mac "${SIGN_ARGS[@]}"

echo "==> Build complete. Artifacts:"
ls -la "$OUT"/*.dmg "$OUT"/*.zip "$OUT"/latest-mac.yml 2>/dev/null || true

# ---- Notarization (optional, env-driven) ----
NOTARIZE=1
if [ -z "${NOTARY_PROFILE:-}" ] && { [ -z "${APPLE_ID:-}" ] || [ -z "${APPLE_APP_SPECIFIC_PASSWORD:-}" ]; }; then
  NOTARIZE=0
  echo "==> Skipping notarization (set APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD, or NOTARY_PROFILE)"
fi

if [ "$NOTARIZE" = 1 ]; then
  for DMG in "$OUT"/*.dmg; do
    echo "==> Notarizing $DMG"
    if [ -n "${NOTARY_PROFILE:-}" ]; then
      SUBMIT_ID="$(xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" 2>&1 | tee /dev/stderr | awk '/^[[:space:]]*id:/ {print $2; exit}')" || true
    else
      SUBMIT_ID="$(xcrun notarytool submit "$DMG" --apple-id "$APPLE_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD" --team-id "${APPLE_TEAM_ID:-}" 2>&1 | tee /dev/stderr | awk '/^[[:space:]]*id:/ {print $2; exit}')" || true
    fi
    if [ -z "$SUBMIT_ID" ]; then
      echo "!! Could not parse submission id for $DMG — notarization may have failed" >&2
      exit 1
    fi
    if [ -n "${NOTARY_PROFILE:-}" ]; then
      xcrun notarytool wait "$SUBMIT_ID" --keychain-profile "$NOTARY_PROFILE"
    else
      xcrun notarytool wait "$SUBMIT_ID" --apple-id "$APPLE_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD" --team-id "${APPLE_TEAM_ID:-}"
    fi
    echo "==> Stapling $DMG"
    xcrun stapler staple "$DMG"
    xcrun stapler validate "$DMG"
    echo "==> Gatekeeper check for $DMG"
    spctl -a -vv -t open --context context:primary-signature "$DMG" || true
  done
fi

echo "==> Done. Publish: upload dist/*.dmg, dist/*.zip, dist/*.blockmap, dist/latest-mac.yml"
echo "    to the GitHub release (tag v${VERSION}) of moshioshimayo/quietpls."
