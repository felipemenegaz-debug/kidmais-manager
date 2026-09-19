---
name: kidmais-render-staging
description: Consultar inventário, deploys, logs e health do Kidmais Manager em staging via Render MCP e acompanhar regressão pós-deploy. Use em operações rotineiras de homologação; para prontidão de produção, use kidmais-render-production.
---

# Kidmais Render Staging

Ler primeiro a [política operacional dos agentes](../../../docs/OPERACAO_AGENTES.md). Esta skill aplica suas autorizações ao acompanhamento de staging; não concede permissão adicional para escrita.

Esta skill nunca executa migrations. Não aplica, reaplica, desfaz nem testa migrations contra banco remoto. Se uma operação exigir migration, pare e encaminhe para uma tarefa específica de migration, com escopo e autorização explícitos.

## Identificar o alvo

- Usar a integração oficial Render MCP. Workspace conhecido: `My Workspace` (`tea-daidbj95efls73d2bcf0`); passar o `workspaceId` confirmado em cada chamada. Se não estiver confirmado no escopo, listar workspaces e esclarecer antes de qualquer escrita.
- Localizar `kidmais-manager-staging` por inventário e confirmar ID, repositório `felipemenegaz-debug/kidmais-manager` e branch `staging` nos metadados. ID conhecido em 19/09/2026: `srv-daif418ae00c73e8k2gg`; divergência exige conferir o alvo, não selecionar outro serviço por semelhança.
- Serviços de produção também podem usar a branch `staging`. Não os tratar como homologação. Não acessar produção quando a tarefa proibir.

## Consultas e acompanhamento

- Usar `list_services`/`get_service` para inventário e estado, `list_deploys` para o último deploy ou os cinco mais recentes e `list_logs` para inicialização/erros, com janela temporal e limite adequados. Tratar paginação quando necessária. Não usar consultas SQL para completar inventário de bancos.
- Registrar nome/ID, branch, repositório, URL pública, auto-deploy, deploy ID, status, SHA e horário com fuso. Distinguir candidata em andamento do deploy efetivamente `live`; `deactivated` não significa necessariamente falha.
- Acompanhar deploy já iniciado/autorizado com consultas espaçadas até conclusão ou bloqueio. Em falha, apresentar evidências; não reiniciar, refazer deploy, rollback ou alterar env automaticamente. Não criar monitor recorrente sem pedido.
- Sanitizar logs e exibir apenas trechos relevantes. Consultar somente nomes/presença de env se a ferramenta de leitura permitir; caso contrário, informar a limitação sem chamar `update_environment_variables` ou buscar valores de secrets.

## Health e regressão pós-deploy

- Usar a URL HTTPS pública confirmada. O MCP atual não oferece requisição HTTP de health: quando o escopo permitir HTTP, usar `node scripts/production/smoke-test.mjs --base-url=https://kidmais-manager-staging.onrender.com --json`, conforme o [contrato do verificador](../../../scripts/production/README.md). Se o pedido limitar acesso exclusivamente ao MCP, registrar health HTTP não verificado.
- O smoke faz GET de health e não abre conexão SQL direta. HTTP 503 continua falha; não inferir causa quando a resposta não a informar. HTTP 200 `degraded` pode ser esperado com OTP explicitamente desabilitado, conforme código/configuração verificados. Health não comprova entrega de WhatsApp.
- Conferir SHA implantado e resultados da regressão da candidata. Para código alterado, `npm run check:v1:static` reúne testes unitários, ESLint, TypeScript e build; preparar ambiente local isolado antes da execução. Não repetir sem motivo uma validação já concluída para a mesma candidata.
- Não executar `npm run check:v1:staging`, `check:v1:clone` ou outros testes integrados apenas pelo nome: podem conectar e escrever no banco. Inspecionar efeitos, confirmar destino de homologação/clone isolado e obter autorização explícita para operações de banco antes de executá-los. Nunca usar produção ou `kidmais_manager`.
- Navegação/regressão pós-deploy deve respeitar os efeitos das rotas. Criação de dados e envio real de OTP/WhatsApp precisam estar explicitamente autorizados; não fazem parte de uma consulta de logs/health.

Concluir com ambiente/commit verificados, evidências, falhas e verificações pendentes. Env/secrets, restart e infraestrutura exigem aprovação explícita; ambiguidades de alvo ou autorização impedem escrita.
