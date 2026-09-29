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

-- Validação da definição = skillSchema/conteudoSchema do runtime (lib/inteligencia/skills/contrato.ts), limite a limite.
-- Funções puras (IMMUTABLE), sem SECURITY DEFINER, search_path fixo e chamadas qualificadas.

-- String.prototype.trim() do JavaScript: remove WhiteSpace + LineTerminator do ECMAScript (tab, VT, FF, espaço, NBSP,
-- BOM, separadores Zs, LF, CR, U+2028, U+2029). btrim() padrão só tira espaço e não equivale. Montado com chr().
CREATE FUNCTION kidmais_058_trim_js(t text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $$
  SELECT regexp_replace(regexp_replace(t, '^[' || w.c || ']+', ''), '[' || w.c || ']+$', '')
    FROM (SELECT chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || chr(32) || chr(160) || chr(5760)
                 || chr(8192) || '-' || chr(8202) || chr(8232) || chr(8233) || chr(8239) || chr(8287) || chr(12288) || chr(65279) AS c) w
$$;

-- TEXTO(max) do runtime: z.string().trim().min(1).max(max) — comprimento do texto APARADO em code points (o zod 4 conta
-- code points, não unidades UTF-16: 400 emojis passam, 401 não — conferido no teste de paridade).
CREATE FUNCTION kidmais_058_texto_ok(v jsonb, maximo int) RETURNS boolean
  LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF v IS NULL OR jsonb_typeof(v) IS DISTINCT FROM 'string' THEN RETURN false; END IF;
  RETURN char_length(public.kidmais_058_trim_js(v #>> '{}')) BETWEEN 1 AND maximo;
END $$;

-- Lista com no máximo `maximo` itens, todos TEXTO(limite).
CREATE FUNCTION kidmais_058_lista_textos_ok(v jsonb, maximo int, limite int) RETURNS boolean
  LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  item jsonb;
BEGIN
  IF v IS NULL OR jsonb_typeof(v) IS DISTINCT FROM 'array' OR jsonb_array_length(v) > maximo THEN RETURN false; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(v) LOOP
    IF NOT public.kidmais_058_texto_ok(item, limite) THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END $$;

-- Objeto com exatamente estas chaves (strict() do runtime).
CREATE FUNCTION kidmais_058_chaves_exatas(v jsonb, chaves text[]) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $$
  SELECT COALESCE(jsonb_typeof(v) = 'object' AND v ?& chaves AND (v - chaves) = '{}'::jsonb, false)
$$;

-- conteudoSchema.
CREATE FUNCTION kidmais_058_conteudo_ok(c jsonb) RETURNS boolean
  LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  item jsonb;
  marcador jsonb;
  m jsonb;
BEGIN
  IF NOT public.kidmais_058_chaves_exatas(c, ARRAY['tom', 'instrucoes', 'procedimentos', 'objecoes', 'templates', 'formatacao']) THEN RETURN false; END IF;
  -- tom: TEXTO(400).nullable()
  IF jsonb_typeof(c->'tom') <> 'null' AND NOT public.kidmais_058_texto_ok(c->'tom', 400) THEN RETURN false; END IF;
  -- instrucoes: array(TEXTO(300)).max(20)
  IF NOT public.kidmais_058_lista_textos_ok(c->'instrucoes', 20, 300) THEN RETURN false; END IF;
  -- procedimentos: array({titulo: TEXTO(120), passos: array(TEXTO(300)).min(1).max(15)}).max(20)
  IF jsonb_typeof(c->'procedimentos') <> 'array' OR jsonb_array_length(c->'procedimentos') > 20 THEN RETURN false; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(c->'procedimentos') LOOP
    IF NOT public.kidmais_058_chaves_exatas(item, ARRAY['titulo', 'passos'])
       OR NOT public.kidmais_058_texto_ok(item->'titulo', 120)
       OR NOT public.kidmais_058_lista_textos_ok(item->'passos', 15, 300)
       OR jsonb_array_length(item->'passos') < 1 THEN RETURN false; END IF;
  END LOOP;
  -- objecoes: array({objecao: TEXTO(200), resposta: TEXTO(600)}).max(20)
  IF jsonb_typeof(c->'objecoes') <> 'array' OR jsonb_array_length(c->'objecoes') > 20 THEN RETURN false; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(c->'objecoes') LOOP
    IF NOT public.kidmais_058_chaves_exatas(item, ARRAY['objecao', 'resposta'])
       OR NOT public.kidmais_058_texto_ok(item->'objecao', 200)
       OR NOT public.kidmais_058_texto_ok(item->'resposta', 600) THEN RETURN false; END IF;
  END LOOP;
  -- templates: array({id: /^[a-z][a-z0-9_]{1,48}$/, titulo: TEXTO(120), texto: TEXTO(1200), marcadores: array(enum).max(10)}).max(20)
  IF jsonb_typeof(c->'templates') <> 'array' OR jsonb_array_length(c->'templates') > 20 THEN RETURN false; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(c->'templates') LOOP
    IF NOT public.kidmais_058_chaves_exatas(item, ARRAY['id', 'titulo', 'texto', 'marcadores'])
       OR jsonb_typeof(item->'id') <> 'string' OR NOT ((item->>'id') ~ '^[a-z][a-z0-9_]{1,48}$')
       OR NOT public.kidmais_058_texto_ok(item->'titulo', 120)
       OR NOT public.kidmais_058_texto_ok(item->'texto', 1200)
       OR jsonb_typeof(item->'marcadores') <> 'array' OR jsonb_array_length(item->'marcadores') > 10 THEN RETURN false; END IF;
    FOR marcador IN SELECT value FROM jsonb_array_elements(item->'marcadores') LOOP
      IF jsonb_typeof(marcador) <> 'string' OR (marcador #>> '{}') NOT IN ('nome_cliente', 'nome_aniversariante', 'data_festa', 'horario_festa',
           'nome_pacote', 'convidados', 'nome_empresa', 'valor_em_aberto', 'data_vencimento', 'situacao_contrato') THEN RETURN false; END IF;
    END LOOP;
  END LOOP;
  -- formatacao: {maxParagrafos: number.int().min(1).max(10).nullable(), usarListas: boolean.nullable()}
  m := c->'formatacao';
  IF NOT public.kidmais_058_chaves_exatas(m, ARRAY['maxParagrafos', 'usarListas']) THEN RETURN false; END IF;
  IF jsonb_typeof(m->'maxParagrafos') = 'number' THEN
    IF (m->>'maxParagrafos')::numeric <> trunc((m->>'maxParagrafos')::numeric) OR (m->>'maxParagrafos')::numeric NOT BETWEEN 1 AND 10 THEN RETURN false; END IF;
  ELSIF jsonb_typeof(m->'maxParagrafos') <> 'null' THEN RETURN false;
  END IF;
  IF jsonb_typeof(m->'usarListas') NOT IN ('boolean', 'null') THEN RETURN false; END IF;
  RETURN true;
END $$;

-- Demais campos do skillSchema (fora de conteudo): limites, formatos e chaves exatas.
CREATE FUNCTION kidmais_058_metadados_ok(d jsonb) RETURNS boolean
  LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  item jsonb;
  uuid_js constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
BEGIN
  IF NOT public.kidmais_058_chaves_exatas(d, ARRAY['id', 'nivel', 'escopo', 'finalidades', 'capacidades', 'versao', 'proveniencia',
       'revisao', 'permissoes', 'restricoes', 'conteudo', 'hash']) THEN RETURN false; END IF;
  -- id /^[a-z][a-z0-9_]{2,48}$/, versao /^\d+\.\d+\.\d+$/, hash /^[0-9a-f]{64}$/
  IF jsonb_typeof(d->'id') <> 'string' OR NOT ((d->>'id') ~ '^[a-z][a-z0-9_]{2,48}$') THEN RETURN false; END IF;
  IF jsonb_typeof(d->'versao') <> 'string' OR NOT ((d->>'versao') ~ '^[0-9]+\.[0-9]+\.[0-9]+$') THEN RETURN false; END IF;
  IF jsonb_typeof(d->'hash') <> 'string' OR NOT ((d->>'hash') ~ '^[0-9a-f]{64}$') THEN RETURN false; END IF;
  IF jsonb_typeof(d->'nivel') <> 'string' OR (d->>'nivel') NOT IN ('PLATAFORMA', 'EMPRESA', 'ESTABELECIMENTO') THEN RETURN false; END IF;
  -- escopo {empresaId: UUID|null, estabelecimentoId: UUID|null}
  IF NOT public.kidmais_058_chaves_exatas(d->'escopo', ARRAY['empresaId', 'estabelecimentoId']) THEN RETURN false; END IF;
  FOR item IN SELECT value FROM jsonb_each(d->'escopo') LOOP
    IF jsonb_typeof(item) = 'null' THEN CONTINUE; END IF;
    IF jsonb_typeof(item) <> 'string' OR NOT ((item #>> '{}') ~ uuid_js) THEN RETURN false; END IF;
  END LOOP;
  -- finalidades: array(enum).min(1).max(6)
  IF jsonb_typeof(d->'finalidades') <> 'array' OR jsonb_array_length(d->'finalidades') NOT BETWEEN 1 AND 6 THEN RETURN false; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(d->'finalidades') LOOP
    IF jsonb_typeof(item) <> 'string' OR (item #>> '{}') NOT IN ('TOM', 'ATENDIMENTO', 'SUGESTAO_TEXTO', 'PROCEDIMENTO', 'OBJECAO', 'FORMATACAO') THEN RETURN false; END IF;
  END LOOP;
  -- capacidades: array(/^[a-z_]{1,64}$/).max(20)
  IF jsonb_typeof(d->'capacidades') <> 'array' OR jsonb_array_length(d->'capacidades') > 20 THEN RETURN false; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(d->'capacidades') LOOP
    IF jsonb_typeof(item) <> 'string' OR NOT ((item #>> '{}') ~ '^[a-z_]{1,64}$') THEN RETURN false; END IF;
  END LOOP;
  -- proveniencia {origem: enum, autor: TEXTO(120), referencia: TEXTO(120)}
  IF NOT public.kidmais_058_chaves_exatas(d->'proveniencia', ARRAY['origem', 'autor', 'referencia'])
     OR jsonb_typeof(d->'proveniencia'->'origem') <> 'string' OR (d->'proveniencia'->>'origem') NOT IN ('INTERNA', 'EMPRESA', 'TERCEIRO')
     OR NOT public.kidmais_058_texto_ok(d->'proveniencia'->'autor', 120)
     OR NOT public.kidmais_058_texto_ok(d->'proveniencia'->'referencia', 120) THEN RETURN false; END IF;
  -- revisao {estado: enum, revisor: TEXTO(120)|null, revisadoEm: /^\d{4}-\d{2}-\d{2}$/|null, hashRevisado: HASH|null}
  IF NOT public.kidmais_058_chaves_exatas(d->'revisao', ARRAY['estado', 'revisor', 'revisadoEm', 'hashRevisado'])
     OR jsonb_typeof(d->'revisao'->'estado') <> 'string' OR (d->'revisao'->>'estado') NOT IN ('APROVADA', 'RESTRITA', 'PENDENTE', 'REJEITADA') THEN RETURN false; END IF;
  IF jsonb_typeof(d->'revisao'->'revisor') <> 'null' AND NOT public.kidmais_058_texto_ok(d->'revisao'->'revisor', 120) THEN RETURN false; END IF;
  IF jsonb_typeof(d->'revisao'->'revisadoEm') <> 'null'
     AND (jsonb_typeof(d->'revisao'->'revisadoEm') <> 'string' OR NOT ((d->'revisao'->>'revisadoEm') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')) THEN RETURN false; END IF;
  IF jsonb_typeof(d->'revisao'->'hashRevisado') <> 'null'
     AND (jsonb_typeof(d->'revisao'->'hashRevisado') <> 'string' OR NOT ((d->'revisao'->>'hashRevisado') ~ '^[0-9a-f]{64}$')) THEN RETURN false; END IF;
  -- permissoes {classes: array(enum READ|SUGGEST).min(1).max(2)}
  IF NOT public.kidmais_058_chaves_exatas(d->'permissoes', ARRAY['classes'])
     OR jsonb_typeof(d->'permissoes'->'classes') <> 'array' OR jsonb_array_length(d->'permissoes'->'classes') NOT BETWEEN 1 AND 2 THEN RETURN false; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(d->'permissoes'->'classes') LOOP
    IF jsonb_typeof(item) <> 'string' OR (item #>> '{}') NOT IN ('READ', 'SUGGEST') THEN RETURN false; END IF;
  END LOOP;
  -- restricoes: array(TEXTO(200)).max(20)
  IF NOT public.kidmais_058_lista_textos_ok(d->'restricoes', 20, 200) THEN RETURN false; END IF;
  RETURN true;
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
  -- Paridade exata com o runtime (limites, trim do JS, UTF-16, chaves exatas): funções kidmais_058_*_ok acima.
  CONSTRAINT ia_skills_058_definicao_limites_check CHECK (COALESCE(public.kidmais_058_metadados_ok(definicao), false)),
  CONSTRAINT ia_skills_058_conteudo_check CHECK (COALESCE(public.kidmais_058_conteudo_ok(definicao->'conteudo'), false)),
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
