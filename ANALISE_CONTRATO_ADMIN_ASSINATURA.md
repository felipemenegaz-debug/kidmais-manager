# Contrato administrativo e assinatura Kidmais — análise prévia

Data: 09/09/2026. Estado: inspeção concluída; implementação pausada pelas condições expressas no pedido. Este documento não é um relatório de funcionalidade implementada nem uma autorização de migration.

## Estado preservado

Checkpoint: `.backups/pix-validado-20260909-130820/`.

- ZIP de fontes/configuração: `kidmais-manager-fontes.zip`, com 270 arquivos, incluindo Migration 012, schema original, assets, lockfile e configuração local. Não inclui dependências, build ou caches.
- Manifesto de cada arquivo: `manifesto-fontes.json`. Os 270 conteúdos do ZIP foram conferidos por SHA-256.
- PostgreSQL: `kidmais_manager.dump`, formato custom, produzido pelo pg_dump 18. O catálogo foi lido com pg_restore e salvo em `catalogo-dump.txt`. Não foi realizado ensaio de restauração em outro banco.
- Hashes dos quatro artefatos principais: `hashes-artefatos.json`.
- Documentos disponíveis: `documentos/`, com dois PDFs oficiais e três resumos, além do manifesto. As cópias dos dois documentos assinados conferem com os hashes persistidos. A terceira versão é de pacote sem template oficial disponível; não foi inventado um PDF oficial.
- Não há repositório Git nesta pasta; portanto, não foi criado commit.

Na conferência final da pasta contra o checkpoint, 269 arquivos permanecem idênticos. A única diferença é `next-env.d.ts`: as duas referências geradas passaram de `.next/types/` para `.next/dev/types/`, compatível com a geração do Next em desenvolvimento. Não editei nem reverti esse arquivo gerado. O ZIP preserva o conteúdo anterior; nenhum fonte de domínio apresentou divergência.

Os documentos foram obtidos pelo renderizador existente em consulta de leitura, sem atualizar versões ou hashes no banco. Isso preserva cópias verificadas no checkpoint; não significa que o domínio atual já tenha armazenamento permanente dos bytes do PDF.

## Os nove pontos solicitados

1. **Ciclo atual:** Fechamento apto e condição comercial revisada → geração do snapshot/versão → acesso público com identidade/OTP → aceite da versão e do documento → Contrato assinado e atualização do Fechamento. Pagamento continua dependendo de criação explícita. Não existe etapa de assinatura Kidmais.
2. **Estados físicos:** `contratos.status`: `AGUARDANDO_ASSINATURA`, `ASSINADO`, `CANCELADO`. `contrato_versoes.status`: `ATIVA`, `SUBSTITUIDA`, `ASSINADA`, `CANCELADA`. Não há estados próprios de elaboração, assinatura Kidmais ou liberação ao cliente. A base contém três contratos e três versões: dois assinados e um aguardando assinatura/ativo.
3. **PDF:** `lib/contratos/services/documento.service.ts` coordena o documento; `lib/contratos/documento/oficial/registry.ts` seleciona o template oficial; `festa-completa-v1.ts` e `oficial/pdf.ts` montam o PDF. O template oficial disponível é Festa Completa V1. O PDF é gerado sob demanda; a base guarda hash e versão do template, não seus bytes.
4. **Snapshot e congelamento:** `contrato.service.ts` cria snapshot; `snapshot-core.ts` produz a representação canônica e SHA-256. O aceite em `contrato-publico.service.ts` bloqueia/reconsulta registros, confere documento/versão e grava a assinatura. A emissão posterior verifica o hash assinado. Hoje o serviço rejeita gerar nova versão de contrato já assinado; não há congelamento por assinatura Kidmais porque ela ainda não existe.
5. **Aceite do cliente:** reutiliza `validacoes_identidade_cliente`, finalidade `CONTRATO_ACEITE`, prova OTP consumida pela versão exata, token de acesso e verificações no servidor. A versão registra `assinado_em`, `documento_template_versao`, `documento_pdf_hash` e `aceite_metodo = OTP`. Contrato e Fechamento também mudam de estado. Não se deve refazer esse mecanismo.
6. **Auditoria:** os repositórios de `auditoria` e `eventos_historico_cliente` inserem eventos com ator/contexto, entidade, dados e metadados. Podem receber os novos eventos; porém registrar um UUID de desenvolvimento não prova a identidade do representante.
7. **Reutilização:** snapshot/hash, renderizadores e seção de integridade, acesso público/OTP, transações e bloqueios, auditoria/histórico, serviços comerciais oficiais, criação explícita de Pagamentos e padrões visuais de `RevisaoComercial`/admin Disponibilidade.
8. **Arquivos prováveis:** veja o mapa abaixo. É estimativa de impacto, não uma lista de alterações realizadas.
9. **Migration:** necessária. A estrutura não representa as novas assinaturas, a origem/tipo de alteração e a coexistência de versões assinadas com uma versão em elaboração. Não foi criada nem aplicada migration.

## Decisões que impedem implementar agora

### Identidade administrativa

`lib/http/admin-crm-api.ts` bloqueia as APIs administrativas em produção e só as habilita em desenvolvimento com `CRM_API_DEV_ENABLED=true`. O ator vem do cabeçalho `x-kidmais-dev-user-id`, controlado pelo solicitante. Não foi encontrada autenticação administrativa real no código nem tabelas de usuários/sessões administrativas entre as 30 tabelas públicas inspecionadas.

Os dados fixos de representante no template não são credenciais nem comprovam autorização. Antes de implementar a ação de assinatura é necessário definir autenticação, sessão e permissão de representante no servidor. IP/user-agent são contexto auxiliar, não identidade; cabeçalhos de proxy também exigem uma origem confiável.

### Versão em elaboração versus versão contratual vigente

O índice físico `contrato_versoes_corrente_uk` é único por contrato para `status IN ('ATIVA','ASSINADA')`. Portanto, V1 assinada e V2 ativa não podem coexistir. Alterar o status histórico de V1 apenas para contornar isso conflitaria com a preservação solicitada.

Proposta para discussão: distinguir a versão em elaboração da versão assinada vigente, mantendo V1 imutável. V2 só passa a valer após completar o novo fluxo. O modelo de retificação/aditivo deve registrar vínculo com a origem e não pressupor que todo aditivo substitui integralmente o contrato original.

### Impacto financeiro de V2

`lib/pagamentos/services/pagamento.service.ts` verifica a versão assinada contra `contratos.versao_atual`, tanto na criação quanto em operações de recebimento. Mudar esse ponteiro para um rascunho V2 pode bloquear operações de um Pagamento legitimamente vinculado a V1.

É necessário definir o tratamento de Pagamentos existentes quando V2 altera valor/condições e é assinada. Não se deve migrar recebimentos, recalcular descontos ou trocar o vínculo financeiro silenciosamente. A elaboração de V2, por si só, não deve invalidar os registros de V1. A solução precisa preservar a soma exata do plano e a versão que fundamenta cada obrigação.

### Documento imutável

Hoje há hashes e templates, mas não armazenamento durável dos bytes por versão. Uma mudança futura de template/asset pode causar falha de integridade na emissão histórica. Proponho preservar o documento definitivo de novas versões antes da primeira assinatura e servi-lo por ID de versão, sem modificar bytes depois.

A identificação eletrônica da Kidmais deve ser incluída no documento final durante a operação explícita, com dados autenticados e horário do servidor; então o hash dos bytes finais é associado à prova. Não inserir no próprio PDF seu hash integral como se fosse possível calculá-lo antes de finalizar os mesmos bytes. A prova pode referenciar esse hash externamente, reutilizando a seção de integridade para o identificador da versão/snapshot.

Para os documentos legados, manter os templates/assets históricos e a verificação existente. Não executar backfill de assinatura nem regravar versões antigas. O checkpoint contém as cópias verificadas disponíveis, mas não transforma o armazenamento da aplicação.

## Migration: situação e requisitos para a proposta executável

1. **Físico atual:** `contratos` tem status, `versao_atual`, autoria opcional e datas; `contrato_versoes` tem snapshot/hash, número, status, motivo e metadados do aceite OTP. A validação de identidade aponta para a versão consumidora. Existem checks de estado/assinatura e o índice parcial único descrito acima. Migration 012 permanece aplicada; não precisa ser refeita.
2. **Insuficiência:** não há representação de assinatura administrativa autenticada, liberação ao cliente, origem/tipo/diff de alteração ou documento imutável armazenado; o índice e o ponteiro atual não atendem V1 assinada + V2 em elaboração.
3. **Objetos candidatos, ainda não definidos como DDL:** evolução de `contratos`/`contrato_versoes` e seus checks/índices; registros de assinaturas vinculados à versão; metadados/armazenamento de documentos imutáveis. Estrutura de autenticação depende da decisão de identidade. Reutilizar auditoria/OTP em vez de duplicá-los.
4. **Impacto:** compatibilidade explícita para legados; revisão das consultas de versão corrente e das invariantes financeiras antes de ativar o novo fluxo. Nenhuma linha existente foi atualizada nesta inspeção.
5. **Backfill:** não executar. Ausência da nova assinatura deve ser tratada como legado, nunca como assinatura inferida. Defaults não podem transformar registros históricos em contratos assinados pela Kidmais.
6. **Rollback SQL:** ainda não há migration criada para desfazer. O SQL completo só pode ser definido após escolher os objetos e a semântica de versões/assinaturas. Um rollback que simplesmente apague novas assinaturas/documentos seria incompatível com o requisito de preservação. Antes de pedir autorização para criar a migration, a proposta deverá incluir rollback transacional que aborte se houver registros novos incompatíveis. O dump é recuperação do checkpoint, não rollback seguro de operações comerciais posteriores.
7. **Preservação de assinados:** manter IDs, snapshot, hash, datas e aceite OTP das duas versões assinadas; não trocar seu status para liberar o índice; não atribuir representante retroativamente. Novas alterações devem ter identidade e documento próprios, sem herdar assinaturas.

Esta análise não pede autorização para um DDL ainda indefinido. A próxima decisão é de arquitetura/autenticação; depois será possível apresentar objetos e rollback SQL exatos para aprovação, antes de criar qualquer migration.

## Mapa provável de arquivos

| Área | Arquivos/caminhos | Motivo provável |
| --- | --- | --- |
| Domínio Contrato | `lib/contratos/services/contrato.service.ts`, `contrato-publico.service.ts`, `documento.service.ts`, `snapshot-core.ts`, `models.ts`, `errors.ts` | Edição validada, estados, congelamento, assinaturas e documento por versão |
| Persistência Contrato | `lib/contratos/repositories/contrato.repository.ts`, `models.ts` | Histórico, origem e consultas de versão vigente/em elaboração |
| Documento | `lib/contratos/documento/oficial/registry.ts`, novo template versionado e modelos pertinentes | Novos documentos com identificação eletrônica, preservando V1 e seus assets |
| API | `app/api/admin/contratos/**`, `app/api/contratos/**` | Operações explícitas, autorização e seleção segura de versão |
| Interface | nova página/componente administrativo; `components/contrato/ContratoPublico.tsx` | Formulário, histórico, impressão e liberação ao cliente |
| Identidade administrativa | `lib/http/admin-crm-api.ts` e novos arquivos conforme arquitetura aprovada | Substituir identificação de desenvolvimento por autenticação/autorização reais |
| Pagamentos | `lib/pagamentos/services/pagamento.service.ts` e consultas pertinentes | Distinguir versão em elaboração da obrigação assinada sem alterar dinheiro automaticamente |
| Fechamento/comercial | serviços e modelos apenas onde a edição aprovada exigir | Validar mudanças com as regras oficiais; preservar PIX parcelado e Migration 012 |
| Testes | testes de Contrato, HTTP, integração, concorrência e regressões afetadas | Cobrir os 25 cenários solicitados após implementar |

Não foi alterado código de Contrato, Fechamento, Pagamentos, Disponibilidade ou CRM neste novo bloco. Não foi iniciado Festa. Foram acrescentados apenas o checkpoint e esta documentação. A regressão do PIX está documentada em `README_VALIDACAO_AJUSTE_PIX.md`; os testes da funcionalidade nova ainda não existem nem foram declarados aprovados.
