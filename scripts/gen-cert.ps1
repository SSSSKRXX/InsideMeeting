# 生成 HTTPS 证书（Windows 版，对应 gen-cert.sh）
# 用法：在项目根目录执行  powershell -ExecutionPolicy Bypass -File scripts\gen-cert.ps1
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$CertDir = Join-Path $Root 'certs'
New-Item -ItemType Directory -Force -Path $CertDir | Out-Null

$CertFile = Join-Path $CertDir 'cert.pem'
$KeyFile  = Join-Path $CertDir 'key.pem'

# ---------- 优先用 Tailscale 签发的正式证书 ----------
$ts = Get-Command tailscale -ErrorAction SilentlyContinue
if (-not $ts) {
    $tsExe = 'C:\Program Files\Tailscale\tailscale.exe'
    if (Test-Path $tsExe) { $ts = $tsExe }
}
if ($ts) {
    $tsPath = if ($ts -is [string]) { $ts } else { $ts.Source }
    try {
        $status = & $tsPath status --json | ConvertFrom-Json
        $dnsName = $status.Self.DNSName -replace '\.$', ''
    } catch { $dnsName = $null }

    if ($dnsName) {
        Write-Host "检测到 Tailscale 域名：$dnsName"
        Write-Host "正在申请 Let's Encrypt 证书（需要在 Tailscale 后台开启 HTTPS Certificates）…"
        & $tsPath cert --cert-file $CertFile --key-file $KeyFile $dnsName 2>$null
        if ($LASTEXITCODE -eq 0 -and (Test-Path $CertFile)) {
            Write-Host ''
            Write-Host '已获取受信任的正式证书，浏览器不会有任何安全警告。' -ForegroundColor Green
            Write-Host "访问地址：https://$dnsName`:8443"
            Write-Host ''
            Write-Host '证书 90 天过期。建议用「任务计划程序」每月跑一次本脚本并重启服务。'
            exit 0
        }
        Write-Host 'tailscale cert 失败，回退到自签证书。' -ForegroundColor Yellow
        Write-Host '（需要在 Tailscale 管理后台 DNS 页面启用 MagicDNS 和 HTTPS Certificates）'
        Write-Host ''
    }
}

# ---------- 回退：自签证书 ----------
# 收集本机所有内网 IP 一起写进 SAN
$ips = @(Get-NetIPAddress -AddressFamily IPv4 |
         Where-Object { $_.IPAddress -ne '127.0.0.1' } |
         Select-Object -ExpandProperty IPAddress)

$san = @('DNS:localhost', 'IP:127.0.0.1') + ($ips | ForEach-Object { "IP:$_" })
# 允许额外传入域名：.\gen-cert.ps1 meet.company.com
foreach ($extra in $args) { $san += "DNS:$extra" }
$sanStr = $san -join ','
Write-Host "证书 SAN: $sanStr"

$openssl = Get-Command openssl -ErrorAction SilentlyContinue
if ($openssl) {
    & openssl req -x509 -newkey rsa:2048 -nodes `
        -keyout $KeyFile -out $CertFile -days 3650 `
        -subj '/C=CN/O=InsideMeeting/CN=InsideMeeting' `
        -addext "subjectAltName=$sanStr" 2>$null
} else {
    # 没装 openssl 就用 Windows 自带的证书 API，再导出成 pem
    Write-Host '未找到 openssl，改用 Windows 内置证书接口生成…'
    $dnsNames = @('localhost') + $ips
    $cert = New-SelfSignedCertificate -DnsName $dnsNames -CertStoreLocation 'Cert:\CurrentUser\My' `
            -NotAfter (Get-Date).AddYears(10) -FriendlyName 'InsideMeeting' `
            -KeyExportPolicy Exportable -KeyAlgorithm RSA -KeyLength 2048

    $certB64 = [Convert]::ToBase64String($cert.RawData, 'InsertLineBreaks')
    "-----BEGIN CERTIFICATE-----`n$certB64`n-----END CERTIFICATE-----" |
        Set-Content -Path $CertFile -Encoding ascii

    $rsa = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($cert)
    $keyB64 = [Convert]::ToBase64String($rsa.ExportPkcs8PrivateKey(), 'InsertLineBreaks')
    "-----BEGIN PRIVATE KEY-----`n$keyB64`n-----END PRIVATE KEY-----" |
        Set-Content -Path $KeyFile -Encoding ascii

    Remove-Item "Cert:\CurrentUser\My\$($cert.Thumbprint)" -Force
}

Write-Host ''
Write-Host '证书已生成：' -ForegroundColor Green
Write-Host "  $CertFile"
Write-Host "  $KeyFile"
Write-Host ''
Write-Host '首次访问浏览器会提示「不安全」，这是自签证书的正常现象：'
Write-Host '  Chrome/Edge：点「高级」→「继续前往」。'
Write-Host '  想彻底去掉警告：双击 cert.pem → 安装证书 → 本地计算机 → 受信任的根证书颁发机构。'
Write-Host ''
