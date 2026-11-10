-- 115 — Índice (empresa_id, data_evento) em fechamentos para o recorte por período das festas da empresa; remove o 054
--       (plano "Plano pesquisa de satisfacao 20261030", proposta P-114 renumerada para 115; desenho APROVADO pelo Astra
--       para implementação LOCAL; D-PS4-R3-2 decidida por Felipe em 03/11/2026).
--
-- NÃO APLICADA em banco persistente. Só o cluster descartável autorizado; staging e produção exigem autorização explícita
-- de Felipe (docs/OPERACAO_AGENTES.md). Número: 112 (clientes PJ), 113 (reservada à contagem do Google) e 114 (trava de
-- configuração da agenda, liberar salões) estão tomadas; 115 conferida livre em 03/11 (refs do GitHub, clones locais em
-- migrations/checks/rollback, vault). Número proposto, não reserva global.
--
--   * Só índices btree comuns; nenhuma linha, coluna, restrição ou função muda. O código da PS-4 é correto sem eles (é
--     só caminho de acesso; a escolha continua com o planner e é conferida nos planos do ensaio).
--   * Remove o fechamentos_054_empresa_idx (empresa_id) WHERE empresa_id IS NOT NULL, redundante com o prefixo do 115
--     (decisão de Felipe 03/11/2026, após a investigação da rodada 4): com a tabela fisicamente agrupada por empresa
--     (correlação de empresa_id alta), o planner preferia o 054 de uma coluna e lia todas as festas da empresa em vez da
--     faixa do período. Todo acesso só por empresa_id passa a usar o prefixo do 115. O 054 só sai depois que o 115 existe.
--   * Sem CONCURRENTLY: migration em transação, como as demais. A criação bloqueia escritas em fechamentos enquanto dura.
--     O DROP INDEX do 054 pede ACCESS EXCLUSIVE em fechamentos: a partir dele, LEITURAS também ficam bloqueadas até o
--     COMMIT, e ele espera leitores já abertos (PS4-R4-C3). lock_timeout limita só a ESPERA por cada lock; o
--     statement_timeout de 60 s vale por instrução, não é prazo da migration inteira. Antes de banco persistente: ensaiar
--     com leitor aberto e escolher janela.
--   * Guardas: se já existe um objeto com o nome do 115, ele tem de ser exatamente este índice (schema, tabela, btree,
--     colunas e ordem, ASC, classes de operador padrão, sem expressão nem predicado, não único, válido/pronto/vivo); se
--     existe o nome do 054, ele tem de ser exatamente o índice da 054 (btree, só empresa_id, ASC, opclass padrão, não
--     único, predicado empresa_id IS NOT NULL). Reaplicação (115 presente, 054 ausente) não faz nada; homônimo divergente
--     de qualquer um dos dois recusa sem alterar nada.
-- Down: database/rollback/20261103_115_fechamentos_empresa_data_down.sql. Precheck/postcheck: database/checks/20261103_115_*.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;

DO $$ BEGIN
  IF to_regclass('public.fechamentos') IS NULL
     OR (SELECT format_type(atttypid, atttypmod) FROM pg_attribute WHERE attrelid = 'public.fechamentos'::regclass AND attname = 'empresa_id' AND NOT attisdropped) IS DISTINCT FROM 'uuid'
     OR (SELECT format_type(atttypid, atttypmod) FROM pg_attribute WHERE attrelid = 'public.fechamentos'::regclass AND attname = 'data_evento' AND NOT attisdropped) IS DISTINCT FROM 'date' THEN
    RAISE EXCEPTION '115: fechamentos.empresa_id (uuid) e fechamentos.data_evento (date) são exigidos.';
  END IF;
  IF to_regclass('public.fechamentos_115_empresa_data_idx') IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_am am ON am.oid = c.relam
       WHERE c.oid = to_regclass('public.fechamentos_115_empresa_data_idx') AND n.nspname = 'public' AND c.relkind = 'i'
         AND i.indrelid = 'public.fechamentos'::regclass AND am.amname = 'btree'
         AND NOT i.indisunique AND i.indisvalid AND i.indisready AND i.indislive
         AND i.indnatts = 2 AND i.indnkeyatts = 2 AND i.indexprs IS NULL AND i.indpred IS NULL
         -- int2vector é indexado a partir de 0: compara elemento a elemento (a igualdade de arrays exige os mesmos limites)
         AND i.indkey[0] = (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.fechamentos'::regclass AND attname = 'empresa_id')
         AND i.indkey[1] = (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.fechamentos'::regclass AND attname = 'data_evento')
         AND i.indoption[0] = 0 AND i.indoption[1] = 0
         AND NOT EXISTS (SELECT 1 FROM unnest(i.indclass::oid[]) k(opc) JOIN pg_opclass o ON o.oid = k.opc WHERE NOT o.opcdefault)) THEN
      RAISE EXCEPTION '115: existe objeto fechamentos_115_empresa_data_idx com outra definição; nada foi alterado.';
    END IF;
    RAISE NOTICE '115: índice já presente e conforme; nada a fazer.';
  END IF;
  IF to_regclass('public.fechamentos_054_empresa_idx') IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_am am ON am.oid = c.relam
       WHERE c.oid = to_regclass('public.fechamentos_054_empresa_idx') AND n.nspname = 'public' AND c.relkind = 'i'
         AND i.indrelid = 'public.fechamentos'::regclass AND am.amname = 'btree'
         AND NOT i.indisunique AND i.indnatts = 1 AND i.indnkeyatts = 1 AND i.indexprs IS NULL
         AND i.indkey[0] = (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.fechamentos'::regclass AND attname = 'empresa_id')
         AND i.indoption[0] = 0
         AND pg_get_expr(i.indpred, i.indrelid) = '(empresa_id IS NOT NULL)'
         AND NOT EXISTS (SELECT 1 FROM unnest(i.indclass::oid[]) k(opc) JOIN pg_opclass o ON o.oid = k.opc WHERE NOT o.opcdefault)) THEN
    RAISE EXCEPTION '115: fechamentos_054_empresa_idx existe com outra definição; nada foi alterado.';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS fechamentos_115_empresa_data_idx ON public.fechamentos (empresa_id, data_evento);

COMMENT ON INDEX public.fechamentos_115_empresa_data_idx IS
  'Recorte por período das festas da empresa (PS-4, resultados da pesquisa de satisfação) e todo acesso só por empresa_id (substitui o 054). Só caminho de acesso; nenhuma regra depende dele.';

-- O 054 só sai com o 115 já criado nesta mesma transação: nunca fica sem caminho por empresa_id.
DROP INDEX IF EXISTS public.fechamentos_054_empresa_idx;

COMMIT;
