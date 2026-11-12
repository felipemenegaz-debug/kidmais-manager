-- 102: apresentação do salão ao cliente (fase S-A do fluxo "cliente com 2 salões"). Plano rev. 4 aprovado com ressalvas
-- pelo Astra em 25/10/2026 (vault: "Plano tecnico saloes S-A e S-A2 20261025"); decisões de Felipe F1–F4 do mesmo dia.
--   * agenda_saloes ganha campos de apresentação (mínimo, sentados, área, idade, frase, outra festa no horário, o que é
--     exclusivo, mês das fotos), a declaração "salão como está hoje" e a versão do conteúdo;
--   * catálogo global e imutável de itens físicos do salão + itens por salão (catálogo ou próprio, até 4 destaques);
--   * fotos WebP no banco (até 8 ativas por salão, legenda obrigatória, nunca apagadas, só marcadas como removidas);
--   * qualquer mudança pública (no salão, nas fotos ou nos itens) sobe conteudo_versao e anula a declaração, inclusive
--     quando vem da agenda (nome, capacidade, ativo) ou de SQL direto.
-- Depende só da 093. Não suporta a 098 (salões combinados, pausada): recusa se ela estiver instalada, e o aplicador da
-- 098 recusa depois desta pelo retrato. Não toca funções da 094/100. Sem backfill: salões existentes ficam com os
-- valores neutros (opcionais NULL, exclusivos vazio, versão 0, sem declaração).
-- Executar somente após autorização própria do ambiente, precheck, backup operacional e postcheck.
-- Rollback: database/rollback/20261025_102_saloes_apresentacao_down.sql (recusado se houver qualquer conteúdo novo).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
SET LOCAL search_path = public, pg_catalog;
DO $$
BEGIN
  IF to_regclass('public.agenda_saloes') IS NULL OR to_regclass('public.usuarios_administrativos') IS NULL
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.agenda_saloes'::regclass AND conname = 'agenda_saloes_empresa_id_uk') THEN
    RAISE EXCEPTION '102: precheck falhou (093 ausente); nada alterado';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'agenda_saloes' AND column_name IN ('combinado', 'membros'))
    OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname LIKE 'kidmais098\_%') THEN
    RAISE EXCEPTION '102: precheck falhou (098 instalada; 098+102 exige revisão conjunta); nada alterado';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'agenda_saloes'
              AND column_name IN ('convidados_minimo', 'convidados_sentados', 'area_m2', 'idade_min', 'idade_max', 'frase',
                                  'outra_festa_simultanea', 'exclusivos', 'fotos_referencia', 'declaracao_em', 'declaracao_por',
                                  'declaracao_versao', 'conteudo_versao'))
    OR to_regclass('public.agenda_salao_itens_catalogo') IS NOT NULL OR to_regclass('public.agenda_salao_itens') IS NOT NULL
    OR to_regclass('public.agenda_salao_fotos') IS NOT NULL
    OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname LIKE 'kidmais102\_%') THEN
    RAISE EXCEPTION '102: precheck falhou (102 já aplicada ou parcial); nada alterado';
  END IF;
END $$;

-- =============================================================================
-- 1. Campos de apresentação do salão. CHECKs escritos para nunca resultarem UNKNOWN com NULL.
-- =============================================================================
CREATE FUNCTION public.kidmais102_exclusivos_validos(v text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog AS $$
  SELECT (cardinality(v) = 0 OR array_ndims(v) = 1)
     AND array_position(v, NULL) IS NULL
     AND v <@ ARRAY['ENTRADA', 'BRINQUEDOS', 'BANHEIROS', 'MESA_BOLO', 'SOM', 'ESTACIONAMENTO']::text[]
     AND cardinality(v) = (SELECT count(DISTINCT x) FROM unnest(v) AS x)
$$;

ALTER TABLE public.agenda_saloes
  ADD COLUMN convidados_minimo smallint,
  ADD COLUMN convidados_sentados smallint,
  ADD COLUMN area_m2 smallint,
  ADD COLUMN idade_min smallint,
  ADD COLUMN idade_max smallint,
  ADD COLUMN frase text,
  ADD COLUMN outra_festa_simultanea boolean,
  ADD COLUMN exclusivos text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN fotos_referencia date,
  ADD COLUMN declaracao_em timestamptz,
  ADD COLUMN declaracao_por uuid REFERENCES public.usuarios_administrativos(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD COLUMN declaracao_versao integer,
  ADD COLUMN conteudo_versao integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT agenda_saloes_102_minimo_ck CHECK (convidados_minimo IS NULL
    OR (capacidade_convidados IS NOT NULL AND convidados_minimo > 0 AND convidados_minimo <= capacidade_convidados)),
  ADD CONSTRAINT agenda_saloes_102_sentados_ck CHECK (convidados_sentados IS NULL
    OR (capacidade_convidados IS NOT NULL AND convidados_sentados > 0 AND convidados_sentados <= capacidade_convidados)),
  ADD CONSTRAINT agenda_saloes_102_area_ck CHECK (area_m2 IS NULL OR area_m2 BETWEEN 1 AND 5000),
  ADD CONSTRAINT agenda_saloes_102_idade_ck CHECK ((idade_min IS NULL AND idade_max IS NULL)
    OR (idade_min IS NOT NULL AND idade_max IS NOT NULL AND idade_min BETWEEN 0 AND 17 AND idade_max BETWEEN 0 AND 17 AND idade_min <= idade_max)),
  ADD CONSTRAINT agenda_saloes_102_frase_ck CHECK (frase IS NULL OR (char_length(frase) BETWEEN 1 AND 80 AND frase = btrim(frase))),
  ADD CONSTRAINT agenda_saloes_102_exclusivos_ck CHECK (public.kidmais102_exclusivos_validos(exclusivos)),
  ADD CONSTRAINT agenda_saloes_102_fotos_referencia_ck CHECK (fotos_referencia IS NULL OR extract(day FROM fotos_referencia) = 1),
  ADD CONSTRAINT agenda_saloes_102_declaracao_ck CHECK ((declaracao_em IS NULL AND declaracao_por IS NULL AND declaracao_versao IS NULL)
    OR (declaracao_em IS NOT NULL AND declaracao_por IS NOT NULL AND declaracao_versao IS NOT NULL AND declaracao_versao >= 0)),
  ADD CONSTRAINT agenda_saloes_102_versao_ck CHECK (conteudo_versao >= 0);

-- Versão e declaração do salão (todos os escritores: agenda, assistente, nova tela, SQL direto).
--   * INSERT: nasce neutro (versão 0, sem declaração); mês das fotos não futuro.
--   * UPDATE: mudança efetiva de campo PÚBLICO (nome, capacidade, ativo e os campos de apresentação) sobe a versão uma vez
--     e anula a declaração, mesmo que a mesma instrução tente gravar uma declaração; versão nunca recua; declarar exige a
--     versão vigente. Campos de versão/declaração não contam como públicos: a filha que só sobe a versão não se
--     autoinvalida e a confirmação não se anula. ordem não é pública.
CREATE FUNCTION public.kidmais102_salao_conteudo() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
DECLARE
  mes_atual date := date_trunc('month', (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo'))::date;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.conteudo_versao <> 0 OR NEW.declaracao_em IS NOT NULL OR NEW.declaracao_por IS NOT NULL OR NEW.declaracao_versao IS NOT NULL THEN
      RAISE EXCEPTION '102: salão novo nasce sem declaração e com versão 0' USING ERRCODE = '23514', CONSTRAINT = 'agenda_saloes_102_declaracao_ck';
    END IF;
    IF NEW.fotos_referencia IS NOT NULL AND NEW.fotos_referencia > mes_atual THEN
      RAISE EXCEPTION '102: mês das fotos no futuro' USING ERRCODE = '23514', CONSTRAINT = 'agenda_saloes_102_fotos_referencia_ck';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.conteudo_versao < OLD.conteudo_versao THEN
    RAISE EXCEPTION '102: versão do conteúdo não recua' USING ERRCODE = '23514', CONSTRAINT = 'agenda_saloes_102_versao_ck';
  END IF;
  IF NEW.fotos_referencia IS DISTINCT FROM OLD.fotos_referencia AND NEW.fotos_referencia IS NOT NULL AND NEW.fotos_referencia > mes_atual THEN
    RAISE EXCEPTION '102: mês das fotos no futuro' USING ERRCODE = '23514', CONSTRAINT = 'agenda_saloes_102_fotos_referencia_ck';
  END IF;
  IF NEW.nome IS DISTINCT FROM OLD.nome OR NEW.capacidade_convidados IS DISTINCT FROM OLD.capacidade_convidados
     OR NEW.ativo IS DISTINCT FROM OLD.ativo OR NEW.convidados_minimo IS DISTINCT FROM OLD.convidados_minimo
     OR NEW.convidados_sentados IS DISTINCT FROM OLD.convidados_sentados OR NEW.area_m2 IS DISTINCT FROM OLD.area_m2
     OR NEW.idade_min IS DISTINCT FROM OLD.idade_min OR NEW.idade_max IS DISTINCT FROM OLD.idade_max
     OR NEW.frase IS DISTINCT FROM OLD.frase OR NEW.outra_festa_simultanea IS DISTINCT FROM OLD.outra_festa_simultanea
     OR NEW.exclusivos IS DISTINCT FROM OLD.exclusivos OR NEW.fotos_referencia IS DISTINCT FROM OLD.fotos_referencia THEN
    NEW.conteudo_versao := OLD.conteudo_versao + 1;
    NEW.declaracao_em := NULL;
    NEW.declaracao_por := NULL;
    NEW.declaracao_versao := NULL;
    RETURN NEW;
  END IF;
  IF NEW.declaracao_em IS NOT NULL AND (OLD.declaracao_em IS NULL OR NEW.declaracao_em IS DISTINCT FROM OLD.declaracao_em
       OR NEW.declaracao_versao IS DISTINCT FROM OLD.declaracao_versao OR NEW.declaracao_por IS DISTINCT FROM OLD.declaracao_por)
     AND NEW.declaracao_versao IS DISTINCT FROM NEW.conteudo_versao THEN
    RAISE EXCEPTION '102: declaração precisa da versão vigente do conteúdo' USING ERRCODE = '23514', CONSTRAINT = 'agenda_saloes_102_declaracao_ck';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agenda_saloes_102_conteudo_trg BEFORE INSERT OR UPDATE ON public.agenda_saloes
  FOR EACH ROW EXECUTE FUNCTION public.kidmais102_salao_conteudo();

-- Uma mudança pública numa filha (item ou foto) sobe a versão do salão e anula a declaração, na mesma transação.
CREATE FUNCTION public.kidmais102_invalidar_salao(sid uuid) RETURNS void
LANGUAGE sql SET search_path = public, pg_catalog AS $$
  UPDATE agenda_saloes SET conteudo_versao = conteudo_versao + 1, declaracao_em = NULL, declaracao_por = NULL, declaracao_versao = NULL
   WHERE id = sid
$$;

-- TRUNCATE nunca é permitido nas tabelas da 102 (escaparia dos gatilhos de linha).
CREATE FUNCTION public.kidmais102_sem_truncate() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
BEGIN
  RAISE EXCEPTION '102: TRUNCATE recusado em %', TG_TABLE_NAME USING ERRCODE = '42501';
END $$;

-- =============================================================================
-- 2. Catálogo global de itens físicos do salão: conteúdo imutável (mudar significado = código novo, por migration).
-- Só `ativo` muda: inativo sai das escolhas novas, e os itens já marcados continuam exibidos com o mesmo texto.
-- Fora do seed por decisão de Felipe (F2, 25/10): "acessível" e "segurança dos brinquedos" (laudos, fase S-A3).
-- Itens de serviço (monitores, cardápio, decoração, animação) ficam nos pacotes (103), nunca aqui.
-- =============================================================================
CREATE TABLE public.agenda_salao_itens_catalogo (
  codigo varchar(40) PRIMARY KEY CHECK (codigo ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  grupo text NOT NULL CHECK (grupo IN ('BRINCADEIRAS', 'ADULTOS', 'CONFORTO', 'ESPACO')),
  nome text NOT NULL CHECK (char_length(nome) BETWEEN 1 AND 60 AND nome = btrim(nome)),
  ordem smallint NOT NULL CHECK (ordem > 0),
  ativo boolean NOT NULL DEFAULT true,
  idade_min smallint,
  idade_max smallint,
  pede_detalhe boolean NOT NULL DEFAULT false,
  CONSTRAINT agenda_salao_itens_catalogo_idade_ck CHECK ((idade_min IS NULL AND idade_max IS NULL)
    OR (idade_min IS NOT NULL AND idade_max IS NOT NULL AND idade_min BETWEEN 0 AND 17 AND idade_max BETWEEN 0 AND 17 AND idade_min <= idade_max)),
  CONSTRAINT agenda_salao_itens_catalogo_codigo_grupo_uk UNIQUE (codigo, grupo)
);

CREATE FUNCTION public.kidmais102_catalogo_imutavel() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '102: item do catálogo não é apagado; desative por migration' USING ERRCODE = '42501';
  END IF;
  IF NEW.codigo IS DISTINCT FROM OLD.codigo OR NEW.grupo IS DISTINCT FROM OLD.grupo OR NEW.nome IS DISTINCT FROM OLD.nome
     OR NEW.ordem IS DISTINCT FROM OLD.ordem OR NEW.idade_min IS DISTINCT FROM OLD.idade_min OR NEW.idade_max IS DISTINCT FROM OLD.idade_max
     OR NEW.pede_detalhe IS DISTINCT FROM OLD.pede_detalhe THEN
    RAISE EXCEPTION '102: conteúdo do catálogo é imutável; crie um código novo' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agenda_salao_itens_catalogo_102_imutavel_trg BEFORE UPDATE OR DELETE ON public.agenda_salao_itens_catalogo
  FOR EACH ROW EXECUTE FUNCTION public.kidmais102_catalogo_imutavel();
CREATE TRIGGER agenda_salao_itens_catalogo_102_truncate_trg BEFORE TRUNCATE ON public.agenda_salao_itens_catalogo
  FOR EACH STATEMENT EXECUTE FUNCTION public.kidmais102_sem_truncate();

INSERT INTO public.agenda_salao_itens_catalogo (codigo, grupo, nome, ordem, idade_min, idade_max, pede_detalhe) VALUES
  ('BRINQUEDAO', 'BRINCADEIRAS', 'Brinquedão (kid play)', 1, 4, 12, true),
  ('CAMA_ELASTICA', 'BRINCADEIRAS', 'Cama elástica', 2, 4, 12, false),
  ('PISCINA_BOLINHAS', 'BRINCADEIRAS', 'Piscina de bolinhas', 3, 1, 6, false),
  ('ESCORREGADOR', 'BRINCADEIRAS', 'Escorregador ou tobogã', 4, 2, 10, false),
  ('ESPACO_BABY', 'BRINCADEIRAS', 'Espaço baby (até 3 anos)', 5, 0, 3, false),
  ('SALAO_JOGOS', 'BRINCADEIRAS', 'Salão de jogos', 6, 6, 14, true),
  ('SIMULADORES', 'BRINCADEIRAS', 'Simuladores e brinquedos eletrônicos', 7, 7, 14, false),
  ('CAMPINHO', 'BRINCADEIRAS', 'Campinho ou quadra', 8, 5, 14, false),
  ('PARQUINHO_EXTERNO', 'BRINCADEIRAS', 'Área externa com parquinho', 9, 2, 10, false),
  ('OFICINA_ARTES', 'BRINCADEIRAS', 'Oficina de artes', 10, 3, 10, false),
  ('VISTA_BRINQUEDOS', 'ADULTOS', 'Área dos adultos com vista dos brinquedos', 1, NULL, NULL, false),
  ('BAR_PAIS', 'ADULTOS', 'Bar de pais', 2, NULL, NULL, false),
  ('SINUCA', 'ADULTOS', 'Mesa de sinuca', 3, NULL, NULL, false),
  ('SALA_VIP', 'ADULTOS', 'Sala vip dos anfitriões', 4, NULL, NULL, false),
  ('DECK_JARDIM', 'ADULTOS', 'Deck ou jardim', 5, NULL, NULL, false),
  ('MESAS_TODOS', 'ADULTOS', 'Mesas e cadeiras para todos os convidados', 6, NULL, NULL, false),
  ('AR_TODOS_AMBIENTES', 'CONFORTO', 'Ar-condicionado em todos os ambientes, inclusive brinquedos', 1, NULL, NULL, false),
  ('FRALDARIO', 'CONFORTO', 'Fraldário', 2, NULL, NULL, false),
  ('BERCARIO', 'CONFORTO', 'Berçário ou sala de amamentação', 3, NULL, NULL, false),
  ('CAMARIM', 'CONFORTO', 'Camarim do aniversariante', 4, NULL, NULL, false),
  ('SOM_TELAO', 'CONFORTO', 'Som e telão', 5, NULL, NULL, false),
  ('BANHEIROS_AMPLOS', 'CONFORTO', 'Banheiros amplos', 6, NULL, NULL, false),
  ('WIFI', 'CONFORTO', 'Wi-Fi', 7, NULL, NULL, false),
  ('PISO_UNICO', 'ESPACO', 'Piso único, sem escadas', 1, NULL, NULL, false),
  ('ESTACIONAMENTO', 'ESPACO', 'Estacionamento próprio', 2, NULL, NULL, true),
  ('ENTRADA_INDEPENDENTE', 'ESPACO', 'Entrada independente', 3, NULL, NULL, false),
  ('AREA_COBERTA', 'ESPACO', 'Área coberta para dias de chuva', 4, NULL, NULL, false),
  ('CAMERAS', 'ESPACO', 'Câmeras de segurança', 5, NULL, NULL, false);

-- =============================================================================
-- 3. Itens de cada salão. Identidade imutável (empresa, salão, grupo, código, tipo): trocar item = remover e recriar.
-- Muda por UPDATE só o texto do item próprio, o detalhe e o destaque. Até 4 destaques por salão (F1: item próprio também
-- pode ser destaque), contados com o salão travado.
-- =============================================================================
CREATE TABLE public.agenda_salao_itens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL,
  salao_id uuid NOT NULL,
  grupo text NOT NULL CHECK (grupo IN ('BRINCADEIRAS', 'ADULTOS', 'CONFORTO', 'ESPACO')),
  item_codigo varchar(40),
  item_proprio text,
  detalhe text CHECK (detalhe IS NULL OR (char_length(detalhe) BETWEEN 1 AND 40 AND detalhe = btrim(detalhe))),
  destaque boolean NOT NULL DEFAULT false,
  criado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT agenda_salao_itens_salao_fk FOREIGN KEY (empresa_id, salao_id)
    REFERENCES public.agenda_saloes(empresa_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT agenda_salao_itens_catalogo_fk FOREIGN KEY (item_codigo, grupo)
    REFERENCES public.agenda_salao_itens_catalogo(codigo, grupo) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT agenda_salao_itens_tipo_ck CHECK ((item_codigo IS NULL) <> (item_proprio IS NULL)),
  CONSTRAINT agenda_salao_itens_proprio_ck CHECK (item_proprio IS NULL OR (char_length(item_proprio) BETWEEN 1 AND 60
    AND item_proprio = regexp_replace(btrim(item_proprio), '\s+', ' ', 'g')))
);
CREATE UNIQUE INDEX agenda_salao_itens_codigo_uk ON public.agenda_salao_itens (salao_id, item_codigo) WHERE item_codigo IS NOT NULL;
CREATE UNIQUE INDEX agenda_salao_itens_proprio_uk ON public.agenda_salao_itens (salao_id, grupo, lower(item_proprio)) WHERE item_proprio IS NOT NULL;
CREATE INDEX agenda_salao_itens_empresa_idx ON public.agenda_salao_itens (empresa_id, salao_id);

CREATE FUNCTION public.kidmais102_item_antes() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
DECLARE
  n integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM 1 FROM agenda_saloes WHERE id = OLD.salao_id FOR UPDATE;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.empresa_id IS DISTINCT FROM OLD.empresa_id
       OR NEW.salao_id IS DISTINCT FROM OLD.salao_id OR NEW.grupo IS DISTINCT FROM OLD.grupo
       OR NEW.item_codigo IS DISTINCT FROM OLD.item_codigo OR (NEW.item_proprio IS NULL) <> (OLD.item_proprio IS NULL)
       OR NEW.criado_em IS DISTINCT FROM OLD.criado_em) THEN
    RAISE EXCEPTION '102: identidade do item é imutável; remova e crie outro' USING ERRCODE = '23514', CONSTRAINT = 'agenda_salao_itens_tipo_ck';
  END IF;
  -- Salão travado antes de contar (mesma ordem do serviço: salão → filhas).
  PERFORM 1 FROM agenda_saloes WHERE id = NEW.salao_id FOR UPDATE;
  IF TG_OP = 'INSERT' AND NEW.item_codigo IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM agenda_salao_itens_catalogo c WHERE c.codigo = NEW.item_codigo AND c.ativo) THEN
    RAISE EXCEPTION '102: item do catálogo inativo não pode ser escolhido' USING ERRCODE = '23514', CONSTRAINT = 'agenda_salao_itens_catalogo_fk';
  END IF;
  IF NEW.destaque AND (TG_OP = 'INSERT' OR NOT OLD.destaque) THEN
    SELECT count(*) INTO n FROM agenda_salao_itens i WHERE i.salao_id = NEW.salao_id AND i.destaque AND i.id <> NEW.id;
    IF n >= 4 THEN
      RAISE EXCEPTION '102: no máximo 4 destaques por salão' USING ERRCODE = '23514', CONSTRAINT = 'agenda_salao_itens_destaques_ck';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agenda_salao_itens_102_antes_trg BEFORE INSERT OR UPDATE OR DELETE ON public.agenda_salao_itens
  FOR EACH ROW EXECUTE FUNCTION public.kidmais102_item_antes();

CREATE FUNCTION public.kidmais102_item_depois() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.item_proprio IS NOT DISTINCT FROM OLD.item_proprio AND NEW.detalhe IS NOT DISTINCT FROM OLD.detalhe
     AND NEW.destaque IS NOT DISTINCT FROM OLD.destaque THEN
    RETURN NULL;
  END IF;
  PERFORM public.kidmais102_invalidar_salao(CASE WHEN TG_OP = 'DELETE' THEN OLD.salao_id ELSE NEW.salao_id END);
  RETURN NULL;
END $$;
CREATE TRIGGER agenda_salao_itens_102_depois_trg AFTER INSERT OR UPDATE OR DELETE ON public.agenda_salao_itens
  FOR EACH ROW EXECUTE FUNCTION public.kidmais102_item_depois();
CREATE TRIGGER agenda_salao_itens_102_truncate_trg BEFORE TRUNCATE ON public.agenda_salao_itens
  FOR EACH STATEMENT EXECUTE FUNCTION public.kidmais102_sem_truncate();

-- =============================================================================
-- 4. Fotos do salão: WebP já normalizado (limites iguais à saída da normalização da 085: 1.500.000 bytes, 1600 px).
-- Nunca apagadas; só legenda, ordem e a remoção (uma vez) mudam. Até 8 ativas por salão, contadas com o salão travado.
-- Procedência sem FK para a 085: origem e hash da imagem do site copiada (a posse é conferida pelo serviço).
-- =============================================================================
CREATE TABLE public.agenda_salao_fotos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL,
  salao_id uuid NOT NULL,
  conteudo bytea NOT NULL,
  mime text NOT NULL CHECK (mime = 'image/webp'),
  bytes integer NOT NULL,
  largura integer NOT NULL CHECK (largura BETWEEN 1 AND 1600),
  altura integer NOT NULL CHECK (altura BETWEEN 1 AND 1600),
  sha256 char(64) NOT NULL,
  legenda text NOT NULL CHECK (char_length(legenda) BETWEEN 1 AND 60 AND legenda = btrim(legenda)),
  ordem smallint NOT NULL CHECK (ordem BETWEEN 1 AND 32000),
  origem text NOT NULL CHECK (origem IN ('UPLOAD', 'SITE')),
  origem_sha256 char(64),
  criado_por uuid NOT NULL REFERENCES public.usuarios_administrativos(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  criado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  removida_em timestamptz,
  CONSTRAINT agenda_salao_fotos_salao_fk FOREIGN KEY (empresa_id, salao_id)
    REFERENCES public.agenda_saloes(empresa_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT agenda_salao_fotos_bytes_ck CHECK (bytes BETWEEN 1 AND 1500000 AND bytes = octet_length(conteudo)),
  CONSTRAINT agenda_salao_fotos_hash_ck CHECK (sha256 ~ '^[0-9a-f]{64}$' AND sha256 = encode(sha256(conteudo), 'hex')),
  CONSTRAINT agenda_salao_fotos_origem_ck CHECK ((origem = 'SITE') = (origem_sha256 IS NOT NULL)
    AND (origem_sha256 IS NULL OR origem_sha256 ~ '^[0-9a-f]{64}$')),
  CONSTRAINT agenda_salao_fotos_remocao_ck CHECK (removida_em IS NULL OR removida_em >= criado_em)
);
CREATE UNIQUE INDEX agenda_salao_fotos_ordem_uk ON public.agenda_salao_fotos (empresa_id, salao_id, ordem) WHERE removida_em IS NULL;
CREATE INDEX agenda_salao_fotos_salao_idx ON public.agenda_salao_fotos (salao_id, ordem) WHERE removida_em IS NULL;

CREATE FUNCTION public.kidmais102_foto_antes() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
DECLARE
  n integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '102: foto do salão não é apagada; marque como removida' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.removida_em IS NOT NULL THEN
      RAISE EXCEPTION '102: foto nova não nasce removida' USING ERRCODE = '23514', CONSTRAINT = 'agenda_salao_fotos_remocao_ck';
    END IF;
    PERFORM 1 FROM agenda_saloes WHERE id = NEW.salao_id FOR UPDATE;
    SELECT count(*) INTO n FROM agenda_salao_fotos f WHERE f.salao_id = NEW.salao_id AND f.removida_em IS NULL;
    IF n >= 8 THEN
      RAISE EXCEPTION '102: no máximo 8 fotos ativas por salão' USING ERRCODE = '23514', CONSTRAINT = 'agenda_salao_fotos_limite_ck';
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE: lista do que pode mudar (legenda, ordem e a remoção, uma única vez). Foto removida não muda mais.
  IF OLD.removida_em IS NOT NULL THEN
    RAISE EXCEPTION '102: foto removida não muda nem volta' USING ERRCODE = '42501';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.empresa_id IS DISTINCT FROM OLD.empresa_id OR NEW.salao_id IS DISTINCT FROM OLD.salao_id
     OR NEW.conteudo IS DISTINCT FROM OLD.conteudo OR NEW.mime IS DISTINCT FROM OLD.mime OR NEW.bytes IS DISTINCT FROM OLD.bytes
     OR NEW.largura IS DISTINCT FROM OLD.largura OR NEW.altura IS DISTINCT FROM OLD.altura OR NEW.sha256 IS DISTINCT FROM OLD.sha256
     OR NEW.origem IS DISTINCT FROM OLD.origem OR NEW.origem_sha256 IS DISTINCT FROM OLD.origem_sha256
     OR NEW.criado_por IS DISTINCT FROM OLD.criado_por OR NEW.criado_em IS DISTINCT FROM OLD.criado_em THEN
    RAISE EXCEPTION '102: só legenda, ordem e remoção mudam numa foto' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM agenda_saloes WHERE id = NEW.salao_id FOR UPDATE;
  RETURN NEW;
END $$;
CREATE TRIGGER agenda_salao_fotos_102_antes_trg BEFORE INSERT OR UPDATE OR DELETE ON public.agenda_salao_fotos
  FOR EACH ROW EXECUTE FUNCTION public.kidmais102_foto_antes();

CREATE FUNCTION public.kidmais102_foto_depois() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.legenda IS NOT DISTINCT FROM OLD.legenda AND NEW.ordem IS NOT DISTINCT FROM OLD.ordem
     AND NEW.removida_em IS NOT DISTINCT FROM OLD.removida_em THEN
    RETURN NULL;
  END IF;
  PERFORM public.kidmais102_invalidar_salao(NEW.salao_id);
  RETURN NULL;
END $$;
CREATE TRIGGER agenda_salao_fotos_102_depois_trg AFTER INSERT OR UPDATE ON public.agenda_salao_fotos
  FOR EACH ROW EXECUTE FUNCTION public.kidmais102_foto_depois();
CREATE TRIGGER agenda_salao_fotos_102_truncate_trg BEFORE TRUNCATE ON public.agenda_salao_fotos
  FOR EACH STATEMENT EXECUTE FUNCTION public.kidmais102_sem_truncate();

COMMENT ON TABLE public.agenda_salao_itens_catalogo IS '102: catálogo global e imutável de itens físicos do salão (só ativo muda, por migration).';
COMMENT ON TABLE public.agenda_salao_itens IS '102: itens de cada salão (catálogo ou próprio), até 4 destaques; identidade imutável.';
COMMENT ON TABLE public.agenda_salao_fotos IS '102: fotos WebP do salão, até 8 ativas; nunca apagadas, só marcadas como removidas.';
COMMIT;
