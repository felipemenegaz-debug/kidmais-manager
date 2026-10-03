import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { estruturaFesta019Sql } from '../festas/estrutura-019.ts';

/** Contrato estático da 062 (nenhuma conexão com banco). O comportamento no banco é coberto por agenda-062.postgres.test.ts. */
const ler = (f: string) => readFileSync(f, 'utf8').replaceAll('\r', '');
const M019 = ler('database/migrations/20260915_019_festa_formalizacao.sql');
const M061 = ler('database/migrations/20261002_061_contratos_importados_integracao.sql');
const M062 = ler('database/migrations/20261002_062_agenda_empresa_unidade.sql');
const PRE = ler('database/checks/20261002_062_precheck.sql');
const POS = ler('database/checks/20261002_062_postcheck.sql');
const DOWN = ler('database/rollback/20261002_062_agenda_empresa_unidade_down.sql');
const LEVANTAMENTO = ler('database/repairs/20261002_062_levantamento_agenda.sql');
const PRINCIPAL = ler('database/repairs/20261002_062_unidade_principal.sql');
const BLOQUEIOS = ler('database/repairs/20261002_062_bloqueios_propriedade.sql');

const definicao = (sql: string, nome: string) => {
  const m = sql.match(new RegExp(String.raw`CREATE (?:OR REPLACE )?FUNCTION (?:public\.)?` + nome + String.raw`\([\s\S]*?AS \$\$([\s\S]*?)\$\$;`));
  assert.ok(m, `função ${nome}`);
  return m;
};
const corpo = (sql: string, nome: string) => definicao(sql, nome)[1];
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const mensagens = (s: string) => [...s.matchAll(/RAISE EXCEPTION '([^']+)'/g)].map((m) => m[1]).sort();
/** SQL fora dos corpos de função e dos blocos DO (o que a migration executa diretamente). */
const topo = (sql: string) => sql.replace(/\$(\w*)\$[\s\S]*?\$\1\$/g, '$$…$$');

const SUBSTITUIDAS: Array<[string, string]> = [
  ['kidmais019_validar_destino', M019], ['kidmais019_validar_contrato', M019],
  ['kidmais_proteger_bloqueio_revisao', M019], ['kidmais_validar_agenda_revisao', M061],
];
const MANTIDAS: Array<[string, string]> = [['kidmais019_ocupa', M019], ['kidmais_ocupacoes_operacionais', M061], ['kidmais019_formalizacao', M061]];

test('062 não faz backfill: nenhuma escrita de dados; dado existente fica com o alcance anterior', () => {
  assert.doesNotMatch(topo(M062), /^\s*(INSERT|UPDATE|DELETE)\b/im);
  assert.doesNotMatch(M062, /\b(INSERT INTO|UPDATE|DELETE FROM) public\.(fechamentos|bloqueios_agenda|configuracao_agenda|estabelecimentos)\b/);
  assert.match(M062, /NÃO APLICADA\. Exige autorização explícita/);
  assert.match(M062, /current_setting\('kidmais\.m062_reaplicacao'\) = 'nao' AND \(EXISTS\(SELECT 1 FROM public\.fechamentos WHERE estabelecimento_id IS NOT NULL\)/);
  assert.match(M062, /RAISE EXCEPTION '062: a instalação não atribui escopo a dados existentes'/);
});

test('062 exige a 061 e os corpos anteriores exatos; substitui só quatro funções e não toca ocupação/formalização', () => {
  assert.match(M062, /RAISE EXCEPTION '062 exige a 061 aplicada antes\.'/);
  for (const [nome, fonte] of SUBSTITUIDAS) {
    assert.ok(M062.includes(sha(corpo(fonte, nome))), `precheck da migration: ${nome}`);
    assert.ok(PRE.includes(sha(corpo(fonte, nome))), `precheck: ${nome}`);
    assert.ok(POS.includes(sha(corpo(M062, nome))), `postcheck: ${nome}`);
  }
  for (const [nome, fonte] of MANTIDAS) {
    assert.doesNotMatch(M062, new RegExp(`FUNCTION public\\.${nome}\\(`), `${nome} não é alterada`);
    assert.ok(POS.includes(sha(corpo(fonte, nome))), `postcheck confere ${nome} intacta`);
  }
  const substituidas = [...M062.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\(/g)].map((x) => x[1]);
  assert.deepEqual(substituidas, SUBSTITUIDAS.map(([n]) => n));
});

test('regras substituídas: mesmas mensagens e gatilhos; muda só o alcance (mesmo recurso / bloqueio que alcança)', () => {
  for (const [nome, fonte] of SUBSTITUIDAS) {
    const novo = corpo(M062, nome);
    assert.deepEqual(mensagens(novo), mensagens(corpo(fonte, nome)), `${nome}: mensagens preservadas`);
    assert.match(novo, /kidmais062_(mesmo_recurso|bloqueio_aplica)\(/, `${nome}: compara por recurso`);
    assert.doesNotMatch(novo, /kidmais_ocupacoes_operacionais\(/, `${nome}: usa a ocupação com escopo`);
  }
  // A isenção histórica da 061 continua exatamente no mesmo lugar (slot integrado já realizado).
  assert.match(corpo(M062, 'kidmais_validar_agenda_revisao'), /IF NOT public\.kidmais019_ocupa\(f\.id\) OR public\.kidmais061_historico_passado\(f\.id\) THEN RETURN NULL; END IF;/);
  assert.match(corpo(M062, 'kidmais062_ocupacoes_escopo'), /kidmais019_ocupa\(f\.id\) AND NOT kidmais061_historico_passado\(f\.id\)/);
  // Remarcação herda a unidade da contratação.
  assert.match(corpo(M062, 'kidmais062_ocupacoes_escopo'), /'REVISAO_DESTINO'::text,r\.data_evento,r\.horario_inicio,r\.horario_fim,f\.empresa_id,f\.estabelecimento_id/);
});

test('regras puras da 062 são as mesmas do código (escopo.ts)', () => {
  assert.equal(corpo(M062, 'kidmais062_mesmo_recurso').trim(), 'SELECT (e1 IS NULL OR e2 IS NULL OR e1=e2) AND (u1 IS NULL OR u2 IS NULL OR u1=u2);');
  assert.equal(corpo(M062, 'kidmais062_bloqueio_aplica').trim(), 'SELECT be IS NULL OR e IS NULL OR (be=e AND (bu IS NULL OR u IS NULL OR bu=u));');
  const ts = ler('lib/disponibilidade/escopo.ts');
  assert.match(ts, /\(a\.empresaId === null \|\| b\.empresaId === null \|\| a\.empresaId === b\.empresaId\)\s+&& \(a\.estabelecimentoId === null \|\| b\.estabelecimentoId === null \|\| a\.estabelecimentoId === b\.estabelecimentoId\)/);
  assert.match(ts, /bloqueio\.empresaId === null \|\| alvo\.empresaId === null\s+\|\| \(bloqueio\.empresaId === alvo\.empresaId/);
});

test('locks: o namespace global por data é mantido (mais grosso que o recurso, seguro com código antigo e novo)', () => {
  assert.match(corpo(M062, 'kidmais_proteger_bloqueio_revisao'), /PERFORM public\.kidmais_lock_datas_revisao\(ARRAY\[OLD\.data,NEW\.data\]\)/);
  assert.match(corpo(M062, 'kidmais_validar_agenda_revisao'), /PERFORM public\.kidmais_lock_datas_revisao\(ARRAY\[target_day\]\)/);
  assert.doesNotMatch(M062, /kidmais_lock_datas_revisao\(\w+\s*uuid/);
  assert.match(ler('lib/disponibilidade/repositories/disponibilidade.repository.ts'), /hashtextextended\('kidmais:agenda:' \|\| \$1::text, 0\)/);
});

test('elegibilidade (D6 = opção A): só habilitação explícita vigente; SUSPENSO nunca é permissão; nenhuma habilitação automática', () => {
  // A 043: toda unidade nasce SUSPENSO, status imutável, ATIVO fechado (D03) — o status não distingue suspensão administrativa.
  const m043 = ler('database/migrations/20260926_043_estrutura_tenant.sql');
  assert.match(m043, /estabelecimento novo começa suspenso/);
  assert.match(m043, /estabelecimento permanece não operacional\. ATIVO está fechado\./);
  const agendavel = corpo(M062, 'kidmais062_unidade_agendavel');
  assert.match(agendavel, /JOIN agenda_062_unidades_habilitacao h ON h\.empresa_id = u\.empresa_id AND h\.estabelecimento_id = u\.id AND h\.revogada_em IS NULL/);
  assert.match(agendavel, /u\.status <> 'DESATIVADO' AND e\.status = 'ATIVA'/);
  assert.doesNotMatch(agendavel, /SUSPENSO|'ATIVO'/, 'o status da unidade não concede nada');
  // Nenhuma unidade existente é habilitada pela migration nem por reparo.
  assert.doesNotMatch(M062, /INSERT INTO (public\.)?agenda_062_unidades_habilitacao/);
  for (const reparo of [LEVANTAMENTO, PRINCIPAL, BLOQUEIOS]) assert.doesNotMatch(reparo, /INSERT INTO (public\.)?agenda_062_unidades_habilitacao/);
  // Código e integração usam a mesma regra única; ninguém decide elegibilidade por status.
  for (const [nome, sql] of [['061', M061], ['escopo.ts', ler('lib/disponibilidade/escopo.ts')], ['repositorio.ts', ler('lib/contratos/integracao-importados/repositorio.ts')]]) {
    assert.doesNotMatch(sql, /status\s*<>\s*'DESATIVADO'/, nome);
  }
  assert.match(ler('lib/disponibilidade/escopo.ts'), /public\.kidmais062_unidade_agendavel\(empresa_id, id\)/);
  assert.match(ler('lib/contratos/integracao-importados/repositorio.ts'), /public\.kidmais062_unidade_agendavel\(empresa_id, id\)/);
});

test('habilitação: operador autorizado no banco, histórico imutável, uma vigente por unidade, guarda que sobrevive ao rollback suave', () => {
  assert.match(corpo(M062, 'kidmais062_operador_agenda'), /p_papel = 'REPRESENTANTE_AUTORIZADO' AND EXISTS\(SELECT 1 FROM memberships m JOIN usuarios_administrativos ua ON ua\.id = m\.usuario_id\s+WHERE m\.empresa_id = p_empresa AND m\.usuario_id = p_usuario AND m\.status = 'ATIVA' AND m\.papel = p_papel AND ua\.ativo\)/);
  const guarda = M062.slice(M062.indexOf('CREATE FUNCTION public.kidmais062_habilitacao_guard()'), M062.indexOf('END $guarda$;'));
  assert.match(guarda, /TG_OP IN \('DELETE','TRUNCATE'\)/);
  assert.match(guarda, /habilitação nasce vigente/);
  assert.match(guarda, /habilitar unidade exige Representante autorizado ativo desta empresa/);
  assert.match(guarda, /só a revogação \(uma vez\) altera a habilitação/);
  assert.match(guarda, /revogar habilitação exige Representante autorizado ativo desta empresa/);
  assert.match(M062, /CREATE UNIQUE INDEX agenda_062_unidades_habilitacao_vigente_uk\s+ON public\.agenda_062_unidades_habilitacao \(estabelecimento_id\) WHERE revogada_em IS NULL;/);
  assert.match(M062, /motivo_habilitacao text NOT NULL CHECK \(length\(btrim\(motivo_habilitacao\)\) BETWEEN 5 AND 1000\)/);
  // A guarda é estrutura (dentro do bloco DO $estrutura$), por isso fica no rollback suave.
  const estrutura = M062.slice(M062.indexOf('DO $estrutura$'), M062.indexOf('END $estrutura$;'));
  assert.ok(estrutura.includes('CREATE TRIGGER agenda_062_unidades_habilitacao_guard_trg') && estrutura.includes('CREATE TRIGGER agenda_062_unidades_habilitacao_truncate_trg'));
  assert.doesNotMatch(DOWN.slice(0, DOWN.indexOf('DO $estrutura$')), /agenda_062_unidades_habilitacao_guard_trg|kidmais062_habilitacao_guard/, 'rollback suave não remove a guarda');
});

test('revogação = suspensão administrativa: reservas gravadas ficam; novas, mudança de data/horário, novo destino, bloqueio e turno na unidade são recusados', () => {
  const f = corpo(M062, 'kidmais062_unidade_fechamento');
  assert.match(f, /a unidade da contratação não muda/);
  assert.match(f, /TG_OP='INSERT'[\s\S]*kidmais062_unidade_agendavel\(empresa_id, id\);\s+IF n=1 THEN NEW\.estabelecimento_id := unica; END IF;/);
  assert.match(f, /AND NOT kidmais062_unidade_agendavel\(NEW\.empresa_id, NEW\.estabelecimento_id\) THEN\s+RAISE EXCEPTION '062: unidade não elegível para agenda ou de outra empresa'/);
  assert.match(f, /ROW\(NEW\.data_evento, NEW\.horario_inicio, NEW\.horario_fim\) IS DISTINCT FROM ROW\(OLD\.data_evento, OLD\.horario_inicio, OLD\.horario_fim\)[\s\S]*alterar data ou horário exige unidade habilitada/);
  assert.match(M062, /CREATE TRIGGER fechamentos_062_unidade_trg BEFORE INSERT OR UPDATE OF estabelecimento_id, data_evento, horario_inicio, horario_fim ON public\.fechamentos/);
  assert.match(corpo(M062, 'kidmais062_revisao_unidade'), /alterar data ou horário exige unidade habilitada/);
  assert.match(corpo(M062, 'kidmais062_unidade_ativa'), /AND NOT kidmais062_unidade_agendavel\(NEW\.empresa_id, NEW\.estabelecimento_id\) THEN/);
  // A ocupação NÃO depende da habilitação: a reserva gravada continua ocupando depois da revogação.
  assert.doesNotMatch(corpo(M062, 'kidmais062_ocupacoes_escopo'), /agendavel|habilitacao/);
  // Revogação concorrente: quem grava na unidade trava a habilitação vigente antes de conferir.
  assert.match(corpo(M062, 'kidmais062_travar_habilitacao'), /FOR SHARE/);
  for (const nome of ['kidmais062_unidade_fechamento', 'kidmais062_unidade_ativa', 'kidmais062_revisao_unidade']) {
    assert.match(corpo(M062, nome), /PERFORM kidmais062_travar_habilitacao\(/, nome);
  }
  assert.match(corpo(M062, 'kidmais062_vinculo_unidade'), /unidade do vínculo difere da contratação/);
});

test('compatibilidade: código que usa objetos da 062 só o faz depois de detectá-la (ou exige a 062 para funcionar)', () => {
  const usam = ['lib/disponibilidade/escopo.ts', 'lib/disponibilidade/repositories/disponibilidade.repository.ts', 'lib/contratos/integracao-importados/repositorio.ts'];
  const repo = ler('lib/disponibilidade/repositories/disponibilidade.repository.ts');
  // Cada consulta com escopo escolhe o SQL pela detecção; sem a 062, o SQL anterior (sem coluna nem função nova).
  for (const funcao of ['listarConfiguracoesAgendaAtivas', 'listarBloqueiosAtivosPorPeriodo', 'listarTodosBloqueiosAtivos', 'existeBloqueioAgendaAtivoExato',
    'listarFechamentosConfirmadosPorPeriodo', 'verificarConflitoAgendaParaConfirmacao', 'criarBloqueioAgenda', 'desativarBloqueiosExatos', 'desativarBloqueioAgendaPorId']) {
    const inicio = repo.indexOf(`export async function ${funcao}(`);
    const fim = repo.indexOf('export async function', inicio + 10);
    assert.ok(inicio >= 0, funcao);
    assert.match(repo.slice(inicio, fim < 0 ? undefined : fim), /agendaPorEscopoInstalada\(/, `${funcao}: detecta a 062`);
  }
  // A integração só fica disponível com a 062 instalada.
  assert.match(ler('lib/contratos/integracao-importados/repositorio.ts'), /to_regprocedure\('public\.kidmais062_ocupacoes_escopo\(date,date\)'\) IS NOT NULL AS ok/);
  // Fechamento grava a unidade só quando informada; o escopo só traz unidade com a 062 instalada.
  assert.match(ler('lib/fechamentos/repositories/fechamento.repository.ts'), /\$\{input\.estabelecimentoId \? ",estabelecimento_id" : ""\}/);
  assert.match(ler('lib/disponibilidade/escopo.ts'), /if \(!\(await agendaPorEscopoInstalada\(db\)\)\) return \{ empresaId, estabelecimentoId: null \};/);
  for (const arquivo of usam) assert.match(ler(arquivo), /kidmais062_/);
});

test('reaplicação depois de rollback suave: estrutura completa (19 peças) é reaproveitada; parcial recusa', () => {
  assert.match(M062, /IF pecas = 19 AND NOT EXISTS \(SELECT 1 FROM pg_constraint WHERE conname = 'configuracao_agenda_codigo_uk'\) THEN/);
  assert.match(M062, /RAISE EXCEPTION '062: estrutura parcial \(% de 19 peças\); instalação divergente\.'/);
  assert.match(M062, /RAISE EXCEPTION '062 já aplicada\.'/);
});

test('rollback: devolve a agenda global byte a byte, recusa turnos por empresa e reservas simultâneas entre recursos, e é suave com escopo gravado', () => {
  for (const [nome, fonte] of SUBSTITUIDAS) {
    assert.ok(DOWN.includes(definicao(fonte, nome)[0].replace(/^CREATE (OR REPLACE )?FUNCTION (public\.)?/, 'CREATE OR REPLACE FUNCTION public.')), `${nome} restaurada`);
    assert.ok(DOWN.includes(sha(corpo(fonte, nome))), `${nome} conferida`);
  }
  assert.match(DOWN, /Rollback 062 recusado: há turno ativo por empresa\/unidade/);
  assert.match(DOWN, /Rollback 062 recusado: há reservas simultâneas em recursos diferentes/);
  assert.match(DOWN, /Rollback 062 SUAVE: escopos e habilitações preservados/);
  assert.match(DOWN, /OR EXISTS \(SELECT 1 FROM public\.agenda_062_unidades_habilitacao\) THEN/, 'habilitação gravada força o rollback suave');
  assert.match(DOWN, /ADD CONSTRAINT configuracao_agenda_codigo_uk UNIQUE \(codigo\)/);
  assert.match(DOWN, /DROP FUNCTION public\.kidmais062_ocupacoes_escopo\(date, date\);/, 'sem a função, o código volta às consultas globais');
});

test('reparos (D2/D3): levantamento só lê; aplicação exige variável de sessão explícita; bloqueio sem decisão trava tudo', () => {
  assert.match(LEVANTAMENTO, /^BEGIN READ ONLY;/m);
  assert.doesNotMatch(topo(LEVANTAMENTO), /^\s*(INSERT|UPDATE|DELETE)\b/im);
  assert.match(PRINCIPAL, /current_setting\('kidmais\.reparo_062', true\) IS DISTINCT FROM 'unidade_principal'/);
  assert.match(PRINCIPAL, /'principal', 'Unidade principal', 'SUSPENSO'/);
  assert.match(PRINCIPAL, /WHERE kidmais062_unidade_agendavel\(empresa_id, id\) GROUP BY empresa_id HAVING count\(\*\) = 1/, 'só empresas com exatamente uma unidade ELEGÍVEL recebem atribuição');
  // O levantamento lista nominalmente o que continua global (contratação sem empresa e bloqueio sem dono).
  assert.match(LEVANTAMENTO, /-- 2\. GLOBAL — contratações que ocupam agenda/);
  assert.match(LEVANTAMENTO, /-- 3\. GLOBAL — bloqueios ativos sem dono/);
  assert.match(BLOQUEIOS, /bloqueio\(s\) ativo\(s\) sem dono resolvido; resolva todos/);
  assert.match(BLOQUEIOS, /current_setting\('kidmais\.reparo_062', true\) IS DISTINCT FROM 'bloqueios'/);
});

test('módulo Festa: conjunto 062 = 061 com as quatro regras da 062; nenhum outro corpo muda', () => {
  const conjuntos: Record<string, Record<string, string>> = {};
  for (const [, c, nome, hash] of estruturaFesta019Sql.matchAll(/\('(\d{3})','(\w+)','([0-9a-f]{64})'\)/g)) (conjuntos[c] ??= {})[nome] = hash;
  assert.deepEqual(Object.keys(conjuntos).sort(), ['019', '061', '062']);
  for (const nome of Object.keys(conjuntos['061'])) {
    const esperado = SUBSTITUIDAS.some(([n]) => n === nome) ? sha(corpo(M062, nome)) : conjuntos['061'][nome];
    assert.equal(conjuntos['062'][nome], esperado, nome);
  }
  assert.equal(Object.keys(conjuntos['062']).length, 10);
});
