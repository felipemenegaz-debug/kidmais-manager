BEGIN;

-- Retira a tolerância nominal da 038. Não edita o arquivo da 038.
--
-- A 038 recusava vínculo novo empresa/NULL, mas o critério instalado em
-- kidmais_038_falhar_se_incompativel ainda aceitava o pacote_adicional já
-- existente de FESTA_LOCAL para SALADA_PREMIUM. Esta migration não repete
-- essa lista. Não há exceção por código, por nome nem por parâmetro de sessão.
--
-- Política, sem exceção:
--   NULL/NULL é válido;
--   a mesma empresa nos dois lados é válida;
--   empresas diferentes são inválidas;
--   empresa/NULL é inválido;
--   NULL/empresa é inválido.
--
-- A trava das tabelas vem ANTES da validação. A validação não chama a função
-- antiga: ela ainda toleraria a linha histórica. Se qualquer desencontro
-- existir, inclusive esse vínculo, a transação aborta por inteiro. Nada é
-- reescrito, apagado ou associado a uma empresa.
--
-- NULL para empresa no pai continua recusado pela 036. Esta migration não abre
-- exceção genérica nesse gatilho. A atribuição futura dos sete pacotes legados
-- (HG-6) exige uma migration própria, controlada e auditável, que substitua a
-- guarda. Não é um bypass deste gatilho e não inventa a empresa Kidmais.
-- HG-8 permanece aberto. A Foundation 020 não é copiada.

LOCK TABLE
  public.adicionais,
  public.pacote_adicionais,
  public.pacotes,
  public.precos_adicional,
  public.precos_pacote,
  public.tabelas_preco
IN SHARE ROW EXCLUSIVE MODE;

DO $$ BEGIN
  IF to_regclass('public.pacotes') IS NULL
     OR to_regclass('public.tabelas_preco') IS NULL
     OR to_regclass('public.adicionais') IS NULL
     OR to_regclass('public.precos_pacote') IS NULL
     OR to_regclass('public.precos_adicional') IS NULL
     OR to_regclass('public.pacote_adicionais') IS NULL THEN
    RAISE EXCEPTION '040: catálogo comercial ausente.';
  END IF;
  IF to_regprocedure('public.kidmais_038_falhar_se_incompativel()') IS NULL
     OR to_regprocedure('public.kidmais_036_empresa_pai_imutavel()') IS NULL THEN
    RAISE EXCEPTION '040: guarda de tenant anterior ausente.';
  END IF;
  IF to_regprocedure('public.kidmais_040_falhar_se_incompativel()') IS NOT NULL THEN
    RAISE EXCEPTION '040: integridade sem exceção nominal já existe.';
  END IF;
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
  ) THEN
    RAISE EXCEPTION '040: vínculo incompatível. A migration não corrige dado.'
      USING ERRCODE = '23514';
  END IF;
END $$;

CREATE FUNCTION kidmais_040_falhar_se_incompativel()
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
  ) THEN
    RAISE EXCEPTION '040: vínculo incompatível. A migration não corrige dado.'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION kidmais_038_falhar_se_incompativel()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  -- O nome antigo deixa de ser lista branca. HG-6 não entra por aqui.
  PERFORM kidmais_040_falhar_se_incompativel();
END;
$$;

SELECT kidmais_040_falhar_se_incompativel();

COMMIT;
