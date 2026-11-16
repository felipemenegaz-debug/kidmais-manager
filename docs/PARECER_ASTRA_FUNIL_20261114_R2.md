# Parecer Astra — Funil de oportunidades — R2 final

14/11/2026. Classe A, segunda e última rodada. **REPROVADO: 0 P1, 1 P2 de regressão nos pontos tocados.** Os quatro achados originais foram tratados, mas a conversão automática introduziu o bloqueante abaixo. Parar e levar a Felipe; não abrir terceira rodada automática.

Base2133d398f02f519170b443b5702c6b23b9da41b7, mesmo checkout/branch. Pedido R2, parecer R1, relatório técnico, nota do vault, regras e política operacional considerados. Conferidos diff rastreado e manifesto com arquivos novos, com foco no delta das correções. **50/50 hashes de arquivos e60/60 de evidências iguais.** Nenhum código da implementação corrigido nesta revisão, commit, push, PR, rede operacional ou ambiente real.

## Único achado bloqueante — P2-R2-1

**Conversão automática consome o contato sem herdar sua origem/campanha e impede completar a vinculação existente.** Local introduzido: `lib/oportunidades/conversao.ts:24`. Chamada de criação: `lib/fechamentos/services/fechamento.service.ts:200`. Recusa subsequente: `lib/marketing/contatos.ts:315`; herança que deixa de ser alcançada: `lib/marketing/contatos.ts:334`. Leitura dos resultados: `lib/marketing/atribuicao.ts:86`.

Reprodução:
1. Cliente recorrente C com negociação antiga. Registrar contato K com origem/campanha conhecida diferente da primeira origem do cliente e uma próxima ação pendente. Não registrar origem própria na nova negociação.
2. Criar negociação F para C pelo fluxo normal. O gancho herdarAcoesDoContato transfere a ação e agora grava K.fechamento_id=F/statusCONVERTIDO.
3. O gancho não chama atribuicaoVigente/registrarSeAusente nem escreve marketing_atribuicoes. A origem/campanha permanece somente em K.
4. Tentar concluir pelo fluxo existente vincular-negociacao(K,F): a linha315 retorna409 MARKETING_CONTATO_CONVERTIDO antes da herança de origem na linha334.
5. Consultar a origem da negociação recorrente: SQL_ORIGEM_NEGOCIACAO só usa atribuição própria de F ou primeira origem do cliente na primeira negociação; não consulta o contato vinculado. F fica sem origem/campanha correspondente, apesar de K estar marcado convertido. Perdas/receita por origem/campanha ficam incorretas até intervenção manual separada.

Esperado: a conversão que grava o vínculo preserva também a herança de atribuição já pertencente a esse fluxo (sem sobrescrever uma origem própria existente), ou mantém uma maneira de concluir essa herança. Antes da correção, o gancho não preenchia fechamento_id e ainda era possível executar a vinculação explícita que copia a atribuição. Portanto este bloqueio adicional é regressão da linha tocada, dentro do escopo R2. Não é pedido de novo recurso.

Prova própria em `docs/evidencias/astra-funil-r2/provas.mjs`: executa a função real com remoção de tipos/imports e executor/histórico falsos. Nos casos NULL→B e A→A, confirma o vínculo F e **zero escritas de atribuição**. Confere também a posição da recusa antes da herança no serviço existente. A consequência na leitura é demonstrada pelo SQL citado. **Não é reprodução PostgreSQL ponta a ponta**; não foram executados gatilhos nem UI nesta revisão. O fluxo de controle e a ausência da escrita são determinísticos; não dependem de concorrência ou hipótese de infraestrutura.

## Quatro achados originais

- **P2-1 corrigido no cenário original:** consultas.ts:9 e service.ts:38 usam vínculo do próprio contato, descarte antigo em contatos.ts:286 também. Histórico de outro fechamento não oculta nem bloqueia o retorno. A seleção explícita em conversao.ts:11 restringe a herança ao contato vinculado; outro contato permanece independente. Ressalva bloqueante acima no efeito novo da conversão automática.
- **P2-2 corrigido:** conversao.ts:17–25 alinha fechamento/ação e histórico; consultas.ts:17/23 e resumo.ts:19 adotam responsável do fechamento. Contadores já usam essa fonte. Prova própria executou NULL→B e A→A. Revisados os testes PG do implementador para cartão, filtro, Para hoje, ação divergente, envio falso, confirmação e perda.
- **P3-3 corrigido:** GET em app/api/admin/oportunidades/route.ts:19 informa capacidade comprovada; UI Oportunidades.tsx:20/25/34/41 omite controles/janelas. POST mantém a exigência de edição. Teste de componente e evidência AX do leitor examinados; não refiz login/navegador.
- **P3-4 corrigido:** resumo.ts:11–13 e35 incluem nome da empresa comprovada no assunto/cabeçalho, escapando HTML; chave de idempotência preservada. Sem novo achado P3 neste escopo.

## Provas, limites e encerramento

Execução própria: `env -u DATABASE_URL -u KIDMAIS_HOMOLOGACAO_DATABASE_URL node docs/evidencias/astra-funil-r2/provas.mjs` PASS; hashes50+60 e dois cenários da função real com executor falso. `git diff --check` PASS. Node24.20.0; não executei Node22 declarado. Resultado em `docs/evidencias/astra-funil-r2/resultado.json`.

Evidências do implementador examinadas, **não execuções próprias**: PG4/4, unitários/UI6/6, static5017+103 com lint/TS/build/PDF e capturas/AX locais. A confirmação de B no navegador foi fixture SQL, como declarado. Esses testes não verificam a atribuição de Marketing após a nova vinculação automática, por isso não contradizem o achado.

Migration122, rota de resumo, aplicadores, inventário/receita e exportação preservados por comparação de hashes; decisão123→122 não reaberta. Nada de publicação autorizado. Não reinstalei dependências, não criei cluster/servidor/build/temporário descartável; apenas parecer e provas preserváveis. Nada próprio a limpar.

**Encaminhamento a Felipe:** decidir o tratamento do P2-R2-1 após esgotado o teto da classe A. Trabalho de implementação parado; nenhuma correção silenciosa e nenhuma terceira rodada iniciada. Vault/fila/relato recebem esse estado, preservando o histórico.
