# Identificação do contato no Atendimento WhatsApp — nome e número completo

**Situação:** implementada localmente em 04/10/2026, sem push. A migration **064** está preparada e **não foi aplicada** em nenhum banco. A suíte PostgreSQL está preparada e não foi executada: precisa de autorização (docs/OPERACAO_AGENTES.md).

## O que a tela mostra

A identificação aparece **só** na tela de Atendimento, para quem passa por `acessoAtendimento` (papel `ADMINISTRATIVO` ou `REPRESENTANTE_AUTORIZADO` da empresa piloto comprovada pela sessão). Não abre nenhuma rota nova.

| Campo | De onde vem | Como aparece |
| --- | --- | --- |
| **Número** | `whatsapp_atendimento_conversas.contato` (o canal) | Completo e formatado: `+55 (61) 90000-0101` |
| **Cadastro** | Clientes **da mesma empresa**, não mesclados, com o número no telefone ou no WhatsApp, com e sem o 55 (mesma regra de `buscarClientesPorContatoExato` + `variantesTelefone`) | Um cliente: "Cliente cadastrado: Nome". Vários: "N clientes cadastrados com este número. Nenhum foi escolhido; confira o cadastro." — **nenhum nome sai do banco**. Nenhum: "Nenhum cliente cadastrado com este número." |
| **Perfil no WhatsApp** | Gupshup `payload.sender.name` (formato oficial v2), gravado na conversa pela 064 | "Nome (nome no WhatsApp, não verificado)", em itálico. Sem nome: "Não informado pelo WhatsApp" |

**Título do cartão e da conversa:**
- com cadastro único, o nome cadastrado;
- sem cadastro único, o nome de perfil, **sempre** com o rótulo "não verificado";
- sem nenhum dos dois, o número.

Com cadastro ambíguo, o cartão ganha o aviso "Vários cadastros com este número", com a borda laranja reservada a alertas.

## Regras de segurança e dados

- **Isolamento:**
  - conversas filtradas por empresa e ambiente, como desde a 060;
  - cadastro com `cl.empresa_id = c.empresa_id`;
  - o nome de perfil fica na linha da conversa, que já é isolada por (empresa, ambiente, contato).
- **Ambiguidade:**
  - com mais de um cliente, a consulta devolve só a contagem;
  - a tela não escolhe nem sugere um dos cadastros.
- **Nome de perfil:**
  - escrito pela própria pessoa, sem verificação: nunca vira "cliente" nem preenche cadastro;
  - saneado: sem caracteres de controle ou formatação, espaços colapsados, até 80 caracteres, vazio vira nulo;
  - o evento mais novo vence: replay antigo não sobrescreve, e nome ausente ou vazio não apaga o anterior;
  - gravar o nome não muda a versão nem o estado da conversa;
  - contato fora da lista permitida não grava nada, nem o nome.
- **Modelo:** o worker continua enviando ao modelo só as mensagens e o interesse. Nome de perfil e cadastro nunca vão ao modelo; há teste que fixa o formato da chamada.
- **Logs:** o webhook continua omitindo `source` e `sender` dos registros.
- **Mudança de regra antiga:** até aqui a tela recebia só os 4 últimos dígitos ("o telefone completo não sai do servidor"). O pedido do Felipe de 04/10/2026 muda essa regra **só** para esta tela autorizada. As prévias de mensagens prontas continuam sem telefone.

## Migration 064 (preparada, não aplicada)

| Arquivo | Conteúdo |
| --- | --- |
| `database/migrations/20261004_064_whatsapp_nome_perfil.sql` | `nome_perfil text` e `nome_perfil_em timestamptz` na conversa: anuláveis, sem default, sem reescrita; restrições de formato (aparado, 1–80) e de par nome/horário; `lock_timeout` de 5 s; falha fechada; exige a 060 e independe da 063 |
| `database/rollback/20261004_064_whatsapp_nome_perfil_down.sql` | Remove só as duas colunas. Com nomes gravados, recusa sem `SET LOCAL kidmais.rollback_064_descartar_nomes = 'sim'` |
| `database/checks/20261004_064_postcheck.sql` e `…_064_rollback_postcheck.sql` | Somente leitura; confere também a unicidade (empresa, ambiente, contato) da 060 |

**Sem a 064 a tela continua funcionando.** O serviço confere no catálogo, a cada uso e sem cache, se a coluna existe. Sem ela, mostra o número e o cadastro e diz que o perfil não foi informado. Aplicar ou reverter a 064 não exige reiniciar a aplicação.

**Registro:** a 064 entrou em `scripts/production/check-migrations.mjs` (inventário, postcheck, autorização explícita, pendência) e em `production.test.mjs` (37/37).

## Numeração

Conferida em 04/10/2026, depois de `git fetch` (leitura) em todas as refs locais e remotas:

| Ref | Última migration |
| --- | --- |
| `origin/staging` (`904b451`) e `origin/production` (`650e268`) | **062** |
| Esta candidata (`whatsapp/atendimento-ia-v1`) | 063 `whatsapp_mensagens_prontas` + 064 `whatsapp_nome_perfil` |
| `origin/feat/painel-desenvolvedor-20261004` (e as locais `feat/…` e `codex/painel-multi-20261004`) | **063 `painel_desenvolvedor`** — colide com a 063 desta candidata |

**Consequência:** quem entrar em staging **depois** renumera. Se o painel entrar primeiro, as prontas viram 064 e o nome de perfil 065. Os nomes de arquivo, `check-migrations`, `production.test`, os testes estáticos, os textos de erro "06x exige/já aplicada" e as suítes precisam mudar juntos. A 064 não depende da 063, só da 060.

## Testes

- **Unitários (sem banco):**
  - `lib/whatsapp/atendimento/identificacao.test.ts`: leitura do `sender.name`, saneamento, situação do cadastro, formatação e prioridade dos rótulos;
  - `service.test.ts`: SQL da listagem (empresa, mesclados, variante sem 55, nenhum nome com ambiguidade, conversas da empresa e do ambiente, sem a 064 → `NULL`), gravação do nome só com a 064, papel sem acesso recusado, worker sem nome nem cadastro na chamada ao modelo;
  - `core.test.ts`, com a regra antiga atualizada;
  - `migration-064.test.ts` (estático).
- **PostgreSQL (preparada, não executada):** `migration-064.postgres.test.ts`, declarada em `regressao-v1-selecao.cjs`. Cobre ordem, tela sem a 064, aplicação e regras do banco, nome de perfil (saneado, replay, ausente, mais novo), cadastro (variante sem 55, outra empresa não conta, ambíguo sem nome), isolamento por empresa e ambiente, rollback recusado e com descarte, tela depois do rollback e reaplicação.
- `migration-060.postgres.test.ts` ajustada ao novo contrato da tela (número completo + cadastro).

## Pendente (exige autorização)

1. Executar as suítes PostgreSQL 060/063/064 e a completa no cluster descartável.
2. Validação visual no navegador (desktop, celular e teclado) com banco sintético: cartão, título e quadro de identificação nos três casos de cadastro e com e sem nome de perfil.
3. Decidir a numeração final com a branch do painel antes de qualquer merge.
