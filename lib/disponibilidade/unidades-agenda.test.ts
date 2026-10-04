import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DbExecutor } from '../db/contracts.ts';
import { AvailabilityServiceError } from './services/errors.ts';
import { habilitarUnidadeAgenda, listarUnidadesAgenda, revogarUnidadeAgenda, type AuditoriaAgenda } from './unidades-agenda.ts';

/**
 * Habilitação de unidade para agenda (D6 = opção A) sem banco: papel, motivo, empresa comprovada, idempotência de
 * estado (já habilitada / não habilitada) e auditoria na mesma transação. As guardas do banco (operador ativo, histórico
 * imutável, efeitos da revogação) são provadas em agenda-062.postgres.test.ts.
 */
const EMPRESA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OUTRA = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const U1 = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
const DESATIVADA = 'a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3';
const USUARIO = '99999999-9999-4999-8999-999999999999';
const ctx = { requestId: 'req', ip: null, userAgent: 'teste' };
const representante = { empresaComprovada: EMPRESA, usuarioId: USUARIO, papelAtual: 'REPRESENTANTE_AUTORIZADO' };

function banco(opcoes: { v062?: boolean; vigente?: boolean; reservas?: number } = {}) {
  const estado = { vigente: opcoes.vigente ?? false, sql: [] as Array<{ text: string; values: readonly unknown[] }> };
  const db: DbExecutor = {
    async query(text: string, values: readonly unknown[] = []) {
      estado.sql.push({ text, values });
      const linhas = (rows: unknown[]) => ({ rows, rowCount: rows.length }) as never;
      if (text.includes('to_regprocedure')) return linhas([{ instalada: opcoes.v062 ?? true }]);
      // Ordem única de locks (062): empresa → unidade (FOR NO KEY UPDATE: não conflita com o KEY SHARE do FK).
      if (text.includes('FROM public.empresas WHERE id = $1::uuid FOR SHARE')) return linhas(values[0] === EMPRESA ? [{}] : []);
      if (text.includes('FROM public.estabelecimentos WHERE empresa_id = $1::uuid AND id = $2::uuid FOR NO KEY UPDATE')) {
        if (values[0] !== EMPRESA) return linhas([]);
        return linhas(values[1] === U1 ? [{ status: 'SUSPENSO' }] : values[1] === DESATIVADA ? [{ status: 'DESATIVADO' }] : []);
      }
      if (text.includes('SELECT 1 FROM public.agenda_062_unidades_habilitacao')) return linhas(estado.vigente ? [{}] : []);
      if (text.includes('INSERT INTO public.agenda_062_unidades_habilitacao')) { estado.vigente = true; return linhas([{ id: 'h1', habilitada_em: '2026-10-03 10:00' }]); }
      if (text.includes('UPDATE public.agenda_062_unidades_habilitacao')) {
        if (!estado.vigente) return linhas([]);
        estado.vigente = false;
        return linhas([{ id: 'h1', habilitada_em: '2026-10-03 10:00', revogada_em: '2026-10-03 11:00' }]);
      }
      if (text.includes('count(*)::int AS n FROM public.fechamentos')) return linhas([{ n: opcoes.reservas ?? 0 }]);
      if (text.includes('FROM public.estabelecimentos u')) return linhas([{ id: U1, codigo: 'centro', nome: 'Centro', habilitada_em: estado.vigente ? 'x' : null, motivo_habilitacao: null, reservas: 2 }]);
      throw new Error(`SQL inesperado: ${text.slice(0, 80)}`);
    },
  };
  return Object.assign(estado, { db });
}

const erro = (codigo: string, status?: number) => (e: unknown) => e instanceof AvailabilityServiceError && e.code === codigo && (status === undefined || e.httpStatus === status);

test('habilitar: só o Representante autorizado, com motivo, na unidade da empresa comprovada; auditado na mesma transação', async () => {
  const b = banco();
  const auditoria: AuditoriaAgenda[] = [];
  const auditar = async (tx: DbExecutor, r: AuditoriaAgenda) => { assert.equal(tx, b.db); auditoria.push(r); };
  await assert.rejects(habilitarUnidadeAgenda(b.db, { ...representante, papelAtual: 'ADMINISTRATIVO' }, U1, 'Abertura da unidade', ctx, auditar), erro('PAPEL_NAO_AUTORIZADO', 403));
  await assert.rejects(habilitarUnidadeAgenda(b.db, representante, U1, '  ab ', ctx, auditar), erro('MOTIVO_OBRIGATORIO', 400));
  assert.equal(b.sql.length, 0, 'recusa de papel ou motivo antes de qualquer SQL');
  await assert.rejects(habilitarUnidadeAgenda(b.db, { ...representante, empresaComprovada: OUTRA }, U1, 'Abertura da unidade', ctx, auditar), erro('UNIDADE_NAO_ENCONTRADA', 404), 'unidade de outra empresa = não encontrada');
  await assert.rejects(habilitarUnidadeAgenda(b.db, representante, DESATIVADA, 'Abertura da unidade', ctx, auditar), erro('UNIDADE_DESATIVADA', 409));
  const r = await habilitarUnidadeAgenda(b.db, representante, U1, 'Abertura da unidade', ctx, auditar);
  assert.equal(r.habilitacaoId, 'h1');
  const insert = b.sql.find((q) => q.text.includes('INSERT INTO public.agenda_062_unidades_habilitacao'))!;
  assert.deepEqual(insert.values, [EMPRESA, U1, USUARIO, 'REPRESENTANTE_AUTORIZADO', 'Abertura da unidade'], 'empresa, operador e papel do Tenant Context');
  assert.deepEqual(auditoria.map((a) => [a.acao, a.entidadeId, a.justificativa, a.usuarioId]), [['AGENDA_UNIDADE_HABILITADA', U1, 'Abertura da unidade', USUARIO]]);
  await assert.rejects(habilitarUnidadeAgenda(b.db, representante, U1, 'De novo', ctx, auditar), erro('UNIDADE_JA_HABILITADA', 409), 'nenhuma habilitação duplicada');
});

test('revogar: suspensão administrativa com motivo; informa as reservas futuras preservadas; sem habilitação vigente = 409', async () => {
  const b = banco({ vigente: true, reservas: 3 });
  const auditoria: AuditoriaAgenda[] = [];
  const auditar = async (_tx: DbExecutor, r: AuditoriaAgenda) => { auditoria.push(r); };
  await assert.rejects(revogarUnidadeAgenda(b.db, { ...representante, papelAtual: 'ADMINISTRATIVO' }, U1, 'Reforma', ctx, auditar), erro('PAPEL_NAO_AUTORIZADO', 403));
  const r = await revogarUnidadeAgenda(b.db, representante, U1, 'Reforma no salão', ctx, auditar);
  assert.equal(r.reservasFuturasPreservadas, 3);
  const update = b.sql.find((q) => q.text.includes('UPDATE public.agenda_062_unidades_habilitacao'))!;
  assert.match(update.text, /WHERE empresa_id = \$1::uuid AND estabelecimento_id = \$2::uuid AND revogada_em IS NULL/);
  assert.deepEqual(update.values, [EMPRESA, U1, USUARIO, 'REPRESENTANTE_AUTORIZADO', 'Reforma no salão']);
  assert.equal(auditoria[0].acao, 'AGENDA_UNIDADE_REVOGADA');
  assert.deepEqual(auditoria[0].dadosDepois.reservasFuturasPreservadas, 3);
  assert.ok(!b.sql.some((q) => /DELETE|UPDATE public\.fechamentos/.test(q.text)), 'revogar não apaga nem altera reservas');
  await assert.rejects(revogarUnidadeAgenda(b.db, representante, U1, 'Reforma no salão', ctx, auditar), erro('UNIDADE_NAO_HABILITADA', 409));
});

test('sem a 062: habilitação indisponível; listagem só da empresa comprovada', async () => {
  const antes = banco({ v062: false });
  await assert.rejects(habilitarUnidadeAgenda(antes.db, representante, U1, 'Abertura da unidade', ctx, async () => undefined), erro('AGENDA_POR_UNIDADE_INDISPONIVEL', 503));
  await assert.rejects(listarUnidadesAgenda(antes.db, EMPRESA), erro('AGENDA_POR_UNIDADE_INDISPONIVEL', 503));
  const b = banco({ vigente: true });
  const lista = await listarUnidadesAgenda(b.db, EMPRESA);
  assert.deepEqual(lista.map((u) => [u.id, u.habilitada, u.reservasFuturas]), [[U1, true, 2]]);
  assert.deepEqual(b.sql.at(-1)!.values, [EMPRESA]);
  assert.match(b.sql.at(-1)!.text, /WHERE u\.empresa_id = \$1::uuid AND u\.status <> 'DESATIVADO'/);
});
