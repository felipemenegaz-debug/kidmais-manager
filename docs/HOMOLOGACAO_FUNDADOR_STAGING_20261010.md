# Homologação Fundador em staging — rodada 2 (pacote de 10/10/2026)

**Status: PRONTO PARA APROVAÇÃO, NÃO EXECUTADO.** Exclusivamente staging (`srv-daif418ae00c73e8k2gg`, `kidmais_staging_1z91`) e Asaas sandbox. Produção não é tocada. Cada passo P1–P4 depende de aprovação explícita de Felipe para a candidata abaixo ([OPERACAO_AGENTES.md](OPERACAO_AGENTES.md)).

## Por que esta rodada

A tentativa 2 da homologação de planos ([evidência](evidencias/homologacao-planos-cotacao-staging-tentativa2-20261010.md)) parou em S4: toda empresa nova pagante é elegível ao Fundador enquanto houver menos de 20 vagas ocupadas (`lib/assinatura/ofertas.ts`). Esta rodada testa o próprio Fundador.

**Decisão de Felipe (10/10/2026): só reserva, sem pagamento.** O gatilho da 074 (`kidmais_074_registro_guarda`) só admite `RESERVADA → CONFIRMADA` ou `RESERVADA → LIBERADA`: vaga confirmada por pagamento nunca volta a ficar livre. Para liberar as vagas da rodada, nada é pago.

## Candidata

- **Código: `5f818f56291fb5ba67e1bc0506a46ac1db4db9b3`** sobre `origin/staging` `0123050` (inclui os deploys externos `bc95ca4` #151 e `0123050` #152).
- **Candidata completa** = o commit seguinte, que traz só este documento; o SHA exato é o apresentado no pedido de aprovação e é o único que P1 envia.
- Diferença para `0123050`: `scripts/homologacao-fundador-staging.cjs` e teste, e a evidência da tentativa 2. Aplicação web inalterada.
- Se `origin/staging` avançar antes de P1: **não enviar**. Integrar sem force, revisar o diff completo entre a nova ponta e a candidata, revalidar e apresentar o novo SHA para nova aprovação.
- Pedido: não implantar staging por fora durante a janela (P2–P4, ~20 min). Na tentativa 2, um deploy externo trocou a instância no meio de N4.

## Alvo exato

| Item | Valor |
|---|---|
| Workspace Render | `tea-daidbj95efls73d2bcf0` |
| Web staging | `srv-daif418ae00c73e8k2gg`, branch `staging`, auto-deploy OFF (revalidar antes de P1 e P2) |
| Disco | `dsk-daif418ae00c73e8k340` em `/opt/render/project/src/data` |
| Banco | `dpg-daidko3m8hqs73ce4jt0-a` / `kidmais_staging_1z91`, rede privada (`DATABASE_SSL=false`) |
| Asaas | `sandbox` |
| Cron staging | `crn-db493i142hec73ahmoe0` — não alterado |
| Produção | não tocada |

## Sequência

| # | Operação exata | Efeito | Duração/custo |
|---|---|---|---|
| P1 | Revalidar branch/auto-deploy; `git push origin <candidata+docs>:staging` (fast-forward, sem force). | só repositório | segundos |
| P2 | Shell: `--conferir-restauracao` → `RESTAURADA` (registro: ambas ausentes). Render MCP merge **só** `ASSINATURA_PLANOS_ATIVOS=true`; acompanhar o deploy que a gravação dispara (sem disparar outro); conferir commit LIVE, `/api/health` 200 e no Shell `RENDER_GIT_COMMIT` e a chave. | web com a candidata e planos ligados | ~6 min de build |
| P3 | Shell: `cd /opt/render/project/src && nohup node --experimental-strip-types scripts/homologacao-fundador-staging.cjs --fundador-rodada-2-autorizada > data/homologacao-planos-cotacao-20261010/fundador-saida.log 2>&1 < /dev/null &` (registrar PID; não redeployar). Depois `cat …/fundador-saida.log` e registro sanitizado em `docs/evidencias/`. | 3 fixtures, 3 checkouts Fundador sandbox **sem pagamento**, matriz, encerramento com liberação comprovada | ~3–5 min |
| P4 | Remover `ASSINATURA_PLANOS_ATIVOS` no painel (“Save only”); `trigger_deploy` (ponta da branch, conferida antes); `--conferir-restauracao` → `RESTAURADA`; fechar o Shell. | staging volta à configuração registrada | ~6 min |

Interrupção em P3 (deploy externo, queda do Shell): conferir que o PID não está vivo e rodar `node --experimental-strip-types scripts/homologacao-fundador-staging.cjs --encerrar-fundador-rodada-2-autorizada` (mesma trava e mesma regra de prova; idempotente). Depois P4.

## Fixtures (novos IDs; nenhuma reaproveita a rodada 1)

| Fixture | Empresa | Usuário | `codigo` | Plano |
|---|---|---|---|---|
| FE | `ed7800c8-1ddd-4596-b82b-a5db0e5eafc2` | `92eb6686-ad99-44bc-8bdb-d6909dfd96e3` | `hml-fundador-essencial` | Essencial |
| FP | `3970a4d0-6fb2-4a0b-8c9a-b12dbce9f002` | `132a7cc6-8626-4056-9322-f9586528ae47` | `hml-fundador-profissional` | Profissional |
| FM | `be4f80f6-4f55-45b6-97e3-ceae28797cea` | `2b0cb15e-2008-429a-a658-5ade854d50c2` | `hml-fundador-premium` | Premium |

Empresas com teste de 15 dias encerrado há 1 h, documento sintético único (≠ CNPJ da Kidmais, ≠ beneficiários existentes), e-mail `@example.invalid`, senha só em memória. Estado em `data/homologacao-planos-cotacao-20261010/fundador-rodada-2.json` (`wx`).

## Matriz de aceite (divergência = S2)

Preços fixados no executor, independentes do sistema (centavos):

| Plano | Regular mensal | Fundador (−40%) |
|---|---|---|
| Essencial | 19700 | 11820 |
| Profissional | 34700 | 20820 |
| Premium | 59700 | 35820 |

| Item (por fixture) | Esperado |
|---|---|
| Oferta (`/api/admin/assinatura`) | `habilitado` e `fundador` true, `aguardandoVaga` false; `mensalRegular` e `mensal` = tabela |
| Checkout (`POST …/assinatura/checkout`, valor Fundador) | 200 |
| Reserva | exatamente 1 vaga, `RESERVADA`, beneficiário = documento da assinatura |
| Contratação | `EM_ABERTO`, plano certo, desconto 40, regular e final = tabela; assinatura da empresa continua `UNICO` (nada confirmado) |
| Asaas sandbox | 1 assinatura da referência, id = gravado, valor = Fundador; 1 cobrança `PENDING` com valor Fundador |
| Pendência na tela | `pendente.valorCentavos` = Fundador |
| Campanha | ocupadas = antes + 3; confirmadas inalteradas |
| Terceiros | hash de empresas, vínculos, assinaturas, contratações, **vagas Fundador**, isenções, clientes, fechamentos e pacotes fora das fixtures idêntico (S3); endereço público da Kidmais idêntico |

## Encerramento: libera só as vagas da rodada, com cancelamento comprovado (fail-closed)

Sempre (sucesso, falha, parada, recuperação). Nunca lança; o erro original prevalece. Nunca apaga linha.

1. Por fixture com prova de autoria (S1 provou empresa e referência Asaas livres **e** a rodada gravou `intencaoCheckout` antes do checkout):
   - IDs conhecidos: estado da rodada; se a interrupção ocorreu antes de salvá-los, `empresa_assinaturas` da fixture e a listagem por referência. Estado e banco divergentes → para;
   - assinaturas da referência: no máximo 1, mesma referência, cliente e id conhecidos (senão colisão → não toca);
   - cobranças de toda assinatura conhecida listadas **antes** da remoção. **Pagamento conhecido bloqueia sempre, mesmo com `deleted=true`**: estado fora de `PENDING`/`OVERDUE` (pago, confirmado, em dinheiro, estorno, análise, desconhecido) ou data de pagamento → não remove, não libera;
   - `DELETE` da assinatura no sandbox;
   - **prova**: assinatura relida 404 ou `deleted`; ao menos uma cobrança registrada quando houve assinatura; **cada cobrança relida explicitamente com `deleted=true`, estado `PENDING`/`OVERDUE` e sem data de pagamento**. Cobrança 404, estado desconhecido, resposta fora do formato, falha de listagem/leitura (provedor ou banco) → evidência incompleta → reserva mantida.
2. Banco, uma transação, só para fixtures com prova: contratação `EM_ABERTO → CANCELADA` (motivo e data) e vaga `RESERVADA → LIBERADA` (`liberada_em`, `evidencia_liberacao`), filtradas por `empresa_id` da fixture; depois desativa usuários, vínculos e empresas das fixtures (por ID + marcador).
3. Vaga sem prova fica `RESERVADA` e é reportada (`REMOCAO_NAO_COMPROVADA`); vaga `CONFIRMADA` nunca é forçada (`VAGA_NAO_LIBERADA`).
4. Depois: campanha volta ao número de ocupadas de antes; hash de terceiros idêntico ao de antes. Divergência = `INCOMPLETO`.

Permanecem como histórico (nunca apagados): 3 empresas desativadas, 3 contratações `CANCELADA`, 3 vagas `LIBERADA`, 3 clientes no Asaas sandbox sem assinatura ativa.

### Risco declarado

A documentação do Asaas não confirma que `GET /v3/payments/{id}` devolve a cobrança removida com `deleted=true` (pode responder 404). Pela regra fail-closed, 404 mantém a reserva: nesse caso a rodada termina `INCOMPLETO` com até 3 vagas de staging `RESERVADA` (contratações `EM_ABERTO`, fixtures desativadas, nada pago, assinaturas removidas) e a liberação exige decisão própria. Nenhuma vaga de terceiros é afetada.

## Critérios de parada

- S1: alvo, conexão, disco, schema 074, fixture/e-mail/código existente, referência Asaas ocupada, estado de rodada presente.
- S4: **menos de 3 vagas livres** na campanha de staging (sem alterar teto nem vagas de terceiros).
- S2: qualquer item da matriz. S3: terceiros ou Kidmais alterados.
- S5: build/health com falha em P2/P4; `--conferir-restauracao` divergente.

## O que esta rodada não comprova

- Confirmação por pagamento (`CONFIRMADA`, benefício de 12 meses, cobrança paga) e a matriz paga (financeiro por plano, limite de pessoas, Premium completo): exigiria consumir vagas de staging para sempre (decisão de Felipe: não).
- Concorrência na última vaga (Etapa 4, PostgreSQL isolado) e renovação/aviso de 30 dias (Etapa 5).

## Recuperação

- Código: `git revert` em `staging` (só scripts e docs).
- Configuração: P4.
- Vagas/contratações: o encerramento e o modo `--encerrar-fundador-rodada-2-autorizada` repetem a liberação comprovada; vaga presa por falta de prova exige decisão própria.

## Evidências locais (candidata)

| Validação | Resultado |
|---|---|
| Rodada Fundador (offline, banco e provedor simulados) | 17/17 — inclui prova fail-closed (pago/confirmado/em dinheiro/estornado/com data de pagamento bloqueiam mesmo removidos; pago entre listagem e remoção), estado desconhecido ou evidência incompleta (404, estado desconhecido, erro de releitura, falha de listagem, assinatura sem cobrança, falha ao ler IDs no banco) e interrupção após criação no provedor sem IDs salvos (IDs do banco; só referência; banco aponta outra assinatura; assinatura removida por fora sem cobrança; estado × banco divergentes) |
| Scripts afetados (Fundador, planos, aplicador, conexão, restauração, ensaio) | 66/66 |
| Testes unitários sem banco (`check:v1:static`) | 2224/2224 |
| Harness staging (mocks) | 103/103 |
| TypeScript, build de produção, worker de PDF | aprovados |
| ESLint | 0 erros (1 aviso preexistente) |
