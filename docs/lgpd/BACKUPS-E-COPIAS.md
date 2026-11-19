# Backups e cópias de banco: inventário, 90 dias, eliminação e restauração

**Estado (03/11/2026): procedimento LOCAL, documental, não publicado.** Versão de 21/10/2026 atualizada para a fornecedora **Demerzel Labs Ltda.** ("Demerzel Labs") e para os textos legais `2026-11-17-termos`, `2026-11-17-privacidade` e `2026-11-17-dpa`. Nesta atualização nada foi apagado, aberto, restaurado ou consultado em banco ou painel.

Fonte de verdade: `lib/cadastro/documentos-legais.ts`. Se este procedimento divergir dos textos, valem os textos.

| Papel | Quem |
|---|---|
| Responsável pela rotina, pela decisão de eliminar e pela execução | Felipe Menegaz, encarregado da Demerzel Labs |
| Quem pode eliminar cópias no Render (disco, exportações, instâncias) | Só Felipe, no painel ou no Shell. Agentes não apagam nada |
| Quem roda o inventário local | Felipe ou um agente, só com o script de inventário (lê metadados) |

Índice: [INDICE.md](INDICE.md). Calendário: [CALENDARIO-DE-ELIMINACOES.md](CALENDARIO-DE-ELIMINACOES.md).

Convenção de caminhos: `<raiz>` é a pasta do workspace (`D:/glass/KidMais Manager`, nome herdado do repositório).

## 1. Regra

O que os textos prometem (DPA, "Término"; Aviso, tabela de retenção):
- as cópias de segurança ficam **isoladas do uso corrente**;
- cópias de segurança **e exportações do banco** são eliminadas no **ciclo máximo de 90 dias, incluindo cópias locais**, ou em prazo menor onde disponível;
- se houver restauração, as exclusões já determinadas são **reaplicadas**;
- as eliminações ficam registradas e o registro é fornecido **a pedido**.

Regras de execução:
1. **Toda cópia de banco** (PITR, exportação do Render, `pg_dump`, pasta extraída, cluster PostgreSQL local com dados copiados) e **toda exportação entregue a uma empresa cliente** que fique guardada localmente é eliminada em **até 90 dias** a partir da data em que foi gerada. Quando o nome traz a data (ex.: `2026-09-21T10_27Z`), vale a mais antiga entre a data do nome e a data do arquivo.
2. **Prazo menor sempre que possível.** Uma cópia feita para uma janela (migration, reparo, homologação, exportação a pedido) é apagada assim que a janela for encerrada e conferida.
3. **Exceção só por escrito.** Preservar além de 90 dias exige registro (seção 7) com motivo concreto (incidente, disputa, ordem de autoridade), escopo, local isolado e data de revisão (no máximo 90 dias depois). Sem registro, não há exceção.
4. **Na dúvida, tratar como dado real.** As classes são:

| Classe | O que é | Exemplo |
|---|---|---|
| A | Cópia de produção | exportação do banco de produção, dump P1 no disco do Render |
| B | Cópia do banco local antigo (portas 5432/5433) ou de homologação com dados copiados | `<raiz>/Backup/.../.backups/*.dump` |
| C | Cópia de staging (tem dados de teste e contatos reais da equipe e da lista de permitidos do WhatsApp) | `cutover/*/backup/staging-pre-*.dump`, exportações de staging |
| D | Cluster PostgreSQL local "descartável" | `ambientes-locais/pg-descartavel-*` |
| E | Arquivo sintético gerado por teste automatizado | `teste-local/execucoes/*/staging.dump` |
| F | Exportação completa entregue a uma empresa cliente (cópia que ficou com a Demerzel Labs) | pasta de trabalho da exportação manual ([ENSAIO-EXPORTACAO-E-DEVOLUCAO.md](ENSAIO-EXPORTACAO-E-DEVOLUCAO.md)) |

As classes A, B, C e F seguem a regra dos 90 dias. As classes D e E devem ser **sintéticas** pelas regras dos agentes. Ainda assim, entram na mesma limpeza, porque um cluster "descartável" pode ter recebido uma restauração de staging.

## 2. Inventário de onde existem cópias

O inventário abaixo é o de **21/10/2026**. Ele não foi refeito nesta atualização. A próxima rodada mensal (01/12/2026) o substitui.

### 2.1 Render (remoto): o que existe e o prazo efetivo

Dados de documentos e evidências datadas. Nenhum painel foi consultado.

| Cópia | Ambiente | Prazo efetivo | Evidência | Como sai |
|---|---|---|---|---|
| PITR do PostgreSQL de produção `dpg-dak750gae00c73fudmg0-a` | Produção | **3 dias**, janela móvel (plano sem Pro) | painel lido em 11/10/2026 09:17Z (`docs/evidencias/backup-production-codex-20261011.md`) | Automático. Dentro dos 90 dias |
| PITR do PostgreSQL de staging `dpg-daidko3m8hqs73ce4jt0-a` | Staging | **3 dias** | painel lido em 19/10/2026 (vault: Goal Backup Marketing staging) | Automático |
| Exportação lógica do painel (Recovery → Create export, `.dir.tar.gz`) | Ambos | **7 dias** no Render | `docs/ENSAIO_RESTAURACAO_20261007.md` | Automático no Render. **A cópia baixada passa a ser cópia local** (seção 2.2) |
| Dumps `pg_dump --format=custom` do P1 no disco persistente de produção `/opt/render/project/src/data/lancamento-venda-20261011/` (disco `dsk-dakalm142hec739sqrt0`, 1 GB) | Produção | **Sem rotação**: ficam até alguém apagar | `scripts/backup-lancamento-production.cjs`; `docs/BACKUP_PRODUCTION_LANCAMENTO_20261011.md` | Manual (seção 5.3) |
| Snapshots automáticos do disco persistente | Produção | **Não verificado** | — | Conferir na aba Disks do serviço no painel |
| Instâncias PostgreSQL criadas por restauração PITR em ensaios | Staging | Enquanto existirem | `docs/HANDOFF_V1_PRODUCAO.md` | Conferir a lista de bancos no workspace e excluir as que sobraram |

Dumps P1 conhecidos no disco de produção (lista **incompleta** em 21/10; o diretório não foi listado):

| Arquivo | Criado | Tamanho | Eliminar até | Fonte |
|---|---|---|---|---|
| `backup-eac358bd-fab7-4ff3-b0b9-23a86d4913bc.dump` (+ `.json`) | 11/10/2026 09:18Z | 9.799.207 B | **09/01/2027** | `docs/evidencias/backup-production-codex-20261011.md` |
| P1 de 19/10/2026 23:42Z (nome não registrado no repositório) | 19/10/2026 | ? | 17/01/2027 | vault: migrations de produção 19/10 |
| `backup-9fe5b220-2840-4d18-b7c3-1d018e954ec3.dump` (+ `.json`) | 20/10/2026 | ? | 18/01/2027 | vault: reparo dos bloqueios 20/10 |
| P1 das janelas posteriores (088, 087, 089 e outras) | 21/10 em diante | ? | data + 90 dias | vault: notas de cada janela |

O mesmo diretório guarda marcadores de migration e reparo (`migration-*.json`, `reparo-bloqueios.json`). Eles não são cópias de dados: ficam.

### 2.2 Computador de Felipe (inventário de 21/10/2026, 10:35Z)

Comando: `node scripts/lgpd-inventario-backups.cjs --padrao` mais `--raiz` para `C:/Users/Glass/.codex`, `C:/Users/Glass/AppData/Local/Temp`, `D:/Backup`, `D:/Bakcup 19.08.25` e `D:/Felipe`. Foram 326 itens e 4,6 GB, nenhum com mais de 90 dias naquela data. A lista completa (caminho, data, tamanho) está em `pacote-revisao-juridica-astra-20261020/v2/procedimentos/INVENTARIO-LOCAL-20261021.md`. Nenhum arquivo foi aberto.

Atenção: o script de inventário está no clone de procedimentos de 21/10 (`scripts/lgpd-inventario-backups.cjs` e `.test.cjs`). Ele **não** foi copiado para este clone.

| Classe | Onde | Itens | Tamanho | Datas | Eliminar até (90 dias) |
|---|---|---|---|---|---|
| **A** | `<raiz>/2026-09-21T10_27Z.dir/2026-09-21T10_27Z/` (exportação de produção em pasta) | 1 | 2,1 MB | 21/09/2026 10:27Z | **20/12/2026** |
| A? | `<raiz>/2026-09-21T10_27Z.dir/2026-09-21T10_27Z/` (banco de ensaio de restauração pré-019) | 1 | 1,1 MB | 21/09/2026 | 20/12/2026 |
| A | `<raiz>/2026-09-21T10_27Z.dir.tar` (pacote da mesma exportação) | 1 | 3,4 MB | 21/09/2026 | 20/12/2026 |
| A? | `<raiz>/2026-09-13T07_19Z.dir.tar.gz` (ambiente não identificado pelo nome) | 1 | 184 KB | 13/09/2026 07:19Z | **12/12/2026** |
| **B** | `<raiz>/Backup/` (pasta com o nome do repositório: `.backups/*`, `.tmp/*`, `.local-festa/*`): dumps do banco local antigo | 25 | ~31 MB | 09–11/09/2026 | 08–10/12/2026 |
| B | `<raiz>/Backup/legacy/` (cópia idêntica da linha anterior) | 25 | ~31 MB | 09–11/09/2026 | 08–10/12/2026 |
| B | `<raiz>/Backup/HOMOLOGACAO-V1/` (dump pós-016 homologado e dump anonimizado) | 2 | 1,5 MB + 447 KB | 11/09/2026 | 10/12/2026 |
| B | `.backups/` do clone `-github` do repositório (dump de homologação antes da 019) | 1 | 463 KB | 20/09/2026 | 19/12/2026 |
| **C** | `<raiz>/cutover/staging-pre-058-98faef8-20260929-*.dump` | 2 | 1,5 MB cada | 30/09/2026 | 29/12/2026 |
| C | `<raiz>/homologacao-painel-063/backup/*.dump` | 3 | 2,1 MB cada | 04–05/10/2026 | 02–03/01/2027 |
| C | `<raiz>/homologacao-venda-066/backup/staging-pre066-8fce6db-20261006T160458Z.dump` | 1 | 2,2 MB | 06/10/2026 | 04/01/2027 |
| C | `<raiz>/cutover/` (`homologacao-candidata-staging-20261007`, `migracao-067-068-…`, `migracao-070-…`, `migracao-071-…`, `migracao-072-…`), `backup/staging-pre-*.dump` | 9 | 2,2–2,3 MB cada | 07/10/2026 | 05/01/2027 |
| C | pasta de cópias de staging em `C:/Users/Glass/` (`A4-20261014T202052Z/staging.dump`) | 1 | 3,7 MB | 14/10/2026 | 12/01/2027 |
| C | mesma pasta, `19.10.26 - 04h56/` (`2026-10-19T07_57Z.dir.tar.gz` + `extraido/`) | 2 | 5,4 MB + 11,6 MB | 19/10/2026 07:57Z | 17/01/2027 |
| C | mesma pasta, `EXPORT-20261019T0913Z/` (`.dir.tar.gz` + `extraido/`) | 2 | 5,4 MB + 11,6 MB | 19/10/2026 09:13Z | 17/01/2027 |
| **D** | Clusters PostgreSQL locais: `ambientes-locais/` (9), pastas `.local-*` dentro de clones (16), worktrees do clone do site de venda (21), `demo-walle-69dc301-20261012/pg-data` (1), pastas de demo em `C:/Users/Glass/AppData/Local/Temp` (9) | 56 | 4,4 GB | 29/09–21/10/2026 | 28/12/2026–19/01/2027 |
| **E** | `C:/Users/Glass/.codex/worktrees/0997/a4-backup-staging-20261014*/teste-local/…` e `a5-migrations-staging-20261014*/…` (dumps sintéticos) | 193 | 107 MB | 14/10/2026 | 12/01/2027 |

Procurado e **não encontrado** em 21/10: `D:/` pastas temporárias de 19/10, `C:/Users/Glass/Downloads`, `Desktop`, `Documents`, `OneDrive`, `D:/glass/_retirado-do-C-20261020`, `D:/Backup`, `D:/Bakcup 19.08.25`, `D:/Felipe`.

**Fora do script, mas no escopo:**
- O PostgreSQL local antigo (portas 5432/5433) não foi tocado; a política dos agentes proíbe acessá-lo. Felipe decide se ele ainda guarda dados reais e se deve ser eliminado ou anonimizado. Os dumps da classe B vêm dele.
- `<raiz>/backups-obsidian/` (9 cópias do vault de 25/09/2026) são notas, não banco. Conferir se trazem dado pessoal; se não trouxerem, ficam fora da regra.
- `<raiz>` é ela própria um repositório Git solto (branch `master`). Nunca rodar `git add` nela: os dumps acima entrariam no histórico.

## 3. Rotina mensal (Felipe, todo dia 1º, cerca de 15 minutos)

A rotina completa do dia 1º, com os demais prazos da tabela de retenção, está em [CALENDARIO-DE-ELIMINACOES.md](CALENDARIO-DE-ELIMINACOES.md). A parte das cópias é:

1. No clone de procedimentos, rodar:
   ```bash
   node scripts/lgpd-inventario-backups.cjs --padrao --markdown --falhar-se-vencido
   ```
   Código 0: nada vencido. Código 3: há cópia com mais de 90 dias. A coluna "Situação" mostra `VENCIDO`.
2. No Render (painel, só leitura): conferir a janela PITR dos dois bancos, as exportações listadas, os bancos extras no workspace e o diretório do disco de produção (seção 5.3, passo 1).
3. Conferir as exportações completas entregues a empresas (classe F): apagar as já confirmadas pela empresa.
4. Para cada item `VENCIDO`, ou que vença nos próximos 30 dias e já não sirva: eliminar (seção 5) ou registrar a exceção (seção 7).
5. Registrar a rodada em `Registro de copias e eliminacoes LGPD`: data, totais, o que saiu e o que ficou com exceção.
6. A cada trimestre, ampliar a busca com `--raiz` para HDs externos, pendrives e outras pastas onde houver download do painel.

Ao **criar** uma cópia nova (exportação, P1, dump de janela, exportação a pedido de empresa), anotar no mesmo registro: onde, quando, por que e a data-limite. Fechada a janela, apagar.

## 4. Quando apagar antes (recomendação de 21/10, ainda válida)

- **Classe B (banco local antigo):** as 50 cópias de `Backup/` e `Backup/legacy` são duplicadas entre si e anteriores à operação em nuvem. Se não forem necessárias para nenhuma prova, apagar já.
- **Classe C:** os dumps "pre-migration" de staging de 29/09 a 07/10 serviram a janelas já concluídas. Apagar as anteriores à exportação mais recente e as pastas `extraido/`.
- **Classe A:** a exportação de produção de 21/09 e o `.tar.gz` de 13/09 são anteriores às migrations 074a–089 e não servem mais para restaurar. Apagar, salvo exceção registrada.
- **Classes D e E:** apagar os clusters de tarefas encerradas e as pastas `teste-local` (antes, parar cada cluster; ver 5.2). Não apagar o cluster de uma tarefa em andamento.
- **Disco de produção:** manter só o P1 mais recente enquanto uma janela precisar dele (os aplicadores exigem P1 com menos de 24 horas). Os anteriores podem sair.

## 5. Como eliminar

Antes de apagar, para cada item, confirmar que:
- não há restauração em andamento;
- não há exceção registrada;
- não é o único ponto de recuperação de uma janela aberta.

Depois de apagar, registrar.

### 5.1 Arquivo ou pasta local (dump, `.tar.gz`, pasta de exportação, pasta `extraido/`)

PowerShell (Felipe), um item por vez:

```powershell
$alvo = '<caminho completo do item>'
Get-Item -LiteralPath $alvo | Select-Object FullName, Length, LastWriteTime
Remove-Item -LiteralPath $alvo -Recurse -Confirm
```

- `Remove-Item` não passa pela Lixeira. Se apagar pelo Explorer, esvaziar a Lixeira em seguida.
- Pastas sincronizadas (OneDrive, Google Drive): apagar também da lixeira on-line.
- O disco deve ter BitLocker ligado, para que sobras no SSD não sejam legíveis por quem pegar o disco.

### 5.2 Cluster PostgreSQL local

1. Parar o cluster, se estiver rodando: `"C:\Program Files\PostgreSQL\18\bin\pg_ctl.exe" -D "<pasta do cluster>" stop -m fast`.
2. Apagar a pasta do cluster (5.1).
3. **Nunca** tocar os serviços das portas 5432/5433 por esta rotina.

### 5.3 Dumps no disco de produção do Render

Felipe, no Shell do web de produção `srv-dak77m2d0e5s73b8rkkg`. A sessão Shell pode ser cobrada.

1. Listar, só leitura:
   ```bash
   ls -la --time-style=+%Y-%m-%dT%H:%M /opt/render/project/src/data/lancamento-venda-20261011/
   df -h /opt/render/project/src/data
   ```
2. Anotar no registro nome, data e tamanho de cada `backup-*.dump`.
3. Apagar o dump vencido ou desnecessário, um por vez, com confirmação (`rm -i <arquivo>`).
4. O `backup-*.json` correspondente tem só hash, datas e identificadores, sem dado pessoal. Pode ficar como prova de que a cópia existiu e de quando saiu.
5. Repetir a listagem e registrar. Se o disco tiver snapshots automáticos, o arquivo apagado ainda existe neles até expirarem. Anotar esse prazo quando ele for conferido.

### 5.4 Exportações e instâncias no Render

- Exportações expiram sozinhas em 7 dias. Se o painel oferecer exclusão, pode apagar antes.
- Instância criada por PITR para ensaio: excluir no painel no mesmo dia do ensaio (ela também gera custo) e registrar.

## 6. Depois de uma restauração: reaplicar as exclusões

Restaurar (PITR ou dump) volta o banco a um instante **T**. Tudo o que foi excluído, revogado ou descadastrado **depois de T** volta a existir. Os textos prometem que, havendo restauração, as exclusões já determinadas serão reaplicadas. Antes de devolver o banco restaurado ao uso:

1. Anotar **T** e o motivo da restauração em `Registro de incidentes LGPD` ([RESPOSTA-A-INCIDENTES.md](RESPOSTA-A-INCIDENTES.md)).
2. Levantar as determinações feitas depois de T, nas fontes abaixo. Se o banco antigo ainda puder ser lido, a leitura exige autorização própria e é só de leitura.

| Determinação | Onde está registrada | Como reaplicar hoje |
|---|---|---|
| Conversa de WhatsApp excluída (a pedido ou por retenção) | `whatsapp_atendimento_privacidade` (`acao='CONVERSA_EXCLUIDA'`, `conversa_id`, `criada_em`; migration 082) e `Registro de pedidos de titulares LGPD` | Tela Atendimento → Privacidade, excluir de novo (`lib/whatsapp/atendimento/privacidade.ts`). Depois rodar a retenção uma vez (`scripts/whatsapp-atendimento-retencao.mjs`) |
| Arquivo revogado, link trocado | `whatsapp_atendimento_privacidade` (`acao LIKE 'ARQUIVO_%'`) | Mesma tela: revogar ou trocar o link de novo |
| PARAR ("não contatar"), pausa e "com equipe" do WhatsApp | `whatsapp_atendimento_controles_contato` (082) | Hoje não há tela para regravar. Anotar no registro e conferir antes de religar o canal (ferramenta futura) |
| Descadastro de Marketing | `marketing_contato_preferencias_eventos` (086) | Tela de Marketing do cliente: descadastrar de novo (`lib/marketing/automacoes/preferencias.ts`) |
| Autorização de IA de convite revogada | `convite_ia_autorizacoes.revogada_em` (088) | Editor do convite: revogar de novo (`lib/convites/service.ts`) |
| Cliente enviado à lixeira (inativado) | `auditoria` (ação de lixeira; `lib/clientes/services/lixeira.ts`) | Lixeira: mover de novo |
| Pedido de titular atendido com eliminação ou anonimização | `Registro de pedidos de titulares LGPD` (medida e ids técnicos) | Repetir a medida registrada |
| Anonimização de clientes dos buffets (lotes mensais) | Arquivo do lote fora do banco restaurável, com ids técnicos, categoria e medida ([CALENDARIO-DE-ELIMINACOES.md](CALENDARIO-DE-ELIMINACOES.md), seção 2, item 8) | Repetir cada lote com data posterior a T, pelos ids do arquivo, antes de devolver o banco ao uso |
| Exclusão de empresa após o prazo de encerramento | `Registro de copias e eliminacoes LGPD` ([CALENDARIO-DE-ELIMINACOES.md](CALENDARIO-DE-ELIMINACOES.md)) | Repetir a exclusão registrada |
| Observações de saúde apagadas pela empresa | `auditoria` da edição da festa | Avisar a empresa controladora para conferir e apagar de novo |

3. Conferir, por amostra, que cada item reaplicado está correto, e registrar a reaplicação: T, número de itens por tipo, quem fez e quando.
4. Só então religar a recepção do WhatsApp e as automações de Marketing, se tiverem sido desligadas para a restauração.

**Limitação de hoje:** não existe um "registro de exclusões" fora do banco além das notas do vault. Por isso, todo pedido atendido com eliminação é registrado em `Registro de pedidos de titulares LGPD` (com a medida e os ids técnicos, sem nome nem contato) **no mesmo dia**.

## 7. Registro

Nota do vault, **sem dados pessoais**: `Registro de copias e eliminacoes LGPD`. Uma linha por cópia:

| Campo | Exemplo |
|---|---|
| Identificador | `COP-20261019-01` |
| Local exato | pasta de cópias de staging, `EXPORT-20261019T0913Z/` |
| Classe e ambiente | C, staging |
| Criada em / por quê | 19/10/2026 09:13Z, janela H1 do Marketing |
| Eliminar até | 17/01/2027 |
| Situação | ATIVA, ELIMINADA em dd/mm (por Felipe) ou EXCEÇÃO |
| Exceção | motivo, escopo, revisão em dd/mm |

O registro é fornecido à empresa cliente a pedido (Aviso, "Armazenamento, segurança e retenção"; DPA, "Término").

## 8. Script de inventário

`scripts/lgpd-inventario-backups.cjs`, com testes em `scripts/lgpd-inventario-backups.test.cjs` (`node --test scripts/lgpd-inventario-backups.test.cjs`). Hoje só existe no clone de procedimentos de 21/10.

- **Só metadados:** usa `readdirSync` (nomes) e `lstatSync` (data e tamanho). Não abre, não lê, não copia e não apaga arquivos. Não segue atalhos e não conecta a banco nem à rede.
- **O que reconhece:** `.dump`, `.backup`, `.pgdump`; `backup-*.json` (registros do P1); `.sql`, `.sql.gz` e `.bak` com nome sugestivo ou com 5 MB ou mais; `.tar`, `.tar.gz`, `.zip`, `.7z` com nome de backup ou exportação, ou com a data no padrão do Render; pastas com `toc.dat`; pastas com `PG_VERSION` e `base/`.
- **O que ignora:** `node_modules`, `.git`, `.next`.
- **Opções:** `--raiz <pasta>` (repetível); `--padrao`; `--dias 90`; `--json` ou `--markdown`; `--falhar-se-vencido` (código 3 quando há item vencido).
- A idade usa a data mais antiga entre o nome e o arquivo.
- Arquivos sem padrão reconhecido não aparecem: o script reduz a busca manual, mas não a substitui.

## 9. O que ainda é manual e o que precisa de ferramenta

| Item | Hoje | Futuro |
|---|---|---|
| Inventário local | Script + rotina mensal | Tarefa agendada local |
| Disco de produção | Listagem e `rm` manuais no Shell | Rotação no próprio P1, com registro |
| Snapshots do disco e instâncias de ensaio | Conferência manual no painel | — |
| Reaplicação após restauração | Manual, tela por tela | Registro de determinações fora do banco restaurável + script de reaplicação |
| Controles de contato do WhatsApp depois do restore | Sem tela | Tela ou script de reaplicação |
