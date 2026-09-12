# Modelos oficiais de Contrato — Essencial, Completa e Premium

Validação concluída em 10/09/2026, usando o estado atual da pasta e do PostgreSQL como referência. Ajuste restrito aos modelos/documentação de Contrato e seus testes. Nenhuma migration ou alteração de estrutura foi necessária.

## Resultado

| Pacote do snapshot | Identificador oficial para novos PDFs | Revisão do template | Convidado excedente |
|---|---|---|---|
| ESSENCIAL | FESTA_ESSENCIAL_V2 | 2 | R$ 110,00 |
| COMPLETA | FESTA_COMPLETA_V2 | 2 | R$ 130,00 |
| PREMIUM | FESTA_PREMIUM_V2 | 2 | R$ 150,00 |

Os três pacotes concluíram, em banco isolado, Fechamento → revisão administrativa → geração e revisão do PDF → assinatura Kidmais → liberação → validação OTP e aceite do cliente → versão vigente.

A revisão 2 do **template** é independente do número da **versão contratual**. Uma contratação nova V1 já usa o template revisão 2. Uma V2 contratual futura usa o modelo correspondente ao pacote do seu próprio snapshot.

## Inspeção inicial e solução

Antes da edição, o registry oferecia somente `FESTA_COMPLETA_V1`, revisão 1. A cláusula 3 continha R$ 120,00 fixos por pessoa excedente. O armazenamento administrativo gravava o identificador genérico `CONTRATO_ADMIN_V1` e a revisão 1 para todos os documentos.

Os valores vigentes estão centralizados em [configuracao.ts](<D:/glass/KidMais Manager/kidmais-manager/lib/contratos/documento/oficial/configuracao.ts>), em centavos inteiros: 11000, 13000 e 15000. Ali também ficam o nome oficial, identificador e revisão de cada modelo. O servidor resolve essa configuração pelo código do pacote do snapshot. O nome é obtido do registro oficial; não é herdado de um pacote anterior.

O renderer compartilhado [festas-v2.ts](<D:/glass/KidMais Manager/kidmais-manager/lib/contratos/documento/oficial/festas-v2.ts>) reutiliza a base jurídica Completa V1. Ele adapta somente a identificação do pacote, a tarifa na cláusula 3 e a marcação visual pedida. Não foram copiadas 18 cláusulas para três arquivos nem inventadas diferenças jurídicas. Os testes comparam todas as cláusulas e os demais blocos textuais com a base anterior, admitindo somente as substituições aprovadas.

A expressão aprovada “por pessoa excedente” foi preservada. O R$ 120,00 permanece apenas na referência histórica V1 e no reconhecimento/teste dessa redação anterior; não é a tarifa de nenhum novo modelo. Uma divergência inesperada da cláusula-base interrompe a renderização, evitando substituição silenciosa em texto diferente.

O formulário não ganhou campo de tarifa. Tentativas HTTP de enviar `excedenteCentavos`, `templateVersao` ou `modeloCodigo` na edição foram rejeitadas com 400. O renderer também foi testado com uma tarifa extra indevida, que não interfere no valor oficial.

## Aparência dos PDFs

Na cláusula 1, somente o nome do pacote, a data e a quantidade principal de pessoas ficam em Helvetica-Bold. Na cláusula 3, o trecho “R$ … por pessoa excedente” recebe o mesmo destaque. Os textos ao redor continuam com peso normal.

O gerador alterna as fontes dentro do mesmo objeto de texto do PDF, usando o posicionamento da própria fonte. Foram conferidos seis PDFs de três páginas cada: identificação, nomes, datas, convidados, fontes efetivas, 18 cláusulas, margens, rodapés e hashes. As 18 páginas foram renderizadas e inspecionadas visualmente, sem cortes ou sobreposições nos cenários testados.

## Preservação de documentos e dados

Foi criado antes da edição o checkpoint [pre-modelos-1789029529059](<D:/glass/KidMais Manager/kidmais-manager/.backups/pre-modelos-1789029529059>), com 336 arquivos, manifesto de hashes, dump do banco, catálogo e hashes de todas as linhas das 40 tabelas.

A conferência final do banco local encontrou:

- 40 tabelas com todas as linhas e valores idênticos ao checkpoint;
- os dois documentos BYTEA existentes integralmente preservados, incluindo conteúdo e hash;
- versões contratuais, dois Pagamentos reais e demais registros financeiros intactos;
- catálogo de colunas, constraints e triggers intacto;
- migrations, `schema_mvp_kidmais.sql`, `.env.local` e código de Pagamentos intactos.

Não houve backfill, substituição de PDF, nova migration ou atualização de documentos antigos. Os novos identificadores e revisões são inseridos nos campos `template_codigo` e `template_versao` já existentes, junto ao novo BYTEA.

A leitura pública continua entregando o PDF armazenado e agora também informa a identificação desse documento, evitando apresentá-lo como se fosse um template mais recente. A tentativa de gerar outro PDF sobre uma versão já assinada foi rejeitada nos três ciclos. Os testes de V2 conferem novamente o BYTEA/hash e a linha inteira da V1 após a promoção.

O renderer histórico V1 e suas cláusulas permaneceram sem edição. Um teste de referência fixa compara o PDF histórico com o hash obtido pelo código do checkpoint anterior: `328c0cd728828d9dc4c53ba23364135143da8ab76be8c715694d04699cb3a85f`. Essa é uma fixture sintética, não o hash de um contrato real.

Documentos legados assinados anteriores ao armazenamento BYTEA continuam sujeitos à restrição já existente: importação não autorizada e leitura que recusa regeneração. Esta entrega não faz essa importação.

## Trocas de pacote e Pagamentos

| Cenário concluído com assinatura e OTP | Novo documento | Preservação |
|---|---|---|
| Essencial → Completa | Festa Completa, R$ 130,00 | V1 e obrigação original intactas |
| Completa → Premium | Festa Premium, R$ 150,00 | V1 e obrigação original intactas |
| Premium → Completa, com revisão comercial aprovada | Festa Completa, R$ 130,00 | V1 e obrigação original intactas |

Os testes verificam também a ausência da tarifa anterior no trecho destacado. Em cada caso, o primeiro aceite não criou Pagamento automaticamente. Depois foi criado um Pagamento explicitamente para testar que a V2 não o substitui nem altera sua vinculação ou valores. O tratamento de pendência financeira segue a revisão operacional 014 existente.

## Arquivos desta entrega

São 17 arquivos: 11 existentes alterados e 6 novos, incluindo este relatório. Todos permanecem necessários. Caminhos abaixo relativos à pasta do projeto.

| Arquivo | Estado | Motivo |
|---|---|---|
| components/admin/ContratoAdmin.tsx | Alterado | Consultar disponibilidade dos três modelos no registro compartilhado; retirar o aviso incorreto para Essencial/Premium. |
| lib/contratos/documento/oficial/configuracao.ts | Novo | Fonte única de modelos, nomes, revisões e tarifas oficiais. |
| lib/contratos/documento/oficial/festas-v2.ts | Novo | Renderização compartilhada com a base jurídica preservada. |
| lib/contratos/documento/oficial/registry.ts | Alterado | Resolver os três modelos atuais e manter resolução histórica explícita V1. |
| lib/contratos/documento/oficial/models.ts | Alterado | Tipar revisão 2 e trechos destacados nas cláusulas. |
| lib/contratos/documento/oficial/pdf.ts | Alterado | Aplicar negrito parcial, preservando o caminho de renderização histórica sem destaques. |
| lib/contratos/documento/documento-core.test.ts | Alterado | Cobrir modelos, tarifas, cláusulas, fontes, entrada indevida e referência histórica de bytes. |
| lib/contratos/services/administrativo.service.ts | Alterado | Gravar identificador e revisão reais do template gerado. |
| lib/contratos/services/contrato-publico.service.ts | Alterado | Informar ao cliente o modelo do PDF armazenado. |
| lib/contratos/services/documento.service.ts | Alterado | Respeitar a revisão persistida ao resolver metadados históricos de versão assinada. |
| lib/contratos/storage/postgres.ts | Alterado | Receber revisão do template no INSERT existente; comprovantes continuam com revisão 1. |
| scripts/modelos-oficiais.integration.cjs | Novo | Seis ciclos documentais, três trocas, identificação persistida, imutabilidade e Pagamentos. |
| scripts/modelos-oficiais.integridade.cjs | Novo | Conferência somente leitura das 40 tabelas, catálogo e arquivos protegidos. |
| scripts/modelos-oficiais.pdf.py | Novo | Conferir hashes, texto, fontes, margens e renderizar os seis PDFs com Poppler. |
| scripts/revisao-operacional.integration.cjs | Alterado | Executar os novos ciclos no clone; conferir metadados públicos e rejeição de campos indevidos. |
| scripts/revisao-operacional.navegador.cjs | Alterado | Substituir a expectativa antiga de modelo Premium indisponível. |
| RELATORIO_MODELOS_OFICIAIS_CONTRATO.md | Novo | Relatório desta implementação e validação. |

Não foram alterados arquivos funcionais de Fechamento, Pricing, Comercial, Disponibilidade, Identidade/CRM, autenticação ou Pagamentos nesta entrega. Seus testes foram executados como regressão. Nenhum outro módulo foi iniciado. Checkpoint, logs, imagens e fixtures ficam separados em `.backups` e `.tmp` e não entram nessa contagem.

## Testes e resultados

| Bateria | Resultado |
|---|---|
| Contrato unitário: snapshot, documentos e acesso | 16 testes passaram, incluindo 9 de documentos. |
| Autenticação real e Contrato administrativo | 30 verificações passaram. |
| Acabamento / Fechamento / edição / Pricing / comercial | 29 verificações passaram. |
| Revisão operacional 014 + modelos oficiais | 44 verificações passaram, incluindo os 6 novos casos completos e 11 cenários concorrentes. |
| Comercial unitário e condição de pagamento integrada | Passaram. |
| Disponibilidade unitária | Passou. |
| Pagamentos unitário, engenharia, HTTP e concorrência | Todas passaram. |
| PricingService | Passou. |
| Identidade: repository, service e Fechamento | Passaram. |
| HTTP de consulta pública de CPF | Passou durante o teste de navegador, sem exposição cadastral indevida. |
| Navegador de revisão 014, desktop/mobile | Passou: edição, pacote Premium disponível, remarcação, congelamento, assinatura e cancelamento. |
| Navegador de acabamento, desktop/mobile | Passou: login, edição, assinatura, impressão, CRM, logout e convidados públicos. |
| PDFs | 6 documentos / 18 páginas; hashes, modelos, texto, fontes e margens passaram; inspeção visual concluída. |
| Integridade física local e verificação final 014 | Passaram, sem divergências. |
| TypeScript | Passou. |
| Lint direcionado | Passou. |
| Build de produção | Passou. |

As operações funcionais e testes HTTP/concorrentes usaram clones do PostgreSQL; o banco local foi apenas lido para backup e comparação. O navegador usou servidores isolados nas portas 3100/3101. O servidor do usuário na porta 3000 não foi substituído.

O primeiro build foi bloqueado pelo sandbox ao baixar Geist/Geist Mono. A execução com acesso autorizado à rede passou. Permanecem avisos preexistentes sobre tipo de módulo Node e raiz inferida na cópia isolada de build; não foi alterada a configuração do projeto para ocultá-los. O OTP dos testes usou o serviço real de desafio/validação com entrega capturada no ambiente isolado; não foi testada entrega externa de SMS/WhatsApp.

## Evidências e reprodução

Resultados disponíveis em [integridade local](<D:/glass/KidMais Manager/kidmais-manager/.tmp/modelos-oficiais-integridade.json>), [ciclos dos modelos](<D:/glass/KidMais Manager/kidmais-manager/.tmp/modelos-oficiais/resultados.json>), [QA dos PDFs](<D:/glass/KidMais Manager/kidmais-manager/.tmp/modelos-oficiais/qualidade-pdf.json>), [revisão 014](<D:/glass/KidMais Manager/kidmais-manager/.tmp/revisao-operacional-resultados.json>), [regressões](<D:/glass/KidMais Manager/kidmais-manager/.tmp/regressoes-014.json>) e [qualidade/build](<D:/glass/KidMais Manager/kidmais-manager/.tmp/qualidade-014.json>).

Os comandos abaixo foram executados no PowerShell, na pasta `D:\glass\KidMais Manager\kidmais-manager`. O script de modelos é chamado pelo runner 014, que cria seu próprio clone. O script de integridade depende do checkpoint preservado nesta máquina.

```powershell
node --env-file=.env.local scripts/admin-contrato.integration.cjs
node --env-file=.env.local scripts/acabamento.integration.cjs
node --env-file=.env.local scripts/validacao-funcional-014.cjs
node --env-file=.env.local scripts/revisao-operacional.integration.cjs
node --env-file=.env.local scripts/acabamento-navegador.integration.cjs
node --env-file=.env.local scripts/revisao-operacional.navegador.cjs
& 'C:/Users/Glass/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe' scripts/modelos-oficiais.pdf.py
node --env-file=.env.local scripts/modelos-oficiais.integridade.cjs
node --env-file=.env.local scripts/verificacao-final-014.cjs
node --env-file=.env.local scripts/qualidade-014.cjs
```

O QA Python usa pdfplumber e Poppler do runtime disponível. O build requer acesso às fontes externas já utilizadas pelo projeto.

Entrega encerrada neste escopo. Aguardando aprovação do usuário antes de avançar.
