#!/bin/sh
# Multicode AI installer for macOS and Linux.
#
#   curl -fsSL https://multicode.in/install.sh | sh                  # this computer
#   curl -fsSL https://multicode.in/install.sh | sh -s -- mac-arm64  # Apple Silicon Mac
#   curl -fsSL https://multicode.in/install.sh | sh -s -- mac-x64    # Intel Mac
#   curl -fsSL https://multicode.in/install.sh | sh -s -- linux      # Linux (x64)
#
# It downloads the current release, checks it against the published SHA-256
# checksums (and refuses anything that does not match), installs it and opens
# it. A download made here rather than in a browser is not marked as coming
# from the internet, so macOS opens the app without a warning.
#
# Settings (optional): MULTICODE_SITE (default https://multicode.in),
# MULTICODE_DOWNLOAD_BASE (a release folder, instead of asking the site),
# MULTICODE_INSTALL_DIR (macOS; default /Applications), MULTICODE_NO_OPEN=1.
set -eu

SITE="${MULTICODE_SITE:-https://multicode.in}"
APP="Multicode AI"

say() { printf '%s\n' "$*"; }
fail() { printf 'Multicode AI install failed: %s\n' "$*" >&2; exit 1; }

# Only HTTPS (or this computer, for testing).
check_url() {
  case "$1" in
    https://*|http://127.0.0.1:*|http://localhost:*) ;;
    *) fail "refusing to download from $1" ;;
  esac
}

fetch() { # url [output]
  check_url "$1"
  if command -v curl >/dev/null 2>&1; then
    if [ -n "${2:-}" ]; then curl -fsSL --retry 2 -o "$2" "$1"; else curl -fsSL --retry 2 "$1"; fi
  elif command -v wget >/dev/null 2>&1; then
    if [ -n "${2:-}" ]; then wget -q -O "$2" "$1"; else wget -q -O - "$1"; fi
  else
    fail "curl or wget is needed"
  fi
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d ' ' -f 1
  else shasum -a 256 "$1" | cut -d ' ' -f 1; fi
}

target="${1:-}"
if [ -z "$target" ]; then
  case "$(uname -s)/$(uname -m)" in
    Darwin/arm64) target=mac-arm64 ;;
    Darwin/x86_64) target=mac-x64 ;;
    Linux/x86_64|Linux/amd64) target=linux ;;
    *) fail "this computer ($(uname -s) $(uname -m)) is not supported; see $SITE/#download" ;;
  esac
fi
case "$target" in
  mac-arm64)
    [ "$(uname -s)" = Darwin ] || fail "mac-arm64 is for Macs"
    [ "$(uname -m)" = arm64 ] || fail "this Mac has an Intel processor; use mac-x64" ;;
  mac-x64) [ "$(uname -s)" = Darwin ] || fail "mac-x64 is for Macs" ;;
  linux) [ "$(uname -s)" = Linux ] || fail "linux is for Linux" ;;
  *) fail "unknown target '$target' (use mac-arm64, mac-x64 or linux)" ;;
esac

tmp="$(mktemp -d 2>/dev/null || mktemp -d -t multicode)"
mounted=""
cleanup() {
  if [ -n "$mounted" ]; then hdiutil detach "$mounted" -quiet >/dev/null 2>&1 || true; fi
  rm -rf "$tmp"
}
# Clean up, and keep the real exit status: a failure must never look like success.
# shellcheck disable=SC2154 # status is set inside the handler itself
trap 'status=$?; cleanup; exit $status' EXIT
trap 'exit 130' INT TERM

base="${MULTICODE_DOWNLOAD_BASE:-}"
if [ -z "$base" ]; then
  base="$(fetch "$SITE/install/latest" | tr -d '\r\n')" || fail "could not reach $SITE"
fi
case "$base" in */) ;; *) base="$base/" ;; esac
check_url "$base"

say "Checking the latest Multicode AI release..."
fetch "${base}SHA256SUMS.txt" "$tmp/SHA256SUMS.txt" || fail "could not download the checksums"

# "<sha256>  <file>" for the newest file of this kind in the release.
pick() {
  grep -E "^[0-9a-f]{64}  Multicode-AI-[^ /]+$1\$" "$tmp/SHA256SUMS.txt" | tail -n 1
}

download() { # line -> sets $file
  hash="${1%% *}"
  name="${1##* }"
  file="$tmp/$name"
  say "Downloading ${name}..."
  fetch "$base$name" "$file" || fail "could not download $name"
  [ "$(sha256 "$file")" = "$hash" ] || fail "$name does not match its published checksum; nothing was installed"
  say "Checksum verified."
}

case "$target" in
  mac-*)
    arch="${target#mac-}"
    line="$(pick "-mac-$arch(-preview)?\\.dmg")"
    [ -n "$line" ] || fail "no macOS $arch build in this release"
    download "$line"
    dest="${MULTICODE_INSTALL_DIR:-/Applications}"
    if ! { [ -d "$dest" ] && [ -w "$dest" ]; }; then
      [ -n "${MULTICODE_INSTALL_DIR:-}" ] && fail "$dest is not writable"
      dest="$HOME/Applications"
      mkdir -p "$dest"
    fi
    mounted="$tmp/volume"
    mkdir -p "$mounted"
    hdiutil attach -nobrowse -readonly -noautoopen -quiet -mountpoint "$mounted" "$file" || { mounted=""; fail "could not open the disk image"; }
    [ -d "$mounted/$APP.app" ] || fail "the disk image does not contain $APP.app"
    if pgrep -x "$APP" >/dev/null 2>&1; then
      say "Closing the running Multicode AI..."
      osascript -e "quit app \"$APP\"" >/dev/null 2>&1 || true
      sleep 2
    fi
    rm -rf "$dest/$APP.app"
    ditto "$mounted/$APP.app" "$dest/$APP.app"
    hdiutil detach "$mounted" -quiet >/dev/null 2>&1 || true
    mounted=""
    # Belt and braces: nothing here comes from a browser, so there is no
    # quarantine flag to begin with.
    xattr -dr com.apple.quarantine "$dest/$APP.app" 2>/dev/null || true
    say "Installed $APP in $dest."
    if [ -z "${MULTICODE_NO_OPEN:-}" ]; then open "$dest/$APP.app"; fi
    ;;
  linux)
    case "$(uname -m)" in x86_64|amd64) ;; *) fail "only 64-bit Intel/AMD Linux (x86_64) is supported" ;; esac
    sudo=""
    [ "$(id -u)" = 0 ] || sudo="sudo"
    deb="$(pick "-linux-(amd64|x64)(-preview)?\\.deb")"
    if [ -n "$deb" ] && command -v apt-get >/dev/null 2>&1 && command -v dpkg >/dev/null 2>&1; then
      # The .deb also installs the AppArmor profile Ubuntu 24.04+ needs.
      download "$deb"
      say "Installing (you may be asked for your password)..."
      chmod 755 "$tmp" && chmod 644 "$file"
      $sudo apt-get install -y "$file" || fail "the package did not install"
      command -v multicode-ai >/dev/null 2>&1 && launcher="multicode-ai" || launcher="/opt/$APP/multicode-ai"
    else
      line="$(pick "-linux-x86_64(-preview)?\\.AppImage")"
      [ -n "$line" ] || fail "no Linux build in this release"
      download "$line"
      dir="$HOME/.local/share/multicode-ai"
      mkdir -p "$dir" "$HOME/.local/bin" "$HOME/.local/share/applications"
      mv "$file" "$dir/Multicode-AI.AppImage"
      chmod +x "$dir/Multicode-AI.AppImage"
      ln -sf "$dir/Multicode-AI.AppImage" "$HOME/.local/bin/multicode-ai"
      cat > "$HOME/.local/share/applications/multicode-ai.desktop" <<EOF
[Desktop Entry]
Name=$APP
Comment=Your team's AI coding workspace
Exec="$dir/Multicode-AI.AppImage" %U
Terminal=false
Type=Application
Categories=Development;
EOF
      launcher="$dir/Multicode-AI.AppImage"
    fi
    say "Installed $APP."
    if [ -z "${MULTICODE_NO_OPEN:-}" ] && { [ -n "${DISPLAY:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ]; }; then
      nohup "$launcher" >/dev/null 2>&1 &
    fi
    ;;
esac

say "Done. Sign in with your Multicode AI account; your computer connects by itself."
