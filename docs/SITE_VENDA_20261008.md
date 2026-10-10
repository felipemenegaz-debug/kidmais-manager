# Site de venda Kidmais Manager — 08/10/2026

Implementação local para revisão de Felipe. **Sem commit, push, PR, merge, deploy, migration ou alteração de variável no Render.**

Atualização de 09/10: decisões posteriores de D2 e preparação do catálogo compartilhado estão em [INTEGRACAO_PLANOS_20261009.md](INTEGRACAO_PLANOS_20261009.md). O relatório abaixo registra a entrega original; a cobrança ainda não foi conectada aos três planos.

## Base e escopo

- Clone: `D:/glass/KidMais Manager/kidmais-manager-site-venda-20261008`.
- Branch: `codex/site-venda-20261008`, criada de `staging`, base `fb30f70cd06d6522e88475e5185b314612f30f93`.
- Referência: `D:/glass/KidMais Manager/UX-Design/site-venda-20261008/referencia-site-venda.html`, preservada.
- Landing em `/conheca`. `/` continua respondendo 307 para `/disponibilidade`.
- `/planos` usa os mesmos componentes, catálogo e visual; mantém `situacaoCadastro().ativo` e a mensagem fechada: “O cadastro on-line abre em breve. Fale com a Kidmais para começar.”
- A vitrine não escolhe plano no backend. Os três CTAs usam `/cadastro`. Cobrança, paywall, regras de acesso, banco e textos/hashes legais existentes permanecem intactos.

## Implementação

| Arquivos | Responsabilidade |
| --- | --- |
| `app/conheca/page.tsx`, `app/planos/page.tsx` | Rotas dinâmicas e metadata |
| `components/site/Site.tsx`, `secoes.tsx`, `Planos.tsx`, `elementos.tsx` | Estrutura e conteúdo renderizados no servidor; cadastro, contato, rodapé e selos |
| `components/site/Abas.tsx`, `CicloPlanos.tsx` | Únicas ilhas client: seis abas acessíveis e seletor mensal/anual |
| `components/site/telas.tsx` | Ilustrações HTML/CSS, `role="img"`, rótulos e dados fictícios |
| `components/site/site.module.css`, `estilos.ts`, `fonte.ts` | CSS isolado, animações, responsividade e fontes locais pelo Next |
| `lib/site/catalogo.ts`, `configuracao.ts`, `abas.ts`, `metadata.ts` | Preços/status centralizados, configuração, copy das abas e SEO |
| `lib/site/site.test.ts` | Testes de catálogo, preços, configuração, renderização e gates |
| `components/cadastro/DocumentoLegal.tsx` | Apenas IDs nas seções existentes para links de cancelamento e tratamento de dados |
| `lib/assinatura/texto.test.ts` | Aponta o teste existente de pluralização para o novo componente que contém o texto |
| `public/site/og-site-venda.png` | Open Graph estático 1200×630, visual meia-noite |
| `scripts/site-venda-ui.cjs` | QA reproduzível com Playwright do runtime Codex e axe-core existente nas dependências |
| `docs/evidencias/site-venda-20261008/` | Capturas, comparação e resultados medidos |

Fontes: Bricolage Grotesque variável com eixo óptico `opsz`, Figtree 400/500/600, usando `next/font/google`. Sem import de fonte externo no navegador, biblioteca de animação ou formulário de demonstração.

A ordem das seções segue a referência, inclusive as 12 perguntas em `details`, convite, cinco etapas e recibo âncora. Os componentes usam as mesmas regras do catálogo em toda a vitrine. Valores monetários comerciais são calculados em centavos: anual = 10×; Fundador = 60%; âncora = R$ 702. A flag desligada oculta esses valores também no HTML dos cards. Valores nas telas ilustrativas são dados fictícios, não preços da assinatura.

## Catálogo e evidência de produção

Consulta **somente leitura** pelo plugin Render, skill `render-env-vars`, operação `get_service`, em 08/10/2026. Serviço `kidmais-manager-production`, ID `srv-dak77m2d0e5s73b8rkkg`, workspace `tea-daidbj95efls73d2bcf0`: metadados confirmaram serviço ativo, repositório esperado, branch `production`, auto deploy desligado e previews desligados.

Essa operação **não retorna variáveis de ambiente**. As ferramentas Render disponíveis não expõem leitura das flags; a ferramenta de alteração de ambiente não foi usada. Portanto não foi possível comprovar ativação das funcionalidades abaixo. Nenhum segredo foi lido, impresso ou alterado. A existência de código em staging não foi tratada como comprovação de produção.

| ID | Recurso | Status inicial | Evidência / pendência |
| --- | --- | --- | --- |
| agenda | Agenda e disponibilidade | disponivel | Implementação na base staging; ativação em production não auditada |
| clientes | Clientes e aniversariantes | disponivel | Implementação na base staging; ativação em production não auditada |
| festas | Festas e pacotes | disponivel | Implementação na base staging; ativação em production não auditada |
| contratos | Contratos pelo celular | disponivel | Implementação na base staging; assinatura via WhatsApp tem status separado |
| orcamento | Orçamento online | disponivel | Implementação na base staging; ativação em production não auditada |
| horarios | Horário nobre e adicionais | disponivel | Implementação na base staging; ativação em production não auditada |
| financeiro | Financeiro | disponivel | Implementação na base staging; ativação em production não auditada |
| pix | Pix copia e cola | disponivel | Implementação na base staging; usa chave da empresa |
| exportacao | Exportação dos dados | disponivel | Implementação na base staging; produção não exercitada |
| permissoes | Papéis e permissões | disponivel | Implementação na base staging; produção não exercitada |
| multiunidade | Unidade extra | disponivel | Implementação na base staging; oferta comercial depende de D2 |
| suporte | Suporte | disponivel | Oferta humana da referência; canais dependem de D4 |
| implantacao | Implantação assistida | disponivel | Oferta humana da referência; recursos de IA têm selos separados |
| walle_whatsapp | Wall-e no WhatsApp | **em_breve** | Planejamento; entrega de mensagens não comprovada |
| walle_publicitario | Wall-e publicitário | **em_breve** | Protótipo local informado; sem ativação comprovada |
| cartao | Cartão de crédito nas parcelas | **em_breve** | Conexão da conta Asaas do buffet não comprovada |
| convite | Convite da festa | **em_breve** | Módulo sem homologação/ativação comprovadas |
| assinatura_whatsapp | Assinatura com código pelo WhatsApp | **em_breve** | Entrega Gupshup não comprovada |
| copiloto | Copiloto | **em_breve** | Não foi possível ler `AI_READ_ENABLED`, `AI_COPILOTO_MODEL_ENABLED`, `AI_OPERACIONAL_ENABLED` |
| importacao_contratos | Importação de contratos PDF | **em_breve** | Não foi possível ler `AI_CONTRACT_IMPORT_ENABLED`, `CONTRACT_IMPORT_INTEGRATION_ENABLED` |
| importacao_precos | Importação da tabela de preços por IA | **em_breve** | Sem comprovação de ativação em production |

O catálogo está pronto para revisão de Felipe, não se presume aprovado. Os oito itens futuros continuam “Em breve”, inclusive quando incluídos ou citados nos planos, perguntas e ilustrações. O copiloto prepara rascunhos e exige revisão/confirmação; não se promete execução automática. Não são anunciadas quantidades de créditos, envio automático de convites, check-in, vídeo, lista nominal ou compra de créditos de convite.

## Configuração

Nenhuma variável foi criada ou alterada em ambiente remoto; não foi criado `.env.local`.

| Variável lida pelo site | Sem configuração / regra |
| --- | --- |
| `SITE_PRECOS_PUBLICADOS` | Somente o literal `true` publica preços. Ausente/false: “Preço a definir” |
| `SITE_RAZAO_SOCIAL` | “a definir” |
| `SITE_CNPJ` | “a definir” |
| `SITE_ENDERECO` | “a definir” |
| `SITE_ATENDIMENTO_EMAIL` | “a definir” |
| `SITE_ATENDIMENTO_WHATSAPP` | “a definir” e nenhum botão WhatsApp. Número válido com DDI gera links com mensagens distintas de contato/Fundador |
| `SITE_ATENDIMENTO_HORARIO` | “a definir” |
| `SITE_ENCARREGADO_DADOS` | “a definir” |
| `SITE_URL` | Origem opcional para canonical/OG; fallback à configuração existente `ADMIN_AUTH_ORIGIN`. Sem ambas, URLs relativas, sem inventar domínio |

`SITE_PRECOS_PUBLICADOS` já existia na aplicação; agora controla a vitrine inteira. O estado de cadastro continua vindo de `situacaoCadastro()`, sem duplicar suas condições. O preço do Wall-e publicitário sempre fica “A definir”. E-mail e número sintéticos do QA não são configuração comercial nem destinatários reais utilizados.

**Não publicar production com os campos legais/de atendimento vazios.** Preencher e revisar esses dados, os textos legais definitivos e a origem de canonical/OG antes de autorizar publicação. Os documentos atuais continuam identificados como minutas; seus conteúdos e hashes não foram reescritos. A âncora de cancelamento aponta à seção existente “Contato”; D4 inclui a redação definitiva das condições.

## Validação

| Comando / verificação | Resultado |
| --- | --- |
| `npm ci` | Concluído; lockfile preservado |
| `node --experimental-strip-types --test lib/site/site.test.ts lib/assinatura/texto.test.ts` | 8/8 aprovados |
| `npx tsc --noEmit` | Aprovado |
| `npx eslint app/conheca app/planos components/site components/cadastro/DocumentoLegal.tsx lib/site lib/assinatura/texto.test.ts scripts/site-venda-ui.cjs` | Aprovado |
| `npm run check:v1:static` | 2103 testes + 103 testes do harness mock aprovados; lint, TypeScript, build e leitura PDF do asset de produção aprovados |
| `npm run build` | Aprovado também separadamente |
| `git diff --check` | Sem erros de whitespace |
| Playwright no Chrome local, build de produção | Cenários abertos/fechados, telas e medições registrados em `resultados.json` |

O check estático completo passou após a separação servidor/client dos planos. Os últimos ajustes de apresentação/semântica (grupo ARIA, links sublinhados e fundo do botão flutuante) também passam por TypeScript, lint, novo build e nova execução do navegador.

O host tem Node 24.20.0; o projeto declara Node 22.23.2. Os comandos passaram, mas esta execução não substitui a CI na versão fixada. `npm ci` informou 8 vulnerabilidades altas e 1 crítica preexistentes; dependências não foram atualizadas nesta entrega. O check completo mantém um warning preexistente de `FinalidadeSkill` não utilizado em `lib/inteligencia/skills/catalogo.ts`. Avisos de módulos experimentais/CRLF do host não foram tratados alterando configuração global.

O QA inicia dois servidores locais com dados sintéticos, remove variáveis de banco e não envia formulários nem chama provedores reais. Verifica:

- Larguras 360, 390, 560, 768, 1000, 1280 e 1440 sem overflow; fundo meia-noite inclusive com tema claro do host.
- Seis abas por mouse e por setas, Home/End, foco e `aria-selected`.
- `prefers-reduced-motion` sem nenhuma animação remanescente, incluindo pseudoelementos.
- Preços e WhatsApp condicionais; CTAs de cadastro ausentes com cadastro fechado.
- `/` com redirect preservado; `/cadastro` com formulário original aberto e mensagem original fechado, sem submissão.
- Metadados, canonical, `lang=pt-BR`, nenhum formulário na landing, ausência de JSON-LD de preços, selos e âncoras legais.
- Admin continua `noindex`; zero erros de console ou página nos cenários registrados.

### Acessibilidade e contraste

Auditoria axe-core com regras WCAG 2 A/AA e 2.1 AA nos seis estados das abas em desktop e no estado anual móvel. Resultados por cenário em `resultados.json`. Fundos com gradientes, máscaras e pseudoelementos geram resultados **inconclusivos de contraste** no axe; zero violações automáticas não equivale a certificação integral.

Revisão manual: foco menta visível, navegação por teclado, labels, status textuais, links de parágrafo sublinhados e texto de itens excluídos acessível. Foram clareados textos secundários/cinzas e escurecidos os selos do recibo claro; o WhatsApp flutuante recebeu base escura para não perder contraste sobre o convite claro. Comparações conservadoras de luminância WCAG para a paleta: texto secundário `#9aa8c7` sobre `#283b63` = **4,64:1**; legenda `#a4b1ca` = **5,13:1**; texto principal `#eef3ff` sobre `#395773` = **6,79:1**; selo do recibo `#553082` sobre `#f3f0f8` = **8,74:1**; cinza do recibo `#6b6280` = **5,06:1**; texto Fundador `#3a2e4c` sobre `#bfa3ed` = **5,78:1**. Amostras não representam todas as combinações intermediárias de animação; revisão assistiva humana continua recomendada antes de publicação.

### Desempenho móvel

Valores finais e parâmetros são registrados em [resultados.json](evidencias/site-venda-20261008/resultados.json). Três navegações com cache desabilitado, viewport 390×844, toque/mobile, latência 150 ms, download 1,6 Mbps, upload 750 kbps e CPU 4× pelo CDP. LCP e CLS medidos com `PerformanceObserver`; rolagem animada de quatro segundos por `requestAnimationFrame`.

LCP nas três execuções: **1.596 s, 1.680 s, 1.648 s**. CLS: **0 nas três**. Rolagem: **493 frames**, intervalo médio **8.13 ms**, p95 **12.50 ms**, **0 frames acima de 50 ms**. Todos os LCP ficaram abaixo de 2,5 s; todos os CLS abaixo de 0,1.

É uma simulação móvel no computador local, **não uma medição em aparelho físico fraco nem garantia de desempenho em produção**. Não houve redução dos efeitos aprovados. As animações não causaram CLS nos cenários medidos.

## Telas e comparação

[Abrir referência e implementação lado a lado](evidencias/site-venda-20261008/comparacao.html).

| Tela | Desktop 1280 px | Celular 390 px |
| --- | --- | --- |
| Topo | [PNG](evidencias/site-venda-20261008/1280-topo.png) | [PNG](evidencias/site-venda-20261008/390-topo.png) |
| Diferenciais | [PNG](evidencias/site-venda-20261008/1280-diferenciais.png) | [PNG](evidencias/site-venda-20261008/390-diferenciais.png) |
| Aba orçamento | [PNG](evidencias/site-venda-20261008/1280-aba-1.png) | [PNG](evidencias/site-venda-20261008/390-aba-1.png) |
| Aba agenda | [PNG](evidencias/site-venda-20261008/1280-aba-2.png) | [PNG](evidencias/site-venda-20261008/390-aba-2.png) |
| Aba contratos | [PNG](evidencias/site-venda-20261008/1280-aba-3.png) | [PNG](evidencias/site-venda-20261008/390-aba-3.png) |
| Aba financeiro | [PNG](evidencias/site-venda-20261008/1280-aba-4.png) | [PNG](evidencias/site-venda-20261008/390-aba-4.png) |
| Aba importação | [PNG](evidencias/site-venda-20261008/1280-aba-5.png) | [PNG](evidencias/site-venda-20261008/390-aba-5.png) |
| Aba copiloto | [PNG](evidencias/site-venda-20261008/1280-aba-6.png) | [PNG](evidencias/site-venda-20261008/390-aba-6.png) |
| Wall-e | [PNG](evidencias/site-venda-20261008/1280-wall-e.png) | [PNG](evidencias/site-venda-20261008/390-wall-e.png) |
| Convite | [PNG](evidencias/site-venda-20261008/1280-convite.png) | [PNG](evidencias/site-venda-20261008/390-convite.png) |
| Planos mensal | [PNG](evidencias/site-venda-20261008/1280-planos-mensal.png) | [PNG](evidencias/site-venda-20261008/390-planos-mensal.png) |
| Planos anual | [PNG](evidencias/site-venda-20261008/1280-planos-anual.png) | [PNG](evidencias/site-venda-20261008/390-planos-anual.png) |
| Dúvidas | [PNG](evidencias/site-venda-20261008/1280-duvidas.png) | [PNG](evidencias/site-venda-20261008/390-duvidas.png) |
| Rodapé | [PNG](evidencias/site-venda-20261008/1280-rodape.png) | [PNG](evidencias/site-venda-20261008/390-rodape.png) |

[Cadastro fechado e preços desligados](evidencias/site-venda-20261008/390-planos-fechados-sem-precos.png). Nos recortes de seções extensas, cabeçalho sticky e WhatsApp fixo são ocultados **somente durante a captura** para não atravessar a imagem; a captura do topo mantém ambos. Animações ficam ligadas, portanto o instante das bordas/luzes varia entre imagens.

Diferenças restantes em relação ao HTML aprovado:

1. Retirada da faixa “Exemplo para revisão”, tracejados âmbar e placeholders, conforme pedido. Isso reduz a altura antes do hero.
2. Selos “Em breve” adicionais quando uma promessa depende dos oito recursos não comprovados. Algumas linhas/cards ficam mais altos. Legendas de dados fictícios também foram completadas.
3. Formulário substituído por contato WhatsApp; ausência de número remove os botões; dados legais ausentes ficam “a definir”.
4. Links reais, mensagens do gate de cadastro e valores condicionais substituem links fictícios e preços incondicionais da referência.
5. “Profissional em destaque” substitui “Mais escolhido”, sem afirmar popularidade ainda não comprovada. A FAQ sobre mudança de plano declara condições em definição (D2); teste menciona recursos disponíveis e a FAQ de cancelamento remete às condições legais.
6. Tons secundários foram ajustados para contraste; links em parágrafos são sublinhados. Fundo escuro do botão flutuante mantém os mesmos efeitos de vidro e borda, garantindo legibilidade sobre áreas claras.
7. Em telas estreitas, estatísticas do topo e rodapé usam uma coluna, status de linhas de mock passam para uma segunda linha e palavras podem quebrar, evitando overflow a 360 px. Breakpoints 1000/560 preservados.
8. Pequenas diferenças de quebra/altura decorrentes de fontes servidas localmente, badges e estados condicionais. Não se reduziu movimento nem se mudou a ordem das seções.

## Decisões pendentes — não executadas

| Decisão | Estado nesta entrega |
| --- | --- |
| D1 — rota/domínio | `/conheca` implementada para revisão, `/` intacto. Após decisão, o default de `app/conheca/page.tsx` pode ser reexportado em `app/page.tsx`; ajustar `ROTA_SITE` e origem/metadata ao destino escolhido |
| D2 — três planos versus cobrança de plano único | Catálogo comercial separado. Mesmo cadastro/teste para todos; seleção, upgrade/downgrade e cobrança dos três planos não implementados |
| D3 — demonstração com armazenamento | Sem formulário/backend, consentimento novo ou migration. Apenas contato configurável |
| D4 — identificação, atendimento e textos legais | Dados não inventados; minutas preservadas. Revisão/preenchimento obrigatório antes de publicar |
| D5 — publicidade e créditos | Wall-e publicitário “A definir”; sem quantidades de créditos de IA/convite; oferta final aguarda Felipe |
| D6 — preços em production | Nenhuma flag alterada. Default fechado; publicação depende de autorização explícita e configuração de produção |

Também pendentes: leitura autorizada das flags de produção por um meio que as exponha sem revelar segredos, homologação dos oito recursos, revisão final do catálogo por Felipe e medição em aparelho físico fraco. Nenhuma dessas pendências foi contornada prometendo disponibilidade.

## Reproduzir o QA

Após `npm ci` e build, em PowerShell no clone:

```powershell
$env:PLAYWRIGHT_MODULE_PATH='C:/Users/Glass/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'
$env:SITE_BROWSER_EXECUTABLE='C:/Program Files/Google/Chrome/Application/chrome.exe'
$env:SITE_REFERENCE_HTML='D:/glass/KidMais Manager/UX-Design/site-venda-20261008/referencia-site-venda.html'
node scripts/site-venda-ui.cjs
```

O script sobe e encerra servidores nas portas 3188/3189. Não usar arquivo de ambiente com credenciais reais para esse QA. Logs locais `site-*.log` são ignorados pelo Git; evidências revisáveis ficam no diretório documentado.
