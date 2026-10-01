-- A migration 039 repete a recusa de vigência já sobreposta depois da trava.
-- Não despublica tabela e não apaga preço.
DO $$ BEGIN
  IF to_regprocedure('public.kidmais_037_trava_publicacao(uuid)') IS NULL THEN
    RAISE EXCEPTION '039 precheck: trava da 037 ausente.';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM tabelas_preco a
      JOIN tabelas_preco b
        ON b.id > a.id
       AND b.empresa_id IS NOT DISTINCT FROM a.empresa_id
       AND a.publicada_em IS NOT NULL
       AND b.publicada_em IS NOT NULL
       AND daterange(a.vigencia_inicio, COALESCE(a.vigencia_fim, 'infinity'::date), '[]')
           && daterange(b.vigencia_inicio, COALESCE(b.vigencia_fim, 'infinity'::date), '[]')
  ) THEN
    RAISE EXCEPTION '039 precheck: vigência publicada já se sobrepõe. Não corrigir daqui.';
  END IF;
END $$;
SELECT 'pre_039' AS marco, (SELECT count(*) FROM tabelas_preco WHERE publicada_em IS NOT NULL) AS tabelas_publicadas;
