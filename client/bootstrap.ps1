param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [string]$Faex1Host = "10.10.10.184",
  [string]$Faex1User = "heir",
  [string]$Faex1Password = $env:PI_HEC_FAEX1_PASSWORD,
  [string]$ControlEndpoint = "https://10.10.10.184:8443",
  [string]$NodeVersion = "24.21.0"
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($Faex1Password)) {
  throw "Set PI_HEC_FAEX1_PASSWORD or pass -Faex1Password"
}

function Get-Python {
  foreach ($candidate in @("py", "python", "python3")) {
    $cmd = Get-Command $candidate -ErrorAction SilentlyContinue
    if ($cmd) {
      return $cmd.Source
    }
  }
  throw "Python 3 is required for client bootstrap (paramiko SFTP)"
}

function Ensure-Node {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if ($node) {
    $ver = & node -v
    if ($ver -match "^v24\.") {
      return
    }
  }
  $zip = Join-Path $env:TEMP "node-v$NodeVersion-win-x64.zip"
  $url = "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip"
  Invoke-WebRequest -Uri $url -OutFile $zip
  $dest = Join-Path $env:LOCALAPPDATA "Programs\node-v$NodeVersion-win-x64"
  if (-not (Test-Path (Join-Path $dest "node.exe"))) {
    Expand-Archive -Path $zip -DestinationPath (Join-Path $env:LOCALAPPDATA "Programs") -Force
  }
  $env:Path = "$dest;$env:Path"
}

Ensure-Node
corepack enable
corepack prepare pnpm@12.0.0 --activate

Set-Location $RepoRoot
pnpm install
pnpm exec tsc -b client/apps/pi-extension

$hecHome = Join-Path $env:USERPROFILE ".pi-hec"
New-Item -ItemType Directory -Force -Path (Join-Path $hecHome "pki") | Out-Null

$python = Get-Python
& $python -m pip install --user paramiko | Out-Null

$env:PI_HEC_FAEX1_HOST = $Faex1Host
$env:PI_HEC_FAEX1_USER = $Faex1User
$env:PI_HEC_FAEX1_PASSWORD = $Faex1Password
$env:PI_HEC_CLIENT_PKI = (Join-Path $hecHome "pki")

& $python -c @"
import os, posixpath
import paramiko
host = os.environ['PI_HEC_FAEX1_HOST']
user = os.environ['PI_HEC_FAEX1_USER']
password = os.environ['PI_HEC_FAEX1_PASSWORD']
dest = os.environ['PI_HEC_CLIENT_PKI']
client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(hostname=host, username=user, password=password, look_for_keys=False, allow_agent=False)
sftp = client.open_sftp()
os.makedirs(dest, exist_ok=True)
remote_dir = posixpath.join('/home', user, '.pi-hec', 'pki')
for name in [
    'ca.crt.pem',
    'admin.crt.pem',
    'admin.key.pem',
    'admin.sign.key.pem',
    'broker.crt.pem',
    'broker.key.pem',
    'broker.sign.key.pem',
    'pi-agent.crt.pem',
    'pi-agent.key.pem',
    'pi-agent.sign.key.pem',
]:
    sftp.get(posixpath.join(remote_dir, name), os.path.join(dest, name))
sftp.close()
client.close()
print('copied', dest)
"@

@"
PI_HEC_CONTROL_ENDPOINT=$ControlEndpoint
PI_HEC_SECURITY_MODE=production
PI_HEC_TLS_CA=$hecHome\pki\ca.crt.pem
PI_HEC_TLS_CERT=$hecHome\pki\pi-agent.crt.pem
PI_HEC_TLS_KEY=$hecHome\pki\pi-agent.key.pem
"@ | Set-Content -Path (Join-Path $hecHome "control.env") -Encoding ascii

$extPkg = Join-Path $RepoRoot "client\apps\pi-extension\package.json"
$pkg = Get-Content $extPkg -Raw | ConvertFrom-Json
if (-not $pkg.pi -or -not $pkg.pi.extensions) {
  throw "client/apps/pi-extension/package.json is missing pi.extensions"
}

$envFile = Join-Path $hecHome "control.env"
Get-Content $envFile | ForEach-Object {
  if ($_ -match "^(.*?)=(.*)$") {
    Set-Item -Path "Env:$($matches[1])" -Value $matches[2]
  }
}

$pi = Get-Command pi -ErrorAction SilentlyContinue
if ($pi) {
  & pi --version
}

& $python -c @"
import datetime
import http.client
import os
import ssl
from email.utils import parsedate_to_datetime

host = os.environ.get('PI_HEC_FAEX1_HOST', '10.10.10.184')
home = os.environ['USERPROFILE']
ca = os.path.join(home, '.pi-hec', 'pki', 'ca.crt.pem')
cert = os.path.join(home, '.pi-hec', 'pki', 'admin.crt.pem')
key = os.path.join(home, '.pi-hec', 'pki', 'admin.key.pem')
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
ctx.minimum_version = ssl.TLSVersion.TLSv1_3
ctx.load_verify_locations(ca)
ctx.load_cert_chain(cert, key)
ctx.check_hostname = False
conn = http.client.HTTPSConnection(host, 8443, context=ctx, timeout=15)
conn.request('GET', '/v1/projects/bootstrap-probe')
response = conn.getresponse()
body = response.read().decode('utf-8', 'replace')
date_header = response.getheader('Date')
conn.close()
if response.status not in (401, 404):
    raise SystemExit(f'unexpected control-plane status {response.status}: {body}')
if date_header is None:
    raise SystemExit('control-plane response missing Date header')
server = parsedate_to_datetime(date_header).astimezone(datetime.timezone.utc)
skew = abs((server - datetime.datetime.now(datetime.timezone.utc)).total_seconds())
if skew > 25:
    raise SystemExit(
        f'clock skew {skew:.0f}s versus FAEX1 (limit 30s); start Windows Time / NTP before mutations'
    )
print('tls', 'TLSv1.3', 'http', response.status, 'skew', int(skew))
"@

Write-Output "ok client bootstrap $ControlEndpoint"
