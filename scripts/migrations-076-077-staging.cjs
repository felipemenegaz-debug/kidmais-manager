/* eslint-disable @typescript-eslint/no-require-imports */
// O3 da homologação de 10/10/2026: aplica 076 e 077 SOMENTE no banco staging, pelo Web Shell do srv-daif418ae00c73e8k2gg,
// depois de aprovação explícita e do backup conferido. Executa exatamente os arquivos revisados (hash fixado).
// Só aplica o que falta: migration ausente → precheck, migration, postcheck; já aplicada → apenas o postcheck (leitura).
// Qualquer falha para (sem repetir). Cada tentativa tem arquivo próprio; as anteriores nunca são alteradas nem apagadas.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {alvo: alvoEnsaio} = require('./assinatura-staging-ensaio.cjs');
const {SQL_IDENTIDADE, conferirIdentidade, exigirDisco} = require('./conexao-staging.cjs');

const FLAG = '--aplicar-076-077-autorizado';
const DIR = '/opt/render/project/src/data/homologacao-planos-cotacao-20261010';
const BASE = 'migrations-076-077';
const ETAPAS = Object.freeze([
    ['precheck 076', 'database/checks/20261010_076_precheck.sql', '0c57d854e02a59e23003463fc9e501d4fec1f2309a6fe91c7a557fa5f52c3392'],
    ['migration 076', 'database/migrations/20261010_076_cpf_por_empresa.sql', '10c7c051e14024cc4971af3f77237862a35020c8d55b3417b228ba2421838392'],
    ['postcheck 076', 'database/checks/20261010_076_postcheck.sql', '8797783354e0fcc56323c97e5b615f1479e1d3c9cd054cfb95958f25113b71aa'],
    ['precheck 077', 'database/checks/20261010_077_precheck.sql', 'ab24f9ee4a217f92372d0645a150da77a549d19f495cf7b0826fe25a482b1a21'],
    ['migration 077', 'database/migrations/20261010_077_regras_pagamento_empresa.sql', 'afb6bab309168fa7f2e277ba2195eda5dfb15bf6516263b33eb99b3db0b132a8'],
    ['postcheck 077', 'database/checks/20261010_077_postcheck.sql', '812fb322fd367441f795b0de8a558f157a7b041aeb13ad725a1f7d6dd93ad3fd'],
]);
/** Estado real do schema (leitura): cada migration deixa um objeto que só ela cria. */
const SQL_SCHEMA = `SELECT to_regclass('public.clientes_cpf_empresa_canonico_uk') IS NOT NULL AS m076,
    to_regclass('public.empresa_regras_pagamento') IS NOT NULL AS m077`;

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

/** Etapas desta tentativa conforme o schema real: nunca reaplica, nunca pula o postcheck. */
function planoEtapas(schema) {
    assert.equal(typeof schema?.m076, 'boolean', 'SCHEMA_ILEGIVEL'); assert.equal(typeof schema.m077, 'boolean', 'SCHEMA_ILEGIVEL');
    return ETAPAS.filter(([nome]) => {
        const aplicada = nome.endsWith('076') ? schema.m076 : schema.m077;
        return !aplicada || nome.startsWith('postcheck');
    }).map(([nome]) => nome);
}

/** Arquivos de tentativa existentes, em ordem (o da 1ª tentativa não tem número). */
function arquivosTentativas(dir) {
    if (!fs.existsSync(dir)) return [];
    const n = nome => nome === BASE + '.json' ? 1 : Number(/^migrations-076-077\.tentativa-(\d+)\.json$/.exec(nome)?.[1] ?? NaN);
    return fs.readdirSync(dir).filter(x => Number.isInteger(n(x))).sort((a, b) => n(a) - n(b));
}

/**
 * Nova tentativa só quando TODAS as anteriores pararam comprovadamente antes de qualquer SQL de migration: concluido
 * gravado como false, nenhuma etapa iniciada (a etapa é gravada antes do envio) e falha na conexão/identidade.
 * Qualquer outro estado (concluída, em andamento/interrompida, etapa iniciada, arquivo ilegível) para para revisão.
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
        r.schemaAntes = (await db.query(SQL_SCHEMA)).rows[0]; r.plano = planoEtapas(r.schemaAntes); salvar();
        for (const nome of r.plano) {
            r.etapas.push({nome, inicio:new Date().toISOString()}); salvar();
            const resultado = await db.query(sqls.get(nome));
            // Só a linha informativa agregada dos checks (contagens/booleanos); nunca dados de clientes.
            const linhas = (Array.isArray(resultado) ? resultado : [resultado]).flatMap(x => x.rows ?? []);
            Object.assign(r.etapas.at(-1), {ok:true, fim:new Date().toISOString(), info:linhas.at(-1) ?? null}); salvar();
        }
        r.schemaDepois = (await db.query(SQL_SCHEMA)).rows[0];
        assert.ok(r.schemaDepois.m076 && r.schemaDepois.m077, 'SCHEMA_DEPOIS');
        // Informativo (só leitura): a empresa do endereço público atual de staging tem regra de pagamento após a 077?
        const empresaAtual = /^[0-9a-f-]{36}$/i.test(env.AGENDA_PUBLICA_EMPRESA_ID ?? '') ? env.AGENDA_PUBLICA_EMPRESA_ID : null;
        r.enderecoAtual = empresaAtual ? (await db.query(`SELECT e.codigo = 'kidmais' AS codigo_kidmais,
            EXISTS(SELECT 1 FROM empresa_regras_pagamento r WHERE r.empresa_id = e.id) AS tem_regra FROM empresas e WHERE e.id = $1::uuid`, [empresaAtual])).rows[0] ?? null : null;
        r.concluido = true; salvar();
        return {resultado:'PASS', arquivo:t.arquivo, tentativa:t.numero, conexao:r.conexao, schemaAntes:r.schemaAntes,
            etapas:r.etapas.map(e => ({nome:e.nome, ok:e.ok, info:e.info})), enderecoAtual:r.enderecoAtual};
    } catch (e) {
        await db.query('ROLLBACK').catch(() => {});
        r.falha = {etapa:r.etapas.at(-1)?.nome ?? 'CONEXAO', mensagem:String(e?.message).slice(0, 160)}; r.concluido = false; salvar();
        return {resultado:'FALHA', arquivo:t.arquivo, tentativa:t.numero, falha:r.falha};
    } finally {
        await db.end().catch(() => {});
    }
}

if (require.main === module) {
    if (!autorizado(process.argv.slice(2))) { console.error('AGUARDANDO_AUTORIZACAO_O3'); process.exitCode = 1; }
    else executar({env:process.env}).then(s => {
        (s.resultado === 'PASS' ? console.log : console.error)(JSON.stringify(s)); if (s.resultado !== 'PASS') process.exitCode = 2;
    }).catch(e => { console.error(String(e?.message ?? 'RECUSADO').slice(0, 120)); process.exitCode = 1; });
}
module.exports = {ETAPAS, FLAG, BASE, SQL_SCHEMA, alvo, autorizado, lerRevisado, planoEtapas, arquivosTentativas, avaliarTentativas, executar};
