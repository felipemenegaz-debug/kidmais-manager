-- RASCUNHO PREPARADO, NAO EXECUTADO. Decisao de propriedade de Felipe em 11/10/2026, evidencia P0b.
-- Exige pacote de cutover, backup/PITR, ensaio isolado e autorizacao de escrita. Escritas de agenda pausadas na janela.
-- Antes de executar: SET kidmais.reparo_lancamento = 'cinco-bloqueios-kidmais-20261011';
-- Alvo fixo; nenhum bloqueio apagado/desativado; nao aplica outras resolucoes antigas.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
SET LOCAL search_path=public,pg_catalog;
DO $$ BEGIN
  IF current_database()<>'kidmais_production' THEN RAISE EXCEPTION 'BANCO_RECUSADO'; END IF;
  IF current_setting('kidmais.reparo_lancamento',true) IS DISTINCT FROM 'cinco-bloqueios-kidmais-20261011' THEN
    RAISE EXCEPTION 'REPARO_NAO_AUTORIZADO';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM empresas WHERE id='7e990a2b-e64b-4630-9aae-4646fe936ede' AND codigo='kidmais' AND status='ATIVA') THEN
    RAISE EXCEPTION 'IDENTIDADE_KIDMAIS_DIVERGENTE';
  END IF;
END $$;
-- Impede mudanca concorrente dos bloqueios ou decisoes entre conferencia e escrita. Timeout/falha aborta a transacao.
LOCK TABLE bloqueios_agenda, agenda_062_bloqueios_resolucao IN SHARE ROW EXCLUSIVE MODE;
DO $$ DECLARE n integer; BEGIN
  SELECT count(*) INTO n FROM bloqueios_agenda WHERE ativo AND empresa_id IS NULL AND data>=current_date;
  IF n<>5 THEN RAISE EXCEPTION 'CONJUNTO_GLOBAL_DIVERGENTE'; END IF;
  SELECT count(*) INTO n FROM bloqueios_agenda b JOIN (VALUES
    ('57618aab-a62c-4be1-9385-17308ac8dda3'::uuid,'2026-10-15'::date),
    ('3b06e365-7ac1-42e6-ba1a-6b82de76af8b'::uuid,'2026-11-01'::date),
    ('11b9459d-35f8-4a9f-8e6f-aeb7311ff651'::uuid,'2026-11-07'::date),
    ('e4cc53fd-b423-46bc-98b4-86b318a0d688'::uuid,'2026-11-13'::date),
    ('d4e6cf8c-1b42-4bd1-8d18-1750cc3b958e'::uuid,'2027-05-27'::date)
  ) alvo(id,data) ON b.id=alvo.id AND b.data=alvo.data
  WHERE b.ativo AND b.empresa_id IS NULL AND b.estabelecimento_id IS NULL AND NOT b.dia_inteiro
    AND b.horario_inicio='17:00:00'::time AND b.horario_fim='21:00:00'::time
    AND NOT EXISTS(SELECT 1 FROM agenda_062_bloqueios_resolucao r WHERE r.bloqueio_id=b.id);
  IF n<>5 THEN RAISE EXCEPTION 'BLOQUEIOS_DIVERGENTES_OU_REPARO_JA_INICIADO'; END IF;
END $$;
SELECT kidmais_lock_datas_revisao(ARRAY['2026-10-15'::date,'2026-11-01'::date,'2026-11-07'::date,'2026-11-13'::date,'2027-05-27'::date]);
INSERT INTO agenda_062_bloqueios_resolucao(bloqueio_id,empresa_id,estabelecimento_id,decidido_por,motivo)
SELECT id,'7e990a2b-e64b-4630-9aae-4646fe936ede'::uuid,NULL,'Felipe',
  'Propriedade confirmada por Felipe em 11/10/2026 apos leitura P0b; bloqueia a Kidmais inteira, preservando datas e horarios.'
FROM bloqueios_agenda WHERE id IN (
  '57618aab-a62c-4be1-9385-17308ac8dda3'::uuid,'3b06e365-7ac1-42e6-ba1a-6b82de76af8b'::uuid,
  '11b9459d-35f8-4a9f-8e6f-aeb7311ff651'::uuid,'e4cc53fd-b423-46bc-98b4-86b318a0d688'::uuid,
  'd4e6cf8c-1b42-4bd1-8d18-1750cc3b958e'::uuid);
UPDATE bloqueios_agenda SET empresa_id='7e990a2b-e64b-4630-9aae-4646fe936ede'::uuid
WHERE id IN (
  '57618aab-a62c-4be1-9385-17308ac8dda3'::uuid,'3b06e365-7ac1-42e6-ba1a-6b82de76af8b'::uuid,
  '11b9459d-35f8-4a9f-8e6f-aeb7311ff651'::uuid,'e4cc53fd-b423-46bc-98b4-86b318a0d688'::uuid,
  'd4e6cf8c-1b42-4bd1-8d18-1750cc3b958e'::uuid)
RETURNING id,empresa_id,estabelecimento_id,data,horario_inicio,horario_fim,ativo;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM bloqueios_agenda WHERE ativo AND empresa_id IS NULL AND data>=current_date) THEN
    RAISE EXCEPTION 'POSTCHECK_AINDA_GLOBAL';
  END IF;
END $$;
COMMIT;
