-- 020 precheck: read-only and fail-closed. No migration ledger exists.
-- B2 must approve the executor as interim owner and supply a complete
-- saas020.runtime_roles session setting. Record the v1_pre_hash output and
-- supply it as saas020.v1_pre_hash to the UP/postcheck in the same change window.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, public;
DO $pre$
DECLARE runtime_names text := nullif(current_setting('saas020.runtime_roles', true), '');
        r text;
BEGIN
  IF current_setting('server_version_num')::integer NOT BETWEEN 180006 AND 189999 THEN
    RAISE EXCEPTION '020 precheck: PostgreSQL 18.6+ required' USING ERRCODE='55000'; END IF;
  IF (SELECT array_agg(c.relname ORDER BY c.relname)
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind='r') IS DISTINCT FROM ARRAY[
      'adicionais','aniversariantes','aprovacoes_negociacao','auditoria','bloqueios_agenda',
      'clientes','configuracao_agenda','contrato_assinaturas','contrato_documentos',
      'contrato_edicoes','contrato_fluxos','contrato_pendencias_financeiras',
      'contrato_versoes','contratos','eventos_historico_cliente','fechamento_adicionais',
      'fechamento_revisao_adicionais','fechamento_revisoes','fechamentos','festa_areas',
      'festa_buffet','festa_contagens_convidados','festa_eventos','festa_pendencias',
      'festa_solicitacoes','festa_tarefas','festa_usuario_capacidades','festas',
      'limites_autenticacao','mesclagens_clientes','pacotes','pagamento_ajuste_bases',
      'pagamento_ajustes_contratuais','pagamento_comprovantes','pagamento_credito_reservas',
      'pagamento_cronograma_itens','pagamento_cronogramas','pagamento_devolucao_alocacoes',
      'pagamento_devolucao_comprovantes','pagamento_devolucoes','pagamento_estornos',
      'pagamento_eventos','pagamento_gestoes','pagamento_movimentos_contextos',
      'pagamento_parcelas','pagamento_planos','pagamento_recebimento_alocacoes',
      'pagamento_recebimentos','pagamento_tratamentos','pagamentos',
      'possiveis_duplicidades_cliente','precos_adicional','precos_pacote',
      'regras_categoria_horario','regras_desconto_pacote','regras_disponibilidade_pacote',
      'responsaveis_adicionais','sessoes_administrativas','tabelas_preco',
      'usuarios_administrativos','validacoes_identidade_cliente',
      'whatsapp_conexoes','whatsapp_onboarding_tentativas']::name[] THEN
    RAISE EXCEPTION '020 precheck: 63-table V1 identity differs' USING ERRCODE='55000';
  END IF;
  IF to_regprocedure('pg_catalog.gen_random_uuid()') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname='pgcrypto')
     OR NOT EXISTS (
       SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='id'
       JOIN pg_constraint k ON k.conrelid=c.oid AND k.contype='p' AND a.attnum=ANY(k.conkey)
       WHERE n.nspname='public' AND c.relname='usuarios_administrativos'
         AND c.relkind='r' AND a.atttypid='uuid'::regtype AND a.attnotnull)
     OR to_regclass('public.whatsapp_conexoes') IS NULL
     OR to_regclass('public.whatsapp_onboarding_tentativas') IS NULL
     OR to_regclass('public.festas') IS NULL OR to_regclass('public.festa_eventos') IS NULL
     OR to_regclass('public.precos_pacote') IS NULL THEN
    RAISE EXCEPTION '020 precheck: 001/006a/013/016/018 objects missing' USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='kidmais019_ocupa'
        AND oidvectortypes(p.proargtypes)='uuid' AND NOT p.prosecdef
        AND encode(sha256(convert_to(replace(p.prosrc,E'\r',''),'UTF8')),'hex')=
            '87131946b52479651484ec9076ce264243e79867ab2bc1f02447c6a2eb0599a3')
     OR NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='kidmais_ocupacoes_operacionais'
        AND oidvectortypes(p.proargtypes)='date, date' AND NOT p.prosecdef
        AND encode(sha256(convert_to(replace(p.prosrc,E'\r',''),'UTF8')),'hex')=
            '2257c1df5a299a86d60a59b8606e432715dd10d713e4659f370934dcf483be91') THEN
    RAISE EXCEPTION '020 precheck: 019 physical function signature differs' USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS (
      SELECT 1 FROM public.regras_disponibilidade_pacote r
      JOIN public.pacotes p ON p.id=r.pacote_id AND p.codigo='POCKET'
      JOIN public.configuracao_agenda a ON a.id=r.configuracao_agenda_id AND a.codigo='TURNO_1'
      WHERE r.dia_semana=5 AND r.ativo AND r.vigencia_inicio=DATE '2026-09-12'
        AND r.vigencia_fim IS NULL AND r.estado='DISPONIVEL') THEN
    RAISE EXCEPTION '020 precheck: 017 effect absent' USING ERRCODE='55000';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
              WHERE n.nspname='public' AND
                (c.relname IN ('empresas','estabelecimentos','memberships','membership_estabelecimentos')
                 OR left(c.relname,8)='saas020_'))
     OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                WHERE n.nspname='public' AND left(p.proname,8)='saas020_')
     OR EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_namespace n ON n.oid=k.connamespace
                WHERE n.nspname='public' AND left(k.conname,8)='saas020_')
     OR EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
                JOIN pg_namespace n ON n.oid=c.relnamespace
                WHERE n.nspname='public' AND left(t.tgname,8)='saas020_') THEN
    RAISE EXCEPTION '020 precheck: existing/partial 020 object or name collision' USING ERRCODE='55000';
  END IF;
  IF runtime_names IS NULL THEN
    RAISE EXCEPTION '020 precheck: approved executor and runtime inventory required' USING ERRCODE='42501';
  END IF;
  FOREACH r IN ARRAY string_to_array(runtime_names,',') LOOP
    r := btrim(r);
    IF r='' OR r=current_user
       OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=r)
       OR pg_has_role(r,current_user,'MEMBER')
       OR has_schema_privilege(r,'public','CREATE') THEN
      RAISE EXCEPTION '020 precheck: runtime role inventory/privilege unsafe' USING ERRCODE='42501';
    END IF;
  END LOOP;
  IF EXISTS (
     SELECT 1 FROM pg_default_acl d,
       LATERAL aclexplode(d.defaclacl) a
      WHERE d.defaclrole=(SELECT oid FROM pg_roles WHERE rolname=current_user)
       AND (d.defaclnamespace=0 OR d.defaclnamespace='public'::regnamespace)
       AND d.defaclobjtype IN ('r','f')
        AND a.grantee<>d.defaclrole
  ) THEN RAISE EXCEPTION '020 precheck: default ACL requires explicit review' USING ERRCODE='42501'; END IF;
END $pre$;

-- The comparative V1 projection intentionally excludes internal FK triggers on
-- usuarios_administrativos: the new membership FK adds only that inbound dependency.
WITH v1 AS (
  SELECT c.oid,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind='r'
), projection AS (
  SELECT v.relname,
    (SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),
       a.attnotnull,pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum)
     FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
     WHERE a.attrelid=v.oid AND a.attnum>0 AND NOT a.attisdropped) AS columns,
    (SELECT jsonb_agg(jsonb_build_array(k.conname,k.contype,pg_get_constraintdef(k.oid)) ORDER BY k.conname)
     FROM pg_constraint k WHERE k.conrelid=v.oid) AS constraints,
    (SELECT jsonb_agg(pg_get_indexdef(i.indexrelid) ORDER BY x.relname)
     FROM pg_index i JOIN pg_class x ON x.oid=i.indexrelid WHERE i.indrelid=v.oid) AS indexes,
    (SELECT jsonb_agg(pg_get_triggerdef(t.oid) ORDER BY t.tgname)
     FROM pg_trigger t WHERE t.tgrelid=v.oid AND NOT t.tgisinternal) AS triggers
  FROM v1 v
)
SELECT encode(sha256(convert_to(jsonb_agg(to_jsonb(projection) ORDER BY relname)::text,'UTF8')),'hex')
       AS v1_pre_hash FROM projection;
COMMIT;
