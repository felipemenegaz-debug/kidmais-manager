# Estilo e foto de referência — teste local, 12/10/2026

> Histórico do laboratório. No produto (13/10/2026) os prompts estão em `lib/convites/estilos.ts` e as referências aprovadas em `lib/convites/referencias/` (mesmos arquivos e hashes citados abaixo para `scripts/assets/convites/`). Integração: [CONVITES_EDITOR_V1_STAGING_20261013.md](CONVITES_EDITOR_V1_STAGING_20261013.md).

Problema observado: o convite tem boa composição, mas a foto pode continuar realista mesmo quando o pedido solicita cartoon. Não há garantia de corrigir isso apenas aumentando a qualidade.

## Pesquisa e decisão

- [OpenAI: image prompting](https://developers.openai.com/api/docs/guides/image-prompting): definir o papel de cada referência e descrever o novo sujeito separadamente.
- [OpenAI: guia de prompting](https://developers.openai.com/cookbook/examples/multimodal/image-gen-models-prompting-guide): instruções curtas com segmentos identificados; meio visual e composição explícitos.
- [Discussão de usuários sobre image-to-image](https://www.reddit.com/r/ChatGPT/comments/1srlrs1/gptimage_2s_image_to_image_is_not_good/): relatos de resultados variáveis, evidência anedótica, sem garantia ou parâmetro validado para o nosso modelo.
- YouTube: [Animate any Picture using ChatGPT and CapCut](https://www.youtube.com/watch?v=jsxdmWJd8-o) e [Turn Any Photo Into a Cartoon Illustration Using ChatGPT](https://www.youtube.com/watch?v=a1Xekrsx_-g). Encontrados títulos e descrições na busca; abertura das páginas falhou. Não foram assistidos integralmente, nem utilizados como comprovação técnica.

Implementação local: seletor Conforme pedido / Cartoon 3D / Desenho 2D / Realista. A escolha explícita prevalece sobre estilo conflitante no prompt. Conforme pedido conserva o estilo solicitado e usa cartoon 3D na ausência de estilo. Foto representa somente traços; a orientação permite reconstrução artística em vez de copiar pixels. Nome/idade no topo e informações agrupadas são diretrizes, mantendo a ação solicitada. Data ISO vira dia/mês/ano somente no texto enviado; campos originais permanecem intactos.

Mantidos modelo, resolução, qualidade escolhida, consentimento, idempotência, chamada única e início manual. Sem segunda geração de avatar, retry, aumento automático de qualidade ou chamada adicional de texto. Nenhuma geração paga foi executada para validar esta alteração. A eficácia visual ainda precisa de teste manual.

Para testar o backend atualizado, reiniciar o iniciador seguro local e informar a chave na entrada oculta. Atualizar a aba não reinicia o processo que prepara o prompt.

## Experimento em duas etapas

## Referência automática de estilo — 12/10/2026

O teste recomendado agora é uma chamada direta de convite completo OpenAI, com foto autorizada e estilo Cartoon 3D. O servidor acrescenta `scripts/assets/convites/cartoon3d-aprovado-v1.webp`, normalizado da arte aprovada pelo usuário. Não é um asset público nem um segundo upload exigido do usuário. Foto é imagem 1 (traços); arte é imagem 2 (geometria e materiais). O prompt proíbe copiar identidade, textos, dados, marca, cores, cenário ou objetos da referência. Tema e dados oficiais continuam vindo do pedido e dos campos cadastrados.

O primeiro experimento manteve Sunburst, 768×1024 (3:4), qualidade selecionada e WebP; foi substituído pelo preset abaixo. Sem CFG, sampler, steps, negative_prompt ou input_fidelity. Outros estilos, pedidos sem foto e avatar isolado não recebem o asset. Uma chamada não significa custo idêntico: a segunda imagem acrescenta entrada faturável. Não há garantia de sucesso visual nem retry automático.

Leitura do asset ocorre antes da reserva e após recuperação de pedidos históricos; a trava concorrente é revalidada depois do await. O ledger identifica a referência em `plano.referenciaEstiloId`; não guarda a foto original. Reiniciar o iniciador seguro é necessário para carregar o backend atualizado. Não foram feitas chamadas pagas na validação.

Contrato oficial: [Create image edit](https://developers.openai.com/api/reference/resources/images/methods/edit).

### Preset completo autorizado — 12/10/2026

Sunburst, qualidade padrão `xhigh` (seletor mantém high/xhigh/max), 1024×1536 em 2:3, PNG, fundo opaco e uma imagem por chamada. Cartoon 3D descreve cabeça aproximadamente 25% maior, olhos e pálpebras estilizados, feições simplificadas, bochechas arredondadas, cabelo esculpido, pele ilustrada e mãos/corpo estilizados. Estilo precede o pedido visual; a referência aprovada continua automática somente com foto + Cartoon 3D. Idade, tema e dados oficiais permanecem variáveis.

A saída completa não passa pelo enquadramento 3:4 nem pela redução de uploads. Proxy salva PNG e serve o MIME correspondente; recuperação aceita WebP legado. Prévia usa proporção natural e download PNG preserva dimensões naturais, sem sobrepor textos. Imagens comuns continuam no fluxo anterior. Qualidade superior pode aumentar custo/latência e não garante cartoon.

Validação sem API paga: 16 testes do gerador/adaptador e teste de exportação com dimensões novas/legadas, TypeScript e ESLint; revisão independente sem bloqueios. Reiniciar o iniciador seguro e recarregar a página; escolher Cartoon 3D e Muito alta para o próximo teste visual manual.

Diagnóstico seguinte: job `69f5b3a3-0717-4f9c-af08-26beb071a607` recebeu xhigh e PNG 1024×1536, mas estilo Conforme pedido, sem referência automática nem instrução geométrica completa. O editor iniciava nesse modo após recarregar. Corrigido o padrão inicial do editor para Cartoon 3D; demais estilos seguem selecionáveis. Isso permite testar o preset aprovado, sem comprovar ainda sucesso visual. Nenhuma geração paga foi disparada pela correção.

Avatar intenso `e507c619-7ffe-46bb-98b7-b89c8bd7bf59` seguido pelo convite `11a78f28-d14d-497e-83a4-cc9c970a938c`: usuário aprovou e a conferência visual confirmou cartoon acentuado no convite. Para testar uma chamada desde a foto original, avatar e convite completo passaram a compartilhar a mesma direção intensa (cabeça aproximadamente 50% maior, materiais simplificados e menor exigência de semelhança). Não há mais instrução concorrente de 25%. Foto + referência de estilo continuam em uma chamada direta; reutilizar avatar pronto também exige apenas a chamada do convite, mas sua criação inicial foi uma chamada adicional. O caminho direto com foto original ainda não foi validado visualmente nem executado nesta correção. Seis testes com mocks e ESLint passaram. Reiniciar o iniciador seguro para carregar o novo texto.

Refinamento de olhos para chamada única: referência automática atual `cartoon3d-aprovado-v2.webp`, derivada da primeira imagem aprovada enviada (`codex-clipboard-8a96c67a-f389-427f-af98-cd265bede453.png`). A v1 fica preservada para histórico. O convite completo reforça olhos/íris maiores, abertura do olhar, pálpebras simples, rosto arredondado e menos textura realista. O papel da imagem 2 explicita essas proporções, sem copiar identidade, textos ou cena; faixa etária continua vindo dos campos. Prompt de avatar isolado permanece no padrão intenso anterior aprovado. Testes verificaram ordem das duas imagens, envio da v2, refinamento textual e exatamente uma chamada, sem API real. Seis testes e ESLint passaram; novo resultado visual ainda pendente após reiniciar o iniciador seguro.

### Desenho 2D e Realista com direção própria — 12/10/2026

Cada estilo explícito tem agora uma direção de arte própria em `scripts/convites-geradores-local.mjs` (`estilos`, `fotoPorEstilo`, `direcaoReferencia`). Somente o texto do estilo escolhido entra no prompt; os marcadores `CARICATURA CARTOON 3D`, `DESENHO CARTOON 2D` e `FOTOGRAFIA REALISTA` nunca aparecem juntos.

- **Cartoon 3D**: texto, orientação da foto, referência `cartoon3d-aprovado-v2` e avatar sem alteração.
- **Desenho 2D**: pessoa inteiramente redesenhada; contornos limpos de espessura consistente em pessoa, animais, objetos e cenário; rosto simplificado e alegre; olhos expressivos com íris/pupilas alinhadas e perspectiva coerente; cabelo em massas e mechas; cores planas com sombras em blocos (cel shading); sem pele fotográfica, rosto recortado, filtro sobre foto ou materiais 3D. Com foto: semelhança pelos traços principais traduzidos em formas simplificadas, sem colar o rosto fotográfico.
- **Realista**: uma única fotografia coerente; proporções humanas naturais; olhos alinhados e mãos/anatomia coerentes; pele com textura natural, sem suavização plástica; luz com direção, intensidade e temperatura iguais na pessoa e no ambiente; sombras de contato, perspectiva, escala, foco e profundidade compatíveis; roupas e pose do tema; sem recorte, colagem ou elementos cartoon (tipografia do convite permitida). Com foto: preserva traços reconhecíveis e reilumina a pessoa na cena.
- Os três respeitam a faixa etária cadastrada; tema e cores vêm do pedido; nome, idade, data, horário, local, endereço e mensagem vêm dos campos oficiais.

**Registro de referências** (`referenciasEstilo`): independente por estilo. Um arquivo em `scripts/assets/convites/` não é usado até ser registrado no código, e o `id`/arquivo precisam começar pelo próprio estilo (`cartoon2d-…`, `realista-…`), o que impede anexar a referência 3D a outro estilo. Caminhos com diretório são recusados. Com foto + referência registrada: imagem 1 = identidade, imagem 2 = linguagem visual, em uma única chamada `edits`; a direção proíbe copiar identidade, textos, dados, marca, paleta, pose ou cenário da imagem 2.

| Estilo | Referência | Situação |
|---|---|---|
| Cartoon 3D | `cartoon3d-aprovado-v2.webp` | aprovada e automática |
| Desenho 2D | `cartoon2d-aprovado-v1.webp` | aprovada para a V1 em 12/10/2026 e automática (ver abaixo) |
| Realista | `realista-aprovado-v1.webp` | aprovada para a V1 em 12/10/2026 e automática (ver abaixo) |

Se um estilo ficar sem referência no registro (`null`), ele continua funcionando com foto (uma imagem anexada, sem menção a imagem 2) ou somente com texto (`generations`). Para trocar ou acrescentar uma versão: salvar a arte aprovada pelo usuário como `scripts/assets/convites/<estilo>-aprovado-vN.webp`, registrar `{ id, arquivo }` em `referenciasEstilo`, rodar os testes e reiniciar o iniciador seguro.

### Referências 2D e Realista aprovadas para a V1 — 12/10/2026

Origem: duas imagens geradas no laboratório e aprovadas pelo usuário em 12/10/2026 como exemplos da V1, entregues pela área de transferência. Os originais foram preservados intactos; no repositório ficam somente cópias normalizadas (WebP qualidade 90, 667×1000, 2:3, sem metadados), como a referência 3D. Assets privados do servidor, fora de `public/`.

| Asset | Original (preservado) | SHA-256 do original | SHA-256 da cópia |
|---|---|---|---|
| `cartoon2d-aprovado-v1.webp` | `%TEMP%\codex-clipboard-6a976394-d9ee-4fc1-97ed-f7837301d86b.png` (PNG 1024×1536) | `f6b6414c…0f924fc` | `650310c0…e4c0fc26` |
| `realista-aprovado-v1.webp` | `%TEMP%\codex-clipboard-263e793d-5f78-4748-bfaa-d401420cdbc6.png` (PNG 1024×1536) | `bf728d70…a5c84` | `9e89f0ff…80ae02` |

Inspeção antes do cadastro: a 2D tem contornos limpos, cores planas e sombras em blocos; a realista é fotográfica, com luz suave de retrato e rosto/mãos/frasco nítidos. As duas mostram a mesma pessoa adulta, tema ciência (laboratório, jaleco, frascos, livros), nome, idade e dados de uma festa. Por isso a direção com referência extrai somente linguagem visual, acabamento, iluminação e tratamento das formas, e proíbe copiar identidade, rosto, nome, idade, textos, marcas, cenário, pose, roupas, objetos ou paleta. O tema da referência só aparece se o pedido o solicitar. Risco conhecido: como a referência contém um rosto real, ainda pode haver alguma influência dele quando a foto for de outra pessoa. Conferir isso nos próximos testes.

**Aprovação ≠ garantia.** Aprovar estes exemplos para a V1 define o padrão visual desejado; não garante que as próximas gerações atinjam a mesma qualidade, semelhança ou correção de textos. Cada resultado continua exigindo revisão humana.

**Refinamento do Realista** (incorporado ao preset, sem o usuário repetir no prompt e válido para qualquer tema): iluminação suave de retrato com fonte ampla e preenchimento frontal; tonalidade natural da pele, preservando textura e volume, sem manchas acinzentadas nem sombras duras; rosto, mãos e objetos segurados com nitidez compatível; profundidade de campo suficiente, com desfoque suave apenas nos planos secundários; anatomia natural, dedos definidos e contato convincente com objetos; luz, perspectiva e sombras coerentes entre pessoa e cenário; semelhança e faixa etária preservadas, sem pele plástica. Nenhum objeto, roupa ou ambiente (laboratório, jaleco, frasco) é obrigatório.

Validação, só com API simulada: 12 testes do convite completo e 4 dos geradores. Cobrem referência correta e distinta por estilo, com leitura do arquivo real; ordem foto → referência; uma chamada `edits`; parâmetros inalterados; orientações de luz e foco do Realista; ausência de elementos obrigatórios do tema ciência; dados oficiais preservados, sem "Felipe"/"41 anos"; geração sem foto; estilo sem referência; erros sem nova tentativa; Cartoon 3D sem regressão. Também passaram os demais 35 testes de convites (1 HTTP opcional ignorado), TypeScript e ESLint. Nenhuma geração paga. Reiniciar o iniciador seguro para carregar referências e textos novos.

Mantidos modelo, tamanho, qualidade, formato, fundo opaco, chamada única, conferência de conflitos, histórico, uso e recuperação. Nenhum parâmetro de API alterado ou adicionado; consultado o [guia oficial de prompting de imagem](https://developers.openai.com/api/docs/guides/image-prompting) (papel numerado de cada imagem, meio/traço explícito, textura real de pele). Sem avatar obrigatório, retry ou fallback. Validação apenas com API simulada: 12 testes do convite completo + 4 dos geradores (ordem das imagens, estilos isolados, ausência de referência, foto opcional, uma chamada, dados preservados, 3D sem regressão, erros sem nova tentativa), demais testes de convites, TypeScript e ESLint. Nenhuma geração paga. Resultado visual ainda não aprovado; depende de testes com imagens reais após reiniciar o iniciador seguro.

### Proporção infantil no Cartoon 3D — 12/10/2026

Motivação: o convite de Miguel (6 anos) ficou satisfatório, mas com a cabeça grande demais em relação ao tronco. O preset pedia cabeça aproximadamente 50% maior para qualquer idade.

Regra: `idadeInfantil()` lê somente o campo oficial `idade`. Nunca estima idade pela foto nem pelo prompt. É infantil quando o campo inteiro é explícito: `6`, `6 anos`, `1 ano`, `6 meses`, `1 mês`/`1 mes`, com 1–12 anos ou 1–155 meses. Datas, faixas (`6 a 7 anos`), descrições (`Aniversário de 6 anos`, `6º aniversário`), frações (`6 anos e meio`), números por extenso, `0`, semanas e campo vazio contam como ambíguos e mantêm o preset padrão.

No caso infantil, o Cartoon 3D monta uma única instrução de proporção. O trecho dos 50% é substituído por "cabeça aproximadamente 20–30% maior que as proporções naturais de uma criança da idade cadastrada". "Corpo com proporções caricaturadas" vira **PROPORÇÃO INFANTIL**: pescoço, ombros, tronco, braços e mãos proporcionais à idade, exagero suave, sem aparência de bebê nem de boneco de cabeça gigante. Os percentuais são orientação artística, não medida garantida. A regra vale para o convite completo e para o avatar opcional. Com foto, a direção da referência 3D ganha uma frase: a imagem 2 orienta acabamento e estilo, e a proporção infantil dos campos prevalece sobre ela. Continuam iguais olhos grandes e expressivos, olhar alinhado, sorriso, cabelo esculpido e materiais de animação.

Sem alteração: adolescentes (13+), adultos e idades ambíguas. Uma comparação com a versão anterior deu prompt byte a byte idêntico em todos os casos fora do 3D infantil (convite, direção da referência e avatar, em 10 formatos de idade × 4 estilos). Também não mudaram Desenho 2D, Realista, Conforme pedido, referências, parâmetros da API, qualidade padrão, número de chamadas, UX ou imagens já geradas.

Validação, só com API simulada: 17 testes do convite completo e 4 dos geradores. Cobrem idades infantis em anos e meses com somente a proporção 20–30%; casos padrão com somente 50%; nunca as duas instruções juntas; convite e avatar com o mesmo trecho; 2D, Realista e Conforme pedido idênticos entre "6 anos" e "41 anos"; uma chamada com foto → referência 3D e parâmetros intactos. Também passaram os demais 35 testes de convites (1 HTTP opcional ignorado), TypeScript e ESLint. O primeiro teste 3D passou a usar idade adulta para continuar cobrindo o preset aprovado de 50%. Nenhuma geração paga. A aprovação visual depende de novo teste do usuário, depois de reiniciar o iniciador seguro.

### Experimento anterior em duas etapas

Autorizado pelo usuário: botão Criar avatar cartoon dentro de Foto do aniversariante, disponível com foto autorizada e estilo Cartoon 3D/Desenho 2D. Primeira chamada Sunburst gera só o busto ilustrado em fundo neutro, sem convite. Uso e resultado ficam registrados em um job próprio identificado por avatarOnly; não há geração automática da segunda etapa.

Ao concluir, o browser substitui a referência em memória pelo avatar gerado e pede a conferência/autorização antes de Gerar convite completo. Esta é a segunda chamada paga, com registro próprio, usando o avatar em vez da foto original. O avatar também permanece na galeria local; a substituição em memória não sobrevive a fechar/recarregar a aba. Nenhuma chamada é repetida automaticamente após falha ou reinício. O custo depende do uso de cada etapa e deve ser somado pelos dois registros, não presumido como dobro exato.

## Diagnóstico de recusas

Novas falhas OpenAI podem registrar `diagnosticoProvedor` no job local: `requestId` do header x-request-id (formato limitado), `etapa` input/output/unknown e categorias públicas reconhecidas, se fornecidas. Mensagem bruta, scores e campos desconhecidos são descartados. A mensagem do usuário permanece genérica. Os detalhes são opcionais e não comprovam a cobrança nem que houve falso positivo. Recusas antigas não podem ser reconstruídas. Reiniciar o iniciador seguro para carregar o adaptador atualizado; nenhum reenvio automático.

Referências: [tratamento de bloqueios](https://developers.openai.com/api/docs/guides/image-generation) e [identificadores de requisição](https://developers.openai.com/api/reference/overview).

## UX local em coluna central — 12/10/2026

Layout aprovado pelo usuário: Dados da festa no topo, arte centralizada abaixo e painel de IA em seguida. Biblioteca de molduras fica oculta temporariamente somente no laboratório; acervo e arquivos permanecem intactos. Download fica sob a arte e Salvar rascunho após a IA. Imagens anteriores preservam seleção/exclusão em seção recolhida. CSS mantém essa ordem no celular, sem antecipar a prévia. Conferência no navegador em 1180px e 390px sem rolagem horizontal; TypeScript, ESLint, diff check e revisão independente passaram. Nenhuma geração paga ou publicação executada. Captura: .local-convites-qa/editor-ux-coluna-unica.png.

### Refinamento da UX local

Galeria paginada com três linhas: nove imagens no desktop e seis no celular, mantendo seleção e exclusão individual. Painel da IA fixo, sem expansão. Seletores de estilo e qualidade com menu escuro translúcido e navegação por teclado. Prompt com spellcheck e idioma pt-BR, preservando o menu de contexto nativo do navegador. Dados da festa compactos, em duas colunas, com mensagem de uma linha expansível. Verificado desktop e celular sem overflow; nenhum pedido pago realizado.

### Corretor integrado ao prompt

O spellcheck nativo não exibia sugestões no menu do navegador interno. O laboratório agora tem menu próprio de sugestões no clique direito (também Shift+F10), com escolha manual e opção de manter a palavra. Dicionário VERO via dictionary-pt-br 2.0.1, cópia não modificada de index.dic em public/dicionarios/pt-BR, acompanhada de licença e atribuição originais (LGPL-3.0 OR MPL-2.0). Origem: https://github.com/wooorm/dictionaries/tree/master/dictionaries/pt-BR. A consulta usa as entradas lexicais, variações de acento e distância de edição; não interpreta as regras de flexão Hunspell nem faz revisão gramatical. Pode não reconhecer conjugações, nomes próprios ou termos de tema. Não substitui automaticamente, nem verifica/reescreve o restante do prompt. Apenas a ocorrência selecionada é alterada; uma resposta atrasada não troca texto já editado. O arquivo é carregado uma vez, sob demanda, em worker local, sem chamadas a APIs ou serviços externos. A rota do proxy permite somente o arquivo e sua licença. Preservada a revisão nativa nos demais ambientes.
