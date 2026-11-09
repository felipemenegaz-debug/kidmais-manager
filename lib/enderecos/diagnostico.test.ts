import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { avaliarTolerancia, diagnosticarEndereco, linhaDeLogDoEndereco, type AmbienteDiagnostico } from './diagnostico.ts';

const A = 'https://manager.kidmaisfestas.com';
const N = 'https://iafest.demerzellabs.com.br';
const hA = 'manager.kidmaisfestas.com';
const hN = 'iafest.demerzellabs.com.br';
const AGORA = Date.parse('2026-11-05T12:00:00Z');

const ATIVA: AmbienteDiagnostico = {
  ENDERECOS_MODO: 'ATIVA', ENDERECOS_ORIGEM_ANTIGA: A, ENDERECOS_ORIGEM_NOVA: N, ADMIN_AUTH_ORIGIN: N,
  SITE_URL: N, AGENDA_PUBLICA_ORIGEM: A, WHATSAPP_ATENDIMENTO_MIDIA_ORIGEM: A, MCP_PUBLIC_URL: `${A}/api/mcp`,
  ENDERECOS_TOLERANCIA_ATE: '2026-11-06T12:00:00Z',
};
const REVERSAO: AmbienteDiagnostico = { ENDERECOS_MODO: 'REVERSAO', ENDERECOS_ORIGEM_ANTIGA: A, ENDERECOS_ORIGEM_NOVA: N, ADMIN_AUTH_ORIGIN: A, MCP_PUBLIC_URL: `${A}/api/mcp` };

const diag = (host: string | null, env: AmbienteDiagnostico) => diagnosticarEndereco(host, env, AGORA);

test('tolerância: só data UTC válida e futura é ativa', () => {
  assert.equal(avaliarTolerancia(undefined, AGORA), 'AUSENTE');
  assert.equal(avaliarTolerancia('', AGORA), 'AUSENTE');
  assert.equal(avaliarTolerancia('2026-11-05T12:00:01Z', AGORA), 'VALIDA');
  assert.equal(avaliarTolerancia('2026-11-06T12:00Z', AGORA), 'VALIDA');
  assert.equal(avaliarTolerancia('2026-11-05T12:00:00Z', AGORA), 'VENCIDA');
  for (const v of ['amanhã', '2026-11-06', '2026-11-06T12:00:00', '2026-11-06T12:00:00-03:00', '2026-13-40T99:00:00Z', '1'])
    assert.equal(avaliarTolerancia(v, AGORA), 'INVALIDA', v);
});

test('data de tolerância inválida não muda o modo: só o conferidor reprova', () => {
  const d = diag(hA, { ...ATIVA, ENDERECOS_TOLERANCIA_ATE: 'amanhã' });
  assert.equal(d.modoEfetivo, 'ATIVA');
  assert.equal(d.codigo, 'OK');
  assert.equal(d.toleranciaAtiva, false);
  assert.equal(d.tolerancia, 'INVALIDA');
});

test('painelNesteHost compara com ADMIN_AUTH_ORIGIN em qualquer modo; nulo sem como saber', () => {
  assert.equal(diag(hA, ATIVA).painelNesteHost, false);
  assert.equal(diag(hN, ATIVA).painelNesteHost, true);
  assert.equal(diag(`${hN}:443`, ATIVA).painelNesteHost, true);
  assert.equal(diag(hA, REVERSAO).painelNesteHost, true);
  assert.equal(diag(hN, REVERSAO).painelNesteHost, false);
  assert.equal(diag(hA, { ADMIN_AUTH_ORIGIN: N }).painelNesteHost, false, 'também sem modo');
  assert.equal(diag(hA, { ...ATIVA, ENDERECOS_MODO: 'XPTO' }).painelNesteHost, false, 'também com configuração inválida');
  assert.equal(diag(hA, { ...ATIVA, ADMIN_AUTH_ORIGIN: undefined }).painelNesteHost, null);
  assert.equal(diag(hA, { ...ATIVA, ADMIN_AUTH_ORIGIN: 'x' }).painelNesteHost, null);
  assert.equal(diag(null, ATIVA).painelNesteHost, null);
  assert.equal(diag(`${hA},evil.com`, ATIVA).painelNesteHost, null);
});

test('origemAtiva: A, N ou indeterminada; nunca o valor', () => {
  assert.equal(diag(hA, ATIVA).origemAtiva, 'N');
  assert.equal(diag(hA, REVERSAO).origemAtiva, 'A');
  assert.equal(diag(hA, { ADMIN_AUTH_ORIGIN: A }).origemAtiva, 'INDETERMINADA');
  assert.equal(diag(hA, { ...ATIVA, ENDERECOS_MODO: 'XPTO' }).origemAtiva, 'INDETERMINADA');
});

test('coerência em ATIVA: tudo certo', () => {
  assert.deepEqual(diag(hA, ATIVA).coerencia, { convites: true, site: true, agenda: true, midia: true, mcp: true });
});

test('coerência: cada origem errada derruba só o seu item, sem mudar o modo', () => {
  const casos: Array<[Partial<AmbienteDiagnostico>, string]> = [
    [{ CONVITES_PUBLIC_ORIGIN: A }, 'convites'],
    [{ SITE_URL: A }, 'site'],
    [{ AGENDA_PUBLICA_ORIGEM: N }, 'agenda'],
    [{ AGENDA_PUBLICA_ORIGEM: undefined }, 'agenda'],
    [{ AGENDA_PUBLICA_ORIGEM: `${A}/x` }, 'agenda'],
    [{ WHATSAPP_ATENDIMENTO_MIDIA_ORIGEM: undefined }, 'midia'],
    [{ WHATSAPP_ATENDIMENTO_MIDIA_ORIGEM: '' }, 'midia'],
    [{ WHATSAPP_ATENDIMENTO_MIDIA_ORIGEM: 'não é url' }, 'midia'],
    [{ WHATSAPP_ATENDIMENTO_MIDIA_ORIGEM: N }, 'midia'],
    [{ MCP_PUBLIC_URL: `${N}/api/mcp` }, 'mcp'],
    [{ MCP_PUBLIC_URL: 'não é url' }, 'mcp'],
  ];
  for (const [mudanca, item] of casos) {
    const d = diag(hA, { ...ATIVA, ...mudanca });
    assert.equal(d.modoEfetivo, 'ATIVA');
    const falsos = Object.entries(d.coerencia!).filter(([, v]) => !v).map(([k]) => k);
    assert.deepEqual(falsos, [item], JSON.stringify(mudanca));
  }
});

test('coerência segue o fallback dos consumidores: ausente ou vazia cai em ADMIN_AUTH_ORIGIN', () => {
  // REVERSAO com tudo ausente: as origens efetivas são A.
  const semNada: AmbienteDiagnostico = { ENDERECOS_MODO: 'REVERSAO', ENDERECOS_ORIGEM_ANTIGA: A, ENDERECOS_ORIGEM_NOVA: N, ADMIN_AUTH_ORIGIN: A };
  assert.deepEqual(diag(hA, semNada).coerencia, { convites: true, site: true, agenda: true, midia: true, mcp: true });
  assert.equal(diag(hA, { ...semNada, CONVITES_PUBLIC_ORIGIN: '' }).coerencia!.convites, true);
  assert.equal(diag(hA, { ...semNada, WHATSAPP_ATENDIMENTO_MIDIA_ORIGEM: '' }).coerencia!.midia, true);
  // Rollback esquecendo CONVITES_PUBLIC_ORIGIN em N: é o caso H22.
  assert.equal(diag(hA, { ...semNada, CONVITES_PUBLIC_ORIGIN: N }).coerencia!.convites, false);
});

test('coerência: nula sem modo válido em uso', () => {
  assert.equal(diag(hA, { ADMIN_AUTH_ORIGIN: A }).coerencia, null);
  assert.equal(diag(hA, { ...ATIVA, ENDERECOS_MODO: 'DESLIGADO' }).coerencia, null);
  assert.equal(diag(hA, { ...ATIVA, ADMIN_AUTH_ORIGIN: A }).coerencia, null);
});

test('MCP: hash do valor bruto detecta mudança só de caminho; ausência é explícita', () => {
  const hash = (v: string) => createHash('sha256').update(v).digest('hex');
  assert.equal(diag(hA, ATIVA).mcpRecursoSha256, hash(`${A}/api/mcp`));
  const soCaminho = diag(hA, { ...ATIVA, MCP_PUBLIC_URL: A });
  assert.equal(soCaminho.coerencia!.mcp, true, 'a origem segue certa');
  assert.notEqual(soCaminho.mcpRecursoSha256, diag(hA, ATIVA).mcpRecursoSha256, 'o hash denuncia');
  assert.equal(diag(hA, { ...ATIVA, MCP_PUBLIC_URL: undefined }).mcpRecursoSha256, 'AUSENTE');
  assert.equal(diag(hA, { ...ATIVA, MCP_PUBLIC_URL: '' }).mcpRecursoSha256, 'AUSENTE');
});

test('nenhum valor de variável aparece na resposta nem no log', () => {
  const env: AmbienteDiagnostico = {
    ...ATIVA, ENDERECOS_MODO: 'segredo-modo', SITE_URL: 'https://segredo-site.example', CONVITES_PUBLIC_ORIGIN: 'https://segredo-convites.example',
    MCP_PUBLIC_URL: 'https://segredo-mcp.example/api/mcp', ENDERECOS_TOLERANCIA_ATE: 'segredo-data',
  };
  for (const texto of [JSON.stringify(diag(hA, env)), linhaDeLogDoEndereco(env, AGORA), JSON.stringify(diag(hA, ATIVA)), linhaDeLogDoEndereco(ATIVA, AGORA)]) {
    assert.doesNotMatch(texto, /segredo|kidmaisfestas|demerzellabs|https?:/);
  }
});

test('log: conteúdo completo, sem os campos que dependem do pedido', () => {
  const linha = linhaDeLogDoEndereco(ATIVA, AGORA);
  const semPedido: Record<string, unknown> = { ...diagnosticarEndereco(null, ATIVA, AGORA) };
  delete semPedido.painelNesteHost;
  assert.deepEqual(JSON.parse(linha.slice('[Enderecos] '.length)), semPedido);
  assert.equal(semPedido.toleranciaAtiva, true);
  assert.match(String(semPedido.mcpRecursoSha256), /^[0-9a-f]{64}$/);
  assert.doesNotMatch(linha, /painelNesteHost/);
});

test('log: uma linha com o estado', () => {
  const linha = linhaDeLogDoEndereco(ATIVA, AGORA);
  assert.match(linha, /^\[Enderecos\] \{/);
  assert.match(linha, /"modoEfetivo":"ATIVA"/);
  assert.doesNotMatch(linha, /\n/);
});
