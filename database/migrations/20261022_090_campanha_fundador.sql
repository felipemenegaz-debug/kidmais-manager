-- 090 — Campanha Fundador em duas fases (janela de 30 dias sem teto + lote posterior de 20 vagas).
-- LOCAL, preparada em 22/10/2026 (docs/PLANO_PLANO_CPF_E_FUNDADOR.md). NÃO aplicada em staging/produção. Exige 074a e 075.
-- Ordem: código compatível publicado ANTES (sem a 090 o código mantém a regra antiga de 20 vagas) → conferência → autorização
-- → aplicação → postcheck. A migration NÃO cria nem ativa campanha e NÃO grava data de abertura: a campanha nasce RASCUNHO
-- por operação própria e só vira ATIVA com data, contagem, regra de elegibilidade, validade da oferta e autorização.
-- Preserva: ids, documentos, vagas, estados, datas, pagamentos e benefícios de assinatura_fundadores (todas as linhas viram
-- LEGADO) e as guardas 068/074a/075 (a 074a não é editada; esta migration acrescenta uma guarda e troca índice/CHECK de vaga).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;

DO $$ BEGIN
  IF to_regclass('public.assinatura_fundadores') IS NULL OR to_regclass('public.assinatura_contratacoes') IS NULL
     OR to_regclass('public.assinatura_renovacoes') IS NULL OR to_regclass('public.usuarios_administrativos') IS NULL
     OR to_regprocedure('public.kidmais_074_registro_guarda()') IS NULL THEN
    RAISE EXCEPTION '090 exige 074a e 075 instaladas.';
  END IF;
  IF to_regclass('public.assinatura_campanhas') IS NOT NULL
     OR to_regprocedure('public.kidmais_090_campanha_guarda()') IS NOT NULL
     OR to_regprocedure('public.kidmais_090_fundador_guarda()') IS NOT NULL
     OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'assinatura_fundadores'
                AND column_name IN ('campanha_id','origem','regra_versao','oferta_valida_ate')) THEN
    RAISE EXCEPTION '090 já aplicada total ou parcialmente.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.assinatura_fundadores'::regclass
                 AND conname = 'assinatura_fundadores_vaga_check' AND contype = 'c')
     OR to_regclass('public.assinatura_fundadores_vaga_uk') IS NULL THEN
    RAISE EXCEPTION '090: CHECK ou índice de vaga da 074a divergiu da base revisada.';
  END IF;
END $$;
-- Mesma ordem dos caminhos de contratação: empresa → assinatura → campanha → reserva → contratação.
LOCK TABLE assinatura_fundadores IN ACCESS EXCLUSIVE MODE;

-- Fonte persistida da campanha. Datas e regra ficam aqui (não em env); env só liga/desliga a leitura no código.
CREATE TABLE assinatura_campanhas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo text NOT NULL UNIQUE CHECK (codigo ~ '^[a-z0-9][a-z0-9-]{2,59}$'),
  versao_regra text NOT NULL CHECK (char_length(btrim(versao_regra)) BETWEEN 3 AND 80),
  estado text NOT NULL DEFAULT 'RASCUNHO' CHECK (estado IN ('RASCUNHO','ATIVA','ENCERRADA')),
  fuso text NOT NULL DEFAULT 'America/Sao_Paulo' CHECK (fuso = 'America/Sao_Paulo'),
  -- Decisões de Felipe em 22/10/2026 (obrigatórias para ativar; sem valor padrão):
  --   D1 assinar = oferta aceita e persistida pelo servidor; D3 validade de 7 dias corridos da aceitação.
  --   D2 calendário de Brasília (CALENDARIO_LOCAL). HORARIO_EXATO existe só para ensaio sintético de fronteira em banco
  --   descartável; a ativação real usa ativarCampanhaAprovada (lib/assinatura/campanha.ts), que fixa CALENDARIO_LOCAL.
  contagem text CHECK (contagem IN ('CALENDARIO_LOCAL','HORARIO_EXATO')),
  elegibilidade text CHECK (elegibilidade = 'OFERTA_PERSISTIDA'),
  validade_oferta interval CHECK (validade_oferta = interval '7 days'),
  abertura_data date,
  inicio timestamptz,
  janela_fim timestamptz,
  janela_dias smallint NOT NULL DEFAULT 30 CHECK (janela_dias = 30),
  vagas_pos_janela smallint NOT NULL DEFAULT 20 CHECK (vagas_pos_janela = 20),
  desconto_percentual smallint NOT NULL DEFAULT 40 CHECK (desconto_percentual = 40),
  beneficio_meses smallint NOT NULL DEFAULT 12 CHECK (beneficio_meses = 12),
  autorizacao text CHECK (autorizacao IS NULL OR char_length(btrim(autorizacao)) BETWEEN 10 AND 500),
  ativada_por uuid REFERENCES usuarios_administrativos(id),
  ativada_em timestamptz,
  encerrada_em timestamptz,
  motivo_encerramento text CHECK (motivo_encerramento IS NULL OR char_length(btrim(motivo_encerramento)) BETWEEN 5 AND 500),
  criada_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT assinatura_campanhas_ativacao_check CHECK (
    estado = 'RASCUNHO' AND ativada_em IS NULL AND encerrada_em IS NULL
    OR estado IN ('ATIVA','ENCERRADA') AND contagem IS NOT NULL AND elegibilidade IS NOT NULL AND validade_oferta IS NOT NULL
       AND inicio IS NOT NULL AND janela_fim IS NOT NULL AND janela_fim > inicio
       AND (contagem = 'HORARIO_EXATO' OR abertura_data IS NOT NULL)
       AND autorizacao IS NOT NULL AND ativada_por IS NOT NULL AND ativada_em IS NOT NULL
       AND (estado = 'ATIVA') = (encerrada_em IS NULL AND motivo_encerramento IS NULL)
       AND (estado <> 'ENCERRADA' OR motivo_encerramento IS NOT NULL))
);
-- No máximo uma campanha ativa por vez.
CREATE UNIQUE INDEX assinatura_campanhas_ativa_uk ON assinatura_campanhas ((true)) WHERE estado = 'ATIVA';

ALTER TABLE assinatura_fundadores
  ADD COLUMN campanha_id uuid REFERENCES assinatura_campanhas(id),
  ADD COLUMN origem text NOT NULL DEFAULT 'LEGADO' CHECK (origem IN ('LEGADO','JANELA','POS_JANELA')),
  ADD COLUMN regra_versao text,
  ADD COLUMN oferta_valida_ate timestamptz;
-- O padrão só serve ao backfill das linhas existentes: toda inserção nova declara a origem.
ALTER TABLE assinatura_fundadores ALTER COLUMN origem DROP DEFAULT;
ALTER TABLE assinatura_fundadores
  ALTER COLUMN vaga DROP NOT NULL,
  DROP CONSTRAINT assinatura_fundadores_vaga_check,
  ADD CONSTRAINT assinatura_fundadores_vaga_check CHECK (
    origem = 'JANELA' AND vaga IS NULL
    OR origem IN ('LEGADO','POS_JANELA') AND vaga IS NOT NULL AND vaga BETWEEN 1 AND 20),
  ADD CONSTRAINT assinatura_fundadores_campanha_check CHECK (
    origem = 'LEGADO' AND campanha_id IS NULL AND regra_versao IS NULL AND oferta_valida_ate IS NULL
    OR origem IN ('JANELA','POS_JANELA') AND campanha_id IS NOT NULL AND regra_versao IS NOT NULL
       AND oferta_valida_ate IS NOT NULL AND oferta_valida_ate > reservada_em);
-- Vaga legada mantém o número antigo; lote posterior numera 1–20 dentro da campanha. Janela não ocupa vaga.
DROP INDEX assinatura_fundadores_vaga_uk;
CREATE UNIQUE INDEX assinatura_fundadores_vaga_legado_uk ON assinatura_fundadores(vaga)
  WHERE origem = 'LEGADO' AND estado <> 'LIBERADA';
CREATE UNIQUE INDEX assinatura_fundadores_vaga_pos_uk ON assinatura_fundadores(campanha_id, vaga)
  WHERE origem = 'POS_JANELA' AND estado <> 'LIBERADA';
CREATE INDEX assinatura_fundadores_campanha_idx ON assinatura_fundadores(campanha_id, origem, estado) WHERE campanha_id IS NOT NULL;

-- Campanha: rascunho editável; ativação com decisões completas e datas calculadas no banco; depois, imutável.
CREATE FUNCTION kidmais_090_campanha_guarda() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN RAISE EXCEPTION '090: campanhas não são apagadas.' USING ERRCODE = 'P0001'; END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.estado <> 'RASCUNHO' THEN RAISE EXCEPTION '090: campanha ativada ou encerrada não é apagada.' USING ERRCODE = 'P0001'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.estado <> 'RASCUNHO' THEN RAISE EXCEPTION '090: campanha nasce em RASCUNHO.' USING ERRCODE = 'P0001'; END IF;
    NEW.criada_em := clock_timestamp();
    NEW.inicio := NULL; NEW.janela_fim := NULL; NEW.ativada_em := NULL; NEW.ativada_por := NULL;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.criada_em <> OLD.criada_em THEN RAISE EXCEPTION '090: identidade da campanha é imutável.' USING ERRCODE = 'P0001'; END IF;
  IF OLD.estado = 'RASCUNHO' AND NEW.estado = 'RASCUNHO' THEN
    NEW.inicio := NULL; NEW.janela_fim := NULL; NEW.ativada_em := NULL; NEW.ativada_por := NULL;
    RETURN NEW;
  END IF;
  IF OLD.estado = 'RASCUNHO' AND NEW.estado = 'ATIVA' THEN
    -- Mesma trava da alocação: uma reserva LEGADO em andamento termina antes (ou enxerga a ativação depois). Só a
    -- ativação a toma; o encerramento não (a concessão segura a campanha ATIVA com FOR SHARE).
    PERFORM pg_advisory_xact_lock(hashtext('kidmais:fundadores:2026'));
    -- Datas sempre derivadas da regra aprovada; o chamador não informa o fim da janela.
    IF NEW.contagem = 'CALENDARIO_LOCAL' THEN
      IF NEW.abertura_data IS NULL THEN RAISE EXCEPTION '090: data de abertura obrigatória.' USING ERRCODE = 'P0001'; END IF;
      -- Sem ativação retroativa: a janela de 30 dias não pode nascer encurtada.
      IF NEW.abertura_data < (clock_timestamp() AT TIME ZONE NEW.fuso)::date THEN
        RAISE EXCEPTION '090: data de abertura no passado.' USING ERRCODE = 'P0001';
      END IF;
      NEW.inicio := (NEW.abertura_data::timestamp) AT TIME ZONE NEW.fuso;
      NEW.janela_fim := ((NEW.abertura_data + NEW.janela_dias)::timestamp) AT TIME ZONE NEW.fuso;
    ELSIF NEW.contagem = 'HORARIO_EXATO' THEN
      -- Só para ensaio sintético de fronteira (D2 decidiu calendário); o início pode estar no passado.
      IF NEW.inicio IS NULL THEN RAISE EXCEPTION '090: horário de abertura obrigatório.' USING ERRCODE = 'P0001'; END IF;
      NEW.abertura_data := (NEW.inicio AT TIME ZONE NEW.fuso)::date;
      NEW.janela_fim := NEW.inicio + make_interval(hours => 24 * NEW.janela_dias);
    ELSE
      RAISE EXCEPTION '090: contagem da janela não decidida.' USING ERRCODE = 'P0001';
    END IF;
    NEW.ativada_em := clock_timestamp();
    IF NEW.janela_fim <= NEW.ativada_em THEN RAISE EXCEPTION '090: janela já terminaria antes da ativação.' USING ERRCODE = 'P0001'; END IF;
    IF EXISTS (SELECT 1 FROM public.assinatura_campanhas WHERE id <> NEW.id AND estado <> 'RASCUNHO') THEN
      RAISE EXCEPTION '090: já existe campanha ativada; nova campanha exige decisão e migration próprias.' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.estado = 'ATIVA' AND NEW.estado = 'ENCERRADA' THEN
    IF ROW(NEW.codigo,NEW.versao_regra,NEW.fuso,NEW.contagem,NEW.elegibilidade,NEW.validade_oferta,NEW.abertura_data,NEW.inicio,NEW.janela_fim,
           NEW.janela_dias,NEW.vagas_pos_janela,NEW.desconto_percentual,NEW.beneficio_meses,NEW.autorizacao,NEW.ativada_por,NEW.ativada_em)
       IS DISTINCT FROM ROW(OLD.codigo,OLD.versao_regra,OLD.fuso,OLD.contagem,OLD.elegibilidade,OLD.validade_oferta,OLD.abertura_data,OLD.inicio,OLD.janela_fim,
           OLD.janela_dias,OLD.vagas_pos_janela,OLD.desconto_percentual,OLD.beneficio_meses,OLD.autorizacao,OLD.ativada_por,OLD.ativada_em) THEN
      RAISE EXCEPTION '090: condições da campanha ativada são imutáveis.' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.motivo_encerramento IS NULL OR char_length(btrim(NEW.motivo_encerramento)) < 5 THEN
      RAISE EXCEPTION '090: encerramento exige motivo.' USING ERRCODE = 'P0001';
    END IF;
    NEW.encerrada_em := clock_timestamp();
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '090: campanha ativada é imutável (transição %→%).', OLD.estado, NEW.estado USING ERRCODE = 'P0001';
END $$;
CREATE TRIGGER assinatura_campanhas_090_guarda BEFORE INSERT OR UPDATE OR DELETE ON assinatura_campanhas FOR EACH ROW EXECUTE FUNCTION kidmais_090_campanha_guarda();
CREATE TRIGGER assinatura_campanhas_090_truncate BEFORE TRUNCATE ON assinatura_campanhas FOR EACH STATEMENT EXECUTE FUNCTION kidmais_090_campanha_guarda();

-- Concessão: roda depois da guarda 074a (ordem alfabética dos gatilhos), que já travou a empresa. Fase, teto e datas são
-- decididos aqui com o relógio do banco lido DEPOIS das travas; o índice único continua como última defesa.
CREATE FUNCTION kidmais_090_fundador_guarda() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE c public.assinatura_campanhas%ROWTYPE; agora timestamptz; ocupadas integer;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.campanha_id,NEW.origem,NEW.regra_versao,NEW.oferta_valida_ate)
       IS DISTINCT FROM ROW(OLD.campanha_id,OLD.origem,OLD.regra_versao,OLD.oferta_valida_ate) THEN
      RAISE EXCEPTION '090: origem e campanha da concessão Fundador são imutáveis.' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.origem IS NULL THEN RAISE EXCEPTION '090: origem da concessão obrigatória.' USING ERRCODE = 'P0001'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('kidmais:fundadores:2026'));
  IF NEW.origem = 'LEGADO' THEN
    -- Regra antiga (20 primeiros) só enquanto nenhuma campanha nova foi ativada.
    IF EXISTS (SELECT 1 FROM public.assinatura_campanhas WHERE estado <> 'RASCUNHO') THEN
      RAISE EXCEPTION '090: campanha nova já ativada; concessão legada encerrada.' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO c FROM public.assinatura_campanhas WHERE id = NEW.campanha_id FOR SHARE;
  IF NOT FOUND OR c.estado <> 'ATIVA' THEN RAISE EXCEPTION '090: campanha não está ativa.' USING ERRCODE = 'P0001'; END IF;
  IF c.elegibilidade <> 'OFERTA_PERSISTIDA' THEN
    RAISE EXCEPTION '090: regra de elegibilidade sem implementação aprovada.' USING ERRCODE = 'P0001';
  END IF;
  agora := clock_timestamp();
  IF agora < c.inicio THEN RAISE EXCEPTION '090: campanha ainda não começou.' USING ERRCODE = 'P0001'; END IF;
  IF NEW.origem = 'JANELA' AND agora >= c.janela_fim THEN
    RAISE EXCEPTION '090: janela da campanha encerrada.' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.origem = 'POS_JANELA' THEN
    IF agora < c.janela_fim THEN RAISE EXCEPTION '090: lote posterior só depois da janela.' USING ERRCODE = 'P0001'; END IF;
    IF NEW.vaga > c.vagas_pos_janela THEN RAISE EXCEPTION '090: vaga fora do lote posterior.' USING ERRCODE = 'P0001'; END IF;
    SELECT count(*) INTO ocupadas FROM public.assinatura_fundadores
      WHERE campanha_id = c.id AND origem = 'POS_JANELA' AND estado <> 'LIBERADA';
    IF ocupadas >= c.vagas_pos_janela THEN RAISE EXCEPTION '090: vagas do lote posterior esgotadas.' USING ERRCODE = 'P0001'; END IF;
  END IF;
  NEW.regra_versao := c.versao_regra;
  NEW.reservada_em := agora;
  NEW.oferta_valida_ate := agora + c.validade_oferta;
  RETURN NEW;
END $$;
CREATE TRIGGER assinatura_fundadores_090_campanha BEFORE INSERT OR UPDATE ON assinatura_fundadores FOR EACH ROW EXECUTE FUNCTION kidmais_090_fundador_guarda();

COMMENT ON TABLE assinatura_campanhas IS '090: campanha Fundador versionada (janela de 30 dias + lote posterior de 20). Configuração da plataforma, sem dado de cliente.';
COMMENT ON COLUMN assinatura_fundadores.origem IS '090: LEGADO (regra dos 20 primeiros, anterior à campanha), JANELA (sem vaga numerada) ou POS_JANELA (vagas 1–20 da campanha).';
COMMIT;
