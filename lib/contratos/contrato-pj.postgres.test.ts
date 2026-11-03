import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import {
  ambienteAssinatura, carregar, catalogoNativo, cenario, congelarEAssinarKidmais, cpfValido, dia, executor, id, poolNaTransacao, type Cenario,
} from "../../scripts/integracao-importados-test-support.ts";

/**
 * Entrega B (112) — contrato de cliente PJ no PostgreSQL DESCARTÁVEL (modelo 112), pelos serviços reais:
 * - modelo ativo da empresa com `CPF {{contratante.cpf}}` + contratante PJ → MODELO_INCOMPATIVEL_PJ (409) com os trechos,
 *   nada gravado (sem contrato, sem versão); o mesmo modelo com contratante PF gera normalmente;
 * - modelo convertido (`{{contratante.tipo_documento}} {{contratante.documento}}`) → snapshot com tipo, CNPJ, razão
 *   social e representante, CPF vazio, e o PDF da revisão é gerado;
 * - modelo trocado para o legado depois da emissão → a geração do PDF recusa de novo (segunda conferência).
 * Cada teste termina em ROLLBACK.
 */
const opt = () => process.env.KIDMAIS_POSTGRES_DESCARTAVEL === "kidmais_pacotes_v1_descartavel";
let a: Client;
type Operar = Parameters<typeof congelarEAssinarKidmais>[1];
type Nativo = Awaited<ReturnType<typeof catalogoNativo>>;
const CNPJ = "11222333000181";
const conteudo = (clausula: string) => ({
  titulo: "Contrato PJ", contratada: { nome: "Buffet PJ Ltda", documento: "12.345.678/0001-90", endereco: "Rua Teste, 2", representante: "Pessoa Teste" },
  preambulo: [], observacoes: [], cidadeAssinatura: "Cidade Teste",
  clausulas: [{ titulo: "Objeto", texto: `Festa em {{festa.data}} das {{festa.inicio}} às {{festa.fim}} ({{festa.pacote}}), {{festa.convidados}} convidados, {{valor.total}}, {{pagamento.condicao}}. ${clausula}` }],
});
const LEGADO = conteudo("Contratante {{contratante.nome}}, CPF {{contratante.cpf}}.");
const CONVERTIDO = conteudo("Contratante {{contratante.nome}}, {{contratante.tipo_documento}} {{contratante.documento}}, representada por {{contratante.representante}}.");

async function emTx(corpo: () => Promise<void>) {
  await a.query("BEGIN");
  const restaurarPool = poolNaTransacao(a);
  const restaurarAmbiente = ambienteAssinatura();
  try { await corpo(); } finally { await a.query("ROLLBACK"); restaurarAmbiente(); restaurarPool(); }
}
async function modelo(c: Cenario, valor: object, versao = 1) {
  await a.query(`INSERT INTO modelos_contrato_empresa (empresa_id, versao, conteudo, conteudo_sha256, aprovado_por) VALUES ($1::uuid, $5, $2::jsonb, $3, $4::uuid)`,
    [c.empresa, JSON.stringify(valor), "a".repeat(64), c.usuario, versao]);
}
async function cliente(c: Cenario, pj: boolean) {
  const comuns = [c.empresa, `${randomUUID()}@example.invalid`];
  return pj
    ? id(a, `INSERT INTO clientes (nome_completo, razao_social, tipo_pessoa, cnpj, nome_fantasia, representante_nome, representante_cpf, empresa_id, email, telefone, whatsapp, cep, logradouro, numero, bairro, cidade, uf)
        VALUES ('Escola Pequeno Saber Ltda', 'Escola Pequeno Saber Ltda', 'PJ', '${CNPJ}', 'Pequeno Saber', 'Ana Diretora', '11144477735', $1::uuid, $2, '11999998888', '11999998888', '01001000', 'Rua Sintética', '1', 'Centro', 'São Paulo', 'SP') RETURNING id`, comuns)
    : id(a, `INSERT INTO clientes (nome_completo, cpf, empresa_id, email, telefone, whatsapp, cep, logradouro, numero, bairro, cidade, uf)
        VALUES ('Cliente PF', $3, $1::uuid, $2, '11999998888', '11999998888', '01001000', 'Rua Sintética', '1', 'Centro', 'São Paulo', 'SP') RETURNING id`, [...comuns, cpfValido()]);
}
async function proposta(c: Cenario, nativo: Nativo, clienteId: string, data: string) {
  const aniversariante = await id(a, `INSERT INTO aniversariantes (cliente_id, nome) VALUES ($1::uuid, 'Aniversariante PJ') RETURNING id`, [clienteId]);
  return id(a, `INSERT INTO fechamentos (data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, pacote_id, tabela_preco_id, preco_pacote_id,
        categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, valor_pacote_aplicado, valor_tabela, origem_fechamento, cliente_id, aniversariante_id, status)
      SELECT $1::date, '10:00', '22:00', $2::uuid, $3::uuid, p.id, pp.tabela_preco_id, pp.id, 'PADRAO', 'PADRAO', 30, 30, 100, 100, 100, 'ATENDIMENTO_KIDMAIS', $5::uuid, $6::uuid, 'AGUARDANDO_CONTRATO'
        FROM pacotes p JOIN precos_pacote pp ON pp.pacote_id = p.id WHERE p.id = $4::uuid LIMIT 1 RETURNING fechamentos.id`, [data, nativo.turno, c.empresa, c.pacote, clienteId, aniversariante]);
}
const contratos = () => carregar<typeof import("./services/contrato.service.ts")>("lib/contratos/services/contrato.service.ts");
const gerar = (c: Cenario, festa: string) =>
  contratos().gerarContrato({ fechamentoId: festa } as never, { usuarioId: c.usuario, origem: "SISTEMA", executor: executor(a) } as never) as Promise<{ contrato: { id: string }; versao: { id: string } }>;
const codigo = (esperado: string) => (e: unknown) => (e as { code?: string }).code === esperado;

test.before(async () => {
  if (!opt()) return;
  process.env.FESTA_ENABLED = "true";
  a = await conectarDescartavel();
});
test.after(async () => { if (a) await encerrarDescartavel(a); });

test("modelo legado (CPF {{contratante.cpf}}) + PJ → MODELO_INCOMPATIVEL_PJ, nada gravado; o mesmo modelo segue gerando para PF", { skip: !opt(), timeout: 300_000 }, async () => {
  await emTx(async () => {
    const c = await cenario(a, 0);
    const nativo = await catalogoNativo(a, c);
    await modelo(c, LEGADO);
    const festaPj = await proposta(c, nativo, await cliente(c, true), dia(120));
    await a.query("SAVEPOINT recusa");
    await assert.rejects(gerar(c, festaPj), (e: unknown) => codigo("MODELO_INCOMPATIVEL_PJ")(e)
      && (e as { httpStatus?: number }).httpStatus === 409
      && JSON.stringify((e as { details?: unknown }).details).includes("usa {{contratante.cpf}}"));
    await a.query("ROLLBACK TO SAVEPOINT recusa");
    assert.equal((await a.query(`SELECT count(*)::int n FROM contratos WHERE fechamento_id = $1::uuid`, [festaPj])).rows[0].n, 0);
    const festaPf = await proposta(c, nativo, await cliente(c, false), dia(121));
    const pf = await gerar(c, festaPf);
    const s = (await a.query(`SELECT snapshot s FROM contrato_versoes WHERE id = $1::uuid`, [pf.versao.id])).rows[0].s;
    assert.equal("tipoPessoa" in s.contratante, false, "snapshot PF sem chave nova");
  });
});

test("modelo convertido + PJ: snapshot com CNPJ, razão social e representante; PDF gerado; modelo legado depois → PDF recusado", { skip: !opt(), timeout: 300_000 }, async () => {
  await emTx(async () => {
    const c = await cenario(a, 0);
    const nativo = await catalogoNativo(a, c);
    await modelo(c, CONVERTIDO);
    const festa = await proposta(c, nativo, await cliente(c, true), dia(122));
    const gerado = await gerar(c, festa);
    const s = (await a.query(`SELECT snapshot s FROM contrato_versoes WHERE id = $1::uuid`, [gerado.versao.id])).rows[0].s;
    assert.deepEqual(
      { tipo: s.contratante.tipoPessoa, cnpj: s.contratante.cnpj, cpf: s.contratante.cpf, nome: s.contratante.nomeCompleto, razao: s.contratante.razaoSocial, rep: s.contratante.representante },
      { tipo: "PJ", cnpj: CNPJ, cpf: "", nome: "Escola Pequeno Saber Ltda", razao: "Escola Pequeno Saber Ltda", rep: { nome: "Ana Diretora", cpf: "11144477735" } },
    );
    const adm = carregar<typeof import("./services/administrativo.service.ts")>("lib/contratos/services/administrativo.service.ts");
    const revisao = async () => (await a.query<{ revisao: number }>(`SELECT revisao FROM contrato_edicoes WHERE contrato_versao_id = $1`, [gerado.versao.id])).rows[0].revisao;
    const ctx = () => ({ requestId: randomUUID(), ip: null, userAgent: "pj" });
    const operar = adm.operarContrato as unknown as Operar;
    const pdf = await operar(gerado.versao.id, { acao: "gerar_pdf", revisao: await revisao() }, c.token, ctx(), c.empresa) as { documentoId: string };
    assert.ok(pdf.documentoId);
    // Um modelo legado publicado depois da emissão: a geração do PDF confere de novo.
    await a.query(`UPDATE modelos_contrato_empresa SET situacao = 'SUBSTITUIDO', substituido_em = now() WHERE empresa_id = $1::uuid AND situacao = 'ATIVO'`, [c.empresa]);
    await modelo(c, LEGADO, 2);
    await a.query("SAVEPOINT pdf");
    await assert.rejects(operar(gerado.versao.id, { acao: "gerar_pdf", revisao: await revisao() }, c.token, ctx(), c.empresa), codigo("MODELO_INCOMPATIVEL_PJ"));
    await a.query("ROLLBACK TO SAVEPOINT pdf");
  });
});
