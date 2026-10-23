# Pacotes de créditos de IA — implementação LOCAL (22/10/2026)

**Estado:** implementação e validação **locais**. Nada foi publicado, aplicado em staging/produção, cobrado no Asaas
(nem sandbox) ou enviado a provedor de IA. Preços, franquias, validade, cortesias, tetos e garantia ampliada continuam
**PROPOSTAS** de `docs/PLANO_PACOTES_CREDITOS.md` (commit documental `aa706ad`), sem aprovação comercial, jurídica ou fiscal.

- Clone `kidmais-manager-creditos-20261022`, `core.autocrlf=false` antes do checkout, branch `codex/creditos-ia-20261022`.
- Base: `origin/staging` **326895e** (merge #202, devolução L1 + 089, já integrada com a exportação verificável 3bb7b4b).
  O plano foi escrito sobre 3bb7b4b, quando a 089 ainda estava em outro clone; agora ela está na base.
- Migration: **095** (`20261022_095_ia_creditos.sql`). A 1ª entrega usou **090**; a revisão independente de 22/10 (P2-1)
  apontou colisão com trabalhos locais paralelos do mesmo dia — `kidmais-manager-cpf-fundador-20261022` (090 campanha
  Fundador, 091 documento fiscal do contratante) e `kidmais-manager-agenda-precos-20261022` (092 preços por quantidade,
  093/094 agenda) — e a migration foi **renumerada para 095** (arquivos, guarda `kidmais_095_guarda()`, aplicadores, blocos,
  testes, flags de aplicação `--aplicar-095-autorizado`). Busca em 22/10 depois da renumeração: `origin/staging` f2cd0fc
  termina na 089; nenhuma branch remota (`git ls-tree` de todas as `origin/*`) tem `_09x_`; nos clones locais, só este usa
  095. A 087 continua reservada aos avisos de cobrança (clone `kidmais-manager-emails-cobranca-20261019`, não integrada).
  Livre numa leitura não é reserva: repetir antes de congelar a candidata e antes de aplicar; a ordem de aplicação com
  090–094 (se integradas antes) não muda nada na 095, que não depende delas.
- **Reintegrada localmente com o staging `b3735a9` (23/10, até #218):** merge local `3152e3f`; conflitos só por acréscimo dos
  dois lados (staging com 092–094 aplicadas em staging, branch com 095): seletor e receita PG, checagem de migrations de
  produção e seu teste, contexto e exportação. A 095 vem depois da 094; as suítes dos créditos e o E2E usam o modelo 094; a
  exportação, o 095 (inclui 092–094). Número 095 conferido em 23/10: livre em todas as `origin/*`; clones locais com 096/097
  (CPF/Fundador). Nada enviado ao remoto.
- **Integrada localmente com o staging (22/10):** merge local de `origin/staging` **9e096a7** (#203–#208, sem migration
  depois da 089) no commit `e68d402`; único conflito em `scripts/regressao-v1-selecao.cjs` (mantidas as suítes dos créditos
  e as novas de pacotes). Revalidado depois do merge (ver §7, rodada 6). Nada foi enviado ao remoto.

## 1. Arquitetura

| Camada | Arquivo | Papel |
|---|---|---|
| Schema | `database/migrations/20261022_095_ia_creditos.sql` (+ precheck, postcheck, rollback) | 11 tabelas, guarda única `kidmais_095_guarda()` (22 gatilhos) |
| Domínio puro | `lib/creditos/dominio.ts`, `catalogo.ts`, `config.ts` | alocação de lotes, decisão sobre o pagamento lido, devolução, datas SP, flags, catálogo |
| Extrato | `lib/creditos/ledger.ts` | carteira, lotes, lançamentos, reservas; ordem única de travas; conferência independente |
| Compra | `lib/creditos/compra.ts` | pedido (Gestão + senha), um POST de cobrança avulsa, vínculo durável |
| Pagamento | `lib/creditos/pagamento.ts` | **serviço único** do webhook e da reconciliação (reconsulta, crédito único, estorno, disputa) |
| Devolução | `lib/creditos/devolucao.ts` | garantia por compra / saldo não usado, cancelamento do remanescente, estorno por flag própria |
| Convites | `lib/creditos/convites.ts` + `lib/convites/service.ts` | um motor por empresa; reserva 1 crédito por geração |
| Corte | `lib/creditos/corte.ts`, `scripts/creditos-corte-legado.cjs` | legado → créditos por empresa, simulação/aplicação explícitas |
| Manutenção | `lib/creditos/manutencao.ts`, `scripts/creditos-manutencao.cjs` | expiração, franquia mensal das cortadas, avisos de vencimento, outbox |
| Cortesia | `lib/creditos/cortesia.ts` | só operador da plataforma, campanha com teto, protocolo |
| Wall-e | `lib/creditos/walle.ts` | reserva/liquidação em µUS$ (API pronta, **não ligada** ao atendimento) |
| Leitura | `lib/creditos/servico.ts` | saldo (toda a empresa); pedidos, extrato, catálogo e devoluções (Gestão) |
| Rotas | `app/api/admin/creditos/{,pedido,devolucao}/route.ts`, `app/api/desenvolvedor/creditos/route.ts` | Admin (sessão/tenant) e painel do operador |
| Tela | `components/admin/AssinaturaCreditos.tsx` (em Assinatura), ajuste em `ConviteEditor.tsx` | saldo, compra, pedidos, devolução, extrato, avisos |

### Tabelas (095)

`ia_credito_carteiras` (empresa × recurso; saldo/reservado/bloqueado; `CONVITES` só nasce pelo corte), `ia_credito_lotes`
(origem FRANQUIA/COMPRA/CORTESIA/LEGADO, quantidade, preço pago, vencimento; contadores somam a quantidade),
`ia_credito_lancamentos` (extrato **append-only**: CREDITO, RESERVA, LIBERACAO, CONSUMO, BLOQUEIO, DESBLOQUEIO, EXPIRACAO,
REVERSAO, com deltas checados por tipo), `ia_credito_reservas` + `ia_credito_reserva_lotes` (alocação congelada),
`ia_credito_pedidos`, `ia_credito_cobrancas` (vínculo pedido ↔ pagamento por conta/ambiente; uma canônica por pedido;
disputa e exposição), `ia_credito_devolucoes`, `ia_credito_cortesias`, `ia_credito_cortes`, `ia_credito_notificacoes`
(outbox). Diferença do plano: **+2 tabelas** (cortesias e cortes) para a auditoria da concessão e a conciliação exportável do
corte que o plano exigia.

Invariantes no banco: valores inteiros não negativos; `reservado + bloqueado <= saldo`; soma dos contadores do lote =
quantidade; FKs compostas com `empresa_id` (lote/reserva/pedido de outra empresa é recusado); extrato sem
UPDATE/DELETE/TRUNCATE; pedido, lote, cobrança, devolução, cortesia e corte nunca apagados; transições de pedido e devolução
controladas; soma das devoluções ≤ valor pago (pedido travado no gatilho). Correção = lançamento de compensação.

### Ordem única de travas

`[convite] → [pedido] → carteira (empresa, recurso) → lotes por (vence_em, id) → [orçamento global dos Convites]`.
A trava da carteira serializa reserva, consumo, liberação, expiração, crédito e devolução. Provado no PG com duas conexões
reais (espera observada em `pg_blocking_pids`, sem `sleep` como prova).

## 2. Fluxos

**Compra (Gestão, senha ≤ 5 min).** Oferta, preço, quantidade e validade vêm do catálogo do servidor; a tela só confirma
preço e versão dos termos (mudou → 409). Transação curta: idempotência por chave (mesmo conteúdo → mesmo pedido; outro
conteúdo → 409), assinatura paga apta, carteira de Convites já cortada, limites (5/h por pessoa, 10/h por empresa,
3 pendentes, R$ 1.000/dia — sugestões do plano), pedido `CRIACAO_EM_CURSO` com protocolo `KM-AAAAMMDD-XXXXXXXX`, fotografia
da oferta e hash dos termos. Fora de transação: **um** `POST /v3/payments` (avulsa, sem `subscription`, `billingType`
PIX/CREDIT_CARD/BOLETO, `externalReference = km:<ambiente>:creditos:<pedido>`). 4xx definitivo → `FALHOU_CRIACAO`;
timeout/rede/5xx/resposta inválida → `CRIACAO_INCERTA` (nunca repete o POST; a reconciliação procura pela referência).
Cartão: só a fatura hospedada do Asaas (nenhum campo de cartão na página).

**Confirmação.** Webhook autenticado grava a inbox (`cobranca_eventos`); o despacho manda o pagamento avulso para
`lib/creditos/pagamento.ts` (nunca para o sincronizador da assinatura). O serviço trava o pedido e **reconsulta** o Asaas:
`CONFIRMED`/`RECEIVED` com id, referência, cliente, valor e forma conferidos credita **uma** vez (lote COMPRA único por
pedido); `AUTHORIZED`/pendente aguarda; valor/forma/cliente/referência divergentes, dinheiro fora do provedor ou cobrança
duplicada → `REVISAO`. Vencido pago depois: credita com validade a partir de agora (política proposta do plano). A
reconciliação diária usa o mesmo serviço.

**Devolução de pacote** (separada da 089; flag própria `CREDITOS_ESTORNO_ATIVO`). Garantia de 7 dias **por compra**
(integral, mesmo com uso) e, depois, saldo pago não usado pelo preço original (exige nenhuma geração em andamento no lote).
Na mesma transação: devolução com cálculo imutável e **cancelamento do remanescente** (reservas em andamento terminam sem
reabrir crédito). Sem a flag ou boleto: `AGUARDANDO_MANUAL` (fila do operador, conclusão com referência pelo painel). Com a
flag e Pix/cartão: registro prévio `EM_CURSO` e um POST de estorno; resultado desconhecido → `SEM_CONFIRMACAO` (nunca
repetido). `REFUNDED` lido do provedor conclui. Pedido pelo atendimento (login inacessível): mesma regra, origem ATENDIMENTO.

**Disputa/chargeback.** Bloqueia só o remanescente do lote e registra a exposição (parte usada pelo preço original) na
cobrança; favorável desbloqueia uma vez; estorno/perdida cancela o remanescente. Carteira nunca negativa.

**Convites.** Um motor por empresa: sem carteira CONVITES (sem corte) → legado (`convite_carteiras`/`convite_consumos`, como
antes); com carteira → só o motor novo (sem fallback). Autorização 088 e confirmação de foto/galeria continuam **antes** da
reserva; cotas por festa/cliente e teto global diário inalterados. Geração concluída consome 1; não enviada devolve; incerta
mantém reservado ("em verificação"); decisão do operador consome ou devolve. Flag `CREDITOS_CONVITES_CONSUMO_ATIVO`
desligada: empresa cortada recebe 503 ("manutenção", alternativa sem IA); encerrar reservas existentes funciona sempre.
O legado reconfere o motor depois de travar `convite_carteiras` (corte concorrente nunca deixa dois motores).

**Corte do legado** (`scripts/creditos-corte-legado.cjs`): simulação por padrão; `--aplicar --autorizacao "<registro>"`
cria carteira (`corte_em`), lote LEGADO = `max(0, limite − usado)` do mês (vence no fim do mês) e o registro do corte.
Recusa com geração RESERVADA/INCERTA. Idempotente. Produção: só simulação nesta versão. Nunca no startup.

**Franquia mensal** (worker, só empresas cortadas): o **mesmo limite legado** configurado em `convite_carteiras`, com acesso
COMPLETO, `FRANQUIA:<AAAA-MM>` (uma por mês, sem acumular). As franquias propostas 5/15/30 **não** são aplicadas.

**Wall-e:** API em µUS$ (reserva do máximo, custo desconhecido mantém reserva e pede parada, excedente absorvido e
`suspender`), exige `CREDITOS_WALLE_CONSUMO_ATIVO` **e** os gates do atendimento (R6, receptor, contatos). Não está ligada ao
orquestrador do atendimento; nenhuma oferta Wall-e aparece enquanto ele estiver indisponível.

## 3. Configuração (só nomes; valores nunca no código)

| Variável | Padrão | Efeito |
|---|---|---|
| `CREDITOS_CATALOGO_ATIVO` | desligada | mostra o catálogo |
| `CREDITOS_COMPRA_ATIVA` | desligada | aceita novos pedidos (exige catálogo) |
| `CREDITOS_CONVITES_CONSUMO_ATIVO` | desligada | novas reservas no motor novo (empresas cortadas) |
| `CREDITOS_WALLE_CONSUMO_ATIVO` | desligada | carteira do Wall-e (com os gates do atendimento) |
| `CREDITOS_ESTORNO_ATIVO` | desligada | estorno automático de pacote (Pix/cartão) |
| `CREDITOS_CATALOGO_APROVADO` | — | produção: tem de repetir a versão de um catálogo com `aprovacao` registrada no código |
| `CREDITOS_ASAAS_CONTA` | `padrao` | rótulo não secreto da conta (separa ids de contas) |

Só o texto exato `true` liga. Em produção (`KIDMAIS_DEPLOY_ENV=production`) o catálogo de demonstração
(`PROPOSTA-20261022-DEMO`, `aprovacao: null`) é **sempre** recusado, qualquer que seja a flag. Desligar compra/consumo nunca
desliga webhook, reconciliação, histórico, devolução ou encerramento de reservas.

## 4. Publicação futura (não autorizada aqui)

Matriz provada localmente: **código sem 095** → fluxos antigos intactos, `instalado=false`, compra 503, exportação registra as
10 tabelas como ausentes; **095 com flags desligadas** → nenhuma oferta, cobrança, concessão ou consumo novo.
Ordem: código com flags off → `--conferir-095` → backup/PITR → `--aplicar-095-autorizado --backup "<registro>"` →
`--conferir-095` → exportação conferida → corte por empresa (autorização de dados) → flags em staging com sandbox → homologação.
Aplicadores `scripts/migration-095-{comum,staging,production}.cjs` e blocos `scripts/bloco-shell-095.cjs` derivados dos da
089 (gerador `creditos-gerar-aplicador-095.cjs` no workspace, mesmas trocas conferidas e hashes calculados dos SQL LF).

Hashes (LF, depois das correções do parecer R5 de 23/10; os mesmos fixados nos aplicadores): migration `0dac1771…dd9af7e4e`,
precheck `470f3b13…9a6438`, postcheck `8b33991e…296f9c`, rollback `da0c65da…160507`.

**Rollback:** preferir desligar as flags e manter o processamento de pagamentos/devoluções. O SQL de rollback recusa com
qualquer registro (obrigações financeiras) e nunca devolve empresa cortada ao legado.

## 5. Exportação

As 10 tabelas de dados da empresa estão no inventário (`lib/exportacao/entidades.ts`, grupo "Créditos de IA"); o outbox
fica em `FORA_DO_ESCOPO`. Excluídas por motivo: chaves técnicas de repetição/deduplicação (`chave_idempotencia`,
`payload_sha256`, `chave_origem`, `operacao`, `operacao_id`), `url_fatura` (token de acesso), `conta`, `referencia_externa`,
`exposicao_centavos`/`revisao_motivo` (controle interno), motivo/operador da cortesia e referência da autorização do corte.
Retrato `lib/exportacao/colunas-esperadas.json` regenerado e revisado; suítes de exportação passam a declarar o modelo 095.

## 6. Reconciliação e alertas (D-C4)

`scripts/assinatura-reconciliar.cjs`: eventos de cobrança avulsa pelo mesmo serviço; pedidos abertos/incertos/em revisão e
disputas revisitados por item (simulação = ROLLBACK; produção só conferência); fila somente leitura em itens
`PEDIDO_CREDITOS`, `DEVOLUCAO_CREDITOS`, `RESERVA_CREDITOS`, `DISPUTA_CREDITOS`, `DIVERGENCIA_CARTEIRA` e (P2-5)
`COBRANCA_CREDITOS` com `ESTORNO_EXTERNO_PARCIAL`.
**Decidido por Felipe em 22/10 (D4):** pago sem crédito (inclui `PAGO_APOS_CANCELAMENTO` e as divergências de valor/forma/
cliente/referência), pagamento duplicado, estorno externo parcial, arrependimento vencido e divergência de carteira são
`CRITICO` e alarmam em toda conferência até resolução (substituto de Felipe ainda não definido). `DOCUMENTO_FISCAL` não
existe (NFS-e fora desta versão).

**Caminho de escrita em produção (P2-3).** `scripts/creditos-manutencao.cjs` e `scripts/creditos-corte-legado.cjs` aceitam
`--aplicar` em produção **somente** com `--autorizacao "<registro>"` (ASCII, 6–120 caracteres, gravado no relatório); sem
ele, recusam antes de conectar. A manutenção, com o Asaas configurado, revisita os pedidos de `pedidosParaReconciliar` pelo
mesmo serviço do webhook (uma transação por pedido; simulação = ROLLBACK). Saídas do operador para o que pede ação humana
(`lib/creditos/operacao.ts`, rota `/api/desenvolvedor/creditos`, concessão + senha recente + auditoria):
`reprocessar_pedido`, `resolver_revisao` (`CREDITAR` só com o pagamento relido agora como CONFIRMED/RECEIVED;
`ENCERRAR` com referência), `concluir_cobranca_extra` (duplicado devolvido no painel do Asaas) e `resolver_bloqueio`
(`LIBERAR`/`CANCELAR` o saldo bloqueado por estorno externo parcial). Toda ação exige referência (3–200, sem quebra de linha).

## 7. Testes executados (22/10/2026, locais)

| Verificação | Resultado |
|---|---|
| `lib/creditos/creditos.test.ts` (regras, flags, catálogo, Asaas avulso com fetch falso, webhook, CLIs) | 13/13 |
| `npm run check:v1:static` (rodada final) | **EXIT 0**: unitários 3276/3276, harness 103/103, lint 0 erros (1 aviso preexistente em `lib/inteligencia/skills/catalogo.ts`), TypeScript e build OK. A 1ª rodada apontou 1 erro de lint no componente novo (`set-state-in-effect`), corrigido |
| PG descartável `lib/creditos/creditos-095.postgres.test.ts` (modelo 089 + 095) | 10/10 na 1ª entrega; **12/12** depois do fechamento da M16 (duas rodadas seguidas) |
| PG `lib/creditos/aplicador-095.postgres.test.ts` | 1/1 |
| PG exportação (`exportacao` 3/3, `exportacao-adversarial` 6/6, modelo 095) | 9/9 |
| `scripts/migration-095.test.cjs` + `scripts/bloco-shell-095.test.cjs` | 21/21 |
| PTY real (MSYS2 `script.exe`, bash interativo) — `pty-095.cjs` | 9/9 (Ctrl-C: sem linha de código, como 088/089 → "parar e ler") |
| Playwright `scripts/creditos-ui.cjs` (Chrome headless, Asaas dublê, desktop + 390 px, flags on/off) | 8/8 cenários |
| `npx tsc --noEmit` | sem erros |
| `npm run build` (avulso e dentro da regressão estática) | OK; rotas `/api/admin/creditos{,/pedido,/devolucao}` e `/api/desenvolvedor/creditos` compiladas |
| Mutações dirigidas na suíte PG (harness do implementador; não é revisão independente) | 16 mutantes: **14 eliminados pela falha esperada**, 2 sobreviventes (ver abaixo); M01/M08 originais inconclusivos (erro do próprio mutante) e substituídos por M01b/M08b, eliminados |

**Mutações (22/10).** Eliminados pela asserção esperada: M01b filtro de empresa dos lotes (FK composta da alocação + "B
intacta"), M02 extrato aceita UPDATE (mensagem da guarda ausente), M03 `reservado+bloqueado<=saldo` (recusa esperada
ausente), M04 FK do extrato sem empresa (postcheck + recusa da FK), M05 crédito sem conferir valor (`VALOR_DIVERGENTE`),
M06 pedido creditado credita de novo (webhook duplicado: 2º evento FALHOU pela guarda do pedido), M07 webhook sem despacho
(sem espera da trava/sem crédito), M08b Convites ignora a flag (recusa 503 ausente), M09 dois motores ("um motor por
empresa"), M10 devolução sem cancelar o remanescente, M11 liberação reabre lote devolvido, M12 corte com geração aberta,
M13 URL da fatura exportada, M15 liberação de lote vencido volta ao disponível. **Sobreviventes:** M14 (sem o limite da
soma das devoluções no gatilho) — equivalente na prática, pois `UNIQUE (pedido_id)` e o CHECK `valor ≤ valor_pago` já
impedem exceder o pago (defesa em profundidade sem teste próprio); M16 — ver abaixo. Relatórios:
`handoff-revisao-creditos-ia-20261022/mutacoes-r2-16.txt` e `mutacoes-r3-corrigidos.txt`.

**Fechamento da M16 (22/10, mesma data).** Dois testes novos com duas conexões reais: (a) corte aberto e geração pelo
serviço real — a geração espera o corte na trava da empresa (`empresas FOR UPDATE`, antes de escolher o motor) e depois usa
só o motor novo, sem debitar o legado; (b) geração já em curso (mesma ordem de travas da geração) e corte — o corte espera
na trava da empresa, sem deadlock, e a fotografia inclui o consumo legado. Achado: tirar o `FOR SHARE` da empresa no corte
causa **deadlock** (mutante **M17**, eliminado com `40P01 deadlock detected`); a trava foi mantida e documentada. Com a
ordem empresa → `convite_carteiras` nos dois lados, a reconferência do motor (M16) é **equivalente** — inalcançável pelos
caminhos atuais, mantida como defesa em profundidade; M16 sobrevive com a suíte determinística (`mutacoes-r5-m16-m17.txt`).
Uma rodada intermediária (`mutacoes-r4-m16-m17.txt`) foi **inconclusiva** para M16: o teste de expiração dependia de uma
janela de 300 ms; ele foi reescrito sem tempo (o lote vence no banco descartável depois da reserva) e passou em duas rodadas.

**Rodada 3 (22/10): renumeração 095 e correções P2 da revisão independente.** Parecer
`revisao-creditos-ia-20261022/PARECER.md` (APROVADO COM RESSALVAS, 0 P1, 6 P2, 9 P3). Correções: P2-1 renumeração; P2-2
`ENCERRADO → REVISAO` (`PAGO_APOS_CANCELAMENTO`, reconciliação revisita); P2-3 saídas do operador e escrita em produção só
com `--autorizacao`; P2-4 chave de e-mail por notificação e destinatário; P2-5 `refunds[]`/estorno parcial; P2-6 liberação
durante disputa continua bloqueada. P3-4 também (e-mail não configurado não consome tentativas). Validação da rodada:

| Verificação | Resultado |
|---|---|
| `lib/creditos/creditos.test.ts` | 15/15 (P2-4 com 2 destinatários e repetição; `refunds[]`; CLIs com `--autorizacao`) |
| PG créditos (novo teste "095 (P2 da revisão)") | **13/13** em três rodadas |
| PG aplicador 095, exportação 3/3 e adversarial 6/6 (modelo 095) | PASS |
| Aplicadores/blocos 095 | 21/21 |
| `npm run check:v1:static` | EXIT 0 (testes, lint, TS, build) |
| PTY real `pty-095.cjs` | 9 sessões, 0 falhas |
| Playwright `scripts/creditos-ui.cjs` | 8/8 |
| Mutações das correções (N1–N12; harness do implementador) | **12/12 eliminadas** pela falha esperada (N1 pela guarda: `ENCERRADO → CREDITADO` recusado; N11/N12 pela unitária). Relatório `creditos-mutacoes-r6.txt` |

**Rodada 4 (22/10): revisão do delta 095.** Parecer `revisao-creditos-ia-20261022/PARECER-DELTA-095.md` (APROVADO COM
RESSALVAS, 0 P1; P2-1/2/4/6 fechados, P2-3 parcial aceito, P2-5 parcial com o P2-N1 novo; 6 P3 novos). Correções:

- **P2-N1:** `estornado_centavos` passa a ser o valor de estorno já **tratado**; só um aumento é episódio novo. A mesma soma
  relida depois de `resolver_bloqueio` não realarma nem bloqueia; um 2º estorno maior bloqueia de novo. As operações do
  extrato levam o valor (`ESTORNO_PARCIAL:<cobrança>:<tratado>`, `…_LIBERADO/_CANCELADO:<cobrança>:<tratado>`).
- **P3-2:** `resolver_revisao ENCERRAR` relê a cobrança canônica e recusa `PAGAMENTO_CONFIRMADO_DEVOLVER_ANTES` enquanto o
  pagamento estiver CONFIRMED/RECEIVED (devolver no painel do Asaas antes); sem leitura, recusa.
- **P3-4:** as ações por protocolo travam o pedido (`FOR UPDATE`) antes de ler o estado; ENCERRAR confere o `rowCount`.
- **P3-5:** a auditoria de `resolver_revisao` grava `precoCentavos` e `valorLidoCentavos` (aceitar valor divergente segue
  sendo decisão do operador, agora com os dois valores registrados).
- **P3-6:** `CLIENTE_DIVERGENTE`/`REFERENCIA_DIVERGENTE` só são CRÍTICOS com a cobrança canônica CONFIRMED/RECEIVED.
- **Limites aceitos (documentados, sem código):** P3-1 — pedido em revisão por `COBRANCA_DUPLICADA` (sem cobrança canônica)
  só pode ser encerrado e devolvido (`concluir_cobranca_extra`), não creditado; a escolha do cliente por créditos nesse caso
  pede uma nova compra. P3-3 — a janela de 90 dias para revisitar pedido `ENCERRADO` cobre Pix e boleto do piloto; um
  pagamento depois disso ainda chega pelo webhook (que relê e vai a revisão), só deixa de ser procurado pela reconciliação.

Validação: unitários 15/15; PG créditos 13/13 em duas rodadas (aplicador, exportação e adversarial PASS); `check:v1:static`
EXIT 0; Playwright 8/8; SQL sem mudança (hashes dos aplicadores inalterados). Mutações Q1–Q6: **6/6 eliminadas** pela
asserção esperada (`creditos-mutacoes-r7.txt`). Não cobertos por teste: a trava do P3-4 (corrida não determinística) e a
liberação repetida do mesmo episódio.

**Rodada 5 (22/10): revisão do delta 2.** Parecer `revisao-creditos-ia-20261022/PARECER-DELTA-095-R2.md` (APROVADO COM
RESSALVAS, 0 P1; P2-N1, P3-2/4/5 fechados). **P2-N2** corrigido: o ramo `REVISAO` de `processarPedido` passa a gravar
`situacao_provedor` com o status lido desta cobrança (leitura de outro pagamento não conta), e o CRÍTICO de cliente/referência
divergente com dinheiro recebido (D4) dispara no caminho real. O teste do P3-6 foi reescrito para chegar ao estado só pelo
`processarPedido` com o dublê (PENDING → não crítico; RECEIVED → crítico, nada creditado), sem `replica`. Validação: PG
créditos 13/13 em duas rodadas (aplicador, exportação e adversarial PASS), `check:v1:static` EXIT 0; mutações R1b/R2/R3
**3/3** pela asserção esperada (R1 original inconclusivo: quebrava a SQL ao deixar `$3` sem uso; reescrito como R1b).
SQL da 095 sem mudança. Observação do parecer não tratada (P3): a releitura de estorno já tratado faz uma escrita idempotente.

**Onde ficam os créditos (22/10, decisão de Felipe).** Página própria **Configurações › Créditos de IA**
(`/admin/configuracoes/creditos`, cartão no hub e item no menu de Configurações, autoridade da Gestão como a API
`exigirGestao`). Dois blocos separados: **Créditos de convite** e **Créditos do WhatsApp.AI** (sempre visível; sem o Wall-e liberado
para a empresa mostra só "ainda não está ativo", sem venda), cada um com saldo, pacotes, pedidos, devolução e extrato próprios. A **Assinatura** fica só com
o plano e um link "Ver créditos de IA"; o convite da festa mantém a linha de saldo com link para a página. A rota entra nas
abertas com a empresa bloqueada (ver saldo e pedir devolução de pacote pago; a compra recusa no servidor). Uma tentativa
anterior (cartões no convite e em Atendimento, `5708892`) foi substituída a pedido de Felipe. Validação: `check:v1:static`
EXIT 0; Playwright 9/9 (passo 9: Configurações → página, Assinatura com link, convite e Atendimento sem cartão, Equipe sem o
cartão); PG créditos 13/13.

**Rodada 6 (22/10): integração com o staging e P3 residuais.** Merge local de `origin/staging` 9e096a7. P3 do primeiro
parecer e do delta 2:

- **P3-1 (banco):** amarras novas e nomeadas — lote de compra só do recurso do pedido (`ia_credito_lotes_pedido_fk`);
  alocação da reserva com `recurso` nas duas FKs (`ia_credito_reserva_lotes_{reserva,lote}_fk`; coluna `recurso` nova em
  `ia_credito_reserva_lotes`, imutável na guarda e no retrato da exportação); devolução com cobrança e lote do **mesmo**
  pedido (`ia_credito_devolucoes_{cobranca,lote}_fk`). O postcheck confere as cinco pelo nome e com três colunas.
  **Não feito:** gatilho que impeça UPDATE direto de contadores sem lançamento (segue detectado só pela conferência).
- **P3-2:** conta da cobrança conferida (`CONTA_DIVERGENTE`); `CREDITOS_ASAAS_CONTA` inválida falha fechado (venda
  `CONTA_INVALIDA`; `contaProvedor` lança); pedidos `CREDITADO` dos últimos 90 dias são relidos pela reconciliação (estorno
  total feito fora com webhook perdido).
- **P3-3:** cada disputa da mesma cobrança é um episódio do extrato (`DISPUTA:<cobrança>:<n>`); a 2ª contestação bloqueia
  de novo e a 2ª favorável devolve de novo.
- **P3-5:** sem Gestão, os lotes não levam o protocolo do pedido.
- **P3-6:** o texto da devolução diz que a equipe Kidmais faz a restituição até o prazo quando ela está na fila manual
  (piloto), e "enviada ao Asaas" só quando o estorno automático está ligado.
- **P3-7:** catálogo sem aprovação só em `KIDMAIS_DEPLOY_ENV=staging` ou execução local (fora do Render e de
  `NODE_ENV=production`); qualquer outro ambiente é tratado como produção.
- **Delta 2, P3:** a releitura de um estorno já tratado não escreve mais na cobrança.
- **Não tratados:** P3-8 (HTTP dentro da transação, decisão documentada), P3-9 (pontos do sandbox), P3-1/P3-3 do delta
  (limites documentados).

Validação da rodada: unitários 15/15; **suíte PostgreSQL completa 117/117 arquivos** (inclui as de pacotes vindas do
staging); `check:v1:static` EXIT 0; aplicadores/blocos 21/21 com os hashes novos; PTY real 9 sessões, 0 falhas; Playwright
9/9; mutações T1–T7 **7/7** pela falha esperada (`creditos-mutacoes-r9.txt`).

**Rodada 7 (22/10): parecer R4 do Astra (REPROVADO, 4 P2 + 2 P3).** `revisao-creditos-ia-20261022/PARECER-DELTA-095-R4.md`.

- **R4-P2-1 (reconciliação presa nos mesmos 200):** `selecionarParaReconciliar` com duas filas — pendências primeiro (mais
  antigas) e creditados dos últimos 90 dias por um cursor durável, `ia_credito_cobrancas.conferida_em` (coluna nova,
  gravada a cada leitura do provedor, excluída da exportação como controle interno), com cota mínima de 1/4 do limite;
  filtro por ambiente; `truncado` vira item `RECONCILIACAO_TRUNCADA`/`TRUNCADO` nos relatórios.
- **R4-P2-2 (conta inválida derrubava assinaturas):** webhook, reconciliador, manutenção e rota do desenvolvedor validam a
  conta antes e, se inválida, desligam só os créditos (eventos de créditos ficam FALHOU `CREDITOS_SEM_PROVEDOR`; item
  `CONFIG_CONTA_INVALIDA`); o ciclo das assinaturas segue.
- **R4-P2-3 (disputa com tudo reservado):** retenção e perda decididas pelo **estado** (cobrança canônica com disputa
  ABERTA/estorno externo parcial → retém; devolução registrada, disputa PERDIDA ou estorno total externo → cancela), não
  pela quantidade já bloqueada/cancelada.
- **R4-P2-4 (página aberta, API bloqueada):** exceções do paywall por método e caminho exatos — GET `/api/admin/creditos`,
  GET `/api/admin/creditos/pedido` e POST `/api/admin/creditos/devolucao`; compra continua recusada.
- **R4-P3-1:** o postcheck confere nome, tabela de origem, de destino e o par ordenado de colunas de cada FK nova.
- **R4-P3-2:** Wall-e liberado sem carteira aparece com saldo zero e pacotes (primeira compra possível).

Validação da rodada: unitários 27 (créditos, paywall, contratação) e 24 (reconciliador); PG dos créditos 13/13; suíte PG
completa 116/117 na rodada concorrente com o build — `login-origem` (#208) teve 40 timeouts de conexão no teste de 50
logins simultâneos com scrypt enquanto a regressão estática rodava em paralelo; sozinha passou nos dois estados
(`creditos-pg-r24-login.log`); `check:v1:static` EXIT 0; aplicadores/blocos 21/21; PTY 9/0; Playwright 9/9 na 2ª tentativa
(a 1ª abortou a navegação durante a compilação do servidor de desenvolvimento, sem erro no log); mutações U1–U8 **8/8**
pela falha esperada (`creditos-mutacoes-r10.txt`). Não coberto por teste: R4-P3-2 (Wall-e sem carteira) só por código.

**Rodada 8 (23/10): parecer R5 do Astra (REPROVADO, 2 P2; quatro dos seis itens R4 fechados).**
`revisao-creditos-ia-20261022/PARECER-DELTA-095-R5.md` (sha256 `462954d7…`).

- **R5-P2-1 (pendências estáveis travavam a fila):** coluna nova `ia_credito_pedidos.reconciliado_em` como cursor da fila de
  pendências (`ORDER BY reconciliado_em NULLS FIRST, criado_em`). `marcarTentativa` grava a tentativa em transação própria
  ANTES de processar (reconciliador e manutenção), então pendência estável ou com erro vai para o fim da fila; a guarda não
  renova `atualizado_em` quando só a marca muda (a janela de 90 dias do ENCERRADO não cresce). Excluída da exportação.
  Simulação/conferência (ROLLBACK) não grava a marca: ali a fila não avança — a recuperação real é pelo modo que aplica.
- **R5-P2-2 (CANCELAR com tudo reservado se perdia):** `resolverBloqueio` CANCELAR grava `ESTORNO_PARCIAL_CANCELADO` na
  cobrança (não alarma); a liberação posterior cancela por esse estado; um estorno maior depois não reabre a decisão
  (bloqueia e cancela na hora). LIBERAR continua limpando o motivo.

Validação da rodada (sobre o merge `3152e3f` com o staging `b3735a9`): PG dos créditos 13/13; aplicador 095, exportação e
adversarial PASS (modelos 094/095); **suíte PG completa 128/129** — a falha é `lib/comercial/pacotes-1c.postgres.test.ts`
("current transaction is aborted"), que falha **igual no staging puro `b3735a9`** (worktree temporária, mesma suíte:
`creditos-pg-r28-staging-pacotes1c.log`), sem relação com os créditos; `check:v1:static` EXIT 0 (1 aviso de lint
preexistente); aplicadores/blocos 21/21; PTY 9/0; Playwright 9/9 (o E2E passou a escolher "Fazer depois" no assistente da
agenda que o staging abre para empresa sem agenda); mutações V1–V7 **7/7** (`creditos-mutacoes-r11.txt`).

Cluster PostgreSQL 18 descartável: `127.0.0.1:55667`, `cluster_name=kidmais_descartavel`, diretório
`ambientes-locais/pg-descartavel-creditos-20261022`, bancos `kidmais_pacotes_v1_*`/`kidmais_v1_modelo_*`; identidade provada
antes de cada execução; sem o banco `kidmais_manager`.

## 8. Limites e pendências

- **NÃO EXECUTADO:** sandbox Asaas (roteiro abaixo), staging, produção, provedor real de IA, e-mail real.
- Não implementado: teto operacional por empresa/recurso (US$/dia e mês) e limites de gerações simultâneas/hora por empresa
  sugeridos no plano (o teto global diário e 1 geração em andamento por festa continuam); proporcionalidade de franquia no
  1º mês/upgrade (o plano pede validação comercial antes); NFS-e; integração do Wall-e ao orquestrador; tela do operador
  para a fila (há rota `/api/desenvolvedor/creditos`, sem UI); e-mails de saldo baixo (aviso só na tela).
- Uma devolução por pedido (a devolução cancela todo o remanescente). Saldo não usado fora da garantia exige nenhuma geração
  em andamento no lote.
- Textos legais e preços **não** publicados; as minutas do plano seguem sem parecer jurídico (Felipe não tem jurídico: publicar
  é decisão dele com risco assumido, D5 revista em 22/10).
- Decisões de 22/10 por delegação de Felipe: `docs/DECISOES_CREDITOS_IA_20261022.md` (D1 preços do piloto e validade,
  D2 garantia, D3 pagamento tardio, D4 CRÍTICO, D5 pareceres). Pendentes de código: franquia por plano/proporcional, regra
  da 3ª devolução, nova versão aprovada do catálogo (a lacuna do pedido `ENCERRADO` pago foi fechada na P2-2). Pendentes externos:
  4 respostas fiscais da agência contábil (`pacote-revisao-creditos-juridico-contador-20261022/03-EMAIL-CONTADOR.md`), medição de custo,
  substituto de Felipe.

### Roteiro de homologação em sandbox (NÃO EXECUTADO)

1. Staging com código (flags off) e 095 aplicada por autorização própria; `ASAAS_AMBIENTE=sandbox`, conta exclusiva,
   `CREDITOS_ASAAS_CONTA` definida; empresa sintética com assinatura de teste e corte autorizado.
2. Ligar catálogo/compra só em staging; comprar Pix, cartão e boleto; conferir fatura hospedada, retorno e acessibilidade.
3. Confirmar com `POST /sandbox/payment/{id}/confirm`; webhook real autenticado; reenvio do mesmo evento; perda de evento
   (desligar webhook) recuperada pela reconciliação; cartão recusado/análise de risco; cobrança vencida paga depois.
4. Estorno integral/parcial com `CREDITOS_ESTORNO_ATIVO=true`; saldo insuficiente; resultado incerto (sem repetição).
5. Conferir contagens, saldo, extrato (`conferirCarteira`), D-C4 e exportação. Chargeback não existe no sandbox: limitação
   (coberto só por dublê). NFS-e: aceite separado do contador.
