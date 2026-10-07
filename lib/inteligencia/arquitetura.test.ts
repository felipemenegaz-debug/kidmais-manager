import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

/**
 * Proteção contra regressão, não fronteira de segurança.
 * A segurança vem do guard, do Tenant Context, da política, do Human Gate e do registro fechado de ferramentas.
 * Estes testes só impedem que uma mudança futura puxe driver, SQL ou domínios não aprovados
 * para a camada de IA sem que alguém perceba.
 *
 * Três camadas:
 * - IA (`lib/inteligencia`): sem SQL, sem driver, lista fechada de imports de domínio.
 * - Persistência da IA (`lib/ia-persistencia`): SQL das tabelas `ia_*`; da IA só importa tipos.
 * - Rotas (`app/api/admin/inteligencia`): composition root; ligam portas aos serviços de domínio reais.
 * O Core não importa nenhuma das três.
 */

const raiz = join(import.meta.dirname, "..", "..");
const PASTA_ROTAS = join(raiz, "app", "api", "admin", "inteligencia");

function arquivos(dir: string): string[] {
  return readdirSync(dir).flatMap((nome) => {
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) return nome === "node_modules" || nome.startsWith(".") ? [] : arquivos(caminho);
    return /\.(ts|tsx)$/.test(nome) ? [caminho] : [];
  });
}

const naoTeste = (arquivo: string) => !arquivo.endsWith(".test.ts");
const camadaIA = arquivos(join(raiz, "lib", "inteligencia")).filter(naoTeste);
const persistenciaIA = arquivos(join(raiz, "lib", "ia-persistencia")).filter(naoTeste);
const rotasIA = arquivos(PASTA_ROTAS).filter(naoTeste);

/**
 * Lista fechada da camada de IA, por destino já resolvido: leituras de domínio, tenant, erros e utilitários.
 * Linhas marcadas com `@pr:` entram junto com a feature (o check de composição remove as das features ausentes).
 */
const PERMITIDOS_IA: Readonly<Record<string, readonly string[]>> = {
  "zod": ["ZodError", "z"],
  "node:crypto": ["createHash"],
  "lib/financeiro/servico": ["listarRecebiveis", "Recebivel", "recebidoNoPeriodo"],
  "lib/financeiro/calculos": ["reaisDe", "hojeBrasilia", "periodoSelecionado", "HORIZONTE_RECORRENCIA_MESES"],
  "lib/saas/provar-tenant": ["SessaoParaTenant", "TenantComprovado"],
  "lib/clientes/services/errors": ["ClienteServiceError"],
  "lib/comercial/pacotes-admin": ["PacoteAdminError"],
  "lib/autenticacao/service": ["Papel"],
  "lib/db/contracts": ["DbExecutor"],
  "lib/contratos/services/leitura-tenant": ["contratosAguardandoAssinatura", "resumoContratoDoTenant", "ContratoPendente", "ResumoContratoTenant", "relacoesContratoDoTenant", "RelacoesContrato", "ultimosContratosDoTenant"],
  "lib/festas/leitura-tenant": ["agendaDoTenant", "FestaAgenda", "festasDoTenant", "festaDoTenant", "FestaRelacionada"],
  // AI V1.1 (PR 4): leitura do catálogo do Buffet (somente leitura; a escrita segue fora da IA).
  "lib/comercial/catalogo-leitura": ["buscarCategoriasBuffet", "buscarItensBuffet"],
  "lib/comercial/motivos-pacote": ["MOTIVOS_PACOTE"], // @pr:ACTIONS
  // Documentos: funções puras (validação, extração, revisão) e só TIPOS do repositório SQL.
  "lib/importacao-contrato/arquivo": ["ArquivoValidado", "limiteConfigurado", "validarArquivoEnviado"], // @pr:DOCUMENT
  "lib/importacao-contrato/pdf-texto": ["extrairTextoPdf", "temTextoNativo", "OpcoesExtracao", "TextoPdf"], // @pr:DOCUMENT
  "lib/importacao-contrato/extracao": ["EXTRACAO_JSON_SCHEMA", "extracaoSchema", "extracaoVazia", "extrairPorRegras", "ExtracaoLida", "SCHEMA_VERSAO"], // @pr:DOCUMENT
  "lib/importacao-contrato/rascunho": ["aplicarRevisao", "montarRevisao", "dadosNormalizados"], // @pr:DOCUMENT
  "lib/importacao-contrato/modelo": ["CampoExtraido", "ExtracaoContrato"], // @pr:DOCUMENT
  "lib/importacao-contrato/repositorio-documentos": ["ExtracaoRegistrada", "RegistroExtracao"], // @pr:DOCUMENT
  // Importação: plano puro e só TIPOS do repositório SQL.
  "lib/importacao-contrato/plano": ["AnaliseDuplicidade", "PlanoImportacao", "DecisaoCliente", "classificarMatch", "montarPlano"], // @pr:IMPORT
  // Conclusão única: schema e tipos puros; a IA continua sem acesso ao executor do Core.
  "lib/contratos/integracao-importados/modelo": ["decisoesSchema", "DecisoesIntegracao", "ResumoIntegracao"],
  "lib/importacao-contrato/repositorio-importacao": ["ImportacaoLida"], // @pr:IMPORT
  // Importação da tabela de preços (071): só o esquema puro da leitura; a escrita segue no Core.
  "lib/comercial/importacao-tabela/esquema": ["INSTRUCAO_LEITURA_TABELA", "LEITURA_JSON_SCHEMA", "leituraSchema", "LeituraTabela"],
  // Modelo de contrato da empresa (072): só o esquema puro da leitura; publicar e gerar contrato seguem no Core.
  "lib/contratos/modelo-empresa/leitura": ["INSTRUCAO_LEITURA_CONTRATO", "LEITURA_CONTRATO_JSON_SCHEMA", "leituraContratoSchema", "LeituraContrato"],
};

/** Composition roots: além da IA, ligam guard, tenant, pool e os serviços de domínio reais às portas. */
const PERMITIDOS_ROTAS: Readonly<Record<string, readonly string[]>> = {
  "lib/financeiro/servico": ["criarContaPagar", "listarCategoriasDespesa"],
  "next/server": ["NextRequest"],
  "node:crypto": ["randomUUID"],
  "lib/http/admin-crm-api": ["exigirApiAdminCrmDisponivel", "tokenAdmin"],
  "lib/http/api-response": ["jsonNoStore"],
  "lib/saas/provar-tenant": ["withTenantTransaction"],
  // AI V1 (Establishment Context): prova da unidade no Core, dentro da transação do Tenant Context.
  "lib/saas/provar-estabelecimento": ["provarEstabelecimento"],
  "lib/db/postgres": ["db", "withTransaction"],
  "lib/clientes/services": ["obterClienteBase", "analisarCadastroCliente", "cadastrarClienteInterno", "buscarClientesCrm"],
  "lib/festas/service": ["FestaError", "consultarFestas"],
  "lib/ia-persistencia/uso": ["criarRegistroUsoPostgres", "lerUsoAgrupado"],
  // AI V1 (Skills por empresa/unidade): leitura das camadas da 058; o catálogo revalida tudo.
  "lib/ia-persistencia/skills": ["criarRepositorioSkillsPostgres"],
  // AI V1 (agentes): posse do contrato na empresa comprovada e detalhe do domínio para comparar versões.
  "lib/contratos/services/contrato-tenant": ["contratoNoTenant"],
  "lib/contratos/services/administrativo.service": ["detalheAdministrativo"],
  // AI V1.1 (PR 5.5): posição financeira OFICIAL do contrato (somente leitura), após a prova de posse no tenant.
  "lib/pagamentos/repositories/alteracao-financeira.repository": ["lerPosicaoFinanceira"],
  "lib/pagamentos/services/alteracao-financeira-core": ["AlteracaoFinanceiraError"],
  "lib/comercial/pacote-comercial": ["painelPacoteAdmin", "salvarPacoteComercial"], // @pr:ACTIONS
  "lib/comercial/pacote-precos": ["gravarFaixasPacote"], // @pr:ACTIONS
  "lib/comercial/pacotes-admin": ["alterarSituacaoPacoteAdmin", "criarRevisaoPacoteAdmin", "editarPacoteNaoUtilizado", "listarPacotesAdmin"], // @pr:ACTIONS
  "lib/ia-persistencia/operacoes": ["repositorioOperacoesPostgres"], // @pr:ACTIONS
  // IA operacional: leituras OFICIAIS para preparar a contratação (CRM, Fechamento administrativo, disponibilidade, valor
  // de tabela, regra de convidados), a criação oficial do Fechamento (envio do formulário, com o vínculo) e o serviço
  // de parâmetros de consumo da 059. Nenhuma escrita própria da IA: só os serviços de domínio.
  "lib/fechamentos/services/fechamento-administrativo.service": ["clienteParaPreparacao", "criarFechamentoAdministrativo", "obterContextoFechamentoAdministrativo"],
  "lib/fechamentos/convidados": ["erroConvidadosFechamento"],
  "lib/disponibilidade/services": ["consultarDisponibilidadeData"],
  // Agenda por empresa/unidade (062): escopo da empresa comprovada para a consulta oficial de horários.
  "lib/disponibilidade/escopo": ["escopoDaEmpresa"],
  "lib/comercial/services": ["calcularResumoComercial"],
  "lib/financeiro/calculos": ["hojeBrasilia"],
  "lib/operacional/parametros-consumo": ["fonteParametrosDisponivel", "parametroVigente", "registrarParametroConsumo"],
  "lib/importacao-contrato/arquivo": ["limiteConfigurado"], // @pr:DOCUMENT
  "lib/importacao-contrato/pdf-isolado": ["extrairTextoPdfIsolado"], // @pr:DOCUMENT
  "lib/importacao-contrato/multipart": ["TEMPO_PADRAO", "criarSemaforo", "lerMultipartLimitado", "limitesUpload", "CodigoMultipart"], // @pr:DOCUMENT
  "lib/importacao-contrato/repositorio-documentos": ["documentosDisponiveis", "registrarDocumento", "registrarExtracao", "ultimaExtracao"], // @pr:DOCUMENT
  // Composition root explícito: preview e conclusão nativa no mesmo Tenant Context/Human Gate.
  "lib/contratos/integracao-importados/rascunho": ["fonteDoRascunho"],
  "lib/contratos/integracao-importados/composicao": ["coreNativo"],
  "lib/contratos/integracao-importados/servico": ["confirmarIntegracao", "opcoesIntegracaoRascunho", "simularIntegracao", "IntegracaoImportadoError"],
  "lib/importacao-contrato/motor": ["executarImportacao"], // @pr:IMPORT
  "lib/importacao-contrato/repositorio-importacao": ["abrirImportacao", "atualizarImportacao", "importacaoDisponivel", "importacaoPorDocumento", "lerImportacao", "substituirImportacaoCancelada"], // @pr:IMPORT
  // Importação da tabela de preços (071): guarda do PDF e da leitura pelos serviços do Core, no Tenant Context.
  "lib/comercial/importacao-tabela/servico": ["arquivoDaImportacao", "gravarLeitura", "registrarImportacao"],
  "lib/contratos/modelo-empresa/servico": ["arquivoDaImportacaoContrato", "gravarLeituraContrato", "registrarImportacaoContrato"],
};

/** Cada composition root liga os serviços de domínio reais da própria feature, nunca SQL próprio. */
const SERVICOS_POR_COMPOSICAO: Readonly<Record<string, readonly string[]>> = {
  "dependencias.ts": ["provarEstabelecimento(", "consultarFestas(", "obterClienteBase(", "criarRegistroUsoPostgres(", "withTransaction", "listarPacotesAdmin(", "contratoNoTenant(", "detalheAdministrativo(", "buscarClientesCrm(", "lerPosicaoFinanceira("],
  "operacoes/composicao.ts": ["listarPacotesAdmin(", "painelPacoteAdmin(", "salvarPacoteComercial(", "editarPacoteNaoUtilizado(", "criarRevisaoPacoteAdmin(", "preservarSituacao: true", "gravarFaixasPacote(", "alterarSituacaoPacoteAdmin(", "clienteParaPreparacao(", "consultarDisponibilidadeData(", "calcularResumoComercial(", "erroConvidadosFechamento(", "criarFechamentoAdministrativo(", "obterContextoFechamentoAdministrativo(", "registrarParametroConsumo("], // @pr:ACTIONS
  "documentos/composicao.ts": ["registrarDocumento", "registrarExtracao", "ultimaExtracao"], // @pr:DOCUMENT
  "importacoes/composicao.ts": ["analisarCadastroCliente(", "cadastrarClienteInterno(", "executarImportacao(", "abrirImportacao", "fonteDoRascunho(", "confirmarIntegracao(", "tokenAdmin(request)", "autenticadoEm: sessao.autenticado_em"], // @pr:IMPORT
};

/** SQL em qualquer caixa, só em literais de string/template: comentários não executam. */
const SQL = /\b(select\s+(distinct\b|[\w*"(])|insert\s+into|update\s+[\w".]+\s+set|delete\s+from|merge\s+into|truncate\s|drop\s+(table|schema|index)|alter\s+table|create\s+(table|index|function|trigger)|on\s+conflict|grant\s)/i;

/** Identificadores que permitem alcançar código ou o executor por caminhos indiretos. */
const INDIRETOS = new Set(["eval", "Reflect", "globalThis", "Function", "require"]);

type Destino = { tipo: "pacote"; chave: string } | { tipo: "arquivo"; chave: string; teste: boolean };

/** Resolve o especificador contra o arquivo importador e normaliza para caminho do repositório sem extensão. */
function resolverDestino(origem: string, importador: string): Destino {
  let caminho: string;
  if (origem.startsWith("@/")) caminho = resolve(raiz, origem.slice(2));
  else if (origem.startsWith(".") || origem.startsWith("/")) caminho = resolve(dirname(importador), origem);
  else return { tipo: "pacote", chave: origem };
  const chave = relative(raiz, caminho).replaceAll("\\", "/").replace(/\.(ts|tsx|mts|js|mjs|cjs)$/, "").replace(/\/index$/, "");
  return { tipo: "arquivo", chave, teste: /\.test(\.|$)/.test(basename(caminho)) };
}

const daCamadaIA = (d: Destino) => d.tipo === "arquivo" && d.chave.startsWith("lib/inteligencia/");
const daPersistenciaIA = (d: Destino) => d.tipo === "arquivo" && d.chave.startsWith("lib/ia-persistencia/");
const dasRotasIA = (d: Destino) => d.tipo === "arquivo" && d.chave.startsWith("app/api/admin/inteligencia/");

type Regras = { permitidos: Readonly<Record<string, readonly string[]>>; internos(d: Destino): boolean; sql: boolean };
const REGRAS_IA: Regras = { permitidos: PERMITIDOS_IA, internos: daCamadaIA, sql: false };
const REGRAS_ROTAS: Regras = { permitidos: PERMITIDOS_ROTAS, internos: (d) => daCamadaIA(d) || dasRotasIA(d), sql: false };

/** Analisa a AST do TypeScript e devolve cada violação encontrada. */
function violacoes(codigo: string, importador = join(raiz, "lib", "inteligencia", "amostra.ts"), regras: Regras = REGRAS_IA): string[] {
  const fonte = ts.createSourceFile(importador, codigo, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const achados: string[] = [];
  const visitar = (no: ts.Node) => {
    if (ts.isImportDeclaration(no)) {
      const origem = (no.moduleSpecifier as ts.StringLiteral).text;
      const destino = resolverDestino(origem, importador);
      const clausula = no.importClause;
      if (destino.tipo === "arquivo" && destino.teste) achados.push(`importa arquivo de teste: ${origem}`);
      if (!clausula) {
        achados.push(`import sem ligação: ${origem}`);
      } else {
        if (clausula.namedBindings && ts.isNamespaceImport(clausula.namedBindings)) achados.push(`import * de ${origem}`);
        if (!regras.internos(destino)) {
          const lista = regras.permitidos[destino.chave];
          if (!lista) achados.push(`destino não aprovado: ${origem} → ${destino.chave}`);
          else {
            if (clausula.name) achados.push(`import default de ${origem}`);
            if (clausula.namedBindings && ts.isNamedImports(clausula.namedBindings)) {
              for (const elemento of clausula.namedBindings.elements) {
                const importado = (elemento.propertyName ?? elemento.name).text;
                if (!lista.includes(importado)) achados.push(`${importado} de ${destino.chave}`);
              }
            }
          }
        }
      }
    } else if (ts.isExportDeclaration(no) && no.moduleSpecifier) {
      achados.push("re-export de módulo");
    } else if (ts.isImportEqualsDeclaration(no)) {
      achados.push("import = require");
    } else if (ts.isCallExpression(no) && no.expression.kind === ts.SyntaxKind.ImportKeyword) {
      achados.push("import() dinâmico");
    } else if (ts.isCallExpression(no) && ts.isElementAccessExpression(no.expression) && !ts.isStringLiteralLike(no.expression.argumentExpression)) {
      achados.push("chamada por chave computada");
    } else if (!regras.sql && ts.isPropertyAccessExpression(no) && no.name.text === "query") {
      achados.push(".query");
    } else if (!regras.sql && ts.isElementAccessExpression(no) && ts.isStringLiteralLike(no.argumentExpression) && no.argumentExpression.text === "query") {
      achados.push("[\"query\"]");
    } else if (!regras.sql && ts.isBindingElement(no) && ((no.propertyName && ts.isIdentifier(no.propertyName) && no.propertyName.text === "query") || (ts.isIdentifier(no.name) && no.name.text === "query"))) {
      achados.push("desestruturação de query");
    } else if (ts.isIdentifier(no) && INDIRETOS.has(no.text) && !ts.isTypeReferenceNode(no.parent)) {
      achados.push(`acesso indireto: ${no.text}`);
    } else if (!regras.sql && (ts.isStringLiteralLike(no) || ts.isTemplateHead(no) || ts.isTemplateMiddle(no) || ts.isTemplateTail(no))) {
      if (SQL.test(no.text)) achados.push(`SQL: ${no.text.slice(0, 40)}`);
    }
    ts.forEachChild(no, visitar);
  };
  visitar(fonte);
  return achados;
}

test("12. a camada de IA não fala com o PostgreSQL e só importa o que está na lista fechada", () => {
  assert.ok(camadaIA.length >= 20);
  for (const arquivo of camadaIA) {
    const codigo = readFileSync(arquivo, "utf8");
    const nome = relative(raiz, arquivo);
    assert.deepEqual(violacoes(codigo, arquivo), [], nome);
    assert.doesNotMatch(codigo, /process\.env|\.env\.local/, `${nome} lê o ambiente diretamente (deve receber por dependência)`);
  }
});

test("rotas da IA: composition root sem SQL, só POST, com guard e Tenant Context existentes", () => {
  assert.ok(rotasIA.length >= 4);
  for (const arquivo of rotasIA) {
    const codigo = readFileSync(arquivo, "utf8");
    assert.deepEqual(violacoes(codigo, arquivo, REGRAS_ROTAS), [], relative(raiz, arquivo));
    assert.doesNotMatch(codigo, /process\.env\.(DATABASE_URL|ADMIN_AUTH_SECRET)|\.env\.local/);
    if (basename(arquivo) === "route.ts") {
      assert.match(codigo, /export async function POST/);
      assert.doesNotMatch(codigo, /export (async )?function (GET|PUT|PATCH|DELETE)/);
      assert.match(codigo, /searchParams\.get\("empresaId"\)/);
    }
  }
  const composicao = readFileSync(join(PASTA_ROTAS, "dependencias.ts"), "utf8");
  assert.match(composicao, /exigirApiAdminCrmDisponivel\(request\)/);
  assert.match(composicao, /withTenantTransaction,/);
  // As portas apontam para os serviços de domínio reais, não para SQL próprio.
  for (const [arquivo, servicos] of Object.entries(SERVICOS_POR_COMPOSICAO)) {
    const fonte = readFileSync(join(PASTA_ROTAS, arquivo), "utf8");
    for (const servico of servicos) assert.ok(fonte.includes(servico), `${arquivo}: ${servico}`);
  }
  // Editar pacote nunca passa por salvarPacoteComercial (regrava disponibilidade/buffet): só criar.
  const acoes = join(PASTA_ROTAS, "operacoes", "composicao.ts");
  if (existsSync(acoes)) assert.match(readFileSync(acoes, "utf8"), /criar: \(tx, dados, ctx\) => salvarPacoteComercial\(tx, \{ \.\.\.dados, disponibilidade: \[\], categorias: \[\], itens: \[\] \}, ctx\)/);
});

test("persistência da IA: SQL só das tabelas ia_*; da camada de IA importa apenas tipos", () => {
  assert.ok(persistenciaIA.length >= 1);
  for (const arquivo of persistenciaIA) {
    const codigo = readFileSync(arquivo, "utf8");
    const fonte = ts.createSourceFile(arquivo, codigo, ts.ScriptTarget.Latest, true);
    for (const no of fonte.statements) {
      if (!ts.isImportDeclaration(no)) continue;
      const destino = resolverDestino((no.moduleSpecifier as ts.StringLiteral).text, arquivo);
      assert.equal(no.importClause?.isTypeOnly, true, `${relative(raiz, arquivo)}: import de valor ${destino.chave}`);
      assert.ok(daCamadaIA(destino) || destino.chave === "lib/db/contracts", `${relative(raiz, arquivo)}: destino ${destino.chave}`);
    }
    for (const tabela of codigo.matchAll(/\b(?:FROM|INTO|UPDATE|to_regclass\('public\.)\s*([a-z_]+)/g)) {
      assert.match(tabela[1], /^ia_/, `${relative(raiz, arquivo)} toca ${tabela[1]}`);
    }
  }
});

test("o analisador detecta cada forma de contornar a lista fechada", () => {
  const proibidos = [
    // Namespace, default, módulo e nome fora da lista.
    'import * as servico from "../financeiro/servico.ts";',
    'import { painelGeral } from "../financeiro/servico.ts";',
    'import { listarContasPagar as listar } from "../financeiro/servico.ts";',
    'import pg from "pg";',
    'import { Pool } from "pg";',
    'import { db } from "../db/postgres.ts";',
    'import "../db/postgres.ts";',
    'import { consultarFestas } from "../festas/service.ts";',
    'import { salvarPacoteComercial } from "../comercial/pacote-comercial.ts";',
    'import { repositorioOperacoesPostgres } from "../ia-persistencia/operacoes.ts";',
    'import { withTenantTransaction } from "../saas/provar-tenant.ts";',
    // Caminhos equivalentes que parecem locais (achados da revisão do Codex).
    'import { painelGeral } from "./../financeiro/servico.ts";',
    'import { db } from "@/lib/inteligencia/../db/postgres";',
    'import { db } from "./../../lib/db/postgres.ts";',
    'import { listarRecebiveis } from "@/../fora/servico";',
    // Arquivos de teste, mesmo dentro da camada.
    'import { bancoFalso } from "./gateway.test.ts";',
    'import { bancoFalso } from "@/lib/inteligencia/gateway.test";',
    // Re-export, CommonJS e import dinâmico.
    'export * from "../financeiro/servico.ts";',
    'export { painelGeral } from "../financeiro/servico.ts";',
    'import pg = require("pg");',
    'const pg = require("pg");',
    'const servico = await import("../financeiro/servico.ts");',
    // Acesso direto ou indireto ao executor.
    'await tx.query("x");',
    'await tx["query"]("x");',
    "const consultar = tx.query;",
    "const { query } = tx;",
    "const { query: consultar } = tx;",
    "await tx[metodo](texto);",
    "Reflect.apply(fn, tx, []);",
    'globalThis["req" + "uire"]("pg");',
    'new Function("return 1")();',
    'eval("1");',
    // SQL em qualquer caixa.
    'const sql = "select * from clientes";',
    'const sql = "SeLeCt id FROM festas";',
    "const sql = `delete from festas where id = ${id}`;",
    'const sql = "Update pacotes set nome = 1";',
    'const sql = "insert into auditoria values (1)";',
    'const sql = "INSERT INTO x (a) VALUES (1) on conflict do nothing";',
    'const sql = "drop table x";',
  ];
  for (const amostra of proibidos) {
    assert.notDeepEqual(violacoes(amostra), [], amostra);
  }
  const permitidos = [
    'import { listarRecebiveis, type Recebivel } from "../financeiro/servico.ts";',
    'import type { DbExecutor } from "../db/contracts.ts";',
    'import { autorizarFerramenta } from "./politica.ts";',
    'import type { TenantComprovado } from "@/lib/saas/provar-tenant";',
    'const texto = "Selecione o período. Nenhum pagamento vencido.";',
    "const item = ferramentas[nome];",
  ];
  for (const amostra of permitidos) {
    assert.deepEqual(violacoes(amostra), [], amostra);
  }
  // Nas rotas, o composition root pode ligar o serviço real, mas não o driver nem SQL.
  const rota = join(PASTA_ROTAS, "amostra.ts");
  assert.deepEqual(violacoes('import { obterClienteBase } from "@/lib/clientes/services";', rota, REGRAS_ROTAS), []);
  assert.notDeepEqual(violacoes('import { Pool } from "pg";', rota, REGRAS_ROTAS), []);
  assert.notDeepEqual(violacoes('const sql = "select * from pacotes";', rota, REGRAS_ROTAS), []);
  assert.notDeepEqual(violacoes('import { criarPacoteAdmin } from "@/lib/comercial/pacotes-admin";', rota, REGRAS_ROTAS), []);
});

test("LLM não recebe conexão: nenhum pedido de modelo carrega DbExecutor, tenant de pedido ou ferramenta executável", () => {
  const tipos = readFileSync(join(raiz, "lib", "inteligencia", "modelos", "tipos.ts"), "utf8");
  const pedido = tipos.slice(tipos.indexOf("export type PedidoModelo"), tipos.indexOf("export type RespostaBruta"));
  assert.doesNotMatch(pedido, /DbExecutor|TenantComprovado|empresa|executar|tools?\b/i);
  const adaptador = readFileSync(join(raiz, "lib", "inteligencia", "modelos", "openai-compativel.ts"), "utf8");
  assert.doesNotMatch(adaptador, /["']tools["']|functions:|tool_choice/);
});

test("10. o Core não depende da IA: nenhum import fora das camadas de IA resolve para elas", () => {
  const camadas = new Set([...camadaIA, ...persistenciaIA, ...rotasIA]);
  const foraDaIA = [...arquivos(join(raiz, "lib")), ...arquivos(join(raiz, "app")), ...arquivos(join(raiz, "components"))]
    .filter((arquivo) => !camadas.has(arquivo) && !/^lib\/(inteligencia|ia-persistencia)\//.test(relative(raiz, arquivo).replaceAll("\\", "/")));
  assert.ok(foraDaIA.length > 100);
  for (const arquivo of foraDaIA) {
    const fonte = ts.createSourceFile(arquivo, readFileSync(arquivo, "utf8"), ts.ScriptTarget.Latest, true);
    const visitar = (no: ts.Node) => {
      const especificador = ts.isImportDeclaration(no) || ts.isExportDeclaration(no) ? no.moduleSpecifier
        : ts.isCallExpression(no) && (no.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(no.expression) && no.expression.text === "require")) ? no.arguments[0]
          : undefined;
      if (especificador && ts.isStringLiteralLike(especificador)) {
        const destino = resolverDestino(especificador.text, arquivo);
        assert.equal(daCamadaIA(destino) || daPersistenciaIA(destino), false, `${relative(raiz, arquivo)} importa ${especificador.text}`);
      }
      ts.forEachChild(no, visitar);
    };
    visitar(fonte);
  }
});

test("as flags só são lidas pela IA; o Core não consulta INTELIGENCIA_ENABLED nem AI_*", () => {
  const leitores = [...arquivos(join(raiz, "lib")), ...arquivos(join(raiz, "app")), ...arquivos(join(raiz, "components"))]
    .filter((arquivo) => !arquivo.endsWith(".test.ts") && /INTELIGENCIA_ENABLED|AI_(READ|ADMIN_ACTIONS|CONTRACT_IMPORT|JEV)_ENABLED|AI_TENANT_ALLOWLIST/.test(readFileSync(arquivo, "utf8")))
    .map((arquivo) => relative(raiz, arquivo).replaceAll("\\", "/"));
  assert.deepEqual(leitores, ["lib/inteligencia/flags.ts"]);
});

/**
 * B2 — PRs separáveis. O CORE não importa nenhuma feature; cada feature só importa o CORE e as features
 * anteriores na ordem CORE → JEV → DEMERZEL → SKILLS → COPILOTO → AGENTES → ACTIONS → DOCUMENT → IMPORT. O único ponto de encontro é
 * app/api/admin/inteligencia/extensoes.ts, com uma linha marcada `@pr:` por feature.
 */
const FEATURES = { jev: "JEV", demerzel: "DEMERZEL", skills: "SKILLS", copiloto: "COPILOTO", agentes: "AGENTES", acoes: "ACTIONS", documentos: "DOCUMENT", importacao: "IMPORT" } as const;
const ORDEM = ["CORE", "JEV", "DEMERZEL", "SKILLS", "COPILOTO", "AGENTES", "ACTIONS", "DOCUMENT", "IMPORT"] as const;
type Camada = (typeof ORDEM)[number];

function camadaDe(chave: string): Camada | null {
  const ia = chave.match(/^lib\/inteligencia\/([^/]+)\//);
  if (ia) return (FEATURES as Record<string, Camada>)[ia[1]] ?? "CORE";
  if (/^lib\/inteligencia\/[^/]+$/.test(chave)) return "CORE";
  const rota = chave.match(/^app\/api\/admin\/inteligencia\/(jev|demerzel|skills|copiloto|agentes|operacoes|documentos|importacoes)\//);
  if (rota) return ({ jev: "JEV", demerzel: "DEMERZEL", skills: "SKILLS", copiloto: "COPILOTO", agentes: "AGENTES", operacoes: "ACTIONS", documentos: "DOCUMENT", importacoes: "IMPORT" } as const)[rota[1] as "operacoes"];
  if (/^app\/api\/admin\/inteligencia\/[^/]+$/.test(chave)) return "CORE";
  if (/^lib\/importacao-contrato\/(plano|motor|repositorio-importacao)$/.test(chave)) return "IMPORT";
  if (/^lib\/importacao-contrato\/(arquivo|pdf-texto|pdf-isolado|pdf-worker|extracao|validadores|rascunho|repositorio-documentos|multipart)$/.test(chave)) return "DOCUMENT";
  if (/^lib\/ia-persistencia\/operacoes$/.test(chave)) return "ACTIONS";
  if (/^lib\/ia-persistencia\/uso$/.test(chave)) return "CORE";
  return null;
}

function importsDe(arquivo: string) {
  const fonte = ts.createSourceFile(arquivo, readFileSync(arquivo, "utf8"), ts.ScriptTarget.Latest, true);
  return fonte.statements.filter(ts.isImportDeclaration).map((no) => ({
    destino: resolverDestino((no.moduleSpecifier as ts.StringLiteral).text, arquivo),
    linha: fonte.text.slice(no.getStart(), fonte.text.indexOf("\n", no.getEnd()) < 0 ? undefined : fonte.text.indexOf("\n", no.getEnd())),
  }));
}

test("B2: CORE não importa feature; feature só importa CORE e features anteriores; composição compartilhada é marcada", () => {
  const candidatos = [
    ...camadaIA,
    ...rotasIA,
    ...arquivos(join(raiz, "lib", "importacao-contrato")).filter(naoTeste),
    ...persistenciaIA,
  ];
  for (const arquivo of candidatos) {
    const chave = relative(raiz, arquivo).replaceAll("\\", "/").replace(/\.(ts|tsx)$/, "");
    const origem = camadaDe(chave);
    if (!origem) continue;
    for (const { destino, linha } of importsDe(arquivo)) {
      if (destino.tipo !== "arquivo") continue;
      const alvo = camadaDe(destino.chave);
      if (!alvo || ORDEM.indexOf(alvo) <= ORDEM.indexOf(origem)) continue;
      // Exceção única: o ponto de extensão do CORE, com a linha marcada pela feature que a traz.
      const marcada = chave === "app/api/admin/inteligencia/extensoes" && linha.includes(`// @pr:${alvo}`);
      assert.ok(marcada, `${chave} (${origem}) importa ${destino.chave} (${alvo})`);
    }
  }
});

test("B2: o registro de ações é extensível (fábricas + RegistroExtensoes), sem lista estática de features futuras", () => {
  const caminhoRegistro = join(raiz, "lib", "inteligencia", "acoes", "registro.ts");
  if (existsSync(caminhoRegistro)) assert.doesNotMatch(readFileSync(caminhoRegistro, "utf8"), /importacao|documentos/);
  const conversa = readFileSync(join(raiz, "lib", "inteligencia", "conversa.ts"), "utf8");
  assert.doesNotMatch(conversa, /acoes\/|documentos\/|importacao\//, "a conversa recebe ModuloAcoes por dependência");
  const extensoes = readFileSync(join(PASTA_ROTAS, "extensoes.ts"), "utf8");
  for (const linha of extensoes.split(/\r?\n/).filter((l) => /registrar(Jev|Demerzel|Skills|Copiloto|Agentes|Acoes|Importacao|Documentos)|composicao/.test(l))) {
    assert.match(linha, /\/\/ @pr:(JEV|DEMERZEL|SKILLS|COPILOTO|AGENTES|ACTIONS|DOCUMENT|IMPORT)$/, linha);
  }
});
