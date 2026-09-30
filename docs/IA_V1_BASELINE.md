# AI MODULE V1 BASELINE

Estado congelado do AI Module V1 do Kidmais Manager, entregue como pilha de branches locais sobre a Foundation
(`ai-v1/00-tooling` … `ai-v1/15-gates`), verificada por `node scripts/ia-v1-pilha.cjs` (`check:ia:prs`).
Arquitetura e operação: [IA_V1_ARQUITETURA.md](IA_V1_ARQUITETURA.md). Segurança: [IA_V1_SEGURANCA.md](IA_V1_SEGURANCA.md).

## Componentes e versões

| Componente | Versão | Branch da pilha |
|---|---|---|
| Tooling (manifesto Foundation congelado + pilha V1) | — | `ai-v1/00-tooling` |
| JEV | `jev-v1.0.0` | `ai-v1/01-jev` |
| Demerzel | `demerzel-v1.0.0` | `ai-v1/02-demerzel` |
| Skills | `skills-v1.0.0` (+ camadas de empresa/unidade em `ia_skills`, 058, `ai-v1/17-skills-empresa`); `tom_kidmais@1.0.0#324d6d44`, `atendimento_familias@1.0.0#b045e8ea`, `procedimentos_operacionais@1.0.0#a626e6ad` (RESTRITAS) | `ai-v1/03-skills` |
| Context Builder | `contexto-v1.0.0` | `ai-v1/04-contexto` |
| Copiloto | `copiloto-v1.0.0` | `ai-v1/05-copiloto` |
| Agentes | `agentes-v1.0.0` (atendimento, analista_operacional, documentos, administrativo) | `ai-v1/06-agentes` |
| Tool Registry | `tool-registry-v1.0.0` | `ai-v1/07-ferramentas` |
| Policy | `policy-v1.0.0` | `ai-v1/08-politica` |
| Observabilidade | trace V1 + `agregarMetricas` | `ai-v1/09-observabilidade` |
| Custos | visão consolidada + orçamento fail-closed | `ai-v1/10-custos` |
| UX | drawer V1 (categorias, agentes, Copiloto, cancelar, repetir) | `ai-v1/11-ux` |
| Segurança adversarial | 18 vetores, achados corrigidos | `ai-v1/12-seguranca` |
| Cenários integrados | A–J | `ai-v1/13-integrado` |
| Documentação | este baseline | `ai-v1/14-docs` |
| Gates finais | suíte PostgreSQL de custos + correção do auto-review | `ai-v1/15-gates` |

## Flags (padrão: tudo desligado)

| Flag | Liga | Depende de |
|---|---|---|
| `INTELIGENCIA_ENABLED` | IA inteira (sem ela: nenhuma rota abre sessão ou banco) | — |
| `AI_READ_ENABLED` | Leituras novas e texto livre | mestra |
| `AI_ADMIN_ACTIONS_ENABLED` | CONFIRM de cadastro (Human Gate) | mestra + tabela `ia_operacoes` (055) |
| `AI_CONTRACT_IMPORT_ENABLED` | Importação de contrato histórico | mestra + 055b–d |
| `AI_TENANT_ALLOWLIST` | Restringe grupos a empresas listadas | — |
| `AI_SKILLS_EMPRESA_ENABLED` | Camadas de skill da empresa e da unidade (sobre a plataforma) | mestra + 058 aplicada |
| `AI_JEV_ENABLED` / `AI_JEV_MODEL_ENABLED` | Classificador auxiliar / modelo do JEV | mestra; modelo exige orçamento |
| `AI_DEMERZEL_ENABLED` | Orquestradora + agentes | mestra |
| `AI_COPILOTO_MODEL_ENABLED` | Explicação por modelo | mestra + orçamento + provedor |
| `AI_FALLBACK_ENABLED` | Troca de provedor em falha | — |
| `AI_DOCUMENT_EXTERNAL_PROVIDER_ALLOWED` | Documento a provedor externo | decisão explícita |

## Testes

| Suíte | Comando |
|---|---|
| Unidade/arquitetura da IA (JEV, Demerzel, Skills, Contexto, Copiloto, Agentes, Registry, Policy, Observabilidade, Custos, Segurança, Integrados A–J) | `npm run test:inteligencia` |
| UI da IA + importação | `npm run test:ia-demo` |
| Navegação UI V1 | `npm run check:v1:ui` |
| Regressão estática (testes, lint, tsc, build) | `npm run check:v1:static` |
| Manifesto Foundation + pilha V1 | `npm run check:ia:prs` |
| PostgreSQL real (cluster descartável) | `npm run check:v1:postgres` |

Números e resultados da execução final estão no relatório do Master Goal (Fase 15).

## Limitações conhecidas

- Agentes são determinísticos (sem LLM): respondem só aos gatilhos declarados; o resto segue o fluxo normal.
- Establishment Context implementado (prova no Core, escopo COMPANY/ESTABLISHMENT, Policy, contexto, skills, trace, custos).
  Todas as leituras V1 são `COMPANY` porque os dados do Core não têm unidade e a 043 mantém a unidade fechada (D03):
  hoje nenhuma unidade é comprovável e a IA opera no escopo da empresa, fail-closed.
- Skills de empresa/unidade: armazenamento e resolução prontos (058, não aplicada); o cadastro/aprovação pelo Admin é
  fluxo futuro — até lá, só a plataforma (e o que for gravado por operação autorizada).
- Detecção de injeção é por padrões; a segurança real vem da arquitetura (sem ferramentas no modelo, Policy, Human Gate).
- Explicação por modelo pode conter afirmação não numérica falsa; é rotulada como sugestão, abaixo dos dados.
- Visão de custos e orçamento em PostgreSQL dependem da 055a aplicada; sem ela, `disponivel: false` e nenhuma chamada paga.
- Marketing/Vendas, autonomia financeira, envio de mensagens e assinatura: fora do escopo da V1.

## Gates de staging

1. Merge da pilha em ordem (00 → 15), um PR por fase, com `check:ia:prs` verde a cada passo.
2. `check:v1:static`, `check:v1:ui`, `test:ia-demo` e `check:v1:postgres` (cluster descartável) verdes no HEAD de staging.
3. Migrations 055/055a–d e 058 aplicadas em staging **somente com autorização**, seguindo `docs/OPERACAO_AGENTES.md`.
4. Flags ligadas por etapa, com `AI_TENANT_ALLOWLIST` só para a empresa de teste: READ → Demerzel → ações → modelo.
5. Orçamento e pricing configurados (tetos baixos) antes de qualquer flag de modelo.
6. Smoke autenticado da Foundation em staging: **concluído** (login do Felipe após o deploy; Configurações validadas; PRs #14 e #15 em staging — o HEAD atual de staging é a fonte de verdade). Depois de ligar as flags da V1: smoke funcional da IA (leituras, rascunho do agente de atendimento, um CONFIRM de pacote cancelado e um confirmado; traces e `/custos`).
7. Revisão independente das skills da plataforma (hoje RESTRITAS).

## Gates de produção

1. Staging estável com a pilha inteira e as flags acima por pelo menos um ciclo de uso real.
2. Decisão humana registrada sobre: estabelecimento no Tenant Context; armazenamento de skills de empresa; custo recorrente aceito (tetos de `AI_BUDGET_JSON`).
3. Provedor e modelo aprovados (contrato, dados enviados: só o contexto minimizado).
4. Backup e plano de rollback: flags desligam a IA sem tocar no Core; migrations 055* têm rollback documentado.
5. Monitoramento dos traces (`resultado`, `causa`, `politica`, `fallback`, `custoEstimadoMicros`) e alertas de orçamento.
6. Liberação por allowlist, empresa a empresa.
