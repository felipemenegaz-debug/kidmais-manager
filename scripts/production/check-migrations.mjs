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
  '20261004_063_painel_desenvolvedor.sql',
  '20261004_065_whatsapp_nome_perfil.sql',
  '20261006_064_reimportacao_apos_cancelamento.sql',
  '20261006_066_pix_recebimento_empresa.sql',
  '20261006_067_modelo_comercial_empresa.sql',
  '20261007_068_cobranca_assinatura.sql',
  '20261007_069_cadastro_publico.sql',
  '20261007_070_adicionais_do_buffet.sql',
  '20261007_071_importacoes_comerciais.sql',
  '20261007_072_modelos_contrato_empresa.sql',
  '20261008_073_convites.sql',
  '20261009_074_convite_familias.sql',
  '20261009_074a_planos_comerciais.sql',
  '20261009_075_renovacao_fundador.sql',
  // 076–079 (staging). Este inventário só reconhece arquivos e nunca lê o banco (appliedState = unknown). Aplicação em
  // staging registrada em evidências datadas, não confirmada aqui: 076/077 em 10/10/2026; 078 (catálogo do buffet por
  // empresa) em 11/10/2026, PASS em docs/evidencias/atualizacao-staging-20261011.md (S5b); 079 em 11/10/2026
  // (scripts/migration-079-staging.cjs). O estado atual de um banco só se afirma por leitura própria e datada (E2a).
  // Produção exige autorização explícita própria para cada uma.
  '20261010_076_cpf_por_empresa.sql',
  '20261010_077_regras_pagamento_empresa.sql',
  '20261010_078_catalogo_buffet_por_empresa.sql',
  '20261011_079_convite_recuperacao_manual.sql',
  // 080–082: atendimento WhatsApp/Wall-e (antes 077a/077b/078; renumeradas em 11/10/2026, escolha local provisória, não
  // reserva coordenada). Nunca aplicadas em banco remoto segundo os registros desta linha; E2a novo antes de aplicar.
  // Ordem de aplicação num banco que já tem 061–079: 060 → 065 → 080 → 081 → 082 (provada em ordem-staging-real).
  '20261011_080_whatsapp_mensagens_prontas.sql',
  '20261011_081_whatsapp_prontas_midia.sql',
  '20261011_082_wall_e_atendimento.sql',
  // 083: WhatsApp por empresa (empresa_id em whatsapp_conexoes/tentativas). Aditiva; precheck e postcheck externos
  // (padrão). Aplicação em staging registrada em evidência datada fora deste inventário (16/10/2026, ~09:52Z, aplicador
  // scripts/migration-083-staging.cjs, PASS; nota do vault "Plano WhatsApp por empresa"), não confirmada aqui. Por isso o
  // número 083 não muda: o Marketing foi renumerado (18/10/2026).
  '20261016_083_whatsapp_conexao_empresa.sql',
  // 084: etapas duráveis da geração de IA de convites (envio, recebimento, classe da falha) e estado NAO_ENVIADA.
  // Aditiva; precheck e postcheck externos (padrão). Aplicação em staging registrada fora deste inventário (18/10/2026
  // ~08:33Z, aplicador scripts/migration-084-staging.cjs, H1 PASS segundo a sessão de Convites), não confirmada aqui.
  '20261018_084_convite_geracao_pendencias.sql',
  // A 084 é de Convites (PR #176, mergeada em staging em 18/10/2026 segundo o fetch local de 05:50); por isso o
  // Marketing passou de 084/085 para 085/086 (18/10/2026).
  // 085: Marketing (goal local de 14/10/2026). Escolha local provisória, não reserva coordenada; nunca aplicada fora de
  // banco descartável local. Precheck e postcheck externos (forma padrão).
  '20261018_085_marketing_base.sql',
  // 086: automações de Marketing (mesmo goal local; exige a 085).
  '20261018_086_marketing_automacoes.sql',
  // 088: autorização do responsável legal para Convites com IA (parecer da Astra de 21/10/2026). Aditiva; precheck e
  // postcheck externos (padrão). A 087 é de outro trabalho local (avisos de assinatura por e-mail), ainda não integrado:
  // número livre numa leitura não é reserva. Validada só em PostgreSQL descartável local; nunca aplicada fora dele.
  '20261021_088_convite_ia_autorizacoes.sql',
  // 089: pedidos de cancelamento e devolução da assinatura, com protocolo (L1 do parecer da Astra, decisão de Felipe de
  // 21/10/2026). Aditiva; precheck e postcheck externos (padrão). Validada só em PostgreSQL descartável local; nunca
  // aplicada fora dele. Número livre numa leitura não é reserva (outro trabalho local pode disputar a 089).
  '20261021_089_assinatura_encerramentos.sql',
  // 090: campanha Fundador em duas fases (janela de 30 dias + lote de 20; plano CPF/Fundador de 22/10/2026).
  // Precheck e postcheck externos (padrão). Não cria nem ativa campanha. Validada só em PostgreSQL descartável local;
  // nunca aplicada fora dele. Número livre numa leitura local não é reserva global.
  '20261022_090_campanha_fundador.sql',
  // 091: documento fiscal CPF/CNPJ do contratante (plano CPF/Fundador de 22/10/2026). Só alarga CHECKs e acrescenta DV
  // para linhas novas (NOT VALID); não atualiza linhas. Independente da 090. Validada só em PostgreSQL descartável local;
  // nunca aplicada fora dele. Número livre numa leitura local não é reserva global.
  '20261022_091_documento_fiscal_contratante.sql',
  // 092: preço do pacote por quantidades cheias (tipo_calculo PONTO; decisão de Felipe de 22/10/2026). Aditiva; precheck
  // e postcheck externos (padrão). 090/091 citadas por outro plano local e a 087 por outro trabalho: número livre numa
  // leitura não é reserva. Validada só em PostgreSQL descartável local; nunca aplicada fora dele.
  '20261022_092_precos_por_quantidade.sql',
  // 093: configuração da agenda por unidade (etapa 2a; decisões de Felipe de 22/10/2026). Aditiva; precheck e postcheck
  // externos (padrão). Validada só em PostgreSQL descartável local; nunca aplicada fora dele.
  '20261022_093_agenda_configuracao_unidade.sql',
  // 094: capacidade, limite do dia e intervalo na regra de conflito (etapa 2b; decisões de Felipe de 22/10/2026). Troca o
  // corpo de três funções da 062 (manifesto da Festa com o conjunto 094). Validada só em PostgreSQL descartável local.
  '20261022_094_agenda_capacidade.sql',
  // 095: créditos de IA (Convites e Wall-e: carteiras, lotes, extrato imutável, compra avulsa, devolução e corte do
  // legado), implementação local de 22/10/2026. Aditiva; precheck e postcheck externos (padrão). Validada só em
  // PostgreSQL descartável local; nunca aplicada fora dele. Número livre na leitura de 22/10 (087 continua reservada aos
  // avisos de cobrança, fora deste repositório); livre numa leitura não é reserva.
  '20261022_095_ia_creditos.sql',
  // 096: comprovante da contratação e arquivo das versões dos documentos legais (grupo B do parecer de apoio, 22/10/2026).
  // Só cria tabelas novas; não altera linhas. Validada só em PostgreSQL descartável local; nunca aplicada fora dele.
  // 092–095 estão tomadas por outras frentes locais (agenda/preços e créditos IA). Número livre numa leitura local não é reserva global.
  '20261022_096_comprovante_contratacao.sql',
  // 097: manifestações do direito de arrependimento pela ferramenta (grupo C do parecer de apoio, 23/10/2026). Só cria
  // uma tabela nova; não altera linhas. Validada só em PostgreSQL descartável local; nunca aplicada fora dele.
  '20261023_097_assinatura_arrependimentos.sql',
  // 098: salão combinado ("salão inteiro"), fase 1 dos salões (proposta rev. 3 aprovada com ressalvas pelo Astra em
  // 23/10/2026). Troca o corpo de três funções da 094 (manifesto da Festa com o conjunto 098) e protege contratos contra
  // DELETE/TRUNCATE e troca de festa. 095–097 citadas por outros trabalhos locais; 098 conferida livre em 23/10 (clones,
  // refs e PRs abertas), o que não é reserva. Validada só em PostgreSQL descartável local; nunca aplicada fora dele.
  '20261023_098_saloes_combinados.sql',
  // 099: convites avulsos; schema deve preceder o código, sem backfill nem alteração de créditos.
  '20261024_099_convites_avulsos.sql',
  // 100: agenda com um salão — uma festa por vez no horário POR_HORARIO, qualquer que seja a capacidade gravada (decisão
  // de Felipe e parecer do Astra, 25/10/2026). Troca só o corpo de kidmais094_conflito_ocupacao; exige o corpo da 094.
  '20261025_100_agenda_um_salao.sql',
];
// From 013 on each migration has database/checks/<date>_<id>_precheck.sql and _postcheck.sql,
// except these explicit, reviewed shapes (anything else falls back to the default and fails closed):
// - 049–051 carry their prechecks inline (DO $$ ... RAISE) and have no external check files;
// - 052 names its checks with the "financeiro" suffix;
// - 054 needs its immediate backfill between precheck and postcheck;
// - 055a–d, 058, 059, 060, 065, 080, 081 and 082 (WhatsApp atendimento: 065 kept, reserved by staging; the original
//   064/066/067 became 070/071/072, then 073/074/075 on 07/10 (staging took 070, another branch 071), then 076/077/078 on
//   09/10 (staging took 073, 074, 074a and 075), on 10/10 076/077 became 077a/077b while 078 was kept (staging took
//   076 cpf_por_empresa and 077 regras_pagamento_empresa), and on 11/10 077a/077b/078 became 080/081/082 (staging took
//   078 catalogo_buffet_por_empresa and 079 convite_recuperacao_manual; 080–082 stay after every migration of the
//   inventory, in list and file-name order). 080–082 are a provisional local choice, not a coordinated reservation:
//   a number being free in one reading is never a reservation across sessions)
//   carry the precheck inline and have an external postcheck.
const checkFiles = {
  '049': [], '050': [], '051': [],
  '052': ['20260927_052_financeiro_precheck.sql', '20260927_052_financeiro_postcheck.sql'],
  '054': ['20260928_054_precheck.sql', '20260928_054_backfill_imediato.sql', '20260928_054_postcheck.sql'],
  '055a': ['20260928_055a_postcheck.sql'], '055b': ['20260928_055b_postcheck.sql'],
  '055c': ['20260928_055c_postcheck.sql'], '055d': ['20260928_055d_postcheck.sql'],
  '058': ['20260929_058_postcheck.sql'],
  '059': ['20261001_059_postcheck.sql'],
  '060': ['20261001_060_postcheck.sql'],
  '065': ['20261004_065_postcheck.sql'],
  '080': ['20261011_080_postcheck.sql'],
  '081': ['20261011_081_postcheck.sql'],
  '082': ['20261011_082_postcheck.sql'],
};
const requiresExplicitAuthorization = ['055a', '055b', '055c', '055d', '056', '057', '058', '059', '060', '061', '062', '063', '064', '065', '066', '067', '068', '069', '070', '071', '072', '073', '074', '074a', '075', '076', '077', '078', '079', '080', '081', '082', '083', '084', '085', '086', '088', '089', '090', '091', '092', '093', '094', '095', '096', '097', '098', '099', '100'];
const idLabel = id => /^\d+$/.test(id) ? String(Number(id)) : id.replace(/^0+/, '');
const requiredChecks = file => {
  const id = file.split('_')[1];
  if (Object.hasOwn(checkFiles, id)) return checkFiles[id];
  return Number.parseInt(id, 10) >= 13 ? ['precheck', 'postcheck'].map(kind => file.split('_').slice(0, 2).join('_') + '_' + kind + '.sql') : [];
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
  r.pending.push('064_NOT_APPLIED_REQUIRES_EXPLICIT_AUTHORIZATION');
  r.pending.push('065_NOT_APPLIED_REQUIRES_EXPLICIT_AUTHORIZATION');
  r.pending.push('066_NOT_APPLIED_REQUIRES_EXPLICIT_AUTHORIZATION');
  r.pending.push('067_NOT_APPLIED_REQUIRES_EXPLICIT_AUTHORIZATION');
  r.pending.push('068_NOT_APPLIED_REQUIRES_EXPLICIT_AUTHORIZATION');
  r.pending.push('069_NOT_APPLIED_REQUIRES_EXPLICIT_AUTHORIZATION');
  r.pending.push('070_NOT_APPLIED_REQUIRES_EXPLICIT_AUTHORIZATION');
  r.pending.push('071_NOT_APPLIED_REQUIRES_EXPLICIT_AUTHORIZATION');
  r.pending.push('072_NOT_APPLIED_REQUIRES_EXPLICIT_AUTHORIZATION');
  r.pending.push('073_NOT_APPLIED_REQUIRES_EXPLICIT_AUTHORIZATION');
  for (const id of ['074', '074A', '075', '076', '077', '078']) r.pending.push(id + '_NOT_APPLIED_REQUIRES_EXPLICIT_AUTHORIZATION');
  r.pending.push('079_NOT_APPLIED_REQUIRES_EXPLICIT_AUTHORIZATION');
  for (const id of ['080', '081', '082', '083', '084', '085', '086', '088', '089', '090', '091', '092', '093', '094', '095', '096', '097', '098', '099', '100']) r.pending.push(id + '_NOT_APPLIED_REQUIRES_EXPLICIT_AUTHORIZATION');
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
