﻿# OneWMS 桌面版一键构建脚本
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

# 三处版本号必须一致——它们各喂一条独立的升级链路，对不上就会自相矛盾：
#   root package.json  → stage.ps1 写进 server/package.json，随包发布
#   tauri.conf.json    → updater 拿它和 latest.json 比，决定「要不要更新」
#   Cargo.toml         → CARGO_PKG_VERSION = ONE_APP_VERSION，升级闸门拿它判降级
# 典型事故：Cargo.toml 忘了跟着升，用户装了新版程序，闸门仍以为自己是旧版，
# 于是把新库判成「降级」拒开——用户升个级反而打不开软件。
$tauriJson = Get-Content "$desktop\src-tauri\tauri.conf.json" -Raw | ConvertFrom-Json
if ($tauriJson.version -ne $version) {
  Write-Error "[desktop] tauri.conf.json version=$($tauriJson.version) 与 package.json version=$version 不一致"
}
$cargoToml = Get-Content "$desktop\src-tauri\Cargo.toml" -Raw
if ($cargoToml -match '(?m)^\s*version\s*=\s*"([^"]+)"' -and $Matches[1] -ne $version) {
  Write-Error "[desktop] Cargo.toml version=$($Matches[1]) 与 package.json version=$version 不一致"
}

# cargo 加入 PATH（tauri build 需要）
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"

# 更新签名私钥：CI 走 secret（TAURI_SIGNING_PRIVATE_KEY），本机走 .updater\ 下那份。
# 没有私钥就不产 updater 工件——createUpdaterArtifacts 一旦打开而缺私钥，tauri build 会直接失败，
# 会把「只想出个便携版」的日常构建也一起拖死。
$updaterKey = "$desktop\src-tauri\.updater\onewms-updater.key"
if (-not $env:TAURI_SIGNING_PRIVATE_KEY -and (Test-Path $updaterKey)) {
  $env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content $updaterKey -Raw).Trim()
  if (-not $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD) { $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = '' }
}
$signing = [bool]$env:TAURI_SIGNING_PRIVATE_KEY

Write-Output '[1/4] 构建工作区包并组装服务端 payload...'
powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $desktop 'stage.ps1')

Write-Output '[2/4] Tauri 构建...'
Push-Location $desktop
try {
  if ($SkipInstaller) {
    npx tauri build --no-bundle
  } elseif ($signing) {
    # 用配置文件而不是内联 JSON 传 --config：PowerShell → npx(cmd shim) 会把内嵌引号吃掉
    $override = Join-Path $env:TEMP 'onewms-updater-config.json'
    Set-Content -Path $override -Value '{"bundle":{"createUpdaterArtifacts":true}}' -Encoding Ascii
    Write-Output '       （已启用 updater 工件：产出 setup.exe.sig）'
    npx tauri build --config $override
  } else {
    Write-Output '       （未找到更新签名私钥：跳过 updater 工件，本次产物不能被自动更新）'
    npx tauri build
  }
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
  $setupName = "OneWMS-$version-setup-win-x64.exe"
  $setupSrc = Join-Path $desktop "src-tauri\target\release\bundle\nsis\OneWMS_${version}_x64-setup.exe"
  Copy-Item $setupSrc (Join-Path $dist $setupName) -Force

  # updater 清单：客户端拿它比对版本、验签、下载安装包。
  # endpoint 固定指向 releases/latest/download/latest.json，所以每个 Release 都带上同名文件即可，
  # 用户端不用改配置就能一路升上去。
  $sigSrc = "$setupSrc.sig"
  if ($signing -and (Test-Path $sigSrc)) {
    Copy-Item $sigSrc (Join-Path $dist "$setupName.sig") -Force
    $origin = (git -C $repo remote get-url origin 2>$null)
    if ($origin -match 'github\.com[:/]([^/]+/[^/]+?)(?:\.git)?/?$') {
      $downloadUrl = "https://github.com/$($Matches[1])/releases/download/v$version/$setupName"
      $manifest = [ordered]@{
        version  = $version
        notes    = "OneWMS v$version"
        pub_date = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        platforms = [ordered]@{
          'windows-x86_64' = [ordered]@{
            signature = (Get-Content $sigSrc -Raw).Trim()
            url       = $downloadUrl
          }
        }
      }
      # 必须 -Depth：platforms 是三层嵌套，默认深度 2 会把它截成 "..."
      $json = $manifest | ConvertTo-Json -Depth 6
      # 不能带 BOM：本脚本跑在 PowerShell 5.1 上，Set-Content -Encoding UTF8 会写 BOM，
      # 而客户端是 serde_json 直接解响应体，首字节 BOM 会让它报 "expected value"，
      # 结果就是「明明发了版，所有客户端都说检查更新失败」。
      [System.IO.File]::WriteAllText((Join-Path $dist 'latest.json'), $json, (New-Object System.Text.UTF8Encoding $false))
      Write-Output "       已生成 dist\latest.json → $downloadUrl"
    } else {
      Write-Warning '[desktop] 无法从 git remote 推出 GitHub 仓库地址，跳过 latest.json'
    }
  }
}

Write-Output ''
Write-Output '构建完成，产物位于 dist/:'
Get-ChildItem $dist -File | ForEach-Object { Write-Output ("  {0}  ({1:N1} MB)" -f $_.Name, ($_.Length/1MB)) }
