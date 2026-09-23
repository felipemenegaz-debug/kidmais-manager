-- Somente leitura. Verifica estrutura e preservação; comparar contagens com precheck.
DO $$
DECLARE nome text;
BEGIN
  FOREACH nome IN ARRAY ARRAY[
    'buffet_categorias','buffet_itens','pacote_buffet_categorias',
    'pacote_buffet_itens','fechamento_buffet_snapshots','fechamento_buffet_escolhas','adicional_categorias',
    'pacote_adicionais','documentos_publicos'
  ] LOOP
    IF to_regclass('public.' || nome) IS NULL THEN
      RAISE EXCEPTION 'Tabela 021 ausente: %', nome;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM public.adicionais a
             LEFT JOIN public.adicional_categorias c ON c.id=a.categoria_id
             WHERE c.codigo IS DISTINCT FROM a.categoria) THEN
    RAISE EXCEPTION 'Backfill das categorias não corresponde ao código legado.';
  END IF;
  IF (SELECT count(*) FROM public.adicional_categorias) <>
     (SELECT count(DISTINCT categoria) FROM public.adicionais) THEN
    RAISE EXCEPTION 'Quantidade de categorias do backfill divergente.';
  END IF;
  IF (SELECT count(*) FROM public.documentos_publicos WHERE ativo) <> 0 OR
     (SELECT count(*) FROM public.fechamento_buffet_snapshots) <> 0 OR
     (SELECT count(*) FROM public.fechamento_buffet_escolhas) <> 0 OR
     (SELECT count(*) FROM public.pacote_adicionais) <> 0 THEN
    RAISE EXCEPTION 'Estrutura 021 ativou catálogo ou snapshot prematuramente.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid='public.precos_adicional'::regclass
                   AND conname='precos_adicional_valor_check'
                   AND pg_get_constraintdef(oid) LIKE '%valor >=%') THEN
    RAISE EXCEPTION 'Cortesia não permitida na constraint de preço.';
  END IF;
END $$;

SELECT 'pos_021' AS marco,
       (SELECT count(*) FROM public.adicionais) AS adicionais,
       (SELECT count(DISTINCT categoria) FROM public.adicionais) AS categorias,
       (SELECT count(*) FROM public.precos_adicional) AS precos,
       (SELECT count(*) FROM public.fechamentos) AS fechamentos;
