-- Desfaz a 056 só quando nada criado depois dela se perderia. Ordem: primeiro a aplicação volta a uma versão que
-- não lê membership.papel, festa_membership_capacidades nem festa_areas.empresa_id; depois este arquivo.
-- Recusa (sem parâmetro que force) se:
--   - a 057 está aplicada (ela depende de memberships.papel);
--   - algum papel de membership diverge do papel da identidade (papel por empresa seria perdido);
--   - alguma capacidade de membership ativa não existe como capacidade global ativa (concessão nova);
--   - alguma capacidade de membership foi revogada depois da 056 (revogação nova);
--   - dois nomes de área coincidem entre empresas (a unicidade global não volta);
--   - alguma área tem estabelecimento (escopo de unidade seria perdido).
BEGIN;

SET LOCAL lock_timeout = '5s';

DO $$ BEGIN
  IF to_regclass('public.empresa_membership_capacidades') IS NOT NULL THEN
    RAISE EXCEPTION '056 down: a 057 está aplicada (assinatura por membership); desfaça a 057 antes.';
  END IF;
END $$;

LOCK TABLE public.memberships, public.festa_areas, public.festa_usuario_capacidades, public.festa_membership_capacidades,
  public.festa_tarefas, public.festa_pendencias IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.memberships m JOIN public.usuarios_administrativos u ON u.id = m.usuario_id WHERE m.papel <> u.papel) THEN
    RAISE EXCEPTION '056 down: há papel por empresa diferente do papel da identidade. Rollback recusado.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.festa_membership_capacidades n JOIN public.memberships m ON m.id = n.membership_id
     WHERE n.revogado_em IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.festa_usuario_capacidades c WHERE c.usuario_id = m.usuario_id AND c.capacidade = n.capacidade AND c.revogado_em IS NULL)
  ) OR EXISTS (SELECT 1 FROM public.festa_membership_capacidades WHERE revogado_em IS NOT NULL) THEN
    RAISE EXCEPTION '056 down: há concessão ou revogação de capacidade feita por empresa. Rollback recusado.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.festa_areas GROUP BY lower(btrim(nome)) HAVING count(*) > 1)
     OR EXISTS (SELECT 1 FROM public.festa_areas WHERE estabelecimento_id IS NOT NULL) THEN
    RAISE EXCEPTION '056 down: áreas por empresa/estabelecimento não cabem na configuração global. Rollback recusado.';
  END IF;
END $$;

DROP TRIGGER kidmais_056_festa_tarefas_empresa_trg ON public.festa_tarefas;
DROP TRIGGER kidmais_056_festa_pendencias_empresa_trg ON public.festa_pendencias;
DROP FUNCTION public.kidmais_056_festa_filho_empresa();

DROP TRIGGER kidmais_056_area_escopo_imutavel_trg ON public.festa_areas;
DROP FUNCTION public.kidmais_056_area_escopo_imutavel();
DROP INDEX public.kidmais_056_festa_areas_nome_uk;
ALTER TABLE public.festa_areas
  DROP CONSTRAINT kidmais_056_festa_areas_estabelecimento_fk,
  DROP CONSTRAINT kidmais_056_festa_areas_empresa_fk,
  DROP CONSTRAINT kidmais_056_festa_areas_empresa_id_uk,
  DROP COLUMN estabelecimento_id,
  DROP COLUMN empresa_id;
CREATE UNIQUE INDEX festa_areas_nome_uk ON public.festa_areas (lower(trim(nome)));

DROP TRIGGER kidmais_056_capacidade_global_congelada_trg ON public.festa_usuario_capacidades;
DROP FUNCTION public.kidmais_056_capacidade_global_congelada();
DROP TABLE public.festa_membership_capacidades;
DROP FUNCTION public.kidmais_056_fmc_imutavel();

DROP TRIGGER kidmais_056_membership_papel_trg ON public.memberships;
DROP FUNCTION public.kidmais_056_membership_papel_padrao();
ALTER TABLE public.memberships DROP CONSTRAINT kidmais_056_memberships_papel_ck, DROP COLUMN papel;

COMMIT;
