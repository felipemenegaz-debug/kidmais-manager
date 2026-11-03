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
 * Revisões registradas de arquivos do diff que a prova reprova (FECHO ou CHAMADOR). Cada uma vale só para a regra, o
 * caminho e o PAR EXATO de blobs (`de` → `ate`; `null` = arquivo ausente naquele lado) e cobre o delta COMPLETO do
 * arquivo: qualquer outra versão volta a violar. A violação sai em `revisados` com autoria e análise. Autoria registrada
 * como ela é — revisão por agente não é assinatura humana; entrada nova aqui é entrada revisada (Astra) do B-23b.
 */
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
    // Violação de FECHO/CHAMADOR com revisão registrada para esta regra, caminho e par exato de blobs vai para `revisados`.
    const registrar = (v) => {
        const blobs = lados.map((a) => (a.arquivos.includes(v.arquivo) ? blobGit(a.ler(v.arquivo)) : null));
        const rev = REVISOES.find((x) => x.regra === v.regra && x.arquivo === v.arquivo && x.de === blobs[0] && x.ate === blobs[1]);
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
        else if (ehRaiz(f)) violacoes.push({ regra: 'RAIZ', arquivo: f });
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
            else if (motivo) violacoes.push({ regra: 'SQL_TABELA_NO_FECHO', arquivo: f, objeto: t, motivo });
        }
        for (const fn of o.funcoes) {
            const motivo = sql.funcoes.get(fn);
            if (motivo === 'MARCADOR') violacoes.push({ regra: 'SQL_MARCADOR', arquivo: f, objeto: fn });
            else if (motivo?.startsWith('gatilho ')) violacoes.push({ regra: 'SQL_GATILHO_EM_TABELA_DO_FECHO', arquivo: f, objeto: fn, motivo });
            else if (motivo) violacoes.push({ regra: 'SQL_FUNCAO_NO_FECHO', arquivo: f, objeto: fn, motivo });
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
