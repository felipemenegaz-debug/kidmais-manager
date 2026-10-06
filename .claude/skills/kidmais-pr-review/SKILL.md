---
name: kidmais-pr-review
description: Revisão do diff do Kidmais Manager antes de abrir ou aprovar um PR - correção, regressão, segurança, tenant, migrations, testes e documentação. Use quando o usuário pedir revisão de PR/branch/diff ou antes de abrir um PR.
---

# Revisão de PR

Revisão read-only. Compare com a base (`git diff origin/main...HEAD`) e leia cada arquivo alterado por inteiro, não só o hunk.

## Ordem

1. **Escopo**: o diff faz só o que a tarefa pede? Arquivos estranhos (lockfile sem motivo, `.env`, `.next*`, `.backups`, `.tmp`) são achado.
2. **Regra de negócio**: confira contra `docs/modulos/<módulo>.md` (skill `kidmais-business-rules`). Atenção especial a: contrato assinado imutável, parcela após a festa, criação de Festa só com contrato assinado, cálculo de saldo/desconto.
3. **Correção**: estados inválidos, concorrência (dupla submissão, idempotência em pagamentos — veja `lib/pagamentos/services/idempotencia.ts`), transações (`BEGIN/COMMIT/ROLLBACK`), datas e fuso, arredondamento de dinheiro (centavos inteiros).
4. **Segurança/tenant**: rota nova ou alterada, query, auth ou dado pessoal → aplique o checklist da skill `kidmais-tenant-safety`.
5. **Migration**: arquivo em `database/` → skill `kidmais-safe-migration` (precheck, postcheck, rollback, teste isolado).
6. **Testes**: a mudança de regra veio com teste? O gate (`kidmais-test-gate`) foi rodado e está no PR?
7. **Docs**: mudou regra ou arquitetura? Então `docs/` e o changelog mudaram também (skill `kidmais-doc-sync`).
8. **Next.js**: esta versão tem APIs diferentes; confira em `node_modules/next/dist/docs/` antes de apontar algo como errado.

## Formato

```
[BLOQUEANTE|IMPORTANTE|SUGESTÃO] arquivo:linha — problema
  Cenário: entrada/estado → resultado errado
  Correção: …
```

No fim: veredito (aprovar / pedir mudanças), testes que faltam, riscos e rollback.

## Corpo do PR (quando for abrir)

Resumo · Regras afetadas (com link para `docs/`) · Testes rodados (PASS/FAIL) · Riscos · Rollback · Docs atualizadas.
