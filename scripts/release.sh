#!/bin/bash
# Build a quietpls release: dmg + zip for arm64 and x64.
#
# Everything is env-driven and skips cleanly when absent:
#   MAC_SIGNING_IDENTITY  - "Developer ID Application: ..." (falls back to CSC_NAME,
#                           then to ad-hoc signing when neither is set)
#   NOTARY_PROFILE        - notarize with this existing notarytool keychain profile
#   APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID
#                         - alternative: stored into a throwaway keychain profile
#                           (password over stdin, never on a command line) that is
#                           deleted on exit. Notarization is skipped when neither is set.
set -euo pipefail

NOTARY_ARGS=()
KC_DIR=""

# Remove the throwaway notary keychain, if any. Safe to call repeatedly.
cleanup_notary() {
  if [ -n "$KC_DIR" ]; then
    security delete-keychain "$KC_DIR/notary.keychain-db" 2>/dev/null || true
    rm -rf "$KC_DIR"
    KC_DIR=""
  fi
}

# Fill NOTARY_ARGS with notarytool --keychain-profile args and export the same
# profile for electron-builder's in-build notarization. Strips every competing
# credential variable so no child process sees the password.
setup_notary() {
  if [ -n "${NOTARY_PROFILE:-}" ]; then
    NOTARY_ARGS=(--keychain-profile "$NOTARY_PROFILE")
    unset APPLE_KEYCHAIN
  elif [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ]; then
    local saved=() line kc
    while IFS= read -r line; do
      line="${line#"${line%%[![:space:]]*}"}"; line="${line#\"}"; line="${line%\"}"
      [ -n "$line" ] && saved+=("$line")
    done < <(security list-keychains -d user)
    KC_DIR="$(mktemp -d)"
    chmod 700 "$KC_DIR"
    kc="$KC_DIR/notary.keychain-db"
    security create-keychain -p "$(openssl rand -hex 32)" "$kc"
    security list-keychains -d user -s ${saved[@]+"${saved[@]}"}  # keep it off the search list
    security set-keychain-settings "$kc"                            # no auto-lock
    printf '%s' "$APPLE_APP_SPECIFIC_PASSWORD" | xcrun notarytool store-credentials quietpls-release \
      --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --keychain "$kc" --validate
    NOTARY_ARGS=(--keychain-profile quietpls-release --keychain "$kc")
    export APPLE_KEYCHAIN="$kc"
  else
    return 0
  fi
  export APPLE_KEYCHAIN_PROFILE="${NOTARY_ARGS[1]}"
  unset APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_API_KEY APPLE_API_KEY_ID APPLE_API_ISSUER
}

# Sourced (tests, live credential check): define the functions only.
[ "${BASH_SOURCE[0]}" = "$0" ] || return 0

trap 'rc=$?; cleanup_notary; exit $rc' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

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
setup_notary
if [ ${#NOTARY_ARGS[@]} -gt 0 ]; then
  SIGN_ARGS+=(--config.mac.notarize=true)
else
  echo "==> Skipping notarization (set NOTARY_PROFILE, or APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID)"
fi

bash scripts/build-native.sh
npx electron-builder --mac ${SIGN_ARGS[@]+"${SIGN_ARGS[@]}"}

echo "==> Build complete. Artifacts:"
ls -la "$OUT"/*.dmg "$OUT"/*.zip "$OUT"/latest-mac.yml 2>/dev/null || true

# ---- Notarization (optional, env-driven) ----
if [ ${#NOTARY_ARGS[@]} -gt 0 ]; then
  for DMG in "$OUT"/*.dmg; do
    echo "==> Notarizing $DMG"
    SUBMIT_ID="$(xcrun notarytool submit "$DMG" "${NOTARY_ARGS[@]}" 2>&1 | tee /dev/stderr | awk '/^[[:space:]]*id:/ {print $2; exit}')" || true
    if [ -z "$SUBMIT_ID" ]; then
      echo "!! Could not parse submission id for $DMG — notarization may have failed" >&2
      exit 1
    fi
    xcrun notarytool wait "$SUBMIT_ID" "${NOTARY_ARGS[@]}"
    echo "==> Stapling $DMG"
    xcrun stapler staple "$DMG"
    xcrun stapler validate "$DMG"
    echo "==> Gatekeeper check for $DMG"
    spctl -a -vv -t open --context context:primary-signature "$DMG" || true
  done
fi

echo "==> Done. Publish: upload dist/*.dmg, dist/*.zip, dist/*.blockmap, dist/latest-mac.yml"
echo "    to the GitHub release (tag v${VERSION}) of moshioshimayo/quietpls."
