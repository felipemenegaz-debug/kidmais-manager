import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Client } from 'pg';
import { conectarDescartavel, encerrarDescartavel } from '../comercial/postgres-descartavel.ts';
import { carregarModulo } from '../acessos/teste-carregador.ts';
import { iniciarTeste } from './servico.ts';
import { iniciarAssinatura, type DepsCobranca } from './cobranca.ts';

/**
 * 091 — CPF do contratante (buffet pessoa física) no PostgreSQL DESCARTÁVEL, modelo 089. A suíte aplica a 091 (e a 090
 * para o Fundador). E-mail e provedor FALSOS; documentos SINTÉTICOS com DV calculado:
 *   1. sem a 091: CPF recusado (CPF_INDISPONIVEL) no teste e no cadastro, nada gravado; cadastro PJ antigo (`cnpj`) segue;
 *   2. 091: precheck/postcheck, preservação dos documentos, reaplicação recusada, rollback vazio e reaplicação;
 *   3. cadastro público PF (CPF + nome civil, TITULAR_PF, sem sócios), idempotente, auditoria mascarada; chave desligada recusa;
 *      combinações inválidas recusadas no servidor;
 *   4. duplicidade: mesmo CPF por outra pessoa (pedido de acesso neutro), corrida real de duas pessoas e trava do painel;
 *   5. banco: DV no INSERT, documento do teste imutável (CPF → CNPJ recusado), CHECK de formato;
 *   6. Fundador com CPF na janela e checkout: cliente do provedor com nome civil + CPF (PJ: razão social + CNPJ);
 *      documento do cadastro diferente do teste (CPF ↔ CNPJ ou CPF A → B) e CPF sem nome civil não criam cliente;
 *   7. rollback recusado depois de existir CPF;
 *   8. Perfil PF; 9. continuidade assistida (D5): CPF → CNPJ, pendência do provedor, guardas do registro.
 */
const ler = (f: string) => readFileSync(f, 'utf8');
const SQL = {
    pre: ler('database/checks/20261022_091_precheck.sql'), up: ler('database/migrations/20261022_091_documento_fiscal_contratante.sql'),
    post: ler('database/checks/20261022_091_postcheck.sql'), down: ler('database/rollback/20261022_091_documento_fiscal_contratante_down.sql'),
    up090: ler('database/migrations/20261022_090_campanha_fundador.sql'),
};
const opt = () => process.env.KIDMAIS_POSTGRES_DESCARTAVEL === 'kidmais_pacotes_v1_descartavel';
process.env.ADMIN_AUTH_SECRET = `segredo-sintetico-de-teste-${'x'.repeat(24)}`;
process.env.ADMIN_AUTH_ORIGIN = 'http://localhost:3000';
const ENV_ABERTO = { CADASTRO_PUBLICO_ATIVO: 'true', USUARIOS_CRIACAO_DIRETA: 'desativada', EMAIL_PROVIDER: 'arquivo', EMAIL_ARQUIVO_DIR: 'C:\\nao-usado', NODE_ENV: 'development' };
const ENV_CPF = { ...ENV_ABERTO, ASSINATURA_CPF_ATIVO: 'true' };
Object.assign(process.env, ENV_ABERTO);

/** CPF/CNPJ sintéticos com DV oficial. */
function cpf(n: number) {
    const b = String(100000000 + n).slice(-9);
    const dv = (s: string, p: number) => { let t = 0; for (let i = 0; i < s.length; i++) t += Number(s[i]) * (p - i); const r = (t * 10) % 11; return r === 10 ? 0 : r; };
    const d1 = dv(b, 10); return b + d1 + dv(b + d1, 11);
}
function cnpj(n: number) {
    const base = `8${String(n).padStart(7, '0')}0001`;
    const dv = (b: string) => { let s = 0, p = 2; for (let i = b.length - 1; i >= 0; i--) { s += (b.charCodeAt(i) - 48) * p; p = p === 9 ? 2 : p + 1; } const r = s % 11; return r <= 1 ? 0 : 11 - r; };
    const d1 = dv(base); return base + d1 + dv(base + d1);
}

type Fn = (...args: never[]) => Promise<never>;
type Mod = Record<string, Fn>;
let client: Client;
let client2: Client;
const cache = new Map<string, Record<string, unknown>>();
function transacao(c: () => Client) {
    return async <T>(work: (tx: Client) => Promise<T>): Promise<T> => {
        await c().query('BEGIN');
        try { const r = await work(c()); await c().query('COMMIT'); return r; }
        catch (error) { await c().query('ROLLBACK'); throw error; }
    };
}
const carregar = (f: string) => carregarModulo(f, { 'db/postgres': { db: () => client, withTransaction: transacao(() => client) } }, cache) as Mod;
const sufixo = randomBytes(3).toString('hex');
const email = (n: string) => `d091-${n}-${sufixo}@exemplo.test`;
const ctx = (ip = '203.0.113.91') => ({ requestId: randomUUID(), ip, userAgent: 'teste-091' });
let ip = 10;
const enviados: Array<{ para: string; texto: string }> = [];
let svc: { cadastro: Mod; auth: Mod; docs: { versaoVigente: (d: string) => { versao: string } } };
const deps = (c: () => Client = () => client) => ({
    withTransaction: transacao(c),
    registrarAuditoria: (carregar('lib/clientes/repositories/auditoria.repository.ts') as unknown as { registrarAuditoria: Fn }).registrarAuditoria,
    criarHashSenha: (carregar('lib/autenticacao/senha.ts') as unknown as { criarHashSenha: Fn }).criarHashSenha,
    enviarEmail: async (m: { para: string; texto: string }) => { enviados.push(m); return { provedor: 'arquivo' as const, idExterno: null }; },
    gerarToken: () => randomBytes(32).toString('base64url'),
});
async function erro(p: Promise<unknown>) { try { await p; return 'OK'; } catch (e) { return (e as { code?: string }).code ?? (e as Error).message; } }
const contar = async (sql: string, p: unknown[] = []) => (await client.query<{ n: number }>(sql, p)).rows[0].n;
async function conta(n: string) {
    const versoes = { termosVersao: svc.docs.versaoVigente('TERMOS_USO').versao, privacidadeVersao: svc.docs.versaoVigente('PRIVACIDADE').versao };
    await svc.cadastro.processarPedidoCadastro(svc.cadastro.validarPedidoCadastro({ nome: `Pessoa ${n}`, email: email(n), senha: `senha-${n}-forte`, confirmacao: `senha-${n}-forte`,
        aceiteTermos: true, aceitePrivacidade: true, ...versoes } as never) as never, ctx(`198.51.100.${ip++}`) as never, deps() as never);
    const token = [...enviados].reverse().find((m) => m.para === email(n))!.texto.match(/#t=([A-Za-z0-9_-]{43})/)![1];
    const r = await svc.cadastro.confirmarCadastro({ token } as never, ctx() as never, deps() as never) as unknown as { usuarioId: string; sessao: { token: string } };
    return { usuarioId: r.usuarioId, sessao: await (svc.auth.consultarSessao as unknown as (t: string) => Promise<Record<string, string>>)(r.sessao.token) };
}
const aceites = () => ({ aceiteTermos: true, aceitePrivacidade: true, termosVersao: svc.docs.versaoVigente('TERMOS_USO').versao, privacidadeVersao: svc.docs.versaoVigente('PRIVACIDADE').versao });
const pf = (doc: string, o: Record<string, unknown> = {}) => ({ chave: randomUUID(), tipoPessoa: 'PF', documento: doc, nomeCivil: 'Maria Sintética da Silva', nomeFantasia: 'Buffet da Maria', ...aceites(), ...o });
const pjAntigo = (doc: string) => ({ chave: randomUUID(), cnpj: doc, razaoSocial: 'Festas Sintéticas Ltda', nomeFantasia: 'Buffet Festas', qualificacao: 'SOCIO_ADMINISTRADOR', socios: [], ...aceites() });
const cadastrar = (sessao: unknown, dados: unknown, env: Record<string, string> = ENV_CPF, c?: () => Client) =>
    svc.cadastro.cadastrarEmpresa(sessao as never, dados as never, ctx() as never, deps(c) as never, env as never) as unknown as Promise<{ situacao: string; empresaId?: string; repetido?: boolean }>;
const SNAP = `SELECT (SELECT json_agg(json_build_array(empresa_id, documento_teste, situacao, versao) ORDER BY empresa_id) FROM empresa_assinaturas) AS a,
    (SELECT json_agg(json_build_array(usuario_id, chave, documento) ORDER BY usuario_id, chave) FROM cadastros_empresas) AS c,
    (SELECT json_agg(json_build_array(id, qualificacao, situacao) ORDER BY id) FROM empresa_representacoes) AS r`;

test.before(async () => {
    if (!opt()) return;
    client = await conectarDescartavel();
    client2 = await conectarDescartavel({ travar: false });
    svc = { cadastro: carregar('lib/cadastro/publico.ts'), auth: carregar('lib/autenticacao/service.ts'), docs: carregar('lib/cadastro/documentos-legais.ts') as unknown as typeof svc.docs };
});
test.after(async () => {
    if (client2) await encerrarDescartavel(client2, false);
    if (client) await encerrarDescartavel(client);
});

const ids: Record<string, string> = {};
test('1. sem a 091: CPF recusado no teste e no cadastro (nada gravado); PJ pelo campo antigo segue', { skip: !opt() }, async () => {
    assert.equal((await client.query("SELECT to_regprocedure('public.kidmais_091_documento_valido(text)') IS NULL AS ok")).rows[0].ok, true);
    const ana = await conta('ana');
    const antes = await contar('SELECT count(*)::int AS n FROM empresas');
    assert.equal(await erro(cadastrar(ana.sessao, pf(cpf(1)))), 'CPF_INDISPONIVEL');
    assert.equal(await contar('SELECT count(*)::int AS n FROM empresas'), antes, 'nada gravado');
    const e = (await client.query("INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Teste CPF', 'PROVISIONAMENTO') RETURNING id", [`d091-${sufixo}`])).rows[0].id;
    await client.query("UPDATE empresas SET status = 'ATIVA' WHERE id = $1", [e]);
    await client.query('BEGIN');
    assert.equal(await erro(iniciarTeste(client as never, { empresaId: e, documento: cpf(2), env: ENV_CPF })), 'CPF_INDISPONIVEL');
    await client.query('ROLLBACK');
    const r = await cadastrar(ana.sessao, pjAntigo(cnpj(1)));
    assert.equal(r.situacao, 'CRIADA'); ids.pj = r.empresaId!;
    assert.equal((await client.query('SELECT documento_teste FROM empresa_assinaturas WHERE empresa_id = $1', [ids.pj])).rows[0].documento_teste, cnpj(1));
    await assert.rejects(client.query("INSERT INTO empresa_assinaturas (empresa_id, situacao, teste_inicio, teste_fim, documento_teste) VALUES ($1, 'TESTE', now(), now() + interval '1 day', $2)", [e, cpf(3)]),
        /empresa_assinaturas_documento_teste_check/);
    // Linha LEGADA com DV de CNPJ inválido (antes da 091 só havia CHECK de formato): a 091 não pode travá-la.
    const legado = cnpj(9).slice(0, 13) + ((Number(cnpj(9)[13]) + 1) % 10);
    ids.legadoDv = (await client.query("INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Legado DV', 'PROVISIONAMENTO') RETURNING id", [`d091l-${sufixo}`])).rows[0].id;
    await client.query("UPDATE empresas SET status = 'ATIVA' WHERE id = $1", [ids.legadoDv]);
    await client.query("INSERT INTO empresa_assinaturas (empresa_id, situacao, teste_inicio, teste_fim, documento_teste) VALUES ($1, 'TESTE', clock_timestamp(), clock_timestamp() + interval '15 days', $2)", [ids.legadoDv, legado]);
});

test('2. 091: precheck, aplicação, postcheck, preservação, reaplicação recusada, rollback vazio e reaplicação', { skip: !opt() }, async () => {
    const antes = (await client.query(SNAP)).rows[0];
    // O precheck só INFORMA linhas antigas com DV inválido (não recusa nem altera).
    const resultados = await client.query(SQL.pre) as unknown as { rows: { tabela?: string; cnpj_dv_invalido?: string }[] }[];
    const dv = resultados.at(-1)!.rows.find((r) => r.tabela === 'empresa_assinaturas');
    assert.ok(Number(dv?.cnpj_dv_invalido) >= 1, 'precheck conta o legado com DV inválido');
    await client.query(SQL.up); await client.query(SQL.post);
    assert.deepEqual((await client.query(SNAP)).rows[0], antes, 'nenhum documento, estado ou qualificação muda');
    await assert.rejects(client.query(SQL.up), /091 já aplicada/); await client.query('ROLLBACK').catch(() => undefined);
    await assert.rejects(client.query(SQL.pre), /aplicação anterior ou parcial/);
    await client.query(SQL.down);
    assert.deepEqual((await client.query(SNAP)).rows[0], antes);
    await client.query(SQL.pre); await client.query(SQL.up); await client.query(SQL.post);
    // Bloqueante da revisão: a linha legada com DV inválido continua atualizável (nada de CHECK em todo UPDATE).
    await client.query("UPDATE empresa_assinaturas SET teste_fim = teste_fim + interval '1 day' WHERE empresa_id = $1", [ids.legadoDv]);
    assert.equal((await client.query('SELECT versao FROM empresa_assinaturas WHERE empresa_id = $1', [ids.legadoDv])).rows[0].versao, 2);
});

test('3. cadastro público PF: CPF + nome civil, TITULAR_PF, sem sócios, idempotente, auditoria mascarada; chave desligada e combinações inválidas recusadas', { skip: !opt() }, async () => {
    const bia = await conta('bia');
    assert.equal(await erro(cadastrar(bia.sessao, pf(cpf(10)), ENV_ABERTO)), 'CPF_INDISPONIVEL', 'sem a chave operacional');
    for (const dados of [pf(cpf(10), { socios: [{ nome: 'Sócio', qualificacao: 'SOCIO' }] }), pf(cpf(10), { razaoSocial: 'X Ltda' }), pf(cpf(10), { qualificacao: 'PROCURADOR' }),
        pf(cnpj(10)), pf('11111111111'), pf(cpf(10).slice(0, 10) + ((Number(cpf(10)[10]) + 1) % 10)), pf(cpf(10), { nomeCivil: undefined }),
        { ...pjAntigo(cpf(10)) }, { ...pjAntigo(cnpj(11)), documento: cnpj(11) }])
        assert.equal(await erro(cadastrar(bia.sessao, dados)), 'DADOS_INVALIDOS', JSON.stringify(dados).slice(0, 80));
    const dados = pf('000.000.' + cpf(10).slice(6, 9) + '-' + cpf(10).slice(9));
    const r = await cadastrar(bia.sessao, { ...dados, documento: `${cpf(10).slice(0, 3)}.${cpf(10).slice(3, 6)}.${cpf(10).slice(6, 9)}-${cpf(10).slice(9)}` });
    assert.equal(r.situacao, 'CRIADA'); ids.pf = r.empresaId!;
    const linha = (await client.query(`SELECT c.documento_fiscal, c.nome_empresarial, e.nome, a.documento_teste, r.qualificacao,
        (SELECT count(*)::int FROM empresa_socios s WHERE s.empresa_id = e.id) AS socios
        FROM empresas e JOIN plataforma_empresas_cadastro c ON c.empresa_id = e.id JOIN empresa_assinaturas a ON a.empresa_id = e.id
        JOIN empresa_representacoes r ON r.empresa_id = e.id WHERE e.id = $1`, [ids.pf])).rows[0];
    assert.deepEqual(linha, { documento_fiscal: cpf(10), nome_empresarial: 'Maria Sintética da Silva', nome: 'Buffet da Maria', documento_teste: cpf(10), qualificacao: 'TITULAR_PF', socios: 0 });
    const aud = (await client.query("SELECT dados_depois FROM auditoria WHERE acao = 'EMPRESA_CADASTRADA_PUBLICO' AND entidade_id = $1", [ids.pf])).rows[0].dados_depois;
    assert.equal(aud.documento, `*******${cpf(10).slice(-4)}`); assert.equal(aud.tipoPessoa, 'PF');
    assert.ok(!JSON.stringify(aud).includes(cpf(10)), 'CPF completo não vai para a auditoria');
    // Mesma chave: mesma empresa, sem segundo teste.
    const de_novo = await cadastrar(bia.sessao, { ...dados, chave: (await client.query('SELECT chave FROM cadastros_empresas WHERE empresa_id = $1', [ids.pf])).rows[0].chave, documento: cpf(10) });
    assert.deepEqual([de_novo.situacao, de_novo.empresaId, de_novo.repetido], ['CRIADA', ids.pf, true]);
    ids.biaUsuario = bia.usuarioId;
});

test('4. duplicidade de CPF: outra pessoa vira pedido neutro; corrida real; trava compartilhada com o painel', { skip: !opt() }, async () => {
    const caio = await conta('caio');
    assert.equal((await cadastrar(caio.sessao, pf(cpf(10)))).situacao, 'CNPJ_EXISTENTE');
    assert.equal(await contar('SELECT count(*)::int AS n FROM solicitacoes_acesso_empresa WHERE usuario_id = $1 AND documento = $2', [caio.usuarioId, cpf(10)]), 1);
    // Duas pessoas, mesmo CPF novo, ao mesmo tempo em duas conexões: um tenant só.
    const davi = await conta('davi'), eva = await conta('eva');
    const [a, b] = await Promise.all([cadastrar(davi.sessao, pf(cpf(20))), cadastrar(eva.sessao, pf(cpf(20)), ENV_CPF, () => client2)]);
    assert.deepEqual([a.situacao, b.situacao].sort(), ['CNPJ_EXISTENTE', 'CRIADA']);
    assert.equal(await contar('SELECT count(*)::int AS n FROM plataforma_empresas_cadastro WHERE documento_fiscal = $1', [cpf(20)]), 1);
    // Painel (outra conexão) com a mesma trava de documento: o cadastro público espera e encontra a contratante do painel.
    await client2.query('BEGIN');
    await client2.query("SELECT pg_advisory_xact_lock(hashtext('kidmais:cnpj:' || $1))", [cpf(30)]);
    const emp = (await client2.query("INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Painel', 'PROVISIONAMENTO') RETURNING id", [`d091p-${sufixo}`])).rows[0].id;
    await client2.query("UPDATE empresas SET status = 'ATIVA' WHERE id = $1", [emp]);
    const dev = (await client2.query("INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Dev', $2, 'ADMINISTRATIVO', true) RETURNING id",
        [email('dev'), `scrypt$v=1$N=131072$r=8$p=1$${'A'.repeat(22)}==$${'B'.repeat(86)}==`])).rows[0].id;
    await client2.query(`INSERT INTO plataforma_empresas_cadastro (empresa_id, nome_empresarial, documento_fiscal, responsavel_nome, email, criado_por, atualizado_por)
        VALUES ($1, 'Titular Painel', $2, 'Resp', $3, $4, $4)`, [emp, cpf(30), email('painel'), dev]);
    const fabi = await conta('fabi');
    const pid = (await client.query('SELECT pg_backend_pid() AS p')).rows[0].p;
    const publico = cadastrar(fabi.sessao, pf(cpf(30)));
    let naTrava = false;
    for (let i = 0; i < 150 && !naTrava; i++) {
        naTrava = (await client2.query("SELECT wait_event_type = 'Lock' AND wait_event = 'advisory' AS w FROM pg_stat_activity WHERE pid = $1", [pid])).rows[0]?.w === true;
        if (!naTrava) await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(naTrava, 'o cadastro público espera a trava de documento do painel (não só o índice único)');
    await client2.query('COMMIT');
    assert.equal((await publico).situacao, 'CNPJ_EXISTENTE');
    assert.equal(await contar('SELECT count(*)::int AS n FROM plataforma_empresas_cadastro WHERE documento_fiscal = $1', [cpf(30)]), 1);
});

test('5. banco: DV no INSERT, documento do teste imutável, formato', { skip: !opt() }, async () => {
    const e = (await client.query("INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Banco', 'PROVISIONAMENTO') RETURNING id", [`d091b-${sufixo}`])).rows[0].id;
    await client.query("UPDATE empresas SET status = 'ATIVA' WHERE id = $1", [e]);
    const ruim = cpf(40).slice(0, 10) + ((Number(cpf(40)[10]) + 1) % 10);
    await assert.rejects(client.query("INSERT INTO empresa_assinaturas (empresa_id, situacao, teste_inicio, teste_fim, documento_teste) VALUES ($1, 'TESTE', now(), now() + interval '1 day', $2)", [e, ruim]),
        /dígito verificador inválido/);
    await assert.rejects(client.query("INSERT INTO empresa_assinaturas (empresa_id, situacao, teste_inicio, teste_fim, documento_teste) VALUES ($1, 'TESTE', now(), now() + interval '1 day', '529.982.247-25')", [e]),
        /documento_teste_check|dígito verificador inválido/); // gatilho de DV (BEFORE) ou CHECK de formato: recusa nos dois casos
    await assert.rejects(client.query('UPDATE empresa_assinaturas SET documento_teste = $2 WHERE empresa_id = $1', [ids.pf, cnpj(50)]), /Identidade da assinatura é imutável/);
    // O teste do piloto/painel aceita CPF com a 091 e a chave (mesmo iniciarTeste).
    await client.query('BEGIN');
    const t = await iniciarTeste(client as never, { empresaId: e, documento: cpf(40), dias: 30, env: ENV_CPF });
    await client.query('COMMIT');
    assert.equal(t.dias, 30);
});

test('6. Fundador com CPF na janela; checkout cria o cliente do provedor com nome civil + CPF (PJ: razão social + CNPJ); divergência bloqueia', { skip: !opt() }, async () => {
    await client.query(SQL.up090);
    const usuario = ids.biaUsuario;
    await client.query("INSERT INTO assinatura_campanhas (codigo, versao_regra) VALUES ('fundador-091', 'fundador-sintetica-091')");
    await client.query(`UPDATE assinatura_campanhas SET estado = 'ATIVA', contagem = 'HORARIO_EXATO', elegibilidade = 'OFERTA_PERSISTIDA', validade_oferta = '7 days',
        inicio = clock_timestamp() - interval '1 hour', autorizacao = 'Teste sintético sem autorização real', ativada_por = $1 WHERE codigo = 'fundador-091'`, [usuario]);
    const criados: { nome: string; cpfCnpj: string }[] = [];
    const subs = new Map<string, Record<string, unknown>>();
    const provedor = {
        async buscarClientePorReferencia() { return null; },
        async criarCliente(i: { nome: string; cpfCnpj: string; referencia: string }) { criados.push({ nome: i.nome, cpfCnpj: i.cpfCnpj }); return { id: `cus_${criados.length}`, externalReference: i.referencia }; },
        async listarAssinaturasPorReferencia(ref: string) { return [...subs.values()].filter((s) => s.externalReference === ref); },
        async criarAssinatura(i: { cliente: string; referencia: string; valorCentavos: number }) {
            const id = `sub_${subs.size + 1}`; const s = { id, status: 'ACTIVE', deleted: false, cycle: 'MONTHLY', customer: i.cliente, externalReference: i.referencia, valorCentavos: i.valorCentavos };
            subs.set(id, s); return { ...s };
        },
        async obterAssinatura(id: string) { const s = subs.get(id); return s ? { ...s } : null; },
        async listarCobrancasDaAssinatura(id: string) { return [{ clienteId: subs.get(id)?.customer, id: `pay_${id}`, status: 'PENDING', dueDate: '2099-01-01', paymentDate: null, invoiceUrl: `https://sandbox.example.test/i/${id}`, deleted: false, valorCentavos: 11820, assinaturaId: id }]; },
    };
    const env = { ...ENV_CPF, ASSINATURA_PLANOS_ATIVOS: 'true', ASAAS_AMBIENTE: 'sandbox', ASSINATURA_CAMPANHA_FUNDADOR_ATIVA: 'true' };
    const depsDe = (empresa: string): DepsCobranca => ({
        withTenantTransaction: (_s: unknown, _e: unknown, t: (tx: never, tenant: never) => Promise<unknown>) => transacao(() => client)((tx) => t(tx as never, { empresaComprovada: empresa, membershipId: 'm', usuarioId: usuario, papelAtual: 'REPRESENTANTE_AUTORIZADO' } as never)),
        withTransaction: (t: (tx: never) => Promise<unknown>) => transacao(() => client)((tx) => t(tx as never)), provedor: () => provedor as never, env, travarContratacao: async (_e: string, t: () => Promise<unknown>) => t(),
    } as never);
    const sessao = { id: 's', usuario_id: usuario, nome: 'Gestão', cargo: null, papel: 'REPRESENTANTE_AUTORIZADO' as const, autenticado_em: '', expira_em: '', csrf_hash: '' };
    const pedido = { ciclo: 'MENSAL', plano: 'essencial', valorEsperadoCentavos: 11820, versao: '2026-10-20' };
    const r = await iniciarAssinatura(sessao as never, null, pedido, { requestId: randomUUID() }, depsDe(ids.pf)) as { urlPagamento?: string };
    assert.ok(r.urlPagamento);
    assert.deepEqual(criados.at(-1), { nome: 'Maria Sintética da Silva', cpfCnpj: cpf(10) });
    const f = (await client.query('SELECT origem, vaga, documento_beneficiario FROM assinatura_fundadores WHERE empresa_id = $1', [ids.pf])).rows[0];
    assert.deepEqual(f, { origem: 'JANELA', vaga: null, documento_beneficiario: cpf(10) });
    await iniciarAssinatura(sessao as never, null, pedido, { requestId: randomUUID() }, depsDe(ids.pj));
    assert.deepEqual(criados.at(-1), { nome: 'Festas Sintéticas Ltda', cpfCnpj: cnpj(1) });
    // Teste com CPF, cadastro trocado para CNPJ pelo painel: o checkout não cria cliente com documento de outro tipo.
    const g = await conta('gil');
    const rg = await cadastrar(g.sessao, pf(cpf(60)));
    await client.query('UPDATE plataforma_empresas_cadastro SET documento_fiscal = $2 WHERE empresa_id = $1', [rg.empresaId, cnpj(60)]);
    const total = criados.length;
    assert.equal(await erro(iniciarAssinatura(sessao as never, null, pedido, { requestId: randomUUID() }, depsDe(rg.empresaId!))), 'DOCUMENTO_DIVERGENTE');
    assert.equal(criados.length, total, 'nenhum cliente criado');
    // Revisão completa 22/10, P2-2: mesmo tipo, outro documento (CPF A → B na ficha). Nome B + CPF A nunca vai ao provedor.
    const h = await conta('hugo');
    const rh = await cadastrar(h.sessao, pf(cpf(61)));
    await client.query('UPDATE plataforma_empresas_cadastro SET documento_fiscal = $2, nome_empresarial = $3 WHERE empresa_id = $1', [rh.empresaId, cpf(62), 'Outro Titular Sintético']);
    assert.equal(await erro(iniciarAssinatura(sessao as never, null, pedido, { requestId: randomUUID() }, depsDe(rh.empresaId!))), 'DOCUMENTO_DIVERGENTE');
    assert.equal(criados.length, total, 'nenhum cliente criado (CPF A → B)');
    // P2-1: CPF sem nome civil na ficha (estado que o painel permitia): recusa acionável, nunca nome do buffet + CPF.
    const iv = await conta('ivo');
    const ri = await cadastrar(iv.sessao, pf(cpf(63)));
    await client.query('UPDATE plataforma_empresas_cadastro SET nome_empresarial = NULL WHERE empresa_id = $1', [ri.empresaId]);
    assert.equal(await erro(iniciarAssinatura(sessao as never, null, pedido, { requestId: randomUUID() }, depsDe(ri.empresaId!))), 'DADOS_INVALIDOS');
    assert.equal(criados.length, total, 'nenhum cliente criado (sem nome civil)');
});

test('7b. postcheck recusa gatilho com o nome certo e tipo errado; rollback em estado parcial recusa com motivo explícito', { skip: !opt() }, async () => {
    await client.query('BEGIN');
    try {
        await client.query('DROP TRIGGER empresa_assinaturas_091_documento ON empresa_assinaturas');
        await client.query('CREATE TRIGGER empresa_assinaturas_091_documento BEFORE INSERT OR UPDATE ON empresa_assinaturas FOR EACH ROW EXECUTE FUNCTION kidmais_091_documento_guarda()');
        await client.query('SAVEPOINT a');
        await assert.rejects(client.query(SQL.post), /091 postcheck/);
        await client.query('ROLLBACK TO SAVEPOINT a');
        await client.query('DROP TRIGGER empresa_assinaturas_091_documento ON empresa_assinaturas');
        await assert.rejects(client.query(SQL.down.replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, '')), /migration ausente ou parcial/);
        // P3-1 da revisão: sem o gatilho da continuidade (os outros presentes) o rollback também recusa.
        await client.query('ROLLBACK TO SAVEPOINT a');
        await client.query('DROP TRIGGER empresa_documento_continuidades_091_guarda ON empresa_documento_continuidades');
        await assert.rejects(client.query(SQL.down.replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, '')), /migration ausente ou parcial/);
        await client.query('ROLLBACK TO SAVEPOINT a');
        await client.query('DROP INDEX empresa_doc_continuidades_pendente_uk');
        await assert.rejects(client.query(SQL.down.replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, '')), /migration ausente ou parcial/);
    } finally { await client.query('ROLLBACK'); }
    await client.query(SQL.post);
});

test('7. rollback da 091 recusado com CPF registrado', { skip: !opt() }, async () => {
    await assert.rejects(client.query(SQL.down), /rollback recusado/);
    await client.query('ROLLBACK').catch(() => undefined);
    assert.equal((await client.query("SELECT to_regprocedure('public.kidmais_091_documento_valido(text)') IS NOT NULL AS ok")).rows[0].ok, true);
});

test('8. Perfil: contratante PF é reconhecido pela empresa SaaS do perfil (CNPJ opcional ao aplicar); PJ continua exigindo CNPJ', { skip: !opt() }, async () => {
    const { contratantePessoaFisica } = await import('../perfil/cadastro-service.ts');
    const { validarAplicacao } = await import('../perfil/cadastro.ts');
    const perfil = async (empresaId: string) => {
        const codigo = (await client.query('SELECT codigo FROM empresas WHERE id = $1', [empresaId])).rows[0].codigo;
        return (await client.query('INSERT INTO perfil_empresas (codigo, nome_comercial) VALUES ($1, $2) RETURNING id', [codigo, 'Perfil sintético'])).rows[0].id as string;
    };
    const pfPerfil = await perfil(ids.pf), pjPerfil = await perfil(ids.pj);
    assert.equal(await contratantePessoaFisica(client as never, pfPerfil), true);
    assert.equal(await contratantePessoaFisica(client as never, pjPerfil), false);
    const cadastro = { nomeComercial: 'Buffet da Maria', razaoSocial: 'Maria Sintética da Silva', cnpj: '', unidadeNome: 'Buffet da Maria', mesmoEnderecoSede: true,
        sede: { cep: '01001000', logradouro: 'Praça da Sé', numero: '1', semNumero: false, complemento: '', bairro: 'Sé', cidade: 'São Paulo', uf: 'SP', pais: 'BR' },
        telefone: '11999990000', whatsapp: '11999990000', emailComercial: 'contato@exemplo.test' };
    assert.deepEqual(validarAplicacao(cadastro as never, { pessoaFisica: await contratantePessoaFisica(client as never, pfPerfil) }).falhas, []);
    assert.ok(validarAplicacao(cadastro as never, { pessoaFisica: await contratantePessoaFisica(client as never, pjPerfil) }).falhas.some((f) => f.campo === 'cnpj'));
    // Gravação do Perfil PF sem CNPJ respeita o CHECK 027 (CNPJ nulo, nunca vazio nem CPF).
    await client.query('UPDATE perfil_empresas SET razao_social = $2, cnpj = NULL WHERE id = $1', [pfPerfil, 'Maria Sintética da Silva']);
    await assert.rejects(client.query('UPDATE perfil_empresas SET cnpj = $2 WHERE id = $1', [pfPerfil, cpf(10)]), /perfil_empresas_cnpj_check/);
});

test('9. continuidade assistida (D5): sempre pendente até a conferência; trava do checkout; data efetiva; cadeia de documentos; cliente órfão; guardas do banco', { skip: !opt() }, async () => {
    const { registrarContinuidade, concluirContinuidade, continuidadesDaEmpresa } = await import('../desenvolvedor/continuidade.ts');
    const { documentoVigente } = await import('./documento-contratante.ts');
    const { contratantePessoaFisica } = await import('../perfil/cadastro-service.ts');
    const { prepararOferta } = await import('./ofertas.ts');
    const ENV_CONT = { ...ENV_CPF, ASSINATURA_CONTINUIDADE_ATIVA: 'true' };
    const operador = ids.biaUsuario;
    const tx = transacao(() => client);
    const hoje = (await client.query("SELECT ((clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date)::text AS d")).rows[0].d as string;
    const registrar = (empresaId: string, o: Record<string, unknown>, env: Record<string, string> = ENV_CONT) => tx((t) => registrarContinuidade(t as never, {
        empresaId, usuarioId: operador, tipo: 'MESMA_TITULARIDADE', documentoNovo: '', nomeNovo: 'Maria Sintética da Silva ME', instrumento: 'Aditivo de qualificação v1 (sintético)',
        evidencias: 'Certidão do CNPJ e documento do titular conferidos (sintético)', dataEfetiva: hoje, ...o } as never, env));
    const concluir = (empresaId: string, continuidadeId: string, nota = 'Provedor conferido por referência (sintético)') =>
        tx((t) => concluirContinuidade(t as never, { empresaId, continuidadeId, nota, usuarioId: operador }, ENV_CONT));
    const j = await conta('joana');
    const x = (await cadastrar(j.sessao, pf(cpf(70)))).empresaId!;
    // Chave desligada, combinações inválidas e data efetiva futura (P2-3): nada é registrado.
    assert.equal(await erro(registrar(x, { documentoNovo: cnpj(70) }, ENV_CPF)), 'CONTINUIDADE_INDISPONIVEL');
    const dvRuim = cnpj(70).slice(0, 13) + ((Number(cnpj(70)[13]) + 1) % 10);
    for (const [o, codigo] of [[{ tipo: 'RETIFICACAO', documentoNovo: cnpj(70) }, 'DADOS_INVALIDOS'], [{ documentoNovo: cpf(71) }, 'DADOS_INVALIDOS'],
        [{ documentoNovo: dvRuim }, 'DADOS_INVALIDOS'], [{ documentoNovo: cpf(70), tipo: 'RETIFICACAO' }, 'DADOS_INVALIDOS'], [{ documentoNovo: cnpj(1) }, 'DUPLICIDADE'],
        [{ documentoNovo: cnpj(70), dataEfetiva: '2099-01-01' }, 'DADOS_INVALIDOS']] as const)
        assert.equal(await erro(registrar(x, o)), codigo, JSON.stringify(o));
    assert.equal(await contar('SELECT count(*)::int AS n FROM empresa_documento_continuidades WHERE empresa_id = $1', [x]), 0, 'nada gravado nas recusas');
    // P2-1: contratação em curso (trava real kidmais:contratacao em outra conexão) → recusa sem esperar e sem gravar.
    await client2.query('BEGIN');
    await client2.query("SELECT pg_advisory_xact_lock(hashtext('kidmais:contratacao'), hashtext($1))", [x]);
    assert.equal(await erro(registrar(x, { documentoNovo: cnpj(70) })), 'CONTRATACAO_EM_ANDAMENTO');
    await client2.query('COMMIT');
    assert.equal(await contar('SELECT count(*)::int AS n FROM empresa_documento_continuidades WHERE empresa_id = $1', [x]), 0);
    // Registro: SEMPRE pendente (sem vínculo local não prova ausência de cliente remoto); ficha muda; snapshot do teste continua o CPF.
    const r = await registrar(x, { documentoNovo: cnpj(70) });
    assert.equal(r.situacao, 'PENDENTE_PROVEDOR');
    const ficha = (await client.query('SELECT c.documento_fiscal, c.nome_empresarial, a.documento_teste FROM plataforma_empresas_cadastro c JOIN empresa_assinaturas a USING (empresa_id) WHERE empresa_id = $1', [x])).rows[0];
    assert.deepEqual(ficha, { documento_fiscal: cnpj(70), nome_empresarial: 'Maria Sintética da Silva ME', documento_teste: cpf(70) });
    assert.deepEqual(await documentoVigente(client as never, x, cpf(70)), { documento: cnpj(70), pendente: true });
    const pedido = { ciclo: 'MENSAL', plano: 'essencial', valorEsperadoCentavos: 11820, versao: '2026-10-20' };
    const env = { ...ENV_CONT, ASSINATURA_PLANOS_ATIVOS: 'true', ASAAS_AMBIENTE: 'sandbox', ASSINATURA_CAMPANHA_FUNDADOR_ATIVA: 'true' };
    assert.equal(await erro(tx((t) => prepararOferta(t as never, x, operador, pedido as never, env))), 'CONTINUIDADE_PENDENTE');
    assert.equal(await erro(registrar(x, { documentoNovo: cnpj(73), tipo: 'RETIFICACAO' })), 'CONTINUIDADE_PENDENTE');
    // Conclusão também disputa a trava do checkout.
    await client2.query('BEGIN');
    await client2.query("SELECT pg_advisory_xact_lock(hashtext('kidmais:contratacao'), hashtext($1))", [x]);
    assert.equal(await erro(concluir(x, r.continuidadeId)), 'CONTRATACAO_EM_ANDAMENTO');
    await client2.query('COMMIT');
    assert.equal(await erro(concluir(ids.pj, r.continuidadeId, 'Empresa errada')), 'CONFLITO');
    await concluir(x, r.continuidadeId);
    assert.equal(await erro(concluir(x, r.continuidadeId, 'De novo')), 'CONFLITO');
    assert.deepEqual(await documentoVigente(client as never, x, cpf(70)), { documento: cnpj(70), pendente: false });
    const perfilX = (await client.query('INSERT INTO perfil_empresas (codigo, nome_comercial) VALUES ((SELECT codigo FROM empresas WHERE id = $1), $2) RETURNING id', [x, 'Perfil continuidade'])).rows[0].id;
    assert.equal(await contratantePessoaFisica(client as never, perfilX), false, 'Perfil passa a PJ (CNPJ obrigatório)');
    const lista = await continuidadesDaEmpresa(client as never, x);
    assert.equal(lista.length, 1);
    assert.ok(!JSON.stringify(lista).includes(cnpj(70)) && !JSON.stringify(lista).includes(cpf(70)), 'documentos mascarados');
    const retrato = (await client.query('SELECT condicoes FROM empresa_documento_continuidades WHERE empresa_id = $1', [x])).rows[0].condicoes;
    assert.ok(retrato.assinatura && !JSON.stringify(retrato).includes(cpf(70)), 'retrato das condições sem documento');
    // Checkout: cliente órfão achado por referência com o CPF antigo não é reaproveitado (P2-1); sem órfão, cria com o CNPJ.
    const criados: { nome: string; cpfCnpj: string }[] = [];
    const subs = new Map<string, Record<string, unknown>>();
    let orfao: { id: string; externalReference: string; cpfCnpj: string } | null = { id: 'cus_orfao', externalReference: x, cpfCnpj: cpf(70) };
    const provedor = {
        async buscarClientePorReferencia() { return orfao; },
        async criarCliente(i: { nome: string; cpfCnpj: string; referencia: string }) { criados.push({ nome: i.nome, cpfCnpj: i.cpfCnpj }); return { id: `cus_c${criados.length}`, externalReference: i.referencia }; },
        async listarAssinaturasPorReferencia(ref: string) { return [...subs.values()].filter((s) => s.externalReference === ref); },
        async criarAssinatura(i: { cliente: string; referencia: string; valorCentavos: number }) {
            const id = `sub_c${subs.size + 1}`; const s = { id, status: 'ACTIVE', deleted: false, cycle: 'MONTHLY', customer: i.cliente, externalReference: i.referencia, valorCentavos: i.valorCentavos };
            subs.set(id, s); return { ...s };
        },
        async obterAssinatura(id: string) { const s = subs.get(id); return s ? { ...s } : null; },
        async listarCobrancasDaAssinatura(id: string) { return [{ clienteId: subs.get(id)?.customer, id: `pay_${id}`, status: 'PENDING', dueDate: '2099-01-01', paymentDate: null, invoiceUrl: `https://sandbox.example.test/i/${id}`, deleted: false, valorCentavos: 11820, assinaturaId: id }]; },
    };
    const depsDe = (empresa: string): DepsCobranca => ({
        withTenantTransaction: (_s: unknown, _e: unknown, t: (tx: never, tenant: never) => Promise<unknown>) => transacao(() => client)((c) => t(c as never, { empresaComprovada: empresa, membershipId: 'm', usuarioId: operador, papelAtual: 'REPRESENTANTE_AUTORIZADO' } as never)),
        withTransaction: (t: (tx: never) => Promise<unknown>) => transacao(() => client)((c) => t(c as never)), provedor: () => provedor as never, env, travarContratacao: async (_e: string, t: () => Promise<unknown>) => t(),
    } as never);
    const sessao = { id: 's', usuario_id: operador, nome: 'Gestão', cargo: null, papel: 'REPRESENTANTE_AUTORIZADO' as const, autenticado_em: '', expira_em: '', csrf_hash: '' };
    assert.equal(await erro(iniciarAssinatura(sessao as never, null, pedido, { requestId: randomUUID() }, depsDe(x))), 'DOCUMENTO_DIVERGENTE');
    assert.equal(criados.length, 0);
    assert.equal((await client.query('SELECT provedor_cliente_id FROM empresa_assinaturas WHERE empresa_id = $1', [x])).rows[0].provedor_cliente_id, null, 'órfão não vinculado');
    orfao = null;
    await iniciarAssinatura(sessao as never, null, pedido, { requestId: randomUUID() }, depsDe(x));
    assert.deepEqual(criados.at(-1), { nome: 'Maria Sintética da Silva ME', cpfCnpj: cnpj(70) });
    assert.equal((await client.query('SELECT documento_beneficiario FROM assinatura_fundadores WHERE empresa_id = $1', [x])).rows[0].documento_beneficiario, cpf(70),
        'a concessão fica no snapshot do teste (074a), ligada pela continuidade');
    // P2-2: documento intermediário da cadeia (CNPJ 70 → retificação para CNPJ 75) continua vinculado: outro cadastro com ele vira pedido neutro.
    const r2 = await registrar(x, { tipo: 'RETIFICACAO', documentoNovo: cnpj(75), nomeNovo: 'Maria Sintética da Silva ME' });
    await concluir(x, r2.continuidadeId, 'Cliente atualizado no provedor (sintético)');
    const k = await conta('kaio');
    assert.equal((await cadastrar(k.sessao, pjAntigo(cnpj(70)))).situacao, 'CNPJ_EXISTENTE', 'intermediário não fica livre');
    assert.equal((await cadastrar(k.sessao, pjAntigo(cnpj(75)))).situacao, 'CNPJ_EXISTENTE', 'vigente');
    assert.equal(await contar('SELECT count(*)::int AS n FROM assinatura_fundadores WHERE documento_beneficiario = ANY($1)', [[cnpj(70), cnpj(75)]]), 0, 'nenhuma reserva nova');
    assert.equal(await erro(registrar(ids.pf, { documentoNovo: cnpj(70) })), 'DUPLICIDADE', 'intermediário de outra empresa não é "novo"');
    // Com cliente vinculado (ids.pf, do caso 6): pendente até a conferência.
    const p = await registrar(ids.pf, { documentoNovo: cnpj(72), nomeNovo: 'Maria Sintética Festas Ltda', tipo: 'CESSAO', instrumento: 'Cessão de posição contratual v1 (sintético)' });
    assert.equal(p.situacao, 'PENDENTE_PROVEDOR');
    await concluir(ids.pf, p.continuidadeId, 'Cliente conferido no provedor (sintético)');
    assert.deepEqual(await documentoVigente(client as never, ids.pf, cpf(10)), { documento: cnpj(72), pendente: false });
    // Guardas do banco: registro imutável, sem DELETE, encadeamento, DV e data futura.
    await assert.rejects(client.query("UPDATE empresa_documento_continuidades SET nome_novo = 'Outro' WHERE id = $1", [p.continuidadeId]), /registro é imutável/);
    await assert.rejects(client.query('DELETE FROM empresa_documento_continuidades WHERE id = $1', [p.continuidadeId]), /não é apagada/);
    const inserir = (anterior: string, novo: string, data = hoje) => client.query(`INSERT INTO empresa_documento_continuidades (empresa_id, tipo, documento_anterior, documento_novo, nome_novo,
        instrumento, evidencias, data_efetiva, condicoes, situacao, registrada_por)
        VALUES ($1, 'RETIFICACAO', $2, $3, 'Nome', 'Instrumento', 'Evidências', $5::date, '{}', 'PENDENTE_PROVEDOR', $4)`, [ids.pf, anterior, novo, operador, data]);
    await assert.rejects(inserir(cnpj(70), cnpj(74)), /não é o documento vigente/);
    await assert.rejects(inserir(cnpj(72), cnpj(74).slice(0, 13) + ((Number(cnpj(74)[13]) + 1) % 10)), /dígito verificador inválido/);
    await assert.rejects(inserir(cnpj(72), cnpj(74), '2099-01-01'), /data efetiva futura/);
    assert.deepEqual((await client.query('SELECT documento_teste FROM empresa_assinaturas WHERE empresa_id = $1', [ids.pf])).rows[0], { documento_teste: cpf(10) });
});
