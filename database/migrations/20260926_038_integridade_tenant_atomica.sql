BEGIN;

-- Fecha a janela da 036 e recusa estado incompatível sem consertar histórico.
--
-- A trava das tabelas do catálogo vem ANTES da validação. Outra transação não
-- consegue inserir vínculo nem mudar empresa_id entre o critério e a guarda.
-- Se o estado for incompatível, a transação inteira aborta. Nada é reescrito.
--
-- Política antes de HG-6 e HG-8:
--   NULL/NULL permanece válido;
--   a mesma empresa nos dois lados é válida;
--   empresas diferentes são inválidas;
--   empresa/NULL e NULL/empresa são inválidos.
--
-- O pacote_adicional já existente de FESTA_LOCAL para SALADA_PREMIUM, com
-- empresa só no pacote, não é corrigido: atribuir empresa ao adicional
-- inventaria um tenant. Ele não é exceção do gatilho. Vínculo novo nesse
-- formato continua recusado. Qualquer outro desencontro aborta esta migration.
--
-- empresa_id do pai continua imutável, inclusive de nulo para empresa.
-- Não há parâmetro de sessão nem exceção genérica. A resolução futura do HG-6,
-- atribuir empresa a legado comprovado, tem de ser uma migration posterior,
-- específica e auditável, que substitua esta guarda. Esta migration não copia
-- a Foundation 020 e não cria membership.

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
    RAISE EXCEPTION '038: catálogo comercial ausente.';
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
  IF to_regprocedure('public.kidmais_038_falhar_se_incompativel()') IS NOT NULL THEN
    RAISE EXCEPTION '038: integridade atômica de tenant já existe.';
  END IF;
END $$;

CREATE FUNCTION kidmais_038_falhar_se_incompativel()
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

SELECT kidmais_038_falhar_se_incompativel();

CREATE OR REPLACE FUNCTION kidmais_036_empresa_pai_imutavel()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Nulo para empresa também é recusado. HG-6 não entra por este gatilho.
  IF NEW.empresa_id IS DISTINCT FROM OLD.empresa_id THEN
    RAISE EXCEPTION '036: a empresa de % não muda.', TG_TABLE_NAME
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pacotes_empresa_imutavel_trg ON pacotes;
CREATE TRIGGER pacotes_empresa_imutavel_trg
BEFORE UPDATE OF empresa_id ON pacotes
FOR EACH ROW
EXECUTE FUNCTION kidmais_036_empresa_pai_imutavel();

DROP TRIGGER IF EXISTS tabelas_preco_empresa_imutavel_trg ON tabelas_preco;
CREATE TRIGGER tabelas_preco_empresa_imutavel_trg
BEFORE UPDATE OF empresa_id ON tabelas_preco
FOR EACH ROW
EXECUTE FUNCTION kidmais_036_empresa_pai_imutavel();

DROP TRIGGER IF EXISTS adicionais_empresa_imutavel_trg ON adicionais;
CREATE TRIGGER adicionais_empresa_imutavel_trg
BEFORE UPDATE OF empresa_id ON adicionais
FOR EACH ROW
EXECUTE FUNCTION kidmais_036_empresa_pai_imutavel();

COMMIT;
