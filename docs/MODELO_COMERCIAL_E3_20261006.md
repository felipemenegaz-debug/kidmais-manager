# E3 — Modelo comercial da empresa (migration 067)

Terceira entrega do plano de venda por assinatura ([PROPOSTA_VENDA_ASSINATURA_20261006.md](PROPOSTA_VENDA_ASSINATURA_20261006.md), §4.5 e §8).
Só o modelo e o cálculo do acesso; nada é aplicado às rotas ainda (isso é a E4).

## Eixos separados

| Eixo | Onde | Observação |
|---|---|---|
| Situação administrativa | `empresas.status` (existente) | Suspensão pela plataforma; não muda |
| Situação comercial | `empresa_assinaturas` (nova) | **Empresa sem linha = sem cobrança, acesso completo** (Kidmais e todas as empresas atuais). Só o cadastro público (E6) cria a linha, em `TESTE` |
| Exceções comerciais | `empresa_excecoes_comerciais` (nova) | `EXTENSAO_TESTE`, `CORTESIA`, `ACESSO_TEMPORARIO`; prazo ≤ 366 dias, motivo 5–500, imutáveis, revogação registrada, nunca apagadas |
| Representação legal | `empresa_representacoes` (nova) | Sócio/administrador, procurador ou responsável indicado; `DECLARADA → APROVADA/RECUSADA`, `APROVADA → REVOGADA`, decisão com motivo; **não concede acesso** |
| Permissões | `memberships` (existente) | Não muda |

## Acesso comercial (`lib/assinatura/acesso.ts`)

Calculado a cada requisição a partir das datas gravadas, sem tarefa agendada. Prazos aprovados (D8):

| Situação | COMPLETO | SOMENTE_LEITURA | BLOQUEADO |
|---|---|---|---|
| Sem assinatura | sempre | — | — |
| `TESTE` (30 dias) | até `teste_fim` | 60 dias depois | depois |
| `ATIVA` | até `periodo_atual_fim`; depois, 7 dias de regularização | 60 dias após a regularização | depois |
| `EM_ATRASO` | 7 dias desde `em_atraso_desde` | 60 dias | depois |
| `CANCELADA_FIM_PERIODO` | até o fim do período pago | 60 dias | depois |
| `ENCERRADA` | — | 60 dias desde `encerrada_em` | depois |

Exceção `CORTESIA` ou `ACESSO_TEMPORARIO` vigente → COMPLETO até o prazo dela. `EXTENSAO_TESTE` não libera por si: a
plataforma registra a exceção e avança `teste_fim` na mesma transação (E5). Dados inconsistentes falham fechado.
`lib/assinatura/estado.ts` lê o estado da empresa comprovada com o relógio do banco; sem a 067, acesso completo.

Regras D6/D7 (aprovadas) entram na E4: envio ao cliente final exige representação aprovada; contratos já enviados
continuam assináveis pelo cliente final quando o teste vence ou a cobrança falha.

## Migration 067 (NÃO APLICADA)

`database/migrations/20261006_067_modelo_comercial_empresa.sql`, rollback (recusa com qualquer dado comercial),
precheck/postcheck e inventário dos verificadores. Nenhuma tabela existente é alterada.

## Validação

- `lib/assinatura/acesso.test.ts` (7): todas as transições e prazos, exceções, falha fechada.
- `lib/assinatura/assinatura.postgres.test.ts` (PostgreSQL descartável, 6/6): CHECKs, unicidade do id no provedor,
  guardas de exceção e de representação, leitura do estado (sem linha = sem cobrança; teste vencido = somente leitura;
  cortesia libera), rollback. A suíte achou e corrigiu a leitura do relógio do banco (fuso `-03` sem minutos).
- `npm run check:v1:static` aprovado (06/10/2026).
