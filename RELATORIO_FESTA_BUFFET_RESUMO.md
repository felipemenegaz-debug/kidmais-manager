# Festa — Buffet, resumo da contratação e navegação

Rodada concluída em 11/09/2026, somente em clones. O banco real não recebeu a Migration 016 nem alterações desta rodada.

## 1. Mapeamento confirmado no Fechamento

A inspeção cobriu formulário público, schema HTTP, serviços público/administrativo, repositórios, revisão pós-assinatura, montagem do snapshot e estrutura física do PostgreSQL.

| Campo no Fechamento | Caminho no snapshot | Campo apresentado na Festa |
|---|---|---|
| `buffet_salgados` | `contratacao.buffet.salgados` | Salgados |
| `buffet_doces` | `contratacao.buffet.doces` | Doces |
| `buffet_bolo` | `contratacao.buffet.bolo` | Bolo |
| `buffet_bebidas` | `contratacao.buffet.bebidas` | **Bebidas e sucos** |
| `buffet_outros` | `contratacao.buffet.outros` | Outras preferências informadas, preservadas como texto |
| `idade_aniversariante_evento` | `aniversariante.idadeNoEvento` | Idade junto ao nome |
| `tema_festa` | `aniversariante.temaFesta` | Tema no resumo |

O formulário existente chama o campo de bebidas de “Bebidas e sucos” e aceita ambos no mesmo texto. Por isso, o conteúdo foi mantido inteiro e o rótulo não foi reduzido artificialmente a “Sucos”. Não foi criado parser para separar bebidas, sucos ou escolhas de `buffet_outros`.

Arquivos centrais dessa origem: `components/fechamento/FechamentoWizard.tsx`, `app/api/fechamentos/route.ts`, `lib/fechamentos/services/fechamento-publico.service.ts`, `fechamento.service.ts`, `lib/fechamentos/repositories/fechamento.repository.ts` e `lib/contratos/services/contrato.service.ts`.

## 2. Lembrancinha, Empratado e Bombom

Não existiam campos estruturados próprios para essas escolhas. O texto de outras preferências podia contê-las, mas não fornecia uma separação confiável. Os adicionais comerciais cadastrados identificavam direitos/itens contratados, não a escolha textual específica.

A própria 016 agora acrescenta, em `fechamentos` e `fechamento_revisoes`:

- `buffet_lembrancinha`: TEXT nullable, sem default, até 2.000 caracteres.
- `buffet_empratado`: TEXT nullable, sem default, até 2.000 caracteres.
- `buffet_bombom`: TEXT nullable, sem default, até 2.000 caracteres.

No formulário/API/modelo: `buffetLembrancinha`, `buffetEmpratado`, `buffetBombom`. Em novos snapshots: `contratacao.buffet.lembrancinha`, `.empratado`, `.bombom`.

Foram ligados o formulário público, edição administrativa e fluxo de revisão pós-assinatura. As escolhas são textos, sem catálogo e sem opções inventadas. Omissão dos novos campos em uma edição não apaga uma escolha existente; mudança de pacote continua seguindo a limpeza/revisão do buffet já existente.

Para preservar as proteções do versionamento, a 016 atualiza as funções de hash/validação/proteção da revisão operacional para considerar as novas escolhas. Valores novos nulos são omitidos da projeção de hash, preservando os hashes anteriores. O arquivo da Migration 014 não foi editado. O rollback restaura exatamente as definições anteriores dessas três funções.

Exibição na Festa:

- Todas: Salgados, Doces, Bolo, Bebidas e sucos.
- Completa e Mini Festa: também Lembrancinha.
- Premium: também Lembrancinha, Empratado e Bombom.
- Em outros pacotes, campos adicionais aparecem somente quando existe o adicional formal correspondente. A identificação usa códigos cadastrados dos adicionais vinculados ao snapshot, sem interpretar texto livre.

Nenhum valor foi preenchido retroativamente. Snapshots assinados antigos continuam iguais.

## 3. Remoção de Ocorrências

Removida `festa_ocorrencias` da 016, incluindo FKs, checks, triggers de vínculo/invalidação/imutabilidade e referências em precheck, postcheck e rollback.

Removidos comando de ocorrência, schema, leitura e escrita no repositório/serviço, política de resolução/encaminhamento e testes dessa funcionalidade. A API compartilhada de Festa continua existindo, mas recusa o antigo comando `ocorrencia`.

A interface não possui mais aba Problemas/Ocorrências, botão Registrar problema, formulário, providência, resolução ou encaminhamento de ocorrência. Não havia capacidade exclusiva a remover; os perfis continuam Gestão e Equipe com as cinco/duas capacidades já aprovadas.

Observações livres usam o novo comando simples `observacao`: descrição, evento append-only e auditoria atômica. Não possuem situação, importância, providência ou tratamento. São consultáveis em Registros da festa e Histórico.

## 4. Buffet operacional e UX

Criada `festa_buffet`, relação 1:1 com Festa pela chave primária `festa_id`. Contém sete escolhas textuais nullable, referência contratual, autor e instante da atualização. Não é catálogo, produção ou tabela financeira.

Precedência por campo:

1. Valor operacional salvo em Festa, quando não nulo.
2. Valor do snapshot contratual vigente.
3. Vazio, exibido como “Não definido”.

Texto vazio salvo explicitamente representa uma escolha apagada/não definida; `null` permite herdar novamente a origem. Abrir ou consultar não cria ficha. Salvar é idempotente, confere a revisão da Festa e a versão vigente dentro da transação, e grava antes/depois no histórico e na auditoria. Não altera Fechamento, snapshot, PDF, obrigação ou pagamentos. Itens sem direito contratado são recusados também pelo serviço.

A aba Buffet é uma ficha com **Editar**, sem formulário de pendência, etapa, prioridade, situação, dependência ou área. Não cria tarefas automaticamente. Alterações de pacote, direito ou item pago são direcionadas a **Editar contratação**, no módulo contratual existente.

A Visão geral prioriza aniversariante com idade, contratante, tema, data, horário, pacote, convidados, valor contratado, adicionais e indicação de pendência financeira. Oferece Editar contratação, Ver contrato e Ver pagamentos, sem UUID ou versão na apresentação normal. Editar contratação abre a contratação correspondente no fluxo já existente; nenhuma edição comercial paralela foi criada em Festa.

Idade: preferência pelo valor no evento; na ausência, cálculo pela data de nascimento do snapshot/CRM e data do evento; sem fonte válida, “Idade não informada”. Singular: “1 ano”. Aplicado ao cabeçalho, resumo, cards e contratações disponíveis para adicionar.

Na Festa futura, Registros da festa fica recolhido. Na Realizada, aparece aberto. Checklist e pendências continuam independentes de ciclo operacional.

Trocar aba fecha o editor anterior. Sem alterações, fecha imediatamente; com alterações não salvas, pergunta “Deseja sair sem salvar?”, com Continuar editando e Sair sem salvar. O rascunho permanece ao escolher continuar. Nenhum editor é renderizado como formulário de outra aba.

## 5. SHA-256 da 016

Arquivo: `database/migrations/20260911_016_festa.sql`.

```text
3843802812f7a970f8824f3836eef592bf3b565d1721a4ed33c75e5b620774a2
```

São nove tabelas novas: a ficha Buffet substitui a tabela de Ocorrências. O banco aplicado tem 61 tabelas, além das seis novas colunas nas duas tabelas de Fechamento. Não foi criada Migration 017.

## 6. Aplicação e rollback

Validação final em clone estrutural novo: `kidmais_016_1789118219612`, restaurado do checkpoint original.

| Verificação | Resultado |
|---|---|
| Precheck | PASS |
| Aplicação | PASS |
| Postcheck físico | PASS |
| Rollback vazio | PASS |
| Restauração exata das três funções anteriores | PASS |
| Reaplicação | PASS |
| Rollback com dados de Festa | Recusado conforme esperado |
| Rollback com escolha preenchida no Fechamento | Recusado conforme esperado |
| Valores das colunas preexistentes nas 52 tabelas | Preservados por hashes |
| Novas escolhas em registros anteriores | Nulas, sem backfill |

Evidência: `.local-festa/results/migration.json`. A comparação das tabelas antigas exclui apenas as três novas chaves de cada linha; a ausência de valores nessas novas colunas foi verificada separadamente.

## 7. Testes e regressões

| Bateria | Resultado |
|---|---|
| Unitários completos | 135/135 PASS |
| Unitários específicos de Festa | 17 PASS |
| Integração simplificada de Festa | 13 cenários agrupados PASS |
| Integração específica de Buffet Premium | PASS |
| Remarcação, assinatura Kidmais, OTP e promoção | PASS |
| Concorrência de contagens | PASS: ramificação concorrente recusada |
| Concorrência criação/invalidação/pendência/recriação | PASS |
| Navegador Edge, desktop/tablet/celular | PASS |
| TypeScript | PASS |
| Lint direcionado, incluindo Fechamento e novos testes | PASS |
| Build em cópia limpa isolada | PASS |

Cobertura do pedido A–P: campos por pacote e adicional formal; herança e Não definido; complementação sem alterar provas; contratante e idade; ausência de idade; link do fluxo contratual existente; editor sem alterações fecha; editor alterado confirma descarte; ausência de Ocorrências na UX e no banco; Central, cancelamento, remarcação e invalidação.

O teste Premium criou uma contratação pelo fluxo público real de teste, assinou e aceitou via OTP. Confirmou Lembrancinha/Empratado/Bombom estruturados, preenchimento da ficha, idempotência e preservação de provas/financeiro. Também confirmou que alterar uma dessas escolhas numa preparação contratual muda o hash da revisão, mantendo a versão vigente anterior.

No navegador, foram exercitados Buffet Completa, resumo, idade, navegação e descarte, além dos fluxos existentes de Equipe/Gestão, registros posteriores, conflito com preservação de rascunho, cancelamento e invalidação. Premium/Mini/adicionais também têm cobertura de domínio; Premium tem integração com banco. Nenhum erro de página, sem transbordamento horizontal nas três larguras. Captura da ficha Buffet inspecionada visualmente.

Regressões aprovadas: PricingService; Identidade/repositório/serviço/Fechamento; Pagamentos/HTTP/concorrência; condição de pagamento; financeiro 015/HTTP/fluxo; crédito/devolução; casos financeiros; movimentos; revisão operacional e Contrato administrativo.

A repetição de Contrato encontrou uma seleção de fixture que admitia contratação cancelada. O filtro do teste foi corrigido para exigir contratação assinada ativa; a reexecução passou, incluindo OTP, promoção, assinaturas e PDFs. Nenhuma regra de negócio foi flexibilizada. Alguns runners continuam emitindo o aviso preexistente de detecção de módulo TypeScript do Node; não causa falha.

Evidências em `.local-festa/results`: `regressions.json`, `simplificacao-integration.json`, `buffet-integration.json`, `vigencia.json`, `concurrency.json`, `invalidation-concurrency.json`, `browser.json`, `quality.json` e `clean-build.json`.

Inventário desta rodada: 35 arquivos existentes alterados e quatro arquivos de código/teste criados, além deste relatório e evidências locais. Lista completa: `.local-festa/results/buffet-files.json`. Arquivos novos: `lib/fechamentos/repositories/escolhas-buffet.ts`, `lib/festas/buffet.ts`, `lib/festas/buffet.test.ts`, `scripts/festa-016-buffet.integration.cjs`.

O checkpoint anterior está em `.backups/buffet-1789116283550`. A remoção de Ocorrências ocorreu dentro dos arquivos compartilhados; nenhum arquivo de migration publicada foi excluído.

## 8. Novo clone manual

`kidmais_016_1789116640476`.

Restaurado do checkpoint original, com a nova 016 aplicada, nove tabelas de Festa vazias e somente o usuário real Felipe. Catarina 50 e 120 estão elegíveis e disponíveis; nenhuma Festa ou escolha operacional foi criada nessas contratações. Os novos campos do Fechamento permanecem nulos nos registros originais.

O clone automatizado é separado: `kidmais_016_1789116640477`. Nove runners com fixtures recusam o clone manual. Clones anteriores foram preservados e não devem ser usados com esta revisão estrutural.

Evidências: `.local-festa/results/isolation.json` e `buffet-manual.json`.

## 9. Inicialização para teste manual

No VS Code, abra **Terminal → Novo Terminal → PowerShell**. Se o servidor de teste anterior ainda estiver aberto na porta 3017, encerre somente aquele comando com **Ctrl+C** no respectivo terminal.

Cole no terminal:

```powershell
Set-Location -LiteralPath 'D:\glass\KidMais Manager\kidmais-manager'
Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
node --env-file=.env.local --env-file=.local-festa/manual.env scripts/festa-016-dev.cjs
```

A remoção da variável afeta somente a sessão do terminal. Aguarde o servidor pronto e mantenha o terminal aberto. Não cole comandos no `.env.local`.

1. Abra `http://localhost:3017/admin/login` e entre com o usuário real já cadastrado.
2. Abra `http://localhost:3017/admin/configuracoes/acessos`. Em seu usuário, selecione Gestão e confirme explicitamente a alteração do próprio acesso.
3. Abra `http://localhost:3017/admin/festas` e adicione explicitamente a contratação desejada de Catarina 50/120.
4. Confira contratante, tema, convidados, idade, valor e ações na Visão geral.
5. Em Buffet, clique Editar, complete uma escolha e salve. Valores antigos em outras preferências não são separados automaticamente.
6. Abra Editar novamente, altere um texto e troque de aba. Teste Continuar editando e Sair sem salvar.
7. Em Checklist, crie e conclua uma tarefa comum sem motivo. Confira a ausência de Problemas/Ocorrências.
8. Use Registros da festa para observações livres. Alterações de data/pacote/adicionais seguem Editar contratação.

Não é necessário criar outro usuário, executar migration ou reiniciar PostgreSQL. Os scripts de início usam o novo clone manual cadastrado.

## 10. Banco real e preservação

`kidmais_manager` continua com **52 tabelas e sem a Migration 016**. Nesta rodada, inspeções do banco real foram somente leitura; escritas e testes ficaram nos clones. PostgreSQL não foi parado nem reiniciado.

Migrations 012, 013, 014 e 015 e `schema_mvp_kidmais.sql` permaneceram byte a byte iguais. Nenhum backfill. Snapshots/PDFs/BYTEA/assinaturas anteriores não foram regravados. Não houve mudança funcional em Pagamentos, cálculo financeiro, recebimentos, créditos ou devoluções.

A implementação para esta etapa está concluída. Aguardando nova aprovação.
