-- =============================================================================
-- Kidmais Manager / iA.Fest — Migration 127: marca de saída das campanhas por telefone/e-mail (guarda, fase 1a)
-- Arquivo: 20261119_127_marketing_saidas_contato.sql — LOCAL, PREPARADA, não aplicada em staging nem em production.
--
-- Plano: vault "Guarda e anonimizacao dos clientes 20261119", fase 1a (decisões G1–G8 aceitas por Felipe em 19/11).
-- 127 conferida livre em 19/11/2026 (nenhuma migration, clone irmão ou nota usa 127). Exige a 086 e a 060.
--
-- Por quê: o DPA 2026-11-17 (seção campanhas) promete que a saída das campanhas fica guardada pelo telefone ou e-mail e
-- data, e é conferida quando a mesma pessoa volta por recadastro ou importação. Até a 126 o descadastro era só por
-- cliente_id (086): cadastro novo com o mesmo número nascia liberado.
--
-- O que cria:
--   - marketing_saidas_contato: empresa, tipo (TELEFONE/EMAIL), valor normalizado (telefone por kidmais086_destino;
--     e-mail em minúsculas e sem espaços), data da saída, origem, cliente de onde veio (opcional) e quem registrou.
--     Uma marca VIVA por empresa+tipo+valor. Nada é apagado: a marca só é ENCERRADA (reativação pedida pela pessoa),
--     e o gatilho congela todo o resto. Telefone/e-mail ficam em claro (G1).
--   - gatilhos que gravam a marca: (i) descadastro em marketing_contato_preferencias (telefone, WhatsApp e e-mail do
--     cadastro naquele momento); (ii) cadastro de cliente descadastrado que ganha telefone/WhatsApp/e-mail novo;
--     (iii) conversa do atendimento WhatsApp que passa a nao_contatar (PARAR ou encerramento pedido pela pessoa).
--   - reativação (descadastrado_em volta a NULL) encerra as marcas vivas dos contatos ATUAIS do cadastro.
--   - carga inicial: descadastros existentes, conversas e controles do atendimento com nao_contatar.
-- Não muda nenhuma tabela existente nem apaga nada. O código passa a conferir a marca antes de campanha (G2: a pesquisa
-- de satisfação continua com as regras dela) e no formulário do site.
--
-- Rollback: database/rollback/20261119_127_marketing_saidas_contato_down.sql (recusa sem a confirmação explícita de
-- descartar as marcas; não apaga nada sozinho).
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
SET LOCAL search_path = public, pg_catalog;

DO $$
BEGIN
  IF to_regclass('public.marketing_contato_preferencias') IS NULL OR to_regprocedure('public.kidmais086_destino(text)') IS NULL
     OR to_regprocedure('public.kidmais085_somente_insercao()') IS NULL THEN
    RAISE EXCEPTION '127: exige a 086';
  END IF;
  IF to_regclass('public.whatsapp_atendimento_conversas') IS NULL THEN
    RAISE EXCEPTION '127: exige a 060';
  END IF;
  IF to_regclass('public.marketing_saidas_contato') IS NOT NULL THEN
    RAISE EXCEPTION '127: marketing_saidas_contato já existe';
  END IF;
END $$;

-- Trava quem alimenta a carga inicial ANTES de ler: nenhum descadastro ou PARAR fica de fora entre a carga e os gatilhos.
-- SHARE ROW EXCLUSIVE: bloqueia escrita, permite leitura; é o modo que o CREATE TRIGGER pede de qualquer jeito.
LOCK TABLE public.clientes, public.marketing_contato_preferencias, public.whatsapp_atendimento_conversas IN SHARE ROW EXCLUSIVE MODE;

-- E-mail canônico: minúsculas, sem espaços nas pontas; só vale um endereço com uma @ e algo dos dois lados.
CREATE FUNCTION kidmais127_email(valor text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE
  SET search_path = public, pg_catalog, pg_temp AS $$
  SELECT CASE WHEN e ~ '^[^@[:space:]]+@[^@[:space:]]+$' AND char_length(e) <= 320 THEN e END
    FROM (SELECT lower(btrim(COALESCE(valor, ''))) AS e) x
$$;

CREATE TABLE marketing_saidas_contato (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  tipo text NOT NULL,
  valor text NOT NULL,
  origem text NOT NULL,
  saiu_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  cliente_id uuid REFERENCES clientes (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  registrado_por uuid REFERENCES usuarios_administrativos (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  registrado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  encerrada_em timestamptz,
  encerrada_por uuid REFERENCES usuarios_administrativos (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  motivo_encerramento text,
  CONSTRAINT marketing_saidas_tipo CHECK (tipo IN ('TELEFONE', 'EMAIL')),
  CONSTRAINT marketing_saidas_valor CHECK (
    (tipo = 'TELEFONE' AND valor ~ '^[0-9]{12,15}$') OR (tipo = 'EMAIL' AND valor = kidmais127_email(valor))),
  -- EQUIPE/RESPOSTA_PARAR/SIMULACAO: as mesmas origens do descadastro (086). ATENDIMENTO_WHATSAPP: nao_contatar da conversa.
  CONSTRAINT marketing_saidas_origem CHECK (origem IN ('EQUIPE', 'RESPOSTA_PARAR', 'SIMULACAO', 'ATENDIMENTO_WHATSAPP')),
  CONSTRAINT marketing_saidas_encerrada CHECK ((encerrada_em IS NULL) = (motivo_encerramento IS NULL)
    AND (encerrada_em IS NOT NULL OR encerrada_por IS NULL)),
  CONSTRAINT marketing_saidas_motivo CHECK (motivo_encerramento IS NULL OR char_length(motivo_encerramento) BETWEEN 3 AND 300)
);
-- Uma marca viva por empresa, tipo e valor; encerradas ficam como histórico.
CREATE UNIQUE INDEX marketing_saidas_viva_uk ON marketing_saidas_contato (empresa_id, tipo, valor) WHERE encerrada_em IS NULL;
CREATE INDEX marketing_saidas_cliente_idx ON marketing_saidas_contato (empresa_id, cliente_id) WHERE cliente_id IS NOT NULL;

-- Controle: nada é apagado; na INSERÇÃO o cliente (se houver) é da mesma empresa; a única mudança possível é encerrar uma
-- marca viva (encerrada_em, encerrada_por e motivo, uma vez só). Todo o resto é congelado.
CREATE FUNCTION kidmais127_saida_controle() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_catalog, pg_temp AS $$
DECLARE dono uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION '127: marca de saída não é apagada; encerre.'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.cliente_id IS NOT NULL THEN
      SELECT empresa_id INTO dono FROM clientes WHERE id = NEW.cliente_id;
      IF dono IS DISTINCT FROM NEW.empresa_id THEN RAISE EXCEPTION '127: cliente da marca é de outra empresa.'; END IF;
    END IF;
    IF NEW.encerrada_em IS NOT NULL THEN RAISE EXCEPTION '127: marca não nasce encerrada.'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.empresa_id IS DISTINCT FROM OLD.empresa_id OR NEW.tipo IS DISTINCT FROM OLD.tipo
     OR NEW.valor IS DISTINCT FROM OLD.valor OR NEW.origem IS DISTINCT FROM OLD.origem OR NEW.saiu_em IS DISTINCT FROM OLD.saiu_em
     OR NEW.cliente_id IS DISTINCT FROM OLD.cliente_id OR NEW.registrado_por IS DISTINCT FROM OLD.registrado_por
     OR NEW.registrado_em IS DISTINCT FROM OLD.registrado_em THEN
    RAISE EXCEPTION '127: contato, origem e data da marca de saída são imutáveis.';
  END IF;
  IF OLD.encerrada_em IS NOT NULL OR NEW.encerrada_em IS NULL THEN
    RAISE EXCEPTION '127: só uma marca viva pode ser encerrada, uma vez.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER marketing_saidas_controle BEFORE INSERT OR UPDATE OR DELETE ON marketing_saidas_contato
  FOR EACH ROW EXECUTE FUNCTION kidmais127_saida_controle();

-- Grava as marcas dos contatos ATUAIS de um cliente (os que estiverem vazios ou fora do formato ficam de fora).
-- Marca viva já existente para o mesmo valor é mantida (vale a data mais antiga).
CREATE FUNCTION kidmais127_marcar_cliente(p_empresa uuid, p_cliente uuid, p_origem text, p_saiu_em timestamptz, p_por uuid)
  RETURNS void LANGUAGE plpgsql SET search_path = public, pg_catalog, pg_temp AS $$
BEGIN
  INSERT INTO marketing_saidas_contato (empresa_id, tipo, valor, origem, saiu_em, cliente_id, registrado_por)
  SELECT DISTINCT p_empresa, v.tipo, v.valor, p_origem, p_saiu_em, p_cliente, p_por
    FROM clientes c
    CROSS JOIN LATERAL (VALUES ('TELEFONE', kidmais086_destino(c.whatsapp)), ('TELEFONE', kidmais086_destino(c.telefone)),
                               ('EMAIL', kidmais127_email(c.email))) v(tipo, valor)
   WHERE c.id = p_cliente AND c.empresa_id = p_empresa AND v.valor IS NOT NULL
  ON CONFLICT (empresa_id, tipo, valor) WHERE encerrada_em IS NULL DO NOTHING;
END $$;

-- (i) Descadastro (inserção ou atualização com descadastrado_em preenchido) grava as marcas; (iv) reativação
-- (descadastrado_em volta a NULL) encerra as marcas vivas dos contatos ATUAIS do cadastro — a pessoa pediu para voltar.
CREATE FUNCTION kidmais127_saida_por_preferencia() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.descadastrado_em IS NOT NULL THEN
    PERFORM kidmais127_marcar_cliente(NEW.empresa_id, NEW.cliente_id, NEW.descadastro_origem, NEW.descadastrado_em, NEW.atualizado_por);
  ELSIF TG_OP = 'UPDATE' AND OLD.descadastrado_em IS NOT NULL THEN
    UPDATE marketing_saidas_contato s
       SET encerrada_em = clock_timestamp(), encerrada_por = NEW.atualizado_por,
           motivo_encerramento = 'REATIVACAO: a pessoa pediu para voltar a receber (cliente ' || NEW.cliente_id::text || ').'
      FROM clientes c
     WHERE c.id = NEW.cliente_id AND c.empresa_id = NEW.empresa_id
       AND s.empresa_id = NEW.empresa_id AND s.encerrada_em IS NULL
       AND ((s.tipo = 'TELEFONE' AND s.valor IN (kidmais086_destino(c.whatsapp), kidmais086_destino(c.telefone)))
         OR (s.tipo = 'EMAIL' AND s.valor = kidmais127_email(c.email)))
       -- Contato compartilhado que ainda tem outro pedido de saída (outro cliente descadastrado ou "não contatar" no
       -- atendimento) continua marcado: a reativação de um cadastro não desfaz o pedido do outro.
       AND NOT EXISTS (
         SELECT 1 FROM marketing_contato_preferencias p2 JOIN clientes c2 ON c2.id = p2.cliente_id AND c2.empresa_id = p2.empresa_id
          WHERE p2.empresa_id = NEW.empresa_id AND p2.cliente_id <> NEW.cliente_id AND p2.descadastrado_em IS NOT NULL
            AND ((s.tipo = 'TELEFONE' AND s.valor IN (kidmais086_destino(c2.whatsapp), kidmais086_destino(c2.telefone)))
              OR (s.tipo = 'EMAIL' AND s.valor = kidmais127_email(c2.email))))
       AND NOT (s.tipo = 'TELEFONE' AND EXISTS (
         SELECT 1 FROM whatsapp_atendimento_conversas w
          WHERE w.empresa_id = NEW.empresa_id AND w.nao_contatar AND kidmais086_destino(w.contato) = s.valor));
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER marketing_saidas_por_preferencia AFTER INSERT OR UPDATE OF descadastrado_em ON marketing_contato_preferencias
  FOR EACH ROW EXECUTE FUNCTION kidmais127_saida_por_preferencia();

-- (ii) Cliente descadastrado que ganha contato novo (tela, importação, mescla ou SQL): o contato novo também fica marcado.
CREATE FUNCTION kidmais127_saida_contato_novo() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_catalog, pg_temp AS $$
DECLARE p record;
BEGIN
  SELECT descadastrado_em, descadastro_origem INTO p FROM marketing_contato_preferencias
   WHERE empresa_id = NEW.empresa_id AND cliente_id = NEW.id AND descadastrado_em IS NOT NULL;
  IF FOUND THEN
    PERFORM kidmais127_marcar_cliente(NEW.empresa_id, NEW.id, p.descadastro_origem, clock_timestamp(), NULL);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER marketing_saidas_contato_novo AFTER UPDATE OF whatsapp, telefone, email ON clientes
  FOR EACH ROW WHEN (OLD.whatsapp IS DISTINCT FROM NEW.whatsapp OR OLD.telefone IS DISTINCT FROM NEW.telefone
                     OR OLD.email IS DISTINCT FROM NEW.email)
  EXECUTE FUNCTION kidmais127_saida_contato_novo();

-- (iii) Conversa do atendimento que passa a nao_contatar: o número fica marcado (sem cliente; a conversa nem sempre tem).
CREATE FUNCTION kidmais127_saida_por_atendimento() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_catalog, pg_temp AS $$
DECLARE destino text := kidmais086_destino(NEW.contato);
BEGIN
  IF NEW.nao_contatar AND (TG_OP = 'INSERT' OR NOT OLD.nao_contatar) AND destino IS NOT NULL THEN
    INSERT INTO marketing_saidas_contato (empresa_id, tipo, valor, origem)
    VALUES (NEW.empresa_id, 'TELEFONE', destino, 'ATENDIMENTO_WHATSAPP')
    ON CONFLICT (empresa_id, tipo, valor) WHERE encerrada_em IS NULL DO NOTHING;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER marketing_saidas_por_atendimento AFTER INSERT OR UPDATE OF nao_contatar ON whatsapp_atendimento_conversas
  FOR EACH ROW EXECUTE FUNCTION kidmais127_saida_por_atendimento();

-- Carga inicial. Descadastros: contatos do cadastro de hoje, com a data e a origem do descadastro.
SELECT kidmais127_marcar_cliente(p.empresa_id, p.cliente_id, p.descadastro_origem, p.descadastrado_em, p.atualizado_por)
  FROM marketing_contato_preferencias p
 WHERE p.descadastrado_em IS NOT NULL
 ORDER BY p.descadastrado_em, p.cliente_id;

-- Atendimento: conversas e controles (082, se instalada) com nao_contatar; a data mais antiga de cada número.
DO $$
BEGIN
  INSERT INTO marketing_saidas_contato (empresa_id, tipo, valor, origem, saiu_em)
  SELECT DISTINCT ON (empresa_id, destino) empresa_id, 'TELEFONE', destino, 'ATENDIMENTO_WHATSAPP', desde
    FROM (SELECT empresa_id, kidmais086_destino(contato) AS destino, atualizada_em AS desde
            FROM whatsapp_atendimento_conversas WHERE nao_contatar) x
   WHERE destino IS NOT NULL
   ORDER BY empresa_id, destino, desde
  ON CONFLICT (empresa_id, tipo, valor) WHERE encerrada_em IS NULL DO NOTHING;
  IF to_regclass('public.whatsapp_atendimento_controles_contato') IS NOT NULL THEN
    INSERT INTO marketing_saidas_contato (empresa_id, tipo, valor, origem, saiu_em)
    SELECT DISTINCT ON (empresa_id, destino) empresa_id, 'TELEFONE', destino, 'ATENDIMENTO_WHATSAPP', desde
      FROM (SELECT empresa_id, kidmais086_destino(contato) AS destino, registrado_em AS desde
              FROM whatsapp_atendimento_controles_contato WHERE nao_contatar) x
     WHERE destino IS NOT NULL
     ORDER BY empresa_id, destino, desde
    ON CONFLICT (empresa_id, tipo, valor) WHERE encerrada_em IS NULL DO NOTHING;
  END IF;
END $$;

COMMIT;
