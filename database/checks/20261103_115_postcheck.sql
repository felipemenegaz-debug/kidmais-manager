-- Postcheck da 115 (índice (empresa_id, data_evento) em fechamentos): somente leitura; o índice tem de existir exatamente
-- como a 115 o cria (schema public, tabela fechamentos, btree, (empresa_id, data_evento) nessa ordem, ASC, classes de
-- operador padrão, sem expressão nem predicado, não único, válido/pronto/vivo), e o 054 removido.
DO $$ BEGIN
  IF NOT EXISTS (
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
    RAISE EXCEPTION 'postcheck 115: fechamentos_115_empresa_data_idx ausente ou com outra definição';
  END IF;
  IF to_regclass('public.fechamentos_054_empresa_idx') IS NOT NULL THEN
    RAISE EXCEPTION 'postcheck 115: fechamentos_054_empresa_idx ainda existe (a 115 o substitui)';
  END IF;
END $$;
