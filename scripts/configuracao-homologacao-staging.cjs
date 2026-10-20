/* eslint-disable @typescript-eslint/no-require-imports */
// Configuração anterior das duas chaves da homologação (não secretas: só "true"/"false"/ausente).
// Registro: ANTES de O1, pelo comando de uma linha COMANDO_REGISTRO (roda no deploy atual, que ainda não tem este arquivo).
// Conferência: DEPOIS de O5, `node scripts/configuracao-homologacao-staging.cjs --conferir-restauracao` (já na candidata).
const assert = require('node:assert/strict');
const fs = require('node:fs');

const CHAVES = Object.freeze(['COTACAO_PUBLICA_POR_EMPRESA', 'ASSINATURA_PLANOS_ATIVOS']);
const DIR = '/opt/render/project/src/data/homologacao-planos-cotacao-20261010';
const ARQUIVO = 'configuracao-anterior.json';

/** Estado de cada chave: presença e valor normalizado (qualquer coisa fora de true/false vira OUTRO, nunca o texto). */
function registrar(env) {
    return Object.fromEntries(CHAVES.map(k => {
        const v = env[k];
        return [k, {presente:v !== undefined, valor:v === undefined ? null : (['true', 'false'].includes(v) ? v : 'OUTRO')}];
    }));
}

/** Comparação com o registro: lista o que diverge (nome + estado normalizado). */
function conferir(registro, env) {
    assert.deepEqual(Object.keys(registro).sort(), [...CHAVES].sort(), 'REGISTRO_INVALIDO');
    const atual = registrar(env);
    return CHAVES.filter(k => atual[k].presente !== registro[k].presente || atual[k].valor !== registro[k].valor)
        .map(k => ({chave:k, anterior:registro[k], atual:atual[k]}));
}

/** Ação de O5 para voltar ao registro (o MCP só grava; remoção é pelo painel, “Save only”). */
function planoRestauracao(registro) {
    return CHAVES.map(k => {
        const r = registro[k];
        if (!r.presente) return {chave:k, acao:'REMOVER_NO_PAINEL'};
        if (r.valor === 'OUTRO') return {chave:k, acao:'PARAR_VALOR_DESCONHECIDO'};
        return {chave:k, acao:'DEFINIR', valor:r.valor};
    });
}

// Mesma lógica de registrar(), em uma linha, para o Web Shell do deploy atual (antes de O1). Não sobrescreve (flag wx).
const COMANDO_REGISTRO = `mkdir -p data/homologacao-planos-cotacao-20261010 && node -e 'const n=${JSON.stringify(CHAVES)};const o={};for(const k of n){const v=process.env[k];o[k]={presente:v!==undefined,valor:v===undefined?null:(["true","false"].includes(v)?v:"OUTRO")}}require("fs").writeFileSync("data/homologacao-planos-cotacao-20261010/${ARQUIVO}",JSON.stringify(o),{mode:0o600,flag:"wx"});console.log(JSON.stringify(o))'`;

function alvo(env) {
    assert.equal(env.RENDER, 'true'); assert.equal(env.RENDER_SERVICE_ID, 'srv-daif418ae00c73e8k2gg'); assert.equal(env.KIDMAIS_DEPLOY_ENV, 'staging');
}

if (require.main === module) {
    try {
        const flags = process.argv.slice(2).filter(a => a.startsWith('--'));
        assert.deepEqual(flags, ['--conferir-restauracao'], 'USO: --conferir-restauracao');
        alvo(process.env);
        const registro = JSON.parse(fs.readFileSync(DIR + '/' + ARQUIVO, 'utf8'));
        const divergencias = conferir(registro, process.env);
        console.log(JSON.stringify({resultado:divergencias.length ? 'DIVERGENTE' : 'RESTAURADA', registro, divergencias}));
        if (divergencias.length) process.exitCode = 2;
    } catch (e) {
        console.error(String(e?.message ?? 'RECUSADO').slice(0, 120)); process.exitCode = 1;
    }
}
module.exports = {CHAVES, ARQUIVO, registrar, conferir, planoRestauracao, COMANDO_REGISTRO, alvo};
