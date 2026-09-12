-- =============================================================================
-- Kidmais Manager
-- Migration 010 — Documento e aceite eletrônico do Contrato
-- Arquivo: 20260908_010_contrato_documento_aceite.sql
-- =============================================================================

BEGIN;

DO $$
BEGIN
    IF to_regclass('public.validacoes_identidade_cliente') IS NULL THEN
        RAISE EXCEPTION 'Migration 010 exige a tabela validacoes_identidade_cliente.';
    END IF;

    IF to_regclass('public.contratos') IS NULL THEN
        RAISE EXCEPTION 'Migration 010 exige a tabela contratos.';
    END IF;

    IF to_regclass('public.contrato_versoes') IS NULL THEN
        RAISE EXCEPTION 'Migration 010 exige a tabela contrato_versoes.';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'validacoes_identidade_cliente'
          AND column_name = 'consumido_por_contrato_versao_id'
    ) THEN
        RAISE EXCEPTION 'Migration 010 detectou consumido_por_contrato_versao_id já existente. Revise antes de aplicar.';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'contrato_versoes'
          AND column_name IN (
              'documento_template_versao',
              'documento_pdf_hash',
              'aceite_metodo'
          )
    ) THEN
        RAISE EXCEPTION 'Migration 010 detectou metadados documentais já existentes em contrato_versoes. Revise antes de aplicar.';
    END IF;
END;
$$;

ALTER TABLE validacoes_identidade_cliente
    DROP CONSTRAINT validacoes_identidade_cliente_finalidade_check;

ALTER TABLE validacoes_identidade_cliente
    ADD CONSTRAINT validacoes_identidade_cliente_finalidade_check CHECK (
        finalidade IN (
            'FECHAMENTO_PUBLICO',
            'CONTRATO_ACEITE'
        )
    );

ALTER TABLE validacoes_identidade_cliente
    ADD COLUMN consumido_por_contrato_versao_id uuid;

ALTER TABLE validacoes_identidade_cliente
    ADD CONSTRAINT validacoes_identidade_cliente_contrato_versao_fk
        FOREIGN KEY (consumido_por_contrato_versao_id)
        REFERENCES contrato_versoes(id)
        ON DELETE RESTRICT;

ALTER TABLE validacoes_identidade_cliente
    DROP CONSTRAINT validacoes_identidade_cliente_pendente_check,
    DROP CONSTRAINT validacoes_identidade_cliente_recuperacao_check,
    DROP CONSTRAINT validacoes_identidade_cliente_confirmada_check,
    DROP CONSTRAINT validacoes_identidade_cliente_consumida_check,
    DROP CONSTRAINT validacoes_identidade_cliente_consumo_consistencia;

ALTER TABLE validacoes_identidade_cliente
    ADD CONSTRAINT validacoes_identidade_cliente_pendente_check CHECK (
        status <> 'PENDENTE'
        OR (
            canal IS NOT NULL
            AND codigo_hash IS NOT NULL
            AND codigo_expira_em IS NOT NULL
            AND confirmado_em IS NULL
            AND token_prova_hash IS NULL
            AND prova_expira_em IS NULL
            AND consumido_em IS NULL
            AND consumido_por_fechamento_id IS NULL
            AND consumido_por_contrato_versao_id IS NULL
            AND recuperacao_solicitada_em IS NULL
        )
    );

ALTER TABLE validacoes_identidade_cliente
    ADD CONSTRAINT validacoes_identidade_cliente_recuperacao_check CHECK (
        status <> 'RECUPERACAO_PENDENTE'
        OR (
            codigo_hash IS NULL
            AND codigo_expira_em IS NULL
            AND confirmado_em IS NULL
            AND token_prova_hash IS NULL
            AND prova_expira_em IS NULL
            AND consumido_em IS NULL
            AND consumido_por_fechamento_id IS NULL
            AND consumido_por_contrato_versao_id IS NULL
            AND recuperacao_solicitada_em IS NOT NULL
        )
    );

ALTER TABLE validacoes_identidade_cliente
    ADD CONSTRAINT validacoes_identidade_cliente_confirmada_check CHECK (
        status <> 'CONFIRMADA'
        OR (
            canal IS NOT NULL
            AND confirmado_em IS NOT NULL
            AND token_prova_hash IS NOT NULL
            AND prova_expira_em IS NOT NULL
            AND consumido_em IS NULL
            AND consumido_por_fechamento_id IS NULL
            AND consumido_por_contrato_versao_id IS NULL
        )
    );

ALTER TABLE validacoes_identidade_cliente
    ADD CONSTRAINT validacoes_identidade_cliente_consumida_check CHECK (
        status <> 'CONSUMIDA'
        OR (
            confirmado_em IS NOT NULL
            AND token_prova_hash IS NOT NULL
            AND prova_expira_em IS NOT NULL
            AND consumido_em IS NOT NULL
            AND (
                (
                    consumido_por_fechamento_id IS NOT NULL
                    AND consumido_por_contrato_versao_id IS NULL
                )
                OR
                (
                    consumido_por_fechamento_id IS NULL
                    AND consumido_por_contrato_versao_id IS NOT NULL
                )
            )
        )
    );

ALTER TABLE validacoes_identidade_cliente
    ADD CONSTRAINT validacoes_identidade_cliente_consumo_consistencia CHECK (
        (
            consumido_em IS NULL
            AND consumido_por_fechamento_id IS NULL
            AND consumido_por_contrato_versao_id IS NULL
        )
        OR
        (
            consumido_em IS NOT NULL
            AND (
                (
                    consumido_por_fechamento_id IS NOT NULL
                    AND consumido_por_contrato_versao_id IS NULL
                )
                OR
                (
                    consumido_por_fechamento_id IS NULL
                    AND consumido_por_contrato_versao_id IS NOT NULL
                )
            )
        )
    );

ALTER TABLE validacoes_identidade_cliente
    ADD CONSTRAINT validacoes_identidade_cliente_consumidor_finalidade_check
    CHECK (
        (
            finalidade = 'FECHAMENTO_PUBLICO'
            AND consumido_por_contrato_versao_id IS NULL
        )
        OR
        (
            finalidade = 'CONTRATO_ACEITE'
            AND consumido_por_fechamento_id IS NULL
        )
    );

CREATE UNIQUE INDEX validacoes_identidade_cliente_contrato_versao_uk
    ON validacoes_identidade_cliente (consumido_por_contrato_versao_id)
    WHERE consumido_por_contrato_versao_id IS NOT NULL;

COMMENT ON COLUMN validacoes_identidade_cliente.consumido_por_contrato_versao_id IS
'Versão contratual que consumiu uma prova de identidade com finalidade CONTRATO_ACEITE.';

ALTER TABLE contrato_versoes
    ADD COLUMN documento_template_versao integer,
    ADD COLUMN documento_pdf_hash char(64),
    ADD COLUMN aceite_metodo varchar(20);

ALTER TABLE contrato_versoes
    ADD CONSTRAINT contrato_versoes_documento_template_check CHECK (
        documento_template_versao IS NULL
        OR documento_template_versao > 0
    ),
    ADD CONSTRAINT contrato_versoes_documento_pdf_hash_check CHECK (
        documento_pdf_hash IS NULL
        OR documento_pdf_hash ~ '^[0-9a-f]{64}$'
    ),
    ADD CONSTRAINT contrato_versoes_aceite_metodo_check CHECK (
        aceite_metodo IS NULL
        OR aceite_metodo IN ('OTP')
    );

ALTER TABLE contrato_versoes
    ADD CONSTRAINT contrato_versoes_assinatura_documento_check CHECK (
        status <> 'ASSINADA'
        OR (
            documento_template_versao IS NOT NULL
            AND documento_pdf_hash IS NOT NULL
            AND aceite_metodo IS NOT NULL
        )
    );

COMMENT ON COLUMN contrato_versoes.documento_template_versao IS
'Versão do renderizador/template contratual utilizado para produzir o documento efetivamente aceito.';

COMMENT ON COLUMN contrato_versoes.documento_pdf_hash IS
'SHA-256 hexadecimal do PDF efetivamente aceito pelo Cliente.';

COMMENT ON COLUMN contrato_versoes.aceite_metodo IS
'Método utilizado para aceite da versão contratual. Inicialmente OTP.';

COMMIT;
