import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { invalidarPendentes, mensagemHorarioRecusado, MENSAGEM_COTACAO_FALHOU, soAMaisRecente, travaAposConvidados, type EstadoTravaConvidados } from './convidados-trava.ts';

// P2-R1 (Astra, 27/10): no fluxo de convidados primeiro, trocar o número no Valor não pode deixar avançar com horário
// recusado nem com a cotação carregando ou em erro. Sequência de interação: falha, demora e recuperação.
const VALOR = 5;
const base: EstadoTravaConvidados = {
    convidadosDaEntrada: true, etapa: VALOR, etapaDosConvidados: 0, cotacao: 'ok', erroCotacao: null, revalidando: false, horarioRecusado: null,
};

test('P2-R1: sequência no Valor — revalidando, recusado, nova troca, cotação lenta, erro, recuperação', () => {
    const passos: Array<[string, Partial<EstadoTravaConvidados>, string]> = [
        ['antes de trocar', {}, 'livre'],
        ['troca para 120: revalidando (demora)', { revalidando: true, cotacao: 'carregando' }, 'aguardar'],
        ['revalidação recusou (falha)', { horarioRecusado: mensagemHorarioRecusado(120), cotacao: 'erro', erroCotacao: 'Nenhum salão livre neste horário comporta 120 convidados.' }, 'erro'],
        ['recusado mesmo com a cotação ok', { horarioRecusado: mensagemHorarioRecusado(120), cotacao: 'ok' }, 'erro'],
        ['troca para 90: revalidando de novo', { revalidando: true, cotacao: 'carregando' }, 'aguardar'],
        ['horário ok, cotação ainda carregando (demora)', { cotacao: 'carregando' }, 'aguardar'],
        ['cotação com erro', { cotacao: 'erro', erroCotacao: 'Este pacote ainda não tem preço publicado.' }, 'erro'],
        ['cotação ok (recuperação)', { cotacao: 'ok' }, 'livre'],
    ];
    for (const [nome, delta, esperado] of passos) assert.equal(travaAposConvidados({ ...base, ...delta }).tipo, esperado, nome);
});

test('P2-R1: revalidação em andamento espera mesmo com a cotação já pronta (demora só do horário)', () => {
    assert.equal(travaAposConvidados({ ...base, revalidando: true, cotacao: 'ok' }).tipo, 'aguardar');
    assert.equal(travaAposConvidados({ ...base, revalidando: true, cotacao: 'ok', horarioRecusado: 'recusa anterior' }).tipo, 'aguardar',
        'nova troca em revalidação: espera o resultado em vez de repetir a recusa anterior');
});

test('P2-R1: mensagens — a recusa do horário vence a da cotação; erro de cotação sem texto tem mensagem própria', () => {
    assert.deepEqual(travaAposConvidados({ ...base, horarioRecusado: 'recusado', cotacao: 'erro', erroCotacao: 'outro' }), { tipo: 'erro', mensagem: 'recusado' });
    assert.deepEqual(travaAposConvidados({ ...base, cotacao: 'erro', erroCotacao: null }), { tipo: 'erro', mensagem: MENSAGEM_COTACAO_FALHOU });
    assert.equal(travaAposConvidados({ ...base, cotacao: 'sem' }).tipo, 'erro');
    assert.match(mensagemHorarioRecusado(120), /Com 120 convidados/);
});

test('P2-R1: vale em todas as etapas depois do Pacote; a URL antiga e o próprio Pacote não mudam', () => {
    for (const etapa of [3, 4, 5, 6, 7, 8]) assert.equal(travaAposConvidados({ ...base, etapa, cotacao: 'carregando' }).tipo, 'aguardar', `etapa ${etapa}`);
    assert.equal(travaAposConvidados({ ...base, etapa: 0, cotacao: 'erro' }).tipo, 'livre', 'o Pacote já confere pela regra da etapa');
    assert.equal(travaAposConvidados({ ...base, convidadosDaEntrada: false, cotacao: 'erro' }).tipo, 'livre', 'URL antiga: comportamento de antes');
    assert.equal(travaAposConvidados({ ...base, convidadosDaEntrada: false, etapaDosConvidados: 2, etapa: 5, horarioRecusado: 'x' }).tipo, 'livre');
});

test('P2-R1: o assistente usa a trava antes das outras regras e registra a recusa da troca no chip', () => {
    const fonte = readFileSync('components/fechamento/FechamentoWizard.tsx', 'utf8');
    const validar = fonte.slice(fonte.indexOf('function validarEtapaAtual()'), fonte.indexOf('// Outra empresa: só vale pacote que ela oferece'));
    assert.match(validar, /travaAposConvidados\(\{/, 'a trava roda no início de validarEtapaAtual');
    assert.match(validar, /revalidando: validandoDisponibilidade, horarioRecusado/);
    assert.match(validar, /trava\.tipo === "aguardar"[\s\S]*setAvancarAposCotacao\(true\)/);
    assert.match(validar, /trava\.tipo === "erro"[\s\S]*return false/);
    const alterar = fonte.slice(fonte.indexOf('async function alterarConvidados'), fonte.indexOf('function voltar()'));
    assert.match(alterar, /const valido = await revalidarHorarioAtual\(quantidade\);[\s\S]*?if \(valido === false\) setHorarioRecusado\(ultimaRecusa\.current \?\? mensagemHorarioRecusado\(quantidade\)\);/,
        'S-D: a recusa do salão de preferência traz a mensagem dela; sem ela, a do horário');
    const revalidar = fonte.slice(fonte.indexOf('async function revalidarHorarioAtual'), fonte.indexOf('function validarEtapaAtual()'));
    assert.match(revalidar, /setHorarioRecusado\(null\);\s*return true;/, 'só o sucesso limpa a recusa (recuperação)');
    assert.match(fonte, /etapaQueEspera = etapa === etapaDosConvidados \|\| \(preselecaoDisponibilidade && convidadosDaEntrada && etapa > etapaDosConvidados\)/,
        'a espera da cotação também avança sozinha depois do Pacote');
});

// P2-R3 (Astra): duas trocas rápidas no chip, com as respostas chegando invertidas. O modelo abaixo é o mesmo de
// alterarConvidados: limpa a recusa, revalida pela soAMaisRecente e só grava a recusa se a resposta for a vigente.
function adiada<T>() {
    let resolver!: (v: T) => void;
    let rejeitar!: (e: unknown) => void;
    const promessa = new Promise<T>((ok, erro) => { resolver = ok; rejeitar = erro; });
    return { promessa, resolver, rejeitar };
}
function chip() {
    const seq = { current: 0 };
    const estado = { recusa: null as string | null, aplicadas: [] as number[] };
    const trocar = async (quantidade: number, resposta: Promise<boolean>) => {
        estado.recusa = null;
        const r = await soAMaisRecente(seq, () => resposta);
        if (!r.vigente) return null;
        const valido = r.ok && r.valor;
        if (valido) estado.aplicadas.push(quantidade);
        else estado.recusa = mensagemHorarioRecusado(quantidade);
        return valido;
    };
    return { estado, trocar };
}

test('P2-R3: 120 lento recusado chega DEPOIS de 80 aprovado — a recusa antiga é descartada', async () => {
    const { estado, trocar } = chip();
    const lenta = adiada<boolean>();
    const rapida = adiada<boolean>();
    const p120 = trocar(120, lenta.promessa);
    const p80 = trocar(80, rapida.promessa);
    rapida.resolver(true);
    assert.equal(await p80, true);
    lenta.resolver(false);
    assert.equal(await p120, null, 'resposta antiga descartada');
    assert.equal(estado.recusa, null, 'o formulário com 80 não fica bloqueado pela recusa de 120');
    assert.deepEqual(estado.aplicadas, [80]);
});

test('P2-R3: 80 lento aprovado chega DEPOIS de 120 recusado — o sucesso antigo não limpa a recusa vigente', async () => {
    const { estado, trocar } = chip();
    const lenta = adiada<boolean>();
    const rapida = adiada<boolean>();
    const p80 = trocar(80, lenta.promessa);
    const p120 = trocar(120, rapida.promessa);
    rapida.resolver(false);
    assert.equal(await p120, false);
    lenta.resolver(true);
    assert.equal(await p80, null);
    assert.equal(estado.recusa, mensagemHorarioRecusado(120), 'continua bloqueado pela troca vigente (120)');
    assert.deepEqual(estado.aplicadas, []);
});

test('P2-R3: na ordem normal e com falha de rede antiga, vale sempre a última troca', async () => {
    const { estado, trocar } = chip();
    assert.equal(await trocar(120, Promise.resolve(false)), false);
    assert.equal(estado.recusa, mensagemHorarioRecusado(120));
    assert.equal(await trocar(80, Promise.resolve(true)), true, 'recuperação');
    assert.equal(estado.recusa, null);
    const antiga = adiada<boolean>();
    const pAntiga = trocar(90, antiga.promessa);
    const pNova = trocar(70, Promise.resolve(true));
    assert.equal(await pNova, true);
    antiga.rejeitar(new Error('rede'));
    assert.equal(await pAntiga, null, 'erro de uma consulta antiga também é descartado');
    assert.equal(estado.recusa, null);
});

test('P2-R3: o assistente passa a revalidação pela soAMaisRecente e ignora respostas antigas', () => {
    const fonte = readFileSync('components/fechamento/FechamentoWizard.tsx', 'utf8');
    const revalidar = fonte.slice(fonte.indexOf('async function revalidarHorarioAtual'), fonte.indexOf('function validarEtapaAtual()'));
    assert.match(revalidar, /const resultado = await soAMaisRecente\(revalidacaoSeq, async \(\) => \{/);
    assert.match(revalidar, /if \(!resultado\.vigente\) return null;\s*try \{/, 'a descartada sai antes de qualquer setState (nem encerra a espera)');
    const alterar = fonte.slice(fonte.indexOf('async function alterarConvidados'), fonte.indexOf('function voltar()'));
    assert.match(alterar, /if \(valido === false\) setHorarioRecusado/, 'null (antiga) não grava recusa');
});

// P2-R3 (rodada 3): o caso reproduzido pelo Astra — Continuar no Pacote com 80 pendente, troca para 120 que NÃO cabe no
// pacote (retorno antecipado, sem nova consulta) e o sucesso antigo de 80 chegando depois. Modelo do assistente:
// continuar() e alterarConvidados() com as mesmas regras (invalidarPendentes no início; soAMaisRecente nas consultas).
function assistente(maximoDoPacote: number) {
    const seq = { current: 0 };
    const tela = { etapa: 0, convidados: 80, validando: false, aviso: null as string | null };
    const revalidar = async (resposta: Promise<boolean>) => {
        tela.validando = true;
        const r = await soAMaisRecente(seq, () => resposta);
        if (!r.vigente) return null;
        tela.validando = false;
        return r.ok && r.valor;
    };
    const continuar = async (resposta: Promise<boolean>) => {
        const ok = await revalidar(resposta);
        if (!ok) return;
        tela.etapa = 3;
    };
    const alterar = async (quantidade: number, resposta?: Promise<boolean>) => {
        invalidarPendentes(seq);
        tela.validando = false;
        tela.convidados = quantidade;
        if (quantidade > maximoDoPacote) { tela.etapa = 0; tela.aviso = `não cabe ${quantidade}`; return; }
        await revalidar(resposta!);
    };
    return { tela, continuar, alterar };
}

test('P2-R3 (rodada 3): troca incompatível invalida o Continuar pendente — o sucesso antigo não avança', async () => {
    const { tela, continuar, alterar } = assistente(100);
    const antiga = adiada<boolean>();
    const pContinuar = continuar(antiga.promessa);
    assert.equal(tela.validando, true);
    await alterar(120);
    assert.deepEqual({ etapa: tela.etapa, validando: tela.validando }, { etapa: 0, validando: false }, 'sem consulta substituta, a espera termina');
    antiga.resolver(true);
    await pContinuar;
    assert.deepEqual({ etapa: tela.etapa, convidados: tela.convidados, validando: tela.validando }, { etapa: 0, convidados: 120, validando: false },
        'o sucesso de 80 não leva 120 com pacote incompatível à etapa 3');
});

test('P2-R3 (rodada 3): troca compatível durante o Continuar pendente — vale só a nova consulta', async () => {
    const { tela, continuar, alterar } = assistente(100);
    const antiga = adiada<boolean>();
    const nova = adiada<boolean>();
    const pContinuar = continuar(antiga.promessa);
    const pAlterar = alterar(90, nova.promessa);
    antiga.resolver(true);
    await pContinuar;
    assert.equal(tela.etapa, 0, 'a antiga não avança');
    assert.equal(tela.validando, true, 'a nova ainda está em curso');
    nova.resolver(false);
    await pAlterar;
    assert.deepEqual({ etapa: tela.etapa, validando: tela.validando }, { etapa: 0, validando: false });
});

test('P2-R3 (rodada 3): o assistente invalida antes do retorno antecipado e encerra a espera', () => {
    const fonte = readFileSync('components/fechamento/FechamentoWizard.tsx', 'utf8');
    const alterar = fonte.slice(fonte.indexOf('async function alterarConvidados'), fonte.indexOf('function voltar()'));
    const invalida = alterar.indexOf('invalidarPendentes(revalidacaoSeq);');
    assert.ok(invalida > 0 && invalida < alterar.indexOf('if (motivo)'), 'invalida antes do retorno do pacote incompatível');
    const encerra = alterar.indexOf('setValidandoDisponibilidade(false);');
    assert.ok(encerra > invalida && encerra < alterar.indexOf('if (motivo)'), 'encerra a espera sem consulta substituta');
});
