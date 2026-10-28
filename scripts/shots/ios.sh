#!/bin/bash
# scripts/shots/ios.sh <simulator id> <raw dir> <ios|duo-outer> [UI language ...]   (from the repo root)
# The release build of the iOS app on a simulator, per language from a fresh install, through ios/Shots (the UI test
# that drives it): PNGs to <raw>/<target>/<language>/<n>.png for compose.py. ios is an iPhone 18 Pro Max on iOS 27.0
# (1320x2868, the 6.9" set); duo-outer an iPhone Duo on iOS 27.1, folded (1398x2034). The Duo can't be unfolded
# without Simulator.app, so there's no raw duo-inner set; compose.py skips it. SHOTS_ONLY=3 takes just shot 3; give it its own
# raw dir, since a failed language's PNGs are deleted. The app is built with SHOTS, which puts Shots.swift's style on sites.
set -uo pipefail
sim=$1 raw=$2 target=$3
shift 3
langs=("$@")
[ ${#langs[@]} -gt 0 ] || langs=(en en-GB de fr es es-419 pt-BR pt-PT it nl ru uk pl tr sv ar ja ko zh-Hans zh-Hant hi id vi th)
build=build-shots
app="$build/Build/Products/Release-iphonesimulator/Plain Wallet.app"
# a build without SHOTS would show the banner. Its JavaScript is the marker: Swift keeps "SHOTS_SITE_CSS" (under 16
# bytes) inline in the code, not as a string grep can find.
if [ ! -d "$app" ] || ! grep -qa "document.documentElement.appendChild(Object.assign" "$app/Plain Wallet"; then
  rm -rf "$app"
  npm run build:android >/dev/null && rm -rf ios/web && cp -R .output/android-mv3 ios/web &&
    xcodebuild -project ios/PlainWallet.xcodeproj -scheme PlainWallet -configuration Release -destination 'generic/platform=iOS Simulator' \
      -derivedDataPath "$build" CODE_SIGNING_ALLOWED=NO OTHER_SWIFT_FLAGS='$(inherited) -D SHOTS' build -quiet || exit 1
fi
xcrun simctl boot "$sim" 2>/dev/null
xcrun simctl bootstatus "$sim" -b >/dev/null
xcrun simctl spawn "$sim" defaults write -g AppleKeyboards -array 'en_US@sw=QWERTY;hw=Automatic'  # see Shots.swift
xcrun simctl status_bar "$sim" override --time 9:41 --batteryState charged --batteryLevel 100 --cellularMode active --cellularBars 4 --wifiBars 3 --dataNetwork wifi
failed=()
for lang in "${langs[@]}"; do
  out="$raw/$target/$lang"
  mkdir -p "$out"
  ok=
  for attempt in 1 2; do
    xcrun simctl uninstall "$sim" com.borodutch.plainwallet 2>/dev/null
    xcrun simctl install "$sim" "$app"
    if TEST_RUNNER_SHOTS_LANG=$lang TEST_RUNNER_SHOTS_DIR=$(cd "$out" && pwd) TEST_RUNNER_SHOTS_ONLY=${SHOTS_ONLY:-} xcodebuild test -project scripts/shots/ios/Shots.xcodeproj -scheme Shots \
        -destination "id=$sim" -derivedDataPath "$build/ui-$sim" -collect-test-diagnostics never > "$out/test.log" 2>&1; then
      # the app was in this language: the test tapped the button with its translation of "Generate seed phrase" (which
      # tells the two Chinese apart, though not en/en-GB, es/es-419 or pt-BR/pt-PT)
      button=$(python3 -c 'import json, os, sys; p = f"locales/{sys.argv[1]}.json"; print((json.load(open(p)) if os.path.exists(p) else {}).get("Generate seed phrase", "Generate seed phrase"))' "$lang")
      grep -qF "\"$button\" Button" "$out/test.log" && { ok=1; break; }
      echo "$lang: attempt $attempt failed: the app isn't in $lang (no \"$button\" button)"
      continue
    fi
    echo "$lang: attempt $attempt failed: $(grep -m1 'error:' "$out/test.log" | grep -v IDESchemeAction | cut -c1-200)"
  done
  [ -n "$ok" ] && echo "$lang ok" || { rm -f "$out"/*.png; failed+=("$lang"); }  # no half or wrong-language set
done
echo "failed: ${failed[*]:-none}"
[ -z "${failed[*]:-}" ]
