# Agendamento da reconciliação — criado, aguardando habilitação

Atualização de 09/10: pré-requisito de schema resolvido; 074a/075 aplicadas em staging com backup, pre/postchecks e health aprovados. Ver [execução](MIGRATIONS_ASSINATURA_STAGING_20261009.md). O diagnóstico anterior de schema ausente abaixo é histórico. Código validado e publicado em staging; cron criado em modo aguardando. Habilitação depende das credenciais exclusivas e conexão TLS verificada.

## Execução autorizada — bloqueio confirmado em 09/10/2026

Felipe autorizou este plano. A inspeção do schema foi executada antes da criação do recurso pago: **074 e 075 ausentes em staging**. `empresa_assinaturas` e `cobranca_eventos` existem; `assinatura_isencoes`, `assinatura_fundadores`, `assinatura_contratacoes` e `assinatura_renovacoes` retornaram null no catálogo. Banco confirmado `kidmais_staging_1z91`, transação `READ ONLY`, conexão TLS ativa.

O conector SQL Render falhou ao conectar. SSH local não estava configurado (sem chave de host conhecida e sem diretório de chaves). A inspeção foi concluída pelo Web Shell autenticado do serviço staging, usando a conexão privada já existente e conferindo host/nome antes de conectar. Certificado interno autoassinado tratado no processo de inspeção, com TLS ativo; nenhuma configuração persistente de TLS/rede alterada. Nenhuma credencial foi impressa. Apenas catálogos e identidade da conexão foram consultados.

Último deploy staging consultado: `dep-db488b3l550s73atio70`, live, commit `ef1d74a7046cf37df458828d1febfea5911302b0` (biblioteca de molduras de convites). Não publicado nem alterado nesta etapa.

Conforme o item 2 do plano aprovado, execução interrompida antes de criar cron ou habilitar escritas. Não houve custo novo, migration, push ou deploy. A autorização do cron permanece válida; o pré-requisito é a [operação específica de migrations](MIGRATIONS_ASSINATURA_STAGING_20261009.md), posteriormente autorizada e concluída.

## Configuração preparada

Blueprint separado: `infra/render-assinatura-cron.yaml`. Não foi aplicado. Serviço novo `kidmais-assinatura-reconciliar-staging`, workspace `tea-daidbj95efls73d2bcf0`, região Virginia, Node 22.23.2, plano `0.5c-512mb`, branch `staging`, deploy automático desligado. Executa a cada cinco minutos, UTC; limite local de quatro minutos por rodada. Sem disco ou endpoint público.

Inicialmente `KIDMAIS_RECONCILIAR_MODO=aguardando`: o lançador `scripts/assinatura-cron.cjs` registra que aguarda habilitação e não conecta nem importa o cliente do provedor. Este estado NÃO significa que os pagamentos estão sendo reconciliados. Depois da verificação do alvo e do schema, passar por `simular` e só então `aplicar`. A simulação faz transações com rollback; portanto também exige a aprovação operacional do banco.

O lançador restringe ambiente a staging, provedor a sandbox e conexão ao alvo esperado. A confirmação `KIDMAIS_RECONCILIAR_SCHEMA_VALIDADO=074-075` deve ser preenchida apenas depois da inspeção real; não instala migrations e não substitui a inspeção. O host privado esperado no arquivo deriva do ID Render e ainda precisa ser confirmado no painel de conexões, sem revelar a senha.

## Metadados verificados em 09/10/2026

- Serviço web staging: `srv-daif418ae00c73e8k2gg`, branch staging, auto-deploy OFF.
- Serviço web produção: `srv-dak77m2d0e5s73b8rkkg`, branch production, auto-deploy OFF. Nenhuma alteração proposta nele.
- Banco staging: `dpg-daidko3m8hqs73ce4jt0-a`, nome `kidmais-staging`, database `kidmais_staging_1z91`, available, Virginia.
- A listagem não mostrou cron existente. Nenhum SQL, segredo ou dado de negócio remoto foi consultado nesta preparação. A existência do banco não comprova schema nem credenciais instalados.

## Sequência operacional proposta

1. Revisar/publicar a candidata de código em staging, preservando trabalho preexistente e revalidando auto-deploy antes de push. A árvore local ainda contém alterações da integração comercial; não publicar um conjunto incompleto de dependências. Identificar commit exato e passar os checks obrigatórios antes de criar serviço baseado nesse commit. Não fazer merge/deploy do web por inferência.
2. Inspecionar somente metadados do schema no banco staging exato (catálogo, tabelas/colunas/constraints exigidas por 068/074/075). Validar conexão e TLS. Não consultar dados dos clientes. Se schema estiver incompleto, parar: migrations/cutover do web precisam de plano e autorização próprios; a aprovação deste cron não os inclui.
3. Criar o cron separado com modo aguardando, conferir ID e commit. Custo mínimo mensal US$ 1, inclusive sem trabalho útil; uso ativo pode superar o mínimo. Não criar outros serviços ou bancos. Sem auto-deploy.
4. Configurar somente no novo cron os valores de `KIDMAIS_RECONCILIAR_DATABASE_URL`, confirmação literal do alvo, chave/token Asaas sandbox e marcador de schema verificado. Não copiar grupos de env inteiros nem credenciais de produção; nenhuma variável Resend é necessária. A chave local protegida por DPAPI não é presumida como credencial exclusiva do serviço remoto.
5. Configurar notificações de falha por e-mail especificamente para o cron e conferir destinatário Felipe (`felipemenegaz@gmail.com`) e preferências efetivas. Não alterar padrões de todos os serviços nem conectar Slack. A API de listagem não comprovou esse destino; não declarar alerta ativo até verificá-lo. As saídas 1 (interrupção/configuração) e 2 (itens falhos) devem falhar a execução do Render. Não enviar mensagens de teste a terceiros.
6. Rodada `simular`, conferir relatório sem mutação externa e sem dados sensíveis; depois ativar `aplicar`, habilitando as escritas da reconciliação no banco staging e compensações sandbox já implementadas. Conferir duas execuções e a configuração de notificações. Testar alerta com uma execução deliberadamente recusada pela guarda, sem credenciais/banco; restaurar modo e confirmar recuperação. A confirmação de chegada do e-mail pelo usuário continua necessária.

## Efeitos e recuperação

O modo aplicar atualiza assinaturas, eventos, auditoria e confirmações comerciais, podendo remover duplicatas do Asaas sandbox conforme as regras de compensação existentes. Não cria cobranças novas nem envia e-mail pelo Resend. A garantia de uma execução por vez do Render é por serviço; não iniciar um segundo cron idêntico nem rodar o CLI manualmente em paralelo. Disparo manual enquanto roda cancela a execução ativa.

Se houver divergência ou falha, retornar modo aguardando/suspender somente o novo cron, preservar relatórios e reconciliar novamente após correção. Interrupção não desfaz ações já confirmadas no provedor. Nenhum rollback destrutivo, restauração de banco ou remoção de históricos está autorizado por este plano.

## Validação local

Três testes das guardas/ciclo e ESLint aprovados. Blueprint validado contra o schema oficial Render draft 2020-12, com AJV 8 instalado somente em `.local-assinatura-cron` (ignorado pelo Git). O AJV antigo do projeto não suporta esse draft; dependências do projeto não mudaram. Validação do schema comprova estrutura, não identidade do banco, credenciais ou notificações remotas. Nenhum deploy/agendamento foi criado.

## Autorização já recebida (histórico)

Solicitar autorização para criar/configurar este cron e seu custo, inspecionar o schema do banco staging indicado e, somente se os pré-requisitos estiverem corretos, habilitar a reconciliação periódica com os efeitos descritos. A [política operacional](OPERACAO_AGENTES.md) exige: “Alterações de variáveis de ambiente, segredos, restart ou infraestrutura de staging exigem aprovação explícita”. Também exige autorização para SQL e troca de conexão, inclusive em staging. A exigência vem da política do projeto; as skills Render orientam a implementação.

Fontes oficiais consultadas: [Cron Jobs](https://render.com/docs/cronjobs) (mínimo de US$ 1/mês, uso por segundo, single-run, UTC), [notificações](https://render.com/docs/notifications) (falhas de cron por e-mail/Slack e override por serviço), [Blueprint](https://render.com/docs/blueprint-spec) (schema e campos suportados).

## Publicação e recurso criado em 09/10

Candidata de integração: commit 2ad129c; incorporada com convites em 5cc471c. Branch staging atual cdae01f contém a candidata e acrescenta apenas documentação/harness de convites. Cron crn-db493i142hec73ahmoe0 criado em Virginia, 0.5c-512mb, auto-deploy OFF, a cada 5 minutos. Build live dep-db493i942hec73ahmpa0. Execuções 07:05 e 07:10 UTC emitiram AGUARDANDO_HABILITACAO, conectou:false. Estas rodadas não reconciliam pagamentos.

Preferência do próprio cron definida como Only failure notifications; metadados confirmam notifyOnFail=notify. Canal Email confirmado no painel; conta autenticada felipemenegaz@gmail.com. Entrega efetiva ainda não testada. Nenhuma chave Asaas, conexão de banco ou token de webhook foi instalada neste cron; não copiar a chave dos ensaios locais por inferência.

Validação da candidata: 2165 testes da aplicação, 103 do harness staging, TypeScript e lint sem erros, build isolado sem .env aprovado; 37 testes de inventário, 4 das guardas/ciclo e 2 da porta do webhook aprovados. Após nova entrega de convites, 45 testes de convites, lint pertinente e build novamente aprovados. Aviso preexistente de lint em catalogo.ts, sem erros. Testes do webhook local precisaram liberar apenas loopback. Nenhum banco ou provedor real acessado nestas validações.

Inventário reconhece 074 convites, 074a planos e 075 renovação, com checks distintos e autorização operacional ainda obrigatória por ambiente. TLS remoto agora não aceita que parâmetros da URL desabilitem a verificação de certificado; CA própria opcional, com rejectUnauthorized:true. Conexão ativa do cron ainda precisa ser homologada.

Configuração restante: [guia de habilitação](CONFIGURAR_CRON_STAGING_20261009.md).

## Deploy web concluído

Deploy dep-db497o942hec73ai4ut0 live às 07:18:58 UTC de 09/10/2026, commit cdae01f715105db4dfbb791d30184d5e12b9950d. Build remoto e regressão estática aprovados. Health HTTP 200, databaseReady/festaReady/otpReady true. Página /conheca carregou, aba Agenda selecionou, ciclo Anual selecionou e primeira FAQ abriu com a resposta esperada. Cadastro e preços permanecem fechados pelas flags atuais; dados legais/contato ainda aparecem a definir. Nenhuma alteração de flags do web foi feita.

Avisos do cron: override Only failure notifications, notifyOnFail=notify, canal Email observado, conta autenticada de Felipe confirmada. Entrega efetiva e teste deliberado de falha ficam pendentes até configurar o cron.

Produção não alterada. Não houve novas migrations nesta publicação.
