# Fila administrativa Em contratação

## Operação

Em **Festas → Em contratação**, o operador acessa fechamentos sem Festa. A mesma
fila aparece em **Clientes → perfil → Festas e fechamentos**, filtrada pelo cliente.
Os links levam à revisão existente ou ao contrato existente, sem digitar UUID.

`GET /api/admin/fechamentos/contratacoes?clienteId=<uuid>` usa a autorização
administrativa da revisão comercial e responde com `Cache-Control: no-store`.
O filtro de cliente é opcional, validado e parametrizado. A consulta usa LEFT JOIN
para preservar fechamentos sem contrato e uma única ida ao banco.

## Classificação e ações

| Estado existente | Apresentação / ação |
| --- | --- |
| RASCUNHO | Preparação / Abrir revisão |
| AGUARDANDO_APROVACAO | Aprovação comercial / Revisar proposta |
| APROVADO | Proposta aprovada / Abrir revisão |
| AGUARDANDO_CONTRATO sem contrato | Aguardando contrato / Gerar contrato na revisão |
| EM_ELABORACAO | Elaboração / Abrir contrato |
| EM_ELABORACAO com documento revisado | Aguardando Kidmais / Assinar pela Kidmais no contrato |
| ASSINADA_KIDMAIS | Assinado pela Kidmais / Abrir contrato para liberar acesso |
| AGUARDANDO_CLIENTE | Aguardando cliente / Abrir contrato e acesso público |
| ASSINADO sem Festa | Formalizado — Festa pendente / Abrir contrato e solicitar verificação |

CONTRATO_ASSINADO, AGUARDANDO_PAGAMENTO e CONFIRMADO sem Festa também permanecem
visíveis para não esconder inconsistências legadas. Se faltar contrato, a fila
orienta verificar o vínculo. A edição cancelada de um contrato ainda ativo é
identificada como preparação cancelada, sem autorizar retomada automaticamente.

Qualquer Festa vinculada exclui a contratação da fila, inclusive Festa invalidada.
Fechamentos CANCELADO, RECUSADO, EXPIRADO e contratos CANCELADO não são ativos.
Quando há contrato, sua edição determina o próximo passo e nunca se oferece
gerar outro contrato. O painel contratual continua validando as permissões e
pré-condições de cada ação.

## Atualização e limites

A fila recarrega a cada 30 segundos e ao receber foco. Ao selecionar uma aba de
Festas, a lista de Festas é atualizada. A fila não antecipa a classificação em
Próximas nem cria Festa, reserva horário ou executa reconciliação.

Não há migration nem alteração da formalização 019. A resposta contém somente
os campos necessários aos cards, sem documentos, assinaturas ou snapshot completo.
A fila não possui paginação; reavaliar volume e frequência de atualização conforme
o uso. Falhas de carregamento aparecem como erro, nunca como fila vazia.

## Validação local

Testes de classificação, consulta com executor simulado, API com dependências
simuladas e renderização dos cards não acessam banco nem serviços externos.
Executar `npm run check:v1:static` e `npm run production:test`.
Um smoke autorizado posterior deve validar dados reais, transição após a segunda
assinatura, acesso pelo CRM e o comportamento visual no navegador.
