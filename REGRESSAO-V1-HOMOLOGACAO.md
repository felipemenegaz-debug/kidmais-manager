# Regressão V1 no clone sanitizado

> Aviso B5B-1: roteiro histórico, não certificado de sanitização. A auditoria B4
> encontrou o clone-evidência pós-019 com dados operacionais remanescentes.
> O novo sanitizador recusa absolutamente `kidmais_v1_homologacao` e
> `kidmais_manager`. Não executar os comandos legados abaixo como parte da B5B.
> Ver [perfil e processo pós-019](docs/baseline/V1-POST-019-SANITIZATION.md).

Este roteiro aceita exclusivamente um PostgreSQL local chamado
`kidmais_v1_homologacao`. Ele não lê `.env.local` e não usa `DATABASE_URL` como
origem da conexão.

## Travas antes da conexão

- consentimento explícito `KIDMAIS_REGRESSAO_HOMOLOGACAO=SIM`;
- URL fornecida somente por `KIDMAIS_HOMOLOGACAO_DATABASE_URL`;
- protocolo PostgreSQL;
- host `localhost`, loopback IPv4 ou IPv6;
- nome físico exatamente `kidmais_v1_homologacao`.

O texto anterior atribuía ao executor uma checagem global de 61 tabelas pós-016
e de 52 operacionais vazias. A auditoria estática B4 não encontrou essa checagem
global implementada no runner. Portanto, ele não prova sanitização. O perfil
pós-019 aprovado exige 63 tabelas, nove canônicas e 54 operacionais vazias,
com validação própria e somente em destino descartável autorizado.

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
- verificações das suítes não equivalem a preflight/postflight global comprovando
  ausência de linhas nas 54 tabelas operacionais pós-019.

O smoke test do WhatsApp transacional real deve ser executado separadamente, em
homologação do provedor, com número autorizado. Navegação desktop/mobile usa APIs
simuladas e pode ser executada com `npm run check:v1:ui` quando houver Chromium ou
Edge compatível com Playwright no ambiente.
