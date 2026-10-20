# Executar interativamente no PowerShell do Windows. Nunca passar chaves como argumentos.
# SecureString/Export-Clixml usa proteção do usuário Windows; não é um arquivo .env.
[CmdletBinding()]
param([switch]$Verificar,[switch]$TestarConexao,[switch]$AtualizarResend,[switch]$TestarAssinatura)
$ErrorActionPreference='Stop'
$raizSandbox=Split-Path -Parent $PSScriptRoot
$pastaSandbox=Join-Path $raizSandbox '.local-assinatura-sandbox'
$arquivoSandbox=Join-Path $pastaSandbox 'credenciais.clixml'
$nomesSandbox=@('ASAAS_AMBIENTE','ASAAS_API_KEY','ASAAS_WEBHOOK_TOKEN','EMAIL_PROVIDER','RESEND_API_KEY','EMAIL_REMETENTE','KIDMAIS_EMAIL_TESTE')
if ($env:OS -ne 'Windows_NT') { throw 'Execute no Windows: este arquivo depende da proteção do usuário Windows.' }
if (-not $Verificar -and -not $TestarConexao -and -not $AtualizarResend -and -not $TestarAssinatura) {
    if (Test-Path -LiteralPath $arquivoSandbox) { throw 'Credenciais já salvas. Use -Verificar; substituição requer decisão explícita.' }
    $chaveAsaas=Read-Host 'Cole a chave da conta SANDBOX Asaas (entrada oculta)' -AsSecureString
    $chaveResend=Read-Host 'Cole a chave Resend de teste (entrada oculta)' -AsSecureString
    $remetenteSandbox=Read-Host 'Remetente autorizado no Resend (email ou Nome <email>)'
    $bytesSandbox=New-Object byte[] 32
    $rngSandbox=[System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rngSandbox.GetBytes($bytesSandbox) } finally { $rngSandbox.Dispose() }
    $tokenSandbox=ConvertTo-SecureString ([Convert]::ToBase64String($bytesSandbox)) -AsPlainText -Force
    New-Item -ItemType Directory -Path $pastaSandbox -Force | Out-Null
    [pscustomobject]@{Asaas=$chaveAsaas;Resend=$chaveResend;Webhook=$tokenSandbox;Remetente=$remetenteSandbox} | Export-Clixml -LiteralPath $arquivoSandbox
    Write-Host 'Credenciais protegidas pelo usuário Windows. Nenhum serviço externo foi chamado.'
}
$credenciaisSandbox=Import-Clixml -LiteralPath $arquivoSandbox
if ($AtualizarResend) {
    $credenciaisSandbox.Resend=Read-Host 'Cole a nova chave API do Resend (entrada oculta)' -AsSecureString
    $credenciaisSandbox | Export-Clixml -LiteralPath $arquivoSandbox
    Write-Host 'Chave Resend atualizada. Chave Asaas preservada. Nenhum email enviado.'
}
$ambienteAnterior=@{}
foreach($nomeSandbox in $nomesSandbox){$ambienteAnterior[$nomeSandbox]=[Environment]::GetEnvironmentVariable($nomeSandbox,'Process')}
function Ler-SegredoSandbox([Security.SecureString]$segredoSandbox){
    $ponteiroSandbox=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($segredoSandbox)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ponteiroSandbox) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ponteiroSandbox) }
}
try {
    $env:ASAAS_AMBIENTE='sandbox'
    $env:ASAAS_API_KEY=Ler-SegredoSandbox $credenciaisSandbox.Asaas
    $env:ASAAS_WEBHOOK_TOKEN=Ler-SegredoSandbox $credenciaisSandbox.Webhook
    $env:EMAIL_PROVIDER='resend'
    $env:RESEND_API_KEY=Ler-SegredoSandbox $credenciaisSandbox.Resend
    $env:EMAIL_REMETENTE=$credenciaisSandbox.Remetente
    $env:KIDMAIS_EMAIL_TESTE='felipemenegaz@gmail.com'
    if ($TestarAssinatura) {
        & node --experimental-strip-types (Join-Path $PSScriptRoot 'assinatura-sandbox-ciclo.cjs')
    } elseif ($TestarConexao) {
        & node --experimental-strip-types (Join-Path $PSScriptRoot 'assinatura-sandbox-conexao.cjs')
    } else {
        & node --experimental-strip-types (Join-Path $PSScriptRoot 'assinatura-sandbox-diagnostico.cjs')
    }
    $codigoSandbox=$LASTEXITCODE
} finally {
    foreach($nomeSandbox in $nomesSandbox){[Environment]::SetEnvironmentVariable($nomeSandbox,$ambienteAnterior[$nomeSandbox],'Process')}
    $credenciaisSandbox=$null
}
exit $codigoSandbox
