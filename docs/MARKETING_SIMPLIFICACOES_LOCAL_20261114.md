# Simplificações de Marketing — implementação local de 14/11/2026

Base: `2133d398f02f519170b443b5702c6b23b9da41b7` (`origin/staging`). Branch: `codex/marketing-simplificacoes-20261114`. Somente diff local, sem commit, push, PR, deploy, alteração remota ou migration nova. Conferência do Claude e revisão independente do Astra ainda pendentes.

1. A criação comercial vincula, na mesma transação, o contato do mesmo cliente e empresa com maior `recebido_em`, depois maior `id`, entre `NOVO`/`EM_ATENDIMENTO` sem negociação. A empresa vem da negociação persistida. O cliente é travado para serializar novas negociações; o vínculo reutiliza a ação manual, a herança de atribuição e o histórico. Uma negociação não recebe dois contatos. Descartados ficam intactos. Sem a tabela de Marketing, o fluxo comercial legado continua.
2. Pedidos e contatos tem ações para abrir o fluxo existente de negociação e conversar pelo WhatsApp. Cliente, data e convidados são preparados; os requisitos cadastrais e comerciais existentes continuam sendo validados. Contato manual sem cliente passa pela deduplicação existente ao abrir o fluxo. O cadastro tem quatro campos visíveis; as opções de origem ficam em Configurações.
3. Campanhas tem três campos iniciais, uma escolha conjunta de canal/origem, resultados acumulados e download local de QR code em SVG com `qrcode-generator`, já presente no lockfile. Início/fim organizam a campanha; pausa e período não interrompem atribuição. Só arquivar interrompe. O patch de texto de 30/10 foi aplicado e `campanhaVigente` removida.
4. Acompanhamento abre com tarefas e regras recolhidas. Chamar apenas monta `wa.me`, sem provedor. Histórico, caixas simuladas e processamento ficam em Detalhes técnicos. As autorizações continuam nesta página, recolhidas; mover para a ficha do cliente ampliaria o escopo. Motor, worker e transporte não foram alterados.
5. Resultados tem quatro indicadores e tabela de cinco colunas. Custo por contrato é explicitamente uma **estimativa**, dividindo orçamento total da campanha pelos contratos do período, e não gasto realizado. Detalhes e receitas recebidas ficam em Ver mais. Datas são agrupadas em até seis fins de semana com sábado/domingo livre no horizonte consultado. Site do buffet abre em um site existente da empresa, fixa a seleção inicial e recolhe canônico, sitemap e domínio em Avançado. Rascunho/publicação e guardião de saída continuam com o comportamento existente. Menu tem quatro itens; Campanhas fica acessível por Resultados. A URL antiga de permissões redireciona para Usuários e acessos; as demais URLs foram preservadas.

## Histórico e contagem

Não há reparo retroativo nem inferência de conversão só pelo cliente. Isso evita associar um contrato antigo a pedidos repetidos de campanhas diferentes. O histórico continua podendo ser vinculado manualmente. A conversão conta os pedidos do período vinculados a negociações com contrato assinado; contratos/receita têm seus próprios períodos, como antes.

## Evidências e reprodução

Pacote local: `D:/glass/KidMais Manager/ambientes-locais/marketing-simplificacoes-20261114`.

- `PROMPT_CLAUDE.md`: arquivos por item, SHA256 dos cinco patches sequenciais, comandos, resultados e limites.
- `relatorios/`: saídas completas e códigos de saída por comando, prova PostgreSQL e controle negativo em cópia isolada.
- `prints/`: capturas antes/depois, somente da demo no navegador interno, em 1280 e 375 px.
- O cluster descartável desta tarefa usa exclusivamente `E:/kidmais-pg-descartavel/marketing-simplificacoes-20261114`, porta 55714. Nunca 5432/5433.

Não houve mensagens reais, teste em staging/produção, nova integração, alteração de WhatsApp multiempresa, OTP, Financeiro ou promoção. Aviso de pedido novo continua fora do escopo. F-1 do editor não foi resolvida. Publicação, consentimento e integrações reais não são homologados pela prova local. Reverter significa remover os diffs locais dos cinco itens; não há alteração de esquema para desfazer.

## Correção da conferência — item 6 (14/11/2026)

O vínculo automático é auxiliar à venda. `SAVEPOINT marketing_conversao_automatica` é aberto antes de consultar ou alterar o Marketing, fora do `catch`. Uma falha recuperável dentro do vínculo executa `ROLLBACK TO SAVEPOINT` e `RELEASE SAVEPOINT`, registra no servidor apenas o ID da negociação e o código do erro e deixa a criação comercial continuar com adicionais, escolhas e fotografia do pacote. Contato, atribuição e histórico do vínculo voltam ao estado anterior. O botão de vínculo manual continua disponível.

Transação já abortada ou ausência de transação falham ao abrir o SAVEPOINT e são propagadas. Falhas na recuperação/liberação também são propagadas, assim como códigos das classes `08`, `25`, `2D`, `3B` e `40` (conexão, estado/controle transacional e serialização/deadlock). Erros posteriores, no restante da criação comercial, ficam fora desse tratamento e continuam causando rollback da venda. O log do vínculo não recebe mensagem, stack, SQL, parâmetros, nome, telefone ou e-mail do erro.

No sucesso, liberar o SAVEPOINT mantém as travas até o término da transação externa. No rollback parcial, PostgreSQL libera o `FOR NO KEY UPDATE` do cliente e o `FOR UPDATE` do contato adquiridos depois do SAVEPOINT; travas anteriores do chamador permanecem. Portanto, a criação que falhou no Marketing segue sem reservar o contato: outra negociação pode vinculá-lo. Duas conversões bem-sucedidas continuam serializadas pela trava do cliente e pela seleção/trava do contato ainda elegível; a falha desfeita não é uma conversão. Isso não garante conversão para a negociação que teve o erro, nem dispensa o vínculo manual posterior. Referência: [travas e rollback para savepoint no PostgreSQL 18](https://www.postgresql.org/docs/18/explicit-locking.html).

A suíte de conversão preserva os casos anteriores e acrescenta o caminho público real, usando prova de identidade sintética sem administrador, uma falha SQL após as alterações do vínculo, verificação do log sem dados pessoais, transação previamente abortada e propagação de erro de serialização. O contrato assinado continua sendo fixture sintética. Concorrência de duas criações comerciais não foi exercitada nesta correção.

O acabamento altera somente CSS e marcação: texto e ações de tarefas separados, ações de pedidos agrupadas, checkbox e rótulo alinhados e cabeçalhos de campanhas com posição uniforme dos botões. Contagem de novos na autenticação, receita 086, linhas zeradas de Resultados e abas do topo permanecem como observações para o Astra, fora desta correção.

Evidências e handoff da correção: `D:/glass/KidMais Manager/ambientes-locais/marketing-simplificacoes-20261114/correcao-conferencia-20261114`. O `item-6.patch`, no pacote principal, aplica depois dos cinco patches originais. Conferência do Claude e revisão independente do Astra pendentes; nenhuma publicação autorizada.

## Correção dos P3 2 e 3 — item 7 (14/11/2026, somente local)

O vínculo automático lê a origem persistida do fechamento: CLIENTE registra CONTATO_MARKETING_NEGOCIACAO com FECHAMENTO_PUBLICO e usuário nulo. Chamadas manuais mantêm CRM_INTERNO e seu autor administrativo. O contexto é parâmetro interno do serviço, não campo aceito no corpo da API. Seleção, atribuição e SAVEPOINT permanecem iguais.

Campanhas lê searchParams.data no servidor: aceita somente uma string AAAA-MM-DD que corresponda a uma data real e seja hoje ou futura em America/Sao_Paulo; ausente, repetida, malformada, inexistente ou passada é ignorada sem aviso. Após os dados carregarem e com permissão de edição, o formulário Nova campanha abre uma vez com esse início. Cancelar/recarregar os dados não reabre o formulário; uma nova data na navegação troca a chave da tela. Nenhuma campanha é salva automaticamente.

Validação: 132 testes sem banco PASS, zero SKIP; conversão PostgreSQL 9/9 com asserções de origem/autor públicos e manuais; TypeScript e diff-check passam. Captura da página real da demo localhost:3787 mostra Nova campanha aberta por ?data=2027-04-10 e início 10/04/2027 (Mais opções expandido apenas para conferência). O contador de sessão (P3 1) não foi alterado. Sem build completo, matriz integral de papéis/planos, assinatura em tela ou homologação remota nesta rodada.

Pacote sequencial item-7.patch e manifesto em ambientes-locais/marketing-simplificacoes-20261114; evidências em ambientes-locais/marketing-correcao-p3-20261114 e print em prints/item-7/campanha-por-data.jpg. Cluster descartável próprio 55787 e demo são encerrados na limpeza. Sem commit, PR, publicação, migration nova ou dependência nova. Handoff: correcao-p3-item7-20261114/PROMPT_CLAUDE.md no pacote.
## Item 8 — campanha para divulgar data livre (14/11/2026)

Ajuste local que supera apenas o preenchimento do item 7: o atalho com data válida abre uma vez com Início em hoje (São Paulo), Fim na data livre e Nome sugerido Data livre DD/MM/AAAA, editável. Nova campanha manual começa sempre em hoje, com fim e nome vazios, inclusive com data na URL. Validação silenciosa de parâmetro inválido/ausente e permissão preservadas. Testes cobrem sugestão, edição do nome, reset manual, fuso São Paulo, abertura única e validação. Sem alteração de backend, banco ou dependências.
