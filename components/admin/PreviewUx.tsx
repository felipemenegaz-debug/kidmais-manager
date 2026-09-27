'use client';

import AdminShell from './AdminShell';
import CatalogoEditor from './CatalogoEditor';
import PacotesAdmin from './PacotesAdmin';
import { fonteAdmin } from './fonte';

const horarios = [
  { id: '11111111-1111-4111-8111-111111111111', nome: 'Primeiro horário', inicio: '11:00:00', fim: '15:00:00' },
  { id: '22222222-2222-4222-8222-222222222222', nome: 'Segundo horário', inicio: '17:00:00', fim: '21:00:00' },
];
const categorias = [
  { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', nome: 'Salgados' },
  { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', nome: 'Doces' },
  { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3', nome: 'Bolo' },
  { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4', nome: 'Empratado premium' },
];
const pacotes = [
  {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
    nome: 'Festa Completa',
    descricao: 'Buffet e bolo',
    duracaoMinutos: 240,
    convidadosMinimos: 20,
    convidadosMaximos: 50,
    diasPermitidos: [5, 6, 7],
    ativo: true,
    arquivadoEm: null,
  },
  {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
    nome: 'Festa Pocket',
    descricao: null,
    duracaoMinutos: 180,
    convidadosMinimos: 15,
    convidadosMaximos: 30,
    diasPermitidos: [1, 2, 3, 4, 5],
    ativo: false,
    arquivadoEm: '2026-09-20',
  },
];

const edicao = {
  pacote: pacotes[0],
  disponibilidade: [
    { dia: 1, horarioId: horarios[0].id },
    { dia: 6, horarioId: horarios[1].id },
  ],
  categorias: [
    { categoriaId: categorias[0].id, escolhas: 8, ativo: true },
    { categoriaId: categorias[1].id, escolhas: 4, ativo: true },
    { categoriaId: categorias[2].id, escolhas: 1, ativo: true },
  ],
  faixas: {
    editavel: true,
    aviso: null,
    faixas: [
      { convidadosMin: 20, convidadosMax: 30, valor: '6490.00' },
      { convidadosMin: 31, convidadosMax: 40, valor: '7390.00' },
      { convidadosMin: 41, convidadosMax: 50, valor: '8190.00' },
    ],
  },
};

const buffet = {
  categorias: [
    { id: categorias[0].id, nome: 'Salgados', ativo: true },
    { id: categorias[1].id, nome: 'Doces', ativo: true },
    { id: categorias[2].id, nome: 'Bolo', ativo: true },
  ],
  itens: [
    { id: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1', nome: 'Coxinha', ativo: true, categoria_id: categorias[0].id },
    { id: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2', nome: 'Brigadeiro', ativo: true, categoria_id: categorias[1].id },
    { id: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3', nome: 'Empada', ativo: true, categoria_id: categorias[0].id },
  ],
};

export default function PreviewUx({ tela, estado }: { tela: 'pacotes' | 'buffet'; estado?: string }) {
  const caminho = tela === 'buffet' ? '/admin/configuracoes/catalogo' : '/admin/configuracoes/pacotes';
  const filtro = estado === 'arquivados' ? 'arquivados' : 'todos';
  return <div className={fonteAdmin.variable}>
    <AdminShell vitrine={{ nome: 'Felipe', caminho }}>
      {tela === 'buffet'
        ? <CatalogoEditor vitrine={{ ...buffet, secao: estado === 'itens' ? 'itens' : 'categorias' }} />
        : <PacotesAdmin vitrine={{
          pacotes,
          horarios,
          categorias,
          itens: buffet.itens,
          filtro,
          edicao: estado === 'editar' ? edicao : null,
        }} />}
    </AdminShell>
  </div>;
}
