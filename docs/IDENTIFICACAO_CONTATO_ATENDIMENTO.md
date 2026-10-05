# Identificação do contato no Atendimento WhatsApp — nome e número completo

**Situação:** implementada localmente em 04/10/2026, sem push. A migration **065** (nome de perfil) foi aplicada **somente** nos bancos descartáveis das validações autorizadas de 04/10/2026 (HEAD `78ed9d8`; resultado em [VALIDACAO_IDENTIFICACAO.md](VALIDACAO_IDENTIFICACAO.md)), já removidos. Esta entrega não aplicou nada em staging nem em produção; o estado desses bancos **não foi verificado**.

## O que a tela mostra

A identificação aparece **só** na tela de Atendimento, para quem passa por `acessoAtendimento`: papel `ADMINISTRATIVO` ou `REPRESENTANTE_AUTORIZADO` com vínculo **ativo** na empresa piloto comprovada pela sessão. Não abre nenhuma rota nova.

| Campo | De onde vem | Como aparece |
| --- | --- | --- |
| **Número** | `whatsapp_atendimento_conversas.contato` (o canal) | Completo e formatado: `+55 (61) 90000-0101` |
| **Cadastro** | Clientes **da mesma empresa**, não mesclados, com o número no telefone ou no WhatsApp, com e sem o 55 (mesma regra de `buscarClientesPorContatoExato` + `variantesTelefone`) | Um cliente: "Cliente cadastrado: Nome". Vários: "N clientes cadastrados com este número. Nenhum foi escolhido; confira o cadastro." — **nenhum nome sai do banco**. Nenhum: "Nenhum cliente cadastrado com este número." |
| **Perfil no WhatsApp** | Gupshup `payload.sender.name` (formato oficial v2), gravado na conversa pela 065 | "Nome (nome no WhatsApp, não verificado)", em itálico. Sem nome, ou sem a 065: "Não informado pelo WhatsApp" |

**Título do cartão e da conversa:**
- com cadastro único, o nome cadastrado;
- sem cadastro único, o nome de perfil, **sempre** com o rótulo "não verificado";
- sem nenhum dos dois, o número.

Com cadastro ambíguo, o cartão ganha o aviso "Vários cadastros com este número", com a borda laranja reservada a alertas.

## Regras de segurança e dados

- **Isolamento:**
  - conversas filtradas por empresa e ambiente (060);
  - cadastro com `cl.empresa_id = c.empresa_id`;
  - o nome de perfil fica na linha da conversa, única por (empresa, ambiente, contato).
- **Ambiguidade:**
  - com mais de um cliente, a consulta devolve só a contagem;
  - a tela não escolhe nem sugere um dos cadastros.
- **Nome de perfil:**
  - escrito pela própria pessoa, sem verificação: nunca vira "cliente" nem preenche cadastro;
  - saneado: sem caracteres de controle ou formatação, espaços colapsados, até 80 caracteres, vazio vira nulo;
  - o evento mais novo vence: replay antigo não sobrescreve, e nome ausente ou vazio não apaga o anterior;
  - gravar o nome não muda a versão nem o estado da conversa;
  - contato fora da lista permitida não grava nada.
- **Modelo:** o worker continua enviando ao modelo só as mensagens e o interesse. Nome de perfil e cadastro nunca vão ao modelo; há teste que fixa o formato da chamada.
- **Logs:** o webhook continua omitindo `source` e `sender` dos registros.
- **Mudança de regra antiga:** até aqui a tela recebia só os 4 últimos dígitos. O pedido do Felipe de 04/10/2026 muda isso **só** para esta tela autorizada. As prévias de mensagens prontas continuam sem telefone.

## Migration 065 (preparada; aplicada só em bancos descartáveis de validação)

| Arquivo | Conteúdo |
| --- | --- |
| `database/migrations/20261004_065_whatsapp_nome_perfil.sql` | `nome_perfil text` e `nome_perfil_em timestamptz` na conversa: anuláveis, sem default, sem reescrita; restrições de formato (aparado, 1–80) e de par nome/horário; `lock_timeout` de 5 s; falha fechada; exige a 060 e independe da 064 |
| `database/rollback/20261004_065_whatsapp_nome_perfil_down.sql` | Remove só as duas colunas. Com nomes gravados, recusa sem `SET LOCAL kidmais.rollback_065_descartar_nomes = 'sim'` |
| `database/checks/20261004_065_postcheck.sql` e `…_065_rollback_postcheck.sql` | Somente leitura; confere também a unicidade (empresa, ambiente, contato) da 060 |

**Sem a 065 a tela continua funcionando.** O serviço confere no catálogo, a cada uso e sem cache, se a coluna existe. Sem ela, mostra o número e o cadastro e diz que o perfil não foi informado. Aplicar ou reverter a 065 não exige reiniciar a aplicação.

## Numeração — coordenada com a candidata do painel

**Leitura de 04/10/2026, depois de `git fetch`:**

| Ref | Arquivos de migration 06x na branch (não é o estado de nenhum banco) |
| --- | --- |
| `origin/staging` (`904b451`) e `origin/production` (`650e268`) | até a **062** |
| `origin/feat/painel-desenvolvedor-20261004` (`2b6702a`; em `660c216` na leitura das 18:47, mesma 063) = local `feat/…`; local `codex/painel-multi-20261004` (`c0158d4`, sessão ativa) | **063 `painel_desenvolvedor`**, com `063_precheck`/`063_postcheck` e rollback. Base no `staging` atual; 2–3 commits à frente; **já publicada** |
| Esta candidata, antes da coordenação | 063 prontas + 064 nome de perfil, colidindo com o painel no id e no arquivo `database/checks/20261004_063_postcheck.sql` |

**Decisão:**
- o painel, com a branch já publicada no GitHub, mantém a **063**;
- esta candidata, ainda não publicada, renumerou para **064 (mensagens prontas)** e **065 (nome de perfil)** no commit `090e7df`.

Foram atualizados migrations, rollbacks, postchecks, mensagens de erro ("064 exige a 060", "migration 064" na tela), variáveis de descarte (`kidmais.rollback_064_descartar_prontas` e `kidmais.rollback_065_descartar_nomes`), `check-migrations`, `production.test`, a seleção PostgreSQL, os testes estáticos e as suítes. O inventário de produção é uma lista explícita e só exige ids únicos, sem sequência contígua. Por isso as duas candidatas entram **em qualquer ordem**: as tabelas são independentes e nenhuma depende da outra.

**Prova (só leitura/local):**
- `git merge-tree` da candidata com `origin/staging`: **sem conflito**.
- Com o painel (`2b6702a`) e com `codex/painel-multi-20261004` (`c0158d4`): conflito **só** em `scripts/production/check-migrations.mjs` e `production.test.mjs`, que são listas adjacentes. Com o painel em `660c216` (leitura das 18:47), também em `app/admin/login/page.tsx`: ver [PLANO_INTEGRACAO_ATENDIMENTO.md](PLANO_INTEGRACAO_ATENDIMENTO.md).
- Simulação numa worktree descartável do painel com esta candidata mesclada, com os inventários resolvidos pela união das listas:
  - `production.test` **37/37**;
  - `check-migrations` sem bloqueio, com 060…065 únicos e a última sendo a 065;
  - testes de numeração 8/8.
- O resolvedor e o diff da simulação estão em `.local-ux/coordenacao-painel/`, fora do Git. A worktree foi removida.

**Resolução na hora da segunda mescla**, seja quem for o segundo: unir as listas. Em `approvedFiles`:

```
'20261004_063_painel_desenvolvedor.sql',
'20261004_064_whatsapp_mensagens_prontas.sql',
'20261004_065_whatsapp_nome_perfil.sql',
```

Também:
- `requiresExplicitAuthorization` com `'060' … '065'`;
- as três pendências `063`, `064` e `065`;
- no `production.test`, `latest` = 065 e as listas com as três.

**Teste de numeração** (`migration-065.test.ts`): nenhum arquivo 063 pode ser do atendimento; se existir 063, é a do painel. Vale antes e depois da mescla.

**O que não foi feito:** nenhuma alteração na branch do painel, nenhum push e nenhum contato com a outra sessão. A coordenação se apoia no estado publicado do painel; se ele mudar de número antes de entrar, refazer esta leitura.

## Testes

- **Unitários (sem banco):**
  - `identificacao.test.ts`: `sender.name`, saneamento, situação do cadastro, formatação, prioridade dos rótulos;
  - `service.test.ts`: SQL da listagem (empresa, mesclados, variante sem 55, nenhum nome com ambiguidade, empresa e ambiente; sem a 065 → `NULL`), gravação do nome só com a 065, guarda de papel do serviço, worker sem nome nem cadastro na chamada ao modelo;
  - `core.test.ts`;
  - `migration-065.test.ts` (estático e numeração).
- **PostgreSQL (preparada, não executada):** `migration-065.postgres.test.ts`. Cobre ordem; tela sem a 065; aplicação e regras do banco; nome de perfil (saneado, replay, ausente, mais novo); cadastro (variante sem 55, outra empresa não conta, ambíguo sem nome); isolamento por empresa e ambiente; **recusa obrigatória** de usuário só de outra empresa e de vínculo não ativo; rollback recusado e com descarte; tela depois do rollback (sem cache); reaplicação; limpeza.
- `migration-060.postgres.test.ts` ajustada ao novo contrato da tela.

## Pendente (exige autorização)

Ver "Validação preparada" em [VALIDACAO_IDENTIFICACAO.md](VALIDACAO_IDENTIFICACAO.md).
