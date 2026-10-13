import assert from 'node:assert/strict';
import test from 'node:test';
import { carregarModulo, executorFalso } from '../acessos/teste-carregador.ts';

/**
 * R2: remover a pessoa da empresa (Configurações > Usuários) e desativar o vínculo (painel do desenvolvedor) tiram a
 * elegibilidade de administrar o Perfil da empresa, como o rebaixamento da #157. As duas operações precisam avaliar a
 * última administradora pelo id do PERFIL (id próprio, associado à empresa SaaS por código; lib/perfil/criacao.ts), e a
 * remoção precisa revogar as concessões da pessoa NESSE Perfil. Módulos reais; o banco é falso e RESPEITA os
 * parâmetros: o Perfil é achado pela empresa SaaS, as concessões só aparecem pelo id do Perfil consultado.
 */
type Mod = Record<string, (...a: unknown[]) => Promise<unknown>>;

const agora = Date.now();
const EMP = '00000000-0000-4000-8000-0000000000a1';
const PERFIL = '00000000-0000-4000-8000-0000000000c1';
const PERFIL_OUTRO = '00000000-0000-4000-8000-0000000000c2';
const ATOR = '00000000-0000-4000-8000-000000000001';
const ALVO = '00000000-0000-4000-8000-000000000002';
const OUTRA = '00000000-0000-4000-8000-000000000003';
const sessao = {
    id: 's', usuario_id: ATOR, nome: 'Pessoa', cargo: null, papel: 'REPRESENTANTE_AUTORIZADO',
    autenticado_em: new Date(agora - 60_000).toISOString(), consultado_em: new Date(agora).toISOString(), expira_em: new Date(agora + 3_600_000).toISOString(), csrf_hash: 'h',
};
const ctx = { requestId: '00000000-0000-4000-8000-0000000000f1', ip: null, userAgent: null };

/**
 * administradoras: quem tem PERFIL_ADMINISTRAR_CONCESSOES em cada Perfil. perfisDaEmpresa: os Perfis associados à
 * empresa SaaS (vazio = sem Perfil; dois = associação ambígua). perfilInstalado=false simula banco anterior à 026.
 */
function banco(administradoras: Record<string, string[]>, perfisDaEmpresa: string[] = [PERFIL], perfilInstalado = true) {
    const vinculo = { id: ALVO, membership_id: '00000000-0000-4000-8000-0000000000b2', usuario_id: ALVO, papel: 'REPRESENTANTE_AUTORIZADO', status: 'ATIVA', nome: 'Alvo', email: 'alvo@exemplo.test', conta_ativa: true, pode_assinar: false };
    return executorFalso([
        // Concessões: só as dos Perfis pedidos em $1. Pelo id da empresa SaaS, nada.
        [/perfil_empresa_concessoes c/, (p) => (p[0] as string[]).flatMap((perfil) => (administradoras[perfil] ?? [])
            .map((usuario_id) => ({ empresa_id: perfil, usuario_id, papel: 'REPRESENTANTE_AUTORIZADO', ativo: true })))],
        // revogarConcessoesAtivasDoUsuario: devolve as concessões do usuário ($1) no Perfil filtrado ($4).
        [/^UPDATE public\.perfil_empresa_concessoes/, (p) => Object.entries(administradoras)
            .filter(([perfil, lista]) => (p[3] === null || p[3] === perfil) && lista.includes(String(p[0])))
            .map(([perfil]) => ({ id: `concessao-${perfil}`, empresa_id: perfil, capacidade: 'PERFIL_ADMINISTRAR_CONCESSOES' }))],
        // perfilDoTenantOuNulo: os Perfis associados à empresa SaaS informada ($1).
        [/FROM public\.perfil_empresas p[\s\S]*WHERE e\.id=\$1::uuid/, (p) => (p[0] === EMP ? perfisDaEmpresa.map((id) => ({ id })) : [])],
        [/to_regclass\('public\.perfil_empresas'\)/, () => [perfilInstalado ? { empresas: 'perfil_empresas', concessoes: 'perfil_empresa_concessoes' } : { empresas: null, concessoes: null }]],
        [/FROM usuarios_administrativos WHERE id=\$1 FOR UPDATE/, () => [{ id: ALVO, nome: 'Alvo', email: 'alvo@exemplo.test', papel: 'ADMINISTRATIVO', ativo: true }]],
        [/plataforma_desenvolvedores/, () => [{ id: 'dev' }]],
        [/SELECT id FROM empresas WHERE id = \$1::uuid FOR UPDATE/, () => [{ id: EMP }]],
        [/count\(\*\)::int AS n FROM memberships/, () => [{ n: 1 }]],
        [/FROM memberships m JOIN usuarios_administrativos u ON u\.id = m\.usuario_id[\s\S]*FOR UPDATE OF m/, () => [vinculo]],
    ]);
}

function carregar(tx: ReturnType<typeof banco>) {
    const auditorias: Array<{ acao: string; dadosDepois?: Record<string, unknown> }> = [];
    const withTransaction = async (fn: (t: unknown) => unknown) => fn(tx);
    const dubles = {
        'db/postgres': { db: () => tx, withTransaction },
        'clientes/repositories/auditoria.repository': { registrarAuditoria: async (input: { acao: string }) => { auditorias.push(input); return {}; } },
        'saas/provar-tenant': {
            travarUsuariosNaOrdem: async () => undefined,
            executarNoTenant: async (t: unknown, _s: unknown, _e: unknown, work: (t: unknown, tenant: unknown) => Promise<unknown>) => work(t, { empresaComprovada: EMP, papelAtual: 'REPRESENTANTE_AUTORIZADO' }),
        },
    };
    const cache = new Map<string, Record<string, unknown>>();
    const vinculos = carregarModulo('lib/desenvolvedor/vinculos.ts', dubles, cache) as Mod;
    const usuarios = carregarModulo('lib/autenticacao/usuarios.ts', dubles, cache) as Mod;
    const deps = { withTransaction, registrarAuditoria: dubles['clientes/repositories/auditoria.repository'].registrarAuditoria, enviarEmail: async () => undefined, gerarToken: () => 'x' };
    return {
        auditorias,
        painel: () => vinculos.alterarSituacaoVinculo(sessao, EMP, ALVO, 'desativar', { motivo: 'Teste R2' }, ctx, deps),
        empresa: () => usuarios.removerDaEmpresa(sessao, { acao: 'remover', usuarioId: ALVO, confirmar: true }, 'r', { ...deps, criacaoDireta: () => false }, EMP),
    };
}

const alterouVinculo = (tx: ReturnType<typeof banco>) => tx.executados.some((q) => /^UPDATE memberships SET status/.test(q.sql));
const revogacoesPerfil = (tx: ReturnType<typeof banco>) => tx.executados.filter((q) => /^UPDATE public\.perfil_empresa_concessoes/.test(q.sql));
const travouPerfil = (tx: ReturnType<typeof banco>, id: string) => tx.executados.some((q) => /pg_advisory_xact_lock/.test(q.sql) && q.params[0] === `kidmais:perfil-empresa:${id}`);
const consultouConcessoesCom = (tx: ReturnType<typeof banco>) => tx.executados.filter((q) => /perfil_empresa_concessoes c/.test(q.sql)).map((q) => q.params[0]);

for (const [fluxo, codigo] of [['painel', 'ULTIMA_ADMINISTRADORA'], ['empresa', 'PERFIL_ULTIMA_ADMINISTRADORA']] as const) {
    const operacao = fluxo === 'painel' ? 'desativar o vínculo' : 'remover da empresa';

    test(`${fluxo}: ${operacao} da última administradora do Perfil (id próprio ≠ empresa SaaS) é recusado (409), sem alterar acessos`, async () => {
        const tx = banco({ [PERFIL]: [ALVO] });
        const m = carregar(tx);
        await assert.rejects(m[fluxo](), (e: { code?: string; httpStatus?: number }) => e.code === codigo && e.httpStatus === 409);
        assert.equal(alterouVinculo(tx), false, 'o vínculo não pode mudar');
        assert.equal(revogacoesPerfil(tx).length, 0, 'nenhuma concessão revogada');
        assert.equal(m.auditorias.length, 0, 'nenhuma alteração auditada');
        assert.ok(travouPerfil(tx, PERFIL) && !travouPerfil(tx, EMP), 'a trava usa o id do Perfil, não o da empresa SaaS');
        assert.deepEqual(consultouConcessoesCom(tx), [[PERFIL]], 'as concessões são consultadas só pelo id do Perfil');
    });

    test(`${fluxo}: administradora de OUTRO Perfil não conta → ${operacao} da única administradora deste Perfil continua recusado`, async () => {
        const tx = banco({ [PERFIL]: [ALVO], [PERFIL_OUTRO]: [OUTRA] });
        const m = carregar(tx);
        await assert.rejects(m[fluxo](), (e: { code?: string; httpStatus?: number }) => e.code === codigo && e.httpStatus === 409);
        assert.equal(alterouVinculo(tx), false);
        assert.ok(!travouPerfil(tx, PERFIL_OUTRO), 'o outro Perfil não é travado nem avaliado');
    });

    test(`${fluxo}: Perfil ambíguo (duas associações) → 409 sem alterar acessos`, async () => {
        const tx = banco({ [PERFIL]: [ALVO, OUTRA] }, [PERFIL, PERFIL_OUTRO]);
        const m = carregar(tx);
        await assert.rejects(m[fluxo](), (e: { code?: string; httpStatus?: number }) => e.code === 'PERFIL_ESTRUTURA_AUSENTE' && e.httpStatus === 409);
        assert.equal(alterouVinculo(tx), false, 'o vínculo não pode mudar');
        assert.equal(revogacoesPerfil(tx).length, 0, 'nenhuma concessão revogada');
        assert.equal(consultouConcessoesCom(tx).length, 0, 'não escolhe um dos Perfis');
        assert.equal(m.auditorias.length, 0);
    });

    test(`${fluxo}: com outra administradora do Perfil, ${operacao} segue (guarda)`, async () => {
        const tx = banco({ [PERFIL]: [ALVO, OUTRA] });
        const m = carregar(tx);
        await m[fluxo]();
        assert.equal(alterouVinculo(tx), true);
    });

    test(`${fluxo}: empresa sem Perfil associado → nada a proteger, ${operacao} segue (guarda)`, async () => {
        const tx = banco({ [PERFIL]: [ALVO] }, []);
        const m = carregar(tx);
        await m[fluxo]();
        assert.equal(alterouVinculo(tx), true);
        assert.equal(revogacoesPerfil(tx).length, 0, 'sem Perfil, nenhuma revogação');
    });

    test(`${fluxo}: sem a estrutura do Perfil (antes da 026), ${operacao} segue (guarda)`, async () => {
        const tx = banco({ [PERFIL]: [ALVO] }, [PERFIL], false);
        const m = carregar(tx);
        await m[fluxo]();
        assert.equal(alterouVinculo(tx), true);
        assert.equal(revogacoesPerfil(tx).length, 0);
    });
}

test('empresa: remover revoga as concessões da pessoa no Perfil DESTA empresa (id do Perfil), e só nele', async () => {
    const tx = banco({ [PERFIL]: [ALVO, OUTRA], [PERFIL_OUTRO]: [ALVO] });
    const m = carregar(tx);
    await m.empresa();
    const revogacoes = revogacoesPerfil(tx);
    assert.equal(revogacoes.length, 1);
    assert.equal(revogacoes[0].params[0], ALVO, 'só a pessoa removida');
    assert.equal(revogacoes[0].params[3], PERFIL, 'filtro pelo id do Perfil, nunca pelo id da empresa SaaS nem sem filtro');
    const auditoria = m.auditorias.find((a) => a.acao === 'MEMBERSHIP_REMOVIDA');
    assert.equal(auditoria?.dadosDepois?.concessoesPerfil, 1, 'a auditoria conta a concessão revogada');
});

test('painel: desativar o vínculo não revoga concessões (só suspende; a elegibilidade cai pela membership)', async () => {
    const tx = banco({ [PERFIL]: [ALVO, OUTRA] });
    const m = carregar(tx);
    await m.painel();
    assert.equal(revogacoesPerfil(tx).length, 0);
});
