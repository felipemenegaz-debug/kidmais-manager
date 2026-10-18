-- Rollback da 084. Recusa quando alguma geração já registrou etapa, classe ou estado NAO_ENVIADA: essas linhas são
-- histórico auditável (envio, recebimento, devolução automática). Nesse caso, preserve e corrija para frente.
-- Antes do rollback, volte o código para a versão anterior (que não grava as colunas novas).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;
LOCK TABLE convite_geracoes IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='convite_geracoes' AND column_name='falha_classe')
    OR EXISTS (SELECT 1 FROM convite_geracoes WHERE estado='NAO_ENVIADA' OR etapas_registradas OR enviado_em IS NOT NULL OR recebido_em IS NOT NULL
      OR resultado_pendente IS NOT NULL OR falha_classe IS NOT NULL OR falha_diagnostico IS NOT NULL OR falha_detalhes IS NOT NULL) THEN
    RAISE EXCEPTION '084 rollback recusado: migration ausente/parcial ou há etapas registradas. Preserve o histórico e faça correção para frente.';
  END IF;
END $$;
DROP INDEX convite_geracoes_em_aberto;
ALTER TABLE convite_geracoes DROP CONSTRAINT convite_geracoes_etapas_consistentes;
ALTER TABLE convite_geracoes DROP CONSTRAINT convite_geracoes_estado_check;
ALTER TABLE convite_geracoes ADD CONSTRAINT convite_geracoes_estado_check
  CHECK (estado IN ('RESERVADA','CONCLUIDA','INCERTA','RESOLVIDA_COBRADA','RESOLVIDA_SEM_COBRANCA'));
ALTER TABLE convite_geracoes DROP COLUMN etapas_registradas, DROP COLUMN enviado_em, DROP COLUMN recebido_em, DROP COLUMN resultado_pendente,
  DROP COLUMN falha_classe, DROP COLUMN falha_diagnostico, DROP COLUMN falha_detalhes;
COMMIT;
