-- 084: etapas duráveis da geração de IA (envio, recebimento, falha classificada) e estado NAO_ENVIADA.
-- Executar somente após autorização do ambiente, precheck e backup operacional. Aditiva: o código anterior continua
-- funcionando depois dela (colunas novas anuláveis; nenhum estado existente muda). Aplicar ANTES do deploy do código.
-- Nenhuma linha existente é alterada (gerações INCERTA antigas continuam INCERTA, com classe nula).
-- etapas_registradas separa as gerações criadas pelo código novo (que grava enviado_em ANTES de chamar o provedor) das
-- antigas ou de uma instância anterior ainda em execução no deploy: sem o marcador, "enviado_em nulo" não prova que
-- não houve envio, e a geração nunca é devolvida automaticamente.
-- Rollback: database/rollback/20261018_084_convite_geracao_pendencias_down.sql
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;
DO $$
DECLARE definicao text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO definicao FROM pg_constraint
    WHERE conrelid='public.convite_geracoes'::regclass AND conname='convite_geracoes_estado_check';
  IF definicao IS NULL OR definicao NOT LIKE '%RESOLVIDA_SEM_COBRANCA%' OR definicao LIKE '%NAO_ENVIADA%'
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.convite_geracoes'::regclass AND conname='convite_geracoes_resolucao_consistente')
    OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='convite_geracoes'
      AND column_name IN ('etapas_registradas','enviado_em','recebido_em','resultado_pendente','falha_classe','falha_diagnostico','falha_detalhes')) THEN
    RAISE EXCEPTION '084: precheck falhou (079 ausente ou 084 anterior/parcial); nada alterado';
  END IF;
END $$;
ALTER TABLE convite_geracoes DROP CONSTRAINT convite_geracoes_estado_check;
ALTER TABLE convite_geracoes ADD CONSTRAINT convite_geracoes_estado_check
  CHECK (estado IN ('RESERVADA','CONCLUIDA','INCERTA','RESOLVIDA_COBRADA','RESOLVIDA_SEM_COBRANCA','NAO_ENVIADA'));
-- enviado_em: gravado e confirmado ANTES de chamar o provedor (sem ele, a chamada não acontece).
-- recebido_em/resultado_pendente: imagem recebida e guardada antes do processamento local; limpo ao concluir ou decidir.
-- O padrão false vale para linhas existentes e para o código anterior; o código novo grava true explicitamente.
ALTER TABLE convite_geracoes ADD COLUMN etapas_registradas boolean NOT NULL DEFAULT false,
  ADD COLUMN enviado_em timestamptz,
  ADD COLUMN recebido_em timestamptz,
  ADD COLUMN resultado_pendente bytea,
  ADD COLUMN falha_classe text,
  ADD COLUMN falha_diagnostico text,
  ADD COLUMN falha_detalhes jsonb;
ALTER TABLE convite_geracoes ADD CONSTRAINT convite_geracoes_etapas_consistentes CHECK (
  (recebido_em IS NULL OR enviado_em IS NOT NULL)
  AND (resultado_pendente IS NULL OR (recebido_em IS NOT NULL AND octet_length(resultado_pendente) BETWEEN 1 AND 16000000))
  AND (falha_classe IS NULL OR falha_classe IN ('PRE_ENVIO','RESPOSTA_PROVEDOR','DESCONHECIDA','ARMAZENAMENTO','DEVOLUCAO_FALHOU'))
  -- Etapas só existem em gerações do código novo.
  AND (etapas_registradas OR (enviado_em IS NULL AND recebido_em IS NULL AND resultado_pendente IS NULL))
  AND (falha_diagnostico IS NULL OR falha_diagnostico ~ '^[a-z0-9_]{1,120}$')
  AND (falha_detalhes IS NULL OR jsonb_typeof(falha_detalhes) = 'object')
  -- Devolução automática só quando o envio comprovadamente não começou.
  AND ((estado = 'NAO_ENVIADA') = (falha_classe IS NOT DISTINCT FROM 'PRE_ENVIO'))
  AND (estado <> 'NAO_ENVIADA' OR (etapas_registradas AND enviado_em IS NULL AND recebido_em IS NULL AND resultado_pendente IS NULL))
);
CREATE INDEX convite_geracoes_em_aberto ON convite_geracoes(criado_em) WHERE estado IN ('RESERVADA','INCERTA');
COMMIT;
