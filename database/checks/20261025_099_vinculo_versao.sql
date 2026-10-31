-- Somente leitura. Pré-condição de produção da 099 (plano de promoção de 25/10/2026, B-2), complementar ao precheck.
-- A 099 troca o corpo de convite_validar_vinculo(): além do vínculo festa/contrato/fechamento/empresa/cliente/
-- estabelecimento que a 073 já exigia, passa a exigir que versao_contrato_id seja uma versão DO CONTRATO DA FESTA. O
-- gatilho roda em todo INSERT e UPDATE de convites (consumo de geração, editor, cotas), então um convite existente que não
-- satisfaça a regra nova ficaria impossível de atualizar depois da 099. Recusa se houver qualquer convite vinculado nessa
-- situação; informa só a contagem (sem ids). Não corrige dados.
DO $$
DECLARE incompativeis bigint;
BEGIN
  SELECT count(*) INTO incompativeis FROM convites cv
   WHERE cv.festa_id IS NOT NULL AND NOT EXISTS (
     SELECT 1 FROM festas f JOIN contratos c ON c.id=f.contrato_id JOIN fechamentos fe ON fe.id=c.fechamento_id
      WHERE f.id=cv.festa_id AND fe.empresa_id=cv.empresa_id AND fe.cliente_id=cv.cliente_id
        AND fe.estabelecimento_id IS NOT DISTINCT FROM cv.estabelecimento_id
        AND EXISTS (SELECT 1 FROM contrato_versoes v WHERE v.id=cv.versao_contrato_id AND v.contrato_id=c.id));
  IF incompativeis > 0 THEN
    RAISE EXCEPTION '099: % convite(s) vinculado(s) que a regra nova recusaria em qualquer atualização', incompativeis;
  END IF;
END $$;
