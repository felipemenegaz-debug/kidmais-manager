-- 073 postcheck somente leitura. Não declara autorização ou aplicação em outro ambiente.
DO $$
DECLARE nome text;
BEGIN
  FOREACH nome IN ARRAY ARRAY['convite_carteiras','convite_consumos','convite_orcamento_global','convites','convite_artes','convite_geracoes','convite_respostas','convite_limites_http','convite_eventos'] LOOP
    IF to_regclass('public.' || nome) IS NULL THEN RAISE EXCEPTION '073 postcheck: tabela ausente: %', nome; END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.convites'::regclass AND tgname='convite_vinculo' AND NOT tgisinternal AND tgenabled='O') THEN
    RAISE EXCEPTION '073 postcheck: trigger de vínculo ausente ou desabilitado.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('public.convite_uma_geracao_pendente') AND indisunique AND indisvalid AND indpred IS NOT NULL) THEN
    RAISE EXCEPTION '073 postcheck: índice de geração pendente ausente/inválido.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.convites ci LEFT JOIN public.festas f ON f.id=ci.festa_id
    LEFT JOIN public.contratos co ON co.id=f.contrato_id LEFT JOIN public.fechamentos fe ON fe.id=co.fechamento_id
    WHERE fe.id IS NULL OR fe.empresa_id IS DISTINCT FROM ci.empresa_id OR fe.cliente_id IS DISTINCT FROM ci.cliente_id
      OR fe.estabelecimento_id IS DISTINCT FROM ci.estabelecimento_id) THEN
    RAISE EXCEPTION '073 postcheck: vínculo de convite divergente.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.convites WHERE usado_festa>limite_festa OR usado_cliente>limite_cliente) THEN
    RAISE EXCEPTION '073 postcheck: uso acima da cota.';
  END IF;
  RAISE NOTICE '073 postcheck OK.';
END $$;
