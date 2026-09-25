#!/bin/sh
# run-typecheck.sh — a REAL `tsc --noEmit` over the extension entry point,
# self-contained: it finds the compiler and the pi typings on its own and
# refuses to report a result it cannot stand behind.
#
#   sh typecheck/run-typecheck.sh
#
# Prerequisites, in this order of preference:
#   typescript : $TSC, then `tsc` on PATH, then a node_modules/typescript
#                walking up from this repo's root
#   pi typings : $PI_TYPES_DIR (a node_modules holding
#                @earendil-works/pi-coding-agent), else the same upward walk
#
# Optional pin: PI_EXPECT='^0\.87\.' — refuse to check against a different
# pi version than this one (the banner always names the exact version the
# check ran against; 0.87.0 typings do not prove anything about 0.87.1).
#
# Exit status: 0 = tsc said clean, 1 = tsc reported errors, 2 = NOT RUN
# (prerequisite missing). A missing prerequisite is never reported as a
# pass. CONTROL=1 seeds a deliberate type error first and proves the
# checker can fail before the clean run is trusted.
set -e
SELF=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$SELF/.." && pwd)
ENTRY="$ROOT/extensions/self-aware-memory/index.ts"
[ -f "$ENTRY" ] || { echo "NOT RUN: entry not found: $ENTRY"; exit 2; }

# ── find the compiler ───────────────────────────────────────────────────
TSC_BIN=""
for c in "$TSC" "$(command -v tsc 2>/dev/null || true)"; do
	if [ -n "$c" ] && [ -f "$c" ]; then TSC_BIN="$c"; break; fi
done
if [ -z "$TSC_BIN" ]; then
	d="$ROOT"
	while [ -n "$d" ] && [ "$d" != "/" ]; do
		if [ -f "$d/node_modules/typescript/bin/tsc" ]; then TSC_BIN="$d/node_modules/typescript/bin/tsc"; break; fi
		d=$(dirname "$d")
	done
fi
if [ -z "$TSC_BIN" ]; then
	echo "NOT RUN: no typescript compiler reachable (\$TSC, PATH, node_modules walk from $ROOT)."
	exit 2
fi
TSC_VER=$("$TSC_BIN" --version 2>/dev/null || echo "typescript version unknown")
TS_MAJ=$(printf '%s' "$TSC_VER" | sed -n 's/[^0-9]*\([0-9][0-9]*\)\.\([0-9][0-9]*\).*/\1/p')
TS_MIN=$(printf '%s' "$TSC_VER" | sed -n 's/[^0-9]*\([0-9][0-9]*\)\.\([0-9][0-9]*\).*/\2/p')
if [ -z "$TS_MAJ" ] || [ -z "$TS_MIN" ]; then
	echo "NOT RUN: cannot parse a typescript version from '$TSC_VER' — refusing to report a result."; exit 2
fi
# erasableSyntaxOnly needs TS >= 5.8; older compilers also misread modern
# @types/node and the noise reads as "the extension is broken".
if [ "$TS_MAJ" -lt 5 ] || { [ "$TS_MAJ" -eq 5 ] && [ "$TS_MIN" -lt 8 ]; }; then
	echo "NOT RUN: typescript $TS_MAJ.$TS_MIN is below the 5.8 floor."
	exit 2
fi

# ── find the pi typings ──────────────────────────────────────────────────
NC_DIR="${PI_TYPES_DIR:-}"
if [ -z "$NC_DIR" ]; then
	d="$ROOT"
	while [ -n "$d" ] && [ "$d" != "/" ]; do
		if [ -f "$d/node_modules/@earendil-works/pi-coding-agent/package.json" ]; then NC_DIR="$d/node_modules"; break; fi
		d=$(dirname "$d")
	done
fi
PI_PKG="$NC_DIR/@earendil-works/pi-coding-agent"
if [ ! -f "$PI_PKG/package.json" ]; then
	echo "NOT RUN: no @earendil-works/pi-coding-agent typings found."
	echo "       Set PI_TYPES_DIR=<...>/node_modules holding that package."
	exit 2
fi
PI_VER=$(node -e 'console.log(require(process.argv[1]).version)' "$PI_PKG/package.json")
if [ -n "${PI_EXPECT:-}" ] && ! printf '%s' "$PI_VER" | grep -Eq "$PI_EXPECT"; then
	echo "NOT RUN: pi typings are $PI_VER but PI_EXPECT=$PI_EXPECT — wrong capture for this run."
	exit 2
fi

# ── scratch: the package, next to a node_modules that IS the pi tree ─────
RUN="${SAM_TYPECHECK_DIR:-${TMPDIR:-/tmp}/sam-typecheck}"
rm -rf "$RUN"; mkdir -p "$RUN"
# package.json carries "type": "module" — without it Node16 resolution reads
# the .ts files as CommonJS and reports TS1479/TS1541 on every pi import.
cp "$ROOT/package.json" "$RUN/package.json"
cp -R "$ROOT/extensions" "$RUN/extensions"
cp -R "$ROOT/src" "$RUN/src"
ln -s "$NC_DIR" "$RUN/node_modules"

TYPES_DIR="$PI_PKG/node_modules/@types"
[ -d "$TYPES_DIR" ] || TYPES_DIR="$NC_DIR/@types"

cat > "$RUN/tsconfig.json" <<JSON
{
  "extends": "$SELF/tsconfig.base.json",
  "compilerOptions": {
    "typeRoots": ["$TYPES_DIR"],
    "types": ["node"]
  },
  "files": ["extensions/self-aware-memory/index.ts"]
}
JSON

echo "── pi-self-aware-memory typecheck ─────────────────────────────────────"
echo "entry     : $ENTRY"
echo "hash      : $(sha256sum "$ENTRY" | cut -d' ' -f1)"
echo "compiler  : $TSC_BIN ($TSC_VER)  [floor 5.8: OK]"
echo "pi typings: $PI_PKG  version $PI_VER   <-- the check is only as good as this line"
echo "config    : $SELF/tsconfig.base.json + generated $RUN/tsconfig.json (strict, noEmit)"
echo

# CONTROL=1: seed a deliberate error and prove the checker reports it before
# any clean run is trusted. No pipe: a pipe would report sed's status, not
# the compiler's — and a seeded error that does not fail is exactly the
# void-basis trap.
if [ "${CONTROL:-0}" = 1 ]; then
	printf 'export const seededTypeError: number = "not a number";\n' > "$RUN/__seed.ts"
	cat > "$RUN/tsconfig.seed.json" <<JSON
{ "extends": "$SELF/tsconfig.base.json",
  "compilerOptions": { "typeRoots": ["$TYPES_DIR"], "types": ["node"] },
  "files": ["__seed.ts"] }
JSON
	if "$TSC_BIN" -p "$RUN/tsconfig.seed.json" > "$RUN/seed.log" 2>&1; then
		echo "NOT RUN: the compiler reported CLEAN on a seeded type error — this checker cannot"
		echo "       detect errors, so a clean result on the extension would mean nothing."
		exit 2
	fi
	sed 's/^/  seed: /' "$RUN/seed.log"
	rm -f "$RUN/__seed.ts" "$RUN/tsconfig.seed.json"
	echo "control   : seeded type error was reported (above) — the checker is able to fail"
	echo
fi

if "$TSC_BIN" -p "$RUN/tsconfig.json"; then
	echo
	echo "TYPECHECK CLEAN against pi typings $PI_VER ($TSC_VER)"
	exit 0
fi
echo
echo "TYPECHECK REPORTED ERRORS (above) against pi typings $PI_VER — entry hash $(sha256sum "$RUN/extensions/self-aware-memory/index.ts" | cut -d' ' -f1)"
exit 1
