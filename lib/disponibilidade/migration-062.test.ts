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
const FECHAMENTOS = ler('database/repairs/20261002_062_fechamentos_unidade.sql');

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
    // Mensagens nativas preservadas; a única nova é a da habilitação (D6) no destino, prefixada com "062: unidade".
    assert.deepEqual(mensagens(novo).filter((m) => !m.startsWith('062: unidade')), mensagens(corpo(fonte, nome)), `${nome}: mensagens preservadas`);
    if (nome !== 'kidmais019_validar_destino') assert.ok(!mensagens(novo).some((m) => m.startsWith('062:')), nome);
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
  for (const reparo of [LEVANTAMENTO, PRINCIPAL, BLOQUEIOS, FECHAMENTOS]) assert.doesNotMatch(reparo, /INSERT INTO (public\.)?agenda_062_unidades_habilitacao/);
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
  assert.match(M062, /CREATE TRIGGER fechamentos_062_unidade_trg BEFORE INSERT OR UPDATE OF estabelecimento_id, data_evento, horario_inicio, horario_fim, status ON public\.fechamentos/);
  // Proposta antiga (que ainda não ocupa) não vira reserva na unidade revogada: nem por CONFIRMADO...
  assert.match(f, /NEW\.status='CONFIRMADO' AND OLD\.status IS DISTINCT FROM 'CONFIRMADO'\s+AND NOT kidmais019_ocupa\(OLD\.id\) AND NOT kidmais062_unidade_agendavel\(NEW\.empresa_id, NEW\.estabelecimento_id\) THEN\s+RAISE EXCEPTION '062: unidade sem habilitação vigente; confirmar nova reserva exige unidade habilitada'/);
  // ... nem pela formalização (troca da versão vigente) ...
  const fluxo = corpo(M062, 'kidmais062_fluxo_unidade');
  assert.match(fluxo, /IF NOT kidmais019_ocupa\(f\.id\) AND NOT kidmais062_unidade_agendavel\(f\.empresa_id, f\.estabelecimento_id\) THEN\s+RAISE EXCEPTION '062: unidade sem habilitação vigente; formalizar nova reserva exige unidade habilitada'/);
  assert.match(M062, /CREATE TRIGGER contrato_fluxos_062_unidade_trg BEFORE INSERT OR UPDATE OF versao_vigente_id ON public\.contrato_fluxos/);
  // ... nem no destino validado pela formalização nativa e pela integração.
  assert.match(corpo(M062, 'kidmais019_validar_destino'), /IF NOT kidmais062_unidade_agendavel\(emp,uni\) AND \(NOT kidmais019_ocupa\(fid\) OR NOT mesmo_slot\) THEN/);
  // Hold do destino adquirido depois da revogação também passa pela regra da revisão.
  assert.match(M062, /CREATE TRIGGER fechamento_revisoes_062_unidade_trg BEFORE INSERT OR UPDATE OF data_evento, horario_inicio, horario_fim, estado, hold_destino_adquirido_em ON public\.fechamento_revisoes/);
  assert.match(corpo(M062, 'kidmais062_revisao_unidade'), /alterar data ou horário exige unidade habilitada/);
  // Bloqueio/turno: na unidade revogada só desativar ou corrigir descrição; criar, reativar ou mudar horário é recusado.
  const ativa = corpo(M062, 'kidmais062_unidade_ativa');
  assert.match(ativa, /IF kidmais062_unidade_agendavel\(NEW\.empresa_id, NEW\.estabelecimento_id\) THEN RETURN NEW; END IF;/);
  assert.match(ativa, /IF NEW\.ativo AND \(NOT OLD\.ativo OR \(to_jsonb\(NEW\) - descritivos\) IS DISTINCT FROM \(to_jsonb\(OLD\) - descritivos\)\) THEN/);
  assert.match(M062, /CREATE TRIGGER bloqueios_agenda_062_unidade_trg BEFORE INSERT OR UPDATE ON public\.bloqueios_agenda/);
  assert.match(M062, /CREATE TRIGGER configuracao_agenda_062_unidade_trg BEFORE INSERT OR UPDATE ON public\.configuracao_agenda/);
  // A ocupação NÃO depende da habilitação: a reserva gravada continua ocupando depois da revogação.
  assert.doesNotMatch(corpo(M062, 'kidmais062_ocupacoes_escopo'), /agendavel|habilitacao/);
  // Revogação concorrente: quem grava na unidade trava a habilitação vigente antes de conferir.
  assert.match(corpo(M062, 'kidmais062_travar_habilitacao'), /FOR SHARE/);
  for (const nome of ['kidmais062_unidade_fechamento', 'kidmais062_fluxo_unidade', 'kidmais062_unidade_ativa', 'kidmais062_revisao_unidade', 'kidmais019_validar_destino']) {
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

test('ordem única de locks: empresa → unidade → habilitação (→ data → contratação); habilitar/revogar travam a unidade sem bloquear o FK', () => {
  const travar = corpo(M062, 'kidmais062_travar_habilitacao');
  const empresa = travar.indexOf('FROM empresas e'), unidade = travar.indexOf('FROM estabelecimentos WHERE id = p_unidade FOR SHARE'), hab = travar.indexOf('FROM agenda_062_unidades_habilitacao');
  assert.ok(empresa >= 0 && empresa < unidade && unidade < hab, 'empresa, depois unidade, depois habilitação');
  assert.match(travar, /FROM empresas e WHERE[\s\S]*?FOR SHARE;/);
  const servico = ler('lib/disponibilidade/unidades-agenda.ts');
  const travarUnidade = servico.slice(servico.indexOf('async function travarUnidade('), servico.indexOf('export async function habilitarUnidadeAgenda('));
  assert.ok(travarUnidade.indexOf('FROM public.empresas WHERE id = $1::uuid FOR SHARE') < travarUnidade.indexOf('FOR NO KEY UPDATE'), 'empresa antes da unidade');
  assert.doesNotMatch(travarUnidade, /FOR UPDATE\b/, 'FOR UPDATE conflitaria com o KEY SHARE do FK (ciclo com a reserva)');
  // Gatilhos da 062 disparam antes dos locks de data da 019 na mesma tabela (ordem alfabética do PostgreSQL).
  assert.ok('fechamentos_062_unidade_trg' < 'festa019_lock_fechamento' && 'contrato_fluxos_062_unidade_trg' < 'festa019_lock_fluxo'
    && 'fechamento_revisoes_062_unidade_trg' < 'festa019_lock_revisao' && 'bloqueios_agenda_062_unidade_trg' < 'fr_bloqueio_proteger_trg');
  // A integração trava a unidade antes da data.
  const integracao = ler('lib/contratos/integracao-importados/servico.ts');
  assert.ok(integracao.indexOf('await repo.travarUnidade(tx, decisoes.estabelecimentoId)') < integracao.indexOf('await repo.travarData(tx, decisoes.evento.data)'));
  // Duplicidade (só a integração, uma por empresa) entre unidade e data, e os candidatos reconsultados depois desse lock.
  const iDup = integracao.indexOf('await repo.travarDuplicidade(tx, empresaId)');
  assert.ok(integracao.indexOf('await repo.travarUnidade(tx, decisoes.estabelecimentoId)') < iDup && iDup < integracao.indexOf('await repo.travarData(tx, decisoes.evento.data)'));
  assert.ok(iDup < integracao.indexOf('const vinculosAgora = await repo.possiveisVinculos(tx, empresaId, p.criterio)'));
});

test('reaplicação depois de rollback suave: estrutura completa (20 peças) é reaproveitada; parcial recusa', () => {
  assert.match(M062, /IF pecas = 20 AND codigos_globais = 0 THEN/);
  assert.match(M062, /RAISE EXCEPTION '062: estrutura parcial \(% de 20 peças\); instalação divergente\.'/);
  assert.match(M062, /\+ \(CASE WHEN to_regclass\('public\.agenda_062_fechamentos_resolucao'\) IS NULL THEN 0 ELSE 1 END\)/);
  assert.match(M062, /RAISE EXCEPTION '062 já aplicada\.'/);
});

test('rollback: devolve a agenda global byte a byte, recusa turnos por empresa e reservas simultâneas entre recursos, e é suave com escopo gravado', () => {
  for (const [nome, fonte] of SUBSTITUIDAS) {
    assert.ok(DOWN.includes(definicao(fonte, nome)[0].replace(/^CREATE (OR REPLACE )?FUNCTION (public\.)?/, 'CREATE OR REPLACE FUNCTION public.')), `${nome} restaurada`);
    assert.ok(DOWN.includes(sha(corpo(fonte, nome))), `${nome} conferida`);
  }
  assert.match(DOWN, /Rollback 062 recusado: há turno ativo por empresa\/unidade/);
  assert.match(DOWN, /Rollback 062 recusado: há reservas simultâneas em recursos diferentes/);
  // Bloqueio com dono que alcançaria reserva de OUTRO recurso quando todo bloqueio voltar a ser global.
  assert.match(DOWN, /WHERE NOT public\.kidmais062_bloqueio_aplica\(b\.empresa_id, b\.estabelecimento_id, o\.empresa_id, o\.estabelecimento_id\)\) THEN\s+RAISE EXCEPTION 'Rollback 062 recusado: há bloqueio de empresa\/unidade no horário de reserva de outro recurso/);
  assert.ok(DOWN.indexOf('bloqueio de empresa/unidade no horário') < DOWN.indexOf('DROP TRIGGER'), 'recusas antes de qualquer remoção');
  assert.match(DOWN, /OR EXISTS \(SELECT 1 FROM public\.agenda_062_fechamentos_resolucao\)/, 'decisão D2 gravada força o rollback suave');
  assert.match(DOWN, /DROP TRIGGER contrato_fluxos_062_unidade_trg ON public\.contrato_fluxos;/);
  assert.match(DOWN, /Rollback 062 SUAVE: escopos e habilitações preservados/);
  assert.match(DOWN, /OR EXISTS \(SELECT 1 FROM public\.agenda_062_unidades_habilitacao\) THEN/, 'habilitação gravada força o rollback suave');
  assert.match(DOWN, /ADD CONSTRAINT configuracao_agenda_codigo_uk UNIQUE \(codigo\)/);
  assert.match(DOWN, /DROP FUNCTION public\.kidmais062_ocupacoes_escopo\(date, date\);/, 'sem a função, o código volta às consultas globais');
});

test('reparos (D2/D3): levantamento só lê; aplicação exige variável de sessão explícita; nada é atribuído sem decisão por registro', () => {
  assert.match(LEVANTAMENTO, /^BEGIN READ ONLY;/m);
  assert.doesNotMatch(topo(LEVANTAMENTO), /^\s*(INSERT|UPDATE|DELETE)\b/im);
  assert.match(PRINCIPAL, /current_setting\('kidmais\.reparo_062', true\) IS DISTINCT FROM 'unidade_principal'/);
  assert.match(PRINCIPAL, /'principal', 'Unidade principal', 'SUSPENSO'/);
  // Unidade principal só cria a identidade: nenhuma contratação recebe unidade por suposição.
  assert.doesNotMatch(topo(PRINCIPAL), /UPDATE\s+(public\.)?fechamentos/i);
  assert.doesNotMatch(PRINCIPAL, /HAVING count\(\*\) = 1/);
  // Unidade da contratação: só decisões gravadas, unidade já habilitada, mesma empresa; inválida trava tudo.
  assert.match(M062, /CREATE TABLE public\.agenda_062_fechamentos_resolucao \(/);
  assert.match(FECHAMENTOS, /current_setting\('kidmais\.reparo_062', true\) IS DISTINCT FROM 'fechamentos_unidade'/);
  assert.match(FECHAMENTOS, /OR \(f\.estabelecimento_id IS NULL AND NOT kidmais062_unidade_agendavel\(r\.empresa_id, r\.estabelecimento_id\)\)/);
  assert.match(FECHAMENTOS, /f\.empresa_id IS DISTINCT FROM r\.empresa_id/);
  assert.match(topo(FECHAMENTOS), /UPDATE fechamentos f SET estabelecimento_id = r\.estabelecimento_id\s+FROM agenda_062_fechamentos_resolucao r\s+WHERE r\.fechamento_id = f\.id AND f\.empresa_id = r\.empresa_id AND f\.estabelecimento_id IS NULL/);
  assert.match(LEVANTAMENTO, /-- 6\. DECISÃO D2/);
  // Reparos: unidades, depois TODAS as datas ordenadas, antes do UPDATE; e a pausa de escritas de agenda documentada.
  for (const reparo of [FECHAMENTOS, BLOQUEIOS]) {
    assert.ok(reparo.indexOf('PERFORM kidmais062_travar_habilitacao(') < reparo.indexOf('PERFORM kidmais_lock_datas_revisao(ARRAY(SELECT DISTINCT'));
    assert.ok(reparo.indexOf('PERFORM kidmais_lock_datas_revisao(ARRAY(SELECT DISTINCT') < reparo.search(/^UPDATE /m));
    assert.match(reparo, /escritas de agenda PAUSADAS/);
    assert.match(reparo, /lock_timeout só limita a espera; não evita deadlock/);
  }
  assert.match(ler('docs/CONTRATOS_IMPORTADOS_INTEGRACAO.md'), /\| S17 \|[^\n]*escritas de agenda pausadas/);
  const candidatosD2 = "f.empresa_id IS NOT NULL AND f.estabelecimento_id IS NULL AND f.data_evento >= current_date AND f.status NOT IN ('CANCELADO', 'RECUSADO', 'EXPIRADO')";
  assert.ok(LEVANTAMENTO.includes(candidatosD2) && FECHAMENTOS.includes(candidatosD2), 'mesmo predicado de candidatos D2');
  // Mesmo predicado de pendência no levantamento (consulta 3) e no reparo de bloqueios.
  assert.match(LEVANTAMENTO, /WHERE b\.ativo AND b\.empresa_id IS NULL AND b\.data >= current_date/);
  assert.match(BLOQUEIOS, /WHERE b\.ativo AND b\.empresa_id IS NULL AND b\.data >= current_date\s+AND NOT EXISTS \(SELECT 1 FROM agenda_062_bloqueios_resolucao r WHERE r\.bloqueio_id = b\.id\)/);
  assert.match(BLOQUEIOS, /resolução\(ões\) para unidade sem habilitação vigente/);
  assert.doesNotMatch(LEVANTAMENTO, /hoje só ATIVO|inalcançável/, 'comentário antigo da elegibilidade');
  // O levantamento lista nominalmente o que continua global (contratação sem empresa e bloqueio sem dono).
  assert.match(LEVANTAMENTO, /-- 2\. GLOBAL — contratações que ocupam agenda/);
  assert.match(LEVANTAMENTO, /-- 3\. GLOBAL — bloqueios ativos sem dono/);
  assert.match(BLOQUEIOS, /bloqueio\(s\) ativo\(s\), futuros, sem dono resolvido; resolva todos/);
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

test('legado sem empresa (D7): bloqueia todas as empresas, aparece no levantamento e NUNCA recebe empresa por reparo automático', () => {
  // Regra de conflito: ocupação sem empresa conflita com qualquer recurso; bloqueio global alcança qualquer ocupação.
  assert.match(corpo(M062, 'kidmais062_mesmo_recurso'), /e1 IS NULL OR e2 IS NULL OR e1=e2/);
  assert.match(corpo(M062, 'kidmais062_bloqueio_aplica'), /be IS NULL OR e IS NULL/);
  // Listado nominalmente (consulta 2), sem identificar cliente na disponibilidade.
  assert.match(LEVANTAMENTO, /-- 2\. GLOBAL — contratações que ocupam agenda[\s\S]*WHERE o\.empresa_id IS NULL/);
  // Nenhuma migration, reparo ou código atribui empresa a fechamento existente.
  const reparos = [PRINCIPAL, BLOQUEIOS, FECHAMENTOS, LEVANTAMENTO, M062];
  const atribuiEmpresa = /UPDATE\s+(public\.)?fechamentos\b(\s+\w+)?\s+SET\s+(?:(?!\bFROM\b|\bWHERE\b)[^;])*\bempresa_id\s*=/i;
  assert.match('UPDATE fechamentos f SET estabelecimento_id = 1, empresa_id = 2 WHERE x', atribuiEmpresa, 'o detector pega a atribuição');
  assert.doesNotMatch('UPDATE fechamentos f SET estabelecimento_id = r.x FROM r WHERE f.empresa_id = r.empresa_id', atribuiEmpresa, 'filtro por empresa não é atribuição');
  for (const sql of reparos) assert.doesNotMatch(sql, atribuiEmpresa);
  assert.match(FECHAMENTOS, /WHERE r\.fechamento_id = f\.id AND f\.empresa_id = r\.empresa_id AND f\.estabelecimento_id IS NULL/, 'D2 exige empresa já definida');
  const doc = ler('docs/CONTRATOS_IMPORTADOS_INTEGRACAO.md');
  assert.match(doc, /\*\*D7 — contratações legadas sem empresa:\*\*/);
});
