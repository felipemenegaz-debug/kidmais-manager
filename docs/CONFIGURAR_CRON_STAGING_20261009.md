# Habilitação pendente da reconciliação

Serviço já criado: [kidmais-assinatura-reconciliar-staging](https://dashboard.render.com/cron/crn-db493i142hec73ahmoe0/env). Está em aguardando e não conecta ao banco.

## Credencial a preparar

Criar uma chave **Asaas sandbox exclusiva deste cron**, com nome sugerido **Kidmais Manager — reconciliação staging**. Inserir diretamente no campo ASAAS_API_KEY do ambiente do cron no Render; não colar em conversa, arquivo versionado ou log. A chave dos ensaios locais não deve ser reutilizada por inferência.

## Configuração ainda necessária antes de habilitar

- KIDMAIS_RECONCILIAR_DATABASE_URL: conexão do banco kidmais_staging_1z91 no host privado dpg-daidko3m8hqs73ce4jt0-a, porta 5432. Conferir identidade antes de conectar.
- ASAAS_WEBHOOK_TOKEN: token exclusivo compatível com o validador (32–255 caracteres ASCII imprimíveis). O cron não expõe endpoint de webhook.
- KIDMAIS_RECONCILIAR_CA_PEM: se necessário para o certificado privado Render. Verificar certificado e hostname, mantendo rejectUnauthorized:true; não desabilitar a validação para fazer o teste passar.

Depois: validar conexão TLS e acesso somente ao sandbox, rodada simular, rodada aplicar e segunda rodada sem duplicações. Testar aviso deliberado de falha conforme plano autorizado, restaurar o modo e confirmar recebimento do e-mail por Felipe. A autorização do cron já foi recebida; não solicitar novamente para estes mesmos passos e alvo.

Não ativar aplicar apenas porque as execuções aguardando terminaram com sucesso. Elas não processam pagamentos.

## Verificação das credenciais em 09/10, 07:42 UTC

Felipe informou ter criado a chave identificada como `kidmais-staging-etapa3-20261008`, com expiração sugerida em 07/01/2027 às 23:59 (Brasília). O nome e a expiração não comprovam o ambiente da chave.

Os nomes ASAAS_API_KEY, ASAAS_WEBHOOK_TOKEN e KIDMAIS_RECONCILIAR_DATABASE_URL apareceram salvos no painel, com valores ocultos. Nenhum valor foi revelado. Rodada manual em modo simular, após build dep-db49l8rncjis73c9v1m0 (commit 88fee4b), foi recusada às 07:42:19 UTC: `ASAAS_API_KEY não é uma chave de sandbox: cobrança desligada.` O validador recusou o formato antes de conectar ao banco ou chamar o provedor; isso não comprova que seja chave de produção, pois espaços internos, cópia incompleta ou comprimento também podem causar recusa. Modo devolvido a aguardando; atualização iniciou build separado para restaurar o estado.

Próximo passo: Felipe conferir a chave na conta sandbox e substituir diretamente no painel do cron, incluindo o prefixo `$aact_hmlg_`, sem aspas ou espaços. Referência: [autenticação Asaas](https://docs.asaas.com/docs/autentica%C3%A7%C3%A3o-1). Não enviar chave na conversa. Conexão TLS, simulação concluída, aplicar e entrega do alerta continuam pendentes.

A documentação atual do Render esclarece que a conexão interna usa certificados autoassinados e não suporta verify-ca/verify-full: [conexões Postgres](https://render.com/docs/postgresql-creating-connecting#ssl-modes-for-internal-connections). A configuração atual exige verificação de certificado; a compatibilidade ainda não foi testada porque a chave foi recusada primeiro. Não desabilitar a verificação por inferência. Qualquer mudança desse requisito deverá ter plano e autorização específica.

Após a correção informada por Felipe, a rodada de 07:46:09 UTC passou na validação de formato da chave/token e parou no handshake com `self-signed certificate`, sem consultas/gravações. Modo aguardando restaurado e build de recuperação live às 07:47:15 UTC. Ajuste local validado, não publicado: [plano de TLS do cron](TLS_CRON_STAGING_20261009.md). Autenticação no Asaas, simulação completa e aplicar ainda pendentes.
