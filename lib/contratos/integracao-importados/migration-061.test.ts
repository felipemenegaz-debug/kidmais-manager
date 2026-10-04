import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { estruturaFesta019Sql } from '../../festas/estrutura-019.ts';

/** Contrato estático da 061 (nenhuma conexão com banco). O comportamento dos gatilhos é coberto por integracao.postgres.test.ts. */
const ler = (f: string) => readFileSync(f, 'utf8').replaceAll('\r', '');
const M061 = ler('database/migrations/20261002_061_contratos_importados_integracao.sql');
const M019 = ler('database/migrations/20260915_019_festa_formalizacao.sql');
const M057 = ler('database/migrations/20260929_057_assinatura_contrato_empresa.sql');
const M015 = ler('database/migrations/20260910_015_tratamento_financeiro.sql');
const DOWN = ler('database/rollback/20261002_061_contratos_importados_integracao_down.sql');
const PRE = ler('database/checks/20261002_061_precheck.sql');
const POS = ler('database/checks/20261002_061_postcheck.sql');

const corpo = (sql: string, nome: string) => {
  const m = sql.match(new RegExp(String.raw`CREATE (?:OR REPLACE )?FUNCTION (?:public\.)?` + nome + String.raw`\([\s\S]*?AS \$\$([\s\S]*?)\$\$;`));
  assert.ok(m, `função ${nome}`);
  return m[1];
};
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const md5 = (s: string) => createHash('md5').update(s).digest('hex');
/** SQL fora dos corpos $$...$$ (o que a migration executa diretamente). */
const topo = (sql: string) => sql.replace(/\$\$[\s\S]*?\$\$/g, '$$…$$');

test('061 não faz backfill nem integra nada: sem INSERT/UPDATE/DELETE de dados no nível da migration', () => {
  const t = topo(M061);
  assert.doesNotMatch(t, /^\s*(INSERT|UPDATE|DELETE)\b/im);
  assert.match(M061, /NÃO APLICADA\. Exige autorização explícita/);
  assert.match(M061, /RAISE EXCEPTION '061 já aplicada\.'/);
});

const SUBSTITUIDAS = ['kidmais019_formalizacao', 'kidmais_ocupacoes_operacionais', 'kidmais_validar_agenda_revisao'];
const HASHES_019: Record<string, string> = {
  kidmais019_formalizacao: 'ef21416cd23e5a2d59c486abc83470ca47dc30a2ef8501b488d216c88804fa25',
  kidmais019_ocupa: '87131946b52479651484ec9076ce264243e79867ab2bc1f02447c6a2eb0599a3',
  kidmais_ocupacoes_operacionais: '2257c1df5a299a86d60a59b8606e432715dd10d713e4659f370934dcf483be91',
  kidmais_validar_agenda_revisao: '997158485f6dc9595cf6045594b220206c59c31b631bc164aad3956963875e89',
};

test('precheck exige os corpos exatos da 019/057; postcheck exige os da 061 e a ocupação da 019 intacta', () => {
  for (const [nome, hash] of Object.entries(HASHES_019)) assert.equal(sha(corpo(M019, nome)), hash, nome);
  assert.equal(md5(corpo(M057, 'kidmais_validar_fluxo_contrato')), 'e7d4d19ac1b1d925135adbc45a2247a5');
  for (const sql of [M061, PRE]) {
    for (const nome of SUBSTITUIDAS) assert.ok(sql.includes(HASHES_019[nome]), nome);
    assert.ok(sql.includes('e7d4d19ac1b1d925135adbc45a2247a5'));
  }
  for (const nome of SUBSTITUIDAS) assert.ok(POS.includes(sha(corpo(M061, nome))), nome);
  assert.ok(POS.includes(HASHES_019.kidmais019_ocupa), 'ocupação continua a da 019');
  assert.ok(POS.includes(md5(corpo(M061, 'kidmais_validar_fluxo_contrato'))));
  assert.match(POS, /a instalação não pode integrar contratos \(sem backfill\)/);
});

test('a 061 não toca a reserva (kidmais019_ocupa) e substitui exatamente três funções da 019', () => {
  assert.doesNotMatch(M061, /FUNCTION public\.kidmais019_ocupa\(/);
  const substituidas = [...M061.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\(/g)].map((x) => x[1]).filter((n) => n !== 'kidmais_validar_fluxo_contrato' && n !== 'kidmais_015_validar');
  assert.deepEqual(substituidas, SUBSTITUIDAS);
  assert.equal(M061.split('CREATE OR REPLACE FUNCTION public.kidmais_015_validar(').length, 2, 'a 015 é substituída uma única vez');
});

// R5: o gatilho financeiro diferido da 015 recusava no commit a parcela histórica preservada (PIX depois da festa).
const HASH_015 = 'f003f5f39c136b98aa3d1784584b1dca8fd6aca9fd665dc7351d3044e6f6e06c';
const ANTES_015 = 'AND i.vencimento_referencia>r.data_festa_referencia)))';
const DEPOIS_015 = 'AND i.vencimento_referencia>r.data_festa_referencia AND NOT public.kidmais061_excecao_historica(i.parcela_id,i.vencimento_referencia))))';

test('[R5] 015: a 061 muda SÓ a condição de vencimento PIX do gatilho financeiro (exceção do plano histórico); pre/postcheck e rollback byte a byte', () => {
  assert.equal(sha(corpo(M015, 'kidmais_015_validar')), HASH_015);
  assert.equal(corpo(M015, 'kidmais_015_validar').split(ANTES_015).length, 2, 'condição original única');
  assert.equal(corpo(M061, 'kidmais_015_validar'), corpo(M015, 'kidmais_015_validar').split(ANTES_015).join(DEPOIS_015), 'nenhuma outra mudança');
  for (const sql of [M061, PRE]) assert.ok(sql.includes(HASH_015), 'precheck exige o corpo da 015');
  assert.ok(M061.indexOf(HASH_015) < M061.indexOf('CREATE OR REPLACE FUNCTION public.kidmais_015_validar'), 'confere antes de substituir');
  assert.ok(POS.includes(sha(corpo(M061, 'kidmais_015_validar'))), 'postcheck exige o corpo da 061');
  assert.equal(corpo(DOWN, 'kidmais_015_validar'), corpo(M015, 'kidmais_015_validar'), 'rollback restaura a 015');
  assert.ok(DOWN.indexOf('FUNCTION public.kidmais_015_validar') < DOWN.indexOf('DROP FUNCTION public.kidmais061_excecao_historica(uuid, date);'), 'restaura antes de remover a função usada');
  assert.ok(DOWN.includes(HASH_015), 'rollback confere o corpo restaurado');
  // Mesmo critério do serviço: plano versão 1, confirmação gravada para o número e o vencimento.
  const excecao = corpo(M061, 'kidmais061_excecao_historica');
  for (const trecho of ["pl.numero_versao=1", "->>'aposFestaConfirmada'='true'", "->>'vencimento'=pp.vencimento::text", "WHERE pp.id=$1 AND pp.vencimento=$2"]) {
    assert.ok(excecao.includes(trecho), trecho);
  }
  const repo = ler('lib/pagamentos/repositories/alteracao-financeira.repository.ts');
  assert.ok(repo.includes('pl.numero_versao = 1'), 'serviço com o mesmo critério');
});

test('rollback recusa com dados integrados e restaura 019/057 byte a byte', () => {
  assert.match(DOWN, /Rollback 061 recusado: há contratos históricos integrados/);
  // Com as regras da 062 instaladas, a 061 não pode ser desfeita (restauraria a agenda global por baixo da 062).
  assert.match(DOWN, /IF to_regprocedure\('public\.kidmais062_ocupacoes_escopo\(date,date\)'\) IS NOT NULL THEN\s+RAISE EXCEPTION 'Rollback 061 recusado: a 062 está aplicada; aplique antes o rollback da 062\.'/);
  assert.ok(DOWN.indexOf('a 062 está aplicada') < DOWN.indexOf('DROP TRIGGER'), 'a recusa vem antes de qualquer remoção');
  for (const nome of SUBSTITUIDAS) assert.equal(corpo(DOWN, nome), corpo(M019, nome), nome);
  assert.equal(corpo(DOWN, 'kidmais_validar_fluxo_contrato'), corpo(M057, 'kidmais_validar_fluxo_contrato'));
  assert.match(DOWN, /DROP FUNCTION public\.kidmais061_historico_passado\(uuid\);/);
  assert.match(DOWN, /aceite_metodo IN \('OTP'\)/);
  assert.match(DOWN, /origem_fechamento IN \('CLIENTE', 'ATENDIMENTO_KIDMAIS'\)\)/);
});

test('formalização: o fluxo nativo fica idêntico e a conferência em papel é um OR explícito, sem assinatura digital', () => {
  const nativo = corpo(M019, 'kidmais019_formalizacao').trim().replace(/;$/, '');
  const novo = corpo(M061, 'kidmais019_formalizacao');
  assert.ok(novo.includes(nativo), 'consulta nativa preservada');
  assert.match(novo, /OR public\.kidmais061_conferencia_historica\(cid,vid\);/);
  const hist = corpo(M061, 'kidmais061_conferencia_historica');
  for (const exigido of ["v.aceite_metodo='CONFERENCIA_PAPEL'", 'v.documento_pdf_hash=ci.documento_sha256', 'NOT EXISTS(SELECT 1 FROM contrato_assinaturas a WHERE a.contrato_versao_id=v.id)',
    "c.status='ASSINADO' AND c.cancelado_em IS NULL", "e.estado='CONCLUIDA' AND e.tipo='INICIAL' AND e.documento_revisado_id IS NULL"]) {
    assert.ok(hist.includes(exigido), exigido);
  }
});

test('validação de fluxo: todas as linhas da 057 continuam; o ramo novo só vale para CONFERENCIA_PAPEL e recusa assinatura', () => {
  const novo = corpo(M061, 'kidmais_validar_fluxo_contrato');
  const linhasNovo = new Set(novo.split('\n').map((l) => l.trim()));
  for (const linha of corpo(M057, 'kidmais_validar_fluxo_contrato').split('\n').map((l) => l.trim()).filter(Boolean)) {
    assert.ok(linhasNovo.has(linha), `linha da 057 ausente: ${linha.slice(0, 80)}`);
  }
  assert.match(novo, /papel := v\.aceite_metodo='CONFERENCIA_PAPEL';/);
  assert.match(novo, /IF papel THEN RAISE EXCEPTION 'Contrato histórico conferido não recebe assinatura digital'/);
  assert.match(novo, /v\.numero_versao<>1 OR e\.tipo<>'INICIAL'/, 'só a versão 1 pode ser de conferência; versões seguintes seguem o OTP');
});

test('agenda: só o slot histórico integrado (já realizado) sai da detecção de conflito; qualquer remarcação volta a ocupar', () => {
  const hist = corpo(M061, 'kidmais061_historico_passado');
  // Isenção amarrada ao slot exato gravado na integração e à data já passada naquele momento.
  for (const exigido of ['ci.data_evento<ci.agenda_a_partir_de', 'f.data_evento=ci.data_evento', 'f.horario_inicio=ci.horario_inicio', 'f.horario_fim=ci.horario_fim']) {
    assert.ok(hist.includes(exigido), exigido);
  }
  // Slot e data de referência vêm do banco (gatilho), não do cliente.
  const vinc = corpo(M061, 'kidmais061_validar_vinculo');
  assert.match(vinc, /NEW\.agenda_a_partir_de := \(clock_timestamp\(\) AT TIME ZONE 'America\/Sao_Paulo'\)::date;/);
  assert.match(vinc, /NEW\.data_evento := f\.data_evento; NEW\.horario_inicio := f\.horario_inicio; NEW\.horario_fim := f\.horario_fim;/);
  // Ocupações: a 019 com UMA condição a mais no ramo confirmado; o ramo de hold de revisão é o mesmo.
  const ocupacoes = corpo(M061, 'kidmais_ocupacoes_operacionais');
  assert.equal(ocupacoes.replace(' AND NOT public.kidmais061_historico_passado(f.id)', ''), corpo(M019, 'kidmais_ocupacoes_operacionais'));
  // Validação de agenda: o ramo de fechamentos ignora o slot histórico integrado; hold e revisão iguais à 019.
  const agenda = corpo(M061, 'kidmais_validar_agenda_revisao');
  assert.equal(agenda.replace(' OR public.kidmais061_historico_passado(f.id)', ''), corpo(M019, 'kidmais_validar_agenda_revisao'));
  // A reserva continua vigente: o hold da remarcação ("Hold exige reserva vigente confirmada") segue kidmais019_ocupa.
  assert.match(agenda, /IF r\.hold_destino_adquirido_em IS NOT NULL AND NOT public\.kidmais019_ocupa\(f\.id\)/);
});

test('vínculo e conferência financeira: imutáveis, mesma empresa, operador ativo e soma em centavos', () => {
  assert.match(M061, /contrato_importacoes_importacao_uk UNIQUE \(importacao_id\)/);
  assert.match(M061, /CONSTRAINT contrato_importacao_financeiro_soma_ck CHECK \(recebido_centavos \+ saldo_centavos = contratado_centavos\)/);
  assert.match(M061, /CREATE TRIGGER contrato_importacoes_imutavel_trg BEFORE UPDATE OR DELETE/);
  assert.match(M061, /CREATE TRIGGER contrato_importacao_financeiro_imutavel_trg BEFORE UPDATE OR DELETE/);
  const vinc = corpo(M061, 'kidmais061_validar_vinculo');
  assert.match(vinc, /i\.empresa_id<>NEW\.empresa_id OR i\.status<>'IMPORTADA'/);
  assert.match(vinc, /m\.empresa_id=NEW\.empresa_id AND m\.usuario_id=NEW\.conferido_por AND m\.status='ATIVA' AND m\.papel=NEW\.conferido_papel/);
  assert.match(corpo(M061, 'kidmais061_exigir_vinculo'), /Festa de importação histórica só nasce da conferência do contrato importado/);
  // Conferência posterior de pagamentos: só na versão conferida ainda vigente, sem revisão aberta e sem cancelamento.
  const fin = corpo(M061, 'kidmais061_validar_financeiro');
  assert.match(fin, /cf\.versao_vigente_id=ci\.contrato_versao_id AND c\.status<>'CANCELADO' AND f\.status<>'CANCELADO'/);
  assert.match(fin, /r\.estado IN \('EM_ELABORACAO','CONGELADA'\)/);
  assert.match(fin, /a versão conferida não é mais a vigente/);
  // Exceção histórica (vencimento depois da festa) conferida no banco: mesma parcela, mesmo vencimento, confirmação gravada.
  assert.match(fin, /pp\.vencimento>f\.data_evento/);
  assert.match(fin, /->>'aposFestaConfirmada','false'\)='true'/);
  assert.match(fin, /->>'vencimento'=pp\.vencimento::text/);
  assert.match(fin, /parcela vence depois da festa sem a exceção histórica confirmada/);
});

/** Conjuntos que o módulo Festa aceita: conjunto → função → hash (lidos do SQL gerado). */
function conjuntosFesta(sql: string) {
  const conjuntos: Record<string, Record<string, string>> = {};
  for (const [, c, nome, hash] of sql.matchAll(/\('(\d{3})','(\w+)','([0-9a-f]{64})'\)/g)) (conjuntos[c] ??= {})[nome] = hash;
  return conjuntos;
}

test('módulo Festa aceita conjuntos coerentes (019 ou 061), nunca mistura função a função', () => {
  const conjuntos = conjuntosFesta(estruturaFesta019Sql);
  const f019 = conjuntos['019'];
  assert.equal(Object.keys(f019).length, 10);
  for (const [nome, hash] of Object.entries(f019)) assert.equal(hash, sha(corpo(M019, nome)), `019: ${nome}`);
  const f061 = conjuntos['061'];
  assert.deepEqual(Object.keys(f061).sort(), Object.keys(f019).sort());
  for (const nome of Object.keys(f019)) {
    assert.equal(f061[nome], SUBSTITUIDAS.includes(nome) ? sha(corpo(M061, nome)) : f019[nome], `061: ${nome}`);
  }
  // Válido se ALGUM conjunto bate por inteiro; o IN por função (que aceitava misturas) não existe mais.
  assert.match(estruturaFesta019Sql, /EXISTS\(SELECT 1 FROM \(SELECT DISTINCT conjunto FROM esperadas\) c WHERE NOT EXISTS\(SELECT 1 FROM esperadas e WHERE e\.conjunto=c\.conjunto/);
  assert.doesNotMatch(estruturaFesta019Sql, /x\.nome=e\.nome/);
});

test('SQL da 061/062 (migrations, checks, rollbacks e reparos): delimitadores $tag$ pareados e nenhum bloco DO com delimitador quebrado', () => {
  const dirs = ['database/migrations', 'database/checks', 'database/rollback', 'database/repairs'];
  const arquivos = dirs.flatMap((d) => readdirSync(d).filter((n) => /2026100[12]_06[12]_/.test(n)).map((n) => d + '/' + n));
  assert.ok(arquivos.length >= 10, String(arquivos.length));
  for (const arquivo of arquivos) {
    const sql = ler(arquivo);
    assert.doesNotMatch(sql, /\bDO \$ /, arquivo);
    const tags = new Map<string, number>();
    for (const [tag] of sql.matchAll(/\$[A-Za-z_]*\$/g)) tags.set(tag, (tags.get(tag) ?? 0) + 1);
    for (const [tag, n] of tags) assert.equal(n % 2, 0, arquivo + ': ' + tag + ' ímpar');
  }
});
