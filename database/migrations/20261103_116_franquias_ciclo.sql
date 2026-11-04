-- 116 — Franquias de IA por plano, F1 (plano "Franquias de IA por plano 20261102", rev. 4.1 APROVADA COM RESSALVAS
-- pelo Astra; D-FR-1..12 decididas por Felipe em 03/11/2026). LOCAL, preparada em 03/11/2026. NÃO aplicada em staging/produção.
-- Exige 074a (assinatura_contratacoes) e 095 (créditos de IA).
-- Ordem: código compatível publicado ANTES (sem a 116 o worker segue o caminho legado e a sincronização não registra
-- pendência) → conferência → autorização → aplicação → postcheck. CREDITOS_FRANQUIA_PLANO_ATIVO continua desligada.
-- O que muda (só acréscimos; nenhuma linha existente é alterada):
--   ia_credito_franquias_ciclo: UMA linha por lote de franquia reconhecido pelo motor por plano (ADOCAO do lote mensal
--     criado pelo worker legado, ou RECONHECIMENTO), 1:1 com o lote, só inserção (gatilho recusa UPDATE/DELETE);
--   ia_credito_franquia_pendencias: intenção de reconhecer, gravada na mesma transação da troca de contratação;
--   ia_credito_notificacoes.tipo: + FRANQUIA_80 e FRANQUIA_100 (avisos de uso da franquia do mês).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;

DO $$ BEGIN
  IF to_regclass('public.ia_credito_lotes') IS NULL OR to_regprocedure('public.kidmais_095_guarda()') IS NULL THEN
    RAISE EXCEPTION '116 exige a 095 (créditos de IA).';
  END IF;
  IF to_regclass('public.assinatura_contratacoes') IS NULL THEN
    RAISE EXCEPTION '116 exige a 074a (assinatura_contratacoes).';
  END IF;
  IF to_regclass('public.ia_credito_franquias_ciclo') IS NOT NULL OR to_regclass('public.ia_credito_franquia_pendencias') IS NOT NULL
     OR to_regprocedure('public.kidmais_116_somente_insercao()') IS NOT NULL THEN
    RAISE EXCEPTION '116 já (parcialmente) presente.';
  END IF;
END $$;

CREATE TABLE ia_credito_franquias_ciclo (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL,
  recurso text NOT NULL,
  ciclo date NOT NULL,
  chave text NOT NULL,
  lote_id uuid NOT NULL,
  tipo text NOT NULL,
  concedido bigint NOT NULL,
  devido_calculado bigint,
  contratacao_id uuid,
  versao_tabela text,
  historico jsonb NOT NULL DEFAULT '[]'::jsonb,
  criado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT ia_credito_franquias_ciclo_carteira_fk FOREIGN KEY (empresa_id, recurso) REFERENCES ia_credito_carteiras(empresa_id, recurso),
  CONSTRAINT ia_credito_franquias_ciclo_lote_fk FOREIGN KEY (lote_id, empresa_id, recurso) REFERENCES ia_credito_lotes(id, empresa_id, recurso),
  CONSTRAINT ia_credito_franquias_ciclo_contratacao_fk FOREIGN KEY (empresa_id, contratacao_id) REFERENCES assinatura_contratacoes(empresa_id, id),
  CONSTRAINT ia_credito_franquias_ciclo_chave_uk UNIQUE (empresa_id, recurso, ciclo, chave),
  CONSTRAINT ia_credito_franquias_ciclo_lote_uk UNIQUE (lote_id),
  CONSTRAINT ia_credito_franquias_ciclo_ciclo_check CHECK (ciclo = date_trunc('month', ciclo)::date),
  CONSTRAINT ia_credito_franquias_ciclo_chave_check CHECK (chave ~ '^FRANQUIA:[0-9]{4}-[0-9]{2}(:R[0-9]{1,4})?$'),
  CONSTRAINT ia_credito_franquias_ciclo_tipo_check CHECK (tipo IN ('ADOCAO', 'RECONHECIMENTO')),
  CONSTRAINT ia_credito_franquias_ciclo_valores_check CHECK (concedido > 0 AND (devido_calculado IS NULL OR devido_calculado >= 0)),
  CONSTRAINT ia_credito_franquias_ciclo_reconhecimento_check CHECK (tipo = 'ADOCAO'
    OR (devido_calculado IS NOT NULL AND contratacao_id IS NOT NULL AND versao_tabela IS NOT NULL AND char_length(btrim(versao_tabela)) BETWEEN 1 AND 40)),
  CONSTRAINT ia_credito_franquias_ciclo_historico_check CHECK (jsonb_typeof(historico) = 'array')
);
CREATE INDEX ia_credito_franquias_ciclo_empresa_idx ON ia_credito_franquias_ciclo (empresa_id, recurso, ciclo);

-- Trilha financeira: só inserção. Correção é sempre um lançamento novo, nunca reescrita.
CREATE FUNCTION kidmais_116_somente_insercao() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ia_credito_franquias_ciclo é só inserção (116).';
END;
$$;
CREATE TRIGGER ia_credito_franquias_ciclo_116_somente_insercao BEFORE UPDATE OR DELETE ON ia_credito_franquias_ciclo
  FOR EACH ROW EXECUTE FUNCTION kidmais_116_somente_insercao();

CREATE TABLE ia_credito_franquia_pendencias (
  empresa_id uuid NOT NULL,
  contratacao_id uuid NOT NULL,
  criada_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  processada_em timestamptz,
  tentativas integer NOT NULL DEFAULT 0,
  ultimo_motivo text,
  CONSTRAINT ia_credito_franquia_pendencias_pk PRIMARY KEY (empresa_id, contratacao_id),
  CONSTRAINT ia_credito_franquia_pendencias_contratacao_fk FOREIGN KEY (empresa_id, contratacao_id) REFERENCES assinatura_contratacoes(empresa_id, id),
  CONSTRAINT ia_credito_franquia_pendencias_tentativas_check CHECK (tentativas BETWEEN 0 AND 1000),
  CONSTRAINT ia_credito_franquia_pendencias_motivo_check CHECK (ultimo_motivo IS NULL OR ultimo_motivo ~ '^[A-Z_]{1,60}$')
);
CREATE INDEX ia_credito_franquia_pendencias_abertas_idx ON ia_credito_franquia_pendencias (criada_em) WHERE processada_em IS NULL;

ALTER TABLE ia_credito_notificacoes DROP CONSTRAINT ia_credito_notificacoes_tipo_check;
ALTER TABLE ia_credito_notificacoes ADD CONSTRAINT ia_credito_notificacoes_tipo_check CHECK (tipo IN ('PAGAMENTO_CONFIRMADO', 'DEVOLUCAO_REGISTRADA',
  'AVISO_INTERNO_DEVOLUCAO', 'LOTE_VENCENDO_30', 'LOTE_VENCENDO_7', 'FRANQUIA_80', 'FRANQUIA_100'));

COMMIT;
