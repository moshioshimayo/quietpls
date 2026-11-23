#!/bin/bash
# Live audio gate: explicitly scoped to John's test VM, never the host Mac.
set -euo pipefail
cd "$(dirname "$0")/../.."
if [ "${QUIETPLS_NATIVE_TEST_SPACE:-}" != 'local:m16' ]; then
  echo 'UNVERIFIED: live audio gate must run inside local:m16 with QUIETPLS_NATIVE_TEST_SPACE=local:m16'
  exit 77
fi
python3 tests/native/source-tap.py
