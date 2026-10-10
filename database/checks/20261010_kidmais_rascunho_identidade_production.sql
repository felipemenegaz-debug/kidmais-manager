-- PREPARADO, NÃO EXECUTADO. Somente leitura administrativa em kidmais_production.
-- Só o rascunho atual do CNPJ confirmado. Não percorre histórico ou nomes semelhantes.
-- Salvar rascunho não concede isenção nem confirma titularidade fiscal.
SELECT current_database() AS banco, p.id AS perfil_id, p.codigo AS perfil_codigo,
    r.numero AS revisao_numero, r.edicao AS revisao_edicao,
    r.conteudo->>'nomeComercial' AS nome_comercial_rascunho,
    regexp_replace(coalesce(p.cnpj, ''), '[^0-9]', '', 'g') = '20119900000160' AS cnpj_aplicado_confere,
    e.candidatos,
    CASE WHEN e.candidatos = 1 THEN e.id END AS empresa_id,
    CASE WHEN e.candidatos = 1 THEN e.status END AS empresa_status,
    CASE WHEN e.candidatos = 1 THEN (
        SELECT u.id FROM public.memberships m
        JOIN public.usuarios_administrativos u ON u.id = m.usuario_id
        WHERE m.empresa_id = e.id AND m.status = 'ATIVA'
          AND m.papel = 'REPRESENTANTE_AUTORIZADO' AND u.ativo
          AND u.email = 'felipemenegaz@gmail.com' LIMIT 1
    ) END AS felipe_gestao_id
FROM public.perfil_empresa_revisoes r
JOIN public.perfil_empresas p ON p.id = r.empresa_id
LEFT JOIN LATERAL (
    SELECT id, status, count(*) OVER () AS candidatos FROM public.empresas
    WHERE id = p.id OR codigo = lower(p.codigo) OR (
        (SELECT count(*) FROM public.empresas) = 1 AND
        (SELECT count(*) FROM public.perfil_empresas) = 1
    ) OR (
        codigo = 'kidmais'
        AND NOT EXISTS (SELECT 1 FROM public.empresas x WHERE x.id = p.id OR x.codigo = lower(p.codigo))
        AND (SELECT count(*) FROM public.perfil_empresas q
            WHERE NOT EXISTS (SELECT 1 FROM public.empresas y WHERE y.id = q.id OR y.codigo = lower(q.codigo))) = 1
    )
) e ON true
WHERE r.estado = 'RASCUNHO'
  AND regexp_replace(coalesce(r.conteudo->>'cnpj', ''), '[^0-9]', '', 'g') = '20119900000160'
  AND current_database() = 'kidmais_production';
