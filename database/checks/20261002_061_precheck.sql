-- 061 precheck (somente leitura): pré-requisitos, não aplicada, corpos substituídos iguais aos da 019/057 e relatório
-- do que a migration NÃO faz (nenhuma importação é integrada automaticamente).
DO $$
DECLARE
  importadas integer;
BEGIN
  IF to_regclass('public.ia_importacoes') IS NULL OR to_regclass('public.ia_documento_originais') IS NULL THEN
    RAISE EXCEPTION '061 precheck: 055c/055d não aplicadas.';
  END IF;
  IF to_regclass('public.estabelecimentos') IS NULL OR to_regclass('public.empresa_membership_capacidades') IS NULL THEN
    RAISE EXCEPTION '061 precheck: 043/057 não aplicadas.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'fechamentos' AND column_name = 'empresa_id') THEN
    RAISE EXCEPTION '061 precheck: 054 não aplicada.';
  END IF;
  IF to_regclass('public.contrato_importacoes') IS NOT NULL THEN
    RAISE EXCEPTION '061 precheck: já aplicada.';
  END IF;
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public.kidmais_validar_fluxo_contrato()'::regprocedure) IS DISTINCT FROM 'e7d4d19ac1b1d925135adbc45a2247a5' THEN
    RAISE EXCEPTION '061 precheck: kidmais_validar_fluxo_contrato difere da 057.';
  END IF;
  IF (SELECT encode(sha256(convert_to(replace(prosrc, E'\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = 'public.kidmais019_formalizacao(uuid,uuid)'::regprocedure) IS DISTINCT FROM 'ef21416cd23e5a2d59c486abc83470ca47dc30a2ef8501b488d216c88804fa25'
     OR (SELECT encode(sha256(convert_to(replace(prosrc, E'\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = 'public.kidmais019_ocupa(uuid)'::regprocedure) IS DISTINCT FROM '87131946b52479651484ec9076ce264243e79867ab2bc1f02447c6a2eb0599a3'
     OR (SELECT encode(sha256(convert_to(replace(prosrc, E'\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = 'public.kidmais_ocupacoes_operacionais(date,date)'::regprocedure) IS DISTINCT FROM '2257c1df5a299a86d60a59b8606e432715dd10d713e4659f370934dcf483be91'
     OR (SELECT encode(sha256(convert_to(replace(prosrc, E'\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = 'public.kidmais_validar_agenda_revisao()'::regprocedure) IS DISTINCT FROM '997158485f6dc9595cf6045594b220206c59c31b631bc164aad3956963875e89' THEN
    RAISE EXCEPTION '061 precheck: formalização/ocupação/agenda diferem da 019.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.contrato_versoes WHERE aceite_metodo IS NOT NULL AND aceite_metodo <> 'OTP') THEN
    RAISE EXCEPTION '061 precheck: há versão com método de aceite desconhecido.';
  END IF;
  SELECT count(*) INTO importadas FROM public.ia_importacoes WHERE status = 'IMPORTADA';
  RAISE NOTICE '061 precheck: % importação(ões) confirmada(s) continuam como projeção; nenhuma é integrada pela migration.', importadas;
END $$;
SELECT '061 precheck OK' AS resultado;
