#!/usr/bin/env bash
#
# Install/refresh the self-improve WATCHDOG as a macOS LaunchAgent. Idempotent.
# The watchdog reloads com.sinter.self-improve if launchd unloaded it or its log
# stalled — see self-improve-watchdog.sh. Runs every 10 minutes.
#
# Usage:  bash scripts/quality/install-self-improve-watchdog.sh
# Remove: bash scripts/quality/install-self-improve-watchdog.sh --uninstall
set -euo pipefail

LABEL="com.sinter.self-improve-watchdog"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
RUNNER="$REPO/scripts/quality/self-improve-watchdog.sh"
DOMAIN="gui/$(id -u)"

unload() {
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
}

if [[ "${1:-}" == "--uninstall" ]]; then
  unload
  rm -f "$PLIST"
  echo "uninstalled $LABEL"
  exit 0
fi

chmod +x "$RUNNER"
mkdir -p "$HOME/Library/LaunchAgents" "$REPO/.quality"

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${RUNNER}</string>
  </array>
  <!-- Every 10 min: cheap liveness probe, reload only on unload/stall. -->
  <key>StartInterval</key><integer>600</integer>
  <key>RunAtLoad</key><false/>
  <key>KeepAlive</key><false/>
  <key>Nice</key><integer>10</integer>
  <key>LowPriorityIO</key><true/>
  <key>WorkingDirectory</key><string>${REPO}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>${HOME}</string>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin</string>
    <key>STALL_SECS</key><string>3600</string>
  </dict>
  <key>StandardOutPath</key><string>${REPO}/.quality/self-improve-watchdog.launchd.log</string>
  <key>StandardErrorPath</key><string>${REPO}/.quality/self-improve-watchdog.launchd.log</string>
</dict>
</plist>
PLIST_EOF

# bootstrap registers for THIS session; enable persists across logout/reboot
# (same persistence fix as the daemon installer — bootstrap alone is session-scoped).
unload
launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null || launchctl load -w "$PLIST"
launchctl enable "$DOMAIN/$LABEL" 2>/dev/null || true

echo "installed + loaded $LABEL (10-min interval)"
launchctl print "$DOMAIN/$LABEL" 2>/dev/null | grep -iE "state =|program =" | head -3 || true
