---
name: kidmais-safe-migration
description: Roteiro padrão para criar, revisar e validar migrations PostgreSQL do Kidmais Manager (database/migrations, checks, rollback, repairs). Use em qualquer mudança de schema, tabela, coluna, constraint, trigger, função SQL, índice ou backfill, e ao revisar uma migration de outra pessoa.
---

# Migration segura

Regra permanente: **migration remota/produção nunca é aplicada pelo agente.** O agente escreve, testa em banco local/clone e entrega o pacote; quem aplica é o usuário, seguindo o procedimento oficial. (O mod `kidmais-guard` bloqueia a execução de `migration-*.apply`.)

## Convenção de arquivos (seguir a numeração existente)

| Arquivo | Conteúdo |
|---|---|
| `database/migrations/AAAAMMDD_NNN_nome.sql` | o `up`, em transação |
| `database/checks/AAAAMMDD_NNN_precheck.sql` | `DO $$ … RAISE EXCEPTION` se a estrutura já existe, se faltam pré-requisitos ou se tipos físicos divergem |
| `database/checks/AAAAMMDD_NNN_postcheck.sql` | confirma tabelas, colunas, constraints, triggers e contagens esperadas |
| `database/rollback/AAAAMMDD_NNN_nome_down.sql` | desfaz o `up` sem perder dado anterior |
| `scripts/migration-NNN.validation.cjs` / `.integrity.cjs` | fingerprint de dados e catálogo antes/depois |
| `scripts/migration-NNN.apply.cjs` | aplicação local **só** com evidência do teste isolado da mesma versão do SQL (hash) |

Use `scripts/migration-014.*` e `database/checks/20260911_016_*` como modelo.

## Passo a passo

1. **Análise**: liste tabelas afetadas, volume, dependências (FK, triggers de `auditoria`, funções) e quem lê/escreve cada coluna (`grep` em `lib/`).
2. **Compatibilidade**: o código atual continua funcionando entre o deploy da migration e o do código? Prefira expandir → migrar → contrair (coluna nova nullable, backfill, depois `NOT NULL`).
3. **Escreva** up, precheck, postcheck e down. Nada de `DROP` de dado sem backup verificado e aprovação explícita.
4. **Backfill**: idempotente, em lotes se a tabela for grande, com contagem antes/depois.
5. **Locks**: `SET LOCAL lock_timeout`; evite `ACCESS EXCLUSIVE` longo; índices grandes com `CONCURRENTLY` (fora de transação).
6. **Teste isolado**: aplique up → postcheck → down → up num banco descartável/clone (`kidmais_v1_homologacao` ou outro local). Nunca contra `kidmais_manager` de produção.
7. **Integridade**: compare fingerprint dos dados existentes antes/depois; dados anteriores devem ficar idênticos, salvo o backfill planejado.
8. **Encoding**: arquivos SQL em UTF-8 sem BOM (houve reparo de encoding na 016; veja `database/repairs/`).
9. **Tenant**: tabela operacional nova já nasce com `empresa_id` (e `estabelecimento_id` quando aplicável) ou com caminho inequívoco até eles (`docs/02-ARQUITETURA-SAAS.md`). Peça a revisão `kidmais-tenant-safety`.

## Entrega

Inclua no PR/relatório:
- arquivos criados;
- resultado do teste isolado (up, postcheck, down, up);
- impacto em dados existentes e no tempo de lock;
- sequência segura de deploy (migration antes/depois do código);
- rollback: comando, pré-condição e o que se perde;
- o comando que **o usuário** deve rodar para aplicar.
