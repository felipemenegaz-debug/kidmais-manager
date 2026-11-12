/* eslint-disable @typescript-eslint/no-require-imports */
// ENSAIO LOCAL da promoção de staging para production (12/11/2026): percorre a cadeia de scripts/promocao-production-ordem.cjs
// num PostgreSQL DESCARTÁVEL local — uma cópia restaurada do banco de production ou um banco sintético — usando os MESMOS
// núcleos dos aplicadores (scripts/migration-<n>-comum.cjs) com um adaptador de ENSAIO no lugar do adaptador de production.
// Os adaptadores de production só aceitam o banco de production, de propósito; este arquivo nunca os usa e nunca conecta
// fora de 127.0.0.1. Não é autorização de nada em production nem em staging.
//   - alvo: só 127.0.0.1/localhost, porta e banco informados, com a autorização de descartável das suítes PostgreSQL
//     (KIDMAIS_POSTGRES_DESCARTAVEL, KIDMAIS_DESCARTAVEL_PORTA e KIDMAIS_DESCARTAVEL_AUTORIZACAO=127.0.0.1:<porta>/<banco>).
//     Recusa ANTES de conectar: host fora do loopback, banco com nome de production/staging/sistema, portas dos clusters
//     reais desta máquina, RENDER*, *DATABASE_URL e PG* no ambiente, autorização ausente ou divergente;
//   - identidade no servidor (como as suítes): banco, 127.0.0.1, porta, papel e cluster_name = kidmais_descartavel, e o
//     cluster sem banco com nome de production, staging ou do banco real local. Cada núcleo repete essa prova na própria
//     conexão (é a `identidade` do adaptador de ensaio);
//   - cadeia: `proximoPasso` decide; para cada passo CONFERIR → APLICAR → CONFERIR_DEPOIS pelo `principal` do núcleo, com
//     as flags do próprio passo. Qualquer código diferente de 0 PARA e diz passo, fase, código e mensagem do núcleo;
//   - 120, 121, 110, 111 e 115: a lógica é a do aplicador genérico (conferirNoCliente e aplicarNoCliente exportados, que
//     aceitam a identidade do alvo). O `conferir` e o `executar` dele são presos a production; aqui só o envelope (conexão,
//     marcador exclusivo e registro da falha) é do ensaio;
//   - valores de ENSAIO no lugar do que production satisfaz pelo ambiente: listados em VALORES_DE_ENSAIO e copiados no
//     relatório. Nenhuma verificação de núcleo é desligada;
//   - relatório (JSON e texto): passo, fase, resultado, código, situação do COMMIT, duração, estado por migration (só
//     rótulos) e contagens agregadas (número de tabelas e linhas por tabela, ANTES e DEPOIS). NUNCA conteúdo de linha: a
//     cópia real tem dados pessoais. A mensagem do núcleo, quando há parada, passa por `semDadosPessoais`.
//   node scripts/ensaio-promocao-local.cjs                                              → plano, sem conexão
//   node --experimental-strip-types scripts/ensaio-promocao-local.cjs --porta <p> --banco <b> --so-conferir
//   node --experimental-strip-types scripts/ensaio-promocao-local.cjs --porta <p> --banco <b>   → a cadeia inteira
// (--experimental-strip-types: o núcleo da 109 importa o contrato TypeScript do cron.) Roteiro: docs/ENSAIO_PROMOCAO_LOCAL_20261112.md.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {exigirOptInDescartavel, variavelDeConexaoHerdada} = require('./regressao-v1-selecao.cjs');

const HOSTS_ACEITOS = Object.freeze(['127.0.0.1', 'localhost']);
const HOST = '127.0.0.1';
/** Papel do initdb e cluster_name do cluster descartável (os mesmos das suítes PostgreSQL). */
const PAPEL = 'kidmais_descartavel';
const CLUSTER = 'kidmais_descartavel';
/** Nomes que o banco do ensaio nunca pode ter: production, staging, o banco real local e os de sistema. */
const BANCOS_RECUSADOS = Object.freeze(['kidmais_production', 'kidmais_staging_1z91', 'kidmais_manager', 'postgres', 'template0', 'template1']);
/** Clusters reais desta máquina: nunca são alvo, mesmo com autorização. */
const PORTAS_RECUSADAS = Object.freeze([5432, 5433]);
const REGISTRO_BACKUP = 'ENSAIO-LOCAL sem backup - banco descartavel';
const REGISTRO_DRENAGEM = 'ENSAIO-LOCAL sem web nem cron - banco descartavel';
/** O env que os núcleos recebem: só isto. O env do processo nunca é repassado. */
const ENV_DOS_NUCLEOS = Object.freeze({WHATSAPP_ATENDIMENTO_MULTIEMPRESA: 'false'});
/** O que production satisfaz pelo ambiente e o ensaio fornece de outro jeito (vai inteiro para o relatório). */
const VALORES_DE_ENSAIO = Object.freeze([
  `registro de backup (todos os passos): "${REGISTRO_BACKUP}" — não há backup; o banco é descartável`,
  `registro de drenagem (107-108): "${REGISTRO_DRENAGEM}" — não há web nem cron; o núcleo continua conferindo atividade e sessões no servidor`,
  '109 (cron suspenso e sem sessão de renovação): não há cron no cluster local; a contagem de sessões kidmais-renovacao* do núcleo continua valendo',
  '117: WHATSAPP_ATENDIMENTO_MULTIEMPRESA="false" no env entregue ao núcleo (o env do processo não é repassado)',
  'alvo e identidade: banco local, 127.0.0.1, papel e cluster_name kidmais_descartavel, no lugar de TLS e rede privada de production',
  'disco persistente: pasta do ensaio (marcadores em <pasta>/marcadores/<passo>) no lugar do disco do Render',
  'retratos da 107-108: só as variantes do arquivo de esperados (aceitaRetratosTeste: false, como staging e production)',
]);
/** O que production exige e o ensaio NÃO exercita (é do adaptador de production, do bloco de Shell ou do deploy). */
const NAO_EXERCIDO = Object.freeze([
  'travas de alvo, TLS e disco dos adaptadores de production e a conferência de sha256 dos blocos de Shell',
  '094: o deploy do código novo antes do passo (exigeAntes) não se aplica a um banco sem aplicação',
  '118: a regra do adaptador de production para o registro "PITR <AAAA-MM-DDTHH:MMZ> <referencia>" (janela de 2 h) e a exceção de TLS',
  'IMPORTACAO_COTA_DISPENSADA e RENDER_GIT_COMMIT: ausentes no env entregue aos núcleos (118 informa AUSENTE; 114 informa commit nulo)',
]);
/** Núcleos aceitos (lista fechada): passo cujo aplicador não esteja aqui PARA antes de rodar. Extras = os do adaptador de production. */
const NUCLEOS = Object.freeze({'089': {}, '090': {}, '091': {}, '092-094': {escopos: ['092-093', '094']}, '095': {}, '096': {}, '097': {}, '100': {},
  '102-103': {}, '104-106': {}, '107-108': {aceitaRetratosTeste: false}, '109': {}, '112': {}, '114': {}, '116': {}, '117': {}, '118': {}});
/** Tabelas contadas ANTES e DEPOIS (só as que existirem; lista fixa, nomes do próprio schema). */
const TABELAS_PRINCIPAIS = Object.freeze(['empresas', 'estabelecimentos', 'usuarios_administrativos', 'clientes', 'pacotes', 'precos_pacote', 'fechamentos',
  'fechamento_revisoes', 'contratos', 'contrato_fluxos', 'configuracao_agenda', 'bloqueios_agenda', 'agenda_saloes', 'agenda_escopo_config',
  'adicional_categorias', 'empresa_assinaturas', 'assinatura_renovacoes', 'assinatura_encerramentos', 'ia_documentos', 'ia_importacao_cotas',
  'whatsapp_atendimento_mensagens', 'marketing_automacao_regras', 'kidmais107_reparos', 'financeiro_aberturas', 'satisfacao_envios']);

const SQL_IDENTIDADE = `SELECT current_database() AS db, current_setting('cluster_name') AS cluster, host(inet_server_addr()) AS addr,
  inet_server_port() AS port, current_user AS papel, current_setting('server_version_num')::int AS versao_pg,
  EXISTS (SELECT 1 FROM pg_catalog.pg_database WHERE lower(datname) IN ('kidmais_production', 'kidmais_staging_1z91', 'kidmais_manager')) AS tem_real`;
/** Só agregados: número de tabelas de public e count(*) de cada tabela da lista que existir. Nenhuma coluna de dados é lida. */
const SQL_CONTAGENS = `SELECT
  (SELECT count(*)::int FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')) AS tabelas,
  (SELECT coalesce(jsonb_object_agg(t, (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM public.%I', t), false, true, '')))[1]::text::bigint ORDER BY t), '{}'::jsonb)
     FROM unnest($1::text[]) AS t WHERE to_regclass(format('public.%I', t)) IS NOT NULL) AS linhas`;

const curta = e => String(e?.message ?? e).replace(/postgres(?:ql)?:\/\/\S+/gi, '<url>').slice(0, 300);
/**
 * Cinto de segurança da mensagem do núcleo (que já sai sem ids nem dados): e-mail, UUID, CPF/CNPJ e sequências longas de
 * dígitos viram marcas; só a primeira linha sai (o assert do Node acrescenta um diff de valores nas seguintes). Hashes
 * hexadecimais (com letras) ficam, porque identificam retratos e corpos de função.
 */
function semDadosPessoais(texto) {
  if (texto === undefined || texto === null) return null;
  return String(texto).split(/\r?\n/)[0].replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '<email>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b|\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/g, '<documento>')
    .replace(/\b\d{9,}\b/g, '<numero>').slice(0, 300);
}

/** Argumentos estritos: nenhum (plano) ou --porta e --banco, com --host, --pasta e --so-conferir opcionais. Nada repetido. */
function lerArgumentos(argv) {
  if (argv.length === 0) return {modo: 'plano'};
  const r = {modo: 'ensaio', host: HOST, porta: null, banco: null, pasta: null};
  const vistos = new Set(), lista = [...argv];
  while (lista.length) {
    const a = lista.shift();
    assert.ok(!vistos.has(a), 'ARGUMENTO_REPETIDO ' + a);
    vistos.add(a);
    if (a === '--so-conferir') { r.modo = 'so-conferir'; continue; }
    assert.ok(['--host', '--porta', '--banco', '--pasta'].includes(a), 'ARGUMENTOS_RECUSADOS');
    const v = lista.shift();
    assert.ok(typeof v === 'string' && v !== '' && !v.startsWith('--'), 'ARGUMENTO_SEM_VALOR ' + a);
    r[a.slice(2)] = v;
  }
  assert.ok(r.porta !== null && r.banco !== null, 'PORTA_E_BANCO_OBRIGATORIOS');
  return r;
}

/** Nada que escolha outro destino pode existir no processo: Render, qualquer *DATABASE_URL e qualquer PG* do driver. */
function exigirAmbiente(env) {
  const recusadas = Object.keys(env).filter(n => /^RENDER/i.test(n) || /DATABASE_URL$/i.test(n) || variavelDeConexaoHerdada(n)).sort();
  assert.ok(recusadas.length === 0, 'AMBIENTE_RECUSADO ' + recusadas.join(' '));
}
/** A autorização das suítes PostgreSQL, com o banco informado: opt-in, porta e o literal 127.0.0.1:<porta>/<banco>. */
function exigirAutorizacao(env, porta, banco) {
  try { exigirOptInDescartavel(env); } catch { assert.fail('AUTORIZACAO_AUSENTE KIDMAIS_POSTGRES_DESCARTAVEL'); }
  assert.ok(env.KIDMAIS_DESCARTAVEL_PORTA === String(porta), 'AUTORIZACAO_RECUSADA KIDMAIS_DESCARTAVEL_PORTA');
  assert.ok(env.KIDMAIS_DESCARTAVEL_AUTORIZACAO === `${HOST}:${porta}/${banco}`, 'AUTORIZACAO_RECUSADA KIDMAIS_DESCARTAVEL_AUTORIZACAO=' + HOST + ':<porta>/<banco>');
}
/** Alvo validado, sem conectar. Mensagens = só o código (e nomes de variáveis, nunca valores). */
function exigirAlvo({host = HOST, porta, banco}, env) {
  assert.ok(HOSTS_ACEITOS.includes(host), 'HOST_RECUSADO');
  assert.ok(typeof porta === 'string' && /^[0-9]{4,5}$/.test(porta), 'PORTA_RECUSADA');
  const p = Number(porta);
  assert.ok(p >= 1024 && p <= 65535 && !PORTAS_RECUSADAS.includes(p), 'PORTA_RECUSADA');
  assert.ok(typeof banco === 'string' && /^[a-z_][a-z0-9_]{0,62}$/.test(banco), 'BANCO_RECUSADO');
  assert.ok(!BANCOS_RECUSADOS.includes(banco), 'BANCO_RECUSADO');
  exigirAmbiente(env);
  exigirAutorizacao(env, p, banco);
  return Object.freeze({host: HOST, porta: p, banco});
}

/** O cluster descartável usa trust em 127.0.0.1: pedido de senha = destino divergente; nenhuma credencial é carregada. */
const senhaRecusada = () => Promise.reject(new Error('SERVIDOR_PEDIU_SENHA'));
const opcoesCliente = (alvo, applicationName) => ({host: alvo.host, port: alvo.porta, user: PAPEL, database: alvo.banco, password: senhaRecusada,
  application_name: applicationName, connectionTimeoutMillis: 10000});
/** Identidade provada no servidor; devolve só rótulos. */
function identidade(l, alvo) {
  assert.ok(l?.db === alvo.banco, 'BANCO_DIVERGENTE');
  assert.ok(l.cluster === CLUSTER, 'CLUSTER_DIVERGENTE');
  assert.ok(l.addr === HOST && Number(l.port) === alvo.porta, 'SERVIDOR_DIVERGENTE');
  assert.ok(l.papel === PAPEL, 'PAPEL_DIVERGENTE');
  assert.ok(l.tem_real === false, 'CLUSTER_COM_BANCO_REAL');
  return {banco: l.db, cluster: l.cluster, local: true, versaoPg: l.versao_pg};
}
/** Adaptador de ENSAIO de um passo: o mesmo contrato dos adaptadores de staging e production, preso ao alvo local validado. */
function ambienteDeEnsaio(alvo, id, pasta, extras = {}) {
  const marcadores = path.join(pasta, 'marcadores');
  return {nome: 'ensaio-local', ALVO: Object.freeze({servico: 'ensaio-local', host: alvo.host, database: alvo.banco, port: alvo.porta}),
    DIR: path.join(marcadores, id), SQL_IDENTIDADE, alvo: () => opcoesCliente(alvo, `kidmais-migration-${id}-ensaio`), identidade: l => identidade(l, alvo),
    exigirDisco: () => {
      let st; try { st = fs.lstatSync(marcadores); } catch { st = null; }
      assert.ok(st && st.isDirectory() && !st.isSymbolicLink(), 'PASTA_DO_ENSAIO_AUSENTE');
    }, ...extras};
}

/**
 * 120, 121, 110, 111 e 115: conferência e aplicação são as do genérico (conferirNoCliente e aplicarNoCliente), com a
 * identidade do ensaio. Daqui só o envelope: conexão, marcador exclusivo na pasta do ensaio e o registro da falha.
 */
function principalGenerico(gen, {amb, raiz, Client}) {
  const situacoes = (r, id) => Object.fromEntries((r?.etapas ?? []).filter(x => x.commit).map(x => [id, x.commit]));
  const comum = id => ({id, raiz, sqlIdentidade: amb.SQL_IDENTIDADE, identidade: amb.identidade});
  async function conferir(id) {
    const db = new Client(amb.alvo()); db.on?.('error', () => undefined);
    try { await db.connect(); return await gen.conferirNoCliente(db, comum(id)); }
    catch (e) { await db.query('ROLLBACK').catch(() => {}); return {modo: 'conferencia', id, resultado: 'FALHA', mensagem: curta(e)}; }
    finally { await db.end().catch(() => {}); }
  }
  async function executar(id, backup) {
    const opts = amb.alvo(); amb.exigirDisco();
    gen.carregar(raiz, id);
    fs.mkdirSync(amb.DIR, {recursive: true, mode: 0o700});
    const marcador = path.join(amb.DIR, gen.marcadorDe(id));
    const registro = {inicio: new Date().toISOString(), ambiente: amb.nome, id, backup, situacao: 'INICIADA'};
    try { fs.writeFileSync(marcador, JSON.stringify(registro, null, 2), {flag: 'wx', mode: 0o600}); }
    catch (e) { if (e?.code === 'EEXIST') assert.fail('TENTATIVA_ANTERIOR_REVISAR ' + marcador); throw e; }
    const salvar = r => fs.writeFileSync(marcador, JSON.stringify({...registro, ...r}, null, 2), {mode: 0o600});
    let ultimo = {id};
    const db = new Client(opts); db.on?.('error', () => undefined);
    try {
      await db.connect();
      const r = await gen.aplicarNoCliente(db, {...comum(id), registrar: x => { ultimo = JSON.parse(JSON.stringify(x)); salvar({...ultimo, situacao: 'EM_ANDAMENTO'}); }});
      salvar({...r, situacao: 'CONCLUIDA', commits: situacoes(r, id)});
      return {resultado: r.resultado, id, marcador, estadoAntes: r.estadoAntes, estadoDepois: r.estadoDepois, commits: situacoes(r, id)};
    } catch (e) {
      const falha = {etapa: ultimo.etapas?.at(-1)?.nome ?? 'CONEXAO', mensagem: curta(e)};
      try { salvar({...ultimo, situacao: 'FALHA', falha, commits: situacoes(ultimo, id)}); } catch { /* a saída abaixo leva a situação do COMMIT */ }
      return {resultado: 'FALHA', id, marcador, falha, commits: situacoes(ultimo, id)};
    } finally { await db.end().catch(() => {}); }
  }
  return async argv => {
    const m = gen.modo(argv);
    assert.ok(m.modo === 'conferir' || m.modo === 'aplicar', 'ARGUMENTOS_RECUSADOS');
    const s = m.modo === 'conferir' ? await conferir(m.id) : await executar(m.id, m.backup);
    return {codigo: gen.CODIGO[s.resultado] ?? 2, saida: s};
  };
}

/** `principal(argv)` do passo: o do núcleo, com o adaptador de ensaio; ou o envelope do genérico. */
function principalDoPasso(p, {alvo, pasta, raiz, Client, carregar = require}) {
  if (p.aplicador === 'generico') {
    const gen = carregar('./' + path.basename(p.arquivo));
    return principalGenerico(gen, {amb: ambienteDeEnsaio(alvo, p.id, pasta), raiz, Client});
  }
  const m = /^scripts\/migration-([0-9]{3}(?:-[0-9]{3})?)-production\.cjs$/.exec(String(p.aplicador));
  assert.ok(m && Object.hasOwn(NUCLEOS, m[1]), 'PASSO_SEM_NUCLEO_DE_ENSAIO ' + p.id);
  const {criarAplicador} = carregar(`./migration-${m[1]}-comum.cjs`);
  const aplicador = criarAplicador(ambienteDeEnsaio(alvo, p.id, pasta, NUCLEOS[m[1]]));
  return argv => aplicador.principal(argv, ENV_DOS_NUCLEOS, {raiz, Client});
}
/** Linha de comando do passo na fase: as flags do próprio passo, com os registros de ensaio no APLICAR. */
function argumentos(p, fase) {
  if (fase !== 'APLICAR') return p.conferir.split(' ');
  return [...p.aplicar.split(' '), '--backup', REGISTRO_BACKUP, ...(p.aposBackup ? [p.aposBackup.split(' ')[0], REGISTRO_DRENAGEM] : [])];
}

/** Situação do COMMIT como o núcleo a informou (o formato muda entre as gerações de núcleo); nunca inventa "confirmado". */
function commitDe(fase, saida) {
  if (fase !== 'APLICAR') return 'NAO_SE_APLICA';
  if (typeof saida?.commit === 'string') return saida.commit;
  if (saida?.commits && Object.keys(saida.commits).length) return saida.commits;
  if (Array.isArray(saida?.migracoesCommitadas)) return {confirmadas: saida.migracoesCommitadas, indeterminada: saida.migracaoIndeterminada ?? null};
  if (typeof saida?.migracaoCommitada === 'boolean') return saida.migracaoCommitada ? 'CONFIRMADO' : 'SEM_CONFIRMACAO_DO_NUCLEO';
  if (/^APLICADA_/.test(String(saida?.resultado))) return 'CONFIRMADO_PELO_RESULTADO';
  if (/^JA_APLICADA/.test(String(saida?.resultado))) return 'NADA_A_COMMITAR';
  return 'NAO_INFORMADA';
}
/** Estado por migration, só rótulos: chaves m<nnn> dos núcleos, a situação do genérico e o estado da 107. */
function estadoDe(saida) {
  const e = saida?.estado ?? saida?.estadoDepois ?? saida?.estadoAntes;
  const r = {};
  for (const [k, v] of Object.entries(e ?? {})) if ((/^m[0-9]{3}[a-z]?$/.test(k) || k === 'situacao') && typeof v === 'string') r[k] = v;
  if (typeof saida?.estado107 === 'string') r.estado107 = saida.estado107;
  return Object.keys(r).length ? r : null;
}
const HEX64 = /^[0-9a-f]{64}$/;
/** Resumo do retrato por seção, como o núcleo o sanitiza: quantidade e sha256 (sem corpos nem literais). É o que permite o diff entre dois bancos. */
function secoesDe(secoes) {
  if (!secoes || typeof secoes !== 'object') return null;
  return Object.fromEntries(Object.entries(secoes).filter(([, v]) => Number.isInteger(v?.n) && HEX64.test(String(v?.sha256))).map(([k, v]) => [String(k).slice(0, 60), {n: v.n, sha256: v.sha256}]));
}
/** Linha do relatório: só o que pode sair (nada das contagens nem dos objetos do núcleo é copiado). */
function linhaDoRelatorio(p, fase, codigo, saida, duracaoMs) {
  const linha = {passo: p.id, fase, codigo, resultado: typeof saida?.resultado === 'string' ? saida.resultado : 'SEM_RESULTADO', commit: commitDe(fase, saida),
    duracaoMs: Math.round(duracaoMs), estado: estadoDe(saida)};
  // 107-108: a fase e o retrato medido (hash do catálogo e variante reconhecida) são o que a cópia real precisa mostrar.
  if (typeof saida?.fase === 'string') linha.faseDoNucleo = saida.fase;
  if (saida?.retrato && typeof saida.retrato === 'object') linha.retrato = {fase: String(saida.retrato.fase ?? ''),
    hash: HEX64.test(String(saida.retrato.hash)) ? saida.retrato.hash : null, variante: typeof saida.retrato.variante === 'string' ? saida.retrato.variante : null, secoes: secoesDe(saida.retrato.secoes)};
  if (codigo !== 0) {
    linha.mensagem = semDadosPessoais(saida?.motivo ?? saida?.mensagem ?? saida?.falha?.mensagem ?? 'sem mensagem do núcleo');
    if (typeof saida?.falha?.etapa === 'string') linha.etapa = saida.falha.etapa;
  }
  return linha;
}
/** Roda uma fase de um passo. Recusa lançada antes de conectar = código 1, como na CLI dos aplicadores. */
async function rodarFase(p, fase, ctx) {
  const inicio = performance.now();
  let codigo, saida;
  try { ({codigo, saida} = await principalDoPasso(p, ctx)(argumentos(p, fase))); }
  catch (e) { codigo = 1; saida = {resultado: 'RECUSADO', mensagem: curta(e)}; }
  return linhaDoRelatorio(p, fase, Number.isInteger(codigo) ? codigo : 2, saida, performance.now() - inicio);
}

/**
 * A cadeia inteira: `proximoPasso` recebe os resultados já obtidos e diz o próximo, CONCLUIDA ou PARAR. Nada é pulado nem
 * repetido; a primeira fase com código diferente de 0 encerra.
 */
async function percorrer(ordem, rodar) {
  const resultados = [], linhas = [];
  for (;;) {
    const prox = ordem.proximoPasso(resultados);
    if (prox.acao === 'CONCLUIDA') return {situacao: 'CONCLUIDA', linhas};
    if (prox.acao !== 'EXECUTAR') {
      const ultima = linhas.at(-1) ?? null;
      return {situacao: 'PARADA', linhas, parada: {motivo: prox.motivo, passo: prox.id ?? ultima?.passo ?? null, fase: prox.fase ?? ultima?.fase ?? null,
        codigo: prox.codigo ?? ultima?.codigo ?? null, significado: prox.significado ?? null, mensagem: ultima?.mensagem ?? null}};
    }
    const p = ordem.PASSOS.find(x => x.id === prox.id);
    assert.ok(p, 'PASSO_DESCONHECIDO ' + prox.id);
    const linha = await rodar(p, prox.fase);
    linhas.push(linha);
    resultados.push({id: prox.id, fase: prox.fase, codigo: linha.codigo});
  }
}
/** --so-conferir: o CONFERIR de TODOS os passos, na ordem, sem parar e sem aplicar nada (diagnóstico do estado). */
async function soConferir(ordem, rodar) {
  const linhas = [];
  for (const p of ordem.PASSOS) linhas.push(await rodar(p, 'CONFERIR'));
  return {situacao: 'SO_CONFERIR', linhas};
}

/** Conexão própria do executor (identidade e contagens): aberta e fechada FORA das fases, para não contar como sessão. */
async function comCliente(alvo, Client, nome, trabalho) {
  const db = new Client(opcoesCliente(alvo, nome)); db.on?.('error', () => undefined);
  await db.connect();
  try {
    await db.query('BEGIN TRANSACTION READ ONLY');
    try {
      await db.query("SET LOCAL statement_timeout = '120s'");
      const id = identidade((await db.query(SQL_IDENTIDADE)).rows[0], alvo);
      return await trabalho(db, id);
    } finally { await db.query('ROLLBACK').catch(() => {}); }
  } finally { await db.end().catch(() => {}); }
}
const provarIdentidade = (alvo, Client) => comCliente(alvo, Client, 'kidmais-ensaio-identidade', async (_db, id) => id);
/** Contagens agregadas: número de tabelas e linhas por tabela principal. */
async function contar(alvo, Client) {
  return comCliente(alvo, Client, 'kidmais-ensaio-contagens', async db => {
    const l = (await db.query(SQL_CONTAGENS, [TABELAS_PRINCIPAIS])).rows[0];
    assert.ok(Number.isInteger(l?.tabelas) && l.linhas && typeof l.linhas === 'object', 'CONTAGENS_ILEGIVEIS');
    return {tabelas: l.tabelas, linhas: Object.fromEntries(Object.entries(l.linhas).map(([t, n]) => [t, Number(n)]))};
  });
}

const segundos = ms => (ms / 1000).toFixed(1) + ' s';
const textoDe = v => (v === null || v === undefined ? '-' : typeof v === 'string' ? v : Object.entries(v).map(([k, x]) => `${k}=${Array.isArray(x) ? x.join('+') || '-' : x}`).join(' '));
/** Relatório em texto: as mesmas informações do JSON, uma linha por fase. */
function relatorioTexto(r) {
  const L = [`ENSAIO LOCAL DA PROMOÇÃO — modo ${r.modo} — situação ${r.situacao}`,
    `alvo ${r.alvo.host}:${r.alvo.porta}/${r.alvo.banco} · PostgreSQL ${Math.floor(r.versaoPg / 10000)}.${r.versaoPg % 10000} · início ${r.inicio} · fim ${r.fim}`, '',
    'passo | fase | código | resultado | COMMIT | duração | estado', '---|---|---|---|---|---|---'];
  for (const l of r.passos) {
    L.push(`${l.passo} | ${l.fase} | ${l.codigo} | ${l.resultado} | ${textoDe(l.commit)} | ${segundos(l.duracaoMs)} | ${textoDe(l.estado)}`
      + (l.retrato ? ` | retrato ${l.retrato.fase} ${l.retrato.variante ?? 'SEM_VARIANTE'} ${l.retrato.hash ?? ''}` : ''));
    if (l.mensagem) L.push(`    ↳ ${l.etapa ? l.etapa + ': ' : ''}${l.mensagem}`);
  }
  if (r.parada) L.push('', `PAROU: passo ${r.parada.passo}, fase ${r.parada.fase}, código ${r.parada.codigo} (${r.parada.motivo}${r.parada.significado ? ': ' + r.parada.significado : ''})`,
    `mensagem do núcleo: ${r.parada.mensagem ?? '-'}`);
  L.push('', `tabelas em public: ${r.contagens.antes.tabelas} antes, ${r.contagens.depois.tabelas} depois`, 'linhas por tabela (antes → depois):');
  const nomes = [...new Set([...Object.keys(r.contagens.antes.linhas), ...Object.keys(r.contagens.depois.linhas)])].sort();
  for (const t of nomes) L.push(`  ${t}: ${r.contagens.antes.linhas[t] ?? 'ausente'} → ${r.contagens.depois.linhas[t] ?? 'ausente'}`);
  L.push('', 'valores de ensaio (no lugar do que production satisfaz pelo ambiente):', ...r.valoresDeEnsaio.map(x => '  - ' + x),
    '', 'não exercido pelo ensaio:', ...r.naoExercido.map(x => '  - ' + x), '');
  return L.join('\n');
}

/** Pasta do ensaio (relatório e marcadores): nova por execução; uma pasta informada precisa não existir ou estar vazia. */
function prepararPasta(pasta) {
  if (pasta === null || pasta === undefined) return fs.mkdtempSync(path.join(os.tmpdir(), 'kidmais-ensaio-promocao-'));
  const p = path.resolve(pasta);
  fs.mkdirSync(p, {recursive: true});
  assert.ok(fs.readdirSync(p).length === 0, 'PASTA_DO_ENSAIO_NAO_VAZIA');
  return p;
}

function plano(ordem) {
  return {resultado: 'PLANO', conecta: false, ambiente: 'ensaio-local',
    uso: ['node --experimental-strip-types scripts/ensaio-promocao-local.cjs --porta <porta> --banco <banco> --so-conferir',
      'node --experimental-strip-types scripts/ensaio-promocao-local.cjs --porta <porta> --banco <banco> [--pasta <pasta-nova>]'],
    autorizacao: ['KIDMAIS_POSTGRES_DESCARTAVEL=kidmais_pacotes_v1_descartavel', 'KIDMAIS_DESCARTAVEL_PORTA=<porta>', `KIDMAIS_DESCARTAVEL_AUTORIZACAO=${HOST}:<porta>/<banco>`],
    recusas: ['host fora de 127.0.0.1/localhost', 'banco ' + BANCOS_RECUSADOS.join(', '), 'porta ' + PORTAS_RECUSADAS.join(', '), 'RENDER*, *DATABASE_URL ou PG* no ambiente',
      `servidor sem cluster_name ${CLUSTER}, papel ${PAPEL} ou com banco real no cluster`],
    passos: ordem.PASSOS.map(p => ({passo: p.id, migrations: p.migrations, aplicador: p.aplicador === 'generico' ? p.arquivo : p.aplicador,
      conferir: argumentos(p, 'CONFERIR').join(' '), aplicar: argumentos(p, 'APLICAR').join(' ')})),
    valoresDeEnsaio: VALORES_DE_ENSAIO, naoExercido: NAO_EXERCIDO, tabelasContadas: TABELAS_PRINCIPAIS};
}

/**
 * Códigos: 0 plano, --so-conferir concluído ou cadeia CONCLUIDA; 1 recusa antes de qualquer passo (lançada); 2 cadeia PARADA.
 * `deps` (testes): Client, raiz, ordem, pasta e carregar.
 */
async function principal(argv, env, deps = {}) {
  const ordem = deps.ordem ?? require('./promocao-production-ordem.cjs');
  const args = lerArgumentos(argv);
  if (args.modo === 'plano') return {codigo: 0, saida: plano(ordem)};
  const alvo = exigirAlvo(args, env);
  const Client = deps.Client ?? require('pg').Client;
  const raiz = deps.raiz ?? path.resolve(__dirname, '..');
  const inicio = new Date().toISOString();
  const id = await provarIdentidade(alvo, Client);
  const pasta = prepararPasta(deps.pasta ?? args.pasta);
  fs.mkdirSync(path.join(pasta, 'marcadores'), {recursive: true});
  const antes = await contar(alvo, Client);
  const rodar = (p, fase) => rodarFase(p, fase, {alvo, pasta, raiz, Client, carregar: deps.carregar});
  const feito = args.modo === 'so-conferir' ? await soConferir(ordem, rodar) : await percorrer(ordem, rodar);
  const depois = await contar(alvo, Client);
  const relatorio = {ferramenta: 'ensaio-promocao-local', modo: args.modo, situacao: feito.situacao, alvo, versaoPg: id.versaoPg, inicio, fim: new Date().toISOString(),
    passos: feito.linhas, ...(feito.parada ? {parada: feito.parada} : {}), contagens: {antes, depois}, valoresDeEnsaio: VALORES_DE_ENSAIO, naoExercido: NAO_EXERCIDO};
  const texto = relatorioTexto(relatorio);
  fs.writeFileSync(path.join(pasta, 'relatorio.json'), JSON.stringify(relatorio, null, 2));
  fs.writeFileSync(path.join(pasta, 'relatorio.txt'), texto);
  return {codigo: feito.situacao === 'PARADA' ? 2 : 0, saida: relatorio, texto, pasta};
}
function cli() {
  principal(process.argv.slice(2), process.env).then(({codigo, saida, texto, pasta}) => {
    if (texto === undefined) console.log(JSON.stringify(saida, null, 2));
    else console.log(texto + '\nrelatório: ' + path.join(pasta, 'relatorio.json') + ' e relatorio.txt (marcadores dos núcleos em ' + path.join(pasta, 'marcadores') + ')');
    process.exitCode = codigo;
  }).catch(e => { console.error('RECUSADO ' + curta(e)); process.exitCode = 1; });
}

if (require.main === module) cli();
module.exports = {HOST, PAPEL, CLUSTER, BANCOS_RECUSADOS, PORTAS_RECUSADAS, REGISTRO_BACKUP, REGISTRO_DRENAGEM, ENV_DOS_NUCLEOS, VALORES_DE_ENSAIO, NAO_EXERCIDO, NUCLEOS,
  TABELAS_PRINCIPAIS, SQL_IDENTIDADE, SQL_CONTAGENS, semDadosPessoais, lerArgumentos, exigirAmbiente, exigirAutorizacao, exigirAlvo, opcoesCliente, identidade,
  ambienteDeEnsaio, principalGenerico, principalDoPasso, argumentos, commitDe, estadoDe, linhaDoRelatorio, rodarFase, percorrer, soConferir, contar, relatorioTexto,
  prepararPasta, plano, principal, cli};
