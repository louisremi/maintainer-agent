#!/usr/bin/env bash
# Proves that the architecture rules fail: plants forbidden imports in a copy
# of the server sources and expects dependency-cruiser to reject each one.
set -uo pipefail
cd "$(dirname "$0")/../server" || exit 2
# The rules match paths starting with src/: swap a modified copy into place.
backup="$(mktemp -d "${TMPDIR:-/tmp}/ma-arch.XXXXXX")"
cp -r src "${backup}/src"
restore() { rm -rf src && cp -r "${backup}/src" src && rm -rf "${backup}"; }
trap restore EXIT
failures=0
expect_violation() {
  local name="$1" file="$2" line="$3"
  rm -rf src; cp -r "${backup}/src" src
  printf '%s\n' "${line}" >> "src/${file}"
  if npx --no-install depcruise src --config .dependency-cruiser.cjs >/dev/null 2>&1; then
    echo "FAIL rules accept: ${name}"; failures=$((failures + 1))
  fi
}
expect_violation "domain importing a framework" maintenance/domain/labels.ts "import '@nestjs/common';"
expect_violation "domain importing node built-ins" connections/domain/connection.ts "import 'node:fs';"
expect_violation "application importing an adapter" maintenance/application/ports.ts "import '../../adapters/system/system';"
expect_violation "a context importing another context" maintenance/domain/labels.ts "import '../../connections/domain';"
expect_violation "an adapter importing a forge adapter" adapters/http/html.ts "import '../forges/github';"
expect_violation "a forge adapter importing the HTTP adapter" adapters/forges/github/webhook-signature.ts "import '../../http/html';"
expect_violation "the settings domain importing a library" settings/domain/effective.ts "import 'yaml';"
expect_violation "the settings context importing maintenance" settings/application/use-cases.ts "import '../../maintenance/domain';"
expect_violation "maintenance importing the settings context" maintenance/application/ports.ts "import '../../settings/domain';"
expect_violation "an adapter importing the composition root" adapters/system/system.ts "import '../../bootstrap/container';"
(( failures == 0 ))
