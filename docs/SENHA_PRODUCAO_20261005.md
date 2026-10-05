# Senha em produção — candidata isolada

Solicitação de Felipe: oferecer “Esqueci minha senha” no login e “Meu perfil e senha” para quem já está conectado. Resend escolhido em 05/10/2026; remetente e configuração ainda pendentes. Felipe autorizou o deploy desta atualização em 05/10/2026. A publicação libera a troca autenticada e os links; recuperação pública permanece desativada por padrão, sem alteração de env ou schema.

Base: production b8e38d37947a04db1ea7bfec32b6d644872d3b4a. Esta candidata reaproveita os serviços de senha de staging sem promover o painel de desenvolvedor, seleção multiempresa ou alterações de agenda/contratos. O login continua abrindo Dashboard.

## Comportamento

- Login: link para solicitar recuperação por e-mail. Pedido e redefinição exigem `RECUPERACAO_SENHA_ATIVA=true` e envio configurado; sem isso retornam 503 sem processar pedidos ou consultar a existência da conta. A ativação não é feita por este deploy.
- Perfil: senha atual, senha nova e confirmação. A operação encerra as sessões abertas da conta, emite uma nova para este navegador e confirma o CSRF emitido antes de mostrar sucesso. Não depende da coluna de seleção de empresa da migration 063.
- Recuperação: resposta pública neutra, limites por IP e e-mail, token com hash persistido, validade de 30 minutos, uso único e revogação das sessões após redefinição. O token chega no fragmento do link; não é enviado na URL ao servidor.
- Páginas de acesso: noindex. Nenhuma alteração automática de infraestrutura, configuração ou banco.

## Condições antes de liberar recuperação

1. Confirmar remetente verificado no Resend. Configurar `EMAIL_PROVIDER=resend`, `EMAIL_REMETENTE` e `RESEND_API_KEY` pelo meio seguro do Render. Nunca enviar a chave na conversa ou versioná-la. Usar a origem administrativa de produção nos links.
2. Confirmar, com autorização para leitura de schema, se produção já possui `recuperacoes_senha` e suas constraints, índices e triggers. A health HTTP não comprova esse schema.
3. Se a tabela não existir, preparar e revisar uma instalação exclusiva dos objetos de recuperação; homologar em banco descartável autorizado. Não aplicar a migration 063 completa por conveniência: ela também altera empresas, memberships e seleção de sessão.
4. Integrar essa instalação com a migration 063 de staging antes de uma futura promoção, evitando criação duplicada ou marcação falsa da 063 como aplicada. Nenhum SQL foi executado nesta preparação.
5. Validar entrega e link com uma conta sintética em homologação e aprovação para o envio. Produção nunca serve de banco de teste.
6. Depois de homologar todas as condições, obter autorização específica para configuração, eventual instalação do schema e ativação com `RECUPERACAO_SENHA_ATIVA=true`. O merge/deploy do código com recuperação pública desativada já foi autorizado; essa autorização não inclui env ou SQL.

## Recuperação operacional

Código anterior: commit b8e38d3 em produção. Reverter o código não restaura senhas nem sessões alteradas após uma troca legítima. Não excluir pedidos de recuperação ou restaurar dados como parte de rollback de código.

## Validação local

1853 testes unitários e 103 testes do harness com mocks passaram na candidata final. A suíte específica de senha e bloqueio de ativação passou (18 testes). TypeScript passou; ESLint tem somente o aviso preexistente de `FinalidadeSkill` em `lib/inteligencia/skills/catalogo.ts`. Build passou com acesso à rede para fontes do Next.js. Sem banco real, envio de e-mail ou carregamento de `.env.local`.

Deploy de código autorizado, com recuperação pública desativada. A troca autenticada usa as tabelas existentes; não exige a 063. Entrega de e-mail e schema remoto de recuperação continuam pendentes e são condições para a ativação posterior, não para publicar a troca autenticada.
