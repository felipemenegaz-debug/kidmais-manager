# Acabamento pontual de Contrato — template V3 e apresentação da agenda

Concluído em 10/09/2026. Foram realizados somente os ajustes solicitados e os testes correspondentes. Nenhuma migration foi criada ou aplicada, nenhuma regra de Pagamentos foi alterada e nenhum outro módulo foi iniciado.

## Idade e correções de português

A função histórica de apresentação da idade acrescentava “anos” a qualquer número. O erro foi reproduzido antes da edição nos três modelos: “Aniversariante: Catarina, 1 anos.”

O renderer compartilhado V3 apresenta **1 ano** quando a idade do snapshot é exatamente 1. As demais idades continuam no plural: **0 anos**, **2 anos**, **10 anos**. Idade ausente continua “idade não informada”. O valor numérico e sua fonte de verdade não foram alterados.

Foram feitas exclusivamente estas três correções nas cláusulas:

| Trecho anterior | Texto novo |
|---|---|
| se houve estoque disponível | se houver estoque disponível |
| O espaço do subsolo e o buffet terminará | O funcionamento do espaço do subsolo e do buffet terminará |
| os parabéns será cantado | os parabéns serão cantados |

Os testes comparam as 18 cláusulas com o template V2. Somente as substituições indicadas nas cláusulas 5 e 8 são admitidas; os demais textos permanecem iguais. Foram preservados os 30 minutos, os 45 minutos, valores, multas, obrigações e destaques em negrito. Não foi feita revisão jurídica geral.

## Hold no mesmo slot: causa e decisão

A consulta física do banco confirmou o cenário observado: revisão em elaboração, Fechamento confirmado, data preparada e vigente **12/09/2026**, início **11:00:00**, fim **15:00:00**, mesmo período e `hold_destino_adquirido_em` preenchido.

Portanto, havia um hold técnico real e a UI também lhe atribuía o significado incorreto de remarcação. O serviço adquire a proteção para a preparação de um Fechamento confirmado sem distinguir se o slot mudou. A função física `kidmais_validar_agenda_revisao()` da Migration 014 exige hold quando uma revisão confirmada chega ao estado `APLICADA`, inclusive se o slot é idêntico. A proteção histórica também impede apagar arbitrariamente um hold já adquirido.

**Decisão: preservar integralmente a lógica e a proteção interna; corrigir somente a semântica visual.** Não foram alterados aquisição, liberação, locks, triggers ou regras de aplicação/cancelamento.

A consulta de leitura do painel agora informa `slot_alterado`, comparando data, início, fim e identificador do período preparados com os valores vigentes. Esse indicador não é uma nova coluna nem um dado gravado.

- Preparação ativa no mesmo slot: **RESERVA CONFIRMADA — data e horário mantidos**, sem “HOLD DE REMARCAÇÃO”.
- Data ou horário efetivamente diferentes, com hold adquirido: o aviso de **HOLD DE REMARCAÇÃO** continua aparecendo, com data e horário de destino.
- Retorno ao slot original durante a elaboração: o aviso de remarcação desaparece, mas a proteção técnica permanece.
- Revisões já aplicadas/canceladas: o painel não infere “data mantida” a partir de um destino que já se tornou vigente; apresenta simplesmente a situação da reserva.

O teste de navegador aguarda a nova elaboração carregar antes de conferir o aviso, evitando validar acidentalmente a versão anteriormente selecionada.

## Versionamento

Como o texto e os bytes de novos PDFs mudaram, a revisão atual passou de **2 para 3**, somente em código/registry.

| Novo modelo | Excedente preservado |
|---|---|
| FESTA_ESSENCIAL_V3 | R$ 110,00 por pessoa excedente |
| FESTA_COMPLETA_V3 | R$ 130,00 por pessoa excedente |
| FESTA_PREMIUM_V3 | R$ 150,00 por pessoa excedente |

O V3 reutiliza a renderização V2 e aplica apenas o acabamento aprovado. As tarifas continuam vindo da configuração central existente, que permaneceu sem edição. Também não foram editados o renderer histórico V1, o renderer V2 ou o gerador de PDF.

A resolução explícita do template 1 mantém Completa V1; a do template 2 mantém os três modelos V2; novas gerações resolvem V3. A revisão do template é independente de V1/V2 da contratação.

Os testes históricos comparam os bytes renderizados com hashes obtidos **antes** desta alteração: uma referência V1 e três referências V2. Todos permaneceram iguais. Esses testes usam fixtures sintéticas; não regeneram ou substituem documentos reais.

## Preservação antes/depois

Foi preservado o estado posterior ao teste manual do usuário no checkpoint [pre-acabamento-v3-1789031952313](<D:/glass/KidMais Manager/kidmais-manager/.backups/pre-acabamento-v3-1789031952313>), com 342 arquivos, dump do PostgreSQL, catálogo e hashes das linhas das 40 tabelas.

A comparação final confirmou:

- **40 tabelas** com todas as linhas e valores iguais ao checkpoint atual;
- **3 documentos BYTEA preexistentes**, com conteúdo, hashes e metadados intactos;
- dois Pagamentos e demais registros financeiros reais intactos;
- catálogo de colunas, constraints e triggers intacto;
- migrations **012, 013 e 014**, demais arquivos SQL e `schema_mvp_kidmais.sql` sem alteração;
- código funcional de Pagamentos, Fechamento e Disponibilidade sem alteração;
- templates históricos V1/V2 e `.env.local` sem alteração.

O banco local foi apenas lido para inspeção, backup e comparação. Operações de escrita dos testes ocorreram em clones. Não houve backfill ou atualização do conteúdo de documentos existentes. O servidor do usuário não foi substituído.

## Arquivos desta entrega

São **12 arquivos: 10 alterados e 2 novos**, incluindo este relatório. Cinco pertencem à implementação; os demais são testes e documentação. Caminhos abaixo relativos à pasta do projeto.

| Arquivo | Motivo |
|---|---|
| lib/contratos/documento/oficial/festas-v3.ts — novo | Renderer compartilhado com singular, três correções gramaticais e identificação V3. |
| lib/contratos/documento/oficial/models.ts | Tipar revisão 3 e defini-la como atual. |
| lib/contratos/documento/oficial/registry.ts | Resolver V3 por padrão e preservar V1/V2 explicitamente. |
| lib/contratos/services/administrativo.service.ts | Acrescentar somente o indicador calculado de comparação de slot à consulta do painel. |
| components/admin/ContratoAdmin.tsx | Distinguir visualmente slot mantido de remarcação real. |
| lib/contratos/documento/documento-core.test.ts | Idades, gramática, valores/negritos e hashes históricos V1/V2. |
| scripts/modelos-oficiais.integration.cjs | Esperar template V3 e validar PDFs com 1 ano e 2 anos nos ciclos completos. |
| scripts/modelos-oficiais.pdf.py | Conferir os textos corrigidos nos PDFs extraídos, além de fontes, margens e hashes. |
| scripts/revisao-operacional.integration.cjs | Conferir slot mantido com hold técnico e remarcação real; permitir idade sintética no helper de fixtures. |
| scripts/revisao-operacional.navegador.cjs | Cobrir slot idêntico, troca somente de horário, retorno ao original e mudança de data. |
| scripts/admin-contrato.integration.cjs | Ler a revisão atual no clone, em vez de presumir revisão 1 após a elaboração iniciada manualmente. |
| RELATORIO_ACABAMENTO_CONTRATO_V3.md — novo | Relatório desta entrega. |

A adaptação do teste administrativo foi necessária porque a primeira execução encontrou a elaboração atual do teste manual. O erro era a revisão fixa no teste; não foi alterada a validação de revisão otimista do produto.

## Testes executados e resultados

| Bateria | Resultado final |
|---|---|
| Contrato unitário: documentos, snapshot e acesso | **34 passaram**, incluindo 27 de documentos. |
| Modelos oficiais + revisão operacional 014 | **45 verificações passaram**, incluindo seis ciclos documentais e 11 cenários concorrentes. |
| Autenticação e Contrato administrativo | **30 verificações passaram**, incluindo assinatura, BYTEA imutável e OTP. |
| Acabamento integrado / Fechamento / edição / Pricing | **29 verificações passaram**. |
| Disponibilidade unitária e proteções concorrentes da 014 | Passaram. |
| Comercial, condição de pagamento e PricingService | Passaram. |
| Pagamentos: unitário, engenharia, HTTP e concorrência | Passaram. |
| Identidade: repository, service e Fechamento | Passaram. |
| Navegador administrativo 014, desktop/mobile | Passou, sem erros de página; sem rótulo de remarcação para slot idêntico e com hold para mudança real. |
| Navegador de acabamento, desktop/mobile | Passou: login, edição, assinatura, impressão, CRM, logout e convidados públicos. |
| PDF: seis documentos, 18 páginas | Texto, singular/plural, correções gramaticais, negritos, margens e hashes passaram; inspeção visual concluída. |
| Comparação física com o checkpoint atual | Passou, sem divergências. |
| TypeScript | Passou. |
| Lint direcionado dos 10 arquivos TS/TSX/CJS modificados | Passou. |
| Build de produção | Passou, usando acesso autorizado às fontes externas já utilizadas pelo projeto. |

As entregas de OTP foram capturadas no ambiente isolado, exercitando os serviços reais de desafio/validação e aceite. Não houve envio externo para clientes. Avisos preexistentes de módulo Node e raiz inferida na cópia de build não impediram a execução; as configurações do projeto foram preservadas.

Evidências: [integridade atual](<D:/glass/KidMais Manager/kidmais-manager/.tmp/acabamento-v3-integridade.json>), [lint direcionado](<D:/glass/KidMais Manager/kidmais-manager/.tmp/acabamento-v3-lint.json>), [modelos/PDF](<D:/glass/KidMais Manager/kidmais-manager/.tmp/modelos-oficiais/qualidade-pdf.json>), [revisão 014](<D:/glass/KidMais Manager/kidmais-manager/.tmp/revisao-operacional-resultados.json>), [navegador](<D:/glass/KidMais Manager/kidmais-manager/.tmp/navegador-revisao.json>), [regressões](<D:/glass/KidMais Manager/kidmais-manager/.tmp/regressoes-014.json>) e [build](<D:/glass/KidMais Manager/kidmais-manager/.tmp/qualidade-014.json>).

Os documentos já persistidos continuam com seu texto original. As correções aparecem somente ao gerar um novo PDF permitido pelo fluxo. Nenhum PDF assinado deve ser regenerado para receber esse acabamento.

Trabalho encerrado neste escopo. Aguardando aprovação do usuário.
