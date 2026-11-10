# ── Windows vitals reader ─────────────────────────────────────
# Emits one JSON reading matching the shape the vitals mod expects.
# Invoked by mods/vitals/main.js on the local Windows machine only.
param([string]$Op = "now")

$ErrorActionPreference = "SilentlyContinue"
$ProgressPreference = "SilentlyContinue"

function Num($v) {
  if ($null -eq $v) { return $null }
  $s = ([string]$v) -replace '[^0-9\.\-]', ''
  $d = 0.0
  if ([double]::TryParse($s, [ref]$d)) { return $d }
  return $null
}

try {
  if ($Op -eq "machines") {
    (@{ machines = @() } | ConvertTo-Json -Compress)
    return
  }

  $os = Get-CimInstance Win32_OperatingSystem
  $cpuHw = Get-CimInstance Win32_Processor | Select-Object -First 1
  $logical = (Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfLogicalProcessors -Sum).Sum
  if (-not $logical) { $logical = [int]$cpuHw.NumberOfLogicalProcessors }

  # ── CPU busy %, total and per-core ──────────────────────────
  $perf = Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor
  $total = 0.0
  $cores = @()
  $sorted = $perf | Sort-Object { if ($_.Name -eq '_Total') { 100000 } else { [int]$_.Name } }
  foreach ($p in $sorted) {
    if ($p.Name -eq '_Total') { $total = [double]$p.PercentProcessorTime }
    else { $cores += [double]$p.PercentProcessorTime }
  }

  # ── Memory ──────────────────────────────────────────────────
  $memTotal = [double]$os.TotalVisibleMemorySize * 1024
  $memFree = [double]$os.FreePhysicalMemory * 1024
  $memUsed = $memTotal - $memFree
  $memPct = 0.0
  if ($memTotal -gt 0) { $memPct = $memUsed / $memTotal * 100 }

  # ── Swap / page file ────────────────────────────────────────
  $swapTotal = 0.0; $swapUsed = 0.0
  foreach ($pf in (Get-CimInstance Win32_PageFileUsage)) {
    $swapTotal += [double]$pf.AllocatedBaseSize * 1MB
    $swapUsed += [double]$pf.CurrentUsage * 1MB
  }
  $swapPct = 0.0
  if ($swapTotal -gt 0) { $swapPct = $swapUsed / $swapTotal * 100 }

  # ── Disks ───────────────────────────────────────────────────
  $disks = @()
  foreach ($d in (Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3")) {
    if (-not $d.Size) { continue }
    $used = [double]$d.Size - [double]$d.FreeSpace
    $disks += @{ mount = $d.DeviceID; size = [double]$d.Size; used = $used; pct = $used / [double]$d.Size * 100 }
  }
  $disks = @($disks)

  # ── Network rate (bytes/sec) ────────────────────────────────
  $netRx = 0.0; $netTx = 0.0
  foreach ($n in (Get-CimInstance Win32_PerfFormattedData_Tcpip_NetworkInterface)) {
    $netRx += [double]$n.BytesReceivedPersec
    $netTx += [double]$n.BytesSentPersec
  }

  # ── GPUs via nvidia-smi ─────────────────────────────────────
  $gpuView = @()
  try {
    $q = "index,name,utilization.gpu,memory.used,memory.total,power.draw,power.limit,temperature.gpu,fan.speed,clocks.sm,clocks.max.sm"
    $lines = & nvidia-smi "--query-gpu=$q" "--format=csv,noheader,nounits" 2>$null
    foreach ($line in $lines) {
      if (-not ("$line").Trim()) { continue }
      $f = "$line" -split '\s*,\s*'
      if ($f.Count -lt 11) { continue }
      $util = Num $f[2]
      $vu = Num $f[3]; $vt = Num $f[4]
      $pw = Num $f[5]; $pl = Num $f[6]
      $tp = Num $f[7]; $fan = Num $f[8]
      $clk = Num $f[9]; $clkMax = Num $f[10]

      $vramPct = 0.0; if ($vt) { $vramPct = $vu / $vt * 100 }
      $pwrPct = 0.0; if ($pl) { $pwrPct = $pw / $pl * 100 }
      $clkPct = 0.0; if ($clkMax) { $clkPct = $clk / $clkMax * 100 }
      $tempPct = 0.0; if ($null -ne $tp) { $tempPct = [math]::Min(100, $tp) }

      $bands = @()
      $bands += @{ label = "GPU"; pct = $util }
      $bands += @{ label = "VRAM"; pct = $vramPct }
      $bands += @{ label = "PWR"; pct = $pwrPct }
      $bands += @{ label = "TEMP"; pct = $tempPct }
      if ($null -ne $fan) { $bands += @{ label = "FAN"; pct = $fan } }
      $bands += @{ label = "CLK"; pct = $clkPct }

      $vramTotal = $null; if ($vt) { $vramTotal = $vt * 1MB }
      $vramUsed = $null; if ($vu) { $vramUsed = $vu * 1MB }

      $gpuView += @{
        id = "gpu" + ("$($f[0])").Trim()
        name = ("$($f[1])").Trim()
        bands = @($bands)
        util = $util
        vramTotal = $vramTotal
        vramUsed = $vramUsed
        power = $pw
        powerLimit = $pl
        temp = $tp
        clock = $clk
      }
    }
  } catch {}
  $gpuView = @($gpuView)

  # ── Uptime ──────────────────────────────────────────────────
  $up = (Get-Date) - $os.LastBootUpTime
  $ud = [int]$up.Days; $uh = [int]$up.Hours; $um = [int]$up.Minutes
  if ($ud -gt 0) { $uptime = "${ud}d${uh}h" }
  elseif ($uh -gt 0) { $uptime = "${uh}h" + ("{0:D2}" -f $um) }
  else { $uptime = "${um}m" }

  # ── Level badge ─────────────────────────────────────────────
  $peak = [math]::Max($total, $memPct)
  foreach ($dk in $disks) { $peak = [math]::Max($peak, $dk.pct) }
  if ($peak -ge 92) { $level = "crit"; $why = "load" }
  elseif ($peak -ge 80) { $level = "busy"; $why = "" }
  else { $level = "ok"; $why = "" }

  $loadPerCore = $total / 100.0
  $release = ($os.Caption -replace '^Microsoft ', '').Trim()

  $reading = @{
    host = $env:COMPUTERNAME
    os = "windows"
    release = $release
    cores = [int]$logical
    uptime = $uptime
    level = $level
    why = $why
    warming = $false
    cpu = $total
    perCore = @($cores)
    cpuInfo = @{ clock = [double]$cpuHw.CurrentClockSpeed; clockMax = [double]$cpuHw.MaxClockSpeed }
    mem = $memPct
    memUsed = $memUsed
    memTotal = $memTotal
    swap = $swapPct
    swapTotal = $swapTotal
    load = @([math]::Round($loadPerCore * $logical, 2))
    loadPerCore = $loadPerCore
    disks = $disks
    netRx = $netRx
    netTx = $netTx
    gpuView = $gpuView
    history = @()
  }
  $reading | ConvertTo-Json -Compress -Depth 8
} catch {
  (@{ error = ("vitals reader: " + $_.Exception.Message) } | ConvertTo-Json -Compress)
}
