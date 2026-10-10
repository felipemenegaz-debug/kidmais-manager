/* eslint-disable @typescript-eslint/no-require-imports */
// Pós-conferência SOMENTE LEITURA do banco descartável do navegador local (docs/HOMOLOGACAO_COTACAO_ETAPAS_20261010.md §7).
// Mesmo alvo e guardas do seed (KIDMAIS_NAVEGADOR_AUTORIZACAO, 127.0.0.1:55481, identidade do cluster); transação READ ONLY;
// imprime só contagens e status — nenhum nome, CPF, e-mail ou telefone.
const seed = require('./navegador-local-seed.cjs');

const EMPRESAS_PEDIDO = Object.freeze(['nav-profissional', 'nav-premium', 'kidmais']);

/** Consultas da pós-conferência (puras; o teste confere que nenhuma escreve). */
const CONSULTAS = Object.freeze({
    pedidos: `SELECT e.codigo, f.origem_fechamento AS origem, f.status, count(*)::int AS n
        FROM fechamentos f JOIN empresas e ON e.id = f.empresa_id GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`,
    clientes: `SELECT e.codigo, count(*)::int AS n, count(c.cpf)::int AS com_cpf FROM clientes c JOIN empresas e ON e.id = c.empresa_id
        WHERE e.codigo = ANY($1::text[]) GROUP BY 1 ORDER BY 1`,
    cpfEntreEmpresas: `SELECT count(*)::int AS cpfs FROM (SELECT c.cpf FROM clientes c JOIN empresas e ON e.id = c.empresa_id
        WHERE c.cpf IS NOT NULL AND e.codigo = ANY($1::text[]) GROUP BY c.cpf HAVING count(DISTINCT c.empresa_id) > 1) x`,
    festasConfirmadas: `SELECT count(*)::int AS n FROM fechamentos WHERE status = 'CONFIRMADO'`,
});

function resumir({pedidos, clientes, cpfEntreEmpresas, festasConfirmadas}) {
    const porEmpresa = Object.fromEntries(EMPRESAS_PEDIDO.map(codigo => [codigo, {
        pedidosCliente:pedidos.filter(p => p.codigo === codigo && p.origem === 'CLIENTE').map(p => `${p.status}:${p.n}`),
        clientes:clientes.find(c => c.codigo === codigo)?.n ?? 0,
    }]));
    const outros = pedidos.filter(p => p.origem === 'CLIENTE' && !EMPRESAS_PEDIDO.includes(p.codigo)).map(p => p.codigo);
    const confere = EMPRESAS_PEDIDO.every(c => porEmpresa[c].pedidosCliente.join() === 'AGUARDANDO_CONTRATO:1')
        && outros.length === 0 && cpfEntreEmpresas === 1 && festasConfirmadas === 0;
    return {resultado:confere ? 'CONFERE' : 'DIVERGE', porEmpresa, pedidosClienteEmOutrasEmpresas:outros,
        cpfEmDuasEmpresas:cpfEntreEmpresas, festasConfirmadas};
}

async function executar(env) {
    const a = seed.alvo(env);
    seed.semConexaoHerdada(env, a);
    const {Client} = require('pg');
    const c = new Client({host:a.host, port:a.porta, user:seed.PAPEL, database:a.banco, ssl:false, connectionTimeoutMillis:5000,
        password:async () => { throw Error('SERVIDOR_PEDIU_SENHA'); }, application_name:'kidmais-navegador-posconferencia'});
    await c.connect();
    try {
        await c.query('BEGIN READ ONLY');
        seed.conferirIdentidade((await c.query(seed.SQL_IDENTIDADE)).rows[0], a, a.banco, [a.banco]);
        const r = {
            pedidos:(await c.query(CONSULTAS.pedidos)).rows,
            clientes:(await c.query(CONSULTAS.clientes, [EMPRESAS_PEDIDO])).rows,
            cpfEntreEmpresas:(await c.query(CONSULTAS.cpfEntreEmpresas, [EMPRESAS_PEDIDO])).rows[0].cpfs,
            festasConfirmadas:(await c.query(CONSULTAS.festasConfirmadas)).rows[0].n,
        };
        return resumir(r);
    } finally { await c.query('ROLLBACK').catch(() => {}); await c.end().catch(() => {}); }
}

if (require.main === module)
    executar(process.env).then(r => { console.log(JSON.stringify(r, null, 2)); if (r.resultado !== 'CONFERE') process.exitCode = 2; })
        .catch(e => { console.error('POSCONFERENCIA_RECUSADA ' + seed.sanitizar(e?.message ?? e?.codigo)); process.exitCode = 1; });
module.exports = {EMPRESAS_PEDIDO, CONSULTAS, resumir};
