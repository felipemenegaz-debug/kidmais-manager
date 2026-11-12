# Financeiro P2 fase B (escritor) — entrega para revisão — 10/11/2026

LOCAL e sem commit. Clone `kidmais-manager-financeiro-p2b-20261110`, branch `codex/financeiro-p2b-20261110`, sobre a fase A (`d0f7fb14`, PR #381 → staging, aberta e sem merge). Contrato: `docs/FINANCEIRO_P2_PLANO_20261109.md` §3 "Fase B" e §4 itens 4, 5 e 7. Nenhum PostgreSQL, staging, production, GitHub ou Render foi usado.

## O que mudou

| Área | Arquivo | O que faz |
|---|---|---|
| Serviço | `lib/financeiro/escritor-p2.ts` (novo) | Guarda por operação, liquidação de entrada avulsa, reversão de pagamento, abertura (leitura, confirmar/corrigir, conferência) e lista de pagamentos da conta |
| Leitor | `lib/financeiro/servico.ts` | Só exporta `conferidosDaAbertura`, que já existia |
| Rotas novas | `app/api/admin/financeiro/contas-receber/[parcelaId]/liquidacoes/route.ts` | POST liquidação (Equipe pode) |
| | `app/api/admin/financeiro/contas-pagar/[contaId]/saidas/route.ts` | GET dos pagamentos da conta, com valor já revertido e restante |
| | `app/api/admin/financeiro/contas-pagar/[contaId]/saidas/[saidaId]/reversoes/route.ts` | POST reversão (Equipe pode) |
| | `app/api/admin/financeiro/abertura/route.ts` | GET vigente, pendências e prévia (`?dataBase=`), com `podeGerir`; POST confirmar ou corrigir (só Gestão) |
| | `app/api/admin/financeiro/abertura/conferencias/route.ts` | POST conferência individual ou em lote (só Gestão) |
| Rotas alteradas | `contas-receber/route.ts`, `contas-pagar/route.ts` | O GET passa a trazer `operacoes: { liquidacao, reversao, abertura }` |
| Tela | `components/admin/FinanceiroTelas.tsx` | Ações mínimas, sem redesenho: "Registrar" na entrada avulsa em aberto, "Reverter" na conta com algo pago, e o cartão "Saldo de abertura" no fluxo |
| Seletor PG | `scripts/regressao-v1-selecao.cjs` | Declara a suíte nova no estado `121` |

O segmento dinâmico da liquidação se chama `[parcelaId]` e não `[entradaId]` como no plano. O Next não aceita dois nomes de slug no mesmo nível, e `contas-receber/[parcelaId]` já existe. A rota valida o id como uuid e o trata como id da entrada.

## Regras implementadas

**Guarda por operação (E.2, gate 3).**
- Três flags no servidor, todas desligadas por padrão: `FINANCEIRO_LIQUIDACAO_ATIVA`, `FINANCEIRO_REVERSAO_ATIVA` e `FINANCEIRO_ABERTURA_ATIVA`. Só o texto `true`, depois de trim, liga.
- A primeira linha de cada função de escrita é `await exigirEscritaP2(tx, "OP")`. Ela recusa com 409 `OPERACAO_DESLIGADA` quando a flag está desligada ou quando a 120/121 não existe no banco.
- Como a guarda fica no serviço e não na rota, qualquer caminho futuro (IA, MCP) passa por ela.
- Hoje a IA não chama nenhuma dessas escritas. Desligar a escrita não esconde leitura nem exportação.
- `operacoes` no GET só orienta a tela; o bloqueio de verdade continua no serviço.

**Papéis (D-FIN-7).**
- Liquidação e reversão: Equipe e Gestão.
- Abertura e conferência: só a Gestão, por `exigirGestaoNoTenant`, com 403 `PAPEL_NAO_AUTORIZADO`.
- Somente leitura: recusado por `exigirApiAdminCrmDisponivel` antes de abrir a transação.

**Plano.**
- Reversão, abertura e conferência exigem `FINANCEIRO_COMPLETO`.
- A liquidação de entrada avulsa não exige, igual à criação de entrada manual de hoje: contas a receber existe no Essencial.
- **Ponto para o revisor confirmar.**

**Liquidação.**
- Pode ser parcial ou total. Recusa:
  - data futura;
  - taxa maior que o valor;
  - entrada de outra empresa (404);
  - entrada com recebimento integral legado, `recebido_em`, como `JA_RECEBIDA`;
  - valor acima do saldo, como `VALOR_EXCEDE_SALDO`.
- A entrada fica travada com `FOR UPDATE`.
- Idempotência por `(empresa_id, chave)`:
  1. confere a chave antes de travar;
  2. confere de novo depois de travar, para que um repetido que esperou a trava não seja lido como excesso de saldo;
  3. grava sob SAVEPOINT, tratando o 23505.
- Grava auditoria `ENTRADA_LIQUIDADA`.

**Reversão.**
- Trava a conta com `FOR UPDATE`, a mesma trava do `pagarConta`.
- A saída precisa ser da conta e da empresa. O motivo tem de 3 a 500 caracteres.
- A data não pode ser futura nem anterior ao pagamento.
- O valor não pode passar do restante da saída, senão `VALOR_EXCEDE_PAGAMENTO`.
- Idempotência como na liquidação. Grava auditoria `PAGAMENTO_REVERTIDO`.
- O `pagarConta` da fase A já usa o pago líquido de reversões, então a conta volta a aceitar pagamento.

**Abertura.**
- Usa a trava consultiva `pg_advisory_xact_lock(hashtext('kidmais:financeiro-abertura'), hashtext(empresaId))`.
- "Hoje" vem do relógio do banco no fuso de Brasília, o mesmo relógio de `criado_em`, do qual o leitor tira a data de confirmação.
- A prévia cobre de D0 até a véspera, com `conjuntoHash`.
- Confirmar ou corrigir:
  - exige `versaoEsperada`;
  - devolve 409 `VERSAO_DIVERGENTE` com a vigente e a prévia nova;
  - devolve 409 `CONJUNTO_MUDOU` com a prévia nova;
  - grava `versao+1` com `substitui_id` e as linhas `PREVIA` na sequência 1;
  - audita `ABERTURA_CONFIRMADA` ou `ABERTURA_CORRIGIDA`.

**Conferência (C.2.2).**
- Exige a versão da revisão e os atributos vistos de cada item, num lote de até 200.
- Versão trocada: 409 `VERSAO_DIVERGENTE` com as pendências atuais.
- Item repetido no lote: `DADOS_INVALIDOS`.
- Item que não está mais pendente com aqueles atributos: 409 `ATRIBUTOS_MUDARAM`, e o lote inteiro é recusado, sem gravação parcial.
- Grava `CONFERIDO` em `MAX(sequencia)+1`, que é o histórico por acréscimo da R1 da fase A.
- Chave por item: `sha256(conferencia\0chave\0tipo:origem)`. Repetir o mesmo lote devolve `reutilizado`; conteúdo diferente com a mesma chave dá `IDEMPOTENCIA_CONFLITANTE`.

**Tela.**
- Com as flags desligadas, a tela fica igual à da fase A.
- Na abertura, a Equipe vê o cartão sem os botões.
- Depois de qualquer resposta do servidor, a próxima tentativa usa uma chave nova. Numa falha de rede, a mesma chave é reaproveitada.
- Num 409, a abertura recarrega a prévia e pede nova confirmação.

## Provas locais

| Prova | Resultado |
|---|---|
| `lib/financeiro/escritor-p2.test.ts` (serviço com banco simulado; leitor da fase A simulado só nas 4 funções usadas; outro tenant = 404 sem gravar; repetição que esperou a trava) | 23/23 |
| `lib/financeiro/escritor-p2-rotas.test.ts` (papéis, somente leitura, corpo estrito sem `empresaId`/`hoje`/`atorId`, 409 com `detalhes`, id não uuid, data futura, guarda na 1ª linha) | 20/20 |
| `components/admin/financeiro-p2b-acoes.test.ts` (flags desligadas = tela da fase A; liquidação e "Reverter" só onde cabem) | 3/3 |
| Testes de rota e de plano existentes ajustados (`contas-pagar-rota-datas`, `recebimento-data-rota`, `recursos-plano`) e de tela (`financeiro-datas-baixa`, `contas-receber-contato`, `pix-ui`, `titulos-motor`) | 17/17 e 39/39 |
| `npx tsc --noEmit` | limpo |
| ESLint nos arquivos tocados | limpo |
| `npm run check:v1:static` (testes `*.test.ts`, ESLint, tsc e `next build`), sem DATABASE_URL/PG* | PASS: 4902/4902 e 103/103, 0 falha, 0 skip, build OK (código 0) |

Observação sem causa atribuída: neste clone, `git status --short` lista cerca de 2.878 arquivos como ` M`, mas `git diff --name-only` mostra só os 13 arquivos realmente alterados. O `git hash-object` de uma amostra é igual ao hash do índice. Nada foi adicionado ao índice por causa disso.

## PostgreSQL: escrito e NÃO executado

`lib/financeiro/escritor-p2.postgres.test.ts`, estado declarado `121`. Usa duas conexões em disputa e uma terceira que observa `pg_stat_activity`, para provar que a segunda transação **esperou** a trava, e não que passou por sorte de ordem. Cenários:
1. Duas liquidações de 70 numa entrada de 100: a segunda espera e é recusada por saldo, e a soma fica em 70.
2. Mesma chave em duas conexões: a segunda espera e reaproveita a primeira. Fica uma linha só.
3. Reversão × pagamento. A conta é de 160, com 100 pagos.
   - A reversão de 60 trava a conta.
   - O pagamento de 100 espera e passa, porque vê o saldo de 120. Sem a trava, leria 60 e seria recusado.
   - O líquido final é 140.
4. Duas reversões de 60 num pagamento de 100: a segunda é recusada com `VALOR_EXCEDE_PAGAMENTO`.
5. Conferência × troca de revisão: a conferência da v1 espera a correção para v2 e recebe `VERSAO_DIVERGENTE`, sem nenhum `CONFERIDO` gravado.

Rodar exige "Sim, rodar PostgreSQL" (plano §4 item 7).

## Fora desta entrega

Fica de fora:
- commit, push e PR;
- PostgreSQL;
- aplicação da 120/121;
- staging e production;
- P3–P6;
- preços, descontos, vitrine e assinaturas.

A fase B só vai a um ambiente depois que a fase A estiver lá e conferida (gate 1).

## Revisão independente local — Codex — 10/11/2026

**Veredito: REPROVADO.** 0 P0, 1 P1, 2 P2, 0 P3. Código de produto preservado; nenhum commit ou acesso externo.

### Achados

- **F1 · P1 — Abertura pode ser confirmada para a data anterior à exibida.** `components/admin/FinanceiroTelas.tsx:542` (também 476–483, 550 e 561). O onChange atualiza dataBase imediatamente e dispara ler sem marcar carregamento. Até o GET voltar, o formulário permite submit e envia previa.dataBase e o hash antigos. Exemplo: prévia de hoje carregada, usuário escolhe ontem, informa o saldo de ontem e confirma antes da resposta: a API valida corretamente a prévia antiga e grava esse saldo em hoje. Não há 409 que impeça isso. Bloquear confirmação enquanto a prévia da data selecionada não estiver pronta, exigir correspondência entre campo e prévia e descartar respostas de consultas antigas.
- **F2 · P2 — Liquidação/reversão não renovam a chave após erro HTTP.** `components/admin/FinanceiroTelas.tsx:195` (função enviar; ver `lib/financeiro/submissao.ts:28`). Tanto corpo.ok=false quanto falha de rede chamam finalizarAcao(..., 'erro'), que mantém a mesma chave. Viola a distinção exigida entre resposta do servidor e falha de rede. Um IDEMPOTENCIA_CONFLITANTE continua usando a chave conflitante mesmo após corrigir o formulário, até fechar/reabrir. Renovar a chave após resposta recebida; preservar a chave apenas na falha de transporte. O PainelAbertura faz essa distinção para respostas JSON.
- **F3 · P2 — Idempotência da conferência não identifica o lote inteiro.** `lib/financeiro/escritor-p2.ts:478` (478–495). A chave persistida incorpora a origem e a consulta busca somente as chaves dos itens do novo pedido. Depois de K:[A,B], K:[A] retorna reutilizado em vez de IDEMPOTENCIA_CONFLITANTE; K:[C], disjunto e ainda pendente, não encontra a chave anterior e pode gravar outro lote. Persistir identidade/fingerprint do pedido completo (versão e conjunto dos itens/atributos), além da chave por linha. A validação de duplicatas também deve ocorrer antes do retorno de retry.

### Conferências solicitadas

- Diff real: 13 arquivos rastreados e 5 novos, sobre d0f7fb146fa36fb620f35c5aa67185474c6bac11, branch codex/financeiro-p2b-20261110. O status ruidoso não foi normalizado nem adicionado ao índice.
- Flags desligadas por padrão; somente trim() === 'true' liga. As quatro funções de escrita começam com exigirEscritaP2. Ausência das tabelas correspondentes resulta em 409 OPERACAO_DESLIGADA.
- Papéis: Equipe liquida/reverte; Gestão exigida para abertura/conferência; recusa comercial de mutações em somente leitura vem da guarda de sessão. Testes de rota simulam essa guarda, sem comprovar um banco real.
- **Liquidação deve continuar sem FINANCEIRO_COMPLETO nesta fase.** O recurso vigente cobre pagar/caixa/relatórios; receber e entradas avulsas já estão disponíveis no Essencial. P3 é a etapa posterior de desdobramento de gates. A ausência desse gate na liquidação é coerente com o contrato atual.
- Liquidação/reversão: consulta idempotente antes/depois do FOR UPDATE; SAVEPOINT/23505 e comparação do conteúdo presentes. Pagamento/reversão compartilham trava da conta; abertura/conferência compartilham advisory por empresa. Versão/conjunto/atributos são recusados antes dos INSERTs; a transação externa protege contra gravação parcial em erros posteriores. Ressalva de idempotência do lote: F3.
- Flags desligadas preservam o conteúdo visual de A por inspeção e testes renderizados. Nenhum navegador foi executado. Retry e troca de data têm as falhas F1/F2; a abertura recarrega a prévia no 409.
- **Desenho PostgreSQL:** os cinco cenários passam por disputa(), que mantém A sem COMMIT e só libera A depois de observar wait_event_type='Lock' do PID de B em pg_stat_activity por uma terceira conexão. PID capturado antes da operação bloqueada. Há asserções do saldo/linha única/erro esperado. Declarado em scripts/regressao-v1-selecao.cjs:83 no estado 121. Isso é revisão do desenho; não é prova de execução PG. O teste não identifica explicitamente o PID bloqueador/tipo exato de trava.

### Validações e limites

- 57/57 testes PASS: escritor-p2, escritor-p2-rotas, financeiro-p2b-acoes, contas-pagar-rota-datas e recebimento-data-rota. DATABASE_URL e PG* removidos do processo de testes.
- Contraprova temporária usando o harness do escritor: 24/24 PASS, incluindo demonstração de K:[A,B] seguido de K:[A] aceito como reutilizado. Arquivo temporário removido ao final.
- npx --no-install tsc --noEmit --incremental false: exit 0.
- ESLint dos arquivos de código do diff e dos testes novos, incluindo análise estática da suíte PG: exit 0.
- Não repetidos: check:v1:static completo, build, 21 passos CI, navegador e PostgreSQL. As provas do implementador acima são históricas, não reexecuções deste revisor.
- Sem PostgreSQL, staging, production, Render, GitHub, commit, push, PR ou correções silenciosas. Dependências/build preexistentes preservados; esta revisão não criou servidores, clusters, node_modules ou .next. Único temporário de teste removido.

**Próximos passos:** corrigir F1–F3 localmente e acrescentar testes de interação/retry e de composição do lote; nova revisão. Execução PG depende de autorização específica, conforme o plano. Sem autorização de publicação.

## Correções da revisão — implementador — 10/11/2026

As três correções são LOCAIS e sem commit, sobre o mesmo clone. Não houve PostgreSQL nem acesso externo.

**F1 (P1): abertura na data errada.** Arquivo `components/admin/FinanceiroTelas.tsx`, componente `PainelAbertura`.
- Cada leitura da abertura recebe um número. Só a resposta da leitura mais recente é aplicada, e a de uma data trocada depois é descartada.
- `previaDaData` só é verdadeiro quando não há leitura em andamento e a data da prévia na tela é igual à data escolhida no campo.
  - Fora disso, o botão fica desabilitado e o `onSubmit` sai sem POST.
  - A tela mostra "Carregando a prévia da data escolhida…" ou avisa que a prévia não é da data escolhida.
- O componente passou a ser exportado (`export function PainelAbertura`) só para o teste renderizá-lo.

**F2 (P2): chave mantida depois de recusa.** Arquivos `lib/financeiro/submissao.ts` e `FinanceiroTelas.tsx`.
- A nova função `recusarAcao` passa de submitting para error com chave nova.
- `enviar` agora separa os dois casos:
  - **sem resposta legível** (rede, ou corpo que não é JSON): `finalizarAcao(…, 'erro')`, que preserva a chave;
  - **resposta com `ok: false`**: com `renovarNaRecusa`, renova a chave.
- Só liquidação e reversão passam `renovarNaRecusa: true`. As ações da fase A e da P1 continuam exatamente como estavam.

**F3 (P2): idempotência do lote.** Arquivo `lib/financeiro/escritor-p2.ts`. Não há migration nova: o formato cabe no `varchar(160)` da 121.
- A chave de cada linha do lote passa a ser `<sha256(chave do pedido)>:<sha256(identidade do lote, origem)>`, com 129 caracteres.
  - A identidade do lote é a versão mais os itens com os atributos, em ordem canônica.
  - O retry lê com `LIKE '<prefixo>:%'` **todas** as linhas da chave, de qualquer lote.
  - Só devolve `reutilizado` quando as chaves gravadas são exatamente as do pedido. Subconjunto, superconjunto, lote disjunto ou outra versão dão `IDEMPOTENCIA_CONFLITANTE`.
  - A mesma lista em outra ordem é o mesmo pedido.
- Item repetido no lote dá `DADOS_INVALIDOS` antes de qualquer leitura, inclusive a do retry.
- As linhas `PREVIA` da confirmação mantêm a chave antiga (`chaveDaLinha`). O F3 só se aplica à conferência.

**Testes novos:**
- `escritor-p2.test.ts`:
  - lote inteiro × subconjunto, superconjunto, disjunto e outra versão;
  - ordem diferente do mesmo lote;
  - item repetido antes do retry;
  - chave ≤ 160 caracteres e com o prefixo do pedido.
- `financeiro-p2b-acoes.test.ts`:
  - recusa 409 renova a chave e a falha de rede preserva;
  - troca de data com resposta pendente não faz POST;
  - resposta antiga de outra data é descartada e o POST leva a data e o hash da prévia nova.

**Contraprova:** cada correção foi removida uma a uma e o teste rodado de novo. Os quatro mutantes foram pegos:

| Mutante | Resultado |
|---|---|
| Envio sem o bloqueio da prévia | falha |
| Sem descartar resposta antiga | falha |
| Chave mantida na recusa | falha |
| Lote sem comparar as chaves | falha |

O sha de cada arquivo foi conferido depois da restauração. Remover só a comparação de tamanho do lote é um mutante equivalente, porque a identidade do lote já está em cada chave. A comparação ficou como redundância.

**Provas locais:**

| Prova | Resultado |
|---|---|
| Suítes da fase B, rotas existentes e `submissao` | 62/62 |
| ESLint nos arquivos tocados | 0 |
| `git diff --check` | limpo |
| `npm run check:v1:static` sem DATABASE_URL/PG* | PASS: 4905/4905 e 103/103, 0 falha, 0 skip, build OK (código 0). A 1ª rodada pegou erro de tipo no teste novo (`pedir`), corrigido antes desta. |

**Não feito:**
- PostgreSQL. O desenho do teste não mudou, e a conferência dele usa a chave do pedido por meio do serviço.
- Commit, PR e qualquer ambiente.

## Revisão independente local — Codex — rodada 2 — 10/11/2026

**Veredito: REPROVADO.** 0 P0, 0 P1, **1 P2**, 0 P3. F2 e F3 fechados; o cenário original de F1 está corrigido, mas F1 ainda tem uma lacuna no caminho de data vazia. Revisão da árvore local, sem commit, na branch `codex/financeiro-p2b-20261110`, HEAD `d0f7fb146fa36fb620f35c5aa67185474c6bac11`.

### Achado remanescente

- **F1-r2 · P2 — Limpar a data não invalida a leitura pendente, que repõe a seleção abandonada e libera a confirmação.** `components/admin/FinanceiroTelas.tsx:577`, com aplicação da resposta em `:501` e `:504`. Cenário reproduzido: prévia de 10/11 carregada → escolher 01/10 (GET pendente) → apagar o campo (o botão fica desabilitado) → resposta de 01/10 chega. Como o ramo vazio não chama `ler` nem incrementa `leituraRef`, a resposta continua sendo considerada atual: `setDataBase` repõe 01/10, `lendo` termina e o botão volta a habilitar. Um submit passa e envia `dataBase=2026-10-01` e `conjuntoHash=h-outubro`, apesar de a última escolha do usuário ter sido apagar a data. **Não houve par data/hash divergente no POST desta reprodução**: o defeito é restaurar uma seleção abandonada e tornar confirmável o formulário que deveria continuar incompleto. O teste independente do contrato falhou com `'2026-10-01' !== ''`; outro teste confirmou o POST liberado no código intacto.
  - **Correção sugerida:** invalidar a geração de leitura em toda alteração do campo, inclusive vazio; encerrar corretamente o estado de carregamento da geração invalidada e manter a seleção vazia. Aplicar respostas apenas se a geração e a data solicitada ainda corresponderem à seleção atual. Preservar o preenchimento inicial quando ainda não houve seleção manual. Acrescentar o teste “data válida → vazio → resposta pendente”, incluindo campo vazio, botão desabilitado e zero POST após a resposta. Nenhuma correção de produto foi feita nesta revisão.

### Verificação de cada correção

**F1 — parcial (`FinanceiroTelas.tsx:495–589`).** Leituras não vazias são numeradas; somente a última aplica resultado, aviso e fim do carregamento. A igualdade `!lendo && dataBase !== '' && previa.dataBase === dataBase` protege botão e handler. O POST usa data/hash do mesmo objeto `previa`. Duas trocas rápidas com respostas fora de ordem passam no controle; retirar o descarte faz falhar a asserção da data. Retirar somente a guarda do handler produz POST durante a leitura e falha o teste. Erro na leitura mais recente, seguido de sucesso de leitura anterior, mantém a data escolhida e o envio bloqueado (contraprova adicional PASS). Efeito inicial: sem leitura o componente retorna `null`, logo não há formulário confirmável; o resultado inicial também verifica geração e desmontagem. O ramo vazio é a exceção descrita acima. Vazio sem leitura pendente permanece bloqueado, por inspeção da guarda.

**F2 — fechado (`submissao.ts:33`; `FinanceiroTelas.tsx:192–224`, `:332`, `:340`).** `recusarAcao` só altera ação em envio com chave, gerando chave nova. Somente liquidação e reversão optam por `renovarNaRecusa: true`. JSON com `ok:false` renova; rejeição de fetch ou de `json()` preserva. Contraprovas adicionais exercitaram reversão nos três casos, liquidação com JSON ilegível e pagamento da fase A com recusa: todos PASS. A função `finalizarAcao` e os outros chamadores mantêm o comportamento anterior; não foi estendida a opção a A/P1.

**F3 — fechado (`escritor-p2.ts:425–429`, `:489–508`).** O prefixo é SHA-256 com domínio `conferencia-lote` e a chave do pedido; o sufixo incorpora versão, conjunto canônico de origens/atributos e origem da linha. Formato: 64 hex + `:` + 64 hex = 129 caracteres, dentro de `varchar(160)` (`database/migrations/20261109_121_financeiro_abertura.sql:68`). O retry lê todas as linhas da empresa com aquele prefixo e exige igualdade do conjunto de chaves. Mesma lista em ordem diferente reutiliza; subconjunto, superconjunto, disjunto, alteração de atributos e outra versão conflitam sem INSERT. Duplicatas são recusadas antes da consulta de retry (depois da guarda e da trava). `PREVIA` continua chamando `chaveDaLinha` (`:413`, `:473`), com hash de 64 caracteres.

- **Concorrência da conferência:** `travarAbertura` (`:303`) ocorre antes da consulta do prefixo e é compartilhada por confirmação/correção. Com as rotas usando uma única transação e isolamento READ COMMITTED, A mantém a trava até COMMIT/ROLLBACK; B só consulta o prefixo depois. Se A confirmar, B com lote igual reutiliza e B com lote diferente conflita antes de INSERT; se A abortar, B pode registrar. A transação externa evita lote parcial. Colisões de `hashtext(empresaId)` apenas serializam empresas adicionais; a consulta ainda filtra a empresa. Isto é análise do código e da ordem das consultas, **não execução de concorrência em PostgreSQL**; o isolamento efetivo do banco não foi consultado.
- **LIKE:** o padrão parametrizado contém somente 64 hex literais + `:` + `%`. A chave bruta não injeta `%`/`_`, e o prefixo tem comprimento fixo; não há colisão por prefixo parcial. PREVIA não tem `:` nem 129 caracteres e não casa. Resta somente a hipótese criptográfica de colisão SHA-256, não um escape do LIKE.
- **Plano:** liquidação continua sem `FINANCEIRO_COMPLETO`, conforme o contrato vigente; conferido na rota e no serviço. Nenhum gate comercial foi acrescentado ou removido nesta revisão.

### Provas próprias, restauração e limites

- **62/62 PASS**, sem falha/skip: `escritor-p2`, `escritor-p2-rotas`, `financeiro-p2b-acoes`, `contas-pagar-rota-datas`, `recebimento-data-rota`, `submissao`. Saída: [baseline.log](evidencias/financeiro-p2b-r2-codex/baseline.log).
- **29/29 PASS** nos controles direcionados antes e depois dos mutantes. **4/4 mutantes detectados**, pelas asserções pertinentes: POST indevido, data sobrescrita, chave não renovada e ausência do conflito de lote; nenhuma classificação baseada apenas em exit code. Logs individuais na pasta de evidências.
- **Contraprovas adicionais: 5 PASS, 1 FAIL esperado pelo contrato ainda quebrado.** O FAIL é exclusivamente F1-r2; o teste que reproduz o campo reposto e o POST indevido passa, corroborando a causa. [Saída completa](evidencias/financeiro-p2b-r2-codex/contraprovas-extras.log).
- Fontes mutadas temporariamente, uma por vez, com restauração byte a byte em `finally`. SHA-256 anterior = posterior em **5/5 arquivos** (três fontes e duas suítes); controles finais verdes. [Manifesto e resultados](evidencias/financeiro-p2b-r2-codex/resultado.json). [Runner reproduzível](evidencias/financeiro-p2b-r2-codex/contraprovas.cjs), executado da raiz pelo Node, cria apenas teste temporário com mocks e o remove ao terminar.
- `DATABASE_URL` e variáveis `PG*`, `NODE_OPTIONS` e `NODE_ENV` retiradas do ambiente dos filhos de teste; sem carregamento de `.env*`. `git diff --check` limpo. Não repetidos nesta rodada: TypeScript, ESLint, build, CI completo e navegador. As provas correspondentes do implementador permanecem históricas.
- Nenhum PostgreSQL (inclusive descartável), staging, production, Render, GitHub, commit, push, PR, execução de migration ou correção de produto. Nenhum `.env*` lido ou alterado. Nenhum servidor, cluster, dependência ou build criado; dependências e `.next` preexistentes preservados. Teste temporário removido; logs, runner e manifesto preservados como evidência.

**Próximo passo:** corrigir F1-r2 localmente e repetir a revisão dirigida ao caminho vazio, mantendo as regressões de F1–F3. Sem autorização operacional ou de publicação.

## Correção do F1-r2 — implementador — 10/11/2026

LOCAL, sem commit, no mesmo clone. Sem PostgreSQL e sem acesso externo.

**Achado:** apagar a data durante um GET pendente não invalidava a leitura. A resposta repunha a data apagada e liberava o envio.

**Correção** (`components/admin/FinanceiroTelas.tsx`, `PainelAbertura`):
- Toda troca do campo passa por `escolherData`.
- **Data preenchida:** chama `ler`, que numera a leitura.
- **Data vazia:** incrementa `leituraRef` e encerra `lendo`. Assim a resposta pendente é descartada e o campo continua vazio. A guarda `previaDaData` mantém o botão e o handler bloqueados.
- O preenchimento inicial e as leituras após o POST não mudaram.

**Teste novo** (`components/admin/financeiro-p2b-acoes.test.ts`): "abertura: apagar a data invalida a leitura pendente; a resposta não repõe a data nem libera o envio".
- Sequência: data válida → vazio → resposta pendente de 01/10.
- Verifica que o campo fica vazio, o botão desabilitado, o aviso aparece e não sai nenhum POST.
- Depois verifica que escolher outra data volta a confirmar com a data e o hash dessa prévia.

**Contraprova:**

| Mutante | Resultado |
|---|---|
| Sem invalidar a leitura no ramo vazio | pego: `'2026-10-01' !== ''` |

O sha do arquivo foi conferido depois da restauração.

**Provas locais:**

| Prova | Resultado |
|---|---|
| Suítes da fase B, rotas existentes e `submissao` | 63/63 |
| ESLint nos arquivos tocados | 0 |
| `tsc --noEmit` | 0 |
| `git diff --check` | limpo |
| `npm run check:v1:static` sem DATABASE_URL/PG* | Testes 4906/4906 e 103/103 PASS. O lint do script parou em 4 erros `no-require-imports`, todos no runner de evidência do revisor (`docs/evidencias/financeiro-p2b-r2-codex/contraprovas.cjs`, não versionado), que não foi alterado. As etapas seguintes foram rodadas à mão: lint com só essa pasta ignorada (0 erros, 4 avisos preexistentes), tsc 0, `next build` 0 e verificação do PDF no build 0. |

**Nota para o revisor:** o `contraprovas.cjs` em `docs/evidencias` faz o `check:v1:static` falhar no lint enquanto estiver nessa pasta. Antes de um commit, decidir se ele vai com `/* eslint-disable @typescript-eslint/no-require-imports */` ou fora do repositório.

**Não feito:** PostgreSQL, commit e PR.

## Revisão independente local — Codex — rodada 3 — 10/11/2026

**Veredito: APROVADO no escopo LOCAL. 0 P0, 0 P1, 0 P2, 0 P3.** F1-r2 fechado; F1–F3 permanecem corrigidos. Branch `codex/financeiro-p2b-20261110`, HEAD `d0f7fb146fa36fb620f35c5aa67185474c6bac11`, alterações sem commit. Nenhuma correção de produto pelo revisor.

### Fechamento e procura de caminhos alternativos

- **F1-r2 fechado — `components/admin/FinanceiroTelas.tsx:514`–`:518`, campo em `:585`.** Toda alteração do campo chama `escolherData`: preenchida inicia leitura numerada; vazia incrementa `leituraRef` e encerra `lendo`. A resposta anterior não aplica leitura, data, erro nem término de carregamento da geração seguinte (`:501`, `:507`, `:509`). O campo permanece vazio; `previaDaData` (`:563`) mantém botão (`:597`) e handler (`:574`) bloqueados. O controle independente do caminho vazio, antes vermelho na r2, agora passa. Remover só a invalidação no vazio volta a falhar com `'2026-10-01' !== ''`.
- **Inicialização preservada — `:521`–`:530`.** Antes da leitura não há formulário; a resposta inicial preenche a data normalmente e verifica geração/desmontagem. Nenhuma alteração nesse caminho. As contraprovas verificam o preenchimento inicial.
- **Vazio → nova data, respostas fora de ordem:** testadas ambas as ordens de chegada, além de recusa e falha de rede da leitura nova seguidas do sucesso antigo. A data continua sendo a última escolhida. Quando a leitura nova falha, o envio fica bloqueado e o handler não produz POST; quando passa, o POST leva a data e o hash da prévia nova. A resposta antiga não encerra o carregamento novo.
- **POST durante edição / 409 — `:532`–`:555`, `:585`–`:587`.** Ao enviar, os campos ficam desabilitados e continuam assim até a recarga terminar. Não há edição normal do campo nessa janela; chamar artificialmente o `onChange` de um input desabilitado não representa uma interação permitida pela UI. Sucesso mantém `ler()`; 409 mantém `ler(dataBase || undefined)` para revisar antes de reenviar. Ambas as sequências foram exercitadas, inclusive nova edição e limpeza após a recarga, seguida de resposta abandonada: vazio/bloqueio preservados. Nenhum caminho adicional de resposta antiga repondo a seleção ou liberando POST foi encontrado no escopo.
- **F2/F3 continuam fechados.** Repetidos os controles de recusa/rede/JSON ilegível de liquidação e reversão, comportamento anterior do pagamento A e identidade do lote inteiro (ordem equivalente, subconjunto, superconjunto, disjunto, atributos/versão e duplicatas). Liquidação continua sem `FINANCEIRO_COMPLETO`, conforme o contrato vigente; rota/serviço conferidos, sem mudança comercial.

### Provas próprias e restauração

- **63/63 PASS**, sem falha/skip/cancelamento, nas seis suítes: `escritor-p2`, `escritor-p2-rotas`, `financeiro-p2b-acoes`, `contas-pagar-rota-datas`, `recebimento-data-rota`, `submissao`. [Baseline](evidencias/financeiro-p2b-r3-codex/baseline.log).
- **30/30 PASS** nos controles direcionados antes/depois; **11/11 PASS** nas contraprovas adicionais. A reprodução que esperava o comportamento defeituoso da r2 foi omitida; o teste do contrato correto foi mantido. [Extras](evidencias/financeiro-p2b-r3-codex/contraprovas-extras.log).
- **5/5 mutantes detectados por asserções pertinentes**, não apenas exit code: ausência da invalidação no vazio (data reposta); ausência da guarda do handler (POST indevido); ausência do descarte (data sobrescrita); ausência de renovação (mesma chave após recusa); ausência de comparação do lote (rejeição esperada ausente).
- Restauração byte a byte em `finally`; SHA-256 anterior = posterior em **5/5 arquivos**, incluindo três fontes e duas suítes. `FinanceiroTelas.tsx`: `cf0cdb937d44b04c60bc91c39ca83552f02175c07ceb8ae314ceccc6f1196c20`. [Manifesto](evidencias/financeiro-p2b-r3-codex/resultado.json). [Runner r3](evidencias/financeiro-p2b-r3-codex/contraprovas.cjs) reutiliza o runner r2 e grava resultados separados, sem sobrescrever evidências históricas.
- Decisão sobre o lint: preservar o runner r2 no conjunto de evidências com `/* eslint-disable @typescript-eslint/no-require-imports */`, limitado à regra incompatível com seus imports CommonJS. Adicionada somente essa diretiva; lógica e logs da r2 preservados. Não recomenda excluir a evidência no futuro commit.
- ESLint dos dois runners, `FinanceiroTelas.tsx` e `financeiro-p2b-acoes.test.ts`: **exit 0, sem mensagens**. `git diff --check`: limpo.
- Testes com `DATABASE_URL`, `PG*`, `NODE_OPTIONS` e `NODE_ENV` removidos do ambiente filho; mocks apenas, sem carregar `.env*`. Não repetidos: static completo, build, TypeScript, CI completo e navegador. Provas amplas do implementador continuam históricas; esta aprovação é da revisão local dirigida, não homologação PostgreSQL.
- Sem PostgreSQL, staging, production, Render, GitHub, commit, push, PR ou execução de migration. Nenhum `.env*` tocado. Temporário de teste removido; nenhum servidor, cluster, dependência ou build criado. Artefatos preexistentes e clone de trabalho preservados para continuidade; evidências mantidas.

**Próximo passo:** encaminhar o parecer local ao implementador/Felipe. Execução PostgreSQL e qualquer publicação continuam fora da autorização desta rodada.
