# Evidência — rodada Fundador em staging, só reserva (10/10/2026, UTC)

Autorização de Felipe: P2–P4 para a candidata `f88b39e9e7746c394554c6b62c4b4bbaf4592353`, só staging e Asaas sandbox, sem pagamentos. Produção não tocada. Saída sanitizada (sem chaves, documentos ou IDs do provedor).

## P1 (feito na sonda) e P2

- `origin/staging` e deploy LIVE em `f88b39e` conferidos antes de cada passo; auto-deploy OFF.
- Shell: `--conferir-restauracao` → `RESTAURADA` (ambas as chaves ausentes, como no registro).
- Render MCP merge **só** `ASSINATURA_PLANOS_ATIVOS=true` → deploy automático `dep-db52hv7lot8c73dgd1cg` (`f88b39e`), LIVE 12:07:18Z, `/api/health` 200.
- Shell: `f88b39e… true sandbox`; sem `fundador-rodada-2.json` (rodada não iniciada).

## P3 — rodada (PID 201) — PASS

```
resultado: PASS, falha: null, erro: null
FE essencial:    vaga 4, regular 19700, fundador 11820, Asaas 11820
FP profissional: vaga 5, regular 34700, fundador 20820, Asaas 20820
FM premium:      vaga 6, regular 59700, fundador 35820, Asaas 35820
campanha antes:     ocupadas 3, confirmadas 2
campanha reservada: ocupadas 6, confirmadas 2   (+3, todas da rodada)
campanha depois:    ocupadas 3, confirmadas 2   (restaurada)
```

Matriz aprovada (o executor para em qualquer divergência): oferta Fundador habilitada sem fila; preços regular e com 40% iguais aos fixados; checkout 200; uma vaga `RESERVADA` por fixture com beneficiário = documento; contratação `EM_ABERTO` com desconto 40 e valores corretos; assinatura da empresa ainda `UNICO`; uma assinatura e uma cobrança `PENDING` no sandbox com o valor Fundador; pendência na tela com o valor Fundador; campanha +3; hash de terceiros (inclusive vagas e contratações de outras empresas) e endereço público da Kidmais idênticos.

## Encerramento (comprovado)

```
prova: fixtures true; assinaturas FE/FP/FM true
FE/FP/FM: ASSINATURA_REMOVIDA_COMPROVADA (1 assinatura, 1 cobrança cada; IDs do estado da rodada)
vagas: FE/FP/FM contratacoesCanceladas 1, vagasLiberadas 1, naoLiberadas []
fixtures: DESATIVADAS; falhasEncerramento: []
```

- Nada foi pago. Cada liberação só ocorreu depois de reler no Asaas a assinatura removida e a cobrança registrada com `deleted=true`, `PENDING`, sem data de pagamento (regra validada pela [sonda](sonda-cobranca-removida-asaas-20261010.md)).
- Vagas preexistentes (3 ocupadas, 2 confirmadas) intactas: contagem de antes = depois e hash de terceiros idêntico também após o encerramento.
- Permanecem como histórico: 3 empresas desativadas, 3 contratações `CANCELADA`, 3 vagas `LIBERADA`, 3 clientes sandbox sem assinatura ativa.

## P4 — restauração

- Painel: removida só `ASSINATURA_PLANOS_ATIVOS` (“Save only”; 71 → 70 variáveis). Uma primeira marcação caiu na linha errada por captura de tela defasada; foi descartada sem salvar (recarga; 71 intactas conferidas) e refeita com conferência no DOM antes de salvar.
- `trigger_deploy` `dep-db52oq2jnfac7391mong` (`f88b39e`, ponta da branch conferida).
- LIVE 12:21:43Z; `/api/health` 200. Shell (instância nova): `RENDER_GIT_COMMIT=f88b39e…`; `--conferir-restauracao` → `{"resultado":"RESTAURADA", ambas presente:false, divergencias:[]}`. Shell encerrado.

## Estado final de staging

Código `f88b39e`; chaves ausentes como no registro; 076/077 aplicadas (tentativa 2); campanha Fundador com as mesmas 3 vagas ocupadas (2 confirmadas) de antes; fixtures FE/FP/FM desativadas com contratações canceladas e vagas liberadas; nenhuma cobrança paga.

## O que esta rodada não comprova

Confirmação por pagamento (`CONFIRMADA`, benefício de 12 meses) e matriz paga (financeiro por plano, limite de pessoas, Premium completo) — fora do escopo por decisão de Felipe (vaga confirmada nunca é liberada pela 074). Concorrência na última vaga (Etapa 4) e renovação/aviso de 30 dias (Etapa 5).
