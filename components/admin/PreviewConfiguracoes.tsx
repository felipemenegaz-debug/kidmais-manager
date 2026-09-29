'use client';

import { useState, type ReactNode } from 'react';
import AdminShell from './AdminShell';
import PerfilEmpresa from './PerfilEmpresa';
import WhatsappConfiguracao from './WhatsappConfiguracao';
import TabelaPacotesPdf from './TabelaPacotesPdf';
import FestaAcessos from '../festas/FestaAcessos';
import HubConfiguracoes from '@/app/admin/configuracoes/page';
import { fonteAdmin } from './fonte';

/**
 * Vitrine de revisão visual das telas de Configurações (somente com KIDMAIS_PREVIEW_UX=1). Os componentes reais
 * renderizam com respostas fictícias: o fetch do navegador é interceptado só dentro desta página, e nenhuma escrita
 * sai do navegador. Dados 100% sintéticos.
 */
export type TelaConfiguracao = 'hub' | 'perfil' | 'acessos' | 'whatsapp' | 'pdf';

const endereco = (cep: string, logradouro: string, numero: string, semNumero = false) => ({
  cep, logradouro, numero, semNumero, complemento: '', bairro: 'Asa Sul', cidade: 'Brasília', uf: 'DF', pais: 'Brasil',
});
const cadastro = {
  nomeComercial: 'Buffet Exemplo', razaoSocial: 'Buffet Exemplo Ltda', cnpj: '11.222.333/0001-81',
  sede: endereco('70000-000', 'Rua das Festas', '120'), unidadeNome: 'Unidade Central', mesmoEnderecoSede: false,
  unidade: endereco('70100-000', 'Avenida Alegria', '', true), referenciaChegada: 'Portão azul, ao lado da praça.',
  telefone: '(61) 3333-4444', whatsapp: '(61) 99999-0000', emailComercial: 'contato@exemplo.invalid', site: '', instagram: '@buffetexemplo',
};

const respostas: Record<string, unknown> = {
  '/api/admin/autenticacao': { ok: true, data: { usuarioId: 'u1', nome: 'Pessoa Gestora', papel: 'REPRESENTANTE_AUTORIZADO' } },
  '/api/admin/configuracoes/perfil-empresa': {
    ok: true,
    data: {
      estruturaInstalada: true, vazio: false,
      contexto: { codigoEmpresa: 'EXEMPLO', codigoUnidade: 'CENTRAL', versao: 3, cadastro, rascunho: null },
      historico: [{ numero: 3, estado: 'APLICADA', motivo: 'Atualização do telefone', versaoBase: 2, editorNome: 'Pessoa Gestora', editadoEm: '2026-09-20T13:00:00Z', aplicadorNome: 'Pessoa Gestora', aplicadoEm: '2026-09-20T13:05:00Z' }],
      capacidades: { PERFIL_CONSULTAR: true, PERFIL_EDITAR_RASCUNHO: true, PERFIL_APLICAR: true, PERFIL_ADMINISTRAR_CONCESSOES: true },
    },
  },
  '/api/admin/configuracoes/usuarios': {
    ok: true,
    data: {
      usuarioId: 'u1',
      usuarios: [
        { id: 'u1', nome: 'Pessoa Gestora', email: 'gestao@exemplo.invalid', nivelSistema: 'Gestão', ativo: true, podeAssinar: true },
        { id: 'u2', nome: 'Pessoa da Equipe', email: 'equipe@exemplo.invalid', nivelSistema: 'Equipe', ativo: true, podeAssinar: false },
        { id: 'u3', nome: 'Pessoa com Nome Bem Comprido Para Testar Quebra', email: 'nome.muito.comprido.para.testar@exemplo.invalid', nivelSistema: 'Gestão', ativo: true, podeAssinar: false },
        { id: 'u4', nome: 'Pessoa Removida', email: 'removida@exemplo.invalid', nivelSistema: 'Equipe', ativo: false, podeAssinar: false },
      ],
    },
  },
  '/api/admin/festas?recurso=perfis': {
    ok: true,
    data: {
      usuarioId: 'u1',
      usuarios: [
        { id: 'u1', nome: 'Pessoa Gestora', nivelSistema: 'Gestão', perfil: 'Gestão' },
        { id: 'u2', nome: 'Pessoa da Equipe', nivelSistema: 'Equipe', perfil: 'Equipe' },
        { id: 'u3', nome: 'Pessoa com Nome Bem Comprido Para Testar Quebra', nivelSistema: 'Gestão', perfil: 'Gestão' },
      ],
    },
  },
  '/api/admin/configuracoes/whatsapp': { ok: true, data: { estado: 'NAO_CONFIGURADA', metaConfigurada: false, conexao: null, tentativa: null } },
  '/api/admin/configuracoes/tabela-pacotes': { ok: true, data: { id: 'd1', nome: 'pacotes-2026.pdf', tamanho: 120000, publicadoEm: '2026-09-18T15:00:00Z' } },
};

function instalarFetchFicticio() {
  if (typeof window === 'undefined') return;
  const w = window as typeof window & { __kidmaisPreviewFetch?: boolean };
  if (w.__kidmaisPreviewFetch) return;
  w.__kidmaisPreviewFetch = true;
  const original = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const caminho = url.replace(/^https?:\/\/[^/]+/, '');
    if (caminho.startsWith('/api/')) {
      const metodo = (init?.method ?? 'GET').toUpperCase();
      const corpo = metodo === 'GET' ? (respostas[caminho] ?? { ok: false, erro: 'Indisponível na vitrine.' })
        : { ok: false, erro: 'Vitrine: nenhuma alteração é enviada.' };
      return new Response(JSON.stringify(corpo), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return original(input, init);
  };
}

const caminhos: Record<TelaConfiguracao, string> = {
  hub: '/admin/configuracoes', perfil: '/admin/configuracoes/perfil-empresa', acessos: '/admin/configuracoes/acessos',
  whatsapp: '/admin/configuracoes/whatsapp', pdf: '/admin/configuracoes/tabela-pacotes',
};

export default function PreviewConfiguracoes({ tela }: { tela: TelaConfiguracao }) {
  // Instala antes do primeiro efeito dos componentes filhos.
  useState(() => { instalarFetchFicticio(); return true; });
  const conteudo: Record<TelaConfiguracao, ReactNode> = {
    hub: <HubConfiguracoes />, perfil: <PerfilEmpresa />, acessos: <FestaAcessos />, whatsapp: <WhatsappConfiguracao />, pdf: <TabelaPacotesPdf />,
  };
  return <div className={fonteAdmin.variable}>
    <AdminShell vitrine={{ nome: 'Pessoa Gestora', caminho: caminhos[tela] }}>{conteudo[tela]}</AdminShell>
  </div>;
}
