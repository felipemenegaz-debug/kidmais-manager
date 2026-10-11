-- 082 — Wall-e: biblioteca com arquivos próprios (foto, vídeo e PDF), estados (rascunho, publicada, arquivada),
--       autorização de envio automático, finalidade e vínculos opcionais; várias respostas por mensagem recebida; fonte
--       da resposta; memória da conversa e resumo da passagem para a equipe.
--
-- NÃO APLICADA em banco persistente. Nesta entrega só em bancos descartáveis locais (autorização do GOAL Wall-e); staging
-- e produção exigem autorização própria (docs/OPERACAO_AGENTES.md). Exige a 060, a 080 e a 081; independe da 065.
--
-- Arquivos: guardados no próprio banco (bytea, só inserção, hash conferido pelo banco), por empresa e ambiente, servidos
-- por URL pública com token aleatório (o provedor baixa a mídia sem sessão). Limites da aplicação: foto JPEG/PNG 5 MB,
-- vídeo MP4/3GPP 16 MB, PDF 16 MB (o provedor aceita até 100 MB; ver docs/WALL_E_ATENDIMENTO.md).
--
-- Mensagem pronta:
--   estado      RASCUNHO | PUBLICADA | ARQUIVADA (ativa = estado <> ARQUIVADA, mantida para os índices da 080);
--   envio_automatico  o Wall-e só envia sozinho conteúdo PUBLICADO com esta autorização (o serviço confere o estado);
--   finalidade  PRECOS | LOCALIZACAO | PACOTES | CARDAPIO | DECORACAO | CONTRATO | GERAL;
--   pacote_codigo (estável entre revisões do pacote) e estabelecimento_id (unidade), opcionais;
--   arquivo_id  arquivo próprio (alternativa à URL externa da 081). PDF só por arquivo próprio.
-- Mensagem: `origem_grupo_id` + `ordem` permitem várias saídas da mesma entrada (texto + PDF + link) sem duplicar em
--   retry; a unicidade da 060 em `origem_id` continua (só a primeira saída o preenche). `fonte` registra a origem e a
--   versão dos dados usados (interno).
-- Conversa: `contexto` (memória do Wall-e) e `passagem` (resumo para a equipe).
--
-- Compatível com os postchecks da 060, 080 e 081: as restrições redefinidas (tipo, mídia por tipo, legenda, par de
-- mídia) mantêm os NOMES da 081 e só ampliam as listas; nenhuma restrição da 060/080 é removida. Aditiva: as linhas
-- existentes continuam válidas (prontas atuais viram PUBLICADA ou ARQUIVADA conforme `ativa`). Com a 082 aplicada, o
-- down da 081 recusa por guarda explícita (a FK do arquivo NÃO bastava: o DROP COLUMN a derrubaria junto): desfazer
-- a 082 antes. Ordem: 082 → 081 → 080 → 065 → 060.
-- Postcheck: database/checks/20261011_082_postcheck.sql. Rollback: database/rollback/20261011_082_wall_e_atendimento_down.sql.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$ BEGIN
  IF to_regclass('public.whatsapp_atendimento_mensagens_prontas') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.whatsapp_atendimento_mensagens'::regclass AND attname = 'midia_pronta_id' AND NOT attisdropped) THEN
    RAISE EXCEPTION '082 exige a 060, a 080 e a 081.';
  END IF;
  IF to_regclass('public.whatsapp_atendimento_arquivos') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_attribute WHERE NOT attisdropped AND (
          (attrelid = 'public.whatsapp_atendimento_mensagens_prontas'::regclass AND attname IN ('estado', 'envio_automatico', 'finalidade', 'pacote_codigo', 'estabelecimento_id', 'arquivo_id'))
       OR (attrelid = 'public.whatsapp_atendimento_mensagens'::regclass AND attname IN ('ordem', 'origem_grupo_id', 'midia_arquivo_id', 'midia_nome', 'fonte'))
       OR (attrelid = 'public.whatsapp_atendimento_conversas'::regclass AND attname IN ('contexto', 'passagem')))) THEN
    RAISE EXCEPTION '082 já aplicada (total ou parcialmente).';
  END IF;
  -- Restrições redefinidas: exatamente como a 081 as criou.
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.whatsapp_atendimento_mensagens_prontas'::regclass AND conname = 'whatsapp_prontas_tipo')
        IS DISTINCT FROM 'CHECK ((tipo = ANY (ARRAY[''TEXTO''::text, ''LINK''::text, ''LINK_FECHAMENTO_INDIVIDUAL''::text, ''IMAGEM''::text, ''VIDEO''::text])))'
     OR (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.whatsapp_atendimento_mensagens'::regclass AND conname = 'whatsapp_mensagens_midia_tipo')
        IS DISTINCT FROM 'CHECK ((midia_tipo = ANY (ARRAY[''IMAGEM''::text, ''VIDEO''::text])))'
     OR (SELECT count(*) FROM pg_constraint WHERE conname IN ('whatsapp_prontas_midia_por_tipo', 'whatsapp_prontas_legenda_limite', 'whatsapp_mensagens_midia_par', 'whatsapp_mensagens_legenda_limite')) <> 4 THEN
    RAISE EXCEPTION '082 recusada: restrições da 081 divergem do esperado.';
  END IF;
END $$;

-- Arquivos próprios da biblioteca (só inserção).
CREATE TABLE whatsapp_atendimento_arquivos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  ambiente text NOT NULL CHECK (ambiente IN ('staging', 'production')),
  tipo text NOT NULL CHECK (tipo IN ('IMAGEM', 'VIDEO', 'DOCUMENTO')),
  mime text NOT NULL,
  nome text NOT NULL CHECK (char_length(nome) BETWEEN 5 AND 240 AND nome !~ '[/\\[:cntrl:]]'),
  tamanho_bytes integer NOT NULL,
  sha256 text NOT NULL,
  conteudo bytea NOT NULL,
  token text NOT NULL CHECK (token ~ '^[A-Za-z0-9_-]{43}$'),
  criado_por uuid NOT NULL REFERENCES usuarios_administrativos(id),
  criado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT whatsapp_arquivos_mime_por_tipo CHECK ((tipo = 'IMAGEM' AND mime IN ('image/jpeg', 'image/png'))
    OR (tipo = 'VIDEO' AND mime IN ('video/mp4', 'video/3gpp')) OR (tipo = 'DOCUMENTO' AND mime = 'application/pdf')),
  CONSTRAINT whatsapp_arquivos_tamanho CHECK (tamanho_bytes = octet_length(conteudo) AND tamanho_bytes > 0
    AND tamanho_bytes <= CASE tipo WHEN 'IMAGEM' THEN 5242880 ELSE 16777216 END),
  CONSTRAINT whatsapp_arquivos_hash CHECK (sha256 = encode(sha256(conteudo), 'hex')),
  CONSTRAINT whatsapp_arquivos_token_uk UNIQUE (token),
  CONSTRAINT whatsapp_arquivos_escopo_uk UNIQUE (id, empresa_id, ambiente, tipo)
);
CREATE INDEX whatsapp_arquivos_empresa ON whatsapp_atendimento_arquivos (empresa_id, ambiente, criado_em DESC);
CREATE FUNCTION kidmais082_arquivo_imutavel() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'whatsapp_atendimento_arquivos é só inserção (arquivo % não pode ser alterado nem apagado).', OLD.id
    USING ERRCODE = 'restrict_violation';
END $$;
CREATE TRIGGER whatsapp_arquivos_imutavel BEFORE UPDATE OR DELETE ON whatsapp_atendimento_arquivos
  FOR EACH ROW EXECUTE FUNCTION kidmais082_arquivo_imutavel();

-- Mensagens prontas.
ALTER TABLE whatsapp_atendimento_mensagens_prontas
  ADD COLUMN estado text NOT NULL DEFAULT 'PUBLICADA',
  ADD COLUMN envio_automatico boolean NOT NULL DEFAULT false,
  ADD COLUMN finalidade text,
  ADD COLUMN pacote_codigo text,
  ADD COLUMN estabelecimento_id uuid,
  ADD COLUMN arquivo_id uuid;
UPDATE whatsapp_atendimento_mensagens_prontas SET estado = CASE WHEN ativa THEN 'PUBLICADA' ELSE 'ARQUIVADA' END;
ALTER TABLE whatsapp_atendimento_mensagens_prontas
  DROP CONSTRAINT whatsapp_prontas_tipo,
  DROP CONSTRAINT whatsapp_prontas_midia_por_tipo,
  DROP CONSTRAINT whatsapp_prontas_legenda_limite,
  ADD CONSTRAINT whatsapp_prontas_tipo CHECK (tipo IN ('TEXTO', 'LINK', 'LINK_FECHAMENTO_INDIVIDUAL', 'IMAGEM', 'VIDEO', 'DOCUMENTO')),
  -- Mídia: URL externa (081) OU arquivo próprio, nunca os dois; PDF só por arquivo próprio.
  ADD CONSTRAINT whatsapp_prontas_midia_por_tipo CHECK ((tipo IN ('IMAGEM', 'VIDEO', 'DOCUMENTO')) = (midia_url IS NOT NULL OR arquivo_id IS NOT NULL)
    AND NOT (midia_url IS NOT NULL AND arquivo_id IS NOT NULL) AND (tipo <> 'DOCUMENTO' OR arquivo_id IS NOT NULL)),
  ADD CONSTRAINT whatsapp_prontas_legenda_limite CHECK (tipo NOT IN ('IMAGEM', 'VIDEO', 'DOCUMENTO') OR length(texto) <= 1024),
  ADD CONSTRAINT whatsapp_prontas_estado CHECK (estado IN ('RASCUNHO', 'PUBLICADA', 'ARQUIVADA')),
  ADD CONSTRAINT whatsapp_prontas_estado_ativa CHECK (ativa = (estado <> 'ARQUIVADA')),
  ADD CONSTRAINT whatsapp_prontas_finalidade CHECK (finalidade IN ('PRECOS', 'LOCALIZACAO', 'PACOTES', 'CARDAPIO', 'DECORACAO', 'CONTRATO', 'GERAL')),
  ADD CONSTRAINT whatsapp_prontas_automatico_finalidade CHECK (NOT envio_automatico OR finalidade IS NOT NULL),
  ADD CONSTRAINT whatsapp_prontas_pacote_codigo CHECK (pacote_codigo ~ '^[A-Za-z0-9_-]{1,60}$'),
  ADD CONSTRAINT whatsapp_prontas_estabelecimento FOREIGN KEY (empresa_id, estabelecimento_id) REFERENCES estabelecimentos (empresa_id, id),
  -- O arquivo é da mesma empresa e ambiente E do mesmo tipo da mensagem pronta.
  ADD CONSTRAINT whatsapp_prontas_arquivo FOREIGN KEY (arquivo_id, empresa_id, ambiente, tipo)
    REFERENCES whatsapp_atendimento_arquivos (id, empresa_id, ambiente, tipo);
CREATE INDEX whatsapp_prontas_automaticas ON whatsapp_atendimento_mensagens_prontas (empresa_id, ambiente, finalidade)
  WHERE estado = 'PUBLICADA' AND envio_automatico;

-- Mensagens.
ALTER TABLE whatsapp_atendimento_mensagens
  ADD COLUMN origem_grupo_id uuid,
  ADD COLUMN ordem smallint NOT NULL DEFAULT 0 CONSTRAINT whatsapp_mensagens_ordem CHECK (ordem BETWEEN 0 AND 9),
  ADD COLUMN midia_arquivo_id uuid,
  ADD COLUMN midia_nome text CONSTRAINT whatsapp_mensagens_midia_nome CHECK (char_length(midia_nome) BETWEEN 5 AND 240),
  ADD COLUMN fonte jsonb CONSTRAINT whatsapp_mensagens_fonte CHECK (jsonb_typeof(fonte) = 'object');
ALTER TABLE whatsapp_atendimento_mensagens
  ADD CONSTRAINT whatsapp_mensagens_origem_grupo_uk UNIQUE (origem_grupo_id, ordem),
  ADD CONSTRAINT whatsapp_mensagens_origem_grupo FOREIGN KEY (origem_grupo_id) REFERENCES whatsapp_atendimento_mensagens (id),
  DROP CONSTRAINT whatsapp_mensagens_midia_tipo,
  DROP CONSTRAINT whatsapp_mensagens_midia_par,
  DROP CONSTRAINT whatsapp_mensagens_legenda_limite,
  ADD CONSTRAINT whatsapp_mensagens_midia_tipo CHECK (midia_tipo IN ('IMAGEM', 'VIDEO', 'DOCUMENTO')),
  -- Mídia por URL externa OU por arquivo próprio (nunca os dois); documento sempre por arquivo e com nome.
  ADD CONSTRAINT whatsapp_mensagens_midia_par CHECK ((midia_tipo IS NULL) = (midia_url IS NULL AND midia_arquivo_id IS NULL)
    AND NOT (midia_url IS NOT NULL AND midia_arquivo_id IS NOT NULL)
    AND (midia_tipo IS DISTINCT FROM 'DOCUMENTO' OR (midia_arquivo_id IS NOT NULL AND midia_nome IS NOT NULL))),
  ADD CONSTRAINT whatsapp_mensagens_legenda_limite CHECK (midia_tipo IS NULL OR texto IS NULL OR length(texto) <= 1024),
  ADD CONSTRAINT whatsapp_mensagens_midia_arquivo FOREIGN KEY (midia_arquivo_id, empresa_id, ambiente, midia_tipo)
    REFERENCES whatsapp_atendimento_arquivos (id, empresa_id, ambiente, tipo);

-- Conversas.
ALTER TABLE whatsapp_atendimento_conversas
  ADD COLUMN contexto jsonb NOT NULL DEFAULT '{}'::jsonb CONSTRAINT whatsapp_conversas_contexto CHECK (jsonb_typeof(contexto) = 'object'),
  ADD COLUMN passagem jsonb CONSTRAINT whatsapp_conversas_passagem CHECK (jsonb_typeof(passagem) = 'object');

COMMENT ON TABLE whatsapp_atendimento_arquivos IS
  'Arquivos da biblioteca do atendimento (foto, vídeo, PDF), por empresa e ambiente; só inserção; servidos por URL com token.';
COMMENT ON COLUMN whatsapp_atendimento_mensagens_prontas.envio_automatico IS
  'O Wall-e só envia sozinho conteúdo PUBLICADO com esta autorização; rascunho e arquivado nunca saem automaticamente.';
COMMENT ON COLUMN whatsapp_atendimento_mensagens.origem_grupo_id IS
  'Mensagem recebida que originou esta saída (várias saídas por entrada, ordenadas por `ordem`); único com `ordem`.';
COMMENT ON COLUMN whatsapp_atendimento_mensagens.fonte IS
  'Origem e versão dos dados usados na resposta (pronta, pacote, tabela de preço, agenda, modelo de contrato). Interno.';
COMMENT ON COLUMN whatsapp_atendimento_conversas.contexto IS
  'Memória do Wall-e na conversa: dados coletados (data, horário, convidados, pacote, unidade, tema), materiais enviados e pendências.';
COMMENT ON COLUMN whatsapp_atendimento_conversas.passagem IS
  'Resumo para a equipe na passagem: motivo, dados coletados, materiais enviados e perguntas pendentes.';

COMMIT;
