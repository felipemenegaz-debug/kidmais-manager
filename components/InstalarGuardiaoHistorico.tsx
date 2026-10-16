'use client';
import { instalarGuardiaoDeHistorico } from '@/components/admin/marketing/protecao-saida';

// R-H1/R-H1-F: o guardião do histórico do editor precisa ouvir popstate ANTES do App Router (no window vale a ordem de
// registro). Este módulo é avaliado na hidratação de QUALQUER documento (layout raiz), antes dos efeitos do AppRouter —
// inclusive quando se entra no painel por navegação cliente a partir de outro layout (not-found, /acesso, /cadastro,
// /desenvolvedor), caso em que o AdminShell só é avaliado depois de o roteador já estar ouvindo. Sem proteção ativa, o
// guardião não intercepta nada.
instalarGuardiaoDeHistorico();

export default function InstalarGuardiaoHistorico() { return null; }
