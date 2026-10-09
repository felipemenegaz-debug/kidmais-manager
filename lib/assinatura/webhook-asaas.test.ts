import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CABECALHO_TOKEN, LIMITE_CORPO, receberWebhookAsaas, tokenConfere, type DepsWebhook } from './webhook-asaas.ts';
import { processarEvento, type ProvedorLeitura } from './sincronizacao.ts';
import { AsaasFalhou, type AssinaturaProvedor, type ClienteAsaas, type CobrancaProvedor } from './asaas.ts';
import { iniciarAssinatura, type DepsCobranca } from './cobranca.ts';

/**
 * Webhook e processamento com um banco EM MEMÓRIA que entende só o SQL destes módulos (o SQL real é exercitado na
 * suíte PostgreSQL descartável cobranca-e8.postgres.test.ts). Provedor falso: nenhuma chamada de rede.
 */
const TOKEN = 'token-webhook-de-teste-com-32-caracteres!';
const ENV = { ASAAS_AMBIENTE: 'sandbox', ASAAS_API_KEY: '$aact_hmlg_000000000000000000000000chave', ASAAS_WEBHOOK_TOKEN: TOKEN };
const EMP_A = '11111111-1111-4111-8111-111111111111';
const EMP_B = '22222222-2222-4222-8222-222222222222';

type Assin = { empresa_id: string; situacao: string; ciclo: string | null; periodo_atual_fim: string | null; em_atraso_desde: string | null; cancelada_em: string | null; encerrada_em: string | null; provedor: string | null; provedor_cliente_id: string | null; provedor_assinatura_id: string | null; provedor_situacao: string | null; sincronizado_em: string | null; versao: number };
type Evento = { id: string; evento_id: string; tipo: string; assinatura_provedor_id: string | null; referencia_externa: string | null; empresa_id: string | null; situacao: string; tentativas: number; ultimo_erro: string | null; processado_em: string | null };

class BancoFalso {
    assinaturas = new Map<string, Assin>();
    eventos: Evento[] = [];
    auditoria: Array<{ acao: string; dados: unknown }> = [];
    sql: string[] = [];
    agora = '2026-10-20T15:00:00.000Z';
    private pilha: string[] = [];
    private snap() { return JSON.stringify({ a: [...this.assinaturas], e: this.eventos, au: this.auditoria }); }
    private restaurar(s: string) { const o = JSON.parse(s); this.assinaturas = new Map(o.a); this.eventos = o.e; this.auditoria = o.au; }
    async query(sql: string, p: readonly unknown[] = []) {
        this.sql.push(sql);
        const rows = (r: object[]) => ({ rows: r as never[], rowCount: r.length });
        const s = sql.replace(/\s+/g, ' ').trim();
        if (s === 'SAVEPOINT kidmais_evento_cobranca') { this.pilha.push(this.snap()); return rows([]); }
        if (s === 'RELEASE SAVEPOINT kidmais_evento_cobranca') { this.pilha.pop(); return rows([]); }
        if (s === 'ROLLBACK TO SAVEPOINT kidmais_evento_cobranca') { this.restaurar(this.pilha.pop()!); return rows([]); }
        if (s.startsWith('SELECT to_regclass')) return rows([{ ok: s.includes('cobranca_eventos') }]);
        if (s.startsWith('INSERT INTO auditoria')) { this.auditoria.push({ acao: s.includes("'COBRANCA_WEBHOOK_RECUSADO'") ? 'COBRANCA_WEBHOOK_RECUSADO' : String(p[2]), dados: p }); return rows([]); }
        if (s.startsWith('INSERT INTO cobranca_eventos')) {
            if (this.eventos.some((e) => e.evento_id === p[0])) return rows([]);
            const e: Evento = { id: `ev-${this.eventos.length + 1}`, evento_id: String(p[0]), tipo: String(p[1]), assinatura_provedor_id: p[3] as string | null, referencia_externa: p[6] as string | null, empresa_id: null, situacao: 'PENDENTE', tentativas: 0, ultimo_erro: null, processado_em: null };
            this.eventos.push(e);
            return rows([{ id: e.id }]);
        }
        if (s.startsWith('SELECT id, situacao FROM cobranca_eventos')) return rows(this.eventos.filter((e) => e.evento_id === p[0]).map((e) => ({ id: e.id, situacao: e.situacao })));
        if (s.startsWith('SELECT id, evento_id, tipo')) return rows(this.eventos.filter((e) => e.id === p[0]).map((e) => ({ ...e })));
        if (s.startsWith("UPDATE cobranca_eventos SET situacao = 'FALHOU'")) {
            const e = this.eventos.find((x) => x.id === p[0])!;
            Object.assign(e, { situacao: 'FALHOU', empresa_id: e.empresa_id ?? p[1], tentativas: e.tentativas + 1, ultimo_erro: p[2] });
            return rows([]);
        }
        if (s.startsWith('UPDATE cobranca_eventos SET situacao = $2')) {
            const e = this.eventos.find((x) => x.id === p[0])!;
            assert.ok(e.situacao !== 'PROCESSADO' && e.situacao !== 'IGNORADO', 'evento concluído não muda (guarda da 068)');
            Object.assign(e, { situacao: p[1], empresa_id: e.empresa_id ?? p[2], tentativas: e.tentativas + 1, ultimo_erro: p[3], processado_em: this.agora });
            return rows([]);
        }
        if (s.startsWith("SELECT empresa_id FROM empresa_assinaturas WHERE provedor = 'ASAAS' AND provedor_assinatura_id = $1"))
            return rows([...this.assinaturas.values()].filter((a) => a.provedor_assinatura_id === p[0]).map((a) => ({ empresa_id: a.empresa_id })));
        if (s.startsWith('SELECT empresa_id FROM empresa_assinaturas WHERE empresa_id = $1::uuid'))
            return rows([...this.assinaturas.values()].filter((a) => a.empresa_id === p[0] && a.provedor_assinatura_id).map((a) => ({ empresa_id: a.empresa_id })));
        if (s.startsWith('SELECT situacao, ciclo')) return rows(this.assinaturas.has(String(p[0])) ? [{ ...this.assinaturas.get(String(p[0]))! }] : []);
        if (s.startsWith('SELECT to_char((clock_timestamp())')) return rows([{ agora: this.agora }]);
        if (s.startsWith('UPDATE empresa_assinaturas SET situacao = $2')) {
            const a = this.assinaturas.get(String(p[0]))!;
            Object.assign(a, { situacao: p[1], ciclo: p[2], periodo_atual_fim: p[3], em_atraso_desde: p[4], cancelada_em: p[5], encerrada_em: p[6], provedor_situacao: p[7], sincronizado_em: this.agora, versao: a.versao + 1 });
            return rows([]);
        }
        if (s.startsWith('UPDATE empresa_assinaturas SET provedor_situacao = $2')) {
            Object.assign(this.assinaturas.get(String(p[0]))!, { provedor_situacao: p[1], sincronizado_em: this.agora });
            return rows([]);
        }
        // iniciarAssinatura
        if (s.startsWith('SELECT id, evento_id, assinatura_provedor_id FROM cobranca_eventos WHERE empresa_id = $1::uuid'))
            return rows(this.eventos.filter((e) => e.evento_id.startsWith('kidmais:') && e.evento_id.includes(String(p[0])) && ['PENDENTE', 'FALHOU'].includes(e.situacao))
                .map((e) => ({ id: e.id, evento_id: e.evento_id, assinatura_provedor_id: null })));
        // marcadores de exclusão abertos da empresa (assinaturasComRemocaoIncerta): este banco falso não tem nenhum
        if (s.startsWith('SELECT id, assinatura_provedor_id FROM cobranca_eventos'))
            return rows(this.eventos.filter((e) => e.evento_id.startsWith('kidmais:remocao:') && e.evento_id.includes(String(p[0])) && ['PENDENTE', 'FALHOU'].includes(e.situacao))
                .map((e) => ({ id: e.id, assinatura_provedor_id: 'sub_desconhecida' })));
        if (s.startsWith("UPDATE cobranca_eventos SET situacao = 'PROCESSADO', processado_em = clock_timestamp(), ultimo_erro = $2")) {
            Object.assign(this.eventos.find((x) => x.id === p[0])!, { situacao: 'PROCESSADO', processado_em: this.agora, ultimo_erro: p[1] });
            return rows([]);
        }
        if (s.startsWith("UPDATE cobranca_eventos SET situacao = 'PROCESSADO', processado_em = clock_timestamp(), ultimo_erro = $3")) {
            for (const e of this.eventos.filter((x) => (p[1] as string[]).includes(x.id) && ['PENDENTE', 'FALHOU'].includes(x.situacao)))
                Object.assign(e, { situacao: 'PROCESSADO', processado_em: this.agora, ultimo_erro: p[2] });
            return rows([]);
        }
        if (s.startsWith('UPDATE cobranca_eventos SET ultimo_erro = $2')) {
            Object.assign(this.eventos.find((x) => x.id === p[0])!, { ultimo_erro: p[1] });
            return rows([]);
        }
        if (s.startsWith('SELECT a.situacao, a.ciclo')) {
            const a = this.assinaturas.get(String(p[0]));
            return rows(a ? [{ ...a, documento_teste: '11222333000181', nome: 'Buffet', hoje: '2026-10-20' }] : []);
        }
        if (s.startsWith("UPDATE empresa_assinaturas SET provedor = 'ASAAS'")) {
            const a = this.assinaturas.get(String(p[0]))!;
            Object.assign(a, { provedor: 'ASAAS', provedor_cliente_id: a.provedor_cliente_id ?? p[1], provedor_assinatura_id: p[2], ciclo: ['TESTE', 'ENCERRADA'].includes(a.situacao) ? p[3] : a.ciclo, provedor_situacao: p[4] });
            return rows([]);
        }
        throw new Error(`SQL não previsto no banco falso: ${s.slice(0, 120)}`);
    }
}

function novaAssinatura(empresaId: string, extra: Partial<Assin> = {}): Assin {
    return { empresa_id: empresaId, situacao: 'TESTE', ciclo: null, periodo_atual_fim: null, em_atraso_desde: null, cancelada_em: null, encerrada_em: null, provedor: 'ASAAS', provedor_cliente_id: `cus_${empresaId.slice(0, 4)}`, provedor_assinatura_id: `sub_${empresaId.slice(0, 4)}`, provedor_situacao: null, sincronizado_em: null, versao: 1, ...extra };
}

/** Provedor falso: estado mutável por assinatura; `fora` simula indisponibilidade. */
class ProvedorFalso implements ProvedorLeitura {
    assinaturas = new Map<string, AssinaturaProvedor | null>();
    cobrancas = new Map<string, CobrancaProvedor[]>();
    fora = false;
    consultas = 0;
    async obterAssinatura(id: string) {
        this.consultas += 1;
        if (this.fora) throw new AsaasFalhou('consultar assinatura', 503, 'HTTP');
        return this.assinaturas.get(id) ?? null;
    }
    async listarCobrancasDaAssinatura(id: string) {
        if (this.fora) throw new AsaasFalhou('listar cobranças', 503, 'HTTP');
        return this.cobrancas.get(id) ?? [];
    }
}
const sub = (id: string, ref: string, status = 'ACTIVE'): AssinaturaProvedor => ({ id, status, deleted: false, cycle: 'MONTHLY', customer: `cus_${ref.slice(0, 4)}`, externalReference: ref });
const pago = (id: string, dueDate: string, status = 'RECEIVED'): CobrancaProvedor => ({ id, status, dueDate, paymentDate: dueDate, invoiceUrl: `https://sandbox.asaas.com/i/${id}`, deleted: false });

function ambiente(env: Record<string, string | undefined> = ENV) {
    const banco = new BancoFalso();
    const agendados: string[] = [];
    const limites = new Map<string, number>();
    const deps: DepsWebhook = {
        env, ip: '203.0.113.7',
        withTransaction: async (t) => t(banco),
        consumirLimite: async (_tx, _tipo, valor, regra) => {
            const k = `${regra.namespace}|${valor}`;
            limites.set(k, (limites.get(k) ?? 0) + 1);
            return limites.get(k)! <= regra.limite;
        },
        agendar: (id) => { agendados.push(id); },
    };
    return { banco, agendados, deps, limites };
}
function req(corpo: unknown, token: string | null = TOKEN, extra: Record<string, string> = {}) {
    const body = typeof corpo === 'string' ? corpo : JSON.stringify(corpo);
    return new Request('https://kidmais.example/api/integracoes/asaas/webhook', {
        method: 'POST', body, headers: { 'Content-Type': 'application/json', ...(token === null ? {} : { [CABECALHO_TOKEN]: token }), ...extra },
    });
}
const evento = (id: string, tipo: string, subscription: string, ref: string) => ({
    id, event: tipo, dateCreated: '2026-10-20 12:00:00', account: { id: 'acc' },
    payment: { object: 'payment', id: `pay_${id}`, subscription, externalReference: ref, customer: 'cus_x', value: 99.9, billingType: 'PIX', status: 'RECEIVED', description: 'Fulano CPF 123' },
});

test('token: comparação em tempo constante; inválido ou ausente → 401, nada gravado além da recusa limitada; corpo e token não vão à auditoria', async () => {
    assert.equal(tokenConfere(TOKEN, TOKEN), true);
    assert.equal(tokenConfere(`${TOKEN}x`, TOKEN), false);
    assert.equal(tokenConfere(null, TOKEN), false);
    const { banco, agendados, deps } = ambiente();
    assert.equal((await receberWebhookAsaas(req(evento('evt_1', 'PAYMENT_RECEIVED', 'sub_1', EMP_A), 'token-errado-token-errado-token-errado'), deps)).status, 401);
    assert.equal((await receberWebhookAsaas(req(evento('evt_2', 'PAYMENT_RECEIVED', 'sub_1', EMP_A), null), deps)).status, 401);
    assert.equal(banco.eventos.length, 0);
    assert.equal(agendados.length, 0);
    assert.deepEqual(banco.auditoria.map((a) => a.acao), ['COBRANCA_WEBHOOK_RECUSADO', 'COBRANCA_WEBHOOK_RECUSADO']);
    const auditado = JSON.stringify(banco.auditoria);
    assert.ok(!auditado.includes('token-errado') && !auditado.includes('evt_1') && !auditado.includes('Fulano'));
    assert.match(auditado, /TOKEN_INVALIDO/);
    assert.match(auditado, /TOKEN_AUSENTE/);
    // A própria recusa é limitada: depois de 10 na janela, nada mais é auditado.
    for (let i = 0; i < 15; i += 1)
        await receberWebhookAsaas(req({}, 'x'.repeat(40)), deps);
    assert.equal(banco.auditoria.length, 10);
});

test('cobrança desligada → 503 sem gravar; corpo grande → 413; JSON inválido → 400; limite por IP → 429; só POST', async () => {
    const desligado = ambiente({ ASAAS_AMBIENTE: 'producao', ASAAS_API_KEY: '$aact_prod_x', ASAAS_WEBHOOK_TOKEN: TOKEN });
    assert.equal((await receberWebhookAsaas(req(evento('evt_1', 'PAYMENT_RECEIVED', 'sub_1', EMP_A)), desligado.deps)).status, 503);
    assert.equal(desligado.banco.sql.length, 0, 'nada consultado nem gravado');
    const { banco, deps } = ambiente();
    const grande = JSON.stringify({ ...evento('evt_g', 'PAYMENT_RECEIVED', 'sub_1', EMP_A), lixo: 'x'.repeat(LIMITE_CORPO) });
    assert.equal((await receberWebhookAsaas(req(grande), deps)).status, 413);
    assert.equal((await receberWebhookAsaas(req(grande, TOKEN, { 'Content-Length': String(grande.length) }), deps)).status, 413);
    assert.equal((await receberWebhookAsaas(req('{nao e json'), deps)).status, 400);
    assert.equal((await receberWebhookAsaas(req({ event: 'PAYMENT_RECEIVED' }), deps)).status, 400);
    assert.equal(banco.eventos.length, 0);
    assert.equal((await receberWebhookAsaas(new Request('https://k.example/x', { method: 'GET' }), deps)).status, 405);
    const limitado = ambiente();
    limitado.deps.consumirLimite = async (_tx, _t, _v, regra) => regra.namespace !== 'WEBHOOK_ASAAS';
    assert.equal((await receberWebhookAsaas(req(evento('evt_l', 'PAYMENT_RECEIVED', 'sub_1', EMP_A)), limitado.deps)).status, 429);
    assert.equal(limitado.banco.eventos.length, 0);
});

test('válido: grava só identificadores, responde 200 e agenda; entrega repetida → um único registro e um único efeito', async () => {
    const { banco, agendados, deps } = ambiente();
    banco.assinaturas.set(EMP_A, novaAssinatura(EMP_A));
    const provedor = new ProvedorFalso();
    provedor.assinaturas.set('sub_1111', sub('sub_1111', EMP_A));
    provedor.cobrancas.set('sub_1111', [pago('p1', '2026-10-20')]);
    const r1 = await receberWebhookAsaas(req(evento('evt_1', 'PAYMENT_RECEIVED', 'sub_1111', EMP_A)), deps);
    assert.equal(r1.status, 200);
    assert.deepEqual(await r1.json(), { recebido: true, duplicado: false });
    const gravado = JSON.stringify(banco.eventos);
    assert.ok(!gravado.includes('Fulano') && !gravado.includes('99.9') && !gravado.includes('PIX'), 'nada de dado pessoal ou valor');
    assert.equal(banco.eventos[0].referencia_externa, EMP_A);
    // Processa (como o `after` da rota faria) e recebe a mesma entrega de novo.
    assert.equal((await processarEvento(banco, agendados[0], { provedor })).situacao, 'PROCESSADO');
    const versao = banco.assinaturas.get(EMP_A)!.versao;
    const r2 = await receberWebhookAsaas(req(evento('evt_1', 'PAYMENT_RECEIVED', 'sub_1111', EMP_A)), deps);
    assert.equal(r2.status, 200);
    assert.deepEqual(await r2.json(), { recebido: true, duplicado: true });
    assert.equal(banco.eventos.length, 1);
    assert.equal(agendados.length, 1, 'evento concluído não é reagendado');
    assert.equal((await processarEvento(banco, banco.eventos[0].id, { provedor })).situacao, 'JA_CONCLUIDO');
    assert.equal(banco.assinaturas.get(EMP_A)!.versao, versao, 'um único efeito');
    assert.equal(banco.assinaturas.get(EMP_A)!.situacao, 'ATIVA');
    assert.equal(banco.auditoria.filter((a) => a.acao === 'ASSINATURA_SINCRONIZADA').length, 1);
});

test('fora de ordem: "pago" depois de "cancelado" → estado final igual ao do provedor após reconsulta', async () => {
    const { banco, agendados, deps } = ambiente();
    banco.assinaturas.set(EMP_A, novaAssinatura(EMP_A));
    const provedor = new ProvedorFalso();
    // Estado atual do provedor: pagou e depois cancelou (assinatura removida → 404).
    provedor.assinaturas.set('sub_1111', null);
    banco.assinaturas.get(EMP_A)!.situacao = 'ATIVA';
    Object.assign(banco.assinaturas.get(EMP_A)!, { ciclo: 'MENSAL', periodo_atual_fim: '2026-11-20T03:00:00.000Z' });
    await receberWebhookAsaas(req({ id: 'evt_del', event: 'SUBSCRIPTION_DELETED', dateCreated: 'x', subscription: { id: 'sub_1111', externalReference: EMP_A } }), deps);
    await receberWebhookAsaas(req(evento('evt_pago', 'PAYMENT_RECEIVED', 'sub_1111', EMP_A)), deps);
    // Processa na ordem invertida de chegada.
    await processarEvento(banco, agendados[1], { provedor });
    await processarEvento(banco, agendados[0], { provedor });
    assert.equal(banco.assinaturas.get(EMP_A)!.situacao, 'CANCELADA_FIM_PERIODO');
    assert.equal(banco.assinaturas.get(EMP_A)!.provedor_situacao, 'DELETED');
    assert.deepEqual(banco.eventos.map((e) => e.situacao), ['PROCESSADO', 'PROCESSADO']);
});

test('tipo desconhecido → IGNORADO; empresa desconhecida → IGNORADO; evento de A nunca toca B', async () => {
    const { banco, agendados, deps } = ambiente();
    banco.assinaturas.set(EMP_A, novaAssinatura(EMP_A));
    banco.assinaturas.set(EMP_B, novaAssinatura(EMP_B));
    const provedor = new ProvedorFalso();
    provedor.assinaturas.set('sub_1111', sub('sub_1111', EMP_A));
    provedor.cobrancas.set('sub_1111', [pago('p1', '2026-10-20')]);
    await receberWebhookAsaas(req({ id: 'evt_x', event: 'ACCOUNT_STATUS_UPDATED', dateCreated: 'x' }), deps);
    await receberWebhookAsaas(req(evento('evt_y', 'PAYMENT_RECEIVED', 'sub_desconhecida', '33333333-3333-4333-8333-333333333333')), deps);
    await receberWebhookAsaas(req(evento('evt_a', 'PAYMENT_CONFIRMED', 'sub_1111', EMP_A)), deps);
    const r = [];
    for (const id of agendados) r.push(await processarEvento(banco, id, { provedor }));
    assert.deepEqual(r.map((x) => [x.situacao, x.motivo ?? null]), [['IGNORADO', 'TIPO_NAO_TRATADO'], ['IGNORADO', 'EMPRESA_NAO_ENCONTRADA'], ['PROCESSADO', null]]);
    assert.equal(provedor.consultas, 1, 'só o evento resolvido consulta o provedor');
    assert.equal(banco.assinaturas.get(EMP_A)!.situacao, 'ATIVA');
    assert.deepEqual([banco.assinaturas.get(EMP_B)!.situacao, banco.assinaturas.get(EMP_B)!.versao, banco.assinaturas.get(EMP_B)!.sincronizado_em], ['TESTE', 1, null]);
    // Referência externa de A apontando para a assinatura de B (evento forjado com token válido) não move B nem A.
    provedor.assinaturas.set('sub_2222', sub('sub_2222', EMP_A));
    await receberWebhookAsaas(req(evento('evt_forjado', 'PAYMENT_RECEIVED', 'sub_2222', EMP_A)), deps);
    const forjado = await processarEvento(banco, agendados.at(-1)!, { provedor });
    assert.deepEqual([forjado.situacao, forjado.motivo], ['IGNORADO', 'REFERENCIA_DIVERGENTE']);
    assert.equal(banco.assinaturas.get(EMP_B)!.situacao, 'TESTE');
});

test('provedor fora do ar → FALHOU com tentativa contada; nova tentativa depois → PROCESSADO', async () => {
    const { banco, agendados, deps } = ambiente();
    banco.assinaturas.set(EMP_A, novaAssinatura(EMP_A));
    const provedor = new ProvedorFalso();
    provedor.assinaturas.set('sub_1111', sub('sub_1111', EMP_A));
    provedor.cobrancas.set('sub_1111', [pago('p1', '2026-10-20')]);
    provedor.fora = true;
    await receberWebhookAsaas(req(evento('evt_1', 'PAYMENT_RECEIVED', 'sub_1111', EMP_A)), deps);
    const falha = await processarEvento(banco, agendados[0], { provedor });
    assert.equal(falha.situacao, 'FALHOU');
    assert.deepEqual([banco.eventos[0].situacao, banco.eventos[0].tentativas, banco.eventos[0].empresa_id], ['FALHOU', 1, EMP_A]);
    assert.match(banco.eventos[0].ultimo_erro ?? '', /^PROVEDOR_INDISPONIVEL/);
    assert.equal(banco.assinaturas.get(EMP_A)!.situacao, 'TESTE', 'nada aplicado');
    // Reentrega do mesmo evento reagenda (ainda pendente) e o provedor voltou.
    provedor.fora = false;
    const r = await receberWebhookAsaas(req(evento('evt_1', 'PAYMENT_RECEIVED', 'sub_1111', EMP_A)), deps);
    assert.deepEqual(await r.json(), { recebido: true, duplicado: true });
    assert.equal(agendados.length, 2);
    assert.equal((await processarEvento(banco, agendados[1], { provedor })).situacao, 'PROCESSADO');
    assert.deepEqual([banco.eventos[0].situacao, banco.eventos[0].tentativas, banco.assinaturas.get(EMP_A)!.situacao], ['PROCESSADO', 2, 'ATIVA']);
});

test('retorno do checkout sem webhook: iniciar a assinatura grava só os ids do provedor; situação e acesso não mudam', async () => {
    const banco = new BancoFalso();
    banco.assinaturas.set(EMP_A, novaAssinatura(EMP_A, { provedor: null, provedor_cliente_id: null, provedor_assinatura_id: null }));
    const chamadas: string[] = [];
    const provedor: ClienteAsaas = {
        async buscarClientePorReferencia() { chamadas.push('buscarCliente'); return null; },
        async criarCliente(i) { chamadas.push(`criarCliente:${i.referencia}`); return { id: 'cus_novo', externalReference: i.referencia }; },
        async obterAssinatura() { return null; },
        async listarAssinaturasPorReferencia() { chamadas.push('listarAssinaturas'); return []; },
        async criarAssinatura(i) { chamadas.push(`criarAssinatura:${i.ciclo}:${i.valorCentavos}:${i.vencimento}`); return { id: 'sub_novo', status: 'ACTIVE', deleted: false, cycle: 'MONTHLY', customer: i.cliente, externalReference: i.referencia }; },
        async listarCobrancasDaAssinatura() { return [{ id: 'pay_1', status: 'PENDING', dueDate: '2026-10-20', paymentDate: null, invoiceUrl: 'https://sandbox.asaas.com/i/pay_1', deleted: false }]; },
        async removerAssinatura() { chamadas.push('remover'); return { removida: true }; },
    };
    let papel = 'REPRESENTANTE_AUTORIZADO';
    const deps: DepsCobranca = {
        withTenantTransaction: async (_s, _e, t) => t(banco, { empresaComprovada: EMP_A, membershipId: 'm', usuarioId: 'u', papelAtual: papel }),
        provedor: () => provedor,
        env: { ...ENV, ASSINATURA_PRECO_MENSAL_CENTAVOS: '9990' },
        withTransaction: async (t) => t(banco),
        // Uma conexão só: sem trava real aqui (a trava por empresa é coberta em contratacao-e8.postgres.test.ts).
        travarContratacao: async (_empresa, t) => t(),
    };
    const sessao = { id: 's', usuario_id: '44444444-4444-4444-8444-444444444444', nome: 'G', cargo: null, papel: 'REPRESENTANTE_AUTORIZADO', autenticado_em: '', expira_em: '', csrf_hash: '' } as const;
    const ctx = { requestId: '55555555-5555-4555-8555-555555555555' };
    papel = 'ADMINISTRATIVO';
    await assert.rejects(iniciarAssinatura(sessao, null, { ciclo: 'MENSAL' }, ctx, deps), /Somente a Gestão/);
    papel = 'REPRESENTANTE_AUTORIZADO';
    await assert.rejects(iniciarAssinatura(sessao, null, { ciclo: 'ANUAL' }, ctx, deps), /não está publicado/, 'sem preço configurado o ciclo fica indisponível');
    const antes = { ...banco.assinaturas.get(EMP_A)! };
    const r = await iniciarAssinatura(sessao, null, { ciclo: 'MENSAL' }, ctx, deps);
    assert.deepEqual(r, { ciclo: 'MENSAL', reaproveitada: false, urlPagamento: 'https://sandbox.asaas.com/i/pay_1', vencimento: '2026-10-20' });
    assert.deepEqual(chamadas, ['buscarCliente', `criarCliente:${EMP_A}`, 'listarAssinaturas', 'criarAssinatura:MENSAL:9990:2026-10-20']);
    assert.deepEqual(banco.eventos.filter((e) => e.evento_id.startsWith('kidmais:criacao:')).map((e) => [e.situacao, e.ultimo_erro]), [['PROCESSADO', 'VINCULADA']],
        'intenção gravada antes do POST e encerrada junto com o vínculo');
    assert.deepEqual(banco.eventos.filter((e) => e.evento_id.startsWith('kidmais:vinculo:')).map((e) => [e.situacao, e.ultimo_erro]), [['PROCESSADO', 'VINCULADA']], 'id confirmado gravado e encerrado com o vínculo');
    const depois = banco.assinaturas.get(EMP_A)!;
    assert.deepEqual([depois.situacao, depois.periodo_atual_fim, depois.provedor_assinatura_id, depois.provedor_cliente_id], [antes.situacao, null, 'sub_novo', 'cus_novo']);
    assert.ok(!banco.sql.some((s) => /empresa_assinaturas SET situacao/.test(s)), 'nenhuma escrita de situação da assinatura ao iniciar');
    // Voltar da página de pagamento é só leitura (a tela de retorno faz GET /api/admin/assinatura).
    const retorno = readFileSync('components/admin/AssinaturaRetorno.tsx', 'utf8');
    assert.match(retorno, /adminFetch\('\/api\/admin\/assinatura'\)/);
    assert.ok(!/method:\s*'POST'/.test(retorno), 'o retorno não envia nada ao servidor');
});
