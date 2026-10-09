# Ajuste TLS do cron — autorizado em 09/10/2026

Felipe respondeu `autorizo` ao plano de publicar e ativar a exceção TLS restrita a este cron/banco de homologação. Autorização não abrange produção nem mudanças de rede. Execução e evidências serão registradas abaixo após verificação.

## Diagnóstico confirmado

Em 09/10/2026 às 07:46:09 UTC, a nova simulação do cron `crn-db493i142hec73ahmoe0` parou com `self-signed certificate`. A chave e o token passaram no validador local de formato; autenticação no Asaas ainda não foi testada. A conexão foi recusada no handshake TLS, antes das consultas e da reconciliação. Build `dep-db49muss728c73a2pbgg`, commit `88fee4b`. Modo restaurado para `aguardando`.

O [Render documenta](https://render.com/docs/postgresql-creating-connecting#ssl-modes-for-internal-connections) que seu Postgres interno usa certificado autoassinado e não suporta verify-ca/verify-full. Exige-se uma decisão operacional diferente do plano anterior, que previa certificado e hostname verificados.

## Mudança local preparada

`scripts/assinatura-reconciliar.cjs` mantém verificação de certificado por padrão. Acrescenta opt-in `KIDMAIS_RECONCILIAR_TLS=render-interno-criptografado`, recusado fora de:

- plataforma Render (`RENDER=true`) e serviço `crn-db493i142hec73ahmoe0`;
- ambiente staging, Asaas sandbox;
- banco `kidmais_staging_1z91`, host privado `dpg-daidko3m8hqs73ce4jt0-a`, porta 5432 e confirmação literal correspondente.

Nesse único escopo, a conexão exige TLS 1.2 ou superior, mas não verifica a assinatura/hostname do certificado autoassinado. A identidade de rede depende da rede privada do Render; autenticação PostgreSQL e confirmação de current_database/pg_stat_ssl permanecem. Isso reduz a autenticação TLS do servidor e precisa de autorização explícita. Não altera HTTPS do Asaas, variáveis globais de TLS, rede/allowlist, serviço web ou produção. Parâmetros SSL da URL são removidos para não sobrescrever a política explícita do cliente.

## Operação proposta para aprovação

1. Revisar e publicar somente os arquivos pertinentes em staging, incorporando previamente entregas concorrentes e revalidando auto-deploy. Validar a candidata completa antes de publicação se houver novos commits.
2. Publicar o código somente no cron existente, que continua em aguardando, identificando o commit e passando os cinco testes do lançador/ciclo/TLS no build remoto.
3. Configurar somente nesse cron `KIDMAIS_RECONCILIAR_TLS=render-interno-criptografado`. A alteração de env pode gerar rebuild do cron; acompanhar sem deploy duplicado.
4. Simular; conferir TLS ativo, banco exato e relatório sem gravação. Somente com sucesso, aplicar e verificar duas rodadas sem duplicações, conforme plano já aprovado.
5. Testar/confirmar entrega do alerta de falha e restaurar estado operacional.

Recuperação: retornar `KIDMAIS_RECONCILIAR_MODO=aguardando` e `KIDMAIS_RECONCILIAR_TLS=verificado`; não fazer rollback destrutivo nem alterar o banco. Nenhuma assinatura foi gravada nas tentativas recusadas.

## Validações locais

Cinco testes aprovados: guardas de ambiente/alvo, rollback por item, bloqueio de parâmetros SSL da URL e recusa do opt-in em outros serviços/bancos/portas/ambientes. ESLint dos arquivos alterados, TypeScript e build isolado sem credenciais aprovados. Log local ignorado `.local-cron-tls-build.log`. Nenhuma mudança local deste ajuste foi publicada ou ativada no Render.

Restauração para aguardando concluída: deploy `dep-db49noflot8c738abh5g` live às 07:47:15 UTC, ainda commit 88fee4b.

A exigência de aprovação vem de [OPERACAO_AGENTES.md](OPERACAO_AGENTES.md): alterações operacionais de env e segredo exigem aprovação explícita. A autorização anterior não abrangia reduzir a verificação de certificado. A política do navegador também exige confirmação no momento de reduzir proteções de segurança, caso a ativação seja feita pela UI.
