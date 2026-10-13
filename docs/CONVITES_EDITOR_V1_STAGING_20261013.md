# Editor de convites V1 — integração em staging (13/10/2026)

Origem: laboratório local `kidmais-manager-convites-simplificar-20261009` (validado pelo usuário em 12/10/2026). Somente o necessário para a V1 foi trazido ao produto; a infraestrutura do laboratório (ComfyUI, servidor/proxy local, festa sintética, persistência em disco, limite ilimitado, avatar prévio, seletor de qualidade, comparadores e motion) **não** foi publicada.

## Comportamento

- **Layout central** (buffet e cliente): Dados da festa → prévia da arte → painel “Crie uma arte com IA” sempre aberto → Salvar/Publicar. Dados em formato compacto. Abaixo: imagens anteriores (recolhidas), acesso do cliente e limites (buffet), famílias, confirmações e histórico.
- **Molduras desativadas no editor** (`MOLDURAS_NO_EDITOR = false` em `ConviteEditor.tsx`). Modelos, SVGs e convites já publicados continuam renderizando; o envio de arte própria/foto continua em “Imagens anteriores” (necessário para modelos com foto existentes).
- **Galeria** paginada em três linhas: 9 por página no computador, 6 no celular.
- **Seletores** escuros e translúcidos (buffet) / claros (cliente), operáveis por teclado (setas, Home/End, Enter, Esc).
- **Corretor ortográfico local**: botão direito sobre a palavra → sugestões do dicionário pt-BR; nada é alterado sem escolha. Dicionário e licença em `public/dicionarios/pt-BR/` (LibreOffice VERO, LGPLv3/MPL; cópia idêntica de `dictionary-pt-br@2.0.1`, sem dependência de runtime), carregados por um Web Worker do próprio app. O prompt não é enviado a terceiros.
- **Convite completo** (arte + textos numa chamada), quando o servidor tem OpenAI configurado: estilos Conforme pedido, Cartoon 3D, Desenho 2D e Realista; foto do aniversariante opcional com a autorização de envio já existente; conferência de nome/idade entre pedido e dados antes de gerar; dados alterados são salvos antes da geração.
- **Download** da arte completa nas dimensões naturais (1024×1536), sem recorte nem textos sobrepostos. Prévia e página pública exibem a arte inteira.

- **Convites existentes**: o editor só passa ao modo “completa” uma arte gerada como convite completo; modos já salvos (inclusive “Arte completa” do botão anterior) não são alterados ao abrir. Escolher outra arte define o modo pela arte escolhida.

## Servidor

- Rota existente `/api/admin/convites` (buffet) e `/api/convites/cliente` (cliente), mesmo `service.gerar`: autenticação, tenant/estabelecimento, contrato vigente, acesso comercial, cotas de empresa/festa/cliente, orçamento diário, idempotência por chave, uma geração pendente por festa, estado INCERTA com recuperação manual, sem retry nem fallback pago.
- Comando `gerar` aceita `completo`, `estilo`, `foto`, `autorizacaoFoto` (opcionais; o pedido antigo continua igual). Modelo `gpt-image-2.5-sunburst`, qualidade `xhigh`, 1024×1536, PNG, fundo opaco — definidos pelo servidor; o cliente não escolhe modelo, qualidade ou arquivo de referência.
- **Dados oficiais** = rascunho salvo no servidor (`convites.rascunho`), nunca o texto do pedido. Conflito de nome/idade retorna 409 antes de reservar créditos. O hash de idempotência do convite completo inclui estilo, hash da foto e esses dados: repetir a chave depois de alterar os textos é recusado (409), sem nova chamada.
- **Foto**: validada e reencodada (`normalizarImagem`, sem metadados), enviada somente na chamada; não é salva no banco nem na auditoria — apenas o hash entra na idempotência.
- **Referências de estilo** privadas em `lib/convites/referencias/` (fora de `public/`), uma por estilo e recusadas se o id/arquivo não pertencer ao estilo:

  | Estilo | Arquivo | SHA-256 |
  |---|---|---|
  | Cartoon 3D | `cartoon3d-aprovado-v2.webp` | `79dacdef…c24a4070` |
  | Desenho 2D | `cartoon2d-aprovado-v1.webp` | `650310c0…e4c0fc26` |
  | Realista | `realista-aprovado-v1.webp` | `9e89f0ff…80ae02` |

  Com foto: imagem 1 = identidade, imagem 2 = referência do estilo, na mesma chamada `images/edits`. Sem foto: `images/generations`, sem referência. Origem e aprovação: [CONVITES_ESTILO_REFERENCIA_LOCAL.md](CONVITES_ESTILO_REFERENCIA_LOCAL.md).
- **Proporção infantil** no Cartoon 3D: idade explícita abaixo de 13 anos nos dados da festa → cabeça ~20–30% maior (instrução única); adolescentes, adultos e idade ambígua mantêm 50%.
- **Armazenamento**: a saída é guardada como WebP nas dimensões originais (qualidade 92→85→78 até caber nos 1,5 MB da coluna `convite_artes.imagem`). **Sem migration.** A arte é identificada como completa pela geração que a criou (`convite_geracoes.modelo`).
- Prompts idênticos byte a byte aos do laboratório aprovado (56 combinações de estilo × idade × foto conferidas na integração).

## Configuração necessária em staging (não alterada nesta entrega)

O convite completo só aparece com `CONVITES_ENABLED=true`, `CONVITES_IA_ENABLED=true`, `CONVITES_IA_PROVIDER=openai`, chave `OPENAI_API_KEY` (ou `CONVITES_OPENAI_API_KEY`) e `CONVITES_IA_TETO_DIARIO_MICROUSD ≥ 300000`. Sem isso, o editor mantém a geração de arte anterior (ou a IA desabilitada) e o restante funciona. A empresa precisa de franquia mensal em `convite_carteiras`. A reserva diária continua conservadora (US$ 0,30 por pedido); o custo real do Sunburst `xhigh` com duas imagens de entrada deve ser conferido no painel do provedor.

## Validação (sem chamadas pagas)

- `lib/convites/estilos.test.ts`, `imagem-completo.test.ts`, `corretor-prompt.test.ts` e o restante de `check:v1:static` (testes unitários, ESLint, TypeScript, build).
- `lib/convites/service.test.cjs`: 6 testes novos do convite completo (referência por estilo e ordem, créditos reais, proporção infantil, conflito antes da reserva, idempotência com estilo/foto, INCERTA sem reenvio, tenant/paywall/cota do cliente, consulta).
- `scripts/convites-exportacao-completa.test.cjs` (agora no CI).
- `scripts/convites-editor-v1-ui.cjs`: navegador local com API simulada — ordem do layout, painel aberto, molduras ausentes, galeria 9/6, teclado, corretor, conflito, foto com autorização, salvar antes de gerar, duplo clique = uma geração, download 1024×1536, persistência após recarregar, sem rolagem horizontal em 1440 e 390 px.

## Rollback

Sem migration nem env, mas **não é um retorno cego ao commit anterior**: a V1 grava `visual.posicao` (botões “Imagem como fundo/no topo”), e o `conteudoSchema` anterior é estrito — no código de `925b7f0`, `publico()` recusaria esses convites publicados (`ZodError` → link público indisponível). Convites completos não gravam `posicao`.

1. **Preferencial — correção à frente**: corrigir em novo PR sobre `staging` e publicar manualmente.
2. **Rollback de staging (`925b7f0`, deploy `dep-db6sskjncjis73eo3mk0`)**: somente após confirmar que nenhum convite foi salvo/publicado com `visual.posicao` desde a V1 (consulta de leitura autorizada) ou ajustando esses rascunhos/publicações antes, com autorização própria para escrita no banco. Alternativa sem dados: reverter apenas `components/convites` e `lib/convites/service.ts`, mantendo `lib/convites/domain.ts` da V1 (schema tolerante).

Artes já geradas permanecem em `convite_artes` (WebP) e continuam exibíveis. Convites “Arte completa” anteriores à V1 mantêm o modo salvo. Produção não é afetada.
