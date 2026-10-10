# Homologação em staging — financeiro por plano e cotação por empresa (pacote de 10/10/2026)

**Status: PRONTO PARA APROVAÇÃO, NÃO EXECUTADO.** Nada aqui autoriza deploy, mudança de env, SQL ou chamadas ao Asaas. Cada operação O1–O5 precisa de aprovação explícita de Felipe para o alvo indicado ([OPERACAO_AGENTES.md](OPERACAO_AGENTES.md)).

## Candidata

Branch `staging`, commit da cotação por empresa (SHA informado no pedido de aprovação; é o `HEAD` de `origin/staging` no momento de O1). Contém:

1. **Financeiro completo por plano** (`a17e6d6`): Essencial recusado no servidor; Profissional, Premium, teste e isenta liberados; Pix e contas a receber em todos.
2. **Cotação pública por empresa**: `/b/<empresas.codigo>/fechamento` e `/disponibilidade`; APIs com `?empresa=<código>`; chave `COTACAO_PUBLICA_POR_EMPRESA` (desligada por padrão); plano `ORCAMENTO_ONLINE` (Profissional/Premium; teste, legado e isentas liberados); situação comercial; agenda por empresa (062).
3. **Isolamento da cotação**:
   - Marca: no endereço de outra empresa, cabeçalho com o nome da empresa (sem logo), redação neutra (“o buffet”), sem contatos, PDF, capacidade, processador de cartão ou ajustes legados da Kidmais; título/descrição neutros e `noindex`. Endereço atual da Kidmais idêntico.
   - CPF: no endereço por empresa, CPF já usado em qualquer cadastro (desta ou de outra empresa) não bloqueia nem muda a resposta; o cliente novo é criado sem CPF com nota interna neutra (“confirme com o cliente”), a duplicidade na própria empresa vai para a revisão do CRM e a resposta pública não traz dados do cadastro. Só cadastro novo nesse endereço (identidade/OTP ainda não é por empresa). Sem mudança de schema; o índice global `clientes_cpf_canonico_uk` continua.
   - Limite de requisições (todas as APIs públicas de cotação/agenda, inclusive o endereço atual): leitura 120/min por origem; pedido 10/h por origem e 60/h por endereço de empresa; 429 com `Retry-After`. Janela em memória por instância (web com 1 instância); origem = último `X-Forwarded-For` no Render.
   - Unidade: escopo V1 de **uma unidade**. Zero unidade = agenda da empresa; uma = ela; mais de uma = 404 em todas as rotas por empresa. Nenhuma unidade é escolhida automaticamente.

## Alvo exato

| Item | Valor |
|---|---|
| Workspace Render | `tea-daidbj95efls73d2bcf0` |
| Web staging | `kidmais-manager-staging` `srv-daif418ae00c73e8k2gg`, branch `staging`, auto-deploy OFF (revalidar antes de O1) |
| Cron staging | `crn-db493i142hec73ahmoe0` — não alterado nem reimplantado |
| Banco | `dpg-daidko3m8hqs73ce4jt0-a` / `kidmais_staging_1z91`, TLS |
| Asaas | `sandbox` |
| Produção | não tocada |

## Executor

`scripts/homologacao-planos-cotacao-staging.cjs` (testes offline: `scripts/homologacao-planos-cotacao-staging.test.cjs`).

- Guardas: as do ensaio de 09/10 (`RENDER=true`, `RENDER_SERVICE_ID=srv-daif418ae00c73e8k2gg`, `KIDMAIS_DEPLOY_ENV=staging`, `ASAAS_AMBIENTE=sandbox`, `ASSINATURA_PLANOS_ATIVOS=true`, host/banco/porta, sem `ssl*` na URL) + `COTACAO_PUBLICA_POR_EMPRESA=true`, `current_database()='kidmais_staging_1z91'` e `pg_stat_ssl.ssl=true`.
- Só roda com a flag única `--rodada-1-autorizada`; sem ela imprime `AGUARDANDO_AUTORIZACAO_O3` e sai. Recusa se o arquivo de estado `/opt/render/project/src/data/homologacao-planos-cotacao-20261010/rodada.json` já existir (sem repetição cega).
- Escreve apenas: `empresas`, `usuarios_administrativos`, `memberships`, `financeiro_categorias`, `empresa_assinaturas`, `assinatura_isencoes`, `pacotes` (+ faixas/disponibilidade pelos serviços de domínio) das quatro fixtures; contratações/pagamentos sandbox de F1/F2 pelo checkout real; contas a pagar e fechamentos sintéticos pelas APIs da própria fixture. Nunca `DELETE`, `TRUNCATE`, `DROP` ou `ALTER` (teste estático).
- Senhas aleatórias só em memória; saída e arquivo de estado sem linhas de banco, CPF, e-mail, token ou senha (só status, códigos e hashes).
- `finally`: remove assinaturas sandbox das fixtures, remove o webhook somente se criado pela rodada, desativa usuários, revoga memberships e marca as empresas `DESATIVADA`. Nada é apagado.

### Fixtures (IDs reservados; nunca reutilizar)

| Fixture | Empresa | Usuário (Gestão) | `codigo` | Estado comercial |
|---|---|---|---|---|
| F1 Essencial | `878a2c39-19e5-4d2a-82a7-223b893352c9` | `11e5006f-68d0-4182-9b12-da048b3f7db8` | `hml-planos-essencial` | contrato Essencial confirmado (checkout + confirmação sandbox) |
| F2 Profissional | `d1787a4c-aaeb-4eb6-99a1-9659feb3902f` | `4aa233ad-6c4f-41bb-ae7f-62996c1b5018` | `hml-planos-profissional` | contrato Profissional confirmado |
| F3 Isenta | `6dfd58f1-91fa-4202-9ace-72d705390272` | `7ff5a408-d1da-4813-99a9-0ebd1cf7511e` | `hml-planos-isenta` | `assinatura_isencoes` (CNPJ sintético ≠ Kidmais) |
| F4 Teste | `092c5201-91c1-446e-90e8-cea19831e749` | `9029758e-317b-4c4e-95c6-685ac990a956` | `hml-planos-teste` | teste de 15 dias vigente |

E-mails `hml-planos-<8 hex>@example.invalid`; nome `TESTE Kidmais — planos/cotação staging 20261010 Fn`; catálogo `POCKET` (20–30 convidados, R$ 1.500) em F1, F2 e F4; categoria de despesa “Homologação” em todas.

## Matriz de aceite (verificada pelo executor; qualquer divergência = parada S2)

| Financeiro (sessão da fixture) | F1 | F2 | F3 | F4 |
|---|---|---|---|---|
| `GET /api/admin/financeiro/contas-pagar` | 403 | 200 | 200 | 200 |
| `POST …/contas-pagar` criar (conta sintética R$ 10) | 403 `RECURSO_FORA_DO_PLANO`, 0 gravadas | 200, 1 gravada | 200, 1 | 200, 1 |
| `…/fluxo-caixa`, `…/relatorios` | 403 | 200 | 200 | 200 |
| `financeiroCompleto` em `/api/admin/financeiro`, `/api/admin/dashboard` e `recursos` de `/api/admin/autenticacao` | `false` | `true` | `true` | `true` |
| `…/contas-receber` | 200 | 200 | 200 | 200 |
| Sessão F1 pedindo `?empresaId=<F2>` | ≠ 200 e sem dado de F2 | | | |

| Cotação (sem sessão) | Esperado |
|---|---|
| `/b/hml-planos-profissional/fechamento` e `/disponibilidade` | 200 |
| `pacotes?empresa=hml-planos-profissional` | 200, só `POCKET` de F2 |
| `pacotes?empresa=hml-planos-teste` | 200 |
| `pacotes?empresa=hml-planos-essencial`, `hml-inexistente`, `HML_RUIM`; `/b/hml-planos-essencial/fechamento` | 404 `COTACAO_PUBLICA_INDISPONIVEL` idêntico |
| `tabela-pacotes?empresa=…` | 404 |
| `disponibilidade?inicio&fim&empresa=hml-planos-profissional` | `comercial` vazio |
| `POST cotacao?empresa=hml-planos-profissional` | 200 |
| `POST /api/fechamentos?empresa=hml-planos-profissional`, cadastro novo, CPF sintético | 201, fechamento com `empresa_id` = F2, resposta sem `crm` |
| Mesmo POST com o **mesmo CPF** em `hml-planos-teste` | 201, mesmas chaves de resposta; cliente de F4 sem CPF |
| POST com `CLIENTE_EXISTENTE` | 409 `IDENTIDADE_NAO_DISPONIVEL` |
| Endereço atual da Kidmais (`/api/fechamentos/pacotes`, `/api/disponibilidade` do próximo mês) | projeção idêntica antes/depois |
| Hash de `empresas`, `memberships`, `empresa_assinaturas` (sem colunas do cron), `assinatura_*`, `clientes`, `fechamentos`, `pacotes`, `financeiro_categorias`, `financeiro_contas_pagar` **fora das fixtures** | idêntico antes/depois (S3) |

## Operações para aprovação (O1–O5)

| # | Operação exata | Efeito | Duração/custo |
|---|---|---|---|
| O1 | Render MCP `update_environment_variables` no `srv-daif418ae00c73e8k2gg` (workspace acima, modo **merge**, sem `replace`): `COTACAO_PUBLICA_POR_EMPRESA=true`, `ASSINATURA_PLANOS_ATIVOS=true`. Nenhuma outra variável. | só grava a configuração; passa a valer no próximo deploy | segundos |
| O2 | Revalidar branch/auto-deploy; conferir `origin/staging` = SHA aprovado; Render MCP `trigger_deploy` no `srv-daif418ae00c73e8k2gg` (sem limpar cache). Acompanhar build (`check:v1:static` + build) e `/api/health`. | web staging reinicia com a candidata e as duas chaves; cron intocado | ~6 min; plano starter |
| O3 | Web Shell do `srv-daif418ae00c73e8k2gg`: `cd /opt/render/project/src && mkdir -p data/homologacao-planos-cotacao-20261010 && nohup node --experimental-strip-types scripts/homologacao-planos-cotacao-staging.cjs --rodada-1-autorizada > data/homologacao-planos-cotacao-20261010/saida.log 2>&1 < /dev/null &` (registrar PID; não reiniciar nem redeployar durante a execução) | fixtures, catálogo, 2 checkouts e 2 confirmações sandbox, matriz, encerramento | ~20–30 min; Shell cobrado por duração |
| O4 | Leitura do resultado: `cat data/homologacao-planos-cotacao-20261010/saida.log` (só status, códigos e hashes), conferência de `rodada.json` e registro sanitizado em `docs/evidencias/` | nenhum | minutos |
| O5 | Encerramento de configuração: Render MCP `update_environment_variables` (merge) `COTACAO_PUBLICA_POR_EMPRESA=false` e `ASSINATURA_PLANOS_ATIVOS=false` (ou remoção pelo painel, “Save only”), seguido de `trigger_deploy` do mesmo SHA para valer em runtime; conferir `/b/hml-planos-profissional/fechamento` = 404 e checkout desabilitado | staging volta ao comportamento sem as chaves; fixtures já desativadas por O3 | ~6 min |

Se O3 parar (S1–S5), o `finally` encerra as fixtures; O5 continua obrigatória. Nova rodada exige novos IDs e nova aprovação.

## Critérios de parada

- S1 alvo/banco/TLS/schema divergente, fixture/e-mail/código/cliente Asaas já existente, ou arquivo de estado presente.
- S2 qualquer item da matriz divergente (inclusive vazamento entre empresas).
- S3 hash de dados fora das fixtures ou projeção pública da Kidmais diferente.
- S4 oferta com Fundador ou aguardando vaga (nunca consumir vaga Fundador), cobrança sandbox divergente, callback não processado em 3 min.
- S5 build/health com falha em O2 ou O5.

Risco conhecido de S3 falso: uso simultâneo do staging por pessoas ou mudança natural de situação comercial de outra empresa durante a rodada. Nesse caso a rodada encerra e o resultado fica inconclusivo; não repetir sem nova aprovação.

## Recuperação

- Código: `git revert` do commit da cotação em `staging` + deploy autorizado; sem migration.
- Configuração: O5 (chaves `false`/removidas + deploy).
- Dados: fixtures desativadas, nunca apagadas; assinaturas sandbox removidas; Kidmais e demais empresas não são escritas.

## Evidências locais desta preparação

- Executor: 6/6 testes offline (guardas recusam produção, banco local, `sslmode` na URL e chaves ausentes; sem flag não executa; escrita só das fixtures; encerramento no `finally`). Importações dinâmicas do executor conferidas.
- Isolamento: cotação 11/11 (inclui escopo de uma unidade), CPF 6/6, marca 5/5, limite 3/3.
- Testes de navegador/script que já falhavam: [comparação base `a17e6d6` × candidata](evidencias/testes-navegador-base-vs-candidata-20261010.txt) — mesmos 7 testes, mesmo resultado e causa nos dois (falta `playwright`, parâmetro de clone manual ou servidor).

## Limitações (bloqueiam liberação comercial, não esta homologação)

- Cliente existente no endereço por empresa (identidade/OTP por empresa) e índice de CPF por empresa: próximo passo de schema (PR-B2), com migration própria e autorização.
- Descontos Pix (10%/3%), opção “cartão Cielo” e selo -15% em dias úteis aparecem fixos no assistente; falta conferir se o cálculo do servidor os aplica a todas as empresas e torná-los condição comercial de cada empresa antes da venda.
- Nome exibido = `empresas.nome`; usar o nome comercial aplicado do perfil fica para depois. O favicon do navegador é o da instalação.
- Escolha pública de unidade inexistente (empresas com mais de uma unidade ficam fora).
- Limite de requisições por instância (revisar se o web passar a ter mais de uma).
- Horário nobre por plano aguardando decisão.
