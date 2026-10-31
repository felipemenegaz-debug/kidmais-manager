# Convites avulsos em production (recorte de 31/10/2026)

Estado: **preparação LOCAL**, sem commit, sem push, nada executado em staging ou production. Este documento não autoriza aplicação nem deploy.

## Por quê

O item **Convites** do menu Operação (`/admin/convites`: biblioteca de convites e convites avulsos com vínculo opcional) existe em staging desde 24/10/2026 (commit `e64df081`, migration 099) e nunca foi promovido. Production (`21f86be8`) só tem o convite pela página da festa. Felipe pediu, em 31/10/2026, para levar só essa parte agora, sem esperar a promoção completa.

## Duas entregas, nesta ordem

A 099 tem de estar aplicada **antes** do código novo, e o aplicador precisa estar no servidor antes dela. Por isso:

| Entrega | Branch (base `production` 21f86be8) | Conteúdo | Muda o app? |
| --- | --- | --- | --- |
| E-1 | `codex/aplicador-099-production-20261031` | aplicador de production da 099 (B-2 aprovado pelo Astra, patch `f7832198…` sem mudança), aplicador de staging e testes, os 4 SQL da 099 + down, 099 no inventário de production, passo novo no CI | Não: só scripts e SQL. Nenhuma migration roda no deploy (o Render não aplica migrations) |
| E-2 | `codex/convites-avulsos-production-20261031` | E-1 + cherry-pick de `e64df081` sem os créditos (095) | Sim: menu Convites, biblioteca, convites avulsos |

Ordem: PR E-1 → merge → deploy manual do web → CONFERIR-099 no Web Shell → backup → APLICAR-099 → CONFERIR-099 (`JA_APLICADA_POSTCHECK_PASS`) → PR E-2 → merge → deploy manual do web → conferência logada. Cada passo remoto pede autorização própria de Felipe.

O E-1 substitui, só para a 099, o transporte do B-4 (pacote "Entrega grupo A"): os arquivos chegam ao servidor pelo próprio deploy. O pacote do Grupo A precisa ser regenerado sem a 099: tirar o transporte e os modos CONFERIR-099/APLICAR-099 do gerador `scripts/bloco-shell-entrega-grupo-a-producao.cjs` (clone `kidmais-manager-entrega-grupo-a-production-20261026`) e da lista de arquivos; recalcular partes, hashes e evidências; ajustar testes, mutantes e a ordem do E3. A base de production, os backups e a recuperação da promoção completa passam a tratar a 099 como pré-condição já aplicada, possivelmente com avulsos em uso: preservar a conferência e o marcador da 099, sem down automático.

## Conflitos resolvidos no cherry-pick

- `components/convites/ConviteEditor.tsx`: mantida a franquia mensal de production (sem o bloco de créditos da 095); acrescentado só o rótulo "Limite deste convite" para o convite sem festa.
- `scripts/production/check-migrations.mjs`: só a 099 entra no inventário de production (as 090–098 são de outros trabalhos ainda não promovidos).
- `scripts/regressao-v1-selecao.cjs`: a suíte `avulsos-099.postgres.test.ts` parte do modelo `089` (em staging era `098`, o estado anterior à 099 lá).
- `.github/workflows/ci.yml`: passo do aplicador de production + `biblioteca.test.cjs` no passo do serviço de convites.

## Validação local

- Aplicador: `migration-099.test.cjs` + `bloco-shell-099.test.cjs` + `migration-099-staging.test.cjs` 23/23; `production:test` 37/37.
- **Ensaio em PostgreSQL 18 descartável** (127.0.0.1:55498, schema = inventário de production até a 089): CONFERIR `PRONTA_PARA_APLICAR` (dono, CREATE, plpgsql e corpos 073/088 conferidos) → APLICAR `APLICADA_POSTCHECK_PASS`, COMMIT confirmado, retrato antes = depois, 34 ms → CONFERIR `JA_APLICADA_POSTCHECK_PASS`. Forma real de `pg_get_constraintdef`: `CHECK ((((festa_id IS NULL) AND … (editor_hash IS NULL)) OR ((festa_id IS NOT NULL) AND … (versao_contrato_id IS NOT NULL))))`, aceita pela gramática do aplicador — fecha a ressalva do Astra no B-2. O ensaio não tinha convites (contagens 0).
- **Ensaio com dados (rodada 2, P2-2 do Astra)** — `ensaio-099-r2.mts`: núcleo real do aplicador de production (`migration-099-comum.cjs`; o adaptador de production só acrescenta alvo/TLS/identidade/disco e é coberto pelos testes com cliente simulado), mesmo inventário até a 089. Fixtures gravados com `session_replication_role = replica` só na transação do fixture (o fixture da suíte foi feito para ROLLBACK); o aplicador e a 099 rodam com todos os gatilhos.
  - A — 2 convites vinculados válidos + 1 autorização de IA: `PRONTA_PARA_APLICAR` → `APLICADA_POSTCHECK_PASS`, COMMIT confirmado, retrato não vazio igual antes/depois, linhas de `convites` e `convite_ia_autorizacoes` idênticas (md5 de `to_jsonb`), 24 ms → `JA_APLICADA_POSTCHECK_PASS`.
  - B — convite com versão de outro contrato: conferência `RECUSARIA` (incompatíveis 1); aplicação recusada na etapa vínculo/versão, antes do DDL; schema (nulabilidade, CHECK, índice, corpos das funções) e linhas intactos.
  - C — papel de login sem posse das tabelas/funções: conferência `RECUSARIA`; aplicação `SEM_PRIVILEGIO_099 DONO CREATE`; schema intacto.
- Código: `tsc` 0; convites + menu 103/103; suíte PG `avulsos-099` 1/1 no modelo 089; `check:v1:static` código 0 (3301 + 103 testes, 2 avisos de ESLint preexistentes, build compilado); passos do CI 18/18.
- Suíte PostgreSQL completa no E-2 (cluster descartável, depois removido): 114/115 arquivos na primeira passada; a falha foi `lib/assinatura/transacao-com-prazo.postgres.test.ts` (teste de prazo de rede, rodou junto com um build), arquivo idêntico ao de production; repetido sozinho: 6/6 nos estados `atual` e `075`.
- **Comparação com a base (P2-3 do Astra)** — `transacao-com-prazo.postgres.test.ts` (o E-2 não altera `lib/assinatura`, pool nem conexão), mesmo cluster:
  - alternando base `21f86be8` (worktree limpa) e E-2, 3× sem carga e 3× com CPU ocupada: 12/12 PASS;
  - mesmas condições da falha original (`check:v1:static` com build rodando junto, teste em laço alternando): build na base → base 2 PASS + **1 falha D1 idêntica** (ADIADA na nova tentativa), E-2 2/2 PASS; build no E-2 → base 3/3, E-2 2/2 PASS.
  - Conclusão: a falha é **preexistente em production** e depende de carga (a nova tentativa do D1 tem prazo de 1,5 s). Não vem do recorte. O static da base nessa rodada teve todos os testes aprovados (3298 + 103) e falhou só no build, ao baixar as fontes do Google (rede local).

## Janela da aplicação da 099

A 099 trava `convites` e `convite_ia_autorizacoes` em ACCESS EXCLUSIVE durante toda a transação: enquanto ela dura, editor, link público, RSVP e geração de convites ficam parados esperando. Os 24–34 ms medidos nos ensaios são de banco local, sem concorrência e com até 2 convites; **não medem** a duração em production. `lock_timeout = 5s` limita só a espera para obter cada trava (se algo segurar a tabela, a aplicação desfaz tudo); a operação inteira fica limitada por `statement_timeout = 60s` por comando. Por isso a aplicação segue a ordem já prevista no aplicador (`scripts/migration-099-production.cjs`, `ORDEM`):

1. CONFERIR-099 (somente leitura) e registrar o resultado e as contagens;
2. backup restaurável de production registrado (dump conferido + PITR);
3. autorização de Felipe para a 099;
4. janela combinada: manutenção e consumidores de convites pausados ou drenados (nenhuma geração de IA em andamento, editor fechado, sem campanha divulgando link);
5. CONFERIR-099 **de novo, imediatamente antes** de aplicar;
6. APLICAR-099 uma vez; qualquer código ≠ 0: parar, copiar a saída e o marcador, não repetir;
7. CONFERIR-099 → `JA_APLICADA_POSTCHECK_PASS`; só então seguir para o E-2.

## Riscos e reversão

- Depois da 099, **sem avulsos**, o código atual de production continua compatível, desde que a conferência de vínculo/versão tenha passado: a 099 também endurece o gatilho `convite_validar_vinculo()` (versão do contrato da festa), não só remove `NOT NULL`.
- **Voltar o E-2 (rollback do deploy para o E-1/código antigo) depois de criados convites avulsos é uma interrupção funcional dos avulsos**, não só uma questão de tela: o serviço antigo (`publico()` em `lib/convites/service.ts`, `JOIN festas`) passa a responder 404 no link público de todo convite avulso já compartilhado, e o RSVP desses links deixa de funcionar; o editor administrativo antigo também não abre avulsos. Nada é apagado, e os convites vinculados continuam normais. A fila do operador (`/desenvolvedor/convites`) continua funcionando (consulta por convite/empresa; a festa aparece vazia). Antes de reverter o E-2 com avulsos em uso, avisar o buffet de que esses links ficam fora do ar até o novo deploy.
- O **down da 099** não é caminho de reversão operacional: recusa se houver convite avulso e também se existir autorização de IA com festa nula, mesmo depois de vincular todos os convites (essa evidência histórica não pode ser perdida). Não há down automático; a reversão é só de código.
- Créditos de IA (095) não entram: a geração com IA em production continua pela franquia mensal (piloto Kidmais).
