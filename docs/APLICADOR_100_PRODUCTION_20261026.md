# Aplicador da 100 em produção (B-3, 26/10/2026)

Estado: **implementação LOCAL**, sem commit, branch `codex/aplicador-100-production-20261026` sobre staging `a590d247bb11a8e687447707dc0c368ac20b07db`. Nada foi executado em nenhum banco. Este documento não autoriza aplicação.

Origem: backlog B-3 do plano de promoção (`kidmais-manager-planejamento-production-20261025/docs/PLANO_PROMOCAO_PRODUCTION_20261025.md`). A 100 (agenda com um salão: uma festa por vez no horário `POR_HORARIO`) só troca o corpo de `kidmais094_conflito_ocupacao`. Ela vem **depois do E6**: código novo publicado (a tela e o servidor já gravam capacidade 1 e trazem este aplicador e os SQL) e 094 aplicada pelo escopo 094 do aplicador da 092–094 (B-1). O núcleo e os SQL são os da #236 (aplicador de staging, já usado em 25/10/2026), sem mudança de comportamento.

## O que foi criado ou alterado

| Arquivo | Conteúdo |
| --- | --- |
| `scripts/migration-100-production.cjs` | adaptador novo: alvo fixo de produção (`srv-dak77m2d0e5s73b8rkkg`, `dpg-dak750gae00c73fudmg0-a`, `kidmais_production`, 5432), TLS obrigatório (`DATABASE_SSL=true`, mínimo TLSv1.2, certificado conforme `DATABASE_SSL_REJECT_UNAUTHORIZED`), identidade provada no servidor (banco, TLS ativo 1.2/1.3, endereço privado), disco persistente (dispositivo diferente do pai, não link), registro `data/agenda-um-salao-100-producao`, `application_name` próprio e ordem do runbook |
| `scripts/migration-100-comum.cjs` | só `ordem: amb.ordem ?? <ordem de staging>` no plano e comentários. Staging continua com a ordem dele |
| `scripts/bloco-shell-100.cjs` | ambiente `production` (`CONFERIR`, `APLICAR`): confere o sha256 do adaptador de produção, dos dois núcleos e dos 4 SQL; guarda do serviço de produção; linha de aviso "somente depois do E6"; sem `conexao-staging.cjs` |
| testes | `scripts/migration-100-production.test.cjs` (7, novo); `scripts/bloco-shell-100.test.cjs` (10 → 14: 4 de produção); passo novo no `ci.yml` |

## Integridade composta (#236)

O aplicador usa a integridade da 094 com o corpo da 100 (`INTEGRIDADE_094_APOS_100`, `database/checks/20261025_094_integridade_apos_100.sql`, sha `855ad392…`) depois do postcheck e na conferência de uma 100 já aplicada. Estados pelo sha256 do corpo da função: corpo da 094 (`b6aac1c0…`) = ausente; da 100 (`805cd427…`) = completa; sem função = sem 094 (recusa `DEPENDENCIA_AUSENTE_100 094`); qualquer outro corpo, inclusive o da 098, = divergente (recusa `CORPO_DIVERGENTE_100`). Depois da 100, o `--conferir-094` do aplicador de produção da 092–094 (B-1) responde pela mesma integridade (`PASS_CORPO_100`).

## Ordem em produção (plano sem conexão)

1. E6 concluído: código novo publicado (conferir commit e hashes implantados) e 094 aplicada, `--conferir-094` PASS.
2. `--conferir-100` (somente leitura; inventário de pares no mesmo horário).
3. Backup restaurável de production registrado (dump conferido + PITR; export funcional não substitui).
4. Autorização de Felipe **para a 100** (separada da 094).
5. Janela combinada: sem escritas de agenda/festas nem DDL concorrente.
6. `--conferir-100` de novo, imediatamente antes.
7. `--aplicar-100-autorizado --backup "<registro>"` (uma vez; marcador exclusivo `migration-100.json`).
8. `--conferir-100`: `JA_APLICADA_INTEGRIDADE_PASS`.
9. `--conferir-094` do aplicador de produção da 092–094 (integridade da 094 com o corpo da 100).

Recusas antes de qualquer escrita: sem 094, 098/deriva, dependência 093/094/062 ausente, falta de DONO/CREATE/LINGUAGEM/TIPOS, pares de ocupações futuras no mesmo horário (> 0; decisão de Felipe, nada é remarcado). Códigos: 0 plano/conferido/PASS; 1 recusa antes de conectar; 2 FALHA registrada (`commit` = CONFIRMADO, DESFEITA_PELO_SERVIDOR ou INDETERMINADO; nunca repetir); 3 conferência RECUSARIA. O down `20261025_100_agenda_um_salao_down.sql` nunca é executado pelo aplicador: rollback manual com autorização própria e coordenado com o código (o down reabre a capacidade gravada; o código novo continua gravando capacidade 1).

## Uso (artefato de revisão — não executar sem autorização)

```text
node scripts/migration-100-production.cjs                                             # plano, sem conexão
node scripts/migration-100-production.cjs --conferir-100                              # somente leitura
node scripts/migration-100-production.cjs --aplicar-100-autorizado --backup "<registro>" # depois do E6, uma vez
node scripts/bloco-shell-100.cjs production <CONFERIR|APLICAR> <rotulo-da-arvore>     # blocos do Web Shell
```

## Validação local (sem banco)

- `scripts/migration-100-production.test.cjs` 7/7, `scripts/migration-100.test.cjs` 12/12 (staging preservado), `scripts/bloco-shell-100.test.cjs` 14/14 (bash e `bash -i` reais em diretório temporário; aplicador real recusando fora do Render): 33/33. ESLint dos 5 arquivos sem erro; `git diff --check` limpo.
- Composição com o B-1: as três suítes rodadas numa cópia com o `migration-092-094-comum.cjs` do clone do B-1 (exports usados pela 100 preservados): 33/33.
- Mutantes em cópia isolada (controle 33/33), todos derrubados: sem `TLS_OBRIGATORIO`, certificado sempre ignorado, identidade sem rede privada, identidade sem TLS, TLS de qualquer versão, disco sem checagem de dispositivo, ordem de staging em produção, serviço de staging no alvo, banco sem trava, bloco de produção com o aplicador de staging, bloco de produção com a guarda de staging, bloco sem o aviso do E6.
- `npm run check:v1:static` código 0 (3599 + 103 testes, 0 falhas; 2 avisos de ESLint preexistentes em arquivos não tocados; `next build` compilado); o `next-env.d.ts` reescrito pelo build foi restaurado. As suítes da 100 rodam pelos passos próprios do `ci.yml`.

## Limites e pendências

- **Nenhum PostgreSQL executado** (nem descartável): o mesmo núcleo foi aplicado em staging em 25/10/2026 (CONFERIR 092–094 `PASS_CORPO_100`), mas o adaptador de produção (TLS/identidade com `pg_stat_ssl` e `inet_server_addr`) só se prova num ensaio isolado autorizado ou na própria conferência de produção.
- O tempo do inventário (120 s de `statement_timeout`) não foi medido com o volume de produção.
- Depende do B-1 (escopo 094) e do código novo publicado (B-4/E5); a 098 continua PAUSADA e é recusada.
- Revisão independente pendente.

## Revisão independente — rodada 1 (REPROVADO: 1 P2 + 1 P3) e correção

- **P2** — depois de conectar, se o marcador deixasse de gravar (por exemplo, `ENOSPC` logo após o COMMIT confirmado), a nova tentativa de gravação dentro do tratamento da falha também lançava erro, e a CLI imprimia `RECUSADO` com código 1 (reservado para recusa antes de conectar). O marcador ficava `EM_ANDAMENTO`, sem o COMMIT. Correção no núcleo (`scripts/migration-100-comum.cjs`, vale para staging e produção): o estado do COMMIT fica em memória e a gravação final do marcador é protegida. A saída é sempre `FALHA`, código 2, com `commit` (CONFIRMADO, DESFEITA_PELO_SERVIDOR, INDETERMINADO ou nulo), `reconciliar`, `marcadorAtualizado` e, quando a gravação falha, `erroMarcador` e o aviso `MARCADOR_DESATUALIZADO` ("copiar esta saída; não repetir"). O marcador antigo continua no disco e impede uma segunda tentativa. Regressão nova cobre 5 momentos com o disco cheio: COMMIT confirmado, indeterminado, desfeito, antes da migration e só na gravação final de um sucesso. Em todos: código 2, COMMIT correto, marcador `EM_ANDAMENTO`, repetição recusada e a migration sem nova execução.
- **P3** — o título do bloco APLICAR pedia "export/PITR" também em produção. Agora a instrução de backup é de cada ambiente: produção pede "dump conferido e PITR; export funcional NAO substitui", e a mensagem `BACKUP_NAO_INFORMADO` também. Os blocos de staging continuam byte a byte iguais aos da #236 (conferido gerando os dois). O formato da referência continua sendo a única validação automática: provar que é um dump conferido segue sendo passo do operador no runbook.
- Validação: suítes da 100: 34/34 (produção 8, staging 12, blocos 14), também com o núcleo do B-1. `npm run check:v1:static` repetido: código 0 (3599 + 103; 2 avisos preexistentes; build compilado); `next-env.d.ts` restaurado. Mutantes em cópia isolada (controle 34/34): os 12 da rodada inicial e 4 novos (marcador volta a escapar, marcador declarado atualizado, backup "export/PITR" em produção, mensagem genérica de falta de backup), todos derrubados. ESLint e `git diff --check` limpos.
- Composição (observação do revisor): os blocos devem ser regenerados da árvore final integrada. Com o B-1, o hash de `scripts/migration-092-094-comum.cjs` muda de `f72efc0a…` para `1446a178…`, e blocos gerados antes recusam a diferença com código 4.

## Re-revisão — APROVADO COM RESSALVAS (P2 e P3 da rodada 1 fechados; 1 P3 de cobertura) e ajuste

- P2 e P3 da rodada 1 fechados. Sem P1/P2 novos.
- **P3 (cobertura)** — o caso "só a gravação final falha" ativava o disco cheio quando a consulta de integridade aparecia no log; a gravação seguinte era o `registrar` do fim dessa etapa, antes da gravação `CONCLUIDA`. Ajuste só no teste (`scripts/migration-100-production.test.cjs`): a falha começa exatamente quando o conteúdo gravado tem `situacao: 'CONCLUIDA'` e continua nas tentativas seguintes. O teste confirma: código 2, COMMIT `CONFIRMADO`, aviso, exatamente 2 gravações falhas (a `CONCLUIDA` e a do tratamento), marcador `EM_ANDAMENTO` com as 4 etapas `ok`, `APLICADA_POSTCHECK_PASS` e estado final `completa`, e repetição bloqueada. Mutante novo (a gravação `CONCLUIDA` engolida em silêncio) derrubado. Total: 17 mutantes, controle 34/34; suítes 34/34; ESLint limpo. O núcleo não mudou nesta rodada.
- Ressalva mantida: `writeFileSync` não é atômico, então uma falha real pode truncar o marcador. Ele continua existindo e bloqueia a repetição (criação exclusiva `wx`), mas o conteúdo pode ficar ilegível. Nesse caso, valem a saída copiada da CLI e o `--conferir-100`. Os mocks lançam antes de escrever.
- Pendente: ensaio PostgreSQL autorizado e regeneração dos blocos na árvore integrada.
