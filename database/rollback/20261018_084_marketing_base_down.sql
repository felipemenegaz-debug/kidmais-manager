-- Rollback da 084 (Marketing). NÃO EXECUTAR sem autorização explícita (docs/OPERACAO_AGENTES.md).
--
-- Rollback operacional recomendado: desligar MARKETING_SITES_PUBLICOS e MARKETING_DOMINIOS_PERSONALIZADOS e voltar o
-- código anterior. O schema da 084 é aditivo e pode ficar: nada do código anterior o lê.
--
-- Este down existe só para bancos descartáveis. Ele RECUSA enquanto houver contato captado, atribuição, campanha com
-- histórico de atribuição ou versão publicada: contatos e evidências não são apagados por rollback. Exige a 085 ausente
-- (desfazer a 085 antes). Fail closed, numa transação só.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$ BEGIN
  IF to_regclass('public.marketing_campanhas') IS NULL THEN RAISE EXCEPTION '084 ausente: nada a remover.'; END IF;
  IF to_regclass('public.marketing_automacao_regras') IS NOT NULL THEN RAISE EXCEPTION '084: desfazer a 085 antes.'; END IF;
END $$;

LOCK TABLE marketing_contatos, marketing_atribuicoes, marketing_site_versoes, marketing_eventos IN ACCESS EXCLUSIVE MODE;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM marketing_contatos) OR EXISTS (SELECT 1 FROM marketing_atribuicoes)
     OR EXISTS (SELECT 1 FROM marketing_site_versoes) OR EXISTS (SELECT 1 FROM marketing_eventos) THEN
    RAISE EXCEPTION '084: há contatos, atribuições, versões publicadas ou eventos; rollback recusado (use o rollback operacional).';
  END IF;
END $$;

DROP TABLE marketing_eventos;
DROP TABLE marketing_atribuicoes;
DROP TABLE marketing_contatos;
DROP TABLE marketing_campanhas;
DROP TABLE marketing_dns_simulado;
DROP TABLE marketing_dominios;
DROP TABLE marketing_site_imagens;
ALTER TABLE marketing_sites DROP CONSTRAINT marketing_sites_versao_fk;
DROP TABLE marketing_site_versoes;
DROP TABLE marketing_sites;
DROP TABLE marketing_origens_opcoes;
DROP TABLE marketing_membership_capacidades;
DROP FUNCTION kidmais084_atribuicao_controle();
DROP FUNCTION kidmais084_contato_tenant();
DROP FUNCTION kidmais084_campanha_controle();
DROP FUNCTION kidmais084_dominio_controle();
DROP FUNCTION kidmais084_imagem_controle();
DROP FUNCTION kidmais084_somente_insercao();
DROP FUNCTION kidmais084_capacidade_imutavel();

COMMIT;
