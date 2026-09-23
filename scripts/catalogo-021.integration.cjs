/* eslint-disable @typescript-eslint/no-require-imports -- Runner local com serviços TS reais. */
// Exclusivo do clone autorizado. Não carrega dotenv, não aplica migrations.
// Um único Client real; transações dos serviços viram savepoints sob rollback externo.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const only = process.argv.find(a => a.startsWith('--only='))?.slice(7);
const selected = only ? new Set(only.split(',')) : null;
const testNames = new Set(['catalogo', 'rolha', 'fechamento', 'negativos_buffet', 'administracao', 'edicao_regras', 'pdf', 'contrato_buffet']);
const results = [];
let client, before, allBefore, ids, temp, transaction = false, savepoint = 0;
let queryQueue = Promise.resolve();
const requireTs = name => require(path.join(root, name));
require.extensions['.ts'] = (module, filename) => {
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: filename,
  }).outputText.replace(/require\("@\/([^"\n]+)"\)/g, (_, name) => `require(${JSON.stringify(path.join(root, name))})`);
  module._compile(output, filename);
};
// Os handlers usam Promise.all; serializar somente este Client de teste.
const executor = { query: (sql, values) => {
  const pending = queryQueue.then(() => client.query(sql, values));
  queryQueue = pending.catch(() => {});
  return pending;
} };
async function tx(work) {
  const name = `catalogo_test_${++savepoint}`;
  await client.query(`SAVEPOINT ${name}`);
  try { const result = await work(executor); await client.query(`RELEASE SAVEPOINT ${name}`); return result; }
  catch (error) { await client.query(`ROLLBACK TO SAVEPOINT ${name}`); await client.query(`RELEASE SAVEPOINT ${name}`); throw error; }
}
async function protectedState() {
  const tables = ['fechamentos', 'fechamento_adicionais'];
  const out = {};
  for (const table of tables) {
    const filter = table === 'fechamentos' ? 'id' : 'fechamento_id';
    out[table] = (await client.query(`SELECT count(*)::int quantidade,
      encode(sha256(convert_to(COALESCE(string_agg(to_jsonb(t)::text,E'\n' ORDER BY t.id),''),'UTF8')),'hex') hash
      FROM public.${table} t WHERE ${filter}=ANY($1::uuid[])`, [ids])).rows[0];
  }
  return out;
}
async function allTablesState() {
  const out = {};
  for (const { tablename } of (await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows) {
    const quoted = '"' + tablename.replaceAll('"', '""') + '"';
    out[tablename] = (await client.query(`SELECT count(*)::int n,
      encode(sha256(convert_to(COALESCE(string_agg(to_jsonb(t)::text,E'\\n' ORDER BY to_jsonb(t)::text),''),'UTF8')),'hex') hash FROM public.${quoted} t`)).rows[0];
  }
  return out;
}
async function test(name, work) {
  if (selected && !selected.has(name)) return;
  try { await tx(work); results.push({ name, status: 'PASS' }); console.log(`PASS ${name}`); }
  catch (error) { results.push({ name, status: 'FAIL', code: error.code ?? error.name }); console.log(`FAIL ${name} code=${error.code ?? error.name}`); console.log((error.stack ?? '').split('\n').filter(line=>/^\s+at /.test(line)).slice(0,4).join('\n')); throw error; }
}
function cpfFicticio() {
  const n = Array.from(randomBytes(9), x => x % 10);
  for (let k = 9; k <= 10; k++) { const r = n.reduce((s, x, i) => s + x * (k + 1 - i), 0) % 11; n.push(r < 2 ? 0 : 11 - r); }
  return n.join('');
}
function pdfFicticio() {
  const stream = 'BT /F1 16 Tf 40 780 Td (Catalogo ficticio - regressao local) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let text = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((o, i) => { offsets.push(Buffer.byteLength(text)); text += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(text);
  text += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(text);
}
async function main() {
  // Um filtro digitado incorretamente não pode resultar em sucesso sem testes.
  assert(process.argv.slice(2).length <= 1 && process.argv.slice(2).every(a => a.startsWith('--only=')), 'Argumento de regressão inválido');
  if (process.argv.length > 2) assert(selected?.size && [...selected].every(name => testNames.has(name)), 'Grupo de regressão desconhecido ou vazio');
  assert.equal(execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim(), 'v1/catalogo-021a');
  const url = new URL(process.env.KIDMAIS_HOMOLOGACAO_DATABASE_URL || '');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  assert(['postgres:', 'postgresql:'].includes(url.protocol));
  assert(['localhost', '127.0.0.1', '::1'].includes(host));
  assert.equal(url.port || '5432', '5432'); assert.equal(decodeURIComponent(url.pathname), '/kidmais_v1_homologacao');
  assert([...url.searchParams.keys()].every(k => k === 'sslmode'));
  client = new Client({ host, port: 5432, database: 'kidmais_v1_homologacao', user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password), ssl: false, connectionTimeoutMillis: 5000, statement_timeout: 30000,
    options: '-c default_transaction_read_only=on -c search_path=public -c lock_timeout=5000' });
  await client.connect();
  const identity = (await client.query("SELECT current_database() banco,host(inet_server_addr()) host,inet_server_port() porta,current_setting('transaction_read_only') readonly")).rows[0];
  assert.equal(identity.banco, 'kidmais_v1_homologacao'); assert(['::1', '127.0.0.1'].includes(identity.host)); assert.equal(identity.porta, 5432); assert.equal(identity.readonly, 'on');
  console.log('DESTINO ' + JSON.stringify(identity));
  ids = (await client.query('SELECT id FROM fechamentos ORDER BY id')).rows.map(r => r.id);
  assert.equal(ids.length, 10, 'Esperados os 10 fechamentos históricos'); before = await protectedState();
  allBefore = await allTablesState();
  console.log('HISTORICO_ANTES ' + JSON.stringify(before));
  // Injecta apenas o executor do banco: SQL, autenticação e serviços não são simulados.
  const dbFile = require.resolve(path.join(root, 'lib/db/postgres.ts'));
  require.cache[dbFile] = { id: dbFile, filename: dbFile, loaded: true, exports: { db: () => executor, withTransaction: tx } };
  process.env.NODE_ENV = 'test'; process.env.ADMIN_AUTH_ORIGIN = 'http://localhost:3000';
  process.env.ADMIN_AUTH_SECRET = randomBytes(32).toString('hex');
  delete process.env.DATABASE_URL;
  process.env.IDENTIDADE_OTP_PEPPER = randomBytes(32).toString('hex');
  process.env.IDENTIDADE_OTP_PROVIDER = 'console'; // Transporte sempre injetado em memória; nunca executar console sender.
  delete process.env.KIDMAIS_DEPLOY_ENV;
  delete process.env.KIDMAIS_STAGING_OTP_DISABLED;
  process.env.CONTRATO_ACEITE_DEV_ENABLED = 'true';
  process.env.FESTA_ENABLED = 'true';
  global.fetch = async () => { throw Error('Transporte externo proibido nesta regressão'); };
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kidmais-catalogo-regressao-')); process.chdir(temp);
  await client.query('BEGIN READ WRITE'); transaction = true;
  // Confirmação imediatamente anterior às fixtures com escrita.
  assert.equal((await client.query('SELECT current_database() banco')).rows[0].banco, 'kidmais_v1_homologacao');
  const { NextRequest } = require('next/server');
  const pricing = requireTs('lib/comercial/services/pricing.service.ts');
  const publicService = requireTs('lib/fechamentos/services/fechamento-publico.service.ts');
  const buffet = requireTs('app/api/fechamentos/catalogo/route.ts');
  const extras = requireTs('app/api/fechamentos/adicionais/route.ts');
  const admin = requireTs('app/api/admin/configuracoes/catalogo/route.ts');
  const upload = requireTs('app/api/admin/configuracoes/tabela-pacotes/route.ts');
  const pdf = requireTs('app/api/fechamentos/tabela-pacotes/route.ts');
  const packages = (await client.query('SELECT id,codigo FROM pacotes WHERE ativo ORDER BY codigo')).rows;
  const turno = (await client.query("SELECT id FROM configuracao_agenda WHERE codigo='TURNO_1' AND ativo")).rows[0].id;
  const date = '2027-06-26';
  const mappings = requireTs('lib/fechamentos/comercial-input.ts').PACOTE_CODIGO_BANCO;
  const req = (suffix, method = 'GET', body, session) => new NextRequest(`http://localhost:3000${suffix}`, { method,
    headers: { ...(body && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}),
      ...(session ? { cookie: `kidmais_admin_dev=${session.token}`, origin: 'http://localhost:3000', 'x-csrf-token': session.csrf } : {}) },
    ...(body ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}) });
  const context = n => ({ data: date, configuracaoAgendaId: turno, pacoteId: packages.find(p => p.codigo === 'COMPLETA').id, convidados: n });
  await test('catalogo', async () => {
    for (const p of packages) {
      const response = await buffet.GET(req(`/api/fechamentos/catalogo?pacote=${p.codigo}`)); assert.equal(response.status, 200);
      const categories = (await response.json()).categorias;
      const expected = p.codigo === 'PIZZA_PARTY' ? [] : ['SALGADOS', 'MASSA_BOLO', 'RECHEIO_BOLO', ...(p.codigo === 'COMPACTA' ? [] : ['DOCES']), ...(['MINI_FESTA','COMPLETA','PREMIUM'].includes(p.codigo) ? ['LEMBRANCINHAS'] : []), ...(p.codigo === 'PREMIUM' ? ['BOMBONS','EMPRATADOS'] : [])];
      assert.deepEqual(categories.map(c => c.codigo).sort(), expected.sort());
      for (const c of categories) assert.equal(c.itens.length, { SALGADOS:25,DOCES:16,MASSA_BOLO:3,RECHEIO_BOLO:7,BOMBONS:4,EMPRATADOS:5,LEMBRANCINHAS:2 }[c.codigo]);
      const front = Object.keys(mappings).find(k => mappings[k] === p.codigo);
      const e = await extras.GET(req(`/api/fechamentos/adicionais?pacote=${front}&data=${date}&convidados=79`)); assert.equal(e.status, 200);
      const available = (await e.json()).adicionais;
      if (p.codigo === 'PIZZA_PARTY') assert.equal(available.length, 0);
      else { assert(available.some(a => a.codigo === 'BEBIDA_ALCOOLICA' && a.preco === 190)); }
      if (['COMPLETA','PREMIUM'].includes(p.codigo)) for (const code of ['PENNE','CREPE_1_SABOR','SORVETE']) assert(!available.some(a => a.codigo === code));
      if (p.codigo === 'PREMIUM') assert(!available.some(a => a.codigo === 'EMPRATADO_PREMIUM'));
      console.log('PACOTE ' + JSON.stringify({ codigo:p.codigo,buffet:categories.map(c=>({codigo:c.codigo,max:c.max,itens:c.itens.length})),extras:available.map(a=>a.codigo) }));
    }
  });
  await test('rolha', async () => {
    for (const [convidados, valor] of [[79,190],[80,290]]) {
      const resumo = await pricing.calcularResumoComercial({ ...context(convidados), adicionais:[{codigo:'BEBIDA_ALCOOLICA',quantidade:1}] },executor);
      assert.equal(resumo.valorAdicionais,valor); assert.equal(resumo.valorTotalTabela,resumo.valorTabelaPacoteAplicado+valor);
      const response=await extras.GET(req(`/api/fechamentos/adicionais?pacote=completa&data=${date}&convidados=${convidados}`));
      assert.equal((await response.json()).adicionais.find(a=>a.codigo==='BEBIDA_ALCOOLICA').preco,valor);
      console.log('ROLHA '+JSON.stringify({ convidados,taxa:valor,pacote:resumo.valorTabelaPacoteAplicado,total:resumo.valorTotalTabela }));
    }
    await assert.rejects(pricing.calcularResumoComercial({...context(80),adicionais:[{codigo:'PENNE'}]},executor), e=>e.code==='ADICIONAL_NAO_ENCONTRADO');
  });
  await test('fechamento', async () => {
    const categories=(await (await buffet.GET(req('/api/fechamentos/catalogo?pacote=COMPLETA'))).json()).categorias;
    const escolhas=Object.fromEntries(categories.map(c=>[c.codigo,[c.itens[0].id]]));
    for(const convidados of [79,80]) {
      const resumo=await pricing.calcularResumoComercial({...context(convidados),adicionais:[{codigo:'BEBIDA_ALCOOLICA'}]},executor);
      const key=randomUUID();
      const input={dataEvento:date,horarioInicio:'11:00',horarioFim:'15:00',configuracaoAgendaId:turno,pacoteId:context(convidados).pacoteId,convidados,
        adicionais:[{codigo:'BEBIDA_ALCOOLICA',quantidade:1}],valorProposto:resumo.valorTotalTabela,formaPagamentoPretendida:'PIX_AVISTA',buffetStatus:'DEFINIDO',escolhasBuffet:escolhas,
        identidade:{tipo:'NOVO_CLIENTE'},cliente:{nomeCompleto:`REGRESSAO-CATALOGO-${key}`,cpf:cpfFicticio(),email:`${key}@example.invalid`,whatsapp:'11900000000',cep:'00000000',logradouro:'Rua Ficticia',numero:'1',bairro:'Teste',cidade:'Teste',uf:'SP'},
        aniversariante:{nome:`Ficticio ${key}`},requestId:key};
      const created=await publicService.criarFechamentoPublicoComIdentidade(input);
      assert.equal(created.fechamento.valorTabela,resumo.valorTotalTabela); assert.equal(created.fechamento.status,'AGUARDANDO_CONTRATO');
      const choices=(await client.query('SELECT e.categoria_nome_aplicado,e.item_nome_aplicado FROM fechamento_buffet_escolhas e JOIN fechamento_buffet_snapshots s ON s.id=e.snapshot_id WHERE s.fechamento_id=$1',[created.fechamento.id])).rows;
      assert.equal(choices.length,categories.length);assert(choices.every(c=>c.categoria_nome_aplicado&&c.item_nome_aplicado));
      const f=(await client.query('SELECT valor_adicionais::text,valor_tabela::text FROM fechamentos WHERE id=$1',[created.fechamento.id])).rows[0];
      assert.equal(Number(f.valor_adicionais),convidados===79?190:290);assert.equal(Number(f.valor_tabela),resumo.valorTotalTabela);
    }
    assert.deepEqual(await protectedState(),before);
  });
  await test('negativos_buffet', async () => {
    const categories=(await (await buffet.GET(req('/api/fechamentos/catalogo?pacote=COMPLETA'))).json()).categorias;
    const resumo=await pricing.calcularResumoComercial(context(80),executor);
    const counts=async()=> (await client.query(`SELECT
      (SELECT count(*) FROM clientes)::int clientes,(SELECT count(*) FROM fechamentos)::int fechamentos,
      (SELECT count(*) FROM fechamento_buffet_snapshots)::int snapshots,(SELECT count(*) FROM fechamento_buffet_escolhas)::int escolhas`)).rows[0];
    const original=await counts();
    const premium=(await (await buffet.GET(req('/api/fechamentos/catalogo?pacote=PREMIUM'))).json()).categorias;
    const invalid=[
      {SALGADOS:categories.find(c=>c.codigo==='SALGADOS').itens.slice(0,9).map(i=>i.id)},
      {EMPRATADOS:[premium.find(c=>c.codigo==='EMPRATADOS').itens[0].id]},
      {SALGADOS:[randomUUID()]},
    ];
    for(const escolhasBuffet of invalid){
      const key=randomUUID();
      await assert.rejects(publicService.criarFechamentoPublicoComIdentidade({dataEvento:date,horarioInicio:'11:00',horarioFim:'15:00',
        configuracaoAgendaId:turno,pacoteId:context(80).pacoteId,convidados:80,valorProposto:resumo.valorTotalTabela,
        formaPagamentoPretendida:'PIX_AVISTA',buffetStatus:'DEFINIDO',escolhasBuffet,identidade:{tipo:'NOVO_CLIENTE'},
        cliente:{nomeCompleto:`REGRESSAO-CATALOGO-${key}`,cpf:cpfFicticio(),email:`${key}@example.invalid`,whatsapp:'11900000000',cep:'00000000',logradouro:'Rua Ficticia',numero:'1',bairro:'Teste',cidade:'Teste',uf:'SP'},
        aniversariante:{nome:`Ficticio ${key}`},requestId:key}),e=>e.code==='BUFFET_INVALIDO');
      assert.deepEqual(await counts(),original,'Rejeição não pode deixar cadastro/fechamento parcial');
    }
  });
  let session;
  async function login() {
    if(session)return session;
    const pass=randomBytes(24).toString('hex'),email=`${randomUUID()}@example.invalid`;
    const password=await requireTs('lib/autenticacao/senha.ts').criarHashSenha(pass);
    await client.query("INSERT INTO usuarios_administrativos(email,nome,cargo,senha_hash,papel) VALUES($1,'REGRESSAO CATALOGO','TESTE',$2,'REPRESENTANTE_AUTORIZADO')",[email,password]);
    session=await requireTs('lib/autenticacao/service.ts').loginAdmin(email,pass,randomUUID(),null,'regressao-local');return session;
  }
  await test('contrato_buffet', async () => {
    const s = await login(), auth = requireTs('lib/autenticacao/service.ts');
    const actor = await auth.consultarSessao(s.token, executor);
    const ctx = { usuarioId: actor.usuario_id, origem: 'SISTEMA', requestId: randomUUID(), ip: null, userAgent: 'Regressao catalogo local' };
    const contratos = requireTs('lib/contratos/services/contrato.service.ts');
    const operacao = requireTs('lib/contratos/services/administrativo.service.ts');
    const repo = requireTs('lib/contratos/repositories/index.ts');
    const leitura = requireTs('lib/contratos/services/fluxo-publico.ts');
    const publico = requireTs('lib/contratos/services/contrato-publico.service.ts');
    const identidade = requireTs('lib/identidade/services/identity.service.ts');
    const pacoteId = packages.find(p => p.codigo === 'PREMIUM').id;
    const categories = (await (await buffet.GET(req('/api/fechamentos/catalogo?pacote=PREMIUM'))).json()).categorias;
    const escolhasBuffet = Object.fromEntries(categories.map(c => [c.codigo, [c.itens[0].id]]));
    const comercial = await pricing.calcularResumoComercial({ ...context(80), pacoteId }, executor);
    const key = randomUUID();
    const created = await publicService.criarFechamentoPublicoComIdentidade({ ...context(80), pacoteId, dataEvento: date, horarioInicio: '11:00', horarioFim: '15:00',
      valorProposto: comercial.valorTotalTabela, formaPagamentoPretendida: 'PIX_AVISTA', buffetStatus: 'DEFINIDO', escolhasBuffet,
      buffetSalgados: 'TEXTO MANIPULADO NO NAVEGADOR', buffetBombom: 'TEXTO MANIPULADO NO NAVEGADOR',
      identidade: { tipo: 'NOVO_CLIENTE' },
      cliente: { nomeCompleto: `REGRESSAO-CATALOGO-${key}`, cpf: cpfFicticio(), email: `${key}@example.invalid`, whatsapp: '11900000000', cep: '00000000', logradouro: 'Rua Ficticia', numero: '1', bairro: 'Teste', cidade: 'Teste', uf: 'SP' },
      aniversariante: { nome: `Ficticio ${key}` }, requestId: key });
    const expected = codigo => categories.find(c => c.codigo === codigo).itens[0].nome;
    assert.equal(created.fechamento.buffetSalgados, expected('SALGADOS'));
    assert.equal(created.fechamento.buffetBombom, expected('BOMBONS'));
    const originalItem = categories.find(c => c.codigo === 'SALGADOS').itens[0];
    const rename = async nome => assert.equal((await admin.PATCH(req('/api/admin/configuracoes/catalogo', 'PATCH', { acao: 'item', id: originalItem.id, nome, ativo: true }, s))).status, 200);
    await rename('Item renomeado depois do fechamento');
    const v1 = await contratos.gerarContrato({ fechamentoId: created.fechamento.id }, ctx);
    assert.equal(v1.versao.snapshot.contratacao.buffet.salgados, expected('SALGADOS'));
    for (const [campo, codigo] of [['doces','DOCES'], ['lembrancinha','LEMBRANCINHAS'], ['empratado','EMPRATADOS'], ['bombom','BOMBONS']])
      assert.equal(v1.versao.snapshot.contratacao.buffet[campo], expected(codigo));
    assert.match(v1.versao.snapshot.contratacao.buffet.bolo, /Massa: .+; Recheio: .+/);
    const op = (id, body) => operacao.operarContrato(id, body, s.token, { ...ctx, requestId: randomUUID() });
    async function assinar(id) {
      const v = await repo.buscarVersaoPorId(id, executor), e = await operacao.edicaoDaVersao(id, executor);
      const doc = await op(id, { acao: 'gerar_pdf', revisao: e.revisao });
      await op(id, { acao: 'revisar', revisao: e.revisao, documentoId: doc.documentoId });
      await op(id, { acao: 'assinar', revisao: e.revisao, documentoId: doc.documentoId, chaveIdempotencia: randomUUID() });
      await op(id, { acao: 'liberar', revisao: e.revisao });
      let codigo;
      const sender = async envio => { codigo = envio.codigo; }; // Código nunca sai do processo.
      const desafio = await publico.iniciarDesafioContrato({ contratoId: v.contratoId, cpf: v.snapshot.contratante.cpf, canal: 'WHATSAPP' }, sender);
      const prova = await identidade.criarIdentityServiceComAmbiente(sender).confirmarCodigo({ validacaoId: desafio.validacaoId, codigo });
      const pdf = await leitura.documentoParaLeitura(v, executor);
      await publico.assinarContratoPublico({ contratoId: v.contratoId, versaoId: v.id, snapshotHash: v.snapshotHash,
        documentoPdfHash: pdf.pdfHash, acessoToken: desafio.acessoToken, provaToken: prova.provaToken }, sender);
      return pdf;
    }
    const pdf1 = await assinar(v1.versao.id);
    const frozen = await repo.buscarVersaoPorId(v1.versao.id, executor);
    const documents = async () => (await client.query('SELECT id,pdf_hash,snapshot_hash,encode(conteudo_pdf,\'hex\') bytes FROM contrato_documentos WHERE contrato_versao_id=$1 ORDER BY id', [frozen.id])).rows;
    const docsBefore = await documents();
    await rename('Item renomeado depois da assinatura');
    const next = await op(frozen.id, { acao: 'nova_versao', tipo: 'RETIFICACAO', motivo: 'Revisao ficticia do buffet', chaveCriacao: randomUUID() });
    const preparacao = await requireTs('lib/fechamentos/services/revisao-operacional.service.ts').fontesPreparacao(next.versaoId, executor);
    const f = preparacao.fechamento, e = await operacao.edicaoDaVersao(next.versaoId, executor);
    const body = { acao: 'editar_festa', revisao: e.revisao, motivo: 'Escolhas revistas apenas na V2', fonteHash: preparacao.fonteHash,
      pacoteId: f.pacoteId, convidados: f.convidados, dataEvento: f.dataEvento, configuracaoAgendaId: f.configuracaoAgendaId,
      horarioInicio: f.horarioInicio, horarioFim: f.horarioFim, adicionais: preparacao.adicionais,
      idadeAniversarianteEvento: f.idadeAniversarianteEvento, temaFesta: f.temaFesta ?? '', buffetStatus: 'DEFINIDO',
      buffetSalgados: 'Escolha revista ficticia V2', buffetBebidas: f.buffetBebidas ?? '', buffetDoces: f.buffetDoces ?? '',
      buffetBolo: f.buffetBolo ?? '', buffetOutros: f.buffetOutros ?? '', buffetLembrancinha: f.buffetLembrancinha ?? '',
      buffetEmpratado: f.buffetEmpratado ?? '', buffetBombom: f.buffetBombom ?? '', observacoesEquipe: f.observacoesEquipe ?? '' };
    await op(next.versaoId, operacao.acaoContratoSchema.parse(body));
    assert.equal((await repo.buscarVersaoPorId(next.versaoId, executor)).snapshot.contratacao.buffet.salgados, body.buffetSalgados);
    assert.deepEqual(await repo.buscarVersaoPorId(frozen.id, executor), frozen);
    await assinar(next.versaoId);
    const detalhe = await operacao.detalheAdministrativo(v1.contrato.id);
    assert.equal(detalhe.fluxo.versao_vigente_id, next.versaoId);
    assert.deepEqual(await repo.buscarVersaoPorId(frozen.id, executor), frozen);
    assert.deepEqual(await documents(), docsBefore);
    const historicalPdf = await leitura.documentoParaLeitura(await repo.buscarVersaoPorId(frozen.id, executor), executor);
    assert.equal(historicalPdf.pdfHash, pdf1.pdfHash); assert(historicalPdf.pdf.equals(pdf1.pdf));
    assert.equal((await client.query('SELECT count(*)::int n FROM festas WHERE contrato_id=$1', [v1.contrato.id])).rows[0].n, 1);
    await assert.rejects(op(frozen.id, { acao: 'salvar', revisao: 1, observacoesDocumentais: 'Alteracao proibida' }), e => e.httpStatus === 409);
    await rename(originalItem.nome);
    console.log('CONTRATO_BUFFET=nomes_servidor,renomeacao_catalogo,V1_assinada,V2_revisada_assinada,V1_snapshot_hash_PDF_preservados');
  });
  await test('administracao', async () => {
    const s=await login();
    assert.equal((await admin.GET(req('/api/admin/configuracoes/catalogo'))).status,401);
    const get=await admin.GET(req('/api/admin/configuracoes/catalogo','GET',null,s));assert.equal(get.status,200);
    const data=(await get.json()).data;const item=data.itens[0];
    const change={acao:'item',id:item.id,nome:'Item ficticio de regressao',ativo:true};
    const noCsrf=req('/api/admin/configuracoes/catalogo','PATCH',change,s);noCsrf.headers.delete('x-csrf-token');
    assert.equal((await admin.PATCH(noCsrf)).status,403);
    assert.equal((await admin.PATCH(req('/api/admin/configuracoes/catalogo','PATCH',change,s))).status,200);
    assert.equal((await client.query('SELECT nome FROM buffet_itens WHERE id=$1',[item.id])).rows[0].nome,change.nome);
    assert.equal((await admin.PATCH(req('/api/admin/configuracoes/catalogo','PATCH',{...change,ativo:false},s))).status,200);
    const exposed=(await (await buffet.GET(req('/api/fechamentos/catalogo?pacote=PREMIUM'))).json()).categorias;
    assert(!exposed.some(c=>c.itens.some(i=>i.id===item.id)));
    assert.equal((await admin.PATCH(req('/api/admin/configuracoes/catalogo','PATCH',{...change,nome:item.nome,ativo:item.ativo},s))).status,200);
    assert.deepEqual(await protectedState(),before);
  });
  await test('edicao_regras', async()=>{
    const s=await login();
    const data=(await (await admin.GET(req('/api/admin/configuracoes/catalogo','GET',null,s))).json()).data;
    const pacote=data.pacotes.find(p=>p.codigo==='COMPLETA'),cat=data.categorias.find(c=>c.codigo==='SALGADOS');
    const adicional=data.adicionais.find(a=>a.codigo==='BEBIDA_ALCOOLICA');
    const patch=async body=>assert.equal((await admin.PATCH(req('/api/admin/configuracoes/catalogo','PATCH',body,s))).status,200);
    await patch({acao:'categoria',id:cat.id,nome:'Categoria ficticia',ativo:true});
    await patch({acao:'regra_buffet',pacoteId:pacote.id,categoriaId:cat.id,max:7,ativo:true});
    const exposed=(await (await buffet.GET(req('/api/fechamentos/catalogo?pacote=COMPLETA'))).json()).categorias.find(c=>c.codigo==='SALGADOS');
    assert.equal(exposed.nome,'Categoria ficticia');assert.equal(exposed.max,7);
    await patch({acao:'vinculo_adicional',pacoteId:pacote.id,adicionalId:adicional.id,modalidade:'INDISPONIVEL'});
    const available=(await (await extras.GET(req(`/api/fechamentos/adicionais?pacote=completa&data=${date}&convidados=80`))).json()).adicionais;
    assert(!available.some(a=>a.codigo==='BEBIDA_ALCOOLICA'));
    await assert.rejects(pricing.calcularResumoComercial({...context(80),adicionais:[{codigo:'BEBIDA_ALCOOLICA'}]},executor),e=>e.code==='ADICIONAL_NAO_ENCONTRADO');
    await patch({acao:'vinculo_adicional',pacoteId:pacote.id,adicionalId:adicional.id,modalidade:'EXTRA'});
    assert.equal((await pricing.calcularResumoComercial({...context(80),adicionais:[{codigo:'BEBIDA_ALCOOLICA'}]},executor)).valorAdicionais,290);
    await patch({acao:'categoria',id:cat.id,nome:cat.nome,ativo:cat.ativo});
    const regra=data.regras.find(r=>r.pacote_id===pacote.id&&r.categoria_id===cat.id);
    await patch({acao:'regra_buffet',pacoteId:pacote.id,categoriaId:cat.id,max:regra.escolhas_max,ativo:regra.ativo});
    assert.deepEqual(await protectedState(),before);
  });
  await test('pdf', async () => {
    const s=await login(),bytes=pdfFicticio();
    const form=()=>{const f=new FormData();f.set('arquivo',new File([bytes],'catalogo-ficticio.pdf',{type:'application/pdf'}));return f;};
    assert.equal((await upload.POST(req('/api/admin/configuracoes/tabela-pacotes','POST',form()))).status,401);
    const response=await upload.POST(req('/api/admin/configuracoes/tabela-pacotes','POST',form(),s));assert.equal(response.status,200);
    assert.equal((await pdf.HEAD()).status,204);
    const opened=await pdf.GET(req('/api/fechamentos/tabela-pacotes'));assert.equal(opened.status,200);assert.equal(opened.headers.get('content-type'),'application/pdf');
    assert.match(opened.headers.get('content-disposition'),/^inline/);assert.equal(Buffer.compare(Buffer.from(await opened.arrayBuffer()),bytes),0);
    const downloaded=await pdf.GET(req('/api/fechamentos/tabela-pacotes?download=1'));
    assert.equal(downloaded.status,200); assert.equal(downloaded.headers.get('content-disposition'),'attachment; filename="pacotes-e-precos.pdf"');
    assert(Buffer.from(await downloaded.arrayBuffer()).equals(bytes));
    assert.equal((await upload.POST(req('/api/admin/configuracoes/tabela-pacotes','POST',form(),s))).status,200);
    assert.equal((await client.query('SELECT count(*)::int n FROM documentos_publicos WHERE ativo')).rows[0].n,1);
    const current=(await client.query('SELECT sha256 FROM documentos_publicos WHERE ativo')).rows[0];assert.equal(current.sha256,createHash('sha256').update(bytes).digest('hex'));
  });
}
main().catch(error=>{console.error('REGRESSAO_FALHOU '+(error.code??error.name));process.exitCode=1;}).finally(async()=>{
  if(client){
    try { if(transaction)await client.query('ROLLBACK'); if(before){assert.deepEqual(await protectedState(),before);console.log('HISTORICO_DEPOIS '+JSON.stringify(await protectedState()));assert.equal((await client.query('SELECT count(*)::int n FROM fechamentos')).rows[0].n,10);console.log('PRESERVACAO_10_FECHAMENTOS=PASS');} }
    catch{console.error('PRESERVACAO=FAIL');process.exitCode=1;}
    try { if(allBefore){ assert.deepEqual(await allTablesState(),allBefore);console.log('RESTAURACAO_TODAS_TABELAS=PASS'); } }
    catch { console.error('RESTAURACAO_TODAS_TABELAS=FAIL');process.exitCode=1; }
    await client.end();
  }
  process.chdir(root);
  if(temp){fs.writeFileSync(path.join(temp,'resultado.json'),JSON.stringify(results,null,2));console.log('EVIDENCIA='+path.join(temp,'resultado.json'));}
  console.log('RESULTADOS '+JSON.stringify(results));
});
