$ErrorActionPreference = 'Continue'
$project = Split-Path -Parent $PSScriptRoot
$workspace = Split-Path -Parent (Split-Path -Parent $project)
$sdk = if ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT } elseif ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $workspace 'work\android-sdk' }
$data = if ($env:GATEWAY_DATA_DIR) { $env:GATEWAY_DATA_DIR } else { Join-Path $workspace 'work\gateway-data' }
$env:ANDROID_HOME = $sdk
$env:ANDROID_SDK_ROOT = $sdk
$env:GATEWAY_DATA_DIR = $data
if (-not $env:JAVA_HOME) { $env:JAVA_HOME = 'C:\Program Files\Android\Android Studio\jbr' }
if (-not $env:APPIUM_HOME) { $env:APPIUM_HOME = Join-Path $data 'appium' }
$nodeExe = if (Test-Path -LiteralPath 'C:\Program Files\nodejs\node.exe') { 'C:\Program Files\nodejs\node.exe' } else { (Get-Command node.exe -ErrorAction Stop).Source }
New-Item -ItemType Directory -Force -Path $data | Out-Null

function Test-ListenPort([int]$port) {
    return [bool](Get-NetTCPConnection -State Listen -LocalAddress '127.0.0.1' -LocalPort $port -ErrorAction SilentlyContinue)
}

while ($true) {
    try {
        $emulator = Get-CimInstance Win32_Process -Filter "name = 'emulator.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*Pixel_10_Android_17*' }
        $restartMarker = Join-Path $data 'camera-restart.lock'
        if (Test-Path -LiteralPath $restartMarker) {
            $markerAge = (Get-Date) - (Get-Item -LiteralPath $restartMarker).LastWriteTime
            if ($markerAge.TotalSeconds -gt 60) { Remove-Item -LiteralPath $restartMarker -Force }
        }
        if (-not $emulator -and -not (Test-Path -LiteralPath $restartMarker)) {
            $args = @('-avd', 'Pixel_10_Android_17', '-gpu', 'host', '-no-window', '-no-snapshot-load')
            $cameraConfig = Join-Path $data 'camera-source.json'
            if (Test-Path -LiteralPath $cameraConfig) {
                $cameraFile = (Get-Content -LiteralPath $cameraConfig -Raw | ConvertFrom-Json).file
                if ($cameraFile -and (Test-Path -LiteralPath $cameraFile)) {
                    $kind = if ($cameraFile -match '\.(png|jpe?g)$') { 'imagefile' } else { 'videofile' }
                    $args += @('-camera-back', "${kind}:$cameraFile")
                }
            }
            $emulatorExe = Join-Path $sdk 'emulator\emulator.exe'
            Add-Content -LiteralPath (Join-Path $data 'supervisor.err.log') -Value "$(Get-Date -Format o) starting emulator: exe=$emulatorExe exists=$(Test-Path -LiteralPath $emulatorExe) project=$project exists=$(Test-Path -LiteralPath $project) user=$env:USERNAME"
            Start-Process -FilePath $emulatorExe -ArgumentList $args -WindowStyle Hidden -WorkingDirectory $project -RedirectStandardOutput (Join-Path $data 'emulator.out.log') -RedirectStandardError (Join-Path $data 'emulator.err.log')
        }
        if (-not (Test-ListenPort 4723)) {
            Start-Process -FilePath $nodeExe -ArgumentList @('node_modules\appium\index.js', '--address', '127.0.0.1', '--port', '4723', '--base-path', '/webdriver', '--log-level', 'warn') -WorkingDirectory $project -WindowStyle Hidden -RedirectStandardOutput (Join-Path $data 'appium.out.log') -RedirectStandardError (Join-Path $data 'appium.err.log')
        }
        if (-not (Test-ListenPort 8765)) {
            Start-Process -FilePath $nodeExe -ArgumentList @('dist\server.js') -WorkingDirectory $project -WindowStyle Hidden -RedirectStandardOutput (Join-Path $data 'gateway.out.log') -RedirectStandardError (Join-Path $data 'gateway.err.log')
        }
    } catch {
        Add-Content -LiteralPath (Join-Path $data 'supervisor.err.log') -Value "$(Get-Date -Format o) $($_.InvocationInfo.Line.Trim()) :: $_"
    }
    Start-Sleep -Seconds 15
}
