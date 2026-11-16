-- PREPARADO, NÃO EXECUTADO. Volta à base anterior à 125 (a 123 intacta) SÓ sem uso: recusa se houver aviso de pagamento,
-- pendência configurada para a família, aviso fixo ou evento de tipo da 125. Depois do primeiro uso, o rollback
-- operacional é desligar a área (rotas) e manter o schema.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;
LOCK TABLE public.area_familia_avisos_pagamento, public.festa_pendencias_familia, public.area_familia_aviso_empresa,
  public.area_familia_eventos, public.festa_pessoas, public.festa_links_area IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.area_familia_avisos_pagamento) OR EXISTS (SELECT 1 FROM public.festa_pendencias_familia)
     OR EXISTS (SELECT 1 FROM public.area_familia_aviso_empresa)
     OR EXISTS (SELECT 1 FROM public.area_familia_eventos WHERE tipo IN ('AVISO_PAGAMENTO', 'AVISO_PAGAMENTO_TRATADO',
                 'PENDENCIA_FEITA', 'PENDENCIA_DEVOLVIDA', 'PENDENCIA_VISIBILIDADE', 'AVISO_FIXO'))
    THEN RAISE EXCEPTION '125: rollback recusado; as ações da área já foram usadas.'; END IF;
END $$;
DROP TRIGGER festa_links_area_125_autoria_trg ON public.festa_links_area;
DROP TRIGGER festa_pessoas_125_remocao_trg ON public.festa_pessoas;
DROP TRIGGER area_familia_eventos_125_pessoas_trg ON public.area_familia_eventos;
DROP TABLE public.area_familia_aviso_empresa;
DROP TABLE public.festa_pendencias_familia;
DROP TABLE public.area_familia_avisos_pagamento;
DROP FUNCTION public.kidmais_125_link_por_pessoa();
DROP FUNCTION public.kidmais_125_remocao_por_pessoa();
DROP FUNCTION public.kidmais_125_evento_pessoas_da_festa();
DROP FUNCTION public.kidmais_125_pendencia_familia_validar();
DROP FUNCTION public.kidmais_125_aviso_pagamento_validar();
DROP FUNCTION public.kidmais_125_contratante_ativo(uuid, uuid);
DROP FUNCTION public.kidmais_125_pessoa_ativa(uuid, uuid);
-- O CHECK dos tipos volta exatamente ao da 123 (mesmo nome, mesma lista).
ALTER TABLE public.area_familia_eventos DROP CONSTRAINT area_familia_eventos_tipo_check;
ALTER TABLE public.area_familia_eventos ADD CONSTRAINT area_familia_eventos_tipo_check CHECK (tipo IN ('LINK_GERADO', 'LINK_REVOGADO',
  'ENTRADA', 'SAIR', 'SAIR_DE_TODOS', 'BUFFET_DESCONECTOU', 'PESSOA_CADASTRADA', 'PESSOA_REMOVIDA', 'CONTATO_ALTERADO', 'SESSOES_DERRUBADAS'));
COMMIT;
