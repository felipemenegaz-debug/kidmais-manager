-- 096 — Comprovante da contratação e arquivo das versões dos documentos legais (grupo B do parecer de apoio, 22/10/2026).
-- LOCAL, preparada em 22/10/2026 (docs/CPF_FUNDADOR_IMPLEMENTACAO_20261022.md, décima segunda rodada). NÃO aplicada em
-- staging/produção. Exige 069 e 074a. Ordem: código compatível publicado ANTES (sem a 096 a contratação segue sem
-- comprovante persistido) → conferência → autorização → aplicação → postcheck.
-- O que muda:
--  - documentos_legais_versoes: texto canônico integral de cada versão publicada dos Termos, do Aviso e do Acordo, com o
--    SHA-256 conferido pelo próprio banco; imutável (versões antigas continuam recuperáveis depois de novas versões);
--  - assinatura_comprovantes: um comprovante por oferta confirmada pelo contratante (instante, contratante mascarado,
--    condições e versões aceitas); imutável, exceto o registro único do envio ou da falha da cópia por e-mail.
-- O que NÃO muda: nenhuma linha existente é alterada; aceites da 069 e ofertas da 074a ficam como estão.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;

DO $$ BEGIN
  IF to_regclass('public.assinatura_contratacoes') IS NULL OR to_regclass('public.usuarios_administrativos') IS NULL
     OR to_regclass('public.aceites_documentos_legais') IS NULL THEN
    RAISE EXCEPTION '096 exige 069 e 074a instaladas.';
  END IF;
  IF to_regclass('public.documentos_legais_versoes') IS NOT NULL OR to_regclass('public.assinatura_comprovantes') IS NOT NULL
     OR to_regprocedure('public.kidmais_096_guarda()') IS NOT NULL THEN
    RAISE EXCEPTION '096 já aplicada total ou parcialmente.';
  END IF;
END $$;

CREATE TABLE documentos_legais_versoes (
  documento text NOT NULL CHECK (documento IN ('TERMOS_USO','PRIVACIDADE','DPA')),
  versao text NOT NULL CHECK (versao ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}(-[a-z0-9]+)?$'),
  hash text NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$'),
  conteudo text NOT NULL,
  registrado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (documento, versao),
  CONSTRAINT documentos_legais_versoes_conteudo_hash_check CHECK (encode(sha256(convert_to(conteudo, 'UTF8')), 'hex') = hash)
);

CREATE TABLE assinatura_comprovantes (
  contratacao_id uuid PRIMARY KEY,
  empresa_id uuid NOT NULL,
  usuario_id uuid NOT NULL REFERENCES usuarios_administrativos(id),
  registrado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  contratante jsonb NOT NULL CHECK (jsonb_typeof(contratante) = 'object'),
  condicoes jsonb NOT NULL CHECK (jsonb_typeof(condicoes) = 'object'),
  termos_versao text NOT NULL,
  privacidade_versao text NOT NULL,
  dpa_versao text NOT NULL,
  email_enviado_em timestamptz,
  email_falhou_em timestamptz,
  CONSTRAINT assinatura_comprovantes_contratacao_fk FOREIGN KEY (empresa_id, contratacao_id) REFERENCES assinatura_contratacoes(empresa_id, id),
  CONSTRAINT assinatura_comprovantes_envio_check CHECK (email_enviado_em IS NULL OR email_falhou_em IS NULL)
);
CREATE INDEX assinatura_comprovantes_empresa_idx ON assinatura_comprovantes (empresa_id, registrado_em DESC);

-- Versões: só inserção. Comprovante: inserção com as três versões arquivadas; atualização só para registrar UMA vez o
-- envio ou a falha da cópia por e-mail; sem DELETE.
CREATE FUNCTION kidmais_096_guarda() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '096: registro de documento ou comprovante não é apagado.' USING ERRCODE = 'P0001';
  END IF;
  IF TG_TABLE_NAME = 'documentos_legais_versoes' THEN
    IF TG_OP = 'UPDATE' THEN
      RAISE EXCEPTION '096: versão publicada de documento é imutável.' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.contratacao_id, NEW.empresa_id, NEW.usuario_id, NEW.registrado_em, NEW.contratante, NEW.condicoes, NEW.termos_versao, NEW.privacidade_versao, NEW.dpa_versao)
         IS DISTINCT FROM (OLD.contratacao_id, OLD.empresa_id, OLD.usuario_id, OLD.registrado_em, OLD.contratante, OLD.condicoes, OLD.termos_versao, OLD.privacidade_versao, OLD.dpa_versao)
       OR OLD.email_enviado_em IS NOT NULL OR OLD.email_falhou_em IS NOT NULL THEN
      RAISE EXCEPTION '096: comprovante é imutável; só o envio da cópia por e-mail é registrado, uma vez.' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF (SELECT count(*) FROM public.documentos_legais_versoes v
       WHERE (v.documento, v.versao) IN (('TERMOS_USO', NEW.termos_versao), ('PRIVACIDADE', NEW.privacidade_versao), ('DPA', NEW.dpa_versao))) <> 3 THEN
    RAISE EXCEPTION '096: versões do comprovante não arquivadas.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER documentos_legais_versoes_096_guarda BEFORE INSERT OR UPDATE OR DELETE ON documentos_legais_versoes
  FOR EACH ROW EXECUTE FUNCTION kidmais_096_guarda();
CREATE TRIGGER assinatura_comprovantes_096_guarda BEFORE INSERT OR UPDATE OR DELETE ON assinatura_comprovantes
  FOR EACH ROW EXECUTE FUNCTION kidmais_096_guarda();

COMMENT ON TABLE documentos_legais_versoes IS '096: texto canônico integral de cada versão publicada (Termos, Aviso, Acordo), hash conferido pelo banco; imutável.';
COMMENT ON TABLE assinatura_comprovantes IS '096: comprovante da contratação (oferta confirmada): instante, contratante mascarado, condições e versões aceitas.';
COMMIT;
