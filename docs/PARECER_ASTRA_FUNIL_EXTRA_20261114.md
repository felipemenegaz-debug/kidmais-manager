# Parecer — conferência extra restrita do Funil — 14/11/2026

**APROVADO no escopo técnico solicitado: P2-R2-1 encerrado; zero P1/P2 reproduzíveis e nenhum novo P3 identificado.** Exceção de rodada expressamente autorizada por Felipe após a R2. Não reabre os demais achados, migrations ou rota de resumo. Não autoriza commit, PR, integração ou publicação.

Autoria: Codex, atendendo à conferência solicitada ao Astra, neste mesmo chat que implementou a correção. Há nova execução de provas dirigidas, mas **não independência de autoria/contexto**. Não apresentar este documento como revisão por outro agente independente.

Checkout kidmais-manager-funil-oportunidades-20261114, base 2133d398f02f519170b443b5702c6b23b9da41b7. Pedido extra, parecer R2, atualização do relatório/vault, manifesto anterior/vigente, diff dos pontos tocados e arquivos novos considerados. Conferidos56/56 hashes do manifesto e77/77 das evidências; implementação preservada.

## Resultado por requisito

- **Uma única herança:** lib/marketing/conversao.ts:7 extrai o bloco que existia em contatos.ts. contatos.ts:315 delega ao helper; oportunidades/conversao.ts:25 usa exatamente o mesmo helper. Origem, campanha, canal, detalhe, UTM e contato de origem seguem para registrarSeAusente (conversao.ts:31–36). Não há segunda implementação da atribuição.
- **Atomicidade:** helper recebe o mesmo tx da ação/vínculo; não abre conexão ou COMMIT. A criação comercial chama o gancho em fechamento.service.ts:200 dentro de withTransaction (:243). A rota manual chega por rotaMarketing/withTenantTransaction (lib/marketing/http.ts:28). Falha da herança propaga ao chamador. Prova própria confirma executor compartilhado e propagação; não executou rollback PostgreSQL real.
- **Idempotência:** marketing/conversao.ts:19 retorna sucesso no mesmo par depois de validar empresa/cliente/negociação. Repetição não grava vínculo, histórico ou atribuição. Outro fechamento continua409 (:12); contato ausente/empresa incorreta e fechamento incompatível continuam404 (:9–18). O caminho manual não tem mais a antiga recusa incondicional antes da herança.
- **Append-only e origem própria:** registrarSeAusente em atribuicao.ts:111 usa INSERT ON CONFLICT DO NOTHING; nenhuma reescrita de marketing_atribuicoes foi introduzida. Uma atribuição própria existente prevalece. A correção não tenta reparar dados históricos produzidos por versões anteriores; não houve publicação daquela versão nesta tarefa.
- **Ação e responsável:** gancho mantém B quando negociação sem responsável e A quando já atribuída a A; a herança ocorre antes de devolver ao chamador. Ambos os casos executados na prova própria.
- **Relatório:** metricas.ts:93/112–116 lê SQL_ORIGEM_NEGOCIACAO, que prioriza a atribuição própria de FECHAMENTO (atribuicao.ts:86). Testes PG novos verificam painelMarketing real para cliente novo e recorrente, com campanha correta. Modelo086 conserva o vínculo/herança manual; gancho sai quando oportunidades_acoes não existe (:7). Log Marketing A no modelo antigo termina9/9 PASS.

## Reprodução e provas

Execução própria:

`env -u DATABASE_URL -u KIDMAIS_HOMOLOGACAO_DATABASE_URL node docs/evidencias/astra-funil-extra/provas.mjs`

Sete grupos PASS: herança/repetição com B herdado; herança/repetição com A; origem própria preservada; outro vínculo409 sem escrita; contato ausente404 sem escrita; negociação incompatível404 sem escrita; falha de herança propagada. Resultado em docs/evidencias/astra-funil-extra/resultado.json. Executa as funções reais com tipos/imports removidos pelo Node, dependências de atribuição/histórico e executor SQL falsos. Asserções verificam argumentos de tenant/cliente e identidade do executor. Não executa SQL/gatilhos nem comprova concorrência/rollback real. Leitura adicional confirma o escritor INSERT-only e a delegação manual.

Provas do implementador examinadas, **não reexecutadas nesta conferência**: antes.log tem os dois cenários PG falhando por ausência de origem; pg-final.log tem novas regressões2/2, funil4/4, origem12/12 e correções Marketing17/17. Marketing A falhou pela expectativa antiga409; marketing-final.log repete9/9 PASS. Total final44 testes/subtestes PG em cinco arquivos, não uma execução combinada verde. Unitários selecionados26/26 e static completo5017+103, lint0 erros/4 avisos existentes, TS/build/PDF PASS. Teste novo usa fixture de fechamento e gancho real, não formulário completo; fotografia das atribuições comprova preservação e repetição sem duplicação. O caso novo é cliente recém-criado já vinculado ao contato.

Node24.20.0; Node22 declarado não executado. Sem nova execução PG, navegador, carga ou corrida concorrente. Primeiras tentativas de iniciar Bash/env no sandbox não executaram a prova; execução local autorizada fora desse bloqueio terminou0. Isso não foi falha da aplicação. git diff --check PASS.

## Encerramento

Sem achado acionável com reprodução neste escopo; não há bloqueante a escalar nem nova rodada iniciada. Reconciliação futura do módulo homônimo da frente de Marketing permanece requisito de integração já documentado, não novo achado. Área da família permanece antes do Funil.

Nenhuma correção de código, commit, push, PR ou ambiente real. Não foram reinstaladas dependências nem criados cluster, servidor ou build; apenas parecer e provas preserváveis. Nenhum descartável próprio a limpar. Manifesto/evidências do implementador permanecem intactos; esta revisão tem pacote separado. Vault, fila e relato atualizados com o resultado e o limite de autoria.
