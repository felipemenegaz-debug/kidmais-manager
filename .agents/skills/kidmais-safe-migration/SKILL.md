---
name: kidmais-safe-migration
description: Planeja, implementa ou revisa migrations e mudanças de schema do Kidmais com compatibilidade, backfill, índices, constraints, sequência de deploy e rollback seguros.
---

# Migration segura

Antes de agir, leia `docs/02-ARQUITETURA-SAAS.md`, `docs/04-SEGURANCA-E-AUDITORIA.md`, os ADRs aplicáveis e regras operacionais em `docs/05-OPERACAO-E-PRODUCAO.md`.

1. Explicite estado atual, estado desejado, volume/locks esperados e impacto na V1.
2. Prefira sequência expandir → compatibilizar código → backfill idempotente → validar → aplicar constraints/índices → remover legado em etapa posterior.
3. Para dados multi-tenant, defina origem confiável de `empresa_id` e `estabelecimento_id`; não aceite backfill ambíguo.
4. Defina prechecks, postchecks, observabilidade, rollback e sequência de deploy antes da execução.
5. Teste apenas em banco isolado com dados sintéticos e autorização explícita. Nunca use banco real da Kidmais nem execute migration de produção automaticamente.
6. Pare e reporte se não houver rollback seguro, origem inequívoca dos dados ou compatibilidade comprovável.
