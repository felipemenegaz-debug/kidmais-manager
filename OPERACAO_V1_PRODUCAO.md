# Kidmais Manager V1 — operação, regressão e implantação

Atualizado em 11/09/2026. Este documento não autoriza nem executa alterações no banco real.

## Estado desta candidata

O código compila e lint, bateria unitária, TypeScript e build estão automatizados por `npm run check:v1:static`. A raiz pública redireciona para Disponibilidade, a rota pública antiga de Festa redireciona para a área administrativa, respostas recebem cabeçalhos básicos de segurança e `/api/health` só retorna HTTP 200 quando PostgreSQL, configuração oficial de OTP, flag Festa e assinatura física da 016 estão prontos.

A Migration 016 foi informada como aplicada e homologada no banco real pelo responsável do projeto. A candidata não repete a migration. A confirmação independente foi preparada como consulta protegida e somente de leitura; sua execução no banco real depende de aprovação explícita.

## Bloqueios de go-live

1. Concluir cadastro externo e homologar, em número real controlado, o template de autenticação da WhatsApp Cloud API. O emissor oficial já está implementado; `console`, SMS e e-mail são recusados na V1 de produção.
2. Executar a regressão integrada em clone anonimizado e a homologação de navegador em desktop e celular.
3. Escolher infraestrutura, domínio, TLS, monitoramento e política de backup/retenção.

Enquanto qualquer item acima estiver aberto, a decisão recomendada é **NO-GO**.

Decisão comercial fechada em 11/09/2026: o fechamento online da V1 permite somente Festa Essencial, Festa Completa e Festa Premium. Pocket, Mini Festa, Festa Compacta e Pizza Party continuam no catálogo interno, mas não aparecem nem podem ser enviados à API pública de fechamento.

Decisão de identidade fechada em 11/09/2026: fechamento e aceite do Contrato usam somente WhatsApp transacional pela Cloud API oficial da Meta. Não há automação de WhatsApp Web. SMS fica reservado a uma fase posterior e não é oferecido pelas rotas públicas da V1.

Decisão de disponibilidade fechada em 11/09/2026: foram removidas, com autorização explícita, a liberação do Pocket em 19/09/2026 à noite e o desconto de 20% do Premium em 23/09/2026 à noite. A candidata parte sem exceções comerciais pré-carregadas; futuras exceções devem ser cadastradas conscientemente pela área administrativa.

## Homologação do WhatsApp transacional

Antes do GO, o responsável pela conta Meta deve fornecer por cofre de segredos: versão ativa da Graph API, `Phone Number ID` e token permanente com permissão de envio. O template `kidmais_codigo_aceite` deve ser aprovado em `pt_BR`, na categoria de autenticação, com uma variável de corpo para o código de seis dígitos. Se o nome ou idioma aprovado for diferente, ajustar apenas as variáveis de ambiente.

Executar a homologação com um Cliente controlado e número real autorizado:

1. Confirmar que `/api/health` retorna 200 com a configuração completa, sem revelar valores.
2. Iniciar o desafio e conferir recebimento, remetente oficial, texto aprovado e expiração informada.
3. Confirmar que código incorreto reduz tentativas, código correto abre o fluxo e o mesmo código não pode ser reutilizado.
4. Repetir no fechamento e no aceite do Contrato.
5. Indisponibilizar temporariamente o provedor em ambiente de homologação e confirmar erro 503 sem token, telefone ou corpo da Meta nos logs/resposta pública.

O teste só é considerado aprovado com evidência do recebimento no aparelho e do aceite concluído. Uma resposta HTTP aceita pela Meta, isoladamente, não comprova entrega.

## Topologia mínima para a V1

- Uma instância Node.js/Next.js por vez. As regras comerciais são gravadas em `data/disponibilidade.json`; múltiplas instâncias podem divergir.
- Volume persistente e backup separado para `data/disponibilidade.json`.
- PostgreSQL em rede privada, TLS habilitado e usuário de runtime com menor privilégio possível.
- Proxy HTTPS com limite de requisições, limite de corpo, logs sem segredos e proteção adicional para login e endpoints de OTP. Limitar por IP e por janela também no provedor/borda; os limites de tentativas do código não substituem esse controle.
- Mesma origem HTTPS para área pública e administrativa, configurada exatamente em `ADMIN_AUTH_ORIGIN`.
- Monitoramento de `/api/health`; HTTP 503 deve retirar a instância do tráfego.

## Sequência de regressão

1. Instalar dependências com `npm ci`.
2. Executar `npm audit --omit=dev` e registrar o resultado.
3. Executar `npm run check:v1:static`.
4. Restaurar um backup anonimizado em clone isolado; nunca usar o banco real para testes mutantes.
5. Confirmar a Migration 016 no clone e executar as integrações existentes de Disponibilidade, Identidade, Contrato, Pagamentos e Festa.
6. Percorrer no navegador: Cliente → Disponibilidade → Fechamento → Contrato → assinatura/aceite → Pagamentos → Festa.
7. Cobrir edição pós-assinatura, remarcação, cancelamento, permissões, histórico, sessão expirada, concorrência e repetição de comandos.
8. Repetir os cenários críticos em desktop e celular, sem erros de console ou chamadas HTTP inesperadas.

## Backup e recuperação

Antes da implantação, exigir:

- backup completo PostgreSQL em formato restaurável, criptografado e fora do servidor da aplicação;
- cópia versionada de `data/disponibilidade.json`;
- retenção diária, semanal e mensal definida pelo responsável do negócio;
- teste de restauração em banco novo, seguido de consulta de integridade e smoke test;
- registro do tempo real de restauração e responsáveis pelo incidente.

O backup só é considerado válido depois de uma restauração testada. Nunca validar restauração sobre o banco real.

## Implantação e rollback da aplicação

1. Congelar mudanças comerciais durante a janela.
2. Gerar backup e validar sua conclusão.
3. Implantar a imagem/artefato imutável com as variáveis do `ENV_PRODUCAO_EXEMPLO.txt`.
4. Confirmar HTTPS, cabeçalhos, cookies `Secure`/`HttpOnly`, `ADMIN_AUTH_ORIGIN` e HTTP 200 em `/api/health`.
5. Fazer smoke test com contas e dados controlados; não alterar registros reais sem autorização operacional.
6. Liberar primeiro para a equipe, depois para um fechamento piloto acompanhado.
7. Em falha, retirar a candidata do tráfego e restaurar a versão anterior da aplicação. Não executar rollback da Migration 016: ela já possui dados potenciais e seu script recusa rollback nessas condições.

## Consulta protegida do banco real

Somente após autorização explícita, configurar `DATABASE_URL`, definir `KIDMAIS_AUTORIZAR_LEITURA_BANCO_REAL=SIM` e executar `npm run check:v1:producao:readonly`. O script exige o banco `kidmais_manager`, abre transação `READ ONLY`, impõe timeout e compara a assinatura física da 016. Ele não aplica migration, DDL, DML ou backfill.

## Critério final de GO

GO exige: OTP real aprovado; catálogo comercial decidido; candidata sem exceções comerciais indevidas; regressão estática e integrada verde; backup restaurado com sucesso; HTTPS e monitoramento ativos; homologação assinada pela Kidmais; piloto acompanhado concluído. Qualquer falha crítica reabre o gate e impede uso comercial.
