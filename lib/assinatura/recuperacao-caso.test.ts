import assert from 'node:assert/strict';
import test from 'node:test';
import { aplicarCaso, CAMPOS_LIVRES_DO_PROVEDOR, gravarLeituras, minimizarLeitura, proporCaso } from './recuperacao-caso.ts';
import type { Fotografia } from './recuperacao-efeitos.ts';

/**
 * B-14 (§3.4, §4): proposta e aplicação de um caso com banco SIMULADO — a fotografia vem de um estado em memória que o
 * "processamento" altera. Verifica SAVEPOINT/ROLLBACK, igualdade de hash entre T1 e T2, regravação dos valores do
 * instante e recusa quando pré-condição local ou remota muda. A prova em PostgreSQL fica para os testes .postgres.
 */
const EMP = '22222222-2222-4222-8222-222222222222';
type Estado = { situacao: string; cancelada_em: string | null; versao: number; sincronizado_em: string; lotes: { id: string; chave_origem: string; criado_em: string }[] };

function banco(estado: Estado) {
    const sql: string[] = [];
    let salvo: Estado | null = null;
    const copia = (e: Estado): Estado => JSON.parse(JSON.stringify(e));
    const tx = { query: async (s: string) => {
        sql.push(s);
        if (s.startsWith('SAVEPOINT')) salvo = copia(estado);
        if (s.startsWith('ROLLBACK TO SAVEPOINT')) Object.assign(estado, salvo);
        return { rows: [], rowCount: 0 };
    } };
    const fotografar = async (): Promise<Fotografia> => ({
        empresa_assinaturas: [{ empresa_id: EMP, situacao: estado.situacao, cancelada_em: estado.cancelada_em, versao: estado.versao, sincronizado_em: estado.sincronizado_em }],
        ia_credito_lotes: estado.lotes.map((l) => ({ ...l, recurso: 'WALLE' })),
    });
    return { tx, sql, fotografar, estado };
}

/** "Processamento normal": cancela com a data de AGORA e cria um lote com id novo. */
function processamento(agora: string, idLote: string) {
    return (b: ReturnType<typeof banco>) => async (provedor: { obterAssinatura: (id: string) => Promise<unknown> }) => {
        const remota = await provedor.obterAssinatura('sub_1') as { status: string };
        if (remota.status === 'INACTIVE') Object.assign(b.estado, { situacao: 'CANCELADA_FIM_PERIODO', cancelada_em: agora, versao: b.estado.versao + 1, sincronizado_em: agora });
        b.estado.lotes.push({ id: idLote, chave_origem: 'COMPRA:p-1', criado_em: agora });
        return { resultado: 'SINCRONIZADA' };
    };
}
const inicial = (): Estado => ({ situacao: 'ATIVA', cancelada_em: null, versao: 3, sincronizado_em: 't0', lotes: [] });
const provedor = (status = 'INACTIVE') => ({ obterAssinatura: async () => ({ id: 'sub_1', status }) });
const regravar = (b: ReturnType<typeof banco>) => async (valores: { coluna: string; valor: unknown }[]) => {
    for (const v of valores) if (v.coluna === 'cancelada_em' && b.estado.cancelada_em !== v.valor) Object.assign(b.estado, { cancelada_em: v.valor, versao: b.estado.versao + 1 });
};

test('proporCaso: efeitos e hash, e nada fica gravado (ROLLBACK TO SAVEPOINT)', async () => {
    const b = banco(inicial());
    const r = await proporCaso({ tx: b.tx, caso: 'k1', provedor: provedor(), fotografar: b.fotografar, executar: processamento('2026-10-27T10:00:00.000Z', 'lote-a')(b) });
    assert.match(r.hash, /^[0-9a-f]{64}$/);
    assert.equal(r.semEfeito, false);
    assert.deepEqual(b.sql, ['SAVEPOINT b14_caso', 'ROLLBACK TO SAVEPOINT b14_caso', 'RELEASE SAVEPOINT b14_caso']);
    assert.deepEqual(b.estado, inicial(), 'estado intacto');
    assert.deepEqual((r.proposta.precondicoes.remoto as unknown[]).length, 1, 'a leitura do provedor virou pré-condição');
});

test('aplicarCaso em T2 (outro instante, outro id): regrava o valor aprovado e mantém as escritas com o mesmo hash', async () => {
    const b1 = banco(inicial());
    const p = await proporCaso({ tx: b1.tx, caso: 'k1', provedor: provedor(), fotografar: b1.fotografar, executar: processamento('2026-10-27T10:00:00.000Z', 'lote-a')(b1) });
    const b2 = banco(inicial());
    const r = await aplicarCaso({ tx: b2.tx, caso: 'k1', provedor: provedor(), fotografar: b2.fotografar, executar: processamento('2026-10-28T09:00:00.000Z', 'lote-b')(b2), regravar: regravar(b2) },
        { hash: p.hash, proposta: p.proposta });
    assert.equal(r.situacao, 'APLICADO');
    assert.equal(b2.estado.cancelada_em, '2026-10-27T10:00:00.000Z', 'data comercial do instante = a aprovada, não a de T2');
    assert.deepEqual(b2.sql, ['SAVEPOINT b14_caso', 'RELEASE SAVEPOINT b14_caso'], 'escritas mantidas para o COMMIT de quem chama');
});

test('aplicarCaso com leitura remota diferente → DIVERGENTE e tudo desfeito', async () => {
    const b1 = banco(inicial());
    const p = await proporCaso({ tx: b1.tx, caso: 'k1', provedor: provedor(), fotografar: b1.fotografar, executar: processamento('t1', 'lote-a')(b1) });
    const b2 = banco(inicial());
    const r = await aplicarCaso({ tx: b2.tx, caso: 'k1', provedor: provedor('ACTIVE'), fotografar: b2.fotografar, executar: processamento('t2', 'lote-b')(b2), regravar: regravar(b2) },
        { hash: p.hash, proposta: p.proposta });
    assert.equal(r.situacao, 'DIVERGENTE');
    assert.deepEqual(b2.estado, inicial());
    assert.deepEqual(b2.sql, ['SAVEPOINT b14_caso', 'ROLLBACK TO SAVEPOINT b14_caso', 'RELEASE SAVEPOINT b14_caso']);
});

test('aplicarCaso com estado local mudado depois do inventário → DIVERGENTE (pré-condição local)', async () => {
    const b1 = banco(inicial());
    const p = await proporCaso({ tx: b1.tx, caso: 'k1', provedor: provedor(), fotografar: b1.fotografar, executar: processamento('t1', 'lote-a')(b1) });
    const b2 = banco({ ...inicial(), sincronizado_em: 't-outro' });
    const r = await aplicarCaso({ tx: b2.tx, caso: 'k1', provedor: provedor(), fotografar: b2.fotografar, executar: processamento('t2', 'lote-b')(b2), regravar: regravar(b2) },
        { hash: p.hash, proposta: p.proposta });
    assert.equal(r.situacao, 'DIVERGENTE');
});

test('aplicarCaso recusa proposta adulterada (hash não confere) ou de outro caso, antes de qualquer SQL', async () => {
    const b1 = banco(inicial());
    const p = await proporCaso({ tx: b1.tx, caso: 'k1', provedor: provedor(), fotografar: b1.fotografar, executar: processamento('t1', 'lote-a')(b1) });
    const b2 = banco(inicial());
    const deps = { tx: b2.tx, caso: 'k1', provedor: provedor(), fotografar: b2.fotografar, executar: processamento('t2', 'lote-b')(b2), regravar: regravar(b2) };
    await assert.rejects(aplicarCaso(deps, { hash: p.hash, proposta: { ...p.proposta, efeitos: [] } }), /inconsistente/);
    await assert.rejects(aplicarCaso({ ...deps, caso: 'k2' }, { hash: p.hash, proposta: p.proposta }), /inconsistente/);
    assert.deepEqual(b2.sql, []);
});

test('gravarLeituras: só funções, objeto congelado, resultado copiado (mudança posterior não altera a pré-condição)', async () => {
    const r = { id: 'x', status: 'RECEIVED' };
    const g = gravarLeituras({ obterCobranca: async () => r, campo: 1 } as unknown as { obterCobranca: () => Promise<unknown> });
    await g.provedor.obterCobranca();
    r.status = 'REFUNDED';
    assert.deepEqual(g.leituras, [{ metodo: 'obterCobranca', args: [], resultado: { id: 'x', status: 'RECEIVED' } }]);
    assert.equal(Object.isFrozen(g.provedor), true);
    assert.equal((g.provedor as unknown as Record<string, unknown>).campo, undefined);
});

test('P3 (rodada 2): a leitura GRAVADA perde o texto livre do provedor antes do hash; o serviço recebe a leitura inteira', async () => {
    const marcador = 'TEXTO PESSOAL DO ESTORNO';
    const lida = { id: 'pay_1', status: 'REFUNDED', estornos: [{ status: 'DONE', valorCentavos: 100, descricao: marcador }] };
    const { provedor, leituras } = gravarLeituras({ obterCobranca: async () => lida });
    const recebida = await provedor.obterCobranca();
    assert.equal(recebida.estornos[0].descricao, marcador, 'o serviço continua com a leitura inteira');
    assert.equal(JSON.stringify(leituras).includes(marcador), false);
    assert.deepEqual(leituras[0].resultado, { id: 'pay_1', status: 'REFUNDED', estornos: [{ status: 'DONE', valorCentavos: 100 }] });
    assert.deepEqual([...CAMPOS_LIVRES_DO_PROVEDOR], ['descricao']);
    assert.deepEqual(minimizarLeitura([null, 1, 'x', { a: { descricao: 'y', b: [{ descricao: 'z', c: 2 }] } }]), [null, 1, 'x', { a: { b: [{ c: 2 }] } }]);
});
