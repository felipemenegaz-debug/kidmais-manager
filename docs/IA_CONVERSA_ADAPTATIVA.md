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
| 10 | Gates locais (testes, TypeScript, ESLint, build, UI, benchmark) | pendente | |
| 11 | PR, CI, merge em staging e deploy manual | pendente | |
| 12 | Homologação com o modelo real pelo app de staging (custo e latência medidos) | pendente | |

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

(preenchida durante a validação)
