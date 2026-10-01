# UX de contratos, assistente e perfil

Evidência local de 01/10/2026, preparada na branch `codex/ux-contratos-perfil`, com base em `staging`. As capturas usam componentes reais e dados sintéticos, com todas as APIs interceptadas. Não comprovam operação em staging nem gravação em banco.

## Entrega

| Superfície | Comportamento |
| --- | --- |
| Assistente Kidmais | Cabeçalho curto, ações claras, estados vazio/carregando/erro, perguntas pendentes anunciadas e evidências recolhidas em “Dados usados”. Mantém confirmação, cancelamento, conversa, teclado e as capacidades existentes. O atalho de contratação abre a seleção de cliente no CRM. |
| Preparar contratação | Agrupa cliente, festa e pagamento; mostra resumo atualizado e pendências do schema existente. “Revisar contratação” apresenta a conferência sem POST. “Voltar e corrigir” conserva os campos; só a confirmação final chama o fechamento administrativo. |
| Contratos | Visão geral, Documentos, Financeiro e Histórico com teclado. Mantém os painéis montados, as versões, observações, diferenças, edição, retificação, PDF, revisão, assinatura, liberação, impressão, cancelamento e financeiro existentes. O próximo passo é derivado do estado recebido. |
| Perfil da Empresa | Campos agrupados, rótulos visíveis no celular e etapas editar/salvar/revisar. Marca indisponível fica recolhida. Mantém rascunho, revisão antes/depois, aplicação, histórico, normalização e conflito. Diferencia erro, carregamento e acesso negado. |

As cores usam as variáveis do tema administrativo existente. Os estilos de contratos e preparação são módulos locais; não alteram o CSS global. O administrador mantém o tema escuro também quando o sistema operacional prefere o tema claro.

## Fluxo real do Core

1. O CRM já oferece `/admin/clientes/[id]/fechamento` para um cliente existente.
2. `FechamentoAdminWizard` consulta o cliente autorizado por `GET /api/admin/clientes/[id]/fechamentos`, a disponibilidade e os adicionais pelas APIs existentes.
3. A nova conferência usa apenas o estado preenchido. A confirmação envia o mesmo schema e payload por `POST /api/admin/clientes/[id]/fechamentos`; preço oficial, regras comerciais e disponibilidade continuam no servidor.
4. O resultado aponta para `/admin/fechamentos/[fechamentoId]/revisao`. `RevisaoComercial` conserva decisão comercial, aprovação/rejeição e `POST /api/admin/contratos` para gerar o contrato.
5. O painel administrativo conserva revisão do PDF, reautenticação, assinatura Kidmais, liberação ao cliente, assinatura pública, novas versões e financeiro.

Não há API, serviço de domínio, migration, autorização, tenant, planner ou executor novo nesta entrega.

## Dependência de IA

A base consultada não tem capability para criar contrato/fechamento pelo chat nem um rascunho contratual transferível para esse formulário. O registro de ferramentas contém leituras de contratos e importação; isso não fornece criação de contratação pela conversa.

O cenário “Faça um contrato do Felipe, Premium, 70 convidados, 31/09 às 17h, Catarina 1 ano, tema unicórnio” é enviado integralmente e permanece no histórico. O teste simula uma resposta `nao_suportado` no protocolo atual, sem fabricar rascunho. **Não foi implementada nem comprovada a coleta conversacional desses campos, a pergunta do ano ou a correção de 31/09.** Essa parte depende da capability do backend e fica explicitamente pendente. A interface não transforma 31/09 em outra data nem descarta os dados enviados.

A preparação entregue funciona pelo cliente do CRM e pelo fechamento administrativo real. Seu calendário exige a seleção de uma data completa disponível; não recebe dados automaticamente da conversa.

## Acesso ao perfil

Um HTTP 403 genérico exibe a mensagem da API, com retorno às configurações e nova tentativa. A mensagem específica de concessão só é usada quando a API devolve `PERFIL_SEM_CONCESSAO`. A página não infere concessão ausente de outro 403 e não cria permissões. Falha HTTP 500 permanece erro de carregamento. Conflito de aplicação conserva o texto e bloqueia nova confirmação até a reconciliação existente.

## Validação

- `npm run check:v1:static`: **1.555 testes unitários + 103 testes do harness de staging**, ESLint, TypeScript e build aprovados. Harness somente com mocks. Um warning preexistente em `lib/inteligencia/skills/catalogo.ts` (`FinalidadeSkill` sem uso); zero erros de lint.
- Testes pertinentes de IA/UI, perfil, fechamento, contrato, pagamentos e apresentação financeira passaram. O harness de fechamento confirma que revisar não grava e que sessão expirada não cria fechamento.
- `scripts/ux-contratos-perfil.test.cjs`: desktop 1440×1000 e celular 390×844; abas pelo teclado, preservação de observações, pendências, revisão sem POST, retorno conservando campos e confirmação usando o payload existente; perfil carregando/403/concessão/500/rascunho/revisão/conflito; assistente vazio/carregando/erro/capability ausente e Escape. Assinatura e liberação verificadas com mocks. Zero erros de navegador, requisições inesperadas ou overflow horizontal.
- `scripts/festa-navegacao-ui.test.cjs`: regressão desktop/celular de versão, financeiro após carga, alterações, retorno e histórico; retorno inseguro rejeitado e nenhuma operação de pagamento.
- Preferências clara/escura verificadas em contratos e perfil. Capturas revisadas visualmente.
- Execução local em **Node 24.20.0**. O projeto exige **22.23.2**, que será usado pelo CI; essa diferença não foi ocultada nem alterou o arquivo de versão.
- `git diff --check` aprovado.

Resultados compactos: [UX](ux-contratos-perfil/resultados-ux.json) e [navegação](ux-contratos-perfil/resultados-navegacao.json).

Para repetir o navegador, instalar as dependências do projeto e disponibilizar Playwright com Chromium ou Edge. `PLAYWRIGHT_MODULE` pode apontar para o módulo já instalado. Executar `node scripts/ux-contratos-perfil.test.cjs` em worktree sem `.env`; o runner inicia e encerra seu próprio servidor local, usa banco inacessível e intercepta APIs. A rota `/preview-ux/contratos-perfil` exige `KIDMAIS_PREVIEW_UX=1`; fora do runner, permanece 404 por padrão.

## Capturas

| Tela | Desktop | Celular |
| --- | --- | --- |
| Assistente vazio | [Imagem](ux-contratos-perfil/ia-vazia-desktop.png) | [Imagem](ux-contratos-perfil/ia-vazia-celular.png) |
| Pedido de contrato sem capability | [Imagem](ux-contratos-perfil/ia-desktop.png) | [Imagem](ux-contratos-perfil/ia-celular.png) |
| Conferência da contratação | [Imagem](ux-contratos-perfil/revisao-desktop.png) | [Imagem](ux-contratos-perfil/revisao-celular.png) |
| Contratos | [Imagem](ux-contratos-perfil/contratos-desktop.png) | [Imagem](ux-contratos-perfil/contratos-celular.png) |
| Perfil | [Imagem](ux-contratos-perfil/perfil-desktop.png) | [Imagem](ux-contratos-perfil/perfil-celular.png) |
| Acesso negado no perfil | [Imagem](ux-contratos-perfil/perfil-acesso-desktop.png) | [Imagem](ux-contratos-perfil/perfil-acesso-celular.png) |

Adicionais: [revisão comercial](ux-contratos-perfil/revisao-comercial-desktop.png), [conflito no perfil](ux-contratos-perfil/perfil-conflito-desktop.png), [documentos](ux-contratos-perfil/documentos-desktop.png).

## Limite operacional

Trabalho restrito ao worktree dedicado. Nenhuma alteração no checkout de Claude. CI consultado executa verificações estáticas e testes com mocks; não contém deploy. Metadados do serviço `kidmais-manager-staging` serão revalidados imediatamente antes do push e registrados na PR. Não houve merge, deploy, acesso à produção, concessão de permissão ou conexão a banco real.
