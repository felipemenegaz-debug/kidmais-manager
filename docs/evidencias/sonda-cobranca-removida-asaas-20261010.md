# Evidência — sonda da cobrança removida no Asaas sandbox (10/10/2026, UTC)

Autorização de Felipe: S1–S4 para a candidata `f88b39e9e7746c394554c6b62c4b4bbaf4592353`, só staging e Asaas sandbox. Produção não tocada. Saída sanitizada (sem chave, nome, documento ou referência completa).

## S1–S2

- Revalidados: branch `staging`, auto-deploy OFF, árvore limpa. Push `0123050..f88b39e` (fast-forward, sem force).
- `trigger_deploy` `dep-db52brl9fdbs73bc77h0` (commit `f88b39e`), LIVE 11:54:03Z; `/api/health` 200. Nenhuma variável alterada.
- Shell (instância `rqcnz`): `RENDER_GIT_COMMIT=f88b39e…`; `ASSINATURA_PLANOS_ATIVOS` ausente; sem estado de sonda anterior no disco.

## S3 — resultado

```
resultado: REGRA_ATENDIDA
antes:  cobrança 1 → GET /payments/{id} 200 {deleted:false, status:PENDING, paymentDate:null, valor:500}
depois: GET /subscriptions/{id} 200 {deleted:true, status:INACTIVE}
        GET /payments/{id}      200 {deleted:true, status:PENDING, paymentDate:null, valor:500}
        GET /subscriptions/{id}/payments  200 total 0
        GET /payments?subscription=       200 total 0
        GET /payments?customer=           200 total 0
        GET /payments?externalReference=  200 total 0
```

Conclusões:

- A leitura direta da cobrança devolve a cobrança removida com `deleted=true`, estado `PENDING` e sem data de pagamento: atende exatamente a regra `cancelamentoComprovado` do executor Fundador. Não houve 404.
- A assinatura removida também é devolvida (200, `deleted=true`), não 404.
- **As listagens omitem itens removidos** (total 0): não servem como prova de remoção; só a leitura direta por id serve. A regra do executor já usa a leitura direta e exige ao menos uma cobrança registrada antes da remoção.

## Limpeza (comprovada)

```
estado: concluido:true, precheck {referenciaLivre:true}, falhasLimpeza: []
limpeza: {acao:REMOVIDOS, assinatura:false (já removida pela própria sonda), cliente:true, restantes:0, clientesAtivos:0}
```

- Assinatura sintética: removida (passo do teste) e relida `deleted=true`.
- Cobrança: removida junto com a assinatura e relida `deleted=true`; nunca paga.
- Cliente sintético: removido; releitura final da referência com 0 clientes ativos e 0 assinaturas ativas.
- S4 (recuperação) não foi necessária. Shell encerrado.
- Efeito indireto autorizado: eventos do webhook do sandbox para staging, se houver, ficam em `cobranca_eventos` como `IGNORADO` (sem empresa); não conferidos nesta sonda (sem leitura de banco).

## Próximo passo (não executado)

Portão da [rodada Fundador](../HOMOLOGACAO_FUNDADOR_STAGING_20261010.md) satisfeito. P1 já está feito (mesma candidata em `staging`); P2–P4 aguardam aprovação de Felipe.
