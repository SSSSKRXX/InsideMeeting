# 一键启动（Windows 版，对应 start.sh）
# 用法：在项目根目录执行  powershell -ExecutionPolicy Bypass -File scripts\start.ps1
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host '未安装 Node.js。请先执行：winget install OpenJS.NodeJS.LTS' -ForegroundColor Red
    exit 1
}

if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    Write-Host '未安装 ffmpeg，会议纪要功能不可用。' -ForegroundColor Yellow
    Write-Host '安装方式：winget install Gyan.FFmpeg（装完需要重开终端让 PATH 生效）'
    Write-Host '或者在 .env 里把 FFMPEG_PATH / FFPROBE_PATH 指向 exe 的完整路径。'
    Write-Host ''
}

if (-not (Test-Path '.env')) {
    Copy-Item '.env.example' '.env'
    Write-Host '已生成 .env，请填入 ASR_API_KEY / LLM_API_KEY 后重新运行。' -ForegroundColor Yellow
    exit 0
}

if (-not (Test-Path 'certs\cert.pem')) {
    & powershell -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'gen-cert.ps1')
}

if (-not (Test-Path 'node_modules')) { npm install }
if (-not (Test-Path 'web\dist'))     { npm run build }

# 首次启动 Windows 防火墙会弹窗，必须勾选「专用网络」才能让别人连进来
npm start
