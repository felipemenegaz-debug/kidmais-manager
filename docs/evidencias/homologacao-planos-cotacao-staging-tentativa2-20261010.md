# Evidência — homologação planos/cotação em staging, tentativa 2 (10/10/2026, UTC)

Candidata `8cd598f14f0254437c3a8d0088b77afc9727c645` (docs `a17777b`). Serviço `srv-daif418ae00c73e8k2gg`, banco `kidmais_staging_1z91`, Asaas sandbox. Produção não tocada. Saídas sanitizadas (sem segredos, dados de clientes ou IDs do provedor).

## N0 — restauração da tentativa 1

- Painel: removidas só `COTACAO_PUBLICA_POR_EMPRESA` e `ASSINATURA_PLANOS_ATIVOS` (“Save only”; 72 → 70 variáveis, conferido no DOM antes de salvar).
- `trigger_deploy` `dep-db50spvlot8c73das1ig` (commit `235b082`), LIVE 10:13:40Z.
- Shell: `RENDER_GIT_COMMIT=235b082…`; `--conferir-restauracao` → `{"resultado":"RESTAURADA", ambas presente:false, divergencias:[]}`.

## N1 — push

`235b082..a17777b` em `staging` (fast-forward). `git diff --name-only 8cd598f a17777b` = só o pacote em `docs/`. Auto-deploy OFF, branch `staging` (revalidados).

## N2 — chaves e deploy da candidata

- Render MCP merge: as duas chaves `true` → deploy automático `dep-db50vsid0e5s73dqf8u0` (commit `a17777b`), LIVE 10:20:24Z; `/api/health` 200.
- Shell: `a17777b… staging true true`.

## N3 — 076/077

PITR conferido no painel (janela de 3 dias). Diretório antes: só `configuracao-anterior.json` e `migrations-076-077.json` (tentativa 1, 09:31); nenhum processo da homologação.

```
{"resultado":"PASS","arquivo":"migrations-076-077.tentativa-2.json","tentativa":2,
 "conexao":{"banco":"kidmais_staging_1z91","tls":false,"redePrivada":true},
 "schemaAntes":{"m076":false,"m077":false},
 "etapas":[precheck 076 ok {clientes_com_cpf:5, legado_sem_empresa_com_cpf:1}, migration 076 ok,
           postcheck 076 ok {indice:clientes_cpf_empresa_canonico_uk, aprovado:true},
           precheck 077 ok {empresas_kidmais:1, kidmais_ativa:1}, migration 077 ok,
           postcheck 077 ok {empresas_com_regra:1, aprovado:true}],
 "enderecoAtual":{"codigo_kidmais":true,"tem_regra":true}}
```

## N4 — executor (PID 166, início 10:24:18Z) — PARADA S4

```
etapas: FIXTURES, CATALOGO, WEBHOOK, CHECKOUT_F1
falha: {"etapa":"CHECKOUT_F1","parada":"S4","mensagem":"FUNDADOR_S4"}
resultado: INCOMPLETO; resultados: {}
prova: {fixtures:true, assinaturas:{F1:false,F2:false,F5:false}, webhook:false}
fixtures: DESATIVADAS; webhook: NADA_CRIADO_PELA_RODADA
assinaturasSandbox: F1/F2/F5 NADA_CRIADO_PELA_RODADA; falhasEncerramento: []
```

- Nenhum checkout, cobrança ou assinatura sandbox criada; nenhuma vaga Fundador reservada (a parada ocorre na leitura da oferta, antes de `checkout`).
- Encerramento concluído pela própria rodada; recuperação (`--encerrar…`) desnecessária.
- Causa: `lib/assinatura/ofertas.ts` — toda empresa nova pagante é elegível ao Fundador enquanto houver menos de 20 vagas ocupadas; em staging a matriz paga sempre para em S4. Critério previsto, não defeito.
- Matriz de financeiro, cotação, regra não zero, contratos F2/F4 e preservação **não executadas** (vêm depois dos checkouts).

## Deploy externo durante N4

`dep-db511obhu5js73dg2ii0`, commit `bc95ca4` (“Corrige layout dos campos do convite (#151)”, descendente de `a17777b`, só `components/convites/editor-admin.module.css`), disparado pela conta de Felipe às 10:18 (enfileirado), iniciado 10:20:24Z, LIVE 10:26:38Z, trocou a instância. A rodada já tinha terminado antes da troca (saída completa em `saida.log`).

## N5 — restauração

- Painel: removidas só as duas chaves (“Save only”; 72 → 70).
- `trigger_deploy` `dep-db516v142hec73fbm3gg` do commit da branch, `bc95ca4` (o mesmo já LIVE pelo deploy externo; não é o SHA da candidata).
- LIVE 10:35:19Z. Shell: `RENDER_GIT_COMMIT=bc95ca4…`; `--conferir-restauracao` → `{"resultado":"RESTAURADA", ambas presente:false, divergencias:[]}`.
- `/api/health` 200; `/b/hml-planos-profissional/fechamento` 404; `/api/fechamentos/pacotes?empresa=hml-planos-profissional` 404.
- Shell encerrado (página deixada). 076/077 permanecem aplicadas em staging.

## Estado final de staging

Código `bc95ca4` (deploy externo + redeploy de N5), chaves ausentes como no registro, 076/077 aplicadas, fixtures F1–F5 desativadas (regra de pagamento de F4 permanece ligada à fixture desativada, nunca apagada), nenhuma assinatura/cobrança sandbox nem vaga Fundador criada pela rodada.

## Pendente

- Matriz paga bloqueada por Fundador (S4) em staging: precisa de alternativa sintética aprovada por Felipe antes de nova rodada (com novos IDs de fixtures).
- Rodada nova exige nova aprovação; a tentativa 2 não se repete sobre o mesmo estado (`rodada.json` presente).
