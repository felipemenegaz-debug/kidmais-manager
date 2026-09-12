-- Rollback autorizado somente antes de uso. Não remover dados para passar a guarda.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = public, pg_catalog;

LOCK TABLE public.contratos, public.contrato_versoes,
  public.usuarios_administrativos, public.sessoes_administrativas,
  public.limites_autenticacao, public.contrato_fluxos,
  public.contrato_edicoes, public.contrato_documentos,
  public.contrato_assinaturas, public.contrato_pendencias_financeiras
  IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.usuarios_administrativos)
     OR EXISTS (SELECT 1 FROM public.sessoes_administrativas)
     OR EXISTS (SELECT 1 FROM public.limites_autenticacao)
     OR EXISTS (SELECT 1 FROM public.contrato_fluxos)
     OR EXISTS (SELECT 1 FROM public.contrato_edicoes)
     OR EXISTS (SELECT 1 FROM public.contrato_documentos)
     OR EXISTS (SELECT 1 FROM public.contrato_assinaturas)
     OR EXISTS (SELECT 1 FROM public.contrato_pendencias_financeiras)
  THEN
    RAISE EXCEPTION
      'Rollback recusado: há dados do novo bloco. Preservar dados e corrigir para frente.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.contrato_versoes
    WHERE status IN ('ATIVA', 'ASSINADA')
    GROUP BY contrato_id HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Rollback recusado: versões coexistentes incompatíveis com o índice antigo.';
  END IF;
END;
$$;

DROP TRIGGER contrato_versoes_validar_fluxo_trg
  ON public.contrato_versoes;
DROP TRIGGER contrato_versoes_preservar_assinada_trg
  ON public.contrato_versoes;

-- As tabelas novas levam consigo apenas seus próprios índices/triggers.
-- Assinaturas referenciam documentos/usuários/OTP, NÃO sessões.
-- Edições referenciam documentos. Nenhuma prova sofre SET NULL.
DROP TABLE public.contrato_pendencias_financeiras;
DROP TABLE public.contrato_assinaturas;
DROP TABLE public.contrato_edicoes;
DROP TABLE public.contrato_documentos;
DROP TABLE public.contrato_fluxos;
DROP TABLE public.sessoes_administrativas;
DROP TABLE public.limites_autenticacao;
DROP TABLE public.usuarios_administrativos;

DROP FUNCTION public.kidmais_validar_fluxo_contrato();
DROP FUNCTION public.kidmais_preservar_versao_assinada();
DROP FUNCTION public.kidmais_preservar_edicao_contrato();
DROP FUNCTION public.kidmais_bloquear_mutacao_prova_contrato();

ALTER TABLE public.contrato_versoes
  DROP CONSTRAINT contrato_versoes_contrato_id_id_uk;

DROP INDEX public.contrato_versoes_em_preparacao_uk;
CREATE UNIQUE INDEX contrato_versoes_corrente_uk
  ON public.contrato_versoes (contrato_id)
  WHERE status IN ('ATIVA', 'ASSINADA');

COMMIT;
