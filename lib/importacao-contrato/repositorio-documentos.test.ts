import test from 'node:test';
import assert from 'node:assert/strict';
import type { DbExecutor } from '../db/contracts.ts';
import { registrarExtracao, type RegistroExtracao } from './repositorio-documentos.ts';

// Simula a guarda da 055c, sem conectar ao PostgreSQL: estado final não muda.
test('releitura guarda uma nova extração e evidências preservando o estado final da primeira leitura', async () => {
  for (const inicial of ['RECEBIDO', 'PRECISA_REVISAO', 'EXTRAIDO', 'FALHOU']) {
    let status = inicial;
    const extracoes: unknown[] = [];
    const evidencias: unknown[] = [];
    const tx: DbExecutor = {
      async query<Row extends object>(sql: string, valores: readonly unknown[] = []) {
        if (sql.includes('INSERT INTO ia_extracoes')) {
          extracoes.push(valores);
          return { rows: [{ id: 'nova-extracao' }] as unknown as Row[], rowCount: 1 };
        }
        if (sql.includes('INSERT INTO ia_evidencias')) evidencias.push(valores);
        if (sql.includes('UPDATE ia_documentos')) {
          const selecionado = !sql.includes("AND status = 'RECEBIDO'") || status === 'RECEBIDO';
          if (selecionado) {
            if (status !== 'RECEBIDO' && valores[2] !== status) throw Object.assign(new Error('Estado final do documento não muda.'), { code: 'P0001' });
            status = String(valores[2]);
          }
        }
        return { rows: [] as Row[], rowCount: 0 };
      },
    };
    const entrada: RegistroExtracao = {
      empresaId: 'empresa', documentoId: 'documento', originalId: 'original', metodo: 'DETERMINISTICO',
      provedor: null, modelo: null, schemaVersao: 1, status: 'SUCESSO', resultado: { secoes: [] }, erro: null,
      correlationId: 'reenvio', iniciadoEm: '2026-10-02T20:00:00Z', concluidoEm: '2026-10-02T20:00:01Z',
      evidencias: [{ campo: 'evento.data', pagina: 1, trecho: 'Data: 18/10/2026', conferida: true }],
    };
    await registrarExtracao(tx, entrada);
    await registrarExtracao(tx, { ...entrada, status: 'PARCIAL' });
    assert.equal(status, inicial === 'RECEBIDO' ? 'EXTRAIDO' : inicial);
    assert.equal(extracoes.length, 2);
    assert.equal(evidencias.length, 2);
  }
});
