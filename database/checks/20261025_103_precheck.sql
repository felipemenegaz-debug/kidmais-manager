-- Precheck da 103 (somente leitura): 021 presente; SERVICOS ausente (primeira instalação) ou idêntica (reexecução).
DO $$
BEGIN
  IF to_regclass('public.adicional_categorias') IS NULL OR to_regclass('public.adicionais') IS NULL THEN
    RAISE EXCEPTION '103 precheck: 021 ausente';
  END IF;
  IF EXISTS (SELECT 1 FROM adicional_categorias WHERE codigo = 'SERVICOS'
              AND NOT (nome = 'Serviços' AND ativo AND arquivado_em IS NULL)) THEN
    RAISE EXCEPTION '103 precheck: categoria SERVICOS divergente, inativa ou arquivada';
  END IF;
END $$;
