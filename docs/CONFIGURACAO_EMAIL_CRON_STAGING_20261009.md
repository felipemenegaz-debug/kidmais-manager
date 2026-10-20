# E-mail e origem do cron staging — plano autorizado e validação

Objetivo: resolver as pendências RESEND_NAO_CONFIGURADO e ORIGEM_STAGING_DIVERGENTE encontradas no diagnóstico publicado. Somente workspace `tea-daidbj95efls73d2bcf0`, cron `crn-db493i142hec73ahmoe0` (kidmais-assinatura-reconciliar-staging). Nenhum acesso ou alteração em produção.

Conferência pelo painel, apenas nomes e valores mascarados: o cron tem 11 variáveis próprias e não tem EMAIL_PROVIDER, EMAIL_REMETENTE, RESEND_API_KEY ou ADMIN_AUTH_ORIGIN. Não foram lidos secrets. O remetente do teste local que Felipe confirmou ter recebido foi explicitamente `Kidmais Manager — Teste <onboarding@resend.dev>` no script `assinatura-sandbox-conexao.cjs`; não usar o Gmail como remetente.

## Configuração exata proposta

| Nome | Valor |
| --- | --- |
| EMAIL_PROVIDER | resend |
| EMAIL_REMETENTE | Kidmais Manager — Teste <onboarding@resend.dev> |
| ADMIN_AUTH_ORIGIN | https://kidmais-manager-staging.onrender.com |
| RESEND_API_KEY | Chave de teste existente, informada por Felipe diretamente no painel do Render; nunca no chat |

O agente configura apenas os três valores não secretos. Felipe insere e salva a chave diretamente no campo do cron. Não recuperar/copiar segredo de outro serviço, abrir `.env.local`, criar chave nova ou ampliar suas permissões. Se Felipe não tiver o valor disponível, aguardar a entrada segura; não pedir que o envie na conversa.

## Execução proposta

1. Após aprovação, revalidar identidade, branch staging/auto-deploy OFF e comando/schedule normais. No Environment, acrescentar somente os quatro campos acima, preservando Asaas, banco, TLS e demais variáveis. Usar Save only e conferir a entrada da chave apenas por presença/formato no diagnóstico. Não revelar/registrar valores em capturas ou relatórios.
2. Após Felipe concluir a entrada segura, salvar o comando temporário `node --experimental-strip-types scripts/assinatura-renovacao-preflight.cjs`, **sem** `--consultar-schema`. Publicar a revisão de staging que contém o diagnóstico, com um deploy manual; não disparar deploy adicional pela alteração de env. A validação é offline: nenhuma conexão SQL ou chamada ao Asaas/Resend, e-mail ou mudança de cobrança. A conferência anterior de schema continua como evidência própria.
3. Esperar uma execução agendada. Esperado: PREPARACAO_CONFERIDA, bloqueios vazios, bancoConsultado=false, provedoresChamados=false, emailsEnviados=0 e cobrancasAlteradas=0. Presença/formato não comprova autenticação nem entrega. Se faltar/estiver inválida a configuração, registrar PENDENTE sem repetir envio ou alterar credenciais.
4. Restaurar `node scripts/assinatura-cron.cjs`, com um deploy de recuperação, e conferir execução agendada normal sem falhas. São dois deploys planejados, dentro do teto mensal de builds US$ 10 já autorizado; manter Starter e não ampliar teto. Não usar Trigger Run para interromper uma execução existente.
5. Em sucesso, manter as quatro configurações no cron de staging e guardar evidências sanitizadas. Em falha da alteração, restaurar o comando normal e remover somente os quatro campos novos, voltando à ausência original; nenhuma remoção/revogação da chave no Resend. Se o build for bloqueado, restaurar configuração e registrar impedimento sem repetir builds enquanto a causa persistir.

Esta aprovação abrange a configuração e sua validação offline, os dois deploys e a recuperação. Não habilita o processador remoto de renovação, envio real, avisos a clientes, cobrança, SQL de negócio ou produção. O ensaio funcional de aviso de 30 dias requer preparação própria.

Validação já existente do diagnóstico: 27 testes, lint, TypeScript e build aprovados. Esta etapa adiciona somente este plano documental; não altera código. A política [OPERACAO_AGENTES.md](OPERACAO_AGENTES.md) determina: “Alterações de variáveis de ambiente, segredos, restart ou infraestrutura de staging exigem aprovação explícita.” A autorização anterior abrangia diagnóstico sem alteração de env.

## Autorização recebida e entrada segura pendente

Felipe respondeu “autorizo” ao plano completo. Revalidados cron correto, branch staging, auto-deploy OFF, comando normal e schedule preservados; última execução normal bem-sucedida às 00:20:21 UTC de 10/10 (21:20 de 09/10 em São Paulo). Os três valores não secretos foram incluídos e salvos com Save only. Nenhum deploy realizado nesta etapa.

O campo RESEND_API_KEY está preparado no formulário, com valor vazio, aguardando Felipe colar e salvar diretamente no Render. Nenhum secret lido, copiado ou inserido pelo agente. Não capturar screenshot nem imprimir o conteúdo do formulário após a entrada da chave; observar apenas nomes e estado salvo. A autorização para os dois deploys e a validação/restauração permanece vigente; prosseguir após Felipe informar que salvou. [Estado do painel antes da chave](evidencias/email-cron-staging-chave-handoff-20261009.png).

## Entrada concluída e diagnóstico aprovado

Felipe informou “salvo”. Após recarregar intencionalmente o Environment, foram conferidos somente os nomes dos quatro campos e o estado salvo (botão Edit). Nenhum valor de segredo foi lido ou capturado. Branch staging e auto-deploy OFF foram revalidados; candidata remota `1bae5525b78875a11cb262fb8d63176719740a5e`.

O deploy de diagnóstico `dep-db4odp7lot8c73cec2k0` ficou LIVE em 10/10/2026 às 00:29:58 UTC (09/10, 21:29:58 em São Paulo). A execução agendada retornou às 00:30:33 UTC:

```json
{"modo":"DIAGNOSTICO_OFFLINE","bloqueios":[],"bancoConsultado":false,"provedoresChamados":false,"emailsEnviados":0,"cobrancasAlteradas":0,"rotinaAplicacaoRemotaHabilitada":false,"resultado":"PREPARACAO_CONFERIDA"}
```

A execução terminou com sucesso às 00:30:40 UTC. A configuração requerida está presente, sem as duas pendências anteriores. Este diagnóstico não autentica a chave no Resend nem comprova entrega de e-mail. Não conectou ao banco, chamou provedores ou habilitou renovação remota. A evidência anterior de schema permanece separada, sem reclassificar seu resultado histórico PENDENTE.

[Comprovação no painel](evidencias/email-cron-staging-diagnostico-20261009.png).

O comando normal `node scripts/assinatura-cron.cjs` foi restaurado e conferido por metadados antes de iniciar o único deploy de recuperação `dep-db4oel0473hc738hppu0`, na mesma candidata, às 00:31:16 UTC. Nenhum push entre os dois deploys; nenhum Trigger Run utilizado. As quatro configurações são mantidas conforme o plano em sucesso. A conferência da próxima execução normal será registrada abaixo.

## Recuperação confirmada — etapa concluída

O deploy de recuperação ficou LIVE às 00:31:50 UTC. A execução agendada das 00:35 retornou APLICAR, SEM_MUDANCA=3 e incompleto=false às 00:35:20 UTC; terminou com sucesso às 00:35:28 UTC (09/10, 21:35:28 em São Paulo). O Render confirmou lastSuccessfulRunAt no mesmo instante, comando normal, schedule `*/5 * * * *`, Starter, branch staging e auto-deploy OFF preservados.

Foram realizados exatamente os dois deploys autorizados. Sem alterações no serviço web, produção, schema, credenciais Asaas, TLS, destinatários ou condições comerciais. Os dois deploys usam a candidata anterior ao commit destas evidências. O aviso real de 30 dias e a renovação no provedor continuam pendentes de ensaio funcional próprio; não estão habilitados por esta etapa.

- [Relatório sanitizado](evidencias/email-cron-staging-validacao-20261009.json).
- [Cron normal recuperado](evidencias/email-cron-staging-recuperado-20261009.png).

Validação documental: revisão das evidências, links e diff, com `git diff --check`. Nenhuma mudança de código nesta etapa; não foi necessário repetir testes de aplicação. As alterações preexistentes em tsconfig.json e capturas locais alheias foram preservadas.
