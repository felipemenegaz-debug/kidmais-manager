/* eslint-disable @typescript-eslint/no-require-imports */
// PostgreSQL real para as migrations 073/074 e serviço de convites. Dependências prévias
// usam schema mínimo sintético; tenant/paywall/provedor são substituídos explicitamente.
// Não substitui homologação sobre a cadeia completa de migrations do produto.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const crypto = require('node:crypto'), ts = require('typescript');
const { Pool } = require('pg');
const root = path.resolve(__dirname, '..');
if (process.argv[2] !== '--executar-autorizado' || !process.argv[3] || process.argv[4] !== '--incluir-074-autorizado' || process.argv[5] !== '--incluir-079-autorizado') {
  console.log('PREPARADO, NÃO EXECUTADO. Migrations 073/074/079 exigem autorização própria; usar testar-convites-postgres.ps1 -Executar -Incluir074 -Incluir079 após autorização.');
  process.exit(0);
}
const cluster = path.resolve(process.argv[3]);
assert.equal(path.dirname(cluster).toLowerCase(), root.toLowerCase());
assert.match(path.basename(cluster), /^\.local-convites-pg-073-[a-f0-9]{32}$/);
assert.equal(fs.readFileSync(path.join(cluster, 'PG_VERSION'), 'utf8').trim(), '18');
const pool = new Pool({ host: '127.0.0.1', port: 55458, database: 'kidmais_convites_v1_teste',
  user: 'convites_teste', password: '', ssl: false, max: 8, connectionTimeoutMillis: 3000,
  options: '-c statement_timeout=10000 -c lock_timeout=5000', application_name: 'convites_073_sintetico' });
const env = { CONVITES_ENABLED: 'true', CONVITES_IA_TETO_DIARIO_MICROUSD: '100000000' };
function load(relative, deps = {}) {
  const file = path.join(root, relative);
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const m = { exports: {} };
  vm.runInNewContext(`(function(require,module,exports){${js}\n})`, { process: { env }, Buffer, Date, Intl })(name => {
    if (Object.hasOwn(deps, name)) return deps[name];
    if (['node:crypto', 'zod'].includes(name)) return require(name);
    throw Error(`Dependência não autorizada no teste: ${name}`);
  }, m, m.exports);
  return m.exports;
}
const domain = load('lib/convites/domain.ts', { './familias-domain.ts': load('lib/convites/familias-domain.ts') });
const familias = load('lib/convites/familias.ts', { './domain': domain });
const repository = load('lib/festas/repository.ts');
const conferencia = load('lib/convites/conferencia-prompt.ts');
const estilos = load('lib/convites/estilos.ts', { './domain.ts': domain, './conferencia-prompt.ts': conferencia,
  'node:fs/promises': require('node:fs/promises'), 'node:path': require('node:path') });
let providerCalls = 0, failProvider = false, beforeTransaction = null;
// Convite completo (V1): provedor sintético sem rede; registra cada chamada para provar que não há repetição automática.
const chamadasCompleto = [];
async function transaction(fn) {
  if (beforeTransaction) { const hook = beforeTransaction; beforeTransaction = null; await hook(); }
  const client = await pool.connect();
  try { await client.query('BEGIN'); const r = await fn(client); await client.query('COMMIT'); return r; }
  catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}
const service = load('lib/convites/service.ts', {
  '../db/postgres': { db: () => pool, withTransaction: transaction },
  '../saas/provar-tenant': { provarTenant: async (tx, session) => {
    assert((await tx.query("SELECT id FROM empresas WHERE id=$1 AND status='ATIVA' FOR UPDATE", [session.empresa])).rowCount);
    return { empresaComprovada: session.empresa, membershipId: session.membership, usuarioId: session.usuario_id, papelAtual: 'REPRESENTANTE_AUTORIZADO' };
  }, revalidarTenant: async () => {} },
  '../saas/provar-estabelecimento': { provarEstabelecimento: async () => { throw Error('Fixture usa unidade nula'); } },
  '../festas/repository': repository,
  '../assinatura/estado': { lerEstadoComercial: async () => ({ acesso: { nivel: 'COMPLETO' } }) },
  './domain': domain, './familias': familias,
  './estilos': estilos,
  './imagem': { MODELO: 'provedor-sintetico-sem-rede', iaConfigurada: () => true,
    FalhaProvedorImagem: class FalhaProvedorImagem extends Error {}, modeloImagem: () => 'provedor-sintetico-sem-rede',
    MODELO_COMPLETO: 'completo-sintetico-sem-rede', QUALIDADE_COMPLETO: 'sintetica', completoDisponivel: () => true,
    armazenarConviteCompleto: async png => png,
    gerarConviteCompletoOpenAI: async (prompt, _fetch, _env, qualidade, refs) => {
      chamadasCompleto.push({ prompt, qualidade, refs: refs.length }); if (failProvider) throw Error('timeout simulado');
      return { imagem: Buffer.from('convite-completo-sintetico'), uso: {} }; },
    normalizarImagem: async () => Buffer.from('arte-sintetica'),
    gerarImagem: async () => { providerCalls++; if (failProvider) throw Error('timeout simulado'); return { imagem: Buffer.from('arte-sintetica'), uso: {} }; } },
});
const uuid = () => crypto.randomUUID();
const evidenciaRecuperacao = 'Verificado no painel do provedor; registro sintético da validação.';
const conteudo = { tema: 'jardim', nome: 'Criança fictícia', idade: '5 anos', mensagem: 'Vamos comemorar!',
  data: '2099-12-20', horario: '16:00', local: 'Buffet fictício', endereco: 'Endereço fictício', arteId: null, confirmarPresenca: true };
const pedido = () => ({ acao: 'gerar', chave: uuid(), prompt: 'Jardim de flores coloridas', referencias: [] });
async function empresa(limite = 10) {
  const id = uuid(); await pool.query("INSERT INTO empresas VALUES($1,'ATIVA')", [id]);
  await pool.query('INSERT INTO convite_carteiras VALUES($1,$2,true)', [id, limite]); return id;
}
async function festa(empresaId) {
  const cliente = uuid(), fechamento = uuid(), contrato = uuid(), versao = uuid(), festaId = uuid(), usuario = uuid(), membership = uuid();
  await pool.query('INSERT INTO usuarios_administrativos(id) VALUES($1)', [usuario]);
  await pool.query("INSERT INTO festa_membership_capacidades(id,empresa_id,membership_id,capacidade) VALUES($1,$2,$3,'FESTA_OPERAR')", [uuid(), empresaId, membership]);
  const token = crypto.randomBytes(32).toString('base64url'), publico = crypto.randomBytes(32).toString('base64url');
  await pool.query('INSERT INTO clientes VALUES($1)', [cliente]);
  await pool.query('INSERT INTO fechamentos VALUES($1,$2,$3,NULL)', [fechamento, empresaId, cliente]);
  await pool.query("INSERT INTO contratos VALUES($1,$2,'ASSINADO',NULL)", [contrato, fechamento]);
  await pool.query("INSERT INTO contrato_versoes VALUES($1,'ASSINADA',1,'{}')", [versao]);
  await pool.query('INSERT INTO contrato_fluxos VALUES($1,$2)', [contrato, versao]);
  await pool.query('INSERT INTO festas VALUES($1,$2,NULL)', [festaId, contrato]);
  const c = (await pool.query(`INSERT INTO convites(empresa_id,festa_id,cliente_id,publico_token,editor_hash,editor_expira_em,rascunho,versao_contrato_id)
    VALUES($1,$2,$3,$4,$5,now()+interval '1 day',$6,$7) RETURNING id`, [empresaId, festaId, cliente, publico,
    crypto.createHash('sha256').update(token).digest('hex'), conteudo, versao])).rows[0];
  return { id: c.id, empresa: empresaId, festa: festaId, contrato, versao, cliente, publico,
    acesso: { tipo: 'cliente', token }, admin: { tipo: 'admin', festaId, sessao: { empresa: empresaId, membership, usuario_id: usuario } } };
}
  const checks = [];
async function check(name, fn) { await fn(); checks.push(name); console.log(`PASS: ${name}`); }
async function run() {
  const identity = (await pool.query("SELECT current_database() banco,current_setting('data_directory') diretorio,current_user usuario")).rows[0];
  assert.equal(identity.banco, 'kidmais_convites_v1_teste'); assert.equal(identity.usuario, 'convites_teste');
  assert.equal(path.resolve(identity.diretorio).toLowerCase(), cluster.toLowerCase());
  assert.equal(Number((await pool.query("SELECT count(*) n FROM pg_tables WHERE schemaname='public'")).rows[0].n), 0, 'Exige banco vazio');
  await pool.query(`CREATE TABLE empresas(id uuid PRIMARY KEY,status text NOT NULL);
    CREATE TABLE usuarios_administrativos(id uuid PRIMARY KEY);
    CREATE TABLE clientes(id uuid PRIMARY KEY);
    CREATE TABLE estabelecimentos(id uuid PRIMARY KEY);
    CREATE TABLE fechamentos(id uuid PRIMARY KEY,empresa_id uuid REFERENCES empresas,cliente_id uuid REFERENCES clientes,estabelecimento_id uuid REFERENCES estabelecimentos);
    CREATE TABLE contratos(id uuid PRIMARY KEY,fechamento_id uuid REFERENCES fechamentos,status text,cancelado_em timestamptz);
    CREATE TABLE contrato_versoes(id uuid PRIMARY KEY,status text,numero_versao integer,snapshot jsonb);
    CREATE TABLE contrato_fluxos(contrato_id uuid PRIMARY KEY REFERENCES contratos,versao_vigente_id uuid REFERENCES contrato_versoes);
    CREATE TABLE contrato_edicoes(contrato_versao_id uuid REFERENCES contrato_versoes,estado text);
    CREATE TABLE festas(id uuid PRIMARY KEY,contrato_id uuid REFERENCES contratos,invalidada_em timestamptz);
    CREATE TABLE festa_membership_capacidades(id uuid PRIMARY KEY,empresa_id uuid,membership_id uuid,capacidade text,revogado_em timestamptz);`);
  await check('migration 073 aplica integralmente no schema sintético', async () => {
    await pool.query(fs.readFileSync(path.join(root, 'database/checks/20261008_073_precheck.sql'), 'utf8'));
    await pool.query(fs.readFileSync(path.join(root, 'database/migrations/20261008_073_convites.sql'), 'utf8'));
    await pool.query(fs.readFileSync(path.join(root, 'database/checks/20261008_073_postcheck.sql'), 'utf8'));
    await assert.rejects(pool.query(fs.readFileSync(path.join(root, 'database/checks/20261008_073_precheck.sql'), 'utf8')), /já aplicada/);
    assert.equal(Number((await pool.query("SELECT count(*) n FROM pg_tables WHERE schemaname='public' AND (tablename LIKE 'convite_%' OR tablename='convites')")).rows[0].n), 9);
  });
  await check('migration 074 preserva RSVP anterior e recusa reaplicação', async () => {
    const f = await festa(await empresa()), chave = uuid();
    await pool.query('INSERT INTO convite_respostas(convite_id,chave,nome,presenca,adultos,criancas) VALUES($1,$2,$3,true,2,1)', [f.id, chave, 'Família anterior']);
    await pool.query(fs.readFileSync(path.join(root, 'database/checks/20261009_074_precheck.sql'), 'utf8'));
    await pool.query(fs.readFileSync(path.join(root, 'database/migrations/20261009_074_convite_familias.sql'), 'utf8'));
    await pool.query(fs.readFileSync(path.join(root, 'database/checks/20261009_074_postcheck.sql'), 'utf8'));
    await assert.rejects(pool.query(fs.readFileSync(path.join(root, 'database/checks/20261009_074_precheck.sql'), 'utf8')), /anterior ou parcial/);
    const r = (await pool.query('SELECT nome,adultos,familia_id FROM convite_respostas WHERE convite_id=$1 AND chave=$2', [f.id, chave])).rows[0];
    assert.equal(r.nome, 'Família anterior'); assert.equal(r.adultos, 2); assert.equal(r.familia_id, null);
  });
  await check('migration 079 passa precheck, aplica sem alterar gerações e passa postcheck', async () => {
    await pool.query(fs.readFileSync(path.join(root, 'database/checks/20261011_079_precheck.sql'), 'utf8'));
    await pool.query(fs.readFileSync(path.join(root, 'database/migrations/20261011_079_convite_recuperacao_manual.sql'), 'utf8'));
    await pool.query(fs.readFileSync(path.join(root, 'database/checks/20261011_079_postcheck.sql'), 'utf8'));
    await assert.rejects(pool.query(fs.readFileSync(path.join(root, 'database/checks/20261011_079_precheck.sql'), 'utf8')), /aplicação anterior ou parcial/);
  });
  await check('rollback 079 funciona antes de decisões e migration pode ser reaplicada', async () => {
    await pool.query(fs.readFileSync(path.join(root, 'database/rollback/20261011_079_convite_recuperacao_manual_down.sql'), 'utf8'));
    await pool.query(fs.readFileSync(path.join(root, 'database/checks/20261011_079_precheck.sql'), 'utf8'));
    await pool.query(fs.readFileSync(path.join(root, 'database/migrations/20261011_079_convite_recuperacao_manual.sql'), 'utf8'));
    await pool.query(fs.readFileSync(path.join(root, 'database/checks/20261011_079_postcheck.sql'), 'utf8'));
  });
  async function incerta(f) {
    const origem = (await pool.query("SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date dia, date_trunc('month',now() AT TIME ZONE 'America/Sao_Paulo')::date mes")).rows[0];
    await pool.query('UPDATE convites SET usado_festa=1,usado_cliente=1 WHERE id=$1', [f.id]);
    await pool.query('INSERT INTO convite_consumos(empresa_id,mes,usado) VALUES($1,$2,1) ON CONFLICT(empresa_id,mes) DO UPDATE SET usado=convite_consumos.usado+1', [f.empresa, origem.mes]);
    await pool.query('INSERT INTO convite_orcamento_global(dia,reservado_microusd) VALUES($1,300000) ON CONFLICT(dia) DO UPDATE SET reservado_microusd=convite_orcamento_global.reservado_microusd+300000', [origem.dia]);
    const chave = uuid();
    await pool.query("INSERT INTO convite_geracoes(id,convite_id,empresa_id,ator,payload_hash,estado,modelo,criado_em,reserva_microusd) VALUES($1,$2,$3,$4,$5,'INCERTA','teste-sintetico',now(),300000)",
      [chave, f.id, f.empresa, `CLIENTE:${f.cliente}`, crypto.createHash('sha256').update(chave).digest('hex')]);
    return chave;
  }
  await check('recuperação PostgreSQL: cobrança confirmada mantém créditos e grava evidência', async () => {
    const f = await festa(await empresa()), chave = await incerta(f);
    const r = await service.comandar(f.admin, { acao: 'recuperar', chave, resultado: 'COBRANCA_CONFIRMADA', evidencia: evidenciaRecuperacao });
    assert.equal(r.estado, 'RESOLVIDA_COBRADA'); assert.equal(r.liberouReserva, false);
    const g = (await pool.query('SELECT estado,resolucao_resultado,resolucao_por,resolucao_evidencia FROM convite_geracoes WHERE id=$1', [chave])).rows[0];
    assert.equal(g.estado, 'RESOLVIDA_COBRADA'); assert.equal(g.resolucao_resultado, 'COBRANCA_CONFIRMADA');
    assert.equal(g.resolucao_por, f.admin.sessao.usuario_id); assert.equal(g.resolucao_evidencia, evidenciaRecuperacao);
    assert.equal((await pool.query('SELECT usado_festa,usado_cliente FROM convites WHERE id=$1', [f.id])).rows[0].usado_festa, 1);
    assert.equal((await pool.query('SELECT usado FROM convite_consumos WHERE empresa_id=$1', [f.empresa])).rows[0].usado, 1);
    assert.equal((await pool.query("SELECT count(*) n FROM convite_eventos WHERE convite_id=$1 AND acao='IA_RECUPERACAO_MANUAL'", [f.id])).rows[0].n, '1');
  });
  await check('recuperação PostgreSQL: sem cobrança libera mensal, festa, cliente e diária exatamente uma vez', async () => {
    const f = await festa(await empresa()), chave = await incerta(f);
    const orcamentoAntes = BigInt((await pool.query("SELECT reservado_microusd FROM convite_orcamento_global WHERE dia=(now() AT TIME ZONE 'America/Sao_Paulo')::date")).rows[0].reservado_microusd);
    const r = await service.comandar(f.admin, { acao: 'recuperar', chave, resultado: 'SEM_COBRANCA', evidencia: evidenciaRecuperacao });
    assert.equal(r.estado, 'RESOLVIDA_SEM_COBRANCA'); assert.equal(r.liberouReserva, true);
    const c = (await pool.query('SELECT usado_festa,usado_cliente FROM convites WHERE id=$1', [f.id])).rows[0];
    assert.equal(c.usado_festa, 0); assert.equal(c.usado_cliente, 0);
    assert.equal((await pool.query('SELECT usado FROM convite_consumos WHERE empresa_id=$1', [f.empresa])).rows[0].usado, 0);
    const orcamentoDepois = BigInt((await pool.query("SELECT reservado_microusd FROM convite_orcamento_global WHERE dia=(now() AT TIME ZONE 'America/Sao_Paulo')::date")).rows[0].reservado_microusd);
    assert.equal(orcamentoDepois, orcamentoAntes - 300000n);
    assert.equal((await pool.query("SELECT count(*) n FROM convite_eventos WHERE convite_id=$1 AND acao='IA_RECUPERACAO_MANUAL'", [f.id])).rows[0].n, '1');
    await assert.rejects(service.comandar(f.admin, { acao: 'recuperar', chave, resultado: 'SEM_COBRANCA', evidencia: evidenciaRecuperacao }), /já foi resolvida/);
    assert.equal((await pool.query("SELECT count(*) n FROM convite_eventos WHERE convite_id=$1 AND acao='IA_RECUPERACAO_MANUAL'", [f.id])).rows[0].n, '1');
  });
  await check('recuperação PostgreSQL: repetição concorrente de sem cobrança devolve uma vez', async () => {
    const f = await festa(await empresa()), chave = await incerta(f);
    const orcamentoAntes = BigInt((await pool.query("SELECT reservado_microusd FROM convite_orcamento_global WHERE dia=(now() AT TIME ZONE 'America/Sao_Paulo')::date")).rows[0].reservado_microusd);
    const decisoes = await Promise.allSettled([
      service.comandar(f.admin, { acao: 'recuperar', chave, resultado: 'SEM_COBRANCA', evidencia: evidenciaRecuperacao }),
      service.comandar(f.admin, { acao: 'recuperar', chave, resultado: 'SEM_COBRANCA', evidencia: evidenciaRecuperacao }),
    ]);
    assert.equal(decisoes.filter(x => x.status === 'fulfilled').length, 1);
    assert.equal((await pool.query('SELECT usado_festa,usado_cliente FROM convites WHERE id=$1', [f.id])).rows[0].usado_festa, 0);
    assert.equal((await pool.query('SELECT usado FROM convite_consumos WHERE empresa_id=$1', [f.empresa])).rows[0].usado, 0);
    const orcamentoDepois = BigInt((await pool.query("SELECT reservado_microusd FROM convite_orcamento_global WHERE dia=(now() AT TIME ZONE 'America/Sao_Paulo')::date")).rows[0].reservado_microusd);
    assert.equal(orcamentoDepois, orcamentoAntes - 300000n);
    assert.equal((await pool.query("SELECT count(*) n FROM convite_eventos WHERE convite_id=$1 AND acao='IA_RECUPERACAO_MANUAL'", [f.id])).rows[0].n, '1');
  });
  await check('recuperação PostgreSQL: decisões conflitantes concorrentes só podem vencer uma vez', async () => {
    const f = await festa(await empresa()), chave = await incerta(f);
    const orcamentoAntes = BigInt((await pool.query("SELECT reservado_microusd FROM convite_orcamento_global WHERE dia=(now() AT TIME ZONE 'America/Sao_Paulo')::date")).rows[0].reservado_microusd);
    const decisoes = await Promise.allSettled([
      service.comandar(f.admin, { acao: 'recuperar', chave, resultado: 'SEM_COBRANCA', evidencia: evidenciaRecuperacao }),
      service.comandar(f.admin, { acao: 'recuperar', chave, resultado: 'COBRANCA_CONFIRMADA', evidencia: evidenciaRecuperacao }),
    ]);
    assert.equal(decisoes.filter(x => x.status === 'fulfilled').length, 1);
    const estado = (await pool.query('SELECT estado FROM convite_geracoes WHERE id=$1', [chave])).rows[0].estado;
    assert.ok(['RESOLVIDA_SEM_COBRANCA', 'RESOLVIDA_COBRADA'].includes(estado));
    if (estado === 'RESOLVIDA_SEM_COBRANCA') {
      const c = (await pool.query('SELECT usado_festa,usado_cliente FROM convites WHERE id=$1', [f.id])).rows[0];
      assert.equal(c.usado_festa, 0); assert.equal(c.usado_cliente, 0);
      assert.equal((await pool.query('SELECT usado FROM convite_consumos WHERE empresa_id=$1', [f.empresa])).rows[0].usado, 0);
      const orcamentoDepois = BigInt((await pool.query("SELECT reservado_microusd FROM convite_orcamento_global WHERE dia=(now() AT TIME ZONE 'America/Sao_Paulo')::date")).rows[0].reservado_microusd);
      assert.equal(orcamentoDepois, orcamentoAntes - 300000n);
    } else {
      const c = (await pool.query('SELECT usado_festa,usado_cliente FROM convites WHERE id=$1', [f.id])).rows[0];
      assert.equal(c.usado_festa, 1); assert.equal(c.usado_cliente, 1);
      assert.equal((await pool.query('SELECT usado FROM convite_consumos WHERE empresa_id=$1', [f.empresa])).rows[0].usado, 1);
      const orcamentoDepois = BigInt((await pool.query("SELECT reservado_microusd FROM convite_orcamento_global WHERE dia=(now() AT TIME ZONE 'America/Sao_Paulo')::date")).rows[0].reservado_microusd);
      assert.equal(orcamentoDepois, orcamentoAntes);
    }
    assert.equal((await pool.query("SELECT count(*) n FROM convite_eventos WHERE convite_id=$1 AND acao='IA_RECUPERACAO_MANUAL'", [f.id])).rows[0].n, '1');
    await assert.rejects(service.comandar(f.admin, { acao: 'recuperar', chave, resultado: 'SEM_COBRANCA', evidencia: evidenciaRecuperacao }), /já foi resolvida/);
  });
  await check('recuperação PostgreSQL: decisão inválida, tenant e permissão são recusados; falha reverte tudo', async () => {
    const f = await festa(await empresa()), chave = await incerta(f);
    const orcamentoAntes = (await pool.query("SELECT reservado_microusd FROM convite_orcamento_global WHERE dia=(now() AT TIME ZONE 'America/Sao_Paulo')::date")).rows[0].reservado_microusd;
    await assert.rejects(service.comandar(f.admin, { acao: 'recuperar', chave, resultado: 'SEM_COBRANCA', evidencia: 'curta' }));
    const outro = await festa(await empresa());
    await assert.rejects(service.comandar({ ...f.admin, sessao: { ...f.admin.sessao, empresa: outro.empresa } }, { acao: 'recuperar', chave, resultado: 'SEM_COBRANCA', evidencia: evidenciaRecuperacao }));
    await pool.query("UPDATE festa_membership_capacidades SET revogado_em=now() WHERE empresa_id=$1 AND membership_id=$2", [f.empresa, f.admin.sessao.membership]);
    await assert.rejects(service.comandar(f.admin, { acao: 'recuperar', chave, resultado: 'SEM_COBRANCA', evidencia: evidenciaRecuperacao }), /permissão/);
    await pool.query('DELETE FROM convite_consumos WHERE empresa_id=$1', [f.empresa]);
    await pool.query("INSERT INTO festa_membership_capacidades(id,empresa_id,membership_id,capacidade) VALUES($1,$2,$3,'FESTA_OPERAR')", [uuid(), f.empresa, f.admin.sessao.membership]);
    await assert.rejects(service.comandar(f.admin, { acao: 'recuperar', chave, resultado: 'SEM_COBRANCA', evidencia: evidenciaRecuperacao }), /reserva mensal original/);
    assert.equal((await pool.query('SELECT estado FROM convite_geracoes WHERE id=$1', [chave])).rows[0].estado, 'INCERTA');
    assert.equal((await pool.query('SELECT usado_festa,usado_cliente FROM convites WHERE id=$1', [f.id])).rows[0].usado_festa, 1);
    assert.equal((await pool.query("SELECT reservado_microusd FROM convite_orcamento_global WHERE dia=(now() AT TIME ZONE 'America/Sao_Paulo')::date")).rows[0].reservado_microusd, orcamentoAntes);
  });
  await check('rollback 079 recusa apagar decisões auditáveis', async () => {
    const sql = fs.readFileSync(path.join(root, 'database/rollback/20261011_079_convite_recuperacao_manual_down.sql'), 'utf8');
    await assert.rejects(pool.query(sql), /há decisões auditáveis/);
    assert.equal((await pool.query("SELECT count(*) n FROM information_schema.columns WHERE table_schema='public' AND table_name='convite_geracoes' AND column_name='resolucao_evidencia'")).rows[0].n, '1');
  });
  await check('famílias: concorrência, isolamento SQL, revogação durante espera e arquivo', async () => {
    const f = await festa(await empresa()), outra = await festa(await empresa());
    await service.comandar(f.acesso, { acao: 'publicar', revisao: 1, conteudo });
    const p = { acao: 'familia_adicionar', id: uuid(), nome: 'Família sintética', adultos: 2, criancas: 1 };
    const resultados = await Promise.all([service.comandar(f.acesso, p), service.comandar(f.acesso, p)]);
    assert.equal(resultados.filter(r => r.repetida).length, 1);
    const token = resultados.find(r => r.linkFamilia).linkFamilia.split('#familia=')[1];
    const resposta = { chave: uuid(), nome: 'Nome não confiável', presenca: true, adultos: 2, criancas: 1 };
    await Promise.all([service.confirmar(f.publico, resposta, token), service.confirmar(f.publico, { ...resposta, chave: uuid() }, token)]);
    assert.equal(Number((await pool.query('SELECT count(*) n FROM convite_respostas WHERE convite_id=$1', [f.id])).rows[0].n), 1);
    assert.equal((await service.consultarPublico(f.publico, token)).familia.nome, p.nome);
    await assert.rejects(pool.query('INSERT INTO convite_respostas(convite_id,chave,nome,presenca,adultos,criancas,familia_id) VALUES($1,$2,$3,true,1,0,$4)', [f.id, uuid(), 'Duplicada', p.id]), { code: '23505' });
    await assert.rejects(pool.query('INSERT INTO convite_respostas(convite_id,chave,nome,presenca,adultos,criancas,familia_id) VALUES($1,$2,$3,true,1,0,$4)', [outra.id, uuid(), 'Outra festa', p.id]), { code: '23503' });
    await assert.rejects(pool.query('INSERT INTO convite_familias(id,convite_id,empresa_id,nome,adultos_previstos,criancas_previstas) VALUES($1,$2,$3,$4,1,0)', [uuid(), f.id, outra.empresa, 'Empresa errada']), { code: '23503' });
    await assert.rejects(service.confirmar(f.publico, { ...resposta, chave: p.id }), /link individual/);
    beforeTransaction = () => service.comandar(f.acesso, { acao: 'familia_link', id: p.id, revisao: 1, habilitado: false });
    await assert.rejects(service.confirmar(f.publico, resposta, token), /indisponível/);
    await service.comandar(f.acesso, { acao: 'familia_status', id: p.id, revisao: 2, ativa: false });
    assert.equal((await service.consultar(f.acesso)).respostas.length, 0);
    await service.comandar(f.acesso, { acao: 'familia_status', id: p.id, revisao: 3, ativa: true });
    assert.equal((await service.consultar(f.acesso)).respostas.length, 1);
    await assert.rejects(service.consultarPublico(f.publico, token), /indisponível/);
  });
  await check('trigger impede vínculo com outra empresa e mudança de dono', async () => {
    const e = await empresa(), f = await festa(e), outra = await empresa();
    await assert.rejects(pool.query('UPDATE convites SET empresa_id=$2 WHERE id=$1', [f.id, outra]), /inválido/);
    const outraFesta = await festa(e);
    await assert.rejects(pool.query('UPDATE convites SET festa_id=$2,cliente_id=$3 WHERE id=$1', [f.id, outraFesta.festa, outraFesta.cliente]), /imutável/);
    await assert.rejects(pool.query("INSERT INTO convite_artes(convite_id,empresa_id,imagem,origem) VALUES($1,$2,$3,'UPLOAD')", [f.id, outra, Buffer.from('x')]), { code: '23503' });
  });
  await check('duas festas concorrentes não ultrapassam último crédito da empresa', async () => {
    const e = await empresa(1), a = await festa(e), b = await festa(e), calls = providerCalls;
    const resultados = await Promise.allSettled([service.comandar(a.acesso, pedido()), service.comandar(b.acesso, pedido())]);
    assert.equal(resultados.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(providerCalls - calls, 1);
    assert.equal((await pool.query('SELECT usado FROM convite_consumos WHERE empresa_id=$1', [e])).rows[0].usado, 1);
    assert.equal(Number((await pool.query('SELECT sum(usado_festa) n FROM convites WHERE empresa_id=$1', [e])).rows[0].n), 1);
  });
  await check('idempotência concorrente reserva e chama provedor uma vez', async () => {
    const f = await festa(await empresa()), p = pedido(), calls = providerCalls;
    await Promise.all([service.comandar(f.acesso, p), service.comandar(f.acesso, p)]);
    assert.equal(providerCalls - calls, 1);
    assert.equal((await pool.query('SELECT usado_festa FROM convites WHERE id=$1', [f.id])).rows[0].usado_festa, 1);
    await assert.rejects(service.comandar(f.acesso, { ...p, prompt: 'Outro pedido com mesma chave' }), /Chave/);
  });
  await check('convite completo: uma chamada com os dados oficiais, persistência como completa e repetição sem nova chamada', async () => {
    const f = await festa(await empresa()), antes = chamadasCompleto.length;
    const p = { acao: 'gerar', chave: uuid(), prompt: 'Jardim de flores coloridas com borboletas', referencias: [], completo: true, estilo: 'cartoon3d' };
    const r = await service.comandar(f.admin, p);
    assert.equal(r.estado, 'CONCLUIDA'); assert.equal(r.completo, true); assert.equal(chamadasCompleto.length - antes, 1);
    const chamada = chamadasCompleto.at(-1);
    assert.match(chamada.prompt, /Criança fictícia/); assert.match(chamada.prompt, /20\/12\/2099/); assert.equal(chamada.refs, 0);
    assert.equal((await service.comandar(f.admin, p)).estado, 'CONCLUIDA'); assert.equal(chamadasCompleto.length - antes, 1);
    const g = (await pool.query('SELECT estado,modelo,arte_id,reserva_microusd FROM convite_geracoes WHERE id=$1', [p.chave])).rows[0];
    assert.equal(g.estado, 'CONCLUIDA'); assert.equal(g.modelo, 'completo-sintetico-sem-rede'); assert.equal(g.reserva_microusd, '300000');
    await pool.query("INSERT INTO festa_membership_capacidades(id,empresa_id,membership_id,capacidade) VALUES($1,$2,$3,'FESTA_CONSULTAR')", [uuid(), f.empresa, f.admin.sessao.membership]);
    const lido = await service.consultar(f.admin);
    assert.deepEqual(lido.artes.map(a => [a.id, a.completo]), [[g.arte_id, true]]);
    await pool.query('UPDATE convites SET rascunho=jsonb_set(rascunho,\'{nome}\',\'"Outro nome"\') WHERE id=$1', [f.id]);
    await assert.rejects(service.comandar(f.admin, p), /Chave/); assert.equal(chamadasCompleto.length - antes, 1);
  });
  await check('convite completo: conflito de nome ou idade é recusado antes da reserva, sem créditos nem chamada', async () => {
    const f = await festa(await empresa()), antes = chamadasCompleto.length;
    for (const prompt of ['Convite da Joana com 7 anos no jardim', 'Festa de 9 anos com dinossauros']) {
      await assert.rejects(service.comandar(f.acesso, { acao: 'gerar', chave: uuid(), prompt, referencias: [], completo: true, estilo: 'cartoon2d' }), e => e.status === 409 || /divergem/.test(e.message));
    }
    assert.equal(chamadasCompleto.length - antes, 0);
    const row = (await pool.query('SELECT usado_festa,usado_cliente FROM convites WHERE id=$1', [f.id])).rows[0];
    assert.equal(row.usado_festa, 0); assert.equal(row.usado_cliente, 0);
    assert.equal(Number((await pool.query('SELECT count(*) n FROM convite_geracoes WHERE convite_id=$1', [f.id])).rows[0].n), 0);
  });
  await check('limite individual protege saldo restante da festa', async () => {
    const f = await festa(await empresa()), calls = providerCalls;
    await pool.query('UPDATE convites SET limite_cliente=1 WHERE id=$1', [f.id]);
    await service.comandar(f.acesso, pedido());
    await assert.rejects(service.comandar(f.acesso, pedido()), /Seu limite/);
    assert.equal(providerCalls - calls, 1);
    const row = (await pool.query('SELECT usado_festa,usado_cliente FROM convites WHERE id=$1', [f.id])).rows[0];
    assert.equal(row.usado_festa, 1); assert.equal(row.usado_cliente, 1);
  });
  await check('timeout preserva reserva e repetição não chama provedor', async () => {
    const f = await festa(await empresa()), p = pedido(), calls = providerCalls;
    failProvider = true;
    try { await assert.rejects(service.comandar(f.acesso, p), /crédito ficou reservado/); }
    finally { failProvider = false; }
    assert.equal((await service.comandar(f.acesso, p)).estado, 'INCERTA');
    assert.equal(providerCalls - calls, 1);
    assert.equal((await pool.query('SELECT usado FROM convite_consumos WHERE empresa_id=$1', [f.empresa])).rows[0].usado, 1);
  });
  await check('teto global concorrente limita duas empresas e rollback não consome cotas', async () => {
    await pool.query('DELETE FROM convite_orcamento_global'); // Exclusivamente no banco sintético validado.
    env.CONVITES_IA_TETO_DIARIO_MICROUSD = '300000';
    const a = await festa(await empresa()), b = await festa(await empresa()), calls = providerCalls;
    try {
      const resultados = await Promise.allSettled([service.comandar(a.acesso, pedido()), service.comandar(b.acesso, pedido())]);
      assert.equal(resultados.filter(r => r.status === 'fulfilled').length, 1); assert.equal(providerCalls - calls, 1);
      assert.equal(Number((await pool.query('SELECT sum(usado_festa) n FROM convites WHERE id=ANY($1::uuid[])', [[a.id, b.id]])).rows[0].n), 1);
      assert.equal((await pool.query('SELECT reservado_microusd FROM convite_orcamento_global')).rows[0].reservado_microusd, '300000');
    } finally { env.CONVITES_IA_TETO_DIARIO_MICROUSD = '100000000'; }
  });
  await check('publicação, RSVP idempotente, mudança contratual e cancelamento', async () => {
    const f = await festa(await empresa());
    await service.comandar(f.acesso, { acao: 'publicar', revisao: 1, conteudo });
    const resposta = { chave: uuid(), nome: 'Família fictícia', presenca: true, adultos: 2, criancas: 1 };
    await service.confirmar(f.publico, resposta);
    await service.confirmar(f.publico, { ...resposta, presenca: false });
    const rows = (await pool.query('SELECT * FROM convite_respostas WHERE convite_id=$1', [f.id])).rows;
    assert.equal(rows.length, 1); assert.equal(rows[0].adultos, 0); assert.equal(rows[0].criancas, 0);
    const nova = uuid(); await pool.query("INSERT INTO contrato_versoes VALUES($1,'ASSINADA',2,'{}')", [nova]);
    await pool.query('UPDATE contrato_fluxos SET versao_vigente_id=$2 WHERE contrato_id=$1', [f.contrato, nova]);
    await assert.rejects(service.publico(f.publico), /indisponível/);
    await service.comandar(f.acesso, { acao: 'publicar', revisao: 2, conteudo });
    await service.publico(f.publico);
    await pool.query("UPDATE contratos SET status='CANCELADO' WHERE id=$1", [f.contrato]);
    await assert.rejects(service.publico(f.publico), /indisponível/);
    await assert.rejects(service.comandar(f.acesso, pedido()), /não está disponível/);
  });
  await check('RSVP revalida data publicada após esperar transação', async () => {
    const f = await festa(await empresa());
    await service.comandar(f.acesso, { acao: 'publicar', revisao: 1, conteudo });
    beforeTransaction = () => pool.query('UPDATE convites SET publicado=$2 WHERE id=$1', [f.id, { ...conteudo, data: '2000-01-01' }]);
    await assert.rejects(service.confirmar(f.publico, { chave: uuid(), nome: 'Convidado fictício', presenca: true, adultos: 1, criancas: 0 }), /encerradas/);
    assert.equal(Number((await pool.query('SELECT count(*) n FROM convite_respostas WHERE convite_id=$1', [f.id])).rows[0].n), 0);
  });
  const report = { ok: true, checks, escopo: 'PostgreSQL 18 descartável; 073/074/079; schema anterior mínimo; tenant/paywall/IA simulados; sem rede externa' };
  fs.writeFileSync(path.join(cluster, 'resultado-convites.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
run().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => pool.end());
