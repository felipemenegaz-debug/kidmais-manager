-- 076 — Unicidade do CPF canônico por empresa (PR-B2). PREPARADA, NÃO APLICADA.
-- Troca o índice global clientes_cpf_canonico_uk por (empresa, cpf). Não altera nem apaga linhas.
-- Legado sem empresa (empresa_id NULL) continua único entre si (COALESCE para o UUID nulo).
-- O código já funciona antes e depois: identidade e cadastro procuram o CPF só na empresa do endereço.
-- Aplicação exige autorização própria (staging e produção separadas), precheck e postcheck.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'clientes' AND column_name = 'empresa_id') THEN
    RAISE EXCEPTION '076 exige a 054 (clientes.empresa_id).';
  END IF;
  IF to_regclass('public.clientes_cpf_empresa_canonico_uk') IS NOT NULL THEN
    RAISE EXCEPTION '076 já aplicada.';
  END IF;
  IF to_regclass('public.clientes_cpf_canonico_uk') IS NULL THEN
    RAISE EXCEPTION '076: índice global clientes_cpf_canonico_uk ausente; estado inesperado.';
  END IF;
END $$;

-- Bloqueia escrita em clientes durante a troca (leituras seguem).
LOCK TABLE clientes IN SHARE ROW EXCLUSIVE MODE;

CREATE UNIQUE INDEX clientes_cpf_empresa_canonico_uk
  ON clientes (COALESCE(empresa_id, '00000000-0000-0000-0000-000000000000'::uuid), cpf)
  WHERE cpf IS NOT NULL AND status <> 'MESCLADO';

DROP INDEX clientes_cpf_canonico_uk;

COMMIT;
