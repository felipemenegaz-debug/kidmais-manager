import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PAGAMENTO_TARDIO, REGRA_RESERVA, textoPagueAte, textoReservaVencida } from './textos-fundador.ts';
import { textoFundador } from '../site/fundador.ts';
import { janelaCalculada, prazoAnunciado } from './campanha.ts';

/** D1/D3 com a redação do parecer jurídico de apoio (§6, 22/10/2026). Datas SINTÉTICAS: nenhuma abertura foi decidida. */
test('regra geral: reserva ao assinar, confirmação no pagamento, fim do 7º dia às 23h59, não 168 horas, não é arrependimento', () => {
    assert.match(REGRA_RESERVA, /fica reservada/);
    assert.match(REGRA_RESERVA, /fim do 7º dia seguinte à confirmação, às 23h59 \(horário de Brasília\)/);
    assert.match(REGRA_RESERVA, /dias de calendário, não 168 horas/);
    assert.match(REGRA_RESERVA, /preserva a condição mesmo depois do fim da campanha/);
    assert.match(REGRA_RESERVA, /12 meses começam com a confirmação do primeiro pagamento/);
    assert.match(REGRA_RESERVA, /não se confunde com o direito de arrependimento/);
});

test('data individual completa, fim do dia, e pagamento tardio sem complemento automático', () => {
    const t = textoPagueAte('2026-11-07');
    assert.match(t, /pague até 07\/11\/2026, fim do dia \(23h59, horário de Brasília\)/);
    for (const s of [t, PAGAMENTO_TARDIO]) {
        assert.match(s, /sem cobrança complementar automática/);
        assert.match(s, /inclusive a devolução quando cabível/);
    }
    const v = textoReservaVencida('2026-11-07');
    assert.match(v, /venceu em 07\/11\/2026, fim do dia \(23h59/);
    assert.match(v, /nada é cobrado a mais automaticamente/);
});

test('site: janela e lote posterior distinguem reserva e confirmação; nenhum texto promete prazo em horas', () => {
    const prazo = prazoAnunciado({ contagem: 'CALENDARIO_LOCAL', janelaFim: janelaCalculada('CALENDARIO_LOCAL', { data: '2026-11-01' }).janelaFim });
    const janela = textoFundador({ fase: 'JANELA', prazo });
    assert.ok(janela.descricao.includes(REGRA_RESERVA));
    assert.match(janela.faq, /fica reservada; ela é confirmada com o primeiro pagamento/);
    const pos = textoFundador({ fase: 'POS_JANELA', vagasRestantes: 5, emConfirmacao: 0, limite: 20 });
    assert.match(pos.descricao, /reservada ao assinar e o benefício é confirmado com o primeiro pagamento/);
    assert.doesNotMatch(pos.descricao, /confirmada na hora de assinar/);
});

test('fontes: "dias corridos" e o texto antigo do prazo não voltam ao site nem à tela de assinatura', () => {
    for (const f of ['lib/site/fundador.ts', 'components/admin/AssinaturaAcoes.tsx', 'lib/assinatura/textos-fundador.ts']) {
        const s = readFileSync(f, 'utf8');
        assert.doesNotMatch(s, /dias corridos/, f);
        assert.doesNotMatch(s, /Pagamento depois disso fica em análise/, f);
    }
});
