-- Postcheck da 083 (Marketing): somente leitura.
DO $$
DECLARE
  item text;
BEGIN
  FOREACH item IN ARRAY ARRAY['marketing_membership_capacidades', 'marketing_origens_opcoes', 'marketing_sites', 'marketing_site_versoes',
                              'marketing_site_imagens', 'marketing_dominios', 'marketing_dns_simulado', 'marketing_campanhas',
                              'marketing_contatos', 'marketing_atribuicoes', 'marketing_eventos'] LOOP
    IF to_regclass('public.' || item) IS NULL THEN RAISE EXCEPTION 'postcheck 083: tabela % ausente', item; END IF;
  END LOOP;
  FOREACH item IN ARRAY ARRAY['marketing_sites_unidade_uk', 'marketing_dominios_host_uk', 'marketing_dominios_principal_uk',
                              'marketing_atrib_vigente_uk', 'marketing_atrib_substitui_uk', 'marketing_cap_ativa_uk', 'marketing_contatos_fechamento_uk'] LOOP
    IF to_regclass('public.' || item) IS NULL THEN RAISE EXCEPTION 'postcheck 083: índice % ausente', item; END IF;
  END LOOP;
  FOREACH item IN ARRAY ARRAY['marketing_cap_imutavel', 'marketing_versoes_imutavel', 'marketing_imagens_controle', 'marketing_dominios_controle',
                              'marketing_campanhas_controle', 'marketing_contatos_tenant', 'marketing_atrib_controle', 'marketing_eventos_imutavel'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = item AND tgenabled = 'O' AND NOT tgisinternal) THEN
      RAISE EXCEPTION 'postcheck 083: trigger % ausente ou desligado', item;
    END IF;
  END LOOP;
  FOREACH item IN ARRAY ARRAY['marketing_dominios_provedor', 'marketing_dominios_simulado', 'marketing_dominios_host', 'marketing_atrib_desconhecida',
                              'marketing_atrib_capturada_tem_campanha', 'marketing_atrib_correcao', 'marketing_contatos_chave_uk', 'marketing_contatos_vinculo_cliente',
                              'marketing_sites_publicado_tem_versao', 'marketing_sites_versao_fk', 'marketing_campanhas_codigo_uk', 'marketing_cap_capacidade'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = item AND convalidated) THEN
      RAISE EXCEPTION 'postcheck 083: restrição % ausente ou não validada', item;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM marketing_dominios WHERE provedor <> 'SIMULADO' OR NOT simulado) THEN
    RAISE EXCEPTION 'postcheck 083: domínio com provedor real (fora do escopo desta migration)';
  END IF;
  IF EXISTS (SELECT 1 FROM marketing_sites WHERE estado = 'PUBLICADO' AND versao_publicada_id IS NULL) THEN
    RAISE EXCEPTION 'postcheck 083: site publicado sem versão';
  END IF;
END $$;
SELECT '083 postcheck OK' AS resultado;
