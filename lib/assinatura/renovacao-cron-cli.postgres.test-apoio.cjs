/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Apoio do teste do JSON IMPRESSO pelo CLI do cron da renovação (B-9 production, revisão do código r2, R2-F1), carregado com
 * `node -r` no processo de `scripts/assinatura-renovacao-cron.cjs`:
 *   - `pg`: Pool/Client REAIS apontados para o PG DESCARTÁVEL (KM_PORTA; nunca o alvo do ambiente). Só a prova de identidade
 *     responde como o alvo de staging, e a consulta final de `alertasInformativos` FALHA de propósito;
 *   - `fetch`: Asaas sandbox FALSO em memória (GET/PUT de UMA assinatura, lista de cobranças vazia); qualquer outra URL é
 *     recusada (nenhuma rede). O número de PUTs vai para KM_ESTADO.
 */
const fs = require('node:fs');
const Module = require('node:module');
const original = Module._load;
const pgReal = require(process.env.KM_PG);
const LOCAL = { host: '127.0.0.1', port: Number(process.env.KM_PORTA), user: 'kidmais_descartavel', database: 'kidmais_pacotes_v1_descartavel',
    password: () => Promise.reject(new Error('o servidor pediu senha; nenhuma credencial é carregada')) };
const IDENTIDADE = /SELECT current_database\(\) AS db, \(SELECT ssl FROM pg_stat_ssl/;
function embrulhar(consulta) {
    return function (sql, ...resto) {
        const texto = typeof sql === 'string' ? sql : sql && sql.text;
        if (texto && IDENTIDADE.test(texto)) return Promise.resolve({ rows: [{ db: 'kidmais_staging_1z91', tls: true }] });
        if (texto && texto.includes('status::text AS status FROM empresas')) return Promise.reject(new Error('consulta final indisponível'));
        return consulta.call(this, sql, ...resto);
    };
}
class Pool extends pgReal.Pool {
    constructor(o) { super({ ...LOCAL, max: (o && o.max) || 4, application_name: o && o.application_name }); this.query = embrulhar(this.query); }
    // Pool.query usa connect com callback; checkout repetido do mesmo cliente não embrulha de novo.
    connect(cb) {
        const preparar = (c) => { if (c && !c.kmEmbrulhado) { c.query = embrulhar(c.query); c.kmEmbrulhado = true; } return c; };
        if (cb) return super.connect((erro, c, devolver) => cb(erro, preparar(c), devolver));
        return super.connect().then(preparar);
    }
}
class Client extends pgReal.Client {
    constructor(o) { super({ ...LOCAL, application_name: o && o.application_name }); this.query = embrulhar(this.query); }
}
Module._load = function (pedido, ...resto) { return pedido === 'pg' ? { ...pgReal, Pool, Client } : original.call(this, pedido, ...resto); };

const sub = JSON.parse(process.env.KM_SUB);
let puts = 0;
const resposta = (corpo, status = 200) => new Response(JSON.stringify(corpo), { status, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (url, init) => {
    const u = new URL(url);
    if (u.hostname !== 'api-sandbox.asaas.com' && u.hostname !== 'sandbox.asaas.com') throw new Error(`rede recusada: ${u.hostname}`);
    const caminho = u.pathname.replace(/^\/v3/, '');
    if (caminho === `/subscriptions/${sub.id}/payments`) return resposta({ data: [], hasMore: false });
    if (caminho === `/subscriptions/${sub.id}` && init.method === 'GET') return resposta(sub);
    if (caminho === `/subscriptions/${sub.id}` && init.method === 'PUT') {
        puts += 1; fs.writeFileSync(process.env.KM_ESTADO, JSON.stringify({ puts }));
        sub.value = JSON.parse(init.body).value; return resposta(sub);
    }
    return resposta({ errors: [] }, 404);
};
