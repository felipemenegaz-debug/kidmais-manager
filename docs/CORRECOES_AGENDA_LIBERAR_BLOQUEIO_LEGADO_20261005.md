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

# Importação: reimportar o mesmo contrato depois do cancelamento (migration 064)

## Problema

Depois de cancelar um contrato integrado a partir de uma importação, o mesmo arquivo não podia ser importado de
novo. Três regras do schema travavam juntas: a 055c guarda um documento por arquivo (sha256 único por empresa); a
055d permite uma importação ativa (em revisão ou importada) por documento e trata IMPORTADA como estado terminal; a
061 liga a importação ao contrato e é imutável. O reenvio do arquivo caía na importação concluída e a tela mostrava
"Este contrato já faz parte do sistema", apontando para o contrato cancelado.

## Correção

- Migration `database/migrations/20261006_064_reimportacao_apos_cancelamento.sql` (NÃO APLICADA; exige autorização):
  nova guarda `kidmais_064_importacao_guarda` com uma única transição a mais: importação IMPORTADA cujo contrato
  integrado está CANCELADO pode passar a DESCARTADA (versão avançando, identidade imutável). Nenhuma linha é alterada
  pela migration; a guarda da 055d permanece para o rollback (`database/rollback/..._064_..._down.sql`). Checks de
  leitura em `database/checks/20261006_064_*.sql`.
- Código: ao reenviar o arquivo (ação `abrir`), se a importação ativa do documento está IMPORTADA e o contrato foi
  cancelado, ela é substituída (DESCARTADA, com cliente e resultado anteriores preservados em `dados.substituicao`) e
  uma nova revisão abre a partir da última extração. Sem a 064 instalada, nada muda. Com contrato ativo, nada muda.
- Tela de integração da importação antiga: mostra "Contrato cancelado" com link para o contrato e orienta a reenviar o
  arquivo, em vez de "já faz parte do sistema".
- Testes: `lib/ia-persistencia/migration-064.test.ts`, `lib/importacao-contrato/reimportacao.test.ts` e cenário novo em
  `lib/inteligencia/importacao/revisao.test.ts`.

## Aplicação

Ordem: código publicado antes (ele detecta a 064 pelo catálogo), depois a 064 no banco de staging com precheck e
postcheck, depois homologação: reenviar o PDF do contrato cancelado, revisar, confirmar e integrar.

# Importação: Dados do contratante (tela e obrigatoriedade)

Pedido de Felipe na homologação: padronizar as cores da lista do select, organizar o bloco "Dados do contratante",
tirar o campo Telefone (confundia com WhatsApp) e deixar e-mail e endereço opcionais.

- Select: a página de importação não tinha a regra `select option { background: var(--card-bg) }` usada nas demais
  telas; a lista nativa aparecia branca. Regra adicionada no assistente.
- Bloco do contratante: o componente usava estilos inline e inputs sem classe, por isso ficavam "invisíveis" sobre o
  vidro escuro (só o preflight do Tailwind os atingia). Agora usa as classes do assistente, em duas seções.
- Telefone: fora da tela, dentro do cadastro (preservado, conta como contato, segue na dedupe e no contrato).
- E-mail e endereço opcionais só na conferência histórica, com endereço completo ou vazio. O fechamento nativo não
  muda. Detalhes em `docs/CONTRATOS_IMPORTADOS_UNIFICACAO_20261005.md` (seção "Ajuste — contratante na conferência").
- Testes: `lib/clientes/cadastro-contratual.test.ts` (novo) e ajuste em `servico.test.ts` (cadastro incompleto agora
  pelo CPF, que continua obrigatório).
