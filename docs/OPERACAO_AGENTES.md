# Política operacional dos agentes — Kidmais Manager

Esta é a referência permanente de autorização operacional para agentes/Codex no repositório `felipemenegaz-debug/kidmais-manager`. Aplicar somente ao escopo solicitado. Restrições explícitas da tarefa, como “somente leitura”, “não tocar produção” ou “aguardar revisão antes de commit”, continuam obrigatórias.

## Contexto registrado em 19/09/2026

Informado e confirmado por Felipe para esta política; não é uma consulta contínua ao estado remoto:

- Existem as branches `main` e `staging`; desenvolvimento e homologação ocorrem em `staging`.
- `staging` está 31 commits à frente de `main`; nenhuma das duas tem proteção de branch configurada.
- A integração oficial Render MCP está funcionando. Workspace conhecido: `My Workspace` (`tea-daidbj95efls73d2bcf0`).
- A branch de origem não determina o ambiente: um serviço de produção continua sendo produção qualquer que seja a branch que ele use.

A afirmação registrada nesta data de que o serviço de produção apontava para `staging` foi superada pela leitura de 29/09/2026 abaixo.

## Topologia Render confirmada em 29/09/2026

Leitura somente de metadados pelo Render MCP (`list_services`/`list_deploys`, workspace `tea-daidbj95efls73d2bcf0`):

| Serviço | ID | Branch | Auto-deploy | Deploy |
|---|---|---|---|---|
| `kidmais-manager-staging` (homologação) | `srv-daif418ae00c73e8k2gg` | `staging` | OFF | manual |
| `kidmais-manager-production` (produção) | `srv-dak77m2d0e5s73b8rkkg` | `production` | OFF | manual |

- PR previews OFF nos dois serviços.
- Pela configuração lida, merge/push em `staging` não dispara deploy (só o CI do GitHub Actions); produção só muda por merge em `production` seguido de deploy manual autorizado.
- Staging e produção têm fluxos separados: cada ambiente tem banco, migrations autorizadas e deploy manual próprios.
- `kidmais-production-admin-019` não apareceu no workspace consultado; seu status (aposentado ou em outro workspace) deve ser confirmado separadamente se ainda for relevante.
- A configuração do Render é mutável pelo painel: revalidar branch e auto-deploy dos serviços, por leitura, imediatamente antes de merges e deploys relevantes. Esta tabela é evidência datada, não garantia.
- O deploy da AI Foundation exige coordenação com as migrations 055a–d, 056 e 057 (ver [INTELIGENCIA_PRODUCAO_V1.md](INTELIGENCIA_PRODUCAO_V1.md)): o código novo exige o schema novo e a 056/057 mudam o modelo de permissões. Não aplicar as migrations e manter o código antigo rodando, nem publicar o código novo sem o schema; o cutover de cada ambiente é uma operação coordenada (backup/clone, migrations com precheck/postcheck, deploy manual, smoke), com autorização explícita.

Revalidar identidade, configuração e efeitos relevantes antes de uma escrita. Esta política não cria proteção de branch nem altera permissões do GitHub, Render ou Codex.

## STAGING

- Leitura de GitHub, metadados Render, status de deploy, logs sanitizados e health é permitida automaticamente no escopo da tarefa.
- Testes locais, TypeScript, ESLint e build são permitidos. Usar ambiente de teste isolado, mocks ou configuração sintética; verificar os efeitos dos scripts e o destino antes de executar testes que possam conectar a banco ou serviços externos. Não carregar credenciais reais por conveniência.
- Alterar código somente no escopo pedido, preservando alterações preexistentes do usuário.
- Commit/push para `staging` somente após revisar o diff e concluir as validações adequadas à mudança. Para código, executar testes pertinentes, TypeScript, ESLint e build; para alterações exclusivamente documentais, revisão de conteúdo/links e `git diff --check` bastam. Respeitar qualquer revisão ou autorização pendente da tarefa.
- Antes do push ou merge, revalidar por leitura a branch e o auto-deploy dos serviços Render e verificar se a publicação pode disparar deploy. Efeito em produção exige autorização explícita de Felipe; não presumir que auto-deploy continua desligado.
- Acompanhar automaticamente um deploy de staging já iniciado ou autorizado, incluindo status, logs, health e regressão permitida. Acompanhar não autoriza disparar ou repetir deploy: isso deve estar no pedido ou em autorização explícita vigente para staging. Evitar deploy duplicado após push com auto-deploy habilitado.
- Alterações de variáveis de ambiente, segredos, restart ou infraestrutura de staging exigem aprovação explícita. A permissão de testar não autoriza migrations, SQL de escrita, restore, delete ou troca de `DATABASE_URL`.

## PRODUÇÃO

- Leitura de metadados, logs sanitizados e health é permitida no escopo solicitado. Se a tarefa disser “não tocar produção”, não acessar produção nessa tarefa.
- Qualquer deploy, redeploy, rollback, restart, liberação de tráfego, alteração de env, branch/commit de origem, domínio/DNS, segredo, revogação de credenciais ou infraestrutura exige autorização explícita de Felipe para o alvo e a ação.
- Migrations, writes SQL, restore, delete e alteração de `DATABASE_URL` sempre exigem autorização explícita de Felipe. A mesma exigência vale em staging e em ambientes isolados; autorização para preparar arquivos não autoriza executá-los em um banco.
- Nunca usar banco de produção para testes, inclusive por scripts de regressão, testes de interface, smoke de escrita ou como destino de restore de teste.
- Leitura de metadados Render e health não autoriza consultas SQL nem leitura de dados de negócio. Acesso direto a banco deve estar explicitamente no escopo e ter o destino validado; a ferramenta SQL do MCP ser somente leitura não amplia essa autorização.
- Preservar a proibição existente de acessar, consultar, alterar ou usar o banco local real `kidmais_manager` como origem de teste/restore/deploy. Não confundir esse banco com um clone isolado autorizado.
- Um resultado GO, teste aprovado ou recomendação em handoff não autoriza nenhuma escrita operacional.

## SECRETS

- Nunca imprimir, copiar ou logar valores de secrets em conversas, comandos, screenshots, relatórios, arquivos versionados ou saídas de ferramentas. Não abrir `.env.local` para trazer credenciais ao contexto.
- Verificar apenas nomes, presença e formato quando possível, por verificadores que não exponham valores. Presença não comprova validade, exclusividade ou rotação.
- Usar injeção segura no processo quando necessária e autorizada; não reutilizar secrets entre staging e produção. Sanitizar logs antes de apresentá-los.
- Se a integração não disponibilizar nomes/presença sem expor valores, registrar a limitação. Não usar uma ferramenta de alteração para tentar ler configuração.

## GITHUB

- Desenvolver e homologar em `staging`. Confirmar branch, repositório remoto, estado da árvore e diff antes de commit/push.
- A futura promoção `staging` → `main` deve ocorrer por PR, após regressão da candidata e revisão. Criar ou aprovar um PR não autoriza merge nem deploy em produção automaticamente.
- Não alterar `main` diretamente sem autorização explícita de Felipe. Não configurar proteções de branch ou outras permissões remotas por iniciativa do agente.
- A ausência atual de proteção técnica não remove estas regras. Não incluir alterações alheias ao pedido no commit.

## RENDER E APROVAÇÕES

- Preferir a integração oficial Render MCP. Distinguir consulta de mutação pelo efeito da ferramenta, não apenas pelo nome.
- Usar o `workspaceId` confirmado em cada chamada, identificar serviço/banco por nome e ID e conferir o ambiente. Listar recursos não autoriza modificá-los.
- Executar automaticamente as leituras permitidas no escopo. Para writes sensíveis descritos nesta política, preparar primeiro um plano concreto com alvo, ação, efeitos, validações e recuperação; pedir aprovação explícita antes de executar.
- Aproveitar uma autorização já dada para a mesma ação e alvo na tarefa, sem repetir a pergunta. Não estender autorização para outro ambiente, ação ou mudança posterior.
- Alterações locais em `render.yaml` ou documentação não devem ser aplicadas ao Render automaticamente. Mudanças de env, restart e infraestrutura podem provocar deploy e devem explicitar esse efeito na aprovação.

## REGRA DE PARADA

Se alvo, workspace, ambiente, banco ou alcance da autorização estiver ambíguo, parar antes de escrever e esclarecer a dúvida. Leituras permitidas e trabalho local independente podem continuar. Não inferir ambiente apenas da branch ou de `NODE_ENV`; staging também pode executar um build com `NODE_ENV=production`.

## Documentação existente e precedência

Esta política define as autorizações; os documentos abaixo mantêm contexto técnico e evidências datadas, sem conceder permissão para executar seus próximos passos. Em conflito operacional, aplicar esta política e as restrições explícitas da tarefa.

- [Handoff de produção](HANDOFF_V1_PRODUCAO.md): preservar como histórico. O smoke de escrita em produção registrado em 15/09/2026 não autoriza repetir testes no banco de produção; GO/NO-GO e configurações antigas não atestam o estado atual.
- [Operação V1](../OPERACAO_V1_PRODUCAO.md): a antiga seção “Consulta protegida do banco real” não deve ser executada; foi superada pela proibição de acesso a `kidmais_manager` mantida no handoff e nesta política.
- [Regressão em clone sanitizado](../REGRESSAO-V1-HOMOLOGACAO.md): usar apenas com alvo isolado confirmado e autorização das operações de banco necessárias.
- [Contrato dos verificadores de produção](../scripts/production/README.md): os checks locais, o smoke HTTP e as opções de conexão a banco têm escopos distintos. Não habilitar conexão por inferência.
- [Skill de produção](../.codex/skills/kidmais-render-production/SKILL.md): avaliação de prontidão e GO/NO-GO.
- [Skill de staging](../.codex/skills/kidmais-render-staging/SKILL.md): acompanhamento rotineiro de staging.
