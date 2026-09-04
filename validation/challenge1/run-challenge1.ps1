param(
  [int]$DurationSeconds = 180,
  [string]$HostUrl = "http://localhost:8080",
  [string[]]$Scenarios = @(
    "26c1_1",
    "26c1_2",
    "26c1_3",
    "26c1_4",
    "26c1_5",
    "26c1_6",
    "26c1_7",
    "26c1_8"
  ),
  [string]$OutputDirName = "generated"
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = (Resolve-Path (Join-Path $ScriptDir "..\..")).Path
$EnvFile = Join-Path $ProjectDir ".env"
if (Test-Path -LiteralPath $EnvFile) {
  foreach ($line in Get-Content -LiteralPath $EnvFile) {
    if ($line -match "^\s*([^#=]+?)\s*=\s*(.*)\s*$") {
      $key = $Matches[1].Trim(); $value = $Matches[2].Trim().Trim('"').Trim("'")
      if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($key, "Process"))) { [Environment]::SetEnvironmentVariable($key, $value, "Process") }
    }
  }
}
$ServerDir = $env:DELIVEROO_BACKEND_DIR
$GamesDir = $env:DELIVEROO_GAMES_DIR
$Scenarios = @($Scenarios | ForEach-Object { "$_".Split(',') } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
$ResultsDir = Join-Path $ScriptDir $OutputDirName
$RunsDir = Join-Path $ResultsDir "runs"
$PidFile = Join-Path $ScriptDir ".challenge1-processes.json"

function Initialize-Directories {
  if (Test-Path -LiteralPath $ResultsDir) {
    throw "Output directory already exists: $ResultsDir. Move or delete it before rerunning."
  }
  New-Item -ItemType Directory -Force -Path $RunsDir | Out-Null
  foreach ($scenario in $Scenarios) {
    New-Item -ItemType Directory -Force -Path (Join-Path $RunsDir $scenario) | Out-Null
  }
}

function Require-ExternalDirectory {
  param([string]$Path, [string]$VariableName, [string]$Purpose)
  if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path -PathType Container)) {
    throw "$VariableName must name the $Purpose directory before running this live validation harness."
  }
}

function Quote-Arg([string]$Arg) {
  if ($Arg -notmatch '[\s"]') { return $Arg }
  return '"' + ($Arg -replace '"', '\"') + '"'
}

function ConvertTo-ArgumentText([string[]]$Arguments) {
  return ($Arguments | ForEach-Object { Quote-Arg $_ }) -join " "
}

function Get-NodePids {
  return @(Get-Process -Name node -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
}

function Find-NewNodePids {
  param(
    [int[]]$BeforePids,
    [int]$TimeoutSeconds = 5
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $current = Get-NodePids
    $newPids = @($current | Where-Object { $BeforePids -notcontains $_ })
    if ($newPids.Count -gt 0) { return $newPids }
    Start-Sleep -Milliseconds 100
  }
  return @()
}

function Start-LoggedProcess {
  param(
    [string]$FilePath,
    [string[]]$Arguments,
    [string]$WorkingDirectory,
    [hashtable]$Environment,
    [string]$LogPath
  )

  $parent = Split-Path -Parent $LogPath
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  Set-Content -LiteralPath $LogPath -Value "" -Encoding UTF8
  $beforeNodePids = Get-NodePids

  $psi = [System.Diagnostics.ProcessStartInfo]::new()
  $psi.FileName = "cmd.exe"
  $psi.WorkingDirectory = $WorkingDirectory
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true

  $commandParts = @()
  foreach ($key in $Environment.Keys) {
    if ($null -eq $Environment[$key]) {
      $commandParts += "set $key="
    } else {
      $commandParts += "set $key=$($Environment[$key])"
    }
  }
  $argText = ConvertTo-ArgumentText $Arguments
  if ([string]::IsNullOrWhiteSpace($argText)) {
    $commandParts += $FilePath
  } else {
    $commandParts += "$FilePath $argText"
  }
  $commandLine = "$($commandParts -join '&& ') > `"$LogPath`" 2>&1"
  $psi.Arguments = "/d /s /c `"$commandLine`""

  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $psi
  [void]$process.Start()
  $newNodePids = Find-NewNodePids -BeforePids $beforeNodePids -TimeoutSeconds 5

  return [pscustomobject]@{
    Process = $process
    LogPath = $LogPath
    KillPids = @($newNodePids)
  }
}

function Merge-ErrorLog {
  param($Handle)

  if ($null -eq $Handle) { return }
  try { $Handle.Process.WaitForExit(1000) | Out-Null } catch {}
}

function Save-ActivePids {
  param($ServerHandle, $CassandraHandle)

  $items = @()
  if ($ServerHandle -and $ServerHandle.Process -and -not $ServerHandle.Process.HasExited) {
    $items += [pscustomobject]@{
      role = "server"
      pid = $ServerHandle.Process.Id
      kill_pids = @($ServerHandle.KillPids)
      path = $ServerHandle.LogPath
      timestamp = (Get-Date).ToUniversalTime().ToString("o")
    }
  }
  if ($CassandraHandle -and $CassandraHandle.Process -and -not $CassandraHandle.Process.HasExited) {
    $items += [pscustomobject]@{
      role = "cassandra"
      pid = $CassandraHandle.Process.Id
      kill_pids = @($CassandraHandle.KillPids)
      path = $CassandraHandle.LogPath
      timestamp = (Get-Date).ToUniversalTime().ToString("o")
    }
  }

  if ($items.Count -gt 0) {
    $items | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $PidFile -Encoding UTF8
  } elseif (Test-Path -LiteralPath $PidFile) {
    Remove-Item -LiteralPath $PidFile -Force
  }
}

function Wait-ProcessExit {
  param(
    [int]$ProcessId,
    [int]$TimeoutSeconds = 10
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $p = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if ($null -eq $p) { return $true }
    Start-Sleep -Milliseconds 250
  }
  return $false
}

function Stop-PidTree {
  param(
    [int]$ProcessId,
    [int]$TimeoutSeconds = 10
  )

  if ($ProcessId -le 0) { return $true }
  $p = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if ($null -eq $p) { return $true }

  try {
    Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
  } catch {}
  if (Wait-ProcessExit -ProcessId $ProcessId -TimeoutSeconds 2) { return $true }

  try {
    & taskkill.exe /PID $ProcessId /T /F | Out-Null
  } catch {}
  return (Wait-ProcessExit -ProcessId $ProcessId -TimeoutSeconds $TimeoutSeconds)
}

function Stop-LoggedProcess {
  param(
    $Handle,
    [int]$TimeoutSeconds = 10
  )

  if ($null -eq $Handle) { return $true }
  $processId = $Handle.Process.Id
  $stopped = $true
  foreach ($extraPid in @($Handle.KillPids)) {
    if ($extraPid -and ([int]$extraPid) -ne $processId) {
      $stopped = (Stop-PidTree -ProcessId ([int]$extraPid) -TimeoutSeconds $TimeoutSeconds) -and $stopped
    }
  }
  $stopped = (Stop-PidTree -ProcessId $processId -TimeoutSeconds $TimeoutSeconds) -and $stopped
  Merge-ErrorLog -Handle $Handle
  try { $Handle.Process.Dispose() } catch {}
  return $stopped
}

function Stop-StaleValidationProcesses {
  if (-not (Test-Path -LiteralPath $PidFile)) { return }

  $records = @(Get-Content -LiteralPath $PidFile -Raw | ConvertFrom-Json)
  foreach ($record in $records) {
    foreach ($extraPid in @($record.kill_pids)) {
      if ($extraPid) {
        [void](Stop-PidTree -ProcessId ([int]$extraPid) -TimeoutSeconds 10)
      }
    }
    if ($record.pid) {
      [void](Stop-PidTree -ProcessId ([int]$record.pid) -TimeoutSeconds 10)
    }
  }
  Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
}

function Get-PortOwnerPid {
  $lines = @(netstat.exe -ano -p tcp | Select-String -Pattern '^\s*TCP\s+\S+:8080\s+\S+\s+LISTENING\s+(\d+)\s*$')
  if ($lines.Count -eq 0) { return $null }
  return [int]$lines[0].Matches[0].Groups[1].Value
}

function Wait-PortFree {
  param([int]$TimeoutSeconds = 15)

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if ($null -eq (Get-PortOwnerPid)) { return $true }
    Start-Sleep -Milliseconds 250
  }
  return $false
}

function Read-LogText([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return "" }
  return (Get-Content -LiteralPath $Path -Raw -ErrorAction SilentlyContinue)
}

function Wait-ForLogPattern {
  param(
    [string]$LogPath,
    [string]$Pattern,
    [int]$TimeoutSeconds,
    $Process
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if ($Process -and $Process.HasExited) { return $false }
    $text = Read-LogText $LogPath
    if ($text -match $Pattern) { return $true }
    Start-Sleep -Milliseconds 250
  }
  return $false
}

function Invoke-AgentsEndpoint {
  return @(Invoke-RestMethod -Uri "$HostUrl/api/agents" -TimeoutSec 3)
}

function Wait-ForServerReady {
  param(
    $Handle,
    [string]$Scenario,
    [int]$TimeoutSeconds = 60
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $scenarioLoaded = $false
  while ((Get-Date) -lt $deadline) {
    if ($Handle.Process.HasExited) { return $false }
    $log = Read-LogText $Handle.LogPath
    if ($log -match [regex]::Escape("from game '$Scenario'") -or $log -match [regex]::Escape("title: '$Scenario'")) {
      $scenarioLoaded = $true
    }
    try {
      $agents = Invoke-AgentsEndpoint
      if ($null -ne $agents -and $scenarioLoaded) { return $true }
    } catch {}
    Start-Sleep -Milliseconds 500
  }
  return $false
}

function Wait-ForCassandraReady {
  param(
    $Handle,
    [int]$TimeoutSeconds = 60
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $startLog = $false
  while ((Get-Date) -lt $deadline) {
    if ($Handle.Process.HasExited) { return $false }
    $log = Read-LogText $Handle.LogPath
    if ($log -match '\[start\]\s+"Cassandra"') {
      $startLog = $true
    }
    try {
      $agents = Invoke-AgentsEndpoint
      $cassandra = $agents | Where-Object { $_.name -eq "Cassandra" } | Select-Object -First 1
      if ($startLog -and $cassandra) { return $true }
    } catch {}
    Start-Sleep -Milliseconds 500
  }
  return $false
}

function New-BaseResult {
  param([string]$Scenario)
  return [ordered]@{
    scenario = $Scenario
    duration_seconds = $DurationSeconds
    agent = "Cassandra"
    score = $null
    penalty = $null
    connected = $false
    pickup_observed = $false
    pickup_count = 0
    delivery_observed = $false
    delivery_count = 0
    crashed = $false
    fatal_error = $null
    timestamp = (Get-Date).ToUniversalTime().ToString("o")
    server_pid = $null
    cassandra_pid = $null
    scenario_verified = $false
  }
}

function Update-ResultFromLogs {
  param(
    [System.Collections.Specialized.OrderedDictionary]$Result,
    [string]$CassandraLog,
    [string]$ServerLog,
    [string]$Scenario
  )

  $cassandraText = Read-LogText $CassandraLog
  $serverText = Read-LogText $ServerLog
  $Result.connected = ($cassandraText -match 'Connected' -and $cassandraText -match '\[start\]\s+"Cassandra"')
  $Result.pickup_count = ([regex]::Matches($cassandraText, '\[pickup\]')).Count
  $Result.delivery_count = ([regex]::Matches($cassandraText, '\[deliver\]')).Count
  $Result.pickup_observed = $Result.pickup_count -gt 0
  $Result.delivery_observed = $Result.delivery_count -gt 0
  $Result.scenario_verified = ($serverText -match [regex]::Escape("from game '$Scenario'") -or $serverText -match [regex]::Escape("title: '$Scenario'"))
}

function Write-Result {
  param(
    [System.Collections.Specialized.OrderedDictionary]$Result,
    [string]$RunDir
  )

  $jsonPath = Join-Path $RunDir "result.json"
  $Result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $jsonPath -Encoding UTF8
}

function Query-CassandraSnapshot {
  $agents = Invoke-AgentsEndpoint
  return $agents | Where-Object { $_.name -eq "Cassandra" } | Select-Object -First 1
}

Stop-StaleValidationProcesses
Require-ExternalDirectory -Path $ServerDir -VariableName "DELIVEROO_BACKEND_DIR" -Purpose "official Deliveroo backend"
Require-ExternalDirectory -Path $GamesDir -VariableName "DELIVEROO_GAMES_DIR" -Purpose "official Deliveroo game assets"
if (-not (Wait-PortFree -TimeoutSeconds 15)) {
  $owner = Get-PortOwnerPid
  throw "Port 8080 is already in use before validation startup (PID $owner). It was not created by this harness, so it was not terminated."
}

Initialize-Directories
$allResults = @()

foreach ($scenario in $Scenarios) {
  $runDir = Join-Path $RunsDir $scenario
  $serverLog = Join-Path $runDir "server.log"
  $cassandraLog = Join-Path $runDir "cassandra.log"
  $result = New-BaseResult $scenario
  $serverHandle = $null
  $cassandraHandle = $null

  Write-Host "[$scenario] starting"

  try {
    Stop-StaleValidationProcesses
    if (-not (Wait-PortFree -TimeoutSeconds 15)) {
      $owner = Get-PortOwnerPid
      throw "Port 8080 is already in use before starting $scenario (PID $owner)"
    }
    if (-not (Test-Path -LiteralPath (Join-Path $GamesDir "$scenario.json"))) {
      throw "Official scenario file not found: $scenario.json"
    }
    if (-not (Test-Path -LiteralPath (Join-Path $ProjectDir "agents\cassandra.js"))) {
      throw "Cassandra entry point not found"
    }

    $serverHandle = Start-LoggedProcess `
      -FilePath "node.exe" `
      -Arguments @("index.js") `
      -WorkingDirectory $ServerDir `
      -Environment @{ GAME_NAME = $scenario; TOKEN = $null } `
      -LogPath $serverLog
    $result.server_pid = $serverHandle.Process.Id
    Save-ActivePids -ServerHandle $serverHandle -CassandraHandle $null

    $serverReady = Wait-ForServerReady -Handle $serverHandle -Scenario $scenario -TimeoutSeconds 60
    if (-not $serverReady) {
      throw "Server did not become ready for $scenario"
    }
    $serverOwnerPid = Get-PortOwnerPid
    if ($serverOwnerPid) {
      $serverHandle.KillPids = @(@($serverHandle.KillPids) + $serverOwnerPid | Select-Object -Unique)
      $result.server_pid = $serverOwnerPid
      Save-ActivePids -ServerHandle $serverHandle -CassandraHandle $null
    }
    $preExistingCassandra = Invoke-AgentsEndpoint | Where-Object { $_.name -eq "Cassandra" } | Select-Object -First 1
    if ($preExistingCassandra) {
      throw "Stale Cassandra was already registered before launching the scenario agent"
    }

    $cassandraHandle = Start-LoggedProcess `
      -FilePath "node.exe" `
      -Arguments @("agents/cassandra.js") `
      -WorkingDirectory $ProjectDir `
      -Environment @{ HOST = $HostUrl; TOKEN = $null } `
      -LogPath $cassandraLog
    $result.cassandra_pid = $cassandraHandle.Process.Id
    Save-ActivePids -ServerHandle $serverHandle -CassandraHandle $cassandraHandle

    $cassandraStarted = Wait-ForCassandraReady -Handle $cassandraHandle -TimeoutSeconds 60
    if (-not $cassandraStarted) {
      Update-ResultFromLogs -Result $result -CassandraLog $cassandraLog -ServerLog $serverLog -Scenario $scenario
      throw "Cassandra did not reach the connected runtime state for $scenario"
    }

    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    $cassandraExitObserved = $false
    $serverExitObserved = $false
    while ($stopwatch.Elapsed.TotalSeconds -lt $DurationSeconds) {
      if (-not $cassandraExitObserved -and $cassandraHandle.Process.HasExited) {
        $cassandraExitObserved = $true
        $result.crashed = $true
        $result.fatal_error = "Cassandra exited before the $DurationSeconds-second validation window ended"
      }
      if (-not $serverExitObserved -and $serverHandle.Process.HasExited) {
        $serverExitObserved = $true
        $result.crashed = $true
        $result.fatal_error = "Deliveroo server exited before the $DurationSeconds-second validation window ended"
        break
      }
      $remainingMs = [math]::Max(0, ($DurationSeconds * 1000) - $stopwatch.ElapsedMilliseconds)
      Start-Sleep -Milliseconds ([math]::Min(1000, $remainingMs))
    }

    try {
      $agent = Query-CassandraSnapshot
      if ($agent) {
        $result.score = [int]$agent.score
        $result.penalty = [int]$agent.penalty
      } elseif (-not $result.fatal_error) {
        $result.fatal_error = "Cassandra not present in /api/agents snapshot"
      }
    } catch {
      if (-not $result.fatal_error) {
        $result.fatal_error = "Could not query /api/agents: $($_.Exception.Message)"
      }
    }

    Update-ResultFromLogs -Result $result -CassandraLog $cassandraLog -ServerLog $serverLog -Scenario $scenario
  } catch {
    $result.crashed = $true
    $result.fatal_error = $_.Exception.Message
    if (Test-Path -LiteralPath $cassandraLog) {
      Update-ResultFromLogs -Result $result -CassandraLog $cassandraLog -ServerLog $serverLog -Scenario $scenario
    }
  } finally {
    $cassandraStopped = Stop-LoggedProcess -Handle $cassandraHandle -TimeoutSeconds 10
    Save-ActivePids -ServerHandle $serverHandle -CassandraHandle $null
    $serverStopped = Stop-LoggedProcess -Handle $serverHandle -TimeoutSeconds 10
    Save-ActivePids -ServerHandle $null -CassandraHandle $null

    if (-not $cassandraStopped) {
      $result.crashed = $true
      if (-not $result.fatal_error) {
        $result.fatal_error = "Cassandra process did not stop within timeout"
      }
    }
    if (-not $serverStopped) {
      $result.crashed = $true
      if (-not $result.fatal_error) {
        $result.fatal_error = "Deliveroo server process did not stop within timeout"
      }
    }
    if (-not (Wait-PortFree -TimeoutSeconds 15)) {
      $owner = Get-PortOwnerPid
      $result.crashed = $true
      if (-not $result.fatal_error) {
        $result.fatal_error = "Port 8080 still in use after cleanup (PID $owner)"
      }
    }

    Merge-ErrorLog -Handle $cassandraHandle
    Merge-ErrorLog -Handle $serverHandle
    Update-ResultFromLogs -Result $result -CassandraLog $cassandraLog -ServerLog $serverLog -Scenario $scenario
    Write-Result -Result $result -RunDir $runDir
    $allResults += [pscustomobject]$result

    $scoreText = if ($null -eq $result.score) { "null" } else { "$($result.score)" }
    $penaltyText = if ($null -eq $result.penalty) { "null" } else { "$($result.penalty)" }
    Write-Host "[$scenario] done score=$scoreText penalty=$penaltyText pickups=$($result.pickup_count) deliveries=$($result.delivery_count) crashed=$($result.crashed)"
  }
}

$summaryCsv = Join-Path $ResultsDir "summary.csv"
$summaryJson = Join-Path $ResultsDir "summary.json"

$allResults |
  Select-Object scenario,duration_seconds,agent,score,penalty,connected,pickup_observed,pickup_count,delivery_observed,delivery_count,crashed,fatal_error,timestamp |
  Export-Csv -LiteralPath $summaryCsv -NoTypeInformation -Encoding UTF8

$allResults | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $summaryJson -Encoding UTF8

Write-Host "Summary written to $summaryCsv"
Write-Host "Summary written to $summaryJson"
