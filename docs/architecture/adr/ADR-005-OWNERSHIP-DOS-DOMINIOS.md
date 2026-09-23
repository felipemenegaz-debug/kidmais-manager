# ADR-005 — Ownership dos domínios V1

## Status

ACCEPTED — SaaS/ADR-005, 1B-C2. Ownership e política de visibilidade D11c expressamente aprovados e refletidos na matriz; schema ainda não definido. D11c CLOSED. D11b (identidade global opcional de clientes) continua CAN_DEFER.

## Contexto

O baseline contém exatamente 63 tabelas. Os nove catálogos preservados na B5B são conteúdo comercial canônico da Kidmais, não dados automaticamente globais da plataforma.

## Problema

Escolher quem possui cada registro, diferenciar identidade global de acesso e impedir que filhos/snapshots percam escopo.

## Drivers

CRM reutilizável na empresa; operação por unidade; configuração independente; integridade de documentos e caixa; ausência de compartilhamento implícito.

## Decisão

Adotar a [matriz das 63 tabelas](../OWNERSHIP-V1-63.md). Clientes, aniversariantes, responsáveis, deduplicação e histórico CRM pertencem à empresa. A mesma pessoa pode ter relações CRM independentes em empresas diferentes. Fechamento, contrato, pagamento/Festa e seus agregados operacionais pertencem à unidade; filhos têm escopo validado do pai. Configurações comerciais têm defaults da empresa e overrides/versões efetivas por unidade. Identidade administrativa é global, separada de memberships/grants; sessões e pré-auth ficam separados da operação tenant-owned. Auditoria empresarial tem unidade quando pertinente.

Conexões WhatsApp pertencem à EMPRESA, com associações configuráveis conexão ↔ estabelecimento da mesma empresa. Uma empresa pode ter várias conexões; uma conexão pode atender todas as unidades atuais, um subconjunto, ou coexistir com números diferentes por unidade. Não assumir 1:1 ou criar associações futuras implicitamente. Associação de conexão é roteamento, não grant de usuário: D03 permanece aberta para permissões em unidades futuras. Onboarding pertence à empresa legitimamente selecionada antes do OAuth; unidades candidatas e associações são autorizadas separadamente. Credenciais nunca são herdadas nem compartilhadas entre empresas. A associação é conceito futuro, não uma 64ª tabela já existente; migration 018 permanece história V1.

D11a: CRM empresa-owned é fechado. D11b: identidade global OPCIONAL de clientes é distinta da identidade administrativa D02 e dos registros CRM. Pode ser acrescentada futuramente por vínculo opcional sem mudar PKs/ownership empresariais, portanto CAN_DEFER; não é requisito da primeira migration. Reutilização futura só por fluxo autorizado pelo titular, com privacidade/auditoria e criação de relacionamento CRM independente. Buffet B não pode fornecer CPF/telefone/e-mail e receber dados privados de A. Não criar agora índice global de CPF, deduplicação cross-company, vínculo automático nem lookup público de identidade.

D11c CLOSED: existe um único relacionamento CRM por cliente dentro da empresa; não duplicar automaticamente por estabelecimento. Usuário com escopo empresarial apropriado acessa o CRM conforme suas permissões. Operador restrito à unidade acessa apenas dados CRM necessários de clientes legitimamente relacionados àquela unidade e aos fluxos autorizados que opera. Ownership empresarial não concede leitura completa nem edição irrestrita; cada ação/campo exige autorização e necessidade.

Busca arbitrária por ID, CPF, telefone ou e-mail não pode funcionar como diretório empresarial. Se o titular inicia legitimamente novo fluxo em A, ou existe outro fundamento/autorização operacional válido verificável no servidor, a resolução pode reutilizar o CRM existente na empresa, somente com os dados necessários/autorizados, e estabelecer a nova relação operacional com A. A simples declaração do operador de que existe um fluxo não comprova esse fundamento. Resolver identidade não concede acesso retroativo aos contratos, pagamentos, festas, fechamentos ou histórico operacional privado de B.

Separar APIs de resolução autorizada de identidade CRM, leitura completa do CRM e leitura de operações establishment-owned. Toda resolução sensível é auditável e não enumerável, inclusive respostas negativas. D11b não altera essa política. A representação de vínculos, campos/ações permitidos e provas de fundamento na 1C deve implementar esses limites, sem inventar grant ampliado nem reabrir ownership.

## Alternativas consideradas

Clientes globais por CPF introduzem correlação indevida entre empresas. Duplicá-los sempre por estabelecimento dificulta histórico e dedup. Tornar pacotes/seeds Kidmais globais impede configuração independente. Copiar automaticamente credenciais da empresa para unidades amplia exposição.

## Consequências positivas

Cada tabela tem destino e regra de referência; permite revisão mecânica da cobertura antes da primeira migration.

## Consequências negativas/trade-offs

Algumas tabelas V1 combinam preocupações que poderão exigir desdobramento, como identidade, sessões, rate limit e auditoria de login. A matriz não impõe uma tabela física para cada conceito. Compartilhar conexão WhatsApp na empresa exige roteamento inequívoco e autorização nas associações; não autoriza todos os operadores da empresa a acessar suas credenciais.

## Invariantes

I01–I04/I08. Ownership não equivale a permissão: cliente empresa-owned não é automaticamente visível integralmente a qualquer usuário de uma unidade. Operações entre unidades são explícitas e nunca atravessam empresas.

## Implicações de segurança

PII e blobs de documento recebem a mesma autorização do agregado. Hash técnico/UUID conhecido não concede acesso. O papel plataforma não torna linhas operacionais globais.

## Implicações para migrations

Preservar PKs e conteúdos assinados; estabelecer escopo de todo filho e resolver campos polimórficos/JSON fora de FKs. Unicidade CPF deve ser revisada para empresa. Credenciais WhatsApp não entram como seed nem são herdadas implicitamente.

## Implicações para testes

T01–T06/T09/T13/T16: filhos cruzados, cliente compartilhado A1/A2 autorizado, negação empresa B, documentos/recebimentos por ID, dedup e auditoria segmentados. T16 cobre resolução legítima sem duplicação, mínimo de campos por fluxo, ausência de diretório e nenhuma leitura retroativa das operações da outra unidade.

## Rollout

Aprovar matriz e desdobramentos; desenhar chaves na 1C; adaptar agregados em sequência preservando invariantes, não simplesmente adicionar colunas sem consumidores.

## Critérios de aceite

63 nomes únicos iguais ao manifesto congelado, sem omissão; cada linha informa chave tenant, necessidade de unidade, risco e ADR; OPENs têm responsável e gate no índice.

## Questões em aberto

D02/D04/D05/D09/D11a e D11c fechadas como direção; representação física na 1C. D11b — CAN_DEFER: identidade global opcional de clientes e seu fluxo de consentimento, desabilitados até desenho/aprovação próprios. D03/D10 permanecem MUST_DECIDE_BEFORE_FIRST_TENANT; D11c não antecipa essas decisões.
