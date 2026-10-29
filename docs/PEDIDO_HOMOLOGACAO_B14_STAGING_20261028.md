# Pedido de homologação do B-14 em staging/sandbox (28/10/2026, rev. 13 — PREPARAÇÃO, nada autorizado)

Documento local. Nada aqui foi executado em staging, production, GitHub (além de leitura) ou Asaas. Ele prepara a
homologação do item 5 da §11 do plano (`docs/PLANO_RECUPERACAO_PAGAMENTOS_B14_20261027.md`, rev. 8.1) e lista o que
falta ANTES de pedir as autorizações.

## 1. Onde estamos

- **H0 concluído (28/10/2026).** HB-1, HB-3, HB-4, HB-5 e HB-7 fechados pelo Astra; HB-2 era falso. Aberto só o HB-6, que se resolve no passo H3.0 (staging).
- Clone `kidmais-manager-recuperacao-pagamentos-b14-20261028`, branch `codex/recuperacao-pagamentos-b14-20261028`, base staging `db8d083b`, sem commit. Acumulado `5424c0d0…` (60 entradas), árvore mínima `27eae3af…` (45 arquivos, Node 22.23.2, pg 8.23.0, zod 4.5.4).
- **Staging andou (leitura de 28/10):** `origin/staging` = `04e1e985` (#259–#264), 14 commits à frente da base. Nenhuma migration nova; nenhum arquivo da árvore mínima mudou (os `lib/` alterados são agenda, contratos, fechamentos, http, mcp/oauth e inteligência, fora do fecho da árvore). Sobreposição com o B-14 só em `scripts/regressao-v1-selecao.cjs`, os dois lados com acréscimos. No H1 a árvore e o acumulado são recalculados depois do merge.
- Fora do commit do H1: `next-env.d.ts` (regerado pelo `next dev`) e o plano `docs/PLANO_RECUPERACAO_PAGAMENTOS_B14_20261027.md` só se Felipe quiser versioná-lo.
- **Próxima autorização: H1** (merge do staging na branch, commit, push e PR para `staging`). D-HML-2 e D-HML-3 só são necessárias antes do H6 e do H7.

## 2. Bloqueios achados nesta preparação (antes de qualquer pedido)

Leituras feitas: `git fetch` de `staging` e `production` e comparação local. Não houve consulta ao Render, a banco ou ao Asaas.

| ID | Bloqueio | Evidência | O que resolve |
| --- | --- | --- | --- |
| HB-1 | **O schema do staging está fora da lista de prefixos do B-14.** `PREFIXOS` (`lib/assinatura/recuperacao-baseline.ts:23`) vai de P0a a P11 (089, 092, 093, 099, 090, 094, 095, 096, 097, 100, 091). O staging já tem 102, 103 e 105 aplicadas (27/10) e o código de 104/106 (#258, `db8d083b`, 28/10). `prefixoDoSchema` devolve `null`, então no staging a entrada só admite `--fila`: CONFERIR, RECUPERAR, INVENTARIO, APLICAR-CASO, CONFERIR-CASO e LIBERACAO recusam com `SCHEMA_FORA_DA_LISTA` (código 1). | `git ls-tree origin/staging database/migrations/`; memória das aplicações em staging (102/103 e 105 aplicadas em 27/10; 104/106 a confirmar) | **D-HML-1** (abaixo) + uma rodada de código com revisão do Astra |
| HB-2 | ~~A lista provavelmente está velha para production.~~ **Corrigido na rev. 2: não está.** A D-ESC-3 = (a) (Felipe, 27/10) deixa 102/103 **fora desta promoção**, com o código dormente, e 104/105/106 não constam do plano de promoção. P0a…P11 é exatamente a cadeia do runbook (089, 092, 093, 099 → código → 090, 094, 095, 096, 097, 100, 091). | `PLANO_PROMOCAO_PRODUCTION_20261025_DECISOES.md:21`; plano de promoção :345 | nada a mudar para production |
| HB-3 | **A §11 põe a homologação depois dos itens 2 e 3**, que ainda estão abertos: matriz PG em cada prefixo, matriz da §3.3.1 e mutantes avaliados pela fotografia. | doc de implementação, "Ainda fora" e "Próximos incrementos" | **incremento 6** (local, PG descartável já autorizado) |
| HB-4 | O procedimento operacional `docs/RECUPERACAO_PAGAMENTOS_B14.md` não existe. | — | incremento 6 |
| HB-5 | O runtime de destino (Node 22.23.2) nunca foi exercitado; os testes rodaram em Node 24.20.0. | `node -v` local | baixar o Node 22.23.2 portátil (pedir antes) ou aceitar a conferência da ENTREGA-CONFERIR no próprio staging |
| HB-6 | Não se sabe se o web de staging tem alguma variável `PG*` ou `NODE_PG_FORCE_NATIVE`. Se tiver, toda conexão recusa (`AMBIENTE_COM_VARIAVEL_PG`, decisão aceita pelo Astra). | — | passo H3.0 (só nomes, nunca valores) |
| HB-7 | A branch está 30 commits atrás do staging (`db8d083b`). | `git rev-list --count` | merge do staging na branch antes do PR. Sobreposição só em `.github/workflows/ci.yml` e `scripts/regressao-v1-selecao.cjs`, ambos com acréscimos. Nenhum `lib/` da árvore mudou no staging, e o lock tem o mesmo pg 8.23.0 e zod 4.5.4. |

### Estado dos bloqueios (rev. 3)

- **HB-1: resolvido localmente.** D-HML-1 = B (Felipe, 28/10): o prefixo `PH` vale só em sandbox. A suíte PG passa nos modelos 097, 103 (o staging de hoje) e 106. Falta a revisão do Astra.
- **HB-2: era falso** (rev. 2).
- **HB-7: resolvido.** O trabalho foi para o clone `kidmais-manager-recuperacao-pagamentos-b14-20261028`, sobre o staging `db8d083b`. A árvore ficou idêntica.
- **HB-3 e HB-4: rev. 4 REPROVADA pelo Astra (5 P2, 2 P3); rodada 1 local, aguardando o Astra (rev. 5).** Inclui a D-HML-4 (exposição da disputa aberta acompanha o consumo), **decidida por Felipe em 28/10/2026**. Rodada 1 REPROVADA (3 P2, 1 P3) → rodada 2 local (rev. 6), com a **D-HML-5, aceita por Felipe em 28/10/2026**: a disputa favorável não desfaz a retenção de estorno parcial pendente. Rodada 2 REPROVADA (2 P2, 1 P3) → rodada 3 local (rev. 7): base com a forma do schema (formato 2), máscara do instante no hash comparável, efeitos completos com comprovante, combinações por código, D-HML-5 integrada e o timeout investigado. Rodada 3 REPROVADA (1 P2, 1 P3; HB-4 fechado) → rodada 4 local (rev. 8): §3.3.1 em 14 modelos, liberação com crédito correto/incorreto e fila recusada/interrompida, timeout instrumentado (KIDMAIS_DIAGNOSTICO_PG) e §11 retificada. Rodada 4 APROVADA COM RESSALVAS pelo Astra 28/10 (P2 fechado; 3 P3: prazo do diagnóstico, causa do timeout, PLANO:191). Rodada 5 local (rev. 9): diagnóstico com prazo e relançamento garantido, causa do timeout registrada como desconhecida com evidências por rodada (D-HML-6 ACEITA por Felipe 28/10: risco residual do timeout local aceito), plano :184/:191 retificado. Rodada 5 APROVADA COM RESSALVAS pelo Astra 28/10 (1 P3: evento error da conexão de diagnóstico sem tratador) → rodada 6 local (rev. 10): ouvinte de error durante toda a vida da conexão, com testes sem banco. Rodada 6 APROVADA pelo Astra 28/10: HB-3 FECHADO. HB-5 exercitado localmente em 28/10 (rev. 11): Node 22.23.2 portátil, 2 defeitos corrigidos (relógio unref do diagnóstico; PATH da PTY no teste), CI 32/32 e PG 32/32 no Node 22. HB-5 APROVADO pelo Astra 28/10 (sem achados; parecer em revisao-b14-hb5-20261028/PARECER.md): **HB-5 FECHADO localmente** — Windows não certifica o Linux do Render; a ENTREGA-CONFERIR no staging segue no roteiro. Aberto: HB-6; nada autorizado. Matriz PG em cada prefixo com o pacote entregue (13 modelos), §3.3.1 completa (achou e corrigiu a disputa PERDIDA), mutantes pela fotografia e o procedimento `docs/RECUPERACAO_PAGAMENTOS_B14.md`.
- **HB-5 FECHADO localmente (Astra 28/10); HB-6 continua aberto.**

## 3. Decisões pedidas a Felipe

- **D-HML-1 — DECIDIDA: B (Felipe, 28/10/2026).** Lista de prefixos (rev. 2; a rev. 1 partia do HB-2 errado). Fato: no staging, além de P11, estão 102, 103 e 105 (aplicadas) e talvez 104/106. Nenhuma delas cria ou altera tabela do domínio do B-14:
  - 102: `agenda_saloes` e as tabelas de itens e fotos dos salões;
  - 103: uma linha em `adicional_categorias`;
  - 105: as tabelas `mcp_oauth_*`;
  - 104/106: revisão da agenda e salão preferido.

  Opções:
  - **A' — não serve:** "estender com a ordem da promoção" não muda nada, porque a promoção é exatamente P0a…P11 e o staging continuaria fora da lista.
  - **B (recomendada):** um prefixo de homologação `PH`, aceito **só** quando o ambiente for `sandbox`: P11 mais as migrations neutras listadas por número **e** pela impressão digital do conteúdo (sha do arquivo). O teste estático prova que nenhuma delas toca as tabelas da fotografia; em production, `PH` recusa sempre. Prova o caminho de production no estado P11 com as tabelas reais, e o neutro fica restrito ao sandbox.
  - **C:** homologar no staging só `--fila` e a entrega. Não prova JANELA nem RESTORE, e o item 5 da §11 fica aberto.
  - **D:** homologar num banco de staging restaurado em P11 (cópia, sem 102+). Exige restore e infraestrutura própria, com autorização mais pesada.
- **D-HML-2 — massa de teste no sandbox.** Os casos do item 5 (filtros de data positivos e negativos, evento `PENDENTE`, cobrança sem registro local) pedem cobranças no Asaas **sandbox** e, em alguns casos, linhas criadas ou removidas no banco de staging. Isso é escrita no sandbox e no staging, com autorização própria. A alternativa é homologar só com o que já existe no staging (TESTE S3 e similares) e registrar o que não foi coberto.
- **D-HML-3 — ensaio do RESTORE no staging.** Inclui ligar a manutenção do web de staging e **reiniciá-lo com a manutenção ligada** (a prova de drenagem em três partes), com o site de staging fora do ar durante o ensaio. Também é preciso definir qual cron faz no staging o papel do `7ce0916f` (D-B14-18). Proposta: o cron de reconciliação de staging, disparado manualmente, só conferência.

## 4. Roteiro proposto (depois de HB-1 a HB-4 resolvidos)

Cada passo tem o seu critério de PASS. Qualquer código diferente do esperado faz PARAR e ler.

| Passo | O quê | Onde | Autorização | PASS |
| --- | --- | --- | --- | --- |
| H0 | Incremento 6 (prefixo PH só em sandbox, se D-HML-1 = B; matriz PG; mutantes por fotografia; procedimento) + Astra | local | já coberta (local + PG descartável) | Astra APROVADO |
| H1 | Merge do staging na branch, commit, push, PR para `staging` | GitHub | **push + PR** | CI do GitHub verde; diff só com os arquivos do B-14 |
| H2 | Merge e deploy do web de staging. O código fica inerte, porque nada roda sem os blocos. | GitHub + Render | **merge + deploy staging** | deploy live com o commit do PR; health ok. Rollback: o deploy anterior. |
| H3.0 | Shell do web de staging: `env \| cut -d= -f1 \| grep -E '^(PG\|NODE_PG_FORCE_NATIVE)' \|\| echo SEM_PG` (só nomes) | Render Shell | **A-B14-L (staging)** | `SEM_PG`; senão parar (HB-6) |
| H3 | ENTREGA-1..N + ENTREGA-CONFERIR, gerados para `staging` com a candidata = commit do deploy | Render Shell | A-B14-L (staging) | `ARVORE_OK`, runtime v22.23.2, `EQUIVALENCIA_LIB … diferentes=0` |
| H4 | FILA (GET dos webhooks no sandbox) | Shell + Asaas sandbox (leitura) | A-B14-L (staging) | código 0 ou a exceção `interrupted` da §3.7 documentada |
| H5 | CONFERIR com `--selar-base`, depois CONFERIR com `--base` (linha de base sem agravamento); filtros de data positivos e negativos | Shell + banco de staging (DML revertido) | A-B14-L (staging) | códigos 0/2/3 conforme a §3.10; base selada; comparação sem `BASELINE_INVALIDA` |
| H6 | RECUPERAR em staging sobre os casos da D-HML-2, com export novo antes | Shell + banco de staging (escrita) | **A-B14-R (staging)** + D-HML-2 | código 0; CONFERIR depois sem divergência |
| H7 | Ensaio do RESTORE: manutenção → reinício → DRENAGEM → INVENTARIO → decisões → APLICAR-CASO/CONFERIR-CASO (um caso) → LIBERACAO → conferência pelo cron (D-HML-3) → desligar a manutenção | Render + Shell + banco de staging | **A-B14-C (staging)**, A-B14-L, **A-B14-O por caso** | drenagem nas três partes; liberação só com tudo `SEM_EFEITO`; site de volta |
| H8 | Medir as ressalvas do incremento 4: limite de 10 s da consulta da trava sob carga, e rollback no servidor depois do descarte da conexão (`pg_stat_activity`) | Shell + banco de staging | A-B14-L (staging) | medida registrada; sem transação presa |
| H9 | LIMPEZA com `KIDMAIS_B14_ENCERRAMENTO=SIM` e o registro final | Shell | A-B14-L (staging) | `LIMPEZA_FIM`; só `casos-*.json` e a árvore removidos |

**Fora da homologação:** qualquer passo em production, escrita no Asaas de production, e a 098 (pausada).

## 5. O que pedir depois

Quando H0 estiver aprovado, o pedido de autorização terá, por passo:
- o commit;
- os sha e os bytes de cada bloco gerado para `staging`;
- as variáveis `KIDMAIS_B14_*` de cada colagem;
- o que cada passo grava;
- o rollback.

As aprovações históricas (rev. 8.1, incrementos) não autorizam nenhum desses passos.
