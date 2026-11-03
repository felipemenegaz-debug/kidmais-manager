/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { especificadores, resolver, fecho, objetosDaMigration, citaTabelaEmSql, gatilhos, avaliar, marcadoresDoFonte, main,
    fechoSql, importCalculado, codigosAntigosDoFonte, sha256, caminhosLiterais, blobGit, REVISOES } = require('./b23-prova-base.cjs');

/** B-23b (D-B23-1 = (a)): prova funcional das bases antigas do B-14, sem git (árvores sintéticas) e a evidência de cada entrada. */
const arvore = (mapa) => ({ arquivos: Object.keys(mapa), ler: (f) => mapa[f] });
const MARC = ['assinatura_encerramentos', 'kidmais094_salao_fechamento'];
const BASE = {
    'lib/assinatura/servico.ts': "import { x } from './util';\nimport { db } from '@/lib/db';\nexport const a = x;",
    'lib/assinatura/util.ts': "export * from '../comum/helper';",
    'lib/assinatura/servico.test.ts': "import { y } from '../so-teste/fixture';",
    'lib/comum/helper/index.ts': "import { p } from '../profundo';\nexport const x = p; const q = 'SELECT * FROM assinaturas_cobrancas';",
    'lib/comum/profundo.ts': 'export const p = 1;',
    'lib/db.ts': 'export const db = 1;',
    'lib/so-teste/fixture.ts': 'export const y = 1;',
    'lib/convites/tela.ts': "export const t = 'convites';",
    'components/Painel.tsx': 'export default 1;',
    'scripts/assinatura-paywall-ui.cjs': "require('./regressao-lista.cjs');",
    'scripts/regressao-lista.cjs': 'module.exports = [];',
    'scripts/assinatura-operacao.cjs': "require('./operacao-comum.cjs');",
    'scripts/operacao-comum.cjs': 'module.exports = 1;',
    'scripts/painel-x-ui.cjs': "require('./regressao-lista.cjs');",
    'database/migrations/001_base.sql': 'CREATE TABLE assinaturas_cobrancas (id int);',
};
const comMudanca = (extra) => ({ ...BASE, ...extra });
const rodar = (alterados, ate = BASE, de = BASE) => avaliar({ alterados, arvores: { de: arvore(de), ate: arvore(ate) }, marcadores: MARC });
const regras = (r) => r.violacoes.map((v) => `${v.regra}:${v.arquivo}${v.objeto ? ':' + v.objeto : ''}`).sort();

test('especificadores e resolução: import/export-from/require/import() por literal, alias @/ e index', () => {
    assert.deepEqual(especificadores("import a from './a';\nexport { b } from \"../b\";\nconst c = require('./c');\nawait import('@/d');\nimport './e';").sort(),
        ['../b', './a', './c', './e', '@/d']);
    const existe = (p) => ['lib/x/a.ts', 'lib/y/index.ts', 'lib/z.cjs'].includes(p);
    assert.equal(resolver('lib/x/b.ts', './a', existe), 'lib/x/a.ts');
    assert.equal(resolver('lib/x/b.ts', '@/lib/y', existe), 'lib/y/index.ts');
    assert.equal(resolver('lib/x/b.ts', '../z', existe), 'lib/z.cjs');
    assert.equal(resolver('lib/x/b.ts', 'pg', existe), null, 'pacote não é arquivo do repositório');
});

test('fecho: transitivo a partir das raízes; testes e roteiros de navegador não são caminho', () => {
    const f = fecho(Object.keys(BASE), (p) => BASE[p]);
    for (const p of ['lib/assinatura/servico.ts', 'lib/assinatura/util.ts', 'lib/comum/helper/index.ts', 'lib/comum/profundo.ts', 'lib/db.ts',
        'scripts/assinatura-operacao.cjs', 'scripts/operacao-comum.cjs']) assert.ok(f.has(p), p);
    // Roteiro de navegador que casa com uma raiz (scripts/assinatura-*-ui.cjs) não é semente: o que ele importa fica fora.
    for (const p of ['lib/so-teste/fixture.ts', 'lib/assinatura/servico.test.ts', 'scripts/painel-x-ui.cjs', 'scripts/regressao-lista.cjs',
        'lib/convites/tela.ts']) assert.ok(!f.has(p), p);
});

test('PASS: diff só de UI e de domínio fora do fecho', () => {
    const r = rodar(['components/Painel.tsx', 'lib/convites/tela.ts', 'scripts/regressao-lista.cjs', 'lib/so-teste/fixture.ts']);
    assert.equal(r.resultado, 'PROVA_PASS', JSON.stringify(r.violacoes));
});

test('FALHA: raiz, global e arquivo alcançável (inclusive só pela árvore antiga)', () => {
    assert.deepEqual(regras(rodar(['lib/assinatura/servico.test.ts'])), ['RAIZ:lib/assinatura/servico.test.ts'], 'teste dentro da raiz conta');
    assert.deepEqual(regras(rodar(['package-lock.json'])), ['GLOBAL:package-lock.json']);
    assert.deepEqual(regras(rodar(['lib/comum/helper/index.ts'])), ['FECHO:lib/comum/helper/index.ts'], 'dependência transitiva');
    const profundo = rodar(['lib/comum/profundo.ts']);
    assert.deepEqual(regras(profundo), ['FECHO:lib/comum/profundo.ts'], 'dependência de dependência, fora das raízes');
    assert.equal(profundo.resultado, 'PROVA_FALHOU');
    // Na base nova o import sumiu, mas a antiga alcançava o arquivo: continua violação.
    const ate = comMudanca({ 'lib/assinatura/util.ts': 'export const x = 1;' });
    assert.ok(regras(rodar(['lib/comum/helper/index.ts', 'lib/assinatura/util.ts'], ate)).includes('FECHO:lib/comum/helper/index.ts'));
});

test('SQL: objetos da migration, sem comentários e sem confundir gatilho com DML', () => {
    const o = objetosDaMigration(`-- UPDATE comentada_fora
/* ALTER TABLE bloco_fora */
ALTER TABLE convites ALTER COLUMN festa_id DROP NOT NULL;
CREATE OR REPLACE FUNCTION convite_validar() RETURNS trigger AS $$ BEGIN RETURN NEW; END $$ LANGUAGE plpgsql;
CREATE TRIGGER t BEFORE INSERT OR UPDATE OF festa_id ON public.convites FOR EACH ROW EXECUTE FUNCTION convite_validar();
CREATE INDEX i ON convites (festa_id);
UPDATE "convite_extra" SET a = 1;`);
    assert.deepEqual(o, { tabelas: ['convite_extra', 'convites'], funcoes: ['convite_validar'] });
    assert.ok(citaTabelaEmSql('const q = `SELECT 1 FROM public.assinaturas_cobrancas WHERE`', 'assinaturas_cobrancas'));
    assert.ok(!citaTabelaEmSql("const texto = 'assinaturas_cobrancas'", 'assinaturas_cobrancas'), 'texto comum não é SQL');
    assert.deepEqual([...gatilhos(['CREATE TRIGGER g AFTER UPDATE ON pagamentos FOR EACH ROW EXECUTE PROCEDURE f_x();']).get('f_x')], ['pagamentos']);
});

test('FALHA SQL: tabela do fecho, função chamada no fecho, gatilho em tabela do fecho e marcador do B-14', () => {
    const mig = 'database/migrations/099_x.sql';
    const sqlTabela = comMudanca({ [mig]: 'ALTER TABLE assinaturas_cobrancas ADD COLUMN y int;' });
    const rTabela = rodar([mig], sqlTabela);
    assert.deepEqual(regras(rTabela), [`SQL_TABELA_NO_FECHO:${mig}:assinaturas_cobrancas`]);
    assert.equal(rTabela.resultado, 'PROVA_FALHOU');
    const sqlFuncao = comMudanca({ [mig]: 'CREATE OR REPLACE FUNCTION calcula_total() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql;',
        'lib/db.ts': "export const db = 'SELECT calcula_total()';" });
    assert.deepEqual(regras(rodar([mig], sqlFuncao)), [`SQL_FUNCAO_NO_FECHO:${mig}:calcula_total`]);
    const sqlGatilho = comMudanca({ [mig]: 'CREATE OR REPLACE FUNCTION guarda() RETURNS trigger AS $$ BEGIN RETURN NEW; END $$ LANGUAGE plpgsql;',
        'database/migrations/050_gatilho.sql': 'CREATE TRIGGER g BEFORE UPDATE ON assinaturas_cobrancas FOR EACH ROW EXECUTE FUNCTION guarda();' });
    assert.deepEqual(regras(rodar([mig], sqlGatilho)), [`SQL_GATILHO_EM_TABELA_DO_FECHO:${mig}:guarda`]);
    const sqlMarcador = comMudanca({ [mig]: 'ALTER TABLE assinatura_encerramentos ADD COLUMN z int;' });
    assert.deepEqual(regras(rodar([mig], sqlMarcador)), [`SQL_MARCADOR:${mig}:assinatura_encerramentos`]);
    const sqlFora = comMudanca({ [mig]: 'ALTER TABLE convites ADD COLUMN w int;' });
    assert.equal(rodar([mig], sqlFora).resultado, 'PROVA_PASS', 'migration fora da cobrança');
});

// Rodada 2 (Astra, B-23b r1: 3 P2): entradas de cobrança que só CHAMAM as raízes, migrations nas duas árvores e fecho SQL
// transitivo (gatilho → função auxiliar, função → função, função → tabela).
test('P2-1: entradas de cobrança são raízes; proxy.ts é global; quem importa uma raiz é CHAMADOR', () => {
    for (const f of ['lib/desenvolvedor/cobranca.ts', 'app/api/desenvolvedor/empresas/[id]/cobranca/route.ts',
        'app/api/desenvolvedor/empresas/[id]/cobranca/pendencias/route.ts', 'app/api/desenvolvedor/renovacoes/route.ts'])
        assert.deepEqual(regras(rodar([f])), [`RAIZ:${f}`], f);
    assert.deepEqual(regras(rodar(['proxy.ts'])), ['GLOBAL:proxy.ts']);
    const chamador = comMudanca({ 'app/api/admin/painel/route.ts': "import { a } from '@/lib/assinatura/servico';" });
    const r = rodar(['app/api/admin/painel/route.ts'], chamador);
    assert.deepEqual(regras(r), ['CHAMADOR:app/api/admin/painel/route.ts']);
    assert.equal(r.resultado, 'PROVA_FALHOU');
    // Só na árvore antiga também conta (o arquivo deixou de chamar, mas a mudança é na entrada).
    assert.deepEqual(regras(rodar(['app/api/admin/painel/route.ts'], BASE, chamador)), ['CHAMADOR:app/api/admin/painel/route.ts']);
});

// Rodada 3 (Astra, P2-R2-01): não há exceção por leitura — importar só `lerEstadoComercial` não libera o chamador, porque o
// resto do arquivo pode escrever na cobrança. O chamador só passa com revisão do delta completo fixada ao par de blobs.
test('P2-R2-01: chamador de leitura comercial continua CHAMADOR; revisão fixada aos blobs, inclusive arquivo novo', () => {
    const f = 'lib/convites/servico.ts';
    const leitura = "import { lerEstadoComercial } from '../assinatura/estado';\nexport const s = 1;";
    const ate = comMudanca({ 'lib/assinatura/estado.ts': 'export async function lerEstadoComercial() { return 1; }', [f]: leitura });
    const r = rodar([f], ate);
    assert.deepEqual(regras(r), [`CHAMADOR:${f}`]);
    assert.equal(r.resultado, 'PROVA_FALHOU');
    assert.equal(r.violacoes[0].importa, 'lib/assinatura/estado.ts');
    const rev = { regra: 'CHAMADOR', arquivo: f, de: null, ate: blobGit(leitura), autoria: 'teste', analise: 'teste' };
    REVISOES.push(rev);
    try {
        const ok = rodar([f], ate);
        assert.equal(ok.resultado, 'PROVA_PASS', JSON.stringify(ok.violacoes));
        assert.deepEqual(ok.revisados, [{ regra: 'CHAMADOR', arquivo: f, importa: 'lib/assinatura/estado.ts', arvore: 'ate',
            de: null, ate: rev.ate, autoria: 'teste', analise: 'teste' }]);
        // A contraprova do Astra: uma escrita comercial junto da leitura muda o blob e volta a ser CHAMADOR.
        const escrita = leitura.replace('export const s = 1;', "await tx.query('UPDATE empresa_assinaturas SET versao = versao + 1');\nexport const s = 1;");
        assert.deepEqual(regras(rodar([f], comMudanca({ ...ate, [f]: escrita }))), [`CHAMADOR:${f}`]);
        // Mesmo conteúdo, mas o arquivo já existia em de: o par (de, ate) não confere.
        assert.deepEqual(regras(rodar([f], ate, comMudanca({ [f]: '// antes' }))), [`CHAMADOR:${f}`]);
        // A revisão é por regra: a mesma revisão não libera FECHO.
        assert.deepEqual(regras(rodar([f], comMudanca({ ...ate, 'lib/assinatura/servico.ts': "import { s } from '../convites/servico';" }))), [`FECHO:${f}`]);
    } finally { REVISOES.pop(); }
});

test('estrutural: produção do fecho que importa teste/roteiro falha em vez de parar o fecho', () => {
    const ate = comMudanca({ 'lib/assinatura/servico.ts': "import { x } from './util';\nimport { z } from './apoio.test-apoio.cjs';",
        'lib/assinatura/apoio.test-apoio.cjs': 'module.exports = {};' });
    const r = rodar(['components/Painel.tsx'], ate);
    assert.deepEqual(regras(r), ['FECHO_IMPORTA_TESTE:lib/assinatura/servico.ts']);
    assert.equal(r.resultado, 'PROVA_FALHOU');
});

test('P2-2: migration removida ou esvaziada conta pelo conteúdo antigo', () => {
    const mig = 'database/migrations/060_cobranca.sql';
    const de = comMudanca({ [mig]: 'ALTER TABLE assinaturas_cobrancas ADD COLUMN z int;' });
    const removida = rodar([mig], BASE, de);
    assert.deepEqual(regras(removida), [`SQL_TABELA_NO_FECHO:${mig}:assinaturas_cobrancas`]);
    assert.equal(removida.resultado, 'PROVA_FALHOU');
    assert.deepEqual(regras(rodar([mig], comMudanca({ [mig]: 'SELECT 1;' }), de)), [`SQL_TABELA_NO_FECHO:${mig}:assinaturas_cobrancas`]);
    // Gatilho que só existia na árvore antiga ainda liga a função à tabela do fecho.
    const fn = 'database/migrations/099_fn.sql', gat = 'database/migrations/050_gatilho.sql';
    const deG = comMudanca({ [gat]: 'CREATE TRIGGER g BEFORE UPDATE ON assinaturas_cobrancas FOR EACH ROW EXECUTE FUNCTION guarda();' });
    const ateG = comMudanca({ [fn]: 'CREATE OR REPLACE FUNCTION guarda() RETURNS trigger AS $$ BEGIN RETURN NEW; END $$ LANGUAGE plpgsql;' });
    assert.deepEqual(regras(rodar([fn, gat], ateG, deG)), [`SQL_GATILHO_EM_TABELA_DO_FECHO:${fn}:guarda`, `SQL_TABELA_NO_FECHO:${gat}:assinaturas_cobrancas`]);
});

test('P2-3: fecho SQL transitivo — gatilho → auxiliar, função → função, função → tabela, gatilho dinâmico', () => {
    const gat = 'database/migrations/050_gatilho.sql', mig = 'database/migrations/099_x.sql';
    const SQL050 = `CREATE TABLE historico (id int);
CREATE OR REPLACE FUNCTION guarda() RETURNS trigger AS $$ BEGIN PERFORM auxiliar(NEW.id); RETURN NEW; END $$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION auxiliar(i int) RETURNS void AS $f$ BEGIN INSERT INTO historico VALUES (i); PERFORM mais_fundo(); END $f$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION mais_fundo() RETURNS void AS $$ SELECT 1 $$ LANGUAGE sql;
CREATE TRIGGER g BEFORE UPDATE ON assinaturas_cobrancas FOR EACH ROW EXECUTE FUNCTION guarda();`;
    const arv = (sql) => comMudanca({ [gat]: SQL050, [mig]: sql });
    const r1 = rodar([mig], arv('CREATE OR REPLACE FUNCTION auxiliar(i int) RETURNS void AS $$ SELECT 1 $$ LANGUAGE sql;'));
    assert.deepEqual(regras(r1), [`SQL_FUNCAO_NO_FECHO:${mig}:auxiliar`]);
    assert.equal(r1.violacoes[0].motivo, 'chamada por guarda');
    assert.equal(r1.resultado, 'PROVA_FALHOU');
    assert.deepEqual(regras(rodar([mig], arv('CREATE OR REPLACE FUNCTION mais_fundo() RETURNS void AS $$ SELECT 2 $$ LANGUAGE sql;'))),
        [`SQL_FUNCAO_NO_FECHO:${mig}:mais_fundo`]);
    const r3 = rodar([mig], arv('ALTER TABLE historico ADD COLUMN y int;'));
    assert.deepEqual(regras(r3), [`SQL_TABELA_NO_FECHO:${mig}:historico`]);
    assert.equal(r3.violacoes[0].motivo, 'usada por auxiliar');
    const din = "DO $$ BEGIN EXECUTE format('CREATE TRIGGER p BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION protege()', 't'); END $$;";
    const r4 = rodar([mig], comMudanca({ [gat]: din, [mig]: 'CREATE OR REPLACE FUNCTION protege() RETURNS trigger AS $$ BEGIN RETURN NEW; END $$ LANGUAGE plpgsql;' }));
    assert.deepEqual(regras(r4), [`SQL_GATILHO_EM_TABELA_DO_FECHO:${mig}:protege`]);
    const s = fechoSql({ fontes: [{ f: 'a.ts', s: 'SELECT * FROM assinaturas_cobrancas' }], marcadores: [], migrations: [BASE['database/migrations/001_base.sql'], SQL050] });
    assert.deepEqual([...s.funcoes.keys()].sort(), ['auxiliar', 'guarda', 'mais_fundo']);
    assert.deepEqual([...s.tabelas.keys()].sort(), ['assinaturas_cobrancas', 'historico']);
});

test('limites: import calculado no fecho e SQL dinâmico em função protegida aparecem para a revisão', () => {
    assert.ok(importCalculado('const m = require(caminho);'));
    assert.ok(!importCalculado("const m = require('./x'); // require(caminho)"));
    const ate = comMudanca({ 'lib/comum/profundo.ts': 'export const p = require(nomeDoModulo);',
        'database/migrations/050_f.sql': "CREATE OR REPLACE FUNCTION calcula() RETURNS void AS $$ BEGIN EXECUTE format('SELECT 1'); END $$ LANGUAGE plpgsql;",
        'lib/db.ts': "export const db = 'SELECT calcula()';" });
    const r = rodar(['components/Painel.tsx'], ate);
    assert.equal(r.resultado, 'PROVA_PASS');
    assert.deepEqual(r.limites, { importsCalculados: ['lib/comum/profundo.ts'], sqlDinamico: ['calcula'], funcoesSemCorpo: [] });
});

test('import calculado: caminho literal do repositório entra no fecho; revisão vale só para o par exato de blobs', () => {
    const ensaio = 'scripts/assinatura-ensaio.cjs', inv = 'scripts/production/inventario.mjs';
    const calc = "const { lista } = await import(pathToFileURL(path.join(raiz, 'scripts/production/inventario.mjs')).href);";
    const de = comMudanca({ [ensaio]: calc, [inv]: 'export const lista = [1];' });
    const ate = comMudanca({ [ensaio]: calc, [inv]: 'export const lista = [1, 2];' });
    assert.deepEqual(caminhosLiterais(calc, (p) => p === inv), [inv]);
    assert.ok(fecho(Object.keys(ate), (p) => ate[p]).has(inv), 'import calculado com literal vira aresta');
    const r = rodar([inv], ate, de);
    assert.deepEqual(regras(r), [`FECHO:${inv}`]);
    assert.equal(r.resultado, 'PROVA_FALHOU');
    // Com a revisão registrada para ESTE par de blobs, vira `revisados`; qualquer outra versão volta a falhar.
    const rev = { regra: 'FECHO', arquivo: inv, de: blobGit(de[inv]), ate: blobGit(ate[inv]), autoria: 'teste', analise: 'teste' };
    REVISOES.push(rev);
    try {
        const ok = rodar([inv], ate, de);
        assert.equal(ok.resultado, 'PROVA_PASS', JSON.stringify(ok.violacoes));
        assert.deepEqual(ok.revisados, [{ regra: 'FECHO', arquivo: inv, de: rev.de, ate: rev.ate, autoria: 'teste', analise: 'teste' }]);
        const outra = comMudanca({ [ensaio]: calc, [inv]: 'export const lista = [1, 2, 3];' });
        assert.deepEqual(regras(rodar([inv], outra, de)), [`FECHO:${inv}`]);
    } finally { REVISOES.pop(); }
    assert.equal(blobGit('a\n'), '78981922613b2afb6025042ff6bd878ac1994e85', 'mesmo sha1 de blob do git');
    assert.deepEqual(regras(rodar(['scripts/init-staging-data.cjs'])), ['GLOBAL:scripts/init-staging-data.cjs']);
});

// B-23c (D-B23c-1 = (A)): RAIZ e as regras SQL de fecho passam a aceitar revisão nominal; GLOBAL, SQL_MARCADOR e
// FECHO_IMPORTA_TESTE nunca. Na regra SQL a revisão também é presa ao objeto.
test('B-23c: RAIZ e SQL revisáveis só pelo par exato (e pelo objeto); GLOBAL e SQL_MARCADOR nunca', () => {
    const raiz = 'lib/assinatura/novo.ts';
    const ate = comMudanca({ [raiz]: 'export const n = 1;' });
    assert.deepEqual(regras(rodar([raiz], ate)), [`RAIZ:${raiz}`], 'sem revisão');
    const mig = 'database/migrations/099_x.sql';
    const sqlT = comMudanca({ [mig]: 'ALTER TABLE assinaturas_cobrancas ADD COLUMN y int;' });
    const sqlG = comMudanca({ [mig]: 'CREATE OR REPLACE FUNCTION guarda() RETURNS trigger AS $$ BEGIN RETURN NEW; END $$ LANGUAGE plpgsql;',
        'database/migrations/050_gatilho.sql': 'CREATE TRIGGER g BEFORE UPDATE ON assinaturas_cobrancas FOR EACH ROW EXECUTE FUNCTION guarda();' });
    const sqlF = comMudanca({ [mig]: 'CREATE OR REPLACE FUNCTION calcula_total() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql;',
        'lib/db.ts': "export const db = 'SELECT calcula_total()';" });
    const rev = (regra, arquivo, objeto, ateBlob) => ({ regra, arquivo, ...(objeto ? { objeto } : {}), de: null, ate: ateBlob, autoria: 't', analise: 't' });
    const revs = [
        rev('RAIZ', raiz, null, blobGit(ate[raiz])),
        rev('SQL_TABELA_NO_FECHO', mig, 'assinaturas_cobrancas', blobGit(sqlT[mig])),
        rev('SQL_GATILHO_EM_TABELA_DO_FECHO', mig, 'guarda', blobGit(sqlG[mig])),
        rev('SQL_FUNCAO_NO_FECHO', mig, 'calcula_total', blobGit(sqlF[mig])),
    ];
    const n = REVISOES.length;
    REVISOES.push(...revs);
    try {
        const ok = rodar([raiz], ate);
        assert.equal(ok.resultado, 'PROVA_PASS', JSON.stringify(ok.violacoes));
        assert.deepEqual(ok.revisados.map((v) => `${v.regra}:${v.arquivo}:${v.de}:${v.ate}`), [`RAIZ:${raiz}:null:${revs[0].ate}`]);
        assert.deepEqual(regras(rodar([raiz], comMudanca({ [raiz]: 'export const n = 2;' }))), [`RAIZ:${raiz}`], 'outro blob ate');
        assert.deepEqual(regras(rodar([raiz], ate, comMudanca({ [raiz]: '// antes' }))), [`RAIZ:${raiz}`], 'arquivo já existia em de');
        for (const [arv, objeto] of [[sqlT, 'assinaturas_cobrancas'], [sqlG, 'guarda'], [sqlF, 'calcula_total']]) {
            const r = rodar([mig], arv);
            assert.equal(r.resultado, 'PROVA_PASS', JSON.stringify(r.violacoes));
            assert.deepEqual(r.revisados.map((v) => v.objeto), [objeto]);
        }
        // Migration alterada: outro blob volta a violar.
        assert.deepEqual(regras(rodar([mig], comMudanca({ [mig]: 'ALTER TABLE assinaturas_cobrancas ADD COLUMN q int;' }))),
            [`SQL_TABELA_NO_FECHO:${mig}:assinaturas_cobrancas`]);
    } finally { REVISOES.length = n; }
    // Objeto trocado (mesmo arquivo e par de blobs): não libera.
    REVISOES.push({ ...revs[1], objeto: 'assinaturas_pagamentos' });
    try { assert.deepEqual(regras(rodar([mig], sqlT)), [`SQL_TABELA_NO_FECHO:${mig}:assinaturas_cobrancas`]); }
    finally { REVISOES.length = n; }
    // Regra trocada: a revisão de tabela não libera a de função no mesmo par.
    REVISOES.push({ ...revs[3], regra: 'SQL_TABELA_NO_FECHO' });
    try { assert.deepEqual(regras(rodar([mig], sqlF)), [`SQL_FUNCAO_NO_FECHO:${mig}:calcula_total`]); }
    finally { REVISOES.length = n; }
    // Regra RAIZ não libera FECHO do mesmo arquivo, e vice-versa.
    const fechoArq = 'lib/comum/profundo.ts';
    const fechoAte = comMudanca({ [fechoArq]: 'export const p = 2;' });
    REVISOES.push(rev('RAIZ', fechoArq, null, blobGit(fechoAte[fechoArq])), rev('FECHO', raiz, null, blobGit(ate[raiz])));
    REVISOES[n].de = blobGit(BASE[fechoArq]);
    try {
        assert.deepEqual(regras(rodar([fechoArq], fechoAte)), [`FECHO:${fechoArq}`]);
        assert.deepEqual(regras(rodar([raiz], ate)), [`RAIZ:${raiz}`]);
    } finally { REVISOES.length = n; }
    // Não revisáveis, mesmo com entrada casando regra, caminho, objeto e blobs.
    const marc = comMudanca({ [mig]: 'ALTER TABLE assinatura_encerramentos ADD COLUMN z int;' });
    const pkg = comMudanca({ 'package-lock.json': '{}' });
    const imp = 'lib/comum/profundo.ts';
    const impAte = comMudanca({ [imp]: "import { y } from '../so-teste/fixture.test-apoio.cjs';", 'lib/so-teste/fixture.test-apoio.cjs': '' });
    REVISOES.push(rev('SQL_MARCADOR', mig, 'assinatura_encerramentos', blobGit(marc[mig])), rev('GLOBAL', 'package-lock.json', null, blobGit('{}')),
        { ...rev('FECHO_IMPORTA_TESTE', imp, null, blobGit(impAte[imp])), de: blobGit(BASE[imp]) }, { ...rev('FECHO', imp, null, blobGit(impAte[imp])), de: blobGit(BASE[imp]) });
    try {
        assert.deepEqual(regras(rodar([mig], marc)), [`SQL_MARCADOR:${mig}:assinatura_encerramentos`]);
        assert.deepEqual(regras(rodar(['package-lock.json'], pkg)), ['GLOBAL:package-lock.json']);
        // A revisão FECHO do arquivo sai em revisados, mas o import de apoio de teste continua violação.
        const ri = rodar([imp], impAte);
        assert.deepEqual(regras(ri), [`FECHO_IMPORTA_TESTE:${imp}`]);
        assert.deepEqual(ri.revisados.map((v) => v.regra), ['FECHO']);
    } finally { REVISOES.length = n; }
});

test('revisões registradas: só os pares revisados (B-23b: 3; B-23c: 21), com autoria', () => {
    const chave = (x) => `${x.regra}:${x.arquivo}:${x.objeto ?? ''}:${x.de}:${x.ate}`;
    assert.deepEqual(REVISOES.map(chave), [
        'FECHO:scripts/production/check-migrations.mjs::0ebac5771a06ca5e70eb277e011838f31ec48db1:06d817620e89c00e4ace0a8fd70afabdc12a81b9',
        'CHAMADOR:lib/convites/service.ts::5d70a0ac5ebf2d3dbbb2592661ec405829d738a0:a77cf5f311ca2cdf4e9f486a36734c36baf14cf1',
        'CHAMADOR:lib/convites/biblioteca.ts::null:a83603cd11088d454e84bb0a579930b7472c4eff',
        'CHAMADOR:lib/site/catalogo.ts::f282886a9bbdca6ab5f07026c177768e8b102a2e:a650bd167dec9c22f2ef590a590e30ae03478605',
        'FECHO:scripts/production/check-migrations.mjs::0ebac5771a06ca5e70eb277e011838f31ec48db1:0fd96b6d36caeb1d0210ab78bb96625fb0ad4791',
        'RAIZ:lib/assinatura/aplicador-087.postgres.test.ts::null:019871354cea2cc0884511f4dd05a6f1f8b26894',
        'RAIZ:lib/assinatura/avisos-087.postgres.test.ts::null:2819c6054a87726eae1913f072a19c9d5044c3e8',
        'RAIZ:lib/assinatura/avisos-envio.test.ts::null:e97a42cfc487c97e937f48ecb69d229f2dd7749d',
        'RAIZ:lib/assinatura/avisos-mensagens.test.ts::null:b72c2b69b8d3e49228301ce7894011dbd612bccc',
        'RAIZ:lib/assinatura/avisos-repositorio.test.ts::null:7895fb100c805264eb10d64a3d58c39f7c687a87',
        'RAIZ:lib/assinatura/avisos.test.ts::null:eee7dc800f313aacdc42de5926c8a209c4c24e57',
        'RAIZ:lib/assinatura/migration-087.test.ts::null:bfe3d7d7269385eede69b19672a17512ee11431e',
        'RAIZ:scripts/assinatura-avisos.test.cjs::null:4a68b8b55cff509a83792010adbea301c626aef3',
        'RAIZ:lib/assinatura/avisos.ts::null:b212898f36e49b05d899c55bca38d5c84419df96',
        'RAIZ:lib/assinatura/avisos-envio.ts::null:7f9104a6f649f52acf8790e6cf8139c1cef58ff7',
        'RAIZ:lib/assinatura/avisos-mensagens.ts::null:cd35b89844e1846d70cba8a6c040e73e2fc2a604',
        'RAIZ:lib/assinatura/avisos-padrao.ts::null:fc490ec176c73c325250f219b9e7f33e1b405ca9',
        'RAIZ:lib/assinatura/avisos-repositorio.ts::null:e01a8fab5520d33c2532e5f2ef22adc164316600',
        'RAIZ:lib/assinatura/cobranca-padrao.ts::b5957da5e0deab0e9a812b3cda06857a620b9a96:f5df456506eb0d4e239a6160c3a8f0d9a9d2c0e6',
        'RAIZ:lib/assinatura/renovacao-entrega.ts::aa0949d91dc2802af09a5aa113c32cfde5381c23:a02bba2bf3941f0cc8f4f7823e1d5b5d08acbb16',
        'RAIZ:lib/assinatura/sincronizacao.ts::4fcaf7dbd4368071c425b2e9a1bf2ccc94e2fdf8:410f97a3124663bf631ea394b620c767a93e0051',
        'RAIZ:scripts/assinatura-avisos.cjs::null:e1aff377acbd3067dc1cf7a0e0ac8074ca4fb376',
        'SQL_TABELA_NO_FECHO:database/migrations/20261019_087_assinatura_avisos.sql:assinatura_avisos:null:b9a818d3f59f8f6cd3d217e9a8fc066de4ff4840',
        'SQL_GATILHO_EM_TABELA_DO_FECHO:database/migrations/20261019_087_assinatura_avisos.sql:kidmais_087_aviso_guarda:null:b9a818d3f59f8f6cd3d217e9a8fc066de4ff4840',
    ], 'revisão nova = entrada revisada pelo Astra');
    for (const r of REVISOES) assert.ok(/^Revisão por agente: /.test(r.autoria) && r.analise.length > 80, r.arquivo);
    for (const r of REVISOES.slice(3)) assert.match(r.autoria, /B-23c/, r.arquivo);
    for (const r of REVISOES) assert.ok(r.objeto === undefined || r.regra.startsWith('SQL_'), `objeto só em SQL: ${r.arquivo}`);
    // As que dependem da trava dizem isso na análise (proveniência; a barreira é a guarda AVISOS_EMAIL_LIGADOS).
    for (const f of ['lib/assinatura/sincronizacao.ts', 'lib/assinatura/avisos-repositorio.ts'])
        assert.match(REVISOES.find((r) => r.arquivo === f).analise, /AVISOS_EMAIL_LIGADOS/, f);
});

test('marcadores lidos do fonte do B-14 e uso inválido do CLI', () => {
    const fonte = fs.readFileSync(path.join(__dirname, '../lib/assinatura/recuperacao-execucao.ts'), 'utf8');
    const m = marcadoresDoFonte(fonte);
    assert.equal(m.length, 8);
    assert.ok(m.includes('assinatura_encerramentos') && m.includes('kidmais094_salao_fechamento'));
    assert.equal(main([]).codigo, 2);
    assert.equal(main(['--de=abc', '--ate=def']).codigo, 2);
    assert.equal(main(['--verificar-lista', '--de=abc']).codigo, 2);
});

test('evidência: cada base antiga além da homologada tem a prova PASS guardada, contra 00d3019a', () => {
    // Literal da fonte, não um import: a lista e a evidência são conferidas uma contra a outra.
    const fonte = fs.readFileSync(path.join(__dirname, '../lib/assinatura/recuperacao-execucao.ts'), 'utf8');
    const lista = codigosAntigosDoFonte(fonte);
    assert.equal(lista[0], '00d3019ade199ce609eab296050e07f4b379e87b', 'a primeira é a base homologada');
    assert.equal(lista.length, 5, 'B-23c: 00d3019a, 4ef9adb6, 5bdd5ac4, 7329cbfe, 5e4340db');
    // Vínculo com a versão: a evidência foi gerada por ESTE analisador e com ESTES marcadores (a reprodução é do job
    // b23-bases do CI, `--verificar-lista`, que tem o histórico).
    const analisador = sha256(fs.readFileSync(path.join(__dirname, 'b23-prova-base.cjs'), 'utf8'));
    const marcadoresSha = sha256(marcadoresDoFonte(fonte).join('\n'));
    for (const sha of lista.slice(1)) {
        const arq = path.join(__dirname, '../docs/evidencias/b23-bases-antigas', `prova-${sha}.json`);
        assert.ok(fs.existsSync(arq), `evidência ausente para ${sha}`);
        const p = JSON.parse(fs.readFileSync(arq, 'utf8'));
        assert.equal(p.de, lista[0], sha);
        assert.equal(p.ate, sha);
        assert.equal(p.analisador, analisador, `${sha}: evidência de outra versão do analisador`);
        assert.equal(p.marcadoresSha, marcadoresSha, `${sha}: evidência com outros marcadores`);
        assert.equal(p.resultado, 'PROVA_PASS', sha);
        assert.deepEqual(p.violacoes, [], sha);
        assert.ok(p.fecho.de > 0 && p.fecho.ate > 0, 'o fecho foi calculado');
    }
});
