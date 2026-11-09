# ── Windows usage populator ───────────────────────────────────
# Fetches Claude plan limits from the OAuth usage endpoint (the same data
# `claude` shows under /usage) and writes the Omarchy-format cache that
# usage.ps1 reads. Run it on a schedule (see README "Usage on Windows").
#
# Safety: the OAuth token is only READ from ~/.claude/.credentials.json and
# sent to api.anthropic.com (its owner) — never written, logged or shared.
# Claude Code keeps that token refreshed; if it's expired or the machine is
# offline, this exits quietly and leaves the last cache in place.
#
# Codex: the desktop app exposes no local/API usage source on Windows, so it
# is intentionally not populated (the Codex row stays hidden).

$ErrorActionPreference = "Stop"

$CacheDir = Join-Path $env:LOCALAPPDATA 'herdr\agent-usage'
New-Item -ItemType Directory -Force -Path $CacheDir | Out-Null

function Update-ClaudeLimits {
  $cf = Join-Path $env:USERPROFILE '.claude\.credentials.json'
  if (-not (Test-Path $cf)) { return }
  $oauth = (Get-Content $cf -Raw -Encoding UTF8 | ConvertFrom-Json).claudeAiOauth
  if (-not $oauth.accessToken) { return }

  $headers = @{
    Authorization       = "Bearer $($oauth.accessToken)"
    'anthropic-version' = '2023-06-01'
    'anthropic-beta'    = 'oauth-2025-04-20'
    'User-Agent'        = 'herdr-glass-usage'
  }
  try {
    $u = Invoke-RestMethod -Method GET -Uri 'https://api.anthropic.com/api/oauth/usage' -Headers $headers -TimeoutSec 25
  } catch {
    return   # expired token / offline — keep the existing cache
  }
  if (-not $u.five_hour -and -not $u.seven_day) { return }

  # Plan label, e.g. default_claude_max_5x -> "Max 5x", else "Max"/"Pro".
  $label = 'Claude'
  if ([string]$oauth.rateLimitTier -match 'max_?(\d+)x') { $label = "Max $($matches[1])x" }
  elseif ($oauth.subscriptionType) { $label = (Get-Culture).TextInfo.ToTitleCase([string]$oauth.subscriptionType) }

  $limits = @()
  if ($null -ne $u.five_hour.utilization) {
    $limits += @{ label = '5h session'; percent = [double]$u.five_hour.utilization / 100; resetsAt = $u.five_hour.resets_at }
  }
  if ($null -ne $u.seven_day.utilization) {
    $limits += @{ label = '7 day'; percent = [double]$u.seven_day.utilization / 100; resetsAt = $u.seven_day.resets_at }
  }
  if (-not $limits.Count) { return }

  $obj = @{
    fetchedAtMs = [int64][datetimeoffset]::UtcNow.ToUnixTimeMilliseconds()
    tierLabel   = $label
    limits      = @($limits)
  }
  # Atomic replace so the reader never sees a half-written file.
  $tmp = Join-Path $CacheDir 'claude-limits.json.tmp'
  ($obj | ConvertTo-Json -Depth 6) | Set-Content -Path $tmp -Encoding UTF8
  Move-Item -Force -Path $tmp -Destination (Join-Path $CacheDir 'claude-limits-live.json')
}

Update-ClaudeLimits
