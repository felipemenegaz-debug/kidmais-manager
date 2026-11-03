import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import {
  ambienteAssinatura, assinarComoCliente, carregar, catalogoNativo, cenario, congelarEAssinarKidmais, cpfValido, dia, executor, id, poolNaTransacao,
  type Cenario,
} from "../../scripts/integracao-importados-test-support.ts";

/**
 * Entrega B (112) — identidade pública e assinatura de PJ (plano R2-1) no PostgreSQL DESCARTÁVEL. Modelo 112:
 * - assinatura PJ ponta a ponta com CNPJ alfanumérico (consulta → desafio → código → aceite), aceite auditado com CNPJ;
 * - o CPF do representante (compartilhado por duas PJs e também cadastrado como PF) nunca abre contrato de PJ; abre só o
 *   contrato PF da pessoa; CNPJ de outra PJ ou de outra empresa: negado; recuperação e reenvio de código por CNPJ.
 * Modelo 109 (código novo sem a 112): CNPJ → PJ_INDISPONIVEL/MIGRACAO_PENDENTE; CPF segue como antes.
 * Cada teste termina em ROLLBACK.
 */
const opt = () => process.env.KIDMAIS_POSTGRES_DESCARTAVEL === "kidmais_pacotes_v1_descartavel";
let a: Client;
let com112 = false;
type Operar = Parameters<typeof congelarEAssinarKidmais>[1];
type Nativo = Awaited<ReturnType<typeof catalogoNativo>>;
const CNPJ_ALFA = "12ABC34501DE35";
const CNPJ = "11222333000181";
const MODELO = {
  titulo: "Contrato PJ", contratada: { nome: "Buffet PJ Ltda", documento: "12.345.678/0001-90", endereco: "Rua Teste, 2", representante: "Pessoa Teste" },
  preambulo: [], observacoes: [], cidadeAssinatura: "Cidade Teste",
  clausulas: [{ titulo: "Objeto", texto: "Festa em {{festa.data}} das {{festa.inicio}} às {{festa.fim}} ({{festa.pacote}}), {{festa.convidados}} convidados, {{valor.total}}, {{pagamento.condicao}}. {{contratante.tipo_documento}} {{contratante.documento}}." }],
};

async function emTx(corpo: () => Promise<void>) {
  await a.query("BEGIN");
  const restaurarPool = poolNaTransacao(a);
  const restaurarAmbiente = ambienteAssinatura();
  try { await corpo(); } finally { await a.query("ROLLBACK"); restaurarAmbiente(); restaurarPool(); }
}
const endereco = `'11999998888', '11999998888', '01001000', 'Rua Sintética', '1', 'Centro', 'São Paulo', 'SP'`;
const clientePj = (c: Cenario, cnpj: string, nome: string, repCpf: string) => id(a,
  `INSERT INTO clientes (nome_completo, razao_social, tipo_pessoa, cnpj, representante_nome, representante_cpf, empresa_id, email, telefone, whatsapp, cep, logradouro, numero, bairro, cidade, uf)
   VALUES ($1, $1, 'PJ', $2, 'Ana Representante', $3, $4::uuid, $5, ${endereco}) RETURNING id`, [nome, cnpj, repCpf, c.empresa, `${randomUUID()}@example.invalid`]);
const clientePf = (c: Cenario, cpf: string) => id(a,
  `INSERT INTO clientes (nome_completo, cpf, empresa_id, email, telefone, whatsapp, cep, logradouro, numero, bairro, cidade, uf)
   VALUES ('Ana Representante', $1, $2::uuid, $3, ${endereco}) RETURNING id`, [cpf, c.empresa, `${randomUUID()}@example.invalid`]);
async function contrato(c: Cenario, nativo: Nativo, clienteId: string, data: string) {
  const aniversariante = await id(a, `INSERT INTO aniversariantes (cliente_id, nome) VALUES ($1::uuid, 'Aniversariante') RETURNING id`, [clienteId]);
  const festa = await id(a, `INSERT INTO fechamentos (data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, pacote_id, tabela_preco_id, preco_pacote_id,
        categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, valor_pacote_aplicado, valor_tabela, origem_fechamento, cliente_id, aniversariante_id, status)
      SELECT $1::date, '10:00', '22:00', $2::uuid, $3::uuid, p.id, pp.tabela_preco_id, pp.id, 'PADRAO', 'PADRAO', 30, 30, 100, 100, 100, 'ATENDIMENTO_KIDMAIS', $5::uuid, $6::uuid, 'AGUARDANDO_CONTRATO'
        FROM pacotes p JOIN precos_pacote pp ON pp.pacote_id = p.id WHERE p.id = $4::uuid LIMIT 1 RETURNING fechamentos.id`, [data, nativo.turno, c.empresa, c.pacote, clienteId, aniversariante]);
  const contratos = carregar<typeof import("../contratos/services/contrato.service.ts")>("lib/contratos/services/contrato.service.ts");
  const gerado = await contratos.gerarContrato({ fechamentoId: festa } as never, { usuarioId: c.usuario, origem: "SISTEMA", executor: executor(a) } as never) as { contrato: { id: string }; versao: { id: string } };
  const adm = carregar<typeof import("../contratos/services/administrativo.service.ts")>("lib/contratos/services/administrativo.service.ts");
  await congelarEAssinarKidmais(a, adm.operarContrato as unknown as Operar, gerado.versao.id, c.empresa, c.token, nativo.tokenRepresentante);
  return gerado;
}
async function empresa() {
  const c = await cenario(a, 0);
  const nativo = await catalogoNativo(a, c);
  await a.query(`INSERT INTO modelos_contrato_empresa (empresa_id, versao, conteudo, conteudo_sha256, aprovado_por) VALUES ($1::uuid, 1, $2::jsonb, $3, $4::uuid)`,
    [c.empresa, JSON.stringify(MODELO), "a".repeat(64), c.usuario]);
  return { c, nativo };
}
const publico = () => carregar<typeof import("../contratos/services/contrato-publico.service.ts")>("lib/contratos/services/contrato-publico.service.ts");
const identidade = () => carregar<typeof import("./services/index.ts")>("lib/identidade/services/index.ts");
const negado = (e: unknown) => (e as { code?: string }).code === "CONTRATO_ACESSO_NAO_AUTORIZADO";
async function recusa<T>(p: () => Promise<T>, f: (e: unknown) => boolean) {
  await a.query("SAVEPOINT recusa");
  await assert.rejects(p(), f);
  await a.query("ROLLBACK TO SAVEPOINT recusa");
}

test.before(async () => {
  if (!opt()) return;
  process.env.FESTA_ENABLED = "true";
  a = await conectarDescartavel();
  com112 = (await a.query("SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.clientes'::regclass AND attname = 'tipo_pessoa' AND NOT attisdropped) AS ok")).rows[0].ok;
});
test.after(async () => { if (a) await encerrarDescartavel(a); });

test("112: assinatura PJ ponta a ponta com CNPJ alfanumérico; aceite auditado com o tipo de documento", { skip: !opt(), timeout: 300_000 }, async (t) => {
  if (!com112) return t.skip("modelo sem a 112");
  await emTx(async () => {
    const { c, nativo } = await empresa();
    const pj = await clientePj(c, CNPJ_ALFA, "Escola Alfa Ltda", cpfValido());
    const g = await contrato(c, nativo, pj, dia(130));
    const assinado = await assinarComoCliente(g.contrato.id, "12.abc.345/01de-35") as { contrato: { status: string } };
    assert.equal(assinado.contrato.status, "ASSINADO");
    const auditado = (await a.query(`SELECT dados_depois ->> 'aceiteTipoDocumento' AS t FROM auditoria WHERE entidade_tipo = 'CONTRATO_VERSAO' AND entidade_id = $1::uuid AND dados_depois ? 'aceiteMetodo'`, [g.versao.id])).rows;
    assert.deepEqual(auditado.map((r) => r.t), ["CNPJ"]);
  });
});

test("112: CPF do representante não abre contrato de PJ (nem compartilhado por duas PJs); abre só o contrato PF da pessoa; CNPJ de outra PJ/empresa negado", { skip: !opt(), timeout: 300_000 }, async (t) => {
  if (!com112) return t.skip("modelo sem a 112");
  await emTx(async () => {
    const { c, nativo } = await empresa();
    const rep = cpfValido();
    const pj1 = await clientePj(c, CNPJ, "Escola Um Ltda", rep);
    const pj2 = await clientePj(c, CNPJ_ALFA, "Escola Dois Ltda", rep);
    const pf = await clientePf(c, rep);
    const g1 = await contrato(c, nativo, pj1, dia(131));
    const g2 = await contrato(c, nativo, pj2, dia(132));
    const gPf = await contrato(c, nativo, pf, dia(133));
    for (const g of [g1, g2]) await recusa(() => publico().consultarAcessoContrato({ contratoId: g.contrato.id, cpf: rep }), negado);
    assert.equal((await publico().consultarAcessoContrato({ contratoId: gPf.contrato.id, cpf: rep })).situacao, "CLIENTE_EXISTENTE");
    await recusa(() => publico().consultarAcessoContrato({ contratoId: gPf.contrato.id, cpf: CNPJ }), negado);
    await recusa(() => publico().consultarAcessoContrato({ contratoId: g1.contrato.id, cpf: CNPJ_ALFA }), negado);
    assert.equal((await publico().consultarAcessoContrato({ contratoId: g1.contrato.id, cpf: "11.222.333/0001-81" })).situacao, "CLIENTE_EXISTENTE");
    // Endereço público da empresa: o CNPJ só existe nela; noutra empresa é cliente novo.
    const { c: outra } = await empresa();
    const escopo = (empresaId: string) => ({ empresaId, incluirLegadoSemEmpresa: false });
    assert.equal((await identidade().consultarCpfPublico(CNPJ, escopo(c.empresa))).situacao, "CLIENTE_EXISTENTE");
    assert.equal((await identidade().consultarCpfPublico(CNPJ, escopo(outra.empresa))).situacao, "NOVO_CLIENTE");
    // Representante sem cadastro PF próprio: o CPF dele não acha nenhuma das PJs.
    await a.query(`UPDATE clientes SET cpf = NULL WHERE id = $1::uuid`, [pf]);
    assert.equal((await identidade().consultarCpfPublico(rep, escopo(c.empresa))).situacao, "NOVO_CLIENTE");
  });
});

test("112: recuperação e reenvio de código pelo CNPJ", { skip: !opt(), timeout: 300_000 }, async (t) => {
  if (!com112) return t.skip("modelo sem a 112");
  await emTx(async () => {
    const { c, nativo } = await empresa();
    const pj = await clientePj(c, CNPJ, "Escola Um Ltda", cpfValido());
    const g = await contrato(c, nativo, pj, dia(134));
    const enviados: string[] = [];
    const emissor = (async (x: { codigo: string }) => { enviados.push(x.codigo); }) as never;
    const d1 = await publico().iniciarDesafioContrato({ contratoId: g.contrato.id, cpf: CNPJ, canal: "WHATSAPP" }, emissor);
    const d2 = await publico().iniciarDesafioContrato({ contratoId: g.contrato.id, cpf: "11.222.333/0001-81", canal: "WHATSAPP" }, emissor);
    assert.equal(enviados.length, 2);
    assert.notEqual(d1.validacaoId, d2.validacaoId);
    const servico = identidade().criarIdentityServiceComAmbiente(emissor);
    assert.deepEqual(await servico.solicitarRecuperacao(CNPJ, { empresaId: c.empresa, incluirLegadoSemEmpresa: false }), { situacao: "RECUPERACAO_PENDENTE" });
    await recusa(() => servico.solicitarRecuperacao(CNPJ_ALFA, { empresaId: c.empresa, incluirLegadoSemEmpresa: false }), (e) => (e as { code?: string }).code === "CLIENTE_NAO_ENCONTRADO");
  });
});

test("sem a 112: CNPJ → PJ_INDISPONIVEL/MIGRACAO_PENDENTE (409); CPF segue; documento inválido recusado", { skip: !opt(), timeout: 300_000 }, async (t) => {
  if (com112) return t.skip("modelo com a 112");
  await emTx(async () => {
    const c = await cenario(a, 0);
    const escopo = { empresaId: c.empresa, incluirLegadoSemEmpresa: false };
    const cpf = cpfValido();
    await clientePf(c, cpf);
    await recusa(() => identidade().consultarCpfPublico(CNPJ, escopo),
      (e) => (e as { code?: string }).code === "PJ_INDISPONIVEL" && (e as { httpStatus?: number }).httpStatus === 409 && (e as { details?: { motivo?: string } }).details?.motivo === "MIGRACAO_PENDENTE");
    assert.equal((await identidade().consultarCpfPublico(cpf, escopo)).situacao, "CLIENTE_EXISTENTE");
    await recusa(() => identidade().consultarCpfPublico("123", escopo), (e) => (e as { code?: string }).code === "CPF_INVALIDO");
    await recusa(() => identidade().consultarCpfPublico("11.222.333/0001-82", escopo), (e) => (e as { code?: string }).code === "DOCUMENTO_INVALIDO");
  });
});
