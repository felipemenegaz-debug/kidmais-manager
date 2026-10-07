# E5 — Painel comercial do desenvolvedor (07/10/2026)

Empilhada sobre o paywall (E4). Sem migration própria (usa 067 + 068).

## O que o desenvolvedor vê

| Onde | Conteúdo |
|---|---|
| Lista de contratantes | Coluna **Comercial**: "Sem cobrança" ou situação · nível de acesso, com a data em que muda |
| Ficha da empresa → **Situação comercial** | Situação (teste, ativa, pendente, cancelada, encerrada), nível de acesso e prazo, plano e ciclo, datas do teste e do período pago, atraso; exceções (tipo, prazo, motivo, autor, revogação); eventos do provedor; histórico comercial auditado |
| Ficha → Implantação, responsável e convites | Já existentes (063; checklist e alertas na PR do painel) |

Dados exibidos vêm só das tabelas comerciais, de `auditoria` e de `cobranca_eventos` (só identificadores). Nenhum dado
operacional da empresa é lido.

## Intervenções (`POST /api/desenvolvedor/empresas/:id` com `acao: 'comercial'`)

| Operação | Regras |
|---|---|
| `estender-teste` | Só em `TESTE`; 1–60 dias, contados do maior entre o fim atual e agora; grava exceção `EXTENSAO_TESTE` |
| `conceder-excecao` | `CORTESIA` ou `ACESSO_TEMPORARIO`; 1–365 dias; acesso completo até o prazo; recusada para empresa sem cobrança |
| `revogar-excecao` | Só exceção vigente da própria empresa; extensão de teste não é revogável (o prazo já está no teste) |

Toda intervenção exige: concessão de desenvolvedor conferida **na transação**; senha confirmada há no máximo 5 minutos
(diálogo de reautenticação); motivo de 5 a 500 caracteres; prazo. É auditada (`COMERCIAL_TESTE_ESTENDIDO`,
`COMERCIAL_EXCECAO_CONCEDIDA`, `COMERCIAL_EXCECAO_REVOGADA`, origem `PAINEL_DESENVOLVEDOR`) com ator, empresa,
antes/depois e motivo.

**Não confundir com a concessão de desenvolvedor**: nenhuma intervenção comercial toca `plataforma_desenvolvedores`,
papel global, memberships ou dados de negócio. A concessão de desenvolvedor continua só pelo CLI
(`node scripts/admin-provision.cjs desenvolvedor`).

## Validação

- PostgreSQL descartável (`lib/desenvolvedor/comercial.postgres.test.ts`, modelo 063 + 067 + 068) 5/5:
  Gestão sem concessão → 404; senha antiga → reautenticação; motivo curto recusado; extensão avança o prazo, audita e
  não muda concessões/vínculos/papéis; cortesia libera e revogação devolve; outra empresa não alcança a exceção;
  empresa sem cobrança recusa; ficha e lista trazem o comercial.
- `lib/desenvolvedor/painel-063.postgres.test.ts` 33/33 nesta árvore; `painel.test.ts` (inclui `comercial.ts` na
  verificação estática de concessão dentro da transação).
- Navegador (`scripts/assinatura-paywall-ui.cjs`, cenário `E2E_PAINEL_COMERCIAL_OK`): lista com a situação comercial;
  cortesia concedida pela ficha com prazo e motivo; histórico atualizado; auditoria gravada; a Gestão da empresa volta a
  escrever; o desenvolvedor não ganha vínculo.
