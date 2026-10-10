import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { carregarModulo } from '../../lib/acessos/teste-carregador.ts';
import type { DadosAssinatura } from './Assinatura';

// Renderiza o componente real. CSS e rede são isolados; não abre banco ou navegador.
const semRede = () => { throw new Error('Rede proibida no teste da apresentação do aviso.'); };
const { AcoesCobranca } = carregarModulo('components/admin/AssinaturaAcoes.tsx', {
    'components/admin/workspace.module.css': {},
    'components/admin/admin.module.css': {},
    'components/admin/AvisoComercial.module.css': {},
    'http/admin-fetch': { adminFetch: semRede, reautenticarSessao: semRede },
}) as { AcoesCobranca: ComponentType<{ dados: DadosAssinatura; recarregar: () => void }> };

function dados(): DadosAssinatura {
    return {
        instalado: true, cobrado: true, gestao: true, agora: '2026-10-09T12:00:00.000Z',
        acesso: { nivel: 'COMPLETO', motivo: 'ASSINATURA_ATIVA', ate: null },
        assinatura: { situacao: 'ATIVA', ciclo: 'MENSAL', testeInicio: '2026-10-01T12:00:00Z',
            testeFim: '2026-10-16T12:00:00Z', periodoAtualFim: '2026-11-08T12:00:00Z', emAtrasoDesde: null, encerradaEm: null },
        excecoes: [], precos: null,
        cobranca: { disponivel: false, vinculada: true, provedorSituacao: 'ACTIVE', sincronizadoEm: null },
        renovacao: { estado: 'PENDENTE', dataRegular: '2026-11-08', valorRegular: 19700, ciclo: 'MENSAL', avisoEnviado: false },
    };
}
function renderizar(d: DadosAssinatura) {
    return renderToStaticMarkup(createElement(AcoesCobranca, { dados: d, recarregar: semRede })).replace(/\u00a0/g, ' ');
}

test('Gestão vê data, valor mensal e antecedência; cancelamento preserva período pago', () => {
    const html = renderizar(dados());
    assert.match(html, /data-aviso-renovacao/);
    assert.match(html, /08\/11\/2026/);
    assert.match(html, /R\$ 197,00\/mês/);
    assert.match(html, /30 dias antes/);
    assert.match(html, /cancelar antes da renovação, preservando o período já pago/);
    assert.doesNotMatch(html, /foi enviado por e-mail/);
});

test('aviso aceito informa o envio, sem afirmar recebimento ou leitura', () => {
    const d = dados(); d.renovacao!.estado = 'AVISADA'; d.renovacao!.avisoEnviado = true;
    const html = renderizar(d);
    assert.match(html, /foi enviado por e-mail à Gestão que contratou/);
    assert.doesNotMatch(html, /será enviado|recebido|lido/);
});

test('renovação anual apresenta total anual, sem tratá-lo como mensalidade', () => {
    const d = dados(); d.renovacao!.ciclo = 'ANUAL'; d.renovacao!.valorRegular = 197000;
    const html = renderizar(d);
    assert.match(html, /R\$ 1\.970,00\/ano/);
    assert.doesNotMatch(html, /1\.970,00\/mês/);
});

test('Equipe não recebe aviso ou ações de contratação da Gestão', () => {
    const d = dados(); d.gestao = false;
    const html = renderizar(d);
    assert.doesNotMatch(html, /data-aviso-renovacao|08\/11\/2026|R\$ 197,00|30 dias antes/);
    assert.match(html, /Somente a Gestão desta empresa contrata ou cancela/);
});

test('renovação em revisão não promete aumento ou envio concluído', () => {
    const d = dados(); d.renovacao!.estado = 'REVISAO';
    const html = renderizar(d);
    assert.match(html, /precisa de revisão pelo atendimento/);
    assert.doesNotMatch(html, /o valor será|foi enviado|30 dias antes/);
});

test('cancelamento, ausência de registro ou assinatura não mostram renovação futura', () => {
    for (const tipo of ['cancelada', 'sem-registro', 'sem-assinatura']) {
        const d = dados();
        if (tipo === 'cancelada') d.renovacao!.estado = 'CANCELADA';
        if (tipo === 'sem-registro') d.renovacao = null;
        if (tipo === 'sem-assinatura') d.assinatura = null;
        assert.doesNotMatch(renderizar(d), /data-aviso-renovacao|Após o Fundador/);
    }
});
