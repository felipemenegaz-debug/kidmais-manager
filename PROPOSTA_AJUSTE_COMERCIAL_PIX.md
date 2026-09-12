# Proposta de persistência — revisão comercial e PIX

Status atualizado: proposta autorizada pelo usuário; Migration 012 criada e aplicada em 09/09/2026. A validação final está documentada em `README_VALIDACAO_AJUSTE_PIX.md`. O texto abaixo preserva a proposta que fundamentou a autorização; não é uma instrução para reaplicar a migration.

## 1. Por que a migration é necessária para a solução proposta

A intenção de parcelamento precisa existir antes do Contrato e ser distinguida da condição revisada pela Kidmais. O Fechamento atual guarda apenas a forma pretendida e observações textuais, sem campo estruturado para essa intenção. A tabela de aprovação guarda valores e decisão, mas não a condição analisada.

Há também uma restrição física: `fechamentos_status_negociacao_check` exige `valor_negociado` sempre que o estado é AGUARDANDO_APROVACAO. Uma proposta de parcelamento pode precisar de revisão mesmo quando a base comercial é exatamente o preço de tabela, sem negociação de valor.

## 2. Estruturas inspecionadas

- `fechamentos`: forma_pagamento_pretendida; valor_tabela; valor_negociado; valor_aprovado; motivo_negociacao; observacoes_negociacao; observacoes_cliente; observacoes_equipe; status; constraints de negociação, aprovação e valores. Não possui JSONB.
- `aprovacoes_negociacao`: fechamento_id; valor_informado; valor_aprovado; status; motivo; aprovado_por_usuario_id; observacoes; criado_em. Não possui JSONB. Decisões APROVADO/CORRIGIDO exigem valor_aprovado.
- `contrato_versoes`: snapshot JSONB, snapshot_schema_versao, snapshot_hash, status e campos de versionamento/assinatura. O snapshot já comporta os dados novos sem alteração física.
- Código: criação pública e comercial do Fechamento; repositório de aprovação; geração do Contrato; resolução do valor contratual; cards e cálculo da etapa 8; API administrativa e sua trava de desenvolvimento; leitura do valor assinado por Pagamentos.

## 3. Por que não usar somente a estrutura existente

Tecnicamente seria possível serializar JSON em campos de observações. Não recomendo: eles são texto livre com significado próprio, e proposta/aprovação passariam a depender da interpretação de observações. Guardar a intenção somente no snapshot também não atende à revisão anterior à geração do Contrato. Auditoria e histórico não devem substituir o registro operacional da condição atual.

Não será preenchido valor_negociado artificialmente apenas para satisfazer o CHECK. A precedência `valorAprovado ?? valorTabela` continua representando a base comercial, antes do desconto da forma de pagamento.

## 4. Objetos propostos

Uma nova migration, sem editar migrations aplicadas e sem alterar `schema_mvp_kidmais.sql`:

1. Acrescentar `fechamentos.condicao_pagamento jsonb NULL`, sem default. Documento versionado para os novos fluxos: forma pretendida, condição PIX proposta (entrada em centavos, parcela em centavos e quantidade, todos opcionais), estado da revisão e condição aprovada separada. O backend controla o estado e os dados aprovados; a API pública aceita apenas a proposta. O documento identifica a aplicação da nova regra comercial sem inferir isso de uma data de corte.
2. Acrescentar `aprovacoes_negociacao.condicao_pagamento jsonb NULL`, sem default. Documento imutável por decisão contendo proposta analisada, condição aprovada quando houver, forma, base comercial resolvida, percentual, desconto em centavos e total contratual em centavos. Autor, momento e decisão continuam nas colunas existentes. Não criar tabela paralela de aprovação.
3. Acrescentar CHECKs para documentos JSON do tipo objeto e versão reconhecida. A aplicação fará a validação detalhada de precisão, limites, campos permitidos e transições; nenhum arredondamento de entrada subcentavo será aceito.
4. Substituir somente `fechamentos_status_negociacao_check`, preservando o caso atual de valor_negociado e permitindo também AGUARDANDO_APROVACAO para documento válido de PIX parcelado com revisão PENDENTE. Não remover as restrições existentes de valor aprovado, valores positivos ou estados.

Não alterar tabelas de preços, Contrato, Pagamentos, índices financeiros, locks ou idempotência. Nenhuma tabela nova ou status global novo é proposto.

## Fluxo de código após autorização

- Etapa 8: PIX à vista 10%, PIX parcelado 3%, cartão 0%; campos opcionais de condição pretendida para PIX parcelado. Não inferir plano definitivo nem exigir que a proposta some o valor contratual.
- Fechamento: persistir a proposta validada; novos PIX parcelados aguardam revisão, mesmo sem desconto negociado adicional. Nenhuma escrita no domínio Pagamentos.
- Revisão administrativa: integrar decisão e histórico à estrutura aprovacoes_negociacao; bloquear e revalidar o Fechamento em transação, registrar proposta e condição aprovada separadamente. Manter a trava administrativa atual até autenticação real. Liberar AGUARDANDO_CONTRATO somente após aprovação explícita; repetição não deve criar decisões duplicadas inadvertidamente.
- Cálculo: resolver primeiro a base comercial válida; calcular o total em centavos inteiros com arredondamento comercial ao centavo. Para base de 929.000 centavos: PIX à vista 836.100; PIX parcelado 901.130; cartão 929.000. O desconto monetário é a diferença entre base e total, mantendo igualdade exata. As entradas são verificadas antes de qualquer conversão/arredondamento.
- Novo Contrato: congelar forma, base, percentual/valor do desconto, total, proposta e condição aprovada no snapshot. Registros legados não serão reinterpretados silenciosamente como se tivessem sido aprovados sob a regra nova. Versões existentes não serão regravadas; contratos assinados permanecem protegidos.
- Pagamentos: continuar consumindo snapshot.comercial.valorFinalContrato; não recalcular desconto. O plano explícito posterior deve somar exatamente o total assinado.

## 5. Impacto em dados existentes

As colunas novas permanecem NULL nos registros existentes. Não haverá UPDATE de preenchimento, backfill, regeneração de contratos ou alteração de snapshots/hashes. Os dois casos reais de Pagamentos serão preservados e conferidos novamente.

O ALTER TABLE exige lock de DDL; a criação/validação de CHECKs pode examinar registros. A aplicação deve ocorrer sem transações de negócio concorrentes durante a janela local. O fluxo legado continua permitido pela parte original do CHECK.

## 6. Rollback

A aplicação da migration será transacional: erro antes do COMMIT desfaz todo o DDL. Antes de haver dados novos, o rollback consiste em restaurar o CHECK original e remover os CHECKs/colunas adicionados, junto da reversão do código correspondente.

Depois de haver propostas ou aprovações novas, não executar DROP automaticamente: isso apagaria dados comerciais, e o CHECK original poderia rejeitar novos Fechamentos pendentes sem valor negociado. Nesse cenário, preservar os documentos, suspender novas operações e apresentar correção adiante ou rollback com exportação e tratamento explícito dos estados, sob nova autorização. Snapshots contratuais existentes nunca serão apagados como parte desse rollback.

## Validação prevista

Os dez casos pedidos serão cobertos, incluindo persistência sem criação financeira, snapshot de 9.011,30, criação posterior de Pagamentos no mesmo valor, valores inválidos/subcentavos e preservação dos contratos existentes. Acrescentar testes de aprovação pendente, recusa, condição aprovada diferente da pretendida, acesso administrativo bloqueado e tentativas públicas de enviar aprovação.

Executar novamente regressões de Fechamento/preços, Contrato, Pagamentos, Identidade/CRM e Disponibilidade, TypeScript, lint direcionado e build. Os testes com escrita usarão fixtures sintéticas e rollback; a validação visual terá instruções reproduzíveis no relatório final.

Nenhum código funcional, migration ou dado foi alterado para produzir esta proposta. O único arquivo criado é este documento.
