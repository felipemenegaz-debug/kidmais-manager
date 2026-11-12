import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { Client } from "pg";
import type { DbExecutor } from "../../db/contracts.ts";
import { conectarDescartavel, encerrarDescartavel } from "../../comercial/postgres-descartavel.ts";
import { salvarPacoteComercial } from "../../comercial/pacote-comercial.ts";
import { listarPacotesContrataveisDaEmpresa } from "../../comercial/repositories/comercial.repository.ts";
import { ehDonaDaConfigLegada } from "../../disponibilidade/config-legada.ts";
import { erroConvidadosEmpresa, erroConvidadosFechamento } from "../../fechamentos/convidados.ts";
import { carregarModulo } from "../../acessos/teste-carregador.ts";
import { resolverPacote, validarContratacao, verificarContratacao, type PortaContratacao } from "./contratacao.ts";

/**
 * Fase 1d (IA) no PostgreSQL DESCARTÁVEL (modelo 089): a preparação de contratação resolve o pacote contra os pacotes
 * REAIS da empresa comprovada. A porta usa os mesmos serviços de domínio da composition root
 * (app/api/admin/inteligencia/operacoes/composicao.ts — o teste de arquitetura exige essas chamadas lá).
 *
 *  I1 buffet comum: "festa jardim" (nome) e o código P_ resolvem para o pacote "Novo pacote" dele; o payload da revisão
 *     leva o código e o valor de tabela do serviço comercial; outro buffet não alcança o pacote;
 *  I2 dona (kidmais, 046): só os sete ids V1 — nome ou código livre recusados; Pizza Party sob consulta.
 *
 * Só pelo check:v1:postgres com opt-in. Dados sintéticos; nenhuma rede, nenhum modelo.
 */
const SENHA = `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`;
const sufixo = randomBytes(3).toString("hex");
const cod = (p: string) => `${p}${randomBytes(4).toString("hex")}`;
let client: Client;
let tx: DbExecutor;
let turnos: string[];
let porta: PortaContratacao;
let fechamentoPublico: (input: Record<string, unknown>, db: DbExecutor) => Promise<{ fechamento: { clienteId: string } }>;

function cpfValido() {
  const base = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  if (base.every((d) => d === base[0])) base[8] = (base[0] + 1) % 10;
  const dv = (n: number[]) => { const s = n.reduce((t, d, i) => t + d * (n.length + 1 - i), 0) % 11; return s < 2 ? 0 : 11 - s; };
  const d1 = dv(base);
  return [...base, d1, dv([...base, d1])].join("");
}
async function emTransacao<T>(fn: () => Promise<T>) {
  await client.query("BEGIN");
  try { const r = await fn(); await client.query("COMMIT"); return r; } catch (erro) { await client.query("ROLLBACK"); throw erro; }
}
async function empresa(nome: string) {
  const id = async (sql: string, v: unknown[]) => (await client.query<{ id: string }>(sql, v)).rows[0].id;
  const e = await id(`INSERT INTO empresas (codigo, nome, status) VALUES ($1, $2, 'PROVISIONAMENTO') RETURNING id::text AS id`, [`p1d${nome}${sufixo}`.toLowerCase(), `Buffet 1d ${nome}`]);
  await client.query(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [e]);
  const u = await id(`INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Harness 1d', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id::text AS id`, [`${cod("u")}@example.test`, SENHA]);
  const m = await id(`INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1::uuid, $2::uuid, 'PENDENTE', clock_timestamp(), 'REPRESENTANTE_AUTORIZADO') RETURNING id::text AS id`, [e, u]);
  await client.query(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`, [m]);
  return { empresa: e, usuario: u };
}
const todosOsDias = () => [1, 2, 3, 4, 5, 6, 7].flatMap((dia) => turnos.map((horarioId) => ({ dia, horarioId })));

const pular = () => process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel";

test.before(async () => {
  if (pular()) return;
  client = await conectarDescartavel();
  tx = { async query<Row extends object>(text: string, values?: readonly unknown[]) {
    const r = await client.query(text, values as unknown[]);
    return { rows: r.rows as Row[], rowCount: r.rowCount };
  } };
  const dubles = { "db/postgres": { db: () => tx, withTransaction: async <T>(fn: (t: DbExecutor) => Promise<T>) => fn(tx) } };
  const cache = new Map();
  const preco = carregarModulo("lib/comercial/services/pricing.service.ts", dubles, cache) as { calcularResumoComercial: (i: Record<string, unknown>, d: DbExecutor) => Promise<{ pacote: { valorTabelaAplicado: number } }> };
  const admin = carregarModulo("lib/fechamentos/services/fechamento-administrativo.service.ts", dubles, cache) as { clienteParaPreparacao: (id: string, empresaId: string, d: DbExecutor) => ReturnType<PortaContratacao["cliente"]> };
  const clientes = carregarModulo("lib/clientes/services/index.ts", dubles, cache) as { buscarClientesCrm: (t: string, e: string, l: number, i: boolean, d: DbExecutor) => Promise<Array<{ cliente: { id: string; nomeCompleto: string; status: string } }>> };
  fechamentoPublico = (carregarModulo("lib/fechamentos/services/fechamento-publico.service.ts", dubles, cache) as { criarFechamentoPublicoComIdentidade: typeof fechamentoPublico }).criarFechamentoPublicoComIdentidade;
  // Mesmas leituras da composition root (portaContratacao), sem o roteamento HTTP.
  porta = {
    async buscarClientes(t, empresaId, termo) {
      return (await clientes.buscarClientesCrm(termo, empresaId, 6, false, t)).map(({ cliente }) => ({ id: cliente.id, nome: cliente.nomeCompleto, ativo: String(cliente.status) === "ATIVO" }));
    },
    cliente: (t, empresaId, clienteId) => admin.clienteParaPreparacao(clienteId, empresaId, t),
    async pacote(t, empresaId, codigo) {
      const p = (await listarPacotesContrataveisDaEmpresa(empresaId, t)).find((x) => x.codigo === codigo);
      return p ? { id: p.id, nome: p.nome, minimo: p.convidadosMinimos, maximo: p.convidadosMaximos } : null;
    },
    pacotes: async (t, empresaId) => (await listarPacotesContrataveisDaEmpresa(empresaId, t)).map((p) => ({ codigo: p.codigo, nome: p.nome })),
    dona: (t, empresaId) => ehDonaDaConfigLegada(t, empresaId),
    erroConvidados: (codigo, p, n, dona) => dona
      ? erroConvidadosFechamento(n, { id: codigo, nome: p.nome, minPagantes: p.minimo ?? 1, maxPagantes: p.maximo ?? 150 })
      : erroConvidadosEmpresa(n, { nome: p.nome, minPagantes: p.minimo ?? 1, maxPagantes: p.maximo ?? 150, limiteCadastrado: p.maximo !== null }),
    horarios: async () => ({ configuracaoId: turnos[0], horarios: [{ inicio: "11:00", fim: "15:00" }] }),
    async precoTabela(t, empresaId, e) {
      try {
        const r = await preco.calcularResumoComercial({ ...e, adicionais: [], empresaEsperada: empresaId }, t);
        return Math.round(Number(r.pacote.valorTabelaAplicado) * 100);
      } catch { return null; }
    },
  };
});
test.after(async () => { if (client) await encerrarDescartavel(client); });

test("I1/I2: a IA resolve o pacote contra os pacotes reais da empresa; a dona continua com os sete", { timeout: 300_000 }, async (t) => {
  if (pular()) { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  turnos = (await client.query<{ id: string }>(`SELECT id::text AS id FROM configuracao_agenda WHERE codigo IN ('TURNO_1', 'TURNO_2') AND ativo ORDER BY codigo`)).rows.map((r) => r.id);
  const kidmais = (await client.query<{ id: string }>(`SELECT id::text AS id FROM empresas WHERE codigo = 'kidmais'`)).rows[0]?.id;
  assert.ok(kidmais, "dona da agenda pública (046)");
  const A = await empresa("A");
  const B = await empresa("B");
  const criado = await emTransacao(() => salvarPacoteComercial(tx, {
    nome: "Festa Jardim", descricao: null, duracaoMinutos: 240, convidadosMinimos: 30, convidadosMaximos: 80,
    disponibilidade: todosOsDias(), faixas: [{ convidadosMin: 30, convidadosMax: 80, valor: "4500.00" }], categorias: [],
  }, { empresaId: A.empresa, usuarioId: A.usuario, requestId: randomUUID(), motivo: "Criação administrativa" }));
  const livre = criado.pacote.codigo;
  assert.match(livre, /^P_[0-9A-F]{32}$/);

  // Cliente completo de A (CRM real) pelo fluxo público.
  const cpf = cpfValido();
  await emTransacao(() => fechamentoPublico({
    dataEvento: "2098-09-12", horarioInicio: "11:00", horarioFim: "15:00", configuracaoAgendaId: turnos[0], pacoteId: criado.pacote.id,
    convidados: 40, adicionais: [], valorProposto: 4500, buffetStatus: "PENDENTE", empresaEsperada: A.empresa,
    identidade: { tipo: "NOVO_CLIENTE" },
    cliente: { nomeCompleto: `Cliente Ia ${sufixo}`, cpf, telefone: "00000000002", whatsapp: "00000000003", email: `pacote.1d.${cpf}@example.invalid`,
      cep: "00000000", logradouro: "Avenida Sintética", numero: "100", complemento: null, bairro: "Bairro Sintético", cidade: "Cidade de Homologação", uf: "SP" },
    aniversariante: { nome: "Beatriz", temaPadrao: "Teste" },
    cpfSemRevelarCadastro: true,
  }, tx));

  // I1: pelo nome (como o operador fala) e pelo código, na empresa comprovada.
  const pedido = validarContratacao({ cliente: `Cliente Ia ${sufixo}`, pacote: "festa jardim", convidados: 40, aniversariante: "Beatriz", data: "2098-09-19", turno: "almoco" });
  const { payload } = await verificarContratacao(tx, A.empresa, pedido, porta, "2026-10-22");
  assert.equal(payload.pacote, livre, "I1: revisão recebe o código do pacote da empresa");
  assert.equal(payload.pacoteNome, "Festa Jardim");
  assert.equal(payload.precoTabelaCentavos, 450000, "I1: valor de tabela do serviço comercial (a IA não calcula)");
  assert.equal((await resolverPacote(tx, A.empresa, livre, porta, false)).idDaTela, livre);
  await assert.rejects(verificarContratacao(tx, A.empresa, { ...pedido, convidados: 81 }, porta, "2026-10-22"), /Festa Jardim atende até 80/);
  // Isolamento: B não alcança o pacote de A, nem pelo código nem pelo nome.
  assert.equal(await ehDonaDaConfigLegada(tx, B.empresa), false);
  await assert.rejects(resolverPacote(tx, B.empresa, livre, porta, false), /ainda não tem pacotes cadastrados/);
  await assert.rejects(resolverPacote(tx, B.empresa, "festa jardim", porta, false), /ainda não tem pacotes cadastrados/);

  // I2: dona — nome livre ou código recusados; Pizza Party sob consulta; id V1 resolvido se o pacote existir no modelo.
  assert.equal(await ehDonaDaConfigLegada(tx, kidmais), true);
  for (const fora of ["festa jardim", livre]) await assert.rejects(resolverPacote(tx, kidmais, fora, porta, true), /não está disponível nesta empresa/, fora);
  await assert.rejects(resolverPacote(tx, kidmais, "pizza_party_scienza", porta, true), /Pizza Party está sob consulta/);
  const premiumDaDona = (await listarPacotesContrataveisDaEmpresa(kidmais, tx)).some((p) => p.codigo === "PREMIUM");
  // Como antes da fase 1d: na dona, o nome passa pelos reconhecedores dos sete ("premium", "PREMIUM", "Festa Premium").
  if (premiumDaDona) for (const comoAntes of ["premium", "PREMIUM", "Festa Premium"]) assert.equal((await resolverPacote(tx, kidmais, comoAntes, porta, true)).idDaTela, "premium", comoAntes);
});
