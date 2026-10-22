import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Client } from 'pg';
import { conectarDescartavel, encerrarDescartavel } from '../comercial/postgres-descartavel.ts';
import type { MensagemEmail } from '../acessos/email.ts';
import { iniciarTeste } from './servico.ts';
import { lerEstadoComercial } from './estado.ts';
import { cancelarAssinatura, type DepsCobranca } from './cobranca.ts';
import { processarEvento, registrarEvento, sincronizarEmpresa } from './sincronizacao.ts';
import { consultarEncerramento, solicitarEncerramento, type DepsDevolucao } from './devolucao.ts';
import { calcularProporcional } from './devolucao-calculo.ts';
import { AsaasFalhou, type AssinaturaProvedor, type CobrancaProvedor } from './asaas.ts';

/**
 * 089 — cancelamento e devolução (L1 de 21/10/2026) no PostgreSQL DESCARTÁVEL sobre o modelo 086 (067/068/074a/075
 * instaladas pela receita; a 087 é de outro trabalho local e não entra). Provedor e e-mail FALSOS (sem rede, sem envio).
 *   1. precheck, aplicação, postcheck, reaplicação recusada, rollback vazio e reaplicação;
 *   2. arrependimento em 7 dias (anual): valor conferido, protocolo, período encerrado na mesma transação, somente leitura,
 *      cancelamento no provedor, estorno MANUAL sem a flag, e-mail, repetição idempotente, nova tentativa recusada;
 *   3. anual proporcional com ASSINATURA_ESTORNO_ATIVO=true (Pix): valor = pago × não utilizados ÷ dias do ciclo,
 *      registro prévio e estorno solicitado; com resposta perdida: SEM_CONFIRMACAO, sem segunda chamada;
 *   4. mensal depois da garantia: sem devolução; cancelar ao fim do período devolve protocolo e e-mail;
 *   5. sincronização, webhook de estorno e reconciliação com a regra D-C4: nenhuma empresa muda, nenhum alarme;
 *   6. guarda da tabela (imutabilidade, transições, conclusão manual com referência, garantia única) e rollback recusado.
 */
const ler = (f: string) => readFileSync(f, 'utf8');
const UP = ler('database/migrations/20261021_089_assinatura_encerramentos.sql');
const PRE = ler('database/checks/20261021_089_precheck.sql');
const POST = ler('database/checks/20261021_089_postcheck.sql');
const DOWN = ler('database/rollback/20261021_089_assinatura_encerramentos_down.sql');
const reconciliar = createRequire(import.meta.url)('../../scripts/assinatura-reconciliar.cjs') as {
    executarCiclo: (o: Record<string, unknown>) => Promise<{ empresas: Record<string, number>; eventos: Record<string, number>; divergente: boolean; incompleto: boolean; alarme?: { itens: unknown[] }; pendentesConhecidos?: unknown[] }>;
    lerIdadesDosEventos: (c: unknown, ids: string[]) => Promise<unknown>;
    lerPendenciasEncerramento: (c: unknown, instanteMs?: number | null) => Promise<{ item: string; resultado: string; motivo: string; recebidoMs: number }[]>;
    codigoDeSaida: (r: unknown, producao: boolean) => number;
};

const TOKEN = 'token-webhook-sintetico-de-teste-32+caracteres';
const ENV = { ASAAS_AMBIENTE: 'sandbox', ASAAS_API_KEY: '$aact_hmlg_chave_sintetica_de_teste_sem_valor', ASAAS_WEBHOOK_TOKEN: TOKEN, SITE_ATENDIMENTO_EMAIL: 'plataforma@example.test' };
const opt = () => process.env.KIDMAIS_POSTGRES_DESCARTAVEL === 'kidmais_pacotes_v1_descartavel';

let client: Client;
let hoje = '';
const q = (texto: string, params: unknown[] = []) => client.query(texto, params);
const ids: Record<string, string> = {};
async function emTx<T>(acao: () => Promise<T>): Promise<T> {
    await q('BEGIN');
    try {
        const r = await acao();
        await q('COMMIT');
        return r;
    }
    catch (error) {
        await q('ROLLBACK');
        throw error;
    }
}
const dia = (deslocamento: number) => {
    const d = new Date(`${hoje}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + deslocamento);
    return d.toISOString().slice(0, 10);
};

/** Provedor falso em objeto simples (a simulação da reconciliação espalha os métodos com `...`). */
const estado = {
    assinaturas: new Map<string, AssinaturaProvedor>(), cobrancas: new Map<string, CobrancaProvedor[]>(),
    remocao: 'normal' as 'normal' | 'perder', estorno: 'normal' as 'normal' | 'perder' | 'recusar',
    remocoes: 0, estornos: [] as { id: string; valor: number; descricao: string }[], seq: 0,
};
const provedor = {
    async obterAssinatura(id: string) { const a = estado.assinaturas.get(id); return a ? { ...a, ...(a.deleted ? { status: 'INACTIVE' } : {}) } : null; },
    async listarCobrancasDaAssinatura(id: string) { return (estado.cobrancas.get(id) ?? []).map((c) => ({ ...c })); },
    async listarAssinaturasPorReferencia(ref: string) { return [...estado.assinaturas.values()].filter((a) => a.externalReference === ref && !a.deleted); },
    async removerAssinatura(id: string) {
        estado.remocoes += 1;
        if (estado.remocao === 'perder') throw new AsaasFalhou('remover assinatura', null, 'TEMPO_ESGOTADO');
        const a = estado.assinaturas.get(id);
        if (a) a.deleted = true;
        return { removida: true };
    },
    async estornarCobranca(id: string, valor: number, descricao: string) {
        estado.estornos.push({ id, valor, descricao });
        if (estado.estorno === 'perder') throw new AsaasFalhou('estornar cobrança', null, 'TEMPO_ESGOTADO');
        if (estado.estorno === 'recusar') throw new AsaasFalhou('estornar cobrança', 400, 'HTTP');
        const c = [...estado.cobrancas.values()].flat().find((x) => x.id === id)!;
        // Como no Asaas: integral → REFUNDED; parcial mantém RECEIVED e lista o estorno em `refunds`.
        if (valor === c.valorCentavos) c.status = 'REFUNDED';
        return { status: c.status, estornos: [{ status: 'PENDING', valorCentavos: valor, descricao }] };
    },
};

const enviados: MensagemEmail[] = [];
const enviarEmail = async (m: MensagemEmail) => { enviados.push(m); return { provedor: 'arquivo' as const, idExterno: null }; };
const CANAL = 'plataforma@example.test';
const paraGestao = () => enviados.filter((m) => m.para !== CANAL);
const internos = () => enviados.filter((m) => m.para === CANAL);
const tenant = () => ({ empresaComprovada: ids.atual, membershipId: 'm', usuarioId: ids.usuario, papelAtual: ids.papel ?? 'REPRESENTANTE_AUTORIZADO' });
function depsDev(env: Record<string, string | undefined> = ENV): DepsDevolucao {
    return { withTenantTransaction: (_s, _e, t) => emTx(() => t(client as never, tenant())), withTransaction: (t) => emTx(() => t(client as never)), provedor: () => provedor, env, enviarEmail };
}
function depsCob(): DepsCobranca {
    return { withTenantTransaction: (_s, _e, t) => emTx(() => t(client as never, tenant())), withTransaction: (t) => emTx(() => t(client as never)), provedor: () => provedor as never,
        env: ENV, travarContratacao: async (_e, t) => t(), enviarEmail };
}
async function sessao(reautenticadaHaSegundos = 10) {
    const r = (await q(`SELECT to_char((clock_timestamp() - make_interval(secs => $1)) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS a,
        to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS c`, [reautenticadaHaSegundos])).rows[0];
    return { id: 's', usuario_id: ids.usuario, nome: 'Gestão', cargo: null, papel: 'REPRESENTANTE_AUTORIZADO' as const, autenticado_em: r.a, consultado_em: r.c, expira_em: '', csrf_hash: '' };
}
const ctx = () => ({ requestId: randomUUID() });
const nivel = async (empresaId: string) => { const e = await lerEstadoComercial(client as never, empresaId); return [e.acesso.nivel, e.acesso.motivo]; };
const linha = async (empresaId: string) => (await q(`SELECT situacao, provedor_situacao, encerrada_em IS NOT NULL AND encerrada_em = periodo_atual_fim AS fechado_junto
    FROM empresa_assinaturas WHERE empresa_id = $1`, [empresaId])).rows[0];
const pedido = async (protocolo: string) => (await q('SELECT * FROM assinatura_encerramentos WHERE protocolo = $1', [protocolo])).rows[0];

async function recusa(sql: string, params: unknown[], motivo: RegExp) {
    await assert.rejects(q(sql, params), motivo);
}

/** Empresa em teste + assinatura "paga" no provedor falso, sincronizada (TESTE → ATIVA pelo caminho real). */
async function empresaPagante(documento: string, ciclo: 'MENSAL' | 'ANUAL', valorCentavos: number, vencimento: string, forma = 'PIX') {
    const empresaId = (await q("INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Buffet Devolução', 'PROVISIONAMENTO') RETURNING id", [`dv${randomBytes(3).toString('hex')}`])).rows[0].id as string;
    await q("UPDATE empresas SET status = 'ATIVA' WHERE id = $1", [empresaId]);
    await emTx(() => iniciarTeste(client as never, { empresaId, documento }));
    const n = ++estado.seq;
    const sub = `sub_dv_${n}`;
    estado.assinaturas.set(sub, { id: sub, status: 'ACTIVE', deleted: false, cycle: ciclo === 'ANUAL' ? 'YEARLY' : 'MONTHLY', customer: `cus_dv_${n}`, externalReference: empresaId, valorCentavos });
    estado.cobrancas.set(sub, [{ id: `pay_${sub}_1`, status: 'RECEIVED', dueDate: vencimento, paymentDate: vencimento, invoiceUrl: null, deleted: false, valorCentavos, billingType: forma, assinaturaId: sub }]);
    await q("UPDATE empresa_assinaturas SET provedor = 'ASAAS', provedor_cliente_id = $2, provedor_assinatura_id = $3 WHERE empresa_id = $1", [empresaId, `cus_dv_${n}`, sub]);
    const r = await emTx(() => sincronizarEmpresa(client as never, empresaId, { provedor }, { tipo: 'RECONCILIACAO' }));
    assert.equal(r.resultado === 'SINCRONIZADA' && r.depois, 'ATIVA');
    return { empresaId, sub, pagamento: `pay_${sub}_1` };
}

test.before(async () => {
    if (!opt()) return;
    client = await conectarDescartavel();
    hoje = (await q("SELECT to_char(clock_timestamp() AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS d")).rows[0].d;
    ids.usuario = (await q("INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Gestão Devolução', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id",
        [`dv${randomBytes(3).toString('hex')}@example.test`, `scrypt$v=1$N=131072$r=8$p=1$${'A'.repeat(22)}==$${'B'.repeat(86)}==`])).rows[0].id;
});
test.after(async () => {
    if (client) await encerrarDescartavel(client);
});

test('089: precheck, aplicação, postcheck, reaplicação recusada, rollback vazio e reaplicação', { skip: !opt() }, async () => {
    await q(PRE);
    await q(UP);
    await q(POST);
    await assert.rejects(q(UP), /089: precheck falhou/);
    await q('ROLLBACK').catch(() => undefined);
    await assert.rejects(q(PRE), /aplicação anterior ou parcial/);
    await q(DOWN);
    assert.equal((await q("SELECT to_regclass('public.assinatura_encerramentos') IS NULL AS ok")).rows[0].ok, true);
    await q(PRE);
    await q(UP);
    await q(POST);
});

test('arrependimento em 7 dias (anual): integral, protocolo, período encerrado já, estorno manual sem a flag, e-mail, idempotente', { skip: !opt() }, async () => {
    const a = await empresaPagante('11222333000181', 'ANUAL', 397_000, hoje);
    ids.a = a.empresaId; ids.atual = a.empresaId; ids.pagA = a.pagamento; ids.subA = a.sub;
    // Só leitura: o histórico não consulta o provedor; as opções, sim.
    const historico = await consultarEncerramento(await sessao(), null, depsDev(), false);
    assert.deepEqual([historico.instalado, historico.opcoes, historico.pedidos.length, historico.estornoAutomatico], [true, null, 0, false]);
    const c = await consultarEncerramento(await sessao(), null, depsDev());
    assert.ok(c.opcoes?.arrependimento.disponivel);
    assert.equal(c.opcoes?.arrependimento.disponivel && c.opcoes.arrependimento.valorCentavos, 397_000);
    assert.deepEqual(c.opcoes?.anualProporcional, { disponivel: false, motivo: 'GARANTIA_PREVALECE' });
    // Equipe não pede; senha antiga não pede; valor diferente do calculado não grava nada.
    ids.papel = 'EQUIPE';
    await assert.rejects(solicitarEncerramento(await sessao(), null, { tipo: 'ARREPENDIMENTO_7_DIAS', confirmar: true, valorEsperadoCentavos: 397_000 }, ctx(), depsDev()), (e: { code?: string }) => e.code === 'COBRANCA_SEM_PERMISSAO');
    delete ids.papel;
    await assert.rejects(solicitarEncerramento(await sessao(600), null, { tipo: 'ARREPENDIMENTO_7_DIAS', confirmar: true, valorEsperadoCentavos: 397_000 }, ctx(), depsDev()), (e: { code?: string }) => e.code === 'REAUTENTICACAO');
    await assert.rejects(solicitarEncerramento(await sessao(), null, { tipo: 'ARREPENDIMENTO_7_DIAS', confirmar: true, valorEsperadoCentavos: 396_999 }, ctx(), depsDev()),
        (e: { code?: string; details?: { valorCentavos?: number } }) => e.code === 'OFERTA_ALTERADA' && e.details?.valorCentavos === 397_000);
    await assert.rejects(solicitarEncerramento(await sessao(), null, { tipo: 'ENCERRAMENTO_ANUAL_PROPORCIONAL', confirmar: true, valorEsperadoCentavos: 397_000 }, ctx(), depsDev()),
        (e: { code?: string; details?: { motivo?: string } }) => e.code === 'CONFLITO' && e.details?.motivo === 'GARANTIA_PREVALECE');
    assert.equal((await q('SELECT count(*)::int AS n FROM assinatura_encerramentos')).rows[0].n, 0, 'recusas não gravam pedido');
    assert.equal((await linha(a.empresaId)).situacao, 'ATIVA');

    const chave = randomUUID();
    const r = await solicitarEncerramento(await sessao(), null, { tipo: 'ARREPENDIMENTO_7_DIAS', confirmar: true, chave, valorEsperadoCentavos: 397_000, motivo: 'Desisti' }, ctx(), depsDev());
    assert.match(r.protocolo, /^KM-\d{8}-[0-9A-HJKMNP-TV-Z]{8}$/);
    assert.deepEqual([r.tipo, r.valorDevolucaoCentavos, r.prazoProcessamento, r.cancelamentoProvedor, r.estorno, r.email, r.repetido],
        ['ARREPENDIMENTO_7_DIAS', 397_000, hoje, 'CONFIRMADO', 'AGUARDANDO_MANUAL', 'ENVIADO', false]);
    assert.equal(estado.estornos.length, 0, 'sem a flag nenhum estorno é chamado');
    assert.equal(estado.assinaturas.get(a.sub)!.deleted, true, 'renovação removida no provedor');
    const l = await linha(a.empresaId);
    assert.deepEqual([l.situacao, l.provedor_situacao, l.fechado_junto], ['ENCERRADA', 'DELETED', true]);
    assert.deepEqual(await nivel(a.empresaId), ['SOMENTE_LEITURA', 'ENCERRADA'], 'o estorno encerra o período: 60 dias de somente leitura a partir de agora');
    const p = await pedido(r.protocolo);
    assert.deepEqual([p.valor_pago_centavos, p.valor_devolucao_centavos, p.cobranca_provedor_id, p.forma_pagamento, p.regra, p.motivo, p.situacao_anterior],
        [397_000, 397_000, a.pagamento, 'PIX', 'L1-20261021', 'Desisti', 'ATIVA']);
    assert.equal((await q("SELECT count(*)::int AS n FROM auditoria WHERE acao = 'ASSINATURA_ENCERRADA_COM_DEVOLUCAO' AND entidade_id = $1 AND dados_depois->>'protocolo' = $2", [a.empresaId, r.protocolo])).rows[0].n, 1);
    assert.equal(paraGestao().length, 1);
    assert.match(paraGestao()[0].texto, new RegExp(r.protocolo));
    assert.match(paraGestao()[0].texto, /R\$\s?3\.970,00/);
    assert.equal(paraGestao()[0].idempotencia, `encerramento:${p.id}`);
    // P2-3: aviso interno imediato ao canal da plataforma, só com protocolo, tipo, valor, prazo e situação (sem dados do pagador).
    assert.equal(internos().length, 1);
    assert.match(internos()[0].texto, new RegExp(r.protocolo));
    assert.match(internos()[0].assunto, /^\[AÇÃO HOJE\]/);
    for (const proibido of [/Buffet/, /@example\.test/, /pay_|sub_|cus_/, /11222333000181/]) assert.doesNotMatch(internos()[0].texto, proibido);
    assert.equal(p.aviso_interno_situacao, 'ENVIADO');
    // Repetição da mesma chave: o mesmo protocolo, sem novo DELETE, estorno ou e-mail.
    const remocoes = estado.remocoes;
    const de2 = await solicitarEncerramento(await sessao(), null, { tipo: 'ARREPENDIMENTO_7_DIAS', confirmar: true, chave, valorEsperadoCentavos: 397_000 }, ctx(), depsDev());
    assert.deepEqual([de2.protocolo, de2.repetido, estado.remocoes, paraGestao().length], [r.protocolo, true, remocoes, 1]);
    // Outra chave: a empresa já está encerrada; nenhuma opção.
    await assert.rejects(solicitarEncerramento(await sessao(), null, { tipo: 'ARREPENDIMENTO_7_DIAS', confirmar: true, valorEsperadoCentavos: 397_000 }, ctx(), depsDev()), (e: { code?: string }) => e.code === 'CONFLITO');
    const depois = await consultarEncerramento(await sessao(), null, depsDev());
    assert.deepEqual([depois.situacao, depois.opcoes, depois.pedidos.map((x) => x.protocolo)], ['ENCERRADA', null, [r.protocolo]]);
    assert.equal('id' in depois.pedidos[0], false, 'o id interno não sai para a tela');
});

test('anual proporcional com a flag (Pix): valor sobre o pago, registro prévio e estorno solicitado; resposta perdida não repete', { skip: !opt() }, async () => {
    const env = { ...ENV, ASSINATURA_ESTORNO_ATIVO: 'true' };
    const b = await empresaPagante('45723174000110', 'ANUAL', 238_200, dia(-100)); // Fundador: 40% sobre 3.970,00
    ids.b = b.empresaId; ids.atual = b.empresaId; ids.subB = b.sub;
    const c = await consultarEncerramento(await sessao(), null, depsDev(env));
    assert.equal(c.estornoAutomatico, true);
    assert.deepEqual(c.opcoes?.arrependimento, { disponivel: false, motivo: 'GARANTIA_ENCERRADA' });
    const esperado = calcularProporcional({ valorPagoCentavos: 238_200, inicioCiclo: dia(-100), dataPedido: hoje });
    assert.equal(esperado.diasUtilizados, 100);
    assert.ok(c.opcoes?.anualProporcional.disponivel);
    assert.equal(c.opcoes?.anualProporcional.disponivel && c.opcoes.anualProporcional.valorCentavos, esperado.valorCentavos);
    const r = await solicitarEncerramento(await sessao(), null, { tipo: 'ENCERRAMENTO_ANUAL_PROPORCIONAL', confirmar: true, chave: randomUUID(), valorEsperadoCentavos: esperado.valorCentavos }, ctx(), depsDev(env));
    assert.deepEqual([r.estorno, r.cancelamentoProvedor, r.valorDevolucaoCentavos], ['SOLICITADO', 'CONFIRMADO', esperado.valorCentavos]);
    assert.deepEqual(estado.estornos, [{ id: b.pagamento, valor: esperado.valorCentavos, descricao: `Kidmais Manager - devolucao ${r.protocolo}` }]);
    const p = await pedido(r.protocolo);
    assert.deepEqual([p.estorno_modo, p.estorno_status_provedor, p.dias_ciclo, p.dias_utilizados, p.estorno_atualizado_em !== null], ['AUTOMATICO', 'RECEIVED', esperado.diasCiclo, 100, true]);
    assert.ok(r.prazoProcessamento && r.prazoProcessamento > hoje, '5 dias úteis');
    assert.equal(estado.cobrancas.get(b.sub)![0].status, 'RECEIVED', 'estorno parcial mantém a cobrança RECEIVED no provedor');

    // Empresa D: remoção e estorno com resposta perdida → SEM_CONFIRMACAO nos dois, uma chamada só de cada.
    const d = await empresaPagante('04252011000110', 'ANUAL', 397_000, dia(-200), 'CREDIT_CARD');
    ids.d = d.empresaId; ids.atual = d.empresaId; ids.subD = d.sub;
    estado.remocao = 'perder'; estado.estorno = 'perder';
    const valorD = calcularProporcional({ valorPagoCentavos: 397_000, inicioCiclo: dia(-200), dataPedido: hoje }).valorCentavos;
    const rd = await solicitarEncerramento(await sessao(), null, { tipo: 'ENCERRAMENTO_ANUAL_PROPORCIONAL', confirmar: true, chave: randomUUID(), valorEsperadoCentavos: valorD }, ctx(), depsDev(env));
    estado.remocao = 'normal'; estado.estorno = 'normal';
    assert.deepEqual([rd.estorno, rd.cancelamentoProvedor], ['SEM_CONFIRMACAO', 'SEM_CONFIRMACAO']);
    assert.equal(estado.estornos.filter((e) => e.id === d.pagamento).length, 1);
    assert.equal(estado.assinaturas.get(d.sub)!.deleted, false, 'a assinatura continua ativa no provedor (revisão manual)');
    assert.deepEqual([(await linha(d.empresaId)).situacao], ['ENCERRADA'], 'o pedido e o encerramento valem mesmo com o provedor incerto');
    // Boleto: nunca chama a API de estorno (precisa de dados bancários).
    const e = await empresaPagante('11444777000161', 'ANUAL', 197_000, dia(-30), 'BOLETO');
    ids.e = e.empresaId; ids.atual = e.empresaId;
    const valorE = calcularProporcional({ valorPagoCentavos: 197_000, inicioCiclo: dia(-30), dataPedido: hoje }).valorCentavos;
    const re = await solicitarEncerramento(await sessao(), null, { tipo: 'ENCERRAMENTO_ANUAL_PROPORCIONAL', confirmar: true, chave: randomUUID(), valorEsperadoCentavos: valorE }, ctx(), depsDev(env));
    assert.deepEqual([re.estorno, estado.estornos.filter((x) => x.id === e.pagamento).length], ['AGUARDANDO_MANUAL', 0]);
    assert.match(paraGestao().at(-1)!.texto, /boleto/);
});

test('mensal depois da garantia: sem devolução; cancelar ao fim do período devolve protocolo e e-mail', { skip: !opt() }, async () => {
    const c = await empresaPagante('19131243000197', 'MENSAL', 39_700, dia(-10));
    ids.c = c.empresaId; ids.atual = c.empresaId;
    const consulta = await consultarEncerramento(await sessao(), null, depsDev());
    assert.deepEqual(consulta.opcoes, { arrependimento: { disponivel: false, motivo: 'GARANTIA_ENCERRADA' }, anualProporcional: { disponivel: false, motivo: 'SOMENTE_ANUAL' } });
    const antes = paraGestao().length;
    const chave = randomUUID();
    const r = await cancelarAssinatura(await sessao(), null, { confirmar: true, motivo: 'Fim da temporada', chave }, ctx(), depsCob());
    assert.equal(r.situacao, 'CANCELADA_FIM_PERIODO');
    assert.match(r.protocolo ?? '', /^KM-/);
    const p = await pedido(r.protocolo!);
    assert.deepEqual([p.tipo, p.estorno_situacao, p.cancelamento_provedor, p.valor_devolucao_centavos, p.email_situacao], ['CANCELAMENTO_FIM_PERIODO', 'NAO_SE_APLICA', 'CONFIRMADO', null, 'ENVIADO']);
    assert.equal(paraGestao().length, antes + 1);
    assert.match(paraGestao().at(-1)!.texto, /não será renovada/);
    assert.deepEqual(await nivel(c.empresaId), ['COMPLETO', 'CANCELADA_NO_PERIODO'], 'mensal: acesso até o fim do ciclo pago');
    const de2 = await cancelarAssinatura(await sessao(), null, { confirmar: true, chave }, ctx(), depsCob());
    assert.deepEqual([de2.protocolo, de2.repetido], [r.protocolo, true]);
    // Mensal cancelada ainda dentro dos 7 dias? Não: a garantia terminou; nada é oferecido.
    const depois = await consultarEncerramento(await sessao(), null, depsDev());
    assert.equal(depois.opcoes?.arrependimento.disponivel, false);
});

test('sincronização, webhook de estorno e reconciliação D-C4: nenhuma empresa muda, nenhum alarme falso', { skip: !opt() }, async () => {
    for (const empresa of [ids.a, ids.b, ids.c, ids.d, ids.e]) {
        const r = await emTx(() => sincronizarEmpresa(client as never, empresa, { provedor }, { tipo: 'RECONCILIACAO' }));
        assert.equal(r.resultado, 'SINCRONIZADA');
        assert.equal(r.resultado === 'SINCRONIZADA' && r.mudou, false, empresa);
    }
    assert.deepEqual([(await linha(ids.b)).situacao, (await linha(ids.d)).situacao], ['ENCERRADA', 'ENCERRADA'], 'cobrança RECEIVED com devolução não reabre o período');
    // Webhooks do estorno (parcial e em andamento) chegam e são concluídos sem mudança.
    for (const [tipo, sub, pag, emp] of [['PAYMENT_PARTIALLY_REFUNDED', ids.subB, `pay_${ids.subB}_1`, ids.b], ['PAYMENT_REFUND_IN_PROGRESS', ids.subB, `pay_${ids.subB}_1`, ids.b],
        ['PAYMENT_REFUNDED', ids.subA, ids.pagA, ids.a]] as const) {
        const reg = await emTx(() => registrarEvento(client as never, { eventoId: `evt_${randomUUID()}`, tipo, criadoNoProvedor: null, assinaturaId: sub, cobrancaId: pag, checkoutId: null, referenciaExterna: emp }));
        const r = await emTx(() => processarEvento(client as never, reg.id, { provedor }));
        assert.ok(r.situacao === 'PROCESSADO' || r.situacao === 'IGNORADO', `${tipo}: ${r.situacao}`);
    }
    // Felipe estorna a garantia de A integralmente no painel: a cobrança vira REFUNDED; nada muda aqui.
    estado.cobrancas.get(ids.subA)![0].status = 'REFUNDED';
    // Ciclo da reconciliação (simulação) com a classificação D-C4 da conferência de produção.
    const sinc = await import('./sincronizacao.ts');
    const relatorio = await reconciliar.executarCiclo({ client, provedor, aplicar: false, banco: 'kidmais_pacotes_v1_descartavel', sinc, idadesDosEventos: reconciliar.lerIdadesDosEventos });
    assert.deepEqual(Object.keys(relatorio.empresas), ['SEM_MUDANCA'], JSON.stringify(relatorio.empresas));
    assert.deepEqual([relatorio.divergente, relatorio.incompleto, relatorio.alarme?.itens.length, reconciliar.codigoDeSaida(relatorio, true)], [false, false, 0, 0]);
    assert.equal(relatorio.empresas.SEM_MUDANCA, 5);
});

test('guarda da 089: imutável, transições, conclusão manual com referência, garantia única, sem DELETE; rollback recusado', { skip: !opt() }, async () => {
    const [a] = (await q("SELECT protocolo FROM assinatura_encerramentos WHERE empresa_id = $1", [ids.a])).rows;
    await recusa('UPDATE assinatura_encerramentos SET valor_devolucao_centavos = 1 WHERE protocolo = $1', [a.protocolo], /imutáveis/);
    await recusa('UPDATE assinatura_encerramentos SET protocolo = $2 WHERE protocolo = $1', [a.protocolo, 'KM-20261021-00000000'], /imutáveis/);
    await recusa("UPDATE assinatura_encerramentos SET estorno_situacao = 'SOLICITADO' WHERE protocolo = $1", [a.protocolo], /transição do estorno inválida/);
    await recusa("UPDATE assinatura_encerramentos SET estorno_situacao = 'EM_CURSO' WHERE protocolo = $1", [a.protocolo], /AUTOMATICO/);
    await recusa("UPDATE assinatura_encerramentos SET estorno_situacao = 'CONCLUIDO' WHERE protocolo = $1", [a.protocolo], /conclusao_check/);
    await recusa("UPDATE assinatura_encerramentos SET cancelamento_provedor = 'PENDENTE' WHERE protocolo = $1", [a.protocolo], /cancelamento no provedor inválida/);
    await recusa('DELETE FROM assinatura_encerramentos WHERE protocolo = $1', [a.protocolo], /não é apagado/);
    await recusa('TRUNCATE assinatura_encerramentos', [], /não é apagado/);
    // Conclusão manual (painel do Asaas): só com referência; depois disso, nada muda.
    await q("UPDATE assinatura_encerramentos SET estorno_situacao = 'CONCLUIDO', estorno_referencia = 'Painel Asaas: estorno Pix concluído' WHERE protocolo = $1", [a.protocolo]);
    const concluido = await pedido(a.protocolo);
    assert.deepEqual([concluido.estorno_situacao, concluido.estorno_modo, concluido.estorno_concluido_em !== null], ['CONCLUIDO', 'MANUAL', true]);
    await recusa("UPDATE assinatura_encerramentos SET estorno_referencia = 'outra' WHERE protocolo = $1", [a.protocolo], /concluído é imutável/);
    // SEM_CONFIRMACAO (empresa D) nunca volta a EM_CURSO; a remoção sem confirmação pode ser confirmada depois.
    const [d] = (await q("SELECT protocolo FROM assinatura_encerramentos WHERE empresa_id = $1", [ids.d])).rows;
    await recusa("UPDATE assinatura_encerramentos SET estorno_situacao = 'EM_CURSO' WHERE protocolo = $1", [d.protocolo], /transição do estorno inválida/);
    await q("UPDATE assinatura_encerramentos SET cancelamento_provedor = 'CONFIRMADO' WHERE protocolo = $1", [d.protocolo]);
    // Garantia de 7 dias: uma vez por empresa; mesma cobrança: uma devolução só.
    const base = await pedido(a.protocolo);
    await recusa(`INSERT INTO assinatura_encerramentos (protocolo, empresa_id, tipo, chave_idempotencia, solicitado_por, situacao_anterior, provedor_assinatura_id,
        cancelamento_provedor, estorno_situacao, regra, cobranca_provedor_id, valor_pago_centavos, inicio_ciclo, data_ativacao, valor_devolucao_centavos, prazo_processamento, acesso_pago_encerrado_em)
        VALUES ('KM-20261021-AAAAAAAA', $1, 'ARREPENDIMENTO_7_DIAS', gen_random_uuid(), $2, 'ATIVA', 'sub_x', 'PENDENTE', 'AGUARDANDO_MANUAL', 'L1-20261021', 'pay_outro', 100, $3, $3, 100, $3, now())`,
    [ids.a, base.solicitado_por, hoje], /assinatura_encerramentos_garantia_uk/);
    await recusa(`INSERT INTO assinatura_encerramentos (protocolo, empresa_id, tipo, chave_idempotencia, solicitado_por, situacao_anterior, provedor_assinatura_id,
        cancelamento_provedor, estorno_situacao, regra, cobranca_provedor_id, valor_pago_centavos, inicio_ciclo, data_ativacao, valor_devolucao_centavos, prazo_processamento, acesso_pago_encerrado_em, ciclo, dias_ciclo, dias_utilizados)
        VALUES ('KM-20261021-BBBBBBBB', $1, 'ENCERRAMENTO_ANUAL_PROPORCIONAL', gen_random_uuid(), $2, 'ATIVA', 'sub_x', 'PENDENTE', 'AGUARDANDO_MANUAL', 'L1-20261021', $3, 100, $4, $4, 50, $4, now(), 'ANUAL', 365, 10)`,
    [ids.b, base.solicitado_por, `pay_${ids.subB}_1`, hoje], /assinatura_encerramentos_cobranca_uk/);
    // Pedido nasce sem estorno executado; devolução maior que o pago é recusada.
    await recusa(`INSERT INTO assinatura_encerramentos (protocolo, empresa_id, tipo, chave_idempotencia, solicitado_por, situacao_anterior, provedor_assinatura_id,
        cancelamento_provedor, estorno_situacao) VALUES ('KM-20261021-CCCCCCCC', $1, 'CANCELAMENTO_FIM_PERIODO', gen_random_uuid(), $2, 'ATIVA', 'sub_x', 'CONFIRMADO', 'CONCLUIDO')`,
    [ids.c, base.solicitado_por], /nasce sem estorno/);
    await recusa(`INSERT INTO assinatura_encerramentos (protocolo, empresa_id, tipo, chave_idempotencia, solicitado_por, situacao_anterior, provedor_assinatura_id,
        cancelamento_provedor, estorno_situacao, regra, cobranca_provedor_id, valor_pago_centavos, inicio_ciclo, data_ativacao, valor_devolucao_centavos, prazo_processamento, acesso_pago_encerrado_em, ciclo, dias_ciclo, dias_utilizados)
        VALUES ('KM-20261021-DDDDDDDD', $1, 'ENCERRAMENTO_ANUAL_PROPORCIONAL', gen_random_uuid(), $2, 'ATIVA', 'sub_x', 'PENDENTE', 'AGUARDANDO_MANUAL', 'L1-20261021', 'pay_novo', 100, $3, $3, 101, $3, now(), 'ANUAL', 365, 10)`,
    [ids.c, base.solicitado_por, hoje], /devolucao_check/);
    await assert.rejects(q(DOWN), /089 rollback recusado: há pedidos/);
    await q('ROLLBACK').catch(() => undefined);
    assert.equal((await q("SELECT to_regclass('public.assinatura_encerramentos') IS NOT NULL AS ok")).rows[0].ok, true);
});

// ---------------------------------------------------------------------------------------------------------------------
// Revisão independente de 21/10/2026 (P2-1, P2-2, P2-3, P3): cenários acrescentados nesta rodada.

/** Acrescenta uma cobrança paga à assinatura (renovação) e sincroniza. */
async function renovar(empresaId: string, sub: string, vencimento: string, valorCentavos: number) {
    const lista = estado.cobrancas.get(sub)!;
    lista.push({ id: `pay_${sub}_${lista.length + 1}`, status: 'RECEIVED', dueDate: vencimento, paymentDate: vencimento, invoiceUrl: null, deleted: false, valorCentavos, billingType: 'PIX', assinaturaId: sub });
    const r = await emTx(() => sincronizarEmpresa(client as never, empresaId, { provedor }, { tipo: 'RECONCILIACAO' }));
    assert.equal(r.resultado === 'SINCRONIZADA' && r.depois, 'ATIVA');
    return `pay_${sub}_${lista.length}`;
}
const sincronizar = (empresaId: string) => emTx(() => sincronizarEmpresa(client as never, empresaId, { provedor }, { tipo: 'RECONCILIACAO' }));

test('P2-1: anual no 2º ano, proporcional sobre a renovação, remoção não confirmada e webhook do estorno: continua ENCERRADA', { skip: !opt() }, async () => {
    const f = await empresaPagante('27418593000167', 'ANUAL', 397_000, dia(-367));
    ids.atual = f.empresaId; ids.f = f.empresaId; ids.subF = f.sub;
    const segunda = await renovar(f.empresaId, f.sub, dia(-2), 397_000);
    // M11: a renovação (2ª cobrança paga) nunca tem a garantia de 7 dias, mesmo paga há 2 dias.
    const c = await consultarEncerramento(await sessao(), null, depsDev());
    assert.deepEqual(c.opcoes?.arrependimento, { disponivel: false, motivo: 'NAO_E_PRIMEIRA_ATIVACAO' });
    await assert.rejects(solicitarEncerramento(await sessao(), null, { tipo: 'ARREPENDIMENTO_7_DIAS', confirmar: true, valorEsperadoCentavos: 397_000 }, ctx(), depsDev()),
        (e: { code?: string; details?: { motivo?: string } }) => e.code === 'CONFLITO' && e.details?.motivo === 'NAO_E_PRIMEIRA_ATIVACAO');
    const valor = calcularProporcional({ valorPagoCentavos: 397_000, inicioCiclo: dia(-2), dataPedido: hoje }).valorCentavos;
    estado.remocao = 'perder';
    const r = await solicitarEncerramento(await sessao(), null, { tipo: 'ENCERRAMENTO_ANUAL_PROPORCIONAL', confirmar: true, chave: randomUUID(), valorEsperadoCentavos: valor }, ctx(), depsDev());
    estado.remocao = 'normal';
    assert.deepEqual([r.cancelamentoProvedor, r.valorDevolucaoCentavos, estado.assinaturas.get(f.sub)!.deleted], ['SEM_CONFIRMACAO', valor, false]);
    assert.equal((await pedido(r.protocolo)).cobranca_provedor_id, segunda);
    // Felipe estorna parcialmente no painel (a cobrança continua RECEIVED) e o webhook chega.
    const reg = await emTx(() => registrarEvento(client as never, { eventoId: `evt_${randomUUID()}`, tipo: 'PAYMENT_PARTIALLY_REFUNDED', criadoNoProvedor: null, assinaturaId: f.sub, cobrancaId: segunda, checkoutId: null, referenciaExterna: f.empresaId }));
    assert.equal((await emTx(() => processarEvento(client as never, reg.id, { provedor }))).situacao, 'PROCESSADO');
    const s = await sincronizar(f.empresaId);
    assert.equal(s.resultado === 'SINCRONIZADA' && s.mudou, false, 'a cobrança do 1º ano não reabre a empresa');
    assert.equal((await linha(f.empresaId)).situacao, 'ENCERRADA');
    assert.deepEqual(await nivel(f.empresaId), ['SOMENTE_LEITURA', 'ENCERRADA']);
    // Só um pagamento NOVO (vencimento posterior) da mesma assinatura reativa.
    const lista = estado.cobrancas.get(f.sub)!;
    lista.push({ id: `pay_${f.sub}_novo`, status: 'RECEIVED', dueDate: dia(363), paymentDate: hoje, invoiceUrl: null, deleted: false, valorCentavos: 397_000, billingType: 'PIX', assinaturaId: f.sub });
    const reativada = await sincronizar(f.empresaId);
    assert.equal(reativada.resultado === 'SINCRONIZADA' && reativada.depois, 'ATIVA', 'pagamento novo reativa');
});

test('P2-2: cancelar ao fim do período sem confirmação; a mesma chave refaz a remoção e responde a situação real; sincronização fecha o pedido antigo', { skip: !opt() }, async () => {
    const g = await empresaPagante('33000167000101', 'MENSAL', 39_700, dia(-10));
    ids.atual = g.empresaId; ids.g = g.empresaId;
    const chave = randomUUID();
    estado.remocao = 'perder';
    const remocoes = estado.remocoes;
    let protocolo = '';
    await assert.rejects(cancelarAssinatura(await sessao(), null, { confirmar: true, chave }, ctx(), depsCob()),
        (e: { code?: string; details?: { protocolo?: string } }) => { protocolo = e.details?.protocolo ?? ''; return e.code === 'COBRANCA_RESULTADO_INCERTO'; });
    assert.match(protocolo, /^KM-/);
    // Mesma chave, provedor ainda sem resposta: nova remoção, 503 de novo com o MESMO protocolo; nada é "cancelado".
    await assert.rejects(cancelarAssinatura(await sessao(), null, { confirmar: true, chave }, ctx(), depsCob()),
        (e: { code?: string; details?: { protocolo?: string } }) => e.code === 'COBRANCA_RESULTADO_INCERTO' && e.details?.protocolo === protocolo);
    assert.equal(estado.remocoes - remocoes, 2, 'a repetição é uma tentativa efetiva');
    assert.equal((await linha(g.empresaId)).situacao, 'ATIVA');
    assert.equal((await q('SELECT count(*)::int AS n FROM assinatura_encerramentos WHERE empresa_id = $1', [g.empresaId])).rows[0].n, 1, 'um pedido só');
    assert.equal(internos().filter((m) => m.texto.includes(protocolo)).length, 1, 'aviso interno uma vez, no primeiro registro');
    // Mesma chave com o provedor respondendo: remove, sincroniza e devolve a situação real com o mesmo protocolo.
    estado.remocao = 'normal';
    const ok = await cancelarAssinatura(await sessao(), null, { confirmar: true, chave }, ctx(), depsCob());
    assert.deepEqual([ok.situacao, ok.protocolo, ok.repetido, estado.remocoes - remocoes], ['CANCELADA_FIM_PERIODO', protocolo, true, 3]);
    assert.equal((await pedido(protocolo)).cancelamento_provedor, 'CONFIRMADO');
    // Outra repetição: só lê (nenhum DELETE novo), com a situação gravada.
    const ja = await cancelarAssinatura(await sessao(), null, { confirmar: true, chave }, ctx(), depsCob());
    assert.deepEqual([ja.situacao, ja.protocolo, ja.repetido, estado.remocoes - remocoes], ['CANCELADA_FIM_PERIODO', protocolo, true, 3]);

    // P3-8: pedido sem confirmação de OUTRA empresa fecha sozinho quando a releitura comprova a remoção (deleted=true).
    const h = await empresaPagante('60701190000104', 'MENSAL', 39_700, dia(-5));
    ids.atual = h.empresaId; ids.h = h.empresaId;
    estado.remocao = 'perder';
    let protH = '';
    await assert.rejects(cancelarAssinatura(await sessao(), null, { confirmar: true, chave: randomUUID() }, ctx(), depsCob()),
        (e: { details?: { protocolo?: string } }) => { protH = e.details?.protocolo ?? ''; return true; });
    estado.remocao = 'normal';
    estado.assinaturas.get(h.sub)!.deleted = true; // o Asaas tinha removido; a resposta é que se perdeu
    const s = await sincronizar(h.empresaId);
    assert.equal(s.resultado === 'SINCRONIZADA' && s.depois, 'CANCELADA_FIM_PERIODO');
    assert.equal((await pedido(protH)).cancelamento_provedor, 'AUSENTE');
    // A guarda aceita a conclusão manual de um estorno interrompido em EM_CURSO (P3-2).
    const [e] = (await q("SELECT protocolo FROM assinatura_encerramentos WHERE empresa_id = $1", [ids.e])).rows;
    await q("UPDATE assinatura_encerramentos SET estorno_situacao = 'EM_CURSO', estorno_modo = 'AUTOMATICO' WHERE protocolo = $1", [e.protocolo]);
    await assert.rejects(q("UPDATE assinatura_encerramentos SET estorno_situacao = 'AGUARDANDO_MANUAL' WHERE protocolo = $1", [e.protocolo]), /transição do estorno inválida/);
    await q("UPDATE assinatura_encerramentos SET estorno_situacao = 'CONCLUIDO', estorno_referencia = 'Painel Asaas: estorno conferido' WHERE protocolo = $1", [e.protocolo]);
    assert.equal((await pedido(e.protocolo)).estorno_modo, 'AUTOMATICO');
});

test('P3-3 (M12/M13): garantia uma vez por empresa e nunca com oferta 074a confirmada por outro pagamento', { skip: !opt() }, async () => {
    // M12: depois do arrependimento de A, uma nova assinatura paga não tem nova garantia (o proporcional continua).
    ids.atual = ids.a;
    const cliente = (await q('SELECT provedor_cliente_id FROM empresa_assinaturas WHERE empresa_id = $1', [ids.a])).rows[0].provedor_cliente_id;
    const sub = `sub_dv_${++estado.seq}`;
    estado.assinaturas.set(sub, { id: sub, status: 'ACTIVE', deleted: false, cycle: 'YEARLY', customer: cliente, externalReference: ids.a, valorCentavos: 397_000 });
    estado.cobrancas.set(sub, [{ id: `pay_${sub}_1`, status: 'RECEIVED', dueDate: hoje, paymentDate: hoje, invoiceUrl: null, deleted: false, valorCentavos: 397_000, billingType: 'PIX', assinaturaId: sub }]);
    await q('UPDATE empresa_assinaturas SET provedor_assinatura_id = $2 WHERE empresa_id = $1', [ids.a, sub]);
    const s = await sincronizar(ids.a);
    assert.equal(s.resultado === 'SINCRONIZADA' && s.depois, 'ATIVA', 'recontratação paga reativa (outra assinatura)');
    const c = await consultarEncerramento(await sessao(), null, depsDev());
    assert.deepEqual(c.opcoes?.arrependimento, { disponivel: false, motivo: 'NAO_E_PRIMEIRA_ATIVACAO' });
    assert.ok(c.opcoes?.anualProporcional.disponivel);
    // M13: oferta 074a CONFIRMADA por outro pagamento (contratação anterior) → a cobrança atual não é a primeira ativação.
    const k = await empresaPagante('00360305000104', 'ANUAL', 397_000, hoje);
    ids.atual = k.empresaId;
    const contratacao = (await q(`INSERT INTO assinatura_contratacoes (empresa_id, chave_idempotencia, plano, ciclo, catalogo_versao, valor_regular_centavos, valor_final_centavos, criada_por)
        VALUES ($1, gen_random_uuid(), 'PROFISSIONAL', 'ANUAL', 'teste-089', 397000, 397000, $2) RETURNING id`, [k.empresaId, ids.usuario])).rows[0].id;
    await q(`UPDATE assinatura_contratacoes SET estado = 'CONFIRMADA', confirmada_em = clock_timestamp(), pagamento_confirmacao_id = 'pay_contratacao_anterior',
        provedor_assinatura_id = 'sub_anterior' WHERE id = $1`, [contratacao]);
    const ck = await consultarEncerramento(await sessao(), null, depsDev());
    assert.deepEqual(ck.opcoes?.arrependimento, { disponivel: false, motivo: 'NAO_E_PRIMEIRA_ATIVACAO' });
});

test('P2-3: aviso interno sem canal fica NAO_CONFIGURADO; fila vencida entra na conferência D-C4 (e o recente não alarma)', { skip: !opt() }, async () => {
    const m = await empresaPagante('07526557000100', 'ANUAL', 197_000, hoje, 'BOLETO');
    ids.atual = m.empresaId;
    const semCanal = { ...ENV, SITE_ATENDIMENTO_EMAIL: undefined };
    const antes = internos().length;
    const r = await solicitarEncerramento(await sessao(), null, { tipo: 'ARREPENDIMENTO_7_DIAS', confirmar: true, chave: randomUUID(), valorEsperadoCentavos: 197_000 }, ctx(), depsDev(semCanal));
    assert.equal(internos().length, antes, 'sem canal: nada enviado');
    assert.equal((await pedido(r.protocolo)).aviso_interno_situacao, 'NAO_CONFIGURADO');
    // Agora: tudo recente (< 1 h) ou concluído/confirmado → nenhum item; a conferência não alarma.
    const agora = await reconciliar.lerPendenciasEncerramento(client);
    assert.deepEqual(agora, [], JSON.stringify(agora));
    // Daqui a 2 h: arrependimentos aguardando, renovações não removidas e o proporcional ainda no prazo (não entra).
    const daqui = Date.now() + 2 * 3_600_000;
    const vencidos = await reconciliar.lerPendenciasEncerramento(client, daqui);
    const chaves = vencidos.map((x) => `${x.item}:${x.resultado}:${x.motivo}`).sort();
    assert.ok(chaves.includes('DEVOLUCAO_PENDENTE:AGUARDANDO_MANUAL:ARREPENDIMENTO_7_DIAS'), chaves.join(','));
    assert.ok(chaves.includes('RENOVACAO_NAO_REMOVIDA:SEM_CONFIRMACAO:ENCERRAMENTO_ANUAL_PROPORCIONAL'), chaves.join(','));
    assert.ok(!chaves.some((x) => x.startsWith('DEVOLUCAO_PENDENTE') && x.endsWith('ENCERRAMENTO_ANUAL_PROPORCIONAL')), 'proporcional dentro de 5 dias úteis não alarma');
    assert.ok(vencidos.every((x) => /^[A-Z0-9_]+$/.test(x.item + x.resultado + x.motivo) && Number.isFinite(x.recebidoMs)), 'só códigos e idade');
    // Ciclo de produção completo com a fila: vencidos alarmam (NOVO), com contagem conferida; sem ids no relatório.
    const sinc = await import('./sincronizacao.ts');
    const rel = await reconciliar.executarCiclo({ client, provedor, aplicar: false, banco: 'kidmais_pacotes_v1_descartavel', sinc,
        idadesDosEventos: reconciliar.lerIdadesDosEventos, pendenciasEncerramento: (c: unknown) => reconciliar.lerPendenciasEncerramento(c, daqui) }) as unknown as {
        empresas: Record<string, number>; encerramentos: Record<string, number>; alarme: { itens: { item: string; aviso: string }[] } };
    assert.deepEqual(Object.keys(rel.empresas), ['SEM_MUDANCA'], JSON.stringify(rel.empresas));
    assert.ok(rel.alarme.itens.some((i) => i.item === 'DEVOLUCAO_PENDENTE' && i.aviso === 'NOVO'));
    assert.equal(reconciliar.codigoDeSaida(rel, true), 2);
    assert.doesNotMatch(JSON.stringify(rel), /KM-|pay_|sub_|[0-9a-f]{8}-[0-9a-f]{4}-/);
    // Sem a fila vencida (agora): a mesma conferência sai 0.
    const limpo = await reconciliar.executarCiclo({ client, provedor, aplicar: false, banco: 'kidmais_pacotes_v1_descartavel', sinc,
        idadesDosEventos: reconciliar.lerIdadesDosEventos, pendenciasEncerramento: reconciliar.lerPendenciasEncerramento });
    assert.equal(reconciliar.codigoDeSaida(limpo, true), 0, JSON.stringify(limpo));
});
