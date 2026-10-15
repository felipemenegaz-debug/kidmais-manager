<#
Avaliação holdout do Wall-e em modo IA REAL.

A chave da OpenAI é digitada aqui, em prompt oculto; vai só para o ambiente do processo filho (node) e é descartada em
seguida. Nunca é impressa, gravada em arquivo, passada na linha de comando ou repassada a outro processo.
Modelo, preços e teto: os já autorizados para a demonstração (fixados em avaliar.mjs, IA_AUTORIZADA): gpt-6-luna,
tier ECONOMY, sem raciocínio, uma tentativa, sem troca de provedor, teto US$ 0,20/dia e 300 mil tokens/dia.
Sem banco: o filho recebe um ambiente limpo, sem DATABASE_URL (e o avaliador recusa se houver). Rede do filho: só
https://api.openai.com/v1/ (guarda-rede.mjs). Resultados: scripts\walle-avaliacao\resultados\v4\ (avaliador v4); cada
chamada é reservada e fechada no livro único de uso (livro-uso-ia.mjs), que soma avaliadores e demonstrações no mesmo
teto do dia. Para a medição da rodada 4, use comparar-ia.ps1 (prioriza a versão corrigida).

  powershell -ExecutionPolicy Bypass -File scripts\walle-avaliacao\avaliar-ia.ps1            (IA real; pede a chave)
  powershell -ExecutionPolicy Bypass -File scripts\walle-avaliacao\avaliar-ia.ps1 -Simular   (ensaio sem rede e sem chave)
#>
param([switch]$Simular)
$ErrorActionPreference = 'Stop'
$raiz = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$node = $env:DEMO_NODE
if (-not $node) { $node = 'C:\Users\Glass\AppData\Local\Temp\claude\D--glass-KidMais-Manager-kidmais-manager-ai-master\d4796071-ef3c-4c91-a3b8-c836972d8bb6\scratchpad\node22\node-v22.23.2-win-x64\node.exe' }
if (-not (Test-Path -LiteralPath $node)) { throw "Node 22 não encontrado em $node (defina DEMO_NODE)." }
$corpus = Join-Path $PSScriptRoot 'corpus-holdout-20261005.json'
$mensagens = (Get-Content -LiteralPath $corpus -Raw -Encoding UTF8 | ConvertFrom-Json).itens.Count

Write-Host "Avaliação holdout do Wall-e - modo IA $(if ($Simular) { 'SIMULADO (provedor falso local; sem rede, sem chave)' } else { 'REAL' })"
Write-Host "  Mensagens: $mensagens (no máximo uma chamada de modelo por mensagem, sem nova tentativa)"
Write-Host '  Modelo: OpenAI gpt-6-luna (ECONOMY, reasoning none), timeout 15 s, sem fallback'
Write-Host '  Preço: US$ 0,10/1M tokens de entrada, US$ 0,50/1M de saída; teto autorizado US$ 0,20/dia e 300.000 tokens/dia'
Write-Host '  Estimativa (ensaio simulado): ~69 mil tokens, ~US$ 0,009 no total'
Write-Host '  Rede: só https://api.openai.com/v1/. Banco: nenhum. Nada é enviado a cliente nem gravado fora de resultados\'

$seguro = $null
if (-not $Simular) {
  # Saldo do livro único conferido ANTES da chave (só leitura): a rodada inteira precisa caber (1.200/mensagem + 2.000).
  $necessario = $mensagens * 1200 + 2000
  & $node (Join-Path $PSScriptRoot 'livro-uso-ia.mjs') conferir --tokens $necessario
  if ($LASTEXITCODE -ne 0) { throw "Sem saldo no livro único para $necessario tokens: a chave não é pedida e nenhuma chamada é feita." }
  $seguro = Read-Host -AsSecureString 'Chave da API OpenAI (mascarada; Enter vazio cancela)'
  if (-not $seguro -or $seguro.Length -lt 20) { if ($seguro) { $seguro.Dispose() }; throw 'Chave não informada: avaliação cancelada. Nenhuma chamada foi feita.' }
}

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $node
$psi.Arguments = '--experimental-strip-types --no-warnings --import ./scripts/walle-avaliacao/registrar.mjs scripts/walle-avaliacao/avaliar.mjs ia' + $(if ($Simular) { ' --simular' } else { '' })
$psi.WorkingDirectory = $raiz
$psi.UseShellExecute = $false
# Ambiente limpo: só o mínimo do Windows (sem DATABASE_URL, chaves, tokens ou variáveis do Next).
$psi.EnvironmentVariables.Clear()
foreach ($n in 'SystemRoot', 'SystemDrive', 'windir', 'TEMP', 'TMP', 'USERPROFILE') { $v = [Environment]::GetEnvironmentVariable($n); if ($v) { $psi.EnvironmentVariables[$n] = $v } }
$p = $null
try {
  if ($seguro) {
    # A chave sai do SecureString direto para o ambiente do filho e é zerada aqui logo após o início.
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($seguro)
    try {
      try { $psi.EnvironmentVariables['OPENAI_API_KEY'] = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr).Trim() } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
      $p = [System.Diagnostics.Process]::Start($psi)
    } finally { $psi.EnvironmentVariables.Remove('OPENAI_API_KEY'); $seguro.Dispose(); $seguro = $null }
  } else {
    $p = [System.Diagnostics.Process]::Start($psi)
  }
  $p.WaitForExit()
  if ($p.ExitCode -ne 0) { throw "Avaliação terminou com código $($p.ExitCode)." }
  Write-Host "Resultados: $(Join-Path $PSScriptRoot 'resultados')"
} finally {
  if ($seguro) { $seguro.Dispose() }
}
