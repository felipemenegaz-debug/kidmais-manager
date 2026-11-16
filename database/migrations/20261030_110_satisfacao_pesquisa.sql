-- 110 — Pesquisa de satisfação pós-festa (PS-1 do plano "Plano pesquisa de satisfacao 20261030", rev. 6 APROVADA pelo
--       Astra; D-PS1..D-PS8 decididas por Felipe em 30/10/2026).
--
-- NÃO APLICADA em banco persistente. PS-1 é LOCAL: só o cluster descartável autorizado; staging e produção exigem
-- autorização explícita de Felipe (docs/OPERACAO_AGENTES.md). Exige a 086 (automações de Marketing), a 054 (empresa
-- imutável em clientes/fechamentos) e a 043 (unidades e vínculos por unidade).
--
-- O que muda no Marketing (086):
--   * regra POS_FESTA ganha a ação PESQUISA_SATISFACAO (só nela), os canais (WHATSAPP/EMAIL) e o modelo do lembrete;
--   * execução ganha o estado terminal PESQUISA_CRIADA (a execução cria o envio e termina; o despacho é por entrega);
--   * kidmais086_execucao_tenant(): mesmo corpo, com PESQUISA_CRIADA na lista de estados concluídos (N4).
-- O que é novo (lib/satisfacao, docs/SATISFACAO_PESQUISA_20261030.md):
--   * satisfacao_envios: uma pesquisa por festa (fechamento), link por HMAC recalculável (só o hash é gravado),
--     vínculos conferidos na criação e imutáveis depois, terminalidade por gatilho, marco de contato (contato_em);
--   * satisfacao_respostas: uma por envio, só em envio ATIVO e válido; invariável resposta ⇔ RESPONDIDO no COMMIT;
--   * satisfacao_tarefas: nota de 0 a 6, criada na mesma transação da resposta (fila da unidade);
--   * satisfacao_entregas: estado por canal e etapa (protocolo do motor: ENVIANDO confirmado antes da rede);
--   * satisfacao_saidas (saída das pesquisas), satisfacao_capacidades (D-PS8), satisfacao_agregados_mensais e
--     satisfacao_expurgos (D-PS7; sem escritor até a PS-6), satisfacao_email_simulado (caixa de saída local).
-- Nenhum DELETE é aceito nas tabelas de evidência: o expurgo com agregado (D-PS7) é uma função restrita da PS-6.
-- Desvio registrado do plano: fechamentos.estabelecimento_id é opcional (062), então a unidade do envio também é —
-- NULL = festa sem unidade, coerência por IS NOT DISTINCT FROM; a fila dessa festa é só da Gestão.
-- Rollback operacional: SATISFACAO_PESQUISA_ENABLED diferente de "true". Down: database/rollback/20261030_110_satisfacao_pesquisa_down.sql
-- (recusa com qualquer dado da pesquisa). Precheck/postcheck: database/checks/20261030_110_{precheck,postcheck}.sql.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;

DO $$ BEGIN
  IF to_regclass('public.marketing_automacao_execucoes') IS NULL OR to_regprocedure('public.kidmais086_execucao_tenant()') IS NULL THEN
    RAISE EXCEPTION '110 exige a 086.';
  END IF;
  IF to_regclass('public.estabelecimentos') IS NULL OR to_regclass('public.membership_estabelecimentos') IS NULL THEN
    RAISE EXCEPTION '110 exige a 043.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'clientes_054_empresa_imutavel_trg' AND tgrelid = 'public.clientes'::regclass AND tgenabled = 'O')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'fechamentos_054_empresa_imutavel_trg' AND tgrelid = 'public.fechamentos'::regclass AND tgenabled = 'O') THEN
    RAISE EXCEPTION '110 exige os gatilhos de empresa imutável da 054, habilitados.';
  END IF;
  IF to_regclass('public.satisfacao_envios') IS NOT NULL OR to_regclass('public.satisfacao_respostas') IS NOT NULL
     OR to_regclass('public.satisfacao_entregas') IS NOT NULL OR to_regclass('public.satisfacao_tarefas') IS NOT NULL
     OR to_regclass('public.satisfacao_saidas') IS NOT NULL OR to_regclass('public.satisfacao_capacidades') IS NOT NULL
     OR to_regclass('public.satisfacao_agregados_mensais') IS NOT NULL OR to_regclass('public.satisfacao_expurgos') IS NOT NULL
     OR to_regclass('public.satisfacao_email_simulado') IS NOT NULL
     OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'marketing_automacao_regras' AND column_name = 'canais') THEN
    RAISE EXCEPTION '110 já aplicada (total ou parcialmente).';
  END IF;
END $$;

-- =============================================================================
-- 1. Marketing (086): ação PESQUISA_SATISFACAO, canais, modelo do lembrete e estado PESQUISA_CRIADA
-- =============================================================================
ALTER TABLE marketing_automacao_regras
  ADD COLUMN canais text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN template_lembrete_texto text,
  ADD COLUMN template_lembrete_provedor text,
  DROP CONSTRAINT marketing_regras_acao,
  ADD CONSTRAINT marketing_regras_acao CHECK (acao IN ('TAREFA_INTERNA', 'MENSAGEM_WHATSAPP', 'SUGESTAO', 'PESQUISA_SATISFACAO')),
  ADD CONSTRAINT marketing_regras_pesquisa_pos_festa CHECK (acao <> 'PESQUISA_SATISFACAO' OR tipo = 'POS_FESTA'),
  ADD CONSTRAINT marketing_regras_canais CHECK (canais <@ ARRAY['WHATSAPP', 'EMAIL']::text[] AND array_position(canais, NULL) IS NULL
    AND cardinality(canais) <= 2 AND (cardinality(canais) < 2 OR canais[1] <> canais[2])
    AND ((acao = 'PESQUISA_SATISFACAO') = (cardinality(canais) >= 1))),
  ADD CONSTRAINT marketing_regras_template_lembrete CHECK (template_lembrete_texto IS NULL OR char_length(template_lembrete_texto) BETWEEN 1 AND 1000),
  ADD CONSTRAINT marketing_regras_template_lembrete_provedor CHECK (template_lembrete_provedor IS NULL OR template_lembrete_provedor ~ '^[a-z0-9_]{3,64}$'),
  -- Pesquisa com WhatsApp ativa exige os dois modelos da Meta (inicial e lembrete) com texto revisado (R3).
  ADD CONSTRAINT marketing_regras_pesquisa_revisada CHECK (status <> 'ATIVA' OR acao <> 'PESQUISA_SATISFACAO' OR NOT ('WHATSAPP' = ANY (canais))
    OR (template_texto IS NOT NULL AND template_provedor IS NOT NULL AND template_revisado_em IS NOT NULL
        AND template_lembrete_texto IS NOT NULL AND template_lembrete_provedor IS NOT NULL));

ALTER TABLE marketing_automacao_execucoes
  DROP CONSTRAINT marketing_exec_acao,
  ADD CONSTRAINT marketing_exec_acao CHECK (acao IN ('TAREFA_INTERNA', 'MENSAGEM_WHATSAPP', 'PESQUISA_SATISFACAO')),
  DROP CONSTRAINT marketing_exec_estado,
  ADD CONSTRAINT marketing_exec_estado CHECK (estado IN ('AGENDADA', 'PROCESSANDO', 'ENVIANDO', 'TAREFA_CRIADA', 'PESQUISA_CRIADA', 'ACEITA', 'ENTREGUE', 'FALHOU', 'INCERTA', 'SUPRIMIDA', 'CANCELADA')),
  DROP CONSTRAINT marketing_exec_final,
  ADD CONSTRAINT marketing_exec_final CHECK ((estado IN ('TAREFA_CRIADA', 'PESQUISA_CRIADA', 'ENTREGUE', 'SUPRIMIDA', 'CANCELADA')) = (concluida_em IS NOT NULL) OR estado IN ('ACEITA', 'FALHOU', 'INCERTA')),
  -- A execução da pesquisa nunca envia: ela cria o envio (PESQUISA_CRIADA) ou termina suprimida/cancelada.
  ADD CONSTRAINT marketing_exec_pesquisa_estados CHECK (acao <> 'PESQUISA_SATISFACAO' OR estado IN ('AGENDADA', 'PROCESSANDO', 'PESQUISA_CRIADA', 'SUPRIMIDA', 'CANCELADA')),
  ADD CONSTRAINT marketing_exec_pesquisa_criada CHECK (estado <> 'PESQUISA_CRIADA' OR acao = 'PESQUISA_SATISFACAO');

-- N4: mesmo corpo da 086; a única diferença é PESQUISA_CRIADA na lista de estados concluídos.
CREATE OR REPLACE FUNCTION kidmais086_execucao_tenant() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_catalog, pg_temp AS $$
DECLARE dono uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION '086: execução de automação não é apagada; cancele.'; END IF;
  IF TG_OP = 'UPDATE' AND (NEW.empresa_id IS DISTINCT FROM OLD.empresa_id OR NEW.regra_id IS DISTINCT FROM OLD.regra_id
     OR NEW.cliente_id IS DISTINCT FROM OLD.cliente_id OR NEW.chave_idempotencia IS DISTINCT FROM OLD.chave_idempotencia
     OR NEW.alvo_id IS DISTINCT FROM OLD.alvo_id OR NEW.acao IS DISTINCT FROM OLD.acao) THEN
    RAISE EXCEPTION '086: identidade da execução é imutável.';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.estado IN ('TAREFA_CRIADA', 'PESQUISA_CRIADA', 'ENTREGUE', 'SUPRIMIDA', 'CANCELADA') THEN
    RAISE EXCEPTION '086: execução concluída não muda (%).', OLD.estado;
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT empresa_id INTO dono FROM clientes WHERE id = NEW.cliente_id;
    IF dono IS DISTINCT FROM NEW.empresa_id THEN RAISE EXCEPTION '086: cliente da execução é de outra empresa.'; END IF;
    IF NEW.fechamento_id IS NOT NULL THEN
      SELECT empresa_id INTO dono FROM fechamentos WHERE id = NEW.fechamento_id;
      IF dono IS DISTINCT FROM NEW.empresa_id THEN RAISE EXCEPTION '086: negociação da execução é de outra empresa.'; END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- =============================================================================
-- 2. Envio: uma pesquisa por festa
-- =============================================================================
CREATE TABLE satisfacao_envios (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  estabelecimento_id uuid,
  fechamento_id uuid NOT NULL,
  cliente_id uuid NOT NULL,
  execucao_id uuid NOT NULL,
  versao_formato smallint NOT NULL DEFAULT 1,
  geracao integer NOT NULL DEFAULT 1,
  chave_versao smallint NOT NULL,
  token_hash bytea NOT NULL,
  estado text NOT NULL DEFAULT 'ATIVO',
  criado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  expira_em timestamptz NOT NULL,
  contato_em timestamptz,
  respondido_em timestamptz,
  expirado_em timestamptz,
  revogado_em timestamptz,
  motivo_revogacao text,
  atualizado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- N2: FK simples nos pais sem UNIQUE (empresa_id, id); a empresa deles é imutável pela 054.
  CONSTRAINT satisfacao_envios_fechamento_fk FOREIGN KEY (fechamento_id) REFERENCES fechamentos (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT satisfacao_envios_cliente_fk FOREIGN KEY (cliente_id) REFERENCES clientes (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT satisfacao_envios_unidade_fk FOREIGN KEY (empresa_id, estabelecimento_id) REFERENCES estabelecimentos (empresa_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT satisfacao_envios_execucao_fk FOREIGN KEY (empresa_id, execucao_id) REFERENCES marketing_automacao_execucoes (empresa_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT satisfacao_envios_festa_uk UNIQUE (empresa_id, fechamento_id),
  CONSTRAINT satisfacao_envios_token_uk UNIQUE (token_hash),
  CONSTRAINT satisfacao_envios_escopo_uk UNIQUE (empresa_id, id),
  CONSTRAINT satisfacao_envios_execucao_uk UNIQUE (execucao_id),
  CONSTRAINT satisfacao_envios_formato CHECK (versao_formato = 1),
  CONSTRAINT satisfacao_envios_geracao CHECK (geracao >= 1),
  CONSTRAINT satisfacao_envios_chave CHECK (chave_versao BETWEEN 1 AND 255),
  CONSTRAINT satisfacao_envios_hash CHECK (octet_length(token_hash) = 32),
  CONSTRAINT satisfacao_envios_estado CHECK (estado IN ('ATIVO', 'RESPONDIDO', 'EXPIRADO', 'REVOGADO')),
  CONSTRAINT satisfacao_envios_validade CHECK (expira_em = criado_em + interval '30 days'),
  CONSTRAINT satisfacao_envios_respondido CHECK ((estado = 'RESPONDIDO') = (respondido_em IS NOT NULL)),
  CONSTRAINT satisfacao_envios_revogado CHECK ((estado = 'REVOGADO') = (revogado_em IS NOT NULL AND motivo_revogacao IS NOT NULL)),
  CONSTRAINT satisfacao_envios_revogado_motivo CHECK (motivo_revogacao IS NULL OR motivo_revogacao IN ('FESTA_CANCELADA', 'CONTRATO_NAO_ASSINADO')),
  CONSTRAINT satisfacao_envios_revogado_coerente CHECK (revogado_em IS NOT NULL OR motivo_revogacao IS NULL),
  CONSTRAINT satisfacao_envios_expirado CHECK ((estado = 'EXPIRADO') = (expirado_em IS NOT NULL)),
  CONSTRAINT satisfacao_envios_contato CHECK (contato_em IS NULL OR contato_em >= criado_em)
);
CREATE INDEX satisfacao_envios_cliente_idx ON satisfacao_envios (empresa_id, cliente_id, contato_em);
CREATE INDEX satisfacao_envios_ativos_idx ON satisfacao_envios (expira_em) WHERE estado = 'ATIVO';

/*
 * Guarda do envio:
 *   - INSERT: nasce ATIVO, geração 1, sem marco nem datas de fim; trava o fechamento FOR SHARE NOWAIT (55P03 se ocupado,
 *     a pesquisa nunca espera pelos pais) e exige empresa, unidade e cliente do fechamento e a execução de PESQUISA do
 *     mesmo fechamento e cliente (N2: coerência só na criação);
 *   - UPDATE: vínculos, validade e criação imutáveis; transições só ATIVO → RESPONDIDO | EXPIRADO | REVOGADO (M1);
 *     estado terminal não muda (datas de fim congeladas); regeneração (N1) só em ATIVO, geração + 1 com hash novo;
 *     contato_em é gravado uma vez (L2) e depois imutável;
 *   - DELETE: recusado (o expurgo com agregado é a função restrita da PS-6).
 */
CREATE FUNCTION kidmais110_envio_guarda() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_catalog, pg_temp AS $$
DECLARE f record; x record;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION '110: envio de pesquisa não é apagado.' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.estado <> 'ATIVO' OR NEW.geracao <> 1 OR NEW.contato_em IS NOT NULL OR NEW.respondido_em IS NOT NULL OR NEW.expirado_em IS NOT NULL
       OR NEW.revogado_em IS NOT NULL OR NEW.motivo_revogacao IS NOT NULL THEN
      RAISE EXCEPTION '110: envio nasce ATIVO, geração 1 e sem marco.' USING ERRCODE = '23514';
    END IF;
    SELECT empresa_id, estabelecimento_id, cliente_id INTO f FROM fechamentos WHERE id = NEW.fechamento_id FOR SHARE NOWAIT;
    IF NOT FOUND OR f.empresa_id IS DISTINCT FROM NEW.empresa_id THEN RAISE EXCEPTION '110: festa de outra empresa.' USING ERRCODE = '23514'; END IF;
    IF f.estabelecimento_id IS DISTINCT FROM NEW.estabelecimento_id THEN RAISE EXCEPTION '110: unidade diferente da festa.' USING ERRCODE = '23514'; END IF;
    IF f.cliente_id IS DISTINCT FROM NEW.cliente_id THEN RAISE EXCEPTION '110: cliente diferente da festa.' USING ERRCODE = '23514'; END IF;
    SELECT fechamento_id, cliente_id, acao INTO x FROM marketing_automacao_execucoes WHERE empresa_id = NEW.empresa_id AND id = NEW.execucao_id;
    IF NOT FOUND OR x.acao <> 'PESQUISA_SATISFACAO' OR x.fechamento_id IS DISTINCT FROM NEW.fechamento_id OR x.cliente_id IS DISTINCT FROM NEW.cliente_id THEN
      RAISE EXCEPTION '110: execução de outra festa, outro cliente ou outra ação.' USING ERRCODE = '23514';
    END IF;
    NEW.atualizado_em := NEW.criado_em;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.empresa_id IS DISTINCT FROM OLD.empresa_id OR NEW.estabelecimento_id IS DISTINCT FROM OLD.estabelecimento_id
     OR NEW.fechamento_id IS DISTINCT FROM OLD.fechamento_id OR NEW.cliente_id IS DISTINCT FROM OLD.cliente_id OR NEW.execucao_id IS DISTINCT FROM OLD.execucao_id
     OR NEW.versao_formato IS DISTINCT FROM OLD.versao_formato OR NEW.criado_em IS DISTINCT FROM OLD.criado_em OR NEW.expira_em IS DISTINCT FROM OLD.expira_em THEN
    RAISE EXCEPTION '110: vínculos e validade do envio são imutáveis.' USING ERRCODE = '23514';
  END IF;
  IF OLD.contato_em IS NOT NULL AND NEW.contato_em IS DISTINCT FROM OLD.contato_em THEN
    RAISE EXCEPTION '110: o marco de contato é gravado uma vez.' USING ERRCODE = '23514';
  END IF;
  IF OLD.estado <> 'ATIVO' AND (NEW.estado IS DISTINCT FROM OLD.estado OR NEW.respondido_em IS DISTINCT FROM OLD.respondido_em
     OR NEW.expirado_em IS DISTINCT FROM OLD.expirado_em OR NEW.revogado_em IS DISTINCT FROM OLD.revogado_em
     OR NEW.motivo_revogacao IS DISTINCT FROM OLD.motivo_revogacao) THEN
    RAISE EXCEPTION '110: envio % é terminal.', OLD.estado USING ERRCODE = '23514';
  END IF;
  IF NEW.geracao IS DISTINCT FROM OLD.geracao OR NEW.chave_versao IS DISTINCT FROM OLD.chave_versao OR NEW.token_hash IS DISTINCT FROM OLD.token_hash THEN
    IF OLD.estado <> 'ATIVO' OR NEW.estado <> 'ATIVO' OR NEW.geracao <> OLD.geracao + 1 OR NEW.token_hash = OLD.token_hash THEN
      RAISE EXCEPTION '110: regeneração só em envio ATIVO, com a próxima geração e hash novo.' USING ERRCODE = '23514';
    END IF;
  END IF;
  NEW.atualizado_em := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER satisfacao_envios_guarda BEFORE INSERT OR UPDATE OR DELETE ON satisfacao_envios FOR EACH ROW EXECUTE FUNCTION kidmais110_envio_guarda();

-- =============================================================================
-- 3. Resposta: uma por envio, só em envio ATIVO e válido
-- =============================================================================
CREATE TABLE satisfacao_respostas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL,
  envio_id uuid NOT NULL,
  versao_questionario smallint NOT NULL,
  nota_indicacao smallint NOT NULL,
  nota_comida smallint,
  nota_equipe smallint,
  nota_espaco smallint,
  comentario text,
  respondido_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT satisfacao_respostas_envio_fk FOREIGN KEY (empresa_id, envio_id) REFERENCES satisfacao_envios (empresa_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT satisfacao_respostas_envio_uk UNIQUE (envio_id),
  CONSTRAINT satisfacao_respostas_escopo_uk UNIQUE (empresa_id, id),
  CONSTRAINT satisfacao_respostas_versao CHECK (versao_questionario IN (1)),
  CONSTRAINT satisfacao_respostas_nps CHECK (nota_indicacao BETWEEN 0 AND 10),
  CONSTRAINT satisfacao_respostas_aspectos CHECK ((nota_comida IS NULL OR nota_comida BETWEEN 1 AND 5) AND (nota_equipe IS NULL OR nota_equipe BETWEEN 1 AND 5)
    AND (nota_espaco IS NULL OR nota_espaco BETWEEN 1 AND 5)),
  CONSTRAINT satisfacao_respostas_comentario CHECK (comentario IS NULL OR (comentario = btrim(comentario) AND char_length(comentario) BETWEEN 1 AND 2000))
);
CREATE INDEX satisfacao_respostas_periodo_idx ON satisfacao_respostas (empresa_id, respondido_em);

-- M1/L1: segunda linha de defesa (inclusive para INSERT direto): trava o envio e exige ATIVO e dentro da validade.
CREATE FUNCTION kidmais110_resposta_guarda() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_catalog, pg_temp AS $$
DECLARE e record;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION '110: resposta de pesquisa é imutável.' USING ERRCODE = '23514'; END IF;
  SELECT estado, expira_em INTO e FROM satisfacao_envios WHERE id = NEW.envio_id AND empresa_id = NEW.empresa_id FOR UPDATE;
  IF NOT FOUND OR e.estado <> 'ATIVO' OR e.expira_em <= clock_timestamp() THEN
    RAISE EXCEPTION '110: só envio ATIVO e válido recebe resposta.' USING ERRCODE = '23514';
  END IF;
  NEW.respondido_em := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER satisfacao_respostas_guarda BEFORE INSERT OR UPDATE OR DELETE ON satisfacao_respostas FOR EACH ROW EXECUTE FUNCTION kidmais110_resposta_guarda();

-- L1 (com a ressalva da rev. 6): no COMMIT, relê as TABELAS (nunca o NEW agendado): resposta ⇔ envio RESPONDIDO.
CREATE FUNCTION kidmais110_invariante_resposta() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_catalog, pg_temp AS $$
DECLARE alvo uuid; estado_atual text; respostas integer;
BEGIN
  -- Ramos separados: o PL/pgSQL resolve NEW.<campo> ao planejar a expressão, e o envio não tem envio_id.
  IF TG_TABLE_NAME = 'satisfacao_respostas' THEN alvo := NEW.envio_id; ELSE alvo := NEW.id; END IF;
  SELECT estado INTO estado_atual FROM satisfacao_envios WHERE id = alvo;
  SELECT count(*) INTO respostas FROM satisfacao_respostas WHERE envio_id = alvo;
  IF estado_atual IS NULL THEN RAISE EXCEPTION '110: envio da resposta ausente.' USING ERRCODE = '23514'; END IF;
  IF (estado_atual = 'RESPONDIDO' AND respostas <> 1) OR (estado_atual <> 'RESPONDIDO' AND respostas <> 0) THEN
    RAISE EXCEPTION '110: envio % com % resposta(s) no COMMIT.', estado_atual, respostas USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER satisfacao_respostas_invariante AFTER INSERT ON satisfacao_respostas DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION kidmais110_invariante_resposta();
CREATE CONSTRAINT TRIGGER satisfacao_envios_invariante AFTER INSERT OR UPDATE ON satisfacao_envios DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION kidmais110_invariante_resposta();

-- =============================================================================
-- 4. Tarefa da nota baixa (0 a 6): na mesma transação da resposta, fila da unidade do envio
-- =============================================================================
CREATE TABLE satisfacao_tarefas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL,
  estabelecimento_id uuid,
  envio_id uuid NOT NULL,
  resposta_id uuid NOT NULL,
  estado text NOT NULL DEFAULT 'ABERTA',
  observacao text,
  concluida_em timestamptz,
  concluida_por uuid REFERENCES usuarios_administrativos (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  criado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  atualizado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT satisfacao_tarefas_resposta_fk FOREIGN KEY (empresa_id, resposta_id) REFERENCES satisfacao_respostas (empresa_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT satisfacao_tarefas_envio_fk FOREIGN KEY (empresa_id, envio_id) REFERENCES satisfacao_envios (empresa_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT satisfacao_tarefas_unidade_fk FOREIGN KEY (empresa_id, estabelecimento_id) REFERENCES estabelecimentos (empresa_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT satisfacao_tarefas_resposta_uk UNIQUE (resposta_id),
  CONSTRAINT satisfacao_tarefas_escopo_uk UNIQUE (empresa_id, id),
  CONSTRAINT satisfacao_tarefas_estado CHECK (estado IN ('ABERTA', 'CONCLUIDA')),
  CONSTRAINT satisfacao_tarefas_conclusao CHECK ((estado = 'CONCLUIDA') = (concluida_em IS NOT NULL AND concluida_por IS NOT NULL)),
  CONSTRAINT satisfacao_tarefas_observacao CHECK (observacao IS NULL OR char_length(observacao) BETWEEN 1 AND 1000)
);
CREATE INDEX satisfacao_tarefas_fila_idx ON satisfacao_tarefas (empresa_id, estabelecimento_id) WHERE estado = 'ABERTA';

CREATE FUNCTION kidmais110_tarefa_guarda() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_catalog, pg_temp AS $$
DECLARE r record;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION '110: tarefa de pesquisa não é apagada.' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT re.envio_id, re.nota_indicacao, e.estabelecimento_id INTO r
      FROM satisfacao_respostas re JOIN satisfacao_envios e ON e.id = re.envio_id
     WHERE re.id = NEW.resposta_id AND re.empresa_id = NEW.empresa_id;
    IF NOT FOUND OR r.envio_id IS DISTINCT FROM NEW.envio_id THEN RAISE EXCEPTION '110: tarefa de outra resposta.' USING ERRCODE = '23514'; END IF;
    IF r.estabelecimento_id IS DISTINCT FROM NEW.estabelecimento_id THEN RAISE EXCEPTION '110: tarefa precisa da unidade do envio.' USING ERRCODE = '23514'; END IF;
    IF r.nota_indicacao > 6 THEN RAISE EXCEPTION '110: tarefa só para nota de 0 a 6.' USING ERRCODE = '23514'; END IF;
    IF NEW.estado <> 'ABERTA' THEN RAISE EXCEPTION '110: tarefa nasce ABERTA.' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.empresa_id IS DISTINCT FROM OLD.empresa_id OR NEW.estabelecimento_id IS DISTINCT FROM OLD.estabelecimento_id
     OR NEW.envio_id IS DISTINCT FROM OLD.envio_id OR NEW.resposta_id IS DISTINCT FROM OLD.resposta_id OR NEW.criado_em IS DISTINCT FROM OLD.criado_em THEN
    RAISE EXCEPTION '110: vínculos da tarefa são imutáveis.' USING ERRCODE = '23514';
  END IF;
  IF OLD.estado = 'CONCLUIDA' THEN RAISE EXCEPTION '110: tarefa concluída não muda.' USING ERRCODE = '23514'; END IF;
  NEW.atualizado_em := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER satisfacao_tarefas_guarda BEFORE INSERT OR UPDATE OR DELETE ON satisfacao_tarefas FOR EACH ROW EXECUTE FUNCTION kidmais110_tarefa_guarda();

-- =============================================================================
-- 5. Entregas por canal e etapa (protocolo do motor da 086)
-- =============================================================================
CREATE TABLE satisfacao_entregas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL,
  envio_id uuid NOT NULL,
  canal text NOT NULL,
  etapa text NOT NULL,
  estado text NOT NULL DEFAULT 'PENDENTE',
  agendada_para timestamptz NOT NULL,
  tentativas integer NOT NULL DEFAULT 0,
  max_tentativas integer NOT NULL,
  proxima_tentativa_em timestamptz,
  posse_token uuid,
  posse_ate timestamptz,
  tentativa_iniciada_em timestamptz,
  provedor_mensagem_id text,
  motivo text,
  destinatario_mascarado text,
  conteudo text,
  criado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  atualizado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  concluida_em timestamptz,
  CONSTRAINT satisfacao_entregas_envio_fk FOREIGN KEY (empresa_id, envio_id) REFERENCES satisfacao_envios (empresa_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT satisfacao_entregas_uk UNIQUE (envio_id, canal, etapa),
  CONSTRAINT satisfacao_entregas_escopo_uk UNIQUE (empresa_id, id),
  CONSTRAINT satisfacao_entregas_canal CHECK (canal IN ('WHATSAPP', 'EMAIL')),
  CONSTRAINT satisfacao_entregas_etapa CHECK (etapa IN ('INICIAL', 'LEMBRETE')),
  CONSTRAINT satisfacao_entregas_estado CHECK (estado IN ('PENDENTE', 'ENVIANDO', 'ACEITA', 'ENTREGUE', 'FALHOU', 'INCERTA', 'SUPRIMIDA', 'CANCELADA')),
  CONSTRAINT satisfacao_entregas_tentativas CHECK (tentativas BETWEEN 0 AND max_tentativas AND max_tentativas BETWEEN 1 AND 5),
  CONSTRAINT satisfacao_entregas_posse CHECK ((estado = 'ENVIANDO') = (posse_token IS NOT NULL AND posse_ate IS NOT NULL)),
  CONSTRAINT satisfacao_entregas_tentativa CHECK (estado <> 'ENVIANDO' OR tentativa_iniciada_em IS NOT NULL),
  CONSTRAINT satisfacao_entregas_provedor CHECK (estado NOT IN ('ACEITA', 'ENTREGUE') OR provedor_mensagem_id IS NOT NULL),
  CONSTRAINT satisfacao_entregas_final CHECK ((estado IN ('ENTREGUE', 'SUPRIMIDA', 'CANCELADA')) = (concluida_em IS NOT NULL) OR estado IN ('ACEITA', 'FALHOU', 'INCERTA')),
  CONSTRAINT satisfacao_entregas_motivo CHECK (motivo IS NULL OR char_length(motivo) <= 300),
  CONSTRAINT satisfacao_entregas_conteudo CHECK (conteudo IS NULL OR char_length(conteudo) <= 4000)
);
CREATE INDEX satisfacao_entregas_fila_idx ON satisfacao_entregas (agendada_para) WHERE estado = 'PENDENTE';
CREATE INDEX satisfacao_entregas_posse_idx ON satisfacao_entregas (posse_ate) WHERE estado = 'ENVIANDO';
CREATE UNIQUE INDEX satisfacao_entregas_provedor_uk ON satisfacao_entregas (provedor_mensagem_id) WHERE provedor_mensagem_id IS NOT NULL;

/*
 * Guarda da entrega: identidade imutável; ENTREGUE/SUPRIMIDA/CANCELADA terminais; passar a ENVIANDO exige o envio ATIVO
 * e dentro de expira_em − 24 h (PRAZO_ESGOTADO) e, no segundo canal INICIAL, até 48 h depois do marco (L2, conferido a
 * cada tentativa). O worker confere antes e suprime com o motivo; o gatilho é a segunda linha de defesa.
 */
CREATE FUNCTION kidmais110_entrega_guarda() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_catalog, pg_temp AS $$
DECLARE e record;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION '110: entrega de pesquisa não é apagada.' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.estado <> 'PENDENTE' OR NEW.tentativas <> 0 THEN RAISE EXCEPTION '110: entrega nasce PENDENTE.' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.empresa_id IS DISTINCT FROM OLD.empresa_id OR NEW.envio_id IS DISTINCT FROM OLD.envio_id
     OR NEW.canal IS DISTINCT FROM OLD.canal OR NEW.etapa IS DISTINCT FROM OLD.etapa OR NEW.criado_em IS DISTINCT FROM OLD.criado_em THEN
    RAISE EXCEPTION '110: identidade da entrega é imutável.' USING ERRCODE = '23514';
  END IF;
  IF OLD.estado IN ('ENTREGUE', 'SUPRIMIDA', 'CANCELADA') THEN RAISE EXCEPTION '110: entrega concluída não muda (%).', OLD.estado USING ERRCODE = '23514'; END IF;
  IF NEW.estado = 'ENVIANDO' AND OLD.estado <> 'ENVIANDO' THEN
    SELECT estado, expira_em, contato_em INTO e FROM satisfacao_envios WHERE id = NEW.envio_id;
    IF e.estado <> 'ATIVO' THEN RAISE EXCEPTION '110: envio não está ATIVO.' USING ERRCODE = '23514'; END IF;
    IF clock_timestamp() > e.expira_em - interval '24 hours' THEN RAISE EXCEPTION '110: PRAZO_ESGOTADO.' USING ERRCODE = '23514'; END IF;
    IF NEW.etapa = 'INICIAL' AND e.contato_em IS NOT NULL AND clock_timestamp() > e.contato_em + interval '48 hours' THEN
      RAISE EXCEPTION '110: SEGUNDO_CANAL_FORA_DO_PRAZO.' USING ERRCODE = '23514';
    END IF;
  END IF;
  NEW.atualizado_em := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER satisfacao_entregas_guarda BEFORE INSERT OR UPDATE OR DELETE ON satisfacao_entregas FOR EACH ROW EXECUTE FUNCTION kidmais110_entrega_guarda();

-- L2 + ressalva da rev. 6: o marco é gravado NA MESMA INSTRUÇÃO que conclui a primeira entrega INICIAL como ACEITA ou
-- INCERTA (qualquer caminho, inclusive a recuperação de posse vencida), com o início daquela tentativa.
CREATE FUNCTION kidmais110_marco_contato() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_catalog, pg_temp AS $$
BEGIN
  UPDATE satisfacao_envios SET contato_em = NEW.tentativa_iniciada_em WHERE id = NEW.envio_id AND contato_em IS NULL;
  RETURN NULL;
END $$;
CREATE TRIGGER satisfacao_entregas_marco AFTER UPDATE OF estado ON satisfacao_entregas FOR EACH ROW
  WHEN (NEW.etapa = 'INICIAL' AND OLD.estado = 'ENVIANDO' AND NEW.estado IN ('ACEITA', 'INCERTA'))
  EXECUTE FUNCTION kidmais110_marco_contato();

-- =============================================================================
-- 6. Saída das pesquisas, capacidades por unidade (D-PS8), agregados e expurgos (D-PS7), caixa de saída simulada
-- =============================================================================
CREATE TABLE satisfacao_saidas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  cliente_id uuid NOT NULL REFERENCES clientes (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  origem text NOT NULL,
  criado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT satisfacao_saidas_uk UNIQUE (empresa_id, cliente_id),
  CONSTRAINT satisfacao_saidas_origem CHECK (origem IN ('PAGINA', 'LINK_EMAIL', 'EQUIPE'))
);

CREATE TABLE satisfacao_capacidades (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  estabelecimento_id uuid NOT NULL,
  capacidade text NOT NULL,
  vinculo_id uuid NOT NULL,
  vinculo_atualizado_em timestamptz NOT NULL,
  concedida_por uuid NOT NULL REFERENCES usuarios_administrativos (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  criado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  revogada_em timestamptz,
  revogada_por uuid REFERENCES usuarios_administrativos (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT satisfacao_capacidades_membership_fk FOREIGN KEY (empresa_id, membership_id) REFERENCES memberships (empresa_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT satisfacao_capacidades_vinculo_fk FOREIGN KEY (empresa_id, estabelecimento_id, vinculo_id)
    REFERENCES membership_estabelecimentos (empresa_id, estabelecimento_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT satisfacao_capacidades_capacidade CHECK (capacidade IN ('SATISFACAO_VER', 'SATISFACAO_TRATAR')),
  CONSTRAINT satisfacao_capacidades_revogada CHECK ((revogada_em IS NULL) = (revogada_por IS NULL))
);
CREATE UNIQUE INDEX satisfacao_capacidades_vigente_uk ON satisfacao_capacidades (empresa_id, membership_id, estabelecimento_id, capacidade) WHERE revogada_em IS NULL;

-- D-PS8: a foto do vínculo é tirada do próprio banco na concessão (timestamptz para timestamptz, nunca por Date do JS).
CREATE FUNCTION kidmais110_capacidade_guarda() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_catalog, pg_temp AS $$
DECLARE v record;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION '110: concessão não é apagada; revogue.' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT membership_id, atualizado_em INTO v FROM membership_estabelecimentos
     WHERE id = NEW.vinculo_id AND empresa_id = NEW.empresa_id AND estabelecimento_id = NEW.estabelecimento_id;
    IF NOT FOUND OR v.membership_id IS DISTINCT FROM NEW.membership_id OR v.atualizado_em IS DISTINCT FROM NEW.vinculo_atualizado_em
       OR NEW.revogada_em IS NOT NULL THEN
      RAISE EXCEPTION '110: concessão exige o vínculo da própria membership, com a foto atual.' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.empresa_id IS DISTINCT FROM OLD.empresa_id OR NEW.membership_id IS DISTINCT FROM OLD.membership_id
     OR NEW.estabelecimento_id IS DISTINCT FROM OLD.estabelecimento_id OR NEW.capacidade IS DISTINCT FROM OLD.capacidade
     OR NEW.vinculo_id IS DISTINCT FROM OLD.vinculo_id OR NEW.vinculo_atualizado_em IS DISTINCT FROM OLD.vinculo_atualizado_em
     OR NEW.concedida_por IS DISTINCT FROM OLD.concedida_por OR NEW.criado_em IS DISTINCT FROM OLD.criado_em OR OLD.revogada_em IS NOT NULL THEN
    RAISE EXCEPTION '110: concessão só muda para revogada.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER satisfacao_capacidades_guarda BEFORE INSERT OR UPDATE OR DELETE ON satisfacao_capacidades FOR EACH ROW EXECUTE FUNCTION kidmais110_capacidade_guarda();

-- D-PS7: agregados sem identificador (mês da unidade, trimestre da unidade, trimestre da empresa) e o registro dos lotes.
-- Sem escritor nesta migration: a função restrita do expurgo (SECURITY DEFINER, papel próprio) é da PS-6.
CREATE TABLE satisfacao_agregados_mensais (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  estabelecimento_id uuid,
  periodo text NOT NULL,
  inicio date NOT NULL,
  respostas integer NOT NULL DEFAULT 0,
  notas_indicacao integer[] NOT NULL DEFAULT array_fill(0, ARRAY[11]),
  soma_comida integer NOT NULL DEFAULT 0, qtd_comida integer NOT NULL DEFAULT 0,
  soma_equipe integer NOT NULL DEFAULT 0, qtd_equipe integer NOT NULL DEFAULT 0,
  soma_espaco integer NOT NULL DEFAULT 0, qtd_espaco integer NOT NULL DEFAULT 0,
  descartadas integer NOT NULL DEFAULT 0,
  atualizado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT satisfacao_agregados_unidade_fk FOREIGN KEY (empresa_id, estabelecimento_id) REFERENCES estabelecimentos (empresa_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT satisfacao_agregados_periodo CHECK (periodo IN ('MES', 'TRIMESTRE') AND inicio = date_trunc(CASE periodo WHEN 'MES' THEN 'month' ELSE 'quarter' END, inicio)::date),
  CONSTRAINT satisfacao_agregados_notas CHECK (cardinality(notas_indicacao) = 11 AND array_position(notas_indicacao, NULL) IS NULL),
  CONSTRAINT satisfacao_agregados_nao_negativos CHECK (respostas >= 0 AND descartadas >= 0 AND qtd_comida >= 0 AND qtd_equipe >= 0 AND qtd_espaco >= 0)
);
CREATE UNIQUE INDEX satisfacao_agregados_uk ON satisfacao_agregados_mensais
  (empresa_id, COALESCE(estabelecimento_id, '00000000-0000-0000-0000-000000000000'::uuid), periodo, inicio);

CREATE TABLE satisfacao_expurgos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  estabelecimento_id uuid,
  mes date NOT NULL,
  estado text NOT NULL DEFAULT 'EM_ANDAMENTO',
  expurgadas integer NOT NULL DEFAULT 0,
  criado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  concluido_em timestamptz,
  CONSTRAINT satisfacao_expurgos_unidade_fk FOREIGN KEY (empresa_id, estabelecimento_id) REFERENCES estabelecimentos (empresa_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT satisfacao_expurgos_estado CHECK (estado IN ('EM_ANDAMENTO', 'CONCLUIDO') AND (estado = 'CONCLUIDO') = (concluido_em IS NOT NULL)),
  CONSTRAINT satisfacao_expurgos_mes CHECK (mes = date_trunc('month', mes)::date)
);
CREATE UNIQUE INDEX satisfacao_expurgos_uk ON satisfacao_expurgos (empresa_id, COALESCE(estabelecimento_id, '00000000-0000-0000-0000-000000000000'::uuid), mes);

CREATE TABLE satisfacao_email_simulado (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  entrega_id uuid NOT NULL,
  idempotencia text NOT NULL,
  provedor_mensagem_id text NOT NULL,
  para_mascarado text NOT NULL,
  assunto text NOT NULL,
  texto text NOT NULL,
  aceito_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT satisfacao_email_simulado_entrega_fk FOREIGN KEY (empresa_id, entrega_id) REFERENCES satisfacao_entregas (empresa_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT satisfacao_email_simulado_idempotencia_uk UNIQUE (idempotencia),
  CONSTRAINT satisfacao_email_simulado_provedor_uk UNIQUE (provedor_mensagem_id),
  CONSTRAINT satisfacao_email_simulado_texto CHECK (char_length(texto) <= 4000 AND char_length(assunto) <= 200)
);

COMMENT ON TABLE satisfacao_envios IS
  'Pesquisa de satisfação: uma por festa. Só o SHA-256 do link é gravado (o link é recalculado por HMAC). Vínculos conferidos na criação e imutáveis; ATIVO → RESPONDIDO | EXPIRADO | REVOGADO é terminal.';
COMMENT ON TABLE satisfacao_respostas IS
  'Resposta identificada (D-PS1): uma por envio, só em envio ATIVO e válido; invariável resposta ⇔ envio RESPONDIDO conferida no COMMIT.';
COMMENT ON TABLE satisfacao_entregas IS
  'Estado de cada envio por canal (WHATSAPP/EMAIL) e etapa (INICIAL/LEMBRETE). ENVIANDO sem resposta vira INCERTA e não é reenviada sozinha.';
COMMENT ON TABLE satisfacao_email_simulado IS
  'Caixa de saída do e-mail SIMULADO (PS-1/PS-2 locais). Nenhum e-mail real; o texto guarda o marcador [link da pesquisa], nunca o link.';

COMMIT;
