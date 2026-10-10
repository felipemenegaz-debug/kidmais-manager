-- 078 rollback PREPARADO, NÃO EXECUTADO. Volta ao catálogo global.
-- Só é automático quando o catálogo inteiro tem um único dono (a Kidmais, ou nenhum): nenhuma empresa recebeu cópia e
-- nenhuma criou o próprio catálogo. ABORTA caso contrário — cópias e catálogos próprios estão ligados a pacotes,
-- adicionais e possivelmente a pedidos; desfazer exige revisão manual (correção para frente).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_catalog;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'buffet_categorias' AND column_name = 'empresa_id') THEN
    RAISE EXCEPTION '078 rollback: não aplicada.';
  END IF;
  IF EXISTS (SELECT 1 FROM buffet_categorias c JOIN empresas e ON e.id = c.empresa_id WHERE e.codigo <> 'kidmais')
     OR EXISTS (SELECT 1 FROM buffet_itens i JOIN empresas e ON e.id = i.empresa_id WHERE e.codigo <> 'kidmais')
     OR (SELECT count(*) FROM (SELECT DISTINCT empresa_id FROM buffet_categorias UNION SELECT DISTINCT empresa_id FROM buffet_itens) x) > 1 THEN
    RAISE EXCEPTION '078 rollback: há catálogo de mais de uma empresa (cópias ou catálogo próprio); revisar manualmente.';
  END IF;
  IF EXISTS (SELECT codigo FROM buffet_categorias GROUP BY codigo HAVING count(*) > 1)
     OR EXISTS (SELECT codigo FROM buffet_itens WHERE categoria_id IS NULL GROUP BY codigo HAVING count(*) > 1) THEN
    RAISE EXCEPTION '078 rollback: códigos repetidos impedem a unicidade global.';
  END IF;
END $$;
DROP TRIGGER fechamento_buffet_escolhas_empresa_trg ON fechamento_buffet_escolhas;
DROP TRIGGER adicionais_origem_buffet_empresa_trg ON adicionais;
DROP TRIGGER pacote_itens_especificos_empresa_trg ON pacote_itens_especificos;
DROP TRIGGER pacote_buffet_itens_empresa_trg ON pacote_buffet_itens;
DROP TRIGGER pacote_buffet_categorias_empresa_trg ON pacote_buffet_categorias;
DROP TRIGGER buffet_itens_categoria_empresa_trg ON buffet_itens;
DROP TRIGGER buffet_itens_empresa_imutavel_trg ON buffet_itens;
DROP TRIGGER buffet_categorias_empresa_imutavel_trg ON buffet_categorias;
DROP FUNCTION kidmais_078_escolha_buffet_empresa();
DROP FUNCTION kidmais_078_adicional_origem_empresa();
DROP FUNCTION kidmais_078_pacote_buffet_empresa();
DROP FUNCTION kidmais_078_item_categoria_empresa();
DROP FUNCTION kidmais_078_empresa_imutavel();
DROP INDEX buffet_itens_empresa_idx;
DROP INDEX buffet_categorias_empresa_idx;
DROP INDEX buffet_itens_codigo_sem_categoria_sem_empresa_uk;
DROP INDEX buffet_itens_empresa_codigo_sem_categoria_uk;
DROP INDEX buffet_categorias_codigo_sem_empresa_uk;
DROP INDEX buffet_categorias_empresa_codigo_uk;
CREATE UNIQUE INDEX buffet_itens_codigo_sem_categoria_uk ON buffet_itens (codigo) WHERE categoria_id IS NULL;
ALTER TABLE buffet_categorias ADD CONSTRAINT buffet_categorias_codigo_key UNIQUE (codigo);
ALTER TABLE buffet_itens DROP COLUMN empresa_id;
ALTER TABLE buffet_categorias DROP COLUMN empresa_id;
COMMIT;
