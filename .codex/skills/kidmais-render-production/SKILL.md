---
name: kidmais-render-production
description: Preparar e avaliar staging/production do Kidmais Manager no Render usando verificadores seguros e evidências operacionais. Use para prontidão e GO/NO-GO, sem desenvolver funcionalidades.
---

# Kidmais Render Production

## Contexto e ordem padrão

1. Confirmar workspace `D:\glass\KidMais Manager\kidmais-manager-github`, `git branch --show-current`, `git log -1 --oneline`, `git status`. A base esperada desta preparação é `staging`; divergências da base solicitada exigem parar e informar. Confirmar `docs/HANDOFF_V1_PRODUCAO.md`, `render.yaml`, migrations 017/018 e `app/api/health/route.ts` presentes.
2. Ler primeiro [handoff](../../../docs/HANDOFF_V1_PRODUCAO.md), fonte principal operacional. Não reler o projeto inteiro. Abrir somente arquivos necessários para divergências ou bloqueios.
3. Executar `node scripts/production/check-env.cjs --json` com ambiente injetado de forma segura.
4. Executar `node scripts/production/check-database-target.cjs --json` (sem conexão).
5. Executar `node scripts/production/check-migrations.cjs --json` (sem conexão).
6. Quando houver URL e autorização de leitura remota no escopo, executar `node scripts/production/smoke-test.cjs --base-url=https://servico.example --json`, substituindo apenas a URL pública. Sem URL, registrar smoke não verificado.
7. Executar `npm run --silent production:check:json`, acrescentando URL/evidência apenas quando disponíveis e autorizadas. O agregado repete somente os checks baratos; não relê o repositório. Consultar [contrato dos scripts](../../../scripts/production/README.md) para flags e formato da atestação.
8. Recomendar a próxima ação concreta a partir dos bloqueadores, distinguindo preparação técnica e operação comercial WhatsApp.
9. Encerrar sempre com GO, GO-PARCIAL ou NO-GO, escopo avaliado, evidências, bloqueadores e pendências. Parar antes de qualquer mudança de risco.

## Segurança e limites de autorização

- Nunca acessar, consultar ou alterar `kidmais_manager`, inclusive como origem de teste/restore. Nunca usar `kidmais_staging`, `kidmais-staging` ou o banco local como production; production exige `kidmais_production` remoto.
- Não carregar `.env.local`, ler secrets para contexto nem imprimir valores. Os scripts recebem env já injetado; não colocar secrets em comandos, screenshots, relatórios ou commits. Nunca reutilizar secrets entre staging e production. Presença de variável não comprova exclusividade ou rotação.
- Nenhum script altera Render, secrets ou banco. `--connect`/`--inspect-db` são leituras opcionais: somente quando o escopo permitir acesso ao destino, após validação de alvo. Nunca usá-las quando a tarefa proibir acesso a qualquer banco. Não executam migrations nem postchecks arbitrários.
- Exigir aprovação humana explícita antes de migrations/escrita em production, revogação de credenciais, alteração de DATABASE_URL/secrets, DNS/domínio, exclusão/restore de banco, Persistent Disk, liberação de tráfego, mudança de branch/commit de production ou qualquer alteração de infraestrutura. Preparar antes um plano revisável com alvo, efeito, pré-condições e recuperação. Um resultado GO não é autorização de mudança.
- A credencial production exposta relatada no handoff exige rotação confirmada antes do GO. Não presumir que foi rotacionada; não procurar seu valor. Production usa `npm start`; o inicializador de staging não deve ser usado em production.

## Interpretação

- Separar sempre **confirmado no código**, **informado externamente** e **verificado pelo script**. Atestação operacional é relato revisado, não verificação independente. Não preencher atestações automaticamente a partir do handoff ou de inferências.
- Inventário até 018 não comprova aplicação. Estado incerto de migrations implica NO-GO de operação. O postcheck antigo da 014 pode dar falso negativo em schema evoluído; não concluir corrupção nem reaplicar migration por suposição.
- Staging pode ter HTTP 200, `ok=true`, `status=degraded`, database/festa ready e OTP unavailable quando explicitamente desabilitado. HTTP 503 real continua bloqueio do smoke; a rota atual pode omitir componentes e não permite inferir a causa.
- GO técnico cobre preparação/fluxos administrativos independentes de WhatsApp, condicionado às verificações e evidências requeridas. GO comercial WhatsApp exige integração e recebimento controlado validados, além de health compatível. Health ready sozinho não basta.
- WhatsApp/Coexistence pendente não impede preparar banco, secrets, migrations, HTTPS, disco, backup/restore e smoke administrativo, respeitando aprovações. Reportar a pendência separadamente. Nunca inventar tokens/configuração para forçar ready.
- GO-PARCIAL significa critérios técnicos completos e integração pendente, com escopo liberado/bloqueado explícito. Banco errado, segredo crítico ausente, ambientes misturados, database/festa indisponíveis, inconsistência estrutural, migration incerta ou segurança crítica implicam NO-GO. Não confundir GO para commit da automação com GO para production.

## Exemplo de invocação

“Use $kidmais-render-production para avaliar a preparação de production. Leia o handoff, execute apenas checks locais com ambiente sintético fornecido, sem acessar Render/bancos/URLs reais, sem alterar infraestrutura e sem commit. Termine com GO/NO-GO para as mudanças de automação.”
