BEGIN;

-- Integridade de tenant no Fechamento. Primeira barreira da importação histórica (PR-A).
--
-- O fechamento não tem empresa_id: a empresa dele é a empresa do pacote.
-- Esta migration garante, em INSERT/UPDATE futuros, que tudo o que um
-- fechamento, uma revisão operacional ou uma fotografia de pacote referencia
-- pertence a essa mesma empresa, e que a empresa do fechamento não muda.
--
-- Política (a mesma da 040), sem exceção:
--   NULL/NULL (legado) é válido;
--   a mesma empresa nos dois lados é válida;
--   empresas diferentes são inválidas;
--   empresa/NULL e NULL/empresa são inválidos.
-- Além da empresa, o preço tem de ser do par (pacote, tabela) gravado, a regra
-- de desconto tem de ser do pacote gravado e o preço do adicional tem de ser do
-- par (adicional, tabela do fechamento ou da revisão).
--
-- Concorrência: a validação lê o preço, o preço do adicional e a regra de
-- desconto com FOR SHARE. Uma reatribuição concorrente (UPDATE, que trava a
-- linha antes dos gatilhos de 030 e desta migration) espera a primeira
-- utilização terminar e então vê a referência; uma primeira utilização que
-- espera a reatribuição reavalia a linha nova e recusa. Ordem das travas na
-- validação: linha do pai (só para adicionais), preço do pacote, regra de desconto,
-- preço do adicional. O adicional trava o pai antes de ler a tabela, e assim troca de
-- tabela e inclusão de filho se serializam: FOR SHARE no fechamento; FOR UPDATE na
-- revisão, que a 014 trava FOR UPDATE logo depois (sem promoção SHARE → UPDATE).
--
-- Troca de tabela: o pai pode ser atualizado antes de os adicionais serem
-- substituídos; um gatilho de restrição DIFERIDO revalida os filhos no COMMIT.
--
-- Fotografia: snapshot_anterior_id só aponta para fotografia do mesmo fechamento
-- (chave estrangeira composta).
--
-- A trava das tabelas vem ANTES da validação. Se existir qualquer linha
-- incompatível, a transação inteira aborta. Nada é reescrito, apagado ou
-- associado a uma empresa. Não cria coluna nem empresa_id.
-- As funções usam nomes qualificados e search_path fixo (pg_catalog, pg_temp por último).
-- Rollback: database/rollback/20260928_053_integridade_tenant_fechamento_down.sql
-- remove só funções, gatilhos e a chave estrangeira composta.

SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
  divergentes text;
BEGIN
  IF to_regclass('public.fechamentos') IS NULL
     OR to_regclass('public.fechamento_adicionais') IS NULL
     OR to_regclass('public.fechamento_revisoes') IS NULL
     OR to_regclass('public.fechamento_revisao_adicionais') IS NULL
     OR to_regclass('public.fechamento_pacote_snapshots') IS NULL
     OR to_regclass('public.fechamento_pacote_composicao') IS NULL
     OR to_regclass('public.regras_desconto_pacote') IS NULL THEN
    RAISE EXCEPTION '053: fechamento ou catálogo comercial ausente.';
  END IF;
  IF to_regprocedure('public.kidmais_034_recusar_empresa_distinta(uuid,uuid,text)') IS NULL THEN
    RAISE EXCEPTION '053: guarda de tenant do catálogo (034) ausente.';
  END IF;
  IF to_regprocedure('public.kidmais_030_preco_utilizado()') IS NULL THEN
    RAISE EXCEPTION '053: proteção de preço utilizado (030) ausente.';
  END IF;
  -- Dependências, pelo mesmo critério do postcheck (schema, tabela, gatilho, função, eventos,
  -- colunas, ENABLED, sem WHEN, gatilho comum): 029 (fotografia imutável), 030 (preço utilizado),
  -- 034 (tenant do catálogo) e 036/038 (empresa imutável). Tudo antes de criar qualquer objeto.
  -- tgtype: ROW=1, BEFORE=2, INSERT=4, DELETE=8, UPDATE=16.
  SELECT string_agg(e.gatilho, ', ' ORDER BY e.gatilho) INTO divergentes
    FROM (VALUES
      ('fechamento_pacote_snapshots_imutavel', 'fechamento_pacote_snapshots', 'public.kidmais_029_fotografia_imutavel()', 27, ARRAY[]::text[]),
      ('fechamento_pacote_composicao_imutavel', 'fechamento_pacote_composicao', 'public.kidmais_029_fotografia_imutavel()', 27, ARRAY[]::text[]),
      ('precos_pacote_calculo_utilizado_trg', 'precos_pacote', 'public.kidmais_030_preco_utilizado()', 19, ARRAY[]::text[]),
      ('precos_adicional_calculo_utilizado_trg', 'precos_adicional', 'public.kidmais_030_preco_utilizado()', 19, ARRAY[]::text[]),
      ('precos_pacote_empresa_trg', 'precos_pacote', 'public.kidmais_034_precos_pacote_empresa()', 23, ARRAY['pacote_id', 'tabela_preco_id']),
      ('precos_adicional_empresa_trg', 'precos_adicional', 'public.kidmais_034_precos_adicional_empresa()', 23, ARRAY['adicional_id', 'tabela_preco_id']),
      ('pacote_adicionais_empresa_trg', 'pacote_adicionais', 'public.kidmais_034_pacote_adicionais_empresa()', 23, ARRAY['adicional_id', 'pacote_id']),
      ('pacotes_empresa_imutavel_trg', 'pacotes', 'public.kidmais_036_empresa_pai_imutavel()', 19, ARRAY['empresa_id']),
      ('tabelas_preco_empresa_imutavel_trg', 'tabelas_preco', 'public.kidmais_036_empresa_pai_imutavel()', 19, ARRAY['empresa_id']),
      ('adicionais_empresa_imutavel_trg', 'adicionais', 'public.kidmais_036_empresa_pai_imutavel()', 19, ARRAY['empresa_id'])
    ) AS e(gatilho, tabela, funcao, tipo, colunas)
   WHERE NOT EXISTS (
     SELECT 1
       FROM pg_catalog.pg_trigger t
       JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE NOT t.tgisinternal AND t.tgname = e.gatilho AND c.relname = e.tabela AND n.nspname = 'public'
        AND t.tgfoid = to_regprocedure(e.funcao) AND t.tgtype = e.tipo AND t.tgenabled = 'O'
        AND t.tgqual IS NULL AND t.tgconstraint = 0
        AND ARRAY(SELECT a.attname::text FROM unnest(t.tgattr::int2[]) AS k(num)
                    JOIN pg_catalog.pg_attribute a ON a.attrelid = t.tgrelid AND a.attnum = k.num
                   ORDER BY a.attname) = e.colunas
   );
  IF divergentes IS NOT NULL THEN
    RAISE EXCEPTION '053: dependência ausente ou degradada: %.', divergentes;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conrelid = 'public.fechamento_pacote_snapshots'::regclass
       AND conname = 'fechamento_pacote_snapshots_id_fechamento_uk'
       AND contype = 'u'
  ) THEN
    RAISE EXCEPTION '053: chave (id, fechamento_id) da fotografia ausente.';
  END IF;
  IF to_regprocedure('public.kidmais_053_falhar_se_incompativel()') IS NOT NULL THEN
    RAISE EXCEPTION '053: integridade de tenant do fechamento já existe.';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('kidmais-053'));
END $$;

LOCK TABLE
  public.pacotes, public.tabelas_preco, public.adicionais, public.precos_pacote,
  public.precos_adicional, public.regras_desconto_pacote,
  public.fechamentos, public.fechamento_adicionais, public.fechamento_revisoes,
  public.fechamento_revisao_adicionais, public.fechamento_pacote_snapshots,
  public.fechamento_pacote_composicao
  IN SHARE ROW EXCLUSIVE MODE;

CREATE FUNCTION public.kidmais_053_recusar(relacao text)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION '053: % cruza empresas ou não pertence ao fechamento.', relacao
    USING ERRCODE = '23514';
END;
$$;

CREATE FUNCTION public.kidmais_053_inexistente(relacao text)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION '053: % inexistente.', relacao
    USING ERRCODE = '23503';
END;
$$;

-- Pacote, tabela, preço e desconto coerentes entre si. Devolve a empresa do pacote.
-- Preço e desconto são lidos com FOR SHARE: a reatribuição concorrente espera ou é vista.
CREATE FUNCTION public.kidmais_053_empresa_comercial(
  p_pacote uuid, p_tabela uuid, p_preco uuid, p_desconto uuid, relacao text
)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  empresa_pacote uuid;
  empresa_tabela uuid;
BEGIN
  SELECT empresa_id INTO empresa_pacote FROM public.pacotes WHERE id = p_pacote;
  IF NOT FOUND THEN PERFORM public.kidmais_053_inexistente(relacao || ': pacote'); END IF;
  SELECT empresa_id INTO empresa_tabela FROM public.tabelas_preco WHERE id = p_tabela;
  IF NOT FOUND THEN PERFORM public.kidmais_053_inexistente(relacao || ': tabela de preço'); END IF;
  IF empresa_pacote IS DISTINCT FROM empresa_tabela THEN
    PERFORM public.kidmais_053_recusar(relacao || ': tabela de preço');
  END IF;
  PERFORM 1 FROM public.precos_pacote
   WHERE id = p_preco AND pacote_id = p_pacote AND tabela_preco_id = p_tabela
     FOR SHARE;
  IF NOT FOUND THEN
    PERFORM public.kidmais_053_recusar(relacao || ': preço do pacote');
  END IF;
  IF p_desconto IS NOT NULL THEN
    PERFORM 1 FROM public.regras_desconto_pacote
     WHERE id = p_desconto AND pacote_id = p_pacote
       FOR SHARE;
    IF NOT FOUND THEN
      PERFORM public.kidmais_053_recusar(relacao || ': regra de desconto');
    END IF;
  END IF;
  RETURN empresa_pacote;
END;
$$;

-- Empresa atual de um fechamento, pelo pacote gravado.
CREATE FUNCTION public.kidmais_053_empresa_do_fechamento(p_fechamento uuid)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  empresa uuid;
BEGIN
  SELECT p.empresa_id INTO empresa
    FROM public.fechamentos f
    JOIN public.pacotes p ON p.id = f.pacote_id
   WHERE f.id = p_fechamento;
  IF NOT FOUND THEN PERFORM public.kidmais_053_inexistente('fechamento'); END IF;
  RETURN empresa;
END;
$$;

-- Adicional da empresa esperada e preço do adicional do par (adicional, tabela), com FOR SHARE.
CREATE FUNCTION public.kidmais_053_validar_adicional(
  p_adicional uuid, p_preco uuid, p_tabela uuid, empresa_esperada uuid, relacao text
)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  empresa_adicional uuid;
BEGIN
  SELECT empresa_id INTO empresa_adicional FROM public.adicionais WHERE id = p_adicional;
  IF NOT FOUND THEN PERFORM public.kidmais_053_inexistente(relacao || ': adicional'); END IF;
  IF empresa_adicional IS DISTINCT FROM empresa_esperada THEN
    PERFORM public.kidmais_053_recusar(relacao || ': adicional');
  END IF;
  PERFORM 1 FROM public.precos_adicional
   WHERE id = p_preco AND adicional_id = p_adicional AND tabela_preco_id = p_tabela
     FOR SHARE;
  IF NOT FOUND THEN
    PERFORM public.kidmais_053_recusar(relacao || ': preço do adicional');
  END IF;
END;
$$;

CREATE FUNCTION public.kidmais_053_fechamento()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  empresa_nova uuid;
  empresa_antiga uuid;
BEGIN
  empresa_nova := public.kidmais_053_empresa_comercial(
    NEW.pacote_id, NEW.tabela_preco_id, NEW.preco_pacote_id, NEW.regra_desconto_pacote_id, 'fechamento'
  );
  IF TG_OP = 'UPDATE' AND NEW.pacote_id IS DISTINCT FROM OLD.pacote_id THEN
    SELECT empresa_id INTO empresa_antiga FROM public.pacotes WHERE id = OLD.pacote_id;
    IF empresa_nova IS DISTINCT FROM empresa_antiga THEN
      PERFORM public.kidmais_053_recusar('troca de pacote do fechamento');
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.kidmais_053_fechamento_adicional()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  tabela uuid;
  empresa uuid;
BEGIN
  -- FOR SHARE no pai: uma troca de tabela concorrente (UPDATE, que trava a linha) termina antes
  -- desta leitura, e a linha é relida; uma troca posterior espera este filho e o vê no COMMIT.
  SELECT f.tabela_preco_id, p.empresa_id INTO tabela, empresa
    FROM public.fechamentos f
    JOIN public.pacotes p ON p.id = f.pacote_id
   WHERE f.id = NEW.fechamento_id
     FOR SHARE OF f;
  IF NOT FOUND THEN PERFORM public.kidmais_053_inexistente('fechamento do adicional'); END IF;
  PERFORM public.kidmais_053_validar_adicional(NEW.adicional_id, NEW.preco_adicional_id, tabela, empresa, 'adicional do fechamento');
  RETURN NEW;
END;
$$;

-- Diferido: no COMMIT, os adicionais do fechamento têm de acompanhar a tabela e a empresa atuais.
CREATE FUNCTION public.kidmais_053_fechamento_filhos()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.fechamento_adicionais fa
      JOIN public.fechamentos f ON f.id = fa.fechamento_id
      JOIN public.pacotes p ON p.id = f.pacote_id
      JOIN public.adicionais a ON a.id = fa.adicional_id
      LEFT JOIN public.precos_adicional pa
        ON pa.id = fa.preco_adicional_id AND pa.adicional_id = fa.adicional_id AND pa.tabela_preco_id = f.tabela_preco_id
     WHERE fa.fechamento_id = NEW.id
       AND (a.empresa_id IS DISTINCT FROM p.empresa_id OR pa.id IS NULL)
  ) THEN
    PERFORM public.kidmais_053_recusar('adicionais do fechamento após troca de tabela ou pacote');
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION public.kidmais_053_revisao()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  empresa_revisao uuid;
BEGIN
  empresa_revisao := public.kidmais_053_empresa_comercial(
    NEW.pacote_id, NEW.tabela_preco_id, NEW.preco_pacote_id, NEW.regra_desconto_pacote_id, 'revisão'
  );
  IF empresa_revisao IS DISTINCT FROM public.kidmais_053_empresa_do_fechamento(NEW.fechamento_id) THEN
    PERFORM public.kidmais_053_recusar('revisão');
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.kidmais_053_revisao_adicional()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  tabela uuid;
  empresa uuid;
BEGIN
  -- FOR UPDATE (não FOR SHARE): em seguida, fra_preservar_trg (014) trava a mesma revisão
  -- FOR UPDATE. Travar já em modo UPDATE evita a promoção SHARE → UPDATE, em que duas inclusões
  -- concorrentes na mesma revisão se bloqueariam mutuamente (deadlock).
  SELECT r.tabela_preco_id, p.empresa_id INTO tabela, empresa
    FROM public.fechamento_revisoes r
    JOIN public.pacotes p ON p.id = r.pacote_id
   WHERE r.id = NEW.fechamento_revisao_id
     FOR UPDATE OF r;
  IF NOT FOUND THEN PERFORM public.kidmais_053_inexistente('revisão do adicional'); END IF;
  PERFORM public.kidmais_053_validar_adicional(NEW.adicional_id, NEW.preco_adicional_id, tabela, empresa, 'adicional da revisão');
  RETURN NEW;
END;
$$;

-- Diferido: no COMMIT, os adicionais da revisão têm de acompanhar a tabela e a empresa atuais.
CREATE FUNCTION public.kidmais_053_revisao_filhos()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.fechamento_revisao_adicionais ra
      JOIN public.fechamento_revisoes rv ON rv.id = ra.fechamento_revisao_id
      JOIN public.pacotes p ON p.id = rv.pacote_id
      JOIN public.adicionais a ON a.id = ra.adicional_id
      LEFT JOIN public.precos_adicional pa
        ON pa.id = ra.preco_adicional_id AND pa.adicional_id = ra.adicional_id AND pa.tabela_preco_id = rv.tabela_preco_id
     WHERE ra.fechamento_revisao_id = NEW.id
       AND (a.empresa_id IS DISTINCT FROM p.empresa_id OR pa.id IS NULL)
  ) THEN
    PERFORM public.kidmais_053_recusar('adicionais da revisão após troca de tabela ou pacote');
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION public.kidmais_053_fotografia()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  empresa_fotografia uuid;
BEGIN
  empresa_fotografia := public.kidmais_053_empresa_comercial(
    NEW.pacote_id, NEW.tabela_preco_id, NEW.preco_pacote_id, NEW.regra_desconto_pacote_id, 'fotografia do pacote'
  );
  IF empresa_fotografia IS DISTINCT FROM public.kidmais_053_empresa_do_fechamento(NEW.fechamento_id) THEN
    PERFORM public.kidmais_053_recusar('fotografia do pacote');
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.kidmais_053_composicao()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  empresa_fotografia uuid;
  empresa_adicional uuid;
BEGIN
  IF NEW.adicional_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT p.empresa_id INTO empresa_fotografia
    FROM public.fechamento_pacote_snapshots s
    JOIN public.pacotes p ON p.id = s.pacote_id
   WHERE s.id = NEW.snapshot_id;
  IF NOT FOUND THEN PERFORM public.kidmais_053_inexistente('fotografia da composição'); END IF;
  SELECT empresa_id INTO empresa_adicional FROM public.adicionais WHERE id = NEW.adicional_id;
  IF NOT FOUND THEN PERFORM public.kidmais_053_inexistente('adicional da composição'); END IF;
  IF empresa_adicional IS DISTINCT FROM empresa_fotografia THEN
    PERFORM public.kidmais_053_recusar('adicional da composição');
  END IF;
  RETURN NEW;
END;
$$;

-- Regra de desconto já utilizada não muda de pacote; a não utilizada não muda de empresa.
-- O UPDATE trava a linha antes deste gatilho; a consulta abaixo vê a utilização já confirmada.
CREATE FUNCTION public.kidmais_053_desconto_utilizado()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  empresa_antiga uuid;
  empresa_nova uuid;
BEGIN
  IF NEW.pacote_id IS NOT DISTINCT FROM OLD.pacote_id THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM public.fechamentos WHERE regra_desconto_pacote_id = OLD.id)
     OR EXISTS (SELECT 1 FROM public.fechamento_revisoes WHERE regra_desconto_pacote_id = OLD.id)
     OR EXISTS (SELECT 1 FROM public.fechamento_pacote_snapshots WHERE regra_desconto_pacote_id = OLD.id) THEN
    PERFORM public.kidmais_053_recusar('regra de desconto utilizada');
  END IF;
  SELECT empresa_id INTO empresa_antiga FROM public.pacotes WHERE id = OLD.pacote_id;
  SELECT empresa_id INTO empresa_nova FROM public.pacotes WHERE id = NEW.pacote_id;
  IF empresa_antiga IS DISTINCT FROM empresa_nova THEN
    PERFORM public.kidmais_053_recusar('regra de desconto');
  END IF;
  RETURN NEW;
END;
$$;

-- Critério do histórico. Repetido no precheck e no postcheck.
CREATE FUNCTION public.kidmais_053_falhar_se_incompativel()
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.fechamentos f
      JOIN public.pacotes p ON p.id = f.pacote_id
      JOIN public.tabelas_preco t ON t.id = f.tabela_preco_id
      LEFT JOIN public.precos_pacote pp
        ON pp.id = f.preco_pacote_id AND pp.pacote_id = f.pacote_id AND pp.tabela_preco_id = f.tabela_preco_id
      LEFT JOIN public.regras_desconto_pacote r
        ON r.id = f.regra_desconto_pacote_id AND r.pacote_id = f.pacote_id
     WHERE t.empresa_id IS DISTINCT FROM p.empresa_id
        OR pp.id IS NULL
        OR (f.regra_desconto_pacote_id IS NOT NULL AND r.id IS NULL)
  ) OR EXISTS (
    SELECT 1
      FROM public.fechamento_adicionais fa
      JOIN public.fechamentos f ON f.id = fa.fechamento_id
      JOIN public.pacotes p ON p.id = f.pacote_id
      JOIN public.adicionais a ON a.id = fa.adicional_id
      LEFT JOIN public.precos_adicional pa
        ON pa.id = fa.preco_adicional_id AND pa.adicional_id = fa.adicional_id AND pa.tabela_preco_id = f.tabela_preco_id
     WHERE a.empresa_id IS DISTINCT FROM p.empresa_id
        OR pa.id IS NULL
  ) OR EXISTS (
    SELECT 1
      FROM public.fechamento_revisoes rv
      JOIN public.fechamentos f ON f.id = rv.fechamento_id
      JOIN public.pacotes pf ON pf.id = f.pacote_id
      JOIN public.pacotes p ON p.id = rv.pacote_id
      JOIN public.tabelas_preco t ON t.id = rv.tabela_preco_id
      LEFT JOIN public.precos_pacote pp
        ON pp.id = rv.preco_pacote_id AND pp.pacote_id = rv.pacote_id AND pp.tabela_preco_id = rv.tabela_preco_id
      LEFT JOIN public.regras_desconto_pacote r
        ON r.id = rv.regra_desconto_pacote_id AND r.pacote_id = rv.pacote_id
     WHERE t.empresa_id IS DISTINCT FROM p.empresa_id
        OR p.empresa_id IS DISTINCT FROM pf.empresa_id
        OR pp.id IS NULL
        OR (rv.regra_desconto_pacote_id IS NOT NULL AND r.id IS NULL)
  ) OR EXISTS (
    SELECT 1
      FROM public.fechamento_revisao_adicionais ra
      JOIN public.fechamento_revisoes rv ON rv.id = ra.fechamento_revisao_id
      JOIN public.pacotes p ON p.id = rv.pacote_id
      JOIN public.adicionais a ON a.id = ra.adicional_id
      LEFT JOIN public.precos_adicional pa
        ON pa.id = ra.preco_adicional_id AND pa.adicional_id = ra.adicional_id AND pa.tabela_preco_id = rv.tabela_preco_id
     WHERE a.empresa_id IS DISTINCT FROM p.empresa_id
        OR pa.id IS NULL
  ) OR EXISTS (
    SELECT 1
      FROM public.fechamento_pacote_snapshots s
      JOIN public.fechamentos f ON f.id = s.fechamento_id
      JOIN public.pacotes pf ON pf.id = f.pacote_id
      JOIN public.pacotes p ON p.id = s.pacote_id
      JOIN public.tabelas_preco t ON t.id = s.tabela_preco_id
      LEFT JOIN public.precos_pacote pp
        ON pp.id = s.preco_pacote_id AND pp.pacote_id = s.pacote_id AND pp.tabela_preco_id = s.tabela_preco_id
      LEFT JOIN public.regras_desconto_pacote r
        ON r.id = s.regra_desconto_pacote_id AND r.pacote_id = s.pacote_id
     WHERE t.empresa_id IS DISTINCT FROM p.empresa_id
        OR p.empresa_id IS DISTINCT FROM pf.empresa_id
        OR pp.id IS NULL
        OR (s.regra_desconto_pacote_id IS NOT NULL AND r.id IS NULL)
  ) OR EXISTS (
    SELECT 1
      FROM public.fechamento_pacote_snapshots s
      JOIN public.fechamento_pacote_snapshots anterior ON anterior.id = s.snapshot_anterior_id
     WHERE anterior.fechamento_id <> s.fechamento_id
  ) OR EXISTS (
    SELECT 1
      FROM public.fechamento_pacote_composicao c
      JOIN public.fechamento_pacote_snapshots s ON s.id = c.snapshot_id
      JOIN public.pacotes p ON p.id = s.pacote_id
      JOIN public.adicionais a ON a.id = c.adicional_id
     WHERE a.empresa_id IS DISTINCT FROM p.empresa_id
  ) THEN
    RAISE EXCEPTION '053: fechamento incompatível. A migration não corrige dado.'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

SELECT public.kidmais_053_falhar_se_incompativel();

ALTER TABLE public.fechamento_pacote_snapshots
  ADD CONSTRAINT fechamento_pacote_snapshots_anterior_mesmo_fechamento_fk
  FOREIGN KEY (snapshot_anterior_id, fechamento_id)
  REFERENCES public.fechamento_pacote_snapshots (id, fechamento_id)
  ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TRIGGER fechamentos_053_empresa_trg
BEFORE INSERT OR UPDATE OF pacote_id, tabela_preco_id, preco_pacote_id, regra_desconto_pacote_id ON public.fechamentos
FOR EACH ROW EXECUTE FUNCTION public.kidmais_053_fechamento();

CREATE CONSTRAINT TRIGGER fechamentos_053_filhos_trg
AFTER UPDATE OF pacote_id, tabela_preco_id ON public.fechamentos
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.kidmais_053_fechamento_filhos();

CREATE TRIGGER fechamento_adicionais_053_empresa_trg
BEFORE INSERT OR UPDATE OF fechamento_id, adicional_id, preco_adicional_id ON public.fechamento_adicionais
FOR EACH ROW EXECUTE FUNCTION public.kidmais_053_fechamento_adicional();

CREATE TRIGGER fechamento_revisoes_053_empresa_trg
BEFORE INSERT OR UPDATE OF fechamento_id, pacote_id, tabela_preco_id, preco_pacote_id, regra_desconto_pacote_id ON public.fechamento_revisoes
FOR EACH ROW EXECUTE FUNCTION public.kidmais_053_revisao();

CREATE CONSTRAINT TRIGGER fechamento_revisoes_053_filhos_trg
AFTER UPDATE OF pacote_id, tabela_preco_id ON public.fechamento_revisoes
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.kidmais_053_revisao_filhos();

CREATE TRIGGER fechamento_revisao_adicionais_053_empresa_trg
BEFORE INSERT OR UPDATE OF fechamento_revisao_id, adicional_id, preco_adicional_id ON public.fechamento_revisao_adicionais
FOR EACH ROW EXECUTE FUNCTION public.kidmais_053_revisao_adicional();

CREATE TRIGGER fechamento_pacote_snapshots_053_empresa_trg
BEFORE INSERT ON public.fechamento_pacote_snapshots
FOR EACH ROW EXECUTE FUNCTION public.kidmais_053_fotografia();

CREATE TRIGGER fechamento_pacote_composicao_053_empresa_trg
BEFORE INSERT ON public.fechamento_pacote_composicao
FOR EACH ROW EXECUTE FUNCTION public.kidmais_053_composicao();

CREATE TRIGGER regras_desconto_pacote_053_utilizada_trg
BEFORE UPDATE OF pacote_id ON public.regras_desconto_pacote
FOR EACH ROW EXECUTE FUNCTION public.kidmais_053_desconto_utilizado();

COMMIT;
