# ADRs da Fundação SaaS — Fases 1B-C / 1B-C1 / 1B-C2

Atualização documental 1B-C2 em 2026-09-22, baseada nas decisões expressas do usuário e inventário estático. Não autoriza migrations, banco, runtime, deploy, início da 1C ou commit/push/merge.

## Governança e precedência

A série tem namespace **SaaS/ADR-001 a SaaS/ADR-010**. Os identificadores históricos **LEGACY/ADR-001 a LEGACY/ADR-003** continuam nos [ADRs aprovados](../../arquitetura/ADR/), sem renumeração, substituição ou revogação. Citar caminho/namespace evita ambiguidade.

ACCEPTED significa decisão estrutural expressamente aprovada, não schema implementado. PARTIALLY ACCEPTED separa direção aprovada de OPEN DECISION remanescente. Detalhes físicos explicitamente delegados à 1C não são escolhas humanas inventadas nesta fase. Nenhum status individual supera os gates do conjunto.

## Índice e status

| ID | Documento | Status 1B-C2 |
| --- | --- | --- |
| SaaS/ADR-001 | [Modelo de tenancy](ADR-001-MODELO-DE-TENANCY.md) | ACCEPTED |
| SaaS/ADR-002 | [Tenant Context](ADR-002-TENANT-CONTEXT.md) | ACCEPTED |
| SaaS/ADR-003 | [Memberships e RBAC](ADR-003-MEMBERSHIPS-E-RBAC.md) | PARTIALLY ACCEPTED — D03/D10 abertas |
| SaaS/ADR-004 | [Isolamento de dados](ADR-004-ISOLAMENTO-DE-DADOS.md) | ACCEPTED |
| SaaS/ADR-005 | [Ownership dos domínios](ADR-005-OWNERSHIP-DOS-DOMINIOS.md) | ACCEPTED — D11c CLOSED; D11b futura |
| SaaS/ADR-006 | [Configuração e herança](ADR-006-CONFIGURACAO-E-HERANCA.md) | ACCEPTED |
| SaaS/ADR-007 | [Migração da Kidmais atual](ADR-007-MIGRACAO-KIDMAIS-INICIAL.md) | ACCEPTED |
| SaaS/ADR-008 | [Rollout e compatibilidade](ADR-008-ROLLOUT-E-COMPATIBILIDADE.md) | PARTIALLY ACCEPTED — D12a CLOSED; provas D12b/c pendentes |
| SaaS/ADR-009 | [Auditoria e identidade](ADR-009-AUDITORIA-E-IDENTIDADE.md) | ACCEPTED |
| SaaS/ADR-010 | [Roles e segurança PostgreSQL](ADR-010-ROLES-E-SEGURANCA-POSTGRESQL.md) | ACCEPTED |

Entradas complementares:

- [Ownership das 63 tabelas](../OWNERSHIP-V1-63.md).
- [Invariantes, inventário D12a, testes e gates](../SAAS-VALIDACAO-E-GATES.md).
- [Mapa completo de fontes, consumidores e autoridade D12a](../SAAS-CONFIG-AUTHORITY-MAP.md).
- [Baseline congelado](../../baseline/V1-POST-019.md).
- [Permissões oficiais](../../arquitetura/PERMISSOES.md).
- [Fluxo de trabalho](../../07-FLUXO-DE-TRABALHO.md).

## Registro das decisões

| ID | Estado / classificação | Conteúdo aprovado ou pendência | Limite |
| --- | --- | --- | --- |
| D01 | ACCEPTED | PostgreSQL/schema compartilhados; empresa_id tenant; unidade operacional quando aplicável; aplicação + integridade + RLS | Detalhe físico na 1C, sem banco por empresa como opção inicial |
| D02 | ACCEPTED | Identidade administrativa global única, sem acesso global; memberships/grants explícitos | Representação na 1C |
| D03 | OPEN DECISION — MUST_DECIDE_BEFORE_FIRST_TENANT | Uma/várias unidades explícitas; não assumir acesso a unidades futuras | Produto/segurança antes do primeiro tenant externo |
| D04 | ACCEPTED como direção | Default da empresa + override da unidade; resolução determinística e referência/identidade/versionamento efetivo; histórico não reinterpretado | Representação física e FKs na 1C |
| D05 | ACCEPTED | Conexão WhatsApp EMPRESA + associações tenant-aware às unidades; várias conexões, sem 1:1 presumido | Desenho das associações/roteamento na 1C; nunca compartilhamento cross-company |
| D06 | ACCEPTED como direção | Autenticar → descoberta mínima autorizada → contexto → conexão/transação → transaction-local → operação → encerramento sem resíduo; fail closed | Policies, FORCE por categoria, grants e provas na 1C/implementação |
| D07 | ACCEPTED como direção | Kidmais = uma empresa + um estabelecimento inicial; raízes autoritativas; backfill verificável/idempotente; efêmeros sem atribuição inventada | Plano executável e reconciliação antes de backfill |
| D08 | ACCEPTED como direção | Chaves diretas preferidas; sidecar somente excepcional com cobertura/integridade/atomicidade/escopo/policies; provas históricas intocadas | Justificativa por tabela na 1C |
| D09 | ACCEPTED como direção | Evento autorizado no contexto legítimo; negação no solicitante com alvo não verificado; sem contexto usa canal separado; não enumerar B | Representação na 1C; retenção/durabilidade antes de habilitar fluxos |
| D10 | OPEN DECISION — MUST_DECIDE_BEFORE_FIRST_TENANT | Semântica de revogação frente a transações concorrentes não fechada | Segurança/arquitetura antes da habilitação multi-tenant externa |
| D11a | ACCEPTED | CRM pertence à empresa; relações independentes da mesma pessoa em empresas diferentes | Sem CPF/telefone/e-mail como autorização cross-tenant |
| D11b | CAN_DEFER | Identidade global opcional de CLIENTES, distinta da identidade administrativa; vínculo futuro opcional sem trocar PK/ownership CRM | Fluxo futuro do titular, privacidade e auditoria; desabilitado até desenho/aprovação próprios |
| D11c | CLOSED — política aprovada | CRM único por empresa; operador de unidade acessa mínimo autorizado por vínculo/fluxo legítimo; resolução sem diretório nem acesso retroativo a outra unidade | APIs de resolução/CRM/operação separadas; fundamento verificável e auditoria; representação na 1C |
| D12a | CLOSED — inventário estrutural | Mapa de fontes/chaves/consumidores, autoridade, conflitos, hardcodes, histórico e impactos concluído e revisado estaticamente | Não é prova D12b; conflitos técnicos permanecem obrigações antes do rollout |
| D12b | Direção ACCEPTED; evidência pendente | Rollout incremental; tenant NULL só transitório single-tenant; retirar escritores antigos, reconciliar, impedir sem escopo, remover leitura global, ativar constraints e provar isolamento | Antes de cada rollout/G2 e obrigatoriamente antes da segunda empresa |
| D12c | PENDENTE — MUST_DECIDE_BEFORE_FIRST_TENANT | Provisionamento/operação/rotação sem alterar estrutura fundamental | Preparar roles antes dos testes G3 e fechar operação antes de G4 |

D11c foi respondida expressamente na 1B-C2. [SaaS/ADR-005](ADR-005-OWNERSHIP-DOS-DOMINIOS.md) é a política canônica: nenhum ID/CPF/contato concede acesso; fluxo legítimo pode reutilizar o CRM empresarial com mínimo necessário sem duplicar cliente, sem liberar operações privadas de outra unidade. Vínculos/grants físicos serão detalhados na 1C dentro desses limites.

D12a tem evidências e conflitos delimitados no [mapa de autoridade](../SAAS-CONFIG-AUTHORITY-MAP.md). Nenhuma nova escolha humana BLOCKER_1C foi identificada; fechar inventário não resolve incompatibilidades runtime/schema ou prova isolamento. D03/D10 permanecem abertas por instrução expressa; não reclassificá-las como resolvidas.

## Dependências e próxima fase

D01/D02 aprovadas sustentam memberships e contexto. D04/D05 aprovadas sustentam configuração efetiva e integração. D09 delimita descoberta/auditoria e D08 preserva históricos. D07 fixa cardinalidade inicial, não elimina checagens de coerência nem aprova grants arbitrários.

Antes da 1C: revisar/aprovar este pacote, com D12a/D11c fechadas. Na 1C autorizada separadamente: detalhar chaves/FKs/policies, representação de herança/associações WhatsApp/visibilidade CRM, exceções de imutabilidade e plano de backfill. Antes do rollout: D12b e provas de compatibilidade, incluindo K10 (019/runtime). Antes do primeiro tenant externo: D03/D10/D12c, testes cross-tenant e G4. D11b não bloqueia primeira migration nem muda CRM empresa-owned.

## Limite de aprovação

As decisões humanas aprovadas foram incorporadas sem SQL ou alteração funcional. D11c CLOSED e D12a CLOSED removem os dois blockers documentais prévios; não concedem autorização de execução, commit ou início da 1C. Permanecer documental até revisão do usuário.
