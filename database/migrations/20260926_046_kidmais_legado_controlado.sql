BEGIN;

-- Provisiona a empresa canônica Kidmais e a primeira membership, e atribui
-- o legado comercial já comprovado. Não copia a 020. Não cria outra empresas.
-- Não grava UUID de usuário: a identidade é resolvida neste banco, na hora,
-- por lower(btrim(email)). Divergência aborta. Não altera senha, papel nem ativo.
--
-- O conjunto nulo tem de ser exatamente os sete pacotes oficiais. SALADA_PREMIUM
-- só acompanha se estiver INCLUSO em PREMIUM, como na 023, e se o adicional
-- vier do catálogo sem empresa. Um vínculo de pacote fora desses sete aborta.
-- Esta migration não apaga essa linha e não a coloca em lista branca.
--
-- A guarda 036 continua recusando nulo para empresa. Ela é desligada só nos
-- três gatilhos de imutabilidade, só para este UPDATE, e religada antes do
-- commit. Não há parâmetro de sessão que reabra a guarda. 035, 041 e 034
-- permanecem ligados. Tabela publicada não muda de empresa.

SET LOCAL lock_timeout = '5s';

DO $mig$
DECLARE
  email_alvo text := 'felipemenegaz@gmail.com';
  usuario uuid;
  n_email integer;
  empresa uuid;
  membership uuid;
  sete text[] := ARRAY['COMPACTA','COMPLETA','ESSENCIAL','MINI_FESTA','PIZZA_PARTY','POCKET','PREMIUM'];
  ids_pacote uuid[];
  ids_adicional uuid[];
  ids_tabela uuid[];
  n_pacote integer;
  n_adicional integer;
  n_tabela integer;
  soma_pacote numeric;
  soma_adicional numeric;
  qtd_preco_pacote integer;
  qtd_preco_adicional integer;
  qtd_snapshot integer;
  qtd_fechamento integer;
  qtd_contrato integer;
BEGIN
  SELECT count(*) INTO n_email
    FROM usuarios_administrativos
   WHERE lower(btrim(email)) = lower(btrim(email_alvo));
  IF n_email <> 1 THEN
    RAISE EXCEPTION '046: a identidade administrativa não é única.'
      USING ERRCODE = '23514';
  END IF;

  SELECT id INTO usuario
    FROM usuarios_administrativos
   WHERE lower(btrim(email)) = lower(btrim(email_alvo))
     AND ativo
     AND papel = 'REPRESENTANTE_AUTORIZADO'
   FOR UPDATE;
  IF usuario IS NULL THEN
    RAISE EXCEPTION '046: a identidade administrativa não está ativa como representante autorizado.'
      USING ERRCODE = '23514';
  END IF;

  IF to_regclass('public.empresas') IS NULL
     OR to_regclass('public.memberships') IS NULL
     OR to_regprocedure('public.kidmais_044_guard_empresas()') IS NULL
     OR to_regprocedure('public.kidmais_045_guard_memberships()') IS NULL
     OR to_regprocedure('public.kidmais_036_empresa_pai_imutavel()') IS NULL THEN
    RAISE EXCEPTION '046: empresa canônica, membership ou guarda anterior ausente.';
  END IF;
  IF EXISTS (SELECT 1 FROM empresas WHERE codigo = 'kidmais') THEN
    RAISE EXCEPTION '046: a empresa Kidmais já existe. Não reutilizar linha revogada nem reprovisionar.';
  END IF;

  INSERT INTO empresas (codigo, nome, status)
  VALUES ('kidmais', 'Kidmais', 'PROVISIONAMENTO')
  RETURNING id INTO empresa;

  PERFORM set_config('kidmais.ator_usuario_id', usuario::text, true);

  UPDATE empresas
     SET status = 'ATIVA'
   WHERE id = empresa
     AND status = 'PROVISIONAMENTO';
  IF NOT EXISTS (
    SELECT 1 FROM empresas WHERE id = empresa AND status = 'ATIVA' AND codigo = 'kidmais' AND nome = 'Kidmais'
  ) THEN
    RAISE EXCEPTION '046: a empresa não entrou em ATIVA pela transição auditada.';
  END IF;

  IF EXISTS (SELECT 1 FROM memberships WHERE empresa_id = empresa AND usuario_id = usuario) THEN
    RAISE EXCEPTION '046: membership revogada não é reutilizada.';
  END IF;

  INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde)
  VALUES (empresa, usuario, 'PENDENTE', clock_timestamp())
  RETURNING id INTO membership;

  UPDATE memberships
     SET status = 'ATIVA'
   WHERE id = membership
     AND empresa_id = empresa
     AND usuario_id = usuario
     AND status = 'PENDENTE';
  IF NOT EXISTS (
    SELECT 1 FROM memberships
     WHERE id = membership AND status = 'ATIVA' AND revogado_em IS NULL AND revisao = 2
  ) THEN
    RAISE EXCEPTION '046: a membership não entrou em ATIVA pela transição auditada.';
  END IF;

  LOCK TABLE
    public.adicionais,
    public.pacote_adicionais,
    public.pacotes,
    public.precos_adicional,
    public.precos_pacote,
    public.tabelas_preco
  IN SHARE ROW EXCLUSIVE MODE;

  IF (
    SELECT coalesce(array_agg(codigo::text ORDER BY codigo), ARRAY[]::text[])
      FROM pacotes
     WHERE empresa_id IS NULL
  ) IS DISTINCT FROM (
    SELECT array_agg(item.codigo ORDER BY item.codigo)
      FROM unnest(sete) AS item(codigo)
  ) THEN
    RAISE EXCEPTION '046: o conjunto de pacotes sem empresa divergiu.'
      USING ERRCODE = '23514';
  END IF;

  SELECT array_agg(id ORDER BY codigo) INTO ids_pacote
    FROM pacotes
   WHERE empresa_id IS NULL
     AND codigo = ANY (sete);
  IF ids_pacote IS NULL OR cardinality(ids_pacote) <> 7 THEN
    RAISE EXCEPTION '046: o conjunto de pacotes sem empresa divergiu.'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pacotes
     WHERE id = ANY (ids_pacote)
       AND revisao_anterior_id IS NOT NULL
  ) OR EXISTS (
    SELECT 1
      FROM pacotes filho
      JOIN pacotes pai ON pai.id = filho.revisao_anterior_id
     WHERE pai.id = ANY (ids_pacote)
        OR filho.id = ANY (ids_pacote)
  ) THEN
    RAISE EXCEPTION '046: revisão do legado impediria a atribuição atômica.'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pacote_adicionais pa
      JOIN pacotes p ON p.id = pa.pacote_id
      JOIN adicionais a ON a.id = pa.adicional_id
     WHERE p.codigo = 'PREMIUM'
       AND a.codigo = 'SALADA_PREMIUM'
       AND pa.modalidade = 'INCLUSO'
       AND p.empresa_id IS NULL
       AND a.empresa_id IS NULL
  ) THEN
    RAISE EXCEPTION '046: SALADA_PREMIUM não está inclusa no pacote oficial.'
      USING ERRCODE = '23514';
  END IF;

  SELECT array_agg(DISTINCT a.id) INTO ids_adicional
    FROM adicionais a
    JOIN pacote_adicionais pa ON pa.adicional_id = a.id
   WHERE pa.pacote_id = ANY (ids_pacote)
     AND a.empresa_id IS NULL;
  IF ids_adicional IS NULL OR NOT EXISTS (
    SELECT 1 FROM adicionais WHERE id = ANY (ids_adicional) AND codigo = 'SALADA_PREMIUM'
  ) THEN
    RAISE EXCEPTION '046: o adicional oficial não entrou no fechamento do legado.'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM adicionais
     WHERE id = ANY (ids_adicional)
       AND empresa_id IS NOT NULL
  ) OR EXISTS (
    SELECT 1
      FROM pacote_adicionais pa
      JOIN adicionais a ON a.id = pa.adicional_id
     WHERE pa.pacote_id = ANY (ids_pacote)
       AND a.empresa_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION '046: adicional do legado já pertence a outra empresa.'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pacote_adicionais pa
     WHERE pa.adicional_id = ANY (ids_adicional)
       AND pa.pacote_id <> ALL (ids_pacote)
  ) THEN
    RAISE EXCEPTION '046: vínculo fora dos sete pacotes impede a atribuição. Esta migration não apaga essa linha.'
      USING ERRCODE = '23514';
  END IF;

  SELECT array_agg(DISTINCT t.id) INTO ids_tabela
    FROM tabelas_preco t
   WHERE t.empresa_id IS NULL
     AND t.publicada_em IS NULL
     AND (
       EXISTS (
         SELECT 1 FROM precos_pacote pp
          WHERE pp.tabela_preco_id = t.id
            AND pp.pacote_id = ANY (ids_pacote)
       )
       OR EXISTS (
         SELECT 1 FROM precos_adicional pr
          WHERE pr.tabela_preco_id = t.id
            AND pr.adicional_id = ANY (ids_adicional)
       )
     );
  IF ids_tabela IS NULL THEN
    RAISE EXCEPTION '046: tabela do legado ausente.'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM tabelas_preco t
      JOIN precos_pacote pp ON pp.tabela_preco_id = t.id
     WHERE pp.pacote_id = ANY (ids_pacote)
       AND t.id <> ALL (ids_tabela)
  ) OR EXISTS (
    SELECT 1
      FROM tabelas_preco t
      JOIN precos_adicional pr ON pr.tabela_preco_id = t.id
     WHERE pr.adicional_id = ANY (ids_adicional)
       AND t.id <> ALL (ids_tabela)
  ) THEN
    RAISE EXCEPTION '046: tabela ligada ao legado não pode acompanhar a atribuição.'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM precos_pacote pp
     WHERE pp.tabela_preco_id = ANY (ids_tabela)
       AND pp.pacote_id <> ALL (ids_pacote)
  ) OR EXISTS (
    SELECT 1
      FROM precos_adicional pr
     WHERE pr.tabela_preco_id = ANY (ids_tabela)
       AND pr.adicional_id <> ALL (ids_adicional)
  ) OR EXISTS (
    SELECT 1 FROM tabelas_preco
     WHERE id = ANY (ids_tabela)
       AND (publicada_em IS NOT NULL OR empresa_id IS NOT NULL)
  ) THEN
    RAISE EXCEPTION '046: tabela do legado cruza pacote, adicional ou publicação.'
      USING ERRCODE = '23514';
  END IF;

  SELECT coalesce(sum(valor), 0), count(*) INTO soma_pacote, qtd_preco_pacote FROM precos_pacote;
  SELECT coalesce(sum(valor), 0), count(*) INTO soma_adicional, qtd_preco_adicional FROM precos_adicional;
  SELECT count(*) INTO qtd_snapshot FROM fechamento_pacote_snapshots;
  SELECT count(*) INTO qtd_fechamento FROM fechamentos;
  SELECT count(*) INTO qtd_contrato FROM contratos;

  EXECUTE 'ALTER TABLE pacotes DISABLE TRIGGER pacotes_empresa_imutavel_trg';
  EXECUTE 'ALTER TABLE tabelas_preco DISABLE TRIGGER tabelas_preco_empresa_imutavel_trg';
  EXECUTE 'ALTER TABLE adicionais DISABLE TRIGGER adicionais_empresa_imutavel_trg';

  UPDATE pacotes
     SET empresa_id = empresa
   WHERE id = ANY (ids_pacote)
     AND empresa_id IS NULL;
  GET DIAGNOSTICS n_pacote = ROW_COUNT;

  UPDATE adicionais
     SET empresa_id = empresa
   WHERE id = ANY (ids_adicional)
     AND empresa_id IS NULL;
  GET DIAGNOSTICS n_adicional = ROW_COUNT;

  UPDATE tabelas_preco
     SET empresa_id = empresa
   WHERE id = ANY (ids_tabela)
     AND empresa_id IS NULL
     AND publicada_em IS NULL;
  GET DIAGNOSTICS n_tabela = ROW_COUNT;

  EXECUTE 'ALTER TABLE pacotes ENABLE TRIGGER pacotes_empresa_imutavel_trg';
  EXECUTE 'ALTER TABLE tabelas_preco ENABLE TRIGGER tabelas_preco_empresa_imutavel_trg';
  EXECUTE 'ALTER TABLE adicionais ENABLE TRIGGER adicionais_empresa_imutavel_trg';

  IF n_pacote <> 7
     OR n_adicional <> cardinality(ids_adicional)
     OR n_tabela <> cardinality(ids_tabela) THEN
    RAISE EXCEPTION '046: a atribuição não atingiu o conjunto travado.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pacotes WHERE id = ANY (ids_pacote) AND empresa_id IS DISTINCT FROM empresa
  ) OR EXISTS (
    SELECT 1 FROM adicionais WHERE id = ANY (ids_adicional) AND empresa_id IS DISTINCT FROM empresa
  ) OR EXISTS (
    SELECT 1 FROM tabelas_preco WHERE id = ANY (ids_tabela) AND empresa_id IS DISTINCT FROM empresa
  ) THEN
    RAISE EXCEPTION '046: identificador do legado não foi preservado na mesma empresa.';
  END IF;

  IF (SELECT coalesce(sum(valor), 0) FROM precos_pacote) IS DISTINCT FROM soma_pacote
     OR (SELECT count(*) FROM precos_pacote) <> qtd_preco_pacote
     OR (SELECT coalesce(sum(valor), 0) FROM precos_adicional) IS DISTINCT FROM soma_adicional
     OR (SELECT count(*) FROM precos_adicional) <> qtd_preco_adicional
     OR (SELECT count(*) FROM fechamento_pacote_snapshots) <> qtd_snapshot
     OR (SELECT count(*) FROM fechamentos) <> qtd_fechamento
     OR (SELECT count(*) FROM contratos) <> qtd_contrato THEN
    RAISE EXCEPTION '046: preço, fotografia ou contratação mudou.';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM precos_pacote pp
      JOIN tabelas_preco t ON t.id = pp.tabela_preco_id
      JOIN pacotes p ON p.id = pp.pacote_id
     WHERE t.empresa_id IS DISTINCT FROM p.empresa_id
  ) OR EXISTS (
    SELECT 1
      FROM precos_adicional pr
      JOIN tabelas_preco t ON t.id = pr.tabela_preco_id
      JOIN adicionais a ON a.id = pr.adicional_id
     WHERE t.empresa_id IS DISTINCT FROM a.empresa_id
  ) OR EXISTS (
    SELECT 1
      FROM pacote_adicionais pa
      JOIN pacotes p ON p.id = pa.pacote_id
      JOIN adicionais a ON a.id = pa.adicional_id
     WHERE p.empresa_id IS DISTINCT FROM a.empresa_id
  ) THEN
    RAISE EXCEPTION '046: a atribuição deixou vínculo incompatível.'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname IN (
       'pacotes_empresa_imutavel_trg',
       'tabelas_preco_empresa_imutavel_trg',
       'adicionais_empresa_imutavel_trg'
     )
       AND NOT tgisinternal
       AND tgenabled <> 'O'
  ) OR position('current_setting' IN pg_get_functiondef('public.kidmais_036_empresa_pai_imutavel()'::regprocedure)) > 0 THEN
    RAISE EXCEPTION '046: a guarda de empresa do pai não voltou.';
  END IF;

  BEGIN
    UPDATE pacotes
       SET empresa_id = NULL
     WHERE codigo = 'POCKET'
       AND empresa_id = empresa;
    RAISE EXCEPTION '046: a guarda de nulo para empresa ficou aberta.';
  EXCEPTION
    WHEN SQLSTATE '23514' THEN
      IF SQLERRM NOT LIKE '036:%' THEN
        RAISE EXCEPTION '046: a recusa da empresa não é a guarda 036.';
      END IF;
  END;

  IF NOT EXISTS (
    SELECT 1 FROM usuarios_administrativos
     WHERE id = usuario AND ativo AND papel = 'REPRESENTANTE_AUTORIZADO'
  ) THEN
    RAISE EXCEPTION '046: papel ou atividade do usuário mudou.';
  END IF;

  INSERT INTO auditoria (
    ator_tipo, usuario_id, acao, entidade_tipo, entidade_id,
    dados_antes, dados_depois, origem, criado_em
  ) VALUES (
    'USUARIO',
    usuario,
    'ATRIBUICAO_LEGADO_CONTROLADA',
    'EMPRESA',
    empresa,
    jsonb_build_object('empresa_id', NULL),
    jsonb_build_object(
      'pacotes', n_pacote,
      'adicionais', n_adicional,
      'tabelas', n_tabela
    ),
    'HG6_ATRIBUICAO_CONTROLADA',
    clock_timestamp()
  );
END
$mig$;

COMMIT;
