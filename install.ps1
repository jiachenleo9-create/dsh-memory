<#
.SYNOPSIS
  安装 dsh-memory 插件到 DSH profile。

.DESCRIPTION
  DSH 的插件解析走 profile 的 node_modules，而源目录是 profile\plugins。
  参考 dsh-completion-alert 的既有布局，本安装器会部署三处：

    1. profile\plugins\dsh-memory      ← 源副本（便于阅读与再安装）
    2. profile\node_modules\dsh-memory ← 实际被加载的模块
    3. profile\package.json            ← 登记 dependencies + dsh.profile.bundles

  三者缺一不可，否则重启后插件不会加载。安装前自动备份被覆盖的内容。

.PARAMETER DshHome
  DSH 主目录，默认取 $env:DSH_HOME，否则 ~/.dsh。

.PARAMETER Profile
  profile 名，默认 desktop。

.PARAMETER DryRun
  只打印将要做的改动，不落盘。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install.ps1
  powershell -ExecutionPolicy Bypass -File .\install.ps1 -DryRun
#>
[CmdletBinding()]
param(
  [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }),
  [string]$Profile = 'desktop',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$source      = Split-Path -Parent $PSCommandPath
$profileDir  = Join-Path $DshHome "profiles\$Profile"
$pluginsDir  = Join-Path $profileDir 'plugins'
$pluginDir   = Join-Path $pluginsDir 'dsh-memory'
$modulesDir  = Join-Path $profileDir 'node_modules'
$moduleDir   = Join-Path $modulesDir 'dsh-memory'
$packageJson = Join-Path $profileDir 'package.json'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

function Write-Step($t) { Write-Host "  $t" -ForegroundColor Cyan }
function Write-Ok($t)   { Write-Host "  [OK] $t" -ForegroundColor Green }
function Write-Note($t) { Write-Host "  [!!] $t" -ForegroundColor Yellow }

Write-Host "`n=== dsh-memory 安装器 ===" -ForegroundColor White
Write-Host "  源目录    : $source"
Write-Host "  profile   : $profileDir"
Write-Host "  源副本    : $pluginDir"
Write-Host "  加载位置  : $moduleDir"
if ($DryRun) { Write-Host "  模式      : DRY RUN（不落盘）" -ForegroundColor Yellow }

# ------------------------------------------------------------------ 1 前置检查
Write-Host "`n[1/5] 前置检查" -ForegroundColor White
if (-not (Test-Path -LiteralPath $packageJson)) {
  throw "找不到 profile 的 package.json：$packageJson`n请确认 -DshHome 与 -Profile 是否正确。"
}
if (-not (Test-Path -LiteralPath $modulesDir)) {
  throw "找不到 node_modules：$modulesDir`n请确认 profile 已初始化过（至少启动过一次 DSH）。"
}
Write-Ok "profile 结构完整"

$shipped = @('lib', 'cordis.patch.yml', 'package.json', 'README.md')
foreach ($item in $shipped) {
  if (-not (Test-Path -LiteralPath (Join-Path $source $item))) { throw "源缺失：$item" }
}
foreach ($rel in @('lib\index.js', 'lib\store.js', 'lib\brief.js', 'lib\harvest.js', 'lib\privacy.js', 'lib\tools.js', 'lib\config.js', 'lib\source.js', 'lib\audit.js')) {
  if (-not (Test-Path -LiteralPath (Join-Path $source $rel))) { throw "源文件缺失：$rel" }
}
Write-Ok "插件源文件完整"

if (-not $DryRun) {
  try {
    $probe = Join-Path $pluginsDir ".write-probe-$stamp"
    [System.IO.File]::WriteAllText($probe, 'ok')
    Remove-Item -LiteralPath $probe -Force
    Write-Ok "目标目录可写"
  } catch {
    throw "无法写入 $pluginsDir（$($_.Exception.Message)）。`n请以管理员身份运行，或先把 DSH 安装目录的权限授予当前用户。"
  }
}

# ------------------------------------------------------------------ 2 部署源副本
Write-Host "`n[2/5] 部署源副本 → plugins\" -ForegroundColor White
if ($DryRun) {
  Write-Step "将复制 $source → $pluginDir"
} else {
  if (Test-Path -LiteralPath $pluginDir) {
    $backup = "$pluginDir.bak-$stamp"
    Write-Step "已存在，备份为 $(Split-Path -Leaf $backup)"
    Move-Item -LiteralPath $pluginDir -Destination $backup -Force
  }
  New-Item -ItemType Directory -Path $pluginDir -Force | Out-Null
  # 只复制发布物：排除开发期的 node_modules 测试垫片与 tests 目录
  foreach ($item in $shipped) {
    Copy-Item -LiteralPath (Join-Path $source $item) -Destination $pluginDir -Recurse -Force
  }
  Write-Ok "已复制到 $pluginDir"
}

# ------------------------------------------------------------------ 3 部署加载副本
Write-Host "`n[3/5] 部署加载副本 → node_modules\" -ForegroundColor White
if ($DryRun) {
  Write-Step "将复制 $pluginDir → $moduleDir"
} else {
  if (Test-Path -LiteralPath $moduleDir) {
    $existing = Get-Item -LiteralPath $moduleDir -Force
    if ($existing.LinkType -eq 'Junction' -or $existing.LinkType -eq 'SymbolicLink') {
      Write-Step "检测到链接，移除链接（只删链接，不动目标目录）"
      Remove-Item -LiteralPath $moduleDir -Force
    } else {
      $backup = "$moduleDir.bak-$stamp"
      Write-Step "已存在，备份为 $(Split-Path -Leaf $backup)"
      Move-Item -LiteralPath $moduleDir -Destination $backup -Force
    }
  }
  New-Item -ItemType Directory -Path $moduleDir -Force | Out-Null
  foreach ($item in $shipped) {
    Copy-Item -LiteralPath (Join-Path $pluginDir $item) -Destination $moduleDir -Recurse -Force
  }
  Write-Ok "已复制到 $moduleDir"
}

# ------------------------------------------------------------------ 4 登记 profile
Write-Host "`n[4/5] 登记到 profile" -ForegroundColor White
$manifest = Get-Content -LiteralPath $packageJson -Raw -Encoding UTF8 | ConvertFrom-Json
$depValue = 'file:plugins/dsh-memory'
$alreadyDep = $manifest.dependencies.PSObject.Properties.Name -contains 'dsh-memory'
$alreadyBundle = $manifest.dsh.profile.bundles -contains 'dsh-memory'

if ($alreadyDep -and $alreadyBundle) {
  Write-Ok "依赖与 bundle 均已登记，无需修改"
} elseif ($DryRun) {
  if (-not $alreadyDep) { Write-Step "将把 dependencies.dsh-memory 设为 `"$depValue`"" }
  if (-not $alreadyBundle) { Write-Step "将把 `"dsh-memory`" 追加到 dsh.profile.bundles" }
} else {
  Copy-Item -LiteralPath $packageJson -Destination "$packageJson.bak-$stamp" -Force
  Write-Step "已备份 package.json → package.json.bak-$stamp"

  $raw = Get-Content -LiteralPath $packageJson -Raw -Encoding UTF8
  # 文本插入而非 ConvertTo-Json：后者会重排整个文件、丢失原有格式。
  if (-not $alreadyDep) {
    $raw = $raw -replace '("dependencies"\s*:\s*\{)', "`$1`n    `"dsh-memory`": `"$depValue`","
  }
  if (-not $alreadyBundle) {
    $raw = $raw -replace '("bundles"\s*:\s*\[)', "`$1`n        `"dsh-memory`","
  }
  [System.IO.File]::WriteAllText($packageJson, $raw, (New-Object System.Text.UTF8Encoding($false)))
  Write-Ok "package.json 已更新"
}

# ------------------------------------------------------------------ 5 校验
Write-Host "`n[5/5] 校验" -ForegroundColor White
if ($DryRun) {
  Write-Step "（dry run 跳过校验）"
} else {
  $check = Get-Content -LiteralPath $packageJson -Raw -Encoding UTF8 | ConvertFrom-Json
  $okDep = $check.dependencies.PSObject.Properties.Name -contains 'dsh-memory'
  $okBundle = $check.dsh.profile.bundles -contains 'dsh-memory'
  if (-not ($okDep -and $okBundle)) {
    throw "package.json 校验失败（依赖=$okDep bundle=$okBundle）。请从 package.json.bak-$stamp 恢复。"
  }
  Write-Ok "package.json 有效：依赖与 bundle 均已登记"

  foreach ($target in @($pluginDir, $moduleDir)) {
    if (-not (Test-Path -LiteralPath (Join-Path $target 'lib\index.js'))) { throw "校验失败：$target 缺少 lib\index.js" }
    if (-not (Test-Path -LiteralPath (Join-Path $target 'cordis.patch.yml'))) { throw "校验失败：$target 缺少 cordis.patch.yml" }
  }
  Write-Ok "两份副本均已就位"

  $node = Get-Command node -ErrorAction SilentlyContinue
  if ($node) {
    $entry = Join-Path $moduleDir 'lib\index.js'
    try {
      & $node.Source --check $entry 2>&1 | Out-Null
      if ($LASTEXITCODE -eq 0) { Write-Ok "插件语法自检通过" }
      else { Write-Note "语法自检返回 $LASTEXITCODE（可忽略，ESM --check 支持程度因版本而异）" }
    } catch {
      Write-Note "语法自检跳过：$($_.Exception.Message)"
    }
  } else {
    Write-Note "未找到 node，跳过语法自检"
  }
}

Write-Host "`n=== 完成 ===" -ForegroundColor Green
Write-Host @"

下一步：
  1. 重启 DeepSeek Harness —— 插件只在启动时加载。
  2. 确认加载成功（端口以实际为准）：
       Invoke-RestMethod http://127.0.0.1:19387/memory/ping
  3. 自检四层存储读写：
       Invoke-RestMethod "http://127.0.0.1:19387/memory/selftest?cwd=<工作区路径>"
  4. 预览即将注入的记忆简报：
       Invoke-RestMethod "http://127.0.0.1:19387/memory/brief?cwd=<工作区路径>"
  5. 查看当前任务锚点：
       Invoke-RestMethod "http://127.0.0.1:19387/memory/anchor?cwd=<工作区路径>"

卸载（任选其一）：
  A. 用备份回滚：把 plugins\dsh-memory.bak-$stamp 与
     node_modules\dsh-memory.bak-$stamp 改回原名，并恢复 package.json.bak-$stamp。
  B. 手工删除 $pluginDir 与 $moduleDir，再从 package.json 的
     dependencies 与 dsh.profile.bundles 中移除 dsh-memory 行。

"@ -ForegroundColor Gray
