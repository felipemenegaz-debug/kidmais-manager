-- PREPARADO. Executar somente após autorização de leitura do banco de staging.
-- Banco: kidmais_staging_1z91, Render dpg-daidko3m8hqs73ce4jt0-a.
-- Consulta limitada ao documento informado por Felipe. Não concede isenção.
WITH alvo AS (
    SELECT e.id, e.nome, e.status
    FROM public.empresas e
    JOIN public.plataforma_empresas_cadastro c ON c.empresa_id = e.id
    WHERE c.documento_fiscal = '20119900000160'
      AND current_database() = 'kidmais_staging_1z91'
)
SELECT current_database() AS banco, a.id AS empresa_id, a.nome, a.status,
    EXISTS (SELECT 1 FROM public.assinatura_isencoes i WHERE i.empresa_id = a.id) AS isenta,
    EXISTS (SELECT 1 FROM public.empresa_assinaturas s WHERE s.empresa_id = a.id) AS assinatura_registrada,
    EXISTS (SELECT 1 FROM public.empresa_assinaturas s WHERE s.empresa_id = a.id
        AND s.provedor_assinatura_id IS NOT NULL) AS vinculada_ao_provedor,
    (SELECT count(*)::int FROM public.assinatura_contratacoes c WHERE c.empresa_id = a.id) AS contratacoes,
    (SELECT count(*)::int FROM public.memberships m
        JOIN public.usuarios_administrativos u ON u.id = m.usuario_id
        WHERE m.empresa_id = a.id AND m.status = 'ATIVA'
          AND m.papel = 'REPRESENTANTE_AUTORIZADO' AND u.ativo) AS gestoes_ativas,
    (SELECT u.id FROM public.memberships m
        JOIN public.usuarios_administrativos u ON u.id = m.usuario_id
        WHERE m.empresa_id = a.id AND m.status = 'ATIVA'
          AND m.papel = 'REPRESENTANTE_AUTORIZADO' AND u.ativo
          AND u.email = 'felipemenegaz@gmail.com' LIMIT 1) AS felipe_gestao_id
FROM alvo a;
