import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as utils from './horario.utils.ts';
import * as erros from './errors.ts';

/** Apoio dos testes de duração do pacote no horário livre: serviço real de disponibilidade com repositórios simulados. */
export const EMPRESA = '00000000-0000-4000-8000-0000000000e1';
export const LIVRE = { id: 'livre', codigo: 'LIVRE', nome: 'Horário livre', horarioInicioPadrao: '00:00:00', horarioFimPadrao: '23:59:00', toleranciaInicioMinutos: 0, passoInicioMinutos: 30, ordemExibicao: 0, ativo: true };
export const FIXO = { id: 'tarde', codigo: 'TURNO_1', nome: 'Tarde', horarioInicioPadrao: '15:00:00', horarioFimPadrao: '19:00:00', toleranciaInicioMinutos: 0, passoInicioMinutos: 30, ordemExibicao: 0, ativo: true };
export const bloqueio = (inicio: string, fim: string) => ({ id: 'b', data: '2026-11-20', diaInteiro: false, horarioInicio: inicio, horarioFim: fim, motivo: 'x', observacoes: null, criadoPorUsuarioId: null, ativo: true, criadoEm: '2026-10-01' });
export const regra = (modo: 'LIVRE' | 'FIXO') => ({ modo, horarioLivre: modo === 'LIVRE' ? LIVRE : null, capacidadeTipo: 'POR_HORARIO' as const, limiteFestasDia: null, intervaloMinimoMinutos: 0, capacidadePorHorario: {}, saloesPorHorario: {}, saloesDoEscopo: [] });

export function transpilar(arquivo: string, mocks: Record<string, unknown>, estrito = true) {
  const exports: Record<string, unknown> = {};
  const code = ts.transpileModule(readFileSync(arquivo, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  new Function('require', 'exports', code)((n: string) => {
    if (n in mocks) return mocks[n];
    assert.ok(!estrito, `dependência não prevista: ${n}`);
    return new Proxy({}, { get: () => async () => [] });
  }, exports);
  return exports;
}

export function servico(modo: 'LIVRE' | 'FIXO', pacoteDuracao: number | null, bloqueios: unknown[] = [], menor: number | null = null) {
  const pacotes: unknown[] = [];
  const menores: unknown[] = [];
  const tx = {
    query: async (sql: string, params: unknown[]) => {
      if (sql.includes('duracao_minutos FROM pacotes')) { pacotes.push(params); return { rows: pacoteDuracao === undefined ? [] : [{ duracao_minutos: pacoteDuracao }] }; }
      if (sql.includes('min(p.duracao_minutos)')) { menores.push(params); return { rows: [{ menor }] }; }
      return { rows: [] };
    },
  };
  const m = transpilar('lib/disponibilidade/services/availability.service.ts', {
    '../../db/postgres.ts': { db: () => tx },
    '../escopo.ts': { escopoDoFechamento: async () => ({ empresaId: EMPRESA, estabelecimentoId: null }) },
    '../repositories/disponibilidade.repository.ts': {
      listarConfiguracoesAgendaAtivas: async () => (modo === 'FIXO' ? [FIXO] : []),
      listarBloqueiosAtivosPorPeriodo: async () => bloqueios,
      listarFechamentosConfirmadosPorPeriodo: async () => [],
      lerRegraCapacidadeAgenda: async () => regra(modo),
    },
    './errors.ts': erros,
    './horario.utils.ts': utils,
  }) as unknown as {
    consultarDisponibilidadeData: (d: string, tx: unknown, ex?: string, esc?: unknown, op?: unknown) => Promise<{ periodos: Array<{ configuracaoId: string; horarios: Array<{ inicio: string; fim: string; ajusteMinutos: number; status: string }> }> }>;
    revalidarHorarioSelecionado: (i: unknown, tx: unknown, esc?: unknown) => Promise<{ candidato: { inicio: string; fim: string } }>;
    duracaoDoPacoteDaEmpresa: (tx: unknown, e: string | null, c?: string) => Promise<number | null>;
  };
  return { m, tx, pacotes, menores };
}
export const ESCOPO = { empresaId: EMPRESA, estabelecimentoId: null };
export const minutos = (h: string) => Number(h.slice(0, 2)) * 60 + Number(h.slice(3, 5));
