BEGIN;

-- Rollback apenas da estrutura 021A, antes do seed e da ativação.
-- Recusa remover qualquer escolha, configuração, documento ou cortesia usada.
DO $$ BEGIN
  IF to_regclass('public.fechamento_buffet_escolhas') IS NULL OR
     to_regclass('public.adicional_categorias') IS NULL THEN
    RAISE EXCEPTION 'Estrutura 021A incompleta; investigar antes de reverter.';
  END IF;
  IF EXISTS (SELECT 1 FROM buffet_categorias) OR
     EXISTS (SELECT 1 FROM buffet_itens) OR
     EXISTS (SELECT 1 FROM pacote_buffet_categorias) OR
     EXISTS (SELECT 1 FROM pacote_buffet_itens) OR
     EXISTS (SELECT 1 FROM fechamento_buffet_snapshots) OR
     EXISTS (SELECT 1 FROM fechamento_buffet_escolhas) OR
     EXISTS (SELECT 1 FROM pacote_adicionais) OR
     EXISTS (SELECT 1 FROM documentos_publicos) OR
     EXISTS (SELECT 1 FROM precos_adicional WHERE valor = 0) THEN
    RAISE EXCEPTION '021A já está em uso; rollback automático recusado.';
  END IF;
  IF EXISTS (SELECT 1 FROM adicionais a JOIN adicional_categorias c ON c.id=a.categoria_id
             WHERE c.codigo IS DISTINCT FROM a.categoria) THEN
    RAISE EXCEPTION 'Categoria legada divergiu da relação 021A.';
  END IF;
END $$;

DROP TABLE documentos_publicos;
DROP TABLE pacote_adicionais;
ALTER TABLE adicionais DROP COLUMN categoria_id;
DROP TABLE adicional_categorias;
DROP TABLE fechamento_buffet_escolhas;
DROP TABLE fechamento_buffet_snapshots;
DROP TABLE pacote_buffet_itens;
DROP TABLE pacote_buffet_categorias;
DROP TABLE buffet_itens;
DROP TABLE buffet_categorias;
ALTER TABLE precos_adicional DROP CONSTRAINT precos_adicional_valor_check;
ALTER TABLE precos_adicional ADD CONSTRAINT precos_adicional_valor_check CHECK (valor > 0);

COMMIT;
