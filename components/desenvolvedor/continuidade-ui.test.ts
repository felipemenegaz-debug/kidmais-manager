import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { carregarModulo } from '../../lib/acessos/teste-carregador.ts';

/** Situação comercial no painel: continuidade de documento (D5) listada mascarada; pendência troca o botão de registrar. */
const dubles = {
    'components/admin/workspace.module.css': { default: {} }, 'components/desenvolvedor/desenvolvedor.module.css': { default: {} },
    'components/desenvolvedor/cliente': { chamar: async () => ({}), formatarData: (s: string | null) => s ?? '—', rotuloAcao: (a: string) => a },
};
const ComercialEmpresa = carregarModulo('components/desenvolvedor/ComercialEmpresa.tsx', dubles, new Map()).default as ComponentType<Record<string, unknown>>;
const base = { instalado: true, cobrado: true, situacao: 'TESTE', nivel: 'COMPLETO', motivo: 'TESTE', ate: null, testeFim: '2026-11-30T00:00:00.000Z', periodoAtualFim: null,
    ciclo: null, testeInicio: '2026-11-01T00:00:00.000Z', emAtrasoDesde: null, versao: 1, excecoes: [], eventos: [], historico: [] };
const linha = (situacao: string) => ({ id: 'c1', tipo: 'MESMA_TITULARIDADE', situacao, documentoAnterior: '*******4725', documentoNovo: '**********0161', nomeNovo: 'Maria ME',
    instrumento: 'Aditivo v1', dataEfetiva: '2026-11-10', registradaEm: '2026-11-10T12:00:00.000Z', registradaPor: 'Atendimento', provedorConferidoEm: null, provedorNota: null });
const html = (comercial: Record<string, unknown>) => renderToStaticMarkup(createElement(ComercialEmpresa, { empresaId: 'e1', comercial, ocupado: false, operar: () => undefined }));

test('sem continuidade: oferece registrar; com pendência: mostra a conferência do provedor e não oferece outra', () => {
    assert.match(html(base), /Continuidade de documento…/);
    const pendente = html({ ...base, continuidades: [linha('PENDENTE_PROVEDOR')] });
    assert.match(pendente, /aguardando conferência do provedor/);
    assert.match(pendente, /Registrar conferência do provedor/);
    assert.doesNotMatch(pendente, /Continuidade de documento…/);
    assert.match(pendente, /\*{7}4725 → \*{10}0161/, 'documentos mascarados');
    const concluida = html({ ...base, continuidades: [linha('CONCLUIDA')] });
    assert.match(concluida, /concluída/); assert.match(concluida, /Continuidade de documento…/);
    assert.match(concluida, /Recuperar vínculo da assinatura…/, 'recuperação assistida (P2-N3) só sem pendência');
    assert.doesNotMatch(pendente, /Recuperar vínculo da assinatura…/);
});
