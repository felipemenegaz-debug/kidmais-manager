-- Somente leitura. Confirma o schema de Convites (073, chave composta de convites) e que a 088 ainda não foi aplicada.
DO $$
BEGIN
  IF to_regclass('public.convites') IS NULL OR to_regclass('public.festas') IS NULL OR to_regclass('public.memberships') IS NULL
    OR to_regclass('public.usuarios_administrativos') IS NULL OR to_regclass('public.clientes') IS NULL THEN
    RAISE EXCEPTION '088 precheck: convites, festas, memberships, usuarios_administrativos ou clientes ausente';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.convites'::regclass AND contype='u'
      AND conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='public.convites'::regclass AND attname='id'),
                         (SELECT attnum FROM pg_attribute WHERE attrelid='public.convites'::regclass AND attname='empresa_id')]::int2[]) THEN
    RAISE EXCEPTION '088 precheck: convites sem UNIQUE (id, empresa_id) da 073';
  END IF;
  IF to_regclass('public.convite_ia_autorizacoes') IS NOT NULL OR to_regclass('public.convite_ia_autorizacao_vigente') IS NOT NULL
    OR to_regclass('public.convite_ia_autorizacoes_empresa') IS NOT NULL OR to_regprocedure('public.convite_ia_autorizacao_validar()') IS NOT NULL THEN
    RAISE EXCEPTION '088 precheck: aplicação anterior ou parcial encontrada';
  END IF;
  RAISE NOTICE '088 precheck OK';
END $$;
-- Contagem informativa (sem ids nem dados pessoais): convites que passarão a pedir autorização antes da próxima geração.
SELECT count(*) AS convites, count(*) FILTER (WHERE EXISTS (SELECT 1 FROM convite_geracoes g WHERE g.convite_id = c.id)) AS com_geracao
  FROM convites c;
