# Kidmais Intelligence V1 — fundação (PR1)

Primeira capacidade: **“O que precisa da minha atenção hoje?”**, somente leitura e **sem LLM**.

## Fluxo

`POST /api/admin/inteligencia` com corpo `{ "capacidade": "atencao_hoje" }`

1. Flag `INTELIGENCIA_ENABLED` (só `true` liga). Desligada: `503 INTELIGENCIA_DESATIVADA`, sem sessão nem banco.
2. Sessão, origem e CSRF: `exigirApiAdminCrmDisponivel` (mesmo guard do Admin).
3. Corpo com schema estrito. Não aceita `empresaId`, `usuarioId` nem texto livre. `parametros` ausente equivale a `{}`; `parametros: null` é recusado com 400.
4. Registro fechado de ferramentas (`lib/inteligencia/ferramentas.ts`).
5. Política (`lib/inteligencia/politica.ts`): só classe `READ`; papel desconhecido é recusado; a ferramenta declara os mesmos papéis que já acessam a informação nas telas. A IA não amplia o RBAC.
6. Tenant: `withTenantTransaction` (prova e revalida a membership). A seleção de empresa usa o mesmo `?empresaId=` das rotas do Financeiro.
7. Ferramenta `atencao_hoje` chama `listarRecebiveis` e monta texto e evidências de forma determinística.
8. Trace: uma linha JSON (`[Kidmais Inteligência]`) com request id, usuário, empresa, ferramenta, resultado, duração, fallback e `causa`. Sem nomes, valores, texto do pedido ou mensagens de erro.

A `causa` é uma classificação fechada: `FLAG`, `VALIDACAO`, `AUTENTICACAO`, `POLITICA`, `TENANT`, `RECUSA_CORE`, `BANCO`, `DOMINIO` ou `INESPERADO`. Nunca registra `error.name`, mensagem, `code` ou stack do erro original.

Falha inesperada: `503 INTELIGENCIA_INDISPONIVEL`, com mensagem humana. Dashboard e Financeiro não dependem deste módulo.

## O que “somente leitura” significa

- A AI Foundation não faz mutação de negócio nem de domínio. Nenhuma ferramenta ou capacidade da IA executa INSERT, UPDATE ou DELETE de dados de negócio nesta fase.
- Atualizações operacionais da sessão pelo guard administrativo existente continuam permitidas. Hoje `exigirApiAdminCrmDisponivel` atualiza `sessoes_administrativas.ultima_atividade_em`, como em qualquer rota do Admin. Isso é do mecanismo de autenticação do Core, não uma escrita da IA, e não há guard especial para a IA.
- `provarTenant` usa `SELECT … FOR UPDATE` (leitura com lock) para comprovar a membership. Também não altera dados.

## Escopo de dados

- Somente o Financeiro, com tenant comprovado. Clientes, Festas, Contratos, Pagamentos e Disponibilidade ficam fora até terem isolamento por empresa.
- `painelGeral` não é chamado: ele também lê a agenda de Festas/Contratos e, via `listarContasPagar`, grava categorias padrão.
- A evidência é só agregada: fonte, quantidade, valor total e, nos vencidos, o maior atraso em dias. Nenhum registro individual, id, nome, contato, pacote ou forma de pagamento.
- O detalhamento (drill-down) é a tela de origem, `/admin/financeiro/contas-receber`, que já lista os registros com o mesmo tenant comprovado. Por isso a resposta não precisa de ids.
- Esse formato agregado é o único que um futuro contexto de modelo poderá receber.

## Contrato para a futura UI

| Necessidade | Campo |
|---|---|
| Estado | `data.estado`: `atencao`, `em_dia` ou `sem_dados` |
| Resumo | `data.resumo` |
| Prioridade e tipo | `data.itens[].prioridade` (`alta`/`media`/`baixa`), `data.itens[].tipo` |
| Evidência | `data.itens[].evidencia` |
| Link de origem | `data.itens[].destino` |
| Freshness | `data.referencia.hoje`, `data.referencia.geradoEm` |
| Erro/fallback | `ok: false` com `codigo` `INTELIGENCIA_INDISPONIVEL` (503) ou `INTELIGENCIA_DESATIVADA` (503) |

Rótulos visuais, ícones e cores ficam na camada de apresentação.

**Os itens são indicadores independentes e não devem ser somados.** `A_RECEBER_EM_ABERTO` é o total em aberto e já inclui `RECEBIVEIS_VENCIDOS` e `RECEBIVEIS_VENCEM_HOJE`. A UI deve exibir cada item com o seu próprio valor, sem calcular totais a partir deles.

Erros de pedido (JSON inválido, schema do pedido ou parâmetros da ferramenta) respondem `400 DADOS_INVALIDOS`. Depois que o pedido é validado, qualquer falha inesperada, inclusive um `ZodError` ou `SyntaxError` vindo do domínio, responde `503 INTELIGENCIA_INDISPONIVEL`, sem mensagem interna.

## Guard

`exigirApiAdminCrmDisponivel` é o guard administrativo genérico, apesar do nome: valida a sessão, e em métodos de escrita a origem e o CSRF. Não depende de flag nem de estado do CRM. É o mesmo guard do Dashboard e do Financeiro.

## Testes

- `npm run test:inteligencia`: sem banco. O Tenant Context real roda sobre uma transação falsa.
- `lib/inteligencia/arquitetura.test.ts`: analisa a AST da camada de IA. Resolve cada import antes de classificá-lo e aplica uma lista fechada de destinos. Recusa import de `*.test.*`, CommonJS, import dinâmico, re-export, acesso a `query` (direto, por chave ou desestruturado), `eval`/`Reflect`/`globalThis`/`Function` e SQL em qualquer caixa. **É proteção contra regressão, não fronteira de segurança.** A segurança vem do guard, do Tenant Context, da política e do registro fechado de ferramentas.
- `lib/inteligencia/inteligencia.postgres.test.ts`: isolamento no PostgreSQL descartável (`KIDMAIS_POSTGRES_DESCARTAVEL=kidmais_pacotes_v1_descartavel`, via `check:v1:postgres`). Semeia empresas A e B dentro de uma transação desfeita no fim e não aplica DDL. Cobre só recebíveis de entrada manual (escopo direto por `empresa_id`). Os recebíveis de contrato dependem da cadeia contrato → fechamento → pacote e não foram semeados.

## Débito técnico do Core (bloqueador)

**Escopo por empresa dos recebíveis de contrato.**

O que é fato hoje:

- Os recebíveis de contrato são atribuídos a uma empresa pela cadeia contrato → fechamento → pacote → `pacotes.empresa_id`.
- `fechamentos` não têm `empresa_id` explícito. A propriedade é indireta.
- A rota pública atual chega ao fechamento por seleção de pacote. A listagem pública do catálogo passa pela proteção existente (`recusarCatalogoPublicoSemTenant`, que recusa quando o tenant não é determinável).
- Não foi demonstrado bypass pela rota pública atual.
- `listarRecebiveis` tem teste de isolamento por empresa no Core (`lib/financeiro/financeiro.postgres.test.ts`). O teste Postgres da IA cobre apenas entradas manuais.

O que ainda exige revisão no Core:

- O serviço de criação por id (`criarFechamentoPublicoComIdentidade` → `buscarPacoteAtivoPorId`) filtra só por id e `ativo`, sem empresa.
- A integridade da propriedade indireta (fechamento → pacote → empresa) não tem garantia explícita no schema.

Isso bloqueia, até validação de ponta a ponta:

- um segundo tenant real;
- a expansão das ferramentas de IA para Festa, Contrato ou Fechamento.

Nenhuma alteração no Core ou migration faz parte deste PR.

## Rollback

Desligar `INTELIGENCIA_ENABLED`, ou reverter os commits. Não há migration nem alteração em serviços de domínio.
