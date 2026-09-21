// Destructive synthetic fixtures ONLY in an explicitly authorized disposable local database.
// Does not create databases, apply migrations, copy production, or load dotenv.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
const loadTs = createRequire(import.meta.url);
let url;
try { url = new URL(process.env.FESTA_019_TEST_URL ?? 'postgresql://invalid@invalid/invalid'); }
catch { throw Error('Invalid disposable target; no connection attempted'); }
const database = decodeURIComponent(url.pathname.slice(1));
if (!process.argv.includes('--authorize-disposable') || !/^kidmais_019_\d+$/.test(database)
    || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.search || url.hash
    || !['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw Error('Explicit disposable local target and --authorize-disposable required. No connection attempted.');
}
const pool = new Pool({ connectionString: url.toString(), max: 8, connectionTimeoutMillis: 5000,
    options: '-c lock_timeout=5s -c statement_timeout=20000' });
const results = [];
try {
    assert.equal((await pool.query('SELECT current_database() AS db')).rows[0].db, database);
    assert.equal((await pool.query('SELECT count(*)::int n FROM contratos')).rows[0].n, 0, 'Requires synthetic empty business data, schema/catalog through 019 installed separately');
    Object.assign(process.env, { NODE_ENV: 'test', RENDER: 'false', KIDMAIS_DEPLOY_ENV: 'test', DATABASE_URL: url.toString(),
        DATABASE_SSL: 'false', FESTA_ENABLED: 'true', CONTRATO_ACEITE_DEV_ENABLED: 'true', IDENTIDADE_OTP_PEPPER: randomBytes(32).toString('hex') });
    globalThis.__kidmaisPgPool = pool;
    // Existing offline TypeScript loader; no connection or fixture is created on import.
    await import('./pagamentos-test-support.cjs');
    const admin = await loadTs('./admin-test-support.cjs').autenticarTeste(pool);
    const { validarAmbienteFesta } = loadTs('../lib/festas/ambiente.ts');
    await validarAmbienteFesta(pool);
    const cs = loadTs('../lib/contratos/services/administrativo.service.ts');
    const publico = loadTs('../lib/contratos/services/contrato-publico.service.ts');
    const identity = loadTs('../lib/identidade/services/index.ts');
    const festa = loadTs('../lib/festas/service.ts');
    const ctx = () => ({ token: admin.token, requestId: randomUUID(), ip: null, userAgent: 'Synthetic 019 integration' });
    const op = (vid, input) => cs.operarContrato(vid, input, admin.token, ctx());
    // Deliberately do NOT grant FESTA_CRIAR.
    for (const cap of ['FESTA_CONSULTAR', 'FESTA_OPERAR', 'FESTA_CORRIGIR']) {
        await pool.query('INSERT INTO festa_usuario_capacidades(usuario_id,capacidade,concedido_por,motivo) VALUES($1,$2,$1,$3)', [admin.usuarioId, cap, 'Synthetic 019']);
    }
    const check = async (name, work) => { await work(); results.push(name); console.log('PASS ' + name); };
    const config = (await pool.query("SELECT id FROM configuracao_agenda WHERE codigo='TURNO_2'")).rows[0].id;
    const pack = (await pool.query("SELECT id FROM pacotes WHERE codigo='COMPLETA'")).rows[0].id;
    const count = async cid => (await pool.query('SELECT count(*)::int n FROM festas WHERE contrato_id=$1 AND invalidada_em IS NULL', [cid])).rows[0].n;
    const occupied = async day => (await pool.query('SELECT * FROM kidmais_ocupacoes_operacionais($1::date,$1::date)', [day])).rows;
    async function freeze(vid) {
        const e = (await pool.query('SELECT * FROM contrato_edicoes WHERE contrato_versao_id=$1', [vid])).rows[0];
        const d = await op(vid, { acao: 'gerar_pdf', revisao: e.revisao });
        await op(vid, { acao: 'revisar', revisao: e.revisao, documentoId: d.documentoId });
        await op(vid, { acao: 'assinar', revisao: e.revisao, documentoId: d.documentoId, chaveIdempotencia: randomUUID() });
        await op(vid, { acao: 'liberar', revisao: e.revisao });
    }
    async function prepare(day, start = '17:00', end = '21:00') {
        const digits = Array.from({ length: 9 }, () => randomInt(0, 10));
        for (const peso of [10, 11]) { const r = digits.reduce((sum, d, i) => sum + d * (peso - i), 0) * 10 % 11; digits.push(r === 10 ? 0 : r); }
        const total = (await loadTs('../lib/comercial/services/index.ts').calcularResumoComercial({ data: day, configuracaoAgendaId: config, pacoteId: pack, convidados: 50 })).valorTotalTabela;
        const f = (await loadTs('../lib/fechamentos/services/fechamento-publico.service.ts').criarFechamentoPublicoComIdentidade({
            dataEvento: day, horarioInicio: start, horarioFim: end, configuracaoAgendaId: config, pacoteId: pack,
            convidados: 50, valorProposto: total, formaPagamentoPretendida: 'CARTAO_CIELO', identidade: { tipo: 'NOVO_CLIENTE' },
            idadeAniversarianteEvento: 1, cliente: { nomeCompleto: 'Synthetic 019', cpf: digits.join(''), telefone: '11999998888',
                whatsapp: '11999998888', email: randomUUID() + '@example.invalid', cep: '01001000', logradouro: 'Rua Sintética', numero: '1', bairro: 'Centro', cidade: 'São Paulo', uf: 'SP' },
            aniversariante: { nome: 'Synthetic child 019' },
        })).fechamento;
        const c = await loadTs('../lib/contratos/services/contrato.service.ts').gerarContrato({ fechamentoId: f.id }, { usuarioId: admin.usuarioId, origem: 'SISTEMA' });
        await freeze(c.versao.id);
        return { cid: c.contrato.id, vid: c.versao.id, fid: f.id, day };
    }
    async function acceptance(cid) {
        const v = (await pool.query('SELECT v.snapshot FROM contrato_fluxos cf JOIN contrato_versoes v ON v.id=cf.versao_em_preparacao_id WHERE cf.contrato_id=$1', [cid])).rows[0];
        const cpf = v.snapshot.contratante.cpf;
        const access = await publico.consultarAcessoContrato({ contratoId: cid, cpf });
        let code; const sender = async x => { code = x.codigo; };
        const challenge = await publico.iniciarDesafioContrato({ contratoId: cid, cpf, canal: access.canais[0].canal }, sender);
        const proof = await identity.criarIdentityServiceComAmbiente(sender).confirmarCodigo({ validacaoId: challenge.validacaoId, codigo: code });
        const input = { contratoId: cid, acessoToken: challenge.acessoToken, provaToken: proof.provaToken };
        const context = await publico.obterContextoContratoPublico(input);
        return { ...input, versaoId: context.versao.id, snapshotHash: context.versao.snapshotHash, documentoPdfHash: context.versao.documentoPdfHash };
    }
    const accept = input => publico.assinarContratoPublico(input, async () => { throw Error('No external OTP permitted'); }, ctx());
    async function concurrentAccepts(inputs) {
        const backends = new Set();
        let ready = 0, release;
        let timer;
        const barrier = new Promise((resolve, reject) => {
            release = resolve;
            timer = setTimeout(() => reject(Error('Concurrent transaction barrier timed out')), 10000);
        });
        globalThis.__kidmaisPgPool = { query: (...args) => pool.query(...args), connect: async () => {
            const c = await pool.connect();
            return { query: async (sql, values) => {
                const result = await c.query(sql, values);
                if (sql === 'BEGIN') {
                    backends.add((await c.query('SELECT pg_backend_pid() pid')).rows[0].pid);
                    if (++ready === inputs.length) release();
                    await barrier;
                }
                return result;
            }, release: () => c.release() };
        } };
        try {
            const result = await Promise.allSettled(inputs.map(accept));
            assert.equal(backends.size, inputs.length, 'Distinct real transactions must begin before either can proceed');
            return result;
        } finally { clearTimeout(timer); globalThis.__kidmaisPgPool = pool; }
    }
    const a = await prepare('2099-10-05');
    const input = await acceptance(a.cid);
    await check('KIDMAIS alone creates no Festa; divergent document is refused', async () => {
        assert.equal(await count(a.cid), 0);
        assert.equal((await occupied(a.day)).length, 0);
        await assert.rejects(accept({ ...input, documentoPdfHash: '0'.repeat(64) }));
        assert.equal(await count(a.cid), 0);
    });
    await check('audit failure rolls back second signature, Festa and occupancy', async () => {
        globalThis.__kidmaisPgPool = { query: (...args) => pool.query(...args), connect: async () => {
            const c = await pool.connect();
            return { query: (sql, values) => { if (String(sql).includes('INSERT INTO public.auditoria')) throw Error('Synthetic audit fault'); return c.query(sql, values); }, release: () => c.release() };
        } };
        try { await assert.rejects(accept(input)); } finally { globalThis.__kidmaisPgPool = pool; }
        assert.equal(await count(a.cid), 0);
        assert.equal((await occupied(a.day)).length, 0);
        assert.deepEqual((await pool.query('SELECT parte FROM contrato_assinaturas WHERE contrato_versao_id=$1', [a.vid])).rows.map(r => r.parte), ['KIDMAIS']);
    });
    await check('concurrent same-contract accepts and retry produce one Festa without FESTA_CRIAR', async () => {
        const r = await concurrentAccepts([input, input]);
        assert.equal(r.filter(x => x.status === 'fulfilled').length, 2);
        assert.equal(await count(a.cid), 1);
        await accept(input);
        assert.equal(await count(a.cid), 1);
        assert.equal((await occupied(a.day)).length, 1);
        assert.equal((await pool.query("SELECT count(*)::int n FROM festa_eventos e JOIN festas f ON f.id=e.festa_id WHERE f.contrato_id=$1 AND e.tipo='FESTA_CRIADA'", [a.cid])).rows[0].n, 1);
    });
    await check('two overlapping contracts have at most one successful signature', async () => {
        const b = await prepare('2099-10-06'), c = await prepare('2099-10-06');
        const bi = await acceptance(b.cid), ci = await acceptance(c.cid);
        const r = await concurrentAccepts([bi, ci]);
        assert.equal(r.filter(x => x.status === 'fulfilled').length, 1);
        assert.equal(await count(b.cid) + await count(c.cid), 1);
        assert.equal((await occupied(b.day)).length, 1);
        assert(r.some(x => x.status === 'rejected' && ['23514', '40001', '40P01', '55P03'].includes(x.reason?.code)));
    });
    await check('partial interval overlap is refused and public availability uses central occupancy', async () => {
        const b = await prepare('2099-10-13'), c = await prepare('2099-10-13', '18:00', '22:00');
        const bi = await acceptance(b.cid), ci = await acceptance(c.cid);
        await accept(bi);
        await assert.rejects(accept(ci));
        assert.equal(await count(b.cid), 1);
        assert.equal(await count(c.cid), 0);
        assert.equal((await occupied(b.day)).length, 1);
        const availability = await loadTs('../lib/disponibilidade/services/index.ts').consultarDisponibilidadeData(b.day);
        const overlapping = availability.periodos.flatMap(p => p.horarios).filter(h => h.inicio < '21:00' && h.fim > '17:00');
        assert(overlapping.length > 0);
        assert(overlapping.every(h => h.status === 'INDISPONIVEL'));
        await assert.rejects(pool.query("INSERT INTO bloqueios_agenda(data,dia_inteiro,motivo) VALUES($1,true,'Synthetic block must lose')", [b.day]));
    });
    await check('legacy CONFIRMADO without a signed contract still occupies exactly once', async () => {
        const b = await prepare('2099-10-14');
        await pool.query("UPDATE fechamentos SET status='CONFIRMADO' WHERE id=$1", [b.fid]);
        assert.equal((await occupied(b.day)).length, 1);
        assert.equal(await count(b.cid), 0);
        assert.equal((await pool.query('SELECT kidmais019_formalizacao($1,$2) valid', [b.cid, b.vid])).rows[0].valid, false);
    });
    const historical = async cid => JSON.stringify((await pool.query(`SELECT v.id,v.snapshot_hash,v.documento_pdf_hash,
        (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM contrato_assinaturas a WHERE a.contrato_versao_id=v.id) assinaturas,
        (SELECT jsonb_agg(to_jsonb(d) ORDER BY d.id) FROM contrato_documentos d WHERE d.contrato_versao_id=v.id) documentos
        FROM contrato_versoes v WHERE v.contrato_id=$1 AND v.status='ASSINADA' ORDER BY v.id`, [cid])).rows);
    await check('retification reuses Festa, preserves signed base and occupancy', async () => {
        const base = await historical(a.cid);
        const next = await op(a.vid, { acao: 'nova_versao', tipo: 'RETIFICACAO', motivo: 'Synthetic document correction', chaveCriacao: randomUUID() });
        await freeze(next.versaoId);
        await accept(await acceptance(a.cid));
        assert.equal(await count(a.cid), 1);
        assert.equal((await occupied(a.day)).length, 1);
        const old = JSON.parse(base)[0];
        assert.deepEqual(JSON.parse(await historical(a.cid)).find(v => v.id === old.id), old);
        a.vid = next.versaoId;
    });
    await check('new version moves occupancy atomically while preserving Festa and old interval until acceptance', async () => {
        const rs = loadTs('../lib/fechamentos/services/revisao-operacional.service.ts');
        const next = await op(a.vid, { acao: 'nova_versao', tipo: 'NOVA_VERSAO', motivo: 'Synthetic reschedule', chaveCriacao: randomUUID() });
        const src = await rs.fontesPreparacao(next.versaoId);
        const f = src.fechamento, destination = '2099-10-09';
        const e = (await pool.query('SELECT revisao FROM contrato_edicoes WHERE contrato_versao_id=$1', [next.versaoId])).rows[0];
        const fields = Object.fromEntries(['buffetSalgados','buffetBebidas','buffetDoces','buffetBolo','buffetOutros','buffetLembrancinha','buffetEmpratado','buffetBombom','observacoesEquipe'].map(k => [k, f[k] ?? '']));
        const edit = { acao: 'editar_festa', revisao: e.revisao, fonteHash: src.fonteHash, motivo: 'Synthetic reschedule',
            pacoteId: f.pacoteId, convidados: f.convidados, dataEvento: destination, configuracaoAgendaId: f.configuracaoAgendaId,
            horarioInicio: f.horarioInicio.slice(0,5), horarioFim: f.horarioFim.slice(0,5), adicionais: src.adicionais,
            idadeAniversarianteEvento: f.idadeAniversarianteEvento, temaFesta: f.temaFesta ?? '', buffetStatus: f.buffetStatus, ...fields,
            comercial: { confirmarAprovacao: true, forma: 'CARTAO_CIELO', baseNegociada: null, condicaoPix: null } };
        await assert.rejects(op(next.versaoId, { ...edit, dataEvento: '2099-10-06' }));
        assert((await occupied(a.day)).some(o => o.fechamento_id === a.fid));
        await op(next.versaoId, edit);
        assert((await occupied(a.day)).some(o => o.fechamento_id === a.fid));
        assert((await occupied(destination)).some(o => o.fechamento_id === a.fid));
        await freeze(next.versaoId);
        await accept(await acceptance(a.cid));
        assert.equal((await occupied(a.day)).length, 0);
        assert.equal((await occupied(destination)).length, 1);
        assert.equal(await count(a.cid), 1);
        a.day = destination; a.vid = next.versaoId;
    });
    await check('administrative block wins: second signature rolls back and independent block remains', async () => {
        const b = await prepare('2099-10-10'), bi = await acceptance(b.cid);
        const connection = await pool.connect();
        try {
            await connection.query('BEGIN');
            await connection.query("INSERT INTO bloqueios_agenda(data,dia_inteiro,motivo) VALUES($1,true,'Synthetic independent block')", [b.day]);
            const pending = accept(bi).then(() => ({ ok: true }), () => ({ ok: false }));
            await connection.query('COMMIT');
            assert.equal((await pending).ok, false);
            assert.equal(await count(b.cid), 0);
            assert.equal((await pool.query('SELECT count(*)::int n FROM bloqueios_agenda WHERE data=$1 AND ativo', [b.day])).rows[0].n, 1);
        } finally { await connection.query('ROLLBACK'); connection.release(); }
    });
    await check('cancel preserves signed documents and finance; invalidation cannot release an active contract', async () => {
        const f = (await pool.query('SELECT * FROM festas WHERE contrato_id=$1', [a.cid])).rows[0];
        const command = { chave: randomUUID(), revisao: f.revisao, versaoId: a.vid, motivo: 'Synthetic cancellation' };
        await assert.rejects(festa.comandarFesta(f.id, { ...command, acao: 'invalidar' }, ctx()));
        const before = await historical(a.cid);
        await festa.comandarFesta(f.id, { ...command, acao: 'cancelar_contratacao' }, ctx());
        assert.equal((await occupied(a.day)).length, 0);
        assert.equal(await historical(a.cid), before);
        assert.equal((await festa.consultarFestas(ctx(), f.id)).festa.estado, 'CANCELADA');
        await assert.rejects(accept(input));
        await pool.query("INSERT INTO bloqueios_agenda(data,dia_inteiro,motivo) VALUES($1,true,'Synthetic block after cancellation')", [a.day]);
        const availability = await loadTs('../lib/disponibilidade/services/index.ts').consultarDisponibilidadeData(a.day);
        assert(!availability.periodos.some(p => p.horarios.some(h => h.status === 'DISPONIVEL')));
        assert.equal((await pool.query('SELECT count(*)::int n FROM pagamentos')).rows[0].n, 0);
    });
    await check('paid reservation remains single; cancellation preserves financial 015 rows and releases confirmed legacy occupancy', async () => {
        const b = await prepare('2099-10-12');
        await accept(await acceptance(b.cid));
        const payments = loadTs('../lib/pagamentos/services/pagamento.service.ts');
        const paymentContext = { ...ctx(), usuarioId: admin.usuarioId, origem: 'TESTE_019' };
        const value = Number((await pool.query("SELECT snapshot->'comercial'->>'valorFinalContrato' total FROM contrato_versoes WHERE id=$1", [b.vid])).rows[0].total);
        const p = (await payments.criarPagamentoDoFechamento({ fechamentoId: b.fid, plano: { meioPagamento: 'PIX', modalidade: 'AVISTA',
            parcelas: [{ valor: value, vencimento: b.day, confirmaReserva: true }] } }, paymentContext)).detalhe;
        const receipt = { pagamentoId: p.pagamento.id, meioPagamento: 'PIX', valorBruto: value,
            chaveIdempotencia: randomUUID(), alocacoes: [{ parcelaId: p.parcelas[0].id, valor: value }] };
        await payments.registrarRecebimentoPagamento(receipt, paymentContext);
        assert.equal((await pool.query('SELECT status FROM fechamentos WHERE id=$1', [b.fid])).rows[0].status, 'CONFIRMADO');
        assert.equal((await occupied(b.day)).length, 1);
        const tables = (await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND (tablename='pagamentos' OR tablename LIKE 'pagamento_%') ORDER BY tablename")).rows.map(r => r.tablename);
        const financial = async () => {
            const result = {};
            for (const table of tables) {
                assert.match(table, /^[a-z_]+$/);
                result[table] = (await pool.query(`SELECT to_jsonb(t)::text row FROM public.${table} t ORDER BY to_jsonb(t)::text`)).rows;
            }
            return result;
        };
        const before = await financial(), signed = await historical(b.cid);
        await payments.registrarRecebimentoPagamento(receipt, paymentContext);
        assert.deepEqual(await financial(), before);
        assert.equal(await count(b.cid), 1);
        assert.equal((await occupied(b.day)).length, 1);
        const ft = (await pool.query('SELECT * FROM festas WHERE contrato_id=$1', [b.cid])).rows[0];
        await festa.comandarFesta(ft.id, { acao: 'cancelar_contratacao', chave: randomUUID(), revisao: ft.revisao, versaoId: b.vid, motivo: 'Synthetic paid cancellation' }, ctx());
        assert.deepEqual(await financial(), before);
        assert.equal(await historical(b.cid), signed);
        assert.equal((await occupied(b.day)).length, 0);
    });
    await check('financial 015 adjustment after a new signed version preserves one Festa and one occupancy', async () => {
        const b = await prepare('2099-10-15');
        await accept(await acceptance(b.cid));
        const payments = loadTs('../lib/pagamentos/services/pagamento.service.ts');
        const value = Number((await pool.query("SELECT snapshot->'comercial'->>'valorFinalContrato' total FROM contrato_versoes WHERE id=$1", [b.vid])).rows[0].total);
        await payments.criarPagamentoDoFechamento({ fechamentoId: b.fid, plano: { meioPagamento: 'PIX', modalidade: 'AVISTA',
            parcelas: [{ valor: value, vencimento: b.day, confirmaReserva: true }] } }, { ...ctx(), usuarioId: admin.usuarioId, origem: 'TESTE_019' });
        const next = await op(b.vid, { acao: 'nova_versao', tipo: 'NOVA_VERSAO', motivo: 'Synthetic commercial revision', chaveCriacao: randomUUID() });
        const src = await loadTs('../lib/fechamentos/services/revisao-operacional.service.ts').fontesPreparacao(next.versaoId);
        const f = src.fechamento;
        const e = (await pool.query('SELECT revisao FROM contrato_edicoes WHERE contrato_versao_id=$1', [next.versaoId])).rows[0];
        const fields = Object.fromEntries(['buffetSalgados','buffetBebidas','buffetDoces','buffetBolo','buffetOutros','buffetLembrancinha','buffetEmpratado','buffetBombom','observacoesEquipe'].map(k => [k, f[k] ?? '']));
        await op(next.versaoId, { acao: 'editar_festa', revisao: e.revisao, fonteHash: src.fonteHash, motivo: 'Synthetic approved change',
            pacoteId: f.pacoteId, convidados: f.convidados, dataEvento: b.day, configuracaoAgendaId: f.configuracaoAgendaId,
            horarioInicio: f.horarioInicio.slice(0,5), horarioFim: f.horarioFim.slice(0,5), adicionais: src.adicionais,
            idadeAniversarianteEvento: f.idadeAniversarianteEvento, temaFesta: f.temaFesta ?? '', buffetStatus: f.buffetStatus, ...fields,
            comercial: { confirmarAprovacao: true, forma: 'CARTAO_CIELO', baseNegociada: value + 100, condicaoPix: null } });
        await freeze(next.versaoId);
        await accept(await acceptance(b.cid));
        await loadTs('./financeiro-015-test-support.cjs').resolver({ contratoId: b.cid }, ctx());
        assert.equal(await count(b.cid), 1);
        assert.equal((await occupied(b.day)).length, 1);
        assert.equal((await pool.query('SELECT count(*)::int n FROM pagamento_ajustes_contratuais a JOIN pagamento_gestoes g ON g.pagamento_id=a.pagamento_id WHERE g.contrato_id=$1', [b.cid])).rows[0].n, 1);
    });
    console.log(JSON.stringify({ status: 'PASS', checks: results.length, fixturesRemainInDisposableDatabase: true }));
} catch (error) {
    console.error(JSON.stringify({ status: 'FAIL', passed: results, code: error?.code ?? 'ASSERTION_OR_EXECUTION' }));
    process.exitCode = 1;
} finally { delete globalThis.__kidmaisPgPool; await pool.end(); }
