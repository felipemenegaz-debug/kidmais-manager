BEGIN;

-- Protege atributos de cálculo de uma linha de preço já usada.
-- ativo, observacoes e atualizado_em continuam editáveis.
-- INSERT de tabela nova e o fim normal de vigência em tabelas_preco não são bloqueados.
DO $$ BEGIN
  IF to_regclass('public.precos_pacote') IS NULL
     OR to_regclass('public.precos_adicional') IS NULL
     OR to_regclass('public.fechamentos') IS NULL
     OR to_regclass('public.fechamento_adicionais') IS NULL
     OR to_regclass('public.fechamento_revisoes') IS NULL
     OR to_regclass('public.fechamento_revisao_adicionais') IS NULL
     OR to_regclass('public.fechamento_pacote_snapshots') IS NULL THEN
    RAISE EXCEPTION '030: preço, fechamento ou fotografia ausente.';
  END IF;
  IF to_regprocedure('public.kidmais_030_preco_utilizado()') IS NOT NULL THEN
    RAISE EXCEPTION '030: proteção de preço utilizado já existe.';
  END IF;
END $$;

CREATE FUNCTION kidmais_030_preco_utilizado()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_TABLE_NAME = 'precos_pacote' THEN
    IF NEW.tabela_preco_id IS DISTINCT FROM OLD.tabela_preco_id
       OR NEW.pacote_id IS DISTINCT FROM OLD.pacote_id
       OR NEW.convidados_min IS DISTINCT FROM OLD.convidados_min
       OR NEW.convidados_max IS DISTINCT FROM OLD.convidados_max
       OR NEW.tipo_calculo IS DISTINCT FROM OLD.tipo_calculo
       OR NEW.valor IS DISTINCT FROM OLD.valor
       OR NEW.categoria_horario IS DISTINCT FROM OLD.categoria_horario THEN
      IF EXISTS (SELECT 1 FROM fechamentos WHERE preco_pacote_id = OLD.id)
         OR EXISTS (SELECT 1 FROM fechamento_pacote_snapshots WHERE preco_pacote_id = OLD.id)
         OR EXISTS (SELECT 1 FROM fechamento_revisoes WHERE preco_pacote_id = OLD.id) THEN
        RAISE EXCEPTION '030: preço de pacote utilizado não pode ter atributos de cálculo alterados.';
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'precos_adicional' THEN
    IF NEW.tabela_preco_id IS DISTINCT FROM OLD.tabela_preco_id
       OR NEW.adicional_id IS DISTINCT FROM OLD.adicional_id
       OR NEW.convidados_min IS DISTINCT FROM OLD.convidados_min
       OR NEW.convidados_max IS DISTINCT FROM OLD.convidados_max
       OR NEW.valor IS DISTINCT FROM OLD.valor THEN
      IF EXISTS (SELECT 1 FROM fechamento_adicionais WHERE preco_adicional_id = OLD.id)
         OR EXISTS (SELECT 1 FROM fechamento_revisao_adicionais WHERE preco_adicional_id = OLD.id) THEN
        RAISE EXCEPTION '030: preço de adicional utilizado não pode ter atributos de cálculo alterados.';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER precos_pacote_calculo_utilizado_trg
BEFORE UPDATE ON precos_pacote
FOR EACH ROW
EXECUTE FUNCTION kidmais_030_preco_utilizado();

CREATE TRIGGER precos_adicional_calculo_utilizado_trg
BEFORE UPDATE ON precos_adicional
FOR EACH ROW
EXECUTE FUNCTION kidmais_030_preco_utilizado();

COMMIT;
