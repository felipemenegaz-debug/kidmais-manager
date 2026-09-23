# ADR-008 — Rollout e compatibilidade V1

## Status

PARTIALLY ACCEPTED — SaaS/ADR-008, atualizado na 1B-C2. Direção de rollout incremental D12b aprovada; D12a CLOSED, D12b/D12c têm provas/entregáveis pendentes. Gates são condições futuras verificáveis, não aprovações de deploy ou início da 1C.

## Contexto

O baseline documental e o harness foram congelados; runtime SaaS ainda não existe. A cópia seletiva de SQL 017–019 na C0 não importou por consequência seus commits funcionais.

## Problema

Impedir ativação prematura de multiempresa e permitir recuperação sem reintroduzir consultas V1 globais sobre dados de vários tenants.

## Drivers

Compatibilidade V1; mudanças pequenas; observabilidade; capacidade de interromper; nenhum big-bang; isolamento preservado no rollback.

## Decisão

Adotar os gates G0–G4 e a [estratégia de validação](../SAAS-VALIDACAO-E-GATES.md). G0 fecha BLOCKER_1C e D12a para desenho 1C autorizado separadamente; G1 prova schema/contexto em isolado; G2 migra somente a Kidmais com observabilidade; G3 comprova dois tenants sintéticos/unidades e roles reais de runtime; G4 autoriza onboarding da segunda empresa operacional após revisão explícita. Laboratório sintético isolado não é onboarding externo e exige autorização própria. Backend bloqueia criação/ativação operacional adicional até G4; UI não basta. Nenhuma convivência aceita de duas empresas com queries V1 globais.

D12b exige retirada/drenagem dos escritores antigos, reconciliação final, impedimento de registros obrigatórios sem escopo, remoção de leitura global V1/compatibilidade tenant NULL, constraints finais ativadas e isolamento comprovado antes da segunda empresa. Nulabilidade transitória só quando necessária à transição single-tenant, sem default de tenant implícito. D03 e D10 permanecem MUST_DECIDE_BEFORE_FIRST_TENANT; nenhum aceite de rollout as resolve automaticamente.

## Alternativas consideradas

Big-bang concentra risco de todos os domínios. Ativar segundo tenant só porque empresa_id existe confunde schema com segurança. Dual-write de dois modelos sem idempotência/reconciliação aumenta inconsistência; só considerar se demonstrada necessidade.

## Consequências positivas

Marcos auditáveis e reversíveis antes da abertura; regressão V1 e isolamento são evidências distintas.

## Consequências negativas/trade-offs

Mais releases e compatibilidade transitória; custo de manter gates, métricas e observação. Nem toda migration é reversível após dados novos.

## Invariantes

I10 e todas as demais invariantes permanecem no rollback. Versão antiga que ignora tenant não pode receber tráfego multiempresa. Ativação, não apenas cadastro, exige G4.

## Implicações de segurança

Monitorar negações, escopo ausente, tentativas de IDOR e erros de integridade sem registrar PII. Rollback de app só usa build já tenant-aware; se indisponível, suspender novas operações afetadas e aplicar correção controlada. Separação física futura requer plano próprio, não fallback espontâneo.

## Implicações para migrations

PRs sugeridos: desenho/contratos de contexto; estrutura empresa/unidade/membership; backfill ensaiado; domínios CRM/config; cadeia operacional; constraints/índices; roles/policies; testes e gate onboarding. Dependências reais podem exigir reagrupar. Nenhuma dessas migrations é criada aqui.

## Implicações para testes

T14/T15 e suíte T01–T13: rollback de app compatível, writers durante backfill, cancelamento/assinatura, idempotência, concorrência de reserva, recusa de tenant novo antes do gate. Provas finais T05/T06/G3 dependentes de D10/D03 exigem semântica fechada; ensaios provisórios não aprovam G4. Se a decisão mudar, invalidar e repetir resultados afetados.

## Rollout

Antes de G4, somente Kidmais em tráfego real futuramente autorizado; A/B sintéticos em laboratório. Após G4, implantação gradual e monitorada. Downgrade de schema remove colunas apenas em fase posterior após demonstrar ausência de consumidores; nunca como reação imediata a incidente.

## Critérios de aceite

Cada gate tem evidência e aprovador; PRs separados/revisados; leitor legado impossibilitado de acessar dados multiempresa; recuperação não quebra isolamento nem conteúdo assinado.

## Questões em aberto

D12a CLOSED no [mapa estrutural](../SAAS-CONFIG-AUTHORITY-MAP.md). D12b — compatibilidade runtime/schema: direção aprovada; provas de writers/readers, cutover, reconciliação e rollback antes de cada rollout/G2, incluindo conflito estático produtor Festa/assinatura019 sem paridade executada. D12c — provisionamento/operação: evolui até antes do primeiro tenant externo quando não altera estrutura fundamental; testes de privilégio em G3 dependem do provisionamento correspondente. D10 — MUST_DECIDE_BEFORE_FIRST_TENANT: ordenação revogação/commit. Novas escolhas humanas de cutover/indisponibilidade não são presumidas nesta fase.
