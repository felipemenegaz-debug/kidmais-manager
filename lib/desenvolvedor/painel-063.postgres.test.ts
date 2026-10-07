import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Client } from 'pg';
import { conectarDescartavel, encerrarDescartavel } from '../comercial/postgres-descartavel.ts';
import { carregarModulo } from '../acessos/teste-carregador.ts';

/**
 * Painel do desenvolvedor (063) no PostgreSQL DESCARTÁVEL (modelo "063" da receita; scripts/regressao-v1-selecao.cjs).
 * Só roda com o opt-in do cluster sintético. Nenhum e-mail real: o envio é dublado e os links são capturados.
 * Cobre: rollback/reaplicação, concessão por CLI, autorização (proprietário sem concessão), interessada sem efeitos,
 * provisionamento, convites (conta nova e existente), isolamento entre empresas, desativação de vínculo, suspensão
 * e reativação com sessões, troca de senha com sessões, recuperação (uso único, expiração, intervalo) e auditoria
 * sem segredos.
 */
const req = createRequire(import.meta.url);
process.env.ADMIN_AUTH_SECRET = `segredo-sintetico-de-teste-${'x'.repeat(24)}`;
process.env.EMAIL_PROVIDER = 'desativado';

type Fn = (...args: never[]) => Promise<never>;
type Mod = Record<string, Fn>;
let client: Client;
const cache = new Map<string, Record<string, unknown>>();
const carregar = (f: string) => carregarModulo(f, { 'db/postgres': { db: () => client, withTransaction } }, cache) as Mod;

async function withTransaction<T>(work: (tx: Client) => Promise<T>): Promise<T> {
    await client.query('BEGIN');
    try {
        const r = await work(client);
        await client.query('COMMIT');
        return r;
    }
    catch (error) {
        await client.query('ROLLBACK');
        throw error;
    }
}

const sufixo = randomBytes(3).toString('hex');
const email = (nome: string) => `p063-${nome}-${sufixo}@exemplo.test`;
const ctx = () => ({ requestId: randomUUID(), ip: null, userAgent: 'teste-063' });
const enviados: Array<{ para: string; texto: string }> = [];
let falharEnvio = false;
const enviarEmail = async (m: { para: string; texto: string }) => {
    if (falharEnvio) {
        const { erroAcesso } = carregar('lib/acessos/erros.ts') as unknown as { erroAcesso: (c: string, m: string, s: number) => Error };
        throw erroAcesso('EMAIL_NAO_CONFIGURADO', 'Envio desligado no teste.', 503);
    }
    enviados.push(m);
    return { provedor: 'arquivo' as const, idExterno: null };
};
const tokenDoUltimoEnvio = (para: string) => {
    const m = [...enviados].reverse().find((e) => e.para === para);
    const t = m?.texto.match(/#t=([A-Za-z0-9_-]{43})/)?.[1];
    assert.ok(t, `token enviado para ${para}`);
    return t!;
};

let svc: { auth: Mod; senha: { criarHashSenha: (s: string) => Promise<string> }; usuarios: Mod; interessadas: Mod; empresas: Mod; vinculos: Mod; resumo: Mod; convites: Mod; recuperacao: Mod; senhaPropria: Mod; tenant: Mod };
const deps = () => ({ withTransaction, registrarAuditoria: (carregar('lib/clientes/repositories/auditoria.repository.ts') as unknown as { registrarAuditoria: Fn }).registrarAuditoria, enviarEmail, gerarToken: () => randomBytes(32).toString('base64url') });

const senhas = { dev: 'senha-do-dev-063', dono: 'senha-do-dono-063', resp: 'senha-do-resp-063', nova: 'senha-nova-063!' };
const ids: Record<string, string> = {};

async function sessaoDe(usuarioId: string) {
    const nova = await withTransaction((tx) => (svc.auth.criarSessaoAdministrativa as unknown as (tx: Client, u: string, ip: null, ua: null) => Promise<{ token: string }>)(tx, usuarioId, null, null));
    const sessao = await (svc.auth.consultarSessao as unknown as (t: string) => Promise<Record<string, string>>)(nova.token);
    return { token: nova.token, sessao };
}
async function sessaoValida(token: string) {
    try {
        await (svc.auth.consultarSessao as unknown as (t: string) => Promise<unknown>)(token);
        return true;
    }
    catch {
        return false;
    }
}
async function acessaEmpresa(usuarioId: string, empresaId: string) {
    try {
        await withTransaction((tx) => (svc.tenant.provarTenant as unknown as (tx: Client, s: unknown, e: string) => Promise<unknown>)(tx, { usuario_id: usuarioId, papel: 'ADMINISTRATIVO' }, empresaId));
        return true;
    }
    catch {
        return false;
    }
}
async function codigoErro(p: Promise<unknown>) {
    try {
        await p;
        return 'OK';
    }
    catch (error) {
        return (error as { code?: string }).code ?? (error as Error).message;
    }
}
const contar = async (sql: string, params: unknown[] = []) => (await client.query<{ n: number }>(sql, params)).rows[0].n;

test.before(async () => {
    client = await conectarDescartavel();
    svc = {
        auth: carregar('lib/autenticacao/service.ts'),
        senha: carregar('lib/autenticacao/senha.ts') as unknown as { criarHashSenha: (s: string) => Promise<string> },
        usuarios: carregar('lib/autenticacao/usuarios.ts'),
        interessadas: carregar('lib/desenvolvedor/interessadas.ts'),
        empresas: carregar('lib/desenvolvedor/empresas.ts'),
        vinculos: carregar('lib/desenvolvedor/vinculos.ts'),
        resumo: carregar('lib/desenvolvedor/resumo.ts'),
        convites: carregar('lib/acessos/convites.ts'),
        recuperacao: carregar('lib/acessos/recuperacao.ts'),
        senhaPropria: carregar('lib/acessos/senha-propria.ts'),
        tenant: carregar('lib/saas/provar-tenant.ts'),
    };
});

test.after(async () => {
    if (client)
        await encerrarDescartavel(client);
});

test('063: rollback em banco sem uso devolve 044/045 e a 063 reaplica com postcheck limpo', async () => {
    const down = readFileSync('database/rollback/20261004_063_painel_desenvolvedor_down.sql', 'utf8');
    const up = readFileSync('database/migrations/20261004_063_painel_desenvolvedor.sql', 'utf8');
    await client.query(down);
    const guard = await client.query<{ f: string }>("SELECT tgfoid::regprocedure::text AS f FROM pg_trigger WHERE tgrelid = 'public.empresas'::regclass AND tgname = 'empresas_guard_trg'");
    assert.equal(guard.rows[0].f, 'kidmais_044_guard_empresas()');
    assert.equal((await client.query("SELECT to_regclass('public.convites_acesso') AS t")).rows[0].t, null);
    await client.query(readFileSync('database/checks/20261004_063_precheck.sql', 'utf8'));
    await client.query(up);
    await client.query(readFileSync('database/checks/20261004_063_postcheck.sql', 'utf8'));
});

test('063: fixtures sintéticas — dev (identidade neutra), dono legado (Gestão de outra empresa) e empresa legado', async () => {
    const hash = async (s: string) => svc.senha.criarHashSenha(s);
    for (const [chave, papel, senha] of [['dev', 'ADMINISTRATIVO', senhas.dev], ['dono', 'REPRESENTANTE_AUTORIZADO', senhas.dono]] as const) {
        ids[chave] = (await client.query<{ id: string }>('INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel) VALUES ($1, $2, $3, $4) RETURNING id',
            [email(chave), `Pessoa ${chave}`, await hash(senha), papel])).rows[0].id;
    }
    ids.legado = (await client.query<{ id: string }>(`INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Empresa Legado 063', 'PROVISIONAMENTO') RETURNING id`, [`p063-legado-${sufixo}`])).rows[0].id;
    await client.query("UPDATE empresas SET status = 'ATIVA' WHERE id = $1", [ids.legado]);
    ids.donoLegado = (await client.query<{ id: string }>(`INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1, $2, 'PENDENTE', clock_timestamp(), 'REPRESENTANTE_AUTORIZADO') RETURNING id`, [ids.legado, ids.dono])).rows[0].id;
    await client.query("UPDATE memberships SET status = 'ATIVA' WHERE id = $1", [ids.donoLegado]);
});

test('concessão de desenvolvedor só pelo CLI, sem duplicar; a tabela recusa apagar e alterar a concessão', async () => {
    const cli = req('../../scripts/admin-provision.cjs') as { alterarDesenvolvedor: (c: Client, i: Record<string, string>) => Promise<{ concessaoId: string }> };
    const r = await cli.alterarDesenvolvedor(client, { operacao: 'conceder', email: email('dev'), operador: 'Teste 063', motivo: 'Desenvolvedor sintético' });
    assert.ok(r.concessaoId);
    await assert.rejects(cli.alterarDesenvolvedor(client, { operacao: 'conceder', email: email('dev'), operador: 'Teste 063', motivo: 'Duplicada' }), /já está ativa/);
    await assert.rejects(client.query('DELETE FROM plataforma_desenvolvedores WHERE id = $1', [r.concessaoId]), /exclusão física recusada/);
    await assert.rejects(client.query("UPDATE plataforma_desenvolvedores SET concedido_por = 'outro' WHERE id = $1", [r.concessaoId]), /só pode ser revogada/);
    assert.equal(await contar(`SELECT count(*)::int AS n FROM auditoria WHERE acao = 'PLATAFORMA_DESENVOLVEDOR_CONCEDIDO' AND entidade_id = $1`, [ids.dev]), 1);
});

test('autorização no servidor: Gestão/proprietário de empresa sem concessão recebe 404 em todo serviço; o dev acessa', async () => {
    const dono = (await sessaoDe(ids.dono)).sessao;
    for (const caso of [
        () => svc.empresas.listarEmpresas(dono as never, {} as never),
        () => svc.interessadas.listarInteressadas(dono as never, {} as never),
        () => svc.resumo.resumoPainel(dono as never),
        () => svc.empresas.obterEmpresa(dono as never, ids.legado as never),
        () => svc.interessadas.criarInteressada(dono as never, { nome: 'Invasora', email: email('x') } as never, ctx() as never),
    ])
        assert.equal(await codigoErro(caso()), 'NAO_ENCONTRADO');
    const dev = (await sessaoDe(ids.dev)).sessao;
    const lista = await svc.empresas.listarEmpresas(dev as never, {} as never) as unknown as { itens: Array<{ id: string }> };
    assert.ok(lista.itens.some((e) => e.id === ids.legado));
});

test('interessada: cadastro não cria empresa, usuário, vínculo nem convite; duplicidade bloqueia e semelhança pede confirmação', async () => {
    const dev = (await sessaoDe(ids.dev)).sessao;
    const antes = await contar('SELECT ((SELECT count(*) FROM empresas) + (SELECT count(*) FROM usuarios_administrativos) + (SELECT count(*) FROM memberships) + (SELECT count(*) FROM convites_acesso))::int AS n');
    const criada = await svc.interessadas.criarInteressada(dev as never, { nome: 'Buffet Alegria 063', documentoFiscal: '11.222.333/0001-81', responsavelNome: 'Ana Responsável', email: email('resp'), telefone: '(11) 98888-0063' } as never, ctx() as never) as unknown as { id: string; revisao: number };
    ids.interessada = criada.id;
    assert.equal(await contar('SELECT ((SELECT count(*) FROM empresas) + (SELECT count(*) FROM usuarios_administrativos) + (SELECT count(*) FROM memberships) + (SELECT count(*) FROM convites_acesso))::int AS n'), antes);
    assert.equal(await codigoErro(svc.interessadas.criarInteressada(dev as never, { nome: 'Outra', email: email('resp') } as never, ctx() as never)), 'DUPLICIDADE');
    assert.equal(await codigoErro(svc.interessadas.criarInteressada(dev as never, { nome: 'Outra com mesmo telefone', telefone: '11988880063' } as never, ctx() as never)), 'DUPLICIDADE');
    const confirmada = await svc.interessadas.criarInteressada(dev as never, { nome: 'Outra com mesmo telefone', telefone: '11988880063', confirmarSemelhantes: true } as never, ctx() as never) as unknown as { id: string; revisao: number };
    const status = await svc.interessadas.alterarStatusInteressada(dev as never, confirmada.id as never, { status: 'DESCARTADA', motivo: 'Duplicada de propósito', revisao: confirmada.revisao } as never, ctx() as never) as unknown as { status: string };
    assert.equal(status.status, 'DESCARTADA');
    const hist = await client.query<{ antes: string; depois: string }>(`SELECT dados_antes->>'status' AS antes, dados_depois->>'status' AS depois FROM auditoria WHERE acao = 'INTERESSADA_STATUS_ALTERADO' AND entidade_id = $1`, [confirmada.id]);
    assert.deepEqual(hist.rows[0], { antes: 'NOVA', depois: 'DESCARTADA' });
});

test('provisionamento: prévia não escreve; confirmação cria empresa ATIVA em implantação + cadastro + convite, converte a interessada e não cria usuário', async () => {
    const dev = (await sessaoDe(ids.dev)).sessao;
    const dados = { interessadaId: ids.interessada, nome: 'Buffet Alegria 063', codigo: `p063-alegria-${sufixo}`, documentoFiscal: '11222333000181', responsavelNome: 'Ana Responsável', email: email('resp') };
    const empresasAntes = await contar('SELECT count(*)::int AS n FROM empresas');
    const previa = await svc.empresas.previaProvisionamento(dev as never, dados as never) as unknown as { podeConfirmar: boolean; efeitos: string[] };
    assert.equal(previa.podeConfirmar, true);
    assert.ok(previa.efeitos.some((e) => /Nenhum usuário é criado/.test(e)));
    assert.equal(await contar('SELECT count(*)::int AS n FROM empresas'), empresasAntes);
    assert.equal(await codigoErro(svc.empresas.provisionarContratante(dev as never, dados as never, ctx() as never, deps() as never)), 'DADOS_INVALIDOS', 'sem confirmar');
    const usuariosAntes = await contar('SELECT count(*)::int AS n FROM usuarios_administrativos');
    const r = await svc.empresas.provisionarContratante(dev as never, { ...dados, confirmar: true } as never, ctx() as never, deps() as never) as unknown as { empresaId: string; conviteId: string; envio: { enviado: boolean } };
    ids.empresa = r.empresaId;
    ids.conviteResp = r.conviteId;
    assert.equal(r.envio.enviado, true);
    assert.equal(await contar('SELECT count(*)::int AS n FROM usuarios_administrativos'), usuariosAntes);
    const e = (await client.query<{ status: string; implantacao: string; interessada: string }>(
        `SELECT e.status, c.implantacao, i.status AS interessada FROM empresas e JOIN plataforma_empresas_cadastro c ON c.empresa_id = e.id JOIN plataforma_interessadas i ON i.empresa_id = e.id WHERE e.id = $1`, [r.empresaId])).rows[0];
    assert.deepEqual(e, { status: 'ATIVA', implantacao: 'AGUARDANDO_PRIMEIRO_ACESSO', interessada: 'CONVERTIDA' });
    assert.equal(await contar("SELECT count(*)::int AS n FROM convites_acesso WHERE empresa_id = $1 AND status = 'PENDENTE' AND papel = 'REPRESENTANTE_AUTORIZADO' AND envios = 1", [r.empresaId]), 1);
    assert.equal(await codigoErro(svc.empresas.provisionarContratante(dev as never, { ...dados, confirmar: true } as never, ctx() as never, deps() as never)), 'CONFLITO', 'interessada já convertida');
});

test('convite com conta nova: cria identidade NEUTRA e vínculo de Gestão só nesta empresa; o link é de uso único', async () => {
    const token = tokenDoUltimoEnvio(email('resp'));
    const consulta = await svc.convites.consultarConvite({ token } as never, ctx() as never, { withTransaction } as never) as unknown as { situacao: string; contaExistente: boolean };
    assert.deepEqual([consulta.situacao, consulta.contaExistente], ['PENDENTE', false]);
    assert.equal(await codigoErro(svc.convites.aceitarConvite({ token, nome: 'Ana Responsável', senha: senhas.resp, confirmacao: 'diferente-063' } as never, ctx() as never, deps() as never)), 'SENHA_INVALIDA');
    const aceito = await svc.convites.aceitarConvite({ token, nome: 'Ana Responsável', senha: senhas.resp, confirmacao: senhas.resp } as never, ctx() as never, { ...deps(), criarHashSenha: svc.senha.criarHashSenha, conferirSenha: (carregar('lib/autenticacao/senha.ts') as unknown as { conferirSenha: Fn }).conferirSenha } as never) as unknown as { contaNova: boolean };
    assert.equal(aceito.contaNova, true);
    const u = (await client.query<{ id: string; papel: string; m_papel: string; m_status: string }>(
        `SELECT u.id, u.papel, m.papel AS m_papel, m.status AS m_status FROM usuarios_administrativos u JOIN memberships m ON m.usuario_id = u.id WHERE u.email = $1`, [email('resp')])).rows;
    assert.equal(u.length, 1, 'um único vínculo');
    assert.deepEqual([u[0].papel, u[0].m_papel, u[0].m_status], ['ADMINISTRATIVO', 'REPRESENTANTE_AUTORIZADO', 'ATIVA']);
    ids.resp = u[0].id;
    assert.equal(await acessaEmpresa(ids.resp, ids.empresa), true);
    assert.equal(await acessaEmpresa(ids.resp, ids.legado), false);
    assert.equal((await client.query('SELECT implantacao FROM plataforma_empresas_cadastro WHERE empresa_id = $1', [ids.empresa])).rows[0].implantacao, 'EM_CONFIGURACAO');
    assert.equal(await codigoErro(svc.convites.aceitarConvite({ token, nome: 'Outra', senha: senhas.resp, confirmacao: senhas.resp } as never, ctx() as never, deps() as never)), 'LINK_INVALIDO');
});

test('convite para conta existente: senha errada é recusada e auditada; correta cria o vínculo sem tocar a outra empresa', async () => {
    const dev = (await sessaoDe(ids.dev)).sessao;
    const convite = await svc.vinculos.convidarUsuario(dev as never, ids.empresa as never, { email: email('dono'), nivel: 'EQUIPE' } as never, ctx() as never, deps() as never) as unknown as { envio: { enviado: boolean } };
    assert.equal(convite.envio.enviado, true);
    assert.equal(await codigoErro(svc.vinculos.convidarUsuario(dev as never, ids.empresa as never, { email: email('dono'), nivel: 'EQUIPE' } as never, ctx() as never, deps() as never)), 'CONFLITO', 'pendente válido não duplica');
    const token = tokenDoUltimoEnvio(email('dono'));
    const conferir = (carregar('lib/autenticacao/senha.ts') as unknown as { conferirSenha: Fn }).conferirSenha;
    assert.equal(await codigoErro(svc.convites.aceitarConvite({ token, senha: 'senha-errada-063' } as never, ctx() as never, { ...deps(), conferirSenha: conferir } as never)), 'DADOS_INVALIDOS');
    assert.equal(await contar(`SELECT count(*)::int AS n FROM auditoria WHERE acao = 'CONVITE_ACEITE_RECUSADO' AND dados_depois->>'empresaId' = $1`, [ids.empresa]), 1);
    await svc.convites.aceitarConvite({ token, senha: senhas.dono } as never, ctx() as never, { ...deps(), conferirSenha: conferir } as never);
    const vinculos = (await client.query<{ empresa_id: string; papel: string; status: string }>('SELECT empresa_id, papel, status FROM memberships WHERE usuario_id = $1 ORDER BY criado_em', [ids.dono])).rows;
    assert.deepEqual(vinculos.map((v) => [v.empresa_id, v.papel, v.status]), [[ids.legado, 'REPRESENTANTE_AUTORIZADO', 'ATIVA'], [ids.empresa, 'ADMINISTRATIVO', 'ATIVA']]);
});

test('isolamento: vínculo, convite e recuperação de outra empresa não são alcançados pelo id desta', async () => {
    const dev = (await sessaoDe(ids.dev)).sessao;
    const outroConvite = (await client.query<{ id: string }>('SELECT id FROM convites_acesso WHERE empresa_id = $1 LIMIT 1', [ids.empresa])).rows[0].id;
    assert.equal(await codigoErro(svc.vinculos.cancelarConvite(dev as never, ids.legado as never, outroConvite as never, ctx() as never, deps() as never)), 'NAO_ENCONTRADO');
    assert.equal(await codigoErro(svc.vinculos.alterarSituacaoVinculo(dev as never, ids.legado as never, ids.resp as never, 'desativar' as never, { motivo: 'cruzado' } as never, ctx() as never, deps() as never)), 'NAO_ENCONTRADO');
    assert.equal(await codigoErro(svc.vinculos.solicitarRecuperacaoPeloPainel(dev as never, ids.legado as never, ids.resp as never, ctx() as never, deps() as never)), 'NAO_ENCONTRADO');
});

test('desativar vínculo: só esta empresa perde o acesso; última Gestão é protegida; quem tem outra empresa continua logado; reativação devolve', async () => {
    const dev = (await sessaoDe(ids.dev)).sessao;
    assert.equal(await codigoErro(svc.vinculos.alterarSituacaoVinculo(dev as never, ids.empresa as never, ids.resp as never, 'desativar' as never, { motivo: 'teste' } as never, ctx() as never, deps() as never)), 'ULTIMA_GESTAO');
    const sessaoDono = await sessaoDe(ids.dono);
    const r = await svc.vinculos.alterarSituacaoVinculo(dev as never, ids.empresa as never, ids.dono as never, 'desativar' as never, { motivo: 'Teste de desativação' } as never, ctx() as never, deps() as never) as unknown as { statusVinculo: string; sessoesEncerradas: number };
    assert.deepEqual([r.statusVinculo, r.sessoesEncerradas], ['SUSPENSA', 0]);
    assert.equal(await acessaEmpresa(ids.dono, ids.empresa), false);
    assert.equal(await acessaEmpresa(ids.dono, ids.legado), true, 'outra empresa intacta');
    assert.equal(await sessaoValida(sessaoDono.token), true);
    assert.equal(await codigoErro(svc.usuarios.criarUsuarioAdministrativo({ ...(await sessaoDe(ids.resp)).sessao } as never, { acao: 'criar', nome: 'Dono', email: email('dono'), nivel: 'EQUIPE', senha: 'qualquer-senha-1', confirmacao: 'qualquer-senha-1' } as never, randomUUID() as never, undefined as never, ids.empresa as never)), 'AUTENTICACAO_ADMINISTRATIVA', 'a empresa não reabre vínculo desativado pela plataforma');
    await svc.vinculos.alterarSituacaoVinculo(dev as never, ids.empresa as never, ids.dono as never, 'reativar' as never, { motivo: 'Teste de reativação' } as never, ctx() as never, deps() as never);
    assert.equal(await acessaEmpresa(ids.dono, ids.empresa), true);
});

test('suspensão da empresa: acesso cai na hora, sessões de quem não tem outro acesso são encerradas, dados preservados; reativação devolve', async () => {
    const dev = (await sessaoDe(ids.dev)).sessao;
    const resp = await sessaoDe(ids.resp);
    const dono = await sessaoDe(ids.dono);
    const contagem = async () => contar('SELECT ((SELECT count(*) FROM memberships WHERE empresa_id = $1) + (SELECT count(*) FROM convites_acesso WHERE empresa_id = $1) + (SELECT count(*) FROM plataforma_empresas_cadastro WHERE empresa_id = $1))::int AS n', [ids.empresa]);
    const antes = await contagem();
    assert.equal(await codigoErro(svc.empresas.alterarSituacaoEmpresa(dev as never, ids.empresa as never, 'suspender' as never, { motivo: 'Inadimplência', confirmacaoCodigo: 'errado' } as never, ctx() as never, deps() as never)), 'DADOS_INVALIDOS');
    const r = await svc.empresas.alterarSituacaoEmpresa(dev as never, ids.empresa as never, 'suspender' as never, { motivo: 'Inadimplência', confirmacaoCodigo: `p063-alegria-${sufixo}` } as never, ctx() as never, deps() as never) as unknown as { status: string; usuariosDesconectados: number };
    assert.equal(r.status, 'SUSPENSA');
    assert.ok(r.usuariosDesconectados >= 1);
    assert.equal(await sessaoValida(resp.token), false, 'responsável sem outro acesso sai');
    assert.equal(await sessaoValida(dono.token), true, 'quem tem outra empresa continua');
    assert.equal(await acessaEmpresa(ids.dono, ids.empresa), false);
    assert.equal(await acessaEmpresa(ids.dono, ids.legado), true);
    assert.equal(await contagem(), antes, 'nada apagado');
    assert.equal(await codigoErro(svc.vinculos.convidarUsuario(dev as never, ids.empresa as never, { email: email('novo'), nivel: 'EQUIPE' } as never, ctx() as never, deps() as never)), 'CONFLITO');
    await svc.empresas.alterarSituacaoEmpresa(dev as never, ids.empresa as never, 'reativar' as never, { motivo: 'Regularizada', confirmacaoCodigo: `p063-alegria-${sufixo}` } as never, ctx() as never, deps() as never);
    assert.equal(await acessaEmpresa(ids.resp, ids.empresa), true);
    assert.equal(await contar(`SELECT count(*)::int AS n FROM auditoria WHERE entidade_id = $1 AND acao IN ('EMPRESA_SUSPENSA', 'EMPRESA_REATIVADA') AND justificativa IS NOT NULL`, [ids.empresa]), 2);
});

test('troca da própria senha: encerra todas as sessões (inclusive de outros dispositivos) e a sessão nova vale; senha atual errada recusada', async () => {
    const outra = await sessaoDe(ids.resp);
    const atual = await sessaoDe(ids.resp);
    assert.equal(await codigoErro(svc.senhaPropria.trocarPropriaSenha(atual.token as never, { senhaAtual: 'errada-063!', novaSenha: senhas.nova, confirmacao: senhas.nova } as never, ctx() as never)), 'SENHA_ATUAL_INCORRETA');
    assert.equal(await sessaoValida(atual.token), true, 'recusa não derruba a sessão');
    const r = await svc.senhaPropria.trocarPropriaSenha(atual.token as never, { senhaAtual: senhas.resp, novaSenha: senhas.nova, confirmacao: senhas.nova } as never, ctx() as never) as unknown as { token: string; sessoesEncerradas: number };
    assert.ok(r.sessoesEncerradas >= 2);
    assert.equal(await sessaoValida(outra.token), false);
    assert.equal(await sessaoValida(atual.token), false);
    assert.equal(await sessaoValida(r.token), true);
    await assert.rejects((svc.auth.loginAdmin as unknown as (...a: unknown[]) => Promise<unknown>)(email('resp'), senhas.resp, randomUUID(), null, null), /Credenciais inválidas/);
    await (svc.auth.loginAdmin as unknown as (...a: unknown[]) => Promise<unknown>)(email('resp'), senhas.nova, randomUUID(), null, null);
});

test('recuperação: resposta neutra sem conta; pedido aberto, intervalo mínimo, uso único, expiração e encerramento das sessões', async () => {
    const depsRec = { ...deps(), criarHashSenha: svc.senha.criarHashSenha };
    const pedidosAntes = await contar('SELECT count(*)::int AS n FROM recuperacoes_senha');
    await svc.recuperacao.processarPedidoPublico({ email: email('inexistente') } as never, ctx() as never, depsRec as never);
    assert.equal(await contar('SELECT count(*)::int AS n FROM recuperacoes_senha'), pedidosAntes);
    await svc.recuperacao.processarPedidoPublico({ email: email('resp') } as never, ctx() as never, depsRec as never);
    const token = tokenDoUltimoEnvio(email('resp'));
    await svc.recuperacao.processarPedidoPublico({ email: email('resp') } as never, ctx() as never, depsRec as never);
    assert.equal(await contar('SELECT count(*)::int AS n FROM recuperacoes_senha WHERE usuario_id = $1', [ids.resp]), 1, 'repetição dentro do intervalo não abre outro pedido');
    const logado = await sessaoDe(ids.resp);
    const r = await svc.recuperacao.redefinirSenhaComToken({ token, novaSenha: 'senha-recuperada-063', confirmacao: 'senha-recuperada-063' } as never, ctx() as never, depsRec as never) as unknown as { redefinida: boolean };
    assert.equal(r.redefinida, true);
    assert.equal(await sessaoValida(logado.token), false);
    assert.equal(await codigoErro(svc.recuperacao.redefinirSenhaComToken({ token, novaSenha: 'outra-senha-063', confirmacao: 'outra-senha-063' } as never, ctx() as never, depsRec as never)), 'LINK_INVALIDO');
    // Expiração: o guard não deixa recuar datas; só o teste desliga o gatilho para envelhecer um pedido sintético.
    await client.query('ALTER TABLE recuperacoes_senha DISABLE TRIGGER kidmais_063_rec_guard_trg');
    try {
        await client.query("UPDATE recuperacoes_senha SET criado_em = criado_em - interval '3 hours', expira_em = expira_em - interval '3 hours' WHERE usuario_id = $1", [ids.resp]);
    }
    finally {
        await client.query('ALTER TABLE recuperacoes_senha ENABLE TRIGGER kidmais_063_rec_guard_trg');
    }
    const dev = (await sessaoDe(ids.dev)).sessao;
    const envio = await svc.vinculos.solicitarRecuperacaoPeloPainel(dev as never, ids.empresa as never, ids.resp as never, ctx() as never, depsRec as never) as unknown as Record<string, unknown>;
    assert.equal(envio.enviado, true);
    assert.doesNotMatch(JSON.stringify(envio), /[A-Za-z0-9_-]{43}/, 'o desenvolvedor não recebe token nem link');
    assert.equal(await codigoErro(svc.vinculos.solicitarRecuperacaoPeloPainel(dev as never, ids.empresa as never, ids.resp as never, ctx() as never, depsRec as never)), 'LIMITE_TENTATIVAS');
    const novoToken = tokenDoUltimoEnvio(email('resp'));
    await client.query('ALTER TABLE recuperacoes_senha DISABLE TRIGGER kidmais_063_rec_guard_trg');
    try {
        await client.query("UPDATE recuperacoes_senha SET criado_em = criado_em - interval '1 hour', expira_em = clock_timestamp() - interval '1 minute' WHERE usuario_id = $1 AND usado_em IS NULL AND invalidado_em IS NULL", [ids.resp]);
    }
    finally {
        await client.query('ALTER TABLE recuperacoes_senha ENABLE TRIGGER kidmais_063_rec_guard_trg');
    }
    assert.equal(await codigoErro(svc.recuperacao.redefinirSenhaComToken({ token: novoToken, novaSenha: 'expirada-063!', confirmacao: 'expirada-063!' } as never, ctx() as never, depsRec as never)), 'LINK_INVALIDO');
});

test('envio indisponível: o convite fica registrado como não enviado, com a falha auditada', async () => {
    const dev = (await sessaoDe(ids.dev)).sessao;
    falharEnvio = true;
    try {
        const r = await svc.vinculos.convidarUsuario(dev as never, ids.empresa as never, { email: email('semenvio'), nivel: 'EQUIPE' } as never, ctx() as never, deps() as never) as unknown as { envio: { enviado: boolean; motivo: string } };
        assert.deepEqual([r.envio.enviado, r.envio.motivo], [false, 'Envio desligado no teste.']);
        assert.equal(await contar("SELECT count(*)::int AS n FROM convites_acesso WHERE email = $1 AND envios = 0 AND status = 'PENDENTE'", [email('semenvio')]), 1);
        assert.equal(await contar("SELECT count(*)::int AS n FROM auditoria WHERE acao = 'CONVITE_ENVIO_FALHOU' AND dados_depois->>'empresaId' = $1", [ids.empresa]), 1);
    }
    finally {
        falharEnvio = false;
    }
});

test('auditoria: nenhuma senha, token, hash ou link nos registros produzidos; ator, empresa e resultado presentes', async () => {
    const linhas = (await client.query<{ acao: string; usuario_id: string | null; texto: string }>(
        `SELECT acao, usuario_id, coalesce(dados_antes::text, '') || coalesce(dados_depois::text, '') || coalesce(justificativa, '') AS texto FROM auditoria
          WHERE origem IN ('PAINEL_DESENVOLVEDOR', 'CONVITE_PUBLICO', 'RECUPERACAO_PUBLICA', 'PERFIL_SENHA', 'CLI_PROVISIONAMENTO')`)).rows;
    assert.ok(linhas.length > 20);
    const segredos = [...Object.values(senhas), 'senha-recuperada-063', ...enviados.map((e) => e.texto.match(/#t=([A-Za-z0-9_-]{43})/)?.[1]).filter(Boolean) as string[]];
    for (const l of linhas) {
        for (const s of segredos)
            assert.ok(!l.texto.includes(s), `${l.acao} contém segredo`);
        assert.doesNotMatch(l.texto, /scrypt\$|#t=|"(senha|token|hash|link)"/i, l.acao);
    }
    const painel = (await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM auditoria WHERE origem = 'PAINEL_DESENVOLVEDOR' AND (usuario_id IS NULL OR dados_depois->>'resultado' IS NULL)`)).rows[0].n;
    assert.equal(painel, 0, 'todo registro do painel tem ator e resultado');
});

test('D2: sem concessão ninguém reativa — nem pelo painel (404) nem pelas rotas legadas da empresa; DESATIVADA e REVOGADA são terminais', async () => {
    const dev = (await sessaoDe(ids.dev)).sessao;
    const resp = (await sessaoDe(ids.resp)).sessao;
    const dono = (await sessaoDe(ids.dono)).sessao;
    // Garante o vínculo do dono nesta empresa SUSPENSO para a prova.
    const status = (await client.query<{ status: string }>('SELECT status FROM memberships WHERE empresa_id = $1 AND usuario_id = $2', [ids.empresa, ids.dono])).rows[0].status;
    if (status === 'ATIVA')
        await svc.vinculos.alterarSituacaoVinculo(dev as never, ids.empresa as never, ids.dono as never, 'desativar' as never, { motivo: 'Prova D2' } as never, ctx() as never, deps() as never);
    for (const s of [resp, dono]) {
        assert.equal(await codigoErro(svc.vinculos.alterarSituacaoVinculo(s as never, ids.empresa as never, ids.dono as never, 'reativar' as never, { motivo: 'tentativa' } as never, ctx() as never, deps() as never)), 'NAO_ENCONTRADO');
        assert.equal(await codigoErro(svc.empresas.alterarSituacaoEmpresa(s as never, ids.empresa as never, 'suspender' as never, { motivo: 'tentativa', confirmacaoCodigo: `p063-alegria-${sufixo}` } as never, ctx() as never, deps() as never)), 'NAO_ENCONTRADO');
    }
    // Rotas legadas de Usuários e acessos, como Gestão da empresa: não reabrem, não mudam papel nem assinatura de vínculo suspenso.
    const legado = (fn: string, raw: Record<string, unknown>) => codigoErro((svc.usuarios[fn] as unknown as (...a: unknown[]) => Promise<unknown>)(resp, raw, randomUUID(), undefined, ids.empresa));
    assert.equal(await legado('criarUsuarioAdministrativo', { acao: 'criar', nome: 'Dono', email: email('dono'), nivel: 'GESTAO', senha: 'qualquer-senha-1', confirmacao: 'qualquer-senha-1' }), 'AUTENTICACAO_ADMINISTRATIVA');
    assert.equal(await legado('alterarPapelNaEmpresa', { acao: 'papel', usuarioId: ids.dono, nivel: 'GESTAO' }), 'AUTENTICACAO_ADMINISTRATIVA');
    assert.equal(await legado('alterarAssinaturaNaEmpresa', { acao: 'assinatura', usuarioId: ids.dono, conceder: true }), 'AUTENTICACAO_ADMINISTRATIVA');
    assert.equal((await client.query('SELECT status FROM memberships WHERE empresa_id = $1 AND usuario_id = $2', [ids.empresa, ids.dono])).rows[0].status, 'SUSPENSA');
    // Terminais: o guard da 063 recusa sair de REVOGADA e de DESATIVADA, e o painel também.
    const terminal = (await client.query<{ id: string }>(`INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Empresa Terminal 063', 'PROVISIONAMENTO') RETURNING id`, [`p063-terminal-${sufixo}`])).rows[0].id;
    await client.query("UPDATE empresas SET status = 'ATIVA' WHERE id = $1", [terminal]);
    const m = (await client.query<{ id: string }>(`INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1, $2, 'PENDENTE', clock_timestamp(), 'ADMINISTRATIVO') RETURNING id`, [terminal, ids.resp])).rows[0].id;
    await client.query("UPDATE memberships SET status = 'ATIVA' WHERE id = $1", [m]);
    await client.query("UPDATE memberships SET status = 'REVOGADA' WHERE id = $1", [m]);
    await assert.rejects(client.query("UPDATE memberships SET status = 'ATIVA' WHERE id = $1", [m]), /transição de membership recusada/);
    await assert.rejects(client.query("UPDATE memberships SET status = 'SUSPENSA' WHERE id = $1", [m]), /transição de membership recusada/);
    assert.equal(await codigoErro(svc.vinculos.alterarSituacaoVinculo(dev as never, terminal as never, ids.resp as never, 'reativar' as never, { motivo: 'terminal' } as never, ctx() as never, deps() as never)), 'CONFLITO');
    await client.query("UPDATE empresas SET status = 'DESATIVADA' WHERE id = $1", [terminal]);
    await assert.rejects(client.query("UPDATE empresas SET status = 'ATIVA' WHERE id = $1", [terminal]), /transição de empresa recusada/);
    assert.equal(await codigoErro(svc.empresas.alterarSituacaoEmpresa(dev as never, terminal as never, 'reativar' as never, { motivo: 'terminal', confirmacaoCodigo: `p063-terminal-${sufixo}` } as never, ctx() as never, deps() as never)), 'CONFLITO');
    await svc.vinculos.alterarSituacaoVinculo(dev as never, ids.empresa as never, ids.dono as never, 'reativar' as never, { motivo: 'Fim da prova D2' } as never, ctx() as never, deps() as never);
});

test('D7: o contexto da sessão segue o papel NA empresa (Gestão por membership, plataforma pela identidade)', async () => {
    const contexto = carregar('lib/autenticacao/contexto.ts') as unknown as { contextoDaSessao: (tx: Client, s: unknown, e?: string | null) => Promise<Record<string, unknown>> };
    const resp = await contexto.contextoDaSessao(client, { usuario_id: ids.resp, papel: 'ADMINISTRATIVO' });
    assert.deepEqual([(resp.empresaAtual as { id: string }).id, resp.gestaoNaEmpresa, resp.plataforma, resp.desenvolvedor], [ids.empresa, true, false, false], 'responsável de empresa nova vê as configurações da empresa');
    const dono = await contexto.contextoDaSessao(client, { usuario_id: ids.dono, papel: 'REPRESENTANTE_AUTORIZADO' });
    assert.deepEqual([dono.empresaAtual, dono.selecaoNecessaria, dono.plataforma], [null, true, true]);
    const donoNaNova = await contexto.contextoDaSessao(client, { usuario_id: ids.dono, papel: 'REPRESENTANTE_AUTORIZADO' }, ids.empresa);
    assert.equal(donoNaNova.gestaoNaEmpresa, false, 'Equipe na empresa nova, mesmo com papel global legado');
    const dev = await contexto.contextoDaSessao(client, { usuario_id: ids.dev, papel: 'ADMINISTRATIVO' });
    assert.deepEqual([dev.desenvolvedor, dev.empresaAtual], [true, null]);
});

test('múltiplas empresas: escolha explícita, contexto/papel únicos, sessão anterior recusada e prazo preservado', async () => {
    const escolha = carregar('lib/autenticacao/empresa-ativa.ts') as unknown as { selecionarEmpresaAtiva: (t: string, e: string) => Promise<{ token: string }> };
    const auth = svc.auth as unknown as { consultarSessao: (t: string) => Promise<Record<string, string>> };
    const contexto = carregar('lib/autenticacao/contexto.ts') as unknown as { contextoDaSessao: (tx: Client, s: unknown) => Promise<{ empresaAtual: { id: string }; gestaoNaEmpresa: boolean }> };
    const anterior = await sessaoDe(ids.dono);
    const a = await escolha.selecionarEmpresaAtiva(anterior.token, ids.legado);
    const sessaoA = await auth.consultarSessao(a.token);
    assert.equal(await sessaoValida(anterior.token), false);
    assert.equal(sessaoA.autenticado_em, anterior.sessao.autenticado_em, 'troca não reautentica');
    assert.equal(sessaoA.expira_em, anterior.sessao.expira_em, 'troca não estende oito horas');
    assert.equal((await contexto.contextoDaSessao(client, sessaoA)).gestaoNaEmpresa, true);
    assert.equal((await withTransaction(tx => svc.tenant.provarTenant(tx as never, sessaoA as never)) as unknown as { empresaComprovada: string }).empresaComprovada, ids.legado);
    await assert.rejects(withTransaction(tx => svc.tenant.provarTenant(tx as never, sessaoA as never, ids.empresa as never)), /não comprova/);
    const b = await escolha.selecionarEmpresaAtiva(a.token, ids.empresa);
    const sessaoB = await auth.consultarSessao(b.token);
    assert.equal(await sessaoValida(a.token), false);
    await assert.rejects(withTransaction(tx => svc.tenant.provarTenant(tx as never, sessaoA as never)), /não comprova/, 'pedido em voo da sessão anterior');
    const c = await contexto.contextoDaSessao(client, sessaoB);
    assert.deepEqual([c.empresaAtual.id, c.gestaoNaEmpresa], [ids.empresa, false]);
    await assert.rejects(escolha.selecionarEmpresaAtiva(b.token, randomUUID()), /não comprova/);
    assert.equal(await sessaoValida(b.token), true, 'escolha recusada preserva a sessão');
});

test('seleção: suspensão invalida só as sessões daquele acesso, reativar não restaura a seleção', async () => {
    const escolha = carregar('lib/autenticacao/empresa-ativa.ts') as unknown as { selecionarEmpresaAtiva: (t: string, e: string) => Promise<{ token: string }> };
    const a = await escolha.selecionarEmpresaAtiva((await sessaoDe(ids.dono)).token, ids.legado);
    const b = await escolha.selecionarEmpresaAtiva((await sessaoDe(ids.dono)).token, ids.empresa);
    await client.query("UPDATE memberships SET status='SUSPENSA' WHERE usuario_id=$1 AND empresa_id=$2", [ids.dono, ids.empresa]);
    assert.equal(await sessaoValida(b.token), false);
    assert.equal(await sessaoValida(a.token), true, 'outra empresa mantém a sessão');
    await client.query("UPDATE memberships SET status='ATIVA' WHERE usuario_id=$1 AND empresa_id=$2", [ids.dono, ids.empresa]);
    assert.equal(await sessaoValida(b.token), false, 'reativação exige uma seleção nova');
});

test('renovação comprovada: reautenticação devolve anterior→atual e preserva a empresa ativa; senha errada não muda nada; login comum não renova', async () => {
    const selecao = carregar('lib/autenticacao/empresa-ativa.ts') as unknown as { selecionarEmpresaAtiva: (t: string, e: string) => Promise<{ token: string }> };
    const consultar = svc.auth.consultarSessao as unknown as (t: string) => Promise<{ id: string; empresa_ativa_id: string | null }>;
    const reautenticar = svc.auth.reautenticarAdmin as unknown as (t: string, s: string) => Promise<{ token: string; renovacao: { anterior: string; atual: string } | null }>;
    const escolhida = await selecao.selecionarEmpresaAtiva((await sessaoDe(ids.dono)).token, ids.legado);
    const antes = await consultar(escolhida.token);
    assert.equal(antes.empresa_ativa_id, ids.legado);
    await assert.rejects(reautenticar(escolhida.token, 'senha-errada-063'));
    assert.equal(await sessaoValida(escolhida.token), true, 'senha errada mantém a sessão');
    assert.equal((await consultar(escolhida.token)).empresa_ativa_id, ids.legado, 'senha errada mantém a empresa');
    const r = await reautenticar(escolhida.token, senhas.dono);
    assert.ok(r.renovacao);
    assert.equal(r.renovacao!.anterior, antes.id);
    const depois = await consultar(r.token);
    assert.equal(depois.id, r.renovacao!.atual, 'a renovação aponta a sessão nova emitida');
    assert.equal(depois.empresa_ativa_id, ids.legado, 'a empresa ativa é preservada');
    assert.equal(await sessaoValida(escolhida.token), false, 'a sessão anterior deixa de valer');
    const login = await (svc.auth.loginAdmin as unknown as (...a: unknown[]) => Promise<{ renovacao: unknown }>)(email('dono'), senhas.dono, randomUUID(), null, null);
    assert.equal(login.renovacao, null, 'login comum não é renovação');
});

test('perfil da empresa nova (implantação): Equipe e conta sem vínculo recusadas; a Gestão cria perfil, unidade e capacidades; associação pelo código; idempotente', async () => {
    const criacao = carregar('lib/perfil/criacao.ts') as unknown as { criarPerfilDaEmpresa: (tx: Client, tenant: unknown, input: Record<string, unknown>, auditoria: Fn) => Promise<{ criado: boolean; perfilId: string; unidadeId: string | null; motivo: string }> };
    const tenantMod = carregar('lib/perfil/tenant.ts') as unknown as { perfilDoTenant: (tx: Client, e: string) => Promise<string>; perfilDoTenantOuNulo: (tx: Client, e: string) => Promise<string | null> };
    const registrar = (carregar('lib/clientes/repositories/auditoria.repository.ts') as unknown as { registrarAuditoria: Fn }).registrarAuditoria;
    const executarNoTenant = svc.tenant.executarNoTenant as unknown as (tx: Client, s: unknown, e: string, w: (t: Client, tenant: unknown) => Promise<unknown>) => Promise<unknown>;
    const criarComo = (usuarioId: string, empresaId: string, autenticadoHaMs = 0) => withTransaction((tx) => executarNoTenant(tx, { usuario_id: usuarioId, papel: 'ADMINISTRATIVO' }, empresaId,
        (t, tenant) => criacao.criarPerfilDaEmpresa(t, tenant, { autenticadoEm: new Date(Date.now() - autenticadoHaMs).toISOString(), agora: Date.now(), requestId: randomUUID() }, registrar)));
    assert.equal(await tenantMod.perfilDoTenantOuNulo(client, ids.empresa), null, 'empresa provisionada pelo painel nasce sem perfil');
    assert.equal(await codigoErro(criarComo(ids.dono, ids.empresa)), 'PAPEL_NAO_AUTORIZADO', 'Equipe nesta empresa não cria o perfil');
    assert.equal(await codigoErro(criarComo(ids.dev, ids.empresa)), 'TENANT_NAO_COMPROVADO', 'concessão de desenvolvedor não dá acesso operacional à empresa');
    assert.equal(await codigoErro(criarComo(ids.resp, ids.empresa, 6 * 60_000)), 'PERFIL_REAUTENTICACAO', 'senha confirmada há mais de 5 min');
    assert.equal(await contar('SELECT count(*)::int AS n FROM perfil_empresas'), 0, 'nenhuma recusa escreveu');
    const r = await criarComo(ids.resp, ids.empresa) as { criado: boolean; perfilId: string; unidadeId: string | null; motivo: string };
    assert.deepEqual([r.criado, r.motivo], [true, 'CRIADO']);
    ids.perfil = r.perfilId;
    const perfil = (await client.query<{ codigo: string; nome_comercial: string; razao_social: string | null; cnpj: string | null; versao: number }>('SELECT codigo, nome_comercial, razao_social, cnpj, versao FROM perfil_empresas WHERE id = $1', [r.perfilId])).rows[0];
    assert.deepEqual(perfil, { codigo: `p063-alegria-${sufixo}`, nome_comercial: 'Buffet Alegria 063', razao_social: null, cnpj: '11222333000181', versao: 0 }, 'só nome e CNPJ válido do cadastro administrativo são pré-preenchidos');
    assert.equal(await contar('SELECT count(*)::int AS n FROM perfil_unidades WHERE empresa_id = $1', [r.perfilId]), 1);
    assert.equal(await contar('SELECT count(*)::int AS n FROM perfil_empresa_concessoes WHERE empresa_id = $1 AND usuario_id = $2 AND revogado_em IS NULL', [r.perfilId, ids.resp]), 4);
    assert.equal(await tenantMod.perfilDoTenant(client, ids.empresa), r.perfilId, 'associado pelo código da empresa');
    const cadastro = carregar('lib/perfil/cadastro-service.ts') as unknown as { lerCadastroPerfil: (tx: Client, u: string, p: string) => Promise<{ contexto: { codigoEmpresa: string } | null; capacidades: Record<string, boolean> | null }> };
    const lido = await cadastro.lerCadastroPerfil(client, ids.resp, r.perfilId);
    assert.equal(lido.contexto?.codigoEmpresa, `p063-alegria-${sufixo}`);
    assert.deepEqual(Object.values(lido.capacidades ?? {}), [true, true, true, true], 'a Gestão que criou administra o perfil');
    const denovo = await criarComo(ids.resp, ids.empresa) as { criado: boolean; motivo: string };
    assert.deepEqual([denovo.criado, denovo.motivo], [false, 'JA_EXISTE'], 'idempotente');
    assert.equal(await contar('SELECT count(*)::int AS n FROM perfil_empresas'), 1);
    assert.equal(await contar("SELECT count(*)::int AS n FROM auditoria WHERE acao = 'PERFIL_ESTRUTURA_CRIADA' AND entidade_id = $1", [r.perfilId]), 1);
    assert.equal(await contar("SELECT count(*)::int AS n FROM auditoria WHERE origem = 'PERFIL_EMPRESA' AND (dados_depois::text ~ 'scrypt\\$' OR dados_depois::text ~ '#t=')"), 0);
});

test('perfil legado sem código correspondente continua da empresa kidmais mesmo com várias empresas; dois órfãos fecham o acesso', async () => {
    const tenantMod = carregar('lib/perfil/tenant.ts') as unknown as { perfilDoTenant: (tx: Client, e: string) => Promise<string>; perfilDoTenantOuNulo: (tx: Client, e: string) => Promise<string | null> };
    const kidmais = (await client.query<{ id: string }>("SELECT id FROM empresas WHERE codigo = 'kidmais' AND status = 'ATIVA'")).rows[0]?.id;
    assert.ok(kidmais, 'empresa legada da 046 presente no modelo');
    assert.ok(await contar('SELECT count(*)::int AS n FROM empresas') > 1, 'instalação com várias empresas (o atalho da instalação única não vale)');
    const orfao = (await client.query<{ id: string }>('INSERT INTO perfil_empresas (codigo) VALUES ($1) RETURNING id', [`EMP-${sufixo}`])).rows[0].id;
    assert.equal(await tenantMod.perfilDoTenant(client, kidmais), orfao, 'o único perfil órfão pertence à kidmais');
    assert.equal(await tenantMod.perfilDoTenantOuNulo(client, ids.legado), null, 'o órfão não vaza para outra empresa sem perfil');
    assert.equal(await tenantMod.perfilDoTenant(client, ids.empresa), ids.perfil, 'o perfil da contratante segue associado pelo código');
    const segundo = (await client.query<{ id: string }>('INSERT INTO perfil_empresas (codigo) VALUES ($1) RETURNING id', [`EMP-2-${sufixo}`])).rows[0].id;
    assert.equal(await codigoErro(tenantMod.perfilDoTenant(client, kidmais)), 'PERFIL_ESTRUTURA_AUSENTE', 'dois órfãos: ninguém é escolhido');
    await client.query('DELETE FROM perfil_empresas WHERE id = $1', [segundo]);
    assert.equal(await tenantMod.perfilDoTenant(client, kidmais), orfao);
});

test('implantação: CONCLUÍDA é recusada com pendências reais (auditada) e aceita depois do perfil aplicado; a ficha lista as pendências', async () => {
    const dev = (await sessaoDe(ids.dev)).sessao;
    const revisao = async () => (await client.query<{ revisao: number }>('SELECT revisao::int AS revisao FROM plataforma_empresas_cadastro WHERE empresa_id = $1', [ids.empresa])).rows[0].revisao;
    const concluir = async () => svc.empresas.alterarImplantacao(dev as never, ids.empresa as never, { implantacao: 'CONCLUIDA', revisao: await revisao() } as never, ctx() as never, deps() as never);
    const recusa = await concluir().then(() => null, (e) => e as { code?: string; httpStatus?: number; details?: { pendencias?: Array<{ codigo: string }> } });
    assert.equal(recusa?.code, 'IMPLANTACAO_PENDENTE');
    assert.equal(recusa?.httpStatus, 409);
    assert.deepEqual(recusa?.details?.pendencias?.map((p) => p.codigo), ['PERFIL_APLICADO'], 'Gestão ativa e perfil criado já atendidos; falta aplicar o cadastro');
    assert.equal((await client.query('SELECT implantacao FROM plataforma_empresas_cadastro WHERE empresa_id = $1', [ids.empresa])).rows[0].implantacao, 'EM_CONFIGURACAO', 'nada mudou');
    assert.equal(await contar("SELECT count(*)::int AS n FROM auditoria WHERE acao = 'EMPRESA_IMPLANTACAO_RECUSADA' AND entidade_id = $1", [ids.empresa]), 1);
    const antes = await svc.empresas.obterEmpresa(dev as never, ids.empresa as never) as unknown as { implantacao: { podeConcluir: boolean; itens: Array<{ codigo: string; atendida: boolean; obrigatoria: boolean }> } };
    assert.equal(antes.implantacao.podeConcluir, false);
    assert.deepEqual(antes.implantacao.itens.filter((i) => i.obrigatoria).map((i) => [i.codigo, i.atendida]), [['GESTAO_ATIVA', true], ['PERFIL_CRIADO', true], ['PERFIL_APLICADO', false]]);
    const cadastro = carregar('lib/perfil/cadastro-service.ts') as unknown as { salvarRascunhoPerfil: (tx: Client, i: Record<string, unknown>, a: Fn) => Promise<{ numero: number; edicao: number; versaoBase: number }>; aplicarCadastroPerfil: (tx: Client, i: Record<string, unknown>, a: Fn) => Promise<unknown> };
    const registrar = (carregar('lib/clientes/repositories/auditoria.repository.ts') as unknown as { registrarAuditoria: Fn }).registrarAuditoria;
    const endereco = { cep: '01001000', logradouro: 'Praça da Sé', numero: '', semNumero: true, complemento: '', bairro: 'Sé', cidade: 'São Paulo', uf: 'SP', pais: 'BR' };
    const dados = { nomeComercial: 'Buffet Alegria 063', razaoSocial: 'Alegria Festas Ltda', cnpj: '11222333000181', sede: endereco, unidadeNome: 'Sede', mesmoEnderecoSede: true, unidade: endereco, referenciaChegada: '', telefone: '11999990063', whatsapp: '', emailComercial: '', site: '', instagram: '' };
    const rascunho = await withTransaction((tx) => cadastro.salvarRascunhoPerfil(tx, { usuarioId: ids.resp, perfilDoServidor: ids.perfil, empresaIdCliente: null, numero: null, edicao: null, versaoBase: 0, cadastro: dados, requestId: randomUUID() }, registrar));
    await withTransaction((tx) => cadastro.aplicarCadastroPerfil(tx, { usuarioId: ids.resp, perfilDoServidor: ids.perfil, empresaIdCliente: null, ...rascunho, confirmar: true, motivo: 'Implantação da contratante', autenticadoEm: new Date().toISOString(), agora: Date.now(), requestId: randomUUID() }, registrar));
    assert.equal((await client.query('SELECT versao FROM perfil_empresas WHERE id = $1', [ids.perfil])).rows[0].versao, 1);
    const ok = await concluir() as { implantacao: string; alterado: boolean };
    assert.deepEqual([ok.implantacao, ok.alterado], ['CONCLUIDA', true]);
    const depois = await svc.empresas.obterEmpresa(dev as never, ids.empresa as never) as unknown as { empresa: { cadastro: { implantacao: string; implantacaoConcluidaEm: string | null } }; implantacao: { podeConcluir: boolean; itens: Array<{ codigo: string; atendida: boolean; obrigatoria: boolean }> } };
    assert.equal(depois.empresa.cadastro.implantacao, 'CONCLUIDA');
    assert.ok(depois.empresa.cadastro.implantacaoConcluidaEm);
    assert.equal(depois.implantacao.podeConcluir, true);
    assert.ok(depois.implantacao.itens.filter((i) => i.obrigatoria).every((i) => i.atendida));
    assert.equal(await contar("SELECT count(*)::int AS n FROM auditoria WHERE acao = 'EMPRESA_IMPLANTACAO_ALTERADA' AND entidade_id = $1 AND dados_depois->>'implantacao' = 'CONCLUIDA'", [ids.empresa]), 1);
});

test('Retry-After: reenvio dentro do intervalo e recuperação repetida pelo painel devolvem o prazo restante calculável', async () => {
    const dev = (await sessaoDe(ids.dev)).sessao;
    const convite = await svc.vinculos.convidarUsuario(dev as never, ids.empresa as never, { email: email('retry'), nivel: 'EQUIPE' } as never, ctx() as never, deps() as never) as unknown as { conviteId: string; envio: { enviado: boolean } };
    assert.equal(convite.envio.enviado, true);
    const reenvio = await (svc.vinculos.reenviarConvite(dev as never, ids.empresa as never, convite.conviteId as never, ctx() as never, deps() as never) as unknown as Promise<unknown>)
        .then(() => null, (e) => e as { code?: string; httpStatus?: number; details?: { retryAfterSegundos?: number } });
    assert.deepEqual([reenvio?.code, reenvio?.httpStatus], ['LIMITE_TENTATIVAS', 429]);
    const prazo = reenvio?.details?.retryAfterSegundos;
    assert.ok(typeof prazo === 'number' && prazo >= 1 && prazo <= 60, `prazo do reenvio: ${prazo}`);
    const depsRec = { ...deps(), criarHashSenha: svc.senha.criarHashSenha };
    const primeira = await svc.vinculos.solicitarRecuperacaoPeloPainel(dev as never, ids.empresa as never, ids.dono as never, ctx() as never, depsRec as never) as unknown as { enviado: boolean };
    assert.equal(primeira.enviado, true);
    const repetida = await (svc.vinculos.solicitarRecuperacaoPeloPainel(dev as never, ids.empresa as never, ids.dono as never, ctx() as never, depsRec as never) as unknown as Promise<unknown>)
        .then(() => null, (e) => e as { code?: string; details?: { retryAfterSegundos?: number } });
    assert.equal(repetida?.code, 'LIMITE_TENTATIVAS');
    const espera = repetida?.details?.retryAfterSegundos;
    assert.ok(typeof espera === 'number' && espera >= 1 && espera <= 120, `prazo da recuperação: ${espera}`);
});

test('auditoria consultável: por empresa, por ação e por período, paginada; só origens administrativas; sem segredos; sem concessão → 404', async () => {
    const consulta = carregar('lib/desenvolvedor/auditoria-consulta.ts') as unknown as {
        ORIGENS_ADMINISTRATIVAS: readonly string[];
        consultarAuditoria: (s: unknown, raw: unknown, d: unknown) => Promise<{ itens: Array<{ acao: string; origem: string; empresaId: string | null }>; total: number; porPagina: number; acoes: string[]; empresas: Array<{ id: string }> }>;
    };
    const dev = (await sessaoDe(ids.dev)).sessao;
    const dono = (await sessaoDe(ids.dono)).sessao;
    assert.equal(await codigoErro(consulta.consultarAuditoria(dono, {}, deps())), 'NAO_ENCONTRADO', 'Gestão sem concessão não consulta');
    const porEmpresa = await consulta.consultarAuditoria(dev, { empresaId: ids.empresa }, deps());
    assert.ok(porEmpresa.total >= 10, `registros da empresa: ${porEmpresa.total}`);
    assert.ok(porEmpresa.itens.every((i) => i.empresaId === null || i.empresaId === ids.empresa), 'nenhum registro de outra empresa');
    assert.ok(porEmpresa.itens.some((i) => i.acao === 'PERFIL_ESTRUTURA_CRIADA'), 'o perfil criado pela Gestão aparece na atividade da empresa');
    assert.ok(porEmpresa.itens.every((i) => consulta.ORIGENS_ADMINISTRATIVAS.includes(i.origem)));
    const porAcao = await consulta.consultarAuditoria(dev, { acao: 'CONVITE_CRIADO' }, deps());
    assert.ok(porAcao.total >= 3 && porAcao.itens.every((i) => i.acao === 'CONVITE_CRIADO'));
    const tudo = await consulta.consultarAuditoria(dev, {}, deps());
    const dia = (deslocamento: number) => new Date(Date.now() + deslocamento * 86_400_000).toISOString().slice(0, 10);
    assert.equal((await consulta.consultarAuditoria(dev, { de: dia(-1), ate: dia(1) }, deps())).total, tudo.total, 'tudo desta suíte está na janela');
    assert.equal((await consulta.consultarAuditoria(dev, { de: '2000-01-01', ate: '2000-01-02' }, deps())).total, 0);
    assert.equal(tudo.itens.length, Math.min(25, tudo.total));
    const ultima = Math.ceil(tudo.total / 25);
    assert.equal((await consulta.consultarAuditoria(dev, { pagina: ultima }, deps())).itens.length, tudo.total - (ultima - 1) * 25, 'última página');
    const texto = JSON.stringify([...porEmpresa.itens, ...tudo.itens, ...porAcao.itens]);
    for (const s of [...Object.values(senhas), 'senha-recuperada-063', ...enviados.map((e) => e.texto.match(/#t=([A-Za-z0-9_-]{43})/)?.[1]).filter(Boolean) as string[]])
        assert.ok(!texto.includes(s), 'segredo na consulta');
    assert.doesNotMatch(texto, /scrypt\$|#t=|"token"|"senha"|"hash"/i);
    assert.ok(tudo.acoes.includes('EMPRESA_PROVISIONADA') && tudo.empresas.some((e) => e.id === ids.empresa));
});

/**
 * Achado Astra (PR #104): perfil existente sem administrador elegível. A Gestão ativa da empresa pode assumir a
 * administração pela interface; a elegibilidade é lida sem travas e sem nada do cadastro; a concessão revalida tudo
 * na transação (Gestão, empresa ativa, associação única, reautenticação, ausência de administrador elegível), não
 * eleva quem tem concessões parciais quando há administrador, não duplica e serializa a concorrência.
 */
type Elegibilidade = { elegivel: boolean; motivo: string | null; capacidadesFaltantes: string[] };
type ResultadoConcessao = { criado: boolean; perfilId: string; capacidadesConcedidas: string[]; motivo: string };
const TODAS = ['PERFIL_CONSULTAR', 'PERFIL_EDITAR_RASCUNHO', 'PERFIL_APLICAR', 'PERFIL_ADMINISTRAR_CONCESSOES'];
function concessaoInicialApi() {
    const criacao = carregar('lib/perfil/criacao.ts') as unknown as {
        criarPerfilDaEmpresa: (tx: Client, tenant: unknown, input: Record<string, unknown>, auditoria: Fn, opcoes: { exigirExistente: boolean }) => Promise<ResultadoConcessao>;
        elegibilidadeConcessaoInicial: (tx: Client, tenant: unknown) => Promise<Elegibilidade>;
    };
    const registrar = (carregar('lib/clientes/repositories/auditoria.repository.ts') as unknown as { registrarAuditoria: Fn }).registrarAuditoria;
    const executarNoTenant = svc.tenant.executarNoTenant as unknown as (tx: Client, s: unknown, e: string, w: (t: Client, tenant: unknown) => Promise<unknown>) => Promise<unknown>;
    const sessao = (usuarioId: string) => ({ usuario_id: usuarioId, papel: 'ADMINISTRATIVO' });
    const elegibilidade = (usuarioId: string, empresaId = ids.concEmpresa) => withTransaction((tx) => executarNoTenant(tx, sessao(usuarioId), empresaId, (t, tenant) => criacao.elegibilidadeConcessaoInicial(t, tenant))) as Promise<Elegibilidade>;
    const assumirEm = (tx: Client, usuarioId: string, empresaId = ids.concEmpresa, autenticadoHaMs = 0) => executarNoTenant(tx, sessao(usuarioId), empresaId,
        (t, tenant) => criacao.criarPerfilDaEmpresa(t, tenant, { autenticadoEm: new Date(Date.now() - autenticadoHaMs).toISOString(), agora: Date.now(), requestId: randomUUID() }, registrar, { exigirExistente: true })) as Promise<ResultadoConcessao>;
    const assumir = (usuarioId: string, empresaId = ids.concEmpresa, autenticadoHaMs = 0) => withTransaction((tx) => assumirEm(tx, usuarioId, empresaId, autenticadoHaMs));
    const ativas = async (usuarioId?: string) => (await client.query<{ capacidade: string }>(
        'SELECT capacidade FROM perfil_empresa_concessoes WHERE empresa_id = $1 AND revogado_em IS NULL AND ($2::uuid IS NULL OR usuario_id = $2::uuid)', [ids.concPerfil, usuarioId ?? null])).rows.map((l) => l.capacidade).sort((a, b) => TODAS.indexOf(a) - TODAS.indexOf(b));
    const revogar = (usuarioId: string, capacidades: string[]) => client.query(
        "UPDATE perfil_empresa_concessoes SET revogado_em = clock_timestamp(), revogado_por = $2, motivo_revogacao = 'fixture do teste' WHERE empresa_id = $1 AND usuario_id = $2 AND capacidade = ANY($3::text[]) AND revogado_em IS NULL",
        [ids.concPerfil, usuarioId, capacidades]);
    const conceder = (usuarioId: string, porQuem: string, capacidades: string[]) => Promise.all(capacidades.map((c) => client.query(
        "INSERT INTO perfil_empresa_concessoes (empresa_id, usuario_id, capacidade, concedido_por, motivo, referencia_autorizacao) VALUES ($1, $2, $3, $4, 'fixture do teste', 'TESTE')", [ids.concPerfil, usuarioId, c, porQuem])));
    return { elegibilidade, assumir, assumirEm, ativas, revogar, conceder };
}

test('concessão inicial — fixtures: empresa ativa com perfil existente sem concessões; duas Gestões, Equipe, vínculo suspenso e revogado', async () => {
    const hash = await svc.senha.criarHashSenha(senhas.resp);
    for (const chave of ['gestaoA', 'gestaoB', 'equipeC', 'suspensaD', 'revogadaE'])
        ids[chave] = (await client.query<{ id: string }>('INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel) VALUES ($1, $2, $3, $4) RETURNING id', [email(chave.toLowerCase()), 'Pessoa ' + chave, hash, 'ADMINISTRATIVO'])).rows[0].id;
    ids.concEmpresa = (await client.query<{ id: string }>("INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Contratante Concessão 063', 'PROVISIONAMENTO') RETURNING id", ['p063-conc-' + sufixo])).rows[0].id;
    await client.query("UPDATE empresas SET status = 'ATIVA' WHERE id = $1", [ids.concEmpresa]);
    const vinculo = async (usuario: string, papel: string, status: string) => {
        const m = (await client.query<{ id: string }>("INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1, $2, 'PENDENTE', clock_timestamp(), $3) RETURNING id", [ids.concEmpresa, usuario, papel])).rows[0].id;
        await client.query("UPDATE memberships SET status = 'ATIVA' WHERE id = $1", [m]);
        if (status !== 'ATIVA')
            await client.query('UPDATE memberships SET status = $2 WHERE id = $1', [m, status]);
        return m;
    };
    await vinculo(ids.gestaoA, 'REPRESENTANTE_AUTORIZADO', 'ATIVA');
    await vinculo(ids.gestaoB, 'REPRESENTANTE_AUTORIZADO', 'ATIVA');
    await vinculo(ids.equipeC, 'ADMINISTRATIVO', 'ATIVA');
    await vinculo(ids.suspensaD, 'REPRESENTANTE_AUTORIZADO', 'SUSPENSA');
    await vinculo(ids.revogadaE, 'REPRESENTANTE_AUTORIZADO', 'REVOGADA');
    // Perfil "legado": existe, associado pelo código, sem nenhuma concessão (ninguém administra).
    ids.concPerfil = (await client.query<{ id: string }>('INSERT INTO perfil_empresas (codigo, nome_comercial) VALUES ($1, $2) RETURNING id', ['p063-conc-' + sufixo, 'Concessão Festas 063'])).rows[0].id;
    await client.query("INSERT INTO perfil_unidades (empresa_id, codigo, nome, mesmo_endereco_sede) VALUES ($1::uuid, $2, 'Sede', true)", [ids.concPerfil, 'p063-conc-' + sufixo + '-principal']);
    const tenantMod = carregar('lib/perfil/tenant.ts') as unknown as { perfilDoTenant: (tx: Client, e: string) => Promise<string> };
    assert.equal(await tenantMod.perfilDoTenant(client, ids.concEmpresa), ids.concPerfil);
    assert.equal(await contar('SELECT count(*)::int AS n FROM perfil_empresa_concessoes WHERE empresa_id = $1', [ids.concPerfil]), 0);
});

test('concessão inicial — elegibilidade: só a Gestão ativa da empresa ativa; Equipe, sem vínculo, suspenso, revogado e empresa suspensa recusados; o cadastro continua fechado', async () => {
    const api = concessaoInicialApi();
    assert.deepEqual(await api.elegibilidade(ids.gestaoA), { elegivel: true, motivo: null, capacidadesFaltantes: TODAS });
    assert.deepEqual(await api.elegibilidade(ids.equipeC), { elegivel: false, motivo: 'SEM_GESTAO', capacidadesFaltantes: [] });
    for (const [quem, rotulo] of [[ids.dev, 'desenvolvedor sem vínculo'], [ids.suspensaD, 'vínculo suspenso'], [ids.revogadaE, 'vínculo revogado'], [ids.dono, 'Gestão de outra empresa']] as const) {
        assert.equal(await codigoErro(api.elegibilidade(quem)), 'TENANT_NAO_COMPROVADO', rotulo + ': nem a elegibilidade é lida');
        assert.equal(await codigoErro(api.assumir(quem)), 'TENANT_NAO_COMPROVADO', rotulo + ': nada concedido');
    }
    assert.equal(await codigoErro(api.assumir(ids.equipeC)), 'PAPEL_NAO_AUTORIZADO', 'Equipe não assume');
    await client.query("UPDATE empresas SET status = 'SUSPENSA' WHERE id = $1", [ids.concEmpresa]);
    assert.equal(await codigoErro(api.elegibilidade(ids.gestaoA)), 'TENANT_NAO_COMPROVADO', 'empresa suspensa: Gestão sem tenant');
    assert.equal(await codigoErro(api.assumir(ids.gestaoA)), 'TENANT_NAO_COMPROVADO');
    await client.query("UPDATE empresas SET status = 'ATIVA' WHERE id = $1", [ids.concEmpresa]);
    assert.deepEqual(await api.ativas(), [], 'nenhuma recusa escreveu');
    const cadastro = carregar('lib/perfil/cadastro-service.ts') as unknown as { lerCadastroPerfil: (tx: Client, u: string, p: string) => Promise<unknown> };
    assert.equal(await codigoErro(cadastro.lerCadastroPerfil(client, ids.gestaoA, ids.concPerfil)), 'PERFIL_SEM_CONCESSAO', 'antes da concessão o GET do cadastro continua 403: a tela só recebe a elegibilidade');
});

test('concessão inicial — reautenticação vencida não concede; a Gestão assume as quatro capacidades (auditado); repetição não duplica; a segunda Gestão fica bloqueada', async () => {
    const api = concessaoInicialApi();
    assert.equal(await codigoErro(api.assumir(ids.gestaoA, ids.concEmpresa, 6 * 60_000)), 'PERFIL_REAUTENTICACAO');
    assert.deepEqual(await api.ativas(), []);
    const r = await api.assumir(ids.gestaoA);
    assert.deepEqual([r.criado, r.perfilId, r.motivo, r.capacidadesConcedidas], [false, ids.concPerfil, 'CONCESSAO_INICIAL', TODAS]);
    assert.deepEqual(await api.ativas(ids.gestaoA), TODAS);
    const auditoria = (await client.query<{ dados_depois: { capacidades: string[]; jaPossuia: string[]; origemConcessao: string } }>("SELECT dados_depois FROM auditoria WHERE acao = 'PERFIL_CONCESSAO_INICIAL' AND entidade_id = $1 ORDER BY criado_em", [ids.concPerfil])).rows;
    assert.equal(auditoria.length, 1);
    assert.deepEqual(auditoria[0].dados_depois.capacidades, TODAS);
    assert.deepEqual([auditoria[0].dados_depois.jaPossuia, auditoria[0].dados_depois.origemConcessao], [[], 'IMPLANTACAO']);
    const cadastro = carregar('lib/perfil/cadastro-service.ts') as unknown as { lerCadastroPerfil: (tx: Client, u: string, p: string) => Promise<{ capacidades: Record<string, boolean> | null }> };
    assert.deepEqual(Object.values((await cadastro.lerCadastroPerfil(client, ids.gestaoA, ids.concPerfil)).capacidades ?? {}), [true, true, true, true], 'depois da concessão o cadastro abre');
    const denovo = await api.assumir(ids.gestaoA);
    assert.deepEqual([denovo.motivo, denovo.capacidadesConcedidas], ['JA_EXISTE', []], 'repetir não duplica');
    assert.equal(await contar('SELECT count(*)::int AS n FROM perfil_empresa_concessoes WHERE empresa_id = $1', [ids.concPerfil]), 4);
    assert.deepEqual(await api.elegibilidade(ids.gestaoA), { elegivel: false, motivo: 'JA_ADMINISTRA', capacidadesFaltantes: [] });
    assert.deepEqual(await api.elegibilidade(ids.gestaoB), { elegivel: false, motivo: 'ADMINISTRADOR_EXISTENTE', capacidadesFaltantes: [] });
    const recusa = await api.assumir(ids.gestaoB).then(() => null, (e) => e as { code?: string; httpStatus?: number });
    assert.deepEqual([recusa?.code, recusa?.httpStatus], ['PERFIL_SEM_CONCESSAO', 409]);
    assert.deepEqual(await api.ativas(ids.gestaoB), []);
    assert.equal(await contar("SELECT count(*)::int AS n FROM auditoria WHERE acao = 'PERFIL_CONCESSAO_INICIAL' AND entidade_id = $1", [ids.concPerfil]), 1);
});

test('concessão inicial — concessões parciais: com administrador elegível ninguém é elevado; sem administrador, só o que falta é concedido (sem duplicar); vínculo suspenso não conta como administrador', async () => {
    const api = concessaoInicialApi();
    await api.conceder(ids.gestaoB, ids.gestaoA, ['PERFIL_CONSULTAR']);
    assert.deepEqual(await api.elegibilidade(ids.gestaoB), { elegivel: false, motivo: 'ADMINISTRADOR_EXISTENTE', capacidadesFaltantes: [] }, 'ter só PERFIL_CONSULTAR não dá direito a assumir enquanto há administrador');
    assert.equal(await codigoErro(api.assumir(ids.gestaoB)), 'PERFIL_SEM_CONCESSAO');
    assert.deepEqual(await api.ativas(ids.gestaoB), ['PERFIL_CONSULTAR'], 'nada elevado');
    // A administração da Gestão A é suspensa com o vínculo: ela deixa de ser administradora elegível.
    await client.query("UPDATE memberships SET status = 'SUSPENSA' WHERE empresa_id = $1 AND usuario_id = $2", [ids.concEmpresa, ids.gestaoA]);
    assert.deepEqual(await api.elegibilidade(ids.gestaoB), { elegivel: true, motivo: null, capacidadesFaltantes: TODAS.slice(1) }, 'sem administrador elegível, faltam só as três');
    await client.query("UPDATE memberships SET status = 'ATIVA' WHERE empresa_id = $1 AND usuario_id = $2", [ids.concEmpresa, ids.gestaoA]);
    assert.deepEqual(await api.elegibilidade(ids.gestaoB), { elegivel: false, motivo: 'ADMINISTRADOR_EXISTENTE', capacidadesFaltantes: [] });
    // Concessões parciais sem administrador: A perde ADMINISTRAR/APLICAR/EDITAR e fica só com CONSULTAR.
    await api.revogar(ids.gestaoA, TODAS.slice(1));
    assert.deepEqual(await api.ativas(ids.gestaoA), ['PERFIL_CONSULTAR']);
    assert.deepEqual(await api.elegibilidade(ids.gestaoA), { elegivel: true, motivo: null, capacidadesFaltantes: TODAS.slice(1) });
    const r = await api.assumir(ids.gestaoA);
    assert.deepEqual([r.motivo, r.capacidadesConcedidas], ['CONCESSAO_INICIAL', TODAS.slice(1)]);
    assert.deepEqual(await api.ativas(ids.gestaoA), TODAS, 'quatro capacidades ativas, nenhuma duplicada');
    assert.equal(await contar("SELECT count(*)::int AS n FROM perfil_empresa_concessoes WHERE empresa_id = $1 AND usuario_id = $2 AND capacidade = 'PERFIL_CONSULTAR'", [ids.concPerfil, ids.gestaoA]), 1, 'a capacidade que já existia não foi inserida de novo');
    const ultima = (await client.query<{ dados_depois: { capacidades: string[]; jaPossuia: string[] } }>("SELECT dados_depois FROM auditoria WHERE acao = 'PERFIL_CONCESSAO_INICIAL' AND entidade_id = $1 ORDER BY criado_em DESC LIMIT 1", [ids.concPerfil])).rows[0];
    assert.deepEqual([ultima.dados_depois.capacidades, ultima.dados_depois.jaPossuia], [TODAS.slice(1), ['PERFIL_CONSULTAR']]);
    assert.deepEqual(await api.elegibilidade(ids.gestaoB), { elegivel: false, motivo: 'ADMINISTRADOR_EXISTENTE', capacidadesFaltantes: [] });
});

test('concessão inicial — associação ambígua recusada; concorrência: a segunda Gestão espera a primeira e é recusada; nada duplicado', async () => {
    const api = concessaoInicialApi();
    // Dois perfis associados (um pelo código, outro pelo UUID): ninguém assume até a plataforma corrigir.
    await client.query('INSERT INTO perfil_empresas (id, codigo) VALUES ($1::uuid, $2)', [ids.concEmpresa, 'p063-conc-uuid-' + sufixo]);
    assert.deepEqual(await api.elegibilidade(ids.gestaoA), { elegivel: false, motivo: 'AMBIGUO', capacidadesFaltantes: [] });
    assert.equal(await codigoErro(api.assumir(ids.gestaoA)), 'PERFIL_LIMITE_V1');
    await client.query('DELETE FROM perfil_empresas WHERE id = $1::uuid', [ids.concEmpresa]);
    // Estado "ninguém administra" para as duas Gestões.
    await api.revogar(ids.gestaoA, TODAS);
    await api.revogar(ids.gestaoB, TODAS);
    assert.deepEqual(await api.ativas(), []);
    assert.deepEqual(await api.elegibilidade(ids.gestaoA), { elegivel: true, motivo: null, capacidadesFaltantes: TODAS });
    assert.deepEqual(await api.elegibilidade(ids.gestaoB), { elegivel: true, motivo: null, capacidadesFaltantes: TODAS });
    // A assume numa transação ainda aberta; B tenta em outra conexão enquanto A não confirmou.
    const outra = await conectarDescartavel({ travar: false });
    try {
        await client.query('BEGIN');
        const deA = await api.assumirEm(client, ids.gestaoA);
        assert.equal(deA.motivo, 'CONCESSAO_INICIAL');
        const deB = (async () => {
            await outra.query('BEGIN');
            try {
                const r = await api.assumirEm(outra, ids.gestaoB);
                await outra.query('COMMIT');
                return { ok: r };
            }
            catch (error) {
                await outra.query('ROLLBACK');
                return { erro: (error as { code?: string }).code };
            }
        })();
        const corrida = await Promise.race([deB, new Promise<'pendente'>((resolve) => setTimeout(() => resolve('pendente'), 400))]);
        assert.equal(corrida, 'pendente', 'B fica bloqueada enquanto a transação de A está aberta');
        await client.query('COMMIT');
        assert.deepEqual(await deB, { erro: 'PERFIL_SEM_CONCESSAO' }, 'depois do commit de A, B vê a administradora e é recusada');
    }
    finally {
        await encerrarDescartavel(outra, false);
    }
    assert.deepEqual(await api.ativas(ids.gestaoA), TODAS);
    assert.deepEqual(await api.ativas(ids.gestaoB), []);
    assert.equal(await contar('SELECT count(*)::int AS n FROM perfil_empresa_concessoes WHERE empresa_id = $1 AND revogado_em IS NULL', [ids.concPerfil]), 4);
    assert.equal(await contar("SELECT count(*)::int AS n FROM auditoria WHERE acao = 'PERFIL_CONCESSAO_INICIAL' AND entidade_id = $1", [ids.concPerfil]), 3);
    assert.equal(await contar("SELECT count(*)::int AS n FROM auditoria WHERE origem = 'PERFIL_EMPRESA' AND entidade_id = $1 AND (dados_depois::text ~ 'scrypt\\$' OR dados_depois::text ~ 'senha')", [ids.concPerfil]), 0, 'auditoria sem segredos');
});

test('H0 (database/checks/20261006_h0_perfil_legado_leitura.sql): mesma associação da aplicação; órfão único da kidmais com administrador; ambiguidades marcadas; inelegíveis por conta/vínculo não contam', async () => {
    const h0 = readFileSync('database/checks/20261006_h0_perfil_legado_leitura.sql', 'utf8');
    assert.match(h0, /^BEGIN READ ONLY;/m);
    assert.match(h0, /^ROLLBACK;\s*$/m);
    const semComentarios = h0.split(/\r?\n/).map((l) => l.replace(/--.*$/, '')).join('\n');
    assert.doesNotMatch(semComentarios, /\b(INSERT|UPDATE|DELETE|MERGE|COPY|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE)\b|senha|token|password/i, 'somente leitura, sem segredos');
    const kidmais = (await client.query<{ id: string }>("SELECT id FROM empresas WHERE codigo = 'kidmais'")).rows[0].id;
    const orfao = (await client.query<{ id: string }>('SELECT id FROM perfil_empresas WHERE codigo = $1', ['EMP-' + sufixo])).rows[0].id;
    const hash = await svc.senha.criarHashSenha(senhas.resp);
    const pessoa = async (chave: string, ativo = true) => (await client.query<{ id: string }>('INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, $2, $3, $4, $5) RETURNING id', [email('h0-' + chave), 'H0 ' + chave, hash, 'ADMINISTRATIVO', ativo])).rows[0].id;
    const vinculoNaKidmais = async (usuario: string, papel: string, status: string) => {
        const m = (await client.query<{ id: string }>("INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1, $2, 'PENDENTE', clock_timestamp(), $3) RETURNING id", [kidmais, usuario, papel])).rows[0].id;
        await client.query("UPDATE memberships SET status = 'ATIVA' WHERE id = $1", [m]);
        if (status !== 'ATIVA')
            await client.query('UPDATE memberships SET status = $2 WHERE id = $1', [m, status]);
    };
    const administrar = (usuario: string) => client.query("INSERT INTO perfil_empresa_concessoes (empresa_id, usuario_id, capacidade, concedido_por, motivo, referencia_autorizacao) VALUES ($1, $2, 'PERFIL_ADMINISTRAR_CONCESSOES', $2, 'fixture H0', 'TESTE')", [orfao, usuario]);
    // Órfão único da kidmais: K administra (elegível); I (conta inativa), S (vínculo suspenso) e Q (Equipe) não contam.
    const k = await pessoa('k');
    await vinculoNaKidmais(k, 'REPRESENTANTE_AUTORIZADO', 'ATIVA');
    await administrar(k);
    const i = await pessoa('i', false);
    await vinculoNaKidmais(i, 'REPRESENTANTE_AUTORIZADO', 'ATIVA');
    await administrar(i);
    const sus = await pessoa('s');
    await vinculoNaKidmais(sus, 'REPRESENTANTE_AUTORIZADO', 'SUSPENSA');
    await administrar(sus);
    const q = await pessoa('q');
    await vinculoNaKidmais(q, 'ADMINISTRATIVO', 'ATIVA');
    await administrar(q);
    // Ambiguidade perfil → várias empresas (UUID da empresa legado + código de uma empresa nova) e
    // vários perfis → mesma empresa (segundo perfil apontando pelo UUID para a empresa da concessão).
    const e2 = (await client.query<{ id: string }>("INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Empresa H0 063', 'PROVISIONAMENTO') RETURNING id", ['p063-h0-' + sufixo])).rows[0].id;
    await client.query("UPDATE empresas SET status = 'ATIVA' WHERE id = $1", [e2]);
    await client.query('INSERT INTO perfil_empresas (id, codigo) VALUES ($1::uuid, $2)', [ids.legado, 'p063-h0-' + sufixo]);
    await client.query('INSERT INTO perfil_empresas (id, codigo) VALUES ($1::uuid, $2)', [ids.concEmpresa, 'p063-dup-' + sufixo]);
    try {
        const resultados = await client.query(h0) as unknown as Array<{ command: string; rows: Record<string, unknown>[] }>;
        assert.ok(Array.isArray(resultados) && resultados.length === 7, 'BEGIN, (0)…(4), ROLLBACK');
        assert.deepEqual([resultados[0].command, resultados[6].command], ['BEGIN', 'ROLLBACK']);
        const [, geral, legada, orfaos, associacao, multiplos] = resultados;
        assert.equal(geral.rows[0].perfil_empresas, 'perfil_empresas');
        assert.deepEqual(legada.rows.map((l) => [l.id, l.status]), [[kidmais, 'ATIVA']]);
        assert.deepEqual(orfaos.rows.map((l) => l.id), [orfao], 'o órfão continua único: os dois perfis novos casam por UUID');
        const porPerfil = new Map(associacao.rows.map((l) => [String(l.perfil_id), l]));
        const linha = (perfilId: string) => {
            const l = porPerfil.get(perfilId);
            assert.ok(l, 'perfil ' + perfilId + ' na leitura');
            return l!;
        };
        const resumo = (l: Record<string, unknown>) => [l.situacao, Number(l.candidatas), l.empresa_id, l.perfis_na_mesma_empresa === null ? null : Number(l.perfis_na_mesma_empresa), Number(l.concessoes_ativas), l.administradores_elegiveis === null ? null : Number(l.administradores_elegiveis)];
        assert.deepEqual(resumo(linha(ids.perfil)), ['OK', 1, ids.empresa, 1, 4, 1], 'associação direta pelo código, com administradora (resp)');
        assert.deepEqual(resumo(linha(orfao)), ['OK', 1, kidmais, 1, 4, 1], 'órfão único → kidmais; só K conta como administrador');
        assert.deepEqual(resumo(linha(ids.concPerfil)), ['OK', 1, ids.concEmpresa, 2, 4, 1], 'direta pelo código; a empresa tem dois perfis');
        const dup = linha((await client.query<{ id: string }>('SELECT id FROM perfil_empresas WHERE codigo = $1', ['p063-dup-' + sufixo])).rows[0].id);
        assert.deepEqual(resumo(dup), ['OK', 1, ids.concEmpresa, 2, 0, 0], 'perfil sem administrador, mesma empresa do anterior');
        const amb = linha(ids.legado);
        assert.deepEqual(resumo(amb), ['AMBIGUO_VARIAS_EMPRESAS', 2, null, null, 0, null], 'nenhuma empresa é escolhida quando há duas candidatas');
        assert.equal(amb.candidatas_codigos, ['p063-h0-' + sufixo, 'p063-legado-' + sufixo].sort().join(', '));
        assert.deepEqual(multiplos.rows.map((l) => [l.empresa_id, Number(l.perfis)]), [[ids.concEmpresa, 2]], 'vários perfis → mesma empresa');
        for (const r of resultados)
            assert.doesNotMatch(JSON.stringify(r.rows), /scrypt\$|senha|nome_comercial|cnpj|@exemplo\.test/, 'saída sem segredos nem dados de negócio');
    }
    finally {
        await client.query('DELETE FROM perfil_empresa_concessoes WHERE empresa_id = $1 AND usuario_id = ANY($2::uuid[])', [orfao, [k, i, sus, q]]);
        await client.query('DELETE FROM perfil_empresas WHERE id = ANY($1::uuid[])', [[ids.legado, ids.concEmpresa]]);
    }
});

test('rollback da 063 recusa depois do uso (vínculo suspenso ou registros), sem apagar nada', async () => {
    const dev = (await sessaoDe(ids.dev)).sessao;
    await svc.vinculos.alterarSituacaoVinculo(dev as never, ids.empresa as never, ids.dono as never, 'desativar' as never, { motivo: 'Prova de rollback' } as never, ctx() as never, deps() as never);
    await assert.rejects(client.query(readFileSync('database/rollback/20261004_063_painel_desenvolvedor_down.sql', 'utf8')), /vínculo SUSPENSO|seleção de empresa já utilizada/);
    await client.query('ROLLBACK').catch(() => undefined);
    assert.ok(await contar('SELECT count(*)::int AS n FROM plataforma_interessadas') > 0);
});
