# Admin V1 — revisão visual

Estado: **VISUAL REVIEW READY**, sujeito à revisão humana. Nenhum deploy realizado.

## Fontes e aprovação

O [inventário](inventario-fontes.md) e o [mapa estruturado](inventario-fontes.json) cobrem os dois exports complementares: 25 artboards e 3.965 nós. Não houve escolha silenciosa entre versões.

- Aprovada: Perfil desktop 3/3, `NyzMuM4gcmrvcqH7WxGB`.
- Base visual mobile: Perfil 2/2, `pJtifCp4ezXtllds7P9o`; sem aprovação formal.
- Candidatas: Pacotes 3/3, Composição 4/4, Preços 2/2 e Segurança 2/2. A implementação compatível foi autorizada, mas isso não aprova os desenhos.
- Fonte primária: [UX Pilot original](https://uxpilot.ai/s/9ee1d98314d8ec21f6820641038dfc7f), com HTML/CSS renderizado. Os .fig são complemento estruturado. Documentação funcional governa comportamentos.

`FIGMA_REFERENCE_UNAVAILABLE — UX PILOT USED AS PRIMARY SOURCE`

O plugin Figma recusou acesso ao arquivo identificado pelos exports; nenhum frame foi inventado, criado ou importado.

## Isolamento e base

Branch: `ux/admin-v1-visual-parity`. Base exata: `origin/integration/saas-commercial-foundation`, SHA `1b8806887ab96c1fe8c497344a64b594be197404`.

O worktree separado começou com `git status --porcelain` vazio. O working tree original e os rascunhos do outro agente não foram alterados nem incorporados.

Consulta Render somente de leitura em 27/09/2026: `kidmais-manager-staging`, `srv-daif418ae00c73e8k2gg`, repositório `felipemenegaz-debug/kidmais-manager`, branch `staging`, auto-deploy desligado. Deploy live `dep-das9h7t9fdbs73cfh400`, SHA `1b8806887ab96c1fe8c497344a64b594be197404`, concluído às 01:19:38 de São Paulo (04:19:38 UTC). É referência operacional, não publicação desta branch.

## Implementação

- Shell escuro com Inter, sidebar desktop expandida de 256 px, item ativo e rotas reais. Drawer mobile com Escape, retorno e contenção de foco e bloqueio de rolagem do fundo.
- Perfil em duas colunas no desktop e uma no mobile, com Identificação, Endereços, Contatos, Marca e Histórico. CEP, S/N, endereço alternativo, draft/apply, conflito, capacidades e auditoria preservados. Erros de aplicação permanecem visíveis no diálogo.
- Marca apresenta a indisponibilidade real. Não oferece upload nem armazenamento fictício.
- Pacotes com busca, filtros de estado, duração humana, histórico e edição/composição em diálogo. Criação sem campo Código, empresaId ou Motivo.
- Código técnico novo: `P_` + UUID normalizado; gerado no domínio quando omitido, sem alterar códigos existentes. O índice existente por empresa/código vigente garante unicidade; revisões preservam o código. Evento `PACOTE_CRIADO` permanece.
- Duração usa horas e minutos, mantendo minutos no payload. Valores fora de múltiplos de 15 são preservados; 167 continua 2h47min.
- Adapters usam a empresa já comprovada por `withTenantTransaction`. Um empresaId divergente continua recusado antes do adapter. Sem mudanças em Tenant Context ou RBAC.
- Preços mostra vigência, escopo declarado, faixas, preços, lacunas e completude HG-4. Publicação depende de completude e ação explícita. Formulários auxiliares ficam em seções expansíveis.
- Hub, Buffet, Acessos e WhatsApp usam o tema. Clientes, Contratos, Festas e Agenda têm integração visual com o shell. Referências globais de Buffet continuam somente leitura.

## Matriz final — Perfil

Medições do navegador no mesmo viewport desktop de 1440 × 1800. Valores fracionários refletem a escala de renderização do navegador. Capturas em 375 × 900 e notebook 1024 × 768 também foram revistas.

Viewport CSS e dimensão do PNG não são equivalentes: a captura nativa pode excluir a scrollbar e refletir a escala do navegador (por exemplo, 375 × 900 CSS gera 360 × 863 pixels com scrollbar). O manifesto registra os pixels; os JSONs registram as medidas DOM. Comparações usam capturas do mesmo viewport e mecanismo, sem percentual artificial de semelhança.

| Elemento | Referência | Implementação final | Resultado |
| --- | --- | --- | --- |
| Canvas / card | #090D1B / #151B2E | mesmos tokens | coincide |
| Sidebar | 256 px | 256 px | coincide; links reais diferem do mock |
| Header | 80 px | 80 px | coincide |
| Área após sidebar | 1184 px | 1184 px | coincide |
| Padding / gap principal | 32 / 32 px | 32 / 32 px | coincide |
| Colunas úteis | 736 / 352 px | 736 / 352 px | coincide |
| Card Identificação | 736 × 412,83 | 736 × 413,83 | +1 px |
| Card Endereços | 736 × 533,50 | 736 × 537 | +3,50 px; campos reais acessíveis em detalhes |
| Card Contatos | 736 × 494,17 | 736 × 499,92 | +5,75 px; orientação funcional adicional |
| Card Marca | 352 × 830,83 | 352 × 831 | estrutura coincide; conteúdo indisponível real |
| Card Histórico | 352 × 294,33 | 352 × 294 | diferença subpixel |
| Raio / padding dos cards | 32 / 32 px | 32 / 32 px | coincide |
| Input | 14 px / linha 21 / altura 46,33 | mesmos valores | coincide |
| Input padding / raio | 12 × 16 / 12 px | mesmos valores | coincide |
| Input fundo / borda | branco 3% / branco 8% | mesmos valores | coincide |
| Salvar rascunho | 189,10 × 37,33 | 189,10 × 40 | alvo mínimo de interação preservado |
| Revisar e aplicar | 227,28 × 40 | 228,61 × 41,33 | borda adiciona 1,33 px |
| Mobile header | 64 px | 64 px | coincide |
| Mobile card largura / raio / padding | 328 / 24 / 24 px | mesmos valores | coincide; viewport 375 com scrollbar nativa de 15 px |
| Mobile input | 16 px / linha 24 / altura 49,33 | mesmos valores | coincide |
| Mobile Identificação | altura 365,83 | 363,83 | −2 px |
| Mobile Endereços / Contatos | 594 / 473,83 px | 675,67 / 530,83 px | conteúdo adicional real preservado; não alegar paridade de altura |
| Notebook | sem artboard específico | uma coluna principal, sidebar expandida | sem overflow horizontal |

O ciclo de comparação corrigiu a largura inicial do grid, o alinhamento de Local da festa, os botões e badge do header, o preenchimento dos cards mobile e o espaçamento da busca de Acessos.

## Diferenças deliberadas para revisão humana

Não são apresentadas como paridade pixel a pixel:

1. Menu exibe rotas existentes; não cria Dashboard, Solicitações ou Segurança fictícios. Segurança candidata foi inventariada, mas não criou fluxo novo de credenciais.
2. Marca não reproduz o botão de upload da referência. Prévia documental é ilustrativa e não um documento emitido.
3. Perfil preserva asteriscos reais, ajuda acessível, campos da unidade/referência de chegada e aviso sobre contato obrigatório. Isso aumenta a altura mobile em relação à base visual.
4. Pacotes usa estados e operações do domínio disponível. Não inventa publicação, ordenação ou estados “público/rascunho” inexistentes no contrato atual. Composição mantém os controles suportados de vínculos e limites, em diálogo.
5. Preços conserva o escopo explícito e as lacunas HG-4. O layout é uma adaptação da candidata ao contrato funcional; não reproduz restauração de versão ou edição em lote sem backend.
6. As páginas operacionais receberam integração visual; suas estruturas internas não têm artboard administrativo aprovado correspondente.

As diferenças acima são consequência do escopo funcional e das exceções expressas do Goal. Candidatas continuam pendentes de validação humana.

## Validação e limites

`npm run check:v1:static`: **PASS**, 721 testes da suíte principal + 103 do harness = **824**, zero falhas; ESLint, TypeScript e build de produção aprovados. `git diff --check` aprovado.

Testes acrescentados/ajustados cobrem geração de código e auditoria inicial, recusa de empresa divergente, formulário sem Código/Motivo na criação, durações 165/210/240/167, round-trip de todos os valores de 1 a 1440 minutos e manutenção do drawer sem collapse desktop.

Revisão de navegador:

- Perfil: 1440, 375 e 1024 px; medidas computadas e capturas comparadas.
- Drawer: abrir, Tab do último controle ao primeiro, Escape, retorno do foco e restauração de scroll.
- Perfil: CEP sintético, S/N, endereço alternativo, salvar/recarregar rascunho, comparação, conflito simulado visível e aplicação bloqueada.
- Pacotes: listagem, busca, criação em memória sem Código/Motivo, edição preservando 2h47min; composição sem catálogo mantém ações desabilitadas.
- Preços: estado incompleto bloqueia publicação; completo habilita o botão, sem publicar.
- Hub, Buffet, Acessos, WhatsApp, Clientes, Contratos, Festas e Agenda: capturas desktop/mobile e inspeção de overflow e fundo.

A aplicação foi renderizada com proxy exclusivamente local, APIs simuladas em memória e DATABASE_URL sintética apontando para porta inacessível. Nenhuma API de negócio é encaminhada pelo proxy; endpoints não habilitados retornam 403. As capturas não atestam persistência PostgreSQL, integração remota ou estados de todos os registros históricos. Testes PostgreSQL ficam fora da regressão estática. Nenhum OTP, credencial real, migration, produção ou deploy foi usado.

Runtime local: Node 24.20; o projeto declara Node 22.23.2. O build e a suíte passaram neste runtime local; não se apresenta isso como teste no runtime exato do Render.

## Evidências

O pacote local `visual-review/`, entregue junto à tarefa, contém:

- `visual-review.html`: galeria de capturas e comparação lado a lado;
- `perfil-desktop-referencia.png`, `perfil-desktop-implementacao.png` e comparação/overlay;
- Perfil mobile, seções inferiores, diálogo/conflito e notebook;
- Pacotes e Preços desktop/mobile, candidatas e Composição;
- shell e páginas auxiliares/operacionais;
- `perfil-computed.json`, `paginas-computed.json`, log estático e manifesto SHA-256.

As imagens são evidências da execução local, não fontes canônicas de design. O inventário e os IDs UX Pilot continuam determinando as referências. Os arquivos alterados e commits estão registrados no relatório da entrega; nenhuma branch compartilhada foi modificada.
