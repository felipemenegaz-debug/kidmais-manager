# Marketing — UX do site por unidade, personalização visual e automações (15/10/2026, somente local)

**Goal:** nota `Goal UX Marketing site e automacoes` no vault.
**Base:** `90135b4` (código funcional aprovado em `2c5aa43`; `90135b4` só documenta N1).
**Branch:** `codex/marketing-ux-site-automacoes-20261015`, na worktree `kidmais-manager-marketing-ux-20261015`. Só local, sem push.
**Revisão independente:** pendente. **Aceite visual de Felipe:** pendente.

## Antes e depois

| Antes (90135b4) | Depois |
|---|---|
| Abertura sem foto quando a galeria ficava vazia; espaços grandes; estrutura em lista e pacotes em cartões simples | Abertura com foto em destaque (ou composição com as cores da marca, sem vazio). Estrutura e diferenciais em blocos. Galeria navegável. Pacotes com nome, inclusões, capacidade e duração, ação e foto **só quando vinculada** ao pacote |
| Um visual único; cores principal e de apoio sem orientação | Três estilos por unidade: **Infantil acolhedor**, **Social contemporâneo** e **Celebrações elegante**. Oito paletas prontas e cor personalizada. Contraste calculado (WCAG) e avisos de leitura |
| Editor em uma coluna longa; prévia só em outra aba e só do rascunho salvo | Editor em abas (Identidade, Fotos, Conteúdo, Pacotes, Publicação e SEO). Prévia imediata ao lado com o **mesmo renderizador** da página pública, em largura de computador ou de celular. No celular, alterna entre Editar e Prévia |
| Automações em formulário técnico | Cada regra em passos: Quando acontecer → Prazo → O que fazer → Mensagem → Horários → Revisar/simular/ativar. Frase-resumo fiel aos valores. Prévia da mensagem com dados fictícios identificados. Histórico legível ("aceita" não é "entregue"). Aviso "Ambiente local — mensagens simuladas" |

## Entrega A — site público e personalização

**Schema** (`lib/marketing/site/conteudo.ts`). A evolução é só no JSON do conteúdo, **sem migration**; a 083 e a 084 não foram tocadas.
- `aparencia.estilo`: enum de 3 valores, padrão `INFANTIL_ACOLHEDOR`, objeto estrito.
- `pacotes[].imagemId`: uuid ou null, padrão null.

**Compatibilidade com conteúdo antigo**
- Rascunhos antigos validam e recebem os padrões. Versões publicadas antigas renderizam no estilo padrão (`estiloDoConteudo`).
- A **impressão do rascunho** (`formaParaImpressao`) omite os campos novos quando estão no padrão e preserva a ordem das chaves. Sem isso, todo site já publicado passaria a acusar "alterações não publicadas" sem edição. Há teste para isso.
- `imagensReferenciadas` passa a incluir a foto de pacote. A rota pública de imagem usa essa mesma função: só serve imagem citada na versão **publicada**. Rascunho e upload avulso continuam 404.
- A capa continua sendo a **1ª foto da galeria**, sem estado novo. O editor explica isso e oferece "Usar como capa".
- `pacotesDisponiveis` passa a devolver descrição, capacidade e duração. É uma mudança mínima de contrato de apresentação, para a prévia imediata.

**Tema** (`lib/marketing/site/tema.ts`)
- Os estilos mudam neutros, tipografia (só fontes do sistema, sem rede), raios e composição. O renderizador é um só, via `data-estilo`.
- Paletas prontas.
- Texto sobre a cor principal: branco ou quase-preto, o de maior contraste.
- Cor principal usada como texto: ajustada até 4,5:1 sobre o fundo do estilo.
- Foco visível com pelo menos 3:1.
- Avisos para combinações ruins: texto de botão ilegível, cor clara demais, cores quase iguais.

**Renderizador** (`components/marketing/site/SitePublicoPagina.tsx` + `site-publico.module.css`)
- Topo: marca (logo ou monograma com as iniciais), navegação por seções e ação "Pedir orçamento".
- Abertura: com foto, conforme o estilo (foto ao lado com moldura no Infantil; foto de ponta a ponta com camada escura no Social e no Elegante). Sem foto: composição com as cores.
- Seções: Sobre, Estrutura em blocos, Galeria navegável (`GaleriaNavegavel`, setas e teclado; grade quando há até 3 fotos), Pacotes, Onde estamos, Orçamento (texto e garantias ao lado do formulário) e rodapé com contatos.
- Celular: barra "Pedir orçamento / WhatsApp" (`BarraAcaoCelular`, `position: sticky`) que **some** quando o formulário está visível ou um campo está em edição.
- **Container queries**: a prévia "celular" dentro do editor mostra de fato o layout de celular.
- Formulário: "(obrigatório)", campos alinhados, `aria-busy` no envio. Erro e sucesso já existiam. O texto do consentimento é o mesmo.
- Não inventa avaliações, preços, urgência ou fotos.
- Respeita `prefers-reduced-motion`. Tem link "Ir para o pedido de orçamento".
- SEO preservado: canonical, robots, sitemap, JSON-LD e URLs.

**Editor** (`components/admin/marketing/MarketingSite.tsx` + `site-editor.module.css`)
- Seleção de unidade explícita ("Editando o site da …"), com confirmação ao trocar com alterações não salvas e aviso ao sair da página.
- Barra de estado: situação da publicação, "rascunho diferente do publicado" e Rascunho salvo / Alterações não salvas / Salvando… / Erro ao salvar.
- Salvar **não** publica; publicar é ação explícita.
- Fotos:
  - envio múltiplo com progresso e erros por arquivo;
  - miniaturas com selos (capa, galeria, logo, foto de pacote, fora do site);
  - usar como capa, pôr ou tirar da galeria;
  - mover com botões (alternativa ao arrastar);
  - legenda e remover.
- Logo e foto de pacote: escolha por miniaturas.
- Só visualizar: campos desabilitados, sem botões de escrita e com aviso. A API já recusa (403).
- Prévia: imagens pela rota **administrativa**, a mesma de antes. Nenhum endpoint público novo.

## Entrega B — automações compreensíveis

**`lib/marketing/automacoes/explicacao.ts`** (só apresentação, com testes)
- `resumoRegra`, `quandoAcontece`, `oQueFaz` e `horarioPermitido`, fiéis a `alvos.ts`, `janela.ts` e `motor.ts`:
  - recompra = "N dias **antes** de completar um ano da última festa com contrato assinado";
  - pós-festa = janela de 14 dias;
  - frequência = só para mensagens, somando todas as regras;
  - tentativas = só para provedor indisponível.
- `ROTULO_ESTADO`: ACEITA = "Mensagem aceita pelo transporte simulado (não é confirmação de entrega)".
- `ROTULO_MOTIVO` / `motivoLegivel`: só os motivos que o motor grava; um motivo desconhecido aparece como veio.
- `QUEM_RECEBE`: a regra real de `elegivelParaMensagem`.

**Tela** (`MarketingAutomacoes.tsx` + `automacoes.module.css`)
- Passos numerados; opções avançadas recolhidas e explicadas; Datas vagas sem campos de envio.
- Prévia da mensagem com "Ana Exemplo" identificada como fictícia. A revisão local não equivale à aprovação do modelo pelo provedor.
- Simulação usa a versão **salva** (desabilitada com alterações não salvas). Mostra total, amostra limitada a `LIMITE_SIMULACAO` e motivos do backend; não grava nem envia nada.
- Regra ativa: explica o efeito real de salvar.
  - Prazo, horários e ação mantêm a regra ativa, e o que está agendado é revalidado.
  - Texto ou modelo pausa a regra e cancela as mensagens agendadas.
  - Isso é `salvarRegra`, sem mudança.
- Faixa "Ambiente local — mensagens simuladas". "Processar agora (um ciclo)" explica que executa um ciclo e que ativar não liga processamento contínuo.
- Só visualizar: campos desabilitados, sem botões de ação.

**Invariantes:** nenhuma regra de negócio, lock, consentimento, revogação, evidência, revalidação, idempotência, frequência, janela, fuso ou lote foi alterado. O delta não toca `motor.ts`, `alvos.ts`, `preferencias.ts`, `regras.ts` nem as migrations. R1–R4, O1/O2 e F1 seguem cobertos pelas suítes PostgreSQL. N1 segue qualificada.

## Validação (resultados reais desta rodada)

Ambiente:
- Cluster sintético **novo** `127.0.0.1:55550`, autorizado especificamente por Felipe.
- Banco `kidmais_marketing_ux_20261015`, com o inventário aprovado até a 084.
- App em `http://localhost:3494`, a partir desta worktree, com ambiente fechado (lista explícita e zero `.env` carregados).
- Transporte e domínio **simulados**.
- Fixtures fictícias com **ilustrações próprias geradas localmente** (rótulo "Imagem ilustrativa — demonstração"), sem fotos reais, banco de imagens ou rede.
- Scripts e relatórios em `ambientes-locais/marketing-ux-20261015/`.

| Verificação | Resultado |
|---|---|
| Testes novos: `tema.test.ts` (compatibilidade, impressão, contraste, renderizador) e `explicacao.test.ts` | 8/8 |
| Unitários de Marketing sem banco | 60/60 |
| `check:v1:static` | ver o pacote de revisão (LEIA-ME), com o log final |
| Suítes PostgreSQL do Marketing (F1, O1/O2, R1–R4, A, B, migration) | ver o pacote de revisão |
| Roteiro de navegador S1–S15 + X1 | 16/16 PASS após reconferência. A 1ª execução teve 5 falhas: 4 de espera ou seletor do próprio roteiro e **1 defeito real** de rolagem horizontal das Automações no celular, corrigido. O detalhe está em `relatorios/roteiro.json`, campo `primeiraExecucao` |

**Defeito encontrado e corrigido nesta rodada:** um texto oculto (`srOnly`, absoluto) no cabeçalho da tabela de histórico escapava do recorte da área rolável e esticava a página no celular para 977 px. Foi trocado por `aria-label` no `<th>`.

## Limitações

- As fotos da demonstração são ilustrações; o aceite visual com fotos reais de buffet fica para Felipe.
- Fontes: só as do sistema (Georgia/serif no Elegante), sem fontes da web nem rede.
- A prévia imediata mostra o preço "a partir de" só se a última prévia salva já o resolveu; o valor definitivo é congelado na publicação, como antes.
- Ordenação de fotos por botões, não por arrastar.
- O3/O4, preços e planos e a reconciliação das migrations seguem fora do goal.
