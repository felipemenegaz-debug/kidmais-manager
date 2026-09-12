# Kidmais Manager — Contrato Bloco 2 — arquitetura de dois documentos

Data: 08/09/2026

## Decisão consolidada

Cada versão contratual passa a produzir dois documentos derivados do MESMO snapshot imutável:

1. **Resumo da Contratação**
   - documento comercial/informativo;
   - visual e curto;
   - serve para conferência de cliente, festa, pacote, buffet, adicionais e valores;
   - não recebe o aceite jurídico;
   - não substitui o Contrato Oficial.

2. **Contrato Oficial**
   - documento jurídico específico de cada pacote;
   - é o documento que recebe o aceite eletrônico;
   - seu SHA-256 é o valor persistido em `contrato_versoes.documento_pdf_hash`;
   - continua vinculado à mesma versão/snapshot já congelada.

Nenhuma migration nova é necessária para esta separação.

## Modelo jurídico disponível neste patch

- `COMPLETA` → `FESTA_COMPLETA_V1`
- Fonte: contrato oficial fornecido pela Kidmais da antiga **Festa Standard**, hoje chamada **Festa Completa**.
- O contrato-fonte possuía 19 cláusulas; após a retirada aprovada da antiga cláusula 16, o modelo atual possui 18 cláusulas sequenciais.
- Os demais pacotes permanecem sem Contrato Oficial cadastrado e, portanto, com aceite bloqueado.

## Ajustes aprovados em 08/09/2026

1. **Pagamento conforme o Fechamento**
   - a cláusula de pagamento acompanha a forma registrada no snapshot: `PIX_AVISTA`, `PIX_PARCELADO` ou `CARTAO_CIELO`;
   - a redação deixa explícito que a forma indicada não representa pagamento realizado nem quitação;
   - quando houver parcelas ou valores com vencimento futuro, a regra de inadimplemento se aplica sem criar contradição com pagamentos à vista.

2. **Aumento de convidados**
   - a regra é expressa como prazo de 8 dias corridos antes do evento;
   - quando o fechamento ocorrer dentro desse prazo, aumentos posteriores dependem de análise e autorização expressa da Kidmais;
   - não é gerada uma data-limite anterior à própria contratação.

3. **Antiga cláusula 16 removida**
   - foi excluída integralmente a redação sobre valores pendentes no final do evento e a multa de R$ 450,00;
   - as cláusulas posteriores foram renumeradas, resultando em 18 cláusulas.

4. **Foro**
   - a cláusula final passa a eleger o foro da Comarca de Brasília-DF para controvérsias ou questões decorrentes do contrato que demandem medida ou ação judicial, observada a legislação aplicável;
   - foi removida a expressão legada `deste aditivo`.

## Liberação final do modelo Festa Completa V1

Em 08/09/2026, a Kidmais confirmou os valores, regras comerciais e dados da CONTRATADA utilizados no modelo `FESTA_COMPLETA_V1`. Com isso:

- o modelo passa a ser marcado como `homologadoParaProducao: true`;
- o aviso visual de homologação é removido do Contrato Oficial;
- o aceite eletrônico em produção deixa de ser bloqueado por falta de homologação deste modelo;
- permanecem preservadas as 18 cláusulas aprovadas e os ajustes funcionais descritos acima.

Essa liberação representa a aprovação interna da Kidmais para uso do template no sistema. Ela não constitui parecer jurídico externo nem substitui eventual revisão por advogado.

## Rotas

### Administrativo

- Contrato Oficial:
  - `GET /api/admin/contratos/pdf?fechamentoId=<uuid>`
- Resumo da Contratação:
  - `GET /api/admin/contratos/resumo?fechamentoId=<uuid>`

### Público autenticado por OTP

- Contrato Oficial:
  - `POST /api/contratos/:contratoId/pdf`
- Resumo da Contratação:
  - `POST /api/contratos/:contratoId/resumo`

## Aceite

O cliente passa a visualizar abas separadas:

1. Resumo da Contratação;
2. Contrato Oficial.

A interface exige que a aba de Contrato Oficial seja aberta antes de habilitar o aceite.
O backend continua validando a exata versão, snapshot e SHA-256 do **Contrato Oficial**.

## Preservação histórica

- não altera snapshots existentes;
- não cria nova versão contratual apenas por esta mudança enquanto nenhum contrato tiver sido assinado;
- não altera `schema_mvp_kidmais.sql`;
- não cria Pagamentos;
- não cria Festa;
- não altera Migration 010.
