import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Client } from 'pg';
import { conectarDescartavel, encerrarDescartavel } from '../comercial/postgres-descartavel.ts';
import { carregarModulo } from '../acessos/teste-carregador.ts';

/**
 * Cadastro público (E6) no PostgreSQL DESCARTÁVEL: modelo "063" + 067 + 068 + 069 aplicadas aqui. E-mail dublado
 * (nada sai da máquina). Cobre: pedido sem criar conta, conta existente sem enumeração, limites, falha de envio,
 * confirmação de uso único, aceites versionados, empresa idempotente, CNPJ duplicado e concorrente sem revelar dados,
 * mesma pessoa em vários CNPJs, nenhuma autoridade de plataforma, decisão de representação e rollback.
 */
const req = createRequire(import.meta.url);
process.env.ADMIN_AUTH_SECRET = `segredo-sintetico-de-teste-${'x'.repeat(24)}`;
process.env.ADMIN_AUTH_ORIGIN = 'http://localhost:3000';
const ENV_ABERTO = { CADASTRO_PUBLICO_ATIVO: 'true', USUARIOS_CRIACAO_DIRETA: 'desativada', EMAIL_PROVIDER: 'arquivo', EMAIL_ARQUIVO_DIR: 'C:\\nao-usado', NODE_ENV: 'development' };
Object.assign(process.env, ENV_ABERTO);

type Fn = (...args: never[]) => Promise<never>;
type Mod = Record<string, Fn>;
let client: Client;
let client2: Client;
const cache = new Map<string, Record<string, unknown>>();
const carregar = (f: string) => carregarModulo(f, { 'db/postgres': { db: () => client, withTransaction: transacao(() => client) } }, cache) as Mod;
function transacao(c: () => Client) {
    return async <T>(work: (tx: Client) => Promise<T>): Promise<T> => {
        await c().query('BEGIN');
        try {
            const r = await work(c());
            await c().query('COMMIT');
            return r;
        }
        catch (error) {
            await c().query('ROLLBACK');
            throw error;
        }
    };
}
const sufixo = randomBytes(3).toString('hex');
const email = (n: string) => `c069-${n}-${sufixo}@exemplo.test`;
const ctx = (ip = '203.0.113.9') => ({ requestId: randomUUID(), ip, userAgent: 'teste-069' });
let ipSeguinte = 10;
const enviados: Array<{ para: string; assunto: string; texto: string }> = [];
let falharEnvio = false;
let svc: { cadastro: Mod; auth: Mod; docs: { versaoVigente: (d: string) => { versao: string; hash: string } }; tenant: Mod; representacao: Mod };
const deps = (c: () => Client = () => client) => ({
    withTransaction: transacao(c),
    registrarAuditoria: (carregar('lib/clientes/repositories/auditoria.repository.ts') as unknown as { registrarAuditoria: Fn }).registrarAuditoria,
    criarHashSenha: (carregar('lib/autenticacao/senha.ts') as unknown as { criarHashSenha: Fn }).criarHashSenha,
    enviarEmail: async (m: { para: string; assunto: string; texto: string }) => {
        if (falharEnvio) throw new Error('envio falhou');
        enviados.push(m);
        return { provedor: 'arquivo' as const, idExterno: null };
    },
    gerarToken: () => randomBytes(32).toString('base64url'),
});
const tokenPara = (para: string) => {
    const t = [...enviados].reverse().find((m) => m.para === para)?.texto.match(/#t=([A-Za-z0-9_-]{43})/)?.[1];
    assert.ok(t, `link para ${para}`);
    return t!;
};
const contar = async (sql: string, p: unknown[] = []) => (await client.query<{ n: number }>(sql, p)).rows[0].n;
async function erro(p: Promise<unknown>) {
    try { await p; return 'OK'; } catch (e) { return (e as { code?: string }).code ?? (e as Error).message; }
}
const pedido = (n: string, o: Record<string, unknown> = {}) => ({
    nome: `Pessoa ${n}`, email: email(n), senha: `senha-${n}-forte`, confirmacao: `senha-${n}-forte`, aceiteTermos: true, aceitePrivacidade: true,
    termosVersao: svc.docs.versaoVigente('TERMOS_USO').versao, privacidadeVersao: svc.docs.versaoVigente('PRIVACIDADE').versao, ...o,
});
const empresa = (cnpj: string, o: Record<string, unknown> = {}) => ({
    chave: randomUUID(), cnpj, razaoSocial: 'Alegria Festas Ltda', nomeFantasia: 'Buffet Alegria', telefone: '(11) 98888-0069', qualificacao: 'RESPONSAVEL_INDICADO',
    socios: [{ nome: 'Sócia Fundadora', qualificacao: 'SOCIO_ADMINISTRADOR' }], aceiteTermos: true, aceitePrivacidade: true,
    termosVersao: svc.docs.versaoVigente('TERMOS_USO').versao, privacidadeVersao: svc.docs.versaoVigente('PRIVACIDADE').versao, ...o,
});
async function contaConfirmada(n: string, o: Record<string, unknown> = {}) {
    // Cada pessoa sintética vem de um IP próprio: o limite por origem (10/h) é coberto no teste do pedido.
    await svc.cadastro.processarPedidoCadastro(svc.cadastro.validarPedidoCadastro(pedido(n, o) as never) as never, ctx(`198.51.100.${ipSeguinte++}`) as never, deps() as never);
    const r = await svc.cadastro.confirmarCadastro({ token: tokenPara(email(n)) } as never, ctx() as never, deps() as never) as unknown as { usuarioId: string; sessao: { token: string } };
    const sessao = await (svc.auth.consultarSessao as unknown as (t: string) => Promise<Record<string, string>>)(r.sessao.token);
    return { usuarioId: r.usuarioId, sessao };
}
const cadastrar = (sessao: unknown, dados: unknown, c?: () => Client) => svc.cadastro.cadastrarEmpresa(sessao as never, dados as never, ctx() as never, deps(c) as never, ENV_ABERTO as never) as unknown as Promise<{ situacao: string; empresaId?: string; repetido?: boolean; testeFim?: string }>;

test.before(async () => {
    client = await conectarDescartavel();
    client2 = await conectarDescartavel({ travar: false });
    svc = {
        cadastro: carregar('lib/cadastro/publico.ts'), auth: carregar('lib/autenticacao/service.ts'), tenant: carregar('lib/saas/provar-tenant.ts'),
        docs: carregar('lib/cadastro/documentos-legais.ts') as unknown as typeof svc.docs, representacao: carregar('lib/desenvolvedor/representacao.ts'),
    };
});
test.after(async () => {
    if (client2) await encerrarDescartavel(client2, false);
    if (client) await encerrarDescartavel(client);
});

test('069: exige a 068; pre/postcheck; rollback sem dados; reaplicar recusa', async () => {
    await assert.rejects(client.query(readFileSync('database/migrations/20261007_069_cadastro_publico.sql', 'utf8')), /069 exige a 068/);
    await client.query('ROLLBACK').catch(() => undefined);
    for (const f of ['database/migrations/20261006_067_modelo_comercial_empresa.sql', 'database/migrations/20261007_068_cobranca_assinatura.sql', 'database/checks/20261007_069_precheck.sql',
        'database/migrations/20261007_069_cadastro_publico.sql', 'database/checks/20261007_069_postcheck.sql', 'database/rollback/20261007_069_cadastro_publico_down.sql',
        'database/checks/20261007_069_precheck.sql', 'database/migrations/20261007_069_cadastro_publico.sql', 'database/checks/20261007_069_postcheck.sql'])
        await client.query(readFileSync(f, 'utf8'));
    await assert.rejects(client.query(readFileSync('database/migrations/20261007_069_cadastro_publico.sql', 'utf8')), /069 já aplicada/);
    await client.query('ROLLBACK').catch(() => undefined);
});

test('pedido: nenhuma conta nasce antes da confirmação; e-mail com conta recebe aviso sem link; limite por e-mail; falha de envio invalida o pedido', async () => {
    const usuarios = await contar('SELECT count(*)::int AS n FROM usuarios_administrativos');
    await svc.cadastro.processarPedidoCadastro(svc.cadastro.validarPedidoCadastro(pedido('ana') as never) as never, ctx() as never, deps() as never);
    assert.equal(await contar('SELECT count(*)::int AS n FROM usuarios_administrativos'), usuarios, 'sem conta antes da confirmação');
    assert.deepEqual((await client.query("SELECT situacao, senha_hash LIKE 'scrypt$%' AS hash FROM cadastros_publicos WHERE email = $1", [email('ana')])).rows, [{ situacao: 'PENDENTE', hash: true }]);
    tokenPara(email('ana'));
    // Conta existente: aviso para entrar, nenhum link de confirmação, nenhum pedido.
    const existente = (await client.query<{ id: string }>("INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel) VALUES ($1, 'Já Existe', $2, 'ADMINISTRATIVO') RETURNING id",
        [email('existe'), `scrypt$v=1$N=131072$r=8$p=1$${'A'.repeat(22)}==$${'B'.repeat(86)}==`])).rows[0].id;
    assert.ok(existente);
    await svc.cadastro.processarPedidoCadastro(svc.cadastro.validarPedidoCadastro(pedido('existe') as never) as never, ctx() as never, deps() as never);
    const aviso = enviados.at(-1)!;
    assert.deepEqual([aviso.para, /#t=/.test(aviso.texto), /já tem uma conta/.test(aviso.texto)], [email('existe'), false, true]);
    assert.equal(await contar('SELECT count(*)::int AS n FROM cadastros_publicos WHERE email = $1', [email('existe')]), 0);
    // Limite: o 4º pedido do mesmo e-mail na hora não gera e-mail nem pedido novo.
    for (let i = 0; i < 2; i++)
        await svc.cadastro.processarPedidoCadastro(svc.cadastro.validarPedidoCadastro(pedido('ana') as never) as never, ctx() as never, deps() as never);
    const antes = enviados.length;
    const quarto = await svc.cadastro.processarPedidoCadastro(svc.cadastro.validarPedidoCadastro(pedido('ana') as never) as never, ctx() as never, deps() as never) as unknown as { enviado: boolean; motivo: string };
    assert.deepEqual([quarto.enviado, quarto.motivo, enviados.length], [false, 'LIMITE', antes]);
    assert.equal(await contar("SELECT count(*)::int AS n FROM cadastros_publicos WHERE email = $1 AND situacao = 'PENDENTE'", [email('ana')]), 1, 'um pendente por e-mail');
    // Falha de envio: o pedido nasce e é invalidado.
    falharEnvio = true;
    const r = await svc.cadastro.processarPedidoCadastro(svc.cadastro.validarPedidoCadastro(pedido('falha') as never) as never, ctx() as never, deps() as never) as unknown as { enviado: boolean; motivo: string };
    falharEnvio = false;
    assert.deepEqual([r.enviado, r.motivo], [false, 'ENVIO']);
    assert.deepEqual((await client.query('SELECT situacao, senha_hash FROM cadastros_publicos WHERE email = $1', [email('falha')])).rows, [{ situacao: 'SUBSTITUIDO', senha_hash: null }]);
    assert.equal(await contar("SELECT count(*)::int AS n FROM auditoria WHERE acao = 'CADASTRO_ENVIO_FALHOU' AND dados_depois::text LIKE $1", [`%${email('falha')}%`]), 0, 'auditoria sem e-mail');
});

test('confirmação: conta neutra, aceites versionados, senha apagada do pedido, sessão aberta; link de uso único; corrida com conta criada', async () => {
    const token = tokenPara(email('ana'));
    const r = await svc.cadastro.confirmarCadastro({ token } as never, ctx() as never, deps() as never) as unknown as { usuarioId: string; sessao: { token: string } };
    const u = (await client.query('SELECT papel, email FROM usuarios_administrativos WHERE id = $1', [r.usuarioId])).rows[0];
    assert.deepEqual([u.papel, u.email], ['ADMINISTRATIVO', email('ana')]);
    const aceites = (await client.query('SELECT documento, versao, hash_conteudo, origem, empresa_id FROM aceites_documentos_legais WHERE usuario_id = $1 ORDER BY documento', [r.usuarioId])).rows;
    assert.deepEqual(aceites.map((a) => [a.documento, a.versao, a.hash_conteudo, a.origem, a.empresa_id]), [
        ['PRIVACIDADE', svc.docs.versaoVigente('PRIVACIDADE').versao, svc.docs.versaoVigente('PRIVACIDADE').hash, 'CADASTRO', null],
        ['TERMOS_USO', svc.docs.versaoVigente('TERMOS_USO').versao, svc.docs.versaoVigente('TERMOS_USO').hash, 'CADASTRO', null],
    ]);
    assert.deepEqual((await client.query("SELECT situacao, senha_hash FROM cadastros_publicos WHERE usuario_id = $1", [r.usuarioId])).rows, [{ situacao: 'CONFIRMADO', senha_hash: null }]);
    assert.ok((await (svc.auth.consultarSessao as unknown as (t: string) => Promise<{ usuario_id: string }>)(r.sessao.token)).usuario_id === r.usuarioId);
    assert.equal(await erro(svc.cadastro.confirmarCadastro({ token } as never, ctx() as never, deps() as never)), 'LINK_INVALIDO', 'uso único');
    assert.equal(await erro(svc.cadastro.confirmarCadastro({ token: 'x'.repeat(43) } as never, ctx() as never, deps() as never)), 'LINK_INVALIDO');
    // Pedido vencido.
    await svc.cadastro.processarPedidoCadastro(svc.cadastro.validarPedidoCadastro(pedido('vencido') as never) as never, ctx() as never, deps() as never);
    await client.query("UPDATE cadastros_publicos SET expira_em = criado_em + interval '1 second' WHERE email = $1", [email('vencido')]);
    await new Promise((ok) => setTimeout(ok, 1100));
    assert.equal(await erro(svc.cadastro.confirmarCadastro({ token: tokenPara(email('vencido')) } as never, ctx() as never, deps() as never)), 'LINK_INVALIDO');
    // Corrida: alguém criou conta com o e-mail entre o pedido e a confirmação.
    await svc.cadastro.processarPedidoCadastro(svc.cadastro.validarPedidoCadastro(pedido('corrida') as never) as never, ctx() as never, deps() as never);
    await client.query("INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel) VALUES ($1, 'Outra', $2, 'ADMINISTRATIVO')", [email('corrida'), `scrypt$v=1$N=131072$r=8$p=1$${'A'.repeat(22)}==$${'B'.repeat(86)}==`]);
    assert.equal(await erro(svc.cadastro.confirmarCadastro({ token: tokenPara(email('corrida')) } as never, ctx() as never, deps() as never)), 'CONFLITO');
    assert.equal(await contar("SELECT count(*)::int AS n FROM cadastros_publicos WHERE email = $1 AND situacao = 'SUBSTITUIDO'", [email('corrida')]), 1);
});

test('empresa: criação transacional com Gestão só da pessoa, teste do CNPJ, representação declarada, sócios e aceites; idempotente; sem autoridade de plataforma', async () => {
    const { usuarioId, sessao } = await contaConfirmada('bia');
    const dados = empresa('80.123.456/0001-88');
    const r = await cadastrar(sessao, dados);
    assert.equal(r.situacao, 'CRIADA');
    const e = (await client.query(`SELECT e.status, e.nome, c.nome_empresarial, c.documento_fiscal, c.implantacao, c.responsavel_nome, a.situacao AS assinatura, a.documento_teste,
        (a.teste_fim - a.teste_inicio) = interval '15 days' AS quinze FROM empresas e JOIN plataforma_empresas_cadastro c ON c.empresa_id = e.id JOIN empresa_assinaturas a ON a.empresa_id = e.id WHERE e.id = $1`, [r.empresaId])).rows[0];
    assert.deepEqual(e, { status: 'ATIVA', nome: 'Buffet Alegria', nome_empresarial: 'Alegria Festas Ltda', documento_fiscal: '80123456000188', implantacao: 'EM_CONFIGURACAO', responsavel_nome: 'Pessoa bia', assinatura: 'TESTE', documento_teste: '80123456000188', quinze: true });
    assert.deepEqual((await client.query('SELECT usuario_id::text, papel, status FROM memberships WHERE empresa_id = $1', [r.empresaId])).rows, [{ usuario_id: usuarioId, papel: 'REPRESENTANTE_AUTORIZADO', status: 'ATIVA' }]);
    assert.deepEqual((await client.query('SELECT qualificacao, situacao FROM empresa_representacoes WHERE empresa_id = $1', [r.empresaId])).rows, [{ qualificacao: 'RESPONSAVEL_INDICADO', situacao: 'DECLARADA' }]);
    assert.deepEqual((await client.query('SELECT nome, qualificacao FROM empresa_socios WHERE empresa_id = $1', [r.empresaId])).rows, [{ nome: 'Sócia Fundadora', qualificacao: 'SOCIO_ADMINISTRADOR' }]);
    assert.equal(await contar("SELECT count(*)::int AS n FROM aceites_documentos_legais WHERE empresa_id = $1 AND origem = 'NOVA_EMPRESA'", [r.empresaId]), 2);
    assert.equal((await client.query('SELECT papel FROM usuarios_administrativos WHERE id = $1', [usuarioId])).rows[0].papel, 'ADMINISTRATIVO', 'papel global continua neutro');
    assert.equal(await contar('SELECT count(*)::int AS n FROM plataforma_desenvolvedores WHERE usuario_id = $1', [usuarioId]), 0);
    // Mesma chave (clique duplo ou conexão caída): mesma empresa, nada duplicado.
    const de_novo = await cadastrar(sessao, dados);
    assert.deepEqual([de_novo.situacao, de_novo.empresaId, de_novo.repetido], ['CRIADA', r.empresaId, true]);
    assert.equal(await contar('SELECT count(*)::int AS n FROM empresas WHERE id IN (SELECT empresa_id FROM cadastros_empresas WHERE usuario_id = $1)', [usuarioId]), 1);
    // Resposta perdida e página recarregada (chave nova, mesmo CNPJ, mesma pessoa com Gestão ativa): retoma a mesma
    // empresa em vez de tratar a própria empresa como "CNPJ já cadastrado" e abrir pedido de acesso para ela mesma.
    const recarregada = await cadastrar(sessao, empresa('80123456000188'));
    assert.deepEqual([recarregada.situacao, recarregada.empresaId, recarregada.repetido], ['CRIADA', r.empresaId, true]);
    assert.equal(await contar('SELECT count(*)::int AS n FROM solicitacoes_acesso_empresa WHERE usuario_id = $1', [usuarioId]), 0, 'sem pedido de acesso à própria empresa');
    assert.equal(await contar('SELECT count(*)::int AS n FROM cadastros_empresas WHERE usuario_id = $1', [usuarioId]), 1);
    // A Gestão acessa a empresa nova pela prova de tenant (só ela).
    const prova = await (svc.tenant.provarTenant as unknown as (tx: Client, s: unknown, e: string) => Promise<{ empresaComprovada: string; papelAtual: string }>)(client, { usuario_id: usuarioId, papel: 'ADMINISTRATIVO' }, r.empresaId!);
    assert.deepEqual([prova.empresaComprovada, prova.papelAtual], [r.empresaId, 'REPRESENTANTE_AUTORIZADO']);
});

test('CNPJ já cadastrado (outra chave, outra pessoa ou perfil legado): resposta neutra, pedido de acesso registrado, nenhum dado nem vínculo', async () => {
    const { usuarioId, sessao } = await contaConfirmada('caio');
    const vinculos = await contar('SELECT count(*)::int AS n FROM memberships');
    const r = await cadastrar(sessao, empresa('80123456000188'));
    assert.deepEqual(r, { situacao: 'CNPJ_EXISTENTE' }, 'nada da empresa existente volta');
    assert.equal(await contar('SELECT count(*)::int AS n FROM memberships'), vinculos);
    assert.equal(await contar("SELECT count(*)::int AS n FROM solicitacoes_acesso_empresa WHERE usuario_id = $1 AND situacao = 'PENDENTE' AND empresa_id IS NOT NULL", [usuarioId]), 1);
    await cadastrar(sessao, empresa('80123456000188'));
    assert.equal(await contar('SELECT count(*)::int AS n FROM solicitacoes_acesso_empresa WHERE usuario_id = $1', [usuarioId]), 1, 'pedido pendente não duplica');
    // Perfil legado (ex.: a Kidmais, sem cadastro administrativo) também conta como já cadastrado.
    await client.query("INSERT INTO perfil_empresas (codigo, cnpj) VALUES ($1, '80234567000161')", [`LEG-${sufixo}`]);
    assert.deepEqual(await cadastrar(sessao, empresa('80234567000161')), { situacao: 'CNPJ_EXISTENTE' });
    assert.equal(await erro(cadastrar(sessao, empresa('11.111.111/1111-11'))), 'DADOS_INVALIDOS', 'raiz repetida recusada');
    assert.equal(await erro(cadastrar(sessao, empresa('80123456000189'))), 'DADOS_INVALIDOS', 'dígito errado');
});

test('retomada só para quem criou e mantém a Gestão: vínculo encerrado → resposta neutra e pedido de acesso', async () => {
    const { usuarioId, sessao } = await contaConfirmada('hana');
    const r = await cadastrar(sessao, empresa('81234567000124'));
    assert.equal(r.situacao, 'CRIADA');
    await client.query("UPDATE memberships SET status = 'REVOGADA' WHERE usuario_id = $1 AND empresa_id = $2", [usuarioId, r.empresaId]);
    assert.deepEqual(await cadastrar(sessao, empresa('81234567000124')), { situacao: 'CNPJ_EXISTENTE' });
    assert.equal(await contar("SELECT count(*)::int AS n FROM solicitacoes_acesso_empresa WHERE usuario_id = $1 AND situacao = 'PENDENTE'", [usuarioId]), 1);
});

test('mesma pessoa, mesmo CNPJ, duas abas ao mesmo tempo (chaves diferentes): a trava da conta serializa → uma empresa, as duas respostas a retomam, nenhum pedido de acesso', async () => {
    const { usuarioId, sessao } = await contaConfirmada('kai');
    const [ra, rb] = await Promise.all([cadastrar(sessao, empresa('81678912000119')), cadastrar(sessao, empresa('81678912000119'), () => client2)]);
    assert.deepEqual([ra.situacao, rb.situacao], ['CRIADA', 'CRIADA']);
    assert.equal(ra.empresaId, rb.empresaId);
    assert.deepEqual([ra.repetido, rb.repetido].sort(), [false, true]);
    assert.equal(await contar("SELECT count(*)::int AS n FROM plataforma_empresas_cadastro WHERE documento_fiscal = '81678912000119'"), 1);
    assert.equal(await contar('SELECT count(*)::int AS n FROM solicitacoes_acesso_empresa WHERE usuario_id = $1', [usuarioId]), 0);
});

test('nome da pessoa não é único: duas contas com o mesmo nome cadastram empresas diferentes', async () => {
    const a = await contaConfirmada('ivo', { nome: 'Maria Silva' });
    const b = await contaConfirmada('jon', { nome: 'Maria Silva' });
    const [ra, rb] = [await cadastrar(a.sessao, empresa('81345678000108')), await cadastrar(b.sessao, empresa('81456789000191'))];
    assert.deepEqual([ra.situacao, rb.situacao], ['CRIADA', 'CRIADA']);
    assert.deepEqual((await client.query('SELECT DISTINCT responsavel_nome FROM plataforma_empresas_cadastro WHERE empresa_id = ANY($1::uuid[])', [[ra.empresaId, rb.empresaId]])).rows, [{ responsavel_nome: 'Maria Silva' }]);
});

test('concorrência: duas pessoas cadastram o mesmo CNPJ ao mesmo tempo → uma empresa, o outro recebe a resposta neutra', async () => {
    const a = await contaConfirmada('dani');
    const b = await contaConfirmada('edu');
    const [ra, rb] = await Promise.all([cadastrar(a.sessao, empresa('80345678000145')), cadastrar(b.sessao, empresa('80345678000145'), () => client2)]);
    assert.deepEqual([ra.situacao, rb.situacao].sort(), ['CNPJ_EXISTENTE', 'CRIADA']);
    assert.equal(await contar("SELECT count(*)::int AS n FROM plataforma_empresas_cadastro WHERE documento_fiscal = '80345678000145'"), 1);
});

test('mesma pessoa em vários CNPJs: um teste e uma Gestão por empresa; papel e situação por empresa', async () => {
    const { usuarioId, sessao } = await contaConfirmada('fabi');
    const r1 = await cadastrar(sessao, empresa('80456789000129', { nomeFantasia: 'Buffet Um' }));
    const r2 = await cadastrar(sessao, empresa('80567891000100', { nomeFantasia: 'Buffet Dois', qualificacao: 'SOCIO_ADMINISTRADOR', socios: [] }));
    assert.deepEqual([r1.situacao, r2.situacao], ['CRIADA', 'CRIADA']);
    assert.equal(await contar("SELECT count(*)::int AS n FROM memberships WHERE usuario_id = $1 AND status = 'ATIVA' AND papel = 'REPRESENTANTE_AUTORIZADO'", [usuarioId]), 2);
    assert.equal(await contar('SELECT count(*)::int AS n FROM empresa_assinaturas WHERE empresa_id = ANY($1::uuid[])', [[r1.empresaId, r2.empresaId]]), 2);
    // Equipe convidada em uma não ganha nada na outra (isolamento por empresa).
    await client.query("UPDATE memberships SET papel = 'ADMINISTRATIVO' WHERE usuario_id = $1 AND empresa_id = $2", [usuarioId, r2.empresaId]);
    const papeis = (await client.query('SELECT empresa_id::text, papel FROM memberships WHERE usuario_id = $1 ORDER BY papel', [usuarioId])).rows;
    assert.deepEqual(papeis.map((p) => p.papel), ['ADMINISTRATIVO', 'REPRESENTANTE_AUTORIZADO']);
});

test('salvaguardas: sessão antiga pede reautenticação; cadastro fechado recusa; limite diário por pessoa', async () => {
    const { usuarioId, sessao } = await contaConfirmada('gil');
    const velha = { ...sessao, autenticado_em: new Date(Date.parse(String(sessao.consultado_em)) - 10 * 60_000).toISOString() };
    assert.equal(await erro(cadastrar(velha, empresa('80678912000156'))), 'REAUTENTICACAO');
    assert.equal(await erro(svc.cadastro.cadastrarEmpresa(sessao as never, empresa('80678912000156') as never, ctx() as never, deps() as never, { ...ENV_ABERTO, CADASTRO_PUBLICO_ATIVO: 'false' } as never)), 'CADASTRO_INDISPONIVEL');
    for (const cnpj of ['80678912000156', '80789123000192', '80891234000105', '80912345000150', '81023456000179'])
        assert.notEqual((await cadastrar(sessao, empresa(cnpj))).situacao, undefined);
    assert.equal(await erro(cadastrar(sessao, empresa('81134567000152'))), 'LIMITE_TENTATIVAS');
    assert.ok(usuarioId);
});

test('representação: o desenvolvedor aprova ou recusa com motivo e auditoria; transição inválida recusada; acesso não muda', async () => {
    const { usuarioId, sessao } = await contaConfirmada('hel');
    const r = await cadastrar(sessao, empresa('81245678000136'));
    const repr = (await client.query('SELECT id FROM empresa_representacoes WHERE empresa_id = $1', [r.empresaId])).rows[0].id as string;
    const dev = (await client.query<{ id: string }>("INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel) VALUES ($1, 'Dev 069', $2, 'ADMINISTRATIVO') RETURNING id", [email('dev'), `scrypt$v=1$N=131072$r=8$p=1$${'A'.repeat(22)}==$${'B'.repeat(86)}==`])).rows[0].id;
    await (req('../../scripts/admin-provision.cjs') as { alterarDesenvolvedor: (c: Client, i: Record<string, string>) => Promise<unknown> }).alterarDesenvolvedor(client, { operacao: 'conceder', email: email('dev'), operador: 'Teste 069', motivo: 'Desenvolvedor sintético' });
    await client.query("UPDATE usuarios_administrativos SET senha_alterada_em = clock_timestamp() - interval '1 hour' WHERE id = $1", [dev]);
    const nova = await transacao(() => client)((tx) => (svc.auth.criarSessaoAdministrativa as unknown as (tx: Client, u: string, ip: null, ua: null) => Promise<{ token: string }>)(tx, dev, null, null));
    const sDev = await (svc.auth.consultarSessao as unknown as (t: string) => Promise<unknown>)(nova.token);
    const painelDeps = { withTransaction: transacao(() => client), registrarAuditoria: deps().registrarAuditoria };
    const decidir = (d: unknown) => svc.representacao.decidirRepresentacaoOuPedido(sDev as never, r.empresaId as never, d as never, ctx() as never, painelDeps as never);
    assert.equal(await erro(svc.representacao.decidirRepresentacaoOuPedido(sessao as never, r.empresaId as never, { alvo: 'representacao', id: repr, decisao: 'APROVADA', motivo: 'Sem concessão' } as never, ctx() as never, painelDeps as never)), 'NAO_ENCONTRADO');
    assert.equal(await erro(decidir({ alvo: 'representacao', id: repr, decisao: 'REVOGADA', motivo: 'Ainda declarada' })), 'CONFLITO');
    await decidir({ alvo: 'representacao', id: repr, decisao: 'APROVADA', motivo: 'Contrato social conferido', evidencia: 'Contrato social apresentado por e-mail' });
    assert.deepEqual((await client.query('SELECT situacao, motivo_decisao, decidido_por::text FROM empresa_representacoes WHERE id = $1', [repr])).rows[0], { situacao: 'APROVADA', motivo_decisao: 'Contrato social conferido', decidido_por: dev });
    assert.equal(await contar("SELECT count(*)::int AS n FROM auditoria WHERE acao = 'REPRESENTACAO_APROVADA' AND entidade_id = $1", [r.empresaId]), 1);
    assert.equal(await contar("SELECT count(*)::int AS n FROM memberships WHERE empresa_id = $1 AND status = 'ATIVA'", [r.empresaId]), 1, 'aprovação não concede acesso');
    // Ficha do desenvolvedor: a origem do cadastro é o cadastro público (não "cadastro direto").
    const empresasPainel = carregar('lib/desenvolvedor/empresas.ts') as unknown as { obterEmpresa: (s: unknown, id: string, d: unknown) => Promise<{ empresa: { cadastro: { origem: string } } }> };
    assert.equal((await empresasPainel.obterEmpresa(sDev, r.empresaId!, painelDeps)).empresa.cadastro.origem, 'CADASTRO_PUBLICO');
    assert.ok(usuarioId);
});

test('rollback da 069 recusa com dados de cadastro, sem apagar nada', async () => {
    await assert.rejects(client.query(readFileSync('database/rollback/20261007_069_cadastro_publico_down.sql', 'utf8')), /rollback recusado/);
    await client.query('ROLLBACK').catch(() => undefined);
    assert.ok(await contar('SELECT count(*)::int AS n FROM cadastros_publicos') > 0);
});
