<#
Avaliação da CANDIDATA de integração (whatsapp/candidata-walle-20261007) em modo IA REAL, com uma única chave digitada
em prompt oculto. Mesmo avaliador v4 e mesmas travas do comparar-ia.ps1 da rodada 27 (que fica intocado):

- a chave vai só para o ambiente de cada processo filho (ambiente limpo, sem DATABASE_URL) e é descartada no fim; nunca
  é impressa, gravada ou passada na linha de comando;
- modelo, preços e teto já autorizados (gpt-6-luna, ECONOMY, uma tentativa, sem troca de provedor; US$ 0,20 e 300 mil
  tokens por DIA para TUDO — avaliadores e demonstrações), pelo LIVRO ÚNICO (livro-uso-ia.mjs, fora das worktrees);
- antes de pedir a chave: retrato das demonstrações que não usam o livro, estado do livro e conferência de saldo para
  uma rodada inteira (98 mil tokens); sem saldo, a chave nem é pedida e nada é chamado;
- cada chamada é reservada e fechada no livro; rodada que não cabe inteira é recusada (rodar no dia seguinte);
- rede: só https://api.openai.com/v1/. Banco: nenhum. Nada é enviado a cliente.

Rodadas (o código é o desta worktree): holdout 28 (o conjunto independente das últimas correções), holdout 27 e
holdout 26. Cada rodada só começa se 98 mil tokens couberem no livro; as três (~264 mil) cabem num dia sem outro gasto. Ensaio -Simular em 07/10 (050cdb0+): ~88 mil tokens e ~US$ 0,011 por rodada; as duas,
~176 mil tokens e ~US$ 0,021 (cabem no teto do dia se nada mais tiver sido gasto). 2-3 min cada.
Os resultados levam o SHA curto no nome (resultados\v4\cand-<sha>-holdoutNN-ia.*) e o SHA completo dentro (git.sha); o
avaliador recusa árvore com alterações rastreadas e HEAD diferente do conferido aqui. Rodada já medida NESTE SHA é pulada.
Vale na candidata local e na branch de entrega enxuta (mesmo código de produto).

  powershell -ExecutionPolicy Bypass -File scripts\walle-avaliacao\avaliar-candidata-ia.ps1            (IA real; pede a chave)
  powershell -ExecutionPolicy Bypass -File scripts\walle-avaliacao\avaliar-candidata-ia.ps1 -Simular   (ensaio sem rede e sem chave)
#>
param([switch]$Simular)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$raiz = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$node = $env:DEMO_NODE
if (-not $node) { $node = 'C:\Users\Glass\AppData\Local\Temp\claude\D--glass-KidMais-Manager-kidmais-manager-ai-master\d4796071-ef3c-4c91-a3b8-c836972d8bb6\scratchpad\node22\node-v22.23.2-win-x64\node.exe' }
if (-not (Test-Path -LiteralPath $node)) { throw "Node 22 não encontrado em $node (defina DEMO_NODE)." }
# A avaliação é da candidata: branch e árvore conferidas antes de qualquer chave.
$branch = "$(git -C $raiz rev-parse --abbrev-ref HEAD)".Trim()
if ($branch -notin @('whatsapp/candidata-walle-20261007', 'whatsapp/entrega-walle-20261007')) { throw "PARAR: branch $branch (esperada whatsapp/candidata-walle-20261007 ou whatsapp/entrega-walle-20261007)." }
$sha = "$(git -C $raiz rev-parse HEAD)".Trim()
$curto = $sha.Substring(0, 7)
$alterados = @(git -C $raiz status --porcelain --untracked-files=no | ForEach-Object { $_.Substring(3) } | Where-Object { $_ -notin @('next-env.d.ts', 'tsconfig.json') })
if ($alterados.Count -and -not $Simular) { throw "PARAR: alterações não commitadas ($($alterados -join ', ')); o resultado precisa de SHA exato." }
$h26 = 'scripts/walle-avaliacao/corpus-holdout-26-20261007.json'
$h27 = 'scripts/walle-avaliacao/corpus-holdout-27-20261007.json'
$h28 = 'scripts/walle-avaliacao/corpus-holdout-28-20261007.json'
foreach ($h in $h26, $h27, $h28) { if (-not (Test-Path -LiteralPath (Join-Path $raiz $h))) { throw "Holdout não encontrado ($h)." } }
$rodadas = @(
  @{ rotulo = 'candidata x holdout 28'; args = "--corpus $h28 --versao cand-$curto --sha-exigido $sha"; saida = "cand-$curto-holdout28" },
  @{ rotulo = 'candidata x holdout 27'; args = "--corpus $h27 --versao cand-$curto --sha-exigido $sha"; saida = "cand-$curto-holdout27" },
  @{ rotulo = 'candidata x holdout 26'; args = "--corpus $h26 --versao cand-$curto --sha-exigido $sha"; saida = "cand-$curto-holdout26" }
)
Write-Host "Avaliação da candidata em modo IA $(if ($Simular) { 'SIMULADO (provedor falso local; sem rede, sem chave)' } else { 'REAL' })"
Write-Host "  Código: $raiz ($branch, SHA $sha)"
Write-Host '  Rodadas, nesta ordem: holdout 28, holdout 27, holdout 26 (80 cada)'
Write-Host '  Modelo: OpenAI gpt-6-luna (ECONOMY, reasoning none), timeout 15 s, sem fallback; uma chamada por mensagem'
Write-Host '  Teto: US$ 0,20 e 300.000 tokens por dia para TUDO (avaliadores e demonstrações), pelo livro único'
Write-Host '  Estimativa (ensaio): ~88 mil tokens e ~US$ 0,011 por rodada; ~176 mil e ~US$ 0,021 as duas (a rodada só começa se 98 mil tokens couberem)'
Write-Host '  Ctrl+C interrompe; o que já foi gasto (e a chamada no ar, pelo máximo) fica no livro.'
Write-Host '  Rede: só https://api.openai.com/v1/. Banco: nenhum. Nada é enviado a cliente.'
if (-not $Simular) {
  Write-Host "`nConsumo de hoje (antes de pedir a chave):"
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'observar-demos.ps1')
  & $node (Join-Path $PSScriptRoot 'livro-uso-ia.mjs') estado | ForEach-Object { Write-Host "  $_" }
  $pendentes = @($rodadas | Where-Object { -not (Test-Path -LiteralPath (Join-Path $PSScriptRoot "resultados\v4\$($_.saida)-ia.json")) })
  if (-not $pendentes.Count) { Write-Host 'Todas as rodadas já foram medidas: nada a fazer, nenhuma chave pedida.'; return }
  & $node (Join-Path $PSScriptRoot 'livro-uso-ia.mjs') conferir --tokens 98000
  if ($LASTEXITCODE -ne 0) { throw 'Sem saldo no livro único para uma rodada (98 mil tokens): a chave não é pedida e nenhuma chamada é feita. Rode no dia seguinte.' }
}
$seguro = $null
if (-not $Simular) {
  $seguro = Read-Host -AsSecureString 'Chave da API OpenAI (mascarada; Enter vazio cancela)'
  if (-not $seguro -or $seguro.Length -lt 20) { if ($seguro) { $seguro.Dispose() }; throw 'Chave não informada: avaliação cancelada. Nenhuma chamada foi feita.' }
}
try {
  foreach ($r in $rodadas) {
    Write-Host "`n=== $($r.rotulo) ==="
    if (-not $Simular -and (Test-Path -LiteralPath (Join-Path $PSScriptRoot "resultados\v4\$($r.saida)-ia.json"))) { Write-Host '  Já medida: pulada (resultados\v4).'; continue }
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $node
    $psi.Arguments = "--experimental-strip-types --no-warnings --import ./scripts/walle-avaliacao/registrar.mjs scripts/walle-avaliacao/avaliar.mjs ia $($r.args)" + $(if ($Simular) { ' --simular' } else { '' })
    $psi.WorkingDirectory = $raiz
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.EnvironmentVariables.Clear()
    foreach ($n in 'SystemRoot', 'SystemDrive', 'windir', 'TEMP', 'TMP', 'USERPROFILE') { $v = [Environment]::GetEnvironmentVariable($n); if ($v) { $psi.EnvironmentVariables[$n] = $v } }
    # Só o diretório do git no PATH do filho: o avaliador lê o SHA do código (sem git, recusa a rodada).
    $psi.EnvironmentVariables['PATH'] = Split-Path -Parent (Get-Command git -ErrorAction Stop).Source
    $p = $null
    if ($seguro) {
      $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($seguro)
      try {
        try { $psi.EnvironmentVariables['OPENAI_API_KEY'] = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr).Trim() } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
        $p = [System.Diagnostics.Process]::Start($psi)
      } finally { $psi.EnvironmentVariables.Remove('OPENAI_API_KEY') }
    } else { $p = [System.Diagnostics.Process]::Start($psi) }
    $saida = $p.StandardOutput.ReadToEnd()
    $p.WaitForExit()
    if ($p.ExitCode -eq 3) { Write-Host '  Não coube no teto de hoje: rodada não executada (rode amanhã).'; continue }
    if ($p.ExitCode -ne 0) { throw "Rodada '$($r.rotulo)' terminou com código $($p.ExitCode)." }
    ($saida -split "`n") | Where-Object { $_ -match '^\| (Pedido|Mensagem|Bloqueio|Alergia|Festa|Reserva|Reclama|Pagamento|Instru|Negocia|Pergunta sem|Data|Mês|Fonte|Informa|Alteração)' -or $_ -match '^\*\*\d+/\d+\*\* mensagens comerciais' -or $_ -match '^Reconhecidas:' -or $_ -match '^Modelo:' } | ForEach-Object { Write-Host "  $_" }
  }
} finally { if ($seguro) { $seguro.Dispose(); $seguro = $null } }
if (-not $Simular) { & $node (Join-Path $PSScriptRoot 'livro-uso-ia.mjs') estado | ForEach-Object { Write-Host "  $_" } }
Write-Host "`nResultados: $(Join-Path $PSScriptRoot 'resultados\v4\') (cand-$curto-holdout28-ia, -holdout27-ia e -holdout26-ia; SHA $sha)"
