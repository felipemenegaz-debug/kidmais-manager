# Kidmais Manager — Contrato — Bloco 2

## Estado desta implementação

Este bloco estende o Contrato já existente sem recriar o domínio do Bloco 1.
A Migration `20260908_010_contrato_documento_aceite.sql` é pré-requisito e deve estar aplicada antes de iniciar o fluxo público.

O `schema_mvp_kidmais.sql` continua legado/provisório e não foi alterado.

## O que foi implementado

- renderizador contratual versionado a partir exclusivamente de `contrato_versoes.snapshot`;
- PDF determinístico server-side, sem Chromium e sem biblioteca externa de PDF;
- SHA-256 do PDF efetivamente apresentado ao Cliente;
- visualização administrativa do PDF por Fechamento;
- fluxo público `/contrato/[contratoId]`;
- CPF + contato mascarado + OTP com finalidade `CONTRATO_ACEITE`;
- token de acesso HMAC vinculado ao Contrato, versão e validação OTP que originaram a sessão;
- aceite vinculado a `versaoId`, `snapshotHash` e `documentoPdfHash`;
- assinatura atômica da versão corrente;
- `contrato_versoes: ATIVA -> ASSINADA`;
- `contratos: AGUARDANDO_ASSINATURA -> ASSINADO`;
- `fechamentos: AGUARDANDO_CONTRATO -> CONTRATO_ASSINADO`;
- consumo da prova OTP pela versão assinada;
- histórico funcional e auditoria técnica do aceite;
- retry idempotente da mesma assinatura após commit;
- bloqueio de regeneração continua sendo responsabilidade das regras do Bloco 1.

Pagamentos e Festa permanecem fora deste bloco. O Fechamento **não** avança para `AGUARDANDO_PAGAMENTO` aqui.

## Template V1 — importante

O Template V1 é deliberadamente uma **minuta técnica de desenvolvimento**. O ZIP original não continha o texto jurídico definitivo da Kidmais nem os dados completos da parte contratada necessários para homologação jurídica.

Por isso:

- o PDF V1 traz aviso explícito de minuta técnica;
- em `NODE_ENV=production`, o aceite é sempre bloqueado;
- em desenvolvimento, o aceite só é liberado com:

```env
CONTRATO_ACEITE_DEV_ENABLED=true
```

Quando o texto jurídico aprovado for fornecido, deve ser criado um novo Template V2 (ou superior). O Template V1 não deve ser sobrescrito, pois renderizadores antigos precisam continuar reproduzíveis.

## Rotas principais

### Administrativo

`GET /api/admin/contratos/pdf?fechamentoId=<UUID>`

Gera a visualização do PDF da versão corrente. Continua protegido pela mesma guarda administrativa DEV das APIs administrativas atuais.

### Público

- `POST /api/contratos/[contratoId]/acesso`
- `POST /api/contratos/[contratoId]/identidade/iniciar`
- `POST /api/identidade/confirmar-codigo` (rota existente reutilizada)
- `POST /api/contratos/[contratoId]/contexto`
- `POST /api/contratos/[contratoId]/pdf`
- `POST /api/contratos/[contratoId]/aceite`
- página: `/contrato/[contratoId]`

O token de prova e o token de acesso não são colocados na URL.

## Segurança da sessão pública

O OTP `CONTRATO_ACEITE` sozinho não é tratado como autorização genérica para todos os Contratos daquele Cliente.
Ao iniciar o desafio, o servidor gera também um token HMAC curto de sessão, vinculado a:

- Contrato;
- versão corrente;
- ID da validação OTP;
- expiração.

Contexto, PDF e aceite exigem simultaneamente a prova OTP e esse token de acesso. Assim, uma prova obtida no fluxo de um Contrato não pode ser utilizada para acessar outro Contrato do mesmo Cliente.

## Regra de assinatura

Dentro de uma única transação PostgreSQL, o serviço valida e bloqueia os registros relevantes. A assinatura nova exige:

- Contrato `AGUARDANDO_ASSINATURA`;
- versão corrente `ATIVA`;
- Fechamento `AGUARDANDO_CONTRATO`;
- `versaoId` exibida igual à versão corrente;
- `snapshotHash` exibido igual ao persistido;
- PDF regenerado com o mesmo SHA-256 enviado pelo Cliente;
- token de acesso vinculado àquela versão/validação;
- prova OTP `CONTRATO_ACEITE`, válida e do Cliente canônico correto.

Somente depois disso a prova é consumida e os três estados são atualizados.

## PDF e preservação

O PDF é determinístico: o mesmo snapshot + número da versão + template geram os mesmos bytes e o mesmo SHA-256.

Quando uma versão está `ASSINADA`, o serviço regenera o PDF com o template persistido e compara o resultado com `documento_pdf_hash`. Se houver divergência, a entrega é bloqueada com erro de integridade em vez de devolver silenciosamente um documento diferente do aceito.

## Testes locais

```powershell
npx.cmd tsc -p tsconfig.json --noEmit
npm run test:contrato
npm run test:disponibilidade
```

Para homologar o fluxo completo, habilite `CONTRATO_ACEITE_DEV_ENABLED=true`, reinicie `npm run dev`, abra `/contrato/<contratoId>`, valide o CPF e use o OTP exibido pelo provider `console`.

Após o aceite, execute `scripts/contrato-bloco2-verificacao.sql` no PostgreSQL físico.
