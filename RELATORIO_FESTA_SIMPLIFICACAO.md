# Festa — simplificação para preparação e registros posteriores

Validação concluída em 11/09/2026. Implementação e testes executados somente em clones. Nenhuma aplicação da 016 no banco real. Aguardando aprovação para o próximo passo.

## 1. Estruturas removidas da Migration 016

- `festas.status` e sua máquina de estados; comandos de preparação, montagem, início, encerramento, conclusão, reabertura e autorização de transição.
- `festas.contagem_final_id`, FK correspondente e confirmação de contagem final.
- `festas.versao_contratual_revisada_id`, FK correspondente e comando `revisar_vigencia`.
- Etapas de transição em tarefas e pendências. O agrupamento agora é `categoria`, com `ANTES`/`DEPOIS`.
- `EM_ANDAMENTO` de tarefa. Estados finais: `PENDENTE`, `CONCLUIDA`, `NAO_SE_APLICA`.
- Decisão/aprovação e execução da solicitação: `decisao_operacional`, `decisor_id`, `decidido_em`, `motivo_decisao`, `estado_execucao`, com seus checks dependentes.
- Capacidades ligadas a encerramento, conclusão, exceções, reabertura, confirmação final e decisão de solicitação.

Foram removidas também as dependências correspondentes do serviço, validação de entrada, interface e testes. Não foi criada Migration 017.

## 2. Estruturas mantidas

As nove tabelas continuam: `festas`, `festa_areas`, `festa_usuario_capacidades`, `festa_tarefas`, `festa_pendencias`, `festa_ocorrencias`, `festa_contagens_convidados`, `festa_solicitacoes` e `festa_eventos`.

Permanecem criação explícita e idempotente, auditoria genérica atômica com eventos de Festa, controle de concorrência, vínculo contratual, áreas opcionais sem seed, pendências de cliente/equipe e fatos com autor e contexto contratual. Eventos e contagens continuam append-only. A unicidade de `corrige_contagem_id` impede ramificações concorrentes; uma nova correção deve apontar para a última correção da cadeia.

Invalidação permanece lógica, com motivo, autor e data: oculta a Festa, preserva o contrato e permite uma nova Festa pela unicidade parcial por contratação. Atividade já registrada impede a remoção por engano. Hora extra e adicional agora são registros de fatos; não são pedidos pendentes de execução e também contam como atividade registrada.

Cancelamento continua formalizado no serviço contratual, com motivo e auditoria, sem movimentos financeiros automáticos. A data passada, isoladamente, não impede cancelamento. Contagem válida positiva ou registro não cancelado de hora extra/adicional impede cancelamento por representar evidência incompatível. Correções de registros equivocados exigem Gestão, motivo e preservam o histórico.

Buffet permanece uma área de escolhas/pendências. Não foram implementados buffet estruturado, produção persistida, fórmulas ou regras comerciais.

## 3. Capacidades finais

| Perfil | Capacidades |
|---|---|
| Gestão | `FESTA_CONSULTAR`, `FESTA_CRIAR`, `FESTA_OPERAR`, `FESTA_CORRIGIR`, `FESTA_CONFIGURAR_AREAS` |
| Equipe | `FESTA_CONSULTAR`, `FESTA_OPERAR` |

Nenhum papel global novo. O representante autorizado administra os acessos com autenticação e auditoria. Não recebe capacidades operacionais automaticamente; alterar o próprio acesso exige confirmação explícita.

## 4. Estado derivado e comportamento

O cálculo usa a contratação vigente e o relógio de `America/Sao_Paulo`:

- Removida por engano: campos de invalidação; oculta nas listas normais.
- Cancelada: cancelamento da fonte contratual, prevalecendo sobre a data.
- Realizada: horário final previsto já alcançado. Não grava evento nem confirmação automática no banco.
- Hoje: evento do dia que ainda não alcançou o término. Eventos que atravessam meia-noite continuam nessa visão até o término previsto.
- Próxima: evento futuro.

Horário final ausente usa o fim do dia como fallback. Histórico oferece Todas/Realizadas/Canceladas. Pendências considera tarefas abertas de qualquer prioridade e pendências abertas, excluindo canceladas e removidas.

Checklist e prioridade não controlam estado. Gestão e Equipe podem registrar convidados, hora extra, adicional, ocorrência, observação e pendência depois da data, mantendo o rótulo Realizada. Hora extra e adicionais não criam cobranças, recebimentos, créditos ou devoluções.

Presentes informados são a última observação válida, considerando sua cadeia de correções. Excedentes são `max(presentes - convidados vigentes, 0)`. Sem contagem, ambos ficam não informados; convidados contratados não são usados como presença presumida.

A Festa lê a versão vigente atual. Remarcação move sua data sem criar outra Festa. Alteração contratual exibe aviso informativo e comparação com a versão da criação, sem exigir reconhecimento manual. Tarefas e fatos anteriores preservam suas associações contratuais históricas.

## 5. SHA-256 da Migration 016

Arquivo: `database/migrations/20260911_016_festa.sql`.

```text
ea38cbb996b072228f97130ed1774147a5a58fe88f8dca911e6ac7eb9118c162
```

## 6. Validação estrutural

Clone estrutural novo: `kidmais_016_1789113097039`, restaurado do checkpoint original.

| Verificação | Resultado |
|---|---|
| Precheck | PASS |
| Aplicação da 016 simplificada | PASS |
| Postcheck físico | PASS |
| Rollback com tabelas de Festa vazias | PASS |
| Reaplicação | PASS |
| Rollback com dados | Recusado conforme esperado |
| Conteúdo das 52 tabelas anteriores no clone | Preservado por hashes |

O clone aplicado possui 61 tabelas. O rollback usa locks exclusivos e recusa remover estruturas que contenham dados ou auditoria de Festa. Não houve backfill.

Evidência: `.local-festa/results/migration.json`.

## 7. Testes da alteração

| Bateria | Resultado |
|---|---|
| Unitários de domínio, perfis e política de Festa | 15/15 PASS |
| Integração simplificada de Festa | 12 cenários agrupados PASS |
| Remarcação com assinatura Kidmais e aceite OTP real do fluxo de teste | PASS |
| Concorrência de correções de contagem | PASS: segunda ramificação recusada com `23505`; correção seguinte permitida |
| Concorrência de criação/invalidação | PASS: duplicidade `23505`, atividade durante invalidação `23514`, recriação e uma Festa ativa |
| Navegador Edge automatizado | PASS |
| TypeScript | PASS |
| Lint direcionado | PASS, sem avisos |
| Build em cópia limpa isolada | PASS |

A integração cobre os casos A–M e O–R do pedido; N é coberto pelo teste de remarcação/vigência. Também verifica atomicidade diante de falha de auditoria, idempotência, imutabilidade, autenticação e CSRF. A simulação de data no teste de integração confirma gravações posteriores à data sem fabricar uma realização.

O navegador validou Gestão/Equipe/sem acesso, ausência dos controles antigos, Hoje e Histórico derivados, filtros Realizadas/Canceladas, cancelamento, invalidação e recriação, convidados/excedentes, hora extra, adicional, ocorrência, checklist crítico, pendência posterior e recuperação de rascunho após conflito. Desktop 1280, tablet 820 e celular 390 passaram sem transbordamento horizontal; nenhum erro de página. Capturas desktop e celular inspecionadas visualmente.

Há aviso preexistente do Node sobre detecção de módulo TypeScript (`MODULE_TYPELESS_PACKAGE_JSON`) em alguns runners; não provoca falha. Nenhuma alteração arquitetural de módulos foi feita para eliminá-lo.

Evidências atuais: `simplificacao-integration.json`, `vigencia.json`, `concurrency.json`, `invalidation-concurrency.json`, `browser.json`, `quality.json` e `clean-build.json`, em `.local-festa/results`. Resultados de rodadas anteriores permanecem históricos e não substituem essas evidências.

## 8. Regressões e arquivos

Regressões: 133 testes unitários passaram, além de PricingService, Identidade/repositório/serviço/Fechamento, Pagamentos/HTTP/concorrência, condição de pagamento, financeiro 015/HTTP/fluxo, crédito/devolução, casos financeiros, movimentos, revisão operacional e Contrato administrativo. Todas as 16 entradas de `.local-festa/results/regressions.json` terminaram com código zero. Os 15 unitários de Festa foram executados novamente depois do último ajuste.

Arquivos de implementação alterados nesta rodada:

- `lib/festas/domain.ts`, `perfis.ts`, `politica.ts`, `repository.ts`, `schema.ts`, `service.ts`, `ux.ts`.
- `components/festas/FestaConsole.tsx`.
- `lib/contratos/services/cancelamento.service.ts`: substituição da antiga evidência de início operacional por fatos compatíveis com o domínio simplificado.
- `database/migrations/20260911_016_festa.sql`, `database/checks/20260911_016_postcheck.sql`, `database/rollback/20260911_016_festa_down.sql`.

Testes e preparação alterados:

- `lib/festas/domain.test.ts`, `perfis.test.ts`, `politica.test.ts`.
- `scripts/festa-016.integration.cjs`, `festa-016-browser.cjs`, `festa-016-concorrencia.cjs`, `festa-016-invalidacao-concorrencia.cjs`, `festa-016-prepare-environments.cjs`, `festa-016-verify-environments.cjs`, `festa-016-vigencia.cjs`.

Seis runners antigos foram removidos por dependerem do ciclo eliminado: `festa-016-atomicidade.cjs`, `festa-016-contagem-final.integration.cjs`, `festa-016-invalidacao.integration.cjs`, `festa-016-patch-final.integration.cjs`, `festa-016-perfis.integration.cjs` e `festa-016-revisao.integration.cjs`. A cobertura pertinente foi consolidada na integração, testes de domínio, concorrência e navegador atuais.

São 22 arquivos existentes alterados, seis removidos e este relatório criado, além das evidências locais. Inventário: `.local-festa/results/simplificacao-files.json`. Checkpoint do código anterior: `.backups/simplificacao-1789112468760`.

Nenhum arquivo funcional de Pagamentos, Fechamento, OTP, geração de documentos ou versionamento foi alterado nesta simplificação. O impacto fora de Festa limita-se ao serviço contratual de cancelamento mencionado acima.

## 9. Novo clone manual

Banco: `kidmais_016_1789113046647`.

Restaurado do checkpoint original e com a 016 simplificada aplicada. As 52 tabelas do checkpoint mantêm os hashes originais; as nove tabelas de Festa estão vazias. Somente o usuário real Felipe, sem fixtures sintéticas e sem concessão automática de acesso. As contratações de Catarina com 50 e 120 convidados foram consultadas e estão elegíveis. Nenhuma Festa foi criada nelas.

O clone automatizado é separado: `kidmais_016_1789113046648`. Oito runners com fixtures recusam o clone manual. Clones manuais anteriores ficaram obsoletos e foram preservados, sem adaptação de seus dados.

Evidências: `.local-festa/results/isolation.json` e `simplificacao-manual-elegiveis.json`.

## 10. Como testar localmente

Abra o VS Code. No menu **Terminal → Novo Terminal**, selecione **PowerShell**. Cole as três linhas abaixo no terminal, não no arquivo `.env.local`:

```powershell
Set-Location -LiteralPath 'D:\glass\KidMais Manager\kidmais-manager'
Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
node --env-file=.env.local --env-file=.local-festa/manual.env scripts/festa-016-dev.cjs
```

A segunda linha remove somente uma variável da sessão desse terminal, permitindo que o arquivo do clone forneça a conexão correta. Não altera arquivos nem dados. O comando de inicialização confere o nome do clone manual antes de iniciar o servidor.

Mantenha esse terminal aberto e aguarde a mensagem de servidor pronto. Abra **http://localhost:3017/admin/login** no navegador. Entre com seu usuário real e sua senha cadastrada.

1. Abra **Configurações → Acessos** (`http://localhost:3017/admin/configuracoes/acessos`).
2. Em seu usuário, clique em **Alterar acesso**, selecione **Gestão**, marque a confirmação de alteração do próprio acesso e salve. Isso concede capacidades somente no clone.
3. Abra **Festas** (`http://localhost:3017/admin/festas`). Selecione a contratação de Catarina desejada entre as disponíveis e adicione a Festa explicitamente.
4. Confira data, pacote, convidados e o rótulo derivado. Explore Hoje, Próximas, Pendências e Histórico conforme a data vigente.
5. Cadastre e conclua uma tarefa, inclusive com destaque de atenção. Verifique que nenhuma etapa ou conclusão de Festa é solicitada.
6. Sem contagem, confira “Não informado”. Cadastre uma contagem e verifique presentes/excedentes. Correções ficam registradas no histórico.
7. Cadastre hora extra, adicional, ocorrência e observação. Nenhuma dessas ações cria cobrança ou muda manualmente o estado.
8. Para testar remoção por engano, use uma Festa ainda sem atividades. Para cancelamento real, use **Mais ações → Cancelar festa**, informe o motivo e confira **Histórico → Canceladas**. Essas ações de teste ficam somente no clone.

O servidor não foi deixado executando. Não é necessário aplicar migration, criar usuário ou reiniciar o PostgreSQL. Nenhum comando manual de aplicação no banco real é fornecido nesta etapa.

## 11. Preservação do banco real

`kidmais_manager` continua com **52 tabelas e sem `festas`/Migration 016**. As verificações finais no banco real usaram conexões somente leitura. Nenhum comando de escrita desta rodada foi dirigido a ele. O PostgreSQL não foi parado nem reiniciado.

Migrations 012, 013, 014 e 015 e `schema_mvp_kidmais.sql` permanecem byte a byte iguais aos hashes do checkpoint. Provas, BYTEA/PDFs, snapshots, assinaturas, versões e dados financeiros históricos permaneceram preservados.

Precisão da comparação: 49 tabelas reais coincidem integralmente com o checkpoint original. As três diferenças são `auditoria`, `sessoes_administrativas` e `limites_autenticacao`, com última atividade em 11/09 às 01:10:53 (São Paulo), anterior ao checkpoint desta simplificação às 04:41:08. Não foram revertidas nem confundidas com alterações desta rodada. Evidência: `.local-festa/results/simplificacao-real-preservation.json`.

Implementação encerrada nesta etapa. A aplicação em banco real depende de nova aprovação.
