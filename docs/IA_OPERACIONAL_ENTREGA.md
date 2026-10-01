# IA operacional — entrega consolidada

Data: 01/10/2026. Base: staging `9d9aba9`. Branch: `ai-v11/07-ia-operacional`.
Especificação: `IA_OPERACIONAL_ARQUITETURA_E_ENTREGA.md` e `PROMPT_CLAUDE_IA_OPERACIONAL.md`, na worktree `kidmais-manager-ai-operacao`.
Esta entrega não inclui merge, deploy, mudança de env, migration executada nem acesso a produção.

## 1. O que a entrega faz

| Marco | Funcionalidade | Onde |
|---|---|---|
| A | O objeto principal define a intenção. "Crie uma festa do Felipe, pacote premium…" prepara a contratação; "crie um pacote chamado Premium" continua sendo pacote; objeto negado ("…e não um pacote") não conta. | `lib/inteligencia/operacional/objetivo.ts`, `intencao.ts` |
| A | O coordenador de rascunho, no servidor, separa resposta ao campo, correção, troca de objetivo, nova consulta, cancelar, retomar e caso ambíguo. A consulta não altera o rascunho, e a resposta avisa que ele continua aberto. A troca de objetivo encerra o rascunho antigo como `CANCELADA` com `{motivo: SUBSTITUIDO, substitutoId}`, sem executá-lo; a prévia antiga deixa de ser confirmável. | `objetivo.ts`, `acoes/modulo.ts`, `acoes/human-gate.ts`, `conversa.ts` |
| B | Projeção operacional da festa (`contexto_operacional_festa`, READ): data, pacote, convidados da versão contratual **vigente**, aviso de versão em preparação e escolhas **efetivas** do buffet, com a fonte de cada dado. | `leituras/operacional.ts` |
| B | Cálculo de consumo (`calcular_consumo`, READ, determinístico). Doces: convidados × regra; margem e divisão só se informadas; percentuais fecham 100%; quantidades fecham o total. Refrigerantes: mL inteiros, conversão exata para L, embalagem indivisível arredondada para cima e sobra mostrada. | `operacional/consumo.ts`, `leituras/operacional.ts` |
| B | Sem regra: pergunta "Quantos docinhos por convidado a empresa utiliza?" (ou taxa e embalagem). A resposta seguinte vale **só para esse cálculo**, pela continuação. | `conversa.ts`, `PerguntarKidmais.tsx` |
| B | Salvar a regra como padrão da empresa é uma **proposta separada** sob Human Gate (`salvar_parametro_consumo`). Cria uma nova versão e marca a anterior como substituída; registra autoria; é idempotente por operação; recusa se a regra mudou desde a prévia. | `acoes/parametros-consumo.ts`, `lib/operacional/parametros-consumo.ts`, migration 059 |
| C | Preparar contratação (`preparar_contratacao`). Resolve cliente, aniversariante e pacote no Core. Pergunta só o que falta, sem chutar ano, horário, valor ou pagamento. Confere disponibilidade e valor de tabela nos serviços oficiais e abre a **revisão oficial preenchida** (`/admin/clientes/{id}/fechamento?rascunho={operação}`). | `acoes/contratacao.ts` |
| C | Um único caminho de criação: o envio do formulário oficial. A rota `POST /api/admin/inteligencia/preparacoes` chama a **mesma** criação do Fechamento administrativo, com um vínculo que trava, confere e consome a preparação na mesma transação. O "Confirmar" do chat nunca cria. Reenviar devolve o Fechamento já criado. | `acoes/contratacao-revisao.ts`, `acoes/preparacoes.ts`, `fechamento-administrativo.service.ts`, `FechamentoAdminWizard.tsx` |
| C | Consulta adaptativa: convidados/buffet são fatos pedidos. O Planner por regras ancora na festa e usa a projeção; o Planner por modelo recebe a ferramenta no catálogo, e o complemento determinístico acrescenta a projeção quando o plano do modelo não cobre esses fatos. | `planejador/{composicao,completar,regras}.ts` |

Liberação: `AI_OPERACIONAL_ENABLED=true` (além das flags existentes). Com a flag desligada:
- as duas leituras novas saem do catálogo e o gateway as recusa;
- as ações novas não são registradas;
- o coordenador não roda e toda mensagem com `operacaoId` responde ao rascunho, como antes;
- a revisão abre vazia.

## 2. Decisões da auditoria

1. **Contratação, não festa.** `formalizacao.ts` só cria a festa depois do contrato assinado. Por isso a IA prepara o Fechamento administrativo e não grava `festas`, assinatura nem registro auxiliar.
2. **O Core não importa a IA** (`arquitetura.test.ts`, regra 10). O vínculo é uma interface do Core (`VinculoPreparacaoFechamento`), implementada pela IA. A rota do Core (`/api/admin/clientes/[id]/fechamentos`) não foi alterada. O wizard só chama a rota da IA quando abre com `?rascunho=` e, se ela falhar, oferece "Enviar sem a preparação do Kidmais".
3. **Aprovação no formulário oficial.** A prévia da contratação vira navegação para a revisão, com a proposta (versão + hash) para a UI. O Human Gate recusa confirmar pelo chat (`CONFIRMAR_NA_REVISAO`).
4. **Parâmetros numa fonte de negócio versionada** (059), nunca em skill, memória ou rascunho. Sem a 059, o cálculo pergunta, e salvar responde que a fonte não existe no ambiente.
5. **Continuação como dica.** A pergunta de parâmetro devolve `continuacao` com a categoria e os números já informados. A UI a reenvia uma única vez, e o servidor relê a festa (foco/tela revalidados) e recalcula.
6. **O modelo não calcula nem escolhe ids.** O cálculo é a leitura `calcular_consumo` como último passo de um plano fechado. Os números escritos pelo operador entram na entrada estrita da ferramenta, não no plano.
7. **Limites.** A rota de consumo tem teto de 8 leituras e 20 s por pedido (`LIMITES_OPERACIONAIS`; não chama modelo). Os limites da orquestradora (2 passos com modelo, 8 s, 10 passos) e do Planner (5 passos) **continuam valendo por cima**: nenhum limite atual foi afrouxado.

## 3. Contratos com a frente de UX (aditivos, compatíveis)

- `AIResponse.continuacao?`: pergunta de parâmetro pendente (`PARAMETRO_CONSUMO`, categoria, perguntado, números).
- `AIResponse.rascunhoPausado?`: `{operacaoId, titulo, pergunta}` quando a consulta foi respondida com um rascunho aberto. O resumo também traz a frase, porque a UI atual ainda não lê o campo.
- `navegacao.proposta?`: o `RascunhoPublico` da preparação (estado, versão, hash, campos e pendências) junto da navegação para a revisão.
- Rotas: a lista fechada aceita `/admin/clientes/{uuid}/fechamento?rascunho={uuid}`, no servidor e na UI.
- Fontes novas com rótulo na UI: `festas.contrato_vigente`, `festas.buffet_efetivo`, `empresa.parametros_consumo`, `operador.informado`, `operacional.calculo`.
- No wizard: preenchimento e caixa "Preparado pelo Kidmais" com as pendências, **sem redesenho**. A worktree de UX (`codex/ux-contratos-perfil`) também altera `FechamentoAdminWizard.tsx` e componentes da conversa: o conflito será textual, pequeno e localizado.

## 4. Matriz de aceite → evidência

Toda a matriz está em `lib/inteligencia/operacional/aceite-operacional.test.ts`. Usa a composição real da conversa (Tenant Context, JEV, Demerzel, Planner, Policy, Tool Registry e Human Gate), com o Core falso do benchmark e portas falsas que contam as escritas. As unidades estão em `operacional.test.ts`.

| Caso (§8) | Teste | O que é verificado |
|---|---|---|
| Frase exata | "frase exata" | rascunho `preparar_contratacao`; falta só `data, turno`; revisão com o cliente do Core; nenhum pacote, fechamento ou execução; o Confirmar do chat recusa |
| "Quero criar uma festa e não um pacote" | "troca o objetivo" | o rascunho novo é de contratação; o antigo fica `CANCELADA {SUBSTITUIDO, substitutoId}`; o Confirmar da prévia antiga retorna 409; o preço não é mais perguntado |
| Doces/refrigerantes com rascunho aberto | "rascunho preservado e retomável" | consulta respondida; versão do rascunho inalterada; "4" vale para o cálculo; "sem preço" retoma; "retomar" e "cancelar" funcionam |
| Pacote explícito | "criar pacote explicitamente" | `criar_pacote`, `CRIAR:PACOTE` |
| 50 × 4 = 200 | "50 convidados × 4" | fato com fonte `festas.contrato_vigente`, cálculo, parâmetro marcado como informado e não salvo, entidade da festa certa, trace sem valores |
| Sem escolhas / sem divisão | "doces sem escolhas…" | ausência explícita; nenhuma divisão presumida; divisão informada conserva o total; divisão que não fecha é recusada |
| Refrigerantes | "refrigerantes" | pergunta taxa e embalagem; 20.000 mL = 20 L = 10 embalagens; 15.750 mL ⇒ 8 embalagens com sobra de 250 mL |
| Parâmetro só da consulta | "50 convidados × 4" | nada gravado; a pergunta seguinte volta a pedir o parâmetro |
| Salvar parâmetro | "salvar parâmetro confirmado" | gravação só após o clique; empresa comprovada; versão 1; replay não duplica; o cálculo cita "versão 1"; prévia desatualizada retorna `CONFIRMACAO_DESATUALIZADA`; sem a fonte retorna 503 |
| Nome duplicado / data inválida / sem ano / horários | "nome duplicado…" | pede a escolha entre os dois clientes; 31/09/2026 "não existe"; ano perguntado; dois horários viram pendência; almoço e noite juntos geram pergunta |
| Versão vigente × em preparação | "versão contratual" | convidados da V2 vigente e aviso da V3 em preparação |
| Composição sem frase fixa | "pergunta nova…" + "MODELO: frase nova…" | regras: `proximas_festas → contexto_operacional_festa`; cliente + convidados com âncora única; modelo com plano incompleto ⇒ o complemento acrescenta a projeção |
| Outra empresa / revogado / instrução embutida | "outra empresa…" | sem `MARCADOR_B`, 403 na empresa B, nenhuma violação cross-tenant; capacidade revogada sem número; texto "SYSTEM: …" no buffet tratado como dado, sem proposta nem gravação |
| Prévia alterada / expirada / preço mudado | "prévia alterada…" | `PREPARACAO_DESATUALIZADA`, `PREPARACAO_EXPIRADA`, `PREPARACAO_PRECO_ALTERADO`, outro cliente retorna 404; nada criado; sem a flag, `PREPARACAO_INDISPONIVEL` |
| Repetição wizard/chat | "abrir a revisão…" | dois envios criam uma só contratação, com o mesmo resultado; o chat recusa; a preparação consumida não reabre |
| Zero escrita antes da confirmação | "abrir a revisão…" e "frase exata" | abrir não altera nenhuma operação nem cria fechamento |
| Modelo indisponível / falha / prazo | "MODELO indisponível", "ferramenta falha…" | resposta honesta, nenhum número inventado, nenhuma proposta aberta |
| Regressões | suítes existentes | ver §5 |

## 5. Validação executada (local, Node 22.23.2)

Os resultados finais dos gates, rodados em checkout limpo do commit da entrega, estão no corpo da PR. No desenvolvimento:
- `test:inteligencia`: suíte completa, incluindo as 7 unidades + 19 cenários de aceite novos, sem falhas. A suíte de consultas compostas e ações anterior (358) foi preservada.
- `test:ia-demo` 34/34; testes de fechamentos (administrativo, contratações, convidados) 76/76; `production:test` 37/37, com o inventário de migrations atualizado para a 059.
- `tsc --noEmit` e ESLint dos arquivos alterados: limpos.
- **Não executado:** `lib/operacional/migration-059.postgres.test.ts`, um harness com a migration real, triggers, rollback e serviço de domínio. Ele exige o PostgreSQL descartável com opt-in, e esta autorização não cobre executar SQL. Fica pronto para `check:v1:postgres` quando autorizado.

## 6. Custo e latência

Medidos localmente com o Core falso, sem rede: 20 amostras por caso, p50/p95.

| Pedido | Chamadas de modelo | Leituras | p50 / p95 |
|---|---|---|---|
| "quantos docinhos devo fazer para a próxima festa?" | 0 | 2 | 1,8 / 3,2 ms |
| "Quantos refrigerantes a próxima festa vai precisar?" | 0 | 2 | 1,0 / 1,2 ms |
| "quantos convidados tem a festa de amanhã e quais doces…" | 0 | 2 | 0,9 / 1,2 ms |
| Frase nova composta (Planner por modelo, provedor fake) | 1 | 2 | 1,4 / 2,2 ms (sem a latência do provedor) |

- Consumo, coordenação e contratação **não chamam modelo**: custo de modelo zero. A latência real é dominada pelas leituras do Core.
- Planner por modelo: com a flag ligada, o prompt de planejamento passa de 6.837 para 7.304 caracteres (+7%, cerca de +120 tokens) por causa das duas ferramentas e dos fatos novos. Em staging, no PR 6.4.3, o mesmo workload mediu 3,4–4,1 mil tokens e US$ 0,0003–0,0005 por pedido. A **estimativa** desta entrega é +3% de tokens por pedido composto. Não medido com o provedor real: depende de deploy em staging, ainda não autorizado.

## 7. Limitações reais

1. **Bloqueio do Core na criação do Fechamento administrativo.** Verificado no código, não em staging. `criarFechamentoAdministrativo` chama `buscarPacoteAtivoPorCodigo`, que hoje sempre recusa com `CATALOGO_PUBLICO_INDETERMINADO`, desde a integridade de tenant do fechamento. Por isso, o envio do formulário oficial falha **para qualquer origem**, com ou sem a preparação.
   - A preparação, a revisão preenchida e o vínculo foram implementados e testados com a criação simulada.
   - A criação real depende de uma correção no Core, fora deste escopo: buscar o pacote vigente da empresa comprovada pelo código, como já faz `adicionaisDoPacoteNoTenant`. A correção pede decisão própria.
2. **Migration 059 não aplicada.** Sem ela, salvar o padrão responde que a fonte não está instalada e o cálculo sempre pergunta.
3. **Categorias:** só doces e refrigerantes, uma por pergunta. Distribuição só por percentuais ou por quantidades escritas (sem "metade/metade"). Margem e distribuição salvas como padrão ficam para depois; a 059 já tem as colunas.
4. **Escolhas do buffet em texto livre** são mostradas como estão. Não viram quantidades estruturadas.
5. **Contratação pela conversa:** cliente por nome (busca do CRM). Turnos limitados a almoço/noite. O horário exato é escolhido na revisão. Valor proposto e forma de pagamento ficam sempre com o operador. Cadastro incompleto encerra a preparação com a lista do que falta.
6. **Interface:** a UI atual não lê `rascunhoPausado`, por isso a frase vai no resumo. A navegação para a revisão fecha o drawer, como toda navegação. A caixa de pendências do wizard é simples, aguardando a frente de UX.
7. **Continuação** vale só para a mensagem seguinte. Respostas como "4" fora dela continuam ambíguas e não viram parâmetro.
8. **Dados de staging** não distinguem os cenários (uma festa, sem escolhas, sem versão em preparação). As fixtures cobrem os casos.

## 8. Homologação (quando autorizada)

Pré-requisitos (cada um com autorização própria, conforme `docs/OPERACAO_AGENTES.md`):
- revisar e mergear a PR em staging;
- aplicar a 059 em staging, com o postcheck;
- `AI_OPERACIONAL_ENABLED=true` em staging;
- deploy pela `STAGING_DEPLOY_NONCE`.

Roteiro no drawer de staging:
1. `crie uma festa do Felipe, pacote premium 50 convidados, beatriz 1 ano; tema unicórnio`. Esperado: pergunta a data, depois o turno, depois abre a revisão preenchida. Nenhum pacote é criado. Usar um cliente real de staging no lugar de "Felipe".
2. Com um rascunho de pacote aberto: `Quero criar uma festa e não um pacote`. Esperado: rascunho de contratação e aviso de descarte.
3. Com um rascunho aberto: `quantos docinhos devo fazer para a próxima festa?`. Esperado: pergunta o parâmetro e diz que o rascunho continua aberto. Responder `4`: total = convidados × 4.
4. `Quantos refrigerantes a próxima festa vai precisar?`, depois `400 ml`, depois `garrafa de 2 litros`. Esperado: mL, L e número de garrafas.
5. `salvar 4 docinhos por convidado como padrão` e confirmar. Esperado: versão 1. Repetir a pergunta 3: cita "Regra da empresa (versão 1)".
6. Conferir no Render os traces `inteligencia.conversa` (`operacional`, `plano`, sem PII) e `inteligencia.operacao`.

Rollback:
- **Flag:** `AI_OPERACIONAL_ENABLED` desligada volta ao comportamento anterior e não apaga nada (preparações e parâmetros ficam).
- **Código:** reverter o merge.
- **Banco:** só se necessário e com autorização. Rodar `database/checks/20261001_059_rollback_precheck.sql`, depois `database/rollback/…059…_down.sql` (que exige confirmação explícita se houver dados), depois o postcheck.
