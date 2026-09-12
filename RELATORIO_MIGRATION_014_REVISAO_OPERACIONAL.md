# Migration 014 — revisão operacional pós-assinatura

Relatório de implementação e validação — 10/09/2026.

A estrutura autorizada foi aplicada ao PostgreSQL local e o fluxo de revisão operacional foi implementado. O ciclo completo foi validado para o pacote Completa: preparar, revisar, assinar pela Kidmais, obter aceite do cliente e aplicar a operação sem alterar a obrigação financeira original.

**Limitação que permanece:** Essencial e Premium podem ser preparados e precificados, mas não possuem modelo oficial de contrato registrado no projeto. A geração/assinatura desses pacotes continua bloqueada. Não considero o ciclo documental desses dois pacotes homologado. A tela informa essa limitação; nenhum texto contratual de outro pacote foi adaptado sem aprovação.

## 1. Causa original e checkpoint

Faltava uma fonte operacional tipada para preparar alterações de uma contratação assinada sem antecipar a mudança do Fechamento vigente. A nova estrutura separa proposta operacional, documento e obrigação financeira, mantendo a distinção entre contratação assinada e reserva confirmada.

Checkpoint anterior às alterações: [manifesto dos 320 arquivos](<D:/glass/KidMais Manager/kidmais-manager/.backups/pre-014-1789002903295/manifesto.json>). A mesma pasta contém fontes, [dump PostgreSQL](<D:/glass/KidMais Manager/kidmais-manager/.backups/pre-014-1789002903295/banco.dump>), catálogo, contagens e hashes das 38 tabelas. As correções válidas anteriores foram usadas como base e preservadas.

## 2. Migration 014

Arquivo aplicado: [20260909_014_revisao_operacional.sql](<D:/glass/KidMais Manager/kidmais-manager/database/migrations/20260909_014_revisao_operacional.sql>).

SHA-256 aplicado e conferido ao final:

`92996b2ef2a696ec17ecb75e1b54fec2745303b2e24ad1f2d5b3a047c9f738d0`.

A Migration 014 não foi modificada depois de aplicada. Não houve Migration 015, alteração das migrations 012/013, alteração de schema_mvp_kidmais.sql, backfill ou início de Festa.

## 3. Precheck, postcheck e rollback

- [Precheck](<D:/glass/KidMais Manager/kidmais-manager/database/checks/20260909_014_precheck.sql>): pré-requisitos físicos, ausência dos objetos 014 e compatibilidade das referências.
- [Postcheck](<D:/glass/KidMais Manager/kidmais-manager/database/checks/20260909_014_postcheck.sql>): colunas, índices, constraints, funções e triggers esperados.
- [Rollback](<D:/glass/KidMais Manager/kidmais-manager/database/rollback/20260909_014_revisao_operacional_down.sql>): reversão exclusiva de 014 enquanto não houver uso.

O DOWN vazio restaurou no clone o catálogo completo anterior, incluindo índices e funções. Após revisão, itens, aprovação vinculada, evidência/auditoria ou snapshot operacional, o DOWN recusa. Cancelar a revisão não apaga seu histórico nem torna o DOWN novamente permitido.

Não execute rollback como teste manual no banco de trabalho. Após uso, restauração de backup exige decisão específica; voltar apenas o código antigo pode fazer a aplicação ignorar proteções existentes.

## 4. Teste isolado UP/DOWN

Foram executadas **38 verificações estruturais antes da aplicação local**: restauração idêntica do dump, UP, postcheck, catálogo, DOWN vazio, novo UP, dados sintéticos, hashes, FKs, estados inválidos, aprovação exata, BYTEA/provas, congelamento, imutabilidade, aplicação, cancelamento e recusa de DOWN após uso.

[Evidência estrutural](<D:/glass/KidMais Manager/kidmais-manager/.backups/pre-014-1789002903295/014-teste-isolado.json>). Nenhum fixture desses testes foi inserido no banco local.

## 5. Estrutura física antes/depois

| Objeto | Antes | Depois |
|---|---|---|
| Tabelas públicas | 38 | 40 |
| fechamento_revisoes | Inexistente | 68 colunas: 29 de contexto/controle e 39 operacionais |
| fechamento_revisao_adicionais | Inexistente | 12 colunas, incluindo valores aplicados e vínculo com a revisão |
| aprovacoes_negociacao | 10 colunas | 14 colunas |
| contratos | 9 colunas | 9 colunas; UNIQUE adicional para referência composta |
| Constraints no catálogo consultado | 654 | 770 |
| Triggers de usuário | 39 | 57 |
| Funções novas de 014 | 0 | 10 |

Os quatro campos novos de aprovacoes_negociacao são fechamento_revisao_id, fechamento_revisao_numero, fechamento_revisao_hash e chave_decisao. São opcionais no histórico anterior e permanecem NULL nos registros existentes. A constraint exige o conjunto coerente quando houver nova decisão vinculada à revisão.

As FKs preservam referências a contrato, versão-base, V2, edição, documentos, usuários administrativos, CRM e catálogo comercial. Índice parcial impede duas preparações abertas da mesma contratação. Hashes cobrem operação e itens. Triggers mantêm base protegida, congelamento, estados terminais e coerência de agenda. Foram conferidos os 95 objetos explicitamente nomeados pelo SQL; a contagem geral de constraints acima também inclui objetos gerados pelo PostgreSQL.

## 6. Aplicação local e comparação integral

[Evidência da aplicação](<D:/glass/KidMais Manager/kidmais-manager/.backups/pre-014-1789002903295/014-aplicacao-local.json>). A comparação abrangeu todas as colunas anteriores e todas as linhas das 38 tabelas, com ordenação estável e SHA-256. A inspeção final comparou também colunas/defaults, constraints, triggers, índices e funções, usando o mesmo search_path da aplicação.

Resultado: **zero divergências**. As duas tabelas novas continuam vazias; nenhuma revisão, hold, assinatura ou aprovação operacional foi criada no banco local durante os testes. Os quatro campos adicionais das aprovações antigas continuam NULL.

Contagens preservadas: 9 Fechamentos, 3 Contratos, 4 versões, 2 documentos BYTEA, 0 assinaturas da estrutura administrativa, 2 Pagamentos, 3 recebimentos, 5 parcelas e 0 pendências financeiras. Os dois casos financeiros anteriores permanecem íntegros. Os testes funcionais ocorreram em clones.

[Conferência final](<D:/glass/KidMais Manager/kidmais-manager/.tmp/verificacao-final-014.json>).

## 7. Arquivos alterados

Inventário comparado ao checkpoint: **33 arquivos de implementação/SQL/testes, mais este relatório**. Todos devem permanecer para conservar o fluxo validado e suas verificações reproduzíveis. Nenhum arquivo foi revertido neste bloco. A tabela completa está no final deste relatório.

Impactos fora de Contrato: Fechamento ganhou preparação tipada; Disponibilidade considera holds e seus locks; Pagamentos trata a revisão durante a confirmação da reserva; os serviços proprietários de CRM são usados para cadastro/vínculos. A rota administrativa de Clientes foi alterada apenas na tipagem de params. Nenhuma regra de autenticação foi relaxada. Pricing não teve suas regras alteradas.

## 8. Revisão operacional e fontes de verdade

CRM continua sendo cadastro. Fechamento/revisão guarda operação preparada. Disponibilidade decide agenda. Pricing calcula pacote, convidados e adicionais. A decisão comercial tem autor e conteúdo exatos. Contrato congela snapshot/PDF/provas. Pagamentos conserva a obrigação financeira.

contrato_edicoes.dados_fonte não substitui colunas operacionais. Criar V2 copia uma base explícita e verificável. Editar V2 altera essa preparação, exceto correções cadastrais explícitas, gravadas imediatamente pelo CRM com auditoria.

## 9. Remarcação

| Situação | Preparação | Cancelamento | Aplicação após aceite |
|---|---|---|---|
| V1 CONFIRMADA | Base ocupada; destino validado pode receber hold | Libera destino, mantém base | Transfere ocupação ao destino; Fechamento continua CONFIRMADO |
| V1 assinada sem reserva confirmada | Base e destino não ganham reserva por existir V2 | Não cria ocupação artificial | Atualiza operação, mantendo ausência de confirmação financeira |

Nos testes de 12/09 e 19/09, ambas ficaram protegidas durante a revisão de V1 confirmada. Outra contratação foi recusada. Cancelar liberou apenas 19; aplicar tornou 19 vigente e liberou 12. Os fixtures utilizaram anos futuros em banco isolado.

## 10. Holds e pagamento durante V2

hold_destino_adquirido_em só é registrado após aquisição válida. Não é inferido da existência de proposta ou assinatura. O painel diferencia reserva confirmada, hold e data proposta sem reserva. Base confirmada com destino sem hold mostra necessidade de revalidação.

Primeiro pagamento durante EM_ELABORACAO ou CONGELADA confirma legitimamente V1 quando a base está livre. Na mesma transação, tenta proteger o destino. Se um terceiro já o ocupa, o recebimento e a confirmação válida da V1 permanecem; o terceiro conserva sua data; V2 fica sem hold e não avança sem revalidação. O PDF congelado não muda. Repetir uma assinatura já registrada retorna a prova existente, sem criar outro ato.

Em V2 concluída sem pagamento, o primeiro pagamento posterior usa a data operacional vigente atual e só confirma após lock/revalidação.

## 11. Concorrência e rollback funcional

Conexões PostgreSQL e sessões administrativas distintas; espera física conferida por pg_blocking_pids. Cobertura:

- Duas revisões disputando o mesmo destino: só uma adquire.
- Bloqueio administrativo antes/depois da revisão: o perdedor observa o resultado confirmado.
- Aceite antes/depois do cancelamento: só um termina; sem prova parcial do perdedor.
- Edição antes/depois da assinatura: revisão obsoleta ou congelamento impede a segunda mutação.
- Mudança de destino não revela liberação parcial; rollback mantém o hold anterior.
- Rollback do primeiro concorrente permite recuperação válida do segundo.
- Desativação por ID e por intervalo exato participa do mesmo protocolo.

Erros não deixam o Fechamento antecipadamente alterado. A disponibilidade pública continua retornando horários/status sem identificação pessoal.

## 12. Edição pós-assinatura e casos comuns

Editar festa prepara data, período, horário oficial, pacote, convidados, adicionais, buffet, tema/idade, condição comercial e vínculos. Não exige solicitação do cliente para iniciar.

Validados: 50→60, inclusive ciclo completo uma semana antes da festa; 110/130/140 e manual 67; recálculo por Pricing; Essencial→Completa→Premium na preparação; inclusão/remoção de adicionais; prevenção de cobrança duplicada de itens/combos incluídos; buffet pendente na troca de pacote e novas escolhas posteriores.

**Os ciclos completos de assinatura/aplicação utilizaram Completa.** Preparar um upgrade para Premium não equivale a ter contrato Premium homologado: faltam seus modelos oficiais.

## 13. Troca de vínculos e CRM

A seleção valida cliente canônico e pertencimento de aniversariante/responsável ativo. Vínculos do Fechamento só mudam na aplicação. Foi concluído aceite com OTP do novo contratante, aplicando também aniversariante e responsável adicional propostos.

Correções de contato/nome usam serviços auditados do CRM. Snapshot/PDF anterior continua imutável. Alterar contato após congelamento não invalida o documento. Identidade canônica/CPF divergente exige nova proposta.

## 14. Comercial: proposta, aprovação e recusa

A operação preparada é o conteúdo proposto. A decisão fica em aprovacoes_negociacao, ligada a ID, número e hash exatos da revisão, autor real e chave idempotente. Aprovar não significa receber dinheiro. Alterar conteúdo invalida aprovação vigente e revisão documental; decisões anteriores permanecem.

Recusar condição comercial registra decisão negativa, mantém preparação editável e conserva reserva/hold existente. Não cancela a revisão automaticamente.

| Forma | Base | Desconto | Valor contratual |
|---|---:|---:|---:|
| PIX à vista | R$ 9.290,00 | 10% | R$ 8.361,00 |
| PIX parcelado | R$ 9.290,00 | 3% | R$ 9.011,30 |
| Cartão | R$ 9.290,00 | 0% | R$ 9.290,00 |

Subcentavos são rejeitados. Condição PIX preparada não cria parcelas financeiras.

## 15. Contrato e provas

Assinatura Kidmais exige sessão real válida/reautenticada, REPRESENTANTE_AUTORIZADO e revisão do PDF exato. Congela conteúdo, itens, snapshot e documento. O hold pode ser adquirido posteriormente, quando a base for legitimamente confirmada, sem mudar conteúdo assinado.

Aceite com OTP aplica preparação, substitui adicionais operacionais, promove a versão, atualiza agenda, cria pendência quando necessária e audita na mesma transação. V1 e documentos/provas permanecem. V3 após V2 aplicada foi validada.

A prova permanente continua independente da retenção da sessão. As regras de BYTEA, imutabilidade e exclusão futura de sessões da 013 foram preservadas.

## 16. Pagamentos

Não se alteram automaticamente valor_total_contratado, plano, parcelas, recebimentos, saldo, estornos ou comprovantes. Não é criado segundo Pagamento. O existente permanece ligado à versão original.

A pendência considera valor final, forma/condição efetiva e devedor, evitando divergência causada apenas por metadados de revisão. Diferença material usa contrato_pendencias_financeiras de forma idempotente; resolução ficou fora deste bloco.

Fechamento, preparação, aprovação e assinatura não criam Pagamento/recebimento automaticamente. O plano continua exigindo soma exata igual à obrigação assinada usada na criação; Pagamentos não recalcula desconto.

## 17. Cancelamento e idempotência

EM_ELABORACAO e CONGELADA podem ser canceladas antes do aceite, com sessão real e motivo. Preservam-se V1, documentos, assinatura Kidmais e Pagamentos; libera-se apenas a proteção provisória.

Mesma criação/autor/base/pedido retorna a revisão existente, comparando o pedido da auditoria imutável. Repetir após cancelamento não reabre a revisão. Chaves, decisão/autor ou intenção incompatíveis são recusados. UUIDs são normalizados nas comparações.

Propostas documentais anteriores à 014 não receberam backfill. O painel permite cancelamento explícito da proposta anterior e criação de outra preparação; não converte o passado silenciosamente.

## 18. Testes executados

| Bateria | Resultado |
|---|---|
| Estrutura 014: UP/DOWN/UP/integridade | 38 verificações aprovadas antes da aplicação |
| Contrato/autenticação real | 30 cenários aprovados |
| Acabamento/Fechamento administrativo | 29 cenários aprovados |
| Novo fluxo operacional, HTTP e concorrência | 38 cenários aprovados |
| Unitários Comercial/Disponibilidade/Contrato/Pagamentos | 22 + 5 + 12 + 30 testes aprovados |
| Pagamentos engenharia | 24 cenários; rollback/fingerprint aprovados |
| Pagamentos HTTP | 35 requisições; handlers Next + PostgreSQL reais |
| Pagamentos concorrência | 5 cenários com espera física e preservação |
| Pricing, Comercial/PIX, Identidade repository/service/Fechamento | Aprovados |
| Navegador de regressão | Login, edição, impressão, assinatura, CRM, logout, público e mobile aprovados |
| Navegador 014 | V2, convidados, remarcação, buffet/PIX, assinatura, cancelamento e mobile aprovados |
| HTTP consultar CPF | Resposta mascarada, sem dados pessoais completos |
| TypeScript, lint direcionado, build | Aprovados |
| PostgreSQL local final | 40 tabelas; zero divergências nas 38 projeções anteriores |

Evidências: [regressões](<D:/glass/KidMais Manager/kidmais-manager/.tmp/regressoes-014.json>), [Contrato/auth](<D:/glass/KidMais Manager/kidmais-manager/.tmp/admin-contrato-resultados.json>), [acabamento](<D:/glass/KidMais Manager/kidmais-manager/.tmp/acabamento-resultados.json>), [novo fluxo](<D:/glass/KidMais Manager/kidmais-manager/.tmp/revisao-operacional-resultados.json>), [navegador anterior](<D:/glass/KidMais Manager/kidmais-manager/.tmp/navegador-acabamento.json>), [navegador 014](<D:/glass/KidMais Manager/kidmais-manager/.tmp/navegador-revisao.json>), [privacidade HTTP](<D:/glass/KidMais Manager/kidmais-manager/.tmp/identidade-http-014.log>), [qualidade/build](<D:/glass/KidMais Manager/kidmais-manager/.tmp/qualidade-014.json>).

## 19. Regressões e correções encontradas

A validação corrigiu comparações de UUIDs, repetição de criação/cancelamento/decisão, pendência por metadados sem efeito financeiro, exibição de hashes internos na tabela de alterações, acessibilidade dos selects e os tipos de params exigidos pelo Next atual.

O build inicialmente não baixou Geist por restrição de rede. Após autorização, expôs tipos antigos das rotas; corrigidos, passou. Persistem apenas avisos de testes sobre módulo TypeScript e múltiplos lockfiles na cópia isolada. Não foi alterado package.json para esconder avisos.

## 20. Limitações e pontos de parada

- Essencial/Premium: preparação e cálculo disponíveis, assinatura bloqueada até aprovação/cadastro dos modelos oficiais. Aditivo específico também permanece indisponível.
- Pendência financeira: registrada para análise posterior, sem cobrança de diferença, abatimento, renegociação ou transferência automática de dívida.
- Revisão congelada com destino ocupado: revalidar o mesmo destino quando disponível ou cancelar/refazer; não editar o documento congelado.
- Troca de vínculos usa cadastros canônicos existentes. Novos cadastros são criados pelo CRM antes da seleção.
- OTP local usa console; isso não representa envio real de SMS/WhatsApp/e-mail.
- Não há tela de lançamento de recebimentos neste painel. Os cenários financeiros foram validados por serviços/handlers/PostgreSQL em clones.
- Checkpoints/clones/evidências foram mantidos. O servidor do operador não foi substituído pelo servidor de teste nem pelo build isolado.

## 21. Passo a passo exato no navegador

### Abrir o projeto e o sistema

1. No VS Code, abra a pasta `D:\glass\KidMais Manager\kidmais-manager`.
2. No menu superior, clique **Terminal → Novo Terminal**. Se necessário, escolha **PowerShell** na seta ao lado do botão **+** do terminal.
3. Clique dentro do terminal, não no editor de `.env.local`. Cole o comando abaixo e pressione **Enter**:

```powershell
Set-Location -LiteralPath 'D:\glass\KidMais Manager\kidmais-manager'
```

4. Se já existe um terminal executando o app na porta 3000, use essa instância. Caso contrário, execute neste terminal:

```powershell
npm.cmd run dev -- --port 3000
```

5. Espere aparecer **Ready/pronto** e mantenha o terminal aberto. Se aparecer `EADDRINUSE`/porta em uso, não inicie outra instância nessa porta: tente o endereço do próximo passo, pois já há um processo atendendo.
6. Abra Edge ou Chrome, pressione **Ctrl+L**, cole [http://localhost:3000/admin/login](http://localhost:3000/admin/login) e pressione **Enter**.
7. Informe o e-mail e a senha do seu usuário real já criado e clique **Entrar**. Não rode bootstrap novamente. DATABASE_URL e o segredo administrativo já estão configurados no estado inspecionado; não é necessário editar `.env.local` para esta alteração.
8. Abra [http://localhost:3000/admin/contratos](http://localhost:3000/admin/contratos).

### Escolher a contratação e iniciar uma revisão

9. No campo **Contrato**, escolha uma contratação de teste adequada. Concluir o aceite em uma contratação real altera seus dados operacionais: a preservação informada neste relatório corresponde ao estado anterior aos seus testes manuais.
10. Em **Histórico de versões**, selecione a versão vigente assinada. O painel mostra **Vigente** e **Contrato ASSINADO**. Para contrato inicial ainda em elaboração, primeiro complete sua revisão, assinatura Kidmais e aceite do cliente; somente então inicie uma revisão pós-assinatura.
11. Se houver proposta documental antiga sem preparação operacional, use **Cancelar proposta anterior**, registre o motivo e selecione novamente a versão vigente. Essa ação conserva os documentos anteriores.
12. Vá até **Nova alteração contratual**. Escolha **Nova versão**, escreva um motivo claro e clique **Iniciar elaboração**.
13. Confira que a nova versão aparece **EM_ELABORACAO** e que **Vigente** ainda aponta para a anterior. Clique **Editar festa** no topo do painel.

### Alterar convidados, pacote, buffet e data

14. Abra **Pacote e convidados**. Substitua 50 por 60 em **Convidados pagantes**. Os botões **110**, **130** e **140** também estão disponíveis; para outra quantidade, digite no campo.
15. Ao trocar pacote, o buffet volta a **Pendente**. Para testar o ciclo completo até a assinatura nesta entrega, escolha **Completa**. Premium permite preparação/cálculo e exibe o bloqueio por modelo oficial ausente.
16. Em **Adicionais**, marque/desmarque itens permitidos e ajuste quantidades. Itens já incluídos no pacote ficam identificados para evitar duplicidade.
17. Em **Escolhas do buffet**, escolha a situação e preencha preferências. Após trocar pacote, salve primeiro com **Pendente**; reabra o editor para concluir as novas escolhas.
18. Para remarcar, abra **Dados da festa**, altere **Data da festa**, aguarde a consulta e escolha **Período** e **Horário** disponíveis. O backend confere novamente ao salvar.
19. Preencha **Motivo da alteração administrativa** e clique **Salvar alteração da festa**. Se houver conflito, leia o aviso e reabra a edição para atualizar os dados.
20. Confira **Agenda da revisão**: se a base estava confirmada, ela continua protegida e o destino mostra **HOLD DE REMARCAÇÃO** após aquisição válida. Sem pagamento confirmatório, aparece **DATA PROPOSTA — AINDA NÃO RESERVADA**.

### Validar PIX parcelado e os três valores

21. Clique **Editar festa** e abra **Condições comerciais**.
22. Marque **Revisar e aprovar condição comercial nesta edição**. Em **Forma de pagamento**, escolha **PIX parcelado — 3%**.
23. Em **Base negociada (opcional)**, informe **9290**. Em **Quantidade de parcelas acordada**, informe **3**. Deixe entrada/valor de parcela vazios quando esses valores não tiverem sido acordados.
24. Informe o motivo, clique **Salvar alteração da festa** e confirme a aprovação comercial na caixa exibida pelo navegador.
25. O painel deve mostrar base **R$ 9.290,00** e valor contratual **R$ 9.011,30**. Isso é condição comercial, não recebimento nem plano financeiro criado.
26. Para conferir as outras opções antes da assinatura, repita com a mesma base: **PIX à vista → R$ 8.361,00**; **Cartão → R$ 9.290,00**. Cada condição salva substitui a proposta atual e exige nova revisão documental.
27. Para recusar comercialmente, clique **Recusar condição comercial** e registre o motivo. A proposta permanece aberta e conserva a proteção de agenda existente.

### Trocar vínculos ou corrigir cadastro

28. Em **Editar festa**, abra **Trocar vínculos da contratação**. Selecione **Contratante proposto**, depois **Aniversariante proposto** e, quando aplicável, **Responsável adicional proposto**. As opções são filtradas pelo contratante.
29. Salve com motivo. A troca fica preparada; o Fechamento vigente só muda após o aceite. Ao trocar a seleção, salve antes de reabrir os campos de correção cadastral do novo vínculo.
30. Para corrigir contato/nome do cadastro atual, use **Dados do contratante/Dados da festa**. Essas correções são gravadas imediatamente no CRM com auditoria; não reescrevem PDFs assinados.

### Conferir documento, assinar e aplicar

31. Fora do editor, confira **Alterações desta revisão**. Use **Observações exclusivamente documentais** apenas para texto documental e clique **Salvar revisão** se alterar esse campo.
32. Clique **Gerar PDF da revisão N**. Em **Documentos**, clique **Abrir/imprimir CONTRATO** da revisão correspondente. Leia o PDF.
33. Volte ao painel. Clique **Confirmar revisão deste PDF** e confirme que conferiu o documento exato.
34. Em **Assinatura Kidmais**, digite sua senha no campo **Confirme sua senha**. Clique **APROVAR E ASSINAR PELA KIDMAIS** e confirme. Seu usuário deve ser **REPRESENTANTE_AUTORIZADO**.
35. Confira que o editor deixou de estar disponível. A versão está congelada, e os comprovantes permanecem acessíveis. Clique **LIBERAR PARA O CLIENTE**.
36. Clique **Abrir acesso público do cliente**. Preencha **CPF do contratante** com o CPF da nova versão e clique **Continuar**. Escolha um canal disponível e clique **Enviar código**.
37. No ambiente local atual, o OTP aparece no terminal em que o app está rodando, pois o provedor é **console**. Digite os seis dígitos dessa solicitação em **Código de validação** e clique **Abrir documentos**. Não espere envio real ao celular nesse ambiente.
38. Selecione **Contrato Oficial**, abra e confira o PDF. Marque **Li o Contrato Oficial desta contratação e aceito os termos da exata versão exibida.** Clique **Aceitar e assinar eletronicamente** e espere **Aceite registrado com sucesso**. Identidade ou data inválida impedem aplicação parcial.
39. Atualize o painel administrativo. A nova versão deve constar vigente/concluída, e o Fechamento deve refletir convidados, vínculos, itens e data aplicados. PDFs/provas anteriores continuam no histórico.
40. Se existia reserva confirmada e houve remarcação, confira na [Disponibilidade](http://localhost:3000/disponibilidade) a liberação da base e ocupação do destino. Sem confirmação financeira, o destino continua sem reserva confirmada.
41. Em **Financeiro**, confira que a obrigação continua na versão original. Havendo diferença material, aparece pendência; nenhuma parcela/recebimento é criado automaticamente.

### Testar cancelamento separadamente

42. A partir da versão vigente, inicie outra **Nova versão**, altere uma data e salve. Antes do aceite final do cliente, clique **Cancelar revisão / V2** e informe o motivo.
43. Pode cancelar em elaboração ou depois da assinatura Kidmais. A proposta fica **CANCELADA**; o destino provisório é liberado e a reserva-base existente permanece. Documento e assinatura já produzidos continuam acessíveis.
44. Revisão aplicada não pode ser cancelada por esse botão. Para outra alteração, inicie a próxima versão a partir da vigente.

Os cenários de primeiro recebimento durante/depois de V2 foram automatizados em clones porque não há formulário de lançamento de recebimentos neste painel. Não use UPDATE manual para simular reserva ou pagamento.

**Ponto de parada:** nenhum outro módulo foi iniciado. Aguardar avaliação do usuário desta entrega e decisão sobre modelos contratuais ausentes.

## Inventário completo de arquivos

| Arquivo | Decisão | Motivo e cobertura |
|---|---|---|
| [app/api/admin/clientes/[id]/route.ts](<D:/glass/KidMais Manager/kidmais-manager/app/api/admin/clientes/[id]/route.ts>) | Alterado — manter | Tipagem params Promise exigida pelo Next; build, TypeScript e CRM. |
| [app/api/admin/contratos/versoes/[versaoId]/edicao/route.ts](<D:/glass/KidMais Manager/kidmais-manager/app/api/admin/contratos/versoes/[versaoId]/edicao/route.ts>) | Alterado — manter | Fontes preparadas, vínculos canônicos e agenda própria; HTTP 014 e navegador. |
| [app/api/contratos/route-utils.ts](<D:/glass/KidMais Manager/kidmais-manager/app/api/contratos/route-utils.ts>) | Alterado — manter | Tipagem compartilhada Promise nas rotas públicas; build, OTP e HTTP. |
| [components/admin/ContratoAdmin.tsx](<D:/glass/KidMais Manager/kidmais-manager/components/admin/ContratoAdmin.tsx>) | Alterado — manter | Fluxo V2, agenda/hold, revalidação, recusa, cancelamento e aviso de modelo; navegador. |
| [components/admin/EdicaoFesta.tsx](<D:/glass/KidMais Manager/kidmais-manager/components/admin/EdicaoFesta.tsx>) | Alterado — manter | Vínculos preparados e controles acessíveis no editor integrado; desktop/mobile e HTTP. |
| [database/checks/20260909_014_postcheck.sql](<D:/glass/KidMais Manager/kidmais-manager/database/checks/20260909_014_postcheck.sql>) | Novo — manter | Verificação da estrutura aplicada; UP isolado, aplicação e inspeção final. |
| [database/checks/20260909_014_precheck.sql](<D:/glass/KidMais Manager/kidmais-manager/database/checks/20260909_014_precheck.sql>) | Novo — manter | Pré-requisitos físicos; UP isolado e aplicação local. |
| [database/migrations/20260909_014_revisao_operacional.sql](<D:/glass/KidMais Manager/kidmais-manager/database/migrations/20260909_014_revisao_operacional.sql>) | Novo — manter | Estrutura autorizada de preparação e agenda; 38 verificações estruturais. |
| [database/rollback/20260909_014_revisao_operacional_down.sql](<D:/glass/KidMais Manager/kidmais-manager/database/rollback/20260909_014_revisao_operacional_down.sql>) | Novo — manter | DOWN exclusivo sem uso e recusa após uso; catálogo anterior restaurado no clone. |
| [lib/contratos/repositories/contrato.repository.ts](<D:/glass/KidMais Manager/kidmais-manager/lib/contratos/repositories/contrato.repository.ts>) | Alterado — manter | Referências comerciais da revisão tipada; snapshots 014 e regressão Contrato. |
| [lib/contratos/services/administrativo.service.ts](<D:/glass/KidMais Manager/kidmais-manager/lib/contratos/services/administrativo.service.ts>) | Alterado — manter | Criação, edição, decisão, assinatura, cancelamento e idempotência; Contrato/auth, 014, HTTP e navegador. |
| [lib/contratos/services/alteracoes.ts](<D:/glass/KidMais Manager/kidmais-manager/lib/contratos/services/alteracoes.ts>) | Alterado — manter | Oculta metadados internos na tabela do operador, mantendo snapshot/auditoria; navegador e diferenças. |
| [lib/contratos/services/contrato-publico.service.ts](<D:/glass/KidMais Manager/kidmais-manager/lib/contratos/services/contrato-publico.service.ts>) | Alterado — manter | Confere identidade canônica/CPF do snapshot operacional; OTP, vínculos e identidade. |
| [lib/contratos/services/contrato.service.ts](<D:/glass/KidMais Manager/kidmais-manager/lib/contratos/services/contrato.service.ts>) | Alterado — manter | Snapshot usa fontes da preparação; consultas sequenciais na mesma conexão; Contrato, Pricing e PIX. |
| [lib/contratos/services/fluxo-publico.ts](<D:/glass/KidMais Manager/kidmais-manager/lib/contratos/services/fluxo-publico.ts>) | Alterado — manter | Aplicação/promoção e comparação da obrigação efetiva; aceite, rollback e pendências idempotentes. |
| [lib/disponibilidade/repositories/disponibilidade.repository.ts](<D:/glass/KidMais Manager/kidmais-manager/lib/disponibilidade/repositories/disponibilidade.repository.ts>) | Alterado — manter | Ocupações incluem holds; bloqueios e desativações usam locks comuns; concorrência e Pagamentos. |
| [lib/disponibilidade/services/availability.service.ts](<D:/glass/KidMais Manager/kidmais-manager/lib/disponibilidade/services/availability.service.ts>) | Alterado — manter | Exclusão interna da própria contratação sem exposição pública; agenda e remarcação. |
| [lib/fechamentos/repositories/revisao.repository.ts](<D:/glass/KidMais Manager/kidmais-manager/lib/fechamentos/repositories/revisao.repository.ts>) | Novo — manter | Persistência dos 39 campos/itens, hashes e aplicação; integridade física e testes 014. |
| [lib/fechamentos/services/edicao-administrativa-schema.ts](<D:/glass/KidMais Manager/kidmais-manager/lib/fechamentos/services/edicao-administrativa-schema.ts>) | Alterado — manter | Vínculos estritos e UUIDs normalizados; HTTP e entradas inválidas. |
| [lib/fechamentos/services/edicao-administrativa.service.ts](<D:/glass/KidMais Manager/kidmais-manager/lib/fechamentos/services/edicao-administrativa.service.ts>) | Alterado — manter | Preserva guard pré-assinatura e encaminha pós-assinatura à preparação; acabamento e 014. |
| [lib/fechamentos/services/revisao-operacional.service.ts](<D:/glass/KidMais Manager/kidmais-manager/lib/fechamentos/services/revisao-operacional.service.ts>) | Novo — manter | Regras de preparação, Pricing/CRM/comercial, hold, congelamento, aplicação e cancelamento; 38 cenários 014. |
| [lib/pagamentos/services/pagamento.service.ts](<D:/glass/KidMais Manager/kidmais-manager/lib/pagamentos/services/pagamento.service.ts>) | Alterado — manter | Revisão no contexto bloqueado e destino após confirmação legítima; quatro cenários de pagamento durante V2 e regressões financeiras. |
| [scripts/acabamento.integration.cjs](<D:/glass/KidMais Manager/kidmais-manager/scripts/acabamento.integration.cjs>) | Alterado — manter | Corrige a descrição da asserção de fonte de outra contratação; 29 cenários preservados. |
| [scripts/identidade-api-consultar-cpf.integration.ts](<D:/glass/KidMais Manager/kidmais-manager/scripts/identidade-api-consultar-cpf.integration.ts>) | Alterado — manter | URL de teste configurável para usar servidor isolado; teste HTTP de privacidade. |
| [scripts/migration-014.apply.cjs](<D:/glass/KidMais Manager/kidmais-manager/scripts/migration-014.apply.cjs>) | Novo — manter | Aplica apenas SQL com hash/evidência aprovados; comparação integral na aplicação. |
| [scripts/migration-014.integrity.cjs](<D:/glass/KidMais Manager/kidmais-manager/scripts/migration-014.integrity.cjs>) | Novo — manter | 15 verificações complementares de FKs/triggers/provas/congelamento/aplicação/cancelamento. |
| [scripts/migration-014.validation.cjs](<D:/glass/KidMais Manager/kidmais-manager/scripts/migration-014.validation.cjs>) | Novo — manter | 23 verificações iniciais de restauração, UP/DOWN/UP, catálogo e recusa após uso. |
| [scripts/qualidade-014.cjs](<D:/glass/KidMais Manager/kidmais-manager/scripts/qualidade-014.cjs>) | Novo — manter | Lint, TypeScript e build em cópia isolada; logs reproduzíveis. |
| [scripts/revisao-operacional.concorrencia.cjs](<D:/glass/KidMais Manager/kidmais-manager/scripts/revisao-operacional.concorrencia.cjs>) | Novo — manter | 11 cenários de concorrência/visibilidade com conexões e barreiras PostgreSQL reais. |
| [scripts/revisao-operacional.integration.cjs](<D:/glass/KidMais Manager/kidmais-manager/scripts/revisao-operacional.integration.cjs>) | Novo — manter | Clone com ciclo operacional/financeiro, vínculos, HTTP, idempotência e concorrência; 38 cenários. |
| [scripts/revisao-operacional.navegador.cjs](<D:/glass/KidMais Manager/kidmais-manager/scripts/revisao-operacional.navegador.cjs>) | Novo — manter | V2 por cliques desktop/mobile, assinatura, cancelamento e privacidade HTTP, sem bypass. |
| [scripts/validacao-funcional-014.cjs](<D:/glass/KidMais Manager/kidmais-manager/scripts/validacao-funcional-014.cjs>) | Novo — manter | Agrupa 13 baterias de regressão em clone e mantém seus logs. |
| [scripts/verificacao-final-014.cjs](<D:/glass/KidMais Manager/kidmais-manager/scripts/verificacao-final-014.cjs>) | Novo — manter | Inspeção somente leitura, catálogo/dados/hashes e inventário; 38 projeções e 25 arquivos protegidos. |
| [Este relatório](<D:/glass/KidMais Manager/kidmais-manager/RELATORIO_MIGRATION_014_REVISAO_OPERACIONAL.md>) | Novo — manter | Inventário, evidências, limites e instruções manuais. |
