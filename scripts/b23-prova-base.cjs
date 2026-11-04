/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * B-23b (plano de promoção, D-B23-1 = (a)): prova funcional de uma base antiga de production para a lista fechada
 * `CODIGOS_ANTIGOS` do B-14 (`lib/assinatura/recuperacao-execucao.ts`). Só lê o git local (sem rede, banco ou Render).
 *
 *   node scripts/b23-prova-base.cjs --de=<sha homologado> --ate=<sha candidato a base antiga>
 *   node scripts/b23-prova-base.cjs --verificar-lista   (reexecuta a prova de cada entrada e compara com a evidência)
 *
 * A base passa (código 0, PROVA_PASS) quando o diff `de..ate`:
 *   1. não toca nenhuma raiz de cobrança e recuperação (RAIZES) nem os arquivos globais de build, dependência e borda
 *      (GLOBAIS, inclui `proxy.ts`, que roda antes de toda rota, e o inicializador do startCommand);
 *   2. não toca nenhum arquivo alcançável pelas raízes por import/require, inclusive transitivo, em `de` OU em `ate` (num
 *      arquivo com import calculado, todo caminho do repositório escrito como literal também conta), nem arquivo que
 *      importa diretamente uma raiz (CHAMADOR: imports seguem dependências, não chamadores) — FECHO e CHAMADOR só passam
 *      com revisão registrada do delta completo, fixada à regra, ao caminho e ao par exato de blobs (REVISOES);
 *   3. nas migrations alteradas — conteúdo de `de` E de `ate`, inclusive removidas —, não atinge tabela ou função do fecho
 *      SQL: o que o código do fecho cita, os marcadores do B-14, as funções disparadas por gatilho (das duas árvores) dessas
 *      tabelas e, transitivamente, as funções chamadas e as tabelas usadas pelos corpos dessas funções.
 * Estrutural: arquivo de produção do fecho que importa teste/roteiro também falha (FECHO_IMPORTA_TESTE).
 * Qualquer violação → código 1 (PROVA_FALHOU) com a lista. Erro de uso ou de git → código 2. A saída é JSON estável e leva
 * o sha do analisador e dos marcadores; `limites` lista o que a expressão regular não cobre (imports calculados no fecho,
 * SQL dinâmico e funções sem corpo reconhecido no fecho SQL) para a revisão humana registrar, entrada por entrada.
 * Limites declarados: imports por literal; SQL por expressão regular (sem parser); `node_modules` coberto só por GLOBAIS.
 */
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const RAIZES = [
    /^lib\/assinatura\//, /^lib\/creditos\//, /^lib\/desenvolvedor\/cobranca\.ts$/,
    /^scripts\/assinatura-[^/]+$/, /^scripts\/recuperacao-[^/]+$/,
    /^app\/api\/admin\/assinatura\//, /^app\/api\/admin\/creditos\//, /^app\/api\/desenvolvedor\/creditos\//,
    /^app\/api\/desenvolvedor\/empresas\/\[id\]\/cobranca\//, /^app\/api\/desenvolvedor\/renovacoes\//,
    /^app\/api\/integracoes\/asaas\//,
];
const GLOBAIS = new Set(['package.json', 'package-lock.json', 'tsconfig.json', 'next.config.ts', 'next.config.js', 'next.config.mjs',
    'render.yaml', 'proxy.ts', 'middleware.ts', 'scripts/init-staging-data.cjs']);
const CODIGO = /\.(ts|tsx|js|cjs|mjs)$/;
/**
 * Testes não rodam em production: não são ponto de partida nem caminho do fecho (dentro de uma raiz, contam como RAIZ).
 * Inclui os apoios de teste (`*.test-apoio.cjs`) e os roteiros de navegador `scripts/*-ui.cjs` (Playwright). Se um arquivo
 * de produção do fecho importar um deles, a prova falha (FECHO_IMPORTA_TESTE) em vez de parar a propagação em silêncio.
 */
const TESTE = /(\.test\.(ts|tsx|js|cjs|mjs)|\.test-apoio\.cjs|^scripts\/[^/]+-ui\.cjs)$/;
const EXTENSOES = ['', '.ts', '.tsx', '.js', '.cjs', '.mjs', '.json', '/index.ts', '/index.tsx', '/index.js'];
const MIGRATION = /^database\/migrations\/[^/]+\.sql$/;
const LISTA = 'lib/assinatura/recuperacao-execucao.ts';
/**
 * Revisões registradas de arquivos do diff que a prova reprova. Cada uma vale só para a regra, o caminho e o PAR EXATO de
 * blobs (`de` → `ate`; `null` = arquivo ausente naquele lado) — nas regras SQL, também para o `objeto` — e cobre o
 * delta COMPLETO do arquivo: qualquer outra versão volta a violar. A violação sai em `revisados` com autoria e análise.
 * Autoria registrada como ela é — revisão por agente não é assinatura humana; entrada nova aqui é entrada revisada (Astra).
 * Revisáveis (REVISAVEIS): FECHO e CHAMADOR (B-23b) e, pela exceção nominal D-B23c-1 = (A) de 03/11/2026, RAIZ e as regras
 * SQL de fecho. GLOBAL, SQL_MARCADOR e FECHO_IMPORTA_TESTE nunca são revisáveis.
 * As entradas de 5e4340db que dependem da trava ASSINATURA_AVISOS_EMAIL desligada (D-B23c-2) dizem isso na análise; a
 * barreira executável é a guarda AVISOS_EMAIL_LIGADOS de scripts/recuperacao-pagamentos-producao.cjs.
 */
const REVISAVEIS = new Set(['FECHO', 'CHAMADOR', 'RAIZ', 'SQL_TABELA_NO_FECHO', 'SQL_FUNCAO_NO_FECHO', 'SQL_GATILHO_EM_TABELA_DO_FECHO']);
const B23C = 'Revisão por agente: Claude (implementador, B-23c, 03/11/2026); aceite independente por agente: Astra (r1, 03/11/2026), '
    + 'das 21 análises nominais, exclusivamente para as regras, caminhos, pares integrais de blobs e objetos SQL registrados, '
    + 'sob D-B23c-1/2/3. Este aceite não encerra o P2-B23C-COD-R1-01, não substitui o §6 e não autoriza operação ou promoção.';
const B23D = 'Revisão por agente: Claude (implementador, B-23d, 04/11/2026); aceite independente por agente: Astra (código r1, '
    + '04/11/2026), das nove análises nominais, exclusivamente para as regras, caminhos e pares integrais de blobs registrados, sob '
    + 'D-B23d-1/2/3 = (A), com ressalva documental P3-B23D-COD-R1-01. Mantidas a trava desligada e as barreiras operacionais '
    + 'existentes. Este aceite não autoriza operação ou promoção.';
const NOVO_087 = 'Arquivo novo da 087 (avisos por e-mail da assinatura, #299), ausente em 00d3019a. ';
const TESTE_087 = NOVO_087 + 'Teste: não roda em production nem é importado por código de produção; não muda o caminho do B-14.';
const REVISOES = [
    {
        regra: 'FECHO', arquivo: 'scripts/production/check-migrations.mjs',
        de: '0ebac5771a06ca5e70eb277e011838f31ec48db1', ate: '06d817620e89c00e4ace0a8fd70afabdc12a81b9',
        autoria: 'Revisão por agente: Claude (implementador, r2); aceite independente por agente: Astra (r2, 01/11/2026).',
        analise: 'Inventário do go/no-go de migrations: só acrescenta a 099 a approvedFiles, requiresExplicitAuthorization e '
            + 'pending. Não é carregado pelo app nem pelos crons; entra no fecho só pelo import calculado de '
            + 'scripts/assinatura-schema-completo.cjs (ensaio offline), que corta approvedFiles na 075 — a entrada nova fica fora.',
    },
    {
        regra: 'CHAMADOR', arquivo: 'lib/convites/service.ts',
        de: '5d70a0ac5ebf2d3dbbb2592661ec405829d738a0', ate: 'a77cf5f311ca2cdf4e9f486a36734c36baf14cf1',
        autoria: 'Revisão por agente: Claude (implementador, r3, 01/11/2026); aceite independente por agente: Astra (r3, 02/11/2026), no escopo da prova B-23b.',
        analise: 'Delta completo (+37/−17) só de Convites avulsos: Acesso por conviteId, festa_id/cliente_id/versao_contrato_id '
            + 'anuláveis, ramo do convite sem festa em comConvite (SELECT/FOR UPDATE em convites da empresa), guarda que exige '
            + 'festa para liberar o editor do cliente, publico() com LEFT JOIN para avulso e confirmar() travando festas só '
            + 'quando há festa (o FOR UPDATE de convites passou para antes de publico()). Escritas: só as já existentes em '
            + 'convites/convite_eventos. Cobrança: o import de lerEstadoComercial e a guarda 402 são os mesmos de 00d3019a; '
            + 'nenhum SQL em tabela de assinatura, crédito, pagamento ou marcador do B-14; nenhuma chamada nova a raiz.',
    },
    {
        regra: 'CHAMADOR', arquivo: 'lib/convites/biblioteca.ts',
        de: null, ate: 'a83603cd11088d454e84bb0a579930b7472c4eff',
        autoria: 'Revisão por agente: Claude (implementador, r3, 01/11/2026); aceite independente por agente: Astra (r3, 02/11/2026), no escopo da prova B-23b.',
        analise: 'Arquivo novo (120 linhas): listagem e miniatura (só SELECT em convites/convite_artes/festas/contratos/'
            + 'contrato_versoes/membership_estabelecimentos), criar avulso (INSERT em convites e convite_eventos; não reserva '
            + 'créditos) e vincular (contrato() → festas FOR UPDATE → convites FOR UPDATE; leitura de convite_geracoes; '
            + 'revogarAutorizacao em convite_ia_autorizacoes; UPDATE de convites; INSERT em convite_eventos). Da cobrança só '
            + 'lê lerEstadoComercial e recusa com 402 (mesma guarda do editor); nenhum SQL em tabela de assinatura, crédito, '
            + 'pagamento ou marcador do B-14.',
    },
    {
        regra: 'CHAMADOR', arquivo: 'lib/site/catalogo.ts',
        de: 'f282886a9bbdca6ab5f07026c177768e8b102a2e', ate: 'a650bd167dec9c22f2ef590a590e30ae03478605',
        autoria: B23C,
        analise: 'Delta de apresentação comercial (igual em 7329cbfe e 5e4340db): descrições dos planos, cotas de importação, itens e '
            + 'recursos de Copiloto e Convites, exclusões e posição do Wall-e e remoção do Wall-e publicitário. O import de '
            + 'planos-comerciais.ts (condicoesComerciais, planosComerciais, valorComercial) já existia em 00d3019a e não mudou; '
            + 'o arquivo não calcula cobrança nem tem SQL.',
    },
    {
        regra: 'FECHO', arquivo: 'scripts/production/check-migrations.mjs',
        de: '0ebac5771a06ca5e70eb277e011838f31ec48db1', ate: '0fd96b6d36caeb1d0210ab78bb96625fb0ad4791',
        autoria: B23C,
        analise: 'Inventário do go/no-go de migrations, delta inteiro desde 00d3019a: acrescenta 099 e 087 a approvedFiles, '
            + 'requiresExplicitAuthorization e pending, e corrige o comentário da 088. Não é carregado pelo app nem pelos crons; '
            + 'entra no fecho só pelo import calculado de scripts/assinatura-schema-completo.cjs (ensaio offline), que corta '
            + 'approvedFiles na 075 — as entradas novas ficam fora.',
    },
    {
        regra: 'RAIZ', arquivo: 'lib/assinatura/aplicador-087.postgres.test.ts',
        de: null, ate: '019871354cea2cc0884511f4dd05a6f1f8b26894',
        autoria: B23C,
        analise: TESTE_087,
    },
    {
        regra: 'RAIZ', arquivo: 'lib/assinatura/avisos-087.postgres.test.ts',
        de: null, ate: '2819c6054a87726eae1913f072a19c9d5044c3e8',
        autoria: B23C,
        analise: TESTE_087,
    },
    {
        regra: 'RAIZ', arquivo: 'lib/assinatura/avisos-envio.test.ts',
        de: null, ate: 'e97a42cfc487c97e937f48ecb69d229f2dd7749d',
        autoria: B23C,
        analise: TESTE_087,
    },
    {
        regra: 'RAIZ', arquivo: 'lib/assinatura/avisos-mensagens.test.ts',
        de: null, ate: 'b72c2b69b8d3e49228301ce7894011dbd612bccc',
        autoria: B23C,
        analise: TESTE_087,
    },
    {
        regra: 'RAIZ', arquivo: 'lib/assinatura/avisos-repositorio.test.ts',
        de: null, ate: '7895fb100c805264eb10d64a3d58c39f7c687a87',
        autoria: B23C,
        analise: TESTE_087,
    },
    {
        regra: 'RAIZ', arquivo: 'lib/assinatura/avisos.test.ts',
        de: null, ate: 'eee7dc800f313aacdc42de5926c8a209c4c24e57',
        autoria: B23C,
        analise: TESTE_087,
    },
    {
        regra: 'RAIZ', arquivo: 'lib/assinatura/migration-087.test.ts',
        de: null, ate: 'bfe3d7d7269385eede69b19672a17512ee11431e',
        autoria: B23C,
        analise: TESTE_087,
    },
    {
        regra: 'RAIZ', arquivo: 'scripts/assinatura-avisos.test.cjs',
        de: null, ate: '4a68b8b55cff509a83792010adbea301c626aef3',
        autoria: B23C,
        analise: TESTE_087,
    },
    {
        regra: 'RAIZ', arquivo: 'lib/assinatura/avisos.ts',
        de: null, ate: 'b212898f36e49b05d899c55bca38d5c84419df96',
        autoria: B23C,
        analise: NOVO_087 + 'Regras puras dos avisos (marcos, transições, prazos, avisosLigados = trim().toLowerCase() === "ligado"); '
            + 'sem SQL e sem efeito; só importa acesso.ts (cálculo comercial existente, sem escrita).',
    },
    {
        regra: 'RAIZ', arquivo: 'lib/assinatura/avisos-envio.ts',
        de: null, ate: '7f9104a6f649f52acf8790e6cf8139c1cef58ff7',
        autoria: B23C,
        analise: NOVO_087 + 'Orquestra enfileirar/enviar pelo RepositorioAvisos injetado (escreve só em assinatura_avisos) e pelo '
            + 'EnviarEmail injetado; sem SQL próprio. Só é chamado pelo job assinatura-avisos.cjs e por avisos-padrao.ts.',
    },
    {
        regra: 'RAIZ', arquivo: 'lib/assinatura/avisos-mensagens.ts',
        de: null, ate: 'cd35b89844e1846d70cba8a6c040e73e2fc2a604',
        autoria: B23C,
        analise: NOVO_087 + 'Texto dos e-mails (assunto/corpo) a partir do marco; função pura, sem SQL e sem efeito.',
    },
    {
        regra: 'RAIZ', arquivo: 'lib/assinatura/avisos-padrao.ts',
        de: null, ate: 'fc490ec176c73c325250f219b9e7f33e1b405ca9',
        autoria: B23C,
        analise: NOVO_087 + 'Dependências reais do envio no web; depsAvisosPadrao devolve null (nada enviado) com a trava desligada ou '
            + 'e-mail não configurado. Usado só por cobranca-padrao.ts (processarEventoAgendado), que o B-14 não chama.',
    },
    {
        regra: 'RAIZ', arquivo: 'lib/assinatura/avisos-repositorio.ts',
        de: null, ate: 'e01a8fab5520d33c2532e5f2ef22adc164316600',
        autoria: B23C,
        analise: NOVO_087 + 'SQL dos avisos. Escritas: INSERT … ON CONFLICT DO NOTHING e UPDATE só em assinatura_avisos, e auditoria '
            + 'AVISO_ASSINATURA_ENTREGA_FALHOU via auditarCobranca na devolução (webhook do Resend, que não consulta a trava). '
            + 'registrarAvisosDaTransicao (chamado por sincronizarEmpresa, caminho do B-14) retorna 0 ANTES de qualquer consulta '
            + 'com a trava desligada — condição D-B23c-2. Ligada, emite SAVEPOINT fora do try e pode inserir em '
            + 'assinatura_avisos, tabela fora da fotografia do B-14: por isso a guarda AVISOS_EMAIL_LIGADOS.',
    },
    {
        regra: 'RAIZ', arquivo: 'lib/assinatura/cobranca-padrao.ts',
        de: 'b5957da5e0deab0e9a812b3cda06857a620b9a96', ate: 'f5df456506eb0d4e239a6160c3a8f0d9a9d2c0e6',
        autoria: B23C,
        analise: 'Delta: import de enviarAvisosDaEmpresaAgora e, em processarEventoAgendado, a chamada depois do commit do evento '
            + 'PROCESSADO; no-op com a trava desligada ou sem e-mail; erro só vai ao log. O B-14 chama processarEvento direto, '
            + 'não processarEventoAgendado: este caminho é o do webhook normal, coberto pela confirmação da trava no E0.',
    },
    {
        regra: 'RAIZ', arquivo: 'lib/assinatura/renovacao-entrega.ts',
        de: 'aa0949d91dc2802af09a5aa113c32cfde5381c23', ate: 'a02bba2bf3941f0cc8f4f7823e1d5b5d08acbb16',
        autoria: B23C,
        analise: 'Delta: no webhook do Resend, id que não é de renovação é procurado em assinatura_avisos (registrarDevolucaoAviso), '
            + 'sem consultar a trava: sem a 087 o resultado é o de antes (DESCONHECIDO/NAO_INSTALADA); com a 087, só '
            + 'ENVIADO → DEVOLVIDO em assinatura_avisos e auditoria. Nenhuma escrita nova em renovações, assinatura, crédito, '
            + 'pagamento ou marcador do B-14; caminho externo ao B-14, sujeito às barreiras e drenagem da janela.',
    },
    {
        regra: 'RAIZ', arquivo: 'lib/assinatura/sincronizacao.ts',
        de: '4fcaf7dbd4368071c425b2e9a1bf2ccc94e2fdf8', ate: '410f97a3124663bf631ea394b620c767a93e0051',
        autoria: B23C,
        analise: 'Delta: import e uma chamada a registrarAvisosDaTransicao em sincronizarEmpresa, depois da mudança gravada, na '
            + 'mesma transação. Caminho do B-14 (casos EMPRESA). Com a trava desligada (D-B23c-2) retorna 0 sem consulta: '
            + 'comportamento de 00d3019a. Ligada, poderia inserir em assinatura_avisos fora da fotografia — a guarda '
            + 'AVISOS_EMAIL_LIGADOS recusa o B-14 antes do Client.',
    },
    {
        regra: 'RAIZ', arquivo: 'scripts/assinatura-avisos.cjs',
        de: null, ate: 'e1aff377acbd3067dc1cf7a0e0ac8074ca4fb376',
        autoria: B23C,
        analise: NOVO_087 + 'Job dos avisos (simular por padrão; aplicar só em modos travados, com a trava ligada e a 087 conferida). '
            + 'Escreve só por repositorioAvisos (assinatura_avisos); não consulta o Asaas. Não existe cron dele em production.',
    },
    {
        regra: 'SQL_TABELA_NO_FECHO', arquivo: 'database/migrations/20261019_087_assinatura_avisos.sql', objeto: 'assinatura_avisos',
        de: null, ate: 'b9a818d3f59f8f6cd3d217e9a8fc066de4ff4840',
        autoria: B23C,
        analise: 'Migration 087 inteira (aditiva): cria assinatura_avisos (FKs para empresas e usuarios_administrativos), dois índices, a '
            + 'função kidmais_087_aviso_guarda e dois gatilhos, todos só nessa tabela; nenhuma tabela existente é alterada. As FKs '
            + 'só restringem DELETE/troca de chave das linhas-pai, que o B-14 não faz. ' + 'Objeto: a tabela nova, citada por avisos-repositorio.ts.',
    },
    {
        regra: 'SQL_GATILHO_EM_TABELA_DO_FECHO', arquivo: 'database/migrations/20261019_087_assinatura_avisos.sql', objeto: 'kidmais_087_aviso_guarda',
        de: null, ate: 'b9a818d3f59f8f6cd3d217e9a8fc066de4ff4840',
        autoria: B23C,
        analise: 'Migration 087 inteira (aditiva): cria assinatura_avisos (FKs para empresas e usuarios_administrativos), dois índices, a '
            + 'função kidmais_087_aviso_guarda e dois gatilhos, todos só nessa tabela; nenhuma tabela existente é alterada. As FKs '
            + 'só restringem DELETE/troca de chave das linhas-pai, que o B-14 não faz. ' + 'Objeto: a função de guarda, gatilho só em assinatura_avisos (não apaga histórico; transições permitidas).',
    },
    {
        regra: 'CHAMADOR', arquivo: 'components/admin/AssinaturaAcoes.tsx',
        de: '31c042fb6aa06bdd110304bedd4f3156c280b66c', ate: '60e8fac8491394a3671e0f0e03d00b9a61cb280a',
        autoria: B23D,
        analise: 'Delta completo desde 00d3019a = #311 (+7/−4; linhas 42, 84–85, 87, 90–91 e 159 do blob 60e8fac8): estado comProtocolo, lido de '
            + 'data.instalado no GET /api/admin/assinatura/devolucao?opcoes=1 (campo já existente em lib/assinatura/devolucao.ts, inalterado), '
            + 'e a frase do protocolo só aparece com a 089 instalada. Componente de UI no cliente: nenhum import novo (o de planos-comerciais.ts é '
            + 'o de 00d3019a), nenhuma rota, SQL ou escrita nova; não está no caminho do B-14.',
    },
    {
        regra: 'CHAMADOR', arquivo: 'components/site/secoes.tsx',
        de: 'd2a02ce0a2a77e8c41bccae4676b077c418a4e8b', ate: '5be85ed6f68b70607b87c7a7664794139fd57df6',
        autoria: B23D,
        analise: 'Delta completo desde 00d3019a = #321 (+59/−29): marca iA.Fest nos textos (linhas 20, 36, 44, 54, 70, 85–86, 178, 234, 236, 249 e '
            + '256 do blob 5be85ed6), seções novas ImportacaoDocumentos, FinanceiroDetalhes e Marketing (linhas 92–135) e o Wall-e só como '
            + 'atendente, sem o Wall-e publicitário (linhas 139–141; bloco antigo 117–130 removido). Só JSX estático e textos do site público: '
            + 'nenhum import mudou (o de lib/assinatura/texto.ts é o de 00d3019a), sem rota, SQL, fetch ou cálculo de cobrança.',
    },
    {
        regra: 'RAIZ', arquivo: 'lib/assinatura/transacao-com-prazo.postgres.test.ts',
        de: '3fab557a22351c1249347e93157cb025f09b5256', ate: 'a47298480692e2a52f21062ff5e9a406944786c0',
        autoria: B23D,
        analise: 'Teste (#313, D1 do PRAZO determinístico; +41/−10, linhas 12, 22–27, 120–136, 149, 168–257 do blob a4729848): suíte PG que roda '
            + 'só no harness local em banco descartável (citada apenas por scripts/regressao-v1-selecao.cjs). Não roda em production, não entra '
            + 'no build do web e não é importada por código de produção; não muda nenhum caminho do B-14.',
    },
    {
        regra: 'CHAMADOR', arquivo: 'lib/convites/service.ts',
        de: '5d70a0ac5ebf2d3dbbb2592661ec405829d738a0', ate: '2e28822cdf519d925b3158f21c035e4e645bcdf1',
        autoria: B23D,
        analise: 'Delta completo desde 00d3019a (+40/−18; linhas 16–85, 166, 199, 222, 248–250 e 636–675 do blob 2e28822c) = o par já '
            + 'aceito no B-23b (5d70a0ac → a77cf5f3, Convites avulsos: Acesso por conviteId, '
            + 'ramo sem festa em comConvite, guarda do editor, publico() com LEFT JOIN e confirmar() travando festas só quando há festa) + a #315 '
            + '(linhas 248–250 do blob 2e28822c): ao excluir a arte de um rascunho em modo completa (Convite pronto), o modo volta para modelo, '
            + 'no mesmo UPDATE de convites da mesma transação e empresa. Escritas: só convites, convite_artes, convite_geracoes e '
            + 'convite_eventos. Cobrança: o import de lerEstadoComercial (lib/assinatura/estado.ts) e a guarda 402 são os de 00d3019a; nenhum SQL '
            + 'em tabela de assinatura, crédito, pagamento ou marcador do B-14.',
    },
    {
        regra: 'CHAMADOR', arquivo: 'lib/exportacao/pacote.ts',
        de: '863abfe972079596819a39aa326937bd89309523', ate: '26099c4dfc464a98fcd538d1faf6c8500725e461',
        autoria: B23D,
        analise: 'Delta completo desde 00d3019a = #313, exportação em blocos (+41/−11; linhas 15, 17, 32–33, 178–194 e 374–409 do blob 26099c4d): '
            + 'o cursor passa a ler só octet_length do PDF e cada bloco de até BLOCO_PDF_BYTES (1 MiB) vem por substring com o mesmo filtro de '
            + 'empresa (WHERE do tenant AND t.id), no mesmo executor transacional; o Gravador escreve em laço até o fim (escrita parcial tratada) '
            + 'e o tamanho e o hash finais são conferidos. Só leitura no banco; csv.ts (import de lib/assinatura/csv.ts) inalterado. A transação '
            + 'REPEATABLE READ READ ONLY continua sendo obrigação do chamador (lib/exportacao/servico.ts). Nada de cobrança ou do B-14.',
    },
    {
        regra: 'CHAMADOR', arquivo: 'lib/site/catalogo.ts',
        de: 'f282886a9bbdca6ab5f07026c177768e8b102a2e', ate: '2006ad357acd8a451b5d495470031996dd4ea748',
        autoria: B23D,
        analise: 'Delta completo desde 00d3019a (+16/−12; linhas 41–83 do blob 2006ad35; removidas as linhas 19 e 78–79 do blob f282886a) '
            + '= o par já aceito no B-23c (f282886a → a650bd16, apresentação comercial dos planos: '
            + 'descrições, cotas de importação, Copiloto e Convites, exclusões e posição do Wall-e, adicionais) + a #321, que tira do catálogo o '
            + 'recurso walle_publicitario (linha 19 do blob f282886a, removida, e o adicional Wall-e publicitário, linha 79). Dados estáticos do site; o import de planos-comerciais.ts '
            + '(condicoesComerciais, planosComerciais, valorComercial) é o de 00d3019a; o arquivo não calcula cobrança nem tem SQL.',
    },
    {
        regra: 'FECHO', arquivo: 'lib/site/configuracao.ts',
        de: '29a0d08476cd538d4818929e0f79b4b733003a15', ate: '57c006e2d377ef896a126687cd86de60932a4f28',
        autoria: B23D,
        analise: 'Delta completo desde 00d3019a = #321, só strings (linhas 2, 31–32 e 34–35 do blob 57c006e2): Kidmais/Kidmais Manager passam a '
            + 'iA.Fest na frase de cadastro fechado e nas mensagens de WhatsApp e e-mail do site. Funções, assinaturas, variáveis de ambiente '
            + 'lidas e retorno de configuracaoSite iguais. Está na árvore entregue do B-14, mas o pacote leva a versão da candidata, não a de '
            + 'production.',
    },
    {
        regra: 'RAIZ', arquivo: 'scripts/assinatura-avisos.cjs',
        de: null, ate: 'd20388aed9cdd2853b2190bde39cf0322ed36c8d',
        autoria: B23D,
        analise: 'Arquivo inteiro (280 linhas; B-23c aceitou o blob e1aff377 da 087, aqui somado à #304/#309): job do cron de avisos. Configuração '
            + '(linhas 38–99): simular por padrão; aplicar só com ASSINATURA_AVISOS_EMAIL=ligado, KIDMAIS_AVISOS_MODO e alvo explícito validado '
            + 'por validarAlvo/opcoesConexao de assinatura-reconciliar.cjs (nunca DATABASE_URL), TLS obrigatório fora do local (linhas 101–115). '
            + 'Execução (linhas 228–278): importa avisos-envio, avisos-repositorio, configuracao e acessos/email; escreve só em assinatura_avisos '
            + 'por repositorioAvisos, em transações próprias; não consulta o Asaas. Diagnóstico (#309, linhas 118–221): ETAPAS, MOTIVOS e TIPOS '
            + 'fechados e CODIGO_SEGURO, que restringe só o FORMATO do code (não garante o sigilo de um conteúdo externo compatível com esse '
            + 'formato); cicloComEncerramento separa a falha do corpo da do encerramento; URL ilegível vira mensagem fixa. Fora da árvore '
            + 'entregue do B-14 e não importado pelo app: isso é evidência auxiliar. Continuam necessárias a trava ASSINATURA_AVISOS_EMAIL '
            + 'desligada na janela (D-B23c-2), conferida pela guarda AVISOS_EMAIL_LIGADOS, e as barreiras operacionais existentes.',
    },
    {
        regra: 'RAIZ', arquivo: 'scripts/assinatura-avisos.test.cjs',
        de: null, ate: 'fce75ad066407fff4fbb1edec341fbd0859c75ba',
        autoria: B23D,
        analise: 'Teste do job de avisos (302 linhas; B-23c aceitou o blob 4a68b8b5, aqui somado aos testes do log seguro da #309): roda no build '
            + 'do cron (node --test) e no CI, nunca em runtime; não é importado por código de produção e não muda o caminho do B-14.',
    },
];
const EVIDENCIAS = 'docs/evidencias/b23-bases-antigas';

const ehRaiz = (f) => RAIZES.some((r) => r.test(f));
const sha256 = (s) => crypto.createHash('sha256').update(s.replace(/\r\n/g, '\n')).digest('hex');

/** Especificadores de import/require/export-from/import() por literal. */
function especificadores(fonte) {
    const out = new Set();
    const re = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)(['"])([^'"\n]+)\1/gm;
    for (let m; (m = re.exec(fonte));) out.add(m[2]);
    return [...out];
}

/** import()/require() com argumento que não é literal simples: o fecho pode estar incompleto ali. */
const importCalculado = (fonte) => /\b(?:require|import)\s*\(\s*(?!['")])/.test(fonte.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' '));

/** Caminhos do repositório (a partir da raiz) escritos como literal num fonte. */
function caminhosLiterais(fonte, existe) {
    return [...new Set([...fonte.matchAll(/(['"`])([\w@.-]+(?:\/[\w@.[\]-]+)+)\1/g)].map((m) => m[2]))].filter(existe).sort();
}

/** sha1 de blob do git (o mesmo de `git rev-parse <commit>:<arquivo>`), para fixar uma revisão a uma versão exata. */
const blobGit = (conteudo) => {
    const b = Buffer.from(conteudo, 'utf8');
    return crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${b.length}\0`), b])).digest('hex');
};

/** Resolve um especificador local para um caminho do repositório (ou null para pacote/externo). */
function resolver(origem, espec, existe) {
    let base;
    if (espec.startsWith('@/')) base = espec.slice(2);
    else if (espec.startsWith('./') || espec.startsWith('../')) base = path.posix.join(path.posix.dirname(origem), espec);
    else return null;
    for (const ext of EXTENSOES) if (existe(base + ext)) return base + ext;
    return null;
}

/** Arquivos do repositório que `f` importa diretamente. */
function importsDe(f, ler, existe) {
    return especificadores(ler(f)).map((e) => resolver(f, e, existe)).filter(Boolean);
}

/**
 * Fecho transitivo dos arquivos alcançáveis a partir das raízes numa árvore (`arquivos` = lista, `ler` = conteúdo).
 * Devolve o conjunto e, em `.testes`, as arestas produção → teste encontradas no caminho.
 */
function fecho(arquivos, ler) {
    const existe = new Set(arquivos);
    const visto = new Set();
    const testes = [];
    const pilha = arquivos.filter((f) => ehRaiz(f) && CODIGO.test(f) && !TESTE.test(f));
    while (pilha.length) {
        const f = pilha.pop();
        if (visto.has(f)) continue;
        visto.add(f);
        if (!CODIGO.test(f)) continue;
        for (const alvo of importsDe(f, ler, (p) => existe.has(p))) {
            if (TESTE.test(alvo)) testes.push({ arquivo: f, alvo });
            else if (!visto.has(alvo)) pilha.push(alvo);
        }
        // Import calculado (`import(pathToFileURL(path.join(raiz, 'x/y.mjs')))`, `fs.readFileSync(path.join(raiz, …))`):
        // conservador — todo caminho do repositório escrito como literal no arquivo entra no fecho (testes não).
        const fonte = ler(f);
        if (importCalculado(fonte)) for (const alvo of caminhosLiterais(fonte, (p) => existe.has(p)))
            if (!TESTE.test(alvo) && !visto.has(alvo)) pilha.push(alvo);
    }
    visto.testes = testes;
    return visto;
}

/** Tira comentários SQL (`--` até o fim da linha e blocos), para o texto deles não virar objeto. */
const semComentarios = (sql) => sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
const nome = (s) => s.replace(/"/g, '').replace(/^public\./i, '').toLowerCase();
const escapar = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ID = '("?[\\w.]+"?)';

/** Objetos que uma migration atinge: tabelas (DDL/DML), funções criadas/trocadas/removidas e gatilhos (tabela-alvo). */
function objetosDaMigration(fonte) {
    const sql = semComentarios(fonte);
    const tabelas = new Set(), funcoes = new Set();
    const padroesTabela = [
        new RegExp(`\\balter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?${ID}`, 'gi'),
        new RegExp(`\\b(?:create|drop)\\s+table\\s+(?:if\\s+(?:not\\s+)?exists\\s+)?${ID}`, 'gi'),
        new RegExp(`\\bcreate\\s+(?:unique\\s+)?index\\s+(?:concurrently\\s+)?(?:if\\s+not\\s+exists\\s+)?(?:"?[\\w.]+"?\\s+)?on\\s+(?:only\\s+)?${ID}`, 'gi'),
        new RegExp(`\\bcreate\\s+(?:or\\s+replace\\s+)?(?:constraint\\s+)?trigger\\s+"?\\w+"?[\\s\\S]*?\\bon\\s+${ID}`, 'gi'),
        new RegExp(`\\bdrop\\s+trigger\\s+(?:if\\s+exists\\s+)?"?\\w+"?\\s+on\\s+${ID}`, 'gi'),
        // "BEFORE UPDATE ON t" / "UPDATE OF col ON t" são de gatilho (tratados acima), não DML.
        new RegExp(`\\b(?:update|insert\\s+into|delete\\s+from|truncate(?:\\s+table)?)\\s+(?!(?:on|of|or)\\b)${ID}`, 'gi'),
    ];
    for (const re of padroesTabela) for (let m; (m = re.exec(sql));) tabelas.add(nome(m[1]));
    const reFuncao = new RegExp(`\\b(?:create\\s+(?:or\\s+replace\\s+)?|drop\\s+|alter\\s+)function\\s+(?:if\\s+exists\\s+)?${ID}`, 'gi');
    for (let m; (m = reFuncao.exec(sql));) funcoes.add(nome(m[1]));
    return { tabelas: [...tabelas].sort(), funcoes: [...funcoes].sort() };
}

/** Tabela citada em contexto SQL num fonte (FROM/JOIN/INTO/UPDATE/TABLE/ON/REFERENCES), sem casar texto comum. */
function citaTabelaEmSql(fonte, tabela) {
    return new RegExp(`\\b(?:from|join|into|update|table|references|on)\\s+(?:public\\.)?"?${escapar(tabela)}"?\\b`, 'i').test(fonte);
}

/** Função chamada em fonte (SQL ou TS): nome seguido de parêntese. */
const citaFuncao = (fonte, funcao) => new RegExp(`\\b${escapar(funcao)}\\s*\\(`, 'i').test(fonte);

/** Gatilhos declarados nas migrations: função executada → tabelas onde dispara. */
function gatilhos(migrations) {
    const mapa = new Map();
    const re = /\bcreate\s+(?:or\s+replace\s+)?(?:constraint\s+)?trigger\s+"?\w+"?[\s\S]*?\bon\s+("?[\w.]+"?)[\s\S]*?\bexecute\s+(?:function|procedure)\s+("?[\w.]+"?)\s*\(/gi;
    for (const fonte of migrations) for (let m, sql = semComentarios(fonte); (m = re.exec(sql));) {
        const f = nome(m[2]);
        if (!mapa.has(f)) mapa.set(f, new Set());
        mapa.get(f).add(nome(m[1]));
    }
    return mapa;
}

/** Corpos das funções declaradas (`AS $tag$ … $tag$`), concatenados por nome; funções declaradas; tabelas criadas. */
function catalogoSql(migrations) {
    const corpos = new Map(), declaradas = new Set(), tabelas = new Set();
    const reCorpo = new RegExp(`\\bcreate\\s+(?:or\\s+replace\\s+)?function\\s+${ID}\\s*\\([\\s\\S]*?\\bas\\s+(\\$\\w*\\$)([\\s\\S]*?)\\2`, 'gi');
    const reDecl = new RegExp(`\\bcreate\\s+(?:or\\s+replace\\s+)?function\\s+${ID}`, 'gi');
    const reTabela = new RegExp(`\\bcreate\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?${ID}`, 'gi');
    for (const fonte of migrations) {
        const sql = semComentarios(fonte);
        for (let m; (m = reDecl.exec(sql));) declaradas.add(nome(m[1]));
        for (let m; (m = reTabela.exec(sql));) tabelas.add(nome(m[1]));
        for (let m; (m = reCorpo.exec(sql));) corpos.set(nome(m[1]), (corpos.get(nome(m[1])) ?? '') + '\n' + m[3]);
    }
    return { corpos, declaradas, tabelas };
}

/**
 * Fecho SQL até ponto fixo. Sementes: tabelas e funções citadas pelo código do fecho e os marcadores do B-14. Regras:
 * tabela protegida → funções dos gatilhos dela; função protegida → funções que o corpo chama e tabelas que o corpo usa.
 * O mapa guarda de onde veio cada objeto (a cadeia aparece na violação).
 */
function fechoSql({ fontes, marcadores, migrations }) {
    const { corpos, declaradas, tabelas: criadas } = catalogoSql(migrations);
    const disparos = gatilhos(migrations);
    const porTabela = new Map();
    for (const [fn, ts] of disparos) for (const t of ts) {
        if (!porTabela.has(t)) porTabela.set(t, new Set());
        porTabela.get(t).add(fn);
    }
    const marc = new Set(marcadores.map(nome));
    const tabelasConhecidas = [...new Set([...criadas, ...marc])].sort();
    const funcoesConhecidas = [...new Set([...declaradas, ...disparos.keys()])].sort();
    const tabelas = new Map(), funcoes = new Map();
    const fila = [];
    const addT = (t, motivo) => { if (!tabelas.has(t) && !funcoes.has(t)) { tabelas.set(t, motivo); fila.push(['t', t]); } };
    const addF = (f, motivo) => { if (!funcoes.has(f) && !tabelas.has(f)) { funcoes.set(f, motivo); fila.push(['f', f]); } };
    for (const m of [...marc].sort()) (declaradas.has(m) && !criadas.has(m) ? addF : addT)(m, 'MARCADOR');
    // Gatilho criado por SQL dinâmico (`EXECUTE format('CREATE TRIGGER … ON %I …')`): a tabela não é conhecida, então a
    // função disparada entra protegida de saída (conservador).
    const reDinamico = /\bexecute\s+format\s*\(\s*'[^']*\bcreate\s+(?:constraint\s+)?trigger\b[^']*\bexecute\s+(?:function|procedure)\s+("?[\w.]+"?)\s*\(/gi;
    for (const fonte of migrations) for (let m, sql = semComentarios(fonte); (m = reDinamico.exec(sql));) addF(nome(m[1]), 'gatilho dinâmico');
    for (const t of tabelasConhecidas) {
        const quem = fontes.find((x) => citaTabelaEmSql(x.s, t));
        if (quem) addT(t, `citada em ${quem.f}`);
    }
    for (const fn of funcoesConhecidas) {
        const quem = fontes.find((x) => citaFuncao(x.s, fn));
        if (quem) addF(fn, `chamada em ${quem.f}`);
    }
    while (fila.length) {
        const [tipo, obj] = fila.shift();
        if (tipo === 't') for (const fn of [...(porTabela.get(obj) ?? [])].sort()) addF(fn, `gatilho em ${obj}`);
        else {
            const corpo = corpos.get(obj) ?? '';
            for (const fn of funcoesConhecidas) if (fn !== obj && citaFuncao(corpo, fn)) addF(fn, `chamada por ${obj}`);
            for (const t of tabelasConhecidas) if (citaTabelaEmSql(corpo, t)) addT(t, `usada por ${obj}`);
        }
    }
    const semCorpo = [...funcoes.keys()].filter((f) => !corpos.has(f)).sort();
    const dinamico = [...funcoes.keys()].filter((f) => /\bexecute\s+(?!function\b|procedure\b)/i.test(corpos.get(f) ?? '')).sort();
    return { tabelas, funcoes, semCorpo, dinamico };
}

/**
 * Avaliação pura (testável sem git). `arvores` = { de: {arquivos, ler}, ate: {arquivos, ler} }; `alterados` = nomes do
 * diff; `marcadores` = nomes dos objetos do B-14 (tabelas/funções).
 */
function avaliar({ alterados, arvores, marcadores }) {
    const violacoes = [];
    const revisados = [];
    const nomes = ['de', 'ate'];
    const lados = nomes.map((k) => arvores[k]);
    // Violação revisável com revisão registrada para esta regra, caminho, objeto (SQL) e par exato de blobs vai para
    // `revisados`; as outras regras nunca passam por aqui.
    const registrar = (v) => {
        if (!REVISAVEIS.has(v.regra)) throw new Error(`Regra não revisável: ${v.regra}`);
        const blobs = lados.map((a) => (a.arquivos.includes(v.arquivo) ? blobGit(a.ler(v.arquivo)) : null));
        const rev = REVISOES.find((x) => x.regra === v.regra && x.arquivo === v.arquivo && (x.objeto ?? null) === (v.objeto ?? null)
            && x.de === blobs[0] && x.ate === blobs[1]);
        if (rev) revisados.push({ ...v, de: rev.de, ate: rev.ate, autoria: rev.autoria, analise: rev.analise });
        else violacoes.push(v);
    };
    const fechos = lados.map((a) => fecho(a.arquivos, a.ler));
    const alcancavel = new Set([...fechos[0], ...fechos[1]]);
    fechos.forEach((fc, i) => {
        for (const t of fc.testes) violacoes.push({ regra: 'FECHO_IMPORTA_TESTE', arquivo: t.arquivo, alvo: t.alvo, arvore: nomes[i] });
    });
    for (const f of alterados) {
        if (GLOBAIS.has(f)) violacoes.push({ regra: 'GLOBAL', arquivo: f });
        else if (ehRaiz(f)) registrar({ regra: 'RAIZ', arquivo: f });
        else if (alcancavel.has(f)) registrar({ regra: 'FECHO', arquivo: f });
        else if (CODIGO.test(f) && !TESTE.test(f)) {
            const chamada = lados.map((a, i) => {
                if (!a.arquivos.includes(f)) return null;
                const existe = new Set(a.arquivos);
                const tem = (p) => existe.has(p);
                const fonte = a.ler(f);
                const raiz = especificadores(fonte).map((e) => resolver(f, e, tem)).find((p) => p && ehRaiz(p));
                return raiz ? { regra: 'CHAMADOR', arquivo: f, importa: raiz, arvore: nomes[i] } : null;
            }).find(Boolean);
            if (chamada) registrar(chamada);
        }
    }
    const fontes = [];
    lados.forEach((a, i) => { for (const f of [...fechos[i]].sort()) if (CODIGO.test(f)) fontes.push({ f, s: a.ler(f) }); });
    const migrations = lados.flatMap((a) => a.arquivos.filter((f) => MIGRATION.test(f)).map((f) => a.ler(f)));
    const sql = fechoSql({ fontes, marcadores, migrations });
    const objetos = [];
    for (const f of alterados.filter((x) => MIGRATION.test(x))) {
        // As duas versões: uma migration removida ou esvaziada também muda o schema que o código antigo espera.
        const versoes = lados.filter((a) => a.arquivos.includes(f)).map((a) => objetosDaMigration(a.ler(f)));
        const o = {
            tabelas: [...new Set(versoes.flatMap((v) => v.tabelas))].sort(),
            funcoes: [...new Set(versoes.flatMap((v) => v.funcoes))].sort(),
        };
        objetos.push({ migration: f, ...o });
        for (const t of o.tabelas) {
            const motivo = sql.tabelas.get(t);
            if (motivo === 'MARCADOR') violacoes.push({ regra: 'SQL_MARCADOR', arquivo: f, objeto: t });
            else if (motivo) registrar({ regra: 'SQL_TABELA_NO_FECHO', arquivo: f, objeto: t, motivo });
        }
        for (const fn of o.funcoes) {
            const motivo = sql.funcoes.get(fn);
            if (motivo === 'MARCADOR') violacoes.push({ regra: 'SQL_MARCADOR', arquivo: f, objeto: fn });
            else if (motivo?.startsWith('gatilho ')) registrar({ regra: 'SQL_GATILHO_EM_TABELA_DO_FECHO', arquivo: f, objeto: fn, motivo });
            else if (motivo) registrar({ regra: 'SQL_FUNCAO_NO_FECHO', arquivo: f, objeto: fn, motivo });
        }
    }
    const limites = {
        importsCalculados: [...new Set(fontes.filter((x) => importCalculado(x.s)).map((x) => x.f))].sort(),
        sqlDinamico: sql.dinamico,
        funcoesSemCorpo: sql.semCorpo,
    };
    return {
        resultado: violacoes.length ? 'PROVA_FALHOU' : 'PROVA_PASS', violacoes, objetos, revisados,
        fecho: { de: fechos[0].size, ate: fechos[1].size, sqlTabelas: sql.tabelas.size, sqlFuncoes: sql.funcoes.size }, limites,
    };
}

/** Marcadores do B-14 lidos do próprio fonte (nomes entre aspas depois de `nome:` no bloco MARCADORES). */
function marcadoresDoFonte(fonte) {
    const i = fonte.indexOf('export const MARCADORES:');
    if (i < 0) throw new Error('MARCADORES_AUSENTES');
    const bloco = fonte.slice(i, fonte.indexOf('});', i));
    return [...bloco.matchAll(/nome:\s*'([\w.]+)'/g)].map((m) => m[1]);
}

/** SHAs da lista fechada `CODIGOS_ANTIGOS`, na ordem do fonte (o primeiro é a base homologada). */
function codigosAntigosDoFonte(fonte) {
    const i = fonte.indexOf('export const CODIGOS_ANTIGOS');
    if (i < 0) throw new Error('LISTA_AUSENTE');
    return [...fonte.slice(i, fonte.indexOf('] as const);', i)).matchAll(/'([0-9a-f]{40})'/g)].map((m) => m[1]);
}

function git(args) { return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28 }); }
function arvoreGit(sha) {
    const arquivos = git(['ls-tree', '-r', '--name-only', sha]).split('\n').filter(Boolean);
    const cache = new Map();
    return { arquivos, ler: (f) => { if (!cache.has(f)) cache.set(f, git(['show', `${sha}:${f}`])); return cache.get(f); } };
}

/** A prova de `de..ate`, com os marcadores do B-14 deste checkout e o sha do analisador (vínculo da evidência). */
function provar(de, ate, fonteLista) {
    const alterados = git(['diff', '--name-only', de, ate]).split('\n').filter(Boolean).sort();
    const arvores = { de: arvoreGit(de), ate: arvoreGit(ate) };
    // Os marcadores são os do B-14 que vai rodar (este checkout): as bases antigas não têm o B-14.
    const marcadores = marcadoresDoFonte(fonteLista);
    const r = avaliar({ alterados, arvores, marcadores });
    return { de, ate, analisador: sha256(fs.readFileSync(__filename, 'utf8')), marcadoresSha: sha256(marcadores.join('\n')),
        alterados: alterados.length, marcadores, ...r };
}

/** Reexecuta a prova de cada base da lista (menos a homologada) e compara com a evidência guardada, campo a campo. */
function verificarLista(raiz) {
    const fonte = fs.readFileSync(path.join(raiz, LISTA), 'utf8');
    const [homologada, ...bases] = codigosAntigosDoFonte(fonte);
    const resultados = bases.map((sha) => {
        const arq = path.join(raiz, EVIDENCIAS, `prova-${sha}.json`);
        if (!fs.existsSync(arq)) return { sha, situacao: 'EVIDENCIA_AUSENTE' };
        const agora = provar(homologada, sha, fonte);
        if (agora.resultado !== 'PROVA_PASS') return { sha, situacao: 'PROVA_FALHOU', violacoes: agora.violacoes };
        const guardada = fs.readFileSync(arq, 'utf8').replace(/\r\n/g, '\n');
        return { sha, situacao: guardada === JSON.stringify(agora, null, 1) + '\n' ? 'CONFERE' : 'EVIDENCIA_DIVERGE' };
    });
    const ok = resultados.length > 0 && resultados.every((r) => r.situacao === 'CONFERE');
    return { codigo: ok ? 0 : 1, saida: { resultado: ok ? 'LISTA_CONFERE' : 'LISTA_DIVERGE', homologada, resultados } };
}

function main(argv) {
    if (argv.length === 1 && argv[0] === '--verificar-lista') return verificarLista(process.cwd());
    const op = Object.fromEntries(argv.map((a) => /^--(de|ate)=([0-9a-f]{40})$/.exec(a)).filter(Boolean).map((m) => [m[1], m[2]]));
    if (!op.de || !op.ate || argv.length !== 2) return { codigo: 2, saida: { resultado: 'USO', uso: '--de=<sha40> --ate=<sha40> | --verificar-lista' } };
    const saida = provar(op.de, op.ate, git(['show', `HEAD:${LISTA}`]));
    return { codigo: saida.resultado === 'PROVA_PASS' ? 0 : 1, saida };
}

if (require.main === module) {
    try {
        const { codigo, saida } = main(process.argv.slice(2));
        console.log(JSON.stringify(saida, null, 1));
        process.exitCode = codigo;
    } catch (e) {
        console.error('ERRO ' + String(e?.message ?? e).slice(0, 200));
        process.exitCode = 2;
    }
}

module.exports = { RAIZES, GLOBAIS, REVISOES, caminhosLiterais, blobGit, especificadores, importCalculado, resolver, fecho, objetosDaMigration, citaTabelaEmSql, citaFuncao,
    gatilhos, catalogoSql, fechoSql, avaliar, marcadoresDoFonte, codigosAntigosDoFonte, sha256, verificarLista, main };
