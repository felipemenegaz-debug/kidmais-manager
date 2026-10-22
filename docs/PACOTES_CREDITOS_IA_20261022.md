# Pacotes de créditos de IA — implementação LOCAL (22/10/2026)

**Estado:** implementação e validação **locais**. Nada foi publicado, aplicado em staging/produção, cobrado no Asaas
(nem sandbox) ou enviado a provedor de IA. Preços, franquias, validade, cortesias, tetos e garantia ampliada continuam
**PROPOSTAS** de `docs/PLANO_PACOTES_CREDITOS.md` (commit documental `aa706ad`), sem aprovação comercial, jurídica ou fiscal.

- Clone `kidmais-manager-creditos-20261022`, `core.autocrlf=false` antes do checkout, branch `codex/creditos-ia-20261022`.
- Base: `origin/staging` **326895e** (merge #202, devolução L1 + 089, já integrada com a exportação verificável 3bb7b4b).
  O plano foi escrito sobre 3bb7b4b, quando a 089 ainda estava em outro clone; agora ela está na base.
- Migration escolhida: **090** (`20261022_090_ia_creditos.sql`). Busca em 22/10: nenhum `_090_`/`_091_` em clones locais,
  branches remotas (`git ls-tree` de todas as `origin/*`) ou checks; a 087 continua reservada aos avisos de cobrança
  (clone `kidmais-manager-emails-cobranca-20261019`, não integrada). Livre numa leitura não é reserva: repetir antes de
  congelar a candidata e antes de aplicar.

## 1. Arquitetura

| Camada | Arquivo | Papel |
|---|---|---|
| Schema | `database/migrations/20261022_090_ia_creditos.sql` (+ precheck, postcheck, rollback) | 11 tabelas, guarda única `kidmais_090_guarda()` (22 gatilhos) |
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

### Tabelas (090)

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

Matriz provada localmente: **código sem 090** → fluxos antigos intactos, `instalado=false`, compra 503, exportação registra as
10 tabelas como ausentes; **090 com flags desligadas** → nenhuma oferta, cobrança, concessão ou consumo novo.
Ordem: código com flags off → `--conferir-090` → backup/PITR → `--aplicar-090-autorizado --backup "<registro>"` →
`--conferir-090` → exportação conferida → corte por empresa (autorização de dados) → flags em staging com sandbox → homologação.
Aplicadores `scripts/migration-090-{comum,staging,production}.cjs` e blocos `scripts/bloco-shell-090.cjs` derivados dos da
089 (gerador `creditos-gerar-aplicador-090.cjs` no workspace, mesmas trocas conferidas e hashes calculados dos SQL LF).

Hashes (LF): migration `c429ccde…c5083`, precheck `ab25a876…8e131`, postcheck `231b13d3…cd553`, rollback `0a6851cb…c987b`.

**Rollback:** preferir desligar as flags e manter o processamento de pagamentos/devoluções. O SQL de rollback recusa com
qualquer registro (obrigações financeiras) e nunca devolve empresa cortada ao legado.

## 5. Exportação

As 10 tabelas de dados da empresa estão no inventário (`lib/exportacao/entidades.ts`, grupo "Créditos de IA"); o outbox
fica em `FORA_DO_ESCOPO`. Excluídas por motivo: chaves técnicas de repetição/deduplicação (`chave_idempotencia`,
`payload_sha256`, `chave_origem`, `operacao`, `operacao_id`), `url_fatura` (token de acesso), `conta`, `referencia_externa`,
`exposicao_centavos`/`revisao_motivo` (controle interno), motivo/operador da cortesia e referência da autorização do corte.
Retrato `lib/exportacao/colunas-esperadas.json` regenerado e revisado; suítes de exportação passam a declarar o modelo 090.

## 6. Reconciliação e alertas (D-C4)

`scripts/assinatura-reconciliar.cjs`: eventos de cobrança avulsa pelo mesmo serviço; pedidos abertos/incertos/em revisão e
disputas revisitados por item (simulação = ROLLBACK; produção só conferência); fila somente leitura em itens
`PEDIDO_CREDITOS`, `DEVOLUCAO_CREDITOS`, `RESERVA_CREDITOS`, `DISPUTA_CREDITOS`, `DIVERGENCIA_CARTEIRA`.
**Decidido por Felipe em 22/10 (D4):** pago sem crédito, pagamento duplicado, arrependimento vencido e divergência de carteira
são `CRITICO` e alarmam em toda conferência até resolução (substituto de Felipe ainda não definido). `DOCUMENTO_FISCAL` não
existe (NFS-e fora desta versão).

## 7. Testes executados (22/10/2026, locais)

| Verificação | Resultado |
|---|---|
| `lib/creditos/creditos.test.ts` (regras, flags, catálogo, Asaas avulso com fetch falso, webhook, CLIs) | 13/13 |
| `npm run check:v1:static` (rodada final) | **EXIT 0**: unitários 3276/3276, harness 103/103, lint 0 erros (1 aviso preexistente em `lib/inteligencia/skills/catalogo.ts`), TypeScript e build OK. A 1ª rodada apontou 1 erro de lint no componente novo (`set-state-in-effect`), corrigido |
| PG descartável `lib/creditos/creditos-090.postgres.test.ts` (modelo 089 + 090) | 10/10 na 1ª entrega; **12/12** depois do fechamento da M16 (duas rodadas seguidas) |
| PG `lib/creditos/aplicador-090.postgres.test.ts` | 1/1 |
| PG exportação (`exportacao` 3/3, `exportacao-adversarial` 6/6, modelo 090) | 9/9 |
| `scripts/migration-090.test.cjs` + `scripts/bloco-shell-090.test.cjs` | 21/21 |
| PTY real (MSYS2 `script.exe`, bash interativo) — `pty-090.cjs` | 9/9 (Ctrl-C: sem linha de código, como 088/089 → "parar e ler") |
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
- Textos legais e preços **não** publicados; minutas do plano seguem pendentes de jurídico.
- Decisões de 22/10 por delegação de Felipe: `docs/DECISOES_CREDITOS_IA_20261022.md` (D1 preços do piloto e validade,
  D2 garantia, D3 pagamento tardio, D4 CRÍTICO, D5 pareceres). Pendentes de código: franquia por plano/proporcional, regra
  da 3ª devolução, lacuna de pagamento em pedido `ENCERRADO`, nova versão aprovada do catálogo. Pendentes externos:
  pareceres do jurídico e do contador (pacote `pacote-revisao-creditos-juridico-contador-20261022/`), medição de custo,
  substituto de Felipe.

### Roteiro de homologação em sandbox (NÃO EXECUTADO)

1. Staging com código (flags off) e 090 aplicada por autorização própria; `ASAAS_AMBIENTE=sandbox`, conta exclusiva,
   `CREDITOS_ASAAS_CONTA` definida; empresa sintética com assinatura de teste e corte autorizado.
2. Ligar catálogo/compra só em staging; comprar Pix, cartão e boleto; conferir fatura hospedada, retorno e acessibilidade.
3. Confirmar com `POST /sandbox/payment/{id}/confirm`; webhook real autenticado; reenvio do mesmo evento; perda de evento
   (desligar webhook) recuperada pela reconciliação; cartão recusado/análise de risco; cobrança vencida paga depois.
4. Estorno integral/parcial com `CREDITOS_ESTORNO_ATIVO=true`; saldo insuficiente; resultado incerto (sem repetição).
5. Conferir contagens, saldo, extrato (`conferirCarteira`), D-C4 e exportação. Chargeback não existe no sandbox: limitação
   (coberto só por dublê). NFS-e: aceite separado do contador.
