-- 055d — Kidmais Intelligence (IMPORT): rascunho de importação histórica.
--
-- NÃO APLICADA. Exige autorização explícita (docs/OPERACAO_AGENTES.md). Depende da 055c
-- (ia_documentos e ia_extracoes). Cliente e contrato histórico nunca ficam aqui: só nascem pelo
-- Import Engine, nos serviços do Core, depois do Human Gate (055b).
--
--   ia_importacoes   rascunho de importação revisado pelo operador (ImportDraft)
BEGIN;

DO $$ BEGIN
  IF to_regclass('public.ia_documentos') IS NULL OR to_regclass('public.ia_extracoes') IS NULL THEN
    RAISE EXCEPTION '055d exige a 055c (ia_documentos, ia_extracoes).';
  END IF;
  IF to_regclass('public.ia_importacoes') IS NOT NULL THEN
    RAISE EXCEPTION '055d já aplicada (ia_importacoes existe).';
  END IF;
END $$;

CREATE TABLE ia_importacoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  documento_id uuid NOT NULL,
  empresa_id uuid NOT NULL,
  extracao_id uuid NOT NULL,
  -- EM_REVISAO é o único estado aberto; IMPORTADA e DESCARTADA são terminais (a confirmação em si
  -- fica no Human Gate, ia_operacoes).
  status varchar(24) NOT NULL CHECK (status IN ('EM_REVISAO', 'IMPORTADA', 'DESCARTADA')),
  versao integer NOT NULL CHECK (versao > 0),
  dados jsonb NOT NULL CHECK (jsonb_typeof(dados) = 'object'),
  cliente_id uuid,
  resultado jsonb CHECK (resultado IS NULL OR jsonb_typeof(resultado) = 'object'),
  criado_por uuid NOT NULL REFERENCES usuarios_administrativos(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ia_importacoes_documento_fk FOREIGN KEY (documento_id, empresa_id)
    REFERENCES ia_documentos (id, empresa_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  -- A extração revisada é do mesmo documento (e da mesma empresa).
  CONSTRAINT ia_importacoes_extracao_fk FOREIGN KEY (extracao_id, documento_id, empresa_id)
    REFERENCES ia_extracoes (id, documento_id, empresa_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  -- Resultado e cliente existem só na importação concluída.
  CONSTRAINT ia_importacoes_importada_check CHECK (
    (status = 'IMPORTADA' AND resultado IS NOT NULL AND cliente_id IS NOT NULL)
    OR (status <> 'IMPORTADA' AND resultado IS NULL AND cliente_id IS NULL)
  )
);
-- Um documento tem no máximo uma importação aberta ou concluída. A descartada fica como histórico e não
-- bloqueia reabrir o mesmo documento (o upload do mesmo arquivo reaproveita o documento pelo sha256).
CREATE UNIQUE INDEX ia_importacoes_documento_ativa_uk ON ia_importacoes (documento_id) WHERE status <> 'DESCARTADA';

CREATE FUNCTION kidmais_055_importacao_guarda() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ia_importacoes não é apagada.' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.id <> OLD.id OR NEW.empresa_id <> OLD.empresa_id OR NEW.documento_id <> OLD.documento_id
     OR NEW.extracao_id <> OLD.extracao_id OR NEW.criado_por <> OLD.criado_por THEN
    RAISE EXCEPTION 'Identidade da importação é imutável.' USING ERRCODE = 'P0001';
  END IF;
  -- Estados terminais: só EM_REVISAO muda, e só para EM_REVISAO, IMPORTADA ou DESCARTADA.
  IF OLD.status <> 'EM_REVISAO' THEN
    RAISE EXCEPTION 'Importação encerrada não muda.' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.versao <= OLD.versao THEN
    RAISE EXCEPTION 'Versão da importação só avança.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ia_importacoes_055_guarda_trg BEFORE UPDATE OR DELETE ON ia_importacoes
  FOR EACH ROW EXECUTE FUNCTION kidmais_055_importacao_guarda();

COMMIT;
