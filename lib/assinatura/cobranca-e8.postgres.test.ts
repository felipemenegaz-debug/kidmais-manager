import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Client } from 'pg';
import { conectarDescartavel, encerrarDescartavel } from '../comercial/postgres-descartavel.ts';
import { carregarModulo } from '../acessos/teste-carregador.ts';
import { iniciarTeste } from './servico.ts';
import { lerEstadoComercial } from './estado.ts';
import { iniciarAssinatura, cancelarAssinatura, type DepsCobranca } from './cobranca.ts';
import { processarEvento, sincronizarEmpresa } from './sincronizacao.ts';
import { CABECALHO_TOKEN, receberWebhookAsaas, type ConsumirLimite } from './webhook-asaas.ts';
import { AsaasFalhou, type AssinaturaProvedor, type ClienteAsaas, type CobrancaProvedor } from './asaas.ts';

/**
 * E8 no PostgreSQL DESCARTÁVEL (modelo "atual" + 067 + 068 aplicadas aqui) com provedor FALSO (sem rede):
 * checkout sem efeito de acesso, TESTE → ATIVA por pagamento confirmado, atraso e regularização, cancelamento ao fim do
 * período e encerramento, eventos duplicados e fora de ordem, token inválido, provedor fora do ar, isolamento entre
 * empresas e o nível do paywall (lerEstadoComercial) depois de cada passo. SQL real, guarda real da 068.
 */
const M067 = 'database/migrations/20261006_067_modelo_comercial_empresa.sql';
const M068 = 'database/migrations/20261007_068_cobranca_assinatura.sql';
const TOKEN = 'token-webhook-sintetico-de-teste-32+caracteres';
const ENV = { ASAAS_AMBIENTE: 'sandbox', ASAAS_API_KEY: '$aact_hmlg_chave_sintetica_de_teste_sem_valor', ASAAS_WEBHOOK_TOKEN: TOKEN, ASSINATURA_PRECO_MENSAL_CENTAVOS: '9990' };

let client: Client;
let consumirLimite: ConsumirLimite;
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

/** Provedor falso com estado: assinaturas, cobranças e clientes por referência; `fora` = indisponível. */
class AsaasFalso implements ClienteAsaas {
    clientes = new Map<string, string>();
    assinaturas = new Map<string, AssinaturaProvedor>();
    cobrancas = new Map<string, CobrancaProvedor[]>();
    vencimentoInicial = new Map<string, string>();
    criadas = 0;
    fora = false;
    private seq = 0;
    private checar(op: string) { if (this.fora) throw new AsaasFalhou(op, 503, 'HTTP'); }
    async buscarClientePorReferencia(ref: string) { this.checar('listar clientes'); const id = this.clientes.get(ref); return id ? { id, externalReference: ref } : null; }
    async criarCliente(i: { referencia: string }) { this.checar('criar cliente'); const id = `cus_${++this.seq}`; this.clientes.set(i.referencia, id); return { id, externalReference: i.referencia }; }
    async obterAssinatura(id: string) { this.checar('consultar assinatura'); const a = this.assinaturas.get(id); return a && !a.deleted ? { ...a } : null; }
    async listarAssinaturasPorReferencia(ref: string) { this.checar('listar assinaturas'); return [...this.assinaturas.values()].filter((a) => a.externalReference === ref && !a.deleted); }
    async criarAssinatura(i: { cliente: string; ciclo: 'MENSAL' | 'ANUAL'; vencimento: string; referencia: string }) {
        this.checar('criar assinatura');
        this.criadas += 1;
        const id = `sub_${++this.seq}`;
        this.assinaturas.set(id, { id, status: 'ACTIVE', deleted: false, cycle: i.ciclo === 'MENSAL' ? 'MONTHLY' : 'YEARLY', customer: i.cliente, externalReference: i.referencia });
        const vencimento = this.vencimentoInicial.get(i.referencia) ?? i.vencimento;
        this.cobrancas.set(id, [{ id: `pay_${id}_1`, status: 'PENDING', dueDate: vencimento, paymentDate: null, invoiceUrl: `https://sandbox.asaas.com/i/pay_${id}_1`, deleted: false }]);
        return this.assinaturas.get(id)!;
    }
    async listarCobrancasDaAssinatura(id: string) { this.checar('listar cobranças'); return (this.cobrancas.get(id) ?? []).map((c) => ({ ...c })); }
    async removerAssinatura(id: string) {
        this.checar('remover assinatura');
        const a = this.assinaturas.get(id);
        if (a) {
            a.deleted = true;
            this.cobrancas.set(id, (this.cobrancas.get(id) ?? []).filter((c) => ['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'].includes(c.status)));
        }
        return { removida: true };
    }
    pagar(sub: string, idx = 0, status = 'RECEIVED') { const c = this.cobrancas.get(sub)![idx]; c.status = status; c.paymentDate = c.dueDate; }
}
const provedor = new AsaasFalso();

function deps(): DepsCobranca {
    return {
        withTenantTransaction: (_sessao, _empresa, trabalho) => emTx(() => trabalho(client as never, { empresaComprovada: ids.atual, membershipId: 'm', usuarioId: ids.usuario, papelAtual: 'REPRESENTANTE_AUTORIZADO' })),
        provedor: () => provedor, env: ENV,
        withTransaction: (t) => emTx(() => t(client as never)),
        // Uma conexão só: sem trava real aqui (a trava por empresa é coberta em contratacao-e8.postgres.test.ts).
        travarContratacao: async (_empresa, t) => t(),
    };
}
async function sessao(reautenticadaHaSegundos = 10) {
    const r = (await q(`SELECT to_char((clock_timestamp() - make_interval(secs => $1)) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS a,
        to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS c`, [reautenticadaHaSegundos])).rows[0];
    return { id: 's', usuario_id: ids.usuario, nome: 'Gestão', cargo: null, papel: 'REPRESENTANTE_AUTORIZADO' as const, autenticado_em: r.a, consultado_em: r.c, expira_em: '', csrf_hash: '' };
}
const ctx = () => ({ requestId: crypto.randomUUID() });

/** Webhook completo (token, limite real por IP, gravação) + processamento como o `after` da rota faria. */
async function webhook(corpo: unknown, token: string | null = TOKEN) {
    const agendados: string[] = [];
    const res = await receberWebhookAsaas(new Request('https://kidmais.example/api/integracoes/asaas/webhook', {
        method: 'POST', body: JSON.stringify(corpo), headers: { 'Content-Type': 'application/json', ...(token ? { [CABECALHO_TOKEN]: token } : {}) },
    }), { env: ENV, ip: '203.0.113.9', withTransaction: (t) => emTx(() => t(client as never)), consumirLimite, agendar: (id) => { agendados.push(id); } });
    const processados = [];
    for (const id of agendados)
        processados.push(await emTx(() => processarEvento(client as never, id, { provedor })));
    return { status: res.status, corpo: res.status === 200 ? await res.json() as { duplicado: boolean } : null, processados };
}
const evPagamento = (id: string, tipo: string, sub: string, ref: string) => ({ id, event: tipo, dateCreated: `${hoje} 10:00:00`, payment: { id: `pay_${id}`, subscription: sub, externalReference: ref, value: 99.9, customer: 'cus_x' } });
const evAssinatura = (id: string, tipo: string, sub: string, ref: string) => ({ id, event: tipo, dateCreated: `${hoje} 10:00:00`, subscription: { id: sub, externalReference: ref } });

async function linha(empresaId: string) {
    return (await q(`SELECT situacao, versao, provedor_assinatura_id, provedor_cliente_id, provedor_situacao, sincronizado_em IS NOT NULL AS sincronizada,
        to_char(periodo_atual_fim AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS periodo,
        to_char(em_atraso_desde AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS atraso FROM empresa_assinaturas WHERE empresa_id = $1`, [empresaId])).rows[0];
}
const nivel = async (empresaId: string) => { const e = await lerEstadoComercial(client as never, empresaId); return [e.acesso.nivel, e.acesso.motivo]; };
const fimDoCiclo = (data: string) => { const [a, m, d] = data.split('-').map(Number); const ultimo = new Date(Date.UTC(a, m + 1, 0)).getUTCDate(); return new Date(Date.UTC(a + Math.floor(m / 12), m % 12, Math.min(d, ultimo), 3)).toISOString(); };

async function novaEmpresa(documento: string) {
    const id = (await q("INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Buffet E8', 'PROVISIONAMENTO') RETURNING id", [`e8${randomBytes(3).toString('hex')}`])).rows[0].id as string;
    await q("UPDATE empresas SET status = 'ATIVA' WHERE id = $1", [id]);
    await emTx(() => iniciarTeste(client as never, { empresaId: id, documento }));
    return id;
}

test.before(async () => {
    client = await conectarDescartavel();
    process.env.ADMIN_AUTH_SECRET = 'segredo-sintetico-da-suite-e8-com-mais-de-32-caracteres';
    const servico = carregarModulo('lib/autenticacao/service.ts', { 'db/postgres': { db: () => client, withTransaction: async (w: (c: Client) => unknown) => w(client) } }, new Map()) as { consumirLimite: ConsumirLimite };
    consumirLimite = servico.consumirLimite;
    // Estado `atual` (até a 057): instala 067/068; estado `075`: já instaladas pela receita.
    if ((await q("SELECT to_regclass('public.empresa_assinaturas') IS NULL AS ok")).rows[0].ok) await q(readFileSync(M067, 'utf8'));
    if ((await q("SELECT to_regclass('public.cobranca_eventos') IS NULL AS ok")).rows[0].ok) await q(readFileSync(M068, 'utf8'));
    hoje = (await q("SELECT to_char(clock_timestamp() AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS d")).rows[0].d;
    ids.usuario = (await q("INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Gestão E8', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id",
        [`e8${randomBytes(3).toString('hex')}@example.test`, `scrypt$v=1$N=131072$r=8$p=1$${'A'.repeat(22)}==$${'B'.repeat(86)}==`])).rows[0].id;
    ids.a = await novaEmpresa('11222333000181');
    ids.b = await novaEmpresa('45723174000110');
    ids.c = await novaEmpresa('04252011000110');
});
test.after(async () => {
    if (client)
        await encerrarDescartavel(client);
});

test('checkout: grava só os ids do provedor; voltar da página sem webhook não muda situação nem acesso; repetir não duplica', async () => {
    ids.atual = ids.a;
    const r = await iniciarAssinatura(await sessao(), null, { ciclo: 'MENSAL' }, ctx(), deps());
    assert.match(r.urlPagamento ?? '', /^https:\/\/sandbox\.asaas\.com\/i\//);
    assert.equal(r.vencimento, hoje);
    const l = await linha(ids.a);
    assert.deepEqual([l.situacao, l.periodo, l.provedor_situacao], ['TESTE', null, 'ACTIVE']);
    ids.subA = l.provedor_assinatura_id;
    assert.deepEqual(await nivel(ids.a), ['COMPLETO', 'TESTE'], 'retorno do checkout sem webhook não libera nem muda nada');
    // "Continuar pagamento": mesma assinatura e mesma cobrança em aberto, sem criar outra no provedor.
    const de2 = await iniciarAssinatura(await sessao(), null, { ciclo: 'MENSAL' }, ctx(), deps());
    assert.deepEqual([de2.reaproveitada, de2.urlPagamento, provedor.criadas], [true, r.urlPagamento, 1]);
    // Commit perdido depois de criar no provedor: a próxima tentativa reencontra cliente e assinatura pela referência.
    ids.atual = ids.c;
    provedor.vencimentoInicial.set(ids.c, dia(-45));
    let fases = 0;
    const base = deps();
    // Fase C (3ª transação de tenant: empresa, fase A, fase C) falha por comunicação sem COMMIT: o vínculo relido está
    // vazio, então é DÚVIDA — nada é excluído no provedor, a pendência fica registrada e a resposta é "incerta".
    const perdido: DepsCobranca = { ...base, withTenantTransaction: (s, e, t) => {
        fases += 1;
        if (fases === 3)
            return Promise.reject(Object.assign(new Error('commit perdido (simulado)'), { code: 'ECONNRESET' }));
        return base.withTenantTransaction(s, e, t);
    } };
    await assert.rejects(iniciarAssinatura(await sessao(), null, { ciclo: 'MENSAL' }, ctx(), perdido), (e: { code?: string }) => e.code === 'COBRANCA_RESULTADO_INCERTO');
    assert.equal(provedor.criadas, 2);
    assert.equal((await linha(ids.c)).provedor_assinatura_id, null, 'nada gravado na falha');
    assert.equal((await q("SELECT count(*)::int AS n FROM cobranca_eventos WHERE empresa_id = $1 AND tipo = 'KIDMAIS_RECONCILIAR_CONTRATACAO' AND ultimo_erro = 'COMMIT_INCERTO'", [ids.c])).rows[0].n, 1, 'pendência registrada');
    const retomada = await iniciarAssinatura(await sessao(), null, { ciclo: 'MENSAL' }, ctx(), deps());
    assert.equal(retomada.reaproveitada, true);
    assert.equal(provedor.criadas, 2, 'a assinatura criada antes do commit perdido foi reaproveitada');
    ids.subC = (await linha(ids.c)).provedor_assinatura_id;
});

test('webhook: token inválido → 401 e nada gravado além da recusa; pagamento confirmado → TESTE → ATIVA; duplicado → um efeito', async () => {
    const eventosAntes = (await q('SELECT count(*)::int AS n FROM cobranca_eventos')).rows[0].n;
    const recusa = await webhook(evPagamento('evt_a1', 'PAYMENT_RECEIVED', ids.subA, ids.a), 'token-errado-token-errado-token-errado!!');
    assert.equal(recusa.status, 401);
    assert.equal((await q('SELECT count(*)::int AS n FROM cobranca_eventos')).rows[0].n, eventosAntes);
    const auditada = (await q("SELECT dados_depois FROM auditoria WHERE acao = 'COBRANCA_WEBHOOK_RECUSADO' ORDER BY criado_em DESC LIMIT 1")).rows[0];
    assert.deepEqual(auditada.dados_depois, { provedor: 'ASAAS', motivo: 'TOKEN_INVALIDO' });
    assert.equal((await linha(ids.a)).situacao, 'TESTE');

    provedor.pagar(ids.subA);
    const r = await webhook(evPagamento('evt_a1', 'PAYMENT_RECEIVED', ids.subA, ids.a));
    assert.deepEqual([r.status, r.corpo?.duplicado, r.processados.map((p) => p.situacao)], [200, false, ['PROCESSADO']]);
    const l = await linha(ids.a);
    assert.deepEqual([l.situacao, l.periodo, l.sincronizada], ['ATIVA', fimDoCiclo(hoje), true]);
    assert.deepEqual(await nivel(ids.a), ['COMPLETO', 'ASSINATURA_ATIVA']);
    const gravado = (await q("SELECT tipo, assinatura_provedor_id, cobranca_provedor_id, referencia_externa, empresa_id, situacao, tentativas FROM cobranca_eventos WHERE evento_id = 'evt_a1'")).rows[0];
    assert.deepEqual(gravado, { tipo: 'PAYMENT_RECEIVED', assinatura_provedor_id: ids.subA, cobranca_provedor_id: 'pay_evt_a1', referencia_externa: ids.a, empresa_id: ids.a, situacao: 'PROCESSADO', tentativas: 1 });
    const versao = l.versao;
    const dup = await webhook(evPagamento('evt_a1', 'PAYMENT_RECEIVED', ids.subA, ids.a));
    assert.deepEqual([dup.status, dup.corpo?.duplicado, dup.processados.length], [200, true, 0]);
    assert.equal((await q("SELECT count(*)::int AS n FROM cobranca_eventos WHERE evento_id = 'evt_a1'")).rows[0].n, 1);
    assert.equal((await linha(ids.a)).versao, versao, 'um único efeito');
    // Evento antigo ("criada") entregue depois do pagamento: reconsulta → continua ATIVA, sem nova transição auditada.
    const transicoes = (await q("SELECT count(*)::int AS n FROM auditoria WHERE acao = 'ASSINATURA_SINCRONIZADA' AND entidade_id = $1", [ids.a])).rows[0].n;
    await webhook(evPagamento('evt_a0', 'PAYMENT_CREATED', ids.subA, ids.a));
    assert.equal((await linha(ids.a)).situacao, 'ATIVA');
    assert.equal((await q("SELECT count(*)::int AS n FROM auditoria WHERE acao = 'ASSINATURA_SINCRONIZADA' AND entidade_id = $1", [ids.a])).rows[0].n, transicoes);
    // Assinatura ativa e em dia: "assinar" de novo não cria outra nem devolve cobrança.
    ids.atual = ids.a;
    const denovo = await iniciarAssinatura(await sessao(), null, { ciclo: 'MENSAL' }, ctx(), deps());
    assert.deepEqual([denovo.reaproveitada, denovo.urlPagamento, provedor.criadas], [true, null, 2]);
});

test('atraso e regularização: período vencido + cobrança OVERDUE → EM_ATRASO; pagamento → ATIVA (paywall a cada passo)', async () => {
    provedor.pagar(ids.subC); // vencimento hoje-45: período pago já terminou
    await webhook(evPagamento('evt_c1', 'PAYMENT_RECEIVED', ids.subC, ids.c));
    assert.deepEqual([(await linha(ids.c)).situacao, ...(await nivel(ids.c))], ['ATIVA', 'SOMENTE_LEITURA', 'PAGAMENTO_PENDENTE']);
    provedor.cobrancas.get(ids.subC)!.push({ id: 'pay_c2', status: 'OVERDUE', dueDate: dia(-14), paymentDate: null, invoiceUrl: 'https://sandbox.asaas.com/i/pay_c2', deleted: false });
    await webhook(evPagamento('evt_c2', 'PAYMENT_OVERDUE', ids.subC, ids.c));
    const atraso = await linha(ids.c);
    assert.deepEqual([atraso.situacao, atraso.atraso], ['EM_ATRASO', `${dia(-14)}T03:00:00.000Z`]);
    assert.deepEqual(await nivel(ids.c), ['SOMENTE_LEITURA', 'PAGAMENTO_PENDENTE'], '7 dias de regularização já passaram');
    // "Continuar pagamento" devolve a cobrança vencida.
    ids.atual = ids.c;
    assert.equal((await iniciarAssinatura(await sessao(), null, { ciclo: 'MENSAL' }, ctx(), deps())).urlPagamento, 'https://sandbox.asaas.com/i/pay_c2');
    provedor.pagar(ids.subC, 1);
    await webhook(evPagamento('evt_c3', 'PAYMENT_RECEIVED', ids.subC, ids.c));
    const regular = await linha(ids.c);
    assert.deepEqual([regular.situacao, regular.atraso, regular.periodo], ['ATIVA', null, fimDoCiclo(dia(-14))]);
    assert.deepEqual(await nivel(ids.c), ['COMPLETO', 'ASSINATURA_ATIVA'], 'pagamento posterior devolve o acesso completo sem perda');
});

test('provedor fora do ar → FALHOU (savepoint, transação segue válida); nova tentativa → PROCESSADO', async () => {
    provedor.fora = true;
    const r = await webhook(evPagamento('evt_c4', 'PAYMENT_UPDATED', ids.subC, ids.c));
    provedor.fora = false;
    assert.deepEqual([r.status, r.processados[0].situacao], [200, 'FALHOU']);
    const ev = (await q("SELECT id, situacao, tentativas, ultimo_erro, processado_em FROM cobranca_eventos WHERE evento_id = 'evt_c4'")).rows[0];
    assert.deepEqual([ev.situacao, ev.tentativas, ev.processado_em], ['FALHOU', 1, null]);
    assert.match(ev.ultimo_erro, /^PROVEDOR_INDISPONIVEL/);
    assert.equal((await emTx(() => processarEvento(client as never, ev.id, { provedor }))).situacao, 'PROCESSADO');
    assert.equal((await q('SELECT tentativas FROM cobranca_eventos WHERE id = $1', [ev.id])).rows[0].tentativas, 2);
});

test('cancelamento: exige senha recente; CANCELADA_FIM_PERIODO com acesso até o fim; "pago" antigo depois não reverte; fim do período → ENCERRADA', async () => {
    ids.atual = ids.a;
    await assert.rejects(cancelarAssinatura(await sessao(600), null, { confirmar: true }, ctx(), deps()), /Confirme sua senha/);
    await assert.rejects(cancelarAssinatura(await sessao(), null, {}, ctx(), deps()), /Confirme o cancelamento/);
    assert.equal((await linha(ids.a)).situacao, 'ATIVA');
    const r = await cancelarAssinatura(await sessao(), null, { confirmar: true, motivo: 'Teste da suíte' }, ctx(), deps());
    assert.equal(r.situacao, 'CANCELADA_FIM_PERIODO');
    assert.equal(provedor.assinaturas.get(ids.subA)!.deleted, true);
    const l = await linha(ids.a);
    assert.deepEqual([l.situacao, l.provedor_situacao, l.periodo], ['CANCELADA_FIM_PERIODO', 'DELETED', fimDoCiclo(hoje)]);
    assert.deepEqual(await nivel(ids.a), ['COMPLETO', 'CANCELADA_NO_PERIODO']);
    const auditoria = (await q("SELECT justificativa, origem FROM auditoria WHERE acao = 'ASSINATURA_CANCELADA' AND entidade_id = $1", [ids.a])).rows[0];
    assert.deepEqual(auditoria, { justificativa: 'Teste da suíte', origem: 'COBRANCA' });
    await assert.rejects(cancelarAssinatura(await sessao(), null, { confirmar: true }, ctx(), deps()), /já foi cancelada/);
    // Fora de ordem: "pago" e "criada" antigos chegam depois do cancelamento → reconsulta diz removida → nada muda.
    await webhook(evPagamento('evt_a1_reentregue', 'PAYMENT_CONFIRMED', ids.subA, ids.a));
    await webhook(evAssinatura('evt_a_created', 'SUBSCRIPTION_CREATED', ids.subA, ids.a));
    assert.equal((await linha(ids.a)).situacao, 'CANCELADA_FIM_PERIODO');
    // O tempo passa (simulado no período gravado): a reconsulta encerra e o paywall passa a somente leitura.
    await q("UPDATE empresa_assinaturas SET periodo_atual_fim = clock_timestamp() - interval '1 day' WHERE empresa_id = $1", [ids.a]);
    const s = await emTx(() => sincronizarEmpresa(client as never, ids.a, { provedor }, { tipo: 'RECONCILIACAO' }));
    assert.deepEqual([s.resultado, (s as { depois: string }).depois], ['SINCRONIZADA', 'ENCERRADA']);
    assert.deepEqual(await nivel(ids.a), ['SOMENTE_LEITURA', 'ENCERRADA']);
});

test('isolamento: eventos de A e C nunca tocam B; evento com referência de B sem assinatura dela → IGNORADO', async () => {
    const b = await linha(ids.b);
    assert.deepEqual([b.situacao, b.versao, b.provedor_assinatura_id, b.sincronizada], ['TESTE', 1, null, false]);
    const r = await webhook(evPagamento('evt_b_forjado', 'PAYMENT_RECEIVED', ids.subC, ids.b));
    assert.equal(r.processados[0].empresaId, ids.c, 'resolvido pela assinatura gravada (de C), não pela referência informada');
    const r2 = await webhook(evPagamento('evt_b_sem', 'PAYMENT_RECEIVED', 'sub_inexistente', ids.b));
    assert.deepEqual([r2.processados[0].situacao, r2.processados[0].motivo], ['IGNORADO', 'EMPRESA_NAO_ENCONTRADA']);
    const tipo = await webhook({ id: 'evt_desconhecido', event: 'ACCOUNT_STATUS_UPDATED', dateCreated: 'x' });
    assert.deepEqual([tipo.processados[0].situacao, tipo.processados[0].motivo], ['IGNORADO', 'TIPO_NAO_TRATADO']);
    const depois = await linha(ids.b);
    assert.deepEqual([depois.situacao, depois.versao, depois.sincronizada], ['TESTE', 1, false]);
    assert.deepEqual(await nivel(ids.b), ['COMPLETO', 'TESTE']);
    assert.equal((await q('SELECT count(*)::int AS n FROM cobranca_eventos WHERE empresa_id = $1', [ids.b])).rows[0].n, 0);
    // Nenhum dado pessoal ou valor do corpo foi gravado nos eventos.
    const colunas = JSON.stringify((await q('SELECT * FROM cobranca_eventos')).rows);
    assert.ok(!colunas.includes('99.9') && !colunas.includes('cus_x'));
});
