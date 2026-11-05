# OneWMS 桌面版一键构建脚本
# 用法：
#   powershell -File packages\desktop\build.ps1                # 全量：安装包 + 便携版
#   powershell -File packages\desktop\build.ps1 -SkipInstaller # 仅便携版（跳过 NSIS，快）
# 产物统一输出到仓库根 dist/ 目录：
#   dist/OneWMS-<版本>-portable-win-x64.zip   便携版（解压即用）
#   dist/OneWMS-portable/                     便携版目录（可直接运行 OneWMS.exe）
#   dist/OneWMS-<版本>-setup-win-x64.exe      NSIS 安装包
param([switch]$SkipInstaller)

$ErrorActionPreference = 'Stop'

$desktop = $PSScriptRoot                                 # packages/desktop
$repo = Split-Path -Parent (Split-Path -Parent $desktop) # 仓库根
$version = (Get-Content "$repo\package.json" -Raw | ConvertFrom-Json).version
$dist = Join-Path $repo 'dist'
New-Item -ItemType Directory -Force -Path $dist | Out-Null

# cargo 加入 PATH（tauri build 需要）
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"

Write-Output '[1/4] 构建工作区包并组装服务端 payload...'
powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $desktop 'stage.ps1')

Write-Output '[2/4] Tauri 构建...'
Push-Location $desktop
try {
  if ($SkipInstaller) { npx tauri build --no-bundle } else { npx tauri build }
} finally { Pop-Location }

Write-Output '[3/4] 组装便携版...'
$portable = Join-Path $dist 'OneWMS-portable'
if (Test-Path $portable) { Remove-Item $portable -Recurse -Force }
New-Item -ItemType Directory -Force -Path "$portable\resources" | Out-Null
Copy-Item "$desktop\src-tauri\target\release\onewms-desktop.exe" "$portable\OneWMS.exe"
Copy-Item "$desktop\src-tauri\resources\server" "$portable\resources\server" -Recurse
# 清理运行残留数据，保证产物干净
if (Test-Path "$portable\data") { Remove-Item "$portable\data" -Recurse -Force }

Write-Output '[4/4] 打包分发产物...'
$zip = Join-Path $dist "OneWMS-$version-portable-win-x64.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path "$portable\*" -DestinationPath $zip

if (-not $SkipInstaller) {
  $setupSrc = Join-Path $desktop "src-tauri\target\release\bundle\nsis\OneWMS_${version}_x64-setup.exe"
  Copy-Item $setupSrc (Join-Path $dist "OneWMS-$version-setup-win-x64.exe") -Force
}

Write-Output ''
Write-Output '构建完成，产物位于 dist/:'
Get-ChildItem $dist -File | ForEach-Object { Write-Output ("  {0}  ({1:N1} MB)" -f $_.Name, ($_.Length/1MB)) }
