import assert from 'node:assert/strict';
import test from 'node:test';
import type { ResultadoAtendimento } from '../../../lib/whatsapp/atendimento/resultado.ts';
import { achar, carregarComponente, cssFalso, elementos, texto, tique } from '../teste-componente.ts';

const vazio = { sessoes: 0, entradas: 0, saidas: [], ia: { chamadas: 0, semPreco: 0, custos: [] } };

async function montar(dados: ResultadoAtendimento, erro?: string) {
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
  assert.match(texto(tela), /Sessões de atendimento de 24 h2\.345Mensagens de entrada3\.456/);
  assert.equal(achar(tela, 'tr', /ENTREGUEEntrega confirmada1\.23411/).props['data-confirmada'], true);
  assert.equal(achar(tela, 'tr', 'INCERTO08').props['data-confirmada'], false);
  assert.match(texto(tela), /Custo estimado de IA1\.234 chamadas · 1 com preço ausenteUSD 1\.234,567001BRL 0,000001EUR 0,00/);
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
