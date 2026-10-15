# Privacidade para o cadastro Meta — minuta local de 15/10/2026

## Estado e escopo

**Preparada e validada localmente; publicação da minuta em staging em andamento.** Esta entrega amplia o aviso já existente em `/privacidade` para revisão do responsável e revisão jurídica. Não representa aprovação Meta, liberação para dados reais ou política definitiva.

Autorização: Felipe confirmou os dados de identificação e contato propostos e respondeu “pode fazer” à preparação local. A responsável informada é Mary Marra Menegaz – EPP, nome fantasia KidMais Festas; os dados constam do texto canônico. Não houve consulta cadastral oficial. Demerzel Labs não foi indicada como responsável.

Base: `origin/staging` em `eb6ca81`, worktree `kidmais-manager-privacidade-meta-20261015`, branch `codex/privacidade-meta-20261015`. O checkout histórico `kidmais-manager-site-venda-20261008` tinha texto anterior e alterações locais; foi preservado.

Até a preparação local não houve push, merge ou deploy. Em seguida Felipe pediu “termine tudo e me de a url da Política de Privacidade”, autorizando concluir a disponibilização pública desta página. Alvo desta entrega: staging existente, sem promoção para produção. Não inclui DNS, banco, configuração de provedor ou envio de informações à Meta/Gupshup. Não foram lidas credenciais reais.

## Implementação

- `lib/cadastro/documentos-legais.ts`: identificação do responsável; dados e finalidades; cookies de acesso; clientes dos buffets; crianças e dados sensíveis; WhatsApp e IA; prestadores; transferências internacionais; retenção; direitos e instruções para exclusão por e-mail.
- `app/privacidade/page.tsx`: descrição da página nos metadados.
- `components/cadastro/DocumentoLegal.tsx`: seção de direitos com âncora `/privacidade#exclusao-de-dados`. Mantida `/privacidade#tratamento-de-dados`.
- `lib/cadastro/cadastro.test.ts`: verifica que um cadastro novo não aceita a versão anterior da privacidade.

O banner de minuta e os campos `[A DEFINIR]` foram mantidos. Nenhuma garantia de anonimização completa, expiração automática universal ou exclusão em aparelhos/terceiros foi introduzida.

### Informações posteriores fornecidas por Felipe

Ainda em 15/10/2026, Felipe informou uso de **Render, Gupshup/Meta e IA com clientes reais**, identificou **OpenAI** como provedora de IA e confirmou **“sem exclusão automática”** para conversas do WhatsApp. A minuta foi ajustada para refletir esse relato: não afirma mais que a operação efetiva está restrita a testes nem que exista exclusão automática. Resend/Asaas não foram confirmados como ativos; o inventário completo permanece pendente. Não foram verificadas configurações remotas, contratos, região, retenção da OpenAI ou rotinas em execução.

**Divergência operacional aberta:** `PRIVACIDADE_ATENDIMENTO_D1_D4.md` registra restrição a dados sintéticos/contatos controlados e pendências D1–D4/R6. O relato de uso real não comprova resolução dessas pendências. A atualização do aviso não altera flags, autorizações, controles técnicos ou aquela documentação histórica e não representa liberação adicional de uso real. É necessário reconciliar o estado operacional e as decisões registradas; a minuta não deve ocultar o uso que foi informado enquanto isso.

## Versões e integridade

| Documento | Versão | SHA-256 do texto canônico |
| --- | --- | --- |
| Privacidade anterior | `2026-10-13-minuta` | `f86da4d4521931af5221a2268a3291967fd5f04c7016e309ddb17d8879d69940` |
| Primeira minuta local (histórico) | `2026-10-15-minuta` | `e666f47968f8c07f348a26a669602aae5406b758c19d668e254df406a858d0c2` |
| Revisão OpenAI (histórico local) | `2026-10-15-minuta2` | `94ccbea9d86523286cd88c9d109bf787e00ac240a89ed16591bb2c87dde52721` |
| Revisão sem exclusão automática (histórico local) | `2026-10-15-minuta3` | `301a9c617259a4927b4df5f8b41bb651ad09a98920186893683baca2e6727383` |
| Privacidade atual, novo contato | `2026-10-15-minuta4` | `0b2e6d8cd7aa76672c757fc8b1537cd77baaea0bb8c5675bcb6a986c81780ae4` |
| Termos, sem alteração | `2026-10-13-minuta` | `b79f469969a540bd7a644565745756bf3ccc62e0c470be1a3b6a398805d3b37d` |

As funções de hash e persistência de aceites não mudaram. Aceites históricos não foram regravados; nenhuma migration é necessária. A comparação de versão existente passa a recusar novos pedidos com a versão antiga da privacidade.

## Validação local

- Testes `node --experimental-strip-types --test lib/cadastro/cadastro.test.ts`: **6/6 PASS**, com banco simulado.
- TypeScript `tsc --noEmit --incremental false`: **PASS**.
- ESLint nos quatro arquivos de código alterados: **PASS**.
- `npm.cmd run build`: **PASS**, incluindo TypeScript e geração estática de `/privacidade` e `/termos`. A tentativa inicial no sandbox ficou parada; foi interrompida e a repetição fora do sandbox concluiu. Não houve deploy.
- `git diff --check`: **PASS**.
- Navegador local em `http://localhost:3186/privacidade`: página acessível sem login, versão e impressão digital correspondentes; identificação, banner de minuta e seção de exclusão visíveis. A âncora de exclusão foi conferida. Layout existente preservado; sem nova homologação visual mobile.
- Revisão independente somente leitura da primeira minuta: um ajuste editorial solicitado, para abranger todo o Atendimento WhatsApp na restrição de homologação; corrigido e conferido. Essa descrição factual foi posteriormente atualizada pelo relato de Felipe. A revisão incremental de `minuta2` não encontrou novos problemas técnicos e distinguiu uso declarado de verificação operacional. Não equivale a aprovação jurídica ou autorização de publicação.

Ambiente de validação: Node `24.20.0`, Next `16.3.4`. O `package.json` exige Node `22.23.2`; não foi alegada validação nessa versão. Instalação com `npm ci --ignore-scripts`, sem alteração do lockfile; o npm reportou 9 vulnerabilidades nas dependências existentes (8 high, 1 critical), não investigadas ou corrigidas nesta alteração textual.

## O que falta antes da versão definitiva

1. Concluir acordo de tratamento e responsabilidades plataforma/empresa cliente; confirmar finalidades e bases legais, com avaliação específica para dados sensíveis e de menores.
2. Verificar por ambiente os prestadores informados como ativos, dados compartilhados, países e mecanismos de transferência internacional, inclusive condições da OpenAI. Reconciliar uso real declarado com as pendências D1–D4/R6. O relato de uso e a presença da integração no código não atestam controles ou configuração remota.
3. Definir prazos de retenção para conta, contratos, logs, backups, controles de não contato e registros de exclusão; documentar o procedimento de retenção e exclusão e, se houver futura automação, validar sua execução. A ausência atual de exclusão automática foi informada por Felipe; não equivale a uma decisão de guarda ilimitada. Não inventar prazo para preencher a minuta.
4. Concluir inventário de cookies/armazenamento e definição sobre encarregado quando aplicável.
5. Concluir revisão jurídica (D11), elaborar nova versão definitiva e revisar o impacto sobre os aceites.
6. Publicar e conferir a URL sem login. O pedido posterior de Felipe autoriza disponibilizar esta página no staging existente; não remove a revisão jurídica D11 nem transforma a minuta em texto definitivo. A existência da URL não garante aprovação Meta.

## Fontes e evidências

- Código: `lib/acessos/email.ts` (Resend), `lib/assinatura/asaas.ts`, `lib/whatsapp/atendimento/transporte.ts`, `lib/identidade/delivery/gupshup.sender.ts`, `lib/inteligencia/modelos/openai-compativel.ts`, rotas de autenticação e confirmação do cadastro.
- Contexto técnico: `CADASTRO_PUBLICO_E6_20261007.md`, `PRIVACIDADE_ATENDIMENTO_D1_D4.md`, `OPERACAO_AGENTES.md`.
- [ANPD — direitos dos titulares](https://www.gov.br/anpd/pt-br/assuntos/titular-de-dados/direito-dos-titulares).
- [ANPD — Resolução 19, transferências internacionais](https://www.gov.br/anpd/pt-br/acesso-a-informacao/institucional/atos-normativos/regulamentacoes_anpd/resolucao-cd-anpd-no-19-de-23-de-agosto-de-2024).
- [Gupshup — obter Solution ID na Meta](https://partner-docs.gupshup.io/docs/get-solution-id-from-meta).

A página pública de staging foi observada nesta tarefa com versão `2026-10-13-minuta`, impressão digital `f86da4d45219`. Esta entrega local não a alterou.

### Revalidação da minuta3

Após as informações sobre OpenAI e ausência de exclusão automática: testes 6/6, ESLint dos dois arquivos modificados nesta revisão, build com TypeScript e `git diff --check` PASS. Conferidos hash dos termos intacto e HTML compilado com a nova impressão digital, OpenAI e ausência de exclusão automática. Prévia reiniciada em localhost:3186 e recarregada no navegador, exibindo `2026-10-15-minuta3` e o parágrafo atualizado. Revisão independente incremental sem novos problemas técnicos; sugestão documental sobre não pressupor automação incorporada. Nenhuma publicação externa.

### Atualização do canal de privacidade

Felipe indicou `glass@demerzellabs.com.br` para privacidade/exclusão. As duas referências na política foram atualizadas e a versão passou a `2026-10-15-minuta4`. Termos e contato de cancelamento permaneceram intactos. Endereço informado, sem teste de recebimento nem nomeação de encarregado. Testes de cadastro 6/6, ESLint, build com TypeScript e revisão independente incremental PASS. Nenhuma publicação externa ou alteração no Google Workspace.

### Preferência comercial sobre histórico (registro)

Felipe informou que considera melhor manter o histórico por mais tempo. Nenhum prazo foi escolhido e nenhuma guarda ilimitada foi aprovada. A preferência não altera a minuta3 ou a configuração de exclusão. Próximo passo: justificar os períodos por categoria/finalidade e definir revisão e atendimento de pedidos, distinguindo histórico útil, evidências contratuais e conteúdo desnecessário. Ver [orientação oficial sobre duração do tratamento](https://www.gov.br/dnit/pt-br/acesso-a-informacao/tratamento-de-dados-pessoais/perguntas-frequentes-sobre-a-lgpd-e-atuacao-da-agencia-nacional-de-protecao-de-dados-anpd/4-adequacao-a-lgpd/4-5-por-quanto-tempo).

## Verificação do procedimento de exclusão — 15/10/2026

**Resultado: funções parciais disponíveis no código; não há comprovação de exclusão integral de um titular.** Inspeção e testes simulados, sem banco, dados reais, serviços externos ou alteração funcional. A minuta4 foi preservada.

| Área | Evidência | Limite relevante |
| --- | --- | --- |
| Cadastro do cliente | `lib/clientes/services/lixeira.ts` muda status para INATIVO; `lib/clientes/lixeira.test.ts` confirma preservação de ID, vínculos e histórico | A ação chamada EXCLUIR na lixeira não elimina os dados pessoais; não usar como prova de atendimento integral ao titular |
| Conversa WhatsApp | `excluirDadosConversa` em `lib/whatsapp/atendimento/privacidade.ts` emite exclusão de mensagens/status/conversa e desvincula auditoria | SQL inspecionado, não executado nesta etapa; controles de não contato/pausa/equipe, hashes contra reentrega e auditoria podem permanecer; tarefas em andamento adiam a exclusão |
| Arquivos da biblioteca | Função específica de revogação, separada da conversa; conteúdo e link tratados pelo procedimento próprio | Excluir conversa não remove arquivos da biblioteca; cópias de destinatários, provedores e backups não são alcançadas |
| Acesso à função | Gestão da empresa ativa, senha recente e confirmação EXCLUIR; busca pelo número completo | Requer schema 082; instalação em ambiente real não foi consultada |
| Conta com restrição comercial | A rota de privacidade passa pela guarda comercial; `decidirPaywall` retorna 402 para POST em SOMENTE_LEITURA/BLOQUEADO | R9 permanece: pedido via e-mail pode ser recebido, mas o fluxo para sua execução nessas contas não está resolvido |

### Validação executada

`node --experimental-strip-types --test components/admin/atendimento/privacidade-tela.test.ts lib/clientes/lixeira.test.ts scripts/whatsapp-atendimento-retencao.test.mjs`: **29/29 PASS, zero pulados**. Tela usa API e reautenticação simuladas; lixeira usa executor de banco falso; script usa transporte HTTP falso. Cobrem confirmações, senha incorreta, restauração, isolamento por empresa, preservação de histórico e configuração/chamada simulada de retenção. Não comprovam a execução de DELETE no PostgreSQL nem o funcionamento em staging/produção.

Adicionalmente, execução da função pura `decidirPaywall` confirmou **402** para POST de privacidade nos dois estados comerciais restritos. Sem banco ou HTTP.

Os testes PostgreSQL existentes (`privacidade.postgres.test.ts` e `revogacao-envio.postgres.test.ts`) foram apenas consultados. Não foram executados: demandam alvo descartável identificado e autorização específica para operações de banco conforme `OPERACAO_AGENTES.md`. Não houve alteração de schema, flags de IA ou retenção.

### Procedimento proposto para revisão

1. Receber em `glass@demerzellabs.com.br`, registrar o pedido e confirmar a identidade com informações proporcionais. Não pedir senha ou código de verificação.
2. Identificar a empresa responsável, os números/e-mails vinculados e as categorias abrangidas pelo pedido. Quem acompanha operacionalmente o pedido ainda precisa ser definido.
3. Inventariar separadamente cadastro, conversa, arquivos, contratos, pagamentos e demais registros. Avaliar quais dados precisam ser preservados e por qual fundamento; não decidir pela lixeira automaticamente.
4. Para WhatsApp, quando autorizado e disponível, usar a função específica de privacidade; tratar arquivos por revogação própria. Se houver processamento, aguardar e repetir com verificação. Não afirmar conclusão sem conferir o resultado.
5. Registrar os dados removidos, os preservados e suas razões, além do encaminhamento a provedores/backups quando aplicável; responder ao solicitante. Não prometer remoção de cópias no aparelho de destinatários.

**Próxima entrega técnica a definir:** procedimento para eliminar/anonimizar os dados pessoais do cadastro sem destruir registros que precisem ser preservados, e caminho autorizado para pedidos de empresas com acesso comercial restrito (R9). Preparar critérios e testes de isolamento antes de implementar ou executar exclusão em banco. Uma frase na política não resolve essas lacunas.
