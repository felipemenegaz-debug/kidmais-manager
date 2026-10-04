# Atendimento WhatsApp — Gupshup verificado e ativação em staging

Preparado em 02/10/2026. **Nada deste documento foi executado.** Cada etapa remota precisa da autorização explícita do Felipe para o alvo e a ação ([OPERACAO_AGENTES.md](OPERACAO_AGENTES.md)). Estado do código: PR `whatsapp/atendimento-ia-v1` → `staging`. Validações anteriores: [VALIDACAO_060_E_HOMOLOGACAO_GUPSHUP.md](VALIDACAO_060_E_HOMOLOGACAO_GUPSHUP.md).

## O que a documentação oficial do Gupshup confirma

Consulta de 02/10/2026, somente leitura. Itens marcados "não documentado" precisam de prova na homologação.

| Assunto | Documentado | Efeito no código |
| --- | --- | --- |
| Mensagem recebida (v2) | `{app, timestamp, version: 2, type: "message", payload}`. `timestamp` em **milissegundos**. `payload.source` sem "+". Texto em `payload.payload.text`. Tipos: text, image, file, audio, video, contact, location, button_reply, list_reply (e quick_reply). [inbound](https://docs.gupshup.io/docs/what-is-an-inbound-message), [text](https://docs.gupshup.io/docs/text) | Já estava correto. Só texto vai ao modelo; o resto vai para a equipe. Nome do remetente não é guardado |
| Status (`message-event`) | `enqueued`/`failed` síncrono: `payload.id` é o `messageId` do envio. `sent`/`delivered`/`read`: `payload.id` é o id do WhatsApp e `payload.gsId` é o do Gupshup. Ordem **não garantida**; `read` pode chegar sem `delivered`. [message-events](https://docs.gupshup.io/docs/message-events) | Correlação por `gsId ?? id` (correto). Status fora de ordem não rebaixa ENTREGUE. `read` conta como ENTREGUE |
| Envio de sessão | `POST https://api.gupshup.io/wa/api/v1/msg`, cabeçalho `apikey`, formulário `channel, source, destination, src.name, message`. Sucesso: **2xx** (o exemplo usa 200) com `{"status":"submitted","messageId":…}`. Erros 400/401/429 com `{"status":"error"}`. Sem chave de idempotência. [msg](https://docs.gupshup.io/reference/msg) | **Corrigido:** o transporte só aceitava 202 e marcaria todo envio real como incerto. Agora: 2xx aceito; 4xx documentado = recusa definitiva (FALHOU); 5xx, 408, corpo inválido ou timeout = INCERTO, sem reenvio |
| Janela de 24 h | A sessão começa na última mensagem do usuário. Fora dela, o envio falha de forma assíncrona (código 470). [session messages](https://docs.gupshup.io/docs/session-messages-1) | Já verificado antes de enfileirar e antes de enviar |
| Opt-out | O Gupshup não verifica opt-out no envio; a empresa controla. [suporte](https://support.gupshup.io/hc/en-us/articles/35183519921689) | PARAR grava `nao_contatar` e bloqueia tudo, inclusive envio humano |
| Retentativa do webhook | Esperado 2xx em até 10 s; fora disso, o Gupshup repete. Contagem e intervalo de repetição não documentados. [webhooks](https://docs.gupshup.io/docs/what-is-a-webhook) | Persistência antes do ACK, deduplicação por evento. Horário do evento à frente do relógio vale como "agora" (antes devolvia 503 e o Gupshup repetiria sem fim) |
| Autenticação do webhook | **Sem assinatura/HMAC documentada.** Cabeçalhos próprios só pela **Partner API**: assinatura com campo `meta`, enviado como cabeçalho "para autenticação". [setsubscription v3](https://partner-docs.gupshup.io/reference/setsubscription-api-v3). A API de assinatura self-serve não tem `meta` | O receptor exige `X-Kidmais-Webhook-Secret`. **Isso exige criar a assinatura pela Partner API** (decisão D1) |
| Várias assinaturas | Até **5 assinaturas por app**; cada uma recebe sua cópia dos eventos. A API de "callback URL" antiga foi descontinuada (2025). [atualizações técnicas](https://support.gupshup.io/hc/en-us/articles/42866242419609) | Staging e produção podem receber o mesmo evento. **Novo:** `WHATSAPP_ATENDIMENTO_RECEPTOR` define o único ambiente que grava e responde |
| IPs de origem | Lista publicada na documentação de parceiros ([allowlist](https://partner-docs.gupshup.io/docs/gupshup-ip-allowlisting)); a página self-serve manda pedir ao suporte | Não usado como autenticação (IPs compartilhados entre clientes Gupshup) |

## Receptor único do número

Três camadas, todas fail-closed. **Nenhuma comprova sozinha a exclusividade entre ambientes**: a flag é local a cada ambiente, e a configuração do outro ambiente e as assinaturas do Gupshup precisam ser verificadas (E0).

1. **Código:** só grava e envia o ambiente em que `WHATSAPP_ATENDIMENTO_RECEPTOR` = `KIDMAIS_DEPLOY_ENV`. Ausente, vazio ou divergente: nada é gravado nem enviado, mesmo com `RECEIVE_ENABLED` e `ENABLED` ligados.
   - Garante só o lado de cada ambiente.
   - O estado das variáveis de produção **não foi verificado** nesta entrega; conferir os nomes por leitura, com autorização (E0).
2. **Gupshup:** cada ambiente **deve** ter o seu `GUPSHUP_WEBHOOK_SECRET`.
   - Só a assinatura com o segredo do receptor autentica mensagens; a cópia de outro ambiente sem o segredo dele recebe 401.
   - Presença não comprova que os segredos são diferentes: isso fica a cargo de quem os gerou.
   - A lista de assinaturas do app mostra quais URLs recebem `MESSAGE`.
3. **Janela de 24 h:** o envio exige mensagem do cliente recebida *no mesmo banco* nas últimas 24 h. O ambiente que não recebeu não tem conversa aberta para responder.

Para trocar o receptor no futuro (staging → produção), a ordem é: desligar `ENABLED` e `RECEIVE_ENABLED` em staging, remover `RECEPTOR` de staging, parar o worker de staging e só então configurar produção. Nunca os dois ao mesmo tempo.

## Condições para iniciar a homologação real

A homologação real (E5 em diante) fica bloqueada até as três condições estarem comprovadas:

1. **Autenticação Gupshup:** o mecanismo efetivamente suportado para o app `KidmaisManager` (chamado #277630). Não enfraquecer o webhook nem alterar assinaturas para contornar.
2. **Receptor exclusivo:** E0 sem divergência. Produção sem as variáveis de automação do atendimento; nenhuma outra assinatura com `MESSAGE` levando a resposta automática.
3. **OTP preservado:** depois do deploy (E3), o webhook continua 204 para os status de OTP, e o OTP de login funciona em staging.

O merge (E1) não implica deploy nem ativação. Cada etapa seguinte tem autorização própria.

## Decisões do Felipe antes de ativar

| # | Decisão | Recomendação |
| --- | --- | --- |
| D1 | Como autenticar o webhook (**pendente:** consulta ao Gupshup no chamado #277630, aberto e sem resposta em 02/10/2026; canal não é ativado antes da comprovação) | Assinatura v2 criada pela Partner API, com `meta` = `{"X-Kidmais-Webhook-Secret": <segredo de staging>}`. Se não houver acesso Partner para o app `KidmaisManager`, parar: a alternativa (segredo no caminho da URL) exige outra mudança de código e revisão de segurança, e não está implementada |
| D2 | Número destinatário de teste (A1) | Um número do Felipe ou de pessoa que consentiu; só ele na lista de permitidos |
| D3 | Onde roda o worker (A6) | **Decidido:** processo temporário na máquina do Felipe, só durante a janela autorizada. Nenhum serviço Render é criado; o worker de produção é decisão da etapa própria de produção |
| D4 | Quem recebe hoje as mensagens do número | Ler as assinaturas atuais antes de qualquer mudança. A nova assinatura de staging é **acrescentada**, nunca substitui as existentes |

## Deploy da candidata com o canal desligado (E1–E3 concretas)

Preparado em 04/10/2026. **Não depende da resposta do Gupshup**: nada aqui liga recepção ou envio, cria assinatura, muda variável, inicia worker ou manda mensagem. Cada linha exige autorização própria.

### Leituras feitas (04/10/2026)

**Render, workspace `tea-daidbj95efls73d2bcf0`:**
- `kidmais-manager-staging` (`srv-daif418ae00c73e8k2gg`): branch `staging`, auto-deploy desligado (`autoDeploy: no`, trigger `off`), previews desligados.
- Deploy live: `dep-db0u5g6gekts73ba5urg`, commit `87b9611`, igual ao `origin/staging` atual.
- `kidmais-manager-production`: branch `production`, auto-deploy desligado.
- Não existe Background Worker nem outro serviço além dos dois web services.

**Banco de staging:** `kidmais-staging` (`dpg-daidko3m8hqs73ce4jt0-a`, banco `kidmais_staging_1z91`, PostgreSQL 18).

**Migrations aplicadas em staging: NÃO comprovadas.**
- O inventário não tem tabela de controle (`appliedState: unknown`).
- O repositório registra a 059 aplicada em 01/10 (por um script executado pelo Felipe) e um plano para 061/062 (`docs/CONTRATOS_IMPORTADOS_INTEGRACAO.md`, S1–S21), sem registro de execução.
- O deploy live de `87b9611`, que contém o código da 061/062, sugere as duas aplicadas, mas não prova.
- Leitura necessária: E2a.

### O que a candidata exige do schema

| Migration | Exigida pelo código da candidata? | Observação |
| --- | --- | --- |
| 055a–059 | Sim, pelo código já em produção de staging (IA, skills, operacional) | A candidata não muda essa dependência |
| 060 | Só para a tela de Atendimento, a API administrativa e o processador | Sem a 060: a tela responde "indisponível"; o webhook não toca no banco com o canal desligado; o OTP não muda |
| 061/062 | Pelo código de contratos e agenda já live em `87b9611` (com detecção de schema) | A candidata não muda essa dependência: o deploy só acrescenta o WhatsApp ao que já está no ar |

### Prova de que o canal fica desligado

- **Recepção:** `recepcaoAtiva()` exige `WHATSAPP_ATENDIMENTO_RECEIVE_ENABLED=true`, `WHATSAPP_ATENDIMENTO_RECEPTOR` igual a `KIDMAIS_DEPLOY_ENV` e uma empresa piloto válida. `WHATSAPP_ATENDIMENTO_RECEPTOR` foi criada por esta PR e **não foi configurada por esta entrega** (nenhuma autorização de variável foi dada). A ausência em staging é confirmada antes do deploy pela leitura E3-pré (sem inferência) e de novo pela tela depois dele. Sem ela, a recepção fica desligada e o webhook se comporta como hoje.
- **Envio:** `atendimentoAtivo()` exige `WHATSAPP_ATENDIMENTO_ENABLED=true` e o mesmo receptor. O processador exige `WHATSAPP_ATENDIMENTO_WORKER_SECRET` (401 sem ele) e só roda se for chamado. Nenhum worker existe nem será iniciado.
- **Confirmação ANTES do deploy (E3-pré), sem inferir ausência:** leitura das variáveis `WHATSAPP_ATENDIMENTO_*` do serviço de staging no painel do Render, feita pelo Felipe, com o resultado informado no chat. O Render MCP não lista variáveis, e o código live não as lê. Critério: `RECEPTOR` inexistente e nem `RECEIVE_ENABLED` nem `ENABLED` iguais a `true`; senão, **parar** (mudar variável é operação própria). Roteiro: `.local-ux/staging-060/E3-pre-conferencia-variaveis.md`.
- **Confirmação DEPOIS do deploy (segunda, não substitui a anterior):** a tela mostra a "Situação do canal", lida do ambiente do servidor. O esperado: "Receptor do número: Outro ambiente ou nenhum", "Receber mensagens: Desligado" e "Enviar respostas: Desligado". Divergência leva a reverter para o deploy anterior.

### Efeito no OTP

- O envio do OTP (`lib/identidade`) não mudou.
- A rota `/api/integracoes/gupshup/webhook` ganhou um ramo de persistência que **só existe com a recepção ligada**. Desligada, o receptor é chamado sem `persistEvent` e responde como hoje (204/400/401/403/405/408/413/415/503).
- O pool do banco é criado só na primeira consulta: importar o serviço não conecta.
- Evidência: `webhook.test.ts`, no gate de `918b0a1` e do merge `6cf5813`.

### Ordem e operações

| # | Operação | Alvo | Efeito | Verificação | Recuperação |
| --- | --- | --- | --- | --- | --- |
| P1 | Push da branch `whatsapp/atendimento-ia-v1` | GitHub (PR #80) | PR atualizada sem conflito; CI do HEAD exato. Nenhum serviço Render acompanha esta branch | CI verde do HEAD; descrição da PR atualizada | Force push não; corrigir com novo commit |
| E1 | Merge da PR #80 em `staging` (merge commit) | GitHub | `origin/staging` passa a conter a candidata. Sem deploy com o auto-deploy desligado (revalidar antes) | `origin/staging` = merge; deploy live inalterado | Revert do merge |
| E2a | **Leitura** do estado das migrations: `aplicar-060-staging.ps1 -Alvo <sha> -SomenteEstado`, executado pelo Felipe (URL digitada mascarada) | Banco de staging, `default_transaction_read_only=on` | Nenhum | **Marcadores = presença preliminar.** Para cada migration com marcador presente, o **postcheck oficial** do commit alvo roda em leitura e é o que a **confirma**. Ausente ou parcial nunca conta como confirmada | — |
| E2b | Backup fresco (`pg_dump -Fc`) e 060 (precheck embutido, atômica, `lock_timeout` 5 s) e postcheck oficial em leitura: o mesmo script sem `-SomenteEstado`, com frase digitada. Só prossegue com 055a–059 **confirmadas** por postcheck, 061/062 sem estado parcial nem postcheck falhando, e 060 ausente | Banco de staging | Cria 5 tabelas vazias; Core intacto. O código live (`87b9611`) as ignora | Postcheck oficial da 060 OK em leitura; marcadores da 060 presentes | **Falha durante a 060 = resultado potencialmente incerto** (a conexão pode cair em volta do COMMIT). O script não repete: inspeciona em leitura (marcadores e, se presentes, o postcheck) ou, sem conexão, declara o estado desconhecido. Não repetir, não executar DOWN e não fazer deploy antes da inspeção (`-SomenteEstado`) e de uma decisão. Tabelas vazias: rollback precheck, down e postcheck da 060 só por decisão. Nunca restaurar o backup sem decisão |
| E3-pré | Leitura das variáveis `WHATSAPP_ATENDIMENTO_*` no painel do Render, feita pelo Felipe; nova leitura dos serviços (sem worker) | `srv-daif418ae00c73e8k2gg` (leitura) | Nenhum | Critério do roteiro `E3-pre-conferencia-variaveis.md` | Divergência: parar antes do deploy |
| E3 | Deploy manual do commit de `origin/staging` (o merge da E1) | `srv-daif418ae00c73e8k2gg` | Build com `check:v1:static`; código novo no ar com o canal desligado | Deploy `live` com o commit certo; `/api/health`; logs sanitizados; tela de Atendimento abre com tudo desligado; login com OTP funciona | Deploy do commit anterior (`87b9611`) |

**Ordem recomendada:** P1 → (CI e revisão) → E1 → E2a → E2b → E3-pré → E3. Com a 060 antes do deploy, a tela funciona assim que o código sobe. Se E2 for adiada, E3 continua segura, mas a tela fica "indisponível" até a 060. E3 nunca acontece sem E3-pré.

**OTP na verificação:** o login em staging dispara um OTP real para o número do usuário que entra. Só com autorização explícita, ou com o próprio Felipe fazendo o login.

**Scripts para revisão (fora do Git, no checkout).** Pasta `C:/Users/Glass/.codex/worktrees/0997/kidmais-manager-ai-master/.local-ux/staging-060/`, com hashes SHA-256 em `MANIFESTO.txt`:
- `aplicar-060-staging.ps1`: modos `-SomenteValidar`, `-SomenteEstado` e padrão;
- `estado-migrations-staging.sql`: marcadores de presença preliminar;
- `guard-origem.ps1` e `sonda-encoding.sql`: copiados sem alteração do script da 059, com hash idêntico à origem;
- `E3-pre-conferencia-variaveis.md`.

Validação offline (`-SomenteValidar`), sem conexão:
- o positivo extrai e confere por blob a 060 e os 11 postchecks oficiais;
- os negativos param sem conectar quando o alvo não tem a 060, com chave proibida e quando o `staging` remoto difere do alvo.

## Ativação em staging, etapa por etapa

Ordem pensada para que cada etapa seja reversível e o canal fique desligado até o fim. Staging: `kidmais-manager-staging` (`srv-daif418ae00c73e8k2gg`), branch `staging`, auto-deploy desligado (revalidar por leitura antes de E1 e E3).

| Etapa | Alvo e ação | Efeito | Validação | Recuperação |
| --- | --- | --- | --- | --- |
| E0 — Leituras | Render: branch/auto-deploy de staging e produção; nomes (não valores) das variáveis de staging e, com autorização, de produção. Gupshup: listar as assinaturas do app (painel ou `GET` da Partner API) | Nenhum | Assinaturas atuais, modos e URLs anotados. Em staging, `GUPSHUP_WEBHOOK_SECRET` e `KIDMAIS_DEPLOY_ENV=staging` presentes. **Exclusividade:** produção sem `WHATSAPP_ATENDIMENTO_RECEPTOR`, `RECEIVE_ENABLED` e `ENABLED`, e nenhuma outra assinatura com `MESSAGE` apontando para um receptor que responda automaticamente | Divergência: parar antes de E1 |
| E1 — Merge | PR → `staging` (merge commit), com autorização, depois de revalidar imediatamente antes: HEAD e base da PR, CI verde do HEAD, branch e auto-deploy dos serviços Render | Código em `staging`. Sem deploy **se** o auto-deploy continuar desligado, o que não é garantia permanente. Deploy nunca é consequência automática | CI verde; `git log origin/staging`; deploys do serviço inalterados | Revert do merge |
| E2 — Banco | Backup do banco de staging; 060 com precheck inline e postcheck | Cria 5 tabelas vazias; Core intacto | Postcheck; contagem de tabelas do Core igual antes e depois | Down da 060 (recusa se houver dados sem descarte explícito). Ensaio validado no PostgreSQL descartável |
| E3 — Deploy | Deploy manual do commit de `staging`, com autorização própria (não decorre do merge) | Código novo no ar com o canal desligado | Health; `/admin/atendimento` abre com "Receber mensagens: Desligado"; webhook continua 204 para status de OTP; **login com OTP funciona em staging** (condição 3) | Deploy do commit anterior |
| E4 — Variáveis | Staging: `WHATSAPP_ATENDIMENTO_EMPRESA_ID`, `WHATSAPP_ATENDIMENTO_RECEPTOR=staging`, `WHATSAPP_ATENDIMENTO_CONTATOS_PERMITIDOS=<D2>`, `WHATSAPP_ATENDIMENTO_WORKER_SECRET` (novo, exclusivo), `WHATSAPP_ATENDIMENTO_WORKER_URL`, teto em `AI_BUDGET_JSON.porCapacidade.whatsapp_atendimento` (baixo). `RECEIVE_ENABLED` e `ENABLED` ainda **desligados**. Produção: nada | A troca de variáveis provoca deploy de staging | Tela: "Receptor: Este ambiente", "Orçamento: Definido", demais desligados | Remover as variáveis (novo deploy) |
| E5 — Assinatura | Gupshup: **acrescentar** assinatura v2 de staging, tag `kidmais-staging-atendimento`, URL `https://kidmais-manager-staging.onrender.com/api/integracoes/gupshup/webhook`, modos MESSAGE, SENT, DELIVERED, READ, FAILED, `meta` com o segredo de staging (D1) | Staging passa a receber cópias dos eventos; com `RECEIVE_ENABLED` desligado só registra metadados | H1: mensagem do número de teste aparece só como metadado no log, sem gravação | Remover só essa assinatura pela tag |
| E6 — Recepção | `RECEIVE_ENABLED=true` (deploy) | Mensagens do número de teste são gravadas; demais confirmadas sem gravar | H2 | Desligar a variável |
| E7 — Worker e envio | Configuração da empresa ligada pela tela; `ENABLED=true` (deploy); worker conforme D3 | Respostas automáticas só para o número de teste | H3 a H10 | Desligar `ENABLED`; parar o worker. Histórico e resultados incertos ficam |
| E8 — Encerramento | Desligar `ENABLED` e `RECEIVE_ENABLED`, parar o worker, esvaziar a lista de permitidos e remover a assinatura de staging (ou mantê-la com recepção desligada) | Canal desligado | Tela mostra tudo desligado | — |

O roteiro H1–H11 está na [Parte 3 da validação](VALIDACAO_060_E_HOMOLOGACAO_GUPSHUP.md#roteiro). Acréscimos desta rodada:

- **H3:** conferir que o envio real volta 2xx com `messageId`, que a mensagem fica SUBMETIDA e depois ENTREGUE pelo `gsId` do `delivered` ou `read`.
- **H9:** com o teto da capacidade esgotado, o contato recebe só o texto fixo de encaminhamento e a conversa vai para "Aguardando atendente".
- **H9:** com o limite de respostas da tela em 1, a segunda pergunta encaminha sem chamar o modelo.
- **H11 (novo item):** conferir no painel do Gupshup que as assinaturas anteriores continuam iguais às de E0.

**Interrupção imediata:**
- envio a número fora da lista;
- mensagem de cliente real gravada;
- resposta com preço ou condição fora das respostas publicadas;
- qualquer erro de isolamento;
- resposta automática vinda de produção.

Nesses casos: desligar as flags, parar o worker, remover a assinatura de staging e registrar.

## Worker

`node scripts/whatsapp-atendimento-worker.mjs`, com `WHATSAPP_ATENDIMENTO_WORKER_URL` e `WHATSAPP_ATENDIMENTO_WORKER_SECRET` do mesmo ambiente injetados no processo (nunca em arquivo versionado).

- Recusa iniciar sem URL HTTPS completa do processador ou com segredo fora do formato.
- Laço: chama o processador; sem fila espera 3 s; com fila cheia (`LIMITE`) chama de novo na hora; em falha espera 3, 6, 12… até 60 s.
- Logs sem conteúdo: início, mudança de estado do processador, resumo de tarefas a cada 10 min, falhas por código HTTP.
- Para com SIGTERM/SIGINT. Parar no meio de um lote é seguro: o que ficou em andamento vira FALHOU/INCERTO depois de 10 min e vai para a equipe, sem reenvio.
- Mais de um worker ao mesmo tempo é seguro (reserva com SKIP LOCKED), mas não é necessário no piloto.

## Recuperação geral

Desligar `WHATSAPP_ATENDIMENTO_ENABLED` interrompe envios novos (inclusive humanos pela fila); desligar `RECEIVE_ENABLED` volta o webhook a só registrar metadados; remover `RECEPTOR` desliga as duas coisas de uma vez. O histórico, os resultados incertos e as tabelas ficam. Não apagar tabelas nem reenviar em massa como recuperação. O down da 060 só depois de exportar as tabelas, como no ensaio.
