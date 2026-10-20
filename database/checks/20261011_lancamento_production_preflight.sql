-- PREPARADO, NAO EXECUTADO. P0b: leitura delimitada para revisar bloqueios e copias da 078.
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '10s';
SET LOCAL lock_timeout = '3s';
SET LOCAL search_path = public, pg_catalog;
DO $$ BEGIN
  IF current_database() <> 'kidmais_production' THEN RAISE EXCEPTION 'BANCO_RECUSADO'; END IF;
  IF (SELECT count(*) FROM empresas WHERE codigo='kidmais' AND id='7e990a2b-e64b-4630-9aae-4646fe936ede' AND status='ATIVA') <> 1 THEN
    RAISE EXCEPTION 'IDENTIDADE_KIDMAIS_DIVERGENTE';
  END IF;
  IF to_regclass('public.agenda_062_bloqueios_resolucao') IS NULL THEN RAISE EXCEPTION 'BASE_062_AUSENTE'; END IF;
  IF (SELECT count(*) FROM bloqueios_agenda WHERE ativo AND empresa_id IS NULL AND data>=current_date) > 20 THEN
    RAISE EXCEPTION 'MAIS_DE_20_BLOQUEIOS_REVISAR_ESCOPO';
  END IF;
END $$;
-- Nao le motivo, nome/e-mail/ID do autor nem dados de clientes. Vinculo do autor e apenas indicio, nao decisao.
SELECT b.id AS bloqueio_id, b.data, b.dia_inteiro, b.horario_inicio, b.horario_fim,
  ARRAY(SELECT DISTINCT e.codigo FROM memberships m JOIN empresas e ON e.id=m.empresa_id
    WHERE m.usuario_id=b.criado_por_usuario_id ORDER BY e.codigo) AS indicio_empresas_do_autor,
  e.codigo AS decisao_empresa, r.estabelecimento_id AS decisao_unidade,
  CASE WHEN r.bloqueio_id IS NULL THEN 'PENDENTE' ELSE 'RESOLVIDO' END AS situacao
FROM bloqueios_agenda b LEFT JOIN agenda_062_bloqueios_resolucao r ON r.bloqueio_id=b.id
LEFT JOIN empresas e ON e.id=r.empresa_id
WHERE b.ativo AND b.empresa_id IS NULL AND b.data>=current_date
ORDER BY b.data, b.horario_inicio NULLS FIRST, b.id;
-- Mesma origem de uso da consulta revisada no precheck 078; a migration copia somente o que ja e utilizado.
WITH k AS (SELECT id FROM empresas WHERE codigo='kidmais'), uso AS (
  SELECT p.empresa_id, pbc.categoria_id FROM pacote_buffet_categorias pbc JOIN pacotes p ON p.id=pbc.pacote_id
  UNION SELECT p.empresa_id, i.categoria_id FROM pacote_itens_especificos pe JOIN pacotes p ON p.id=pe.pacote_id JOIN buffet_itens i ON i.id=pe.item_id
  UNION SELECT a.empresa_id, a.origem_buffet_categoria_id FROM adicionais a WHERE a.origem_buffet_categoria_id IS NOT NULL
  UNION SELECT a.empresa_id, i.categoria_id FROM adicionais a JOIN buffet_itens i ON i.id=a.origem_buffet_item_id
)
SELECT e.codigo AS empresa_que_recebe_copia,
  count(DISTINCT uso.categoria_id) FILTER (WHERE uso.categoria_id IS NOT NULL) AS categorias_usadas,
  bool_or(uso.categoria_id IS NULL) AS usa_item_sem_categoria
FROM uso JOIN empresas e ON e.id=uso.empresa_id
WHERE uso.empresa_id IS DISTINCT FROM (SELECT id FROM k)
GROUP BY e.codigo ORDER BY e.codigo;
ROLLBACK;
