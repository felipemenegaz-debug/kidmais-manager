-- 060 — Atendimento WhatsApp (piloto Gupshup): configuração, conversas, mensagens, status do provedor e auditoria.
--
-- NÃO APLICADA. Exige autorização explícita (docs/OPERACAO_AGENTES.md) para qualquer banco, inclusive staging,
-- clones e o cluster descartável. Sem esta migration o webhook continua só registrando metadados (flag
-- WHATSAPP_ATENDIMENTO_RECEIVE_ENABLED desligada) e a tela de atendimento responde "indisponível".
--
--   whatsapp_atendimento_config     uma configuração por (empresa, ambiente); respostas publicadas pelo representante.
--   whatsapp_atendimento_conversas  uma conversa por (empresa, ambiente, contato); `versao` invalida trabalho antigo.
--   whatsapp_atendimento_mensagens  entradas e saídas; `externa_id` deduplica eventos do provedor por empresa/ambiente;
--                                   `origem_id` garante no máximo uma resposta automática por entrada.
--   whatsapp_atendimento_status     status recebidos do provedor ANTES ou DEPOIS do retorno do envio (correlação).
--                                   Status correlacionado é apagado na hora; sem mensagem correspondente (ex.: OTP do
--                                   mesmo app) expira em 24 h por `recebido_em` (lib/whatsapp/atendimento/service.ts).
--   whatsapp_atendimento_auditoria  ações humanas (assumir, retomar, encerrar, enviar, configurar).
-- Toda referência a conversa carrega (empresa, ambiente): uma linha de outra empresa não pode ser referenciada.
-- Escrita só pelos serviços de lib/whatsapp/atendimento; a IA classifica, nunca escreve aqui diretamente.
BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$ BEGIN
  IF to_regclass('public.empresas') IS NULL OR to_regclass('public.usuarios_administrativos') IS NULL OR to_regclass('public.memberships') IS NULL THEN
    RAISE EXCEPTION '060 exige empresas, usuarios_administrativos e memberships.';
  END IF;
  IF to_regclass('public.whatsapp_atendimento_config') IS NOT NULL OR to_regclass('public.whatsapp_atendimento_conversas') IS NOT NULL
     OR to_regclass('public.whatsapp_atendimento_mensagens') IS NOT NULL OR to_regclass('public.whatsapp_atendimento_status') IS NOT NULL
     OR to_regclass('public.whatsapp_atendimento_auditoria') IS NOT NULL THEN
    RAISE EXCEPTION '060 já aplicada (total ou parcialmente).';
  END IF;
END $$;

CREATE TABLE whatsapp_atendimento_config (
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  ambiente text NOT NULL CHECK (ambiente IN ('staging','production')),
  configuracao jsonb NOT NULL CHECK (jsonb_typeof(configuracao) = 'object'),
  atualizada_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (empresa_id, ambiente)
);

CREATE TABLE whatsapp_atendimento_conversas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  ambiente text NOT NULL CHECK (ambiente IN ('staging','production')),
  contato text NOT NULL CHECK (contato ~ '^[0-9]{8,15}$'),
  estado text NOT NULL DEFAULT 'IA' CHECK (estado IN ('IA','AGUARDANDO_HUMANO','HUMANO','ENCERRADA')),
  responsavel_id uuid REFERENCES usuarios_administrativos(id),
  nao_contatar boolean NOT NULL DEFAULT false,
  interesse jsonb NOT NULL DEFAULT '{"data":null,"convidados":null}' CHECK (jsonb_typeof(interesse) = 'object'),
  versao bigint NOT NULL DEFAULT 0 CHECK (versao >= 0),
  ultima_entrada_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  atualizada_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (estado <> 'HUMANO' OR responsavel_id IS NOT NULL),
  UNIQUE (empresa_id, ambiente, contato),
  UNIQUE (id, empresa_id, ambiente)
);
CREATE INDEX whatsapp_atendimento_conversas_lista ON whatsapp_atendimento_conversas (empresa_id, ambiente, atualizada_em DESC);

CREATE TABLE whatsapp_atendimento_mensagens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversa_id uuid NOT NULL,
  empresa_id uuid NOT NULL,
  ambiente text NOT NULL CHECK (ambiente IN ('staging','production')),
  externa_id text CHECK (length(externa_id) BETWEEN 1 AND 512),
  origem_id uuid UNIQUE REFERENCES whatsapp_atendimento_mensagens(id),
  autor_usuario_id uuid REFERENCES usuarios_administrativos(id),
  direcao text NOT NULL CHECK (direcao IN ('ENTRADA','SAIDA')),
  texto text CHECK (length(texto) <= 4000),
  estado text NOT NULL CHECK (estado IN ('PENDENTE','PROCESSANDO','PROCESSADA','CANCELADA','ENVIANDO','SUBMETIDA','ENTREGUE','FALHOU','INCERTO')),
  provedor_id text CHECK (length(provedor_id) BETWEEN 1 AND 512),
  versao_conversa bigint NOT NULL,
  criada_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  iniciada_em timestamptz,
  FOREIGN KEY (conversa_id, empresa_id, ambiente) REFERENCES whatsapp_atendimento_conversas(id, empresa_id, ambiente),
  CHECK (direcao = 'SAIDA' OR (externa_id IS NOT NULL AND autor_usuario_id IS NULL AND origem_id IS NULL)),
  CHECK (direcao = 'ENTRADA' OR externa_id IS NULL),
  UNIQUE (empresa_id, ambiente, externa_id)
);
CREATE INDEX whatsapp_atendimento_fila ON whatsapp_atendimento_mensagens (empresa_id, ambiente, criada_em) WHERE estado = 'PENDENTE';
CREATE INDEX whatsapp_atendimento_ativas ON whatsapp_atendimento_mensagens (conversa_id) WHERE estado IN ('PROCESSANDO','ENVIANDO');
CREATE INDEX whatsapp_atendimento_historico ON whatsapp_atendimento_mensagens (conversa_id, criada_em);
CREATE INDEX whatsapp_atendimento_provedor ON whatsapp_atendimento_mensagens (empresa_id, ambiente, provedor_id) WHERE provedor_id IS NOT NULL;

CREATE TABLE whatsapp_atendimento_status (
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  ambiente text NOT NULL CHECK (ambiente IN ('staging','production')),
  provedor_id text NOT NULL CHECK (length(provedor_id) BETWEEN 1 AND 512),
  estado text NOT NULL CHECK (estado IN ('ENTREGUE','FALHOU')),
  recebido_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (empresa_id, ambiente, provedor_id)
);
CREATE INDEX whatsapp_atendimento_status_expiracao ON whatsapp_atendimento_status (empresa_id, ambiente, recebido_em);

CREATE TABLE whatsapp_atendimento_auditoria (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  ambiente text NOT NULL CHECK (ambiente IN ('staging','production')),
  usuario_id uuid NOT NULL REFERENCES usuarios_administrativos(id),
  acao text NOT NULL CHECK (acao IN ('assumir','retomar','encerrar','enviar','CONFIGURACAO_ATUALIZADA')),
  conversa_id uuid,
  criada_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (conversa_id, empresa_id, ambiente) REFERENCES whatsapp_atendimento_conversas(id, empresa_id, ambiente)
);
CREATE INDEX whatsapp_atendimento_auditoria_empresa ON whatsapp_atendimento_auditoria (empresa_id, ambiente, criada_em);

COMMIT;
