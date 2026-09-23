# Fases 1C-A / 1C-B0 / 1C-B1 — desenho e migratabilidade SaaS

Status: **PROPOSTA PRONTA PARA APROVAÇÃO ANTES DAS MIGRATIONS**, baseada no commit arquitetural `c8cc8790a556a4e6c5df9b6fa57f84183b26a992`, branch `saas/foundation`. A B1 preserva os documentos ainda não commitados da A/B0. OPEN_1C-01 foi aprovado pelo usuário na B0; isso não aprova migrations ou todos os detalhes físicos. A proposta X exige aprovação explícita da exceção de retenção/transferência ao append-only, não altera por si só os ADRs ACCEPTED. D03/D10 continuam MUST_DECIDE_BEFORE_FIRST_TENANT; D11b CAN_DEFER; D12b pendente.

## Documentos

1. [Blueprint: entidades, integridade e diagrama](SAAS-SCHEMA-BLUEPRINT.md).
2. [Configuração: direção física aprovada e detalhes propostos](SAAS-CONFIG-PHYSICAL-DESIGN.md).
3. [Matriz completa das 63 tabelas](SAAS-SCHEMA-63-MATRIX.md).
4. [RLS, contexto e superfície de descoberta](SAAS-RLS-BLUEPRINT.md).
5. [Backfill, nulabilidade e preservação](SAAS-BACKFILL-PLAN.md).
6. [Slices, dependências, rollback e gates](SAAS-MIGRATION-SLICES.md).
7. [Proof of Migratability B0: 63 tabelas, proteções, exceções e legado](SAAS-MIGRATABILITY-PROOF.md).
8. [B1: classificação, autoridade e disposição do legado de segurança](SAAS-LEGACY-SECURITY-DISPOSITION.md).

A configuração recebeu documento próprio porque suas alternativas e referências históricas precisam de revisão independente; a matriz inclui o inventário dos uniques. Os oito documentos técnicos, mais este índice, formam uma única proposta. A prova B0 complementa cada linha da matriz com proteções; a B1 substitui o impasse estrutural B0-AUD por tratamento nominal, sem certificar execução.

## Fontes e precedência

- [ADRs SaaS 001–010 e decisões D01–D12](../adr/README.md), lidos integralmente.
- [Ownership 63](../OWNERSHIP-V1-63.md), [autoridades D12a](../SAAS-CONFIG-AUTHORITY-MAP.md), [invariantes I01–I10/testes T01–T16/gates G0–G4](../SAAS-VALIDACAO-E-GATES.md).
- [Manifesto V1 pós-019](../../../database/baseline/v1-post-019.manifest.json), [baseline histórico](../../baseline/V1-POST-019.md), [projeção estática do schema](../../../scripts/sanitize-v1-post-019/expected-schema.json) e migrations versionadas citadas na matriz.

Nomes/tipos novos são recomendações documentais. A referência é PG18; o fingerprint V1 não atesta dados ocupados, RLS ou privilégios operacionais. SQL 017–019 não trouxe o runtime correspondente. A matriz distingue V1 global de ownership futuro e não aumenta a contagem das 63 ao listar entidades novas.

## OPEN_1C e critérios de aprovação

| Item | Recomendação | Aprovação/evidência necessária | Bloqueia o quê? |
| --- | --- | --- | --- |
| OPEN_1C-01 — CLOSED | A+C: versões tipadas por escopo + publicação efetiva por unidade | Direção aprovada explicitamente pelo usuário na 1C-B0; revisar detalhes antes do SQL | Escolha física de direção fechada; provas de integridade/publicação continuam gates |
| OPEN_1C-02 — DESIGN_CLOSED_EXECUTION_GATE | P permanente e M temporário por guard/família, sem sidecar obrigatório demonstrado | G-P antes do primeiro ADD COLUMN S2 em H16; G-M antes do primeiro backfill protegido S5 ou escrita equivalente antecipada | Execução dependente bloqueada até ensaio ocupado, não novo impasse estrutural |
| OPEN_1C-03 — DESIGN_CLOSED, proposto para aprovação | Combinação B+D: Core nativo, tenant history, mínimo Core global via X e eliminação elegível; sem dupla autoridade | Aprovar X/retention/campos/irreversibilidade e ensaiar G-X; classificar população e provar G-COVERAGE/G-ACCESS | Sem autorização de execução; casos MANUAL_REVIEW bloqueiam lote/cutover, sem tenant NULL final |

OPEN_1C-01 fecha a direção física sem reabrir D04. B0/B1 não provam população nem execução de banco. Em OPEN_1C-03, X remove apenas a origem elegível atomicamente com evidência Core mínima; dados tenant/duráveis não são promovidos a Core. A perda autorizada de campos minimizados não é reversível por um down comum. **Não está autorizado escrever a migration completa**. D03/D10 não são convertidas em OPEN_1C nem fechadas por este desenho. D12c continua preparação de roles/operação antes dos gates correspondentes.

## Riscos e revisão

- P0: FK cruzada, contexto adulterado, NULL como wildcard, descoberta circular, role owner/BYPASSRLS, vínculo CRM sem fundamento, conexão WhatsApp alheia, assinatura sem Festa019 e segundo tenant prematuro. Mitigações no blueprint/RLS/slices; exigem provas G1/G3/D12b.
- P1: publicação parcial, configuração histórica mutável, trigger/hash afetado por backfill, idempotência sem escopo, concessão V1 ampliada, rollback destrutivo após uso. Congelar fontes, preservar IDs/conteúdo e validar por agregado.
- P2: custo dos índices compostos/publicações, contenção, planos RLS, volume de históricos e locks ainda não medidos. Sem promessa de zero downtime.

Revisão desta fase é documental e adversarial: explorer para relações/uniques, migration-reviewer para integridade/backfill/rollback e revisão tenant-security para autorização/contexto. Não substitui testes físicos. Rollback desta entrega é remover/reverter somente documentação não aprovada; nenhum banco foi modificado.
