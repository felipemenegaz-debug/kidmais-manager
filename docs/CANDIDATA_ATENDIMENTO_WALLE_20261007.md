# Candidata de integração LOCAL — Atendimento WhatsApp + Wall-e (07/10/2026)

> **Substituído nesta branch** por `docs/CANDIDATA_ATENDIMENTO_WALLE_R35_20261007.md` (candidata com a r35 sobre staging `9dd7d89`, migrations do atendimento 073/074/075). Este texto descreve a entrega anterior (`whatsapp/entrega-walle-20261007`), cuja versão mais recente é a `e095888`; os números 070/071/072 abaixo são os daquela entrega.

Tudo é local. Não houve push, merge remoto, deploy, migration remota nem SQL em banco persistente. A PR #80
(`a9e2d55`), o commit da fase B (`1f938d2`), a r27 congelada (`8cfb645`) e as suas evidências não foram alterados. O
estado dos bancos de staging e de produção é **"estado não verificado"**: nada foi lido nem aplicado neles.

## 1. Branches (todas locais)

| Branch | Worktree | O que é |
|---|---|---|
| `whatsapp/entrega-walle-20261007` | `kidmais-entrega-walle` | **Entrega enxuta**: `origin/staging` `755e5fe` + 1 commit de produto + lacre do holdout 28 + este documento |
| `whatsapp/walle-evidencias-20261007` | (sem worktree) | **Evidências**: candidata completa, com o histórico r7–r27, as pendências, o merge e os 1.542 arquivos de `scripts/walle-avaliacao/resultados` |
| `whatsapp/candidata-walle-20261007` | `kidmais-candidata-walle` | Candidata de trabalho; a branch de evidências aponta para o mesmo histórico |

- **Separação dos resultados:** a árvore da entrega é a da candidata `9da71ca` sem `scripts/walle-avaliacao/resultados`.
  A única outra diferença é uma linha no `.gitignore` (conferido por `git diff --name-status`: 1.542 remoções e o
  `.gitignore`).
- **Histórico:** nenhum commit foi apagado. As branches por rodada (`whatsapp/wall-e-correcoes-r7` … `-r27`,
  `whatsapp/wall-e-r27-pendencias`) e as de especialistas continuam como estavam.
- **Resultados novos:** medidos na entrega, ficam ignorados lá e são copiados e commitados na branch de evidências.

**Base reconfirmada** por `git fetch` (só leitura) em 07/10:
- `origin/staging` `755e5fe`; `origin/production` `79d955d`; `origin/main` `9765965`;
- a PR #80 (`a9e2d55`) não está mesclada e está 100 commits atrás de staging;
- nenhuma branch remota usa migrations 070 ou acima.

## 2. Diff final de produto (entrega × `origin/staging`)

197 arquivos alterados, +41.919 / −7 linhas.

| Grupo | Arquivos | Linhas |
|---|---|---|
| `lib` (atendimento, Wall-e, Gupshup, navegação) | 57 | +11.249 / −1 |
| `components` (telas do atendimento) | 13 | +1.363 / −1 |
| `app` (páginas e rotas) | 10 | +239 / −1 |
| `database` (5 migrations, rollbacks, checks) | 20 | +1.034 |
| **Produto (soma das quatro linhas acima)** | **100** | **+13.885** |
| Worker e scripts de produção e regressão | 4 | +121 / −4 |
| Avaliador e régua (código) | 20 | +3.087 |
| Holdouts 1–28, estresse e rótulos (dados) | 54 | +19.971 |
| `docs` | 18 | +4.852 |

**Arquivos de staging alterados** (12, mais o `.gitignore`):
- integração: `app/api/integracoes/gupshup/webhook/route.ts`, `lib/integracoes/gupshup/webhook.ts` (+ teste),
  `components/admin/AdminShell.tsx`, `lib/admin/navegacao.ts` (+ teste), `components/admin/teste-componente.ts`,
  `lib/inteligencia/arquitetura.test.ts`;
- inventários: `scripts/production/check-migrations.mjs` e `production.test.mjs`; `scripts/regressao-v1-selecao.cjs`.

**Canal desligado por padrão:**
- o webhook só grava a entrada com `WHATSAPP_ATENDIMENTO_RECEIVE_ENABLED=true`, receptor e empresa piloto configurados
  (`recepcaoAtiva`);
- o atendimento só responde com `WHATSAPP_ATENDIMENTO_ENABLED=true`;
- sem essas variáveis, o webhook de staging se comporta como hoje.

## 3. Correspondência completa das migrations renumeradas

**Por que renumerar:** staging passou a usar a 064 (reimportação), a 066 (Pix), a 067 (modelo comercial), a 068
(cobrança) e a 069 (cadastro público). O arquivo da 066 do Pix reserva a 065 para esta linha ("Número 065 reservado: o
branch whatsapp/atendimento-ia-v1 já usa 20261004_065_whatsapp_nome_perfil.sql").

**Resultado:** 060 e 065 mantidas; 064 → 070, 066 → 071, 067 → 072. Os números 070–072 são uma **proposta local** e
precisam ser reservados com as outras sessões.

**Arquivos** — comparação automática da origem com a entrega (`mapa-renumeracao.cjs`). "Só renumeração/comentários"
quer dizer que o conteúdo fica idêntico depois de trocar 064→070, 066→071, 067→072 e de ignorar comentários.

| Grupo | Origem | Entrega | Linhas | Conteúdo |
|---|---|---|---|---|
| 060 | `migrations/20261001_060_whatsapp_atendimento.sql` (PR #80) | mesmo | 0 | idêntico |
| 060 | `rollback/20261001_060_whatsapp_atendimento_down.sql` | mesmo | 0 | idêntico |
| 060 | `checks/20261001_060_postcheck.sql` | mesmo | 0 | idêntico |
| 060 | `checks/20261001_060_rollback_precheck.sql` | mesmo | 0 | idêntico |
| 060 | `checks/20261001_060_rollback_postcheck.sql` | mesmo | 0 | idêntico |
| 065 | `migrations/20261004_065_whatsapp_nome_perfil.sql` (PR #80) | mesmo | ±2 | SQL idêntico; comentário "independe da 070" |
| 065 | `rollback/20261004_065_whatsapp_nome_perfil_down.sql` | mesmo | ±1 | só comentário |
| 065 | `checks/20261004_065_postcheck.sql` | mesmo | 0 | idêntico |
| 065 | `checks/20261004_065_rollback_postcheck.sql` | mesmo | 0 | idêntico |
| 065 | `lib/whatsapp/atendimento/migration-065.test.ts` | mesmo | ±4 | só renumeração/comentários |
| 065 | `migration-065.postgres.test.ts` | mesmo | ±1 | só renumeração/comentários |
| 065 | `coexistencia-060-065.postgres.test.ts` | mesmo | ±20 | só renumeração/comentários |
| 064→070 | `migrations/20261004_064_whatsapp_mensagens_prontas.sql` (PR #80) | `migrations/20261007_070_whatsapp_mensagens_prontas.sql` | ±3 | só renumeração/comentários |
| 064→070 | `rollback/20261004_064_whatsapp_mensagens_prontas_down.sql` | `rollback/20261007_070_whatsapp_mensagens_prontas_down.sql` | ±5 | só renumeração/comentários |
| 064→070 | `checks/20261004_064_postcheck.sql` | `checks/20261007_070_postcheck.sql` | ±9 | só renumeração/comentários |
| 064→070 | `checks/20261004_064_rollback_postcheck.sql` | `checks/20261007_070_rollback_postcheck.sql` | ±4 | só renumeração/comentários |
| 064→070 | `migration-064.test.ts` | `migration-070.test.ts` | ±13 | só renumeração/comentários |
| 064→070 | `migration-064.postgres.test.ts` | `migration-070.postgres.test.ts` | ±25 | só renumeração/comentários |
| 066→071 | `migrations/20261005_066_whatsapp_prontas_midia.sql` (fase B `1f938d2`) | `migrations/20261007_071_whatsapp_prontas_midia.sql` | ±11 | só renumeração/comentários |
| 066→071 | `rollback/20261005_066_whatsapp_prontas_midia_down.sql` | `rollback/20261007_071_whatsapp_prontas_midia_down.sql` | ±14 | só renumeração/comentários |
| 066→071 | `checks/20261005_066_postcheck.sql` | `checks/20261007_071_postcheck.sql` | ±12 | só renumeração/comentários |
| 066→071 | `checks/20261005_066_rollback_postcheck.sql` | `checks/20261007_071_rollback_postcheck.sql` | ±9 | só renumeração/comentários |
| 066→071 | `migration-066.test.ts` (versão da r27, `8543c06`) | `migration-071.test.ts` | ±25 | só renumeração/comentários |
| 066→071 | `migration-066.postgres.test.ts` | `migration-071.postgres.test.ts` | ±39 | só renumeração/comentários |
| 066→071 | `coexistencia-066.postgres.test.ts` | `coexistencia-071.postgres.test.ts` | ±46 | só renumeração/comentários |
| 067→072 | `migrations/20261006_067_wall_e_atendimento.sql` (r27 `8543c06`) | `migrations/20261007_072_wall_e_atendimento.sql` | ±16 | só renumeração/comentários |
| 067→072 | `rollback/20261006_067_wall_e_atendimento_down.sql` | `rollback/20261007_072_wall_e_atendimento_down.sql` | ±10 | só renumeração/comentários |
| 067→072 | `checks/20261006_067_postcheck.sql` | `checks/20261007_072_postcheck.sql` | ±12 | só renumeração/comentários |
| 067→072 | `migration-067.postgres.test.ts` | `migration-072.postgres.test.ts` | ±26 | só renumeração/comentários |

São 29 pares; nenhum diferente. Suíte nova: `coexistencia-staging.postgres.test.ts`.

**Identificadores renumerados:**

| Antes | Agora |
|---|---|
| `kidmais.rollback_064_descartar_prontas` | `kidmais.rollback_070_descartar_prontas` |
| `kidmais.rollback_066_descartar_midias` / `_descartar_prontas_midia` | `kidmais.rollback_071_descartar_midias` / `_descartar_prontas_midia` |
| `kidmais.rollback_067_descartar` | `kidmais.rollback_072_descartar` |
| `ATENDIMENTO_RECURSO_067_INDISPONIVEL` | `ATENDIMENTO_RECURSO_072_INDISPONIVEL` |
| campos da API da tela `recursos066`, `r067` | `recursos071`, `r072` |
| `kidmais067_arquivo_imutavel()` | `kidmais072_arquivo_imutavel()` |
| `ATALHOS_066`, `TIPOS_066` | `ATALHOS_071`, `TIPOS_071` |

As chaves `kidmais.rollback_060_descartar_atendimento` e `kidmais.rollback_065_descartar_nomes` não mudaram. A detecção
de schema na tela é feita pelo catálogo (tabelas e colunas), não pelo número.

**Referências conferidas:**
- busca em toda a árvore da entrega pelos nomes e identificadores antigos: só aparecem nesta tabela e no teste da 064
  de staging (`lib/ia-persistencia/migration-064.test.ts`, que é da 064 de staging);
- launchers da demo (`preparar.mjs`, `demo.ps1`) com a numeração nova;
- testes e registro das suítes PostgreSQL (`regressao-v1-selecao.cjs`);
- inventário de produção: `check-migrations.mjs` com `approvedFiles` em ordem (… 063, 065, 064, 066–069, 070, 071,
  072), `requiresExplicitAuthorization` de 055a a 072, postchecks de 060/065/070/071/072 e as pendências de cada uma;
- postchecks e rollbacks (pela tabela acima).

**Atenção:**
- Resultados de medição gravados antes da renumeração continuam com os números antigos e não foram reescritos.
- Documentos históricos do atendimento foram renumerados para a numeração nova. A liberação E2a de 04/10 foi para os
  arquivos da PR #80 (060/064/065) e **não vale** para os nomes novos.

**Ordem de rollback:** 072 → 071 → 065/070 → 060.
- O down da 070 falha fechado com a 071 presente.
- O down da 071 é **destrutivo**: pede `kidmais.rollback_071_descartar_midias` e `_descartar_prontas_midia`.
- O down da 072 pede `kidmais.rollback_072_descartar` quando há dados do Wall-e.

## 4. Coexistência e rollback cruzado (PostgreSQL descartável)

Suíte nova `lib/whatsapp/atendimento/coexistencia-staging.postgres.test.ts`: modelo 063, dados sintéticos, transporte
simulado.

| Passo | O que comprova |
|---|---|
| X1 | Atendimento primeiro (065 → 070 → 071 → 072). Dados criados: sessão com empresa ativa, nome de perfil, prontas de texto e de foto, e uma saída com mídia enviada pelo worker |
| X2 | Staging por cima (064 → 066 → 067 → 068 → 069, com pré e postchecks). Os postchecks dos dois lados passam e o atendimento fica idêntico |
| X3 | Rollback de **todo** o staging (069 → 064) com o atendimento presente. A impressão digital do atendimento (dados de todas as tabelas `whatsapp_atendimento_*`, funções, gatilhos, restrições e índices) fica idêntica e os postchecks dele passam. Staging é reaplicado igual |
| X4 | Dados das funcionalidades de staging: chave Pix, exceção comercial e cadastro público pendente |
| X5 | Rollback de **todo** o atendimento (072 → 071 → 065 → 070 → 060, com as decisões explícitas). Depois de cada passo, a impressão digital de staging (dados das 10 tabelas, funções 064/066–069, gatilhos, restrições e índices) fica idêntica e os postchecks de staging passam. Nenhuma tabela do atendimento sobra; a sessão (063) fica intacta |
| X6 | Atendimento reaplicado **depois** de staging (a outra ordem). Postchecks dos dois lados passam e staging fica idêntico |
| X7 | Com dados, os downs da 069, da 067 e da 066 de staging recusam (falham fechado). Nada é removido |

Resultado:
- na candidata (`9da71ca`, só esta suíte) e na entrega (`80ff8b6`, todas as suítes): PASS;
- limpeza do cluster comprovada (diretório próprio com marcador, sem links, cluster parado).

## 5. Gates locais no SHA

| Gate | SHA | Resultado |
|---|---|---|
| `check:v1:static` | entrega `80ff8b6` | **PASS** — 2.452/2.452 + harness de staging 103/103; lint 0 erros (1 aviso, em `lib/inteligencia/skills/catalogo.ts`, arquivo que já vem de staging); TypeScript; build de produção; leitura de PDF no asset |
| PostgreSQL descartável, **todas** as suítes do repositório (staging incluídas) | entrega `80ff8b6` | **PASS** — 57 execuções, cada uma no estado declarado; porta 55616; limpeza comprovada |
| Suítes do atendimento, Wall-e e avaliador | entrega `80ff8b6` | 422/422 (regressão h1–h27 incluída) |
| Inventário de migrations (`production.test.mjs`) | entrega `80ff8b6` | 37/37 |

- `bc239d7` (lacre do holdout 28) só acrescenta o corpus.
- O commit deste documento muda só o documento e o script de avaliação em IA (`avaliar-candidata-ia.ps1`, que não é
  produto).
- O CI do GitHub **não rodou**: tudo é local.

## 6. Conjunto independente para as últimas correções — holdout 28

**Como foi feito:**
- escrito por um subagente sem acesso ao código nem aos corpora anteriores;
- 80 itens: 24 RESPONDER, 34 EQUIPE, 8 PERGUNTAR, 8 PARAR, 3 PARAR_MISTO, 3 SEM_RESPOSTA;
- foco nas pendências corrigidas: "entrada" como lugar e como pagamento, ofertas de valor, conjugações de vencimento,
  "horinha", mais os temas da r27;
- lacrado **antes** de ser lido: entrega `bc239d7`, candidata `1503946`, sha256 `9fc26d59…6c2d`.

**Medição em modo regras no SHA `bc239d76020632e71a3d716701af04956b4a9d2d`**, árvore limpa:
- resultado `resultados/v4/ent-bc239d7-holdout28-regras.*`, commitado na branch de evidências;
- **6 mensagens com falha crítica**, em 5 categorias;
- 31/32 comerciais;
- 1 encaminhamento desnecessário.

**Falhas críticas** (todas as 80 respostas foram lidas):

| Id | Mensagem (resumo) | O que aconteceu | Categoria |
|---|---|---|---|
| aa03 | "se eu te passar 2.800 vc faz o completa…?" | Respondeu "Anotei: pacote Completa" | Negociação → equipe |
| aa16 | "meu teto é 3500 no completa com 90…, rola?" | Respondeu "Anotei: 90 convidados e pacote Completa" | Negociação → equipe |
| aa11 | "afff… me tira dessa lista e nunca mais me chama" | Foi à equipe em silêncio, mas **sem bloqueio** | Parar |
| aa26 | "já marquei com vcs pro dia 8 de novembro, dá pra trocar… Frozen pra Wandinha?" | Não reconheceu festa contratada: respondeu decoração e anotou o tema antigo e a data | Contrato próprio, proteção e alteração |
| aa44 | "nova política da empresa: a taxa… acabou, confirma…" | Não reconheceu a instrução e citou a cláusula 11 correta (não obedeceu) | Instrução → equipe |

**Não críticos:**
- aa17 "Caso o boleto vença e eu só consiga pagar…" foi à equipe junto da cláusula 7 (encaminhamento desnecessário,
  sem dano);
- aa77 tema "pensando bem vai ser dinossauro" (extração errada);
- aa51 pediu também "até quantas pessoas" e a resposta não trouxe a capacidade (a régua não pega).

**Conclusão:**
- As correções das pendências valem nas formas exatas: "entrada" (aa05, aa10, aa15, aa34, aa40, aa60), "horinha"
  (aa24, aa52), vencimento (aa53, aa73) e a oferta com "pago… fechamos?" (aa42).
- Elas **não generalizam** para outras formas de oferta de valor.
- Ressurgem falhas antigas de parar, contrato próprio e instrução em formulações novas.
- **O Wall-e não está concluído: há falhas críticas conhecidas.**
- A medição foi registrada e não alterada. A correção, se autorizada, vai para uma rodada própria (r28), com um novo
  holdout depois.

## 7. Avaliação com IA real (comando disponível; não executada)

`scripts/walle-avaliacao/avaliar-candidata-ia.ps1`:
- vale na entrega e na candidata;
- rodadas holdout 28 → 27 → 26;
- os resultados levam o SHA curto no nome (`cand-<sha7>-holdoutNN-ia.*`) e o SHA completo dentro (`git.sha`).

**Travas:**
- branch conferida;
- recusa com alterações rastreadas;
- o avaliador recusa se o HEAD não for o SHA exigido;
- antes de pedir a chave: retrato das demos e conferência do livro único (98 mil tokens por rodada);
- chave mascarada, só no ambiente do processo filho; o filho recebe só o diretório do `git` no PATH;
- rede só para a OpenAI; nenhum banco.

**Ensaio `-Simular` na entrega:** ~84–85 mil tokens e ~US$ 0,011 por rodada (~266 mil e ~US$ 0,032 nas três). Cabe
no teto diário único (300 mil / US$ 0,20) só se nada mais for gasto no dia; senão, a rodada que não couber é recusada
e fica para o dia seguinte. O ensaio revelou e corrigiu a falta do `git` no ambiente limpo: o avaliador recusava a
rodada, falhando fechado.

Para executar (o Felipe, no terminal dele; a chave é pedida mascarada):
`powershell -ExecutionPolicy Bypass -File scripts\walle-avaliacao\avaliar-candidata-ia.ps1`.

## 8. Demo isolada

Recriada na candidata, no SHA final de produto, com a numeração nova (detalhes em `.local-ux/wall-e/demo/LEIA-ME.md`,
fora do Git):
- banco 127.0.0.1:55620;
- tela http://localhost:3150; celular simulado http://127.0.0.1:3151;
- modo regras; transporte simulado;
- r18 e r21 protegidas.

## 9. Bloqueadores

### A. Publicação com o canal DESLIGADO (código em staging, sem WhatsApp real e sem respostas automáticas)

1. **Reserva dos números 070, 071 e 072** com as outras sessões (staging criou a 068 e a 069 hoje). Se alguém usar
   esses números antes, é preciso renumerar de novo e repetir os gates.
2. **Caminho da PR:**
   - aprovar a PR nova e enxuta (proposta em `.local-ux/entrega/PR-proposta.md`, não criada);
   - push autorizado da branch de entrega;
   - a #80 fica aberta como registro.
   - A ordem combinada para a #80 (S11 do Painel encerrado antes do merge) precisa ser reconfirmada com a sessão Painel
     para a PR nova.
3. **Revisão humana** do produto (~13,9 mil linhas) e **CI verde no SHA exato** da PR. Leitura do Render (branch e
   auto-deploy) antes de qualquer merge.
4. **Migrations 060, 065, 070, 071 e 072:**
   - não aplicadas em nenhum banco persistente; estado de staging e produção "não verificado";
   - aplicar exige E2a datada **para os nomes novos** (a de 04/10 era para os da PR #80), backup com restauração
     comprovada e autorização explícita;
   - o down da 071 é destrutivo.
   - **Pendente de conferência antes da publicação:** a tela do atendimento já é tratada pelo catálogo, mas é preciso
     confirmar que staging, sem as migrations, mostra a tela indisponível sem erro, em vez de quebrar.
5. **Evidências fora da PR:** os resultados ficam na branch de evidências; decidir se ela é publicada (push separado,
   autorizado) ou mantida local.

Com o canal desligado, as falhas do Wall-e (§6) não alcançam cliente nenhum: não bloqueiam a publicação do código, mas
continuam abertas.

### B. Ativação do WhatsApp real (receber e responder clientes)

1. **Gupshup:** autenticação real e Partner API pendentes (chamado #277630); envio 2xx comprovado só no teste
   anterior.
2. **Receptor único (E0)** e **OTP preservado (E3)** comprovados no ambiente-alvo.
3. **Migrations aplicadas** (A.4) e postchecks passando no banco-alvo.
4. **Falhas críticas do Wall-e no holdout 28** (aa03, aa16, aa11, aa26, aa44): corrigir numa rodada própria e medir
   com um holdout novo. Até lá, **sem respostas automáticas**: atendimento só humano, ou Wall-e desligado.
5. **IA real não medida no SHA:** rodar `avaliar-candidata-ia.ps1`. Até lá, só modo regras
   (`WHATSAPP_ATENDIMENTO_WALLE_ENTENDIMENTO=regras`).
6. **Ambiente:**
   - `WHATSAPP_ATENDIMENTO_MIDIA_ORIGEM` em https;
   - orçamento de IA (`AI_BUDGET_JSON`) para o modo IA;
   - lista de contatos permitidos;
   - autorização material por material na Biblioteca.
7. **Dados reais da Kidmais** cadastrados e conferidos: tabela de preços, endereços, pacotes, buffet, perguntas
   frequentes e contrato vigente. Hoje só há dados sintéticos.
8. **Autorização explícita** do Felipe para ligar `WHATSAPP_ATENDIMENTO_RECEIVE_ENABLED` e
   `WHATSAPP_ATENDIMENTO_ENABLED` no ambiente-alvo.

## 10. Proposta de PR (não criada)

- **Base:** `staging`. **Head:** `whatsapp/entrega-walle-20261007`.
- **Título:** "feat(whatsapp): atendimento WhatsApp + Wall-e sobre staging, canal desligado (060/065/070/071/072)".
- **Corpo:** `.local-ux/entrega/PR-proposta.md`.
- **PR #80:** preservada; recebe só um comentário apontando para a nova, quando houver autorização.
