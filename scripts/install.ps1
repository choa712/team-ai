<#
One-command install for TeamAI on Windows: dependencies, build, command links.

Run scripts\install.cmd, which starts this script whatever the PowerShell
execution policy is. Idempotent: re-run it to upgrade.

  -DryRun          print what would happen, change nothing
  -UserBin         link into %LOCALAPPDATA%\TeamAI\bin (added to the user PATH)
                   instead of npm's global prefix; also the automatic fallback
                   when npm link fails
  -Ps1Shims MODE   auto (default) | keep | remove. npm writes a .ps1 next to
                   each .cmd command, and PowerShell prefers the .ps1, which the
                   default Restricted policy refuses to run. auto removes the
                   TeamAI .ps1 files only when the policy would block them, so
                   PowerShell falls back to the .cmd.
  -Uninstall       remove the commands, the fallback directory and its PATH entry
  -RemoveTeamClaude
                   also stop and uninstall TeamClaude and clear the address it
                   left in ~/.claude/settings.json (scripts\remove-teamclaude.mjs;
                   will not stop a running TeamClaude while sessions using it run)

This file is ASCII on purpose: Windows PowerShell 5.1 reads a script without a
byte order mark in the system code page.
#>
[CmdletBinding()]
param(
  [switch]$DryRun,
  [switch]$UserBin,
  [ValidateSet('auto', 'keep', 'remove')][string]$Ps1Shims = 'auto',
  [switch]$Uninstall,
  [switch]$RemoveTeamClaude
)
$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$Launchers = @('tai', 'taic', 'tax', 'tag')
$Commands = @('teamai') + $Launchers
$UserBinDir = if ($env:TEAMAI_BIN_DIR) { $env:TEAMAI_BIN_DIR } else { Join-Path $env:LOCALAPPDATA 'TeamAI\bin' }

function Step([string]$Message) { Write-Host ''; Write-Host "==> $Message" }
function Note([string]$Message) { Write-Host "   $Message" }

function Invoke-Npm([string[]]$NpmArgs) {
  if ($DryRun) { Note "would run: npm $($NpmArgs -join ' ')"; return 0 }
  # npm.cmd, not npm: under the Restricted policy "npm" resolves to npm.ps1 and is refused.
  & npm.cmd @NpmArgs | Out-Host
  return $LASTEXITCODE
}

function Get-UserPath { [Environment]::GetEnvironmentVariable('Path', 'User') }
function Set-UserPath([string]$Value) { [Environment]::SetEnvironmentVariable('Path', $Value, 'User') }
function Split-PathList([string]$Value) { if ($Value) { @($Value -split ';' | Where-Object { $_ }) } else { @() } }

# What a new terminal would see: the machine PATH, then the user PATH.
function Get-FreshPath { ([Environment]::GetEnvironmentVariable('Path', 'Machine'), (Get-UserPath) | Where-Object { $_ }) -join ';' }

# The policy a normal PowerShell window runs under. This process was started
# with -ExecutionPolicy Bypass, so the Process scope is ignored here.
function Get-SessionPolicy {
  foreach ($scope in 'MachinePolicy', 'UserPolicy', 'CurrentUser', 'LocalMachine') {
    $value = Get-ExecutionPolicy -Scope $scope
    if ($value -ne 'Undefined') { return [string]$value }
  }
  return 'Restricted'
}

function Remove-UserBin {
  if (Test-Path $UserBinDir) {
    foreach ($name in $Commands) {
      foreach ($file in (Join-Path $UserBinDir "$name.cmd"), (Join-Path $UserBinDir "$name.mjs")) {
        if (Test-Path $file) { if ($DryRun) { Note "would remove $file" } else { Remove-Item -Force $file } }
      }
    }
    if (-not $DryRun -and -not (Get-ChildItem $UserBinDir -Force | Select-Object -First 1)) { Remove-Item -Force $UserBinDir }
  }
  $entries = Split-PathList (Get-UserPath)
  $kept = @($entries | Where-Object { $_.TrimEnd('\') -ne $UserBinDir.TrimEnd('\') })
  if ($kept.Count -ne $entries.Count) {
    if ($DryRun) { Note "would remove $UserBinDir from the user PATH" } else { Set-UserPath ($kept -join ';'); Note "removed $UserBinDir from the user PATH" }
  }
}

if ($Uninstall) {
  Step 'Removing TeamAI commands'
  $code = Invoke-Npm @('rm', '--global', 'teamai-cli', '--loglevel=error')
  if ($code -ne 0) { Note "npm rm exited $code (nothing linked?)" }
  Remove-UserBin
  Write-Host ''
  Write-Host 'TeamAI commands removed. Accounts and settings in %USERPROFILE%\.config\teamai are kept.'
  exit 0
}

Step 'Checking prerequisites'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'node not found. Install Node.js 20 or newer (https://nodejs.org).' }
if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { throw 'npm not found. Install Node.js 20 or newer.' }
$nodeMajor = [int](& node -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt 20) { throw "Node 20+ required, found $(& node -v)." }
Note "node $(& node -v)"
# Not fatal: TeamAI is useful with only one of the two clients installed.
foreach ($client in 'claude', 'codex') {
  if (-not (Get-Command $client -ErrorAction SilentlyContinue)) { Note "note: '$client' is not on PATH; $client sessions will not launch until it is" }
}

Set-Location $RepoRoot

Step 'Installing dependencies'
$hasLock = Test-Path (Join-Path $RepoRoot 'package-lock.json')
$code = if ($hasLock) { Invoke-Npm @('ci', '--no-audit', '--no-fund') } else { 1 }
if ($code -ne 0) { $code = Invoke-Npm @('install', '--no-audit', '--no-fund') }
if ($code -ne 0) { throw "npm install failed ($code)" }

Step 'Building'
$code = Invoke-Npm @('run', 'build')
if ($code -ne 0) { throw "npm run build failed ($code)" }

Step "Linking commands ($($Commands -join ', '))"
$linkedInto = 'npm'
if (-not $UserBin) {
  $code = Invoke-Npm @('link', '--no-audit', '--no-fund')
  if ($code -ne 0) { Note "npm link failed ($code); linking into $UserBinDir instead"; $UserBin = $true }
}
if ($UserBin) {
  $linkedInto = $UserBinDir
  $targets = @{ 'teamai' = 'dist\src\cli.js' }
  foreach ($name in $Launchers) { $targets[$name] = "dist\src\bin\$name.js" }
  # Each command is <name>.cmd running <name>.mjs beside it, and the .mjs imports
  # the entry file by its file:// URL. Both files are plain ASCII whatever the
  # repository path is: the URL percent-encodes it, and %~dp0 is expanded by
  # cmd.exe itself. A path written into the .cmd would pass through the console
  # code page and break on a profile such as C:\Users\<Korean name>. The launcher
  # name reaches the CLI as the .mjs file name.
  if ($DryRun) { Note "would write $($Commands.Count) commands to $UserBinDir" } else {
    New-Item -ItemType Directory -Force -Path $UserBinDir | Out-Null
    foreach ($name in $Commands) {
      $url = ([Uri](Join-Path $RepoRoot $targets[$name])).AbsoluteUri
      Set-Content -Path (Join-Path $UserBinDir "$name.mjs") -Encoding Ascii -Value "import '$url';"
      Set-Content -Path (Join-Path $UserBinDir "$name.cmd") -Encoding Ascii -Value "@node `"%~dp0$name.mjs`" %*"
    }
  }
  $entries = Split-PathList (Get-UserPath)
  if (-not ($entries | Where-Object { $_.TrimEnd('\') -eq $UserBinDir.TrimEnd('\') })) {
    if ($DryRun) { Note "would add $UserBinDir to the user PATH" } else { Set-UserPath ((@($entries) + $UserBinDir) -join ';'); Note "added $UserBinDir to the user PATH" }
  }
}

$policy = Get-SessionPolicy
if ($linkedInto -eq 'npm') {
  $prefix = (& npm.cmd prefix --global).Trim()
  $blocked = $policy -in @('Restricted', 'AllSigned')
  if ($Ps1Shims -eq 'remove' -or ($Ps1Shims -eq 'auto' -and $blocked)) {
    Step "Removing TeamAI .ps1 shims (execution policy: $policy)"
    foreach ($name in $Commands) {
      $shim = Join-Path $prefix "$name.ps1"
      # Only npm's shim for this package: never a file someone else put there.
      if ((Test-Path $shim) -and ((Get-Content -Raw $shim) -match 'teamai-cli')) {
        if ($DryRun) { Note "would remove $shim" } else { Remove-Item -Force $shim; Note "removed $shim; PowerShell runs $name.cmd instead" }
      }
    }
  }
}

Step 'Verifying in a new session'
if ($DryRun) { Note 'would check that every command resolves and that tax and taic reach their clients' } else {
  # A child PowerShell with a new terminal's PATH and policy: the Bypass this
  # script runs under is passed down through PSExecutionPolicyPreference, so
  # it is cleared for the child.
  $probeHome = Join-Path ([IO.Path]::GetTempPath()) ("teamai-install-check-" + [Guid]::NewGuid().ToString('N'))
  $check = @'
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$failed = 0
foreach ($name in 'teamai', 'tai', 'taic', 'tax', 'tag') {
  $cmd = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $cmd) { Write-Output "MISSING $name"; $failed++ } else { Write-Output "found $name -> $($cmd.Source)" }
}
teamai help *> $null
if ($LASTEXITCODE -ne 0) { Write-Output "teamai help exited $LASTEXITCODE"; $failed++ }
# With an empty TEAMAI_HOME a launcher stops before starting anything, and
# what it says shows which client it would have run.
foreach ($pair in @(@('tax', 'codex'), @('taic', 'claude'))) {
  $out = (& $pair[0] status 2>&1 | Out-String)
  if ($out -match "No enabled $($pair[1]) accounts") { Write-Output "$($pair[0]) -> $($pair[1])" } else { Write-Output "$($pair[0]) did not reach $($pair[1]): $($out.Trim())"; $failed++ }
}
exit $failed
'@
  $savedPath = $env:Path; $savedPolicy = $env:PSExecutionPolicyPreference; $savedHome = $env:TEAMAI_HOME
  try {
    $env:Path = Get-FreshPath; $env:TEAMAI_HOME = $probeHome
    Remove-Item Env:PSExecutionPolicyPreference -ErrorAction SilentlyContinue
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($check))
    & powershell.exe -NoProfile -NonInteractive -OutputFormat Text -EncodedCommand $encoded | ForEach-Object { Note $_ }
    $verifyCode = $LASTEXITCODE
  } finally {
    $env:Path = $savedPath; $env:TEAMAI_HOME = $savedHome
    if ($null -ne $savedPolicy) { $env:PSExecutionPolicyPreference = $savedPolicy }
    Remove-Item -Recurse -Force $probeHome -ErrorAction SilentlyContinue
  }
  if ($verifyCode -ne 0) { throw "verification failed ($verifyCode problem(s)); see the lines above" }
  Note "commands resolve under the $policy policy"
}

# TeamClaude writes its address into ~/.claude/settings.json, and that file
# wins over the address taic passes: TeamAI sessions then reach TeamClaude, or a
# dead port once it stops. Remove it on request, otherwise only report it.
$teamclaudeStatus = 0
$removeScript = Join-Path $PSScriptRoot 'remove-teamclaude.mjs'
if ($RemoveTeamClaude) {
  Step 'Removing TeamClaude'
  $removeArgs = @($removeScript)
  if ($DryRun) { $removeArgs += '--dry-run' }
  & node @removeArgs | Out-Host
  $teamclaudeStatus = $LASTEXITCODE
} else {
  Step 'Checking for TeamClaude'
  & node $removeScript --check | Out-Host
  switch ($LASTEXITCODE) {
    0 { Note 'not found' }
    10 { Note 'Remove it, from a terminal with no Claude Code session: scripts\install.cmd -RemoveTeamClaude' }
    default { Note "could not check (exit $LASTEXITCODE)" }
  }
}

# Claude Code keeps one background service behind its sessions list ("claude
# agents", or the left arrow in a session), and that service keeps the variables
# of the shell that started it. One started by a plain "claude" has no relay
# address, so a session made through taic and opened from the list stops with
# "No LLM gateway". Stopping it is safe to repeat: background sessions keep
# running, and the next list opened through taic starts a new service.
if (Get-Command claude -ErrorAction SilentlyContinue) {
  Step 'Stopping the Claude Code background service'
  if ($DryRun) { Note 'would run: claude daemon stop --any --keep-workers' } else {
    # Through cmd.exe: it joins the two output streams itself, which Windows
    # PowerShell 5.1 turns into a terminating error under ErrorActionPreference Stop.
    $daemonOut = @(& cmd.exe /d /c 'claude daemon stop --any --keep-workers 2>&1 <nul')
    if ($LASTEXITCODE -eq 0) {
      $first = $daemonOut | Where-Object { "$_".Trim() } | Select-Object -First 1
      Note "$first; open the sessions list through taic (taic agents) from now on"
    } else { Note "skipped: this Claude Code did not accept 'daemon stop'" }
  }
}

# TeamClaude listened on the same Claude port (3456). A relay still running
# there makes every TeamAI start fail with "port in use", so say so now.
if (-not $DryRun) {
  $configPath = Join-Path $(if ($env:TEAMAI_HOME) { $env:TEAMAI_HOME } elseif ($env:XDG_CONFIG_HOME) { Join-Path $env:XDG_CONFIG_HOME 'teamai' } else { Join-Path $HOME '.config\teamai' }) 'config.json'
  $ports = @(3456, 3457)
  if (Test-Path $configPath) {
    try { $proxy = (Get-Content -Raw $configPath | ConvertFrom-Json).proxy; if ($proxy.claudePort) { $ports[0] = [int]$proxy.claudePort }; if ($proxy.codexPort) { $ports[1] = [int]$proxy.codexPort } } catch { }
  }
  foreach ($port in $ports) {
    $listen = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $listen) { continue }
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($listen.OwningProcess)" -ErrorAction SilentlyContinue
    if ($proc -and $proc.CommandLine -match 'teamai|team-ai') { continue }
    $who = if ($proc) { "$($proc.Name) (pid $($proc.ProcessId))" } else { "pid $($listen.OwningProcess)" }
    Write-Host ''
    Write-Host "   warning: port $port is already used by $who."
    Write-Host '   TeamAI cannot start while it is. If it is TeamClaude, close Claude Code and run: scripts\install.cmd -RemoveTeamClaude'
  }
}

Write-Host ''
Write-Host 'TeamAI is installed. Open a new terminal, then:'
Write-Host ''
Write-Host '  teamai login     add a Claude or Codex account (repeat per account)'
Write-Host '  taic             Claude Code through the account pool'
Write-Host '  tax              Codex through the account pool'
Write-Host '  tai              open the dashboard'
Write-Host ''
if ($teamclaudeStatus -ne 0) {
  Write-Host 'TeamClaude was not fully removed: see the lines above, then run scripts\install.cmd -RemoveTeamClaude again.'
  exit $teamclaudeStatus
}
