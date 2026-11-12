# Salões combinados — fase 1 dos salões (migration 098)

Estado: **implementação LOCAL composta com o staging atual** (clone `kidmais-manager-saloes-fase1-composicao-20261023`,
branch `codex/saloes-fase1-combinado-20261023`, base `origin/staging` `dde49b8`, com as PRs #221 e #222). Foi desenvolvida
sobre `b3735a9`, aprovada com ressalvas pelo Astra na conferência final e recomposta em 23/10/2026. Nada foi publicado
nem aplicado fora de PostgreSQL descartável local. Fonte de verdade do desenho: nota do vault
`02 - Kidmais Manager SaaS/07 - Roadmap/Saloes fase 1 salao inteiro 20261023.md` (revisão 3, APROVADA COM RESSALVAS
pelo Astra em 23/10/2026, com as duas ressalvas P3 do parecer final).

## O que é

Um buffet com dois ou mais salões no mesmo endereço pode cadastrar um **salão combinado** ("Salão inteiro" = A+B).
O combinado é reservável como qualquer salão. Quando ele está reservado, A e B ficam ocupados; quando A está
reservado, o combinado fica indisponível; A e B continuam podendo receber festas simultâneas.

Fora desta fase: limite de salões por plano (fase 2; até lá, sem limite em qualquer plano, risco aceito por Felipe),
salão no contrato/PDF (fase 3), escolha por número de convidados e bloqueio por salão (o bloqueio continua fechando o
horário inteiro).

## Banco (098)

Arquivos:

- `database/migrations/20261023_098_saloes_combinados.sql`
- `database/checks/20261023_098_precheck.sql`, `_postcheck.sql`, `_integridade.sql`
- `database/rollback/20261023_098_saloes_combinados_down.sql`
- `scripts/migration-098-hashes.mjs` (hash offline dos corpos, sem banco)

Modelo:

| Objeto | Regra |
|---|---|
| `agenda_saloes.combinado boolean NOT NULL DEFAULT false` | tipo do salão |
| `agenda_saloes.membros uuid[]` | nulo no simples; no combinado, 1-D, base 1, sem nulos nem repetidos, em ordem crescente, 2 ou mais (`agenda_saloes_098_membros_check` + `kidmais098_membros_canonicos`) |
| `agenda_saloes_098_guarda_trg` (BEFORE UPDATE OR DELETE) | `id`, `empresa_id`, `estabelecimento_id`, `combinado` e `membros` imutáveis; DELETE de salão que é membro recusado; D5 (abaixo) |
| `agenda_saloes_098_combinado_trg` (BEFORE INSERT) + `agenda_saloes_098_combinado_diferido` (AFTER INSERT, DEFERRABLE INITIALLY DEFERRED) | trava os membros `FOR SHARE` em ordem de id e exige membros simples, ativos, da mesma empresa e unidade, sem o próprio id; confere de novo no COMMIT |
| `agenda_saloes_098_truncate_trg`, `contratos_098_truncate_trg` | TRUNCATE recusado |
| `contratos_098_guarda_trg` (BEFORE DELETE OR UPDATE OF fechamento_id) | contrato não é apagado e não muda de festa |

Funções novas: `kidmais098_hoje()` (data de America/Sao_Paulo via `clock_timestamp()`, volátil),
`kidmais098_conjunto`, `kidmais098_saloes_cruzam`, `kidmais098_salao_elegivel`, `kidmais098_validar_elegibilidade`,
`kidmais098_salao_guarda`, `kidmais098_combinado_validar`, `kidmais098_proibir_truncate`, `kidmais098_contrato_guarda`,
`kidmais098_membros_canonicos`.

Corpos substituídos (gerados a partir da 094, conferidos por teste unitário):

- `kidmais094_conflito_ocupacao`: no ramo POR_SALAO, `(o.salao_id IS NULL OR salao IS NULL OR o.salao_id = salao)`
  vira `kidmais098_saloes_cruzam(o.salao_id, salao)`. Limite do dia e bloqueio inalterados.
- `kidmais019_validar_contrato`: uma linha a mais, `IF kidmais019_ocupa(fid) THEN PERFORM kidmais098_validar_elegibilidade(fid); END IF;`.
- `kidmais_validar_agenda_revisao`: uma linha a mais, `PERFORM public.kidmais098_validar_elegibilidade(fid);`, depois
  da trava das datas e antes do conflito.

### Invariante de elegibilidade

Toda ocupação de hoje em diante (`data >= kidmais098_hoje()`, por ocupação, como em `kidmais094_ocupacoes`: origem
`CONFIRMADA` sem histórico passado e `REVISAO_DESTINO` com hold) aponta para salão nulo ou elegível (ativo e, se
combinado, com todos os membros presentes, simples e ativos). `kidmais098_validar_elegibilidade(fid)`:

1. monta a **união, sem repetidos e ordenada por id**, dos salões e membros de todas as ocupações futuras da festa
   (origem e destino do hold) — ressalva P3-1 do parecer final;
2. trava essa união numa única consulta `ORDER BY id FOR SHARE`;
3. em consulta nova (estado confirmado), recusa salão inelegível; salão ou membro ausente nunca vira conjunto vazio.

Ela roda nas validações diferidas da 019 (contrato, fluxo, fechamento, festa) e na validação da revisão (hold,
aplicação), cobrindo o inventário de eventos da revisão 2 (inclusive cancelamento e volta do contrato).

### D5 (decisão de Felipe, 23/10)

Desativar salão, combinado ou membro de combinado com ocupação de hoje em diante é recusado pelo gatilho. A tela lista
as festas antes (mesmo corte, `kidmais098_hoje()` — ressalva P3-2). Rascunho sem hold não conta; hold conta origem e
destino; aplicar libera a origem; cancelar libera o destino.

### Ordem de locks efetiva

| Caminho | Ordem |
|---|---|
| SQL direto em `fechamentos` | 062 (empresa → unidade → habilitação, FOR SHARE) → datas (019) → salões e membros (diferido, união por id, FOR SHARE) |
| Serviço de reserva/formalização | datas (serviço) → linha do fechamento → 062 → datas (019, sem efeito) → salões e membros (diferido) |
| Troca manual e revisão | linha do fechamento → datas → 062 → salões e membros |
| Cadastro (`salvarAgendaEscopo`, criar combinado, desativar salão) | `kidmais:agenda-config:<empresa>` → todos os salões do escopo `ORDER BY id FOR NO KEY UPDATE` → DML |

Reserva e cadastro travam salões em ordem crescente de id; o cadastro não pega fechamento, data nem empresa.

### Aplicação e rollback

Ordem: código com o conjunto 098 no manifesto da Festa (`lib/festas/estrutura-019.ts`, que aceita 094 **ou** 094+098)
→ precheck → 098 → postcheck → integridade 098. O precheck recusa se houver festa de hoje em diante em salão inativo.
Depois da 098, `20261022_094_integridade.sql` deixa de passar (três corpos trocados): use `20261023_098_integridade.sql`.

Rollback, numa transação única:

1. recusa se a 098 não estiver aplicada;
2. roda o **verificador completo da 098**, o mesmo bloco de `20261023_098_integridade.sql`, antes de qualquer alteração. Por isso também recusa instalação parcial ou alterada: gatilho desligado, corpo diferente, constraint ausente;
3. recusa se existir **qualquer** combinado, mesmo inativo;
4. trava `agenda_saloes` (SHARE ROW EXCLUSIVE) e confere de novo;
5. volta os três corpos da 094 e remove os objetos da 098;
6. antes do COMMIT, roda o **verificador completo da 094**, o mesmo bloco de `20261022_094_integridade.sql`.

Qualquer falha aborta a transação inteira (correção do P2-1 da revisão do Astra). Um teste unitário exige que os blocos sejam idênticos aos dos arquivos de check.

Rodadas 2 e 3 do Astra: o verificador da 098 tem um segundo bloco, **"Colunas e FKs exatas"**. Ele confere a definição completa de `salao_id` nas quatro tabelas: tipo, nulabilidade (nulável nas duas da 094, NOT NULL nas duas da 093), sem default, identity ou coluna gerada; e também `agenda_saloes.id`. Além disso, confere as FKs. Cada uma das quatro tabelas que referenciam `agenda_saloes` (fechamentos, fechamento_revisoes, pacote_saloes, configuracao_agenda_saloes) precisa ter **exatamente uma** FK para ela, com estas propriedades:
- validada e não adiável;
- de `salao_id` (`conkey`) para `agenda_saloes.id` (`confkey`);
- RESTRICT/RESTRICT e MATCH SIMPLE.

O rollback repete esse bloco como pós-condição, depois do verificador da 094. O arquivo `20261022_094_integridade.sql`, que só confere a existência de alguma FK, não foi alterado porque tem o hash fixado no aplicador 092–094, já usado em staging. O rollback não mexe em FKs.

## Core

- `lib/agenda/saloes-conjuntos.ts`: a mesma regra do SQL, sem banco (`saloesCruzam`, `salaoElegivel`, conjuntos).
- `lib/disponibilidade/repositories/disponibilidade.repository.ts`: `lerRegraCapacidadeAgenda` traz os conjuntos de
  todos os salões do escopo e só os elegíveis como candidatos.
- `lib/disponibilidade/services/availability.service.ts`: `ocupacaoImpedeCandidato` usa a interseção; origem e destino
  do hold continuam ocupações separadas; sem candidato elegível = indisponível.
- `lib/agenda/salao-festa.ts` (formalização, importação, pagamento, hold, aplicação) e `lib/agenda/troca-salao.ts`
  (troca manual): só candidatos elegíveis; permissão por identidade em `pacote_saloes`/`configuracao_agenda_saloes`
  (A e B liberados não liberam AB).
- `lib/agenda/configuracao-unidade.ts`: lock de todos os salões do escopo no cadastro; `criarSalaoCombinado`,
  `desativarSalao`, `impedimentosDesativacao`, `hojeDaAgenda`; o salvamento da tela mantém os combinados e os aceita
  nos horários pelo nome.
- `lib/agenda/saloes-do-dia.ts` + `GET /api/admin/agenda/saloes-do-dia`: ocupação do dia por salão.

## Telas

- Configurações › Agenda (capacidade por salão): seção "Salões combinados" — criar escolhendo os salões, listar com a
  composição, desativar (recusa com a lista de festas). Sem edição de membros. Com qualquer alteração da agenda ainda
  não salva (`formAlterado`), criar e desativar ficam bloqueados e a tela pede salvar ou descartar: essas ações gravam e
  recarregam a agenda, o que descartaria a edição (P2-2 da revisão do Astra).
  - A pendência compara o texto digitado como está, sem converter nem filtrar. Por isso "abc" num número ou uma linha sem nome também contam (rodada 2).
  - Enquanto grava ou recarrega, todos os controles da agenda ficam desabilitados.
  - Se o rascunho mudar mesmo assim durante a requisição, ele é preservado no retorno: só a agenda salva e a lista de combinados são atualizadas, e a tela avisa que as alterações foram mantidas.
  - Rodada 3: desativar horário, cancelar a desativação e trocar de unidade também exigem salvar ou descartar. Os botões e o seletor ficam desabilitados, e as ações forçadas são recusadas sem gravar nem recarregar. Um aviso geral de pendência aparece no topo.
- Pacotes: o combinado aparece com a composição e o aviso de permissão explícita.
- Agenda (Disponibilidade): "Salões neste dia" — o combinado reservado marca A e B; combinado com membro desativado
  aparece como "Indisponível: <membro> desativado", nunca como livre (P3-3).

## Exportação

`agenda_saloes.combinado` e `agenda_saloes.membros` (array em JSON) entram no CSV da exportação; retrato em
`lib/exportacao/colunas-esperadas.json`; as suítes de exportação rodam no modelo 098.

## Testes

- Unitários: `lib/agenda/saloes-combinados-098.test.ts` (regra pura, candidatos, hold, corpos = 094 + linhas,
  hashes do verificador, manifesto, guardas declaradas).
- PostgreSQL descartável: `lib/agenda/saloes-combinados-098.postgres.test.ts` (modelo 094 + 098 aplicada pela suíte)
  e `lib/agenda/saloes-caminhos-098.postgres.test.ts` (modelo 098, serviços reais com contrato). A primeira inclui o
  rollback recusando 098 parcial/alterada (gatilho da 094 ou da 098 desligado, deriva de corpo, CHECK removido) e a
  pós-condição da 094 abortando a transação inteira.
- Tela: `components/admin/saloes-combinados-tela.test.ts` (pendência bloqueia criar/desativar sem gravar nem
  recarregar; descartar libera; agenda do dia com combinado inelegível).

Limites conhecidos: a virada da meia-noite dentro de uma transação não é simulada (o relógio do servidor não é
injetável); a prova cobre a expressão em instantes fixos (21h, 23h59 e 0h de SP com sessão em UTC), a sessão em
fusos que estão em outro dia e a volatilidade de `kidmais098_hoje()`. A confirmação por pagamento é coberta pela
função de escolha que ela usa (`escolherSalao`), não pelo fluxo completo de pagamento.

## Retrato estrutural canônico (rodada 4 do Astra)

`database/checks/20261023_098_retrato.sql` é a fonte única de um retrato estrutural das tabelas e funções que a 093, a 094 e a 098 tocam:
- **Tabelas:** agenda_saloes, fechamentos, fechamento_revisoes, contratos, contrato_fluxos, festas, pacote_saloes e configuracao_agenda_saloes.
- **O que entra:** colunas, com default por expressão; constraints; índices; gatilhos; regras; políticas; e atributos das funções do escopo (corpo, volatilidade, SECURITY DEFINER, STRICT, PARALLEL, SET search_path, assinatura).
- **O que fica fora:** dono, ACL e OIDs, que mudam por ambiente.
- **Como é calculado:** sempre com `search_path = pg_catalog`, porque o texto das definições depende do search_path da sessão, e ordenado em collation "C". O valor anterior do search_path é restaurado.

`scripts/migration-098-retrato.mjs` embute o mesmo bloco, com o SHA-256 esperado, nestes lugares:
- no precheck: estado 094;
- no postcheck e no verificador: estado 098;
- no rollback: pré-condição 098 e pós-condição 094.

Os hashes foram calculados em PostgreSQL 18 nos modelos 094 e 098 construídos do inventário.

**Consequências:**
- Qualquer deriva estrutural nessas tabelas ou funções faz a 098 recusar a aplicação ou o rollback. Exemplos: default de id trocado, índice extra, search_path de função alterado. A recusa acontece sem alterar nada.
- O retrato vale para o inventário até a 098. Uma migration nova que toque essas tabelas ou funções exige recalcular os retratos.
- Antes de aplicar a 098 em staging, rodar `20261023_098_retrato.sql` em modo somente leitura (com autorização) e conferir que bate com o modelo 094. Se o staging tiver deriva estrutural real em relação ao inventário, o precheck recusa, e o diff mostra o que diverge.

### Rodada 5 do Astra: escopo do retrato

- **Gatilhos internos das constraints:** entram as FKs nos dois lados, inclusive as de outras tabelas que apontam para o escopo. Cada gatilho é identificado por constraint, tabelas, função `RI_FKey_*`, eventos (`tgtype`), estado e adiamento. O nome fica fora porque traz OID.
- **Tabelas:** passam a ser as 8 tabelas-base mais toda tabela ou view de `public` cujo nome aparece no corpo de uma função protegida, ou seja, as dependências diretas. No inventário até a 098 são 44 tabelas: configuracao_agenda, agenda_escopo_config, bloqueios_agenda, a habilitação da 062, empresas, estabelecimentos, as tabelas de formalização e de importação, entre outras. As funções de gatilho dessas tabelas também entram.
- **Efeito:** o acoplamento ao inventário fica mais amplo. Uma migration nova que mexa em qualquer dessas tabelas exige investigar a divergência e recalcular os dois retratos com `scripts/migration-098-retrato.mjs`, depois de recalcular os hashes num PG descartável.

### Rodada 6 do Astra: P2-1 fechado; os três P3 resolvidos

- **Fechamento transitivo:** CTE recursiva que, a partir das 8 tabelas-base e das funções protegidas, segue:
  - função → tabelas/views e funções de `public` citadas no corpo;
  - tabela → funções dos seus gatilhos;
  - view → tabelas citadas na definição;
  - e assim até não haver nada novo.

  No inventário até a 098 isso dá **72 tabelas e 115 funções**. Entram também, por exemplo, pagamentos, preços, auditoria e `marketing_contato_autorizacoes`.
- **Sequências:** entram as das colunas do escopo, tanto identity/serial quanto as usadas por `nextval`, com tipo, início, incremento, mínimo, máximo, cache e ciclo.
- **Tipos:** entram os não internos das colunas (domínio, enum, composto, range). Hoje não há nenhum.
- **Extensões:** entram as que fornecem funções usadas em defaults do escopo, só a presença (hoje `pgcrypto`). Versão e configuração ficam como pré-requisito do ambiente.
- **Políticas RLS:** entram com os papéis (`polroles`).
- **Custo:** cerca de 1,2 s por cálculo, abaixo do `statement_timeout` de 60 s do rollback.

**Acoplamento:** qualquer migration que mexa numa das 72 tabelas ou 115 funções antes da 098 chegar a um ambiente exige investigar e recalcular os retratos. A alternativa sugerida pelo Astra é uma lista explícita e revisada das referências indiretas, com menos acoplamento e mais manutenção manual. Essa decisão é do Felipe.

## Composição com o staging `dde49b8` (23/10/2026)

- **Diff aplicado:** o diff desenvolvido sobre `b3735a9` foi aplicado com `git apply --3way`. O código aplicou sem conflito. Os 4 conflitos foram de inventário e de seleção de testes:
  - `check-migrations.mjs` e `production.test.mjs`: entram 095–097 e a 098, inclusive na autorização explícita e nas pendências;
  - receita: modelos 095, **097** (inventário inteiro antes da 098) e 098;
  - seleção: a suíte da 098 roda sobre o modelo 097, e a exportação, no 098.
- **098 livre:** conferida em 447 refs remotas (branches e PRs), nas PRs abertas e nos clones locais.
- **Retratos recalculados depois de investigar a diferença:**
  - antes da 098: 72 tabelas, 115 funções; as 65 linhas a mais em relação à base antiga são só FKs (e gatilhos internos) das tabelas novas da 090/091/095–097 para `empresas` e `usuarios_administrativos`;
  - a mudança introduzida pela 098 é idêntica à da base antiga;
  - "estado 094" no código passa a significar o inventário inteiro antes da 098.
