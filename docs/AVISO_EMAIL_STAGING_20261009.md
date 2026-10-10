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
