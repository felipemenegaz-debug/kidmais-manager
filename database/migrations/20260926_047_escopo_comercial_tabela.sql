BEGIN;

-- HG-4: publicar exige o escopo comercial declarado da própria tabela.
-- Um preço ativo não basta, e a tabela não precisa vender todo pacote,
-- toda categoria nem toda faixa possível. Sem escopo, a publicação falha fechada.
-- Esta migration não infere escopo a partir de preço histórico, não publica
-- linha, não recalcula fechamento e não altera preço, contrato ou documento.
--
-- Rollback: database/rollback/20260926_047_escopo_comercial_tabela_down.sql
-- devolve a guarda anterior e remove só as tabelas novas, vazias nesta aplicação.

LOCK TABLE
  public.precos_pacote,
  public.tabelas_preco
IN SHARE ROW EXCLUSIVE MODE;

DO $$ BEGIN
  IF to_regclass('public.tabelas_preco') IS NULL OR to_regclass('public.precos_pacote') IS NULL THEN
    RAISE EXCEPTION '047: tabela de preço ausente.';
  END IF;
  IF to_regprocedure('public.kidmais_035_preservar_tabela_publicada()') IS NULL
     OR to_regprocedure('public.kidmais_037_trava_publicacao(uuid)') IS NULL THEN
    RAISE EXCEPTION '047: guarda de publicação ausente.';
  END IF;
  IF to_regclass('public.tabela_preco_escopos') IS NOT NULL
     OR to_regprocedure('public.kidmais_047_lacunas_escopo(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION '047: escopo comercial já existe.';
  END IF;
END $$;

CREATE TABLE tabela_preco_escopos (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tabela_preco_id uuid NOT NULL,
    pacote_id uuid NOT NULL,
    categoria_horario varchar(20) NOT NULL,
    cobertura_continua boolean NOT NULL,
    limite_convidados_min smallint,
    limite_convidados_max smallint,
    criado_em timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT tabela_preco_escopos_tabela_fk
        FOREIGN KEY (tabela_preco_id) REFERENCES tabelas_preco(id) ON DELETE RESTRICT,
    CONSTRAINT tabela_preco_escopos_pacote_fk
        FOREIGN KEY (pacote_id) REFERENCES pacotes(id) ON DELETE RESTRICT,
    CONSTRAINT tabela_preco_escopos_combinacao_uk
        UNIQUE (tabela_preco_id, pacote_id, categoria_horario),
    CONSTRAINT tabela_preco_escopos_categoria_check
        CHECK (categoria_horario IN ('GERAL', 'PADRAO', 'NOBRE')),
    CONSTRAINT tabela_preco_escopos_limite_min_check
        CHECK (limite_convidados_min IS NULL OR limite_convidados_min > 0),
    CONSTRAINT tabela_preco_escopos_limite_max_check
        CHECK (limite_convidados_max IS NULL OR limite_convidados_max > 0),
    CONSTRAINT tabela_preco_escopos_limite_intervalo_check
        CHECK (
            limite_convidados_min IS NULL
            OR limite_convidados_max IS NULL
            OR limite_convidados_max >= limite_convidados_min
        )
);

CREATE TABLE tabela_preco_escopo_faixas (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    escopo_id uuid NOT NULL,
    convidados_min smallint NOT NULL,
    convidados_max smallint,
    criado_em timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT tabela_preco_escopo_faixas_escopo_fk
        FOREIGN KEY (escopo_id) REFERENCES tabela_preco_escopos(id) ON DELETE RESTRICT,
    CONSTRAINT tabela_preco_escopo_faixas_min_check CHECK (convidados_min > 0),
    CONSTRAINT tabela_preco_escopo_faixas_intervalo_check CHECK (
        convidados_max IS NULL OR convidados_max >= convidados_min
    ),
    CONSTRAINT tabela_preco_escopo_faixas_uk
        UNIQUE NULLS NOT DISTINCT (escopo_id, convidados_min, convidados_max)
);

CREATE FUNCTION kidmais_047_lacunas_escopo(tabela uuid)
RETURNS TABLE (codigo text, detalhe text)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH escopo AS (
    SELECT e.id, e.pacote_id, e.categoria_horario, e.cobertura_continua,
           e.limite_convidados_min, e.limite_convidados_max
      FROM tabela_preco_escopos e
     WHERE e.tabela_preco_id = tabela
  ),
  faixa AS (
    SELECT f.id, f.escopo_id, f.convidados_min, f.convidados_max,
           e.pacote_id, e.categoria_horario, e.cobertura_continua,
           e.limite_convidados_min, e.limite_convidados_max,
           p.codigo AS pacote_codigo,
           p.convidados_minimos, p.convidados_maximos
      FROM tabela_preco_escopo_faixas f
      JOIN escopo e ON e.id = f.escopo_id
      JOIN pacotes p ON p.id = e.pacote_id
  )
  SELECT 'ESCOPO_AUSENTE'::text,
         'A tabela não declara quais pacotes, categorias e faixas vende.'::text
   WHERE NOT EXISTS (SELECT 1 FROM escopo)
  UNION ALL
  SELECT 'COMBINACAO_SEM_FAIXA', p.codigo || ' · ' || e.categoria_horario
    FROM escopo e
    JOIN pacotes p ON p.id = e.pacote_id
   WHERE NOT EXISTS (SELECT 1 FROM faixa f WHERE f.escopo_id = e.id)
  UNION ALL
  SELECT 'EMPRESA_DIVERGENTE', p.codigo
    FROM escopo e
    JOIN pacotes p ON p.id = e.pacote_id
    JOIN tabelas_preco t ON t.id = tabela
   WHERE t.empresa_id IS DISTINCT FROM p.empresa_id
  UNION ALL
  SELECT 'FAIXA_INVALIDA', f.pacote_codigo || ' · ' || f.categoria_horario
    FROM faixa f
   WHERE f.convidados_min < 1
      OR (f.convidados_max IS NOT NULL AND f.convidados_max < f.convidados_min)
  UNION ALL
  SELECT 'FAIXA_SOBREPOSTA', a.pacote_codigo || ' · ' || a.categoria_horario
    FROM faixa a
    JOIN faixa b
      ON b.escopo_id = a.escopo_id
     AND b.id > a.id
     AND numrange(a.convidados_min::numeric, COALESCE(a.convidados_max::numeric, 'Infinity'::numeric), '[]')
         && numrange(b.convidados_min::numeric, COALESCE(b.convidados_max::numeric, 'Infinity'::numeric), '[]')
  UNION ALL
  SELECT 'FAIXA_FORA_DO_LIMITE', f.pacote_codigo || ' · ' || f.categoria_horario
    FROM faixa f
   WHERE (f.limite_convidados_min IS NOT NULL AND f.convidados_min < f.limite_convidados_min)
      OR (f.limite_convidados_max IS NOT NULL AND (f.convidados_max IS NULL OR f.convidados_max > f.limite_convidados_max))
      OR (f.convidados_minimos IS NOT NULL AND f.convidados_min < f.convidados_minimos)
      OR (f.convidados_maximos IS NOT NULL AND (f.convidados_max IS NULL OR f.convidados_max > f.convidados_maximos))
  UNION ALL
  SELECT 'FAIXA_COM_BURACO', x.pacote_codigo || ' · ' || x.categoria_horario
    FROM (
      SELECT f.pacote_codigo, f.categoria_horario, f.cobertura_continua,
             f.convidados_min, f.convidados_max,
             f.limite_convidados_min, f.limite_convidados_max,
             lag(f.convidados_max) OVER (PARTITION BY f.escopo_id ORDER BY f.convidados_min, f.id) AS anterior_max,
             row_number() OVER (PARTITION BY f.escopo_id ORDER BY f.convidados_min, f.id) AS ordem,
             count(*) OVER (PARTITION BY f.escopo_id) AS total
        FROM faixa f
    ) x
   WHERE x.cobertura_continua
     AND (
       (x.ordem > 1 AND (x.anterior_max IS NULL OR x.convidados_min > x.anterior_max + 1))
       OR (x.limite_convidados_min IS NOT NULL AND x.ordem = 1 AND x.convidados_min > x.limite_convidados_min)
       OR (x.limite_convidados_max IS NOT NULL AND x.ordem = x.total
           AND (x.convidados_max IS NULL OR x.convidados_max < x.limite_convidados_max))
     )
  UNION ALL
  SELECT 'FAIXA_SEM_PRECO',
         f.pacote_codigo || ' · ' || f.categoria_horario || ' · ' || f.convidados_min::text
           || '–' || COALESCE(f.convidados_max::text, 'aberto')
    FROM faixa f
   WHERE NOT EXISTS (
     SELECT 1
       FROM precos_pacote p
      WHERE p.tabela_preco_id = tabela
        AND p.ativo
        AND p.pacote_id = f.pacote_id
        AND p.categoria_horario = f.categoria_horario
        AND p.convidados_min = f.convidados_min
        AND p.convidados_max IS NOT DISTINCT FROM f.convidados_max
        AND p.valor > 0
        AND p.tipo_calculo IN ('FIXO', 'POR_CONVIDADO')
   )
  UNION ALL
  SELECT 'PRECO_FORA_DO_ESCOPO',
         pk.codigo || ' · ' || p.categoria_horario || ' · ' || p.convidados_min::text
           || '–' || COALESCE(p.convidados_max::text, 'aberto')
    FROM precos_pacote p
    JOIN pacotes pk ON pk.id = p.pacote_id
   WHERE p.tabela_preco_id = tabela
     AND p.ativo
     AND NOT EXISTS (
       SELECT 1
         FROM faixa f
        WHERE f.pacote_id = p.pacote_id
          AND f.categoria_horario = p.categoria_horario
          AND f.convidados_min = p.convidados_min
          AND f.convidados_max IS NOT DISTINCT FROM p.convidados_max
     );
$$;

CREATE FUNCTION kidmais_047_escopo_mesma_empresa()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF (SELECT empresa_id FROM tabelas_preco WHERE id = NEW.tabela_preco_id)
     IS DISTINCT FROM
     (SELECT empresa_id FROM pacotes WHERE id = NEW.pacote_id) THEN
    RAISE EXCEPTION '047: escopo cruza empresas.'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tabela_preco_escopos_empresa_trg
BEFORE INSERT OR UPDATE OF tabela_preco_id, pacote_id ON tabela_preco_escopos
FOR EACH ROW
EXECUTE FUNCTION kidmais_047_escopo_mesma_empresa();

CREATE FUNCTION kidmais_047_escopo_imutavel()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  tabela uuid;
  publicada timestamptz;
BEGIN
  IF TG_TABLE_NAME = 'tabela_preco_escopos' THEN
    tabela := CASE WHEN TG_OP = 'DELETE' THEN OLD.tabela_preco_id ELSE NEW.tabela_preco_id END;
  ELSE
    SELECT e.tabela_preco_id INTO tabela
      FROM tabela_preco_escopos e
     WHERE e.id = CASE WHEN TG_OP = 'DELETE' THEN OLD.escopo_id ELSE NEW.escopo_id END;
  END IF;
  SELECT publicada_em INTO publicada FROM tabelas_preco WHERE id = tabela;
  IF publicada IS NOT NULL THEN
    RAISE EXCEPTION '047: escopo de tabela publicada não muda.'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tabela_preco_escopos_publicado_trg
BEFORE INSERT OR UPDATE OR DELETE ON tabela_preco_escopos
FOR EACH ROW
EXECUTE FUNCTION kidmais_047_escopo_imutavel();

CREATE TRIGGER tabela_preco_escopo_faixas_publicado_trg
BEFORE INSERT OR UPDATE OR DELETE ON tabela_preco_escopo_faixas
FOR EACH ROW
EXECUTE FUNCTION kidmais_047_escopo_imutavel();

CREATE OR REPLACE FUNCTION kidmais_035_preservar_tabela_publicada()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  lacuna text;
BEGIN
  IF OLD.publicada_em IS NOT NULL THEN
    IF NEW.publicada_em IS DISTINCT FROM OLD.publicada_em
       OR NEW.empresa_id IS DISTINCT FROM OLD.empresa_id
       OR NEW.codigo IS DISTINCT FROM OLD.codigo
       OR NEW.ativa IS DISTINCT FROM OLD.ativa
       OR NEW.vigencia_inicio IS DISTINCT FROM OLD.vigencia_inicio
       OR NEW.vigencia_fim IS DISTINCT FROM OLD.vigencia_fim THEN
      RAISE EXCEPTION '035: tabela publicada conserva empresa, vigência e publicação.';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.publicada_em IS NULL THEN
    RETURN NEW;
  END IF;
  PERFORM kidmais_037_trava_publicacao(NEW.empresa_id);
  IF NEW.ativa THEN
    RAISE EXCEPTION '035: publicação exige tabela inativa.';
  END IF;
  IF NEW.vigencia_fim IS NOT NULL AND NEW.vigencia_fim < NEW.vigencia_inicio THEN
    RAISE EXCEPTION '035: vigência inválida.';
  END IF;
  SELECT codigo INTO lacuna FROM kidmais_047_lacunas_escopo(NEW.id) LIMIT 1;
  IF lacuna IS NOT NULL THEN
    RAISE EXCEPTION '047: escopo declarado incompleto (%).', lacuna
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM precos_pacote pp
      JOIN pacotes p ON p.id = pp.pacote_id
     WHERE pp.tabela_preco_id = NEW.id
       AND NEW.empresa_id IS DISTINCT FROM p.empresa_id
  ) THEN
    RAISE EXCEPTION '035: preço de pacote cruza empresas.';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM precos_pacote
     WHERE tabela_preco_id = NEW.id
       AND (
         convidados_min < 1
         OR (convidados_max IS NOT NULL AND convidados_max < convidados_min)
         OR valor <= 0
       )
  ) THEN
    RAISE EXCEPTION '035: faixa inválida.';
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
     WHERE a.tabela_preco_id = NEW.id
  ) THEN
    RAISE EXCEPTION '035: faixa sobreposta.';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM tabelas_preco outra
     WHERE outra.id <> NEW.id
       AND outra.empresa_id IS NOT DISTINCT FROM NEW.empresa_id
       AND outra.publicada_em IS NOT NULL
       AND daterange(outra.vigencia_inicio, COALESCE(outra.vigencia_fim, 'infinity'::date), '[]')
           && daterange(NEW.vigencia_inicio, COALESCE(NEW.vigencia_fim, 'infinity'::date), '[]')
  ) THEN
    RAISE EXCEPTION '035: vigência publicada sobreposta.';
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
