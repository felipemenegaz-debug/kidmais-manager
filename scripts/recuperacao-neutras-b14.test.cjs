/* eslint-disable @typescript-eslint/no-require-imports */
// B-14, D-HML-1 = B (Felipe, 28/10/2026): as migrations do prefixo de homologação PH são NEUTRAS para a árvore do B-14.
// Prova estática, sem banco: o conteúdo de cada arquivo está fixado por sha (LF); sem comentários, nenhuma instrução
// altera, indexa, dá gatilho, regra, política ou permissão a uma tabela que a árvore lê ou grava; funções criadas ou
// substituídas não aparecem na árvore; a única ligação admitida é REFERENCES (chave estrangeira de tabela NOVA) para uma
// tabela da qual a árvore nunca apaga linhas nem muda o id. Arquivo mudou → este teste reprova e a neutralidade é revista.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { arvore } = require('./arvore-recuperacao-b14.cjs');

const raiz = path.resolve(__dirname, '..');
const FIXADOS = Object.freeze({
    '102': '27de259d274f2d814b3f219ecd7fdb1db62a25c3b09d09b02a376216c8230c69',
    '103': '990e48a02de32a68d0cb84b74e5e086db229131eea296a2bc7f29128f7b8634c',
    '104': '9802e07e029bfa5a8f4594c032107531df50dcd59388258369dff9c5a6d9f330',
    '105': 'e1ddedd8d18e82e88b37fbea7620dac310f4affdaf65ef053cda0c5394dbfb2c',
    '106': '6d012b991a5e116dbd41908f4d5006e5be98c1bc617486bb8695b5fc34979e88',
});
const ID = '(?:"?public"?\\.)?"?([a-z_][a-z0-9_]*)"?';
/** Comentários (-- e /* *\/) e literais de texto fora: só o código SQL conta. Corpos $$ ficam (podem ter DML). */
const semComentarios = (sql) => sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ').replace(/'(?:[^']|'')*'/g, "''");
const todos = (re, t) => [...t.matchAll(re)].map((m) => m[1].toLowerCase());

function tocadas(sql) {
    const t = semComentarios(sql);
    const altera = [
        ...todos(new RegExp(`\\bALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?${ID}`, 'gi'), t),
        ...todos(new RegExp(`\\bINSERT\\s+INTO\\s+${ID}`, 'gi'), t),
        ...todos(new RegExp(`\\bUPDATE\\s+(?:ONLY\\s+)?${ID}\\s+(?:AS\\s+\\w+\\s+|\\w+\\s+)?SET\\b`, 'gi'), t),
        ...todos(new RegExp(`\\bDELETE\\s+FROM\\s+(?:ONLY\\s+)?${ID}`, 'gi'), t),
        ...todos(new RegExp(`\\bTRUNCATE\\s+(?:TABLE\\s+)?(?:ONLY\\s+)?${ID}`, 'gi'), t),
        ...todos(new RegExp(`\\bDROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?${ID}`, 'gi'), t),
        ...todos(new RegExp(`\\bCREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:CONSTRAINT\\s+)?TRIGGER\\s+\\w+[\\s\\S]*?\\bON\\s+${ID}`, 'gi'), t),
        ...todos(new RegExp(`\\bCREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?\\w*\\s*ON\\s+(?:ONLY\\s+)?${ID}`, 'gi'), t),
        ...todos(new RegExp(`\\bCREATE\\s+(?:POLICY|RULE)\\s+\\w+[\\s\\S]*?\\bON\\s+${ID}`, 'gi'), t),
        ...todos(new RegExp(`\\b(?:GRANT|REVOKE)\\s+[\\s\\S]*?\\bON\\s+(?:TABLE\\s+)?${ID}`, 'gi'), t),
    ];
    return {
        altera: [...new Set(altera)],
        criadas: [...new Set(todos(new RegExp(`\\bCREATE\\s+(?:UNLOGGED\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${ID}`, 'gi'), t))],
        referencias: [...new Set(todos(new RegExp(`\\bREFERENCES\\s+${ID}`, 'gi'), t))],
        funcoes: [...new Set(todos(new RegExp(`\\bFUNCTION\\s+${ID}`, 'gi'), t))],
    };
}

/** O que a árvore usa: tabelas em FROM/JOIN/INTO/UPDATE/TABLE e as que ela apaga ou cujo id muda. */
function usoDaArvore() {
    const textos = arvore(raiz).arquivos.map((x) => x.conteudo.toString('utf8'));
    // Os marcadores de presença das neutras (MARCADORES_NEUTROS: só to_regclass/pg_proc por nome) são a única menção
    // admitida; fora desse bloco, nenhum objeto das neutras pode aparecer na árvore.
    const bloco = /export const MARCADORES_NEUTROS[\s\S]*?\}\);/;
    const juntos = textos.join('\n');
    assert.ok(bloco.test(juntos), 'bloco MARCADORES_NEUTROS na árvore');
    const tudo = juntos.replace(bloco, '');
    const tabelas = new Set(todos(/\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+(?:public\.)?([a-z_][a-z0-9_]*)/gi, tudo));
    const apagadas = new Set(todos(/\bDELETE\s+FROM\s+(?:public\.)?([a-z_][a-z0-9_]*)/gi, tudo));
    return { tudo, tabelas, apagadas, idMudado: idMudadoEm(tudo) };
}

/**
 * Tabelas cujo `id` um UPDATE muda, em QUALQUER posição da lista do SET (aprovação do PH, P3: `SET nome = $1, id = $2`
 * escapava), inclusive qualificado (`e.id =`), entre aspas e na forma de tupla (`(nome, id) = (…)`).
 */
function idMudadoEm(texto) {
    const r = new Set();
    const re = /\bUPDATE\s+(?:ONLY\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?(?:\s+(?:AS\s+)?(?!SET\b)\w+)?\s+SET\b([\s\S]*?)(?=\bWHERE\b|\bFROM\b|\bRETURNING\b|;|`|$)/gi;
    for (const m of texto.matchAll(re)) {
        const sets = m[2];
        const tupla = [...sets.matchAll(/\(([^()]*)\)\s*=/g)].some((t) => t[1].split(',').some((c) => /^(?:\w+\.)?"?id"?$/i.test(c.trim())));
        if (/(?:^|,)\s*(?:\w+\.)?"?id"?\s*=/i.test(sets) || tupla) r.add(m[1].toLowerCase());
    }
    return r;
}

test('neutras do PH: conteúdo fixado por sha e nenhuma toca o que a árvore do B-14 usa', () => {
    const dir = path.join(raiz, 'database/migrations');
    const uso = usoDaArvore();
    assert.ok(uso.tabelas.has('empresa_assinaturas') && uso.tabelas.has('cobranca_eventos') && uso.tabelas.has('ia_credito_carteiras'), 'oráculo do uso da árvore');
    for (const [n, esperado] of Object.entries(FIXADOS)) {
        const arquivos = fs.readdirSync(dir).filter((f) => new RegExp(`^\\d{8}_${n}_.*\\.sql$`).test(f));
        assert.equal(arquivos.length, 1, `uma migration ${n}`);
        const sql = fs.readFileSync(path.join(dir, arquivos[0]), 'utf8').replace(/\r\n/g, '\n');
        assert.equal(createHash('sha256').update(sql).digest('hex'), esperado, `${arquivos[0]} mudou: rever a neutralidade antes de fixar o sha novo`);
        const t = tocadas(sql);
        assert.deepEqual(t.altera.filter((x) => uso.tabelas.has(x) && !t.criadas.includes(x)), [], `${n} altera tabela da árvore`);
        assert.deepEqual(t.criadas.filter((x) => uso.tabelas.has(x)), [], `${n} cria tabela com nome que a árvore usa`);
        assert.deepEqual(t.funcoes.filter((f) => uso.tudo.includes(f)), [], `${n} cria/substitui função usada pela árvore`);
        for (const r of t.referencias.filter((x) => uso.tabelas.has(x))) {
            assert.equal(uso.apagadas.has(r), false, `${n}: FK para ${r}, da qual a árvore apaga linhas`);
            assert.equal(uso.idMudado.has(r), false, `${n}: FK para ${r}, cujo id a árvore muda`);
        }
    }
});

test('o detector de toque reprova uma migration que mexe na árvore (controle)', () => {
    const uso = usoDaArvore();
    for (const sql of ['ALTER TABLE public.empresa_assinaturas ADD COLUMN x int;', 'CREATE TRIGGER t BEFORE UPDATE ON public.cobranca_eventos FOR EACH ROW EXECUTE FUNCTION f();',
        'CREATE UNIQUE INDEX i ON public.ia_credito_carteiras (empresa_id);', 'INSERT INTO auditoria (acao) VALUES (1);', 'UPDATE empresas SET nome = 1;',
        'REVOKE UPDATE ON TABLE public.empresa_assinaturas FROM PUBLIC;', 'CREATE POLICY p ON public.cobranca_eventos USING (true);']) {
        const t = tocadas(sql);
        assert.ok(t.altera.some((x) => uso.tabelas.has(x)), sql);
    }
    // Mudança de id em qualquer posição do SET (contraexemplo do Astra e vizinhos); outras colunas não contam.
    for (const sql of ['UPDATE empresas SET nome = $1, id = $2 WHERE x', 'UPDATE public.empresas e SET e.id = 1;', 'UPDATE empresas SET "id" = gen_random_uuid();',
        'UPDATE empresas SET (nome, id) = (1, 2);', 'UPDATE empresas SET id = 1'])
        assert.ok(idMudadoEm(sql).has('empresas'), sql);
    for (const sql of ['UPDATE empresas SET nome = $1, empresa_id = $2 WHERE id = $3', 'UPDATE empresas SET valid = 1;', 'UPDATE empresas SET nome = 1 FROM x WHERE x.id = 1;'])
        assert.equal(idMudadoEm(sql).has('empresas'), false, sql);
    // Comentário e literal não contam.
    assert.deepEqual(tocadas("-- ALTER TABLE empresa_assinaturas\n/* UPDATE empresas SET x = 1 */ SELECT 'DELETE FROM empresas';").altera, []);
});
