BEGIN READ ONLY;
DO $$ BEGIN
 IF to_regclass('public.festas') IS NULL OR to_regclass('public.whatsapp_onboarding_tentativas') IS NULL
 THEN RAISE EXCEPTION 'Precheck 019: cadeia até 018 necessária'; END IF;
 IF to_regprocedure('public.kidmais019_ocupa(uuid)') IS NOT NULL
 THEN RAISE EXCEPTION 'Precheck 019: migration já instalada; não reaplicar'; END IF;
 IF EXISTS(SELECT 1 FROM public.contratos c LEFT JOIN public.contrato_fluxos cf ON cf.contrato_id=c.id
 LEFT JOIN public.contrato_versoes v ON v.id=cf.versao_vigente_id
 LEFT JOIN public.contrato_edicoes e ON e.contrato_versao_id=v.id
 WHERE c.status='ASSINADO' AND (v.id IS NULL OR v.status<>'ASSINADA' OR e.estado IS DISTINCT FROM 'CONCLUIDA'
 OR (SELECT count(DISTINCT parte) FROM public.contrato_assinaturas WHERE contrato_versao_id=v.id)<>2))
 THEN RAISE EXCEPTION 'Precheck 019: assinatura legada/incompleta exige revisão'; END IF;
END $$;
-- Candidate occupancy after activation, including contracts before payment.
WITH ocupacao AS (
 SELECT f.id,f.data_evento,f.horario_inicio,f.horario_fim FROM public.fechamentos f
 WHERE f.status<>'CANCELADO' AND NOT EXISTS(SELECT 1 FROM public.contratos c WHERE c.fechamento_id=f.id AND c.status='CANCELADO')
 AND (f.status='CONFIRMADO' OR EXISTS(SELECT 1 FROM public.contratos c WHERE c.fechamento_id=f.id AND c.status='ASSINADO'))
 UNION ALL SELECT r.fechamento_id,r.data_evento,r.horario_inicio,r.horario_fim FROM public.fechamento_revisoes r
 JOIN public.contratos c ON c.id=r.contrato_id WHERE c.status='ASSINADO'
 AND r.estado IN ('EM_ELABORACAO','CONGELADA') AND r.hold_destino_adquirido_em IS NOT NULL
)
SELECT a.id fechamento_id,b.id conflito_fechamento_id,NULL::uuid bloqueio_id FROM ocupacao a JOIN ocupacao b
 ON a.id<b.id AND a.data_evento=b.data_evento AND a.horario_inicio<b.horario_fim AND a.horario_fim>b.horario_inicio
UNION ALL SELECT a.id,NULL,b.id FROM ocupacao a JOIN public.bloqueios_agenda b ON b.data=a.data_evento AND b.ativo
WHERE b.dia_inteiro OR b.horario_inicio IS NULL OR b.horario_fim IS NULL OR (a.horario_inicio<b.horario_fim AND a.horario_fim>b.horario_inicio);
-- STOP if the previous report contains any row. No automatic conflict resolution.
SELECT c.id contrato_id FROM public.contratos c WHERE c.status='ASSINADO'
AND NOT EXISTS(SELECT 1 FROM public.festas f WHERE f.contrato_id=c.id AND f.invalidada_em IS NULL);
COMMIT;
