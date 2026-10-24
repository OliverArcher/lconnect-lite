<#
.SYNOPSIS
  打安装包：编译后台服务，放到 Tauri 的 externalBin 位置，再编译界面并生成 NSIS 安装程序。
  输出在 target\release\bundle\nsis\LConnect Lite_<版本>_x64-setup.exe。

.EXAMPLE
  .\scripts\build-installer.ps1
#>
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent

Push-Location $root
try {
  cargo build --release -p lcl-daemon -p lcl-sensord -p lcl-display-host
  if ($LASTEXITCODE -ne 0) { throw '编译后台服务失败' }
  # Tauri 按“名字-目标三元组.exe”找附带的程序，安装时改回原名放在界面旁边。
  $bin = Join-Path $root 'app\src-tauri\binaries'
  New-Item -ItemType Directory -Force $bin | Out-Null
  foreach ($name in 'lcl-daemon', 'lcl-sensord', 'lcl-display-host') {
    Copy-Item (Join-Path $root "target\release\$name.exe") (Join-Path $bin "$name-x86_64-pc-windows-msvc.exe") -Force
  }

  Set-Location (Join-Path $root 'app')
  npx tauri build
  if ($LASTEXITCODE -ne 0) { throw '打包失败' }
  Get-ChildItem (Join-Path $root 'target\release\bundle\nsis\*-setup.exe') | Select-Object FullName, Length
} finally {
  Pop-Location
}
