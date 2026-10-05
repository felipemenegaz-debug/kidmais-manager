-- 064 — Atendimento WhatsApp: biblioteca de mensagens prontas da equipe (fase A: texto e links) e favoritas por usuário.
--
-- NÃO APLICADA. Exige autorização explícita (docs/OPERACAO_AGENTES.md) para qualquer banco, inclusive staging,
-- clones e o cluster descartável. Depende da 060 (não a altera). Sem esta migration a tela de Atendimento continua
-- funcionando; só a biblioteca responde "indisponível".
--
--   whatsapp_atendimento_mensagens_prontas            mensagens da EQUIPE por (empresa, ambiente). Não são fontes da IA
--                                                    (respostas publicadas ficam em whatsapp_atendimento_config) nem
--                                                    automações: o atendente escolhe, revisa e envia pela ação "enviar".
--   whatsapp_atendimento_mensagens_prontas_favoritas favoritas por usuário, sempre na mesma empresa/ambiente da mensagem.
--
-- Tipos: TEXTO; LINK (https fixo, validado também no serviço); LINK_FECHAMENTO_INDIVIDUAL (sem link gravado: resolvido
-- na hora do rascunho pelo fluxo autorizado de contratação, com vínculo inequívoco empresa → conversa → cliente).
-- Atalhos ("Tabela de preços", "Disponibilidade / fechamento"): no máximo uma mensagem ATIVA por atalho e empresa.
-- Remoção é lógica (ativa = false): o histórico das conversas não depende destas linhas.
BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$ BEGIN
  IF to_regclass('public.whatsapp_atendimento_conversas') IS NULL OR to_regclass('public.empresas') IS NULL
     OR to_regclass('public.usuarios_administrativos') IS NULL THEN
    RAISE EXCEPTION '064 exige a 060 (atendimento WhatsApp), empresas e usuarios_administrativos.';
  END IF;
  IF to_regclass('public.whatsapp_atendimento_mensagens_prontas') IS NOT NULL
     OR to_regclass('public.whatsapp_atendimento_mensagens_prontas_favoritas') IS NOT NULL THEN
    RAISE EXCEPTION '064 já aplicada (total ou parcialmente).';
  END IF;
END $$;

CREATE TABLE whatsapp_atendimento_mensagens_prontas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  ambiente text NOT NULL CHECK (ambiente IN ('staging','production')),
  titulo text NOT NULL CHECK (titulo = btrim(titulo) AND length(titulo) BETWEEN 2 AND 80),
  categoria text NOT NULL CHECK (categoria = btrim(categoria) AND length(categoria) BETWEEN 2 AND 40),
  tipo text NOT NULL CHECK (tipo IN ('TEXTO','LINK','LINK_FECHAMENTO_INDIVIDUAL')),
  texto text NOT NULL CHECK (length(btrim(texto)) BETWEEN 1 AND 4000),
  link text CHECK (link ~ '^https://[^[:space:]]+$' AND length(link) <= 2048),
  atalho text CHECK (atalho IN ('TABELA_PRECOS','DISPONIBILIDADE_FECHAMENTO')),
  ativa boolean NOT NULL DEFAULT true,
  versao bigint NOT NULL DEFAULT 0 CHECK (versao >= 0),
  criada_por uuid NOT NULL REFERENCES usuarios_administrativos(id),
  atualizada_por uuid NOT NULL REFERENCES usuarios_administrativos(id),
  criada_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  atualizada_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- Link gravado só no tipo LINK; o individual nunca é gravado (vem do fluxo autorizado).
  CONSTRAINT whatsapp_prontas_link_por_tipo CHECK ((tipo = 'LINK') = (link IS NOT NULL)),
  CONSTRAINT whatsapp_prontas_rascunho_limite CHECK (length(texto) + COALESCE(length(link) + 2, 0) <= 4000),
  UNIQUE (id, empresa_id, ambiente)
);
CREATE UNIQUE INDEX whatsapp_prontas_atalho_unico ON whatsapp_atendimento_mensagens_prontas (empresa_id, ambiente, atalho) WHERE atalho IS NOT NULL AND ativa;
CREATE UNIQUE INDEX whatsapp_prontas_titulo_unico ON whatsapp_atendimento_mensagens_prontas (empresa_id, ambiente, lower(titulo)) WHERE ativa;
CREATE INDEX whatsapp_prontas_lista ON whatsapp_atendimento_mensagens_prontas (empresa_id, ambiente, categoria, titulo) WHERE ativa;

CREATE TABLE whatsapp_atendimento_mensagens_prontas_favoritas (
  usuario_id uuid NOT NULL REFERENCES usuarios_administrativos(id),
  mensagem_pronta_id uuid NOT NULL,
  empresa_id uuid NOT NULL,
  ambiente text NOT NULL CHECK (ambiente IN ('staging','production')),
  criada_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (usuario_id, mensagem_pronta_id),
  -- A favorita carrega (empresa, ambiente) da mensagem: não referencia mensagem de outra empresa.
  FOREIGN KEY (mensagem_pronta_id, empresa_id, ambiente) REFERENCES whatsapp_atendimento_mensagens_prontas(id, empresa_id, ambiente)
);
CREATE INDEX whatsapp_prontas_favoritas_usuario ON whatsapp_atendimento_mensagens_prontas_favoritas (usuario_id, empresa_id, ambiente);

COMMIT;
