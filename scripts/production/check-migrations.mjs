import fs from 'node:fs';
import path from 'node:path';
import { result, cli, isMain } from './common.mjs';
import { readDatabase } from './check-database-target.mjs';
// Explicit V1 inventory, not a numeric range: Foundation 020 belongs to another
// branch and is deliberately absent. Any new/renamed file requires review.
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
  '20260926_029_fechamento_pacote_snapshot.sql',
];
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
      r.blockers.push('MIGRATION_SEQUENCE_INVALID_' + Number(id));
  }
  if (files.some(x => !approvedFiles.includes(x))) r.blockers.push('MIGRATION_BASELINE_REVIEW_REQUIRED');
  for (const file of approvedFiles.filter(x => Number(x.split('_')[1]) >= 13)) {
    for (const kind of ['precheck', 'postcheck']) if (!hasCheck(file.slice(0, 12) + '_' + kind + '.sql')) r.blockers.push('CHECK_FILE_MISSING_' + file.slice(9, 12) + '_' + kind);
  }
  r.evidence.push({ source: 'code', scope: 'REPOSITORY', status: r.status, migrations: files, latest: files.at(-1), appliedState: 'unknown',
    deliberatelyAbsent: [{ id: '020', reason: 'FOUNDATION_SAAS_SEPARATE_BRANCH_NOT_REQUIRED_BY_CATALOG' }] });
  r.pending.push('014_OLD_POSTCHECK_CAN_FALSE_NEGATIVE_ON_EVOLVED_SCHEMA');
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
export { check, inspectInventory };
