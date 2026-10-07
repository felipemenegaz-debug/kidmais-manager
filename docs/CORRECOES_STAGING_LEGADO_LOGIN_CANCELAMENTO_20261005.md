# Correções para homologação em staging

Base: `staging` em `128509e26e597e7cbcf36d73dd9395ceea947aca`. Produção não recebe estas alterações.

- Login: botão pequeno Mostrar/Ocultar, com nome acessível e sem enviar o formulário.
- Contratos: cancelamento antes da assinatura fica visível. Contrato com Festa oferece o caminho para cancelar na Festa; a Festa apresenta o botão fora de Mais ações e exige confirmação após o motivo. As regras de permissão, atividade registrada e preservação financeira continuam no servidor.
- Agenda: bloqueios antigos sem empresa continuam protegidos contra desativação por usuários de uma empresa. A conta com concessão ativa de desenvolvedor da plataforma pode atribuir e desativar um bloqueio individual, com empresa comprovada, unidade habilitada, motivo e confirmação. Exige autenticação há no máximo cinco minutos. O registro físico é preservado inativo e a decisão fica em `agenda_062_bloqueios_resolucao`, com identidade, motivo e horário. Não há atribuição automática ou em massa.

## Limites de homologação

O fluxo legado usa o schema 062 já previsto e a autoridade 063. Sem a 063, a tela continua funcionando, mas a ação especial não aparece. Nenhuma migration, concessão, SQL operacional ou configuração de ambiente foi executada. A disponibilidade da concessão na conta de Felipe e a propriedade das datas relatadas ainda precisam de conferência autorizada em staging. Uma resolução anterior conflitante é recusada para revisão pela plataforma.

Um bloqueio global é uma pendência de propriedade e afeta todas as empresas; a decisão de atribuição exige conferir a origem antes de confirmar. Reservas de contratos permanecem na agenda. Desativar um bloqueio não cancela contratos nem garante disponibilidade se houver outra ocupação.

Validar em staging, com dados de homologação autorizados: login e Mostrar/Ocultar; cancelar contratação não assinada com recusa/aceite da confirmação; caminho de cancelamento da Festa; resolução de um bloqueio antigo conhecido, importação na data liberada e manutenção das demais ocupações. Não usar banco de produção para essa regressão.

Preparação local: testes com mocks, lint, TypeScript e build. Publicação deve seguir PR para staging, merge e deploy manual autorizado, seguida de homologação. Promoção para produção exige autorização separada.
