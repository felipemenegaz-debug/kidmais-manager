import assert from 'node:assert/strict';
import test from 'node:test';
import type { ResultadoAtendimento } from '../../../lib/whatsapp/atendimento/resultado.ts';
import { achar, carregarComponente, cssFalso, elementos, texto, tique } from '../teste-componente.ts';

const vazio = { sessoes: 0, entradas: 0, saidas: [], ia: { chamadas: 0, semPreco: 0, custos: [] } };
import { situacaoTeto } from '../../../lib/whatsapp/atendimento/teto-mensal.ts';
const teto = (usadas: number, limite = 1000) => situacaoTeto(usadas, limite, '2026-12');

async function montar(entrada: Omit<ResultadoAtendimento, 'teto'> & { teto?: ResultadoAtendimento['teto'] }, erro?: string) {
  const dados: ResultadoAtendimento = { teto: teto(0), ...entrada };
  const urls: string[] = [];
  const h = carregarComponente('components/admin/atendimento/ResultadoAtendimento.tsx', {
    'next/link': { default: (p: { children?: unknown }) => p.children },
    '@/lib/http/admin-fetch': {
      adminFetch: async (url: string) => {
        urls.push(url);
        return { ok: !erro, json: async () => ({ ok: !erro, data: dados, erro }) };
      },
    },
    './atendimento.module.css': cssFalso,
  });
  const inicial = h.render();
  h.efeitos();
  await tique();
  return { inicial, tela: h.render(), urls };
}

test('resultado: dois meses, entrega confirmada, cobertura em São Paulo e números em português', async () => {
  const { inicial, tela, urls } = await montar({
    primeiraMensagemEm: '2026-12-01T01:30:00.000Z',
    meses: [{
      mes: '2026-12', sessoes: 2345, entradas: 3456,
      saidas: [{ estado: 'ENTREGUE', equipe: 1234, automatica: 11 }, { estado: 'INCERTO', equipe: 0, automatica: 8 }],
      ia: { chamadas: 1234, semPreco: 1, custos: [
        { moeda: 'USD', custoEstimadoMicros: '1234567001' },
        { moeda: 'BRL', custoEstimadoMicros: '1' },
        { moeda: 'EUR', custoEstimadoMicros: '0' },
      ] },
    }, { mes: '2026-11', ...vazio }],
  });
  assert.match(texto(inicial), /Carregando resultado/);
  assert.deepEqual(urls, ['/api/admin/atendimento/resultado']);
  assert.deepEqual(elementos(tela).filter(e => e.type === 'h2').map(texto), ['dezembro de 2026', 'novembro de 2026']);
  assert.match(texto(tela), /Medidas internas de uso.*A fatura da Meta é separada/);
  assert.match(texto(tela), /30\/11\/2026.*Números de mensagens anteriores a essa data não aparecem/);
  assert.match(texto(tela), /Sessões de atendimento de 24 h2\.345Mensagens de entrada3\.456/);
  assert.doesNotMatch(texto(tela), /24 h/, '24 e h ficam juntos na quebra de linha (espaço não separável)');
  assert.equal(achar(tela, 'tr', /ENTREGUEEntrega confirmada1\.23411/).props['data-confirmada'], true);
  assert.equal(achar(tela, 'tr', 'INCERTO08').props['data-confirmada'], false);
  assert.match(texto(tela), /Custo estimado de IA1\.234 chamadas · 1 com preço ausenteUSD 1\.234,567BRL < 0,0001EUR 0,00/);
  assert.equal(achar(tela, 'header').props.className, 'topo topoResultado');
});

test('resultado: custo estimado com 2 a 4 casas, arredondado, e "< 0,0001" acima de zero', async () => {
  const casos: [string, string][] = [
    ['1919', 'USD 0,0019'], ['1500000', 'USD 1,50'], ['12345678', 'USD 12,3457'], ['99', 'USD < 0,0001'],
    ['1', 'USD < 0,0001'], ['100', 'USD 0,0001'], ['149', 'USD 0,0001'], ['150', 'USD 0,0002'], ['0', 'USD 0,00'],
    ['999950', 'USD 1,00'], ['1234567890123', 'USD 1.234.567,8901'], ['120000', 'USD 0,12'], ['123000', 'USD 0,123'],
  ];
  for (const [micros, esperado] of casos) {
    const { tela } = await montar({ primeiraMensagemEm: null, meses: [{ mes: '2026-12', ...vazio,
      ia: { chamadas: 1, semPreco: 0, custos: [{ moeda: 'USD', custoEstimadoMicros: micros }] } }] });
    assert.equal(texto(achar(tela, 'li', /USD/)), esperado, micros);
  }
});

test('resultado: estados vazio, preço ausente em todas as chamadas e falha de leitura', async () => {
  const dados = { primeiraMensagemEm: null, meses: [
    { mes: '2026-12', ...vazio },
    { mes: '2026-11', ...vazio, ia: { chamadas: 1, semPreco: 1, custos: [] } },
  ] };
  const { tela } = await montar(dados);
  assert.match(texto(tela), /Nenhuma mensagem guardada neste ambiente para a empresa ativa/);
  assert.match(texto(tela), /Nenhuma mensagem guardada neste mês/);
  assert.match(texto(tela), /Nenhuma chamada de IA registrada neste mês/);
  assert.match(texto(tela), /1 chamada · 1 com preço ausenteNenhuma chamada com preço conhecido/);
  const falha = await montar(dados, 'Seu acesso não inclui o Atendimento WhatsApp desta empresa.');
  assert.equal(achar(falha.tela, 'p', /Seu acesso/).props.role, 'alert');
});

test('resultado: teto mensal (3b r5) — estimativa, franquia da Meta separada do limite do Wall-e, aviso com ceil', async () => {
  const base = { primeiraMensagemEm: null, meses: [{ mes: '2026-12', ...vazio }] };
  const p = async (t: ResultadoAtendimento['teto']) => achar((await montar({ ...base, teto: t })).tela, 'p', /mensagens do número neste mês/);
  const normal = await p(teto(12));
  assert.equal(texto(normal), 'Cerca de 12 mensagens do número neste mês (equipe e Wall-e), em reservas estimadas pelo iA.Fest; inclui envios que falharam ou foram cancelados. O Wall-e para de responder ao chegar a 1.000 no mês. A Meta não cobra as primeiras 1.000 respostas do mês por número. Se houver cobrança, ela vai para o cartão da conta do WhatsApp do buffet. Confira na Meta a contagem oficial e se houve cobrança.');
  assert.equal(normal.props.role, undefined);
  assert.equal(achar((await montar({ ...base, teto: teto(799) })).tela, 'p', /mensagens do número neste mês/).props['data-teto'], 'NORMAL', '799: ainda sem aviso');
  const aviso = await p(teto(800));
  assert.match(texto(aviso), / Atingiu 800: ao chegar a 1.000, o Wall-e para de responder até o mês que vem. /);
  assert.equal(aviso.props.role, 'alert');
  // ceil (Astra r1, P3): limite 5 ⇒ aviso em 4 (floor daria 4 também; 7 ⇒ ceil 6, floor 5).
  assert.equal(teto(0, 7).aviso, 6);
  assert.equal(teto(5, 7).estado, 'NORMAL');
  const atingido = await p(teto(1000));
  assert.match(texto(atingido), / O Wall-e parou ao chegar a 1.000 e volta no mês que vem; as conversas novas vão para a equipe. A Meta não cobra as primeiras 1.000/);
  assert.equal(atingido.props['data-teto'], 'ATINGIDO');
  // Franquia da Meta separada: limite do Wall-e em 1.500, com 1.100 reservadas ⇒ o Wall-e segue; a tela manda conferir
  // a contagem da Meta, sem afirmar cobrança (Astra r2, P2: reservas incluem falhas e cancelamentos).
  const acima = await p(teto(1100, 1500));
  assert.equal(acima.props['data-teto'], 'NORMAL');
  assert.equal(acima.props.role, 'alert', 'acima da franquia: destaque mesmo abaixo do limite do Wall-e');
  assert.match(texto(acima), /O Wall-e para de responder ao chegar a 1.500 no mês. A estimativa passou das 1.000 respostas do mês que a Meta não cobra. Se houver cobrança, ela vai para o cartão da conta do WhatsApp do buffet. Confira na Meta a contagem oficial e se houve cobrança\.$/);
  assert.doesNotMatch(texto(acima), /é cobrado no cartão|são cobradas pela Meta no cartão|há cobrança/, "reserva não afirma cobrança (Astra r3, P2)");
  for (const t of [normal, aviso, atingido, acima]) {
    assert.match(texto(t), / Se houver cobrança, ela vai para o cartão da conta do WhatsApp do buffet\. Confira na Meta a contagem oficial e se houve cobrança\.$/, 'os dois ramos: "se houver" e conferir na Meta');
    assert.doesNotMatch(texto(t), /acima disso|a cobrança vai para|é cobrado no cartão/, 'nenhum ramo dá a cobrança como certa (Astra r4, P2)');
  }
  // Limite do Wall-e abaixo da franquia: nunca promete "grátis até o limite".
  assert.doesNotMatch(texto(await p(teto(10, 300))), /grátis|até 300 .*não cobra/);
  // Sem teto aplicável (piloto, em qualquer canal, ou sem a 135): a frase não aparece.
  assert.equal(elementos((await montar({ ...base, teto: null })).tela).filter(e => e.type === 'p' && /mensagens do número neste mês/.test(texto(e))).length, 0);
});
