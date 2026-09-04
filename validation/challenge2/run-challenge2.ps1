param(
  [int]$DurationSeconds = 180,
  [int]$PreflightDurationSeconds = 45,
  [string]$HostUrl = "http://localhost:8080",
  [string[]]$Scenarios = @("26c2_1","26c2_2","26c2_3","26c2_4","26c2_5","26c2_6","26c2_7","26c2_8","26c2_9"),
  [string]$OutputDirName = "generated",
  [switch]$SkipLlmNetworkPreflight,
  [switch]$SkipShortPreflight,
  [switch]$PreflightOnly
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = (Resolve-Path (Join-Path $ScriptDir "..\..")).Path
$ResultsDir = Join-Path $ScriptDir $OutputDirName
$PreflightDir = Join-Path $ResultsDir ("preflight_" + (Get-Date -Format "yyyyMMdd_HHmmss"))
$PidFile = Join-Path $ScriptDir ".challenge2-processes.json"
$Scenarios = @($Scenarios | ForEach-Object { "$_".Split(',') } | ForEach-Object { $_.Trim() } | Where-Object { $_ })

function Read-LogText([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return "" }
  return (Get-Content -LiteralPath $Path -Raw -ErrorAction SilentlyContinue)
}

function Load-DotEnvIfPresent([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  foreach ($line in Get-Content -LiteralPath $Path) {
    $trimmed = $line.Trim()
    if ($trimmed.Length -eq 0 -or $trimmed.StartsWith("#") -or $trimmed -notmatch "^\s*([^#=]+?)\s*=\s*(.*)\s*$") { continue }
    $key = $Matches[1].Trim()
    $value = $Matches[2].Trim()
    if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($key, "Process"))) {
      [Environment]::SetEnvironmentVariable($key, $value, "Process")
    }
  }
}

Load-DotEnvIfPresent (Join-Path $ProjectDir ".env")
$ServerDir = $env:DELIVEROO_BACKEND_DIR
$MissionDir = $env:MISSION_AGENTS_DIR
$ScenarioDir = if ([string]::IsNullOrWhiteSpace($MissionDir)) { $null } else { Join-Path $MissionDir "challenge2" }

function Test-Key([string]$Key) {
  return -not [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($Key, "Process"))
}

function Require-ExternalDirectory {
  param([string]$Path, [string]$VariableName, [string]$Purpose)
  if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path -PathType Container)) {
    throw "$VariableName must name the $Purpose directory before running this live validation harness."
  }
}

function Get-ScenarioDefinition([string]$Scenario) {
  $json = & node.exe (Join-Path $ScriptDir "scenario-metadata.js") $Scenario
  if ($LASTEXITCODE -ne 0) { throw "No official Challenge 2 mapping for $Scenario" }
  return ($json | ConvertFrom-Json)
}

function Invoke-EnvironmentPreflight {
  Load-DotEnvIfPresent (Join-Path $ProjectDir ".env")

  $preflightPath = Join-Path $ScriptDir "environment-preflight.json"
  $preflight = [ordered]@{
    timestamp = (Get-Date).ToUniversalTime().ToString("o")
    llm_api_key_available = (Test-Key "LLM_API_KEY")
    llm_base_url_available = (Test-Key "LLM_BASE_URL")
    llm_model_available = (Test-Key "LLM_MODEL")
    admin_token_generated_by_runner = $true
    admin_password_configured = (Test-Key "ADMIN_PASSWORD")
    admin_password_default_used = -not (Test-Key "ADMIN_PASSWORD")
    team_secret_available = (Test-Key "TEAM_SECRET")
    planner_required_for_selected_scenarios = $false
    planner_checked = $false
    llm_network_checked = $false
    llm_network_available = $null
    llm_preflight_log = $null
  }

  if (-not $preflight.llm_api_key_available) {
    $preflight | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $preflightPath -Encoding UTF8
    throw "LLM_API_KEY is not available from the process environment or the repository-root .env file"
  }
  if ($Scenarios | Where-Object { (Get-ScenarioDefinition $_).level -eq "L3" }) {
    if (-not $preflight.team_secret_available) {
      $preflight | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $preflightPath -Encoding UTF8
      throw "TEAM_SECRET is not available; L3 validation requires authenticated Loqua/Cassandra_T pairing"
    }
  }

  if (-not $SkipLlmNetworkPreflight) {
    $logPath = Join-Path $ScriptDir "llm-preflight.log"
    Push-Location $ProjectDir
    try {
      & node.exe "validation/challenge2/llm-preflight.js" *> $logPath
      $preflight.llm_network_checked = $true
      $llmLogText = Read-LogText $logPath
      $preflight.llm_network_available = ($LASTEXITCODE -eq 0 -and $llmLogText -match '"ok"\s*:\s*true' -and $llmLogText -match '"responseReceived"\s*:\s*true')
      $preflight.llm_preflight_log = $logPath
    } finally {
      Pop-Location
    }
    if (-not $preflight.llm_network_available) {
      $preflight | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $preflightPath -Encoding UTF8
      throw "LLM provider preflight failed. See $logPath"
    }
  }

  $preflight | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $preflightPath -Encoding UTF8
  Write-Host "[preflight] LLM_API_KEY=available LLM_BASE_URL=$($preflight.llm_base_url_available) LLM_MODEL=$($preflight.llm_model_available) ADMIN_TOKEN=generated-per-backend ADMIN_PASSWORD_CONFIGURED=$($preflight.admin_password_configured) DEFAULT_ADMIN_PASSWORD_USED=$($preflight.admin_password_default_used) TEAM_SECRET=$($preflight.team_secret_available) LLM_NETWORK=$($preflight.llm_network_available) PLANNER_REQUIRED=false"
}

function Get-AdminPassword {
  $configured = [Environment]::GetEnvironmentVariable("ADMIN_PASSWORD", "Process")
  if ([string]::IsNullOrWhiteSpace($configured)) { return "admin" }
  return $configured
}

function Request-AdminToken {
  param([string]$RunDir)
  $tokenMetaPath = Join-Path $RunDir "admin-token-preflight.json"
  $password = Get-AdminPassword
  $headers = @{
    name = "challenge2-mission-admin"
    password = $password
  }
  try {
    $response = Invoke-RestMethod -Uri "$HostUrl/api/tokens" -Method Post -Headers $headers -TimeoutSec 10
    $role = $response.payload.role
    $ok = -not [string]::IsNullOrWhiteSpace($response.token) -and $role -eq "admin"
    [ordered]@{
      timestamp = (Get-Date).ToUniversalTime().ToString("o")
      endpoint = "$HostUrl/api/tokens"
      method = "POST"
      headers_sent = @("name", "password")
      token_value_persisted = $false
      admin_password_configured = (Test-Key "ADMIN_PASSWORD")
      admin_password_default_used = -not (Test-Key "ADMIN_PASSWORD")
      token_obtained = $ok
      payload_role = $role
    } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $tokenMetaPath -Encoding UTF8
    if (-not $ok) { throw "Generated token was missing or not admin role" }
    return $response.token
  } catch {
    [ordered]@{
      timestamp = (Get-Date).ToUniversalTime().ToString("o")
      endpoint = "$HostUrl/api/tokens"
      method = "POST"
      headers_sent = @("name", "password")
      token_value_persisted = $false
      admin_password_configured = (Test-Key "ADMIN_PASSWORD")
      admin_password_default_used = -not (Test-Key "ADMIN_PASSWORD")
      token_obtained = $false
      error = $_.Exception.Message
    } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $tokenMetaPath -Encoding UTF8
    throw "Could not obtain admin JWT from local backend: $($_.Exception.Message)"
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
  param([int[]]$BeforePids, [int]$TimeoutSeconds = 5)
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
  param([string]$FilePath, [string[]]$Arguments, [string]$WorkingDirectory, [hashtable]$Environment, [string]$LogPath)
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $LogPath) | Out-Null
  Set-Content -LiteralPath $LogPath -Value "" -Encoding UTF8
  $beforeNodePids = Get-NodePids
  $psi = [System.Diagnostics.ProcessStartInfo]::new()
  $psi.FileName = "cmd.exe"
  $psi.WorkingDirectory = $WorkingDirectory
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  foreach ($key in $Environment.Keys) {
    $value = $Environment[$key]
    if ($null -eq $value) { $value = "" }
    $psi.Environment[$key] = "$value"
  }
  $argText = ConvertTo-ArgumentText $Arguments
  $commandLine = if ([string]::IsNullOrWhiteSpace($argText)) { "$FilePath > `"$LogPath`" 2>&1" } else { "$FilePath $argText > `"$LogPath`" 2>&1" }
  $psi.Arguments = "/d /s /c `"$commandLine`""
  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $psi
  [void]$process.Start()
  return [pscustomobject]@{ Process = $process; LogPath = $LogPath; KillPids = @(Find-NewNodePids -BeforePids $beforeNodePids -TimeoutSeconds 5) }
}

function Wait-ProcessExit { param([int]$ProcessId, [int]$TimeoutSeconds = 10)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if ($null -eq (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) { return $true }
    Start-Sleep -Milliseconds 250
  }
  return $false
}

function Stop-PidTree { param([int]$ProcessId, [int]$TimeoutSeconds = 10)
  if ($ProcessId -le 0) { return $true }
  if ($null -eq (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) { return $true }
  try { Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue } catch {}
  if (Wait-ProcessExit -ProcessId $ProcessId -TimeoutSeconds 2) { return $true }
  try { & taskkill.exe /PID $ProcessId /T /F | Out-Null } catch {}
  return (Wait-ProcessExit -ProcessId $ProcessId -TimeoutSeconds $TimeoutSeconds)
}

function Stop-LoggedProcess { param($Handle, [int]$TimeoutSeconds = 10)
  if ($null -eq $Handle) { return $true }
  $processId = $Handle.Process.Id
  $stopped = $true
  foreach ($extraPid in @($Handle.KillPids)) {
    if ($extraPid -and ([int]$extraPid) -ne $processId) {
      $stopped = (Stop-PidTree -ProcessId ([int]$extraPid) -TimeoutSeconds $TimeoutSeconds) -and $stopped
    }
  }
  $stopped = (Stop-PidTree -ProcessId $processId -TimeoutSeconds $TimeoutSeconds) -and $stopped
  try { $Handle.Process.WaitForExit(1000) | Out-Null } catch {}
  try { $Handle.Process.Dispose() } catch {}
  return $stopped
}

function Save-ActivePids {
  param($ServerHandle, [object[]]$AgentHandles, $MissionHandle)
  $items = @()
  foreach ($entry in @(@{ role = "server"; handle = $ServerHandle }, @{ role = "mission-agent"; handle = $MissionHandle })) {
    $h = $entry.handle
    if ($h -and $h.Process -and -not $h.Process.HasExited) {
      $items += [pscustomobject]@{ role = $entry.role; pid = $h.Process.Id; kill_pids = @($h.KillPids); path = $h.LogPath; timestamp = (Get-Date).ToUniversalTime().ToString("o") }
    }
  }
  foreach ($h in @($AgentHandles)) {
    if ($h -and $h.Process -and -not $h.Process.HasExited) {
      $items += [pscustomobject]@{ role = "agent"; pid = $h.Process.Id; kill_pids = @($h.KillPids); path = $h.LogPath; timestamp = (Get-Date).ToUniversalTime().ToString("o") }
    }
  }
  if ($items.Count -gt 0) { $items | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $PidFile -Encoding UTF8 }
  elseif (Test-Path -LiteralPath $PidFile) { Remove-Item -LiteralPath $PidFile -Force }
}

function Stop-StaleValidationProcesses {
  if (-not (Test-Path -LiteralPath $PidFile)) { return }
  $records = @(Get-Content -LiteralPath $PidFile -Raw | ConvertFrom-Json)
  foreach ($record in $records) {
    foreach ($extraPid in @($record.kill_pids)) { if ($extraPid) { [void](Stop-PidTree -ProcessId ([int]$extraPid) -TimeoutSeconds 10) } }
    if ($record.pid) { [void](Stop-PidTree -ProcessId ([int]$record.pid) -TimeoutSeconds 10) }
  }
  Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
}

function Get-PortOwnerPid {
  $lines = @(netstat.exe -ano -p tcp | Select-String -Pattern '^\s*TCP\s+\S+:8080\s+\S+\s+LISTENING\s+(\d+)\s*$')
  if ($lines.Count -eq 0) { return $null }
  return [int]$lines[0].Matches[0].Groups[1].Value
}

function Wait-PortFree { param([int]$TimeoutSeconds = 15)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if ($null -eq (Get-PortOwnerPid)) { return $true }
    Start-Sleep -Milliseconds 250
  }
  return $false
}

function Invoke-AgentsEndpoint {
  return @(Invoke-RestMethod -Uri "$HostUrl/api/agents" -TimeoutSec 3)
}

function Wait-ForLogPattern { param([string]$LogPath, [string]$Pattern, [int]$TimeoutSeconds, $Process)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if ($Process -and $Process.HasExited) { return $false }
    if ((Read-LogText $LogPath) -match $Pattern) { return $true }
    Start-Sleep -Milliseconds 250
  }
  return $false
}

function Wait-ForServerReady { param($Handle, [string]$Scenario, [int]$TimeoutSeconds = 60)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $scenarioLoaded = $false
  while ((Get-Date) -lt $deadline) {
    if ($Handle.Process.HasExited) { return $false }
    if ((Read-LogText $Handle.LogPath) -match [regex]::Escape("title: '$Scenario'")) { $scenarioLoaded = $true }
    try { if ($null -ne (Invoke-AgentsEndpoint) -and $scenarioLoaded) { return $true } } catch {}
    Start-Sleep -Milliseconds 500
  }
  return $false
}

function Wait-ForAgentReady { param($Handle, [string]$AgentName, [int]$TimeoutSeconds = 90)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $startLog = $false
  while ((Get-Date) -lt $deadline) {
    if ($Handle.Process.HasExited) { return $false }
    if ((Read-LogText $Handle.LogPath) -match ([regex]::Escape("[start] `"$AgentName`""))) { $startLog = $true }
    try {
      $agent = Invoke-AgentsEndpoint | Where-Object { $_.name -eq $AgentName } | Select-Object -First 1
      if ($startLog -and $agent) { return $true }
    } catch {}
    Start-Sleep -Milliseconds 500
  }
  return $false
}

function Convert-AgentSnapshot($agents) {
  $out = @{}
  foreach ($name in @("Loqua", "Cassandra_T")) {
    $a = $agents | Where-Object { $_.name -eq $name } | Select-Object -First 1
    if ($a) { $out[$name] = [ordered]@{ id = $a.id; name = $a.name; score = [int]$a.score; penalty = [int]$a.penalty; x = $a.x; y = $a.y; connected = $true } }
    else { $out[$name] = $null }
  }
  return $out
}

function Count-Matches([string]$Text, [string]$Pattern) {
  return ([regex]::Matches($Text, $Pattern)).Count
}

function Initialize-ResultsDirectory {
  param([string]$Directory, [string[]]$ScenarioList)
  $blocking = @("runs", "summary.csv", "summary.json", "summary.md") |
    ForEach-Object { Join-Path $Directory $_ } |
    Where-Object { Test-Path -LiteralPath $_ }
  if ($blocking.Count -gt 0) {
    throw "Generated output already exists in $Directory. Choose a different OutputDirName to avoid overwriting generated evidence."
  }
  New-Item -ItemType Directory -Force -Path (Join-Path $Directory "runs") | Out-Null
  foreach ($scenario in $ScenarioList) { New-Item -ItemType Directory -Force -Path (Join-Path (Join-Path $Directory "runs") $scenario) | Out-Null }
}

function Build-ResultFromLogs {
  param([string]$Scenario, $Definition, [string]$RunDir, [int]$RuntimeSeconds, $FinalSnapshot, [bool]$ScenarioVerified, [bool]$AdminTokenObtained, [bool]$Crashed, [string]$FatalError)
  $loquaText = Read-LogText (Join-Path $RunDir "loqua.log")
  $cassandraText = Read-LogText (Join-Path $RunDir "cassandra-team.log")
  $missionText = Read-LogText (Join-Path $RunDir "mission-agent.log")
  $rewards = Count-Matches $missionText 'Rewarded\s+.+?\s+with\s+\d+pts'
  $penalties = Count-Matches $missionText 'Penalized\s+.+?\s+with\s+\d+pts'
  $loquaRewards = Count-Matches $missionText 'Rewarded\s+Loqua\s+with\s+\d+pts'
  $loquaPenalties = Count-Matches $missionText 'Penalized\s+Loqua\s+with\s+\d+pts'
  $cassRewards = Count-Matches $missionText 'Rewarded\s+Cassandra_T\s+with\s+\d+pts'
  $cassPenalties = Count-Matches $missionText 'Penalized\s+Cassandra_T\s+with\s+\d+pts'
  $directiveObserved = switch ($Scenario) {
    "26c2_1" { $loquaText -match '\[policy\] adopted goto' -or $loquaText -match '\[mission\] goto .* completed' }
    "26c2_2" { $loquaText -match '\[policy\] adopted drop_at' -or $loquaText -match '\[mission\] drop_at .* completed' }
    "26c2_3" { $loquaText -match '\[mission\] answered ' }
    "26c2_4" { $loquaText -match '\[reflex\] provisional avoidance' -or $loquaText -match '\[policy\] avoidance directive' }
    "26c2_5" { $loquaText -match '\[policy\] directive: deliver EXACTLY' }
    "26c2_6" { $loquaText -match '\[reflex\] provisional avoidance' -or $loquaText -match '\[policy\] avoidance directive' }
    "26c2_7" { $loquaText -match '\[policy\] directive: deliveries capped' }
    "26c2_8" { $loquaText -match '\[policy\] handoff adopted' -or $cassandraText -match 'handoff' }
    "26c2_9" { $loquaText -match '\[reflex\] stop-go ARMED' -or $loquaText -match '\[policy\] stop-go armed' }
    default { $false }
  }
  $combined = $loquaText + "`n" + $cassandraText
  $coordObserved = if ($Definition.level -eq "L3") { ($combined -match '\[team\] paired with teammate' -and $combined -match '\[team\] (directive received|task accepted|belief exchange|RED LIGHT|GREEN LIGHT)') } else { $null }
  $missionSuccess = switch ($Scenario) {
    "26c2_1" { $loquaRewards -gt 0 }
    "26c2_2" { $loquaRewards -gt 0 }
    "26c2_3" { $loquaRewards -gt 0 -and ($loquaText -match '\[mission\] answered ') }
    "26c2_4" { $directiveObserved -and $loquaPenalties -eq 0 }
    "26c2_5" { $loquaRewards -gt 0 -and $directiveObserved }
    "26c2_6" { $directiveObserved -and $loquaPenalties -eq 0 }
    "26c2_7" { $loquaRewards -gt 0 -and $directiveObserved }
    "26c2_8" { $rewards -gt 0 -and $directiveObserved -and $coordObserved }
    "26c2_9" { $directiveObserved -and $coordObserved -and (($loquaPenalties + $cassPenalties) -eq 0) }
    default { $null }
  }
  $configPath = Join-Path $ScenarioDir "$Scenario.json"
  $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
  $args = @($Definition.missionArgs)
  return [ordered]@{
    scenario = $Scenario
    level = $Definition.level
    requirement = $Definition.requirement
    duration = $RuntimeSeconds
    scenario_verified = $ScenarioVerified
    admin_token_obtained = $AdminTokenObtained
    admin_token_persisted = $false
    json_config_path = $configPath
    json_title = $config.title
    json_description = $config.description
    crashed = $Crashed
    fatal_error = $FatalError
    mission_agent = $Definition.missionAgent
    mission_agent_script = (Join-Path $MissionDir $Definition.missionAgent)
    mission_arguments = $args
    mission_command = "node.exe validation/challenge2/mission-launcher.js $Scenario"
    mission_request = $args[2]
    agents_launched = @($Definition.agents)
    final_agents = $FinalSnapshot
    final_score_loqua = if ($FinalSnapshot.Loqua) { $FinalSnapshot.Loqua.score } else { $null }
    final_score_cassandra = if ($FinalSnapshot.Cassandra_T) { $FinalSnapshot.Cassandra_T.score } else { $null }
    final_position_loqua = if ($FinalSnapshot.Loqua) { @{ x = $FinalSnapshot.Loqua.x; y = $FinalSnapshot.Loqua.y } } else { $null }
    final_position_cassandra = if ($FinalSnapshot.Cassandra_T) { @{ x = $FinalSnapshot.Cassandra_T.x; y = $FinalSnapshot.Cassandra_T.y } } else { $null }
    mission_success = $missionSuccess
    mission_reward_count = $rewards
    mission_penalty_count = $penalties
    loqua_mission_reward_count = $loquaRewards
    loqua_mission_penalty_count = $loquaPenalties
    cassandra_mission_reward_count = $cassRewards
    cassandra_mission_penalty_count = $cassPenalties
    llm_request_observed = ($loquaText -match '\[mission\] from ')
    llm_interpretation_observed = ($loquaText -match '\[mission\] interpreted ')
    directive_or_goal_observed = $directiveObserved
    team_coordination_observed = $coordObserved
    logs = [ordered]@{ server = (Join-Path $RunDir "server.log"); loqua = (Join-Path $RunDir "loqua.log"); cassandra_team = if (Test-Path -LiteralPath (Join-Path $RunDir "cassandra-team.log")) { (Join-Path $RunDir "cassandra-team.log") } else { $null }; mission_agent = (Join-Path $RunDir "mission-agent.log") }
    notes = ""
  }
}

function Run-Scenario {
  param([string]$Scenario, [int]$RuntimeSeconds, [string]$BaseDir)
  $definition = Get-ScenarioDefinition $Scenario
  $runDir = Join-Path (Join-Path $BaseDir "runs") $Scenario
  New-Item -ItemType Directory -Force -Path $runDir | Out-Null
  $serverHandle = $null; $loquaHandle = $null; $cassHandle = $null; $missionHandle = $null
  $crashed = $false; $fatalError = $null; $scenarioVerified = $false; $adminTokenObtained = $false; $finalSnapshot = @{}
  Write-Host "[$Scenario] starting ($($definition.level), $($definition.requirement))"
  try {
    Stop-StaleValidationProcesses
    if (-not (Wait-PortFree -TimeoutSeconds 15)) { throw "Port 8080 is already in use before starting $Scenario (PID $(Get-PortOwnerPid))" }
    $configPath = Join-Path $ScenarioDir "$Scenario.json"
    foreach ($requiredPath in @($configPath, (Join-Path $MissionDir $definition.missionAgent), (Join-Path $ProjectDir "agents\loqua.js"))) {
      if (-not (Test-Path -LiteralPath $requiredPath)) { throw "Required file not found: $requiredPath" }
    }
    if (@($definition.agents) -contains "Cassandra_T" -and -not (Test-Path -LiteralPath (Join-Path $ProjectDir "agents\cassandra-team.js"))) { throw "Cassandra_T entry point not found" }
    $serverHandle = Start-LoggedProcess -FilePath "node.exe" -Arguments @("index.js", "-g", $configPath) -WorkingDirectory $ServerDir -Environment @{ TOKEN = $null } -LogPath (Join-Path $runDir "server.log")
    Save-ActivePids -ServerHandle $serverHandle -AgentHandles @() -MissionHandle $null
    if (-not (Wait-ForServerReady -Handle $serverHandle -Scenario $Scenario -TimeoutSeconds 60)) { throw "Server did not become ready with official config $Scenario" }
    $scenarioVerified = $true
    $adminToken = Request-AdminToken -RunDir $runDir
    $adminTokenObtained = $true
    $serverOwnerPid = Get-PortOwnerPid
    if ($serverOwnerPid) { $serverHandle.KillPids = @(@($serverHandle.KillPids) + $serverOwnerPid | Select-Object -Unique) }
    if (Invoke-AgentsEndpoint | Where-Object { $_.name -in @("Loqua", "Cassandra_T") }) { throw "Stale Loqua/Cassandra_T already registered before launch" }
    $loquaHandle = Start-LoggedProcess -FilePath "node.exe" -Arguments @("agents/loqua.js") -WorkingDirectory $ProjectDir -Environment @{ HOST = $HostUrl; TOKEN = $null } -LogPath (Join-Path $runDir "loqua.log")
    Save-ActivePids -ServerHandle $serverHandle -AgentHandles @($loquaHandle) -MissionHandle $null
    if (-not (Wait-ForAgentReady -Handle $loquaHandle -AgentName "Loqua" -TimeoutSeconds 90)) { throw "Loqua did not reach the connected runtime state" }
    if (@($definition.agents) -contains "Cassandra_T") {
      $cassHandle = Start-LoggedProcess -FilePath "node.exe" -Arguments @("agents/cassandra-team.js") -WorkingDirectory $ProjectDir -Environment @{ HOST = $HostUrl; TOKEN = $null } -LogPath (Join-Path $runDir "cassandra-team.log")
      Save-ActivePids -ServerHandle $serverHandle -AgentHandles @($loquaHandle, $cassHandle) -MissionHandle $null
      if (-not (Wait-ForAgentReady -Handle $cassHandle -AgentName "Cassandra_T" -TimeoutSeconds 90)) { throw "Cassandra_T did not reach the connected runtime state" }
    }
    $missionHandle = Start-LoggedProcess -FilePath "node.exe" -Arguments @("validation/challenge2/mission-launcher.js", $Scenario) -WorkingDirectory $ProjectDir -Environment @{ HOST = $HostUrl; ADMIN_TOKEN = $adminToken } -LogPath (Join-Path $runDir "mission-agent.log")
    Save-ActivePids -ServerHandle $serverHandle -AgentHandles @($loquaHandle, $cassHandle) -MissionHandle $missionHandle
    $prompt = [string]$definition.missionArgs[2]
    if (-not (Wait-ForLogPattern -LogPath (Join-Path $runDir "mission-agent.log") -Pattern ([regex]::Escape($prompt.Substring(0, [Math]::Min(40, $prompt.Length)))) -TimeoutSeconds 30 -Process $missionHandle.Process)) { throw "Mission agent did not emit the official prompt" }
    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    $handles = @($serverHandle, $loquaHandle, $cassHandle, $missionHandle) | Where-Object { $_ }
    while ($stopwatch.Elapsed.TotalSeconds -lt $RuntimeSeconds) {
      foreach ($h in $handles) {
        if ($h.Process.HasExited) { $crashed = $true; $fatalError = "A validation process exited before the $RuntimeSeconds-second window ended: $($h.LogPath)"; break }
      }
      if ($crashed) { break }
      $remainingMs = [math]::Max(0, ($RuntimeSeconds * 1000) - $stopwatch.ElapsedMilliseconds)
      Start-Sleep -Milliseconds ([math]::Min(1000, $remainingMs))
    }
    try { $finalSnapshot = Convert-AgentSnapshot (Invoke-AgentsEndpoint) } catch { $crashed = $true; $fatalError = "Could not query /api/agents: $($_.Exception.Message)" }
  } catch {
    $crashed = $true
    $fatalError = $_.Exception.Message
  } finally {
    $missionStopped = Stop-LoggedProcess -Handle $missionHandle -TimeoutSeconds 10
    Save-ActivePids -ServerHandle $serverHandle -AgentHandles @($loquaHandle, $cassHandle) -MissionHandle $null
    $cassStopped = Stop-LoggedProcess -Handle $cassHandle -TimeoutSeconds 10
    $loquaStopped = Stop-LoggedProcess -Handle $loquaHandle -TimeoutSeconds 10
    Save-ActivePids -ServerHandle $serverHandle -AgentHandles @() -MissionHandle $null
    $serverStopped = Stop-LoggedProcess -Handle $serverHandle -TimeoutSeconds 10
    Save-ActivePids -ServerHandle $null -AgentHandles @() -MissionHandle $null
    if (-not $missionStopped -or -not $cassStopped -or -not $loquaStopped -or -not $serverStopped) { $crashed = $true; if (-not $fatalError) { $fatalError = "One or more validation processes did not stop within timeout" } }
    if (-not (Wait-PortFree -TimeoutSeconds 15)) { $crashed = $true; if (-not $fatalError) { $fatalError = "Port 8080 still in use after cleanup (PID $(Get-PortOwnerPid))" } }
  }
  $result = Build-ResultFromLogs -Scenario $Scenario -Definition $definition -RunDir $runDir -RuntimeSeconds $RuntimeSeconds -FinalSnapshot $finalSnapshot -ScenarioVerified $scenarioVerified -AdminTokenObtained $adminTokenObtained -Crashed $crashed -FatalError $fatalError
  $result | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $runDir "result.json") -Encoding UTF8
  Write-Host "[$Scenario] done success=$($result.mission_success) score_loqua=$($result.final_score_loqua) score_cassandra=$($result.final_score_cassandra) crashed=$($result.crashed)"
  return [pscustomobject]$result
}

function Write-Summaries {
  param([object[]]$Results, [string]$BaseDir)
  $Results |
    Select-Object scenario,level,duration,scenario_verified,crashed,mission_agent,@{n='agents';e={$_.agents_launched -join '+'}},mission_success,final_score_loqua,final_score_cassandra,llm_request_observed,llm_interpretation_observed,directive_or_goal_observed,team_coordination_observed,notes |
    Export-Csv -LiteralPath (Join-Path $BaseDir "summary.csv") -NoTypeInformation -Encoding UTF8
  $Results | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $BaseDir "summary.json") -Encoding UTF8
  $lines = @("# Challenge 2 Validation Summary", "", "| Scenario | Level | Mission | Success | Loqua score | Cassandra_T score | Crash/Error |", "|---|---|---|---|---:|---:|---|")
  foreach ($r in $Results) {
    $err = if ($r.crashed) { "YES: $($r.fatal_error)" } else { "No" }
    $cassScore = if ($null -eq $r.final_score_cassandra) { "N/A" } else { "$($r.final_score_cassandra)" }
    $lines += "| $($r.scenario) | $($r.level) | $($r.requirement) | $($r.mission_success) | $($r.final_score_loqua) | $cassScore | $err |"
  }
  $lines | Set-Content -LiteralPath (Join-Path $BaseDir "summary.md") -Encoding UTF8
  Write-Host "Summary written to $(Join-Path $BaseDir 'summary.csv')"
  Write-Host "Summary written to $(Join-Path $BaseDir 'summary.json')"
  Write-Host "Readable summary written to $(Join-Path $BaseDir 'summary.md')"
}

Stop-StaleValidationProcesses
Require-ExternalDirectory -Path $ServerDir -VariableName "DELIVEROO_BACKEND_DIR" -Purpose "official Deliveroo backend"
Require-ExternalDirectory -Path $MissionDir -VariableName "MISSION_AGENTS_DIR" -Purpose "official Deliveroo missionAgents"
Require-ExternalDirectory -Path $ScenarioDir -VariableName "MISSION_AGENTS_DIR" -Purpose "official Deliveroo missionAgents/challenge2"
if (-not (Wait-PortFree -TimeoutSeconds 15)) { throw "Port 8080 is already in use before validation startup (PID $(Get-PortOwnerPid)). It was not created by this harness, so it was not terminated." }
Invoke-EnvironmentPreflight
if (-not $SkipShortPreflight) {
  Initialize-ResultsDirectory -Directory $PreflightDir -ScenarioList @("26c2_1")
  $preflightResult = Run-Scenario -Scenario "26c2_1" -RuntimeSeconds $PreflightDurationSeconds -BaseDir $PreflightDir
  Write-Summaries -Results @($preflightResult) -BaseDir $PreflightDir
  if ($preflightResult.crashed -or -not $preflightResult.scenario_verified -or -not $preflightResult.llm_request_observed -or -not $preflightResult.llm_interpretation_observed) {
    throw "Short 26c2_1 preflight failed; not running full official suite. See $PreflightDir"
  }
  if ($PreflightOnly) {
    Write-Host "PreflightOnly set; full official suite not launched."
    return
  }
}
Initialize-ResultsDirectory -Directory $ResultsDir -ScenarioList $Scenarios
$allResults = @()
foreach ($scenario in $Scenarios) { $allResults += Run-Scenario -Scenario $scenario -RuntimeSeconds $DurationSeconds -BaseDir $ResultsDir }
Write-Summaries -Results $allResults -BaseDir $ResultsDir
