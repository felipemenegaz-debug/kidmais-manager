# E1 — Gestão convida; conta existente só entra por aceite

Primeira entrega do plano de venda por assinatura ([PROPOSTA_VENDA_ASSINATURA_20261006.md](PROPOSTA_VENDA_ASSINATURA_20261006.md), §8).

## Problema

`criarUsuarioAdministrativo` (`lib/autenticacao/usuarios.ts`) deixa a Gestão de uma empresa:

- vincular à própria empresa a conta já existente de qualquer e-mail, sem aceite da pessoa;
- criar a conta de um e-mail ainda não cadastrado com uma senha escolhida pela Gestão.

Com cadastro público, qualquer pessoa vira Gestão da própria empresa e poderia ocupar o e-mail de outra.

## O que muda

- **Convite pela Gestão** (`lib/acessos/convites-empresa.ts`): reaproveita o convite da 063 (`convites_acesso`, token em hash, 7 dias, uso único, reenvio invalida o anterior). A autoridade é a Gestão **da empresa comprovada** (`executarNoTenant` + `papelAtual`), nunca a concessão de desenvolvedor; o `empresaId` não vem do corpo. Quem já tem conta aceita com a própria senha; conta nova define a senha no aceite (`/acesso/convite`).
- **Rota** `app/api/admin/configuracoes/usuarios`: ações `convidar`, `reenviar-convite`, `cancelar-convite`; o GET devolve `convites` (ou `null` sem a 063, sem derrubar a lista de pessoas) e `criacaoDireta`.
- **Tela** `components/festas/FestaAcessos.tsx`: "Adicionar pessoa" abre em **Convidar por e-mail**; "Definir senha agora" só aparece enquanto a criação direta estiver permitida. Nova seção **Convites pendentes** com Reenviar e Cancelar. Falha de envio aparece como "convite criado, mas o e-mail não foi enviado".
- **Criação direta atrás de configuração**: `USUARIOS_CRIACAO_DIRETA=desativada` recusa a ação `criar` com 403 `CRIACAO_DIRETA_DESATIVADA`, antes de calcular hash ou abrir transação.

## Por que a criação direta continua ligada por padrão

O envio de e-mail está desligado (`EMAIL_PROVIDER=desativado`, decisão D1 pendente). Sem e-mail, convite não chega e a Gestão ficaria sem como adicionar a equipe. Ordem para desligar:

1. configurar e validar o envio real (D1);
2. definir `USUARIOS_CRIACAO_DIRETA=desativada` no ambiente;
3. só então ligar o cadastro público (E6), que deve recusar subir com a criação direta permitida.

## Auditoria

`CONVITE_CRIADO`, `CONVITE_RENOVADO`, `CONVITE_CANCELADO`, `CONVITE_ENVIADO` / `CONVITE_ENVIO_FALHOU`, origem `ADMIN_USUARIOS`, com `empresaId`. Nunca token, link ou e-mail completo (o destino do envio vai mascarado).

## Validação

- `lib/acessos/convites-empresa.test.ts` (7 casos, sem banco): Equipe recusada antes de gravar; empresa só a comprovada (corpo com `empresaId` recusado); só o hash do token no banco; nada de token na resposta ou auditoria; falha de envio registrada; vínculo existente recusado sem revelar se o e-mail tem conta; cancelar/reenviar filtrados pela empresa comprovada; criação direta desativada recusa antes de hash e transação.
- `components/festas/FestaAcessos.test.ts` atualizado.
- `npm run check:v1:static`: testes, lint, TypeScript e build aprovados (06/10/2026).
- **Não executado**: teste PostgreSQL (exige autorização para o cluster descartável) e verificação visual da tela.

## Dependências e rollback

- Sem migration: usa `convites_acesso` da 063. Em ambiente sem a 063 a tela continua listando pessoas e esconde convites; as ações de convite respondem 503.
- Rollback: reverter o código. Convites criados pela Gestão permanecem válidos e continuam administráveis pelo painel do desenvolvedor.
