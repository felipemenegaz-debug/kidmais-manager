import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { carregarModulo } from '../../lib/acessos/teste-carregador.ts';
import type { DadosAssinatura } from './Assinatura';

// O3 (opção A) e P2-R1 (revisão de 31c5704d): renderiza o componente real da escolha de plano. Sem rede, banco ou navegador.
const semRede = () => { throw new Error('Rede proibida no teste da escolha de plano.'); };
const { AcoesCobranca } = carregarModulo('components/admin/AssinaturaAcoes.tsx', {
    'components/admin/workspace.module.css': {},
    'components/admin/admin.module.css': {},
    'components/admin/AvisoComercial.module.css': {},
    'http/admin-fetch': { adminFetch: semRede, reautenticarSessao: semRede },
}) as { AcoesCobranca: ComponentType<{ dados: DadosAssinatura; recarregar: () => void }> };

const planos = (fundador: boolean) => [
    { id: 'essencial', nome: 'Essencial', mensal: fundador ? 11820 : 19700, anual: fundador ? 118200 : 197000, mensalRegular: 19700, anualRegular: 197000 },
];
function dados(ofertas: { fundador: boolean; aguardandoVaga: boolean; pendente: null | { plano: string; ciclo: 'MENSAL'; valorCentavos: number; fundadorValidoAte: null | { ate: string; dia: string; vencida: boolean } } }): DadosAssinatura {
    return {
        instalado: true, cobrado: false, gestao: true, agora: '2026-10-25T12:00:00.000Z',
        acesso: { nivel: 'COMPLETO', motivo: 'TESTE', ate: '2026-11-08T12:00:00.000Z' },
        assinatura: { situacao: 'TESTE', ciclo: 'MENSAL', testeInicio: '2026-10-24T12:00:00Z', testeFim: '2026-11-08T12:00:00Z',
            periodoAtualFim: null, emAtrasoDesde: null, encerradaEm: null },
        excecoes: [], precos: null,
        cobranca: { disponivel: true, vinculada: false, provedorSituacao: null, sincronizadoEm: null },
        renovacao: null,
        ofertas: { isenta: false, habilitado: true, planoAtual: null, campanha: { fase: 'LEGADO' }, bloqueio: null, versao: '2026-10-20',
            ...ofertas, planos: planos(ofertas.fundador) },
        contratacao: null,
    } as unknown as DadosAssinatura;
}
const renderizar = (d: DadosAssinatura) => renderToStaticMarkup(createElement(AcoesCobranca, { dados: d, recarregar: semRede })).replace(/ /g, ' ');

test('vagas em confirmação sem oferta: aviso E botões pelo preço normal; nada de Fundador 40%', () => {
    const html = renderizar(dados({ fundador: false, aguardandoVaga: true, pendente: null }));
    assert.match(html, /data-vagas-em-confirmacao/);
    assert.match(html, /assinar agora pelo preço normal ou aguardar/);
    assert.match(html, /Assinar Essencial — R\$ 197,00\/mês/);
    assert.doesNotMatch(html, /Fundador: 40% de desconto/);
    assert.doesNotMatch(html, /Aguarde antes de contratar/);
});

test('oferta regular pendente (P2-R1): tela não anuncia Fundador e retoma por R$ 197', () => {
    const html = renderizar(dados({ fundador: false, aguardandoVaga: false, pendente: { plano: 'essencial', ciclo: 'MENSAL', valorCentavos: 19700, fundadorValidoAte: null } }));
    assert.match(html, /Retomar essencial — R\$ 197,00/);
    assert.doesNotMatch(html, /Fundador: 40% de desconto/);
    assert.doesNotMatch(html, /data-vagas-em-confirmacao/);
});

test('controle: oferta Fundador pendente segue anunciando Fundador e retoma por R$ 118,20', () => {
    const html = renderizar(dados({ fundador: true, aguardandoVaga: false, pendente: { plano: 'essencial', ciclo: 'MENSAL', valorCentavos: 11820, fundadorValidoAte: null } }));
    assert.match(html, /Fundador: 40% de desconto por 12 meses/);
    assert.match(html, /Retomar essencial — R\$ 118,20/);
});

/** P2-R1: aguardandoVaga=false na retomada não esconde os avisos de validade/vencimento da reserva Fundador (D3). */
test('retomada Fundador: aviso "pague até" com reserva válida e aviso de vencida com reserva vencida, sem aviso de vagas', () => {
    const base = { plano: 'essencial', ciclo: 'MENSAL' as const, valorCentavos: 11820 };
    const valida = renderizar(dados({ fundador: true, aguardandoVaga: false, pendente: { ...base, fundadorValidoAte: { ate: '2026-10-31T02:59:59.000Z', dia: '2026-10-30', vencida: false } as never } }));
    assert.match(valida, /data-fundador-validade/);
    assert.match(valida, /pague até 30\/10\/2026, fim do dia/);
    assert.doesNotMatch(valida, /data-vagas-em-confirmacao|data-fundador-vencido/);
    const vencida = renderizar(dados({ fundador: true, aguardandoVaga: false, pendente: { ...base, fundadorValidoAte: { ate: '2026-10-20T02:59:59.000Z', dia: '2026-10-19', vencida: true } as never } }));
    assert.match(vencida, /data-fundador-vencido/);
    assert.match(vencida, /venceu em 19\/10\/2026/);
    assert.doesNotMatch(vencida, /data-vagas-em-confirmacao|data-fundador-validade/);
});

test('retomada com a campanha desligada: oferta Fundador aceita continua anunciada e retomável (habilitado pela oferta pendente)', () => {
    const d = dados({ fundador: true, aguardandoVaga: false, pendente: { plano: 'essencial', ciclo: 'MENSAL', valorCentavos: 11820, fundadorValidoAte: null } });
    (d.ofertas as unknown as { campanha: unknown }).campanha = { fase: 'DESLIGADA' };
    const html = renderizar(d);
    assert.match(html, /Fundador: 40% de desconto por 12 meses/);
    assert.match(html, /Retomar essencial — R\$ 118,20/);
});
