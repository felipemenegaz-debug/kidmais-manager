/* eslint-disable @typescript-eslint/no-require-imports */
// Inventário e retrato restrito da 107/108 e a prova única de "108 íntegra" (plano E4, E4-3; P2-E4-R2-1 e P2-E4-R2-2 da
// rev. 2.1). Sem banco: ponto fixo das fontes igual ao congelado, omissão deliberada e referência não resolvida
// recusadas, contrato_fluxos/festas cobertas, SQL somente leitura, constantes iguais às do detector NOVA e esperados
// A_MEDIR_NO_CLUSTER recusando a comparação.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const inv = require('./migration-108-inventario.cjs');
const ret = require('./migration-108-retrato.cjs');

const raiz = path.resolve(__dirname, '..');
const M108 = fs.readFileSync(path.join(raiz, 'database/migrations/20261028_108_saloes_combinados.sql'), 'utf8').replace(/\r\n/g, '\n');
const sha = t => createHash('sha256').update(t, 'utf8').digest('hex');
const H = c => c.repeat(64);
/** Esperados "medidos" de mentira (só para exercitar o comparador), amarrados ao SQL atual. */
const medidos = (extra = {}) => ({versao_pg_maior: 18, trecho_sha256: ret.hashTrecho(ret.trechoRetrato108()),
  F0: {canonico: H('a'), deriva_conhecida: H('b')}, F1: {canonico: H('c')}, F2: {canonico: H('d')}, ...extra});
const copia = x => JSON.parse(JSON.stringify(x));

test('inventário: o ponto fixo recalculado das fontes reproduz o congelado', () => {
  const r = inv.conferir();
  assert.equal(r.ok, true, JSON.stringify(r.diferencas ?? r.erro));
  assert.deepEqual(r.atual.funcoes.map(f => f.nome), inv.INVENTARIO_108.funcoes.map(f => f.nome));
  assert.equal(inv.INVENTARIO_108.dinamicos.length, 0, 'nenhum corpo do escopo usa SQL dinâmico');
  assert.equal(inv.INVENTARIO_108.mencoesSemExtracao.length, 0, 'toda relação mencionada num corpo foi extraída');
});

test('inventário: dependências diretas dos corpos da 108, lidas à mão (não pelo gerador), estão no escopo', () => {
  // Revisão manual de 29/10/2026 dos 14 corpos da migration 108 e das dependências diretas das substituídas.
  const LIDAS_A_MAO = {
    kidmais098_conjunto: {chama: [], tabelas: ['agenda_saloes']},
    kidmais098_saloes_cruzam: {chama: ['kidmais098_conjunto'], tabelas: []},
    kidmais098_salao_elegivel: {chama: [], tabelas: ['agenda_saloes']},
    kidmais098_validar_elegibilidade: {chama: ['kidmais098_hoje', 'kidmais094_ocupacoes', 'kidmais098_conjunto', 'kidmais098_salao_elegivel'], tabelas: ['agenda_saloes']},
    kidmais098_salao_guarda: {chama: ['kidmais094_ocupacoes', 'kidmais098_hoje'], tabelas: ['agenda_saloes']},
    kidmais098_combinado_validar: {chama: ['kidmais098_membros_canonicos'], tabelas: ['agenda_saloes']},
    kidmais094_conflito_ocupacao: {chama: ['kidmais094_ocupacoes', 'kidmais062_mesmo_recurso', 'kidmais098_saloes_cruzam'], tabelas: ['agenda_escopo_config']},
    kidmais019_validar_contrato: {chama: ['kidmais019_formalizacao', 'kidmais019_ocupa', 'kidmais098_validar_elegibilidade', 'kidmais094_ocupacoes',
      'kidmais094_conflito_ocupacao', 'kidmais062_ocupacoes_escopo', 'kidmais062_bloqueio_aplica'],
    tabelas: ['contratos', 'contrato_fluxos', 'fechamento_revisoes', 'festas', 'bloqueios_agenda']},
    kidmais_validar_agenda_revisao: {chama: ['kidmais019_ocupa', 'kidmais061_historico_passado', 'kidmais_lock_datas_revisao', 'kidmais098_validar_elegibilidade',
      'kidmais094_conflito_ocupacao', 'kidmais062_bloqueio_aplica'], tabelas: ['fechamento_revisoes', 'fechamentos', 'bloqueios_agenda']},
    kidmais094_ocupacoes: {chama: ['kidmais019_ocupa', 'kidmais061_historico_passado'], tabelas: ['fechamentos', 'fechamento_revisoes', 'contrato_fluxos']},
    kidmais019_ocupa: {chama: ['kidmais019_formalizacao'], tabelas: ['fechamentos', 'contratos', 'contrato_fluxos']},
    kidmais019_formalizacao: {chama: ['kidmais061_conferencia_historica'],
      tabelas: ['contratos', 'contrato_fluxos', 'contrato_versoes', 'contrato_edicoes', 'contrato_documentos', 'contrato_assinaturas']},
    kidmais061_historico_passado: {chama: [], tabelas: ['contrato_importacoes', 'fechamentos']},
  };
  const funcoes = new Set(inv.INVENTARIO_108.funcoes.map(f => f.nome));
  const tabelas = new Set([...inv.INVENTARIO_108.tabelas, ...inv.INVENTARIO_108.tabelasLidas]);
  for (const [f, {chama, tabelas: ts}] of Object.entries(LIDAS_A_MAO)) {
    assert.ok(funcoes.has(f), f);
    for (const c of chama) assert.ok(funcoes.has(c), `${f} → ${c}`);
    for (const t of ts) assert.ok(tabelas.has(t), `${f} lê ${t}`);
  }
  for (const f of [...inv.FUNCOES_098, inv.MARCADOR_108, ...inv.SUBSTITUIDAS_108]) assert.ok(funcoes.has(f), f);
  // Gatilhos das tabelas do escopo (amostra lida nas migrations 005/016/019/061/094/102/104/106).
  for (const f of ['kidmais_set_atualizado_em', 'festa016_invalidacao', 'kidmais019_lock_ocupacao', 'kidmais094_salao_fechamento',
    'kidmais094_salao_revisao', 'kidmais102_salao_conteudo', 'kidmais104_hash_versao_imutavel', 'kidmais106_salao_preferido_escopo']) assert.ok(funcoes.has(f), f);
});

test('inventário: uma dependência omitida de propósito (função, tabela ou corpo) faz a conferência falhar', () => {
  for (const nome of ['kidmais062_mesmo_recurso', 'kidmais098_hoje', 'kidmais_set_atualizado_em']) {
    const c = copia(inv.INVENTARIO_108);
    c.funcoes = c.funcoes.filter(f => f.nome !== nome);
    const r = inv.conferir({inventario: c});
    assert.equal(r.ok, false, nome);
    assert.ok(r.diferencas.some(d => d.startsWith('funcao FALTA_NO_CONGELADO ' + nome + '@')), JSON.stringify(r.diferencas));
  }
  const semTabela = copia(inv.INVENTARIO_108);
  semTabela.tabelasLidas = semTabela.tabelasLidas.filter(t => t !== 'contrato_versoes');
  assert.ok(inv.conferir({inventario: semTabela}).diferencas.includes('tabelaLida FALTA_NO_CONGELADO contrato_versoes'));
  const outroCorpo = copia(inv.INVENTARIO_108);
  outroCorpo.funcoes.find(f => f.nome === 'kidmais094_ocupacoes').corpos = [H('0')];
  assert.equal(inv.conferir({inventario: outroCorpo}).ok, false, 'corpo da fonte mudou sem revisar o congelado');
  // Fonte sem a definição de uma função chamada: o ponto fixo recusa (referência não resolvida).
  const fontes = inv.lerFontes().map(f => (f.arquivo.includes('_062_') ? {...f, texto: f.texto.replace(/CREATE (OR REPLACE )?FUNCTION (public\.)?kidmais062_mesmo_recurso\(/g, 'CREATE FUNCTION kidmais062_renomeada(')} : f));
  assert.throws(() => inv.calcularInventario({fontes}), /REFERENCIA_NAO_RESOLVIDA kidmais062_mesmo_recurso/);
});

test('inventário: referência não resolvida e gatilho dinâmico não revisado recusam', () => {
  const fontes = [...inv.lerFontes(), {arquivo: '20261028_108_zz_teste.sql', texto: `-- teste
CREATE OR REPLACE FUNCTION public.kidmais098_hoje() RETURNS date LANGUAGE sql AS $$ SELECT kidmais999_nao_existe() $$;`}];
  assert.throws(() => inv.calcularInventario({fontes}), /REFERENCIA_NAO_RESOLVIDA kidmais999_nao_existe/);
  const r = inv.conferir({fontes});
  assert.equal(r.ok, false);
  assert.match(r.erro, /REFERENCIA_NAO_RESOLVIDA/);
  // Comentário não é chamada.
  const comentario = [...inv.lerFontes(), {arquivo: 'x.sql', texto: `CREATE OR REPLACE FUNCTION public.kidmais098_hoje() RETURNS date LANGUAGE sql AS $$
 -- kidmais999_nao_existe()
 SELECT (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date
$$;`}];
  assert.doesNotThrow(() => inv.calcularInventario({fontes: comentario}));
  const revisados = inv.GATILHOS_DINAMICOS_REVISADOS.filter(g => g.funcao !== 'kidmais_set_atualizado_em');
  assert.throws(() => inv.calcularInventario({revisados}), /GATILHO_DINAMICO_NAO_REVISADO 20261028_107_reparo_deriva_agenda\.sql kidmais_set_atualizado_em/);
  const comDrop = [...inv.lerFontes(), {arquivo: 'y.sql', texto: 'CREATE FUNCTION public.kidmais108_instalada() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$; DROP FUNCTION public.kidmais098_hoje();'}];
  assert.throws(() => inv.calcularInventario({fontes: comDrop}), /DROP_FUNCTION_NAO_TRATADO/);
});

test('inventário: contrato_fluxos e festas têm estrutura completa no retrato (colunas, constraints, índices, gatilhos)', () => {
  for (const t of ['contrato_fluxos', 'festas', 'agenda_saloes', 'contratos', 'fechamentos', 'fechamento_revisoes', 'agenda_escopo_config',
    'configuracao_agenda', 'configuracao_agenda_saloes', 'bloqueios_agenda', 'kidmais107_reparos']) assert.ok(inv.INVENTARIO_108.tabelas.includes(t), t);
  const trecho = ret.trechoRetrato108();
  for (const chave of ['colunas', 'constraints', 'indices', 'gatilhos']) {
    const bloco = trecho.slice(trecho.indexOf(`'${chave}'`), trecho.indexOf('\n  \'', trecho.indexOf(`'${chave}'`) + 1));
    for (const t of ['contrato_fluxos', 'festas']) assert.ok(bloco.includes(`'${t}'`), `${chave} cobre ${t}`);
  }
  // As tabelas só lidas entram nas colunas (nome, tipo, nulidade, default), sem filtro de coluna.
  const colunas = trecho.slice(trecho.indexOf("'colunas'"), trecho.indexOf("'constraints'"));
  for (const t of inv.INVENTARIO_108.tabelasLidas) assert.ok(colunas.includes(`'${t}'`), t);
  assert.doesNotMatch(colunas, /attname IN/);
  for (const f of inv.INVENTARIO_108.funcoes) assert.ok(trecho.includes(`'${f.nome}'`), f.nome);
});

test('retrato: o arquivo SQL é o gerado do inventário, com um único par de marcadores; esperados amarrados ao trecho', () => {
  const texto = fs.readFileSync(path.join(raiz, ret.ARQUIVO_RETRATO), 'utf8');
  assert.equal(texto.replace(/\r\n/g, '\n'), ret.arquivoRetrato108());
  assert.equal(ret.lerTrechoArquivo(), ret.trechoRetrato108());
  assert.throws(() => ret.extrairTrecho(texto + '\n' + ret.INICIO + '\n' + ret.FIM), /RETRATO_108_MARCADORES/);
  assert.equal(ret.carregarEsperados().trecho_sha256, ret.hashTrecho(ret.trechoRetrato108()));
  const outro = copia(inv.INVENTARIO_108);
  outro.funcoes = outro.funcoes.slice(1);
  assert.notEqual(ret.trechoRetrato108(outro), ret.trechoRetrato108(), 'o trecho depende do inventário');
});

/** SQL sem literais nem comentários: nenhuma palavra de escrita/DDL, nenhuma chamada a função do escopo, um só comando. */
function exigirSomenteLeitura(sql, rotulo) {
  const {mascarado} = inv.lexar(sql);
  assert.doesNotMatch(mascarado, /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|CREATE|ALTER|DROP|GRANT|REVOKE|COPY|SET|RESET|LOCK|CALL|DO|EXECUTE|PERFORM|COMMENT|VACUUM|ANALYZE|REFRESH|CLUSTER|REINDEX|NOTIFY|LISTEN|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|PREPARE|DISCARD|SECURITY)\b/i, rotulo);
  assert.doesNotMatch(mascarado, /\bFOR\s+(UPDATE|SHARE|NO\s+KEY|KEY)\b/i, rotulo);
  assert.doesNotMatch(mascarado, /\b(?:kidmais|festa)[0-9a-z_]*\s*\(/i, rotulo + ': nenhuma função do escopo é executada');
  assert.doesNotMatch(mascarado, /\b(?:pg_advisory|nextval|setval|set_config|pg_sleep|lo_|dblink)/i, rotulo);
  assert.ok(!mascarado.includes(';'), rotulo + ': um único comando');
  assert.match(mascarado.trimStart(), /^SELECT\b/, rotulo);
}

test('retrato e prova: SQL somente leitura (sem DDL/DML fora de literais), ordenação "C" e deparse sem normalização', () => {
  const arquivo = fs.readFileSync(path.join(raiz, ret.ARQUIVO_RETRATO), 'utf8');
  exigirSomenteLeitura(arquivo.replace(/;\s*$/, ''), 'arquivo do retrato');
  exigirSomenteLeitura(ret.sqlRetrato108(), 'sqlRetrato108');
  exigirSomenteLeitura(ret.sqlProva108Integra({esperados: medidos()}), 'sqlProva108Integra');
  const trecho = ret.trechoRetrato108();
  for (const linha of trecho.split('\n').filter(l => l.includes('ORDER BY'))) assert.match(linha.slice(linha.indexOf('ORDER BY')), /COLLATE "C"/, linha);
  // P2-1 da revisão da E4: nenhum pg_get_* passa por normalização textual (remover "public." apagava conteúdo de
  // literais: o default 'public.X' ficava igual a 'X'). search_path = pg_catalog já torna o deparse determinístico.
  for (const def of ['pg_get_constraintdef', 'pg_get_indexdef', 'pg_get_triggerdef', 'pg_get_expr', 'pg_get_function_result']) {
    assert.ok(trecho.includes('pg_catalog.' + def + '('), def);
  }
  assert.doesNotMatch(trecho, /regexp_replace|\breplace\(\s*pg_catalog\.pg_get/, 'retrato sem normalização textual do deparse');
  assert.doesNotMatch(trecho, /public\\\\?\./, 'nenhum padrão de "public." no retrato');
  assert.deepEqual(ret.PREPARO_SESSAO, ['SET LOCAL search_path = pg_catalog']);
});

test('prova 108: inclui a integridade da 107 (estrutura e linhas do registro), a mesma consulta do aplicador 107/108', () => {
  const def107 = require('./migration-107-definicoes.cjs');
  const sql = ret.sqlProva108Integra({esperados: medidos()});
  assert.ok(sql.includes(def107.sqlIntegridade107()), 'a prova reusa sqlIntegridade107() sem alteração');
  assert.ok(sql.includes("'INTEGRIDADE_107 ' || i.motivo"), 'cada falha da 107 vira motivo nomeado da prova');
  assert.match(sql, /WHERE i\.ok IS NOT TRUE/, 'ok nulo também é falha');
  // A integridade da 107 lê as linhas do registro (ação, tabela, nome anterior e definição contra o que a 107 grava).
  assert.match(def107.sqlIntegridade107(), /r\.definicao = r\.d_esperado/);
});

test('esperados: o carregador comum (094, 100, 107/108) só aceita o arquivo com o hash revisado (P2-3)', () => {
  const ev = require('./migration-108-evidencias.cjs');
  const texto = fs.readFileSync(path.join(raiz, ret.ARQUIVO_ESPERADOS), 'utf8').replace(/\r/g, '');
  assert.equal(sha(texto), ret.HASH_ESPERADOS, 'o arquivo versionado é o revisado');
  const comum = require('./migration-107-108-comum.cjs');
  assert.equal(comum.ARQUIVOS.find(([n]) => n === 'retratos esperados 108')[2], ret.HASH_ESPERADOS, 'o aplicador 107/108 fixa o MESMO hash');
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'esperados-108-'));
  try {
    const destino = path.join(tmp, ret.ARQUIVO_ESPERADOS);
    fs.mkdirSync(path.dirname(destino), {recursive: true});
    // CRLF do checkout é o mesmo conteúdo.
    fs.writeFileSync(destino, texto.replace(/\n/g, '\r\n'));
    assert.deepEqual(ret.carregarEsperados(tmp), JSON.parse(texto));
    // Só o hash de F2 trocado, trecho_sha256 intacto (o caso reproduzido na revisão): recusa nos dois carregadores.
    const x = JSON.parse(texto);
    x.F2 = {canonico: H('f')};
    fs.writeFileSync(destino, JSON.stringify(x, null, 2) + '\n');
    assert.throws(() => ret.carregarEsperados(tmp), /RETRATO_108_ESPERADOS_NAO_REVISADOS/, 'ESPERADOS_NAO_REVISADOS_ACEITOS carregarEsperados');
    assert.throws(() => ev.esperados108({raiz: tmp}), /RETRATO_108_ESPERADOS_NAO_REVISADOS/, 'ESPERADOS_NAO_REVISADOS_ACEITOS esperados108');
  } finally { fs.rmSync(tmp, {recursive: true, force: true}); }
});

test('prova 108: as constantes são as do detector NOVA (lib/agenda/estado-combinados.ts) e as dos corpos da migration', async () => {
  const det = await import('../lib/agenda/estado-combinados.ts');
  assert.equal(ret.NOVA.hashes.conflito108, det.HASHES_COMBINADOS.conflito108);
  assert.equal(ret.NOVA.hashes.contrato, det.HASHES_COMBINADOS.contrato);
  assert.equal(ret.NOVA.hashes.revisao, det.HASHES_COMBINADOS.revisao);
  assert.deepEqual({...ret.NOVA.funcoes}, {...det.FUNCOES_COMBINADOS});
  assert.deepEqual(ret.NOVA.gatilhos.map(g => [...g]), det.GATILHOS_COMBINADOS.map(g => [...g]));
  assert.equal(ret.NOVA.checkMembros, det.CHECK_MEMBROS_NORMALIZADO);
  const sql = ret.sqlProva108Integra({esperados: medidos()});
  for (const h of [...Object.values(ret.NOVA.hashes), ...Object.values(ret.NOVA.funcoes), ret.HASH_MARCADOR_108, ret.NOVA.checkMembros]) assert.ok(sql.includes(`'${h}'`), h);
  for (const [n, t, f, tipo, dif] of ret.NOVA.gatilhos) assert.ok(sql.includes(`('${n}', '${t}', '${f}', ${tipo}, ${dif},`), n);
  assert.ok(sql.includes(`IN ('${H('d')}')`), 'retrato de F2 comparado ao esperado');
  assert.ok(sql.includes(ret.trechoRetrato108()), 'a prova reusa o MESMO trecho do retrato');
  // Os corpos extraídos estaticamente da migration 108 (inventário) batem com o detector: o lexer lê o prosrc certo.
  const corpo = nome => inv.INVENTARIO_108.funcoes.find(f => f.nome === nome).corpos;
  for (const [n, h] of Object.entries(ret.NOVA.funcoes)) assert.deepEqual(corpo(n), [h], n);
  assert.deepEqual(corpo('kidmais094_conflito_ocupacao'), [ret.NOVA.hashes.conflito108]);
  assert.deepEqual(corpo('kidmais019_validar_contrato'), [ret.NOVA.hashes.contrato]);
  assert.deepEqual(corpo('kidmais_validar_agenda_revisao'), [ret.NOVA.hashes.revisao]);
  assert.deepEqual(corpo('kidmais108_instalada'), [ret.HASH_MARCADOR_108]);
  assert.equal(sha(' SELECT true '), ret.HASH_MARCADOR_108);
  for (const motivo of ['FUNCOES_098_CORPO', 'COLUNA_COMBINADO', 'CHECK_MEMBROS', 'GATILHOS_098', 'CORPO_CONFLITO_108', 'MARCADOR_108', 'METADADOS ', 'RETRATO_F2']) {
    assert.ok(sql.includes(`'${motivo}`), motivo);
  }
});

test('prova 108: metadados das 14 funções são os da migration (linguagem, volatilidade, search_path, sem SECURITY DEFINER)', () => {
  const extraidos = [];
  for (const s of inv.instrucoes(M108)) {
    const m = /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.(\w+)\s*\(([^)]*)\)/i.exec(s.mascarado);
    if (!m) continue;
    const cab = s.mascarado.replace(/\s+/g, ' ');
    assert.doesNotMatch(cab, /SECURITY\s+DEFINER/i, m[1]);
    const linguagem = /LANGUAGE (\w+)/i.exec(cab)[1].toLowerCase();
    const vol = /\bIMMUTABLE\b/i.test(cab) ? 'i' : /\bSTABLE\b/i.test(cab) ? 's' : 'v';
    const sp = /SET search_path = ([\w, ]+?) AS/i.exec(cab);
    extraidos.push([m[1], linguagem, vol, sp ? 'search_path=' + sp[1].trim() : null]);
  }
  assert.equal(extraidos.length, 14);
  const porNome = Object.fromEntries(ret.METADADOS_108.map(([s, ...r]) => [s.slice(0, s.indexOf('(')), r]));
  for (const [nome, ...r] of extraidos) assert.deepEqual(porNome[nome], r, nome);
  assert.equal(Object.keys(porNome).length, 14);
});

test('esperados: A_MEDIR_NO_CLUSTER recusa comparar (retrato e prova); medidos comparam por fase e variante', () => {
  // O arquivo versionado traz os retratos MEDIDOS no cluster E4 (29/10/2026): 64 hex em toda variante, aceitos.
  const versionado = ret.carregarEsperados();
  for (const fase of ret.FASES) {
    assert.ok(Object.values(versionado[fase]).every(h => /^[0-9a-f]{64}$/.test(h)), fase + ' medida');
    assert.deepEqual(ret.hashesAceitos(fase, versionado).map(a => a.variante), Object.keys(versionado[fase]));
  }
  assert.doesNotThrow(() => ret.sqlProva108Integra(), 'prova com o F2 medido');
  const P = ret.PENDENTE;
  const esperados = medidos({F0: {canonico: P, deriva_conhecida: P}, F1: {canonico: P}, F2: {canonico: P}});
  for (const fase of ret.FASES) {
    assert.throws(() => ret.hashesAceitos(fase, esperados), /RETRATO_108_NAO_MEDIDO/);
    assert.throws(() => ret.compararRetrato108(fase, {hash_108: H('a'), search_path: 'pg_catalog', versao_pg: 180006}, esperados), /RETRATO_108_NAO_MEDIDO/);
  }
  assert.throws(() => ret.sqlProva108Integra({esperados}), /RETRATO_108_NAO_MEDIDO F2/);
  // Uma variante pendente basta para recusar a fase inteira.
  assert.throws(() => ret.hashesAceitos('F0', medidos({F0: {canonico: H('a'), deriva_conhecida: ret.PENDENTE}})), /NAO_MEDIDO F0\.deriva_conhecida/);
  assert.throws(() => ret.hashesAceitos('F1', medidos({F1: {canonico: 'abc'}})), /ESPERADO_INVALIDO/);
  assert.throws(() => ret.hashesAceitos('F1', medidos({F1: {}})), /SEM_ESPERADO/);
  assert.throws(() => ret.hashesAceitos('F3', medidos()), /FASE_DESCONHECIDA/);
  assert.throws(() => ret.hashesAceitos('F2', medidos({trecho_sha256: H('e')})), /ESPERADO_DE_OUTRO_SQL/);
  assert.throws(() => ret.hashesAceitos('F2', medidos({versao_pg_maior: 17})), /VERSAO_ESPERADA/);
  const linha = (hash, extra = {}) => ({hash_108: hash, search_path: 'pg_catalog', versao_pg: 180006, ...extra});
  assert.deepEqual(ret.compararRetrato108('F0', linha(H('b')), medidos()), {fase: 'F0', ok: true, variante: 'deriva_conhecida'});
  assert.deepEqual(ret.compararRetrato108('F0', linha(H('a')), medidos()), {fase: 'F0', ok: true, variante: 'canonico'});
  assert.deepEqual(ret.compararRetrato108('F1', linha(H('a')), medidos()), {fase: 'F1', ok: false, variante: null}, 'o hash de F0 não vale em F1');
  assert.deepEqual(ret.compararRetrato108('F2', linha(H('d')), medidos()), {fase: 'F2', ok: true, variante: 'canonico'});
  assert.throws(() => ret.compararRetrato108('F2', linha(H('d'), {search_path: 'public, pg_catalog'}), medidos()), /RETRATO_108_SEARCH_PATH/);
  assert.throws(() => ret.compararRetrato108('F2', linha(H('d'), {versao_pg: 170004}), medidos()), /RETRATO_108_VERSAO_PG/);
  assert.throws(() => ret.compararRetrato108('F2', linha('x'), medidos()), /RETRATO_108_ILEGIVEL/);
});
