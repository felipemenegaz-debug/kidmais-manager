param([switch]$Executar, [switch]$Incluir074)
$ErrorActionPreference = 'Stop'
$raizConvites = Split-Path $PSScriptRoot -Parent
$binConvites = 'C:/Program Files/PostgreSQL/18/bin'
$portaConvites = 55458
$bancoConvites = 'kidmais_convites_v1_teste'
if (-not $Executar -or -not $Incluir074) {
  Write-Output "PREPARADO, NAO EXECUTADO: migrations 073 e 074 em PostgreSQL 18 novo em 127.0.0.1:$portaConvites, banco $bancoConvites, apenas dados sinteticos. Exige autorizacao explicita para a 074 antes de usar -Executar -Incluir074."
  exit 0
}
# Não lê .env, não usa DATABASE_URL e não reaproveita nenhum cluster existente.
# libpq também aceita PGSERVICE/PGHOSTADDR. Recusa herança para não redirecionar createdb.
if (Get-ChildItem Env:PG* -ErrorAction SilentlyContinue) { throw 'Execute em processo sem variáveis PG*: conexão libpq deve usar apenas o alvo sintético explícito.' }
$clusterConvites = Join-Path $raizConvites ('.local-convites-pg-073-' + [guid]::NewGuid().ToString('N'))
if (Test-Path -LiteralPath $clusterConvites) { throw 'O diretório deve ser novo.' }
if (Get-NetTCPConnection -LocalPort $portaConvites -State Listen -ErrorAction SilentlyContinue) { throw 'Porta ocupada; nenhum servidor existente será acessado.' }
& "$binConvites/initdb.exe" -D $clusterConvites -U convites_teste -A trust --encoding=UTF8 --locale=C
if ($LASTEXITCODE -ne 0) { throw 'initdb falhou.' }
# No Windows, postgres pode herdar o pipe do PowerShell e bloquear a próxima linha
# mesmo depois de pg_ctl terminar. Aguarda só pg_ctl, com saída em arquivos próprios.
$inicioConvites = Start-Process -FilePath "$binConvites/pg_ctl.exe" -ArgumentList @('-D', ('"' + $clusterConvites + '"'), '-l', ('"' + "$clusterConvites/servidor.log" + '"'), '-o', ('"' + "-h 127.0.0.1 -p $portaConvites" + '"'), '-w', 'start') -PassThru -WindowStyle Hidden -RedirectStandardOutput "$clusterConvites/inicio.out" -RedirectStandardError "$clusterConvites/inicio.err"
if (-not $inicioConvites.WaitForExit(30000) -or $inicioConvites.ExitCode -ne 0) { throw 'O servidor descartável não iniciou; verificar logs do cluster.' }
try {
  & "$binConvites/createdb.exe" -h 127.0.0.1 -p $portaConvites -U convites_teste --no-password $bancoConvites
  if ($LASTEXITCODE -ne 0) { throw 'Criação do banco descartável falhou.' }
  Push-Location $raizConvites
  try {
    node scripts/convites-postgres.cjs --executar-autorizado $clusterConvites --incluir-074-autorizado
    if ($LASTEXITCODE -ne 0) { throw 'Validação de convites falhou; evidências preservadas no cluster.' }
  } finally { Pop-Location }
} finally {
  & "$binConvites/pg_ctl.exe" -D $clusterConvites -m fast -w stop
  if ($LASTEXITCODE -ne 0) { Write-Warning "Verificar parada do cluster descartável: $clusterConvites" }
  Write-Output "Cluster de teste preservado e destinado somente a esta validação: $clusterConvites"
}
