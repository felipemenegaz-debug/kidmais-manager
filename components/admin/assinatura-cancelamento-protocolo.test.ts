import assert from 'node:assert/strict';
import test from 'node:test';
import { achar, carregarComponente, cssFalso, elementos, texto, tique } from './teste-componente.ts';
import * as textosFundador from '../../lib/assinatura/textos-fundador.ts';
import * as comprovanteTexto from '../../lib/assinatura/comprovante-texto.ts';

// O formulário de cancelar ao fim do período só promete "protocolo na hora" quando o servidor confirma o registro de
// protocolos (089, `instalado` da consulta de devolução). Em production sem a 089 a promessa não se cumpria (03/11/2026).
function montar(resposta: () => Promise<unknown>) {
    const chamadas: string[] = [];
    const tela = carregarComponente('components/admin/AssinaturaAcoes.tsx', {
        'next/link': { default: function Link() { return null; } },
        '@/lib/suporte/rota': { ROTA_AJUDA: '/admin/ajuda' },
        '@/components/admin/workspace.module.css': cssFalso,
        '@/lib/http/admin-fetch': {
            adminFetch: async (url: string) => { chamadas.push(url); return resposta(); },
            reautenticarSessao: () => { throw new Error('não confirma o cancelamento no teste'); },
        },
        './Assinatura': { default: function Assinatura() { return null; }, reais: (c: number) => `R$ ${c / 100}` },
        './AvisoComercial': { dataCurta: (d: string) => d.slice(0, 10) },
        './AssinaturaEncerramento': { EncerramentoComDevolucao: function EncerramentoComDevolucao() { return null; } },
        './ArrependimentoLegal': { ArrependimentoLegal: function ArrependimentoLegal() { return null; } },
        '@/lib/assinatura/textos-fundador': textosFundador,
        '@/lib/assinatura/comprovante-texto': comprovanteTexto,
    });
    const dados = {
        instalado: true, cobrado: true, gestao: true, agora: '2026-11-03T12:00:00.000Z',
        acesso: { nivel: 'COMPLETO', motivo: 'ASSINATURA_ATIVA', ate: null },
        assinatura: { situacao: 'ATIVA', ciclo: 'MENSAL', testeInicio: null, testeFim: null, periodoAtualFim: '2026-12-03T12:00:00Z', emAtrasoDesde: null, encerradaEm: null },
        excecoes: [], precos: null, renovacao: null,
        cobranca: { disponivel: true, vinculada: true, provedorSituacao: 'ACTIVE', sincronizadoEm: null },
    };
    const render = () => tela.render('AcoesCobranca', { dados, recarregar: () => {} });
    return { chamadas, render };
}
const json = (corpo: unknown) => async () => ({ ok: true, json: async () => corpo });
const formulario = (arvore: unknown) => elementos(arvore).find((e) => e.type === 'form' && 'data-cancelamento' in e.props);

async function abrirCancelamento(resposta: () => Promise<unknown>) {
    const t = montar(resposta);
    const botao = achar(t.render(), 'button', 'Cancelar ao fim do período…');
    (botao.props.onClick as () => void)();
    const antes = formulario(t.render());
    for (let i = 0; i < 5; i++) await tique();
    return { chamadas: t.chamadas, antes, depois: formulario(t.render()) };
}

test('com a 089 (instalado): o formulário promete o protocolo na hora', async () => {
    const r = await abrirCancelamento(json({ ok: true, data: { instalado: true, opcoes: null } }));
    assert.deepEqual(r.chamadas, ['/api/admin/assinatura/devolucao?opcoes=1']);
    assert.ok(r.depois, 'formulário aberto');
    assert.match(texto(r.depois), /Você recebe um protocolo na hora\./);
    assert.match(texto(r.depois), /Sem multa\./);
});

test('sem a 089, com falha da consulta ou antes da resposta: nenhuma promessa de protocolo', async () => {
    const casos: [string, () => Promise<unknown>][] = [
        ['sem 089', json({ ok: true, data: { instalado: false, opcoes: null } })],
        ['resposta de erro', json({ ok: false, erro: 'x' })],
        ['corpo sem instalado', json({ ok: true, data: { opcoes: null } })],
        ['rede falhou', async () => { throw new Error('rede'); }],
    ];
    for (const [nome, resposta] of casos) {
        const r = await abrirCancelamento(resposta);
        assert.ok(r.antes && r.depois, `${nome}: formulário aberto`);
        assert.doesNotMatch(texto(r.antes), /protocolo/, `${nome}: antes da resposta`);
        assert.doesNotMatch(texto(r.depois), /protocolo/, `${nome}: depois da resposta`);
        assert.match(texto(r.depois), /nada é apagado\./, `${nome}: o restante do aviso continua`);
    }
});
