# Recuperação de pagamentos — 09/10/2026

Resultado: **PASS**, na base autorizada `127.0.0.1:55475/kidmais_webhook_20261009_sintetica`. Continuação solicitada por Felipe após a homologação do callback externo. Criadas três fixtures adicionais, preservando literalmente as assinaturas anteriores. Nenhuma migration, credencial externa, cobrança, túnel ou e-mail nesta etapa.

## Cenários executados

1. O handler real `receberWebhookAsaas` persistiu eventos em PostgreSQL e produziu resposta 200. Seu callback de agendamento foi deliberadamente descartado, e o processo filho encerrou com código 77 sem executar finally. Os eventos ficaram PENDENTE em armazenamento durável. O ensaio chama o handler diretamente; não mede entrega HTTP pela rede nem o tempo exato de uma queda do Next.
2. O processamento de outro evento reconsultou um provedor simulado indisponível (503), mantendo o evento FALHOU e a assinatura em TESTE. O registro da falha foi commitado.
3. Um processo filho processou o terceiro evento dentro de uma transação e encerrou com código 78 antes do COMMIT. O PostgreSQL reverteu os efeitos não confirmados; a assinatura continuou em TESTE e o evento persistido continuou recuperável.
4. Novo processo executou o mesmo ciclo de reconciliação usado pelo CLI, delimitado às três fixtures. Reconsulta ao provedor simulado disponível: os três eventos ficaram PROCESSADO e as assinaturas ATIVA, com período pago futuro. Contagem de tentativas: 1, 1 e 2, conforme os cenários.
5. Segunda rodada preservou literalmente os contratos, concessões Fundador e eventos. As assinaturas anteriores à rodada permaneceram literalmente iguais. Não houve nova entrega de webhook para provocar a recuperação.

As respostas do provedor são simuladas para controlar a falha. O banco e os encerramentos dos processos são reais. O teste externo Asaas permanece documentado separadamente em `HOMOLOGACAO_WEBHOOK_20261009.md`; não confundir as duas provas.

## Correção operacional

`scripts/assinatura-reconciliar.cjs` já processava pendências, mas erros por item eram apenas contabilizados e podiam resultar em saída 0. Extraído `executarCiclo`, compartilhado pelo CLI e pela homologação, sem mudar a lógica de transações por item. O relatório agora inclui `incompleto`; FALHOU, erro por item ou sincronização recusada resultam em saída 2. Erro de configuração/interrupção continua saída 1. Isso permite que um agendador detecte execução incompleta e alerte ou tente novamente. Um item que falha não impede os demais; simulação mantém ROLLBACK e bloqueios de mutações externas.

## Validação e estado final

- Três cenários PostgreSQL aprovados e recuperação repetida idempotente.
- Dois novos testes do ciclo e nove testes existentes de webhook/reconciliação aprovados; ESLint aprovado.
- Alterações desta etapa restritas a scripts e documentação; nenhum código Next alterado, build da aplicação não repetido (aprovado na etapa anterior).
- Evidência detalhada sem credenciais: `.local-assinatura-recuperacao/resultado.json`. Executor: `scripts/assinatura-recuperacao-homologar.cjs`. Estado concluído impede novas escritas por repetição; retomadas parciais exigem revisão, sem apagar histórico.
- Cluster sintético encerrado ao final. Nenhum commit, push, deploy, cron permanente ou alteração de produção.

## Próxima etapa

Preparar a execução periódica da reconciliação e seus alertas no ambiente de homologação. O mecanismo está validado, mas ainda não roda sozinho na hospedagem. A configuração deverá indicar alvo, intervalo, credenciais sandbox exclusivas, logs sanitizados, tratamento das saídas 1/2 e prevenção de execuções sobrepostas. Criação de cron, custo e alterações de infraestrutura continuam sujeitas à autorização operacional para o serviço exato.
