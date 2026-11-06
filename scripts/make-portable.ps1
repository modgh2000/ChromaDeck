# Builds the portable ZIP from a finished `tauri build` output.
# Run AFTER `npm run tauri build` (or `npm run bundle:all`):
#   npm run bundle:portable
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$pkg = Get-Content (Join-Path $root "package.json") -Raw | ConvertFrom-Json
$version = $pkg.version

$exe = Join-Path $root "src-tauri/target/release/chromadeck.exe"
if (-not (Test-Path -LiteralPath $exe)) {
    throw "Missing $exe - run 'npm run tauri build' first."
}

$outDir = Join-Path $root "src-tauri/target/release/bundle/portable"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$zip = Join-Path $outDir "ChromaDeck_${version}_x64-portable.zip"
if (Test-Path -LiteralPath $zip) { Remove-Item -Force -LiteralPath $zip }

$stage = Join-Path ([IO.Path]::GetTempPath()) ("chromadeck-portable-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $stage | Out-Null
try {
    Copy-Item -LiteralPath $exe -Destination (Join-Path $stage "chromadeck.exe")
    Copy-Item -LiteralPath (Join-Path $root "LICENSE") -Destination $stage
    # Intel IGCL header transcription requires its notice to accompany
    # distribution (see NOTICE).
    Copy-Item -LiteralPath (Join-Path $root "NOTICE") -Destination $stage
    # Portable marker: presence of this empty file beside the exe tells the
    # app to keep all data in a `data` folder next to it instead of
    # %LOCALAPPDATA%\ChromaDeck (see default_store_path in store.rs).
    New-Item -ItemType File -Force -Path (Join-Path $stage "portable") | Out-Null
    Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zip
} finally {
    Remove-Item -Recurse -Force -LiteralPath $stage -ErrorAction SilentlyContinue
}

"Portable bundle: $zip"
