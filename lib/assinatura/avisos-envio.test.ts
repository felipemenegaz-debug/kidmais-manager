import assert from 'node:assert/strict';
import test from 'node:test';
import type { MensagemEmail } from '../acessos/email.ts';
import type { AssinaturaGravada } from './acesso.ts';
import { JANELA_RETENTATIVA_MS, LIMITE_DESTINATARIOS } from './avisos.ts';
import { enfileirarAvisosDaEmpresa, enviarAviso, executarAvisos, exigeAtencao, type AlteracaoAviso, type AvisoGravado, type ContextoAviso, type DepsAvisos, type NovoAviso, type RepositorioAvisos } from './avisos-envio.ts';

/**
 * Enfileiramento e envio (087) com repositório EM MEMÓRIA que impõe o UNIQUE (empresa, tipo, marco, pessoa) e as
 * transições da guarda. Provedor de e-mail falso. Dados sintéticos; nenhum banco nem rede.
 */
const E = '11111111-1111-4111-8111-111111111111';
const G1 = { id: '33333333-3333-4333-8333-333333333331', email: 'gestao1@example.invalid' };
const G2 = { id: '33333333-3333-4333-8333-333333333332', email: 'gestao2@example.invalid' };
const P = { regularizacaoDias: 7, somenteLeituraDias: 60 };
const TRANSICOES: Record<string, string[]> = { PENDENTE: ['ENVIANDO', 'DESCARTADO'], ENVIANDO: ['ENVIADO', 'INCERTO'], ENVIADO: ['DEVOLVIDO'] };

function cenario(o: { assinatura?: AssinaturaGravada | null; agora?: string; gestao?: typeof G1[] } = {}) {
    const ctx: ContextoAviso = {
        empresaId: E, empresa: 'Buffet Sintético', empresaAtiva: true, excecoes: [], agora: o.agora ?? '2026-10-29T12:00:00.000Z', gestao: o.gestao ?? [G1, G2],
        assinatura: o.assinatura === undefined ? { situacao: 'TESTE', testeFim: '2026-11-01T03:00:00.000Z', periodoAtualFim: null, emAtrasoDesde: null, encerradaEm: null } : o.assinatura,
    };
    const linhas = new Map<string, AvisoGravado>();
    const historico: string[] = [];
    let seq = 0;
    const repositorio: RepositorioAvisos = {
        instalado: async () => true,
        empresas: async () => [E],
        contexto: async () => structuredClone(ctx),
        enfileirar: async (n: NovoAviso) => {
            if ([...linhas.values()].some((l) => l.empresaId === n.empresaId && l.tipo === n.tipo && l.marco === n.marco && l.destinatarioId === n.destinatarioId)) return false;
            linhas.set(n.id, { ...structuredClone(n), estado: 'PENDENTE', tentadoEm: null, enviadoEm: null, idExterno: null, ultimoErro: null, criadoEm: ctx.agora });
            return true;
        },
        pendentes: async () => [...linhas.values()].filter((l) => l.estado === 'PENDENTE' || l.estado === 'ENVIANDO').map((l) => l.id),
        ler: async (id) => (linhas.has(id) ? { aviso: structuredClone(linhas.get(id)!), contexto: structuredClone(ctx) } : null),
        marcar: async (id, a: AlteracaoAviso) => {
            const l = linhas.get(id)!;
            assert.ok(a.estado === l.estado || TRANSICOES[l.estado]?.includes(a.estado), `transição ${l.estado}→${a.estado}`);
            l.estado = a.estado; l.ultimoErro = a.erro ?? null;
            if (a.tentativa) l.tentadoEm ??= relogio.agora;
            if (a.envioId) { l.enviadoEm ??= relogio.agora; l.idExterno ??= a.envioId; }
            historico.push(`${l.tipo}:${a.estado}${a.erro ? `:${a.erro}` : ''}`);
        },
    };
    const enviados: MensagemEmail[] = [];
    const relogio = { agora: '2026-10-29T12:00:00.000Z', falhar: false };
    const deps: DepsAvisos = {
        repositorio, origem: 'https://manager.example', prazos: P, simular: false, gerarId: () => `55555555-5555-4555-8555-${String(++seq).padStart(12, '0')}`,
        relogio: () => Date.parse(relogio.agora),
        enviar: async (m) => { if (relogio.falhar) throw new Error('provedor fora'); enviados.push(m); return { provedor: 'arquivo', idExterno: `email_${enviados.length}` }; },
    };
    return { ctx, linhas, historico, enviados, relogio, deps };
}

test('job: um aviso por pessoa da Gestão; repetir o job não cria nem envia de novo', async () => {
    const c = cenario();
    const r1 = await executarAvisos(c.deps);
    assert.deepEqual(r1, { instalado: true, enfileiramento: { empresas: 1, criados: 2, existentes: 0, erros: 0 }, envios: { ENVIADO: 2 } });
    assert.deepEqual(c.enviados.map((m) => m.para).sort(), [G1.email, G2.email]);
    assert.ok(c.enviados.every((m) => /3 dias|termina em 31\/10\/2026/.test(m.assunto)));
    const r2 = await executarAvisos(c.deps);
    assert.deepEqual(r2, { instalado: true, enfileiramento: { empresas: 1, criados: 0, existentes: 2, erros: 0 }, envios: {} });
    assert.equal(c.enviados.length, 2);
    assert.equal(exigeAtencao(r2), false);
});

test(`no máximo ${LIMITE_DESTINATARIOS} pessoas; sem Gestão ativa, nada`, async () => {
    const muitos = Array.from({ length: 8 }, (_, i) => ({ id: `33333333-3333-4333-8333-00000000000${i}`, email: `g${i}@example.invalid` }));
    assert.equal((await enfileirarAvisosDaEmpresa(E, cenario({ gestao: muitos }).deps)).criados, LIMITE_DESTINATARIOS);
    assert.equal((await enfileirarAvisosDaEmpresa(E, cenario({ gestao: [] }).deps)).criados, 0);
    assert.equal((await enfileirarAvisosDaEmpresa(E, cenario({ assinatura: null }).deps)).criados, 0);
});

test('revalidação antes do 1º envio: já pagou ou saiu da Gestão ⇒ DESCARTADO, sem e-mail', async () => {
    const c = cenario({ gestao: [G1] });
    await enfileirarAvisosDaEmpresa(E, c.deps);
    const [id] = [...c.linhas.keys()];
    c.ctx.assinatura = { situacao: 'ATIVA', testeFim: '2026-11-01T03:00:00.000Z', periodoAtualFim: '2026-11-29T03:00:00.000Z', emAtrasoDesde: null, encerradaEm: null };
    assert.equal(await enviarAviso(id, c.deps), 'DESCARTADO');
    assert.equal(c.linhas.get(id)!.ultimoErro, 'AVISO_OBSOLETO');
    const d = cenario({ gestao: [G1] });
    await enfileirarAvisosDaEmpresa(E, d.deps);
    d.ctx.gestao = [{ ...G1, email: 'outro@example.invalid' }];
    assert.equal(await enviarAviso([...d.linhas.keys()][0], d.deps), 'DESCARTADO');
    assert.equal([...d.linhas.values()][0].ultimoErro, 'DESTINATARIO_ALTERADO');
    const e = cenario({ gestao: [G1] });
    await enfileirarAvisosDaEmpresa(E, e.deps);
    e.ctx.empresaAtiva = false;
    assert.equal(await enviarAviso([...e.linhas.keys()][0], e.deps), 'DESCARTADO');
    assert.equal([...e.linhas.values()][0].ultimoErro, 'EMPRESA_INATIVA');
    assert.equal(c.enviados.length + d.enviados.length + e.enviados.length, 0);
});

test('falha do provedor: fica ENVIANDO e repete com a MESMA mensagem e chave; depois de 23 h vira INCERTO', async () => {
    const c = cenario({ gestao: [G1] });
    await enfileirarAvisosDaEmpresa(E, c.deps);
    const [id] = [...c.linhas.keys()];
    c.relogio.falhar = true;
    assert.equal(await enviarAviso(id, c.deps), 'ENVIO_FALHOU');
    assert.deepEqual([c.linhas.get(id)!.estado, c.linhas.get(id)!.ultimoErro], ['ENVIANDO', 'ENVIO_FALHOU']);
    c.relogio.falhar = false;
    c.relogio.agora = new Date(Date.parse(c.relogio.agora) + 3_600_000).toISOString();
    assert.equal(await enviarAviso(id, c.deps), 'ENVIADO');
    assert.equal(c.enviados[0].idempotencia, c.linhas.get(id)!.mensagem.idempotencia);
    assert.equal(await enviarAviso(id, c.deps), 'JA_CONCLUIDO');
    assert.equal(c.enviados.length, 1);

    const d = cenario({ gestao: [G1] });
    await enfileirarAvisosDaEmpresa(E, d.deps);
    const [outro] = [...d.linhas.keys()];
    d.relogio.falhar = true;
    await enviarAviso(outro, d.deps);
    d.relogio.agora = new Date(Date.parse(d.relogio.agora) + JANELA_RETENTATIVA_MS).toISOString();
    assert.equal(await enviarAviso(outro, d.deps), 'INCERTO');
    assert.equal(d.linhas.get(outro)!.estado, 'INCERTO');
    const r = await executarAvisos(d.deps);
    assert.equal(r.instalado && r.envios.INCERTO, undefined, 'INCERTO não volta à fila');
});

test('resposta sem id do provedor não conta como enviado', async () => {
    const c = cenario({ gestao: [G1] });
    c.deps.enviar = async () => ({ provedor: 'resend', idExterno: null });
    await enfileirarAvisosDaEmpresa(E, c.deps);
    assert.equal(await enviarAviso([...c.linhas.keys()][0], c.deps), 'ENVIO_FALHOU');
});

test('simulação: nada é gravado nem enviado; relatório informa o que aconteceria', async () => {
    const c = cenario();
    const r = await executarAvisos({ ...c.deps, simular: true, enviar: async () => { throw new Error('proibido'); } });
    assert.deepEqual(r, { instalado: true, enfileiramento: { empresas: 1, criados: 2, existentes: 0, erros: 0 }, envios: {} });
    assert.equal(c.linhas.size, 0);
    await enfileirarAvisosDaEmpresa(E, c.deps);
    const antes = structuredClone([...c.linhas.values()]);
    assert.equal(await enviarAviso([...c.linhas.keys()][0], { ...c.deps, simular: true }), 'ENVIARIA');
    assert.deepEqual([...c.linhas.values()], antes);
    assert.equal(c.enviados.length, 0);
});

test('sem a 087 instalada: nada acontece; atenção humana com INCERTO, falha ou erro', async () => {
    const c = cenario();
    c.deps.repositorio.instalado = async () => false;
    assert.deepEqual(await executarAvisos(c.deps), { instalado: false });
    assert.equal(exigeAtencao({ instalado: false }), false);
    const base = { instalado: true as const, enfileiramento: { empresas: 1, criados: 0, existentes: 0, erros: 0 } };
    assert.equal(exigeAtencao({ ...base, envios: { ENVIADO: 3, DESCARTADO: 1 } }), false);
    for (const k of ['INCERTO', 'ENVIO_FALHOU', 'ERRO_REPROCESSAVEL']) assert.equal(exigeAtencao({ ...base, envios: { [k]: 1 } }), true, k);
    assert.equal(exigeAtencao({ ...base, enfileiramento: { ...base.enfileiramento, erros: 1 }, envios: {} }), true);
});
