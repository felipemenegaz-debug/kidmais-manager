# IA operacional — entrega consolidada

Data: 01/10/2026. Especificação: `IA_OPERACIONAL_ARQUITETURA_E_ENTREGA.md` e `PROMPT_CLAUDE_IA_OPERACIONAL.md`, na worktree `kidmais-manager-ai-operacao`.

**Estado em 01/10/2026:**

| Item | Situação |
|---|---|
| PR 7 (`ai-v11/07-ia-operacional`) | Mergeada em staging como PR #52, com merge commit `59a2ff4` (pais `6ed6c2e` + `bdc5adc`). |
| Deploy em staging | `59a2ff4` no ar com a flag (`dep-dav1ekm0tbcc73d5qmu0`, via `STAGING_DEPLOY_NONCE`, auto-deploy OFF conferido em staging e produção). `/api/health` 200; `/api/admin/inteligencia/preparacoes` deixou de responder 503 (sem dados: 400 `DADOS_INVALIDOS`). |
| Antes da flag | Só a correção do Core estava ativa (busca de pacote pela empresa comprovada), no deploy `dep-dav0ncbncjis738mj010`. |
| Migration 059 em staging | **Aplicada** em 01/10/2026 pelo script do §8: backup novo antes (`pg_dump -Fc`, 1245 itens), UP atômico, **postcheck OK** (tabela e 2 funções). Não reaplicar. |
| `AI_OPERACIONAL_ENABLED` em staging | **Ligada** (só no serviço de staging). |
| Continuação com várias categorias | Corrigida na branch `ai-v11/08-continuacao-consumo` (a partir de `59a2ff4`), PR contra staging (§1, §7). |
| Produção | Intocada. |

## 0. Resumo honesto

| Situação | O quê |
|---|---|
| **Completo e verificado no código real** (unitário e integração local, sem banco) | Objetivo principal e coordenação de rascunhos; cálculo de consumo; continuação com várias categorias; preparação da contratação; vínculo idempotente com o formulário oficial; reconciliação de resultado incerto; consulta adaptativa com complementos depois da execução; busca de pacote do Fechamento pela empresa comprovada. |
| **Verificado com portas falsas** (simula o Core) | Matriz de aceite de ponta a ponta na conversa: CRM, festa, agenda, preço e criação do Fechamento são simulados. O Core falso modela transação e trava de linha; não é PostgreSQL. |
| **Executado em PostgreSQL descartável** (autorizado; uma rodada) | `check:v1:postgres`: 29/29 suítes, na árvore de `7ffadd4`. Inclui `pacote-empresa` (busca real de pacote pelo repositório) e `migration-059` (up, postcheck, gatilhos, serviço real, rollback). Entre `7ffadd4` e `59a2ff4` nada mudou em `database/`, `lib/comercial`, `lib/operacional` nem nas suítes PostgreSQL. A `ai-v11/08` só altera a conversa e a composição, que nenhuma suíte PostgreSQL cobre; por isso a rodada não foi repetida. |
| **Não coberto por PostgreSQL** | A trava `FOR UPDATE` da preparação e a concorrência de duas abas: nenhuma suíte PostgreSQL as exercita (a `inteligencia.postgres` cobre o gateway e o tenant, não a preparação). Só testes simulados e homologação. |
| **Pendente de homologação** (exige 059 e flag em staging, autorizadas) | Criação real do Fechamento ponta a ponta com preparação; concorrência real de duas abas; salvar parâmetro na 059 real; custo com o provedor real; dados reais de staging. |

## 1. O que a entrega faz

| Marco | Funcionalidade | Onde |
|---|---|---|
| A | O objeto principal define a intenção. "Crie uma festa do Felipe, pacote premium…" prepara a contratação; "crie um pacote chamado Premium" continua sendo pacote. O objeto do verbo é o primeiro substantivo depois dele: "crie uma tarefa nesta festa" não cria festa. Objeto negado não conta. | `operacional/objetivo.ts`, `intencao.ts` |
| A | Coordenador de rascunho no servidor: resposta ao campo, correção, troca de objetivo (substituição auditável, prévia antiga inválida), nova consulta (rascunho preservado e retomável), cancelar, retomar e ambíguo. | `objetivo.ts`, `acoes/modulo.ts`, `acoes/human-gate.ts`, `conversa.ts` |
| B | Projeção operacional da festa: versão contratual **vigente**, aviso de versão em preparação e escolhas **efetivas** do buffet, com a fonte de cada dado. | `leituras/operacional.ts` |
| B | Cálculo determinístico de doces e refrigerantes: inteiros, mL, embalagem indivisível com sobra; margem e divisão só se informadas. **Doces e refrigerantes na mesma pergunta** viram dois cálculos da mesma festa, cada um com os seus números. | `operacional/consumo.ts`, `leituras/operacional.ts`, `conversa.ts` |
| B | Sem regra: pergunta o parâmetro, e a resposta vale só para aquele cálculo (continuação lida das evidências estruturadas, nunca do texto). Salvar como padrão é proposta separada sob Human Gate, gravada pelo serviço da 059. | `acoes/parametros-consumo.ts`, `lib/operacional/parametros-consumo.ts` |
| B | **Continuação com várias categorias** (`ai-v11/08`). A continuação leva a festa da pergunta (`festaId`, revalidada no Core e com prioridade sobre a tela aberta), todas as categorias pedidas (`categorias`) e os números já escritos de cada uma (`parametros` e `informados`). Cada resposta recalcula todas as categorias e pergunta só o próximo parâmetro pendente, até os dois resultados finais. Números explícitos da categoria não perguntada também valem, e a taxa e a embalagem podem vir juntas ("400 mL e garrafas de 2 litros"). Na resposta composta, o mesmo fato da mesma fonte aparece uma vez. | `conversa.ts` (`continuacaoDa`, `consumoDoPedido`, `planejarConsumo`), `operacional/consumo.ts`, `planejador/composicao.ts`, `cliente-inteligencia.ts` |
| C | Preparar a contratação pelos serviços oficiais e abrir a **revisão oficial preenchida** com referência opaca. O Confirmar do chat nunca cria. | `acoes/contratacao.ts` |
| C | **Busca de pacote do Fechamento pela empresa comprovada** (`buscarPacoteVigenteDaEmpresaPorCodigo`). O catálogo público sem tenant continua recusado (`buscarPacoteAtivoPorCodigo` intacto). Com isso, o formulário oficial volta a poder criar o Fechamento. | `comercial.repository.ts`, `fechamento-administrativo.service.ts` |
| C | **A preparação é a âncora de idempotência dos dois caminhos.** "Concluir" (com as conferências da prévia) e "Enviar sem a preparação" (só o formulário oficial) usam a mesma operação, travada na transação da criação. Reenvio, clique duplo, outra aba, resposta perdida ou troca de caminho nunca criam um segundo Fechamento. | `contratacao-revisao.ts`, `preparacoes.ts`, `components/admin/fechamento-preparacao.ts` |
| C | **Reconciliação de resultado incerto.** Rede caída, resposta perdida, 5xx ou conflito: o wizard pergunta ao servidor (somente leitura) se a preparação já virou Fechamento antes de permitir outra criação. Se não houver resposta, o envio fica bloqueado até "Verificar de novo". | `fechamento-preparacao.ts` (`enviarPreparado`, `reconciliar`), `FechamentoAdminWizard.tsx` |
| C | **Consulta adaptativa.** O Planner (regras ou modelo) monta o plano; o complemento determinístico o completa antes de executar; **depois da execução, o agente analisa o que voltou**, identifica fatos pedidos ainda faltando e busca complementos autorizados com a âncora devolvida pelo Core. A ponte festa ⇄ contrato usa a relação do Core. São no máximo 2 rodadas e 4 leituras, contadas pela orquestradora. Recusa, erro ou limite param e a resposta aponta a ausência. | `conversa.ts` (`complementarAposExecucao`), `planejador/{composicao,completar}.ts` |

Liberação: `AI_OPERACIONAL_ENABLED=true` (além das flags existentes). Sem a flag:
- as leituras e ações novas não existem;
- o coordenador não roda;
- a revisão abre vazia e o formulário segue pelo endpoint do Core.

A correção da busca de pacote é do Core e **não** depende da flag: ela destrava o formulário oficial para qualquer origem.

## 2. Decisões

1. **Contratação, não festa.** A festa só nasce depois do contrato assinado (`formalizacao.ts`). A IA prepara o Fechamento administrativo.
2. **O Core não importa a IA** (`arquitetura.test.ts`, regra 10). O vínculo é uma interface do Core (`VinculoPreparacaoFechamento`), implementada pela IA na rota `/api/admin/inteligencia/preparacoes` (abrir, situação, concluir, concluir sem preparação). A rota do Core não foi alterada.
3. **Pacote da empresa comprovada.** O Fechamento passa a buscar o pacote vigente, ativo e não arquivado da empresa do Tenant Context pelo código. Outra empresa, legado sem empresa ou mais de uma linha retornam "Pacote não disponível". A guarda central `EMPRESA_INCOMPATIVEL` continua no serviço comercial como defesa em profundidade.
4. **Uma âncora, dois caminhos.**
   - A trava da linha (`FOR UPDATE`) serializa os envios concorrentes da mesma preparação, e o segundo encontra `EXECUTADA`.
   - Sem a trava (pior caso), o compare-and-set falha, a transação do perdedor é desfeita e a reconciliação mostra o vencedor.
   - "Enviar sem a preparação" vale enquanto a preparação estiver aberta (COLETANDO/AGUARDANDO). Se ela já tiver sido encerrada no chat, o operador recarrega o formulário sem ela.
5. **Lacunas depois da execução: seleção determinística por registro de fornecedores.** O modelo participa do planejamento; a escolha dos complementos segue o registro fato → leitura → âncora, e cada leitura passa por Policy e Tenant Context no gateway. Os limites atuais da orquestradora (10 passos, 2 com modelo, 8 s) **não foram alterados**: os complementos param neles (testado).
6. **Parâmetros numa fonte versionada** (059), nunca em skill, memória ou rascunho.

## 3. Contratos com a frente de UX (aditivos)

- `AIResponse.continuacao?` (com `categorias?`, `informados?` e `festaId?` desde `ai-v11/08`; a UI só repassa o formato fechado validado por `continuacaoValida`), `AIResponse.rascunhoPausado?`, `navegacao.proposta?`; rota `/admin/clientes/{uuid}/fechamento?rascunho={uuid}` na lista fechada.
- Evidências estruturadas do cálculo: "Categoria do cálculo" (DOCES/REFRIGERANTES) e "Parâmetro pendente" (`CATEGORIA:PARAMETRO`).
- Wizard:
  - caixa "Preparado pelo Kidmais" com as pendências;
  - "Enviar sem a preparação do Kidmais" só após uma recusa definitiva da preparação;
  - "Verificar de novo" quando o resultado é incerto (envio bloqueado até reconciliar).
- O conflito com `codex/ux-contratos-perfil` (#51) no `FechamentoAdminWizard.tsx` foi resolvido em `bdc5adc`: o fluxo "Revise antes de criar" em dois passos foi mantido e a preparação do Kidmais foi acrescentada.

## 4. Matriz de aceite → evidência

Tipos de evidência:
- **R:** unitário/integração sobre o código real, sem banco.
- **F:** conversa completa com portas falsas (Core simulado).
- **P:** executado em PostgreSQL descartável (`check:v1:postgres`, 29/29).
- **H:** só na homologação.

| Caso (§8) | Teste | Evidência |
|---|---|---|
| Frase exata ⇒ preparar contratação | "frase exata" | F + R (extração em `operacional.test.ts`) |
| Correção festa/pacote no rascunho | "troca o objetivo" | F |
| Doces/refrigerantes com rascunho aberto | "rascunho preservado e retomável" | F |
| Pacote explícito | "criar pacote explicitamente" | F |
| 50 × 4 = 200 | "50 convidados × 4" | F + R (`calcularDoces`) |
| Sem escolhas / sem divisão | "doces sem escolhas…" | F + R |
| Refrigerantes | "refrigerantes" | F + R |
| **Doces E refrigerantes, variações sem regra** | "doces E refrigerantes (regras)", "MODELO: variações…" (3 frases × 3 planos) | F |
| **Continuação com várias categorias** (pergunta ⇒ "4" ⇒ "400 mL e garrafas de 2 litros" ⇒ dois resultados, festa preservada mesmo com outra festa aberta na tela, sem fato repetido) | "continuação com várias categorias…", "…em outra ordem…", "continuação adulterada…" (festa de outra empresa negada; formatos inválidos com 400), extrator em `operacional.test.ts`, deduplicação em `composicao.test.ts` | F + R |
| Parâmetro só da consulta / salvar padrão | "50 × 4", "salvar parâmetro confirmado", `parametros-consumo.test.ts`, `migration-059.postgres.test.ts` | F + R + P; staging: H |
| Nome duplicado, data, ano, horários | "nome duplicado…" | F + R |
| Versão vigente × em preparação | "versão contratual" | F |
| Composição sem frase fixa e **lacunas depois da execução** | "pergunta nova…", "MODELO: frase nova…", "lacuna DEPOIS da execução" (ponte contrato ⇒ festa), "teto de passos" (para no limite), "complemento recusado" | F |
| Outra empresa / revogado / instrução embutida | "outra empresa…", "complemento recusado" | F |
| **Busca de pacote pela empresa comprovada** | `administrativo.test.ts` (rota e serviço REAIS, repositório REAL sobre tabela fictícia) + `pacote-empresa.postgres.test.ts` | R + P; staging: H |
| Prévia alterada/expirada/preço mudado | "prévia alterada…", "preço mudou ⇒ recusa definitiva…" | F + R (`criarVinculo`) |
| **Resposta perdida após gravação, reenvio, alternância, duas abas, concorrência** | "resposta perdida DEPOIS da gravação", "SEM saber o resultado…", "falha ANTES de gravar", "preço mudou…", "duas abas ao mesmo tempo (com e sem trava)" | R (`enviarPreparado`/`reconciliar` + rota + vínculo, com transação e trava simuladas); PostgreSQL: não coberto; staging: H |
| Zero escrita antes da confirmação / ao abrir revisão | "abrir a revisão…", "frase exata" | F |
| Modelo indisponível / falha / prazo | "MODELO indisponível", "ferramenta falha…" | F |
| Regressões | suítes existentes, benchmark | R |

## 5. Validação executada (local, Node 22.23.2)

Os números finais dos gates estão no fim deste documento (§9: PR 7 no candidato final; `ai-v11/08` na árvore de trabalho).
- `test:inteligencia` da PR 7: 394/394, incluindo 29 cenários de aceite operacionais. Na `ai-v11/08`: 398/398, com 32 cenários de aceite. `lib/fechamentos/administrativo.test.ts`: 47/47, com 3 testes novos ou ajustados para a busca da empresa comprovada. `lib/operacional/parametros-consumo.test.ts`: 2/2.
- **Ajuste de expectativa explicado:** dois testes do Fechamento esperavam a guarda central (`409 EMPRESA_INCOMPATIVEL`) para "pacote de outra empresa" e "pacote legado sem empresa". Com a busca pela empresa comprovada, esses pacotes nem são encontrados (`404 Pacote não disponível`), sem nenhuma associação, o que é mais restritivo. O teste novo prova que a consulta usa a empresa comprovada.
- **Defeito encontrado e corrigido:** `lib/operacional/parametros-consumo.ts` usava propriedades de parâmetro do TypeScript, que o Node em modo strip-types não carrega. Isso teria quebrado o harness PostgreSQL da 059. A aplicação, compilada pelo Next, não era afetada.
- Benchmark de linguagem natural: sem diff em relação à baseline do commit anterior (só `fes-04`, já explicado).

## 6. Custo e latência

Medidos localmente com o Core falso e sem rede (detalhe na versão anterior deste relatório). Consumo, coordenação e contratação **não chamam modelo**.

Planner por modelo: com a flag, o prompt fica cerca de 7% maior. Estimativa: +3% de tokens por pedido composto; não medido com o provedor real.

Os complementos depois da execução **não chamam modelo**. Cada um é uma leitura contada (no máximo 4 por pedido, dentro do teto de passos da orquestradora).

## 7. Limitações reais

1. **PostgreSQL:** a busca de pacote e a 059 rodaram em PostgreSQL descartável (29/29). A trava `FOR UPDATE` da preparação e a concorrência de duas abas **não** têm suíte PostgreSQL; ficam para a homologação.
2. **A criação real do Fechamento ponta a ponta** (preço, agenda, fotografia do pacote, auditoria) não foi exercitada com banco: a correção destrava o formulário oficial, mas a validação real é de homologação.
3. **Limites:** com o teto atual da orquestradora (10 passos), pedidos com muitos fatos podem ficar parciais. Nesse caso o complemento para e a resposta aponta o que faltou, conforme testado. Ampliar o teto exige decisão própria.
4. **Continuação (corrigida em `ai-v11/08`, ainda não mergeada):** em staging (`59a2ff4`), com doces e refrigerantes pendentes, a resposta ao primeiro parâmetro recalcula só aquela categoria e perde a outra. A festa vem da tela/foco, e outra festa aberta na tela a desviaria. Também havia uma falha: dois cálculos ancorados na tela ou no foco eram recusados pelo validador de plano (só o 1º passo pode ler o contexto). Na branch nova o 2º cálculo lê a festa devolvida pelo 1º. Até essa branch chegar a staging, homologar a pergunta combinada com a ressalva do §8 (4.5).
5. **Categorias:** só doces e refrigerantes; distribuição só por percentuais ou quantidades escritas; escolhas em texto livre não viram quantidades.
6. **Contratação pela conversa:** cliente por nome; turnos almoço/noite; horário, valor e pagamento ficam com o operador; cadastro incompleto encerra a preparação. "Enviar sem a preparação" exige a preparação ainda aberta.
7. **Interface:** a UI atual não lê `rascunhoPausado` (a frase vai no resumo); as evidências do cálculo aparecem como linhas de evidência; caixa e botões do wizard simples, aguardando a frente de UX.
8. **Dados de staging** não distinguem os cenários; as fixtures cobrem os casos.

## 8. Homologação em staging (roteiro corrigido)

Cada passo exige a autorização correspondente. Produção fica fora. Depois de cada deploy, entrar de novo no Admin. Chamadas manuais precisam do `x-csrf-token` de `/api/admin/autenticacao`.

**Pré-requisitos, nesta ordem:**

1. **059 em staging**, pelo script `aplicar-059-staging.ps1`:
   - commit alvo `59a2ff4`: o SHA completo é conferido contra `origin/staging`, e o SQL é extraído do commit e conferido pelo blob;
   - URL digitada mascarada; só aceita o host do staging, o banco `kidmais_staging_1z91` e os usuários do staging;
   - Fase A, só leitura: identidade, sonda UTF-8, 055a–058 presentes, 059 ausente e backup `pg_dump -Fc` novo;
   - frase de confirmação `APLICAR 059 EM kidmais_staging_1z91 PARA 59a2ff4`;
   - Fase B: releitura do alvo, 059 (atômica), postcheck só leitura e estado final;
   - nunca executa o DOWN.

   Validação sem conexão (01/10/2026):
   - conferidos: sintaxe, variáveis definidas, binários do PostgreSQL 18.6, arquivos auxiliares, funções, frase, ausência de DOWN e arquivos no alvo;
   - `"$binpsql.exe"` foi corrigido para `"$bin\psql.exe"`, e o validador acusa a versão antiga.
2. **Flag:**
   - conferir de novo que o auto-deploy está OFF em staging e em produção;
   - definir `AI_OPERACIONAL_ENABLED=true` **só** no serviço de staging e fazer o deploy via `STAGING_DEPLOY_NONCE`;
   - conferir `/api/health`;
   - `POST /api/admin/inteligencia/preparacoes` sem sessão deve deixar de responder 503 `PREPARACAO_INDISPONIVEL`.
3. **(Recomendado antes do passo 4.5)** Levar a `ai-v11/08` a staging (PR, CI, merge commit e deploy autorizados), para homologar a pergunta combinada já com a continuação corrigida.

**Roteiro (Admin de staging, empresa de teste):**

| # | Ação | Esperado | Onde conferir |
|---|---|---|---|
| 4.1 | Na conversa: "crie uma festa do Felipe, pacote premium 50 convidados, beatriz 1 ano; tema unicórnio", com cliente, pacote e data que existam em staging | Rascunho de **contratação** (não pacote), perguntando só o que falta. "Abrir revisão" leva a `/admin/clientes/{id}/fechamento?rascunho={id}` com o formulário **preenchido** e a caixa "Preparado pelo Kidmais". Nenhuma escrita até criar. | Tela; traces `operacional` e `inteligencia.operacao` |
| 4.2 | Revisar e **criar** o Fechamento pelo formulário oficial | Um Fechamento criado; a preparação vira EXECUTADA | Lista de Fechamentos do cliente (um só) |
| 4.3 | Reenviar; depois abrir a mesma revisão em **duas abas** e enviar nas duas | Sempre o **mesmo** Fechamento, nenhum segundo | Lista do cliente; traces sem nova criação |
| 4.4 | Com um rascunho de pacote aberto: "quero criar uma festa e não um pacote" | O objetivo troca para contratação; a prévia antiga é invalidada | Tela; trace `operacional` |
| 4.5 | Sem regra salva: "quantos doces e refrigerantes a próxima festa vai precisar?" ⇒ "4" ⇒ "400 mL e garrafas de 2 litros" | **Com `ai-v11/08`:** a 1ª resposta pergunta os docinhos; a 2ª calcula os doces e pergunta os mL; a 3ª traz os dois resultados (doces e embalagens) da mesma festa, sem perguntar de novo e sem fato repetido. **Só com `59a2ff4`:** depois do "4" a categoria refrigerantes se perde. Nesse caso, refazer a pergunta já com os números ("…4 docinhos por convidado, 400 ml de refrigerante por convidado, garrafas de 2 litros") e registrar a limitação. | Tela; trace `plano` (passos `calcular_consumo`) |
| 4.6 | Abrir outra festa na tela no meio da sequência 4.5 e responder | Com `ai-v11/08`: o cálculo continua sendo da festa da pergunta | Entidades da resposta |
| 4.7 | "salvar 4 docinhos por convidado como padrão" ⇒ confirmar | Proposta sob Human Gate. Após confirmar, "versão 1"; repetir a confirmação não cria versão 2. Nova pergunta de doces usa a regra da empresa. | Tela; `operacional_parametros_consumo` (consulta só leitura, se autorizada) |
| 4.8 | Pergunta com lacuna: "do contrato mais recente, quantos doces e refrigerantes a festa vai precisar?" | Ponte contrato ⇒ festa pelo Core; cálculos com a regra salva | Trace `plano.aposExecucao` |
| 4.9 | Conferir os logs do serviço de staging | Traces `operacional`, `plano.aposExecucao` e `inteligencia.operacao` sem nomes, valores, ids de cliente, segredos ou prompts | Logs do Render (staging) |

**Rollback:**
- desligar `AI_OPERACIONAL_ENABLED`: nada é apagado e a conversa volta ao comportamento anterior;
- reverter o merge, se preciso;
- 059, só com decisão explícita: precheck de rollback, DOWN (com confirmação explícita se houver dados) e postcheck. O script de aplicação nunca executa o DOWN.

## 9. Gates

### PR 7 — candidato final (`bdc5adc`, já com o #51, checkout limpo, Node 22.23.2; o mesmo conteúdo foi mergeado como `59a2ff4`)

| Gate | Resultado |
|---|---|
| `test:inteligencia` | 394/394 |
| `test:ia-demo` | ok |
| Benchmark de linguagem natural | sem diff, 0 violações |
| `check:v1:static` (todos os `*.test.ts` de app/components/lib, lint, TypeScript, **build de produção** com ambiente vazio) | 1594/1594 + 103/103; build ok |
| `check:ia:prs` (composição por estágios e pilha V1) | ok |
| `tsc --noEmit`, ESLint | ok |
| `check:v1:ui` (navegação da festa, desktop e celular) | ok |
| `check:v1:postgres` (autorizado; árvore de `7ffadd4`, sem mudança de banco/suítes até `bdc5adc`; cluster descartável NOVO, `cluster_name=kidmais_descartavel`, porta 55591, sem o banco real) | **29/29 arquivos OK**, inclusive `pacote-empresa` (busca real) e `migration-059` (up, postcheck, gatilhos, serviço real, rollback) |

### `ai-v11/08-continuacao-consumo` — árvore de trabalho sobre `59a2ff4` (Node 22.23.2)

| Gate | Resultado |
|---|---|
| `test:inteligencia` | 398/398 (aceite operacional 32/32) |
| `check:v1:static` (com build de produção) | 1598/1598 + 103/103; build ok; lint com 1 aviso anterior, em arquivo não alterado (`skills/catalogo.ts`) |
| `check:ia:prs` | ok |
| `tsc --noEmit`, ESLint dos arquivos alterados | ok |
| `check:v1:ui` | ok |
| Benchmark de linguagem natural | sem diff |
| `check:v1:postgres` | não repetido (ver §0) |
