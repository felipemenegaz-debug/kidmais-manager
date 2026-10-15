<#
Avaliação da r29 CONGELADA (whatsapp/wall-e-correcoes-r29, bc1eabe = código 5951b37 + lacres e docs) em modo IA
REAL nos holdouts 30, 29 e 28, com uma única chave digitada em prompt oculto. O código, o avaliador e os holdouts são
os da worktree da r29 (caminhos absolutos abaixo); este script só orquestra e nada grava fora de
kidmais-wall-e-r29\scripts\walle-avaliacao\resultados\v4\ (pasta ignorada pelo Git: a árvore da r29 continua limpa).

Antes de pedir a chave (nada é chamado se algo falhar):
- worktree, branch e SHA exatos da r29; árvore sem alterações rastreadas;
- sha256 dos três holdouts lacrados (conteúdo do Git no SHA) e avaliador com --sha-exigido;
- Node 22 no caminho absoluto;
- rodadas já medidas NESTE SHA são puladas (r29-bc1eabe-holdoutNN-ia.json com git.sha igual);
- retrato das demonstrações que não usam o livro, estado do livro e SALDO AGREGADO: só roda as rodadas pendentes que
  cabem inteiras no saldo do dia (98 mil tokens cada; teto único de 300 mil tokens e US$ 0,20 para avaliadores e demos).
Durante: cada chamada é reservada e fechada no livro; a chave vai só para o ambiente do processo filho (ambiente limpo,
sem DATABASE_URL; PATH só com o diretório do git); rede só https://api.openai.com/v1/; nenhum banco; nada a cliente.
Depois: a comparação regras × IA por categoria, com respostas completas e fontes (comparar-regras-ia.mjs, sem custo).

Ensaio -Simular (sem rede, sem chave, nada no livro) grava -ia-simulado e a comparação simulada.

  powershell -ExecutionPolicy Bypass -File C:\Users\Glass\.codex\worktrees\0997\kidmais-wall-e-r30\scripts\walle-avaliacao\avaliar-r29-ia.ps1
  powershell -ExecutionPolicy Bypass -File C:\Users\Glass\.codex\worktrees\0997\kidmais-wall-e-r30\scripts\walle-avaliacao\avaliar-r29-ia.ps1 -Simular
#>
param([switch]$Simular)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$R29 = 'C:\Users\Glass\.codex\worktrees\0997\kidmais-wall-e-r29'
$BRANCH = 'whatsapp/wall-e-correcoes-r29'
$SHA = 'bc1eabe6a953c80476b8329175ea264d160a960e'
$VERSAO = 'r29-bc1eabe'
$NODE = 'C:\Users\Glass\AppData\Local\Temp\claude\D--glass-KidMais-Manager-kidmais-manager-ai-master\d4796071-ef3c-4c91-a3b8-c836972d8bb6\scratchpad\node22\node-v22.23.2-win-x64\node.exe'
$AVAL = Join-Path $R29 'scripts\walle-avaliacao'
$RES = Join-Path $AVAL 'resultados\v4'
$COMPARAR = Join-Path $PSScriptRoot 'comparar-regras-ia.mjs'
$TOKENS_RODADA = 98000
# Holdouts lacrados (sha256 do conteúdo no Git, conferido no lacre), na ordem de medição: o mais independente primeiro.
$HOLDOUTS = @(
  @{ n = '30'; arquivo = 'scripts/walle-avaliacao/corpus-holdout-30-20261007.json'; sha256 = 'a63cf6bce6e5e2de8dc62780c42b74b5f3aee0bcc9f2686dab06fca33dc05420' },
  @{ n = '29'; arquivo = 'scripts/walle-avaliacao/corpus-holdout-29-20261007.json'; sha256 = '29b6a96bca135634343a068ad52b87f53909db7c48ccfaeb93a299bc774d2d2a' },
  @{ n = '28'; arquivo = 'scripts/walle-avaliacao/corpus-holdout-28-20261007.json'; sha256 = '9fc26d59cd41ed6842e10960d51c613601b09444a23208a50e71c134231e6c2d' }
)

Write-Host "Avaliação da r29 congelada em modo IA $(if ($Simular) { 'SIMULADO (provedor falso local; sem rede, sem chave, nada no livro)' } else { 'REAL' })"
# ---------------------------------------------------------------- conferências (antes de qualquer chave)
foreach ($p in $R29, $NODE, $AVAL, $COMPARAR) { if (-not (Test-Path -LiteralPath $p)) { throw "PARAR: não encontrado: $p" } }
$versaoNode = (& $NODE --version).Trim()
if ($versaoNode -notmatch '^v22\.') { throw "PARAR: Node $versaoNode (esperado v22)." }
$branch = "$(git -C $R29 rev-parse --abbrev-ref HEAD)".Trim()
$head = "$(git -C $R29 rev-parse HEAD)".Trim()
if ($branch -ne $BRANCH) { throw "PARAR: a worktree da r29 está na branch $branch (esperada $BRANCH)." }
if ($head -ne $SHA) { throw "PARAR: HEAD da r29 é $head (esperado $SHA, a r29 congelada)." }
$alterados = @(git -C $R29 status --porcelain --untracked-files=no | ForEach-Object { $_.Substring(3) } | Where-Object { $_ -notin @('next-env.d.ts', 'tsconfig.json') })
if ($alterados.Count) { throw "PARAR: alterações não commitadas na r29 ($($alterados -join ', '))." }
if (-not (Select-String -LiteralPath (Join-Path $AVAL 'avaliar.mjs') -Pattern "--sha-exigido" -SimpleMatch -Quiet)) { throw 'PARAR: avaliar.mjs da r29 sem --sha-exigido.' }
foreach ($h in $HOLDOUTS) {
  $calc = (& $NODE -e "const c=require('child_process').execFileSync('git',['-C',process.argv[1],'cat-file','blob','HEAD:'+process.argv[2]]);process.stdout.write(require('crypto').createHash('sha256').update(c).digest('hex'))" $R29 $h.arquivo).Trim()
  if ($calc -ne $h.sha256) { throw "PARAR: holdout $($h.n) com sha256 $calc (esperado $($h.sha256))." }
}
Write-Host "  r29: $R29 ($branch, $head), árvore limpa; Node $versaoNode; holdouts 30/29/28 conferidos (sha256)."
Write-Host '  Modelo: OpenAI gpt-6-luna (ECONOMY, reasoning none), timeout 15 s, sem fallback; uma chamada por mensagem.'
Write-Host '  Teto: US$ 0,20 e 300.000 tokens por dia para TUDO (avaliadores e demonstrações), pelo livro único.'
Write-Host "  Estimativa: ~85 mil tokens e ~US$ 0,011 por rodada; $TOKENS_RODADA tokens reservados por rodada para começar."
$sufixo = if ($Simular) { '-ia-simulado' } else { '-ia' }
$medida = { param($n) $f = Join-Path $RES "$VERSAO-holdout$n$sufixo.json"; if (-not (Test-Path -LiteralPath $f)) { return $false }; try { return ((Get-Content -LiteralPath $f -Raw -Encoding UTF8 | ConvertFrom-Json).git.sha -eq $SHA) } catch { return $false } }
$pendentes = @($HOLDOUTS | Where-Object { -not (& $medida $_.n) })
foreach ($h in $HOLDOUTS) { if (-not ($pendentes -contains $h)) { Write-Host "  holdout $($h.n): já medido neste SHA (pulado)." } }
# Resultados em regras no mesmo SHA (a comparação precisa deles; não custam nada).
foreach ($h in $HOLDOUTS) {
  if (-not (Test-Path -LiteralPath (Join-Path $RES "$VERSAO-holdout$($h.n)-regras.json"))) {
    Write-Host "  holdout $($h.n): medindo em regras neste SHA (sem custo)."
    Push-Location $R29
    try { & $NODE --experimental-strip-types --no-warnings --import ./scripts/walle-avaliacao/registrar.mjs scripts/walle-avaliacao/avaliar.mjs regras --corpus $h.arquivo --versao $VERSAO --sha-exigido $SHA | Out-Null; if ($LASTEXITCODE -ne 0) { throw "regras do holdout $($h.n) falharam" } } finally { Pop-Location }
  }
}
if (-not $pendentes.Count) { Write-Host 'Todas as rodadas já foram medidas neste SHA: nenhuma chave pedida.' }
else {
  if (-not $Simular) {
    Write-Host "`nConsumo de hoje (antes de pedir a chave):"
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $AVAL 'observar-demos.ps1')
    & $NODE (Join-Path $AVAL 'livro-uso-ia.mjs') estado | ForEach-Object { Write-Host "  $_" }
    # Saldo agregado: só as rodadas pendentes que cabem inteiras no saldo do dia, na ordem 30, 29, 28.
    $cabem = 0
    for ($k = $pendentes.Count; $k -ge 1; $k--) { & $NODE (Join-Path $AVAL 'livro-uso-ia.mjs') conferir --tokens ($TOKENS_RODADA * $k) *> $null; if ($LASTEXITCODE -eq 0) { $cabem = $k; break } }
    if (-not $cabem) { throw "Sem saldo no livro único para uma rodada ($TOKENS_RODADA tokens): a chave não é pedida e nenhuma chamada é feita. Rode no dia seguinte." }
    if ($cabem -lt $pendentes.Count) { Write-Host "  Saldo para $cabem de $($pendentes.Count) rodadas pendentes: as demais ficam para outro dia." }
    $pendentes = @($pendentes | Select-Object -First $cabem)
  }
  Write-Host "  Rodadas desta execução: $(($pendentes | ForEach-Object { 'holdout ' + $_.n }) -join ', ')"
  $seguro = $null
  if (-not $Simular) {
    $seguro = Read-Host -AsSecureString 'Chave da API OpenAI (mascarada; Enter vazio cancela)'
    if (-not $seguro -or $seguro.Length -lt 20) { if ($seguro) { $seguro.Dispose() }; throw 'Chave não informada: avaliação cancelada. Nenhuma chamada foi feita.' }
  }
  try {
    foreach ($h in $pendentes) {
      Write-Host "`n=== r29 x holdout $($h.n) ==="
      $psi = New-Object System.Diagnostics.ProcessStartInfo
      $psi.FileName = $NODE
      $psi.Arguments = "--experimental-strip-types --no-warnings --import ./scripts/walle-avaliacao/registrar.mjs scripts/walle-avaliacao/avaliar.mjs ia --corpus $($h.arquivo) --versao $VERSAO --sha-exigido $SHA" + $(if ($Simular) { ' --simular' } else { '' })
      $psi.WorkingDirectory = $R29
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
      if ($p.ExitCode -ne 0) { throw "Rodada do holdout $($h.n) terminou com código $($p.ExitCode)." }
      ($saida -split "`n") | Where-Object { $_ -match '^\| .+\| \*\*[1-9]' -or $_ -match '^\*\*\d+/\d+\*\* mensagens comerciais' -or $_ -match '^Modelo:' -or $_ -match '^Código:' } | ForEach-Object { Write-Host "  $_" }
    }
  } finally { if ($seguro) { $seguro.Dispose(); $seguro = $null } }
  if (-not $Simular) { & $NODE (Join-Path $AVAL 'livro-uso-ia.mjs') estado | ForEach-Object { Write-Host "  $_" } }
}
# ---------------------------------------------------------------- comparação regras × IA (sem custo)
$args2 = @($COMPARAR, '--pasta', $RES, '--versao', $VERSAO, '--holdouts', '30,29,28') + $(if ($Simular) { @('--simulado') } else { @() })
& $NODE @args2 | ForEach-Object { Write-Host "  $_" }
Write-Host "`nResultados: $RES ($VERSAO-holdoutNN-regras / $VERSAO-holdoutNN$sufixo; SHA $SHA)"
