# Sincronização de senha após o PR 99

O PR 99 foi preparado na branch de produção e publicado sem homologar a adaptação em staging primeiro. Felipe identificou o desvio do fluxo em 05/10/2026 e solicitou a sincronização. Produção permanece no commit publicado `51b1a68c7dc838817336b43b7d5883d2fa9d0a6a`; esta correção tem staging como alvo.

## Integração

Merge normal de production em uma candidata baseada em staging `5a948c0d2ed8af2cc03412e16b7f7f27248f4c89`. Manter o histórico do merge: não squashar. O ancestral comum evita reaplicar os commits do PR 99 em futuras promoções.

Staging já contém recuperação e troca de senha, além de seleção de empresa e painel de desenvolvedor. Foram preservados integralmente os arquivos de staging de login, shell, perfil de senha, serviço de senha, autenticação, testes existentes, tratamento de erros e configuração Next. A duplicação de helpers criada pelo merge textual em `lib/autenticacao/service.ts` foi removida preservando a implementação original de staging.

Entram apenas a exigência de ativação explícita da recuperação pública, suas duas rotas, os testes dessa exigência e o documento do PR 99. O código de troca de senha mantém a seleção de empresa e a confirmação de renovação de sessão de staging. O login mantém Dashboard e retorno seguro. Agenda e contratos não são modificados.

## Ambientes e ativação

As branches não precisam ser idênticas: staging possui funcionalidades ainda não promovidas. Sincronizar significa integrar a mudança compatível e o histórico, preservando essas funcionalidades. Não copiar todos os arquivos de produção sobre staging nem promover todo staging para produção por este pedido.

`RECUPERACAO_SENHA_ATIVA=true` exige a configuração do Resend, estrutura de recuperação instalada e entrega homologada. Nenhuma env, SQL, migration ou infraestrutura é alterada nesta sincronização. Deploy de staging deve ser identificado e acompanhado separadamente; não redeployar produção.

## Fluxo das próximas alterações

Preparar primeiro a candidata de staging, homologar testes e interface nesse ambiente e depois promover somente a mudança aprovada para production. Diferenças necessárias entre os ambientes devem ser resolvidas na candidata de staging antes da publicação em produção.
