# Calendário de eliminações

**Estado (03/11/2026): procedimento LOCAL, documental, não publicado.** Responsável: Felipe Menegaz, encarregado da Demerzel Labs. Enquanto as rotinas automáticas não existirem, os textos prometem que os prazos são controlados "por procedimento operacional da Demerzel Labs, com registro das eliminações realizadas" (Aviso, "Armazenamento, segurança e retenção"; Termos, "Depois do teste ou da assinatura"). Este calendário é esse procedimento.

Fonte de verdade: tabela de retenção do Aviso `2026-11-17-privacidade` e prazos dos Termos `2026-11-25-termos` e do DPA `2026-11-17-dpa`, em `lib/cadastro/documentos-legais.ts`. Se este calendário divergir dos textos, valem os textos. Nenhum prazo autoriza guardar todos os dados pelo maior prazo.

Índice: [INDICE.md](INDICE.md). Toda eliminação vai para `Registro de copias e eliminacoes LGPD`, sem dados pessoais.

## 1. Tabela de retenção (resumo dos textos)

| Categoria | Prazo | Quem elimina | Automático hoje? |
|---|---|---|---|
| Dados operacionais do buffet | Até **12 meses** contados da suspensão posterior aos 60 dias de somente leitura; pedido anterior de exclusão antecipa | Demerzel Labs | **Não**: procedimento (seção 3) |
| Contratos e evidências essenciais de contratação e aceite | Até **10 anos** após o término da relação ou cumprimento, como política de defesa contratual, **mediante necessidade documentada** | Demerzel Labs | Não |
| Documentos fiscais da assinatura | Prazo tributário: em regra **5 anos** contados do primeiro dia do exercício seguinte ao da emissão (CTN, art. 173), com extensão enquanto houver procedimento ou crédito não prescrito | Demerzel Labs | Não |
| Registros de acesso à aplicação | **6 meses**; preservações adicionais individualizadas quando legalmente cabíveis. Não significa guardar mensagens por 6 meses | Demerzel Labs | A conferir (seção 2, item 5) |
| Auditoria operacional e segurança adicional | **12 meses**, salvo necessidade específica documentada | Demerzel Labs | A conferir (seção 2, item 5) |
| Contratos, pagamentos e cobranças dos clientes do buffet | **5 anos** da festa ou do último pagamento (o que for mais tarde); festa cancelada: do cancelamento. Vale mesmo para quem saiu das campanhas | Demerzel Labs (anonimização) | **Não**: procedimento (seção 2, item 8) |
| Contato de cliente que contratou festa (campanhas e fidelidade) | Até pedir para sair, ou **5 anos** sem festa nem contato (contato = iniciativa do cliente; campanha sem resposta não renova) | Demerzel Labs (anonimização) | **Não**: procedimento (seção 2, item 8) |
| Contato de interessado que nunca contratou | **2 anos** sem contato | Demerzel Labs (anonimização) | **Não**: procedimento (seção 2, item 8) |
| Nome e nascimento da criança para lembrete de aniversário | Só com autorização do responsável; até revogar ou até o fim do prazo do contato. **Lembrete ainda não existe no sistema** | Demerzel Labs (anonimização) | Não se aplica hoje |
| Registro de quem saiu das campanhas (telefone ou e-mail e data) | Enquanto durar a assinatura do buffet, sem o resto do cadastro | — | Hoje ligado ao cadastro do cliente (e, no WhatsApp, ao número do PARAR); marca por telefone/e-mail **a implementar** antes de ligar o envio de campanhas. Na anonimização, manter o registro |
| Conversas e mídias do WhatsApp | Prazo **configurado pela empresa** (1 dia a 10 anos); padrão **recomendado: 12 meses sem atividade**. **Sem prazo configurado, não há eliminação automática** | Rotina de retenção, para empresas com prazo | Rotina existe; agendamento a conferir |
| Identificadores técnicos protegidos das conversas excluídas | **30 dias** após a exclusão, para impedir recriação por reentrega | Rotina de retenção | Sim, junto com a retenção |
| Registro de "não contatar" | Mantido para respeitar a oposição, sem a conversa | — | — |
| Alergias e observações de saúde | Preferencialmente **30 dias após a festa**, **por ação da empresa cliente**, salvo necessidade concreta (incidente, disputa) | Empresa cliente | **Não**. A Demerzel Labs só orienta |
| Cópias de segurança e exportações do banco | Ciclo máximo de **90 dias, incluindo cópias locais**; prazo menor onde disponível | Demerzel Labs | PITR sim (3 dias); demais, procedimento ([BACKUPS-E-COPIAS.md](BACKUPS-E-COPIAS.md)) |

## 2. Rotina mensal (todo dia 1º)

Cerca de 30 minutos. Ao fim, uma linha em `Registro de copias e eliminacoes LGPD` com a data e o resumo.

1. **Cópias e exportações (90 dias).** Rodar a rotina de [BACKUPS-E-COPIAS.md](BACKUPS-E-COPIAS.md), seção 3. Inclui as exportações completas entregues a empresas (classe F).
2. **Encerramentos de empresas.** Atualizar a lista de empresas em somente leitura ou suspensas (seção 3). Para cada uma, conferir as datas S (suspensão), A (aviso) e E (exclusão). Fazer o que vence no mês seguinte.
3. **WhatsApp.**
   - Conferir, por empresa com o canal ligado, se há prazo de retenção configurado.
   - Empresa sem prazo: suas conversas **não** são eliminadas automaticamente. Orientar a configuração (padrão recomendado: 12 meses sem atividade). Anotar a orientação.
   - Conferir que a rotina de retenção rodou no mês (contagens, sem conteúdo). Se não rodou, rodar uma vez (`scripts/whatsapp-atendimento-retencao.mjs`, no ambiente correto) — **a definir com autorização** em produção.
   - Pedidos de exclusão do mês: conferir que todos foram atendidos ([DIREITOS-DO-TITULAR.md](DIREITOS-DO-TITULAR.md)).
4. **Saúde.** Lembrar as empresas clientes de revisar e apagar as observações de saúde das festas com mais de 30 dias. A eliminação é ação da empresa. Anotar o lembrete.
5. **Registros de acesso (6 meses) e auditoria (12 meses).** Conferir se há rotina que elimina sessões e registros de acesso com mais de 6 meses e auditoria com mais de 12 meses. Se não houver, a eliminação é manual — **a definir com autorização** (leitura e escrita em banco de produção). Até lá, registrar o mês como "pendente de ferramenta".
6. **Contratos (10 anos) e fiscais (5 anos).** Uma vez por ano, no dia 1º de janeiro: listar o que passou do prazo e não tem necessidade documentada; eliminar ou anonimizar — **a definir com autorização**.
7. **Registro de acessos de suporte.** Conferir que todo acesso de suporte do mês foi anotado ([INDICE.md](INDICE.md), seção "Acessos de suporte").
8. **Clientes dos buffets (DPA, "Guarda dos dados dos clientes do Contratante" e "Fim dos prazos: anonimização").** Enquanto a anonimização automática não existir, no dia 1º de cada mês **M**:
   1. **Empresas no lote.** Só entram empresas cujo representante aceitou o DPA `2026-11-17-dpa` ou posterior: conferir a versão no registro de aceite do sistema ou, no reaceite manual, a evidência do documento eletrônico ([REACEITE-EMPRESA-EXISTENTE.md](REACEITE-EMPRESA-EXISTENTE.md)). Empresa sem esse aceite fica fora do lote e é anotada como pendente de reaceite.
   2. **Datas-base.** Para cada cliente ou interessado, registrar por categoria a data e a origem do marco: festa, último pagamento ou cancelamento (contratos e pagamentos); última festa ou última iniciativa do cliente — mensagem dele, pedido de orçamento ou resposta (contato para campanhas); última iniciativa (quem nunca contratou); pedido de saída das campanhas, com data.
   3. **Aviso (mês M).** Listar o que **vence no mês M+2**, por categoria e finalidade, e avisar a empresa no próprio dia 1º, com as contagens e o caminho da exportação. A execução será no dia 1º do mês M+2, então o aviso sai com pelo menos 59 dias de antecedência (a regra é: data da execução menos 30 dias, no mínimo).
   4. **Execução (mês M).** Tratar o que vence no mês M e foi avisado dois meses antes. Os prazos são máximos: executar no dia 1º antecipa em até 30 dias e nunca atrasa. Aplicar a medida **a cada categoria vencida**, mantendo só o que ainda serve a uma categoria no prazo:
      - **Campanha vencida ou saída pedida:** parar as campanhas na hora (a saída não espera o lote) e tirar o contato do uso para campanhas, sem tocar no contrato ainda no prazo.
      - **Contrato vencido com contato de campanha ainda no prazo** (ex.: cliente respondeu a uma campanha no 4º ano): eliminar o contrato em PDF, os arquivos e os dados que só constam do contrato (documento, endereço, dados da festa que identifiquem a pessoa, nome e nascimento da criança sem autorização de lembrete); ficam valores, datas e quantidades, e o nome, telefone e e-mail só para o contato de campanha ainda autorizado.
      - **Todos os prazos do cliente vencidos:** anonimizar o restante (somem nome, telefone, e-mail, documento, endereço, arquivos e contratos em PDF, mensagens, nome e nascimento da criança; ficam valores, datas, quantidades e o registro de quem saiu).
   5. **Exceção.** Valor em aberto ou disputa informada pela empresa preserva só o contrato, os pagamentos e os dados de identificação e contato que constam deles, até o fim da cobrança ou da disputa. O resto do cliente segue os seus prazos.
   6. **Primeira aplicação (transição).** No primeiro lote de cada empresa (dia **D**, um dia 1º), não cabe o aviso normal para o que já venceu (inclusive importado) nem para o que vence nos meses D e D+1. Esses itens recebem aviso no dia D, todos de uma vez, e cada um é executado **no dia 1º do mês do seu vencimento ou em D + 30 dias, o que for mais tarde**, conforme o DPA. Assim o aviso nunca tem menos de 30 dias e a antecipação nunca passa de 30 dias (a execução nunca é antes do dia 1º do mês do vencimento). Só os já vencidos e os que vencem antes de D + 30 dias são executados depois do vencimento, em D + 30 dias. Exemplos: D = 01/04: vencimento 15/04 → 01/05; 15/05 → 01/05; 15/06 → ciclo normal (01/06). D = 01/07: vencimento 31/08 → 01/08. D = 01/02/2027: vencimento 01/03 → 03/03 (D + 30). A partir de D, o ciclo normal do item 3 avisa o mês D+2 em diante, sem lacuna.
   7. **Registro do lote.** Em `Registro de copias e eliminacoes LGPD`, só contagens por categoria e medida, sem dados pessoais. À parte, **fora do banco restaurável**, guardar o arquivo do lote com os identificadores técnicos mínimos (ids de cliente, contrato, festa e arquivo; sem nome, telefone ou e-mail), a categoria, a medida e a data, com acesso só do encarregado. Apagar esse arquivo quando expirar a última cópia de segurança anterior ao lote (90 dias). Ele é a fonte para reaplicar o lote numa restauração ([BACKUPS-E-COPIAS.md](BACKUPS-E-COPIAS.md), seção 6).
   **A definir com autorização** (leitura e escrita em banco de produção).

## 3. Eventos de encerramento de empresa

Datas por empresa (anotar na linha da empresa, pelo id, em `Registro de copias e eliminacoes LGPD`):

| Marco | Quando | O que fazer |
|---|---|---|
| **D0 — início da somente leitura** | Fim do teste sem assinatura; fim do período já pago de assinatura cancelada; depois dos 7 dias para regularizar um pagamento; ou na hora do arrependimento ou do encerramento antecipado do anual | Anotar D0. A exportação continua disponível |
| **S — suspensão** | D0 + **60 dias** | Conferir que o acesso foi suspenso. A exportação continua disponível (por tela à Gestão ou a pedido, em até 15 dias) |
| **A — aviso de exclusão** | **pelo menos 30 dias antes** de E | Avisar o responsável cadastrado por e-mail do canal oficial: data da exclusão programada, como exportar, como pedir exclusão antes. Anotar o envio |
| **E — exclusão programada** | até S + **12 meses** | Eliminar ou anonimizar os dados operacionais da empresa, ressalvados os registros mínimos justificados (contratos e evidências de aceite até 10 anos, fiscais, registros de acesso e auditoria nos seus prazos). **A definir com autorização** (escrita em banco de produção). Registrar o que saiu e o que ficou, com o motivo |
| **E + 90 dias** | ciclo das cópias | As cópias de segurança que ainda tinham os dados expiram. Se houver restauração antes disso, **reaplicar a exclusão** |

Antecipações:
- **Pedido de exclusão da empresa antes de E:** tratar como E imediato, observados os direitos dos titulares e as obrigações aplicáveis. Fazer o aviso A só se fizer sentido (a própria empresa pediu).
- **Empresa volta a assinar antes de E:** cancelar A e E e registrar.

## 4. Outros eventos

| Evento | O que fazer | Referência |
|---|---|---|
| **Fim do teste** de uma empresa sem assinatura | Abrir a linha da empresa com D0 = fim do teste | Termos, "Teste grátis" e "Depois do teste" |
| **Fim de assinatura** (cancelada, atraso, arrependimento, encerramento antecipado) | Abrir a linha da empresa com D0 conforme a seção 3 | Termos, "Cancelamento e devolução" |
| **30 dias antes da exclusão** | Enviar o aviso A | Termos; DPA, "Término" |
| **Restauração de backup** | Antes de devolver o banco ao uso, **reaplicar todas as exclusões** feitas depois do instante restaurado | [BACKUPS-E-COPIAS.md](BACKUPS-E-COPIAS.md), seção 6 |
| **Cópia nova criada** (dump, exportação, P1) | Anotar a data-limite (criação + 90 dias) e apagar ao fechar a janela | [BACKUPS-E-COPIAS.md](BACKUPS-E-COPIAS.md) |
| **Exportação completa entregue** | Apagar a pasta de trabalho após a confirmação da empresa; nunca além de 90 dias | [ENSAIO-EXPORTACAO-E-DEVOLUCAO.md](ENSAIO-EXPORTACAO-E-DEVOLUCAO.md) |
| **Pedido de exclusão de titular atendido** | Registrar a medida e os ids técnicos no mesmo dia | [DIREITOS-DO-TITULAR.md](DIREITOS-DO-TITULAR.md) |
| **Conversa do WhatsApp excluída** | Identificadores técnicos saem em 30 dias pela rotina; "não contatar" fica | Aviso, "Conversas do WhatsApp" |

## 5. O que ainda depende de ferramenta

| Item | Hoje | Futuro |
|---|---|---|
| Controle de D0, S, A e E por empresa | Linha manual no registro do vault | Tabela de exclusões programadas com alerta |
| Aviso 30 dias antes | E-mail manual do canal oficial | Aviso automático |
| Exclusão da empresa em E | Manual, com autorização | Rotina com registro |
| Registros de acesso e auditoria | A conferir | Purga automática por prazo |
| Saúde | Lembrete à empresa | Campo estruturado e lembrete automático |
| Retenção do WhatsApp | Rotina sob demanda; agendamento a conferir | Agendamento diário + alarme |
