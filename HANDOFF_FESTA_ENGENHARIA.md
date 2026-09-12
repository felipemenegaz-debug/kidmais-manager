# KIDMAIS MANAGER
## HANDOFF — FESTA / ENGENHARIA

Estamos iniciando a etapa de Engenharia do módulo Festa.

IMPORTANTE:
Nesta primeira etapa NÃO altere código, NÃO aplique migration e NÃO modifique o banco.

Primeiro faça apenas análise técnica do projeto atual.

## Estado atual

O projeto já possui:

- Clientes / CRM
- Disponibilidade
- Fechamento
- Contrato
- autenticação administrativa
- assinatura Kidmais
- aceite eletrônico do cliente por OTP
- Pagamentos
- edição administrativa da festa
- edição pós-assinatura
- remarcação
- versionamento contratual
- tratamento financeiro das alterações

As migrations atuais chegam até a Migration 015.

NÃO alterar retroativamente:
- Migration 012
- Migration 013
- Migration 014
- Migration 015

Também NÃO atualizar por enquanto:
schema_mvp_kidmais.sql

## Situação atual de Festa

Existe atualmente:

app/festas/[id]/page.tsx

e:

components/festas/FestaProfile.tsx

Porém essa implementação ainda utiliza dados mockados e NÃO representa o novo módulo Festa operacional definido funcionalmente.

Não expandir simplesmente o mock.

A nova Festa deverá trabalhar com dados reais do PostgreSQL e integrar-se aos módulos existentes.

## Responsabilidade do módulo Festa

Contrato responde:
"O que foi contratado?"

Pagamentos responde:
"O que foi lançado, recebido, estornado, devolvido e ainda devido?"

Festa responde:
"O que deve ser preparado e executado no evento, o que efetivamente aconteceu e quais ocorrências precisam permanecer registradas?"

## Status operacionais aprovados

- PROGRAMADA
- EM_PREPARACAO
- PRONTA_PARA_EXECUCAO
- EM_MONTAGEM
- EM_ANDAMENTO
- EM_ENCERRAMENTO
- CONCLUIDA
- CANCELADA

Não misturar status operacional com:
- contrato
- financeiro
- agenda
- pendências

Não criar status como:
- COM_PENDENCIA
- AGUARDANDO_DEFINICOES
- PENDENCIA_FINANCEIRA

## Regras invariantes

1. Contrato assinado é histórico e imutável.
2. Festa não altera diretamente obrigação contratual.
3. Festa não fabrica recebimentos, pagamentos, estornos ou devoluções.
4. Convidados contratados, presentes e excedentes são conceitos diferentes.
5. Produção não altera quantidade contratada.
6. Aprovação operacional não significa pagamento.
7. Festa CONCLUIDA pode possuir pendências posteriores.
8. Pendência posterior não reabre automaticamente a Festa.
9. Correções não apagam valores anteriores.
10. Alterações vindas de outro módulo devem preservar sua verdadeira origem.

## Alterações contratuais

A Migration 014 já possui o fluxo de revisão/edição pós-assinatura.

Festa NÃO deve criar outro mecanismo de alteração contratual.

Exemplo:

Cliente pede 50 -> 70 convidados.

Festa registra a solicitação.

Se for alteração material, utiliza o mecanismo pós-assinatura existente.

Somente quando a nova versão estiver vigente Festa passa a considerar 70 como contratados.

## Financeiro

A Migration 015 já trata consequências financeiras.

Festa pode registrar, por exemplo:

8 convidados excedentes.

Mas não deve criar automaticamente:
- obrigação
- recebimento
- estorno
- devolução
- pagamento

Esses fatos continuam pertencendo ao módulo Pagamentos.

## Auditoria

Já existe infraestrutura genérica de auditoria no projeto.

Antes de criar qualquer tabela nova de auditoria para Festa, avaliar reutilização da existente.

Histórico operacional e auditoria são conceitos diferentes.

Pode ser necessária uma estrutura como festa_eventos para a linha do tempo amigável.

## Estruturas que precisam ser avaliadas

Analise tecnicamente a necessidade de estruturas equivalentes a:

- festas
- festa_tarefas
- festa_pendencias
- festa_ocorrencias
- festa_eventos
- festa_contagens_convidados
- festa_solicitacoes
- estruturas de marcos operacionais
- estruturas mínimas de produção
- escolhas estruturadas de buffet quando necessário

Evite tabelas redundantes.

## Tarefas

Precisamos suportar:

Etapas:
- PRE_PREPARACAO
- PREPARACAO
- MONTAGEM
- DURANTE
- ENCERRAMENTO
- POS_EVENTO

Status:
- PENDENTE
- EM_ANDAMENTO
- CONCLUIDA
- NAO_SE_APLICA

Prioridade:
- NORMAL
- ATENCAO
- CRITICA

Responsabilidade:
- área
- responsável individual opcional

Reaberturas devem preservar histórico.

## Ocorrências

Precisamos suportar:

Status:
- ABERTA
- RESOLVIDA
- ENCAMINHADA

Gravidade:
- NORMAL
- IMPORTANTE
- CRITICA

Registrar dano ou ocorrência nunca deve criar cobrança automaticamente.

## Convidados

Precisamos manter:

- convidados contratados
- presentes
- excedentes

Não armazenar apenas um contador sobrescrito se isso destruir o histórico das contagens.

## Hora extra e adicionais

Registrar solicitação e aprovação operacional separadamente.

Aprovação operacional NÃO significa:
- contrato alterado
- pagamento realizado
- obrigação quitada

## Buffet

O estado atual de Fechamento ainda possui parte do buffet em campos textuais.

A nova UX necessita maior estrutura.

NÃO sobrescrever snapshots e informações históricas existentes.

NÃO realizar backfill inventando escolhas antigas.

## Produção

Precisamos suportar conceitualmente:

- previsto
- ajustado
- preparado
- conferido
- extra

Mas as fórmulas reais ainda NÃO estão definidas.

Se não houver regra configurada:
"Quantidade automática não configurada."

Não inventar fórmulas.

## Regras ainda A DEFINIR

Não resolver por suposição:

- composição completa de alguns pacotes
- quantidade de sabores de doces
- opções de bebidas
- quantidade de lembrancinhas
- fórmulas de produção
- margens de segurança
- prazos
- janela automática de preparação
- método definitivo de contagem
- tolerância de hora extra
- preço de hora extra
- regra comercial de excedentes
- nomes finais das áreas da equipe

## Autenticação e permissões

Na definição funcional usamos:
- Operador
- Supervisor/Gerente
- Administrador

Esses são conceitos funcionais.

NÃO criar novos papéis de autenticação automaticamente.

Primeiro analise o modelo real de autenticação existente e proponha como mapear as capacidades necessárias.

## Rotas

Avalie seguir o padrão administrativo atual, por exemplo:

app/admin/festas
app/admin/festas/[festaId]

API equivalente em:

app/api/admin/festas

Services/repositories devem seguir o padrão arquitetural atual.

Não concentrar regra de negócio em componentes React ou route handlers.

## Concorrência

Avaliar especialmente:

- dois usuários concluindo a mesma tarefa
- dois usuários atualizando convidados
- contrato alterado enquanto Festa está aberta
- conclusão concorrente
- reabertura concorrente
- alteração de buffet durante produção

Não permitir sobrescrita silenciosa.

## Idempotência

A criação da Festa deve ser idempotente.

Uma contratação não pode gerar duas Festas por repetição de request ou duplo clique.

## Migration

A análise funcional indica provável necessidade de Migration 016.

PORÉM NÃO CRIE NEM APLIQUE A MIGRATION AINDA.

Primeiro avalie se é melhor:

A) Migration 016 única para o núcleo operacional

ou

B) 016 para núcleo Festa e migrations posteriores para funcionalidades como produção/catálogos.

Não criar migration monolítica sem necessidade.

## Backfill

NÃO criar automaticamente Festas históricas ou inventar fatos operacionais.

Antes de qualquer backfill, apresente estratégia.

## Primeira resposta esperada

Responda SOMENTE com análise técnica contendo:

A. Diagnóstico atual
B. O que será reutilizado
C. Lacunas
D. Arquitetura técnica proposta
E. Persistência/tabelas propostas
F. Recomendação sobre Migration 016
G. Integrações
H. Permissões/autorização
I. Concorrência/idempotência
J. Ordem de implementação
K. Testes automatizados propostos
L. Riscos de regressão
M. Pontos A DEFINIR

NÃO implemente nada nessa primeira resposta.

Depois da análise técnica, aguardarei aprovação antes de alterar o projeto.
