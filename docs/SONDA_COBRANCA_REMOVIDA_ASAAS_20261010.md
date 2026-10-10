# Sonda isolada — retorno da cobrança após remover a assinatura (Asaas sandbox, 10/10/2026)

**Status: PRONTA PARA APROVAÇÃO, NÃO EXECUTADA.** Exclusivamente Asaas sandbox, executada no Web Shell do web staging (`srv-daif418ae00c73e8k2gg`, única origem da chave sandbox). Sem banco, sem pagamento, sem empresa, sem vaga Fundador. Produção não é tocada.

## Pergunta

A prova fail-closed da [rodada Fundador](HOMOLOGACAO_FUNDADOR_STAGING_20261010.md) só libera uma vaga quando cada cobrança da assinatura removida é relida por `GET /v3/payments/{id}` com `deleted=true`, estado `PENDING`/`OVERDUE` e sem data de pagamento. A documentação do Asaas não confirma esse retorno (pode ser 404). A sonda responde isso antes da rodada completa.

## Recursos

| Recurso | Detalhe | Limpeza |
|---|---|---|
| Cliente sintético | nome “TESTE Kidmais sonda cobrança removida”, CNPJ sintético válido, `externalReference` única `hml-sonda-cobranca-20261010-<uuid>`, `notificationDisabled: true` | `DELETE /customers/{id}` no `finally` |
| Assinatura | R$ 5,00 mensal, `billingType UNDEFINED`, vencimento hoje + 10 dias, mesma referência | removida pela própria sonda (é o objeto do teste) |
| Cobrança gerada pela assinatura | nunca paga (a sonda para se aparecer paga) | removida junto com a assinatura |
| Estado | `data/homologacao-planos-cotacao-20261010/sonda-cobranca-removida.json` (disco persistente, `wx`: uma execução) | mantido como evidência |
| Efeito colateral em staging | se houver webhook do sandbox apontando para staging, até ~4 eventos (`PAYMENT_CREATED`, `SUBSCRIPTION_CREATED`, `PAYMENT_DELETED`, `SUBSCRIPTION_DELETED`) gravados em `cobranca_eventos` como `IGNORADO` (referência sem empresa) | não apagados (histórico) |

## Comandos

| # | Operação | Efeito | Custo |
|---|---|---|---|
| S1 | Revalidar branch/auto-deploy; `git push origin <candidata>:staging` (fast-forward, sem force). Se `staging` avançou: não enviar; integrar, revisar o diff completo e apresentar novo SHA. É o P1 da rodada Fundador (mesma candidata). | repositório | segundos |
| S2 | Render MCP `trigger_deploy` (sem mudar env); conferir commit LIVE e `/api/health` 200. A aplicação é a mesma de `0123050`; mudam só `scripts/` e `docs/`. | web reinicia | ~6 min |
| S3 | Shell: `cd /opt/render/project/src && node --experimental-strip-types scripts/sonda-cobranca-removida-asaas.cjs --sonda-cobranca-removida-autorizada` | cria, remove e relê; limpa no `finally` | < 1 min |
| S4 | Só se interrompida: `node --experimental-strip-types scripts/sonda-cobranca-removida-asaas.cjs --encerrar-sonda-cobranca-removida-autorizada` (remove assinatura/cliente pela referência gravada). Fechar o Shell. | limpeza | segundos |

Nenhuma variável de ambiente muda; não há restauração de configuração.

## O que a sonda registra (sem dados pessoais)

- Antes da remoção: cada cobrança por `GET /payments/{id}` (HTTP, `deleted`, `status`, data de pagamento, valor).
- Depois da remoção: `GET /subscriptions/{id}`; cada `GET /payments/{id}` (**leitura usada pela regra**); e, para desenhar prova alternativa sem nova sonda, as leituras `GET /subscriptions/{id}/payments`, `GET /payments?subscription=`, `GET /payments?customer=` e `GET /payments?externalReference=` (HTTP, total e forma mínima de cada item).
- Limpeza: assinaturas ativas restantes da referência (esperado 0) e cliente removido.

## Decisão pelo resultado

| `resultado` | Significado | Próximo passo |
|---|---|---|
| `REGRA_ATENDIDA` | releitura direta mostra a cobrança `deleted=true`, `PENDING`/`OVERDUE`, sem pagamento — exatamente a regra do executor (`cancelamentoComprovado`) | seguir com P2–P4 da rodada Fundador (P1 já feito em S1) |
| `COBRANCA_404` | a leitura direta não comprova; reserva seria mantida | não executar a rodada; preparar prova alternativa documentada a partir das leituras registradas, com testes e nova candidata, e pedir nova aprovação |
| `OUTRO` / `INCOMPLETO` | formato inesperado, erro ou falha de limpeza | parar e analisar; limpeza pela S4 se necessário |

## Validação local

- `scripts/sonda-cobranca-removida-asaas.test.cjs`: 6/6 — flag única; recusa sem disco (sonda e recuperação); alvo só web staging + sandbox; leituras restritas a GET dos recursos da sonda; classificação pela mesma função do executor (removida, 404, paga removida, não removida, estado desconhecido, erro HTTP, assinatura ativa); limpeza só da referência da sonda, inclusive sem ID salvo, sem nada criado, com falha (nunca lança) e com referência alheia (nada chamado); código sem banco, sem pagamento, só sandbox e com `wx`.
