// Offline generator for the 062 precheck, postcheck and rollback. Run after editing migration 019, 061 or 062;
// never connects to a database.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
const ler = (f) => fs.readFileSync(f, 'utf8').replaceAll('\r', '');
const m019 = ler('database/migrations/20260915_019_festa_formalizacao.sql');
const m061 = ler('database/migrations/20261002_061_contratos_importados_integracao.sql');
const m062 = ler('database/migrations/20261002_062_agenda_empresa_unidade.sql');
const re = (nome) => new RegExp(String.raw`CREATE (?:OR REPLACE )?FUNCTION (?:public\.)?` + nome + String.raw`\([\s\S]*?AS \$\$([\s\S]*?)\$\$;`);
const definicao = (sql, nome) => {
  const m = sql.match(re(nome));
  if (!m) throw Error('sem ' + nome);
  return m[0].replace(/^CREATE (OR REPLACE )?FUNCTION (public\.)?/, 'CREATE OR REPLACE FUNCTION public.');
};
const corpo = (sql, nome) => {
  const m = sql.match(re(nome));
  if (!m) throw Error('sem ' + nome);
  return m[1];
};
const sha = (s) => createHash('sha256').update(s).digest('hex');
const hashSql = (nome, assinatura) => `(SELECT encode(sha256(convert_to(replace(prosrc, E'\\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = 'public.${nome}${assinatura}'::regprocedure)`;

/** Corpos que a 062 substitui e de onde vêm os anteriores (019 ou 061) — e nenhum outro. */
const SUBSTITUIDAS = [
  ['kidmais019_validar_destino', '(uuid)', m019],
  ['kidmais019_validar_contrato', '()', m019],
  ['kidmais_proteger_bloqueio_revisao', '()', m019],
  ['kidmais_validar_agenda_revisao', '()', m061],
];
/** Mantidas pela 062 (conferidas antes e depois): ocupação 019, ocupações e formalização da 061. */
const MANTIDAS = [
  ['kidmais019_ocupa', '(uuid)', m019],
  ['kidmais_ocupacoes_operacionais', '(date,date)', m061],
  ['kidmais019_formalizacao', '(uuid,uuid)', m061],
];
const substituidasNa062 = [...m062.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\(/g)].map((x) => x[1]);
if (substituidasNa062.join() !== SUBSTITUIDAS.map(([n]) => n).join()) throw Error(`062 substitui ${substituidasNa062.join()}`);
/** Função da ESTRUTURA (guarda do histórico de habilitação): fica no rollback suave. */
const ESTRUTURA_FUNCOES = [['kidmais062_habilitacao_guard', '()']];
/** Regras: removidas pelo rollback e recriadas na reaplicação. */
const NOVAS = [
  ['kidmais062_mesmo_recurso', '(uuid,uuid,uuid,uuid)'], ['kidmais062_bloqueio_aplica', '(uuid,uuid,uuid,uuid)'],
  ['kidmais062_operador_agenda', '(uuid,uuid,text)'], ['kidmais062_unidade_agendavel', '(uuid,uuid)'], ['kidmais062_travar_habilitacao', '(uuid)'],
  ['kidmais062_ocupacoes_escopo', '(date,date)'], ['kidmais062_unidade_fechamento', '()'], ['kidmais062_fluxo_unidade', '()'], ['kidmais062_unidade_ativa', '()'],
  ['kidmais062_revisao_unidade', '()'], ['kidmais062_vinculo_unidade', '()'],
];
const criadasNa062 = [...m062.matchAll(/CREATE FUNCTION public\.(\w+)\(/g)].map((x) => x[1]);
if (criadasNa062.join() !== [...ESTRUTURA_FUNCOES, ...NOVAS].map(([n]) => n).join()) throw Error(`062 cria ${criadasNa062.join()}`);
/** Gatilhos das regras (removidos pelo rollback). */
const GATILHOS = [
  ['fechamentos_062_unidade_trg', 'fechamentos'], ['contrato_fluxos_062_unidade_trg', 'contrato_fluxos'], ['bloqueios_agenda_062_unidade_trg', 'bloqueios_agenda'],
  ['configuracao_agenda_062_unidade_trg', 'configuracao_agenda'], ['fechamento_revisoes_062_unidade_trg', 'fechamento_revisoes'],
  ['contrato_importacoes_062_unidade_trg', 'contrato_importacoes'],
];
/** Gatilhos da estrutura (guarda do histórico de habilitação): ficam no rollback suave. */
const GATILHOS_ESTRUTURA = [
  ['agenda_062_unidades_habilitacao_guard_trg', 'agenda_062_unidades_habilitacao'], ['agenda_062_unidades_habilitacao_truncate_trg', 'agenda_062_unidades_habilitacao'],
];
for (const [g] of [...GATILHOS, ...GATILHOS_ESTRUTURA]) if (!m062.includes(`CREATE TRIGGER ${g} `)) throw Error('sem gatilho ' + g);
const RESTRICOES = ['fechamentos_062_estabelecimento_fk', 'fechamentos_062_unidade_exige_empresa_check',
  'bloqueios_agenda_062_estabelecimento_fk', 'bloqueios_agenda_062_unidade_exige_empresa_check',
  'configuracao_agenda_062_estabelecimento_fk', 'configuracao_agenda_062_unidade_exige_empresa_check'];
for (const r of RESTRICOES) if (!m062.includes(r)) throw Error('sem restrição ' + r);

const divergentes = (lista, fonte) => lista.map(([n, a, f]) => `${hashSql(n, a)} IS DISTINCT FROM '${sha(corpo(fonte ?? f, n))}'`).join('\n     OR ');

// Precheck: o mesmo teste do topo da migration, sem escrever, com relatório do que a 062 NÃO faz.
const precheck = `-- 062 precheck (somente leitura). Gerado offline por scripts/migration-062-manifest.mjs.
-- Pré-requisitos (061 aplicada), corpos anteriores exatos (019/061) e relatório do que a migration NÃO faz:
-- nenhuma contratação ou bloqueio existente recebe empresa/unidade (D2/D3 ficam em database/repairs).
DO $$
DECLARE
  sem_unidade integer; bloqueios integer; turnos integer;
BEGIN
  IF to_regclass('public.contrato_importacoes') IS NULL OR to_regprocedure('public.kidmais061_historico_passado(uuid)') IS NULL THEN
    RAISE EXCEPTION '062 precheck: 061 não aplicada.';
  END IF;
  IF to_regclass('public.estabelecimentos') IS NULL THEN RAISE EXCEPTION '062 precheck: 043 não aplicada.'; END IF;
  IF to_regprocedure('public.kidmais062_ocupacoes_escopo(date,date)') IS NOT NULL THEN RAISE EXCEPTION '062 precheck: já aplicada.'; END IF;
  IF ${divergentes(SUBSTITUIDAS)}
     OR ${divergentes(MANTIDAS)} THEN
    RAISE EXCEPTION '062 precheck: corpos de agenda divergem da 019/061.';
  END IF;
  SELECT count(*) INTO sem_unidade FROM public.empresas e WHERE e.status = 'ATIVA'
    AND NOT EXISTS (SELECT 1 FROM public.estabelecimentos u WHERE u.empresa_id = e.id AND u.status <> 'DESATIVADO');
  SELECT count(*) INTO bloqueios FROM public.bloqueios_agenda WHERE ativo;
  SELECT count(*) INTO turnos FROM public.configuracao_agenda WHERE ativo;
  RAISE NOTICE '062 precheck: % empresa(s) ativa(s) sem unidade (D2: reparo Unidade principal e decisões por contratação); % bloqueio(s) ativo(s) continuam globais até resolução (D3); % turno(s) ativo(s) ficam como modelos globais (D5).', sem_unidade, bloqueios, turnos;
END $$;
SELECT '062 precheck OK' AS resultado;
`;
fs.writeFileSync('database/checks/20261002_062_precheck.sql', precheck);

const postcheck = `-- Postcheck da 062 (somente leitura). Gerado offline por scripts/migration-062-manifest.mjs.
-- Estrutura de escopo, regras com corpo exato da 062, ocupação/formalização/ocupações intactas (019/061), gatilhos
-- ativos e, na primeira instalação, nenhum escopo atribuído a dado existente.
DO $$
DECLARE
  item text;
BEGIN
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND (
      (table_name = 'fechamentos' AND column_name = 'estabelecimento_id')
      OR (table_name IN ('bloqueios_agenda', 'configuracao_agenda') AND column_name IN ('empresa_id', 'estabelecimento_id')))) <> 5
     OR to_regclass('public.agenda_062_bloqueios_resolucao') IS NULL
     OR to_regclass('public.agenda_062_fechamentos_resolucao') IS NULL
     OR to_regclass('public.agenda_062_unidades_habilitacao') IS NULL
     OR to_regclass('public.agenda_062_unidades_habilitacao_vigente_uk') IS NULL
     OR to_regclass('public.configuracao_agenda_062_codigo_escopo_uk') IS NULL
     OR EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'configuracao_agenda_codigo_uk') THEN
    RAISE EXCEPTION 'postcheck 062: estrutura de escopo ausente ou código de turno ainda único globalmente';
  END IF;
  FOREACH item IN ARRAY ARRAY[${RESTRICOES.map((r) => `'${r}'`).join(', ')}] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = item AND convalidated) THEN
      RAISE EXCEPTION 'postcheck 062: restrição % ausente ou não validada', item;
    END IF;
  END LOOP;
  FOREACH item IN ARRAY ARRAY[${[...GATILHOS, ...GATILHOS_ESTRUTURA].map(([g]) => `'${g}'`).join(', ')}] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = item AND tgenabled = 'O' AND NOT tgisinternal) THEN
      RAISE EXCEPTION 'postcheck 062: gatilho % ausente ou desligado', item;
    END IF;
  END LOOP;
  FOREACH item IN ARRAY ARRAY[${[...ESTRUTURA_FUNCOES, ...NOVAS].map(([n, a]) => `'public.${n}${a}'`).join(', ')}] LOOP
    IF to_regprocedure(item) IS NULL OR (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure(item)) THEN
      RAISE EXCEPTION 'postcheck 062: função % ausente ou SECURITY DEFINER', item;
    END IF;
  END LOOP;
  IF ${divergentes(SUBSTITUIDAS, m062)}
     OR ${divergentes(MANTIDAS)}
     OR ${hashSql('kidmais062_ocupacoes_escopo', '(date,date)')} IS DISTINCT FROM '${sha(corpo(m062, 'kidmais062_ocupacoes_escopo'))}' THEN
    RAISE EXCEPTION 'postcheck 062: corpos de agenda divergem da 062 (ou ocupação/formalização/ocupações mudaram)';
  END IF;
END $$;
-- Relatório (não falha): o que segue com o alcance anterior e espera decisão explícita (D2/D3).
SELECT (SELECT count(*) FROM public.fechamentos WHERE empresa_id IS NOT NULL AND estabelecimento_id IS NULL) AS contratacoes_sem_unidade,
       (SELECT count(*) FROM public.bloqueios_agenda WHERE ativo AND empresa_id IS NULL) AS bloqueios_globais,
       (SELECT count(*) FROM public.configuracao_agenda WHERE empresa_id IS NOT NULL) AS turnos_por_empresa;
SELECT 'postcheck 062 OK' AS resultado;
`;
fs.writeFileSync('database/checks/20261002_062_postcheck.sql', postcheck);

const rollback = `-- Rollback 062 — devolve a agenda GLOBAL (019/061). NÃO APLICADO. Exige autorização explícita (docs/OPERACAO_AGENTES.md).
-- Gerado offline por scripts/migration-062-manifest.mjs: restaura byte a byte ${SUBSTITUIDAS.map(([n, , f]) => `${n} (${f === m019 ? '019' : '061'})`).join(', ')},
-- remove gatilhos e funções kidmais062_* e confere os hashes no fim.
-- Global é sempre seguro (só conflita mais): nenhuma festa é liberada; pode aparecer conflito entre empresas que a 062
-- permitia (mesmo horário em unidades/empresas diferentes) — o rollback RECUSA se houver esse caso.
-- Estrutura:
--   * sem nenhum escopo gravado: removida por completo (volta ao schema da 061, inclusive o código de turno único);
--   * com escopo gravado (unidades, donos, resoluções): rollback SUAVE — colunas, tabela e dados preservados, só as
--     regras saem. A 062 pode ser reaplicada depois e reencontra a estrutura (database/migrations/...062...sql).
-- Recusa se houver turno ativo por empresa/unidade (sem a 062 ele entraria na agenda global de todas as empresas) ou
-- bloqueio com dono que alcançaria reserva de outro recurso (sem a 062 todo bloqueio volta a ser global).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_catalog;
LOCK TABLE public.fechamentos, public.fechamento_revisoes, public.contrato_fluxos, public.bloqueios_agenda, public.configuracao_agenda, public.contrato_importacoes,
  public.agenda_062_unidades_habilitacao IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF to_regprocedure('public.kidmais062_ocupacoes_escopo(date,date)') IS NULL THEN RAISE EXCEPTION 'Rollback 062: não aplicada.'; END IF;
  IF EXISTS (SELECT 1 FROM public.configuracao_agenda WHERE ativo AND empresa_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Rollback 062 recusado: há turno ativo por empresa/unidade; desative-o por decisão explícita antes.';
  END IF;
  -- Com a agenda global, duas reservas simultâneas em recursos diferentes (de qualquer data) passariam a conflitar.
  IF EXISTS (SELECT 1 FROM public.kidmais062_ocupacoes_escopo('-infinity'::date, 'infinity'::date) a
               JOIN public.kidmais062_ocupacoes_escopo('-infinity'::date, 'infinity'::date) b
                 ON b.data = a.data AND b.fechamento_id <> a.fechamento_id
                AND b.horario_inicio < a.horario_fim AND b.horario_fim > a.horario_inicio) THEN
    RAISE EXCEPTION 'Rollback 062 recusado: há reservas simultâneas em recursos diferentes; a agenda global as tornaria conflitantes. Correção forward necessária.';
  END IF;
  -- Sem a 062, todo bloqueio ativo volta a valer para todas as empresas (o dono é ignorado): bloqueio de uma empresa ou
  -- unidade que alcança reserva de OUTRO recurso passaria a conflitar com ela.
  IF EXISTS (SELECT 1 FROM public.kidmais062_ocupacoes_escopo('-infinity'::date, 'infinity'::date) o
               JOIN public.bloqueios_agenda b ON b.ativo AND b.data = o.data
                AND (b.dia_inteiro OR b.horario_inicio IS NULL OR b.horario_fim IS NULL OR (b.horario_inicio < o.horario_fim AND b.horario_fim > o.horario_inicio))
              WHERE NOT public.kidmais062_bloqueio_aplica(b.empresa_id, b.estabelecimento_id, o.empresa_id, o.estabelecimento_id)) THEN
    RAISE EXCEPTION 'Rollback 062 recusado: há bloqueio de empresa/unidade no horário de reserva de outro recurso; a agenda global os tornaria conflitantes. Desative o bloqueio por decisão explícita ou corrija para frente.';
  END IF;
END $$;
DROP TRIGGER contrato_importacoes_062_unidade_trg ON public.contrato_importacoes;
DROP TRIGGER fechamento_revisoes_062_unidade_trg ON public.fechamento_revisoes;
DROP TRIGGER configuracao_agenda_062_unidade_trg ON public.configuracao_agenda;
DROP TRIGGER bloqueios_agenda_062_unidade_trg ON public.bloqueios_agenda;
DROP TRIGGER contrato_fluxos_062_unidade_trg ON public.contrato_fluxos;
DROP TRIGGER fechamentos_062_unidade_trg ON public.fechamentos;
${SUBSTITUIDAS.map(([n, , f]) => definicao(f, n)).join('\n')}
DROP FUNCTION public.kidmais062_vinculo_unidade();
DROP FUNCTION public.kidmais062_revisao_unidade();
DROP FUNCTION public.kidmais062_unidade_ativa();
DROP FUNCTION public.kidmais062_fluxo_unidade();
DROP FUNCTION public.kidmais062_unidade_fechamento();
DROP FUNCTION public.kidmais062_ocupacoes_escopo(date, date);
DROP FUNCTION public.kidmais062_unidade_agendavel(uuid, uuid);
DROP FUNCTION public.kidmais062_travar_habilitacao(uuid);
DROP FUNCTION public.kidmais062_operador_agenda(uuid, uuid, text);
DROP FUNCTION public.kidmais062_bloqueio_aplica(uuid, uuid, uuid, uuid);
DROP FUNCTION public.kidmais062_mesmo_recurso(uuid, uuid, uuid, uuid);
DO $estrutura$ BEGIN
  IF EXISTS (SELECT 1 FROM public.fechamentos WHERE estabelecimento_id IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.bloqueios_agenda WHERE empresa_id IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.configuracao_agenda WHERE empresa_id IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.agenda_062_bloqueios_resolucao)
     OR EXISTS (SELECT 1 FROM public.agenda_062_fechamentos_resolucao)
     OR EXISTS (SELECT 1 FROM public.agenda_062_unidades_habilitacao) THEN
    RAISE NOTICE 'Rollback 062 SUAVE: escopos e habilitações preservados (colunas, decisões D2/D3 e histórico de habilitação com a guarda); agenda global ativa.';
    RETURN;
  END IF;
  DROP TABLE public.agenda_062_unidades_habilitacao;
  DROP FUNCTION public.kidmais062_habilitacao_guard();
  DROP TABLE public.agenda_062_fechamentos_resolucao;
  DROP TABLE public.agenda_062_bloqueios_resolucao;
  DROP INDEX public.configuracao_agenda_062_codigo_escopo_uk;
  DROP INDEX public.bloqueios_agenda_062_escopo_idx;
  DROP INDEX public.fechamentos_062_agenda_idx;
  ALTER TABLE public.configuracao_agenda DROP CONSTRAINT configuracao_agenda_062_estabelecimento_fk,
    DROP CONSTRAINT configuracao_agenda_062_unidade_exige_empresa_check, DROP COLUMN estabelecimento_id, DROP COLUMN empresa_id,
    ADD CONSTRAINT configuracao_agenda_codigo_uk UNIQUE (codigo);
  ALTER TABLE public.bloqueios_agenda DROP CONSTRAINT bloqueios_agenda_062_estabelecimento_fk,
    DROP CONSTRAINT bloqueios_agenda_062_unidade_exige_empresa_check, DROP COLUMN estabelecimento_id, DROP COLUMN empresa_id;
  ALTER TABLE public.fechamentos DROP CONSTRAINT fechamentos_062_estabelecimento_fk,
    DROP CONSTRAINT fechamentos_062_unidade_exige_empresa_check, DROP COLUMN estabelecimento_id;
  RAISE NOTICE 'Rollback 062 COMPLETO: estrutura removida; schema igual ao da 061.';
END $estrutura$;
DO $$ BEGIN
  IF ${divergentes(SUBSTITUIDAS)}
     OR ${divergentes(MANTIDAS)} THEN
    RAISE EXCEPTION 'Rollback 062: corpos restaurados divergem de 019/061.';
  END IF;
END $$;
COMMIT;
`;
fs.writeFileSync('database/rollback/20261002_062_agenda_empresa_unidade_down.sql', rollback);

console.log(JSON.stringify(Object.fromEntries([
  ...SUBSTITUIDAS.map(([n, , f]) => [n, { anterior: sha(corpo(f, n)), '062': sha(corpo(m062, n)) }]),
  ...MANTIDAS.map(([n, , f]) => [n, { mantida: sha(corpo(f, n)) }]),
]), null, 1));
