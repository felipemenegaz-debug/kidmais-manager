# Regressão integrada do catálogo 021–024

> Atualização: os achados de total duplicado, mensagem de reserva e extensão do
> editor foram corrigidos e retestados. A renderização independente do PDF de
> teste foi visualizada. Consulte a rodada de correção ao final; os resultados
> anteriores abaixo permanecem como evidência histórica.

Execução em 23/09/2026, branch `v1/catalogo-021a`, base
`3ab621e67230a61527222ed710b4f9cec701977e`.

## Destino e método

- Banco efetivamente conectado: `kidmais_v1_homologacao`.
- Servidor: `::1` (loopback), porta `5432`.
- Credencial obtida exclusivamente de `KIDMAIS_HOMOLOGACAO_DATABASE_URL`, sem carregar dotenv ou usar `DATABASE_URL`.
- Identidade conferida antes das escritas. Sessão com `search_path=public`.
- Serviços e handlers reais, autenticação administrativa real e PostgreSQL físico; executor compartilhado com savepoints dentro de uma transação externa de teste.
- Fixtures sintéticas e alterações administrativas revertidas por `ROLLBACK` ao final. PDFs de teste gravados somente em diretório temporário isolado.
- Nenhuma migration, acesso a outro banco, implantação, commit ou push.
- Esta execução verifica serviços e handlers HTTP em processo; não é uma validação visual no navegador.

## Resultados

| Bloco | Resultado | Evidência exercitada |
|---|---|---|
| Catálogo por pacote | PASS | Composição e quantidades de itens de buffet dos sete pacotes; rolha disponível nos pacotes configurados; itens incluídos não oferecidos como extras pagos em Completa/Premium. Pizza Party permanece sem configuração, conforme catálogo atual. |
| Fronteira de rolha | PASS | API de adicionais e cálculo comercial concordam em 79 e 80 convidados; adicional já incluído é rejeitado como compra extra. |
| Fechamento | PASS | Dois novos fluxos fictícios pelo serviço real, com buffet definido e escolhas persistidas, estado `AGUARDANDO_CONTRATO` e totais conferidos no banco. |
| Administração | PASS | GET sem sessão retorna 401; PATCH sem CSRF retorna 403; edição/inativação de item reflete no catálogo público. |
| PDF informativo | PASS | Upload sem sessão retorna 401; upload autenticado retorna 200; HEAD retorna 204; GET retorna 200, PDF inline e bytes idênticos; republicação mantém um documento ativo e hash correto. |
| Negativos de buffet | PASS | Excesso de escolhas, categoria não incluída e item inexistente retornam `BUFFET_INVALIDO`, sem cadastro/fechamento/snapshot/escolha parcial. |
| Edição de regras | PASS | Nome da categoria e limite de escolhas atualizados via API; adicional indisponível deixa a consulta pública e é rejeitado no cálculo; restauração da regra recupera o preço esperado. |

Total: **7 grupos PASS, 0 FAIL**. Nenhum defeito funcional encontrado nos caminhos exercitados; não houve correção de código da aplicação.

### Valores da fronteira

Pacote Completa, 26/06/2027, 11:00–15:00:

| Convidados | Valor do pacote | Taxa de rolha | Total do fechamento |
|---|---|---|---|
| 79 | R$ 11.390,00 | R$ 190,00 | R$ 11.580,00 |
| 80 | R$ 11.390,00 | R$ 290,00 | R$ 11.680,00 |

## Preservação dos fechamentos anteriores

As dez linhas preexistentes de `fechamentos` foram comparadas integralmente por hash antes, durante e após os testes. Isso inclui seus valores comerciais. Os hashes permaneceram idênticos nas duas execuções:

- `fechamentos`: 10 registros, SHA-256 `5009709cb89bd0bb0e008334cf0ca446c76cfaa191edea58d2d0441ac3af37ca`.
- `fechamento_adicionais` desses fechamentos: 0 registros, SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
- Após cada rollback, o total de fechamentos continuou sendo 10.

## Execuções e evidências

```text
node scripts/catalogo-021.integration.cjs
  catalogo, rolha, fechamento, administracao, pdf: 5 PASS

node scripts/catalogo-021.integration.cjs --only=negativos_buffet,edicao_regras
  negativos_buffet, edicao_regras: 2 PASS
```

O primeiro comando foi executado antes da inclusão dos dois blocos complementares; o segundo executou somente os blocos novos. O runner atual contém os sete blocos.

Resultados locais sanitizados:

- `C:\Users\Glass\AppData\Local\Temp\kidmais-catalogo-regressao-eu5M8j\resultado.json`
- `C:\Users\Glass\AppData\Local\Temp\kidmais-catalogo-regressao-ash2s0\resultado.json`

O runner aceita `--only` para repetir apenas os blocos afetados. Ele exige a branch e o destino acima, dez fechamentos preexistentes e encerra diante de falha.

## Complemento: navegador desktop e celular — 23/09/2026

Esta seção complementa, sem substituir, os sete grupos de integração anteriores.
PASS nesses grupos não equivale a homologação de todas as regras comerciais ou da
interface. A comparação comercial e as pendências estão em
[CATALOGO_V1_021A.md](CATALOGO_V1_021A.md).

### Isolamento e evidência de restauração

- Aplicação Next.js local em `http://localhost:3131`, cópia temporária da branch
  `v1/catalogo-021a`, sem arquivos `.env` e sem alterar os fontes da aplicação no
  checkout. A cópia substituiu somente o executor de banco por um executor real
  com savepoints, dentro de uma transação externa de teste. Isso possibilitou usar
  as páginas e rotas reais no navegador e reverter todas as escritas ao final.
- O destino foi validado antes das escritas: `kidmais_v1_homologacao`, `::1`, porta
  5432; única credencial de origem: `KIDMAIS_HOMOLOGACAO_DATABASE_URL`.
- Conta fictícia temporária com papel `REPRESENTANTE_AUTORIZADO`, validada pelo
  login normal. Nenhum usuário preexistente teve credencial ou permissão alterada.
- Dois fechamentos na primeira sessão de teste (Completa/80 e Premium/79) e um
  fechamento na segunda sessão (Completa/79). Todas as sessões terminaram com
  `ROLLBACK_ALL_PUBLIC_TABLES_IDENTICAL=PASS`: hashes e contagens de **72 tabelas
  públicas** idênticos antes/depois, incluindo os **10 fechamentos originais**.
- O PDF fictício publicado foi removido também do diretório da cópia temporária.
  Servidor encerrado, abas fechadas e override de viewport restaurado.
- Nenhum outro banco, migration ou serviço implantado. Nenhum OTP enviado.
- Consulta externa de CEP foi bloqueada no ambiente de teste; endereço fictício
  foi preenchido manualmente. Fontes Google indisponíveis usaram fallback do Next.
  Essas limitações não foram classificadas como defeitos do catálogo.

### Matriz observada no navegador

| Fluxo | Desktop | Celular | Observação |
|---|---|---|---|
| Login do proprietário fictício | PASS | Sessão preservada | Autenticação real, sem bypass de rota |
| Editar/salvar nome de item do buffet | PASS | PASS | Mensagem “Alteração salva”; persistência confirmada após reabrir no desktop |
| Alterar adicional por pacote | PASS | PASS | Rolha de Completa: Extra pago → Indisponível → Extra pago; PATCH 200, confirmação e persistência |
| Selecionar buffet no fechamento público | PASS | PASS | Escolhas reais; nona opção de salgados rejeitada com “Escolha até 8 em Salgados” |
| Rolha e cálculo do fechamento | PASS | PASS | 79 → R$ 190; 80 → R$ 290; totais Completa R$ 11.580/R$ 11.680 |
| Enviar fechamento público | PASS | PASS | POST `/api/fechamentos` 201 e tela “Solicitação recebida”; nenhum contrato/assinatura solicitado |
| Publicar PDF pela UI | Não repetido | PASS | Publicação 200, metadados exibidos e link público disponível |
| Abrir link do PDF publicado | Link/GET PASS; visual inconclusivo | Link/GET PASS; visual inconclusivo | GET 200; visualizador embutido apresentou tela cinza/ícone de falha. Não homologar renderização visual com essa evidência |

Desktop: viewport solicitado 1365×900, capturas úteis 1350×890. Celular: viewport
solicitado 390×844, capturas úteis em torno de 375×812. Trata-se de responsividade
em navegador emulado, não de aparelho físico ou teste de teclado/touch nativo.

A abertura de uma segunda aba para PDF fez uma tentativa de redimensionamento não
atingir a aba do formulário. A dimensão real das capturas foi conferida; essas
imagens foram reclassificadas como móveis. O fechamento desktop foi repetido em
aba nova, com captura de 1350 pixels confirmada, e passou. Nenhum resultado móvel
foi usado como evidência desktop.

### Problemas de uso e decisões pendentes

1. **Resumo duplicado:** “Total calculado” aparece duas vezes com o mesmo valor.
   Reproduzido em Completa/Premium e nos dois tamanhos. As duas ocorrências estão
   em `components/fechamento/FechamentoWizard.tsx` (linhas 2570 e 2587 nesta base).
2. **Mensagem de reserva contraditória:** resumo/sucesso dizem que a confirmação
   depende das duas assinaturas; a etapa Pagamento afirma que depende da parcela
   inicial. Texto em `FechamentoWizard.tsx:2750`; requer alinhamento com a regra
   já aprovada, sem modificar o mecanismo financeiro por inferência.
3. **Bombom extra sem unidade/quantidade:** no Premium existe escolha de bombom
   incluído e botão “Bombom R$ 7,00” como adicional. Selecionar esse botão somou
   exatamente R$ 7,00, sem controle de quantidade. Não foi presumido que esse
   valor cobre todos os convidados ou que substitui o item incluso. O adicional
   foi desmarcado antes do envio. Unidades e distinção do excedente precisam ser
   definidas/explicitadas; o relatório anterior não cobria essa interpretação.
4. **Catálogo administrativo longo:** todos os itens ficam expostos, com muitos
   botões “Salvar” e sem busca; no celular, chegar aos adicionais exige extensa
   rolagem. A mensagem geral de sucesso fica no topo, distante do item editado.
   Os controles funcionaram, mas a orientação/eficiência de uso merece melhoria.
5. **Lembrancinhas extras não chegam ao cliente:** revisão de código confirmou
   que a API filtra códigos ausentes do mapa `ADICIONAL_CODIGO_BANCO`. Os códigos
   `LEMBRANCINHA_PERSONALIZADA` e `LEMBRANCINHA_PREMIUM`, visíveis no editor,
   não estão nesse mapa. Corrigir requer decidir também a regra de unidade e
   preço; não foram inventadas regras neste teste.
6. **PDF:** publicação e entrega HTTP verificadas, mas falta abrir/renderizar em
   navegador com visualizador PDF funcional. A tela cinza do navegador embutido
   não prova defeito no arquivo ou na rota. Não classificar como PASS visual.

Nenhuma alteração funcional da aplicação foi feita nesta rodada. Os achados
acima foram registrados para revisão; não representam autorização para mudar
composição, unidades, preços ou a regra de reserva.

### Capturas locais

Os arquivos estão em `test-results/catalogo-browser/` (artefatos locais ignorados
pelo Git). As imagens são JPEG; não contêm credenciais ou dados pessoais reais.

- [Editor desktop](../test-results/catalogo-browser/desktop-catalogo.jpg)
- [Editor celular](../test-results/catalogo-browser/mobile-catalogo.jpg)
- [Adicionais celular](../test-results/catalogo-browser/mobile-adicionais.jpg)
- [Resumo desktop, captura com largura confirmada](../test-results/catalogo-browser/desktop-confirmado-resumo.jpg)
- [Resumo celular](../test-results/catalogo-browser/mobile-resumo.jpg)
- [Conclusão desktop](../test-results/catalogo-browser/desktop-confirmado-concluido.jpg)
- [Conclusão celular](../test-results/catalogo-browser/mobile-fechamento-resultado.jpg)
- [Bombom sem unidade no Premium](../test-results/catalogo-browser/mobile-premium-bombom-unidade.jpg)
- [Publicação do PDF](../test-results/catalogo-browser/mobile-publicacao-pdf.jpg)
- [Visualizador PDF inconclusivo](../test-results/catalogo-browser/pdf-visualizador-inconclusivo.jpg)
- `baseline-hashes.json` e `after-hashes.json`: evidências sanitizadas de restauração
  das 72 tabelas da última sessão, na mesma pasta de artefatos.

### Revisão dos dois arquivos da regressão

- `scripts/catalogo-021.integration.cjs`: mantidas as guardas de branch, destino,
  dez fechamentos preexistentes e rollback. Corrigido um falso sucesso possível:
  `--only` vazio/desconhecido antes permitia concluir sem executar grupo algum;
  agora é rejeitado **antes da conexão**. Os dois casos negativos retornaram
  exit 1, como esperado. Sintaxe e ESLint do runner: PASS.
- Este relatório passou a separar os testes de serviços da verificação no
  navegador, registrar dimensões reais e não confundir composição implementada
  com decisão comercial oficial ainda pendente. Não foram repetidas suítes grandes.

## Correção de interface e reteste — 23/09/2026

Branch mantida em `v1/catalogo-021a`. Alterações limitadas à apresentação:

- `FechamentoWizard.tsx`: removida a ocorrência duplicada de “Total calculado”.
  O valor permanece o mesmo, sem mudar cálculo ou desconto.
- Na etapa Pagamento, a mensagem divergente era **“A reserva depende da parcela
  inicial confirmada e da disponibilidade”**. Foi substituída por **“O envio não
  reserva a data. A confirmação depende da disponibilidade e das assinaturas da
  KIDMAIS e do CLIENTE.”** O título passou de “Primeiro pagamento” para
  “Confirmação da contratação”. Nenhuma regra financeira ou de ocupação mudou.
- `CatalogoEditor.tsx` e `catalogo-editor.module.css`: acesso direto às seções
  Buffet/Adicionais, categorias recolhidas com contagem de itens, busca por nome
  de categoria/item/adicional e barra fixa com busca e resultado do salvamento.
  Alternar seção ou filtrar não desmonta os formulários; os handlers existentes
  continuam responsáveis pelas escritas. Nenhum preço, unidade ou vínculo
  comercial foi alterado no código.

### Testes afetados no navegador

| Verificação | Desktop | Celular | Evidência |
|---|---|---|---|
| Editor compacto e busca | PASS | PASS | Categorias recolhidas; busca “Massa”; acesso direto a Adicionais; busca sem resultado informa ausência |
| Editar item de buffet | PASS | PASS | Nome de massa editado/salvo no desktop e restaurado pelo celular; mensagem de confirmação |
| Editar adicional por pacote | PASS | PASS | Taxa para bebida alcoólica de Completa: EXTRA → INDISPONIVEL → EXTRA; confirmação de salvamento em ambos |
| Resumo sem total duplicado | PASS | PASS | Contagem DOM exata de “Total calculado” = 1; R$ 11.580,00 |
| Mensagem da etapa Pagamento | PASS | PASS | Texto de não reserva e duas assinaturas visível; removida a condição de parcela inicial |
| Conclusão do fechamento | PASS | PASS | Mesmo fluxo sintético concluído uma vez, resposta de sucesso examinada nos dois tamanhos; não foram feitos dois envios |
| Agenda após o envio | PASS | — | 24/10/2026, 11:00–15:00 continuou Disponível |

Um novo fechamento sintético, Completa/79 convidados, foi enviado pelo fluxo
público real. Referência R$ 11.390,00 + rolha R$ 190,00 = R$ 11.580,00;
preferência PIX à vista R$ 10.422,00. Buffet deixado “a definir” nesta rodada.
Os testes anteriores de composição e da fronteira 79/80 não foram repetidos,
pois cálculo, catálogo persistido e backend não mudaram.

Viewport solicitado: desktop 1365×900 e celular 390×844. Capturas de viewport
confirmadas em 1350×890 e 375×812. A verificação móvel é emulação responsiva,
não teste em aparelho físico. Algumas capturas de página inteira incluem margem
preta produzida pelo capturador; o conteúdo útil foi inspecionado visualmente.

### PDF fora do visualizador embutido

O próprio PDF fictício usado na regressão foi aberto pelo renderizador
independente **Poppler / pdftoppm**, sem depender do visualizador do navegador.
A imagem resultante foi aberta e inspecionada: página A4 branca, texto legível
“Catalogo ficticio - regressao local”, sem tela cinza ou ícone de falha.

- **Renderização visual independente: PASS**, uma página efetivamente vista.
- SHA-256 do arquivo:
  `6d6dd6e6dda0952a05e8ecfe0a1dc5a9175605fca3421e2881836c91e313c6ac`.
- Poppler retornou exit 0; emitiu avisos de fontes de substituição instaladas
  no ambiente, sem impedir a renderização desse documento.
- O visualizador embutido continua sem homologação: a evidência aponta para uma
  limitação dele, não para PDF corrompido. Nenhuma rota ou arquivo PDF foi
  modificado para mascarar a falha. O PASS cobre este arquivo sintético, não uma
  tabela comercial oficial nem todos os leitores PDF.

### Reversão e validação local

- Destino revalidado antes de escrever: `kidmais_v1_homologacao`, `::1`, porta
  `5432`, exclusivamente pela variável dedicada de homologação.
- Browser serviu cópia isolada do código atual, sem `.env`, usando conexão única
  com transação externa e savepoints. Nenhuma escrita de teste foi commitada.
- Após encerrar o servidor, consulta independente **READ ONLY** confirmou as
  **72 tabelas públicas idênticas ao baseline**, por contagem e hash de linhas.
  Os **10 fechamentos anteriores e seus valores permanecem intactos**;
  SHA-256: `5009709cb89bd0bb0e008334cf0ca446c76cfaa191edea58d2d0441ac3af37ca`.
- ESLint dos dois componentes: PASS. TypeScript `--noEmit`: PASS.
- Build isolado `next build --webpack`: PASS (26 páginas). Primeira tentativa
  bloqueada pelo sandbox ao baixar Google Fonts; reexecução autorizada passou.
  Nenhuma credencial real foi fornecida ao build; URL sintética inválida.
- `git diff --check`: PASS. Sem migrations, deploy, commit ou push.

Capturas/evidências locais, ignoradas pelo Git:

- [Editor desktop corrigido](../test-results/catalogo-browser/fix-desktop-catalogo.jpg)
- [Editor celular corrigido](../test-results/catalogo-browser/fix-mobile-catalogo.jpg)
- [Salvamento no celular](../test-results/catalogo-browser/fix-mobile-edicao.jpg)
- [Adicionais no celular](../test-results/catalogo-browser/fix-mobile-adicionais.jpg)
- [Resumo desktop corrigido](../test-results/catalogo-browser/fix-desktop-resumo.jpg)
- [Resumo celular corrigido](../test-results/catalogo-browser/fix-mobile-resumo.jpg)
- [Mensagem de pagamento no celular](../test-results/catalogo-browser/fix-mobile-pagamento.jpg)
- [Conclusão sem reserva](../test-results/catalogo-browser/fix-mobile-concluido.jpg)
- [Agenda após envio](../test-results/catalogo-browser/fix-agenda-apos-envio.jpg)
- [PDF visualizado fora do navegador](../test-results/catalogo-browser/pdf-render-independente.png)
- [Arquivo PDF verificado](../test-results/catalogo-browser/pdf-ficticio-verificado.pdf)
- `fix-baseline-hashes.json`, `fix-after-hashes.json` e `fix-build.log` na mesma pasta.

Permanecem pendentes as definições comerciais de bombom, lembrancinhas e Pizza
Party descritas acima. Nenhum preço ou unidade foi inferido ou definido.

## Buffet congelado por versão e download do PDF — 23/09/2026

### Auditoria e lacuna corrigida

O caminho examinado foi:

`FechamentoWizard → criarFechamentoPublicoComIdentidade → fechamentos /
fechamento_buffet_escolhas → carregarSnapshot / montarSnapshotContratoV1 →
contrato_versoes.snapshot → documentoParaLeitura / contrato_documentos`.

Antes do patch, o serviço validava os IDs de `escolhasBuffet` e persistia os
nomes aplicados em `fechamento_buffet_escolhas`, mas os campos textuais do
fechamento eram preenchidos separadamente pelo navegador. O snapshot contratual
consome esses campos textuais: um envio apenas com IDs podia gerar um contrato
sem as escolhas; textos manipulados podiam divergir das escolhas validadas.

Agora `escolhas-buffet.service.ts` resolve os IDs no servidor uma única vez,
mantendo as validações existentes de pacote, categoria, item ativo, limites e
duplicação. Os mesmos nomes resolvidos alimentam tanto a trilha de escolhas
quanto os campos persistidos do fechamento usados pelo snapshot. Massa e recheio
ficam identificados separadamente no texto de bolo. Lembrancinha, empratado e
bombom também são congelados. Categorias adicionais são identificadas pelo nome
aplicado em `buffetOutros`, sem atribuir preço ou unidade.

Com escolhas estruturadas presentes, textos de categorias selecionáveis enviados
pelo navegador não prevalecem sobre os nomes validados. Textos livres de bebidas
e observações continuam permitidos conforme o formulário. Escolhas estruturadas
com status PENDENTE são recusadas. Sem IDs selecionados, o caminho legado e a
edição administrativa com texto livre permanecem preservados.

Não há atualização retroativa dos snapshots existentes. `carregarSnapshot` copia
os textos persistidos, não busca nomes atuais no catálogo. A revisão usa operação
própria, cria uma versão independente e conserva a anterior. A leitura do PDF
revisado usa o BYTEA e hash preservados em `contrato_documentos`; não o regenera
com o catálogo atual. Templates jurídicos, cláusulas, hashes antigos e código de
assinatura não foram modificados.

### Testes no clone

Destino antes de escrita: **`kidmais_v1_homologacao`, loopback `::1`, porta 5432**.
Somente variável dedicada; sem dotenv, banco alternativo ou transporte externo.
Serviços reais e PostgreSQL local, com transação externa revertida ao final.

| Teste afetado | Resultado | Evidência |
|---|---|---|
| Fechamento com IDs de buffet | PASS | Nomes do servidor persistidos mesmo com textos de salgados/bombom manipulados no input |
| Renomear catálogo antes de gerar contrato | PASS | V1 contém nomes escolhidos originalmente; doces, bolo, lembrancinha, empratado e bombom conferidos |
| Criação e dupla assinatura da V1 | PASS | Fluxos reais administrativos/identidade/assinatura; somente transporte OTP simulado em memória |
| Renomear catálogo depois de assinar | PASS | V1 assinada permanece íntegra |
| Revisão e dupla assinatura da V2 | PASS | Buffet revisado somente na V2; ponteiro vigente atualizado; exatamente uma Festa por contrato |
| Leitura histórica da V1 após V2 | PASS | Registro completo da versão, snapshot/hash, documentos/provas e bytes/hash do PDF idênticos aos anteriores |
| Tentativa de editar V1 assinada | PASS | Serviço recusa com 409 |
| Fechamento e negativos de buffet | PASS | Dois grupos afetados: persistência/cálculo e rejeição sem cadastro ou fechamento parcial |
| PDF publicado inline e download | PASS | Ambos HTTP 200 e bytes idênticos ao upload; download com `Content-Disposition: attachment; filename="pacotes-e-precos.pdf"` |

Foram executados **4 grupos de integração afetados, 0 FAIL ao final**:
`fechamento`, `negativos_buffet`, `contrato_buffet`, `pdf`. Nas primeiras
execuções do novo grupo, o fixture omitiu data/horário e a flag local `FESTA_ENABLED`;
essas condições do teste foram corrigidas, sem afrouxar guardas da aplicação.
Cada tentativa, inclusive as interrompidas, terminou com restauração conferida.

Evidências sanitizadas: `resultado.json` nas pastas temporárias
`kidmais-catalogo-regressao-1UxJnl` (fechamento/negativos PASS),
`kidmais-catalogo-regressao-d8R48Y` (contrato/PDF PASS) e
`kidmais-catalogo-regressao-fZvZp8` (reteste do handler de download PASS).

- **72 tabelas restauradas**, conferidas por contagem e hash após ROLLBACK.
- **10 fechamentos anteriores intactos**, com o mesmo hash já registrado acima.
- Testes de snapshot, revisão inicial, pré/pós-assinatura e documento: **77 PASS,
  0 FAIL**. Nenhuma suíte extensa não relacionada foi repetida.
- ESLint dos arquivos afetados, TypeScript e build isolado: **PASS**.
  O build detectou que o novo parâmetro `Request` do GET não podia ser opcional;
  assinatura corrigida e build repetido com sucesso. Build sem credencial real,
  usando destino sintético inválido e sem `.env`.
- `git diff --check`: **PASS**.

### Saída do visualizador embutido

No fechamento público e na administração da tabela existem duas ações claras:
**Abrir PDF em nova aba** e **Baixar PDF para abrir no seu leitor**, acompanhadas
da instrução de baixar se a tela ficar em branco. O segundo link usa
`?download=1`, com disposição de anexo definida pelo servidor e nome fixo seguro.
Não depende de o navegador embutido conseguir renderizar PDF. Headers de
segurança e cache foram mantidos. O teste de entrega/download é HTTP e compara
bytes; a evidência visual independente do arquivo continua sendo a renderização
Poppler registrada na rodada anterior, sem novo PASS para o viewer embutido.

Sem migrations, preços/unidades novos, acesso a outros bancos, deploy, commit ou
push. Mudanças desta rodada: serviço público e novo helper de escolhas, handler
do PDF, links no wizard e na administração, runner e este relatório. As demais
alterações locais anteriores foram preservadas.
