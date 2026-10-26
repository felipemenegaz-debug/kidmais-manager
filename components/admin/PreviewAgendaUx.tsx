'use client';

import { useState } from 'react';
import AdminShell from './AdminShell';
import AgendaConfiguracao, { type DadosAgenda } from './AgendaConfiguracao';
import { AssistenteAgenda } from './AssistenteAgenda';
import { fonteAdmin } from './fonte';

// Prévia sem banco (KIDMAIS_PREVIEW_UX=1) da agenda por unidade (093, etapa 2a).
const escopo = { estabelecimentoId: '55555555-5555-4555-8555-555555555555', nome: 'Moema', configurado: true };
const salaoPrincipal = '66666666-6666-4666-8666-666666666661';
const salaoKids = '66666666-6666-4666-8666-666666666662';
const configurada: DadosAgenda = {
  instalada: true,
  gestao: true,
  escopos: [escopo, { estabelecimentoId: '55555555-5555-4555-8555-555555555556', nome: 'Pinheiros', configurado: false }],
  agenda: {
    escopo,
    config: { modo: 'FIXO', capacidadeTipo: 'POR_SALAO', limiteFestasDia: 4, intervaloMinimoMinutos: 60, configuradoPor: 'Ana Souza', configuradoEm: '2026-10-22T15:00:00Z' },
    saloes: [{ id: salaoPrincipal, nome: 'Salão Principal', capacidadeConvidados: 120 }, { id: salaoKids, nome: 'Salão Kids', capacidadeConvidados: 60 }],
    // 098: salão combinado de exemplo (os dois salões juntos).
    combinados: [{ id: '66666666-6666-4666-8666-666666666663', nome: 'Salão inteiro', capacidadeConvidados: 180, elegivel: true,
      membros: [{ id: salaoPrincipal, nome: 'Salão Principal', ativo: true }, { id: salaoKids, nome: 'Salão Kids', ativo: true }] }],
    combinadosDisponiveis: true,
    horarios: [
      { id: '77777777-7777-4777-8777-777777777771', codigo: 'TURNO_1', nome: 'Manhã', inicio: '10:00', fim: '14:00', dias: [5, 6, 7], capacidade: 2, desativadoAPartirDe: null, saloes: [salaoPrincipal, salaoKids], herdado: false, festasFuturas: { quantidade: 4, proxima: '2026-10-25', ultima: '2026-11-22' } },
      { id: '77777777-7777-4777-8777-777777777772', codigo: 'TURNO_2', nome: 'Tarde', inicio: '15:00', fim: '19:00', dias: [1, 2, 3, 4, 5, 6, 7], capacidade: 2, desativadoAPartirDe: null, saloes: [salaoPrincipal, salaoKids], herdado: false, festasFuturas: { quantidade: 0, proxima: null, ultima: null } },
      { id: '77777777-7777-4777-8777-777777777773', codigo: 'HORARIO_3', nome: 'Noite', inicio: '20:00', fim: '23:30', dias: [5, 6], capacidade: 1, desativadoAPartirDe: '2026-12-01', saloes: [salaoPrincipal], herdado: false, festasFuturas: { quantidade: 0, proxima: null, ultima: null } },
    ],
    // Versão fictícia (a vitrine não grava).
    versaoAgenda: 'va1:' + '0'.repeat(64),
  },
};
const nova = { estabelecimentoId: '55555555-5555-4555-8555-555555555556', nome: 'Pinheiros', configurado: false };
const herdada = {
  escopo: nova, config: null, saloes: [], combinados: [],
  horarios: [
    { id: '88888888-8888-4888-8888-888888888881', codigo: 'TURNO_1', nome: 'Primeiro horário', inicio: '11:00', fim: '15:00', dias: [1, 2, 3, 4, 5, 6, 7], capacidade: 1, desativadoAPartirDe: null, saloes: [], herdado: true, festasFuturas: { quantidade: 0, proxima: null, ultima: null } },
    { id: '88888888-8888-4888-8888-888888888882', codigo: 'TURNO_2', nome: 'Segundo horário', inicio: '17:00', fim: '21:00', dias: [1, 2, 3, 4, 5, 6, 7], capacidade: 1, desativadoAPartirDe: null, saloes: [], herdado: true, festasFuturas: { quantidade: 0, proxima: null, ultima: null } },
  ],
  versaoAgenda: 'va1:' + '1'.repeat(64),
};

// Agenda com um salão (decisão de Felipe, 25/10/2026): uma festa por horário, sem campo de capacidade.
const umSalao: DadosAgenda = {
  ...configurada,
  agenda: {
    ...configurada.agenda!, config: { ...configurada.agenda!.config!, capacidadeTipo: 'POR_HORARIO' }, saloes: [], combinados: [], combinadosDisponiveis: false,
    horarios: configurada.agenda!.horarios.map((h) => ({ ...h, saloes: [] })),
  },
};

export default function PreviewAgendaUx({ estado }: { estado?: string }) {
  const [assistente, setAssistente] = useState(estado === 'assistente');
  return <div className={fonteAdmin.variable}>
    <AdminShell vitrine={{ nome: 'Felipe', caminho: '/admin/configuracoes/agenda' }}>
      <AgendaConfiguracao vitrine={{ dados: estado === 'um-salao' ? umSalao : configurada }} />
      {assistente && <AssistenteAgenda escopo={nova} agenda={herdada} onConcluido={() => setAssistente(false)} onDepois={() => setAssistente(false)} />}
    </AdminShell>
  </div>;
}
