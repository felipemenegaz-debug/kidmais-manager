-- 135: consumo mensal de mensagens do atendimento WhatsApp pela Cloud API (melhoria 3b, D-LAN-3, LOCAL 23/11/2026).
-- Desde 01/10/2026 a Meta cobra a resposta de serviço acima de 1.000 por mês por número, no cartão da conta do WhatsApp
-- (WABA) do buffet. O Wall-e para num teto configurável; para isso o worker RESERVA o grupo inteiro de saídas (texto + PDF)
-- nesta tabela, na MESMA transação que grava as saídas:
--   INSERT ... ON CONFLICT (empresa_id, ambiente, mes) DO UPDATE SET usadas = usadas + k WHERE usadas + k <= limite
-- A trava da linha serializa duas conversas da mesma empresa: nenhuma reserva passa do teto (Astra r1, P1).
-- Agregado sem dados pessoais (só empresa, ambiente, mês e um número) e sem ligação com conversas ou mensagens: excluir
-- uma conversa (privacidade, retenção) não devolve cota já gasta (Astra r1, P1). Mês no fuso de São Paulo ('AAAA-MM').
-- A contagem é uma ESTIMATIVA conservadora: reserva na criação da saída; falha ou cancelamento depois não devolve.
-- Carga inicial: as saídas do mês corrente que contam (nem CANCELADA nem FALHOU), para o teto valer desde a aplicação.
-- Transição sem janela (Astra r3 e r4, P1): o código novo vai ANTES desta migration (sem a 135 ele não tem teto nem reserva).
-- PORTÃO DE DEPLOY (Astra r4, P1): só aplicar com o deploy novo LIVE no web E no worker e SEM gravador antigo vivo (instância
-- anterior encerrada depois do prazo de desligamento, sem requisição nem job em andamento). Um INSERT do código antigo que
-- ficasse atrás do LOCK seguiria depois da carga sem reservar. Quem aplica declara isso na MESMA sessão, antes da 135:
--   SET kidmais.portao_135 = 'deploy-novo-live-sem-gravador-antigo';
-- Sem a declaração a 135 recusa e nada muda. Procedimento de conferência no vault (nota da 3b, "Portão de deploy da 135").
-- A migration trava as gravações de mensagens (LOCK ... IN SHARE MODE, até o COMMIT) antes da carga: gravação já
-- começada termina antes e entra na carga; gravação seguinte espera o COMMIT e, já vendo a 135, reserva pelo código novo.
-- Nada fica de fora nem conta duas vezes, sem reparo depois. Leituras não esperam. Com lock_timeout de 5s, uma gravação
-- longa faz a migration falhar sem efeito (repetir). O início do mês é fixado uma vez na carga (Astra r3, P3).
-- A carga conta também as saídas da piloto; sem efeito: a piloto fica fora do teto em qualquer canal (recorte de 23/11).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;

DO $$
BEGIN
  IF current_setting('kidmais.portao_135', true) IS DISTINCT FROM 'deploy-novo-live-sem-gravador-antigo' THEN
    RAISE EXCEPTION '135: portão de deploy não declarado (SET kidmais.portao_135 = ''deploy-novo-live-sem-gravador-antigo'' só com o deploy novo LIVE e nenhum gravador antigo vivo)';
  END IF;
END $$;

LOCK TABLE public.whatsapp_atendimento_mensagens IN SHARE MODE;

CREATE TABLE public.whatsapp_atendimento_consumo_mensal (
  empresa_id uuid NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  ambiente text NOT NULL CHECK (ambiente IN ('staging','production')),
  mes text NOT NULL CHECK (mes ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  usadas integer NOT NULL DEFAULT 0 CHECK (usadas >= 0),
  atualizado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (empresa_id, ambiente, mes)
);
COMMENT ON TABLE public.whatsapp_atendimento_consumo_mensal IS
  '3b (135): mensagens do atendimento pela Cloud API por empresa, ambiente e mês de São Paulo; reserva atômica do teto do Wall-e. Sem dados pessoais.';

WITH inicio AS (SELECT date_trunc('month', clock_timestamp() AT TIME ZONE 'America/Sao_Paulo') AS mes_sp)
INSERT INTO public.whatsapp_atendimento_consumo_mensal (empresa_id, ambiente, mes, usadas)
SELECT m.empresa_id, m.ambiente, to_char(i.mes_sp, 'YYYY-MM'), count(*)::int
FROM public.whatsapp_atendimento_mensagens m CROSS JOIN inicio i
WHERE m.direcao = 'SAIDA' AND m.estado NOT IN ('CANCELADA','FALHOU')
  AND m.criada_em >= (i.mes_sp AT TIME ZONE 'America/Sao_Paulo')
GROUP BY 1, 2, 3;

COMMIT;
