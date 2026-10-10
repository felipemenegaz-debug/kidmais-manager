# Aviso Fundador — teste do transporte preparado

A configuração do cron passou no [diagnóstico offline](CONFIGURACAO_EMAIL_CRON_STAGING_20261009.md). O executor `assinatura-renovar.cjs --aplicar` continua restrito a banco local isolado e e-mail em arquivo. Esta etapa prepara o teste HTTP real do modelo do aviso pelo Resend, sem habilitar esse executor. O registro na tela e a renovação no Asaas exigem um ensaio posterior com fixture persistida e autorização própria de SQL; este teste não comprova esses comportamentos.

## Resultado concreto preparado

Script [assinatura-aviso-email-staging.cjs](../scripts/assinatura-aviso-email-staging.cjs), com sete testes novos. Só aceita cron `crn-db493i142hec73ahmoe0`, staging, Asaas em sandbox, remetente `Kidmais Manager — Teste <onboarding@resend.dev>`, origem staging e destinatário fixo `felipemenegaz@gmail.com`. Não importa pg, não conecta ao banco nem instancia o cliente Asaas. Usa a função real `mensagemRenovacao` e o adapter real Resend. Dados sintéticos: plano essencial mensal, R$ 118,20 → R$ 197,00, vencimento 30 dias de calendário depois do início da janela em America/Sao_Paulo.

Assunto: `[TESTE] Kidmais Manager: renovação após o benefício Fundador`.

O primeiro parágrafo destaca: “TESTE com dados sintéticos. Não é uma cobrança ou alteração da assinatura da Kidmais Festas.” O restante informa data, preços, acesso à assinatura e cancelamento antes do vencimento, preservando o período pago. O link aponta para `https://kidmais-manager-staging.onrender.com/admin/assinatura`; não contém token nem dados privados.

O script faz dois POSTs imediatos com a mesma mensagem e Idempotency-Key, exigindo o mesmo identificador nas duas respostas. Isso testa a deduplicação do provedor, não o repository ou a concorrência de empresas. A [documentação Resend](https://resend.com/docs/dashboard/emails/idempotency-keys) informa retenção de 24 horas. A janela fixa deste ensaio tem no máximo quatro minutos: o payload e a chave são derivados do início fixo, nunca do horário da repetição. Fora da janela, retorna FORA_JANELA_SEM_ENVIO sem rede. Não há retry automático após resposta incerta, nem envio sem argumentos. Sem arquivo persistente no cron.

## Operação proposta — ainda não autorizada nem executada

1. Alvo único: workspace `tea-daidbj95efls73d2bcf0`, cron de staging acima. Revalidar candidata staging, auto-deploy OFF, comando normal e configuração. Preservar schedule `*/5 * * * *`, env, secrets, TLS, Starter e teto mensal de builds US$ 10. Nenhum acesso a produção.
2. Salvar temporariamente o comando abaixo com janela UTC absoluta. Após aprovação, escolher o próximo tick de cinco minutos que permita tempo de build (pelo menos dez minutos à frente). O fim será início + quatro minutos. Registrar os dois instantes antes de salvar; não deslocar a janela para tentar novamente se expirar. Publicar uma vez, sem push entre este deploy e o de recuperação.

```text
node --experimental-strip-types scripts/assinatura-aviso-email-staging.cjs --enviar-teste --inicio=INICIO_UTC_ISO --fim=FIM_UTC_ISO
```

3. Esperar o tick agendado, sem Trigger Run. No máximo dois requests previstos, para um único e-mail deduplicado. Resultado esperado: ACEITO_REPLAY_MESMO_ID, requisicoes=2, bancoConsultado=false, cobrancasAlteradas=0, entregaNaCaixa=AGUARDA_CONFIRMACAO. Não imprimir a chave, o body, a resposta ou o identificador do provedor. Em recusa, timeout, divergência ou janela expirada, registrar o impedimento e restaurar; não criar outra chave de idempotência ou nova janela sem aprovação.
4. Sempre restaurar `node scripts/assinatura-cron.cjs`, com um único deploy de recuperação e confirmação de execução normal. Dois deploys no total, sem aumento de limite/infraestrutura ou alterações de variáveis. Se o teto de builds bloquear, salvar o comando normal e informar; não repetir builds indefinidamente.
5. Salvar evidências sanitizadas e pedir a Felipe confirmação do recebimento, depois da recuperação. Aceitação pelo Resend não prova entrega na caixa postal. Não declarar renovação integral homologada nem aviso na tela validado.

A aprovação solicitada abrange somente o comando temporário, os dois deploys, o envio/replay do e-mail sintético para o endereço autorizado e a recuperação/evidências. Não abrange SQL, mudanças de cobrança, dados da Kidmais Festas, configuração de acesso, outras empresas ou produção.

## Validação local concluída

34 testes aprovados (sete novos + 27 de renovação/adapters/preflight), ESLint dos dois scripts sem erros/avisos, TypeScript e build aprovados no diretório isolado `.local-release-check`, sem arquivos `.env`. Nenhuma chamada externa nos testes; fetch inteiramente mockado. Build inicialmente recusado pelo compilador no sandbox Windows (canonicalização/acesso negado), repetido fora desse bloqueio e aprovado. Node local 24; execução Render deve continuar no runtime declarado 22.23.2. Log local `.local-aviso-email-build.log`, sem credenciais.

A política [OPERACAO_AGENTES.md](OPERACAO_AGENTES.md) exige aprovação explícita para mudanças operacionais e determina preparar alvo, efeitos, validações e recuperação antes da escrita. A autorização anterior se limitou à configuração e ao diagnóstico offline; envio real e novos deploys são um escopo novo.

## Autorização e janela desta execução

Felipe respondeu “pode” ao plano completo. Conferidos cron correto, staging/auto-deploy OFF, comando normal, schedule e candidata remota `27e072237442e2f249e1e93d85a74e62b6eb7695`. Às 00:48:47 UTC foi escolhida a janela **10/10/2026 01:00:00–01:04:00 UTC** (09/10, 22:00–22:04 em São Paulo), com mais de dez minutos para publicação. Nenhuma nova janela ou retry está autorizado nesta execução.

Comando exato do primeiro deploy:

```text
node --experimental-strip-types scripts/assinatura-aviso-email-staging.cjs --enviar-teste --inicio=2026-10-10T01:00:00.000Z --fim=2026-10-10T01:04:00.000Z
```

O e-mail sintético desta janela mostrará a primeira data de preço normal em **08/11/2026** (30 dias de calendário). Não representa vigência ou cobrança real. Este registro local é feito antes de salvar o comando e será publicado junto às evidências após a recuperação; não altera a candidata entre os dois deploys.

## Execução interrompida antes do envio

O deploy `dep-db4on7flot8c73cfam0g` publicou a candidata às 00:50:06 UTC. O build registra checkout da candidata às 00:49:41, Node 22.23.2 e build bem-sucedido às 00:50:05. A execução agendada registra início às 00:50:09 e novo comando às 00:50:25, porém falhou com `MODULE_NOT_FOUND` para `/opt/render/project/src/scripts/assinatura-aviso-email-staging.cjs`, terminando com exit 1 às 00:50:30.

O arquivo está presente no commit publicado, conferido localmente com git show. A causa da ausência no artefato usado pela execução permanece **não confirmada**. A coincidência com a troca de deploy não comprova que a execução usou a revisão anterior; o log de início é posterior ao instante LIVE. Não declarar esse diagnóstico como causa estabelecida nem pedir correção da chave Resend: o script sequer foi carregado e nenhuma chamada ao provedor foi iniciada por ele.

Conforme recuperação do plano, não foi aguardada outra tentativa de envio: o comando normal foi restaurado, conferido por metadados e o único deploy de recuperação `dep-db4oot2jnfac738028ug` foi iniciado às 00:53:08 UTC, na mesma candidata. A janela das 01:00 foi abandonada, sem substituição, envio manual ou novo deploy de teste. Sem mudanças em env, TLS, Asaas, banco, produção ou teto de builds. O teste real de aceitação/replay/entrega do aviso continua **PENDENTE**, assim como o aviso na tela.

## Recuperação concluída

O segundo deploy ficou LIVE às 00:53:40 UTC. A execução agendada das 00:55 usou `node scripts/assinatura-cron.cjs`, retornou APLICAR, SEM_MUDANCA=3 e incompleto=false às 00:55:24, terminando com sucesso às 00:55:30 UTC (09/10, 21:55:30 em São Paulo). Metadados confirmam lastSuccessfulRunAt, comando normal, schedule, Starter e staging/auto-deploy OFF. Exatamente dois deploys realizados, nenhuma nova janela ou tentativa de envio.

- [Erro anterior ao carregamento do script](evidencias/aviso-email-staging-falha-20261009.png).
- [Reconciliação normal recuperada](evidencias/aviso-email-staging-recuperado-20261009.png).
- [Relatório sanitizado](evidencias/aviso-email-staging-resultado-20261009.json).

Próxima investigação: conferir os arquivos e a identidade do artefato efetivamente usado pelo cron, antes de preparar outra janela de envio. Nenhum novo deploy de diagnóstico, alteração de buildCommand ou envio está autorizado por esta rodada. Não confundir o resultado local dos testes com homologação HTTP real. Evidências documentais revisadas com git diff --check; alterações preexistentes preservadas.
