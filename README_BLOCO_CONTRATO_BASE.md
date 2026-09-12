# Kidmais Manager — Contrato / Bloco 1

**Migration:** `database/migrations/20260908_009_contrato_base.sql`  
**Escopo:** base persistente, snapshot versionado e API administrativa de geração/consulta.  
**Fora deste bloco:** PDF, assinatura, envio ao Cliente, Pagamentos e criação da Festa.

## 1. Regras implementadas

- O Contrato só pode ser gerado quando o Fechamento está em `AGUARDANDO_CONTRATO`.
- `AGUARDANDO_APROVACAO` e os demais estados não autorizados são bloqueados no backend.
- Um Fechamento possui no máximo um **Contrato lógico**.
- O conteúdo documental é congelado em `contrato_versoes`.
- Regenerar após alteração material cria uma nova versão e mantém a anterior como `SUBSTITUIDA`.
- Repetir a geração sem mudança material é idempotente: reutiliza a versão atual.
- Contrato `ASSINADO` ou `CANCELADO` não pode ser regenerado pelo fluxo deste bloco.
- O valor contratual usa `valor_aprovado` quando existir; valor negociado sem aprovação nunca vira valor do Contrato.
- A geração exige o cadastro contratual já definido pelo CRM: nome, CPF, contato, e-mail e endereço completo.
- RG permanece opcional.
- A preferência de pagamento é persistida no Fechamento, mas não representa pagamento efetuado.
- Registros antigos não recebem backfill inventado. Campos que antes não eram persistidos permanecem `NULL`.
- Fechamento, Contrato, Pagamento e Festa continuam domínios separados.

## 2. Estruturas da Migration 009

### Cliente

Adiciona `clientes.rg` como dado opcional.

### Fechamento

Passa a persistir dados que o wizard já coletava:

- responsável adicional vinculado ao CRM;
- idade do aniversariante no evento;
- tema específico da Festa;
- forma de pagamento pretendida;
- alterações específicas do pacote;
- observações do Cliente;
- detalhes do buffet (salgados, bebidas, doces, bolo e outros).

### Contrato

`contratos` representa o Contrato lógico 1:1 com o Fechamento.

`contrato_versoes` armazena o snapshot JSONB imutável, número da versão, status e SHA-256 do conteúdo canônico.

O snapshot contém as referências e valores históricos necessários para a futura renderização do documento, sem depender de o cadastro mestre permanecer igual depois.

## 3. API do Bloco 1

A API é administrativa e continua protegida pela trava temporária já usada no CRM: funciona somente em desenvolvimento com `CRM_API_DEV_ENABLED=true`. Em produção permanece bloqueada até existir autenticação/permissão real.

### Gerar ou regenerar

`POST /api/admin/contratos`

```json
{
  "fechamentoId": "UUID",
  "motivoNovaVersao": "opcional"
}
```

Resposta `201` quando cria uma versão nova. Resposta `200` quando a versão atual já representa exatamente os mesmos dados (`reutilizado: true`).

### Consultar

`GET /api/admin/contratos?fechamentoId=UUID`

Retorna o Contrato lógico e a versão documental corrente.

## 4. Ordem para aplicar localmente

1. Pare o servidor Next.js.
2. No pgAdmin, confirme que está conectado ao banco `kidmais_manager`.
3. Abra e execute **somente** `database/migrations/20260908_009_contrato_base.sql`.
4. Se a Query Tool terminar com `COMMIT`, execute `scripts/contrato-bloco1-verificacao.sql`.
5. Inicie o projeto novamente com o mesmo comando que já funciona no ambiente local (`npm run dev`).
6. Faça os testes de API com um Fechamento `AGUARDANDO_CONTRATO` e com o Fechamento `AGUARDANDO_APROVACAO`.

## 5. Bateria de testes esperada

### A. Estrutura física

O script SQL deve mostrar `contratos` e `contrato_versoes`, o campo `clientes.rg`, os 11 novos campos de `fechamentos`, constraints e índices.

### B. Geração válida

Para um fechamento `AGUARDANDO_CONTRATO`, o primeiro POST deve criar:

- 1 registro em `contratos`;
- versão 1 em `contrato_versoes`;
- evento `CONTRATO_GERADO` no histórico do Cliente;
- auditoria sem copiar o snapshot/PII para o log.

O `fechamentos.status` deve continuar `AGUARDANDO_CONTRATO` neste bloco.

### C. Idempotência

Repetir imediatamente o mesmo POST deve responder `reutilizado: true` e **não** criar versão 2.

### D. Bloqueio comercial

Executar o POST para um fechamento `AGUARDANDO_APROVACAO` deve responder conflito (`409`) com o código `STATUS_FECHAMENTO_NAO_PERMITE_CONTRATO`.

### E. Regressão

- `npx.cmd tsc -p tsconfig.json --noEmit`
- `npm run test:disponibilidade`
- `npm run test:contrato`

## 6. Observações de compatibilidade

A Migration 009 deve ser aplicada antes de executar o código deste bloco, pois os repositories de Cliente e Fechamento já passam a consultar as novas colunas.

`schema_mvp_kidmais.sql` continua legado/provisório e não participa desta implementação.
