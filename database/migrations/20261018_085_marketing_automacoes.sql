-- 085 — Marketing (Entrega B): automações por regras pré-definidas (proposta parada, pós-festa, recompra, datas vagas
--       como sugestão), execuções agendadas idempotentes, histórico, preferências de contato e descadastro, tarefas
--       internas e caixa de saída do transporte SIMULADO.
--
-- NÃO APLICADA em banco persistente. Goal "Marketing local" (14/10/2026): só banco descartável local com autorização
-- própria; staging e produção exigem autorização explícita de Felipe (docs/OPERACAO_AGENTES.md). Exige a 084.
--
-- Regras de execução (docs/MARKETING_LOCAL_20261014.md):
--   * uma execução por (empresa, chave de idempotência) — repetir o planejamento não duplica nada;
--   * posse (posse_token/posse_ate) + FOR UPDATE SKIP LOCKED: dois processadores nunca pegam a mesma execução;
--   * ENVIANDO sem resposta vira INCERTA e NUNCA é reenviada sozinha (sem envio duplicado); FALHOU pode ser re-agendada
--     por pessoa (com nova revalidação);
--   * mensagem só para destino com autorização CONFIRMADA (por número normalizado) e cliente sem descadastro; pausa da
--     regra impede envios pendentes (correção R1 de 15/10/2026: antes a autorização era do cliente inteiro); número
--     que sai do cadastro perde a autorização (O1) e a evidência de confirmação é imutável (O2);
--   * transporte real NÃO existe neste goal: só a caixa de saída simulada (marketing_transporte_simulado).
-- Rollback operacional: MARKETING_AUTOMACOES_ENABLED diferente de "true" para o processamento. O down recusa enquanto
-- houver execução, tarefa ou preferência registrada (evidências de envio e consentimento não são apagadas).
-- Postcheck: database/checks/20261018_085_postcheck.sql. Rollback: database/rollback/20261018_085_marketing_automacoes_down.sql.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;

DO $$ BEGIN
  IF to_regclass('public.marketing_campanhas') IS NULL OR to_regclass('public.marketing_atribuicoes') IS NULL THEN
    RAISE EXCEPTION '085 exige a 084.';
  END IF;
  IF to_regclass('public.marketing_automacao_regras') IS NOT NULL OR to_regclass('public.marketing_automacao_execucoes') IS NOT NULL
     OR to_regclass('public.marketing_contato_preferencias') IS NOT NULL OR to_regclass('public.marketing_tarefas') IS NOT NULL
     OR to_regclass('public.marketing_contato_autorizacoes') IS NOT NULL OR to_regprocedure('public.kidmais085_destino(text)') IS NOT NULL
     OR to_regclass('public.marketing_transporte_simulado') IS NOT NULL THEN
    RAISE EXCEPTION '085 já aplicada (total ou parcialmente).';
  END IF;
END $$;

-- =============================================================================
-- 1. Regras (uma por tipo e unidade). Mensagem só ativa com texto revisado e modelo do provedor informado.
-- =============================================================================
CREATE TABLE marketing_automacao_regras (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  estabelecimento_id uuid,
  tipo text NOT NULL,
  status text NOT NULL DEFAULT 'RASCUNHO',
  acao text NOT NULL,
  espera_dias integer NOT NULL,
  janela_inicio time NOT NULL DEFAULT '09:00',
  janela_fim time NOT NULL DEFAULT '18:00',
  fuso text NOT NULL DEFAULT 'America/Sao_Paulo',
  fim_de_semana boolean NOT NULL DEFAULT false,
  limite_frequencia_dias integer NOT NULL DEFAULT 30,
  max_tentativas integer NOT NULL DEFAULT 3,
  template_texto text,
  template_provedor text,
  template_revisado_em timestamptz,
  template_revisado_por uuid REFERENCES usuarios_administrativos (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  versao integer NOT NULL DEFAULT 1,
  ativada_em timestamptz,
  pausada_em timestamptz,
  criado_por uuid NOT NULL REFERENCES usuarios_administrativos (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  atualizado_por uuid NOT NULL REFERENCES usuarios_administrativos (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  criado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  atualizado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT marketing_regras_unidade_fk FOREIGN KEY (empresa_id, estabelecimento_id)
    REFERENCES estabelecimentos (empresa_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT marketing_regras_escopo_uk UNIQUE (empresa_id, id),
  CONSTRAINT marketing_regras_tipo CHECK (tipo IN ('PROPOSTA_PARADA', 'POS_FESTA', 'RECOMPRA', 'DATAS_VAGAS')),
  CONSTRAINT marketing_regras_status CHECK (status IN ('RASCUNHO', 'ATIVA', 'PAUSADA')),
  CONSTRAINT marketing_regras_acao CHECK (acao IN ('TAREFA_INTERNA', 'MENSAGEM_WHATSAPP', 'SUGESTAO')),
  CONSTRAINT marketing_regras_datas_vagas_sugestao CHECK ((tipo = 'DATAS_VAGAS') = (acao = 'SUGESTAO')),
  CONSTRAINT marketing_regras_espera CHECK (espera_dias BETWEEN 0 AND 400),
  CONSTRAINT marketing_regras_janela CHECK (janela_inicio < janela_fim),
  CONSTRAINT marketing_regras_fuso CHECK (fuso ~ '^[A-Za-z]+(/[A-Za-z_]+){1,2}$'),
  CONSTRAINT marketing_regras_frequencia CHECK (limite_frequencia_dias BETWEEN 1 AND 365),
  CONSTRAINT marketing_regras_tentativas CHECK (max_tentativas BETWEEN 1 AND 5),
  CONSTRAINT marketing_regras_template CHECK (template_texto IS NULL OR char_length(template_texto) BETWEEN 1 AND 1000),
  CONSTRAINT marketing_regras_template_provedor CHECK (template_provedor IS NULL OR template_provedor ~ '^[a-z0-9_]{3,64}$'),
  CONSTRAINT marketing_regras_mensagem_revisada CHECK (status <> 'ATIVA' OR acao <> 'MENSAGEM_WHATSAPP'
    OR (template_texto IS NOT NULL AND template_provedor IS NOT NULL AND template_revisado_em IS NOT NULL)),
  CONSTRAINT marketing_regras_versao CHECK (versao >= 1)
);
CREATE UNIQUE INDEX marketing_regras_tipo_uk ON marketing_automacao_regras (empresa_id, tipo, COALESCE(estabelecimento_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- =============================================================================
-- 2. Execuções (agendamento persistente) + eventos (histórico append-only).
-- =============================================================================
CREATE TABLE marketing_automacao_execucoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL,
  regra_id uuid NOT NULL,
  regra_versao integer NOT NULL,
  acao text NOT NULL,
  alvo_tipo text NOT NULL,
  alvo_id uuid NOT NULL,
  cliente_id uuid NOT NULL REFERENCES clientes (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  fechamento_id uuid REFERENCES fechamentos (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  chave_idempotencia text NOT NULL,
  agendada_para timestamptz NOT NULL,
  estado text NOT NULL DEFAULT 'AGENDADA',
  tentativas integer NOT NULL DEFAULT 0,
  max_tentativas integer NOT NULL,
  proxima_tentativa_em timestamptz,
  posse_token uuid,
  posse_ate timestamptz,
  motivo text,
  provedor_mensagem_id text,
  destinatario_mascarado text,
  conteudo text,
  criado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  atualizado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  concluida_em timestamptz,
  CONSTRAINT marketing_exec_regra_fk FOREIGN KEY (empresa_id, regra_id) REFERENCES marketing_automacao_regras (empresa_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT marketing_exec_escopo_uk UNIQUE (empresa_id, id),
  CONSTRAINT marketing_exec_chave_uk UNIQUE (empresa_id, chave_idempotencia),
  CONSTRAINT marketing_exec_chave CHECK (char_length(chave_idempotencia) BETWEEN 8 AND 200),
  CONSTRAINT marketing_exec_acao CHECK (acao IN ('TAREFA_INTERNA', 'MENSAGEM_WHATSAPP')),
  CONSTRAINT marketing_exec_alvo CHECK (alvo_tipo IN ('FECHAMENTO', 'CLIENTE')),
  CONSTRAINT marketing_exec_estado CHECK (estado IN ('AGENDADA', 'PROCESSANDO', 'ENVIANDO', 'TAREFA_CRIADA', 'ACEITA', 'ENTREGUE', 'FALHOU', 'INCERTA', 'SUPRIMIDA', 'CANCELADA')),
  CONSTRAINT marketing_exec_tentativas CHECK (tentativas BETWEEN 0 AND max_tentativas AND max_tentativas BETWEEN 1 AND 5),
  CONSTRAINT marketing_exec_posse CHECK ((estado IN ('PROCESSANDO', 'ENVIANDO')) = (posse_token IS NOT NULL AND posse_ate IS NOT NULL)),
  CONSTRAINT marketing_exec_provedor CHECK (estado NOT IN ('ACEITA', 'ENTREGUE') OR provedor_mensagem_id IS NOT NULL),
  CONSTRAINT marketing_exec_final CHECK ((estado IN ('TAREFA_CRIADA', 'ENTREGUE', 'SUPRIMIDA', 'CANCELADA')) = (concluida_em IS NOT NULL) OR estado IN ('ACEITA', 'FALHOU', 'INCERTA')),
  CONSTRAINT marketing_exec_motivo CHECK (motivo IS NULL OR char_length(motivo) <= 300),
  CONSTRAINT marketing_exec_conteudo CHECK (conteudo IS NULL OR char_length(conteudo) <= 1200)
);
CREATE INDEX marketing_exec_fila_idx ON marketing_automacao_execucoes (agendada_para) WHERE estado = 'AGENDADA';
CREATE INDEX marketing_exec_posse_idx ON marketing_automacao_execucoes (posse_ate) WHERE estado IN ('PROCESSANDO', 'ENVIANDO');
CREATE INDEX marketing_exec_cliente_idx ON marketing_automacao_execucoes (empresa_id, cliente_id, criado_em DESC);
CREATE INDEX marketing_exec_regra_idx ON marketing_automacao_execucoes (empresa_id, regra_id, estado);
CREATE UNIQUE INDEX marketing_exec_provedor_uk ON marketing_automacao_execucoes (provedor_mensagem_id) WHERE provedor_mensagem_id IS NOT NULL;

-- Integridade: cliente e negociação da mesma empresa da execução.
CREATE FUNCTION kidmais085_execucao_tenant() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_catalog, pg_temp AS $$
DECLARE dono uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION '085: execução de automação não é apagada; cancele.'; END IF;
  IF TG_OP = 'UPDATE' AND (NEW.empresa_id IS DISTINCT FROM OLD.empresa_id OR NEW.regra_id IS DISTINCT FROM OLD.regra_id
     OR NEW.cliente_id IS DISTINCT FROM OLD.cliente_id OR NEW.chave_idempotencia IS DISTINCT FROM OLD.chave_idempotencia
     OR NEW.alvo_id IS DISTINCT FROM OLD.alvo_id OR NEW.acao IS DISTINCT FROM OLD.acao) THEN
    RAISE EXCEPTION '085: identidade da execução é imutável.';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.estado IN ('TAREFA_CRIADA', 'ENTREGUE', 'SUPRIMIDA', 'CANCELADA') THEN
    RAISE EXCEPTION '085: execução concluída não muda (%).', OLD.estado;
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT empresa_id INTO dono FROM clientes WHERE id = NEW.cliente_id;
    IF dono IS DISTINCT FROM NEW.empresa_id THEN RAISE EXCEPTION '085: cliente da execução é de outra empresa.'; END IF;
    IF NEW.fechamento_id IS NOT NULL THEN
      SELECT empresa_id INTO dono FROM fechamentos WHERE id = NEW.fechamento_id;
      IF dono IS DISTINCT FROM NEW.empresa_id THEN RAISE EXCEPTION '085: negociação da execução é de outra empresa.'; END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER marketing_exec_tenant BEFORE INSERT OR UPDATE OR DELETE ON marketing_automacao_execucoes
  FOR EACH ROW EXECUTE FUNCTION kidmais085_execucao_tenant();

CREATE TABLE marketing_automacao_eventos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL,
  execucao_id uuid NOT NULL,
  estado_anterior text,
  estado_novo text NOT NULL,
  detalhe jsonb NOT NULL DEFAULT '{}'::jsonb,
  criado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT marketing_eventos_exec_fk FOREIGN KEY (empresa_id, execucao_id) REFERENCES marketing_automacao_execucoes (empresa_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT marketing_eventos_exec_detalhe CHECK (jsonb_typeof(detalhe) = 'object' AND octet_length(detalhe::text) <= 4000)
);
CREATE INDEX marketing_eventos_exec_idx ON marketing_automacao_eventos (execucao_id, criado_em);
CREATE TRIGGER marketing_automacao_eventos_imutavel BEFORE UPDATE OR DELETE ON marketing_automacao_eventos
  FOR EACH ROW EXECUTE FUNCTION kidmais084_somente_insercao();

-- =============================================================================
-- 3. Descadastro (por cliente) e autorizações de mensagem POR DESTINO (correção R1, 15/10/2026).
--    Autorização vale só para o número normalizado que foi autorizado, com origem e evidência. Mudança de número não
--    herda autorização; reaproveitar cadastro (por e-mail, por exemplo) não prova o destino: fica PENDENTE até a equipe
--    confirmar. Descadastro é do cliente inteiro, prevalece sobre qualquer autorização e revoga as existentes.
-- =============================================================================
CREATE TABLE marketing_contato_preferencias (
  empresa_id uuid NOT NULL REFERENCES empresas (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  cliente_id uuid NOT NULL REFERENCES clientes (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  descadastrado_em timestamptz,
  descadastro_origem text,
  observacao text,
  atualizado_por uuid REFERENCES usuarios_administrativos (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  atualizado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (empresa_id, cliente_id),
  CONSTRAINT marketing_pref_descadastro CHECK ((descadastrado_em IS NULL) = (descadastro_origem IS NULL)),
  CONSTRAINT marketing_pref_observacao CHECK (observacao IS NULL OR char_length(observacao) <= 300),
  CONSTRAINT marketing_pref_origens CHECK (descadastro_origem IS NULL OR descadastro_origem IN ('EQUIPE', 'RESPOSTA_PARAR', 'SIMULACAO'))
);

CREATE TABLE marketing_contato_preferencias_eventos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL,
  cliente_id uuid NOT NULL,
  descadastrado boolean NOT NULL,
  origem text NOT NULL,
  observacao text,
  registrado_por uuid,
  registrado_em timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX marketing_pref_eventos_idx ON marketing_contato_preferencias_eventos (empresa_id, cliente_id, registrado_em);
CREATE TRIGGER marketing_pref_eventos_imutavel BEFORE UPDATE OR DELETE ON marketing_contato_preferencias_eventos
  FOR EACH ROW EXECUTE FUNCTION kidmais084_somente_insercao();

CREATE FUNCTION kidmais085_preferencia_tenant() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_catalog, pg_temp AS $$
DECLARE dono uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION '085: preferência de contato não é apagada.'; END IF;
  SELECT empresa_id INTO dono FROM clientes WHERE id = NEW.cliente_id;
  IF dono IS DISTINCT FROM NEW.empresa_id THEN RAISE EXCEPTION '085: cliente da preferência é de outra empresa.'; END IF;
  INSERT INTO marketing_contato_preferencias_eventos (empresa_id, cliente_id, descadastrado, origem, observacao, registrado_por)
  VALUES (NEW.empresa_id, NEW.cliente_id, NEW.descadastrado_em IS NOT NULL, COALESCE(NEW.descadastro_origem, 'EQUIPE'), NEW.observacao, NEW.atualizado_por);
  RETURN NEW;
END $$;
CREATE TRIGGER marketing_pref_tenant BEFORE INSERT OR UPDATE OR DELETE ON marketing_contato_preferencias
  FOR EACH ROW EXECUTE FUNCTION kidmais085_preferencia_tenant();

CREATE TABLE marketing_contato_autorizacoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  cliente_id uuid NOT NULL REFERENCES clientes (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  canal text NOT NULL DEFAULT 'WHATSAPP',
  destino text NOT NULL,
  estado text NOT NULL,
  origem text NOT NULL,
  contato_id uuid,
  evidencia text NOT NULL,
  confirmada_em timestamptz,
  confirmada_por uuid REFERENCES usuarios_administrativos (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  confirmacao text,
  revogada_em timestamptz,
  revogada_por uuid REFERENCES usuarios_administrativos (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  motivo_revogacao text,
  criado_por uuid REFERENCES usuarios_administrativos (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  criado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  atualizado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT marketing_aut_contato_fk FOREIGN KEY (empresa_id, contato_id) REFERENCES marketing_contatos (empresa_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT marketing_aut_canal CHECK (canal IN ('WHATSAPP')),
  -- Destino normalizado: só dígitos, com DDI (números brasileiros de 10/11 dígitos ganham o 55 antes de gravar).
  CONSTRAINT marketing_aut_destino CHECK (destino ~ '^[0-9]{12,15}$'),
  CONSTRAINT marketing_aut_estado CHECK (estado IN ('PENDENTE', 'CONFIRMADA', 'REVOGADA')),
  CONSTRAINT marketing_aut_origem CHECK (origem IN ('FORMULARIO_SITE', 'EQUIPE')),
  CONSTRAINT marketing_aut_formulario_tem_contato CHECK (origem <> 'FORMULARIO_SITE' OR contato_id IS NOT NULL),
  CONSTRAINT marketing_aut_evidencia CHECK (char_length(btrim(evidencia)) BETWEEN 3 AND 300),
  -- Evidência de confirmação (data + registro de como foi confirmada; quem, quando foi a equipe) é tudo ou nada:
  -- PENDENTE não tem nenhuma; CONFIRMADA tem data e registro; REVOGADA mantém exatamente o que tinha antes (vinda de
  -- CONFIRMADA continua com data e registro; vinda de PENDENTE fica sem nenhum). O gatilho congela esses campos (O2).
  CONSTRAINT marketing_aut_confirmada CHECK (
    (confirmada_em IS NULL) = (confirmacao IS NULL) AND (confirmada_em IS NOT NULL OR confirmada_por IS NULL)
    AND (estado <> 'PENDENTE' OR confirmada_em IS NULL) AND (estado <> 'CONFIRMADA' OR confirmada_em IS NOT NULL)),
  CONSTRAINT marketing_aut_confirmacao CHECK (confirmacao IS NULL OR char_length(confirmacao) <= 300),
  CONSTRAINT marketing_aut_revogada CHECK ((estado = 'REVOGADA') = (revogada_em IS NOT NULL AND motivo_revogacao IS NOT NULL)
    AND (estado = 'REVOGADA' OR revogada_por IS NULL)),
  CONSTRAINT marketing_aut_motivo CHECK (motivo_revogacao IS NULL OR char_length(motivo_revogacao) BETWEEN 3 AND 300)
);
-- Uma autorização viva (pendente ou confirmada) por cliente, canal e destino; revogadas ficam como histórico.
CREATE UNIQUE INDEX marketing_aut_viva_uk ON marketing_contato_autorizacoes (empresa_id, cliente_id, canal, destino) WHERE estado <> 'REVOGADA';
CREATE INDEX marketing_aut_cliente_idx ON marketing_contato_autorizacoes (empresa_id, cliente_id, estado);

CREATE FUNCTION kidmais085_autorizacao_controle() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_catalog, pg_temp AS $$
DECLARE dono uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION '085: autorização de contato não é apagada; revogue.'; END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT empresa_id INTO dono FROM clientes WHERE id = NEW.cliente_id;
    IF dono IS DISTINCT FROM NEW.empresa_id THEN RAISE EXCEPTION '085: cliente da autorização é de outra empresa.'; END IF;
    IF NEW.estado = 'REVOGADA' THEN RAISE EXCEPTION '085: autorização não nasce revogada.'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.empresa_id IS DISTINCT FROM OLD.empresa_id OR NEW.cliente_id IS DISTINCT FROM OLD.cliente_id OR NEW.canal IS DISTINCT FROM OLD.canal
     OR NEW.destino IS DISTINCT FROM OLD.destino OR NEW.origem IS DISTINCT FROM OLD.origem OR NEW.contato_id IS DISTINCT FROM OLD.contato_id
     OR NEW.evidencia IS DISTINCT FROM OLD.evidencia OR NEW.criado_em IS DISTINCT FROM OLD.criado_em OR NEW.criado_por IS DISTINCT FROM OLD.criado_por THEN
    RAISE EXCEPTION '085: destino, origem e evidência da autorização são imutáveis.';
  END IF;
  -- Transições: PENDENTE → CONFIRMADA | REVOGADA; CONFIRMADA → REVOGADA. Revogada é final.
  IF NOT ((OLD.estado = 'PENDENTE' AND NEW.estado IN ('CONFIRMADA', 'REVOGADA')) OR (OLD.estado = 'CONFIRMADA' AND NEW.estado = 'REVOGADA')) THEN
    RAISE EXCEPTION '085: transição de autorização inválida (% → %).', OLD.estado, NEW.estado;
  END IF;
  -- Evidências de confirmação (O2, 15/10/2026): só são gravadas na passagem PENDENTE → CONFIRMADA; em qualquer outra
  -- transição (inclusive a revogação) ficam exatamente como estavam — a própria linha é o histórico.
  IF NOT (OLD.estado = 'PENDENTE' AND NEW.estado = 'CONFIRMADA')
     AND (NEW.confirmada_em IS DISTINCT FROM OLD.confirmada_em OR NEW.confirmada_por IS DISTINCT FROM OLD.confirmada_por
          OR NEW.confirmacao IS DISTINCT FROM OLD.confirmacao) THEN
    RAISE EXCEPTION '085: evidências de confirmação da autorização são imutáveis.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER marketing_aut_controle BEFORE INSERT OR UPDATE OR DELETE ON marketing_contato_autorizacoes
  FOR EACH ROW EXECUTE FUNCTION kidmais085_autorizacao_controle();

-- Destino canônico em SQL: mesma regra de normalizarDestino (lib/marketing/automacoes/preferencias.ts) — só dígitos;
-- 10/11 dígitos ganham o DDI 55; 12–15 dígitos ficam como estão; o resto não é destino.
CREATE FUNCTION kidmais085_destino(valor text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE
  SET search_path = public, pg_catalog, pg_temp AS $$
  SELECT CASE WHEN d ~ '^[0-9]{10,11}$' THEN '55' || d WHEN d ~ '^[0-9]{12,15}$' THEN d END
    FROM (SELECT regexp_replace(COALESCE(valor, ''), '[^0-9]', '', 'g') AS d) x
$$;

-- O1 (15/10/2026, decisão de Felipe): número que SAI do cadastro do cliente (WhatsApp e telefone) perde as autorizações
-- vivas (pendente ou confirmada) desse número, na mesma transação da alteração — vale para edição na tela, importação,
-- mescla ou SQL direto. Se o número voltar ao cadastro, precisa de nova autorização (equipe ou formulário); a revogada
-- fica como histórico. Troca só de formatação (mesmo destino normalizado) não revoga nada.
CREATE FUNCTION kidmais085_numero_saiu_do_cadastro() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_catalog, pg_temp AS $$
BEGIN
  UPDATE marketing_contato_autorizacoes a
     SET estado = 'REVOGADA', revogada_em = clock_timestamp(), atualizado_em = clock_timestamp(),
         motivo_revogacao = 'NUMERO_SAIU_DO_CADASTRO: o número deixou o cadastro do cliente; nova autorização é necessária.'
   WHERE a.empresa_id = OLD.empresa_id AND a.cliente_id = OLD.id AND a.canal = 'WHATSAPP' AND a.estado <> 'REVOGADA'
     AND a.destino IN (kidmais085_destino(OLD.whatsapp), kidmais085_destino(OLD.telefone))
     AND a.destino IS DISTINCT FROM kidmais085_destino(NEW.whatsapp) AND a.destino IS DISTINCT FROM kidmais085_destino(NEW.telefone);
  RETURN NULL;
END $$;
CREATE TRIGGER marketing_aut_numero_saiu AFTER UPDATE OF whatsapp, telefone ON clientes
  FOR EACH ROW WHEN (OLD.whatsapp IS DISTINCT FROM NEW.whatsapp OR OLD.telefone IS DISTINCT FROM NEW.telefone)
  EXECUTE FUNCTION kidmais085_numero_saiu_do_cadastro();

-- =============================================================================
-- 4. Tarefas internas (sem provedor externo) e caixa de saída do transporte simulado.
-- =============================================================================
CREATE TABLE marketing_tarefas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL,
  execucao_id uuid NOT NULL,
  cliente_id uuid NOT NULL REFERENCES clientes (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  fechamento_id uuid REFERENCES fechamentos (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  titulo text NOT NULL,
  descricao text,
  vencimento date NOT NULL,
  status text NOT NULL DEFAULT 'ABERTA',
  concluida_em timestamptz,
  concluida_por uuid REFERENCES usuarios_administrativos (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  criado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT marketing_tarefas_exec_fk FOREIGN KEY (empresa_id, execucao_id) REFERENCES marketing_automacao_execucoes (empresa_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT marketing_tarefas_exec_uk UNIQUE (execucao_id),
  CONSTRAINT marketing_tarefas_titulo CHECK (char_length(btrim(titulo)) BETWEEN 3 AND 160),
  CONSTRAINT marketing_tarefas_descricao CHECK (descricao IS NULL OR char_length(descricao) <= 1000),
  CONSTRAINT marketing_tarefas_status CHECK (status IN ('ABERTA', 'CONCLUIDA', 'CANCELADA')),
  CONSTRAINT marketing_tarefas_conclusao CHECK ((status = 'ABERTA') = (concluida_em IS NULL))
);
CREATE INDEX marketing_tarefas_abertas_idx ON marketing_tarefas (empresa_id, vencimento) WHERE status = 'ABERTA';

CREATE TABLE marketing_transporte_simulado (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  execucao_id uuid NOT NULL,
  idempotencia text NOT NULL,
  provedor_mensagem_id text NOT NULL,
  destinatario_mascarado text NOT NULL,
  template_provedor text NOT NULL,
  texto text NOT NULL,
  status text NOT NULL DEFAULT 'ACEITA',
  aceito_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  atualizado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT marketing_simulado_idempotencia_uk UNIQUE (idempotencia),
  CONSTRAINT marketing_simulado_provedor_uk UNIQUE (provedor_mensagem_id),
  CONSTRAINT marketing_simulado_status CHECK (status IN ('ACEITA', 'ENTREGUE', 'FALHOU')),
  CONSTRAINT marketing_simulado_texto CHECK (char_length(texto) <= 1200)
);

COMMENT ON TABLE marketing_automacao_execucoes IS
  'Agendamento persistente das automações. Idempotente por (empresa, chave). ENVIANDO sem resposta vira INCERTA e não é reenviada sozinha.';
COMMENT ON TABLE marketing_transporte_simulado IS
  'Caixa de saída do transporte SIMULADO (goal local). Nenhuma mensagem real é enviada; não há transporte real nesta migration.';
COMMENT ON TABLE marketing_contato_preferencias IS
  'Descadastro por cliente (prevalece sobre qualquer autorização). Revalidado no envio.';
COMMENT ON TABLE marketing_contato_autorizacoes IS
  'Autorização de mensagem por destino normalizado, com origem e evidência. Só CONFIRMADA de número que ainda está no cadastro permite envio; pendente exige confirmação da equipe; número que sai do cadastro é revogado (gatilho marketing_aut_numero_saiu em clientes).';

COMMIT;
