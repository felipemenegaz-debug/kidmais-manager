# Acabamento e edição administrativa — Kidmais Manager

Data: 09/09/2026. Fonte: estado atual de `D:\glass\KidMais Manager\kidmais-manager` e PostgreSQL local.

## Resultado e limite desta entrega

Foi implementada a edição administrativa da **elaboração inicial ainda sem assinatura**, na mesma tela de Contratos. A edição recalcula as condições pelos serviços de domínio, atualiza a mesma versão e invalida a revisão documental anterior quando o conteúdo muda. A interface ficou clara, com marca existente, navegação real, seções expansíveis, histórico, diferenças e consulta financeira.

Os atalhos públicos **110, 130 e 140** foram adicionados, preservando todos os anteriores e a digitação manual.

**A edição operacional de uma contratação já assinada não está liberada.** Essa parte depende da estrutura de preparação de Fechamento explicada abaixo, para manter V1 e sua situação operacional vigentes durante V2. A elaboração de uma nova versão exclusivamente documental continua disponível, inclusive por iniciativa da equipe, e agora reutiliza a preparação aberta em vez de criar outra.

Nenhuma Migration 014 foi criada ou aplicada. Migrations 012/013, demais migrations, `schema_mvp_kidmais.sql`, configuração local e dados anteriores foram preservados. Festa não foi iniciado; a rota preexistente `/festas/[id]` não foi alterada.

## Checkpoint e inspeção física

Checkpoint anterior às alterações: `.backups/acabamento-1788998049484/`.

- `fontes/`: cópia de 306 arquivos da pasta atual, sem dependências, caches e outros backups.
- `manifesto.json`: SHA-256 dos arquivos copiados.
- `banco.dump`: backup PostgreSQL em formato custom.
- `dados.json`: quantidade e SHA-256 do conteúdo integral das 38 tabelas públicas.
- `catalogo.json`: colunas, defaults, nulabilidade, constraints e triggers.

A pasta não é um repositório Git; por isso a preservação foi feita por cópia verificável e dump, sem criar um repositório ou commit artificial.

O banco atual já contém **um usuário administrativo real**, dois Pagamentos, três planos, cinco parcelas, três recebimentos, três alocações, um estorno e um comprovante. Também havia quatro versões contratuais, uma elaboração e dois documentos. Esses registros não foram tratados como fixtures vazios nem apagados.

A verificação final compara as **38 tabelas integralmente** ao checkpoint, incluindo autenticação, documentos, histórico e financeiro; compara o catálogo físico; e verifica os hashes de 25 arquivos protegidos. Os testes de escrita usam bancos `kidmais_funcional_*` clonados. Nenhum usuário sintético foi criado no banco local de operação.

## Serviços encontrados e operações criadas

| Domínio | O que já existia | Tratamento nesta entrega |
|---|---|---|
| Clientes/CRM | Atualização cadastral, validação, detecção de duplicidades e auditoria | Serviço passa a aceitar a transação da orquestração e bloqueia o registro durante a alteração |
| Aniversariante | Repositório com atualização cadastral | Novo serviço de Clientes valida os dados, vínculo e atividade; atualiza e audita na mesma transação |
| Fechamento | Criação comercial e revisão de propostas; não havia edição administrativa ampla | Novo serviço de edição pré-assinatura com validações e persistência no próprio domínio |
| Pricing | Elegibilidade, faixas, descontos oficiais e precificação de adicionais | Reutilizado; valor calculado não é recebido como valor final livre da interface |
| Disponibilidade | Consulta de horários e lock de agenda compartilhado com bloqueios/reservas | Reutilizado na alteração pré-assinatura; datas bloqueadas são recusadas dentro da transação |
| Comercial | Condição de pagamento, parser monetário, cálculo de descontos e histórico de aprovações | Reutilizados com aprovação administrativa explícita e auditada na edição |
| Contrato | Elaboração documental, revisão de PDF, assinaturas e promoção de versões | Orquestração dos domínios, atualização da elaboração, diferenças e proteção contra fonte desatualizada |
| Pagamentos | Obrigação ligada à versão assinada e pendências por nova vigência | Nenhuma mutação financeira adicionada; painel mostra a obrigação original e pendências existentes |

Não foi usado SQL avulso para alterar os casos reais. O repositório novo de Fechamento persiste somente o resultado validado pelo serviço; a interface e a rota não executam updates de negócio diretamente.

## Campos editáveis

Disponíveis em **Editar festa**, para uma elaboração inicial do fluxo administrativo e antes de qualquer assinatura:

| Grupo | Campos |
|---|---|
| Contratante | Nome completo, RG, telefone, WhatsApp, e-mail, CEP, logradouro, número, complemento, bairro, cidade e UF |
| Aniversariante | Nome e data de nascimento do cadastro vinculado |
| Festa | Idade no evento, tema, data, período, horário e observações da equipe |
| Pacote | Troca entre pacotes elegíveis e configurados no catálogo |
| Convidados | Quantidade manual e atalhos dentro dos limites do pacote |
| Adicionais | Seleção, remoção e quantidade, com cálculo oficial |
| Buffet | Situação pendente/definida e preferências textuais existentes: salgados, bebidas, doces, bolo e outras |
| Comercial | Forma de pagamento, base negociada opcional e condição PIX, mediante aprovação explícita |
| Documento | Observações exclusivamente documentais, pelo botão Salvar revisão |

CPF e troca da identidade do contratante não foram liberados. IDs, hashes, status, assinatura, identidade de assinatura, timestamps, saldo, recebimentos, estornos e comprovantes não são campos de edição.

Correções de cadastro alteram o CRM compartilhado: podem aparecer em outras consultas do mesmo cliente. **Não reescrevem snapshots ou documentos já assinados.**

## Regras da edição

1. A ação exige sessão administrativa real; a rota exige CSRF e origem válidos.
2. O backend valida uma lista estrita de campos. Campos adicionais/técnicos são recusados também no serviço.
3. Fechamento, Contrato, elaboração e registros cadastrais relevantes são protegidos pela transação e por locks.
4. Revisão e hash da fonte impedem sobrescrever uma alteração concorrente ou um cadastro modificado no CRM depois da abertura do formulário.
5. Pricing resolve novamente pacote, data, faixa de convidados e adicionais. Não existe campo de valor final para contornar esse cálculo.
6. O novo Fechamento persiste nos campos existentes; Contrato reconstrói seu snapshot a partir dos domínios. O JSON de Contrato não vira cadastro operacional.
7. Mudanças materiais atualizam a mesma versão em elaboração, incrementam a revisão e removem a referência de revisão/aprovação do PDF anterior. O PDF antigo continua preservado, mas não pode fundamentar a nova revisão.
8. Salvar novamente um conteúdo documental idêntico não cria outra versão nem uma revisão desnecessária.
9. Antes de gerar, revisar ou assinar uma elaboração inicial, o sistema confere novamente a fonte. Alteração externa do CRM exige salvar a revisão e gerar/revisar o documento atualizado.
10. Histórico/auditoria registram o usuário e o contexto. As alterações de Fechamento e cadastro e a revisão de snapshot registram antes/depois.

### Comercial e buffet

O campo **Revisar e aprovar condição comercial nesta edição** é uma decisão explícita da equipe. Sem essa confirmação, o sistema não inventa uma nova aprovação de negociação ou de PIX parcelado quando o preço muda. A decisão usa o histórico de aprovações existente, preserva a proposta anterior quando da mesma forma de pagamento e registra a condição aprovada separadamente.

O valor de tabela é recalculado. Base negociada é uma operação comercial identificada; o desconto de pagamento incide depois, uma vez:

| Forma | Base de teste | Valor contratual validado |
|---|---:|---:|
| PIX à vista | R$ 9.290,00 | R$ 8.361,00 |
| PIX parcelado | R$ 9.290,00 | R$ 9.011,30 |
| Cartão | R$ 9.290,00 | R$ 9.290,00 |

Ao trocar pacote, o buffet deve ficar pendente e as preferências anteriores são limpas para nova conferência. Preferências não geram cobrança. Itens explicitamente incluídos em Completa/Premium são recusados como cobrança extra. Os combos Adultos e Lanchinhos também são recusados nesses pacotes por conterem itens já incluídos, conforme suas composições na migration comercial 006; podem ser escolhidos os itens avulsos não incluídos. Não se inventou um preço parcial para esses combos.

O parser continua rejeitando frações de centavo. Códigos de adicionais e UUIDs de catálogo são normalizados antes das comparações.

## Data e horário: o que foi entregue

**Antes da primeira assinatura**, o operador pode alterar data/período/horário. O backend consulta os candidatos oficiais de Disponibilidade e adquire os locks das datas em ordem estável, usando o mesmo mecanismo dos bloqueios administrativos. Recalcula as regras comerciais da nova data e grava Fechamento e elaboração na mesma transação.

Uma elaboração ainda não confirma reserva. As regras anteriores de confirmação por Pagamentos continuam válidas.

O teste concorrente mantém a transação de um bloqueio aberta, inicia a alteração de data, verifica que ela aguarda, confirma o bloqueio e comprova a recusa da alteração sem mudança parcial de data ou snapshot.

**Depois de assinatura**, a ação operacional é recusada. Não foi implementada promoção de uma nova data sobre V1 usando apenas o JSON contratual.

## Ponto bloqueado: preparação operacional após assinatura

### Lacuna comprovada

O catálogo físico apresenta:

- `contratos.fechamento_id` obrigatório, com FK e unicidade: um Fechamento por Contrato;
- em `fechamentos`, um único conjunto de data, horário, pacote, convidados, preços e buffet;
- `fechamento_adicionais` associado ao Fechamento, sem dimensão de revisão;
- `contrato_fluxos` separando versão vigente e versão em preparação apenas no domínio contratual;
- `contrato_edicoes.dados_fonte` e `alteracoes` em JSONB, com schema de elaboração documental; não há revisão operacional própria de Fechamento;
- assinatura congela a edição e o snapshot; documentos, assinaturas e pendências são imutáveis;
- Pagamentos referencia a versão contratual que originou a obrigação.

Atualizar o Fechamento existente durante V2 mudaria a situação operacional de V1 antes de sua conclusão. Criar um segundo Fechamento independente perderia a relação controlada de revisão e poderia virar outra contratação. Guardar toda a operação proposta em `contrato_edicoes.dados_fonte` colocaria o domínio operacional em Contrato, contrariando a regra desta solicitação.

### Estrutura proposta para uma autorização futura

Não há arquivo SQL novo nesta entrega. O desenho necessário é uma **revisão no domínio de Fechamento**, com referência à elaboração contratual:

1. `fechamento_revisoes`: vínculo com Fechamento e versão contratual, referência à base vigente, estado, revisão concorrente, autor/motivo, campos operacionais propostos tipados (data, horários, configuração, pacote, convidados, referências de preço, valores, buffet e condição comercial), autoria da aprovação e instantes pertinentes.
2. `fechamento_revisao_adicionais`: itens, quantidades, referências de preço e valores da preparação, ligados à revisão e sem substituir os adicionais vigentes.
3. Caso dados cadastrais também devam aguardar a nova vigência, preparação cadastral vinculada à revisão, pertencente ao domínio de Clientes, com controle da versão do cadastro. Essa decisão precisa estar explícita no desenho autorizado; o cadastro compartilhado não deve ser sobrescrito silenciosamente na conclusão.

As constraints devem impedir duas preparações operacionais abertas para a mesma contratação, vincular a revisão ao Contrato correto e congelar sua fonte após assinatura Kidmais. A conclusão pelo cliente deve revalidar a agenda e a fonte aprovada, aplicar a revisão de Fechamento, promover Contrato e criar a pendência financeira cabível **na mesma transação**. Se a data ficar ocupada, a transação deve falhar sem promover V2 nem invalidar V1.

Essa estrutura permitiria upgrade, convidados, adicionais, buffet, condição comercial e remarcação **pós-assinatura**, sem mover a fonte operacional para Contrato. Não altera a obrigação financeira original.

### Impacto e rollback da futura estrutura

Impacto: novas tabelas e serviços de preparação de Fechamento; integração de Disponibilidade e da promoção de Contrato; tratamento explícito de conflito cadastral; uso da pendência financeira já existente. Sem backfill: contratações anteriores entram no fluxo por uma ação administrativa nova.

Antes de uso, o rollback pode remover apenas os objetos novos, na ordem de dependências. Depois de uso, não deve apagar preparações assinadas nem tentar reconstruir vigências por updates automáticos: exige plano aprovado de preservação e restauração, ou correção progressiva. O rollback não pode reescrever prova contratual nem recalcular Pagamentos.

**Aguardando autorização para detalhar/criar/testar/aplicar essa migration. Nenhuma dessas operações estruturais foi executada.**

## UI antes e depois

| Antes | Depois |
|---|---|
| Fundo externo escuro em modo escuro do sistema | Fundo claro em toda a área administrativa e login |
| Cabeçalho simples | Logo existente, identificação Manager, Gestão de festas e sessão |
| Navegação básica | Clientes, Contratos e Agenda/Disponibilidade com estado ativo |
| Somente observações documentais editáveis | Editor único com seções expansíveis por assunto |
| Dados sem resumo de alteração | Cabeçalho de contexto, badge, diferenças antes/depois e histórico |
| Financeiro fora da conferência do Contrato | Consulta da obrigação original e pendências, sem controles de recebimento falsos |
| Atalhos públicos incompletos | 110/130/140 incluídos; entrada manual mantida |

Não foi inventada uma página de Pagamentos: existem APIs, mas não uma listagem visual própria desse módulo. Também não se criou menu apontando para uma listagem inexistente de Festas/Fechamentos ou para a página inicial genérica do Next.js.

Evidências visuais em `.tmp/`: `acabamento-editor-desktop.png`, `acabamento-editor-mobile.png`, `acabamento-painel-desktop.png`, `acabamento-convidados-publico.png`. A tabela de diferenças usa rolagem interna em telas estreitas para não quebrar os valores.

## Arquivos da entrega

Todos os arquivos abaixo precisam permanecer para a funcionalidade, suas proteções, validação ou documentação. Não foram revertidas correções anteriores.

| Arquivo | Motivo |
|---|---|
| `app/api/admin/contratos/versoes/[versaoId]/edicao/route.ts` | Contexto e simulação do editor, com autenticação e serviços oficiais |
| `app/api/admin/contratos/versoes/[versaoId]/route.ts` | Resposta clara para campos inválidos da nova ação, preservando guard |
| `components/admin/admin.module.css` | Fundo claro, cards, grupos, badges, diferenças e responsividade |
| `components/admin/AdminShell.tsx` | Marca existente e navegação das rotas reais |
| `components/admin/ContratoAdmin.tsx` | Editor integrado, histórico, diferenças e consulta financeira |
| `components/admin/EdicaoFesta.tsx` | Formulário administrativo, cálculo, aprovação explícita e dados cadastrais |
| `components/fechamento/FechamentoWizard.tsx` | Uso da lista de atalhos com 110/130/140 |
| `lib/clientes/services/cliente.service.ts` | Participação na transação externa e lock cadastral |
| `lib/clientes/services/aniversariante.service.ts` | Validação, atualização e auditoria pelo domínio de Clientes |
| `lib/contratos/services/administrativo.service.ts` | Orquestração, invalidação, concorrência, diferenças e reutilização de preparação |
| `lib/contratos/services/alteracoes.ts` | Comparação dos campos de conteúdo, sem expor controles técnicos na diferença |
| `lib/contratos/services/contrato.service.ts` | Exporta o carregamento oficial do snapshot para reutilização |
| `lib/fechamentos/convidados.ts` | Lista compartilhada de atalhos, sem mudar limites |
| `lib/fechamentos/convidados.test.ts` | Cobertura dos três atalhos e preservação das opções/limites |
| `lib/fechamentos/repositories/edicao.repository.ts` | Persistência do Fechamento validado e dos adicionais |
| `lib/fechamentos/services/edicao-administrativa-schema.ts` | Campos permitidos, normalização e tipos da ação |
| `lib/fechamentos/services/edicao-administrativa.service.ts` | Regras de alteração, agenda, Pricing, aprovação e auditoria |
| `lib/http/api-response.ts` | Respostas de erros dos domínios chamados pela fachada |
| `scripts/acabamento.integration.cjs` | Integração da nova edição e concorrência em banco clonado |
| `scripts/acabamento-navegador.integration.cjs` | Navegador real, público/admin, viewport desktop/mobile e guards |
| `scripts/admin-contrato.integration.cjs` | Fixtures compatíveis com banco atual já contendo usuário real; não presume tabela vazia |
| `scripts/verificacao-acabamento.cjs` | Comparação somente leitura do banco, catálogo e arquivos protegidos |
| `RELATORIO_ACABAMENTO_EDICAO_ADMINISTRATIVA.md` | Este relatório e roteiro manual |

**Impactos fora de Contrato:** Fechamento recebeu a operação administrativa; CRM ganhou composição transacional e serviço de aniversariante; o tratamento HTTP passa a reconhecer os erros desses domínios. A aparência do shell compartilhado também alcança Clientes, Disponibilidade administrativa e login. **Nenhum arquivo do serviço de Disponibilidade, do serviço de Pricing ou do módulo Pagamentos foi alterado.** Eles foram reutilizados e suas regressões foram executadas.

`next-env.d.ts`, regenerado pelo Next durante o build, foi restaurado aos bytes do checkpoint. Caches `.next`, `.tmp` e `tsconfig.tsbuildinfo` são artefatos de execução, não mudanças funcionais da entrega.

## Testes e regressões

| Bateria | Resultado |
|---|---|
| Novos atalhos unitários | 5 testes aprovados |
| Nova edição administrativa | 29 verificações de integração aprovadas |
| Autenticação/Contrato 013 | 30 verificações aprovadas; preservação de assinaturas/PDF/V1, OTP e promoção documental |
| Navegador real | 13 cenários aprovados; zero erros de página |
| Comercial e pagamento unitários | Aprovado |
| Disponibilidade unitária | Aprovado |
| Contrato unitário | Aprovado |
| Pagamentos unitário | Aprovado |
| Condição comercial/Fechamento/Contrato/Pagamentos integrados | Aprovado |
| Pagamentos engenharia | Aprovado |
| Pagamentos HTTP | Aprovado |
| Pagamentos concorrência | Aprovado |
| PricingService integrado | Aprovado |
| Identidade repositório/serviço/Fechamento | Aprovado |
| TypeScript sem emissão | Aprovado |
| ESLint direcionado aos arquivos de código da entrega | Aprovado |
| Build Next.js de produção | Aprovado |
| Preservação física e dos dados locais | 38 tabelas sem divergência; catálogo e arquivos protegidos preservados |

O primeiro build falhou por acesso ao Google Fonts. A repetição autorizada com acesso à rede passou; não se alterou o carregamento de fontes para mascarar a falha. A validação de navegador usa uma cópia isolada da aplicação, banco clonado e porta 3100, com Webpack no modo de desenvolvimento para não disputar o servidor do operador. O build de produção usa o comando normal do projeto, com Turbopack.

Os warnings de módulo TypeScript carregado pelo Node e de consultas concorrentes no cliente pg são avisos existentes; não foram convertidos em bypass de testes. Foram mantidos os guards e as constraints físicas.

Relatórios verificáveis: `.tmp/acabamento-resultados.json`, `.tmp/admin-contrato-resultados.json`, `.tmp/navegador-acabamento.json`, `.tmp/regressoes-013.json`, `.tmp/verificacao-acabamento.json`, `.tmp/acabamento-lint.log` e os logs de regressão associados.

## Limites conhecidos

- A edição ampla pós-assinatura e a promoção de uma remarcação vigente dependem da preparação operacional proposta. Não foram apresentadas como concluídas.
- Observações de V2 são editáveis somente enquanto a preparação estiver em elaboração. Depois de assinatura Kidmais, a versão fica congelada.
- Elaborações legadas sem `contrato_edicoes` não foram convertidas em lote nem receberam backfill.
- O registro de modelos oficiais de PDF existente atende **Festa Completa**. Outros pacotes podem ter preço/cadastro válidos, mas não ganharam um template contratual novo nesta entrega; a geração oficial permanece bloqueada onde o modelo não existe. Não foi reutilizado indevidamente o texto de Completa para outro pacote.
- Buffet continua usando preferências textuais existentes. Não foi inventado um catálogo estruturado de sabores nem uma regra nova de preço parcial para combos.
- A aprovação administrativa da condição PIX não cria o plano financeiro; a conferência exata da soma do plano com a versão assinada continua no serviço de Pagamentos.
- A pendência financeira existente continua imutável e sem resolução automática. A promoção documental foi regressada; a promoção de alterações operacionais de valor pós-assinatura não foi simulada como funcionalidade disponível.

## Passo a passo manual — navegador e terminal

### 1. Abrir o sistema

1. No VS Code, feche a aba `.env.local` para não expor credenciais.
2. Clique no menu superior **Terminal → New Terminal / Novo Terminal**.
3. Clique na área inferior, ao lado da linha que começa com `PS`. Cole o comando abaixo **no terminal**, não no editor de arquivos, e pressione Enter:

   ```powershell
   Set-Location -LiteralPath 'D:\Glass\KidMais Manager\kidmais-manager'
   ```

4. Se já existe terminal rodando o servidor na porta 3000, mantenha-o aberto e use-o. Se não existe, execute:

   ```powershell
   npm.cmd run dev
   ```

5. Aguarde aparecer **Ready/Pronto** e confira o endereço **Local**. Não feche esse terminal.
6. Abra Chrome ou Edge. Na barra de endereços, digite `http://localhost:3000/admin/login` e pressione Enter. Se o terminal indicar outra porta, substitua somente o número 3000 pela porta indicada.
7. Use o e-mail e a senha do usuário que você já criou. **Não rode o bootstrap novamente.** Se aparecer erro de configuração `ADMIN_AUTH_SECRET`, a conta já existe, mas falta a configuração de autenticação do servidor; não tente recriar a conta.

### 2. Conferir visual e escolher um contrato

1. Após entrar, abra **Contratos** no menu.
2. Confira fundo claro, logo, identificação da sessão e os links Clientes / Contratos / Agenda.
3. No campo **Contrato**, escolha um cenário de teste.
4. Veja o nome do cliente, data, pacote, convidados, estado da versão e Histórico.
5. Para testar a edição ampla, selecione uma **elaboração inicial EM_ELABORACAO, ainda sem assinatura**, criada no fluxo administrativo. Nesse caso aparece **Editar festa**.
6. Se o contrato já está assinado, use o roteiro documental mais abaixo. A ausência da edição operacional nesse caso é o bloqueio deliberado desta entrega.

### 3. Alterar convidados e pacote

1. Clique em **Editar festa**.
2. A seção **Pacote e convidados** estará aberta. As outras seções podem ser abertas clicando no título roxo.
3. Clique em 110, 130 ou 140 e confira o número no campo. Os botões só aparecem quando cabem nos limites do pacote.
4. Digite manualmente, por exemplo, 67 no campo **Convidados pagantes**. Não é obrigatório usar um atalho.
5. Abra **Condições comerciais** e aguarde o recálculo do valor de tabela.
6. Se trocar pacote, confira sua elegibilidade. As preferências anteriores do buffet são limpas e ficam pendentes para nova definição.
7. Em **Motivo da alteração administrativa**, descreva o motivo operacional. Não é necessário afirmar que o cliente pediu.
8. Clique em **Salvar alteração da festa**. Essa ação altera o cenário selecionado: use um cenário de teste, não uma contratação real sem intenção de mudança.
9. Confira o mesmo número da versão, a nova revisão e **Alterações desta revisão**, com antes/depois.
10. Teste 49 e 151 em Festa Completa: o formulário/backend devem recusar os valores fora dos limites. Volte a uma quantidade válida para salvar.

### 4. Cadastro, aniversariante, adicionais e buffet

1. Reabra **Editar festa** e expanda **Dados do contratante** ou **Dados da festa**.
2. Corrija os campos permitidos. O CPF não é editável por esse formulário.
3. Para adicionais, expanda **Adicionais**, marque/desmarque e informe quantidade quando selecionado.
4. Itens/combos que contêm componentes já incluídos no pacote não podem ser cobrados novamente; na troca de pacote, desmarque uma seleção incompatível se ela continuar selecionada.
5. Expanda **Escolhas do buffet**. Após salvar a troca de pacote como pendente, reabra, confira as novas preferências e, quando estiverem definidas, altere a situação para Definido.
6. Informe motivo, salve e confira diferenças. As correções cadastrais também devem aparecer em **Clientes**, para o mesmo cadastro.

### 5. Condição comercial

1. Expanda **Condições comerciais**.
2. Confira o valor calculado. Para mudar/aprovar forma ou negociação, marque **Revisar e aprovar condição comercial nesta edição**.
3. Escolha PIX à vista, PIX parcelado ou Cartão.
4. Deixe a base negociada em branco para usar a tabela oficial. Se existe uma negociação realmente autorizada para o cenário, informe sua base com até duas casas decimais; isso não substitui o cálculo de tabela.
5. Em PIX parcelado, informe a condição acordada: entrada, valor de parcela e/ou quantidade.
6. Informe o motivo e clique em Salvar. Leia a confirmação comercial exibida pelo navegador antes de confirmar.
7. Confira valor e condição aprovados no painel. Não deve surgir recebimento nem plano financeiro automaticamente.
8. Para reproduzir os três exemplos de preço, use um cenário com base comercial aprovada de R$ 9.290,00 e confira os resultados da tabela deste relatório. Não espere que qualquer data/pacote tenha tabela de R$ 9.290,00: o preço depende do catálogo e da data.

### 6. Alterar data antes da primeira assinatura

1. Na elaboração inicial, abra Editar festa → **Dados da festa**.
2. Escolha a nova data e aguarde a consulta. Selecione período e um horário disponível da lista.
3. Abra Pacote/Condições comerciais e confira a regra da nova data e o recálculo.
4. Salve com motivo. Confira a nova data no painel e nas diferenças.
5. Uma data bloqueada/ocupada deve ser recusada, preservando o estado anterior. O formulário não confirma reserva automaticamente.

### 7. Gerar e revisar novamente o documento

1. Feche o editor após salvar e vá a **Campos documentais**.
2. Se necessário, altere observações documentais e clique em **Salvar revisão**.
3. Clique em **Gerar PDF da revisão N**. Para o catálogo atual, utilize Festa Completa para validar o PDF oficial.
4. Abra o link do novo PDF e confira o conteúdo.
5. Clique em **Confirmar revisão deste PDF** somente depois de lê-lo.
6. Para assinar pela Kidmais, confirme a senha no campo próprio e clique em **APROVAR E ASSINAR PELA KIDMAIS**; leia a confirmação.
7. Depois, clique em **LIBERAR PARA O CLIENTE**.
8. A assinatura do cliente continua pelo acesso público e OTP existentes. Pagamentos continua sendo uma criação explícita posterior.
9. Se o CRM foi alterado em outra tela, a tentativa de usar conteúdo antigo deve exigir salvar/atualizar a revisão e gerar/revisar novo PDF.

### 8. Contrato já assinado: revisão documental

1. Em Contratos, selecione a versão vigente assinada.
2. Vá a **Nova alteração contratual**, escolha Nova versão ou Retificação e informe o motivo da equipe.
3. Clique em **Iniciar elaboração**. Se já houver preparação ainda editável, ela será reutilizada.
4. Confira que V1 permanece no histórico e que a nova versão não tem assinatura herdada.
5. Altere apenas observações documentais e siga gerar → revisar → assinar Kidmais → liberar → assinatura do cliente.
6. Confira que V1 continua preservada e que o painel Financeiro continua mostrando a obrigação da versão original.
7. Não tente usar observações para remarcação, upgrade ou renegociação pós-assinatura: essas operações aguardam a estrutura proposta.

### 9. Atalhos no Fechamento público

1. Abra `http://localhost:3000/disponibilidade`.
2. Escolha uma data/horário disponível e siga o link de Fechamento apresentado pela tela.
3. Escolha Festa Completa e clique em **Continuar**.
4. Em **Quantos convidados pagantes?**, confira 110, 130 e 140, além das opções anteriores.
5. Clique em cada um e confira o campo. Depois digite 67 manualmente e clique em Continuar: deve avançar para buffet.
6. Para conferir limites, volte e tente 49 ou 151 em Festa Completa: não deve avançar até corrigir.
7. Não é necessário enviar um novo Fechamento para validar esses botões.

## Encerramento

Esta entrega encerra o acabamento e as operações descritas como disponíveis. Não encerra a edição operacional pós-assinatura. O próximo passo estrutural depende da autorização do desenho de preparação de Fechamento. Nenhum próximo módulo foi iniciado.
