import assert from 'node:assert/strict';
import test from 'node:test';
import { carregarModulo, executorFalso } from '../acessos/teste-carregador.ts';

/**
 * Painel do desenvolvedor, cobrança (E8) sem banco nem provedor: senha recente antes de tudo, provedor ausente
 * recusa sem abrir transação, concessão conferida DENTRO da transação antes de sincronizar, falha do provedor vira 502
 * sem auditoria de sucesso, e a auditoria da sincronização é gravada na mesma transação.
 */
type Fn = (...args: never[]) => Promise<unknown>;
type Falha = new (operacao: string, status: number | null, motivo: string) => Error;
const EMPRESA = '00000000-0000-4000-8000-0000000000e1';
const agora = Date.now();
const sessao = (autenticadoHaMs = 60_000) => ({
    id: 's', usuario_id: '00000000-0000-4000-8000-000000000001', nome: 'Pessoa', cargo: null, papel: 'REPRESENTANTE_AUTORIZADO',
    autenticado_em: new Date(agora - autenticadoHaMs).toISOString(), consultado_em: new Date(agora).toISOString(), expira_em: new Date(agora + 3_600_000).toISOString(), csrf_hash: 'h',
});
const ctx = { requestId: 'req-1', ip: null, userAgent: null };

function carregar(opcoes: { concedido?: boolean; sincronizar?: (F: Falha) => Promise<unknown>; liberar?: (F: Falha) => Promise<unknown> } = {}) {
    const cache = new Map<string, Record<string, unknown>>();
    const chamadas = { sincronizar: 0, liberar: 0, transacoes: 0, provedor: 0 };
    const auditorias: Array<{ input: Record<string, unknown>; tx: unknown }> = [];
    // A classe AsaasFalhou tem de ser a do mesmo carregamento de cobranca.ts (instanceof).
    const asaas = { AsaasFalhou: Error as unknown as Falha };
    const dubles = {
        'desenvolvedor/interessadas': { painelDepsPadrao: {} },
        'assinatura/sincronizacao': { sincronizarEmpresa: async () => { chamadas.sincronizar += 1; return (opcoes.sincronizar ?? (async () => ({ resultado: 'SINCRONIZADA', antes: 'TESTE', depois: 'ATIVA', mudou: true, provedorSituacao: 'ACTIVE' })))(asaas.AsaasFalhou); } },
        'assinatura/liberacao-intencao': { pendenciasDaEmpresa: async () => [], liberarIntencaoCriacao: async () => { chamadas.liberar += 1; return (opcoes.liberar ?? (async () => ({ liberada: true })))(asaas.AsaasFalhou); } },
    };
    asaas.AsaasFalhou = (carregarModulo('lib/assinatura/asaas.ts', dubles, cache) as { AsaasFalhou: Falha }).AsaasFalhou;
    const mod = carregarModulo('lib/desenvolvedor/cobranca.ts', dubles, cache) as Record<string, Fn>;
    const tx = executorFalso([
        [/FROM plataforma_desenvolvedores/, () => (opcoes.concedido === false ? [] : [{ id: 'd' }])],
        [/to_regclass\('public\.cobranca_eventos'\)/, () => [{ ok: true }]],
    ]);
    const deps = (comProvedor = true) => ({
        withTransaction: async (fn: (t: typeof tx) => Promise<unknown>) => { chamadas.transacoes += 1; return fn(tx); },
        registrarAuditoria: async (input: Record<string, unknown>, t?: unknown) => { auditorias.push({ input, tx: t }); },
        provedor: () => { chamadas.provedor += 1; return comProvedor ? {} : null; },
    });
    return { mod, deps, chamadas, auditorias, tx };
}
const codigo = (esperado: string, status: number) => (e: unknown) => {
    const x = e as { code?: string; httpStatus?: number };
    assert.deepEqual([x.code, x.httpStatus], [esperado, status]);
    return true;
};

test('cobrança no painel: senha confirmada há mais de 5 min recusa antes de consultar provedor ou banco', async () => {
    const { mod, deps, chamadas } = carregar();
    await assert.rejects(mod.sincronizarCobrancaEmpresa(sessao(10 * 60_000) as never, EMPRESA as never, ctx as never, deps() as never), codigo('REAUTENTICACAO', 403));
    await assert.rejects(mod.liberarIntencaoCobranca(sessao(10 * 60_000) as never, EMPRESA as never, {} as never, ctx as never, deps() as never), codigo('REAUTENTICACAO', 403));
    assert.deepEqual(chamadas, { sincronizar: 0, liberar: 0, transacoes: 0, provedor: 0 });
});

test('cobrança no painel: sem provedor configurado responde 503 sem abrir transação', async () => {
    const { mod, deps, chamadas } = carregar();
    await assert.rejects(mod.sincronizarCobrancaEmpresa(sessao() as never, EMPRESA as never, ctx as never, deps(false) as never), codigo('COBRANCA_NAO_CONFIGURADA', 503));
    await assert.rejects(mod.liberarIntencaoCobranca(sessao() as never, EMPRESA as never, {} as never, ctx as never, deps(false) as never), codigo('COBRANCA_NAO_CONFIGURADA', 503));
    assert.equal(chamadas.transacoes, 0);
});

test('cobrança no painel: sem concessão na transação recusa (404) e não sincroniza nem audita', async () => {
    const { mod, deps, chamadas, auditorias } = carregar({ concedido: false });
    await assert.rejects(mod.sincronizarCobrancaEmpresa(sessao() as never, EMPRESA as never, ctx as never, deps() as never), codigo('NAO_ENCONTRADO', 404));
    assert.deepEqual([chamadas.sincronizar, auditorias.length], [0, 0]);
});

test('cobrança no painel: falha do provedor vira 502 "nada foi alterado/liberado", sem auditoria de sucesso', async () => {
    const proprio = carregar({ sincronizar: async (F) => { throw new F('obter assinatura', null, 'REDE'); }, liberar: async (F) => { throw new F('listar assinaturas', null, 'LISTA_INCOMPLETA'); } });
    await assert.rejects(proprio.mod.sincronizarCobrancaEmpresa(sessao() as never, EMPRESA as never, ctx as never, proprio.deps() as never), (e: unknown) => codigo('COBRANCA_FALHOU', 502)(e) && /Nada foi alterado/.test((e as Error).message));
    await assert.rejects(proprio.mod.liberarIntencaoCobranca(sessao() as never, EMPRESA as never, {} as never, ctx as never, proprio.deps() as never), (e: unknown) => codigo('COBRANCA_FALHOU', 502)(e) && /Nada foi liberado/.test((e as Error).message));
    assert.equal(proprio.auditorias.length, 0);
    // Lista incompleta não é "não respondeu": a mensagem manda conferir no provedor.
    await assert.rejects(proprio.mod.liberarIntencaoCobranca(sessao() as never, EMPRESA as never, {} as never, ctx as never, proprio.deps() as never), (e: unknown) => /mais registros desta empresa do que o limite conferido\. Nada foi liberado\. Confira no painel do Asaas/.test((e as Error).message));
});

test('cobrança no painel: sincronização auditada na MESMA transação, com o ator e a empresa alvo', async () => {
    const { mod, deps, auditorias, tx } = carregar();
    const r = await mod.sincronizarCobrancaEmpresa(sessao() as never, EMPRESA as never, ctx as never, deps() as never) as { resultado: string };
    assert.equal(r.resultado, 'SINCRONIZADA');
    assert.equal(auditorias.length, 1);
    assert.equal(auditorias[0].tx, tx);
    assert.equal(auditorias[0].input.acao, 'COBRANCA_SINCRONIZADA');
    assert.deepEqual([auditorias[0].input.usuarioId, auditorias[0].input.origem, (auditorias[0].input.dadosDepois as Record<string, unknown>).empresaId], [sessao().usuario_id, 'PAINEL_DESENVOLVEDOR', EMPRESA]);
    assert.equal(auditorias[0].input.entidadeId, EMPRESA);
    const ordem = tx.executados.map((e) => e.sql);
    assert.ok(ordem.findIndex((s) => /plataforma_desenvolvedores/.test(s)) === 0, 'concessão conferida antes de qualquer outra consulta');
});
