-- 078 — Catálogo do buffet por empresa. PREPARADA, NÃO APLICADA.
-- Antes: buffet_categorias/buffet_itens globais (021/022/050); cada empresa só escolhia quais categorias usar, e os itens
-- (nomes do cardápio da Kidmais) apareciam para todas.
-- Depois:
--   * categorias e itens ganham empresa_id (imutável); o catálogo atual passa a ser da empresa `kidmais` (046), se existir
--     neste banco — o cardápio da Kidmais não muda (mesmos ids, códigos, nomes, ordem e situação);
--   * outra empresa cujos pacotes ou adicionais JÁ usam categorias/itens desse catálogo recebe uma CÓPIA só do que usa
--     (categorias usadas com os itens delas; itens sem categoria usados) e os vínculos dela passam para as cópias;
--     empresa que não usa nada não recebe nada (novos buffets começam sem catálogo);
--   * pedidos, escolhas de buffet e fotografias (029/051) NÃO são tocados: continuam apontando para os ids originais;
--   * código único por empresa; gatilhos recusam vínculo entre empresas distintas (pacote, item, adicional, escolha nova).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_catalog;

DO $$ BEGIN
  -- Primeiro: a própria 078 remove o índice da 050 conferido abaixo; numa reaplicação, a mensagem certa é esta.
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'buffet_categorias' AND column_name = 'empresa_id') THEN
    RAISE EXCEPTION '078 já aplicada.';
  END IF;
  IF to_regclass('public.empresas') IS NULL OR to_regclass('public.buffet_categorias') IS NULL OR to_regclass('public.buffet_itens') IS NULL THEN
    RAISE EXCEPTION '078 exige empresas (031) e o catálogo do buffet (021).';
  END IF;
  IF to_regclass('public.pacote_itens_especificos') IS NULL OR to_regclass('public.buffet_itens_codigo_sem_categoria_uk') IS NULL THEN
    RAISE EXCEPTION '078 exige a 050 (itens sem categoria).';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'adicionais' AND column_name = 'origem_buffet_item_id') THEN
    RAISE EXCEPTION '078 exige a 070 (adicionais do buffet).';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'fechamentos' AND column_name = 'empresa_id') THEN
    RAISE EXCEPTION '078 exige fechamentos.empresa_id (053).';
  END IF;
  IF to_regprocedure('public.kidmais_034_recusar_empresa_distinta(uuid,uuid,text)') IS NULL THEN
    RAISE EXCEPTION '078 exige a 034 (integridade de tenant).';
  END IF;
  IF (SELECT count(*) FROM empresas WHERE codigo = 'kidmais') > 1 THEN
    RAISE EXCEPTION '078: mais de uma empresa kidmais.';
  END IF;
END $$;

ALTER TABLE buffet_categorias ADD COLUMN empresa_id uuid REFERENCES empresas(id) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE buffet_itens ADD COLUMN empresa_id uuid REFERENCES empresas(id) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- 1. Catálogo atual → empresa kidmais (NULL se ela não existir neste banco: fica fora do alcance de qualquer empresa).
UPDATE buffet_categorias SET empresa_id = (SELECT id FROM empresas WHERE codigo = 'kidmais');
UPDATE buffet_itens SET empresa_id = (SELECT id FROM empresas WHERE codigo = 'kidmais');

-- 2. Unicidade POR EMPRESA antes de qualquer cópia: as cópias repetem o código da categoria e o código dos itens sem
--    categoria em outra empresa, o que a unicidade global (021: UNIQUE(codigo); 050: codigo WHERE categoria_id IS NULL)
--    recusaria. Itens com categoria já são únicos por categoria (a cópia vai para a categoria copiada). Catálogo sem
--    empresa mantém a regra antiga, isolado.
DO $$
DECLARE nome_restricao text;
BEGIN
  SELECT con.conname INTO nome_restricao
    FROM pg_constraint con
   WHERE con.conrelid = 'public.buffet_categorias'::regclass AND con.contype = 'u'
     AND con.conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'public.buffet_categorias'::regclass AND attname = 'codigo')]::smallint[];
  IF nome_restricao IS NULL THEN
    RAISE EXCEPTION '078: restrição única global de buffet_categorias.codigo não encontrada.';
  END IF;
  EXECUTE format('ALTER TABLE buffet_categorias DROP CONSTRAINT %I', nome_restricao);
END $$;
CREATE UNIQUE INDEX buffet_categorias_empresa_codigo_uk ON buffet_categorias (empresa_id, codigo) WHERE empresa_id IS NOT NULL;
CREATE UNIQUE INDEX buffet_categorias_codigo_sem_empresa_uk ON buffet_categorias (codigo) WHERE empresa_id IS NULL;
DROP INDEX buffet_itens_codigo_sem_categoria_uk;
CREATE UNIQUE INDEX buffet_itens_empresa_codigo_sem_categoria_uk ON buffet_itens (empresa_id, codigo) WHERE categoria_id IS NULL AND empresa_id IS NOT NULL;
CREATE UNIQUE INDEX buffet_itens_codigo_sem_categoria_sem_empresa_uk ON buffet_itens (codigo) WHERE categoria_id IS NULL AND empresa_id IS NULL;
CREATE INDEX buffet_categorias_empresa_idx ON buffet_categorias (empresa_id, ordem_exibicao, nome) WHERE ativo;
CREATE INDEX buffet_itens_empresa_idx ON buffet_itens (empresa_id, categoria_id) WHERE ativo;

-- 3. Cópia só do que cada OUTRA empresa já usa (pacotes da empresa ou adicionais com origem no buffet).
CREATE TEMP TABLE m078_categorias (empresa_id uuid NOT NULL, origem uuid NOT NULL, copia uuid NOT NULL DEFAULT gen_random_uuid(),
  PRIMARY KEY (empresa_id, origem)) ON COMMIT DROP;
CREATE TEMP TABLE m078_itens (empresa_id uuid NOT NULL, origem uuid NOT NULL, copia uuid NOT NULL DEFAULT gen_random_uuid(),
  PRIMARY KEY (empresa_id, origem)) ON COMMIT DROP;

INSERT INTO m078_categorias (empresa_id, origem)
SELECT DISTINCT u.empresa_id, u.categoria_id
  FROM (
    SELECT p.empresa_id, pbc.categoria_id FROM pacote_buffet_categorias pbc JOIN pacotes p ON p.id = pbc.pacote_id
    UNION SELECT p.empresa_id, i.categoria_id FROM pacote_itens_especificos pe JOIN pacotes p ON p.id = pe.pacote_id
                JOIN buffet_itens i ON i.id = pe.item_id WHERE i.categoria_id IS NOT NULL
    UNION SELECT a.empresa_id, a.origem_buffet_categoria_id FROM adicionais a WHERE a.origem_buffet_categoria_id IS NOT NULL
    UNION SELECT a.empresa_id, i.categoria_id FROM adicionais a JOIN buffet_itens i ON i.id = a.origem_buffet_item_id
                WHERE i.categoria_id IS NOT NULL
  ) u
  JOIN buffet_categorias c ON c.id = u.categoria_id
 WHERE u.empresa_id IS NOT NULL AND u.empresa_id IS DISTINCT FROM c.empresa_id;

-- Itens das categorias copiadas (todos: o modo TODOS_ATIVOS usa os ativos) + itens sem categoria usados pela empresa.
INSERT INTO m078_itens (empresa_id, origem)
SELECT m.empresa_id, i.id FROM m078_categorias m JOIN buffet_itens i ON i.categoria_id = m.origem;
INSERT INTO m078_itens (empresa_id, origem)
SELECT DISTINCT u.empresa_id, u.item_id
  FROM (
    SELECT p.empresa_id, pe.item_id FROM pacote_itens_especificos pe JOIN pacotes p ON p.id = pe.pacote_id
    UNION SELECT a.empresa_id, a.origem_buffet_item_id FROM adicionais a WHERE a.origem_buffet_item_id IS NOT NULL
  ) u
  JOIN buffet_itens i ON i.id = u.item_id
 WHERE i.categoria_id IS NULL AND u.empresa_id IS NOT NULL AND u.empresa_id IS DISTINCT FROM i.empresa_id
ON CONFLICT DO NOTHING;

INSERT INTO buffet_categorias (id, empresa_id, codigo, nome, descricao, ordem_exibicao, ativo, arquivado_em)
SELECT m.copia, m.empresa_id, c.codigo, c.nome, c.descricao, c.ordem_exibicao, c.ativo, c.arquivado_em
  FROM m078_categorias m JOIN buffet_categorias c ON c.id = m.origem;

INSERT INTO buffet_itens (id, empresa_id, categoria_id, codigo, nome, descricao, ordem_exibicao, ativo, arquivado_em)
SELECT mi.copia, mi.empresa_id, mc.copia, i.codigo, i.nome, i.descricao, i.ordem_exibicao, i.ativo, i.arquivado_em
  FROM m078_itens mi JOIN buffet_itens i ON i.id = mi.origem
  LEFT JOIN m078_categorias mc ON mc.empresa_id = mi.empresa_id AND mc.origem = i.categoria_id;

-- Vínculos da outra empresa passam para as cópias (mesmos modos, limites e situação). Pedidos e fotografias: intocados.
INSERT INTO pacote_buffet_categorias (pacote_id, categoria_id, modo_itens, escolhas_min, escolhas_max, ativo)
SELECT pbc.pacote_id, m.copia, pbc.modo_itens, pbc.escolhas_min, pbc.escolhas_max, pbc.ativo
  FROM pacote_buffet_categorias pbc JOIN pacotes p ON p.id = pbc.pacote_id
  JOIN m078_categorias m ON m.empresa_id = p.empresa_id AND m.origem = pbc.categoria_id;
INSERT INTO pacote_buffet_itens (pacote_id, categoria_id, item_id)
SELECT pbi.pacote_id, mc.copia, mi.copia
  FROM pacote_buffet_itens pbi JOIN pacotes p ON p.id = pbi.pacote_id
  JOIN m078_categorias mc ON mc.empresa_id = p.empresa_id AND mc.origem = pbi.categoria_id
  JOIN m078_itens mi ON mi.empresa_id = p.empresa_id AND mi.origem = pbi.item_id;
DELETE FROM pacote_buffet_itens pbi USING pacotes p, m078_categorias m
 WHERE p.id = pbi.pacote_id AND m.empresa_id = p.empresa_id AND m.origem = pbi.categoria_id;
DELETE FROM pacote_buffet_categorias pbc USING pacotes p, m078_categorias m
 WHERE p.id = pbc.pacote_id AND m.empresa_id = p.empresa_id AND m.origem = pbc.categoria_id;
INSERT INTO pacote_itens_especificos (pacote_id, item_id)
SELECT pe.pacote_id, mi.copia
  FROM pacote_itens_especificos pe JOIN pacotes p ON p.id = pe.pacote_id
  JOIN m078_itens mi ON mi.empresa_id = p.empresa_id AND mi.origem = pe.item_id;
DELETE FROM pacote_itens_especificos pe USING pacotes p, m078_itens m
 WHERE p.id = pe.pacote_id AND m.empresa_id = p.empresa_id AND m.origem = pe.item_id;
UPDATE adicionais a SET origem_buffet_categoria_id = m.copia
  FROM m078_categorias m WHERE m.empresa_id = a.empresa_id AND m.origem = a.origem_buffet_categoria_id;
UPDATE adicionais a SET origem_buffet_item_id = m.copia
  FROM m078_itens m WHERE m.empresa_id = a.empresa_id AND m.origem = a.origem_buffet_item_id;

-- 4. Integridade: empresa imutável; nenhum vínculo entre empresas distintas (mesma regra da 034: NULL só com NULL).
CREATE FUNCTION kidmais_078_empresa_imutavel() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.empresa_id IS DISTINCT FROM OLD.empresa_id THEN
    RAISE EXCEPTION '078: a empresa de % não muda.', TG_TABLE_NAME USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER buffet_categorias_empresa_imutavel_trg BEFORE UPDATE OF empresa_id ON buffet_categorias
FOR EACH ROW EXECUTE FUNCTION kidmais_078_empresa_imutavel();
CREATE TRIGGER buffet_itens_empresa_imutavel_trg BEFORE UPDATE OF empresa_id ON buffet_itens
FOR EACH ROW EXECUTE FUNCTION kidmais_078_empresa_imutavel();

CREATE FUNCTION kidmais_078_item_categoria_empresa() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.categoria_id IS NOT NULL THEN
    PERFORM kidmais_034_recusar_empresa_distinta(NEW.empresa_id, (SELECT empresa_id FROM buffet_categorias WHERE id = NEW.categoria_id), 'item do buffet');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER buffet_itens_categoria_empresa_trg BEFORE INSERT OR UPDATE OF categoria_id, empresa_id ON buffet_itens
FOR EACH ROW EXECUTE FUNCTION kidmais_078_item_categoria_empresa();

CREATE FUNCTION kidmais_078_pacote_buffet_empresa() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE empresa_pacote uuid;
BEGIN
  SELECT empresa_id INTO empresa_pacote FROM pacotes WHERE id = NEW.pacote_id;
  IF TG_TABLE_NAME = 'pacote_buffet_categorias' THEN
    PERFORM kidmais_034_recusar_empresa_distinta(empresa_pacote, (SELECT empresa_id FROM buffet_categorias WHERE id = NEW.categoria_id), 'categoria do buffet no pacote');
  ELSE
    PERFORM kidmais_034_recusar_empresa_distinta(empresa_pacote, (SELECT empresa_id FROM buffet_itens WHERE id = NEW.item_id), 'item do buffet no pacote');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pacote_buffet_categorias_empresa_trg BEFORE INSERT OR UPDATE OF pacote_id, categoria_id ON pacote_buffet_categorias
FOR EACH ROW EXECUTE FUNCTION kidmais_078_pacote_buffet_empresa();
CREATE TRIGGER pacote_buffet_itens_empresa_trg BEFORE INSERT OR UPDATE OF pacote_id, item_id ON pacote_buffet_itens
FOR EACH ROW EXECUTE FUNCTION kidmais_078_pacote_buffet_empresa();
CREATE TRIGGER pacote_itens_especificos_empresa_trg BEFORE INSERT OR UPDATE OF pacote_id, item_id ON pacote_itens_especificos
FOR EACH ROW EXECUTE FUNCTION kidmais_078_pacote_buffet_empresa();

CREATE FUNCTION kidmais_078_adicional_origem_empresa() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.origem_buffet_categoria_id IS NOT NULL THEN
    PERFORM kidmais_034_recusar_empresa_distinta(NEW.empresa_id, (SELECT empresa_id FROM buffet_categorias WHERE id = NEW.origem_buffet_categoria_id), 'adicional do buffet');
  END IF;
  IF NEW.origem_buffet_item_id IS NOT NULL THEN
    PERFORM kidmais_034_recusar_empresa_distinta(NEW.empresa_id, (SELECT empresa_id FROM buffet_itens WHERE id = NEW.origem_buffet_item_id), 'adicional do buffet');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER adicionais_origem_buffet_empresa_trg BEFORE INSERT OR UPDATE OF origem_buffet_categoria_id, origem_buffet_item_id ON adicionais
FOR EACH ROW EXECUTE FUNCTION kidmais_078_adicional_origem_empresa();

-- Escolhas NOVAS de buffet só com o catálogo da empresa do pedido (as já gravadas não são revalidadas).
CREATE FUNCTION kidmais_078_escolha_buffet_empresa() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM kidmais_034_recusar_empresa_distinta(
    (SELECT f.empresa_id FROM fechamento_buffet_snapshots s JOIN fechamentos f ON f.id = s.fechamento_id WHERE s.id = NEW.snapshot_id),
    (SELECT empresa_id FROM buffet_categorias WHERE id = NEW.categoria_id), 'escolha do buffet');
  RETURN NEW;
END $$;
CREATE TRIGGER fechamento_buffet_escolhas_empresa_trg BEFORE INSERT ON fechamento_buffet_escolhas
FOR EACH ROW EXECUTE FUNCTION kidmais_078_escolha_buffet_empresa();

COMMIT;
