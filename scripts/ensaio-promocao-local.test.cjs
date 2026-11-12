/* eslint-disable @typescript-eslint/no-require-imports */
// Executor do ensaio local da promoção (scripts/ensaio-promocao-local.cjs), SEM banco e sem rede: recusas de alvo, de
// ambiente e de autorização antes de qualquer conexão; identidade do servidor; ordem da cadeia; parada na primeira falha
// (com `rodar` simulado e com o núcleo real da 089 sobre um cliente simulado); o que entra e o que nunca entra no relatório.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const e = require('./ensaio-promocao-local.cjs');
const ordem = require('./promocao-production-ordem.cjs');

const PORTA = '55843', BANCO = 'kidmais_ensaio_teste';
const ENV = Object.freeze({KIDMAIS_POSTGRES_DESCARTAVEL: 'kidmais_pacotes_v1_descartavel', KIDMAIS_DESCARTAVEL_PORTA: PORTA,
  KIDMAIS_DESCARTAVEL_AUTORIZACAO: `127.0.0.1:${PORTA}/${BANCO}`});
const ALVO = Object.freeze({host: '127.0.0.1', porta: Number(PORTA), banco: BANCO});
const IDENTIDADE = Object.freeze({db: BANCO, cluster: 'kidmais_descartavel', addr: '127.0.0.1', port: Number(PORTA), papel: 'kidmais_descartavel', versao_pg: 180006, tem_real: false});
const pastas = [];
const novaPasta = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'ensaio-promocao-teste-')); pastas.push(p); return p; };
test.after(() => { for (const p of pastas) fs.rmSync(p, {recursive: true, force: true}); });

/** Cliente simulado: responde a identidade e as contagens do executor; qualquer outra consulta segue `outra`. */
function clienteSimulado({identidade = IDENTIDADE, outra = () => { throw new Error('consulta inesperada no cliente simulado'); }, conectar = async () => {}} = {}) {
  const registro = {clientes: 0, consultas: [], nomes: []};
  class Cliente {
    constructor(opts) { registro.clientes++; registro.nomes.push(opts.application_name); this.opts = opts; }
    on() {}
    async connect() { return conectar(this.opts); }
    async query(sql, params) {
      registro.consultas.push(sql);
      if (/^(BEGIN|ROLLBACK|COMMIT|SET LOCAL)/.test(sql)) return {rows: []};
      if (sql === e.SQL_IDENTIDADE) return {rows: [identidade]};
      if (sql === e.SQL_CONTAGENS) { assert.deepEqual(params, [e.TABELAS_PRINCIPAIS]); return {rows: [{tabelas: 3, linhas: {empresas: '2'}}]}; }
      return outra(sql, this.opts);
    }
    async end() {}
  }
  return {Cliente, registro};
}
const recusa = (fn, codigo) => assert.throws(fn, err => { assert.match(err.message, codigo); return true; });

test('argumentos: plano sem argumentos; porta e banco obrigatórios; nada repetido nem desconhecido', () => {
  assert.deepEqual(e.lerArgumentos([]), {modo: 'plano'});
  assert.deepEqual(e.lerArgumentos(['--porta', PORTA, '--banco', BANCO]), {modo: 'ensaio', host: '127.0.0.1', porta: PORTA, banco: BANCO, pasta: null});
  assert.equal(e.lerArgumentos(['--so-conferir', '--banco', BANCO, '--porta', PORTA, '--host', 'localhost']).modo, 'so-conferir');
  recusa(() => e.lerArgumentos(['--porta', PORTA]), /PORTA_E_BANCO_OBRIGATORIOS/);
  recusa(() => e.lerArgumentos(['--porta', PORTA, '--porta', PORTA, '--banco', BANCO]), /ARGUMENTO_REPETIDO/);
  recusa(() => e.lerArgumentos(['--porta', PORTA, '--banco', BANCO, '--aplicar']), /ARGUMENTOS_RECUSADOS/);
  recusa(() => e.lerArgumentos(['--porta', '--banco', BANCO]), /ARGUMENTO_SEM_VALOR/);
});

test('alvo: só loopback, banco que não seja de production, staging, real ou de sistema, e porta fora dos clusters reais', () => {
  assert.deepEqual(e.exigirAlvo({porta: PORTA, banco: BANCO}, ENV), ALVO);
  assert.deepEqual(e.exigirAlvo({host: 'localhost', porta: PORTA, banco: BANCO}, ENV), ALVO, 'localhost conecta em 127.0.0.1');
  for (const host of ['dpg-dak750gae00c73fudmg0-a', '10.0.0.5', '0.0.0.0', '127.0.0.2', '::1', 'LOCALHOST', '', 'localhost.evil.test'])
    recusa(() => e.exigirAlvo({host, porta: PORTA, banco: BANCO}, ENV), /^HOST_RECUSADO$/);
  for (const banco of ['kidmais_production', 'kidmais_staging_1z91', 'kidmais_manager', 'postgres', 'template1', 'Kidmais_Production', 'a b', 'x;drop', '', undefined])
    recusa(() => e.exigirAlvo({porta: PORTA, banco}, {...ENV, KIDMAIS_DESCARTAVEL_AUTORIZACAO: `127.0.0.1:${PORTA}/${banco}`}), /^BANCO_RECUSADO$/);
  for (const porta of ['5432', '5433', '80', '70000', '55843 ', 'abc', undefined, 55843])
    recusa(() => e.exigirAlvo({porta, banco: BANCO}, {...ENV, KIDMAIS_DESCARTAVEL_PORTA: String(porta), KIDMAIS_DESCARTAVEL_AUTORIZACAO: `127.0.0.1:${porta}/${BANCO}`}), /^PORTA_RECUSADA$/);
});

test('ambiente: RENDER, DATABASE_URL (qualquer *DATABASE_URL) e PG* recusam, com o NOME da variável e nunca o valor', () => {
  const segredo = 'postgresql://usuario:senha-secreta@host/banco';
  for (const nome of ['RENDER', 'RENDER_SERVICE_ID', 'DATABASE_URL', 'KIDMAIS_HOMOLOGACAO_DATABASE_URL', 'PGHOST', 'PGPASSWORD', 'PGOPTIONS', 'pgservice'])
    assert.throws(() => e.exigirAlvo({porta: PORTA, banco: BANCO}, {...ENV, [nome]: segredo}), err => {
      assert.equal(err.message, 'AMBIENTE_RECUSADO ' + nome); assert.ok(!err.message.includes('senha')); return true;
    });
});

test('autorização: o mesmo mecanismo das suítes PostgreSQL, com o banco informado; ausente ou divergente recusa', () => {
  const sem = nome => { const x = {...ENV}; delete x[nome]; return x; };
  recusa(() => e.exigirAlvo({porta: PORTA, banco: BANCO}, sem('KIDMAIS_POSTGRES_DESCARTAVEL')), /^AUTORIZACAO_AUSENTE/);
  recusa(() => e.exigirAlvo({porta: PORTA, banco: BANCO}, {...ENV, KIDMAIS_POSTGRES_DESCARTAVEL: 'sim'}), /^AUTORIZACAO_AUSENTE/);
  recusa(() => e.exigirAlvo({porta: PORTA, banco: BANCO}, sem('KIDMAIS_DESCARTAVEL_PORTA')), /^AUTORIZACAO_RECUSADA KIDMAIS_DESCARTAVEL_PORTA$/);
  recusa(() => e.exigirAlvo({porta: PORTA, banco: BANCO}, {...ENV, KIDMAIS_DESCARTAVEL_PORTA: '55498'}), /^AUTORIZACAO_RECUSADA KIDMAIS_DESCARTAVEL_PORTA$/);
  recusa(() => e.exigirAlvo({porta: PORTA, banco: BANCO}, sem('KIDMAIS_DESCARTAVEL_AUTORIZACAO')), /^AUTORIZACAO_RECUSADA KIDMAIS_DESCARTAVEL_AUTORIZACAO/);
  // Autorização de OUTRO banco (a das suítes) ou de outra porta não serve para este alvo.
  for (const valor of [`127.0.0.1:${PORTA}/kidmais_pacotes_v1_descartavel`, `127.0.0.1:55498/${BANCO}`, `localhost:${PORTA}/${BANCO}`, `127.0.0.1:${PORTA}/${BANCO} `])
    recusa(() => e.exigirAlvo({porta: PORTA, banco: BANCO}, {...ENV, KIDMAIS_DESCARTAVEL_AUTORIZACAO: valor}), /^AUTORIZACAO_RECUSADA KIDMAIS_DESCARTAVEL_AUTORIZACAO/);
});

test('recusa de alvo, ambiente ou autorização acontece ANTES de criar cliente; a pasta do ensaio nem é criada', async () => {
  const {Cliente, registro} = clienteSimulado();
  const casos = [[['--porta', PORTA, '--banco', 'kidmais_production'], ENV, /BANCO_RECUSADO/], [['--host', 'db.exemplo.test', '--porta', PORTA, '--banco', BANCO], ENV, /HOST_RECUSADO/],
    [['--porta', PORTA, '--banco', BANCO], {...ENV, DATABASE_URL: 'x'}, /AMBIENTE_RECUSADO DATABASE_URL/], [['--porta', PORTA, '--banco', BANCO], {...ENV, RENDER: 'true'}, /AMBIENTE_RECUSADO RENDER/],
    [['--porta', PORTA, '--banco', BANCO], {}, /AUTORIZACAO_AUSENTE/]];
  for (const [argv, env, codigo] of casos) {
    const pasta = path.join(novaPasta(), 'nao-criada');
    await assert.rejects(e.principal(argv, env, {Client: Cliente, pasta}), codigo);
    assert.equal(fs.existsSync(pasta), false);
  }
  assert.equal(registro.clientes, 0);
});

test('identidade do servidor: banco, cluster_name, endereço, porta, papel e ausência de banco real; divergência para antes de qualquer passo', async () => {
  assert.deepEqual(e.identidade(IDENTIDADE, ALVO), {banco: BANCO, cluster: 'kidmais_descartavel', local: true, versaoPg: 180006});
  const casos = [[{db: 'kidmais_production'}, /BANCO_DIVERGENTE/], [{cluster: 'main'}, /CLUSTER_DIVERGENTE/], [{cluster: ''}, /CLUSTER_DIVERGENTE/], [{addr: '10.0.0.5'}, /SERVIDOR_DIVERGENTE/],
    [{port: 5432}, /SERVIDOR_DIVERGENTE/], [{papel: 'postgres'}, /PAPEL_DIVERGENTE/], [{tem_real: true}, /CLUSTER_COM_BANCO_REAL/], [{tem_real: null}, /CLUSTER_COM_BANCO_REAL/]];
  for (const [troca, codigo] of casos) recusa(() => e.identidade({...IDENTIDADE, ...troca}, ALVO), codigo);
  recusa(() => e.identidade(undefined, ALVO), /BANCO_DIVERGENTE/);
  const {Cliente, registro} = clienteSimulado({identidade: {...IDENTIDADE, cluster: 'main'}});
  const pasta = path.join(novaPasta(), 'nao-criada');
  await assert.rejects(e.principal(['--porta', PORTA, '--banco', BANCO], ENV, {Client: Cliente, pasta}), /CLUSTER_DIVERGENTE/);
  assert.equal(fs.existsSync(pasta), false);
  assert.deepEqual(registro.nomes, ['kidmais-ensaio-identidade']);
  assert.ok(registro.consultas.every(sql => /^(BEGIN TRANSACTION READ ONLY|SET LOCAL|ROLLBACK)/.test(sql) || sql === e.SQL_IDENTIDADE));
});

test('cliente do ensaio: 127.0.0.1, papel do descartável, sem connectionString nem senha carregada, application_name com -ensaio', async () => {
  const o = e.ambienteDeEnsaio(ALVO, '109', novaPasta()).alvo({DATABASE_URL: 'postgresql://ignorada'});
  assert.deepEqual({...o, password: undefined}, {host: '127.0.0.1', port: Number(PORTA), user: 'kidmais_descartavel', database: BANCO, password: undefined,
    application_name: 'kidmais-migration-109-ensaio', connectionTimeoutMillis: 10000});
  assert.ok(!o.application_name.startsWith('kidmais-renovacao'), 'o próprio ensaio não conta como sessão da renovação (núcleo da 109)');
  await assert.rejects(o.password(), /SERVIDOR_PEDIU_SENHA/);
  assert.deepEqual(e.ENV_DOS_NUCLEOS, {WHATSAPP_ATENDIMENTO_MULTIEMPRESA: 'false'});
});

test('ordem: a cadeia é a de PASSOS × FASES de promocao-production-ordem, decidida por proximoPasso, e termina CONCLUIDA', async () => {
  const vistos = [];
  const r = await e.percorrer(ordem, async (p, fase) => { vistos.push(`${p.id} ${fase}`); return {passo: p.id, fase, codigo: 0, resultado: 'OK'}; });
  assert.equal(r.situacao, 'CONCLUIDA');
  assert.deepEqual(vistos, ordem.PASSOS.flatMap(p => ordem.FASES.map(f => `${p.id} ${f}`)));
  assert.equal(r.linhas.length, ordem.PASSOS.length * 3);
  assert.ok(!vistos.some(v => /^(098|099|105) /.test(v)), '098 excluída; 099 e 105 já aplicadas');
});

test('todo passo da ordem tem núcleo de ensaio e as flags do passo são aceitas por ele (cliente que não conecta: FALHA 2, nunca recusa 1)', async () => {
  const {Cliente} = clienteSimulado({conectar: async () => { throw new Error('sem servidor no teste'); }});
  const pasta = novaPasta(); fs.mkdirSync(path.join(pasta, 'marcadores'));
  const ctx = {alvo: ALVO, pasta, raiz: path.resolve(__dirname, '..'), Client: Cliente};
  for (const p of ordem.PASSOS) {
    const l = await e.rodarFase(p, 'CONFERIR', ctx);
    assert.deepEqual([l.passo, l.fase, l.codigo, l.resultado, l.commit], [p.id, 'CONFERIR', 2, 'FALHA', 'NAO_SE_APLICA'], JSON.stringify(l));
    assert.match(l.mensagem, /sem servidor no teste/);
  }
  // APLICAR: o registro de backup de ensaio passa na validação de argumentos de todos; a 107-108 recebe também a drenagem.
  for (const p of ordem.PASSOS) {
    const argv = e.argumentos(p, 'APLICAR');
    assert.deepEqual(argv.slice(-2 - (p.aposBackup ? 2 : 0)).slice(0, 2), ['--backup', e.REGISTRO_BACKUP]);
    assert.equal(argv.includes('--drenagem'), p.id === '107-108');
    const l = await e.rodarFase(p, 'APLICAR', ctx);
    assert.deepEqual([l.codigo, l.resultado], [2, 'FALHA'], `${p.id}: ${JSON.stringify(l)}`);
    assert.equal(l.etapa, 'CONEXAO');
  }
  // O marcador de cada passo ficou na pasta do ensaio, um diretório por passo.
  assert.deepEqual(fs.readdirSync(path.join(pasta, 'marcadores')).sort(), ordem.PASSOS.map(p => p.id).sort());
  // Segunda tentativa na mesma pasta: o marcador exclusivo do núcleo recusa (código 1), como em production.
  const repetida = await e.rodarFase(ordem.PASSOS[0], 'APLICAR', ctx);
  assert.deepEqual([repetida.codigo, repetida.resultado], [1, 'RECUSADO']); assert.match(repetida.mensagem, /TENTATIVA_ANTERIOR_REVISAR/);
});

test('passo com aplicador fora da lista fechada de núcleos para a cadeia (código 1) em vez de improvisar', async () => {
  const estranho = {id: '999', aplicador: 'scripts/migration-999-production.cjs', conferir: '--conferir-999', aplicar: '--aplicar-999-autorizado', migrations: ['999']};
  const l = await e.rodarFase(estranho, 'CONFERIR', {alvo: ALVO, pasta: novaPasta(), raiz: '.', Client: class {}});
  assert.deepEqual([l.codigo, l.resultado, l.mensagem], [1, 'RECUSADO', 'PASSO_SEM_NUCLEO_DE_ENSAIO 999']);
  for (const p of ordem.PASSOS.filter(x => x.aplicador !== 'generico')) assert.ok(Object.hasOwn(e.NUCLEOS, /migration-([0-9-]+)-production/.exec(p.aplicador)[1]), p.id);
});

test('parada na primeira falha: nada roda depois, e a parada diz passo, fase, código e mensagem', async () => {
  for (const [onde, codigo, significado] of [['094 APLICAR', 2, /FALHA registrada/], ['089 CONFERIR', 3, /RECUSARIA/], ['115 CONFERIR_DEPOIS', 1, /antes de conectar/], ['100 APLICAR', 7, /desconhecido/]]) {
    const vistos = [];
    const r = await e.percorrer(ordem, async (p, fase) => {
      vistos.push(`${p.id} ${fase}`);
      return vistos.at(-1) === onde ? {passo: p.id, fase, codigo, resultado: 'X', mensagem: 'MOTIVO_DO_NUCLEO'} : {passo: p.id, fase, codigo: 0, resultado: 'OK'};
    });
    const [passo, fase] = onde.split(' ');
    assert.equal(r.situacao, 'PARADA'); assert.equal(vistos.at(-1), onde);
    assert.deepEqual([r.parada.motivo, r.parada.passo, r.parada.fase, r.parada.codigo, r.parada.mensagem], ['CODIGO_DIFERENTE_DE_ZERO', passo, fase, codigo, 'MOTIVO_DO_NUCLEO']);
    assert.match(r.parada.significado, significado);
    const todas = ordem.PASSOS.flatMap(p => ordem.FASES.map(f => `${p.id} ${f}`));
    assert.deepEqual(vistos, todas.slice(0, todas.indexOf(onde) + 1));
  }
});

test('cliente simulado e núcleo REAL da 089: a falha do CONFERIR para a cadeia no primeiro passo, com relatório em JSON e texto', async () => {
  const {Cliente, registro} = clienteSimulado({outra: () => { throw new Error('falha simulada do banco para fulana@exemplo.test'); }});
  const pasta = path.join(novaPasta(), 'ensaio');
  const {codigo, saida, texto} = await e.principal(['--porta', PORTA, '--banco', BANCO], ENV, {Client: Cliente, pasta});
  assert.equal(codigo, 2); assert.equal(saida.situacao, 'PARADA');
  assert.deepEqual(saida.passos.map(l => [l.passo, l.fase, l.codigo, l.resultado]), [['089', 'CONFERIR', 2, 'FALHA']]);
  assert.deepEqual([saida.parada.passo, saida.parada.fase, saida.parada.codigo], ['089', 'CONFERIR', 2]);
  assert.equal(saida.parada.mensagem, 'falha simulada do banco para <email>');
  assert.deepEqual(saida.contagens, {antes: {tabelas: 3, linhas: {empresas: 2}}, depois: {tabelas: 3, linhas: {empresas: 2}}});
  // Conexões: identidade, contagens antes, o núcleo da 089 (com o nome de ensaio) e contagens depois. Nenhuma outra.
  assert.deepEqual(registro.nomes, ['kidmais-ensaio-identidade', 'kidmais-ensaio-contagens', 'kidmais-migration-089-ensaio', 'kidmais-ensaio-contagens']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(pasta, 'relatorio.json'), 'utf8')), JSON.parse(JSON.stringify(saida)));
  assert.equal(fs.readFileSync(path.join(pasta, 'relatorio.txt'), 'utf8'), texto);
  assert.match(texto, /PAROU: passo 089, fase CONFERIR, código 2/);
  assert.ok(!texto.includes('fulana') && !JSON.stringify(saida).includes('fulana'));
  // Nenhuma escrita foi enviada pelo executor nem pelo núcleo no CONFERIR.
  assert.ok(!registro.consultas.some(sql => /^\s*(BEGIN\s*;?$|COMMIT|CREATE|ALTER|DROP|INSERT|UPDATE|DELETE)/i.test(sql)));
});

test('--so-conferir: o CONFERIR de todos os passos, sem parar na recusa e sem nenhum APLICAR', async () => {
  const {Cliente, registro} = clienteSimulado({outra: () => { throw new Error('sem dados no simulado'); }});
  const {codigo, saida} = await e.principal(['--porta', PORTA, '--banco', BANCO, '--so-conferir'], ENV, {Client: Cliente, pasta: path.join(novaPasta(), 'so')});
  assert.equal(codigo, 0); assert.equal(saida.situacao, 'SO_CONFERIR'); assert.equal(saida.parada, undefined);
  assert.deepEqual(saida.passos.map(l => `${l.passo} ${l.fase}`), ordem.PASSOS.map(p => `${p.id} CONFERIR`));
  assert.ok(registro.nomes.every(n => /-ensaio$|^kidmais-ensaio-/.test(n)));
});

test('relatório: só passo, fase, código, resultado, COMMIT, duração, estado e (107-108) o retrato; nada das contagens ou objetos do núcleo', () => {
  const p = {id: '107-108'};
  const saida = {resultado: 'RECUSARIA', motivo: 'RETRATO_F0_DIVERGENTE ' + 'a'.repeat(64), fase: 'F0', estado: {m107: 'ausente', m108: 'AUSENTE', dono: true, versao_pg: 180006},
    estado107: 'ausente', retrato: {fase: 'F0', hash: 'b'.repeat(64), secoes: {tabelas: {n: 3, sha256: 'c'.repeat(64)}, corpo: {n: 1, sha256: 'texto que não é hash'}}}, conexao: {banco: BANCO}, contagens: {assinaturas: 9},
    contagensAntes: {porEstado: {PAGA: 4}}, sessoes: {outras: 1}, atividade: {locks: 0}, linhas: [{email: 'x@y.test'}]};
  const l = e.linhaDoRelatorio(p, 'CONFERIR', 3, saida, 12.4);
  assert.deepEqual(l, {passo: '107-108', fase: 'CONFERIR', codigo: 3, resultado: 'RECUSARIA', commit: 'NAO_SE_APLICA', duracaoMs: 12, estado: {m107: 'ausente', m108: 'AUSENTE', estado107: 'ausente'},
    faseDoNucleo: 'F0', retrato: {fase: 'F0', hash: 'b'.repeat(64), variante: null, secoes: {tabelas: {n: 3, sha256: 'c'.repeat(64)}}}, mensagem: 'RETRATO_F0_DIVERGENTE ' + 'a'.repeat(64)});
  assert.deepEqual(Object.keys(e.linhaDoRelatorio({id: '089'}, 'APLICAR', 0, {resultado: 'APLICADA_POSTCHECK_PASS', contagensAntes: {assinaturas: 2}, estadoDepois: {m089: 'completa'}}, 1)),
    ['passo', 'fase', 'codigo', 'resultado', 'commit', 'duracaoMs', 'estado']);
  assert.equal(e.semDadosPessoais('a@b.com cpf 123.456.789-09 cnpj 11.222.333/0001-81 tel 5511999998888 id 57618aab-a62c-4be1-9385-17308ac8dda3 hash ' + 'd'.repeat(64)),
    '<email> cpf <documento> cnpj <documento> tel <numero> id <uuid> hash ' + 'd'.repeat(64));
  assert.equal(e.semDadosPessoais(undefined), null);
  assert.equal(e.semDadosPessoais("CODIGO_DO_NUCLEO\n+ actual - expected\n+ 'valor'"), 'CODIGO_DO_NUCLEO', 'só a primeira linha, sem o diff do assert');
});

test('situação do COMMIT: a que o núcleo informou, em qualquer geração de núcleo; nunca "confirmado" inventado', () => {
  assert.equal(e.commitDe('CONFERIR', {commit: 'CONFIRMADO'}), 'NAO_SE_APLICA');
  assert.equal(e.commitDe('APLICAR', {resultado: 'FALHA', commit: 'INDETERMINADO'}), 'INDETERMINADO');
  assert.deepEqual(e.commitDe('APLICAR', {resultado: 'FALHA', commits: {107: 'CONFIRMADO', 108: 'NAO_COMMITADA'}}), {107: 'CONFIRMADO', 108: 'NAO_COMMITADA'});
  assert.deepEqual(e.commitDe('APLICAR', {resultado: 'FALHA', migracoesCommitadas: ['092'], migracaoIndeterminada: '093'}), {confirmadas: ['092'], indeterminada: '093'});
  assert.equal(e.commitDe('APLICAR', {resultado: 'FALHA', migracaoCommitada: false}), 'SEM_CONFIRMACAO_DO_NUCLEO');
  assert.equal(e.commitDe('APLICAR', {resultado: 'FALHA', migracaoCommitada: true}), 'CONFIRMADO');
  assert.equal(e.commitDe('APLICAR', {resultado: 'APLICADA_POSTCHECK_PASS'}), 'CONFIRMADO_PELO_RESULTADO');
  assert.equal(e.commitDe('APLICAR', {resultado: 'JA_APLICADA_POSTCHECK_PASS', commits: {}}), 'NADA_A_COMMITAR');
  assert.equal(e.commitDe('APLICAR', {resultado: 'FALHA', commits: {}}), 'NAO_INFORMADA');
  assert.equal(e.commitDe('APLICAR', {resultado: 'RECUSADO'}), 'NAO_INFORMADA');
});

test('plano (sem argumentos): não conecta, lista os passos da ordem, os valores de ensaio e o que não é exercido', async () => {
  const {codigo, saida} = await e.principal([], {RENDER: 'true', DATABASE_URL: 'x'}, {Client: class { constructor() { throw new Error('não pode conectar'); } }});
  assert.equal(codigo, 0); assert.equal(saida.conecta, false);
  assert.deepEqual(saida.passos.map(p => p.passo), ordem.PASSOS.map(p => p.id));
  assert.ok(saida.valoresDeEnsaio.some(v => /backup/.test(v)) && saida.valoresDeEnsaio.some(v => /drenagem/.test(v)) && saida.valoresDeEnsaio.some(v => /109/.test(v))
    && saida.valoresDeEnsaio.some(v => /WHATSAPP_ATENDIMENTO_MULTIEMPRESA/.test(v)));
  assert.match(e.REGISTRO_BACKUP, /^[A-Za-z0-9:._/ -]{6,120}$/); assert.match(e.REGISTRO_DRENAGEM, /^[A-Za-z0-9:._/ -]{6,120}$/);
});

test('o executor não importa adaptador de production nem de staging e não lê DATABASE_URL', () => {
  const fonte = fs.readFileSync(path.join(__dirname, 'ensaio-promocao-local.cjs'), 'utf8');
  assert.ok(!/require\([^)]*-(?:production|staging)\.cjs/.test(fonte.replace(/promocao-production-ordem\.cjs/g, '')), 'só a ordem e, pelo passo, o genérico');
  assert.ok(!/env\.DATABASE_URL|connectionString/.test(fonte));
  assert.equal((fonte.match(/process\.env/g) ?? []).length, 1, 'process.env só na CLI');
});

test('pasta do ensaio: nova por execução; uma pasta informada com conteúdo recusa', () => {
  const p = novaPasta();
  assert.equal(e.prepararPasta(path.join(p, 'nova')), path.join(p, 'nova'));
  fs.writeFileSync(path.join(p, 'nova', 'x'), '');
  recusa(() => e.prepararPasta(path.join(p, 'nova')), /PASTA_DO_ENSAIO_NAO_VAZIA/);
  const padrao = e.prepararPasta(null); pastas.push(padrao);
  assert.ok(padrao.startsWith(os.tmpdir()) && fs.readdirSync(padrao).length === 0);
});
