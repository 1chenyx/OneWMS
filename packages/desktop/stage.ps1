# OneWMS 桌面版 staging 脚本：组装 Tauri resources/server 运行时载荷
# 用法：powershell -File packages\desktop\stage.ps1
# 产物：packages/desktop/src-tauri/resources/server/{node.exe, packages/*, node_modules}
$ErrorActionPreference = 'Stop'

$desktop = $PSScriptRoot                                # packages/desktop
$repo = Split-Path -Parent (Split-Path -Parent $desktop) # 仓库根（desktop → packages → 根）
$dest = Join-Path $desktop 'src-tauri\resources\server'
$src = Join-Path $desktop 'stage-tmp'

# 1) 全量构建五个包
Push-Location $repo
try { npm run build } finally { Pop-Location }

# 2) 组装运行时目录
if (Test-Path $src) { Remove-Item $src -Recurse -Force }
New-Item -ItemType Directory -Force -Path "$src\packages\core","$src\packages\wms","$src\packages\ai","$src\packages\server","$src\packages\app" | Out-Null
Copy-Item "$repo\package.json" $src -Force
foreach ($p in 'core','wms','ai','server') {
  Copy-Item "$repo\packages\$p\package.json" "$src\packages\$p\" -Force
  Copy-Item "$repo\packages\$p\dist" "$src\packages\$p\dist" -Recurse -Force
}
Copy-Item "$repo\packages\app\dist" "$src\packages\app\dist" -Recurse -Force
Push-Location $src
try { npm install --omit=dev --no-audit --no-fund --loglevel=error } finally { Pop-Location }

# 3) node_modules/@one 若为 junction（沙箱/CI 环境可能指向临时目录）替换为真实目录，
#    保证后续拷贝与 zip/安装包分发后不依赖本机绝对路径
$oneDir = Join-Path $src 'node_modules\@one'
Get-ChildItem $oneDir -Directory -ErrorAction SilentlyContinue |
  Where-Object { $_.LinkType -eq 'Junction' } | ForEach-Object { $_.Delete() }
foreach ($n in 'core','wms','ai') {
  $target = Join-Path $oneDir $n
  if (Test-Path $target) { Remove-Item $target -Recurse -Force }
  Copy-Item "$src\packages\$n" $target -Recurse -Force
}

# 4) 拷贝到 Tauri resources（排除数据与无关产物）
if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
Copy-Item $src $dest -Recurse -Force
foreach ($junk in 'data','start.bat','package-lock.json','node_modules\.bin') {
  $p = Join-Path $dest $junk
  if (Test-Path $p) { Remove-Item $p -Recurse -Force }
}

# 5) 携带 node.exe（与本机 better-sqlite3 预编译 ABI 一致）
$nodeSrc = (Get-Command node).Source
Copy-Item $nodeSrc (Join-Path $dest 'node.exe') -Force

# 6) 清理临时目录
Remove-Item $src -Recurse -Force

Write-Output "[stage] payload 就绪: $dest"
