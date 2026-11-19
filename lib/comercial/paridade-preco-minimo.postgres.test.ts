import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import ts from "typescript";
import type { NextRequest } from "next/server";
import type { DisponibilidadeDataPublica } from "../disponibilidade/services/models.ts";
import { conectarDescartavel, encerrarDescartavel } from "./postgres-descartavel.ts";

const DATAS = ["2030-03-01", "2030-03-02"] as const;
const PACOTES = [
  { codigo: "POCKET", tela: "pocket", tipo: "PONTO", minimo: 20, exato: 151025, geral: 181045 },
  { codigo: "MINI_FESTA", tela: "mini", tipo: "FIXO", minimo: 25, exato: 202035, geral: 282075 },
  { codigo: "COMPACTA", tela: "compacta", tipo: "POR_CONVIDADO", minimo: 30, exato: 10317, geral: 12789 },
] as const;
const CATEGORIAS = [["PADRAO", "exato"], ["GERAL", "geral"]] as const;
const ORIGEM = "http://127.0.0.1";

async function semear(cliente: Client) {
  const empresa = (await cliente.query<{ id: string }>(
    "INSERT INTO empresas (codigo,nome,status) VALUES ('dfp6prova','Buffet sintético D-FP-6','PROVISIONAMENTO') RETURNING id"
  )).rows[0].id;
  await cliente.query("UPDATE empresas SET status = 'ATIVA' WHERE id = $1", [empresa]);
  const configs = (await cliente.query<{ id: string; codigo: string }>(
    "SELECT id, codigo FROM configuracao_agenda WHERE empresa_id IS NULL AND ativo AND codigo IN ('TURNO_1','TURNO_2') ORDER BY codigo"
  )).rows;
  assert.equal(configs.length, 2);
  const tabela = (await cliente.query<{ id: string }>(
    "INSERT INTO tabelas_preco (empresa_id,codigo,nome,vigencia_inicio,vigencia_fim,ativa) VALUES ($1,'DFP6','Tabela sintética',$2,$3,false) RETURNING id",
    [empresa, ...DATAS]
  )).rows[0].id;

  for (const [ordem, p] of PACOTES.entries()) {
    const id = (await cliente.query<{ id: string }>(
      "INSERT INTO pacotes (empresa_id,codigo,nome,ordem_exibicao,ativo,vigente,convidados_minimos,convidados_maximos) VALUES ($1,$2::text,$2::text,$3,true,true,$4,50) RETURNING id",
      [empresa, p.codigo, ordem + 1, p.minimo]
    )).rows[0].id;
    for (const { id: config } of configs) {
      await cliente.query(
        "INSERT INTO regras_disponibilidade_pacote (pacote_id,dia_semana,configuracao_agenda_id,estado,vigencia_inicio) VALUES ($1,5,$2,'DISPONIVEL',$3),($1,6,$2,'DISPONIVEL',$3)",
        [id, config, DATAS[0]]
      );
    }
    for (const [categoria, variante] of CATEGORIAS) {
      const escopo = (await cliente.query<{ id: string }>(
        "INSERT INTO tabela_preco_escopos (tabela_preco_id,pacote_id,categoria_horario,cobertura_continua) VALUES ($1,$2,$3,false) RETURNING id",
        [tabela, id, categoria]
      )).rows[0].id;
      const linhas = p.tipo === "PONTO" ? [[p.minimo, p.minimo, p[variante]], [50, 50, p[variante] + 70000]] : [[p.minimo, 50, p[variante]]];
      for (const [min, max, centavos] of linhas) {
        await cliente.query(
          "INSERT INTO tabela_preco_escopo_faixas (escopo_id,convidados_min,convidados_max) VALUES ($1,$2,$3)",
          [escopo, min, max]
        );
        await cliente.query(
          "INSERT INTO precos_pacote (tabela_preco_id,pacote_id,convidados_min,convidados_max,tipo_calculo,valor,categoria_horario) VALUES ($1,$2,$3,$4,$5,$6,$7)",
          [tabela, id, min, max, p.tipo, (centavos / 100).toFixed(2), categoria]
        );
      }
    }
    await cliente.query(
      "INSERT INTO regras_desconto_pacote (pacote_id,dia_semana,percentual,codigo,titulo,vigencia_inicio,vigencia_fim) VALUES ($1,5,15,'DIA_SEMANA_BUFFET','15% de desconto na sexta',$2,$2)",
      [id, DATAS[0]]
    );
  }
  await cliente.query("UPDATE tabelas_preco SET publicada_em = clock_timestamp() WHERE id=$1", [tabela]);
  return { empresa, configs };
}

type Rota = (request: NextRequest) => Promise<Response>;
type Cartao = { codigo: string; convidadosMinimos: number; precoNoMinimo: number };
type Cotacao = {
  convidadosFaturados: number;
  categoria: string;
  valorTabela: number;
  desconto: { percentual: number; valor: number; origem: string };
  valor: number;
};

async function corpo<T>(resposta: Response): Promise<T> {
  const dados = await resposta.json();
  assert.equal(resposta.status, 200, JSON.stringify(dados));
  return dados as T;
}

test("D-FP-6: preço no mínimo do cartão igual à base da cotação pelas rotas públicas", async (t) => {
  const cliente = await conectarDescartavel();
  const globalDoTeste = globalThis as { __kidmaisPgPool?: Pick<Client, "query"> };
  const poolAnterior = globalDoTeste.__kidmaisPgPool;
  const empresaAnterior = process.env.AGENDA_PUBLICA_EMPRESA_ID;
  const unidadeAnterior = process.env.AGENDA_PUBLICA_UNIDADE_ID;
  const exigir = createRequire(import.meta.url);
  const raiz = fileURLToPath(new URL("../..", import.meta.url));
  const extensoes = exigir.extensions as unknown as Record<string, (modulo: { _compile(code: string, filename: string): void }, arquivo: string) => void>;
  const extensaoAnterior = extensoes[".ts"];
  try {
    await cliente.query("BEGIN");
    const { empresa, configs } = await semear(cliente);
    process.env.AGENDA_PUBLICA_EMPRESA_ID = empresa;
    delete process.env.AGENDA_PUBLICA_UNIDADE_ID;
    // As rotas reais usam a mesma conexão descartável já verificada, dentro da transação da fixture.
    globalDoTeste.__kidmaisPgPool = cliente;
    extensoes[".ts"] = (modulo, arquivo) => {
      const saida = ts.transpileModule(readFileSync(arquivo, "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
        fileName: arquivo,
      }).outputText.replace(/require\("@\/([^"\n]+)"\)/g, (_texto, caminho: string) => `require(${JSON.stringify(resolve(raiz, caminho))})`);
      modulo._compile(saida, arquivo);
    };
    const { NextRequest } = exigir("next/server") as typeof import("next/server");
    const { GET: lerAgenda } = exigir(resolve(raiz, "app/api/disponibilidade/route.ts")) as { GET: Rota };
    const { GET: listarPacotes } = exigir(resolve(raiz, "app/api/fechamentos/pacotes/route.ts")) as { GET: Rota };
    const { POST: cotar } = exigir(resolve(raiz, "app/api/fechamentos/cotacao/route.ts")) as { POST: Rota };
    let comparacoes = 0;

    for (const data of DATAS) {
      const { data: agenda } = await corpo<{ data: DisponibilidadeDataPublica }>(
        await lerAgenda(new NextRequest(`${ORIGEM}/api/disponibilidade?data=${data}&convidados=15`)),
      );
      for (const config of configs) {
        const periodo = agenda.periodos.find(p => p.configuracaoId === config.id);
        assert.ok(periodo, `${data} / ${config.codigo}`);
        const consulta = new URLSearchParams({ data, configuracaoId: config.id, convidados: "15" });
        const { pacotes } = await corpo<{ pacotes: Cartao[] }>(
          await listarPacotes(new NextRequest(`${ORIGEM}/api/fechamentos/pacotes?${consulta}`)),
        );
        assert.deepEqual(pacotes.map(p => p.codigo).sort(), PACOTES.map(p => p.codigo).sort());
        for (const pacote of PACOTES) {
          await t.test(`${pacote.tipo} / ${pacote.codigo} / ${data} / ${config.codigo}`, async (caso) => {
            const horario = periodo.horarios.find(h => h.pacotesVendaveis?.includes(pacote.codigo));
            assert.ok(horario, "a agenda deve oferecer um horário vendável para o pacote");
            const cartao = pacotes.find(p => p.codigo === pacote.codigo);
            assert.ok(cartao);
            assert.equal(cartao.convidadosMinimos, pacote.minimo);
            const { data: cotacao } = await corpo<{ data: Cotacao }>(await cotar(new NextRequest(`${ORIGEM}/api/fechamentos/cotacao`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                pacote: pacote.tela, dataFesta: data, configuracaoId: config.id, convidados: pacote.minimo,
                ajusteHorario: String(horario.ajusteMinutos), horarioInicio: horario.inicio, horarioFim: horario.fim,
              }),
            })));
            const geral = data === DATAS[1] && config.codigo === "TURNO_2";
            const baseEmCentavos = pacote[geral ? "geral" : "exato"] * (pacote.tipo === "POR_CONVIDADO" ? pacote.minimo : 1);
            const percentual = data === DATAS[0] ? 15 : 0;
            const descontoEmCentavos = Math.round(baseEmCentavos * percentual / 100);

            assert.equal(cotacao.convidadosFaturados, pacote.minimo);
            assert.equal(cotacao.categoria, geral ? "GERAL" : "PADRAO");
            assert.equal(cotacao.valorTabela, baseEmCentavos / 100);
            assert.equal(cartao.precoNoMinimo, cotacao.valorTabela);
            assert.equal(cotacao.desconto.percentual, percentual);
            assert.equal(cotacao.desconto.origem, percentual ? "empresa" : "nenhum");
            assert.equal(cotacao.desconto.valor, descontoEmCentavos / 100);
            assert.equal(cotacao.valor, (baseEmCentavos - descontoEmCentavos) / 100);
            caso.diagnostic(`categoria=${cotacao.categoria} mínimo=${pacote.minimo} cartão=${cartao.precoNoMinimo.toFixed(2)} base=${cotacao.valorTabela.toFixed(2)} desconto=${cotacao.desconto.valor.toFixed(2)} cotação=${cotacao.valor.toFixed(2)}`);
            comparacoes++;
          });
        }
      }
    }
    assert.equal(comparacoes, 12);
  } finally {
    if (extensaoAnterior) extensoes[".ts"] = extensaoAnterior;
    else delete extensoes[".ts"];
    globalDoTeste.__kidmaisPgPool = poolAnterior;
    if (empresaAnterior === undefined) delete process.env.AGENDA_PUBLICA_EMPRESA_ID;
    else process.env.AGENDA_PUBLICA_EMPRESA_ID = empresaAnterior;
    if (unidadeAnterior === undefined) delete process.env.AGENDA_PUBLICA_UNIDADE_ID;
    else process.env.AGENDA_PUBLICA_UNIDADE_ID = unidadeAnterior;
    await encerrarDescartavel(cliente);
  }
});
