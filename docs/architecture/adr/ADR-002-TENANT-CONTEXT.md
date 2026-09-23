# ADR-002 — Tenant Context e fronteira de confiança

## Status

ACCEPTED — SaaS/ADR-002, direção D06 aprovada na 1B-C1. Contrato de confiança aceito; mecanismo físico e código continuam futuros. D10 não é resolvida por este aceite.

## Contexto

[Sessão administrativa](../../../lib/autenticacao/service.ts) identifica usuário e papel globais; [contexto CRM](../../../lib/clientes/services/context.ts) contém usuário/origem, sem empresa. [withTransaction](../../../lib/db/postgres.ts) reserva uma conexão, mas não instala contexto tenant.

## Problema

Um ID válido na URL, header, cookie de seleção ou corpo não demonstra vínculo com empresa, unidade ou recurso. O mesmo problema existe em endpoints públicos e futuros jobs.

## Drivers

Negação por padrão; origem confiável; vínculo ao recurso; transação consistente; APIs públicas utilizáveis; diagnóstico sem PII.

## Decisão

Fluxo aprovado: autenticar principal → descoberta autorizada mínima de memberships/vínculos → resolver empresa, ação e unidades permitidas → reservar conexão → iniciar transação → instalar tenant context transaction-local → acessar dados operacionais → encerrar transação → liberar conexão sem contexto residual. Produzir contexto imutável com principal/usuário, empresa, unidades autorizadas, ação, origem e correlação. Seletores externos são candidatos, nunca autorização. Serviços/repositories tenant-owned exigem contexto em leituras, joins, contagens e mutações. Não usar estado global mutável nem configuração persistente no pool.

A descoberta é uma superfície de controle explicitamente separada do acesso operacional. Ela verifica a identidade/prova autenticada e retorna somente memberships do próprio principal ou bindings necessários à finalidade autorizada; não aceita um tenant candidato como prova e não expõe diretório global de clientes/recursos. O acesso restrito de descoberta antecede o contexto completo e não depende circularmente de consultá-lo numa superfície operacional já bloqueada. A 1C definirá mecanismo/roles/policies dessa superfície sem conceder owner, BYPASSRLS ou consulta global genérica ao runtime. Nenhuma consulta operacional acontece nessa etapa. Revalidar os vínculos para a transação; a ordenação exata frente à revogação concorrente permanece D10.

D11c distingue a descoberta mínima de bootstrap acima da resolução CRM em fluxo já autorizado na empresa/unidade. Esta última exige fundamento operacional verificável, retorna somente dados necessários/autorizados e não libera leitura completa do CRM nem operações de outra unidade. IDs/CPF/contatos não comprovam fundamento; aplicar a [política de visibilidade](ADR-005-OWNERSHIP-DOS-DOMINIOS.md) e T16.

## Alternativas consideradas

Sessão contendo apenas IDs sem revalidação mantém acessos revogados. Tenant inferido de UUID ou campo do payload permite IDOR. Host/subdomínio ajuda descoberta, mas não autoriza. Contexto implícito da Kidmais em qualquer endpoint é incompatível com múltiplas empresas.

## Consequências positivas

Autorização fica rastreável e testável; camada de dados pode recusar chamadas sem contexto antes da consulta.

## Consequências negativas/trade-offs

Exige adaptação transversal de APIs, serviços e repositories; revalidação tem custo e deve ser projetada contra condições de corrida.

## Invariantes

I02/I03/I05/I07/I08. O recurso pertence à empresa do contexto; a unidade pertence a essa empresa e está no escopo autorizado. Troca de empresa revalida tudo.

## Implicações de segurança

Rotas públicas usam descoberta restrita de vínculo servidor entre prova/capability e empresa/unidade/recurso; códigos públicos de descoberta não concedem leitura privada. Capabilities verificadas têm finalidade, expiração e operação restritas, sem equivaler a membership administrativa. OTP/prova e documento ficam ligados a esse vínculo desde emissão e no consumo. Webhook autenticado resolve conexão da empresa e associações autorizadas às unidades; se houver múltiplas unidades, usar vínculo operacional verificável, nunca escolher a primeira ou aceitar um ID do payload como autorização. Jobs revalidam principal de serviço e escopo ao consumir/repetir; contexto na fila isoladamente não basta. Sem contexto legítimo, fail closed.

## Implicações para migrations

Desenhar memberships, bindings e fronteira de descoberta antes de adaptar consultas operacionais. O transporte aprovado é transaction-local na conexão reservada, instalado antes da primeira consulta operacional tenant-owned; configuração local termina com a transação conforme a [semântica PostgreSQL](https://www.postgresql.org/docs/18/sql-set.html). Formato dos parâmetros e policies será detalhado na 1C.

## Implicações para testes

T03/T05/T07/T08/T09/T10: conexão fria sem tenant, descoberta do próprio principal, seleção B adulterada, capability expirada/recurso errado, webhook ambíguo, pool A→B, erro/rollback, revogação e job sem contexto. Cache/export/storage incluem empresa, unidade e visibilidade em chaves e autorização. Descoberta não pode retornar dados operacionais nem permissões de outro principal.

## Rollout

Adicionar interface de contexto, depois migrar cada entrada e consumidor. Adaptador V1 só permite empresa Kidmais explícita enquanto houver exatamente um tenant; não vira fallback genérico.

## Critérios de aceite

Inventário de entradas administrativas, públicas, jobs e exports coberto; nenhuma chamada tenant-owned sem contexto; logs comprovam a origem da autorização sem conter credenciais.

## Questões em aberto

D06 fechada como direção: descoberta autorizada separada e contexto transaction-local. Implementação das policies/roles/consultas de descoberta é trabalho da 1C. OPEN DECISION D10 — MUST_DECIDE_BEFORE_FIRST_TENANT: semântica exata de revogação versus commit, a fechar antes de habilitação multi-tenant externa. D03 continua aberta; não presumir unidades futuras autorizadas.
