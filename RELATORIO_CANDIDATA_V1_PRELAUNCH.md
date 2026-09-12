# Kidmais Manager V1 — candidata de pré-lançamento

Data: 11/09/2026

## Resultado

Esta candidata recebeu somente correções e proteções de lançamento. As duas exceções de disponibilidade foram removidas do arquivo local mediante autorização explícita. Nenhuma conexão com o banco real foi aberta e nenhuma migration, DDL ou DML foi executada.

| Verificação | Resultado |
| --- | --- |
| Testes unitários | 156 aprovados; 0 falhas |
| ESLint global | aprovado; 0 erros e 0 avisos |
| TypeScript | aprovado |
| Build Next.js de produção | aprovado |
| Auditoria npm de dependências de produção | 0 vulnerabilidades conhecidas |
| Smoke HTTP local | raiz redireciona para Disponibilidade; rota Festa antiga redireciona para Admin; Pocket é recusado antes do banco com `PACOTE_FORA_ESCOPO_V1` |
| Cabeçalhos | nosniff, SAMEORIGIN, Referrer-Policy, Permissions-Policy e HSTS em produção |
| Health check sem ambiente configurado | HTTP 503 esperado; falha fechada, inclusive para configuração OTP ausente/insegura |
| Guarda da leitura do banco real | recusou execução sem autorização explícita, como esperado |

## Preservação comprovada

- Migration 016 inalterada: SHA-256 `3843802812f7a970f8824f3836eef592bf3b565d1721a4ed33c75e5b620774a2`.
- `data/disponibilidade.json` alterado exclusivamente para remover as duas exceções autorizadas: SHA-256 anterior `d29dd8587a1652baedc6b3606a4059a2f15ff6e1e6da3f4ee9a8530a2c3b3a3b`; novo SHA-256 `547e1db8ab65433a9912403a99775d4b27b3e180d611a9c4b693d7ace1ad6d1b`.
- `package-lock.json` inalterado: SHA-256 `f8b354bb5106d247b4231244146fdc30363372c9e910dde608fbb733f25e6fd2`.

## Correções incluídas

- remoção da página padrão do Next.js na raiz;
- retirada de Festa e duplicidades mockadas das rotas acessíveis;
- retirada de componentes mortos que simulavam gravação apenas local;
- limpeza de rótulos de protótipo, ambiente de teste e integrações pendentes no CRM;
- links do CRM para o fechamento e para as Festas reais;
- cabeçalhos básicos de segurança e remoção de `X-Powered-By`;
- endpoint `/api/health` com PostgreSQL, flag Festa e assinatura física da 016;
- regressão estática reproduzível em um comando;
- verificação pós-016 somente de leitura, protegida por autorização explícita;
- modelo de variáveis e runbook de implantação, backup, recuperação e rollback da aplicação;
- correção dos oito erros e dois avisos de lint existentes, sem mudança de regra de negócio.
- restrição do fechamento online a Essencial, Completa e Premium, com bloqueio na interface, na API e no serviço transacional antes de qualquer gravação.
- integração do OTP com a WhatsApp Cloud API oficial, por template, com timeout, telefone normalizado, configuração validada e erro sanitizado;
- fechamento e aceite público limitados a WhatsApp; SMS/e-mail permanecem apenas modelados para evolução futura e não são oferecidos na V1;
- proteção de produção que recusa emissor `console` e faz o health check falhar quando faltam credenciais/configuração do canal oficial.
- remoção autorizada das exceções Pocket de 19/09/2026 e Premium de 23/09/2026, com teste que exige listas comerciais vazias na candidata.

## Situação de lançamento

Os gates de pacotes vendáveis, implementação do emissor OTP e exceções comerciais foram resolvidos no código. A situação permanece **NO-GO** até resolver os três gates descritos em `OPERACAO_V1_PRODUCAO.md`: conta/número/template WhatsApp homologados de ponta a ponta, regressão integrada/homologação em navegador e infraestrutura com backup restaurado.
