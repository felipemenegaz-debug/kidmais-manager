import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ASAAS_SANDBOX_URL, PREFIXO_CHAVE_SANDBOX, criarClienteAsaas } from './asaas.ts';
import {
    abrirMarcadorRemocao, novoRegistroRemocoes, reconciliarContratacao, registrarRemocoes, registrarResultadoRemocao, removerComResultado,
    type ResultadoRemocao, type TransacaoIndependente,
} from './reconciliacao-contratacao.ts';

/**
 * C1 do parecer de 10/10/2026 (pacote c7b647f): resposta 404 ao DELETE comprova AUSÊNCIA no provedor, não que o nosso
 * pedido removeu a assinatura. Quatro resultados distintos — exclusão confirmada, ausência confirmada, recusa e resultado
 * desconhecido — com auditoria correspondente. Componentes reais (cliente Asaas com `fetch` falso, reconciliarContratacao,
 * registrarResultadoRemocao, registrarRemocoes) sobre um banco dublê em memória: nenhum banco, nenhuma rede.
 */
const EMPRESA = '11111111-1111-4111-8111-111111111111';
const VINCULADA = 'sub_vinculada';
const DUPLICATA = 'sub_duplicata';
const config = { ambiente: 'sandbox' as const, baseUrl: ASAAS_SANDBOX_URL, apiKey: `${PREFIXO_CHAVE_SANDBOX}sintetica`, webhookToken: 'x'.repeat(32) };

type Marcador = { id: string; evento_id: string; assinatura_provedor_id: string; situacao: string; ultimo_erro: string };
/** Banco dublê: marcadores de exclusão, auditoria e o vínculo da empresa. Recusa SQL inesperado. */
function bancoDuble(marcadores: Marcador[] = []) {
    const auditorias: Array<{ acao: string; depois: Record<string, unknown> }> = [];
    let sequencia = 0;
    const tx = {
        async query(sql: string, p: unknown[] = []) {
            const s = sql.replace(/\s+/g, ' ').trim();
            if (s.startsWith('SET LOCAL') || s.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [], rowCount: 0 };
            if (s.includes('to_regclass')) return { rows: [{ instalado074: false }], rowCount: 1 };
            if (s.startsWith('SELECT situacao, provedor_assinatura_id, provedor_cliente_id FROM empresa_assinaturas'))
                return { rows: [{ situacao: 'ATIVA', provedor_assinatura_id: VINCULADA, provedor_cliente_id: 'cus_1' }], rowCount: 1 };
            const abertos = marcadores.filter((m) => m.situacao === 'PENDENTE' || m.situacao === 'FALHOU');
            if (s.startsWith('SELECT id, assinatura_provedor_id FROM cobranca_eventos')) return { rows: abertos.map(({ id, assinatura_provedor_id }) => ({ id, assinatura_provedor_id })), rowCount: abertos.length };
            if (s.startsWith('SELECT 1 FROM cobranca_eventos')) { const r = abertos.filter((m) => m.assinatura_provedor_id === p[2]); return { rows: r.map(() => ({ '?column?': 1 })), rowCount: r.length }; }
            if (s.startsWith('INSERT INTO cobranca_eventos')) {
                const m = { id: `00000000-0000-4000-8000-00000000000${++sequencia}`, evento_id: String(p[0]), assinatura_provedor_id: String(p[2]), situacao: 'PENDENTE', ultimo_erro: String(p[5]) };
                marcadores.push(m);
                return { rows: [{ id: m.id }], rowCount: 1 };
            }
            if (s.startsWith("UPDATE cobranca_eventos SET situacao = 'PROCESSADO'")) {
                const ids = Array.isArray(p[0]) ? p[0] as string[] : [String(p[0])];
                const motivo = s.includes("ultimo_erro = 'AUSENCIA_CONFIRMADA_NA_RELEITURA'") ? 'AUSENCIA_CONFIRMADA_NA_RELEITURA' : String(p[2]);
                for (const m of marcadores) if (ids.includes(m.id) && m.situacao === 'PENDENTE') Object.assign(m, { situacao: 'PROCESSADO', ultimo_erro: motivo });
                return { rows: [], rowCount: 1 };
            }
            if (s.startsWith("UPDATE cobranca_eventos SET ultimo_erro = 'REMOCAO_SEM_CONFIRMACAO'")) {
                for (const m of marcadores) if (m.id === p[0]) m.ultimo_erro = 'REMOCAO_SEM_CONFIRMACAO';
                return { rows: [], rowCount: 1 };
            }
            if (s.startsWith('INSERT INTO auditoria')) { auditorias.push({ acao: String(p[2]), depois: JSON.parse(String(p[5])) }); return { rows: [], rowCount: 1 }; }
            throw new Error(`SQL inesperado no dublê: ${s.slice(0, 90)}`);
        },
    };
    const independente: TransacaoIndependente = async (trabalho) => trabalho(tx as never);
    return { tx, independente, marcadores, auditorias };
}

const json = (status: number, corpo: unknown) => new Response(JSON.stringify(corpo), { status });
const sub = (id: string) => ({ id, status: 'ACTIVE', deleted: false, cycle: 'MONTHLY', customer: 'cus_1', externalReference: EMPRESA });
type RespostaDelete = (init?: RequestInit) => Promise<Response> | Response;
/** Nunca responde, como uma conexão parada: só o abort do tempo-limite do cliente encerra (igual ao fetch real). */
const semResposta: RespostaDelete = (init) => new Promise<Response>((_ok, falha) => init?.signal?.addEventListener('abort', () => falha(new DOMException('abort', 'AbortError'))));
/** Provedor real (cliente Asaas) com `fetch` falso: vínculo e duplicata ativos, duplicata só com cobrança em aberto. */
function provedor(opcoes: { delete: RespostaDelete; duplicata?: 'ativa' | 'ausente'; tempoLimiteMs?: number }) {
    const chamadas: string[] = [];
    const f = async (url: string, init: RequestInit) => {
        const caminho = url.slice(ASAAS_SANDBOX_URL.length);
        chamadas.push(`${init.method} ${caminho.split('?')[0]}`);
        if (init.method === 'DELETE') return opcoes.delete(init);
        if (caminho.startsWith('/subscriptions?')) return json(200, { hasMore: false, data: [sub(VINCULADA), ...(opcoes.duplicata === 'ausente' ? [] : [sub(DUPLICATA)])] });
        if (caminho === `/subscriptions/${VINCULADA}`) return json(200, sub(VINCULADA));
        if (caminho === `/subscriptions/${DUPLICATA}`) return opcoes.duplicata === 'ausente' ? json(404, { errors: [] }) : json(200, sub(DUPLICATA));
        if (caminho.startsWith(`/subscriptions/${DUPLICATA}/payments`)) return json(200, { hasMore: false, data: [{ id: 'pay_1', status: 'PENDING', dueDate: '2026-11-10' }] });
        throw new Error(`rota inesperada: ${init.method} ${caminho}`);
    };
    return { cliente: criarClienteAsaas(config, { fetch: f, tempoLimiteMs: opcoes.tempoLimiteMs ?? 1000 }), chamadas, deletes: () => chamadas.filter((c) => c.startsWith('DELETE')).length };
}
const acoes = (db: { auditorias: Array<{ acao: string }> }) => db.auditorias.map((a) => a.acao);
async function reconciliar(p: ReturnType<typeof provedor>, db: ReturnType<typeof bancoDuble>) {
    const registro = novoRegistroRemocoes();
    try {
        return { r: await reconciliarContratacao(db.tx as never, EMPRESA, p.cliente, null, { criacao: false, assinaturaId: DUPLICATA }, registro, db.independente), registro, erro: null as unknown };
    }
    catch (erro) {
        return { r: null, registro, erro };
    }
}

test('C1: DELETE com 404 → AUSENTE (nunca CONFIRMADA); auditoria NEUTRA, marcador fecha como ausência, um único DELETE', async () => {
    const p = provedor({ delete: () => json(404, { errors: [{ description: 'nao encontrado' }] }) });
    const db = bancoDuble();
    const { r, registro } = await reconciliar(p, db);
    assert.equal(p.deletes(), 1);
    assert.deepEqual(acoes(db), ['ASSINATURA_AUSENCIA_CONFIRMADA_EXCLUSAO'], 'não atribui a remoção ao nosso pedido');
    assert.ok(!acoes(db).includes('ASSINATURA_DUPLICADA_REMOVIDA'));
    assert.equal(db.auditorias[0].depois.confirmacao, 'AUSENCIA_NA_RESPOSTA_DA_EXCLUSAO');
    assert.deepEqual(db.marcadores.map((m) => [m.situacao, m.ultimo_erro]), [['PROCESSADO', 'AUSENCIA_CONFIRMADA_NA_EXCLUSAO']]);
    assert.deepEqual([registro.confirmadas, registro.ausentes, registro.semConfirmacao], [[], [DUPLICATA], []]);
    assert.deepEqual(r, { resultado: 'NADA_A_FAZER', removidas: [] }, 'ausência não conta como removida por nós');
});

test('C1: exclusão confirmada pela resposta (deleted) → CONFIRMADA; ASSINATURA_DUPLICADA_REMOVIDA uma vez e marcador REMOCAO_CONFIRMADA', async () => {
    const p = provedor({ delete: () => json(200, { deleted: true, id: DUPLICATA }) });
    const db = bancoDuble();
    const { r, registro } = await reconciliar(p, db);
    assert.equal(p.deletes(), 1);
    assert.deepEqual(acoes(db), ['ASSINATURA_DUPLICADA_REMOVIDA']);
    assert.equal(db.auditorias[0].depois.confirmacao, 'RESPOSTA_DO_PROVEDOR');
    assert.deepEqual(db.marcadores.map((m) => [m.situacao, m.ultimo_erro]), [['PROCESSADO', 'REMOCAO_CONFIRMADA']]);
    assert.deepEqual(registro.confirmadas, [DUPLICATA]);
    assert.ok(!registro.ausentes?.length, 'confirmada não é registrada como ausência');
    assert.deepEqual(r, { resultado: 'CONCILIADA', removidas: [DUPLICATA] });
});

test('C1: falhas sem confirmação (5xx, 408, 409, 429, rede, tempo esgotado, 200 sem deleted) → DESCONHECIDA; marcador aberto, nunca removida nem ausente', async () => {
    const casos: Record<string, { delete: RespostaDelete; tempoLimiteMs?: number }> = {
        '503': { delete: () => json(503, {}) }, '500': { delete: () => json(500, {}) }, '408': { delete: () => json(408, {}) },
        '409': { delete: () => json(409, {}) }, '429': { delete: () => json(429, {}) },
        rede: { delete: () => { throw new TypeError('fetch failed'); } },
        'tempo esgotado': { delete: semResposta, tempoLimiteMs: 20 },
        '200 sem deleted': { delete: () => json(200, { id: DUPLICATA }) },
    };
    for (const [nome, caso] of Object.entries(casos)) {
        const p = provedor(caso);
        const db = bancoDuble();
        const { r, registro } = await reconciliar(p, db);
        assert.equal(p.deletes(), 1, nome);
        assert.deepEqual(acoes(db), ['ASSINATURA_REMOCAO_SEM_CONFIRMACAO'], `${nome}: só a auditoria de resultado desconhecido`);
        assert.deepEqual(db.marcadores.map((m) => [m.situacao, m.ultimo_erro]), [['PENDENTE', 'REMOCAO_SEM_CONFIRMACAO']], nome);
        assert.deepEqual([registro.confirmadas, registro.semConfirmacao], [[], [DUPLICATA]], nome);
        assert.ok(!registro.ausentes?.length, nome);
        assert.deepEqual(r, { resultado: 'REVISAO_HUMANA', ids: [DUPLICATA], motivo: 'REMOCAO_SEM_CONFIRMACAO' }, nome);
    }
});

test('C1: recusa definitiva (400) → RECUSADA; marcador fecha como REMOCAO_RECUSADA, sem auditoria de remoção nem de ausência', async () => {
    const p = provedor({ delete: () => json(400, { errors: [] }) });
    const db = bancoDuble();
    const { r, erro } = await reconciliar(p, db);
    assert.equal(r, null);
    assert.equal((erro as { status?: number }).status, 400, 'a recusa propaga: o evento fica FALHOU e volta a ser tentado');
    assert.deepEqual(acoes(db), []);
    assert.deepEqual(db.marcadores.map((m) => [m.situacao, m.ultimo_erro]), [['PROCESSADO', 'REMOCAO_RECUSADA']]);
});

test('C1: recuperação por releitura — marcador aberto + GET 404 → ausência pela releitura (ação neutra), SEM novo DELETE; GET ativo → revisão, SEM DELETE', async () => {
    const aberto = (): Marcador => ({ id: '33333333-3333-4333-8333-333333333333', evento_id: `kidmais:remocao:${EMPRESA}:anterior`, assinatura_provedor_id: DUPLICATA, situacao: 'PENDENTE', ultimo_erro: 'REMOCAO_SEM_CONFIRMACAO' });
    // Ausente na releitura (a exclusão anterior aconteceu, ou outra pessoa removeu).
    const pAusente = provedor({ delete: () => { throw new Error('DELETE não pode ser repetido'); }, duplicata: 'ausente' });
    const dbAusente = bancoDuble([aberto()]);
    const a = await reconciliar(pAusente, dbAusente);
    assert.equal(pAusente.deletes(), 0, 'nenhum DELETE na recuperação');
    assert.deepEqual(a.registro.confirmadasNaReleitura, [{ marcadorId: '33333333-3333-4333-8333-333333333333' }]);
    await registrarRemocoes(dbAusente.tx as never, EMPRESA, a.registro, { tipo: 'RECONCILIACAO' }, { id: 'evento-qualquer', concluido: true });
    assert.deepEqual(acoes(dbAusente), ['ASSINATURA_AUSENCIA_CONFIRMADA_RELEITURA']);
    assert.deepEqual(dbAusente.marcadores.map((m) => [m.situacao, m.ultimo_erro]), [['PROCESSADO', 'AUSENCIA_CONFIRMADA_NA_RELEITURA']]);
    // Ainda ativa na releitura (a exclusão anterior não aconteceu): nunca repete, fica para revisão.
    const pAtiva = provedor({ delete: () => { throw new Error('DELETE não pode ser repetido'); } });
    const dbAtiva = bancoDuble([aberto()]);
    const b = await reconciliar(pAtiva, dbAtiva);
    assert.equal(pAtiva.deletes(), 0);
    assert.deepEqual(b.r, { resultado: 'REVISAO_HUMANA', ids: [DUPLICATA], motivo: 'REMOCAO_SEM_CONFIRMACAO' });
    assert.deepEqual(acoes(dbAtiva), []);
    assert.equal(dbAtiva.marcadores[0].situacao, 'PENDENTE');
});

test('C1: classificação do cliente real — 404 AUSENTE, deleted CONFIRMADA, 4xx RECUSADA, o resto DESCONHECIDA', async () => {
    const classificar = async (resposta: RespostaDelete, tempoLimiteMs = 1000) => {
        const c = criarClienteAsaas(config, { fetch: async (_url, init) => resposta(init), tempoLimiteMs });
        return (await removerComResultado(c, DUPLICATA)).resultado;
    };
    assert.equal(await classificar(() => json(404, {})), 'AUSENTE');
    assert.equal(await classificar(() => json(200, { deleted: true, id: DUPLICATA })), 'CONFIRMADA');
    assert.equal(await classificar(() => json(200, { id: DUPLICATA })), 'DESCONHECIDA');
    for (const s of [400, 401, 403, 422]) assert.equal(await classificar(() => json(s, {})), 'RECUSADA', String(s));
    for (const s of [408, 409, 429, 500, 502, 503]) assert.equal(await classificar(() => json(s, {})), 'DESCONHECIDA', String(s));
    assert.equal(await classificar(semResposta, 20), 'DESCONHECIDA');
});

test('C1: compensação da contratação usa o mesmo registro — ausência fecha marcador e pendências com motivos neutros', async () => {
    const db = bancoDuble();
    const marcador = await abrirMarcadorRemocao(db.tx as never, EMPRESA, DUPLICATA, 'REMOCAO_EM_CURSO');
    const extras: string[] = [];
    const ausente: ResultadoRemocao = { resultado: 'AUSENTE' };
    assert.equal(await registrarResultadoRemocao(db.independente, EMPRESA, marcador, ausente, { tipo: 'GESTAO', usuarioId: null, requestId: null } as never, async () => { extras.push('pendencias'); }), true);
    assert.deepEqual(acoes(db), ['ASSINATURA_AUSENCIA_CONFIRMADA_EXCLUSAO']);
    assert.deepEqual(db.marcadores.map((m) => [m.situacao, m.ultimo_erro]), [['PROCESSADO', 'AUSENCIA_CONFIRMADA_NA_EXCLUSAO']]);
    assert.deepEqual(extras, ['pendencias'], 'pendências da operação tratadas na mesma transação');
    // As pendências da operação fecham como ausência, nunca como COMPENSADA (que afirmaria a remoção por nós).
    const fonte = readFileSync('lib/assinatura/cobranca.ts', 'utf8');
    const compensar = fonte.slice(fonte.indexOf('async function compensarComMarcador('));
    assert.match(compensar, /else if \(remocao\.resultado === 'AUSENTE'\)\s*\/\/[^\n]*\n\s*await encerrarPendencias\(tx, empresaId, b\.encerrar, 'DUPLICATA_AUSENTE_NO_PROVEDOR'\);/);
});
