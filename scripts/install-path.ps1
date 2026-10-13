$ErrorActionPreference = 'Stop'

# Register this installation for the current Windows user, without setx truncation
# or modifying the machine-wide PATH. The launcher keeps the caller's directory.
$id2aRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$id2aLauncher = Join-Path $id2aRoot 'id2a.cmd'
$id2aEntry = Join-Path $id2aRoot 'src\cli.mjs'
if (-not (Test-Path -LiteralPath $id2aLauncher -PathType Leaf) -or -not (Test-Path -LiteralPath $id2aEntry -PathType Leaf)) {
    throw 'ID2A launcher or source entry point is missing.'
}
if (-not (Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue)) {
    throw 'Node.js 24 or newer must be installed and available on PATH.'
}

function ConvertTo-Id2aPathKey([string] $id2aPathEntry) {
    if ([string]::IsNullOrWhiteSpace($id2aPathEntry)) { return '' }
    $id2aExpanded = [Environment]::ExpandEnvironmentVariables($id2aPathEntry.Trim().Trim('"'))
    try { return [IO.Path]::GetFullPath($id2aExpanded).TrimEnd('\', '/') }
    catch { return $id2aExpanded.TrimEnd('\', '/') }
}

$id2aPathKey = ConvertTo-Id2aPathKey $id2aRoot
$id2aExistingCommands = @(Get-Command id2a -All -ErrorAction SilentlyContinue)
foreach ($id2aExistingCommand in $id2aExistingCommands) {
    if ($id2aExistingCommand.CommandType -ne 'Application' -or
        (ConvertTo-Id2aPathKey $id2aExistingCommand.Source) -ine (ConvertTo-Id2aPathKey $id2aLauncher)) {
        throw "Another command named id2a already exists: $($id2aExistingCommand.Source). Resolve the name collision before installing."
    }
}

$id2aUserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$id2aRegistered = @($id2aUserPath -split ';' | Where-Object {
    (ConvertTo-Id2aPathKey $_) -ieq $id2aPathKey
}).Count -gt 0
if (-not $id2aRegistered) {
    $id2aSeparator = if ([string]::IsNullOrEmpty($id2aUserPath) -or $id2aUserPath.EndsWith(';')) { '' } else { ';' }
    [Environment]::SetEnvironmentVariable('Path', "$id2aUserPath$id2aSeparator$id2aRoot", 'User')
}

# This updates only this installer's process. Existing terminals need a restart
# or an explicit session-local PATH update; a child cannot update its parent.
$id2aInProcess = @($env:Path -split ';' | Where-Object {
    (ConvertTo-Id2aPathKey $_) -ieq $id2aPathKey
}).Count -gt 0
if (-not $id2aInProcess) { $env:Path += ";$id2aRoot" }
$id2aResolved = Get-Command id2a -CommandType Application -ErrorAction Stop
if ((ConvertTo-Id2aPathKey $id2aResolved.Source) -ine (ConvertTo-Id2aPathKey $id2aLauncher)) {
    throw 'PATH registration completed, but id2a resolved to another installation.'
}
Write-Output "ID2A registered on the current user's PATH: $id2aRoot"
Write-Output 'Open a new terminal and run id2a from any project directory.'
Write-Output ('For an already-open PowerShell session: $env:Path += ";' + $id2aRoot + '"')
