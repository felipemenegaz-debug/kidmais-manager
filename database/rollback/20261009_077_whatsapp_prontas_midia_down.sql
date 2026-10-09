-- Rollback da 077. NÃO EXECUTAR sem autorização explícita (docs/OPERACAO_AGENTES.md).
--
-- *** DESTRUTIVO quando há dados de mídia. Com as duas decisões explícitas (passos 3 e 4) este script APAGA, sem volta
-- *** pelo próprio script: a URL, o tipo e a origem (pronta + versão) de toda resposta já registrada com foto/vídeo (o
-- *** texto/legenda fica); TODAS as mensagens prontas de foto/vídeo, ativas ou arquivadas, de todas as empresas e
-- *** ambientes do banco, com as favoritas delas; e os atalhos novos (salgados, bolos, endereço, localização) das demais.
-- *** Antes: exportar whatsapp_atendimento_mensagens (colunas de mídia) e whatsapp_atendimento_mensagens_prontas(+favoritas)
-- *** e ter backup com restauração comprovada. Reaplicar a 077 depois NÃO recupera esses dados.
--
-- O rollback de código não exige este script: sem as colunas a tela só deixa de oferecer fotos e vídeos (o serviço
-- confere o catálogo a cada uso). Este down remove a estrutura e devolve as restrições da 076 com os nomes originais.
-- Ordem entre migrations: 078 → 077 → 076 → 065 → 060. Este down recusa enquanto qualquer objeto da 078 existir e vem
-- ANTES do down da 076 (que recusa enquanto a 077 existir). A recusa acontece antes de travar ou alterar qualquer coisa.
--
-- Fail closed, numa transação só:
--   1. lock_timeout curto; trava ACCESS EXCLUSIVE nas duas tabelas antes de conferir;
--   2. resposta com mídia ainda na fila (PENDENTE, PROCESSANDO ou ENVIANDO) impede o rollback mesmo com as decisões
--      de descarte: sem as colunas ela sairia só com a legenda (ou vazia). Aguarde o resultado do envio ou encerre a conversa;
--   3. respostas já registradas com mídia: exige exportação prévia e decisão explícita de descarte da URL e da origem:
--      SET LOCAL kidmais.rollback_077_descartar_midias = 'sim';
--   4. mensagens prontas de foto/vídeo (ativas ou arquivadas) ou com os atalhos novos: as restrições da 076 não as
--      aceitam. Exige exportação prévia e decisão explícita:
--      SET LOCAL kidmais.rollback_077_descartar_prontas_midia = 'sim'
--      → as prontas de foto/vídeo são removidas (com as favoritas delas) e os atalhos novos ficam vazios. A remoção vem
--        DEPOIS de tirar a origem das mensagens (a FK não deixaria antes).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$ BEGIN
  IF to_regclass('public.whatsapp_atendimento_mensagens_prontas') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.whatsapp_atendimento_mensagens_prontas'::regclass AND attname = 'midia_url' AND NOT attisdropped) THEN
    RAISE EXCEPTION '077 ausente: nada a remover.';
  END IF;
  -- Revisão final (09/10): com qualquer objeto da 078 ainda aplicado, recusa ANTES de travar ou alterar qualquer coisa.
  -- Sem esta guarda o DROP COLUMN midia_tipo derrubaria junto a FK da 078 (restrição da mesma tabela) e deixaria a 078
  -- pela metade (arquivos, estado/finalidade das prontas, grupos de saída). Ordem: 078 → 077 → 076 → 065 → 060.
  IF to_regclass('public.whatsapp_atendimento_arquivos') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.whatsapp_atendimento_mensagens_prontas'::regclass AND attname IN ('estado', 'arquivo_id', 'finalidade', 'envio_automatico') AND NOT attisdropped)
     OR EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('public.whatsapp_atendimento_mensagens') AND attname IN ('origem_grupo_id', 'midia_arquivo_id', 'fonte') AND NOT attisdropped) THEN
    RAISE EXCEPTION 'Rollback da 077 recusado: a 078 ainda está aplicada (total ou parcialmente). Rode antes o down da 078. Ordem: 078 → 077 → 076 → 065 → 060.';
  END IF;
END $$;

LOCK TABLE whatsapp_atendimento_mensagens_prontas_favoritas, whatsapp_atendimento_mensagens_prontas, whatsapp_atendimento_mensagens IN ACCESS EXCLUSIVE MODE;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM whatsapp_atendimento_mensagens WHERE midia_tipo IS NOT NULL AND estado IN ('PENDENTE', 'PROCESSANDO', 'ENVIANDO')) THEN
    RAISE EXCEPTION 'Rollback da 077 recusado: há resposta com mídia na fila de envio. Aguarde o resultado do envio ou encerre a conversa antes.';
  END IF;
  IF EXISTS (SELECT 1 FROM whatsapp_atendimento_mensagens WHERE midia_tipo IS NOT NULL)
     AND COALESCE(current_setting('kidmais.rollback_077_descartar_midias', true), '') <> 'sim' THEN
    RAISE EXCEPTION 'Rollback da 077 recusado: há respostas enviadas com mídia. Exporte (id, conversa_id, empresa_id, ambiente, midia_tipo, midia_url, midia_pronta_id, midia_pronta_versao) e confirme o descarte com SET LOCAL kidmais.rollback_077_descartar_midias = ''sim''.';
  END IF;
  IF EXISTS (SELECT 1 FROM whatsapp_atendimento_mensagens_prontas WHERE tipo IN ('IMAGEM', 'VIDEO') OR atalho IN ('SALGADOS', 'BOLOS', 'ENDERECO', 'LOCALIZACAO'))
     AND COALESCE(current_setting('kidmais.rollback_077_descartar_prontas_midia', true), '') <> 'sim' THEN
    RAISE EXCEPTION 'Rollback da 077 recusado: há mensagens prontas de foto/vídeo ou com os atalhos novos (as restrições da 076 não as aceitam). Exporte whatsapp_atendimento_mensagens_prontas e confirme com SET LOCAL kidmais.rollback_077_descartar_prontas_midia = ''sim'': as de foto/vídeo são removidas (com as favoritas) e os atalhos novos ficam vazios.';
  END IF;
END $$;

-- Mensagens primeiro: sai a FK da origem (e com ela a dependência da tabela de prontas).
ALTER TABLE whatsapp_atendimento_mensagens
  DROP CONSTRAINT whatsapp_mensagens_midia_pronta,
  DROP CONSTRAINT whatsapp_mensagens_midia_origem,
  DROP CONSTRAINT whatsapp_mensagens_midia_pronta_versao,
  DROP CONSTRAINT whatsapp_mensagens_legenda_limite,
  DROP CONSTRAINT whatsapp_mensagens_midia_so_saida,
  DROP CONSTRAINT whatsapp_mensagens_midia_par,
  DROP COLUMN midia_pronta_versao,
  DROP COLUMN midia_pronta_id,
  DROP COLUMN midia_url,
  DROP COLUMN midia_tipo;

-- Só com a decisão do passo 4 (sem ela, o bloco acima já recusou se houvesse linhas): nada mais muda.
DELETE FROM whatsapp_atendimento_mensagens_prontas_favoritas f
  USING whatsapp_atendimento_mensagens_prontas p
  WHERE p.id = f.mensagem_pronta_id AND p.tipo IN ('IMAGEM', 'VIDEO');
DELETE FROM whatsapp_atendimento_mensagens_prontas WHERE tipo IN ('IMAGEM', 'VIDEO');
UPDATE whatsapp_atendimento_mensagens_prontas SET atalho = NULL, versao = versao + 1, atualizada_em = clock_timestamp()
  WHERE atalho IN ('SALGADOS', 'BOLOS', 'ENDERECO', 'LOCALIZACAO');

ALTER TABLE whatsapp_atendimento_mensagens_prontas
  DROP CONSTRAINT whatsapp_prontas_legenda_limite,
  DROP CONSTRAINT whatsapp_prontas_midia_por_tipo,
  DROP COLUMN midia_url,
  DROP CONSTRAINT whatsapp_prontas_atalho,
  DROP CONSTRAINT whatsapp_prontas_tipo,
  ADD CONSTRAINT whatsapp_atendimento_mensagens_prontas_tipo_check CHECK (tipo IN ('TEXTO', 'LINK', 'LINK_FECHAMENTO_INDIVIDUAL')),
  ADD CONSTRAINT whatsapp_atendimento_mensagens_prontas_atalho_check CHECK (atalho IN ('TABELA_PRECOS', 'DISPONIBILIDADE_FECHAMENTO'));

COMMIT;
