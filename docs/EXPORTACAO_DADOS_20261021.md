# Exportação verificável dos dados da empresa (21/10/2026)

**Estado: LOCAL, rodada 2.** Implementado e validado só neste clone (`codex/exportacao-verificavel-20261021`, base staging `2139966`). Sem push, PR, deploy, env ou banco remoto. PostgreSQL só em cluster descartável local. Nenhuma migration nova.

Atende o item 1 de `pacote-revisao-juridica-astra-20261020/v2/PLANO-PROCEDIMENTOS.md`, a lacuna L2 e o ajuste 6 do parecer da Astra de 21/10/2026. Pontos do parecer cobertos: informar formatos e abrangência, permitir exportação durante a suspensão e não bloquear a exportação para forçar aceite.

**Rodada 2:** corrige os achados da revisão independente (`revisao-exportacao-20261021/PARECER.md`: staging APROVADO COM RESSALVAS, produção REPROVADO por P2-1, P2-2 e P2-3). O resumo por achado está em [Rodada 2](#rodada-2-correções-da-revisão-independente).

## O que a Gestão vê

- **Admin → Assinatura → Exportar dados.** O botão **Baixar pacote completo (ZIP)** gera e baixa o pacote. A tela mostra o nome do arquivo e o **código de conferência**, que é o SHA-256 do `MANIFESTO.json`.
  - Os links **Clientes (CSV)** e **Contas a receber (CSV)** continuam como antes.
  - A seção aparece só para a Gestão e em qualquer situação da assinatura: teste, somente leitura ou bloqueio comercial. O paywall sempre permite `/api/admin/exportacao`.
- **Empresa suspensa pelo painel do desenvolvedor.** A Gestão vê **Exportar dados de empresa suspensa**, com o mesmo botão, em três lugares:
  - na tela Assinatura, mesmo trabalhando numa empresa ativa e sem trocar de empresa;
  - na tela "Sem empresa ativa";
  - na tela de escolha de empresa.
  - A suspensão continua encerrando as sessões que estavam na empresa suspensa.

## API

`POST /api/admin/exportacao` com corpo `{"tipo":"completa","empresaId":"<uuid opcional>"}`.

- **Proteção:** a mesma do Admin para escrita (origem + `x-csrf-token`, em `exigirApiAdminCrmDisponivel`). Um site de terceiros não consegue disparar a geração.
- **200:** `application/zip` em fluxo, com:
  - `Content-Length`;
  - `Content-Disposition: attachment; filename="kidmais-exportacao-<codigo>-<AAAAMMDDTHHMMSSZ>.zip"`;
  - `Cache-Control: no-store`;
  - `X-Kidmais-Exportacao-Formato: 1`, `X-Kidmais-Manifesto-Sha256` e `X-Kidmais-Pacote-Sha256`.
- **Recusas:**

| Status e código | Quando |
|---|---|
| `403 TENANT_NAO_COMPROVADO` | sem vínculo, outra empresa, empresa desativada, sessão inválida |
| `403 PAPEL_NAO_AUTORIZADO` | Equipe |
| `413 EXPORTACAO_GRANDE_DEMAIS` | acima dos limites do pacote |
| `429 EXPORTACAO_OCUPADA` | já há uma exportação montando neste processo |
| `429 EXPORTACAO_LIMITE` | limite por hora atingido |
| `503 EXPORTACAO_DEMORADA` | passou do tempo |
| `503 EXPORTACAO_INVENTARIO_DESATUALIZADO` | tabela pública sem classificação |
| `507 EXPORTACAO_SEM_ESPACO` | falta disco temporário |
| `405 METODO_NAO_PERMITIDO` | `GET ?tipo=completa` |

- **CSVs avulsos:** `GET /api/admin/exportacao?tipo=clientes|contas-receber[&empresaId=]` continuam por GET e pela mesma guarda. Valem duas regras a mais:
  - a sessão tem de estar na própria empresa;
  - navegação vinda de outro site (`Sec-Fetch-Site: cross-site` ou `same-site`) recebe `403 ORIGEM_RECUSADA`.
- **Lista de suspensas:** `GET /api/admin/exportacao/empresas-suspensas` devolve `{ id, nome }` das empresas SUSPENSAS em que a pessoa é Gestão com vínculo ativo. A rota não concede nada.

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
- **Fórmulas:** texto livre recebe um apóstrofo na frente quando começa com:
  - `=`, `+`, `-` ou `@`, também depois de espaços ou tabulações iniciais;
  - as formas de largura total `＝＋－＠`;
  - tabulação ou CR.
  - O valor original é o texto sem o apóstrofo. Números, datas, uuid e booleanos não mudam, então um valor negativo continua número.
- **Binários (`bytea`):** viram `<coluna>__bytes` e `<coluna>__sha256`. Só o PDF dos contratos (`contrato_documentos.conteudo_pdf`) também vai como arquivo, indicado em `conteudo_pdf__arquivo`. O pacote confere que o SHA-256 do arquivo é o mesmo calculado pelo banco.
- **Consistência:** a leitura é uma única transação `REPEATABLE READ READ ONLY`, então todos os arquivos refletem o mesmo instante (`geradoEm`).
- **Ambientes diferentes:**
  - as colunas são lidas do schema no momento;
  - tabela do inventário ainda não criada no ambiente vira entrada em `entidadesAusentes`;
  - tabela pública que **não está no inventário** recusa a geração (ver Inventário).
- **Ordem das linhas:** chave primária, para o mesmo banco gerar o mesmo CSV.

## Como conferir os hashes

1. **Na tela:** guarde o código de conferência mostrado. Ele também fica na auditoria da plataforma (`EXPORTACAO_DADOS`, campo `manifestoSha256`). Se o `MANIFESTO.json` confere, todos os hashes listados nele valem.
2. **Linux ou macOS**, na pasta extraída: `sha256sum -c SHA256SUMS.txt` (ou `shasum -a 256 -c SHA256SUMS.txt`). Todas as linhas devem dar `OK`.
3. **Windows (PowerShell):** `Get-FileHash -Algorithm SHA256 .\MANIFESTO.json` e compare com o código da tela. O PowerShell mostra em maiúsculas; o valor é o mesmo. Faça o mesmo para qualquer arquivo de `dados/` contra o `MANIFESTO.json`.
4. **Linhas:** o número de linhas de cada CSV, sem o cabeçalho, é o campo `linhas` do arquivo no MANIFESTO.

A auditoria `SUCESSO` prova que o pacote foi gerado e entregue ao servidor web. Ela não prova que o navegador terminou o download (P3-7). Se o download falhar, gere de novo; o limite por hora comporta isso.

## Isolamento, autorização e auditoria

- **Isolamento:** cada entidade é uma tabela filtrada só pela empresa comprovada (`$1`), de um de dois jeitos:
  - direto por `empresa_id`;
  - pela cadeia de posse até uma tabela que tem `empresa_id`: cliente; fechamento → contrato → versão → pagamento/plano/parcela; contrato → festa; convite; tabela de preço; pacote.
  - Os aliases das subconsultas são sempre qualificados, e um teste estático confere.
  - A suíte PostgreSQL confere no catálogo que cada filtro segue uma FK real (direta, composta ou por tabela intermediária).
  - O perfil cadastral usa a mesma associação perfil ↔ empresa de `lib/perfil/autorizacao.ts`.
- **Autorização:** só a Gestão (`REPRESENTANTE_AUTORIZADO`), com o papel do vínculo nesta empresa. Equipe recebe 403.
- **Três transações curtas** (`lib/exportacao/servico.ts`):
  1. prova do tenant e limite de uso;
  2. leitura em fotografia, gravada em arquivos temporários; o ZIP é montado em arquivo depois do commit da leitura;
  3. nova prova com a mesma empresa, o mesmo vínculo e a mesma situação, seguida de auditoria e revalidação antes do commit.
  - O ZIP só começa a sair depois da fase 3. Vínculo suspenso, papel trocado, empresa suspensa ou desativada no meio: nada é entregue e nada é auditado.
- **Auditoria do sucesso:** uma linha `EXPORTACAO_DADOS` (`entidade_tipo = EMPRESA`, `origem = EXPORTACAO`) com usuário, empresa e `requestId`. Nos dados ficam só contagens e hashes: tipo, formato, `geradoEm`, arquivos, linhas, bytes, PDFs, entidades ausentes, `manifestoSha256`, `zipSha256`, `empresaSuspensa` e resultado. Não ficam conteúdo, IP nem navegador.
- **Auditoria das recusas da guarda (P3-5):** uma linha `EXPORTACAO_RECUSADA` para Equipe, empresa alheia ou sessão inválida, com:
  - usuário;
  - a empresa pedida, se era um UUID; senão, o próprio usuário;
  - `dados_depois = { tipo, codigo, empresaInformada }`.
  - O texto pedido, IP e navegador não entram.
- **Limite de uso (P3-2):** até 6 pacotes completos por empresa e 12 por pessoa na última hora. A contagem sai da própria auditoria, então vale entre reinícios e instâncias.

## Decisão: exportação de empresa suspensa (exceção mínima)

- **Problema:** `provarTenant` (`lib/saas/provar-tenant.ts:76`) só aceita empresa `ATIVA`, então a suspensão administrativa prendia os dados. A suspensão comercial (bloqueio por vencimento) já não prendia: o paywall libera a rota.
- **Solução:** guarda própria, só da exportação (`lib/exportacao/guarda.ts`):
  - **Empresa ATIVA:** exatamente `provarTenant` + Gestão. Nada muda.
  - **Empresa SUSPENSA:** aceita somente quando, na mesma transação e na ordem de travas usuário → empresa → vínculo:
    - a empresa foi pedida explicitamente por `empresaId`;
    - o status é `SUSPENSA`, nunca `DESATIVADA` nem `PROVISIONAMENTO`;
    - a pessoa está ativa;
    - a sessão continua válida (revogada, expirada ou com contexto mudado é recusada);
    - o vínculo dessa empresa está `ATIVA` com papel Gestão.
  - **Sessão em outra empresa:** é aceita **só no POST do pacote completo** (P3-4). A sessão continua na empresa ativa, sem mudança de contexto. Uma empresa ATIVA continua exigindo a seleção. Os CSVs por GET seguem a regra estrita.
  - A revalidação antes do commit exige o mesmo estado.
- **Alcance:** só as rotas `/api/admin/exportacao` usam a guarda; um teste estático confere. `provarTenant` continua recusando a suspensa em todo o resto, e o teste PostgreSQL confere.
- **Por que é seguro o bastante:**
  - é somente leitura, mais a auditoria;
  - vale só para a Gestão, que já é a responsável pelos dados;
  - o evento fica marcado com `empresaSuspensa: true`.

### Suspensão por segurança (P2-2) — procedimento até a decisão de Felipe

A exceção não distingue o motivo da suspensão: o motivo é texto livre, e nenhuma marca nova foi criada nesta rodada, por decisão pendente. Quando a suspensão for **por segurança** (conta comprometida, acesso indevido), suspender a empresa não basta para fechar a exportação. O procedimento fecha:

1. **Painel do desenvolvedor → ficha da empresa → Usuários e vínculos:** suspender ou revogar o vínculo de **cada Gestão afetada**. Vínculo diferente de `ATIVA` é recusado pela guarda, como os testes provam.
2. **Fechar o acesso da pessoa** em pelo menos uma de duas formas:
   - desativar o usuário (`ativo = false` é recusado);
   - trocar a senha pela recuperação. A troca encerra as sessões e quem tinha a senha antiga não entra.
3. **Suspender a empresa** (opcional, para fechar o resto do sistema), com o motivo registrado.
4. **Conferir na auditoria:** depois do passo 1 não deve haver `EXPORTACAO_DADOS` da empresa; tentativas aparecem como `EXPORTACAO_RECUSADA`.
5. **Ao reabrir:** reativar o vínculo só depois de confirmar a identidade da Gestão.

**Decisão aberta de Felipe:** manter esse procedimento manual ou criar a marca "suspensão por segurança" por migration (próximo número livre; a 089 já é da devolução).

### Linhas sem empresa em produção (P2-5) — contagem preparada, não executada

- **O problema:** 12 tabelas do pacote aceitam `empresa_id` nulo: `aceites_documentos_legais`, `adicionais`, `bloqueios_agenda`, `buffet_categorias`, `buffet_itens`, `clientes`, `configuracao_agenda`, `fechamentos`, `pacotes`, `solicitacoes_acesso_empresa`, `tabelas_preco` e `whatsapp_conexoes`.
  - Linhas legadas sem empresa não saem no pacote de ninguém.
  - O modelo 088 já semeia 2 `configuracao_agenda` globais.
- **O bloco:** `scripts/bloco-shell-exportacao-producao.mjs` gera o bloco **SOMENTE LEITURA** para o Web Shell de produção. Ele:
  - tem guarda de `RENDER_SERVICE_ID` (`srv-dak77m2d0e5s73b8rkkg`);
  - roda em transação `READ ONLY` conferida por `SHOW transaction_read_only`, com prazo de 20 s e `ROLLBACK` no fim;
  - conta `empresa_id IS NULL` nas tabelas diretas que aceitam nulo;
  - lista tabelas públicas sem classificação, para conferir o P2-3 antes do deploy;
  - só imprime contagens e nomes de tabela; nunca imprime a `DATABASE_URL`.
- **Gerar:** `node --experimental-strip-types scripts/bloco-shell-exportacao-producao.mjs <saída>`.
- **Testes:** o bloco foi testado contra o banco descartável (modelo 088: 12 tabelas, 2 nulas em `configuracao_agenda`, 174 tabelas, nenhuma sem classificação) e pela guarda (outro serviço: `SHELL_ERRADO_NAO_E_PRODUCAO`).
- **Execução em produção:** **não executado**. Depende de autorização explícita de Felipe.
- **Se houver linhas da empresa original:** backfill por migration autorizada ou nota no pacote.

## Limites, memória e disco

| Limite | Valor | Comportamento |
|---|---|---|
| Linhas por arquivo | 200 000 | acima disso, 413, sem pacote parcial |
| Tamanho total (CSV + PDFs, sem compressão) | 150 MB | 413; a mensagem orienta a falar com o suporte |
| Tempo total de leitura | 120 s | 503 |
| Tempo por comando SQL | 60 s (`statement_timeout`) | 503 |
| Exportações simultâneas por processo | **1** | 429; tentar de novo em um minuto |
| Pacotes completos por hora | 6 por empresa, 12 por pessoa | 429 |
| Disco temporário | folga de 32 MB além do que ainda falta gravar | 507, sem pacote parcial |
| Entradas no ZIP | 65 535 | 413 (antes era erro 500 genérico, P3-6) |

**Fluxo (P2-1):**

1. **Leitura:** cada tabela é lida por cursor (`DECLARE … NO SCROLL CURSOR` / `FETCH 100`) para um CSV temporário. O buffer de escrita é reutilizado, e SHA-256 e CRC-32 são calculados durante a gravação. Os PDFs vêm um por vez.
2. **Montagem:** o ZIP é montado em arquivo, lendo dos temporários com um bloco de 256 KB reutilizado. O deflate é alimentado só depois que o zlib consome o bloco. Os temporários de dados são apagados em seguida.
3. **Envio:** a rota envia o ZIP com `fs.createReadStream` → `Readable.toWeb`, sem a cópia `new Uint8Array`.
4. **Limpeza:** a pasta é apagada quando o envio termina, falha ou é abandonado. Há ainda uma rede de segurança de 10 minutos e a remoção, a cada exportação, de sobras com mais de 1 hora (processo reiniciado).

**Disco:** sempre em `os.tmpdir()`, em pasta própria (`kidmais-exportacao-*`, permissão 600). O código recusa o disco persistente `/opt/render/project/src/data`. O espaço livre é conferido antes, a cada 16 MB e antes do ZIP.

**Memória medida** (mesmo roteiro do revisor: `gerarPacote` real com mensagens de WhatsApp de 1 KB no banco descartável, mais o envio do ZIP por fluxo):

| Pacote (dados sem compressão) | Antes (em memória) | Depois (em fluxo) |
|---|---|---|
| 42 MB (100 000 × 220 B) | pico 520 MB (+443 MB) | pico 215 MB (**+133 MB**) |
| 37 MB (30 000 × 1 KB) | — | pico 159 MB (**+81 MB**) |
| 73 MB (60 000 × 1 KB) | — | pico 217 MB (**+133 MB**) |
| 147 MB (120 000 × 1 KB) | pico **1 019 MB (+946 MB)**; revisor: 1 142 MB | pico **219 MB (+143 MB)** |

- **Leitura da medição:** a memória fica limitada e não cresce com o tamanho do pacote (≈ +140 MB de patamar, sobretudo lixo ainda não coletado do driver e do heap). Antes, crescia com o pacote. "+" é o pico amostrado menos o RSS logo antes da exportação; o pico é o maxRSS do processo.
- **Instância de 512 MB:** um pacote de 147 MB deixa a instância em torno de 220 MB de RSS. Relatórios em `ambientes-locais/memoria-exportacao-20261021/`.
- **Lacuna:** não medi PDFs grandes (o fixture de contrato não passa pelas validações adiadas no COMMIT). Cada PDF vem sozinho, então o custo é o maior PDF + o lote.

## Inventário (schema até a 089: 175 tabelas = 144 no pacote + 31 fora)

Até a 088 eram 174 = 143 + 31; a integração com a devolução (22/10/2026) acrescentou `assinatura_encerramentos` ao pacote.

Três travas impedem que uma tabela nova fique fora em silêncio (P2-3):

- **Teste estático** (`lib/exportacao/exportacao.test.ts`), independente de modelo de banco:
  - compara todos os `CREATE TABLE` de `database/migrations`, menos `DROP`/`RENAME` posteriores e os `*_down.sql`, com o inventário;
  - falha com tabela sem classificação ou com classificação órfã.
  - A 089 da devolução (`assinatura_encerramentos`) já está classificada (integração de 22/10/2026).
- **Em execução:** a geração lista as tabelas públicas do banco e **recusa com 503** (`EXPORTACAO_INVENTARIO_DESATUALIZADO`) se alguma não estiver classificada. Os nomes vão para o log do servidor.
  - **Por que recusar, e não listar no manifesto:** um pacote chamado "completo" não pode omitir dados em silêncio. O 503 é visível, auditável e corrigível por código.
  - **Consequência operacional:** migration com tabela nova só pode ir para produção junto com o código que a classifica.
- **Retrato das colunas:** as colunas exportadas de cada tabela ficam fixadas em `lib/exportacao/colunas-esperadas.json`. A suíte PostgreSQL falha quando uma migration muda essas colunas. Revisar se há segredo e atualizar com `KIDMAIS_EXPORTACAO_ATUALIZAR_RETRATO=1`.

**Nunca saem:**
- por lista declarada:
  - senhas e hashes de senha;
  - códigos dos links públicos (`publico_token`, `token_hash` das famílias, `editor_hash`);
  - códigos e provas de OTP;
  - credenciais cifradas do WhatsApp e `token` dos arquivos;
  - código de verificação de domínio e travas internas;
  - id interno da sessão em `contrato_assinaturas` e `pagamento_eventos` (P3-1).
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
| `contratos/contrato_assinaturas` | `contrato_assinaturas` | Assinaturas e aceites (evidência: método, data, IP e navegador). | 19 |
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
| `contrato_assinaturas` | `sessao_id` | identificador interno da sessão (não é prova do aceite) |
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

## Rodada 2: correções da revisão independente

Parecer: `D:/glass/KidMais Manager/revisao-exportacao-20261021/PARECER.md` (staging APROVADO COM RESSALVAS; produção REPROVADO até P2-1, P2-3 e P2-4).

| Achado | O que mudou | Prova |
|---|---|---|
| **P2-1** memória | Leitura por cursor em lotes de 100 para CSV temporário (buffer reutilizado; SHA-256/CRC-32 incrementais); PDFs um por vez; ZIP montado em arquivo; envio por fluxo só depois da revalidação; `limpar()` em fim, erro, abandono e prazo; sobras antigas removidas; espaço livre conferido (507); 1 exportação por processo; sem `new Uint8Array` | Pico de 1 019 MB → **219 MB** (147 MB de dados; +143 MB), patamar estável de 37 a 147 MB; unitários de lotes, temporários e vaga; PG: pasta apagada depois de cada pacote |
| **P2-2** suspensão por segurança | Sem marca nova (decisão de Felipe). Procedimento documentado acima: suspender o vínculo e desativar o usuário ou trocar a senha fecha a exportação | Guarda recusa vínculo suspenso e usuário inativo (PG) |
| **P2-3** inventário | Teste estático `CREATE TABLE` das migrations × inventário; em execução, tabela pública sem classificação → 503 | Unitário (inclusive leitor de CREATE/DROP/RENAME); PG cria tabela nova → 503 sem pacote, temporário ou auditoria |
| **P2-4** cobertura | Suíte `exportacao-adversarial.postgres.test.ts` com os 3 cenários do revisor (3 empresas e conferência por UUID e FK, guarda adversarial, fotografia RR com escrita concorrente) + FK no catálogo para todos os filtros; fixture comum com `marketing_tarefas` e `convites_acesso` | Mutações abaixo |
| **P2-5** empresa nula em produção | Bloco de Shell SOMENTE LEITURA gerado por `scripts/bloco-shell-exportacao-producao.mjs` (não executado) | Testado no descartável e na guarda; unitário confere leitura, guarda e inventário embutido |
| **P3-1** | `contrato_assinaturas.sessao_id` fora | Retrato atualizado (só essa coluna saiu) |
| **P3-2** | Geração por POST com CSRF; GET do pacote = 405; CSV por GET recusa `Sec-Fetch-Site` de outro site; limite 6/empresa e 12/pessoa por hora | Playwright (405, 403 sem CSRF, 403 cross-site); PG do limite |
| **P3-3** | Neutralização após espaços/tabulações e em largura total | Unitário |
| **P3-4** | Gestão na empresa ativa vê e baixa a suspensa na tela Assinatura, sem trocar de empresa (só no POST) | PG (sessão continua na ativa; empresa ATIVA continua exigindo seleção) e Playwright |
| **P3-5** | Recusas da guarda auditadas (`EXPORTACAO_RECUSADA`, só ids e código) | PG |
| **P3-6** | Mais de 65 535 entradas → 413 com mensagem, não 500 | Código (`MAXIMO_ENTRADAS_ZIP`) |
| **P3-7** | Documentado: auditoria não prova que o navegador terminou o download | — |
| **P3-8** | Fallback de perfil herdado mantido; o cenário adversarial do revisor (perfil órfão não vaza) está na suíte | PG |

### Mutações (roteiro do revisor adaptado, M1–M8 + M9–M17 novas)

Cada mutação foi aplicada e restaurada no clone; rodaram os unitários e as duas suítes PG. Uma mutação “morre” quando alguma das três falha. **22/22 mortas** (a rodada 1 tinha 5 sobreviventes à suíte do autor: M1b, M1d, M4, M7, M8).

| Mutação | Unitários | PG autor | PG adversarial |
|---|---|---|---|
| M1-filtro-cadeia-aniversariantes | passa | **falha** | **falha** |
| M1b-filtro-marketing_tarefas | passa | **falha** | **falha** |
| M1c-filtro-whatsapp_conversas | passa | **falha** | **falha** |
| M1d-filtro-convites_acesso | passa | **falha** | **falha** |
| M2-exclusao-ip-aceites | passa | **falha** | **falha** |
| M2b-exclusao-chave-convite_respostas | passa | **falha** | passa |
| M2c-lista-permissao-usuarios | **falha** | **falha** | passa |
| M2d-exclusao-publico_token-sem-padrao | **falha** | **falha** | passa |
| M3-libera-DESATIVADA | **falha** | **falha** | **falha** |
| M4-sem-checagem-sessao-noutra-empresa | **falha** | **falha** | **falha** |
| M6-vinculo-qualquer-status | passa | **falha** | passa |
| M7-sem-reprova-na-fase-C | passa | passa | **falha** |
| M8-leitura-sem-fotografia | **falha** | passa | **falha** |
| M9-sem-recusa-de-tabela-nao-classificada | **falha** | passa | **falha** |
| M10-duas-exportacoes-simultaneas | **falha** | passa | passa |
| M11-sem-limpeza-em-erro | passa | **falha** | **falha** |
| M12-sessao_id-de-contrato_assinaturas-exportado | **falha** | **falha** | passa |
| M13-formula-so-no-inicio | **falha** | passa | passa |
| M14-recusa-nao-auditada | passa | passa | **falha** |
| M15-sem-limite-de-uso | passa | passa | **falha** |
| M16-pacote-por-GET | **falha** | passa | passa |
| M17-excecao-aceita-empresa-ATIVA-de-outra-selecao | passa | passa | **falha** |

Logs: `ambientes-locais/mutacoes-exportacao-r2/logs/`. Na M10, o teste da vaga ficava esperando sem prazo; ele ganhou um timeout de 10 s.

## Testes e validações

**Unitários:** `lib/exportacao/exportacao.test.ts` (11 testes) e `lib/assinatura/exportacao.test.ts` (2), 13/13. Cobrem:
- ZIP em arquivo: CRC incremental, adulteração e tamanho divergente;
- fórmulas;
- inventário: invariantes e confronto com as migrations;
- colunas;
- pacote em fluxo com banco falso que fala cursor: lotes, cursores fechados, só leitura, só o ZIP sobra;
- recusas sem temporário: limites, inventário, disco;
- sobras antigas e vaga única;
- estáticos: POST/CSRF, fluxo sem cópia, auditoria sem IP, temporário fora do disco persistente;
- bloco de Shell.

**PostgreSQL descartável** (modelo 088, porta 55621), 2 suítes, **9/9**:
- `exportacao.postgres.test.ts` (3): completude e retrato; pacote de 2 empresas com contagens independentes, PDFs, isolamento, segredos, auditoria e limites; guarda.
- `exportacao-adversarial.postgres.test.ts` (6): 3 empresas; guarda adversarial e P3-4; fotografia RR; FK no catálogo; inventário em execução; limite de uso e recusas auditadas.

**Playwright** (`scripts/exportacao-ui.cjs`, Chrome, `next dev` + descartável), 3/3:
- Gestão na ativa: ZIP por POST e código = manifesto = auditoria;
- GET do pacote 405, POST sem CSRF 403 e CSV de outro site 403;
- a mesma Gestão baixa a suspensa na Assinatura sem trocar de empresa;
- celular sem rolagem;
- Equipe recebe 403;
- Gestão só da suspensa baixa pela tela "Sem empresa ativa".

**Verificações gerais:**
- `npx tsc --noEmit` sem erros;
- ESLint sem erros nos arquivos alterados;
- `npm run check:v1:static` PASS (testes, lint com o aviso preexistente em `lib/inteligencia/skills/catalogo.ts`, TypeScript e build).

**Como repetir:**
1. Crie um cluster descartável (derivado de `scripts/pg-descartavel-061.cjs`, porta livre).
2. Rode as suítes PG com `KIDMAIS_POSTGRES_SOMENTE=lib/exportacao/exportacao.postgres.test.ts,lib/exportacao/exportacao-adversarial.postgres.test.ts`.
3. Rode a interface com `node --experimental-strip-types scripts/exportacao-ui.cjs`, definindo `KIDMAIS_PLAYWRIGHT_MODULE` e os três `KIDMAIS_*`.
4. Meça a memória com `ambientes-locais/memoria-exportacao-20261021/memoria-depois.mts <linhas> <bytes>`.
5. Rode as mutações com `ambientes-locais/mutacoes-exportacao-r2/mutacoes-r2.cjs`.

## Integração com a 089 (devolução) e migrations futuras

A 089 cria `assinatura_encerramentos`. **Integrada em 22/10/2026** na branch `codex/devolucao-cancelamento-20261021`
(merge da staging `3bb7b4b`), conforme o passo (7) da revisão da exportação:
1. entidade `empresa/assinatura_encerramentos` em `ENTIDADES` (grupo Empresa, depois de `assinatura_renovacoes`,
   `onde: EMP`);
2. excluídas só duas colunas: `chave_idempotencia` (identificador técnico de repetição da tela) e
   `aviso_interno_situacao` (controle interno da plataforma: se a equipe Kidmais foi avisada; não é dado do pedido).
   Protocolo, valores, prazos, situação do cancelamento e do estorno, ids do provedor (da própria empresa) e a situação
   do e-mail de confirmação saem;
3. modelo `"089"` na receita; as duas suítes PG e `scripts/exportacao-ui.cjs` passaram para ele;
4. retrato regenerado com `KIDMAIS_EXPORTACAO_ATUALIZAR_RETRATO=1` (diff só com a chave `assinatura_encerramentos`);
5. inventário: 175 = 144 + 31.

**Ordem de publicação em cada ambiente:** código integrado primeiro (sem a 089, a tabela fica em `entidadesAusentes` e
a devolução mantém o fluxo antigo); depois a 089 com autorização própria. Se a 089 fosse aplicada antes, com o código
antigo no ar a exportação completa responderia 503 até o deploy. Em qualquer ordem, rodar o bloco P2-5 como
pós-conferência (`NAO_CLASSIFICADAS NENHUMA`).

## O que falta

- **Revisão do delta** desta rodada. Depois: PR, deploy em staging e homologação. Não há migration.
- **Decisões de Felipe:**
  - P2-2: procedimento manual ou marca "suspensão por segurança";
  - P2-5: autorizar a execução do bloco somente leitura em produção e decidir o tratamento das linhas sem empresa, se houver.
- **Arquivos binários além dos PDFs**, que saem só com tamanho e SHA-256:
  - imagens de convite e de site;
  - mídias e arquivos do WhatsApp;
  - documentos de IA;
  - planilhas de importação;
  - comprovantes de devolução.
  - Se a Astra ou Felipe exigirem, entram como `arquivos/<tipo>/` pelo mesmo fluxo, dentro do limite.
- **Medição de memória com PDFs grandes:** cada PDF é lido sozinho.
- **Auditoria geral** (`auditoria`): fora do pacote; pedido do titular ou da empresa segue o procedimento de direitos (item 5 do plano).
- **Exclusão programada** (item 2 do plano): o aviso de 30 dias deve apontar para esta exportação.
- **Textos legais:** os Termos e o Aviso podem citar o formato e a disponibilidade na suspensão depois da publicação.

## Atualização local de capacidade — 22/10/2026

A pendência acima de carregar cada PDF inteiro foi tratada localmente com blocos de 1 MiB. Ensaio com Next em produção e 5/10/20/40 sessões: sem erros, pico máximo 377 MiB. Não houve limite rígido de 512 MiB nem reprodução da CPU do Render; logins e duas exportações concorrentes continuam pendentes. Detalhes, metodologia e validações em [Exportação e capacidade](EXPORTACAO_CAPACIDADE_20261022.md). Delta ainda não publicado; revisão independente APROVADO com ressalvas P3, fechadas localmente em 22/10 e aguardando conferência.
