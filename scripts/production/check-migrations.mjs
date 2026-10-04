import fs from 'node:fs';
import path from 'node:path';
import { result, cli, isMain } from './common.mjs';
import { readDatabase } from './check-database-target.mjs';
// Explicit V1 inventory, not a numeric range: Foundation 020 belongs to another
// branch and is deliberately absent. Any new/renamed file requires review.
// Recognizing a file here never means it was applied (appliedState stays unknown);
// 055a–d additionally require explicit authorization before any apply.
const approvedFiles = [
  '20260907_001_crm_extensions.sql',
  '20260907_002_crm_people.sql',
  '20260907_003_crm_history_audit.sql',
  '20260907_004_crm_duplicates_merge.sql',
  '20260907_005_disponibilidade_base.sql',
  '20260907_006_comercial_base.sql',
  '20260907_006a_comercial_precos_patch.sql',
  '20260908_007_fechamento_base.sql',
  '20260908_008_identidade_cliente.sql',
  '20260908_009_contrato_base.sql',
  '20260908_010_contrato_documento_aceite.sql',
  '20260908_011_pagamentos_base.sql',
  '20260909_012_condicao_pagamento.sql',
  '20260909_013_autenticacao_contrato.sql',
  '20260909_014_revisao_operacional.sql',
  '20260910_015_tratamento_financeiro.sql',
  '20260911_016_festa.sql',
  '20260912_017_pocket_sexta.sql',
  '20260912_018_whatsapp_onboarding.sql',
  '20260915_019_festa_formalizacao.sql',
  '20260923_021_catalogo_configuravel_estrutura.sql',
  '20260923_022_catalogo_itens_iniciais.sql',
  '20260923_023_adicionais_por_pacote.sql',
  '20260923_024_taxa_rolha_versionada.sql',
  '20260923_025_extras_unitarios_pizza.sql',
  '20260925_026_perfil_empresa_estrutura.sql',
  '20260925_027_perfil_empresa_cadastro.sql',
  '20260925_028_perfil_empresa_revisao_aplicacao.sql',
  '20260926_029_fechamento_pacote_snapshot.sql',
  '20260926_030_preco_utilizado.sql',
  '20260926_031_empresas_comercial.sql',
  '20260926_032_pacote_revisao.sql',
  '20260926_033_tabela_preco_publicacao.sql',
  '20260926_034_integridade_tenant_comercial.sql',
  '20260926_035_publicacao_tabela_invariantes.sql',
  '20260926_036_empresa_pai_imutavel.sql',
  '20260926_037_publicacao_concorrencia.sql',
  '20260926_038_integridade_tenant_atomica.sql',
  '20260926_039_publicacao_serial_completa.sql',
  '20260926_040_integridade_sem_excecao_nominal.sql',
  '20260926_041_revisao_mesmo_tenant.sql',
  '20260926_042_reativacao_faixa_publicada.sql',
  '20260926_043_estrutura_tenant.sql',
  '20260926_044_ciclo_empresa.sql',
  '20260926_045_ciclo_membership.sql',
  '20260926_046_kidmais_legado_controlado.sql',
  '20260926_047_escopo_comercial_tabela.sql',
  '20260927_048_supersessao_tabela_publicada.sql',
  '20260927_049_publicacao_insert_e_trava.sql',
  '20260927_050_item_sem_categoria.sql',
  '20260927_051_snapshot_item_especifico.sql',
  '20260927_052_financeiro_gerencial.sql',
  '20260928_053_integridade_tenant_fechamento.sql',
  '20260928_054_empresa_id_clientes_fechamentos.sql',
  '20260928_055a_inteligencia_uso.sql',
  '20260928_055b_inteligencia_operacoes.sql',
  '20260928_055c_inteligencia_documentos.sql',
  '20260928_055d_inteligencia_importacoes.sql',
  '20260929_056_membership_papel_festa_tenant.sql',
  '20260929_057_assinatura_contrato_empresa.sql',
  '20260929_058_inteligencia_skills.sql',
  '20261001_059_operacional_parametros_consumo.sql',
  '20261001_060_whatsapp_atendimento.sql',
  '20261002_061_contratos_importados_integracao.sql',
  '20261002_062_agenda_empresa_unidade.sql',
  '20261004_063_whatsapp_mensagens_prontas.sql',
];
// From 013 on each migration has database/checks/<date>_<id>_precheck.sql and _postcheck.sql,
// except these explicit, reviewed shapes (anything else falls back to the default and fails closed):
// - 049–051 carry their prechecks inline (DO $$ ... RAISE) and have no external check files;
// - 052 names its checks with the "financeiro" suffix;
// - 054 needs its immediate backfill between precheck and postcheck;
// - 055a–d, 058, 059, 060 and 063 carry the precheck inline and have an external postcheck.
const checkFiles = {
  '049': [], '050': [], '051': [],
  '052': ['20260927_052_financeiro_precheck.sql', '20260927_052_financeiro_postcheck.sql'],
  '054': ['20260928_054_precheck.sql', '20260928_054_backfill_imediato.sql', '20260928_054_postcheck.sql'],
  '055a': ['20260928_055a_postcheck.sql'], '055b': ['20260928_055b_postcheck.sql'],
  '055c': ['20260928_055c_postcheck.sql'], '055d': ['20260928_055d_postcheck.sql'],
  '058': ['20260929_058_postcheck.sql'],
  '059': ['20261001_059_postcheck.sql'],
  '060': ['20261001_060_postcheck.sql'],
  '063': ['20261004_063_postcheck.sql'],
};
const requiresExplicitAuthorization = ['055a', '055b', '055c', '055d', '056', '057', '058', '059', '060', '061', '062', '063'];
const idLabel = id => /^\d+$/.test(id) ? String(Number(id)) : id.replace(/^0+/, '');
const requiredChecks = file => {
  const id = file.split('_')[1];
  if (Object.hasOwn(checkFiles, id)) return checkFiles[id];
  return Number.parseInt(id, 10) >= 13 ? ['precheck', 'postcheck'].map(kind => file.slice(0, 12) + '_' + kind + '.sql') : [];
};
function inspectInventory(entries, hasCheck) {
  const r = result('migrations');
  // Only this existing rollback is excluded; an arbitrary *_down.sql is not approved.
  const files = entries.filter(x => x !== '20260907_999_crm_core_down.sql').sort();
  const ids = files.map(x => x.split('_')[1]);
  if (ids.filter(x => x === '006a').length !== 1) r.blockers.push('MIGRATION_006A_MISSING');
  if (!hasCheck('20260908_011_pagamentos_postcheck.sql')) r.blockers.push('CHECK_FILE_MISSING_011_postcheck');
  for (const file of approvedFiles.filter(x => x.split('_')[1] !== '006a')) {
    const id = file.split('_')[1];
    if (files.filter(x => x === file).length !== 1 || ids.filter(x => x === id).length !== 1)
      r.blockers.push('MIGRATION_SEQUENCE_INVALID_' + idLabel(id));
  }
  if (files.some(x => !approvedFiles.includes(x))) r.blockers.push('MIGRATION_BASELINE_REVIEW_REQUIRED');
  for (const file of approvedFiles) {
    for (const check of requiredChecks(file)) if (!hasCheck(check)) r.blockers.push('CHECK_FILE_MISSING_' + check.slice(9, -4));
  }
  r.evidence.push({ source: 'code', scope: 'REPOSITORY', status: r.status, migrations: files, latest: files.at(-1), appliedState: 'unknown',
    deliberatelyAbsent: [{ id: '020', reason: 'FOUNDATION_SAAS_SEPARATE_BRANCH_NOT_REQUIRED_BY_CATALOG' }],
    requiresExplicitAuthorization: files.filter(x => requiresExplicitAuthorization.includes(x.split('_')[1])) });
  r.pending.push('014_OLD_POSTCHECK_CAN_FALSE_NEGATIVE_ON_EVOLVED_SCHEMA');
  r.pending.push('055A_D_NOT_APPLIED_REQUIRE_EXPLICIT_AUTHORIZATION');
  r.pending.push('056_NOT_APPLIED_REQUIRES_EXPLICIT_AUTHORIZATION');
  r.pending.push('057_NOT_APPLIED_REQUIRES_EXPLICIT_AUTHORIZATION');
  r.pending.push('058_NOT_APPLIED_REQUIRES_EXPLICIT_AUTHORIZATION');
  r.pending.push('059_NOT_APPLIED_REQUIRES_EXPLICIT_AUTHORIZATION');
  r.pending.push('060_NOT_APPLIED_REQUIRES_EXPLICIT_AUTHORIZATION');
  r.pending.push('061_NOT_APPLIED_REQUIRES_EXPLICIT_AUTHORIZATION');
  r.pending.push('062_NOT_APPLIED_REQUIRES_EXPLICIT_AUTHORIZATION');
  r.pending.push('063_NOT_APPLIED_REQUIRES_EXPLICIT_AUTHORIZATION');
  return r;
}
async function check(env, options = {}) {
  const root = path.resolve(import.meta.dirname, '../..');
  const r = inspectInventory(fs.readdirSync(path.join(root, 'database/migrations')),
    file => fs.existsSync(path.join(root, 'database/checks', file)));
  if (options['inspect-db']) {
    try { const data = await readDatabase(env, "SELECT count(*)::int AS count FROM pg_tables WHERE schemaname='public'"); r.evidence.push({ source: 'script', publicTables: Number(data.rows[0].count), appliedState: 'unknown' }); }
    catch { r.unknown.push('OPERATIONAL:MIGRATION_INSPECTION_NOT_VERIFIED'); }
  }
  return r;
}
if (isMain(import.meta.url)) cli('migrations', { 'inspect-db': 'boolean' }, check);
export { check, inspectInventory, approvedFiles, requiredChecks };
