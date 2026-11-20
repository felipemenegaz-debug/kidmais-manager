/* eslint-disable @typescript-eslint/no-require-imports */
// Cópia única do disco persistente para o banco, DEPOIS da 128 (vault "Convites geracao sobrevive ao deploy 20261120",
// fases 3 e 4). Roda no Web Shell do web (staging srv-daif418ae00c73e8k2gg ou production srv-dak77m2d0e5s73b8rkkg), com o
// disco ainda montado e o código que lê do banco já implantado (deploy LIVE). Copia só o que o web usa hoje:
//   - data/disponibilidade.json → disponibilidade_config_legada (origem DISCO). Linha gravada pelo painel (PAINEL) vence e
//     nunca é sobrescrita; linha DISCO de uma cópia anterior é atualizada se o arquivo mudou depois dela;
//   - o PDF do documento público ATIVO → documentos_publicos.conteudo, só se ainda estiver NULL e se tamanho e sha256 do
//     arquivo baterem com a linha (a CHECK da 128 confere de novo no banco). Sob a mesma trava da publicação.
// Documentos inativos ficam só no backup do disco (backups-disco-20261120). Nada é apagado do disco.
//   node scripts/disco-para-banco-128.cjs                                   → plano, sem conexão
//   node scripts/disco-para-banco-128.cjs --conferir-128 <alvo>             → somente leitura (READ ONLY): o que falta copiar
//   node scripts/disco-para-banco-128.cjs --copiar-128-autorizado <alvo>    → uma transação; repetir é seguro
// <alvo> é staging ou production e precisa ser o KIDMAIS_DEPLOY_ENV do serviço (conferido antes de conectar). As duas
// operações exigem o disco persistente montado.
// Códigos: 0 PLANO/CONFERIDO/COPIADO; 1 recusa antes de conectar; 2 FALHA antes do COMMIT (ROLLBACK, nada gravado);
// 3 conferência recusaria; 4 INDETERMINADO (o COMMIT foi enviado e não houve confirmação: rode --conferir-128 antes de
// qualquer outra coisa).
// A saída é o registro (JSON com contagens, tamanhos e sha256; nunca conteúdo, URL ou senha): copie-a para a nota.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const stg = require('./conexao-staging.cjs');
const prd = require('./conexao-production.cjs');
const s116 = require('./migration-116-staging.cjs');

const DISCO = '/opt/render/project/src/data';
const FLAG_CONFERIR = '--conferir-128';
const FLAG_COPIAR = '--copiar-128-autorizado';
const ALVOS = Object.freeze(['staging', 'production']);
const TIPO = 'TABELA_PACOTES_PRECOS';
const CHAVE = /^[0-9a-f-]{36}\.pdf$/;
const CODIGO = Object.freeze({PLANO: 0, CONFERIDO: 0, COPIADO: 0, RECUSARIA: 3, FALHA: 2, INDETERMINADO: 4});
const curta = e => String(e?.message ?? e).replace(/postgres(?:ql)?:\/\/\S+/gi, '<url>').slice(0, 300);
const sha = b => crypto.createHash('sha256').update(b).digest('hex');

/** Ambiente pelo KIDMAIS_DEPLOY_ENV, com a validação rígida de cada um (serviço, host, banco, TLS, PG* herdadas). */
function ambiente(env) {
  if (env.KIDMAIS_DEPLOY_ENV === 'staging') {
    const cfg = s116.alvo(env); cfg.application_name = 'kidmais-disco-para-banco-128-staging';
    return {nome: 'staging', cfg, sqlIdentidade: stg.SQL_IDENTIDADE,
      identidade: id => { try { return stg.conferirIdentidade(id, env); } catch (e) { assert.fail('IDENTIDADE_RECUSADA ' + String(e?.message ?? '').slice(0, 40)); } }};
  }
  if (env.KIDMAIS_DEPLOY_ENV === 'production')
    return {nome: 'production', cfg: prd.alvoRigido(env, 'kidmais-disco-para-banco-128-production'), sqlIdentidade: prd.SQL_IDENTIDADE, identidade: prd.identidade};
  assert.fail('AMBIENTE_RECUSADO');
}

/** Sem argumentos: plano. Com flag: o alvo é obrigatório e precisa ser o ambiente declarado do serviço. */
function modo(argv, env = {}) {
  if (argv.length === 0) return {modo: 'plano'};
  assert.ok(argv.length === 2 && [FLAG_CONFERIR, FLAG_COPIAR].includes(argv[0]) && ALVOS.includes(argv[1]), 'ARGUMENTOS_RECUSADOS');
  assert.equal(env.KIDMAIS_DEPLOY_ENV, argv[1], 'ALVO_DIFERENTE_DO_AMBIENTE');
  return {modo: argv[0] === FLAG_CONFERIR ? 'conferir' : 'copiar', alvo: argv[1]};
}

function plano() {
  return {resultado: 'PLANO', conecta: false, disco: DISCO, copia: [
    'disponibilidade.json → disponibilidade_config_legada (sem linha: insere; linha DISCO diferente: atualiza; PAINEL: preserva)',
    `PDF ativo (${TIPO}) → documentos_publicos.conteudo (só NULL; tamanho e sha256 conferidos; trava da publicação)`],
  ordem: ['código com a leitura pelo banco implantado no web (deploy LIVE)', '128 aplicada (JA_APLICADA_POSTCHECK_PASS)',
    `${FLAG_CONFERIR} <alvo>: PRONTO_PARA_COPIAR`, 'sim de Felipe', `${FLAG_COPIAR} <alvo>`, `${FLAG_CONFERIR} <alvo>: NADA_A_COPIAR`,
    'só então a remoção do disco (Felipe)'],
  nuncaExecuta: ['apagar arquivo do disco', 'sobrescrever linha gravada pelo painel', 'migration', 'env', 'deploy', 'restart']};
}

/** Lê o disco sem tocar no banco. Erro de leitura vira estado (ILEGIVEL), nunca exceção. */
function lerConfigDoDisco(disco) {
  const arquivo = path.join(disco, 'disponibilidade.json');
  let texto;
  // falhaLeitura: o arquivo não pôde ser lido (EACCES, EIO…), diferente de conteúdo inválido. Depois do COMMIT isso torna a
  // releitura INDISPONIVEL, em vez de um resumo que trata o arquivo como ilegível.
  try { texto = fs.readFileSync(arquivo, 'utf8'); }
  catch (e) { return e?.code === 'ENOENT' ? {estado: 'AUSENTE'} : {estado: 'ILEGIVEL', falhaLeitura: e?.code ?? 'ERRO'}; }
  let bruto;
  try { bruto = JSON.parse(texto); } catch { return {estado: 'ILEGIVEL', bytes: Buffer.byteLength(texto), sha256: sha(texto)}; }
  // Mesma forma estrita da leitura para gravar de lib/disponibilidade/config-legada-armazem.ts: campo presente que não é
  // lista, ou item que não é objeto, é ILEGIVEL (a cópia não descarta conteúdo em silêncio). Campo ausente = [].
  const objeto = v => !!v && typeof v === 'object' && !Array.isArray(v);
  const formaOk = objeto(bruto) && ['pacoteOverrides', 'descontos'].every(c => bruto[c] === undefined || (Array.isArray(bruto[c]) && bruto[c].every(objeto)));
  if (!formaOk) return {estado: 'ILEGIVEL', bytes: Buffer.byteLength(texto), sha256: sha(texto)};
  const conteudo = {pacoteOverrides: bruto.pacoteOverrides ?? [], descontos: bruto.descontos ?? []};
  return {estado: 'PRESENTE', bytes: Buffer.byteLength(texto), sha256: sha(texto), conteudo,
    pacoteOverrides: conteudo.pacoteOverrides.length, descontos: conteudo.descontos.length};
}
function lerPdfDoDisco(disco, doc) {
  if (!CHAVE.test(doc.chave_armazenamento)) return {estado: 'CHAVE_INVALIDA'};
  let bytes;
  try { bytes = fs.readFileSync(path.join(disco, 'documentos-publicos', doc.chave_armazenamento)); }
  catch (e) { return {estado: e?.code === 'ENOENT' ? 'AUSENTE' : 'ILEGIVEL'}; }
  const h = sha(bytes);
  if (bytes.length !== Number(doc.tamanho_bytes) || h !== doc.sha256) return {estado: 'DIVERGENTE', bytes: bytes.length, sha256: h};
  return {estado: 'CONFERE', bytes};
}

/**
 * O que o banco tem. `conteudoDisco` (ou null) é comparado com a linha pelo próprio jsonb (igual_ao_disco).
 * `travar`: FOR UPDATE na linha e nos documentos ativos (cópia).
 */
async function estadoNoBanco(db, conteudoDisco, travar = false) {
  const r = (await db.query(`SELECT to_regclass('public.disponibilidade_config_legada') IS NOT NULL AS tabela,
      EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('public.documentos_publicos') AND attname = 'conteudo' AND NOT attisdropped) AS coluna`)).rows[0];
  if (!r.tabela || !r.coluna) return {instalada: false};
  const linha = (await db.query(`SELECT origem, atualizado_em::text AS atualizado_em,
      COALESCE(conteudo = $1::jsonb, false) AS igual_ao_disco FROM disponibilidade_config_legada WHERE id = 1${travar ? ' FOR UPDATE' : ''}`,
  [conteudoDisco ? JSON.stringify(conteudoDisco) : null])).rows[0] ?? null;
  const docs = (await db.query(`SELECT id::text AS id, chave_armazenamento, tamanho_bytes, sha256, conteudo IS NOT NULL AS no_banco
      FROM documentos_publicos WHERE tipo = $1 AND ativo ORDER BY id${travar ? ' FOR UPDATE' : ''}`, [TIPO])).rows;
  return {instalada: true, linha, docs};
}

/** Resumo sem conteúdo: o que existe no disco, no banco, o que a cópia faria e o que a impede. */
function resumir(banco, config, pdfs) {
  const linha = banco.linha;
  const doPainel = linha?.origem === 'PAINEL';
  const pendentes = {
    config: config.estado === 'PRESENTE' && (!linha || (!doPainel && !linha.igual_ao_disco)),
    pdfs: pdfs.filter(p => !p.no_banco && p.disco === 'CONFERE').length};
  const problemas = [
    // Sem linha, o disco é a única fonte: arquivo ilegível ou ausente deixaria a agenda pública sem regras depois do disco.
    ...(config.estado === 'ILEGIVEL' && !doPainel ? ['CONFIG_ILEGIVEL'] : []),
    ...(config.estado === 'AUSENTE' && !linha ? ['CONFIG_AUSENTE_SEM_LINHA'] : []),
    ...pdfs.filter(p => !p.no_banco && p.disco !== 'CONFERE').map(p => `PDF_${p.disco} ${p.id}`)];
  return {pendentes, problemas,
    config: {disco: {estado: config.estado, bytes: config.bytes, sha256: config.sha256, pacoteOverrides: config.pacoteOverrides, descontos: config.descontos},
      banco: linha ? {origem: linha.origem, atualizadoEm: linha.atualizado_em, igualAoDisco: linha.igual_ao_disco} : null},
    pdfs: pdfs.map(p => ({id: p.id, tamanho: Number(p.tamanho_bytes), sha256: p.sha256, noBanco: p.no_banco, disco: p.disco}))};
}
const pdfsComDisco = (disco, docs) => docs.map(d => ({...d, disco: d.no_banco ? 'NAO_LIDO' : lerPdfDoDisco(disco, d).estado}));
const situacao = r => r.problemas.length ? 'PROBLEMA' : (r.pendentes.config || r.pendentes.pdfs) ? 'PRONTO_PARA_COPIAR' : 'NADA_A_COPIAR';

async function abrir(amb, Client) {
  const db = new Client(amb.cfg); db.on?.('error', () => undefined);
  await db.connect();
  return db;
}
async function provarIdentidade(db, amb) { return amb.identidade((await db.query(amb.sqlIdentidade)).rows[0]); }

async function conferir({env, disco = DISCO, Client = require('pg').Client, amb = ambiente(env)}) {
  let db;
  try {
    db = await abrir(amb, Client);
    await db.query('BEGIN READ ONLY');
    const conexao = await provarIdentidade(db, amb);
    const config = lerConfigDoDisco(disco);
    const banco = await estadoNoBanco(db, config.conteudo ?? null);
    if (!banco.instalada) { await db.query('ROLLBACK'); return {resultado: 'RECUSARIA', ambiente: amb.nome, conexao, motivo: '128_AUSENTE'}; }
    const pdfs = pdfsComDisco(disco, banco.docs);
    await db.query('ROLLBACK');
    const r = resumir(banco, config, pdfs);
    return {resultado: r.problemas.length ? 'RECUSARIA' : 'CONFERIDO', situacao: situacao(r), ambiente: amb.nome, conexao, ...r};
  } catch (e) { await db?.query('ROLLBACK').catch(() => {}); return {resultado: 'FALHA', mensagem: curta(e)}; }
  finally { await db?.end().catch(() => {}); }
}

async function copiar({env, disco = DISCO, Client = require('pg').Client, amb = ambiente(env)}) {
  let db;
  // antes: nada foi confirmado (ROLLBACK). commit: o COMMIT foi enviado sem resposta. confirmado: gravado.
  let fase = 'antes';
  try {
    db = await abrir(amb, Client);
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout = '5s'");
    await db.query("SET LOCAL statement_timeout = '60s'");
    const conexao = await provarIdentidade(db, amb);
    // Mesma trava de lib/catalogo/documento-publico.ts (publicação): nenhum PDF muda de ativo durante a cópia.
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [TIPO]);
    const config = lerConfigDoDisco(disco);
    const banco = await estadoNoBanco(db, config.conteudo ?? null, true);
    assert.ok(banco.instalada, '128_AUSENTE');
    const antes = resumir(banco, config, pdfsComDisco(disco, banco.docs));
    assert.equal(antes.problemas.length, 0, antes.problemas.join(', '));
    let configCopiada = false;
    if (antes.pendentes.config) {
      // Linha PAINEL nunca é tocada (WHERE); linha DISCO só muda se o arquivo mudou.
      const r = await db.query(`INSERT INTO disponibilidade_config_legada (id, conteudo, origem, atualizado_em)
          VALUES (1, $1::jsonb, 'DISCO', clock_timestamp())
          ON CONFLICT (id) DO UPDATE SET conteudo = EXCLUDED.conteudo, atualizado_em = clock_timestamp()
          WHERE disponibilidade_config_legada.origem = 'DISCO' AND disponibilidade_config_legada.conteudo IS DISTINCT FROM EXCLUDED.conteudo`,
      [JSON.stringify(config.conteudo)]);
      configCopiada = r.rowCount === 1;
    }
    let pdfsCopiados = 0;
    for (const d of banco.docs) {
      if (d.no_banco) continue;
      const lido = lerPdfDoDisco(disco, d);
      assert.equal(lido.estado, 'CONFERE', `PDF_${lido.estado} ${d.id}`);
      const r = await db.query('UPDATE documentos_publicos SET conteudo = $1 WHERE id = $2::uuid AND ativo AND conteudo IS NULL AND sha256 = $3 AND tamanho_bytes = $4',
        [lido.bytes, d.id, d.sha256, lido.bytes.length]);
      assert.equal(r.rowCount, 1, `PDF_NAO_ATUALIZADO ${d.id}`);
      pdfsCopiados++;
    }
    fase = 'commit';
    await db.query('COMMIT');
    fase = 'confirmado';
    // Depois do COMMIT confirmado, qualquer falha (releitura, esquema, disco, resumo) é só da releitura: o resultado é
    // COPIADO. O arquivo é relido para o resumo comparar com o conteúdo atual, não com o lido antes do COMMIT.
    try {
      const configDepois = lerConfigDoDisco(disco);
      assert.ok(!configDepois.falhaLeitura, `RELEITURA_DO_ARQUIVO_FALHOU ${configDepois.falhaLeitura}`);
      const depois = await estadoNoBanco(db, configDepois.conteudo ?? null);
      assert.ok(depois.instalada, '128_AUSENTE_NA_RELEITURA');
      const r = resumir(depois, configDepois, pdfsComDisco(disco, depois.docs));
      return {resultado: 'COPIADO', situacao: situacao(r), ambiente: amb.nome, conexao, configCopiada, pdfsCopiados, releitura: 'APOS_COMMIT', ...r};
    } catch (e) {
      return {resultado: 'COPIADO', ambiente: amb.nome, conexao, configCopiada, pdfsCopiados, releitura: 'INDISPONIVEL', mensagem: curta(e),
        orientacao: `gravado; rode ${FLAG_CONFERIR} ${amb.nome} para o estado final`};
    }
  } catch (e) {
    if (fase === 'antes') { await db?.query('ROLLBACK').catch(() => {}); return {resultado: 'FALHA', mensagem: curta(e), nadaGravado: true}; }
    return {resultado: 'INDETERMINADO', mensagem: curta(e), nadaGravado: null,
      orientacao: `o COMMIT foi enviado sem confirmação; rode ${FLAG_CONFERIR} ${amb.nome} antes de repetir`};
  }
  finally { await db?.end().catch(() => {}); }
}

async function principal(argv, env, deps = {}) {
  const m = modo(argv, env);
  if (m.modo === 'plano') return {codigo: 0, saida: plano()};
  // As duas operações leem o disco: sem ele, a conferência diria NADA_A_COPIAR por engano.
  (deps.exigirDisco ?? (() => stg.exigirDisco()))();
  const amb = deps.amb ?? ambiente(env);
  const s = m.modo === 'conferir' ? await conferir({env, ...deps, amb}) : await copiar({env, ...deps, amb});
  return {codigo: CODIGO[s.resultado] ?? 2, saida: s};
}
function cli() {
  principal(process.argv.slice(2), process.env).then(({codigo, saida}) => {
    (codigo === 0 ? console.log : console.error)(JSON.stringify(saida)); process.exitCode = codigo;
  }).catch(e => { console.error('RECUSADO ' + curta(e)); process.exitCode = 1; });
}
if (require.main === module) cli();
module.exports = {DISCO, FLAG_CONFERIR, FLAG_COPIAR, ALVOS, CODIGO, ambiente, modo, plano, lerConfigDoDisco, lerPdfDoDisco, resumir, conferir, copiar, principal};
