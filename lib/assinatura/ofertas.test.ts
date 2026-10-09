import assert from 'node:assert/strict';
import test from 'node:test';
import type { DbExecutor } from '../db/contracts';
import { conferirCheckoutLegado, confirmarOfertaPaga, consultarOfertas, novosPlanosLigados, prepararOferta, validarPedidoOferta, type Oferta } from './ofertas.ts';
import { pagamentoDaOferta } from './pagamento-oferta.ts';
import { valorDoProvedor, type AssinaturaProvedor, type CobrancaProvedor, type ClienteAsaas } from './asaas.ts';
import { iniciarAssinatura, type DepsCobranca } from './cobranca.ts';
import type { SessaoAdmin } from '../autenticacao/service.ts';
import { sincronizarEmpresa } from './sincronizacao.ts';

const E = '11111111-1111-4111-8111-111111111111', U = '22222222-2222-4222-8222-222222222222';
const env = { ASSINATURA_PLANOS_ATIVOS: 'true', ASAAS_AMBIENTE: 'sandbox' };
const pedido = { plano: 'essencial', ciclo: 'MENSAL', valorEsperadoCentavos: 11820, versao: '2026-10-09' } as const;
const oferta: Oferta = { id: 'contrato', empresa_id: E, plano: 'ESSENCIAL', ciclo: 'MENSAL', valor_regular_centavos: 19700,
    valor_final_centavos: 11820, fundador_id: 'vaga', estado: 'EM_ABERTO', catalogo_versao: pedido.versao };
const sub: AssinaturaProvedor = { id: 'sub_1', customer: 'cus_1', externalReference: E, cycle: 'MONTHLY', status: 'ACTIVE', deleted: false, valorCentavos: 11820 };
const pago: CobrancaProvedor = { id: 'pay_1', status: 'RECEIVED', dueDate: '2026-10-09', paymentDate: '2026-10-09', deleted: false,
    invoiceUrl: null, valorCentavos: 11820, assinaturaId: 'sub_1', clienteId: 'cus_1' };

/** Memória sintética: não interpreta SQL nem substitui homologação de locks/triggers PostgreSQL. */
class Banco implements DbExecutor {
    instalado = true;
    isenta = false;
    linha = { plano: 'UNICO', ciclo: 'MENSAL', documento_teste: '00000000000191', provedor_assinatura_id: null as string | null,
        provedor_cliente_id: null as string | null, situacao: 'TESTE', nome: 'Buffet sintético', hoje: '2026-10-09',
        periodo_atual_fim: null as string | null, em_atraso_desde: null, cancelada_em: null, encerrada_em: null };
    ocupadas = 0;
    confirmadas = 0;
    propria: { id: string; estado: string; vigente: boolean; beneficio_fim: string | null } | null = null;
    contrato: Oferta | null = null;
    sql: string[] = [];
    eventos: { id: string; assinatura_provedor_id: string | null; evento_id: string; concluido: boolean }[] = [];
    async query<Row extends object>(sql: string, args: readonly unknown[] = []) {
        this.sql.push(sql);
        let rows: object[] = [];
        if (sql.includes('AS instalado074')) rows = [{ instalado074: this.instalado }];
        else if (sql.startsWith('SELECT to_regclass')) rows = [{ ok: sql.includes('cobranca_eventos') }];
        else if (sql.startsWith('SELECT to_char((clock_timestamp())')) rows = [{ agora: '2026-10-09T12:00:00.000Z' }];
        else if (sql.includes('AS isenta')) rows = [{ isenta: this.isenta }];
        else if (sql.startsWith('INSERT INTO cobranca_eventos')) {
            const ev = { id: `ev_${this.eventos.length}`, assinatura_provedor_id: args[2] as string | null, evento_id: args[0] as string, concluido: false };
            this.eventos.push(ev); rows = [ev];
        } else if (sql.startsWith('SELECT id, evento_id, assinatura_provedor_id FROM cobranca_eventos')) rows = this.eventos.filter(e => !e.concluido);
        else if (sql.startsWith('UPDATE cobranca_eventos')) {
            const ids = Array.isArray(args[1]) ? args[1] : [args[0]];
            for (const e of this.eventos) if (ids.includes(e.id)) e.concluido = true;
        } else if (sql.startsWith('INSERT INTO auditoria')) rows = [];
        else if (sql.startsWith('UPDATE empresa_assinaturas SET situacao')) {
            this.linha.situacao = args[1] as string; this.linha.periodo_atual_fim = args[3] as string;
            if (args[8]) this.linha.plano = args[8] as string;
        } else if (sql.startsWith('UPDATE empresa_assinaturas SET provedor_situacao')) rows = [];
        else if (sql.startsWith("UPDATE empresa_assinaturas SET provedor = 'ASAAS'")) {
            this.linha.provedor_cliente_id = args[1] as string;
            this.linha.provedor_assinatura_id = args[2] as string;
        }
        else if (sql.startsWith('SELECT id FROM empresas') || sql.includes('pg_advisory_xact_lock')) rows = [];
        else if (sql.includes('EXISTS (SELECT 1 FROM assinatura_contratacoes')) rows = [{ ...this.linha, aberta: this.contrato?.estado === 'EM_ABERTO' }];
        else if (sql.includes('FROM empresa_assinaturas')) rows = [this.linha];
        else if (sql.includes('count(*) FILTER')) rows = [{ ocupadas: this.ocupadas, confirmadas: this.confirmadas }];
        else if (sql.startsWith('SELECT') && sql.includes('FROM assinatura_fundadores')) rows = this.propria ? [{ ...this.propria }] : [];
        else if (sql.includes('INSERT INTO assinatura_fundadores')) {
            this.propria = { id: 'vaga', estado: 'RESERVADA', vigente: true, beneficio_fim: null };
            this.ocupadas++; rows = [this.propria];
        } else if (sql.includes('INSERT INTO assinatura_contratacoes')) {
            this.contrato = { ...oferta, empresa_id: args[0] as string, plano: args[2] as Oferta['plano'], ciclo: args[3] as Oferta['ciclo'],
                valor_regular_centavos: args[5] as number, valor_final_centavos: args[7] as number, fundador_id: args[8] as string | null };
            rows = [this.contrato];
        } else if (sql.startsWith('UPDATE assinatura_fundadores')) {
            this.propria!.estado = 'CONFIRMADA'; this.propria!.beneficio_fim = '2027-10-09T12:00:00.000Z';
        } else if (sql.startsWith('UPDATE assinatura_contratacoes')) {
            // Devolver cópias na leitura reproduz o snapshot recebido pelo repository.
            this.contrato = { ...this.contrato!, estado: 'CONFIRMADA', pagamento_confirmacao_id: args[2] as string };
        } else if (sql.includes('FROM assinatura_contratacoes')) rows = this.contrato ? [{ ...this.contrato }] : [];
        else throw new Error(`SQL não modelado no teste: ${sql}`);
        return { rows: rows as Row[], rowCount: rows.length };
    }
}

test('novos planos só em sandbox explícito; pedido não aceita preço/catálogo/plano adulterado', () => {
    assert.equal(novosPlanosLigados(env), true);
    for (const e of [{}, { ...env, ASAAS_AMBIENTE: 'production' }, { ...env, ASSINATURA_PLANOS_ATIVOS: 'false' }]) assert.equal(novosPlanosLigados(e), false);
    for (const p of [null, {}, { ...pedido, plano: '__proto__' }, { ...pedido, ciclo: 'WEEKLY' }, { ...pedido, valorEsperadoCentavos: 1.1 }, { ...pedido, versao: 'velha' }])
        assert.throws(() => validarPedidoOferta(p));
    assert.deepEqual(validarPedidoOferta(pedido), pedido);
});

test('reserva automática e retomada idempotente mantêm uma vaga e um snapshot', async () => {
    const db = new Banco();
    const primeira = await prepararOferta(db, E, U, pedido);
    assert.equal(primeira.valor_final_centavos, 11820);
    assert.equal(primeira.valor_regular_centavos, 19700);
    assert.deepEqual(await prepararOferta(db, E, U, pedido), primeira);
    assert.equal(db.sql.filter(s => s.includes('INSERT INTO assinatura_fundadores')).length, 1);
    assert.equal(db.sql.filter(s => s.includes('INSERT INTO assinatura_contratacoes')).length, 1);
    await assert.rejects(prepararOferta(db, E, U, { ...pedido, plano: 'premium' }), /em andamento/);
});

test('vigésima vaga disponível; 20 reservas aguardam, 20 confirmadas exigem confirmação do preço cheio', async () => {
    const db = new Banco(); db.ocupadas = 19; db.confirmadas = 19;
    assert.equal((await prepararOferta(db, E, U, pedido)).fundador_id, 'vaga');
    const cheio = new Banco(); cheio.ocupadas = 20; cheio.confirmadas = 19;
    await assert.rejects(prepararOferta(cheio, E, U, pedido), /em confirmação/);
    cheio.confirmadas = 20;
    await assert.rejects(prepararOferta(cheio, E, U, pedido), /condições disponíveis mudaram/);
    const normal = await prepararOferta(cheio, E, U, { ...pedido, valorEsperadoCentavos: 19700 });
    assert.equal(normal.fundador_id, null);
    assert.equal(normal.valor_final_centavos, 19700);
});

test('sem schema, isenta, empresa legada vinculada e plano ativo não criam oferta', async () => {
    for (const configurar of [
        (b: Banco) => { b.instalado = false; }, (b: Banco) => { b.isenta = true; },
        (b: Banco) => { b.linha.provedor_assinatura_id = 'legado'; }, (b: Banco) => { b.linha.plano = 'PREMIUM'; },
    ]) {
        const db = new Banco(); configurar(db);
        await assert.rejects(prepararOferta(db, E, U, pedido));
        assert.equal(db.sql.some(s => s.startsWith('INSERT')), false);
    }
});

test('endpoint legado não contorna escolha de plano, oferta pendente nem ciclo contratado', async () => {
    const db = new Banco();
    await assert.rejects(conferirCheckoutLegado(db, E, 'MENSAL', env));
    assert.equal(await conferirCheckoutLegado(db, E, 'MENSAL', {}), false);
    db.contrato = oferta;
    await assert.rejects(conferirCheckoutLegado(db, E, 'MENSAL', {}));
    db.contrato = null; db.linha.plano = 'ESSENCIAL'; db.linha.provedor_assinatura_id = 'sub_1';
    assert.equal(await conferirCheckoutLegado(db, E, 'MENSAL', {}), true);
    await assert.rejects(conferirCheckoutLegado(db, E, 'ANUAL', {}));
    db.linha.plano = 'UNICO';
    assert.equal(await conferirCheckoutLegado(db, E, 'MENSAL', env), false, 'legado vinculado preservado');
});

test('checkout exige Gestão antes de reservar vaga ou chamar o provedor', async () => {
    const db = new Banco();
    const deps: DepsCobranca = {
        env, provedor: () => ({} as NonNullable<ReturnType<DepsCobranca['provedor']>>),
        withTenantTransaction: async (_s, _e, f) => f(db, { empresaComprovada: E, membershipId: 'm', usuarioId: U, papelAtual: 'ADMINISTRATIVO' }),
        withTransaction: async f => f(db), travarContratacao: async (_e, f) => f(),
    };
    await assert.rejects(iniciarAssinatura({ usuario_id: U } as SessaoAdmin, null, pedido, { requestId: 'r' }, deps), /Somente a Gestão/);
    assert.equal(db.sql.length, 0);
});

test('pagamento requer identificação exata, ciclo, valor, status e data válidos', () => {
    assert.equal(pagamentoDaOferta(oferta, sub, [pago], 'cus_1')?.id, pago.id);
    for (const alt of [{ valorCentavos: 1 }, { valorCentavos: undefined }, { clienteId: 'outra' }, { assinaturaId: 'outra' },
        { status: 'PENDING' }, { status: 'REFUNDED' }, { status: 'RECEIVED_IN_CASH' }, { deleted: true }, { dueDate: '2026-02-30' }])
        assert.equal(pagamentoDaOferta(oferta, sub, [{ ...pago, ...alt }], 'cus_1'), null);
    for (const alt of [{ customer: 'outra' }, { externalReference: 'outra' }, { externalReference: null }, { cycle: 'YEARLY' }])
        assert.equal(pagamentoDaOferta(oferta, { ...sub, ...alt }, [pago], 'cus_1'), null);
    assert.equal(pagamentoDaOferta(oferta, sub, [pago], null), null);
});

test('pagamento posterior divergente não pode ampliar acesso por um pagamento anterior válido', () => {
    const depois = { ...pago, id: 'pay_2', dueDate: '2026-11-09', valorCentavos: 1 };
    for (const lista of [[pago, depois], [depois, pago]]) assert.equal(pagamentoDaOferta(oferta, sub, lista, 'cus_1'), null);
    assert.equal(pagamentoDaOferta(oferta, sub, [pago, { ...depois, status: 'RECEIVED_IN_CASH' }], 'cus_1'), null);
});

test('renovação mensal após 12 meses exige preço normal; pagar atrasado não prolonga desconto', () => {
    const fim = '2027-10-09T12:00:00.000Z';
    const depois = { ...pago, dueDate: '2027-10-09' };
    assert.equal(pagamentoDaOferta(oferta, sub, [depois], 'cus_1', fim), null);
    assert.ok(pagamentoDaOferta(oferta, sub, [{ ...depois, valorCentavos: 19700 }], 'cus_1', fim));
    assert.ok(pagamentoDaOferta(oferta, sub, [{ ...pago, dueDate: '2027-09-09', paymentDate: '2027-10-10' }], 'cus_1', fim));
});

test('segundo pagamento anual é normal mesmo se primeiro pagamento foi confirmado atrasado', () => {
    const anual: Oferta = { ...oferta, ciclo: 'ANUAL', estado: 'CONFIRMADA', pagamento_confirmacao_id: pago.id, valor_final_centavos: 118200, valor_regular_centavos: 197000 };
    const a = { ...sub, cycle: 'YEARLY' };
    const p = { ...pago, id: 'renovacao', dueDate: '2027-10-09', valorCentavos: 118200 };
    assert.equal(pagamentoDaOferta(anual, a, [p], 'cus_1', '2027-10-20T12:00:00.000Z'), null);
    assert.ok(pagamentoDaOferta(anual, a, [{ ...p, valorCentavos: 197000 }], 'cus_1', '2027-10-20T12:00:00.000Z'));
});

test('confirmar oferta persiste vaga e contrato uma vez; reentrega não atualiza histórico', async () => {
    const db = new Banco(); await prepararOferta(db, E, U, pedido);
    assert.deepEqual(await confirmarOfertaPaga(db, E, sub, [pago], 'cus_1'), { id: 'contrato', plano: 'ESSENCIAL' });
    const escritas = db.sql.filter(s => s.startsWith('UPDATE')).length;
    assert.equal(await confirmarOfertaPaga(db, E, sub, [pago], 'cus_1'), null);
    assert.equal(db.sql.filter(s => s.startsWith('UPDATE')).length, escritas);
    assert.equal(db.propria?.estado, 'CONFIRMADA');
});

test('pagamento errado não confirma; confirmação de outra empresa não é aceita', async () => {
    const db = new Banco(); await prepararOferta(db, E, U, pedido);
    await assert.rejects(confirmarOfertaPaga(db, E, { ...sub, externalReference: 'outra' }, [pago], 'cus_1'), /não corresponde/);
    assert.equal(db.contrato?.estado, 'EM_ABERTO');
    assert.equal(db.propria?.estado, 'RESERVADA');
    assert.equal(db.sql.some(s => s.startsWith('UPDATE')), false);
});

test('consulta não oferece plano novo à empresa isenta ou contrato já ativo', async () => {
    const db = new Banco(); db.isenta = true;
    assert.equal((await consultarOfertas(db, E, env))?.habilitado, false);
    db.isenta = false; db.linha.plano = 'PREMIUM';
    assert.equal((await consultarOfertas(db, E, env))?.habilitado, false);
});

test('conversão do provedor exige centavos exatos e não aceita strings ou valores não finitos', () => {
    assert.equal(valorDoProvedor(118.2), 11820);
    for (const valor of ['118.20', 1.001, NaN, Infinity, -1, 0, null]) assert.equal(valorDoProvedor(valor), null);
});

function checkoutSintetico(db: Banco) {
    let criada: AssinaturaProvedor | null = null;
    let criacoes = 0;
    let valorFatura = 11820;
    const provedor: ClienteAsaas = {
        buscarClientePorReferencia: async () => ({ id: 'cus_1', externalReference: E }),
        criarCliente: async () => { throw new Error('Cliente já existe no mock.'); },
        obterAssinatura: async () => criada,
        listarAssinaturasPorReferencia: async () => criada ? [criada] : [],
        criarAssinatura: async input => {
            assert.equal(input.valorCentavos, 11820);
            assert.ok(db.eventos.some(e => e.evento_id.startsWith('kidmais:criacao:')), 'intenção durável precede POST');
            criacoes++; criada = { ...sub }; return criada;
        },
        listarCobrancasDaAssinatura: async () => [{ ...pago, status: 'PENDING', valorCentavos: valorFatura, invoiceUrl: 'https://sandbox.asaas.com/i/pay_1' }],
        removerAssinatura: async () => { throw new Error('Não deve remover nesta operação.'); },
    };
    const deps: DepsCobranca = { env, provedor: () => provedor,
        withTenantTransaction: async (_s, _e, f) => f(db, { empresaComprovada: E, membershipId: 'm', usuarioId: U, papelAtual: 'REPRESENTANTE_AUTORIZADO' }),
        withTransaction: async f => f(db), travarContratacao: async (_e, f) => f() };
    return { deps, criacoes: () => criacoes, adulterar: () => { valorFatura = 1; } };
}

test('checkout novo cria pelo snapshot, retoma sem duplicar e não libera acesso antes de pagar', async () => {
    const db = new Banco(); const f = checkoutSintetico(db);
    const iniciar = () => iniciarAssinatura({ usuario_id: U } as SessaoAdmin, null, pedido, { requestId: 'r' }, f.deps);
    const primeiro = await iniciar();
    assert.equal(primeiro.urlPagamento, 'https://sandbox.asaas.com/i/pay_1');
    assert.equal(primeiro.reaproveitada, false);
    const segundo = await iniciar();
    assert.equal(segundo.reaproveitada, true);
    assert.equal(f.criacoes(), 1);
    assert.equal(db.linha.situacao, 'TESTE');
    assert.equal(db.linha.plano, 'UNICO');
    assert.equal(db.contrato?.estado, 'EM_ABERTO');
    assert.equal(db.propria?.estado, 'RESERVADA');
});

test('fatura divergente não é apresentada; retry reencontra assinatura sem emitir outra', async () => {
    const db = new Banco(); const f = checkoutSintetico(db); f.adulterar();
    const iniciar = () => iniciarAssinatura({ usuario_id: U } as SessaoAdmin, null, pedido, { requestId: 'r' }, f.deps);
    await assert.rejects(iniciar(), /cobrança não corresponde/);
    await assert.rejects(iniciar(), /cobrança não corresponde/);
    assert.equal(f.criacoes(), 1);
    assert.equal(db.linha.provedor_assinatura_id, null);
    assert.equal(db.linha.situacao, 'TESTE');
});

test('sincronização vincula o plano pago; reentrega não consome vaga nem confirma contrato de novo', async () => {
    const db = new Banco(); const f = checkoutSintetico(db);
    await iniciarAssinatura({ usuario_id: U } as SessaoAdmin, null, pedido, { requestId: 'r' }, f.deps);
    const provider = f.deps.provedor()!;
    provider.listarCobrancasDaAssinatura = async () => [pago];
    await sincronizarEmpresa(db, E, { provedor: provider }, { tipo: 'RECONCILIACAO' });
    assert.equal(db.linha.plano, 'ESSENCIAL');
    assert.equal(db.linha.situacao, 'ATIVA');
    assert.equal(db.contrato?.estado, 'CONFIRMADA');
    const gravacoes = db.sql.filter(s => s.startsWith('UPDATE assinatura_')).length;
    await sincronizarEmpresa(db, E, { provedor: provider }, { tipo: 'RECONCILIACAO' });
    assert.equal(db.sql.filter(s => s.startsWith('UPDATE assinatura_')).length, gravacoes);
    const periodo = db.linha.periodo_atual_fim;
    provider.listarCobrancasDaAssinatura = async () => [pago, { ...pago, id: 'cash', status: 'RECEIVED_IN_CASH', dueDate: '2026-11-09' }];
    await assert.rejects(sincronizarEmpresa(db, E, { provedor: provider }, { tipo: 'RECONCILIACAO' }), /não corresponde/);
    assert.equal(db.linha.periodo_atual_fim, periodo);
});

test('plano confirmado retoma cobrança sem preços legados; encerrado nunca recria pelo preço antigo', async () => {
    const db = new Banco(); const f = checkoutSintetico(db);
    const s = { usuario_id: U } as SessaoAdmin;
    await iniciarAssinatura(s, null, pedido, { requestId: 'r' }, f.deps);
    await confirmarOfertaPaga(db, E, sub, [pago], 'cus_1'); db.linha.plano = 'ESSENCIAL';
    const r = await iniciarAssinatura(s, null, { ciclo: 'MENSAL' }, { requestId: 'r' }, f.deps);
    assert.equal(r.reaproveitada, true);
    f.deps.provedor()!.obterAssinatura = async () => null;
    await assert.rejects(iniciarAssinatura(s, null, { ciclo: 'MENSAL' }, { requestId: 'r' }, f.deps), /recontratação/);
    assert.equal(f.criacoes(), 1);
});
