-- PREPARADO, NÃO EXECUTADO. Exige aprovação explícita de leitura em produção.
-- Somente kidmais_production, recurso Render identificado como kidmais-production.
-- Não depende de instalação dos novos contratos/isenções 074/075.
SELECT current_database() AS banco, e.id AS empresa_id, e.nome, e.status,
    (SELECT u.id FROM public.memberships m
        JOIN public.usuarios_administrativos u ON u.id = m.usuario_id
        WHERE m.empresa_id = e.id AND m.status = 'ATIVA'
          AND m.papel = 'REPRESENTANTE_AUTORIZADO' AND u.ativo
          AND u.email = 'felipemenegaz@gmail.com' LIMIT 1) AS felipe_gestao_id
FROM public.empresas e
JOIN public.plataforma_empresas_cadastro c ON c.empresa_id = e.id
WHERE c.documento_fiscal = '20119900000160'
  AND current_database() = 'kidmais_production';
