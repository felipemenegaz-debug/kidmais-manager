# IA KidMais: compreensão e conversa adaptativa (GOAL MASTER)

Data de início: 01/10/2026. Branch: `ai-v11/09-conversa-adaptativa`, criada de `origin/staging` em `6b45783`.

Este documento tem quatro partes:
- o plano persistente da entrega;
- a auditoria do código de partida;
- a arquitetura implementada;
- as evidências por cenário.

Ele é atualizado a cada etapa. Uma etapa só é marcada como feita com a evidência ao lado.

## 1. Plano e estado

| # | Etapa | Estado | Evidência |
|---|---|---|---|
| 1 | Leitura (AGENTS, OPERACAO_AGENTES, arquitetura da IA operacional, guias do Next 16.3.4) e auditoria do código | feito | §2 |
| 2 | Avaliação de function calling (documentação oficial do gpt-6-luna) | feito | §3 |
| 3 | Contratos: naturezas de fato, workloads novos, trace do ciclo | feito | `contratos.ts`, `rastreio.ts`, `roteador.ts` |
| 4 | Luna: entendimento com contexto (schema estrito, validação, minimização) | feito | `luna/entendimento.ts`; `luna.test.ts` |
| 5 | Luna: redação da resposta final (validação de números, fallback determinístico) | feito | `luna/redacao.ts`; `luna.test.ts` |
| 6 | Demerzel: ciclo adaptativo limitado (4 chamadas de modelo, 8 leituras, 20 s) | feito | `demerzel/adaptativo.ts` |
| 7 | Conversa: portas do ciclo, rascunhos com dados do modelo, consumo com estimativa, fallback seguro | feito | `conversa.ts`, `acoes/*`, `leituras/operacional.ts` |
| 8 | UI: histórico curto como contexto; indicação discreta do rascunho pausado; rótulos das naturezas | feito | `cliente-inteligencia.ts`, `conversa.ts` (UI), `PerguntarKidmais.tsx`; a barra existente "Respondendo ao rascunho" é a indicação discreta |
| 9 | Testes de diálogo (mocks determinísticos) e regressões | feito | 15 diálogos "Luna —" em `aceite-operacional.test.ts`; 8 unitários; 1 de UI |
| 10 | Gates locais (testes, TypeScript, ESLint, build, UI, benchmark) | feito | `56d6834`: test:inteligencia 422/422; check:v1:static 1633+103 com build; check:ia:prs, tsc, ESLint, UI 27/27, ux-contratos-perfil ok; benchmark sem diff. `check:v1:ui` falha também no staging puro `a6fbfd6` (endpoint de logo da #55) — anterior a esta entrega |
| 11 | PR, CI, merge em staging e deploy manual | feito | PR #56, CI success; merge commit `9599af2` (árvore = `56d6834`); deploy `dep-dav35fojo6nc73fa0i9g` live, health 200, sem erros nos logs; auto-deploy OFF (staging e produção) conferido antes |
| 12 | Revisão: 3 lacunas reproduzidas e corrigidas (fallback ambíguo, associação valor↔unidade na redação, estimativa negada) | feito | §5.1; PR #57 (CI success), merge `c37ca62`, deploy `dep-dav3mvc1nsns738g7i90` live, health 200 |
| 13 | Homologação com o modelo real pelo app de staging (custo e latência medidos) | feito | §5.2 e §5.3: 1ª rodada em `9243d2c` (7 falhas e 1 ajuste ⇒ PR #61); 2ª em `1dc986f` limitada pelo teto de orçamento ⇒ PR #62; causa exata (`TETO_TOKENS` diário da empresa) comprovada pela PR #64; 3ª (fallback) em `bfe6fac` ⇒ PR #65; 4ª (Luna) em `3b66958` ⇒ PR #66; rodadas de gestão de contexto ⇒ PRs #67 a #75; **rodada final em `82f9bb1`: 19 cenários + 1 continuação, todos ok, nenhuma recusa** (§5.3). Falha do provedor: só testes |

## 2. Auditoria do código de partida (`6b45783`)

| Componente | Comportamento encontrado | Consequência |
|---|---|---|
| Demerzel (`demerzel/orquestradora.ts`) | O 1º passo é sempre `INTENCAO_REGRAS`. Se a regra reconhece qualquer coisa, o pedido é despachado sem o modelo; o modelo (planner ou intenção) só entra quando nenhuma regra casa. Limites globais: 10 passos, 2 com modelo, 8 s. | Uma palavra isolada encerra a interpretação. |
| Regras (`intencao.ts`, `operacional/objetivo.ts`) | Regex por palavra. "crie uma do cliente Felipe para 50 convidados, pacote premium" vira `criar_pacote`: o objeto não é reconhecido e a regra de pacote casa pela palavra. | Rascunho errado (caso A). |
| Modelo de intenção (`interpretarComModelo`) | Só escolhe UMA capacidade de um enum; não recebe histórico, rascunho nem parâmetros; não extrai nada. | Nenhuma compreensão da mensagem inteira. |
| JEV (`jev/v1`) | Regras rodam sempre; o modelo só quando as regras não entendem. Para as frases obrigatórias não há recusa (READ/CONFIRM). Recusas reais: injeção e FORBIDDEN. A Demerzel recusa "pedido misto" (consulta + alteração) por heurística. | A recusa por pedido misto é linguística, não de risco. |
| Rascunhos (`acoes/human-gate.ts`, `acoes/contratacao.ts`) | Campos extraídos por regex (`extrairContratacao`). O coordenador do rascunho decide resposta/correção/consulta por regex. | A conversa entende parte da resposta e repete perguntas. |
| Continuação de consumo (`conversa.ts`) | Já preserva festa, categorias e parâmetros (PR #54). Extração por regex: "refrigerante de 2l" não é embalagem; "faça você a definição" é ignorado. | Caso C falha: pergunta de novo. |
| Composição | Determinística, deduplica fatos (PR #54). Resumo é a concatenação dos resumos das leituras. | Resposta em frase padronizada. |
| Rascunho pausado | `comPausa` acrescenta ao resumo, em TODA resposta, a pergunta pendente do rascunho. | Repetição. |
| Provedor (`modelos/openai-compativel.ts`) | Chat Completions com `response_format: json_schema` estrito; nenhuma ferramenta enviada. ModelRouter com tiers, reservas de orçamento, circuito e trace de uso. | Base reaproveitável. |
| Contexto ao modelo | `prepararTextoParaModelo` (redige PII, limita). Nenhum histórico chega ao servidor; a UI guarda as últimas 6 trocas só em memória. | Sem contexto conversacional. |

Já implementado pela IA operacional e mantido:
- Human Gate, com a revisão oficial da contratação;
- cálculo determinístico de consumo, com a 059 aplicada em staging;
- consulta adaptativa por regras e complementos determinísticos;
- Policy, Tenant Context e registro fechado de ferramentas.

Incompleto e mudado por esta entrega:
- compreensão pelo modelo antes das regras, com contexto;
- extração de parâmetros pelo modelo;
- estimativa explícita;
- redação natural;
- ciclo com limites próprios;
- indicação discreta do rascunho pausado.

## 3. Function calling: avaliação

Fonte: documentação oficial do modelo ([GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna) e [Using GPT-6](https://developers.openai.com/api/docs/guides/latest-model)), consultada em 01/10/2026:

- **Preço:** US$ 0,10 por 1M tokens de entrada, US$ 0,01 em cache e US$ 0,50 de saída.
- **Endpoints:** Chat Completions e Responses.
- **Function calling no Chat Completions:** só com `reasoning_effort: "none"`. Com raciocínio, só pela Responses API.
- **Structured Outputs:** suportado.

Decisão: **não migrar o provedor nesta entrega.** O ciclo usa saídas estruturadas estritas (`json_schema`) pelo adaptador atual, com o mesmo contrato de uma chamada de função. O modelo devolve a escolha de ferramentas, os parâmetros e o objetivo num schema fechado; o servidor valida e executa.

Motivos:
1. **Preserva o que já funciona:** ModelRouter, reservas de orçamento, circuito, fallback DeepSeek (que não tem Responses) e trace de uso.
2. **Preserva a configuração de staging:** ECONOMY usa `reasoning_effort: none`, que já é o modo exigido para function calling no Chat Completions. Não há perda de capacidade.
3. **Execução no servidor:** com function calling nativo o modelo continuaria só *pedindo* a chamada. Executar, revalidar e limitar são do servidor nos dois desenhos.
4. **Risco de migração:** a Responses API exige novo parsing de saída e de uso. O fórum oficial registra relatos de itens extras e tokens espúrios em Structured Outputs pela Responses com modelos Luna. Migrar exige benchmark próprio, registrado como próximo passo possível.

## 4. Arquitetura implementada

### Fluxo de uma mensagem (com `AI_OPERACIONAL_ENABLED`, Demerzel e provedor disponíveis)

1. **Estado do servidor.** O rascunho (se a UI apontar um) é relido no tenant comprovado: dono, empresa, estado e prazo. A continuação de consumo é uma dica revalidada no Core. O histórico curto (até 4 trocas, 300 caracteres cada) é só contexto.
2. **Demerzel: risco.** JEV só por regras, sem modelo: injeção, segredo, SQL, permissão, exclusão e outra empresa são recusados antes de gastar modelo. Incerteza linguística nunca é risco.
3. **Luna: entendimento** (`INTERPRETAR_CONVERSA`, 1 chamada). Lê a mensagem inteira com o contexto e devolve, num schema estrito e fechado:
   - objetivo, relação com o rascunho e correção;
   - consultas do catálogo do operador e a festa ("a próxima", "desta tela", "da conversa", por data);
   - parâmetros de consumo, pedidos de estimativa e campos da contratação;
   - pergunta de esclarecimento e outros pedidos.
4. **Revalidação no servidor** (`luna/entendimento.ts`):
   - enums do catálogo;
   - números e nomes só se o USUÁRIO os escreveu (mensagem ou histórico), com litros convertidos para mL;
   - datas reais, e o ano só se escrito;
   - estimativa só com pedido explícito;
   - "pacote" como atributo de um pedido sobre cliente ou festa nunca vira `criar_pacote` (vira esclarecimento).
   - Ids nunca vêm do modelo.
5. **Execução pelas portas guardadas** (`conversa.ts`, `atenderComLuna`):
   - **rascunho:** resposta ou correção (nova versão, que invalida confirmações antigas), troca auditável de objetivo (`SUBSTITUIDO`), cancelar ou retomar;
   - **ação:** proposta sob Human Gate, com os campos entendidos pela Luna, que a ação sanitiza (`doModelo`) e o Core verifica (`verificar`);
   - **cálculo de consumo:** categorias e parâmetros sobre a continuação; convidados sempre da festa no Core;
   - **consulta:** o caminho existente, mas a regra só decide se concordar com a Luna. Uma ação casada por palavra numa pergunta não abre rascunho, e a recusa por "pedido misto" deixa de valer quando a Luna entendeu uma consulta.
6. **Luna: análise e redação** (`REDIGIR_RESPOSTA`, 1 chamada). Ela escreve a resposta em linguagem natural a partir dos fatos verificados e aponta lacunas entre as consultas complementares possíveis (âncora única do Core).
   - Garantias conferidas no servidor:
     - todo número do texto existe nos fatos;
     - todo número do resumo determinístico (os totais) aparece no texto;
     - sem links nem marcação.
   - Se a redação for reprovada, fica o texto determinístico.
7. **Complemento.** Se a Luna apontou lacuna e há orçamento, a Demerzel lê a consulta complementar (contada, Policy em cada leitura) e pede nova redação.
8. **Limites desta rota** (`LIMITES_ADAPTATIVOS`): 4 chamadas de modelo no pedido inteiro (entendimento + planner + redações), 8 leituras e 20 s. Ao atingir um limite, a resposta comprovada sai sem redação e a parada fica no trace. A espera por resposta humana encerra o pedido.
9. **Fallback:** sem entendimento (provedor fora, prazo, saída inválida), o caminho anterior responde exatamente como antes. Erros de Policy, Tenant e Core seguem o tratamento seguro de sempre.

### Naturezas dos fatos

| Natureza | Significado | Rótulo na UI |
|---|---|---|
| `FATO` | dado registrado no Core | Dado |
| `PARAMETRO` | parâmetro informado pelo usuário só para esta consulta | Informado por você |
| `CALCULO` | cálculo determinístico | Cálculo |
| `ESTIMATIVA` | hipótese pedida pelo usuário; nunca padrão da empresa nem recomendação comprovada; nunca salva sem proposta e aprovação separadas | Estimativa |
| `AUSENCIA` | dado ausente ("Tipos de doces ainda não escolhidos pelo cliente.") | Sem dados |

### Papéis

- **Luna** (`luna/`, CORE):
  - entende a mensagem inteira e extrai parâmetros;
  - escolhe consultas do catálogo;
  - analisa resultados, aponta lacunas e redige.
  - Não autoriza nem executa.
- **Demerzel** (`demerzel/adaptativo.ts`, feature):
  - coordena o ciclo e checa o risco (JEV por regras);
  - conta modelo, leituras, prazo e repetições.
  - Não decide por palavra isolada.
- **JEV:** só risco, por regras nesta rota. Não escolhe tom, não recusa por incerteza linguística, não concede permissão.
- **Core, Tenant Context, Policy e Human Gate:** inalterados. A aprovação humana continua sendo o único caminho de escrita.

### Contexto enviado ao modelo (minimizado)

| Item | Detalhe |
|---|---|
| Mensagem | redigida: CPF, telefone, e-mail, ids e números longos |
| Histórico | até 4 trocas |
| Tela | tipo e se há registro aberto (sem id) |
| Rascunho | objetivo, estado, pergunta pendente e campos preenchidos; texto livre (nomes, tema) vai só como "(informado)" |
| Pendências de consumo | categorias, o perguntado e os números já informados |
| Catálogo | ids e descrições das consultas e ações do operador |
| Redação | fatos já verificados, com PII redigida |

### Trace (`rastreio.adaptativo`)

Só códigos, contagens e durações: objetivo, relação, consultas, categorias, estimativa, correção, outros pedidos, chamadas de modelo, leituras, redação, parada, fallback e duração. Nunca texto, nomes, valores ou ids. Uso, tokens e custo seguem no registro de uso do ModelRouter.

### Rollback

- **Código:** reverter o merge.
- **Comportamento:** `AI_OPERACIONAL_ENABLED=false` desliga o ciclo (e a IA operacional inteira). Sem nova migration.

## 5. Evidências por cenário

### 5.1 Revisão (01/10/2026): lacunas reproduzidas e corrigidas

| # | Lacuna (reproduzida antes da correção) | Correção | Regressões |
|---|---|---|---|
| 1 | Sem a Luna, o fallback por regras classificava "crie uma do cliente Felipe para 50 convidados, pacote premium" como `criar_pacote` | `criacaoAmbigua` (`intencao.ts`): criação com "pacote" cujo objeto não é pacote, num pedido sobre cliente, convidados ou aniversário, vira **esclarecimento**. A pergunta repete o que foi entendido, e as sugestões são as frases completas de cada caminho, então o contexto não se perde. A extração "festa do cliente Felipe" passou a dar o cliente "Felipe". Correção relacionada: a pergunta "qual o preço do pacote premium **novo**…?" não abre mais rascunho. A Luna usa a mesma pergunta quando pede esclarecimento. | Diálogos "Fallback (lacuna 1)": sem modelo, provedor fora, 3 variações, pacote explícito, pergunta, rascunho aberto; "Luna (lacuna 1)" |
| 2 | `conferirRedacao` aceitava "60 docinhos para 240 convidados" com dados "240 docinhos para 60 convidados" | Pares **valor + unidade/categoria** (`quantidadesDe`): número com unidade no texto precisa existir com a mesma unidade nos dados; resultado com estimativa precisa dizer "estimativa"; "regra da empresa" só com regra registrada; quantidades de texto livre "como registrado" não autorizam pares. A forma da frase continua livre. | "Redação (lacuna 2)": troca valor/unidade, categoria errada, paráfrases livres aceitas, parâmetro como "regra da empresa", estimativa sem rótulo, 350 mL × 350 convidados, 999 injetado |
| 3 | `revalidar` aceitava estimativa para "Não estime o consumo; quero somente a regra cadastrada." e para "não sei" | `estimativasPedidas`: só uma **delegação positiva** ("faça você a definição", "estime", "pode sugerir") não negada na oração; veto explícito ("somente a regra cadastrada", "não quero chute") anula tudo; "não sei" sozinho nunca autoriza; a categoria vem da oração, da anterior ou do parâmetro pendente. | "Luna (lacuna 3)": 13 frases (negações, veto, "não sei", "nem pense em estimar", "mas não os doces", contexto pendente); revalidar por categoria; diálogo sem regra (pergunta) e com regra cadastrada (usa a regra) |

### 5.2 Homologação com modelo real

**1ª rodada (01/10/2026, 17:11–17:24 UTC; staging `9243d2c` = `c37ca62` + PR #58 de logo, sem mudança na IA; gpt-6-luna, effort none).** O operador fez login; os diálogos foram enviados pelo drawer "Perguntar ao Kidmais" do Admin. Custo, tokens e latência vêm do log saneado `inteligencia.conversa` (só ids, códigos e contagens; nenhum texto do pedido, nome ou valor). Nada foi gravado: os rascunhos foram cancelados ou expiram.

| # | Mensagem (resumo) | Resultado | Chamadas | Tokens | Custo (USD) | Latência |
|---|---|---|---|---|---|---|
| A1 | "crie uma do cliente Felipe para 50 convidados, pacote premium" | ok: rascunho de **festa** com cliente, pacote e convidados; pergunta só o aniversariante | 1 | 2.785 | 0,000352 | 3,5 s |
| A2 | "o aniversariante é o Theo" | ok: preenche e pergunta a data | 1 | 2.872 | 0,000219 | 2,5 s |
| A3 | "dia 14/11/2027, à tarde" | ok: data aceita; "tarde" não é turno ⇒ pergunta almoço/noite | 1 | 2.954 | 0,000233 | 2,6 s |
| A4 | "antes, quantos docinhos preciso para 60 convidados?" (rascunho aberto) | **falha 1**: "Ainda não sei responder isso" (Planner chamado sem festa) | 2 | 6.357 | 0,000583 | 5,3 s |
| A5 | "à noite" (retomada) | ok: volta ao rascunho; o Core não acha o cliente "Felipe" e pergunta o cliente | 1 | 2.993 | 0,000234 | 2,5 s |
| A6 | "Quero criar uma festa e não um pacote" (rascunho perguntando o cliente) | **falha 2**: a frase inteira virou o nome do cliente | 1 | 3.046 | 0,000239 | 2,9 s |
| A7 | "cancele esse rascunho" | ok: cancelado, nada gravado | 1 | 3.076 | 0,000240 | 2,4 s |
| B | "Quais contratos estão pendentes e quanto recebemos este mês?" | **falha 3**: só os contratos (a regra casava uma leitura e a escolha dupla da Luna era ignorada) | 2 | 3.519 | 0,000310 | 5,3 s |
| E1 | "quantos docinhos e refrigerantes para a próxima festa?" | ok: festa 26/06/2027, 60 convidados do contrato vigente; as duas regras ausentes são perguntadas | 2 | 3.896 | 0,000355 | 5,1 s |
| C | "4 doces por convidados, refrigerante de 2l. Não sei… faça você a definição." | ok: 240 docinhos; 200 mL estimados (rotulados) ⇒ 12 L = 6 garrafas de 2 L; nada perguntado de novo. Resumo determinístico sem a palavra "estimativa" (**ajuste 4**) | 2 | 4.268 | 0,000413 | 5,2 s |
| N1 | "quantos refrigerantes para a próxima festa?" | ok: pergunta a taxa e a embalagem | 2 | 3.848 | 0,000355 | 4,3 s |
| N2 | "Não estime o consumo; quero somente a regra cadastrada." | sem estimativa (ok), mas **falha 5**: esclarecimento da Luna perdeu a continuação | 1 | 3.066 | 0,000246 | 2,1 s |
| N3 | "não sei" | **falha 6**: saída da Luna rejeitada inteira (limite de campo opcional) ⇒ "Ainda não sei responder" | 1 | 2.977 | 0,000228 | 2,3 s |
| D | "pode estimar os refrigerantes da próxima festa? garrafa de 2 litros e uns 10% de margem" | ok: 500 mL estimados + 10% ⇒ 33 L = 17 garrafas; redação do modelo diz "estimativa" e "não é padrão da empresa" | 2 | 4.024 | 0,000377 | 4,9 s |
| F | "e os docinhos, com 5 por convidado?" (elipse) | ok: mesma festa, 300 docinhos para 60 convidados, divisão pendente | 2 | 3.928 | 0,000355 | 4,6 s |

Média da rodada: ~3.600 tokens e ~US$ 0,00033 por mensagem; 2,1–5,3 s; nunca mais de 2 chamadas de modelo por mensagem (teto 4).

Também achado: o trace `adaptativo` (e o `operacional`) não aparecia no log — a saída é fechada nas chaves de `novoRastreio` (**falha 7**).

**Correções (PR #61, cada uma com regressão que falha sem ela):**
1. Cálculo sem festa entendido pela Luna: pergunta "Para qual festa?" com o rascunho pausado, sem chamar o Planner.
2. Resposta crua a uma pergunta de nome só vale se parecer nome (sem palavras de pedido, até 6 palavras).
3. Duas ou mais consultas da Luna: a regra de leitura única não decide; o Planner compõe.
4. Resumo determinístico do total que usa estimativa diz "(com a estimativa que você pediu)".
5. Parâmetro de consumo pendente + mensagem sem objetivo novo (negação, "não sei"): refaz o mesmo cálculo, mesma festa, sem estimar; "não sei" ganha a dica de pedir a estimativa.
6. Saída da Luna: campo opcional fora do limite é descartado ou cortado (enums e tipos continuam estritos).
7. `operacional` e `adaptativo` entram no formato fechado do log.
8. Redação: negação de "regra da empresa" reconhecida na mesma oração ("não é uma regra da empresa", "sem regra da empresa").

**Falha do provedor:** não exercitada ao vivo nesta rodada — exigiria mudar variáveis de configuração da IA em staging (fora da autorização). Coberta pelos testes de diálogo com provedor fora do ar (HTTP 5xx ⇒ caminho anterior, sem ação automática).

**2ª rodada (01/10/2026, 18:12–18:15 UTC; staging `1dc986f`).** Só a 1ª mensagem chegou ao modelo ("crie uma do cliente Felipe para 50 convidados, pacote premium" ⇒ rascunho de festa com cliente, pacote e convidados; 1 chamada, 2.785 tokens, US$ 0,000352, 3,2 s). Da 2ª em diante, o trace `adaptativo` (agora no log) mostra `chamadasModelo: 0`, ~20 ms e `ENTENDIMENTO_INDISPONIVEL`, sem erro de provedor; o Planner também ficou `INDISPONIVEL`. Leitura: o roteador recusou a reserva antes da chamada — muito provavelmente o teto diário de tokens por empresa (`AI_BUDGET_JSON`), consumido pela 1ª rodada e pelos demais usos do dia. Não confirmado (exigiria ler a configuração ou o banco, fora da autorização).

Com isso, a rodada virou uma observação real do **caminho sem modelo**: nada automático foi gravado; cálculo determinístico correto (60 convidados, regras ausentes perguntadas); cancelamento ok; "Quero criar uma festa e não um pacote" com o rascunho perguntando um nome ⇒ "Não consegui entender a resposta" (a correção 2 da PR #61 vale também sem modelo). Duas falhas, corrigidas na PR #62 (sem testes novos, a pedido do operador):
1. "o aniversariante é o Theo" gravava "é o Theo" ⇒ o verbo e o artigo saem do nome.
2. Cálculo sem festa sem plano do Planner respondia "Ainda não sei responder" ⇒ pergunta "Para qual festa?".

**Pendências declaradas:** repetir os diálogos com o modelo (correções 1, 3, 5, 6 e 8 da PR #61 só foram comprovadas por testes de diálogo); falha do provedor ao vivo (exige mudar configuração).

**Causa exata da recusa (01/10/2026, 21:01 UTC; staging `bfe6fac`, PR #64).** O trace passou a registrar `recusasModelo`. A recusa da Luna é `ORCAMENTO / TETO_TOKENS / EMPRESA / DIA`, com reserva tentada de 12.141 a 13.263 tokens.

A visão de custos do Admin mostra, no dia:
- 89.434 tokens reais em 43 chamadas, US$ 0,00874;
- nenhuma reserva aberta ou órfã;
- nenhum custo desconhecido.

Conclusão: o **teto diário de tokens da empresa** em `AI_BUDGET_JSON` (valor não lido; ele fica entre 89.434 e 101.575) não comporta a reserva da Luna. A reserva estima a entrada a 1 token por byte e fica cerca de 4,5× acima do consumo real (~2,8k). As reservas do JEV (~3k) e do classificador antigo ainda cabem, e por isso eles continuam chamando o modelo. Ficam descartadas reserva pendente, custo desconhecido e orçamento ausente ou inválido.

**3ª rodada: fallback (21:01–21:05 UTC; staging `bfe6fac`).** Os mesmos diálogos foram enviados pelo drawer com a Luna recusada pelo orçamento. Esta rodada observa o **caminho anterior** e não serve de evidência de compreensão da Luna. Em 100% das mensagens o trace traz `recusasModelo` com `luna_entender` e `adaptativo.fallback = ENTENDIMENTO_INDISPONIVEL`. O caminho anterior ainda usou modelos pequenos em N2 (JEV + classificador antigo: 2 chamadas, 2.173 tokens, US$ 0,00026, 4,2 s) e em D e F (JEV: ~775 tokens, ~US$ 0,00011, 1,8–2,2 s). Nas demais mensagens: 0 chamadas e 23–1.104 ms.

| # | Resultado sem a Luna |
|---|---|
| A1 | ok: esclarece com o contexto (festa ou pacote) e não abre nada; a sugestão abre o rascunho de festa com cliente, pacote e convidados |
| A2–A3 | ok: aniversariante "Theo" (sem "é o"); data aceita; pergunta o turno |
| A4 | ok: "Para qual festa?" com o rascunho pausado |
| A5 | ok: retoma; o Core não acha o cliente e pergunta |
| A6 | ok: "Não consegui entender a resposta" (não vira nome) |
| A7 | ok: cancelado, nada gravado |
| B | limitação esperada: só os contratos (composição exige Luna/Planner, recusados) |
| E1 | ok: festa e convidados do Core; as duas regras ausentes são perguntadas |
| C | ok sem estimar: 240 docinhos; pergunta mL e embalagem ("2l" não é lido sem a Luna) |
| N1 | ok: pergunta taxa e embalagem |
| N2 | **falha (corrigida na PR 14)**: o classificador antigo propôs *cadastrar* "Regra de consumo da empresa" |
| N3 | **falha (corrigida na PR 14)**: "não sei" respondia ao rascunho de regra ("Não consegui entender") |
| D | **falha (corrigida na PR 14)**: "pode estimar os refrigerantes…" virou resumo da festa ("Festa em 268 dias") |
| F | ok: 300 docinhos para 60 convidados (mesma festa) |

Nada foi gravado: os rascunhos de regra abertos por N2 foram cancelados.

**Correções da PR 14 (caminho determinístico; cada uma com teste que falha sem ela):**
1. Com um parâmetro de consumo pendente, "não sei", "não estime" e "só a regra cadastrada" refazem o mesmo cálculo (mesma festa, sem estimativa) antes de qualquer classificador. É a regra que a PR #61 já aplicava no caminho da Luna.
2. "Estimar os refrigerantes/doces" é pedido de cálculo de consumo. Sem a Luna, a taxa ausente é perguntada (não há estimativa sem delegação entendida).

**4ª rodada: Luna real (01/10/2026, 21:28–21:30 UTC; staging `3b66958` = PR #65, deploy `dep-davctr9srm7s73bgvvg0`; gpt-6-luna, effort none).**

Orçamento: `AI_BUDGET_JSON` de staging passou a `{"moeda":"USD","porEmpresa":{"tokensDiario":500000,"tokensMensal":5000000,"custoDiario":0.5,"custoMensal":5}}`, com autorização do operador. Se havia `porCapacidade` ou `estimativa` antes, saíram.

As 15 mensagens rodaram sem nenhuma recusa (`recusasModelo: []`). Custo, tokens e latência vêm do trace saneado `inteligencia.conversa`.

| # | Resultado com a Luna | Chamadas | Tokens | Custo (USD) | Latência |
|---|---|---|---|---|---|
| A1 | ok: rascunho de festa com cliente, pacote e convidados direto (sem esclarecimento) | 1 | 2.785 | 0,000352 | 3,4 s |
| A2 | ok: "Theo"; pergunta a data | 1 | 2.872 | 0,000219 | 2,8 s |
| A3 | ok: data aceita; "tarde" ⇒ pergunta almoço/noite | 1 | 2.945 | 0,000229 | 2,6 s |
| A4 | ok: "Para qual festa?" com o rascunho pausado (correção 1 da PR #61) | 1 | 2.967 | 0,000231 | 2,3 s |
| A5 | ok, com ressalva: turno preenchido, mas a Luna marcou `outrosPedidos: 1` e a resposta disse "o outro que você mencionou ainda não foi feito" (o pedido de docinhos do histórico) | 1 | 3.021 | 0,000245 | 2,9 s |
| A6 | ok: não vira nome; pergunta o cliente (correção 2 da PR #61) | 1 | 3.065 | 0,000247 | 2,7 s |
| A7 | ok: cancelado, nada gravado | 1 | 3.039 | 0,000236 | 2,5 s |
| B | **falha (corrigida na PR 15)**: a Luna escolheu `contratos_pendentes` + `analisar_pagamentos`; o Planner montou 2 passos e o passo 1 deu ERRO ⇒ "ainda não consigo responder" | 2 | 6.388 | 0,000613 | 4,4 s |
| E1 | ok: festa e convidados do Core; regras ausentes perguntadas | 2 | 3.884 | 0,000366 | 4,6 s |
| C | ok: 240 docinhos; 500 mL estimados (pedido) ⇒ 30 L = 15 × 2 L; divisão pendente | 2 | 4.225 | 0,000408 | 5,1 s |
| N1 | ok: pergunta taxa e embalagem | 2 | 3.873 | 0,000359 | 5,2 s |
| N2 | **falha (corrigida na PR 15)**: a Luna rotulou como `CONSULTA` sem consultas ⇒ "Ainda não sei responder isso" | 1 | 3.072 | 0,000240 | 2,5 s |
| N3 | **falha (corrigida na PR 15)**: o mesmo, para "não sei" | 1 | 3.037 | 0,000242 | 2,6 s |
| D | ok: 500 mL estimados + 10% ⇒ 33 L = 17 × 2 L; "hipótese, não padrão da empresa" | 2 | 4.071 | 0,000381 | 5,0 s |
| F | ok: mesma festa, 300 docinhos, divisão pendente | 2 | 3.924 | 0,000353 | 4,0 s |

Total da rodada: 21 chamadas, 53.168 tokens, US$ 0,004721. Média de ~3.540 tokens e ~US$ 0,00031 por mensagem; latência de 2,3 a 5,2 s.

**Correções da PR 15 (cada uma com teste que falha sem ela):**
1. Consultas independentes pedidas pela Luna (nenhuma exige entidade de entrada) são lidas pela mesma porta guardada e compostas de forma determinística, sem o Planner. O Planner foi desenhado para cadeias e descarta listagens da resposta.
2. O executor do Planner aceita passo intermediário com fatos e sem `entidades`. A saída fica vazia, e um passo que dependa dela para em SEM_DADOS.
3. Com parâmetro de consumo pendente, a resposta sem dado reconhecida por regra ("não sei", "não estime", "só a regra cadastrada") refaz o mesmo cálculo, seja qual for o rótulo da Luna.

**Pendências (na época):**
- A5: o aviso de "outro pedido" vem do histórico. Corrigido nas PRs #67 a #73 (ver §5.3).
- Falha do provedor ao vivo: exige mudar configuração.

### 5.3 Gestão de contexto (A5) e encerramento

**Rodadas com a Luna real depois da 4ª (01/10/2026, 22:15–23:25 UTC).** Cada rodada rodou na candidata publicada e cada achado virou uma PR com regressão que falha sem a correção.

| Candidata | Achado com o modelo real | PR |
|---|---|---|
| `c594cc1` | A5: "à noite" ao rascunho contou o pedido de docinhos do histórico como novo ("o outro que você mencionou…") | #67: outro pedido exige o **trecho literal da mensagem atual**, conferido no servidor; o que vem do histórico é descartado (`adaptativo.outrosDescartados`); a instrução separa mensagem atual e contexto |
| `ec4fac2` | A5 resolvido (resposta ao campo, correção e retomada sem aviso). Mensagem mista "o cliente é … E quantos refrigerantes…?" perdeu o pedido: a frase "resposta ao rascunho não tem outros pedidos" da #67 era ampla demais | #68: frase removida; instrução de mensagem mista |
| `b72f612` | Mensagem mista: outro pedido registrado, mas a leitura com redação determinística não o anunciava. Caso C: redação com `**negrito**` mostrado cru | #69: aviso também em leitura determinística; Markdown removido antes das conferências |
| `f41018e` | Mensagem mista com rascunho: a Luna marcou RESPONDE + CALCULO_CONSUMO e o dado do rascunho se perdia | #70: RESPONDE/CORRIGE + consulta/cálculo com rascunho aberto ⇒ resposta ao rascunho primeiro e o outro pedido anunciado (`operacional.decisao = LUNA:MENSAGEM_MISTA`) |
| `ea32084` | F recebeu a margem de 10% dita antes para os refrigerantes; N3 citava a embalagem de outra pergunta; D não estimou depois de "Não estime…" no histórico | #71: parâmetros de consumo só da mensagem atual (o já informado vem da continuação); vetos antigos não valem agora |
| `6c83539` | D ainda sem estimativa na sequência N1→N3→D | #72: estimativa pedida sem valor utilizável é registrada (`estimativa_sem_valor:<categoria>` em `adaptativo.descartes`) e dita na resposta; nada é inventado |
| `c84b597` | Com o rascunho de contratação aberto, a consulta paralela de refrigerantes deixava a taxa pendente e "não estime…"/"não sei" iam ao rascunho | #73: com continuação pendente, a resposta sem dado vai ao cálculo; resposta legítima ao rascunho continua indo ao rascunho |

**Regressões de A5 e da gestão de contexto** (todas falham sem a correção): unitárias em `luna.test.ts` (histórico, correção, retomada, pedido inventado, pedido novo com pontuação/acento, trecho = mensagem inteira; parâmetros de consumo do histórico descartados com elipse da contratação preservada; instrução) e diálogos em `aceite-operacional.test.ts` (fluxo A com resposta ao campo, correção, retomada e pedido novo; mensagem mista com redação determinística e com redação da Luna; mensagem mista com rascunho; estimativa pedida sem valor; continuação com rascunho pausado).

#### Orçamento de staging (`AI_BUDGET_JSON`)

O valor anterior **não pôde ser lido**: a integração do Render não expõe valores de variáveis, os eventos do serviço não guardam valores e o app não registra o orçamento em log. Ele foi substituído por outra sessão (com autorização do operador), que também não o leu antes. O que as evidências permitem afirmar:

| Item | Antes | Agora | Evidência |
|---|---|---|---|
| `porEmpresa.tokensDiario` | existia; entre 89.434 e 101.575 (provavelmente 100.000) | 500.000 | recusa `TETO_TOKENS / EMPRESA / DIA` às 21:01 com consumo de 89.434 e reserva de 12.141 |
| `porEmpresa.tokensMensal` | desconhecido (nenhuma recusa mensal observada; o mês = o dia) | 5.000.000 | — |
| `custoDiario` / `custoMensal` / `moeda` | desconhecidos (nenhuma recusa de custo observada) | 0,50 / 5 USD | — |
| `porCapacidade` | desconhecido (nenhuma recusa com escopo CAPACIDADE) | ausente | se existia, foi removido |
| `estimativa` (fator de reserva) | desconhecido; reservas observadas coerentes com o padrão (1 token/byte, overhead 512) | ausente (padrão) | reservas de 12–13k para ~2,8k reais |

Não há mudança operacional obrigatória: a configuração atual funciona e as recusas ficam visíveis no trace. Para fechar a dúvida sobre o que foi removido, só o operador pode conferir num registro próprio (cofre de senhas, anotação ou histórico do painel, se houver).

#### Mensagem mista que completa o rascunho (PRs #74 e #75)

Antes: "o cliente é … E quantos refrigerantes para a próxima festa?" completava a preparação, a UI abria a revisão do Fechamento e fechava a conversa — o pedido de refrigerantes sumia (ou, nas PRs #69/#70, só era anunciado como "não feito").

Agora, com a integração mínima entre conversa e revisão (sem redesenho):
- **servidor** (`conversa.ts`): RESPONDE/CORRIGE + consulta/cálculo com rascunho aberto ⇒ a resposta vai ao rascunho **e** o segundo pedido é executado pelas mesmas portas guardadas; o resultado (ou a pergunta necessária, ex.: "Quantos mL de refrigerante por convidado…?") vai em `pedidoSeguinte`, e a continuação e o foco dele valem para a próxima mensagem. Não há mais aviso de "pedido não feito" para ele;
- **UI** (`PerguntarKidmais`, `conversa.ts`, `cliente-inteligencia.ts`): o segundo pedido entra como mais uma resposta do Kidmais (validada por formato fechado); ao abrir a revisão com um segundo pedido, a conversa **não fecha** — fica aberta sobre a revisão, no mesmo layout do Admin;
- **confirmação humana** inalterada: a revisão só cria o Fechamento ao concluir o formulário; o "Confirmar" do chat continua recusado (`CONFIRMAR_NA_REVISAO`).

Regressões (falham sem a correção): diálogo do fluxo completo em `aceite-operacional.test.ts` (rascunho ⇒ mensagem mista que o completa ⇒ navegação para a revisão + pergunta do cálculo ⇒ "400 ml" continua o cálculo com a revisão intocada ⇒ chat não confirma, nenhum Fechamento); mensagem mista sem completar o rascunho; provider em `inteligencia-ui.test.ts` (navega sem fechar a conversa, mostra a segunda resposta, reenvia a continuação) e formato fechado do segundo pedido.

**PR #75 (achado da rodada parcial em `3930273`, 00:30–00:32 UTC):** com o modelo real, a mensagem mista voltou com `relacaoRascunho: SEM_RASCUNHO` — a Luna rotulou só o cálculo e o nome do cliente se perdia. A mensagem mista passou a ser reconhecida também pelo **trecho** que responde ao campo pendente do rascunho (`outrosPedidos[].trecho`, conferido literalmente na mensagem atual), não só pelo rótulo da Luna. Regressão em `aceite-operacional.test.ts` (rótulo SEM_RASCUNHO + trecho ⇒ rascunho completo e segundo pedido atendido).

Limite conhecido: a conversa é estado em memória do layout do Admin. Navegar de uma tela do CRM (`/clientes`, outro layout) para a revisão (`/admin/...`) recarrega o layout e a conversa recomeça — comportamento anterior, inalterado.

#### Cobertura, em quatro frentes separadas

1. **Compreensão com o modelo real (gpt-6-luna, ECONOMY, effort none):** 1ª rodada (`9243d2c`), 4ª (`3b66958`), rodadas de §5.3 (`c594cc1` a `c84b597`) e a **rodada final** abaixo. Só contam mensagens com `luna_entender` executado (sem `recusasModelo`).
2. **Fallback (caminho anterior sem a Luna):** 3ª rodada ao vivo (`bfe6fac`, 15 diálogos com a Luna recusada): 11 ok, B limitado (composição exige Luna/Planner), 3 falhas corrigidas na PR #65. Nessa rodada os modelos menores (JEV e classificador antigo) ainda responderam onde a reserva deles cabia — não é evidência da Luna. Testes: diálogos "Fallback (lacuna 1)", "Fallback (PR 14)" e os de provedor fora do ar.
3. **Recusa de orçamento, ao vivo:** 2ª rodada (`1dc986f`) e 3ª rodada (`bfe6fac`), com a causa exata no trace (`recusasModelo`: `ORCAMENTO / TETO_TOKENS / EMPRESA / DIA` e a reserva tentada). Testes: `roteador.test.ts` (AUSENTE, INVALIDO, SEM_TETO, SEM_PRECO, TETO_TOKENS por empresa e por capacidade) e o diálogo "Luna — PR 13".
4. **Falha do provedor (HTTP 5xx, timeout, saída inválida): só testes.** Não exercitada ao vivo nesta etapa, por decisão do operador (não alterar configuração para forçá-la). Cobertura: diálogos com `ErroModelo("HTTP_5XX")` ("Fallback (lacuna 1)", "Fallback (PR 14)", "PR 18"), testes do roteador (circuito, retry, uso desconhecido, liberação da reserva em 4xx) e `hardening-jev.test.ts`.

#### Rodada final (02/10/2026, 00:44–00:47 UTC)

Candidata publicada: `82f9bb1` (merge da PR #75), deploy `dep-davfq8e7bikc73dtf1tg` live desde 00:43:37 UTC; modelo gpt-6-luna (ECONOMY, effort none). Orçamento: `AI_BUDGET_JSON.porEmpresa.tokensDiario` de staging passou de 500.000 para 1.000.000 com autorização do operador (demais campos preservados: `tokensMensal` 5.000.000, `custoDiario` 0,50, `custoMensal` 5 USD). Produção intocada.

As 20 mensagens foram enviadas numa única conversa pelo drawer "Perguntar ao Kidmais" do Admin. Todas tiveram `luna_entender` executado, `recusasModelo: []` e `errosModelo: []`, sem fallback. Nenhuma resposta trouxe Markdown cru. Custo, tokens e latência vêm do trace saneado `inteligencia.conversa`. Nada foi gravado: o rascunho foi cancelado por A7 e a revisão aberta pela mensagem mista não foi concluída.

| # | Cenário | Resultado | Chamadas | Tokens | Custo (USD) | Latência |
|---|---|---|---|---|---|---|
| 1 | A1 — criar festa (cliente, 50 convidados, pacote) | ok: rascunho de festa; pergunta o aniversariante | 1 | 3.078 | 0,000121 | 2,3 s |
| 2 | A2 — aniversariante | ok: "Theo"; pergunta a data | 1 | 3.165 | 0,000121 | 2,0 s |
| 3 | A3 — data e "à tarde" | ok: data aceita; pergunta o turno | 1 | 3.249 | 0,000130 | 2,3 s |
| 4 | A4 — docinhos para 60 convidados com rascunho aberto | ok: "Para qual festa?", rascunho pausado | 1 | 3.262 | 0,000126 | 2,7 s |
| 5 | A5 — "à noite" (resposta ao campo) | ok: turno preenchido, **sem aviso de outro pedido** (`outrosPedidos: 0`) | 1 | 3.293 | 0,000125 | 2,1 s |
| 6 | Correção ("60 convidados") | ok: rascunho corrigido, sem aviso | 1 | 3.329 | 0,000129 | 2,5 s |
| 7 | Consulta paralela de docinhos com rascunho aberto | ok: 240 docinhos; rascunho continua pausado | 2 | 4.310 | 0,000257 | 4,6 s |
| 8 | Retomada do rascunho | ok: volta ao campo pendente | 1 | 3.373 | 0,000245 | 2,5 s |
| 9 | A6 — "quero criar uma festa e não um pacote" | ok: `TROCA_OBJETIVO`, não vira nome | 1 | 3.370 | 0,000247 | 2,7 s |
| 10 | Mensagem mista: cliente + "quantos refrigerantes para a próxima festa?" | ok: `LUNA:MENSAGEM_MISTA`, `relacaoRascunho: RESPONDE`; rascunho completo ⇒ revisão aberta (`PREVIEW`); a conversa **ficou aberta** com a pergunta dos mL | 1 | 3.379 | 0,000251 | 3,1 s |
| 10a | "400 ml" (continuação do segundo pedido) | ok: 24 L; pergunta a embalagem; revisão intocada | 2 | 4.309 | 0,000368 | 3,6 s |
| 11 | A7 — "cancele esse rascunho" | ok: `CANCELADO`, nada gravado; o chat não confirma | 1 | 3.403 | 0,000246 | 2,5 s |
| 12 | B — contratos pendentes e recebido no mês | ok: 1 contrato + R$ 0,00 (composição das duas leituras) | 2 | 3.949 | 0,000325 | 3,7 s |
| 13 | E1 — docinhos e refrigerantes da próxima festa | ok: festa e convidados do Core; regras ausentes perguntadas | 2 | 4.216 | 0,000360 | 5,1 s |
| 14 | C — 4 doces por convidado, 2 L, "faça você a definição" | ok: 240 docinhos; 250 mL **estimados** ⇒ 15 L = 8 × 2 L | 3 | 5.708 | 0,000577 | 6,5 s |
| 15 | N1 — refrigerantes da próxima festa | ok: pergunta taxa e embalagem | 2 | 4.203 | 0,000356 | 4,7 s |
| 16 | N2 — "não estime; só a regra cadastrada" | ok: refaz o cálculo sem estimar e pergunta de novo | 2 | 4.245 | 0,000355 | 5,4 s |
| 17 | N3 — "não sei" | ok: dica de pedir a estimativa; embalagem antiga descartada (`descartes: embalagemMl`) | 2 | 4.286 | 0,000375 | 4,0 s |
| 18 | D — estimar refrigerantes, 2 L, 10% de margem | ok: 250 mL estimados + 10% ⇒ 16,5 L = 9 × 2 L | 2 | 4.498 | 0,000395 | 4,4 s |
| 19 | F — "e os docinhos, com 5 por convidado?" | ok: mesma festa, 300 docinhos, **sem** a margem dos refrigerantes | 2 | 4.310 | 0,000364 | 4,1 s |

Total: 30 chamadas de modelo, 76.935 tokens, US$ 0,005473 (média de ~3.850 tokens e ~US$ 0,00027 por mensagem); latência de 2,0 a 6,5 s; no máximo 3 chamadas por mensagem (teto 4).

Os 15 cenários de §5.2 (A1–A7, B, E1, C, N1–N3, D, F) e os 4 de gestão de contexto (correção, consulta paralela, retomada, mensagem mista) passaram na mesma candidata. Recusa de orçamento e fallback não aparecem nesta rodada (ver frentes 2 e 3 acima); a falha do provedor continua coberta só por testes (frente 4).
