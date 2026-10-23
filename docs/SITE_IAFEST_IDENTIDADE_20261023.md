# iA.Fest — identidade do site de venda — 23/10/2026

Felipe definiu iA.Fest como novo nome do sistema, forneceu quatro imagens da marca, pediu a logo isolada flutuando no fundo e a retirada temporária de Wall-e publicitário de toda a divulgação. Continuação da atualização autorizada do site em staging.

## Escopo implementado

- Cabeçalho e rodapé com o PNG do logotipo fornecido, nome acessível iA.Fest e filtro CSS para integrar o fundo escuro do arquivo à página.
- Textos, ações de contato, Copiloto ilustrativo, títulos e metadados de `/conheca` e `/planos` atualizados. Imagem de compartilhamento usa a apresentação fornecida; ícone SVG enquadra o símbolo do PNG original, sem redesenhar a marca.
- Símbolo isolado convertido em máscara luminosa de caracteres pelo renderer, a partir do PNG original. Substitui um item por região, mantendo a densidade, movimento, pausa, limites e proteção de texto existentes. Sem o nome no elemento flutuante.
- Wall-e publicitário removido do catálogo da vitrine, dos adicionais, da seção, FAQ e promessas de criação de posts/divulgação. Atendimento WhatsApp continua com seu status anterior. Nenhuma mudança de entrega ou preço dos demais recursos.
- Kidmais Festas preservada como empresa de origem e buffet de exemplo; URLs reais existentes continuam válidas.
- Metadados de termos/privacidade atualizados e nota de transição no leitor. O texto versionado e os hashes de aceite dos documentos legais permanecem intactos.

Não altera marca do painel administrativo, banco, contratos, contas, domínios, variáveis, cron ou produção. Alteração restrita ao site de venda e à apresentação dos documentos vinculados.

## Base, validação e operação

Worktree isolada `kidmais-manager-iafest-20261023`, base `8abbf66c0993fa5ee2bc05dbd541397ced959aa5`, mesmo SHA LIVE de staging no início. Checkouts anteriores preservados.

- Testes pertinentes: 18/18 (site e posicionamento), incluindo ausência da oferta publicitária e identidade nova no rodapé.
- ESLint dos arquivos alterados passou; build final e TypeScript passaram (78 páginas). Erro intermediário de tipagem da máscara corrigido antes da versão final.
- Revisão independente encontrou duas referências antigas no Copiloto e uma frase de publicação; corrigidas, revisão final aprovada.
- Navegador local sobre build de produção: desktop 1280 e celular 390 px. Logo carregada, máscara `marca=pronta`, sem overflow e sem erros; texto de `/conheca` sem Kidmais Manager, publicitário ou departamento de marketing. Símbolo legível nos espaços livres.
- Ajuste CSS final para o fundo da marca e ícone incluídos no build final; conferência remota após deploy ainda pendente neste registro.

Alvo único: web staging `srv-daif418ae00c73e8k2gg`, My Workspace `tea-daidbj95efls73d2bcf0`. Auto-deploy OFF; produção usa production e cron também tem auto-deploy OFF. Nenhuma configuração alterada. Deploy manual único, acompanhado até LIVE, health e conferência da página pública. Deploy anterior: `dep-dbdfv1rncjis73a2o6m0`.

## Resultado remoto confirmado

- SHA `aaaf2696cc7cb2521950ed96cf8af65a0cdbabaf`, deploy `dep-dbdgirvb9u1s739korng` LIVE em 23/10/2026 07:25:12Z (04:25 Brasília).
- Render: regressão estática completa aprovada (testes, lint, TypeScript e build). Health e `/conheca` HTTP 200.
- Navegador em staging: título iA.Fest, imagem do cabeçalho carregada, máscara do símbolo `pronta`, sem Kidmais Manager ou Wall-e publicitário no texto de `/conheca`, sem overflow horizontal/erros observados.
- Screenshot: `evidencias/site-iafest-staging-20261023.png`. Staging mantido aberto; servidor e aba locais encerrados.
- Nenhuma mudança de banco, env, domínios, cron, painel administrativo ou produção.

## Ajuste solicitado após a prévia — símbolo ao lado do nome

Felipe rejeitou o símbolo da logo flutuando. Removido todo o carregamento/máscara da marca do renderer de fundo; voltam apenas as figuras de festa. O componente Marca, compartilhado por cabeçalho e rodapé de `/conheca` e `/planos`, agora mostra o símbolo original à esquerda do nome, alinhado por flex, com tamanhos menores no celular e símbolo decorativo sem duplicar o nome acessível.

Validação: 18/18 testes pertinentes, lint, TypeScript e build passaram. Revisão independente aprovada. Navegador local em 1280 e 390 px: símbolo e nome na ordem correta nas duas marcas, sem overflow, sem dataset/carregamento de logo no fundo. Resultado remoto desta correção ainda pendente neste registro. Mantém os limites de operação anteriores.

Staging avançou para `bbb0b0f` durante a preparação (aplicadores manuais de agenda/CI/testes, sem delta runtime do site). Integrado sem conflito, sem executar aplicadores. Push fast-forward resultou em `fe0878dd9535a0cbe9793315b44b136cc9a17cef`. Aguardado o deploy da outra frente `dep-dbdgu8vb9u1s739lv090` ficar LIVE antes de iniciar o deploy desta correção `dep-dbdh35dg1s2s73bg11fg`, às 07:49:41Z. Sem deploys simultâneos; resultado final ainda pendente.

Correção da logo confirmada LIVE em 23/10/2026 às 08:00:03Z, SHA fe0878d, deploy dep-dbdh35dg1s2s73bg11fg. DOM público confirmou símbolo à esquerda do nome em cabeçalho e rodapé e ausência de overflow.

## Marketing no site — 23/10/2026

Pedido: incluir a seção do módulo existente. Conferidos os componentes administrativos e lib/marketing: campanhas por canal com links rastreáveis, métricas por origem/campanha, tarefas para propostas paradas, pós-festa e recompra, sugestões de datas vagas. O transporte de mensagens é exclusivamente simulado (transporte.ts); a seção explica essa limitação e que publicação/gestão de anúncios continua nas plataformas. Não se trata do Wall-e publicitário pausado.

Seção com quatro cartões no padrão visual existente, fundo animado compartilhado, CTA para demonstração e links no menu/rodapé. Revisão independente conferiu fidelidade funcional e identificou o estilo riscado herdado; corrigido com classe própria. Testes pertinentes 18/18 e lint passaram. Primeiro build local interrompido sem conclusão; reexecução com mock local de fontes para não depender do download externo. Publicação desta seção ainda pendente.
Build/TypeScript concluídos com 78 páginas após executar fora do isolamento do terminal, com mock de fontes. Revisão independente final aprovada. Navegador local confirmou seção, quatro cartões sem risco no texto e sem overflow desktop. Nenhum formulário enviado.
Seção Marketing: push fast-forward fe0878d → 53b02951ad612e0a63441e85d7f1eb30a81e9a98. Deploy staging dep-dbdhec5g1s2s73bh5il0 iniciado às 08:13:36Z de 23/10/2026. Sem variáveis, banco, cron ou produção alterados. Servidor local encerrado.

Resultado Marketing: deploy dep-dbdhec5g1s2s73bh5il0 LIVE em 23/10/2026 08:24:01Z, SHA 53b02951ad612e0a63441e85d7f1eb30a81e9a98. Após 502 transitório da troca, página pública carregou; link Marketing navega para a seção, quatro cartões e nota de limitações presentes, sem overflow desktop. Evidência: evidencias/site-marketing-staging-20261023.png. Staging mantido aberto. Nenhuma alteração operacional além do deploy web autorizado.

## Ampliação dos módulos — 23/10/2026

Solicitados importação do modelo jurídico, festas fechadas e preços; financeiro detalhado; vários salões na mesma unidade; site do buffet dentro do Marketing. Conferidos ModeloContrato, IntegracaoContrato, AgendaConfiguracao, FinanceiroTelas e MarketingSite. Criadas seções #importacao (3 cartões), #financeiro (4), #saloes (3) e destaque de site/SEO em #marketing. Atualizadas abas e descrição de unidade extra, preservados selos existentes de importação e limitações das mensagens. Plano Essencial/financeiro completo diferenciados.

Código c8529e3 integrado sem conflito com origin/staging 030e833 (PR216, documentos por empresa), preservando a atualização concorrente. Testes unitários pertinentes após merge: 25/25; lint, TypeScript e build de 78 páginas passaram. Revisão independente aprovada. Navegador local conferiu cartões, âncoras e ausência de overflow desktop. Deploy concorrente dep-dbdiedg473hc73ei2n50 concluído antes da publicação desta frente. Sem banco, variável, cron ou produção alterados.
