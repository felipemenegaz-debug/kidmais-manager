# Kidmais Manager — Bloco final de Identidade / CRM no Fechamento

Este pacote deve ser extraído na raiz de `kidmais-manager`.

## Escopo
- vínculo seguro da prova OTP com `POST /api/fechamentos`;
- `cliente_id` resolvido exclusivamente no backend;
- consumo atômico e de uso único da prova;
- CPF novo cria Cliente sem duplicar CPF existente;
- Cliente existente reutiliza o mesmo Cliente;
- carregamento do cadastro e aniversariantes somente após OTP;
- seleção de aniversariante existente ou criação de novo;
- atualização de cadastro existente somente com confirmação explícita;
- recuperação pendente sem revelar dados nem criar Cliente duplicado;
- frontend do Fechamento sem `clientesMock` e sem OTP mock;
- origem pública continua `CLIENTE`;
- `ATENDIMENTO_KIDMAIS` continua bloqueado no navegador até existir autenticação/permissão real;
- correções conhecidas de frontend comercial: Festa Completa 50 = R$ 8.990, Penne 50 = R$ 500 e PIX parcelado sem desconto automático.

## Não altera
- Migration 008 já aplicada;
- `schema_mvp_kidmais.sql`;
- tabelas CRM existentes;
- envio real por WhatsApp/SMS (provider de desenvolvimento continua sendo console).

## Validação
```powershell
npx.cmd tsc -p tsconfig.json --noEmit
npx.cmd --yes tsx scripts/identidade-fechamento.integration.ts
```

O teste de integração usa ROLLBACK e não deve deixar Cliente, aniversariante ou Fechamento de teste persistidos.
