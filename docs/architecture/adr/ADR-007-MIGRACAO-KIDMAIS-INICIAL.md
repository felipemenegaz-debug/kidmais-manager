# ADR-007 — Migração da Kidmais atual

## Status

ACCEPTED — SaaS/ADR-007, direção D07/D08/D12b aprovada na 1B-C1. Plano conceitual; nenhum SQL, schema físico ou execução autorizados. Mapeamentos executáveis e evidências de reconciliação continuam futuros.

## Contexto

O [manifesto congelado](../../../database/baseline/v1-post-019.manifest.json) fixa 001–019, com 006+006a composta e funções 014 parcialmente substituídas por 019. A B5B certifica operação vazia em descartável, não demonstra migração de todos os dados históricos ocupados.

## Problema

Converter dados V1 para a primeira empresa/unidades sem perder identidade, autoria, PDFs, fatos financeiros, histórico e invariantes; não inventar a unidade de cada registro.

## Drivers

Preservar IDs quando seguro; manter conteúdos assinados; compatibilidade gradual; backfill auditável/idempotente; validação e recuperação mensuráveis.

## Decisão

Destino D07 aprovado: uma empresa Kidmais e um estabelecimento inicial. Essa cardinalidade é evidência humana explícita, não inferência pelo nome. Mapear raízes operacionais para esse contexto e derivar filhos por pais autoritativos; referências contraditórias/órfãs continuam bloqueadoras. Não inventar unidades adicionais nem reinterpretar histórico. IDs/códigos concretos serão definidos no plano executável. Backfill idempotente, tenant-aware, verificável e em lotes com checkpoints: preencher ausências, comparar atribuições existentes e recusar divergências. Preservar IDs quando seguro, contratos, pagamentos, festas, documentos, autoria, auditoria e invariantes.

Preferir tenant keys diretas quando a atualização segura de metadados respeitar as proteções existentes. Sidecar NÃO é arquitetura padrão: somente exceção justificada por tabela histórica protegida, com cobertura obrigatória, integridade, atomicidade, tenant scope e constraints/policies adequadas. Não basta um join opcional para filtrar registros. Definir tratamento de ausência de mapeamento que falhe fechado e impeça confirmação de estado incompleto. Nunca reescrever hashes, documentos assinados ou provas para facilitar tenancy.

Sessões, OTPs e tentativas de onboarding efêmeras/ambíguas não ganham atribuição por palpite; avaliar expiração/revogação/reemissão planejadas, preservando a trilha. Provas já consumidas seguem o recurso comprovado. Grants V1 exigem mapeamento explícito de ação e unidade inicial, sem ampliar poderes para empresas/unidades futuras.

## Alternativas consideradas

Recriar IDs quebra referências e documentos. Tratar sanitizador EMPTY_OPERATION como migration elimina dados e é inadmissível. Backfill universal para uma unidade sem validação oculta ambiguidade. Downgrade destrutivo ou desabilitar triggers globalmente remove garantias.

## Consequências positivas

Mantém rastreabilidade e permite reconciliação por agregados e identidade; cada lote tem estado verificável.

## Consequências negativas/trade-offs

Triggers append-only e validações diferidas tornam backfill não trivial; lock/tempo/volume ainda desconhecidos. Exige simulação em dados sintéticos ocupados representativos, não apenas schema vazio.

## Invariantes

Preservar invariantes de assinatura/019, fatos imutáveis/015, auditoria append-only e relação fechamento→contrato→Festa. I01–I04 passam a ser obrigatórios após validação. Nenhuma atribuição ambígua é aceita.

## Implicações de segurança

Mapeamento de usuários V1 para memberships não concede administração irrestrita. Sessões/capabilities legadas são reemitidas ou revogadas de forma planejada. Secrets de integração nunca são copiados para fixtures; o planejamento de credenciais é separado. Ensaios somente em destino isolado explicitamente autorizado, com dados sintéticos ou clone sanitizado adequado.

## Implicações para migrations

Novas migrations SaaS serão novas entradas, sem reescrever 001–019. Dados canônicos 006+006a e mutação 017 são da Kidmais; não viram templates globais mutáveis. Tenant keys podem ser temporariamente nullable somente quando necessário ao rollout single-tenant, sem DEFAULT implícito de tenant. Triggers imutáveis exigem plano antes do backfill: alteração estreita segura de metadados ou exceção sidecar D08, nunca DISABLE TRIGGER genérico. Validar nulidade, FKs, uniques, hashes e agregados financeiros antes/depois. Tratar índices/locks por tabela na 1C; não afirmar zero downtime sem medição.

## Implicações para testes

T14/T15: reexecução idempotente, lote interrompido, órfão, vínculo conflitante, graph financeiro 015 ocupado, formalização 019, PDFs/assinaturas byte a byte e ausência de efeito cross-tenant. Registrar contagens/checksums seguros, sem publicar hashes de PII em logs.

## Rollout

Expandir → instalar writers compatíveis e leitura transitória explicitamente limitada à Kidmais única → retirar/drenar escritores antigos → backfill/reconciliação final → impedir novos registros obrigatórios sem escopo → validar/endurecer constraints → retirar leitura global V1 e toda compatibilidade tenant NULL → provar isolamento. Leitor novo não pode ocultar registros legados silenciosamente; o plano de compatibilidade será testado, não um fallback global permanente. Antes do segundo tenant, rollback somente para build compatível com schema aditivo e gate single-tenant preservado. Após segundo tenant, jamais voltar a readers V1 globais; aplicar [ADR-008](ADR-008-ROLLOUT-E-COMPATIBILIDADE.md).

## Critérios de aceite

Mapeamento D07 aprovado; nenhum órfão; conteúdo imutável preservado; todos os writers cobertos; métricas de lote/reconciliação e plano de recuperação testados sem banco real.

## Questões em aberto

D07/D08 fechadas como direção; atribuição de uma empresa/unidade aprovada. Estratégia por tabela, IDs/códigos concretos, grants iniciais, política de expiração/reemissão e prova de preservação são entregáveis do plano executável, sem inventar fatos históricos. D12a CLOSED: [inventário](../SAAS-CONFIG-AUTHORITY-MAP.md), inclusive ausência de versão histórica de área e fontes fora do banco; D12b: compatibilidade runtime/schema antes dos rollouts; D12c: provisionamento/operação até os gates pertinentes. Impasse de atribuição histórica ou nova escolha de negócio exige retorno ao usuário.
