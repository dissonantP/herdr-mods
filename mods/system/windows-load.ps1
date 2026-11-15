# Samples Windows-wide CPU, memory and GPU load every 2 s and writes them as JSON to $Out,
# for the Herdr `system` mod running in WSL. Exits when $Heartbeat (touched by the mod on
# every read) is older than 30 s, so it stops once Herdr closes.
param([string]$Out, [string]$Heartbeat)
$ErrorActionPreference = "SilentlyContinue"
# One sampler at a time: a second copy (Herdr restarted, two windows) exits at once.
$mutex = New-Object System.Threading.Mutex($false, "herdr-system-load")
if (-not $mutex.WaitOne(0)) { exit }
$totalMB = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1MB)
$counters = @(
  '\Processor(_Total)\% Processor Time',
  '\Processor(_Total)\% User Time',
  '\Processor(_Total)\% Privileged Time',
  '\Memory\Available MBytes'
)
# The GPU counter has one value per engine of every program, so it costs the most to read:
# read it every 5th sample (about every 10 s) and repeat the last value in between.
$gpu = $null; $n = 0
while ($true) {
  $hb = Get-Item -LiteralPath $Heartbeat
  if (-not $hb -or ((Get-Date) - $hb.LastWriteTime).TotalSeconds -gt 30) { exit }
  $s = (Get-Counter -Counter $counters -SampleInterval 2 -MaxSamples 1).CounterSamples
  $v = { param($p) ($s | Where-Object { $_.Path -like "*$p" } | Select-Object -First 1).CookedValue }
  # Task Manager's GPU %: the busiest engine type (3D, copy, video...) summed over its engines.
  if ($n++ % 5 -eq 0) { $gpu = ((Get-Counter '\GPU Engine(*)\Utilization Percentage').CounterSamples |
    Group-Object { if ($_.InstanceName -match 'engtype_(\w+)') { $Matches[1] } else { '' } } |
    ForEach-Object { ($_.Group | Measure-Object CookedValue -Sum).Sum } | Measure-Object -Maximum).Maximum }
  $avail = & $v '\memory\available mbytes'
  $json = @{
    at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    cpu = & $v '\processor(_total)\% processor time'
    user = & $v '\processor(_total)\% user time'
    system = & $v '\processor(_total)\% privileged time'
    totalMB = $totalMB
    usedMB = $totalMB - $avail
    gpu = if ($null -ne $gpu) { [math]::Min(100, $gpu) } else { $null }
  } | ConvertTo-Json -Compress
  $tmp = "$Out.tmp"
  Set-Content -LiteralPath $tmp -Value $json -NoNewline
  Move-Item -LiteralPath $tmp -Destination $Out -Force
}
