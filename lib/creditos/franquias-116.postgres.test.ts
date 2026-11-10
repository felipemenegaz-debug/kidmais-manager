import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Client } from 'pg';
import { conectarDescartavel, encerrarDescartavel } from '../comercial/postgres-descartavel.ts';
import type { DbExecutor } from '../db/contracts';
import { iniciarTeste } from '../assinatura/servico.ts';
import { prepararOferta } from '../assinatura/ofertas.ts';
import { valorComercial } from '../assinatura/planos-comerciais.ts';
import { processarEvento, sincronizarEmpresa } from '../assinatura/sincronizacao.ts';
import { registrarPendencia } from '../assinatura/reconciliacao-contratacao.ts';
import { gravarResultadoCancelamento } from '../assinatura/devolucao.ts';
import type { AssinaturaProvedor, CobrancaProvedor } from '../assinatura/asaas.ts';
import { DOCUMENTOS, hashDocumento } from '../cadastro/documentos-legais.ts';
import { diferenca, efeitosPresentes, semEfeito } from '../assinatura/recuperacao-efeitos.ts';
import { fotografar, regravarDoInstante } from '../assinatura/recuperacao-fotografia.ts';
import type { Efeito } from '../assinatura/recuperacao-hash.ts';
import { abrirCarteira, creditarLote, encerrarReserva, reservar } from './ledger.ts';
import { manutencaoEmpresa } from './manutencao.ts';
import { avisosDeUsoFranquia, FranquiaEmConflito, franquiasInstaladas, PlanoIlegivel, processarPendenciasFranquia, reconhecerFranquia, usoDaFranquia, registrarPendenciaFranquia } from './franquias.ts';
import type { PlanoFranquia } from './franquias-regra.ts';

/**
 * F1 das franquias por plano (plano rev. 4.1; D-FR-1..12) no PostgreSQL DESCARTÁVEL, modelo 112 (sem a 116; a suíte aplica).
 * Dados SINTÉTICOS; provedor FALSO (nenhuma rede). Datas de confirmação são fixture: gravadas com os gatilhos desligados
 * nesta sessão (session_replication_role = replica, só no cluster descartável); os CHECKs continuam valendo.
 *   1. sem a 116: código novo compatível (flag ligada segue o legado; pendência não registrada e a transação segue);
 *   2. precheck, aplicação, postcheck, reaplicação recusada, rollback vazio aceito e reaplicação;
 *   3. flag desligada = caminho legado byte a byte (nenhuma linha da 116);
 *   4. categorias: SEM_CORTE, MES_DO_CORTE, SEM_LIMITE (teste/isenta), HISTORICO_DIVERGENTE, ACESSO_NAO_COMPLETO;
 *   5. recorrente, upgrade no mês (complemento :R2), ida e volta, adoção do lote legado, repetição sem efeito, só inserção;
 *   6. conflito de chave é erro (pendência registra CHAVE_EM_CONFLITO);
 *   7. corrida REAL de três sessões: confirmação segurando a assinatura × pendência × worker (espera observada);
 *   8. pendência gravada pela sincronização real (sincronizarEmpresa) e processada;
 *   9. avisos 80/100 (um aviso por marco, sem duplicar ao saltar para 100);
 *  10. rollback recusado com dados, sem efeito.
 * Rodada 2 (revisão r1 do Astra): valores esperados LITERAIS por tamanho do mês (nunca a própria regra como oráculo) e
 *  11. os exemplos do §4.2 e o histórico gravado (contratação e instante, inclusive a inicial);
 *  12. fronteira do mês em São Paulo × UTC;  13. plano desconhecido;  14. falha do INSERT no SAVEPOINT da pendência;
 *  15. atomicidade crédito → trilha;  16. avisos com saldos mistos e vencimentos (§4.6);
 *  17. postcheck: pendência legítima aceita, definições/NOT NULL/NOT VALID/gatilho/dados divergentes recusados;
 *  18–20. corridas REAIS sem deadlock (gatilhos ativos): manutenção × sincronização nas duas ordens e × geração de convites;
 *  21. B-14 com a 116: a pendência é efeito na proposta e na aplicação, repetir não gera, instante anterior = divergente.
 * Rodada 3 (revisão r2 do Astra):
 *  22–23. corrida com a RECONCILIAÇÃO REAL (processarEvento → reconciliarContratacao): CONCILIADA com o marcador gravado na
 *         transação independente e a promoção da empresa pela sincronização; VINCULADA com a promoção pelo gatilho 074a;
 *  24. devolução D1 e B-14 regravar: empresa antes da assinatura (quem espera a empresa não segura a assinatura);
 *  25. base e uso dos avisos com valores literais: bloqueio, cancelamento, reservas e franquia antiga ainda vigente.
 */
const ler = (f: string) => readFileSync(f, 'utf8');
const UP = ler('database/migrations/20261103_116_franquias_ciclo.sql');
const PRE = ler('database/checks/20261103_116_precheck.sql');
const POS = ler('database/checks/20261103_116_postcheck.sql');
const DOWN = ler('database/rollback/20261103_116_franquias_ciclo_down.sql');
const opt = () => process.env.KIDMAIS_POSTGRES_DESCARTAVEL === 'kidmais_pacotes_v1_descartavel';
const LIGADA = { CREDITOS_FRANQUIA_PLANO_ATIVO: 'true' };
const SENHA_FALSA = `scrypt$v=1$N=131072$r=8$p=1$${'A'.repeat(22)}==$${'B'.repeat(86)}==`;
// Corte do legado num mês passado (a carteira CONVITES exige corte_em; o mês do corte é coberto à parte, no cenário 4).
const CORTE = '2026-01-15T12:00:00.000Z';
const ENV_PLANOS = { ASSINATURA_PLANOS_ATIVOS: 'true', ASAAS_AMBIENTE: 'sandbox' };

let c: Client;
let usuario = '';
let seq = 0;
const q = (sql: string, v: unknown[] = []) => c.query(sql, v);
function emTx(db: Client) {
    return async <T>(w: (tx: DbExecutor) => Promise<T>): Promise<T> => {
        await db.query('BEGIN');
        try { const r = await w(db as unknown as DbExecutor); await db.query('COMMIT'); return r; }
        catch (e) { await db.query('ROLLBACK'); throw e; }
    };
}
const tx = emTx;
/** Fixture com os gatilhos desligados nesta transação (só datas e estados sintéticos; CHECKs valem). */
async function fixture(f: () => Promise<unknown>) {
    await q('BEGIN');
    try { await q('SET LOCAL session_replication_role = replica'); await f(); await q('COMMIT'); }
    catch (e) { await q('ROLLBACK'); throw e; }
}
// Meio-dia do dia `dia` do mês corrente em São Paulo; dia ≤ 0 cai no mês anterior.
const QUANDO = `(date_trunc('month', clock_timestamp() AT TIME ZONE 'America/Sao_Paulo') + make_interval(days => $1::int - 1, hours => 12)) AT TIME ZONE 'America/Sao_Paulo'`;
async function mes() {
    const r = (await q(`SELECT to_char(date_trunc('month', clock_timestamp() AT TIME ZONE 'America/Sao_Paulo'), 'YYYY-MM-DD') AS ciclo,
        extract(day FROM date_trunc('month', clock_timestamp() AT TIME ZONE 'America/Sao_Paulo') + interval '1 month' - interval '1 day')::int AS dias`)).rows[0];
    return { ciclo: r.ciclo as string, dias: Number(r.dias), chave: `FRANQUIA:${(r.ciclo as string).slice(0, 7)}` };
}

async function empresa(nome = 'Buffet Franquia') {
    const e = (await q("INSERT INTO empresas (codigo, nome, status) VALUES ($1, $2, 'PROVISIONAMENTO') RETURNING id::text AS id", [`fq${++seq}${randomBytes(3).toString('hex')}`, nome])).rows[0].id as string;
    await q("UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid", [e]);
    return e;
}
// Início do mês seguinte em São Paulo deslocado de $1 minutos (−1 = último minuto deste ciclo; 0 = fim exato).
const FIM_DO_MES = `(date_trunc('month', clock_timestamp() AT TIME ZONE 'America/Sao_Paulo') + interval '1 month' + make_interval(mins => $1::int)) AT TIME ZONE 'America/Sao_Paulo'`;
/** Contratação CONFIRMADA no instante `quando` (SQL com $1 = `n`; fixture) — devolve o id. */
async function confirmadaEm(e: string, plano: PlanoFranquia, quando: string, n: number) {
    let idc = '';
    await fixture(async () => {
        idc = (await q(`INSERT INTO assinatura_contratacoes (empresa_id, chave_idempotencia, plano, ciclo, catalogo_versao, valor_regular_centavos, valor_final_centavos,
                criada_por, criada_em, estado, confirmada_em, pagamento_confirmacao_id, provedor_assinatura_id)
            VALUES ($2, $3, $4, 'MENSAL', 'sintetico', 9900, 9900, $5, ${quando} - interval '1 hour', 'CONFIRMADA', ${quando}, $6, $7) RETURNING id::text AS id`,
        [n, e, randomUUID(), plano.toUpperCase(), usuario, `pay_${randomBytes(5).toString('hex')}`, `sub_${randomBytes(5).toString('hex')}`])).rows[0].id;
    });
    return idc;
}
/** Contratação CONFIRMADA no dia `dia` (meio-dia em São Paulo). */
const confirmada = (e: string, plano: PlanoFranquia, dia: number) => confirmadaEm(e, plano, QUANDO, dia);
/** Valor esperado LITERAL para o tamanho do mês corrente (28–31 dias). */
async function literal(t: Record<28 | 29 | 30 | 31, number>) {
    const { dias } = await mes();
    return t[dias as 28 | 29 | 30 | 31];
}
async function vigente(e: string, contratacao: string, plano: PlanoFranquia) {
    await fixture(() => q('UPDATE empresa_assinaturas SET contratacao_atual_id = $2::uuid, plano = $3 WHERE empresa_id = $1::uuid', [e, contratacao, plano.toUpperCase()]));
}
/** Empresa ATIVA com assinatura paga, carteira CONVITES aberta e o histórico [(plano, dia)]; o último é o vigente. */
async function comPlano(historico: [PlanoFranquia, number][], o: { carteira?: boolean; legado?: number } = {}) {
    const e = await empresa();
    await fixture(async () => {
        await q(`INSERT INTO empresa_assinaturas (empresa_id, situacao, teste_inicio, teste_fim) VALUES ($1::uuid, 'TESTE', clock_timestamp() - interval '80 days', clock_timestamp() - interval '65 days')`, [e]);
        await q(`UPDATE empresa_assinaturas SET situacao = 'ATIVA', ciclo = 'MENSAL', provedor = 'ASAAS', provedor_assinatura_id = $2, periodo_atual_fim = clock_timestamp() + interval '20 days'
            WHERE empresa_id = $1::uuid`, [e, `sub_${randomBytes(5).toString('hex')}`]);
    });
    let atual = '';
    for (const [plano, dia] of historico) { atual = await confirmada(e, plano, dia); await vigente(e, atual, plano); }
    if (o.legado) await q('INSERT INTO convite_carteiras (empresa_id, limite_mensal, ativo) VALUES ($1::uuid, $2, true)', [e, o.legado]);
    if (o.carteira !== false) await tx(c)((t) => abrirCarteira(t, e, 'CONVITES', CORTE));
    return { e, atual };
}
const reconhecer = (e: string, db: Client = c) => tx(db)((t) => reconhecerFranquia(t, e));
const linhas = async (e: string) => (await q(`SELECT chave, tipo, concedido::int AS concedido, devido_calculado::int AS devido, contratacao_id::text AS contratacao
    FROM ia_credito_franquias_ciclo WHERE empresa_id = $1::uuid ORDER BY criado_em, chave`, [e])).rows;
const lotes = async (e: string) => (await q(`SELECT chave_origem, origem, quantidade::int AS quantidade FROM ia_credito_lotes WHERE empresa_id = $1::uuid AND recurso = 'CONVITES' ORDER BY chave_origem`, [e])).rows;
const consumirDe = (e: string, n: number, op: string) => tx(c)(async (t) => {
    await reservar(t, { empresaId: e, recurso: 'CONVITES', operacaoId: op, quantidade: n, ator: 'SISTEMA' });
    await encerrarReserva(t, { empresaId: e, recurso: 'CONVITES', operacaoId: op, quantidadeFinal: n, ator: 'SISTEMA' });
});

/** Empresa em teste com carteira e uma oferta Premium pronta; `sincronizar` roda a sincronização REAL com provedor FALSO (pago hoje). */
async function empresaSincronizavel(nome: string) {
    const n = ++seq;
    const doc = (() => {
        const base = `7${String(n).padStart(7, '0')}0001`;
        const dv = (b: string) => { let s = 0, p = 2; for (let i = b.length - 1; i >= 0; i--) { s += (b.charCodeAt(i) - 48) * p; p = p === 9 ? 2 : p + 1; } const r = s % 11; return r <= 1 ? 0 : 11 - r; };
        const d1 = dv(base); return base + d1 + dv(base + d1);
    })();
    const e = await empresa(nome);
    await q(`INSERT INTO plataforma_empresas_cadastro (empresa_id, nome_empresarial, documento_fiscal, responsavel_nome, email, criado_por, atualizado_por)
        VALUES ($1, 'Festas Franquia Ltda', $2, 'Responsável', $3, $4, $4)`, [e, doc, `fq${n}@example.test`, usuario]);
    await tx(c)((t) => iniciarTeste(t as never, { empresaId: e, documento: doc }));
    await tx(c)((t) => abrirCarteira(t, e, 'CONVITES', CORTE));
    const documentos = Object.fromEntries(Object.values(DOCUMENTOS).map((d) => [d.documento, { versao: d.versao, hash: hashDocumento(d) }]));
    const pedido = (valor: number) => ({ plano: 'premium' as const, ciclo: 'MENSAL' as const, valorEsperadoCentavos: valor, versao: '2026-10-20', documentos });
    const oferta = await tx(c)((t) => prepararOferta(t, e, usuario, pedido(valorComercial('premium', 'mensal', true)), ENV_PLANOS))
        .catch(() => tx(c)((t) => prepararOferta(t, e, usuario, pedido(valorComercial('premium', 'mensal', false)), ENV_PLANOS)));
    const hoje = (await q("SELECT to_char(clock_timestamp() AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS d")).rows[0].d as string;
    const id = randomBytes(4).toString('hex');
    const sub: AssinaturaProvedor = { id: `sub_${id}`, customer: `cus_${id}`, externalReference: e, cycle: 'MONTHLY', status: 'ACTIVE', deleted: false, valorCentavos: oferta.valor_final_centavos };
    const pay = { id: `pay_${id}`, status: 'RECEIVED', dueDate: hoje, paymentDate: hoje, deleted: false, invoiceUrl: null, valorCentavos: oferta.valor_final_centavos,
        assinaturaId: sub.id, clienteId: sub.customer, billingType: 'PIX' } as CobrancaProvedor;
    const provedor = {
        async obterAssinatura(x: string) { return x === sub.id ? { ...sub } : null; },
        async listarCobrancasDaAssinatura(x: string) { return x === sub.id ? [{ ...pay }] : []; },
        async listarAssinaturasPorReferencia(ref: string) { return ref === e ? [{ ...sub }] : []; },
    };
    await q("UPDATE empresa_assinaturas SET provedor = 'ASAAS', provedor_cliente_id = $2, provedor_assinatura_id = $3 WHERE empresa_id = $1", [e, sub.customer, sub.id]);
    const sincronizar = (db: Client) => tx(db)((t) => sincronizarEmpresa(t as never, e, { provedor: provedor as never }, { tipo: 'RECONCILIACAO' }));
    return { e, oferta, hoje, provedor, sincronizar, sub };
}
async function esperarBloqueio(obs: Client, pid: number, bloqueador: number) {
    for (let i = 0; i < 400; i++) {
        if ((await obs.query<{ b: number[] }>('SELECT pg_blocking_pids($1::int) AS b', [pid])).rows[0].b.map(Number).includes(bloqueador)) return true;
        await new Promise((f) => setTimeout(f, 25));
    }
    return false;
}
const pidDe = async (db: Client) => Number((await db.query<{ p: number }>('SELECT pg_backend_pid() AS p')).rows[0].p);

test.before(async () => {
    if (!opt()) return;
    c = await conectarDescartavel();
    usuario = (await q("INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Gestão Franquias', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id::text AS id",
        [`fq${randomBytes(3).toString('hex')}@example.test`, SENHA_FALSA])).rows[0].id;
});
test.after(async () => { if (c) await encerrarDescartavel(c); });

test('1. sem a 116: flag ligada segue o legado; pendência não registrada e a transação continua', { skip: !opt() }, async () => {
    assert.equal(await tx(c)((t) => franquiasInstaladas(t)), false);
    const { e, atual } = await comPlano([['premium', -5]], { legado: 7 });
    const m = await tx(c)((t) => manutencaoEmpresa(t, e, LIGADA));
    assert.deepEqual(m.franquia, { concedida: true, motivo: null, porPlano: false }, 'caminho legado: limite da convite_carteiras');
    assert.deepEqual(await lotes(e), [{ chave_origem: (await mes()).chave, origem: 'FRANQUIA', quantidade: 7 }]);
    const r = await tx(c)(async (t) => { const criada = await registrarPendenciaFranquia(t, e, atual); return { criada, ok: (await t.query('SELECT 1 AS ok')).rows[0].ok }; });
    assert.deepEqual(r, { criada: false, ok: 1 });
    assert.deepEqual(await processarPendenciasFranquia(tx(c)), { processadas: 0, concedidas: 0, falhas: 0 });
});

test('2. 116: precheck, aplicação, postcheck; reaplicar recusa; rollback vazio aceito; reaplica', { skip: !opt() }, async () => {
    await q(PRE); await q(UP); await q(POS);
    await assert.rejects(q(UP), /116 já \(parcialmente\) presente/); await q('ROLLBACK');
    await assert.rejects(q(PRE), /116 já \(parcialmente\) presente/); await q('ROLLBACK');
    // Só um aviso de uso (sem franquia): o rollback também recusa, pela guarda própria (corpo dentro da transação do teste).
    const e = await empresa();
    await q('BEGIN');
    await q("INSERT INTO ia_credito_notificacoes (empresa_id, tipo, dedupe) VALUES ($1::uuid, 'FRANQUIA_80', $2)", [e, `FRANQUIA_80:${e}:CONVITES:teste`]);
    await assert.rejects(q(DOWN.replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, '')), /rollback recusado; já existe aviso de uso/);
    await q('ROLLBACK');
    await q(DOWN);
    assert.equal(await tx(c)((t) => franquiasInstaladas(t)), false);
    await q(PRE); await q(UP); await q(POS);
    assert.equal(await tx(c)((t) => franquiasInstaladas(t)), true);
});

test('3. flag desligada: caminho legado, nenhuma linha da 116 nem aviso de uso', { skip: !opt() }, async () => {
    const { e } = await comPlano([['premium', -5]], { legado: 4 });
    const m = await tx(c)((t) => manutencaoEmpresa(t, e, {}));
    assert.deepEqual(m.franquia, { concedida: true, motivo: null, porPlano: false });
    assert.deepEqual((await lotes(e)).map((l) => l.quantidade), [4]);
    assert.deepEqual(await linhas(e), []);
    // Sem convite_carteiras e flag desligada: o legado continua sem franquia (o plano não entra).
    const s = await comPlano([['premium', -5]]);
    assert.equal((await tx(c)((t) => manutencaoEmpresa(t, s.e, {}))).franquia.motivo, 'SEM_FRANQUIA_CONFIGURADA');
    assert.deepEqual(await lotes(s.e), []);
});

test('4. categorias: SEM_CORTE, MES_DO_CORTE, SEM_LIMITE (teste e isenta), HISTORICO_DIVERGENTE, ACESSO_NAO_COMPLETO', { skip: !opt() }, async () => {
    const semCarteira = await comPlano([['premium', -5]], { carteira: false });
    assert.equal((await reconhecer(semCarteira.e)).motivo, 'SEM_CORTE');

    const corte = await comPlano([['premium', -5]]);
    await q(`INSERT INTO ia_credito_cortes (empresa_id, recurso, mes, limite_mensal, usado, quantidade_legado, referencia_autorizacao)
        VALUES ($1::uuid, 'CONVITES', $2::date, 10, 10, 0, 'TESTE-LOCAL 116')`, [corte.e, (await mes()).ciclo]);
    assert.equal((await reconhecer(corte.e)).motivo, 'MES_DO_CORTE');

    const teste = await empresa();
    await q(`INSERT INTO empresa_assinaturas (empresa_id, situacao, teste_inicio, teste_fim) VALUES ($1::uuid, 'TESTE', clock_timestamp() - interval '2 days', clock_timestamp() + interval '12 days')`, [teste]);
    await tx(c)((t) => abrirCarteira(t, teste, 'CONVITES', CORTE));
    assert.equal((await reconhecer(teste)).motivo, 'SEM_LIMITE');
    // No worker, SEM_LIMITE volta ao legado (sem convite_carteiras: sem franquia).
    assert.deepEqual((await tx(c)((t) => manutencaoEmpresa(t, teste, LIGADA))).franquia, { concedida: false, motivo: 'SEM_FRANQUIA_CONFIGURADA', porPlano: false });

    const isenta = await comPlano([['premium', -5]]);
    // A guarda da 074a recusa isenção com histórico de contratação; aqui o estado é sintético (isenta e com plano).
    await fixture(() => q(`INSERT INTO assinatura_isencoes (empresa_id, documento_verificado, motivo, concedida_por) VALUES ($1::uuid, $2, 'Isenção sintética 116', $3::uuid)`,
        [isenta.e, `9${String(seq).padStart(11, '0')}00`.slice(0, 12) + '00', usuario]));
    assert.equal((await reconhecer(isenta.e)).motivo, 'SEM_LIMITE');

    const divergente = await comPlano([['essencial', -20], ['premium', 2]]);
    const antiga = (await q("SELECT id::text FROM assinatura_contratacoes WHERE empresa_id = $1::uuid AND plano = 'ESSENCIAL'", [divergente.e])).rows[0].id;
    await vigente(divergente.e, antiga, 'essencial');
    assert.equal((await reconhecer(divergente.e)).motivo, 'HISTORICO_DIVERGENTE');

    const vencida = await comPlano([['premium', -5]]);
    await fixture(() => q("UPDATE empresa_assinaturas SET periodo_atual_fim = clock_timestamp() - interval '90 days' WHERE empresa_id = $1::uuid", [vencida.e]));
    assert.equal((await reconhecer(vencida.e)).motivo, 'ACESSO_NAO_COMPLETO');

    for (const x of [semCarteira.e, corte.e, teste, isenta.e, divergente.e, vencida.e]) {
        assert.deepEqual(await linhas(x), [], 'nenhum reconhecimento');
        assert.deepEqual((await lotes(x)).filter((l) => l.origem === 'FRANQUIA'), []);
    }
});

test('5. recorrente, upgrade no mês, ida e volta, adoção do legado; repetição sem efeito; só inserção', { skip: !opt() }, async () => {
    const { chave } = await mes();
    // Recorrente: Premium desde o mês anterior = 30.
    const rec = await comPlano([['premium', -3]]);
    assert.deepEqual(await reconhecer(rec.e), { concedida: true, quantidade: 30, motivo: null, adotado: 0, devido: 30 });
    assert.deepEqual(await reconhecer(rec.e), { concedida: false, quantidade: 0, motivo: 'JA_RECONHECIDA', adotado: 0, devido: 30 });
    assert.deepEqual(await linhas(rec.e), [{ chave, tipo: 'RECONHECIMENTO', concedido: 30, devido: 30, contratacao: rec.atual }]);

    // Upgrade: Essencial reconhecido (10); Premium no dia 16 → complemento :R2 de ceil(20 × restantes/dias).
    const up = await comPlano([['essencial', -3]]);
    assert.equal((await reconhecer(up.e)).quantidade, 10);
    const premium = await confirmada(up.e, 'premium', 16);
    await vigente(up.e, premium, 'premium');
    const devidoUp = await literal({ 28: 20, 29: 20, 30: 20, 31: 21 });
    assert.deepEqual(await reconhecer(up.e), { concedida: true, quantidade: devidoUp - 10, motivo: null, adotado: 0, devido: devidoUp });
    assert.deepEqual((await linhas(up.e)).map((l) => [l.chave, l.concedido, l.contratacao]), [[chave, 10, up.atual], [`${chave}:R2`, devidoUp - 10, premium]]);
    assert.deepEqual((await lotes(up.e)).map((l) => [l.chave_origem, l.quantidade]), [[chave, 10], [`${chave}:R2`, devidoUp - 10]]);

    // Ida e volta (Premium → Profissional → Premium): nada além dos 30.
    const volta = await comPlano([['premium', -3], ['profissional', 1], ['premium', 2]]);
    assert.equal((await reconhecer(volta.e)).devido, 30);
    assert.equal((await lotes(volta.e)).reduce((s, l) => s + l.quantidade, 0), 30);

    // Adoção: o worker legado criou FRANQUIA:<mês> com 10 (flag desligada); ligada, adota 10 e completa 20 (:R2).
    const ad = await comPlano([['premium', -3]], { legado: 10 });
    assert.equal((await tx(c)((t) => manutencaoEmpresa(t, ad.e, {}))).franquia.porPlano, false);
    assert.deepEqual(await tx(c)((t) => manutencaoEmpresa(t, ad.e, LIGADA)).then((m) => m.franquia), { concedida: true, motivo: null, porPlano: true });
    assert.deepEqual((await linhas(ad.e)).map((l) => [l.chave, l.tipo, l.concedido]), [[chave, 'ADOCAO', 10], [`${chave}:R2`, 'RECONHECIMENTO', 20]]);
    assert.deepEqual(await tx(c)((t) => manutencaoEmpresa(t, ad.e, LIGADA)).then((m) => m.franquia), { concedida: false, motivo: 'JA_RECONHECIDA', porPlano: true });
    assert.equal((await lotes(ad.e)).length, 2);

    // Só inserção: UPDATE e DELETE recusados pelo gatilho.
    await assert.rejects(q('UPDATE ia_credito_franquias_ciclo SET concedido = 99 WHERE empresa_id = $1::uuid', [rec.e]), /só inserção \(116\)/);
    await assert.rejects(q('DELETE FROM ia_credito_franquias_ciclo WHERE empresa_id = $1::uuid', [rec.e]), /só inserção \(116\)/);
    assert.equal((await linhas(rec.e))[0].concedido, 30);
});

test('6. conflito de chave é erro; a pendência registra CHAVE_EM_CONFLITO e nada é concedido', { skip: !opt() }, async () => {
    const { chave, ciclo } = await mes();
    const x = await comPlano([['essencial', -3]]);
    await reconhecer(x.e);
    // Lote :R2 criado por fora (simula escrita concorrente indevida) antes do complemento.
    await tx(c)((t) => creditarLote(t, { empresaId: x.e, recurso: 'CONVITES', origem: 'FRANQUIA', chaveOrigem: `${chave}:R2`, quantidade: 1,
        venceEm: Date.now() + 86400000, ciclo, ator: 'SISTEMA' }));
    const p = await confirmada(x.e, 'premium', 10);
    await vigente(x.e, p, 'premium');
    await assert.rejects(reconhecer(x.e), FranquiaEmConflito);
    await tx(c)((t) => registrarPendenciaFranquia(t, x.e, p));
    const r = await processarPendenciasFranquia(tx(c));
    assert.ok(r.falhas >= 1);
    assert.deepEqual((await q('SELECT processada_em IS NULL AS aberta, tentativas, ultimo_motivo FROM ia_credito_franquia_pendencias WHERE empresa_id = $1::uuid', [x.e])).rows,
        [{ aberta: true, tentativas: 1, ultimo_motivo: 'CHAVE_EM_CONFLITO' }]);
    assert.deepEqual((await linhas(x.e)).map((l) => l.concedido), [10]);
    // Fecha a pendência para não contaminar as próximas execuções da fila.
    await q('UPDATE ia_credito_franquia_pendencias SET processada_em = clock_timestamp() WHERE empresa_id = $1::uuid', [x.e]);
});

test('7. corrida de três sessões: confirmação segurando a assinatura × pendência × worker → devido exato, uma concessão', { skip: !opt() }, async () => {
    const x = await comPlano([['essencial', -3]]);
    const p = await confirmada(x.e, 'premium', 1);
    const sync = await conectarDescartavel({ travar: false });
    const s2 = await conectarDescartavel({ travar: false });
    const s3 = await conectarDescartavel({ travar: false });
    const obs = await conectarDescartavel({ travar: false });
    try {
        // Sessão 1 (a sincronização): troca a contratação atual e grava a pendência, ainda sem COMMIT.
        await sync.query('BEGIN');
        await sync.query('SET LOCAL session_replication_role = replica');
        await sync.query("UPDATE empresa_assinaturas SET contratacao_atual_id = $2::uuid, plano = 'PREMIUM' WHERE empresa_id = $1::uuid", [x.e, p]);
        await registrarPendenciaFranquia(sync as unknown as DbExecutor, x.e, p);
        const pidSync = await pidDe(sync);
        const pid2 = await pidDe(s2);
        const pid3 = await pidDe(s3);
        // Sessão 2 (worker): trava a carteira e espera a assinatura. Sessão 3 (fila): espera a carteira.
        const w2 = reconhecer(x.e, s2).then((r) => r, (e) => e);
        assert.ok(await esperarBloqueio(obs, pid2, pidSync), 'worker espera a sincronização (FOR SHARE na assinatura)');
        const w3 = reconhecer(x.e, s3).then((r) => r, (e) => e);
        assert.ok(await esperarBloqueio(obs, pid3, pid2), 'segunda leitura espera a carteira');
        await sync.query('COMMIT');
        const [r2, r3] = await Promise.all([w2, w3]);
        const devido = 30; // Essencial desde o mês anterior, Premium no dia 1: 10 + ceil(20 × dias/dias).
        assert.deepEqual([r2.devido, r3.devido], [devido, devido], 'ambos leram o histórico depois da troca');
        assert.equal([r2, r3].filter((r) => r.concedida).length, 1);
        assert.equal((await lotes(x.e)).reduce((s, l) => s + l.quantidade, 0), devido, 'exatamente o devido, nunca em dobro');
        assert.equal((await processarPendenciasFranquia(tx(c))).falhas, 0);
        assert.equal((await q('SELECT ultimo_motivo FROM ia_credito_franquia_pendencias WHERE empresa_id = $1::uuid', [x.e])).rows[0].ultimo_motivo, 'JA_RECONHECIDA');
    }
    finally { for (const k of [sync, s2, s3, obs]) await k.end().catch(() => undefined); }
});

test('8. a sincronização real (sincronizarEmpresa) grava a pendência na mesma transação; a fila reconhece', { skip: !opt() }, async () => {
    const s8 = await empresaSincronizavel('Buffet Sincronização');
    const r = await s8.sincronizar(c);
    assert.equal(r.resultado === 'SINCRONIZADA' && r.depois, 'ATIVA');
    assert.deepEqual((await q('SELECT contratacao_id::text AS id, processada_em IS NULL AS aberta FROM ia_credito_franquia_pendencias WHERE empresa_id = $1::uuid', [s8.e])).rows,
        [{ id: s8.oferta.id, aberta: true }], 'pendência gravada pela sincronização');
    assert.deepEqual(await lotes(s8.e), [], 'a sincronização não credita');
    const fila = await processarPendenciasFranquia(tx(c));
    assert.ok(fila.concedidas >= 1);
    // Oráculo independente da regra: ativação Premium hoje = ceil(30 × (dias − dia + 1) ÷ dias).
    const { dias } = await mes();
    const dia = Number(s8.hoje.slice(8, 10));
    const devido = Math.ceil((30 * (dias - dia + 1)) / dias);
    assert.deepEqual((await linhas(s8.e)).map((l) => [l.tipo, l.concedido, l.contratacao]), [['RECONHECIMENTO', devido, s8.oferta.id]]);
});

test('9. avisos de uso: 80% e 100% do direito do ciclo, um aviso por marco', { skip: !opt() }, async () => {
    const x = await comPlano([['premium', -3]]);
    await reconhecer(x.e);
    const consumir = (n: number, op: string) => tx(c)(async (t) => {
        await reservar(t, { empresaId: x.e, recurso: 'CONVITES', operacaoId: op, quantidade: n, ator: 'SISTEMA' });
        await encerrarReserva(t, { empresaId: x.e, recurso: 'CONVITES', operacaoId: op, quantidadeFinal: n, ator: 'SISTEMA' });
    });
    const avisos = async () => (await q("SELECT tipo FROM ia_credito_notificacoes WHERE empresa_id = $1::uuid AND tipo LIKE 'FRANQUIA_%' ORDER BY tipo", [x.e])).rows.map((r) => r.tipo);
    await consumir(23, 'f-1');
    assert.equal(await tx(c)((t) => avisosDeUsoFranquia(t, x.e)), 0);
    await consumir(1, 'f-2');
    await tx(c)((t) => avisosDeUsoFranquia(t, x.e));
    await tx(c)((t) => avisosDeUsoFranquia(t, x.e));
    assert.deepEqual(await avisos(), ['FRANQUIA_80'], 'dedupe por empresa e mês');
    await consumir(6, 'f-3');
    await tx(c)((t) => manutencaoEmpresa(t, x.e, LIGADA));
    assert.deepEqual(await avisos(), ['FRANQUIA_100', 'FRANQUIA_80']);
    // Quem salta direto para 100% recebe só o de 100%.
    const y = await comPlano([['essencial', -3]]);
    await reconhecer(y.e);
    await tx(c)(async (t) => {
        await reservar(t, { empresaId: y.e, recurso: 'CONVITES', operacaoId: 'g-1', quantidade: 10, ator: 'SISTEMA' });
        await encerrarReserva(t, { empresaId: y.e, recurso: 'CONVITES', operacaoId: 'g-1', quantidadeFinal: 10, ator: 'SISTEMA' });
    });
    await tx(c)((t) => avisosDeUsoFranquia(t, y.e));
    assert.deepEqual((await q("SELECT tipo FROM ia_credito_notificacoes WHERE empresa_id = $1::uuid AND tipo LIKE 'FRANQUIA_%'", [y.e])).rows.map((r) => r.tipo), ['FRANQUIA_100']);
});

test('10. rollback recusado com franquia reconhecida: nenhum efeito', { skip: !opt() }, async () => {
    const antes = (await q('SELECT count(*)::int AS n FROM ia_credito_franquias_ciclo')).rows[0].n;
    assert.ok(antes > 0);
    // Cada guarda com a própria mensagem: os avisos de uso do cenário 9 não podem mascarar a recusa pela trilha financeira.
    await assert.rejects(q(DOWN), /rollback recusado; já existe franquia reconhecida/); await q('ROLLBACK');
    assert.equal(await tx(c)((t) => franquiasInstaladas(t)), true, 'tabelas intactas');
    assert.equal((await q('SELECT count(*)::int AS n FROM ia_credito_franquias_ciclo')).rows[0].n, antes);
});

test('11. exemplos do §4.2 no PG com valores literais por tamanho do mês; histórico gravado com contratação e instante', { skip: !opt() }, async () => {
    const { chave } = await mes();
    // Recorrente com worker atrasado: 30.
    assert.equal((await reconhecer((await comPlano([['premium', -3]])).e)).devido, 30);
    // Ativação no dia 16 e no dia 15 (primeira contratação no mês).
    const d16 = await comPlano([['premium', 16]]);
    assert.equal((await reconhecer(d16.e)).quantidade, await literal({ 28: 14, 29: 15, 30: 15, 31: 16 }));
    const d15 = await comPlano([['premium', 15]]);
    assert.equal((await reconhecer(d15.e)).quantidade, await literal({ 28: 15, 29: 16, 30: 16, 31: 17 }));
    // Upgrade antes do primeiro worker: UMA linha com o devido inteiro.
    const antes = await comPlano([['essencial', -3], ['premium', 16]]);
    const vinte = await literal({ 28: 20, 29: 20, 30: 20, 31: 21 });
    assert.deepEqual(await reconhecer(antes.e), { concedida: true, quantidade: vinte, motivo: null, adotado: 0, devido: vinte });
    assert.deepEqual((await linhas(antes.e)).map((l) => [l.chave, l.concedido]), [[chave, vinte]]);
    // Mesmo upgrade com worker antes: 10 + complemento (cenário 5); ida e volta e adoção: 30 (cenário 5).
    // Histórico gravado (revisão r1, P3-6): o segmento inicial traz a contratação vigente no início do ciclo e o instante; os
    // seguintes, o instante da confirmação — iguais aos do banco.
    const h = (await q(`SELECT historico FROM ia_credito_franquias_ciclo WHERE empresa_id = $1::uuid`, [antes.e])).rows[0].historico as
        { contratacaoId: string | null; plano: string; confirmadaEm: string | null; dia: number; valor: number; parcela: number }[];
    const banco = (await q(`SELECT id::text, to_char(confirmada_em AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS em FROM assinatura_contratacoes
        WHERE empresa_id = $1::uuid ORDER BY confirmada_em`, [antes.e])).rows;
    assert.deepEqual(h.map((s) => [s.contratacaoId, s.plano, s.confirmadaEm, s.dia, s.valor, s.parcela]),
        [[banco[0].id, 'essencial', banco[0].em, 1, 10, 10], [banco[1].id, 'premium', banco[1].em, 16, 30, vinte - 10]]);
    // Ativação sem contratação anterior: o segmento inicial é o piso, sem contratação nem instante.
    const h16 = (await q('SELECT historico FROM ia_credito_franquias_ciclo WHERE empresa_id = $1::uuid', [d16.e])).rows[0].historico as { contratacaoId: string | null; confirmadaEm: string | null }[];
    assert.deepEqual([h16[0].contratacaoId, h16[0].confirmadaEm], [null, null]);
    assert.equal(h16[1].contratacaoId, d16.atual);
});

test('12. fronteira do mês em São Paulo (não em UTC): fim − 1 min conta no ciclo; o fim exato já é o ciclo seguinte', { skip: !opt() }, async () => {
    const { dias } = await mes();
    // Último minuto do mês em São Paulo = 02:59 UTC do dia 1 seguinte: em UTC já seria o mês seguinte.
    const ultimo = await comPlano([]);
    const c1 = await confirmadaEm(ultimo.e, 'premium', FIM_DO_MES, -1);
    await vigente(ultimo.e, c1, 'premium');
    assert.equal((await q(`SELECT extract(month FROM confirmada_em AT TIME ZONE 'UTC') <> extract(month FROM confirmada_em AT TIME ZONE 'America/Sao_Paulo') AS cruza
        FROM assinatura_contratacoes WHERE id = $1::uuid`, [c1])).rows[0].cruza, true, 'o instante cruza o mês em UTC');
    assert.deepEqual(await reconhecer(ultimo.e), { concedida: true, quantidade: 1, motivo: null, adotado: 0, devido: 1 }, `ceil(30 × 1/${dias}) = 1`);
    assert.equal(((await q('SELECT historico FROM ia_credito_franquias_ciclo WHERE empresa_id = $1::uuid', [ultimo.e])).rows[0].historico as { dia: number }[])[1].dia, dias);
    // Fim exato (00:00 do dia 1 seguinte em São Paulo): fora deste ciclo — nada devido agora.
    const fim = await comPlano([]);
    const c2 = await confirmadaEm(fim.e, 'premium', FIM_DO_MES, 0);
    await vigente(fim.e, c2, 'premium');
    assert.deepEqual(await reconhecer(fim.e), { concedida: false, quantidade: 0, motivo: 'JA_RECONHECIDA', adotado: 0, devido: 0 });
    assert.deepEqual(await lotes(fim.e), []);
});

test('13. plano desconhecido na vigente: erro (PlanoIlegivel), nada creditado nem gravado na trilha', { skip: !opt() }, async () => {
    const x = await comPlano([['premium', -3]]);
    await q('BEGIN');
    try {
        // Só nesta transação: sem o CHECK do plano, uma contratação com plano fora do catálogo vira a vigente.
        for (const r of (await q(`SELECT conname FROM pg_constraint WHERE conrelid = 'assinatura_contratacoes'::regclass AND contype = 'c'
                AND pg_get_constraintdef(oid) ILIKE '%plano%'`)).rows) await q(`ALTER TABLE assinatura_contratacoes DROP CONSTRAINT ${r.conname}`);
        await q('SET LOCAL session_replication_role = replica');
        const d = (await q(`INSERT INTO assinatura_contratacoes (empresa_id, chave_idempotencia, plano, ciclo, catalogo_versao, valor_regular_centavos, valor_final_centavos,
                criada_por, criada_em, estado, confirmada_em, pagamento_confirmacao_id, provedor_assinatura_id)
            VALUES ($1, $2, 'DIAMANTE', 'MENSAL', 'sintetico', 9900, 9900, $3, clock_timestamp() - interval '1 hour', 'CONFIRMADA', clock_timestamp(), $4, $5) RETURNING id::text AS id`,
        [x.e, randomUUID(), usuario, `pay_${randomBytes(5).toString('hex')}`, `sub_${randomBytes(5).toString('hex')}`])).rows[0].id;
        await q('UPDATE empresa_assinaturas SET contratacao_atual_id = $2::uuid WHERE empresa_id = $1::uuid', [x.e, d]);
        await q('SET LOCAL session_replication_role = origin');
        await assert.rejects(reconhecerFranquia(c as unknown as DbExecutor, x.e), PlanoIlegivel);
    }
    finally { await q('ROLLBACK'); }
    assert.deepEqual(await linhas(x.e), []);
    assert.deepEqual(await lotes(x.e), []);
});

test('14. pendência: falha do INSERT dentro do SAVEPOINT devolve false e a transação da sincronização continua (escrita anterior preservada)', { skip: !opt() }, async () => {
    const x = await comPlano([['premium', -3]]);
    const r = await tx(c)(async (t) => {
        // Escrita anterior da mesma transação (no lugar da troca de contratação da sincronização).
        await t.query("INSERT INTO ia_credito_notificacoes (empresa_id, tipo, dedupe) VALUES ($1::uuid, 'LOTE_VENCENDO_7', $2)", [x.e, `LOTE_VENCENDO_7:${x.e}`]);
        const criada = await registrarPendenciaFranquia(t, x.e, randomUUID()); // contratação inexistente: a FK recusa
        const depois = (await t.query('SELECT count(*)::int AS n FROM ia_credito_notificacoes WHERE empresa_id = $1::uuid', [x.e])).rows[0].n;
        return { criada, depois };
    });
    assert.deepEqual(r, { criada: false, depois: 1 });
    assert.equal((await q('SELECT count(*)::int AS n FROM ia_credito_notificacoes WHERE empresa_id = $1::uuid', [x.e])).rows[0].n, 1, 'commit da escrita anterior');
    assert.deepEqual((await q('SELECT 1 FROM ia_credito_franquia_pendencias WHERE empresa_id = $1::uuid', [x.e])).rows, []);
});

test('15. atomicidade crédito → trilha: falha ao gravar a linha da trilha desfaz o lote e o CREDITO', { skip: !opt() }, async () => {
    const x = await comPlano([['premium', -3]]);
    await q('BEGIN');
    try {
        // CHECK NOT VALID só nesta transação: as linhas existentes ficam, toda inserção nova na trilha falha.
        await q('ALTER TABLE ia_credito_franquias_ciclo ADD CONSTRAINT teste_116_falha CHECK (concedido < 0) NOT VALID');
        await q('SAVEPOINT reconhecer');
        await assert.rejects(reconhecerFranquia(c as unknown as DbExecutor, x.e), /teste_116_falha/);
        await q('ROLLBACK TO SAVEPOINT reconhecer');
        assert.deepEqual((await q("SELECT count(*)::int AS n FROM ia_credito_lotes WHERE empresa_id = $1::uuid AND origem = 'FRANQUIA'", [x.e])).rows[0].n, 0, 'lote desfeito com a trilha');
        assert.deepEqual((await q("SELECT count(*)::int AS n FROM ia_credito_lancamentos WHERE empresa_id = $1::uuid AND tipo = 'CREDITO'", [x.e])).rows[0].n, 0);
        assert.equal((await q("SELECT saldo::int AS s FROM ia_credito_carteiras WHERE empresa_id = $1::uuid AND recurso = 'CONVITES'", [x.e])).rows[0].s, 0);
    }
    finally { await q('ROLLBACK'); }
    assert.deepEqual(await reconhecer(x.e).then((r) => r.quantidade), 30, 'sem o CHECK, o reconhecimento passa inteiro');
});

test('16. avisos com saldos mistos (§4.6): direito do ciclo + saldos válidos; vencido fora; cortesia que vence antes é consumida antes', { skip: !opt() }, async () => {
    const { ciclo } = await mes();
    const avisos = async (e: string) => (await q("SELECT tipo FROM ia_credito_notificacoes WHERE empresa_id = $1::uuid AND tipo LIKE 'FRANQUIA_%' ORDER BY tipo", [e])).rows.map((r) => r.tipo);
    const cortesia = (e: string, n: number, venceEm: number, chave: string) =>
        tx(c)((t) => creditarLote(t, { empresaId: e, recurso: 'CONVITES', origem: 'CORTESIA', chaveOrigem: `CORTESIA:${chave}`, quantidade: n, venceEm, ciclo, ator: 'SISTEMA' }));
    const agoraMs = Number((await q('SELECT (extract(epoch FROM clock_timestamp()) * 1000)::bigint AS t')).rows[0].t);

    // Franquia 30 + cortesia 20 que vence depois do fim do mês: base 50.
    const a = await comPlano([['premium', -3]]);
    await reconhecer(a.e);
    await cortesia(a.e, 20, agoraMs + 60 * 86400000, 'a');
    await consumirDe(a.e, 30, 'a-1');
    assert.equal(await tx(c)((t) => avisosDeUsoFranquia(t, a.e)), 0, '30 de 50 = 60%: nenhum aviso (a fórmula só da franquia daria 100%)');
    await consumirDe(a.e, 10, 'a-2');
    await tx(c)((t) => avisosDeUsoFranquia(t, a.e));
    assert.deepEqual(await avisos(a.e), ['FRANQUIA_80'], '40 de 50 = 80%');
    await consumirDe(a.e, 10, 'a-3');
    await tx(c)((t) => avisosDeUsoFranquia(t, a.e));
    assert.deepEqual(await avisos(a.e), ['FRANQUIA_100', 'FRANQUIA_80']);

    // Lote vencido (ainda não expirado pelo worker) não entra na base: 24 de 30 = 80%.
    const b = await comPlano([['premium', -3]]);
    await reconhecer(b.e);
    const velho = await cortesia(b.e, 100, agoraMs + 86400000, 'b');
    await fixture(() => q("UPDATE ia_credito_lotes SET liberado_em = clock_timestamp() - interval '10 days', vence_em = clock_timestamp() - interval '1 day' WHERE id = $1::uuid", [velho.loteId]));
    await consumirDe(b.e, 24, 'b-1');
    await tx(c)((t) => avisosDeUsoFranquia(t, b.e));
    assert.deepEqual(await avisos(b.e), ['FRANQUIA_80'], 'com o vencido na base seriam 24 de 130');

    // Cortesia de 10 que vence ANTES do fim do mês: consumida primeiro (ordem por vencimento); base 40.
    const d = await comPlano([['premium', -3]]);
    await reconhecer(d.e);
    const fimMs = Number((await q(`SELECT (extract(epoch FROM (date_trunc('month', clock_timestamp() AT TIME ZONE 'America/Sao_Paulo') + interval '1 month') AT TIME ZONE 'America/Sao_Paulo') * 1000)::bigint AS t`)).rows[0].t);
    const curta = await cortesia(d.e, 10, Math.min(agoraMs + 30 * 60000, fimMs - 60000), 'd');
    await consumirDe(d.e, 10, 'd-1');
    assert.deepEqual((await q('SELECT consumido::int AS n FROM ia_credito_lotes WHERE id = $1::uuid', [curta.loteId])).rows[0].n, 10, 'a cortesia que vence antes saiu primeiro');
    await consumirDe(d.e, 22, 'd-2');
    await tx(c)((t) => avisosDeUsoFranquia(t, d.e));
    assert.deepEqual(await avisos(d.e), ['FRANQUIA_80'], '32 de 40 = 80% (só a franquia daria 22 de 30 = 73%)');
});

test('17. postcheck (P2-4/P3-7): pendência legítima aceita; pendência não legítima, trilha, definição, NOT NULL, NOT VALID e gatilho divergentes recusados', { skip: !opt() }, async () => {
    // Banco novo só com a 116 aplicada: as tabelas estão vazias aqui só se nenhum cenário reconheceu ainda; por isso o
    // postcheck roda numa transação que esvazia a trilha (gatilho desligado só nela) e desfaz tudo no fim.
    const corpo = POS.replace(/^BEGIN TRANSACTION READ ONLY;$/m, '').replace(/^ROLLBACK;$/m, '');
    const x = await comPlano([['premium', -3]]);
    const recusa = async (preparo: () => Promise<unknown>, motivo: RegExp) => {
        await q('BEGIN');
        try {
            await limparTrilha();
            await preparo();
            await assert.rejects(q(corpo), motivo);
        }
        finally { await q('ROLLBACK'); }
    };
    async function limparTrilha() {
        await q('SET LOCAL session_replication_role = replica');
        await q('DELETE FROM ia_credito_franquias_ciclo');
        await q('DELETE FROM ia_credito_franquia_pendencias');
        await q('SET LOCAL session_replication_role = origin');
    }
    // Pendência legítima (gravada pela sincronização logo depois do COMMIT da 116): aprovado.
    await q('BEGIN');
    try {
        await limparTrilha();
        assert.equal(await registrarPendenciaFranquia(c as unknown as DbExecutor, x.e, x.atual), true);
        const r = await q(corpo);
        assert.deepEqual((r as unknown as { rows: unknown[] }[]).at(-1)!.rows, [{ banco: 'kidmais_pacotes_v1_descartavel', aprovado: true, pendencias_legitimas: '1' }]);
    }
    finally { await q('ROLLBACK'); }
    const pendente = async () => { await registrarPendenciaFranquia(c as unknown as DbExecutor, x.e, x.atual); };
    await recusa(async () => { await pendente(); await q('UPDATE ia_credito_franquia_pendencias SET tentativas = 1'); }, /pendência de franquia não legítima/);
    await recusa(async () => { await pendente(); await q("UPDATE ia_credito_franquia_pendencias SET ultimo_motivo = 'ERRO'"); }, /pendência de franquia não legítima/);
    await recusa(async () => { await pendente(); await q('UPDATE ia_credito_franquia_pendencias SET processada_em = clock_timestamp()'); }, /pendência de franquia não legítima/);
    await recusa(async () => {
        // Pendência de uma contratação ainda EM_ABERTO (não confirmada).
        const aberta = (await q(`INSERT INTO assinatura_contratacoes (empresa_id, chave_idempotencia, plano, ciclo, catalogo_versao, valor_regular_centavos,
            valor_final_centavos, criada_por) VALUES ($1, $2, 'PREMIUM', 'MENSAL', 'sintetico', 9900, 9900, $3) RETURNING id::text AS id`, [x.e, randomUUID(), usuario])).rows[0].id;
        assert.equal(await registrarPendenciaFranquia(c as unknown as DbExecutor, x.e, aberta), true);
    }, /pendência de franquia não legítima/);
    await recusa(() => reconhecerFranquia(c as unknown as DbExecutor, x.e), /deveria estar vazia/);
    await recusa(() => q('ALTER TABLE ia_credito_franquia_pendencias ALTER COLUMN tentativas DROP NOT NULL'), /definição das tabelas novas divergente/);
    await recusa(() => q('ALTER TABLE ia_credito_franquias_ciclo ALTER COLUMN versao_tabela SET NOT NULL'), /definição das tabelas novas divergente/);
    await recusa(async () => {
        await q('ALTER TABLE ia_credito_franquia_pendencias DROP CONSTRAINT ia_credito_franquia_pendencias_tentativas_check');
        await q('ALTER TABLE ia_credito_franquia_pendencias ADD CONSTRAINT ia_credito_franquia_pendencias_tentativas_check CHECK (tentativas BETWEEN 0 AND 1000) NOT VALID');
    }, /definição das tabelas novas divergente/);
    await recusa(async () => {
        await q('ALTER TABLE ia_credito_franquias_ciclo DROP CONSTRAINT ia_credito_franquias_ciclo_lote_uk');
        await q('ALTER TABLE ia_credito_franquias_ciclo ADD CONSTRAINT ia_credito_franquias_ciclo_lote_uk UNIQUE (lote_id, empresa_id)');
    }, /definição das tabelas novas divergente/);
    await recusa(async () => {
        await q('DROP TRIGGER ia_credito_franquias_ciclo_116_somente_insercao ON ia_credito_franquias_ciclo');
        await q(`CREATE TRIGGER ia_credito_franquias_ciclo_116_somente_insercao BEFORE UPDATE ON ia_credito_franquias_ciclo
            FOR EACH ROW EXECUTE FUNCTION kidmais_116_somente_insercao()`);
    }, /definição das tabelas novas divergente/);
    await recusa(() => q('ALTER TABLE ia_credito_franquias_ciclo DISABLE TRIGGER ia_credito_franquias_ciclo_116_somente_insercao'), /definição das tabelas novas divergente/);
    await recusa(() => q(`CREATE OR REPLACE FUNCTION kidmais_116_somente_insercao() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RETURN NEW; END; $f$`),
        /função do gatilho de só inserção divergente/);
});

test('18. corrida (P2-1), manutenção primeiro: manutenção completa (gatilhos ativos) × sincronização REAL, sem deadlock', { skip: !opt() }, async () => {
    const s = await empresaSincronizavel('Buffet Corrida 1');
    await s.sincronizar(c);
    await processarPendenciasFranquia(tx(c));
    const direito = (await linhas(s.e)).reduce((t, l) => t + l.concedido, 0);
    assert.ok(direito > 0);
    await consumirDe(s.e, Math.ceil(direito * 0.8), 'r1-1');
    // O marco que a manutenção vai gravar, lido numa transação desfeita (a empresa pode ter outros saldos na base).
    await q('BEGIN');
    let marco = '';
    try {
        await avisosDeUsoFranquia(c as unknown as DbExecutor, s.e);
        marco = (await q("SELECT tipo FROM ia_credito_notificacoes WHERE empresa_id = $1::uuid AND tipo LIKE 'FRANQUIA_%'", [s.e])).rows[0]?.tipo ?? '';
    }
    finally { await q('ROLLBACK'); }
    assert.match(marco, /^FRANQUIA_(80|100)$/, 'a manutenção da corrida grava um aviso');
    const dedupe = `${marco}:${s.e}:CONVITES:${(await mes()).ciclo.slice(0, 7)}`;
    const outra = await empresa('Buffet Portão');
    const [g, m, sy, obs] = await Promise.all([1, 2, 3, 4].map(() => conectarDescartavel({ travar: false })));
    try {
        // Portão: a MESMA chave de dedupe, ainda sem COMMIT, em OUTRA empresa (não segura nenhuma trava desta empresa). A
        // manutenção para no INSERT do aviso já com a carteira e a assinatura (FOR SHARE) nas mãos — o ponto do deadlock da r1.
        await g.query('BEGIN');
        await g.query('INSERT INTO ia_credito_notificacoes (empresa_id, tipo, dedupe) VALUES ($1::uuid, $2, $3)', [outra, marco, dedupe]);
        const [pg, pm, ps] = await Promise.all([pidDe(g), pidDe(m), pidDe(sy)]);
        const wm = tx(m)((t) => manutencaoEmpresa(t, s.e, LIGADA)).then((r) => r, (e) => e);
        assert.ok(await esperarBloqueio(obs, pm, pg), 'manutenção parada no aviso');
        const ws = s.sincronizar(sy).then((r) => r, (e) => e);
        assert.ok(await esperarBloqueio(obs, ps, pm), 'a sincronização espera a manutenção já na empresa (antes da assinatura)');
        await g.query('ROLLBACK');
        const [rm, rs] = await Promise.all([wm, ws]);
        for (const r of [rm, rs]) assert.ok(!(r instanceof Error), `sem erro (40P01 seria deadlock): ${r instanceof Error ? (r as { code?: string }).code ?? r.message : ''}`);
        assert.deepEqual((await q("SELECT tipo FROM ia_credito_notificacoes WHERE empresa_id = $1::uuid AND tipo LIKE 'FRANQUIA_%'", [s.e])).rows.map((r) => r.tipo), [marco]);
    }
    finally { for (const k2 of [g, m, sy, obs]) await k2.end().catch(() => undefined); }
});

test('19. corrida (P2-1), sincronização primeiro: a sincronização REAL segura empresa e espera a assinatura; a manutenção espera na empresa', { skip: !opt() }, async () => {
    const s = await empresaSincronizavel('Buffet Corrida 2');
    await s.sincronizar(c);
    await processarPendenciasFranquia(tx(c));
    const direito = (await linhas(s.e)).reduce((t, l) => t + l.concedido, 0);
    await consumirDe(s.e, Math.ceil(direito * 0.8), 'r2-1');
    const [g, m, sy, obs] = await Promise.all([1, 2, 3, 4].map(() => conectarDescartavel({ travar: false })));
    try {
        await g.query('BEGIN');
        await g.query('SELECT 1 FROM empresa_assinaturas WHERE empresa_id = $1::uuid FOR UPDATE', [s.e]);
        const [pg, pm, ps] = await Promise.all([pidDe(g), pidDe(m), pidDe(sy)]);
        const ws = s.sincronizar(sy).then((r) => r, (e) => e);
        assert.ok(await esperarBloqueio(obs, ps, pg), 'sincronização com a empresa, esperando a assinatura');
        const wm = tx(m)((t) => manutencaoEmpresa(t, s.e, LIGADA)).then((r) => r, (e) => e);
        assert.ok(await esperarBloqueio(obs, pm, ps), 'manutenção espera a sincronização na empresa, sem carteira nas mãos');
        assert.equal((await obs.query(`SELECT count(*)::int AS n FROM pg_locks l JOIN pg_class r ON r.oid = l.relation
            WHERE l.pid = $1 AND r.relname = 'ia_credito_carteiras' AND l.granted AND l.mode = 'RowShareLock'`, [pm])).rows[0].n, 0, 'a carteira ainda não foi travada');
        await g.query('COMMIT');
        const [rs, rm] = await Promise.all([ws, wm]);
        for (const r of [rm, rs]) assert.ok(!(r instanceof Error), `sem erro: ${r instanceof Error ? (r as { code?: string }).code ?? r.message : ''}`);
    }
    finally { for (const k2 of [g, m, sy, obs]) await k2.end().catch(() => undefined); }
});

test('20. corrida: geração de convites (empresa FOR UPDATE → carteira) × manutenção, sem deadlock', { skip: !opt() }, async () => {
    const x = await comPlano([['premium', -3]]);
    await reconhecer(x.e);
    await consumirDe(x.e, 24, 'r3-1');
    const [gc, m, obs] = await Promise.all([1, 2, 3].map(() => conectarDescartavel({ travar: false })));
    try {
        // Ordem da geração (lib/convites/service.ts): empresa FOR UPDATE no início, carteira na reserva.
        await gc.query('BEGIN');
        await gc.query("SELECT id FROM empresas WHERE id = $1 AND status = 'ATIVA' FOR UPDATE", [x.e]);
        const [pgc, pm] = await Promise.all([pidDe(gc), pidDe(m)]);
        const wm = tx(m)((t) => manutencaoEmpresa(t, x.e, LIGADA)).then((r) => r, (e) => e);
        assert.ok(await esperarBloqueio(obs, pm, pgc), 'manutenção espera a empresa');
        const reserva = await reservar(gc as unknown as DbExecutor, { empresaId: x.e, recurso: 'CONVITES', operacaoId: 'r3-geracao', quantidade: 1, ator: 'SISTEMA' })
            .then((r) => r, (e) => e);
        assert.ok(!(reserva instanceof Error), `a geração reserva sem esperar a manutenção: ${reserva instanceof Error ? (reserva as { code?: string }).code : ''}`);
        await gc.query('COMMIT');
        const rm = await wm;
        assert.ok(!(rm instanceof Error), `manutenção sem erro: ${rm instanceof Error ? (rm as { code?: string }).code ?? rm.message : ''}`);
    }
    finally { for (const k2 of [gc, m, obs]) await k2.end().catch(() => undefined); }
});

test('21. B-14 com a 116 (P2-3): a pendência da sincronização é efeito na proposta e na aplicação; repetir não gera; instante anterior = divergente', { skip: !opt() }, async () => {
    const s = await empresaSincronizavel('Buffet B-14');
    const alvo = { empresaId: s.e };
    const pendencias = (ef: Efeito[]) => ef.filter((x) => x.tabela === 'ia_credito_franquia_pendencias');
    // T1 (proposta): sincroniza dentro de uma transação desfeita.
    await q('BEGIN');
    let proposta: Efeito[];
    try {
        const antes = await fotografar(c as unknown as DbExecutor, alvo);
        await sincronizarEmpresa(c as never, s.e, { provedor: s.provedor as never }, { tipo: 'RECONCILIACAO' });
        proposta = diferenca(antes, await fotografar(c as unknown as DbExecutor, alvo));
    }
    finally { await q('ROLLBACK'); }
    assert.deepEqual(pendencias(proposta).map((x) => [x.chave, x.operacao]), [[`${s.e}:${s.oferta.id}`, 'INSERT']]);
    assert.equal(semEfeito(proposta), false);
    // T2 (aplicação): o mesmo efeito, com prova de que veio desta aplicação.
    const desdeMs = Number((await q('SELECT (extract(epoch FROM clock_timestamp()) * 1000)::bigint AS t')).rows[0].t);
    const antes2 = await tx(c)((t) => fotografar(t, alvo));
    await s.sincronizar(c);
    const depois2 = await tx(c)((t) => fotografar(t, alvo));
    assert.deepEqual(pendencias(diferenca(antes2, depois2)), pendencias(proposta));
    assert.equal(efeitosPresentes(depois2, pendencias(proposta), { desdeMs, requestId: 'n/a' }), true);
    // Repetição: nenhuma pendência nova.
    await s.sincronizar(c);
    assert.deepEqual(pendencias(diferenca(depois2, await tx(c)((t) => fotografar(t, alvo)))), []);
    // Linha histórica (anterior ao início da aplicação) não satisfaz o INSERT aprovado: DIVERGENTE.
    const depoisMs = Number((await q('SELECT (extract(epoch FROM clock_timestamp()) * 1000)::bigint AS t')).rows[0].t) + 1;
    assert.equal(efeitosPresentes(depois2, pendencias(proposta), { desdeMs: depoisMs, requestId: 'n/a' }), false);
});

/** Provedor FALSO da reconciliação: a listagem para num portão (a reconciliação já tem a empresa e a assinatura). */
function provedorComPortao(s: Awaited<ReturnType<typeof empresaSincronizavel>>, extra: AssinaturaProvedor | null) {
    let abrir!: () => void;
    const portao = new Promise<void>((f) => { abrir = f; });
    let chegou!: () => void;
    const naListagem = new Promise<void>((f) => { chegou = f; });
    const removidas = new Set<string>();
    const todas = () => [s.sub, ...(extra ? [extra] : [])].map((x) => ({ ...x, deleted: removidas.has(x.id) }));
    const provedor = {
        async obterAssinatura(x: string) { return todas().find((y) => y.id === x) ?? null; },
        async listarCobrancasDaAssinatura(x: string) { return s.provedor.listarCobrancasDaAssinatura(x); },
        async listarAssinaturasPorReferencia(ref: string) { chegou(); await portao; return ref === s.e ? todas().filter((y) => !y.deleted) : []; },
        async removerAssinatura(x: string) { removidas.add(x); return { removida: true }; },
    };
    return { provedor, abrir, naListagem, removidas };
}
const resultado = (r: unknown) => r instanceof Error ? `${(r as { code?: string }).code ?? ''} ${r.message}` : '';
async function carteiraTravadaPor(obs: Client, pid: number) {
    return (await obs.query(`SELECT count(*)::int AS n FROM pg_locks l JOIN pg_class r ON r.oid = l.relation
        WHERE l.pid = $1 AND r.relname = 'ia_credito_carteiras' AND l.granted AND l.mode = 'RowShareLock'`, [pid])).rows[0].n > 0;
}

/**
 * Reconciliação REAL × manutenção. A reconciliação trava empresa (FOR NO KEY UPDATE) e assinatura (FOR UPDATE) e para na
 * listagem do provedor; a manutenção chega e tem de esperar JÁ NA EMPRESA (FOR SHARE), sem carteira. Com KEY SHARE (r2) ela
 * entrava, travava a carteira e esperava a assinatura; a promoção da empresa a FOR UPDATE fechava o ciclo (40P01).
 */
async function corridaComReconciliacao(nome: string, preparar: (s: Awaited<ReturnType<typeof empresaSincronizavel>>) => Promise<{ extra: AssinaturaProvedor | null; assinaturaId: string; motivo: 'COMPENSACAO_FALHOU' | 'CRIACAO_CONFIRMADA_SEM_VINCULO' }>) {
    const s = await empresaSincronizavel(nome);
    const p = await preparar(s);
    const r = provedorComPortao(s, p.extra);
    const ev = await tx(c)((t) => registrarPendencia(t, { empresaId: s.e, assinaturaId: p.assinaturaId, motivo: p.motivo }));
    const [rc, m, ind, obs] = await Promise.all([1, 2, 3, 4].map(() => conectarDescartavel({ travar: false })));
    try {
        const independente = <T>(w: (t: DbExecutor) => Promise<T>) => tx(ind)(w);
        const [pr, pm] = await Promise.all([pidDe(rc), pidDe(m)]);
        const wr = tx(rc)((t) => processarEvento(t, ev, { provedor: r.provedor as never, transacaoIndependente: independente as never })).then((x) => x, (e) => e);
        await r.naListagem;
        const wm = tx(m)((t) => manutencaoEmpresa(t, s.e, LIGADA)).then((x) => x, (e) => e);
        assert.ok(await esperarBloqueio(obs, pm, pr), 'a manutenção espera a reconciliação');
        assert.equal(await carteiraTravadaPor(obs, pm), false, 'a manutenção espera na EMPRESA, sem a carteira nas mãos');
        r.abrir();
        const [rr, rm] = await Promise.all([wr, wm]);
        assert.ok(!(rm instanceof Error), `manutenção sem erro: ${resultado(rm)}`);
        assert.ok(!(rr instanceof Error), `reconciliação sem erro: ${resultado(rr)}`);
        return { s, r, rr: rr as { situacao: string; motivo?: string } };
    }
    finally { for (const k2 of [rc, m, ind, obs]) await k2.end().catch(() => undefined); }
}

test('22. corrida (r2 P2): reconciliação REAL CONCILIADA — marcador na transação independente e promoção pela sincronização × manutenção, sem deadlock', { skip: !opt() }, async () => {
    let dup!: AssinaturaProvedor;
    const { s, r, rr } = await corridaComReconciliacao('Buffet Reconciliação 1', async (s) => {
        await s.sincronizar(c);
        await processarPendenciasFranquia(tx(c));
        dup = { ...s.sub, id: `sub_dup_${randomBytes(4).toString('hex')}` };
        return { extra: dup, assinaturaId: dup.id, motivo: 'COMPENSACAO_FALHOU' };
    });
    assert.deepEqual({ situacao: rr.situacao, motivo: rr.motivo }, { situacao: 'PROCESSADO', motivo: 'CONCILIADA' }, 'a reconciliação concluiu (não caiu em FALHOU por 40P01 no SAVEPOINT)');
    assert.deepEqual([...r.removidas], [dup.id]);
    // O marcador foi gravado e fechado na transação INDEPENDENTE (FK = KEY SHARE na empresa) enquanto a manutenção esperava.
    assert.deepEqual((await q(`SELECT situacao, ultimo_erro, assinatura_provedor_id FROM cobranca_eventos
        WHERE empresa_id = $1::uuid AND evento_id LIKE 'kidmais:remocao:%'`, [s.e])).rows, [{ situacao: 'PROCESSADO', ultimo_erro: 'REMOCAO_CONFIRMADA', assinatura_provedor_id: dup.id }]);
});

test('23. corrida (r2 P2): reconciliação REAL VINCULADA — promoção pelo gatilho 074a × manutenção, sem deadlock', { skip: !opt() }, async () => {
    const { s, rr } = await corridaComReconciliacao('Buffet Reconciliação 2', async (s) => {
        // Vínculo antigo que o provedor não conhece mais; a única ativa é a nova → VINCULADA (UPDATE de empresa_assinaturas).
        await q('UPDATE empresa_assinaturas SET provedor_assinatura_id = $2 WHERE empresa_id = $1::uuid', [s.e, `sub_velha_${randomBytes(4).toString('hex')}`]);
        return { extra: null, assinaturaId: s.sub.id, motivo: 'CRIACAO_CONFIRMADA_SEM_VINCULO' };
    });
    assert.deepEqual({ situacao: rr.situacao, motivo: rr.motivo }, { situacao: 'PROCESSADO', motivo: 'VINCULADA' });
    assert.deepEqual((await q('SELECT provedor_assinatura_id, situacao, plano FROM empresa_assinaturas WHERE empresa_id = $1::uuid', [s.e])).rows,
        [{ provedor_assinatura_id: s.sub.id, situacao: 'ATIVA', plano: 'PREMIUM' }]);
});

test('24. devolução D1 e B-14 regravar: empresa ANTES da assinatura — quem espera a empresa não segura a assinatura', { skip: !opt() }, async () => {
    // Empresa sincronizada de verdade (o gatilho 068 confere contratação, ciclo e provedor na escrita).
    const x = await empresaSincronizavel('Buffet Ordem D1');
    await x.sincronizar(c);
    const sub = x.sub.id;
    const casos: [string, (t: DbExecutor) => Promise<unknown>][] = [
        ['devolução D1', (t) => gravarResultadoCancelamento(t, x.e, randomUUID(), 'CONFIRMADO', sub)],
        ['B-14 regravar', (t) => regravarDoInstante(t, [{ tabela: 'empresa_assinaturas', chave: x.e, coluna: 'cancelada_em', valor: '2026-01-02T03:04:05.000Z' }])],
    ];
    for (const [nome, escrever] of casos) {
        const [g, d, obs] = await Promise.all([1, 2, 3].map(() => conectarDescartavel({ travar: false })));
        try {
            // A primeira trava da manutenção (empresa FOR SHARE), segura.
            await g.query('BEGIN');
            await g.query('SELECT 1 FROM empresas WHERE id = $1::uuid FOR SHARE', [x.e]);
            const [pg, pd] = await Promise.all([pidDe(g), pidDe(d)]);
            const w = tx(d)(escrever).then((r) => r, (e) => e);
            assert.ok(await esperarBloqueio(obs, pd, pg), `${nome} espera a empresa`);
            // Antes da r3 a escrita já segurava a assinatura (UPDATE) e o gatilho 068 esperava a empresa: a manutenção,
            // que pede a assinatura FOR SHARE depois da carteira, fecharia o ciclo.
            await obs.query('BEGIN');
            const livre = await obs.query('SELECT 1 FROM empresa_assinaturas WHERE empresa_id = $1::uuid FOR SHARE NOWAIT', [x.e]).then(() => true, () => false);
            await obs.query('ROLLBACK');
            assert.equal(livre, true, `${nome}: a assinatura continua livre enquanto espera a empresa`);
            await g.query('COMMIT');
            const r = await w;
            assert.ok(!(r instanceof Error), `${nome} sem erro: ${resultado(r)}`);
        }
        finally { for (const k2 of [g, d, obs]) await k2.end().catch(() => undefined); }
    }
});

test('25. avisos (r2 P3): base e uso LITERAIS com bloqueio, cancelamento, reservas e franquia antiga ainda vigente', { skip: !opt() }, async () => {
    const { ciclo } = await mes();
    const agoraMs = Number((await q('SELECT (extract(epoch FROM clock_timestamp()) * 1000)::bigint AS t')).rows[0].t);
    const fimMs = Number((await q(`SELECT (extract(epoch FROM (date_trunc('month', clock_timestamp() AT TIME ZONE 'America/Sao_Paulo') + interval '1 month') AT TIME ZONE 'America/Sao_Paulo') * 1000)::bigint AS t`)).rows[0].t);
    const antesDaFranquia = Math.min(agoraMs + 30 * 60000, fimMs - 60000);
    const uso = async (e: string) => { const u = await tx(c)((t) => usoDaFranquia(t, e)); return { direito: u.direito, uso: u.uso, base: u.base }; };
    const avisos = async (e: string) => { await tx(c)((t) => avisosDeUsoFranquia(t, e)); return (await q("SELECT tipo FROM ia_credito_notificacoes WHERE empresa_id = $1::uuid AND tipo LIKE 'FRANQUIA_%' ORDER BY tipo", [e])).rows.map((r) => r.tipo); };
    /** Franquia 30 com 22 consumidos; depois um lote de 100 que vence antes da franquia, com 10 consumidos no ciclo. */
    async function base22mais10(chave: string) {
        const x = await comPlano([['premium', -3]]);
        await reconhecer(x.e);
        await consumirDe(x.e, 22, `${chave}-f`);
        const l = await tx(c)((t) => creditarLote(t, { empresaId: x.e, recurso: 'CONVITES', origem: 'CORTESIA', chaveOrigem: `CORTESIA:${chave}`, quantidade: 100, venceEm: antesDaFranquia, ciclo, ator: 'SISTEMA' }));
        await consumirDe(x.e, 10, `${chave}-o`);
        assert.deepEqual((await q('SELECT consumido::int AS n FROM ia_credito_lotes WHERE id = $1::uuid', [l.loteId])).rows[0].n, 10);
        return { e: x.e, lote: l.loteId };
    }
    const mover = (lote: string, sets: string) => fixture(() => q(`UPDATE ia_credito_lotes SET ${sets} WHERE id = $1::uuid`, [lote]));

    // Sem nada fora do saldo: 32 de 30 + 90 + 10 = 130.
    const livre = await base22mais10('r3-livre');
    assert.deepEqual(await uso(livre.e), { direito: 30, uso: 32, base: 130 });
    // Exemplo do Astra: os 90 restantes CANCELADOS → o lote fica, sem saldo; o consumo do ciclo nele continua → 32 / 40 = 80%.
    const cancelado = await base22mais10('r3-cancelado');
    await mover(cancelado.lote, 'disponivel = 0, cancelado = 90');
    assert.deepEqual(await uso(cancelado.e), { direito: 30, uso: 32, base: 40 });
    assert.deepEqual(await avisos(cancelado.e), ['FRANQUIA_80'], 'excluir o lote inteiro daria 22 / 30 ≈ 73%: nenhum aviso');
    // BLOQUEIO parcial (devolução em curso): 50 bloqueados saem do saldo → 32 / (30 + 40 + 10).
    const bloqueado = await base22mais10('r3-bloqueado');
    await mover(bloqueado.lote, 'disponivel = 40, bloqueado = 50');
    assert.deepEqual(await uso(bloqueado.e), { direito: 30, uso: 32, base: 80 });
    // RESERVA em aberto de 20 (sai do lote curto, que vence antes): reservado é saldo (os 90 continuam na base); reserva não é uso.
    const reserva = await base22mais10('r3-reserva');
    await tx(c)((t) => reservar(t, { empresaId: reserva.e, recurso: 'CONVITES', operacaoId: 'r3-reserva-aberta', quantidade: 20, ator: 'SISTEMA' }));
    assert.deepEqual((await q('SELECT disponivel::int AS d, reservado::int AS r FROM ia_credito_lotes WHERE id = $1::uuid', [reserva.lote])).rows[0], { d: 70, r: 20 });
    assert.deepEqual(await uso(reserva.e), { direito: 30, uso: 32, base: 130 });

    // FRANQUIA ANTIGA ainda vigente (ciclo anterior): saldo restante + consumo SÓ deste ciclo.
    const x = await comPlano([['premium', -3]]);
    await reconhecer(x.e);
    await consumirDe(x.e, 22, 'r3-antiga-f');
    const anterior = (await q(`SELECT to_char(($1::date - interval '1 month')::date, 'YYYY-MM-DD') AS d`, [ciclo])).rows[0].d as string;
    const antiga = await tx(c)((t) => creditarLote(t, { empresaId: x.e, recurso: 'CONVITES', origem: 'FRANQUIA', chaveOrigem: `FRANQUIA:${anterior.slice(0, 7)}`, quantidade: 50, venceEm: antesDaFranquia, ciclo: anterior, ator: 'SISTEMA' }));
    await consumirDe(x.e, 15, 'r3-antiga-mes-passado');
    // Os 15 foram consumidos no ciclo anterior (fixture: só a data do lançamento).
    await fixture(() => q(`UPDATE ia_credito_lancamentos SET criado_em = ($2::date)::timestamp AT TIME ZONE 'America/Sao_Paulo' + interval '2 days'
        WHERE empresa_id = $1::uuid AND lote_id = $3::uuid AND tipo = 'CONSUMO'`, [x.e, anterior, antiga.loteId]));
    await consumirDe(x.e, 5, 'r3-antiga-este-mes');
    assert.deepEqual((await q('SELECT consumido::int AS c, disponivel::int AS d FROM ia_credito_lotes WHERE id = $1::uuid', [antiga.loteId])).rows[0], { c: 20, d: 30 });
    assert.deepEqual(await uso(x.e), { direito: 30, uso: 27, base: 65 }, 'uso 22 + 5; base 30 + 30 + 5 (os 15 do mês passado ficam fora)');
});
