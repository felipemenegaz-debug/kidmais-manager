-- Precheck da 084 (Marketing): somente leitura. Confirma dependências e que nada da 084 existe.
BEGIN TRANSACTION READ ONLY;
SELECT
  to_regclass('public.empresas') IS NOT NULL AS tem_empresas,
  to_regclass('public.estabelecimentos') IS NOT NULL AS tem_estabelecimentos,
  to_regclass('public.memberships') IS NOT NULL AS tem_memberships,
  EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.clientes'::regclass AND attname = 'empresa_id' AND NOT attisdropped) AS clientes_tem_empresa_054,
  EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.fechamentos'::regclass AND attname = 'estabelecimento_id' AND NOT attisdropped) AS fechamentos_tem_unidade_062,
  to_regclass('public.marketing_campanhas') IS NULL AND to_regclass('public.marketing_sites') IS NULL
    AND to_regclass('public.marketing_atribuicoes') IS NULL AND to_regclass('public.marketing_contatos') IS NULL AS marketing_ausente;
ROLLBACK;
