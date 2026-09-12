-- =============================================================================
-- Kidmais Manager
-- PATCH da migration 006 — preços comerciais
-- Arquivo: 20260907_006a_comercial_precos_patch.sql
--
-- Objetivo:
--   Corrigir banco que recebeu a versão intermediária da migration 006:
--   - permitir categoria GERAL em precos_pacote;
--   - mover Mini Festa e Festa Compacta de PADRAO para GERAL;
--   - inserir Kidmais Pocket a R$ 190 por convidado, mínimo de 20;
--   - inserir matriz NOBRE de Essencial / Completa / Premium;
--   - validar o estado final: GERAL=3, PADRAO=33, NOBRE=33, TOTAL=69.
--
-- NÃO apaga tabelas.
-- NÃO altera schema_mvp_kidmais.sql.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Permitir categoria GERAL
-- -----------------------------------------------------------------------------

ALTER TABLE precos_pacote
    DROP CONSTRAINT IF EXISTS precos_pacote_categoria_check;

ALTER TABLE precos_pacote
    ADD CONSTRAINT precos_pacote_categoria_check
    CHECK (categoria_horario IN ('GERAL', 'PADRAO', 'NOBRE'));

-- -----------------------------------------------------------------------------
-- 2. Mini Festa e Compacta não variam por categoria de horário nesta versão.
--    Converter os registros existentes PADRAO para GERAL.
-- -----------------------------------------------------------------------------

UPDATE precos_pacote pp
SET
    categoria_horario = 'GERAL',
    observacoes = 'R$ 170 por convidado, mínimo faturável de 30 convidados.'
FROM pacotes p, tabelas_preco t
WHERE pp.pacote_id = p.id
  AND pp.tabela_preco_id = t.id
  AND t.codigo = 'COMERCIAL_2026_09'
  AND p.codigo = 'MINI_FESTA'
  AND pp.categoria_horario = 'PADRAO'
  AND pp.convidados_min = 30
  AND pp.convidados_max = 150
  AND pp.tipo_calculo = 'POR_CONVIDADO'
  AND pp.valor = 170.00;

UPDATE precos_pacote pp
SET
    categoria_horario = 'GERAL',
    observacoes = 'Base comercial confirmada para 40 convidados. Acima de 40 exige regra específica ainda não persistida.'
FROM pacotes p, tabelas_preco t
WHERE pp.pacote_id = p.id
  AND pp.tabela_preco_id = t.id
  AND t.codigo = 'COMERCIAL_2026_09'
  AND p.codigo = 'COMPACTA'
  AND pp.categoria_horario = 'PADRAO'
  AND pp.convidados_min = 40
  AND pp.convidados_max = 40
  AND pp.tipo_calculo = 'FIXO'
  AND pp.valor = 6490.00;

-- -----------------------------------------------------------------------------
-- 3. Kidmais Pocket
--    Regra oficial: R$ 190 por convidado, mínimo faturável de 20 convidados.
-- -----------------------------------------------------------------------------

WITH tabela AS (
    SELECT id
    FROM tabelas_preco
    WHERE codigo = 'COMERCIAL_2026_09'
),
pacote AS (
    SELECT id
    FROM pacotes
    WHERE codigo = 'POCKET'
)
INSERT INTO precos_pacote (
    tabela_preco_id,
    pacote_id,
    convidados_min,
    convidados_max,
    tipo_calculo,
    valor,
    categoria_horario,
    observacoes
)
SELECT
    t.id,
    p.id,
    20,
    150,
    'POR_CONVIDADO',
    190.00,
    'GERAL',
    'R$ 190 por convidado, mínimo faturável de 20 convidados.'
FROM tabela t
CROSS JOIN pacote p
WHERE NOT EXISTS (
    SELECT 1
    FROM precos_pacote existente
    WHERE existente.tabela_preco_id = t.id
      AND existente.pacote_id = p.id
      AND existente.categoria_horario = 'GERAL'
      AND existente.convidados_min = 20
      AND existente.convidados_max = 150
      AND existente.ativo = true
);

-- -----------------------------------------------------------------------------
-- 4. Matriz NOBRE
--
-- Categoria NOBRE:
--   sábado + TURNO_2
--   domingo + TURNO_1
--
-- Essencial mantém os mesmos valores de referência.
-- Completa e Premium usam a matriz de valor mais alto confirmada.
-- -----------------------------------------------------------------------------

WITH tabela AS (
    SELECT id
    FROM tabelas_preco
    WHERE codigo = 'COMERCIAL_2026_09'
),
faixas AS (
    SELECT *
    FROM (VALUES
        ('ESSENCIAL', 50,  50,  8490.00::numeric),
        ('ESSENCIAL', 51,  60,  9190.00::numeric),
        ('ESSENCIAL', 61,  70,  9890.00::numeric),
        ('ESSENCIAL', 71,  80, 10590.00::numeric),
        ('ESSENCIAL', 81,  90, 11290.00::numeric),
        ('ESSENCIAL', 91, 100, 11990.00::numeric),
        ('ESSENCIAL',101, 110, 12690.00::numeric),
        ('ESSENCIAL',111, 120, 13390.00::numeric),
        ('ESSENCIAL',121, 130, 14090.00::numeric),
        ('ESSENCIAL',131, 140, 14790.00::numeric),
        ('ESSENCIAL',141, 150, 15490.00::numeric),

        ('COMPLETA',   50,  50,  9290.00::numeric),
        ('COMPLETA',   51,  60,  9990.00::numeric),
        ('COMPLETA',   61,  70, 10790.00::numeric),
        ('COMPLETA',   71,  80, 11590.00::numeric),
        ('COMPLETA',   81,  90, 12390.00::numeric),
        ('COMPLETA',   91, 100, 13290.00::numeric),
        ('COMPLETA',  101, 110, 14190.00::numeric),
        ('COMPLETA',  111, 120, 15090.00::numeric),
        ('COMPLETA',  121, 130, 15990.00::numeric),
        ('COMPLETA',  131, 140, 16890.00::numeric),
        ('COMPLETA',  141, 150, 17790.00::numeric),

        ('PREMIUM',    50,  50, 10690.00::numeric),
        ('PREMIUM',    51,  60, 11790.00::numeric),
        ('PREMIUM',    61,  70, 12890.00::numeric),
        ('PREMIUM',    71,  80, 13990.00::numeric),
        ('PREMIUM',    81,  90, 15090.00::numeric),
        ('PREMIUM',    91, 100, 16190.00::numeric),
        ('PREMIUM',   101, 110, 17290.00::numeric),
        ('PREMIUM',   111, 120, 18390.00::numeric),
        ('PREMIUM',   121, 130, 19490.00::numeric),
        ('PREMIUM',   131, 140, 20590.00::numeric),
        ('PREMIUM',   141, 150, 21690.00::numeric)
    ) AS v(pacote_codigo, convidados_min, convidados_max, valor)
)
INSERT INTO precos_pacote (
    tabela_preco_id,
    pacote_id,
    convidados_min,
    convidados_max,
    tipo_calculo,
    valor,
    categoria_horario,
    observacoes
)
SELECT
    t.id,
    p.id,
    f.convidados_min,
    f.convidados_max,
    'FIXO',
    f.valor,
    'NOBRE',
    'Preço de tabela para sábado TURNO_2 e domingo TURNO_1. Descontos não alteram este valor histórico.'
FROM tabela t
JOIN faixas f ON true
JOIN pacotes p ON p.codigo = f.pacote_codigo
WHERE NOT EXISTS (
    SELECT 1
    FROM precos_pacote existente
    WHERE existente.tabela_preco_id = t.id
      AND existente.pacote_id = p.id
      AND existente.categoria_horario = 'NOBRE'
      AND existente.convidados_min = f.convidados_min
      AND existente.convidados_max = f.convidados_max
      AND existente.ativo = true
);

-- -----------------------------------------------------------------------------
-- 5. Validação final
-- -----------------------------------------------------------------------------

DO $$
DECLARE
    v_geral integer;
    v_padrao integer;
    v_nobre integer;
    v_total integer;
BEGIN
    SELECT count(*) INTO v_geral
    FROM precos_pacote
    WHERE ativo = true
      AND categoria_horario = 'GERAL';

    SELECT count(*) INTO v_padrao
    FROM precos_pacote
    WHERE ativo = true
      AND categoria_horario = 'PADRAO';

    SELECT count(*) INTO v_nobre
    FROM precos_pacote
    WHERE ativo = true
      AND categoria_horario = 'NOBRE';

    SELECT count(*) INTO v_total
    FROM precos_pacote
    WHERE ativo = true;

    IF v_geral <> 3 THEN
        RAISE EXCEPTION
            'Patch comercial inválido: esperados 3 preços GERAL, encontrados %',
            v_geral;
    END IF;

    IF v_padrao <> 33 THEN
        RAISE EXCEPTION
            'Patch comercial inválido: esperados 33 preços PADRAO, encontrados %',
            v_padrao;
    END IF;

    IF v_nobre <> 33 THEN
        RAISE EXCEPTION
            'Patch comercial inválido: esperados 33 preços NOBRE, encontrados %',
            v_nobre;
    END IF;

    IF v_total <> 69 THEN
        RAISE EXCEPTION
            'Patch comercial inválido: esperados 69 preços ativos, encontrados %',
            v_total;
    END IF;
END;
$$;

COMMIT;
