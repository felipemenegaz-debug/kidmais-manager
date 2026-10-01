BEGIN;

-- A empresa do pai comercial não muda depois do cadastro.
-- A 034 só olha INSERT/UPDATE das chaves do vínculo. UPDATE pacotes.empresa_id
-- (ou da tabela, ou do adicional) atravessava o tenant sem tocar a linha filha.
--
-- FK composta (id, empresa_id) não cabe neste schema: empresa_id é nulo no
-- legado, NULL/NULL continua válido, e já existe um pacote_adicional cujo
-- pacote tem empresa e cujo adicional não tem. Reescrever essa linha inventaria
-- um tenant. MATCH SIMPLE ignoraria o nulo; MATCH FULL recusaria o legado.
--
-- Esta migration não dá UPDATE nem DELETE de catálogo. O vínculo histórico
-- com um lado nulo permanece. Vínculo novo desse formato continua recusado
-- pela 034. NULL/NULL continua permitido.
--
-- O precheck abaixo faz parte da migration. Dado incompatível — as duas
-- empresas preenchidas e diferentes — aborta a transação. Não há script
-- opcional que autorize seguir.

DO $$ BEGIN
  IF to_regclass('public.pacotes') IS NULL
     OR to_regclass('public.tabelas_preco') IS NULL
     OR to_regclass('public.adicionais') IS NULL
     OR to_regclass('public.precos_pacote') IS NULL
     OR to_regclass('public.precos_adicional') IS NULL
     OR to_regclass('public.pacote_adicionais') IS NULL THEN
    RAISE EXCEPTION '036: catálogo comercial ausente.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'pacotes' AND column_name = 'empresa_id'
  ) THEN
    RAISE EXCEPTION '036: empresa_id comercial ausente.';
  END IF;
  IF to_regprocedure('public.kidmais_036_falhar_se_incompativel()') IS NOT NULL
     OR to_regprocedure('public.kidmais_036_empresa_pai_imutavel()') IS NOT NULL THEN
    RAISE EXCEPTION '036: imutabilidade de empresa do pai já existe.';
  END IF;
END $$;

CREATE FUNCTION kidmais_036_falhar_se_incompativel()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM precos_pacote pp
      JOIN tabelas_preco t ON t.id = pp.tabela_preco_id
      JOIN pacotes p ON p.id = pp.pacote_id
     WHERE t.empresa_id IS NOT NULL
       AND p.empresa_id IS NOT NULL
       AND t.empresa_id <> p.empresa_id
  ) OR EXISTS (
    SELECT 1
      FROM pacote_adicionais pa
      JOIN pacotes p ON p.id = pa.pacote_id
      JOIN adicionais a ON a.id = pa.adicional_id
     WHERE p.empresa_id IS NOT NULL
       AND a.empresa_id IS NOT NULL
       AND p.empresa_id <> a.empresa_id
  ) OR EXISTS (
    SELECT 1
      FROM precos_adicional pr
      JOIN tabelas_preco t ON t.id = pr.tabela_preco_id
      JOIN adicionais a ON a.id = pr.adicional_id
     WHERE t.empresa_id IS NOT NULL
       AND a.empresa_id IS NOT NULL
       AND t.empresa_id <> a.empresa_id
  ) THEN
    RAISE EXCEPTION '036: vínculo entre duas empresas já existe. A migration não corrige dado.'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

SELECT kidmais_036_falhar_se_incompativel();

CREATE FUNCTION kidmais_036_empresa_pai_imutavel()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.empresa_id IS DISTINCT FROM OLD.empresa_id THEN
    RAISE EXCEPTION '036: a empresa de % não muda.', TG_TABLE_NAME
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER pacotes_empresa_imutavel_trg
BEFORE UPDATE OF empresa_id ON pacotes
FOR EACH ROW
EXECUTE FUNCTION kidmais_036_empresa_pai_imutavel();

CREATE TRIGGER tabelas_preco_empresa_imutavel_trg
BEFORE UPDATE OF empresa_id ON tabelas_preco
FOR EACH ROW
EXECUTE FUNCTION kidmais_036_empresa_pai_imutavel();

CREATE TRIGGER adicionais_empresa_imutavel_trg
BEFORE UPDATE OF empresa_id ON adicionais
FOR EACH ROW
EXECUTE FUNCTION kidmais_036_empresa_pai_imutavel();

COMMIT;
