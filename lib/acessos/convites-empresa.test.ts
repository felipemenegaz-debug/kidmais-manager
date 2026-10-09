import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { carregarModulo, executorFalso } from './teste-carregador.ts';

/**
 * E1 — convites feitos pela Gestão da própria empresa e criação direta atrás de configuração. Sem banco: o tenant é
 * dublado (provarTenant tem os próprios testes PostgreSQL) e o executor responde por SQL.
 */
type Mod = Record<string, (...args: never[]) => Promise<unknown>>;
const EMPRESA = '00000000-0000-4000-8000-0000000000e1';
const OUTRA = '00000000-0000-4000-8000-0000000000e2';
const USUARIO = '00000000-0000-4000-8000-000000000001';

class Falha extends Error {
    httpStatus: number;
    constructor(message: string, httpStatus: number) { super(message); this.httpStatus = httpStatus; }
}

function carregar(papelAtual: string, empresaVista: string[] = [], arquivo = 'lib/acessos/convites-empresa.ts') {
    return carregarModulo(arquivo, {
        'db/postgres': { withTransaction: () => { throw new Error('sem banco'); } },
        'autenticacao/service': { authError: (m: string, s = 401) => new Falha(m, s), consumirLimite: async () => true, prazoDoLimite: async () => null },
        'autenticacao/usuarios': {
            marcarAtor: async (tx: { query: (sql: string, p: unknown[]) => unknown }, id: string) => tx.query("SELECT set_config('kidmais.ator_usuario_id', $1, true)", [id]),
            concederPerfilFesta: async () => ({}), inserirIdentidadeNeutra: async () => 'id',
        },
        'acessos/senha-propria': { validarNovaSenha: () => undefined },
        'saas/provar-tenant': {
            executarNoTenant: async (tx: unknown, _sessao: unknown, solicitada: string | null, work: (t: unknown, tenant: unknown) => Promise<unknown>) => {
                empresaVista.push(String(solicitada));
                return work(tx, { empresaComprovada: EMPRESA, membershipId: 'm1', usuarioId: USUARIO, papelAtual });
            },
        },
    }, new Map()) as Mod;
}

const sessao = { id: 's1', usuario_id: USUARIO, nome: 'Gestão', cargo: null, papel: 'ADMINISTRATIVO', autenticado_em: '', expira_em: '', csrf_hash: '' };
const ctx = { requestId: 'req-1', ip: null, userAgent: 'teste' };

function cenario(opcoes: { vinculo?: string; envioFalha?: boolean; vagas?: { ativos: number; pendentes: number } } = {}) {
    const tx = executorFalso([
        [/AS instalado074/, () => [{ instalado074: !!opcoes.vagas }]],
        [/AS isenta/, () => [{ isenta: false }]],
        [/SELECT c.plano/, () => [{ plano: 'ESSENCIAL' }]],
        [/AS ativos/, () => opcoes.vagas ? [opcoes.vagas] : []],
        [/SELECT status FROM empresas/, () => [{ status: 'ATIVA' }]],
        [/FROM memberships m JOIN usuarios_administrativos/, () => (opcoes.vinculo ? [{ status: opcoes.vinculo }] : [])],
        [/INSERT INTO convites_acesso/, () => [{ id: 'c1', expira_em: '2026-10-13' }]],
        [/SELECT nome FROM empresas/, () => [{ nome: 'Buffet Teste' }]],
    ]);
    const auditoria: Array<Record<string, unknown>> = [];
    const emails: Array<Record<string, unknown>> = [];
    const deps = {
        withTransaction: async (w: (t: typeof tx) => Promise<unknown>) => w(tx),
        registrarAuditoria: async (input: Record<string, unknown>) => { auditoria.push(input); return input; },
        enviarEmail: async (m: Record<string, unknown>) => { if (opcoes.envioFalha) throw new Error('falhou'); emails.push(m); },
        gerarToken: () => 'T'.repeat(43),
    };
    return { tx, deps, auditoria, emails };
}

test('limite do plano recusa novo convite antes de gravar, auditar ou enviar email', async () => {
    const mod = carregar('REPRESENTANTE_AUTORIZADO');
    for (const vagas of [{ ativos: 1, pendentes: 2 }, { ativos: 5, pendentes: 0 }]) {
        const { tx, deps, auditoria, emails } = cenario({ vagas });
        await assert.rejects(mod.convidarNaEmpresa(sessao as never,
            { acao: 'convidar', email: 'nova@exemplo.com', nivel: 'EQUIPE' } as never,
            ctx as never, deps as never), { code: 'LIMITE_USUARIOS_PLANO' });
        assert.ok(!tx.executados.some(q => /INSERT INTO convites_acesso|UPDATE memberships/.test(q.sql)));
        assert.equal(emails.length, 0);
        assert.equal(auditoria.length, 0);
    }
});

test('reenvio mantém reserva válida acima do limite, mas convite vencido precisa de vaga', async () => {
    const mod = carregar('REPRESENTANTE_AUTORIZADO', [], 'lib/acessos/convites.ts');
    for (const expirado of [false, true]) {
        const tx = executorFalso([
            [/AS instalado074/, () => [{ instalado074: true }]],
            [/AS isenta/, () => [{ isenta: false }]],
            [/SELECT c.plano/, () => [{ plano: 'ESSENCIAL' }]],
            [/AS ativos/, () => [{ ativos: 5, pendentes: expirado ? 0 : 1 }]],
            [/FROM convites_acesso c WHERE c.id/, () => [{ id: 'c1', empresa_id: EMPRESA, status: 'PENDENTE', expirado, envios: 1, segundos_desde_envio: 70 }]],
            [/UPDATE convites_acesso SET token_hash/, () => [{ expira_em: '2026-10-16' }]],
        ]);
        const chamada = () => mod.renovarConviteNaTransacao(tx as never, { gerarToken: () => 'T'.repeat(43) } as never, EMPRESA as never, 'c1' as never);
        if (expirado) {
            await assert.rejects(chamada(), { code: 'LIMITE_USUARIOS_PLANO' });
            assert.ok(!tx.executados.some(q => /UPDATE convites_acesso/.test(q.sql)));
        } else {
            await chamada();
            assert.ok(tx.executados.some(q => /UPDATE convites_acesso SET token_hash/.test(q.sql)));
        }
        assert.match(tx.executados[0].sql, /FROM empresas.*FOR UPDATE/);
    }
});

test('aceite converte reserva válida no limite e acima dele; expiração na conclusão aborta a transação', async () => {
    const mod = carregar('REPRESENTANTE_AUTORIZADO', [], 'lib/acessos/convites.ts');
    for (const [ativos, expiraAoConcluir] of [[2, false], [5, false], [2, true]] as const) {
        const falso = executorFalso([
            [/FROM convites_acesso c WHERE c.token_hash/, () => [{ id: 'c1', empresa_id: EMPRESA, email: 'pessoa@example.invalid',
                status: 'PENDENTE', expirado: false, papel: 'ADMINISTRATIVO', criado_por: USUARIO }]],
            [/SELECT id, senha_hash, ativo FROM usuarios_administrativos/, () => [{ id: USUARIO, senha_hash: 'h', ativo: true }]],
            [/SELECT nome, status FROM empresas/, () => [{ nome: 'Empresa Sintética', status: 'ATIVA' }]],
            [/AS instalado074/, () => [{ instalado074: true }]],
            [/AS isenta/, () => [{ isenta: false }]],
            [/SELECT c.plano/, () => [{ plano: 'ESSENCIAL' }]],
            [/AS ativos/, () => [{ ativos, pendentes: 1 }]],
            [/INSERT INTO memberships/, () => [{ id: 'm1' }]],
            [/UPDATE convites_acesso SET status = 'ACEITO'/, () => expiraAoConcluir ? [] : [{ id: 'c1' }]],
        ]);
        const tx = { ...falso, query: async (sql: string, params: unknown[] = []) => {
            const r = await falso.query(sql, params); return { ...r, rowCount: r.rows.length };
        } };
        let commits = 0, rollbacks = 0, auditorias = 0;
        const deps = {
            withTransaction: async (w: (t: typeof tx) => Promise<unknown>) => {
                try { const r = await w(tx); commits++; return r; } catch (e) { rollbacks++; throw e; }
            },
            conferirSenha: async () => true,
            registrarAuditoria: async () => { auditorias++; },
        };
        const aceitar = () => mod.aceitarConvite({ token: 'T'.repeat(43), senha: 'senha-sintetica' } as never, ctx as never, deps as never);
        if (expiraAoConcluir) {
            await assert.rejects(aceitar(), { code: 'LINK_INVALIDO', httpStatus: 410 });
            assert.equal(commits, 0); assert.equal(rollbacks, 1); assert.equal(auditorias, 0);
        } else {
            assert.equal((await aceitar() as { aceito: boolean }).aceito, true);
            assert.equal(commits, 1); assert.equal(rollbacks, 0); assert.equal(auditorias, 1);
        }
        const concluir = tx.executados.find(q => /UPDATE convites_acesso SET status = 'ACEITO'/.test(q.sql))!;
        assert.match(concluir.sql, /status = 'PENDENTE' AND expira_em > clock_timestamp\(\)/);
    }
});

test('token cancelado, substituído ou expirado enquanto aguarda a empresa é revalidado antes da senha', async () => {
    const mod = carregar('REPRESENTANTE_AUTORIZADO', [], 'lib/acessos/convites.ts');
    const inicial = { id: 'c1', empresa_id: EMPRESA, email: 'pessoa@example.invalid', status: 'PENDENTE', expirado: false };
    for (const atual of [null, { ...inicial, status: 'CANCELADO' }, { ...inicial, expirado: true }, { ...inicial, empresa_id: OUTRA }]) {
        let leituras = 0, senhas = 0;
        const tx = executorFalso([
            [/FROM convites_acesso c WHERE c.token_hash/, () => ++leituras === 1 ? [inicial] : atual ? [atual] : []],
            [/SELECT id, senha_hash, ativo FROM usuarios_administrativos/, () => [{ id: USUARIO, senha_hash: 'h', ativo: true }]],
            [/SELECT nome, status FROM empresas/, () => [{ nome: 'Empresa Sintética', status: 'ATIVA' }]],
        ]);
        const deps = { withTransaction: async (w: (t: typeof tx) => Promise<unknown>) => w(tx),
            conferirSenha: async () => { senhas++; return true; } };
        await assert.rejects(mod.aceitarConvite({ token: 'T'.repeat(43), senha: 'senha-sintetica' } as never, ctx as never, deps as never),
            { code: 'LINK_INVALIDO', httpStatus: 410 });
        assert.equal(leituras, 2); assert.equal(senhas, 0);
        assert.ok(!tx.executados.some(q => /^(INSERT|UPDATE)/.test(q.sql)));
    }
});

test('Equipe não convida: 403 antes de qualquer gravação', async () => {
    const mod = carregar('ADMINISTRATIVO');
    const { tx, deps } = cenario();
    await assert.rejects(mod.convidarNaEmpresa(sessao as never, { acao: 'convidar', email: 'pessoa@exemplo.com', nivel: 'EQUIPE' } as never, ctx as never, deps as never),
        (e: Falha) => e.httpStatus === 403);
    assert.ok(!tx.executados.some((q) => /INSERT INTO convites_acesso/.test(q.sql)));
});

test('Gestão convida na empresa COMPROVADA; empresaId no corpo é recusado; e-mail normalizado; nada de token na resposta ou auditoria', async () => {
    const vistas: string[] = [];
    const mod = carregar('REPRESENTANTE_AUTORIZADO', vistas);
    const { tx, deps, auditoria, emails } = cenario();
    await assert.rejects(mod.convidarNaEmpresa(sessao as never, { acao: 'convidar', email: 'a@b.com', nivel: 'EQUIPE', empresaId: OUTRA } as never, ctx as never, deps as never));
    const r = await mod.convidarNaEmpresa(sessao as never, { acao: 'convidar', email: '  Pessoa@Exemplo.COM ', nome: 'Pessoa', nivel: 'GESTAO' } as never, ctx as never, deps as never, EMPRESA as never) as Record<string, unknown>;
    assert.deepEqual(vistas.at(-1), EMPRESA);
    const insert = tx.executados.find((q) => /INSERT INTO convites_acesso/.test(q.sql));
    assert.ok(insert);
    assert.equal(insert.params[0], EMPRESA);
    assert.equal(insert.params[1], 'pessoa@exemplo.com');
    assert.equal(insert.params[3], 'REPRESENTANTE_AUTORIZADO');
    assert.notEqual(insert.params[4], 'T'.repeat(43), 'só o hash do token vai ao banco');
    assert.ok(tx.executados.some((q) => /kidmais\.ator_usuario_id/.test(q.sql)), 'ator marcado para os guards');
    assert.equal(emails.length, 1);
    assert.match(String(emails[0].texto ?? emails[0].html ?? JSON.stringify(emails[0])), /#t=/);
    const serializado = JSON.stringify({ r, auditoria });
    assert.doesNotMatch(serializado, /T{43}/);
    assert.deepEqual(auditoria.map((a) => a.acao), ['CONVITE_CRIADO', 'CONVITE_ENVIADO']);
    assert.ok(auditoria.every((a) => a.origem === 'ADMIN_USUARIOS' && (a.dadosDepois as Record<string, unknown>).empresaId === EMPRESA));
    assert.equal((r.envio as Record<string, unknown>).enviado, true);
});

test('e-mail que falha: convite fica criado, resposta diz que não foi enviado e a auditoria registra a falha', async () => {
    const mod = carregar('REPRESENTANTE_AUTORIZADO');
    const { deps, auditoria } = cenario({ envioFalha: true });
    const r = await mod.convidarNaEmpresa(sessao as never, { acao: 'convidar', email: 'pessoa@exemplo.com', nivel: 'EQUIPE' } as never, ctx as never, deps as never) as { envio: { enviado: boolean; motivo: string } };
    assert.equal(r.envio.enviado, false);
    assert.ok(r.envio.motivo.length > 0);
    assert.deepEqual(auditoria.map((a) => a.acao), ['CONVITE_CRIADO', 'CONVITE_ENVIO_FALHOU']);
});

test('vínculo já existente nesta empresa: conflito sem criar convite (nada diz se o e-mail tem conta no Kidmais)', async () => {
    const mod = carregar('REPRESENTANTE_AUTORIZADO');
    for (const vinculo of ['ATIVA', 'SUSPENSA', 'REVOGADA']) {
        const { tx, deps } = cenario({ vinculo });
        await assert.rejects(mod.convidarNaEmpresa(sessao as never, { acao: 'convidar', email: 'pessoa@exemplo.com', nivel: 'EQUIPE' } as never, ctx as never, deps as never),
            (e: { httpStatus: number; message: string }) => e.httpStatus === 409 && !/conta no Kidmais|já usa o Kidmais/i.test(e.message));
        assert.ok(!tx.executados.some((q) => /INSERT INTO convites_acesso/.test(q.sql)));
    }
});

test('cancelar e reenviar só alcançam convites da empresa comprovada', async () => {
    const mod = carregar('REPRESENTANTE_AUTORIZADO');
    const tx = executorFalso([[/FROM convites_acesso c WHERE c\.id = \$1::uuid AND c\.empresa_id = \$2::uuid/, (p) => (p[1] === EMPRESA ? [{ id: p[0], email: 'x@y.com', papel: 'ADMINISTRATIVO', status: 'PENDENTE', expirado: false }] : [])]]);
    const auditoria: Array<Record<string, unknown>> = [];
    const deps = { withTransaction: async (w: (t: typeof tx) => Promise<unknown>) => w(tx), registrarAuditoria: async (i: Record<string, unknown>) => { auditoria.push(i); }, enviarEmail: async () => undefined, gerarToken: () => 'T'.repeat(43) };
    const id = '00000000-0000-4000-8000-0000000000c1';
    const r = await mod.alterarConviteNaEmpresa(sessao as never, { acao: 'cancelar-convite', conviteId: id } as never, ctx as never, deps as never) as Record<string, unknown>;
    assert.equal(r.situacao, 'CANCELADO');
    const busca = tx.executados.find((q) => /FROM convites_acesso c WHERE c\.id/.test(q.sql));
    assert.deepEqual(busca?.params, [id, EMPRESA]);
    assert.equal(auditoria[0].acao, 'CONVITE_CANCELADO');
    await assert.rejects(mod.alterarConviteNaEmpresa(sessao as never, { acao: 'apagar-convite', conviteId: id } as never, ctx as never, deps as never));
});

test('criação direta: desativada por configuração recusa antes de calcular hash ou abrir transação', async () => {
    const usuarios = carregarModulo('lib/autenticacao/usuarios.ts', {
        'db/postgres': { withTransaction: () => { throw new Error('sem banco'); } },
        'clientes/repositories/auditoria.repository': { registrarAuditoria: async () => undefined },
        'autenticacao/service': { authError: (m: string, s = 401) => new Falha(m, s) },
        'autenticacao/senha': { senhaValida: () => true, criarHashSenha: async () => 'h' },
        'perfil/protecao-usuarios': { avaliarPerdaDeElegibilidade: async () => null, MENSAGEM_ULTIMA_ADMINISTRADORA: '', revogarConcessoesAtivasDoUsuario: async () => 0 },
        'saas/provar-tenant': { executarNoTenant: async () => { throw new Error('não deveria provar tenant'); } },
        'autenticacao/plataforma': { PAPEL_GLOBAL_NEUTRO: 'ADMINISTRATIVO' },
    }, new Map()) as Mod;
    const disponivel = usuarios.criacaoDiretaDisponivel as unknown as (env: Record<string, string | undefined>) => boolean;
    assert.equal(disponivel({}), true, 'padrão preserva a operação atual enquanto o e-mail não está configurado');
    assert.equal(disponivel({ USUARIOS_CRIACAO_DIRETA: 'desativada' }), false);
    assert.equal(disponivel({ USUARIOS_CRIACAO_DIRETA: ' Desativada ' }), false);
    let hashes = 0, transacoes = 0;
    const deps = { withTransaction: async () => { transacoes += 1; }, criarHashSenha: async () => { hashes += 1; return 'h'; }, registrarAuditoria: async () => undefined, criacaoDireta: () => false };
    await assert.rejects(usuarios.criarUsuarioAdministrativo(sessao as never, { acao: 'criar', nome: 'P', email: 'p@x.com', nivel: 'EQUIPE', senha: 'senha-forte-1', confirmacao: 'senha-forte-1' } as never, 'r' as never, deps as never),
        (e: { httpStatus: number; code: string }) => e.httpStatus === 403 && e.code === 'CRIACAO_DIRETA_DESATIVADA');
    assert.equal(hashes, 0);
    assert.equal(transacoes, 0);
});

test('rota: convites usam a mesma sessão/CSRF, o GET informa convites e criação direta, e falta da 063 não derruba a lista', () => {
    const rota = readFileSync('app/api/admin/configuracoes/usuarios/route.ts', 'utf8');
    assert.equal((rota.match(/exigirApiAdminCrmDisponivel\(request\)/g) ?? []).length, 2);
    assert.match(rota, /body\.acao === 'convidar'/);
    assert.match(rota, /'reenviar-convite' \|\| body\.acao === 'cancelar-convite'/);
    assert.match(rota, /criacaoDireta: criacaoDiretaDisponivel\(\)/);
    assert.match(rota, /if \(tabelaAusente\(error\)\) return null;/);
    assert.match(rota, /comRetryAfter/);
});
