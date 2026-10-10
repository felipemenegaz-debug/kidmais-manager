-- Rollback da 078 (Wall-e). NÃO EXECUTAR sem autorização explícita (docs/OPERACAO_AGENTES.md).
--
-- *** DESTRUTIVO quando há dados dos recursos novos. Com a decisão explícita (passo 3) este script APAGA, sem volta pelo
-- *** próprio script: todos os arquivos próprios da biblioteca (fotos, vídeos e PDFs) de todas as empresas e ambientes
-- *** do banco; as mensagens prontas de PDF ou com arquivo próprio (com as favoritas); a mídia (tipo, arquivo, nome e
-- *** origem) das respostas que usaram arquivo próprio ou PDF (o texto/legenda fica); as saídas extras de uma mesma
-- *** mensagem recebida perdem o agrupamento (continuam no histórico); a fonte das respostas; a memória e o resumo de
-- *** passagem das conversas. Rascunhos são ARQUIVADOS (no código anterior apareceriam como ativos).
-- *** Antes: exportar whatsapp_atendimento_arquivos, as colunas novas de mensagens/prontas/conversas e ter backup com
-- *** restauração comprovada. Reaplicar a 078 depois NÃO recupera esses dados.
--
-- Ordem: 078 → 077b → 077a → 065 → 060. Este down vem ANTES do down da 077b, que recusa enquanto qualquer objeto da 078
-- existir (guarda explícita; a FK do arquivo sozinha não impedia o down da 077b).
-- Fail closed, numa transação só:
--   1. lock_timeout curto; ACCESS EXCLUSIVE nas tabelas antes de conferir;
--   2. resposta com arquivo próprio/PDF na fila (PENDENTE, PROCESSANDO ou ENVIANDO) impede o rollback sempre;
--   3. qualquer dado dos recursos novos exige: SET LOCAL kidmais.rollback_078_descartar = 'sim';
--   4. as restrições da 077b voltam exatamente como eram (mesmos nomes e definições).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$ BEGIN
  IF to_regclass('public.whatsapp_atendimento_arquivos') IS NULL THEN
    RAISE EXCEPTION '078 ausente: nada a remover.';
  END IF;
END $$;

LOCK TABLE whatsapp_atendimento_mensagens_prontas_favoritas, whatsapp_atendimento_mensagens_prontas, whatsapp_atendimento_mensagens,
  whatsapp_atendimento_conversas, whatsapp_atendimento_arquivos IN ACCESS EXCLUSIVE MODE;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM whatsapp_atendimento_mensagens WHERE (midia_arquivo_id IS NOT NULL OR midia_tipo = 'DOCUMENTO') AND estado IN ('PENDENTE', 'PROCESSANDO', 'ENVIANDO')) THEN
    RAISE EXCEPTION 'Rollback da 078 recusado: há resposta com arquivo próprio ou PDF na fila de envio. Aguarde o resultado do envio ou encerre a conversa antes.';
  END IF;
  IF (EXISTS (SELECT 1 FROM whatsapp_atendimento_arquivos)
      OR EXISTS (SELECT 1 FROM whatsapp_atendimento_mensagens WHERE midia_arquivo_id IS NOT NULL OR midia_tipo = 'DOCUMENTO' OR origem_grupo_id IS NOT NULL OR fonte IS NOT NULL)
      OR EXISTS (SELECT 1 FROM whatsapp_atendimento_mensagens_prontas WHERE arquivo_id IS NOT NULL OR tipo = 'DOCUMENTO' OR estado = 'RASCUNHO' OR envio_automatico
                  OR finalidade IS NOT NULL OR pacote_codigo IS NOT NULL OR estabelecimento_id IS NOT NULL)
      OR EXISTS (SELECT 1 FROM whatsapp_atendimento_conversas WHERE contexto <> '{}'::jsonb OR passagem IS NOT NULL))
     AND COALESCE(current_setting('kidmais.rollback_078_descartar', true), '') <> 'sim' THEN
    RAISE EXCEPTION 'Rollback da 078 recusado: há dados dos recursos do Wall-e (arquivos, PDFs, rascunhos, autorização automática, várias saídas, fonte, memória ou passagem). Exporte-os e confirme o descarte com SET LOCAL kidmais.rollback_078_descartar = ''sim''.';
  END IF;
END $$;

-- Mensagens: sem mídia de arquivo próprio/PDF (o texto fica) e sem as colunas novas.
UPDATE whatsapp_atendimento_mensagens SET midia_tipo = NULL, midia_arquivo_id = NULL, midia_nome = NULL, midia_pronta_id = NULL, midia_pronta_versao = NULL
  WHERE midia_arquivo_id IS NOT NULL OR midia_tipo = 'DOCUMENTO';
ALTER TABLE whatsapp_atendimento_mensagens
  DROP CONSTRAINT whatsapp_mensagens_midia_arquivo,
  DROP CONSTRAINT whatsapp_mensagens_origem_grupo,
  DROP CONSTRAINT whatsapp_mensagens_origem_grupo_uk,
  DROP CONSTRAINT whatsapp_mensagens_midia_par,
  DROP CONSTRAINT whatsapp_mensagens_midia_tipo,
  DROP CONSTRAINT whatsapp_mensagens_legenda_limite,
  DROP COLUMN fonte,
  DROP COLUMN midia_nome,
  DROP COLUMN midia_arquivo_id,
  DROP COLUMN ordem,
  DROP COLUMN origem_grupo_id,
  ADD CONSTRAINT whatsapp_mensagens_midia_tipo CHECK (midia_tipo IN ('IMAGEM', 'VIDEO')),
  ADD CONSTRAINT whatsapp_mensagens_midia_par CHECK ((midia_tipo IS NULL) = (midia_url IS NULL)),
  ADD CONSTRAINT whatsapp_mensagens_legenda_limite CHECK (midia_tipo IS NULL OR texto IS NULL OR length(texto) <= 1024);

-- Prontas: sem PDF/arquivo próprio (com as favoritas), rascunhos arquivados, sem as colunas novas.
DELETE FROM whatsapp_atendimento_mensagens_prontas_favoritas f USING whatsapp_atendimento_mensagens_prontas p
  WHERE p.id = f.mensagem_pronta_id AND (p.arquivo_id IS NOT NULL OR p.tipo = 'DOCUMENTO');
DELETE FROM whatsapp_atendimento_mensagens_prontas WHERE arquivo_id IS NOT NULL OR tipo = 'DOCUMENTO';
UPDATE whatsapp_atendimento_mensagens_prontas SET ativa = false, atalho = NULL, estado = 'ARQUIVADA', versao = versao + 1, atualizada_em = clock_timestamp()
  WHERE estado = 'RASCUNHO';
DROP INDEX whatsapp_prontas_automaticas;
ALTER TABLE whatsapp_atendimento_mensagens_prontas
  DROP CONSTRAINT whatsapp_prontas_arquivo,
  DROP CONSTRAINT whatsapp_prontas_estabelecimento,
  DROP CONSTRAINT whatsapp_prontas_pacote_codigo,
  DROP CONSTRAINT whatsapp_prontas_automatico_finalidade,
  DROP CONSTRAINT whatsapp_prontas_finalidade,
  DROP CONSTRAINT whatsapp_prontas_estado_ativa,
  DROP CONSTRAINT whatsapp_prontas_estado,
  DROP CONSTRAINT whatsapp_prontas_legenda_limite,
  DROP CONSTRAINT whatsapp_prontas_midia_por_tipo,
  DROP CONSTRAINT whatsapp_prontas_tipo,
  DROP COLUMN arquivo_id,
  DROP COLUMN estabelecimento_id,
  DROP COLUMN pacote_codigo,
  DROP COLUMN finalidade,
  DROP COLUMN envio_automatico,
  DROP COLUMN estado,
  ADD CONSTRAINT whatsapp_prontas_tipo CHECK (tipo IN ('TEXTO', 'LINK', 'LINK_FECHAMENTO_INDIVIDUAL', 'IMAGEM', 'VIDEO')),
  ADD CONSTRAINT whatsapp_prontas_midia_por_tipo CHECK ((tipo IN ('IMAGEM', 'VIDEO')) = (midia_url IS NOT NULL)),
  ADD CONSTRAINT whatsapp_prontas_legenda_limite CHECK (tipo NOT IN ('IMAGEM', 'VIDEO') OR length(texto) <= 1024);

-- Conversas e arquivos.
ALTER TABLE whatsapp_atendimento_conversas DROP COLUMN passagem, DROP COLUMN contexto;
DROP TABLE whatsapp_atendimento_arquivos;
DROP FUNCTION kidmais078_arquivo_imutavel();

COMMIT;
