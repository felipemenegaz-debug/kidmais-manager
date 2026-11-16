-- 124 postcheck PREPARADO, NÃO EXECUTADO. Somente leitura. Confere tabela, constraints validadas, gatilhos ligados no
-- formato da 124, corpos iguais ao manifesto da 124 e nenhuma linha fora da regra.
BEGIN TRANSACTION READ ONLY;
SET LOCAL search_path = public, pg_catalog;
DO $$
DECLARE
  etapa text := 'postcheck';
  f text[];
  c text;
  g text[];
BEGIN
  IF to_regclass('public.contrato_assinaturas_papel') IS NULL THEN RAISE EXCEPTION '124 postcheck: tabela ausente'; END IF;
  FOREACH c IN ARRAY ARRAY['contrato_assinaturas_papel_versao_uk', 'contrato_assinaturas_papel_chave_uk', 'contrato_assinaturas_papel_versao_fk',
      'contrato_assinaturas_papel_arquivo_completo_ck', 'contrato_assinaturas_papel_arquivo_tipo_ck', 'contrato_assinaturas_papel_arquivo_tamanho_ck',
      'contrato_assinaturas_papel_arquivo_sha_ck'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.contrato_assinaturas_papel'::regclass AND conname = c AND convalidated) THEN
      RAISE EXCEPTION '124 postcheck: constraint % ausente ou não validada', c;
    END IF;
  END LOOP;
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.contrato_versoes'::regclass AND conname = 'contrato_versoes_aceite_metodo_check' AND convalidated)
     IS DISTINCT FROM 'CHECK (((aceite_metodo IS NULL) OR ((aceite_metodo)::text = ANY ((ARRAY[''OTP''::character varying, ''CONFERENCIA_PAPEL''::character varying, ''PAPEL_CLIENTE''::character varying])::text[]))))' THEN
    RAISE EXCEPTION '124 postcheck: CHECK de método de aceite fora do formato da 124';
  END IF;
  -- [nome, tgtype, diferido, função]. tgtype: 7 = ROW BEFORE INSERT; 27 = ROW BEFORE UPDATE OR DELETE;
  -- 34 = STATEMENT BEFORE TRUNCATE; 5 = ROW AFTER INSERT.
  FOREACH g SLICE 1 IN ARRAY ARRAY[
      ['contrato_assinaturas_papel_validar_registro_trg', '7', 'f', 'kidmais124_validar_registro_papel'],
      ['contrato_assinaturas_papel_imutavel_trg', '27', 'f', 'kidmais124_imutavel'],
      ['contrato_assinaturas_papel_truncate_trg', '34', 'f', 'kidmais124_imutavel'],
      ['contrato_assinaturas_papel_validar_fluxo_trg', '5', 't', 'kidmais_validar_fluxo_contrato']] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
                    WHERE t.tgrelid = 'public.contrato_assinaturas_papel'::regclass AND t.tgname = g[1] AND NOT t.tgisinternal
                      AND t.tgenabled = 'O' AND t.tgtype = g[2]::int AND t.tgdeferrable = (g[3] = 't') AND t.tginitdeferred = (g[3] = 't')
                      AND p.proname = g[4]) THEN
      RAISE EXCEPTION '124 postcheck: gatilho % ausente, desligado ou fora do formato', g[1];
    END IF;
  END LOOP;
  FOREACH f SLICE 1 IN ARRAY ARRAY[
      ['public.kidmais_validar_fluxo_contrato()', '7efdbe0d338b9f6a5f8320a373fbc958f5f3998fef792222bdceebfb2d1d5eb5'],
      ['public.kidmais019_formalizacao(uuid,uuid)', '6a6f9c4ae2be1563d3a097f1bdaf99332ea32cbbc417ea1145ff67d4447e8ceb'],
      ['public.kidmais124_instante_civil(date)', '82b0fff9548fc938db8da45369f85f87908eeabe2db73e57fe5ad91274473496'],
      ['public.kidmais124_validar_registro_papel()', 'd431bfcd86697f76cfb612d28f25971b60437ea17209e085e5ab143122d28afb'],
      ['public.kidmais124_imutavel()', 'f180c2d918b468f1c52ef1671f27853732ebcb2f83e0950a3c0acee3d5a632b5'],
      ['public.kidmais124_papel_cliente(uuid,uuid)', 'e2f3d094746c027aab0831d4f5c128b03535e51615c53065e3f2fef8fcd81666']] LOOP
    IF to_regprocedure(f[1]) IS NULL OR (SELECT encode(sha256(convert_to(replace(prosrc, E'\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = to_regprocedure(f[1])) IS DISTINCT FROM f[2] THEN
      RAISE EXCEPTION '124 %: função % ausente ou divergente da 124', etapa, f[1];
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM public.contrato_versoes v WHERE v.aceite_metodo = 'PAPEL_CLIENTE'
              AND NOT EXISTS (SELECT 1 FROM public.contrato_assinaturas_papel p WHERE p.contrato_versao_id = v.id))
     -- Integridade HISTÓRICA do registro (achado do Astra): não depende de o contrato seguir ativo nem de a V1 seguir
     -- vigente. Cancelamento posterior e sucessão por V2 não invalidam a evidência; por isso não usa kidmais124_papel_cliente
     -- (que é a elegibilidade atual para formalizar).
     OR EXISTS (SELECT 1 FROM public.contrato_assinaturas_papel p
                  JOIN public.contrato_versoes v ON v.id = p.contrato_versao_id
                  JOIN public.contratos c ON c.id = v.contrato_id
                  JOIN public.fechamentos fe ON fe.id = c.fechamento_id
                  LEFT JOIN public.contrato_edicoes e ON e.contrato_versao_id = v.id
                 WHERE v.aceite_metodo IS DISTINCT FROM 'PAPEL_CLIENTE' OR v.status IS DISTINCT FROM 'ASSINADA' OR v.numero_versao <> 1
                    OR p.contrato_id IS DISTINCT FROM v.contrato_id OR p.empresa_id IS DISTINCT FROM fe.empresa_id
                    OR e.contrato_versao_id IS NULL OR e.tipo IS DISTINCT FROM 'INICIAL' OR e.estado IS DISTINCT FROM 'CONCLUIDA' OR e.liberado_em IS NULL
                    OR p.data_declarada < (e.liberado_em AT TIME ZONE 'America/Sao_Paulo')::date
                    OR p.data_declarada > (p.registrado_em AT TIME ZONE 'America/Sao_Paulo')::date
                    OR v.assinado_em IS DISTINCT FROM public.kidmais124_instante_civil(p.data_declarada)
                    OR v.documento_template_versao IS NULL
                    OR (p.arquivo IS NOT NULL AND encode(sha256(p.arquivo), 'hex') IS DISTINCT FROM p.arquivo_sha256)
                    OR NOT EXISTS (SELECT 1 FROM public.contrato_assinaturas k WHERE k.contrato_versao_id = v.id AND k.parte = 'KIDMAIS' AND k.pdf_hash = v.documento_pdf_hash)
                    OR EXISTS (SELECT 1 FROM public.contrato_assinaturas k WHERE k.contrato_versao_id = v.id AND k.parte = 'CLIENTE')) THEN
    RAISE EXCEPTION '124 postcheck: versão PAPEL_CLIENTE sem registro, ou registro fora da regra';
  END IF;
END $$;
SELECT current_database() AS banco, true AS aprovado;
ROLLBACK;
