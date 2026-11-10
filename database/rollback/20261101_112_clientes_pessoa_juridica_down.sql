-- PREPARADO, NÃO EXECUTADO. Volta à base anterior à 112 SÓ sem nenhum dado de PJ (R21-3): recusa, em qualquer status
-- (ATIVO, INATIVO, MESCLADO), se houver tipo_pessoa diferente de PF ou qualquer coluna removível preenchida.
-- Recusado = nenhum efeito (uma transação só). Depois da primeira PJ, só correção para frente.
-- Exige o código compatível ainda publicado (sem a 112 ele volta às consultas base e recusa PJ).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;
LOCK TABLE public.clientes IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.clientes WHERE tipo_pessoa <> 'PF' OR cnpj IS NOT NULL OR razao_social IS NOT NULL
       OR nome_fantasia IS NOT NULL OR representante_nome IS NOT NULL OR representante_cpf IS NOT NULL)
    THEN RAISE EXCEPTION '112: rollback recusado; existe cliente PJ ou dado de PJ preenchido.'; END IF;
END $$;
DROP TRIGGER mesclagens_clientes_112_mesmo_tipo ON public.mesclagens_clientes;
DROP TRIGGER clientes_112_mesclagem_mesmo_tipo ON public.clientes;
DROP FUNCTION public.kidmais_112_mesclagem_mesmo_tipo();
DROP INDEX public.clientes_cnpj_empresa_canonico_uk;
ALTER TABLE public.clientes
  DROP CONSTRAINT clientes_112_representante_nome,
  DROP CONSTRAINT clientes_112_pj_identidade,
  DROP CONSTRAINT clientes_112_pf_sem_campos_pj,
  DROP CONSTRAINT clientes_112_textos_nao_vazios,
  DROP CONSTRAINT clientes_112_representante_cpf_formato,
  DROP CONSTRAINT clientes_112_cnpj_formato,
  DROP CONSTRAINT clientes_112_tipo_pessoa_check;
ALTER TABLE public.clientes
  DROP COLUMN representante_cpf,
  DROP COLUMN representante_nome,
  DROP COLUMN nome_fantasia,
  DROP COLUMN razao_social,
  DROP COLUMN cnpj,
  DROP COLUMN tipo_pessoa;
DROP FUNCTION public.kidmais_112_cnpj_valido(text);
DROP FUNCTION public.kidmais_112_cpf_valido(text);
COMMIT;
