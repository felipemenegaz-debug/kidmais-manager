-- 058 — Kidmais Intelligence (SKILLS): armazenamento das camadas de skill da EMPRESA e do ESTABELECIMENTO.
--
-- NÃO APLICADA. Exige autorização explícita (docs/OPERACAO_AGENTES.md) para qualquer banco, inclusive staging
-- e clones. Sem esta migration a IA segue só com as skills da PLATAFORMA (código revisado); a camada de
-- empresa/unidade também depende de AI_SKILLS_EMPRESA_ENABLED=true.
--
--   ia_skills  uma linha por VERSÃO de skill de empresa (nivel EMPRESA) ou de unidade (nivel ESTABELECIMENTO),
--              sempre override de uma skill da plataforma de mesmo id (conferido pela aplicação). `definicao` é a
--              skill completa (schema do Skills V1: proveniência, revisão, hash, permissões, restrições, conteúdo),
--              validada e varrida pela aplicação ao ler; aqui só o que o banco consegue garantir:
--   * escopo coerente: EMPRESA ⇔ estabelecimento_id NULL; unidade da MESMA empresa (FK composta);
--   * a definição tem TODOS os campos do contrato, com os tipos certos, finalidades/classes não vazias e dentro dos
--     valores permitidos (cada CHECK devolve false explícito, nunca NULL — auditoria A4);
--   * a definição bate com as colunas (id, versão, hash, nível, empresa e unidade);
--   * versão imutável: só o status muda (nova versão = nova linha); sem DELETE nem TRUNCATE;
--   * no máximo UMA versão ATIVA por (empresa, unidade, skill);
--   * status: RASCUNHO → ATIVA ↔ SUSPENSA → ARQUIVADA (ARQUIVADA é final).
-- Sem escrita pela IA: nenhuma ferramenta, rota ou agente grava aqui (o cadastro/aprovação é fluxo futuro do Admin).
BEGIN;

DO $$ BEGIN
  IF to_regclass('public.empresas') IS NULL OR to_regclass('public.estabelecimentos') IS NULL
     OR to_regclass('public.usuarios_administrativos') IS NULL THEN
    RAISE EXCEPTION '058 exige empresas, estabelecimentos e usuarios_administrativos.';
  END IF;
  IF to_regclass('public.ia_skills') IS NOT NULL THEN
    RAISE EXCEPTION '058 já aplicada.';
  END IF;
END $$;

CREATE TABLE ia_skills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  estabelecimento_id uuid,
  nivel varchar(16) NOT NULL CHECK (nivel IN ('EMPRESA', 'ESTABELECIMENTO')),
  skill_id varchar(50) NOT NULL CHECK (skill_id ~ '^[a-z][a-z0-9_]{2,48}$'),
  versao varchar(20) NOT NULL CHECK (versao ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  hash char(64) NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$'),
  status varchar(16) NOT NULL CHECK (status IN ('RASCUNHO', 'ATIVA', 'SUSPENSA', 'ARQUIVADA')),
  definicao jsonb NOT NULL CHECK (jsonb_typeof(definicao) = 'object'),
  criado_por uuid NOT NULL REFERENCES usuarios_administrativos(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  criado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  atualizado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT ia_skills_058_escopo_check CHECK ((nivel = 'ESTABELECIMENTO') = (estabelecimento_id IS NOT NULL)),
  CONSTRAINT ia_skills_058_estabelecimento_fk FOREIGN KEY (empresa_id, estabelecimento_id)
    REFERENCES estabelecimentos (empresa_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  -- Contrato da definição (A4): cada CHECK devolve false explícito (nunca NULL) quando falta campo ou o tipo é outro.
  CONSTRAINT ia_skills_058_definicao_chaves_check CHECK (
    definicao ?& ARRAY['id', 'nivel', 'escopo', 'finalidades', 'capacidades', 'versao', 'proveniencia', 'revisao',
                      'permissoes', 'restricoes', 'conteudo', 'hash']
  ),
  CONSTRAINT ia_skills_058_definicao_tipos_check CHECK (COALESCE(
    jsonb_typeof(definicao->'id') = 'string' AND jsonb_typeof(definicao->'nivel') = 'string'
    AND jsonb_typeof(definicao->'versao') = 'string' AND jsonb_typeof(definicao->'hash') = 'string'
    AND jsonb_typeof(definicao->'escopo') = 'object' AND jsonb_typeof(definicao->'proveniencia') = 'object'
    AND jsonb_typeof(definicao->'revisao') = 'object' AND jsonb_typeof(definicao->'permissoes') = 'object'
    AND jsonb_typeof(definicao->'conteudo') = 'object' AND jsonb_typeof(definicao->'finalidades') = 'array'
    AND jsonb_typeof(definicao->'capacidades') = 'array' AND jsonb_typeof(definicao->'restricoes') = 'array'
    AND jsonb_typeof(definicao->'permissoes'->'classes') = 'array',
  false)),
  CONSTRAINT ia_skills_058_definicao_valores_check CHECK (COALESCE(
    (CASE WHEN jsonb_typeof(definicao->'finalidades') = 'array' THEN jsonb_array_length(definicao->'finalidades') > 0 ELSE false END)
    AND (definicao->'finalidades') <@ '["TOM", "ATENDIMENTO", "SUGESTAO_TEXTO", "PROCEDIMENTO", "OBJECAO", "FORMATACAO"]'::jsonb
    AND (CASE WHEN jsonb_typeof(definicao->'permissoes'->'classes') = 'array' THEN jsonb_array_length(definicao->'permissoes'->'classes') > 0 ELSE false END)
    AND (definicao->'permissoes'->'classes') <@ '["READ", "SUGGEST"]'::jsonb
    AND (definicao->'escopo') ?& ARRAY['empresaId', 'estabelecimentoId']
    AND (definicao->'proveniencia') ?& ARRAY['origem', 'autor', 'referencia']
    AND (definicao->'proveniencia'->>'origem') IN ('INTERNA', 'EMPRESA', 'TERCEIRO')
    AND (definicao->'revisao') ?& ARRAY['estado', 'revisor', 'revisadoEm', 'hashRevisado']
    AND (definicao->'revisao'->>'estado') IN ('APROVADA', 'RESTRITA', 'PENDENTE', 'REJEITADA'),
  false)),
  -- Estrutura interna de `conteudo` = conteudoSchema do runtime (lib/inteligencia/skills/contrato.ts, estrito):
  -- tom (texto não vazio | null); instrucoes [texto]; procedimentos [{titulo, passos: [texto] não vazio}];
  -- objecoes [{objecao, resposta}]; templates [{id ^[a-z][a-z0-9_]{1,48}$, titulo, texto, marcadores ⊂ lista fechada}];
  -- formatacao {maxParagrafos: inteiro 1..10 | null, usarListas: booleano | null}. Sem chaves extras. Nunca NULL (A4).
  CONSTRAINT ia_skills_058_conteudo_check CHECK (COALESCE(
    jsonb_typeof(definicao->'conteudo') = 'object'
    AND (definicao->'conteudo') ?& ARRAY['tom', 'instrucoes', 'procedimentos', 'objecoes', 'templates', 'formatacao']
    AND ((definicao->'conteudo') - ARRAY['tom', 'instrucoes', 'procedimentos', 'objecoes', 'templates', 'formatacao']) = '{}'::jsonb
    AND (jsonb_typeof(definicao->'conteudo'->'tom') = 'null'
         OR (jsonb_typeof(definicao->'conteudo'->'tom') = 'string' AND btrim(definicao->'conteudo'->>'tom') <> ''))
    AND jsonb_typeof(definicao->'conteudo'->'instrucoes') = 'array'
    AND jsonb_typeof(definicao->'conteudo'->'procedimentos') = 'array'
    AND jsonb_typeof(definicao->'conteudo'->'objecoes') = 'array'
    AND jsonb_typeof(definicao->'conteudo'->'templates') = 'array'
    AND jsonb_typeof(definicao->'conteudo'->'formatacao') = 'object'
    AND (definicao->'conteudo'->'formatacao') ?& ARRAY['maxParagrafos', 'usarListas']
    AND ((definicao->'conteudo'->'formatacao') - ARRAY['maxParagrafos', 'usarListas']) = '{}'::jsonb
    AND jsonb_typeof(definicao->'conteudo'->'formatacao'->'maxParagrafos') IN ('number', 'null')
    AND jsonb_typeof(definicao->'conteudo'->'formatacao'->'usarListas') IN ('boolean', 'null')
    AND NOT jsonb_path_exists(definicao, '$.conteudo.formatacao.maxParagrafos ? (@.type() == "number" && (@ < 1 || @ > 10 || @.floor() != @))')
    AND NOT jsonb_path_exists(definicao, '$.conteudo.instrucoes[*] ? (@.type() != "string" || !(@ like_regex "[^[:space:]]"))')
    AND NOT jsonb_path_exists(definicao, '$.conteudo.procedimentos[*] ? (@.type() != "object"
          || !exists(@.titulo ? (@.type() == "string" && @ like_regex "[^[:space:]]"))
          || !(@.passos.type() == "array") || !(@.passos.size() > 0)
          || exists(@.passos[*] ? (@.type() != "string" || !(@ like_regex "[^[:space:]]")))
          || exists(@.keyvalue() ? (@.key != "titulo" && @.key != "passos")))')
    AND NOT jsonb_path_exists(definicao, '$.conteudo.objecoes[*] ? (@.type() != "object"
          || !exists(@.objecao ? (@.type() == "string" && @ like_regex "[^[:space:]]"))
          || !exists(@.resposta ? (@.type() == "string" && @ like_regex "[^[:space:]]"))
          || exists(@.keyvalue() ? (@.key != "objecao" && @.key != "resposta")))')
    AND NOT jsonb_path_exists(definicao, '$.conteudo.templates[*] ? (@.type() != "object"
          || !exists(@.id ? (@.type() == "string" && @ like_regex "^[a-z][a-z0-9_]{1,48}$"))
          || !exists(@.titulo ? (@.type() == "string" && @ like_regex "[^[:space:]]"))
          || !exists(@.texto ? (@.type() == "string" && @ like_regex "[^[:space:]]"))
          || !(@.marcadores.type() == "array")
          || exists(@.marcadores[*] ? (!(@ == "nome_cliente" || @ == "nome_aniversariante" || @ == "data_festa" || @ == "horario_festa"
               || @ == "nome_pacote" || @ == "convidados" || @ == "nome_empresa" || @ == "valor_em_aberto" || @ == "data_vencimento"
               || @ == "situacao_contrato")))
          || exists(@.keyvalue() ? (@.key != "id" && @.key != "titulo" && @.key != "texto" && @.key != "marcadores")))'),
  false)),
  -- A definição bate com as colunas (id, versão, hash, nível, empresa e unidade).
  CONSTRAINT ia_skills_058_definicao_check CHECK (COALESCE(
    definicao->>'id' = skill_id
    AND definicao->>'versao' = versao
    AND definicao->>'hash' = hash
    AND definicao->>'nivel' = nivel
    AND definicao->'escopo'->>'empresaId' = empresa_id::text
    AND (definicao->'escopo'->>'estabelecimentoId') IS NOT DISTINCT FROM estabelecimento_id::text,
  false)),
  CONSTRAINT ia_skills_058_datas_check CHECK (atualizado_em >= criado_em),
  CONSTRAINT ia_skills_058_versao_uk UNIQUE NULLS NOT DISTINCT (empresa_id, estabelecimento_id, skill_id, versao)
);
CREATE UNIQUE INDEX ia_skills_058_uma_ativa_uk ON ia_skills (empresa_id, estabelecimento_id, skill_id) NULLS NOT DISTINCT
  WHERE status = 'ATIVA';
CREATE INDEX ia_skills_058_empresa_status_idx ON ia_skills (empresa_id, status);

CREATE FUNCTION kidmais_058_skill_guarda() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '058: exclusão de skill recusada (arquive a versão).' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.empresa_id IS DISTINCT FROM OLD.empresa_id
     OR NEW.estabelecimento_id IS DISTINCT FROM OLD.estabelecimento_id OR NEW.nivel IS DISTINCT FROM OLD.nivel
     OR NEW.skill_id IS DISTINCT FROM OLD.skill_id OR NEW.versao IS DISTINCT FROM OLD.versao
     OR NEW.hash IS DISTINCT FROM OLD.hash OR NEW.definicao IS DISTINCT FROM OLD.definicao
     OR NEW.criado_por IS DISTINCT FROM OLD.criado_por OR NEW.criado_em IS DISTINCT FROM OLD.criado_em THEN
    RAISE EXCEPTION '058: versão de skill é imutável; crie uma nova versão.' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'RASCUNHO' AND NEW.status IN ('ATIVA', 'ARQUIVADA'))
    OR (OLD.status = 'ATIVA' AND NEW.status IN ('SUSPENSA', 'ARQUIVADA'))
    OR (OLD.status = 'SUSPENSA' AND NEW.status IN ('ATIVA', 'ARQUIVADA'))
  ) THEN
    RAISE EXCEPTION '058: transição de status % → % recusada.', OLD.status, NEW.status USING ERRCODE = 'P0001';
  END IF;
  NEW.atualizado_em := clock_timestamp();
  RETURN NEW;
END $$;

CREATE FUNCTION kidmais_058_bloquear_truncate() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION '058: TRUNCATE de ia_skills recusado.' USING ERRCODE = 'P0001';
END $$;

CREATE TRIGGER ia_skills_058_guarda_trg BEFORE UPDATE OR DELETE ON ia_skills
  FOR EACH ROW EXECUTE FUNCTION kidmais_058_skill_guarda();
CREATE TRIGGER ia_skills_058_truncate_trg BEFORE TRUNCATE ON ia_skills
  FOR EACH STATEMENT EXECUTE FUNCTION kidmais_058_bloquear_truncate();

COMMIT;
