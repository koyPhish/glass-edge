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
# Codex: limits are read from the session logs in ~/.codex (see below).

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

# ── Codex ─────────────────────────────────────────────────────
# Codex records the account's rate limits in every session log
# (~/.codex/sessions/**/rollout-*.jsonl, "token_count" events carry
# rate_limits.primary = 5h window, .secondary = weekly). We only read the
# tail of the newest logs — no network, no token. The numbers are as fresh as
# your last Codex turn; a window whose reset time has passed shows 0 %.
function Read-Tail($path, $bytes = 1048576) {
  $fs = [IO.File]::Open($path, 'Open', 'Read', 'ReadWrite')
  try {
    $n = [math]::Min($bytes, $fs.Length)
    $fs.Seek(-$n, 'End') | Out-Null
    $buf = New-Object byte[] $n
    $fs.Read($buf, 0, $n) | Out-Null
    return [Text.Encoding]::UTF8.GetString($buf)
  } finally { $fs.Dispose() }
}

function Update-CodexLimits {
  $root = Join-Path $env:USERPROFILE '.codex'
  $files = foreach ($d in 'sessions', 'archived_sessions') {
    $p = Join-Path $root $d
    if (Test-Path $p) { Get-ChildItem $p -Recurse -Filter 'rollout-*.jsonl' -File -ErrorAction SilentlyContinue }
  }
  $files = @($files | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 8)

  foreach ($f in $files) {
    try { $lines = (Read-Tail $f.FullName) -split "`n" } catch { continue }
    for ($i = $lines.Count - 1; $i -ge 0; $i--) {
      if ($lines[$i] -notmatch '"rate_limits"\s*:\s*\{') { continue }
      try { $ev = $lines[$i] | ConvertFrom-Json } catch { continue }   # first line of the slice may be cut off
      $rl = $ev.payload.rate_limits
      if (-not $rl -or -not $rl.primary) { continue }

      $now = [datetimeoffset]::UtcNow
      $limits = @()
      foreach ($w in @(@($rl.primary, '5h session'), @($rl.secondary, '7 day'))) {
        $win = $w[0]
        if (-not $win -or $null -eq $win.used_percent) { continue }
        $reset = $null
        if ($win.resets_at) { $reset = [datetimeoffset]::FromUnixTimeSeconds([int64]$win.resets_at) }
        $pct = [double]$win.used_percent / 100
        if ($reset -and $reset -le $now) { $pct = 0.0; $reset = $null }   # window already rolled over
        $at = $null
        if ($reset) { $at = $reset.ToString('o') }
        $limits += @{ label = $w[1]; percent = $pct; resetsAt = $at }
      }
      if (-not $limits.Count) { continue }

      $label = 'Codex'
      if ($rl.plan_type) { $label = (Get-Culture).TextInfo.ToTitleCase([string]$rl.plan_type) }
      $obj = @{
        fetchedAtMs = [int64]([datetimeoffset]$f.LastWriteTimeUtc).ToUnixTimeMilliseconds()
        tierLabel   = $label
        limits      = @($limits)
      }
      $tmp = Join-Path $CacheDir 'codex-limits.json.tmp'
      ($obj | ConvertTo-Json -Depth 6) | Set-Content -Path $tmp -Encoding UTF8
      Move-Item -Force -Path $tmp -Destination (Join-Path $CacheDir 'codex-limits-live.json')
      return
    }
  }
}

# Live source (preferred): the same ChatGPT usage endpoint Codex itself calls for
# /status. The access token in ~/.codex/auth.json is only READ and sent to
# chatgpt.com (its owner) - never written, logged or shared. Codex keeps it
# refreshed; if it's expired or we're offline this returns $false and the
# session-log reader above is used instead.
function Update-CodexLimitsLive {
  $af = Join-Path $env:USERPROFILE '.codex\auth.json'
  if (-not (Test-Path $af)) { return $false }
  $t = (Get-Content $af -Raw -Encoding UTF8 | ConvertFrom-Json).tokens
  if (-not $t.access_token) { return $false }
  $h = @{ Authorization = "Bearer $($t.access_token)"; 'User-Agent' = 'herdr-glass-usage' }
  if ($t.account_id) { $h['ChatGPT-Account-Id'] = $t.account_id }
  try {
    $u = Invoke-RestMethod -Method GET -Uri 'https://chatgpt.com/backend-api/wham/usage' -Headers $h -TimeoutSec 25
  } catch { return $false }
  $rl = $u.rate_limit
  if (-not $rl -or -not $rl.primary_window) { return $false }

  $limits = @()
  foreach ($w in @(@($rl.primary_window, '5h session'), @($rl.secondary_window, '7 day'))) {
    $win = $w[0]
    if (-not $win -or $null -eq $win.used_percent) { continue }
    $at = $null
    if ($win.reset_at) { $at = [datetimeoffset]::FromUnixTimeSeconds([int64]$win.reset_at).ToString('o') }
    $limits += @{ label = $w[1]; percent = [double]$win.used_percent / 100; resetsAt = $at }
  }
  if (-not $limits.Count) { return $false }

  $label = 'Codex'
  if ($u.plan_type) { $label = (Get-Culture).TextInfo.ToTitleCase([string]$u.plan_type) }
  $obj = @{
    fetchedAtMs = [int64][datetimeoffset]::UtcNow.ToUnixTimeMilliseconds()
    tierLabel   = $label
    limits      = @($limits)
  }
  $tmp = Join-Path $CacheDir 'codex-limits.json.tmp'
  ($obj | ConvertTo-Json -Depth 6) | Set-Content -Path $tmp -Encoding UTF8
  Move-Item -Force -Path $tmp -Destination (Join-Path $CacheDir 'codex-limits-live.json')
  return $true
}

try { Update-ClaudeLimits } catch { }
try { if (-not (Update-CodexLimitsLive)) { Update-CodexLimits } } catch { try { Update-CodexLimits } catch { } }
