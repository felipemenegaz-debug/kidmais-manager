/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const { Client } = require('pg');
async function main() {
    const source = new URL(process.env.DATABASE_URL), name = 'kidmais_funcional_' + Date.now();
    const dump = '.tmp/funcional-013.dump';
    const env = { ...process.env, PGPASSWORD: decodeURIComponent(source.password) };
    const args = ['-h', source.hostname, '-p', source.port || '5432', '-U', decodeURIComponent(source.username)];
    assert.equal(cp.spawnSync('C:/Program Files/PostgreSQL/18/bin/pg_dump.exe', [...args, '-d', source.pathname.slice(1), '-Fc', '-f', dump], { env }).status, 0);
    const admin = new Client({ connectionString: source.toString() });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${name}"`);
    await admin.end();
    assert.equal(cp.spawnSync('C:/Program Files/PostgreSQL/18/bin/pg_restore.exe', [...args, '-d', name, '--exit-on-error', dump], { env }).status, 0);
    source.pathname = '/' + name;
    process.env.DATABASE_URL = source.toString();
    process.env.NODE_ENV = 'test';
    process.env.ADMIN_AUTH_SECRET = crypto.randomBytes(32).toString('hex');
    process.env.ADMIN_AUTH_ORIGIN = 'http://localhost:3100';
    require('./pagamentos-test-support.cjs'); // Apenas transpiler; sem installPool/bypass de autenticação.
    const { NextRequest } = require('next/server');
    const auth = require('../app/api/admin/autenticacao/route.ts');
    const guard = require('../lib/http/admin-crm-api.ts');
    const { provisionar } = require('./admin-provision.cjs');
    const { consultarSessao } = require('../lib/autenticacao/service.ts');
    const { operarContrato } = require('../lib/contratos/services/administrativo.service.ts');
    const c = new Client({ connectionString: source.toString() });
    await c.connect();
    const results = [];
    const ok = name => { results.push(name); console.log('OK', name); };
    const password = crypto.randomBytes(24).toString('base64url');
    const bootstrap = { acao: 'bootstrap', email: 'rep@example.invalid', nome: 'Representante sintético', papel: 'REPRESENTANTE_AUTORIZADO', ativo: true, senha: password };
    const other = new Client({ connectionString: source.toString() });
    await other.connect();
    const initialUsers=(await c.query('SELECT count(*)::int AS n FROM usuarios_administrativos')).rows[0].n;
    // O banco atual pode ter o representante real. Só provisionamos fixtures no clone.
    const concorrente=initialUsers ? {...bootstrap,acao:'criar'} : bootstrap;
    const boot = await Promise.allSettled([provisionar(c, concorrente), provisionar(other, concorrente)]);
    await other.end();
    assert.equal(boot.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal((await c.query('SELECT count(*)::int AS n FROM usuarios_administrativos')).rows[0].n, initialUsers+1);
    ok(initialUsers ? 'provisionamento concorrente: exatamente um novo usuário; existentes preservados' : 'bootstrap concorrente: exatamente um usuário');
    await assert.rejects(provisionar(c, bootstrap));
    ok('bootstrap recusa usuário existente');
    await provisionar(c, { ...bootstrap, acao: 'criar', email: 'admin@example.invalid', nome: 'Administrativo sintético', papel: 'ADMINISTRATIVO' });
    function browser() {
        const jar = new Map();
        let csrf = '';
        return { jar, get token() { return jar.get('kidmais_admin_dev'); },
            async call(method, body, expected = 200, headers = {}) {
                const request = new NextRequest(process.env.ADMIN_AUTH_ORIGIN + '/api/admin/autenticacao', { method, headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), origin: process.env.ADMIN_AUTH_ORIGIN, 'Content-Type': 'application/json', 'x-csrf-token': csrf, ...headers }, ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) });
                const response = await auth[method](request);
                const data = await response.json();
                assert.equal(response.status, expected, JSON.stringify(data));
                for (const item of response.headers.getSetCookie()) {
                    const pair = item.split(';')[0];
                    const n = pair.indexOf('=');
                    jar.set(pair.slice(0, n), pair.slice(n + 1));
                }
                if (data.data?.csrf)
                    csrf = data.data.csrf;
                return data;
            },
            request(path, method = 'GET', headers = {}) { return new NextRequest(process.env.ADMIN_AUTH_ORIGIN + path, { method, headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), origin: process.env.ADMIN_AUTH_ORIGIN, 'x-csrf-token': csrf, ...headers } }); }
        };
    }
    const b = browser();
    await b.call('GET');
    await b.call('POST', { acao: 'login', email: bootstrap.email, senha: password }, 403, { 'x-csrf-token': 'forjado' });
    ok('CSRF inválido recusado');
    await assert.rejects(require('../lib/autenticacao/service.ts').loginAdmin('direct-absent@example.invalid', password, crypto.randomUUID(), null, null), e => { if (e.httpStatus !== 401)
        console.error('Diagnóstico autenticação', e.code, e.message); return e.httpStatus === 401; });
    await b.call('POST', { acao: 'login', email: 'ausente@example.invalid', senha: password }, 401);
    ok('usuário inexistente recusado');
    await b.call('POST', { acao: 'login', email: bootstrap.email, senha: 'senha-incorreta' }, 401);
    ok('senha incorreta recusada');
    await b.call('POST', { acao: 'login', email: bootstrap.email, senha: password });
    ok('login real');
    const user = (await b.call('GET')).data;
    assert.equal(user.papel, 'REPRESENTANTE_AUTORIZADO');
    assert.equal((await guard.exigirApiAdminCrmDisponivel(b.request('/api/admin/contratos'))).usuario_id, user.usuarioId);
    const spoof = new NextRequest(process.env.ADMIN_AUTH_ORIGIN + '/api/admin/contratos', { headers: { 'x-kidmais-dev-user-id': user.usuarioId } });
    await assert.rejects(guard.exigirApiAdminCrmDisponivel(spoof), e => e.httpStatus === 401);
    ok('spoof de usuário sem sessão recusado');
    const insecure = new NextRequest('http://100.112.40.14:3000/api/admin/contratos');
    assert.throws(() => guard.politicaAdmin(insecure));
    ok('HTTP remoto recusado');
    let s = await consultarSessao(b.token);
    await c.query("UPDATE sessoes_administrativas SET ultima_atividade_em=criado_em-interval '1 second' WHERE id=$1", [s.id]).then(() => assert.fail('check deve rejeitar'), e => assert.equal(e.code, '23514'));
    await c.query("UPDATE sessoes_administrativas SET criado_em=now()-interval '2 hours',autenticado_em=now()-interval '1 hour',ultima_atividade_em=now()-interval '31 minutes' WHERE id=$1", [s.id]);
    await assert.rejects(consultarSessao(b.token));
    ok('inatividade recusada');
    await b.call('GET');
    await b.call('POST', { acao: 'login', email: bootstrap.email, senha: password });
    s = await consultarSessao(b.token);
    await c.query("UPDATE sessoes_administrativas SET criado_em=now()-interval '2 hours',expira_em=now()-interval '1 second' WHERE id=$1", [s.id]);
    await assert.rejects(consultarSessao(b.token));
    ok('expiração absoluta recusada');
    await b.call('GET');
    await b.call('POST', { acao: 'login', email: bootstrap.email, senha: password });
    const old = b.token;
    await b.call('POST', { acao: 'reautenticar', senha: password });
    assert.notEqual(b.token, old);
    await assert.rejects(consultarSessao(old));
    ok('reautenticação rotaciona e revoga sessão anterior');
    await b.call('POST', { acao: 'reautenticar', senha: 'incorreta' }, 401);
    assert(await consultarSessao(b.token));
    ok('reautenticação incorreta não substitui sessão válida');
    await provisionar(c, { ...bootstrap, acao: 'criar', email: 'gestao@example.invalid', nome: 'Gestão sintética', papel: 'ADMINISTRATIVO' });
    const managed = browser();
    await managed.call('GET');
    await managed.call('POST', { acao: 'login', email: 'gestao@example.invalid', senha: password });
    const managedToken = managed.token;
    await provisionar(c, { acao: 'atualizar', email: 'gestao@example.invalid', papel: 'REPRESENTANTE_AUTORIZADO', ativo: true });
    await assert.rejects(consultarSessao(managedToken));
    ok('alteração de papel pelo CLI revoga sessão');
    await managed.call('GET');
    await managed.call('POST', { acao: 'login', email: 'gestao@example.invalid', senha: password });
    await provisionar(c, { acao: 'atualizar', email: 'gestao@example.invalid', papel: 'REPRESENTANTE_AUTORIZADO', ativo: false });
    await assert.rejects(consultarSessao(managed.token));
    await managed.call('GET');
    await managed.call('POST', { acao: 'login', email: 'gestao@example.invalid', senha: password }, 401);
    ok('desativação revoga e impede login');
    const limited = browser();
    await limited.call('GET');
    for (let i = 0; i < 5; i++)
        await limited.call('POST', { acao: 'login', email: 'limitado@example.invalid', senha: password }, 401);
    await limited.call('POST', { acao: 'login', email: 'limitado@example.invalid', senha: password }, 429);
    assert((await c.query("SELECT 1 FROM limites_autenticacao WHERE tipo='IDENTIFICADOR' AND tentativas=5 AND bloqueado_ate>now()")).rowCount > 0);
    ok('cinco falhas e bloqueio persistido; sexta tentativa recusada');
    // O teste deve partir da vigente, inclusive quando o operador já concluiu uma V2.
    const original = (await c.query("SELECT v.id,v.contrato_id FROM contrato_versoes v JOIN contrato_fluxos f ON f.versao_vigente_id=v.id WHERE v.status='ASSINADA' AND EXISTS(SELECT 1 FROM contratos c WHERE c.id=v.contrato_id AND c.status='ASSINADO') AND f.versao_em_preparacao_id IS NULL AND EXISTS(SELECT 1 FROM pagamentos p JOIN contrato_versoes pv ON pv.id=p.contrato_versao_id WHERE pv.contrato_id=v.contrato_id) ORDER BY v.id LIMIT 1")).rows[0];
    assert(original, 'Fixture: versão vigente assinada sem preparação aberta no clone');
    const before = (await c.query('SELECT to_jsonb(v)::text AS row FROM contrato_versoes v WHERE id=$1', [original.id])).rows;
    const financialBefore = (await c.query('SELECT to_jsonb(p)::text AS row FROM pagamentos p ORDER BY id')).rows;
    const ctx = { requestId: crypto.randomUUID(), ip: null, userAgent: 'Synthetic integration' };
    const made = await operarContrato(original.id, { acao: 'nova_versao', tipo: 'RETIFICACAO', motivo: 'Observação documental sintética' }, b.token, ctx);
    const vid = made.versaoId;
    // A cópia atual pode conter uma elaboração iniciada no teste manual.
    const revisaoInicial = (await c.query('SELECT revisao FROM contrato_edicoes WHERE contrato_versao_id=$1',[vid])).rows[0].revisao;
    const revisaoSalva = revisaoInicial + 1;
    ok('V1 vigente + V2 em elaboração');
    assert.equal((await c.query('SELECT versao_vigente_id FROM contrato_fluxos WHERE contrato_id=$1', [original.contrato_id])).rows[0].versao_vigente_id, original.id);
    assert.equal((await c.query('SELECT count(*)::int AS n FROM contrato_assinaturas WHERE contrato_versao_id=$1', [vid])).rows[0].n, 0);
    await operarContrato(vid, { acao: 'salvar', revisao: revisaoInicial, observacoesDocumentais: 'Conferência documental.' }, b.token, ctx);
    await assert.rejects(operarContrato(vid, { acao: 'salvar', revisao: revisaoInicial, observacoesDocumentais: 'Revisão desatualizada' }, b.token, ctx));
    ok('edição e conflito de revisão');
    const doc = await operarContrato(vid, { acao: 'gerar_pdf', revisao: revisaoSalva }, b.token, ctx);
    for (const statement of ['UPDATE contrato_documentos SET tamanho_bytes=tamanho_bytes+1 WHERE id=$1', 'DELETE FROM contrato_documentos WHERE id=$1'])
        await assert.rejects(c.query(statement, [doc.documentoId]), e => e.code === '23514');
    await assert.rejects(c.query(`INSERT INTO contrato_documentos(contrato_versao_id,categoria,revisao,snapshot_hash,template_codigo,template_versao,pdf_hash,tamanho_bytes,conteudo_pdf)
  SELECT contrato_versao_id,categoria,revisao,snapshot_hash,template_codigo,template_versao,repeat('0',64),tamanho_bytes,conteudo_pdf FROM contrato_documentos WHERE id=$1`, [doc.documentoId]), e => e.code === '23514');
    ok('BYTEA: hash incompatível e UPDATE/DELETE recusados fisicamente');
    await operarContrato(vid, { acao: 'revisar', revisao: revisaoSalva, documentoId: doc.documentoId }, b.token, ctx);
    const ordinary = browser();
    await ordinary.call('GET');
    await ordinary.call('POST', { acao: 'login', email: 'admin@example.invalid', senha: password });
    const sign = { acao: 'assinar', revisao: revisaoSalva, documentoId: doc.documentoId, chaveIdempotencia: crypto.randomUUID() };
    s = await consultarSessao(b.token);
    await c.query("UPDATE sessoes_administrativas SET criado_em=now()-interval '10 minutes',autenticado_em=now()-interval '6 minutes' WHERE id=$1", [s.id]);
    // A senha do fixture antecede a sessão antiga; a janela é a causa da recusa.
    await c.query("UPDATE usuarios_administrativos SET senha_alterada_em=now()-interval '1 hour' WHERE id=$1", [s.usuario_id]);
    await assert.rejects(operarContrato(vid, sign, b.token, ctx), e => e.httpStatus === 403);
    ok('assinatura exige reautenticação na janela de cinco minutos');
    await b.call('POST', { acao: 'reautenticar', senha: password });
    await assert.rejects(operarContrato(vid, sign, ordinary.token, ctx), e => e.httpStatus === 403);
    ok('ADMINISTRATIVO não assina');
    const signed = await Promise.all([operarContrato(vid, sign, b.token, ctx), operarContrato(vid, sign, b.token, ctx)]);
    assert.equal(signed[0].assinaturaId, signed[1].assinaturaId);
    ok('assinatura concorrente e idempotente');
    const proofBefore = (await c.query('SELECT to_jsonb(a)::text AS row FROM contrato_assinaturas a WHERE contrato_versao_id=$1', [vid])).rows;
    for (const statement of ["UPDATE contrato_assinaturas SET identidade_snapshot='{}' WHERE contrato_versao_id=$1", 'DELETE FROM contrato_assinaturas WHERE contrato_versao_id=$1', "UPDATE contrato_versoes SET snapshot_hash=repeat('0',64) WHERE id=$1"])
        await assert.rejects(c.query(statement, [vid]), e => e.code === '23514');
    ok('assinatura e snapshot imutáveis no PostgreSQL');
    s = await consultarSessao(b.token);
    await c.query('UPDATE sessoes_administrativas SET revogado_em=clock_timestamp() WHERE id=$1', [s.id]);
    await c.query('DELETE FROM sessoes_administrativas WHERE id=$1', [s.id]);
    await operarContrato(vid, { acao: 'liberar', revisao: revisaoSalva }, ordinary.token, ctx);
    ok('ADMINISTRATIVO libera após assinatura; sessão histórica excluída');
    assert.deepEqual((await c.query('SELECT to_jsonb(a)::text AS row FROM contrato_assinaturas a WHERE contrato_versao_id=$1', [vid])).rows, proofBefore);
    await assert.rejects(operarContrato(vid, { acao: 'salvar', revisao: revisaoSalva, observacoesDocumentais: 'Alteração proibida' }, ordinary.token, ctx));
    assert.deepEqual((await c.query('SELECT to_jsonb(v)::text AS row FROM contrato_versoes v WHERE id=$1', [original.id])).rows, before);
    assert.deepEqual((await c.query('SELECT to_jsonb(p)::text AS row FROM pagamentos p ORDER BY id')).rows, financialBefore);
    ok('V1/prova/Pagamentos preservados');
    const publicService = require('../lib/contratos/services/contrato-publico.service.ts');
    const identityService = require('../lib/identidade/services');
    const version = (await c.query('SELECT snapshot FROM contrato_versoes WHERE id=$1', [vid])).rows[0];
    const access = await publicService.consultarAcessoContrato({ contratoId: original.contrato_id, cpf: version.snapshot.contratante.cpf });
    let code;
    const sender = async (delivery) => { code = delivery.codigo; };
    const challenge = await publicService.iniciarDesafioContrato({ contratoId: original.contrato_id, cpf: version.snapshot.contratante.cpf, canal: access.canais[0].canal }, sender);
    assert(code);
    const confirmed = await identityService.criarIdentityServiceComAmbiente(sender).confirmarCodigo({ validacaoId: challenge.validacaoId, codigo: code });
    const publicInput = { contratoId: original.contrato_id, provaToken: confirmed.provaToken, acessoToken: challenge.acessoToken };
    const publicContext = await publicService.obterContextoContratoPublico(publicInput);
    assert.equal(publicContext.aceitePermitido, true);
    const bytesBefore = await publicService.gerarPdfContratoPublico(publicInput);
    const accept = { ...publicInput, versaoId: vid, snapshotHash: publicContext.versao.snapshotHash, documentoPdfHash: publicContext.versao.documentoPdfHash };
    const completed = await publicService.assinarContratoPublico(accept, sender);
    assert.equal(completed.versao.status, 'ASSINADA');
    assert.equal((await c.query('SELECT versao_vigente_id FROM contrato_fluxos WHERE contrato_id=$1', [original.contrato_id])).rows[0].versao_vigente_id, vid);
    assert.equal((await publicService.assinarContratoPublico(accept, sender)).reutilizado, true);
    assert((await publicService.gerarPdfContratoPublico(publicInput)).pdf.equals(bytesBefore.pdf));
    assert.equal((await c.query('SELECT count(*)::int AS n FROM contrato_assinaturas WHERE contrato_versao_id=$1', [vid])).rows[0].n, 2);
    assert.deepEqual((await c.query('SELECT to_jsonb(v)::text AS row FROM contrato_versoes v WHERE id=$1', [original.id])).rows, before);
    assert.deepEqual((await c.query('SELECT to_jsonb(p)::text AS row FROM pagamentos p ORDER BY id')).rows, financialBefore);
    ok('OTP real; promoção V2; duas provas; retry; PDF e V1 íntegros');
    const proofs = (await publicService.obterContextoContratoPublico(publicInput)).comprovantes;
    assert.equal(proofs.length, 2);
    for (const proof of proofs) {
        const document = await publicService.lerComprovantePublico({ ...publicInput, documentoId: proof.id });
        assert.equal(document.pdf_hash, crypto.createHash('sha256').update(document.conteudo_pdf).digest('hex'));
        assert(document.conteudo_pdf.includes(Buffer.from('Parte: ' + proof.parte)));
        assert(document.conteudo_pdf.includes(Buffer.from('Dados da assinatura')));
    }
    await assert.rejects(publicService.lerComprovantePublico({ ...publicInput, documentoId: doc.documentoId }));
    ok('comprovantes públicos vinculados à versão e hashes conferidos');
    const { acaoContratoSchema } = require('../lib/contratos/services/administrativo.service.ts');
    for (const extra of [{ valor: 1 }, { data: '2099-01-01' }, { contratante: {} }, { snapshot: {} }, { status: 'CONCLUIDA' }])
        assert.equal(acaoContratoSchema.safeParse({ acao: 'salvar', revisao: 1, observacoesDocumentais: 'Teste', ...extra }).success, false);
    ok('source of truth: injeção de campos de outro domínio recusada');
    // Exercita a pendência isoladamente, sem disponibilizar renegociação no produto.
    await c.query('BEGIN');
    const promoted = (await require('../lib/contratos/repositories').buscarVersaoPorId(vid, c));
    const modified = { ...promoted, snapshot: { ...promoted.snapshot, comercial: { ...promoted.snapshot.comercial, valorFinalContrato: promoted.snapshot.comercial.valorFinalContrato + 1 } } };
    const register = require('../lib/contratos/services/fluxo-publico.ts').registrarPendenciasDaVigencia;
    await register(c, modified, original.id);
    await register(c, modified, original.id);
    assert.equal((await c.query('SELECT count(*)::int AS n FROM contrato_pendencias_financeiras WHERE versao_nova_id=$1', [vid])).rows[0].n, 1);
    assert.deepEqual((await c.query('SELECT to_jsonb(p)::text AS row FROM pagamentos p ORDER BY id')).rows, financialBefore);
    await c.query('ROLLBACK');
    ok('pendência financeira idempotente sem alterar obrigação (cenário isolado)');
    await ordinary.call('POST', { acao: 'logout' });
    await assert.rejects(consultarSessao(ordinary.token ?? ''));
    ok('logout');
    process.env.NODE_ENV = 'production';
    process.env.ADMIN_AUTH_ORIGIN = 'https://admin.example.invalid';
    const secureOrigin = process.env.ADMIN_AUTH_ORIGIN;
    const prelogin = await auth.GET(new NextRequest(secureOrigin+'/api/admin/autenticacao'));
    const secureCsrf = (await prelogin.json()).data.csrf;
    const secureLogin = await auth.POST(new NextRequest(secureOrigin+'/api/admin/autenticacao', {method:'POST',headers:{origin:secureOrigin,cookie:`__Host-kidmais_admin_csrf=${secureCsrf}`,'x-csrf-token':secureCsrf,'content-type':'application/json'},body:JSON.stringify({acao:'login',email:bootstrap.email,senha:password})}));
    assert.equal(secureLogin.status,200);
    const secureCookies = secureLogin.headers.getSetCookie();
    assert.equal(secureCookies.length,2);
    for(const cookie of secureCookies){assert.match(cookie,/^__Host-/);assert.match(cookie,/; Secure/);assert.match(cookie,/; HttpOnly/);assert.match(cookie,/; SameSite=lax/i);assert.match(cookie,/; Path=\//);assert(!/; Domain=/i.test(cookie));}
    ok('HTTPS em produção: login real e cookies __Host, Secure, HttpOnly, Lax e sem Domain');
    fs.writeFileSync('.tmp/admin-contrato-resultados.json', JSON.stringify({ banco: name, contratoId: original.contrato_id, versaoId: vid, results }, null, 2));
    await c.end();
    if (globalThis.__kidmaisPgPool)
        await globalThis.__kidmaisPgPool.end();
}
main().catch(e => { console.error(e); process.exitCode = 1; process.exit(1); });
