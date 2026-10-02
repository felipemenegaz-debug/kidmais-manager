# Passagem para Claude — UX e atendimento WhatsApp

Atualizado em 01/10/2026. Modelo recomendado para continuar: Claude Opus 5.5 no Claude Code, com acesso a este checkout. Este documento registra a candidata local; não atesta uma publicação ou uma integração real homologada.

## Rodada de 02/10/2026 (Claude): separação e conclusão da primeira versão

**Separação da candidata:**
- O WhatsApp está na branch `whatsapp/atendimento-ia-v1`, criada de `origin/staging` (881690f), que vira a PR para staging.
- As correções de importação ficaram na branch local `ux/importacao-revisao-cancelamento` (c1a252d), sem push, para uma entrega própria.
- A candidata inteira, como estava, ficou em `backup/ux-whatsapp-candidata-20261002`.
- A correção do financeiro **não** entra nesta PR: já está em `staging` (PR #77) e em `production` (PR #79), com código idêntico ao local.

**Mudanças desta rodada** (detalhes e plano de ativação em [WHATSAPP_ATIVACAO_STAGING.md](WHATSAPP_ATIVACAO_STAGING.md)):
- **Envio:** o transporte só aceitava HTTP 202, mas a API de sessão do Gupshup documenta 2xx (exemplo 200). Todo envio real terminaria "Entrega não confirmada".
  - 2xx com `submitted` passa a ser sucesso.
  - Recusa documentada (4xx) termina FALHOU.
  - O resto continua INCERTO, sem reenvio.
- **Receptor único:** `WHATSAPP_ATENDIMENTO_RECEPTOR` precisa ser igual a `KIDMAIS_DEPLOY_ENV` para gravar ou enviar. Ausente, nada é gravado nem enviado. O app Gupshup pode ter até cinco assinaturas, e todas recebem cópia.
- **Falha do modelo, orçamento ou limite:** a conversa vai para a equipe e o contato recebe só um texto fixo de encaminhamento. Antes, ficava sem resposta.
- **Limite configurável:** respostas automáticas por conversa em 24 h (padrão 20, de 1 a 100), definidas na tela. O teto de custo continua no `AI_BUDGET_JSON` da capacidade `whatsapp_atendimento`.
- **Ordem:** a resposta considera a entrada mais recente pelo horário do evento, mesmo que ela tenha chegado antes de outra mais antiga.
- **Horário do evento:** à frente do relógio, vale como agora. Antes devolvia 503, e o Gupshup repetiria o evento sem fim.
- **Tela:**
  - situação do canal em partes (receptor, receber, enviar, orçamento, empresa);
  - responsável na lista, no quadro e na conversa;
  - autor de cada mensagem (cliente, assistente virtual ou atendente);
  - motivo quando a resposta está bloqueada (janela, opt-out, não assumida);
  - "Voltar às conversas" no celular;
  - limite de respostas na configuração, com validação do navegador;
  - acesso negado agora devolve 403.
- **Worker:** recusa iniciar com URL ou segredo inválidos. Faz espera crescente até 60 s, registra só mudanças de estado e um resumo a cada 10 min, e para por sinal sem perder trabalho.

**Validação desta rodada** (Node 22.23.2, sem banco, rede ou provedor reais):
- `check:v1:static`: 1.713 testes unitários e 103 do harness, lint (só o warning preexistente), TypeScript e build. Log: `.local-ux/whatsapp-static-node22-v2.log`.
- QA no navegador com APIs simuladas (`.local-ux/qa-whatsapp-ui-v2.cjs`, capturas em `.local-ux/whatsapp-qa-v2/`), em celular 390×844 e desktop 1280×900. Coberto: teclado e foco, rolagem, conflito 409, janela expirada, opt-out, passagem entre atendentes, redução de movimento, configuração e quadro.
- PostgreSQL descartável (autorizado pelo Felipe, mesmo destino 127.0.0.1:55498, identidade conferida): `check:v1:postgres` 30/30, com a suíte da 060 executando os passos 8b–8d. Log: `.local-ux/pg-060/check-v1-postgres-r5-whatsapp.log`. A migration 060 **não mudou**.

**Revisão independente da PR #80 e correções (02/10/2026).** A revisão confirmou isolamento, autenticação da rota administrativa, revalidação sob trava e INCERTO sem reenvio. Achados corrigidos:
1. Condição permanente não devolve mais 503 no webhook:
   - empresa suspensa: confirma sem gravar;
   - sem configuração: grava para a equipe, sem automação;
   - empresa piloto ausente ou inválida: recepção desligada (só metadados).
2. Saída parada na fila há mais de 15 min não é enviada. Envio humano e "Retomar IA" são recusados (409) com a chave da IA desligada.
3. Entrada antiga que chega depois de uma mais recente já tratada vira histórico, sem nova resposta.
4. A retenção de status também roda na recepção.
5. Erros de regra de negócio devolvem 409 ou 404, não 503.
6. O processador registra só um código fixo de erro.
7. A tela recebe só os 4 últimos dígitos do contato.
8. O histórico da conversa anterior não aparece ao trocar de conversa.
9. O modelo recebe só a sessão atual, com telefone e e-mail omitidos (além do CPF).
10. O webhook não trava a linha da empresa.
11. Um worker que perde a corrida numa conversa segue com o lote.

A suíte PostgreSQL ganhou o passo 8e (entrada atrasada e contato mascarado).

**Resposta publicada revogada (P1 apontado pelo Felipe depois de a588185).** O worker montava a resposta com a configuração lida na reserva e, antes de enviar, só conferia `ativo`. Uma resposta publicada removida ou corrigida ainda podia sair dentro dos 15 min. Agora:
- **Durante a geração:** ao gravar a saída, o worker relê a configuração com `FOR SHARE` e monta o texto a partir da versão vigente. Resposta removida vira a mensagem padrão de encaminhamento; resposta corrigida sai com o texto novo.
- **Saída pendente:** antes de enviar, a resposta automática criada antes da última alteração da configuração (`atualizada_em` maior que `criada_em`, comparado no banco) é cancelada.
  - **Alcance da trava:** o `FOR SHARE` dura só até o COMMIT da transação que marca ENVIANDO. O POST ao Gupshup vem depois, fora de qualquer trava.
    - Salvamento que chega **antes** desse COMMIT: espera, grava `atualizada_em` depois e a saída é cancelada.
    - Salvamento **depois** do COMMIT (envio já iniciado): não retém o envio. O texto lido sai, ou termina INCERTO. Não há reconferência nem recolhimento.
    - Essa janela dura no máximo o tempo do POST (até 10 s).
  - **Estado da conversa depois do cancelamento:**
    - IA conduzindo e saída que ainda seria enviada: a conversa vai para "Aguardando atendente", sem responsável e com nova versão.
    - Já com a equipe (AGUARDANDO_HUMANO, HUMANO, ENCERRADA): estado, responsável e versão não mudam.
    - Saída inválida por outro motivo (entrada nova pendente): não é escalada, a entrada nova segue para a IA.
  - Mensagens humanas e o texto fixo de encaminhamento não dependem das respostas publicadas e seguem.
  - Efeito colateral aceito: salvar a configuração, mesmo sem mudar respostas, cancela respostas automáticas ainda pendentes. A conversa continua visível para a equipe.
- **Tela:** "Enviar resposta" exige a configuração da empresa ligada, como o servidor, e explica o motivo.
- **Testes:**
  - unitários para resposta corrigida e removida durante a geração, para saída pendente revogada (provedor não chamado) e para mensagens humanas e de encaminhamento que seguem;
  - PostgreSQL, passo 8f: resposta corrigida durante a chamada ao modelo e removida com a saída pendente. Só o texto vigente chega ao provedor.
  - Depois do cancelamento (8f): a conversa conduzida pela IA fica AGUARDANDO_HUMANO, sem responsável e com versão +1. A conversa assumida fica HUMANO, com o mesmo responsável e a mesma versão.
  - Unitários do escalonamento: estados humanos preservados, entrada nova não escalada e envio iniciado não retido. A revogação é conferida uma vez, antes do POST.

**Ativação continua bloqueada:** o acesso à Partner API e a autenticação real do webhook aguardam resposta do Gupshup (chamado #277630). Não ativar o canal antes disso.

## Checkout e instruções

- Diretório: `C:/Users/Glass/.codex/worktrees/0997/kidmais-manager-ai-master`.
- Branch: `codex/ux-whatsapp-atendimento`.
- Base: `4a0c966ae143281165f82ec8d8e00f7d443ddf9b`, obtida de `origin/staging` nesta sessão.
- Alterações locais ainda sem commit, push, merge ou deploy. Preservar todos os arquivos modificados e novos; consultar `git status` antes de trabalhar.
- Ler `AGENTS.md`, `docs/OPERACAO_AGENTES.md` e os guias da versão instalada de Next.js em `node_modules/next/dist/docs/`. Não usar credenciais reais ou o banco local real para testes.
- O usuário escolheu Gupshup e o número atual da Kidmais. Essa escolha define o canal; não substitui a autorização operacional exigida para migrations, configuração remota e envios de teste.

## Alterações preparadas

**Importação:** botão Importar contrato antigo recebe o estilo primário em degradê. Erros de rede/API não abrem automaticamente dados fictícios. A demonstração exige escolha explícita. Revisão permite corrigir e marcar Não consta no documento. Cancelar abre confirmação em dialog nativo, preserva a revisão se o descarte falhar, e cancela primeiro o Human Gate quando houver uma confirmação preparada. Voltar e corrigir preserva os campos. Cancelamento não promete apagar imediatamente o documento privado, nem cancela contratos existentes.

**WhatsApp:** nova página `/admin/atendimento`, lista de conversas e quadro por estado de atendimento, edição de perguntas/respostas aprovadas pelo representante da empresa, tomada humana, retorno à IA, encerramento e resposta humana em fila. A configuração é do piloto fixo identificado no servidor; ainda não é a administração de conexões de todas as empresas.

**Fluxo:** webhook autenticado persiste antes do ACK, com deduplicação por empresa/ambiente/evento. A composição em `app/api/admin/inteligencia/whatsapp/modelo.ts` injeta classificação do roteador existente no domínio `lib/whatsapp/atendimento`. O Core não importa modelos ou persistência de IA. A classificação tem schema fechado; o texto comercial vem exclusivamente das respostas aprovadas, ou de mensagens fixas de qualificação/encaminhamento. Mantém orçamento, registro de consumo e uma tentativa de modelo, até 15 segundos, sem fallback automático de provedor.

**Envio:** worker serializa por conversa, revalida revisão, estado, janela de 24 horas, empresa ativa e responsável humano. Tomada humana impede resposta automática pendente. Mensagens manuais não são invalidadas por uma nova mensagem do cliente ou outra resposta do mesmo atendente. Pedido PARAR bloqueia novos envios. Opt-out não tem botão de reativação: desenhar consentimento verificável antes de oferecer reabertura. Timeout de envio fica INCERTO sem retry cego; entregas confirmadas podem chegar antes do retorno do envio e ficam numa caixa de status para correlação posterior. Trabalhos interrompidos por mais de dez minutos encaminham a conversa para humano.

## Migration e ativação pendentes

Arquivo preparado, **não executado**: `database/migrations/20261001_060_whatsapp_atendimento.sql`, no padrão da 059 (pré-condição inline, `database/checks/20261001_060_postcheck.sql`, rollback `database/rollback/20261001_060_whatsapp_atendimento_down.sql` com prechecks e pós-checks próprios, inventário em `scripts/production/check-migrations.mjs`). Cria configuração, conversas, mensagens, status (com expiração) e auditoria com chave composta por empresa e ambiente. Plano de validação e de homologação: [VALIDACAO_060_E_HOMOLOGACAO_GUPSHUP.md](VALIDACAO_060_E_HOMOLOGACAO_GUPSHUP.md). Não executá-lo nem em clone sem autorização para o destino, conforme a política do projeto. Validar SQL, concorrência real, rollback e restauração num PostgreSQL descartável autorizado antes da publicação.

Nomes de configuração a conferir por presença/formato, nunca imprimir valores:

- `KIDMAIS_DEPLOY_ENV`: ambiente explícito staging ou production.
- `WHATSAPP_ATENDIMENTO_EMPRESA_ID`: UUID da empresa piloto comprovada.
- `WHATSAPP_ATENDIMENTO_RECEPTOR`: `staging` ou `production`, igual a `KIDMAIS_DEPLOY_ENV` só no ambiente que recebe e responde o número (receptor único). Ausente: nada é gravado nem enviado.
- `WHATSAPP_ATENDIMENTO_RECEIVE_ENABLED`: libera persistência autenticada do webhook.
- `WHATSAPP_ATENDIMENTO_ENABLED`: libera a fila do canal; ausente/desligada não envia.
- `WHATSAPP_ATENDIMENTO_WORKER_SECRET`: segredo exclusivo por ambiente, de 32 a 256 caracteres imprimíveis sem espaços.
- `WHATSAPP_ATENDIMENTO_WORKER_URL`: URL HTTPS completa de `/api/integracoes/gupshup/atendimento/processar`.
- `WHATSAPP_ATENDIMENTO_CONTATOS_PERMITIDOS`: números com DDI, só dígitos, separados por vírgula. Obrigatória em staging (sem ela nada é gravado nem enviado); opcional em produção para ativação gradual.
- Configuração de IA vigente, incluindo chave-mestra e orçamento aplicável à empresa/capacidade `whatsapp_atendimento`, pricing e provedor. A chave-mestra também bloqueia o processador, inclusive envios humanos pela fila.
- Configuração de Gupshup vigente: app `KidmaisManager`, source, API key, webhook secret. Revalidar nomes, número, titularidade e contrato de status com a configuração real sem expor segredos.

O processo separado proposto é `node scripts/whatsapp-atendimento-worker.mjs`. Não existe worker provisionado por esta entrega, nem alteração em infraestrutura/auto-deploy. A tela salva uma configuração de FAQ inicialmente desligada; cadastrar e revisar fontes antes de ligar. Não deve haver automação simultânea de staging e production sobre o mesmo número. Definir um único receptor autorizado antes de ativar persistência/envios.

Homologar primeiro com configuração desligada e dados sintéticos. Depois, com autorização concreta, validar um número destinatário de teste, evento duplicado, mídia, status fora de ordem, tomada humana durante geração, opt-out, suspensão, expiração da janela, falha de modelo, teto de orçamento, interrupção do worker e timeout de transporte. Confirmar o mecanismo de autenticação efetivamente fornecido pelo Gupshup.

Recuperação proposta: desligar a flag do canal para impedir novos envios, manter histórico e resultados incertos, parar o worker e retornar à versão anterior conforme o plano aprovado. Não apagar tabelas ou tentar reenvio em massa como recuperação.

## Limites e continuação do produto

- O atendimento qualifica interesse (data completa e convidados) e encaminha. Não confirma festa, não assina contrato, não registra pagamento e não reserva agenda.
- Consulta automática de disponibilidade ainda não está ligada: o serviço atual de disponibilidade precisa de revisão do isolamento por empresa/unidade antes de ser exposto ao canal público. Não informar uma data como disponível sem consulta autorizada ao serviço correto.
- Preparar contratação aponta para o CRM existente. O atalho Nova festa, com fluxo administrativo mais curto, ainda precisa ser implementado pelos serviços oficiais, sem inserção direta de festa ou reserva em rascunho.
- Upload de modelo contratual por empresa e painel de onboarding de empresas/unidades permanecem nos planos para evolução. Não confundir importação histórica com publicação de um modelo.
- O quadro atual tem estados de atendimento, não todas as etapas comerciais de um CRM. Lista e histórico mostram até 100 itens; paginação e etapas comerciais são evolução posterior.
- Ainda falta QA visual de celular, teclado e dialog no navegador, e teste de persistência/concorrência em PostgreSQL autorizado. Os mocks não substituem essas verificações.

Consultar também `docs/PROXIMA_ENTREGA_UX_WHATSAPP.md`, `docs/ATENDIMENTO_IA_WHATSAPP_PLANO.md` e `docs/ADMINISTRACAO_PLATAFORMA_PLANO.md`. São planos históricos desta preparação; este handoff informa o estado da candidata. Não presumir que relatos antigos de logo, perfil, dashboard ou IA administrativa continuam reproduzíveis na base atual.

## Validação local

Última regressão desta candidata: **1.683 testes unitários e 103 testes do harness passaram**, além de TypeScript, lint sem erros e build. Permanece um warning preexistente de import não usado em `lib/inteligencia/skills/catalogo.ts`. `git diff --check` passou. O teste de confirmação/cancelamento exercita preservação de estado quando o descarte falha. Estes resultados não incluem PostgreSQL ou QA visual no navegador.

`npm.cmd run check:v1:static` reúne testes unitários, harness de staging com mocks, lint, TypeScript e build. Log local: `.local-ux/whatsapp-static-check.log`. Testes específicos do canal: `node --experimental-strip-types --test lib/whatsapp/atendimento/core.test.ts lib/whatsapp/atendimento/worker.test.ts lib/whatsapp/atendimento/transporte.test.ts`. Incluem invalidação por tomada humana, preservação de fila manual, janela, opt-out, pausa, timeout sem repetição e formulário oficial de envio. A revisão arquitetural mantém imports fechados; foram acrescentadas apenas três portas explícitas à composição da IA.

A execução desta sessão usou Node 24.20.0. O projeto declara Node 22.23.2: repetir as validações com o runtime declarado antes de publicar. Nenhum teste desta sessão acessou PostgreSQL, Gupshup real ou provedor de IA real.

## Revisão de 01/10/2026 (Claude, mesma candidata local)

Sem commit, push, migration, configuração remota ou envio real. Correções feitas na revisão, cada uma com teste:

- **Data passada no interesse:** a qualificação aceitava "Registrei seu interesse para 2020…". Agora data anterior a hoje (fuso America/Sao_Paulo) é recusada com nova pergunta, e uma data já vencida guardada na conversa não é reaproveitada (`hojeOperacao`, `dataDeInteresse` em `core.ts`; uso no `worker.ts`).
- **Webhook sem retry infinito:** evento de mensagem fora do contrato (outro app, versão, campos) devolvia 503 para sempre. Agora é confirmado sem persistir; texto vazio ou acima de 4.000 caracteres vira conteúdo sem texto e vai para a equipe. Falhas duráveis (banco, empresa inativa, configuração ausente) continuam 503 para retry.
- **Conversa encerrada pela equipe:** nova mensagem do cliente ficava em "Encerrada" e ninguém via. Agora reabre como contato novo (IA se a automação estiver ligada; senão aguardando atendente), sem responsável. Contato com PARAR continua bloqueado.
- **UI do atendimento:** ao escolher uma conversa (clique, toque ou Enter), o foco e a rolagem vão para ela; data no formato dd/mm/aaaa; horário em cada mensagem; "Quadro" no lugar de "Kanban"; foco visível em botões, links e resumo; "Retomar IA" com a borda luminosa aprovada dos botões da IA (sem animação com redução de movimento); ícone de atendimento no menu.
- **Diálogo de cancelar importação:** título e texto com espaçamento próprio.

Testes novos: `lib/whatsapp/atendimento/service.test.ts` (dedupe, automação desligada, PARAR, reabertura, opt-out, empresa inativa e configuração ausente, papel, versão, janela, envio em andamento, status), data passada em `core.test.ts`, falha de modelo/orçamento em `worker.test.ts`. Isolamento por empresa: `provarTenant` recusa usuário sem membership ativa na empresa piloto; o teste confirma que o controle usa só a empresa piloto e recusa papel sem atendimento.

**Gates com Node 22.23.2** (executável chamado diretamente; os logs anteriores eram de Node 24): `check:v1:static` — 1.700 testes unitários (na segunda rodada; 1.693 na primeira), 103 do harness com mocks, lint (só o warning preexistente de `FinalidadeSkill`), TypeScript e build. Log: `.local-ux/whatsapp-static-node22.log`.

**QA visual com APIs simuladas** (Playwright, `next dev` isolado, banco inacessível, nenhuma API real; roteiro `.local-ux/qa-whatsapp-ui.cjs`, que exige `PLAYWRIGHT_MODULE`; capturas e `resultados.json` em `.local-ux/whatsapp-qa/`), em celular 390×844 e desktop 1280×900, sem rolagem horizontal e sem erro de página:
- atendimento: lista, conversa aberta por teclado com foco no título, assumir com versão atual, conflito 409 exibido como alerta, opt-out com ações bloqueadas, quadro por estado, borda da IA animada e parada com `prefers-reduced-motion`;
- importação: falha na verificação mostra erro explícito e não abre demonstração sozinha; demonstração só pelo botão; revisão real (vitrine) com cancelar por teclado, foco dentro do diálogo, Esc preservando a revisão, erro do servidor ao marcar "Não consta no documento" exibido, e descarte confirmado voltando ao envio.

**Segunda rodada (01/10/2026), também sem banco, rede ou envio real:**
- **Migration 060** no padrão da 059: pré-condição inline, `lock_timeout`, chaves compostas também na auditoria (que ganhou `ambiente`), restrições de coerência entre direção e origem, índices da fila e de tarefas ativas, postcheck, down fail-closed (recusa com envio em andamento e exige descarte explícito com dados), rollback precheck/postcheck e inventário com testes (`production:test` 37/37). O inventário anterior já falhava com o arquivo 060 fora da lista.
- **Retenção de status:** status correlacionado é aplicado e apagado na hora; sem correspondência (OTP, envio incerto) expira em 24 h, apagado em lotes pelo worker.
- **Vazão:** uma resposta automática são duas tarefas (entrada e saída). O processador agora esvazia a fila em lote (até 20 tarefas ou 30 s por chamada) e o worker chama de novo sem esperar quando o lote para no limite. Corrigido também: mensagem obsoleta cancelada encerrava o lote.
- **Contatos permitidos:** proteção em código contra clientes reais na homologação com o número comercial (ver variável acima).
- **Suíte PostgreSQL da 060** escrita e registrada (`lib/whatsapp/atendimento/migration-060.postgres.test.ts`).

**Validação PostgreSQL (02/10/2026)**, autorizada pelo Felipe e feita só no cluster descartável 127.0.0.1:55498, PostgreSQL 18.6, com dados sintéticos:
- `check:v1:postgres` com Node 22.23.2: 29 de 30 suítes OK, **incluindo a da 060**. Ela cobre:
  - aplicação e reaplicação recusada;
  - isolamento entre empresas;
  - deduplicação em paralelo;
  - dois workers em paralelo;
  - tomada humana durante a geração;
  - PARAR;
  - janela de 24 h;
  - status antes do retorno do envio e retenção;
  - interrupção;
  - rollback.
- Ensaio de exportação, rollback e restauração: assinaturas idênticas no mesmo banco e em outro.
- Servidor parado e somente o diretório descartável removido.
- Detalhes, falha pré-existente do financeiro e achado do `--disable-triggers`: [plano, "Resultado da Parte 1"](VALIDACAO_060_E_HOMOLOGACAO_GUPSHUP.md).

**Segunda rodada PostgreSQL (02/10/2026)**, autorizada e no mesmo destino descartável (detalhes no [plano](VALIDACAO_060_E_HOMOLOGACAO_GUPSHUP.md), "Segunda rodada"):
- **Financeiro, teste.** O teste de concorrência original nunca concorria: os dados não estavam confirmados, e a rejeição ficava sem tratamento em parte das execuções. Na base `4a0c966` ele passa 10/10, com código idêntico; é uma corrida do próprio teste. O teste foi corrigido:
  - dados confirmados e visíveis às duas conexões;
  - tratamento registrado no início da operação concorrente;
  - espera comprovada em `pg_locks`;
  - erro específico exigido.
- **Financeiro, código.** O teste corrigido revelou um **defeito real já presente na base**, ao calcular o total pago dentro do `SELECT ... FOR UPDATE`. Uma baixa concorrente podia:
  - pagar além do valor da conta;
  - cancelar uma conta paga;
  - editar uma conta paga.
  Corrigido com `travarConta` em `lib/financeiro/servico.ts`. A regressão falha nas três versões antigas e passa 10/10 com a correção. **Atenção:** o defeito existe em staging, e em produção se a 052 foi publicada.
- **Recuperação da 060 sem superusuário.** Estrutura + dados exportados e restaurados por um usuário restrito sintético, sem `--disable-triggers`, no mesmo banco e em outro. Dados e estrutura idênticos; chaves estrangeiras, ausência de órfãos, isolamento e permissões verificados.
- **Gates.** `check:v1:postgres` 30/30, `check:v1:static` (1.700 + 103), `production:test` 37/37.

**Continua pendente:**
- Decidir como publicar a correção do financeiro: na entrega do WhatsApp ou em PR própria, com prioridade, por afetar staging e possivelmente produção.
- Homologação do Gupshup em staging (Parte 3 do plano) com destinatário de teste autorizado: autenticação do webhook, formato de `message-event` (`gsId` × `id`), mídia, status fora de ordem, receptor único do número.
- Worker não provisionado: decidir onde roda (autorização A6 do plano).
- **Nova festa** (atalho pelos serviços oficiais), **disponibilidade automática** (exige revisão do isolamento por empresa e unidade) e **etapas comerciais do quadro** (com paginação além de 100 itens) seguem como pendências de produto.

## Prompt para iniciar no Claude Code

> Continue a candidata local da entrega de UX e atendimento WhatsApp da Kidmais. Leia AGENTS.md, docs/OPERACAO_AGENTES.md e docs/HANDOFF_CLAUDE_UX_WHATSAPP.md. Preserve a árvore atual, confira as evidências e conclua as validações pendentes antes de recomendar publicação. Use Gupshup e o número atual da Kidmais, conforme escolhido. Não execute migration, mude configuração remota ou envie mensagens reais sem a autorização aplicável ao destino. Primeiro informe o estado encontrado e o próximo passo concreto.
