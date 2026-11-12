/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * B-14 (plano rev. 8.1, §3.8, D-B14-13): árvore mínima autossuficiente da recuperação de pagamentos.
 *   - fecho das dependências de EXECUÇÃO a partir de scripts/recuperacao-pagamentos-producao.cjs, pela árvore sintática do
 *     TypeScript (não por expressão regular): imports e requires relativos (estáticos e dinâmicos) e reexportações, sem os
 *     `import type` / `export type … from` (apagados pelo strip-types do Node); import()/require() com especificador que não
 *     seja literal recusa (DEPENDENCIA_NAO_DETERMINAVEL);
 *   - conteúdo LF (CR recusado), sha-256 por arquivo, `SHA256SUMS` no formato do sha256sum (ordenado) e o hash da árvore
 *     (sha-256 do SHA256SUMS), que os blocos de Shell fixam;
 *   - um package.json próprio (privado, sem "type", como o do repositório): a árvore não depende do package.json do deploy;
 *   - dependências externas permitidas só por lista fechada (pg e zod, do node_modules do serviço, versão conferida no
 *     bloco), além dos módulos node:*; qualquer outra recusa.
 * Só lê arquivos. Não conecta nem executa nada.
 *   node scripts/arvore-recuperacao-b14.cjs            imprime o resumo (arquivos, bytes, hash da árvore)
 */
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
// Só o gerador local usa o compilador (devDependency); a árvore entregue não o leva.
const ts = require('typescript');

const ENTRADA = 'scripts/recuperacao-pagamentos-producao.cjs';
const EXTERNOS = Object.freeze(['pg', 'zod']);
const PACKAGE_JSON = '{\n  "name": "kidmais-recuperacao-b14",\n  "private": true\n}\n';
const sha = (b) => createHash('sha256').update(b).digest('hex');

function lerLF(raiz, arquivo) {
    const texto = fs.readFileSync(path.join(raiz, arquivo), 'utf8').replace(/\r\n/g, '\n');
    if (texto.includes('\r')) throw new Error(`CR_ISOLADO ${arquivo}`);
    return texto;
}

function resolver(raiz, de, especificador) {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(de), especificador));
    for (const c of [base, `${base}.ts`, `${base}.cjs`, `${base}.js`, `${base}.mjs`]) {
        const p = path.join(raiz, c);
        if (fs.existsSync(p) && fs.statSync(p).isFile()) return c;
    }
    return null;
}

/**
 * Especificadores de execução, pela árvore sintática (revisão do incremento 5, P3: a expressão regular engolia o import
 * seguinte quando um comentário vinha depois de um `import type`):
 *   - `import … from` e `import '…'` (efeito), exceto `import type …` (`import { type X }` CARREGA o módulo e entra);
 *   - `export … from` (reexportação), exceto `export type … from`; `import x = require('…')`;
 *   - `import('…')` e `require('…')` com string ou template sem substituição; qualquer outro argumento recusa.
 * Comentários e strings nunca contam (não são nós de import).
 * Revisão da rodada 1 (P3-R1-3): carregador INDIRETO recusa, porque o fecho não o veria:
 *   - `require` fora da posição de chamada direta (alias `const r = require`, passado como argumento…); de `require.x` só
 *     main, resolve e cache são admitidos (não carregam módulo); `require.call/apply/bind` e `require[…]` recusam;
 *   - `module.require`, `createRequire`, `_load`, `dlopen` e `import.meta.resolve`, em qualquer posição.
 * Aprovação com ressalvas do incremento 5 (P3): também por COLCHETES — chave literal perigosa (`module['require']`,
 * `x['createRequire']`, `x['call']`…) ou chave não literal sobre module/require/process/Module/globalThis/import.meta.
 */
function especificadores(texto, arquivo = 'modulo.ts') {
    const tipo = /\.(?:c|m)?js$/.test(arquivo) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
    const fonte = ts.createSourceFile(arquivo, texto, ts.ScriptTarget.Latest, true, tipo);
    const r = [];
    const literal = (n) => n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : null;
    const recusar = (n) => { throw new Error(`DEPENDENCIA_NAO_DETERMINAVEL ${arquivo}:${fonte.getLineAndCharacterOfPosition(n.getStart(fonte)).line + 1}`); };
    const INDIRETOS = new Set(['createRequire', '_load', 'dlopen']);
    const PROPRIEDADES_DE_REQUIRE = new Set(['main', 'resolve', 'cache']);
    const CHAVES_PERIGOSAS = new Set([...INDIRETOS, 'require', 'resolve', 'call', 'apply', 'bind']);
    const BASES_SENSIVEIS = new Set(['module', 'require', 'process', 'Module', 'globalThis']);
    const visitar = (n) => {
        if (ts.isElementAccessExpression(n)) {
            const chave = literal(n.argumentExpression);
            if (chave !== null ? CHAVES_PERIGOSAS.has(chave)
                : (ts.isIdentifier(n.expression) && BASES_SENSIVEIS.has(n.expression.text)) || ts.isMetaProperty(n.expression)) recusar(n);
        }
        if (ts.isIdentifier(n) || ts.isPrivateIdentifier(n)) {
            const p = n.parent;
            if (INDIRETOS.has(n.text)) recusar(n);
            if (n.text === 'require') {
                const chamada = ts.isCallExpression(p) && p.expression === n;
                const propriedadeDeRequire = ts.isPropertyAccessExpression(p) && p.expression === n && PROPRIEDADES_DE_REQUIRE.has(p.name.text);
                if (!chamada && !propriedadeDeRequire) recusar(n);
            }
            if (n.text === 'resolve' && ts.isPropertyAccessExpression(p) && p.name === n && ts.isMetaProperty(p.expression)) recusar(n);
        }
        if (ts.isImportDeclaration(n)) { if (!n.importClause?.isTypeOnly) r.push(literal(n.moduleSpecifier)); }
        else if (ts.isExportDeclaration(n)) { if (!n.isTypeOnly && n.moduleSpecifier) r.push(literal(n.moduleSpecifier)); }
        else if (ts.isImportEqualsDeclaration(n)) {
            if (!n.isTypeOnly && ts.isExternalModuleReference(n.moduleReference)) r.push(literal(n.moduleReference.expression));
        }
        else if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === 'require'))) {
            const e = n.arguments.length === 1 || n.expression.kind === ts.SyntaxKind.ImportKeyword ? literal(n.arguments[0]) : null;
            if (e === null) throw new Error(`DEPENDENCIA_NAO_DETERMINAVEL ${arquivo}:${fonte.getLineAndCharacterOfPosition(n.getStart(fonte)).line + 1}`);
            r.push(e);
        }
        ts.forEachChild(n, visitar);
    };
    visitar(fonte);
    for (const e of r) if (e === null) throw new Error(`DEPENDENCIA_NAO_DETERMINAVEL ${arquivo}`);
    return r;
}

/** A árvore: arquivos (ordenados), SHA256SUMS e o hash dela. Externo fora da lista ou import não resolvido recusa. */
function arvore(raiz = path.resolve(__dirname, '..')) {
    const vistos = new Map();
    const fila = [ENTRADA];
    while (fila.length) {
        const f = fila.shift();
        if (vistos.has(f)) continue;
        const texto = lerLF(raiz, f);
        vistos.set(f, texto);
        for (const e of especificadores(texto, f)) {
            if (e.startsWith('node:')) continue;
            if (!e.startsWith('.')) {
                const pacote = e.startsWith('@') ? e.split('/').slice(0, 2).join('/') : e.split('/')[0];
                if (!EXTERNOS.includes(pacote)) throw new Error(`EXTERNO_FORA_DA_LISTA ${pacote} em ${f}`);
                continue;
            }
            const r = resolver(raiz, f, e);
            if (!r) throw new Error(`IMPORT_NAO_RESOLVIDO ${e} em ${f}`);
            fila.push(r);
        }
    }
    vistos.set('package.json', PACKAGE_JSON);
    const arquivos = [...vistos.keys()].sort().map((arquivo) => {
        if (!/^[A-Za-z0-9_./-]+$/.test(arquivo)) throw new Error(`CAMINHO_INSEGURO ${arquivo}`);
        const b = Buffer.from(vistos.get(arquivo), 'utf8');
        return { arquivo, sha: sha(b), bytes: b.length, conteudo: b };
    });
    // Formato do sha256sum (dois espaços), ordenado: `sha256sum -c SHA256SUMS` confere a árvore inteira.
    const sha256sums = arquivos.map((a) => `${a.sha}  ${a.arquivo}`).join('\n') + '\n';
    return { arquivos, sha256sums, shaArvore: sha(Buffer.from(sha256sums, 'utf8')), entrada: ENTRADA };
}

/** Versões exigidas no serviço: Node do engines do package.json; pg e zod as do node_modules do clone. */
function runtime(raiz = path.resolve(__dirname, '..')) {
    const pkg = JSON.parse(fs.readFileSync(path.join(raiz, 'package.json'), 'utf8'));
    const versao = (p) => JSON.parse(fs.readFileSync(path.join(raiz, 'node_modules', p, 'package.json'), 'utf8')).version;
    return { node: String(pkg.engines?.node ?? ''), pg: versao('pg'), zod: versao('zod') };
}

if (require.main === module) {
    try {
        const a = arvore();
        const rt = runtime();
        console.log(`ARVORE ${a.shaArvore} arquivos=${a.arquivos.length} bytes=${a.arquivos.reduce((t, x) => t + x.bytes, 0)} node=${rt.node} pg=${rt.pg} zod=${rt.zod}`);
    }
    catch (e) { console.error(`RECUSADO ${String(e?.message ?? e).slice(0, 200)}`); process.exitCode = 1; }
}

module.exports = { ENTRADA, EXTERNOS, PACKAGE_JSON, arvore, runtime, especificadores };
