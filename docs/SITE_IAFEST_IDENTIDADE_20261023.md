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
