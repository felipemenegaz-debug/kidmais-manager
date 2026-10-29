/* eslint-disable @typescript-eslint/no-require-imports */
// Inventário do retrato restrito da 108 (plano E4, E4-3; critério P2-E4-R2-1 da rev. 2.1). O escopo do retrato é
// fechado por PONTO FIXO a partir das FONTES (as migrations da cadeia), não do banco:
//   * fontes: database/migrations/*.sql em ordem de nome até a 108, sem a 098 histórica (20261023_098_*, nunca aplicada)
//     e sem arquivos de down (*_down.sql);
//   * definição de cada função: a ÚLTIMA `CREATE [OR REPLACE] FUNCTION [public.]<nome>(<args>)` da cadeia (por nome e
//     argumentos), inclusive as da 108 (que substituem 3 corpos). Função só criada dentro de string (EXECUTE) recusa;
//   * conjunto inicial: as 10 kidmais098_*, o marcador kidmais108_instalada, as 3 substituídas e as funções de gatilhos,
//     CHECKs, defaults e índices das tabelas do escopo;
//   * cada chamada `<nome>(` no corpo (sem comentários) a uma função definida na cadeia entra no escopo; uma chamada
//     `kidmais...(` a função NUNCA definida na cadeia é referência não resolvida e RECUSA o inventário;
//   * tabelas: as citadas nos corpos (FROM/JOIN/UPDATE/INTO/TABLE/ONLY e %ROWTYPE) que a cadeia cria, mais as
//     explícitas do plano; cada tabela nova traz os gatilhos/CHECKs/defaults dela, até nada novo aparecer;
//   * gatilhos criados dentro de string (EXECUTE format, 015/095/107) não são deriváveis pela leitura estática da
//     instrução: cada ocorrência precisa estar em GATILHOS_DINAMICOS_REVISADOS (tabelas lidas no arquivo, revisão
//     manual), senão RECUSA;
//   * corpo com EXECUTE (SQL dinâmico) é marcado em `dinamicos` para revisão manual (as tabelas montadas em tempo de
//     execução não são deriváveis).
// O inventário CONGELADO abaixo foi revisado contra os corpos (lidos, não só a extração deste gerador). `conferir()`
// recalcula das fontes e compara: qualquer diferença (dependência omitida, tabela a mais, arquivo de definição
// diferente) é FALHA. Sem banco, sem rede.
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');

const DIR_MIGRATIONS = 'database/migrations';
const ULTIMA = '20261028_108_saloes_combinados.sql';
const EXCLUIDAS = Object.freeze([/^20261023_098_/, /_down\.sql$/]);

/** Conjunto inicial de funções (E4-3). */
const FUNCOES_098 = Object.freeze(['kidmais098_hoje', 'kidmais098_membros_canonicos', 'kidmais098_conjunto', 'kidmais098_saloes_cruzam',
  'kidmais098_salao_elegivel', 'kidmais098_validar_elegibilidade', 'kidmais098_salao_guarda', 'kidmais098_combinado_validar',
  'kidmais098_proibir_truncate', 'kidmais098_contrato_guarda']);
const MARCADOR_108 = 'kidmais108_instalada';
const SUBSTITUIDAS_108 = Object.freeze(['kidmais094_conflito_ocupacao', 'kidmais019_validar_contrato', 'kidmais_validar_agenda_revisao']);
/** Tabelas explícitas do plano (E4-3 e P2-E4-R2-1: contrato_fluxos e festas incluídas). */
const TABELAS_EXPLICITAS = Object.freeze(['agenda_saloes', 'contratos', 'contrato_fluxos', 'festas', 'fechamentos', 'fechamento_revisoes',
  'agenda_escopo_config', 'configuracao_agenda', 'configuracao_agenda_saloes', 'bloqueios_agenda', 'kidmais107_reparos']);

/**
 * Gatilhos criados por SQL dinâmico (texto dentro de string), revisados à mão no arquivo: a função e as tabelas em que o
 * laço cria o gatilho. Uma ocorrência dinâmica fora desta lista recusa o inventário.
 */
const GATILHOS_DINAMICOS_REVISADOS = Object.freeze([
  {arquivo: '20260910_015_tratamento_financeiro.sql', funcao: 'kidmais_015_imutavel', tabelas: ['pagamento_eventos', 'pagamento_ajustes_contratuais',
    'pagamento_cronograma_itens', 'pagamento_movimentos_contextos', 'pagamento_devolucao_alocacoes', 'pagamento_devolucao_comprovantes', 'pagamento_ajuste_bases']},
  {arquivo: '20260910_015_tratamento_financeiro.sql', funcao: 'kidmais_015_processo', tabelas: ['pagamento_gestoes', 'pagamento_tratamentos',
    'pagamento_cronogramas', 'pagamento_credito_reservas', 'pagamento_devolucoes']},
  {arquivo: '20260910_015_tratamento_financeiro.sql', funcao: 'kidmais_015_proteger_legado', tabelas: ['pagamentos', 'pagamento_parcelas',
    'pagamento_recebimentos', 'pagamento_estornos', 'pagamento_recebimento_alocacoes', 'pagamento_comprovantes']},
  {arquivo: '20260910_015_tratamento_financeiro.sql', funcao: 'kidmais_015_validar', tabelas: ['pagamento_gestoes', 'pagamento_tratamentos',
    'pagamento_eventos', 'pagamento_ajustes_contratuais', 'pagamento_cronogramas', 'pagamento_cronograma_itens', 'pagamento_movimentos_contextos',
    'pagamento_credito_reservas', 'pagamento_devolucoes', 'pagamento_devolucao_alocacoes', 'pagamento_devolucao_comprovantes', 'pagamento_ajuste_bases',
    'pagamentos', 'pagamento_parcelas', 'pagamento_recebimentos', 'pagamento_estornos', 'pagamento_recebimento_alocacoes']},
  {arquivo: '20261022_095_ia_creditos.sql', funcao: 'kidmais_095_guarda', tabelas: ['ia_credito_carteiras', 'ia_credito_pedidos', 'ia_credito_lotes',
    'ia_credito_lancamentos', 'ia_credito_reservas', 'ia_credito_reserva_lotes', 'ia_credito_cobrancas', 'ia_credito_devolucoes', 'ia_credito_cortesias',
    'ia_credito_cortes', 'ia_credito_notificacoes']},
  {arquivo: '20261028_107_reparo_deriva_agenda.sql', funcao: 'kidmais_set_atualizado_em', tabelas: ['bloqueios_agenda', 'configuracao_agenda']},
]);

// ---------------------------------------------------------------------------------------------------------------------
// Leitura léxica mínima do SQL: tira comentários (-- e /* */), preserva strings ('...', E'...') e corpos $tag$...$tag$.
// `mascarado` tem o mesmo comprimento do texto, com o conteúdo de strings e corpos trocado por espaços (para regex sem
// falso positivo dentro de literais).
// ---------------------------------------------------------------------------------------------------------------------
function lexar(texto) {
  const src = texto.replace(/\r/g, '');
  let limpo = '', mascarado = '';
  const strings = [], corpos = [];
  let i = 0;
  const emIdent = k => k >= 0 && /[A-Za-z0-9_]/.test(src[k]);
  while (i < src.length) {
    const c = src[i];
    if (c === '-' && src[i + 1] === '-') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') {
      let prof = 1; i += 2;
      while (i < src.length && prof > 0) {
        if (src[i] === '/' && src[i + 1] === '*') { prof++; i += 2; } else if (src[i] === '*' && src[i + 1] === '/') { prof--; i += 2; } else i++;
      }
      limpo += ' '; mascarado += ' '; continue;
    }
    if (c === "'") {
      const escape = (src[i - 1] === 'E' || src[i - 1] === 'e') && !emIdent(i - 2);
      let j = i + 1, conteudo = '';
      for (;;) {
        if (j >= src.length) throw new Error('SQL_STRING_ABERTA');
        if (escape && src[j] === '\\') { conteudo += src[j] + (src[j + 1] ?? ''); j += 2; continue; }
        if (src[j] === "'") { if (src[j + 1] === "'") { conteudo += "''"; j += 2; continue; } break; }
        conteudo += src[j]; j++;
      }
      const inicio = limpo.length + 1;
      strings.push({inicio, conteudo});
      limpo += "'" + conteudo + "'"; mascarado += "'" + ' '.repeat(conteudo.length) + "'";
      i = j + 1; continue;
    }
    if (c === '$' && !emIdent(i - 1)) {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(src.slice(i));
      if (m) {
        const tag = m[0];
        const fim = src.indexOf(tag, i + tag.length);
        if (fim < 0) throw new Error('SQL_CORPO_ABERTO ' + tag);
        const conteudo = src.slice(i + tag.length, fim);
        const inicio = limpo.length + tag.length;
        corpos.push({inicio, conteudo});
        limpo += tag + conteudo + tag; mascarado += tag + ' '.repeat(conteudo.length) + tag;
        i = fim + tag.length; continue;
      }
    }
    limpo += c; mascarado += c; i++;
  }
  return {limpo, mascarado, strings, corpos};
}

/** Instruções de topo (separadas por `;` fora de literais), cada uma com o próprio texto limpo e mascarado. */
function instrucoes(texto) {
  const {limpo, mascarado, strings, corpos} = lexar(texto);
  const r = [];
  let inicio = 0;
  const fechar = fim => {
    const s = {limpo: limpo.slice(inicio, fim), mascarado: mascarado.slice(inicio, fim),
      strings: strings.filter(x => x.inicio >= inicio && x.inicio < fim).map(x => x.conteudo),
      corpos: corpos.filter(x => x.inicio >= inicio && x.inicio < fim).map(x => x.conteudo)};
    if (s.mascarado.trim()) r.push(s);
    inicio = fim + 1;
  };
  for (let k = 0; k < mascarado.length; k++) if (mascarado[k] === ';') fechar(k);
  fechar(mascarado.length);
  return r;
}

function fecharParenteses(texto, abre) {
  let prof = 0;
  for (let k = abre; k < texto.length; k++) {
    if (texto[k] === '(') prof++;
    else if (texto[k] === ')' && --prof === 0) return k;
  }
  throw new Error('SQL_PARENTESES_ABERTOS');
}

const ID = '"?([A-Za-z_][A-Za-z0-9_]*)"?';
const RE_FUNCAO = new RegExp(`^\\s*CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(?:public\\.)?${ID}\\s*\\(`, 'i');
const RE_GATILHO = new RegExp(`^\\s*CREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:CONSTRAINT\\s+)?TRIGGER\\s+${ID}[\\s\\S]*?\\bON\\s+(?:ONLY\\s+)?(?:public\\.)?${ID}[\\s\\S]*?\\bEXECUTE\\s+(?:FUNCTION|PROCEDURE)\\s+(?:public\\.)?${ID}\\s*\\(`, 'i');
const RE_SOLTAR_GATILHO = new RegExp(`^\\s*DROP\\s+TRIGGER\\s+(?:IF\\s+EXISTS\\s+)?${ID}\\s+ON\\s+(?:ONLY\\s+)?(?:public\\.)?${ID}`, 'i');
const RE_TABELA = new RegExp(`^\\s*CREATE\\s+(?:UNLOGGED\\s+)?(?:TABLE|VIEW|OR\\s+REPLACE\\s+VIEW)\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:public\\.)?${ID}`, 'i');
const RE_ALTERAR_TABELA = new RegExp(`^\\s*ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?(?:public\\.)?${ID}`, 'i');
const RE_INDICE = new RegExp(`^\\s*CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:${ID}\\s+)?ON\\s+(?:ONLY\\s+)?(?:public\\.)?${ID}`, 'i');
const normalizarArgs = a => a.toLowerCase().replace(/\s+/g, ' ').replace(/\s*([(),])\s*/g, '$1').trim();

/** Fontes da cadeia: arquivos em ordem de nome, até a 108, sem a 098 histórica e sem downs. */
function lerFontes(raiz = path.resolve(__dirname, '..')) {
  const dir = path.join(raiz, DIR_MIGRATIONS);
  return fs.readdirSync(dir).filter(n => n.endsWith('.sql') && n <= ULTIMA && !EXCLUIDAS.some(re => re.test(n))).sort()
    .map(arquivo => ({arquivo, texto: fs.readFileSync(path.join(dir, arquivo), 'utf8')}));
}

/**
 * Catálogo estático da cadeia: definições de função (a última por nome+argumentos), gatilhos vigentes por tabela,
 * relações criadas, instruções de estrutura por tabela (CREATE/ALTER TABLE, CREATE INDEX) e ocorrências dinâmicas.
 */
function catalogar(fontes) {
  const funcoes = new Map(); // nome -> Map(args -> {arquivo, corpo, cabecalho})
  const gatilhos = new Map(); // tabela -> Map(nome -> {funcao, arquivo})
  const relacoes = new Set();
  const estrutura = new Map(); // tabela -> [texto limpo]
  const dinamicos = [];
  const recusas = [];
  const processar = (arquivo, texto) => {
    for (const s of instrucoes(texto)) {
      for (const lit of s.strings) {
        const m = /EXECUTE\s+(?:FUNCTION|PROCEDURE)\s+(?:public\.)?"?([A-Za-z_][A-Za-z0-9_]*)"?\s*\(/i.exec(lit);
        if (m && /CREATE\s+(?:CONSTRAINT\s+)?TRIGGER/i.test(lit)) dinamicos.push({arquivo, funcao: m[1].toLowerCase()});
        if (/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION/i.test(lit)) recusas.push(`FUNCAO_DINAMICA ${arquivo}`);
      }
      let m;
      if ((m = RE_FUNCAO.exec(s.mascarado))) {
        const abre = s.mascarado.indexOf('(', m.index + m[0].length - 1);
        const fecha = fecharParenteses(s.mascarado, abre);
        const args = normalizarArgs(s.limpo.slice(abre + 1, fecha));
        if (s.corpos.length !== 1) { recusas.push(`CORPO_NAO_RECONHECIDO ${arquivo} ${m[1]}`); continue; }
        const nome = m[1].toLowerCase();
        if (!funcoes.has(nome)) funcoes.set(nome, new Map());
        funcoes.get(nome).set(args, {arquivo, corpo: s.corpos[0], cabecalho: s.mascarado.replace(/\s+/g, ' ').trim()});
        continue;
      }
      if (/^\s*DROP\s+FUNCTION/i.test(s.mascarado)) { recusas.push(`DROP_FUNCTION_NAO_TRATADO ${arquivo}`); continue; }
      if ((m = RE_GATILHO.exec(s.mascarado))) {
        const tabela = m[2].toLowerCase();
        if (!gatilhos.has(tabela)) gatilhos.set(tabela, new Map());
        gatilhos.get(tabela).set(m[1].toLowerCase(), {funcao: m[3].toLowerCase(), arquivo});
        continue;
      }
      if ((m = RE_SOLTAR_GATILHO.exec(s.mascarado))) { gatilhos.get(m[2].toLowerCase())?.delete(m[1].toLowerCase()); continue; }
      if (/^\s*DO\b/i.test(s.mascarado)) { for (const corpo of s.corpos) processar(arquivo, corpo); continue; }
      if ((m = RE_TABELA.exec(s.mascarado))) relacoes.add(m[1].toLowerCase());
      const alvo = (RE_TABELA.exec(s.mascarado) ?? RE_ALTERAR_TABELA.exec(s.mascarado))?.[1] ?? RE_INDICE.exec(s.mascarado)?.[2];
      if (alvo) {
        const t = alvo.toLowerCase();
        if (!estrutura.has(t)) estrutura.set(t, []);
        estrutura.get(t).push(s.limpo);
      }
    }
  };
  for (const {arquivo, texto} of fontes) processar(arquivo, texto);
  return {funcoes, gatilhos, relacoes, estrutura, dinamicos, recusas};
}

/** Chamadas `<nome>(` num texto (sem comentários), inclusive dentro de strings (to_regprocedure, EXECUTE). */
const chamadas = texto => new Set([...lexar(texto).limpo.matchAll(/(?<![A-Za-z0-9_$])([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)].map(m => m[1].toLowerCase()));
const RE_LEITURA = /\b(?:FROM|JOIN|UPDATE|INTO|TABLE|ONLY)\s+(?:public\.)?"?([A-Za-z_][A-Za-z0-9_]*)"?/gi;
const RE_ESCRITA = /\b(?:UPDATE\s+(?:ONLY\s+)?|INSERT\s+INTO\s+|DELETE\s+FROM\s+(?:ONLY\s+)?|TRUNCATE\s+(?:TABLE\s+)?(?:ONLY\s+)?)(?:public\.)?"?([A-Za-z_][A-Za-z0-9_]*)"?/gi;
/** Tabelas citadas no corpo (fora de literais): após FROM/JOIN/UPDATE/INTO/TABLE/ONLY e antes de %ROWTYPE. */
function tabelasCitadas(texto, relacoes) {
  const {mascarado} = lexar(texto);
  const achadas = new Set();
  for (const m of mascarado.matchAll(RE_LEITURA)) achadas.add(m[1].toLowerCase());
  for (const m of mascarado.matchAll(/(?:public\.)?([A-Za-z_][A-Za-z0-9_]*)%ROWTYPE/gi)) achadas.add(m[1].toLowerCase());
  return [...achadas].filter(t => relacoes.has(t));
}
/** Tabelas ESCRITAS pelo corpo (UPDATE/INSERT/DELETE/TRUNCATE): só escrita dispara os gatilhos da tabela. */
function tabelasEscritas(texto, relacoes) {
  const {mascarado} = lexar(texto);
  return [...new Set([...mascarado.matchAll(RE_ESCRITA)].map(m => m[1].toLowerCase()))].filter(t => relacoes.has(t));
}
/** Relações da cadeia citadas em qualquer posição (palavra inteira, fora de literais), para conferir a extração acima. */
function relacoesMencionadas(texto, relacoes) {
  const {mascarado} = lexar(texto);
  return [...new Set([...mascarado.matchAll(/(?<![A-Za-z0-9_.])([A-Za-z_][A-Za-z0-9_]*)(?![A-Za-z0-9_(])/g)].map(m => m[1].toLowerCase()))]
    .filter(t => relacoes.has(t));
}
const sha256 = t => createHash('sha256').update(t.replace(/\r/g, ''), 'utf8').digest('hex');
const C = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Ponto fixo. Duas classes de tabela:
 *   * `tabelas` (estrutura completa no retrato): as explícitas do plano e as ESCRITAS por uma função do escopo; os
 *     gatilhos, CHECKs, defaults e índices delas trazem funções para o escopo (só a escrita dispara gatilho);
 *   * `tabelasLidas` (só colunas no retrato: nome, tipo, nulidade, default): as lidas pelos corpos e não incluídas acima.
 *     Ler não dispara gatilho; seguir os gatilhos das lidas levaria ao retrato global (129 funções, 72 tabelas em 29/10),
 *     que o plano descarta.
 * Devolve {funcoes: [{nome, arquivos, corpos}], tabelas, tabelasLidas, escritas, dinamicos, mencoesSemExtracao}. Lança com a
 * lista de referências não resolvidas, gatilhos dinâmicos não revisados ou construções não tratadas.
 */
function calcularInventario({fontes = lerFontes(), revisados = GATILHOS_DINAMICOS_REVISADOS} = {}) {
  const cat = catalogar(fontes);
  const erros = [...cat.recusas];
  for (const d of cat.dinamicos) {
    if (!revisados.some(r => r.arquivo === d.arquivo && r.funcao === d.funcao)) erros.push(`GATILHO_DINAMICO_NAO_REVISADO ${d.arquivo} ${d.funcao}`);
  }
  const gatilhosDe = t => [...(cat.gatilhos.get(t)?.values() ?? [])].map(g => g.funcao)
    .concat(revisados.filter(r => r.tabelas.includes(t)).map(r => r.funcao));
  const funcoes = new Set(), tabelas = new Set(), lidas = new Set(), escritas = new Set(), naoResolvidas = new Set();
  const dinamicosCorpo = new Set(), mencoes = new Set();
  const fila = [...FUNCOES_098, MARCADOR_108, ...SUBSTITUIDAS_108];
  const filaTabelas = [...TABELAS_EXPLICITAS];
  while (fila.length || filaTabelas.length) {
    while (filaTabelas.length) {
      const t = filaTabelas.shift();
      if (tabelas.has(t)) continue;
      tabelas.add(t);
      if (!cat.relacoes.has(t)) erros.push(`TABELA_NAO_CRIADA_NA_CADEIA ${t}`);
      fila.push(...gatilhosDe(t));
      for (const texto of cat.estrutura.get(t) ?? []) {
        for (const n of chamadas(texto)) {
          if (cat.funcoes.has(n)) fila.push(n);
          else if (/^kidmais/.test(n) && !cat.relacoes.has(n)) naoResolvidas.add(n);  // CREATE TABLE <nome> (
        }
      }
    }
    while (fila.length) {
      const f = fila.shift();
      if (funcoes.has(f)) continue;
      const defs = cat.funcoes.get(f);
      if (!defs) { naoResolvidas.add(f); continue; }
      funcoes.add(f);
      for (const {corpo} of defs.values()) {
        for (const n of chamadas(corpo)) {
          if (cat.funcoes.has(n)) fila.push(n);
          else if (/^kidmais/.test(n)) naoResolvidas.add(n);
        }
        if (/\bEXECUTE\b(?!\s+(?:FUNCTION|PROCEDURE))/i.test(lexar(corpo).mascarado)) dinamicosCorpo.add(f);
        const citadas = tabelasCitadas(corpo, cat.relacoes);
        for (const t of citadas) lidas.add(t);
        for (const t of tabelasEscritas(corpo, cat.relacoes)) { escritas.add(`${f}:${t}`); filaTabelas.push(t); }
        for (const t of relacoesMencionadas(corpo, cat.relacoes)) if (!citadas.includes(t)) mencoes.add(`${f}:${t}`);
      }
    }
  }
  if (naoResolvidas.size) erros.push('REFERENCIA_NAO_RESOLVIDA ' + [...naoResolvidas].sort(C).join(' '));
  if (erros.length) throw new Error('INVENTARIO_108_RECUSADO ' + erros.join('; '));
  return {
    funcoes: [...funcoes].sort(C).map(nome => {
      const defs = [...cat.funcoes.get(nome).values()];
      return {nome, arquivos: [...new Set(defs.map(d => d.arquivo))].sort(C), corpos: defs.map(d => sha256(d.corpo)).sort(C)};
    }),
    tabelas: [...tabelas].sort(C),
    tabelasLidas: [...lidas].filter(t => !tabelas.has(t)).sort(C),
    escritas: [...escritas].sort(C),
    dinamicos: [...dinamicosCorpo].sort(C),
    mencoesSemExtracao: [...mencoes].sort(C),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Inventário CONGELADO (revisado contra os corpos em 29/10/2026). Mudou a cadeia? Recalcular, revisar e atualizar aqui.
// ---------------------------------------------------------------------------------------------------------------------
const INVENTARIO_108 = Object.freeze({
  funcoes: Object.freeze([
    Object.freeze({nome: 'festa016_invalidacao', arquivos: ['20260911_016_festa.sql'],
      corpos: ['9e76156bf51fe80cd069494c7055f83162aaa658bc80253b6617a0a49290ae91']}),
    Object.freeze({nome: 'kidmais019_bloquear_contrato', arquivos: ['20260915_019_festa_formalizacao.sql'],
      corpos: ['c53da9b53ef20f045ab259d1aa64ef08b6c093d57876812ece2b8fcce5bf836a']}),
    Object.freeze({nome: 'kidmais019_formalizacao', arquivos: ['20261002_061_contratos_importados_integracao.sql'],
      corpos: ['1b428128346f7158389c6a3495f72e9c92a39930b2cb4afe571b9aec900a91ba']}),
    Object.freeze({nome: 'kidmais019_lock_ocupacao', arquivos: ['20260915_019_festa_formalizacao.sql'],
      corpos: ['eb5f187f7ef5e7a499413d71cc1a0c5023d65080920997248a7f5d1947460880']}),
    Object.freeze({nome: 'kidmais019_ocupa', arquivos: ['20260915_019_festa_formalizacao.sql'],
      corpos: ['87131946b52479651484ec9076ce264243e79867ab2bc1f02447c6a2eb0599a3']}),
    Object.freeze({nome: 'kidmais019_proteger_invalidacao', arquivos: ['20260915_019_festa_formalizacao.sql'],
      corpos: ['367f9e8df878a2efd8c25513989e15893e236ba637319b565660831685236871']}),
    Object.freeze({nome: 'kidmais019_validar_contrato', arquivos: ['20261028_108_saloes_combinados.sql'],
      corpos: ['13095fc87c52c3970f9cfad1c5bcef77d3e860904f71b39948de0335b4e76c21']}),
    Object.freeze({nome: 'kidmais061_conferencia_historica', arquivos: ['20261002_061_contratos_importados_integracao.sql'],
      corpos: ['c4c62403926d8d40a32b60af4b11003ed156bbc10523c2d0eb902f04e37a6d6e']}),
    Object.freeze({nome: 'kidmais061_exigir_vinculo', arquivos: ['20261002_061_contratos_importados_integracao.sql'],
      corpos: ['b42c05443deac2503a7f4fc8ee84892eab75b9c149754c22fb4deb1a2ddd7cc4']}),
    Object.freeze({nome: 'kidmais061_historico_passado', arquivos: ['20261002_061_contratos_importados_integracao.sql'],
      corpos: ['634dfcb5fd486259bd7ce5990d4735bb4d65aa73ce22b354aa67e1df46235850']}),
    Object.freeze({nome: 'kidmais061_origem_fechamento', arquivos: ['20261002_061_contratos_importados_integracao.sql'],
      corpos: ['28739fead81613cd2918f323c1aa16b7d77b44db1a42aa32cfe33f860df46f9e']}),
    Object.freeze({nome: 'kidmais062_bloqueio_aplica', arquivos: ['20261002_062_agenda_empresa_unidade.sql'],
      corpos: ['079d8d87dffa6f8c90b8a2b9018f6619dfc07216369dba2c0f22c8732af80fed']}),
    Object.freeze({nome: 'kidmais062_fluxo_unidade', arquivos: ['20261002_062_agenda_empresa_unidade.sql'],
      corpos: ['7e206192de36336bec77b29e480d39dc5edf1ae0c79c33e74b9fac95ad7a7602']}),
    Object.freeze({nome: 'kidmais062_mesmo_recurso', arquivos: ['20261002_062_agenda_empresa_unidade.sql'],
      corpos: ['259f174524dc060fc38b338ee220b0a3281f084ba2457aa125aa7b43a1b36126']}),
    Object.freeze({nome: 'kidmais062_ocupacoes_escopo', arquivos: ['20261002_062_agenda_empresa_unidade.sql'],
      corpos: ['e2fdec749c6d1f1f570e48acb46a5708ff6a4d30003623ccf2dbcc887befbe37']}),
    Object.freeze({nome: 'kidmais062_revisao_unidade', arquivos: ['20261002_062_agenda_empresa_unidade.sql'],
      corpos: ['2696188db9d0c7b9ca5751a330c98472145b4852063948ec5dbbcf2170ccb651']}),
    Object.freeze({nome: 'kidmais062_travar_habilitacao', arquivos: ['20261002_062_agenda_empresa_unidade.sql'],
      corpos: ['0c6bf3261b311c718cf218fdaba3f448d20f73a1ddd793578defdde6e022aaf5']}),
    Object.freeze({nome: 'kidmais062_unidade_agendavel', arquivos: ['20261002_062_agenda_empresa_unidade.sql'],
      corpos: ['94bfc305694dde9f9c587e3fa5a37fb0fca263075b10de40b9801ee5c495d866']}),
    Object.freeze({nome: 'kidmais062_unidade_ativa', arquivos: ['20261002_062_agenda_empresa_unidade.sql'],
      corpos: ['6232e18138d8fdcebb0cba46847183aaf051c6cf80d27456ca7e1b6274cb8f70']}),
    Object.freeze({nome: 'kidmais062_unidade_fechamento', arquivos: ['20261002_062_agenda_empresa_unidade.sql'],
      corpos: ['7c3ee9738cad40505fb1f3115612adc4d3c06eff424832e226444ef4de5c03bd']}),
    Object.freeze({nome: 'kidmais093_mesma_empresa', arquivos: ['20261022_093_agenda_configuracao_unidade.sql'],
      corpos: ['53fb3e8ad6a63e4105067a5c8d70ea878ee9b0c32f689c202f196c2b68c0a346']}),
    Object.freeze({nome: 'kidmais094_conflito_ocupacao', arquivos: ['20261028_108_saloes_combinados.sql'],
      corpos: ['06a387fe9c40ceca6a4021b1f9676b76ee92592a2cc241705f1201a40cc97537']}),
    Object.freeze({nome: 'kidmais094_ocupacoes', arquivos: ['20261022_094_agenda_capacidade.sql'],
      corpos: ['3fa027c88aa5b82c5cbece4ac8a4f51d2b85c7ee18108def1c5974cca1237bbc']}),
    Object.freeze({nome: 'kidmais094_salao_fechamento', arquivos: ['20261022_094_agenda_capacidade.sql'],
      corpos: ['ea270481051aea570015af300abc4d3b208627c90473a25977e22a1b11be0305']}),
    Object.freeze({nome: 'kidmais094_salao_revisao', arquivos: ['20261022_094_agenda_capacidade.sql'],
      corpos: ['b55b3e839da369ce0e28a52bad7003b391d6af2091075a4bf419c4e7770d4d59']}),
    Object.freeze({nome: 'kidmais098_combinado_validar', arquivos: ['20261028_108_saloes_combinados.sql'],
      corpos: ['0d5a2713f41f68b53a6a0bd22b5189cc7e31fcc9b6a7649b59cd9671ee1045ba']}),
    Object.freeze({nome: 'kidmais098_conjunto', arquivos: ['20261028_108_saloes_combinados.sql'],
      corpos: ['a9c7277cc298fb6307f5cfce64a7fe1eea8a0dc2d8a610f5d44bfa9d470d38dc']}),
    Object.freeze({nome: 'kidmais098_contrato_guarda', arquivos: ['20261028_108_saloes_combinados.sql'],
      corpos: ['0ae5abc6372e3edf997bab5b4ab7f213a4d8bb0ff2708c4c4c5db72a5fc74e04']}),
    Object.freeze({nome: 'kidmais098_hoje', arquivos: ['20261028_108_saloes_combinados.sql'],
      corpos: ['3a4b2df59eb38d2a5e6f4894fb6dd891f8ef6f793d302b6699184adba825c121']}),
    Object.freeze({nome: 'kidmais098_membros_canonicos', arquivos: ['20261028_108_saloes_combinados.sql'],
      corpos: ['a28f25f25ca6fde6a8687f86ae7a76f557d19e2404a708906c916bd1dbc34fa4']}),
    Object.freeze({nome: 'kidmais098_proibir_truncate', arquivos: ['20261028_108_saloes_combinados.sql'],
      corpos: ['b6fc1e418cc21bdf78952e9ae8ac8aeff89f257c9a9ab92bccba9850d28099df']}),
    Object.freeze({nome: 'kidmais098_salao_elegivel', arquivos: ['20261028_108_saloes_combinados.sql'],
      corpos: ['9f6e7b59f5ecd89c1a6bf0b67098da041600691979d2e98ae56e8ab3badce4e2']}),
    Object.freeze({nome: 'kidmais098_salao_guarda', arquivos: ['20261028_108_saloes_combinados.sql'],
      corpos: ['9a587402acfe1a1c537b0a7c1a8c3d77e5a1782f2c9e721b32108fde611124c7']}),
    Object.freeze({nome: 'kidmais098_saloes_cruzam', arquivos: ['20261028_108_saloes_combinados.sql'],
      corpos: ['5fa4a47206e773b5a91028b5c7649e2c6317bc67e3ed548a899448fa6d3a19fe']}),
    Object.freeze({nome: 'kidmais098_validar_elegibilidade', arquivos: ['20261028_108_saloes_combinados.sql'],
      corpos: ['f54b73da9bf4685524f88971878bb9792d5f6442432f23cf7f3001dc64b99c05']}),
    Object.freeze({nome: 'kidmais102_exclusivos_validos', arquivos: ['20261025_102_saloes_apresentacao.sql'],
      corpos: ['ac3e6d15e811fbde7db85f43d044aea9cfeba00a03af850cd0f5fadf6bc43241']}),
    Object.freeze({nome: 'kidmais102_salao_conteudo', arquivos: ['20261025_102_saloes_apresentacao.sql'],
      corpos: ['e0ff834d08bd20e810da395b23e132e909e6003b0015fe51b092c3cdb04013b1']}),
    Object.freeze({nome: 'kidmais104_hash_versao_imutavel', arquivos: ['20261027_104_revisao_hash_salao.sql'],
      corpos: ['182ead96ac34a0abcd6251d500bb3b5705657301fe915a6addd19f82b432ec85']}),
    Object.freeze({nome: 'kidmais106_salao_escopo_referenciado', arquivos: ['20261027_106_salao_preferido.sql'],
      corpos: ['a3684094f18048377a1cccd4ff81de80a4649fe675f07cadd1e24c515e87c5b4']}),
    Object.freeze({nome: 'kidmais106_salao_preferido_escopo', arquivos: ['20261027_106_salao_preferido.sql'],
      corpos: ['1e6d43d03d39cff9eabe02149c881666bc8b120557aa5650a8ce1b954955a231']}),
    Object.freeze({nome: 'kidmais108_instalada', arquivos: ['20261028_108_saloes_combinados.sql'],
      corpos: ['2fb8df147716589d768e113780faac103ca05619fad609a3924404bad7894f1c']}),
    Object.freeze({nome: 'kidmais_053_empresa_comercial', arquivos: ['20260928_053_integridade_tenant_fechamento.sql'],
      corpos: ['e8b6432bb78137ab3d2fbd00e8451db9edb6163a92ec7958bccc345852d7b7f1']}),
    Object.freeze({nome: 'kidmais_053_empresa_do_fechamento', arquivos: ['20260928_053_integridade_tenant_fechamento.sql'],
      corpos: ['3903c1e6a531ce99dd8df9536d0578ee76bf974a653fd84d0c09523364319ab1']}),
    Object.freeze({nome: 'kidmais_053_fechamento', arquivos: ['20260928_053_integridade_tenant_fechamento.sql'],
      corpos: ['bec0ff56b60a5ac934e58fc3a57220a925d386c7528ab0b746344fe052c9b0fe']}),
    Object.freeze({nome: 'kidmais_053_fechamento_filhos', arquivos: ['20260928_053_integridade_tenant_fechamento.sql'],
      corpos: ['ad1b7bc9f5d99d1dfee7ab9bc7dd47f510971d55145e9cfd67dfd510b6c590a3']}),
    Object.freeze({nome: 'kidmais_053_inexistente', arquivos: ['20260928_053_integridade_tenant_fechamento.sql'],
      corpos: ['58f4cf678d308d153862310ca5272df4ae7b24bb8274803d137a0bfd559c7fa7']}),
    Object.freeze({nome: 'kidmais_053_recusar', arquivos: ['20260928_053_integridade_tenant_fechamento.sql'],
      corpos: ['f928a20dd730c57b1e4198b73b30dacc1cdf45601bf90a74c4a72edf82a134fe']}),
    Object.freeze({nome: 'kidmais_053_revisao', arquivos: ['20260928_053_integridade_tenant_fechamento.sql'],
      corpos: ['bad1cf5880574717dad312ab09c98eb42bdd547c536385410164c1e98b8af90d']}),
    Object.freeze({nome: 'kidmais_053_revisao_filhos', arquivos: ['20260928_053_integridade_tenant_fechamento.sql'],
      corpos: ['7d219a92aa9e72c0a76f3eb511bf11c0d8e7898debe48bb0e9a4260f28132f72']}),
    Object.freeze({nome: 'kidmais_054_empresa_imutavel', arquivos: ['20260928_054_empresa_id_clientes_fechamentos.sql'],
      corpos: ['a4dfef0828232f50a1f2d1471ab7af60d12bd7d2d6e46ae5853d4f6cb0026c13']}),
    Object.freeze({nome: 'kidmais_054_fechamento_cliente_coerente', arquivos: ['20260928_054_empresa_id_clientes_fechamentos.sql'],
      corpos: ['06afd1f8a45a25fb8f23f54daf0a90c16bd6814f65d9eb1d2a88f9f98eff85c5']}),
    Object.freeze({nome: 'kidmais_054_fechamento_empresa_coerente', arquivos: ['20260928_054_empresa_id_clientes_fechamentos.sql'],
      corpos: ['94ca6576c4eb9d1cb876162f3ee6a6544bc4902c6c13725c31c69839d5102d1c']}),
    Object.freeze({nome: 'kidmais_054_revisao_cliente_coerente', arquivos: ['20260928_054_empresa_id_clientes_fechamentos.sql'],
      corpos: ['db793067fdd4d7f782e88af2988de8358ceed87d7304e80660ea5a436ccc0c9c']}),
    Object.freeze({nome: 'kidmais_057_pode_assinar_pela_empresa', arquivos: ['20260929_057_assinatura_contrato_empresa.sql'],
      corpos: ['0dc20aacadd5f498219c226019523b847fa6bcb193b7d7652e03807b37e8e6a9']}),
    Object.freeze({nome: 'kidmais_hash_revisao_operacional', arquivos: ['20261027_104_revisao_hash_salao.sql'],
      corpos: ['fe0f0199883b0c9d994478a2aba4e92940bea0f52250ef2ea62462900615f6ed']}),
    Object.freeze({nome: 'kidmais_lock_datas_revisao', arquivos: ['20260909_014_revisao_operacional.sql'],
      corpos: ['144da247d48ff6cb8dc4188399b9ee83c04d64beb0c4344391a9554b6fa66d13']}),
    Object.freeze({nome: 'kidmais_preservar_revisao_operacional', arquivos: ['20260909_014_revisao_operacional.sql'],
      corpos: ['1fdcc5498acf8af7b2ea0940f5d657aaa8b7754e64c15e8b87e30590c6cdca05']}),
    Object.freeze({nome: 'kidmais_proteger_bloqueio_revisao', arquivos: ['20261002_062_agenda_empresa_unidade.sql'],
      corpos: ['74ac39079d343f7db514322ca043925ea9c6a2fb2ffe7b5b7752b0a181d812b9']}),
    Object.freeze({nome: 'kidmais_proteger_fechamento_em_revisao', arquivos: ['20260911_016_festa.sql'],
      corpos: ['bef018fc0705dcfbc53f57e2d7f6526550dc41864ddf9f950887c133a29468cb']}),
    Object.freeze({nome: 'kidmais_set_atualizado_em', arquivos: ['20260907_001_crm_extensions.sql'],
      corpos: ['bf41f6fa162c5b0d67224d0d7e0210732f2e311b913b4a641624a9c945cb79a5']}),
    Object.freeze({nome: 'kidmais_validar_agenda_revisao', arquivos: ['20261028_108_saloes_combinados.sql'],
      corpos: ['8476ec76d2ae8af4f7fbbdba595b0fd82b8060c76be4d2d915a47451f11f9e24']}),
    Object.freeze({nome: 'kidmais_validar_fluxo_contrato', arquivos: ['20261002_061_contratos_importados_integracao.sql'],
      corpos: ['a27d9507fbc5e2ae9d6d7ada15f2e6bd45364fa5a133273a7d34d2bb0a3fe002']}),
    Object.freeze({nome: 'kidmais_validar_revisao_operacional', arquivos: ['20260911_016_festa.sql'],
      corpos: ['6d56fb3c5b0c0064102d2524b6d16e53570b9eb9eedcae98640748f7b382ef3b']}),
  ]),
  tabelas: Object.freeze([
    'agenda_escopo_config', 'agenda_saloes', 'bloqueios_agenda', 'configuracao_agenda', 'configuracao_agenda_saloes', 'contrato_fluxos',
    'contratos', 'fechamento_revisoes', 'fechamentos', 'festas', 'kidmais107_reparos',
  ]),
  tabelasLidas: Object.freeze([
    'adicionais', 'agenda_062_unidades_habilitacao', 'aniversariantes', 'aprovacoes_negociacao', 'clientes', 'contrato_assinaturas',
    'contrato_documentos', 'contrato_edicoes', 'contrato_importacao_financeiro', 'contrato_importacoes', 'contrato_versoes',
    'empresa_membership_capacidades', 'empresas', 'estabelecimentos', 'fechamento_adicionais', 'fechamento_revisao_adicionais',
    'festa_buffet', 'festa_contagens_convidados', 'festa_eventos', 'festa_pendencias', 'festa_solicitacoes', 'festa_tarefas',
    'memberships', 'pacotes', 'precos_adicional', 'precos_pacote', 'regras_desconto_pacote', 'responsaveis_adicionais',
    'sessoes_administrativas', 'tabelas_preco', 'usuarios_administrativos', 'validacoes_identidade_cliente',
  ]),
  escritas: Object.freeze([]),
  dinamicos: Object.freeze([]),
  mencoesSemExtracao: Object.freeze([]),
});

/** Recalcula das fontes e compara com o congelado (ou com `inventario`, para os testes). */
function conferir({inventario = INVENTARIO_108, ...opcoes} = {}) {
  let atual;
  try { atual = calcularInventario(opcoes); } catch (e) { return {ok: false, erro: e.message, diferencas: []}; }
  const chave = f => `${f.nome}@${f.arquivos.join(',')}#${f.corpos.join(',')}`;
  const diferencas = [];
  const comparar = (rotulo, esperado, obtido) => {
    const e = new Set(esperado), o = new Set(obtido);
    for (const x of o) if (!e.has(x)) diferencas.push(`${rotulo} FALTA_NO_CONGELADO ${x}`);
    for (const x of e) if (!o.has(x)) diferencas.push(`${rotulo} SOBRA_NO_CONGELADO ${x}`);
  };
  comparar('funcao', inventario.funcoes.map(chave), atual.funcoes.map(chave));
  comparar('tabela', inventario.tabelas, atual.tabelas);
  comparar('tabelaLida', inventario.tabelasLidas, atual.tabelasLidas);
  comparar('escrita', inventario.escritas, atual.escritas);
  comparar('dinamico', inventario.dinamicos, atual.dinamicos);
  comparar('mencao', inventario.mencoesSemExtracao, atual.mencoesSemExtracao);
  return {ok: diferencas.length === 0, diferencas, atual};
}

if (require.main === module) {
  const r = conferir();
  console.log(JSON.stringify(r.ok ? {ok: true} : r, null, 2));
  process.exitCode = r.ok ? 0 : 1;
}

module.exports = {DIR_MIGRATIONS, ULTIMA, FUNCOES_098, MARCADOR_108, SUBSTITUIDAS_108, TABELAS_EXPLICITAS, GATILHOS_DINAMICOS_REVISADOS,
  INVENTARIO_108, lexar, instrucoes, lerFontes, catalogar, chamadas, tabelasCitadas, calcularInventario, conferir};
