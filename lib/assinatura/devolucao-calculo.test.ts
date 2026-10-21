import test from 'node:test';
import assert from 'node:assert/strict';
import { calcularProporcional, dataBrasilia, diasEntre, fimDaGarantia, fimDoCicloAnual, gerarProtocolo, meiaNoiteBrasilia, opcoesDeEncerramento, PROTOCOLO,
    somarDiasUteis, type EntradaOpcoes } from './devolucao-calculo.ts';
import { inicioDoDia, somarCiclo } from './provedor-estado.ts';

const instante = (iso: string) => Date.parse(iso);

test('datas de Brasília: meia-noite igual à de provedor-estado e ciclo anual com o mesmo fim', () => {
    assert.equal(meiaNoiteBrasilia('2026-11-10'), inicioDoDia('2026-11-10'));
    for (const d of ['2026-11-10', '2028-02-29', '2027-01-31'])
        assert.equal(meiaNoiteBrasilia(fimDoCicloAnual(d)), somarCiclo(d, 'ANUAL'), d);
    assert.equal(fimDoCicloAnual('2028-02-29'), '2029-02-28');
    assert.equal(dataBrasilia(instante('2026-11-11T02:59:59.999Z')), '2026-11-10');
    assert.equal(dataBrasilia(instante('2026-11-11T03:00:00.000Z')), '2026-11-11');
    assert.equal(diasEntre('2026-11-10', '2027-11-10'), 365);
    assert.equal(diasEntre('2027-03-01', '2028-03-01'), 366);
});

test('proporcional: exemplos numéricos do documento (valor pago, dia do pedido não conta, meio centavo para cima)', () => {
    // Profissional anual R$ 3.970,00, pedido 100 dias depois do início: 265/365.
    assert.deepEqual(calcularProporcional({ valorPagoCentavos: 397_000, inicioCiclo: '2026-11-10', dataPedido: '2027-02-18' }),
        { diasCiclo: 365, diasUtilizados: 100, diasNaoUtilizados: 265, valorCentavos: 288_233 });
    // Mesmo plano com Fundador (40%): R$ 2.382,00 pagos; o desconto não é cobrado de volta.
    assert.equal(calcularProporcional({ valorPagoCentavos: 238_200, inicioCiclo: '2026-11-10', dataPedido: '2027-02-18' }).valorCentavos, 172_940);
    // Essencial anual R$ 1.970,00, pedido no dia 8 (fora da garantia): 357/365.
    assert.equal(calcularProporcional({ valorPagoCentavos: 197_000, inicioCiclo: '2026-11-10', dataPedido: '2026-11-18' }).valorCentavos, 192_682);
    // Último dia do ciclo: 1 dia não utilizado.
    const ultimo = calcularProporcional({ valorPagoCentavos: 697_000, inicioCiclo: '2026-11-10', dataPedido: '2027-11-09' });
    assert.deepEqual([ultimo.diasUtilizados, ultimo.diasNaoUtilizados, ultimo.valorCentavos], [364, 1, 1_910]);
    // Pedido antes do vencimento (pagamento antecipado): nada utilizado; dias limitados ao ciclo.
    assert.equal(calcularProporcional({ valorPagoCentavos: 397_000, inicioCiclo: '2026-11-10', dataPedido: '2026-11-01' }).valorCentavos, 397_000);
    assert.equal(calcularProporcional({ valorPagoCentavos: 397_000, inicioCiclo: '2026-11-10', dataPedido: '2028-01-01' }).valorCentavos, 0);
    // Meio centavo: 1 × 1/2 não existe em ciclo anual; confere a regra com 365 dias e valor que dá x,5.
    assert.equal(calcularProporcional({ valorPagoCentavos: 73, inicioCiclo: '2026-11-10', dataPedido: '2027-05-11' }).valorCentavos, 37); // 73×183/365 = 36,6
    for (const valor of [0, -1, 1.5, Number.NaN])
        assert.throws(() => calcularProporcional({ valorPagoCentavos: valor, inicioCiclo: '2026-11-10', dataPedido: '2027-02-18' }));
    assert.throws(() => calcularProporcional({ valorPagoCentavos: 100, inicioCiclo: '2026-13-01', dataPedido: '2027-02-18' }));
});

test('proporcional: soma do usado e do devolvido nunca passa do pago (todos os dias do ciclo)', () => {
    for (const valor of [197_000, 238_200, 397_000, 418_200, 697_000, 1]) {
        for (let dia = 0; dia <= 365; dia += 1) {
            const c = calcularProporcional({ valorPagoCentavos: valor, inicioCiclo: '2026-11-10', dataPedido: new Date(Date.UTC(2026, 10, 10 + dia)).toISOString().slice(0, 10) });
            assert.ok(c.valorCentavos >= 0 && c.valorCentavos <= valor);
            assert.ok(Math.abs(c.valorCentavos - valor * c.diasNaoUtilizados / c.diasCiclo) <= 0.5);
        }
    }
});

test('garantia de 7 dias: o dia da ativação não conta; termina ao fim do 7º dia (Brasília)', () => {
    const fim = fimDaGarantia('2026-11-10');
    assert.equal(new Date(fim).toISOString(), '2026-11-18T03:00:00.000Z');
    assert.equal(dataBrasilia(fim - 1), '2026-11-17');
});

test('dias úteis: seg–sex, o dia do pedido não conta', () => {
    assert.equal(somarDiasUteis('2026-10-21', 5), '2026-10-28'); // quarta → quarta seguinte
    assert.equal(somarDiasUteis('2026-10-24', 5), '2026-10-30'); // sábado → sexta
    assert.equal(somarDiasUteis('2026-10-23', 1), '2026-10-26'); // sexta → segunda
});

const base = (mudar: Partial<EntradaOpcoes> = {}): EntradaOpcoes => ({
    situacao: 'ATIVA', ciclo: 'ANUAL', agora: instante('2026-11-12T15:00:00Z'), primeiraAtivacao: true, pedidoExistente: false,
    pagamento: { id: 'pay_1', valorCentavos: 397_000, vencimento: '2026-11-10', dataAtivacao: '2026-11-10', formaPagamento: 'PIX' }, ...mudar,
});

test('opções: na garantia, devolução integral (anual ou mensal) e o proporcional não é oferecido', () => {
    const o = opcoesDeEncerramento(base());
    assert.ok(o.arrependimento.disponivel);
    if (o.arrependimento.disponivel) {
        assert.equal(o.arrependimento.valorCentavos, 397_000);
        assert.equal(o.arrependimento.prazoProcessamento, '2026-11-12');
        assert.equal(o.arrependimento.ate, '2026-11-18T03:00:00.000Z');
    }
    assert.deepEqual(o.anualProporcional, { disponivel: false, motivo: 'GARANTIA_PREVALECE' });
    const mensal = opcoesDeEncerramento(base({ ciclo: 'MENSAL', pagamento: { ...base().pagamento!, valorCentavos: 39_700 } }));
    assert.ok(mensal.arrependimento.disponivel && mensal.arrependimento.valorCentavos === 39_700);
    assert.deepEqual(mensal.anualProporcional, { disponivel: false, motivo: 'SOMENTE_ANUAL' });
    // Cancelada ao fim do período ainda pode se arrepender.
    assert.ok(opcoesDeEncerramento(base({ situacao: 'CANCELADA_FIM_PERIODO' })).arrependimento.disponivel);
});

test('opções: depois da garantia, mensal sem devolução; anual proporcional com prazo de 5 dias úteis', () => {
    const depois = instante('2026-11-18T03:00:00Z'); // 18/11 00:00 de Brasília
    const anual = opcoesDeEncerramento(base({ agora: depois }));
    assert.deepEqual(anual.arrependimento, { disponivel: false, motivo: 'GARANTIA_ENCERRADA' });
    assert.ok(anual.anualProporcional.disponivel);
    if (anual.anualProporcional.disponivel) {
        assert.equal(anual.anualProporcional.valorCentavos, 388_299); // 397000 × 357/365
        assert.equal(anual.anualProporcional.prazoProcessamento, '2026-11-25');
        assert.equal(anual.anualProporcional.calculo?.diasUtilizados, 8);
    }
    const mensal = opcoesDeEncerramento(base({ agora: depois, ciclo: 'MENSAL' }));
    assert.equal(mensal.arrependimento.disponivel || mensal.anualProporcional.disponivel, false);
    // Ainda dentro: 17/11 23:59 de Brasília.
    assert.ok(opcoesDeEncerramento(base({ agora: depois - 60_000 })).arrependimento.disponivel);
});

test('opções: recusas (não é a primeira ativação, sem pagamento, situação, pedido existente, período terminado)', () => {
    assert.deepEqual(opcoesDeEncerramento(base({ primeiraAtivacao: false })).arrependimento, { disponivel: false, motivo: 'NAO_E_PRIMEIRA_ATIVACAO' });
    assert.ok(opcoesDeEncerramento(base({ primeiraAtivacao: false })).anualProporcional.disponivel, 'renovação anual: só o proporcional');
    assert.deepEqual(opcoesDeEncerramento(base({ pagamento: null })).arrependimento, { disponivel: false, motivo: 'SEM_PAGAMENTO_CONFIRMADO' });
    assert.deepEqual(opcoesDeEncerramento(base({ pagamento: { ...base().pagamento!, valorCentavos: null } })).arrependimento, { disponivel: false, motivo: 'VALOR_PAGO_DESCONHECIDO' });
    for (const situacao of ['TESTE', 'EM_ATRASO', 'ENCERRADA'])
        assert.deepEqual(opcoesDeEncerramento(base({ situacao })).arrependimento, { disponivel: false, motivo: 'SEM_PERIODO_PAGO_VIGENTE' }, situacao);
    assert.deepEqual(opcoesDeEncerramento(base({ pedidoExistente: true })).anualProporcional, { disponivel: false, motivo: 'PEDIDO_JA_REGISTRADO' });
    assert.deepEqual(opcoesDeEncerramento(base({ agora: instante('2027-11-10T03:00:00Z') })).anualProporcional, { disponivel: false, motivo: 'PERIODO_TERMINADO' });
});

test('protocolo: formato fixo, sem dado pessoal, data de Brasília', () => {
    const p = gerarProtocolo(instante('2026-10-22T02:30:00Z'), new Uint8Array([0, 1, 31, 32, 200, 255, 17, 9]));
    assert.equal(p, 'KM-20261021-01Z08ZH9');
    assert.match(p, PROTOCOLO);
    assert.throws(() => gerarProtocolo(Date.now(), new Uint8Array(4)));
});
