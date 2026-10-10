# Webhook Asaas — homologação executada

**Continuação:** [recuperação após falhas](HOMOLOGACAO_RECUPERACAO_20261009.md) validada posteriormente com PostgreSQL real, processos separados e provedor simulado. Execução periódica na hospedagem ainda não configurada.

## Resultado em 09/10/2026

Felipe aprovou este plano com “pode”. Executada a rodada em `kidmais_webhook_20261009_sintetica`, no cluster sintético `127.0.0.1:55475`. **PASS ponta a ponta**, com entrega externa real do Asaas sandbox, Next e PostgreSQL completos.

- Schema: 76 migrations e checks, incluindo up/down/reaplicação 074/075. Manifesto de 194 arquivos em `evidencias/assinatura-webhook-schema-20261009.json`.
- Login, seleção de empresa e checkout feitos pelas APIs reais do aplicativo, com cookies, CSRF e sessão. Trial da fixture já vencido: acesso inicial `SOMENTE_LEITURA / TESTE_ENCERRADO`. Criada assinatura Essencial mensal Fundador de R$ 118,20 no sandbox pelo serviço real de contratação. O checkout sozinho preservou acesso somente para consulta.
- Quick Tunnel Cloudflare temporário apontou somente para a porta restrita 3196. Verificados painel HTTP 404 e callback sem token HTTP 401. `cloudflared` 2026.10.0 baixado da distribuição oficial; SHA-256 conferido com o digest da release: `86aee4017b26625cee8484c113558f48effa4cd47f7aa05fcf425604e5d2b23c`.
- O primeiro callback revelou uma incompatibilidade concreta: o ID opaco do Asaas contém `&`; a expressão regular recusava esse caractere. Corrigido `lib/assinatura/sincronizacao.ts` para aceitar e preservar `&`, mantendo limite de 200 caracteres, prefixos internos reservados, token e reconsulta do provedor. Adicionado teste de regressão com o formato do exemplo oficial, incluindo recusas de entradas malformadas. Duas entregas receberam 400 antes da correção; a reentrega do próprio Asaas recebeu 200 e foi processada.
- Evento externo `PAYMENT_RECEIVED` persistido como `PROCESSADO`, uma tentativa de processamento, sem erro. Contratação e Fundador confirmados uma única vez; acesso mudou para `COMPLETO / ASSINATURA_ATIVA`, até `2026-11-09T03:00:00.000Z`. Não houve liberação manual por SQL nem sincronização disparada pelo roteiro para produzir esse resultado.
- Replay **local** do mesmo ID já recebido externamente retornou 200 e preservou literalmente assinatura, contrato e concessão. Esse replay testa idempotência e não é contado como entrega externa adicional.
- Cancelamento pela API real, após reautenticação: `COMPLETO / CANCELADA_NO_PERIODO`, com a mesma data final. Recorrência encerrada e cobrança paga simulada preservada. Webhook temporário removido e sua ausência reconsultada. Túnel, Next, proxy e cluster encerrados; portas 3195, 3196 e 55475 sem listeners na verificação final. Base e evidências preservadas.

O schema exige CNPJ de 14 caracteres; por isso esta fixture usou CNPJ sintético gerado com dígitos verificadores, conforme orientação oficial de dados fictícios para sandbox, em vez do CPF do exemplo do ensaio anterior. Sem CNPJ real da Kidmais, contatos do cliente ou notificações ao cliente. O e-mail autorizado de Felipe foi usado apenas como contato exigido na configuração do webhook; nenhum envio Resend foi solicitado nesta rodada.

Evidência detalhada, sem chaves: `.local-assinatura-webhook/rodada.json`, `next.log` e `cloudflared-integridade.json`. Scripts: `homologar-webhook-local.ps1` injeta somente os segredos Asaas via DPAPI; `assinatura-webhook-homologar.cjs` executa o roteiro e a limpeza. O estado concluído impede repetir mutações; falha com criação iniciada exige retomada revisada.

Validações locais: 100 testes de assinatura aprovados, TypeScript, ESLint e build aprovados. Build registrado em `homologacao-webhook-build.log`. Runtime local Node 24.20.0; o projeto declara 22.23.2. Nenhum commit, push, deploy ou alteração Render/produção realizado.

Limites: este ensaio valida o caminho mensal e a reentrega após recusa HTTP. Não simula queda do processo depois de responder 200, nem comprova agendamento de reconciliação, assinatura anual, cartão ou o aviso de renovação no prazo real. A ativação permanente ainda exige configuração por ambiente e operação de recuperação dos eventos duráveis pendentes/falhos.

## Plano aprovado (registro histórico)

## Situação

Na preparação, o ciclo externo de assinatura sandbox já havia passado; faltava comprovar callback externo e atualização do acesso. O resultado da execução autorizada está registrado acima.

A aplicação já recebe POST em `/api/integracoes/asaas/webhook`, compara o token, persiste evento de forma idempotente e agenda processamento por `after`. O processamento reconsulta o Asaas; o corpo do callback não basta para liberar acesso. Falha após HTTP 200 depende de reconciliação/reprocessamento, que também deve ser verificado antes de disponibilizar a integração em produção.

## Alvos e operações solicitadas

1. Usar o cluster sintético existente `.local-renovacao-pg075`, em `127.0.0.1:55475`. Criar exclusivamente a nova base `kidmais_webhook_20261009_sintetica`, vazia, com schema versionado completo e fixtures artificiais. Se já existir, parar para inspecionar o registro da rodada; não sobrescrever. Não copiar banco real nem alterar as duas bases de homologação anteriores. Registrar as versões/hashes das migrations aplicadas. A criação, migrations e escritas das fixtures nesta nova base são parte da aprovação solicitada.
2. Subir instância temporária do Kidmais em `127.0.0.1:3195` exclusivamente com essa base. Preparar guardas de host/porta/nome antes de conectar. Não carregar `.env.local`. Credenciais sandbox via DPAPI, nunca em argumentos/logs.
3. Baixar `cloudflared` de distribuição oficial, verificar integridade disponível e executá-lo sem instalação como serviço. Abrir Quick Tunnel temporário apontando exclusivamente para `127.0.0.1:3196`, onde `scripts/assinatura-webhook-porta.cjs` expõe apenas o POST do webhook. Nunca apontar o túnel diretamente ao Next. A URL HTTPS é gerada na execução e deve ser registrada sem tokens. Tráfego sandbox atravessa a Cloudflare.
4. Registrar um webhook temporário na conta Asaas sandbox, selecionando os eventos de pagamento necessários ao ensaio, com token exclusivo (não a API key). Persistir intenção e ID antes de prosseguir. Não modificar webhooks existentes. Se o limite da conta impedir criação, parar sem apagar configurações alheias. Conferir URL/ID/eventos por reconsulta. Nenhuma configuração no Render.
5. Criar empresa/gestor sintéticos na base nova e contratar Essencial mensal Fundador pelo fluxo da aplicação, R$ 118,20. Criar somente cliente/assinatura sintéticos da rodada no Asaas, sem contatos e com notificações desativadas. Usar documento do exemplo oficial de sandbox, nunca o CNPJ real da Kidmais.
6. Confirmar a cobrança exclusivamente pelo endpoint de simulação sandbox. Esperar o callback externo: verificar evento persistido, processamento concluído, contratação confirmada, Fundador concedido uma única vez, assinatura ativa e período de acesso. Separar evidência de entrega externa de qualquer replay local. Repetir o mesmo evento localmente para testar idempotência sem nova concessão; manter a origem dessa repetição explícita. Verificar também que token inválido não ativa nada.
7. Cancelar somente a recorrência sintética criada na rodada, reconsultar seu encerramento e preservar cobrança paga simulada. Remover apenas o webhook temporário após conferir seu ID/URL; parar túnel, proxy, aplicação e cluster. Preservar a base sintética e evidências para auditoria. Não apagar histórico nem liberar vagas artificiais para ocultar efeitos do teste.

## Falhas e recuperação

- Persistir intenções antes de criações externas. Resposta perdida exige reconsulta por referência; não repetir POST cegamente.
- Sem callback: registrar etapa incompleta e consultar logs sanitizados. Não substituir a prova por polling e declarar webhook aprovado.
- Falha no processamento: verificar estado durável e reprocessamento idempotente; não corrigir estado comercial manualmente por SQL.
- Falha na limpeza: registrar IDs locais e pendência, interromper túnel e informar a recorrência/webhook que ainda requer encerramento. Não limpar objetos que não pertençam à rodada.

## Preparação validada

Criados `scripts/assinatura-webhook-porta.cjs` e seu teste. O proxy aceita apenas caminho literal, método POST, token com comparação em tempo constante, JSON até 64 KiB e tempo limitado. Descarta cookies e headers de origem fornecidos pelo chamador; encaminha para destino local fixo. Não repassa respostas internas; somente HTTP 200 do app vira confirmação. Sem token/configuração de homologação, não inicia. Essa guarda não substitui a validação de destino do banco no lançador do app.

Em 09/10/2026: dois testes Node aprovados com requisições HTTP locais e destino simulado, cobrindo bloqueios, ausência de encaminhamento indevido, encaminhamento válido e falhas/redirecionamentos do destino. ESLint aprovado. O sandbox do executor bloqueou loopback com EACCES; a repetição autorizada fora dele passou. Nenhum banco, túnel ou provedor foi conectado por esses testes. Não houve alteração de código Next; build da aplicação não foi repetido nesta preparação. Preparação do lançador/fixture e execução ponta a ponta continuam pendentes.

## Referências consultadas

- [Asaas: webhooks](https://docs.asaas.com/docs/sobre-os-webhooks): eventos podem ser repetidos, autenticação pelo header `asaas-access-token`, persistência antes de HTTP 200.
- [Asaas: eventos de pagamento](https://docs.asaas.com/docs/payment-events): exemplo de identificador opaco contendo `&`.
- [Asaas: aprovação de contas sandbox](https://docs.asaas.com/docs/aprova%C3%A7%C3%A3o-de-contas): orientação para dados fictícios com formato válido nos testes.
- [Cloudflare: Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/): URL temporária para desenvolvimento, encerrada ao parar o processo; sem garantia de disponibilidade. Autenticação interativa por e-mail não serve para callbacks Asaas.

A aprovação foi solicitada pela [política operacional](OPERACAO_AGENTES.md): “Migrations, writes SQL, restore, delete e alteração de DATABASE_URL sempre exigem autorização explícita de Felipe. A mesma exigência vale em staging e em ambientes isolados”. Felipe aprovou o novo alvo e as operações deste plano antes da execução.
