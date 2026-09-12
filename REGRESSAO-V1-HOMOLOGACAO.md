# Regressão V1 no clone sanitizado

Este roteiro aceita exclusivamente um PostgreSQL local chamado
`kidmais_v1_homologacao`. Ele não lê `.env.local` e não usa `DATABASE_URL` como
origem da conexão.

## Travas antes da conexão

- consentimento explícito `KIDMAIS_REGRESSAO_HOMOLOGACAO=SIM`;
- URL fornecida somente por `KIDMAIS_HOMOLOGACAO_DATABASE_URL`;
- protocolo PostgreSQL;
- host `localhost`, loopback IPv4 ou IPv6;
- nome físico exatamente `kidmais_v1_homologacao`.

Depois de conectar, o executor confere novamente o nome e o endereço informados
pelo servidor, as 61 tabelas públicas pós-016, a estrutura mínima de Festa e o
estado vazio das 52 tabelas operacionais. Qualquer divergência encerra a execução.

## Execução

Configure a URL apenas na sessão temporária do terminal; não a grave em arquivo
do projeto e não a envie por chat.

```bash
export KIDMAIS_REGRESSAO_HOMOLOGACAO=SIM
read -rsp 'URL do clone sanitizado: ' KIDMAIS_HOMOLOGACAO_DATABASE_URL
export KIDMAIS_HOMOLOGACAO_DATABASE_URL
npm run check:v1:clone
unset KIDMAIS_HOMOLOGACAO_DATABASE_URL KIDMAIS_REGRESSAO_HOMOLOGACAO
```

PowerShell 7:

```powershell
$env:KIDMAIS_REGRESSAO_HOMOLOGACAO = 'SIM'
$env:KIDMAIS_HOMOLOGACAO_DATABASE_URL = Read-Host -MaskInput 'URL do clone sanitizado'
npm run check:v1:clone
Remove-Item Env:KIDMAIS_HOMOLOGACAO_DATABASE_URL, Env:KIDMAIS_REGRESSAO_HOMOLOGACAO
```

Os resultados ficam em `.tmp/regressao-v1-homologacao/resultado.json`, com um
log por suite e somente metadados não secretos do alvo.

## Cobertura automatizada no clone

- catálogo comercial e disponibilidade;
- identidade/CRM com rollback;
- fechamento, revisão comercial e geração de contrato;
- aceite por OTP com transporte simulado, sem enviar WhatsApp real;
- pagamentos, idempotência, HTTP, CSRF e comprovantes sintéticos;
- edição pós-assinatura, remarcação, vigência de Festa e cancelamento;
- preflight e postflight confirmando que nenhuma linha operacional permaneceu.

O smoke test do WhatsApp transacional real deve ser executado separadamente, em
homologação do provedor, com número autorizado. Navegação desktop/mobile usa APIs
simuladas e pode ser executada com `npm run check:v1:ui` quando houver Chromium ou
Edge compatível com Playwright no ambiente.
