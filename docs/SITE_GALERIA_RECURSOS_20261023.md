# Cabeçalho e galeria de recursos — 23/10/2026

Felipe aprovou a amostra e autorizou sua implementação/publicação em staging.
Base: `c3e0a36` (staging LIVE na conferência inicial). Escopo somente apresentação:

- Cabeçalho com símbolo e nome na mesma linha do menu; menu recolhido abaixo de 1280 px.
- 12 recursos na ordem aprovada, 15 imagens WebP extraídas da amostra aprovada.
- Convites: arte fornecida e tela de criação por IA; texto sobre tema, cores e confirmação de convidados.
- Orçamento: pacote, convidados e Buffet; recorte apenas visual da terceira captura, com imagem completa ao ampliar.
- Marketing: exemplo de agradecimento/pedido de avaliação após a festa, com nota do estado simulado da captura.
- Copiloto: criação/edição de pacotes e outras tarefas, com revisão e confirmação.
- Capturas de dados editadas para fins ilustrativos na amostra anterior. Nenhuma consulta ou alteração de cadastro para esta publicação.

## Validação local

- Testes existentes `lib/site/site.test.ts`: 15/15.
- TypeScript, ESLint dos arquivos afetados, `git diff --check`: aprovados.
- Build Next/Turbopack: aprovado, 79 páginas estáticas. Fontes Google simuladas localmente pelo mock já existente; o Render usa seu build normal.
- Revisão independente somente leitura: sem bloqueadores. Sugestão de devolver o foco ao Menu ao pressionar Escape aplicada e conferida.
- Navegador sobre build de produção local: cabeçalho em linha no desktop, troca de recurso, três imagens de Orçamento, recorte/expansão do Buffet, duas imagens de Convites e menu móvel. Largura móvel sem overflow horizontal (scrollWidth = clientWidth = 360).
- Nenhum banco, variável remota, cron ou migration faz parte da alteração. Produção não será publicada nesta tarefa.

## Publicação

Staging `srv-daif418ae00c73e8k2gg`, branch staging, auto-deploy OFF. Publicação manual após push sem force; acompanhar até LIVE e conferir `/conheca#recursos`. O estado final será registrado após o deploy.
