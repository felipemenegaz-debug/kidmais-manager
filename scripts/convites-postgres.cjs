/* eslint-disable @typescript-eslint/no-require-imports */
// PostgreSQL real para as migrations 073/074 e serviço de convites. Dependências prévias
// usam schema mínimo sintético; tenant/paywall/provedor são substituídos explicitamente.
// Não substitui homologação sobre a cadeia completa de migrations do produto.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const crypto = require('node:crypto'), ts = require('typescript');
const { Pool } = require('pg');
const root = path.resolve(__dirname, '..');
if (process.argv[2] !== '--executar-autorizado' || !process.argv[3] || process.argv[4] !== '--incluir-074-autorizado' || process.argv[5] !== '--incluir-079-autorizado' || process.argv[6] !== '--incluir-084-autorizado') {
  console.log('PREPARADO, NÃO EXECUTADO. Migrations 073/074/079/084 exigem autorização própria; usar testar-convites-postgres.ps1 -Executar -Incluir074 -Incluir079 -Incluir084 após autorização.');
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
  vm.runInNewContext(`(function(require,module,exports){${js}\n})`, { process: { env }, Buffer, Date, Intl, setTimeout, console, fetch: fetchSintetico })(name => {
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
let providerCalls = 0, failProvider = false, failModeracao = false, beforeTransaction = null;
// 084: provedor sintético por HTTP simulado. `enviosProvedor` conta requisições que de fato "saíram" pelo `enviar`
// do serviço (marcador enviado_em gravado antes); `portao` segura a resposta para simular abas/recargas concorrentes.
let enviosProvedor = 0, portao = null, falharAntesDoEnvio = false, falharReprocesso = false, falharTransacoes = 0, imagemInvalida = false, ultimoCabecalho = null, aoEnviar = null, antesDoEnvio = null;
async function fetchSintetico(_url, init) {
  enviosProvedor++; ultimoCabecalho = { ...init.headers };
  if (aoEnviar) { const h = aoEnviar; aoEnviar = null; h(); }
  if (portao) await portao;
  if (failProvider) throw Object.assign(Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  const corpo = failModeracao ? { error: { code: 'moderation_blocked' } } : { data: [{ b64_json: Buffer.from('imagem-recebida').toString('base64') }], usage: { output_tokens: 7 } };
  const r = { ok: !failModeracao, status: failModeracao ? 400 : 200, clone: () => r, json: async () => corpo };
  return r;
}
async function provedorSintetico(enviar, imagem) {
  if (falharAntesDoEnvio) throw new FalhaSintetica('pedido_nao_montado');
  if (antesDoEnvio) { const h = antesDoEnvio; antesDoEnvio = null; await h(); }
  let r;
  try { r = await enviar('https://api.openai.com/v1/images/generations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); }
  catch { throw new FalhaSintetica('rede_ou_timeout'); }
  if (!r.ok) throw new FalhaSintetica('http_400_moderation_blocked', { requestId: 'req_sintetico_1', etapa: 'input', categorias: ['sexual', 'PRIVADO'] });
  if (imagemInvalida) throw new FalhaSintetica('resposta_imagem_invalida');
  return { imagem, uso: { output_tokens: 7 } };
}
// Mesmo formato do erro do adaptador: diagnóstico + detalhes já extraídos da resposta do provedor.
class FalhaSintetica extends Error { constructor(diagnostico, detalhes) { super('Falha no provedor de imagem.'); this.diagnostico = diagnostico; this.detalhes = detalhes; } }
// Convite completo (V1): provedor sintético sem rede; registra cada chamada para provar que não há repetição automática.
const chamadasCompleto = [];
async function transaction(fn) {
  if (beforeTransaction) { const hook = beforeTransaction; beforeTransaction = null; await hook(); }
  if (falharTransacoes > 0) { falharTransacoes--; throw new Error('falha simulada de transação (banco indisponível)'); }
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
    FalhaProvedorImagem: FalhaSintetica, modeloImagem: () => 'provedor-sintetico-sem-rede',
    MODELO_COMPLETO: 'completo-sintetico-sem-rede', QUALIDADE_COMPLETO: 'sintetica', completoDisponivel: () => true,
    armazenarConviteCompleto: async png => png,
    imagemDaResposta: (_url, corpo) => typeof corpo?.data?.[0]?.b64_json === 'string' ? Buffer.from(corpo.data[0].b64_json, 'base64') : null,
    processarImagemRecebida: async bytes => { if (falharReprocesso) throw Error('imagem guardada inválida'); return Buffer.concat([Buffer.from('reprocessada:'), bytes]); },
    gerarConviteCompletoOpenAI: async (prompt, enviar, _env, qualidade, refs) => {
      chamadasCompleto.push({ prompt, qualidade, refs: refs.length }); return provedorSintetico(enviar, Buffer.from('convite-completo-sintetico')); },
    normalizarImagem: async () => Buffer.from('arte-sintetica'),
    gerarImagem: async (_prompt, _refs, enviar) => { providerCalls++; return provedorSintetico(enviar, Buffer.from('arte-sintetica')); } },
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
  await pool.query(`CREATE TABLE empresas(id uuid PRIMARY KEY,status text NOT NULL,nome text NOT NULL DEFAULT 'Empresa sintética');
    CREATE TABLE usuarios_administrativos(id uuid PRIMARY KEY,nome text NOT NULL DEFAULT 'Operador sintético',ativo boolean NOT NULL DEFAULT true);
    CREATE TABLE plataforma_desenvolvedores(id uuid PRIMARY KEY,usuario_id uuid NOT NULL REFERENCES usuarios_administrativos,revogado_em timestamptz);
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
  await check('migration 084 (depois da 079) passa precheck, aplica sem alterar gerações, passa postcheck e recusa reaplicação', async () => {
    // Geração INCERTA anterior (como a 2c911441… real): a 084 não pode tocá-la.
    const legado = await festa(await empresa()), chaveLegada = await incerta(legado);
    const linha = sql => pool.query(`SELECT id,estado,ator,payload_hash,arte_id,modelo,reserva_microusd,resolucao_resultado,criado_em FROM convite_geracoes WHERE id=$1`, [chaveLegada]).then(r => JSON.stringify(r.rows[0]) + sql);
    const antes = await linha('');
    await pool.query(fs.readFileSync(path.join(root, 'database/checks/20261018_084_precheck.sql'), 'utf8'));
    await pool.query(fs.readFileSync(path.join(root, 'database/migrations/20261018_084_convite_geracao_pendencias.sql'), 'utf8'));
    await pool.query(fs.readFileSync(path.join(root, 'database/checks/20261018_084_postcheck.sql'), 'utf8'));
    assert.equal(await linha(''), antes);
    const novas = (await pool.query('SELECT enviado_em,recebido_em,resultado_pendente,falha_classe,falha_diagnostico,falha_detalhes FROM convite_geracoes WHERE id=$1', [chaveLegada])).rows[0];
    assert.deepEqual(Object.values(novas), [null, null, null, null, null, null]);
    assert.equal((await pool.query('SELECT etapas_registradas FROM convite_geracoes WHERE id=$1', [chaveLegada])).rows[0].etapas_registradas, false);
    // Linha antiga (sem marcador) nunca pode virar NAO_ENVIADA nem receber etapas.
    await assert.rejects(pool.query("UPDATE convite_geracoes SET estado='NAO_ENVIADA',falha_classe='PRE_ENVIO' WHERE id=$1", [chaveLegada]), { code: '23514' });
    await assert.rejects(pool.query('UPDATE convite_geracoes SET enviado_em=now() WHERE id=$1', [chaveLegada]), { code: '23514' });
    // A constraint amarra NAO_ENVIADA a "sem envio" e à classe PRE_ENVIO.
    await assert.rejects(pool.query("UPDATE convite_geracoes SET estado='NAO_ENVIADA',falha_classe='PRE_ENVIO',enviado_em=now() WHERE id=$1", [chaveLegada]), { code: '23514' });
    await assert.rejects(pool.query("UPDATE convite_geracoes SET falha_classe='PRE_ENVIO' WHERE id=$1", [chaveLegada]), { code: '23514' });
    await assert.rejects(pool.query("UPDATE convite_geracoes SET falha_diagnostico='image[]' WHERE id=$1", [chaveLegada]), { code: '23514' });
    await assert.rejects(pool.query(fs.readFileSync(path.join(root, 'database/checks/20261018_084_precheck.sql'), 'utf8')), /aplicação anterior ou parcial/);
    await assert.rejects(pool.query(fs.readFileSync(path.join(root, 'database/migrations/20261018_084_convite_geracao_pendencias.sql'), 'utf8')), /precheck falhou/);
  });
  await check('rollback 084 funciona antes de qualquer etapa registrada e a 084 pode ser reaplicada', async () => {
    await pool.query(fs.readFileSync(path.join(root, 'database/rollback/20261018_084_convite_geracao_pendencias_down.sql'), 'utf8'));
    assert.equal((await pool.query("SELECT count(*) n FROM information_schema.columns WHERE table_schema='public' AND table_name='convite_geracoes' AND column_name='enviado_em'")).rows[0].n, '0');
    await pool.query(fs.readFileSync(path.join(root, 'database/checks/20261018_084_precheck.sql'), 'utf8'));
    await pool.query(fs.readFileSync(path.join(root, 'database/migrations/20261018_084_convite_geracao_pendencias.sql'), 'utf8'));
    await pool.query(fs.readFileSync(path.join(root, 'database/checks/20261018_084_postcheck.sql'), 'utf8'));
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
  // Decisão financeira só do operador da plataforma (painel do desenvolvedor), na transação real.
  const operadorPlataforma = uuid();
  await pool.query('INSERT INTO usuarios_administrativos(id) VALUES($1)', [operadorPlataforma]);
  const decidir = (geracaoId, resultado, evidencia = evidenciaRecuperacao) => transaction(tx => service.resolverGeracaoIncerta(tx, operadorPlataforma, { geracaoId, resultado, evidencia }));
  const orcamentoHoje = async () => BigInt((await pool.query("SELECT reservado_microusd FROM convite_orcamento_global WHERE dia=(now() AT TIME ZONE 'America/Sao_Paulo')::date")).rows[0].reservado_microusd);
  await check('recuperação PostgreSQL (operador): cobrança confirmada mantém créditos e grava evidência', async () => {
    const f = await festa(await empresa()), chave = await incerta(f);
    const r = await decidir(chave, 'COBRANCA_CONFIRMADA');
    assert.equal(r.estado, 'RESOLVIDA_COBRADA'); assert.equal(r.liberouReserva, false);
    const g = (await pool.query('SELECT estado,resolucao_resultado,resolucao_por,resolucao_evidencia FROM convite_geracoes WHERE id=$1', [chave])).rows[0];
    assert.equal(g.estado, 'RESOLVIDA_COBRADA'); assert.equal(g.resolucao_resultado, 'COBRANCA_CONFIRMADA');
    assert.equal(g.resolucao_por, operadorPlataforma); assert.equal(g.resolucao_evidencia, evidenciaRecuperacao);
    assert.equal((await pool.query('SELECT usado_festa,usado_cliente FROM convites WHERE id=$1', [f.id])).rows[0].usado_festa, 1);
    assert.equal((await pool.query('SELECT usado FROM convite_consumos WHERE empresa_id=$1', [f.empresa])).rows[0].usado, 1);
    const ev = (await pool.query("SELECT ator,detalhe FROM convite_eventos WHERE convite_id=$1 AND acao='IA_RECUPERACAO_MANUAL'", [f.id])).rows;
    assert.equal(ev.length, 1); assert.equal(ev[0].ator, `OPERADOR:${operadorPlataforma}`); assert.ok(!JSON.stringify(ev[0].detalhe).includes('Verificado no painel'));
  });
  await check('recuperação PostgreSQL (operador): sem cobrança devolve mensal, festa, cliente e diária exatamente uma vez', async () => {
    const f = await festa(await empresa()), chave = await incerta(f);
    const orcamentoAntes = await orcamentoHoje();
    const r = await decidir(chave, 'SEM_COBRANCA');
    assert.equal(r.estado, 'RESOLVIDA_SEM_COBRANCA'); assert.equal(r.liberouReserva, true);
    const c = (await pool.query('SELECT usado_festa,usado_cliente FROM convites WHERE id=$1', [f.id])).rows[0];
    assert.equal(c.usado_festa, 0); assert.equal(c.usado_cliente, 0);
    assert.equal((await pool.query('SELECT usado FROM convite_consumos WHERE empresa_id=$1', [f.empresa])).rows[0].usado, 0);
    assert.equal(await orcamentoHoje(), orcamentoAntes - 300000n);
    await assert.rejects(decidir(chave, 'SEM_COBRANCA'), /já foi resolvida/);
    assert.equal(await orcamentoHoje(), orcamentoAntes - 300000n);
    assert.equal((await pool.query("SELECT count(*) n FROM convite_eventos WHERE convite_id=$1 AND acao='IA_RECUPERACAO_MANUAL'", [f.id])).rows[0].n, '1');
  });
  await check('recuperação PostgreSQL (operador): repetição concorrente de sem cobrança devolve uma vez', async () => {
    const f = await festa(await empresa()), chave = await incerta(f);
    const orcamentoAntes = await orcamentoHoje();
    const decisoes = await Promise.allSettled([decidir(chave, 'SEM_COBRANCA'), decidir(chave, 'SEM_COBRANCA'), decidir(chave, 'SEM_COBRANCA')]);
    assert.equal(decisoes.filter(x => x.status === 'fulfilled').length, 1);
    assert.equal((await pool.query('SELECT usado_festa FROM convites WHERE id=$1', [f.id])).rows[0].usado_festa, 0);
    assert.equal((await pool.query('SELECT usado FROM convite_consumos WHERE empresa_id=$1', [f.empresa])).rows[0].usado, 0);
    assert.equal(await orcamentoHoje(), orcamentoAntes - 300000n);
    assert.equal((await pool.query("SELECT count(*) n FROM convite_eventos WHERE convite_id=$1 AND acao='IA_RECUPERACAO_MANUAL'", [f.id])).rows[0].n, '1');
  });
  await check('recuperação PostgreSQL (operador): decisões conflitantes concorrentes só podem vencer uma vez', async () => {
    const f = await festa(await empresa()), chave = await incerta(f);
    const orcamentoAntes = await orcamentoHoje();
    const decisoes = await Promise.allSettled([decidir(chave, 'SEM_COBRANCA'), decidir(chave, 'COBRANCA_CONFIRMADA')]);
    assert.equal(decisoes.filter(x => x.status === 'fulfilled').length, 1);
    const estado = (await pool.query('SELECT estado FROM convite_geracoes WHERE id=$1', [chave])).rows[0].estado;
    const devolvida = estado === 'RESOLVIDA_SEM_COBRANCA';
    assert.equal((await pool.query('SELECT usado_festa FROM convites WHERE id=$1', [f.id])).rows[0].usado_festa, devolvida ? 0 : 1);
    assert.equal((await pool.query('SELECT usado FROM convite_consumos WHERE empresa_id=$1', [f.empresa])).rows[0].usado, devolvida ? 0 : 1);
    assert.equal(await orcamentoHoje(), devolvida ? orcamentoAntes - 300000n : orcamentoAntes);
    assert.equal((await pool.query("SELECT count(*) n FROM convite_eventos WHERE convite_id=$1 AND acao='IA_RECUPERACAO_MANUAL'", [f.id])).rows[0].n, '1');
  });
  await check('recuperação PostgreSQL: buffet e cliente não decidem; evidência curta recusada; falha de devolução reverte tudo', async () => {
    const f = await festa(await empresa()), chave = await incerta(f);
    const orcamentoAntes = await orcamentoHoje();
    for (const acesso of [f.admin, f.acesso])
      await assert.rejects(service.comandar(acesso, { acao: 'recuperar', chave, resultado: 'SEM_COBRANCA', evidencia: evidenciaRecuperacao }), e => e.name === 'ZodError');
    await assert.rejects(decidir(chave, 'SEM_COBRANCA', 'curta'), e => e.name === 'ZodError');
    await pool.query('DELETE FROM convite_consumos WHERE empresa_id=$1', [f.empresa]);
    await assert.rejects(decidir(chave, 'SEM_COBRANCA'), /reserva mensal original/);
    assert.equal((await pool.query('SELECT estado FROM convite_geracoes WHERE id=$1', [chave])).rows[0].estado, 'INCERTA');
    assert.equal((await pool.query('SELECT usado_festa,usado_cliente FROM convites WHERE id=$1', [f.id])).rows[0].usado_festa, 1);
    assert.equal(await orcamentoHoje(), orcamentoAntes);
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
  await check('timeout depois do envio: reserva mantida, classe DESCONHECIDA, "verificando" e repetição sem nova chamada', async () => {
    const f = await festa(await empresa()), p = pedido(), calls = providerCalls, envios = enviosProvedor;
    failProvider = true;
    try { const r = await service.comandar(f.acesso, p); assert.equal(r.estado, 'VERIFICANDO'); assert.match(r.mensagem, /Você não precisa tentar novamente/); }
    finally { failProvider = false; }
    const g = (await pool.query('SELECT estado,falha_classe,falha_diagnostico,enviado_em FROM convite_geracoes WHERE id=$1', [p.chave])).rows[0];
    assert.equal(g.estado, 'INCERTA'); assert.equal(g.falha_classe, 'DESCONHECIDA'); assert.equal(g.falha_diagnostico, 'rede_ou_timeout'); assert.ok(g.enviado_em);
    assert.equal((await service.comandar(f.acesso, p)).estado, 'VERIFICANDO');
    assert.equal(providerCalls - calls, 1); assert.equal(enviosProvedor - envios, 1);
    assert.equal((await pool.query('SELECT usado FROM convite_consumos WHERE empresa_id=$1', [f.empresa])).rows[0].usado, 1);
    assert.equal(ultimoCabecalho['X-Client-Request-Id'], p.chave);
  });
  await check('moderação: classe RESPOSTA_PROVEDOR, evidência sanitizada na geração e no evento, sem nova chamada nem devolução', async () => {
    const f = await festa(await empresa()), p = pedido(), calls = providerCalls;
    failModeracao = true;
    try { assert.equal((await service.comandar(f.acesso, p)).estado, 'VERIFICANDO'); }
    finally { failModeracao = false; }
    const g = (await pool.query('SELECT estado,falha_classe,falha_diagnostico,falha_detalhes FROM convite_geracoes WHERE id=$1', [p.chave])).rows[0];
    assert.equal(g.estado, 'INCERTA'); assert.equal(g.falha_classe, 'RESPOSTA_PROVEDOR'); assert.equal(g.falha_diagnostico, 'http_400_moderation_blocked');
    assert.deepEqual(g.falha_detalhes, { requestId: 'req_sintetico_1', etapa: 'input', categorias: ['sexual'] });
    const ev = (await pool.query("SELECT detalhe FROM convite_eventos WHERE convite_id=$1 AND acao='IA_INCERTA'", [f.id])).rows;
    assert.equal(ev.length, 1);
    assert.deepEqual(ev[0].detalhe, { geracao: p.chave, diagnostico: 'http_400_moderation_blocked', classe: 'RESPOSTA_PROVEDOR', requestId: 'req_sintetico_1', etapa: 'input', categorias: ['sexual'] });
    assert.equal((await service.comandar(f.acesso, p)).estado, 'VERIFICANDO'); assert.equal(providerCalls - calls, 1);
    await assert.rejects(service.comandar(f.acesso, pedido()), /verificando a geração anterior/);
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
  // --- 084: chamada única, persistência, reinício e fila do operador, com travas e constraints reais -------------
  const esperarEnvio = async (base) => { for (let i = 0; i < 300 && enviosProvedor === base; i++) await new Promise(r => setTimeout(r, 10)); };
  const consumoMes = async empresaId => Number((await pool.query('SELECT COALESCE(sum(usado),0) n FROM convite_consumos WHERE empresa_id=$1', [empresaId])).rows[0].n);
  const orcamentoDia = async () => BigInt((await pool.query('SELECT COALESCE(sum(reservado_microusd),0)::bigint n FROM convite_orcamento_global')).rows[0].n);
  await check('chamada única: clique duplo em paralelo e outra aba durante o envio fazem 1 envio, 1 reserva e acompanham a mesma geração', async () => {
    const f = await festa(await empresa()), p = pedido(), envios = enviosProvedor;
    let abrir; portao = new Promise(r => { abrir = r; });
    const duplas = Promise.all([service.comandar(f.acesso, p), service.comandar(f.acesso, p)]);
    await esperarEnvio(envios);
    assert.equal(enviosProvedor - envios, 1);
    const outraAba = await service.comandar(f.acesso, pedido());
    assert.equal(outraAba.acompanhando, true); assert.equal(outraAba.chave, p.chave); assert.equal(outraAba.estado, 'EM_ANDAMENTO');
    assert.equal((await service.situacaoGeracao(f.acesso, p.chave)).estado, 'EM_ANDAMENTO');
    assert.equal((await service.consultar(f.acesso)).geracaoEmAndamento, p.chave);
    portao = null; abrir();
    const [a, b] = await duplas;
    const [nova, repetida] = a.repetida ? [b, a] : [a, b];
    assert.equal(nova.estado, 'CONCLUIDA'); assert.equal(repetida.repetida, true);
    assert.equal(enviosProvedor - envios, 1);
    assert.equal(Number((await pool.query('SELECT count(*) n FROM convite_geracoes WHERE convite_id=$1', [f.id])).rows[0].n), 1);
    assert.equal(Number((await pool.query('SELECT count(*) n FROM convite_artes WHERE convite_id=$1', [f.id])).rows[0].n), 1);
    assert.equal((await pool.query('SELECT usado_festa FROM convites WHERE id=$1', [f.id])).rows[0].usado_festa, 1);
    assert.equal(await consumoMes(f.empresa), 1);
    const g = (await pool.query('SELECT enviado_em,recebido_em,resultado_pendente FROM convite_geracoes WHERE id=$1', [p.chave])).rows[0];
    assert.ok(g.enviado_em && g.recebido_em); assert.equal(g.resultado_pendente, null);
  });
  await check('reconexão e recarga: arte salva e resposta perdida; situação e a mesma chave devolvem a arte sem nova chamada', async () => {
    const f = await festa(await empresa()), p = pedido(), envios = enviosProvedor;
    const original = await service.comandar(f.acesso, p); // resposta "perdida" no navegador
    const s = await service.situacaoGeracao(f.acesso, p.chave);
    assert.equal(s.estado, 'CONCLUIDA'); assert.equal(s.arteId, original.arteId);
    const repetida = await service.comandar(f.acesso, p);
    assert.equal(repetida.estado, 'CONCLUIDA'); assert.equal(repetida.arteId, original.arteId);
    await assert.rejects(service.situacaoGeracao(f.acesso, uuid()), e => e.status === 404);
    // Outra festa não enxerga a geração.
    const outra = await festa(await empresa());
    await assert.rejects(service.situacaoGeracao(outra.acesso, p.chave), e => e.status === 404);
    assert.equal(enviosProvedor - envios, 1); assert.equal(await consumoMes(f.empresa), 1);
  });
  await check('queda antes do envio: NAO_ENVIADA, devolução exata de festa, cliente, mês e dia, e evento; nada sai para o provedor', async () => {
    const f = await festa(await empresa()), p = pedido(), envios = enviosProvedor, orcamento = await orcamentoDia();
    falharAntesDoEnvio = true;
    try { await assert.rejects(service.comandar(f.acesso, p), e => e.status === 503 && /Nenhum crédito foi usado/.test(e.message)); }
    finally { falharAntesDoEnvio = false; }
    const g = (await pool.query('SELECT estado,falha_classe,enviado_em FROM convite_geracoes WHERE id=$1', [p.chave])).rows[0];
    assert.equal(g.estado, 'NAO_ENVIADA'); assert.equal(g.falha_classe, 'PRE_ENVIO'); assert.equal(g.enviado_em, null);
    const c = (await pool.query('SELECT usado_festa,usado_cliente FROM convites WHERE id=$1', [f.id])).rows[0];
    assert.equal(c.usado_festa, 0); assert.equal(c.usado_cliente, 0); assert.equal(await consumoMes(f.empresa), 0);
    assert.equal(await orcamentoDia(), orcamento);
    assert.equal(Number((await pool.query("SELECT count(*) n FROM convite_eventos WHERE convite_id=$1 AND acao='IA_NAO_ENVIADA'", [f.id])).rows[0].n), 1);
    assert.equal((await service.comandar(f.acesso, p)).estado, 'NAO_INICIADA');
    assert.equal(enviosProvedor - envios, 0); assert.equal(await consumoMes(f.empresa), 0);
    // Nova tentativa (nova chave) segue normalmente.
    assert.equal((await service.comandar(f.acesso, pedido())).estado, 'CONCLUIDA'); assert.equal(enviosProvedor - envios, 1);
  });
  await check('imagem guardada e gravação da arte falhando (banco): resposta EM_ANDAMENTO e a próxima leitura conclui sem nova chamada', async () => {
    const f = await festa(await empresa()), p = pedido(), envios = enviosProvedor;
    aoEnviar = () => { falharTransacoes = 3; };
    const r = await service.comandar(f.acesso, p);
    assert.equal(r.estado, 'EM_ANDAMENTO'); assert.equal(falharTransacoes, 0);
    const antes = (await pool.query('SELECT estado,recebido_em,resultado_pendente,uso FROM convite_geracoes WHERE id=$1', [p.chave])).rows[0];
    assert.equal(antes.estado, 'RESERVADA'); assert.ok(antes.recebido_em); assert.equal(antes.resultado_pendente.toString(), 'imagem-recebida');
    assert.deepEqual(antes.uso, { output_tokens: 7 });
    assert.equal((await service.consultar(f.acesso)).geracaoEmAndamento, p.chave, 'imagem recém-guardada: a geração em curso ainda pode gravar');
    await pool.query("UPDATE convite_geracoes SET recebido_em=now()-interval '1 minute' WHERE id=$1", [p.chave]);
    const d = await service.consultar(f.acesso);
    assert.equal(d.geracaoEmAndamento, null); assert.equal(d.artes.length, 1);
    const g = (await pool.query('SELECT estado,arte_id,resultado_pendente FROM convite_geracoes WHERE id=$1', [p.chave])).rows[0];
    assert.equal(g.estado, 'CONCLUIDA'); assert.equal(g.resultado_pendente, null);
    assert.equal((await pool.query('SELECT imagem FROM convite_artes WHERE id=$1', [g.arte_id])).rows[0].imagem.toString(), 'reprocessada:imagem-recebida');
    const ev = (await pool.query("SELECT ator,detalhe FROM convite_eventos WHERE convite_id=$1 AND acao='IA_CONCLUIDA'", [f.id])).rows;
    assert.equal(ev.length, 1); assert.equal(ev[0].ator, 'SISTEMA:reconciliacao'); assert.equal(ev[0].detalhe.recuperada, true);
    assert.equal(enviosProvedor - envios, 1); assert.equal(await consumoMes(f.empresa), 1);
  });
  await check('imagem recebida inválida: ARMAZENAMENTO, imagem retida, crédito mantido e festa protegida', async () => {
    const f = await festa(await empresa()), p = pedido(), envios = enviosProvedor;
    imagemInvalida = true;
    try { assert.equal((await service.comandar(f.acesso, p)).estado, 'VERIFICANDO'); }
    finally { imagemInvalida = false; }
    const g = (await pool.query('SELECT estado,falha_classe,resultado_pendente FROM convite_geracoes WHERE id=$1', [p.chave])).rows[0];
    assert.equal(g.estado, 'INCERTA'); assert.equal(g.falha_classe, 'ARMAZENAMENTO'); assert.ok(g.resultado_pendente);
    await assert.rejects(service.comandar(f.acesso, pedido()), /verificando a geração anterior/);
    assert.equal(enviosProvedor - envios, 1); assert.equal(await consumoMes(f.empresa), 1);
  });
  // Reserva deixada por um processo que reiniciou (sem passar pelo serviço), com os contadores coerentes.
  async function reservaInterrompida(f, { criado, enviado = null, imagem = null, etapas = true }) {
    const chave = uuid();
    await pool.query('UPDATE convites SET usado_festa=usado_festa+1,usado_cliente=usado_cliente+1 WHERE id=$1', [f.id]);
    await pool.query(`INSERT INTO convite_consumos(empresa_id,mes,usado) VALUES($1,date_trunc('month',(now()-$2::interval) AT TIME ZONE 'America/Sao_Paulo')::date,1)
      ON CONFLICT(empresa_id,mes) DO UPDATE SET usado=convite_consumos.usado+1`, [f.empresa, criado]);
    await pool.query(`INSERT INTO convite_orcamento_global(dia,reservado_microusd) VALUES(((now()-$1::interval) AT TIME ZONE 'America/Sao_Paulo')::date,300000)
      ON CONFLICT(dia) DO UPDATE SET reservado_microusd=convite_orcamento_global.reservado_microusd+300000`, [criado]);
    await pool.query(`INSERT INTO convite_geracoes(id,convite_id,empresa_id,ator,payload_hash,modelo,criado_em,enviado_em,recebido_em,resultado_pendente,etapas_registradas)
      VALUES($1,$2,$3,$4,'hash-reinicio','provedor-sintetico-sem-rede',now()-$5::interval,CASE WHEN $6::text IS NULL THEN NULL ELSE now()-$6::interval END,
        CASE WHEN $7::bytea IS NULL THEN NULL ELSE now()-interval '1 minute' END,$7,$8)`, [chave, f.id, f.empresa, `CLIENTE:${f.cliente}`, criado, enviado, imagem, etapas]);
    return chave;
  }
  await check('reinício com geração em andamento: sem envio → devolve; recente → acompanha; enviada há 11 min → verificação; imagem guardada → arte', async () => {
    const envios = enviosProvedor;
    const a = await festa(await empresa()), orcamento = await orcamentoDia();
    const semEnvio = await reservaInterrompida(a, { criado: '3 minutes' });
    assert.equal(await orcamentoDia(), orcamento + 300000n);
    assert.equal((await service.consultar(a.acesso)).geracaoEmAndamento, null);
    const ga = (await pool.query('SELECT estado,falha_classe,falha_diagnostico FROM convite_geracoes WHERE id=$1', [semEnvio])).rows[0];
    assert.equal(ga.estado, 'NAO_ENVIADA'); assert.equal(ga.falha_diagnostico, 'interrompida_antes_do_envio');
    assert.equal((await pool.query('SELECT usado_festa FROM convites WHERE id=$1', [a.id])).rows[0].usado_festa, 0);
    assert.equal(await consumoMes(a.empresa), 0); assert.equal(await orcamentoDia(), orcamento);
    assert.equal((await pool.query("SELECT ator FROM convite_eventos WHERE convite_id=$1 AND acao='IA_NAO_ENVIADA'", [a.id])).rows[0].ator, 'SISTEMA:reconciliacao');

    const b = await festa(await empresa()), recente = await reservaInterrompida(b, { criado: '1 minute' });
    assert.equal((await service.consultar(b.acesso)).geracaoEmAndamento, recente);
    const acompanha = await service.comandar(b.acesso, pedido());
    assert.equal(acompanha.acompanhando, true); assert.equal(acompanha.chave, recente);

    const c = await festa(await empresa()), enviada = await reservaInterrompida(c, { criado: '11 minutes', enviado: '11 minutes' });
    assert.equal((await service.consultar(c.acesso)).geracaoIncerta, true);
    const gc = (await pool.query('SELECT estado,falha_classe FROM convite_geracoes WHERE id=$1', [enviada])).rows[0];
    assert.equal(gc.estado, 'INCERTA'); assert.equal(gc.falha_classe, 'DESCONHECIDA'); assert.equal(await consumoMes(c.empresa), 1);

    const d = await festa(await empresa()), cedo = await reservaInterrompida(d, { criado: '5 minutes', enviado: '5 minutes' });
    assert.equal((await service.consultar(d.acesso)).geracaoEmAndamento, cedo);

    const e = await festa(await empresa()), guardada = await reservaInterrompida(e, { criado: '2 minutes', enviado: '1 minute', imagem: Buffer.from('guardada') });
    assert.equal((await service.situacaoGeracao(e.acesso, guardada)).estado, 'CONCLUIDA');
    assert.equal(await consumoMes(e.empresa), 1);

    // Ninguém abre o convite: a fila do operador reconcilia sozinha.
    const g = await festa(await empresa()), esquecida = await reservaInterrompida(g, { criado: '5 minutes' });
    assert.ok(await service.reconciliarGeracoesParadas() >= 1);
    assert.equal((await pool.query('SELECT estado FROM convite_geracoes WHERE id=$1', [esquecida])).rows[0].estado, 'NAO_ENVIADA');
    assert.equal(await consumoMes(g.empresa), 0);
    assert.equal(enviosProvedor - envios, 0);
  });
  // Fila do operador com o módulo real do painel (concessão e auditoria em tabelas sintéticas mínimas).
  const cachePainel = new Map();
  function carregarPainel(file) {
    const absoluto = path.resolve(file);
    if (cachePainel.has(absoluto)) return cachePainel.get(absoluto);
    const js = ts.transpileModule(fs.readFileSync(absoluto, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const m = { exports: {} }; cachePainel.set(absoluto, m.exports);
    const mocks = { '../convites/domain': domain, '../convites/service': service, './interessadas.ts': { painelDepsPadrao: {} } };
    vm.runInNewContext(`(function(require,module,exports){${js}\n})`, { process: { env }, Buffer, Date, console })(nome => {
      if (Object.hasOwn(mocks, nome)) return mocks[nome];
      if (nome === 'zod') return require('zod');
      if (!nome.startsWith('.')) throw Error(`Dependência não autorizada no teste: ${nome}`);
      const alvo = path.resolve(path.dirname(absoluto), nome);
      return carregarPainel(alvo.endsWith('.ts') ? alvo : `${alvo}.ts`);
    }, m, m.exports);
    cachePainel.set(absoluto, m.exports); return m.exports;
  }
  await check('fila do operador (PostgreSQL real): concessão exigida, evidência sanitizada, tratadas automaticamente e decisão auditada uma vez', async () => {
    const painel = carregarPainel(path.join(root, 'lib/desenvolvedor/convites-geracoes.ts'));
    const operadorPainel = uuid(), semConcessao = uuid();
    await pool.query('INSERT INTO usuarios_administrativos(id,nome) VALUES($1,$2),($3,$4)', [operadorPainel, 'Operador sintético', semConcessao, 'Sem concessão']);
    await pool.query('INSERT INTO plataforma_desenvolvedores(id,usuario_id) VALUES($1,$2)', [uuid(), operadorPainel]);
    const auditoria = [];
    const deps = { withTransaction: transaction, registrarAuditoria: async i => { auditoria.push(i); }, reconciliar: () => service.reconciliarGeracoesParadas(), resolver: service.resolverGeracaoIncerta, concluir: service.concluirGeracaoComImagem };
    const agora = new Date().toISOString(), sessaoOk = { usuario_id: operadorPainel, autenticado_em: agora, consultado_em: agora };
    const ctx = { requestId: 'req-harness', ip: null, userAgent: null };
    await assert.rejects(painel.filaGeracoesConvites({ ...sessaoOk, usuario_id: semConcessao }, deps), e => e.httpStatus === 404);
    // Geração nova em verificação (moderação) para decidir.
    const f = await festa(await empresa()), p = pedido();
    failModeracao = true;
    try { await service.comandar(f.acesso, p); } finally { failModeracao = false; }
    const fila = await painel.filaGeracoesConvites(sessaoOk, deps);
    const item = fila.pendentes.find(x => x.id === p.chave);
    assert.equal(item.classe, 'RESPOSTA_PROVEDOR'); assert.equal(item.origem, 'CLIENTE'); assert.equal(item.diagnostico, 'http_400_moderation_blocked');
    assert.deepEqual(JSON.parse(JSON.stringify(item.evidencia)), { diagnostico: 'http_400_moderation_blocked', requestId: 'req_sintetico_1', etapa: 'input', categorias: ['sexual'] });
    assert.ok(!JSON.stringify(fila).includes('PRIVADO'));
    assert.ok(fila.pendentes.some(x => x.classe === 'SEM_CLASSE'), 'geração anterior à 084 aparece sem classe');
    assert.ok(fila.automaticas.some(x => x.estado === 'NAO_ENVIADA') && fila.automaticas.some(x => x.estado === 'CONCLUIDA'));
    assert.ok(fila.decisoes.length >= 1 && fila.decisoes.every(d => d.resolvedor));
    // O buffet da festa continua vendo só "verificando".
    await pool.query("INSERT INTO festa_membership_capacidades(id,empresa_id,membership_id,capacidade) VALUES($1,$2,$3,'FESTA_CONSULTAR')", [uuid(), f.empresa, f.admin.sessao.membership]);
    const buffet = await service.consultar(f.admin);
    assert.equal(buffet.geracaoIncerta, true); assert.ok(!JSON.stringify(buffet).includes('req_sintetico_1'));
    // Decidir: senha recente obrigatória; depois uma única transição, devolução e auditoria.
    const velho = new Date(Date.now() - 6 * 60_000).toISOString();
    await assert.rejects(painel.resolverGeracaoConvite({ ...sessaoOk, autenticado_em: velho }, { acao: 'decidir', geracaoId: p.chave, resultado: 'SEM_COBRANCA', evidencia: evidenciaRecuperacao }, ctx, deps), e => e.code === 'REAUTENTICACAO');
    const decisoes = await Promise.allSettled([1, 2].map(() => painel.resolverGeracaoConvite(sessaoOk, { acao: 'decidir', geracaoId: p.chave, resultado: 'SEM_COBRANCA', evidencia: evidenciaRecuperacao }, ctx, deps)));
    assert.equal(decisoes.filter(x => x.status === 'fulfilled').length, 1);
    assert.ok(decisoes.some(x => x.status === 'rejected' && x.reason.httpStatus === 409 && x.reason.code === 'CONFLITO'));
    assert.equal(auditoria.filter(a => a.acao === 'CONVITE_GERACAO_RESOLVIDA' && a.entidadeId === p.chave).length, 1);
    assert.equal(await consumoMes(f.empresa), 0);
    assert.equal((await pool.query('SELECT resolucao_por FROM convite_geracoes WHERE id=$1', [p.chave])).rows[0].resolucao_por, operadorPainel);
    assert.ok(!(await painel.filaGeracoesConvites(sessaoOk, deps)).pendentes.some(x => x.id === p.chave));
  });
  // --- Achados da revisão independente, com travas e constraints reais ---------------------------------------------
  await check('reserva do código anterior (sem marcador): nunca devolvida automaticamente; depois de 10 min vai para o operador', async () => {
    const envios = enviosProvedor;
    const a = await festa(await empresa()), orcamento = await orcamentoDia();
    const recente = await reservaInterrompida(a, { criado: '3 minutes', etapas: false });
    assert.equal((await service.consultar(a.acesso)).geracaoEmAndamento, recente);
    assert.equal((await pool.query('SELECT estado FROM convite_geracoes WHERE id=$1', [recente])).rows[0].estado, 'RESERVADA');
    assert.equal(await consumoMes(a.empresa), 1); assert.equal(await orcamentoDia(), orcamento + 300000n);
    const b = await festa(await empresa()), antiga = await reservaInterrompida(b, { criado: '11 minutes', etapas: false });
    assert.equal((await service.consultar(b.acesso)).geracaoIncerta, true);
    const g = (await pool.query('SELECT estado,falha_classe,falha_diagnostico FROM convite_geracoes WHERE id=$1', [antiga])).rows[0];
    assert.equal(g.estado, 'INCERTA'); assert.equal(g.falha_classe, 'DESCONHECIDA'); assert.equal(g.falha_diagnostico, 'legado_sem_registro');
    assert.equal(await consumoMes(b.empresa), 1);
    assert.equal(enviosProvedor - envios, 0);
  });
  await check('devolução automática que não fecha (consumo do mês ausente) vai para o operador como DEVOLUCAO_FALHOU, sem devolução parcial', async () => {
    const f = await festa(await empresa()), chave = await reservaInterrompida(f, { criado: '3 minutes' });
    await pool.query('DELETE FROM convite_consumos WHERE empresa_id=$1', [f.empresa]); // inconsistência sintética
    const orcamento = await orcamentoDia();
    const d = await service.consultar(f.acesso);
    assert.equal(d.geracaoEmAndamento, null); assert.equal(d.geracaoIncerta, true);
    const g = (await pool.query('SELECT estado,falha_classe FROM convite_geracoes WHERE id=$1', [chave])).rows[0];
    assert.equal(g.estado, 'INCERTA'); assert.equal(g.falha_classe, 'DEVOLUCAO_FALHOU');
    assert.equal((await pool.query('SELECT usado_festa FROM convites WHERE id=$1', [f.id])).rows[0].usado_festa, 1, 'savepoint desfez a devolução parcial');
    assert.equal(await orcamentoDia(), orcamento);
  });
  await check('operador conclui com a imagem retida (PostgreSQL real): arte entregue sem chamada, crédito mantido, uma vez só', async () => {
    const f = await festa(await empresa()), p = pedido(), envios = enviosProvedor;
    imagemInvalida = true;
    try { assert.equal((await service.comandar(f.acesso, p)).estado, 'VERIFICANDO'); } finally { imagemInvalida = false; }
    const operadorImagem = uuid();
    await pool.query('INSERT INTO usuarios_administrativos(id) VALUES($1)', [operadorImagem]);
    const concluir = () => transaction(tx => service.concluirGeracaoComImagem(tx, operadorImagem, { geracaoId: p.chave }));
    const r = await Promise.allSettled([concluir(), concluir()]);
    assert.equal(r.filter(x => x.status === 'fulfilled').length, 1);
    const g = (await pool.query('SELECT estado,arte_id,resultado_pendente,falha_classe FROM convite_geracoes WHERE id=$1', [p.chave])).rows[0];
    assert.equal(g.estado, 'CONCLUIDA'); assert.equal(g.resultado_pendente, null); assert.equal(g.falha_classe, 'ARMAZENAMENTO');
    assert.equal((await pool.query('SELECT imagem FROM convite_artes WHERE id=$1', [g.arte_id])).rows[0].imagem.toString(), 'reprocessada:imagem-recebida');
    assert.equal(Number((await pool.query('SELECT count(*) n FROM convite_artes WHERE convite_id=$1', [f.id])).rows[0].n), 1);
    assert.equal(enviosProvedor - envios, 1); assert.equal(await consumoMes(f.empresa), 1);
    assert.equal((await service.situacaoGeracao(f.acesso, p.chave)).estado, 'CONCLUIDA');
  });
  await check('reconciliação travando a linha enquanto o envio tenta marcar enviado_em: o marcador espera, não acha RESERVADA e nada sai', async () => {
    const f = await festa(await empresa()), p = pedido(), envios = enviosProvedor;
    antesDoEnvio = async () => {
      const travador = await pool.connect();
      await travador.query('BEGIN');
      await travador.query('SELECT id FROM convite_geracoes WHERE id=$1 FOR UPDATE', [p.chave]);
      // Simula a reconciliação concluindo NAO_ENVIADA enquanto o marcador aguarda a trava.
      setTimeout(async () => {
        await travador.query("UPDATE convite_geracoes SET estado='NAO_ENVIADA',falha_classe='PRE_ENVIO',falha_diagnostico='reconciliacao_simulada' WHERE id=$1", [p.chave]);
        await travador.query('COMMIT'); travador.release();
      }, 300);
    };
    await assert.rejects(service.comandar(f.acesso, p), e => e.status === 503);
    const g = (await pool.query('SELECT estado,enviado_em FROM convite_geracoes WHERE id=$1', [p.chave])).rows[0];
    assert.equal(g.estado, 'NAO_ENVIADA'); assert.equal(g.enviado_em, null);
    assert.equal(enviosProvedor - envios, 0);
  });
  await check('devolução automática e nova reserva da mesma empresa em paralelo: mesma ordem de travas, sem deadlock', async () => {
    const e = await empresa();
    for (let rodada = 0; rodada < 5; rodada++) {
      const parada = await festa(e), nova = await festa(e);
      await reservaInterrompida(parada, { criado: '3 minutes' });
      const [leitura, geracao] = await Promise.allSettled([service.consultar(parada.acesso), service.comandar(nova.acesso, pedido())]);
      assert.equal(leitura.status, 'fulfilled', leitura.reason?.message); assert.equal(geracao.status, 'fulfilled', geracao.reason?.message);
      assert.equal(geracao.value.estado, 'CONCLUIDA');
    }
  });
  await check('histórico do buffet e do cliente em linguagem simples; sistema e operador aparecem como plataforma', async () => {
    const f = await festa(await empresa()), chave = await reservaInterrompida(f, { criado: '3 minutes' });
    const d = await service.consultar(f.acesso);
    assert.ok(d.historico.some(h => h.acao === 'IA_NAO_INICIADA' && h.ator === 'PLATAFORMA'));
    assert.ok(!d.historico.some(h => ['IA_INCERTA', 'IA_NAO_ENVIADA', 'IA_RECUPERACAO_MANUAL'].includes(h.acao) || ['SISTEMA', 'OPERADOR'].includes(h.ator)));
    assert.equal((await pool.query('SELECT estado FROM convite_geracoes WHERE id=$1', [chave])).rows[0].estado, 'NAO_ENVIADA');
  });
  await check('rollback 084 recusa apagar etapas e decisões registradas; postcheck 084 segue válido', async () => {
    await assert.rejects(pool.query(fs.readFileSync(path.join(root, 'database/rollback/20261018_084_convite_geracao_pendencias_down.sql'), 'utf8')), /etapas registradas/);
    await pool.query(fs.readFileSync(path.join(root, 'database/checks/20261018_084_postcheck.sql'), 'utf8'));
  });
  const report = { ok: true, checks, envios: enviosProvedor, escopo: 'PostgreSQL 18 descartável; 073/074/079/084; schema anterior mínimo; tenant/paywall/IA simulados; sem rede externa' };
  fs.writeFileSync(path.join(cluster, 'resultado-convites.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
run().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => pool.end());
