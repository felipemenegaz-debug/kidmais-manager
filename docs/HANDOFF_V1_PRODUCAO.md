# Handoff V1 — preparação para produção

Data: 14/09/2026.

## Base confirmada antes da criação

- Clone: `D:\glass\KidMais Manager\kidmais-manager-github`.
- Branch: `staging`.
- Commit: `b58acc96c9d6600ffed132e751f83f497c2e8877` (`b58acc9`).
- Árvore de trabalho limpa na verificação inicial.
- Presentes: `render.yaml`, `database/migrations/20260912_017_pocket_sexta.sql`, `database/migrations/20260912_018_whatsapp_onboarding.sql` e `app/api/health/route.ts`.

Este handoff distingue fatos confirmados pela leitura do repositório de fatos operacionais informados e validados externamente. O Codex desta execução não verificou diretamente esses fatos no Render. Nenhum banco ou serviço externo foi acessado nesta tarefa; testes e build não foram executados. A única alteração desta tarefa é este documento.

## Configuração versionada de staging

O `render.yaml` define o serviço `kidmais-manager-staging`, branch `staging`, runtime Node.js `22.23.2`, plano `starter`, região `virginia`, uma instância e deploy automático desativado.

- Build: `npm ci --include=dev && npm run check:v1:static && npm run build`.
- Inicialização: `node scripts/init-staging-data.cjs && npm start`.
- Health check: `/api/health`.
- Disco: 1 GB em `/opt/render/project/src/data`.
- `NODE_ENV=production`, `KIDMAIS_DEPLOY_ENV=staging`, `FESTA_ENABLED=true`.
- OTP desabilitado explicitamente: `IDENTIDADE_OTP_PROVIDER=disabled` e `KIDMAIS_STAGING_OTP_DISABLED=SIM`.
- Aceite de desenvolvimento desativado: `CONTRATO_ACEITE_DEV_ENABLED=false`.

O inicializador de dados exige `KIDMAIS_DEPLOY_ENV=staging`; portanto, o comando de inicialização atual não serve diretamente para produção. Ele cria ou valida `data/disponibilidade.json`. A produção precisa de provisionamento e persistência próprios para esse arquivo, mantendo uma instância enquanto essa estratégia de armazenamento permanecer.

## Migrations disponíveis

| Migration | Efeito observado no SQL | Verificações disponíveis |
| --- | --- | --- |
| 017 | Encerra em 11/09/2026 a regra histórica de indisponibilidade do Pocket na sexta, TURNO_1, e cria disponibilidade a partir de 12/09/2026. | `database/checks/20260912_017_precheck.sql` e `database/checks/20260912_017_postcheck.sql` |
| 018 | Cria estruturas de conexão e tentativas de onboarding WhatsApp, com credencial cifrada e separação de ambiente. Exige estruturas administrativas e recusa instalação parcial. | `database/checks/20260912_018_precheck.sql` e `database/checks/20260912_018_postcheck.sql` |

A existência dos arquivos não demonstra que foram aplicados. Antes de qualquer implantação no banco de destino, confirmar o histórico e os pré-requisitos, incluindo a estrutura de Festa da 016, executar os prechecks e registrar os postchecks após eventual aplicação autorizada. Não reaplicar migrations por suposição.

Os scripts de reversão estão em `database/rollback/`. A reversão da 018 recusa execução quando existem dados de onboarding ou conexão. A 017 também contém verificações de estado e dependências comerciais. Reversão de banco exige análise própria e backup restaurável; não deve acompanhar automaticamente o rollback da aplicação.

## Saúde e limites da verificação

A rota `app/api/health/route.ts` usa Node.js, execução dinâmica e `Cache-Control: no-store`. A implementação em `lib/saude/status.ts` verifica conexão PostgreSQL, habilitação e validação do ambiente Festa e configuração de OTP.

- HTTP 200 com `status: ready`: componentes database, festa e otp prontos na avaliação implementada.
- HTTP 200 com `status: degraded`: staging com OTP explicitamente desabilitado, database e festa prontos.
- HTTP 503 com `status: unavailable`: falha de prontidão.

O health check valida a configuração do OTP, mas não comprova entrega real de WhatsApp nem homologação do onboarding. Para o GO comercial dos fluxos dependentes de WhatsApp/OTP, exigir a integração validada, saúde compatível e teste de recebimento em número controlado. O GO técnico da infraestrutura e dos fluxos administrativos independentes de WhatsApp tem avaliação própria. A pendência da integração não impede sua preparação ou seus smoke tests. Essa distinção não modifica a implementação atual: configuração de OTP inválida pode produzir HTTP 503 em production. Não inventar tokens, credenciais ou configuração para forçar health `ready`, nem enfraquecer validações de segurança.

## Preparação necessária para produção

1. Concluir a configuração do serviço production já criado, do domínio HTTPS e da origem administrativa. Production usa `npm start`, sem o inicializador exclusivo de staging.
2. Configurar PostgreSQL, permissões de runtime, TLS e persistência. O YAML atual usa `DATABASE_SSL=false` e `DATABASE_SSL_REJECT_UNAUTHORIZED=false`; revisar esses valores conforme a conexão de produção e o roteiro operacional.
3. Configurar `DATABASE_URL`, `ADMIN_AUTH_ORIGIN`, `ADMIN_AUTH_SECRET` e `IDENTIDADE_OTP_PEPPER` como variáveis de ambiente do serviço, com proteção adequada aos segredos e sem registrar seus valores no repositório. Seguir as regras de rotação e Environment Variables abaixo.
4. Usar `KIDMAIS_DEPLOY_ENV=production`, `IDENTIDADE_OTP_PROVIDER=whatsapp_cloud` e remover a exceção `KIDMAIS_STAGING_OTP_DISABLED`. Manter Festa habilitada e aceite de desenvolvimento desabilitado.
5. Configurar `WHATSAPP_CLOUD_API_VERSION`, `WHATSAPP_CLOUD_PHONE_NUMBER_ID`, `WHATSAPP_CLOUD_ACCESS_TOKEN` e `WHATSAPP_OTP_TEMPLATE_NAME`; revisar idioma, país e timeout. Homologar recebimento, expiração, tentativas e uso único no fechamento e aceite de contrato.
6. Validar separadamente o onboarding Meta e suas variáveis `META_*`, `WHATSAPP_CREDENTIAL_ENCRYPTION_KEY` e `WHATSAPP_CREDENTIAL_KEY_VERSION`, já listadas no YAML. Configurar onboarding não substitui a configuração do emissor de OTP.
7. Confirmar migrations e executar regressão estática, integrada em clone isolado e navegação desktop/mobile. Registrar resultados com commit e ambiente utilizados.
8. Preparar backup PostgreSQL e de `data/disponibilidade.json`, testar restauração em ambiente isolado e definir responsáveis, retenção e recuperação.
9. Após implantação autorizada, verificar saúde, login e sessão administrativa, disponibilidade, fechamento, contrato, pagamentos e Festa; concluir piloto acompanhado.

## Critério de passagem

Production permanece explicitamente em **NO-GO** neste momento. O GO técnico da infraestrutura e dos fluxos administrativos que não dependem de WhatsApp exige evidências de regressão, migrations no destino, segurança das credenciais, HTTPS, persistência, restauração de backup, monitoramento e aceite operacional. O GO comercial dos fluxos dependentes de WhatsApp/OTP exige adicionalmente liberação e validação real dessa integração. WhatsApp não está declarado pronto. A pendência de WhatsApp/Coexistence não bloqueia a preparação técnica nem os smoke tests administrativos independentes da integração.

Em falha da candidata, retirar a versão do tráfego e avaliar retorno ao artefato anterior compatível com o banco. Preservar os dados e tratar qualquer reversão de schema em procedimento específico.

## Estado operacional confirmado fora desta tarefa

Os fatos desta seção foram informados pelo responsável e validados operacionalmente fora desta execução. O Codex desta execução não os verificou diretamente no Render. Eles complementam a leitura técnica do repositório; não são resultados de testes ou acessos realizados nesta tarefa.

### Production já criada

PostgreSQL production já criado: `kidmais-production`.

Banco: `kidmais_production`.

Configuração inicial conhecida:

- PostgreSQL 18;
- Virginia (US East);
- compute básico pago;
- storage inicial 1 GB;
- autoscaling desligado;
- HA desligado.

Web Service production já criado: `kidmais-manager-production`.

Configuração inicial conhecida:

- branch `staging` usada **TEMPORARIAMENTE** durante a preparação de production;
- região Virginia;
- build: `npm ci --include=dev && npm run check:v1:static && npm run build`;
- start: `npm start`;
- auto deploy deve permanecer desligado;
- health path: `/api/health`.

### Regra crítica e permanente do banco local real

**O banco local real `kidmais_manager` NUNCA deve ser acessado, consultado, alterado, usado para migrations, usado para testes, usado como origem de restore ou usado como origem de deploy.**

Essa é uma regra permanente do projeto nesta preparação. Referências históricas a consultas no banco real não constituem autorização e não devem ser seguidas nesta preparação.

Existe um clone local anonimizado de homologação: `kidmais_v1_homologacao`.

### Staging já validado operacionalmente

- Web Service `kidmais-manager-staging` funcionando;
- PostgreSQL `kidmais-staging`;
- branch `staging`;
- região Virginia;
- `/api/health` retornou `ok: true`, `status: degraded`, `database: ready`, `festa: ready` e `otp: unavailable`.

Esse `degraded` é esperado enquanto OTP estiver desabilitado no staging.

### Migrations de staging validadas até 018

| Migration | Resultado operacional informado |
| --- | --- |
| 013 | Aprovado |
| 014 | Aprovado com ressalva de postcheck antigo incompatível com schema evoluído |
| 015 | Aprovado |
| 016 | Aprovado |
| 017 | Aprovado |
| 018 | Aprovado |

Na 014, o postcheck antigo esperava um estado intermediário antigo. Houve falso negativo por aumento posterior de tabelas/colunas. As verificações estruturais relevantes foram refeitas em modo somente leitura e passaram.

**Staging já foi validado operacionalmente; production ainda precisa ser preparado, ter as migrations aplicadas conforme o estado do destino e ser validado.** Permanecem todas as cautelas técnicas anteriores sobre histórico, pré-requisitos, prechecks, postchecks, backup e reversão. Não reaplicar migrations por suposição.

### Backup/restore de staging já validados

PITR:

- executado;
- restore criado em banco separado;
- staging original permaneceu intacto;
- restore validado.

No restore:

- 63 tabelas no schema `public`;
- estruturas recentes presentes;
- postchecks 016, 017 e 018 passaram;
- dados básicos recuperados.

Logical Export:

- criado;
- download concluído;
- arquivo guardado fora do Render.

Conclusão operacional informada: **PITR aprovado; restore aprovado; logical export aprovado.** Essas evidências são de staging e não substituem a preparação e validação de backup/restore de production.

### Meta / WhatsApp / Gupshup

- Meta Business Verification: **concluída**.
- WhatsApp/Coexistence: **ainda pendente de suporte da Gupshup**.

Essa pendência **NÃO bloqueia**:

- banco production;
- secrets;
- migrations;
- domínio/HTTPS;
- backup/restore;
- Persistent Disk;
- smoke tests administrativos;
- preparação geral da produção.

Ela bloqueia apenas os fluxos que dependem efetivamente do WhatsApp/OTP. Não inventar tokens, credenciais ou configuração para forçar health `ready`. O GO comercial desses fluxos continua condicionado à liberação e validação da integração. Meta Business Verification concluída não significa WhatsApp pronto.

### Credencial production exposta — rotação concluída

Durante a configuração inicial, o conteúdo completo de `DATABASE_URL` de production apareceu em screenshot. A credencial exposta foi tratada como comprometida e sua rotação foi concluída.

Fatos **confirmados operacionalmente fora desta execução**, informados pelo responsável; não foram verificados diretamente pelos scripts locais:

- `DATABASE_URL` do Web Service production foi atualizada;
- login validado com `session_user` igual a `kidmais_production_app_v2`;
- banco validado como `kidmais_production`;
- banco estava com 0 tabelas antes das migrations;
- não havia conexões ativas usando a credencial antiga;
- a credencial antiga foi revogada/removida;
- a conexão continuou funcionando após a revogação;
- staging não esteve envolvido.

Registro estruturado do mesmo relato para a automação (`PASS_REPORTED`). Não atesta o estado atual do destino nem substitui as demais evidências exigidas para GO:

```production-operational-report
{
  "schemaVersion": 1,
  "environment": "production",
  "gate": "credentialRotation",
  "confirmation": "confirmed-outside-this-execution",
  "database": "kidmais_production",
  "sessionUser": "kidmais_production_app_v2",
  "databaseUrlUpdated": true,
  "loginValidated": true,
  "zeroTablesBeforeMigrations": true,
  "noOldCredentialConnections": true,
  "oldCredentialRevoked": true,
  "connectionAfterRevocation": true,
  "stagingNotInvolved": true
}
```

Nunca registrar o valor da URL ou da senha no handoff.

### Environment Variables versus Secret Files

Estas configurações devem ser **Environment Variables**:

- `ADMIN_AUTH_SECRET`;
- `IDENTIDADE_OTP_PEPPER`;
- `WHATSAPP_CREDENTIAL_ENCRYPTION_KEY`;
- `WHATSAPP_CREDENTIAL_KEY_VERSION`.

**Não usar Secret Files para elas. Secrets de production devem ser diferentes dos de staging.**

### Persistent Disk production

Production ainda precisa de Persistent Disk próprio e separado do staging para `data/disponibilidade.json`.

O inicializador `scripts/init-staging-data.cjs` é exclusivo de staging e **NÃO deve ser usado em production**. Production usa `npm start`.

A inicialização/provisionamento seguro de `data/disponibilidade.json` em production ainda precisa ser concluída.

### Production status

**NO-GO neste momento.**

Razões principais:

- env/secrets ainda precisam ser concluídos/revisados;
- Persistent Disk production ainda precisa ser preparado;
- migrations production ainda não foram validadas/aplicadas;
- domínio/HTTPS ainda não foi concluído;
- smoke tests production ainda não foram concluídos.

WhatsApp/Coexistence não bloqueia essas etapas acima. O GO técnico e o GO comercial dos fluxos dependentes de WhatsApp devem ser avaliados separadamente, sem enfraquecer validações de segurança.

### Próximo passo operacional

1. concluir/revisar Environment Variables e secrets exclusivos de production;
2. preparar Persistent Disk production;
3. preparar e validar migrations production até o estado requerido pela aplicação;
4. configurar domínio e HTTPS;
5. atualizar/validar `ADMIN_AUTH_ORIGIN`;
6. executar smoke tests administrativos;
7. revisar logs;
8. emitir novo GO/NO-GO.

### Regra de economia de contexto

- Usar este handoff como fonte principal de contexto operacional.
- Não reler o repositório inteiro.
- Abrir apenas arquivos relevantes para a tarefa.
- Não repetir auditorias já concluídas sem motivo.
- Distinguir sempre fatos confirmados no código de fatos operacionais informados externamente.

## Referências no repositório

- [Operação, regressão e implantação](../OPERACAO_V1_PRODUCAO.md).
- [Regressão no clone sanitizado](../REGRESSAO-V1-HOMOLOGACAO.md).
- [Blueprint de staging](../render.yaml).
- [Rota de saúde](../app/api/health/route.ts).
- [Regras de prontidão](../lib/saude/status.ts).
- [Configuração de modo OTP](../lib/identidade/configuracao-otp.ts).

Os documentos anteriores contêm contexto histórico. Para o comportamento atual de saúde com OTP desabilitado em staging, este handoff se baseia no código do commit confirmado acima.

---

## Atualização operacional — 2026-09-15

> Esta seção registra o estado mais recente validado de production.
> Em caso de conflito com seções anteriores deste handoff, esta atualização prevalece.
> As seções anteriores devem ser mantidas como histórico operacional.

### Estado atual de production

- Web Service Render: `kidmais-manager-production`.
- PostgreSQL Render: `kidmais-production`.
- Banco: `kidmais_production`.
- Branch de origem: `staging`.
- Commit atualmente validado em production: `115d18a`.
- Auto-Deploy: **Off**.
- URL temporária oficial enquanto o domínio próprio não estiver pronto:
  `https://kidmais-manager-production.onrender.com`.
- `ADMIN_AUTH_ORIGIN` permanece apontando para a URL `onrender.com`.
- Não alterar `ADMIN_AUTH_ORIGIN` para o domínio customizado antes de DNS e HTTPS estarem concluídos.
- O banco local real `kidmais_manager` não deve ser acessado nem alterado.

### Persistent Disk

Persistent Disk de production criado e validado em:

`/opt/render/project/src/data`

O arquivo `disponibilidade.json` foi criado e validado nesse volume.

### Banco e migrations

A cadeia de migrations `001 -> 018` foi aplicada manualmente em production e validada.

Estado final confirmado:

- PostgreSQL 18.
- 63 tabelas públicas.
- 0 índices inválidos.
- 0 constraints não validadas.
- Migration 014 teve o postcheck executado no ponto correto, antes da 015.
- Migration 016 foi aplicada com UTF-8.
- Migration 018 aprovada.
- Postchecks 016, 017 e 018 aprovados.

A divergência estrutural detectada na Migration 016 foi corrigida em production de forma controlada.

Assinatura final validada da estrutura 016:

`d723f81def59be627132230aa6de2e00b0b509d48f20b0e0701afd7eb99650d7`

### Backup lógico e recuperação

Backup lógico de production criado no Persistent Disk:

`/opt/render/project/src/data/kidmais_production_20260915T062511Z.dump`

SHA-256 validado:

`d39ac926a891fae966b5fbec7a322f4e050fdc20c3298e359784e8a3623c8019b`

Validações realizadas:

- `pg_restore --list`: aprovado.
- Restore do dump em banco isolado: aprovado.
- Banco restaurado apresentou 63 tabelas.
- Postchecks 016, 017 e 018 passaram após restore.
- Patch estrutural da 016 foi testado primeiro exclusivamente no restore.

Também foi realizado teste real de Point-in-Time Recovery do Render:

- banco PITR isolado criado a partir de ponto anterior ao patch;
- 63 tabelas recuperadas;
- postchecks 016, 017 e 018 aprovados;
- assinatura antiga da 016 reproduzida:
  `cebbc03827126c2c703ddc024a080a4c392d4a0f1f142ba1cb664061cc3d74608`.

Os bancos temporários utilizados nos testes de restore/PITR foram removidos após a validação.

### Credenciais PostgreSQL

O provisionamento inicial utilizou credenciais temporárias separadas.

Credenciais temporárias de provisionamento foram posteriormente revogadas.

Credencial atual de production:

`kidmais_production_app_v3`

A `DATABASE_URL` do Web Service foi rotacionada para a credencial atual e validada após restart/deploy.

`KIDMAIS_PROVISION_DATABASE_URL` não permanece configurada no Web Service.

### Primeiro administrador de production

O primeiro usuário administrativo foi criado pelo fluxo controlado:

`scripts/admin-provision.cjs bootstrap`

Estado validado:

- exatamente 1 usuário administrativo;
- ativo;
- papel `REPRESENTANTE_AUTORIZADO`;
- criação auditada.

Auditoria do bootstrap confirmada com:

- `ator_tipo = SISTEMA`;
- `acao = ADMIN_BOOTSTRAP`;
- `entidade_tipo = USUARIO_ADMINISTRATIVO`;
- `origem = CLI_PROVISIONAMENTO`.

O login administrativo real em production foi testado com sucesso.

### Política de origem administrativa no Render

Durante o smoke test foi identificado que a política proxy-aware originalmente reconhecia apenas Render staging.

Correção aplicada na branch `staging` e publicada no commit:

`115d18a fix: habilitar origem admin segura no Render production`

A correção:

- mantém confiança em headers encaminhados somente quando `RENDER=true`;
- aceita somente `KIDMAIS_DEPLOY_ENV=staging` ou `production`;
- mantém validação fail-closed;
- mantém HTTPS obrigatório;
- mantém comparação exata de host;
- mantém proteção contra múltiplos valores;
- mantém `Origin` exata nas mutações;
- mantém CSRF e cookies administrativos.

Validações locais do patch:

- testes direcionados: 32/32 PASS;
- `npm run check:v1:static`: 229/229 PASS;
- TypeScript: PASS;
- ESLint: PASS;
- build: PASS;
- `git diff --check`: PASS.

Login real no Render production aprovado após o deploy.

### Smoke tests administrativos

Testes realizados pela URL `onrender.com`.

Aprovados:

- home pública;
- login administrativo;
- sessão administrativa;
- Clientes;
- Contratos;
- Festas;
- Agenda / Disponibilidade;
- Configurações.

Não foram identificados erros 403/500 nas telas administrativas após a correção da política de origem.

### Smoke test de escrita do CRM

Foi criado um cliente sintético exclusivamente para validar escrita em production:

- nome: `CLIENTE TESTE PRODUCAO`;
- observação: `SMOKE TEST PRODUCAO - REMOVER APOS VALIDACAO`;
- ID:
  `a6b4e918-1149-4ab1-8943-89c8b6b8e512`.

Validações aprovadas:

- criação pela interface;
- persistência no PostgreSQL;
- abertura do perfil;
- histórico `CADASTRO_CRIADO`;
- auditoria `CLIENTE_CRIADO`;
- associação ao usuário administrativo.

O registro não possui festa, fechamento ou pagamento vinculado.

O modelo possui FKs `RESTRICT` para preservar histórico e auditoria.
Existe `marcarClienteInativo()` no repository, porém não existe atualmente fluxo oficial de service/API/UI para inativação auditada.

Por esse motivo, **não executar DELETE nem UPDATE manual nesse cliente em production**.
O registro sintético deve permanecer claramente identificado até existir fluxo oficial de arquivamento/inativação.

### Logs e segurança

Após o deploy do commit `115d18a`:

- nenhuma ocorrência recente de `Kidmais Admin Origin`;
- nenhuma ocorrência recente de `ERROR`;
- nenhuma ocorrência recente de `WARN`;
- serviço iniciou normalmente;
- porta Render 10000 detectada;
- nenhum segredo foi identificado nos logs revisados.

Estado de runtime confirmado:

- `NODE_ENV=production`;
- `KIDMAIS_DEPLOY_ENV=production`;
- `RENDER=true`;
- `RENDER_GIT_COMMIT=115d18abc3655c5a6fea9a6724ca3e3013a802b0`.

### Health / WhatsApp

`/api/health` continua retornando:

`{"ok":false,"status":"unavailable"}`

HTTP 503.

Motivo conhecido: integração OTP/WhatsApp ainda não concluída.

Meta Business Verification foi concluída.

WhatsApp / Coexistence permanece pendente da Gupshup.

Essa pendência não bloqueia a operação administrativa já validada, mas bloqueia a liberação completa dos fluxos externos que dependem de OTP/WhatsApp.

### Domínio customizado

Domínio pretendido:

`manager.kidmaisfestas.com`

DNS de `kidmaisfestas.com` utiliza Terra:

- `NS2.TERRAEMPRESAS.COM.BR`
- `NS3.TERRAEMPRESAS.COM.BR`

Registrador: Tucows.

Aguardando acesso administrativo ao Terra para configuração do DNS.

Até DNS e HTTPS estarem confirmados, continuar utilizando a URL `onrender.com`.

### GO / NO-GO atualizado

**GO técnico para a V1 administrativa em production.**

Estão aprovados:

- banco;
- migrations;
- backup lógico;
- restore;
- PITR;
- autenticação administrativa;
- navegação administrativa;
- leitura e escrita básica do CRM;
- auditoria;
- política de origem segura no Render;
- logs principais;
- rotação de credenciais.

**NO-GO para liberação comercial completa dos fluxos externos dependentes de WhatsApp/OTP** enquanto a integração Gupshup não estiver operacional.

O domínio próprio é pendência de lançamento, mas não bloqueia homologação/operação interna pela URL `onrender.com`.

### Próximos passos

1. concluir WhatsApp/OTP com a Gupshup;
2. repetir `/api/health` até obter estado saudável;
3. configurar `manager.kidmaisfestas.com` no DNS Terra;
4. aguardar e validar HTTPS do domínio customizado;
5. somente depois trocar `ADMIN_AUTH_ORIGIN` para o domínio definitivo;
6. repetir smoke tests administrativos no domínio definitivo;
7. validar os fluxos externos que dependem de OTP;
8. emitir GO/NO-GO comercial final.