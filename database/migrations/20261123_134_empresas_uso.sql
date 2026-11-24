-- =============================================================================
-- Kidmais Manager / iA.Fest — Migration 134: uso da contratante (Cliente ou Interna), só para o painel do desenvolvedor
-- Arquivo: 20261123_134_empresas_uso.sql — LOCAL, PREPARADA, não aplicada em staging nem em production.
--
-- Plano: vault "Contratantes desativadas 20261123", fase 2 (D-INT-1 e D-INT-2 decididas por Felipe em 23/11/2026).
-- 134 reservada nos relatos em 23/11 22:10Z (maior número em todos os clones = 133). Exige a 063.
--
-- Por quê: Desenvolvedor › Contratantes mistura clientes reais com empresas de teste, demonstração e suporte que
-- continuam ativas. A marca "Interna" deixa o filtro "Em uso" mostrar só clientes.
--
-- O que cria: plataforma_empresas_uso (uma linha por empresa marcada). Empresa sem linha = Cliente, então nenhuma
-- linha é inserida aqui e as legadas sem cadastro (063) também funcionam. Não altera tabela existente nem função.
-- Só o painel do desenvolvedor lê e escreve; a troca é auditada (EMPRESA_USO_ALTERADO) pelo código.
--
-- Rollback: database/rollback/20261123_134_empresas_uso_down.sql (descarta as marcas; o código volta a tratar todas
-- como Cliente quando a tabela some).
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;

DO $$
BEGIN
  IF to_regclass('public.plataforma_empresas_cadastro') IS NULL OR to_regclass('public.usuarios_administrativos') IS NULL THEN
    RAISE EXCEPTION '134: exige a 063';
  END IF;
  IF to_regclass('public.plataforma_empresas_uso') IS NOT NULL THEN
    RAISE EXCEPTION '134: plataforma_empresas_uso já existe';
  END IF;
END $$;

CREATE TABLE plataforma_empresas_uso (
  empresa_id uuid PRIMARY KEY,
  uso text NOT NULL,
  atualizado_por uuid NOT NULL,
  atualizado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT kidmais_134_uso_empresa_fk FOREIGN KEY (empresa_id) REFERENCES empresas (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT kidmais_134_uso_atualizado_por_fk FOREIGN KEY (atualizado_por) REFERENCES usuarios_administrativos (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT kidmais_134_uso_ck CHECK (uso IN ('CLIENTE', 'INTERNA'))
);
COMMENT ON TABLE plataforma_empresas_uso IS '134: uso da contratante no painel do desenvolvedor (sem linha = CLIENTE). A troca é auditada como EMPRESA_USO_ALTERADO.';

COMMIT;
