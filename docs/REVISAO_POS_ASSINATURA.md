# Revisão / retificação pós-assinatura

## Fluxo analisado e implementação

O sistema já possui `nova_versao` em `operarContrato`, preparações operacionais,
edições, documentos por versão e promoção transacional após assinatura. A ação
existia no fim do painel com o nome “Iniciar elaboração”. Este patch a destaca
como **Criar revisão / retificação** e reutiliza o fluxo existente.

1. Abrir o contrato e selecionar a versão vigente assinada.
2. Escolher nova versão ou retificação e informar motivo obrigatório.
3. Criar a revisão, ou abrir a preparação já existente.
4. Usar **Editar dados desta revisão** e salvar os campos permitidos.
5. Conferir versão anterior, nova versão, motivo, data, status e diferenças reais.
6. Gerar novo PDF, revisar o documento exato e assinar pela Kidmais.
7. Liberar para o cliente assinar. Só então a revisão passa a ser vigente.

Nenhuma migration nova. Nenhuma alteração de migrations existentes.
API reutilizada: `POST /api/admin/contratos/versoes/{id}`, ação `nova_versao`.
O painel GET passa a informar a ocupação vigente pela função central da 019;
o aviso de reserva não depende mais exclusivamente de CONFIRMADO/pagamento.

## Preservação e classificação

A edição direta de versão assinada/congelada é recusada antes de editar dados.
A revisão usa novos registros em `contrato_versoes`, `contrato_edicoes` e
`fechamento_revisoes`, preservando origem, motivo, autor, data e auditoria.
PDFs, hashes, assinaturas e comprovantes anteriores não são sobrescritos.
Permanecem acessíveis selecionando a versão no histórico e seus documentos.

Somente `documental.observacoes` recebe classificação DOCUMENTAL; os outros campos
de conteúdo são MATERIAL, incluindo identidades, data, pacote, convidados e
condições comerciais. Metadados de revisão, schema e estado do fechamento não
são diferenças de conteúdo. A classificação não concede dispensa de assinatura:
**todas as revisões continuam exigindo Kidmais e cliente**. Não há interpretação
automática do texto livre para autorizar obrigações novas sem aceite.

## Festa, agenda e financeiro

A Festa mantém identidade por contrato e lê o snapshot da versão vigente.
Preparar uma revisão não muda a Festa nem libera o horário anterior. A estrutura
existente valida e pode proteger provisoriamente o destino da remarcação.
Na formalização, os locks e a revalidação da 019 antecedem a promoção. A aplicação
operacional, a assinatura e a troca de vigência compartilham a transação. Falha
impede efeitos parciais; Festa existente é reutilizada.

Cancelar somente a revisão preserva a versão vigente e sua ocupação. O histórico
da proposta é mantido. Cancelamento do contrato continua pelo fluxo próprio.

Mudanças comerciais mostram aviso de impacto financeiro. O fluxo existente registra
pendências de vigência para tratamento explícito. **Não há recálculo automático do
plano financeiro neste patch**: as obrigações futuras precisam do tratamento já
existente em Financeiro. Recebimentos, quitações e estornos não são fabricados.

## Idempotência

O navegador reutiliza a chave para a mesma intenção (versão/tipo/motivo), inclusive
em retry após falha de rede, e bloqueia requisições simultâneas na mesma tela.
O backend mantém locks de fechamento/contrato/fluxo e reutiliza preparação aberta.
As constraints existentes garantem chave de criação única e uma preparação aberta
por fechamento. Outra intenção com a mesma chave é recusada.

## Arquivos e validação

- `components/admin/ContratoAdmin.tsx`: ação, comparação, avisos e retry estável.
- `lib/contratos/services/administrativo.service.ts`: guarda de edição e ocupação.
- `lib/contratos/services/alteracoes.ts`: diferenças e classificação conservadora.
- `lib/contratos/services/revisao-pos-assinatura.test.ts`: testes offline dos fluxos.
- Este documento: operação e limites.

Os testes usam executores/dependências simulados e verificações do código/constraints
versionados. Não comprovam concorrência física, rollback PostgreSQL ou navegação
completa no navegador. Antes do GO operacional, homologar V1 → V2 em ambiente
descartável/autorizado, incluindo conflito de remarcação, dois operadores, assinaturas,
cancelamento, documentos anteriores e tratamento financeiro.

O template específico ADITIVO segue indisponível no modelo atual. Versões documentais
legadas sem preparação operacional continuam exigindo o tratamento já previsto pelo
sistema; este patch não importa PDFs antigos nem faz reconciliação automática.

Comandos de validação: testes novos e regressões 019/Em contratação,
`npm run production:test`, `npm run check:v1:static`, `npm run build`,
`git diff --check`. Nenhum banco real, production, secret ou infraestrutura foi acessado.
