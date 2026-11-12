-- Precheck da 115 (índice (empresa_id, data_evento) em fechamentos): somente leitura. Exige as colunas e aceita o índice
-- ausente ou já presente e conforme (a subida é idempotente) e o 054 ausente ou igual ao da 054 (a subida o remove);
-- qualquer objeto homônimo de um dos dois com outra definição recusa.
BEGIN TRANSACTION READ ONLY;
DO $$ BEGIN
  IF to_regclass('public.fechamentos') IS NULL
     OR (SELECT format_type(atttypid, atttypmod) FROM pg_attribute WHERE attrelid = 'public.fechamentos'::regclass AND attname = 'empresa_id' AND NOT attisdropped) IS DISTINCT FROM 'uuid'
     OR (SELECT format_type(atttypid, atttypmod) FROM pg_attribute WHERE attrelid = 'public.fechamentos'::regclass AND attname = 'data_evento' AND NOT attisdropped) IS DISTINCT FROM 'date' THEN
    RAISE EXCEPTION 'precheck 115: fechamentos.empresa_id (uuid) e fechamentos.data_evento (date) são exigidos';
  END IF;
  IF to_regclass('public.fechamentos_115_empresa_data_idx') IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_am am ON am.oid = c.relam
       WHERE c.oid = to_regclass('public.fechamentos_115_empresa_data_idx') AND n.nspname = 'public' AND c.relkind = 'i'
         AND i.indrelid = 'public.fechamentos'::regclass AND am.amname = 'btree'
         AND NOT i.indisunique AND i.indisvalid AND i.indisready AND i.indislive
         AND i.indnatts = 2 AND i.indnkeyatts = 2 AND i.indexprs IS NULL AND i.indpred IS NULL
         -- int2vector é indexado a partir de 0: compara elemento a elemento (a igualdade de arrays exige os mesmos limites)
         AND i.indkey[0] = (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.fechamentos'::regclass AND attname = 'empresa_id')
         AND i.indkey[1] = (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.fechamentos'::regclass AND attname = 'data_evento')
         AND i.indoption[0] = 0 AND i.indoption[1] = 0
         AND NOT EXISTS (SELECT 1 FROM unnest(i.indclass::oid[]) k(opc) JOIN pg_opclass o ON o.oid = k.opc WHERE NOT o.opcdefault)) THEN
    RAISE EXCEPTION 'precheck 115: fechamentos_115_empresa_data_idx existe com outra definição';
  END IF;
  IF to_regclass('public.fechamentos_054_empresa_idx') IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_am am ON am.oid = c.relam
       WHERE c.oid = to_regclass('public.fechamentos_054_empresa_idx') AND n.nspname = 'public' AND c.relkind = 'i'
         AND i.indrelid = 'public.fechamentos'::regclass AND am.amname = 'btree'
         AND NOT i.indisunique AND i.indnatts = 1 AND i.indnkeyatts = 1 AND i.indexprs IS NULL
         AND i.indkey[0] = (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.fechamentos'::regclass AND attname = 'empresa_id')
         AND i.indoption[0] = 0
         AND pg_get_expr(i.indpred, i.indrelid) = '(empresa_id IS NOT NULL)'
         AND NOT EXISTS (SELECT 1 FROM unnest(i.indclass::oid[]) k(opc) JOIN pg_opclass o ON o.oid = k.opc WHERE NOT o.opcdefault)) THEN
    RAISE EXCEPTION 'precheck 115: fechamentos_054_empresa_idx existe com outra definição';
  END IF;
END $$;
ROLLBACK;
