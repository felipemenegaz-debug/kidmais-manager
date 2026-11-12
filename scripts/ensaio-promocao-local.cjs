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
//     cópia real tem dados pessoais. A mensagem do núcleo só entra pela lista de permissão de `mensagemSegura`; a crua vai só para <pasta>/saida-crua.log.
//   node scripts/ensaio-promocao-local.cjs                                              → plano, sem conexão
//   node --experimental-strip-types scripts/ensaio-promocao-local.cjs --porta <p> --banco <b> --so-conferir
//   node --experimental-strip-types scripts/ensaio-promocao-local.cjs --porta <p> --banco <b>   → a cadeia inteira
//   ... --porta <p> --banco <b> --retrato-da-copia   → a cadeia inteira, com o retrato da 107-108 MEDIDO NA PRÓPRIA CÓPIA (D-ENS-1)
//     Só para a cópia restaurada por pg_dump/pg_restore: a restauração lógica muda o texto de pg_get_constraintdef/pg_get_indexdef e o retrato
//     F0 nunca casa com as variantes do arquivo. No passo 107-108 os esperados F0, F1 e F2 são medidos em bancos GÊMEOS (CREATE DATABASE ... TEMPLATE
//     <banco>, cópia física no mesmo cluster local), apagados no fim; o passo real roda com os três hashes e aceitaRetratosTeste: true (só ali, só
//     neste modo). O retrato deixa de ser verificação independente: NÃO confere production. Recusado com --so-conferir.
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
/** Gêmeo do banco do ensaio no modo --retrato-da-copia: nome previsível (<banco> + sufixo fixo); existente = recusa. */
const SUFIXO_GEMEO = '_gemeo_retrato';
/** Hash fictício (64 hex) injetado nas fases ainda não medidas: o núcleo grava o hash real ANTES de comparar. */
const HASH_FICTICIO = 'f'.repeat(64);
const PASSO_DO_RETRATO = '107-108';
const VALOR_RETRATO_DA_COPIA = 'retratos da 107-108: MEDIDOS NA PRÓPRIA CÓPIA (--retrato-da-copia), em bancos gêmeos físicos apagados no fim; aceitaRetratosTeste: true só no passo 107-108 e só neste modo; o arquivo de esperados NÃO é usado. NÃO confere production e o retrato deixa de ser verificação independente (a janela real continua com as variantes do arquivo)';
const NAO_EXERCIDO_RETRATO_DA_COPIA = 'verificação independente do retrato da 107-108 contra as variantes do arquivo de esperados (canonico, deriva_conhecida, staging_20261030): só o --conferir-107-108 de production na janela real';
/** Valores de ensaio e o que não é exercido, conforme o modo. */
const valoresDeEnsaio = copia => (copia ? [...VALORES_DE_ENSAIO.slice(0, -1), VALOR_RETRATO_DA_COPIA] : VALORES_DE_ENSAIO);
const naoExercido = copia => (copia ? [...NAO_EXERCIDO, NAO_EXERCIDO_RETRATO_DA_COPIA] : NAO_EXERCIDO);
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
 * O relatório sai da pasta do ensaio e a cópia real tem dados pessoais: da mensagem do núcleo só passa o que está numa
 * LISTA DE PERMISSÃO — nunca texto livre (uma mensagem do servidor pode citar valor de linha). Passam:
 *   - o identificador do núcleo no início (maiúsculas, dígitos e sublinhado: APLICACAO_PARCIAL_090, RETRATO_F0_DIVERGENTE);
 *     sem ele, a mensagem inteira vira DIAGNOSTICO_GENERICO;
 *   - depois dele, só termos com forma de identificador de catálogo ou de migration: números de migration (094, 092-093),
 *     nomes com sublinhado ou ponto (ia_credito_notificacoes, fechamento_revisoes.salao_id), identificadores maiúsculos
 *     compostos (SELECT_AGENDA_SALOES), hash hexadecimal de 8 ou 64 e palavras do VOCABULARIO fixo; pares chave=valor e
 *     listas com barra valem se todas as partes valerem. Qualquer outro termo é OMITIDO e só a quantidade aparece;
 *   - as faltas de privilégio do genérico, que são frases fixas seguidas de um nome de objeto (FALTAS_CONHECIDAS).
 * Só a primeira linha é lida (o assert do Node acrescenta um diff de valores nas seguintes). A mensagem crua do núcleo ou do
 * servidor (inclusive `detail`, que costuma trazer valor de linha) vai só para ARQUIVO_CRU, dentro da pasta do ensaio: nunca
 * para o terminal (quem roda pode ser um agente, e a saída do terminal entra na conversa dele) nem para o relatório.
 */
const ARQUIVO_CRU = 'saida-crua.log';
const DIAGNOSTICO_GENERICO = `MENSAGEM_NAO_RECONHECIDA (detalhe em ${ARQUIVO_CRU}, na pasta do ensaio; não copiar para fora dela)`;
/** Falha antes de existir pasta do ensaio (conexão ou identidade): sem identificador reconhecido, nada cru é mostrado nem gravado. */
const FALHA_ANTES_DO_ENSAIO = 'FALHA_ANTES_DO_ENSAIO (conexão ou identidade do servidor; nenhum passo rodou e nada foi gravado)';
const IDENTIFICADOR = /^[A-Z][A-Z0-9_]{2,79}$/;
const HEX8 = /^(?=.*[a-f])[0-9a-f]{8}$/, HEX64 = /^[0-9a-f]{64}$/;
const NUMERO_DE_MIGRATION = /^\d{1,4}$|^\d{3}(?:[-/]\d{3}){1,9}$/;
const NOME_DE_CATALOGO = /^[a-z][a-z0-9]*(?:[_.][a-z0-9]+)+$/;
const NOME_CURTO = /^[a-z]{1,3}\d{2,4}$/;
const MAIUSCULO_COMPOSTO = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$|^[A-Z]\d{1,3}$/;
/** Palavras soltas aceitas (sem sublinhado nem dígito não há como distinguir de texto livre): só estas. */
const VOCABULARIO = new Set([...TABELAS_PRINCIPAIS, 'public', 'ausente', 'presente', 'completa', 'parcial', 'divergente', 'true', 'false', 'null',
  'lock', 'revisao', 'exigir', 'atributos', 'CREATE', 'REFERENCES', 'SELECT', 'CONEXAO', 'VERIFICACAO']);
const parteSegura = p => p === '' || (p.length <= 80 && (VOCABULARIO.has(p) || HEX8.test(p) || HEX64.test(p) || NUMERO_DE_MIGRATION.test(p)
  || (!/\d{9,}/.test(p) && (NOME_DE_CATALOGO.test(p) || NOME_CURTO.test(p) || MAIUSCULO_COMPOSTO.test(p)))));
/** Termo sem a pontuação das bordas; chave=valor e a/b/c valem se todas as partes valerem. Devolve o termo limpo ou null. */
function termoSeguro(t) {
  const limpo = t.replace(/^[([{"'`]+|[)\]}"'`,;:.]+$/g, '');
  return limpo.split(/[=/]/).every(parteSegura) ? limpo : null;
}
const NOME_SQL = '[a-z_][a-z0-9_]{0,62}';
const FALTAS_CONHECIDAS = Object.freeze([/^CREATE no schema public$/, new RegExp(`^posse da tabela ${NOME_SQL}$`), new RegExp(`^REFERENCES em ${NOME_SQL}$`),
  new RegExp(`^posse da função ${NOME_SQL}\\([a-z0-9_ ,\\[\\]]{0,120}\\)$`)]);
const FALTA_NAO_RECONHECIDA = 'FALTA_NAO_RECONHECIDA';
/** Uma falta de privilégio do genérico: frase fixa + nome de objeto, ou o rótulo fixo. */
const faltaSegura = f => (typeof f === 'string' && FALTAS_CONHECIDAS.some(r => r.test(f.trim())) ? f.trim() : FALTA_NAO_RECONHECIDA);
function mensagemSegura(texto) {
  if (texto === undefined || texto === null) return null;
  const [cabeca, ...resto] = String(texto).split(/\r?\n|\r/)[0].trim().split(/\s+/);
  if (!IDENTIFICADOR.test(cabeca)) return DIAGNOSTICO_GENERICO;
  if (cabeca === 'PRIVILEGIO_INSUFICIENTE') return `${cabeca} ${resto.join(' ').split(';').map(faltaSegura).join('; ')}`;
  const termos = resto.map(termoSeguro), omitidos = termos.filter(t => t === null).length;
  return [cabeca, ...termos.filter(t => t !== null && t !== ''), ...(omitidos ? [`[${omitidos} termo(s) omitido(s)]`] : [])].join(' ');
}
/** Rótulo curto do núcleo (resultado, estado, variante, etapa): só letras ASCII, dígitos, sublinhado, hífen, `+` e espaço simples. */
const rotulo = (v, reserva = null) => (typeof v === 'string' && /^[A-Za-z0-9_+-]+(?: [A-Za-z0-9_+-]+){0,9}$/.test(v) && v.length <= 80 ? v : reserva);

/** Argumentos estritos: nenhum (plano) ou --porta e --banco, com --host, --pasta, --so-conferir e --retrato-da-copia opcionais (os dois últimos não combinam). Nada repetido. */
function lerArgumentos(argv) {
  if (argv.length === 0) return {modo: 'plano'};
  const r = {modo: 'ensaio', host: HOST, porta: null, banco: null, pasta: null};
  const vistos = new Set(), lista = [...argv];
  while (lista.length) {
    const a = lista.shift();
    assert.ok(!vistos.has(a), 'ARGUMENTO_REPETIDO ' + a);
    vistos.add(a);
    if (a === '--so-conferir') { r.modo = 'so-conferir'; continue; }
    if (a === '--retrato-da-copia') { r.retratoDaCopia = true; continue; }
    assert.ok(['--host', '--porta', '--banco', '--pasta'].includes(a), 'ARGUMENTOS_RECUSADOS');
    const v = lista.shift();
    assert.ok(typeof v === 'string' && v !== '' && !v.startsWith('--'), 'ARGUMENTO_SEM_VALOR ' + a);
    r[a.slice(2)] = v;
  }
  assert.ok(r.porta !== null && r.banco !== null, 'PORTA_E_BANCO_OBRIGATORIOS');
  assert.ok(!(r.retratoDaCopia && r.modo === 'so-conferir'), 'RETRATO_DA_COPIA_EXIGE_CADEIA (--so-conferir não aplica nada: não há retrato a medir nem a aceitar)');
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
 * identidade do ensaio — inclusive a conferência de privilégios (CREATE no schema, posse, REFERENCES), que o genérico faz
 * no CONFERIR, no pré-voo e de novo antes da transação. Daqui só o envelope: conexões, pré-voo antes do marcador, marcador
 * exclusivo na pasta do ensaio e o registro da falha.
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
  /**
   * Pré-voo do APLICAR, ANTES do marcador, numa conexão própria só de leitura (como o `executar` do genérico): estado
   * parcial e privilégio insuficiente recusam (lançam) sem gravar nada. O genérico não exporta o pré-voo dele
   * (`preflightNoCliente`); se passar a exportar, é ele que roda. Enquanto não, a mesma decisão vem do `conferirNoCliente`
   * do próprio genérico: sem plano (estado parcial) ou com `privilegios.ok` falso = recusa com o motivo dele. Check
   * reprovado NÃO recusa aqui: como em production, ele falha dentro da transação (NAO_COMMITADA), já com marcador.
   */
  async function preVoo(id, opts) {
    const db = new Client(opts); db.on?.('error', () => undefined);
    try {
      await db.connect();
      if (typeof gen.preflightNoCliente === 'function') { await gen.preflightNoCliente(db, comum(id)); return; }
      const r = await gen.conferirNoCliente(db, comum(id));
      if (r.resultado === 'RECUSARIA' && (!r.plano || r.privilegios?.ok === false)) {
        // A lista inteira de faltas segue junto do erro (a mensagem do genérico corta em 300 caracteres).
        throw Object.assign(new Error(String(r.motivo ?? 'PRE_VOO_RECUSADO')), Array.isArray(r.privilegios?.faltas) ? {faltas: r.privilegios.faltas} : {});
      }
    } catch (e) { await db.query('ROLLBACK').catch(() => {}); throw e; }
    finally { await db.end().catch(() => {}); }
  }
  async function executar(id, backup) {
    const opts = amb.alvo(); amb.exigirDisco();
    gen.carregar(raiz, id);
    fs.mkdirSync(amb.DIR, {recursive: true, mode: 0o700});
    const marcador = path.join(amb.DIR, gen.marcadorDe(id));
    if (fs.existsSync(marcador)) assert.fail('TENTATIVA_ANTERIOR_REVISAR ' + marcador);
    await preVoo(id, opts);
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
function principalDoPasso(p, {alvo, pasta, raiz, Client, carregar = require, retratosCopia = null}) {
  if (p.aplicador === 'generico') {
    const gen = carregar('./' + path.basename(p.arquivo));
    return principalGenerico(gen, {amb: ambienteDeEnsaio(alvo, p.id, pasta), raiz, Client});
  }
  const m = /^scripts\/migration-([0-9]{3}(?:-[0-9]{3})?)-production\.cjs$/.exec(String(p.aplicador));
  assert.ok(m && Object.hasOwn(NUCLEOS, m[1]), 'PASSO_SEM_NUCLEO_DE_ENSAIO ' + p.id);
  const {criarAplicador, ENV_RETRATOS_TESTE} = carregar(`./migration-${m[1]}-comum.cjs`);
  if (retratosCopia && p.id === PASSO_DO_RETRATO) {
    // ÚNICO lugar com aceitaRetratosTeste: true: o passo real, com os esperados medidos nos gêmeos (nunca o arquivo).
    return async argv => {
      const medido = await retratosCopia.obter(p);
      const real = criarAplicador(ambienteDeEnsaio(alvo, p.id, pasta, {...NUCLEOS[m[1]], aceitaRetratosTeste: true}));
      return real.principal(argv, {...ENV_DOS_NUCLEOS, [ENV_RETRATOS_TESTE]: JSON.stringify(medido.esperados)}, {raiz, Client});
    };
  }
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
/** A situação do COMMIT só com rótulos e números de migration (o que não tiver essa forma vira NAO_INFORMADA ou sai da lista). */
function commitSeguro(c) {
  const r = v => (IDENTIFICADOR.test(String(v)) ? v : 'NAO_INFORMADA'), id = v => /^\d{3}$/.test(String(v));
  if (typeof c === 'string') return r(c);
  if (Array.isArray(c?.confirmadas)) return {confirmadas: c.confirmadas.filter(id), indeterminada: id(c.indeterminada) ? c.indeterminada : null};
  return Object.fromEntries(Object.entries(c ?? {}).filter(([k]) => id(k)).map(([k, v]) => [k, r(v)]));
}
/** Estado por migration, só rótulos: chaves m<nnn> dos núcleos, a situação do genérico e o estado da 107. */
function estadoDe(saida) {
  const e = saida?.estado ?? saida?.estadoDepois ?? saida?.estadoAntes;
  const r = {};
  const umRotulo = v => (typeof v === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(v) ? v : null);
  for (const [k, v] of Object.entries(e ?? {})) if ((/^m[0-9]{3}[a-z]?$/.test(k) || k === 'situacao') && umRotulo(v)) r[k] = v;
  if (umRotulo(saida?.estado107)) r.estado107 = saida.estado107;
  return Object.keys(r).length ? r : null;
}
/** Resumo do retrato por seção, como o núcleo o sanitiza: quantidade e sha256 (sem corpos nem literais). É o que permite o diff entre dois bancos. */
function secoesDe(secoes) {
  if (!secoes || typeof secoes !== 'object') return null;
  return Object.fromEntries(Object.entries(secoes).filter(([, v]) => Number.isInteger(v?.n) && HEX64.test(String(v?.sha256))).map(([k, v]) => [String(k).slice(0, 60), {n: v.n, sha256: v.sha256}]));
}
/** Linha do relatório: só o que pode sair (nada das contagens nem dos objetos do núcleo é copiado). */
function linhaDoRelatorio(p, fase, codigo, saida, duracaoMs) {
  const linha = {passo: p.id, fase, codigo, resultado: IDENTIFICADOR.test(String(saida?.resultado)) ? saida.resultado : 'SEM_RESULTADO', commit: commitSeguro(commitDe(fase, saida)),
    duracaoMs: Math.round(duracaoMs), estado: estadoDe(saida)};
  // 107-108: a fase e o retrato medido (hash do catálogo e variante reconhecida) são o que a cópia real precisa mostrar.
  if (/^F[0-2]$/.test(String(saida?.fase))) linha.faseDoNucleo = saida.fase;
  if (saida?.retrato && typeof saida.retrato === 'object') linha.retrato = {fase: /^F[0-2]$/.test(String(saida.retrato.fase)) ? saida.retrato.fase : '',
    hash: HEX64.test(String(saida.retrato.hash)) ? saida.retrato.hash : null, variante: rotulo(saida.retrato.variante), secoes: secoesDe(saida.retrato.secoes)};
  if (codigo !== 0) {
    // Faltas de privilégio do genérico: a lista inteira (a mensagem dele corta em 300 caracteres), cada item pelo filtro.
    const faltas = saida?.privilegios?.ok === false && Array.isArray(saida.privilegios.faltas) ? saida.privilegios.faltas.map(faltaSegura) : null;
    if (faltas) linha.faltas = faltas;
    linha.mensagem = faltas ? 'PRIVILEGIO_INSUFICIENTE ' + faltas.join('; ') : mensagemSegura(saida?.motivo ?? saida?.mensagem ?? saida?.falha?.mensagem ?? 'SEM_MENSAGEM_DO_NUCLEO');
    const etapa = rotulo(saida?.falha?.etapa);
    if (etapa) linha.etapa = etapa;
  }
  return linha;
}
/** Texto cru de uma falha, numa linha: a mensagem do núcleo e, de um erro do driver, também code, detail, where e hint. Só para ARQUIVO_CRU. */
function textoCru(saida, erro) {
  const partes = erro ? [erro.message, ...['code', 'detail', 'where', 'hint', 'constraint', 'table', 'column'].map(k => (erro[k] ? `${k}: ${erro[k]}` : null))]
    : [saida?.motivo ?? saida?.mensagem ?? saida?.falha?.mensagem ?? '(sem mensagem)'];
  return partes.filter(Boolean).map(String).join(' | ').replace(/\s*[\r\n]+\s*/g, ' / ').slice(0, 4000);
}
/** Registro da saída crua na pasta do ensaio: uma linha por ocorrência (hora, passo, fase, código, texto), arquivo só do dono. */
function registroCru(pasta) {
  const arquivo = path.join(pasta, ARQUIVO_CRU);
  const r = {arquivo, ocorrencias: 0, gravar(passo, fase, codigo, texto) {
    fs.appendFileSync(arquivo, `${new Date().toISOString()}\t${passo}\t${fase}\tcódigo ${codigo}\t${texto}\n`, {mode: 0o600});
    r.ocorrencias++;
  }};
  return r;
}
/** Roda uma fase de um passo. Recusa lançada antes de conectar = código 1, como na CLI dos aplicadores. */
async function rodarFase(p, fase, ctx) {
  const inicio = performance.now();
  let codigo, saida, erro = null;
  try { ({codigo, saida} = await principalDoPasso(p, ctx)(argumentos(p, fase))); }
  catch (e) { erro = e; codigo = 1; saida = {resultado: 'RECUSADO', mensagem: curta(e), ...(Array.isArray(e?.faltas) ? {privilegios: {ok: false, faltas: e.faltas}} : {})}; }
  codigo = Number.isInteger(codigo) ? codigo : 2;
  if (codigo !== 0) ctx.cru?.gravar(p.id, fase, codigo, textoCru(saida, erro));
  return linhaDoRelatorio(p, fase, codigo, saida, performance.now() - inicio);
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

/**
 * --retrato-da-copia: medição dos esperados F0, F1 e F2 da 107-108 em bancos GÊMEOS do banco do ensaio.
 * Gêmeo = `CREATE DATABASE <banco><SUFIXO_GEMEO> TEMPLATE <banco>`: cópia física no mesmo cluster local, que preserva o texto do catálogo
 * (a restauração lógica é que o muda). Passa pelas mesmas travas do alvo (loopback, porta, nome fora de BANCOS_RECUSADOS e identidade provada
 * no servidor), deriva só do banco já autorizado, recusa se já existir e é apagado SEMPRE (finally). Em cada gêmeo roda o núcleo REAL da 107-108
 * com aceitaRetratosTeste: true e esperados em que as fases ainda não medidas levam um hash fictício: o núcleo mede o retrato ANTES de comparar,
 * e um cliente embrulhado (clienteCapturando) guarda o hash medido (F0 no CONFERIR; F1 depois da 107 confirmada; F2 dentro da transação da 108,
 * antes da prova, que a seguir recusa e desfaz — no gêmeo). Nada do que o gêmeo faz toca o banco do ensaio.
 */
function alvoDoGemeo(alvo, env) {
  const banco = alvo.banco + SUFIXO_GEMEO;
  // Mesmas travas do alvo; a autorização do gêmeo é derivada da do banco já autorizado (o gêmeo só existe a partir dele).
  exigirAlvo({host: alvo.host, porta: String(alvo.porta), banco}, {...env, KIDMAIS_DESCARTAVEL_AUTORIZACAO: `${HOST}:${alvo.porta}/${banco}`});
  return Object.freeze({host: alvo.host, porta: alvo.porta, banco});
}
/** Conexão administrativa (banco `postgres`, só para CREATE/DROP DATABASE), com a identidade provada no servidor. */
async function comAdmin(alvo, Client, trabalho) {
  const adm = {...alvo, banco: 'postgres'};
  const db = new Client(opcoesCliente(adm, 'kidmais-ensaio-gemeo')); db.on?.('error', () => undefined);
  await db.connect();
  try {
    identidade((await db.query(SQL_IDENTIDADE)).rows[0], adm);
    return await trabalho(db);
  } finally { await db.end().catch(() => {}); }
}
async function comGemeo(alvo, env, Client, trabalho) {
  const g = alvoDoGemeo(alvo, env);
  await comAdmin(alvo, Client, async db => {
    assert.ok((await db.query('SELECT 1 FROM pg_catalog.pg_database WHERE datname = $1', [g.banco])).rows.length === 0, 'GEMEO_JA_EXISTE ' + g.banco);
  });
  let erro = null, valor, apagar = null;
  try {
    await comAdmin(alvo, Client, async db => { await db.query(`CREATE DATABASE "${g.banco}" TEMPLATE "${alvo.banco}"`); });
    valor = await trabalho(g);
  } catch (e) { erro = e; }
  try { await comAdmin(alvo, Client, async db => { await db.query(`DROP DATABASE IF EXISTS "${g.banco}" WITH (FORCE)`); }); } catch (e) { apagar = e; }
  if (apagar) throw new Error('GEMEO_NAO_APAGADO ' + g.banco);
  if (erro) throw erro;
  return valor;
}
/** Cliente que guarda o hash de todo retrato medido pelo núcleo e mede o de F2 antes da prova "108 íntegra" (a mesma sessão, a mesma transação). */
function clienteCapturando(Client, capturas, sqlRetrato) {
  return class extends Client {
    async query(...a) {
      const sql = typeof a[0] === 'string' ? a[0] : a[0]?.text;
      if (typeof sql === 'string' && sql.includes("ARRAY['RETRATO_F2']")) {
        const h = (await super.query(sqlRetrato)).rows?.[0]?.hash_108;
        if (HEX64.test(String(h))) capturas.push({fase: 'F2', hash: h});
      }
      const r = await super.query(...a);
      const h = r?.rows?.[0]?.hash_108;
      if (HEX64.test(String(h))) capturas.push({fase: null, hash: h});
      return r;
    }
  };
}
const mensagemDoNucleo = r => String(r?.saida?.motivo ?? r?.saida?.mensagem ?? r?.saida?.falha?.mensagem ?? '').split(/\r?\n|\r/)[0];
async function medirRetratosDaCopia({p, alvo, env, Client, raiz, pasta, carregar = require}) {
  const comum = carregar('./migration-107-108-comum.cjs'), ret = carregar('./migration-108-retrato.cjs');
  const arquivo = ret.carregarEsperados(raiz);
  const sqlRetrato = ret.sqlRetrato108({raiz});
  const molde = (F0, F1, F2) => ({versao_pg_maior: arquivo.versao_pg_maior, trecho_sha256: arquivo.trecho_sha256, F0, F1, F2});
  const fic = {copia: HASH_FICTICIO};
  let n = 0;
  const noGemeo = (fase, esperados) => comGemeo(alvo, env, Client, async g => {
    const dir = path.join(pasta, 'gemeos', `${++n}-${fase.toLowerCase()}`);
    fs.mkdirSync(path.join(dir, 'marcadores'), {recursive: true});
    const capturas = [];
    const aplicador = comum.criarAplicador(ambienteDeEnsaio(g, p.id, dir, {aceitaRetratosTeste: true}));
    const r = await aplicador.principal(argumentos(p, fase), {...ENV_DOS_NUCLEOS, [comum.ENV_RETRATOS_TESTE]: JSON.stringify(esperados)},
      {raiz, Client: clienteCapturando(Client, capturas, sqlRetrato)});
    return {...r, capturas};
  });
  const nao = (fase, r) => new Error(`RETRATO_COPIA_NAO_MEDIDO ${fase} ${mensagemDoNucleo(r) || 'SEM_MENSAGEM_DO_NUCLEO'}`);
  // F0: CONFERIR com tudo fictício; o núcleo recusa RETRATO_F0_DIVERGENTE depois de gravar o hash real.
  const a = await noGemeo('CONFERIR', molde(fic, fic, fic));
  const h0 = a.capturas.at(-1)?.hash;
  if (!(a.codigo === 3 && /RETRATO_F0_DIVERGENTE/.test(mensagemDoNucleo(a)) && h0)) throw nao('F0', a);
  // F1: APLICAR com F0 real; a 107 confirma (no gêmeo) e o F1 fictício recusa depois de medir. O rótulo de F0 'copia' só serve se a avaliação
  // da 107 NÃO for toda canônica (o núcleo exige variante 'canonico' <=> tudo canônico): senão o mesmo hash entra como 'canonico'.
  let nomeF0 = null, h1 = null;
  for (const nome of ['copia', 'canonico']) {
    const b = await noGemeo('APLICAR', molde({[nome]: h0}, fic, fic));
    if (nome === 'copia' && /RETRATO_F0_INCOERENTE/.test(mensagemDoNucleo(b))) continue;
    h1 = b.capturas.at(-1)?.hash;
    if (!(b.codigo === 2 && /RETRATO_F1_DIVERGENTE/.test(mensagemDoNucleo(b)) && h1 && mensagemDoNucleo(b).includes(h1))) throw nao('F1', b);
    nomeF0 = nome; break;
  }
  if (!nomeF0) throw nao('F1', {saida: {mensagem: 'RETRATO_F0_INCOERENTE nos dois rótulos'}});
  // F2: APLICAR com F0 e F1 reais; a 108 mede o F2 dentro da transação e a prova recusa (RETRATO_F2) e desfaz — no gêmeo.
  const c = await noGemeo('APLICAR', molde({[nomeF0]: h0}, {copia: h1}, fic));
  const h2 = c.capturas.filter(x => x.fase === 'F2').at(-1)?.hash;
  if (!(c.codigo === 2 && h2 && /RETRATO_F2/.test(String(c.saida?.falha?.mensagem ?? '')) && c.capturas.filter(x => !x.fase).every(x => x.hash === h0 || x.hash === h1))) throw nao('F2', c);
  const hashes = {F0: h0, F1: h1, F2: h2};
  return {esperados: molde({[nomeF0]: h0}, {copia: h1}, {copia: h2}), hashes, rotuloF0DoNucleo: nomeF0,
    casouComArquivo: Object.fromEntries(Object.entries(hashes).map(([f, h]) => [f, Object.entries(arquivo[f] ?? {}).find(([, v]) => v === h)?.[0] ?? null]))};
}
/** Medição preguiçosa e única: acontece ao chegar no passo 107-108 (o estado do banco é o de então). */
function criarMedidorDeRetratos(base) {
  let promessa = null, medido = null;
  return {obter: p => (promessa ??= medirRetratosDaCopia({...base, p}).then(m => (medido = m))), medido: () => medido};
}
/** No modo, o retrato da linha do passo é rotulado como medido na cópia (o rótulo do núcleo, quando difere, fica em varianteNucleo). */
function rotularLinhaDaCopia(l) {
  if (l.passo !== PASSO_DO_RETRATO || !l.retrato) return l;
  const r = {...l.retrato, origem: 'MEDIDO_NA_COPIA'};
  if (r.variante) { r.varianteNucleo = r.variante; r.variante = 'copia'; }
  return {...l, retrato: r};
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
      + (l.retrato ? ` | retrato ${l.retrato.fase} ${l.retrato.variante ?? 'SEM_VARIANTE'} ${l.retrato.hash ?? ''}${l.retrato.origem ? ` [MEDIDO NA CÓPIA${l.retrato.varianteNucleo && l.retrato.varianteNucleo !== l.retrato.variante ? '; rótulo interno do núcleo: ' + l.retrato.varianteNucleo : ''}]` : ''}` : ''));
    if (l.mensagem) L.push(`    ↳ ${l.etapa ? l.etapa + ': ' : ''}${l.mensagem}`);
  }
  if (r.retratoDaCopia) {
    const x = r.retratoDaCopia;
    L.push('', 'ATENÇÃO — RETRATO DA 107–108 MEDIDO NA CÓPIA (--retrato-da-copia): NÃO confere production e não é verificação independente.', x.medido
      ? `  variante: ${x.variante} · F0 ${x.hashes.F0} · F1 ${x.hashes.F1} · F2 ${x.hashes.F2}`
      : '  o passo 107-108 não foi alcançado: nada foi medido nem aceito.');
    if (x.medido) L.push(`  casou com variante do arquivo de esperados: F0 ${x.casouComArquivo.F0 ?? 'nenhuma'} · F1 ${x.casouComArquivo.F1 ?? 'nenhuma'} · F2 ${x.casouComArquivo.F2 ?? 'nenhuma'}`);
  }
  if (r.parada) L.push('', `PAROU: passo ${r.parada.passo}, fase ${r.parada.fase}, código ${r.parada.codigo} (${r.parada.motivo}${r.parada.significado ? ': ' + r.parada.significado : ''})`,
    `mensagem do núcleo: ${r.parada.mensagem ?? '-'}`);
  if (r.saidaCrua) L.push('', `saída crua: ${r.saidaCrua.ocorrencias} ocorrência(s) em ${r.saidaCrua.arquivo}, na pasta do ensaio (tem dado de cliente: não copiar nem colar para fora da pasta)`);
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
      'node --experimental-strip-types scripts/ensaio-promocao-local.cjs --porta <porta> --banco <banco> [--pasta <pasta-nova>]',
      'node --experimental-strip-types scripts/ensaio-promocao-local.cjs --porta <porta> --banco <banco> --retrato-da-copia [--pasta <pasta-nova>]   (cópia restaurada por pg_restore; retrato da 107-108 medido na cópia; não combina com --so-conferir)'],
    autorizacao: ['KIDMAIS_POSTGRES_DESCARTAVEL=kidmais_pacotes_v1_descartavel', 'KIDMAIS_DESCARTAVEL_PORTA=<porta>', `KIDMAIS_DESCARTAVEL_AUTORIZACAO=${HOST}:<porta>/<banco>`],
    recusas: ['host fora de 127.0.0.1/localhost', 'banco ' + BANCOS_RECUSADOS.join(', '), 'porta ' + PORTAS_RECUSADAS.join(', '), 'RENDER*, *DATABASE_URL ou PG* no ambiente',
      `servidor sem cluster_name ${CLUSTER}, papel ${PAPEL} ou com banco real no cluster`],
    passos: ordem.PASSOS.map(p => ({passo: p.id, migrations: p.migrations, aplicador: p.aplicador === 'generico' ? p.arquivo : p.aplicador,
      conferir: argumentos(p, 'CONFERIR').join(' '), aplicar: argumentos(p, 'APLICAR').join(' ')})),
    valoresDeEnsaio: VALORES_DE_ENSAIO, naoExercido: NAO_EXERCIDO, tabelasContadas: TABELAS_PRINCIPAIS};
}

/**
 * Códigos: 0 plano, --so-conferir concluído ou cadeia CONCLUIDA; 1 recusa antes de qualquer passo (lançada); 2 cadeia PARADA.
 * `deps` (testes): Client, raiz, ordem, pasta e carregar. Depois de conectar, nenhum erro sobe com texto do servidor: ele vai para
 * ARQUIVO_CRU (se a pasta já existe) e o que é lançado leva só o identificador reconhecido ou um diagnóstico fixo.
 */
async function principal(argv, env, deps = {}) {
  const ordem = deps.ordem ?? require('./promocao-production-ordem.cjs');
  const args = lerArgumentos(argv);
  if (args.modo === 'plano') return {codigo: 0, saida: plano(ordem)};
  const alvo = exigirAlvo(args, env);
  const Client = deps.Client ?? require('pg').Client;
  const raiz = deps.raiz ?? path.resolve(__dirname, '..');
  const inicio = new Date().toISOString();
  let id;
  try { id = await provarIdentidade(alvo, Client); }
  catch (e) { const m = mensagemSegura(curta(e)); throw new Error(m === DIAGNOSTICO_GENERICO ? FALHA_ANTES_DO_ENSAIO : m); }
  const pasta = prepararPasta(deps.pasta ?? args.pasta);
  fs.mkdirSync(path.join(pasta, 'marcadores'), {recursive: true});
  const cru = registroCru(pasta);
  const copia = args.retratoDaCopia === true;
  const retratosCopia = copia ? criarMedidorDeRetratos({alvo, env, Client, raiz, pasta, carregar: deps.carregar}) : null;
  let antes, feito, depois;
  try {
    antes = await contar(alvo, Client);
    const rodar = async (p, fase) => {
      const l = await rodarFase(p, fase, {alvo, pasta, raiz, Client, carregar: deps.carregar, cru, retratosCopia});
      return copia ? rotularLinhaDaCopia(l) : l;
    };
    feito = args.modo === 'so-conferir' ? await soConferir(ordem, rodar) : await percorrer(ordem, rodar);
    depois = await contar(alvo, Client);
  } catch (e) {
    // Erro do próprio executor (contagens, ordem): o texto cru fica na pasta; para fora só o identificador ou o diagnóstico fixo.
    cru.gravar('executor', '-', 1, textoCru(null, e));
    throw new Error(`${mensagemSegura(curta(e))} [pasta do ensaio: ${pasta}]`);
  }
  const relatorio = {ferramenta: 'ensaio-promocao-local', modo: args.modo, situacao: feito.situacao, alvo, versaoPg: id.versaoPg, inicio, fim: new Date().toISOString(),
    passos: feito.linhas, ...(feito.parada ? {parada: feito.parada} : {}), contagens: {antes, depois},
    ...(copia ? {retratoDaCopia: {origem: 'MEDIDO_NA_COPIA', variante: 'copia', confereProduction: false, medido: retratosCopia.medido() !== null,
      ...(retratosCopia.medido() ? {hashes: retratosCopia.medido().hashes, casouComArquivo: retratosCopia.medido().casouComArquivo} : {})}} : {}),
    ...(cru.ocorrencias ? {saidaCrua: {arquivo: ARQUIVO_CRU, ocorrencias: cru.ocorrencias}} : {}), valoresDeEnsaio: valoresDeEnsaio(copia), naoExercido: naoExercido(copia)};
  const texto = relatorioTexto(relatorio);
  fs.writeFileSync(path.join(pasta, 'relatorio.json'), JSON.stringify(relatorio, null, 2));
  fs.writeFileSync(path.join(pasta, 'relatorio.txt'), texto);
  return {codigo: feito.situacao === 'PARADA' ? 2 : 0, saida: relatorio, texto, pasta};
}
/** CLI: no terminal sai só o relatório filtrado (ou a recusa numa linha); `deps` existe para o teste capturar a saída. */
function cli(argv = process.argv.slice(2), env = process.env, deps = {}) {
  return principal(argv, env, deps).then(({codigo, saida, texto, pasta}) => {
    if (texto === undefined) console.log(JSON.stringify(saida, null, 2));
    else console.log(texto + '\nrelatório: ' + path.join(pasta, 'relatorio.json') + ' e relatorio.txt (marcadores dos núcleos em ' + path.join(pasta, 'marcadores') + ')');
    process.exitCode = codigo;
  }).catch(e => { console.error('RECUSADO ' + curta(e).split(/\r?\n|\r/)[0]); process.exitCode = 1; });
}

if (require.main === module) cli();
module.exports = {HOST, PAPEL, CLUSTER, BANCOS_RECUSADOS, PORTAS_RECUSADAS, REGISTRO_BACKUP, REGISTRO_DRENAGEM, ENV_DOS_NUCLEOS, VALORES_DE_ENSAIO, NAO_EXERCIDO, NUCLEOS,
  TABELAS_PRINCIPAIS, SQL_IDENTIDADE, SQL_CONTAGENS, ARQUIVO_CRU, DIAGNOSTICO_GENERICO, FALHA_ANTES_DO_ENSAIO, FALTA_NAO_RECONHECIDA, textoCru, registroCru, mensagemSegura, faltaSegura, termoSeguro, lerArgumentos, exigirAmbiente, exigirAutorizacao, exigirAlvo, opcoesCliente, identidade,
  ambienteDeEnsaio, principalGenerico, principalDoPasso, argumentos, commitDe, estadoDe, linhaDoRelatorio, rodarFase, percorrer, soConferir, contar, relatorioTexto,
  prepararPasta, plano, principal, cli, SUFIXO_GEMEO, HASH_FICTICIO, PASSO_DO_RETRATO, valoresDeEnsaio, naoExercido, alvoDoGemeo, comGemeo, clienteCapturando,
  medirRetratosDaCopia, criarMedidorDeRetratos, rotularLinhaDaCopia};
