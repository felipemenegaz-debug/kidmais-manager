import assert from 'node:assert/strict';
import test from 'node:test';
import { carregarModulo } from '../acessos/teste-carregador.ts';

/**
 * Regressão permanente do P1 da revisão independente (reprodução marcador-checkout.mjs, 08/10/2026): o checkout nunca
 * adota a assinatura de um marcador de exclusão aberto nem o encerra como VINCULADA. Banco e provedor são dublês; o banco
 * dublê aplica os filtros de prefixo das consultas (LIKE / NOT LIKE) como o PostgreSQL.
 */
const EMPRESA = '11111111-1111-4111-8111-111111111111';
const MARCADOR = '22222222-2222-4222-8222-222222222222';
const casaPrefixo = (valor: string, padrao: unknown) => typeof padrao === 'string' && valor.startsWith(padrao.replace(/%$/, ''));

function cenario(opcoes: { prefixo: 'remocao' | 'vinculo'; listagem: 'vazia' | 'unica' }) {
    const marcador = { id: MARCADOR, evento_id: `kidmais:${opcoes.prefixo}:${EMPRESA}:teste`, assinatura_provedor_id: 'sub_incerta', situacao: 'PENDENTE', ultimo_erro: 'REMOCAO_SEM_CONFIRMACAO' };
    const linha = { situacao: 'TESTE', ciclo: 'MENSAL', provedor_cliente_id: 'cus_teste', provedor_assinatura_id: null as string | null, provedor_situacao: null, documento_teste: '97310458000189', nome: 'Sintetica', hoje: '2026-10-08' };
    const assinatura = { id: 'sub_incerta', customer: 'cus_teste', externalReference: EMPRESA, status: 'ACTIVE', cycle: 'MONTHLY', deleted: false };
    const posts = { n: 0 };
    const aberto = () => (marcador.situacao === 'PENDENTE' ? [{ ...marcador }] : []);
    const tx = {
        async query(sql: string, p: unknown[] = []) {
            if (sql.startsWith('SELECT to_regclass')) return { rows: [{ ok: sql.includes('cobranca_eventos') }] };
            if (sql.startsWith('SELECT a.situacao')) return { rows: [{ ...linha }] };
            // marcadoresDeRemocao: evento_id LIKE 'kidmais:remocao:%'
            if (sql.startsWith('SELECT id, assinatura_provedor_id FROM cobranca_eventos')) return { rows: aberto().filter((m) => casaPrefixo(m.evento_id, p[2])) };
            // pendenciasAbertas: com o filtro NOT LIKE (versão corrigida) ou sem ele (versão antiga)
            if (sql.startsWith('SELECT id, evento_id, assinatura_provedor_id')) return { rows: aberto().filter((m) => !(sql.includes('evento_id NOT LIKE') && casaPrefixo(m.evento_id, p[2]))) };
            if (sql.startsWith('UPDATE empresa_assinaturas')) { linha.provedor_assinatura_id = p[2] as string; return { rows: [] }; }
            if (sql.startsWith("UPDATE cobranca_eventos SET situacao = 'PROCESSADO'")) {
                const protegido = sql.includes('evento_id NOT LIKE') && casaPrefixo(marcador.evento_id, p[4]);
                if ((p[1] as string[]).includes(marcador.id) && !protegido) Object.assign(marcador, { situacao: 'PROCESSADO', ultimo_erro: p[2] });
                return { rows: [] };
            }
            throw new Error(`SQL inesperado: ${sql.slice(0, 80)}`);
        },
    };
    const { iniciarAssinatura } = carregarModulo('lib/assinatura/cobranca.ts', {
        'db/postgres': {}, 'assinatura/sincronizacao': { sincronizarEmpresa: async () => ({}), auditarCobranca: async () => undefined },
        'assinatura/sincronizacao-auditoria': { auditarCobranca: async () => undefined },
    }) as { iniciarAssinatura: (...a: unknown[]) => Promise<{ reaproveitada: boolean }> };
    const provedor = {
        obterAssinatura: async () => assinatura,
        listarAssinaturasPorReferencia: async () => (opcoes.listagem === 'unica' ? [assinatura] : []),
        listarCobrancasDaAssinatura: async () => [],
        criarAssinatura: async () => { posts.n += 1; throw new Error('POST não esperado'); },
    };
    const deps = {
        provedor: () => provedor, env: { ASSINATURA_PRECO_MENSAL_CENTAVOS: '990' },
        withTransaction: async (w: (t: typeof tx) => unknown) => w(tx),
        withTenantTransaction: async (_s: unknown, _e: unknown, w: (t: typeof tx, tenant: unknown) => unknown) => w(tx, { papelAtual: 'REPRESENTANTE_AUTORIZADO', empresaComprovada: EMPRESA }),
        travarContratacao: async (_e: unknown, w: () => unknown) => w(),
    };
    const contratar = () => iniciarAssinatura({ usuario_id: 'ator' }, EMPRESA, { ciclo: 'MENSAL' }, { requestId: 'revisao' }, deps);
    return { contratar, marcador, linha, posts };
}
const codigo = async (p: Promise<unknown>) => { try { await p; return 'OK'; } catch (e) { return (e as { code?: string }).code ?? (e as Error).message; } };

test('P1 (reprodução da revisão): listagem vazia + GET ativo de assinatura com exclusão incerta → checkout não adota nem encerra o marcador', async () => {
    const c = cenario({ prefixo: 'remocao', listagem: 'vazia' });
    assert.equal(await codigo(c.contratar()), 'COBRANCA_RESULTADO_INCERTO');
    assert.deepEqual([c.linha.provedor_assinatura_id, c.marcador.situacao, c.marcador.ultimo_erro, c.posts.n], [null, 'PENDENTE', 'REMOCAO_SEM_CONFIRMACAO', 0]);
});

test('P1: listagem com uma única candidata, que está marcada → checkout não adota, não cria outra, marcador aberto', async () => {
    const c = cenario({ prefixo: 'remocao', listagem: 'unica' });
    assert.equal(await codigo(c.contratar()), 'COBRANCA_RESULTADO_INCERTO');
    assert.deepEqual([c.linha.provedor_assinatura_id, c.marcador.situacao, c.posts.n], [null, 'PENDENTE', 0]);
});

test('controle da reprodução: id durável de vínculo (kidmais:vinculo:) continua sendo retomado e encerrado como VINCULADA', async () => {
    const c = cenario({ prefixo: 'vinculo', listagem: 'vazia' });
    const r = await c.contratar();
    assert.equal(r.reaproveitada, true);
    assert.deepEqual([c.linha.provedor_assinatura_id, c.marcador.situacao, c.marcador.ultimo_erro, c.posts.n], ['sub_incerta', 'PROCESSADO', 'VINCULADA', 0]);
});
