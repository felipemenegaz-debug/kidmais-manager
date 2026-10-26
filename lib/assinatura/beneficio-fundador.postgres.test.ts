import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Client } from 'pg';
import { conectarDescartavel, encerrarDescartavel } from '../comercial/postgres-descartavel.ts';
import { iniciarTeste } from './servico.ts';
import { prepararOferta, type PedidoOferta } from './ofertas.ts';
import { sincronizarEmpresa } from './sincronizacao.ts';
import { lerComprovante } from './comprovante.ts';
import { consultarAssinatura } from './consulta.ts';
import { consultarBeneficioFundador, consultarBeneficioFundadorDesenvolvedor } from './beneficio-fundador.ts';
import { carregarModulo } from '../acessos/teste-carregador.ts';
import type { BeneficioFundadorDesenvolvedor } from './beneficio-fundador.ts';
import { DOCUMENTOS, hashDocumento } from '../cadastro/documentos-legais.ts';
import type { AssinaturaProvedor, CobrancaProvedor } from './asaas.ts';

/**
 * Situação atual do benefício Fundador (diagnóstico de 25/10/2026), no PostgreSQL DESCARTÁVEL sobre o modelo 089.
 * Provedor FALSO; documentos SINTÉTICOS com DV calculado. Confirmação pelo caminho do produto (sincronizarEmpresa):
 *   1. sem a 090 e sem a 096: reservada (nunca como confirmada), Gestão × Equipe, empresa sem concessão, leitura READ ONLY;
 *   2. com a 096: confirmada vigente com as datas PERSISTIDAS (fim = confirmação + 12 meses UTC, pelo gatilho), oferta
 *      vinculada, comprovante inalterado ("reservada"), isolamento A × B × C, sem documento nem id do provedor;
 *   3. concessão liberada não aparece;
 *   4. limites do prazo (fixture sintética das datas): fim no futuro → vigente; fim já alcançado → encerrada; leitura não grava;
 *   5. com a 090: o desenvolvedor vê a fase (LEGADO) e a vaga; a Gestão não.
 */
const ler = (f: string) => readFileSync(f, 'utf8');
const SQL = {
    pre096: ler('database/checks/20261022_096_precheck.sql'), up096: ler('database/migrations/20261022_096_comprovante_contratacao.sql'),
    post096: ler('database/checks/20261022_096_postcheck.sql'),
    pre090: ler('database/checks/20261022_090_precheck.sql'), up090: ler('database/migrations/20261022_090_campanha_fundador.sql'),
    post090: ler('database/checks/20261022_090_postcheck.sql'),
};
const opt = () => process.env.KIDMAIS_POSTGRES_DESCARTAVEL === 'kidmais_pacotes_v1_descartavel';
const ENV = { ASSINATURA_PLANOS_ATIVOS: 'true', ASAAS_AMBIENTE: 'sandbox' };
const PEDIDO: PedidoOferta = { plano: 'essencial', ciclo: 'MENSAL', valorEsperadoCentavos: 11820, versao: '2026-10-20' };
const ISO = (c: string) => `to_char((${c}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

let client: Client;
let usuario = '';
let seq = 0;
let com096 = false;
/** Ficha comercial real do painel (carregada com o db/postgres apontando para o cliente descartável). */
let comercialDaEmpresa: (tx: never, empresaId: string) => Promise<{ fundador: BeneficioFundadorDesenvolvedor | null }>;
const q = (texto: string, params: unknown[] = []) => client.query(texto, params);
async function emTx<T>(acao: () => Promise<T>, modo = 'BEGIN'): Promise<T> {
    await client.query(modo);
    try { const r = await acao(); await client.query('COMMIT'); return r; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
}
const somenteLeitura = <T>(acao: () => Promise<T>) => emTx(acao, 'BEGIN READ ONLY');
function cnpj(n: number) {
    const base = `6${String(n).padStart(7, '0')}0001`;
    const dv = (b: string) => { let s = 0, p = 2; for (let i = b.length - 1; i >= 0; i--) { s += (b.charCodeAt(i) - 48) * p; p = p === 9 ? 2 : p + 1; } const r = s % 11; return r <= 1 ? 0 : 11 - r; };
    const d1 = dv(base); return base + d1 + dv(base + d1);
}
async function empresaEmTeste() {
    const n = ++seq;
    const empresaId = (await q("INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Buffet Benefício', 'PROVISIONAMENTO') RETURNING id", [`bf${n}${randomBytes(3).toString('hex')}`])).rows[0].id as string;
    await q("UPDATE empresas SET status = 'ATIVA' WHERE id = $1", [empresaId]);
    await q(`INSERT INTO plataforma_empresas_cadastro (empresa_id, nome_empresarial, documento_fiscal, responsavel_nome, email, criado_por, atualizado_por)
        VALUES ($1, 'Festas Benefício Ltda', $2, 'Responsável', $3, $4, $4)`, [empresaId, cnpj(n), `bf${n}@example.test`, usuario]);
    await emTx(() => iniciarTeste(client as never, { empresaId, documento: cnpj(n) }));
    return { empresaId, documento: cnpj(n) };
}
const docsVigentes = () => Object.fromEntries(Object.values(DOCUMENTOS).map((d) => [d.documento, { versao: d.versao, hash: hashDocumento(d) }]));
const oferta = (empresaId: string) => emTx(() => prepararOferta(client as never, empresaId, usuario, { ...PEDIDO, ...(com096 ? { documentos: docsVigentes() } : {}) }, ENV));
const tenant = (empresaId: string, papelAtual = 'REPRESENTANTE_AUTORIZADO') => ({ empresaComprovada: empresaId, membershipId: 'm', usuarioId: usuario, papelAtual });
const gestao = (empresaId: string, papel?: string) => somenteLeitura(() => consultarAssinatura(client as never, tenant(empresaId, papel) as never, ENV));
const persistido = async (empresaId: string) => (await q(`SELECT estado, ${ISO('reservada_em')} AS r, ${ISO('confirmada_em')} AS c, ${ISO('beneficio_fim')} AS f,
    ${ISO("(confirmada_em AT TIME ZONE 'UTC' + interval '12 months') AT TIME ZONE 'UTC'")} AS doze, documento_beneficiario, pagamento_confirmacao_id
    FROM assinatura_fundadores WHERE empresa_id = $1 AND estado <> 'LIBERADA'`, [empresaId])).rows[0];
const retrato = async () => (await q(`SELECT (SELECT jsonb_agg(to_jsonb(f) ORDER BY id) FROM assinatura_fundadores f) AS f,
    (SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM assinatura_contratacoes c) AS c`)).rows[0];

/** Confirma pelo caminho do produto: provedor falso com a assinatura ACTIVE e a primeira cobrança RECEIVED do valor da oferta. */
async function confirmarPeloProduto(empresaId: string) {
    const hoje = (await q("SELECT to_char(clock_timestamp() AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS d")).rows[0].d;
    const id = randomBytes(4).toString('hex');
    const sub: AssinaturaProvedor = { id: `sub_${id}`, customer: `cus_${id}`, externalReference: empresaId, cycle: 'MONTHLY', status: 'ACTIVE', deleted: false, valorCentavos: 11820 };
    const pay = { id: `pay_${id}`, status: 'RECEIVED', dueDate: hoje, paymentDate: hoje, deleted: false, invoiceUrl: null, valorCentavos: 11820,
        assinaturaId: sub.id, clienteId: sub.customer, billingType: 'PIX' } as CobrancaProvedor;
    const provedor = {
        async obterAssinatura(x: string) { return x === sub.id ? { ...sub } : null; },
        async listarCobrancasDaAssinatura(x: string) { return x === sub.id ? [{ ...pay }] : []; },
        async listarAssinaturasPorReferencia(ref: string) { return ref === empresaId ? [{ ...sub }] : []; },
    };
    await q("UPDATE empresa_assinaturas SET provedor = 'ASAAS', provedor_cliente_id = $2, provedor_assinatura_id = $3 WHERE empresa_id = $1", [empresaId, sub.customer, sub.id]);
    const r = await emTx(() => sincronizarEmpresa(client as never, empresaId, { provedor: provedor as never }, { tipo: 'RECONCILIACAO' }));
    assert.equal(r.resultado === 'SINCRONIZADA' && r.depois, 'ATIVA');
    return pay.id;
}
/** Nada de documento, id do provedor nem número de 11 ou 14 dígitos na saída. */
function semVazamento(saida: unknown, documento: string, pagamento?: string) {
    const j = JSON.stringify(saida);
    assert.ok(!j.includes(documento), 'documento do beneficiário');
    if (pagamento) assert.ok(!j.includes(pagamento), 'id do pagamento no provedor');
    assert.doesNotMatch(j, /(?<!\d)(\d{11}|\d{14})(?!\d)/);
    assert.doesNotMatch(j, /documento_beneficiario|documentoBeneficiario|pagamento_confirmacao_id|pagamentoConfirmacaoId/);
}

test.before(async () => {
    if (!opt()) return;
    client = await conectarDescartavel();
    comercialDaEmpresa = (carregarModulo('lib/desenvolvedor/comercial.ts', { 'db/postgres': { db: () => client, withTransaction: (t: (tx: never) => unknown) => emTx(() => t(client as never) as Promise<unknown>) } },
        new Map()) as unknown as { comercialDaEmpresa: typeof comercialDaEmpresa }).comercialDaEmpresa;
    usuario = (await q("INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Gestão Benefício', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id",
        [`bf${randomBytes(3).toString('hex')}@example.test`, `scrypt$v=1$N=131072$r=8$p=1$${'A'.repeat(22)}==$${'B'.repeat(86)}==`])).rows[0].id;
});
test.after(async () => { if (client) await encerrarDescartavel(client); });

const A = { empresaId: '', documento: '', oferta: '' };
const B = { empresaId: '', documento: '', oferta: '', pagamento: '' };
let C = '';
test('1. sem a 090/096: reservada nunca aparece como confirmada; só a Gestão recebe; empresa sem concessão: null; leitura READ ONLY', { skip: !opt() }, async () => {
    assert.equal((await q("SELECT to_regclass('public.assinatura_campanhas') IS NULL AND to_regclass('public.assinatura_comprovantes') IS NULL AS ok")).rows[0].ok, true);
    Object.assign(A, await empresaEmTeste());
    A.oferta = (await oferta(A.empresaId)).id;
    const b = await somenteLeitura(() => consultarBeneficioFundador(client as never, A.empresaId));
    const p = await persistido(A.empresaId);
    assert.deepEqual(b, { situacao: 'RESERVADA', reservadaEm: p.r, confirmadaEm: null, beneficioFim: null, contratacaoId: A.oferta, contratacaoEstado: 'EM_ABERTO' });
    const g = await gestao(A.empresaId);
    assert.deepEqual(g.fundador, b);
    assert.equal((await gestao(A.empresaId, 'EQUIPE')).fundador, null, 'Equipe não recebe');
    const dev = await somenteLeitura(() => consultarBeneficioFundadorDesenvolvedor(client as never, A.empresaId));
    assert.equal(dev?.origem, null, 'sem a 090: sem fase');
    assert.ok(Number.isInteger(dev?.vaga) && dev!.vaga! >= 1 && dev!.vaga! <= 20);
    semVazamento([b, g.fundador, dev], A.documento);
    C = (await empresaEmTeste()).empresaId;
    assert.equal(await somenteLeitura(() => consultarBeneficioFundador(client as never, C)), null);
    assert.equal((await gestao(C)).fundador, null);
});

test('2. com a 096: confirmada vigente com as datas persistidas, oferta vinculada, comprovante inalterado e isolamento A × B × C', { skip: !opt() }, async () => {
    await q(SQL.pre096); await q(SQL.up096); await q(SQL.post096); com096 = true;
    Object.assign(B, await empresaEmTeste());
    B.oferta = (await oferta(B.empresaId)).id;
    const comprovanteAntes = await emTx(() => lerComprovante(client as never, B.empresaId));
    assert.deepEqual(comprovanteAntes?.condicoes.fundador, { reservada: true, pagueAte: null });
    B.pagamento = await confirmarPeloProduto(B.empresaId);
    const p = await persistido(B.empresaId);
    assert.equal(p.estado, 'CONFIRMADA');
    assert.equal(p.f, p.doze, 'gatilho 074a: fim = confirmação + 12 meses (UTC)');
    const b = await somenteLeitura(() => consultarBeneficioFundador(client as never, B.empresaId));
    assert.deepEqual(b, { situacao: 'CONFIRMADA_VIGENTE', reservadaEm: p.r, confirmadaEm: p.c, beneficioFim: p.f, contratacaoId: B.oferta, contratacaoEstado: 'CONFIRMADA' },
        'datas persistidas, sem recálculo');
    // Comprovante: o retrato do aceite segue "reservada", igual ao de antes da confirmação.
    assert.deepEqual(await emTx(() => lerComprovante(client as never, B.empresaId)), comprovanteAntes);
    const g = await gestao(B.empresaId);
    assert.deepEqual(g.fundador, b);
    assert.deepEqual(g.contratacao?.comprovante?.condicoes.fundador, { reservada: true, pagueAte: null }, 'comprovante na mesma resposta, separado');
    // Isolamento: cada empresa só vê a própria concessão.
    assert.equal((await gestao(A.empresaId)).fundador?.situacao, 'RESERVADA');
    assert.equal((await gestao(A.empresaId)).fundador?.contratacaoId, A.oferta);
    assert.equal((await gestao(C)).fundador, null);
    assert.notEqual((await gestao(A.empresaId)).fundador?.reservadaEm, undefined);
    semVazamento([b, g.fundador], B.documento, B.pagamento);
    const comercial = await somenteLeitura(() => comercialDaEmpresa(client as never, B.empresaId));
    assert.equal(comercial.fundador?.situacao, 'CONFIRMADA_VIGENTE');
    assert.equal(comercial.fundador?.contratacaoId, B.oferta);
    assert.equal((comercial as { plano?: string | null }).plano, 'ESSENCIAL', 'O-1: ficha recebe o plano contratado');
    assert.equal(((await somenteLeitura(() => comercialDaEmpresa(client as never, C))) as { plano?: string | null }).plano, 'UNICO', 'legado em teste');
    semVazamento(comercial.fundador, B.documento, B.pagamento);
    assert.equal((await somenteLeitura(() => comercialDaEmpresa(client as never, C))).fundador, null);
});

test('3. concessão liberada não aparece (nem para a Gestão nem para o desenvolvedor)', { skip: !opt() }, async () => {
    const d = await empresaEmTeste();
    await oferta(d.empresaId);
    await emTx(async () => {
        await q("UPDATE assinatura_contratacoes SET estado = 'CANCELADA', cancelada_em = clock_timestamp(), motivo_cancelamento = 'Fixture sintética liberada' WHERE empresa_id = $1", [d.empresaId]);
        await q("UPDATE assinatura_fundadores SET estado = 'LIBERADA', liberada_em = clock_timestamp(), evidencia_liberacao = 'Fixture sintética: sem cobrança' WHERE empresa_id = $1", [d.empresaId]);
    });
    assert.equal(await somenteLeitura(() => consultarBeneficioFundador(client as never, d.empresaId)), null);
    assert.equal(await somenteLeitura(() => consultarBeneficioFundadorDesenvolvedor(client as never, d.empresaId)), null);
    assert.equal((await gestao(d.empresaId)).fundador, null);
});

// Oportunidades da revisão independente de 631a5674 (não bloqueantes): vínculo da oferta com contratações canceladas e várias.
test('3b. reserva só com contratação cancelada fica sem oferta; nova oferta reaproveita a concessão; a atual vence uma aberta da mesma concessão', { skip: !opt() }, async () => {
    const f = await empresaEmTeste();
    const cancelada = (await oferta(f.empresaId)).id;
    await q("UPDATE assinatura_contratacoes SET estado = 'CANCELADA', cancelada_em = clock_timestamp(), motivo_cancelamento = 'Fixture sintética cancelada' WHERE id = $1", [cancelada]);
    let b = await somenteLeitura(() => consultarBeneficioFundador(client as never, f.empresaId));
    assert.deepEqual([b?.situacao, b?.contratacaoId, b?.contratacaoEstado], ['RESERVADA', null, null], 'reserva continua; a cancelada não é a oferta');
    assert.equal((await gestao(f.empresaId)).fundador?.situacao, 'RESERVADA');
    const nova = (await oferta(f.empresaId)).id;
    assert.notEqual(nova, cancelada);
    b = await somenteLeitura(() => consultarBeneficioFundador(client as never, f.empresaId));
    assert.deepEqual([b?.situacao, b?.contratacaoId, b?.contratacaoEstado], ['RESERVADA', nova, 'EM_ABERTO'], 'a oferta em aberto, nunca a cancelada');
    // B: contratação atual CONFIRMADA e outra EM_ABERTO na mesma concessão (fixture direta; o gatilho aceita durante o benefício).
    const extra = (await q(`INSERT INTO assinatura_contratacoes (empresa_id, chave_idempotencia, plano, ciclo, catalogo_versao, valor_regular_centavos,
            desconto_percentual, valor_final_centavos, fundador_id, criada_por)
        SELECT empresa_id, gen_random_uuid(), 'PROFISSIONAL', 'MENSAL', catalogo_versao, 39700, 40, 23820, fundador_id, criada_por
          FROM assinatura_contratacoes WHERE id = $1 RETURNING id`, [B.oferta])).rows[0].id as string;
    b = await somenteLeitura(() => consultarBeneficioFundador(client as never, B.empresaId));
    assert.deepEqual([b?.situacao, b?.contratacaoId, b?.contratacaoEstado], ['CONFIRMADA_VIGENTE', B.oferta, 'CONFIRMADA'], 'a contratação atual da assinatura vence a aberta');
    await q("UPDATE assinatura_contratacoes SET estado = 'CANCELADA', cancelada_em = clock_timestamp(), motivo_cancelamento = 'Fixture sintética encerrada' WHERE id = $1", [extra]);
    assert.equal((await somenteLeitura(() => consultarBeneficioFundador(client as never, B.empresaId)))?.contratacaoId, B.oferta);
});

test('4. limites do prazo: fim no futuro → vigente; fim alcançado → encerrada; a leitura nunca grava', { skip: !opt() }, async () => {
    const e = await empresaEmTeste();
    const ofertaE = (await oferta(e.empresaId)).id;
    await confirmarPeloProduto(e.empresaId);
    // Fixture SINTÉTICA: o produto nunca move datas; para simular o tempo, as datas persistidas são deslocadas com os
    // gatilhos desligados nesta sessão (só no cluster descartável). A guarda de coerência (CHECK) continua valendo.
    const deslocar = (fim: string) => emTx(async () => {
        await q("SET LOCAL session_replication_role = replica");
        await q(`UPDATE assinatura_fundadores SET reservada_em = ${fim} - interval '12 months 1 hour', confirmada_em = ${fim} - interval '12 months',
            beneficio_fim = ${fim} WHERE empresa_id = $1`, [e.empresaId]);
    });
    await deslocar("clock_timestamp() + interval '1 hour'");
    let b = await somenteLeitura(() => consultarBeneficioFundador(client as never, e.empresaId));
    assert.equal(b?.situacao, 'CONFIRMADA_VIGENTE');
    await deslocar('clock_timestamp()');
    b = await somenteLeitura(() => consultarBeneficioFundador(client as never, e.empresaId));
    assert.equal(b?.situacao, 'ENCERRADA', 'no instante do fim (já alcançado), encerrada');
    await deslocar("clock_timestamp() - interval '1 day'");
    const antes = await retrato();
    b = await somenteLeitura(() => consultarBeneficioFundador(client as never, e.empresaId));
    const p = await persistido(e.empresaId);
    assert.deepEqual(b, { situacao: 'ENCERRADA', reservadaEm: p.r, confirmadaEm: p.c, beneficioFim: p.f, contratacaoId: ofertaE, contratacaoEstado: 'CONFIRMADA' });
    assert.equal((await gestao(e.empresaId)).fundador?.situacao, 'ENCERRADA');
    assert.equal((await somenteLeitura(() => comercialDaEmpresa(client as never, e.empresaId))).fundador?.situacao, 'ENCERRADA');
    assert.deepEqual(await retrato(), antes, 'consultas não gravam');
    // As outras empresas não mudaram.
    assert.equal((await gestao(B.empresaId)).fundador?.situacao, 'CONFIRMADA_VIGENTE');
    assert.equal((await gestao(A.empresaId)).fundador?.situacao, 'RESERVADA');
});

test('5. com a 090: o desenvolvedor vê fase e vaga; a Gestão não recebe vaga nem fase', { skip: !opt() }, async () => {
    await q(SQL.pre090); await q(SQL.up090); await q(SQL.post090);
    const dev = await somenteLeitura(() => consultarBeneficioFundadorDesenvolvedor(client as never, B.empresaId));
    assert.equal(dev?.origem, 'LEGADO');
    assert.ok(Number.isInteger(dev?.vaga));
    const g = await gestao(B.empresaId);
    assert.equal(g.fundador?.situacao, 'CONFIRMADA_VIGENTE');
    assert.deepEqual(Object.keys(g.fundador!).sort(), ['beneficioFim', 'confirmadaEm', 'contratacaoEstado', 'contratacaoId', 'reservadaEm', 'situacao']);
    semVazamento([dev, g.fundador], B.documento, B.pagamento);
});
