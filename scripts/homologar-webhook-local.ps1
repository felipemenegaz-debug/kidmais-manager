# Plano aprovado: somente banco sintetico fixo e Asaas sandbox. Nao solicita nem imprime segredos.
[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$raizWebhook=Split-Path -Parent $PSScriptRoot
$nomesWebhook=@('ASAAS_AMBIENTE','ASAAS_API_KEY','ASAAS_WEBHOOK_TOKEN','KIDMAIS_WEBHOOK_AUTORIZACAO')
$anteriorWebhook=@{}
foreach($nomeWebhook in $nomesWebhook){$anteriorWebhook[$nomeWebhook]=[Environment]::GetEnvironmentVariable($nomeWebhook,'Process')}
function Ler-SegredoWebhook([Security.SecureString]$segredoWebhook){
    $ponteiroWebhook=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($segredoWebhook)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ponteiroWebhook) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ponteiroWebhook) }
}
try {
    $credencialWebhook=Import-Clixml -LiteralPath (Join-Path $raizWebhook '.local-assinatura-sandbox/credenciais.clixml')
    $env:ASAAS_AMBIENTE='sandbox'
    $env:ASAAS_API_KEY=Ler-SegredoWebhook $credencialWebhook.Asaas
    $env:ASAAS_WEBHOOK_TOKEN=Ler-SegredoWebhook $credencialWebhook.Webhook
    $env:KIDMAIS_WEBHOOK_AUTORIZACAO='127.0.0.1:55475/kidmais_webhook_20261009_sintetica'
    & node --experimental-strip-types (Join-Path $PSScriptRoot 'assinatura-webhook-homologar.cjs')
    $codigoWebhook=$LASTEXITCODE
} finally {
    foreach($nomeWebhook in $nomesWebhook){[Environment]::SetEnvironmentVariable($nomeWebhook,$anteriorWebhook[$nomeWebhook],'Process')}
    $credencialWebhook=$null
}
exit $codigoWebhook
