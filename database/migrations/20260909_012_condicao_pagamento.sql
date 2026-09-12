-- Autorizada pelo usuário após PROPOSTA_AJUSTE_COMERCIAL_PIX.md.
-- Banco físico inspecionado antes da criação. Sem backfill/default.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE fechamentos ADD COLUMN condicao_pagamento jsonb;
ALTER TABLE aprovacoes_negociacao ADD COLUMN condicao_pagamento jsonb;
ALTER TABLE fechamentos ADD CONSTRAINT fechamentos_condicao_pagamento_check CHECK (
  condicao_pagamento IS NULL OR COALESCE(
    jsonb_typeof(condicao_pagamento) = 'object'
    AND condicao_pagamento->'schemaVersao' = '1'::jsonb
    AND condicao_pagamento->>'forma' = forma_pagamento_pretendida
    AND condicao_pagamento->>'revisaoStatus' IN ('PENDENTE','APROVADA','DISPENSADA','RECUSADA'), false)
);
ALTER TABLE aprovacoes_negociacao ADD CONSTRAINT aprovacoes_condicao_pagamento_check CHECK (
  condicao_pagamento IS NULL OR COALESCE(
    jsonb_typeof(condicao_pagamento) = 'object'
    AND condicao_pagamento->'schemaVersao' = '1'::jsonb, false)
);
ALTER TABLE fechamentos DROP CONSTRAINT fechamentos_status_negociacao_check;
ALTER TABLE fechamentos ADD CONSTRAINT fechamentos_status_negociacao_check CHECK (
  status <> 'AGUARDANDO_APROVACAO' OR valor_negociado IS NOT NULL OR COALESCE(
    condicao_pagamento->>'forma' = 'PIX_PARCELADO'
    AND condicao_pagamento->>'revisaoStatus' = 'PENDENTE', false)
);
COMMENT ON COLUMN fechamentos.condicao_pagamento IS
  'Condição comercial versionada do novo fluxo; proposta separada da aprovação. NULL preserva legado. Não é plano financeiro.';
COMMENT ON COLUMN aprovacoes_negociacao.condicao_pagamento IS
  'Snapshot da condição analisada por decisão; append-only pela aplicação. Não representa recebimento.';
COMMIT;
