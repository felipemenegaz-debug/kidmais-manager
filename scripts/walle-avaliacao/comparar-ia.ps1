<#
Medição do Wall-e em modo IA REAL (avaliador v4), com uma única chave digitada em prompt oculto.

A chave vai só para o ambiente de cada processo filho (ambiente limpo, sem DATABASE_URL) e é descartada no fim; nunca
é impressa, gravada ou passada na linha de comando. Modelo, preços e teto: os já autorizados (gpt-6-luna, ECONOMY,
uma tentativa, sem troca de provedor, US$ 0,20 e 300 mil tokens por DIA). O teto vale para TUDO junto: antes de pedir a
chave, as demonstrações que não usam o livro são lidas (só leitura) e o LIVRO ÚNICO (livro-uso-ia.mjs, fora das
worktrees) mostra o que já foi gasto hoje, inclusive rodadas interrompidas e chamadas no ar. Cada chamada é reservada
e fechada no livro; rodada que não cabe inteira é recusada (rodar no dia seguinte). Rede: só https://api.openai.com/v1/.

Prioridade (a versão corrigida primeiro; comparações antigas só se sobrar teto): rodada 12 x holdout 12 (pedida pelo
usuário: a medição independente da rodada 12, com o código CONGELADO da worktree r12), rodada 27 x holdout 27 (a medição
desta rodada) e antes x holdout 8 (a comparação pendente desde 06/10). As rodadas 9 a 11 não foram medidas em IA real
(sem saldo em 06/10);
as da rodada 8 (holdouts 8, 7 e 4) já foram medidas e não se repetem. Com 300 mil tokens por dia cabem 3 rodadas.
Rodada já medida (resultado em resultados\v4\) é pulada. No fim gera resultados\v4\comparacao.md.

  powershell -ExecutionPolicy Bypass -File scripts\walle-avaliacao\comparar-ia.ps1            (IA real; pede a chave)
  powershell -ExecutionPolicy Bypass -File scripts\walle-avaliacao\comparar-ia.ps1 -Simular   (ensaio sem rede e sem chave)
#>
param([switch]$Simular)
$ErrorActionPreference = 'Stop'
# Saída do node em UTF-8 (sem isso o PowerShell 5.1 mostra "instru├º├úo" no console).
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$raiz = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
# Versão "antes" (c5a2f9a) num checkout só de avaliação: a worktree antiga foi removida em 06/10.
$antes = 'C:\Users\Glass\.codex\worktrees\0997\kidmais-wall-e-medir-antes'
$node = $env:DEMO_NODE
if (-not $node) { $node = 'C:\Users\Glass\AppData\Local\Temp\claude\D--glass-KidMais-Manager-kidmais-manager-ai-master\d4796071-ef3c-4c91-a3b8-c836972d8bb6\scratchpad\node22\node-v22.23.2-win-x64\node.exe' }
if (-not (Test-Path -LiteralPath $node)) { throw "Node 22 não encontrado em $node (defina DEMO_NODE)." }
$h7 = 'scripts/walle-avaliacao/corpus-holdout-7-20261005.json'
$h8 = 'scripts/walle-avaliacao/corpus-holdout-8-20261005.json'
$h9 = 'scripts/walle-avaliacao/corpus-holdout-9-20261006.json'
$h10 = 'scripts/walle-avaliacao/corpus-holdout-10-20261006.json'
$h11 = 'scripts/walle-avaliacao/corpus-holdout-11-20261006.json'
$h12 = 'scripts/walle-avaliacao/corpus-holdout-12-20261006.json'
$h27 = 'scripts/walle-avaliacao/corpus-holdout-27-20261007.json'
# Rodada 12 congelada (a3d6f6a) na worktree dela; a medição do holdout 12 é dessa versão, não da 27.
$r12 = 'C:\Users\Glass\.codex\worktrees\0997\kidmais-wall-e-r12'
if (-not (Test-Path -LiteralPath (Join-Path $raiz $h27))) { throw "Holdout 27 não encontrado ($h27)." }
$rodadas = @(
  @{ rotulo = 'rodada 12 x holdout 12'; args = "--corpus $h12 --codigo `"$r12`" --versao r12"; saida = 'r12-holdout12'; codigo = $r12 },
  @{ rotulo = 'rodada 27 x holdout 27'; args = "--corpus $h27 --versao r27"; saida = 'r27-holdout27' },
  @{ rotulo = 'antes x holdout 8'; args = "--corpus $h8 --codigo `"$antes`" --versao antes"; saida = 'antes-holdout8'; codigo = $antes }
)
# Código de outra versão conferido ANTES de pedir a chave (em 06/10 a rodada "antes" só falhou depois de três pagas).
foreach ($r in $rodadas) { if ($r.codigo -and -not (Test-Path -LiteralPath (Join-Path $r.codigo 'lib\whatsapp\atendimento\walle\entendimento.ts'))) { throw "Código da rodada '$($r.rotulo)' não encontrado em $($r.codigo)." } }

Write-Host "Medição do Wall-e em modo IA $(if ($Simular) { 'SIMULADO (provedor falso local; sem rede, sem chave)' } else { 'REAL' })"
Write-Host '  Rodadas, nesta ordem: rodada 12 x holdout 12, rodada 27 x holdout 27, antes x holdout 8 (80 cada)'
Write-Host '  Modelo: OpenAI gpt-6-luna (ECONOMY, reasoning none), timeout 15 s, sem fallback; uma chamada por mensagem'
Write-Host '  Teto: US$ 0,20 e 300.000 tokens por dia para TUDO (avaliadores e demonstrações), pelo livro único'
Write-Host '  Estimativa: ~80 mil tokens e ~US$ 0,005 por rodada (a rodada só começa se 98 mil tokens couberem); 2-3 min cada'
Write-Host '  Ctrl+C interrompe; o que já foi gasto (e a chamada no ar, pelo máximo) fica no livro.'
Write-Host '  Rede: só https://api.openai.com/v1/. Banco: nenhum (as demonstrações são só lidas). Nada é enviado a cliente.'
if (-not $Simular) {
  Write-Host "`nConsumo de hoje (antes de pedir a chave):"
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'observar-demos.ps1')
  & $node (Join-Path $PSScriptRoot 'livro-uso-ia.mjs') estado | ForEach-Object { Write-Host "  $_" }
  # Rodada 10: sem saldo para ao menos UMA rodada pendente inteira (98 mil tokens), a chave nem é pedida.
  $pendentes = @($rodadas | Where-Object { -not (Test-Path -LiteralPath (Join-Path $PSScriptRoot "resultados\v4\$($_.saida)-ia.json")) })
  if (-not $pendentes.Count) { Write-Host 'Todas as rodadas já foram medidas: nada a fazer, nenhuma chave pedida.'; return }
  & $node (Join-Path $PSScriptRoot 'livro-uso-ia.mjs') conferir --tokens 98000
  if ($LASTEXITCODE -ne 0) { throw 'Sem saldo no livro único para uma rodada (98 mil tokens): a chave não é pedida e nenhuma chamada é feita. Rode no dia seguinte.' }
}

$seguro = $null
if (-not $Simular) {
  $seguro = Read-Host -AsSecureString 'Chave da API OpenAI (mascarada; Enter vazio cancela)'
  if (-not $seguro -or $seguro.Length -lt 20) { if ($seguro) { $seguro.Dispose() }; throw 'Chave não informada: medição cancelada. Nenhuma chamada foi feita.' }
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
    $p = $null
    if ($seguro) {
      $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($seguro)
      try {
        try { $psi.EnvironmentVariables['OPENAI_API_KEY'] = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr).Trim() } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
        $p = [System.Diagnostics.Process]::Start($psi)
      } finally { $psi.EnvironmentVariables.Remove('OPENAI_API_KEY') }
    } else { $p = [System.Diagnostics.Process]::Start($psi) }
    # Resultado completo fica em resultados\v4\; aqui só o resumo das falhas críticas.
    $saida = $p.StandardOutput.ReadToEnd()
    $p.WaitForExit()
    if ($p.ExitCode -eq 3) { Write-Host '  Não coube no teto de hoje: rodada não executada (rode amanhã).'; continue }
    if ($p.ExitCode -ne 0) { throw "Rodada '$($r.rotulo)' terminou com código $($p.ExitCode)." }
    ($saida -split "`n") | Where-Object { $_ -match '^\| (Pedido|Mensagem|Bloqueio|Alergia|Festa|Reserva|Reclama|Pagamento|Instru|Negocia|Pergunta sem)' -or $_ -match '^\*\*\d+/\d+\*\* mensagens comerciais' -or $_ -match '^Reconhecidas:' -or $_ -match '^Modelo:' } | ForEach-Object { Write-Host "  $_" }
  }
} finally { if ($seguro) { $seguro.Dispose(); $seguro = $null } }
if (-not $Simular) { & $node (Join-Path $PSScriptRoot 'livro-uso-ia.mjs') estado | ForEach-Object { Write-Host "  $_" } }
& $node (Join-Path $PSScriptRoot 'comparar.mjs') | Out-Null
Write-Host "`nComparação: $(Join-Path $PSScriptRoot 'resultados\v4\comparacao.md')"
