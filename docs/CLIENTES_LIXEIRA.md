# Clientes: arquivamento e lixeira

## Arquitetura

O CRM já possui ATIVO, INATIVO e MESCLADO, identificação canônica por CPF,
histórico e auditoria. Este patch reutiliza essas estruturas, sem migration.
Arquivar e excluir usam INATIVO, diferenciados pela ação registrada na auditoria:
CLIENTE_ARQUIVAR ou CLIENTE_EXCLUIR. Restaurar usa CLIENTE_RESTAURAR e retorna ATIVO.
Clientes inativos anteriores ao recurso aparecem como arquivados, sem inventar
data, motivo ou responsável quando não existem evidências.

## Operação

Na ficha: **Excluir / Arquivar cliente** → informar ação e motivo → primeira
confirmação → segunda confirmação explícita sobre preservação do histórico.
Arquivar identifica cliente legítimo inativo; excluir identifica cadastro errado,
teste ou duplicado. Nenhuma das ações executa DELETE físico.

Em **Clientes → Lixeira / Arquivados**, os registros mostram nome, contato mascarado,
data, responsável, motivo e botão **Restaurar cliente**. A restauração exige motivo,
preserva ID e vínculos e registra novo evento. Também está disponível na ficha.
A lista da lixeira usa páginas de 50 registros.

## API e segurança

- GET `/api/admin/clientes/lixeira?offset=0`: lista administrativa de inativos.
- GET `/api/admin/clientes/{id}/lixeira`: situação e evidência da última transição.
- POST `/api/admin/clientes/{id}/lixeira`: ARQUIVAR, EXCLUIR ou RESTAURAR.
- GET `/api/admin/clientes?incluirInativos=true`: consulta incluindo inativos.

Os endpoints usam a guarda administrativa atual do CRM; mutações mantêm Origin e
CSRF. A API exige motivo, chave de idempotência, versão temporal do cadastro e duas
confirmações para desativar. A transação bloqueia o cliente, recusa alteração
concorrente, muda somente status/metadados de atualização e grava auditoria e
histórico. Falha na auditoria deve abortar a transação do chamador.

A chave é vinculada ao cliente, usuário, intenção, motivo e versão observada.
Retry não repete auditoria nem desfaz restauração posterior. A versão temporal
preserva microssegundos para evitar diferenças entre PostgreSQL e JavaScript.
Cliente mesclado deve ser operado pelo cadastro principal.

## Busca, duplicidades e vínculos

A lista padrão e a busca do CRM mostram ATIVO. A opção **Incluir arquivados/excluídos**
permite encontrar INATIVO. Consultas históricas por ID e consultas de duplicidade
continuam incluindo INATIVO; o índice único de CPF canônico não é alterado.

CPF de cliente inativo bloqueia novo cadastro e oferece acesso à ficha para
restauração. Contato ou e-mail exato de inativo também exige conferir/restaurar o
cadastro antes de criar outro. Contatos compartilhados por clientes ativos continuam
seguindo o aviso de possível duplicidade existente. E-mail foi incluído na análise.

Não há alteração de contratos, documentos assinados, festas, fechamentos,
pagamentos ou ocupação. Arquivar cliente **não cancela sua contratação** nem
interrompe obrigações existentes. Perfil histórico permanece acessível.

## Retenção e limites

Após 90 dias da ação, a interface sinaliza elegibilidade para avaliação futura.
Isso não comprova que a purga seja segura. Nenhuma rotina de purga foi criada.
Para mudar entre arquivado e lixeira, restaurar primeiro e registrar a nova ação.

Sem campos novos: a auditoria é a fonte da data, motivo e tipo da ação. Seu histórico
precisa ser preservado. Volume elevado pode exigir avaliação de índices, sem criar
índices ou alterar infraestrutura neste patch.

## Validação

Testes novos com dependências simuladas verificam estados, IDs, ausência de DELETE
e alterações em vínculos, auditoria, restauração, retry, conflitos, confirmação,
busca, duplicidades, mascaramento e autenticação. As regressões gerais incluem CRM,
Contratos, Festa, Pagamentos, Em contratação e formalização 019.

Não houve conexão com banco real. Antes de GO operacional, homologar o fluxo visual,
concorrência física, rollback da auditoria e preservação dos vínculos em ambiente
descartável/autorizado. Comandos: testes novos, production:test, check:v1:static,
build e git diff --check. Não há commit, push, deploy ou migration neste trabalho.
