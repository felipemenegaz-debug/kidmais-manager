# IA operacional — entrega consolidada (candidata para revisão)

Data: 01/10/2026. Base: staging `9d9aba9`. Branch: `ai-v11/07-ia-operacional`.
Especificação: `IA_OPERACIONAL_ARQUITETURA_E_ENTREGA.md` e `PROMPT_CLAUDE_IA_OPERACIONAL.md`, na worktree `kidmais-manager-ai-operacao`.
Esta entrega não inclui merge, deploy, mudança de env/flags, migration executada nem acesso a produção.

## 0. Resumo honesto

| Situação | O quê |
|---|---|
| **Completo e verificado no código real** (unitário e integração local, sem banco) | Objetivo principal e coordenação de rascunhos; cálculo de consumo; preparação da contratação; vínculo idempotente com o formulário oficial; reconciliação de resultado incerto; consulta adaptativa com complementos depois da execução; busca de pacote do Fechamento pela empresa comprovada. |
| **Verificado com portas falsas** (simula o Core) | Matriz de aceite de ponta a ponta na conversa: CRM, festa, agenda, preço e criação do Fechamento são simulados. O Core falso modela transação e trava de linha; não é PostgreSQL. |
| **Preparado, não executado** (exige autorização de SQL, mesmo em ambiente isolado — `OPERACAO_AGENTES.md` §48) | `lib/comercial/pacote-empresa.postgres.test.ts` (busca real de pacote) e `lib/operacional/migration-059.postgres.test.ts` (059 + serviço real). Ambos pulam sem o opt-in do PostgreSQL descartável. |
| **Pendente de homologação** (exige merge, flag, migration e deploy autorizados) | Criação real do Fechamento ponta a ponta com preparação; concorrência real de duas abas em PostgreSQL; custo com o provedor real; dados reais de staging. |

## 1. O que a entrega faz

| Marco | Funcionalidade | Onde |
|---|---|---|
| A | O objeto principal define a intenção. "Crie uma festa do Felipe, pacote premium…" prepara a contratação; "crie um pacote chamado Premium" continua sendo pacote. O objeto do verbo é o primeiro substantivo depois dele: "crie uma tarefa nesta festa" não cria festa. Objeto negado não conta. | `operacional/objetivo.ts`, `intencao.ts` |
| A | Coordenador de rascunho no servidor: resposta ao campo, correção, troca de objetivo (substituição auditável, prévia antiga inválida), nova consulta (rascunho preservado e retomável), cancelar, retomar e ambíguo. | `objetivo.ts`, `acoes/modulo.ts`, `acoes/human-gate.ts`, `conversa.ts` |
| B | Projeção operacional da festa: versão contratual **vigente**, aviso de versão em preparação e escolhas **efetivas** do buffet, com a fonte de cada dado. | `leituras/operacional.ts` |
| B | Cálculo determinístico de doces e refrigerantes: inteiros, mL, embalagem indivisível com sobra; margem e divisão só se informadas. **Doces e refrigerantes na mesma pergunta** viram dois cálculos da mesma festa, cada um com os seus números. | `operacional/consumo.ts`, `leituras/operacional.ts`, `conversa.ts` |
| B | Sem regra: pergunta o parâmetro, e a resposta vale só para aquele cálculo (continuação lida das evidências estruturadas, nunca do texto). Salvar como padrão é proposta separada sob Human Gate, gravada pelo serviço da 059. | `acoes/parametros-consumo.ts`, `lib/operacional/parametros-consumo.ts` |
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

- `AIResponse.continuacao?`, `AIResponse.rascunhoPausado?`, `navegacao.proposta?`; rota `/admin/clientes/{uuid}/fechamento?rascunho={uuid}` na lista fechada.
- Evidências estruturadas do cálculo: "Categoria do cálculo" (DOCES/REFRIGERANTES) e "Parâmetro pendente" (`CATEGORIA:PARAMETRO`).
- Wizard:
  - caixa "Preparado pelo Kidmais" com as pendências;
  - "Enviar sem a preparação do Kidmais" só após uma recusa definitiva da preparação;
  - "Verificar de novo" quando o resultado é incerto (envio bloqueado até reconciliar).
- **Conflito esperado** com `codex/ux-contratos-perfil`: ela também altera `FechamentoAdminWizard.tsx` (fluxo "Revise antes de criar" em dois passos), `lib/fechamentos/administrativo.test.ts` e componentes da conversa. As mudanças daqui ficaram isoladas em `components/admin/fechamento-preparacao.ts`; no wizard, só o carregamento, o envio e a caixa.

## 4. Matriz de aceite → evidência

Tipos de evidência:
- **R:** unitário/integração sobre o código real, sem banco.
- **F:** conversa completa com portas falsas (Core simulado).
- **P:** PostgreSQL preparado, não executado.
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
| Parâmetro só da consulta / salvar padrão | "50 × 4", "salvar parâmetro confirmado", `parametros-consumo.test.ts` | F + R; banco: P |
| Nome duplicado, data, ano, horários | "nome duplicado…" | F + R |
| Versão vigente × em preparação | "versão contratual" | F |
| Composição sem frase fixa e **lacunas depois da execução** | "pergunta nova…", "MODELO: frase nova…", "lacuna DEPOIS da execução" (ponte contrato ⇒ festa), "teto de passos" (para no limite), "complemento recusado" | F |
| Outra empresa / revogado / instrução embutida | "outra empresa…", "complemento recusado" | F |
| **Busca de pacote pela empresa comprovada** | `administrativo.test.ts` (rota e serviço REAIS, repositório REAL sobre tabela fictícia) + `pacote-empresa.postgres.test.ts` | R; banco: P |
| Prévia alterada/expirada/preço mudado | "prévia alterada…", "preço mudou ⇒ recusa definitiva…" | F + R (`criarVinculo`) |
| **Resposta perdida após gravação, reenvio, alternância, duas abas, concorrência** | "resposta perdida DEPOIS da gravação", "SEM saber o resultado…", "falha ANTES de gravar", "preço mudou…", "duas abas ao mesmo tempo (com e sem trava)" | R (`enviarPreparado`/`reconciliar` + rota + vínculo, com transação e trava simuladas); banco: H |
| Zero escrita antes da confirmação / ao abrir revisão | "abrir a revisão…", "frase exata" | F |
| Modelo indisponível / falha / prazo | "MODELO indisponível", "ferramenta falha…" | F |
| Regressões | suítes existentes, benchmark | R |

## 5. Validação executada (local, Node 22.23.2)

Os números finais dos gates, em checkout limpo do commit candidato, estão no fim deste documento (§9).
- `test:inteligencia`: 394/394 nesta rodada, incluindo 29 cenários de aceite operacionais. `lib/fechamentos/administrativo.test.ts`: 47/47, com 3 testes novos ou ajustados para a busca da empresa comprovada. `lib/operacional/parametros-consumo.test.ts`: 2/2.
- **Ajuste de expectativa explicado:** dois testes do Fechamento esperavam a guarda central (`409 EMPRESA_INCOMPATIVEL`) para "pacote de outra empresa" e "pacote legado sem empresa". Com a busca pela empresa comprovada, esses pacotes nem são encontrados (`404 Pacote não disponível`), sem nenhuma associação, o que é mais restritivo. O teste novo prova que a consulta usa a empresa comprovada.
- **Defeito encontrado e corrigido:** `lib/operacional/parametros-consumo.ts` usava propriedades de parâmetro do TypeScript, que o Node em modo strip-types não carrega. Isso teria quebrado o harness PostgreSQL da 059. A aplicação, compilada pelo Next, não era afetada.
- Benchmark de linguagem natural: sem diff em relação à baseline do commit anterior (só `fes-04`, já explicado).

## 6. Custo e latência

Medidos localmente com o Core falso e sem rede (detalhe na versão anterior deste relatório). Consumo, coordenação e contratação **não chamam modelo**.

Planner por modelo: com a flag, o prompt fica cerca de 7% maior. Estimativa: +3% de tokens por pedido composto; não medido com o provedor real.

Os complementos depois da execução **não chamam modelo**. Cada um é uma leitura contada (no máximo 4 por pedido, dentro do teto de passos da orquestradora).

## 7. Limitações reais

1. **Nada tocou um PostgreSQL nesta entrega.** A busca de pacote, a trava `FOR UPDATE` da preparação e a 059 estão cobertas por testes simulados e por harnesses PostgreSQL prontos, mas não executados.
2. **A criação real do Fechamento ponta a ponta** (preço, agenda, fotografia do pacote, auditoria) não foi exercitada com banco: a correção destrava o formulário oficial, mas a validação real é de homologação.
3. **Limites:** com o teto atual da orquestradora (10 passos), pedidos com muitos fatos podem ficar parciais. Nesse caso o complemento para e a resposta aponta o que faltou, conforme testado. Ampliar o teto exige decisão própria.
4. **Continuação:** com doces e refrigerantes pendentes, a continuação segue o primeiro parâmetro pendente. A resposta seguinte recalcula só aquela categoria.
5. **Categorias:** só doces e refrigerantes; distribuição só por percentuais ou quantidades escritas; escolhas em texto livre não viram quantidades.
6. **Contratação pela conversa:** cliente por nome; turnos almoço/noite; horário, valor e pagamento ficam com o operador; cadastro incompleto encerra a preparação. "Enviar sem a preparação" exige a preparação ainda aberta.
7. **Interface:** a UI atual não lê `rascunhoPausado` (a frase vai no resumo); as evidências do cálculo aparecem como linhas de evidência; caixa e botões do wizard simples, aguardando a frente de UX.
8. **Dados de staging** não distinguem os cenários; as fixtures cobrem os casos.

## 8. Homologação (quando autorizada)

1. Autorização para rodar no PostgreSQL descartável: `check:v1:postgres` (inclui `pacote-empresa` e `migration-059`).
2. Revisão e merge em staging; aplicar a 059 com o postcheck; `AI_OPERACIONAL_ENABLED=true`; deploy pela `STAGING_DEPLOY_NONCE`.
3. Roteiro:
   - frase exata ⇒ revisão preenchida ⇒ **concluir o Fechamento real** ⇒ conferir um único Fechamento;
   - repetir o envio e abrir em duas abas ⇒ o mesmo Fechamento;
   - "quero criar uma festa e não um pacote" ⇒ rascunho de contratação;
   - "quantos doces e refrigerantes a próxima festa vai precisar?" ⇒ perguntas dos parâmetros ⇒ cálculos;
   - salvar 4 docinhos como padrão ⇒ "versão 1";
   - conferir os traces (`operacional`, `plano.aposExecucao`, `inteligencia.operacao`).
4. Rollback:
   - flag desligada (nada apagado);
   - reverter o merge;
   - 059: precheck, down (com confirmação explícita se houver dados) e postcheck.

## 9. Gates do commit candidato (`3407d2d`, checkout limpo, Node 22.23.2)

| Gate | Resultado |
|---|---|
| `test:inteligencia` | 394/394 |
| `test:ia-demo` | ok |
| Benchmark de linguagem natural | sem diff, 0 violações |
| `check:v1:static` (todos os `*.test.ts` de app/components/lib, lint, TypeScript, **build de produção** com ambiente vazio) | 1594/1594 + 103/103; build ok |
| `check:ia:prs` (composição por estágios e pilha V1) | ok |
| `tsc --noEmit`, ESLint | ok |
| `check:v1:ui` (navegação da festa, desktop e celular) | ok |
| `check:v1:postgres` | **não executado** (exige autorização de SQL) |
