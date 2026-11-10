-- Rollback da 115 (índice (empresa_id, data_evento) em fechamentos; a subida removeu o 054). NÃO EXECUTAR sem autorização
-- explícita (docs/OPERACAO_AGENTES.md).
--
-- Recria o fechamentos_054_empresa_idx exatamente como a 054 (btree (empresa_id) WHERE empresa_id IS NOT NULL) e só
-- depois remove o índice da 115: nunca fica sem caminho por empresa_id. Nenhuma linha se perde. Índices ausentes: não faz
-- nada (054 presente e 115 ausente = estado anterior à 115). Objeto homônimo que não seja exatamente o índice da 115, ou
-- 054 presente com outra definição ou inválido: recusa sem alterar. Mesmos limites operacionais da subida (transação,
-- lock_timeout 5 s por espera de lock, statement_timeout 60 s por instrução, não pela transação). A criação do 054
-- bloqueia escritas; o DROP INDEX do 115 pede ACCESS EXCLUSIVE e bloqueia também LEITURAS de fechamentos até o COMMIT
-- (PS4-R4-C3).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;

DO $$ BEGIN
  IF to_regclass('public.fechamentos_115_empresa_data_idx') IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_am am ON am.oid = c.relam
       WHERE c.oid = to_regclass('public.fechamentos_115_empresa_data_idx') AND n.nspname = 'public' AND c.relkind = 'i'
         AND i.indrelid = 'public.fechamentos'::regclass AND am.amname = 'btree'
         AND NOT i.indisunique AND i.indnatts = 2 AND i.indnkeyatts = 2 AND i.indexprs IS NULL AND i.indpred IS NULL
         -- int2vector é indexado a partir de 0: compara elemento a elemento (a igualdade de arrays exige os mesmos limites)
         AND i.indkey[0] = (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.fechamentos'::regclass AND attname = 'empresa_id')
         AND i.indkey[1] = (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.fechamentos'::regclass AND attname = 'data_evento')
         AND i.indoption[0] = 0 AND i.indoption[1] = 0
         AND NOT EXISTS (SELECT 1 FROM unnest(i.indclass::oid[]) k(opc) JOIN pg_opclass o ON o.oid = k.opc WHERE NOT o.opcdefault)) THEN
    RAISE EXCEPTION '115 down: fechamentos_115_empresa_data_idx não é o índice da 115; nada foi removido.';
  END IF;
  IF to_regclass('public.fechamentos_054_empresa_idx') IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_am am ON am.oid = c.relam
       WHERE c.oid = to_regclass('public.fechamentos_054_empresa_idx') AND n.nspname = 'public' AND c.relkind = 'i'
         AND i.indrelid = 'public.fechamentos'::regclass AND am.amname = 'btree'
         AND NOT i.indisunique AND i.indisvalid AND i.indisready AND i.indislive
         AND i.indnatts = 1 AND i.indnkeyatts = 1 AND i.indexprs IS NULL
         AND i.indkey[0] = (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.fechamentos'::regclass AND attname = 'empresa_id')
         AND i.indoption[0] = 0
         AND pg_get_expr(i.indpred, i.indrelid) = '(empresa_id IS NOT NULL)'
         AND NOT EXISTS (SELECT 1 FROM unnest(i.indclass::oid[]) k(opc) JOIN pg_opclass o ON o.oid = k.opc WHERE NOT o.opcdefault)) THEN
    RAISE EXCEPTION '115 down: fechamentos_054_empresa_idx existe com outra definição ou inválido; nada foi alterado.';
  END IF;
  IF to_regclass('public.fechamentos_115_empresa_data_idx') IS NULL THEN
    RAISE NOTICE '115 down: índice da 115 ausente; só garante o 054.';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS fechamentos_054_empresa_idx ON public.fechamentos (empresa_id) WHERE empresa_id IS NOT NULL;

DROP INDEX IF EXISTS public.fechamentos_115_empresa_data_idx;

COMMIT;
