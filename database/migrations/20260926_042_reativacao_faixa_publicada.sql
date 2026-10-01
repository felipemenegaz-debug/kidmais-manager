BEGIN;

-- A 039 serializa o preço publicado depois da trava, mas a faixa ativa era
-- conferida só no BEFORE, antes dessa trava. Duas transações reativavam
-- faixas inativas sobrepostas, cada uma via a outra ainda inativa, e as duas
-- confirmavam.
--
-- Depois da trava por empresa, esta migration relê a sobreposição e os outros
-- invariantes de preço publicado contra o estado que a transação vai confirmar.
-- ativo false→true em tabela publicada entra nessa releitura. observacoes não
-- entra na trava. Empresas diferentes não compartilham a chave.
-- HG-4 continua aberto: não se exige cobrir todos os pacotes nem as duas categorias.
--
-- A trava das tabelas vem antes da validação e da troca da função. Faixa ativa
-- já sobreposta em tabela publicada aborta a migration. Nada é despublicado
-- nem reescrito.

LOCK TABLE
  public.precos_pacote,
  public.tabelas_preco
IN SHARE ROW EXCLUSIVE MODE;

DO $$ BEGIN
  IF to_regclass('public.tabelas_preco') IS NULL OR to_regclass('public.precos_pacote') IS NULL THEN
    RAISE EXCEPTION '042: tabela de preço ausente.';
  END IF;
  IF to_regprocedure('public.kidmais_037_trava_publicacao(uuid)') IS NULL
     OR to_regprocedure('public.kidmais_039_travar_par(uuid,uuid)') IS NULL
     OR to_regprocedure('public.kidmais_035_preservar_preco_publicado()') IS NULL THEN
    RAISE EXCEPTION '042: guarda de publicação ausente.';
  END IF;
  IF to_regprocedure('public.kidmais_042_revalidar_faixa_publicada(uuid,uuid,uuid,text,integer,integer)') IS NOT NULL THEN
    RAISE EXCEPTION '042: releitura da faixa publicada já existe.';
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
    RAISE EXCEPTION '042: faixa ativa já se sobrepõe em tabela publicada. A migration não corrige dado.'
      USING ERRCODE = '23514';
  END IF;
END $$;

CREATE FUNCTION kidmais_042_falhar_se_faixa_publicada_sobreposta()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
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
    RAISE EXCEPTION '042: faixa ativa já se sobrepõe em tabela publicada. A migration não corrige dado.'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

SELECT kidmais_042_falhar_se_faixa_publicada_sobreposta();

CREATE FUNCTION kidmais_042_revalidar_faixa_publicada(
  preco uuid,
  tabela uuid,
  pacote uuid,
  categoria text,
  minimo integer,
  maximo integer
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  publicada timestamptz;
BEGIN
  SELECT publicada_em INTO publicada FROM tabelas_preco WHERE id = tabela;
  IF publicada IS NULL THEN
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1
      FROM precos_pacote p
     WHERE p.id <> preco
       AND p.ativo
       AND p.tabela_preco_id = tabela
       AND p.pacote_id = pacote
       AND p.categoria_horario = categoria
       AND int4range(p.convidados_min::integer, p.convidados_max::integer, '[]')
           && int4range(minimo, maximo, '[]')
  ) THEN
    RAISE EXCEPTION '042: faixa sobreposta em tabela publicada.'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION kidmais_035_preservar_preco_publicado()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  empresa_nova uuid;
  empresa_antiga uuid;
  publicada_nova timestamptz;
  publicada_antiga timestamptz;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.tabela_preco_id IS NOT DISTINCT FROM OLD.tabela_preco_id
     AND NEW.pacote_id IS NOT DISTINCT FROM OLD.pacote_id
     AND NEW.convidados_min IS NOT DISTINCT FROM OLD.convidados_min
     AND NEW.convidados_max IS NOT DISTINCT FROM OLD.convidados_max
     AND NEW.tipo_calculo IS NOT DISTINCT FROM OLD.tipo_calculo
     AND NEW.valor IS NOT DISTINCT FROM OLD.valor
     AND NEW.categoria_horario IS NOT DISTINCT FROM OLD.categoria_horario
     AND NEW.ativo IS NOT DISTINCT FROM OLD.ativo THEN
    RETURN NEW;
  END IF;

  IF TG_WHEN = 'AFTER' THEN
    IF TG_OP = 'DELETE' THEN
      SELECT empresa_id INTO empresa_antiga FROM tabelas_preco WHERE id = OLD.tabela_preco_id;
      PERFORM kidmais_039_travar_par(empresa_antiga, empresa_antiga);
    ELSE
      SELECT empresa_id INTO empresa_nova FROM tabelas_preco WHERE id = NEW.tabela_preco_id;
      IF TG_OP = 'UPDATE' AND NEW.tabela_preco_id IS DISTINCT FROM OLD.tabela_preco_id THEN
        SELECT empresa_id INTO empresa_antiga FROM tabelas_preco WHERE id = OLD.tabela_preco_id;
      ELSE
        empresa_antiga := empresa_nova;
      END IF;
      PERFORM kidmais_039_travar_par(empresa_nova, empresa_antiga);
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    SELECT publicada_em INTO publicada_antiga FROM tabelas_preco WHERE id = OLD.tabela_preco_id;
    IF publicada_antiga IS NOT NULL THEN
      RAISE EXCEPTION '037: preço de tabela publicada não é apagado.'
        USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  SELECT publicada_em INTO publicada_nova FROM tabelas_preco WHERE id = NEW.tabela_preco_id;
  IF TG_OP = 'UPDATE' THEN
    SELECT publicada_em INTO publicada_antiga FROM tabelas_preco WHERE id = OLD.tabela_preco_id;
  END IF;

  IF publicada_nova IS NULL AND publicada_antiga IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    RAISE EXCEPTION '035: tabela publicada não recebe preço novo.';
  END IF;

  IF NEW.tabela_preco_id IS DISTINCT FROM OLD.tabela_preco_id
     OR NEW.pacote_id IS DISTINCT FROM OLD.pacote_id
     OR NEW.convidados_min IS DISTINCT FROM OLD.convidados_min
     OR NEW.convidados_max IS DISTINCT FROM OLD.convidados_max
     OR NEW.tipo_calculo IS DISTINCT FROM OLD.tipo_calculo
     OR NEW.valor IS DISTINCT FROM OLD.valor
     OR NEW.categoria_horario IS DISTINCT FROM OLD.categoria_horario THEN
    RAISE EXCEPTION '037: preço publicado não muda de tabela nem de cálculo.'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.ativo IS DISTINCT FROM OLD.ativo AND NEW.ativo = false THEN
    IF NOT EXISTS (
      SELECT 1
        FROM precos_pacote
       WHERE tabela_preco_id = OLD.tabela_preco_id
         AND id <> OLD.id
         AND ativo
    ) THEN
      RAISE EXCEPTION '037: desativar o último preço esvazia a publicação.'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  -- A trava já foi tomada neste AFTER. A faixa e o esvaziamento acima foram
  -- lidos de novo no estado que esta transação vai confirmar. A conferência
  -- antiga da faixa, no BEFORE, não basta para duas reativações concorrentes.
  IF TG_WHEN = 'AFTER' AND TG_OP = 'UPDATE' AND NEW.ativo THEN
    PERFORM kidmais_042_revalidar_faixa_publicada(
      NEW.id,
      NEW.tabela_preco_id,
      NEW.pacote_id,
      NEW.categoria_horario,
      NEW.convidados_min::integer,
      NEW.convidados_max::integer
    );
  END IF;

  RETURN NEW;
END;
$$;

SELECT kidmais_042_falhar_se_faixa_publicada_sobreposta();

COMMIT;
