param([Parameter(Mandatory = $true)][string]$PdfOriginal)
$ErrorActionPreference = 'Stop'
$raizTeste = Split-Path $PSScriptRoot -Parent
$clusterTeste = Join-Path $raizTeste '.local-reenvio-pg-20261002'
$binTeste = 'C:/Program Files/PostgreSQL/18/bin'
if (Test-Path -LiteralPath $clusterTeste) { throw 'Exige diretório novo para cluster descartável.' }
& "$binTeste/initdb.exe" -D $clusterTeste -U postgres -A trust --encoding=UTF8 --locale=C
if ($LASTEXITCODE -ne 0) { throw 'initdb falhou' }
& "$binTeste/pg_ctl.exe" -D $clusterTeste -l "$clusterTeste/servidor.log" -o '-h 127.0.0.1 -p 55447' -w start
if ($LASTEXITCODE -ne 0) { throw 'Servidor descartável não iniciou' }
try {
  & "$binTeste/createdb.exe" -h 127.0.0.1 -p 55447 -U postgres kidmais_reenvio_descartavel
  if ($LASTEXITCODE -ne 0) { throw 'Criação do banco descartável falhou' }
  $env:KIDMAIS_TESTE_REENVIO = 'AUTORIZADO'
  Push-Location $raizTeste
  try {
    node --experimental-strip-types scripts/testar-reenvio-postgres.mjs $PdfOriginal
    if ($LASTEXITCODE -ne 0) { throw 'Teste do reenvio falhou' }
  } finally { Pop-Location }
} finally {
  Remove-Item Env:KIDMAIS_TESTE_REENVIO -ErrorAction SilentlyContinue
  & "$binTeste/pg_ctl.exe" -D $clusterTeste -m fast -w stop
}
