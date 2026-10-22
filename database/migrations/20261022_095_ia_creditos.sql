-- 095: créditos de IA (Convites e Wall-e) com carteiras separadas, lotes, extrato imutável, reservas, compra avulsa,
-- devolução, cortesia e corte do motor legado. Implementação LOCAL de 22/10/2026 (docs/PACOTES_CREDITOS_IA_20261022.md),
-- a partir da PROPOSTA docs/PLANO_PACOTES_CREDITOS.md: preços, franquias, validade e cortesias continuam propostas, não
-- decisões comerciais; o schema só guarda o que o código versionado e as flags permitirem.
-- Executar somente após autorização própria do ambiente, precheck e backup operacional. Aditiva: só cria tabelas, índices,
-- funções e gatilhos novos; não altera linha, coluna nem gatilho existente (convite_carteiras/convite_consumos ficam como
-- estão e continuam valendo para toda empresa sem corte registrado aqui).
-- ORDEM (como a 088/089): o CÓDIGO é publicado primeiro, já com o aplicador e estes SQL na árvore implantada; depois a 095
-- é aplicada por scripts/migration-095-{staging,production}.cjs (blocos de scripts/bloco-shell-095.cjs). Sem a 095, o código
-- mantém os fluxos antigos e recusa os novos com 503 tratado; com ela aplicada e as flags CREDITOS_* desligadas (padrão),
-- nenhuma oferta, cobrança, concessão ou consumo novo acontece.
-- Invariantes (constraints + gatilhos; a reconciliação recalcula de forma independente):
--   * quantidades inteiras (Convites: gerações; Wall-e: µUS$); dinheiro em centavos inteiros; nada negativo;
--   * carteira: reservado + bloqueado <= saldo; lote: disponível+reservado+bloqueado+consumido+expirado+cancelado = quantidade;
--   * extrato (ia_credito_lancamentos) só recebe INSERT: UPDATE, DELETE e TRUNCATE são recusados (correção = compensação);
--   * toda referência entre tabelas do domínio carrega empresa_id (chaves compostas): lote/pedido de outra empresa é recusado;
--   * nenhum registro financeiro (pedido, cobrança, devolução, lote, corte, cortesia) é apagado pela aplicação.
-- Sem prompts, imagens, conteúdo de conversa, nome, telefone, documento ou payload do Asaas.
-- Rollback: database/rollback/20261022_095_ia_creditos_down.sql (recusado se houver qualquer registro).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;
DO $$
BEGIN
  IF to_regclass('public.empresas') IS NULL OR to_regclass('public.usuarios_administrativos') IS NULL
    OR to_regclass('public.convite_carteiras') IS NULL OR to_regclass('public.convite_geracoes') IS NULL
    OR to_regclass('public.cobranca_eventos') IS NULL OR to_regclass('public.empresa_assinaturas') IS NULL
    OR to_regclass('public.ia_credito_carteiras') IS NOT NULL OR to_regclass('public.ia_credito_lancamentos') IS NOT NULL
    OR to_regprocedure('public.kidmais_095_guarda()') IS NOT NULL THEN
    RAISE EXCEPTION '095: precheck falhou (empresas/usuarios/073/084/068 ausentes ou 095 anterior/parcial); nada alterado';
  END IF;
END $$;

-- Carteira por empresa e recurso (projeção materializada, atualizada na mesma transação de cada lançamento).
-- CONVITES só existe depois do corte do motor legado (corte_em): enquanto não houver linha aqui, a empresa continua no
-- motor antigo (convite_carteiras/convite_consumos); com a linha, só este motor autoriza débito (nunca os dois).
CREATE TABLE ia_credito_carteiras (
  empresa_id uuid NOT NULL REFERENCES empresas(id),
  recurso text NOT NULL CHECK (recurso IN ('CONVITES', 'WALLE')),
  saldo bigint NOT NULL DEFAULT 0,
  reservado bigint NOT NULL DEFAULT 0,
  bloqueado bigint NOT NULL DEFAULT 0,
  corte_em timestamptz,
  criada_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  atualizada_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (empresa_id, recurso),
  CONSTRAINT ia_credito_carteiras_valores_check CHECK (saldo >= 0 AND reservado >= 0 AND bloqueado >= 0 AND reservado + bloqueado <= saldo
    AND saldo <= 1000000000000000),
  CONSTRAINT ia_credito_carteiras_corte_check CHECK (recurso <> 'CONVITES' OR corte_em IS NOT NULL)
);

-- Pedido de compra avulsa (fotografia imutável da oferta, dos termos e do valor calculados no servidor).
CREATE TABLE ia_credito_pedidos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas(id),
  protocolo text NOT NULL UNIQUE CHECK (protocolo ~ '^KM-[0-9]{8}-[0-9A-HJKMNP-TV-Z]{8}$'),
  recurso text NOT NULL CHECK (recurso IN ('CONVITES', 'WALLE')),
  catalogo_versao text NOT NULL CHECK (catalogo_versao ~ '^[A-Z0-9-]{3,60}$'),
  oferta_codigo text NOT NULL CHECK (oferta_codigo ~ '^[A-Z0-9_]{3,40}$'),
  oferta jsonb NOT NULL CHECK (jsonb_typeof(oferta) = 'object' AND pg_column_size(oferta) <= 4096),
  termos_versao text NOT NULL CHECK (termos_versao ~ '^[A-Za-z0-9._-]{3,60}$'),
  termos_sha256 text NOT NULL CHECK (termos_sha256 ~ '^[0-9a-f]{64}$'),
  quantidade bigint NOT NULL CHECK (quantidade > 0 AND quantidade <= 1000000000000),
  preco_centavos bigint NOT NULL CHECK (preco_centavos > 0 AND preco_centavos <= 10000000),
  validade_dias smallint NOT NULL CHECK (validade_dias BETWEEN 1 AND 1100),
  forma text NOT NULL CHECK (forma IN ('PIX', 'CARTAO', 'BOLETO')),
  ambiente text NOT NULL CHECK (ambiente IN ('sandbox', 'producao')),
  chave_idempotencia uuid NOT NULL,
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  estado text NOT NULL CHECK (estado IN ('CRIACAO_EM_CURSO', 'CRIACAO_INCERTA', 'FALHOU_CRIACAO', 'AGUARDANDO_PAGAMENTO', 'VENCIDO',
    'CREDITADO', 'REVISAO', 'ENCERRADO')),
  revisao_motivo text CHECK (revisao_motivo IS NULL OR revisao_motivo ~ '^[A-Z0-9_]{1,60}$'),
  solicitado_por uuid NOT NULL REFERENCES usuarios_administrativos(id),
  criado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  vencimento_pagamento date NOT NULL,
  creditado_em timestamptz,
  atualizado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT ia_credito_pedidos_empresa_uk UNIQUE (id, empresa_id),
  CONSTRAINT ia_credito_pedidos_idempotencia_uk UNIQUE (empresa_id, chave_idempotencia),
  CONSTRAINT ia_credito_pedidos_creditado_check CHECK ((estado = 'CREDITADO') = (creditado_em IS NOT NULL)),
  CONSTRAINT ia_credito_pedidos_revisao_check CHECK ((estado = 'REVISAO') = (revisao_motivo IS NOT NULL))
);
CREATE INDEX ia_credito_pedidos_empresa_idx ON ia_credito_pedidos (empresa_id, criado_em DESC);
CREATE INDEX ia_credito_pedidos_abertos_idx ON ia_credito_pedidos (criado_em)
  WHERE estado IN ('CRIACAO_EM_CURSO', 'CRIACAO_INCERTA', 'AGUARDANDO_PAGAMENTO', 'VENCIDO', 'REVISAO');

-- Lote de crédito: origem, quantidade, preço pago (compra) e vencimento. A oferta original é imutável; só os contadores
-- mudam (sempre somando a quantidade) e o vencimento só pode ser PRORROGADO.
CREATE TABLE ia_credito_lotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL,
  recurso text NOT NULL,
  origem text NOT NULL CHECK (origem IN ('FRANQUIA', 'COMPRA', 'CORTESIA', 'LEGADO')),
  chave_origem text NOT NULL CHECK (chave_origem ~ '^[A-Z]+:[A-Za-z0-9:._-]{1,120}$'),
  quantidade bigint NOT NULL CHECK (quantidade > 0 AND quantidade <= 1000000000000),
  disponivel bigint NOT NULL,
  reservado bigint NOT NULL DEFAULT 0,
  bloqueado bigint NOT NULL DEFAULT 0,
  consumido bigint NOT NULL DEFAULT 0,
  expirado bigint NOT NULL DEFAULT 0,
  cancelado bigint NOT NULL DEFAULT 0,
  preco_centavos bigint CHECK (preco_centavos IS NULL OR preco_centavos > 0),
  pedido_id uuid,
  ciclo date,
  liberado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  vence_em timestamptz NOT NULL,
  FOREIGN KEY (empresa_id, recurso) REFERENCES ia_credito_carteiras(empresa_id, recurso),
  FOREIGN KEY (pedido_id, empresa_id) REFERENCES ia_credito_pedidos(id, empresa_id),
  CONSTRAINT ia_credito_lotes_empresa_uk UNIQUE (id, empresa_id),
  CONSTRAINT ia_credito_lotes_recurso_uk UNIQUE (id, empresa_id, recurso),
  CONSTRAINT ia_credito_lotes_origem_uk UNIQUE (empresa_id, recurso, chave_origem),
  CONSTRAINT ia_credito_lotes_valores_check CHECK (disponivel >= 0 AND reservado >= 0 AND bloqueado >= 0 AND consumido >= 0 AND expirado >= 0
    AND cancelado >= 0 AND disponivel + reservado + bloqueado + consumido + expirado + cancelado = quantidade),
  CONSTRAINT ia_credito_lotes_compra_check CHECK ((origem = 'COMPRA') = (pedido_id IS NOT NULL) AND (origem = 'COMPRA') = (preco_centavos IS NOT NULL)),
  CONSTRAINT ia_credito_lotes_ciclo_check CHECK (origem <> 'FRANQUIA' OR ciclo IS NOT NULL),
  CONSTRAINT ia_credito_lotes_vencimento_check CHECK (vence_em > liberado_em)
);
CREATE UNIQUE INDEX ia_credito_lotes_pedido_uk ON ia_credito_lotes (pedido_id) WHERE pedido_id IS NOT NULL;
-- Ordem de consumo: menor vencimento primeiro (franquia/cortesia antes no empate; a ordem final fica no código).
CREATE INDEX ia_credito_lotes_consumo_idx ON ia_credito_lotes (empresa_id, recurso, vence_em, id) WHERE disponivel > 0 OR reservado > 0;

-- Extrato (fonte de verdade): uma linha por movimento e por lote, com as variações aplicadas à carteira.
CREATE TABLE ia_credito_lancamentos (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  empresa_id uuid NOT NULL,
  recurso text NOT NULL,
  lote_id uuid NOT NULL,
  tipo text NOT NULL CHECK (tipo IN ('CREDITO', 'RESERVA', 'LIBERACAO', 'CONSUMO', 'BLOQUEIO', 'DESBLOQUEIO', 'EXPIRACAO', 'REVERSAO')),
  quantidade bigint NOT NULL CHECK (quantidade > 0),
  delta_saldo bigint NOT NULL,
  delta_reservado bigint NOT NULL,
  delta_bloqueado bigint NOT NULL,
  operacao text NOT NULL CHECK (operacao ~ '^[A-Z_]+:[A-Za-z0-9:._-]{1,160}$'),
  protocolo text CHECK (protocolo IS NULL OR protocolo ~ '^KM-[0-9]{8}-[0-9A-HJKMNP-TV-Z]{8}$'),
  ator text NOT NULL CHECK (ator IN ('GESTAO', 'EQUIPE', 'CLIENTE', 'SISTEMA', 'PLATAFORMA')),
  criado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (lote_id, empresa_id, recurso) REFERENCES ia_credito_lotes(id, empresa_id, recurso),
  CONSTRAINT ia_credito_lancamentos_operacao_uk UNIQUE (empresa_id, recurso, operacao, tipo, lote_id),
  CONSTRAINT ia_credito_lancamentos_deltas_check CHECK (
       (tipo = 'CREDITO'     AND delta_saldo = quantidade  AND delta_reservado = 0           AND delta_bloqueado = 0)
    OR (tipo = 'RESERVA'     AND delta_saldo = 0           AND delta_reservado = quantidade  AND delta_bloqueado = 0)
    OR (tipo = 'LIBERACAO'   AND delta_saldo = 0           AND delta_reservado = -quantidade AND delta_bloqueado = 0)
    OR (tipo = 'CONSUMO'     AND delta_saldo = -quantidade AND delta_reservado = -quantidade AND delta_bloqueado = 0)
    OR (tipo = 'BLOQUEIO'    AND delta_saldo = 0           AND delta_reservado = 0           AND delta_bloqueado = quantidade)
    OR (tipo = 'DESBLOQUEIO' AND delta_saldo = 0           AND delta_reservado = 0           AND delta_bloqueado = -quantidade)
    OR (tipo = 'EXPIRACAO'   AND delta_saldo = -quantidade AND delta_reservado = 0           AND delta_bloqueado = 0)
    OR (tipo = 'REVERSAO'    AND delta_saldo = -quantidade AND delta_reservado = 0           AND delta_bloqueado = -quantidade))
);
CREATE INDEX ia_credito_lancamentos_empresa_idx ON ia_credito_lancamentos (empresa_id, recurso, id DESC);

-- Reserva de uma operação (geração de convite, chamada do Wall-e): máximo previsto e, no fim, o consumo apurado.
-- Timeout não libera por si: só o serviço da operação (ou o operador) encerra a reserva.
CREATE TABLE ia_credito_reservas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL,
  recurso text NOT NULL,
  operacao_id text NOT NULL CHECK (operacao_id ~ '^[A-Za-z0-9:._-]{1,120}$'),
  quantidade bigint NOT NULL CHECK (quantidade > 0),
  consumido bigint,
  custo_real_microusd bigint CHECK (custo_real_microusd IS NULL OR custo_real_microusd >= 0),
  versao_precos text CHECK (versao_precos IS NULL OR versao_precos ~ '^[A-Za-z0-9._:-]{1,80}$'),
  estado text NOT NULL DEFAULT 'ABERTA' CHECK (estado IN ('ABERTA', 'CONSUMIDA', 'LIBERADA')),
  criada_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  encerrada_em timestamptz,
  FOREIGN KEY (empresa_id, recurso) REFERENCES ia_credito_carteiras(empresa_id, recurso),
  CONSTRAINT ia_credito_reservas_empresa_uk UNIQUE (id, empresa_id),
  CONSTRAINT ia_credito_reservas_operacao_uk UNIQUE (empresa_id, recurso, operacao_id),
  CONSTRAINT ia_credito_reservas_encerramento_check CHECK ((estado = 'ABERTA') = (encerrada_em IS NULL)),
  CONSTRAINT ia_credito_reservas_consumo_check CHECK (
       (estado = 'ABERTA' AND consumido IS NULL)
    OR (estado = 'CONSUMIDA' AND consumido IS NOT NULL AND consumido > 0 AND consumido <= quantidade)
    OR (estado = 'LIBERADA' AND consumido IS NULL))
);
CREATE INDEX ia_credito_reservas_abertas_idx ON ia_credito_reservas (empresa_id, recurso, criada_em) WHERE estado = 'ABERTA';

-- Alocação congelada da reserva nos lotes (devolução/consumo voltam exatamente aos lotes de origem).
CREATE TABLE ia_credito_reserva_lotes (
  reserva_id uuid NOT NULL,
  lote_id uuid NOT NULL,
  empresa_id uuid NOT NULL,
  ordem smallint NOT NULL CHECK (ordem >= 1),
  quantidade bigint NOT NULL CHECK (quantidade > 0),
  consumido bigint NOT NULL DEFAULT 0,
  liberado bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (reserva_id, lote_id),
  FOREIGN KEY (reserva_id, empresa_id) REFERENCES ia_credito_reservas(id, empresa_id),
  FOREIGN KEY (lote_id, empresa_id) REFERENCES ia_credito_lotes(id, empresa_id),
  CONSTRAINT ia_credito_reserva_lotes_ordem_uk UNIQUE (reserva_id, ordem),
  CONSTRAINT ia_credito_reserva_lotes_valores_check CHECK (consumido >= 0 AND liberado >= 0 AND consumido + liberado <= quantidade)
);

-- Cobrança avulsa no provedor: vínculo durável pedido ↔ pagamento, com conta e ambiente (sandbox nunca casa com produção).
CREATE TABLE ia_credito_cobrancas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL,
  pedido_id uuid NOT NULL,
  provedor text NOT NULL CHECK (provedor = 'ASAAS'),
  ambiente text NOT NULL CHECK (ambiente IN ('sandbox', 'producao')),
  conta text NOT NULL CHECK (conta ~ '^[a-z0-9_-]{1,40}$'),
  pagamento_id text NOT NULL CHECK (pagamento_id ~ '^[A-Za-z0-9_-]{1,100}$'),
  referencia_externa text NOT NULL CHECK (referencia_externa ~ '^km:(sandbox|producao):creditos:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  canonica boolean NOT NULL,
  valor_centavos bigint NOT NULL CHECK (valor_centavos > 0),
  forma_provedor text CHECK (forma_provedor IS NULL OR forma_provedor ~ '^[A-Z_]{1,40}$'),
  situacao_provedor text NOT NULL CHECK (situacao_provedor ~ '^[A-Z_]{1,40}$'),
  url_fatura text CHECK (url_fatura IS NULL OR (char_length(url_fatura) <= 500 AND url_fatura ~ '^https://')),
  vencimento date,
  confirmada_em timestamptz,
  estornado_centavos bigint NOT NULL DEFAULT 0,
  disputa text NOT NULL DEFAULT 'NENHUMA' CHECK (disputa IN ('NENHUMA', 'ABERTA', 'FAVORAVEL', 'PERDIDA')),
  exposicao_centavos bigint NOT NULL DEFAULT 0 CHECK (exposicao_centavos >= 0),
  revisao_motivo text CHECK (revisao_motivo IS NULL OR revisao_motivo ~ '^[A-Z0-9_]{1,60}$'),
  registrada_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  atualizada_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (pedido_id, empresa_id) REFERENCES ia_credito_pedidos(id, empresa_id),
  CONSTRAINT ia_credito_cobrancas_empresa_uk UNIQUE (id, empresa_id),
  CONSTRAINT ia_credito_cobrancas_pagamento_uk UNIQUE (provedor, ambiente, conta, pagamento_id),
  CONSTRAINT ia_credito_cobrancas_estorno_check CHECK (estornado_centavos >= 0 AND estornado_centavos <= valor_centavos),
  CONSTRAINT ia_credito_cobrancas_exposicao_check CHECK (exposicao_centavos <= valor_centavos)
);
-- Uma cobrança canônica por pedido; extras (pagamento duplicado) ficam registrados para devolução, nunca descartados.
CREATE UNIQUE INDEX ia_credito_cobrancas_canonica_uk ON ia_credito_cobrancas (pedido_id) WHERE canonica;
CREATE INDEX ia_credito_cobrancas_pagamento_idx ON ia_credito_cobrancas (pagamento_id);

-- Devolução de pacote (separada da devolução da assinatura, 089): cálculo imutável e situação do estorno.
CREATE TABLE ia_credito_devolucoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL,
  pedido_id uuid NOT NULL,
  cobranca_id uuid NOT NULL,
  lote_id uuid NOT NULL,
  protocolo text NOT NULL UNIQUE CHECK (protocolo ~ '^KM-[0-9]{8}-[0-9A-HJKMNP-TV-Z]{8}$'),
  tipo text NOT NULL CHECK (tipo IN ('ARREPENDIMENTO_7_DIAS', 'SALDO_NAO_UTILIZADO')),
  origem text NOT NULL CHECK (origem IN ('GESTAO', 'ATENDIMENTO')),
  chave_idempotencia uuid NOT NULL,
  solicitado_por uuid NOT NULL REFERENCES usuarios_administrativos(id),
  solicitado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  regra text NOT NULL CHECK (regra ~ '^[A-Z0-9-]{1,40}$'),
  quantidade_comprada bigint NOT NULL CHECK (quantidade_comprada > 0),
  quantidade_consumida bigint NOT NULL CHECK (quantidade_consumida >= 0),
  quantidade_cancelada bigint NOT NULL CHECK (quantidade_cancelada >= 0),
  valor_pago_centavos bigint NOT NULL CHECK (valor_pago_centavos > 0),
  valor_centavos bigint NOT NULL CHECK (valor_centavos > 0),
  forma text NOT NULL CHECK (forma IN ('PIX', 'CARTAO', 'BOLETO')),
  prazo date NOT NULL,
  estado text NOT NULL CHECK (estado IN ('AGUARDANDO_MANUAL', 'EM_CURSO', 'SOLICITADO', 'SEM_CONFIRMACAO', 'RECUSADO', 'CONCLUIDO')),
  modo text CHECK (modo IS NULL OR modo IN ('MANUAL', 'AUTOMATICO')),
  status_provedor text CHECK (status_provedor IS NULL OR status_provedor ~ '^[A-Z_]{1,40}$'),
  referencia text CHECK (referencia IS NULL OR char_length(btrim(referencia)) BETWEEN 3 AND 200),
  atualizado_em timestamptz,
  concluido_em timestamptz,
  FOREIGN KEY (pedido_id, empresa_id) REFERENCES ia_credito_pedidos(id, empresa_id),
  FOREIGN KEY (cobranca_id, empresa_id) REFERENCES ia_credito_cobrancas(id, empresa_id),
  FOREIGN KEY (lote_id, empresa_id) REFERENCES ia_credito_lotes(id, empresa_id),
  CONSTRAINT ia_credito_devolucoes_idempotencia_uk UNIQUE (empresa_id, chave_idempotencia),
  CONSTRAINT ia_credito_devolucoes_pedido_uk UNIQUE (pedido_id),
  CONSTRAINT ia_credito_devolucoes_valor_check CHECK (valor_centavos <= valor_pago_centavos
    AND quantidade_consumida + quantidade_cancelada <= quantidade_comprada),
  CONSTRAINT ia_credito_devolucoes_integral_check CHECK (tipo <> 'ARREPENDIMENTO_7_DIAS' OR valor_centavos = valor_pago_centavos),
  CONSTRAINT ia_credito_devolucoes_conclusao_check CHECK ((estado = 'CONCLUIDO') = (concluido_em IS NOT NULL)
    AND (estado <> 'CONCLUIDO' OR referencia IS NOT NULL))
);
CREATE INDEX ia_credito_devolucoes_abertas_idx ON ia_credito_devolucoes (prazo) WHERE estado <> 'CONCLUIDO';

-- Cortesia concedida por operador autorizado da plataforma (nunca pela Gestão do buffet): motivo, campanha e protocolo.
CREATE TABLE ia_credito_cortesias (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL,
  recurso text NOT NULL,
  lote_id uuid NOT NULL,
  protocolo text NOT NULL UNIQUE CHECK (protocolo ~ '^KM-[0-9]{8}-[0-9A-HJKMNP-TV-Z]{8}$'),
  campanha text NOT NULL CHECK (campanha ~ '^[A-Z0-9_-]{3,40}$'),
  quantidade bigint NOT NULL CHECK (quantidade > 0),
  validade_dias smallint NOT NULL CHECK (validade_dias BETWEEN 1 AND 400),
  motivo text NOT NULL CHECK (char_length(btrim(motivo)) BETWEEN 5 AND 300),
  concedida_por uuid NOT NULL REFERENCES usuarios_administrativos(id),
  chave_idempotencia uuid NOT NULL,
  criada_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (lote_id, empresa_id, recurso) REFERENCES ia_credito_lotes(id, empresa_id, recurso),
  CONSTRAINT ia_credito_cortesias_idempotencia_uk UNIQUE (empresa_id, chave_idempotencia)
);
CREATE INDEX ia_credito_cortesias_campanha_idx ON ia_credito_cortesias (campanha, recurso);

-- Corte do motor legado dos Convites: fotografia do mês (limite/usado) e o lote LEGADO criado, uma única vez por empresa.
CREATE TABLE ia_credito_cortes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL,
  recurso text NOT NULL CHECK (recurso = 'CONVITES'),
  mes date NOT NULL,
  limite_mensal integer NOT NULL CHECK (limite_mensal >= 0),
  usado integer NOT NULL CHECK (usado >= 0),
  quantidade_legado bigint NOT NULL CHECK (quantidade_legado >= 0),
  lote_id uuid,
  referencia_autorizacao text NOT NULL CHECK (referencia_autorizacao ~ '^[A-Za-z0-9:._/ -]{6,120}$'),
  executado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (empresa_id, recurso) REFERENCES ia_credito_carteiras(empresa_id, recurso),
  FOREIGN KEY (lote_id, empresa_id) REFERENCES ia_credito_lotes(id, empresa_id),
  CONSTRAINT ia_credito_cortes_empresa_uk UNIQUE (empresa_id, recurso),
  CONSTRAINT ia_credito_cortes_lote_check CHECK ((quantidade_legado = 0) = (lote_id IS NULL)
    AND quantidade_legado = GREATEST(0, limite_mensal - usado))
);

-- Saída de notificações por e-mail (outbox deduplicado): sem corpo nem dado pessoal; o texto é montado no envio.
CREATE TABLE ia_credito_notificacoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas(id),
  tipo text NOT NULL CHECK (tipo IN ('PAGAMENTO_CONFIRMADO', 'DEVOLUCAO_REGISTRADA', 'AVISO_INTERNO_DEVOLUCAO', 'LOTE_VENCENDO_30', 'LOTE_VENCENDO_7')),
  dedupe text NOT NULL UNIQUE CHECK (dedupe ~ '^[A-Z0-9_]+:[A-Za-z0-9:._-]{1,160}$'),
  protocolo text CHECK (protocolo IS NULL OR protocolo ~ '^KM-[0-9]{8}-[0-9A-HJKMNP-TV-Z]{8}$'),
  situacao text NOT NULL DEFAULT 'PENDENTE' CHECK (situacao IN ('PENDENTE', 'ENVIADO', 'FALHOU', 'DESCARTADO')),
  tentativas integer NOT NULL DEFAULT 0 CHECK (tentativas BETWEEN 0 AND 20),
  proxima_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  criada_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  enviada_em timestamptz,
  CONSTRAINT ia_credito_notificacoes_envio_check CHECK ((situacao = 'ENVIADO') = (enviada_em IS NOT NULL))
);
CREATE INDEX ia_credito_notificacoes_pendentes_idx ON ia_credito_notificacoes (proxima_em) WHERE situacao IN ('PENDENTE', 'FALHOU');

-- Guarda única do domínio: imutabilidade, transições e somas. Mensagens sem dado pessoal.
CREATE FUNCTION kidmais_095_guarda() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE devolvido bigint; pago bigint;
BEGIN
  IF TG_OP = 'TRUNCATE' THEN RAISE EXCEPTION '095: % não é truncada.', TG_TABLE_NAME USING ERRCODE = 'P0001'; END IF;
  IF TG_TABLE_NAME = 'ia_credito_lancamentos' THEN
    IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION '095: extrato é imutável; corrija por lançamento de compensação.' USING ERRCODE = 'P0001'; END IF;
    NEW.criado_em := clock_timestamp();
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' AND TG_TABLE_NAME <> 'ia_credito_notificacoes' THEN
    RAISE EXCEPTION '095: registro de % não é apagado.', TG_TABLE_NAME USING ERRCODE = 'P0001';
  END IF;
  IF TG_TABLE_NAME = 'ia_credito_carteiras' THEN
    IF TG_OP = 'UPDATE' AND (NEW.empresa_id, NEW.recurso, NEW.corte_em, NEW.criada_em) IS DISTINCT FROM (OLD.empresa_id, OLD.recurso, OLD.corte_em, OLD.criada_em) THEN
      RAISE EXCEPTION '095: identidade e corte da carteira são imutáveis.' USING ERRCODE = 'P0001';
    END IF;
    NEW.atualizada_em := clock_timestamp();
  ELSIF TG_TABLE_NAME = 'ia_credito_lotes' THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.disponivel <> NEW.quantidade OR NEW.reservado + NEW.bloqueado + NEW.consumido + NEW.expirado + NEW.cancelado <> 0 THEN
        RAISE EXCEPTION '095: lote nasce inteiro disponível.' USING ERRCODE = 'P0001';
      END IF;
      NEW.liberado_em := clock_timestamp();
    ELSE
      IF (NEW.id, NEW.empresa_id, NEW.recurso, NEW.origem, NEW.chave_origem, NEW.quantidade, NEW.preco_centavos, NEW.pedido_id, NEW.ciclo, NEW.liberado_em)
         IS DISTINCT FROM (OLD.id, OLD.empresa_id, OLD.recurso, OLD.origem, OLD.chave_origem, OLD.quantidade, OLD.preco_centavos, OLD.pedido_id, OLD.ciclo, OLD.liberado_em) THEN
        RAISE EXCEPTION '095: origem, quantidade e preço do lote são imutáveis.' USING ERRCODE = 'P0001';
      END IF;
      IF NEW.vence_em < OLD.vence_em THEN RAISE EXCEPTION '095: vencimento do lote só pode ser prorrogado.' USING ERRCODE = 'P0001'; END IF;
      IF NEW.consumido < OLD.consumido OR NEW.expirado < OLD.expirado OR NEW.cancelado < OLD.cancelado THEN
        RAISE EXCEPTION '095: consumo, expiração e cancelamento do lote não voltam atrás.' USING ERRCODE = 'P0001';
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'ia_credito_reservas' THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.estado <> 'ABERTA' THEN RAISE EXCEPTION '095: reserva nasce ABERTA.' USING ERRCODE = 'P0001'; END IF;
      NEW.criada_em := clock_timestamp();
    ELSE
      IF (NEW.id, NEW.empresa_id, NEW.recurso, NEW.operacao_id, NEW.quantidade, NEW.versao_precos, NEW.criada_em)
         IS DISTINCT FROM (OLD.id, OLD.empresa_id, OLD.recurso, OLD.operacao_id, OLD.quantidade, OLD.versao_precos, OLD.criada_em) THEN
        RAISE EXCEPTION '095: reserva é imutável (exceto o encerramento).' USING ERRCODE = 'P0001';
      END IF;
      IF OLD.estado <> 'ABERTA' AND ROW(NEW.*) IS DISTINCT FROM ROW(OLD.*) THEN RAISE EXCEPTION '095: reserva encerrada é final.' USING ERRCODE = 'P0001'; END IF;
      IF NEW.estado <> OLD.estado THEN NEW.encerrada_em := clock_timestamp(); END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'ia_credito_reserva_lotes' THEN
    IF TG_OP = 'UPDATE' AND ((NEW.reserva_id, NEW.lote_id, NEW.empresa_id, NEW.ordem, NEW.quantidade) IS DISTINCT FROM (OLD.reserva_id, OLD.lote_id, OLD.empresa_id, OLD.ordem, OLD.quantidade)
       OR NEW.consumido < OLD.consumido OR NEW.liberado < OLD.liberado) THEN
      RAISE EXCEPTION '095: alocação da reserva é imutável.' USING ERRCODE = 'P0001';
    END IF;
  ELSIF TG_TABLE_NAME = 'ia_credito_pedidos' THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.estado <> 'CRIACAO_EM_CURSO' OR NEW.creditado_em IS NOT NULL THEN RAISE EXCEPTION '095: pedido nasce em CRIACAO_EM_CURSO.' USING ERRCODE = 'P0001'; END IF;
      NEW.criado_em := clock_timestamp(); NEW.atualizado_em := NEW.criado_em;
    ELSE
      IF (NEW.id, NEW.empresa_id, NEW.protocolo, NEW.recurso, NEW.catalogo_versao, NEW.oferta_codigo, NEW.oferta, NEW.termos_versao, NEW.termos_sha256, NEW.quantidade,
          NEW.preco_centavos, NEW.validade_dias, NEW.forma, NEW.ambiente, NEW.chave_idempotencia, NEW.payload_sha256, NEW.solicitado_por, NEW.criado_em, NEW.vencimento_pagamento)
         IS DISTINCT FROM (OLD.id, OLD.empresa_id, OLD.protocolo, OLD.recurso, OLD.catalogo_versao, OLD.oferta_codigo, OLD.oferta, OLD.termos_versao, OLD.termos_sha256, OLD.quantidade,
          OLD.preco_centavos, OLD.validade_dias, OLD.forma, OLD.ambiente, OLD.chave_idempotencia, OLD.payload_sha256, OLD.solicitado_por, OLD.criado_em, OLD.vencimento_pagamento) THEN
        RAISE EXCEPTION '095: oferta, valor e protocolo do pedido são imutáveis.' USING ERRCODE = 'P0001';
      END IF;
      IF NEW.estado IS DISTINCT FROM OLD.estado AND NOT ((OLD.estado, NEW.estado) IN (
           ('CRIACAO_EM_CURSO', 'AGUARDANDO_PAGAMENTO'), ('CRIACAO_EM_CURSO', 'CRIACAO_INCERTA'), ('CRIACAO_EM_CURSO', 'FALHOU_CRIACAO'),
           ('CRIACAO_INCERTA', 'AGUARDANDO_PAGAMENTO'), ('CRIACAO_INCERTA', 'FALHOU_CRIACAO'), ('CRIACAO_INCERTA', 'REVISAO'),
           ('FALHOU_CRIACAO', 'REVISAO'),
           ('AGUARDANDO_PAGAMENTO', 'CREDITADO'), ('AGUARDANDO_PAGAMENTO', 'VENCIDO'), ('AGUARDANDO_PAGAMENTO', 'REVISAO'), ('AGUARDANDO_PAGAMENTO', 'ENCERRADO'),
           ('VENCIDO', 'CREDITADO'), ('VENCIDO', 'REVISAO'), ('VENCIDO', 'ENCERRADO'),
           ('REVISAO', 'CREDITADO'), ('REVISAO', 'ENCERRADO'), ('REVISAO', 'AGUARDANDO_PAGAMENTO'),
           -- P2-2 (revisão de 22/10): pagamento confirmado depois do cancelamento da cobrança vai para revisão (nunca fica sem saída).
           ('ENCERRADO', 'REVISAO'))) THEN
        RAISE EXCEPTION '095: transição do pedido inválida: % → %.', OLD.estado, NEW.estado USING ERRCODE = 'P0001';
      END IF;
      IF OLD.creditado_em IS NOT NULL AND NEW.creditado_em IS DISTINCT FROM OLD.creditado_em THEN
        RAISE EXCEPTION '095: crédito do pedido é final.' USING ERRCODE = 'P0001';
      END IF;
      NEW.atualizado_em := clock_timestamp();
    END IF;
  ELSIF TG_TABLE_NAME = 'ia_credito_cobrancas' THEN
    IF TG_OP = 'UPDATE' THEN
      IF (NEW.id, NEW.empresa_id, NEW.pedido_id, NEW.provedor, NEW.ambiente, NEW.conta, NEW.pagamento_id, NEW.referencia_externa, NEW.valor_centavos, NEW.registrada_em)
         IS DISTINCT FROM (OLD.id, OLD.empresa_id, OLD.pedido_id, OLD.provedor, OLD.ambiente, OLD.conta, OLD.pagamento_id, OLD.referencia_externa, OLD.valor_centavos, OLD.registrada_em) THEN
        RAISE EXCEPTION '095: vínculo e valor da cobrança são imutáveis.' USING ERRCODE = 'P0001';
      END IF;
      IF OLD.canonica AND NOT NEW.canonica THEN RAISE EXCEPTION '095: cobrança canônica não deixa de ser canônica.' USING ERRCODE = 'P0001'; END IF;
      IF OLD.confirmada_em IS NOT NULL AND NEW.confirmada_em IS DISTINCT FROM OLD.confirmada_em THEN
        RAISE EXCEPTION '095: confirmação da cobrança é final.' USING ERRCODE = 'P0001';
      END IF;
      IF NEW.estornado_centavos < OLD.estornado_centavos OR NEW.exposicao_centavos < OLD.exposicao_centavos THEN
        RAISE EXCEPTION '095: estorno e exposição só aumentam.' USING ERRCODE = 'P0001';
      END IF;
      NEW.atualizada_em := clock_timestamp();
    ELSE
      NEW.registrada_em := clock_timestamp(); NEW.atualizada_em := NEW.registrada_em;
    END IF;
  ELSIF TG_TABLE_NAME = 'ia_credito_devolucoes' THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.estado <> 'AGUARDANDO_MANUAL' OR NEW.modo IS NOT NULL OR NEW.status_provedor IS NOT NULL OR NEW.referencia IS NOT NULL OR NEW.concluido_em IS NOT NULL THEN
        RAISE EXCEPTION '095: devolução nasce sem estorno executado.' USING ERRCODE = 'P0001';
      END IF;
      -- Soma das devoluções do pedido nunca passa do valor pago (pedido travado: devoluções concorrentes esperam).
      SELECT preco_centavos INTO pago FROM public.ia_credito_pedidos WHERE id = NEW.pedido_id AND empresa_id = NEW.empresa_id FOR UPDATE;
      SELECT coalesce(sum(valor_centavos), 0) INTO devolvido FROM public.ia_credito_devolucoes WHERE pedido_id = NEW.pedido_id;
      IF pago IS NULL OR NEW.valor_pago_centavos <> pago OR devolvido + NEW.valor_centavos > pago THEN
        RAISE EXCEPTION '095: devolução acima do valor pago do pedido.' USING ERRCODE = 'P0001';
      END IF;
      NEW.solicitado_em := clock_timestamp(); NEW.atualizado_em := NULL;
    ELSE
      IF (NEW.id, NEW.empresa_id, NEW.pedido_id, NEW.cobranca_id, NEW.lote_id, NEW.protocolo, NEW.tipo, NEW.origem, NEW.chave_idempotencia, NEW.solicitado_por,
          NEW.solicitado_em, NEW.regra, NEW.quantidade_comprada, NEW.quantidade_consumida, NEW.quantidade_cancelada, NEW.valor_pago_centavos, NEW.valor_centavos, NEW.forma, NEW.prazo)
         IS DISTINCT FROM (OLD.id, OLD.empresa_id, OLD.pedido_id, OLD.cobranca_id, OLD.lote_id, OLD.protocolo, OLD.tipo, OLD.origem, OLD.chave_idempotencia, OLD.solicitado_por,
          OLD.solicitado_em, OLD.regra, OLD.quantidade_comprada, OLD.quantidade_consumida, OLD.quantidade_cancelada, OLD.valor_pago_centavos, OLD.valor_centavos, OLD.forma, OLD.prazo) THEN
        RAISE EXCEPTION '095: protocolo, valores e cálculo da devolução são imutáveis.' USING ERRCODE = 'P0001';
      END IF;
      IF NEW.estado IS DISTINCT FROM OLD.estado THEN
        IF NOT ((OLD.estado, NEW.estado) IN (
             ('AGUARDANDO_MANUAL', 'EM_CURSO'), ('AGUARDANDO_MANUAL', 'CONCLUIDO'),
             ('EM_CURSO', 'SOLICITADO'), ('EM_CURSO', 'SEM_CONFIRMACAO'), ('EM_CURSO', 'RECUSADO'), ('EM_CURSO', 'CONCLUIDO'),
             ('SOLICITADO', 'CONCLUIDO'), ('SEM_CONFIRMACAO', 'SOLICITADO'), ('SEM_CONFIRMACAO', 'CONCLUIDO'), ('RECUSADO', 'CONCLUIDO'))) THEN
          RAISE EXCEPTION '095: transição da devolução inválida: % → %.', OLD.estado, NEW.estado USING ERRCODE = 'P0001';
        END IF;
        IF NEW.estado = 'EM_CURSO' AND NEW.modo IS DISTINCT FROM 'AUTOMATICO' THEN
          RAISE EXCEPTION '095: chamada automática exige modo AUTOMATICO.' USING ERRCODE = 'P0001';
        END IF;
        NEW.atualizado_em := clock_timestamp();
        IF NEW.estado = 'CONCLUIDO' THEN NEW.concluido_em := clock_timestamp(); NEW.modo := COALESCE(NEW.modo, 'MANUAL'); END IF;
      ELSIF NEW.modo IS DISTINCT FROM OLD.modo OR NEW.concluido_em IS DISTINCT FROM OLD.concluido_em THEN
        RAISE EXCEPTION '095: modo e conclusão só mudam junto com a situação.' USING ERRCODE = 'P0001';
      END IF;
      IF OLD.estado = 'CONCLUIDO' AND ROW(NEW.*) IS DISTINCT FROM ROW(OLD.*) THEN RAISE EXCEPTION '095: devolução concluída é imutável.' USING ERRCODE = 'P0001'; END IF;
    END IF;
  ELSIF TG_TABLE_NAME IN ('ia_credito_cortesias', 'ia_credito_cortes') THEN
    IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION '095: registro de % é imutável.', TG_TABLE_NAME USING ERRCODE = 'P0001'; END IF;
  ELSIF TG_TABLE_NAME = 'ia_credito_notificacoes' THEN
    IF TG_OP = 'DELETE' AND OLD.situacao IN ('PENDENTE', 'FALHOU') THEN RAISE EXCEPTION '095: notificação pendente não é apagada.' USING ERRCODE = 'P0001'; END IF;
    IF TG_OP = 'UPDATE' AND ((NEW.id, NEW.empresa_id, NEW.tipo, NEW.dedupe, NEW.protocolo, NEW.criada_em) IS DISTINCT FROM (OLD.id, OLD.empresa_id, OLD.tipo, OLD.dedupe, OLD.protocolo, OLD.criada_em)
       OR OLD.situacao IN ('ENVIADO', 'DESCARTADO') AND NEW.situacao IS DISTINCT FROM OLD.situacao) THEN
      RAISE EXCEPTION '095: notificação é imutável depois de enviada.' USING ERRCODE = 'P0001';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  END IF;
  RETURN NEW;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ia_credito_carteiras', 'ia_credito_pedidos', 'ia_credito_lotes', 'ia_credito_lancamentos', 'ia_credito_reservas',
      'ia_credito_reserva_lotes', 'ia_credito_cobrancas', 'ia_credito_devolucoes', 'ia_credito_cortesias', 'ia_credito_cortes', 'ia_credito_notificacoes'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION kidmais_095_guarda()', t || '_095_guarda_trg', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION kidmais_095_guarda()', t || '_095_sem_truncate_trg', t);
  END LOOP;
END $$;

COMMENT ON TABLE ia_credito_carteiras IS '095: carteira de créditos de IA por empresa e recurso (projeção do extrato).';
COMMENT ON TABLE ia_credito_lancamentos IS '095: extrato imutável de créditos de IA (fonte de verdade).';
COMMIT;
