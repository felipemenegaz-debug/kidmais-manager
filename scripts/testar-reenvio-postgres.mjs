// Opt-in explícito. Somente cluster local descartável criado para este teste.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import * as documentos from '../lib/importacao-contrato/repositorio-documentos.ts';
import * as importacoes from '../lib/importacao-contrato/repositorio-importacao.ts';
import { extrairTextoPdfIsolado } from '../lib/importacao-contrato/pdf-isolado.ts';
import { atenderDocumento } from '../lib/inteligencia/documentos/upload.ts';
import { atenderImportacao } from '../lib/inteligencia/importacao/revisao.ts';
import { criarAcaoImportacao } from '../lib/inteligencia/importacao/acao.ts';
import { criarRepositorioOperacoesEmMemoria } from '../lib/inteligencia/acoes/memoria.ts';

assert.equal(process.env.KIDMAIS_TESTE_REENVIO, 'AUTORIZADO');
const db = new Client({ host: '127.0.0.1', port: 55447, user: 'postgres', password: '', database: 'kidmais_reenvio_descartavel', connectionTimeoutMillis: 3000 });
await db.connect();
try {
  const alvo = (await db.query('SELECT current_database() AS db, current_setting(\'data_directory\') AS dir')).rows[0];
  assert.equal(alvo.db, 'kidmais_reenvio_descartavel');
  assert.match(alvo.dir.replaceAll('\\', '/'), /\/kidmais-manager-correcoes-20261002\/\.local-reenvio-pg-20261002$/);
  assert.equal((await db.query("SELECT to_regclass('public.ia_documentos') AS tabela")).rows[0].tabela, null, 'Exige banco novo');
  await db.query('CREATE TABLE empresas(id uuid PRIMARY KEY); CREATE TABLE usuarios_administrativos(id uuid PRIMARY KEY)');
  const a = readFileSync('database/migrations/20260928_055a_inteligencia_uso.sql', 'utf8');
  const guarda = a.match(/CREATE FUNCTION kidmais_055_somente_insercao\(\)[\s\S]*?END \$\$;/);
  assert(guarda, 'Guarda real 055a ausente');
  await db.query(guarda[0]);
  for (const sql of ['20260928_055c_inteligencia_documentos.sql', '20260928_055d_inteligencia_importacoes.sql']) await db.query(readFileSync(`database/migrations/${sql}`, 'utf8'));
  const empresaId = randomUUID(), usuarioId = randomUUID();
  await db.query('INSERT INTO empresas VALUES ($1)', [empresaId]);
  await db.query('INSERT INTO usuarios_administrativos VALUES ($1)', [usuarioId]);
  const base = {
    env: { INTELIGENCIA_ENABLED: 'true', AI_CONTRACT_IMPORT_ENABLED: 'true' },
    autenticar: async () => ({ usuario_id: usuarioId, papel: 'ADMINISTRATIVO' }),
    withTenantTransaction: async (_s, empresa, trabalho) => {
      assert.equal(empresa, empresaId);
      await db.query('BEGIN');
      try { const r = await trabalho(db, { empresaComprovada: empresaId, usuarioId, membershipId: randomUUID(), papelAtual: 'ADMINISTRATIVO' }); await db.query('COMMIT'); return r; }
      catch (e) { await db.query('ROLLBACK'); throw e; }
    },
    agora: () => new Date(), requestId: randomUUID, registrar: () => {},
  };
  const porta = { ...importacoes, disponivel: importacoes.importacaoDisponivel, ultimaExtracao: documentos.ultimaExtracao,
    analisarCliente: async () => ({ cpfExistente: null, possiveisDuplicidades: [] }), executar: async () => { throw Error('Confirmação de negócio fora do teste'); } };
  const deps = { ...base, importacao: porta, acao: criarAcaoImportacao(porta), gate: { repositorio: criarRepositorioOperacoesEmMemoria(), agora: () => new Date(), novoId: randomUUID, ttlConfirmacaoSegundos: 600 } };
  const arquivo = { nome: 'Contrato KidMais.pdf', tipo: 'application/pdf', bytes: new Uint8Array(readFileSync(process.argv[2])) };
  const enviar = (leitor) => atenderDocumento({ empresaSolicitada: empresaId, lerArquivo: async () => arquivo }, { ...base, documentos: { ...documentos, disponivel: documentos.documentosDisponiveis }, roteador: null, lerPdf: leitor });
  const abrir = (documentoId) => atenderImportacao({ empresaSolicitada: empresaId, lerCorpo: async () => ({ acao: 'abrir', documentoId }) }, deps);
  // Reproduz o histórico anterior à correção: extração vazia + revisão ativa vazia.
  const primeiro = await enviar(async () => ({ paginas: [], avisos: [], interrompido: null }));
  assert.equal(primeiro.status, 200);
  const documentoId = primeiro.corpo.data.documentoId;
  const antiga = await abrir(documentoId);
  assert.equal(antiga.status, 200);
  const relido = await enviar(extrairTextoPdfIsolado);
  assert.equal(relido.status, 200, JSON.stringify(relido.corpo));
  const novaExtracao = await documentos.ultimaExtracao(db, empresaId, documentoId);
  // Prova que a operação antiga falha com a guarda real antes de testar a recuperação.
  await db.query('BEGIN');
  await assert.rejects(db.query('UPDATE ia_importacoes SET extracao_id = $2, versao = versao + 1 WHERE id = $1', [antiga.corpo.data.importacao.id, novaExtracao.extracaoId]), /Identidade da importação é imutável/);
  await db.query('ROLLBACK');
  const revisao = await abrir(documentoId);
  assert.equal(revisao.status, 200, JSON.stringify(revisao.corpo));
  assert.notEqual(revisao.corpo.data.importacao.id, antiga.corpo.data.importacao.id);
  const cs = revisao.corpo.data.importacao.extracao.secoes.flatMap(s => s.campos);
  assert.equal(cs.filter(c => c.estado === 'ENCONTRADO').length, 13);
  const historico = (await db.query('SELECT status FROM ia_importacoes ORDER BY criado_em')).rows;
  assert.deepEqual(historico.map(x => x.status), ['DESCARTADA', 'EM_REVISAO']);
  const replay = await abrir(documentoId);
  assert.equal(replay.corpo.data.importacao.id, revisao.corpo.data.importacao.id);
  console.log(JSON.stringify({ resultado: 'PASS', fluxo: 'upload vazio → revisão antiga → releitura do PDF → nova revisão → replay', encontrados: 13, historico: historico.map(x => x.status), banco: 'local descartável' }));
} finally { await db.end(); }
