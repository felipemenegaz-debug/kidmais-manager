param([switch]$Executar, [switch]$Incluir074, [switch]$Incluir079, [switch]$Incluir084)
$ErrorActionPreference = 'Stop'
$raizConvites = Split-Path $PSScriptRoot -Parent
$binConvites = 'C:/Program Files/PostgreSQL/18/bin'
$portaConvites = 55458
$bancoConvites = 'kidmais_convites_v1_teste'
if (-not $Executar -or -not $Incluir074 -or -not $Incluir079 -or -not $Incluir084) {
  Write-Output "PREPARADO, NAO EXECUTADO: migrations 073, 074, 079 e 084 em PostgreSQL 18 novo em 127.0.0.1:$portaConvites, banco $bancoConvites, apenas dados sinteticos. Exige autorizacao explicita para todas antes de usar -Executar -Incluir074 -Incluir079 -Incluir084."
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
try {
  $clusterNomeConvites = 'kidmais_convites_' + [guid]::NewGuid().ToString('N')
  $opcoesServidorConvites = "-h 127.0.0.1 -p $portaConvites -c cluster_name=$clusterNomeConvites"
  $inicioConvites = Start-Process -FilePath "$binConvites/pg_ctl.exe" -ArgumentList @('-D', ('"' + $clusterConvites + '"'), '-l', ('"' + "$clusterConvites/servidor.log" + '"'), '-o', ('"' + $opcoesServidorConvites + '"'), '-w', 'start') -PassThru -WindowStyle Hidden -RedirectStandardOutput "$clusterConvites/inicio.out" -RedirectStandardError "$clusterConvites/inicio.err"
  $servidorProntoConvites = $false
  for ($tentativaConvites = 0; $tentativaConvites -lt 120; $tentativaConvites++) {
    & "$binConvites/pg_isready.exe" -h 127.0.0.1 -p $portaConvites -U convites_teste -d postgres *> $null
    if ($LASTEXITCODE -eq 0) { $servidorProntoConvites = $true; break }
    Start-Sleep -Milliseconds 250
  }
  if (-not $servidorProntoConvites) { throw 'O servidor descartável não iniciou; verificar logs do cluster.' }
  & "$binConvites/pg_ctl.exe" status -D $clusterConvites *> $null
  if ($LASTEXITCODE -ne 0) { throw 'pg_ctl não confirma servidor iniciado neste cluster.' }
  $identidadeConvites = & "$binConvites/psql.exe" -X -h 127.0.0.1 -p $portaConvites -U convites_teste -d postgres -At -F '|' -c "SELECT current_database(),current_user,inet_server_addr()::text,inet_server_port(),current_setting('cluster_name'),current_setting('data_directory')"
  if ($LASTEXITCODE -ne 0) { throw 'Não foi possível identificar o cluster antes da criação do banco.' }
  $identidadePartesConvites = ($identidadeConvites -join '').Split('|')
  if ($identidadePartesConvites.Count -ne 6) { throw ('Identidade PostgreSQL inesperada antes da criação do banco: ' + ($identidadeConvites -join ' ')) }
  $diretorioRealConvites = [IO.Path]::GetFullPath($identidadePartesConvites[5]).Replace('\','/').TrimEnd('/').ToLowerInvariant()
  $diretorioEsperadoConvites = [IO.Path]::GetFullPath($clusterConvites).Replace('\','/').TrimEnd('/').ToLowerInvariant()
  if ($identidadePartesConvites.Count -ne 6 -or $identidadePartesConvites[0] -ne 'postgres' -or $identidadePartesConvites[1] -ne 'convites_teste' -or $identidadePartesConvites[2] -notmatch '^127\.0\.0\.1(?:/32)?$' -or [int]$identidadePartesConvites[3] -ne $portaConvites -or $identidadePartesConvites[4] -ne $clusterNomeConvites -or $diretorioRealConvites -ne $diretorioEsperadoConvites) {
    throw ('Identidade do cluster descartável não corresponde; nenhum banco foi criado. Dados observados (sem segredos): ' + ($identidadeConvites -join ' '))
  }
  & "$binConvites/createdb.exe" -h 127.0.0.1 -p $portaConvites -U convites_teste --no-password $bancoConvites
  if ($LASTEXITCODE -ne 0) { throw 'Criação do banco descartável falhou.' }
  Push-Location $raizConvites
  try {
    node scripts/convites-postgres.cjs --executar-autorizado $clusterConvites --incluir-074-autorizado --incluir-079-autorizado --incluir-084-autorizado
    if ($LASTEXITCODE -ne 0) { throw 'Validação de convites falhou; evidências preservadas no cluster.' }
  } finally { Pop-Location }
} finally {
  & "$binConvites/pg_ctl.exe" -D $clusterConvites -m fast -w stop
  if ($LASTEXITCODE -ne 0) { Write-Warning "Verificar parada do cluster descartável: $clusterConvites" }
  Write-Output "Cluster de teste preservado e destinado somente a esta validação: $clusterConvites"
}
