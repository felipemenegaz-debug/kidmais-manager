/* eslint-disable @typescript-eslint/no-require-imports */
// Núcleo do aplicador manual da 092 → 093 → 094 (preço por quantidade cheia, agenda por unidade/salões, capacidade e
// salão da festa) — staging (scripts/migration-092-094-staging.cjs) e produção (scripts/migration-092-094-production.cjs);
// cada adaptador fixa o alvo, a identidade da conexão, o disco e os escopos permitidos.
// Derivado do aplicador da 089 (alvo travado, TLS, hash fixado de cada SQL com CRLF normalizado, estado ausente/completa/
// parcial, marcador exclusivo no disco persistente, códigos 0/1/2/3), com três migrations em sequência:
//   - cada uma tem estado próprio; só valem os prefixos da ordem (nenhuma, 092, 092+093, todas) — fora disso recusa;
//   - a aplicação roda, para cada migration ausente e na ordem, precheck (READ ONLY) → migration (transação própria do
//     arquivo, lock_timeout 5s) → estado completo → postcheck de INSTALAÇÃO → integridade (ambos READ ONLY);
//   - dois tipos de verificação (parecer do Astra de 23/10, P2-2): o postcheck de instalação prova a preservação dos dados
//     logo após o COMMIT (ex.: nenhum horário com capacidade ≠ 1, nenhuma festa com salão) e só roda na mesma execução,
//     depois da própria migration, dentro da janela combinada sem escritas de agenda/preços; a integridade
//     (database/checks/*_integridade.sql) é repetível — só estrutura, aceita dados operacionais — e é o que a conferência e
//     as migrations já completas usam;
//   - cada migration commita sozinha: uma falha na 093 deixa a 092 aplicada (o código publicado funciona com qualquer
//     prefixo; sem a 094 a agenda segue a regra exclusiva). O COMMIT é registrado assim que a consulta da migration
//     volta sem erro, antes de qualquer outra leitura (P2-1); se ela falha, a etapa fica DESFEITA_PELO_SERVIDOR (erro do
//     PostgreSQL antes do COMMIT, fora das classes 08/57/58/XX e do 40003) ou INDETERMINADO (sem resposta do servidor: reconciliar pela conferência);
//   - o estado (ausente/completa/parcial) usa marcadores de presença: detecta a versão/prefixo dos SQL fixados, não prova
//     integridade (P3-1) — isso é papel do arquivo de integridade (gatilhos habilitados e ligados, FKs validadas, índices
//     válidos, colunas, corpos de função por sha256).
// Ordem (como a 088/089): o CÓDIGO é publicado ANTES, já com este aplicador e os SQL na árvore implantada. Depois:
// --conferir-092-094 → autorização → --aplicar-092-094-autorizado --backup <registro> → --conferir-092-094.
// Conferência: somente leitura (BEGIN TRANSACTION READ ONLY em toda consulta), não grava nada no banco nem no disco.
// Nunca executa os down. A saída tem só nomes de etapas, booleanos e contagens (sem ids, nomes ou URL do banco).
// Escopos de execução (plano de promoção de 25/10/2026, B-1): `todas` (092 → 093 → 094 numa execução; staging) ou, em
// produção, `092-093` e `094` separados — o código antigo de produção quebra com a 094 (manifesto Festa), então a 094 só
// roda depois do deploy do código novo, em outra execução, com flag, autorização e marcador próprios. O escopo 092-093
// recusa com a 094 presente e nunca põe etapa da 094 no plano; o 094 exige 092 e 093 completas.
// Privilégios: avaliados como current_user, que é quem executa o DDL (no Render a credencial entra com `SET role` do
// dono; lição de 14/10/2026). As três alteram objetos existentes (ALTER TABLE, CREATE TRIGGER, CREATE OR REPLACE
// FUNCTION), por isso exigem ser DONO deles (pg_has_role USAGE no papel dono), além de CREATE em public e REFERENCES.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
// Carregado só quando usado: os aplicadores 102/103, 104/106 e 105 importam lerRevisado daqui e não dependem da 108.
const ev108 = () => require('./migration-108-evidencias.cjs');

const FLAG_CONFERIR = '--conferir-092-094';
const FLAG_APLICAR = '--aplicar-092-094-autorizado';
const FLAG_BACKUP = '--backup';
const MARCADOR = 'migration-092-094.json';
const IDS = Object.freeze(['092', '093', '094']);
const FLAG_APLICAR_092_093 = '--aplicar-092-093-autorizado';
const FLAG_APLICAR_094 = '--aplicar-094-autorizado';
const FLAG_CONFERIR_092_093 = '--conferir-092-093';
const FLAG_CONFERIR_094 = '--conferir-094';
/** Escopo → migrations que ele pode aplicar, flags de conferência e de aplicação e marcador exclusivo no disco. */
const ESCOPOS = Object.freeze({
  todas: Object.freeze({ids: IDS, conferir: FLAG_CONFERIR, flag: FLAG_APLICAR, marcador: MARCADOR}),
  '092-093': Object.freeze({ids: Object.freeze(['092', '093']), conferir: FLAG_CONFERIR_092_093, flag: FLAG_APLICAR_092_093, marcador: 'migration-092-093.json'}),
  '094': Object.freeze({ids: Object.freeze(['094']), conferir: FLAG_CONFERIR_094, flag: FLAG_APLICAR_094, marcador: 'migration-094.json'}),
});
const ETAPAS = Object.freeze([
  ['precheck 092', 'database/checks/20261022_092_precheck.sql', '9aae9e948df43719d6eb243c6d18497cb14091bca85efe95d25d92ef3a3b0da1'],
  ['migration 092', 'database/migrations/20261022_092_precos_por_quantidade.sql', '9fab4b45111d59af352851656f875600336584e7372ba6f65512643266600071'],
  ['postcheck 092', 'database/checks/20261022_092_postcheck.sql', 'f8e625fc3da3e083498777c3b59639f333607986e661961d3d4db2183826b4f1'],
  ['precheck 093', 'database/checks/20261022_093_precheck.sql', 'a3ec856898a775cf3c7c5023860201bf38ca48ddf38067891fd2103309b34534'],
  ['migration 093', 'database/migrations/20261022_093_agenda_configuracao_unidade.sql', '68eb102f9923cc7b3ffcb67871f97c6c74092a9bd7940a3b0482fef36e38446d'],
  ['postcheck 093', 'database/checks/20261022_093_postcheck.sql', 'c51e9bf4084ee0b60c5112c7c891f69bb0378c540db7cbbb7fb6026ed8e932ec'],
  ['precheck 094', 'database/checks/20261022_094_precheck.sql', 'bb169b2363f8946809d8a15d6a450843a8f2d5a40d802f30185059f6bfe417d5'],
  ['migration 094', 'database/migrations/20261022_094_agenda_capacidade.sql', '2dd526c8e09a0a933b40d8aacc9c36ac89e30b7d76ca796344bbd9d4904e9b93'],
  ['postcheck 094', 'database/checks/20261022_094_postcheck.sql', '38db738d4b2d139f4f0a189034150cf5b3dddaf5445a2a5f9db35b61b9539c4d'],
  ['integridade 092', 'database/checks/20261022_092_integridade.sql', 'b887aca4a7c04c24fdcfcd8f2ffd99c17e75fd60363566e77f36c1b01021c7f2'],
  ['integridade 093', 'database/checks/20261022_093_integridade.sql', '4e2894fceb36d9c26e10eab7098a1e7782f6a32827590d7f14af648cc3c6f130'],
  ['integridade 094', 'database/checks/20261022_094_integridade.sql', '43bd4cad374dfe00600c647d3d755c4b5907cccf0986fc6d457ca4717cfceb65'],
]);
const etapa = nome => ETAPAS.find(e => e[0] === nome);
/**
 * Migration 100 (agenda com um salão, 25/10/2026): troca SÓ o corpo de kidmais094_conflito_ocupacao. Depois dela, a
 * integridade da 094 confere esse corpo pelo hash da 100 — arquivo idêntico ao da 094 exceto por essa expectativa — e
 * todo o resto (gatilhos, colunas, FKs, os demais corpos) segue igual. Qualquer outro corpo cai na integridade da 094 e
 * recusa (nunca se ignora a divergência).
 */
const CORPO_CONFLITO_094 = 'b6aac1c0b99ed64f4dca94fe5d886e5d5892b82888325010e02adc850def8cf6';
const CORPO_CONFLITO_100 = '805cd427a7cc7a725fb3bdfb4fd050f04e618131104fcfc0678a0ddadd5b4bdb';
const INTEGRIDADE_094_APOS_100 = Object.freeze(['integridade 094 apos 100', 'database/checks/20261025_094_integridade_apos_100.sql',
  '855ad392fce77972165739fe6949838436cb79c6c0b82517a70bf83b65b6b4c5']);
/**
 * Migration 108 (salões combinados rebaseados, 28/10/2026; plano E4, E4-6): troca os corpos da regra de conflito e das
 * validações kidmais019_validar_contrato/kidmais_validar_agenda_revisao. Depois dela, a integridade da 094 é a CÓPIA da
 * versão após a 100 com só esses três hashes trocados (todo o resto preservado) e, ALÉM disso, a 108 precisa estar
 * íntegra pela prova única de scripts/migration-108-retrato.cjs (sqlProva108Integra; P2-E4-R2-2). Qualquer outro corpo
 * (ou evidência da 108 com outro corpo) = recusa nomeada, nunca a integridade da 094 original.
 */
const CORPO_CONFLITO_108 = '06a387fe9c40ceca6a4021b1f9676b76ee92592a2cc241705f1201a40cc97537';
const INTEGRIDADE_094_APOS_108 = Object.freeze(['integridade 094 apos 108', 'database/checks/20261029_094_integridade_apos_108.sql',
  '5000760588f1cb881b0db34250ce521b1e77fa2e9b1b778535ec79c2894142d6']);
const SQL_CORPO_CONFLITO = "SELECT encode(sha256(convert_to(replace(prosrc, E'\\r', ''), 'UTF8')), 'hex') AS h FROM pg_proc"
  + " WHERE oid = to_regprocedure('public.kidmais094_conflito_ocupacao(uuid,date,time without time zone,time without time zone,uuid,uuid,uuid,uuid)')";

const reg = t => `to_regclass('public.${t}')`;
const proc = f => `to_regprocedure('public.${f}')`;
const coluna = (t, c) => `EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=${reg(t)} AND attname='${c}' AND NOT attisdropped)`;
const gatilho = (t, g) => `EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='${g}' AND tgrelid=${reg(t)})`;
const restricao = (t, r, def) => `EXISTS (SELECT 1 FROM pg_constraint WHERE conname='${r}' AND conrelid=${reg(t)}${def ? ` AND pg_get_constraintdef(oid) LIKE '%${def}%'` : ''})`;
const corpo = (f, trecho) => `coalesce((SELECT prosrc LIKE '%${trecho}%' FROM pg_proc WHERE oid=${proc(f)}), false)`;
/** current_user é dono (ou membro com USAGE do dono) de TODAS as tabelas/funções listadas, e todas existem. */
const dono = (tabelas, funcoes = []) => `coalesce((SELECT bool_and(pg_has_role(current_user, d, 'USAGE')) AND count(*)=${tabelas.length + funcoes.length} FROM (
    SELECT relowner AS d FROM pg_class WHERE oid IN (${tabelas.map(reg).join(',')})${funcoes.length ? `
    UNION ALL SELECT proowner FROM pg_proc WHERE oid IN (${funcoes.map(proc).join(',')})` : ''}) x), false)`;
const referencias = tabelas => `coalesce((SELECT bool_and(has_table_privilege(current_user, oid, 'REFERENCES')) AND count(*)=${tabelas.length}
    FROM pg_class WHERE oid IN (${tabelas.map(reg).join(',')})), false)`;

/** Objetos de cada migration (presença lida do catálogo; a 092 e a 094 também substituem corpos de funções existentes). */
const OBJETOS = Object.freeze({
  '092': Object.freeze({
    m092_ponto: restricao('precos_pacote', 'precos_pacote_092_ponto_check'),
    m092_tipo_preco: restricao('precos_pacote', 'precos_pacote_tipo_calculo_check', 'PONTO'),
    m092_tipo_fotografia: restricao('fechamento_pacote_snapshots', 'fechamento_pacote_snapshots_tipo_check', 'PONTO'),
    m092_lacunas: corpo('kidmais_047_lacunas_escopo(uuid)', 'PONTO_DECRESCENTE'),
  }),
  '093': Object.freeze({
    m093_escopo: `${reg('agenda_escopo_config')} IS NOT NULL`,
    m093_saloes: `${reg('agenda_saloes')} IS NOT NULL`,
    m093_horario_saloes: `${reg('configuracao_agenda_saloes')} IS NOT NULL`,
    m093_pacote_saloes: `${reg('pacote_saloes')} IS NOT NULL`,
    m093_indice_escopo: `${reg('agenda_escopo_config_escopo_uk')} IS NOT NULL`,
    m093_indice_salao: `${reg('agenda_saloes_nome_uk')} IS NOT NULL`,
    m093_dias_semana: coluna('configuracao_agenda', 'dias_semana'),
    m093_capacidade: coluna('configuracao_agenda', 'capacidade'),
    m093_desativado: coluna('configuracao_agenda', 'desativado_a_partir_de'),
    m093_horario_livre: coluna('configuracao_agenda', 'horario_livre'),
    m093_livre_check: restricao('configuracao_agenda', 'configuracao_agenda_093_livre_escopo_check'),
    m093_funcao: `${proc('kidmais093_mesma_empresa()')} IS NOT NULL`,
    m093_gatilho_horario: gatilho('configuracao_agenda_saloes', 'configuracao_agenda_saloes_093_empresa_trg'),
    m093_gatilho_pacote: gatilho('pacote_saloes', 'pacote_saloes_093_empresa_trg'),
  }),
  '094': Object.freeze({
    m094_salao_festa: coluna('fechamentos', 'salao_id'),
    m094_salao_revisao: coluna('fechamento_revisoes', 'salao_id'),
    m094_funcao_festa: `${proc('kidmais094_salao_fechamento()')} IS NOT NULL`,
    m094_funcao_revisao: `${proc('kidmais094_salao_revisao()')} IS NOT NULL`,
    m094_ocupacoes: `${proc('kidmais094_ocupacoes(date,date)')} IS NOT NULL`,
    m094_conflito: `${proc('kidmais094_conflito_ocupacao(uuid,date,time without time zone,time without time zone,uuid,uuid,uuid,uuid)')} IS NOT NULL`,
    m094_gatilho_festa: gatilho('fechamentos', 'fechamentos_094_salao_trg'),
    m094_gatilho_revisao: gatilho('fechamento_revisoes', 'fechamento_revisoes_094_salao_trg'),
    m094_destino: corpo('kidmais019_validar_destino(uuid)', 'kidmais094_conflito_ocupacao'),
    m094_contrato: corpo('kidmais019_validar_contrato()', 'kidmais094_ocupacoes'),
    m094_revisao: corpo('kidmais_validar_agenda_revisao()', 'kidmais094_conflito_ocupacao'),
  }),
});
/** Dependências de cada migration (as mesmas dos prechecks), privilégios e o SET role informado sem nomes. */
const BASE = Object.freeze({
  d092: `${reg('precos_pacote')} IS NOT NULL AND ${reg('fechamento_pacote_snapshots')} IS NOT NULL AND ${reg('tabela_preco_escopos')} IS NOT NULL
    AND ${proc('kidmais_047_lacunas_escopo(uuid)')} IS NOT NULL AND ${restricao('precos_pacote', 'precos_pacote_tipo_calculo_check')}
    AND ${restricao('fechamento_pacote_snapshots', 'fechamento_pacote_snapshots_tipo_check')}`,
  d093: `${['configuracao_agenda', 'estabelecimentos', 'pacotes', 'usuarios_administrativos', 'empresas'].map(t => `${reg(t)} IS NOT NULL`).join(' AND ')}
    AND ${proc('kidmais062_unidade_agendavel(uuid,uuid)')} IS NOT NULL`,
  d094: `${reg('fechamentos')} IS NOT NULL AND ${reg('fechamento_revisoes')} IS NOT NULL AND ${proc('kidmais062_ocupacoes_escopo(date,date)')} IS NOT NULL
    AND ${['kidmais019_validar_destino(uuid)', 'kidmais019_validar_contrato()', 'kidmais_validar_agenda_revisao()'].map(f => `${proc(f)} IS NOT NULL`).join(' AND ')}`,
  pode_criar: `has_schema_privilege(current_user,'public','CREATE')`,
  dono_092: dono(['precos_pacote', 'fechamento_pacote_snapshots'], ['kidmais_047_lacunas_escopo(uuid)']),
  dono_093: dono(['configuracao_agenda']),
  referencias_093: referencias(['empresas', 'usuarios_administrativos', 'estabelecimentos', 'configuracao_agenda', 'pacotes']),
  dono_094: dono(['fechamentos', 'fechamento_revisoes'], ['kidmais019_validar_destino(uuid)', 'kidmais019_validar_contrato()', 'kidmais_validar_agenda_revisao()']),
  // agenda_saloes nasce na 093: aplicada nesta mesma execução, o dono é o próprio current_user.
  referencias_094: `CASE WHEN ${reg('agenda_saloes')} IS NULL THEN true ELSE ${referencias(['agenda_saloes'])} END`,
  papel_trocado: 'session_user <> current_user',
});
const CAMPOS = Object.freeze([...Object.keys(BASE), ...IDS.flatMap(id => Object.keys(OBJETOS[id]))]);
const SQL_ESTADO = 'SELECT\n  ' + [...Object.entries(BASE), ...IDS.flatMap(id => Object.entries(OBJETOS[id]))].map(([k, sql]) => `(${sql}) AS ${k}`).join(',\n  ');

function lerRevisado(raiz, arquivo, hash) {
  const sql = fs.readFileSync(path.join(raiz, arquivo), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(createHash('sha256').update(sql, 'utf8').digest('hex'), hash, 'ARQUIVO_DIVERGENTE ' + arquivo);
  return sql;
}
const curta = e => String(e?.message ?? e).replace(/postgres(?:ql)?:\/\/\S+/gi, '<url>').slice(0, 160);

/** Por migration: ausente | completa | parcial, pelos objetos dela (cada migration é uma transação só). */
function lerEstado(e) {
  for (const k of CAMPOS) assert.equal(typeof e?.[k], 'boolean', 'ESTADO_ILEGIVEL ' + k);
  const s = Object.fromEntries(Object.keys(BASE).map(k => [k, e[k]]));
  for (const id of IDS) {
    const chaves = Object.keys(OBJETOS[id]), presentes = chaves.filter(k => e[k]).length;
    s['m' + id] = presentes === 0 ? 'ausente' : presentes === chaves.length ? 'completa' : 'parcial';
  }
  return s;
}
const DEPENDENCIAS = Object.freeze({'092': 'DEPENDENCIA_AUSENTE_092 006/029/047', '093': 'DEPENDENCIA_AUSENTE_093 043/062', '094': 'DEPENDENCIA_AUSENTE_094 019/062'});
/**
 * Plano a partir do estado; recusa ANTES de qualquer escrita o que não for seguro. Escopo 092-093: só 092/093 no plano e
 * a 094 tem de estar ausente; escopo 094: integridade da 092 e da 093 (já completas) e a instalação da 094.
 */
function planoEtapas(s, escopo = 'todas') {
  assert.ok(Object.hasOwn(ESCOPOS, escopo), 'ESCOPO_DESCONHECIDO');
  for (const id of IDS) assert.notEqual(s['m' + id], 'parcial', 'APLICACAO_PARCIAL_' + id);
  // Só prefixos da ordem: 093 completa exige 092 completa; 094 completa exige 093 completa.
  assert.ok((s.m093 !== 'completa' || s.m092 === 'completa') && (s.m094 !== 'completa' || s.m093 === 'completa'), 'ORDEM_INESPERADA_092_094');
  if (escopo === '092-093') assert.equal(s.m094, 'ausente', 'ESCOPO_092_093_EXIGE_094_AUSENTE');
  if (escopo === '094') assert.ok(s.m092 === 'completa' && s.m093 === 'completa', 'ESCOPO_094_EXIGE_092_093_COMPLETAS');
  const consideradas = escopo === '092-093' ? ESCOPOS[escopo].ids : IDS;
  const pendentes = consideradas.filter(id => s['m' + id] === 'ausente');
  for (const id of pendentes) {
    assert.ok(s['d' + id], DEPENDENCIAS[id]);
    const falta = [!s.pode_criar && 'CREATE', !s['dono_' + id] && 'DONO', s['referencias_' + id] === false && 'REFERENCES'].filter(Boolean);
    assert.ok(falta.length === 0, `SEM_PRIVILEGIO_${id} ${falta.join(' ')}`);
  }
  return consideradas.flatMap(id => (s['m' + id] === 'completa' ? ['integridade'] : ['precheck', 'migration', 'postcheck', 'integridade']).map(t => `${t} ${id}`));
}

/**
 * Situação do COMMIT quando a consulta da migration falha. O arquivo é BEGIN … COMMIT numa consulta só: um erro do
 * PostgreSQL (SQLSTATE) em qualquer comando antes do COMMIT desfaz a transação inteira. Sem SQLSTATE (conexão perdida,
 * resposta não recebida) ou com perda de conexão, intervenção do operador, recurso do sistema ou erro interno (08, 57,
 * 58, XX), não se sabe se o COMMIT valeu: INDETERMINADO, a reconciliar pela conferência — nunca tratado como desfeito.
 * A classe 57 inteira, inclusive 57014 (cancelamento/statement_timeout), fica indeterminada: um cancelamento que chega
 * durante o COMMIT não prova que o commit local deixou de ser gravado (parecer do Astra, rodada 2). 40003
 * (statement_completion_unknown) também é INDETERMINADO: o próprio servidor diz que não sabe se o comando terminou (mesma
 * regra da 098; F-1 do Astra na revisão do aplicador 102/103, 27/10/2026).
 */
function commitNaFalha(e) {
  const sqlstate = typeof e?.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code) ? e.code : null;
  return sqlstate && !/^(08|57|58|XX)/.test(sqlstate) && sqlstate !== '40003' ? 'DESFEITA_PELO_SERVIDOR' : 'INDETERMINADO';
}

async function somenteLeitura(db, sql) {
  await db.query('BEGIN TRANSACTION READ ONLY');
  try {
    // Leitura também espera lock (ACCESS SHARE contra DDL concorrente): espera curta, falha explícita (parecer, d).
    await db.query("SET LOCAL lock_timeout = '5s'");
    await db.query("SET LOCAL statement_timeout = '30s'");
    const r = await db.query(sql);
    await db.query('ROLLBACK');
    return r;
  } catch (e) { await db.query('ROLLBACK').catch(() => {}); throw e; }
}
/**
 * Integridade da 094 (READ ONLY), pelo corpo da regra de conflito:
 *   - 094 → integridade da 094 (PASS); 100 → variante após a 100 (PASS_CORPO_100);
 *   - 108 → prova única "108 íntegra" (sqlProva108Integra) E a variante após a 108 (PASS_CORPO_108);
 *   - evidência da 108 (marcador, corpos ou funções kidmais098_* da 108) com corpo 094/100 → recusa EVIDENCIA_108_PARCIAL;
 *   - qualquer outro corpo (098 histórica, deriva, função sem corpo legível) → recusa CORPO_CONFLITO_DESCONHECIDO_094.
 * As recusas são nomeadas (erro com recusa = true): o CONFERIR as devolve como RECUSARIA; o APLICAR, como FALHA.
 */
// `prova108` = {env, aceitaTeste}: só a suíte PostgreSQL cria o aplicador com aceitaRetratosTeste (override de F2).
async function integridade094(db, raiz, prova108 = {}) {
  const corpo = (await somenteLeitura(db, SQL_CORPO_CONFLITO)).rows[0]?.h ?? null;
  const evidencias = ev108().evidencias108(ev108().lerEvidencias108((await somenteLeitura(db, ev108().SQL_EVIDENCIA_108)).rows[0]));
  if (corpo === CORPO_CONFLITO_108) {
    const prova = await ev108().provar108(db, {raiz, ...prova108});
    if (!prova.integra) throw ev108().recusa('PROVA_108_NAO_INTEGRA ' + prova.motivos.join(' '));
    await somenteLeitura(db, lerRevisado(raiz, INTEGRIDADE_094_APOS_108[1], INTEGRIDADE_094_APOS_108[2]));
    return 'PASS_CORPO_108';
  }
  if (evidencias.length > 0) throw ev108().recusa('EVIDENCIA_108_PARCIAL ' + evidencias.join(' '));
  if (corpo !== CORPO_CONFLITO_094 && corpo !== CORPO_CONFLITO_100) throw ev108().recusa('CORPO_CONFLITO_DESCONHECIDO_094');
  const apos100 = corpo === CORPO_CONFLITO_100;
  const [, arquivo, hash] = apos100 ? INTEGRIDADE_094_APOS_100 : etapa('integridade 094');
  await somenteLeitura(db, lerRevisado(raiz, arquivo, hash));
  return apos100 ? 'PASS_CORPO_100' : 'PASS';
}
/** Contagens informativas (sem ids): preços, horários e festas; com a 093, salões e escopos; com a 094, festas com salão. */
async function contagens(db, estado) {
  const c = ['(SELECT count(*) FROM precos_pacote)::int AS precos', '(SELECT count(*) FROM configuracao_agenda)::int AS horarios', '(SELECT count(*) FROM fechamentos)::int AS festas'];
  if (estado.m093 === 'completa') c.push('(SELECT count(*) FROM agenda_saloes)::int AS saloes', '(SELECT count(*) FROM agenda_escopo_config)::int AS escopos');
  if (estado.m094 === 'completa') c.push('(SELECT count(*) FROM fechamentos WHERE salao_id IS NOT NULL)::int AS festas_com_salao');
  return (await somenteLeitura(db, 'SELECT ' + c.join(', '))).rows[0];
}

/**
 * Conferência (nenhuma escrita no banco nem no disco): identidade, estado, plano e, em READ ONLY, a integridade
 * (repetível, aceita dados operacionais) de cada migration completa e o precheck de cada ausente — exceto o da 094 sem a
 * 093, que exige as tabelas da 093 (APOS_093).
 * Com `escopo` (produção: 092-093 no E3, 094 no E6), o plano, os checks e o resultado/código são SÓ daquele escopo: o E3
 * não depende de privilégio, dependência ou REFERENCES exclusivos da 094 (revisão do B-1, P2). Sem `escopo`, é o
 * diagnóstico global; num ambiente com escopos separados ele calcula o plano de cada escopo ANTES de qualquer retorno.
 */
async function conferirNoCliente(db, {raiz, sqlIdentidade, identidade, prova108, escopos = ['todas'], escopo}) {
  const r = {modo: 'conferencia'};
  if (escopo) r.escopo = escopo;
  r.conexao = identidade((await somenteLeitura(db, sqlIdentidade)).rows[0]);
  r.estado = lerEstado((await somenteLeitura(db, SQL_ESTADO)).rows[0]);
  // Ambiente com execuções separadas: o que cada escopo faria agora (plano ou motivo da recusa), sem escrever nada.
  if (escopos.some(x => x !== 'todas')) r.planos = Object.fromEntries(escopos.map(x => {
    try { return [x, planoEtapas(r.estado, x)]; } catch (e) { return [x, {recusaria: curta(e)}]; }
  }));
  try { r.plano = planoEtapas(r.estado, escopo ?? 'todas'); } catch (e) { r.resultado = 'RECUSARIA'; r.motivo = curta(e); return r; }
  const ids = escopo === '092-093' ? ESCOPOS[escopo].ids : IDS;
  r.contagens = await contagens(db, r.estado);
  r.checks = {};
  for (const id of ids) {
    const nome = (r.estado['m' + id] === 'completa' ? 'integridade ' : 'precheck ') + id;
    if (id === '094' && r.estado.m094 === 'ausente' && r.estado.m093 !== 'completa') { r.checks[nome] = 'APOS_093'; continue; }
    if (nome === 'integridade 094') {
      try { r.checks[nome] = await integridade094(db, raiz, prova108); } catch (e) {
        if (!e?.recusa) throw e;
        r.checks[nome] = 'RECUSADA'; r.resultado = 'RECUSARIA'; r.motivo = curta(e); return r;
      }
      continue;
    }
    const [, arquivo, hash] = etapa(nome);
    await somenteLeitura(db, lerRevisado(raiz, arquivo, hash));
    r.checks[nome] = 'PASS';
  }
  r.resultado = ids.every(id => r.estado['m' + id] === 'completa') ? 'JA_APLICADA_INTEGRIDADE_PASS' : 'PRONTA_PARA_APLICAR';
  return r;
}

/**
 * Aplicação, na ordem do plano: precheck (READ ONLY) → migration (transação do arquivo) → COMMIT registrado → estado
 * completo → postcheck de instalação → integridade. Completas: só integridade.
 */
async function aplicarNoCliente(db, {raiz, sqlIdentidade, identidade, registrar = () => {}, prova108, escopo = 'todas'}) {
  const sqls = new Map(ETAPAS.map(([nome, arquivo, hash]) => [nome, lerRevisado(raiz, arquivo, hash)]));
  const r = {escopo, etapas: []};
  r.conexao = identidade((await somenteLeitura(db, sqlIdentidade)).rows[0]); registrar(r);
  r.estadoAntes = lerEstado((await somenteLeitura(db, SQL_ESTADO)).rows[0]);
  r.plano = planoEtapas(r.estadoAntes, escopo); r.contagensAntes = await contagens(db, r.estadoAntes); registrar(r);
  // Defesa em profundidade: o plano do escopo 092-093 nunca pode conter etapa da 094.
  if (escopo === '092-093') assert.ok(!r.plano.some(n => n.endsWith(' 094')), 'ESCOPO_092_093_COM_ETAPA_094');
  for (const nome of r.plano) {
    r.etapas.push({nome, inicio: new Date().toISOString()}); registrar(r);
    if (nome.startsWith('migration ')) {
      try { await db.query(sqls.get(nome)); } catch (e) {
        r.etapas.at(-1).commit = commitNaFalha(e); registrar(r);
        await db.query('ROLLBACK').catch(() => {}); throw e;
      }
      // A consulta voltou sem erro: o COMMIT do arquivo valeu. Registrado ANTES de qualquer outra leitura (P2-1).
      r.etapas.at(-1).commit = 'CONFIRMADO'; registrar(r);
      const id = nome.slice(-3);
      assert.equal(lerEstado((await somenteLeitura(db, SQL_ESTADO)).rows[0])['m' + id], 'completa', 'ESTADO_DEPOIS_' + id);
    } else if (nome === 'integridade 094') r.etapas.at(-1).integridade = await integridade094(db, raiz, prova108);
    else await somenteLeitura(db, sqls.get(nome));
    Object.assign(r.etapas.at(-1), {ok: true, fim: new Date().toISOString()}); registrar(r);
  }
  r.estadoDepois = lerEstado((await somenteLeitura(db, SQL_ESTADO)).rows[0]);
  const esperadas = escopo === '092-093' ? ESCOPOS[escopo].ids : IDS;
  for (const id of esperadas) assert.equal(r.estadoDepois['m' + id], 'completa', 'ESTADO_FINAL_' + id);
  if (escopo === '092-093') assert.equal(r.estadoDepois.m094, 'ausente', 'ESTADO_FINAL_094_PRESENTE');
  r.contagensDepois = await contagens(db, r.estadoDepois);
  r.resultado = r.plano.some(n => n.startsWith('migration ')) ? 'APLICADA_POSTCHECK_PASS' : 'JA_APLICADA_INTEGRIDADE_PASS';
  registrar(r);
  return r;
}
const commitadas = r => (r.etapas ?? []).filter(x => x.commit === 'CONFIRMADO').map(x => x.nome.slice(-3));
const indeterminada = r => (r.etapas ?? []).find(x => x.commit === 'INDETERMINADO')?.nome.slice(-3) ?? null;

/**
 * Modo pelos argumentos: nenhum (plano), --conferir-092-094 (diagnóstico global), a conferência de um escopo PERMITIDO
 * no ambiente (--conferir-092-093, --conferir-094) ou a flag de aplicação de um escopo permitido seguida de
 * --backup <registro>. Flag de escopo não permitido (ex.: --aplicar-092-094-autorizado em produção) é recusada.
 */
function modo(argv, escopos = ['todas']) {
  if (argv.length === 0) return {modo: 'plano'};
  if (argv.length === 1 && argv[0] === FLAG_CONFERIR) return {modo: 'conferir'};
  const conferencia = escopos.find(x => x !== 'todas' && ESCOPOS[x].conferir === argv[0]);
  if (conferencia && argv.length === 1) return {modo: 'conferir', escopo: conferencia};
  const escopo = escopos.find(x => ESCOPOS[x].flag === argv[0]);
  if (escopo && argv.length === 3 && argv[1] === FLAG_BACKUP) {
    // Referência do backup/export feito antes (ex.: horário e id do export, PITR anotado); só texto curto e seguro.
    assert.match(argv[2], /^[A-Za-z0-9:._/ -]{6,120}$/, 'BACKUP_INVALIDO');
    return {modo: 'aplicar', escopo, backup: argv[2]};
  }
  assert.fail(escopos.some(x => argv.includes(ESCOPOS[x].flag)) ? 'BACKUP_OBRIGATORIO' : 'ARGUMENTOS_RECUSADOS');
}

/**
 * Fábrica do aplicador de um ambiente. `amb` fixa: nome, alvo(env) → opções do pg, SQL de identidade, identidade(linha),
 * diretório do registro, verificação do disco persistente e, opcionalmente, os escopos permitidos (padrão: `todas`) e a
 * ordem operacional mostrada no plano.
 */
function criarAplicador(amb) {
  const raizPadrao = path.resolve(__dirname, '..');
  // Override de F2 (KIDMAIS_RETRATOS_108_TESTE) só com aceitaRetratosTeste: true (suíte PostgreSQL; staging nunca).
  const prova = env => ({env, aceitaTeste: amb.aceitaRetratosTeste === true});
  const escopos = Object.freeze([...(amb.escopos ?? ['todas'])]);
  for (const x of escopos) assert.ok(Object.hasOwn(ESCOPOS, x), 'ESCOPO_DESCONHECIDO');
  const ordemPadrao = ['deploy do código com este aplicador (sem a 092–094 a agenda segue a regra exclusiva e o preço por faixas); conferir commit e hashes implantados',
    FLAG_CONFERIR, `backup restaurável de ${amb.nome} registrado (id/horário; export funcional não substitui)`, 'autorização de Felipe',
    'janela combinada: sem escritas de agenda/preços nem DDL concorrente', `${FLAG_CONFERIR} de novo, imediatamente antes`, FLAG_APLICAR, FLAG_CONFERIR];
  function plano({raiz = raizPadrao} = {}) {
    return {resultado: 'PLANO', conecta: false, ambiente: amb.nome, alvo: amb.ALVO,
      arquivos: [...ETAPAS, INTEGRIDADE_094_APOS_100, INTEGRIDADE_094_APOS_108].map(([nome, arquivo, hash]) => { lerRevisado(raiz, arquivo, hash); return {nome, arquivo, sha256: hash}; }),
      modos: {conferir: FLAG_CONFERIR, ...Object.fromEntries(escopos.filter(x => x !== 'todas').map(x => ['conferir ' + x, ESCOPOS[x].conferir])),
        ...Object.fromEntries(escopos.map(x => [x === 'todas' ? 'aplicar' : 'aplicar ' + x,
        `${ESCOPOS[x].flag} ${FLAG_BACKUP} <registro-do-backup>`]))}, registro: amb.DIR,
      marcadores: Object.fromEntries(escopos.map(x => [x, ESCOPOS[x].marcador])),
      preRequisitos: ['092: 006/029/047 (precos_pacote, fechamento_pacote_snapshots, tabela_preco_escopos, kidmais_047_lacunas_escopo)',
        '093: 043/062 (configuracao_agenda, estabelecimentos, pacotes, usuarios_administrativos, empresas, kidmais062_unidade_agendavel)',
        '094: 019/062 (fechamentos, fechamento_revisoes, kidmais062_ocupacoes_escopo, funções 019 da agenda)',
        'estado em prefixo da ordem (nenhuma, 092, 092+093, todas), nunca parcial', 'CREATE em public, dono dos objetos alterados, REFERENCES nas tabelas citadas',
        ...(escopos.includes('092-093') ? ['escopo 092-093: 094 ausente (nunca aplica a 094)'] : []),
        ...(escopos.includes('094') ? ['escopo 094: 092 e 093 completas'] : [])],
      ordem: amb.ordem ?? ordemPadrao,
      paradas: ['qualquer código ≠ 0: parar, copiar a saída e o marcador; não repetir',
        'FALHA: migracoesCommitadas = commits confirmados; migracaoIndeterminada ≠ null = reconciliar com a conferência antes de decidir',
        ...escopos.map(x => `retomada só com decisão de Felipe: renomear o marcador anterior (nunca apagar) para ${ESCOPOS[x].marcador.replace(/\.json$/, '')}.<horario>.json; o novo registro lista as tentativas anteriores`)],
      nuncaExecuta: ['down 092', 'down 093', 'down 094', 'alteração de env', 'deploy', 'restart',
        ...(escopos.includes('092-093') ? ['migration 094 na execução do escopo 092-093'] : [])]};
  }
  async function conferir({env, escopo, raiz = raizPadrao, Client = require('pg').Client}) {
    if (escopo !== undefined) assert.ok(escopo !== 'todas' && escopos.includes(escopo), 'ESCOPO_RECUSADO');
    const opts = amb.alvo(env);
    const db = new Client(opts); db.on?.('error', () => undefined);
    try { await db.connect(); return await conferirNoCliente(db, {raiz, sqlIdentidade: amb.SQL_IDENTIDADE, identidade: l => amb.identidade(l, env), prova108: prova(env), escopos, escopo}); }
    catch (e) { await db.query('ROLLBACK').catch(() => {}); return {modo: 'conferencia', resultado: 'FALHA', mensagem: curta(e)}; }
    finally { await db.end().catch(() => {}); }
  }
  async function executar({env, backup, escopo = escopos[0], dir = amb.DIR, raiz = raizPadrao, Client = require('pg').Client, disco = () => amb.exigirDisco()}) {
    assert.ok(escopos.includes(escopo), 'ESCOPO_RECUSADO');
    const opts = amb.alvo(env); disco();
    assert.match(String(backup ?? ''), /^[A-Za-z0-9:._/ -]{6,120}$/, 'BACKUP_OBRIGATORIO');
    for (const [, arquivo, hash] of [...ETAPAS, INTEGRIDADE_094_APOS_100, INTEGRIDADE_094_APOS_108]) lerRevisado(raiz, arquivo, hash);
    fs.mkdirSync(dir, {recursive: true, mode: 0o700});
    const nomeMarcador = ESCOPOS[escopo].marcador, base = nomeMarcador.replace(/\.json$/, '');
    const marcador = path.join(dir, nomeMarcador);
    // Tentativas anteriores preservadas pelo operador (marcador renomeado, nunca apagado) entram no novo registro.
    const anteriores = fs.readdirSync(dir).filter(n => n.startsWith(base + '.') && n.endsWith('.json') && n !== nomeMarcador).sort();
    const registro = {inicio: new Date().toISOString(), ambiente: amb.nome, escopo, backup, situacao: 'INICIADA', tentativasAnteriores: anteriores};
    // Exclusivo: qualquer tentativa anterior (concluída, falha ou perdida) impede repetição automática.
    try { fs.writeFileSync(marcador, JSON.stringify(registro, null, 2), {flag: 'wx', mode: 0o600}); }
    catch (e) { if (e?.code === 'EEXIST') assert.fail('TENTATIVA_ANTERIOR_REVISAR ' + marcador); throw e; }
    const salvar = r => fs.writeFileSync(marcador, JSON.stringify({...registro, ...r}, null, 2), {mode: 0o600});
    let ultimo = {};
    const db = new Client(opts); db.on?.('error', () => undefined);
    try {
      await db.connect();
      const r = await aplicarNoCliente(db, {raiz, sqlIdentidade: amb.SQL_IDENTIDADE, identidade: l => amb.identidade(l, env), prova108: prova(env), escopo,
        registrar: x => { ultimo = JSON.parse(JSON.stringify(x)); salvar({...ultimo, situacao: 'EM_ANDAMENTO'}); }});
      salvar({...r, situacao: 'CONCLUIDA', migracoesCommitadas: commitadas(r)});
      return {resultado: r.resultado, escopo, marcador, conexao: r.conexao, estadoAntes: r.estadoAntes, estadoDepois: r.estadoDepois,
        contagensAntes: r.contagensAntes, contagensDepois: r.contagensDepois, etapas: r.etapas.map(e => e.nome), migracoesCommitadas: commitadas(r)};
    } catch (e) {
      const falha = {etapa: ultimo.etapas?.at(-1)?.nome ?? 'CONEXAO', mensagem: curta(e)};
      // Cada migration commita sozinha: as confirmadas antes da falha ficam aplicadas (o código publicado aceita o
      // prefixo). Indeterminada: o COMMIT pode ter valido; só a conferência diz o estado real.
      const situacao = {migracoesCommitadas: commitadas(ultimo), migracaoIndeterminada: indeterminada(ultimo),
        reconciliar: `${FLAG_CONFERIR} antes de qualquer decisão; não repetir`};
      salvar({...ultimo, situacao: 'FALHA', falha, ...situacao});
      return {resultado: 'FALHA', escopo, marcador, falha, ...situacao};
    } finally { await db.end().catch(() => {}); }
  }
  /** Códigos: 0 PLANO/CONFERIDO/PASS; 1 recusa antes de conectar (lançada); 2 FALHA registrada; 3 conferência RECUSARIA. */
  const CODIGO = Object.freeze({PLANO: 0, PRONTA_PARA_APLICAR: 0, JA_APLICADA_INTEGRIDADE_PASS: 0, APLICADA_POSTCHECK_PASS: 0, FALHA: 2, RECUSARIA: 3});
  async function principal(argv, env, deps = {}) {
    const m = modo(argv, escopos);
    if (m.modo === 'plano') return {codigo: 0, saida: plano(deps)};
    const s = m.modo === 'conferir' ? await conferir({env, ...deps, escopo: m.escopo}) : await executar({env, ...deps, backup: m.backup, escopo: m.escopo});
    return {codigo: CODIGO[s.resultado] ?? 2, saida: s};
  }
  function cli() {
    principal(process.argv.slice(2), process.env).then(({codigo, saida}) => {
      (codigo === 0 ? console.log : console.error)(JSON.stringify(saida)); process.exitCode = codigo;
    }).catch(e => { console.error('RECUSADO ' + curta(e)); process.exitCode = 1; });
  }
  return {plano, conferir, executar, principal, cli, CODIGO, escopos};
}

module.exports = {IDS, ETAPAS, ESCOPOS, FLAG_APLICAR_092_093, FLAG_APLICAR_094, FLAG_CONFERIR_092_093, FLAG_CONFERIR_094, INTEGRIDADE_094_APOS_100,
  INTEGRIDADE_094_APOS_108, CORPO_CONFLITO_094, CORPO_CONFLITO_100, CORPO_CONFLITO_108, SQL_CORPO_CONFLITO, integridade094, OBJETOS, BASE, CAMPOS,
  commitNaFalha, FLAG_CONFERIR, FLAG_APLICAR, FLAG_BACKUP, MARCADOR, SQL_ESTADO, lerRevisado, lerEstado, planoEtapas,
  conferirNoCliente, aplicarNoCliente, modo, criarAplicador};
