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

/** Modo --catalogo (docs/HOMOLOGACAO_CATALOGO_BUFFET_20261010.md): catálogo do buffet por empresa, só contagens. */
const CONSULTAS_CATALOGO = Object.freeze({
    porEmpresa: `SELECT e.codigo, count(DISTINCT c.id)::int AS categorias, count(DISTINCT i.id)::int AS itens,
        bool_or(c.codigo = 'SALGADOS') AS tem_salgados
        FROM empresas e LEFT JOIN buffet_categorias c ON c.empresa_id = e.id LEFT JOIN buffet_itens i ON i.empresa_id = e.id
        WHERE e.codigo = ANY($1::text[]) GROUP BY e.codigo ORDER BY e.codigo`,
    cruzados: `SELECT
        (SELECT count(*) FROM pacote_buffet_categorias x JOIN pacotes p ON p.id = x.pacote_id JOIN buffet_categorias c ON c.id = x.categoria_id
          WHERE p.empresa_id IS DISTINCT FROM c.empresa_id)
      + (SELECT count(*) FROM pacote_buffet_itens x JOIN pacotes p ON p.id = x.pacote_id JOIN buffet_itens i ON i.id = x.item_id
          WHERE p.empresa_id IS DISTINCT FROM i.empresa_id)
      + (SELECT count(*) FROM pacote_itens_especificos x JOIN pacotes p ON p.id = x.pacote_id JOIN buffet_itens i ON i.id = x.item_id
          WHERE p.empresa_id IS DISTINCT FROM i.empresa_id)
      + (SELECT count(*) FROM buffet_itens i JOIN buffet_categorias c ON c.id = i.categoria_id WHERE i.empresa_id IS DISTINCT FROM c.empresa_id)
      + (SELECT count(*) FROM adicionais a JOIN buffet_itens i ON i.id = a.origem_buffet_item_id WHERE a.empresa_id IS DISTINCT FROM i.empresa_id)
      + (SELECT count(*) FROM adicionais a JOIN buffet_categorias c ON c.id = a.origem_buffet_categoria_id WHERE a.empresa_id IS DISTINCT FROM c.empresa_id)
      + (SELECT count(*) FROM fechamento_buffet_escolhas x JOIN fechamento_buffet_snapshots s ON s.id = x.snapshot_id
          JOIN fechamentos f ON f.id = s.fechamento_id JOIN buffet_categorias c ON c.id = x.categoria_id WHERE f.empresa_id IS DISTINCT FROM c.empresa_id)
      AS n`,
    escolhas: `SELECT e.codigo, count(*)::int AS n FROM fechamento_buffet_escolhas x JOIN fechamento_buffet_snapshots s ON s.id = x.snapshot_id
        JOIN fechamentos f ON f.id = s.fechamento_id JOIN empresas e ON e.id = f.empresa_id GROUP BY e.codigo ORDER BY e.codigo`,
});

function resumirCatalogo({porEmpresa, cruzados, escolhas}) {
    const de = codigo => porEmpresa.find(x => x.codigo === codigo) ?? {categorias:0, itens:0, tem_salgados:false};
    const confere = cruzados === 0 && de('kidmais').categorias >= 7
        && ['nav-profissional', 'nav-premium'].every(c => de(c).tem_salgados === true && de(c).itens > 0)
        && de('nav-essencial').categorias === 0;
    return {resultado:confere ? 'CONFERE' : 'DIVERGE', vinculosEntreEmpresas:cruzados,
        catalogo:Object.fromEntries(porEmpresa.map(x => [x.codigo, {categorias:x.categorias, itens:x.itens, salgados:x.tem_salgados === true}])),
        escolhasDeBuffetPorEmpresa:Object.fromEntries(escolhas.map(x => [x.codigo, x.n]))};
}

async function executar(env, modoCatalogo = false) {
    const a = seed.alvo(env);
    seed.semConexaoHerdada(env, a);
    const {Client} = require('pg');
    const c = new Client({host:a.host, port:a.porta, user:seed.PAPEL, database:a.banco, ssl:false, connectionTimeoutMillis:5000,
        password:async () => { throw Error('SERVIDOR_PEDIU_SENHA'); }, application_name:'kidmais-navegador-posconferencia'});
    await c.connect();
    try {
        await c.query('BEGIN READ ONLY');
        seed.conferirIdentidade((await c.query(seed.SQL_IDENTIDADE)).rows[0], a, a.banco, [a.banco]);
        if (modoCatalogo) return resumirCatalogo({
            porEmpresa:(await c.query(CONSULTAS_CATALOGO.porEmpresa, [['kidmais', 'nav-profissional', 'nav-premium', 'nav-essencial']])).rows,
            cruzados:Number((await c.query(CONSULTAS_CATALOGO.cruzados)).rows[0].n),
            escolhas:(await c.query(CONSULTAS_CATALOGO.escolhas)).rows,
        });
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
    executar(process.env, process.argv.slice(2).includes('--catalogo')).then(r => { console.log(JSON.stringify(r, null, 2)); if (r.resultado !== 'CONFERE') process.exitCode = 2; })
        .catch(e => { console.error('POSCONFERENCIA_RECUSADA ' + seed.sanitizar(e?.message ?? e?.codigo)); process.exitCode = 1; });
module.exports = {EMPRESAS_PEDIDO, CONSULTAS, resumir, CONSULTAS_CATALOGO, resumirCatalogo};
