import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { carregarModulo } from '../../lib/acessos/teste-carregador.ts';
import type { DadosAssinatura } from './Assinatura';

// Renderiza o componente real da Gestão e a ficha do desenvolvedor. CSS e rede isolados; sem banco ou navegador.
const semRede = () => { throw new Error('Rede proibida no teste da apresentação do benefício.'); };
const { AcoesCobranca } = carregarModulo('components/admin/AssinaturaAcoes.tsx', {
    'components/admin/workspace.module.css': {},
    'components/admin/admin.module.css': {},
    'components/admin/AvisoComercial.module.css': {},
    'http/admin-fetch': { adminFetch: semRede, reautenticarSessao: semRede },
}) as { AcoesCobranca: ComponentType<{ dados: DadosAssinatura; recarregar: () => void }> };
const ComercialEmpresa = carregarModulo('components/desenvolvedor/ComercialEmpresa.tsx', {
    'components/admin/workspace.module.css': { default: {} }, 'components/desenvolvedor/desenvolvedor.module.css': { default: {} },
    'components/desenvolvedor/cliente': { chamar: async () => ({}), formatarData: (s: string | null) => s ?? '—', rotuloAcao: (a: string) => a },
}, new Map()).default as ComponentType<Record<string, unknown>>;

const CONFIRMADA = { situacao: 'CONFIRMADA_VIGENTE' as const, reservadaEm: '2026-10-25T10:02:00.638Z', confirmadaEm: '2026-10-25T10:22:16.000Z',
    beneficioFim: '2027-10-25T10:22:16.000Z', contratacaoId: 'f0984b9d-0000-4000-8000-000000000001', contratacaoEstado: 'CONFIRMADA' };
function dados(fundador: DadosAssinatura['fundador']): DadosAssinatura {
    return {
        instalado: true, cobrado: true, gestao: true, agora: '2026-10-25T12:00:00.000Z',
        acesso: { nivel: 'COMPLETO', motivo: 'ASSINATURA_ATIVA', ate: null },
        assinatura: { situacao: 'ATIVA', ciclo: 'MENSAL', testeInicio: '2026-10-25T10:00:00Z', testeFim: '2026-11-09T10:00:00Z',
            periodoAtualFim: '2026-11-25T03:00:00Z', emAtrasoDesde: null, encerradaEm: null },
        excecoes: [], precos: null,
        cobranca: { disponivel: true, vinculada: true, provedorSituacao: 'ACTIVE', sincronizadoEm: null },
        contratacao: { comprovante: { contratacaoId: CONFIRMADA.contratacaoId } } as never,
        fundador,
    };
}
const gestao = (d: DadosAssinatura) => renderToStaticMarkup(createElement(AcoesCobranca, { dados: d, recarregar: semRede })).replace(/ /g, ' ');
const bloco = (html: string) => html.match(/<div role="status" data-beneficio-fundador="[^"]+">.*?<\/div>/)?.[0] ?? '';

test('Gestão: confirmada vigente com datas em Brasília, separada do link do comprovante', () => {
    const html = gestao(dados(CONFIRMADA));
    const b = bloco(html);
    assert.match(b, /data-beneficio-fundador="CONFIRMADA_VIGENTE"/);
    assert.match(b, /confirmada em 25\/10\/2026 às 07:22\. Benefício de 12 meses vigente até 25\/10\/2027 às 07:22 \(horário de Brasília\)/);
    assert.match(b, /O comprovante registra as condições aceitas na contratação; esta é a situação atual do benefício/);
    assert.doesNotMatch(b, /href=/, 'o link do comprovante fica fora do bloco do benefício');
    assert.match(html, /data-link-comprovante/);
});

// P3-T1 (revisão de 631a5674): concessão anterior à 096 ou contratação sem comprovante mostra o benefício do mesmo jeito.
test('Gestão: benefício confirmado aparece sem comprovante (contratação nula ou sem comprovante registrado)', () => {
    for (const contratacao of [null, { comprovante: null } as never]) {
        const d = dados(CONFIRMADA); d.contratacao = contratacao;
        const html = gestao(d);
        assert.match(bloco(html), /data-beneficio-fundador="CONFIRMADA_VIGENTE"/);
        assert.match(bloco(html), /vigente até 25\/10\/2027 às 07:22 \(horário de Brasília\)/);
        assert.doesNotMatch(html, /data-link-comprovante/, 'sem comprovante, sem link');
    }
});

test('Gestão: reservada não aparece como confirmada; encerrada por prazo não aparece como vigente', () => {
    const r = bloco(gestao(dados({ ...CONFIRMADA, situacao: 'RESERVADA', confirmadaEm: null, beneficioFim: null, contratacaoEstado: 'EM_ABERTO' })));
    assert.match(r, /data-beneficio-fundador="RESERVADA"/);
    assert.match(r, /reservada, ainda não confirmada/);
    assert.doesNotMatch(r, /confirmada em|vigente/);
    const e = bloco(gestao(dados({ ...CONFIRMADA, situacao: 'ENCERRADA' })));
    assert.match(e, /data-beneficio-fundador="ENCERRADA"/);
    assert.match(e, /terminou em 25\/10\/2027 às 07:22/);
    assert.doesNotMatch(e, /vigente/);
});

test('virada do dia: fim às 02:30 UTC aparece no dia anterior, em Brasília', () => {
    const b = bloco(gestao(dados({ ...CONFIRMADA, confirmadaEm: '2026-10-25T02:30:00.000Z', beneficioFim: '2027-10-25T02:30:00.000Z' })));
    assert.match(b, /confirmada em 24\/10\/2026 às 23:30.*até 24\/10\/2027 às 23:30/);
});

test('sem o dado (schema ausente, sem concessão ou Equipe): nada muda na tela', () => {
    for (const f of [null, undefined]) assert.doesNotMatch(gestao(dados(f)), /data-beneficio-fundador|Condição Fundador/);
    const equipe = dados(CONFIRMADA); equipe.gestao = false;
    assert.doesNotMatch(gestao(equipe), /data-beneficio-fundador|Condição Fundador/);
    assert.doesNotMatch(gestao(dados({ ...CONFIRMADA, confirmadaEm: null })), /data-beneficio-fundador/, 'dado incoerente não é apresentado');
});

const base = { instalado: true, cobrado: true, situacao: 'ATIVA', nivel: 'COMPLETO', motivo: 'ASSINATURA_ATIVA', ate: null, testeFim: '2026-11-09T10:00:00.000Z', periodoAtualFim: null,
    ciclo: 'MENSAL', testeInicio: '2026-10-25T10:00:00.000Z', emAtrasoDesde: null, versao: 1, excecoes: [], eventos: [], historico: [] };
const ficha = (fundador: unknown) => renderToStaticMarkup(createElement(ComercialEmpresa, { empresaId: 'e1', comercial: { ...base, fundador }, ocupado: false, operar: () => undefined }))
    .replace(/ /g, ' ');

test('desenvolvedor: estado, vaga, fase, datas em Brasília e oferta; reservada e encerrada distinguidas; ausente sem dado', () => {
    const c = ficha({ ...CONFIRMADA, vaga: 13, origem: 'LEGADO' });
    assert.match(c, /data-fundador-desenvolvedor="CONFIRMADA_VIGENTE"/);
    assert.match(c, /Confirmada · vigente/);
    assert.match(c, /vaga 13 · LEGADO/);
    assert.match(c, /reservada em 25\/10\/2026 às 07:02 · confirmada em 25\/10\/2026 às 07:22 · benefício até 25\/10\/2027 às 07:22 \(horário de Brasília\)/);
    assert.match(c, /oferta f0984b9d-0000-4000-8000-000000000001/);
    const r = ficha({ ...CONFIRMADA, situacao: 'RESERVADA', confirmadaEm: null, beneficioFim: null, vaga: 2, origem: null });
    assert.match(r, /Reservada \(ainda não confirmada\)/);
    assert.doesNotMatch(r, /confirmada em|benefício até|LEGADO/);
    assert.match(ficha({ ...CONFIRMADA, situacao: 'ENCERRADA', vaga: 13, origem: 'LEGADO' }), /Encerrada por prazo/);
    for (const f of [null, undefined]) assert.doesNotMatch(ficha(f), /data-fundador-desenvolvedor|<h3>Fundador<\/h3>/);
});

// O-1 (conferência pós-#237): a ficha mostrava "Único" fixo para quem contratou um plano novo.
test('desenvolvedor: plano contratado pelo nome; legado (UNICO ou sem a 074a) continua "Único"', () => {
    const plano = (p: unknown, ciclo = 'MENSAL') => renderToStaticMarkup(createElement(ComercialEmpresa, { empresaId: 'e1',
        comercial: { ...base, ciclo, plano: p }, ocupado: false, operar: () => undefined })).match(/<dt>Plano<\/dt><dd>([^<]*)<\/dd>/)?.[1];
    assert.equal(plano('ESSENCIAL'), 'Essencial · mensal');
    assert.equal(plano('PROFISSIONAL', 'ANUAL'), 'Profissional · anual');
    assert.equal(plano('PREMIUM'), 'Premium · mensal');
    assert.equal(plano('UNICO'), 'Único · mensal');
    assert.equal(plano(null), 'Único · mensal');
    assert.equal(plano(undefined), 'Único · mensal');
    assert.equal(plano('OUTRO'), 'OUTRO · mensal', 'valor desconhecido aparece como veio, sem inventar nome');
    // P3 da revisão: propriedades herdadas não são planos.
    for (const herdada of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) assert.equal(plano(herdada), `${herdada} · mensal`);
});
