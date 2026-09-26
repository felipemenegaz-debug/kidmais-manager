-- A migration 042 repete este critério depois de travar preço e tabela.
-- Não despublica tabela e não apaga preço.
DO $$ BEGIN
  IF to_regclass('public.precos_pacote') IS NULL OR to_regclass('public.tabelas_preco') IS NULL THEN
    RAISE EXCEPTION '042 precheck: tabela de preço ausente.';
  END IF;
  IF to_regprocedure('public.kidmais_039_travar_par(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION '042 precheck: trava da publicação ausente.';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM precos_pacote a
      JOIN precos_pacote b
        ON b.tabela_preco_id = a.tabela_preco_id
       AND b.pacote_id = a.pacote_id
       AND b.categoria_horario = a.categoria_horario
       AND b.id > a.id
       AND a.ativo
       AND b.ativo
       AND int4range(a.convidados_min::integer, a.convidados_max::integer, '[]')
           && int4range(b.convidados_min::integer, b.convidados_max::integer, '[]')
      JOIN tabelas_preco t ON t.id = a.tabela_preco_id
     WHERE t.publicada_em IS NOT NULL
  ) THEN
    RAISE EXCEPTION '042 precheck: faixa ativa já se sobrepõe em tabela publicada. Não corrigir daqui.';
  END IF;
END $$;
SELECT 'pre_042' AS marco, (SELECT count(*) FROM tabelas_preco WHERE publicada_em IS NOT NULL) AS tabelas_publicadas;
