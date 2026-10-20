# Aviso Fundador via Shell staging — execução preparada

Objetivo: testar aceitação e deduplicação do e-mail sintético usando o artefato já publicado e [conferido por hashes](DIAGNOSTICO_ARTEFATO_CRON_20261009.md). Não muda o comando do cron nem publica outro build. Alvo único: workspace `tea-daidbj95efls73d2bcf0`, cron `crn-db493i142hec73ahmoe0`, candidata atual LIVE `27e072237442e2f249e1e93d85a74e62b6eb7695`, deploy `dep-db4oot2jnfac738028ug`. Revalidado comando normal, staging/auto-deploy OFF e sucesso agendado às 02:10:28 UTC de 10/10.

## Operação delimitada proposta

1. Depois de aprovação, revalidar candidata/serviço/configuração por metadados. Abrir **uma** nova sessão temporária no Shell desse cron, no plano atual, por até cinco minutos desde a abertura. A conexão pode ter cobrança por duração; nenhum novo serviço, alteração de plano ou ampliação de limite. Se o terminal não ficar pronto no prazo, fechar a página e registrar o impedimento.
2. Executar o comando de leitura do diagnóstico anterior no mesmo Shell. Exigir serviço/ambiente e Node 22.23.2 corretos, revisão informada exatamente `27e0722…` e os três arquivos presentes com hashes iguais. Em divergência, encerrar sem enviar, sem novo deploy e sem alterar credenciais.
3. Assim que os hashes forem confirmados, escolher uma única janela UTC absoluta: início no minuto atual (segundos 00.000), fim início + quatro minutos. Registrar os instantes antes de executar; o comando deve começar dentro da janela e dentro do limite da sessão. Não reutilizar a janela abandonada das 01:00 nem gerar nova janela para repetir uma falha. Datas do e-mail derivadas do início fixo e de America/Sao_Paulo.
4. Executar **uma vez** o script existente com os argumentos abaixo, preenchendo as duas datas ISO verificadas. Usar a configuração já salva no Render, sem ler/copiar chaves ou abrir .env. Não executar assinatura-renovar, assinatura-cron ou outros comandos de aplicação.

```sh
node --experimental-strip-types /opt/render/project/src/scripts/assinatura-aviso-email-staging.cjs --enviar-teste --inicio=INICIO_UTC_ISO --fim=FIM_UTC_ISO
```

5. O script faz no máximo **dois POSTs imediatos** ao Resend, com o mesmo payload/Idempotency-Key, para um único e-mail deduplicado. Destinatário fixo **felipemenegaz@gmail.com**, remetente `Kidmais Manager — Teste <onboarding@resend.dev>`. Modelo real de renovação, claramente marcado TESTE; preços sintéticos Essencial mensal R$ 118,20 → R$ 197,00, vencimento 30 dias de calendário após o início. O primeiro parágrafo afirma que não é uma cobrança ou alteração da assinatura da Kidmais Festas. Link público staging `/admin/assinatura`, sem token. Não envia para outros destinatários, não consulta banco, não chama Asaas nem altera assinatura/cobrança.
6. Resultado esperado: `ACEITO_REPLAY_MESMO_ID`, requisicoes=2, bancoConsultado=false, cobrancasAlteradas=0, entregaNaCaixa=AGUARDA_CONFIRMACAO, avisoNaTelaValidado=false, renovacaoRemotaHabilitada=false. Exigir o mesmo identificador nas respostas; não registrar o identificador, body ou segredo. Salvar somente a saída sanitizada/captura. Em recusa, timeout, divergência, janela expirada ou ausência do script, não tentar de novo nesta autorização; registrar resultado incerto/pendente.
7. Sempre sair com `exit` e fechar a página do Shell; confirmar aba fechada e metadados do cron normal, sem reconectar ao Shell para conferir encerramento. Não afirmar desprovisionamento confirmado pela API se esse status não estiver disponível. Nenhum deploy de recuperação é necessário porque comando, env e schedule ficam preservados.
8. Após fechar a sessão, pedir a Felipe confirmação de recebimento do único e-mail de teste. Aceitação pelo Resend não comprova entrega. Guardar as evidências documentais em staging após revisão/metadata-auto-deploy; não declarar aviso na tela ou renovação integral homologados.

## Aprovação requerida e validação existente

Esta proposta está **preparada, não executada**. A aprovação abrange uma sessão temporária de até cinco minutos, a leitura dos hashes e uma execução do envio/replay para o endereço indicado, seguida do encerramento e evidências. Zero deploys, SQL, alterações de env, cron, cobrança, dados da Kidmais Festas ou produção.

A autorização anterior se limitou à inspeção e foi concluída. A política [OPERACAO_AGENTES.md](OPERACAO_AGENTES.md) exige aprovação explícita para infraestrutura de staging; a [documentação Render](https://render.com/docs/ssh#cron-job-connections) descreve a instância temporária do Shell. A permissão de inspecionar não autoriza este envio real. O teste anterior previa parar após falha e não autorizava nova janela.

Nenhuma alteração de código nesta proposta. O script já tem sete testes específicos e 34 testes pertinentes aprovados, além de lint/TypeScript/build anteriores; sua identidade foi conferida no artefato Node 22.23.2. Esta etapa requer somente revisão documental e git diff --check; nenhum teste real ou provider foi chamado ao preparar o plano.

## Execução autorizada

Felipe aprovou em 09/10: Pode. autorizo. goal até o último objetivo. Shell aberto aproximadamente 02:30:48 UTC de 10/10, limite 02:35:48. Hashes, Node e revisão conferidos. Janela única fixada ANTES do envio: 2026-10-10T02:31:00.000Z a 2026-10-10T02:35:00.000Z. Nenhuma repetição com nova janela autorizada.

Resultado: ACEITO_REPLAY_MESMO_ID, duas requisições imediatas, um único e-mail. Felipe confirmou o recebimento nesta conversa. Sem consulta ao banco, sem alterações de cobrança, aviso persistido/tela não homologados e renovação remota não habilitada. Captura sanitizada: evidencias/aviso-email-shell-staging-resultado-20261009.png. Exit enviado e aba fechada; lista de abas vazia às aproximadamente 02:32 UTC, dentro do limite. Não há confirmação de desprovisionamento pela API. Cron normal preservado, último sucesso consultado 02:35:16 UTC; deploy LIVE continua dep-db4oot2jnfac738028ug. Zero deploys realizados nesta execução.
