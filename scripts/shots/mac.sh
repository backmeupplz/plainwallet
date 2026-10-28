#!/bin/bash
# scripts/shots/mac.sh <raw dir> [UI language ...]   (from the repo root, then compose.py with SHOTS_TARGETS=mac)
# The Mac's screens for the Mac App Store, per language from fresh storage: the wallet page, as the Mac app's window
# and Safari's extension show it, in mac/Render.swift (WebKit, the engine of both, in a window off screen) driven by
# mac/shots.js. PNGs go to <raw>/mac/<language>/: 5 the password, 1 the wallet and 4 sending in the app's window
# (880x1440, its 440x720 points at 2x); 3 Safari's toolbar popup and 2 a site's permit approval in the extension's
# approval window. The sites behind them, at Safari's 1120x700, are 3-site.png (veydrift.com, the same for every
# language, without its dated token-sale strip as on the phones) and 2-site.png (MetaMask's test dapp, connected to
# that language's new wallet). compose.py draws the windows around them.
set -uo pipefail
raw=$1
shift
langs=("$@")
[ ${#langs[@]} -gt 0 ] || langs=(en en-GB de fr es es-419 pt-BR pt-PT it nl ru uk pl tr sv ar ja ko zh-Hans zh-Hant hi id vi th)
build=build-shots/mac
mkdir -p "$build" "$raw/mac"
npm run build:android >/dev/null && swiftc -O scripts/shots/mac/Render.swift -o "$build/Render" || exit 1
port=$((9400 + $$ % 100))
python3 -m http.server "$port" --bind 127.0.0.1 -d .output/android-mv3 >/dev/null 2>&1 &
server=$!
trap 'kill $server' EXIT
sleep 1
SITE_CSS='.auction-banner { display: none !important } :root { --auction-banner-h: 0px !important }'

# site <language> <url> <name> <accounts JSON> <out dir>
site() {
  { python3 -c 'import json, sys; print("const SHOTS = " + json.dumps({"name": sys.argv[1], "width": 1120, "height": 700, "accounts": json.loads(sys.argv[2]), "css": sys.argv[3]}))' "$3" "$4" "$SITE_CSS"
    cat scripts/shots/mac/site.js; echo ';'; cat .output/android-mv3/android-inpage.js; } > "$build/site.js"  # without the ; the provider's (function(){…})() would call what the site script's returns
  "$build/Render" "$2" "$build/site.js" "$5" -AppleLanguages "($1)" >> "$5/render.log" 2>&1
}

site en https://veydrift.com 3-site '[]' "$build" || { echo "veydrift.com: $(tail -1 "$build/render.log")"; exit 1; }
failed=()
for lang in "${langs[@]}"; do
  out="$raw/mac/$lang"
  rm -rf "$out"
  mkdir -p "$out"
  ok=
  for attempt in 1 2; do
    echo "const SHOTS = {\"lang\": \"$lang\"};" | cat - scripts/shots/mac/shots.js > "$build/shots.js"
    if "$build/Render" "http://127.0.0.1:$port/android.html?view=tab" "$build/shots.js" "$out" -AppleLanguages "($lang)" > "$out/render.log" 2>&1; then
      account=$(sed -n 's/^account \(0x[0-9a-fA-F]\{40\}\)$/\1/p' "$out/render.log")
      if [ -n "$account" ] && site "$lang" https://metamask.github.io/test-dapp/ 2-site "[\"$account\"]" "$out"; then
        cp "$build/3-site.png" "$out/"
        ok=1
        break
      fi
    fi
    echo "$lang: attempt $attempt failed: $(grep -v '^shot \|^account ' "$out/render.log" | tail -2 | cut -c1-300)"
  done
  [ -n "$ok" ] && echo "$lang ok" || { rm -f "$out"/*.png; failed+=("$lang"); }  # no half set
done
echo "failed: ${failed[*]:-none}"
[ -z "${failed[*]:-}" ]
