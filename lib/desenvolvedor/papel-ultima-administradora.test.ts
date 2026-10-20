import assert from 'node:assert/strict';
import test from 'node:test';
import { carregarModulo, executorFalso } from '../acessos/teste-carregador.ts';

/**
 * Rebaixar Gestão → Equipe retira a elegibilidade de administrar o Perfil (056: elegível = membership
 * REPRESENTANTE_AUTORIZADO ativa naquela empresa). Quem é a última administradora do Perfil não pode ser rebaixada,
 * do mesmo jeito que não pode ser desativada nem removida (MENSAGEM_ULTIMA_ADMINISTRADORA: "antes de desativar,
 * revogar ou retirar a Gestão"). Vale para o painel do desenvolvedor e para Configurações > Usuários da empresa.
 * Módulos reais; só o banco é falso (respostas por SQL), e ele RESPEITA os parâmetros: o Perfil tem id próprio
 * (PERFIL ≠ EMP, como os criados por lib/perfil/criacao.ts), é achado pela empresa SaaS e as concessões só aparecem
 * quando consultadas pelo id do Perfil (filtro c.empresa_id = ANY($1) de avaliarPerdaDeElegibilidade).
 */
type Mod = Record<string, (...a: unknown[]) => Promise<unknown>>;

const agora = Date.now();
const EMP = '00000000-0000-4000-8000-0000000000a1';
const PERFIL = '00000000-0000-4000-8000-0000000000c1';
const ATOR = '00000000-0000-4000-8000-000000000001';
const ALVO = '00000000-0000-4000-8000-000000000002';
const OUTRA = '00000000-0000-4000-8000-000000000003';
const sessao = {
    id: 's', usuario_id: ATOR, nome: 'Pessoa', cargo: null, papel: 'REPRESENTANTE_AUTORIZADO',
    autenticado_em: new Date(agora - 60_000).toISOString(), consultado_em: new Date(agora).toISOString(), expira_em: new Date(agora + 3_600_000).toISOString(), csrf_hash: 'h',
};
const ctx = { requestId: '00000000-0000-4000-8000-0000000000f1', ip: null, userAgent: null };

/**
 * administradorasPerfil: quem tem PERFIL_ADMINISTRAR_CONCESSOES no Perfil; perfilInstalado=false simula banco anterior à
 * 026; perfilId=null simula empresa sem Perfil associado.
 */
function banco(administradorasPerfil: string[], perfilInstalado = true, perfilId: string | null = PERFIL) {
    const vinculo = { id: ALVO, membership_id: '00000000-0000-4000-8000-0000000000b2', usuario_id: ALVO, papel: 'REPRESENTANTE_AUTORIZADO', status: 'ATIVA', nome: 'Alvo', email: 'alvo@exemplo.test', conta_ativa: true, pode_assinar: false };
    return executorFalso([
        // Concessões do Perfil: só quando o filtro ($1) contém o id do PERFIL. Pelo id da empresa SaaS, nada.
        [/perfil_empresa_concessoes c/, (p) => perfilId && (p[0] as string[]).includes(perfilId)
            ? administradorasPerfil.map((usuario_id) => ({ empresa_id: perfilId, usuario_id, papel: 'REPRESENTANTE_AUTORIZADO', ativo: true }))
            : []],
        // perfilDoTenantOuNulo: o Perfil associado à empresa SaaS informada ($1).
        [/FROM public\.perfil_empresas p[\s\S]*WHERE e\.id=\$1::uuid/, (p) => (p[0] === EMP && perfilId ? [{ id: perfilId }] : [])],
        [/to_regclass\('public\.perfil_empresas'\)/, () => [perfilInstalado ? { empresas: 'perfil_empresas', concessoes: 'perfil_empresa_concessoes' } : { empresas: null, concessoes: null }]],
        [/FROM usuarios_administrativos WHERE id=\$1 FOR UPDATE/, () => [{ id: ALVO, nome: 'Alvo', email: 'alvo@exemplo.test', papel: 'ADMINISTRATIVO', ativo: true }]],
        [/plataforma_desenvolvedores/, () => [{ id: 'dev' }]],
        [/SELECT id FROM empresas WHERE id = \$1::uuid FOR UPDATE/, () => [{ id: EMP }]],
        [/count\(\*\)::int AS n FROM memberships/, () => [{ n: 1 }]],
        [/^UPDATE memberships SET papel/, () => []],
        [/FROM memberships m JOIN usuarios_administrativos u ON u\.id = m\.usuario_id[\s\S]*FOR UPDATE OF m/, () => [vinculo]],
    ]);
}

function carregar(tx: ReturnType<typeof banco>) {
    const auditorias: Array<{ acao: string }> = [];
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
        painel: (nivel: string) => vinculos.alterarPapelVinculo(sessao, EMP, ALVO, { nivel }, ctx, deps),
        empresa: (nivel: string) => usuarios.alterarPapelNaEmpresa(sessao, { acao: 'papel', usuarioId: ALVO, nivel }, 'r', { ...deps, criacaoDireta: () => false }, EMP),
    };
}

const rebaixou = (tx: ReturnType<typeof banco>) => tx.executados.some((q) => /^UPDATE memberships SET papel/.test(q.sql));
const travouPerfil = (tx: ReturnType<typeof banco>, id: string) => tx.executados.some((q) => /pg_advisory_xact_lock/.test(q.sql) && q.params[0] === `kidmais:perfil-empresa:${id}`);

for (const [fluxo, codigo] of [['painel', 'ULTIMA_ADMINISTRADORA'], ['empresa', 'PERFIL_ULTIMA_ADMINISTRADORA']] as const) {
    test(`${fluxo}: rebaixar a última administradora do Perfil para Equipe é recusado (409), sem alterar o papel`, async () => {
        const tx = banco([ALVO]);
        const m = carregar(tx);
        await assert.rejects(m[fluxo]('EQUIPE'), (e: { code?: string; httpStatus?: number }) => e.code === codigo && e.httpStatus === 409);
        assert.equal(rebaixou(tx), false, 'o papel não pode mudar');
        assert.equal(m.auditorias.length, 0, 'nenhuma alteração auditada');
        assert.ok(travouPerfil(tx, PERFIL) && !travouPerfil(tx, EMP), 'a trava e a consulta usam o id do Perfil, não o da empresa SaaS');
    });

    test(`${fluxo}: empresa sem Perfil associado → nada a proteger, o rebaixamento segue (guarda)`, async () => {
        const tx = banco([ALVO], true, null);
        const m = carregar(tx);
        await m[fluxo]('EQUIPE');
        assert.equal(rebaixou(tx), true);
    });

    test(`${fluxo}: com outra administradora do Perfil, o rebaixamento segue (guarda)`, async () => {
        const tx = banco([ALVO, OUTRA]);
        const m = carregar(tx);
        await m[fluxo]('EQUIPE');
        assert.equal(rebaixou(tx), true);
    });

    test(`${fluxo}: sem a estrutura do Perfil (antes da 026), o rebaixamento segue (guarda)`, async () => {
        const tx = banco([ALVO], false);
        const m = carregar(tx);
        await m[fluxo]('EQUIPE');
        assert.equal(rebaixou(tx), true);
    });
}
