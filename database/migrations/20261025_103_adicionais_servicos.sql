-- 103: categoria global "Serviços" no catálogo de adicionais (fase S-A2 do fluxo "cliente com 2 salões"; plano rev. 4
-- aprovado com ressalvas pelo Astra em 25/10/2026; F4: separada da 102).
--   * só dados: uma linha em adicional_categorias (tabela global da 021, igual para todas as empresas);
--   * os itens (monitores, recreação, animação, gerente de festa) são adicionais POR EMPRESA, criados pelo buffet;
--     nada é criado em massa aqui. Em cada pacote o buffet marca INCLUSO/EXTRA/INDISPONIVEL (pacote_adicionais);
--   * INCLUSO dispensa preço próprio (a oferta filtra INCLUSO antes do preço); EXTRA continua exigindo preço;
--   * reexecução aceita só a mesma linha (código SERVICOS, nome "Serviços", ativa, não arquivada); divergente recusa.
-- Rollback: database/rollback/20261025_103_adicionais_servicos_down.sql (recusado se algum adicional usar SERVICOS).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;
DO $$
BEGIN
  IF to_regclass('public.adicional_categorias') IS NULL OR to_regclass('public.adicionais') IS NULL THEN
    RAISE EXCEPTION '103: precheck falhou (021 ausente); nada alterado';
  END IF;
  IF EXISTS (SELECT 1 FROM adicional_categorias WHERE codigo = 'SERVICOS'
              AND NOT (nome = 'Serviços' AND ativo AND arquivado_em IS NULL)) THEN
    RAISE EXCEPTION '103: precheck falhou (categoria SERVICOS divergente, inativa ou arquivada); nada alterado';
  END IF;
END $$;
LOCK TABLE public.adicional_categorias IN SHARE ROW EXCLUSIVE MODE;
INSERT INTO public.adicional_categorias (codigo, nome, ordem_exibicao)
SELECT 'SERVICOS', 'Serviços', coalesce(max(ordem_exibicao), 0) + 1 FROM public.adicional_categorias
HAVING NOT EXISTS (SELECT 1 FROM public.adicional_categorias WHERE codigo = 'SERVICOS');
COMMIT;
