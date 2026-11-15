#!/usr/bin/env bash
#
# Watchdog for com.sinter.self-improve — reloads the daemon if launchd has
# silently unloaded it OR its log has gone stale (no progress within STALL_SECS).
# Catches the two failure modes launchd KeepAlive CANNOT:
#   - silent unload under macOS resource pressure (what killed the daemon 2026-07-05,
#     with the machine up 13 days — no reboot, no crash, just gone from the domain)
#   - a hung inner loop (bash process still alive, no node progress, KeepAlive won't fire)
#
# Fail-safe by design: NEVER exits non-zero (launchd would throttle the interval).
# Reload is idempotent — it just re-runs install-self-improve-daemon.sh (bootout +
# bootstrap + enable), same as a manual restart.
#
# Managed by ~/Library/LaunchAgents/com.sinter.self-improve-watchdog.plist
# (install/refresh: scripts/quality/install-self-improve-watchdog.sh).
set -u

LABEL="com.sinter.self-improve"
REPO="${SINTER_REPO:-$HOME/workspaces/liminal}"
DAEMON_LOG="$REPO/.quality/self-improve-daemon.log"
WATCH_LOG="$REPO/.quality/self-improve-watchdog.log"
STALL_SECS="${STALL_SECS:-3600}"   # 3x the 1200s cadence — no log progress in 1h = stalled
DOMAIN="gui/$(id -u)"

ts() { date -u +%FT%TZ; }
wlog() { printf '[watchdog %s] %s\n' "$(ts)" "$*" >> "$WATCH_LOG"; }
# Trim the watchdog log so it can't grow unbounded.
[ -f "$WATCH_LOG" ] && { tail -n 2000 "$WATCH_LOG" > "$WATCH_LOG.tmp" 2>/dev/null && mv "$WATCH_LOG.tmp" "$WATCH_LOG"; } || true

# Health 1: is the service loaded in the user domain?
if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  loaded=1
else
  loaded=0
fi

# Health 2: is the daemon log fresh? A healthy daemon writes at least once per
# cycle (garden tend -> ... -> sleep 1200s), so mtime age should stay well under
# STALL_SECS. A stale mtime means the process died without launchd noticing.
progress="ok"
if [ -f "$DAEMON_LOG" ]; then
  now=$(date +%s)
  mtime=$(stat -f %m "$DAEMON_LOG" 2>/dev/null || stat -c %Y "$DAEMON_LOG" 2>/dev/null || echo 0)
  age=$(( now - mtime ))
  [ "$age" -gt "$STALL_SECS" ] && progress="stale-${age}s"
else
  progress="no-log"
fi

# Healthy -> nothing to do.
if [ "$loaded" -eq 1 ] && [ "$progress" = "ok" ]; then
  exit 0
fi

# Unhealthy -> reload via the installer (idempotent). Logged, never fatal.
wlog "reload: loaded=$loaded progress=$progress — running install-self-improve-daemon.sh"
if bash "$REPO/scripts/quality/install-self-improve-daemon.sh" >> "$WATCH_LOG" 2>&1; then
  wlog "reload ok"
else
  wlog "reload FAILED rc=$? (will retry next interval)"
fi
exit 0
