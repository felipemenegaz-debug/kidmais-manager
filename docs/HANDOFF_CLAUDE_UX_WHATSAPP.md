# Atendimento IA WhatsApp V1 — estado consolidado e passagem

Atualizado em 04/10/2026 (preparação local enquanto o Gupshup responde; ver "Preparação de 04/10/2026"). Documento único de estado da V1. Substitui os registros por rodada anteriores, que ficam no histórico do Git. Planos de origem: [ATENDIMENTO_IA_WHATSAPP_PLANO.md](ATENDIMENTO_IA_WHATSAPP_PLANO.md) e [PROXIMA_ENTREGA_UX_WHATSAPP.md](PROXIMA_ENTREGA_UX_WHATSAPP.md) (escopo histórico). Ativação: [WHATSAPP_ATIVACAO_STAGING.md](WHATSAPP_ATIVACAO_STAGING.md). Banco descartável: [VALIDACAO_060_E_HOMOLOGACAO_GUPSHUP.md](VALIDACAO_060_E_HOMOLOGACAO_GUPSHUP.md). Autorizações: [OPERACAO_AGENTES.md](OPERACAO_AGENTES.md).

## Estado em quatro níveis

| Nível | Estado |
| --- | --- |
| Implementado e validado localmente | **Sim.** PR #80 (`whatsapp/atendimento-ia-v1` → `staging`). O remoto está em `b7db96a` (código validado em `a55aed8`). A preparação de 04/10/2026 está só no checkout local, sem push: integração local de `origin/staging` (`e099edd`) e melhorias de tela, com o código validado em `918b0a1` |
| Integrado em staging | **Não.** PR aberta, sem merge. Migration 060 não aplicada no banco de staging. Nenhuma variável configurada |
| Homologado com Gupshup real | **Não.** Bloqueado até comprovar três condições: autenticação do webhook pelo mecanismo do Gupshup (chamado #277630, acesso ao app `KidmaisManager`), receptor exclusivo do número entre ambientes (E0) e preservação do OTP |
| Ativo em produção | **Estado não verificado; não ativado por esta entrega.** Produção não foi lida nem alterada. Não presumir seu estado; exige etapa e autorização próprias |

**Operações remotas desta entrega:**
- **Feitas, só no GitHub:** push da branch `whatsapp/atendimento-ia-v1` e criação/edição da PR #80 (título, descrição), sem merge.
- **Leituras:** metadados dos serviços Render (branch e auto-deploy) e estado da PR e do CI.
- **Nenhuma operação de infraestrutura:**
  - sem deploy nem restart;
  - nenhuma variável ou segredo alterado;
  - nenhuma migration ou SQL em banco de staging ou produção;
  - nada no Gupshup (assinaturas, callback) e nenhuma mensagem real.
- **Local, autorizado pelo Felipe:** o PostgreSQL descartável (127.0.0.1:55498), criado e removido em cada rodada.

## Preparação de 04/10/2026 (local, sem push)

Pedido do Felipe: preparar o módulo sem depender do Gupshup. Não autorizou merge, deploy, migration, mudança remota nem mensagem real.

- **Base atualizada:** `origin/staging` avançou para `35a2bd9` (contratos históricos 061 e agenda por empresa 062), e a PR #80 ficou em conflito (`dirty`).
  - Integração **local**: `e099edd`, merge de `origin/staging` na branch.
  - Conflitos só nos inventários: 060 ao lado de 061/062 em `check-migrations`, `production.test`, seleção das suítes PostgreSQL e `PERMITIDOS_ROTAS`.
  - Não há colisão de número: staging não tem 060.
  - Os modelos PostgreSQL `061`/`062` passam a incluir a 060, com tabelas independentes.
  - A suíte da 060 continua no estado `atual`.
- **Tela (lacunas comprovadas na revisão de fila humana, pendentes, incertos e motivos):** as contagens dizem que valem para as conversas carregadas (até as 100 atualizadas mais recentemente).
  - **Fila humana:** contagem "N conversas aguardando atendente" na lista e contagem em cada coluna do quadro.
  - **Saídas que não chegaram:** a explicação aparece abaixo da mensagem, para os estados Na fila, Não enviada e Entrega não confirmada.
    - Na fila: prazo de 15 min.
    - Cancelada: os motivos possíveis.
    - Falha: não entregue.
    - Incerta: pode ter chegado; conferir antes de repetir; sem reenvio automático.
  - **"Retomar IA" desabilitado** mostra o motivo: envio, chave da IA ou configuração da empresa desligados.
- **Documentos novos:**
  - [WHATSAPP_RESPOSTAS_INICIAIS.md](WHATSAPP_RESPOSTAS_INICIAIS.md): textos para aprovação. Nenhum texto foi trocado no código.
  - [WHATSAPP_CUSTOS_ESTIMATIVA.md](WHATSAPP_CUSTOS_ESTIMATIVA.md): a Meta voltou a cobrar respostas de serviço em 01/10/2026, com 1.000 grátis por número por mês.
  - [WHATSAPP_ROTEIRO_HOMOLOGACAO.md](WHATSAPP_ROTEIRO_HOMOLOGACAO.md): evidência local × verificação real.
- **PostgreSQL:** a integração não mudou nenhum código do WhatsApp nem a 060, só inventários e seleção. A validação integrada (Parte 4) foi executada com autorização em 04/10: 36/36 no HEAD `af14865`.

## Checkout e branches

- **Checkout:** `C:/Users/Glass/.codex/worktrees/0997/kidmais-manager-ai-master`.
- **Branch da PR:** `whatsapp/atendimento-ia-v1`, a partir de `origin/staging` 881690f.
- **Branches locais, sem push:**
  - `ux/importacao-revisao-cancelamento` (c1a252d): correções de UX da importação, para entrega própria;
  - `backup/ux-whatsapp-candidata-20261002` (4d7402f): a candidata original inteira.
- **Correção financeira:** não faz parte desta PR. Já está em staging (#77) e em production (#79), com código idêntico ao da candidata.
- **Node:** os gates rodam com Node 22.23.2, chamando `node.exe` diretamente. `npm` com esse Node falha em silêncio.

## O que a V1 faz e não faz

**Faz:**
- recebe mensagens do número comercial pelo webhook Gupshup;
- responde com respostas publicadas pela empresa (FAQ) ou textos fixos;
- qualifica interesse (data completa e convidados) e encaminha à equipe;
- oferece tela de Atendimento com lista, quadro, histórico, responsável, assumir, retomar IA, encerrar e resposta humana;
- tem configuração de respostas, limite e estado da automação, desligada por padrão.

**Não faz:**
- não informa preço, desconto, disponibilidade ou cláusula fora das respostas publicadas;
- não reserva data, não cria festa, contrato ou pagamento;
- não lê dados privados de clientes;
- não inicia conversa nem usa templates;
- não analisa mídia (vai para a equipe);
- não consulta disponibilidade automaticamente: o serviço exige revisão de isolamento por empresa e unidade antes de ser exposto ao canal público.

## Critérios de conclusão técnica

Evidências locais em `.local-ux/` (fora do Git), vinculadas ao commit.

| # | Critério | Implementação | Evidência (commit) | Estado | Pendência |
| --- | --- | --- | --- | --- | --- |
| 1 | Webhook autenticado, persistência antes do ACK, deduplicação | Cabeçalho `X-Kidmais-Webhook-Secret` (comparação em tempo constante). Persiste antes do 204. Só falha recuperável devolve 503. `externa_id` único por empresa/ambiente e trava por contato | `webhook.test.ts`, `service.test.ts`. PostgreSQL passo 3: o mesmo evento 3× em paralelo grava 1 (`a55aed8`) | Validado localmente | **O mecanismo real não está comprovado.** O Gupshup só documenta cabeçalho próprio na assinatura criada pela Partner API, e o acesso aguarda o chamado #277630. Responsável: Felipe/Gupshup |
| 2 | Isolamento, permitidos em staging, receptor único | Chaves compostas empresa/ambiente; tenant comprovado na tela. `WHATSAPP_ATENDIMENTO_CONTATOS_PERMITIDOS` obrigatória em staging. `WHATSAPP_ATENDIMENTO_RECEPTOR` igual a `KIDMAIS_DEPLOY_ENV` para gravar ou enviar | PostgreSQL passo 2 (referência cruzada recusada; outra empresa recusada); `core.test.ts`, `service.test.ts`, `worker.test.ts` (`a55aed8`) | Validado localmente | **A flag é local e não comprova exclusividade entre ambientes.** Exige leitura das assinaturas do app e dos nomes de variáveis de produção (etapa E0, com autorização). Responsável: Felipe |
| 3 | IA existente, fontes aprovadas, orçamento e limites, sem operações protegidas | Roteador existente, capacidade `whatsapp_atendimento` com teto obrigatório e uma tentativa de 15 s. Classificação em schema fechado; texto só de respostas publicadas ou fixas. Limite por conversa em 24 h. CPF, e-mail e telefone omitidos. Nenhuma chamada a reserva, pagamento ou contrato | `arquitetura.test.ts` (imports fechados), `core.test.ts`, `worker.test.ts`; PostgreSQL 8d (limite) (`a55aed8`) | Validado localmente | Teto de orçamento de staging a definir na ativação (E4) |
| 4 | Tomada humana, PARAR, suspensão e janela de 24 h | Revalidação sob trava da conversa antes da geração, ao gravar e antes de enviar. Saída na fila há mais de 15 min não sai. Envio humano exige chave da IA e configuração ligadas | PostgreSQL 5 (assumir durante a geração), 6a (PARAR), 6b (janela); `worker.test.ts`, `service.test.ts` (`a55aed8`) | Validado localmente | — |
| 5 | Falha de modelo/orçamento e timeout | Falha ou limite: conversa vai para a equipe com texto fixo. Timeout ou 5xx: INCERTO, sem reenvio. 4xx documentado: FALHOU | PostgreSQL 8b; `worker.test.ts`, `transporte.test.ts` (`a55aed8`) | Validado localmente | Timeout real do Gupshup não será forçado na homologação |
| 6 | Status fora de ordem, concorrência e recuperação | Status gravado antes da correlação; ENTREGUE não regride; retenção de 24 h. `SKIP LOCKED` e uma tarefa ativa por conversa. Interrompido há mais de 10 min vira FALHOU/INCERTO e vai para a equipe. Entrada atrasada não duplica resposta | PostgreSQL 4 (dois workers), 7 (status antes do retorno), 8 (interrupção), 8c (ordem), 8e (entrada atrasada) (`a55aed8`) | Validado localmente | Medir vazão real (H8) |
| 7 | Resposta publicada revogada | Ao gravar, a saída usa a configuração vigente (`FOR SHARE`). Saída pendente criada antes da última alteração é cancelada. Com a IA conduzindo, a conversa vai para AGUARDANDO_HUMANO; estados humanos, responsável e versão são preservados | PostgreSQL 8f: corrigida durante a geração, removida com saída pendente, estado após o cancelamento; `worker.test.ts` (`a55aed8`) | Validado localmente | — |
| 8 | Limite explícito da revogação | A trava termina no COMMIT que marca ENVIANDO; o POST vem depois. Alteração posterior não retém o envio: sai o texto lido ou INCERTO. Não há promessa de cancelamento nem recolhimento | Comentário em `worker.ts`; teste "envio iniciado não retido" (`a55aed8`) | Validado localmente | — |
| 9 | Migration 060, postchecks e recuperação | Pré-condição inline, postcheck, down fail-closed, rollback precheck/postcheck, inventário | `check:v1:postgres` 30/30 em `a55aed8` (`.local-ux/pg-060/check-v1-postgres-r7-escalonamento.log`). Ensaio de exportação/restauração, também com usuário restrito sem superusuário, em 02/10, com a 060 idêntica (não mudou desde `a7ac6bd`). `production:test` 37/37 em `a55aed8` | Validado no descartável | Aplicação em staging exige backup e autorização (E2) |
| 10 | UX desktop, celular e teclado; motivos e estados reais | Situação do canal em partes; responsável; autor e estado por direção; motivo de bloqueio da resposta e do "Retomar IA"; fila humana contada; explicação das saídas na fila, não enviadas e incertas; "Voltar às conversas" no celular; só 4 dígitos do contato | QA Playwright com APIs simuladas em 390×844 e 1280×900 (`.local-ux/qa-whatsapp-ui-v2.cjs`, `.local-ux/whatsapp-qa-v2/`), rodado em `918b0a1` (`.local-ux/whatsapp-qa-v2/execucao-918b0a1.log`) | Validado localmente | Conferência visual do Felipe em staging após o deploy |

**Gates do código validado (`a55aed8`, remoto):**
- `check:v1:static`: 1.724 testes unitários e 103 do harness com mocks, lint, TypeScript e build (`.local-ux/whatsapp-static-node22-v5.log`);
- `check:v1:postgres`: 30/30 no descartável;
- `production:test`: 37/37;
- CI do GitHub: verde.

**Integração seguinte (04/10/2026, local):** `origin/staging` avançou para `87b9611` (PR #92: tela de contrato integrado e 7 linhas em `lib/financeiro/servico.ts`), sem migration nem sobreposição com a candidata. Merge local `6cf5813`: `check:v1:static` 1.879 + 103, lint, TypeScript e build (`.local-ux/whatsapp-static-6cf5813.log`), `production:test` 37/37 (`.local-ux/production-test-6cf5813.log`). O PostgreSQL integrado (36/36 em `af14865`) vale para o código do WhatsApp e para as migrations, que a integração não mudou. As 7 linhas do financeiro vêm da PR #92 de staging, com sua própria validação. **Plano de deploy em staging com o canal desligado:** [WHATSAPP_ATIVACAO_STAGING.md](WHATSAPP_ATIVACAO_STAGING.md), "Deploy da candidata com o canal desligado".

**Gates do código validado da preparação: `918b0a1` (local, base `35a2bd9` integrada, árvore limpa):**
- `check:v1:static`: 1.879 testes unitários e 103 do harness, lint, TypeScript, build e leitura de PDF no asset (`.local-ux/whatsapp-static-918b0a1.log`);
- `production:test`: 37/37 com 060, 061 e 062 (`.local-ux/production-test-918b0a1.log`);
- QA da tela em celular 390×844 e desktop 1280×900: todos os cenários (`.local-ux/whatsapp-qa-v2/execucao-918b0a1.log`; capturas em `.local-ux/whatsapp-qa-v2/`);
- `check:v1:postgres` na base nova, **executado em 04/10/2026** com autorização (Parte 4, O1/O2/O4), no HEAD `af14865` (código = `918b0a1`): 36/36 execuções. Inclui a 060 (`atual`) e as suítes nos estados 061/062, cujos modelos contêm a 060. Cluster removido no fim (`.local-ux/pg-060/check-v1-postgres-r8-integrada-af14865.log`);
- CI não se aplica: não houve push.

Execuções intermediárias, substituídas pela de `918b0a1`: `e099edd` (merge) e `149d2a4` (primeira versão da tela).

O HEAD local final é um commit só de documentação depois de `918b0a1` (registro destas evidências). Fora de `docs/`, ele é idêntico a `918b0a1`.

## Configuração (só nomes; nunca imprimir valores)

| Variável | Valor e uso |
| --- | --- |
| `KIDMAIS_DEPLOY_ENV` | `staging` ou `production` |
| `WHATSAPP_ATENDIMENTO_RECEPTOR` | Igual a `KIDMAIS_DEPLOY_ENV` só no ambiente que recebe e responde o número. Ausente: nada é gravado nem enviado |
| `WHATSAPP_ATENDIMENTO_EMPRESA_ID` | UUID da empresa piloto. Inválido: recepção desligada |
| `WHATSAPP_ATENDIMENTO_RECEIVE_ENABLED` | Persistência do webhook |
| `WHATSAPP_ATENDIMENTO_ENABLED` | Fila e envios |
| `WHATSAPP_ATENDIMENTO_CONTATOS_PERMITIDOS` | Números com DDI, só dígitos, separados por vírgula. Obrigatória em staging |
| `WHATSAPP_ATENDIMENTO_WORKER_SECRET` | Exclusivo por ambiente, de 32 a 256 caracteres |
| `WHATSAPP_ATENDIMENTO_WORKER_URL` | URL HTTPS completa de `/api/integracoes/gupshup/atendimento/processar` |
| `INTELIGENCIA_ENABLED` | Chave-mestra da IA. Sem ela o processador não roda, nem envio humano pela fila |
| `AI_BUDGET_JSON` | Precisa de teto aplicável à capacidade `whatsapp_atendimento` |
| `GUPSHUP_*` | Existentes do OTP: `GUPSHUP_API_KEY`, `GUPSHUP_SOURCE`, `GUPSHUP_APP_NAME=KidmaisManager`, `GUPSHUP_WEBHOOK_SECRET` |

O OTP usa o endpoint de template e não passa pelo transporte do atendimento. O webhook continua registrando os metadados de status do OTP.

## Riscos conhecidos

- **Autenticação real do webhook não comprovada** (critério 1). Sem acesso à Partner API, a alternativa exige outra mudança de código e revisão de segurança. Não enfraquecer o webhook para contornar.
- **Exclusividade entre ambientes** depende de configuração nos dois ambientes e das assinaturas do Gupshup. O código só garante o lado de cada ambiente.
- **Salvar a configuração** cancela respostas automáticas ainda pendentes. É conservador: com a IA conduzindo, a conversa vai para a equipe.
- **Envio já marcado ENVIANDO** sai mesmo que a configuração mude durante o POST (até 10 s).
- **Merge não é garantia de "sem deploy":** auto-deploy e branch dos serviços Render podem mudar. Revalidar por leitura imediatamente antes de qualquer merge.
- **Vazão** estimada em cerca de 20 respostas por minuto com um worker; precisa ser medida (H8).

## Recuperação

- **Desligar sem apagar nada:**
  - `WHATSAPP_ATENDIMENTO_ENABLED` interrompe envios novos;
  - `RECEIVE_ENABLED` volta o webhook a só registrar metadados;
  - remover `RECEPTOR` desliga as duas coisas de uma vez.
- Histórico e resultados incertos ficam. Não reenviar em massa.
- **Código:** revert do merge.
- **Dados:** down da 060 só depois de exportar as tabelas, como no ensaio.

## Pendências e próximos passos

| Prioridade | Pendência | Responsável |
| --- | --- | --- |
| P0 | Resposta do Gupshup ao chamado #277630: mecanismo de autenticação e acesso Partner ao app `KidmaisManager` | Felipe / Gupshup |
| P0 | Antes da homologação real, comprovar as três condições: autenticação Gupshup, receptor exclusivo (E0) e OTP preservado. O webhook continua 204 para os status de OTP, e o OTP de login segue funcionando em staging depois do deploy (E3) | Felipe autoriza; Claude verifica |
| P1 | Revisão independente da preparação local de 04/10/2026 (merge com staging, tela e documentos) | Codex |
| P1 | Push da preparação local para a PR #80, para remover o conflito com `staging` e rodar o CI. É mudança remota (GitHub) e precisa de autorização | Felipe autoriza |
| — | ~~`check:v1:postgres` com a base nova~~: **concluído em 04/10/2026**, 36/36 (Parte 4 de [VALIDACAO_060_E_HOMOLOGACAO_GUPSHUP.md](VALIDACAO_060_E_HOMOLOGACAO_GUPSHUP.md)) | — |
| P1 | Aprovação dos textos iniciais ([WHATSAPP_RESPOSTAS_INICIAIS.md](WHATSAPP_RESPOSTAS_INICIAIS.md)). O texto 2 corrige uma lacuna real: dúvida sem resposta publicada é encaminhada sem avisar o cliente. Nenhum texto promete atendimento "agora", e o PARAR não oferece "atendente": o bloqueio não é desfeito por mensagem do contato (teste em `service.test.ts`) | Felipe |
| P2 | Confirmar a tarifa de serviço do Brasil na tabela da Meta e a taxa do Gupshup no painel ou contrato ([WHATSAPP_CUSTOS_ESTIMATIVA.md](WHATSAPP_CUSTOS_ESTIMATIVA.md)) | Felipe |
| P1 | Merge em `staging`, com autorização e revalidação de HEAD/base, CI e Render (branch e auto-deploy) | Felipe autoriza; Claude executa |
| P1 | Etapas E0–E8 de staging ([WHATSAPP_ATIVACAO_STAGING.md](WHATSAPP_ATIVACAO_STAGING.md)), cada uma com autorização própria, depois do P0 | Felipe autoriza; Claude executa |
| P2 | Produção: etapa e autorização próprias, depois da homologação em staging | Felipe |
| P3 | Fora da V1: disponibilidade automática, atalho "Nova festa", etapas comerciais do quadro e paginação acima de 100 | Produto |

## Histórico de commits da PR

| Commit | Conteúdo |
| --- | --- |
| `a7ac6bd` | Candidata: webhook durável, fila, worker, tela e migration 060 |
| `9ef4cb8` | Envio 2xx do Gupshup, receptor único, encaminhamento sem modelo, limites, tela completa e worker externo |
| `a588185` | Correções da revisão independente: sem 503 eterno, saída vencida, entrada atrasada, contato mascarado, dados mínimos ao modelo |
| `2395935` | Resposta publicada revogada durante a geração e enquanto pendente; botão exige configuração ativa |
| `a55aed8` | Estado da conversa após cancelamento; alcance da trava documentado |
| seguintes | Consolidação desta documentação e da descrição da PR; comentário do cabeçalho da suíte PostgreSQL (sem mudança de comportamento) |
