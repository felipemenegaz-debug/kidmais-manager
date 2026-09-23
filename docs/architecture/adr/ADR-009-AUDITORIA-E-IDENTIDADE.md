# ADR-009 — Auditoria e identidade

## Status

ACCEPTED — SaaS/ADR-009, direção D09 aprovada na 1B-C1. Envelope e limites de segurança aceitos, autoria V1 preservada; representação física, retenção operacional e provas de durabilidade permanecem futuras.

## Contexto

A [auditoria V1](../../../lib/clientes/repositories/auditoria.repository.ts) persiste ator, usuário, recurso, antes/depois e correlação, sem empresa/unidade. Eventos de Festa/financeiro e assinaturas têm snapshots próprios que não podem ser reescritos silenciosamente.

## Problema

IDs e snapshots sem contexto podem ser interpretados como pertencentes ao tenant corrente, esconder origem de sistema ou expor PII em logs.

## Drivers

Autoria imutável; rastreabilidade; minimização de dados; investigação por escopo; compatibilidade com documentos assinados.

## Decisão

Evento autorizado registra contexto legítimo: empresa, unidade quando aplicável, ator/principal, usuário quando humano, escopo usado, origem de sistema, ação, recurso autorizado, resultado, instante e correlação. SISTEMA exige principal de serviço, não apenas usuário ausente. Snapshots novos preservam origem validada; conteúdo histórico assinado permanece intacto, ligado a escopo por D08.

Tentativa cross-tenant pertence ao contexto legítimo do solicitante: não consultar tenant alvo para descobrir ownership, não criar evento nele e não afirmar que o recurso candidato pertence ao solicitante. Minimizar o identificador informado e tratá-lo como alvo NÃO VERIFICADO, sem FK/snapshot de recurso obtido por lookup privilegiado. Sem contexto tenant legítimo, usar superfície/canal de segurança separado para pré-auth/plataforma. Não usar empresa_id NULL como wildcard de auditoria operacional. O desenho físico distinguirá alvo candidato de recurso autorizado, sem fabricar identidade histórica.

D11c exige auditar resolução CRM sensível no contexto autorizado da empresa/unidade, com fundamento, ação, resultado e correlação minimizados. Tentativa arbitrária não provoca lookup privilegiado nem revela se o cliente existe em outra unidade; não incluir seu histórico na resposta ou no evento visível ao solicitante. Reutilização legítima de CRM não libera trilhas operacionais de outras unidades. Validar também T16.

## Alternativas consideradas

Completar o tenant do snapshot em tempo de leitura usando o tenant corrente falsifica origem. Copiar o payload inteiro para auditoria expõe dados/secrets. Globalizar todas as trilhas impede acesso seguro por empresa.

## Consequências positivas

Permite investigar autorização e sistema sem ambiguidade; conserva a história anterior à migração.

## Consequências negativas/trade-offs

Mais metadados e definição de retenção; eventos pré-auth nem sempre possuem tenant legítimo. Envelope do legado precisa explicitar origem/método de atribuição.

## Invariantes

I08. Evento operacional autorizado e recurso resolvido pertencem ao mesmo escopo apropriado. Evento de tentativa usa contexto legítimo do solicitante e alvo não verificado, sem afirmar ownership do alvo. Correlação não autoriza acesso. Auditoria não é mecanismo de enumeração cross-tenant; acesso administrativo/suporte a ela também é auditado e exige autorização.

## Implicações de segurança

Allowlist de campos, redaction e controle de leitura por escopo. Nunca registrar senha, token, OTP, credencial cifrada utilizável, documento integral ou payload irrestrito. Mapear tratamento de erros brutos da V1 como trabalho futuro, sem afirmar vazamento comprovado. Falha na gravação de auditoria obrigatória deve impedir confirmação da mutação ou usar mecanismo transacional durável aprovado.

## Implicações para migrations

Separar autenticação/plataforma de eventos operacionais conforme D09. Preferir escopo direto; relação auxiliar D08 é excepcional, com cobertura obrigatória, atomicidade, integridade, tenant scope e policies adequadas. Preservar append-only/IDs/PDFs/hashes. Não fabricar membership histórica; registrar atribuição de migração separadamente. Constraints de evento autorizado não podem exigir lookup de recurso alheio para registrar uma negação.

## Implicações para testes

T09/T12/T14: evento autorizado A não aponta para B; tentativa A→UUID B e A→UUID inexistente não revela diferença de existência a A nem faz lookup privilegiado. Testar ausência de contexto, ator sistema identificado, suporte sem grant negado, rollback sem evento de sucesso órfão, legado rastreável e logs livres de canários sensíveis. Negação tem persistência própria adequada ao resultado, sem se perder acidentalmente no rollback da mutação negada.

## Rollout

Primeiro inventariar trilhas e pontos de emissão; definir contratos de evento; migrar metadados históricos de forma auditável; habilitar emissão SaaS; validar segregação antes do segundo tenant.

## Critérios de aceite

Todo evento sensível resolve ator e escopo sem depender da sessão de quem consulta; testes negativos de leitura e sanitização de logs passam; campos obrigatórios têm origem comprovada.

## Questões em aberto

D09/D08 fechadas como direção. Separação física das trilhas e mecanismos de persistência serão detalhados na 1C. Retenção, durabilidade operacional e eventual suporte delegado devem fechar antes de habilitar os respectivos fluxos; não há acesso de suporte implícito. D10 permanece aberta para revogação concorrente. Identidade global opcional do cliente (D11b) não é autorização para compartilhar trilhas CRM de empresas distintas.
