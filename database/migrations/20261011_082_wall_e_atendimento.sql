-- 082 — Wall-e: biblioteca com arquivos próprios (foto, vídeo e PDF), estados (rascunho, publicada, arquivada),
--       autorização de envio automático, finalidade e vínculos opcionais; várias respostas por mensagem recebida; fonte
--       da resposta; memória da conversa e resumo da passagem para a equipe.
--
-- NÃO APLICADA em banco persistente. Nesta entrega só em bancos descartáveis locais (autorização do GOAL Wall-e); staging
-- e produção exigem autorização própria (docs/OPERACAO_AGENTES.md). Exige a 060, a 080 e a 081; independe da 065.
--
-- Arquivos: guardados no próprio banco (bytea, hash conferido pelo banco), por empresa e ambiente, servidos por URL
-- pública com token aleatório (o provedor baixa a mídia sem sessão). D3 (privacidade): nunca apagados nem alterados,
-- EXCETO por (a) revogação — conteúdo apagado, link trocado, irreversível — e (b) troca do link ou da expiração; o
-- gatilho recusa todo o resto. Arquivo revogado, vencido (expira_em) ou de empresa não ATIVA não é servido.
-- D2 (privacidade): whatsapp_atendimento_privacidade registra exclusões de conversa e revogações sem conteúdo nem contato. Limites da aplicação: foto JPEG/PNG 5 MB,
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
  IF to_regclass('public.whatsapp_atendimento_arquivos') IS NOT NULL OR to_regclass('public.whatsapp_atendimento_privacidade') IS NOT NULL
     OR to_regclass('public.whatsapp_atendimento_controles_contato') IS NOT NULL
     OR to_regclass('public.whatsapp_atendimento_eventos_excluidos') IS NOT NULL
     OR to_regclass('public.whatsapp_atendimento_retencao_config') IS NOT NULL
     OR to_regclass('public.whatsapp_atendimento_retencao_execucoes') IS NOT NULL
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

-- Arquivos próprios da biblioteca (inserção; depois só revogação, troca de link ou de expiração — D3).
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
  expira_em timestamptz,
  token_trocado_em timestamptz,
  revogado_em timestamptz,
  revogado_por uuid REFERENCES usuarios_administrativos(id),
  CONSTRAINT whatsapp_arquivos_revogacao CHECK ((revogado_em IS NULL) = (revogado_por IS NULL) AND (revogado_em IS NULL OR octet_length(conteudo) = 0)),
  CONSTRAINT whatsapp_arquivos_expiracao CHECK (expira_em IS NULL OR expira_em > criado_em),
  CONSTRAINT whatsapp_arquivos_mime_por_tipo CHECK ((tipo = 'IMAGEM' AND mime IN ('image/jpeg', 'image/png'))
    OR (tipo = 'VIDEO' AND mime IN ('video/mp4', 'video/3gpp')) OR (tipo = 'DOCUMENTO' AND mime = 'application/pdf')),
  -- Tamanho e hash descrevem o arquivo recebido; depois da revogação o conteúdo fica vazio (metadados preservados).
  CONSTRAINT whatsapp_arquivos_tamanho CHECK ((revogado_em IS NOT NULL OR tamanho_bytes = octet_length(conteudo)) AND tamanho_bytes > 0
    AND tamanho_bytes <= CASE tipo WHEN 'IMAGEM' THEN 5242880 ELSE 16777216 END),
  CONSTRAINT whatsapp_arquivos_hash CHECK (revogado_em IS NOT NULL OR sha256 = encode(sha256(conteudo), 'hex')),
  CONSTRAINT whatsapp_arquivos_token_uk UNIQUE (token),
  CONSTRAINT whatsapp_arquivos_escopo_uk UNIQUE (id, empresa_id, ambiente, tipo)
);
CREATE INDEX whatsapp_arquivos_empresa ON whatsapp_atendimento_arquivos (empresa_id, ambiente, criado_em DESC);
CREATE FUNCTION kidmais082_arquivo_controle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'whatsapp_atendimento_arquivos não é apagado (arquivo %): revogue o arquivo.', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW.id, NEW.empresa_id, NEW.ambiente, NEW.tipo, NEW.mime, NEW.nome, NEW.tamanho_bytes, NEW.sha256, NEW.criado_por, NEW.criado_em)
     IS DISTINCT FROM (OLD.id, OLD.empresa_id, OLD.ambiente, OLD.tipo, OLD.mime, OLD.nome, OLD.tamanho_bytes, OLD.sha256, OLD.criado_por, OLD.criado_em) THEN
    RAISE EXCEPTION 'arquivo %: só revogação, troca de link ou de expiração.', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.revogado_em IS NOT NULL THEN
    RAISE EXCEPTION 'arquivo % revogado: não muda mais.', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.revogado_em IS NOT NULL THEN
    -- Revogação: conteúdo apagado e link trocado na mesma escrita (irreversível).
    IF octet_length(NEW.conteudo) <> 0 OR NEW.token = OLD.token THEN
      RAISE EXCEPTION 'arquivo %: a revogação apaga o conteúdo e troca o link.', OLD.id USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.conteudo IS DISTINCT FROM OLD.conteudo THEN
    RAISE EXCEPTION 'arquivo %: o conteúdo não muda (envie um arquivo novo).', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  -- Vencido (expira_em no passado): mudar a expiração (reativar) exige link novo na mesma escrita.
  IF OLD.expira_em IS NOT NULL AND OLD.expira_em <= clock_timestamp() AND NEW.expira_em IS DISTINCT FROM OLD.expira_em AND NEW.token = OLD.token THEN
    RAISE EXCEPTION 'arquivo %: reativar um arquivo vencido exige link novo.', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.token IS DISTINCT FROM OLD.token AND NEW.token_trocado_em IS NOT DISTINCT FROM OLD.token_trocado_em THEN
    RAISE EXCEPTION 'arquivo %: a troca de link registra token_trocado_em.', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER whatsapp_arquivos_controle BEFORE UPDATE OR DELETE ON whatsapp_atendimento_arquivos
  FOR EACH ROW EXECUTE FUNCTION kidmais082_arquivo_controle();

-- D2/D3: registro verificável de exclusões e revogações. SEM conteúdo e SEM contato (nem hash do número): só ids,
-- contagens, quem pediu e o prazo aplicado. conversa_id sem FK (a conversa excluída não existe mais).
CREATE TABLE whatsapp_atendimento_privacidade (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  ambiente text NOT NULL CHECK (ambiente IN ('staging', 'production')),
  acao text NOT NULL CHECK (acao IN ('CONVERSA_EXCLUIDA', 'ARQUIVO_REVOGADO', 'ARQUIVO_LINK_TROCADO', 'ARQUIVO_EXPIRACAO_DEFINIDA', 'ARQUIVO_REATIVADO', 'RETENCAO_CONFIGURADA')),
  origem text NOT NULL CHECK (origem IN ('PEDIDO', 'RETENCAO')),
  usuario_id uuid REFERENCES usuarios_administrativos(id),
  conversa_id uuid,
  arquivo_id uuid REFERENCES whatsapp_atendimento_arquivos(id),
  mensagens_removidas integer CHECK (mensagens_removidas >= 0),
  saidas_canceladas integer CHECK (saidas_canceladas >= 0),
  manteve_nao_contatar boolean,
  manteve_pausa boolean,
  manteve_equipe boolean,
  motivo text CHECK (motivo IN ('PEDIDO_DO_TITULAR', 'DECISAO_DA_EMPRESA')),
  prazo_dias integer CHECK (prazo_dias > 0),
  expira_em timestamptz,
  criada_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT whatsapp_privacidade_autor CHECK (origem <> 'PEDIDO' OR usuario_id IS NOT NULL),
  CONSTRAINT whatsapp_privacidade_alvo CHECK ((acao = 'CONVERSA_EXCLUIDA' AND conversa_id IS NOT NULL AND arquivo_id IS NULL AND mensagens_removidas IS NOT NULL
      AND manteve_nao_contatar IS NOT NULL AND manteve_pausa IS NOT NULL AND manteve_equipe IS NOT NULL)
    OR (acao LIKE 'ARQUIVO\_%' AND arquivo_id IS NOT NULL AND conversa_id IS NULL)
    OR (acao = 'RETENCAO_CONFIGURADA' AND arquivo_id IS NULL AND conversa_id IS NULL AND origem = 'PEDIDO')),
  CONSTRAINT whatsapp_privacidade_retencao CHECK (origem <> 'RETENCAO' OR (acao = 'CONVERSA_EXCLUIDA' AND prazo_dias IS NOT NULL)),
  CONSTRAINT whatsapp_privacidade_motivo CHECK (motivo IS NULL OR (acao = 'CONVERSA_EXCLUIDA' AND origem = 'PEDIDO'))
);
CREATE INDEX whatsapp_privacidade_empresa ON whatsapp_atendimento_privacidade (empresa_id, ambiente, criada_em DESC);

-- D2 (12/10): controles MÍNIMOS de um contato cuja conversa foi excluída, separados do conteúdo (nenhum texto, nome ou
-- data de festa): o número, a empresa e o que precisa continuar valendo — PARAR (nao_contatar), pausa pedida
-- (sem_automatico) e conversa que estava com a equipe (com_equipe). Uma conversa nova do mesmo número herda os
-- controles e a linha é consumida (o controle passa a viver na conversa nova). Tratamento futuro: decisão R2.
CREATE TABLE whatsapp_atendimento_controles_contato (
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  ambiente text NOT NULL CHECK (ambiente IN ('staging', 'production')),
  contato text NOT NULL CHECK (contato ~ '^[0-9]{8,15}$'),
  nao_contatar boolean NOT NULL DEFAULT false,
  sem_automatico boolean NOT NULL DEFAULT false,
  com_equipe boolean NOT NULL DEFAULT false,
  registrado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  atualizado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (empresa_id, ambiente, contato),
  CONSTRAINT whatsapp_controles_algum CHECK (nao_contatar OR sem_automatico OR com_equipe)
);
-- D2 (12/10): identificadores de eventos do provedor cujas mensagens foram excluídas, para uma reentrega não recriar o
-- conteúdo. Só o SHA-256 do id da mensagem no provedor (nunca texto, nome ou número), por empresa, ambiente e provedor.
-- Guardados por um prazo técnico fixo (RETENCAO_DEDUP_DIAS no código) e apagados pela rotina de retenção.
CREATE TABLE whatsapp_atendimento_eventos_excluidos (
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  ambiente text NOT NULL CHECK (ambiente IN ('staging', 'production')),
  provedor text NOT NULL CHECK (provedor IN ('GUPSHUP')),
  evento_sha256 text NOT NULL CHECK (evento_sha256 ~ '^[0-9a-f]{64}$'),
  excluido_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (empresa_id, ambiente, provedor, evento_sha256)
);
CREATE INDEX whatsapp_eventos_excluidos_prazo ON whatsapp_atendimento_eventos_excluidos (excluido_em);
-- D2 (12/10): retenção por empresa, decidida pela gestão da empresa (sem prazo padrão: sem linha ou prazo NULL = nada
-- é apagado automaticamente) e o registro de cada execução da rotina (sem conteúdo; só contagens e códigos de erro).
CREATE TABLE whatsapp_atendimento_retencao_config (
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  ambiente text NOT NULL CHECK (ambiente IN ('staging', 'production')),
  prazo_dias integer CHECK (prazo_dias BETWEEN 1 AND 3650),
  definido_por uuid NOT NULL REFERENCES usuarios_administrativos(id),
  definido_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (empresa_id, ambiente)
);
CREATE TABLE whatsapp_atendimento_retencao_execucoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ambiente text NOT NULL CHECK (ambiente IN ('staging', 'production')),
  iniciada_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  terminada_em timestamptz,
  estado text NOT NULL CHECK (estado IN ('EM_ANDAMENTO', 'CONCLUIDA', 'CONCLUIDA_COM_FALHAS', 'FALHOU')),
  empresas integer NOT NULL DEFAULT 0 CHECK (empresas >= 0),
  excluidas integer NOT NULL DEFAULT 0 CHECK (excluidas >= 0),
  adiadas integer NOT NULL DEFAULT 0 CHECK (adiadas >= 0),
  falhas integer NOT NULL DEFAULT 0 CHECK (falhas >= 0),
  pendentes_removidas integer NOT NULL DEFAULT 0 CHECK (pendentes_removidas >= 0),
  dedup_removidos integer NOT NULL DEFAULT 0 CHECK (dedup_removidos >= 0),
  erros text[] NOT NULL DEFAULT '{}' CHECK (array_length(erros, 1) IS NULL OR array_length(erros, 1) <= 20),
  CONSTRAINT whatsapp_retencao_fim CHECK ((estado = 'EM_ANDAMENTO') = (terminada_em IS NULL))
);
CREATE INDEX whatsapp_retencao_execucoes_recentes ON whatsapp_atendimento_retencao_execucoes (ambiente, iniciada_em DESC);

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
  ADD COLUMN fonte jsonb CONSTRAINT whatsapp_mensagens_fonte CHECK (jsonb_typeof(fonte) = 'object'),
  -- D3 (12/10): por que uma saída foi cancelada sem sair (o operador vê; nunca cancelamento silencioso).
  ADD COLUMN motivo_cancelamento text CONSTRAINT whatsapp_mensagens_motivo_cancelamento CHECK (motivo_cancelamento IN ('ARQUIVO_INDISPONIVEL', 'ARQUIVO_REVOGADO'));
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
  'Arquivos da biblioteca do atendimento (foto, vídeo, PDF), por empresa e ambiente; servidos por URL com token; só revogação (apaga o conteúdo) ou troca de link/expiração depois de inseridos.';
COMMENT ON TABLE whatsapp_atendimento_privacidade IS
  'Registro de exclusões de conversa (pedido ou retenção) e de revogações/trocas de link de arquivo; sem conteúdo nem contato.';
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
