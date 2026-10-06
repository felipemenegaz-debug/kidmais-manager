---
name: kidmais-business-rules
description: Consulta as regras oficiais do Kidmais Manager antes de alterar comportamento funcional. Use sempre que a tarefa mudar regra de CRM, disponibilidade, fechamento, contratos, pagamentos, festas, buffet ou configurações (preço, parcelamento, desconto PIX, assinatura, criação de festa, horários, cancelamento), ou quando houver dúvida sobre o que o sistema "deve" fazer.
---

# Regras de negócio do Kidmais Manager

`docs/` é a fonte oficial. Documentos na raiz (`RELATORIO_*`, `README_*`, `PROPOSTA_*`) são histórico: servem de contexto, nunca prevalecem sobre `docs/`.

## Passo a passo

1. Identifique o módulo pela pasta alterada e leia o documento dele **antes** de codar:

   | Código | Documento |
   |---|---|
   | `lib/clientes`, `lib/identidade`, `app/clientes` | `docs/modulos/CLIENTES-CRM.md` |
   | `lib/disponibilidade`, `lib/agenda`, `app/disponibilidade` | `docs/modulos/DISPONIBILIDADE.md` |
   | `lib/fechamentos`, `lib/comercial`, `app/fechamento` | `docs/modulos/FECHAMENTO.md` |
   | `lib/contratos`, `app/contrato` | `docs/modulos/CONTRATOS.md` |
   | `lib/pagamentos` | `docs/modulos/PAGAMENTOS.md` |
   | `lib/festas`, `app/festas` | `docs/modulos/FESTAS.md` e `docs/modulos/BUFFET.md` |
   | configurações, preços, pacotes | `docs/modulos/CONFIGURACOES.md` |

2. Leia também `docs/01-REGRAS-DE-NEGOCIO.md` (regras estruturais) e, se tocar em empresa/unidade, `docs/02-ARQUITETURA-SAAS.md`.
3. Confira o histórico de decisões em `docs/06-CHANGELOG-FUNCIONAL.md`.
4. No plano, **cite a regra** que a mudança cumpre ou altera, com o arquivo de origem.

## Invariantes que nunca podem ser quebrados (Core)

- Contrato assinado é imutável: correção gera nova versão, aditivo ou retificação, com histórico, motivo, data e responsável. Mudança material exige novo aceite.
- PDF do contrato é regenerado a partir dos dados/template-fonte, nunca editado direto.
- Fechamento público concluído **não** cria Festa; a Festa nasce quando o contrato está assinado pelas duas partes.
- Nenhuma parcela vence depois da data da festa; entrada, parcela e quantidade precisam ser coerentes; saldo após entrada é calculado pelo sistema.
- Cliente é arquivado (exclusão lógica com dupla confirmação, lixeira, restauração); exclusão física só quando segura.
- Segurança, auditoria, integridade e versionamento ficam no Core e não viram configuração (ADR-003).

## Regras específicas da Kidmais (viram configuração no SaaS)

- PIX parcelado com 3% de desconto; condição direta com a Kidmais.
- Foro dos contratos: Comarca de Brasília-DF.

Ao mexer nessas regras, não as espalhe em mais código fixo: prefira ponto único de configuração, como pede o ADR-003.

## Quando a regra não está documentada ou conflita

Pare e pergunte ao usuário. Não invente regra. Se a decisão for tomada, registre com a skill `kidmais-doc-sync`.
