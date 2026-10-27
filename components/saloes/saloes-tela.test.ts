import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { diferencas, linhaNumeros, mesPorExtenso, organizar, selecaoInicial, seguirSemEtapa, textoSituacao, type ListaPublica } from './saloes-tela.ts';
import { motivoForaDoSalao, situacaoDoPreferido } from '../fechamento/salao-preferido.ts';
import { soAMaisRecente } from '../fechamento/convidados-trava.ts';
import type { SalaoPublico } from '../../lib/agenda/salao-publico.ts';

const salao = (id: string, nome: string, situacao: SalaoPublico['situacao'], cap: number | null, extra: Partial<SalaoPublico> = {}): SalaoPublico => ({
    id, nome, numeros: { capacidade: cap, minimo: null, sentados: null, areaM2: null }, idade: null, frase: null, destaques: [], grupos: [],
    fotos: [], mesDasFotos: null, convivencia: null, emTodosOsPacotes: [], situacao, ...extra,
});

test('S-D: recomendado primeiro; quem não serve fica à parte; com uma só opção ela vem selecionada (D3)', () => {
    const lista: ListaPublica = { saloes: [salao('a', 'A', 'livre', 200), salao('b', 'B', 'livre', 100), salao('c', 'C', 'ocupado', 90)], recomendado: { id: 'b', motivo: 'x' } };
    const o = organizar(lista);
    assert.deepEqual(o.principais.map((s) => s.id), ['b', 'a']);
    assert.deepEqual(o.indisponiveis.map((s) => s.id), ['c']);
    assert.equal(selecaoInicial(lista), null, 'duas opções: o cliente escolhe');
    assert.equal(selecaoInicial({ saloes: [salao('a', 'A', 'livre', 200), salao('c', 'C', 'nao_comporta', 50)], recomendado: { id: 'a', motivo: '' } }), 'a');
    assert.equal(selecaoInicial({ saloes: [salao('c', 'C', 'ocupado', 50)], recomendado: null }), null);
});

test('S-D: motivo de quem não serve nunca diz quem ocupa', () => {
    assert.equal(textoSituacao(salao('c', 'C', 'nao_comporta', 50), 80), 'Não comporta 80 convidados (até 50).');
    assert.equal(textoSituacao({ situacao: 'abaixo_do_minimo', numeros: { capacidade: 200, minimo: 100, sentados: null, areaM2: null } }, 80), 'Pede no mínimo 100 convidados.');
    assert.equal(textoSituacao(salao('c', 'C', 'ocupado', 50), 80), 'Já reservado neste horário.');
    assert.equal(textoSituacao(salao('c', 'C', 'livre', 50), 80), null);
});

test('S-D: números, mês das fotos e comparação só com as diferenças', () => {
    assert.equal(linhaNumeros({ numeros: { capacidade: 120, minimo: 60, sentados: 80, areaM2: 150 }, idade: { min: 3, max: 10, sugerida: true } }),
        'até 120 convidados · mínimo 60 · 80 sentados · 150 m² · 3 a 10 anos (sugerido)');
    assert.equal(mesPorExtenso('2026-09'), 'setembro de 2026');
    assert.equal(mesPorExtenso(null), null);
    const a = salao('a', 'A', 'livre', 120, { grupos: [{ grupo: 'BRINCADEIRAS', nome: 'Brincadeiras', itens: ['Pula-pula'] }], convivencia: 'Só a sua festa.' });
    const b = salao('b', 'B', 'livre', 60, { grupos: [{ grupo: 'BRINCADEIRAS', nome: 'Brincadeiras', itens: ['Pula-pula'] }], convivencia: 'Só a sua festa.' });
    assert.deepEqual(diferencas([a, b]).map((l) => l.rotulo), ['Convidados'], 'iguais em tudo menos a capacidade');
});

test('S-D: situação do preferido pela leitura pública (fetch simulado) e pacote fora do salão', async () => {
    const consulta = { data: '2026-11-14', configuracaoId: 'c', inicio: '15:00', fim: '19:00', convidados: 80 };
    const resposta = (status: number, corpo: unknown) => (async () => new Response(JSON.stringify(corpo), { status })) as unknown as typeof fetch;
    const lista = { ok: true, data: { saloes: [{ id: 's1', nome: 'Grande', situacao: 'livre' }, { id: 's2', nome: 'Pequeno', situacao: 'nao_comporta' }] } };
    assert.deepEqual(await situacaoDoPreferido('buffet', 's1', consulta, resposta(200, lista)), { tipo: 'livre', salao: { id: 's1', nome: 'Grande' } });
    assert.deepEqual(await situacaoDoPreferido('buffet', 's2', consulta, resposta(200, lista)), { tipo: 'indisponivel' });
    assert.deepEqual(await situacaoDoPreferido('buffet', 's9', consulta, resposta(200, lista)), { tipo: 'indisponivel' });
    assert.deepEqual(await situacaoDoPreferido('buffet', 's1', consulta, resposta(404, {})), { tipo: 'indisponivel' }, 'etapa despublicada');
    const fatos = { P: { nome: 'P', descricao: null, duracaoMinutos: null, convidadosMinimos: null, convidadosMaximos: null, precoMinimo: null, noSalao: false },
        G: { nome: 'G', descricao: null, duracaoMinutos: null, convidadosMinimos: null, convidadosMaximos: null, precoMinimo: null, noSalao: true } };
    assert.equal(motivoForaDoSalao(fatos, 'P', { id: 's1', nome: 'Grande' }), 'Não é oferecido no Grande.');
    assert.equal(motivoForaDoSalao(fatos, 'G', { id: 's1', nome: 'Grande' }), null);
    assert.equal(motivoForaDoSalao(fatos, 'P', null), null, 'sem preferência, nada muda');
});

test('S-D: assistente — preferência na URL, pacote fora do salão não conclui, envio com salaoPreferido, textos do contrato', () => {
    const fonte = readFileSync('components/fechamento/FechamentoWizard.tsx', 'utf8');
    assert.match(fonte, /const salaoParam = params\.get\("salao"\);/);
    assert.match(fonte, /params\.set\("aviso", "salao"\);\s*router\.replace\(`\$\{paginaPublica\("\/saloes", empresa\)\}/, 'salão que não serve: volta à escolha');
    const bloco = fonte.slice(fonte.indexOf('if (etapa === 0 && salaoPreferido && form.pacote) {'), fonte.indexOf('if (etapa === 0 && pacote?.sobConsulta) {'));
    assert.match(bloco, /if \(fora\) \{ setErro\(`\$\{fora\} Escolha um pacote deste salão ou troque o salão\.`\); return false; \}/, 'pacote fora do salão não conclui');
    assert.match(fonte, /\.\.\.\(salaoPreferido \? \{ salaoPreferido: salaoPreferido\.id \} : \{\}\),/);
    assert.match(fonte, /Salão de preferência: \{salaoPreferido\.nome\} · a confirmação vem no contrato\./);
    assert.equal(fonte.includes('confirmado no contrato'), false, 'P3-1: o sucesso não afirma confirmação');
    assert.match(fonte, /Emitir o contrato não reserva o salão; a reserva acontece quando você assina\./);
    const tela = readFileSync('components/saloes/ConhecaSaloes.tsx', 'utf8');
    assert.match(tela, /if \(r\.status === 404\) \{\s*if \(seguirSemEtapa\(atuais\)\) seguir\(\);\s*else \{ setParams\(atuais\); setSemEtapa\(\(\) => seguir\); \}/, 'P2-1: com salão/aviso, não segue sozinho');
    assert.match(tela, /Continuar sem salão de preferência/);
    assert.match(tela, /Voltar e escolher outra data/);
    assert.match(tela, /p\.set\("salao", escolhido\.id\);/);
});

test('S-D (revisão P2-1): sem a etapa, só segue sozinho se nada foi escolhido nem avisado', () => {
    assert.equal(seguirSemEtapa(new URLSearchParams('data=2026-11-14&convidados=80')), true);
    assert.equal(seguirSemEtapa(new URLSearchParams('data=2026-11-14&salao=s1')), false, 'salão escolhido');
    assert.equal(seguirSemEtapa(new URLSearchParams('data=2026-11-14&aviso=salao')), false, 'aviso do fechamento');
    assert.equal(seguirSemEtapa(new URLSearchParams('salao=s1&aviso=salao')), false);
});

test('S-D (revisão P2-2): 120 → 80 com respostas invertidas — o 120 atrasado (horário e salão) é descartado', async () => {
    const seq = { current: 0 };
    let liberar120: () => void = () => {};
    const atraso120 = new Promise<void>((r) => { liberar120 = r; });
    // Mesma composição do assistente: disponibilidade e salão de preferência dentro do MESMO soAMaisRecente.
    const preferidoPara = (n: number) => (n <= 100 ? 'livre' : 'indisponivel');
    const revalidar = (n: number, esperar?: Promise<void>) => soAMaisRecente(seq, async () => {
        if (esperar) await esperar;
        return { horario: 'DISPONIVEL', preferido: preferidoPara(n) };
    });
    const r120 = revalidar(120, atraso120);
    const r80 = revalidar(80);
    const v80 = await r80;
    assert.equal(v80.vigente, true);
    assert.deepEqual(v80.vigente && v80.ok ? v80.valor : null, { horario: 'DISPONIVEL', preferido: 'livre' });
    liberar120();
    const v120 = await r120;
    assert.equal(v120.vigente, false, 'a resposta do 120 (salão indisponível) chega depois e não trava o 80');
});

test('S-D (revisão P2-2/P2-3): assistente confere o preferido DENTRO da revalidação, no fim do candidato (duração do pacote)', () => {
    const fonte = readFileSync('components/fechamento/FechamentoWizard.tsx', 'utf8');
    const inicio = fonte.indexOf('const resultado = await soAMaisRecente(revalidacaoSeq, async () => {');
    const fim = fonte.indexOf('if (!resultado.vigente) return null;', inicio);
    assert.ok(inicio > 0 && fim > inicio);
    const callback = fonte.slice(inicio, fim);
    assert.match(callback, /&duracao=\$\{fato\.duracaoMinutos\}/, 'a consulta usa a duração do pacote escolhido');
    assert.match(callback, /await situacaoDoPreferido\(empresa, salaoPreferido\.id, \{[\s\S]*inicio: c\.inicio, fim: c\.fim, convidados: convidadosInformados,/, 'preferido no fim do candidato');
    assert.equal(fonte.split('situacaoDoPreferido(').length - 1, 2, 'só a entrada e a revalidação consultam o preferido (nenhuma chamada solta fora da sequência)');
    assert.match(fonte, /if \(salaoPreferido && preferido\?\.tipo !== "livre"\) \{[\s\S]*?return false;/, 'salão que não serve: revalidação recusa');
    assert.match(fonte, /if \(valido === false\) setHorarioRecusado\(ultimaRecusa\.current \?\? mensagemHorarioRecusado\(quantidade\)\);/);
});
