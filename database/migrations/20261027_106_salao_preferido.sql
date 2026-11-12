-- 106: salão de preferência do cliente (fase S-D do fluxo "cliente com 2 salões"; plano S-E/S-D rev. 4.1 aprovado pelo
-- Astra em 27/10/2026, D5/R-D1/R-D5/R3-D1/R3-D2/R4-D1). Número: a 105 é do MCP por assinatura (local) e a 101 do
-- envio do link (local); a 104 é da S-E.
--   * fechamentos.salao_preferido_id: escolha do cliente na tela "Conheça os salões". NÃO ocupa a agenda (a ocupação
--     continua nascendo na assinatura, com o salão do documento); a emissão usa a preferência e nunca troca em silêncio.
--   * FK composta (empresa_id, salao_preferido_id) → agenda_saloes(empresa_id, id) (agenda_saloes_empresa_id_uk, 093),
--     ON DELETE/UPDATE RESTRICT, não adiável.
--   * Gatilho em fechamentos (BEFORE INSERT OR UPDATE OF salao_preferido_id, empresa_id, estabelecimento_id): com
--     preferência não nula, lê o salão FOR SHARE e exige a mesma empresa e a mesma unidade (IS NOT DISTINCT FROM; NULL
--     só com NULL, regra da 094).
--   * Gatilho em agenda_saloes (BEFORE UPDATE OF empresa_id, estabelecimento_id): recusa mudar o escopo de um salão
--     referenciado por QUALQUER festa (inclusive cancelada).
--   * As duas funções são VOLATILE (consulta interna com snapshot novo a cada comando em READ COMMITTED) e com
--     search_path fixo: é o que serializa preferência × mudança de escopo (R3-D2/R4-D1).
--   * Índice parcial (salao_preferido_id) WHERE salao_preferido_id IS NOT NULL.
-- Rollback: database/rollback/20261027_106_salao_preferido_down.sql (recusado com qualquer valor gravado).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
SET LOCAL search_path = public, pg_catalog;
DO $$
BEGIN
  IF to_regclass('public.agenda_salao_fotos') IS NULL OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.fechamentos'::regclass
       AND attname = 'salao_id' AND NOT attisdropped) THEN
    RAISE EXCEPTION '106: precheck falhou (094 e 102 são pré-requisitos); nada alterado';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.agenda_saloes'::regclass AND conname = 'agenda_saloes_empresa_id_uk' AND contype = 'u') THEN
    RAISE EXCEPTION '106: precheck falhou (agenda_saloes_empresa_id_uk ausente); nada alterado';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.fechamentos'::regclass AND attname = 'salao_preferido_id' AND NOT attisdropped)
     OR to_regprocedure('public.kidmais106_salao_preferido_escopo()') IS NOT NULL
     OR to_regprocedure('public.kidmais106_salao_escopo_referenciado()') IS NOT NULL
     OR to_regclass('public.fechamentos_106_salao_preferido_idx') IS NOT NULL THEN
    RAISE EXCEPTION '106: precheck falhou (já aplicada ou parcial); nada alterado';
  END IF;
END $$;
ALTER TABLE public.fechamentos ADD COLUMN salao_preferido_id uuid;
ALTER TABLE public.fechamentos ADD CONSTRAINT fechamentos_106_salao_preferido_fk FOREIGN KEY (empresa_id, salao_preferido_id)
  REFERENCES public.agenda_saloes (empresa_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE INDEX fechamentos_106_salao_preferido_idx ON public.fechamentos (salao_preferido_id) WHERE salao_preferido_id IS NOT NULL;
CREATE FUNCTION public.kidmais106_salao_preferido_escopo() RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path = public, pg_catalog AS $$
DECLARE s record;
BEGIN
  IF NEW.salao_preferido_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT empresa_id, estabelecimento_id INTO s FROM public.agenda_saloes WHERE id = NEW.salao_preferido_id FOR SHARE;
  IF NOT FOUND OR s.empresa_id IS DISTINCT FROM NEW.empresa_id OR s.estabelecimento_id IS DISTINCT FROM NEW.estabelecimento_id THEN
    RAISE EXCEPTION '106: salão de preferência de outra empresa ou unidade' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fechamentos_106_salao_preferido_trg BEFORE INSERT OR UPDATE OF salao_preferido_id, empresa_id, estabelecimento_id ON public.fechamentos
  FOR EACH ROW EXECUTE FUNCTION public.kidmais106_salao_preferido_escopo();
CREATE FUNCTION public.kidmais106_salao_escopo_referenciado() RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path = public, pg_catalog AS $$
BEGIN
  IF (NEW.empresa_id IS DISTINCT FROM OLD.empresa_id OR NEW.estabelecimento_id IS DISTINCT FROM OLD.estabelecimento_id)
     AND EXISTS (SELECT 1 FROM public.fechamentos WHERE salao_preferido_id = OLD.id) THEN
    RAISE EXCEPTION '106: salão escolhido por cliente não muda de empresa ou unidade' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agenda_saloes_106_escopo_trg BEFORE UPDATE OF empresa_id, estabelecimento_id ON public.agenda_saloes
  FOR EACH ROW EXECUTE FUNCTION public.kidmais106_salao_escopo_referenciado();
COMMIT;
