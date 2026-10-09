# Renovação Fundador — implementação local e homologação proposta

Atualização de 09/10/2026: preparado e validado localmente um [diagnóstico remoto de configuração/schema](RENOVACAO_PREFLIGHT_STAGING_20261009.md). Ainda aguarda autorização operacional; não habilita aplicação da renovação ou envio real. A quinta rodada de contratação/cancelamento foi aprovada conforme [evidência própria](ENSAIO_ASSINATURA_RODADA5_20261009.md).

Decisão de Felipe em 09/10/2026: após 12 meses, renovar pelo preço normal, avisando **30 dias antes por e-mail e no sistema**. Este documento descreve código local; não declara rotina agendada, banco migrado, envio real ou cobrança em produção.

## Comportamento implementado

- A contratação confirmada conserva preço regular, desconto, ciclo e benefício. A rotina registra uma renovação por contratação, com mensagem e destinatário imutáveis. O e-mail vai à pessoa da Gestão que contratou, desde que ainda tenha vínculo Gestão ativo e mantenha o endereço; mudança de responsável/endereço exige revisão, evitando envio a ex-integrantes. A tela da assinatura mostra o aviso à Gestão atual sem expor o endereço ou erros internos.
- A primeira data de preço normal é calculada pelas datas de vencimento. No mensal, é o primeiro vencimento no fim ou depois da vigência Fundador; no anual, é a renovação do primeiro ano, sem conceder outro ano com desconto por atraso na primeira confirmação. Datas de fim de mês mantêm o dia âncora. Os 30 dias de aviso são dias de calendário em `America/Sao_Paulo`.
- No dia do aviso, grava-se `AVISANDO` antes do envio. Uma resposta aceita pelo provedor, com identificador externo, permite registrar `AVISADA`. Isso comprova aceitação pelo provedor, **não recebimento/leitura na caixa postal**. A chave e o conteúdo são reutilizados em retries. Após 23 horas ou perda do prazo de antecedência, não há repetição cega; passa a revisão.
- Depois do aviso confirmado, a rotina aguarda até que a próxima parcela ainda não gerada já pertença à renovação. Atualiza o valor da assinatura com `updatePendingPayments: false`; parcelas já geradas são reconsultadas individualmente e só as da renovação, ainda pendentes/vencidas, podem ser corrigidas. Parcelas antigas, pagas ou com identificação divergente não são reprecificadas.
- Intenção `APLICANDO` é persistida antes dos PUTs. Resposta perdida é recuperada pela releitura do estado do provedor; não se cria outra assinatura ou cobrança. Nova leitura de assinatura e parcelas confirma `REGULAR`. O processamento seguinte também confere a consistência das parcelas futuras.
- Isenção, suspensão administrativa e cancelamento impedem novo processamento. Nenhuma operação envia `status: ACTIVE`, encurta o período já pago ou apaga cobrança. Se uma falha deixa a renovação em revisão e as próximas parcelas já seriam posteriores ao benefício, pode-se suspender a geração (`INACTIVE`) para não perpetuar o desconto nem aplicar aumento sem aviso. Faturas existentes permanecem e precisam de revisão; não há cobrança automática da diferença. Casos de revisão continuam visíveis mesmo após essa suspensão.

Arquivos principais: `lib/assinatura/renovacao-fundador.ts` (processamento), `renovacao-repositorio.ts` (persistência/consulta), `asaas.ts` (consultas e PUTs), `lib/acessos/email.ts` (idempotência), `scripts/assinatura-renovar.cjs` (execução explícita), componentes da tela de assinatura e migration 075 com precheck/postcheck/rollback.

## Execução e limites

A rotina não é chamada dentro do webhook: seus commits de intenção precisam preceder a rede. O executável separado usa a mesma trava por empresa da contratação e transações curtas. Sem argumentos, abre transações `READ ONLY` e simula sem gravar registro, enviar mensagem, mudar preço ou suspender recorrência. O reconciliador antigo também bloqueia as novas mutações na simulação.

Comando preparado, **não executado**:

```powershell
node --experimental-strip-types scripts/assinatura-renovar.cjs
# Somente depois de autorização explícita para o alvo:
node --experimental-strip-types scripts/assinatura-renovar.cjs --aplicar
```

Configuração: `KIDMAIS_RECONCILIAR_DATABASE_URL` e `KIDMAIS_RECONCILIAR_ALVO` confirmam explicitamente banco/host/porta; `DATABASE_URL` e `.env.local` nunca são usados pelo script. As credenciais Asaas precisam ser de sandbox. Nesta entrega, `--aplicar` exige banco local e `EMAIL_PROVIDER=arquivo`, com diretório absoluto e ambiente local de teste. O adaptador Resend possui testes com fetch falso, mas o executável não permite envio real. Nenhum segredo foi criado ou lido.

O processamento precisa rodar periodicamente antes da primeira janela de aviso; proposta para futura operação: execução horária, alerta sobre qualquer retorno de erro/revisão e acompanhamento de avisos aceitos, bounces e preço confirmado. **Nenhum cron, automação Codex ou serviço Render foi criado.** A ativação exige homologação e autorização separadas. Falha de banco/provedor não é encoberta: retorna erro reprocessável e mantém a intenção anterior. Monitorar o código de saída e contadores do executável; eles não incluem dados pessoais.

## Migration 075 preparada

`database/migrations/20261009_075_renovacao_fundador.sql` cria `assinatura_renovacoes`, FK composta por empresa/contratação, unicidade por contratação, prazo de 30 dias, estados e guardas de histórico. Mensagem, destinatário, datas e identificadores de envio são imutáveis; atualizações exigem transições válidas. Constraints exigem aviso no prazo antes de registrar preço aplicado. O rollback recusa qualquer linha existente e deve preceder o rollback 074; não usa `CASCADE`.

Precheck e postcheck estão em `database/checks/20261009_075_*.sql`; rollback em `database/rollback/20261009_075_renovacao_fundador_down.sql`. Executados no PostgreSQL sintético descrito abaixo; não aplicados em staging/produção. Revalidar numeração 074/075 antes de integrar branches.

## Plano de homologação PostgreSQL — autorizado e executado parcialmente em 09/10/2026

Alvo autorizado: cluster PostgreSQL 18.6 **novo e descartável**, em `D:/glass/KidMais Manager/kidmais-manager-site-venda-20261008/.local-renovacao-pg075`, escutando apenas `127.0.0.1:55475`; banco `kidmais_renovacao_075_sintetica`, usuário `kidmais_renovacao_075`. Diretório e porta estavam livres antes da criação. O cluster foi iniciado e parado ao concluir os testes; seus arquivos sintéticos permanecem ignorados pelo Git.

Escopo autorizado pela resposta “próximo passo” à proposta concreta: inicializar/iniciar esse cluster, criar somente o banco descartável, aplicar schema de base sintético e migrations necessárias, executar prechecks/074/075/postchecks, inserts/updates sintéticos dos testes e rollbacks, e parar esse cluster ao fim. Sem restauração, dump, cópia ou leitura de dados de bancos existentes. Nenhuma conexão a `kidmais_manager`, staging ou produção. Provedor e e-mail permaneceram mocks, sem chamadas externas.

Plano original de ensaios (a cobertura efetivamente executada está discriminada abaixo):

1. Identidade do cluster/banco/porta/usuário antes de qualquer escrita; base somente sintética.
2. 074 e 075 up/down vazios, reaplicação recusada e rollback 075 recusado com histórico. Legado UNICO intacto.
3. Contrato e vaga confirmados atomicamente, FKs diferidas, 20 vagas sob disputa simultânea, idempotência de checkout e isolamento por empresa.
4. Repository real: criação de renovação, mensagem congelada, transições e evidências, tentativa de avisar fora do prazo rejeitada, proibição de alterar destinatário/preço histórico ou apagar registro.
5. Duas execuções concorrentes da renovação; falha entre commit de intenção e envio/PUT; envio/price response perdida; retomada pela reconsulta com provedor falso.
6. Cancelamento e suspensão concorrentes; isenção; Gestão revogada; virada de dia, fim de mês e ano bissexto; parcelas anteriores, já pagas e da renovação.
7. Simulação sem quaisquer writes SQL/externos; nenhuma concessão a CNPJ autodeclarado; postchecks finais e parada do cluster.

### Resultado do ensaio isolado

O script `scripts/assinatura-074-075-homologacao.cjs` confirma banco, usuário, endereço, porta e nome do cluster antes das transações. Não lê `.env`/`DATABASE_URL` e bloqueia `fetch`. O modo `--preparar` recusa banco existente; `--continuar-preparo` serviu para retomar a base 067/068 após falha transacional da 074, sem apagar dados. `--testar` deixa fixtures persistidas e deve ser executado uma vez após o preparo, não repetido sobre o resultado final.

**Erro encontrado e corrigido:** os CHECKs explícitos de evidências da 074 colidiam com os nomes implícitos dos CHECKs da coluna `estado`. Renomeados para `assinatura_fundadores_evidencias_check` e `assinatura_contratacoes_evidencias_check`. A aplicação antes da correção falhou; depois, up/down/reaplicação e pre/postchecks passaram, preservando literalmente a assinatura legada sintética.

**Seis grupos PostgreSQL aprovados:**

1. Oferta idempotente, snapshot financeiro imutável, recusa de plano sem pagamento e bloqueio de contratação para empresa isenta.
2. Duas transações disputando a última de 20 vagas: uma reserva aceita, outra aguarda; teto preservado.
3. Confirmação atômica de contrato/Fundador/assinatura e reentrega idempotente, com a FK diferida ativa.
4. Repository real, intenção de envio já commitada antes do mock de e-mail, duas execuções concorrentes, somente um envio e uma atualização de preço, retomada e DTO do aviso.
5. Imutabilidade de mensagem/evidências e recusa de DELETE/TRUNCATE e de rollbacks com histórico. O TRUNCATE de contratações foi recusado pela FK; o de renovações, pelo trigger.
6. Simulação sem alteração dos registros, envio ou mudança de preço, seguida dos postchecks finais.

**Limites:** dependências de empresas, usuários, memberships, cadastro e auditoria são tabelas mínimas sintéticas; migrations 067/068/074/075 são os arquivos reais. Isso não valida o schema completo da aplicação. O registro de renovação foi criado explicitamente com vencimento regular em hoje + 30 dias para testar o relógio real sem adulterar triggers; cálculo dos 12 meses permanece coberto pelos unitários. Falhas de rede/resposta perdida, cancelamento simultâneo, revogação da Gestão e calendários extremos ainda não foram repetidos com este repository PostgreSQL; estão nos testes sintéticos conforme sua cobertura, e permanecem na matriz de homologação ampliada. Não houve homologação HTTP Asaas/Resend.

Validação após correção: **99/99 testes unitários de assinatura**, ESLint do harness e TypeScript aprovados. A primeira seleção por wildcard incluiu testes PostgreSQL antigos e foi recusada pelo opt-in obrigatório antes de conectar; repetida com exclusão explícita de `*.postgres.test.ts`. Build não repetido nesta etapa de SQL/harness/documentação; o build anterior aprovado permanece a evidência da aplicação. Logs locais: `homologacao-075-preparo.log`, `homologacao-075-fluxos.log`, `homologacao-075-unit.log`. Cluster encerrado com `pg_ctl ... -m fast -w stop`, retornando `server stopped`.

## Fontes oficiais consultadas em 09/10/2026

- [Asaas — atualizar assinatura](https://docs.asaas.com/reference/atualizar-assinatura-existente): mudanças afetam próximas cobranças por padrão, pendentes exigem opção própria; `INACTIVE` suspende geração, sem apagar cobranças existentes.
- [Asaas — atualizar cobrança](https://docs.asaas.com/reference/atualizar-cobranca-existente): PUT com valor, vencimento e forma; restrições para cobranças já processadas. Alterações podem gerar notificações conforme configuração do cliente.
- [Asaas — assinatura com cartão](https://docs.asaas.com/docs/criando-assinatura-com-cartao-de-credito): alteração de valor exige tokenização habilitada. Cartão e formas de pagamento precisam de homologação sandbox; erros do provedor permanecem reprocessáveis/revisáveis.
- [Resend — idempotência](https://resend.com/docs/dashboard/emails/idempotency-keys): chave no header, retenção de 24 horas. O limite local de retry é 23 horas; não promete exatamente uma entrega após essa janela.

## Validação local

99 testes sintéticos de assinatura aprovados, incluindo 21 novos de renovação/adaptadores. Testes cobrem precedência do aviso, snapshots, retomada após falha, parcela antiga, pagamento concorrente, isenção, cancelamento, simulação, idempotência de e-mail em arquivo e request HTTP mockado. ESLint dos arquivos alterados sem erros/avisos.

Regressão ampla: **2.150 testes + 103 do harness aprovados**, TypeScript aprovado e lint sem erros (um aviso preexistente em `lib/inteligencia/skills/catalogo.ts`). O build do check amplo encontrou o bloqueio conhecido do compilador pelo sandbox do Windows; repetido fora desse bloqueio, **build aprovado**, inclusive TypeScript e verificação do worker PDF no asset gerado. `git diff --check` sem erros. Logs locais: `renovacao-unit.log`, `renovacao-static.log`, `renovacao-lint.log`, `renovacao-build.log`. Node local 24.20.0, diferente do 22.23.2 declarado pelo projeto; repetir na versão declarada na homologação.

Atualização posterior: [instalação do schema completo](HOMOLOGACAO_SCHEMA_COMPLETO_20261009.md) aprovada em banco sintético separado, com 76 migrations e checks e rollback/reaplicação 074/075. Os testes funcionais deste documento continuam sendo os da base reduzida. Ainda não publicado, não agendado e não homologado com provedores externos. Limites de recursos/usuários por plano e vínculo da isenção real da Kidmais são etapas separadas.
