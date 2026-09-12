-- =============================================================================
-- Kidmais Manager — Contrato Bloco 2
-- Verificação física pós-aceite
-- SOMENTE LEITURA
-- =============================================================================

-- 1. Contrato, versão corrente e Fechamento.
SELECT
    c.id AS contrato_id,
    c.fechamento_id,
    c.status AS contrato_status,
    c.versao_atual,
    c.assinado_em AS contrato_assinado_em,
    cv.id AS contrato_versao_id,
    cv.numero_versao,
    cv.status AS versao_status,
    cv.snapshot_hash,
    cv.documento_template_versao,
    cv.documento_pdf_hash,
    cv.aceite_metodo,
    cv.assinado_em AS versao_assinada_em,
    f.status AS fechamento_status,
    f.cliente_id
FROM contratos c
JOIN fechamentos f
  ON f.id = c.fechamento_id
JOIN contrato_versoes cv
  ON cv.contrato_id = c.id
 AND cv.numero_versao = c.versao_atual
ORDER BY c.criado_em DESC;

-- Esperado para o Contrato homologado:
-- contrato_status   = ASSINADO
-- versao_status     = ASSINADA
-- fechamento_status = CONTRATO_ASSINADO
-- documento_template_versao = 1 (enquanto V1 estiver em homologação DEV)
-- documento_pdf_hash = SHA-256 de 64 caracteres
-- aceite_metodo = OTP


-- 2. Prova de identidade consumida especificamente pela versão contratual.
SELECT
    vic.id AS validacao_id,
    vic.cliente_id,
    vic.finalidade,
    vic.canal,
    vic.status,
    vic.confirmado_em,
    vic.consumido_em,
    vic.consumido_por_fechamento_id,
    vic.consumido_por_contrato_versao_id,
    cv.contrato_id,
    cv.numero_versao
FROM validacoes_identidade_cliente vic
LEFT JOIN contrato_versoes cv
  ON cv.id = vic.consumido_por_contrato_versao_id
WHERE vic.finalidade = 'CONTRATO_ACEITE'
ORDER BY vic.criado_em DESC;

-- Para a prova que assinou:
-- status = CONSUMIDA
-- consumido_por_fechamento_id = NULL
-- consumido_por_contrato_versao_id = versão ASSINADA


-- 3. Histórico funcional do Cliente.
SELECT
    id,
    cliente_id,
    tipo_evento,
    origem,
    entidade_tipo,
    entidade_id,
    detalhe,
    metadata,
    critico,
    criado_em
FROM eventos_historico_cliente
WHERE tipo_evento = 'CONTRATO_ASSINADO'
ORDER BY criado_em DESC;


-- 4. Auditoria técnica do aceite.
SELECT
    id,
    cliente_id,
    ator_tipo,
    acao,
    entidade_tipo,
    entidade_id,
    dados_antes,
    dados_depois,
    origem,
    request_id,
    ip,
    user_agent,
    criado_em
FROM auditoria
WHERE acao = 'CONTRATO_ACEITO_CLIENTE'
ORDER BY criado_em DESC;


-- 5. Verificar que não surgiu mais de uma versão corrente por Contrato.
SELECT
    contrato_id,
    COUNT(*) AS versoes_correntes
FROM contrato_versoes
WHERE status IN ('ATIVA', 'ASSINADA')
GROUP BY contrato_id
HAVING COUNT(*) > 1;

-- Esperado: zero linhas.


-- 6. Verificar inconsistências de assinatura.
SELECT
    c.id AS contrato_id,
    c.status AS contrato_status,
    c.assinado_em AS contrato_assinado_em,
    cv.id AS versao_id,
    cv.status AS versao_status,
    cv.assinado_em AS versao_assinada_em,
    cv.documento_template_versao,
    cv.documento_pdf_hash,
    cv.aceite_metodo
FROM contratos c
JOIN contrato_versoes cv
  ON cv.contrato_id = c.id
 AND cv.numero_versao = c.versao_atual
WHERE
    (c.status = 'ASSINADO' AND c.assinado_em IS NULL)
 OR (cv.status = 'ASSINADA' AND cv.assinado_em IS NULL)
 OR (cv.status = 'ASSINADA' AND cv.documento_template_versao IS NULL)
 OR (cv.status = 'ASSINADA' AND cv.documento_pdf_hash IS NULL)
 OR (cv.status = 'ASSINADA' AND cv.aceite_metodo IS NULL);

-- Esperado: zero linhas.
