# 06 — Changelog Funcional

## 2026-09-21 — Productização SaaS
Definido:
- arquitetura Empresa → Estabelecimentos → Configurações/Dados Operacionais;
- código identificador próprio por empresa;
- múltiplos estabelecimentos por empresa;
- configurações independentes por unidade;
- herança opcional de padrões da empresa com sobrescrita por estabelecimento;
- isolamento entre empresas/tenants;
- escopo por estabelecimento para dados operacionais;
- transformação de regras comerciais específicas em configurações;
- segurança, auditoria e integridade permanecem no Core;
- roadmap interno separado do roadmap comercial;
- trilhas Produto, Plataforma, Segurança, Reliability, Developer Experience, Customer Success, SaaS Operations e Data/AI;
- marcos segunda empresa, 10 empresas e 50 empresas;
- productização priorizada antes de IA, estoque e expansões avançadas.

## 2026-09-15 — Festa e contrato
Definido:
- fechamento público concluído não cria Festa automaticamente;
- a Festa deve ser criada quando o contrato estiver assinado por ambas as partes;
- investigar qualquer divergência entre fechamento aprovado, contrato assinado e visibilidade no módulo Festas.

## 2026-09-15 — Clientes / CRM
Definido:
- exclusão lógica/arquivamento com dupla confirmação;
- remoção da lista ativa;
- lixeira/histórico;
- possibilidade de restauração;
- preservação de vínculos e auditoria;
- exclusão física somente quando segura.

## 2026-09-09 — Contratos
Definido:
- edição administrativa antes da assinatura;
- PDF regenerado a partir dos dados/template-fonte;
- documento assinado nunca é sobrescrito;
- alterações materiais posteriores exigem nova versão/aditivo/retificação e, quando necessário, novo aceite.

## 2026-09-09 — Pagamentos
Definido:
- PIX parcelado com 3% de desconto;
- saldo calculado após entrada;
- parcelamento validado pelo sistema;
- nenhuma parcela pode vencer após a data da festa.
