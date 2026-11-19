-- 127 postcheck PREPARADO, NÃO EXECUTADO. Somente leitura. Confere objetos, gatilhos e a carga inicial da 127.
BEGIN TRANSACTION READ ONLY;
SET LOCAL search_path = public, pg_catalog;
DO $$
BEGIN
  IF to_regclass('public.marketing_saidas_contato') IS NULL OR to_regclass('public.marketing_saidas_viva_uk') IS NULL
     OR to_regprocedure('public.kidmais127_email(text)') IS NULL
     OR to_regprocedure('public.kidmais127_marcar_cliente(uuid,uuid,text,timestamp with time zone,uuid)') IS NULL THEN
    RAISE EXCEPTION '127 postcheck: objetos da 127 ausentes';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled = 'O' AND (tgrelid, tgname) IN (
        ('public.marketing_saidas_contato'::regclass, 'marketing_saidas_controle'),
        ('public.marketing_contato_preferencias'::regclass, 'marketing_saidas_por_preferencia'),
        ('public.clientes'::regclass, 'marketing_saidas_contato_novo'),
        ('public.whatsapp_atendimento_conversas'::regclass, 'marketing_saidas_por_atendimento'))) <> 4 THEN
    RAISE EXCEPTION '127 postcheck: gatilhos da 127 ausentes ou desligados';
  END IF;
  -- Todo contato válido de cliente descadastrado tem marca viva.
  IF EXISTS (
    SELECT 1 FROM marketing_contato_preferencias p JOIN clientes c ON c.id = p.cliente_id AND c.empresa_id = p.empresa_id
     CROSS JOIN LATERAL (VALUES ('TELEFONE', kidmais086_destino(c.whatsapp)), ('TELEFONE', kidmais086_destino(c.telefone)),
                                ('EMAIL', kidmais127_email(c.email))) v(tipo, valor)
     WHERE p.descadastrado_em IS NOT NULL AND v.valor IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM marketing_saidas_contato s WHERE s.empresa_id = p.empresa_id AND s.tipo = v.tipo
                          AND s.valor = v.valor AND s.encerrada_em IS NULL)) THEN
    RAISE EXCEPTION '127 postcheck: descadastro sem marca de saída';
  END IF;
  -- Todo número com nao_contatar no atendimento (que normaliza) tem marca viva.
  IF EXISTS (
    SELECT 1 FROM whatsapp_atendimento_conversas w
     WHERE w.nao_contatar AND kidmais086_destino(w.contato) IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM marketing_saidas_contato s WHERE s.empresa_id = w.empresa_id AND s.tipo = 'TELEFONE'
                          AND s.valor = kidmais086_destino(w.contato) AND s.encerrada_em IS NULL)) THEN
    RAISE EXCEPTION '127 postcheck: PARAR do atendimento sem marca de saída';
  END IF;
END $$;
SELECT current_database() AS banco, true AS aprovado,
  (SELECT count(*) FROM marketing_saidas_contato WHERE encerrada_em IS NULL) AS marcas_vivas;
ROLLBACK;
