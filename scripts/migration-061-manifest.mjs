// Offline generator for the 061 rollback and postcheck. Run after editing migration 061; never connects to a database.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
const ler = (f) => fs.readFileSync(f, 'utf8').replaceAll('\r', '');
const m019 = ler('database/migrations/20260915_019_festa_formalizacao.sql');
const m057 = ler('database/migrations/20260929_057_assinatura_contrato_empresa.sql');
const m061 = ler('database/migrations/20261002_061_contratos_importados_integracao.sql');
const re = (nome) => new RegExp(String.raw`CREATE (?:OR REPLACE )?FUNCTION (?:public\.)?` + nome + String.raw`\([\s\S]*?AS \$\$([\s\S]*?)\$\$;`);
const definicao = (sql, nome) => {
  const m = sql.match(re(nome));
  if (!m) throw Error('sem ' + nome);
  return m[0].replace(/^CREATE (OR REPLACE )?FUNCTION (public\.)?/, 'CREATE OR REPLACE FUNCTION public.');
};
const corpo = (sql, nome) => sql.match(re(nome))[1];
const sha = (s) => createHash('sha256').update(s).digest('hex');
const md5 = (s) => createHash('md5').update(s).digest('hex');

/** Funções da 019 que a 061 substitui (assinatura regprocedure) — e nenhuma outra. */
const SUBSTITUIDAS_019 = [['kidmais019_formalizacao', '(uuid,uuid)'], ['kidmais_ocupacoes_operacionais', '(date,date)'], ['kidmais_validar_agenda_revisao', '()']];
const substituidasNa061 = [...m061.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\(/g)].map((x) => x[1]).filter((n) => n !== 'kidmais_validar_fluxo_contrato');
if (substituidasNa061.join() !== SUBSTITUIDAS_019.map(([n]) => n).join()) throw Error(`061 substitui ${substituidasNa061.join()}`);
const hashSql = (nome, assinatura, hash) => `(SELECT encode(sha256(convert_to(replace(prosrc, E'\\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = 'public.${nome}${assinatura}'::regprocedure) IS DISTINCT FROM '${hash}'`;
const conferir = (fonte) => SUBSTITUIDAS_019.map(([n, a]) => `     OR ${hashSql(n, a, sha(corpo(fonte, n)))}`).join('\n');
// kidmais019_ocupa NÃO é substituída: a reserva do contrato histórico é vigente como qualquer outra.
const ocupa019 = `     OR ${hashSql('kidmais019_ocupa', '(uuid)', sha(corpo(m019, 'kidmais019_ocupa')))}`;

const out = `-- Rollback 061 — só antes de qualquer integração. Nunca remove contrato, festa ou financeiro integrados.
-- NÃO APLICADO. Exige autorização explícita (docs/OPERACAO_AGENTES.md).
-- Gerado offline por scripts/migration-061-manifest.mjs: restaura byte a byte ${SUBSTITUIDAS_019.map(([n]) => n).join(', ')} (019)
-- e kidmais_validar_fluxo_contrato (057), e confere os hashes no fim.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_catalog;
LOCK TABLE public.contrato_importacoes, public.contrato_importacao_financeiro, public.fechamentos, public.contratos,
  public.contrato_versoes, public.festas IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM public.contrato_importacoes) OR EXISTS(SELECT 1 FROM public.contrato_importacao_financeiro)
     OR EXISTS(SELECT 1 FROM public.fechamentos WHERE origem_fechamento = 'IMPORTACAO_HISTORICA')
     OR EXISTS(SELECT 1 FROM public.contrato_versoes WHERE aceite_metodo = 'CONFERENCIA_PAPEL')
     OR EXISTS(SELECT 1 FROM public.festas WHERE origem_criacao = 'IMPORTACAO_HISTORICA') THEN
    RAISE EXCEPTION 'Rollback 061 recusado: há contratos históricos integrados; correção forward necessária.';
  END IF;
END $$;
DROP TRIGGER festa019_061_origem_importacao ON public.festas;
DROP TRIGGER fechamentos_061_vinculo_trg ON public.fechamentos;
DROP TRIGGER fechamentos_061_origem_trg ON public.fechamentos;
${SUBSTITUIDAS_019.map(([n]) => definicao(m019, n)).join('\n')}
${definicao(m057, 'kidmais_validar_fluxo_contrato')}
DROP TABLE public.contrato_importacao_financeiro;
DROP TABLE public.contrato_importacoes;
DROP FUNCTION public.kidmais061_historico_passado(uuid);
DROP FUNCTION public.kidmais061_conferencia_historica(uuid, uuid);
DROP FUNCTION public.kidmais061_exigir_vinculo();
DROP FUNCTION public.kidmais061_origem_fechamento();
DROP FUNCTION public.kidmais061_validar_financeiro();
DROP FUNCTION public.kidmais061_validar_vinculo();
DROP FUNCTION public.kidmais061_imutavel();
ALTER TABLE public.festas DROP CONSTRAINT festa019_autoria_check,
  ADD CONSTRAINT festa019_autoria_check CHECK (
 (origem_criacao='MANUAL_HISTORICA' AND criado_por IS NOT NULL) OR
 (origem_criacao='AUTOMATICA_FORMALIZACAO' AND criado_por IS NULL));
ALTER TABLE public.contrato_versoes DROP CONSTRAINT contrato_versoes_assinatura_documento_check,
  ADD CONSTRAINT contrato_versoes_assinatura_documento_check CHECK (
    status <> 'ASSINADA' OR (documento_template_versao IS NOT NULL AND documento_pdf_hash IS NOT NULL AND aceite_metodo IS NOT NULL)),
  DROP CONSTRAINT contrato_versoes_aceite_metodo_check,
  ADD CONSTRAINT contrato_versoes_aceite_metodo_check CHECK (aceite_metodo IS NULL OR aceite_metodo IN ('OTP'));
ALTER TABLE public.fechamentos DROP CONSTRAINT fechamentos_origem_check,
  ADD CONSTRAINT fechamentos_origem_check CHECK (origem_fechamento IN ('CLIENTE', 'ATENDIMENTO_KIDMAIS'));
DO $$ BEGIN
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public.kidmais_validar_fluxo_contrato()'::regprocedure) IS DISTINCT FROM '${md5(corpo(m057, 'kidmais_validar_fluxo_contrato'))}'
${conferir(m019)}
${ocupa019} THEN
    RAISE EXCEPTION 'Rollback 061: corpos restaurados divergem de 019/057.';
  END IF;
END $$;
COMMIT;
`;
fs.writeFileSync('database/rollback/20261002_061_contratos_importados_integracao_down.sql', out);

const postcheck = `-- Postcheck da 061 (somente leitura). Gerado offline por scripts/migration-061-manifest.mjs.
-- Tabelas e gatilhos ativos, funções com corpo exato da 061 (e kidmais019_ocupa intacta), restrições validadas e
-- nenhuma integração criada pela instalação.
DO $$
DECLARE
  item text;
BEGIN
  IF to_regclass('public.contrato_importacoes') IS NULL OR to_regclass('public.contrato_importacao_financeiro') IS NULL THEN
    RAISE EXCEPTION 'postcheck 061: tabelas ausentes';
  END IF;
  FOREACH item IN ARRAY ARRAY['contrato_importacoes_imutavel_trg', 'contrato_importacao_financeiro_imutavel_trg',
    'contrato_importacoes_truncate_trg', 'contrato_importacao_financeiro_truncate_trg', 'contrato_importacoes_validar_trg',
    'contrato_importacao_financeiro_validar_trg', 'fechamentos_061_origem_trg', 'fechamentos_061_vinculo_trg',
    'contrato_importacoes_061_financeiro_trg', 'festa019_061_origem_importacao'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = item AND tgenabled = 'O' AND NOT tgisinternal) THEN
      RAISE EXCEPTION 'postcheck 061: gatilho % ausente ou desligado', item;
    END IF;
  END LOOP;
  FOREACH item IN ARRAY ARRAY['kidmais061_imutavel', 'kidmais061_validar_vinculo', 'kidmais061_validar_financeiro',
    'kidmais061_origem_fechamento', 'kidmais061_exigir_vinculo', 'kidmais061_conferencia_historica', 'kidmais061_historico_passado'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = item AND NOT p.prosecdef AND p.proconfig @> ARRAY['search_path=public, pg_catalog']) THEN
      RAISE EXCEPTION 'postcheck 061: função % ausente, SECURITY DEFINER ou sem search_path fixo', item;
    END IF;
  END LOOP;
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public.kidmais_validar_fluxo_contrato()'::regprocedure) IS DISTINCT FROM '${md5(corpo(m061, 'kidmais_validar_fluxo_contrato'))}'
${conferir(m061)}
${ocupa019} THEN
    RAISE EXCEPTION 'postcheck 061: corpos de validação/formalização/agenda divergem da 061 (ou a ocupação da 019 mudou)';
  END IF;
  FOREACH item IN ARRAY ARRAY['fechamentos_origem_check', 'contrato_versoes_aceite_metodo_check', 'contrato_versoes_assinatura_documento_check',
    'festa019_autoria_check', 'contrato_importacao_financeiro_soma_ck', 'contrato_importacao_financeiro_situacao_ck'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = item AND convalidated) THEN
      RAISE EXCEPTION 'postcheck 061: restrição % ausente ou não validada', item;
    END IF;
  END LOOP;
  IF pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname = 'fechamentos_origem_check')) NOT LIKE '%IMPORTACAO_HISTORICA%'
     OR pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname = 'contrato_versoes_aceite_metodo_check')) NOT LIKE '%CONFERENCIA_PAPEL%' THEN
    RAISE EXCEPTION 'postcheck 061: restrições de origem não atualizadas';
  END IF;
  IF EXISTS (SELECT 1 FROM public.contrato_importacoes) OR EXISTS (SELECT 1 FROM public.fechamentos WHERE origem_fechamento = 'IMPORTACAO_HISTORICA') THEN
    RAISE EXCEPTION 'postcheck 061: a instalação não pode integrar contratos (sem backfill)';
  END IF;
END $$;
SELECT 'postcheck 061 OK' AS resultado;
`;
fs.writeFileSync('database/checks/20261002_061_postcheck.sql', postcheck);
console.log(JSON.stringify(Object.fromEntries([...SUBSTITUIDAS_019.map(([n]) => [n, { '019': sha(corpo(m019, n)), '061': sha(corpo(m061, n)) }]),
  ['validador', { '057': md5(corpo(m057, 'kidmais_validar_fluxo_contrato')), '061': md5(corpo(m061, 'kidmais_validar_fluxo_contrato')) }]]), null, 1));
