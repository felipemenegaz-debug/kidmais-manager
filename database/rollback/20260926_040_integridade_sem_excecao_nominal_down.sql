-- Devolve o corpo da 038, inclusive a tolerância histórica, e remove a 040.
-- Não apaga vínculo, não limpa empresa_id e não reescreve FESTA_LOCAL.
-- Este DOWN não é a política futura: a 040 é que recusa a exceção nominal.
-- Sem a 040, chamar kidmais_038_falhar_se_incompativel volta a tolerar o par antigo.
BEGIN;

CREATE OR REPLACE FUNCTION kidmais_038_falhar_se_incompativel()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM precos_pacote pp
      JOIN tabelas_preco t ON t.id = pp.tabela_preco_id
      JOIN pacotes p ON p.id = pp.pacote_id
     WHERE t.empresa_id IS DISTINCT FROM p.empresa_id
  ) OR EXISTS (
    SELECT 1
      FROM precos_adicional pr
      JOIN tabelas_preco t ON t.id = pr.tabela_preco_id
      JOIN adicionais a ON a.id = pr.adicional_id
     WHERE t.empresa_id IS DISTINCT FROM a.empresa_id
  ) OR EXISTS (
    SELECT 1
      FROM pacote_adicionais pa
      JOIN pacotes p ON p.id = pa.pacote_id
      JOIN adicionais a ON a.id = pa.adicional_id
     WHERE p.empresa_id IS DISTINCT FROM a.empresa_id
       AND NOT (
         p.codigo = 'FESTA_LOCAL'
         AND a.codigo = 'SALADA_PREMIUM'
         AND p.empresa_id IS NOT NULL
         AND a.empresa_id IS NULL
       )
  ) THEN
    RAISE EXCEPTION '038: vínculo incompatível. A migration não corrige dado.'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

DROP FUNCTION IF EXISTS kidmais_040_falhar_se_incompativel();

COMMIT;
