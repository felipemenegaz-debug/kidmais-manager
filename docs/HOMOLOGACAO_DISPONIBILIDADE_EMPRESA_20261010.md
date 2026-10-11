# Disponibilidade do pacote por empresa — correção e homologação local (10/10/2026)

**Status: PRONTO PARA APROVAÇÃO, NÃO EXECUTADO.** Nenhum cluster, servidor ou navegador foi iniciado na preparação. Nada em
staging, produção, Render ou serviços externos. Sem push nem deploy. Sem migração nova (nenhuma mudança de schema).

- **Código: `5ba3534a5cbc5a3ada421e4e7f015b3a5f912977`**. Este pacote está no commit seguinte, que altera só `docs/`; o SHA desse
  commit é o da aprovação. `git diff --name-only 5ba3534a5cbc5a3ada421e4e7f015b3a5f912977 HEAD` deve listar só `docs/`.
- Base: catálogo por empresa homologado localmente (`be1b612` / evidência `72f3054`).
- Origem: achado da homologação do catálogo — no `/b/nav-profissional`, o POCKET (liberado pela empresa em todos os dias) aparecia
  “indisponível” no sábado ([evidência](evidencias/homologacao-catalogo-buffet-078-20261010.md), “Observação”).

## 1. Causa

`lib/agenda/disponibilidade.ts` (tela) aplicava regras **fixas da Kidmais** pelo código do pacote — `pocket` (segunda a quinta e
sexta no almoço), `mini`, `compacta` (sábado à noite), `pizza_party_scienza` (consulta) — a qualquer empresa. O servidor já decidia
pela configuração da empresa (`regras_disponibilidade_pacote`, dia ISO + período + vigência) em `precificarPacote`; a tela bloqueava
antes de chegar ao servidor.

## 2. Correção

| Onde | Antes | Agora |
|---|---|---|
| `GET /api/fechamentos/pacotes?empresa=<código>` | nome, preço, convidados | + `disponibilidade` de cada pacote **da empresa do endereço**: regras ativas e não expiradas (dia ISO 1–7, `almoco`/`noite` por `TURNO_1`/`TURNO_2`, estado, vigência). Sem dado pessoal |
| `GET /api/fechamentos/pacotes` (endereço atual da Kidmais) | — | **inalterado**: sem o campo e sem consulta nova |
| `statusDataPacote` | agenda → decisão por data → regra fixa por código | agenda → decisão por data → **regras da empresa** (vigência escolhida como no servidor: maior início vigente na data; sem regra = indisponível, motivo “conforme a configuração do buffet”) ; sem regras (endereço atual) → regra legada, idêntica |
| Assistente (`FechamentoWizard`) e calendário | regra fixa | as regras do pacote da empresa nas 5 decisões (validação da etapa, troca de pacote, seleção de data, alternativa de período, células do mês). No fluxo público só as duas primeiras são alcançáveis — ver limitação no §5 |
| Rótulo de consulta no calendário | “Consultar Kidmais” | “Consultar o buffet” fora do endereço da Kidmais |
| Seed local do navegador | Pocket de todas as empresas em todos os dias | Profissional: todos os dias; **Premium: só dias úteis (1–5)** — prova o isolamento na tela |

Fora do escopo (inalterado): o painel administrativo (`AdminDisponibilidade`) ainda calcula o status comercial com as regras fixas;
registrado como pendência.

## 3. Testes

| Arquivo | Cobre |
|---|---|
| `lib/agenda/disponibilidade.test.ts` | **caso encontrado** (POCKET do Profissional no sábado e domingo = disponível pela configuração; mesmo pedido no legado = indisponível); só o configurado vale (sem regra = indisponível, motivo sem “Kidmais”); nenhuma regra fixa por código (Compacta sábado à noite, Mini sexta à noite, Pizza Party, tradicionais); vigência (anterior, sobreposta, expirada, futura); agenda acima da regra; **regressão do legado** (16 casos de Pocket/Mini/Compacta/tradicionais/Pizza Party e motivos, com e sem `null`); rótulo de consulta |
| `lib/comercial/disponibilidade-pacote-publica.test.ts` | mapeamento `TURNO_1/2`; leitura só pelo id do pacote, só ativas/não expiradas, sem escrita; tela: Kidmais = `null`, empresa = só as regras do pacote dela, sem resposta = `[]`; **rota com duas empresas com POCKET** — cada uma recebe só as suas regras (A sábado disponível; B só quarta → sábado indisponível); legado sem o campo e sem leitura; todas as chamadas da tela ligadas às regras |
| Guardas existentes | `cotacao-publica.test.ts` (escopo da rota inalterado) e `marca-publica.test.ts` (menções a `kidmais` só por decisão de marca — os dois usos novos foram listados explicitamente) |
| `scripts/navegador-local-seed.test.cjs` | sábado só no Profissional; dias ISO válidos |

Testes que falham contra o código anterior: o caso encontrado (`indisponivel` em vez de `disponivel`) e os de isolamento.

**Validação local feita (código `5ba3534`, offline):** testes sem banco 2277/2277; `scripts/` em série 278/280 (as 2 falhas são as
ferramentas manuais de banco que exigem `--festa-id`, inalteradas); smoke 103/103; produção 37/37; planos `confere: true` (impressão
`ba47d7bf…22c1`, sem mudança de schema); TypeScript; ESLint 0 erros (1 aviso preexistente); `next build` com fontes locais (61 páginas);
worker de PDF no asset; `git diff --check` limpo. Nenhum banco usado; `KIDMAIS_HOMOLOGACAO_DATABASE_URL` removida do ambiente dos
comandos (valor não lido).

## 4. Passos (cada um exige aprovação; só `127.0.0.1`; sem conta administrativa; sem envio de pedido)

**Pré-condições (leitura):** `HEAD` = SHA aprovado; só `docs/` depois de `5ba3534`; árvore limpa; sem `.env*`, `DATABASE_URL`, `PG*`;
`KIDMAIS_HOMOLOGACAO_DATABASE_URL` fora do ambiente dos comandos; portas 55481 e 3481 livres; `navegador-local-seed.cjs --plano`
`confere: true`.

| Passo | O quê | Esperado |
|---|---|---|
| B0 | `Rename-Item .local-navegador .local-navegador-execucao-be1b612` | renomeada, intacta |
| B1 | `$env:KIDMAIS_PG_BIN='C:/Program Files/PostgreSQL/18/bin'`; `cluster-descartavel-postgres.cjs criar --cluster kidmais_navegador --criar-autorizado`; `iniciar … --iniciar-autorizado`; `conferir` | pasta **nova** `.local-navegador-pg-<guid>`, `CONFERE`, bancos `[]` |
| B2 | `$env:KIDMAIS_NAVEGADOR_AUTORIZACAO='127.0.0.1:55481/kidmais_navegador_disponibilidade_20261010'; node scripts/navegador-local-seed.cjs --seed-navegador-autorizado` | `PASS`; `isolamento.nav-profissional.diasPocket = [1..7]`, `nav-premium.diasPocket = [1..5]`; demais conferências como em `be1b612` |
| B3 | mesma variável; `node scripts/navegador-local-servidor.cjs --iniciar-autorizado` | `127.0.0.1:3481`, Asaas desligado, CEP externo desligado, fontes locais |
| B4 | checklist §5, desktop e celular | — |
| B5 | `node scripts/navegador-local-posconferencia.cjs --catalogo` (só leitura) | `CONFERE` (nada mudou no catálogo) |
| B6 | parar servidor (árvore do lançador) e cluster; restaurar `next-env.d.ts`/`tsconfig.json` se regenerados; fechar a aba | portas livres; pastas preservadas |

## 5. Checklist (D = desktop; C = celular 375×812). Datas: sáb 14/11/2026, dom 15/11, qua 18/11

**Caminho público (o mesmo do cliente), em todos os itens de tela:** abrir `/b/<código>/disponibilidade` (ou `/disponibilidade` no
legado) → escolher o mês, o dia, o período e o horário **clicando** → botão **“Continuar para escolher o pacote”** → etapa Pacote →
“Selecionar” → “Continuar”. Nenhum endereço de `/fechamento?…` é digitado, colado ou alterado, e nenhuma navegação é feita por script
(JavaScript só para **ler** o texto da página). Se o botão não levar à etapa Pacote, o item é registrado como **não executado**, com
o motivo e a captura, e a execução para nesse item; o endereço nunca é aberto diretamente.

| # | Caminho | Esperado | D | C |
|---|---|---|---|---|
| V1 | `/b/nav-profissional/disponibilidade` → **sábado 14/11, almoço, 11:00–15:00** → Continuar → Pocket → Continuar → Convidados (20) → Continuar até **Valor** | avança sem “não está disponível”; Valor mostra a cotação do servidor (R$ 1.500,00) | ✓ | ✓ |
| V2 | `/b/nav-profissional/disponibilidade` → **domingo 15/11, noite, 17:00–21:00** → Continuar → Pocket → Continuar | avança para Convidados (dia ISO 7) | ✓ | — |
| V3 | `/b/nav-premium/disponibilidade` → **sábado 14/11, almoço** → Continuar → Pocket → Continuar | permanece na etapa Pacote com “Este pacote não está disponível neste dia e período, conforme a configuração do buffet.”; nenhum texto da Kidmais | ✓ | ✓ |
| V4 | `/b/nav-premium/disponibilidade` → **quarta 18/11, almoço** → Continuar → Pocket → Continuar até **Valor** | avança; Valor R$ 2.300,00 | ✓ | — |
| V5 | `/disponibilidade` (legado) → **sábado 14/11 almoço** → Kidmais Pocket; **sábado 14/11 noite** → Festa Compacta; **quarta 18/11 almoço** → Kidmais Pocket | Pocket sábado recusado (regra legada); Compacta sábado à noite: “A Festa Compacta não está disponível aos sábados no segundo período.”; Pocket quarta avança | ✓ | ✓ |
| V6 | APIs sem sessão, pela barra de endereço (leitura de JSON): `/api/fechamentos/pacotes?empresa=nav-profissional`, `?empresa=nav-premium`, sem empresa | Profissional: 14 regras do POCKET (7 dias × 2 períodos); Premium: 10 (5 × 2); sem empresa: **sem** `disponibilidade` | ✓ | — |
| V7 | Recuperação pelo próprio cliente, a partir de V3: na etapa Pacote do Premium, **“Alterar data ou horário”** → volta a `/b/nav-premium/disponibilidade` → **quarta 18/11, almoço** → Continuar → Pocket → Continuar | o link leva à disponibilidade **do Premium** (não ao endereço da Kidmais); a nova data avança para Convidados | ✓ | ✓ |

**Limitação registrada (fluxo público):** o calendário interno do assistente (`CalendarioDisponibilidade`, etapa “Confirme a data e
o horário”), que também usa as regras do pacote, **não é acessível no fluxo público**: o assistente só abre com a data trazida da
disponibilidade (`origem=DISPONIBILIDADE`; sem ela redireciona para `/disponibilidade`) e pula essa etapa ao avançar (Pacote →
Convidados) e ao voltar (Convidados → Pacote). Ele só aparece com parâmetros de atendimento interno, que não são caminho do cliente
e não fazem parte deste pacote. As três decisões desse calendário ficam cobertas **só pelos testes** (§3: ligação de todas as
chamadas às regras da empresa e a regra em si). Consequência para o cliente: o calendário público de `/b/<código>/disponibilidade`
mostra a agenda do buffet, sem considerar o pacote — um sábado aparece “Disponível” no Premium e a recusa do Pocket só vem na etapa
Pacote (V3), com o caminho de volta do V7. Comportamento anterior a esta correção; registrado como pendência de UX.

Envio de pedido: **nenhum** (parar no máximo na etapa Valor). Nenhuma conta administrativa. Efeitos permanentes: só as pastas locais
novas (`.local-navegador-pg-*`, `.local-navegador/`), ignoradas pelo Git; remoção só com autorização de limpeza (C6).

## 6. Riscos e pendências

- Empresa que ainda não configurou dias para um pacote verá o pacote indisponível em todas as datas (antes, as regras da Kidmais
  podiam liberar dias que o servidor recusaria na cotação). É o mesmo resultado do servidor (`ELEGIBILIDADE_NAO_CONFIGURADA`).
- Painel administrativo (`components/admin/AdminDisponibilidade.tsx`) ainda usa as regras fixas no status comercial exibido —
  pendência (não altera pedidos; o servidor decide).
- Staging/produção: código compatível com qualquer schema já existente (só leitura de tabela da 006); entra com o pacote de código.
- **Fluxo público:** o calendário de `/b/<código>/disponibilidade` não considera o pacote, e o calendário interno do assistente não é
  alcançável pelo cliente (§5). Pendência de UX: indicar a disponibilidade do pacote antes da etapa Pacote (decisão de produto).
- Pendentes de antes: cliente existente com OTP (staging); 074–078 sem autorização para produção.
