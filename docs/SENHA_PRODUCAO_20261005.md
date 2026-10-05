# Senha em produção — candidata isolada

Solicitação de Felipe: oferecer “Esqueci minha senha” no login e “Meu perfil e senha” para quem já está conectado. Resend escolhido em 05/10/2026; remetente e configuração ainda pendentes.

Base: production b8e38d37947a04db1ea7bfec32b6d644872d3b4a. Esta candidata reaproveita os serviços de senha de staging sem promover o painel de desenvolvedor, seleção multiempresa ou alterações de agenda/contratos. O login continua abrindo Dashboard.

## Comportamento

- Login: link para solicitar recuperação por e-mail. Se o envio não estiver configurado, resposta 503 sem anunciar envio e sem consultar a existência da conta.
- Perfil: senha atual, senha nova e confirmação. A operação encerra as sessões abertas da conta, emite uma nova para este navegador e confirma o CSRF emitido antes de mostrar sucesso. Não depende da coluna de seleção de empresa da migration 063.
- Recuperação: resposta pública neutra, limites por IP e e-mail, token com hash persistido, validade de 30 minutos, uso único e revogação das sessões após redefinição. O token chega no fragmento do link; não é enviado na URL ao servidor.
- Páginas de acesso: noindex. Nenhuma alteração automática de infraestrutura, configuração ou banco.

## Condições antes de liberar recuperação

1. Confirmar remetente verificado no Resend. Configurar `EMAIL_PROVIDER=resend`, `EMAIL_REMETENTE` e `RESEND_API_KEY` pelo meio seguro do Render. Nunca enviar a chave na conversa ou versioná-la. Usar a origem administrativa de produção nos links.
2. Confirmar, com autorização para leitura de schema, se produção já possui `recuperacoes_senha` e suas constraints, índices e triggers. A health HTTP não comprova esse schema.
3. Se a tabela não existir, preparar e revisar uma instalação exclusiva dos objetos de recuperação; homologar em banco descartável autorizado. Não aplicar a migration 063 completa por conveniência: ela também altera empresas, memberships e seleção de sessão.
4. Integrar essa instalação com a migration 063 de staging antes de uma futura promoção, evitando criação duplicada ou marcação falsa da 063 como aplicada. Nenhum SQL foi executado nesta preparação.
5. Validar entrega e link com uma conta sintética em homologação e aprovação para o envio. Produção nunca serve de banco de teste.
6. Obter autorização específica para configuração, eventual instalação do schema, merge e deploy desta nova mudança. A autorização anterior foi para o PR 97, já concluído.

## Recuperação operacional

Código anterior: commit b8e38d3 em produção. Reverter o código não restaura senhas nem sessões alteradas após uma troca legítima. Não excluir pedidos de recuperação ou restaurar dados como parte de rollback de código.

## Validação local

1851 testes unitários e 103 testes do harness com mocks passaram. A suíte específica de senha passou (16 testes) e o teste adicional da rota sem e-mail configurado passou. TypeScript passou; ESLint tem somente o aviso preexistente de `FinalidadeSkill` em `lib/inteligencia/skills/catalogo.ts`. Build passou com acesso à rede para fontes do Next.js. Sem banco real, envio de e-mail ou carregamento de `.env.local`.

Candidata em rascunho; ainda não homologada a entrega de e-mail nem instalado/verificado o schema remoto. Não fazer merge/deploy antes dessas condições.
