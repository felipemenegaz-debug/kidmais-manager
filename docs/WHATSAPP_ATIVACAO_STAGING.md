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

Três camadas, todas fail-closed:

1. **Código:** só grava e envia o ambiente em que `WHATSAPP_ATENDIMENTO_RECEPTOR` = `KIDMAIS_DEPLOY_ENV`. Ausente, vazio ou divergente: nada é gravado nem enviado, mesmo com `RECEIVE_ENABLED` e `ENABLED` ligados. Produção hoje não tem nenhuma das variáveis do atendimento e fica desligada.
2. **Gupshup:** cada ambiente tem seu `GUPSHUP_WEBHOOK_SECRET`. Só a assinatura com o segredo do receptor autentica mensagens; a cópia de outro ambiente sem o segredo dele recebe 401.
3. **Janela de 24 h:** o envio exige mensagem do cliente recebida *no mesmo banco* nas últimas 24 h. O ambiente que não recebeu não tem conversa aberta para responder.

Para trocar o receptor no futuro (staging → produção), a ordem é: desligar `ENABLED` e `RECEIVE_ENABLED` em staging, remover `RECEPTOR` de staging, parar o worker de staging e só então configurar produção. Nunca os dois ao mesmo tempo.

## Decisões do Felipe antes de ativar

| # | Decisão | Recomendação |
| --- | --- | --- |
| D1 | Como autenticar o webhook (**pendente:** consulta ao Gupshup no chamado #277630, aberto e sem resposta em 02/10/2026; canal não é ativado antes da comprovação) | Assinatura v2 criada pela Partner API, com `meta` = `{"X-Kidmais-Webhook-Secret": <segredo de staging>}`. Se não houver acesso Partner para o app `KidmaisManager`, parar: a alternativa (segredo no caminho da URL) exige outra mudança de código e revisão de segurança, e não está implementada |
| D2 | Número destinatário de teste (A1) | Um número do Felipe ou de pessoa que consentiu; só ele na lista de permitidos |
| D3 | Onde roda o worker (A6) | Na homologação: processo temporário na máquina do Felipe durante a janela de teste. Depois: Background Worker do Render, decidido junto com a ativação em produção |
| D4 | Quem recebe hoje as mensagens do número | Ler as assinaturas atuais antes de qualquer mudança. A nova assinatura de staging é **acrescentada**, nunca substitui as existentes |

## Ativação em staging, etapa por etapa

Ordem pensada para que cada etapa seja reversível e o canal fique desligado até o fim. Staging: `kidmais-manager-staging` (`srv-daif418ae00c73e8k2gg`), branch `staging`, auto-deploy desligado (revalidar por leitura antes de E1 e E3).

| Etapa | Alvo e ação | Efeito | Validação | Recuperação |
| --- | --- | --- | --- | --- |
| E0 — Leituras | Render: branch/auto-deploy de staging e produção; nomes (não valores) das variáveis de staging. Gupshup: listar as assinaturas do app (painel ou `GET` da Partner API) | Nenhum | Assinaturas atuais, modos e URLs anotados; `GUPSHUP_WEBHOOK_SECRET` e `KIDMAIS_DEPLOY_ENV=staging` presentes em staging | — |
| E1 — Merge | PR → `staging` (merge commit), depois do CI verde | Código em `staging`; sem deploy (auto-deploy desligado) | CI verde; `git log origin/staging` | Revert do merge |
| E2 — Banco | Backup do banco de staging; 060 com precheck inline e postcheck | Cria 5 tabelas vazias; Core intacto | Postcheck; contagem de tabelas do Core igual antes e depois | Down da 060 (recusa se houver dados sem descarte explícito). Ensaio validado no PostgreSQL descartável |
| E3 — Deploy | Deploy manual do commit de `staging` | Código novo no ar com o canal desligado | Health; `/admin/atendimento` abre com "Receber mensagens: Desligado"; webhook continua 204 para status de OTP | Deploy do commit anterior |
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
