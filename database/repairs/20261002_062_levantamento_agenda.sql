-- Levantamento da agenda depois da 062 (SOMENTE LEITURA; não é migration). Executar só com autorização para o alvo:
--   psql -X -v ON_ERROR_STOP=1 -f database/repairs/20261002_062_levantamento_agenda.sql
-- Lista o que AINDA NÃO está isolado por empresa e o que espera decisão explícita (D2/D3/D6). Nada é alterado.
-- Enquanto as consultas 2 e 3 devolverem linhas, a agenda NÃO está isolada por completo: esses registros continuam
-- tornando horários indisponíveis para todas as empresas (sem revelar quem ocupa).
BEGIN READ ONLY;
SET LOCAL search_path = public, pg_catalog;

DO $$ BEGIN
  IF to_regprocedure('public.kidmais062_ocupacoes_escopo(date,date)') IS NULL THEN
    RAISE EXCEPTION 'levantamento 062: a 062 não está aplicada (antes dela a agenda inteira é global).';
  END IF;
END $$;

-- 1. Elegibilidade das unidades (D6 = opção A). Regra única: kidmais062_unidade_agendavel = empresa ATIVA, unidade não
--    desativada e HABILITAÇÃO vigente (agenda_062_unidades_habilitacao). O status SUSPENSO da 043 não conta.
--    Sem unidade habilitada, a empresa é um único recurso de agenda.
SELECT e.id AS empresa_id, e.codigo, e.status AS empresa_status,
       count(u.id) FILTER (WHERE u.status = 'SUSPENSO') AS unidades_suspensas,
       count(u.id) FILTER (WHERE u.status = 'DESATIVADO') AS unidades_desativadas,
       count(u.id) FILTER (WHERE public.kidmais062_unidade_agendavel(u.empresa_id, u.id)) AS unidades_habilitadas
  FROM empresas e LEFT JOIN estabelecimentos u ON u.empresa_id = e.id
 GROUP BY e.id, e.codigo, e.status
 ORDER BY e.codigo;

-- 2. GLOBAL — contratações que ocupam agenda (ou têm destino de remarcação) SEM empresa (legado anterior à 054 cujo
--    pacote não tem empresa). Conflitam com todas as empresas. Resolução: política de legado da 054 (empresa do
--    pacote), por reparo próprio e autorizado; nunca por suposição.
SELECT o.fechamento_id, o.revisao_id, o.origem, o.data, o.horario_inicio, o.horario_fim
  FROM kidmais062_ocupacoes_escopo(current_date, 'infinity'::date) o
 WHERE o.empresa_id IS NULL
 ORDER BY o.data, o.horario_inicio;

-- 3. GLOBAL — bloqueios ativos sem dono, de hoje em diante (todos os anteriores à 062 e os criados com a 062
--    removida). Valem para todas as empresas até a resolução D3 (agenda_062_bloqueios_resolucao + reparo de
--    propriedade). Mesmo predicado que trava o reparo: toda linha PENDENTE aqui impede a aplicação. As empresas do
--    autor são só INDÍCIO para quem decide; nunca são aplicadas automaticamente. Resolução para unidade exige a
--    unidade habilitada (consulta 1).
SELECT b.id AS bloqueio_id, b.data, b.dia_inteiro, b.horario_inicio, b.horario_fim, b.motivo,
       (SELECT array_agg(DISTINCT m.empresa_id) FROM memberships m WHERE m.usuario_id = b.criado_por_usuario_id) AS indicio_empresas_do_autor,
       r.empresa_id AS resolvido_para_empresa, r.estabelecimento_id AS resolvido_para_unidade,
       CASE WHEN r.bloqueio_id IS NULL THEN 'PENDENTE' ELSE 'RESOLVIDO' END AS situacao
  FROM bloqueios_agenda b LEFT JOIN agenda_062_bloqueios_resolucao r ON r.bloqueio_id = b.id
 WHERE b.ativo AND b.empresa_id IS NULL AND b.data >= current_date
 ORDER BY b.data, b.horario_inicio NULLS FIRST;

-- 4. EMPRESA INTEIRA — contratações futuras de empresa sem unidade. Isoladas entre empresas; dentro da empresa valem
--    para todas as unidades até a decisão por contratação (consulta 6).
SELECT f.empresa_id, count(*) AS contratacoes_futuras_sem_unidade
  FROM fechamentos f
 WHERE f.empresa_id IS NOT NULL AND f.estabelecimento_id IS NULL AND f.data_evento >= current_date AND public.kidmais019_ocupa(f.id)
 GROUP BY f.empresa_id;

-- 5. Turnos: modelos globais (preservados; só classificam horários, não ocupam) e turnos por empresa/unidade.
SELECT CASE WHEN estabelecimento_id IS NOT NULL THEN 'UNIDADE' WHEN empresa_id IS NOT NULL THEN 'EMPRESA' ELSE 'GLOBAL' END AS nivel,
       count(*) AS turnos, count(*) FILTER (WHERE ativo) AS ativos
  FROM configuracao_agenda GROUP BY 1 ORDER BY 1;

-- 6. DECISÃO D2 — contratações futuras (propostas e reservas, não canceladas) sem unidade, com as unidades possíveis
--    da empresa e a decisão já gravada. Mesmo predicado da pendência do reparo de unidade.
--    Quem decide grava em agenda_062_fechamentos_resolucao (unidade, decidido_por, motivo); o reparo
--    20261002_062_fechamentos_unidade.sql aplica só as decididas, com a unidade já habilitada. Nada é inferido de
--    "a empresa só tem uma unidade".
SELECT f.id AS fechamento_id, f.empresa_id, f.data_evento, f.horario_inicio, f.horario_fim, f.status,
       (SELECT array_agg(u.id ORDER BY u.nome) FROM estabelecimentos u WHERE u.empresa_id = f.empresa_id AND u.status <> 'DESATIVADO') AS unidades_da_empresa,
       (SELECT array_agg(u.id ORDER BY u.nome) FROM estabelecimentos u WHERE u.empresa_id = f.empresa_id AND public.kidmais062_unidade_agendavel(u.empresa_id, u.id)) AS unidades_habilitadas,
       r.estabelecimento_id AS decidido_para_unidade,
       CASE WHEN r.fechamento_id IS NULL THEN 'SEM_DECISAO'
            WHEN public.kidmais062_unidade_agendavel(r.empresa_id, r.estabelecimento_id) THEN 'DECIDIDO'
            ELSE 'DECIDIDO_UNIDADE_NAO_HABILITADA' END AS situacao
  FROM fechamentos f LEFT JOIN agenda_062_fechamentos_resolucao r ON r.fechamento_id = f.id
 WHERE f.empresa_id IS NOT NULL AND f.estabelecimento_id IS NULL AND f.data_evento >= current_date AND f.status NOT IN ('CANCELADO', 'RECUSADO', 'EXPIRADO')
 ORDER BY f.empresa_id, f.data_evento, f.horario_inicio;

-- 7. Bloqueios PASSADOS sem dono (informativo; não travam o reparo nem decidem agenda futura).
SELECT count(*) AS bloqueios_passados_sem_dono FROM bloqueios_agenda WHERE ativo AND empresa_id IS NULL AND data < current_date;
COMMIT;
