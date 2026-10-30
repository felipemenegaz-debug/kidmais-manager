# Aplicador da 109 em staging (renovação substituta, B-9)

Estado: LOCAL, sem commit. Autorização de Felipe em 30/10/2026 ("autorizo o próximo passo"), depois de o código da #271 entrar no ar em staging (web 139ab9bc, cron da renovação 139ab9bc, primeira execução PASS) e do retrato real de staging conferido igual à 075. A aplicação da 109 no banco real é passo SEPARADO, com autorização própria.

Plano de origem: `docs/PLANO_B9_PRODUCAO_PUTS_JANELA_20261029.md` §3 (corte código → 109; rollback só sem histórico).

## O que entra

| Arquivo | Papel |
|---|---|
| `scripts/migration-109-comum.cjs` | Núcleo do aplicador (estado, guardas, plano, transação com verificação antes do COMMIT, marcador). |
| `scripts/migration-109-staging.cjs` | Trava de alvo de staging (web `srv-daif418ae00c73e8k2gg`, banco `kidmais_staging_1z91`), identidade/TLS/disco de `conexao-staging.cjs`. |
| `scripts/bloco-shell-109.cjs` | Gera os blocos CONFERIR e APLICAR do Web Shell (confere sha256 dos arquivos implantados e roda o aplicador). |
| `scripts/migration-109.test.cjs`, `scripts/bloco-shell-109.test.cjs` | Cliente simulado e colagem real em bash/bash -i (na CI). |
| `lib/assinatura/aplicador-109.postgres.test.ts` | Prova real no PG descartável, modelo 106 (075 íntegra, sem a 109). |

Os SQL (`109_precheck`, `109_renovacao_substituta`, `109_postcheck`) e o contrato (`renovacao-schema.ts`, `renovacao-schema-retratos.ts`) já estão em staging desde a #271 e não mudam: o aplicador fixa o sha256 de cada um (CRLF normalizado).

## Desenho

- **Estado pelo contrato do cron.** O mesmo `capacidadeRenovacao` do cron, da renovação manual e do preflight:
  - retrato igual ao da 075 = pendente;
  - igual ao da 109 = completa;
  - qualquer outro = DIVERGENTE, recusado com os nomes das divergências, nunca as definições.
- **Guardas antes de qualquer escrita.** Só catálogo, privilégios e `pg_stat_activity`:
  - privilégios do dono de `assinatura_renovacoes`, CREATE em public e USAGE em plpgsql;
  - SELECT na tabela, para as contagens;
  - nenhuma sessão `kidmais-renovacao*` ativa (cron, renovação manual ou restrita, preflight).
- **Transação única.** Precheck (READ ONLY), depois a migration sem o COMMIT final. Ainda na mesma transação: o corpo do postcheck (retrato = 109, gerado do contrato) e a capacidade `'109'`. Só então o COMMIT. Depois, a capacidade `'109'` de novo em READ ONLY.
- **Prazos (revisão do Astra, P3-1):**
  - `lock_timeout` de 5 s, que vem do SQL fixado.
  - `statement_timeout` de 60 s (`ORCAMENTO_DDL`) na sessão da conexão dedicada, definido antes do BEGIN do corpo. Vale para cada comando da transação do DDL, o postcheck, a capacidade e o COMMIT.
  - Estouro antes do COMMIT = NAO_COMMITADA. No COMMIT, 57014 = INDETERMINADO.
  - Os SQL fixados não mudam.
- **Contagens por estado** antes e depois. A 109 não toca dados: os números são os mesmos, sem nenhum vínculo de substituição.
- **Situação do COMMIT:** NAO_COMMITADA, CONFIRMADO, DESFEITA_PELO_SERVIDOR ou INDETERMINADO (40003 e classes 08/57/58/XX). Fica registrada num marcador exclusivo no disco persistente (`data/renovacao-109-staging/migration-109.json`).
- **Nunca executa:** o down, env, deploy, restart, suspender ou reativar o cron, escrita em `assinatura_renovacoes`.

## Ordem da janela (staging)

1. Conferir no Render que **todos os consumidores do plano §3** estão num commit com a #271 (139ab9bc ou posterior) e sem execução antiga em andamento: o web, o cron da renovação (`crn-dbg512hsrm7s73chk57g`) e o cron da reconciliação (`crn-db493i142hec73ahmoe0`, que também hospeda o preflight). As ferramentas manuais rodam no Shell do web. Fazer também o deploy do código com este aplicador. Em 30/10 o web e o cron da renovação estão em 139ab9bc, e o **cron da reconciliação ainda em 62b125e7**: falta o deploy dele (com autorização, fora do congelamento H7b).
   - Nota técnica (revisão do Astra, P3-2): o código da reconciliação não lê nem grava `assinatura_renovacoes`, e o preflight antigo só conta os dois gatilhos de nome fixo, que a 109 mantém. Ainda assim, o gate do plano é mantido como está; não foi reduzido.
2. Bloco CONFERIR. Esperado: `PRONTA_PARA_APLICAR`, capacidade 075, contagens.
3. Ponto PITR do PostgreSQL de staging comprovado e registrado.
4. Autorização de Felipe para a 109.
5. Suspender o cron da renovação no Render. Nenhuma renovação manual em andamento.
6. Bloco CONFERIR de novo, depois o bloco APLICAR (`KIDMAIS_REGISTRO_BACKUP` definido antes de colar), depois o bloco CONFERIR. Esperado no fim: `JA_APLICADA_CAPACIDADE_PASS`.
7. Reativar o cron. A execução seguinte lê a capacidade 109 (no log, sem saída 1).

**Paradas:** qualquer código diferente de 0 → parar, copiar a saída e o marcador, não repetir e manter o cron suspenso.

**Se o COMMIT ficar INDETERMINADO:** reconciliar pelo CONFERIR. A retomada só acontece com decisão de Felipe, renomeando o marcador (nunca apagando).

**Recuperação:**
- O down, só com autorização própria e SEM histórico de substituição (o down recusa).
- Depois da primeira substituição, só correção para frente.
- Em último caso, PITR.

## Provas locais

- Cliente simulado (`migration-109.test.cjs`): 14/14.
- Blocos (`bloco-shell-109.test.cjs`): 11/11, com bash e bash -i reais.
- PG descartável 18.6, cluster 55764: 3/3 (`aplicador-109` no modelo 106; regressão `renovacao-109` e `renovacao-schema`). Casos cobertos:
  - recusas pela sessão do cron, pelo retrato divergente (gatilho desligado; corpo da guarda) e pelo papel sem ser dono ou sem CREATE;
  - aplicação por papel dono não superusuário, com uma renovação real na tabela;
  - deriva da 109 recusada;
  - down;
  - falha real de lock (NAO_COMMITADA) e retomada.
- Mutantes: 21/21 mortos na cópia isolada (`ambientes-locais/mutacoes-aplicador-109-20261030.cjs`; relatório `2026-10-30T08-36-13-886Z-mutantes.json`). Na primeira rodada sobreviveram A13 (releitura final depois do caminho "já aplicada") e A16 (hash do contrato na conferência); os dois testes novos os mataram.
- CI local: 36/36 com os passos do `ci.yml` (inclui os 2 novos), clone em LF (`core.autocrlf=false`). Uma rodada anterior com o clone em CRLF falhou em 2 passos alheios (checksums de arquivos); era só o fim de linha.

## Rodada 2 — ressalvas da revisão do Astra (APROVADO COM RESSALVAS, 0 P1/P2, 2 P3)

Relatório: `revisao-aplicador-109-staging-20261030-astra/RELATORIO.md`.

- **P3-1 (prazo de execução do DDL):**
  - **Correção:** `statement_timeout` de sessão (`ORCAMENTO_DDL` = 60 s), definido logo antes do corpo e desfeito depois. Vale para o corpo, o postcheck, a capacidade e o COMMIT.
  - **Prova no PG:** outra sessão segura a tabela; com prazo de 1 s, quem estoura é o `statement_timeout`, antes do `lock_timeout` de 5 s. Resultado NAO_COMMITADA, nada criado, e a conferência seguinte dá PRONTA.
  - **Achado no caminho:** num banco pequeno, o DDL inteiro leva menos de 1 ms. Um prazo minúsculo sozinho não provaria nada, por isso a prova usa a espera pelo lock.
  - **Testes simulados novos:** prazo estourado no corpo e na capacidade (NAO_COMMITADA), no COMMIT (INDETERMINADO) e prazo recusado.
- **P3-2 (consumidores):** o roteiro, os pré-requisitos e o comentário do núcleo agora citam o cron da reconciliação (`crn-db493i142hec73ahmoe0`, que também hospeda o preflight), com as execuções antigas drenadas, como exige o §3. O gate foi mantido, não dispensado. Esse cron ainda está em 62b125e7 e precisa de deploy antes da janela, com autorização própria e fora do congelamento H7b.
- **Provas da rodada 2:**
  - cliente simulado 14/14 (casos novos dentro dos testes existentes);
  - blocos 11/11;
  - PG 3/3 (relatório `2026-10-30T09-21-45-260Z`), com o cluster removido;
  - mutantes 24/24, com 3 novos, A18–A20 (relatório `2026-10-30T09-21-34-739Z-mutantes.json`);
  - CI local 36/36 (`ci-a109-r2-resumo.log`).
- **Conferência r2 do Astra: APROVADO** (`revisao-aplicador-109-staging-20261030-astra/r2/RELATORIO.md`). P3-1 e P3-2 encerrados, sem regressão.
