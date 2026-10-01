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
| 13 | Homologação com o modelo real pelo app de staging (custo e latência medidos) | em andamento | §5.2: 1ª rodada em `9243d2c` (7 falhas e 1 ajuste, corrigidos na PR #61); 2ª rodada após o redeploy |

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
