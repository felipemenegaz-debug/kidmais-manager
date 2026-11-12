-- Postcheck da 103 (somente leitura): exatamente uma categoria SERVICOS, com o nome esperado, ativa e não arquivada.
DO $$
BEGIN
  IF (SELECT count(*) FROM adicional_categorias WHERE codigo = 'SERVICOS' AND nome = 'Serviços' AND ativo AND arquivado_em IS NULL) <> 1 THEN
    RAISE EXCEPTION '103 postcheck: categoria SERVICOS ausente ou divergente';
  END IF;
END $$;
