# Pacote consolidado de 10/10/2026 — G1–G4, inventário 076/077, concorrência, navegador e rodada de pagamento+renovação

**Status: PRONTO PARA APROVAÇÃO, NÃO EXECUTADO.** Nenhum push, deploy, mudança de variável ou operação de banco foi feito para este pacote. A janela D+2 de staging é preservada: nada em staging antes do “pode ir” de Felipe ([OPERACAO_AGENTES.md](OPERACAO_AGENTES.md)).

## Candidata

- **Código: `6acdb60375d43f50a51d169bfad73bc358954b03`**; este documento e os pacotes estão no commit seguinte (só `docs/`), cujo SHA é o do pedido de aprovação. `git diff --name-only 6acdb60375d43f50a51d169bfad73bc358954b03 HEAD` deve listar só `docs/`.
- Base: `origin/staging` `f88b39e` (fast-forward; nenhum commit externo integrado depois dele até o fechamento deste pacote — revalidar antes de P1).

## O que muda no produto (vai para staging no P1 da rodada; produção só por pacote próprio)

| Item | Mudança | Efeito em runtime |
|---|---|---|
| G1 | `DepsRenovacao.relogioReal` (opcional) só na janela de 23 h da retentativa do aviso | nenhum sem o parâmetro; o processador geral não o usa |
| G2 | `scripts/assinatura-renovar-restrito.cjs`: lista explícita de empresas, simulação por padrão, recusa de produção e de serviços que não sejam o web de staging; **`--agora` com `--aplicar` fora de banco local só para fixtures de homologação** (conferido no banco antes de processar) | nenhum (execução manual e autorizada; fora de qualquer cron) |
| G3 | `POST /api/integracoes/resend/webhook`: assinatura Svix, `email.bounced/complained/failed` → `AVISADA → REVISAO`, idempotente, auditado | **desligado (503) sem `RESEND_WEBHOOK_SECRET`** |
| G4 | `GET /api/desenvolvedor/renovacoes` + alerta no painel do desenvolvedor; empresas desativadas e fixtures **continuam visíveis**, distinguidas (real ativa: ALTA/MEDIA; real desativada: MEDIA “(empresa desativada)”; fixture: INFO “(fixture de homologação[, desativada])”; reais antes de fixtures) | leitura, só desenvolvedor, sem dado pessoal |
| Inventário | `scripts/production/check-migrations.mjs` inclui 076/077 como pendentes de autorização explícita em produção (como 074/074a/075); GO/NO-GO de produção passa a listá-las | nenhum em staging; produção continua exigindo autorização própria para aplicar |

Regra única de fixture (`ehFixtureHomologacao`): código com prefixo `hml-` **e** nome iniciado por `TESTE `. Empresa real nunca é classificada como fixture por um só dos critérios.

## Pacotes e ordem recomendada

| Ordem | Pacote | Alvo | Efeito permanente | Aprovação |
|---|---|---|---|---|
| 1 | [Concorrência](CONCORRENCIA_VAGAS_ISOLADO_20261010.md) C1–C6 | cluster PostgreSQL 18 local descartável `127.0.0.1:55480` | nenhum fora da pasta `.local-concorrencia-pg-*` (git-ignorada) | própria |
| 2 | [Navegador local](NAVEGADOR_LOCAL_20261010.md) | cluster local `127.0.0.1:55481` + `next dev` em `localhost:3481`, contas sintéticas | nenhum fora de `.local-navegador*` (git-ignorada) | própria |
| 3 | [Pagamento + renovação em staging](HOMOLOGACAO_PAGAMENTO_RENOVACAO_STAGING_20261010.md) P1–P4 | staging + Asaas sandbox, **depois da janela D+2** | **3 vagas Fundador `CONFIRMADA` para sempre** (campanha 3/2 → 6/5 se nada mudar antes), 3 contratações confirmadas, 3 registros de renovação (F1 `REVISAO`, F2/F5 `CANCELADA`), 3 cobranças sandbox pagas, 5 fixtures desativadas | própria |
| depois | Configuração externa do G3 (cadastro do webhook no Resend, `RESEND_WEBHOOK_SECRET` no ambiente-alvo) e caminho de conexão do G2 a partir do Shell | staging (e produção só por pacote próprio) | variável de ambiente nova; deploy disparado pela gravação | própria |

Os passos 1 e 2 são locais e independentes de staging; podem rodar durante a D+2. O passo 3 usa as duas chaves (`ASSINATURA_PLANOS_ATIVOS`, `COTACAO_PUBLICA_POR_EMPRESA`) só durante a janela e restaura o registro (ambas ausentes).

## Configuração comum

- E-mail: **SINK** na rodada de staging (nenhum envio); arquivo local nos testes de navegador.
- Ajuste de vencimento: **somente no Asaas sandbox**, somente nas assinaturas mensais da rodada (F1 Essencial, F5 Premium), com o estado anterior gravado antes; nenhuma data de banco ou relógio do sistema é alterado.
- Portas locais: 55480 (concorrência), 55481 (navegador), 3481 (servidor local).

## Recuperação

- Código: `git revert` dos commits do pacote em `staging` + deploy autorizado (G3 desligado sem segredo; G4 só leitura; G2 manual).
- Configuração de staging: P4 da rodada (`--conferir-restauracao` → `RESTAURADA`).
- Rodada interrompida: modo `--encerrar-pagamento-renovacao-rodada-3-autorizada` (prova de autoria; idempotente).
- Locais: parar servidor/cluster e remover a pasta pela marca de autoria da ferramenta `cluster-descartavel-postgres.cjs`.
- **Sem rollback:** vagas e contratações `CONFIRMADA`, registros de renovação e cobranças pagas do sandbox (074/075 e o provedor não permitem desfazer).

## Validação local (candidata)

| Verificação | Resultado |
|---|---|
| Testes unitários sem banco (conjunto do `check:v1:static`) | 2247/2247 |
| Testes de scripts afetados (rodadas, sonda, conexão, aplicador, restauração, ensaio, concorrência, cluster, navegador) | 169/169 |
| Verificação de produção (`scripts/production/production.test.mjs`) | 37/37 (076/077 pendentes de autorização explícita) |
| Harness de staging (mocks) | 103/103 |
| Planos offline de concorrência e seed do navegador | `confere: true`, 79 migrations, impressão `8a9a97477eac3d046dbd891bfd601df6e8f301f469247ef1e5e0f13403e03cfb` |
| TypeScript, build de produção, worker de PDF | aprovados |
| ESLint | 0 erros (1 aviso preexistente) |
| `git diff --check` | limpo |

## Pendências fora deste pacote

- Regra padrão de pagamento para buffets sem regra (hoje 0%).
- Manifestos antigos do ensaio de 09/10 (`docs/evidencias/assinatura-schema-completo-20261009.json`, `assinatura-webhook-schema-20261009.json`) já estavam desatualizados (76/194 vs 77/197 até a 075); não foram regravados.
- Produção: 074/074a/075/076/077 continuam pendentes de autorização explícita.
