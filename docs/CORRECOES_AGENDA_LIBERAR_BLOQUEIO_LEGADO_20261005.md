# Agenda: liberar bloqueio anterior à separação por empresa

Base: `staging` em `d6a7cf6` (merge da PR #103). Production (`51b1a68`) está contida nessa base.

## Problema

No painel de Disponibilidade, o botão de desativar só aparecia em bloqueios criados depois da separação da agenda por
empresa e unidade (062). Os bloqueios antigos, sem `empresa_id`, só podiam ser desativados por conta com concessão de
desenvolvedor da plataforma (063) e autenticação recente; para a equipe da empresa não havia ação nenhuma.

## Regra adotada

Bloqueio de agenda nunca pertence a contrato: a ocupação de contrato fica em outra tabela e continua na agenda. Logo, todo
bloqueio físico pode ser liberado; o que se protege é só a propriedade do bloqueio antigo.

A própria empresa libera um bloqueio sem dono quando é a dona plausível:

- quem criou o bloqueio tem (ou teve) vínculo (`memberships`) com a empresa; ou
- não existe nenhuma outra empresa ATIVA ou SUSPENSA a quem o bloqueio possa pertencer.

Fora disso, a decisão continua com a plataforma (`resolver_bloqueio_legado`, inalterado).

## Efeito no banco

Mesma sequência da resolução pela plataforma: habilitação da unidade travada, data travada (`kidmais:agenda:<data>`),
decisão gravada em `agenda_062_bloqueios_resolucao` (empresa, unidade, quem decidiu, motivo), e o registro de
`bloqueios_agenda` recebe `empresa_id`/`estabelecimento_id` e passa a `ativo = false`. Nada é apagado. Uma resolução já
registrada para outra empresa é recusada (409) e fica para a plataforma.

## Interface

- Bloqueio antigo mostra o botão **Liberar horário**: pede o motivo (pré-preenchido), confirma e envia
  `desativar_bloqueio` com `motivo`.
- Bloqueios da empresa continuam com **Desativar**.
- A ação da plataforma continua disponível para a conta com concessão, como **Atribuir pela plataforma**.

## Verificação

`node --experimental-strip-types --test lib/disponibilidade/bloqueios-legados.test.ts lib/disponibilidade/escopo.test.ts`,
`npx tsc --noEmit`, `npm run lint`. Sem migration, sem SQL operacional, sem alteração de ambiente. Publicação segue PR
para `staging` e promoção para `production` com autorização separada.

# Contrato: cancelamento com revisão em andamento

## Problema

Cancelar um contrato que tem revisão em elaboração ou congelada falhava com "Operação recusada pelas proteções de
integridade". No PostgreSQL de staging a exceção real era "Ponteiro lógico diverge da vigência" (23514).

## Causa

O serviço encerrava a revisão aberta e cancelava o contrato na mesma transação. A regra de fluxo do contrato
(`kidmais_validar_fluxo_contrato`, 013, mantida na 057 e na 061) é um constraint trigger adiado para o commit e exige
contrato `ASSINADO` sempre que versão, edição ou fluxo são tocados; no commit o contrato já estava `CANCELADO`. A regra da
019 ("Cancelamento exige encerrar a preparação") exige o oposto no mesmo instante. Sem revisão aberta nada disso é
tocado e o cancelamento funciona.

## Correção (só código)

- `cancelarContratacaoDaFesta` recusa com 409 e mensagem clara quando há revisão em andamento: "Há uma revisão em
  andamento (Vn). Cancele a revisão antes de cancelar o contrato." Nenhuma escrita acontece.
- A tela do contrato ganha o botão **Cancelar revisão** na versão em preparação, usando a ação `cancelar_revisao` que o
  serviço já oferecia (motivo e confirmação). Depois disso o cancelamento do contrato segue pelo caminho normal.
- Teste: `lib/contratos/services/cancelamento-revisao-aberta.test.ts`.

Relaxar a regra do banco para aceitar contrato cancelado exigiria migration e autorização separada; não foi feito.
