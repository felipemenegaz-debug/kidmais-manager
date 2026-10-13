# Coleção aberta — laboratório local

Primeira seleção: três molduras próprias (Folhas, Estrelas e Balões) compostas com caminhos dos ícones oficiais Tabler, sob licença MIT. Originais, licença e checksums estão em `lib/convites/acervo/`. Não são molduras prontas copiadas do Tabler: o layout da moldura é uma composição do KidMais.

Os downloads de duas molduras FreeSVG retornaram arquivos vazios nesta sessão e não foram integrados. Não há sincronização automática ou dependência de sites externos em runtime.

Na interface local, abra **Coleção aberta** para escolher uma das molduras. Em **Crie uma arte com IA**, a opção **Wall‑E: sugerir moldura da coleção aberta pelo tema** aplica uma sugestão ao preparar o pedido. Natureza usa folhas; espaço/viagem no tempo usa estrelas; demais pedidos usam balões. É uma regra determinística experimental, sem classificador treinado. Desmarque para preservar a moldura atual. A geração aplica a imagem no topo, mantendo a moldura e os dados.

Elementos individuais não aparecem no seletor. Os caminhos incorporados ao resultado são visíveis no SVG exportado; não são recursos secretos. Nenhum prompt ou dado da festa é enviado aos sites dos acervos. O ComfyUI continua local e vídeo generativo permanece indisponível. A animação de 5 segundos reutiliza a composição.

A categoria experimental só aparece com `laboratorioLocal`. Código e assets permanecem neste checkout; não houve publicação. PNG e animação usam o mesmo `svgModelo` que a prévia. Todos os dados interpolados continuam escapados.

Fontes: https://github.com/tabler/tabler-icons e sua licença, preservada em `LICENSE-Tabler.txt`. Importação offline reproduzível: `node scripts/convites-acervo-importar.mjs`, após baixar os três arquivos oficiais para `.local-convites-qa/acervo-originais`.
