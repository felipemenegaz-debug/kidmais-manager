/* eslint-disable @typescript-eslint/no-require-imports */
// Guarda fase 3 (20/11/2026): simulação do lote mensal de anonimização, SÓ no PostgreSQL DESCARTÁVEL local.
// Só leitura (transação READ ONLY, desfeita no fim) e só contagens: nenhum nome, contato, documento ou id de cliente sai
// daqui. A conexão é a de lib/comercial/postgres-descartavel.ts (opt-in, porta autorizada, 127.0.0.1, papel e
// cluster_name conferidos antes de qualquer SQL); DATABASE_URL e afins herdados fazem recusar. Rodar em staging pede
// adaptador próprio e o sim de Felipe (fora desta fase).
//
// Uso: node scripts/guarda-simular.cjs --aviso AAAA-MM-01 [--tipo PRIMEIRA|NORMAL] [--empresa <uuid>] [--com-aviso]
const path = require('node:path');
const { pathToFileURL } = require('node:url');

function argumentos(argv) {
    const o = { tipo: 'PRIMEIRA', comAviso: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--aviso') o.aviso = argv[++i];
        else if (a === '--tipo') o.tipo = argv[++i];
        else if (a === '--empresa') o.empresaId = argv[++i];
        else if (a === '--com-aviso') o.comAviso = true;
        else throw new Error('argumento desconhecido: ' + a);
    }
    if (!/^\d{4}-\d{2}-01$/.test(o.aviso ?? '')) throw new Error('--aviso AAAA-MM-01 é obrigatório (o aviso é sempre no dia 1º)');
    if (!['PRIMEIRA', 'NORMAL'].includes(o.tipo)) throw new Error('--tipo PRIMEIRA ou NORMAL');
    if (o.empresaId !== undefined && !/^[0-9a-f-]{36}$/i.test(o.empresaId)) throw new Error('--empresa precisa ser um uuid');
    return o;
}

async function principal() {
    const o = argumentos(process.argv.slice(2));
    const raiz = path.resolve(__dirname, '..');
    const ts = (r) => import(pathToFileURL(path.join(raiz, r)).href);
    const { conectarDescartavel, encerrarDescartavel } = await ts('lib/comercial/postgres-descartavel.ts');
    const { simularLote, rascunhoDoAviso } = await ts('lib/guarda/simulacao.ts');
    const c = await conectarDescartavel();
    try {
        await c.query('BEGIN TRANSACTION READ ONLY');
        const r = await simularLote(c, { aviso: o.aviso, tipo: o.tipo, empresaId: o.empresaId });
        const saida = { lote: r.lote, disputaMedida: r.disputaMedida, totais: r.totais, empresas: r.empresas };
        if (o.comAviso) saida.avisos = r.empresas.filter((e) => e.apto).map((e) => ({ empresaId: e.empresaId, texto: rascunhoDoAviso(e, r.lote) }));
        process.stdout.write(JSON.stringify(saida, null, 2) + '\n');
    } finally {
        await c.query('ROLLBACK').catch(() => {});
        await encerrarDescartavel(c);
    }
}

principal().then(() => process.exit(0), (e) => { process.stderr.write('guarda-simular: ' + (e && e.message ? e.message : String(e)) + '\n'); process.exit(1); });
