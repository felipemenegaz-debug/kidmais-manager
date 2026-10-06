import assert from 'node:assert/strict';
import test from 'node:test';
import { carregarModulo, executorFalso } from '../acessos/teste-carregador.ts';

/**
 * Criação do Perfil pela Gestão da empresa nova — sem banco (executorFalso). Os fluxos com PostgreSQL ficam em
 * lib/desenvolvedor/painel-063.postgres.test.ts.
 */
type Mod = Record<string, (...args: never[]) => unknown>;
const dubleBanco = { 'db/postgres': { db: () => { throw new Error('sem banco'); }, withTransaction: () => { throw new Error('sem banco'); } } };
const mod = carregarModulo('lib/perfil/criacao.ts', { ...dubleBanco }) as Mod;
type Criar = (tx: unknown, tenant: unknown, input: { autenticadoEm: string; agora?: number; requestId: string }, auditoria: (i: Record<string, unknown>) => Promise<unknown>, opcoes?: { exigirExistente?: boolean }) => Promise<{ criado: boolean; perfilId: string; unidadeId: string | null; capacidadesConcedidas: string[]; motivo: string }>;
const criar = mod.criarPerfilDaEmpresa as Criar;

const EMPRESA = '00000000-0000-4000-8000-0000000000e1';
const USUARIO = '00000000-0000-4000-8000-000000000001';
const agora = Date.parse('2026-10-05T12:00:00.000Z');
const tenant = (papelAtual = 'REPRESENTANTE_AUTORIZADO') => ({ empresaComprovada: EMPRESA, membershipId: 'm1', usuarioId: USUARIO, papelAtual });
const recente = { autenticadoEm: new Date(agora - 60_000).toISOString(), agora, requestId: '00000000-0000-4000-8000-0000000000aa' };

function banco(opcoes: { instalada?: boolean; perfis?: string[]; minhas?: string[]; administradores?: number; cadastro?: { nome_empresarial: string | null; documento_fiscal: string | null } | null; semCadastroTabela?: boolean; codigo?: string; nome?: string } = {}) {
    const inseridos: Array<{ sql: string; params: unknown[] }> = [];
    const tx = executorFalso([
        [/to_regclass\('public\.perfil_empresas'\) AS empresas/, () => (opcoes.instalada === false ? [{ empresas: null, unidades: null, revisoes: null, colunas_revisao: 0 }] : [{ empresas: 'x', unidades: 'x', revisoes: 'x', colunas_revisao: 2 }])],
        [/to_regclass\('public\.plataforma_empresas_cadastro'\)/, () => [{ t: opcoes.semCadastroTabela ? null : 'x' }]],
        [/FROM empresas WHERE id = \$1::uuid FOR UPDATE/, () => [{ id: EMPRESA, codigo: opcoes.codigo ?? 'buffet-alegria', nome: opcoes.nome ?? 'Buffet Alegria', status: 'ATIVA' }]],
        [/FROM public\.perfil_empresas p JOIN LATERAL/, () => (opcoes.perfis ?? []).map((id) => ({ id }))],
        [/SELECT capacidade FROM public\.perfil_empresa_concessoes/, () => (opcoes.minhas ?? []).map((capacidade) => ({ capacidade }))],
        [/count\(\*\)::int AS n FROM public\.perfil_empresa_concessoes c/, () => [{ n: opcoes.administradores ?? 0 }]],
        [/FROM public\.plataforma_empresas_cadastro WHERE empresa_id/, () => (opcoes.cadastro === null ? [] : [opcoes.cadastro ?? { nome_empresarial: 'Alegria Festas Ltda', documento_fiscal: '11222333000181' }])],
        [/INSERT INTO public\.perfil_empresas/, (params) => { inseridos.push({ sql: 'perfil', params }); return [{ id: 'p-novo' }]; }],
        [/INSERT INTO public\.perfil_unidades/, (params) => { inseridos.push({ sql: 'unidade', params }); return [{ id: 'u-novo' }]; }],
        [/INSERT INTO public\.perfil_empresa_concessoes/, (params) => { inseridos.push({ sql: 'concessao', params }); return []; }],
    ]);
    const auditorias: Array<Record<string, unknown>> = [];
    return { tx, inseridos, auditorias, auditoria: async (i: Record<string, unknown>) => { auditorias.push(i); } };
}

test('só a Gestão desta empresa cria o perfil; reautenticação vencida e estrutura ausente recusam antes de qualquer escrita', async () => {
    const equipe = banco();
    await assert.rejects(criar(equipe.tx, tenant('ADMINISTRATIVO'), recente, equipe.auditoria), (e: { code?: string; httpStatus?: number }) => e.code === 'PAPEL_NAO_AUTORIZADO' && e.httpStatus === 403);
    assert.equal(equipe.tx.executados.length, 0);
    const vencida = banco();
    await assert.rejects(criar(vencida.tx, tenant(), { ...recente, autenticadoEm: new Date(agora - 301_000).toISOString() }, vencida.auditoria), (e: { code?: string }) => e.code === 'PERFIL_REAUTENTICACAO');
    await assert.rejects(criar(vencida.tx, tenant(), { ...recente, autenticadoEm: new Date(agora + 1_000).toISOString() }, vencida.auditoria), (e: { code?: string }) => e.code === 'PERFIL_REAUTENTICACAO', 'carimbo futuro recusa');
    assert.equal(vencida.tx.executados.length, 0);
    const semEstrutura = banco({ instalada: false });
    await assert.rejects(criar(semEstrutura.tx, tenant(), recente, semEstrutura.auditoria), (e: { code?: string }) => e.code === 'PERFIL_ESTRUTURA_AUSENTE');
    assert.equal(semEstrutura.inseridos.length, 0);
});

test('criação: perfil com o código da empresa, uma unidade, quatro capacidades para quem criou e auditoria; pré-preenche só nome, razão social e CNPJ válidos', async () => {
    const b = banco();
    const r = await criar(b.tx, tenant(), recente, b.auditoria);
    assert.deepEqual([r.criado, r.perfilId, r.unidadeId, r.motivo], [true, 'p-novo', 'u-novo', 'CRIADO']);
    assert.deepEqual(r.capacidadesConcedidas, ['PERFIL_CONSULTAR', 'PERFIL_EDITAR_RASCUNHO', 'PERFIL_APLICAR', 'PERFIL_ADMINISTRAR_CONCESSOES']);
    assert.ok(b.tx.executados.some((q) => /pg_advisory_xact_lock/.test(q.sql)), 'serializa com a trava do provisionamento do perfil');
    const perfil = b.inseridos.find((i) => i.sql === 'perfil')!;
    assert.deepEqual(perfil.params, ['buffet-alegria', 'Buffet Alegria', 'Alegria Festas Ltda', '11222333000181']);
    const unidade = b.inseridos.find((i) => i.sql === 'unidade')!;
    assert.deepEqual(unidade.params, ['p-novo', 'buffet-alegria-principal', 'Buffet Alegria']);
    const concessoes = b.inseridos.filter((i) => i.sql === 'concessao');
    assert.equal(concessoes.length, 4);
    for (const c of concessoes)
        assert.deepEqual([c.params[0], c.params[1], c.params[4]], ['p-novo', USUARIO, `IMPLANTACAO:${EMPRESA}`]);
    assert.equal(b.auditorias.length, 1);
    assert.equal(b.auditorias[0].acao, 'PERFIL_ESTRUTURA_CRIADA');
    assert.deepEqual((b.auditorias[0].dadosDepois as { preenchidos: string[] }).preenchidos, ['nomeComercial', 'razaoSocial', 'cnpj']);
    assert.doesNotMatch(JSON.stringify(b.auditorias), /senha|token|hash/i);
});

test('pré-preenchimento: CNPJ inválido, CPF ou placeholder não entram; cadastro administrativo ausente ou tabela 063 ausente não impedem a criação', async () => {
    const cpf = banco({ cadastro: { nome_empresarial: null, documento_fiscal: '52998224725' } });
    await criar(cpf.tx, tenant(), recente, cpf.auditoria);
    assert.deepEqual(cpf.inseridos.find((i) => i.sql === 'perfil')!.params, ['buffet-alegria', 'Buffet Alegria', null, null]);
    const invalido = banco({ cadastro: { nome_empresarial: 'X Ltda', documento_fiscal: '11222333000199' } });
    await criar(invalido.tx, tenant(), recente, invalido.auditoria);
    assert.deepEqual(invalido.inseridos.find((i) => i.sql === 'perfil')!.params, ['buffet-alegria', 'Buffet Alegria', 'X Ltda', null]);
    const semCadastro = banco({ cadastro: null });
    assert.equal((await criar(semCadastro.tx, tenant(), recente, semCadastro.auditoria)).criado, true);
    const semTabela = banco({ semCadastroTabela: true });
    assert.equal((await criar(semTabela.tx, tenant(), recente, semTabela.auditoria)).criado, true);
    assert.ok(!semTabela.tx.executados.some((q) => /FROM public\.plataforma_empresas_cadastro WHERE/.test(q.sql)), 'não consulta tabela inexistente');
    const codigoLongo = 'a'.repeat(64);
    const longo = banco({ codigo: codigoLongo });
    await criar(longo.tx, tenant(), recente, longo.auditoria);
    const codigoUnidade = String(longo.inseridos.find((i) => i.sql === 'unidade')!.params[1]);
    assert.ok(codigoUnidade.length <= 64 && codigoUnidade.endsWith('-principal'), codigoUnidade);
});

test('perfil existente: quem já tem as quatro capacidades → nada muda; sem administrador elegível → concessão inicial das quatro; com administrador → 409 sem escrita', async () => {
    const completo = banco({ perfis: ['p1'], minhas: ['PERFIL_CONSULTAR', 'PERFIL_EDITAR_RASCUNHO', 'PERFIL_APLICAR', 'PERFIL_ADMINISTRAR_CONCESSOES'], administradores: 1 });
    const r1 = await criar(completo.tx, tenant(), recente, completo.auditoria);
    assert.deepEqual([r1.criado, r1.perfilId, r1.motivo, r1.capacidadesConcedidas], [false, 'p1', 'JA_EXISTE', []]);
    assert.equal(completo.inseridos.length, 0);
    assert.equal(completo.auditorias.length, 0);
    const orfao = banco({ perfis: ['p1'], minhas: [], administradores: 0 });
    const r2 = await criar(orfao.tx, tenant(), recente, orfao.auditoria);
    assert.deepEqual([r2.criado, r2.motivo, r2.capacidadesConcedidas.length], [false, 'CONCESSAO_INICIAL', 4]);
    assert.equal(orfao.inseridos.filter((i) => i.sql === 'concessao').length, 4);
    assert.equal(orfao.inseridos.filter((i) => i.sql !== 'concessao').length, 0, 'não cria perfil nem unidade');
    assert.ok(orfao.tx.executados.some((q) => /PERFIL_ADMINISTRAR_CONCESSOES' AND revogado_em IS NULL FOR UPDATE/.test(q.sql)), 'trava as concessões de administração antes de decidir');
    assert.equal(orfao.auditorias[0].acao, 'PERFIL_CONCESSAO_INICIAL');
    const administrado = banco({ perfis: ['p1'], minhas: [], administradores: 1 });
    await assert.rejects(criar(administrado.tx, tenant(), recente, administrado.auditoria), (e: { code?: string; httpStatus?: number }) => e.code === 'PERFIL_SEM_CONCESSAO' && e.httpStatus === 409);
    assert.equal(administrado.inseridos.length, 0);
    const ambiguo = banco({ perfis: ['p1', 'p2'] });
    await assert.rejects(criar(ambiguo.tx, tenant(), recente, ambiguo.auditoria), (e: { code?: string }) => e.code === 'PERFIL_LIMITE_V1');
});

test('concessões parciais: só PERFIL_CONSULTAR não comprova administrador — sem administrador elegível a conta recebe só o que falta; com administrador, nada é elevado', async () => {
    const parcialSemAdmin = banco({ perfis: ['p1'], minhas: ['PERFIL_CONSULTAR'], administradores: 0 });
    const r = await criar(parcialSemAdmin.tx, tenant(), recente, parcialSemAdmin.auditoria);
    assert.deepEqual([r.motivo, r.capacidadesConcedidas], ['CONCESSAO_INICIAL', ['PERFIL_EDITAR_RASCUNHO', 'PERFIL_APLICAR', 'PERFIL_ADMINISTRAR_CONCESSOES']]);
    assert.equal(parcialSemAdmin.inseridos.filter((i) => i.sql === 'concessao').length, 3, 'não duplica a capacidade que já existia');
    assert.deepEqual((parcialSemAdmin.auditorias[0].dadosDepois as { jaPossuia: string[] }).jaPossuia, ['PERFIL_CONSULTAR']);
    const parcialComAdmin = banco({ perfis: ['p1'], minhas: ['PERFIL_CONSULTAR'], administradores: 1 });
    await assert.rejects(criar(parcialComAdmin.tx, tenant(), recente, parcialComAdmin.auditoria), (e: { code?: string }) => e.code === 'PERFIL_SEM_CONCESSAO');
    assert.equal(parcialComAdmin.inseridos.length, 0);
    assert.equal(parcialComAdmin.auditorias.length, 0);
});

test('concessao-inicial exige perfil existente: sem perfil, 409 e nenhuma escrita', async () => {
    const b = banco({ perfis: [] });
    await assert.rejects(criar(b.tx, tenant(), recente, b.auditoria, { exigirExistente: true }), (e: { code?: string; httpStatus?: number }) => e.code === 'PERFIL_ESTRUTURA_AUSENTE' && e.httpStatus === 409);
    assert.equal(b.inseridos.length, 0);
});

test('elegibilidade (leitura para a tela): veredito por Gestão, estrutura, associação, administradores e capacidades que faltam; nunca lê o cadastro', async () => {
    const elegibilidade = mod.elegibilidadeConcessaoInicial as (tx: unknown, tenant: unknown) => Promise<{ elegivel: boolean; motivo: string | null; capacidadesFaltantes: string[] }>;
    assert.deepEqual(await elegibilidade(banco().tx, tenant('ADMINISTRATIVO')), { elegivel: false, motivo: 'SEM_GESTAO', capacidadesFaltantes: [] });
    assert.deepEqual(await elegibilidade(banco({ instalada: false }).tx, tenant()), { elegivel: false, motivo: 'ESTRUTURA_AUSENTE', capacidadesFaltantes: [] });
    assert.deepEqual(await elegibilidade(banco({ perfis: [] }).tx, tenant()), { elegivel: false, motivo: 'SEM_PERFIL', capacidadesFaltantes: [] });
    assert.deepEqual(await elegibilidade(banco({ perfis: ['p1', 'p2'] }).tx, tenant()), { elegivel: false, motivo: 'AMBIGUO', capacidadesFaltantes: [] });
    assert.deepEqual(await elegibilidade(banco({ perfis: ['p1'], minhas: ['PERFIL_CONSULTAR'], administradores: 1 }).tx, tenant()), { elegivel: false, motivo: 'ADMINISTRADOR_EXISTENTE', capacidadesFaltantes: [] });
    assert.deepEqual(await elegibilidade(banco({ perfis: ['p1'], minhas: ['PERFIL_CONSULTAR', 'PERFIL_EDITAR_RASCUNHO', 'PERFIL_APLICAR', 'PERFIL_ADMINISTRAR_CONCESSOES'], administradores: 1 }).tx, tenant()), { elegivel: false, motivo: 'JA_ADMINISTRA', capacidadesFaltantes: [] });
    const leitura = banco({ perfis: ['p1'], minhas: ['PERFIL_CONSULTAR'], administradores: 0 });
    assert.deepEqual(await elegibilidade(leitura.tx, tenant()), { elegivel: true, motivo: null, capacidadesFaltantes: ['PERFIL_EDITAR_RASCUNHO', 'PERFIL_APLICAR', 'PERFIL_ADMINISTRAR_CONCESSOES'] });
    assert.equal(leitura.inseridos.length, 0);
    for (const q of leitura.tx.executados) {
        assert.doesNotMatch(q.sql, /FOR UPDATE|pg_advisory/, 'leitura sem travas');
        if (/to_regclass\(/.test(q.sql))
            continue; // só confere se a estrutura existe
        assert.doesNotMatch(q.sql, /nome_comercial|razao_social|cnpj|sede_|perfil_empresa_revisoes|conteudo|perfil_unidades|logo/, 'nada do cadastro é lido');
    }
});
