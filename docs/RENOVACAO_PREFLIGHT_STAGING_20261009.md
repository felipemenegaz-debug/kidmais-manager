# Preparação da renovação remota — diagnóstico para aprovação

A quinta rodada confirmou contratação/cancelamento mensal em staging; não confirmou renovação após 12 meses nem envio do aviso. Antes de habilitar essa rotina, conferir sua configuração e as guardas do schema no ambiente remoto.

## Entrega local concluída

`scripts/assinatura-renovacao-preflight.cjs` aceita somente o cron `crn-db493i142hec73ahmoe0`, ambiente staging, Asaas sandbox e conexão explicitamente confirmada a `kidmais_staging_1z91@dpg-daidko3m8hqs73ce4jt0-a:5432`. Reutiliza a política TLS já aprovada para esse cron; não a amplia nem modifica configurações globais.

Sem argumentos, confere apenas configuração offline, sem abrir conexão. Com `--consultar-schema`, conecta em transação READ ONLY, confirma nome do banco e TLS, consulta existência das tabelas 074/075 e os dois triggers habilitados da 075 nos catálogos PostgreSQL, e encerra com ROLLBACK. Não consulta registros de empresas, destinatários ou contratações. Não importa o processador de renovação, não chama Asaas/Resend, não envia e-mails e não altera preços. Nenhum modo de aplicação existe nesse diagnóstico.

Relatório distingue PREPARACAO_CONFERIDA de PENDENTE; configuração presente não significa autenticação válida ou entrega de e-mail. Schema estrutural não comprova constraints completas, conteúdo comercial, calendários, histórico ou processamento concorrente. Erros do CLI são sanitizados. O executável `assinatura-renovar.cjs --aplicar` continua limitado ao banco local isolado e e-mail em arquivo.

Validação local: 27/27 testes (seis novos de diagnóstico e 21 de renovação/adaptadores), ESLint sem erros/avisos, TypeScript e build Next.js aprovados em `.local-release-check`, sem arquivos `.env*`. Testes usam somente ambiente sintético e cliente PostgreSQL/fetch simulados. Node local 24, diferente da versão 22.23.2 declarada; a execução remota ainda não foi realizada. Avisos preexistentes de tipo de módulo e raiz inferida do workspace não impediram os checks.

## Plano remoto concreto — ainda não executado

Workspace `tea-daidbj95efls73d2bcf0`; somente cron staging `crn-db493i142hec73ahmoe0` e banco interno explicitado acima. Nenhuma ação em produção ou no banco local real.

1. Revalidar branch staging, auto-deploy OFF, comando normal `node scripts/assinatura-cron.cjs`, horário `*/5 * * * *` e ausência de execução em andamento. Código preparado deve estar publicado em staging; identificar a candidata antes do deploy.
2. Alterar temporariamente somente o comando do cron para `node --experimental-strip-types scripts/assinatura-renovacao-preflight.cjs --consultar-schema`; salvar e realizar um deploy manual. Preservar secrets, env, schedule, plano e TLS existentes. Durante essa janela, as novas execuções desse cron fazem o diagnóstico em vez da reconciliação normal. Uma execução anterior em andamento deve terminar; não usar Trigger Run para interrompê-la.
3. Esperar uma execução agendada, ler somente relatório sanitizado e status. Consulta de banco restrita a identidade/TLS e catálogos, sem dados de negócio. Campos ausentes de configuração são pendências: não inserir segredos nem alterar env sob esta autorização. Retorno PENDENTE/erro pode provocar o alerta de falha já configurado no Render.
4. Mesmo em falha, restaurar o comando normal e realizar um único deploy de recuperação; conferir LIVE e execução agendada normal, registrando logs sanitizados. Até dois deploys planejados, usando o teto mensal de builds US$ 10 já autorizado; não ampliar teto, plano ou criar serviço novo. Se houver impedimento financeiro/build, restaurar a configuração, registrar o bloqueio e não repetir builds sem resolver sua causa.
5. Guardar evidência sanitizada do diagnóstico e da recuperação, revisar e publicar documentação em staging. Resultado não habilita renovação remota, envio real, cobrança, isenção ou produção. O próximo ensaio de aviso e preço precisa de fixture, destinatário e ações próprios preparados e aprovados.

Solicita-se autorização específica para a troca temporária de comando, os dois deploys e essa leitura de catálogos. A política [OPERACAO_AGENTES.md](OPERACAO_AGENTES.md) exige aprovação explícita para configuração/deploy e exige banco dentro do escopo autorizado. A autorização da quinta rodada não abrangia essa nova operação.

## Execução autorizada — 09/10/2026

Felipe respondeu “autorizo” ao plano acima. Branch/auto-deploy/comando/schedule foram revalidados; última execução normal bem-sucedida às 21:40:20 UTC. Revisão local e remota confirmadas: `0b2dabfdf086fd6f80eb5bc0a841bd3d5d6c4d45`. Comando temporário salvo; deploy `dep-db4luu60tbcc73f6enrg` LIVE às 21:41:40 UTC. Relatório agendado e recuperação serão registrados abaixo após a confirmação.

Execução agendada às 21:45:27 UTC: banco/TLS conferidos e schema estrutural aprovado, com as tabelas presentes e duas guardas 075 habilitadas. Resultado PENDENTE por `RESEND_NAO_CONFIGURADO` e `ORIGEM_STAGING_DIVERGENTE`; processo encerrou com código 2. Esse retorno é intencional para impedir confundir pendências com integração concluída; pode gerar o alerta já configurado no Render. Nenhum provedor chamado, e-mail enviado, cobrança alterada ou aplicação remota habilitada. Nenhum secret/env modificado. [Registro sanitizado](evidencias/renovacao-preflight-staging-20261009.json) e [relatório no painel](evidencias/renovacao-preflight-staging-20261009.png).

Comando normal restaurado: `node scripts/assinatura-cron.cjs`. Deploy de recuperação `dep-db4m15om7kps73cbf65g` LIVE às 21:46:33 UTC, na mesma candidata. Restam configurar o Resend e a origem administrativa no cron sob autorização específica, antes do ensaio externo de avisos/renovação. A conferência estrutural deste diagnóstico não substitui esse ensaio funcional.

Recuperação funcional confirmada: relatório normal às 21:50:20 UTC, eventos vazios, três empresas SEM_MUDANCA e incompleto=false; execução terminou com sucesso às 21:50:30 UTC. Horário, plano, secrets, env e TLS preservados. Branch staging e auto-deploy OFF revalidados no cron e no web antes do push das evidências. [Prova no painel](evidencias/renovacao-preflight-cron-recuperado-20261009.png).
