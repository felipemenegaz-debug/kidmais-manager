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
