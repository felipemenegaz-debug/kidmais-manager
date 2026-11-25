/* eslint-disable @typescript-eslint/no-require-imports */
// B-26: regras do conferidor sem banco. A leitura real fica em lib/assinatura/conferidor-g-vazio.postgres.test.ts.
const test = require('node:test');
const assert = require('node:assert/strict');
const cg = require('./conferidor-g-vazio.cjs');
const bloco = require('./bloco-shell-conferidor-g-vazio.cjs');

const CORTE = '2026-11-01T00:00:00.000Z';
const fechada = () => ({...Object.fromEntries(cg.L1_DESLIGADAS.map(k => [k, 'AUSENTE'])), ...Object.fromEntries(cg.L1_AUSENTES.map(k => [k, 'AUSENTE']))});
const barreira = () => ({l1: Object.fromEntries(cg.SERVICOS_L1.map(s => [s, fechada()])), c2: {quem_tem_acesso: 'so Felipe', em: CORTE}, crons_suspensos: true, artefato: 'bb65640a', l2: 'ARTEFATO_SEM_L2'});
const provedorSemConta = () => ({em: CORTE, declarante: 'Felipe', conta_existe: false, o_que_foi_olhado: 'painel do provedor, lista de contas'});
const declaracao = (extra = {}) => ({versao: 1, ponto: 'P2', alvo: 'teste', corte_p1: CORTE, prefixo: {fonte: 'indeclaravel'}, barreira: barreira(), provedor: provedorSemConta(),
  linha_base: {assinatura_isencoes: {contagem: 0, hash: 'h0'}, empresa_excecoes_comerciais: {contagem: 0, hash: 'h0'}, empresa_documento_continuidades: {contagem: 0, hash: 'h0'}, cadastros_empresas: {contagem: 0, hash: 'h0'}}, ...extra});
function leituraVazia(prefixo = []) {
  const quer = new Set([...cg.BASE, ...prefixo]);
  const migracoes = Object.fromEntries([...cg.BASE, ...cg.SEQUENCIA].map(id => [id, quer.has(id) ? 'completa' : 'ausente']));
  const dominio = Object.fromEntries(cg.MATRIZ.map(({objeto, migracao}) => [objeto, quer.has(migracao)
    ? {presente: true, tipo: 'r', leitura: true, rls: {ativa: false}, contagem: 0, ...(cg.COLUNAS_HASH[objeto] ? {hash: 'h0'} : {})}
    : {presente: false, tipo: null, leitura: null, rls: null}]));
  const ancoras = Object.fromEntries(cg.ANCORAS.map(i => [i, cg.estadoEsperado(i, prefixo.length)]));
  return {migracoes, dominio, ancoras, excecoes: [], continuidades: [], cadastros: [], lotes: [], auditoria: {legivel: true, por_acao: [{acao: 'LOGIN', de_cobranca: false, n: 3}]}, linhasProibidas: [], catalogo: [], foraDoEscopo: []};
}
const motivos = (l, d = declaracao(), p = []) => cg.conformidade(l, d, p).motivos;

test('leitura vazia no prefixo inicial: A-VAZIO, sem exigir auditoria = 0', () => {
  const c = cg.conformidade(leituraVazia(), declaracao(), []);
  assert.deepEqual(c.motivos, []);
  assert.equal(c.atual, 'A-VAZIO');
});

test('estrutura: parcial, ausente declarada e presente não declarada são FALHA, cada uma com o seu motivo', () => {
  const parcial = leituraVazia(); parcial.migracoes['089'] = 'parcial';
  assert.deepEqual(motivos(parcial), ['MIGRATION_089_PARCIAL_NAO_DECLARADA']);
  const faltando = leituraVazia();
  assert.ok(motivos(faltando, declaracao(), ['089']).includes('MIGRATION_089_AUSENTE_ESPERADA'));
  const sobrando = leituraVazia(['089']);
  assert.ok(motivos(sobrando).includes('MIGRATION_089_COMPLETA_NAO_DECLARADA'));
  const base = leituraVazia(); base.migracoes['105'] = 'ausente';
  assert.deepEqual(motivos(base), ['MIGRATION_105_AUSENTE_ESPERADA']);
});

test('estado da migration: todas, nenhuma, algumas; a 100 pelo corpo', () => {
  assert.equal(cg.estadoMigracao('089', {a: true, b: true}), 'completa');
  assert.equal(cg.estadoMigracao('089', {a: false, b: false}), 'ausente');
  assert.equal(cg.estadoMigracao('089', {a: true, b: false}), 'parcial');
  assert.equal(cg.estadoMigracao('100', null, '805cd427a7cc7a725fb3bdfb4fd050f04e618131104fcfc0678a0ddadd5b4bdb'), 'completa');
  assert.equal(cg.estadoMigracao('100', null, 'b6aac1c0b99ed64f4dca94fe5d886e5d5892b82888325010e02adc850def8cf6'), 'ausente');
  assert.equal(cg.estadoMigracao('100', null, null), 'ausente');
  assert.equal(cg.estadoMigracao('100', null, 'outro-corpo'), 'parcial');
});

test('papel e RLS: RLS ativa, sem privilégio e tipo errado nunca viram zero', () => {
  const rls = leituraVazia(); rls.dominio.cobranca_eventos = {presente: true, tipo: 'r', leitura: true, rls: {ativa: true}};
  assert.deepEqual(motivos(rls), ['RLS_PODE_INDUZIR_ZERO:cobranca_eventos']);
  const priv = leituraVazia(); priv.dominio.cobranca_eventos = {presente: true, tipo: 'r', leitura: false, rls: {ativa: false}};
  assert.deepEqual(motivos(priv), ['SEM_PRIVILEGIO:cobranca_eventos']);
  const vis = leituraVazia(); vis.dominio.cobranca_eventos = {presente: true, tipo: 'v', leitura: true, rls: {ativa: false}};
  assert.deepEqual(motivos(vis), ['TIPO_INESPERADO:cobranca_eventos']);
  const aud = leituraVazia(); aud.auditoria = {legivel: false, por_acao: []};
  assert.deepEqual(motivos(aud), ['AUDITORIA_ILEGIVEL_OU_RLS']);
});

test('regra de fechamento: nome com maiúsculas também casa', () => {
  const l = leituraVazia(); l.catalogo = [{esquema: 'public', objeto: 'Assinatura_Nova'}];
  assert.deepEqual(motivos(l), ['TABELA_FORA_DA_MATRIZ:public.Assinatura_Nova']);
});

test('regra de fechamento: tabela nova reprova, a lista de excluídos não, outro esquema não se beneficia da lista', () => {
  const l = leituraVazia();
  l.catalogo = [{esquema: 'public', objeto: 'assinatura_nova'}, {esquema: 'public', objeto: 'contratos'}, {esquema: 'public', objeto: 'contrato_assinaturas'}, {esquema: 'public', objeto: 'pagamento_credito_reservas'}, {esquema: 'public', objeto: 'festas'}, {esquema: 'public', objeto: 'cobranca_eventos'}, {esquema: 'copia', objeto: 'contratos'}];
  assert.deepEqual(motivos(l), ['TABELA_FORA_DA_MATRIZ:copia.contratos', 'TABELA_FORA_DA_MATRIZ:public.assinatura_nova']);
  for (const t of ['faturas', 'asaas_x', 'plano_y', 'checkout_z', 'pedido_w', 'devolucoes', 'encerrados', 'avisos', 'isencao', 'excecao', 'continuidade', 'renovacao', 'comprovante', 'campanha', 'fundador', 'arrepender'])
    assert.ok(cg.REGRA_FECHAMENTO.test(t), t);
  const fora = leituraVazia(); fora.foraDoEscopo = ['ia_credito_franquias_ciclo'];
  assert.deepEqual(motivos(fora), ['FORA_DO_ESCOPO_PRESENTE:ia_credito_franquias_ciclo']);
});

test('domínio: linha em objeto VAZIA reprova; crédito abre em com-dados ou barreira perdida', () => {
  const l = leituraVazia(); l.dominio.assinatura_avisos.contagem = 1;
  assert.deepEqual(motivos(l), ['OBJETO_COM_LINHA:assinatura_avisos']);
  const lc = leituraVazia(['089', '092', '093', '090', '094', '095']);
  const d = declaracao();
  lc.lotes = [{origem: 'COMPRA', com_pedido: true, n: 1}];
  assert.deepEqual(motivos(lc, d, ['089', '092', '093', '090', '094', '095']), ['CREDITO_COM_DADOS']);
  lc.lotes = [{origem: 'CORTESIA', com_pedido: false, n: 1}];
  assert.deepEqual(motivos(lc, d, ['089', '092', '093', '090', '094', '095']), ['CREDITO_BARREIRA_PERDIDA']);
});

test('classificados: linha exige classificação; depois do P1 qualquer mudança de hash ou contagem reprova', () => {
  const l = leituraVazia(); Object.assign(l.dominio.assinatura_isencoes, {contagem: 1, hash: 'h1'}); l.linhasClassificadas = {assinatura_isencoes: ['a']};
  assert.deepEqual(motivos(l, declaracao({ponto: 'P1', linha_base: undefined})), ['CLASSIFICACAO_PENDENTE:assinatura_isencoes']);
  const zero = declaracao().linha_base;
  const base = {...zero, assinatura_isencoes: {contagem: 1, hash: 'h1', classificacoes: [{linha: 'a', classificacao: 'isencao interna da Kidmais'}]}};
  assert.deepEqual(motivos(l, declaracao({linha_base: base})), []);
  Object.assign(l.dominio.assinatura_isencoes, {hash: 'h2'});
  assert.deepEqual(motivos(l, declaracao({linha_base: base})), ['LINHA_DE_BASE_MUDOU:assinatura_isencoes']);
  const contou = leituraVazia(); Object.assign(contou.dominio.assinatura_isencoes, {contagem: 2, hash: 'h1'}); contou.linhasClassificadas = {assinatura_isencoes: ['a']};
  assert.deepEqual(motivos(contou, declaracao({linha_base: base})), ['LINHA_DE_BASE_MUDOU:assinatura_isencoes'], 'mesmo hash, contagem diferente');
  assert.deepEqual(motivos(leituraVazia(), declaracao({ponto: 'P1', linha_base: undefined})), []);
  assert.deepEqual(motivos(leituraVazia(), declaracao({linha_base: undefined})), ['LINHA_DE_BASE_AUSENTE']);
  const nova = leituraVazia(); Object.assign(nova.dominio.cadastros_empresas, {contagem: 1, hash: 'h9'});
  assert.deepEqual(motivos(nova), ['LINHA_DE_BASE_MUDOU:cadastros_empresas', 'CLASSIFICACAO_PENDENTE:cadastros_empresas']);
});

test('classificados: referência obrigatória depois do P1, mesmo vazia, e classificação linha a linha', () => {
  const zero = declaracao().linha_base;
  const semIsencao = Object.fromEntries(Object.entries(zero).filter(([k]) => k !== 'assinatura_isencoes'));
  assert.deepEqual(motivos(leituraVazia(), declaracao({linha_base: semIsencao})), ['LINHA_DE_BASE_SEM_OBJETO:assinatura_isencoes'], 'tabela vazia não dispensa a referência');
  assert.deepEqual(motivos(leituraVazia(), declaracao({ponto: 'P1', linha_base: semIsencao})), [], 'o P1 é quem cria a referência');
  const doisDe = classificacoes => declaracao({ponto: 'P1', linha_base: {...zero, assinatura_isencoes: {contagem: 2, hash: 'h1', classificacoes}}});
  const l = leituraVazia(); Object.assign(l.dominio.assinatura_isencoes, {contagem: 2, hash: 'h1'}); l.linhasClassificadas = {assinatura_isencoes: ['b', 'a']};
  const uma = (linha, classificacao = 'explicada por Felipe') => ({linha, classificacao});
  assert.deepEqual(motivos(l, doisDe([uma('a'), uma('b')])), [], 'cada linha, em qualquer ordem');
  assert.deepEqual(motivos(l, declaracao({ponto: 'P1', linha_base: {...zero, assinatura_isencoes: {contagem: 2, hash: 'h1', classificacao: 'texto unico'}}})), ['CLASSIFICACAO_PENDENTE:assinatura_isencoes'], 'texto único');
  assert.deepEqual(motivos(l, doisDe([])), ['CLASSIFICACAO_PENDENTE:assinatura_isencoes']);
  assert.deepEqual(motivos(l, doisDe([uma('a'), uma('b', ' ')])), ['CLASSIFICACAO_PENDENTE:assinatura_isencoes'], 'uma sem texto');
  assert.deepEqual(motivos(l, doisDe([uma('a')])), ['CLASSIFICACAO_DIVERGENTE:assinatura_isencoes'], 'faltou uma');
  assert.deepEqual(motivos(l, doisDe([uma('a'), uma('c')])), ['CLASSIFICACAO_DIVERGENTE:assinatura_isencoes'], 'outra linha');
  assert.deepEqual(motivos(l, doisDe([uma('a'), uma('a')])), ['CLASSIFICACAO_DIVERGENTE:assinatura_isencoes'], 'a mesma duas vezes');
  const l3 = leituraVazia(); Object.assign(l3.dominio.assinatura_isencoes, {contagem: 3, hash: 'h1'}); l3.linhasClassificadas = {assinatura_isencoes: ['a', 'b', 'b']};
  const tresDe = classificacoes => declaracao({ponto: 'P1', linha_base: {...zero, assinatura_isencoes: {contagem: 3, hash: 'h1', classificacoes}}});
  assert.deepEqual(motivos(l3, tresDe([uma('b'), uma('a'), uma('b')])), [], 'duas linhas iguais, duas classificações');
  assert.deepEqual(motivos(l3, tresDe([uma('a'), uma('a'), uma('b')])), ['CLASSIFICACAO_DIVERGENTE:assinatura_isencoes'], 'mesmas impressões, multiplicidade diferente');
  assert.deepEqual(cg.conformidade(l, doisDe([uma('a'), uma('b')]), []).classificados.classificados.assinatura_isencoes, {contagem: 2, linhas_classificadas: 2});
});

test('assinatura: cada guarda numa relação ancorada, cada objeto com a estrutura medida, cada função com uma identidade, nada por preencher', () => {
  const pares = Object.values(cg.GATILHOS).flat().map(([t, g]) => `${t}.${g}`);
  assert.equal(pares.length, 58);
  assert.equal(new Set(pares).size, 58);
  // A definição de cada guarda está na linha "gatilho|" da relação, presa ao prefixo pela âncora.
  for (const [t] of Object.values(cg.GATILHOS).flat()) assert.ok(cg.ANCORAS.includes(`relacao:${t}`), t);
  assert.match(cg.linhasEstrutura('r'), /'gatilho\|' \|\| g\.tgname \|\| '\|' \|\| g\.tgenabled::text \|\| '\|' \|\| pg_get_triggerdef\(g\.oid, false\)/);
  assert.match(cg.linhasEstrutura('r'), /'verificacao_fk\|'[^\n]*g\.tgenabled::text\s+FROM pg_constraint r JOIN pg_trigger g ON g\.tgconstraint=r\.oid AND g\.tgisinternal/);
  assert.ok(!/RI_ConstraintTrigger|tgname/.test(cg.linhasEstrutura('r').split('verificacao_fk')[1]), 'nome gerado do gatilho interno fora da linha');
  for (const [f, hs] of Object.entries(cg.DEFS_FUNCAO)) { assert.equal(hs.length, 1, f); assert.match(hs[0], /^[0-9a-f]{64}$/); }
  assert.equal(Object.keys(cg.DEFS_FUNCAO).length, 23);
  assert.equal(cg.GATILHOS['095'].length, 22, 'um par por tabela da 095, sem contagem global');
  assert.equal(new Set(cg.GATILHOS['095'].map(g => g[0])).size, 11);
  assert.deepEqual(Object.keys(cg.ESTRUTURA_OBJETOS).sort(), cg.MATRIZ.map(m => m.objeto).sort());
  for (const hs of Object.values(cg.ESTRUTURA_OBJETOS)) { assert.ok(hs.length >= 1); for (const h of hs) assert.match(h, /^[0-9a-f]{64}$/); }
  for (const {objeto, migracao} of cg.MATRIZ) assert.ok(cg.ASSINATURAS[migracao][`estrutura_${objeto}`], objeto);
  for (const [id, itens] of Object.entries(cg.ASSINATURAS)) for (const [k, expr] of Object.entries(itens)) assert.ok(typeof expr === 'string' ? !/undefined|\/\*/.test(expr) : k === `estrutura_${expr.estrutura}`, `${id}.${k}`);
  assert.ok(cg.ASSINATURAS['091'].funcao_kidmais_091_documento_valido, 'auxiliar da restrição');
});

/** O que o SQL de cada migration da sequência cria ou altera, lido do próprio arquivo (sem comentários de linha). */
function inventarioDoSql(id) {
  const fs = require('node:fs'), path = require('node:path');
  const pasta = path.join(__dirname, '..', 'database', 'migrations');
  const arquivos = fs.readdirSync(pasta).filter(a => new RegExp(`^\\d{8}_${id}_.*\\.sql$`).test(a));
  assert.equal(arquivos.length, 1, id);
  const sql = fs.readFileSync(path.join(pasta, arquivos[0]), 'utf8').replace(/--[^\n]*/g, '');
  const nomes = (re) => [...sql.matchAll(re)].map(m => m[1].toLowerCase());
  const relacoes = new Set([
    ...nomes(/\b(?:ALTER\s+TABLE(?:\s+IF\s+EXISTS)?(?:\s+ONLY)?|CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?|COMMENT\s+ON\s+(?:TABLE|COLUMN))\s+(?:public\.)?([a-z_0-9]+)/gi),
    ...nomes(/\bCREATE\s+(?:UNIQUE\s+)?INDEX(?:\s+CONCURRENTLY)?(?:\s+IF\s+NOT\s+EXISTS)?\s+[a-z_0-9]+\s+ON\s+(?:ONLY\s+)?(?:public\.)?([a-z_0-9]+)/gi),
    ...nomes(/\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\s+[a-z_0-9]+\s[^;]*?\bON\s+(?:public\.)?([a-z_0-9]+)/gi),
  ]);
  const funcoes = new Set(nomes(/\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\s+(?:public\.)?([a-z_0-9]+)/gi));
  const outros = [...sql.matchAll(/\b(?:CREATE|ALTER|DROP)\s+(?:OR\s+REPLACE\s+)?(VIEW|MATERIALIZED\s+VIEW|TYPE|DOMAIN|SEQUENCE|EXTENSION|SCHEMA|RULE|POLICY|AGGREGATE|OPERATOR|CAST|TABLE)\b/gi)].map(m => m[0]).filter(x => !/^ALTER\s+TABLE$/i.test(x) && !/^CREATE\s+TABLE$/i.test(x));
  return {relacoes: [...relacoes].sort(), funcoes: [...funcoes].sort(), outros};
}

test('âncoras: o SQL de cada migration da sequência só cria ou altera relações e funções ancoradas, nas listas da própria migration', () => {
  for (const id of cg.SEQUENCIA) {
    const inv = inventarioDoSql(id);
    assert.deepEqual(inv.relacoes, [...cg.RELACOES_DA_SEQUENCIA[id]].sort(), `${id}: relações`);
    assert.deepEqual(inv.funcoes, [...cg.FUNCOES_DA_SEQUENCIA[id]].sort(), `${id}: funções`);
    assert.deepEqual(inv.outros, [], `${id}: outro tipo de objeto`);
    for (const t of inv.relacoes) assert.ok(cg.ANCORAS.includes(`relacao:${t}`), t);
    for (const f of inv.funcoes) assert.ok(cg.ANCORAS.includes(`funcao:${f}`), f);
  }
  assert.ok(cg.RELACOES_DA_SEQUENCIA['091'].includes('solicitacoes_acesso_empresa'), 'contraprova R3-02 do Astra');
});

test('âncoras: trajetória medida de cada item, presa ao prefixo', () => {
  assert.deepEqual(Object.keys(cg.TRAJETORIA).sort(), [...cg.ANCORAS]);
  for (const [item, t] of Object.entries(cg.TRAJETORIA)) {
    assert.equal(t[0][0], 0, item);
    for (let i = 1; i < t.length; i++) { assert.ok(t[i][0] > t[i - 1][0] && t[i][0] <= cg.SEQUENCIA.length, item); assert.notEqual(t[i][1], t[i - 1][1], item); }
    for (const [, h] of t) assert.ok(h === null || /^[0-9a-f]{64}$/.test(h), item);
  }
  const s = 'relacao:solicitacoes_acesso_empresa';
  assert.ok(cg.estadoEsperado(s, 0) && cg.estadoEsperado(s, 10) && cg.estadoEsperado(s, 0) !== cg.estadoEsperado(s, 10));
  assert.equal(cg.estadoEsperado(s, 9), cg.estadoEsperado(s, 0), 'a 091 é a última');
  assert.equal(cg.estadoEsperado('funcao:kidmais_091_documento_valido', 9), null);
  assert.equal(cg.estadoEsperado('relacao:nao_existe', 0), undefined);
  // Cada estrutura aceita pela assinatura da migration vem da mesma medição (hash canônico), sem segunda forma.
  for (const m of cg.MATRIZ) assert.deepEqual([...cg.ESTRUTURA_OBJETOS[m.objeto]].sort(), [...new Set(cg.TRAJETORIA[`relacao:${m.objeto}`].map(x => x[1]).filter(Boolean))].sort(), m.objeto);
  assert.equal(cg.FORMA_RESTAURADA, undefined, 'r6: sem lista de formas restauradas por prefixo');
  assert.equal(cg.estadosAceitos, undefined, 'r6: um só estado por item e prefixo');
});

test('R5-01: a projeção canônica leva a forma da migration à do restore (medida) e é ponto fixo', () => {
  // Pares medidos no PostgreSQL 18.6 (sonda-restore-r5.json): à esquerda o catálogo das migrations, à direita o mesmo depois do pg_restore.
  const pares = [
    ["restricao|precos_pacote_tipo_calculo_check|c|CHECK (((tipo_calculo)::text = ANY ((ARRAY['FIXO'::character varying, 'POR_CONVIDADO'::character varying, 'PONTO'::character varying])::text[])))",
      "restricao|precos_pacote_tipo_calculo_check|c|CHECK (((tipo_calculo)::text = ANY (ARRAY[('FIXO'::character varying)::text, ('POR_CONVIDADO'::character varying)::text, ('PONTO'::character varying)::text])))"],
    ["restricao|mcp_oauth_concessoes_escopos_check|c|CHECK ((((cardinality(escopos) >= 1) AND (cardinality(escopos) <= 3)) AND (escopos <@ ARRAY['agenda:read'::text, 'financeiro:read'::text, 'conhecimento:read'::text])))",
      "restricao|mcp_oauth_concessoes_escopos_check|c|CHECK (((cardinality(escopos) >= 1) AND (cardinality(escopos) <= 3) AND (escopos <@ ARRAY['agenda:read'::text, 'financeiro:read'::text, 'conhecimento:read'::text])))"],
    ["restricao|configuracao_agenda_dias_semana_check|c|CHECK (((dias_semana IS NULL) OR (((cardinality(dias_semana) >= 1) AND (cardinality(dias_semana) <= 7)) AND (dias_semana <@ ARRAY[(1)::smallint, (2)::smallint, (3)::smallint, (4)::smallint, (5)::smallint, (6)::smallint, (7)::smallint]))))",
      "restricao|configuracao_agenda_dias_semana_check|c|CHECK (((dias_semana IS NULL) OR ((cardinality(dias_semana) >= 1) AND (cardinality(dias_semana) <= 7) AND (dias_semana <@ ARRAY[(1)::smallint, (2)::smallint, (3)::smallint, (4)::smallint, (5)::smallint, (6)::smallint, (7)::smallint]))))"],
    ["restricao|fr_congelamento_ck|c|CHECK ((((num_nonnulls(congelado_snapshot_hash, congelado_documento_id, congelado_em, congelado_por_usuario_id) = 0) AND ((estado)::text = ANY ((ARRAY['EM_ELABORACAO'::character varying, 'CANCELADA'::character varying])::text[]))) OR ((num_nonnulls(congelado_snapshot_hash, congelado_documento_id, congelado_em, congelado_por_usuario_id) = 4) AND ((estado)::text = ANY ((ARRAY['CONGELADA'::character varying, 'APLICADA'::character varying, 'CANCELADA'::character varying])::text[])))))",
      "restricao|fr_congelamento_ck|c|CHECK ((((num_nonnulls(congelado_snapshot_hash, congelado_documento_id, congelado_em, congelado_por_usuario_id) = 0) AND ((estado)::text = ANY (ARRAY[('EM_ELABORACAO'::character varying)::text, ('CANCELADA'::character varying)::text]))) OR ((num_nonnulls(congelado_snapshot_hash, congelado_documento_id, congelado_em, congelado_por_usuario_id) = 4) AND ((estado)::text = ANY (ARRAY[('CONGELADA'::character varying)::text, ('APLICADA'::character varying)::text, ('CANCELADA'::character varying)::text])))))"],
    ["indice|fr_agenda_aberta_idx|CREATE INDEX fr_agenda_aberta_idx ON public.fechamento_revisoes USING btree (data_evento, horario_inicio, horario_fim) WHERE (((estado)::text = ANY ((ARRAY['EM_ELABORACAO'::character varying, 'CONGELADA'::character varying])::text[])) AND (hold_destino_adquirido_em IS NOT NULL))|true|true",
      "indice|fr_agenda_aberta_idx|CREATE INDEX fr_agenda_aberta_idx ON public.fechamento_revisoes USING btree (data_evento, horario_inicio, horario_fim) WHERE (((estado)::text = ANY (ARRAY[('EM_ELABORACAO'::character varying)::text, ('CONGELADA'::character varying)::text])) AND (hold_destino_adquirido_em IS NOT NULL))|true|true"],
    ["restricao|x_aspas_ck|c|CHECK (((v)::text = ANY ((ARRAY['O''BRIEN'::character varying, 'A, B'::character varying])::text[])))",
      "restricao|x_aspas_ck|c|CHECK (((v)::text = ANY (ARRAY[('O''BRIEN'::character varying)::text, ('A, B'::character varying)::text])))"],
  ];
  for (const [migracao, restaurada] of pares) {
    assert.equal(cg.canonica(migracao), restaurada, migracao);
    assert.equal(cg.canonica(restaurada), restaurada, 'ponto fixo');
  }
  // Relação com a forma mista (restore no k=0, depois a 092: categoria restaurada, tipo recriado na forma da migration) = mesmo hash.
  const categoria = ["restricao|precos_pacote_categoria_check|c|CHECK (((categoria_horario)::text = ANY ((ARRAY['GERAL'::character varying, 'PADRAO'::character varying, 'NOBRE'::character varying])::text[])))",
    "restricao|precos_pacote_categoria_check|c|CHECK (((categoria_horario)::text = ANY (ARRAY[('GERAL'::character varying)::text, ('PADRAO'::character varying)::text, ('NOBRE'::character varying)::text])))"];
  const tabela = 'tabela|r|p';
  const h = cg.hashLinhas([tabela, categoria[0], pares[0][0]]);
  assert.equal(cg.hashLinhas([tabela, categoria[1], pares[0][0]]), h, 'mista');
  assert.equal(cg.hashLinhas([pares[0][1], categoria[1], tabela]), h, 'toda restaurada, em outra ordem');
  // Mudança material continua mudando o hash, nas duas formas.
  assert.notEqual(cg.hashLinhas([tabela, categoria[1].replace("('NOBRE'::character varying)::text", "('NOBRE'::character varying)::text, ('OUTRO'::character varying)::text"), pares[0][0]]), h);
  assert.notEqual(cg.hashLinhas([tabela, categoria[1], pares[0][0].replace("'PONTO'::character varying]", "'PONTO'::character varying, 'OUTRO'::character varying]")]), h);
  assert.notEqual(cg.hashLinhas([tabela, categoria[1], pares[0][0].replace(' = ANY ', ' <> ALL ')]), h);
  // Hash = sha256 das linhas canônicas na ordem do COLLATE "C" (bytes UTF-8), unidas por \n; relação ausente = null.
  const {createHash} = require('node:crypto');
  assert.equal(cg.hashLinhas(['\u{1F600}', '�', 'a']), createHash('sha256').update('a\n�\n\u{1F600}', 'utf8').digest('hex'), 'ordem dos bytes, não a do UTF-16');
  assert.equal(cg.hashLinhas(undefined), null);
  assert.equal(cg.hashLinhas([]), null);
});

test('R5-01: a projeção só toca nas duas reanálises; aninhamento à direita, OR, outros casts, literais e outras linhas ficam como estão', () => {
  const iguais = [
    // E aninhado depois do primeiro operando: o parser do PostgreSQL não o funde ao reler (medido: cadastros_publicos, empresa_socios).
    "restricao|cadastros_publicos_nome_check|c|CHECK (((nome = btrim(nome)) AND ((char_length(nome) >= 2) AND (char_length(nome) <= 120))))",
    // OU dentro de OU e E dentro de OU: fora da regra.
    'restricao|a_ck|c|CHECK ((((a IS NULL) OR (b IS NULL)) OR (c IS NULL)))',
    'restricao|a_ck|c|CHECK ((((a IS NULL) AND (b IS NULL)) OR (c IS NULL)))',
    // E de primeiro nível com operando sem parênteses: não reconhecido, fica (mais estrito que o parser).
    'restricao|a_ck|c|CHECK (((flag AND (x > 1)) AND (y > 2)))',
    // ARRAY com elemento que não é literal varchar, ou com outro destino de conversão.
    "restricao|a_ck|c|CHECK (((v)::text = ANY ((ARRAY['A'::character varying, w])::text[])))",
    "restricao|a_ck|c|CHECK (((v)::text = ANY ((ARRAY['A'::text, 'B'::text])::text[])))",
    "restricao|a_ck|c|CHECK ((v = ANY ((ARRAY['1'::character varying, '2'::character varying])::integer[])))",
    "restricao|a_ck|c|CHECK (((v)::text = ANY ((ARRAY['A'::character varying])::character varying[])))",
    // O padrão dentro de um literal ou de um identificador entre aspas não é tocado.
    "restricao|a_ck|c|CHECK ((v ~ '(ARRAY[''A''::character varying])::text[]'::text))",
    "restricao|a_ck|c|CHECK ((v = '(ARRAY[''::character varying])::text[]'::text))",
    `restricao|a_ck|c|CHECK ((("(ARRAY['A'::character varying])::text[]" IS NULL)))`,
    "restricao|a_ck|c|CHECK ((v = '((a) AND (b)) AND (c)'::text))",
    'restricao|a_ck|c|CHECK ((("((a) AND (b)) AND (c)" IS NULL) AND (b IS NULL)))',
    // Outras linhas (coluna, gatilho, regra), nome fora do padrão simples e texto desbalanceado.
    "coluna|v|text[]|false|(ARRAY['A'::character varying])::text[]|||",
    "gatilho|g|O|CREATE TRIGGER g BEFORE UPDATE ON public.t FOR EACH ROW WHEN ((((old.a IS NULL) AND (old.b IS NULL)) AND (old.c IS NULL))) EXECUTE FUNCTION f()",
    "restricao|\"Ck\"|c|CHECK (((v)::text = ANY ((ARRAY['A'::character varying])::text[])))",
    "restricao|a_ck|c|CHECK ((((a IS NULL) AND (b IS NULL)) AND (c IS NULL))",
    "restricao|a_ck|c|CHECK ((v = 'aberto)",
  ];
  for (const l of iguais) assert.equal(cg.canonica(l), l, l);
  // Só a primeira posição se funde; a da direita, dentro do mesmo E, fica.
  assert.equal(cg.canonica('restricao|a_ck|c|CHECK (((((a) AND (b)) AND (c)) AND ((d) AND (e))))'), 'restricao|a_ck|c|CHECK (((a) AND (b) AND (c) AND ((d) AND (e))))');
});

test('R4-04: a assinatura da relação inclui a sequência identity ou serial com todos os parâmetros', () => {
  const sql = cg.linhasEstrutura('x');
  assert.match(sql, /'sequencia\|'/);
  for (const campo of ['a.attname', 'd.deptype', 'sq.relname', 'sq.relpersistence', 'format_type(s.seqtypid, NULL)', 's.seqstart', 's.seqincrement', 's.seqmax', 's.seqmin', 's.seqcache', 's.seqcycle']) assert.ok(sql.includes(campo), campo);
  assert.match(sql, /d\.deptype IN \('a', 'i'\)/);
  assert.match(sql, /d\.refobjid=x\b/);
});

test('âncoras: estado antecipado, revertido, ausente, não lido ou sem medida reprova; no prefixo declarado, passa', () => {
  const s = 'relacao:solicitacoes_acesso_empresa';
  const antecipada = leituraVazia([]); antecipada.ancoras[s] = cg.estadoEsperado(s, 10);
  assert.deepEqual(motivos(antecipada), [`FORA_DO_PREFIXO:${s}`], 'CHECK da 091 aplicado antes da 091');
  const c = cg.conformidade(antecipada, declaracao(), []);
  assert.deepEqual(c.comum.fora_do_prefixo, [{item: s, medido: cg.estadoEsperado(s, 10), esperado: cg.estadoEsperado(s, 0)}]);
  assert.ok(Object.hasOwn(c.comum.estrutura_divergente, 'solicitacoes_acesso_empresa'));
  const revertida = leituraVazia(cg.SEQUENCIA); revertida.ancoras[s] = cg.estadoEsperado(s, 0);
  assert.deepEqual(motivos(revertida, declaracao(), cg.SEQUENCIA), [`FORA_DO_PREFIXO:${s}`], '091 declarada com o CHECK revertido');
  assert.deepEqual(motivos(leituraVazia(cg.SEQUENCIA), declaracao(), cg.SEQUENCIA), []);
  const reduzido = leituraVazia(cg.SEQUENCIA);
  assert.ok(motivos(reduzido, declaracao(), cg.SEQUENCIA.slice(0, 9)).includes(`FORA_DO_PREFIXO:${s}`), 'prefixo declarado menor que o aplicado');
  const f = 'funcao:kidmais_091_documento_valido';
  const outraFuncao = leituraVazia(cg.SEQUENCIA); outraFuncao.ancoras[f] = 'f'.repeat(64);
  assert.deepEqual(motivos(outraFuncao, declaracao(), cg.SEQUENCIA), [`FORA_DO_PREFIXO:${f}`]);
  const semItem = leituraVazia([]); delete semItem.ancoras[s];
  assert.deepEqual(motivos(semItem), [`FORA_DO_PREFIXO:${s}`], 'item não lido');
  const semLeitura = leituraVazia([]); delete semLeitura.ancoras;
  assert.equal(motivos(semLeitura).length, cg.ANCORAS.length);
  const nula = leituraVazia([]); nula.ancoras['relacao:empresa_assinaturas'] = null;
  assert.deepEqual(motivos(nula), ['FORA_DO_PREFIXO:relacao:empresa_assinaturas'], 'relação sumida');
});

test('estados terminais: exceção vigente e continuidade pendente reprovam; terminais passam', () => {
  const l = leituraVazia();
  l.excecoes = [{tipo: 'CORTESIA', revogada: false, vencida: false, n: 1}];
  assert.deepEqual(motivos(l), ['EXCECAO_VIGENTE_NAO_TERMINAL']);
  l.excecoes = [{tipo: 'CORTESIA', revogada: true, vencida: false, n: 1}, {tipo: 'CORTESIA', revogada: false, vencida: true, n: 1}, {tipo: 'EXTENSAO_TESTE', revogada: false, vencida: false, autorizada: true, n: 2}];
  assert.deepEqual(motivos(l), []);
  // D-LAN-4 correção 4: extensão vigente só passa ligada a um teste autorizado; sem vínculo (ou recorte indeterminado: autorizada null) reprova.
  for (const autorizada of [false, null, undefined]) {
    const s = leituraVazia();
    s.excecoes = [{tipo: 'EXTENSAO_TESTE', revogada: false, vencida: false, autorizada, n: 1}];
    assert.deepEqual(motivos(s), ['EXTENSAO_TESTE_VIGENTE_SEM_VINCULO'], String(autorizada));
  }
  const revogada = leituraVazia();
  revogada.excecoes = [{tipo: 'EXTENSAO_TESTE', revogada: true, vencida: false, autorizada: false, n: 1}];
  assert.deepEqual(motivos(revogada), [], 'revogada é terminal');
  l.continuidades = [{tipo: 'CESSAO', situacao: 'PENDENTE_PROVEDOR', n: 1}];
  assert.deepEqual(motivos(l), ['CONTINUIDADE_NAO_CONCLUIDA']);
  l.continuidades = [{tipo: 'CESSAO', situacao: 'CONCLUIDA', n: 1}];
  assert.deepEqual(motivos(l), []);
});

test('cadastros_publicos: PENDENTE não expirado só reprova do P3 em diante; depois a contagem não muda', () => {
  const l = leituraVazia();
  l.cadastros = [{situacao: 'PENDENTE', nao_expirado: true, n: 1}];
  assert.deepEqual(motivos(l, declaracao({ponto: 'P2'})), []);
  assert.deepEqual(motivos(l, declaracao({ponto: 'P3'})), ['CADASTRO_PENDENTE_NAO_EXPIRADO']);
  l.cadastros = [{situacao: 'SUBSTITUIDO', nao_expirado: false, n: 2}];
  assert.deepEqual(motivos(l, declaracao({ponto: 'P3'})), []);
  assert.deepEqual(motivos(l, declaracao({ponto: 'P4'})), ['REFERENCIA_DE_CADASTROS_AUSENTE']);
  assert.deepEqual(motivos(l, declaracao({ponto: 'P4', cadastros_referencia: {SUBSTITUIDO: 2}})), []);
  assert.deepEqual(motivos(l, declaracao({ponto: 'P4', cadastros_referencia: {SUBSTITUIDO: 1}})), ['CADASTROS_MUDARAM_DESDE_P3']);
});

test('auditoria: três classes com precedência; fora das listas com origem COBRANCA reprova; login não', () => {
  assert.equal(cg.classeAuditoria('COBRANCA_WEBHOOK_RECUSADO'), 'TENTATIVA_RECUSADA');
  assert.equal(cg.classeAuditoria('ASSINATURA_SINCRONIZACAO_RECUSADA'), 'TENTATIVA_RECUSADA');
  assert.equal(cg.classeAuditoria('ASSINATURA_X_SEM_CONFIRMACAO'), 'EFEITO_INCERTO');
  for (const a of ['ASSINATURA_CRIADA', 'COBRANCA_X', 'CREDITOS_Y', 'COMERCIAL_Z', 'RENOVACAO_W', 'AVISO_ASSINATURA_V', 'ARREPENDIMENTO_REGISTRADO', 'ENCERRADA', 'EMPRESA_CADASTRADA_PUBLICO', 'CADASTRO_CONFIRMADO'])
    assert.equal(cg.classeAuditoria(a), 'EFEITO_ACEITO', a);
  assert.equal(cg.classeAuditoria('LOGIN'), null);
  const l = leituraVazia();
  l.auditoria.por_acao = [{acao: 'ASSINATURA_CRIADA', de_cobranca: false, n: 1}];
  l.linhasProibidas = [{id: 'a1', acao: 'ASSINATURA_CRIADA'}];
  assert.deepEqual(motivos(l), ['AUDITORIA_PROIBIDA']);
  const s = leituraVazia(); s.auditoria.por_acao = [{acao: 'NOVA_ACAO', de_cobranca: true, n: 2}];
  assert.deepEqual(motivos(s), ['AUDITORIA_COBRANCA_SEM_CLASSE']);
  assert.equal(cg.avaliarAuditoria(l, null).relatorio.classes.EFEITO_ACEITO, 1);
});

test('barreira: L1 aberta em qualquer serviço, C2, crons e artefato; rótulos nunca carregam valor', () => {
  const b = barreira(); b.l1['cron-avisos'].CREDITOS_COMPRA_ATIVA = 'LIGADA';
  assert.deepEqual(motivos(leituraVazia(), declaracao({barreira: b})), ['L1_NAO_FECHADA:cron-avisos']);
  const k = barreira(); k.l1.web.ASAAS_API_KEY = 'PRESENTE';
  assert.deepEqual(motivos(leituraVazia(), declaracao({barreira: k})), ['L1_NAO_FECHADA:web']);
  const sem = barreira(); delete sem.l1['cron-reconciliacao'];
  assert.deepEqual(motivos(leituraVazia(), declaracao({barreira: sem})), ['L1_NAO_FECHADA:cron-reconciliacao']);
  const c = barreira(); c.crons_suspensos = false; c.c2 = {};
  assert.deepEqual(motivos(leituraVazia(), declaracao({barreira: c})), ['C2_NAO_REAFIRMADO', 'CRONS_NAO_SUSPENSOS']);
  assert.deepEqual(cg.avaliarBarreira(declaracao(), {RENDER_GIT_COMMIT: 'ffffffff'}), ['ARTEFATO_DIVERGENTE']);
  assert.deepEqual(cg.avaliarBarreira(declaracao(), {RENDER_GIT_COMMIT: 'bb65640a1234'}), []);
  assert.deepEqual(cg.avaliarBarreira({...declaracao(), barreira: undefined}), ['BARREIRA_NAO_DECLARADA']);
  const r = cg.rotulosL1({CADASTRO_PUBLICO_ATIVO: 'true', CREDITOS_COMPRA_ATIVA: 'false', ASAAS_API_KEY: '$aact_segredo', ASAAS_WEBHOOK_TOKEN: '  '});
  assert.equal(r.CADASTRO_PUBLICO_ATIVO, 'LIGADA');
  assert.equal(r.CREDITOS_COMPRA_ATIVA, 'DESLIGADA');
  assert.equal(r.CREDITOS_CATALOGO_ATIVO, 'AUSENTE');
  assert.equal(r.ASAAS_API_KEY, 'PRESENTE');
  assert.equal(r.ASAAS_WEBHOOK_TOKEN, 'AUSENTE');
  assert.ok(!JSON.stringify(r).includes('aact'));
  assert.equal(cg.l1Fechada(r), false);
  const prod = {...declaracao({alvo: 'production'})};
  assert.deepEqual(cg.avaliarBarreira(prod, {CADASTRO_PUBLICO_ATIVO: 'true'}), ['L1_WEB_DIVERGE_DESTE_SERVICO']);
});

test('provedor: registro por ponto; conta existente exige listagem completa e zero objeto capaz de cobrar', () => {
  assert.deepEqual(cg.avaliarProvedor(undefined), ['PROVEDOR_SEM_REGISTRO']);
  assert.deepEqual(cg.avaliarProvedor({em: CORTE, declarante: 'Felipe', conta_existe: false, o_que_foi_olhado: 'x'}), ['PROVEDOR_DECLARACAO_INCOMPLETA']);
  assert.deepEqual(cg.avaliarProvedor(provedorSemConta()), []);
  const conta = {em: CORTE, declarante: 'Felipe', conta_existe: true, conta: 'Demerzel', ambiente: 'producao', escopo: 'assinaturas, cobrancas e checkouts', listagem_completa: true, webhooks_conferidos: true, fila_conferida: true, operacoes_manuais_conferidas: true, objetos_capazes_de_cobrar: 0};
  assert.deepEqual(cg.avaliarProvedor(conta), []);
  assert.deepEqual(cg.avaliarProvedor({...conta, listagem_completa: false}), ['PROVEDOR_DECLARACAO_INCOMPLETA']);
  assert.deepEqual(cg.avaliarProvedor({...conta, objetos_capazes_de_cobrar: 1}), ['PROVEDOR_COM_OBJETO_CAPAZ_DE_COBRAR']);
  assert.deepEqual(cg.avaliarProvedor({...conta, objetos_capazes_de_cobrar: undefined}), ['PROVEDOR_COM_OBJETO_CAPAZ_DE_COBRAR']);
});

const HORA_A1 = '2026-02-01T10:00:00.123456Z';
const ldtValida = () => ({td_concluido: true, td_id: 'TD-1', guarda_demonstrada: true, objetos: {assinatura_avisos: {contagem: 1, hash: 'h1', situacoes: {ENVIADO: 1}}}, auditoria: [{id: 'a1', acao: 'AVISO_ASSINATURA_ENVIADO', hora: HORA_A1, td: 'TD-1'}]});
const leituraLdt = () => {
  const l = leituraVazia();
  Object.assign(l.dominio.assinatura_avisos, {contagem: 1, hash: 'h1', situacoes: {ENVIADO: 1}});
  l.auditoria.por_acao = [{acao: 'AVISO_ASSINATURA_ENVIADO', de_cobranca: true, n: 1}];
  l.linhasProibidas = [{id: 'a1', acao: 'AVISO_ASSINATURA_ENVIADO', hora: HORA_A1}];
  return l;
};
const barreiraGuardada = () => ({...barreira(), l2: 'PROVADA_NO_ARTEFATO'});

test('LDT: base exclusiva, exatamente as linhas da LDT, guarda no artefato e objetos admitidos', () => {
  const d = (ldt = ldtValida()) => declaracao({ponto: 'S', ldt, barreira: barreiraGuardada(), cadastros_referencia: {}});
  const c = cg.conformidade(leituraLdt(), d(), []);
  assert.deepEqual(c.motivos, []);
  assert.equal(c.base, 'LDT');
  assert.equal(c.atual, 'A-LDT');
  // Com LDT vigente não existe A-VAZIO, mesmo sem linha: as linhas sumiram, logo divergem.
  assert.ok(cg.conformidade(leituraVazia(), d(), []).motivos.includes('LDT_DIVERGENTE:assinatura_avisos'));
  const mudou = leituraLdt(); mudou.dominio.assinatura_avisos.hash = 'h2';
  assert.deepEqual(motivos(mudou, d()), ['LDT_DIVERGENTE:assinatura_avisos']);
  const outra = leituraLdt(); outra.dominio.cobranca_eventos.contagem = 1;
  assert.deepEqual(motivos(outra, d()), ['OBJETO_COM_LINHA:cobranca_eventos']);
  const auditoriaNova = leituraLdt(); auditoriaNova.linhasProibidas.push({id: 'a2', acao: 'AVISO_ASSINATURA_ENVIADO', hora: HORA_A1});
  assert.deepEqual(motivos(auditoriaNova, d()), ['AUDITORIA_PROIBIDA']);
  const trocou = leituraLdt(); trocou.linhasProibidas = [{id: 'a1', acao: 'ASSINATURA_CRIADA', hora: HORA_A1}];
  assert.deepEqual(motivos(trocou, d()), ['AUDITORIA_PROIBIDA'], 'mesmo id com outra ação não está tratado');
  const outraHora = leituraLdt(); outraHora.linhasProibidas[0].hora = '2026-02-01T10:00:00.123457Z';
  assert.deepEqual(motivos(outraHora, d()), ['AUDITORIA_PROIBIDA'], 'mesmo id e ação com outra hora não é a ocorrência tratada');
  const semOcorrencia = (o) => d({...ldtValida(), auditoria: [{id: 'a1', acao: 'AVISO_ASSINATURA_ENVIADO', hora: HORA_A1, td: 'TD-1', ...o}]});
  assert.ok(motivos(leituraLdt(), semOcorrencia({hora: undefined})).includes('LDT_AUDITORIA_INCOMPLETA'), 'sem hora');
  assert.ok(motivos(leituraLdt(), semOcorrencia({hora: '2026-02-01'})).includes('LDT_AUDITORIA_INCOMPLETA'), 'hora sem precisão');
  assert.deepEqual(motivos(leituraLdt(), semOcorrencia({td: undefined})), ['LDT_AUDITORIA_SEM_VINCULO_TD'], 'sem vínculo');
  assert.deepEqual(motivos(leituraLdt(), semOcorrencia({td: 'TD-2'})), ['LDT_AUDITORIA_SEM_VINCULO_TD'], 'outro TD');
  assert.deepEqual(motivos(leituraLdt(), d({...ldtValida(), td_id: undefined})), ['LDT_SEM_TD', 'LDT_AUDITORIA_SEM_VINCULO_TD'], 'booleano sem identificador do TD');
  const sumiu = leituraLdt(); sumiu.linhasProibidas = [];
  assert.deepEqual(motivos(sumiu, d()), ['LDT_AUDITORIA_NAO_ENCONTRADA']);
  assert.deepEqual(motivos(leituraLdt(), {...d(), barreira: barreira()}), ['LDT_SEM_GUARDA_NO_ARTEFATO']);
  assert.deepEqual(motivos(leituraLdt(), d({...ldtValida(), td_concluido: false})), ['LDT_SEM_TD']);
  assert.ok(motivos(leituraVazia(), d({td_concluido: true, td_id: 'TD-1', guarda_demonstrada: true, objetos: {}, auditoria: []})).includes('LDT_VAZIA'));
  const naoAdmitido = leituraLdt();
  assert.ok(motivos(naoAdmitido, d({...ldtValida(), objetos: {...ldtValida().objetos, ia_credito_pedidos: {contagem: 1, hash: 'h'}}})).includes('LDT_OBJETO_NAO_ADMITIDO:ia_credito_pedidos'));
  assert.throws(() => cg.validarDeclaracao(declaracao({ponto: 'P3', ldt: ldtValida()})), {message: 'LDT_ANTES_DO_S'});
});

test('histórico e resultado do S: a tabela da §9.2.5, célula por célula', () => {
  const coberto = {ponto_inicial: 'P1', contencao_continua: true, houve_fc_ou_perda_de_barreira: false};
  assert.equal(cg.avaliarHistorico(coberto), 'H-COBERTO');
  assert.equal(cg.avaliarHistorico(undefined), 'H-NAO');
  assert.equal(cg.avaliarHistorico({...coberto, contencao_continua: false}), 'H-NAO');
  assert.equal(cg.avaliarHistorico({...coberto, houve_fc_ou_perda_de_barreira: true}), 'H-NAO');
  assert.equal(cg.avaliarHistorico({ponto_inicial: 'P1', contencao_continua: true}), 'H-NAO');
  assert.equal(cg.avaliarHistorico({...coberto, houve_fc_ou_perda_de_barreira: true, criterio_de_cobertura: true}), 'H-COBERTO');
  assert.equal(cg.resultadoDoPonto('S', 'A-FALHA', 'H-COBERTO'), 'S-FALHA');
  assert.equal(cg.resultadoDoPonto('S', 'A-FALHA', 'H-NAO'), 'S-FALHA');
  assert.equal(cg.resultadoDoPonto('S', 'A-VAZIO', 'H-COBERTO'), 'S-PASS');
  assert.equal(cg.resultadoDoPonto('S', 'A-LDT', 'H-COBERTO'), 'S-REG');
  assert.equal(cg.resultadoDoPonto('S', 'A-VAZIO', 'H-NAO'), 'S-HIST');
  assert.equal(cg.resultadoDoPonto('S', 'A-LDT', 'H-NAO'), 'S-HIST');
  assert.equal(cg.resultadoDoPonto('P1', 'A-VAZIO'), 'PASS');
  assert.equal(cg.resultadoDoPonto('P3', 'A-LDT'), 'FALHA');
  assert.equal(cg.resultadoDoPonto('P9', 'A-LDT'), 'CONFORME');
  assert.equal(cg.resultadoDoPonto('P9', 'A-FALHA'), 'NAO_CONFORME');
  assert.deepEqual(cg.CODIGO_DO_RESULTADO, {PASS: 0, 'S-PASS': 0, 'S-REG': 0, CONFORME: 0, FALHA: 3, 'S-FALHA': 3, 'S-HIST': 3, NAO_CONFORME: 3, INCONCLUSIVO: 1});
});

test('contadores: classificado sempre vigiado; cadastros_publicos só depois do P3', () => {
  const ant = o => ({stats_reset: 'r', contadores: {[o]: {ins: 1, del: 0}}});
  const agora = o => ({[o]: {ins: 2, del: 0}});
  assert.deepEqual(cg.compararContadores(agora('assinatura_isencoes'), 'r', ant('assinatura_isencoes'), 'P2').movimentos, ['assinatura_isencoes']);
  assert.deepEqual(cg.compararContadores(agora('cadastros_publicos'), 'r', ant('cadastros_publicos'), 'P2').movimentos, []);
  assert.deepEqual(cg.compararContadores(agora('cadastros_publicos'), 'r', ant('cadastros_publicos'), 'P3').movimentos, []);
  assert.deepEqual(cg.compararContadores(agora('cadastros_publicos'), 'r', ant('cadastros_publicos'), 'P4').movimentos, ['cadastros_publicos']);
});

test('LDT sem linha e sem ocorrência não sustenta a base; restore só em destino isolado', () => {
  const b = {...barreira(), l2: 'PROVADA_NO_ARTEFATO'};
  assert.deepEqual(cg.validarLdt({td_concluido: true, td_id: 'TD-1', guarda_demonstrada: true, objetos: {cobranca_eventos: {contagem: 0}}, auditoria: []}, b), ['LDT_VAZIA']);
  assert.deepEqual(cg.validarLdt({td_concluido: true, td_id: 'TD-1', guarda_demonstrada: true, objetos: {cobranca_eventos: {contagem: 1}}, auditoria: []}, b), []);
  assert.deepEqual(cg.validarLdt({td_concluido: true, td_id: 'TD-1', guarda_demonstrada: true, objetos: {}, auditoria: [{id: 'a', acao: 'AA', hora: HORA_A1, td: 'TD-1'}]}, b), []);
  assert.deepEqual(cg.validarLdt({td_concluido: true, td_id: 'TD-1', guarda_demonstrada: true, objetos: {}, auditoria: [{id: 'a', acao: 'AA'}]}, b), ['LDT_AUDITORIA_INCOMPLETA'], 'contraprova R1-04: só id e ação');
  assert.throws(() => cg.validarDeclaracao(declaracao({alvo: 'production', prefixo: {fonte: 'restore'}})), {message: 'RESTORE_SO_EM_DESTINO_ISOLADO'});
});

test('contadores entre pontos: movimento em VAZIA acusa; reset é lacuna relatada', () => {
  assert.equal(cg.compararContadores({}, null, undefined).situacao, 'SEM_LEITURA_ANTERIOR');
  assert.equal(cg.compararContadores({}, 'r2', {stats_reset: 'r1', contadores: {}}).situacao, 'LACUNA_RESET_DE_ESTATISTICAS');
  const a = {stats_reset: 'r1', contadores: {cobranca_eventos: {ins: 1, del: 1}, cadastros_publicos: {ins: 1, del: 0}}};
  assert.deepEqual(cg.compararContadores({cobranca_eventos: {ins: 2, del: 1}, cadastros_publicos: {ins: 9, del: 0}}, 'r1', a).movimentos, ['cobranca_eventos']);
  assert.deepEqual(cg.compararContadores({cobranca_eventos: {ins: 1, del: 2}}, 'r1', a).movimentos, ['cobranca_eventos']);
  assert.deepEqual(cg.compararContadores({cobranca_eventos: {ins: 1, del: 1}}, 'r1', a).movimentos, []);
});

const arquivosFalsos = mapa => ({ler: p => { if (!(p in mapa)) throw new Error('ENOENT'); return mapa[p]; }});
const concluida = JSON.stringify({situacao: 'CONCLUIDA', resultado: 'APLICADA_POSTCHECK_PASS'});

test('prefixo: vem dos marcadores, nunca do que se encontrar', () => {
  const {ler} = arquivosFalsos({'/d/migration-089.json': concluida, '/d/falha.json': JSON.stringify({situacao: 'FALHA'}), '/d/down-089.json': JSON.stringify({situacao: 'CONCLUIDA'}), '/d/ruim.json': '{'});
  const listar = nomes => () => nomes;
  const base = {fonte: 'marcadores', pastas_marcadores: ['/d'], itens: [{migracao: '089', marcador: '/d/migration-089.json'}]};
  const ok = cg.resolverPrefixo(base, ler, listar(['migration-089.json', 'migration-099.json', 'migration-105.json', 'outro.txt']));
  assert.equal(ok.situacao, 'DECLARADO');
  assert.deepEqual(ok.ids, ['089']);
  assert.equal(ok.evidencias[0].sha256.length, 64);
  const mot = (p, nomes = []) => cg.resolverPrefixo(p, ler, listar(nomes)).motivo;
  assert.equal(mot({...base, itens: [{migracao: '089', marcador: '/d/nao-existe.json'}]}), 'PREFIXO_SEM_MARCADOR');
  assert.equal(mot({...base, itens: [{migracao: '089', marcador: '/d/ruim.json'}]}), 'PREFIXO_SEM_MARCADOR');
  assert.equal(mot({...base, itens: [{migracao: '089', marcador: '/d/falha.json'}]}), 'MARCADOR_NAO_CONCLUIDO');
  assert.equal(mot({...base, itens: [{migracao: '092', marcador: '/d/migration-089.json'}]}), 'PREFIXO_FORA_DE_ORDEM');
  assert.equal(mot({...base, pastas_marcadores: []}), 'PASTAS_DE_MARCADORES_NAO_DECLARADAS');
  assert.equal(mot({fonte: 'marcadores', pastas_marcadores: ['/d'], itens: []}, ['migration-089.json']), 'MARCADOR_NAO_DECLARADO');
  assert.equal(mot({fonte: 'marcadores', pastas_marcadores: ['/d'], itens: []}, ['migration-092-094.json']), 'MARCADOR_NAO_DECLARADO');
  assert.equal(cg.resolverPrefixo({fonte: 'marcadores', pastas_marcadores: ['/d'], itens: []}, ler, () => { throw new Error('x'); }).motivo, 'PASTA_DE_MARCADORES_ILEGIVEL');
  assert.equal(mot({...base, downs: [{migracao: '089', marcador: '/d/sem.json'}]}), 'DOWN_SEM_MARCADOR');
  const down = cg.resolverPrefixo({...base, downs: [{migracao: '089', marcador: '/d/down-089.json'}]}, ler, listar(['migration-089.json']));
  assert.deepEqual(down.ids, []);
  assert.equal(cg.resolverPrefixo({fonte: 'indeclaravel'}).situacao, 'INDECLARAVEL');
  assert.equal(cg.resolverPrefixo({fonte: 'restore', itens: []}).motivo, 'RESTORE_SEM_REGISTRO');
  assert.equal(cg.resolverPrefixo({fonte: 'restore', itens: [{migracao: '089'}], registro: {ponto: CORTE, origem: 'B-12'}}).situacao, 'DECLARADO');
  assert.deepEqual(cg.idsDoMarcador('092-094'), ['092', '093', '094']);
  assert.deepEqual(cg.idsDoMarcador('092-093'), ['092', '093']);
});

test('declaração: campo desconhecido, versão, ponto, alvo e corte futuro recusam', () => {
  const recusa = (d, m) => assert.throws(() => cg.validarDeclaracao(d), {message: m});
  recusa({...declaracao(), extra: 1}, 'DECLARACAO_CAMPO_DESCONHECIDO');
  recusa({...declaracao(), versao: 2}, 'DECLARACAO_VERSAO');
  recusa({...declaracao(), ponto: 'P6'}, 'DECLARACAO_PONTO');
  recusa({...declaracao(), alvo: 'staging'}, 'DECLARACAO_ALVO');
  recusa({...declaracao(), corte_p1: '2999-01-01T00:00:00.000Z'}, 'DECLARACAO_CORTE');
  recusa({...declaracao(), corte_p1: 'ontem'}, 'DECLARACAO_CORTE');
  recusa({...declaracao(), prefixo: {}}, 'DECLARACAO_PREFIXO');
});

test('alvo: sinais contraditórios recusam antes de conectar; banco errado recusa', () => {
  const PROD = {RENDER: 'true', RENDER_SERVICE_ID: 'srv-dak77m2d0e5s73b8rkkg', KIDMAIS_DEPLOY_ENV: 'production'};
  assert.doesNotThrow(() => cg.validarAlvo({alvo: 'production'}, PROD));
  assert.throws(() => cg.validarAlvo({alvo: 'production'}, {...PROD, KIDMAIS_DEPLOY_ENV: 'staging'}), {message: 'ALVO_PRODUCTION_SEM_SINAIS'});
  assert.throws(() => cg.validarAlvo({alvo: 'production'}, {...PROD, RENDER_SERVICE_ID: 'srv-x'}), {message: 'ALVO_PRODUCTION_SEM_SINAIS'});
  assert.throws(() => cg.validarAlvo({alvo: 'isolado'}, {KIDMAIS_DEPLOY_ENV: 'production'}), {message: 'ALVO_ISOLADO_EM_PRODUCTION'});
  assert.throws(() => cg.validarAlvo({alvo: 'isolado'}, {RENDER_SERVICE_ID: 'srv-dak77m2d0e5s73b8rkkg'}), {message: 'ALVO_ISOLADO_EM_PRODUCTION'});
  assert.throws(() => cg.validarBanco({alvo: 'production'}, 'outro'), {message: 'BANCO_DIVERGENTE'});
  assert.throws(() => cg.validarBanco({alvo: 'isolado'}, 'kidmais_production'), {message: 'BANCO_DE_PRODUCTION_EM_OUTRO_ALVO'});
  assert.doesNotThrow(() => cg.validarBanco({alvo: 'production'}, 'kidmais_production'));
});

test('URL: campos explícitos, parâmetros de destino recusados, TLS pelo ambiente', () => {
  const p = cg.parametrosDaUrl({DATABASE_URL: 'postgresql://u:s%40nha@dpg-x-a/kidmais_production', DATABASE_SSL: 'true', DATABASE_SSL_REJECT_UNAUTHORIZED: 'false'});
  assert.deepEqual({h: p.host, po: p.port, d: p.database, u: p.user, s: p.password, t: p.ssl}, {h: 'dpg-x-a', po: 5432, d: 'kidmais_production', u: 'u', s: 's@nha', t: {rejectUnauthorized: false}});
  assert.equal('connectionString' in p, false);
  for (const [url, m] of [['postgresql://u:s@h/d?host=outro', 'URL_COM_PARAMETROS'], ['postgresql://u:s@h/d?port=1', 'URL_COM_PARAMETROS'], ['mysql://u:s@h/d', 'URL_INVALIDA'], ['postgresql://u:s@h/', 'URL_INVALIDA'], ['lixo', 'URL_ILEGIVEL'], ['postgresql://u:%E0%A4@h/d', 'URL_ILEGIVEL']])
    assert.throws(() => cg.parametrosDaUrl({DATABASE_URL: url}), {message: m}, url);
});

test('saída: SHA-256 do texto e código pela tabela; código desconhecido nunca é 0', () => {
  let saida = '';
  assert.equal(cg.imprimir({resultado: 'PASS'}, s => { saida += s; }), 0);
  assert.match(saida, /SHA256_SAIDA=[0-9a-f]{64}\nCODIGO_SAIDA=0\n$/);
  assert.equal(cg.imprimir({resultado: 'S-HIST'}, () => undefined), 3);
  assert.equal(cg.imprimir({resultado: 'INCONCLUSIVO'}, () => undefined), 1);
  assert.equal(cg.imprimir({resultado: 'OUTRO'}, () => undefined), 1);
});

/** Cliente de banco falso: responde vazio à estrutura e registra cada SQL; falha numa consulta escolhida. */
function clienteFalso(cfg = {}) {
  return class {
    on() {}
    async connect() { if (cfg.falhaConexao) throw Object.assign(new Error('postgres://u:segredo@h/d recusou'), {code: 'ECONNREFUSED'}); }
    async end() {}
    async query(sql) {
      (cfg.sqls ?? []).push(sql);
      if (sql === cg.SQL_ESCRITORES) return {rows: [cfg.escritores ?? {total: 0, invisiveis: 0, recentes: 0}]};
      if (cfg.falhaEm && sql.includes(cfg.falhaEm)) throw Object.assign(new Error('senha=segredo'), {code: '42501'});
      if (sql.includes('session_user')) return {rows: [{banco: cfg.banco ?? 'descartavel', versao: 'PG', versao_num: cfg.versaoNum ?? 180006, servidor: '127.0.0.1', porta: 1, papel_sessao: 'a', papel: 'a', rolsuper: false, rolbypassrls: false, somente_leitura: cfg.somenteLeitura ?? 'on', isolamento: 'repeatable read', agora: new Date()}]};
      if (sql.includes('_corpo_conflito')) {
        const estrutura = Object.fromEntries(Object.entries(cg.ASSINATURAS).map(([id, itens]) => [id, Object.fromEntries(Object.keys(itens).map(k => [k, cg.BASE.includes(id)]))]));
        estrutura._corpo_conflito = null;
        return {rows: [{estrutura}]};
      }
      if (sql.includes('stats_reset')) return {rows: [{stats_reset: null}]};
      if (cfg.objetos && sql.includes('c.relkind AS tipo')) return {rows: cfg.objetos};
      if (cfg.dependencias && sql === cg.SQL_DEPENDENCIAS_RECORTE) return {rows: [cfg.dependencias]};
      if (sql.includes('/* auditorias_autorizadas */')) return {rows: cfg.semAutorizadas ? [] : [{iniciados: '0', estendidos: '0'}]};
      if (sql.includes('pg_stat_user_tables') && cfg.contadores) return {rows: cfg.contadores()};
      return {rows: []};
    }
  };
}
const semEspera = {esperar: async () => {}};
const declaracaoSemPrefixo = (extra = {}) => ({...declaracao({ponto: 'P1', linha_base: undefined}), prefixo: {fonte: 'restore', itens: [], registro: {ponto: CORTE, origem: 'B-12'}}, ...extra});

test('leitura: só SELECT, SET LOCAL, BEGIN READ ONLY e ROLLBACK, em ordem', async () => {
  const sqls = [];
  const r = await cg.conferir(declaracaoSemPrefixo(), {env: {}, Client: clienteFalso({sqls}), ...semEspera});
  // Várias transações (leitura principal + uma por leitura dos contadores), cada uma BEGIN READ ONLY … ROLLBACK, sem nada fora delas.
  let dentro = false, transacoes = 0;
  for (const s of sqls) {
    if (s === 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY') { assert.ok(!dentro, 'BEGIN aninhado'); dentro = true; transacoes++; continue; }
    if (s === 'ROLLBACK') { assert.ok(dentro, 'ROLLBACK solto'); dentro = false; continue; }
    assert.ok(dentro, `fora de transação: ${s}`);
    assert.match(s, /^(SET LOCAL |SELECT |\/\* auditorias_autorizadas \*\/)/, s);
  }
  assert.ok(!dentro);
  assert.ok(transacoes >= 3, `principal + duas leituras de contadores (${transacoes})`);
  assert.ok(!sqls.some(s => /\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE|GRANT|COMMIT)\b/.test(s)));
  assert.equal(r.papel.isolamento, 'repeatable read');
  assert.ok(r.inicio && r.fim);
});

test('erro nunca vira zero: qualquer falha de leitura é INCONCLUSIVO, sem texto do erro', async () => {
  for (const falhaEm of ['session_user', '_corpo_conflito', '::text AS item', 'CROSS JOIN LATERAL', 'pg_class c JOIN', 'pg_stat_user_tables', 'stats_reset']) {
    const r = await cg.conferir(declaracaoSemPrefixo(), {env: {}, Client: clienteFalso({falhaEm})});
    assert.equal(r.resultado, 'INCONCLUSIVO', `${falhaEm}|motivos=${r.motivos.join(',')}`);
    assert.equal(cg.CODIGO_DO_RESULTADO[r.resultado], 1);
    assert.deepEqual(r.motivos, ['LEITURA_IMPOSSIVEL:42501']);
    assert.ok(!JSON.stringify(r).includes('segredo'));
  }
  const c = await cg.conferir(declaracaoSemPrefixo(), {env: {}, Client: clienteFalso({falhaConexao: true})});
  assert.deepEqual(c.motivos, ['LEITURA_IMPOSSIVEL:ECONNREFUSED']);
  assert.ok(!JSON.stringify(c).includes('segredo'));
  await assert.rejects(cg.conferir(declaracaoSemPrefixo(), {env: {}, Client: clienteFalso({somenteLeitura: 'off'})}), {message: 'TRANSACAO_NAO_E_SOMENTE_LEITURA'});
  await assert.rejects(cg.conferir(declaracaoSemPrefixo(), {env: {}, Client: clienteFalso({banco: 'kidmais_production'})}), {message: 'BANCO_DE_PRODUCTION_EM_OUTRO_ALVO'});
});

test('prefixo indeclarável: relata o catálogo, nunca emite PASS', async () => {
  // Lançar aqui também é errado: o ponto precisa sair com o relato, não com uma exceção.
  let r;
  try { r = await cg.conferir(declaracao({ponto: 'P1', linha_base: undefined, prefixo: {fonte: 'indeclaravel'}}), {env: {}, Client: clienteFalso()}); } catch (e) { assert.fail(`não pode lançar: ${e.message}`); }
  assert.equal(r.resultado, 'INCONCLUSIVO', `motivos=${r.motivos.join(',')}`);
  assert.deepEqual(r.motivos, ['PREFIXO_INDECLARAVEL']);
  assert.ok(Array.isArray(r.catalogo_relatado));
});

test('marcador de perda: entra no S-HIST e não sai por releitura', async () => {
  // A leitura falsa acima não tem tabela: é a marca que se testa, não a conformidade.
  const r = await cg.conferir(declaracaoSemPrefixo({ponto: 'P9', linha_base: {}, cadastros_referencia: {}, leitura_anterior: {marcador_perda_nao_descartada: true}}), {env: {}, Client: clienteFalso()});
  assert.equal(r.marcador_perda_nao_descartada, true);
  const semMarca = await cg.conferir(declaracaoSemPrefixo({ponto: 'P9', linha_base: {}, cadastros_referencia: {}}), {env: {}, Client: clienteFalso()});
  assert.equal(semMarca.marcador_perda_nao_descartada, false);
  // Pelo caminho da conformidade, não só pelo do prefixo indeclarável: a releitura conforme ou reprovada também não apaga.
  const comPrefixo = {prefixo: {fonte: 'marcadores', pastas_marcadores: ['/m'], itens: []}, ponto: 'P9', linha_base: {}, cadastros_referencia: {}};
  const opcoes = {env: {}, Client: clienteFalso(), listarPasta: () => []};
  assert.equal((await cg.conferir(declaracaoSemPrefixo({...comPrefixo, leitura_anterior: {marcador_perda_nao_descartada: true}}), opcoes)).marcador_perda_nao_descartada, true);
  assert.equal((await cg.conferir(declaracaoSemPrefixo({...comPrefixo, marcador_perda: true}), opcoes)).marcador_perda_nao_descartada, true);
  assert.equal((await cg.conferir(declaracaoSemPrefixo(comPrefixo), opcoes)).marcador_perda_nao_descartada, false);
  const inconclusivo = await cg.conferir(declaracaoSemPrefixo({leitura_anterior: {marcador_perda_nao_descartada: true}}), {env: {}, Client: clienteFalso({falhaConexao: true})});
  assert.equal(inconclusivo.marcador_perda_nao_descartada, true);
});

test('main: alvo de teste recusado na linha de comando, --l1 sem valor', async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'conferidor-'));
  try {
    const arq = path.join(pasta, 'd.json');
    fs.writeFileSync(arq, JSON.stringify(declaracao()));
    const antes = process.stdout.write; let saida = '';
    process.stdout.write = s => { saida += s; return true; };
    let codigo;
    // Driver controlado: a recusa vem antes de qualquer cliente, e nada no teste abre conexão de verdade.
    const clientes = [];
    class ClienteQueRegistra { constructor(o) { clientes.push(o); } on() {} async connect() { throw Object.assign(new Error('sintetico'), {code: 'ECONNREFUSED'}); } async end() {} }
    try { codigo = await cg.main([`--declaracao=${arq}`], {}, {Client: ClienteQueRegistra}); } finally { process.stdout.write = antes; }
    assert.equal(clientes.length, 0, 'recusado antes de criar cliente');
    assert.equal(codigo, 1);
    assert.match(saida, /ALVO_TESTE_SO_EM_TESTE/);
    fs.writeFileSync(arq, '{');
    saida = ''; process.stdout.write = s => { saida += s; return true; };
    try { codigo = await cg.main([`--declaracao=${arq}`], {}); } finally { process.stdout.write = antes; }
    assert.equal(codigo, 1);
    assert.match(saida, /DECLARACAO_ILEGIVEL/);
  } finally { fs.rmSync(pasta, {recursive: true, force: true}); }
});

test('matriz: nenhum dado pessoal no hash e todo admitido na LDT tem colunas', () => {
  const pessoais = /documento|^email$|nome|motivo|mensagem|evidencia|instrumento|contratante|condicoes|ultimo_erro|provedor_cliente|provedor_assinatura|referencia|nota/;
  for (const [t, colunas] of Object.entries(cg.COLUNAS_HASH)) for (const c of colunas) assert.ok(!pessoais.test(c), `${t}.${c}`);
  for (const t of cg.ADMITIDOS_LDT) assert.ok(cg.COLUNAS_HASH[t], t);
  for (const t of ['assinatura_campanhas', 'ia_credito_pedidos', 'ia_credito_lotes']) assert.ok(!cg.ADMITIDOS_LDT.includes(t), t);
  assert.equal(cg.MATRIZ.length, 26);
  assert.equal(new Set(cg.MATRIZ.map(m => m.objeto)).size, 26);
  for (const t of ['contrato_x', 'pagamento_y', 'contratos', 'mcp_oauth_pedidos', 'aceites_documentos_legais']) assert.ok(cg.excluido(t), t);
  for (const t of ['contratacoes', 'pedidos', 'assinatura_x']) assert.ok(!cg.excluido(t), t);
});

test('bloco: ASCII, sha do corpo conferido, serviço guardado, conferidor carregado e deriva recusada', () => {
  for (const modo of bloco.MODOS) {
    const b = bloco.gerar({modo, rotulo: 'abcdef1'});
    assert.match(b, /^[\x09\x0a\x20-\x7e]*$/);
    assert.match(b, /sha256sum "\$C"/);
    assert.match(b, /CORPO_DIVERGENTE/);
    const c = bloco.corpo({modo});
    assert.match(c, /SERVICO_DIVERGENTE/);
    assert.match(c, /srv-dak77m2d0e5s73b8rkkg/);
    assert.match(c, /LINK_RECUSADO/);
  }
  const entregas = bloco.MODOS.filter(m => m.startsWith('ENTREGAR-'));
  assert.ok(entregas.length >= 2, 'D-LAN-4: conferidor passou de uma colagem');
  assert.deepEqual(bloco.MODOS, [...entregas, 'CONFERIR', 'LIMPEZA']);
  for (const m of entregas) { assert.match(bloco.corpo({modo: m}), /CONTEUDO_DIVERGENTE/); assert.ok(bloco.corpo({modo: m}).includes(`FRACAO_${/(\d+)$/.exec(m)[1]}_DIVERGENTE: nada gravado`), m); assert.doesNotMatch(bloco.corpo({modo: m}), /FRACAO_DIVERGENTE/); }
  // As frações remontam exatamente o arquivo.
  const zlib = require('node:zlib');
  assert.deepEqual(zlib.gunzipSync(Buffer.from(bloco.fracoes().flatMap(p => p.linhas).join(''), 'base64')), bloco.lerConferidor());
  assert.throws(() => bloco.gerar({modo: 'ENTREGAR', rotulo: 'abcdef1'}), {message: 'MODO_INVALIDO'});
  assert.throws(() => bloco.gerar({modo: `ENTREGAR-${entregas.length + 1}`, rotulo: 'abcdef1'}), {message: 'MODO_INVALIDO'});
  assert.match(bloco.corpo({modo: 'CONFERIR'}), /--declaracao=/);
  assert.match(bloco.corpo({modo: 'LIMPEZA'}), /DIVERGENTE_PRESERVADO/);
  assert.ok(!/\b(psql|DROP|DELETE)\b/.test(bloco.corpo({modo: 'CONFERIR'})));
  assert.throws(() => bloco.gerar({modo: 'ENTREGAR-1', rotulo: 'x'}), {message: 'ROTULO_INVALIDO'});
  assert.throws(() => bloco.gerar({modo: 'OUTRO', rotulo: 'abcdef1'}), {message: 'MODO_INVALIDO'});
  assert.equal(bloco.gerar({modo: 'ENTREGAR-1', rotulo: 'abcdef1'}), bloco.gerar({modo: 'ENTREGAR-1', rotulo: 'abcdef1'}));
});

test('bloco executado de verdade (bash -i em pasta temporária): serviço, entrega, repetição, adulteração, declaração e limpeza', () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const {spawnSync} = require('node:child_process');
  const {createHash} = require('node:crypto');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b26-bloco-'));
  try {
    const raizBash = spawnSync('bash', ['-c', 'pwd -P'], {cwd: dir, encoding: 'utf8'}).stdout.trim();
    assert.ok(raizBash);
    const env = {...process.env, RENDER_SERVICE_ID: 'srv-dak77m2d0e5s73b8rkkg'};
    delete env.DATABASE_URL;
    const texto = modo => bloco.gerar({modo, rotulo: 'abcdef1', alterarCorpo: c => c.split('/opt/render/project/src').join(raizBash)});
    const colar = (entrada, e = env) => {
      const r = spawnSync('bash', ['--norc', '--noprofile', '-i'], {input: entrada, encoding: 'utf8', env: e, cwd: dir, timeout: 60000});
      assert.equal(r.error, undefined);
      // bash -i ecoa a entrada no stderr: o texto do próprio bloco casaria as asserções. Só o stdout é o que o bloco disse.
      return r.stdout;
    };
    const destino = path.join(dir, '.kidmais-conferidor-g-vazio');
    const arquivo = path.join(destino, 'conferidor-g-vazio.cjs');
    const sha = bytes => createHash('sha256').update(bytes).digest('hex');
    const esperado = sha(bloco.lerConferidor());
    const entregas = bloco.MODOS.filter(m => m.startsWith('ENTREGAR-'));
    const N = entregas.length;
    const pastaPartes = path.join(destino, '.partes');

    const outro = colar(texto('ENTREGAR-1'), {...env, RENDER_SERVICE_ID: 'srv-outro'});
    assert.match(outro, /SERVICO_DIVERGENTE/); assert.match(outro, /CODIGO_SAIDA_BLOCO=4/);
    assert.ok(!fs.existsSync(destino), 'serviço errado não cria nada');

    // Adultera o conteúdo entregue, não o controle: vale mesmo se o trecho que confere o sha mudar. Prova antes de rodar que a adulteração ocorreu.
    const genuino = texto('ENTREGAR-1');
    const partes = genuino.split('\n');
    const iPayload = partes.findIndex(l => /^[A-Za-z0-9+/]{76}$/.test(l));
    assert.ok(iPayload >= 0, 'há linha de conteúdo para adulterar');
    partes[iPayload] = `${partes[iPayload][0] === 'A' ? 'B' : 'A'}${partes[iPayload].slice(1)}`;
    const adulterado = partes.join('\n');
    assert.notEqual(adulterado, genuino);
    const recusado = colar(adulterado);
    assert.match(recusado, /CORPO_DIVERGENTE/); assert.match(recusado, /CODIGO_SAIDA_BLOCO=4/);
    assert.ok(!fs.existsSync(destino), 'corpo adulterado não executa');

    // Partes em ordem inversa e repetidas: só a última monta; fração adulterada no disco para com 4 e não monta.
    const ultima = colar(texto(entregas[N - 1]));
    assert.ok(ultima.includes(`PARTE_${N}_DE_${N}_GRAVADA`), ultima); assert.match(ultima, /FALTAM_PARTES/); assert.match(ultima, /CODIGO_SAIDA_BLOCO=0/);
    assert.ok(!fs.existsSync(arquivo), 'sem todas as partes nada é instalado');
    const deNovo = colar(texto(entregas[N - 1]));
    assert.match(deNovo, /FALTAM_PARTES/); assert.match(deNovo, /CODIGO_SAIDA_BLOCO=0/);
    const fracao = fs.readdirSync(pastaPartes).find(n => n.startsWith(`${N}-`));
    assert.ok(fracao, 'fração gravada com o sha no nome');
    fs.appendFileSync(path.join(pastaPartes, fracao), 'AAAA\n');
    const fracaoRuim = colar(texto(entregas[N - 1]));
    assert.ok(fracaoRuim.includes(`FRACAO_${N}_DIVERGENTE: nada gravado`), fracaoRuim); assert.doesNotMatch(fracaoRuim, /FRACAO_DIVERGENTE/); assert.match(fracaoRuim, /CODIGO_SAIDA_BLOCO=4/);
    // Astra r1 de código, P3: colar as demais com a fração N adulterada no disco aponta a fração e sai 4 (não FALTAM_PARTES/0).
    for (const m of entregas.slice(0, N - 1)) {
      const r = colar(texto(m)); assert.ok(!/ENTREGUE/.test(r), r);
      assert.ok(r.includes(`FRACAO_${N}_DIVERGENTE`), r); assert.doesNotMatch(r, /FALTAM_PARTES/); assert.match(r, /CODIGO_SAIDA_BLOCO=4/);
    }
    assert.ok(!fs.existsSync(arquivo), 'fração adulterada não monta o arquivo');
    fs.rmSync(path.join(pastaPartes, fracao));
    const entregue = colar(texto(entregas[N - 1]));
    assert.ok(entregue.includes(`ENTREGUE ${esperado}`), entregue); assert.match(entregue, /CODIGO_SAIDA_BLOCO=0/);
    assert.equal(sha(fs.readFileSync(arquivo)), esperado);
    assert.ok(!fs.existsSync(pastaPartes), 'frações saem depois de montar');
    // Astra r1 de código, P2: o --plano roda na cópia isolada entregue (não no módulo do checkout), sai 0 e traz os dois critérios.
    const plano = spawnSync(process.execPath, [arquivo, '--plano'], {cwd: destino, encoding: 'utf8', env: {PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT}});
    assert.equal(plano.status, 0, plano.stderr);
    const pj = JSON.parse(plano.stdout);
    assert.deepEqual(Object.keys(pj.recorte_teste.criterio).sort(), ['empresa_assinaturas', 'empresa_excecoes_comerciais']);
    assert.equal(pj.recorte_teste.criterio.empresa_assinaturas, cg.testeAutorizado('r'));
    assert.equal(pj.recorte_teste.criterio.empresa_excecoes_comerciais, cg.extensaoAutorizada('r'));
    assert.ok(pj.recorte_teste.sql_auditorias_autorizadas.includes('auditorias_autorizadas'));
    const repetido = colar(texto(entregas[0]));
    assert.ok(repetido.includes(`JA_PRESENTE ${esperado}`), repetido); assert.match(repetido, /CODIGO_SAIDA_BLOCO=0/);

    const semDeclaracao = colar(texto('CONFERIR'));
    assert.match(semDeclaracao, /DECLARACAO_AUSENTE/); assert.match(semDeclaracao, /CODIGO_SAIDA_BLOCO=4/);
    fs.writeFileSync(path.join(destino, 'declaracao.json'), JSON.stringify({alvo: 'teste'}));
    const conferido = colar(texto('CONFERIR'));
    assert.match(conferido, /ALVO_TESTE_SO_EM_TESTE/); assert.match(conferido, /CODIGO_SAIDA=1/); assert.match(conferido, /CODIGO_SAIDA_BLOCO=1/);

    fs.appendFileSync(arquivo, '// alterado\n');
    const divergente = colar(texto(entregas[0]));
    assert.match(divergente, /CONTEUDO_DIVERGENTE/); assert.match(divergente, /CODIGO_SAIDA_BLOCO=4/);
    const naoRoda = colar(texto('CONFERIR'));
    assert.match(naoRoda, /CONFERIDOR_AUSENTE_OU_DIVERGENTE/); assert.match(naoRoda, /CODIGO_SAIDA_BLOCO=4/);
    const preservado = colar(texto('LIMPEZA'));
    assert.match(preservado, /DIVERGENTE_PRESERVADO/);
    assert.ok(fs.existsSync(arquivo), 'divergente fica para exame');
    assert.ok(!fs.existsSync(path.join(destino, 'declaracao.json')), 'a declaração sai');

    fs.rmSync(arquivo);
    colar(texto(entregas[0]));
    assert.ok(fs.existsSync(pastaPartes), 'fração pendente antes da limpeza');
    const limpo = colar(texto('LIMPEZA'));
    assert.match(limpo, /LIMPEZA_FEITA/); assert.match(limpo, /CODIGO_SAIDA_BLOCO=0/);
    assert.ok(!fs.existsSync(destino), 'nada fica para trás');
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('colunas lidas: lista fixa por objeto, para a prova de coluna ausente não depender do próprio módulo', () => {
  const esperadas = {
    empresa_assinaturas: ['empresa_id', 'plano', 'ciclo', 'situacao', 'teste_fim', 'periodo_atual_fim', 'cancelada_em', 'encerrada_em', 'versao', 'atualizado_em'],
    cobranca_eventos: ['id', 'provedor', 'tipo', 'empresa_id', 'situacao', 'recebido_em', 'processado_em'],
    assinatura_fundadores: ['id', 'empresa_id', 'estado', 'reservada_em', 'confirmada_em', 'beneficio_fim', 'liberada_em'],
    assinatura_contratacoes: ['id', 'empresa_id', 'plano', 'ciclo', 'estado', 'valor_final_centavos', 'criada_em', 'confirmada_em', 'cancelada_em'],
    assinatura_renovacoes: ['id', 'empresa_id', 'contratacao_id', 'primeiro_vencimento', 'estado', 'aviso_enviado_em', 'preco_aplicado_em', 'atualizado_em'],
    assinatura_avisos: ['id', 'empresa_id', 'tipo', 'marco', 'estado', 'enviado_em', 'atualizado_em'],
    assinatura_encerramentos: ['id', 'protocolo', 'empresa_id', 'tipo', 'solicitado_em', 'valor_devolucao_centavos', 'estorno_situacao', 'estorno_concluido_em'],
    assinatura_comprovantes: ['contratacao_id', 'empresa_id', 'registrado_em', 'email_enviado_em', 'email_falhou_em'],
    assinatura_arrependimentos: ['id', 'protocolo', 'empresa_id', 'solicitado_em', 'situacao', 'concluido_em', 'valor_restituido_centavos'],
    ia_credito_lotes: ['origem', 'pedido_id'],
    assinatura_isencoes: ['empresa_id', 'concedida_por', 'concedida_em'],
    empresa_excecoes_comerciais: ['id', 'empresa_id', 'tipo', 'valida_ate', 'criado_em', 'revogada_em', 'revogada_por'],
    empresa_documento_continuidades: ['id', 'empresa_id', 'tipo', 'situacao', 'data_efetiva', 'provedor_conferido_em', 'registrada_em'],
    cadastros_empresas: ['usuario_id', 'chave', 'empresa_id', 'criado_em'],
    cadastros_publicos: ['situacao', 'expira_em'],
  };
  for (const {objeto} of cg.MATRIZ) assert.deepEqual(cg.colunasLidas(objeto), esperadas[objeto] ?? [], objeto);
});

// ---------- D-LAN-4: teste autorizado (plano r2 + correções Astra r2) ----------

test('recorte: empresa_assinaturas é VAZIA_SALVO_TESTE e entra nos domínios vazios', () => {
  const m = cg.MATRIZ.find(x => x.objeto === 'empresa_assinaturas');
  assert.equal(m.dominio, 'VAZIA_SALVO_TESTE');
  assert.deepEqual(cg.DOMINIOS_VAZIOS, ['VAZIA', 'VAZIA_SALVO_TESTE']);
  assert.deepEqual(Object.keys(cg.RECORTE).sort(), ['empresa_assinaturas', 'empresa_excecoes_comerciais']);
  assert.deepEqual(cg.INSERCOES_AUTORIZADAS, {empresa_assinaturas: 'iniciados', empresa_excecoes_comerciais: 'estendidos'});
  // Linha de teste autorizada não conta; linha fora do critério conta como qualquer outra.
  const l = leituraVazia();
  l.dominio.empresa_assinaturas = {...l.dominio.empresa_assinaturas, contagem: 0, recorte: {situacao: 'APLICADO', total: 2, autorizadas: 2}};
  assert.deepEqual(motivos(l), []);
  l.dominio.empresa_assinaturas = {...l.dominio.empresa_assinaturas, contagem: 1, recorte: {situacao: 'APLICADO', total: 3, autorizadas: 2}};
  assert.ok(motivos(l).some(m => /empresa_assinaturas/.test(m)), motivos(l).join(','));
});

test('recorte indeterminado (dependência ausente): nunca vira zero', () => {
  const l = leituraVazia();
  const {contagem, ...semContagem} = l.dominio.empresa_assinaturas;
  assert.equal(contagem, 0);
  l.dominio.empresa_assinaturas = {...semContagem, recorte: {situacao: 'INDETERMINADO', faltas: ['colunas:auditoria']}};
  assert.ok(motivos(l).includes('RECORTE_TESTE_INDETERMINADO:empresa_assinaturas'), motivos(l).join(','));
});

test('predicado: alias próprio, auditoria SUCESSO do painel, um só INICIADO, maior testeFim e extensão não revogada', () => {
  const p = cg.testeAutorizado('r');
  for (const trecho of ["'PAINEL_DESENVOLVEDOR'", "'EMPRESA'", "'SUCESSO'", "'COMERCIAL_TESTE_INICIADO'", "'COMERCIAL_TESTE_ESTENDIDO'", "'EXTENSAO_TESTE'", 'revogada_em IS NULL', 'ORDER BY', 'DESC', 'LIMIT 1', "date_trunc('milliseconds'"]) assert.ok(p.includes(trecho), trecho);
  for (const c of cg.COLUNAS_NULAS_NO_TESTE) assert.ok(p.includes(`r.${c} IS NULL`), c);
  assert.ok(p.includes("r.situacao = 'TESTE'"));
  assert.ok(/public\.auditoria/.test(p) && /public\.empresa_excecoes_comerciais/.test(p), 'tabelas qualificadas (search_path = pg_catalog)');
  const x = cg.extensaoAutorizada('r');
  for (const trecho of ["'EXTENSAO_TESTE'", 'revogada_em IS NULL', "'excecaoId'", "'COMERCIAL_TESTE_ESTENDIDO'"]) assert.ok(x.includes(trecho), trecho);
  assert.ok(x.includes(cg.testeAutorizado('txa')), 'extensão exige teste autorizado da mesma empresa');
  // A data da auditoria só é usada se tiver o formato ISO em ms; texto torto vira NULL e o critério cai (IS TRUE).
  assert.match(cg.dataAud('au', 'testeFim'), /\[0-9\]\{3\}Z/);
  assert.ok(cg.sqlContagem('empresa_assinaturas').includes('IS NOT TRUE'));
  assert.ok(cg.sqlContagem('empresa_assinaturas').includes('FROM public.empresa_assinaturas r'));
  assert.ok(!cg.sqlContagem('cobranca_eventos').includes('IS NOT TRUE'));
  assert.ok(cg.SQL_AUDITORIAS_AUTORIZADAS.includes(cg.painelSucesso('au')));
  assert.ok(cg.sqlAuditoria(false).includes('false AS painel_sucesso'), 'sem recorte pronto, nada vira TESTE_AUTORIZADO');
  assert.ok(cg.sqlExcecoes(false).includes('false AS autorizada'), 'sem recorte pronto, extensão fica sem vínculo');
});

test('auditoria: TESTE_AUTORIZADO só com SUCESSO do painel; RECUSADO da mesma ação continua classificado', () => {
  assert.equal(cg.classeAuditoria('COMERCIAL_TESTE_INICIADO', true), 'TESTE_AUTORIZADO');
  assert.equal(cg.classeAuditoria('COMERCIAL_TESTE_ESTENDIDO', true), 'TESTE_AUTORIZADO');
  assert.equal(cg.classeAuditoria('COBRANCA_WEBHOOK_RECUSADO', true), 'TENTATIVA_RECUSADA', 'painel não abre outras ações');
  const semPainel = cg.classeAuditoria('COMERCIAL_TESTE_INICIADO', false);
  assert.notEqual(semPainel, 'TESTE_AUTORIZADO');
  const l = leituraVazia();
  l.auditoria.por_acao = [{acao: 'COMERCIAL_TESTE_INICIADO', de_cobranca: false, painel_sucesso: true, n: 1}, {acao: 'COMERCIAL_TESTE_INICIADO', de_cobranca: false, painel_sucesso: false, n: 1}];
  const r = cg.avaliarAuditoria(l, null).relatorio;
  assert.equal(r.classes.TESTE_AUTORIZADO, 1);
  assert.equal(Object.values(r.classes).reduce((a, b) => a + b, 0), semPainel ? 2 : 1, 'a outra linha segue a classe antiga');
});

test('contadores pareados: inserção coberta pela auditoria não é movimento; a mais é; a menos é desalinhado; sem acumulado é movimento', () => {
  const ant = (ins, aud) => ({stats_reset: 'r', contadores: {empresa_assinaturas: {ins, del: 0}, empresa_excecoes_comerciais: {ins, del: 0}}, ...(aud ? {auditorias_autorizadas: aud} : {})});
  const agora = ins => ({empresa_assinaturas: {ins, del: 0}, empresa_excecoes_comerciais: {ins, del: 0}});
  const c = (a, p, acc) => cg.compararContadores(agora(a), 'r', p, 'P2', acc);
  assert.deepEqual(c(2, ant(1, {iniciados: 1, estendidos: 3}), {iniciados: 2, estendidos: 4}), {situacao: 'COMPARADO', movimentos: [], desalinhados: []});
  assert.deepEqual(c(3, ant(1, {iniciados: 1, estendidos: 3}), {iniciados: 2, estendidos: 5}).movimentos, ['empresa_assinaturas']);
  assert.deepEqual(c(2, ant(1, {iniciados: 1, estendidos: 3}), {iniciados: 2, estendidos: 5}).desalinhados, ['empresa_excecoes_comerciais']);
  // Relatório antigo, sem auditorias_autorizadas: qualquer inserção é movimento (lado seguro).
  assert.deepEqual(c(2, ant(1, null), {iniciados: 1, estendidos: 1}).movimentos, ['empresa_assinaturas', 'empresa_excecoes_comerciais']);
  assert.deepEqual(c(2, ant(1, {iniciados: 0, estendidos: 0}), null).movimentos, ['empresa_assinaturas', 'empresa_excecoes_comerciais']);
  // Exclusão é sempre movimento, mesmo com auditoria.
  const delAgora = {empresa_assinaturas: {ins: 1, del: 1}, empresa_excecoes_comerciais: {ins: 1, del: 0}};
  assert.deepEqual(cg.compararContadores(delAgora, 'r', ant(1, {iniciados: 0, estendidos: 0}), 'P2', {iniciados: 0, estendidos: 0}).movimentos, ['empresa_assinaturas']);
});

test('contadores estáveis: duas leituras iguais seguidas; instável vira CONTADORES_NAO_ESTABILIZADOS e INCONCLUSIVO', async () => {
  const base = cg.MATRIZ.map(m => ({objeto: m.objeto, ins: '0', del: '0'}));
  let n = 0;
  const instavel = () => base.map(r => (r.objeto === 'cobranca_eventos' ? {...r, ins: String(n++)} : r));
  const esperas = [];
  const db = new (clienteFalso({contadores: instavel}))();
  const r = await cg.lerContadoresEstaveis(db, false, {esperar: async ms => esperas.push(ms), tentativas: 4, intervalo: 7});
  assert.equal(r.estaveis, false); assert.equal(r.leituras, 4); assert.deepEqual(esperas, [7, 7, 7]);
  const estavel = await cg.lerContadoresEstaveis(new (clienteFalso({contadores: () => base}))(), true, semEspera);
  assert.equal(estavel.estaveis, true); assert.equal(estavel.leituras, 2);
  assert.deepEqual(estavel.autorizadas, {iniciados: 0, estendidos: 0});
  await assert.rejects(cg.lerContadoresEstaveis(new (clienteFalso({contadores: () => base, semAutorizadas: true}))(), true, semEspera), e => e.code === 'AUD_SEM_LINHA');
  n = 0;
  const rel = await cg.conferir(declaracaoSemPrefixo(), {env: {}, Client: clienteFalso({contadores: instavel}), esperar: async () => {}, tentativas: 3});
  assert.equal(rel.contadores_estaveis, false);
  assert.ok(rel.motivos.includes('CONTADORES_NAO_ESTABILIZADOS') || rel.resultado === 'INCONCLUSIVO', rel.motivos.join(','));
  assert.equal(rel.resultado, 'INCONCLUSIVO');
});

test('--plano mostra o recorte do teste autorizado', async () => {
  const saidas = [];
  const orig = process.stdout.write;
  process.stdout.write = s => { saidas.push(String(s)); return true; };
  try { await cg.main(['--plano'], {}); } finally { process.stdout.write = orig; }
  const plano = JSON.parse(saidas.join(''));
  assert.ok(plano.recorte_teste, 'recorte_teste no plano');
  assert.ok(plano.recorte_teste.sql_auditorias_autorizadas.includes('auditorias_autorizadas'));
  assert.ok(plano.recorte_teste.criterio);
});

// ---------- Astra r1 de código (D-LAN-4 r2) ----------
const comPrefixoR2 = {prefixo: {fonte: 'marcadores', pastas_marcadores: ['/m'], itens: []}, ponto: 'P9', linha_base: {}, cadastros_referencia: {}};

test('r2 predicado: INICIADO exige testeFim válido e qualquer extensão revogada veta, antes do máximo', () => {
  const p = cg.testeAutorizado('r');
  assert.ok(p.includes(`${cg.dataAud('tai', 'testeFim')} IS NOT NULL`), 'testeFim inicial obrigatório');
  assert.match(p, /NOT EXISTS \(SELECT 1 FROM public\.empresa_excecoes_comerciais tvr WHERE tvr\.empresa_id = r\.empresa_id AND tvr\.tipo = 'EXTENSAO_TESTE' AND tvr\.revogada_em IS NOT NULL\)/);
});

test('r2 fotografia: contadores que mudam entre a amostra de antes e a de depois repetem a leitura e terminam INCONCLUSIVO, sem movimento', async () => {
  const base = cg.MATRIZ.map(m => ({objeto: m.objeto, ins: '0', del: '0'}));
  let chamadas = 0;
  // Cada amostra estável (duas leituras iguais) vê um valor novo: antes ≠ depois em toda repetição.
  const mudaEntreAmostras = () => { const v = String(Math.floor(chamadas++ / 2)); return base.map(r => (r.objeto === 'cobranca_eventos' ? {...r, ins: v} : r)); };
  const sqls = [];
  const anterior = {stats_reset: null, contadores: Object.fromEntries(base.map(r => [r.objeto, {ins: 0, del: 0}])), contadores_estaveis: true, fotografia_coerente: true};
  const rel = await cg.conferir(declaracaoSemPrefixo({...comPrefixoR2, leitura_anterior: anterior}), {env: {}, Client: clienteFalso({contadores: mudaEntreAmostras, sqls}), listarPasta: () => [], esperar: async () => {}});
  assert.equal(rel.fotografia_coerente, false);
  assert.equal(rel.repeticoes_fotografia, cg.REPETICOES_FOTOGRAFIA);
  assert.equal(sqls.filter(s => s.includes('session_user')).length, cg.REPETICOES_FOTOGRAFIA, 'o domínio é relido a cada repetição');
  assert.ok(rel.motivos.includes('CONTADORES_MUDARAM_DURANTE_A_LEITURA'), rel.motivos.join(','));
  assert.ok(!rel.motivos.some(m => m.startsWith('MOVIMENTO_ENTRE_PONTOS')), 'sem pontas estáveis não se decide movimento');
  assert.equal(rel.comparacao_contadores.situacao, 'PONTAS_NAO_ESTAVEIS');
  assert.notEqual(rel.resultado, 'PASS');
  // Coerente na 2ª repetição: segue com a leitura repetida.
  let k = 0;
  const mudaUmaVez = () => { const v = k++ < 2 ? '0' : '1'; return base.map(r => (r.objeto === 'cobranca_eventos' ? {...r, ins: v} : r)); };
  const rel2 = await cg.conferir(declaracaoSemPrefixo(comPrefixoR2), {env: {}, Client: clienteFalso({contadores: mudaUmaVez}), listarPasta: () => [], esperar: async () => {}});
  assert.equal(rel2.fotografia_coerente, true); assert.equal(rel2.repeticoes_fotografia, 2);
  assert.ok(!rel2.motivos.includes('CONTADORES_MUDARAM_DURANTE_A_LEITURA'));
});

test('r2 leitura anterior instável: movimento aparente não é decidido; lacuna CONTADORES_ANTERIORES_NAO_ESTABILIZADOS', async () => {
  const base = cg.MATRIZ.map(m => ({objeto: m.objeto, ins: m.objeto === 'cobranca_eventos' ? '5' : '0', del: '0'}));
  const contadoresAnt = Object.fromEntries(base.map(r => [r.objeto, {ins: 0, del: 0}]));
  // r3 (Astra r2, P1): a anterior só vale com tudo provado; legado sem campo, quarentena menor ou PG < 15 também são pontas instáveis.
  const provada = {contadores_estaveis: true, fotografia_coerente: true, estatisticas_cumulativas: true, quarentena_ms: 65000, prova_descarga: 'PROVADA'};
  const semCampo = campo => { const p = {...provada}; delete p[campo]; return p; };
  const casos = [{...provada, contadores_estaveis: false}, {...provada, fotografia_coerente: false}, semCampo('fotografia_coerente'), semCampo('contadores_estaveis'),
    semCampo('quarentena_ms'), semCampo('estatisticas_cumulativas'), {...provada, quarentena_ms: 64999}, {...provada, quarentena_ms: '65000'}, {...provada, estatisticas_cumulativas: false}, semCampo('prova_descarga'), {...provada, prova_descarga: 'SEM_PROVA'}];
  for (const flags of casos) {
    const rel = await cg.conferir(declaracaoSemPrefixo({...comPrefixoR2, leitura_anterior: {stats_reset: null, contadores: contadoresAnt, ...flags}}), {env: {}, Client: clienteFalso({contadores: () => base}), listarPasta: () => [], esperar: async () => {}, quarentenaMs: 65000});
    assert.ok(rel.motivos.includes('CONTADORES_ANTERIORES_NAO_ESTABILIZADOS'), JSON.stringify(flags) + rel.motivos.join(','));
    assert.ok(!rel.motivos.some(m => m.startsWith('MOVIMENTO_ENTRE_PONTOS')));
    assert.notEqual(rel.resultado, 'PASS');
  }
  // Controle: com a anterior provada e a mesma quarentena, o mesmo movimento é acusado.
  const ok = await cg.conferir(declaracaoSemPrefixo({...comPrefixoR2, leitura_anterior: {stats_reset: null, contadores: contadoresAnt, ...provada}}), {env: {}, Client: clienteFalso({contadores: () => base}), listarPasta: () => [], esperar: async () => {}, quarentenaMs: 65000});
  assert.ok(ok.motivos.includes('MOVIMENTO_ENTRE_PONTOS:cobranca_eventos'), ok.motivos.join(','));
  assert.ok(!ok.motivos.includes('CONTADORES_ANTERIORES_NAO_ESTABILIZADOS'));
});

test('r3 quarentena: a amostra final só sai depois da espera, que vem depois da fotografia; fora do teste a padrão é 65 s e sai no relatório', async () => {
  assert.equal(cg.QUARENTENA_STATS_MS, 65000);
  const ordem = [];
  const esperar = async ms => { ordem.push(`ESPERA:${ms}`); };
  const rel = await cg.conferir(declaracaoSemPrefixo({...comPrefixoR2, alvo: 'isolado'}), {env: {DATABASE_URL: 'postgresql://x@127.0.0.1:1/x'}, Client: clienteFalso({sqls: ordem}), listarPasta: () => [], esperar});
  assert.equal(rel.quarentena_ms, cg.QUARENTENA_STATS_MS);
  const iEspera = ordem.indexOf(`ESPERA:${cg.QUARENTENA_STATS_MS}`);
  assert.ok(iEspera > 0, 'a quarentena padrão foi aguardada');
  assert.ok(ordem.findIndex(s => s.includes('session_user')) < iEspera, 'a espera vem depois da fotografia do domínio');
  assert.ok(ordem.slice(iEspera + 1).some(s => s.includes('n_tup_ins')), 'a amostra final vem depois da espera');
  // Valor explícito é respeitado e publicado; inválido cai na padrão.
  const ordem2 = [];
  const rel2 = await cg.conferir(declaracaoSemPrefixo(comPrefixoR2), {env: {}, Client: clienteFalso({sqls: ordem2}), listarPasta: () => [], esperar: async ms => { ordem2.push(`ESPERA:${ms}`); }, quarentenaMs: 70000});
  assert.equal(rel2.quarentena_ms, 70000); assert.ok(ordem2.includes('ESPERA:70000'));
  const rel3 = await cg.conferir(declaracaoSemPrefixo({...comPrefixoR2, alvo: 'isolado'}), {env: {DATABASE_URL: 'postgresql://x@127.0.0.1:1/x'}, Client: clienteFalso(), listarPasta: () => [], esperar: async () => {}, quarentenaMs: -1});
  assert.equal(rel3.quarentena_ms, cg.QUARENTENA_STATS_MS);
});

test('r3 PG anterior ao 15: estatísticas sem garantia viram lacuna e o movimento não é decidido', async () => {
  const base = cg.MATRIZ.map(m => ({objeto: m.objeto, ins: m.objeto === 'cobranca_eventos' ? '5' : '0', del: '0'}));
  const anterior = {stats_reset: null, contadores: Object.fromEntries(base.map(r => [r.objeto, {ins: 0, del: 0}])), contadores_estaveis: true, fotografia_coerente: true, estatisticas_cumulativas: true, quarentena_ms: 0, prova_descarga: 'NAO_EXIGIDA'};
  for (const [versaoNum, garantida] of [[140010, false], [149999, false], [150000, true], [180006, true]]) {
    const rel = await cg.conferir(declaracaoSemPrefixo({...comPrefixoR2, leitura_anterior: anterior}), {env: {}, Client: clienteFalso({contadores: () => base, versaoNum}), listarPasta: () => [], esperar: async () => {}});
    assert.equal(rel.estatisticas_cumulativas, garantida, String(versaoNum));
    assert.equal(rel.motivos.includes('ESTATISTICAS_SEM_GARANTIA_PG_ANTERIOR_AO_15'), !garantida, String(versaoNum));
    assert.equal(rel.motivos.includes('MOVIMENTO_ENTRE_PONTOS:cobranca_eventos'), garantida, String(versaoNum));
    if (!garantida) { assert.equal(rel.comparacao_contadores.situacao, 'PONTAS_NAO_ESTAVEIS'); assert.notEqual(rel.resultado, 'PASS'); }
  }
});

test('r2 auditoria: coluna lida ausente (id/acao/origem/criado_em) vira AUDITORIA_COLUNAS_AUSENTES, nunca zero', () => {
  assert.deepEqual([...cg.COLUNAS_AUDITORIA_LIDAS], ['id', 'acao', 'origem', 'criado_em']);
  assert.ok(cg.SQL_DEPENDENCIAS_RECORTE.includes('AS auditoria_lida'));
  const l = leituraVazia();
  l.auditoria = {legivel: false, por_acao: [], colunas_ausentes: true};
  assert.ok(motivos(l).includes('AUDITORIA_COLUNAS_AUSENTES'));
  l.auditoria = {legivel: false, por_acao: []};
  assert.ok(motivos(l).includes('AUDITORIA_ILEGIVEL_OU_RLS'));
});

test('r2 auditoria pelo lerBanco: auditoria legível com coluna lida ausente não é consultada e vira AUDITORIA_COLUNAS_AUSENTES', async () => {
  const objetos = [{objeto: 'auditoria', tipo: 'r', leitura: true, rls_ativa: false, relrowsecurity: false, relforcerowsecurity: false}];
  const consultouAuditoria = sqls => sqls.some(s => s.includes('FROM public.auditoria au WHERE au.criado_em >= $1::timestamptz GROUP BY'));
  const sem = [];
  const r = await cg.conferir(declaracaoSemPrefixo(comPrefixoR2), {env: {}, Client: clienteFalso({sqls: sem, objetos, dependencias: {auditoria_lida: false}}), ...semEspera, listarPasta: () => []});
  assert.ok(r.motivos.includes('AUDITORIA_COLUNAS_AUSENTES'), r.motivos.join(','));
  assert.ok(!consultouAuditoria(sem), 'coluna ausente: a auditoria não pode ser lida');
  // Controle: com as colunas lidas presentes, a mesma auditoria é consultada e o motivo some.
  const com = [];
  const ok = await cg.conferir(declaracaoSemPrefixo(comPrefixoR2), {env: {}, Client: clienteFalso({sqls: com, objetos, dependencias: {auditoria_lida: true}}), ...semEspera, listarPasta: () => []});
  assert.ok(consultouAuditoria(com));
  assert.ok(!ok.motivos.includes('AUDITORIA_COLUNAS_AUSENTES'), ok.motivos.join(','));
  assert.ok(!ok.motivos.includes('AUDITORIA_ILEGIVEL_OU_RLS'), ok.motivos.join(','));
});

test('r3 prova de descarga: fora do teste, sessão invisível, ativa ou ociosa há pouco = sem prova (lacuna, movimento não decidido); consulta antes da amostra final', async () => {
  assert.equal(cg.OCIOSO_MINIMO_S, 11);
  assert.ok(cg.SQL_ESCRITORES.includes("state = 'idle' AND state_change <= clock_timestamp() - interval '11 seconds'"));
  assert.ok(cg.SQL_ESCRITORES.includes('pid <> pg_backend_pid()') && cg.SQL_ESCRITORES.includes('datname = current_database()'));
  const base = cg.MATRIZ.map(m => ({objeto: m.objeto, ins: m.objeto === 'cobranca_eventos' ? '5' : '0', del: '0'}));
  const anterior = {stats_reset: null, contadores: Object.fromEntries(base.map(r => [r.objeto, {ins: 0, del: 0}])), contadores_estaveis: true, fotografia_coerente: true, estatisticas_cumulativas: true, quarentena_ms: 65000, prova_descarga: 'PROVADA'};
  const isolado = (escritores, extra = {}, sqls) => cg.conferir(declaracaoSemPrefixo({...comPrefixoR2, alvo: 'isolado', leitura_anterior: {...anterior, ...extra}}),
    {env: {DATABASE_URL: 'postgresql://x@127.0.0.1:1/x'}, Client: clienteFalso({contadores: () => base, escritores, sqls}), listarPasta: () => [], esperar: async ms => { sqls?.push('ESPERA:' + ms); }});
  for (const esc of [{total: 2, invisiveis: 0, recentes: 1}, {total: 2, invisiveis: 1, recentes: 0}, {total: null, invisiveis: 0, recentes: 0}, {}]) {
    const rel = await isolado(esc);
    assert.equal(rel.prova_descarga, 'SEM_PROVA', JSON.stringify(esc));
    assert.ok(rel.motivos.includes('ESCRITORES_SEM_PROVA_DE_DESCARGA'), JSON.stringify(esc));
    assert.ok(!rel.motivos.some(m => m.startsWith('MOVIMENTO_ENTRE_PONTOS')), JSON.stringify(esc));
    assert.equal(rel.comparacao_contadores.situacao, 'PONTAS_NAO_ESTAVEIS'); assert.notEqual(rel.resultado, 'PASS');
  }
  // Controle: todas as outras sessões ociosas há tempo bastante = provada, e o mesmo movimento é acusado.
  const ordem = [];
  const ok = await isolado({total: 3, invisiveis: 0, recentes: 0}, {}, ordem);
  assert.equal(ok.prova_descarga, 'PROVADA'); assert.deepEqual(ok.escritores, {total: 3, invisiveis: 0, recentes: 0, descarregados: true});
  assert.ok(!ok.motivos.includes('ESCRITORES_SEM_PROVA_DE_DESCARGA'));
  assert.ok(ok.motivos.includes('MOVIMENTO_ENTRE_PONTOS:cobranca_eventos'), ok.motivos.join(','));
  const iEsp = ordem.indexOf('ESPERA:' + cg.QUARENTENA_STATS_MS), iEsc = ordem.lastIndexOf(cg.SQL_ESCRITORES);
  assert.ok(iEsp >= 0 && iEsc > iEsp, 'a prova vem depois da quarentena');
  assert.ok(ordem.slice(iEsc + 1).some(s => s.includes('n_tup_ins')), 'e antes da amostra final');
  // Com a prova exigida, anterior "NAO_EXIGIDA" (de teste) não serve de ponta.
  const antTeste = await isolado({total: 0, invisiveis: 0, recentes: 0}, {prova_descarga: 'NAO_EXIGIDA'});
  assert.ok(antTeste.motivos.includes('CONTADORES_ANTERIORES_NAO_ESTABILIZADOS'), antTeste.motivos.join(','));
  // No alvo de teste não é exigida (sai NAO_EXIGIDA), salvo pedido explícito.
  const t1 = await cg.conferir(declaracaoSemPrefixo(comPrefixoR2), {env: {}, Client: clienteFalso({escritores: {total: 1, invisiveis: 0, recentes: 1}}), listarPasta: () => [], esperar: async () => {}});
  assert.equal(t1.prova_descarga, 'NAO_EXIGIDA'); assert.ok(!t1.motivos.includes('ESCRITORES_SEM_PROVA_DE_DESCARGA'));
  const t2 = await cg.conferir(declaracaoSemPrefixo(comPrefixoR2), {env: {}, Client: clienteFalso({escritores: {total: 1, invisiveis: 0, recentes: 1}}), listarPasta: () => [], esperar: async () => {}, exigirDescarga: true});
  assert.equal(t2.prova_descarga, 'SEM_PROVA'); assert.ok(t2.motivos.includes('ESCRITORES_SEM_PROVA_DE_DESCARGA'));
});

// ---------- Astra r3 de código (D-LAN-4 r4) ----------
test('r4 reset e ausência de movimento: reset entre pontos é lacuna; fora do teste, comparação sem movimento nunca certifica (INCONCLUSIVO), movimento acusado continua reprovando', async () => {
  const zerada = cg.MATRIZ.map(m => ({objeto: m.objeto, ins: '0', del: '0'}));
  const comMov = cg.MATRIZ.map(m => ({objeto: m.objeto, ins: m.objeto === 'cobranca_eventos' ? '5' : '0', del: '0'}));
  const anterior = {stats_reset: null, contadores: Object.fromEntries(zerada.map(r => [r.objeto, {ins: 0, del: 0}])), contadores_estaveis: true, fotografia_coerente: true, estatisticas_cumulativas: true, quarentena_ms: 65000, prova_descarga: 'PROVADA'};
  const livres = {total: 2, invisiveis: 0, recentes: 0};
  const isolado = (contadores, extra = {}) => cg.conferir(declaracaoSemPrefixo({...comPrefixoR2, alvo: 'isolado', leitura_anterior: {...anterior, ...extra}}),
    {env: {DATABASE_URL: 'postgresql://x@127.0.0.1:1/x'}, Client: clienteFalso({contadores: () => contadores, escritores: livres}), listarPasta: () => [], esperar: async () => {}});
  // Prova de descarga PROVADA e nenhum movimento: ainda assim a ausência não está provada.
  const sem = await isolado(zerada);
  assert.equal(sem.prova_descarga, 'PROVADA');
  assert.equal(sem.comparacao_contadores.situacao, 'COMPARADO');
  assert.ok(sem.motivos.includes('AUSENCIA_DE_MOVIMENTO_SEM_PROVA_TRANSACIONAL'), sem.motivos.join(','));
  assert.equal(sem.ausencia_de_movimento, 'NAO_PROVADA');
  assert.ok(!['PASS', 'S-PASS', 'S-REG', 'CONFORME'].includes(sem.resultado), sem.resultado);
  assert.equal(cg.CODIGO_DO_RESULTADO[sem.resultado] === 0, false);
  assert.ok(typeof sem.resultado_sem_lacunas === 'string');
  // Movimento acusado: reprova, e a lacuna de ausência não aparece.
  const mov = await isolado(comMov);
  assert.ok(mov.motivos.includes('MOVIMENTO_ENTRE_PONTOS:cobranca_eventos'));
  assert.ok(!mov.motivos.includes('AUSENCIA_DE_MOVIMENTO_SEM_PROVA_TRANSACIONAL'));
  assert.equal(mov.ausencia_de_movimento, 'MOVIMENTO_ACUSADO');
  assert.ok(['FALHA', 'S-FALHA', 'NAO_CONFORME'].includes(mov.resultado), mov.resultado);
  // Reset entre pontos: lacuna nomeada, nunca PASS/CONFORME, nem com contadores iguais.
  for (const c of [zerada, comMov]) {
    const rs = await isolado(c, {stats_reset: '2026-11-01T00:00:00Z'});
    assert.equal(rs.comparacao_contadores.situacao, 'LACUNA_RESET_DE_ESTATISTICAS');
    assert.ok(rs.motivos.includes('ESTATISTICAS_REINICIADAS_ENTRE_PONTOS'), rs.motivos.join(','));
    assert.equal(rs.ausencia_de_movimento, 'NAO_PROVADA');
    assert.equal(cg.CODIGO_DO_RESULTADO[rs.resultado] === 0, false, rs.resultado);
  }
  // Alvo de teste (o harness é o único escritor): comparação sem movimento não ganha a lacuna, mas reset continua lacuna.
  const antTeste = {...anterior, quarentena_ms: 0, prova_descarga: 'NAO_EXIGIDA'};
  const teste = extra => cg.conferir(declaracaoSemPrefixo({...comPrefixoR2, leitura_anterior: {...antTeste, ...extra}}), {env: {}, Client: clienteFalso({contadores: () => zerada}), listarPasta: () => [], esperar: async () => {}});
  const t1 = await teste({});
  assert.equal(t1.comparacao_contadores.situacao, 'COMPARADO');
  assert.ok(!t1.motivos.includes('AUSENCIA_DE_MOVIMENTO_SEM_PROVA_TRANSACIONAL'), t1.motivos.join(','));
  assert.equal(t1.ausencia_de_movimento, 'COMPARADA_NO_TESTE');
  const t2 = await teste({stats_reset: '2026-11-01T00:00:00Z'});
  assert.ok(t2.motivos.includes('ESTATISTICAS_REINICIADAS_ENTRE_PONTOS'), t2.motivos.join(','));
  assert.equal(cg.CODIGO_DO_RESULTADO[t2.resultado] === 0, false, t2.resultado);
});

// ---------- Astra r4 de código (D-LAN-4 r5) ----------
test('r5: fora do alvo de teste a ausência nunca é certificada, nem com a descarga dispensada; anterior sem contadores é lacuna; estado_atual vem do apurado; retornos antecipados têm os campos novos', async () => {
  const zerada = cg.MATRIZ.map(m => ({objeto: m.objeto, ins: '0', del: '0'}));
  const comMov = cg.MATRIZ.map(m => ({objeto: m.objeto, ins: m.objeto === 'cobranca_eventos' ? '5' : '0', del: '0'}));
  const anterior = {stats_reset: null, contadores: Object.fromEntries(zerada.map(r => [r.objeto, {ins: 0, del: 0}])), contadores_estaveis: true, fotografia_coerente: true, estatisticas_cumulativas: true, quarentena_ms: 65000, prova_descarga: 'PROVADA'};
  const livres = {total: 2, invisiveis: 0, recentes: 0};
  const isolado = (contadores, ant, opcoes = {}) => cg.conferir(declaracaoSemPrefixo({...comPrefixoR2, alvo: 'isolado', ...(ant === undefined ? {} : {leitura_anterior: ant})}),
    {env: {DATABASE_URL: 'postgresql://x@127.0.0.1:1/x'}, Client: clienteFalso({contadores: () => contadores, escritores: livres}), listarPasta: () => [], esperar: async () => {}, ...opcoes});
  // P1: a opção da API que dispensa a descarga não dispensa a lacuna nem muda o rótulo.
  const dispensada = await isolado(zerada, anterior, {exigirDescarga: false});
  assert.equal(dispensada.prova_descarga, 'NAO_EXIGIDA');
  assert.equal(dispensada.comparacao_contadores.situacao, 'COMPARADO');
  assert.ok(dispensada.motivos.includes('AUSENCIA_DE_MOVIMENTO_SEM_PROVA_TRANSACIONAL'), dispensada.motivos.join(','));
  assert.equal(dispensada.ausencia_de_movimento, 'NAO_PROVADA');
  assert.equal(cg.CODIGO_DO_RESULTADO[dispensada.resultado] === 0, false, dispensada.resultado);
  // P1: fora do alvo de teste, leitura anterior declarada sem contadores válidos é lacuna; sem leitura anterior, não. No teste (só marcador), não.
  for (const ant of [{}, {contadores: null}, {contadores: 'x'}, {marcador_perda_nao_descartada: false}]) {
    const r = await isolado(zerada, ant);
    assert.equal(r.comparacao_contadores.situacao, 'SEM_LEITURA_ANTERIOR');
    assert.ok(r.motivos.includes('LEITURA_ANTERIOR_SEM_CONTADORES'), JSON.stringify(ant) + ' ' + r.motivos.join(','));
    assert.equal(r.ausencia_de_movimento, 'NAO_PROVADA');
    assert.equal(cg.CODIGO_DO_RESULTADO[r.resultado] === 0, false, r.resultado);
    const t = await cg.conferir(declaracaoSemPrefixo({...comPrefixoR2, leitura_anterior: ant}), {env: {}, Client: clienteFalso({contadores: () => zerada}), listarPasta: () => [], esperar: async () => {}});
    assert.ok(!t.motivos.includes('LEITURA_ANTERIOR_SEM_CONTADORES'), t.motivos.join(','));
    assert.equal(t.ausencia_de_movimento, 'NAO_PROVADA');
  }
  const primeira = await isolado(zerada, undefined);
  assert.ok(!primeira.motivos.includes('LEITURA_ANTERIOR_SEM_CONTADORES'), primeira.motivos.join(','));
  // P2: movimento acusado é apurado (A-FALHA). O caso só-lacuna (não A-FALHA) é provado na suíte PG: este falso nunca chega a CONFORME.
  const mov = await isolado(comMov, anterior);
  assert.equal(mov.estado_atual, 'A-FALHA');
  // P3: retornos antecipados com o mesmo formato.
  const imp = await cg.conferir(declaracaoSemPrefixo(), {env: {}, Client: clienteFalso({falhaConexao: true})});
  assert.equal(imp.resultado_sem_lacunas, null); assert.equal(imp.ausencia_de_movimento, 'NAO_PROVADA');
  const ind = await cg.conferir(declaracao({ponto: 'P1', linha_base: undefined, prefixo: {fonte: 'indeclaravel'}}), {env: {}, Client: clienteFalso()});
  assert.deepEqual(ind.motivos, ['PREFIXO_INDECLARAVEL']);
  assert.equal(ind.resultado_sem_lacunas, null); assert.equal(ind.ausencia_de_movimento, 'NAO_PROVADA');
});

// ---------- Astra r5 de código (D-LAN-4 r6) ----------
test('r6: leitura anterior válida com mapa de contadores esvaziado não vira comparação; fora do teste é lacuna', async () => {
  const zerada = cg.MATRIZ.map(m => ({objeto: m.objeto, ins: '0', del: '0'}));
  const cheia = {stats_reset: null, contadores: Object.fromEntries(zerada.map(r => [r.objeto, {ins: 0, del: 0}])), contadores_estaveis: true, fotografia_coerente: true, estatisticas_cumulativas: true, quarentena_ms: 65000, prova_descarga: 'PROVADA'};
  const livres = {total: 2, invisiveis: 0, recentes: 0};
  const isolado = ant => cg.conferir(declaracaoSemPrefixo({...comPrefixoR2, alvo: 'isolado', leitura_anterior: ant}),
    {env: {DATABASE_URL: 'postgresql://x@127.0.0.1:1/x'}, Client: clienteFalso({contadores: () => zerada, escritores: livres}), listarPasta: () => [], esperar: async () => {}});
  for (const contadores of [{}, {objeto_inexistente: {ins: 0, del: 0}}]) {
    const r = await isolado({...cheia, contadores});
    assert.equal(r.comparacao_contadores.situacao, 'SEM_PARES_COMPARAVEIS', JSON.stringify(contadores));
    assert.ok(r.motivos.includes('LEITURA_ANTERIOR_SEM_CONTADORES'), r.motivos.join(','));
    assert.ok(!r.motivos.includes('AUSENCIA_DE_MOVIMENTO_SEM_PROVA_TRANSACIONAL'), r.motivos.join(','));
    assert.equal(r.ausencia_de_movimento, 'NAO_PROVADA');
    assert.equal(cg.CODIGO_DO_RESULTADO[r.resultado] === 0, false, r.resultado);
    const t = await cg.conferir(declaracaoSemPrefixo({...comPrefixoR2, leitura_anterior: {...cheia, contadores}}), {env: {}, Client: clienteFalso({contadores: () => zerada}), listarPasta: () => [], esperar: async () => {}});
    assert.ok(!t.motivos.includes('LEITURA_ANTERIOR_SEM_CONTADORES'), t.motivos.join(','));
    assert.equal(t.ausencia_de_movimento, 'NAO_PROVADA');
  }
  // Com o mapa cheio a comparação acontece (controle).
  const c = await isolado(cheia);
  assert.equal(c.comparacao_contadores.situacao, 'COMPARADO');
  assert.ok(!c.motivos.includes('LEITURA_ANTERIOR_SEM_CONTADORES'), c.motivos.join(','));
});

// ---------- Astra r6 de código (D-LAN-4 r7) ----------
test('r7: anterior cheia e atual sem objetos vigiados aponta a fotografia atual, não a anterior', async () => {
  const zerada = cg.MATRIZ.map(m => ({objeto: m.objeto, ins: '0', del: '0'}));
  const cheia = {stats_reset: null, contadores: Object.fromEntries(zerada.map(r => [r.objeto, {ins: 0, del: 0}])), contadores_estaveis: true, fotografia_coerente: true, estatisticas_cumulativas: true, quarentena_ms: 65000, prova_descarga: 'PROVADA'};
  const livres = {total: 2, invisiveis: 0, recentes: 0};
  const isolado = (atual, ant) => cg.conferir(declaracaoSemPrefixo({...comPrefixoR2, alvo: 'isolado', leitura_anterior: ant}),
    {env: {DATABASE_URL: 'postgresql://x@127.0.0.1:1/x'}, Client: clienteFalso({contadores: () => atual, escritores: livres}), listarPasta: () => [], esperar: async () => {}});
  const atualVazia = await isolado([], cheia);
  assert.equal(atualVazia.comparacao_contadores.situacao, 'SEM_PARES_COMPARAVEIS');
  assert.equal(atualVazia.comparacao_contadores.falta, 'ATUAL');
  assert.ok(atualVazia.motivos.includes('SEM_PARES_COMPARAVEIS'), atualVazia.motivos.join(','));
  assert.ok(!atualVazia.motivos.includes('LEITURA_ANTERIOR_SEM_CONTADORES'), atualVazia.motivos.join(','));
  assert.equal(atualVazia.ausencia_de_movimento, 'NAO_PROVADA');
  assert.equal(cg.CODIGO_DO_RESULTADO[atualVazia.resultado] === 0, false, atualVazia.resultado);
  // Anterior esvaziada continua apontando a anterior, mesmo com a atual também vazia.
  for (const atual of [zerada, []]) {
    const r = await isolado(atual, {...cheia, contadores: {}});
    assert.equal(r.comparacao_contadores.falta, 'ANTERIOR');
    assert.ok(r.motivos.includes('LEITURA_ANTERIOR_SEM_CONTADORES'), r.motivos.join(','));
    assert.ok(!r.motivos.includes('SEM_PARES_COMPARAVEIS'), r.motivos.join(','));
  }
  // Anterior só com objetos não vigiados conta como anterior sem contadores vigiados.
  // O único objeto da matriz que pode ficar fora da vigilância é cadastros_publicos, e só até o P3.
  const naoVigiados = cg.MATRIZ.filter(m => !cg.DOMINIOS_VAZIOS.includes(m.dominio) && !cg.OBJETOS_HASHEADOS_CLASSIFICADOS.includes(m.objeto));
  assert.deepEqual(naoVigiados.map(m => m.objeto), ['cadastros_publicos']);
  const soNaoVigiados = await cg.conferir(declaracaoSemPrefixo({...comPrefixoR2, ponto: 'P3', alvo: 'isolado', leitura_anterior: {...cheia, contadores: {cadastros_publicos: {ins: 0, del: 0}}}}),
    {env: {DATABASE_URL: 'postgresql://x@127.0.0.1:1/x'}, Client: clienteFalso({contadores: () => zerada, escritores: livres}), listarPasta: () => [], esperar: async () => {}});
  assert.equal(soNaoVigiados.comparacao_contadores.falta, 'ANTERIOR');
  assert.ok(soNaoVigiados.motivos.includes('LEITURA_ANTERIOR_SEM_CONTADORES'), soNaoVigiados.motivos.join(','));
  // No alvo de teste nenhuma das duas lacunas entra.
  const t = await cg.conferir(declaracaoSemPrefixo({...comPrefixoR2, leitura_anterior: cheia}), {env: {}, Client: clienteFalso({contadores: () => []}), listarPasta: () => [], esperar: async () => {}});
  assert.ok(!t.motivos.includes('SEM_PARES_COMPARAVEIS') && !t.motivos.includes('LEITURA_ANTERIOR_SEM_CONTADORES'), t.motivos.join(','));
  assert.equal(t.ausencia_de_movimento, 'NAO_PROVADA');
});
