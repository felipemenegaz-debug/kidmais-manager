import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Client } from 'pg';
import { conectarDescartavel, encerrarDescartavel } from '../comercial/postgres-descartavel.ts';
import { iniciarTeste } from './servico.ts';
import { iniciarAssinatura, travaPorEmpresa, type DepsCobranca } from './cobranca.ts';
import { processarEvento } from './sincronizacao.ts';
import { TIPO_PENDENCIA } from './reconciliacao-contratacao.ts';
import { AsaasFalhou, type AssinaturaProvedor, type ClienteAsaas, type CobrancaProvedor } from './asaas.ts';

/**
 * Contratação da assinatura sob falhas e concorrência (E8), no PostgreSQL DESCARTÁVEL com VÁRIAS conexões reais
 * (a trava por empresa é pg_try_advisory_xact_lock de verdade) e provedor FALSO (sem rede, nenhuma chamada ao Asaas):
 *   - duas contratações simultâneas → uma assinatura no provedor, a outra recebe 409;
 *   - COMMIT confirmado no banco seguido de erro de comunicação → sucesso, nada desfeito;
 *   - criação no provedor com resposta perdida → reencontrada pela referência, sem duplicar; sem como confirmar →
 *     pendência e resposta "incerta";
 *   - falha na compensação → pendência registrada (não ignorada) e resolvida depois pela reconciliação;
 *   - dúvida sobre o vínculo → nada é excluído;
 *   - retomada sem duplicidade;
 *   - POST com resposta perdida e listagem vazia → nenhum outro POST até a assinatura aparecer (registro prévio);
 *   - compensação imediata com pagamento, recontratação após cancelamento e várias ativas → nenhuma exclusão.
 */
const M067 = 'database/migrations/20261006_067_modelo_comercial_empresa.sql';
const M068 = 'database/migrations/20261007_068_cobranca_assinatura.sql';
const ENV = { ASAAS_AMBIENTE: 'sandbox', ASAAS_API_KEY: '$aact_hmlg_chave_sintetica_de_teste_sem_valor', ASAAS_WEBHOOK_TOKEN: 'token-webhook-sintetico-de-teste-32+caracteres', ASSINATURA_PRECO_MENSAL_CENTAVOS: '9990' };
const PAGAS = ['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'];

let principal: Client;
const conexoes: Client[] = [];
const livres: Client[] = [];
const fila: Array<(c: Client) => void> = [];
const pegar = () => new Promise<Client>((ok) => { const c = livres.pop(); if (c) ok(c); else fila.push(ok); });
const devolver = (c: Client) => { const prox = fila.shift(); if (prox) prox(c); else livres.push(c); };
/** Transação numa conexão livre do "pool" de teste (como o withTransaction da aplicação). */
async function withTransaction<T>(trabalho: (tx: never) => Promise<T>): Promise<T> {
    const c = await pegar();
    try {
        await c.query('BEGIN');
        try {
            const r = await trabalho(c as never);
            await c.query('COMMIT');
            return r;
        }
        catch (error) {
            await c.query('ROLLBACK').catch(() => undefined);
            throw error;
        }
    }
    finally {
        devolver(c);
    }
}
const q = (sql: string, p: unknown[] = []) => principal.query(sql, p);

/** Provedor falso com botões de falha. Contagens permitem afirmar "sem duplicidade". */
class AsaasFalso implements ClienteAsaas {
    clientes = new Map<string, string>();
    assinaturas = new Map<string, AssinaturaProvedor>();
    cobrancas = new Map<string, CobrancaProvedor[]>();
    criadas = 0;
    removidas: string[] = [];
    atrasoCriacaoMs = 0;
    perderRespostaDaCriacao = false;
    falharListagensRestantes = 0;
    falharRemocao = false;
    depoisDeCriar: ((id: string) => Promise<void>) | null = null;
    /** POSTs de criação de assinatura recebidos (inclusive os que "perderam" a resposta). */
    postsCriacao = 0;
    /** Assinaturas que já existem mas ainda não aparecem na listagem (atraso de consistência do provedor). */
    ocultasNaListagem = new Set<string>();
    private seq = 0;
    /** Ids únicos por instância: as empresas de testes diferentes nunca compartilham ids do provedor. */
    private readonly prefixo = randomBytes(3).toString('hex');
    async buscarClientePorReferencia(ref: string) { const id = this.clientes.get(ref); return id ? { id, externalReference: ref } : null; }
    async criarCliente(i: { referencia: string }) { const id = `cus_${this.prefixo}_${++this.seq}`; this.clientes.set(i.referencia, id); return { id, externalReference: i.referencia }; }
    async obterAssinatura(id: string) { const a = this.assinaturas.get(id); return a && !a.deleted ? { ...a } : null; }
    async listarAssinaturasPorReferencia(ref: string) {
        if (this.falharListagensRestantes > 0) {
            this.falharListagensRestantes -= 1;
            throw new AsaasFalhou('listar assinaturas', null, 'TEMPO_ESGOTADO');
        }
        return [...this.assinaturas.values()].filter((a) => a.externalReference === ref && !a.deleted && !this.ocultasNaListagem.has(a.id)).map((a) => ({ ...a }));
    }
    criarDireto(cliente: string, ref: string) {
        this.criadas += 1;
        const id = `sub_${this.prefixo}_${++this.seq}`;
        this.assinaturas.set(id, { id, status: 'ACTIVE', deleted: false, cycle: 'MONTHLY', customer: cliente, externalReference: ref });
        this.cobrancas.set(id, [{ id: `pay_${id}`, status: 'PENDING', dueDate: '2026-10-20', paymentDate: null, invoiceUrl: `https://sandbox.asaas.com/i/pay_${id}`, deleted: false }]);
        return id;
    }
    async criarAssinatura(i: { cliente: string; referencia: string }) {
        this.postsCriacao += 1;
        if (this.atrasoCriacaoMs) await new Promise((ok) => setTimeout(ok, this.atrasoCriacaoMs));
        const id = this.criarDireto(i.cliente, i.referencia);
        if (this.depoisDeCriar) await this.depoisDeCriar(id);
        if (this.perderRespostaDaCriacao)
            throw new AsaasFalhou('criar assinatura', null, 'TEMPO_ESGOTADO');
        return { ...this.assinaturas.get(id)! };
    }
    async listarCobrancasDaAssinatura(id: string) { return (this.cobrancas.get(id) ?? []).map((c) => ({ ...c })); }
    async removerAssinatura(id: string) {
        if (this.falharRemocao)
            throw new AsaasFalhou('remover assinatura', null, 'REDE');
        const a = this.assinaturas.get(id);
        if (a) { a.deleted = true; this.removidas.push(id); this.cobrancas.set(id, (this.cobrancas.get(id) ?? []).filter((c) => PAGAS.includes(c.status))); }
        return { removida: true };
    }
    ativasDe(ref: string) { return [...this.assinaturas.values()].filter((a) => a.externalReference === ref && !a.deleted).map((a) => a.id); }
}

let usuario = '';
async function novaEmpresa() {
    const id = (await q("INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Buffet Contratação', 'PROVISIONAMENTO') RETURNING id", [`ct${randomBytes(4).toString('hex')}`])).rows[0].id as string;
    await q("UPDATE empresas SET status = 'ATIVA' WHERE id = $1", [id]);
    const cnpjBase = `9${String(Date.now()).slice(-7)}${String(Math.floor(Math.random() * 10_000)).padStart(4, '0')}`.slice(0, 12);
    const dv = (b: string) => { let s = 0, p = 2; for (let i = b.length - 1; i >= 0; i--) { s += (b.charCodeAt(i) - 48) * p; p = p === 9 ? 2 : p + 1; } const r = s % 11; return r <= 1 ? 0 : 11 - r; };
    const d1 = dv(cnpjBase), cnpj = `${cnpjBase}${d1}${dv(cnpjBase + d1)}`;
    await withTransaction((tx) => iniciarTeste(tx, { empresaId: id, documento: cnpj }));
    return id;
}
type Opcoes = { provedor: AsaasFalso; withTenant?: DepsCobranca['withTenantTransaction']; withTx?: DepsCobranca['withTransaction'] };
function deps(empresa: string, o: Opcoes): DepsCobranca {
    const tenant = { empresaComprovada: empresa, membershipId: 'm', usuarioId: usuario, papelAtual: 'REPRESENTANTE_AUTORIZADO' };
    const wt = o.withTx ?? withTransaction;
    return {
        withTenantTransaction: o.withTenant ?? ((_s, _e, t) => withTransaction((tx) => t(tx, tenant))),
        withTransaction: wt,
        travarContratacao: travaPorEmpresa(withTransaction),
        provedor: () => o.provedor,
        env: ENV,
    };
}
const sessao = () => ({ id: 's', usuario_id: usuario, nome: 'Gestão', cargo: null, papel: 'REPRESENTANTE_AUTORIZADO' as const, autenticado_em: '', expira_em: '', csrf_hash: '' });
const contratar = (empresa: string, d: DepsCobranca) => iniciarAssinatura(sessao(), null, { ciclo: 'MENSAL' }, { requestId: randomUUID() }, d);
const vinculo = async (empresa: string) => (await q('SELECT provedor_assinatura_id AS id FROM empresa_assinaturas WHERE empresa_id = $1', [empresa])).rows[0].id as string | null;
/** Pendências ABERTAS (PENDENTE/FALHOU); intenções de criação já confirmadas ficam PROCESSADO e não aparecem aqui. */
const pendencias = async (empresa: string) => (await q("SELECT id, evento_id, situacao, ultimo_erro, assinatura_provedor_id FROM cobranca_eventos WHERE empresa_id = $1 AND tipo = $2 AND situacao IN ('PENDENTE', 'FALHOU') ORDER BY recebido_em", [empresa, TIPO_PENDENCIA])).rows;
const intencoes = async (empresa: string) => (await q("SELECT situacao, ultimo_erro FROM cobranca_eventos WHERE empresa_id = $1 AND evento_id LIKE 'kidmais:criacao:%' ORDER BY recebido_em", [empresa])).rows.map((r) => [r.situacao, r.ultimo_erro]);
async function codigo(p: Promise<unknown>) {
    try { await p; return 'OK'; } catch (e) { return (e as { code?: string }).code ?? (e as Error).message; }
}
/** Tenant transaction que faz COMMIT e DEPOIS simula a conexão caindo (a resposta do COMMIT não chega). */
function commitSemResposta(empresa: string, chamadaAlvo: number) {
    let n = 0;
    const tenant = { empresaComprovada: empresa, membershipId: 'm', usuarioId: usuario, papelAtual: 'REPRESENTANTE_AUTORIZADO' };
    return (async (_s: unknown, _e: unknown, t: (tx: never, tn: typeof tenant) => Promise<unknown>) => {
        n += 1;
        const r = await withTransaction((tx) => t(tx, tenant));
        if (n === chamadaAlvo)
            throw Object.assign(new Error('Connection terminated unexpectedly'), { code: 'ECONNRESET' });
        return r;
    }) as DepsCobranca['withTenantTransaction'];
}
/** Tenant transaction que falha por comunicação ANTES do COMMIT (rollback) na chamada indicada. */
function quedaAntesDoCommit(empresa: string, chamadaAlvo: number) {
    let n = 0;
    const tenant = { empresaComprovada: empresa, membershipId: 'm', usuarioId: usuario, papelAtual: 'REPRESENTANTE_AUTORIZADO' };
    return (async (_s: unknown, _e: unknown, t: (tx: never, tn: typeof tenant) => Promise<unknown>) => {
        n += 1;
        return withTransaction(async (tx) => {
            const r = await t(tx, tenant);
            if (n === chamadaAlvo)
                throw Object.assign(new Error('Connection terminated unexpectedly'), { code: 'ECONNRESET' });
            return r;
        });
    }) as DepsCobranca['withTenantTransaction'];
}

test.before(async () => {
    principal = await conectarDescartavel();
    for (let i = 0; i < 6; i++) {
        const c = await conectarDescartavel({ travar: false });
        conexoes.push(c);
        livres.push(c);
    }
    await q(readFileSync(M067, 'utf8'));
    await q(readFileSync(M068, 'utf8'));
    usuario = (await q("INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Gestão Contratação', $2, 'ADMINISTRATIVO', true) RETURNING id",
        [`ct-${randomBytes(3).toString('hex')}@example.test`, `scrypt$v=1$N=131072$r=8$p=1$${'A'.repeat(22)}==$${'B'.repeat(86)}==`])).rows[0].id;
});
test.after(async () => {
    for (const c of conexoes) await encerrarDescartavel(c, false);
    if (principal) await encerrarDescartavel(principal);
});

test('duas contratações simultâneas da mesma empresa: uma assinatura no provedor; a outra recebe 409; a seguinte reaproveita', async () => {
    const empresa = await novaEmpresa();
    const provedor = new AsaasFalso();
    provedor.atrasoCriacaoMs = 400;
    const [r1, r2] = await Promise.allSettled([contratar(empresa, deps(empresa, { provedor })), contratar(empresa, deps(empresa, { provedor }))]);
    const ok = [r1, r2].filter((r) => r.status === 'fulfilled');
    const recusa = [r1, r2].find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
    assert.equal(ok.length, 1);
    assert.equal((recusa?.reason as { code?: string }).code, 'CONTRATACAO_EM_ANDAMENTO');
    assert.equal(provedor.criadas, 1, 'uma única assinatura criada no provedor');
    assert.equal(await vinculo(empresa), provedor.ativasDe(empresa)[0]);
    const terceira = await contratar(empresa, deps(empresa, { provedor })) as { reaproveitada: boolean; urlPagamento: string | null };
    assert.deepEqual([terceira.reaproveitada, provedor.criadas], [true, 1]);
    assert.ok(terceira.urlPagamento);
    assert.deepEqual(await pendencias(empresa), []);
    assert.deepEqual(await intencoes(empresa), [['PROCESSADO', 'CRIACAO_CONFIRMADA']], 'uma intenção, gravada antes do POST e fechada');
});

test('COMMIT confirmado no banco seguido de erro de comunicação: releitura confirma o vínculo, resposta normal, nada desfeito', async () => {
    const empresa = await novaEmpresa();
    const provedor = new AsaasFalso();
    // Chamadas de tenant: 1 = empresa comprovada, 2 = fase A, 3 = fase C (COMMIT feito, resposta perdida).
    const r = await contratar(empresa, deps(empresa, { provedor, withTenant: commitSemResposta(empresa, 3) })) as { urlPagamento: string | null; reaproveitada: boolean };
    assert.ok(r.urlPagamento, 'segue como sucesso');
    assert.equal(await vinculo(empresa), provedor.ativasDe(empresa)[0]);
    assert.deepEqual([provedor.criadas, provedor.removidas.length], [1, 0], 'nenhuma compensação');
    assert.deepEqual(await pendencias(empresa), [], 'nenhuma pendência: o resultado foi confirmado');
});

test('criação no provedor com resposta perdida: reencontrada pela referência e vinculada, sem duplicar', async () => {
    const empresa = await novaEmpresa();
    const provedor = new AsaasFalso();
    provedor.perderRespostaDaCriacao = true;
    const r = await contratar(empresa, deps(empresa, { provedor })) as { urlPagamento: string | null };
    assert.ok(r.urlPagamento);
    assert.deepEqual([provedor.criadas, provedor.ativasDe(empresa).length], [1, 1]);
    assert.equal(await vinculo(empresa), provedor.ativasDe(empresa)[0]);
    assert.deepEqual(await pendencias(empresa), []);
});

test('resposta perdida SEM como confirmar: pendência e resposta incerta; a retomada vincula a mesma assinatura e a pendência fecha sem excluir nada', async () => {
    const empresa = await novaEmpresa();
    const provedor = new AsaasFalso();
    provedor.perderRespostaDaCriacao = true;
    provedor.falharListagensRestantes = 0;
    // A listagem de retomada (antes de criar) funciona; a de confirmação (depois do tempo esgotado) falha.
    provedor.depoisDeCriar = async () => { provedor.falharListagensRestantes = 1; };
    assert.equal(await codigo(contratar(empresa, deps(empresa, { provedor }))), 'COBRANCA_RESULTADO_INCERTO');
    assert.equal(await vinculo(empresa), null);
    const [pend] = await pendencias(empresa);
    assert.deepEqual([pend.situacao, pend.ultimo_erro], ['PENDENTE', 'CRIACAO_SEM_RESPOSTA']);
    assert.equal(provedor.criadas, 1);
    // Retomada: a próxima contratação encontra a assinatura criada e só vincula.
    provedor.perderRespostaDaCriacao = false;
    provedor.depoisDeCriar = null;
    const r = await contratar(empresa, deps(empresa, { provedor })) as { reaproveitada: boolean };
    assert.deepEqual([r.reaproveitada, provedor.criadas], [true, 1], 'sem duplicidade');
    assert.equal(await vinculo(empresa), provedor.ativasDe(empresa)[0]);
    const resultado = await withTransaction((tx) => processarEvento(tx, pend.id, { provedor }));
    assert.deepEqual([resultado.situacao, resultado.motivo], ['PROCESSADO', 'NADA_A_FAZER']);
    assert.deepEqual(provedor.removidas, []);
});

test('queda antes do COMMIT com vínculo não confirmado: NADA é excluído; pendência COMMIT_INCERTO; a retomada vincula sem duplicar', async () => {
    const empresa = await novaEmpresa();
    const provedor = new AsaasFalso();
    assert.equal(await codigo(contratar(empresa, deps(empresa, { provedor, withTenant: quedaAntesDoCommit(empresa, 3) }))), 'COBRANCA_RESULTADO_INCERTO');
    assert.equal(await vinculo(empresa), null);
    assert.deepEqual([provedor.criadas, provedor.removidas.length, provedor.ativasDe(empresa).length], [1, 0, 1], 'a assinatura criada continua lá');
    const [pend] = await pendencias(empresa);
    assert.deepEqual([pend.situacao, pend.ultimo_erro, pend.assinatura_provedor_id], ['PENDENTE', 'COMMIT_INCERTO', provedor.ativasDe(empresa)[0]]);
    // A reconciliação sozinha também resolve: sem vínculo e exatamente uma ativa → vincula.
    const resultado = await withTransaction((tx) => processarEvento(tx, pend.id, { provedor }));
    assert.deepEqual([resultado.situacao, resultado.motivo], ['PROCESSADO', 'VINCULADA']);
    assert.equal(await vinculo(empresa), provedor.ativasDe(empresa)[0]);
    const r = await contratar(empresa, deps(empresa, { provedor })) as { reaproveitada: boolean };
    assert.deepEqual([r.reaproveitada, provedor.criadas], [true, 1]);
});

test('releitura do vínculo impossível: dúvida total → nada excluído, pendência registrada pela conexão que funcionar', async () => {
    const empresa = await novaEmpresa();
    const provedor = new AsaasFalso();
    // Transações comuns: 1 = pendências abertas, 2 = intenção, 3 = intenção confirmada, 4 = releitura do vínculo (falha).
    let n = 0;
    const withTx: DepsCobranca['withTransaction'] = (t) => {
        if (++n === 4) { return Promise.reject(Object.assign(new Error('Connection terminated'), { code: 'ECONNRESET' })); }
        return withTransaction(t);
    };
    assert.equal(await codigo(contratar(empresa, deps(empresa, { provedor, withTenant: quedaAntesDoCommit(empresa, 3), withTx }))), 'COBRANCA_RESULTADO_INCERTO');
    assert.deepEqual([provedor.removidas.length, provedor.ativasDe(empresa).length], [0, 1]);
    assert.deepEqual((await pendencias(empresa)).map((p) => p.ultimo_erro), ['VINCULO_DUVIDOSO']);
});

test('falha na compensação: duplicata confirmada pelo banco não é removida agora → pendência COMPENSACAO_FALHOU; a reconciliação remove depois', async () => {
    const empresa = await novaEmpresa();
    const provedor = new AsaasFalso();
    const cliente = (await provedor.criarCliente({ referencia: empresa })).id;
    // Outro escritor vincula OUTRA assinatura entre a criação e a gravação desta (estado confirmado no banco).
    provedor.depoisDeCriar = async () => {
        provedor.depoisDeCriar = null;
        const outra = provedor.criarDireto(cliente, `${empresa}-outra`);
        provedor.assinaturas.get(outra)!.externalReference = empresa;
        await q("UPDATE empresa_assinaturas SET provedor = 'ASAAS', provedor_cliente_id = $2, provedor_assinatura_id = $3 WHERE empresa_id = $1", [empresa, cliente, outra]);
    };
    provedor.falharRemocao = true;
    assert.equal(await codigo(contratar(empresa, deps(empresa, { provedor }))), 'CONFLITO');
    const vinculada = await vinculo(empresa);
    const duplicata = provedor.ativasDe(empresa).find((id) => id !== vinculada)!;
    assert.ok(duplicata, 'a duplicata continua ativa (remoção falhou)');
    const [pend] = await pendencias(empresa);
    assert.deepEqual([pend.situacao, pend.ultimo_erro, pend.assinatura_provedor_id], ['PENDENTE', 'COMPENSACAO_FALHOU', duplicata]);
    // Provedor ainda falhando: a pendência fica FALHOU (visível), não some.
    const tentativa = await withTransaction((tx) => processarEvento(tx, pend.id, { provedor }));
    assert.equal(tentativa.situacao, 'FALHOU');
    assert.match(String(tentativa.motivo), /PROVEDOR_INDISPONIVEL: remover assinatura/);
    provedor.falharRemocao = false;
    const resolvida = await withTransaction((tx) => processarEvento(tx, pend.id, { provedor }));
    assert.deepEqual([resolvida.situacao, resolvida.motivo], ['PROCESSADO', 'CONCILIADA']);
    assert.deepEqual([provedor.removidas, provedor.ativasDe(empresa)], [[duplicata], [vinculada]]);
    assert.equal(await vinculo(empresa), vinculada, 'o vínculo confirmado nunca é tocado');
});

test('duplicata com cobrança paga nunca é removida automaticamente: revisão humana', async () => {
    const empresa = await novaEmpresa();
    const provedor = new AsaasFalso();
    const cliente = (await provedor.criarCliente({ referencia: empresa })).id;
    const vinculada = provedor.criarDireto(cliente, empresa);
    const paga = provedor.criarDireto(cliente, empresa);
    provedor.cobrancas.get(paga)![0].status = 'RECEIVED';
    await q("UPDATE empresa_assinaturas SET provedor = 'ASAAS', provedor_cliente_id = $2, provedor_assinatura_id = $3 WHERE empresa_id = $1", [empresa, cliente, vinculada]);
    const pendId = await withTransaction(async (tx) => (await import('./reconciliacao-contratacao.ts')).registrarPendencia(tx, { empresaId: empresa, assinaturaId: paga, motivo: 'COMPENSACAO_FALHOU' }));
    const r = await withTransaction((tx) => processarEvento(tx, pendId, { provedor }));
    assert.deepEqual([r.situacao, r.motivo], ['FALHOU', 'REVISAO_HUMANA: DUPLICATA_COM_PAGAMENTO']);
    assert.deepEqual(provedor.removidas, []);
});

test('compensação imediata com pagamento: duplicata confirmada pelo banco mas já paga → NÃO é excluída; pendência COMPENSACAO_PRESERVADA; reconciliação pede revisão', async () => {
    const empresa = await novaEmpresa();
    const provedor = new AsaasFalso();
    const cliente = (await provedor.criarCliente({ referencia: empresa })).id;
    let nossa = '';
    // Outro escritor vincula OUTRA assinatura vigente; a nossa já recebeu um pagamento antes da gravação.
    provedor.depoisDeCriar = async (id) => {
        provedor.depoisDeCriar = null;
        nossa = id;
        provedor.cobrancas.get(id)![0].status = 'CONFIRMED';
        const outra = provedor.criarDireto(cliente, empresa);
        await q("UPDATE empresa_assinaturas SET provedor = 'ASAAS', provedor_cliente_id = $2, provedor_assinatura_id = $3 WHERE empresa_id = $1", [empresa, cliente, outra]);
    };
    assert.equal(await codigo(contratar(empresa, deps(empresa, { provedor }))), 'CONFLITO');
    assert.deepEqual(provedor.removidas, [], 'nenhuma exclusão: a candidata tem pagamento');
    assert.equal(provedor.ativasDe(empresa).length, 2);
    const [pend] = await pendencias(empresa);
    assert.deepEqual([pend.situacao, pend.ultimo_erro, pend.assinatura_provedor_id], ['PENDENTE', 'COMPENSACAO_PRESERVADA: CANDIDATA_COM_PAGAMENTO', nossa]);
    const vinculada = await vinculo(empresa);
    const r = await withTransaction((tx) => processarEvento(tx, pend.id, { provedor }));
    assert.deepEqual([r.situacao, r.motivo], ['FALHOU', 'REVISAO_HUMANA: DUPLICATA_COM_PAGAMENTO']);
    assert.deepEqual([provedor.removidas, await vinculo(empresa)], [[], vinculada]);
});

test('recontratação após cancelamento com resposta perdida: a referência antiga cancelada nunca justifica excluir a nova; a reconciliação vincula sem excluir', async () => {
    const empresa = await novaEmpresa();
    const provedor = new AsaasFalso();
    const cliente = (await provedor.criarCliente({ referencia: empresa })).id;
    const antiga = provedor.criarDireto(cliente, empresa);
    await provedor.removerAssinatura(antiga);
    provedor.removidas = [];
    await q(`UPDATE empresa_assinaturas SET provedor = 'ASAAS', provedor_cliente_id = $2, provedor_assinatura_id = $3, provedor_situacao = 'DELETED',
                    situacao = 'ENCERRADA', encerrada_em = clock_timestamp() WHERE empresa_id = $1`, [empresa, cliente, antiga]);
    // Recontratação: a resposta da criação se perde (reencontrada pela referência) e a gravação cai antes do COMMIT.
    provedor.perderRespostaDaCriacao = true;
    assert.equal(await codigo(contratar(empresa, deps(empresa, { provedor, withTenant: quedaAntesDoCommit(empresa, 3) }))), 'COBRANCA_RESULTADO_INCERTO');
    const [nova] = provedor.ativasDe(empresa);
    assert.ok(nova && nova !== antiga);
    assert.deepEqual([provedor.removidas, await vinculo(empresa)], [[], antiga], 'a nova continua no provedor; o banco ainda aponta a antiga');
    const [pend] = await pendencias(empresa);
    assert.deepEqual([pend.ultimo_erro, pend.assinatura_provedor_id], ['COMMIT_INCERTO', nova]);
    // Reconciliação: vínculo antigo não vigente + uma única ativa → vincula a nova; nada excluído.
    const r = await withTransaction((tx) => processarEvento(tx, pend.id, { provedor }));
    assert.deepEqual([r.situacao, r.motivo], ['PROCESSADO', 'VINCULADA']);
    assert.deepEqual([provedor.removidas, await vinculo(empresa), provedor.ativasDe(empresa)], [[], nova, [nova]]);
    // Retomada: reaproveita a nova, sem criar outra.
    provedor.perderRespostaDaCriacao = false;
    const retomada = await contratar(empresa, deps(empresa, { provedor })) as { reaproveitada: boolean };
    assert.deepEqual([retomada.reaproveitada, provedor.criadas, provedor.removidas], [true, 2, []]);
});

test('retomada com várias ativas: não escolhe a primeira, não cria nem exclui; pendência e revisão humana (inclusive com vínculo antigo cancelado)', async () => {
    const empresa = await novaEmpresa();
    const provedor = new AsaasFalso();
    const cliente = (await provedor.criarCliente({ referencia: empresa })).id;
    const s1 = provedor.criarDireto(cliente, empresa);
    const s2 = provedor.criarDireto(cliente, empresa);
    assert.equal(await codigo(contratar(empresa, deps(empresa, { provedor }))), 'COBRANCA_RESULTADO_INCERTO');
    assert.deepEqual([provedor.criadas, provedor.removidas, await vinculo(empresa)], [2, [], null], 'nada criado, nada excluído, nada vinculado');
    const [pend] = await pendencias(empresa);
    assert.deepEqual([pend.situacao, pend.ultimo_erro], ['PENDENTE', 'ASSINATURAS_AMBIGUAS']);
    const r = await withTransaction((tx) => processarEvento(tx, pend.id, { provedor }));
    assert.deepEqual([r.situacao, r.motivo], ['FALHOU', 'REVISAO_HUMANA: VARIAS_ASSINATURAS_SEM_VINCULO']);
    // O banco aponta uma assinatura antiga já cancelada: as duas ativas NÃO viram "duplicatas" dela.
    const antiga = provedor.criarDireto(cliente, empresa);
    await provedor.removerAssinatura(antiga);
    provedor.removidas = [];
    await q("UPDATE empresa_assinaturas SET provedor = 'ASAAS', provedor_cliente_id = $2, provedor_assinatura_id = $3, provedor_situacao = 'DELETED' WHERE empresa_id = $1", [empresa, cliente, antiga]);
    const r2 = await withTransaction((tx) => processarEvento(tx, pend.id, { provedor }));
    assert.deepEqual([r2.situacao, r2.motivo], ['FALHOU', 'REVISAO_HUMANA: VARIAS_ASSINATURAS_SEM_VINCULO']);
    assert.equal(await codigo(contratar(empresa, deps(empresa, { provedor }))), 'COBRANCA_RESULTADO_INCERTO');
    assert.deepEqual([provedor.criadas, provedor.removidas, provedor.ativasDe(empresa).sort()], [3, [], [s1, s2].sort()]);
    assert.equal(await vinculo(empresa), antiga);
});

test('POST com resposta perdida e listagem vazia: nova tentativa NÃO cria outra; a pendência fica aberta até a primeira aparecer; o provedor recebe UMA criação', async () => {
    const empresa = await novaEmpresa();
    const provedor = new AsaasFalso();
    let primeira = '';
    // 1º POST: o provedor cria, a resposta se perde e a assinatura ainda não aparece na listagem.
    provedor.perderRespostaDaCriacao = true;
    provedor.depoisDeCriar = async (id) => { primeira = id; provedor.ocultasNaListagem.add(id); };
    assert.equal(await codigo(contratar(empresa, deps(empresa, { provedor }))), 'COBRANCA_RESULTADO_INCERTO');
    assert.deepEqual([provedor.postsCriacao, await vinculo(empresa)], [1, null]);
    const [pend] = await pendencias(empresa);
    assert.deepEqual([pend.situacao, pend.ultimo_erro, pend.evento_id.startsWith('kidmais:criacao:')], ['PENDENTE', 'CRIACAO_SEM_RESPOSTA', true]);
    // Nova tentativa com a listagem ainda vazia: o provedor responderia normalmente, mas NÃO há outro POST.
    provedor.perderRespostaDaCriacao = false;
    provedor.depoisDeCriar = null;
    assert.equal(await codigo(contratar(empresa, deps(empresa, { provedor }))), 'COBRANCA_RESULTADO_INCERTO');
    assert.equal(provedor.postsCriacao, 1, 'listagem vazia não libera outro POST');
    // A reconciliação também não fecha a pendência com listagem vazia.
    const aguardando = await withTransaction((tx) => processarEvento(tx, pend.id, { provedor }));
    assert.deepEqual([aguardando.situacao, aguardando.motivo], ['FALHOU', 'AGUARDANDO_CONFIRMACAO: CRIACAO_NAO_CONFIRMADA']);
    assert.deepEqual((await pendencias(empresa)).map((x) => x.id), [pend.id], 'a mesma pendência continua aberta');
    assert.equal(await codigo(contratar(empresa, deps(empresa, { provedor }))), 'COBRANCA_RESULTADO_INCERTO');
    assert.equal(provedor.postsCriacao, 1);
    // Só agora a primeira assinatura aparece: a retomada a reaproveita, sem criar outra.
    provedor.ocultasNaListagem.clear();
    const r = await contratar(empresa, deps(empresa, { provedor })) as { reaproveitada: boolean; urlPagamento: string | null };
    assert.deepEqual([r.reaproveitada, Boolean(r.urlPagamento), await vinculo(empresa)], [true, true, primeira]);
    const fechada = await withTransaction((tx) => processarEvento(tx, pend.id, { provedor }));
    assert.deepEqual([fechada.situacao, fechada.motivo], ['PROCESSADO', 'NADA_A_FAZER']);
    assert.deepEqual([provedor.postsCriacao, provedor.criadas, provedor.ativasDe(empresa), provedor.removidas, await pendencias(empresa)], [1, 1, [primeira], [], []],
        'o provedor recebeu UMA criação; nada excluído; nenhuma pendência aberta');
});

test('processo cai logo depois do POST: a intenção prévia (CRIACAO_EM_CURSO) continua aberta e bloqueia outro POST enquanto a listagem estiver vazia', async () => {
    const empresa = await novaEmpresa();
    const provedor = new AsaasFalso();
    const cliente = (await provedor.criarCliente({ referencia: empresa })).id;
    // Estado deixado por um processo que gravou a intenção, fez o POST (o provedor criou) e morreu antes de anotar.
    const { registrarPendencia } = await import('./reconciliacao-contratacao.ts');
    await withTransaction((tx) => registrarPendencia(tx, { empresaId: empresa, assinaturaId: null, motivo: 'CRIACAO_EM_CURSO', operacao: 'criacao' }));
    const orfa = provedor.criarDireto(cliente, empresa);
    provedor.ocultasNaListagem.add(orfa);
    assert.equal(await codigo(contratar(empresa, deps(empresa, { provedor }))), 'COBRANCA_RESULTADO_INCERTO');
    assert.deepEqual([provedor.postsCriacao, await intencoes(empresa)], [0, [['PENDENTE', 'CRIACAO_EM_CURSO']]], 'nenhum POST: a operação anterior não foi resolvida');
    const [pend] = await pendencias(empresa);
    const espera = await withTransaction((tx) => processarEvento(tx, pend.id, { provedor }));
    assert.equal(espera.situacao, 'FALHOU');
    provedor.ocultasNaListagem.clear();
    const r = await withTransaction((tx) => processarEvento(tx, pend.id, { provedor }));
    assert.deepEqual([r.situacao, r.motivo, await vinculo(empresa)], ['PROCESSADO', 'VINCULADA', orfa]);
    const retomada = await contratar(empresa, deps(empresa, { provedor })) as { reaproveitada: boolean };
    assert.deepEqual([retomada.reaproveitada, provedor.postsCriacao, provedor.removidas, (await pendencias(empresa)).length], [true, 0, [], 0]);
});
