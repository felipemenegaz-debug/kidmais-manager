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
import { CONFIRMACAO_LIBERACAO, liberarIntencaoCriacao, MENSAGEM_BLOQUEIO_REMOCAO, pendenciasDaEmpresa } from './liberacao-intencao.ts';
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
const M063 = 'database/migrations/20261004_063_painel_desenvolvedor.sql';
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
    /** O POST de criação falha por tempo esgotado SEM criar nada (operação comprovadamente não executada). */
    falharAntesDeCriar = false;
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
        if (this.falharAntesDeCriar)
            throw new AsaasFalhou('criar assinatura', null, 'TEMPO_ESGOTADO');
        if (this.atrasoCriacaoMs) await new Promise((ok) => setTimeout(ok, this.atrasoCriacaoMs));
        const id = this.criarDireto(i.cliente, i.referencia);
        if (this.depoisDeCriar) await this.depoisDeCriar(id);
        if (this.perderRespostaDaCriacao)
            throw new AsaasFalhou('criar assinatura', null, 'TEMPO_ESGOTADO');
        return { ...this.assinaturas.get(id)! };
    }
    /** Assinaturas cuja listagem de cobranças falha (REDE): "a operação seguinte" falhando no meio da reconciliação. */
    falharCobrancasDe = new Set<string>();
    async listarCobrancasDaAssinatura(id: string) {
        if (this.falharCobrancasDe.has(id))
            throw new AsaasFalhou('listar cobranças', null, 'REDE');
        return (this.cobrancas.get(id) ?? []).map((c) => ({ ...c }));
    }
    /**
     * Exclusão: 'recusar' = 400 sem excluir (comprovadamente não executada); 'perderResposta' = exclui e a resposta se
     * perde; 'semConfirmar' = 200 sem `deleted` e nada excluído. `removidas` é a verdade do provedor; `chamadasRemocao`
     * conta os DELETEs recebidos.
     */
    modoRemocao: 'normal' | 'recusar' | 'perderResposta' | 'semConfirmar' = 'normal';
    chamadasRemocao = 0;
    /** Ganchos em volta do DELETE (antes de chegar ao provedor; depois de o provedor executar), para quedas e observação. */
    antesDeRemover: ((id: string) => Promise<void>) | null = null;
    depoisDeRemover: ((id: string) => Promise<void>) | null = null;
    async removerAssinatura(id: string) {
        this.chamadasRemocao += 1;
        if (this.antesDeRemover) await this.antesDeRemover(id);
        if (this.falharRemocao)
            throw new AsaasFalhou('remover assinatura', null, 'REDE');
        if (this.modoRemocao === 'recusar')
            throw new AsaasFalhou('remover assinatura', 400, 'HTTP');
        if (this.modoRemocao === 'semConfirmar')
            return { removida: false };
        const a = this.assinaturas.get(id);
        if (a) { a.deleted = true; this.removidas.push(id); this.cobrancas.set(id, (this.cobrancas.get(id) ?? []).filter((c) => PAGAS.includes(c.status))); }
        if (this.depoisDeRemover) await this.depoisDeRemover(id);
        if (this.modoRemocao === 'perderResposta')
            throw new AsaasFalhou('remover assinatura', null, 'TEMPO_ESGOTADO');
        return { removida: true };
    }
    ativasDe(ref: string) { return [...this.assinaturas.values()].filter((a) => a.externalReference === ref && !a.deleted).map((a) => a.id); }
}

let usuario = '';
let dev = '';
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
/** Auditorias de exclusão de duplicata da empresa, em ordem: [ação, removidas, confirmação]. */
const remocoesAuditadas = async (empresa: string) => (await q("SELECT acao, dados_depois FROM auditoria WHERE entidade_id = $1 AND acao IN ('ASSINATURA_DUPLICADA_REMOVIDA', 'ASSINATURA_REMOCAO_SEM_CONFIRMACAO') ORDER BY criado_em, id", [empresa])).rows
    .map((r) => [r.acao, r.dados_depois.removidas ?? null, r.dados_depois.confirmacao ?? null]);
const vinculo = async (empresa: string) => (await q('SELECT provedor_assinatura_id AS id FROM empresa_assinaturas WHERE empresa_id = $1', [empresa])).rows[0].id as string | null;
/** Pendências ABERTAS (PENDENTE/FALHOU); intenções de criação já confirmadas ficam PROCESSADO e não aparecem aqui. */
const pendencias = async (empresa: string) => (await q("SELECT id, evento_id, situacao, ultimo_erro, assinatura_provedor_id FROM cobranca_eventos WHERE empresa_id = $1 AND tipo = $2 AND situacao IN ('PENDENTE', 'FALHOU') ORDER BY recebido_em", [empresa, TIPO_PENDENCIA])).rows;
const idsConfirmados = async (empresa: string) => (await q("SELECT situacao, ultimo_erro FROM cobranca_eventos WHERE empresa_id = $1 AND evento_id LIKE 'kidmais:vinculo:%' ORDER BY recebido_em", [empresa])).rows.map((r) => [r.situacao, r.ultimo_erro]);
/**
 * Processo que MORRE ao entrar na fase C: a chamada de tenant de número `chamadaAlvo` falha e, a partir daí, nada mais
 * deste processo chega ao banco (nem releitura, nem pendência, nem encerramento).
 */
function processoQueMorre(empresa: string, chamadaAlvo: number) {
    let n = 0, morto = false;
    const tenant = { empresaComprovada: empresa, membershipId: 'm', usuarioId: usuario, papelAtual: 'REPRESENTANTE_AUTORIZADO' };
    const queda = () => Object.assign(new Error('processo encerrado (simulado)'), { code: 'ECONNRESET' });
    const withTenant = ((_s: unknown, _e: unknown, t: (tx: never, tn: typeof tenant) => Promise<unknown>) => {
        n += 1;
        if (morto || n === chamadaAlvo) { morto = true; return Promise.reject(queda()); }
        return withTransaction((tx) => t(tx, tenant));
    }) as DepsCobranca['withTenantTransaction'];
    const withTx: DepsCobranca['withTransaction'] = (t) => morto ? Promise.reject(queda()) : withTransaction(t);
    return { withTenant, withTx };
}
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
    if (!(await q("SELECT to_regclass('public.plataforma_desenvolvedores') IS NOT NULL AS ok")).rows[0].ok)
        await q(readFileSync(M063, 'utf8'));
    usuario = (await q("INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Gestão Contratação', $2, 'ADMINISTRATIVO', true) RETURNING id",
        [`ct-${randomBytes(3).toString('hex')}@example.test`, `scrypt$v=1$N=131072$r=8$p=1$${'A'.repeat(22)}==$${'B'.repeat(86)}==`])).rows[0].id;
    dev = (await q("INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Dev Contratação', $2, 'ADMINISTRATIVO', true) RETURNING id",
        [`dev-${randomBytes(3).toString('hex')}@example.test`, `scrypt$v=1$N=131072$r=8$p=1$${'A'.repeat(22)}==$${'B'.repeat(86)}==`])).rows[0].id;
    await q("INSERT INTO plataforma_desenvolvedores (usuario_id, concedido_por, motivo) VALUES ($1, 'teste-sintetico', 'concessão sintética de teste')", [dev]);
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
    assert.deepEqual(await intencoes(empresa), [['PROCESSADO', 'VINCULADA']], 'uma intenção, gravada antes do POST e encerrada junto com o vínculo');
    assert.deepEqual(await idsConfirmados(empresa), [['PROCESSADO', 'VINCULADA']], 'o id confirmado também, na mesma transação do vínculo');
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
    const resultado = await withTransaction((tx) => processarEvento(tx, pend.id, { provedor, transacaoIndependente: withTransaction }));
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
    const resultado = await withTransaction((tx) => processarEvento(tx, pend.id, { provedor, transacaoIndependente: withTransaction }));
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

test('falha na compensação (recusa 4xx, comprovadamente não executada): pendência COMPENSACAO_FALHOU; a reconciliação remove depois', async () => {
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
    provedor.modoRemocao = 'recusar';
    assert.equal(await codigo(contratar(empresa, deps(empresa, { provedor }))), 'CONFLITO');
    const vinculada = await vinculo(empresa);
    const duplicata = provedor.ativasDe(empresa).find((id) => id !== vinculada)!;
    assert.ok(duplicata, 'a duplicata continua ativa (remoção recusada)');
    assert.deepEqual((await marcadores(empresa)).map((m) => [m.situacao, m.ultimo_erro]), [['PROCESSADO', 'REMOCAO_RECUSADA']], 'marcador prévio fechado: resultado conhecido');
    const [pend] = await pendencias(empresa);
    assert.deepEqual([pend.situacao, pend.ultimo_erro, pend.assinatura_provedor_id], ['PENDENTE', 'COMPENSACAO_FALHOU', duplicata]);
    // Provedor recusando a exclusão (4xx: comprovadamente não executada): a pendência fica FALHOU (visível), não some,
    // e pode ser tentada de novo. (Resultado DESCONHECIDO nunca é repetido: ver os testes de exclusão sem confirmação.)
    const tentativa = await withTransaction((tx) => processarEvento(tx, pend.id, { provedor, transacaoIndependente: withTransaction }));
    assert.equal(tentativa.situacao, 'FALHOU');
    assert.match(String(tentativa.motivo), /PROVEDOR_INDISPONIVEL: remover assinatura \(400\)/);
    assert.deepEqual(await remocoesAuditadas(empresa), [], 'recusa: nada registrado como excluído');
    provedor.modoRemocao = 'normal';
    const resolvida = await withTransaction((tx) => processarEvento(tx, pend.id, { provedor, transacaoIndependente: withTransaction }));
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
    const r = await withTransaction((tx) => processarEvento(tx, pendId, { provedor, transacaoIndependente: withTransaction }));
    assert.deepEqual([r.situacao, r.motivo], ['FALHOU', 'REVISAO_HUMANA: DUPLICATA_COM_PAGAMENTO']);
    assert.deepEqual(provedor.removidas, []);
});

/** Empresa com vínculo vigente e duplicatas só com cobrança em aberto (a decisão central manda excluir cada uma). */
async function comDuplicatas<P extends AsaasFalso = AsaasFalso>(n: number, provedor: P = new AsaasFalso() as P) {
    const empresa = await novaEmpresa();
    const cliente = (await provedor.criarCliente({ referencia: empresa })).id;
    const vinculada = provedor.criarDireto(cliente, empresa);
    const duplicatas = Array.from({ length: n }, () => provedor.criarDireto(cliente, empresa));
    await q("UPDATE empresa_assinaturas SET provedor = 'ASAAS', provedor_cliente_id = $2, provedor_assinatura_id = $3 WHERE empresa_id = $1", [empresa, cliente, vinculada]);
    const pendId = await withTransaction(async (tx) => (await import('./reconciliacao-contratacao.ts')).registrarPendencia(tx, { empresaId: empresa, assinaturaId: duplicatas[0], motivo: 'COMPENSACAO_FALHOU' }));
    return { empresa, provedor, vinculada, duplicatas, pendId };
}
const marcadores = async (empresa: string) => (await q("SELECT id, situacao, ultimo_erro, assinatura_provedor_id FROM cobranca_eventos WHERE empresa_id = $1 AND evento_id LIKE 'kidmais:remocao:%' ORDER BY recebido_em", [empresa])).rows;

test('reconciliação: 1ª exclusão confirmada e a operação seguinte falha → a exclusão fica auditada; a nova tentativa não exclui de novo', async () => {
    const { empresa, provedor, vinculada, duplicatas: [d1, d2], pendId } = await comDuplicatas(2);
    provedor.falharCobrancasDe.add(d2);
    const r = await withTransaction((tx) => processarEvento(tx, pendId, { provedor, transacaoIndependente: withTransaction }));
    assert.equal(r.situacao, 'FALHOU');
    assert.match(String(r.motivo), /^PROVEDOR_INDISPONIVEL: listar cobranças/);
    assert.deepEqual([provedor.removidas, provedor.chamadasRemocao], [[d1], 1], 'o provedor excluiu d1 antes da falha');
    assert.deepEqual(await remocoesAuditadas(empresa), [['ASSINATURA_DUPLICADA_REMOVIDA', 1, 'RESPOSTA_DO_PROVEDOR']], 'a exclusão confirmada sobrevive ao SAVEPOINT desfeito');
    assert.deepEqual((await marcadores(empresa)).map((m) => [m.situacao, m.ultimo_erro]), [['PROCESSADO', 'REMOCAO_CONFIRMADA']], 'confirmada: o marcador prévio fecha; não vira resultado desconhecido');
    provedor.falharCobrancasDe.clear();
    const depois = await withTransaction((tx) => processarEvento(tx, pendId, { provedor, transacaoIndependente: withTransaction }));
    assert.deepEqual([depois.situacao, depois.motivo], ['PROCESSADO', 'CONCILIADA']);
    assert.deepEqual([provedor.removidas, provedor.chamadasRemocao, provedor.ativasDe(empresa)], [[d1, d2], 2, [vinculada]], 'd1 não recebeu outro DELETE');
    assert.deepEqual(await remocoesAuditadas(empresa), [['ASSINATURA_DUPLICADA_REMOVIDA', 1, 'RESPOSTA_DO_PROVEDOR'], ['ASSINATURA_DUPLICADA_REMOVIDA', 1, 'RESPOSTA_DO_PROVEDOR']]);
});

test('reconciliação: resposta perdida na exclusão → resultado desconhecido (não conta como excluída), marcador e auditoria próprios; a releitura confirma sem repetir o DELETE', async () => {
    const { empresa, provedor, vinculada, duplicatas: [d1], pendId } = await comDuplicatas(1);
    provedor.modoRemocao = 'perderResposta';
    const r = await withTransaction((tx) => processarEvento(tx, pendId, { provedor, transacaoIndependente: withTransaction }));
    assert.deepEqual([r.situacao, r.motivo], ['FALHOU', 'REVISAO_HUMANA: REMOCAO_SEM_CONFIRMACAO']);
    assert.deepEqual(await remocoesAuditadas(empresa), [['ASSINATURA_REMOCAO_SEM_CONFIRMACAO', null, null]], 'sem ASSINATURA_DUPLICADA_REMOVIDA: não é sucesso confirmado');
    const [m] = await marcadores(empresa);
    assert.deepEqual([m.situacao, m.ultimo_erro, m.assinatura_provedor_id], ['PENDENTE', 'REMOCAO_SEM_CONFIRMACAO', d1]);
    // Provedor de volta ao normal: a reconciliação só RELÊ pelo id; d1 está removida → confirmada pela releitura.
    provedor.modoRemocao = 'normal';
    const depois = await withTransaction((tx) => processarEvento(tx, pendId, { provedor, transacaoIndependente: withTransaction }));
    assert.deepEqual([depois.situacao, depois.motivo], ['PROCESSADO', 'NADA_A_FAZER']);
    assert.equal(provedor.chamadasRemocao, 1, 'nenhum DELETE repetido');
    assert.deepEqual(await remocoesAuditadas(empresa), [['ASSINATURA_REMOCAO_SEM_CONFIRMACAO', null, null], ['ASSINATURA_DUPLICADA_REMOVIDA', 1, 'RELEITURA']]);
    assert.deepEqual((await marcadores(empresa)).map((x) => [x.situacao, x.ultimo_erro]), [['PROCESSADO', 'REMOCAO_CONFIRMADA_NA_RELEITURA']]);
    assert.deepEqual([provedor.ativasDe(empresa), await vinculo(empresa), await pendencias(empresa)], [[vinculada], vinculada, []]);
});

test('reconciliação: exclusão sem confirmação que NÃO aconteceu nunca é repetida; fica em revisão humana até a releitura mostrar a assinatura removida', async () => {
    const { empresa, provedor, vinculada, duplicatas: [d1], pendId } = await comDuplicatas(1);
    provedor.modoRemocao = 'semConfirmar';
    const r = await withTransaction((tx) => processarEvento(tx, pendId, { provedor, transacaoIndependente: withTransaction }));
    assert.deepEqual([r.situacao, r.motivo], ['FALHOU', 'REVISAO_HUMANA: REMOCAO_SEM_CONFIRMACAO']);
    assert.deepEqual([provedor.removidas, provedor.chamadasRemocao], [[], 1]);
    provedor.modoRemocao = 'normal';
    // Nem a pendência original nem o próprio marcador disparam outro DELETE: d1 continua ativa → revisão humana.
    const [m] = await marcadores(empresa);
    for (const id of [pendId, m.id]) {
        const t = await withTransaction((tx) => processarEvento(tx, id, { provedor, transacaoIndependente: withTransaction }));
        assert.deepEqual([t.situacao, t.motivo], ['FALHOU', 'REVISAO_HUMANA: REMOCAO_SEM_CONFIRMACAO']);
    }
    assert.deepEqual([provedor.chamadasRemocao, provedor.ativasDe(empresa)], [1, [vinculada, d1]]);
    assert.deepEqual(await remocoesAuditadas(empresa), [['ASSINATURA_REMOCAO_SEM_CONFIRMACAO', null, null]]);
    // Uma pessoa exclui no painel do Asaas: o marcador fecha pela releitura, com a exclusão auditada uma única vez.
    provedor.assinaturas.get(d1)!.deleted = true;
    const fechado = await withTransaction((tx) => processarEvento(tx, m.id, { provedor, transacaoIndependente: withTransaction }));
    assert.deepEqual([fechado.situacao, fechado.motivo], ['PROCESSADO', 'REMOCAO_CONFIRMADA_NA_RELEITURA']);
    assert.equal(provedor.chamadasRemocao, 1);
    assert.deepEqual(await remocoesAuditadas(empresa), [['ASSINATURA_REMOCAO_SEM_CONFIRMACAO', null, null], ['ASSINATURA_DUPLICADA_REMOVIDA', 1, 'RELEITURA']]);
});

/** Contratação em que outro escritor vincula OUTRA assinatura entre a criação e a gravação: a criada vira duplicata e a decisão central manda excluí-la. */
function contratacaoComDuplicata(empresa: string, provedor: AsaasFalso, cliente: string) {
    provedor.depoisDeCriar = async () => {
        provedor.depoisDeCriar = null;
        const outra = provedor.criarDireto(cliente, `${empresa}-outra`);
        provedor.assinaturas.get(outra)!.externalReference = empresa;
        await q("UPDATE empresa_assinaturas SET provedor = 'ASAAS', provedor_cliente_id = $2, provedor_assinatura_id = $3 WHERE empresa_id = $1", [empresa, cliente, outra]);
    };
}
async function cenarioCompensacao() {
    const empresa = await novaEmpresa();
    const provedor = new AsaasFalso();
    const cliente = (await provedor.criarCliente({ referencia: empresa })).id;
    contratacaoComDuplicata(empresa, provedor, cliente);
    return { empresa, provedor };
}
/** withTransaction cujas consultas com o parâmetro `marca` falham (banco indisponível naquele instante). */
function falhandoCom(marca: string): DepsCobranca['withTransaction'] {
    return ((trabalho: (tx: never) => Promise<unknown>) => withTransaction((tx) => trabalho({
        query: (sql: string, p: unknown[] = []) => (p.includes(marca)
            ? Promise.reject(Object.assign(new Error('falha simulada do banco'), { code: '08006' }))
            : (tx as unknown as Client).query(sql, p)),
    } as never))) as DepsCobranca['withTransaction'];
}
const encerradas = async (empresa: string) => (await q("SELECT ultimo_erro FROM cobranca_eventos WHERE empresa_id = $1 AND tipo = $2 AND situacao = 'PROCESSADO' AND evento_id NOT LIKE 'kidmais:remocao:%' ORDER BY ultimo_erro", [empresa, TIPO_PENDENCIA])).rows.map((r) => r.ultimo_erro);

test('contratação, compensação confirmada: marcador gravado ANTES do DELETE e fechado; exclusão auditada pela resposta do provedor', async () => {
    const { empresa, provedor } = await cenarioCompensacao();
    assert.equal(await codigo(contratar(empresa, deps(empresa, { provedor }))), 'CONFLITO');
    const vinculada = await vinculo(empresa);
    assert.deepEqual([provedor.chamadasRemocao, provedor.removidas.length, provedor.ativasDe(empresa)], [1, 1, [vinculada]]);
    assert.deepEqual((await marcadores(empresa)).map((m) => [m.situacao, m.ultimo_erro]), [['PROCESSADO', 'REMOCAO_CONFIRMADA']]);
    assert.deepEqual(await remocoesAuditadas(empresa), [['ASSINATURA_DUPLICADA_REMOVIDA', 1, 'RESPOSTA_DO_PROVEDOR']]);
    assert.deepEqual(await pendencias(empresa), [], 'pendências da operação encerradas');
});

test('contratação, exclusão realizada com resposta perdida: sem sucesso registrado; marcador aberto; a reconciliação confirma pela releitura sem repetir o DELETE', async () => {
    const { empresa, provedor } = await cenarioCompensacao();
    provedor.modoRemocao = 'perderResposta';
    assert.equal(await codigo(contratar(empresa, deps(empresa, { provedor }))), 'CONFLITO');
    const vinculada = await vinculo(empresa);
    const [duplicata] = provedor.removidas;
    assert.deepEqual([provedor.chamadasRemocao, provedor.ativasDe(empresa)], [1, [vinculada]], 'o provedor excluiu, mas a resposta se perdeu');
    assert.deepEqual(await remocoesAuditadas(empresa), [['ASSINATURA_REMOCAO_SEM_CONFIRMACAO', null, null]], 'nenhuma auditoria de removida');
    const [m] = await marcadores(empresa);
    assert.deepEqual([m.situacao, m.ultimo_erro, m.assinatura_provedor_id], ['PENDENTE', 'REMOCAO_SEM_CONFIRMACAO', duplicata]);
    assert.deepEqual((await pendencias(empresa)).map((p) => p.id), [m.id], 'só o marcador: nenhuma COMPENSACAO_FALHOU que levaria a outro DELETE');
    assert.ok(!(await encerradas(empresa)).includes('COMPENSADA'), 'a operação não foi encerrada como compensada');
    provedor.modoRemocao = 'normal';
    const r = await withTransaction((tx) => processarEvento(tx, m.id, { provedor, transacaoIndependente: withTransaction }));
    assert.deepEqual([r.situacao, r.motivo], ['PROCESSADO', 'REMOCAO_CONFIRMADA_NA_RELEITURA']);
    assert.equal(provedor.chamadasRemocao, 1, 'nenhum DELETE repetido');
    assert.deepEqual(await remocoesAuditadas(empresa), [['ASSINATURA_REMOCAO_SEM_CONFIRMACAO', null, null], ['ASSINATURA_DUPLICADA_REMOVIDA', 1, 'RELEITURA']]);
    assert.deepEqual(await pendencias(empresa), []);
});

test('contratação, resposta sem confirmação e assinatura ainda existente: nada registrado como sucesso; a reconciliação posterior nunca repete o DELETE', async () => {
    const { empresa, provedor } = await cenarioCompensacao();
    provedor.modoRemocao = 'semConfirmar';
    assert.equal(await codigo(contratar(empresa, deps(empresa, { provedor }))), 'CONFLITO');
    const vinculada = await vinculo(empresa);
    const duplicata = provedor.ativasDe(empresa).find((id) => id !== vinculada)!;
    assert.ok(duplicata, 'a duplicata continua no provedor');
    assert.deepEqual([provedor.chamadasRemocao, provedor.removidas], [1, []]);
    assert.deepEqual(await remocoesAuditadas(empresa), [['ASSINATURA_REMOCAO_SEM_CONFIRMACAO', null, null]], 'resposta sem confirmação não é sucesso');
    assert.ok(!(await encerradas(empresa)).includes('COMPENSADA'));
    const [m] = await marcadores(empresa);
    assert.deepEqual([m.situacao, m.ultimo_erro, m.assinatura_provedor_id], ['PENDENTE', 'REMOCAO_SEM_CONFIRMACAO', duplicata]);
    provedor.modoRemocao = 'normal';
    const r = await withTransaction((tx) => processarEvento(tx, m.id, { provedor, transacaoIndependente: withTransaction }));
    assert.deepEqual([r.situacao, r.motivo], ['FALHOU', 'REVISAO_HUMANA: REMOCAO_SEM_CONFIRMACAO']);
    assert.deepEqual([provedor.chamadasRemocao, provedor.ativasDe(empresa).sort()], [1, [vinculada, duplicata].sort()], 'nenhum DELETE repetido; a duplicata fica para revisão');
    assert.deepEqual(await remocoesAuditadas(empresa), [['ASSINATURA_REMOCAO_SEM_CONFIRMACAO', null, null]]);
});

test('contratação, falha ao gravar o marcador: o DELETE não acontece; pendência COMPENSACAO_FALHOU (nada executado) e a reconciliação decide depois', async () => {
    const { empresa, provedor } = await cenarioCompensacao();
    assert.equal(await codigo(contratar(empresa, deps(empresa, { provedor, withTx: falhandoCom('REMOCAO_EM_CURSO') }))), 'CONFLITO');
    const vinculada = await vinculo(empresa);
    assert.deepEqual([provedor.chamadasRemocao, provedor.ativasDe(empresa).length, await marcadores(empresa)], [0, 2, []], 'sem marcador, sem DELETE');
    const [pend] = await pendencias(empresa);
    assert.equal(pend.ultimo_erro, 'COMPENSACAO_FALHOU');
    const r = await withTransaction((tx) => processarEvento(tx, pend.id, { provedor, transacaoIndependente: withTransaction }));
    assert.deepEqual([r.situacao, r.motivo, provedor.chamadasRemocao, provedor.ativasDe(empresa)], ['PROCESSADO', 'CONCILIADA', 1, [vinculada]]);
    assert.deepEqual(await remocoesAuditadas(empresa), [['ASSINATURA_DUPLICADA_REMOVIDA', 1, 'RESPOSTA_DO_PROVEDOR']]);
});

test('contratação, interrupção entre o DELETE e a gravação do resultado: o marcador prévio continua aberto; a reconciliação relê e confirma, sem repetir o DELETE', async () => {
    const { empresa, provedor } = await cenarioCompensacao();
    // O DELETE é confirmado pelo provedor, mas a gravação do resultado não chega ao banco.
    assert.equal(await codigo(contratar(empresa, deps(empresa, { provedor, withTx: falhandoCom('REMOCAO_CONFIRMADA') }))), 'CONFLITO');
    const vinculada = await vinculo(empresa);
    assert.deepEqual([provedor.chamadasRemocao, provedor.ativasDe(empresa)], [1, [vinculada]]);
    assert.deepEqual(await remocoesAuditadas(empresa), [], 'o resultado não foi gravado');
    const [m] = await marcadores(empresa);
    assert.deepEqual([m.situacao, m.ultimo_erro], ['PENDENTE', 'REMOCAO_EM_CURSO']);
    // Todas as pendências abertas da empresa (marcador, intenção, id confirmado) são processadas: nenhuma repete o DELETE.
    for (const p of await pendencias(empresa))
        await withTransaction((tx) => processarEvento(tx, p.id, { provedor, transacaoIndependente: withTransaction }));
    assert.equal(provedor.chamadasRemocao, 1);
    assert.deepEqual((await marcadores(empresa)).map((x) => [x.situacao, x.ultimo_erro]), [['PROCESSADO', 'REMOCAO_CONFIRMADA_NA_RELEITURA']]);
    assert.deepEqual(await remocoesAuditadas(empresa), [['ASSINATURA_DUPLICADA_REMOVIDA', 1, 'RELEITURA']], 'a exclusão fica registrada uma vez');
});

test('liberação manual bloqueada por marcador de exclusão: mensagem explícita, sem atalho; o painel mostra o motivo e não oferece liberar', async () => {
    const empresa = await novaEmpresa();
    const recon = await import('./reconciliacao-contratacao.ts');
    const intencao = await withTransaction((tx) => recon.registrarPendencia(tx, { empresaId: empresa, assinaturaId: null, motivo: 'CRIACAO_EM_CURSO', operacao: 'criacao' }));
    const marcador = await withTransaction((tx) => recon.abrirMarcadorRemocao(tx, empresa, 'sub_marcador_teste', 'REMOCAO_SEM_CONFIRMACAO'));
    let mensagem = '';
    try {
        await withTransaction((tx) => liberarIntencaoCriacao(tx, { usuario_id: dev }, empresa,
            { pendenciaId: intencao, motivo: 'Conferido no painel do Asaas: nenhuma assinatura criada', confirmacao: CONFIRMACAO_LIBERACAO },
            { listarAssinaturasPorReferencia: async () => [] }, { requestId: randomUUID() }));
    }
    catch (e) { mensagem = (e as Error).message; }
    assert.equal(mensagem, MENSAGEM_BLOQUEIO_REMOCAO);
    assert.deepEqual((await pendencias(empresa)).map((p) => p.id).sort(), [intencao, marcador].sort(), 'nada liberado nem fechado');
    const lista = await withTransaction((tx) => pendenciasDaEmpresa(tx, { usuario_id: dev }, empresa));
    const deIntencao = lista.find((p) => p.id === intencao)!;
    const doMarcador = lista.find((p) => p.id === marcador)!;
    assert.deepEqual([deIntencao.tipo, deIntencao.liberavel, deIntencao.bloqueadaPor], ['INTENCAO_CRIACAO', false, 'REMOCAO_SEM_CONFIRMACAO']);
    assert.deepEqual([doMarcador.tipo, doMarcador.liberavel, doMarcador.motivo], ['REMOCAO_SEM_CONFIRMACAO', false, 'REMOCAO_SEM_CONFIRMACAO']);
});

// --- Marcador confirmado no banco ANTES do DELETE, também na reconciliação (transação independente, conexões reais) ---

type Independente = NonNullable<Parameters<typeof processarEvento>[2]['transacaoIndependente']>;
const independenteReal = withTransaction as unknown as Independente;
/** Transação independente real (outra conexão) que deixa de existir quando o "processo cai". */
function independenteQueCai() {
    const estado = { caiu: false };
    const tx = (<T,>(trabalho: (t: never) => Promise<T>) => (estado.caiu ? Promise.reject(new Error('processo encerrado (simulado)')) : withTransaction(trabalho))) as unknown as Independente;
    return { estado, tx };
}
/**
 * Processamento numa conexão PRÓPRIA (fora do "pool" de teste): pode ser encerrada pelo servidor (pg_terminate_backend)
 * no meio, como uma queda real; a transação dela é desfeita pelo PostgreSQL.
 */
async function conexaoDeProcessamento() {
    const c = await conectarDescartavel({ travar: false });
    c.on('error', () => undefined);
    const pid = (await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
    const processar = async (id: string, d: Parameters<typeof processarEvento>[2], antes?: string) => {
        try {
            await c.query('BEGIN');
            if (antes) await c.query(antes);
            const r = await processarEvento(c as never, id, d);
            await c.query('COMMIT');
            return { ok: true as const, r };
        }
        catch (erro) {
            await c.query('ROLLBACK').catch(() => undefined);
            return { ok: false as const, erro: erro as Error };
        }
        finally {
            await c.end().catch(() => undefined);
        }
    };
    return { pid, processar };
}
const encerrarProcesso = (pid: number) => q('SELECT pg_terminate_backend($1)', [pid]);
const situacaoDo = async (id: string) => (await q('SELECT situacao, tentativas, ultimo_erro FROM cobranca_eventos WHERE id = $1', [id])).rows[0];

test('reconciliação: o marcador está CONFIRMADO no banco (visível a outra conexão) antes do DELETE, com a transação do processamento ainda aberta e travando a linha', async () => {
    const { empresa, provedor, vinculada, duplicatas: [d1], pendId } = await comDuplicatas(1);
    const visto: Array<unknown> = [];
    provedor.antesDeRemover = async (id) => {
        visto.push((await marcadores(empresa)).map((m) => [m.situacao, m.ultimo_erro, m.assinatura_provedor_id]));
        // A linha da assinatura continua travada pela transação do processamento (não confirmada ainda).
        visto.push(await q('SELECT 1 FROM empresa_assinaturas WHERE empresa_id = $1 FOR UPDATE NOWAIT', [empresa]).then(() => 'livre', (e: { code?: string }) => e.code));
        visto.push(id);
    };
    const r = await withTransaction((tx) => processarEvento(tx, pendId, { provedor, transacaoIndependente: independenteReal }));
    assert.deepEqual(visto, [[['PENDENTE', 'REMOCAO_EM_CURSO', d1]], '55P03', d1]);
    assert.deepEqual([r.situacao, r.motivo, provedor.ativasDe(empresa)], ['PROCESSADO', 'CONCILIADA', [vinculada]]);
    assert.deepEqual((await marcadores(empresa)).map((m) => [m.situacao, m.ultimo_erro]), [['PROCESSADO', 'REMOCAO_CONFIRMADA']]);
    assert.deepEqual(await remocoesAuditadas(empresa), [['ASSINATURA_DUPLICADA_REMOVIDA', 1, 'RESPOSTA_DO_PROVEDOR']]);
});

test('reconciliação: lock real disputado com a transação do processamento → o marcador não é gravado (lock_timeout) e o DELETE não acontece; nada trava', async () => {
    const { empresa, provedor, pendId } = await comDuplicatas(1);
    const conexao = await conexaoDeProcessamento();
    const inicio = Date.now();
    // A própria transação do processamento segura um lock que impede o INSERT do marcador na outra conexão.
    const fim = await conexao.processar(pendId, { provedor, transacaoIndependente: independenteReal }, 'LOCK TABLE cobranca_eventos IN SHARE MODE');
    const ms = Date.now() - inicio;
    assert.ok(fim.ok, String(!fim.ok && fim.erro));
    assert.deepEqual([fim.ok && fim.r.situacao, fim.ok && fim.r.motivo], ['FALHOU', 'ADIADA: MARCADOR_NAO_GRAVADO']);
    assert.ok(ms >= 2500 && ms < 9000, `esperou o lock_timeout (3 s) e não travou: ${ms} ms`);
    assert.deepEqual([provedor.chamadasRemocao, await marcadores(empresa), await remocoesAuditadas(empresa)], [0, [], []]);
    // Sem disputa, a nova tentativa grava o marcador e exclui.
    const r = await withTransaction((tx) => processarEvento(tx, pendId, { provedor, transacaoIndependente: independenteReal }));
    assert.deepEqual([r.situacao, r.motivo, provedor.chamadasRemocao], ['PROCESSADO', 'CONCILIADA', 1]);
});

test('reconciliação: falha ao gravar o marcador (simulada) ou sem transação independente → ADIADA, nenhum DELETE', async () => {
    const { empresa, provedor, pendId } = await comDuplicatas(1);
    const quebrada = (() => Promise.reject(new Error('banco indisponível (simulado)'))) as unknown as Independente;
    for (const d of [{ provedor, transacaoIndependente: quebrada }, { provedor }]) {
        const r = await withTransaction((tx) => processarEvento(tx, pendId, d));
        assert.deepEqual([r.situacao, r.motivo], ['FALHOU', 'ADIADA: MARCADOR_NAO_GRAVADO']);
    }
    assert.deepEqual([provedor.chamadasRemocao, await marcadores(empresa), (await situacaoDo(pendId)).situacao], [0, [], 'FALHOU']);
});

test('reconciliação: queda REAL depois de gravar o marcador e antes do DELETE → o marcador sobrevive; a recuperação só relê e mantém revisão (nenhum DELETE)', async () => {
    const { empresa, provedor, duplicatas: [d1], pendId } = await comDuplicatas(1);
    const antes = await situacaoDo(pendId);
    const conexao = await conexaoDeProcessamento();
    const queda = independenteQueCai();
    provedor.antesDeRemover = async () => {
        queda.estado.caiu = true;
        await encerrarProcesso(conexao.pid);
        throw new Error('processo encerrado antes do DELETE');
    };
    const fim = await conexao.processar(pendId, { provedor, transacaoIndependente: queda.tx });
    assert.equal(fim.ok, false, 'o processamento não terminou');
    provedor.antesDeRemover = null;
    assert.deepEqual(await situacaoDo(pendId), antes, 'a transação do processamento foi desfeita pelo servidor');
    assert.deepEqual((await marcadores(empresa)).map((m) => [m.situacao, m.ultimo_erro, m.assinatura_provedor_id]), [['PENDENTE', 'REMOCAO_EM_CURSO', d1]], 'o marcador confirmado antes sobreviveu');
    assert.deepEqual([provedor.removidas, await remocoesAuditadas(empresa)], [[], []]);
    for (const id of [pendId, (await marcadores(empresa))[0].id]) {
        const r = await withTransaction((tx) => processarEvento(tx, id, { provedor, transacaoIndependente: independenteReal }));
        assert.deepEqual([r.situacao, r.motivo], ['FALHOU', 'REVISAO_HUMANA: REMOCAO_SEM_CONFIRMACAO']);
    }
    assert.deepEqual([provedor.chamadasRemocao, provedor.removidas, provedor.ativasDe(empresa).includes(d1)], [1, [], true], 'nenhum DELETE depois da queda');
});

test('reconciliação: queda REAL depois do DELETE e antes de gravar a confirmação → nenhum novo DELETE; a releitura confirma a exclusão uma vez', async () => {
    const { empresa, provedor, vinculada, duplicatas: [d1], pendId } = await comDuplicatas(1);
    const conexao = await conexaoDeProcessamento();
    const queda = independenteQueCai();
    provedor.depoisDeRemover = async () => {
        queda.estado.caiu = true;
        await encerrarProcesso(conexao.pid);
    };
    const fim = await conexao.processar(pendId, { provedor, transacaoIndependente: queda.tx });
    assert.equal(fim.ok, false);
    provedor.depoisDeRemover = null;
    assert.deepEqual([provedor.removidas, provedor.chamadasRemocao], [[d1], 1], 'o provedor excluiu');
    assert.deepEqual((await marcadores(empresa)).map((m) => [m.situacao, m.ultimo_erro]), [['PENDENTE', 'REMOCAO_EM_CURSO']]);
    assert.deepEqual(await remocoesAuditadas(empresa), [], 'a confirmação não chegou ao banco');
    const r = await withTransaction((tx) => processarEvento(tx, pendId, { provedor, transacaoIndependente: independenteReal }));
    assert.deepEqual([r.situacao, r.motivo], ['PROCESSADO', 'NADA_A_FAZER']);
    assert.equal(provedor.chamadasRemocao, 1, 'nenhum DELETE repetido');
    assert.deepEqual(await remocoesAuditadas(empresa), [['ASSINATURA_DUPLICADA_REMOVIDA', 1, 'RELEITURA']]);
    assert.deepEqual([(await marcadores(empresa)).map((m) => m.situacao), provedor.ativasDe(empresa)], [['PROCESSADO'], [vinculada]]);
});

class AsaasLeituraFalhando extends AsaasFalso {
    falharLeituraDe = new Set<string>();
    override async obterAssinatura(id: string) {
        if (this.falharLeituraDe.has(id))
            throw new AsaasFalhou('consultar assinatura', null, 'REDE');
        return super.obterAssinatura(id);
    }
}

test('recuperação distingue ausência de erro de consulta: leitura falhando não confirma nada nem exclui; ausência confirma pela releitura', async () => {
    const { empresa, provedor, duplicatas: [d1], pendId } = await comDuplicatas(1, new AsaasLeituraFalhando());
    const recon = await import('./reconciliacao-contratacao.ts');
    const marcador = await withTransaction((tx) => recon.abrirMarcadorRemocao(tx, empresa, d1, 'REMOCAO_EM_CURSO'));
    provedor.assinaturas.get(d1)!.deleted = true;
    provedor.falharLeituraDe.add(d1);
    const r = await withTransaction((tx) => processarEvento(tx, pendId, { provedor, transacaoIndependente: independenteReal }));
    assert.equal(r.situacao, 'FALHOU');
    assert.match(String(r.motivo), /^PROVEDOR_INDISPONIVEL: consultar assinatura/);
    assert.deepEqual([(await situacaoDo(marcador)).situacao, await remocoesAuditadas(empresa), provedor.chamadasRemocao], ['PENDENTE', [], 0], 'erro de consulta não é ausência');
    provedor.falharLeituraDe.clear();
    const depois = await withTransaction((tx) => processarEvento(tx, pendId, { provedor, transacaoIndependente: independenteReal }));
    assert.deepEqual([depois.situacao, (await situacaoDo(marcador)).ultimo_erro, provedor.chamadasRemocao], ['PROCESSADO', 'REMOCAO_CONFIRMADA_NA_RELEITURA', 0]);
    assert.deepEqual(await remocoesAuditadas(empresa), [['ASSINATURA_DUPLICADA_REMOVIDA', 1, 'RELEITURA']]);
});

test('concorrência real: duas reconciliações da mesma empresa ao mesmo tempo → a segunda espera a trava da linha; um único DELETE e uma única auditoria', async () => {
    const { empresa, provedor, vinculada, duplicatas: [d1], pendId } = await comDuplicatas(1);
    const recon = await import('./reconciliacao-contratacao.ts');
    const pend2 = await withTransaction((tx) => recon.registrarPendencia(tx, { empresaId: empresa, assinaturaId: d1, motivo: 'COMPENSACAO_FALHOU' }));
    let esperaVista = false;
    provedor.antesDeRemover = async () => {
        provedor.antesDeRemover = null;
        for (let i = 0; i < 60 && !esperaVista; i++) {
            esperaVista = (await q("SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted")).rows[0].n > 0;
            if (!esperaVista) await new Promise((ok) => setTimeout(ok, 50));
        }
    };
    const [a, b] = await Promise.all([pendId, pend2].map((id) => withTransaction((tx) => processarEvento(tx, id, { provedor, transacaoIndependente: independenteReal }))));
    assert.ok(esperaVista, 'a outra reconciliação estava esperando a trava durante o DELETE');
    assert.deepEqual([a.situacao, b.situacao].sort(), ['PROCESSADO', 'PROCESSADO']);
    assert.deepEqual([provedor.chamadasRemocao, provedor.removidas, provedor.ativasDe(empresa)], [1, [d1], [vinculada]]);
    assert.deepEqual(await remocoesAuditadas(empresa), [['ASSINATURA_DUPLICADA_REMOVIDA', 1, 'RESPOSTA_DO_PROVEDOR']]);
});

test('concorrência real: dois marcadores prévios para a mesma assinatura ao mesmo tempo → só um é gravado (trava consultiva); o outro não exclui', async () => {
    const empresa = await novaEmpresa();
    const recon = await import('./reconciliacao-contratacao.ts');
    const ids = await Promise.all([1, 2].map(() => recon.persistirMarcadorPrevio(independenteReal, empresa, 'sub_corrida_marcador')));
    assert.equal(ids.filter(Boolean).length, 1);
    assert.deepEqual((await marcadores(empresa)).map((m) => m.assinatura_provedor_id), ['sub_corrida_marcador']);
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
    const r = await withTransaction((tx) => processarEvento(tx, pend.id, { provedor, transacaoIndependente: withTransaction }));
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
    const r = await withTransaction((tx) => processarEvento(tx, pend.id, { provedor, transacaoIndependente: withTransaction }));
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
    const r = await withTransaction((tx) => processarEvento(tx, pend.id, { provedor, transacaoIndependente: withTransaction }));
    assert.deepEqual([r.situacao, r.motivo], ['FALHOU', 'REVISAO_HUMANA: VARIAS_ASSINATURAS_SEM_VINCULO']);
    // O banco aponta uma assinatura antiga já cancelada: as duas ativas NÃO viram "duplicatas" dela.
    const antiga = provedor.criarDireto(cliente, empresa);
    await provedor.removerAssinatura(antiga);
    provedor.removidas = [];
    await q("UPDATE empresa_assinaturas SET provedor = 'ASAAS', provedor_cliente_id = $2, provedor_assinatura_id = $3, provedor_situacao = 'DELETED' WHERE empresa_id = $1", [empresa, cliente, antiga]);
    const r2 = await withTransaction((tx) => processarEvento(tx, pend.id, { provedor, transacaoIndependente: withTransaction }));
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
    const aguardando = await withTransaction((tx) => processarEvento(tx, pend.id, { provedor, transacaoIndependente: withTransaction }));
    assert.deepEqual([aguardando.situacao, aguardando.motivo], ['FALHOU', 'AGUARDANDO_CONFIRMACAO: CRIACAO_NAO_CONFIRMADA']);
    assert.deepEqual((await pendencias(empresa)).map((x) => x.id), [pend.id], 'a mesma pendência continua aberta');
    assert.equal(await codigo(contratar(empresa, deps(empresa, { provedor }))), 'COBRANCA_RESULTADO_INCERTO');
    assert.equal(provedor.postsCriacao, 1);
    // Só agora a primeira assinatura aparece: a retomada a reaproveita, sem criar outra.
    provedor.ocultasNaListagem.clear();
    const r = await contratar(empresa, deps(empresa, { provedor })) as { reaproveitada: boolean; urlPagamento: string | null };
    assert.deepEqual([r.reaproveitada, Boolean(r.urlPagamento), await vinculo(empresa)], [true, true, primeira]);
    const fechada = await withTransaction((tx) => processarEvento(tx, pend.id, { provedor, transacaoIndependente: withTransaction }));
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
    const espera = await withTransaction((tx) => processarEvento(tx, pend.id, { provedor, transacaoIndependente: withTransaction }));
    assert.equal(espera.situacao, 'FALHOU');
    provedor.ocultasNaListagem.clear();
    const r = await withTransaction((tx) => processarEvento(tx, pend.id, { provedor, transacaoIndependente: withTransaction }));
    assert.deepEqual([r.situacao, r.motivo, await vinculo(empresa)], ['PROCESSADO', 'VINCULADA', orfa]);
    const retomada = await contratar(empresa, deps(empresa, { provedor })) as { reaproveitada: boolean };
    assert.deepEqual([retomada.reaproveitada, provedor.postsCriacao, provedor.removidas, (await pendencias(empresa)).length], [true, 0, [], 0]);
});

test('POST com sucesso e processo que cai ANTES da fase C, listagem vazia: a nova tentativa vincula pelo id durável — UM POST, intenção encerrada só com o vínculo', async () => {
    const empresa = await novaEmpresa();
    const provedor = new AsaasFalso();
    let criada = '';
    provedor.depoisDeCriar = async (id) => { criada = id; provedor.ocultasNaListagem.add(id); };
    // Chamadas de tenant: 1 = empresa comprovada, 2 = fase A, 3 = fase C (o processo morre aqui).
    const morre = processoQueMorre(empresa, 3);
    assert.notEqual(await codigo(contratar(empresa, deps(empresa, { provedor, withTenant: morre.withTenant, withTx: morre.withTx }))), 'OK');
    provedor.depoisDeCriar = null;
    assert.deepEqual([provedor.postsCriacao, await vinculo(empresa)], [1, null], 'POST respondido, vínculo não gravado');
    // Recuperável: a intenção continua aberta e o id confirmado ficou gravado de forma durável.
    assert.deepEqual(await intencoes(empresa), [['PENDENTE', 'CRIACAO_EM_CURSO']]);
    const abertas = await pendencias(empresa);
    assert.deepEqual(abertas.map((x) => [x.ultimo_erro, x.assinatura_provedor_id]), [['CRIACAO_EM_CURSO', null], ['CRIACAO_CONFIRMADA_SEM_VINCULO', criada]]);
    // A liberação manual é recusada: há assinatura confirmada.
    assert.equal(await codigo(withTransaction((tx) => liberarIntencaoCriacao(tx, { usuario_id: dev }, empresa, { pendenciaId: abertas[0].id, motivo: 'tentativa indevida de liberar', confirmacao: CONFIRMACAO_LIBERACAO }, provedor, { requestId: randomUUID() }))), 'CONFLITO');
    // Nova tentativa com a listagem AINDA vazia: reaproveita pelo id, sem POST.
    assert.deepEqual(provedor.ativasDe(empresa), [criada]);
    assert.deepEqual(await provedor.listarAssinaturasPorReferencia(empresa), [], 'listagem vazia');
    const r = await contratar(empresa, deps(empresa, { provedor })) as { reaproveitada: boolean; urlPagamento: string | null };
    assert.deepEqual([r.reaproveitada, Boolean(r.urlPagamento), await vinculo(empresa)], [true, true, criada]);
    assert.deepEqual([provedor.postsCriacao, provedor.criadas, provedor.removidas], [1, 1, []], 'UM POST; nada excluído');
    assert.deepEqual([await intencoes(empresa), await idsConfirmados(empresa), await pendencias(empresa)], [[['PROCESSADO', 'VINCULADA']], [['PROCESSADO', 'VINCULADA']], []],
        'intenção e id encerrados junto com o vínculo');
});

test('mesma queda antes da fase C, recuperada pela reconciliação do id durável (sem nova contratação): vincula, sem POST', async () => {
    const empresa = await novaEmpresa();
    const provedor = new AsaasFalso();
    let criada = '';
    provedor.depoisDeCriar = async (id) => { criada = id; provedor.ocultasNaListagem.add(id); };
    const morre = processoQueMorre(empresa, 3);
    assert.notEqual(await codigo(contratar(empresa, deps(empresa, { provedor, withTenant: morre.withTenant, withTx: morre.withTx }))), 'OK');
    provedor.depoisDeCriar = null;
    const [intencao, idDuravel] = await pendencias(empresa);
    const r = await withTransaction((tx) => processarEvento(tx, idDuravel.id, { provedor, transacaoIndependente: withTransaction }));
    assert.deepEqual([r.situacao, r.motivo, await vinculo(empresa)], ['PROCESSADO', 'VINCULADA', criada]);
    const ri = await withTransaction((tx) => processarEvento(tx, intencao.id, { provedor, transacaoIndependente: withTransaction }));
    assert.deepEqual([ri.situacao, ri.motivo], ['PROCESSADO', 'NADA_A_FAZER'], 'empresa vinculada: a intenção fecha');
    assert.deepEqual([provedor.postsCriacao, provedor.removidas, await pendencias(empresa)], [1, [], []]);
});

test('liberação manual auditada: só para intenção comprovadamente não executada; recusas não mudam nada; nunca por prazo; depois, uma nova criação', async () => {
    const empresa = await novaEmpresa();
    const provedor = new AsaasFalso();
    provedor.falharAntesDeCriar = true;
    assert.equal(await codigo(contratar(empresa, deps(empresa, { provedor }))), 'COBRANCA_RESULTADO_INCERTO');
    provedor.falharAntesDeCriar = false;
    const [intencao] = await pendencias(empresa);
    assert.deepEqual([intencao.ultimo_erro, provedor.postsCriacao, provedor.criadas], ['CRIACAO_SEM_RESPOSTA', 1, 0]);
    // Bloqueada: nem a contratação nem a reconciliação liberam com a listagem vazia (sem prazo nenhum).
    assert.equal(await codigo(contratar(empresa, deps(empresa, { provedor }))), 'COBRANCA_RESULTADO_INCERTO');
    for (let i = 0; i < 3; i++)
        assert.equal((await withTransaction((tx) => processarEvento(tx, intencao.id, { provedor, transacaoIndependente: withTransaction }))).motivo, 'AGUARDANDO_CONFIRMACAO: CRIACAO_NAO_CONFIRMADA');
    assert.equal(provedor.postsCriacao, 1);
    const liberar = (raw: unknown, quem = dev, prov: Pick<ClienteAsaas, 'listarAssinaturasPorReferencia'> = provedor) =>
        codigo(withTransaction((tx) => liberarIntencaoCriacao(tx, { usuario_id: quem }, empresa, raw, prov, { requestId: randomUUID() })));
    const valido = { pendenciaId: intencao.id, motivo: 'Conferido no painel do Asaas: nenhuma assinatura criada', confirmacao: CONFIRMACAO_LIBERACAO };
    assert.equal(await liberar({ ...valido, confirmacao: 'sim' }), 'DADOS_INVALIDOS', 'declaração literal obrigatória');
    assert.equal(await liberar({ ...valido, motivo: 'curto' }), 'DADOS_INVALIDOS', 'motivo obrigatório');
    assert.equal(await liberar(valido, usuario), 'NAO_ENCONTRADO', 'sem concessão de desenvolvedor');
    assert.equal(await liberar({ ...valido, pendenciaId: randomUUID() }), 'CONFLITO', 'pendência inexistente');
    const visivel = { listarAssinaturasPorReferencia: async () => [{ id: 'sub_x', status: 'ACTIVE', deleted: false, cycle: 'MONTHLY', customer: null, externalReference: empresa }] };
    assert.equal(await liberar(valido, dev, visivel), 'CONFLITO', 'provedor mostra assinatura: foi executada');
    const fora = { listarAssinaturasPorReferencia: async () => { throw new AsaasFalhou('listar assinaturas', null, 'REDE'); } };
    assert.notEqual(await liberar(valido, dev, fora), 'OK', 'provedor indisponível: nada liberado');
    assert.deepEqual((await pendencias(empresa)).map((x) => x.id), [intencao.id], 'recusas não mudaram nada');
    // Liberação válida: auditada com o motivo; a intenção fecha; a próxima contratação cria UMA assinatura.
    assert.equal(await liberar(valido), 'OK');
    const ev = (await q('SELECT situacao, ultimo_erro FROM cobranca_eventos WHERE id = $1', [intencao.id])).rows[0];
    assert.deepEqual([ev.situacao, ev.ultimo_erro], ['PROCESSADO', 'LIBERADA_MANUALMENTE: CRIACAO_NAO_EXECUTADA']);
    const aud = (await q("SELECT usuario_id, justificativa, dados_depois FROM auditoria WHERE acao = 'COBRANCA_INTENCAO_LIBERADA' AND dados_depois::text LIKE $1", [`%${intencao.id}%`])).rows;
    assert.equal(aud.length, 1);
    assert.deepEqual([aud[0].usuario_id, aud[0].justificativa], [dev, valido.motivo]);
    assert.equal(await liberar(valido), 'CONFLITO', 'já resolvida');
    const r = await contratar(empresa, deps(empresa, { provedor })) as { reaproveitada: boolean };
    assert.deepEqual([r.reaproveitada, provedor.postsCriacao, provedor.criadas, await vinculo(empresa)], [false, 2, 1, provedor.ativasDe(empresa)[0]]);
});
