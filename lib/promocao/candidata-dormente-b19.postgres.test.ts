import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import type { DbExecutor } from "../db/contracts.ts";
import { carregar, catalogoNativo, catalogoNoTurno, cenario, dia, id, type Cenario } from "../../scripts/integracao-importados-test-support.ts";
import { carregarComBanco, executor, porSavepoint, porTransacao } from "../marketing/harness-postgres.ts";
import { carregarModulo } from "../acessos/teste-carregador.ts";
import * as cotacaoPublicaReal from "../comercial/cotacao-publica.ts";
import * as escopoReal from "../disponibilidade/escopo.ts";
import { MARCADORES } from "../assinatura/recuperacao-execucao.ts";
import { apresentacaoInstalada, salvarApresentacao } from "../agenda/salao-apresentacao.ts";
import { criarServicosComuns } from "../comercial/servicos-comuns.ts";
import { combinadosInstalados, hashVersaoInstalada, preferidoInstalado } from "../agenda/salao-festa.ts";
import { estadoCombinados } from "../agenda/estado-combinados.ts";
import { capacidadeRenovacao } from "../assinatura/renovacao-schema.ts";
import { criarRepositorioOAuthPostgres, SchemaMcpAusente } from "../integracoes/oauth/postgres.ts";
import { conexoesDaPessoa } from "../integracoes/oauth/conexoes.ts";
import { criarTransporteMcp } from "../integracoes/mcp/servidor.ts";
import { cpfDisponivel, schemaCpfInstalado } from "../assinatura/documento-contratante.ts";
import { validarAmbienteFesta } from "../festas/ambiente.ts";
import { assinaturaEstruturaFestaAtual, estruturaFesta016Sql, tabelasFesta016 } from "../festas/estrutura-016.ts";
import { exigirTravaConfiguracao, travarConfiguracaoAgenda, TravaConfiguracaoAusenteError } from "../agenda/trava-configuracao.ts";
import { avisosDeUsoFranquia, franquiasInstaladas, processarPendenciasFranquia, registrarPendenciaFranquia } from "../creditos/franquias.ts";
import { franquiaDoMes } from "../creditos/manutencao.ts";
import { colisoesDisponivel, modoEfetivo } from "../whatsapp/atendimento/multiempresa.ts";
import { concluirCota, cotaInstalada, liberarCota, reservarCota } from "../importacao-contrato/cota.ts";
import { documentosDisponiveis, registrarDocumento, registrarExtracao, ultimaExtracao } from "../importacao-contrato/repositorio-documentos.ts";
import { executarNoTenant, type SessaoParaTenant } from "../saas/provar-tenant.ts";
import { cobrancaDestravada, decidirTravaCobranca, exigirCobrancaDestravada } from "../assinatura/trava-cobranca.ts";
// Rodada 2 (parecer B19A-R1): consumidores reais da 116 (manutenção, executor do cron, sincronização) e da 117 (recepção,
// status, configuração, tela, limpeza e worker), nos mesmos modelos, sem instalar 116/117.
import { createRequire } from "node:module";
import { abrirCarteira } from "../creditos/ledger.ts";
import { empresasComCarteira, manutencaoEmpresa } from "../creditos/manutencao.ts";
import { iniciarTeste } from "../assinatura/servico.ts";
import { prepararOferta } from "../assinatura/ofertas.ts";
import { valorComercial } from "../assinatura/planos-comerciais.ts";
import { sincronizarEmpresa } from "../assinatura/sincronizacao.ts";
import type { AssinaturaProvedor, CobrancaProvedor } from "../assinatura/asaas.ts";
import { DOCUMENTOS, hashDocumento } from "../cadastro/documentos-legais.ts";
import { carregarComponente } from "../../components/admin/teste-componente.ts";
import * as credencialWhatsapp from "../whatsapp/credencial.ts";
import * as coreAtendimento from "../whatsapp/atendimento/core.ts";
import * as configuracaoAtendimentoReal from "../whatsapp/atendimento/configuracao.ts";
import * as multiempresa from "../whatsapp/atendimento/multiempresa.ts";
import { carregarAtendimento, cod as codAtendimento, db as dbAtendimento, transporteSemRede, withTransaction as transacaoAtendimento } from "../whatsapp/atendimento/harness-postgres.ts";
import type { ConteudoSaida } from "../whatsapp/atendimento/transporte.ts";
import type { AlvoEnvio } from "../whatsapp/atendimento/worker.ts";

/**
 * B-19 do plano de promoção para production (rodada 18, R17-F5; §4.5): a candidata roda no schema FINAL desta promoção
 * (089–097, 099 e 100, na ordem do runbook) COM e SEM a 091, e SEM 098 e 102–109 (D-ESC-4…7 = (a)). Modelos da receita:
 * b14-P11 (com a 091) e b14-P10 (sem a 091). Cada modelo roda a suíte inteira; o modelo é identificado pelo catálogo, e o
 * primeiro teste recusa qualquer outro schema (a suíte nunca "passa" num estado que não é o da promoção).
 * Cobre as RECUSAS da ausência pelos caminhos reais (serviço ou rota carregada com o banco do cluster):
 *   102 → 409 RECURSO_INDISPONIVEL; 103 → 409 RECURSO_INDISPONIVEL (categoria Serviços); 104 → hashVersaoInstalada falso e
 *   módulo Festa/health aceitos (assinatura estrutural atual); 105 → transporte MCP 503 antes de qualquer dependência com o
 *   canal desligado E GET/POST administrativos de conexões 503 (SchemaMcpAusente), sem criar nada; 106 → preferidoInstalado
 *   falso e POST público com preferência = 409 SALAO_INDISPONIVEL sem escrita; 107/108 → combinados AUSENTE (e os caminhos
 *   da agenda seguem sem combinados); 109 → renovação no modo 075; 091 → CPF disponível só com a 091 E a chave ligada.
 * Fluxos normais: o mesmo POST público sem preferência cria o fechamento (201), e o health responde 200 com Festa ligada.
 * 100 → com um salão, capacidade antiga 2 aceita uma festa por horário. "Sem escrita" é medido dentro da transação
 * (pg_stat_xact_user_tables) antes do ROLLBACK. As suítes de domínio (agenda, Festa, renovação, disponibilidade) rodam
 * também nestes modelos (regressao-v1-selecao.cjs).
 *
 * B-19 AMPLIADO (§9.2.7, rodada 25; ensaio LOCAL de 09/11/2026 sobre o head de staging, não sobre a candidata C congelada):
 * modelos b14-P12 (com a 091), b14-P12-sem091 e b14-P12-118 — 105 PRESENTE, sem 098, 102–104, 106–109, 112, 114, 116, 117
 * e (exceto no P12-118) sem a 118. Acrescenta:
 *   105 presente → conexões GET 200 com a lista (vazia) e POST de concessão inexistente 404 NAO_ENCONTRADA (nunca 503 por
 *   schema); o transporte com o canal desligado segue 503 antes de qualquer dependência;
 *   112 → pessoaJuridicaDisponivel falso; POST público com CNPJ = 409 PJ_INDISPONIVEL (MIGRACAO_PENDENTE), sem escrita;
 *   114 → sem kidmais114_exigir_configuracao; a guarda em TypeScript (exigirTravaConfiguracao) recusa sem a trava e passa com ela;
 *   116 → franquiasInstaladas falso; com CREDITOS_FRANQUIA_PLANO_ATIVO ligada a franquia segue o caminho legado (porPlano
 *   false); pendência e avisos não escrevem;
 *   117 → com WHATSAPP_ATENDIMENTO_MULTIEMPRESA=true o modo efetivo é PILOTO e a marca de colisão fica indisponível;
 *   118 → com CONTRACT_IMPORT ligado o envio de documento = 503 COTA_INDISPONIVEL antes de gravar e de ler (também com a
 *   dispensa copiada para o serviço de production); desligado, recusa pela flag antes de tudo. No P12-118 o mesmo envio lê
 *   e consome a cota (fluxo normal);
 *   L2 (B-25) → com KIDMAIS_DEPLOY_ENV=production (só neste processo de teste) a trava recusa 503 COBRANCA_TRAVADA dentro da
 *   transação, sem escrita; execução local abre. A suíte própria da B-25 também roda nos modelos P12 (seleção).
 *
 * RODADA 2 (09/11/2026, parecer independente da rodada 1: B19A-R1, R3 e R4; ainda LOCAL e sobre o head de staging):
 *   modelos de ESTADO FINAL × prova de TRAJETÓRIA: b14-P12/-sem091 são o estado final da opção (d) da D-ESC-8 (118 adiada);
 *   b14-P12-118 e b14-P12-118-sem091 aplicam a 118 na ordem da opção (c) (E6: 100 → 118 → 091; a segunda com a 091
 *   adiada). As opções (a) A-118 e (b) E3 NÃO são ensaiadas (D-ESC-8 pendente);
 *   116, consumidores → empresa com plano, carteira/corte e limite legado: o executor REAL do cron (scripts/creditos-
 *   manutencao.cjs, executar + manutencaoEmpresa com a chave ligada no processo) concede pelo caminho legado, repetir não
 *   concede de novo; a sincronização REAL (sincronizarEmpresa, provedor falso) chega à pendência e COMMITA; pendência
 *   direta numa transação com escrita anterior não invalida a transação;
 *   117, consumidores → recepção, configuração, tela, status (duplicado e único), limpeza e worker REAIS com a chave ligada:
 *   piloto opera; não piloto recusada (não grava, não configura, automação indisponível); nada consulta a tabela de colisões
 *   nem o rodízio (ausentes: qualquer consulta falharia); a pendência da não piloto fica intacta;
 *   L2 → a recusa é medida num iniciador que ESCREVE depois da trava (a abertura indevida aparece como escrita); controle
 *   positivo do observador: escrita desfeita por ROLLBACK TO SAVEPOINT antes da recusa continua contada.
 */
// O serviço de clientes tem imports sem extensão: carregado pelo transpilador dos testes (não pelo strip nativo).
const { pessoaJuridicaDisponivel } = carregar<typeof import("../clientes/services/cliente.service.ts")>("lib/clientes/services/cliente.service.ts");
let a: Client;
let tx: DbExecutor;
let com091 = false;
let com105 = false;
let com118 = false;

async function existe(tipo: "tabela" | "funcao", nome: string) {
  const sql = tipo === "tabela" ? "SELECT to_regclass('public.' || $1) IS NOT NULL AS ok"
    : "SELECT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = $1) AS ok";
  return (await a.query<{ ok: boolean }>(sql, [nome])).rows[0]!.ok === true;
}
async function coluna(tabela: string, nome: string) {
  return (await a.query<{ ok: boolean }>(`SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('public.' || $1)
    AND attname = $2 AND NOT attisdropped) AS ok`, [tabela, nome])).rows[0]!.ok === true;
}
async function codigoDe(promessa: Promise<unknown>) {
  try { await promessa; return "SEM_RECUSA"; }
  catch (e) { const x = e as { code?: string; codigo?: string; httpStatus?: number; status?: number };
    return `${x.codigo ?? x.code ?? (e instanceof Error ? e.name : "ERRO")}:${x.httpStatus ?? x.status ?? ""}`; }
}
async function emTransacaoDesfeita<T>(fn: () => Promise<T>): Promise<T> {
  await a.query("BEGIN");
  try { return await fn(); } finally { await a.query("ROLLBACK"); }
}
/** Escritas desta sessão na transação aberta (INSERT/UPDATE/DELETE em tabelas do usuário, inclusive as que serão desfeitas). */
const escritasNaTransacao = async () => (await a.query<{ n: number }>(
  `SELECT coalesce(sum(n_tup_ins + n_tup_upd + n_tup_del), 0)::int AS n FROM pg_stat_xact_user_tables`)).rows[0]!.n;
/** Recusa observada DENTRO da transação, antes do ROLLBACK (revisão do Astra, P3): qualquer escrita antes da recusa aparece. */
async function recusaSemEscrita(fn: () => Promise<unknown>) {
  return emTransacaoDesfeita(async () => {
    const antes = await escritasNaTransacao();
    const codigo = await codigoDe(fn());
    return { codigo, escritas: (await escritasNaTransacao()) - antes };
  });
}
/** Igual a recusaSemEscrita, para quem RESPONDE (rota/gateway) em vez de lançar: devolve o valor e as escritas. */
async function respostaComEscritas<T>(fn: () => Promise<T>) {
  return emTransacaoDesfeita(async () => {
    const antes = await escritasNaTransacao();
    const valor = await fn();
    return { valor, escritas: (await escritasNaTransacao()) - antes };
  });
}
function cpfValido() {
  const base = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  if (base.every((d) => d === base[0])) base[8] = (base[0]! + 1) % 10;
  const dv = (n: number[]) => { const soma = n.reduce((t, d, i) => t + d * (n.length + 1 - i), 0) % 11; return soma < 2 ? 0 : 11 - soma; };
  const d1 = dv(base);
  return [...base, d1, dv([...base, d1])].join("");
}
const ctx = (c: Cenario) => ({ empresaId: c.empresa, usuarioId: c.usuario, requestId: randomUUID() });

type RespostaRota = { status: number; body: Record<string, unknown> };
/** POST público de fechamento com o banco do cluster; `transacao` decide se a rota commita (porTransacao) ou usa savepoints. */
async function rotaFechamentos(c: Cenario, transacao: "COMMIT" | "SAVEPOINT") {
  const tarde = await id(a, `INSERT INTO configuracao_agenda (codigo, nome, horario_inicio_padrao, horario_fim_padrao, tolerancia_inicio_minutos, passo_inicio_minutos,
                ordem_exibicao, empresa_id, capacidade) VALUES ($1, 'Tarde', '15:00', '19:00', 0, 30, 1, $2::uuid, 1) RETURNING id`,
  [`TARDE_B19_${randomBytes(3).toString("hex").toUpperCase()}`, c.empresa]);
  await catalogoNativo(a, c);
  await catalogoNoTurno(a, c, tarde);
  const extras = {
    "next/server": { NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, body }) } },
    "http/limite-publico": { limitarPublico: async () => null },
    "comercial/cotacao-publica": { ...cotacaoPublicaReal, codigoEmpresaDoPedido: () => "buffet-b19",
      escopoCotacaoPublica: async () => ({ empresaId: c.empresa, estabelecimentoId: null, porCodigo: true }) },
    "disponibilidade/escopo": { ...escopoReal, escopoDaEmpresa: async () => ({ estabelecimentoId: null }) },
    "db/postgres": { db: () => executor(a), withTransaction: transacao === "COMMIT" ? porTransacao(a) : porSavepoint(a) },
  };
  const rota = carregarComBanco("app/api/fechamentos/route.ts", a, () => null, extras, new Map()) as unknown as {
    POST: (r: unknown) => Promise<RespostaRota> };
  return (data: string, extra: Record<string, unknown> = {}) => rota.POST({ url: "http://localhost/api/fechamentos", nextUrl: new URL("http://localhost/api/fechamentos"),
    headers: new Headers(), json: async () => ({
      pacote: "completa", dataFesta: data, configuracaoId: tarde, ajusteHorario: "0", horarioInicio: "15:00", horarioFim: "19:00",
      identidadeTipo: "NOVO_CLIENTE", statusDisponibilidade: "disponivel", convidadosPagantes: 50, buffetDefinicao: "depois", adicionaisSelecionados: [],
      valorCombinado: "100,00", formaPagamento: "pix_avista", nomeCliente: "Cliente Sintético B19", cpf: cpfValido(), email: `b19-${randomBytes(3).toString("hex")}@buffet.test`,
      whatsapp: "11988880019", telefone: "1133330019", cep: "70000000", logradouro: "Rua Sintética", numero: "1", bairro: "Centro", cidade: "Brasília", uf: "DF",
      nomeAniversariante: "Aniversariante B19", idadeAniversariante: 6, ...extra,
    }) });
}

test.before(async () => {
  a = await conectarDescartavel();
  tx = executor(a);
});
test.after(async () => { if (a) await encerrarDescartavel(a); });

test("B-19: o schema é o final da promoção (089–097, 099, 100; 091 e 105 conforme o modelo) sem 098, 102–104, 106–109, 112, 114, 116 e 117", async () => {
  for (const [m, o] of Object.entries(MARCADORES)) {
    if (m === "091") continue;
    assert.equal(await existe(o.tipo, o.nome), true, `marcador da ${m} presente`);
  }
  assert.equal(await existe("funcao", "kidmais_100_capacidade_por_horario") || await coluna("agenda_escopo_config", "capacidade_tipo"), true, "100/094 presentes");
  com091 = await existe("tabela", "empresa_documento_continuidades");
  assert.equal(com091, await schemaCpfInstalado(tx), "091: tabela e função andam juntas (nunca parcial)");
  com105 = await existe("tabela", "mcp_oauth_clientes");
  assert.equal(await existe("tabela", "mcp_oauth_concessoes"), com105, "105: nunca parcial");
  com118 = await cotaInstalada(tx);
  assert.equal(await existe("tabela", "ia_importacao_usos") || await existe("tabela", "ia_importacao_cotas"), com118, "118: nunca parcial");
  assert.ok(!com118 || com105, "118 só nos modelos ampliados (P12-118 e P12-118-sem091)");
  if (com118) {
    // Trajetória da opção (c) da D-ESC-8 (E6: 100 → 118 → 091). Indício pelo catálogo da base recém-criada pela receita
    // (cada migration é uma transação própria): xmin da linha gravada por cada uma — a 100 regrava kidmais094_conflito_ocupacao,
    // a 118 cria kidmais_118_periodo_mensal e a 091 cria empresa_documento_continuidades. Não é prova da ordem de production.
    const xmin = async (sql: string) => Number((await a.query<{ x: string | null }>(sql)).rows[0]?.x ?? 0);
    const x100 = await xmin(`SELECT xmin::text AS x FROM pg_proc WHERE oid = to_regprocedure('public.kidmais094_conflito_ocupacao(uuid,date,time without time zone,time without time zone,uuid,uuid,uuid,uuid)')`);
    const x118 = await xmin(`SELECT xmin::text AS x FROM pg_proc WHERE proname = 'kidmais_118_periodo_mensal'`);
    assert.ok(x100 > 0 && x118 > x100, `118 aplicada depois da 100 (xmin 100=${x100}, 118=${x118})`);
    if (com091) {
      const x091 = await xmin(`SELECT xmin::text AS x FROM pg_class WHERE oid = to_regclass('public.empresa_documento_continuidades')`);
      assert.ok(x091 > x118, `091 aplicada depois da 118 (xmin 118=${x118}, 091=${x091})`);
    }
    console.log(`B-19 trajetória (c): xmin 100=${x100} 118=${x118}${com091 ? "" : " (091 adiada)"}`);
  }
  // Ausentes: 098 e 102–104, 106–109 (objetos próprios de cada uma).
  assert.equal(await existe("funcao", "kidmais098_conjunto"), false, "098/108 ausentes");
  assert.equal(await existe("tabela", "agenda_salao_itens_catalogo"), false, "102 ausente");
  assert.equal(await coluna("agenda_saloes", "convidados_minimo"), false, "102 ausente (colunas)");
  assert.equal((await a.query<{ n: number }>(`SELECT count(*)::int AS n FROM adicional_categorias WHERE codigo = 'SERVICOS'`)).rows[0]!.n, 0, "103 ausente");
  assert.equal(await coluna("fechamento_revisoes", "hash_versao"), false, "104 ausente");
  assert.equal(await existe("funcao", "kidmais104_hash_versao_imutavel"), false, "104 ausente (função)");
  assert.equal(await coluna("fechamentos", "salao_preferido_id"), false, "106 ausente");
  assert.equal(await coluna("agenda_saloes", "combinado"), false, "108 ausente (coluna)");
  // Ampliado: 112, 114, 116 e 117 ausentes em todos os modelos.
  assert.equal(await coluna("clientes", "tipo_pessoa"), false, "112 ausente");
  assert.equal(await coluna("clientes", "cnpj"), false, "112 ausente (cnpj)");
  assert.equal(await existe("funcao", "kidmais114_exigir_configuracao"), false, "114 ausente");
  assert.equal(await existe("tabela", "ia_credito_franquias_ciclo"), false, "116 ausente");
  assert.equal(await existe("tabela", "ia_credito_franquia_pendencias"), false, "116 ausente (pendências)");
  assert.equal(await existe("tabela", "whatsapp_atendimento_rodizio"), false, "117 ausente");
  assert.equal(await existe("tabela", "whatsapp_atendimento_status_colisoes"), false, "117 ausente (colisões)");
  const nome = com105
    ? `b14-P12${com118 ? "-118" : ""}${com091 ? "" : "-sem091"} (105 presente${com091 ? ", com a 091" : ", sem a 091"}${com118 ? ", com a 118" : ", sem a 118"})`
    : com091 ? "b14-P11 (com a 091)" : "b14-P10 (sem a 091)";
  console.log(`B-19 modelo: ${nome}`);
});

test("B-19 (102/103): apresentação dos salões e categoria Serviços recusam com 409 RECURSO_INDISPONIVEL, sem escrita", async () => {
  assert.equal(await apresentacaoInstalada(tx), "AUSENTE");
  const c = await cenario(a, 0);
  const salao = await id(a, `INSERT INTO agenda_saloes (empresa_id, nome, capacidade_convidados, ordem) VALUES ($1::uuid, 'Salão B-19', 80, 1) RETURNING id`, [c.empresa]);
  const r102 = await recusaSemEscrita(() => salvarApresentacao(tx, ctx(c), salao, 1, {
    convidadosMinimo: null, convidadosSentados: null, areaM2: 100, idadeMin: 3, idadeMax: 10, frase: "B-19", outraFestaSimultanea: true, exclusivos: [], fotosReferencia: "2026-09",
  }, []));
  assert.deepEqual(r102, { codigo: "RECURSO_INDISPONIVEL:409", escritas: 0 }, "102: recusa sem nenhuma escrita antes dela");
  const r103 = await recusaSemEscrita(() => criarServicosComuns(tx, ctx(c)));
  assert.deepEqual(r103, { codigo: "RECURSO_INDISPONIVEL:409", escritas: 0 }, "103: recusa sem nenhuma escrita antes dela");
  assert.equal((await a.query<{ n: number }>(`SELECT count(*)::int AS n FROM adicional_categorias WHERE codigo = 'SERVICOS'`)).rows[0]!.n, 0, "nada criado");
});

test("B-19 (104): sem hash_versao; o módulo Festa aceita a estrutura e o health responde 200 com Festa ligada", async () => {
  assert.equal(await hashVersaoInstalada(tx), false);
  assert.equal((await a.query<{ assinatura: string }>(estruturaFesta016Sql, [tabelasFesta016])).rows[0]!.assinatura, assinaturaEstruturaFestaAtual,
    "assinatura estrutural = a anterior à 104 (o código de production também a aceita)");
  const anterior = process.env.FESTA_ENABLED;
  process.env.FESTA_ENABLED = "true";
  try {
    await validarAmbienteFesta(tx);
    const rota = carregarComBanco("app/api/health/route.ts", a, () => null, {
      "db/postgres": { db: () => tx, databaseHealthCheck: async () => (await a.query<{ ok: number }>("SELECT 1 AS ok")).rows[0]!.ok === 1 },
      "identidade/delivery": { validarConfiguracaoOtpAmbiente: () => ({ provider: "gupshup", status: "ready", configured: true, enabled: true }) },
    }, new Map()) as unknown as { GET: () => Promise<Response> };
    const r = await rota.GET();
    assert.equal(r.status, 200, await r.text());
  } finally {
    if (anterior === undefined) delete process.env.FESTA_ENABLED; else process.env.FESTA_ENABLED = anterior;
  }
});

test("B-19 (105): transporte MCP desligado = 503 sem tocar dependência; conexões: 503 SchemaMcpAusente sem a 105, lista e 404 com ela", async () => {
  const tocadas: string[] = [];
  const barreira = (nome: string): unknown => new Proxy(() => undefined, {
    get: (_alvo, p) => { if (p === "then") return undefined; tocadas.push(`${nome}.${String(p)}`); return barreira(`${nome}.${String(p)}`); },
    apply: () => { tocadas.push(`${nome}()`); throw new Error(`dependência tocada: ${nome}`); },
  });
  const atender = criarTransporteMcp({ oauth: { env: {} }, ferramentas: barreira("ferramentas"), limitador: barreira("limitador"), prazoCorpoMs: 200 } as never);
  const r = await atender(new Request("https://manager.example.test/api/mcp", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }));
  assert.equal(r.status, 503);
  assert.deepEqual(tocadas.filter((t) => t.endsWith("()")), [], "nenhuma dependência chamada com o canal desligado");

  const c = await cenario(a, 0);
  const repo = criarRepositorioOAuthPostgres(() => tx, porTransacao(a));
  if (com105) {
    assert.deepEqual(await conexoesDaPessoa({}, repo, c.usuario), { canal: { ativo: false, urlServidor: null }, conexoes: [] }, "105 presente: lista (vazia), canal desligado");
  } else {
    await assert.rejects(conexoesDaPessoa({}, repo, c.usuario), SchemaMcpAusente);
    await assert.rejects(conexoesDaPessoa({ MCP_ENABLED: "false" }, repo, c.usuario), SchemaMcpAusente);
  }
  // A rota é carregada pelo carregador de testes (transpila cada módulo): o repositório dela vem do MESMO cache, para que
  // o SchemaMcpAusente lançado seja a classe que a rota reconhece (instanceof), como no servidor real.
  const cache = new Map<string, Record<string, unknown>>();
  const postgresDaRota = carregarModulo("lib/integracoes/oauth/postgres.ts", {}, cache) as { criarRepositorioOAuthPostgres: typeof criarRepositorioOAuthPostgres };
  const repoDaRota = postgresDaRota.criarRepositorioOAuthPostgres(() => tx, porTransacao(a));
  const rota = carregarComBanco("app/api/admin/mcp/conexoes/route.ts", a, () => ({ usuario_id: c.usuario, empresa_ativa_id: c.empresa }), {
    "mcp/dependencias": { repositorioDaPessoa: () => repoDaRota },
    // O carregador de rotas não transpila este módulo; a rota só o usa em `instanceof` (prazo vencido → 503 próprio).
    "db/transacao-com-prazo": { PrazoDaTransacaoVencido: class PrazoDaTransacaoVencido extends Error {} },
  }, cache) as unknown as { GET: (r: unknown) => Promise<Response>; POST: (r: unknown) => Promise<Response> };
  const get = await rota.GET(new Request("http://localhost/api/admin/mcp/conexoes"));
  const post = await rota.POST(new Request("http://localhost/api/admin/mcp/conexoes", { method: "POST", body: JSON.stringify({ concessaoId: randomUUID() }),
    headers: { "content-type": "application/json" } }));
  if (com105) {
    assert.equal(get.status, 200, "105 presente: a lista sai (nunca 503 por schema)");
    assert.deepEqual((await get.json() as { data: { conexoes: unknown[] } }).data.conexoes, []);
    assert.equal(post.status, 404, "105 presente: revogar concessão inexistente = 404");
    assert.equal((await post.json() as { codigo: string }).codigo, "NAO_ENCONTRADA");
    assert.equal((await a.query<{ n: number }>(`SELECT count(*)::int AS n FROM mcp_oauth_concessoes`)).rows[0]!.n, 0, "nada criado");
  } else {
    assert.equal(get.status, 503);
    assert.equal((await get.json() as { codigo: string }).codigo, "INDISPONIVEL");
    assert.equal(post.status, 503);
    assert.equal((await post.json() as { codigo: string }).codigo, "INDISPONIVEL");
    assert.equal(await existe("tabela", "mcp_oauth_concessoes"), false, "nenhum objeto criado");
  }
});

test("B-19 (106 e fluxo normal): POST público sem preferência cria o fechamento (201); com preferência = 409 SALAO_INDISPONIVEL sem escrita", async () => {
  assert.equal(await preferidoInstalado(tx), false);
  const c = await cenario(a, 0);
  const enviar = await rotaFechamentos(c, "COMMIT");
  const contagem = async () => (await a.query<{ n: number }>(`SELECT count(*)::int AS n FROM fechamentos WHERE empresa_id = $1::uuid`, [c.empresa])).rows[0]!.n;
  const ok = await enviar(dia(170));
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(await contagem(), 1, "fechamento criado pelo caminho público normal");
  const salao = await id(a, `INSERT INTO agenda_saloes (empresa_id, nome, capacidade_convidados, ordem) VALUES ($1::uuid, 'Salão B-19', 80, 1) RETURNING id`, [c.empresa]);
  const pref = await enviar(dia(171), { salaoPreferido: salao });
  assert.deepEqual([pref.status, pref.body.codigo], [409, "SALAO_INDISPONIVEL"], JSON.stringify(pref.body));
  assert.equal(await contagem(), 1, "preferência recusada sem escrita");
});

test("B-19 (107/108): combinados AUSENTE; os caminhos da agenda seguem sem combinados (nunca ANTIGA/PARCIAL)", async () => {
  assert.deepEqual(await estadoCombinados(tx), { estado: "AUSENTE", coluna: false });
  assert.equal(await combinadosInstalados(tx), false);
});

test("B-19 (109): a renovação roda no modo 075 (retrato da tabela de renovações íntegro, sem a SUBSTITUTA)", async () => {
  assert.deepEqual(await capacidadeRenovacao(tx), { capacidade: "075" });
});

test("B-19 (091): CPF só com a 091 instalada E a chave ligada; sem a 091 a chave ligada não basta", async () => {
  assert.equal(await cpfDisponivel(tx, {}), false, "chave desligada: nunca");
  assert.equal(await cpfDisponivel(tx, { ASSINATURA_CPF_ATIVO: "true" }), com091, com091 ? "com a 091: disponível com a chave" : "sem a 091: indisponível mesmo com a chave");
});

test("B-19 (100): com um salão (POR_HORARIO), capacidade antiga 2 aceita só uma festa no horário; outro horário segue livre", async () => {
  const conflito = "kidmais094_conflito_ocupacao(uuid,date,time without time zone,time without time zone,uuid,uuid,uuid,uuid)";
  assert.equal((await a.query<{ h: string }>(`SELECT encode(sha256(convert_to(replace(prosrc, E'\r', ''), 'UTF8')), 'hex') AS h FROM pg_proc
    WHERE oid = to_regprocedure('public.${conflito}')`)).rows[0]?.h, "805cd427a7cc7a725fb3bdfb4fd050f04e618131104fcfc0678a0ddadd5b4bdb", "corpo da regra = o da 100");
  const c = await cenario(a, 0);
  const D = dia(45);
  await a.query(`INSERT INTO agenda_escopo_config (empresa_id, modo, capacidade_tipo, limite_festas_dia, intervalo_minimo_minutos, configurado_por)
                 VALUES ($1::uuid, 'FIXO', 'POR_HORARIO', NULL, 60, $2::uuid)`, [c.empresa, c.usuario]);
  const horario = (codigo: string, inicio: string, fim: string) => id(a, `INSERT INTO configuracao_agenda (codigo, nome, horario_inicio_padrao, horario_fim_padrao,
      tolerancia_inicio_minutos, passo_inicio_minutos, ordem_exibicao, empresa_id, capacidade) VALUES ($1, $1, $2, $3, 0, 30, 1, $4::uuid, 2) RETURNING id`,
    [codigo, inicio, fim, c.empresa]);
  const tarde = await horario("B19_TARDE_DOIS", "15:00", "19:00"), manha = await horario("B19_MANHA_DOIS", "08:00", "11:00");
  // Festa gravada e confirmada numa transação: os gatilhos diferidos conferem a agenda no COMMIT.
  const confirmada = async (cfg: string, inicio: string, fim: string) => {
    await a.query("BEGIN");
    try {
      const f = await id(a, `INSERT INTO fechamentos (data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, pacote_id, tabela_preco_id, preco_pacote_id,
            categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, valor_pacote_aplicado, valor_tabela, origem_fechamento, cliente_id, status)
          SELECT $1::date, $2::time, $3::time, $4::uuid, $5::uuid, p.id, pp.tabela_preco_id, pp.id, 'PADRAO', 'PADRAO', 10, 10, 100, 100, 100,
                 'ATENDIMENTO_KIDMAIS', NULL, 'AGUARDANDO_CONTRATO' FROM pacotes p JOIN precos_pacote pp ON pp.pacote_id = p.id WHERE p.id = $6::uuid RETURNING fechamentos.id`,
        [D, inicio, fim, cfg, c.empresa, c.pacote]);
      await a.query(`UPDATE fechamentos SET status = 'CONFIRMADO' WHERE id = $1::uuid`, [f]);
      await a.query("COMMIT");
      return f;
    } catch (error) {
      await a.query("ROLLBACK");
      throw error;
    }
  };
  await confirmada(tarde, "15:00", "19:00");
  await assert.rejects(confirmada(tarde, "15:00", "19:00"), /Conflito/, "segunda festa no mesmo horário recusada apesar da capacidade 2");
  await confirmada(manha, "08:00", "11:00");
  assert.equal((await a.query<{ n: number }>(`SELECT count(*)::int AS n FROM fechamentos WHERE empresa_id = $1::uuid AND status = 'CONFIRMADO'`, [c.empresa])).rows[0]!.n, 2);
});

test("B-19 (112): sem a 112, POST público com CNPJ = 409 PJ_INDISPONIVEL (MIGRACAO_PENDENTE) sem escrita; com CPF segue 201", async () => {
  assert.equal(await pessoaJuridicaDisponivel(tx), false);
  const c = await cenario(a, 0);
  const enviar = await rotaFechamentos(c, "SAVEPOINT");
  const pj = await respostaComEscritas(() => enviar(dia(172), { cpf: "", cnpj: "11222333000181", nomeCliente: "Escola Sintética B19 Ltda" }));
  assert.deepEqual([pj.valor.status, pj.valor.body.codigo, (pj.valor.body as { motivo?: string }).motivo ?? (pj.valor.body.detalhes as { motivo?: string } | undefined)?.motivo, pj.escritas],
    [409, "PJ_INDISPONIVEL", "MIGRACAO_PENDENTE", 0], JSON.stringify(pj.valor.body));
  const pf = await respostaComEscritas(() => enviar(dia(173)));
  console.log(`B-19 112: PJ ${pj.valor.status}/${String(pj.valor.body.codigo)} escritas=${pj.escritas}; PF ${pf.valor.status} escritas=${pf.escritas}`);
  assert.equal(pf.valor.status, 201, JSON.stringify(pf.valor.body));
  assert.ok(pf.escritas > 0, "controle: o caminho normal escreve (a medição enxerga escrita)");
});

test("B-19 (114): sem a 114 os gatilhos não verificam a trava; a guarda em TypeScript recusa sem a trava e passa com ela", async () => {
  const c = await cenario(a, 0);
  const sem = await recusaSemEscrita(() => exigirTravaConfiguracao(tx, c.empresa));
  assert.deepEqual(sem, { codigo: "TRAVA_CONFIGURACAO_AUSENTE:", escritas: 0 });
  await emTransacaoDesfeita(async () => {
    await assert.rejects(exigirTravaConfiguracao(tx, c.empresa), TravaConfiguracaoAusenteError);
  });
  await emTransacaoDesfeita(async () => {
    await travarConfiguracaoAgenda(tx, c.empresa, { modo: "COMPARTILHADA", linha: "KEY_SHARE" });
    await exigirTravaConfiguracao(tx, c.empresa);
  });
  const corpo = (await a.query<{ src: string }>(`SELECT prosrc AS src FROM pg_proc WHERE oid = to_regprocedure('public.kidmais019_lock_ocupacao()')`)).rows[0]?.src ?? "";
  assert.ok(corpo.length > 0 && !corpo.includes("kidmais114_exigir_configuracao"), "kidmais019_lock_ocupacao no corpo anterior à 114");
});

test("B-19 (116): sem a 116 a franquia segue o caminho legado mesmo com a chave ligada; pendência e avisos não escrevem", async () => {
  assert.equal(await franquiasInstaladas(tx), false);
  const c = await cenario(a, 0);
  const pend = await respostaComEscritas(() => registrarPendenciaFranquia(tx, c.empresa, randomUUID()));
  assert.deepEqual(pend, { valor: false, escritas: 0 }, "pendência não registrada, sem escrita");
  const avisos = await respostaComEscritas(() => avisosDeUsoFranquia(tx, c.empresa));
  assert.deepEqual(avisos, { valor: 0, escritas: 0 });
  assert.deepEqual(await processarPendenciasFranquia(porTransacao(a)), { processadas: 0, concedidas: 0, falhas: 0 });
  const ligada = await respostaComEscritas(() => franquiaDoMes(tx, c.empresa, { CREDITOS_FRANQUIA_PLANO_ATIVO: "true" }));
  const desligada = await respostaComEscritas(() => franquiaDoMes(tx, c.empresa, {}));
  console.log(`B-19 116: chave ligada=${JSON.stringify(ligada)} desligada=${JSON.stringify(desligada)}`);
  assert.equal(ligada.valor.porPlano, false, "chave ligada sem a 116: caminho legado");
  assert.deepEqual(ligada, desligada, "chave ligada = chave desligada (mesmo resultado e mesmas escritas)");
});

// ——— Rodada 2 (B19A-R1): consumidores reais da 116 ———
const SENHA_FALSA = `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`;
// Corte do legado num mês passado (a carteira CONVITES exige corte_em), como em franquias-116.postgres.test.ts.
const CORTE_LEGADO = "2026-01-15T12:00:00.000Z";
/** Fixture com os gatilhos desligados só nesta transação do cluster descartável (datas/estados sintéticos; CHECKs valem). */
async function fixtureReplica(f: () => Promise<unknown>) {
  await a.query("BEGIN");
  try { await a.query("SET LOCAL session_replication_role = replica"); await f(); await a.query("COMMIT"); }
  catch (e) { await a.query("ROLLBACK"); throw e; }
}
async function comitada<T>(w: (t: DbExecutor) => Promise<T>): Promise<T> {
  await a.query("BEGIN");
  try { const r = await w(tx); await a.query("COMMIT"); return r; }
  catch (e) { await a.query("ROLLBACK"); throw e; }
}
async function usuarioSintetico() {
  return id(a, `INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Gestão B-19', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id`,
    [`b19-${randomBytes(4).toString("hex")}@example.test`, SENHA_FALSA]);
}
async function empresaAtiva(prefixo: string) {
  const e = await id(a, `INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Buffet B-19 consumidores', 'PROVISIONAMENTO') RETURNING id`, [`${prefixo}${randomBytes(4).toString("hex")}`]);
  await a.query(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [e]);
  return e;
}
/** Empresa ATIVA, assinatura paga com contratação Premium CONFIRMADA no mês anterior, limite legado e carteira CONVITES. */
async function empresaComPlanoECorte(usuario: string, legado: number) {
  const e = await empresaAtiva("b19fq");
  await fixtureReplica(async () => {
    await a.query(`INSERT INTO empresa_assinaturas (empresa_id, situacao, teste_inicio, teste_fim) VALUES ($1::uuid, 'TESTE', clock_timestamp() - interval '80 days', clock_timestamp() - interval '65 days')`, [e]);
    await a.query(`UPDATE empresa_assinaturas SET situacao = 'ATIVA', ciclo = 'MENSAL', provedor = 'ASAAS', provedor_assinatura_id = $2, periodo_atual_fim = clock_timestamp() + interval '20 days'
      WHERE empresa_id = $1::uuid`, [e, `sub_${randomBytes(5).toString("hex")}`]);
    const quando = `(date_trunc('month', clock_timestamp() AT TIME ZONE 'America/Sao_Paulo') - interval '5 days' + interval '12 hours') AT TIME ZONE 'America/Sao_Paulo'`;
    const contratacao = await id(a, `INSERT INTO assinatura_contratacoes (empresa_id, chave_idempotencia, plano, ciclo, catalogo_versao, valor_regular_centavos, valor_final_centavos,
        criada_por, criada_em, estado, confirmada_em, pagamento_confirmacao_id, provedor_assinatura_id)
      VALUES ($1, $2, 'PREMIUM', 'MENSAL', 'sintetico', 9900, 9900, $3, ${quando} - interval '1 hour', 'CONFIRMADA', ${quando}, $4, $5) RETURNING id::text AS id`,
    [e, randomUUID(), usuario, `pay_${randomBytes(5).toString("hex")}`, `sub_${randomBytes(5).toString("hex")}`]);
    await a.query(`UPDATE empresa_assinaturas SET contratacao_atual_id = $2::uuid, plano = 'PREMIUM' WHERE empresa_id = $1::uuid`, [e, contratacao]);
  });
  await a.query(`INSERT INTO convite_carteiras (empresa_id, limite_mensal, ativo) VALUES ($1::uuid, $2, true)`, [e, legado]);
  await comitada((t) => abrirCarteira(t, e, "CONVITES", CORTE_LEGADO));
  return e;
}
const lotesConvites = async (e: string) => (await a.query<{ chave_origem: string; origem: string; quantidade: number }>(
  `SELECT chave_origem, origem, quantidade::int AS quantidade FROM ia_credito_lotes WHERE empresa_id = $1::uuid AND recurso = 'CONVITES' ORDER BY chave_origem`, [e])).rows;
const chaveDoMes = async () => `FRANQUIA:${(await a.query<{ m: string }>(`SELECT to_char(clock_timestamp() AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM') AS m`)).rows[0]!.m}`;

test("B-19 (116, consumidores): executor real do cron com a chave ligada concede pelo caminho legado; repetir não concede; nada da 116 é consultado", async () => {
  assert.equal(await franquiasInstaladas(tx), false);
  const usuario = await usuarioSintetico();
  const e = await empresaComPlanoECorte(usuario, 7);
  // Composição do script (scripts/creditos-manutencao.cjs, main): pendências da franquia primeiro (só com a chave), depois
  // executar() com manutencaoEmpresa, que lê process.env. A chave fica ligada SÓ neste processo de teste.
  const { executar } = createRequire(import.meta.url)("../../scripts/creditos-manutencao.cjs") as {
    executar: (o: { client: unknown; aplicar: boolean; manutencao: typeof manutencaoEmpresa; empresasComCarteira: typeof empresasComCarteira }) => Promise<Record<string, unknown>> };
  const listaReal = async (t: DbExecutor) => {
    const todas = await empresasComCarteira(t);
    assert.ok(todas.includes(e), "a empresa do cenário está na lista real do executor");
    return [e]; // só ela: as demais empresas de outros testes do mesmo banco não entram no relatório
  };
  const anterior = process.env.CREDITOS_FRANQUIA_PLANO_ATIVO;
  process.env.CREDITOS_FRANQUIA_PLANO_ATIVO = "true";
  try {
    assert.deepEqual(await processarPendenciasFranquia(porTransacao(a)), { processadas: 0, concedidas: 0, falhas: 0 }, "fila de pendências vazia sem a 116");
    const r1 = await executar({ client: a, aplicar: true, manutencao: manutencaoEmpresa, empresasComCarteira: listaReal });
    console.log(`B-19 116 executor: 1ª=${JSON.stringify(r1)}`);
    assert.deepEqual(r1, { modo: "APLICAR", empresas: 1, falhas: 0, expirados: 0, franquias: 1, avisos: 0 }, "concessão legada pelo executor");
    assert.deepEqual(await lotesConvites(e), [{ chave_origem: await chaveDoMes(), origem: "FRANQUIA", quantidade: 7 }], "lote = limite legado (convite_carteiras), não a tabela do plano");
    const r2 = await executar({ client: a, aplicar: true, manutencao: manutencaoEmpresa, empresasComCarteira: listaReal });
    assert.deepEqual(r2, { modo: "APLICAR", empresas: 1, falhas: 0, expirados: 0, franquias: 0, avisos: 0 }, "repetição idempotente");
    assert.equal((await lotesConvites(e)).length, 1, "nenhum lote novo na repetição");
    const direto = await respostaComEscritas(() => manutencaoEmpresa(tx, e, { CREDITOS_FRANQUIA_PLANO_ATIVO: "true" }));
    assert.deepEqual(direto.valor.franquia, { concedida: false, motivo: "JA_CONCEDIDA", porPlano: false }, "manutenção direta: já concedida, caminho legado");
    assert.equal(direto.valor.avisos, 0, "sem avisos de uso (porPlano falso)");
  } finally {
    if (anterior === undefined) delete process.env.CREDITOS_FRANQUIA_PLANO_ATIVO; else process.env.CREDITOS_FRANQUIA_PLANO_ATIVO = anterior;
  }
  assert.equal(await existe("tabela", "ia_credito_franquias_ciclo"), false, "nenhum objeto da 116 criado");
});

test("B-19 (116, consumidores): sincronização REAL chega à pendência e commita; pendência direta não invalida a transação", async () => {
  const usuario = await usuarioSintetico();
  // Transação com escrita anterior (no lugar da troca de contratação): pendência devolve false e a transação segue.
  const x = await empresaComPlanoECorte(usuario, 3);
  const dedupe = `LOTE_VENCENDO_7:${x}:b19`;
  const r = await comitada(async (t) => {
    await t.query(`INSERT INTO ia_credito_notificacoes (empresa_id, tipo, dedupe) VALUES ($1::uuid, 'LOTE_VENCENDO_7', $2)`, [x, dedupe]);
    const criada = await registrarPendenciaFranquia(t, x, randomUUID());
    return { criada, ok: (await t.query<{ ok: number }>("SELECT 1 AS ok")).rows[0]!.ok };
  });
  assert.deepEqual(r, { criada: false, ok: 1 });
  assert.equal((await a.query<{ n: number }>(`SELECT count(*)::int AS n FROM ia_credito_notificacoes WHERE dedupe = $1`, [dedupe])).rows[0]!.n, 1, "escrita anterior commitada");

  // Sincronização real (lib/assinatura/sincronizacao.ts), provedor FALSO pago hoje, como franquias-116 (cenário 8).
  const doc = (() => {
    const base = `8${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}0001`;
    const dv = (b: string) => { let s = 0, p = 2; for (let i = b.length - 1; i >= 0; i--) { s += (b.charCodeAt(i) - 48) * p; p = p === 9 ? 2 : p + 1; } const k = s % 11; return k <= 1 ? 0 : 11 - k; };
    const d1 = dv(base); return base + d1 + dv(base + d1);
  })();
  const e = await empresaAtiva("b19sy");
  await a.query(`INSERT INTO plataforma_empresas_cadastro (empresa_id, nome_empresarial, documento_fiscal, responsavel_nome, email, criado_por, atualizado_por)
    VALUES ($1, 'Festas B-19 Ltda', $2, 'Responsável', $3, $4, $4)`, [e, doc, `b19-${randomBytes(3).toString("hex")}@example.test`, usuario]);
  await comitada((t) => iniciarTeste(t as never, { empresaId: e, documento: doc }));
  await comitada((t) => abrirCarteira(t, e, "CONVITES", CORTE_LEGADO));
  const ENV_PLANOS = { ASSINATURA_PLANOS_ATIVOS: "true", ASAAS_AMBIENTE: "sandbox" };
  const documentos = Object.fromEntries(Object.values(DOCUMENTOS).map((d) => [d.documento, { versao: d.versao, hash: hashDocumento(d) }]));
  const pedido = (valor: number) => ({ plano: "premium" as const, ciclo: "MENSAL" as const, valorEsperadoCentavos: valor, versao: "2026-10-20", documentos });
  const oferta = await comitada((t) => prepararOferta(t, e, usuario, pedido(valorComercial("premium", "mensal", true)), ENV_PLANOS))
    .catch(() => comitada((t) => prepararOferta(t, e, usuario, pedido(valorComercial("premium", "mensal", false)), ENV_PLANOS)));
  const hoje = (await a.query<{ d: string }>(`SELECT to_char(clock_timestamp() AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS d`)).rows[0]!.d;
  const sufixo = randomBytes(4).toString("hex");
  const sub: AssinaturaProvedor = { id: `sub_${sufixo}`, customer: `cus_${sufixo}`, externalReference: e, cycle: "MONTHLY", status: "ACTIVE", deleted: false, valorCentavos: oferta.valor_final_centavos };
  const pay = { id: `pay_${sufixo}`, status: "RECEIVED", dueDate: hoje, paymentDate: hoje, deleted: false, invoiceUrl: null, valorCentavos: oferta.valor_final_centavos,
    assinaturaId: sub.id, clienteId: sub.customer, billingType: "PIX" } as CobrancaProvedor;
  const provedor = {
    async obterAssinatura(s: string) { return s === sub.id ? { ...sub } : null; },
    async listarCobrancasDaAssinatura(s: string) { return s === sub.id ? [{ ...pay }] : []; },
    async listarAssinaturasPorReferencia(ref: string) { return ref === e ? [{ ...sub }] : []; },
  };
  await a.query(`UPDATE empresa_assinaturas SET provedor = 'ASAAS', provedor_cliente_id = $2, provedor_assinatura_id = $3 WHERE empresa_id = $1`, [e, sub.customer, sub.id]);
  const s = await comitada((t) => sincronizarEmpresa(t as never, e, { provedor: provedor as never }, { tipo: "RECONCILIACAO" }));
  console.log(`B-19 116 sincronização: ${JSON.stringify(s)}`);
  assert.equal(s.resultado === "SINCRONIZADA" && s.depois, "ATIVA", "a sincronização real termina");
  assert.deepEqual((await a.query<{ atual: string; situacao: string }>(`SELECT contratacao_atual_id::text AS atual, situacao FROM empresa_assinaturas WHERE empresa_id = $1::uuid`, [e])).rows,
    [{ atual: oferta.id, situacao: "ATIVA" }], "contratação nova COMMITADA (a pendência sem a 116 não invalidou a transação)");
  assert.deepEqual(await lotesConvites(e), [], "a sincronização não credita");
  assert.deepEqual(await processarPendenciasFranquia(porTransacao(a)), { processadas: 0, concedidas: 0, falhas: 0 });
  assert.equal(await existe("tabela", "ia_credito_franquia_pendencias"), false, "nenhum objeto da 116 criado");
});

// ——— Rodada 2 (B19A-R1): consumidores reais da 117 ———
test("B-19 (117, consumidores): chave ligada sem a 117 — piloto opera; não piloto recusada; status, limpeza e worker sem colisões nem rodízio", { timeout: 300_000 }, async () => {
  const CHAVE = "WHATSAPP_ATENDIMENTO_MULTIEMPRESA";
  const ENV_CRED = { WHATSAPP_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"), WHATSAPP_CREDENTIAL_KEY_VERSION: "1", META_GRAPH_API_VERSION: "v23.0" };
  const salvo = Object.fromEntries([CHAVE, ...Object.keys(ENV_CRED)].map((k) => [k, process.env[k]]));
  Object.assign(process.env, ENV_CRED, { [CHAVE]: "true" });
  try {
    assert.deepEqual(await multiempresa.tabelas117(executor(a)), { rodizio: false, colisoes: false }, "117 ausente");
    assert.equal(await multiempresa.modoEfetivo(executor(a)), "PILOTO", "chave ligada sem as tabelas: PILOTO");
    const APP = "1622943079270352", NEGOCIO = "1591095999057604";
    const A = await empresaAtiva("b19wa"), B = await empresaAtiva("b19wb");
    const nomes = new Map([[A, "A"], [B, "B"]]);
    const sessao = async (e: string) => {
      const u = await usuarioSintetico();
      const m = await id(a, `INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1::uuid, $2::uuid, 'PENDENTE', clock_timestamp(), 'REPRESENTANTE_AUTORIZADO') RETURNING id`, [e, u]);
      await a.query(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`, [m]);
      const s = await id(a, `INSERT INTO sessoes_administrativas (usuario_id, token_hash, csrf_hash, autenticado_em, ultima_atividade_em, expira_em, empresa_ativa_id)
        VALUES ($1::uuid, $2, $3, clock_timestamp(), clock_timestamp(), clock_timestamp() + interval '1 hour', $4::uuid) RETURNING id`, [u, randomBytes(32).toString("hex"), randomBytes(32).toString("hex"), e]);
      return { usuario_id: u, papel: "REPRESENTANTE_AUTORIZADO", id: s, empresa_ativa_id: e, autenticado_em: new Date().toISOString() } as never as { usuario_id: string };
    };
    const sA = await sessao(A), sB = await sessao(B);
    const autor = sA.usuario_id;
    const numero = (e: string) => (e === A ? "3190000001" : "3190000002");
    const waba = (e: string) => (e === A ? "2190000001" : "2190000002");
    for (const e of [A, B]) {
      const cifra = credencialWhatsapp.cifrarCredencialWhatsapp(`token-sintetico-${numero(e)}`, { ambiente: "STAGING", appId: APP, businessId: NEGOCIO, wabaId: waba(e), phoneNumberId: numero(e), empresaId: e });
      await a.query(`WITH instante AS (SELECT clock_timestamp() AS agora)
        INSERT INTO whatsapp_conexoes(ambiente,empresa_id,meta_app_id,business_id,waba_id,phone_number_id,numero_exibicao,nome_verificado,coexistencia_confirmada,status,escopos,credencial_cifrada,credencial_iv,credencial_tag,credencial_chave_versao,token_tipo,token_expira_em,meta_validada_em,criada_por_usuario_id,sessao_referencia_id,criada_em,atualizada_em)
        SELECT 'STAGING',$1::uuid,$2,$3,$4,$5,'+55 61 90000-0000','Buffet sintético',true,'CONFIGURADA',ARRAY['whatsapp_business_messaging'],$6,$7,$8,$9,'bearer',NULL,agora,$10::uuid,$11::uuid,agora,agora FROM instante`,
      [e, APP, NEGOCIO, waba(e), numero(e), cifra.ciphertext, cifra.iv, cifra.tag, cifra.keyVersion, autor, randomUUID()]);
    }
    // B isenta (C4 = SIM no MULTI): a recusa observada vem só do modo efetivo PILOTO.
    await a.query(`INSERT INTO assinatura_isencoes (empresa_id, documento_verificado, motivo, concedida_por) VALUES ($1, $2, 'Isenção sintética B-19', $3)`,
      [B, `${String(Math.floor(Math.random() * 1e10)).padStart(12, "0")}00`, autor]);

    const { servico, worker } = carregarAtendimento(A);
    const configuracao = { ...configuracaoAtendimentoReal, ambienteAtendimento: () => "staging", empresaPiloto: () => A };
    const meta = carregarComponente("lib/whatsapp/atendimento/meta.ts", {
      "../../db/postgres.ts": { db: dbAtendimento, withTransaction: transacaoAtendimento }, "../credencial.ts": credencialWhatsapp, "./configuracao.ts": configuracao, "./core.ts": coreAtendimento,
      "./service.ts": servico, "./transporte.ts": transporteSemRede, "./multiempresa.ts": multiempresa,
    }).modulo as typeof import("../whatsapp/atendimento/meta.ts");
    const gupshup: string[] = [], graph: string[] = [], alvos: { empresa: string; piloto: boolean }[] = [];
    const buscar = (async (url: string) => { graph.push(String(url)); return new Response(JSON.stringify({ messages: [{ id: codAtendimento("wamid.") }] }), { status: 200 }); }) as unknown as typeof fetch;
    const deps = {
      interpretar: null,
      enviar: (contato: string, conteudo: ConteudoSaida, alvo?: AlvoEnvio) => {
        alvos.push({ empresa: nomes.get(alvo!.empresaId) ?? "?", piloto: alvo!.piloto });
        return meta.enviarPelaEmpresa(contato, conteudo, { alvo, buscar, gupshup: async (contatoG: string) => { gupshup.push(contatoG); return codAtendimento("gs-"); } });
      },
    };
    const entrada = (e: string, contato: string) => ({ phoneNumberId: numero(e), wabaId: waba(e), id: codAtendimento("wamid.in."), contato, texto: "Oi, quero orçamento", timestamp: Date.now(), nomePerfil: "Cliente Sintético" });
    const status = (e: string, provedorId: string, tipo: "delivered" | "read" | "failed") => ({ phoneNumberId: numero(e), wabaId: waba(e), id: provedorId, tipo });
    const receber = (...lista: ReturnType<typeof entrada>[]) => meta.receberEventosMeta({ entradas: lista, status: [] }, { automacaoGlobal: true });
    const statusDe = (...lista: ReturnType<typeof status>[]) => meta.receberEventosMeta({ entradas: [], status: lista }, { automacaoGlobal: true });
    const conta = async (sql: string, v: unknown[] = []) => Number((await a.query<{ n: string }>(sql, v)).rows[0]!.n);
    const entradasDe = (e: string) => conta("SELECT count(*) AS n FROM whatsapp_atendimento_mensagens WHERE empresa_id=$1 AND direcao='ENTRADA'", [e]);
    const configDe = (e: string) => conta("SELECT count(*) AS n FROM whatsapp_atendimento_config WHERE empresa_id=$1", [e]);
    const conversa = async (e: string) => (await a.query<{ id: string; versao: number }>(`INSERT INTO whatsapp_atendimento_conversas(empresa_id,ambiente,contato,ultima_entrada_em,estado)
      VALUES($1,'staging',$2,clock_timestamp(),'AGUARDANDO_HUMANO') RETURNING id,versao`, [e, `55619${randomBytes(4).readUInt32BE() % 100000000}`.padEnd(13, "0")])).rows[0]!;
    const saida = async (e: string, provedorId: string) => {
      const cv = await conversa(e);
      return id(a, `INSERT INTO whatsapp_atendimento_mensagens(conversa_id,empresa_id,ambiente,direcao,texto,estado,versao_conversa,autor_usuario_id,provedor_id)
        VALUES($1,$2,'staging','SAIDA','Resposta sintética','SUBMETIDA',$3,$4,$5) RETURNING id`, [cv.id, e, cv.versao, autor, provedorId]);
    };
    const estadoDe = async (m: string) => (await a.query<{ estado: string }>("SELECT estado FROM whatsapp_atendimento_mensagens WHERE id=$1", [m])).rows[0]!.estado;
    const buffer = (p: string) => conta("SELECT count(*) AS n FROM whatsapp_atendimento_status WHERE provedor_id=$1", [p]);
    const config = (ativo: boolean) => ({ ativo, nome: "Buffet sintético", perguntas: [], limites: { respostasPor24h: 20 } });

    // Configuração (F4): piloto liga; não piloto não liga NEM configura desligada (escrita só no MULTI efetivo).
    await servico.salvarConfiguracao(sA as never, config(true));
    await assert.rejects(servico.salvarConfiguracao(sB as never, config(true)), /ATENDIMENTO_RECURSO_NAO_INCLUIDO/, "B não liga no PILOTO efetivo");
    await assert.rejects(servico.salvarConfiguracao(sB as never, config(false)), /ATENDIMENTO_RECURSO_NAO_INCLUIDO/, "B não configura nada no PILOTO efetivo");
    assert.deepEqual([await configDe(A), await configDe(B)], [1, 0], "só a piloto tem configuração gravada");
    // Tela: cada empresa lê a própria; B vê a automação indisponível.
    const telaB = await servico.listarAtendimento(sB as never);
    assert.deepEqual([telaB.conversas.length, telaB.automacaoDisponivel], [0, false], "B lê a própria tela, sem automação");
    assert.equal((await servico.listarAtendimento(sA as never)).automacaoDisponivel, true, "a piloto opera");
    // Recepção: piloto grava PENDENTE; B confirma sem gravar.
    await receber(entrada(A, "5561900019001"), entrada(B, "5561900019002"));
    assert.deepEqual([await entradasDe(A), await entradasDe(B)], [1, 0], "recepção: piloto grava; B confirma sem gravar");
    // Pendência antiga de B (de quando era MULTI, sintética): o worker no PILOTO não a toca nem consulta o rodízio.
    const cvB = await conversa(B);
    const pendB = await id(a, `INSERT INTO whatsapp_atendimento_mensagens(conversa_id,empresa_id,ambiente,externa_id,direcao,texto,estado,versao_conversa,criada_em)
      VALUES($1,$2,'staging',$3,'ENTRADA','Oi (pendente de B)','PENDENTE',$4,clock_timestamp() - interval '1 minute') RETURNING id`, [cvB.id, B, codAtendimento("wamid.in.b."), cvB.versao]);
    // Status: duplicado entre A e B → nada aplicado, nada no buffer, sem consultar a tabela de colisões; único de A → aplicado.
    const dupA = await saida(A, "wamid.B19DUP"), dupB = await saida(B, "wamid.B19DUP");
    await statusDe(status(A, "wamid.B19DUP", "failed"));
    assert.deepEqual([await estadoDe(dupA), await estadoDe(dupB), await buffer("wamid.B19DUP")], ["SUBMETIDA", "SUBMETIDA", 0], "duplicado: nada aplicado, nada no buffer, nenhum erro");
    const unicoA = await saida(A, "wamid.B19UNI");
    await statusDe(status(A, "wamid.B19UNI", "delivered"));
    assert.equal(await estadoDe(unicoA), "ENTREGUE", "status único da piloto aplicado");
    // Limpeza (status + colisões) sem a tabela de colisões.
    await servico.limparStatusExpirados();
    // Worker: lote no PILOTO, só a piloto reservada/enviada (Gupshup espionado; nenhuma rede).
    const lote = await worker.processarLote(deps, { maxTarefas: 10 });
    console.log(`B-19 117 consumidores: lote=${JSON.stringify(lote)} alvos=${JSON.stringify(alvos)} gupshup=${gupshup.length} graph=${graph.length}`);
    assert.ok(lote.tarefas >= 1, "a piloto é processada");
    assert.ok(alvos.length >= 1 && alvos.every((x) => x.empresa === "A" && x.piloto), "só a piloto é reservada/enviada");
    assert.deepEqual([gupshup.length, graph.length], [alvos.length, 0], "envio da piloto pelo Gupshup; nenhuma chamada Graph de B");
    assert.equal(await estadoDe(pendB), "PENDENTE", "pendência de B preservada (sem rodízio)");
    assert.deepEqual(await multiempresa.tabelas117(executor(a)), { rodizio: false, colisoes: false }, "nenhum objeto da 117 criado");
  } finally {
    for (const [k, v] of Object.entries(salvo)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test("B-19 (117): sem a 117 o atendimento fica no modo PILOTO mesmo com a chave multiempresa ligada", async () => {
  await emTransacaoDesfeita(async () => {
    assert.equal(await modoEfetivo(tx, { WHATSAPP_ATENDIMENTO_MULTIEMPRESA: "true" } as unknown as NodeJS.ProcessEnv), "PILOTO");
    assert.equal(await colisoesDisponivel(tx), false);
  });
  await emTransacaoDesfeita(async () => {
    assert.equal(await modoEfetivo(tx, {} as unknown as NodeJS.ProcessEnv), "PILOTO");
  });
});

test("B-19 (118): envio de documento com CONTRACT_IMPORT ligado = 503 COTA_INDISPONIVEL sem a 118 (antes de gravar e de ler); com a 118 lê e consome", async () => {
  // Camada de IA carregada pelo suporte de integração (mesmo padrão de importacao-v3-desistir.postgres.test.ts):
  // a regra 10 de lib/inteligencia/arquitetura.test.ts proíbe import estático da IA fora das camadas de IA.
  type Upload = typeof import("../inteligencia/documentos/upload.ts");
  type Extrair = typeof import("../inteligencia/documentos/extrair.ts");
  type LeitorPdf = import("../inteligencia/documentos/extrair.ts").LeitorPdf;
  type PortaDocumentos = import("../inteligencia/documentos/upload.ts").PortaDocumentos;
  type DependenciasDocumento = import("../inteligencia/documentos/upload.ts").DependenciasDocumento;
  const { atenderDocumento } = carregar<Upload>("lib/inteligencia/documentos/upload.ts");
  const { lerPdfEmProcesso } = carregar<Extrair>("lib/inteligencia/documentos/extrair.ts");
  const { LINHAS, pdf } = carregar<typeof import("../inteligencia/documentos/apoio.test.ts")>("lib/inteligencia/documentos/apoio.test.ts");
  const c = await cenario(a, 0);
  const leituras = { n: 0 };
  const lerPdf: LeitorPdf = async (bytes, o) => { leituras.n += 1; return lerPdfEmProcesso(bytes, o); };
  const porta: PortaDocumentos = {
    disponivel: documentosDisponiveis, registrarDocumento, registrarExtracao, ultimaExtracao,
    cota: { instalada: cotaInstalada, reservar: reservarCota, concluir: concluirCota, liberar: liberarCota },
  };
  const sessao: SessaoParaTenant = { usuario_id: c.usuario, papel: "ADMINISTRATIVO" };
  const comSavepoint = porSavepoint(a);
  const enviar = (env: Record<string, string>) => {
    const deps: DependenciasDocumento = {
      env, autenticar: async () => sessao,
      withTenantTransaction: (s, empresa, work) => comSavepoint((t) => executarNoTenant(t, s, empresa, work)),
      agora: () => new Date(), requestId: randomUUID, registrar: () => {}, relogio: () => 0,
      documentos: porta, roteador: null, lerPdf,
    } as DependenciasDocumento;
    return atenderDocumento({ empresaSolicitada: c.empresa, lerArquivo: async () => ({ nome: "contrato.pdf", tipo: "application/pdf", bytes: pdf(LINHAS) }) }, deps);
  };
  const resumo = (r: { valor: { status: number; corpo: unknown }; escritas: number }) =>
    ({ status: r.valor.status, codigo: (r.valor.corpo as { codigo?: string }).codigo ?? "OK", escritas: r.escritas });
  const LIGADO = { INTELIGENCIA_ENABLED: "true", AI_CONTRACT_IMPORT_ENABLED: "true" };
  const PRODUCTION = "srv-dak77m2d0e5s73b8rkkg";

  const desligado = resumo(await respostaComEscritas(() => enviar({ INTELIGENCIA_ENABLED: "true", AI_CONTRACT_IMPORT_ENABLED: "false" })));
  assert.equal(desligado.escritas, 0, "CONTRACT_IMPORT desligado: nada escrito");
  assert.notEqual(desligado.codigo, "OK", "CONTRACT_IMPORT desligado: recusa pela flag");
  assert.notEqual(desligado.codigo, "COTA_INDISPONIVEL", "a flag recusa antes da cota");
  assert.equal(leituras.n, 0, "CONTRACT_IMPORT desligado: nada lido");
  const dispensaCopiada = resumo(await respostaComEscritas(() => enviar({ ...LIGADO, RENDER: "true", RENDER_SERVICE_ID: PRODUCTION, IMPORTACAO_COTA_DISPENSADA: PRODUCTION,
    KIDMAIS_DEPLOY_ENV: "production" })));
  const ligado = resumo(await respostaComEscritas(() => enviar(LIGADO)));
  console.log(`B-19 118 (${com118 ? "com" : "sem"} a 118): desligado=${JSON.stringify(desligado)} ligado=${JSON.stringify(ligado)} dispensaCopiada=${JSON.stringify(dispensaCopiada)} leituras=${leituras.n}`);
  if (!com118) {
    assert.deepEqual(ligado, { status: 503, codigo: "COTA_INDISPONIVEL", escritas: 0 }, "sem a 118: recusa antes de gravar o documento");
    assert.deepEqual(dispensaCopiada, { status: 503, codigo: "COTA_INDISPONIVEL", escritas: 0 }, "dispensa copiada para o serviço de production não vale");
    assert.equal(leituras.n, 0, "sem a 118: nada lido");
  } else {
    assert.deepEqual([ligado.status, ligado.codigo], [200, "OK"], "com a 118: leitura normal");
    assert.ok(ligado.escritas > 0, "com a 118: documento e cota gravados (desfeitos no fim)");
    assert.deepEqual([dispensaCopiada.status, dispensaCopiada.codigo], [200, "OK"], "com a 118 a cota vale, com ou sem dispensa");
    assert.equal(leituras.n, 2, "com a 118: lido uma vez por envio");
    await emTransacaoDesfeita(async () => {
      const r = await enviar(LIGADO);
      assert.equal(r.status, 200, JSON.stringify(r.corpo));
      const usos = (await a.query<{ estado: string }>(`SELECT estado FROM ia_importacao_usos WHERE empresa_id = $1::uuid`, [c.empresa])).rows.map((x) => x.estado);
      assert.deepEqual(usos, ["CONSUMIDA"], "a leitura consumiu um uso da cota");
    });
  }
});

test("B-19 (L2, B-25): com KIDMAIS_DEPLOY_ENV=production a trava de cobrança recusa 503 COBRANCA_TRAVADA na transação, sem escrita; local abre", async () => {
  const banco = (await a.query<{ b: string }>("SELECT current_database() AS b")).rows[0]!.b;
  // Rodada 2 (B19A-R3): a recusa é medida num INICIADOR que escreve logo depois da trava, como os pontos comerciais reais
  // (a trava é o primeiro passo da transação). Uma trava que abrisse para o sinal isolado de production apareceria aqui como
  // SEM_RECUSA com escrita, antes de qualquer asserção de diagnóstico do motivo.
  const c = await cenario(a, 0);
  const iniciador = (env: Record<string, string>) => async () => {
    await exigirCobrancaDestravada(tx, "B-19", env);
    await a.query(`UPDATE empresas SET nome = nome WHERE id = $1::uuid`, [c.empresa]);
  };
  const recusa = await recusaSemEscrita(iniciador({ KIDMAIS_DEPLOY_ENV: "production" }));
  assert.deepEqual(recusa, { codigo: "COBRANCA_TRAVADA:503", escritas: 0 }, "sinal isolado de production: recusa e nenhuma escrita depois da trava");
  const aberta = await recusaSemEscrita(iniciador({}));
  assert.equal(aberta.codigo, "SEM_RECUSA", "controle: execução local abre a trava");
  assert.ok(aberta.escritas > 0, "controle: o iniciador aberto escreve (a medição enxerga a escrita)");
  // Controle do observador (parecer §3): escrita desfeita por ROLLBACK TO SAVEPOINT antes da MESMA recusa continua contada.
  const desfeita = await recusaSemEscrita(async () => {
    await a.query("SAVEPOINT b19_observador");
    await a.query(`UPDATE empresas SET nome = nome WHERE id = $1::uuid`, [c.empresa]);
    await a.query("ROLLBACK TO SAVEPOINT b19_observador");
    await exigirCobrancaDestravada(tx, "B-19", { KIDMAIS_DEPLOY_ENV: "production" });
  });
  console.log(`B-19 L2: recusa=${JSON.stringify(recusa)} aberta=${JSON.stringify(aberta)} desfeitaAntesDaRecusa=${JSON.stringify(desfeita)}`);
  assert.equal(desfeita.codigo, "COBRANCA_TRAVADA:503");
  assert.ok(desfeita.escritas > 0, "controle: escrita em subtransação desfeita antes da recusa é contada (o observador não a esconde)");
  // Diagnóstico do motivo (o M21 da rodada 1 morre aqui: troca o motivo, não abre a trava).
  assert.deepEqual(decidirTravaCobranca({ KIDMAIS_DEPLOY_ENV: "production" }, banco), { aberta: false, motivo: "DEPLOY_PRODUCTION" });
  const contraditorio = await recusaSemEscrita(() => exigirCobrancaDestravada(tx, "B-19", { KIDMAIS_DEPLOY_ENV: "staging", RENDER: "true", RENDER_SERVICE_ID: "srv-dak77m2d0e5s73b8rkkg" }));
  assert.deepEqual(contraditorio, { codigo: "COBRANCA_TRAVADA:503", escritas: 0 }, "serviço de production rotulado staging fecha");
  await emTransacaoDesfeita(async () => {
    assert.equal(await cobrancaDestravada(tx, "B-19", {}), true, "execução local abre");
  });
});
