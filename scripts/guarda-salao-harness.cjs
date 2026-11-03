/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Plano "liberar agenda com mais de um salão" (rev. 6–7, aprovado pelo Astra): guarda DINÂMICA dos escritores de
 * fechamentos.salao_id e fechamento_revisoes.salao_id. Só no cluster descartável dos testes PG: os gatilhos são
 * instalados pelo runner (não por migration), com o prefixo reservado `kidmais_teste_`.
 *
 *  - Disparo só em escrita de salão: INSERT com salão e UPDATE em que o valor final de salao_id mudou (qualquer SET,
 *    inclusive mudança feita por um BEFORE). O gatilho é genérico e lê a coluna por to_jsonb(NEW): não cria dependência
 *    de coluna, então os testes de rollback que removem salao_id (094) continuam podendo removê-la.
 *  - Correlação comando ↔ escritor: o md5 no fim da marca (`kidmais.escritor_salao`) tem de ser md5(current_query()).
 *  - Violação: erro KD901 (registrado pelo preload, mesmo capturado ou desfeito). Escrita aceita: NOTICE com a marca.
 *  - Avaliação (fim de cada suíte): qualquer KD901 reprova; marca fora da tabela B reprova; B6 só grava NULL; a marca
 *    de fixture `C:<arquivo>` só vale em arquivo de teste/apoio.
 *
 * Limite declarado (rev. 7): UPDATE sem mudança de valor não dispara. A guarda estática sobre os .sql impede introduzir
 * gatilho que escreva salão. É diagnóstico de teste.
 */
const fs = require("node:fs");

/** Tabela B (rev. 5–7) com as origens declaradas pelos chamadores: escritor → caminho → origens. */
const TABELA_B = {
  B1: { APLICACAO_REVISAO_INICIAL: ["ACEITE_PUBLICO"], FORMALIZACAO_PRE_ASSINATURA: ["ACEITE_PUBLICO"],
    FORMALIZACAO_POS_ASSINATURA: ["ACEITE_PUBLICO", "RECONCILIACAO_OPERACIONAL"], CONFIRMACAO_PAGAMENTO: ["PAGAMENTO"],
    INTEGRACAO_IMPORTADO: ["IMPORTACAO"] },
  B2: { CONFIRMACAO_PAGAMENTO: ["PAGAMENTO"] },
  B3: { APLICACAO_REVISAO_OPERACIONAL: ["ACEITE_PUBLICO"] },
  B4: { PREPARACAO_REVISAO: ["EQUIPE"] },
  B5: { PREPARACAO_REVISAO: ["EQUIPE"] },
  B6: { EDICAO_LIMPA_SALAO: ["EQUIPE", "ACEITE_PUBLICO"] },
  B7: { ATRIBUICAO_AVULSA: ["EQUIPE"] },
};
/** Tabela de cada escritor (B4/B5 só em fechamento_revisoes; os demais só em fechamentos). */
const TABELA_DO_ESCRITOR = { B1: "fechamentos", B2: "fechamentos", B3: "fechamentos", B4: "fechamento_revisoes", B5: "fechamento_revisoes", B6: "fechamentos", B7: "fechamentos" };
/** Fixtures C: só arquivos de teste ou de apoio de teste. */
const ARQUIVO_DE_FIXTURE = /(\.test\.(ts|tsx|cjs|mjs|js)|test-support\.ts|test-apoio\.(ts|cjs)|-ui\.cjs)$/;

const PREFIXO = "kidmais_teste_salao|";

const SQL_INSTALAR = `
DO $kidmais_teste$
BEGIN
  IF to_regclass('public.fechamentos') IS NULL THEN RETURN; END IF;
  CREATE OR REPLACE FUNCTION public.kidmais_teste_guarda_salao() RETURNS trigger LANGUAGE plpgsql AS $f$
  DECLARE
    m text := coalesce(current_setting('kidmais.escritor_salao', true), '');
    partes text[] := string_to_array(m, ':');
    novo text := to_jsonb(NEW) ->> 'salao_id';
  BEGIN
    IF TG_OP = 'INSERT' AND novo IS NULL THEN RETURN NULL; END IF;
    IF TG_OP = 'UPDATE' AND novo IS NOT DISTINCT FROM (to_jsonb(OLD) ->> 'salao_id') THEN RETURN NULL; END IF;
    IF m = '' OR partes[array_length(partes, 1)] IS DISTINCT FROM md5(current_query()) THEN
      RAISE EXCEPTION '${PREFIXO}VIOLACAO|%|%|%', coalesce(nullif(m, ''), 'SEM_MARCA'), TG_TABLE_NAME, TG_OP USING ERRCODE = 'KD901';
    END IF;
    RAISE NOTICE '${PREFIXO}ESCRITA|%|%|%|%', m, TG_TABLE_NAME, TG_OP, CASE WHEN novo IS NULL THEN 'NULO' ELSE 'SALAO' END;
    RETURN NULL;
  END $f$;
END $kidmais_teste$;
`;

function sqlGatilhos(tabela) {
  return `
DO $kidmais_teste$
BEGIN
  IF to_regclass('public.${tabela}') IS NULL THEN RETURN; END IF;
  EXECUTE 'DROP TRIGGER IF EXISTS kidmais_teste_salao_ins ON public.${tabela}';
  EXECUTE 'DROP TRIGGER IF EXISTS kidmais_teste_salao_upd ON public.${tabela}';
  EXECUTE 'CREATE TRIGGER kidmais_teste_salao_ins AFTER INSERT ON public.${tabela} FOR EACH ROW EXECUTE FUNCTION public.kidmais_teste_guarda_salao()';
  EXECUTE 'CREATE TRIGGER kidmais_teste_salao_upd AFTER UPDATE ON public.${tabela} FOR EACH ROW EXECUTE FUNCTION public.kidmais_teste_guarda_salao()';
END $kidmais_teste$;
`;
}

/** Instala a guarda num banco (o modelo; os bancos de trabalho herdam pelo TEMPLATE). */
async function instalar(client) {
  await client.query(SQL_INSTALAR);
  for (const tabela of ["fechamentos", "fechamento_revisoes"]) await client.query(sqlGatilhos(tabela));
}

/** "B1:CAMINHO:ORIGEM:md5" ou "C:arquivo:md5" → partes. */
function lerMarca(marca) {
  const p = String(marca).split(":");
  if (p[0] === "C") return { fixture: true, arquivo: p.slice(1, -1).join(":"), hash: p.at(-1) };
  return { fixture: false, escritor: p[0], caminho: p[1], origem: p[2], hash: p[3] };
}

/** Problemas de uma escrita aceita pelo gatilho (marca correlacionada); vazio = permitida pela tabela B ou por C. */
function problemasDaEscrita(e) {
  const m = lerMarca(e.marca);
  if (m.fixture) return ARQUIVO_DE_FIXTURE.test(m.arquivo) ? [] : [`fixture C fora de arquivo de teste: ${m.arquivo}`];
  const origens = TABELA_B[m.escritor]?.[m.caminho];
  const p = [];
  if (!origens) p.push(`escritor × caminho fora da tabela B: ${m.escritor}:${m.caminho}`);
  else if (!origens.includes(m.origem)) p.push(`origem fora da tabela B: ${m.escritor}:${m.caminho}:${m.origem}`);
  if (TABELA_DO_ESCRITOR[m.escritor] && TABELA_DO_ESCRITOR[m.escritor] !== e.tabela) p.push(`${m.escritor} gravou em ${e.tabela}`);
  if (m.escritor === "B6" && e.valor !== "NULO") p.push("B6 gravou um salão (só pode limpar)");
  return p;
}

/** Converte a mensagem do gatilho (NOTICE ou erro KD901) em evento. */
function eventoDaMensagem(mensagem) {
  const s = String(mensagem ?? "");
  if (!s.startsWith(PREFIXO)) return null;
  const [, tipo, marca, tabela, operacao, valor] = s.split("|");
  return { tipo, marca, tabela, operacao, valor };
}

/** Lê o registro JSONL do preload. Arquivo ausente = nenhum evento (o runner confere a presença do preload à parte). */
function lerRegistro(arquivo) {
  if (!fs.existsSync(arquivo)) return [];
  return fs.readFileSync(arquivo, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

/** Avaliação de uma suíte: violações de escrita (KD901 e marcas inválidas) e de ordem originadas em produção. */
function avaliar(eventos) {
  const problemas = [];
  for (const e of eventos) {
    if (e.tipo === "KD901") problemas.push(`KD901 ${e.mensagem}${e.origem ? ` (${e.origem})` : ""}`);
    else if (e.tipo === "ESCRITA") for (const p of problemasDaEscrita(e)) problemas.push(`${p}${e.origem ? ` (${e.origem})` : ""}`);
    else if (e.tipo === "ORDEM" && e.producao) problemas.push(`ordem: ${e.motivo} (${e.origem})`);
  }
  return problemas;
}

/**
 * Ordem D'' (plano "liberar agenda com mais de um salão"): classe de um comando SQL numa transação. CONFIG = trava da
 * configuração da agenda; AGENDA = trava de agenda (data, revisão, contrato 019, salões, bloqueios); LINHA = trava de
 * linha ou DML nas tabelas da agenda; null = irrelevante. Usada pelo preload (regressão inteira) e pelo teste D''.
 */
const TABELAS = "fechamentos|contratos|contrato_fluxos|contrato_versoes|contrato_edicoes|contrato_assinaturas|fechamento_revisoes|pagamentos|pagamento_parcelas|bloqueios_agenda|agenda_saloes";
const RE_CONFIG = /kidmais:agenda-config:/;
const RE_AGENDA = /\bagenda_saloes\b[\s\S]*\bFOR\s+(NO\s+KEY\s+)?(UPDATE|SHARE|KEY\s+SHARE)\b|\bbloqueios_agenda\b[\s\S]*\bFOR\s+(NO\s+KEY\s+)?UPDATE\b/i;
const RE_TRAVA_LINHA = new RegExp(`\\b(FROM|JOIN)\\s+(public\\.)?(${TABELAS})\\b[\\s\\S]*\\bFOR\\s+(NO\\s+KEY\\s+)?(UPDATE|SHARE)\\b`, "i");
const RE_DML = new RegExp(`^\\s*(WITH[\\s\\S]*?\\)\\s*)?(INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+(public\\.)?(${TABELAS})\\b`, "i");

// A chave advisory vem num literal ('kidmais:agenda:' || …); os nomes das funções só contam FORA de literais (consultas de catálogo
// que listam nomes, como lib/festas/ambiente.ts, não travam nada).
const RE_CHAVE_AGENDA = /kidmais:agenda:/;
const RE_FUNCAO_AGENDA = /kidmais_lock_datas_revisao|kidmais019_bloquear_contrato/i;
const semLiterais = (t) => t.replace(/'(?:[^']|'')*'/g, "''");
/**
 * Rodada 2: a cláusula FOR UPDATE/SHARE trava só as tabelas do FROM do PRÓPRIO nível do SELECT (nunca as de um EXISTS ou
 * subconsulta na lista de colunas). Cada nível entre parênteses é avaliado com os níveis internos trocados por "()";
 * uma trava dentro de uma subconsulta/CTE continua contando no nível dela.
 */
function niveis(texto) {
  const pilha = [""];
  const saida = [];
  for (const ch of texto) {
    if (ch === "(") { pilha[pilha.length - 1] += "()"; pilha.push(""); }
    else if (ch === ")" && pilha.length > 1) saida.push(pilha.pop());
    else pilha[pilha.length - 1] += ch;
  }
  return [...saida, ...pilha];
}

function classificarComando(texto) {
  if (RE_CONFIG.test(texto)) return "CONFIG";
  const partes = niveis(texto);
  if (RE_CHAVE_AGENDA.test(texto) || RE_FUNCAO_AGENDA.test(semLiterais(texto)) || partes.some((p) => RE_AGENDA.test(p))) return "AGENDA";
  if (partes.some((p) => RE_TRAVA_LINHA.test(p)) || RE_DML.test(texto)) return "LINHA";
  return null;
}

module.exports = { classificarComando, TABELA_B, TABELA_DO_ESCRITOR, ARQUIVO_DE_FIXTURE, PREFIXO, instalar, lerMarca, problemasDaEscrita, eventoDaMensagem, lerRegistro, avaliar };
