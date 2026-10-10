import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg, { type Client } from 'pg';
import { conectarDescartavel, encerrarDescartavel, portaDescartavel, senhaRecusada } from '../comercial/postgres-descartavel.ts';
import { createRequire } from 'node:module';
import { conexaoDeClientePg, conexaoDescartavelDoPoolPg, transacaoComPrazo } from '../db/transacao-com-prazo.ts';
import { iniciarTeste } from './servico.ts';
import { processarEvento } from './sincronizacao.ts';
import { registrarPendencia, type TransacaoIndependente } from './reconciliacao-contratacao.ts';

/**
 * D1 com REDE PARADA de verdade: o pool da transação independente fala com o PostgreSQL descartável por um proxy TCP local
 * que pode (a) engolir um comando (nunca chega ao servidor) ou (b) deixá-lo passar e engolir a resposta. Sem prazo do lado
 * da aplicação, as duas situações esperariam para sempre. D2: a ausência na releitura tem ação própria, sem duplicar.
 */
const M067 = 'database/migrations/20261006_067_modelo_comercial_empresa.sql';
const M068 = 'database/migrations/20261007_068_cobranca_assinatura.sql';
const PRAZO = 1500;
const APLICACAO = 'kidmais-teste-prazo-d1';

let principal: Client;
const q = (sql: string, p: unknown[] = []) => principal.query(sql, p);
async function emTx<T>(c: Client, f: (tx: never) => Promise<T>) {
    await c.query('BEGIN');
    try { const r = await f(c as never); await c.query('COMMIT'); return r; }
    catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; }
}

/** Proxy TCP: quando o cliente fecha (descarte), fecha também o lado do servidor, que então desfaz o que estava aberto. */
function proxyTcp(destino: number) {
    const regras = { engolirAoEnviar: null as string | null, semRespostaApos: null as string | null };
    const conexoes: net.Socket[] = [];
    const servidor = net.createServer((cliente) => {
        const banco = net.connect(destino, '127.0.0.1');
        conexoes.push(cliente, banco);
        let engolido = false, semResposta = false;
        cliente.on('data', (d) => {
            if (engolido) return;
            const texto = d.toString('latin1');
            if (regras.engolirAoEnviar && texto.includes(regras.engolirAoEnviar)) { engolido = true; return; }
            banco.write(d);
            if (regras.semRespostaApos && texto.includes(regras.semRespostaApos)) semResposta = true;
        });
        banco.on('data', (d) => { if (!engolido && !semResposta) cliente.write(d); });
        const fechar = () => { cliente.destroy(); banco.destroy(); };
        cliente.on('close', fechar); cliente.on('error', fechar); banco.on('close', fechar); banco.on('error', fechar);
    });
    return {
        regras,
        abrir: () => new Promise<number>((ok) => servidor.listen(0, '127.0.0.1', () => ok((servidor.address() as net.AddressInfo).port))),
        fechar: () => new Promise<void>((ok) => { for (const c of conexoes) c.destroy(); servidor.close(() => ok()); }),
    };
}

async function novaEmpresa() {
    const id = (await q("INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Buffet Prazo', 'PROVISIONAMENTO') RETURNING id", [`pz${randomBytes(4).toString('hex')}`])).rows[0].id as string;
    await q("UPDATE empresas SET status = 'ATIVA' WHERE id = $1", [id]);
    const base = `7${String(Date.now()).slice(-7)}${String(Math.floor(Math.random() * 10_000)).padStart(4, '0')}`.slice(0, 12);
    const dv = (b: string) => { let s = 0, p = 2; for (let i = b.length - 1; i >= 0; i--) { s += (b.charCodeAt(i) - 48) * p; p = p === 9 ? 2 : p + 1; } const r = s % 11; return r <= 1 ? 0 : 11 - r; };
    const d1 = dv(base);
    await emTx(principal, (tx) => iniciarTeste(tx, { empresaId: id, documento: `${base}${d1}${dv(base + d1)}` }));
    return id;
}
/** Vínculo vigente + uma duplicata só com cobrança em aberto (a decisão central manda excluir). */
async function cenario() {
    const empresa = await novaEmpresa();
    const sufixo = randomBytes(3).toString('hex');
    const vinculada = `sub_v_${sufixo}`, duplicata = `sub_d_${sufixo}`, cliente = `cus_${sufixo}`;
    await q("UPDATE empresa_assinaturas SET provedor = 'ASAAS', provedor_cliente_id = $3, provedor_assinatura_id = $2 WHERE empresa_id = $1", [empresa, vinculada, cliente]);
    const pend = await emTx(principal, (tx) => registrarPendencia(tx, { empresaId: empresa, assinaturaId: duplicata, motivo: 'COMPENSACAO_FALHOU' }));
    const removidas = new Set<string>();
    const sub = (id: string) => ({ id, status: 'ACTIVE', deleted: false, cycle: 'MONTHLY', customer: cliente, externalReference: empresa });
    const provedor = {
        removerChamadas: 0,
        async obterAssinatura(id: string) { return (id === vinculada || id === duplicata) && !removidas.has(id) ? sub(id) : null; },
        async listarAssinaturasPorReferencia() { return [vinculada, duplicata].filter((id) => !removidas.has(id)).map(sub); },
        async listarCobrancasDaAssinatura(id: string) { return [{ id: `pay_${id}`, status: 'PENDING', dueDate: '2026-10-20', paymentDate: null, invoiceUrl: null, deleted: false }]; },
        async removerAssinatura(id: string) { provedor.removerChamadas += 1; removidas.add(id); return { removida: true }; },
    };
    return { empresa, duplicata, pend, provedor };
}
const marcadores = async (empresa: string) => (await q("SELECT situacao, ultimo_erro FROM cobranca_eventos WHERE empresa_id = $1 AND evento_id LIKE 'kidmais:remocao:%' ORDER BY recebido_em", [empresa])).rows.map((r) => [r.situacao, r.ultimo_erro]);
const auditorias = async (empresa: string) => (await q("SELECT acao, dados_depois->>'confirmacao' AS c FROM auditoria WHERE entidade_id = $1 AND acao IN ('ASSINATURA_DUPLICADA_REMOVIDA', 'ASSINATURA_REMOCAO_SEM_CONFIRMACAO', 'ASSINATURA_AUSENCIA_CONFIRMADA_RELEITURA') ORDER BY criado_em, id", [empresa])).rows.map((r) => [r.acao, r.c]);
const backends = async () => (await q('SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1', [APLICACAO])).rows[0].n as number;
async function ate(cond: () => Promise<boolean>, ms = 4000) {
    const fim = Date.now() + ms;
    while (Date.now() < fim) { if (await cond()) return true; await new Promise((ok) => setTimeout(ok, 50)); }
    return cond();
}
/** Transação independente sem proxy (rede normal), para a recuperação depois de cada cenário. */
const independenteNormal: TransacaoIndependente = async (trabalho) => {
    const c = await conectarDescartavel({ travar: false });
    try { return await emTx(c, trabalho as never); }
    finally { await encerrarDescartavel(c, false); }
};
async function processar(pend: string, provedor: object, independente: TransacaoIndependente) {
    const c = await conectarDescartavel({ travar: false });
    try {
        const t0 = Date.now();
        const r = await emTx(c, (tx) => processarEvento(tx, pend, { provedor: provedor as never, transacaoIndependente: independente }));
        return { r, ms: Date.now() - t0 };
    }
    finally { await encerrarDescartavel(c, false); }
}

let proxy: ReturnType<typeof proxyTcp>;
let portaProxy = 0;
let pool: pg.Pool;
let independenteComPrazo: TransacaoIndependente;
test.before(async () => {
    principal = await conectarDescartavel();
    // Estado `atual` (até a 057): instala 067/068; estado `075`: já instaladas pela receita.
    if ((await q("SELECT to_regclass('public.empresa_assinaturas') IS NULL AS ok")).rows[0].ok) await q(readFileSync(M067, 'utf8'));
    if ((await q("SELECT to_regclass('public.cobranca_eventos') IS NULL AS ok")).rows[0].ok) await q(readFileSync(M068, 'utf8'));
    proxy = proxyTcp(portaDescartavel());
    const porta = await proxy.abrir();
    portaProxy = porta;
    pool = new pg.Pool({ host: '127.0.0.1', port: porta, user: 'kidmais_descartavel', database: 'kidmais_pacotes_v1_descartavel', password: senhaRecusada,
        max: 2, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000, application_name: APLICACAO });
    pool.on('error', () => undefined);
    independenteComPrazo = transacaoComPrazo(() => conexaoDescartavelDoPoolPg(pool as never), PRAZO);
});
test.after(async () => {
    await pool?.end().catch(() => undefined);
    await proxy?.fechar();
    if (principal) await encerrarDescartavel(principal);
});
test.beforeEach(() => { proxy.regras.engolirAoEnviar = null; proxy.regras.semRespostaApos = null; });

test('D1: rede para antes do COMMIT do marcador → ADIADA no prazo, nenhum DELETE, conexão descartada (sai do pool; o servidor encerra a sessão), nada gravado', async () => {
    const { empresa, pend, provedor } = await cenario();
    proxy.regras.engolirAoEnviar = 'INSERT INTO cobranca_eventos';
    const { r, ms } = await processar(pend, provedor, independenteComPrazo);
    assert.deepEqual([r.situacao, r.motivo], ['FALHOU', 'ADIADA: MARCADOR_NAO_GRAVADO']);
    assert.ok(ms >= PRAZO - 50 && ms < PRAZO + 4000, `prazo finito: ${ms} ms`);
    assert.equal(provedor.removerChamadas, 0, 'sem COMMIT confirmado do marcador, nenhum DELETE');
    assert.ok(await ate(async () => pool.totalCount === 0), `conexão descartada não volta ao pool (total ${pool.totalCount})`);
    assert.ok(await ate(async () => (await backends()) === 0), 'o servidor encerrou a sessão da conexão descartada');
    assert.deepEqual(await marcadores(empresa), [], 'o INSERT nunca chegou; nada gravado');
    // Rede de volta: a mesma transação com prazo grava o marcador e exclui normalmente.
    proxy.regras.engolirAoEnviar = null;
    const depois = await processar(pend, provedor, independenteComPrazo);
    assert.deepEqual([depois.r.situacao, depois.r.motivo, provedor.removerChamadas], ['PROCESSADO', 'CONCILIADA', 1]);
    assert.deepEqual(await auditorias(empresa), [['ASSINATURA_DUPLICADA_REMOVIDA', 'RESPOSTA_DO_PROVEDOR']]);
});

test('D1: COMMIT do marcador aplicado SEM resposta → resultado desconhecido: nenhum DELETE; o marcador fica aberto e a recuperação vai para revisão (nunca DELETE)', async () => {
    const { empresa, pend, provedor } = await cenario();
    proxy.regras.semRespostaApos = 'COMMIT';
    const { r, ms } = await processar(pend, provedor, independenteComPrazo);
    assert.deepEqual([r.situacao, r.motivo], ['FALHOU', 'ADIADA: MARCADOR_NAO_GRAVADO']);
    assert.ok(ms < PRAZO + 4000, `prazo finito: ${ms} ms`);
    assert.equal(provedor.removerChamadas, 0, 'COMMIT não confirmado: nenhum DELETE');
    assert.ok(await ate(async () => pool.totalCount === 0));
    assert.deepEqual(await marcadores(empresa), [['PENDENTE', 'REMOCAO_EM_CURSO']], 'o servidor aplicou o COMMIT: o marcador existe');
    proxy.regras.semRespostaApos = null;
    const depois = await processar(pend, provedor, independenteNormal);
    assert.deepEqual([depois.r.situacao, depois.r.motivo], ['FALHOU', 'REVISAO_HUMANA: REMOCAO_SEM_CONFIRMACAO']);
    assert.deepEqual([provedor.removerChamadas, await auditorias(empresa)], [0, []]);
});

test('D1 + D2: DELETE confirmado e a gravação do resultado sem resposta → marcador continua REMOCAO_EM_CURSO; a releitura grava só a AUSÊNCIA (ação neutra), sem DELETE repetido e sem "duplicata removida"', async () => {
    const { empresa, pend, provedor } = await cenario();
    proxy.regras.engolirAoEnviar = "UPDATE cobranca_eventos SET situacao = 'PROCESSADO'";
    const { r, ms } = await processar(pend, provedor, independenteComPrazo);
    assert.deepEqual([r.situacao, r.motivo], ['FALHOU', 'REVISAO_HUMANA: REMOCAO_SEM_CONFIRMACAO']);
    assert.ok(ms < 2 * PRAZO + 4000, `prazo finito: ${ms} ms`);
    assert.equal(provedor.removerChamadas, 1);
    assert.deepEqual([await marcadores(empresa), await auditorias(empresa)], [[['PENDENTE', 'REMOCAO_EM_CURSO']], []]);
    proxy.regras.engolirAoEnviar = null;
    const depois = await processar(pend, provedor, independenteComPrazo);
    assert.deepEqual([depois.r.situacao, depois.r.motivo], ['PROCESSADO', 'NADA_A_FAZER']);
    assert.equal(provedor.removerChamadas, 1, 'nenhum DELETE repetido');
    assert.deepEqual(await marcadores(empresa), [['PROCESSADO', 'AUSENCIA_CONFIRMADA_NA_RELEITURA']]);
    assert.deepEqual(await auditorias(empresa), [['ASSINATURA_AUSENCIA_CONFIRMADA_RELEITURA', 'AUSENCIA_NA_RELEITURA']], 'autoria não atribuída à aplicação');
});

const MARCADOR_DO_SCRIPT = 'kidmais-assinatura-reconciliar-marcador';
const backendsDoScript = async () => (await q('SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1', [MARCADOR_DO_SCRIPT])).rows[0].n as number;

test('D1, abertura do SCRIPT pelo proxy (pg.Client real): SELECT current_database() sem resposta → prazo finito, soquete destruído, sessão encerrada no servidor, ADIADA, nenhum DELETE; com a rede de volta, a mesma abertura confere o banco e exclui', async () => {
    const { empresa, pend, provedor } = await cenario();
    const script = createRequire(import.meta.url)('../../scripts/assinatura-reconciliar.cjs') as {
        transacaoIndependenteDaExecucao: (aplicar: boolean, principal: unknown, abrir: unknown, comPrazo: unknown, prazoMs: number) => TransacaoIndependente;
        abrirConexaoDoMarcador: (Client: unknown, alvo: unknown, adaptar: unknown, registrar?: unknown) => Promise<unknown>;
    };
    const alvo = { connectionString: `postgresql://kidmais_descartavel@127.0.0.1:${portaProxy}/kidmais_pacotes_v1_descartavel`, local: true, database: 'kidmais_pacotes_v1_descartavel' };
    const independente = script.transacaoIndependenteDaExecucao(true, null, (registrar: unknown) => script.abrirConexaoDoMarcador(pg.Client, alvo, conexaoDeClientePg, registrar), transacaoComPrazo, PRAZO);
    proxy.regras.engolirAoEnviar = 'current_database';
    const { r, ms } = await processar(pend, provedor, independente);
    assert.deepEqual([r.situacao, r.motivo], ['FALHOU', 'ADIADA: MARCADOR_NAO_GRAVADO']);
    assert.ok(ms >= PRAZO - 50 && ms < PRAZO + 4000, `prazo finito: ${ms} ms`);
    assert.deepEqual([provedor.removerChamadas, await marcadores(empresa)], [0, []], 'nenhuma escrita de negócio, nenhum DELETE');
    assert.ok(await ate(async () => (await backendsDoScript()) === 0), 'o soquete foi destruído: o servidor encerrou a sessão aberta na conferência');
    proxy.regras.engolirAoEnviar = null;
    const depois = await processar(pend, provedor, independente);
    assert.deepEqual([depois.r.situacao, depois.r.motivo, provedor.removerChamadas], ['PROCESSADO', 'CONCILIADA', 1]);
    assert.deepEqual(await auditorias(empresa), [['ASSINATURA_DUPLICADA_REMOVIDA', 'RESPOSTA_DO_PROVEDOR']]);
    assert.ok(await ate(async () => (await backendsDoScript()) === 0), 'conexões do marcador encerradas ao fim de cada transação');
});

test('TLS do marcador (pg.Client real): alvo remoto exige TLS verificado; servidor sem TLS → abertura falha, ADIADA, nenhum DELETE nem sessão aberta', async () => {
    const { empresa, pend, provedor } = await cenario();
    const script = createRequire(import.meta.url)('../../scripts/assinatura-reconciliar.cjs') as {
        transacaoIndependenteDaExecucao: (aplicar: boolean, principal: unknown, abrir: unknown, comPrazo: unknown, prazoMs: number) => TransacaoIndependente;
        abrirConexaoDoMarcador: (Client: unknown, alvo: unknown, adaptar: unknown, registrar?: unknown, env?: Record<string, string>) => Promise<unknown>;
    };
    // O mesmo servidor descartável (sem TLS), tratado como alvo NÃO local: a política padrão exige TLS com certificado verificado.
    const alvo = { connectionString: `postgresql://kidmais_descartavel@127.0.0.1:${portaDescartavel()}/kidmais_pacotes_v1_descartavel`, local: false, database: 'kidmais_pacotes_v1_descartavel' };
    const independente = script.transacaoIndependenteDaExecucao(true, null, (registrar: unknown) => script.abrirConexaoDoMarcador(pg.Client, alvo, conexaoDeClientePg, registrar, {}), transacaoComPrazo, PRAZO);
    const { r } = await processar(pend, provedor, independente);
    assert.deepEqual([r.situacao, r.motivo], ['FALHOU', 'ADIADA: MARCADOR_NAO_GRAVADO']);
    assert.deepEqual([provedor.removerChamadas, await marcadores(empresa), await auditorias(empresa)], [0, [], []], 'sem TLS, nenhuma escrita e nenhum DELETE');
    assert.ok(await ate(async () => (await backendsDoScript()) === 0), 'nenhuma sessão do marcador ficou aberta');
});

test('D2: resposta confirmada ao nosso DELETE grava "duplicata removida" uma vez; reprocessar não grava ausência por cima (sem auditoria duplicada)', async () => {
    const { empresa, pend, provedor } = await cenario();
    const r = await processar(pend, provedor, independenteComPrazo);
    assert.deepEqual([r.r.situacao, r.r.motivo], ['PROCESSADO', 'CONCILIADA']);
    const outra = await emTx(principal, (tx) => registrarPendencia(tx, { empresaId: empresa, assinaturaId: null, motivo: 'COMMIT_INCERTO' }));
    await processar(outra, provedor, independenteComPrazo);
    assert.deepEqual(await auditorias(empresa), [['ASSINATURA_DUPLICADA_REMOVIDA', 'RESPOSTA_DO_PROVEDOR']]);
    assert.deepEqual([await marcadores(empresa), provedor.removerChamadas], [[['PROCESSADO', 'REMOCAO_CONFIRMADA']], 1]);
});
