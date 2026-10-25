# Fundador: texto da síntese em LEGADO (O1) e proposta para reservas não pagas (O3) — 24/10/2026

**Estado: LOCAL.**
- **Branch:** `codex/fundador-sintese-legado-20261024`, sobre `staging` `f78ddaa1`.
- **Origem:** o diagnóstico pós-smoke 096 em staging (`smoke-comprovante-096-staging-20261024/DIAGNOSTICO-POS-SMOKE.md`).
- **O que foi feito:** a correção do O1 está **implementada**; o O3 é só **proposta**, com decisão de Felipe pendente.
- **Sem push, PR, deploy, migration ou mudança de flag.**

## O1 — síntese prometia prazo de 7 dias na fase LEGADO (implementado)

**Defeito:**
- A síntese "Confira sua contratação" exibia `REGRA_RESERVA` sempre que havia Fundador (`components/admin/AssinaturaAcoes.tsx:150`, versão de staging). A regra diz "Pague até o fim do 7º dia… preserva a condição mesmo depois do fim da campanha".
- Na fase LEGADO (20 primeiros, sem campanha ativada) a concessão **não tem validade**: a 090 exige `oferta_valida_ate IS NULL` para LEGADO, e a D4 diz que LEGADO "não tem prazo e confirma pelo valor contratado".
- O texto prometia um prazo e uma campanha inexistentes. Foi observado no smoke 096: oferta `ea1ca120…` com `pagueAte: null`.

**Correção:**
- `lib/assinatura/textos-fundador.ts`:
  - `REGRA_RESERVA_LEGADO`: reserva ao assinar, confirmação com o primeiro pagamento, início dos 12 meses e distinção do arrependimento, sem prazo, horário ou campanha;
  - `regraReservaDaFase(fase)`: `REGRA_RESERVA` só para `JANELA` e `POS_JANELA`, as fases com validade de 7 dias gravada pela guarda 090; qualquer outra fase, inclusive ausente, usa a regra sem prazo.
- `components/admin/AssinaturaAcoes.tsx`: a síntese usa `regraReservaDaFase(dados.ofertas.campanha?.fase)`. O aviso da JANELA na escolha de plano continua com `REGRA_RESERVA`, como antes.
- **O que não muda:** o comprovante já tratava `pagueAte` nulo (`lib/assinatura/comprovante-texto.ts:37-40`), e o "pague até" do link e da tela só aparece com validade.

**Testes:**
- **`lib/assinatura/textos-fundador.test.ts`, 2 casos novos:**
  - a regra por fase;
  - a fonte da síntese, que não pode voltar a usar a regra fixa.
- **Prova de que o teste pega o defeito:** com o componente antigo, o teste falha (1 de 6); com o novo, passa (6/6).
- **`scripts/cadastro-publico-ui.cjs`** (E2E sem campanha, logo LEGADO): a síntese mostra a regra sem prazo e não contém "7º dia", "23h59", "data indicada na tela" nem "fim da campanha".
- **`scripts/cpf-fundador-ui.cjs`** (E2E em JANELA): continua exigindo "fim do 7º dia seguinte à confirmação, às 23h59", e não muda.

## O3 — reservas não pagas podem travar toda a venda (opção A aprovada por Felipe em 24/10/2026 e implementada; C e D não implementadas)

**Fatos (código em `f78ddaa1`):**
- **Uma reserva não paga ocupa a vaga sem limite de tempo.** A concessão nasce `RESERVADA` no "Confirmar contratação" (`lib/assinatura/ofertas.ts:266`) e só vira `CONFIRMADA` com o pagamento (`confirmarOfertaPaga`). Nenhum código do produto grava `LIBERADA`: a liberação "continua manual, com prova (sem ferramenta própria)".
- **LEGADO:** não tem validade. A ocupação conta `estado <> 'LIBERADA'` (`ofertas.ts:110-114`).
- **Lote posterior (POS_JANELA):** tem validade de 7 dias, mas a reserva vencida **continua** `RESERVADA` e contando (`lib/assinatura/campanha.ts:137-141`). Vencer impede retomar a oferta e confirmar o benefício automaticamente (o pagamento tardio vai para reconciliação, D3). **Não** impede o cliente de pagar a cobrança no provedor: a cobrança continua existindo.
- **O travamento:** com 20 ocupadas e menos de 20 confirmadas, `aguardando = true` (`ofertas.ts:113-114` e `:132`). `prepararOferta` recusa **qualquer** contratação com `FUNDADOR_AGUARDANDO` (`ofertas.ts:257`), e a tela troca os botões de plano por "As vagas Fundador estão em confirmação. Aguarde antes de contratar." (`AssinaturaAcoes.tsx:161`).
- **Consequência:** 20 reservas abandonadas, de clientes ou de testes, **bloqueiam a venda inclusive ao preço regular**, até alguém liberar manualmente cada uma. A JANELA não tem esse limite, porque não usa vaga numerada.
- **[HIPÓTESE] Staging:** com a 11ª reserva LEGADO criada no smoke 096, faltariam cerca de 9 contratações-teste não pagas para travar a venda. Não foi verificado.

**Opções:**

| Opção | O que muda | Prós | Contras |
|---|---|---|---|
| **A. Venda nunca trava (recomendada)** | Com `aguardando`, a tela e o checkout **não recusam**: oferecem o plano pelo preço regular, sem Fundador, com o aviso "As vagas Fundador estão em confirmação; você pode assinar agora pelo preço normal ou aguardar." O servidor recalcula sob a trava, como hoje, e grava a oferta sem concessão. | Só código (`ofertas.ts:257` e `:267`, `AssinaturaAcoes.tsx:161`); sem migration; resolve LEGADO e POS_JANELA; a escolha fica com o cliente. | Revê a decisão "com 20 ocupadas e não confirmadas: `FUNDADOR_AGUARDANDO`" (doc CPF/Fundador §4.2). Quem assina pelo preço regular não recebe o Fundador se uma reserva cair depois (ordem de contratação). |
| B. Prazo também no LEGADO | 7 dias para novas reservas LEGADO. | Alinha com a D3. | Exige migration (CHECK 090 `:88`); a reserva vencida continua ocupando (não resolve o travamento sozinha); revê a D4. |
| C. Liberação assistida | Ferramenta no painel do desenvolvedor para liberar a reserva vencida ou abandonada, com prova de cobrança ausente ou cancelada no provedor e auditoria. Na mesma operação, **cancela ou reconcilia a contratação local**: a guarda 074a recusa `LIBERADA` enquanto houver contratação com `estado <> 'CANCELADA'` ligada à vaga (`database/migrations/20261009_074a_planos_comerciais.sql:161-162`). A oferta `EM_ABERTO` precisa virar `CANCELADA`, com a assinatura e a cobrança encerradas no provedor, antes de liberar. | Mantém as decisões; destrava com controle. | Depende de ação humana; não impede o travamento entre a ocorrência e a liberação. |
| D. Encerrar LEGADO | Ativar a campanha 090 antes de abrir ao público: a guarda encerra novas LEGADO. | Operacional, sem código. | O lote posterior tem o mesmo travamento; depende de data e autorização da campanha. |

**Recomendação:**
- **A** agora, como regra mínima e sem migration;
- **C** depois, para devolver vagas com prova;
- **D** na abertura.
- **Em staging, até lá:** evitar contratações-teste não pagas. Cada uma ocupa uma vaga até liberação manual.

**Se A for aprovada, testes mínimos** (lista ampliada pela revisão de 24/10/2026):
- PG: 20 reservas LEGADO não confirmadas → oferta nova pelo preço regular, sem concessão, e a 21ª vaga não é criada; idem POS_JANELA com reservas vencidas.
- Unitário da tela: o aviso e os botões no preço regular com `aguardandoVaga`.
- Regressão: a reserva existente continua retomável; nada reprecifica oferta já aceita.
- Concorrência pela última vaga: duas confirmações simultâneas com 19 ocupadas. Uma recebe a vaga e o Fundador; a outra recebe `OFERTA_ALTERADA` e, ao confirmar de novo, o preço regular, nunca uma 21ª concessão.
- Mudança de disponibilidade entre a síntese e a confirmação: a síntese mostrou Fundador e, ao confirmar, as vagas acabaram. O servidor recusa com `OFERTA_ALTERADA` (valor esperado divergente), e o cliente vê e confirma explicitamente o preço regular antes de qualquer cobrança.
- O inverso: a síntese no preço regular (aguardando) e uma vaga liberada antes de confirmar. A oferta não muda de preço sem nova confirmação.

**[LIMITAÇÃO]** O efeito em produção não foi verificado: versão do código, planos ligados, campanha e reservas existentes.

## Validação local (24/10/2026, clone isolado em LF sobre `f78ddaa1`)

- **Testes de texto:** `node --experimental-strip-types --test lib/assinatura/textos-fundador.test.ts` dá **6/6**. Com `components/admin/AssinaturaAcoes.tsx` revertido para a versão de staging, dá **5/6**: o teste novo pega o defeito.
- **`npm run check:v1:static`:** **PASS** (3535 + 103 testes, lint com 2 avisos preexistentes em arquivos não tocados, TypeScript e build). A primeira rodada falhou só no build, por ambiente: o Turbopack recusa `node_modules` por junção. Foi refeita com `npm ci` próprio.
- **Bateria PostgreSQL** completa em cluster sintético descartável (55607): **140/140 arquivos**, 820 testes, 816 pass, 0 falhas, 4 pulados de propósito.
- **E2E:**
  - `cadastro-publico-ui` (LEGADO): **PASS**, com "síntese LEGADO sem prazo de 7 dias";
  - `cpf-fundador-ui` (JANELA): **PASS**, com a síntese ainda citando o 7º dia e o "pague até" individual.
- **Cluster:** encerrado e removido.
- **Logs:** `ambientes-locais/pg-descartavel-cpf-fundador-20261022-relatorios/fundador-sintese-legado-20261024/`.

## Revisão do Astra (24/10/2026): APROVADO COM RESSALVAS

- **O1:** aprovado localmente, sem P1/P2. A concessão própria pode devolver resumo `LEGADO` com validade, mas nesse estado o fluxo normal é "Retomar", sem nova síntese.
- **O3:** segue como proposta, dependente de decisão comercial. O travamento de novas vendas foi confirmado. A direção A + C + D é aceitável, desde que preserve a confirmação explícita do preço e as ofertas já aceitas. B não resolve o estoque sozinha; D mantém o risco no lote posterior.
- **P3 corrigidos neste documento:**
  - o vencimento não impede pagar no provedor, só a retomada e a confirmação automática;
  - a opção C precisa cancelar ou reconciliar a contratação local antes de liberar (guarda 074a).
- **Testes de concorrência e de mudança de disponibilidade** acrescentados à lista.
- **Relatório:** `D:/glass/KidMais Manager/revisao-fundador-sintese-legado-4689025a-20261024/RELATORIO.md`.

## O3, opção A — implementação local (24/10/2026)

**Decisão de Felipe:** "Aprovo a opção A do O3 (venda nunca trava: preço regular com aviso e confirmação explícita)". C e D ficam fora.

**Base:** branch `codex/fundador-venda-sem-trava-20261024`, criada sobre `10d36b65` (a branch do O1, PR #228), que está sobre `staging` `f78ddaa1`.

**Mudanças:**
- **`lib/assinatura/ofertas.ts`:**
  - `prepararOferta` não recusa mais com `FUNDADOR_AGUARDANDO` quando há 20 ocupadas e não confirmadas. Sem vaga livre, `elegivel` já é falso e o valor recalculado sob a trava é o regular.
  - Quem enviou o valor Fundador recebe `OFERTA_ALTERADA` (conferência existente do valor esperado) e confirma o novo valor. Nada é gravado nem cobrado.
  - Se a inserção da vaga falhar numa corrida que a trava não cobriu, a resposta também é `OFERTA_ALTERADA`, e não `FUNDADOR_AGUARDANDO`.
- **`lib/assinatura/textos-fundador.ts`:**
  - `AVISO_VAGAS_EM_CONFIRMACAO`: "assinar agora pelo preço normal ou aguardar; se uma vaga for liberada, a condição volta a aparecer";
  - `SINTESE_SEM_FUNDADOR`: a síntese diz que não há Fundador e que o valor é o preço normal.
- **`components/admin/AssinaturaAcoes.tsx`:** o aviso aparece **acima** do ciclo e dos botões de plano, que passam a mostrar o preço regular (`ofertas.fundador` falso). A síntese ganha a linha sem Fundador.

**O que não muda:**
- a oferta já aceita (`EM_ABERTO`) é devolvida antes de olhar vagas: mantém preço, prazo e benefício;
- a reserva vencida continua recusada na retomada (D3);
- o pagamento tardio vai para reconciliação;
- a LEGADO pendente paga mantém a condição (D4);
- o valor cobrado é sempre o da oferta gravada (`lib/assinatura/cobranca.ts:190`), que só existe se for igual ao valor confirmado.

**Testes:**
- **Unitário `lib/assinatura/ofertas.test.ts`:** o caso antigo, que esperava "em confirmação", foi atualizado para a regra nova: o Fundador esperado reconfirma e o regular passa sem vaga.
- **Unitário `lib/assinatura/textos-fundador.test.ts`:** os textos novos e a fonte: aviso antes do ciclo e dos botões, linha da síntese, servidor sem `throw FUNDADOR_AGUARDANDO`.
- **PG `campanha-090`, 2b (novo, LEGADO):**
  - 20 ocupadas em confirmação: a tela mostra o regular (`fundador: false`, `aguardandoVaga: true`, 19700);
  - o Fundador esperado dá `OFERTA_ALTERADA`, sem contratação gravada;
  - o regular confirmado grava oferta sem concessão e sem 21ª vaga, com retomada idempotente;
  - **inverso:** uma vaga liberada (contratação cancelada antes) faz a síntese aberta no regular receber `OFERTA_ALTERADA`, sem desconto silencioso; ao reconfirmar, o cliente recebe a vaga liberada.
- **PG `campanha-090`, 6 (POS_JANELA):**
  - disputa real pela última vaga: o perdedor recebe `OFERTA_ALTERADA`, antes `FUNDADOR_AGUARDANDO`;
  - com 20 em confirmação, uma empresa nova contrata pelo regular, sem concessão, e o lote continua em 20.
- **PG `comprovante-096`, 4b (novo):** com as vagas em confirmação, o Fundador esperado é recusado sem gravar comprovante. O regular grava comprovante com `fundador: null`, desconto 0 e 19700, e o texto não cita Fundador. As vagas de teste são liberadas ao fim.
- **Casos anteriores que continuam passando:** 7, 8, 9 e 10 da `campanha-090` (pagamento tardio, D3, D4, concessão própria).

**Fora dos testes automatizados (limitação):**
- A tela com `aguardandoVaga` foi verificada pela fonte, não renderizada num navegador. Os E2E não montam o estado de 20 vagas ocupadas.
- `scripts/concorrencia-vagas-isolado.cjs` e `scripts/assinatura-074-075-homologacao.cjs` ainda esperam `FUNDADOR_AGUARDANDO`. São roteiros fora do CI: o primeiro já falhava antes desta mudança, e o segundo é um roteiro de homologação de staging antigo. Precisam ser atualizados antes de reutilizados.
