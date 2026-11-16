import assert from "node:assert/strict";
import test from "node:test";
import { assistenteDoCliente, conexaoDoCartao, explicarFalha, formatarDataHora, situacaoDaConexao, type ConexaoComEvidencias, type EvidenciasConexao } from "./situacao-conexao.ts";

const SAUDAVEL: EvidenciasConexao = { motivoRevogacao: null, credencialInvalida: false, codigoUsado: true, codigoPendente: false, tokenVigente: true, ultimaFalha: null };
const CHATGPT = "https://chatgpt.com/oauth/metadata.json";
const CLAUDE = "https://claude.ai/oauth/mcp-oauth-client-metadata";

function conexao(extra: Partial<ConexaoComEvidencias> & { ev?: Partial<EvidenciasConexao> } = {}): ConexaoComEvidencias {
  const { ev, ...resto } = extra;
  return { clientId: CHATGPT, empresaId: "e1", criadaEm: "2026-11-05T16:00:00Z", ultimaFerramentaEm: null, revogadaEm: null, evidencias: { ...SAUDAVEL, ...ev }, ...resto };
}

test("autorizada sem chamada real fica aguardando a primeira consulta", () => {
  assert.equal(situacaoDaConexao(conexao()).codigo, "AUTORIZADA_SEM_CONSULTA");
});

test("só a chamada real registrada confirma a consulta, com data e horário", () => {
  const s = situacaoDaConexao(conexao({ ultimaFerramentaEm: "2026-11-05T16:55:00Z" }));
  assert.equal(s.codigo, "CONSULTA_OK");
  assert.match(s.detalhe, /Última consulta bem-sucedida em 05\/11\/2026.*13:55/);
});

test("inatividade não vira desconexão: consulta antiga com token vigente continua bem-sucedida", () => {
  const s = situacaoDaConexao(conexao({ criadaEm: "2020-01-01T00:00:00Z", ultimaFerramentaEm: "2020-01-02T00:00:00Z" }));
  assert.equal(s.codigo, "CONSULTA_OK");
  assert.equal(s.causa, null);
});

test("desconexão pela pessoa é desconectada, não 'precisa reconectar'", () => {
  const s = situacaoDaConexao(conexao({ revogadaEm: "2026-11-05T19:00:00Z", ev: { motivoRevogacao: "USUARIO", tokenVigente: false } }));
  assert.equal(s.codigo, "DESCONECTADA");
  assert.equal(s.causa, null);
});

test("substituída não aparece como problema", () => {
  assert.equal(situacaoDaConexao(conexao({ revogadaEm: "2026-11-05T19:00:00Z", ev: { motivoRevogacao: "SUBSTITUIDA" } })).codigo, "SUBSTITUIDA");
});

test("'precisa reconectar' só com evidência, sempre com a causa", () => {
  const casos: Array<[Partial<ConexaoComEvidencias> & { ev: Partial<EvidenciasConexao> }, RegExp]> = [
    [{ revogadaEm: "2026-11-05T19:00:00Z", ev: { motivoRevogacao: "REUSO" } }, /por segurança/],
    [{ ev: { credencialInvalida: true } }, /senha/],
    [{ ev: { codigoUsado: false, codigoPendente: false, tokenVigente: false } }, /não concluiu/],
    [{ ev: { tokenVigente: false } }, /não foi concluída pelo assistente ou a renovação automática terminou/],
  ];
  for (const [entrada, causa] of casos) {
    const s = situacaoDaConexao(conexao(entrada));
    assert.equal(s.codigo, "PRECISA_RECONECTAR");
    assert.match(s.causa ?? "", causa);
  }
});

test("código ainda no prazo não é erro: o assistente ainda pode concluir", () => {
  const s = situacaoDaConexao(conexao({ ev: { codigoUsado: false, codigoPendente: true, tokenVigente: false } }));
  assert.equal(s.codigo, "AUTORIZADA_SEM_CONSULTA");
  assert.match(s.detalhe, /Volte ao assistente/);
});

test("falha de ferramenta não muda a situação para 'precisa reconectar'", () => {
  for (const codigo of ["ESCOPO_INSUFICIENTE", "ACESSO_NEGADO", "ASSINATURA_NECESSARIA", "CANAL_DESATIVADO", "INDISPONIVEL", "VOLUME_ACIMA_DO_LIMITE", "DADOS_INVALIDOS"]) {
    const s = situacaoDaConexao(conexao({ ultimaFerramentaEm: "2026-11-05T16:55:00Z", ev: { ultimaFalha: { codigo, capacidade: "kidmais_consultar_agenda", em: "2026-11-05T17:00:00Z" } } }));
    assert.equal(s.codigo, "CONSULTA_OK", codigo);
  }
});

test("explicação das falhas: permissão cita o alvo; temporária não manda reconectar; nenhuma manda apagar", () => {
  assert.equal(explicarFalha(null), null);
  const escopo = explicarFalha({ codigo: "ESCOPO_INSUFICIENTE", capacidade: "kidmais_consultar_recebiveis_resumo", em: "x" })!;
  assert.match(escopo.titulo, /resumo dos recebíveis/);
  assert.match(escopo.acao, /reconecte/);
  assert.match(escopo.acao, /que deseja manter e as que deseja adicionar/);
  assert.match(escopo.acao, /substitui a anterior/);
  assert.doesNotMatch(escopo.acao, /continuam/);
  for (const codigo of ["INDISPONIVEL", "CANAL_DESATIVADO", "ASSINATURA_NECESSARIA", "VOLUME_ACIMA_DO_LIMITE", "DADOS_INVALIDOS", "OUTRO"]) {
    assert.match(explicarFalha({ codigo, capacidade: null, em: "x" })!.acao, /Não é preciso reconectar/, codigo);
  }
  for (const codigo of ["ESCOPO_INSUFICIENTE", "ACESSO_NEGADO", "INDISPONIVEL", "OUTRO"]) {
    const f = explicarFalha({ codigo, capacidade: null, em: "x" })!;
    assert.doesNotMatch(`${f.titulo} ${f.acao}`, /apag|recri/i, codigo);
  }
});

test("cartão: conexão de outra empresa nunca conta como conectada nesta", () => {
  const outra = { ...conexao({ empresaId: "e2", ultimaFerramentaEm: "2026-11-05T16:55:00Z" }), empresaNome: "Beta" };
  const c = conexaoDoCartao([outra], "chatgpt", "e1");
  assert.equal(c.ativa, null);
  assert.equal(c.situacao.codigo, "AGUARDANDO_AUTORIZACAO");
  assert.deepEqual(c.outrasEmpresas.map((x) => x.empresaNome), ["Beta"]);
});

test("cartão: não mistura assistentes; ativa vence encerrada; substituída não vira desconectada", () => {
  const antiga = conexao({ revogadaEm: "2026-11-04T10:00:00Z", ev: { motivoRevogacao: "USUARIO" } });
  const ativa = conexao({ ultimaFerramentaEm: "2026-11-05T16:55:00Z" });
  assert.equal(conexaoDoCartao([antiga, ativa], "chatgpt", "e1").situacao.codigo, "CONSULTA_OK");
  assert.equal(conexaoDoCartao([antiga], "chatgpt", "e1").situacao.codigo, "DESCONECTADA");
  assert.equal(conexaoDoCartao([ativa], "claude", "e1").situacao.codigo, "AGUARDANDO_AUTORIZACAO");
  const substituida = conexao({ revogadaEm: "2026-11-04T10:00:00Z", ev: { motivoRevogacao: "SUBSTITUIDA" } });
  assert.equal(conexaoDoCartao([substituida], "chatgpt", "e1").situacao.codigo, "AGUARDANDO_AUTORIZACAO");
});

test("sem empresa selecionada, nenhum cartão aparece como conectado", () => {
  assert.equal(conexaoDoCartao([conexao()], "chatgpt", null).situacao.codigo, "AGUARDANDO_AUTORIZACAO");
});

test("assistente vem do host do client_id, não do nome declarado nem de host parecido", () => {
  assert.equal(assistenteDoCliente(CHATGPT), "chatgpt");
  assert.equal(assistenteDoCliente(CLAUDE), "claude");
  for (const x of ["https://chatgpt.com.evil.example/x", "https://evil.example/chatgpt.com", "https://sub.claude.ai/x", "chatgpt", ""]) assert.equal(assistenteDoCliente(x), null, x);
});

test("data do PostgreSQL (::text) é formatada; texto inválido vira travessão", () => {
  assert.match(formatarDataHora("2026-11-05 13:55:00.123-03"), /05\/11\/2026.*13:55/);
  assert.match(formatarDataHora("2026-11-05T16:55:00Z"), /05\/11\/2026.*13:55/);
  assert.equal(formatarDataHora(null), "—");
  assert.equal(formatarDataHora("ontem"), "—");
});
