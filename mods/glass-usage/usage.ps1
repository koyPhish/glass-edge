# ── Windows agent-limits reader ───────────────────────────────
# Windows port of usage.py. Reads Omarchy-format limit caches from a
# Windows location and prints {claude, codex} in the shape main.js expects.
# Populate one or both of these (newest file wins) in Omarchy's format:
#   %LOCALAPPDATA%\herdr\agent-usage\claude-limits-*.json
#   %LOCALAPPDATA%\herdr\agent-usage\codex-limits-*.json
# See usage-cache.example.json for the file format.

$ErrorActionPreference = "SilentlyContinue"
$ProgressPreference = "SilentlyContinue"

$DIRS = @(
  (Join-Path $env:LOCALAPPDATA 'herdr\agent-usage'),
  (Join-Path $env:USERPROFILE '.herdr\agent-usage'),
  (Join-Path $env:USERPROFILE '.cache\omarchy\agent-usage')
)

function Newest($pattern) {
  foreach ($d in $DIRS) {
    if (-not (Test-Path $d)) { continue }
    $f = Get-ChildItem (Join-Path $d $pattern) -File -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
    if ($f) { return $f }
  }
  return $null
}

function Epoch($stamp) {
  if (-not $stamp) { return $null }
  try { return [int][datetimeoffset]::Parse([string]$stamp).ToUnixTimeSeconds() } catch { return $null }
}

# First non-titled limit whose label matches; percent (0..1) -> used (0..100).
function Window($limits, $pattern) {
  foreach ($e in $limits) {
    if ($e.title) { continue }
    if (([string]$e.label) -notmatch $pattern) { continue }
    $p = 0.0
    if (-not [double]::TryParse([string]$e.percent, [ref]$p)) { continue }
    $used = [math]::Max(0.0, [math]::Min(100.0, $p * 100))
    return @{ used = $used; resets = (Epoch $e.resetsAt) }
  }
  return $null
}

function Reading($pattern) {
  $f = Newest $pattern
  if (-not $f) { return $null }
  try { $data = Get-Content $f.FullName -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return $null }
  $limits = @($data.limits)
  if ($data.fetchedAtMs) { $at = [int]([double]$data.fetchedAtMs / 1000) }
  else { $at = [int]([datetimeoffset]$f.LastWriteTimeUtc).ToUnixTimeSeconds() }
  return @{
    at = $at
    five = (Window $limits '5.?h|session')
    week = (Window $limits '7.?day|weekly')
    plan = $data.tierLabel
  }
}

$out = @{ claude = (Reading 'claude-limits-*.json'); codex = (Reading 'codex-limits-*.json') }
$out | ConvertTo-Json -Compress -Depth 8
