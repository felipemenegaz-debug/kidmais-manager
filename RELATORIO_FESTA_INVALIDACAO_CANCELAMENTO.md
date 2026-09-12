# Festa — invalidação, cancelamento e remarcação

Validação encerrada em 11/09/2026, somente em clones. Nenhuma aplicação da 016 no banco real.

## Soluções implementadas

**Remover por engano:** invalidação lógica, com autor, instante e motivo. Exige Gestão (`FESTA_CORRIGIR`), Festa PROGRAMADA e ausência de preparação ou fatos operacionais impeditivos. Criação inicial e sua auditoria não impedem a remoção. Tarefas, pendências, ocorrências, contagens, preparação e solicitações aprovadas/executadas impedem a operação. Uma solicitação ainda não decidida nem executada pode permanecer arquivada. A Festa invalidada fica imutável, acessível pelo endereço administrativo anterior e fora das listagens normais. Contrato e financeiro não mudam. Nova criação usa novo identificador e não reativa o registro anterior; a contratação admite somente uma Festa não invalidada.

**Cancelar realmente:** comando oficial em Contrato, seguido de atualização da Festa para CANCELADA na mesma transação. Reutiliza `contratos.status`, `contratos.cancelado_em`, `eventos_historico_cliente` e `auditoria`. O evento de negócio `CONTRATO_CANCELADO`, vinculado à entidade CONTRATO, registra motivo, autor, instante e chave de idempotência. Não foi necessária nova estrutura contratual. O cancelamento exige Gestão, motivo e contrato ativo/assinado. Se EM_ANDAMENTO já ocorreu, o cancelamento é recusado mesmo após encerramento. Falha na auditoria desfaz tanto o cancelamento contratual quanto o operacional. Repetição com a mesma chave e conteúdo não duplica fatos.

Versões, assinaturas, PDF/BYTEA, snapshots, Fechamento e registros financeiros permanecem preservados. O contrato cancelado não admite nova revisão nem novo aceite. A leitura do documento assinado continua disponível. Não há geração automática de crédito, devolução, estorno ou cancelamento da obrigação financeira; os fluxos financeiros existentes continuam separados.

**Remarcar:** a ação abre o fluxo existente de nova versão contratual. A Festa não é cancelada nem substituída. A mudança efetiva continua dependendo da formalização da nova versão e da revisão operacional existente.

## Migration 016

Arquivo: `database/migrations/20260911_016_festa.sql`.

Delta desta rodada:

- `festas.invalidada_em TIMESTAMPTZ`, `invalidada_por UUID` com FK para usuários administrativos e `motivo_invalidacao TEXT`, todos inicialmente NULL; nenhum backfill.
- CHECK exige os três campos simultaneamente preenchidos ou nulos, motivo válido e status PROGRAMADA para invalidação.
- Unicidade absoluta de `contrato_id` substituída pelo índice `festas_contrato_ativo_uk`, UNIQUE sobre `contrato_id WHERE invalidada_em IS NULL`.
- Proteção contra exclusão física e mutação posterior da Festa invalidada; validação dos fatos impeditivos antes da invalidação.
- Proteções e bloqueio transacional do registro pai impedem novos fatos em Festa invalidada e serializam a disputa entre registro operacional e invalidação.
- Postcheck e rollback ajustados às novas proteções. Permanecem nove tabelas de Festa, sem alteração de estruturas anteriores à 016.

SHA-256 final:

```text
8469181fd9c43ece65362a4b8d0c1ac403d6f9dfa3037d2e82a567c61972398e
```

Checkpoint de código desta rodada: `.backups/invalidation-1789106895758`.

Clone estrutural: `kidmais_016_1789107439594`.

| Verificação estrutural | Resultado |
| --- | --- |
| Precheck | PASS |
| Aplicação | PASS |
| Postcheck | PASS |
| Rollback em clone vazio | PASS |
| Reaplicação | PASS |
| Rollback com dados | Recusado como esperado |
| 52 tabelas anteriores | Hashes preservados |

O rollback protegido não deve ser utilizado para apagar trabalho operacional: havendo dados de Festa/auditoria correspondente, recusa a remoção. Não foi executado no banco real nem no clone manual anterior.

## Arquivos desta rodada

Criados:

- `lib/contratos/services/cancelamento.service.ts`: cancelamento oficial, histórico de negócio e auditoria atômica.
- `scripts/festa-016-invalidacao.integration.cjs`: regras de invalidação/cancelamento, idempotência e preservação.
- `scripts/festa-016-invalidacao-concorrencia.cjs`: unicidade concorrente e invalidação versus ocorrência.
- Este relatório.

Alterados:

- `components/festas/FestaConsole.tsx`: Mais ações, diálogos, remarcação guiada, consulta de invalidada, Histórico/Canceladas, motivo/data e ações somente de leitura após cancelamento/invalidação.
- `lib/festas/schema.ts`: comandos e validação dos motivos.
- `lib/festas/service.ts`: invalidação, recriação, sincronização transacional do cancelamento, listagens e exigibilidade derivada.
- `lib/contratos/services/administrativo.service.ts`: impede alterações administrativas em contratação cancelada.
- `lib/contratos/services/fluxo-publico.ts`: impede novo aceite de contratação cancelada, preservando leitura dos documentos.
- `database/migrations/20260911_016_festa.sql`: delta descrito acima.
- `database/checks/20260911_016_postcheck.sql`: campos, índice parcial e ausência de unicidade absoluta.
- `database/rollback/20260911_016_festa_down.sql`: remoção das novas funções no rollback protegido.
- `scripts/festa-016-browser.cjs`: cobertura das novas ações e manutenção das regressões de UX.
- `scripts/festa-016-prepare-environments.cjs`: criação de novos clones da revisão da 016, preservando clones anteriores.
- `scripts/festa-016-verify-environments.cjs`: hash revisado e verificação de isolamento.
- `scripts/festa-016-qualidade.cjs`: inclui os serviços contratuais afetados no lint.

Arquivos locais de registro/resultado e ambiente foram atualizados em `.local-festa`; não contêm mudanças de regra. Não houve alteração de código de Pagamentos, Fechamento ou Disponibilidade nesta rodada.

## Testes e resultados

- 133 testes unitários: 133 PASS, zero falhas.
- Nova integração de invalidação/cancelamento: 13 cenários PASS, cobrindo autorização, motivos, fatos impeditivos, preservação, recriação, unicidade, idempotência, histórico, PDF legível após cancelamento e rollback da operação inteira em falha de auditoria.
- Integração principal de Festa: 17 verificações PASS, incluindo autenticação/CSRF, revisão otimista, transições, contagens, exceções e preservação dos documentos/finanças.
- Revisão operacional de Festa, patch final, contagem final opcional e perfis: PASS.
- Concorrência de criação: segunda criação física simultânea recusada com `23505`.
- Concorrência invalidação/ocorrência: ocorrência concorrente aguarda bloqueio e é recusada com `23514` após invalidação.
- Concorrência das correções de contagem: somente uma correção direta, próxima correção exige a folha; PASS.
- Atomicidade: falha no evento/auditoria desfaz fato e revisão; PASS.
- Regressões: PricingService, Identidade/CRM, Identidade/Fechamento, Pagamentos (domínio, HTTP e concorrência), condições de pagamento, HTTP/fluxo financeiro 015, créditos/devoluções, casos financeiros, movimentos, revisão operacional e Contrato administrativo: PASS.
- Navegador: Gestão/Equipe/sem acesso, autoconcessão explícita, remoção, consulta da invalidada, recriação, cancelamento, exclusão de Hoje/Próximas/Pendências, Histórico/Canceladas com motivo/data, diálogo de remarcação, operação, exceções, contagem final, encerramento, correção, reabertura e conflito preservando rascunho: PASS. Desktop/tablet/mobile e zero erros de página.
- TypeScript, lint direcionado e build em cópia limpa: PASS. Lint dos testes modificados repetido após o ajuste final de seletores: PASS.
- Isolamento final: 14 runners recusam o clone manual; 52 tabelas originais do manual preservadas por hash, nove novas vazias e somente o usuário real.

Houve interrupção da conexão com o PostgreSQL durante a primeira tentativa de navegador. Após o usuário disponibilizar novamente o PostgreSQL 18, a bateria foi retomada e concluída. O seletor de dois campos do teste foi ajustado para incluir o texto auxiliar do rótulo; a execução final passou. Nenhuma alteração de configuração do PostgreSQL foi feita.

Evidências: `.local-festa/results/migration.json`, `invalidation.json`, `invalidation-concurrency.json`, `festa-integration.json`, `atomicity.json`, `concurrency.json`, `regressions.json`, `browser.json`, `quality.json` e `isolation.json`.

## Novo teste manual

Novo banco manual: **`kidmais_016_1789107431778`**.

Criado do checkpoint original e da 016 revisada. Sem fixtures e sem concessão automática de capacidades. A contratação Catarina, 12/09/2026, 120 convidados está presente; nenhuma Festa foi adicionada automaticamente.

O clone manual anterior `kidmais_016_1789104053902` e sua Festa de 120 convidados não foram removidos nem modificados por scripts. Para testar o código atual com a estrutura nova, use o novo clone abaixo; o anterior permanece como histórico do teste anterior.

1. No VS Code, abra **Terminal → Novo Terminal**, selecionando **PowerShell**. Não use o terminal do PostgreSQL.
2. Execute, linha por linha:

```powershell
Set-Location -LiteralPath 'D:\glass\KidMais Manager\kidmais-manager'
Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
node --env-file=.env.local --env-file=.local-festa/manual.env scripts/festa-016-dev.cjs
```

3. Deixe esse terminal aberto. Confirme a mensagem com o nome `kidmais_016_1789107431778` e aguarde o Next.js indicar que está pronto. Se a porta 3017 estiver ocupada por outro servidor da aplicação, encerre aquele servidor pelo terminal correspondente antes de repetir; não pare o PostgreSQL.
4. Abra **http://localhost:3017/admin/login** e entre com seu usuário real e sua senha existente.
5. Como o clone novo não recebeu capacidades automaticamente: em **Configurações → Acessos**, altere seu acesso para **Gestão**, confirme explicitamente a alteração do próprio acesso e salve.
6. Abra **http://localhost:3017/admin/festas**. Em **Adicionar festa de uma contratação assinada**, escolha Catarina com **120 convidados**, conferindo data e horário, e clique em **Adicionar esta festa**. Não escolha a outra contratação de 50 convidados.
7. Abra essa Festa antes de iniciar preparação. Em **Mais ações → Remover festa criada por engano**, informe o motivo e confirme. Ela deve sair das listas e a contratação deve voltar às elegíveis. Adicione-a novamente para comprovar a recriação, sem reutilizar/reativar a Festa removida.
8. Para testar cancelamento real no clone: use uma Festa elegível antes do início, **Mais ações → Cancelar festa**, informe o motivo e confirme. Consulte **Histórico → Canceladas** e seus detalhes. O contrato fica cancelado, sem movimentos financeiros automáticos; os registros anteriores permanecem consultáveis.
9. Para remarcação, use outra Festa ainda ativa: **Mais ações → Remarcar festa** abre a revisão contratual existente. A data efetiva só muda após concluir aquele fluxo. Não use Cancelar para mudar a data.

Não execute migrations manualmente: a 016 revisada já está aplicada no novo clone manual.

## Preservação e ponto de parada

Verificação final, somente leitura: **`kidmais_manager` permanece com 52 tabelas e sem `public.festas`/Migration 016**. Migrations 012, 013, 014, 015 e `schema_mvp_kidmais.sql` permanecem byte a byte intactos. Não houve backfill, mudanças financeiras automáticas nem edição de provas contratuais. Nenhum comando de escrita desta rodada foi direcionado ao banco real.

Implementação e validação nos clones concluídas. Aplicação no banco real continua bloqueada até nova aprovação.
