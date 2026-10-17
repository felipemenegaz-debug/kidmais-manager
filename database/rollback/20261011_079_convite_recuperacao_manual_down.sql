-- Rollback antes de ativar a função. Recusa quando há decisões auditáveis para preservar.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;
LOCK TABLE convite_geracoes IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='convite_geracoes' AND column_name='resolucao_evidencia')
    OR EXISTS (SELECT 1 FROM convite_geracoes WHERE estado IN ('RESOLVIDA_COBRADA','RESOLVIDA_SEM_COBRANCA')) THEN
    RAISE EXCEPTION '079 rollback recusado: migration ausente/parcial ou há decisões auditáveis. Preserve o histórico e faça correção para frente.';
  END IF;
END $$;
DROP INDEX convite_geracoes_incertas;
ALTER TABLE convite_geracoes DROP CONSTRAINT convite_geracoes_resolucao_consistente;
ALTER TABLE convite_geracoes DROP CONSTRAINT convite_geracoes_estado_check;
ALTER TABLE convite_geracoes ADD CONSTRAINT convite_geracoes_estado_check CHECK (estado IN ('RESERVADA','CONCLUIDA','INCERTA'));
ALTER TABLE convite_geracoes DROP COLUMN resolucao_resultado, DROP COLUMN resolucao_por, DROP COLUMN resolucao_em,
  DROP COLUMN resolucao_evidencia, DROP COLUMN reserva_microusd;
COMMIT;
