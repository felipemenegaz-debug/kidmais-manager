# Exportação verificável dos dados da empresa (21/10/2026)

**Estado: LOCAL.** Implementado e validado só neste clone (`codex/exportacao-verificavel-20261021`, base staging `2139966`). Sem push, PR, deploy, env ou banco remoto. PostgreSQL só em cluster descartável local. Nenhuma migration nova.

Atende o item 1 de `pacote-revisao-juridica-astra-20261020/v2/PLANO-PROCEDIMENTOS.md`, a lacuna L2 e o ajuste 6 do parecer da Astra de 21/10/2026. Pontos do parecer cobertos: informar formatos e abrangência, permitir exportação durante a suspensão e não bloquear a exportação para forçar aceite.

## O que a Gestão vê

- **Admin → Assinatura → Exportar dados.** O botão **Baixar pacote completo (ZIP)** baixa o pacote. A tela mostra o nome do arquivo e o **código de conferência**, que é o SHA-256 do `MANIFESTO.json`.
  - Os links **Clientes (CSV)** e **Contas a receber (CSV)** continuam como antes.
  - A seção aparece só para a Gestão e em qualquer situação da assinatura: teste, somente leitura ou bloqueio comercial. O paywall sempre permite `/api/admin/exportacao`.
- **Empresa suspensa pelo painel do desenvolvedor.** A suspensão encerra a sessão. Depois de entrar de novo, a Gestão vê **Exportar dados de empresa suspensa** na tela "Sem empresa ativa" ou na tela de escolha de empresa, com o mesmo botão.

## API

`GET /api/admin/exportacao?tipo=completa[&empresaId=<uuid>]`

- **200:** `application/zip`, com `Content-Disposition: attachment; filename="kidmais-exportacao-<codigo>-<AAAAMMDDTHHMMSSZ>.zip"` e `Cache-Control: no-store`. Cabeçalhos próprios:
  - `X-Kidmais-Exportacao-Formato: 1`
  - `X-Kidmais-Manifesto-Sha256`
  - `X-Kidmais-Pacote-Sha256`
- **Recusas:**
  - `403 TENANT_NAO_COMPROVADO`: sem vínculo, outra empresa, empresa desativada ou sessão em outra empresa;
  - `403 PAPEL_NAO_AUTORIZADO`: Equipe;
  - `413 EXPORTACAO_GRANDE_DEMAIS`;
  - `503 EXPORTACAO_DEMORADA`;
  - `429 EXPORTACAO_OCUPADA`.
- `tipo=clientes` e `tipo=contas-receber` continuam iguais, agora pela mesma guarda.
- `GET /api/admin/exportacao/empresas-suspensas` devolve `{ id, nome }` das empresas SUSPENSAS em que a pessoa é Gestão com vínculo ativo. A lista só sai se a sessão não estiver selecionada em outra empresa. A rota não concede nada.

## Formato do pacote (versão 1)

```
MANIFESTO.json        versão, data, empresa, consistência, regras do CSV, cada arquivo (linhas, colunas, colunas excluídas e motivo, bytes, SHA-256), entidades ausentes e tabelas fora do pacote
SHA256SUMS.txt        "<sha256>  <caminho>" (formato do sha256sum), inclusive o do MANIFESTO.json
LEIA-ME.txt           o que é cada coisa e como conferir
dados/<grupo>/<entidade>.csv   um arquivo por tabela do inventário
arquivos/contratos/<documento_id>.pdf   PDF de cada documento de contrato (contrato e comprovante)
```

- **CSV:**
  - separador `;`, UTF-8 com BOM e fim de linha CRLF, para abrir direto no Excel;
  - aspas no padrão RFC 4180; célula vazia = nulo;
  - cabeçalho com o nome técnico da coluna; os nomes e o significado de cada arquivo estão no MANIFESTO.
- **Valores:** saem como texto do PostgreSQL.
  - Datas e horas em UTC (`2026-10-21 13:45:00+00`).
  - Booleanos `true`/`false`; listas e JSON como texto JSON.
  - Colunas `*_centavos` em centavos; as demais colunas numéricas, como estão no banco.
- **Fórmulas:** texto livre que começa com `=`, `+`, `-` ou `@` (ou tabulação/CR) recebe um apóstrofo na frente. O valor original é o texto sem o apóstrofo. Números, datas, uuid e booleanos não mudam, então um valor negativo continua número.
- **Binários (`bytea`):** viram `<coluna>__bytes` e `<coluna>__sha256`. Só o PDF dos contratos (`contrato_documentos.conteudo_pdf`) também vai como arquivo, indicado em `conteudo_pdf__arquivo`. O pacote confere que o SHA-256 do arquivo é o mesmo calculado pelo banco.
- **Consistência:** a leitura é uma única transação `REPEATABLE READ READ ONLY`, então todos os arquivos refletem o mesmo instante (`geradoEm`).
- **Ambientes diferentes:** as colunas são lidas do schema no momento. Tabela de migration ainda não aplicada no ambiente vira entrada em `entidadesAusentes`, sem erro e sem inventar arquivo.
- **Ordem das linhas:** chave primária, para o mesmo banco gerar o mesmo CSV.

## Como conferir os hashes

1. **Na tela:** guarde o código de conferência mostrado. Ele também fica na auditoria da plataforma (`EXPORTACAO_DADOS`, campo `manifestoSha256`). Se o `MANIFESTO.json` confere, todos os hashes listados nele valem.
2. **Linux ou macOS**, na pasta extraída: `sha256sum -c SHA256SUMS.txt` (ou `shasum -a 256 -c SHA256SUMS.txt`). Todas as linhas devem dar `OK`.
3. **Windows (PowerShell):** `Get-FileHash -Algorithm SHA256 .\MANIFESTO.json` e compare com o código da tela. O PowerShell mostra em maiúsculas; o valor é o mesmo. Faça o mesmo para qualquer arquivo de `dados/` contra o `MANIFESTO.json`.
4. **Linhas:** o número de linhas de cada CSV, sem o cabeçalho, é o campo `linhas` do arquivo no MANIFESTO.

## Isolamento, autorização e auditoria

- **Isolamento:** cada entidade é uma tabela filtrada só pela empresa comprovada (`$1`), de um de dois jeitos:
  - direto por `empresa_id`;
  - pela cadeia de posse até uma tabela que tem `empresa_id`: cliente; fechamento → contrato → versão → pagamento/plano/parcela; contrato → festa; convite; tabela de preço; pacote.
  - Os aliases das subconsultas são sempre qualificados, e um teste estático confere.
  - O perfil cadastral usa a mesma associação perfil ↔ empresa de `lib/perfil/autorizacao.ts`.
- **Autorização:** só a Gestão (`REPRESENTANTE_AUTORIZADO`), com o papel do vínculo nesta empresa. Equipe recebe 403.
- **Três transações curtas** (`lib/exportacao/servico.ts`):
  1. prova do tenant;
  2. leitura, sem travas da empresa;
  3. nova prova com a mesma empresa, o mesmo vínculo e a mesma situação, seguida de auditoria e revalidação antes do commit.
  - O arquivo só é entregue depois da fase 3. Vínculo suspenso, papel trocado, empresa suspensa ou desativada no meio: nada é entregue e nada é auditado.
- **Auditoria:** uma linha `EXPORTACAO_DADOS` (`entidade_tipo = EMPRESA`, `origem = EXPORTACAO`) com usuário, empresa e `requestId`. Nos dados ficam só contagens e hashes: tipo, formato, `geradoEm`, arquivos, linhas, bytes, PDFs, entidades ausentes, `manifestoSha256`, `zipSha256`, `empresaSuspensa` e resultado. Não ficam conteúdo, IP nem navegador.

## Decisão: exportação de empresa suspensa (exceção mínima)

- **Problema:** `provarTenant` (`lib/saas/provar-tenant.ts:76`) só aceita empresa `ATIVA`, então a suspensão administrativa prendia os dados. A suspensão comercial (bloqueio por vencimento) já não prendia: o paywall libera a rota.
- **Solução:** guarda própria, só da exportação (`lib/exportacao/guarda.ts`):
  - **Empresa ATIVA:** exatamente `provarTenant` + Gestão. Nada muda.
  - **Empresa SUSPENSA:** aceita somente quando, na mesma transação e na ordem de travas usuário → empresa → vínculo:
    - a empresa foi pedida explicitamente por `empresaId`;
    - o status é `SUSPENSA`, nunca `DESATIVADA` nem `PROVISIONAMENTO`;
    - a pessoa está ativa;
    - a sessão continua válida e não está selecionada em outra empresa;
    - o vínculo dessa empresa está `ATIVA` com papel Gestão.
  - A revalidação antes do commit exige o mesmo estado.
- **Alcance:** só as rotas `/api/admin/exportacao` usam a guarda; um teste estático confere. `provarTenant` continua recusando a suspensa em todo o resto, e o teste PostgreSQL confere. A suspensão continua revogando as sessões selecionadas na empresa (063).
- **Por que é seguro o bastante:**
  - é somente leitura, mais a auditoria;
  - vale só para a Gestão, que já é a responsável pelos dados;
  - o evento fica marcado com `empresaSuspensa: true`.
- **Risco aceito, para decisão de Felipe:** uma suspensão **por segurança**, como conta comprometida, também deixa exportar.
  - Hoje não há como distinguir o motivo sem migration: o motivo da suspensão é texto livre.
  - Se for preciso bloquear nesse caso, a saída sem migration é revogar ou suspender o vínculo da Gestão afetada, o que fecha também a exportação.
  - A saída com migration (089) é uma marca "suspensão por segurança" na empresa.

## Limites

| Limite | Valor | Comportamento |
|---|---|---|
| Linhas por arquivo | 200 000 | acima disso, 413, sem pacote parcial |
| Tamanho total (CSV + PDFs, sem compressão) | 150 MB | 413; a mensagem orienta a falar com o suporte |
| Tempo total de montagem | 120 s | 503 |
| Tempo por comando SQL | 60 s (`statement_timeout`) | 503 |
| Exportações simultâneas por processo | 2 | 429; tentar de novo em um minuto |

- **Memória:** o pacote é montado em memória porque o manifesto precisa dos hashes de todos os arquivos e a entrega só acontece depois da revalidação.
- **Streaming:** não foi necessário nos volumes atuais. Fica como evolução se alguma empresa passar dos limites.
- **ZIP:** gerador próprio (PKZIP 2.0, deflate do zlib, sem ZIP64), sem dependência nova. Validado com `unzip -t`, `System.IO.Compression` e `sha256sum -c`.

## Inventário (schema até a 088: 174 tabelas = 143 no pacote + 31 fora)

As colunas exportadas de cada tabela ficam fixadas em `lib/exportacao/colunas-esperadas.json`. A suíte PostgreSQL falha quando:
- uma migration acrescenta tabela sem decisão (no pacote ou fora, com motivo);
- uma migration muda as colunas exportadas.

Nos dois casos, revisar se há segredo e atualizar com `KIDMAIS_EXPORTACAO_ATUALIZAR_RETRATO=1`.

**Nunca saem:**
- por lista declarada: senhas e hashes de senha, códigos dos links públicos (`publico_token`, `token_hash` das famílias, `editor_hash`), códigos e provas de OTP, credenciais cifradas do WhatsApp, `token` dos arquivos, código de verificação de domínio e travas internas;
- por padrão de nome (defesa em profundidade): qualquer coluna com `senha`, `password`, `token_hash`, `csrf`, `credencial`, `secret`, `segredo` e outros nomes do mesmo tipo.

### Empresa

| Arquivo (`dados/…csv`) | Tabela | Conteúdo | Colunas |
|---|---|---|---|
| `empresa/empresa` | `empresas` | A própria empresa (código, nome, situação). | 7 |
| `empresa/perfil_empresa` | `perfil_empresas` | Perfil cadastral (nome comercial, razão social, CNPJ, sede). | 17 |
| `empresa/perfil_unidades` | `perfil_unidades` | Unidades do perfil. | 21 |
| `empresa/perfil_revisoes` | `perfil_empresa_revisoes` | Revisões do perfil cadastral. | 14 |
| `empresa/perfil_concessoes` | `perfil_empresa_concessoes` | Concessões de edição do perfil. | 11 |
| `empresa/cadastro` | `cadastros_empresas` | Cadastro feito pela própria empresa. | 5 |
| `empresa/socios` | `empresa_socios` | Sócios declarados. | 7 |
| `empresa/representacoes` | `empresa_representacoes` | Representações da empresa. | 10 |
| `empresa/estabelecimentos` | `estabelecimentos` | Estabelecimentos (unidades) da empresa. | 8 |
| `empresa/aceites_documentos_legais` | `aceites_documentos_legais` | Aceites dos Termos e do Aviso pelas pessoas da empresa. | 8 |
| `empresa/assinatura` | `empresa_assinaturas` | Assinatura do Kidmais Manager (situação e ciclo). | 20 |
| `empresa/assinatura_contratacoes` | `assinatura_contratacoes` | Contratações da assinatura. | 18 |
| `empresa/assinatura_renovacoes` | `assinatura_renovacoes` | Avisos de renovação da assinatura. | 16 |
| `empresa/usuarios` | `usuarios_administrativos` | Pessoas com vínculo nesta empresa (sem senha nem papel global). | 6 |
| `empresa/vinculos` | `memberships` | Vínculos (papel e situação de cada pessoa nesta empresa). | 11 |
| `empresa/vinculo_estabelecimentos` | `membership_estabelecimentos` | Estabelecimentos de cada vínculo. | 10 |
| `empresa/vinculo_capacidades` | `empresa_membership_capacidades` | Capacidades concedidas por vínculo. | 10 |
| `empresa/vinculo_capacidades_festa` | `festa_membership_capacidades` | Capacidades de Festa por vínculo. | 10 |
| `empresa/vinculo_capacidades_marketing` | `marketing_membership_capacidades` | Capacidades de Marketing por vínculo. | 10 |
| `empresa/convites_de_acesso` | `convites_acesso` | Convites de acesso enviados a pessoas. | 17 |
| `empresa/solicitacoes_de_acesso` | `solicitacoes_acesso_empresa` | Pedidos de acesso à empresa. | 9 |

### Clientes

| Arquivo (`dados/…csv`) | Tabela | Conteúdo | Colunas |
|---|---|---|---|
| `clientes/clientes` | `clientes` | Clientes (responsáveis contratantes). | 23 |
| `clientes/aniversariantes` | `aniversariantes` | Aniversariantes de cada cliente. | 12 |
| `clientes/responsaveis_adicionais` | `responsaveis_adicionais` | Outros responsáveis do cliente. | 15 |
| `clientes/historico` | `eventos_historico_cliente` | Histórico de eventos do cliente. | 12 |
| `clientes/mesclagens` | `mesclagens_clientes` | Mesclagens de cadastros duplicados. | 7 |
| `clientes/possiveis_duplicidades` | `possiveis_duplicidades_cliente` | Possíveis duplicidades apontadas. | 10 |
| `clientes/validacoes_identidade` | `validacoes_identidade_cliente` | Validações de identidade do cliente (sem código nem prova). | 19 |

### Contratos

| Arquivo (`dados/…csv`) | Tabela | Conteúdo | Colunas |
|---|---|---|---|
| `contratos/fechamentos` | `fechamentos` | Fechamentos (negociação da festa). | 52 |
| `contratos/fechamento_adicionais` | `fechamento_adicionais` | Adicionais de cada fechamento. | 12 |
| `contratos/fechamento_revisoes` | `fechamento_revisoes` | Revisões de fechamento. | 71 |
| `contratos/fechamento_revisao_adicionais` | `fechamento_revisao_adicionais` | Adicionais das revisões. | 12 |
| `contratos/aprovacoes_negociacao` | `aprovacoes_negociacao` | Aprovações de negociação. | 14 |
| `contratos/fechamento_pacote_snapshots` | `fechamento_pacote_snapshots` | Pacote congelado no fechamento. | 34 |
| `contratos/fechamento_pacote_composicao` | `fechamento_pacote_composicao` | Composição do pacote congelado. | 11 |
| `contratos/fechamento_pacote_itens_especificos` | `fechamento_pacote_itens_especificos` | Itens específicos do pacote congelado. | 6 |
| `contratos/fechamento_buffet_snapshots` | `fechamento_buffet_snapshots` | Buffet congelado no fechamento. | 4 |
| `contratos/fechamento_buffet_escolhas` | `fechamento_buffet_escolhas` | Escolhas do buffet congelado. | 8 |
| `contratos/contratos` | `contratos` | Contratos. | 9 |
| `contratos/contrato_versoes` | `contrato_versoes` | Versões de cada contrato (com o retrato contratual). | 15 |
| `contratos/contrato_documentos` | `contrato_documentos` | Documentos (PDF) de cada versão; o arquivo está em arquivos/contratos/. | 14 |
| `contratos/contrato_assinaturas` | `contrato_assinaturas` | Assinaturas e aceites (evidência: método, data, IP e navegador). | 20 |
| `contratos/contrato_edicoes` | `contrato_edicoes` | Edições de versão. | 20 |
| `contratos/contrato_fluxos` | `contrato_fluxos` | Versão vigente e em preparação. | 5 |
| `contratos/contrato_pendencias_financeiras` | `contrato_pendencias_financeiras` | Pendências financeiras entre versões. | 8 |
| `contratos/importacoes` | `contrato_importacoes` | Contratos importados. | 24 |
| `contratos/importacao_financeiro` | `contrato_importacao_financeiro` | Financeiro dos contratos importados. | 15 |

### Festas

| Arquivo (`dados/…csv`) | Tabela | Conteúdo | Colunas |
|---|---|---|---|
| `festas/festas` | `festas` | Festas. | 13 |
| `festas/buffet` | `festa_buffet` | Buffet da festa. | 11 |
| `festas/contagens_convidados` | `festa_contagens_convidados` | Contagens de convidados. | 12 |
| `festas/eventos` | `festa_eventos` | Eventos da festa. | 19 |
| `festas/pendencias` | `festa_pendencias` | Pendências da festa. | 13 |
| `festas/solicitacoes` | `festa_solicitacoes` | Solicitações da festa. | 16 |
| `festas/tarefas` | `festa_tarefas` | Tarefas da festa. | 14 |
| `festas/areas` | `festa_areas` | Áreas da equipe. | 8 |

### Financeiro

| Arquivo (`dados/…csv`) | Tabela | Conteúdo | Colunas |
|---|---|---|---|
| `financeiro/pagamentos` | `pagamentos` | Pagamentos de cada versão de contrato. | 13 |
| `financeiro/pagamento_planos` | `pagamento_planos` | Planos de pagamento. | 14 |
| `financeiro/parcelas` | `pagamento_parcelas` | Parcelas a receber. | 9 |
| `financeiro/recebimentos` | `pagamento_recebimentos` | Recebimentos. | 16 |
| `financeiro/recebimento_alocacoes` | `pagamento_recebimento_alocacoes` | Alocação dos recebimentos nas parcelas. | 5 |
| `financeiro/comprovantes` | `pagamento_comprovantes` | Comprovantes de recebimento (metadados). | 9 |
| `financeiro/estornos` | `pagamento_estornos` | Estornos. | 16 |
| `financeiro/gestoes` | `pagamento_gestoes` | Gestão de cada pagamento. | 4 |
| `financeiro/pagamento_eventos` | `pagamento_eventos` | Eventos do pagamento. | 17 |
| `financeiro/tratamentos` | `pagamento_tratamentos` | Tratamentos de pendência. | 10 |
| `financeiro/ajustes_contratuais` | `pagamento_ajustes_contratuais` | Ajustes contratuais. | 15 |
| `financeiro/ajuste_bases` | `pagamento_ajuste_bases` | Bases dos ajustes. | 7 |
| `financeiro/credito_reservas` | `pagamento_credito_reservas` | Reservas de crédito. | 8 |
| `financeiro/cronogramas` | `pagamento_cronogramas` | Cronogramas. | 13 |
| `financeiro/cronograma_itens` | `pagamento_cronograma_itens` | Itens dos cronogramas. | 10 |
| `financeiro/devolucoes` | `pagamento_devolucoes` | Devoluções ao cliente. | 18 |
| `financeiro/devolucao_alocacoes` | `pagamento_devolucao_alocacoes` | Alocação das devoluções. | 4 |
| `financeiro/devolucao_comprovantes` | `pagamento_devolucao_comprovantes` | Comprovantes de devolução (tamanho e SHA-256). | 10 |
| `financeiro/movimentos_contextos` | `pagamento_movimentos_contextos` | Contexto econômico dos movimentos. | 9 |
| `financeiro/categorias` | `financeiro_categorias` | Categorias do contas a pagar. | 6 |
| `financeiro/contas_pagar` | `financeiro_contas_pagar` | Contas a pagar. | 17 |
| `financeiro/saidas` | `financeiro_saidas` | Pagamentos das contas (saídas). | 10 |
| `financeiro/recorrencias` | `financeiro_recorrencias` | Recorrências do contas a pagar. | 6 |
| `financeiro/entradas_manuais` | `financeiro_entradas_manuais` | Entradas manuais. | 15 |
| `financeiro/auditoria_financeira` | `financeiro_auditoria` | Auditoria do financeiro da empresa. | 8 |

### Agenda

| Arquivo (`dados/…csv`) | Tabela | Conteúdo | Colunas |
|---|---|---|---|
| `agenda/configuracao_agenda` | `configuracao_agenda` | Horários e configuração da agenda. | 13 |
| `agenda/regras_categoria_horario` | `regras_categoria_horario` | Regras de categoria por horário. | 10 |
| `agenda/bloqueios` | `bloqueios_agenda` | Bloqueios da agenda. | 13 |

### Catálogo

| Arquivo (`dados/…csv`) | Tabela | Conteúdo | Colunas |
|---|---|---|---|
| `catalogo/pacotes` | `pacotes` | Pacotes. | 15 |
| `catalogo/pacote_adicionais` | `pacote_adicionais` | Adicionais de cada pacote. | 6 |
| `catalogo/pacote_buffet_categorias` | `pacote_buffet_categorias` | Categorias de buffet do pacote. | 8 |
| `catalogo/pacote_buffet_itens` | `pacote_buffet_itens` | Itens de buffet do pacote. | 4 |
| `catalogo/pacote_itens_especificos` | `pacote_itens_especificos` | Itens específicos do pacote. | 3 |
| `catalogo/regras_desconto_pacote` | `regras_desconto_pacote` | Descontos por pacote. | 15 |
| `catalogo/regras_disponibilidade_pacote` | `regras_disponibilidade_pacote` | Disponibilidade por pacote. | 11 |
| `catalogo/adicionais` | `adicionais` | Adicionais. | 16 |
| `catalogo/buffet_categorias` | `buffet_categorias` | Categorias do buffet. | 10 |
| `catalogo/buffet_itens` | `buffet_itens` | Itens do buffet. | 11 |
| `catalogo/tabelas_preco` | `tabelas_preco` | Tabelas de preço. | 13 |
| `catalogo/precos_pacote` | `precos_pacote` | Preços de pacote. | 12 |
| `catalogo/precos_adicional` | `precos_adicional` | Preços de adicional. | 10 |
| `catalogo/tabela_preco_escopos` | `tabela_preco_escopos` | Escopos das tabelas. | 8 |
| `catalogo/tabela_preco_escopo_faixas` | `tabela_preco_escopo_faixas` | Faixas dos escopos. | 5 |
| `catalogo/parametros_consumo` | `operacional_parametros_consumo` | Parâmetros operacionais de consumo. | 17 |
| `catalogo/regras_pagamento` | `empresa_regras_pagamento` | Regras de pagamento da empresa. | 8 |
| `catalogo/pix_recebimento` | `empresa_pix_recebimento` | Chave Pix de recebimento da empresa. | 8 |
| `catalogo/modelos_contrato` | `modelos_contrato_empresa` | Modelos de contrato da empresa. | 10 |
| `catalogo/importacoes_comerciais` | `importacoes_comerciais` | Importações de tabela de preços e modelo (arquivo: tamanho e SHA-256). | 22 |

### Convites

| Arquivo (`dados/…csv`) | Tabela | Conteúdo | Colunas |
|---|---|---|---|
| `convites/convites` | `convites` | Convites (sem o código do link público). | 16 |
| `convites/familias` | `convite_familias` | Famílias convidadas (sem o código do link). | 10 |
| `convites/respostas` | `convite_respostas` | Respostas (confirmação de presença). | 7 |
| `convites/eventos` | `convite_eventos` | Eventos do convite. | 6 |
| `convites/artes` | `convite_artes` | Artes do convite (imagem: tamanho e SHA-256). | 7 |
| `convites/geracoes` | `convite_geracoes` | Gerações com IA (resultado: tamanho e SHA-256). | 23 |
| `convites/autorizacoes_ia` | `convite_ia_autorizacoes` | Autorizações do responsável para IA. | 19 |

### Marketing

| Arquivo (`dados/…csv`) | Tabela | Conteúdo | Colunas |
|---|---|---|---|
| `marketing/sites` | `marketing_sites` | Sites. | 14 |
| `marketing/site_versoes` | `marketing_site_versoes` | Versões publicadas dos sites. | 7 |
| `marketing/site_imagens` | `marketing_site_imagens` | Imagens dos sites (tamanho e SHA-256). | 14 |
| `marketing/dominios` | `marketing_dominios` | Domínios (sem o código de verificação). | 15 |
| `marketing/campanhas` | `marketing_campanhas` | Campanhas. | 21 |
| `marketing/origens_opcoes` | `marketing_origens_opcoes` | Opções de origem. | 9 |
| `marketing/contatos` | `marketing_contatos` | Contatos (leads). | 19 |
| `marketing/contato_autorizacoes` | `marketing_contato_autorizacoes` | Autorizações de contato. | 18 |
| `marketing/contato_preferencias` | `marketing_contato_preferencias` | Preferências de contato. | 7 |
| `marketing/contato_preferencias_eventos` | `marketing_contato_preferencias_eventos` | Histórico das preferências. | 8 |
| `marketing/atribuicoes` | `marketing_atribuicoes` | Atribuição de origem. | 17 |
| `marketing/eventos` | `marketing_eventos` | Eventos de Marketing. | 6 |
| `marketing/automacao_regras` | `marketing_automacao_regras` | Regras de automação. | 24 |
| `marketing/automacao_execucoes` | `marketing_automacao_execucoes` | Execuções das automações. | 23 |
| `marketing/automacao_eventos` | `marketing_automacao_eventos` | Eventos das execuções. | 7 |
| `marketing/tarefas` | `marketing_tarefas` | Tarefas de Marketing. | 12 |

### WhatsApp

| Arquivo (`dados/…csv`) | Tabela | Conteúdo | Colunas |
|---|---|---|---|
| `whatsapp/conexoes` | `whatsapp_conexoes` | Conexões do número (sem credenciais). | 23 |
| `whatsapp/configuracao` | `whatsapp_atendimento_config` | Configuração do atendimento. | 4 |
| `whatsapp/retencao` | `whatsapp_atendimento_retencao_config` | Prazo de retenção definido. | 5 |
| `whatsapp/conversas` | `whatsapp_atendimento_conversas` | Conversas. | 15 |
| `whatsapp/mensagens` | `whatsapp_atendimento_mensagens` | Mensagens. | 24 |
| `whatsapp/arquivos` | `whatsapp_atendimento_arquivos` | Arquivos e mídias (tamanho e SHA-256, sem o link). | 16 |
| `whatsapp/mensagens_prontas` | `whatsapp_atendimento_mensagens_prontas` | Mensagens prontas. | 22 |
| `whatsapp/mensagens_prontas_favoritas` | `whatsapp_atendimento_mensagens_prontas_favoritas` | Favoritas por pessoa. | 5 |
| `whatsapp/controles_contato` | `whatsapp_atendimento_controles_contato` | Controles por contato (não contatar, sem automático). | 8 |
| `whatsapp/privacidade` | `whatsapp_atendimento_privacidade` | Pedidos de privacidade atendidos. | 17 |
| `whatsapp/auditoria` | `whatsapp_atendimento_auditoria` | Auditoria do atendimento. | 7 |

### Importações

| Arquivo (`dados/…csv`) | Tabela | Conteúdo | Colunas |
|---|---|---|---|
| `ia/documentos` | `ia_documentos` | Documentos enviados para leitura. | 7 |
| `ia/documento_originais` | `ia_documento_originais` | Originais (tamanho e SHA-256). | 12 |
| `ia/extracoes` | `ia_extracoes` | Extrações dos documentos. | 14 |
| `ia/evidencias` | `ia_evidencias` | Evidências das extrações. | 7 |
| `ia/importacoes` | `ia_importacoes` | Importações a partir das extrações. | 12 |
| `ia/skills` | `ia_skills` | Instruções (skills) da empresa. | 12 |

### Colunas excluídas por tabela (além do padrão de segredos)

| Tabela | Coluna | Motivo |
|---|---|---|
| `aceites_documentos_legais` | `ip` | dado de segurança da sessão |
| `aceites_documentos_legais` | `user_agent` | dado de segurança da sessão |
| `usuarios_administrativos` | tudo fora de `id`, `nome`, `email`, `cargo`, `ativo`, `criado_em` | tabela compartilhada pela plataforma (senha, papel global) |
| `convites_acesso` | `token_hash` | credencial ou segredo técnico |
| `validacoes_identidade_cliente` | `codigo_hash` | credencial ou segredo técnico |
| `validacoes_identidade_cliente` | `token_prova_hash` | credencial ou segredo técnico |
| `pagamento_eventos` | `ip` | dado de segurança da sessão |
| `pagamento_eventos` | `user_agent` | dado de segurança da sessão |
| `pagamento_eventos` | `sessao_id` | dado de segurança da sessão |
| `convites` | `publico_token` | credencial ou segredo técnico |
| `convites` | `editor_hash` | credencial ou segredo técnico |
| `convite_familias` | `token_hash` | credencial ou segredo técnico |
| `convite_respostas` | `chave` | identificador do convidado no link público (permite alterar a resposta) |
| `marketing_dominios` | `token_verificacao` | credencial ou segredo técnico |
| `marketing_automacao_execucoes` | `posse_token` | trava interna do processamento |
| `whatsapp_conexoes` | `credencial_cifrada` | credencial ou segredo técnico |
| `whatsapp_conexoes` | `credencial_iv` | credencial ou segredo técnico |
| `whatsapp_conexoes` | `credencial_tag` | credencial ou segredo técnico |
| `whatsapp_conexoes` | `credencial_chave_versao` | credencial ou segredo técnico |
| `whatsapp_atendimento_arquivos` | `token` | link de acesso ao arquivo |

### Tabelas fora do pacote

| Tabela | Motivo |
|---|---|
| `auditoria` | Auditoria geral da plataforma (segurança e prova de operações, com IP); atendida por pedido específico. |
| `sessoes_administrativas` | Sessões de login: credenciais (hashes de token) e dados de segurança. |
| `recuperacoes_senha` | Recuperação de senha: credenciais. |
| `limites_autenticacao` | Limites de tentativa de login: segurança da plataforma. |
| `cadastros_publicos` | Cadastro público em andamento: contém hash de senha e de token. |
| `plataforma_desenvolvedores` | Acesso de desenvolvedores da plataforma. |
| `plataforma_interessadas` | Registro interno da plataforma sobre interessadas. |
| `plataforma_empresas_cadastro` | Registro interno da plataforma (inclui observações internas); os dados cadastrais da empresa saem em empresa/perfil_empresa e empresa/cadastro. |
| `festa_usuario_capacidades` | Capacidades por pessoa, sem empresa (não são dados de uma empresa). |
| `cobranca_eventos` | Eventos brutos do provedor de cobrança (Asaas). |
| `assinatura_fundadores` | Controle interno de vagas do plano Fundador. |
| `assinatura_isencoes` | Concessões internas da plataforma. |
| `empresa_excecoes_comerciais` | Decisões comerciais internas da plataforma. |
| `ia_operacoes` | Telemetria das operações de IA. |
| `ia_orcamento_reservas` | Reservas de orçamento de IA (telemetria de custo). |
| `ia_uso_modelo` | Uso de modelos de IA (telemetria de custo). |
| `convite_carteiras` | Créditos de geração de convites (controle de consumo da plataforma). |
| `convite_consumos` | Consumo de créditos de convites (controle da plataforma). |
| `convite_limites_http` | Limites de requisição dos links públicos: segurança. |
| `convite_orcamento_global` | Orçamento global de IA dos convites (todas as empresas). |
| `documentos_publicos` | Textos legais publicados (iguais para todas as empresas). |
| `adicional_categorias` | Categorias de referência globais (iguais para todas as empresas). |
| `marketing_dns_simulado` | Simulação técnica local de DNS. |
| `marketing_transporte_simulado` | Simulação técnica local de envio. |
| `whatsapp_atendimento_status` | Recibos técnicos de entrega do provedor. |
| `whatsapp_atendimento_eventos_excluidos` | Lista técnica de eventos já excluídos (impede reprocessamento). |
| `whatsapp_atendimento_retencao_execucoes` | Execuções da rotina de retenção (todas as empresas). |
| `whatsapp_onboarding_tentativas` | Tentativas técnicas de conexão com a Meta. |
| `agenda_062_bloqueios_resolucao` | Tabela técnica da migração da agenda (062). |
| `agenda_062_fechamentos_resolucao` | Tabela técnica da migração da agenda (062). |
| `agenda_062_unidades_habilitacao` | Tabela técnica da migração da agenda (062). |

## Testes e validações (21/10/2026)

- **Unitários** (`lib/exportacao/exportacao.test.ts`, 6 testes; `lib/assinatura/exportacao.test.ts` atualizado):
  - CRC-32 de referência; ZIP ida e volta, adulteração e caminhos inválidos;
  - neutralização de fórmula por tipo;
  - invariantes do inventário: filtro por `$1`, aliases, nada dentro e fora ao mesmo tempo;
  - colunas de segredo; bytea;
  - gerador com banco falso: só `SELECT`, manifesto = ZIP = SHA256SUMS, ausentes declaradas, limites de linhas, bytes e tempo;
  - estáticos: a guarda da suspensa só nas rotas de exportação; auditoria sem IP; uma única escrita (a auditoria).
- **PostgreSQL descartável** (`lib/exportacao/exportacao.postgres.test.ts`, modelo 088, porta 55621): 3/3.
  - Completude do schema e retrato das colunas.
  - Fluxo real das três fases com transações de verdade; escrita recusada na fase de leitura.
  - Duas empresas com fixture completo (contrato assinado com PDF, festa, pagamento e parcelas, convite com família e resposta, contas a pagar, bloqueio, contato de Marketing, conversa WhatsApp):
    - hashes e linhas conferem;
    - 19 contagens independentes (JOINs escritos à parte) batem com o manifesto;
    - PDFs idênticos aos do banco;
    - nenhuma marca, id ou segredo da outra empresa;
    - ids disjuntos;
    - fórmula neutralizada;
    - auditoria só com contagens e hashes.
  - Guarda:
    - Equipe, outra empresa, id inválido, sessão em outra empresa e sessão revogada pela suspensão são recusados;
    - vínculo suspenso no meio e empresa suspensa no meio: nada entregue, nada auditado;
    - suspensa exportável só pela Gestão e só com `empresaId`;
    - `provarTenant` continua recusando a suspensa;
    - desativada recusada.
- **Playwright** (`scripts/exportacao-ui.cjs`, Chrome, `next dev` com o banco descartável), 3 roteiros:
  - Gestão em `/admin/assinatura`: o ZIP baixado confere, e o código mostrado na tela = SHA-256 do MANIFESTO = auditoria;
  - CSV avulso continua; celular de 390 px sem rolagem horizontal;
  - Equipe recebe 403;
  - Gestão de empresa suspensa baixa pela tela "Sem empresa ativa", e sem `empresaId` recebe 403.
- **Geral:** `npx tsc --noEmit` sem erros; ESLint sem erros nos arquivos alterados; `npm run check:v1:static` PASS, com testes, lint (1 aviso preexistente em `lib/inteligencia/skills/catalogo.ts`), TypeScript e build.

**Como repetir:**
1. Crie um cluster descartável (derivado de `scripts/pg-descartavel-061.cjs`, porta livre).
2. Defina `KIDMAIS_POSTGRES_SOMENTE=lib/exportacao/exportacao.postgres.test.ts` e rode o executor do cluster.
3. Para a interface: defina `KIDMAIS_PLAYWRIGHT_MODULE` e os três `KIDMAIS_*` do descartável e rode `node --experimental-strip-types scripts/exportacao-ui.cjs`.

## O que falta

- **Revisão independente** e homologação em staging. Não há migration; o deploy é só de código.
- **Arquivos binários além dos PDFs de contrato**, que saem só com tamanho e SHA-256:
  - imagens de convite e de site;
  - mídias e arquivos do WhatsApp;
  - documentos enviados para leitura por IA;
  - planilhas de importação comercial;
  - comprovantes de devolução.
  - Se a Astra ou Felipe exigirem esses arquivos no pacote, incluir como `arquivos/<tipo>/` com o mesmo mecanismo, cuidando do limite de tamanho.
- **Auditoria geral** (`auditoria`): fica fora por ser registro de segurança da plataforma, com IP. Pedido do titular ou da empresa sobre esse registro segue o procedimento de direitos (item 5 do plano).
- **Exclusão programada** após a suspensão (item 2 do plano): a tela de aviso deve apontar para esta exportação.
- **Decisão sobre suspensão por segurança** (seção acima).
- **Streaming e limites:** se surgir empresa acima dos limites, entrega por outro meio ou montagem em disco temporário com streaming.
- **Textos legais:** os Termos e o Aviso podem citar o formato (ZIP com CSV, PDFs dos contratos e manifesto com SHA-256) e a disponibilidade na suspensão, depois da publicação deste código.
