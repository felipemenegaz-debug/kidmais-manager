-- Retrato restrito da 107/108 (somente leitura; plano E4, E4-3; P2-E4-R2-1). GERADO por scripts/migration-108-retrato.cjs
-- a partir do inventário congelado (scripts/migration-108-inventario.cjs); o teste confere este arquivo byte a byte.
-- Sessão: o chamador fixa `SET LOCAL search_path = pg_catalog` (pg_get_*def qualifica public; texto sem normalização), numa
-- transação READ ONLY; ordenação COLLATE "C"; PostgreSQL versão maior 18. A mesma consulta serve às três fases
-- (F0 pré-107, F1 pós-107/pré-108, F2 pós-108); a fase só escolhe o hash esperado em
-- database/checks/20261029_108_retratos_esperados.json (A_MEDIR_NO_CLUSTER = sem comparação, recusa).
-- Escopo: 63 funções, 11 tabelas com estrutura completa (colunas, constraints c/f/p/u/x,
-- índices, gatilhos) e 32 tabelas lidas (só colunas). NOT NULL vai por attnotnull (as constraints 'n' do
-- PostgreSQL 18 têm nome gerado e ficam fora). Corpos só por sha256 (sem CR); nenhuma função do escopo é executada.
SELECT
-- RETRATO_108_INICIO
(SELECT jsonb_build_object(
  'funcoes', (SELECT coalesce(jsonb_agg(jsonb_build_array(p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')',
                encode(sha256(convert_to(replace(p.prosrc, E'\r', ''), 'UTF8')), 'hex'), l.lanname, p.provolatile, p.prosecdef, p.proisstrict,
                p.proleakproof, p.proparallel, coalesce(array_to_string(p.proconfig, ';'), ''),
                pg_catalog.pg_get_function_result(p.oid), CASE WHEN p.proowner = (SELECT o.relowner FROM pg_catalog.pg_class o WHERE o.oid = pg_catalog.to_regclass('public.agenda_saloes')) THEN 'DONO_AGENDA_SALOES' ELSE pg_catalog.pg_get_userbyid(p.proowner)::text END,
                CASE WHEN p.proacl IS NULL THEN to_jsonb('PADRAO'::text) ELSE (SELECT coalesce(jsonb_agg(jsonb_build_array(CASE WHEN a.grantee = 0 THEN 'PUBLIC' WHEN a.grantee = p.proowner THEN 'DONO' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END, CASE WHEN a.grantor = 0 THEN 'PUBLIC' WHEN a.grantor = p.proowner THEN 'DONO' ELSE pg_catalog.pg_get_userbyid(a.grantor)::text END,
                  a.privilege_type, a.is_grantable) ORDER BY CASE WHEN a.grantee = 0 THEN 'PUBLIC' WHEN a.grantee = p.proowner THEN 'DONO' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END COLLATE "C", a.privilege_type COLLATE "C", CASE WHEN a.grantor = 0 THEN 'PUBLIC' WHEN a.grantor = p.proowner THEN 'DONO' ELSE pg_catalog.pg_get_userbyid(a.grantor)::text END COLLATE "C"), '[]'::jsonb)
                  FROM pg_catalog.aclexplode(p.proacl) a) END)
                ORDER BY p.proname COLLATE "C", pg_catalog.pg_get_function_identity_arguments(p.oid) COLLATE "C"), '[]'::jsonb)
     FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace JOIN pg_catalog.pg_language l ON l.oid = p.prolang
     WHERE n.nspname = 'public' AND p.proname IN ('festa016_invalidacao', 'kidmais019_bloquear_contrato', 'kidmais019_formalizacao', 'kidmais019_lock_ocupacao',
                'kidmais019_ocupa', 'kidmais019_proteger_invalidacao', 'kidmais019_validar_contrato', 'kidmais061_conferencia_historica',
                'kidmais061_exigir_vinculo', 'kidmais061_historico_passado', 'kidmais061_origem_fechamento',
                'kidmais062_bloqueio_aplica', 'kidmais062_fluxo_unidade', 'kidmais062_mesmo_recurso', 'kidmais062_ocupacoes_escopo',
                'kidmais062_revisao_unidade', 'kidmais062_travar_habilitacao', 'kidmais062_unidade_agendavel',
                'kidmais062_unidade_ativa', 'kidmais062_unidade_fechamento', 'kidmais093_mesma_empresa', 'kidmais094_conflito_ocupacao',
                'kidmais094_ocupacoes', 'kidmais094_salao_fechamento', 'kidmais094_salao_revisao', 'kidmais098_combinado_validar',
                'kidmais098_conjunto', 'kidmais098_contrato_guarda', 'kidmais098_hoje', 'kidmais098_membros_canonicos',
                'kidmais098_proibir_truncate', 'kidmais098_salao_elegivel', 'kidmais098_salao_guarda', 'kidmais098_saloes_cruzam',
                'kidmais098_validar_elegibilidade', 'kidmais102_exclusivos_validos', 'kidmais102_salao_conteudo',
                'kidmais104_hash_versao_imutavel', 'kidmais106_salao_escopo_referenciado', 'kidmais106_salao_preferido_escopo',
                'kidmais108_instalada', 'kidmais_053_empresa_comercial', 'kidmais_053_empresa_do_fechamento', 'kidmais_053_fechamento',
                'kidmais_053_fechamento_filhos', 'kidmais_053_inexistente', 'kidmais_053_recusar', 'kidmais_053_revisao',
                'kidmais_053_revisao_filhos', 'kidmais_054_empresa_imutavel', 'kidmais_054_fechamento_cliente_coerente',
                'kidmais_054_fechamento_empresa_coerente', 'kidmais_054_revisao_cliente_coerente',
                'kidmais_057_pode_assinar_pela_empresa', 'kidmais_hash_revisao_operacional', 'kidmais_lock_datas_revisao',
                'kidmais_preservar_revisao_operacional', 'kidmais_proteger_bloqueio_revisao', 'kidmais_proteger_fechamento_em_revisao',
                'kidmais_set_atualizado_em', 'kidmais_validar_agenda_revisao', 'kidmais_validar_fluxo_contrato',
                'kidmais_validar_revisao_operacional')),
  'presenca_funcoes', (SELECT jsonb_agg(jsonb_build_array(e.nome, (SELECT count(*) FROM pg_catalog.pg_proc p
                WHERE p.pronamespace = 'public'::regnamespace AND p.proname = e.nome)) ORDER BY e.nome COLLATE "C")
     FROM unnest(ARRAY['festa016_invalidacao', 'kidmais019_bloquear_contrato', 'kidmais019_formalizacao', 'kidmais019_lock_ocupacao',
                'kidmais019_ocupa', 'kidmais019_proteger_invalidacao', 'kidmais019_validar_contrato', 'kidmais061_conferencia_historica',
                'kidmais061_exigir_vinculo', 'kidmais061_historico_passado', 'kidmais061_origem_fechamento',
                'kidmais062_bloqueio_aplica', 'kidmais062_fluxo_unidade', 'kidmais062_mesmo_recurso', 'kidmais062_ocupacoes_escopo',
                'kidmais062_revisao_unidade', 'kidmais062_travar_habilitacao', 'kidmais062_unidade_agendavel',
                'kidmais062_unidade_ativa', 'kidmais062_unidade_fechamento', 'kidmais093_mesma_empresa', 'kidmais094_conflito_ocupacao',
                'kidmais094_ocupacoes', 'kidmais094_salao_fechamento', 'kidmais094_salao_revisao', 'kidmais098_combinado_validar',
                'kidmais098_conjunto', 'kidmais098_contrato_guarda', 'kidmais098_hoje', 'kidmais098_membros_canonicos',
                'kidmais098_proibir_truncate', 'kidmais098_salao_elegivel', 'kidmais098_salao_guarda', 'kidmais098_saloes_cruzam',
                'kidmais098_validar_elegibilidade', 'kidmais102_exclusivos_validos', 'kidmais102_salao_conteudo',
                'kidmais104_hash_versao_imutavel', 'kidmais106_salao_escopo_referenciado', 'kidmais106_salao_preferido_escopo',
                'kidmais108_instalada', 'kidmais_053_empresa_comercial', 'kidmais_053_empresa_do_fechamento', 'kidmais_053_fechamento',
                'kidmais_053_fechamento_filhos', 'kidmais_053_inexistente', 'kidmais_053_recusar', 'kidmais_053_revisao',
                'kidmais_053_revisao_filhos', 'kidmais_054_empresa_imutavel', 'kidmais_054_fechamento_cliente_coerente',
                'kidmais_054_fechamento_empresa_coerente', 'kidmais_054_revisao_cliente_coerente',
                'kidmais_057_pode_assinar_pela_empresa', 'kidmais_hash_revisao_operacional', 'kidmais_lock_datas_revisao',
                'kidmais_preservar_revisao_operacional', 'kidmais_proteger_bloqueio_revisao', 'kidmais_proteger_fechamento_em_revisao',
                'kidmais_set_atualizado_em', 'kidmais_validar_agenda_revisao', 'kidmais_validar_fluxo_contrato',
                'kidmais_validar_revisao_operacional']::text[]) AS e(nome)),
  'relacoes', (SELECT jsonb_agg(jsonb_build_array(e.nome, c.relkind, CASE WHEN c.oid IS NULL THEN NULL ELSE CASE WHEN c.relowner = (SELECT o.relowner FROM pg_catalog.pg_class o WHERE o.oid = pg_catalog.to_regclass('public.agenda_saloes')) THEN 'DONO_AGENDA_SALOES' ELSE pg_catalog.pg_get_userbyid(c.relowner)::text END END,
                c.relrowsecurity, c.relforcerowsecurity) ORDER BY e.nome COLLATE "C")
     FROM unnest(ARRAY['adicionais', 'agenda_062_unidades_habilitacao', 'agenda_escopo_config', 'agenda_saloes', 'aniversariantes',
                'aprovacoes_negociacao', 'bloqueios_agenda', 'clientes', 'configuracao_agenda', 'configuracao_agenda_saloes',
                'contrato_assinaturas', 'contrato_documentos', 'contrato_edicoes', 'contrato_fluxos', 'contrato_importacao_financeiro',
                'contrato_importacoes', 'contrato_versoes', 'contratos', 'empresa_membership_capacidades', 'empresas',
                'estabelecimentos', 'fechamento_adicionais', 'fechamento_revisao_adicionais', 'fechamento_revisoes', 'fechamentos',
                'festa_buffet', 'festa_contagens_convidados', 'festa_eventos', 'festa_pendencias', 'festa_solicitacoes', 'festa_tarefas',
                'festas', 'kidmais107_reparos', 'memberships', 'pacotes', 'precos_adicional', 'precos_pacote', 'regras_desconto_pacote',
                'responsaveis_adicionais', 'sessoes_administrativas', 'tabelas_preco', 'usuarios_administrativos',
                'validacoes_identidade_cliente']::text[]) AS e(nome)
     LEFT JOIN pg_catalog.pg_class c ON c.oid = pg_catalog.to_regclass('public.' || e.nome)),
  'colunas', (SELECT coalesce(jsonb_agg(jsonb_build_array(c.relname, a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull,
                coalesce(pg_catalog.pg_get_expr(d.adbin, d.adrelid), ''), a.attidentity, a.attgenerated)
                ORDER BY c.relname COLLATE "C", a.attname COLLATE "C"), '[]'::jsonb)
     FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE n.nspname = 'public' AND a.attnum > 0 AND NOT a.attisdropped
       AND c.relname IN ('adicionais', 'agenda_062_unidades_habilitacao', 'agenda_escopo_config', 'agenda_saloes', 'aniversariantes',
                'aprovacoes_negociacao', 'bloqueios_agenda', 'clientes', 'configuracao_agenda', 'configuracao_agenda_saloes',
                'contrato_assinaturas', 'contrato_documentos', 'contrato_edicoes', 'contrato_fluxos', 'contrato_importacao_financeiro',
                'contrato_importacoes', 'contrato_versoes', 'contratos', 'empresa_membership_capacidades', 'empresas',
                'estabelecimentos', 'fechamento_adicionais', 'fechamento_revisao_adicionais', 'fechamento_revisoes', 'fechamentos',
                'festa_buffet', 'festa_contagens_convidados', 'festa_eventos', 'festa_pendencias', 'festa_solicitacoes', 'festa_tarefas',
                'festas', 'kidmais107_reparos', 'memberships', 'pacotes', 'precos_adicional', 'precos_pacote', 'regras_desconto_pacote',
                'responsaveis_adicionais', 'sessoes_administrativas', 'tabelas_preco', 'usuarios_administrativos',
                'validacoes_identidade_cliente')),
  'constraints', (SELECT coalesce(jsonb_agg(jsonb_build_array(c.relname, k.conname, k.contype, pg_catalog.pg_get_constraintdef(k.oid),
                k.convalidated, k.condeferrable, k.condeferred, k.connoinherit) ORDER BY c.relname COLLATE "C", k.conname COLLATE "C"), '[]'::jsonb)
     FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_class c ON c.oid = k.conrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND k.contype IN ('c', 'f', 'p', 'u', 'x')
       AND c.relname IN ('agenda_escopo_config', 'agenda_saloes', 'bloqueios_agenda', 'configuracao_agenda', 'configuracao_agenda_saloes',
                'contrato_fluxos', 'contratos', 'fechamento_revisoes', 'fechamentos', 'festas', 'kidmais107_reparos')),
  'indices', (SELECT coalesce(jsonb_agg(jsonb_build_array(tc.relname, ic.relname, pg_catalog.pg_get_indexdef(i.indexrelid),
                i.indisunique, i.indisprimary, i.indisvalid, i.indisready, i.indimmediate) ORDER BY tc.relname COLLATE "C", ic.relname COLLATE "C"), '[]'::jsonb)
     FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid JOIN pg_catalog.pg_class tc ON tc.oid = i.indrelid
     JOIN pg_catalog.pg_namespace n ON n.oid = tc.relnamespace
     WHERE n.nspname = 'public' AND tc.relname IN ('agenda_escopo_config', 'agenda_saloes', 'bloqueios_agenda', 'configuracao_agenda', 'configuracao_agenda_saloes',
                'contrato_fluxos', 'contratos', 'fechamento_revisoes', 'fechamentos', 'festas', 'kidmais107_reparos')),
  'gatilhos', (SELECT coalesce(jsonb_agg(jsonb_build_array(c.relname, g.tgname, g.tgtype, g.tgfoid::regprocedure::text, g.tgenabled,
                g.tgdeferrable, g.tginitdeferred, g.tgnargs, (SELECT coalesce(jsonb_agg(x.attname ORDER BY x.attname COLLATE "C"), '[]'::jsonb)
                  FROM pg_catalog.pg_attribute x WHERE x.attrelid = g.tgrelid AND x.attnum = ANY (g.tgattr::int2[])),
                pg_catalog.pg_get_triggerdef(g.oid)) ORDER BY c.relname COLLATE "C", g.tgname COLLATE "C"), '[]'::jsonb)
     FROM pg_catalog.pg_trigger g JOIN pg_catalog.pg_class c ON c.oid = g.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE NOT g.tgisinternal AND n.nspname = 'public'
       AND c.relname IN ('agenda_escopo_config', 'agenda_saloes', 'bloqueios_agenda', 'configuracao_agenda', 'configuracao_agenda_saloes',
                'contrato_fluxos', 'contratos', 'fechamento_revisoes', 'fechamentos', 'festas', 'kidmais107_reparos')),
  'marcador_108', (SELECT encode(sha256(convert_to(replace(p.prosrc, E'\r', ''), 'UTF8')), 'hex') FROM pg_catalog.pg_proc p
     WHERE p.oid = pg_catalog.to_regprocedure('public.kidmais108_instalada()'))
))
-- RETRATO_108_FIM
  AS retrato_108;
