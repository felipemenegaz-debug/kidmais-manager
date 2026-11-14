-- PREPARADO, NÃO EXECUTADO. Volta à base anterior à 123 SÓ sem uso: recusa se houver qualquer pessoa, link, sessão,
-- evento ou validação AREA_FAMILIA. Depois do primeiro uso, o rollback operacional é desligar a área (rotas) e manter o schema.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;
LOCK TABLE public.area_familia_eventos, public.area_familia_sessoes, public.festa_links_area, public.festa_pessoas,
  public.limites_contadores, public.validacoes_identidade_cliente IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.festa_pessoas) OR EXISTS (SELECT 1 FROM public.festa_links_area)
     OR EXISTS (SELECT 1 FROM public.area_familia_sessoes) OR EXISTS (SELECT 1 FROM public.area_familia_eventos)
     OR EXISTS (SELECT 1 FROM public.validacoes_identidade_cliente
                 WHERE finalidade = 'AREA_FAMILIA' OR festa_pessoa_id IS NOT NULL OR consumido_por_area_sessao_id IS NOT NULL)
    THEN RAISE EXCEPTION '123: rollback recusado; a área já foi usada.'; END IF;
END $$;
DROP TRIGGER contratos_123_cancelado_trg ON public.contratos;
DROP TRIGGER clientes_123_contato_alterado_trg ON public.clientes;
DROP TRIGGER validacoes_identidade_cliente_area_trg ON public.validacoes_identidade_cliente;
ALTER TABLE public.validacoes_identidade_cliente
  DROP CONSTRAINT validacoes_identidade_cliente_finalidade_check,
  DROP CONSTRAINT validacoes_identidade_cliente_pessoa_area_check,
  DROP CONSTRAINT validacoes_identidade_cliente_pendente_check,
  DROP CONSTRAINT validacoes_identidade_cliente_recuperacao_check,
  DROP CONSTRAINT validacoes_identidade_cliente_confirmada_check,
  DROP CONSTRAINT validacoes_identidade_cliente_consumida_check,
  DROP CONSTRAINT validacoes_identidade_cliente_consumo_consistencia,
  DROP CONSTRAINT validacoes_identidade_cliente_consumidor_finalidade_check;
DROP INDEX public.validacoes_identidade_cliente_area_sessao_uk;
DROP INDEX public.validacoes_identidade_cliente_pessoa_idx;
ALTER TABLE public.validacoes_identidade_cliente DROP COLUMN consumido_por_area_sessao_id, DROP COLUMN festa_pessoa_id;
-- Os checks voltam exatamente ao conteúdo da 010.
ALTER TABLE public.validacoes_identidade_cliente
  ADD CONSTRAINT validacoes_identidade_cliente_finalidade_check CHECK (finalidade IN ('FECHAMENTO_PUBLICO', 'CONTRATO_ACEITE')),
  ADD CONSTRAINT validacoes_identidade_cliente_pendente_check CHECK (
    status <> 'PENDENTE' OR (
      canal IS NOT NULL AND codigo_hash IS NOT NULL AND codigo_expira_em IS NOT NULL
      AND confirmado_em IS NULL AND token_prova_hash IS NULL AND prova_expira_em IS NULL
      AND consumido_em IS NULL AND consumido_por_fechamento_id IS NULL AND consumido_por_contrato_versao_id IS NULL
      AND recuperacao_solicitada_em IS NULL)),
  ADD CONSTRAINT validacoes_identidade_cliente_recuperacao_check CHECK (
    status <> 'RECUPERACAO_PENDENTE' OR (
      codigo_hash IS NULL AND codigo_expira_em IS NULL AND confirmado_em IS NULL AND token_prova_hash IS NULL
      AND prova_expira_em IS NULL AND consumido_em IS NULL AND consumido_por_fechamento_id IS NULL
      AND consumido_por_contrato_versao_id IS NULL AND recuperacao_solicitada_em IS NOT NULL)),
  ADD CONSTRAINT validacoes_identidade_cliente_confirmada_check CHECK (
    status <> 'CONFIRMADA' OR (
      canal IS NOT NULL AND confirmado_em IS NOT NULL AND token_prova_hash IS NOT NULL AND prova_expira_em IS NOT NULL
      AND consumido_em IS NULL AND consumido_por_fechamento_id IS NULL AND consumido_por_contrato_versao_id IS NULL)),
  ADD CONSTRAINT validacoes_identidade_cliente_consumida_check CHECK (
    status <> 'CONSUMIDA' OR (
      confirmado_em IS NOT NULL AND token_prova_hash IS NOT NULL AND prova_expira_em IS NOT NULL AND consumido_em IS NOT NULL
      AND ((consumido_por_fechamento_id IS NOT NULL AND consumido_por_contrato_versao_id IS NULL)
        OR (consumido_por_fechamento_id IS NULL AND consumido_por_contrato_versao_id IS NOT NULL)))),
  ADD CONSTRAINT validacoes_identidade_cliente_consumo_consistencia CHECK (
    (consumido_em IS NULL AND consumido_por_fechamento_id IS NULL AND consumido_por_contrato_versao_id IS NULL)
    OR (consumido_em IS NOT NULL AND ((consumido_por_fechamento_id IS NOT NULL AND consumido_por_contrato_versao_id IS NULL)
        OR (consumido_por_fechamento_id IS NULL AND consumido_por_contrato_versao_id IS NOT NULL)))),
  ADD CONSTRAINT validacoes_identidade_cliente_consumidor_finalidade_check CHECK (
    (finalidade = 'FECHAMENTO_PUBLICO' AND consumido_por_contrato_versao_id IS NULL)
    OR (finalidade = 'CONTRATO_ACEITE' AND consumido_por_fechamento_id IS NULL));
DROP TABLE public.area_familia_eventos;
DROP TABLE public.area_familia_sessoes;
DROP TABLE public.festa_links_area;
DROP TABLE public.festa_pessoas;
DROP TABLE public.limites_contadores;
DROP FUNCTION public.kidmais_123_contrato_cancelado();
DROP FUNCTION public.kidmais_123_pessoa_alterada();
DROP FUNCTION public.kidmais_123_cliente_contato_alterado();
DROP FUNCTION public.kidmais_123_cancelar_codigos(uuid);
DROP FUNCTION public.kidmais_123_revogar_links(uuid, uuid, text);
DROP FUNCTION public.kidmais_123_derrubar_sessoes(uuid, uuid, text);
DROP FUNCTION public.kidmais_123_eventos_somente_acrescimo();
DROP FUNCTION public.kidmais_123_sessao_imutavel();
DROP FUNCTION public.kidmais_123_sessao_exige_prova();
DROP FUNCTION public.kidmais_123_validacao_area_coerente();
DROP FUNCTION public.kidmais_123_festa_pessoas_validar();
DROP FUNCTION public.kidmais_123_empresa_da_festa(uuid);
COMMIT;
