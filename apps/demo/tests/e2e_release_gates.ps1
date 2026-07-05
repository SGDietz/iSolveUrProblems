# HTTP-level release gates (Herm blocker #13) - run AFTER `npm run build`.
# HARD-FAILING (Herm ship-blocker 2026-07-02): every check is an assertion -
# any mismatch prints FAIL and the script exits 1, so this can gate a release
# instead of just printing statuses.
# Phase 1 simulates production (VERCEL_ENV=production): /dev/* must 404 and
# /api/intent/book must 501. Phase 2 runs preview mode: the pending-ZIP find
# must resume through the REAL orchestrator (live Outscraper - needs network
# and OUTSCRAPER_API_KEY; a dead network fails the gate on purpose).
# NOTE: ASCII ONLY in this file - PS 5.1 reads BOM-less .ps1 as ANSI and
# multi-byte chars (em-dash) break the parser.
$ErrorActionPreference = "Stop"
$app = "C:\Users\sgdie\Documents\Claude\projects\iSolveUrProblems-skin\apps\demo"
$port = 3006
$base = "http://localhost:$port"
$script:fails = 0

function Check($label, $actual, $expected) {
  if ("$actual" -eq "$expected") {
    Write-Output "PASS $label -> $actual"
  } else {
    Write-Output "FAIL $label -> got '$actual', want '$expected'"
    $script:fails++
  }
}

function WaitUp() {
  $deadline = (Get-Date).AddSeconds(40)
  while ((Get-Date) -lt $deadline) {
    try { Invoke-WebRequest -Uri "$base/en" -UseBasicParsing -TimeoutSec 5 | Out-Null; return $true } catch { Start-Sleep -Milliseconds 900 }
  }
  return $false
}
function StatusOf($url, $method = "GET", $body = $null) {
  try {
    if ($method -eq "GET") { $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 15 }
    else { $r = Invoke-WebRequest -Uri $url -Method $method -Body $body -ContentType "application/json" -Headers @{ Origin = "https://isolveurproblems.ai" } -UseBasicParsing -TimeoutSec 15 }
    return [int]$r.StatusCode
  } catch { if ($_.Exception.Response) { return [int]$_.Exception.Response.StatusCode } else { return -1 } }
}
function KillTree($proc) {
  # Kill the WHOLE tree (cmd wrapper + node child) or the old server keeps the
  # port and the next phase silently re-tests the previous instance. Best-effort
  # form - PS 5.1 turns native stderr into a terminating error under
  # -ErrorAction Stop.
  try { cmd /c "taskkill /PID $($proc.Id) /T /F >nul 2>&1" } catch { }
  Start-Sleep -Seconds 3
  try {
    $owners = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($procId in $owners) { try { Stop-Process -Id $procId -Force -Confirm:$false } catch { } }
  } catch { }
  Start-Sleep -Seconds 1
}

# -- Phase 1: production simulation --
$env:VERCEL_ENV = "production"
$p1 = Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "cd /d $app && npx next start -p $port" -PassThru -WindowStyle Hidden
if (-not (WaitUp)) { $p1 | Stop-Process -Force; Write-Output "FAIL prod-sim server failed to start"; exit 1 }
Check "prod /en/dev/cards" (StatusOf "$base/en/dev/cards") 404
Check "prod /en/dev/surface" (StatusOf "$base/en/dev/surface") 404
Check "prod /api/intent/book" (StatusOf "$base/api/intent/book" "POST" '{"winner_id":"11111111-2222-4333-8444-555555555555","winner_name":"x"}') 501
Check "prod /api/webhooks/esign/mock" (StatusOf "$base/api/webhooks/esign/mock" "POST" '{"envelope_id":"mock-x","status":"signed"}') 404
KillTree $p1

# -- Phase 2: preview mode --
# EXPLICIT preview (not just unset): apps/demo/.env.local carries a stale
# VERCEL_ENV="production" from an old `vercel env pull`, and next start loads
# it - process env overrides the file, so set it deliberately. (On real
# Vercel, the platform sets VERCEL_ENV per deployment.)
$env:VERCEL_ENV = "preview"
$p2 = Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "cd /d $app && npx next start -p $port" -PassThru -WindowStyle Hidden
if (-not (WaitUp)) { $p2 | Stop-Process -Force; Write-Output "FAIL preview server failed to start"; exit 1 }
Check "preview /en/dev/cards" (StatusOf "$base/en/dev/cards") 200
Check "preview /api/intent/book" (StatusOf "$base/api/intent/book" "POST" '{"winner_id":"11111111-2222-4333-8444-555555555555","winner_name":"x"}') 501
$sid = "claude-gate-" + [guid]::NewGuid().ToString().Substring(0,8)
$body = ConvertTo-Json -InputObject @{ session_id = $sid; speaker = "user"; text = "21093"; surface_snapshot = @{ kind = $null; contractorIds = @(); pendingFind = @{ category = "plumber" } }; tz = "America/New_York" } -Depth 6 -Compress
try {
  $r = Invoke-WebRequest -Uri "$base/api/transcripts/append" -Method POST -Body $body -ContentType "application/json" -Headers @{ Origin = "https://isolveurproblems.ai" } -UseBasicParsing -TimeoutSec 60
  $j = $r.Content | ConvertFrom-Json
  Check "pending-ZIP intent" $j.orchestrator.classification.kind "find_contractor"
  Check "pending-ZIP rule" $j.orchestrator.classification.matched_rule "find.location_answer"
  $hits = @($j.orchestrator.variant.hits).Count
  if ($hits -gt 0) { Write-Output "PASS pending-ZIP hits -> $hits" }
  else { Write-Output "FAIL pending-ZIP hits -> $hits (want more than 0; live Outscraper - check network/key)"; $script:fails++ }
} catch {
  Write-Output "FAIL pending-ZIP find -> $($_.Exception.Message)"
  $script:fails++
}
KillTree $p2

if ($script:fails -gt 0) { Write-Output "RELEASE GATES: $script:fails FAILED"; exit 1 }
Write-Output "RELEASE GATES: ALL PASS"
exit 0
