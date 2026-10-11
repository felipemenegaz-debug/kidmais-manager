/* eslint-disable @typescript-eslint/no-require-imports */
// Atualização de staging (pacote de 11/10/2026): aplica a 078 (catálogo do buffet por empresa) SOMENTE no banco staging,
// pelo Web Shell do srv-daif418ae00c73e8k2gg, depois de aprovação explícita, do backup conferido e do deploy do código
// compatível. Executa exatamente os arquivos revisados (hash fixado). Ausente → precheck, migration, postcheck; já aplicada
// → apenas o postcheck (leitura). Qualquer falha para (sem repetir). Cada tentativa tem arquivo próprio; as anteriores
// nunca são alteradas nem apagadas. Mesmo desenho do aplicador de 076/077 (migrations-076-077-staging.cjs).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {alvo: alvoEnsaio} = require('./assinatura-staging-ensaio.cjs');
const {SQL_IDENTIDADE, conferirIdentidade, exigirDisco} = require('./conexao-staging.cjs');

const FLAG = '--aplicar-078-autorizado';
const DIR = '/opt/render/project/src/data/atualizacao-staging-20261011';
const BASE = 'migration-078';
const ETAPAS = Object.freeze([
    ['precheck 078', 'database/checks/20261010_078_precheck.sql', '51d2845be5c6b234dcc1357fa483743638c786c7005170686461f78e7e7b7d62'],
    ['migration 078', 'database/migrations/20261010_078_catalogo_buffet_por_empresa.sql', '0b4a16c6c75c3a8dd10220bcdfe6c9548e56dde77c35dcb68974cbdee64dc5cf'],
    ['postcheck 078', 'database/checks/20261010_078_postcheck.sql', '1597d3c9eef855e2c11f020bff0caf90fb5f81f365e0b919cbfde50fe65766b5'],
]);
/** Estado real do schema (leitura): a coluna empresa_id do catálogo só existe depois da 078. */
const SQL_SCHEMA = `SELECT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'buffet_categorias' AND column_name = 'empresa_id') AS m078`;
/** Informativo agregado (leitura), antes e depois: tamanho do catálogo e quantas empresas são donas dele. */
const SQL_CATALOGO = `SELECT (SELECT count(*) FROM buffet_categorias)::int AS categorias, (SELECT count(*) FROM buffet_itens)::int AS itens`;
const SQL_DONOS = `SELECT count(DISTINCT empresa_id)::int AS donos, count(*) FILTER (WHERE empresa_id IS NULL)::int AS sem_dono FROM buffet_categorias`;

/** Conteúdo com quebras de linha normalizadas; recusa qualquer divergência do arquivo revisado. */
function lerRevisado(raiz, arquivo, hash) {
    const sql = fs.readFileSync(path.join(raiz, arquivo), 'utf8').replace(/\r\n/g, '\n');
    assert.equal(createHash('sha256').update(sql, 'utf8').digest('hex'), hash, 'ARQUIVO_DIVERGENTE ' + arquivo);
    return sql;
}

/** Mesma trava do staging (serviço, banco, porta, TLS) do ensaio e do aplicador de 076/077. */
function alvo(env) {
    return alvoEnsaio({...env, ASSINATURA_PLANOS_ATIVOS:'true'});
}

function autorizado(argv) {
    const flags = argv.filter(a => a.startsWith('--'));
    return flags.length === 1 && flags[0] === FLAG;
}

/** Etapas desta tentativa conforme o schema real: nunca reaplica (o precheck também recusa “já aplicada”), sempre confere. */
function planoEtapas(schema) {
    assert.equal(typeof schema?.m078, 'boolean', 'SCHEMA_ILEGIVEL');
    return ETAPAS.filter(([nome]) => !schema.m078 || nome.startsWith('postcheck')).map(([nome]) => nome);
}

/** Arquivos de tentativa existentes, em ordem (o da 1ª tentativa não tem número). */
function arquivosTentativas(dir) {
    if (!fs.existsSync(dir)) return [];
    const n = nome => nome === BASE + '.json' ? 1 : Number(/^migration-078\.tentativa-(\d+)\.json$/.exec(nome)?.[1] ?? NaN);
    return fs.readdirSync(dir).filter(x => Number.isInteger(n(x))).sort((a, b) => n(a) - n(b));
}

/**
 * Nova tentativa só quando TODAS as anteriores pararam comprovadamente antes de qualquer SQL: concluido gravado como
 * false, nenhuma etapa iniciada e falha na conexão/identidade. Qualquer outro estado para para revisão.
 */
function avaliarTentativas(dir) {
    const arquivos = arquivosTentativas(dir);
    const anteriores = arquivos.map(nome => {
        let r; try { r = JSON.parse(fs.readFileSync(path.join(dir, nome), 'utf8')); } catch { r = null; }
        const semEfeito = !!r && r.concluido === false && Array.isArray(r.etapas) && r.etapas.length === 0 && r.falha?.etapa === 'CONEXAO';
        return {arquivo:nome, semEfeito, concluido:r?.concluido ?? null, etapas:Array.isArray(r?.etapas) ? r.etapas.length : null};
    });
    const bloqueio = anteriores.find(t => !t.semEfeito);
    assert.ok(!bloqueio, 'TENTATIVA_ANTERIOR_REVISAR ' + (bloqueio && bloqueio.arquivo));
    const numero = arquivos.length + 1;
    return {anteriores, numero, arquivo:numero === 1 ? BASE + '.json' : `${BASE}.tentativa-${numero}.json`};
}

/** Linhas devolvidas por um arquivo com vários comandos; só os informativos agregados/códigos de empresa dos checks. */
function linhasDe(resultado) {
    return (Array.isArray(resultado) ? resultado : [resultado]).flatMap(x => x.rows ?? []);
}

async function executar({env, dir = DIR, raiz = path.resolve(__dirname, '..'), Client = require('pg').Client, disco = () => exigirDisco()}) {
    const opts = alvo(env);
    disco();
    const sqls = new Map(ETAPAS.map(([nome, arquivo, hash]) => [nome, lerRevisado(raiz, arquivo, hash)]));
    fs.mkdirSync(dir, {recursive:true, mode:0o700});
    const t = avaliarTentativas(dir);
    const arquivo = path.join(dir, t.arquivo);
    const r = {inicio:new Date().toISOString(), pid:process.pid, tentativa:t.numero, anteriores:t.anteriores, etapas:[]};
    // wx: duas execuções simultâneas nunca escrevem no mesmo arquivo; a segunda para aqui.
    fs.writeFileSync(arquivo, JSON.stringify(r, null, 2), {mode:0o600, flag:'wx'});
    const salvar = () => fs.writeFileSync(arquivo, JSON.stringify(r, null, 2), {mode:0o600});
    const db = new Client(opts);
    try {
        await db.connect();
        r.conexao = conferirIdentidade((await db.query(SQL_IDENTIDADE)).rows[0], env); salvar();
        r.schemaAntes = (await db.query(SQL_SCHEMA)).rows[0]; r.plano = planoEtapas(r.schemaAntes);
        r.catalogoAntes = (await db.query(SQL_CATALOGO)).rows[0]; salvar();
        for (const nome of r.plano) {
            r.etapas.push({nome, inicio:new Date().toISOString()}); salvar();
            const linhas = linhasDe(await db.query(sqls.get(nome)));
            // Precheck: empresas que recebem cópia (códigos) e contagens; demais: a última linha informativa.
            const info = nome === 'precheck 078' ? linhas : (linhas.at(-1) ?? null);
            Object.assign(r.etapas.at(-1), {ok:true, fim:new Date().toISOString(), info}); salvar();
        }
        r.schemaDepois = (await db.query(SQL_SCHEMA)).rows[0];
        assert.ok(r.schemaDepois.m078, 'SCHEMA_DEPOIS');
        r.catalogoDepois = {...(await db.query(SQL_CATALOGO)).rows[0], ...(await db.query(SQL_DONOS)).rows[0]};
        r.concluido = true; salvar();
        return {resultado:'PASS', arquivo:t.arquivo, tentativa:t.numero, conexao:r.conexao, schemaAntes:r.schemaAntes,
            catalogoAntes:r.catalogoAntes, catalogoDepois:r.catalogoDepois, etapas:r.etapas.map(e => ({nome:e.nome, ok:e.ok, info:e.info}))};
    } catch (e) {
        await db.query('ROLLBACK').catch(() => {});
        r.falha = {etapa:r.etapas.at(-1)?.nome ?? 'CONEXAO', mensagem:String(e?.message).slice(0, 160)}; r.concluido = false; salvar();
        return {resultado:'FALHA', arquivo:t.arquivo, tentativa:t.numero, falha:r.falha};
    } finally {
        await db.end().catch(() => {});
    }
}

if (require.main === module) {
    if (!autorizado(process.argv.slice(2))) { console.error('AGUARDANDO_AUTORIZACAO_078'); process.exitCode = 1; }
    else executar({env:process.env}).then(s => {
        (s.resultado === 'PASS' ? console.log : console.error)(JSON.stringify(s)); if (s.resultado !== 'PASS') process.exitCode = 2;
    }).catch(e => { console.error(String(e?.message ?? 'RECUSADO').slice(0, 120)); process.exitCode = 1; });
}
module.exports = {ETAPAS, FLAG, BASE, DIR, SQL_SCHEMA, SQL_CATALOGO, SQL_DONOS, alvo, autorizado, lerRevisado, planoEtapas, arquivosTentativas, avaliarTentativas, executar};
