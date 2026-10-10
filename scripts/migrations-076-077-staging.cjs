/* eslint-disable @typescript-eslint/no-require-imports */
// O3 da homologação de 10/10/2026: aplica 076 e 077 SOMENTE no banco staging, pelo Web Shell do srv-daif418ae00c73e8k2gg,
// depois de aprovação explícita e do backup conferido. Executa exatamente os arquivos revisados (hash fixado).
// Ordem: precheck 076 → 076 → postcheck 076 → precheck 077 → 077 → postcheck 077. Qualquer falha para (sem repetir).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {alvo: alvoEnsaio} = require('./assinatura-staging-ensaio.cjs');

const FLAG = '--aplicar-076-077-autorizado';
const DIR = '/opt/render/project/src/data/homologacao-planos-cotacao-20261010';
const ETAPAS = Object.freeze([
    ['precheck 076', 'database/checks/20261010_076_precheck.sql', '0c57d854e02a59e23003463fc9e501d4fec1f2309a6fe91c7a557fa5f52c3392'],
    ['migration 076', 'database/migrations/20261010_076_cpf_por_empresa.sql', '10c7c051e14024cc4971af3f77237862a35020c8d55b3417b228ba2421838392'],
    ['postcheck 076', 'database/checks/20261010_076_postcheck.sql', '8797783354e0fcc56323c97e5b615f1479e1d3c9cd054cfb95958f25113b71aa'],
    ['precheck 077', 'database/checks/20261010_077_precheck.sql', 'ab24f9ee4a217f92372d0645a150da77a549d19f495cf7b0826fe25a482b1a21'],
    ['migration 077', 'database/migrations/20261010_077_regras_pagamento_empresa.sql', 'afb6bab309168fa7f2e277ba2195eda5dfb15bf6516263b33eb99b3db0b132a8'],
    ['postcheck 077', 'database/checks/20261010_077_postcheck.sql', '812fb322fd367441f795b0de8a558f157a7b041aeb13ad725a1f7d6dd93ad3fd'],
]);

/** Conteúdo com quebras de linha normalizadas; recusa qualquer divergência do arquivo revisado. */
function lerRevisado(raiz, arquivo, hash) {
    const sql = fs.readFileSync(path.join(raiz, arquivo), 'utf8').replace(/\r\n/g, '\n');
    assert.equal(createHash('sha256').update(sql, 'utf8').digest('hex'), hash, 'ARQUIVO_DIVERGENTE ' + arquivo);
    return sql;
}

/** Mesma trava do staging (serviço, banco, porta, TLS), sem exigir chaves de O1. */
function alvo(env) {
    return alvoEnsaio({...env, ASSINATURA_PLANOS_ATIVOS:'true'});
}

function autorizado(argv) {
    const flags = argv.filter(a => a.startsWith('--'));
    return flags.length === 1 && flags[0] === FLAG;
}

async function main() {
    const opts = alvo(process.env);
    const raiz = path.resolve(__dirname, '..');
    const sqls = ETAPAS.map(([nome, arquivo, hash]) => [nome, lerRevisado(raiz, arquivo, hash)]);
    fs.mkdirSync(DIR, {recursive:true, mode:0o700});
    const arquivo = DIR + '/migrations-076-077.json';
    assert.ok(!fs.existsSync(arquivo), 'EXECUCAO_EXISTENTE_REVISAR');
    const r = {inicio:new Date().toISOString(), etapas:[]};
    const salvar = () => fs.writeFileSync(arquivo, JSON.stringify(r, null, 2), {mode:0o600}); salvar();
    const {Client} = require('pg');
    const db = new Client(opts);
    try {
        await db.connect();
        const id = (await db.query("SELECT current_database() AS db, (SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()) AS tls")).rows[0];
        assert.equal(id.db, 'kidmais_staging_1z91', 'BANCO'); assert.equal(id.tls, true, 'TLS');
        for (const [nome, sql] of sqls) {
            r.etapas.push({nome, inicio:new Date().toISOString()}); salvar();
            const resultado = await db.query(sql);
            // Só a linha informativa agregada dos checks (contagens/booleanos); nunca dados de clientes.
            const linhas = (Array.isArray(resultado) ? resultado : [resultado]).flatMap(x => x.rows ?? []);
            Object.assign(r.etapas.at(-1), {ok:true, fim:new Date().toISOString(), info:linhas.at(-1) ?? null}); salvar();
        }
        // Informativo (só leitura): a empresa do endereço público atual de staging tem regra de pagamento após a 077?
        const empresaAtual = /^[0-9a-f-]{36}$/i.test(process.env.AGENDA_PUBLICA_EMPRESA_ID ?? '') ? process.env.AGENDA_PUBLICA_EMPRESA_ID : null;
        r.enderecoAtual = empresaAtual ? (await db.query(`SELECT e.codigo = 'kidmais' AS codigo_kidmais,
            EXISTS(SELECT 1 FROM empresa_regras_pagamento r WHERE r.empresa_id = e.id) AS tem_regra FROM empresas e WHERE e.id = $1::uuid`, [empresaAtual])).rows[0] ?? null : null;
        r.concluido = true; salvar();
        console.log(JSON.stringify({resultado:'PASS', etapas:r.etapas.map(e => ({nome:e.nome, ok:e.ok, info:e.info})), enderecoAtual:r.enderecoAtual}));
    } catch (e) {
        await db.query('ROLLBACK').catch(() => {});
        r.falha = {etapa:r.etapas.at(-1)?.nome ?? 'CONEXAO', mensagem:String(e.message).slice(0, 160)}; r.concluido = false; salvar();
        console.error(JSON.stringify(r.falha)); process.exitCode = 2;
    } finally {
        await db.end().catch(() => {});
    }
}

if (require.main === module) {
    if (!autorizado(process.argv.slice(2))) { console.error('AGUARDANDO_AUTORIZACAO_O3'); process.exitCode = 1; }
    else main().catch(e => { console.error(String(e?.message ?? 'RECUSADO').slice(0, 120)); process.exitCode = 1; });
}
module.exports = {ETAPAS, FLAG, alvo, autorizado, lerRevisado};
