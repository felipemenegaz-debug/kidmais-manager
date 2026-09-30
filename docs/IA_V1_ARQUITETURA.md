# Kidmais Intelligence — AI Module V1: arquitetura, operação e troubleshooting

> Base: Foundation ([INTELIGENCIA_V1.md](INTELIGENCIA_V1.md), [INTELIGENCIA_PRODUCAO_V1.md](INTELIGENCIA_PRODUCAO_V1.md)).
> Segurança adversarial: [IA_V1_SEGURANCA.md](IA_V1_SEGURANCA.md). Estado congelado da entrega: [IA_V1_BASELINE.md](IA_V1_BASELINE.md).

## 1. Caminho de um pedido

```
Request (drawer / tela)
 → Auth (exigirApiAdminCrmDisponivel: sessão, origem, CSRF)
 → Tenant Context (withTenantTransaction / executarNoTenant: membership, papelAtual)
 → Context Builder (contexto autorizado; contexto de modelo minimizado)
 → Demerzel (orquestradora) → JEV (julgamento) → Skills → Agentes / Copiloto → Model Router
 → Policy V1 (manifesto + papel da membership + flags)
 → Tool Registry V1 (manifesto: entrada, prazo, saída)
 → Human Gate (CONFIRM: rascunho → preview → clique → revalidação total)
 → Serviços de domínio → PostgreSQL
```

Invariantes: nenhum LLM, JEV, skill ou agente fala com o banco; não existe ferramenta de SQL/shell; tenant,
usuário e papel nunca vêm do pedido nem do modelo; toda mutação passa pelo Human Gate com clique humano.

## 2. Componentes

| Componente | Onde | O que faz | O que NUNCA faz |
|---|---|---|---|
| JEV V1 | `lib/inteligencia/jev/v1` | Minimiza o texto (NFKC, ocultos, PII→marcador) e julga 5 dimensões por regras; modelo (ECONOMY, teto de confiança 0,8) só se as regras não entenderam; o mais restritivo vence | Conceder autoridade, ver tenant, afrouxar regra |
| Demerzel V1 | `lib/inteligencia/demerzel` | Orquestra por passos contados (teto de passos, de passos com modelo, de propostas, de custo, prazo, duplicidade); injeção e FORBIDDEN recusados antes de tudo | Chamar porta crua, executar ação, laço sem teto |
| Skills V1 | `lib/inteligencia/skills`, `lib/ia-persistencia/skills.ts` | Conteúdo de forma (tom, templates, objeções, procedimentos) com hash, revisão e varredura; Plataforma (base, código) → Empresa → Estabelecimento (overrides em `ia_skills`, 058), camadas decididas pela Policy | Preço, desconto, permissão, mudança de política (recusados na varredura) |
| Context Builder V1 | `lib/inteligencia/contexto` | Único formato que chega a um modelo: blocos da empresa comprovada, redação de nomes/PII/instruções, limites, barreira final | Levar ids, contatos, dados de criança, texto de pessoa, conteúdo de outra empresa |
| Copiloto V1 | `lib/inteligencia/copiloto` | Perguntas por tela, navegação, próxima ação (procedimento de skill) e explicação por modelo validada contra os dados | Ser fonte de fato; afirmar ação feita; inventar número/id |
| Agentes V1 | `lib/inteligencia/agentes` | Atendimento, Analista Operacional, Documentos e Copiloto Administrativo: planos fechados, determinísticos, sobre as portas contadas | Enviar mensagem, assinar, negociar, ler fora da própria lista |
| Tool Registry V1 | `lib/inteligencia/registro-ferramentas.ts` | Manifesto de toda leitura/sugestão/ação; gateway aplica entrada, prazo e saída | Oferecer ação sem manifesto |
| Policy V1 | `lib/inteligencia/politica-v1.ts` | Decisão única: manifesto, FORBIDDEN, classe×caminho, origem da confirmação, papel da membership, flags | Aceitar papel/tenant do pedido |
| Human Gate | `lib/inteligencia/acoes` | Rascunho persistido, preview, confirmação idempotente (versão+hash), revalidação total a cada passo | Executar por texto; reutilizar aprovação |
| Observabilidade V1 | `lib/inteligencia/rastreio.ts`, `metricas.ts` | Trace fechado e saneado; métricas agregadas | Registrar texto, PII, segredo |
| Custos V1 | `lib/inteligencia/custos.ts`, `lib/ia-persistencia/uso.ts` | Visão consolidada da empresa (Gestão); orçamento fail-closed no Model Router | Transformar custo desconhecido em zero |
| UX V1 | `components/admin/inteligencia` | Informação / Sugestão / Exige confirmação / Erro em texto; cancelar; repetir com segurança | Mostrar confiança numérica; enviar rascunho |

## 3. Classes de capacidade (Human Gates)

| Classe | Exemplos | Execução |
|---|---|---|
| READ | leituras do registro fechado (`atencao_hoje`, `contratos_pendentes`, `resumir_festa`, `pacotes_disponiveis`, `comparar_versoes_contrato`…) | Gateway, com Policy e Tenant Context |
| SUGGEST | `redigir_mensagem`, `orientar_objecao`, `proxima_acao`, `explicar_dados` | Agente/Copiloto; Policy antes de resolver a skill; nada é enviado nem gravado |
| CONFIRM | `criar_pacote`, `editar_pacote`, `ativar_pacote`, `desativar_pacote`, `importar_contrato` | Somente Human Gate, com clique humano |
| FORBIDDEN | `sql`, `excluir`, buffet global, `mutacao_nao_suportada` | Nunca; recusa explicada |

## 4. Tool Registry e Policy

Cada manifesto: `nome`, `capacidade`, `dominio`, `classe`, `papeisExigidos` (requiredRole), `grupoExigido`
(requiredCapability), `escopoTenant = EMPRESA_COMPROVADA`, `escopoEstabelecimento = COMPANY | ESTABLISHMENT`, `entrada`
(inputSchema), `saida` (outputSchema), `prazoMs`, `idempotencia`, `auditoria`, `executor`.
`validarRegistro` barra: SQL/shell executável, entrada que aceita empresa/usuário/papel, FORBIDDEN com papel,
CONFIRM fora do Human Gate, SUGGEST com efeito.

Policy V1 (primeira negação vence): sem manifesto → FORBIDDEN → classe×caminho → confirmação só com origem
`HUMAN_GATE` → papel conhecido e exigido (da membership) → flag + allowlist da empresa. Aplicada no gateway
(antes e dentro do tenant), em cada passo do Human Gate e antes de toda sugestão.

## 4.1 Establishment Context

- A unidade vem SÓ do pedido da tela (`?estabelecimentoId=`, como `?empresaId=`); nunca do corpo, do texto ou do modelo.
- `comEstabelecimento` (gateway) prova a unidade em TODA transação de tenant do pedido, logo depois da membership, pelo
  Core (`lib/saas/provar-estabelecimento.ts`): unidade da empresa comprovada, `ATIVO`, com vínculo `ATIVA` e vigente
  da membership. Qualquer falha ⇒ 404 "Unidade não encontrada" para o pedido inteiro (nunca cai para a empresa).
- Tool Registry: `COMPANY` (dado da empresa) ou `ESTABLISHMENT` (operacional por unidade, filtra por
  `contexto.estabelecimento`). Policy V1: `ESTABLISHMENT` sem unidade comprovada ⇒ `NEGADO_ESTABELECIMENTO`.
- Context Builder: `ContextoAutorizado.estabelecimentoId` = unidade comprovada; bloco lido noutra unidade ⇒ recusa
  (`OUTRO_ESTABELECIMENTO`). Skills: override de estabelecimento só com unidade comprovada. Trace e `ModelUsage`
  carregam `estabelecimentoId`; custos agregam por unidade.
- Estado do Core: a 043 mantém o caminho operacional da unidade FECHADO (unidade nasce SUSPENSO, vínculo SUSPENSA; D03)
  e os dados operacionais (festas, contratos, financeiro, clientes, pacotes) não têm unidade. Por isso todas as
  leituras V1 são `COMPANY` e, hoje, nenhuma unidade é comprovável (fail-closed). Quando o Core abrir D03 e der unidade
  a esses dados, cada leitura passa a `ESTABLISHMENT` no registro — sem mudar Policy, contexto, skills ou trace.

## 4.2 Skills por empresa e por unidade

- Base: as skills da PLATAFORMA (código revisado). Camadas: `ia_skills` (migration 058, **não aplicada**) guarda versões
  de override da EMPRESA e do ESTABELECIMENTO; cada linha é a skill completa (proveniência, revisão, hash, permissões,
  restrições, conteúdo) e o banco garante escopo, coerência com as colunas, versão imutável (nova versão = nova linha),
  uma ATIVA por (empresa, unidade, skill), transições RASCUNHO → ATIVA ↔ SUSPENSA → ARQUIVADA, sem DELETE/TRUNCATE.
- Resolução determinística: Plataforma → Empresa → Estabelecimento, sempre sobre uma skill da plataforma de mesmo id
  (skill nova da empresa ⇒ `SEM_BASE_PLATAFORMA`); tom/templates/objeções/procedimentos refinados por chave, instruções e
  restrições acumuladas (as da plataforma nunca saem), classes só estreitam.
- Policy das camadas: plataforma sempre; EMPRESA com `AI_SKILLS_EMPRESA_ENABLED=true` + allowlist; ESTABELECIMENTO com
  isso E unidade COMPROVADA. O catálogo revalida schema, hash, revisão APROVADA/RESTRITA sobre o hash atual, escopo e
  varredura de conteúdo (preço, desconto, contrato, pagamento, papel/permissão, capacidade, Human Gate, tenant/unidade).
- Sem escrita pela IA: o cadastro e a aprovação de skills de empresa são um fluxo futuro do Admin.

## 5. Observabilidade

Uma linha JSON por pedido (`[Kidmais Inteligência]`), saneada (`sanearRastreio`): `traceId`, `requestId`,
`empresaId` (tenant), `estabelecimentoId` (null na V1), `usuarioId`, `capacidade`, `skills`, `classificadorJev`,
`provedor`, `modelo`, `tokensEntrada/Saida`, `custoEstimadoMicros` (null se desconhecido), `duracaoMs`,
`fallback`, `fallbackProvedor`, `propostaAcao`, `humanGate`, `resultado`, `codigo`, `causa`, `politica`,
`ferramentasSolicitadas/Executadas`, `orquestracao` (passos, parada, julgamento), `versaoRegistro`, `versaoPolitica`.
Linhas adicionais: `[Kidmais JEV]`, `[Kidmais Copiloto]`, `[Kidmais IA uso]` (sem tabela), `[Kidmais IA alerta]`,
`[Kidmais Skills alerta]`. AI trace ≠ auditoria de negócio (esta continua no domínio, na transação da mutação).

`agregarMetricas` agrega linhas de trace (contagens, taxa de fallback, p50/p95, tokens/custo com desconhecidos).

## 6. Orçamento e custos

- Sem `AI_BUDGET_JSON` válido com teto aplicável ⇒ nenhuma chamada de modelo (fail-closed).
- Teto de custo exige preço conhecido (`AI_PRICING_JSON`) e mesma moeda; senão, recusa.
- Reserva antes da chamada, com `pg_advisory_xact_lock` por empresa; reconciliação com os períodos da reserva.
- `POST /api/admin/inteligencia/custos` (Gestão): visão do mês por estabelecimento, capacidade, modelo e dia,
  reservas abertas à parte; custo desconhecido ⇒ `null` + contador.

## 7. Flags (só o texto exato `true` liga)

`INTELIGENCIA_ENABLED` (mestra) · `AI_READ_ENABLED` · `AI_ADMIN_ACTIONS_ENABLED` · `AI_CONTRACT_IMPORT_ENABLED` ·
`AI_TENANT_ALLOWLIST` · `AI_SKILLS_EMPRESA_ENABLED` · `AI_JEV_ENABLED` · `AI_JEV_MODEL_ENABLED` · `AI_DEMERZEL_ENABLED` · `AI_COPILOTO_MODEL_ENABLED` ·
`AI_FALLBACK_ENABLED` · `AI_DOCUMENT_EXTERNAL_PROVIDER_ALLOWED`. Configuração: `AI_PROVIDER_PRIMARY/ECONOMY`,
`AI_OPENAI_*`, `AI_DEEPSEEK_*`, `AI_WORKLOAD_TIERS`, `AI_MODEL_TIMEOUT_MS`, `AI_MODEL_MAX_RETRIES`,
`AI_BUDGET_JSON`, `AI_PRICING_JSON`, `AI_CONFIRMACAO_TTL_SEGUNDOS`, `AI_UPLOAD_MAX_BYTES`.

## 8. Runbooks

**Desligar a IA inteira**: `INTELIGENCIA_ENABLED` ≠ `true`. Nenhuma rota abre sessão ou banco; Core intacto.

**Desligar só o modelo** (manter regras): remover `AI_JEV_MODEL_ENABLED`, `AI_COPILOTO_MODEL_ENABLED` ou o
orçamento. JEV, Demerzel, agentes e leituras seguem determinísticos.

**Desligar a orquestradora**: `AI_DEMERZEL_ENABLED` ≠ `true` ⇒ roteamento direto da Foundation (sem agentes).

**Suspender ações**: `AI_ADMIN_ACTIONS_ENABLED` ≠ `true`. Rascunhos abertos param de avançar; confirmações
recusadas com 503 (revalidação de flag no clique).

**Restringir por empresa**: `AI_TENANT_ALLOWLIST` com os uuids liberados (inválida ⇒ nenhuma empresa).

**Custo subindo**: consultar `/api/admin/inteligencia/custos`; reduzir tetos em `AI_BUDGET_JSON` (efeito na
próxima reserva); `recuperarOrfas` fecha reservas abertas antigas como ÓRFÃS (consumo mantido).

**Skill suspeita**: skills da plataforma são código revisado. Skill de empresa/unidade: `UPDATE ia_skills SET status =
SUSPENSA` na versão (efeito imediato: só ATIVAS são lidas) ou desligar `AI_SKILLS_EMPRESA_ENABLED` (todas as camadas da
empresa saem). Alerta `SKILL_RECUSADA` no log (id, nível, motivos; nunca conteúdo) indica tentativa recusada.

## 9. Troubleshooting

| Sintoma | Causa provável | Onde olhar |
|---|---|---|
| 503 `INTELIGENCIA_DESATIVADA` | Flag mestra/grupo desligado ou empresa fora da allowlist | flags; `politica: NEGADO_FLAG` no trace |
| 403 `INTELIGENCIA_NAO_AUTORIZADA` | Papel da membership sem permissão; Policy negou | `politica` no trace (`NEGADO_PAPEL`, `NEGADO_CLASSE`, `NEGADO_ORIGEM`) |
| 400 `CAPACIDADE_DESCONHECIDA` | Leitura/ação sem manifesto no Tool Registry | `registroCompleto(...).problemas` |
| 503 com `causa: TEMPO` | Leitura estourou `prazoMs` do manifesto | serviço de domínio lento |
| 503 com `causa: SAIDA` | Saída da ferramenta fora do outputSchema (ou chave sensível) | montar* da leitura |
| Resposta sem explicação | Sem flag do Copiloto, orçamento, provedor, ou explicação recusada (`NUMERO_INVENTADO`, `INSTRUCAO`…) | `[Kidmais Copiloto]` |
| "Não sigo instruções…" | JEV/Demerzel detectou injeção | `orquestracao.parada = RECUSA_INJECAO` |
| Rascunho não confirma | Versão/hash mudou, expirou, papel/flag mudou | `humanGate`, `codigo` no trace `inteligencia.operacao` |
| Custos `disponivel: false` | Tabelas `ia_uso_modelo`/`ia_orcamento_reservas` ausentes (055a) | migrations |
| Agente respondeu com dados da própria empresa quando citei outra | (corrigido na V1) JEV recusa empresa citada por id | `SINAL_OUTRO_TENANT` |
