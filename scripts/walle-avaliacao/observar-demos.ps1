<#
Consumo de IA de HOJE nas demonstrações locais do Wall-e que NÃO usam o livro único (a original e a da rodada 2),
lido SÓ LEITURA no banco sintético de cada uma e registrado no livro como "observado" (vale a última leitura do dia).
Demonstração parada (porta livre) não consome agora; o que ela gastou hoje, se gastou, só entra quando estiver no ar.
A demonstração da fase B (55520) é do usuário e não é lida. A da rodada 4 usa o livro (cota) e não é observada aqui.

  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\walle-avaliacao\observar-demos.ps1
#>
$ErrorActionPreference = 'Stop'
$node = $env:DEMO_NODE
if (-not $node) { $node = 'C:\Users\Glass\AppData\Local\Temp\claude\D--glass-KidMais-Manager-kidmais-manager-ai-master\d4796071-ef3c-4c91-a3b8-c836972d8bb6\scratchpad\node22\node-v22.23.2-win-x64\node.exe' }
$psql = 'C:\Program Files\PostgreSQL\18\bin\psql.exe'
foreach ($n in @(Get-ChildItem Env: | Where-Object { $_.Name -eq 'DATABASE_URL' -or $_.Name -like 'PG*' } | Select-Object -ExpandProperty Name)) { Remove-Item "Env:$n" }
$livro = Join-Path $PSScriptRoot 'livro-uso-ia.mjs'
$dia = [TimeZoneInfo]::ConvertTimeBySystemTimeZoneId([DateTime]::UtcNow, 'E. South America Standard Time').ToString('yyyy-MM-dd')
$demos = @(@{ origem = 'demo-original-55524'; porta = 55524 }, @{ origem = 'demo-r2-55530'; porta = 55530 })
$abertas = "('ABERTA','USO_DESCONHECIDO','ORFA')"
$sql = "SET default_transaction_read_only = on; SELECT ((SELECT coalesce(sum(tokens_entrada + tokens_saida),0) FROM ia_uso_modelo WHERE periodo_dia = '$dia'::date AND tokens_entrada IS NOT NULL) + (SELECT coalesce(sum(tokens_reservados),0) FROM ia_orcamento_reservas WHERE periodo_dia = '$dia'::date AND estado IN $abertas))::text || '|' || ((SELECT coalesce(sum(custo_estimado_micros),0) FROM ia_uso_modelo WHERE periodo_dia = '$dia'::date) + (SELECT coalesce(sum(custo_reservado_micros),0) FROM ia_orcamento_reservas WHERE periodo_dia = '$dia'::date AND estado IN $abertas))::text || '|' || (SELECT count(*) FROM ia_uso_modelo WHERE periodo_dia = '$dia'::date)::text;"
foreach ($d in $demos) {
  if (-not (Get-NetTCPConnection -LocalPort $d.porta -State Listen -ErrorAction SilentlyContinue)) { Write-Host "  $($d.origem): parada (porta livre); nada lido."; continue }
  $r = & { $ErrorActionPreference = 'Continue'; & $psql -h 127.0.0.1 -p $d.porta -U kidmais_descartavel -d 'dbname=kidmais_pacotes_v1_descartavel connect_timeout=5' -X -At -c $sql 2>$null }
  $linha = @($r | Where-Object { "$_" -match '^\d+\|\d+\|\d+$' })[0]
  if ($LASTEXITCODE -ne 0 -or -not $linha) { Write-Host "  $($d.origem): NÃO LIDO (consulta recusada); não entra no total — não use o modo IA dela."; continue }
  $p = "$linha".Split('|'); $usd = [string]::Format([Globalization.CultureInfo]::InvariantCulture, '{0:0.######}', [double]$p[1] / 1e6)
  & $node $livro observar --origem $d.origem --tokens $p[0] --usd $usd --nota "lido só leitura em 127.0.0.1:$($d.porta) ($($p[2]) chamadas hoje)" | Out-Null
  Write-Host "  $($d.origem): $($p[0]) tokens, US$ $usd ($($p[2]) chamadas hoje) — registrado no livro."
}
