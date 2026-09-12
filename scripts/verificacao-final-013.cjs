/* eslint-disable @typescript-eslint/no-require-imports */
// Somente SELECT no banco local. Não aplica migrations nem altera dados.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const { Client } = require('pg');
const checkpoint = '.backups/pre-013-20260909-183215';
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
async function main() {
    const baseline = JSON.parse(fs.readFileSync(checkpoint + '/dados-antes.json'));
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    const result = {};
    try {
        await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const after = {};
        for (const table of Object.keys(baseline)) {
            assert.match(table, /^[a-z_]+$/);
            const rows = (await c.query(`SELECT to_jsonb(t)::text AS row FROM public."${table}" t ORDER BY to_jsonb(t)::text`)).rows;
            after[table] = { count: rows.length, sha256: sha(JSON.stringify(rows)) };
        }
        assert.deepEqual(after, baseline, 'Dados anteriores divergentes do checkpoint');
        result.tabelasAnteriores = after;
        const names = ['usuarios_administrativos', 'sessoes_administrativas', 'limites_autenticacao', 'contrato_fluxos', 'contrato_edicoes', 'contrato_documentos', 'contrato_assinaturas', 'contrato_pendencias_financeiras'];
        result.novasTabelas = {};
        for (const name of names) {
            const n = (await c.query('SELECT count(*)::int AS n FROM ' + name)).rows[0].n;
            assert.equal(n, 0);
            result.novasTabelas[name] = n;
        }
        result.colunas = (await c.query(`SELECT table_name,column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' AND table_name=ANY($1) ORDER BY table_name,ordinal_position`, [names])).rows;
        result.constraints = (await c.query(`SELECT conrelid::regclass::text AS tabela,conname,pg_get_constraintdef(oid) AS definicao FROM pg_constraint WHERE conrelid=ANY(SELECT ('public.'||unnest($1::text[]))::regclass) ORDER BY 1,2`, [names])).rows;
        assert(!result.constraints.some(x => x.tabela === 'contrato_assinaturas' && /REFERENCES sessoes_administrativas/.test(x.definicao)));
        result.indices=(await c.query('SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname=$1 AND tablename=ANY($2) ORDER BY 1,2',['public',[...names,'contrato_versoes']])).rows;
        result.triggers=(await c.query(`SELECT c.relname AS tabela,t.tgname,pg_get_triggerdef(t.oid) AS definicao FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal AND c.relname=ANY($1) ORDER BY 1,2`,[[...names,'contrato_versoes']])).rows;
        result.funcoes=(await c.query(`SELECT proname,pg_get_functiondef(oid) AS definicao FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname=ANY($1) ORDER BY 1`,[['kidmais_validar_fluxo_contrato','kidmais_preservar_versao_assinada','kidmais_preservar_edicao_contrato','kidmais_bloquear_mutacao_prova_contrato']])).rows;
        assert.equal(result.funcoes.length,4);
        assert(!result.indices.some(x=>x.indexname==='contrato_versoes_corrente_uk'));
        assert(result.indices.some(x=>x.indexname==='contrato_versoes_em_preparacao_uk'));
        const previousCatalog=JSON.parse(fs.readFileSync(checkpoint+'/catalogo-antes.json'));
        const normalize=rows=>rows.map(x=>JSON.stringify(x)).sort();
        const oldTables=Object.keys(baseline);
        const oldColumns=(await c.query(`SELECT table_name,column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' AND table_name=ANY($1)`,[oldTables])).rows;
        assert.deepEqual(normalize(oldColumns),normalize(previousCatalog.columns),'Colunas das 30 tabelas anteriores divergentes');
        const oldConstraints=(await c.query(`SELECT conrelid::regclass::text AS tabela,conname,pg_get_constraintdef(oid) AS definicao FROM pg_constraint WHERE conrelid=ANY(SELECT ('public.'||unnest($1::text[]))::regclass)`,[oldTables])).rows;
        assert.deepEqual(normalize(oldConstraints.filter(x=>!['contrato_versoes_contrato_id_id_uk','contrato_versoes_validar_fluxo_trg'].includes(x.conname))),normalize(previousCatalog.constraints),'Constraints anteriores divergentes');
        result.catalogoAnteriorConferido=true;
        result.runtimeRole = (await c.query('SELECT current_user AS nome,rolsuper FROM pg_roles WHERE rolname=current_user')).rows[0];
        await c.query('COMMIT');
    }
    finally {
        await c.end();
    }
    const applied = JSON.parse(fs.readFileSync(checkpoint + '/aplicacao-local.json'));
    result.migration013 = sha(fs.readFileSync('database/migrations/20260909_013_autenticacao_contrato.sql'));
    assert.equal(result.migration013, applied.sha256Migration, 'Migration 013 aplicada foi alterada');
    const files = JSON.parse(fs.readFileSync(checkpoint + '/manifesto.json'));
    const old = new Map(files.map(f => [f.path.replaceAll('\\', '/'), f.sha256.toLowerCase()]));
    result.protegidos = {};
    for (const [name, hash] of old) {
        if (/schema_mvp_kidmais\.sql$|012_|^next\.config\.ts$|^next-env\.d\.ts$|^data\/disponibilidade\.json$|^\.env.local$/.test(name)) {
            const current = sha(fs.readFileSync(name));
            assert.equal(current, hash, 'Arquivo protegido mudou: ' + name);
            result.protegidos[name] = current;
        }
    }
    result.arquivos = [];
    function walk(dir = '.') {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (['node_modules', '.next', '.tmp', '.backups', '.git'].includes(entry.name))
                continue;
            const full = path.join(dir, entry.name), relative = full.replaceAll('\\', '/');
            if (entry.isDirectory())
                walk(full);
            else if (!relative.endsWith('.tsbuildinfo')) {
                const hash = sha(fs.readFileSync(full)), before = old.get(relative);
                if (hash !== before)
                    result.arquivos.push({ path: relative, status: before ? 'alterado' : 'novo', sha256: hash });
            }
        }
    }
    walk();
    fs.writeFileSync('.tmp/verificacao-final-013.json', JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ tabelasPreservadas: Object.keys(result.tabelasAnteriores).length, novasTabelasVazias: Object.keys(result.novasTabelas).length, protegidos: Object.keys(result.protegidos), arquivos: result.arquivos.length, runtimeSuperuser: result.runtimeRole.rolsuper }));
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
