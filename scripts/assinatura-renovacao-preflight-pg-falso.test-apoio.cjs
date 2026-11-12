/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Apoio do teste do código de saída do preflight (B-9 production, revisão F1): carregado com `node -r`, troca o driver `pg`
 * por um cliente FALSO (identidade sintética aceita, nenhuma rede). O retrato vem de KM_RETRATO (arquivo JSON) ou é nulo.
 */
const Module = require('node:module');
const original = Module._load;
const retrato = process.env.KM_RETRATO ? JSON.parse(require('node:fs').readFileSync(process.env.KM_RETRATO, 'utf8')) : null;
class Client {
    on() {}
    async connect() {}
    async end() {}
    async query(sql) {
        if (/^\s*SELECT\s+current_database/.test(sql)) return { rows: [{ db: 'kidmais_staging_1z91', tls: true }] };
        if (sql.includes('AS renovacoes')) return { rows: [{ renovacoes: true, contratacoes: true, fundadores: true, guardas: 2 }] };
        if (sql.includes("current_setting('search_path')")) return { rows: [{ v: 'public' }] };
        if (sql.includes("'colunas'")) return { rows: [{ retrato }] };
        return { rows: [] };
    }
}
Module._load = function (pedido, ...resto) { return pedido === 'pg' ? { Client } : original.call(this, pedido, ...resto); };
