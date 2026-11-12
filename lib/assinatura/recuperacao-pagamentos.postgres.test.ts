import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { conectarDescartavel, encerrarDescartavel } from '../comercial/postgres-descartavel.ts';
import { iniciarTeste } from './servico.ts';
import { prepararOferta, type PedidoOferta } from './ofertas.ts';
import { sincronizarEmpresa } from './sincronizacao.ts';
import { DOCUMENTOS, hashDocumento } from '../cadastro/documentos-legais.ts';
import { creditarAposRevisao, processarEventoCreditos, processarPedido, vincularCobrancaCriada, type ContextoProvedor } from '../creditos/pagamento.ts';
import { opcaoDoPedido, registrarDevolucao } from '../creditos/devolucao.ts';
import { encerrarReserva, reservar } from '../creditos/ledger.ts';
import { resolverBloqueio } from '../creditos/operacao.ts';
import { registrarPedido } from './devolucao-registro.ts';
import { vencimentoEmDias } from '../creditos/dominio.ts';
import { diferenca, semEfeito, TABELAS, type Fotografia } from './recuperacao-efeitos.ts';
import { fotografar, regravarDoInstante, tabelasPresentes } from './recuperacao-fotografia.ts';
import { aplicarCaso, proporCaso } from './recuperacao-caso.ts';
import { provedorSomenteLeitura } from './recuperacao-provedor.ts';
import type { AssinaturaProvedor, CobrancaProvedor } from './asaas.ts';
import { aplicarCasoReal, identidadeDoCaso, proporCasoReal, type Caso, type ContextoRecuperacao } from './recuperacao-casos.ts';
import { classificar } from './recuperacao-classes.ts';
import { itemDaBase } from './recuperacao-baseline.ts';
import { evidenciaDoCaso } from './recuperacao-evidencia.ts';
import type { Leitura } from './recuperacao-caso.ts';
import { registrarEvento } from './sincronizacao.ts';

/**
 * B-14 (plano rev. 8.1, §3.3.1, §3.4) no PostgreSQL DESCARTÁVEL, modelo 097 (089–097, inclusive créditos 095).
 * Asaas FALSO em memória. Cobre:
 *   1. fotografia real das tabelas de cobrança da empresa;
 *   2. idempotência por fotografia em estados estáveis (assinatura ATIVA e CANCELADA_FIM_PERIODO; créditos
 *      AGUARDANDO_PAGAMENTO/PENDING, VENCIDO/OVERDUE e CREDITADO/RECEIVED): a 2ª execução do processamento normal só muda
 *      o domínio do SEM_EFEITO (gatilhos reais da 074a e da 095), com o relógio avançado entre as execuções; e o caso de
 *      controle — mudança real no provedor — continua produzindo efeito;
 *   3. proposta (nada gravado) e aplicação em T2 (mesmo hash, data comercial aprovada; repetição → DIVERGENTE);
 *   4. crédito recriado com validade pela data do pagamento (D-B14-15);
 *   5. casos ligados aos serviços (incremento 3): empresa, evento e pedido pelo provedor da lista fechada, origem da
 *      auditoria, base da validade no RESTORE, classe e item da linha de base;
 *   6. revisão de 27/10: crédito já vencido na recuperação (P1-1) fica em REVISAO sem lote, o processamento normal não o
 *      credita sozinho, só a pessoa; troca do efeito entre T1 e T2 → DIVERGENTE; comprovação do pedido (P1-2) com a
 *      fotografia real; fotografia sem os textos livres da 097 (P3-6);
 *   7. revisão de 27/10, rodada 2: a retenção da pessoa sobrevive a qualquer sequência de leituras (null, PENDING, OVERDUE,
 *      removida, REFUNDED, paga com data nova); a meia-noite entre a conferência do vencimento e o INSERT (gatilho de teste
 *      que faz o CHECK real da 095 recusar o lote) vira a mesma revisão, e outro erro não é mascarado; a evidência não leva
 *      a descrição do estorno lida no provedor.
 */
const opt = () => process.env.KIDMAIS_POSTGRES_DESCARTAVEL === 'kidmais_pacotes_v1_descartavel';
const ENV = { ASSINATURA_PLANOS_ATIVOS: 'true', ASAAS_AMBIENTE: 'sandbox' };
const PEDIDO: PedidoOferta = { plano: 'essencial', ciclo: 'MENSAL', valorEsperadoCentavos: 11820, versao: '2026-10-20' };
const DIA = 86400000;

let client: Client;
let usuario = '';
let seq = 0;
const q = (texto: string, params: unknown[] = []) => client.query(texto, params);
async function emTx<T>(acao: () => Promise<T>): Promise<T> {
    await client.query('BEGIN');
    try { const r = await acao(); await client.query('COMMIT'); return r; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
}
const avancarRelogio = () => q('SELECT pg_sleep(0.05)');
function cnpj(n: number) {
    const base = `6${String(n).padStart(7, '0')}0001`;
    const dv = (b: string) => { let s = 0, p = 2; for (let i = b.length - 1; i >= 0; i--) { s += (b.charCodeAt(i) - 48) * p; p = p === 9 ? 2 : p + 1; } const r = s % 11; return r <= 1 ? 0 : 11 - r; };
    const d1 = dv(base); return base + d1 + dv(base + d1);
}
const docs = () => Object.fromEntries(Object.values(DOCUMENTOS).map((d) => [d.documento, { versao: d.versao, hash: hashDocumento(d) }]));
const hoje = async () => (await q("SELECT to_char(clock_timestamp() AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS d")).rows[0].d as string;
const diaMenos = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) - n * DIA).toISOString().slice(0, 10);

/** Asaas falso, mutável entre execuções: assinatura, cobranças da assinatura e cobranças avulsas (créditos). */
function asaas() {
    const subs = new Map<string, AssinaturaProvedor>();
    const daAssinatura = new Map<string, CobrancaProvedor[]>();
    const avulsas = new Map<string, CobrancaProvedor>();
    const cliente = {
        async obterAssinatura(id: string) { const s = subs.get(id); return s ? { ...s } : null; },
        async listarCobrancasDaAssinatura(id: string) { return (daAssinatura.get(id) ?? []).map((p) => ({ ...p })); },
        async listarAssinaturasPorReferencia(ref: string) { return [...subs.values()].filter((s) => s.externalReference === ref).map((s) => ({ ...s })); },
        async obterCobranca(id: string) { const c = avulsas.get(id); return c ? { ...c, estornos: [...(c.estornos ?? [])] } : null; },
        async listarCobrancasPorReferencia(ref: string) { return [...avulsas.values()].filter((c) => c.externalReference === ref).map((c) => ({ ...c })); },
        // Escritas existem no dublê para provar que a lista fechada as corta.
        async removerAssinatura() { throw new Error('escrita no provedor proibida'); },
    };
    return { subs, daAssinatura, avulsas, cliente, somenteLeitura: provedorSomenteLeitura(cliente) };
}

/** Empresa com assinatura ATIVA e oferta Fundador confirmada pelo caminho do produto (como a suíte do B-9). */
async function empresaAtiva(a: ReturnType<typeof asaas>) {
    const n = ++seq;
    const id = (await q("INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Buffet Recuperação', 'PROVISIONAMENTO') RETURNING id", [`rp${n}${randomBytes(3).toString('hex')}`])).rows[0].id as string;
    await q("UPDATE empresas SET status = 'ATIVA' WHERE id = $1", [id]);
    await q(`INSERT INTO plataforma_empresas_cadastro (empresa_id, nome_empresarial, documento_fiscal, responsavel_nome, email, criado_por, atualizado_por)
        VALUES ($1, 'Festas Recuperação Ltda', $2, 'Responsável', $3, $4, $4)`, [id, cnpj(n), `rp${n}@example.test`, usuario]);
    await emTx(() => iniciarTeste(client as never, { empresaId: id, documento: cnpj(n) }));
    await q(`INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1, $2, 'PENDENTE', clock_timestamp(), 'REPRESENTANTE_AUTORIZADO')`, [id, usuario]);
    await q("UPDATE memberships SET status = 'ATIVA' WHERE empresa_id = $1 AND usuario_id = $2", [id, usuario]);
    await emTx(() => prepararOferta(client as never, id, usuario, { ...PEDIDO, documentos: docs() }, ENV));
    const dia = await hoje();
    const k = randomBytes(4).toString('hex');
    const sub: AssinaturaProvedor = { id: `sub_${k}`, customer: `cus_${k}`, externalReference: id, cycle: 'MONTHLY', status: 'ACTIVE', deleted: false, valorCentavos: 11820, nextDueDate: dia };
    a.subs.set(sub.id, sub);
    a.daAssinatura.set(sub.id, [{ id: `pay_${k}`, status: 'RECEIVED', dueDate: dia, paymentDate: dia, deleted: false, invoiceUrl: null, valorCentavos: 11820,
        assinaturaId: sub.id, clienteId: sub.customer, billingType: 'PIX' }]);
    await q("UPDATE empresa_assinaturas SET provedor = 'ASAAS', provedor_cliente_id = $2, provedor_assinatura_id = $3 WHERE empresa_id = $1", [id, sub.customer, sub.id]);
    const r = await emTx(() => sincronizarEmpresa(client as never, id, { provedor: a.somenteLeitura as never }, { tipo: 'RECONCILIACAO' }));
    assert.equal(r.resultado === 'SINCRONIZADA' && r.depois, 'ATIVA');
    return { id, sub };
}

/** Pedido de créditos WALLE (sem corte) com cobrança canônica vinculada pelo caminho do produto. */
async function pedidoWalle(a: ReturnType<typeof asaas>, empresaId: string, cliente: string, status: string, extra: Partial<CobrancaProvedor> = {}) {
    const pedidoId = randomUUID();
    const dia = await hoje();
    const letras = 'ABCDEFGHJKMNPQRSTVWXYZ0123456789';
    const protocolo = `KM-${dia.replaceAll('-', '')}-${Array.from(randomBytes(8), (b) => letras[b % letras.length]).join('')}`;
    await q(`INSERT INTO ia_credito_pedidos (id, empresa_id, protocolo, recurso, catalogo_versao, oferta_codigo, oferta, termos_versao, termos_sha256, quantidade,
            preco_centavos, validade_dias, forma, ambiente, chave_idempotencia, payload_sha256, estado, solicitado_por, vencimento_pagamento)
        VALUES ($1, $2, $3, 'WALLE', 'CATALOGO-B14', 'WALLE_1000', '{}'::jsonb, 'creditos-ia-20261022.demo', $4, 1000, 9900, 90, 'PIX', 'sandbox', $5, $4,
            'CRIACAO_EM_CURSO', $6, $7::date)`, [pedidoId, empresaId, protocolo, 'a'.repeat(64), randomUUID(), usuario, dia]);
    const pagamento: CobrancaProvedor = { id: `pay_${randomBytes(5).toString('hex')}`, status, dueDate: dia, paymentDate: null, invoiceUrl: null, deleted: false,
        valorCentavos: 9900, clienteId: cliente, billingType: 'PIX', externalReference: `km:sandbox:creditos:${pedidoId}`, assinaturaId: null, ...extra };
    a.avulsas.set(pagamento.id, pagamento);
    const ctx: ContextoProvedor = { provedor: a.somenteLeitura as never, ambiente: 'sandbox', conta: 'padrao' };
    await emTx(() => vincularCobrancaCriada(client as never, pedidoId, ctx, pagamento));
    return { pedidoId, pagamento, ctx };
}

/** Idempotência por fotografia: 1ª execução leva ao estado estável; 2ª, com o relógio avançado, só pode ser SEM_EFEITO. */
/**
 * Contadores de escrita das tabelas da lista fechada (pg_stat_xact_user_tables). No PostgreSQL 15+ a visão também traz
 * contadores pendentes de transações anteriores da sessão: por isso a medida é a DIFERENÇA entre duas leituras na mesma
 * transação, antes e depois do trabalho.
 */
async function contadores() {
    const r = await q(`SELECT relname AS t, n_tup_ins AS i, n_tup_upd AS u, n_tup_del AS d FROM pg_stat_xact_user_tables
        WHERE schemaname = 'public' AND relname = ANY($1::text[])`, [Object.keys(TABELAS)]);
    return new Map(r.rows.map((l) => [l.t as string, { ins: Number(l.i), upd: Number(l.u), del: Number(l.d) }]));
}
async function escritasDe(trabalho: () => Promise<unknown>) {
    const a = await contadores();
    await trabalho();
    const d = await contadores();
    const r: Record<string, { ins: number; upd: number; del: number }> = {};
    for (const [t, x] of d) {
        const y = a.get(t) ?? { ins: 0, upd: 0, del: 0 };
        const delta = { ins: x.ins - y.ins, upd: x.upd - y.upd, del: x.del - y.del };
        if (delta.ins || delta.upd || delta.del) r[t] = delta;
    }
    return Object.fromEntries(Object.entries(r).sort(([p], [q2]) => p.localeCompare(q2)));
}
/**
 * Idempotência por fotografia: 1ª execução leva ao estado estável; 2ª, com o relógio avançado, só pode ser SEM_EFEITO E só
 * pode escrever o UPDATE de observação esperado (`observacao`: tabela → quantidade de linhas). A contagem pega a regravação
 * redundante que a fotografia final não vê (a marca de observação já renova a mesma coluna derivada).
 */
async function segundaExecucao(empresaId: string, executar: () => Promise<unknown>, observacao: Record<string, number>) {
    await emTx(executar);
    const antes = await fotografar(client as never, { empresaId });
    await avancarRelogio();
    const escritas = await emTx(() => escritasDe(executar));
    const depois = await fotografar(client as never, { empresaId });
    const esperado = Object.fromEntries(Object.entries(observacao).map(([t, n]) => [t, { ins: 0, upd: n, del: 0 }]));
    assert.deepEqual(escritas, esperado, 'escritas da 2ª execução: só o UPDATE de observação');
    return diferenca(antes, depois);
}
const resumo = (e: ReturnType<typeof diferenca>) => e.map((x) => `${x.operacao} ${x.tabela}.${Object.keys(x.colunas).join(',')}`);

test.before(async () => {
    if (!opt()) return;
    client = await conectarDescartavel();
    usuario = (await q("INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Gestão Recuperação', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id",
        [`rp${randomBytes(3).toString('hex')}@example.test`, `scrypt$v=1$N=131072$r=8$p=1$${'A'.repeat(22)}==$${'B'.repeat(86)}==`])).rows[0].id;
});
test.after(async () => { if (client) await encerrarDescartavel(client); });

/**
 * Revisão do HB-3 r4 (P2): a suíte roda também em cada prefixo P0a…P11 e no PH do staging (combinações aplicáveis da
 * §3.3.1). Cada teste declara o que precisa; onde o prefixo não tem (créditos antes da 095, encerramentos antes da 089,
 * textos da 097), é pulado com o motivo — nunca passa em falso.
 */
type Requisito = '095' | '089' | '097';
const MARCADOR: Record<Requisito, string> = { '095': 'ia_credito_pedidos', '089': 'assinatura_encerramentos', '097': 'assinatura_arrependimentos' };
async function falta(t: { skip: (m: string) => void }, ...req: Requisito[]) {
    for (const r of req) if (!(await q("SELECT to_regclass('public.' || $1) IS NOT NULL AS ok", [MARCADOR[r]])).rows[0].ok) { t.skip(`prefixo sem a ${r}`); return true; }
    return false;
}

test('fotografia real: tabelas da lista fechada presentes no modelo 097 e linhas da empresa', { skip: !opt() }, async (t) => {
    if (await falta(t, '095', '089')) return;
    const presentes = await tabelasPresentes(client as never);
    for (const t of ['empresa_assinaturas', 'assinatura_contratacoes', 'assinatura_fundadores', 'assinatura_encerramentos', 'cobranca_eventos', 'auditoria',
        'ia_credito_pedidos', 'ia_credito_cobrancas', 'ia_credito_lotes', 'ia_credito_lancamentos', 'ia_credito_carteiras', 'ia_credito_notificacoes'])
        assert.ok(presentes.includes(t), t);
    const a = asaas();
    const { id } = await empresaAtiva(a);
    const f: Fotografia = await fotografar(client as never, { empresaId: id });
    assert.equal(f.empresa_assinaturas.length, 1);
    assert.equal(f.empresa_assinaturas[0].situacao, 'ATIVA');
    assert.ok(f.auditoria.length >= 1, 'auditoria da sincronização da empresa');
});

test('idempotência: assinatura ATIVA estável → SEM_EFEITO (gatilho real da 074a), e mudança real no provedor ainda é efeito', { skip: !opt() }, async (t) => {
    if (await falta(t)) return;
    const a = asaas();
    const { id, sub } = await empresaAtiva(a);
    const sinc = () => sincronizarEmpresa(client as never, id, { provedor: a.somenteLeitura as never }, { tipo: 'RECONCILIACAO' });
    const estavel = await segundaExecucao(id, sinc, { empresa_assinaturas: 1 });
    assert.equal(semEfeito(estavel), true, resumo(estavel).join(' | '));
    // Controle: o provedor passa a INACTIVE (cancelada) → a próxima execução muda a situação: efeito.
    a.subs.set(sub.id, { ...sub, status: 'INACTIVE' });
    const antes = await fotografar(client as never, { empresaId: id });
    await avancarRelogio();
    await emTx(sinc);
    const mudou = diferenca(antes, await fotografar(client as never, { empresaId: id }));
    assert.equal(semEfeito(mudou), false);
    assert.ok(mudou.some((e) => e.tabela === 'empresa_assinaturas' && e.colunas.situacao), resumo(mudou).join(' | '));
    // E o novo estado (CANCELADA_FIM_PERIODO) também é estável.
    const estavel2 = await segundaExecucao(id, sinc, { empresa_assinaturas: 1 });
    assert.equal(semEfeito(estavel2), true, resumo(estavel2).join(' | '));
});

test('idempotência: créditos AGUARDANDO_PAGAMENTO/PENDING, VENCIDO/OVERDUE e CREDITADO/RECEIVED estáveis → SEM_EFEITO (gatilho real da 095)', { skip: !opt() }, async (t) => {
    if (await falta(t, '095')) return;
    const a = asaas();
    const { id, sub } = await empresaAtiva(a);
    const p1 = await pedidoWalle(a, id, sub.customer!, 'PENDING');
    const e1 = await segundaExecucao(id, () => processarPedido(client as never, p1.pedidoId, p1.ctx), { ia_credito_cobrancas: 1 });
    assert.equal(semEfeito(e1), true, `AGUARDANDO: ${resumo(e1).join(' | ')}`);

    a.avulsas.set(p1.pagamento.id, { ...p1.pagamento, status: 'OVERDUE' });
    const e2 = await segundaExecucao(id, () => processarPedido(client as never, p1.pedidoId, p1.ctx), { ia_credito_cobrancas: 1 });
    assert.equal(semEfeito(e2), true, `VENCIDO: ${resumo(e2).join(' | ')}`);
    assert.equal((await q('SELECT estado FROM ia_credito_pedidos WHERE id = $1', [p1.pedidoId])).rows[0].estado, 'VENCIDO');

    const dia = await hoje();
    a.avulsas.set(p1.pagamento.id, { ...p1.pagamento, status: 'RECEIVED', paymentDate: dia });
    const e3 = await segundaExecucao(id, () => processarPedido(client as never, p1.pedidoId, p1.ctx), { ia_credito_cobrancas: 1 });
    assert.equal(semEfeito(e3), true, `CREDITADO: ${resumo(e3).join(' | ')}`);
    assert.equal((await q('SELECT estado FROM ia_credito_pedidos WHERE id = $1', [p1.pedidoId])).rows[0].estado, 'CREDITADO');

    // Controle: estorno parcial remoto com status ainda pago → efeito (bloqueio do remanescente, retenção).
    a.avulsas.set(p1.pagamento.id, { ...p1.pagamento, status: 'RECEIVED', paymentDate: dia, estornos: [{ status: 'DONE', valorCentavos: 4000, descricao: null }] });
    const antes = await fotografar(client as never, { empresaId: id });
    await avancarRelogio();
    await emTx(() => processarPedido(client as never, p1.pedidoId, p1.ctx));
    const mudou = diferenca(antes, await fotografar(client as never, { empresaId: id }));
    assert.equal(semEfeito(mudou), false, resumo(mudou).join(' | '));
});

test('caso real: proposta não grava nada; aplicação em T2 grava a data aprovada com o mesmo hash; repetir → DIVERGENTE', { skip: !opt() }, async (t) => {
    if (await falta(t)) return;
    const a = asaas();
    const { id, sub } = await empresaAtiva(a);
    a.subs.set(sub.id, { ...sub, status: 'INACTIVE' });
    const deps = (caso: string) => ({ tx: client as never, caso, provedor: a.somenteLeitura, fotografar: () => fotografar(client as never, { empresaId: id }),
        executar: (provedor: typeof a.somenteLeitura) => sincronizarEmpresa(client as never, id, { provedor: provedor as never }, { tipo: 'RECUPERACAO_B14', caso, requestId: randomUUID() }) });
    const inicio = await fotografar(client as never, { empresaId: id });
    const p = await emTx(() => proporCaso(deps('caso-1')));
    assert.equal(p.semEfeito, false);
    assert.deepEqual(diferenca(inicio, await fotografar(client as never, { empresaId: id })), [], 'nada gravado pela proposta');
    const cancelada = p.proposta.efeitos.find((e) => e.tabela === 'empresa_assinaturas')?.colunas.cancelada_em?.depois;
    assert.equal(typeof cancelada, 'string');

    await avancarRelogio();
    const r = await emTx(() => aplicarCaso({ ...deps('caso-1'), regravar: (v) => regravarDoInstante(client as never, v) }, { hash: p.hash, proposta: p.proposta }));
    assert.equal(r.situacao, 'APLICADO', `hash ${r.hash} ≠ ${p.hash}
T1 ${JSON.stringify(p.proposta)}
T2 ${JSON.stringify(r.proposta)}`);
    const linha = (await q("SELECT situacao, to_jsonb(cancelada_em) AS c FROM empresa_assinaturas WHERE empresa_id = $1", [id])).rows[0];
    assert.equal(linha.situacao, 'CANCELADA_FIM_PERIODO');
    assert.equal(linha.c, cancelada, 'data comercial do instante = a aprovada');

    const de = await emTx(() => aplicarCaso({ ...deps('caso-1'), regravar: (v) => regravarDoInstante(client as never, v) }, { hash: p.hash, proposta: p.proposta }));
    assert.equal(de.situacao, 'DIVERGENTE', 'pré-condição local mudou depois da aplicação');
});

test('crédito recriado pelo caso com baseValidade PAGAMENTO: lote vence pela data do pagamento (D-B14-15)', { skip: !opt() }, async (t) => {
    if (await falta(t, '095')) return;
    const a = asaas();
    const { id, sub } = await empresaAtiva(a);
    const p = await pedidoWalle(a, id, sub.customer!, 'PENDING');
    const pago = diaMenos(await hoje(), 20);
    a.avulsas.set(p.pagamento.id, { ...p.pagamento, status: 'RECEIVED', paymentDate: pago });
    const ctx: ContextoProvedor = { ...p.ctx, baseValidade: 'PAGAMENTO' };
    const deps = { tx: client as never, caso: 'credito-1', provedor: a.somenteLeitura, fotografar: () => fotografar(client as never, { empresaId: id }),
        executar: (provedor: typeof a.somenteLeitura) => processarPedido(client as never, p.pedidoId, { ...ctx, provedor: provedor as never }) };
    const proposta = await emTx(() => proporCaso(deps));
    assert.ok(proposta.proposta.efeitos.some((e) => e.tabela === 'ia_credito_lotes' && e.operacao === 'INSERT'));
    await avancarRelogio();
    const r = await emTx(() => aplicarCaso({ ...deps, regravar: (v) => regravarDoInstante(client as never, v) }, { hash: proposta.hash, proposta: proposta.proposta }));
    assert.equal(r.situacao, 'APLICADO');
    const vence = (await q("SELECT (extract(epoch FROM vence_em) * 1000)::bigint AS v FROM ia_credito_lotes WHERE empresa_id = $1 AND chave_origem = $2", [id, `COMPRA:${p.pedidoId}`])).rows[0].v;
    assert.equal(Number(vence), vencimentoEmDias(Date.parse(`${pago}T12:00:00-03:00`), 90));
});

const contexto = (a: ReturnType<typeof asaas>, modo: 'JANELA' | 'RESTORE', presentes: readonly string[]): ContextoRecuperacao => ({ tx: client as never, execucao: randomUUID(), modo,
    cliente: a.cliente, creditos: { ambiente: 'sandbox', conta: 'padrao' }, presentes });
const entrada = (p: Awaited<ReturnType<typeof proporCasoReal>>, modo: 'JANELA' | 'RESTORE') => ({ modo, tipo: p.caso.tipo, id: p.caso.id, empresaId: p.caso.empresaId, falha: p.falha,
    resultado: p.resultado, antes: p.antes, efeitos: p.proposta?.efeitos ?? [], leituras: (p.proposta?.precondicoes.remoto ?? []) as Leitura[] });

test('casos ligados aos serviços: empresa estável → RECONCILIADA; cancelada no provedor → PROPOSTA com recusas e auditoria RECUPERACAO_B14', { skip: !opt() }, async (t) => {
    if (await falta(t, '095')) return;
    const presentes = await tabelasPresentes(client as never);
    const a = asaas();
    const { id, sub } = await empresaAtiva(a);
    const caso: Caso = { tipo: 'EMPRESA', id, empresaId: id };
    // Estável: na JANELA e no RESTORE, só observação, vínculo comprovado.
    for (const modo of ['JANELA', 'RESTORE'] as const) {
        const p = await emTx(() => proporCasoReal(contexto(a, modo, presentes), caso));
        assert.equal(p.falha, null);
        assert.equal(classificar(entrada(p, modo)).classe, 'RECONCILIADA', modo);
        assert.ok((p.proposta!.precondicoes.remoto as Leitura[]).every((l) => l.metodo !== 'removerAssinatura'));
    }
    a.subs.set(sub.id, { ...sub, status: 'INACTIVE' });
    const ctx = contexto(a, 'RESTORE', presentes);
    const p = await emTx(() => proporCasoReal(ctx, caso));
    const c = classificar(entrada(p, 'RESTORE'));
    assert.deepEqual([c.classe, c.recusas], ['PROPOSTA', ['DATA_DO_INSTANTE', 'QUEDA_SITUACAO']]);
    const item = itemDaBase(p, c);
    assert.deepEqual([item.identidade, item.estado, item.hashProposta], [identidadeDoCaso('EMPRESA', id), 'ATIVA', p.hash]);
    await avancarRelogio();
    const r = await emTx(() => aplicarCasoReal({ ...ctx, execucao: randomUUID() }, caso, { hash: p.hash!, proposta: p.proposta! }));
    assert.equal(r.situacao, 'APLICADO', 'outra execução (outro request_id) aplica com o mesmo hash');
    const aud = (await q(`SELECT dados_depois->>'caso' AS caso FROM auditoria WHERE entidade_id = $1 AND dados_depois ? 'caso' ORDER BY criado_em DESC LIMIT 1`, [id])).rows[0];
    assert.equal(aud?.caso, identidadeDoCaso('EMPRESA', id), 'auditoria com a identidade do caso');
});

test('casos ligados aos serviços: evento pendente com origem da recuperação; pedido no RESTORE com validade pela data do pagamento', { skip: !opt() }, async (t) => {
    if (await falta(t, '095')) return;
    const presentes = await tabelasPresentes(client as never);
    const a = asaas();
    const { id, sub } = await empresaAtiva(a);
    const ev = await emTx(() => registrarEvento(client as never, { eventoId: `evt_${randomBytes(5).toString('hex')}`, tipo: 'PAYMENT_RECEIVED', criadoNoProvedor: null,
        assinaturaId: sub.id, cobrancaId: null, checkoutId: null, referenciaExterna: null }));
    const casoEv: Caso = { tipo: 'EVENTO', id: ev.id, empresaId: id };
    // Mudança real no provedor: a sincronização do evento audita a transição (empresa estável não audita).
    a.subs.set(sub.id, { ...sub, status: 'INACTIVE' });
    const pe = await emTx(() => proporCasoReal(contexto(a, 'RESTORE', presentes), casoEv));
    assert.equal(pe.falha, null);
    assert.deepEqual(pe.resultado, { situacao: 'PROCESSADO', empresaId: id });
    assert.ok(pe.proposta!.efeitos.some((e) => e.tabela === 'cobranca_eventos' && e.colunas.situacao?.depois === 'PROCESSADO'), 'evento processado é efeito');
    assert.equal(classificar(entrada(pe, 'RESTORE')).classe, 'PROPOSTA');
    const audEv = pe.proposta!.efeitos.filter((e) => e.tabela === 'auditoria' && e.operacao === 'INSERT').map((e) => JSON.parse(String(e.colunas.dados_depois?.depois ?? 'null')));
    assert.ok(audEv.length > 0 && audEv.every((d) => d?.caso === identidadeDoCaso('EVENTO', ev.id)), 'auditoria do evento com a origem da recuperação (não WEBHOOK)');
    assert.equal((await q('SELECT situacao FROM cobranca_eventos WHERE id = $1', [ev.id])).rows[0].situacao, 'PENDENTE', 'proposta não grava');
    a.subs.set(sub.id, sub);

    const p = await pedidoWalle(a, id, sub.customer!, 'PENDING');
    const pago = diaMenos(await hoje(), 20);
    a.avulsas.set(p.pagamento.id, { ...p.pagamento, status: 'RECEIVED', paymentDate: pago });
    const casoPed: Caso = { tipo: 'PEDIDO', id: p.pedidoId, empresaId: id };
    const ctx = contexto(a, 'RESTORE', presentes);
    const pp = await emTx(() => proporCasoReal(ctx, casoPed));
    const lote = pp.proposta!.efeitos.find((e) => e.tabela === 'ia_credito_lotes' && e.operacao === 'INSERT');
    assert.equal(Date.parse(String(lote?.colunas.vence_em.depois)), vencimentoEmDias(Date.parse(`${pago}T12:00:00-03:00`), 90), 'RESTORE: base da validade = pagamento');
    const janela = await emTx(() => proporCasoReal(contexto(a, 'JANELA', presentes), casoPed));
    const loteJanela = janela.proposta!.efeitos.find((e) => e.tabela === 'ia_credito_lotes' && e.operacao === 'INSERT');
    assert.notEqual(loteJanela?.colunas.vence_em.depois, lote?.colunas.vence_em.depois, 'JANELA: regra da candidata (não a data do pagamento)');
    await avancarRelogio();
    assert.equal((await emTx(() => aplicarCasoReal({ ...ctx, execucao: randomUUID() }, casoPed, { hash: pp.hash!, proposta: pp.proposta! }))).situacao, 'APLICADO');
    const depois = await emTx(() => proporCasoReal(contexto(a, 'RESTORE', presentes), casoPed));
    assert.equal(classificar(entrada(depois, 'RESTORE'), { ambiente: 'sandbox', conta: 'padrao' }).classe, 'RECONCILIADA', 'depois de aplicado: estável e coerente');
});

const lotesDoPedido = async (empresaId: string, pedidoId: string) => Number((await q('SELECT count(*) AS n FROM ia_credito_lotes WHERE empresa_id = $1 AND pedido_id = $2', [empresaId, pedidoId])).rows[0].n);
const estadoDoPedido = async (pedidoId: string) => (await q('SELECT estado, revisao_motivo FROM ia_credito_pedidos WHERE id = $1', [pedidoId])).rows[0];

test('P1-1: crédito já vencido na recuperação → REVISAO sem lote nem notificação; o normal não credita sozinho; só a pessoa', { skip: !opt() }, async (t) => {
    if (await falta(t, '095')) return;
    const presentes = await tabelasPresentes(client as never);
    const a = asaas();
    const { id, sub } = await empresaAtiva(a);
    const p = await pedidoWalle(a, id, sub.customer!, 'PENDING');
    a.avulsas.set(p.pagamento.id, { ...p.pagamento, status: 'RECEIVED', paymentDate: diaMenos(await hoje(), 100) });
    const caso: Caso = { tipo: 'PEDIDO', id: p.pedidoId, empresaId: id };
    const ctx = contexto(a, 'RESTORE', presentes);
    const pp = await emTx(() => proporCasoReal(ctx, caso));
    assert.equal(pp.falha, null, 'o INSERT do lote vencido não chega a ser tentado');
    assert.deepEqual(pp.resultado, { resultado: 'REVISAO', motivo: 'CREDITO_VENCIDO_NA_RECUPERACAO' });
    assert.equal(pp.proposta!.efeitos.some((e) => e.tabela === 'ia_credito_lotes' || e.tabela === 'ia_credito_notificacoes'), false);
    const c = classificar(entrada(pp, 'RESTORE'), { ambiente: 'sandbox', conta: 'padrao' });
    assert.deepEqual([c.classe, c.recusas], ['PROPOSTA', ['SERVICO:CREDITO_VENCIDO_NA_RECUPERACAO']]);
    await avancarRelogio();
    assert.equal((await emTx(() => aplicarCasoReal({ ...ctx, execucao: randomUUID() }, caso, { hash: pp.hash!, proposta: pp.proposta! }))).situacao, 'APLICADO');
    assert.deepEqual(await estadoDoPedido(p.pedidoId), { estado: 'REVISAO', revisao_motivo: 'CREDITO_VENCIDO_NA_RECUPERACAO' });
    // Depois da liberação: o cron/web (sem baseValidade) não credita com validade contada de agora.
    const normal = await emTx(() => processarPedido(client as never, p.pedidoId, p.ctx));
    assert.deepEqual(normal, { resultado: 'REVISAO', motivo: 'CREDITO_VENCIDO_NA_RECUPERACAO' });
    assert.equal(await lotesDoPedido(id, p.pedidoId), 0);
    const repetida = await emTx(() => proporCasoReal(ctx, caso));
    assert.equal(repetida.semEfeito, true, 'a revisão é estável: a liberação não é bloqueada por ela');
    // Só a decisão da pessoa credita.
    const pessoa = await emTx(() => creditarAposRevisao(client as never, p.pedidoId, p.ctx));
    assert.equal(pessoa.resultado, 'CREDITADO');
    assert.equal(await lotesDoPedido(id, p.pedidoId), 1);
});

test('P1-1: troca do efeito entre T1 e T2 (crédito → revisão por vencimento) → DIVERGENTE, nada gravado', { skip: !opt() }, async (t) => {
    if (await falta(t, '095')) return;
    const presentes = await tabelasPresentes(client as never);
    const a = asaas();
    const { id, sub } = await empresaAtiva(a);
    const p = await pedidoWalle(a, id, sub.customer!, 'PENDING');
    a.avulsas.set(p.pagamento.id, { ...p.pagamento, status: 'RECEIVED', paymentDate: diaMenos(await hoje(), 89) });
    const caso: Caso = { tipo: 'PEDIDO', id: p.pedidoId, empresaId: id };
    const ctx = contexto(a, 'RESTORE', presentes);
    const pp = await emTx(() => proporCasoReal(ctx, caso));
    assert.ok(pp.proposta!.efeitos.some((e) => e.tabela === 'ia_credito_lotes' && e.operacao === 'INSERT'), 'T1: lote vigente');
    // Em T2 o vencimento comercial já passou (simulado pela data lida; a virada real do dia não é reproduzível sem relógio falso).
    a.avulsas.set(p.pagamento.id, { ...p.pagamento, status: 'RECEIVED', paymentDate: diaMenos(await hoje(), 95) });
    const r = await emTx(() => aplicarCasoReal({ ...ctx, execucao: randomUUID() }, caso, { hash: pp.hash!, proposta: pp.proposta! }));
    assert.equal(r.situacao, 'DIVERGENTE');
    assert.equal(await lotesDoPedido(id, p.pedidoId), 0);
    assert.equal((await estadoDoPedido(p.pedidoId)).estado, 'AGUARDANDO_PAGAMENTO');
});

test('P1-2 com a fotografia real: CREDITADO coerente → RECONCILIADA; lote apagado da fotografia → não comprovado', { skip: !opt() }, async (t) => {
    if (await falta(t, '095')) return;
    const presentes = await tabelasPresentes(client as never);
    const a = asaas();
    const { id, sub } = await empresaAtiva(a);
    const p = await pedidoWalle(a, id, sub.customer!, 'PENDING');
    a.avulsas.set(p.pagamento.id, { ...p.pagamento, status: 'RECEIVED', paymentDate: await hoje() });
    await emTx(() => processarPedido(client as never, p.pedidoId, p.ctx));
    const caso: Caso = { tipo: 'PEDIDO', id: p.pedidoId, empresaId: id };
    const r = await emTx(() => proporCasoReal(contexto(a, 'JANELA', presentes), caso));
    const CTXC = { ambiente: 'sandbox', conta: 'padrao' };
    assert.equal(classificar(entrada(r, 'JANELA'), CTXC).classe, 'RECONCILIADA');
    const semLote = { ...entrada(r, 'JANELA'), antes: { ...r.antes!, ia_credito_lotes: [] } };
    assert.equal(classificar(semLote, CTXC).motivo, 'NAO_COMPROVADO:CREDITADO_SEM_LOTE');
});

test('P3-6: a fotografia não traz os textos livres da 097', { skip: !opt() }, async (t) => {
    if (await falta(t, '097')) return;
    const colunas = (await q("SELECT column_name FROM information_schema.columns WHERE table_name = 'assinatura_arrependimentos'")).rows.map((r) => r.column_name as string);
    for (const c of ['motivo', 'intermediador_referencia', 'conclusao_referencia']) assert.ok(colunas.includes(c), c);
    const a = asaas();
    const { id } = await empresaAtiva(a);
    const f = await fotografar(client as never, { empresaId: id });
    assert.ok(Array.isArray(f.assinatura_arrependimentos), 'tabela presente na fotografia');
    // Sem linha real de arrependimento nesta fixture: a omissão é conferida pelo SQL montado com a mesma expressão.
    const r = (await q(`SELECT to_jsonb(x) - ARRAY['motivo', 'intermediador_referencia', 'conclusao_referencia']::text[] AS l
        FROM (SELECT 'texto pessoal'::text AS motivo, 'ref'::text AS intermediador_referencia, 'concl'::text AS conclusao_referencia, 'RECEBIDO'::text AS situacao) x`)).rows[0].l;
    assert.deepEqual(r, { situacao: 'RECEBIDO' });
});

const RESTORE_CTX = (p: { ctx: ContextoProvedor }): ContextoProvedor => ({ ...p.ctx, baseValidade: 'PAGAMENTO' });

for (const [motivo, lerRetida] of [
    ['CREDITO_VENCIDO_NA_RECUPERACAO', async (pg: CobrancaProvedor) => ({ ...pg, status: 'RECEIVED', paymentDate: diaMenos(await hoje(), 100) })],
    ['SEM_DATA_PAGAMENTO', async (pg: CobrancaProvedor) => ({ ...pg, status: 'RECEIVED', paymentDate: null })],
] as const) {
    test(`P1 (rodada 2): retenção ${motivo} sobrevive a leituras intermediárias; o normal nunca credita; só a pessoa`, { skip: !opt() }, async (t) => {
    if (await falta(t, '095')) return;
        const a = asaas();
        const { id, sub } = await empresaAtiva(a);
        const p = await pedidoWalle(a, id, sub.customer!, 'PENDING');
        a.avulsas.set(p.pagamento.id, await lerRetida(p.pagamento));
        assert.deepEqual(await emTx(() => processarPedido(client as never, p.pedidoId, RESTORE_CTX(p))), { resultado: 'REVISAO', motivo });
        const dia = await hoje();
        const sequencia: [string, CobrancaProvedor | null][] = [
            ['nula', null],
            ['PENDING', { ...p.pagamento, status: 'PENDING' }],
            ['OVERDUE', { ...p.pagamento, status: 'OVERDUE' }],
            ['removida', { ...p.pagamento, status: 'PENDING', deleted: true }],
            ['REFUNDED', { ...p.pagamento, status: 'REFUNDED', paymentDate: dia }],
            ['paga hoje', { ...p.pagamento, status: 'RECEIVED', paymentDate: dia }],
            ['paga hoje (RESTORE)', { ...p.pagamento, status: 'RECEIVED', paymentDate: dia }],
        ];
        for (const [rotulo, lida] of sequencia) {
            if (lida) a.avulsas.set(p.pagamento.id, lida); else a.avulsas.delete(p.pagamento.id);
            const ctx = rotulo.endsWith('(RESTORE)') ? RESTORE_CTX(p) : p.ctx;
            assert.deepEqual(await emTx(() => processarPedido(client as never, p.pedidoId, ctx)), { resultado: 'REVISAO', motivo }, rotulo);
            assert.deepEqual(await estadoDoPedido(p.pedidoId), { estado: 'REVISAO', revisao_motivo: motivo }, rotulo);
            assert.equal(await lotesDoPedido(id, p.pedidoId), 0, rotulo);
        }
        // A situação lida continua registrada (a pessoa decide com ela).
        assert.equal((await q('SELECT situacao_provedor FROM ia_credito_cobrancas WHERE pedido_id = $1 AND canonica', [p.pedidoId])).rows[0].situacao_provedor, 'RECEIVED');
        const pessoa = await emTx(() => creditarAposRevisao(client as never, p.pedidoId, p.ctx));
        assert.equal(pessoa.resultado, 'CREDITADO');
        assert.equal(await lotesDoPedido(id, p.pedidoId), 1);
    });
}

/** Gatilho de TESTE, só no cluster descartável: roda depois do gatilho da 095 (ordem alfabética) e simula a meia-noite. */
async function comGatilhoDeTeste<T>(corpo: string, trabalho: () => Promise<T>) {
    await q(`CREATE FUNCTION b14_teste_gatilho() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN ${corpo} RETURN NEW; END $f$`);
    await q('CREATE TRIGGER ia_credito_lotes_zz_b14_teste_trg BEFORE INSERT ON ia_credito_lotes FOR EACH ROW EXECUTE FUNCTION b14_teste_gatilho()');
    try { return await trabalho(); }
    finally {
        await q('DROP TRIGGER ia_credito_lotes_zz_b14_teste_trg ON ia_credito_lotes');
        await q('DROP FUNCTION b14_teste_gatilho()');
    }
}

test('P2 (rodada 2): meia-noite entre a conferência e o INSERT → CHECK real recusa o lote → mesma revisão, sem erro do caso', { skip: !opt() }, async (t) => {
    if (await falta(t, '095')) return;
    const presentes = await tabelasPresentes(client as never);
    const a = asaas();
    const { id, sub } = await empresaAtiva(a);
    const p = await pedidoWalle(a, id, sub.customer!, 'PENDING');
    a.avulsas.set(p.pagamento.id, { ...p.pagamento, status: 'RECEIVED', paymentDate: diaMenos(await hoje(), 30) });
    const caso: Caso = { tipo: 'PEDIDO', id: p.pedidoId, empresaId: id };
    await comGatilhoDeTeste('NEW.liberado_em := NEW.vence_em;', async () => {
        const pp = await emTx(() => proporCasoReal(contexto(a, 'RESTORE', presentes), caso));
        assert.equal(pp.falha, null);
        assert.deepEqual(pp.resultado, { resultado: 'REVISAO', motivo: 'CREDITO_VENCIDO_NA_RECUPERACAO' });
        assert.equal(pp.proposta!.efeitos.some((e) => e.tabela === 'ia_credito_lotes' || e.tabela === 'ia_credito_lancamentos'), false);
        assert.deepEqual(await emTx(() => processarPedido(client as never, p.pedidoId, RESTORE_CTX(p))), { resultado: 'REVISAO', motivo: 'CREDITO_VENCIDO_NA_RECUPERACAO' });
    });
    assert.deepEqual(await estadoDoPedido(p.pedidoId), { estado: 'REVISAO', revisao_motivo: 'CREDITO_VENCIDO_NA_RECUPERACAO' });
    assert.equal(await lotesDoPedido(id, p.pedidoId), 0);
});

test('P2 (rodada 2): outro erro no INSERT do lote não vira revisão — sobe, e nada fica gravado', { skip: !opt() }, async (t) => {
    if (await falta(t, '095')) return;
    const a = asaas();
    const { id, sub } = await empresaAtiva(a);
    const p = await pedidoWalle(a, id, sub.customer!, 'PENDING');
    a.avulsas.set(p.pagamento.id, { ...p.pagamento, status: 'RECEIVED', paymentDate: diaMenos(await hoje(), 30) });
    await comGatilhoDeTeste("RAISE EXCEPTION 'outra recusa' USING ERRCODE = '23514', CONSTRAINT = 'outra_check';", async () => {
        await assert.rejects(emTx(() => processarPedido(client as never, p.pedidoId, RESTORE_CTX(p))), (e: { constraint?: string }) => e.constraint === 'outra_check');
        // Caminho normal (validade contada de agora): sem SAVEPOINT próprio, o erro também sobe.
        await assert.rejects(emTx(() => processarPedido(client as never, p.pedidoId, p.ctx)), (e: { constraint?: string }) => e.constraint === 'outra_check');
    });
    assert.deepEqual(await estadoDoPedido(p.pedidoId), { estado: 'AGUARDANDO_PAGAMENTO', revisao_motivo: null });
    assert.equal(await lotesDoPedido(id, p.pedidoId), 0);
});

test('P3 (rodada 2): a descrição do estorno lida no provedor não entra na proposta, no hash nem na evidência', { skip: !opt() }, async (t) => {
    if (await falta(t, '095')) return;
    const presentes = await tabelasPresentes(client as never);
    const a = asaas();
    const { id, sub } = await empresaAtiva(a);
    const p = await pedidoWalle(a, id, sub.customer!, 'PENDING');
    const marcador = 'MARCADOR PESSOAL DO ESTORNO';
    a.avulsas.set(p.pagamento.id, { ...p.pagamento, status: 'REFUNDED', paymentDate: await hoje(), estornos: [{ status: 'DONE', valorCentavos: 9900, descricao: marcador }] });
    const pp = await emTx(() => proporCasoReal(contexto(a, 'RESTORE', presentes), { tipo: 'PEDIDO', id: p.pedidoId, empresaId: id }));
    assert.equal(pp.falha, null);
    const lidas = pp.proposta!.precondicoes.remoto as Leitura[];
    assert.ok(lidas.some((l) => JSON.stringify(l.resultado).includes('"estornos"')), 'a leitura do estorno está na pré-condição');
    const c = classificar(entrada(pp, 'RESTORE'), { ambiente: 'sandbox', conta: 'padrao' });
    const ev = evidenciaDoCaso(pp, c, itemDaBase(pp, c));
    assert.equal(JSON.stringify(ev).includes(marcador), false);
    assert.equal(JSON.stringify(pp.proposta).includes(marcador), false);
});

/**
 * HB-3 (28/10/2026; §3.3.1): matriz dos estados estáveis de CRÉDITOS. Cada estado: 1ª execução chega nele; 2ª, com o
 * relógio avançado, só o UPDATE de observação (`conferida_em`; nenhum nas saídas antecipadas) e SEM_EFEITO; e um
 * controle com mudança real posterior que continua sendo efeito. Um pedido por cenário (nada se contamina).
 */
async function creditado(a: ReturnType<typeof asaas>, id: string, cliente: string) {
    const p = await pedidoWalle(a, id, cliente, 'PENDING');
    a.avulsas.set(p.pagamento.id, { ...p.pagamento, status: 'RECEIVED', paymentDate: await hoje() });
    await emTx(() => processarPedido(client as never, p.pedidoId, p.ctx));
    assert.equal((await q('SELECT estado FROM ia_credito_pedidos WHERE id = $1', [p.pedidoId])).rows[0].estado, 'CREDITADO');
    return p;
}
async function efeitoDe(id: string, trabalho: () => Promise<unknown>) {
    const antes = await fotografar(client as never, { empresaId: id });
    await avancarRelogio();
    await emTx(trabalho);
    return diferenca(antes, await fotografar(client as never, { empresaId: id }));
}
const cobrancaDo = async (pedidoId: string) => (await q('SELECT disputa, revisao_motivo, retencao_motivo, perda_definitiva_em IS NOT NULL AS perda FROM ia_credito_cobrancas WHERE pedido_id = $1 AND canonica', [pedidoId])).rows[0];

test('§3.3.1 créditos: estorno parcial tratado, disputa ABERTA e FAVORAVEL estáveis; nova disputa é efeito', { skip: !opt() }, async (t) => {
    if (await falta(t, '095')) return;
    const a = asaas();
    const { id, sub } = await empresaAtivaPaga(a);
    // Estorno parcial externo já tratado (bloqueio do remanescente + retenção): estável.
    const p1 = await creditado(a, id, sub.customer!);
    a.avulsas.set(p1.pagamento.id, { ...a.avulsas.get(p1.pagamento.id)!, estornos: [{ status: 'DONE', valorCentavos: 4000, descricao: null }] });
    const e1 = await segundaExecucao(id, () => processarPedido(client as never, p1.pedidoId, p1.ctx), { ia_credito_cobrancas: 1 });
    assert.equal(semEfeito(e1), true, `ESTORNO_PARCIAL: ${resumo(e1).join(' | ')}`);
    assert.equal((await cobrancaDo(p1.pedidoId)).retencao_motivo, 'ESTORNO_EXTERNO_PARCIAL');
    // Controle: um 2º estorno maior é episódio novo (bloqueia de novo): efeito.
    a.avulsas.set(p1.pagamento.id, { ...a.avulsas.get(p1.pagamento.id)!, estornos: [{ status: 'DONE', valorCentavos: 4000, descricao: null }, { status: 'DONE', valorCentavos: 1000, descricao: null }] });
    assert.equal(semEfeito(await efeitoDe(id, () => processarPedido(client as never, p1.pedidoId, p1.ctx))), false, 'estorno maior é efeito');

    // Disputa ABERTA (bloqueio do remanescente) estável; depois FAVORAVEL (desbloqueio) estável.
    const p2 = await creditado(a, id, sub.customer!);
    const pago = a.avulsas.get(p2.pagamento.id)!;
    a.avulsas.set(p2.pagamento.id, { ...pago, status: 'CHARGEBACK_REQUESTED' });
    const e2 = await segundaExecucao(id, () => processarPedido(client as never, p2.pedidoId, p2.ctx), { ia_credito_cobrancas: 1 });
    assert.equal(semEfeito(e2), true, `DISPUTA ABERTA: ${resumo(e2).join(' | ')}`);
    assert.equal((await cobrancaDo(p2.pedidoId)).disputa, 'ABERTA');
    a.avulsas.set(p2.pagamento.id, { ...pago, status: 'RECEIVED' });
    const e3 = await segundaExecucao(id, () => processarPedido(client as never, p2.pedidoId, p2.ctx), { ia_credito_cobrancas: 1 });
    assert.equal(semEfeito(e3), true, `DISPUTA FAVORAVEL: ${resumo(e3).join(' | ')}`);
    assert.equal((await cobrancaDo(p2.pedidoId)).disputa, 'FAVORAVEL');
    // Controle: nova disputa depois da favorável é episódio novo: efeito.
    a.avulsas.set(p2.pagamento.id, { ...pago, status: 'CHARGEBACK_DISPUTE' });
    assert.equal(semEfeito(await efeitoDe(id, () => processarPedido(client as never, p2.pedidoId, p2.ctx))), false, 'nova disputa é efeito');
});

test('§3.3.1 créditos: estorno total externo sem devolução e disputa PERDIDA estáveis; devolução CONCLUIDO estável', { skip: !opt() }, async (t) => {
    if (await falta(t, '095')) return;
    const a = asaas();
    const { id, sub } = await empresaAtivaPaga(a);
    // Estorno total feito fora (painel do provedor), sem devolução nossa: remanescente cancelado, exposição; estável.
    const p1 = await creditado(a, id, sub.customer!);
    a.avulsas.set(p1.pagamento.id, { ...a.avulsas.get(p1.pagamento.id)!, status: 'REFUNDED' });
    const e1 = await segundaExecucao(id, () => processarPedido(client as never, p1.pedidoId, p1.ctx), { ia_credito_cobrancas: 1 });
    assert.equal(semEfeito(e1), true, `ESTORNO EXTERNO: ${resumo(e1).join(' | ')}`);
    assert.deepEqual([(await cobrancaDo(p1.pedidoId)).revisao_motivo, (await cobrancaDo(p1.pedidoId)).perda], ['ESTORNO_SEM_PEDIDO', true]);

    // Disputa aberta que termina em estorno (perdida): estável.
    const p2 = await creditado(a, id, sub.customer!);
    const pago = a.avulsas.get(p2.pagamento.id)!;
    a.avulsas.set(p2.pagamento.id, { ...pago, status: 'CHARGEBACK_REQUESTED' });
    await emTx(() => processarPedido(client as never, p2.pedidoId, p2.ctx));
    a.avulsas.set(p2.pagamento.id, { ...pago, status: 'REFUNDED' });
    const e2 = await segundaExecucao(id, () => processarPedido(client as never, p2.pedidoId, p2.ctx), { ia_credito_cobrancas: 1 });
    assert.equal(semEfeito(e2), true, `DISPUTA PERDIDA: ${resumo(e2).join(' | ')}`);
    assert.equal((await cobrancaDo(p2.pedidoId)).disputa, 'PERDIDA');

    // Devolução nossa (AGUARDANDO_MANUAL) confirmada pelo provedor (REFUNDED) → CONCLUIDO; estável.
    const p3 = await creditado(a, id, sub.customer!);
    const protocolo = (await q('SELECT protocolo FROM ia_credito_pedidos WHERE id = $1', [p3.pedidoId])).rows[0].protocolo as string;
    const opcao = await opcaoDoPedido(client as never, id, protocolo);
    assert.equal(opcao.disponivel, true, JSON.stringify(opcao));
    if (!opcao.disponivel) return;
    await emTx(() => registrarDevolucao(client as never, { empresaId: id, protocoloPedido: protocolo, tipo: opcao.calculo.tipo, valorEsperado: opcao.calculo.valorCentavos,
        chave: randomUUID(), solicitadoPor: usuario, origem: 'GESTAO' }));
    a.avulsas.set(p3.pagamento.id, { ...a.avulsas.get(p3.pagamento.id)!, status: 'REFUNDED' });
    const e3 = await segundaExecucao(id, () => processarPedido(client as never, p3.pedidoId, p3.ctx), { ia_credito_cobrancas: 1 });
    assert.equal(semEfeito(e3), true, `DEVOLUÇÃO CONCLUIDO: ${resumo(e3).join(' | ')}`);
    assert.equal((await q('SELECT estado FROM ia_credito_devolucoes WHERE pedido_id = $1', [p3.pedidoId])).rows[0].estado, 'CONCLUIDO');
});

test('§3.3.1 créditos: ENCERRADO (cobrança cancelada), REVISAO com o mesmo motivo e cobrança não canônica estáveis; controles', { skip: !opt() }, async (t) => {
    if (await falta(t, '095')) return;
    const a = asaas();
    const { id, sub } = await empresaAtivaPaga(a);
    // ENCERRADO: cobrança removida antes do pagamento. A 2ª execução sai antes de qualquer escrita (JA_CONCLUIDO).
    const p1 = await pedidoWalle(a, id, sub.customer!, 'PENDING');
    await emTx(() => processarPedido(client as never, p1.pedidoId, p1.ctx));
    a.avulsas.set(p1.pagamento.id, { ...p1.pagamento, deleted: true });
    const e1 = await segundaExecucao(id, () => processarPedido(client as never, p1.pedidoId, p1.ctx), {});
    assert.equal(semEfeito(e1), true, `ENCERRADO: ${resumo(e1).join(' | ')}`);
    assert.equal((await q('SELECT estado FROM ia_credito_pedidos WHERE id = $1', [p1.pedidoId])).rows[0].estado, 'ENCERRADO');
    // Controle: pago depois do cancelamento → REVISAO PAGO_APOS_CANCELAMENTO: efeito.
    a.avulsas.set(p1.pagamento.id, { ...p1.pagamento, deleted: false, status: 'RECEIVED', paymentDate: await hoje() });
    assert.equal(semEfeito(await efeitoDe(id, () => processarPedido(client as never, p1.pedidoId, p1.ctx))), false, 'pago após cancelamento é efeito');

    // REVISAO com o mesmo motivo (valor divergente): mudarEstado não regrava; só a observação.
    const p2 = await pedidoWalle(a, id, sub.customer!, 'PENDING');
    a.avulsas.set(p2.pagamento.id, { ...p2.pagamento, status: 'RECEIVED', paymentDate: await hoje(), valorCentavos: 5000 });
    const e2 = await segundaExecucao(id, () => processarPedido(client as never, p2.pedidoId, p2.ctx), { ia_credito_cobrancas: 1 });
    assert.equal(semEfeito(e2), true, `REVISAO: ${resumo(e2).join(' | ')}`);
    assert.deepEqual(Object.values((await q('SELECT estado, revisao_motivo FROM ia_credito_pedidos WHERE id = $1', [p2.pedidoId])).rows[0]), ['REVISAO', 'VALOR_DIVERGENTE']);
    // Controle: outro motivo (forma divergente) é efeito.
    a.avulsas.set(p2.pagamento.id, { ...p2.pagamento, status: 'RECEIVED', paymentDate: await hoje(), billingType: 'BOLETO' });
    assert.equal(semEfeito(await efeitoDe(id, () => processarPedido(client as never, p2.pedidoId, p2.ctx))), false, 'motivo novo é efeito');

    // Cobrança não canônica pela via do processarExtra: estável sem escrita (sem cursor de leitura).
    const p3 = await pedidoWalle(a, id, sub.customer!, 'PENDING');
    const extra = `pay_${randomBytes(5).toString('hex')}`;
    a.avulsas.set(extra, { ...p3.pagamento, id: extra, status: 'PENDING' });
    const cobrancaId = (await q(`INSERT INTO ia_credito_cobrancas (empresa_id, pedido_id, provedor, ambiente, conta, pagamento_id, referencia_externa, canonica, valor_centavos,
            forma_provedor, situacao_provedor, url_fatura, vencimento) VALUES ($1, $2, 'ASAAS', 'sandbox', 'padrao', $3, $4, false, 9900, 'PIX', 'PENDING', NULL, $5::date) RETURNING id`,
        [id, p3.pedidoId, extra, `km:sandbox:creditos:${p3.pedidoId}`, await hoje()])).rows[0].id as string;
    const viaExtra = () => processarEventoCreditos(client as never, { cobrancaProvedorId: extra, referenciaExterna: null }, { pedidoId: p3.pedidoId, cobrancaId, canonica: false }, p3.ctx);
    const e3 = await segundaExecucao(id, viaExtra, {});
    assert.equal(semEfeito(e3), true, `NAO_CANONICA: ${resumo(e3).join(' | ')}`);
    // Controle: a extra é paga → PAGAMENTO_DUPLICADO: efeito.
    a.avulsas.set(extra, { ...p3.pagamento, id: extra, status: 'RECEIVED', paymentDate: await hoje() });
    const mudou = await efeitoDe(id, viaExtra);
    assert.equal(semEfeito(mudou), false, 'extra paga é efeito');
    assert.equal((await q('SELECT revisao_motivo FROM ia_credito_cobrancas WHERE id = $1', [cobrancaId])).rows[0].revisao_motivo, 'PAGAMENTO_DUPLICADO');
});

/**
 * HB-3 (28/10/2026; §3.3.1): matriz dos estados estáveis de ASSINATURA. ATIVA e CANCELADA_FIM_PERIODO já estão no teste
 * acima; aqui TESTE vinculada sem pagamento, EM_ATRASO, ENCERRADA e o encerramento AUSENTE (com a oferta Fundador já
 * confirmada pelo caminho do produto em toda empresa). Os períodos no passado são postos por fixture no banco (a 2ª
 * execução é o que se mede); cada estado tem um controle com mudança real.
 */
async function empresaEmTeste(a: ReturnType<typeof asaas>) {
    const n = ++seq;
    const id = (await q("INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Buffet Teste', 'PROVISIONAMENTO') RETURNING id", [`rt${n}${randomBytes(3).toString('hex')}`])).rows[0].id as string;
    await q("UPDATE empresas SET status = 'ATIVA' WHERE id = $1", [id]);
    await q(`INSERT INTO plataforma_empresas_cadastro (empresa_id, nome_empresarial, documento_fiscal, responsavel_nome, email, criado_por, atualizado_por)
        VALUES ($1, 'Festas Teste Ltda', $2, 'Responsável', $3, $4, $4)`, [id, cnpj(n), `rt${n}@example.test`, usuario]);
    await emTx(() => iniciarTeste(client as never, { empresaId: id, documento: cnpj(n) }));
    const dia = await hoje();
    const k = randomBytes(4).toString('hex');
    const sub: AssinaturaProvedor = { id: `sub_${k}`, customer: `cus_${k}`, externalReference: id, cycle: 'MONTHLY', status: 'ACTIVE', deleted: false, valorCentavos: 11820, nextDueDate: dia };
    a.subs.set(sub.id, sub);
    const cobranca: CobrancaProvedor = { id: `pay_${k}`, status: 'PENDING', dueDate: dia, paymentDate: null, deleted: false, invoiceUrl: null, valorCentavos: 11820,
        assinaturaId: sub.id, clienteId: sub.customer, billingType: 'PIX' };
    a.daAssinatura.set(sub.id, [cobranca]);
    await q("UPDATE empresa_assinaturas SET provedor = 'ASAAS', provedor_cliente_id = $2, provedor_assinatura_id = $3 WHERE empresa_id = $1", [id, sub.customer, sub.id]);
    return { id, sub, cobranca };
}
const situacaoDe = async (id: string) => (await q('SELECT situacao FROM empresa_assinaturas WHERE empresa_id = $1', [id])).rows[0].situacao as string;
/** Fixture: o período pago gravado terminou há `dias` (a próxima sincronização decide a partir dele). */
const periodoTerminouHa = (id: string, dias: number) => q("UPDATE empresa_assinaturas SET periodo_atual_fim = clock_timestamp() - make_interval(days => $2) WHERE empresa_id = $1", [id, dias]);

test('§3.3.1 assinatura: TESTE vinculada sem pagamento estável; pagamento é efeito', { skip: !opt() }, async (t) => {
    if (await falta(t)) return;
    const a = asaas();
    const { id, sub, cobranca } = await empresaEmTeste(a);
    const sinc = () => sincronizarEmpresa(client as never, id, { provedor: a.somenteLeitura as never }, { tipo: 'RECONCILIACAO' });
    const e = await segundaExecucao(id, sinc, { empresa_assinaturas: 1 });
    assert.equal(semEfeito(e), true, `TESTE: ${resumo(e).join(' | ')}`);
    assert.equal(await situacaoDe(id), 'TESTE');
    a.daAssinatura.set(sub.id, [{ ...cobranca, status: 'RECEIVED', paymentDate: await hoje() }]);
    const mudou = await efeitoDe(id, sinc);
    assert.equal(semEfeito(mudou), false, 'pagamento no TESTE é efeito');
    assert.equal(await situacaoDe(id), 'ATIVA');
});

test('§3.3.1 assinatura: EM_ATRASO e ENCERRADA estáveis; regularização e nova assinatura paga são efeito', { skip: !opt() }, async (t) => {
    if (await falta(t)) return;
    const a = asaas();
    const dia = await hoje();
    // EM_ATRASO: período pago terminou e há cobrança vencida posterior à última paga.
    const x = await empresaAtivaPaga(a);
    const sincX = () => sincronizarEmpresa(client as never, x.id, { provedor: a.somenteLeitura as never }, { tipo: 'RECONCILIACAO' });
    const paga = a.daAssinatura.get(x.sub.id)![0];
    const vencida: CobrancaProvedor = { ...paga, id: `pay_${randomBytes(4).toString('hex')}`, status: 'OVERDUE', dueDate: diaMenos(dia, 40), paymentDate: null };
    a.daAssinatura.set(x.sub.id, [{ ...paga, dueDate: diaMenos(dia, 70), paymentDate: diaMenos(dia, 70) }, vencida]);
    await periodoTerminouHa(x.id, 35);
    const e1 = await segundaExecucao(x.id, sincX, { empresa_assinaturas: 1 });
    assert.equal(semEfeito(e1), true, `EM_ATRASO: ${resumo(e1).join(' | ')}`);
    assert.equal(await situacaoDe(x.id), 'EM_ATRASO');
    // Controle: a vencida é paga → ATIVA: efeito.
    a.daAssinatura.set(x.sub.id, [{ ...paga, dueDate: diaMenos(dia, 70), paymentDate: diaMenos(dia, 70) }, { ...vencida, status: 'RECEIVED', paymentDate: dia }]);
    assert.equal(semEfeito(await efeitoDe(x.id, sincX)), false, 'regularização é efeito');

    // ENCERRADA: inativa no provedor e período terminado.
    const y = await empresaAtivaPaga(a);
    const sincY = () => sincronizarEmpresa(client as never, y.id, { provedor: a.somenteLeitura as never }, { tipo: 'RECONCILIACAO' });
    const pagaY = a.daAssinatura.get(y.sub.id)![0];
    a.subs.set(y.sub.id, { ...y.sub, status: 'INACTIVE' });
    a.daAssinatura.set(y.sub.id, [{ ...pagaY, dueDate: diaMenos(dia, 70), paymentDate: diaMenos(dia, 70) }]);
    await periodoTerminouHa(y.id, 10);
    const e2 = await segundaExecucao(y.id, sincY, { empresa_assinaturas: 1 });
    assert.equal(semEfeito(e2), true, `ENCERRADA: ${resumo(e2).join(' | ')}`);
    assert.equal(await situacaoDe(y.id), 'ENCERRADA');
    // Controle: a assinatura volta ativa com um pagamento NOVO (vencimento posterior) → ATIVA: efeito.
    a.subs.set(y.sub.id, { ...y.sub, status: 'ACTIVE' });
    a.daAssinatura.set(y.sub.id, [{ ...pagaY, dueDate: diaMenos(dia, 70), paymentDate: diaMenos(dia, 70) },
        { ...pagaY, id: `pay_${randomBytes(4).toString('hex')}`, dueDate: dia, paymentDate: dia }]);
    assert.equal(semEfeito(await efeitoDe(y.id, sincY)), false, 'reativação paga é efeito');
});

test('§3.3.1 assinatura: encerramento já AUSENTE (removida no provedor) estável; outro pedido pendente é efeito', { skip: !opt() }, async (t) => {
    if (await falta(t, '089')) return;
    const a = asaas();
    const { id, sub } = await empresaAtivaPaga(a);
    const sinc = () => sincronizarEmpresa(client as never, id, { provedor: a.somenteLeitura as never }, { tipo: 'RECONCILIACAO' });
    const pedido = () => registrarPedido(client as never, { empresaId: id, tipo: 'CANCELAMENTO_FIM_PERIODO', chave: randomUUID(), solicitadoPor: usuario, motivo: null, ciclo: 'MENSAL',
        situacaoAnterior: 'ATIVA', provedorAssinaturaId: sub.id, cancelamentoProvedor: 'PENDENTE' });
    await emTx(pedido);
    a.subs.set(sub.id, { ...sub, deleted: true });
    const e = await segundaExecucao(id, sinc, { empresa_assinaturas: 1 });
    assert.equal(semEfeito(e), true, `AUSENTE: ${resumo(e).join(' | ')}`);
    assert.deepEqual((await q('SELECT cancelamento_provedor AS c FROM assinatura_encerramentos WHERE empresa_id = $1', [id])).rows.map((r) => r.c), ['AUSENTE']);
    assert.equal(await situacaoDe(id), 'CANCELADA_FIM_PERIODO');
    // Controle: um 2º pedido PENDENTE para a mesma assinatura removida vira AUSENTE na próxima leitura: efeito.
    await emTx(pedido);
    assert.equal(semEfeito(await efeitoDe(id, sinc)), false, 'pedido pendente que vira AUSENTE é efeito');
});

/**
 * Empresa ATIVA pelo pagamento da 1ª cobrança da assinatura, SEM passar pela oferta Fundador (vagas limitadas: a suíte
 * inteira esgotaria as vagas e prepararOferta recusaria com OFERTA_ALTERADA). A oferta confirmada continua coberta pelo
 * teste de ATIVA acima, que usa empresaAtiva.
 */
async function empresaAtivaPaga(a: ReturnType<typeof asaas>) {
    const e = await empresaEmTeste(a);
    a.daAssinatura.set(e.sub.id, [{ ...e.cobranca, status: 'RECEIVED', paymentDate: await hoje() }]);
    await emTx(() => sincronizarEmpresa(client as never, e.id, { provedor: a.somenteLeitura as never }, { tipo: 'RECONCILIACAO' }));
    assert.equal(await situacaoDe(e.id), 'ATIVA');
    return { id: e.id, sub: e.sub };
}

test('§3.3.1 (revisão HB-3, P2): creditado em CONFIRMED e relido RECEIVED com estorno parcial novo converge em UMA leitura', { skip: !opt() }, async (t) => {
    if (await falta(t, '095')) return;
    const a = asaas();
    const { id, sub } = await empresaAtivaPaga(a);
    const p = await pedidoWalle(a, id, sub.customer!, 'PENDING');
    const dia = await hoje();
    a.avulsas.set(p.pagamento.id, { ...p.pagamento, status: 'CONFIRMED', paymentDate: dia });
    await emTx(() => processarPedido(client as never, p.pedidoId, p.ctx));
    assert.equal((await q('SELECT estado FROM ia_credito_pedidos WHERE id = $1', [p.pedidoId])).rows[0].estado, 'CREDITADO');
    a.avulsas.set(p.pagamento.id, { ...p.pagamento, status: 'RECEIVED', paymentDate: dia, estornos: [{ status: 'DONE', valorCentavos: 4000, descricao: null }] });
    const e = await segundaExecucao(id, () => processarPedido(client as never, p.pedidoId, p.ctx), { ia_credito_cobrancas: 1 });
    assert.equal(semEfeito(e), true, resumo(e).join(' | '));
    assert.deepEqual(Object.values((await q('SELECT situacao_provedor, retencao_motivo FROM ia_credito_cobrancas WHERE pedido_id = $1 AND canonica', [p.pedidoId])).rows[0]),
        ['RECEIVED', 'ESTORNO_EXTERNO_PARCIAL']);
});

test('§3.3.1 (revisão HB-3, P2): disputa ABERTA — reserva anterior consumida depois aumenta a exposição (efeito) e o novo estado é estável', { skip: !opt() }, async (t) => {
    if (await falta(t, '095')) return;
    const a = asaas();
    const { id, sub } = await empresaAtivaPaga(a);
    const p = await creditado(a, id, sub.customer!);
    const operacaoId = `op-${randomUUID()}`;
    await emTx(() => reservar(client as never, { empresaId: id, recurso: 'WALLE', operacaoId, quantidade: 300, ator: 'SISTEMA' as never }));
    a.avulsas.set(p.pagamento.id, { ...a.avulsas.get(p.pagamento.id)!, status: 'CHARGEBACK_REQUESTED' });
    const e1 = await segundaExecucao(id, () => processarPedido(client as never, p.pedidoId, p.ctx), { ia_credito_cobrancas: 1 });
    assert.equal(semEfeito(e1), true, `ABERTA: ${resumo(e1).join(' | ')}`);
    const exposicao = async () => Number((await q('SELECT exposicao_centavos AS e FROM ia_credito_cobrancas WHERE pedido_id = $1 AND canonica', [p.pedidoId])).rows[0].e);
    assert.equal(await exposicao(), 0, 'nada consumido na abertura');
    // A reserva feita ANTES da disputa é consumida depois: o já usado sobe — a leitura seguinte registra a exposição nova.
    await emTx(() => encerrarReserva(client as never, { empresaId: id, recurso: 'WALLE', operacaoId, quantidadeFinal: 300, ator: 'SISTEMA' as never }));
    const mudou = await efeitoDe(id, () => processarPedido(client as never, p.pedidoId, p.ctx));
    assert.equal(semEfeito(mudou), false, 'consumo durante a disputa é efeito');
    assert.equal(await exposicao(), 2970, '300 de 1000 créditos de 9900 centavos');
    // E o novo estado é estável.
    const e2 = await segundaExecucao(id, () => processarPedido(client as never, p.pedidoId, p.ctx), { ia_credito_cobrancas: 1 });
    assert.equal(semEfeito(e2), true, `ABERTA após consumo: ${resumo(e2).join(' | ')}`);
    assert.equal(await exposicao(), 2970);
});

/**
 * Revisão do HB-3 r1 (P2): fluxo COMPOSTO estorno parcial × disputa, numa única leitura, com saldos do lote, retenção e
 * fotografia: (1) disputa ABERTA + provedor RECEIVED com parcial novo → FAVORAVEL e retenção na MESMA leitura, e o
 * remanescente continua BLOQUEADO (a favorável não desfaz a retenção); (2) abertura de disputa junto com parcial novo →
 * ABERTA, exposição e retenção na mesma leitura; (3) parcial tratado numa leitura e favorável na seguinte → a favorável
 * também não desbloqueia. Em todos, a leitura seguinte é SEM_EFEITO (só a observação).
 */
const loteDe = async (pedidoId: string) => (await q('SELECT disponivel, bloqueado, cancelado, consumido FROM ia_credito_lotes WHERE pedido_id = $1', [pedidoId])).rows[0];
const cobrancaComposta = async (pedidoId: string) => (await q('SELECT disputa, retencao_motivo, estornado_centavos, situacao_provedor FROM ia_credito_cobrancas WHERE pedido_id = $1 AND canonica', [pedidoId])).rows[0];

test('§3.3.1 (revisão HB-3 r1, P2): disputa ABERTA + parcial novo com status pago → favorável e retenção na MESMA leitura; remanescente bloqueado', { skip: !opt() }, async (t) => {
    if (await falta(t, '095')) return;
    const a = asaas();
    const { id, sub } = await empresaAtivaPaga(a);
    const p = await creditado(a, id, sub.customer!);
    const pago = a.avulsas.get(p.pagamento.id)!;
    a.avulsas.set(p.pagamento.id, { ...pago, status: 'CHARGEBACK_REQUESTED' });
    await emTx(() => processarPedido(client as never, p.pedidoId, p.ctx));
    assert.equal((await cobrancaComposta(p.pedidoId)).disputa, 'ABERTA');
    a.avulsas.set(p.pagamento.id, { ...pago, status: 'RECEIVED', estornos: [{ status: 'DONE', valorCentavos: 4000, descricao: null }] });
    const e = await segundaExecucao(id, () => processarPedido(client as never, p.pedidoId, p.ctx), { ia_credito_cobrancas: 1 });
    assert.equal(semEfeito(e), true, resumo(e).join(' | '));
    assert.deepEqual(Object.values(await cobrancaComposta(p.pedidoId)), ['FAVORAVEL', 'ESTORNO_EXTERNO_PARCIAL', '4000', 'RECEIVED']);
    const l = await loteDe(p.pedidoId);
    assert.deepEqual([Number(l.disponivel), Number(l.bloqueado), Number(l.cancelado)], [0, 1000, 0], 'remanescente retido (bloqueado) até a decisão do operador');
});

test('§3.3.1 (revisão HB-3 r1, P2): abertura de disputa junto com parcial novo → ABERTA, exposição e retenção na MESMA leitura', { skip: !opt() }, async (t) => {
    if (await falta(t, '095')) return;
    const a = asaas();
    const { id, sub } = await empresaAtivaPaga(a);
    const p = await creditado(a, id, sub.customer!);
    const operacaoId = `op-${randomUUID()}`;
    await emTx(() => reservar(client as never, { empresaId: id, recurso: 'WALLE', operacaoId, quantidade: 200, ator: 'SISTEMA' }));
    await emTx(() => encerrarReserva(client as never, { empresaId: id, recurso: 'WALLE', operacaoId, quantidadeFinal: 200, ator: 'SISTEMA' }));
    a.avulsas.set(p.pagamento.id, { ...a.avulsas.get(p.pagamento.id)!, status: 'CHARGEBACK_REQUESTED', estornos: [{ status: 'DONE', valorCentavos: 3000, descricao: null }] });
    const e = await segundaExecucao(id, () => processarPedido(client as never, p.pedidoId, p.ctx), { ia_credito_cobrancas: 1 });
    assert.equal(semEfeito(e), true, resumo(e).join(' | '));
    const c = await cobrancaComposta(p.pedidoId);
    assert.deepEqual([c.disputa, c.retencao_motivo, c.estornado_centavos], ['ABERTA', 'ESTORNO_EXTERNO_PARCIAL', '3000']);
    assert.equal(Number((await q('SELECT exposicao_centavos AS e FROM ia_credito_cobrancas WHERE pedido_id = $1 AND canonica', [p.pedidoId])).rows[0].e), 1980, 'exposição do já usado (200 de 1000)');
    const l = await loteDe(p.pedidoId);
    assert.deepEqual([Number(l.disponivel), Number(l.bloqueado), Number(l.consumido)], [0, 800, 200]);
});

test('§3.3.1 (revisão HB-3 r1, P2): parcial tratado durante a disputa e favorável na leitura seguinte → a favorável não desfaz a retenção', { skip: !opt() }, async (t) => {
    if (await falta(t, '095')) return;
    const a = asaas();
    const { id, sub } = await empresaAtivaPaga(a);
    const p = await creditado(a, id, sub.customer!);
    const pago = a.avulsas.get(p.pagamento.id)!;
    a.avulsas.set(p.pagamento.id, { ...pago, status: 'CHARGEBACK_REQUESTED' });
    await emTx(() => processarPedido(client as never, p.pedidoId, p.ctx));
    a.avulsas.set(p.pagamento.id, { ...pago, status: 'CHARGEBACK_DISPUTE', estornos: [{ status: 'DONE', valorCentavos: 2000, descricao: null }] });
    await emTx(() => processarPedido(client as never, p.pedidoId, p.ctx));
    a.avulsas.set(p.pagamento.id, { ...pago, status: 'RECEIVED', estornos: [{ status: 'DONE', valorCentavos: 2000, descricao: null }] });
    const e = await segundaExecucao(id, () => processarPedido(client as never, p.pedidoId, p.ctx), { ia_credito_cobrancas: 1 });
    assert.equal(semEfeito(e), true, resumo(e).join(' | '));
    assert.deepEqual([(await cobrancaComposta(p.pedidoId)).disputa, (await cobrancaComposta(p.pedidoId)).retencao_motivo], ['FAVORAVEL', 'ESTORNO_EXTERNO_PARCIAL']);
    const l = await loteDe(p.pedidoId);
    assert.deepEqual([Number(l.disponivel), Number(l.bloqueado)], [0, 1000]);
});

/**
 * Revisão do HB-3 r3 (D-HML-5, prova integrada): favorável com retenção de parcial e RESERVA pendente; a decisão do operador
 * resolve. LIBERAR: o retido volta ao disponível, a retenção sai, a reserva encerra normalmente; CANCELAR: perda definitiva e
 * o que volta da reserva é cancelado (nunca reabre). Em ambos, a releitura seguinte é SEM_EFEITO (não rebloqueia).
 */
for (const resultado of ['LIBERAR', 'CANCELAR'] as const) {
    test(`D-HML-5 integrada: favorável com retenção e reserva pendente → operador ${resultado}; ledger e releitura estável`, { skip: !opt() }, async (t) => {
    if (await falta(t, '095')) return;
        const a = asaas();
        const { id, sub } = await empresaAtivaPaga(a);
        const p = await creditado(a, id, sub.customer!);
        const operacaoId = `op-${randomUUID()}`;
        await emTx(() => reservar(client as never, { empresaId: id, recurso: 'WALLE', operacaoId, quantidade: 300, ator: 'SISTEMA' }));
        const pago = a.avulsas.get(p.pagamento.id)!;
        a.avulsas.set(p.pagamento.id, { ...pago, status: 'CHARGEBACK_REQUESTED' });
        await emTx(() => processarPedido(client as never, p.pedidoId, p.ctx));
        a.avulsas.set(p.pagamento.id, { ...pago, status: 'RECEIVED', estornos: [{ status: 'DONE', valorCentavos: 4000, descricao: null }] });
        await emTx(() => processarPedido(client as never, p.pedidoId, p.ctx));
        let l = await loteDe(p.pedidoId);
        assert.deepEqual([Number(l.disponivel), Number(l.bloqueado), Number(l.cancelado)], [0, 700, 0], 'retido; a reserva (300) segue aberta');
        await emTx(() => resolverBloqueio(client as never, usuario, { pagamentoId: p.pagamento.id, resultado, referencia: 'TICKET-B14-1' }));
        l = await loteDe(p.pedidoId);
        assert.deepEqual([Number(l.disponivel), Number(l.bloqueado), Number(l.cancelado)], resultado === 'LIBERAR' ? [700, 0, 0] : [0, 0, 700]);
        assert.equal((await cobrancaComposta(p.pedidoId)).retencao_motivo, null);
        // A reserva pendente encerra consumindo 100: o resto (200) volta ao disponível (LIBERAR) ou é cancelado (CANCELAR).
        await emTx(() => encerrarReserva(client as never, { empresaId: id, recurso: 'WALLE', operacaoId, quantidadeFinal: 100, ator: 'SISTEMA' }));
        l = await loteDe(p.pedidoId);
        assert.deepEqual([Number(l.disponivel), Number(l.consumido), Number(l.cancelado)], resultado === 'LIBERAR' ? [900, 100, 0] : [0, 100, 900]);
        // Releitura do mesmo estado do provedor: nada a fazer (não rebloqueia o liberado nem reabre o cancelado).
        const e = await segundaExecucao(id, () => processarPedido(client as never, p.pedidoId, p.ctx), { ia_credito_cobrancas: 1 });
        assert.equal(semEfeito(e), true, resumo(e).join(' | '));
    });
}

test('guarda de schema (revisão do HB-3 r4): pula SÓ onde falta o objeto — onde ele existe, o teste roda (nunca passa em falso)', { skip: !opt() }, async () => {
    for (const r of ['095', '089', '097'] as const) {
        const existe = (await q("SELECT to_regclass('public.' || $1) IS NOT NULL AS ok", [MARCADOR[r]])).rows[0].ok as boolean;
        let pulou = '';
        assert.equal(await falta({ skip: (m: string) => { pulou = m; } }, r), !existe, r);
        assert.equal(pulou !== '', !existe, r);
    }
    // No modelo 097 (inventário inteiro até a 097) nada pode ser pulado.
    if (process.env.KIDMAIS_POSTGRES_MODELO === '097') assert.equal(await falta({ skip: () => undefined }, '095', '089', '097'), false);
});
