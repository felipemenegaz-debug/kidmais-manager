/**
 * Peças do harness PostgreSQL da 054 que não dependem de driver: registro dos IDs criados pela
 * execução, verificação de resíduo, empresas reservadas e a orquestração da limpeza. Testadas sem
 * banco com um executor simulado (harness-054.test.ts).
 */
export type Executor054 = {
  query<Row extends object = Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<{ rows: Row[]; rowCount?: number | null }>;
};

export const PREFIXO_054 = "Fixture 054";

/**
 * Empresas reservadas do harness. A guarda 044 recusa exclusão física de empresa: elas são criadas
 * uma vez, com código determinístico (único por constraint), e reutilizadas para sempre, nunca
 * alteradas nem excluídas.
 */
export const EMPRESAS_RESERVADAS_054 = {
  A: { codigo: "kidmais-fixture-054-a", nome: "Fixture 054 reservada A" },
  B: { codigo: "kidmais-fixture-054-b", nome: "Fixture 054 reservada B" },
} as const;
export type PapelReservado = keyof typeof EMPRESAS_RESERVADAS_054;

/**
 * Empresas criadas pelas execuções 1–3 (antes do código determinístico). Não são reutilizadas:
 * são resíduo conhecido e documentado, aceito só com este id + código exatos e sem nenhum vínculo.
 */
export const EMPRESAS_LEGADAS_054: readonly { id: string; codigo: string }[] = [
  { id: "fb37b5e3-0117-41b9-a98f-253a1453f0a0", codigo: "e548a2ce1f6" },
  { id: "4dcbc90d-b1c4-4113-a579-576c79c5eaab", codigo: "e54a7fa91ef" },
];

// ---------------------------------------------------------------------------------------------
// Registro dos IDs criados pela execução atual (só eles são removidos na limpeza).
// ---------------------------------------------------------------------------------------------
/** Ordem de remoção respeita as FKs (filhos antes dos pais). Empresas nunca entram aqui. */
export const ORDEM_REMOCAO_054 = [
  "fechamentos",
  "clientes_mesclados",
  "clientes",
  "precos_pacote",
  "tabelas_preco",
  "pacotes",
  "configuracao_agenda",
  "usuarios_administrativos",
] as const;
export type TabelaRegistrada = (typeof ORDEM_REMOCAO_054)[number];
export type Registro054 = { ids: Record<TabelaRegistrada, string[]> };

export function novoRegistro054(): Registro054 {
  return { ids: Object.fromEntries(ORDEM_REMOCAO_054.map((t) => [t, [] as string[]])) as Record<TabelaRegistrada, string[]> };
}
export function registrar054(reg: Registro054, tabela: TabelaRegistrada, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error(`registro 054: id inválido para ${tabela}`);
  reg.ids[tabela].push(id);
  return id;
}
/** Remove só os IDs registrados, numa transação; nenhum DELETE por nome/padrão. Registro vazio: nenhum SQL. */
export async function removerRegistrados054(exec: Executor054, reg: Registro054) {
  const tabelas = ORDEM_REMOCAO_054.filter((t) => reg.ids[t].length > 0);
  if (!tabelas.length) return;
  await exec.query("BEGIN");
  try {
    for (const t of tabelas) {
      const tabela = t === "clientes_mesclados" ? "clientes" : t;
      await exec.query(`DELETE FROM ${tabela} WHERE id = ANY($1::uuid[])`, [reg.ids[t]]);
    }
    await exec.query("COMMIT");
  } catch (erro) {
    await exec.query("ROLLBACK").catch(() => {});
    throw erro;
  }
  for (const t of tabelas) reg.ids[t] = [];
}

// ---------------------------------------------------------------------------------------------
// Vínculos de uma empresa: toda FK para empresas descoberta no catálogo + caminhos indiretos.
// ---------------------------------------------------------------------------------------------
/** FKs de uma coluna para empresas(id), descobertas no catálogo (memberships, estabelecimentos, catálogo, financeiro, 054...). */
export const SQL_FKS_EMPRESA = `SELECT n.nspname AS esquema, c.relname AS tabela, a.attname AS coluna
   FROM pg_catalog.pg_constraint k
   JOIN pg_catalog.pg_class c ON c.oid = k.conrelid
   JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   JOIN pg_catalog.pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
  WHERE k.contype = 'f' AND k.confrelid = 'public.empresas'::regclass AND cardinality(k.conkey) = 1
  ORDER BY 1, 2, 3`;
/** Caminhos sem FK direta: pelo pacote do fechamento (vale antes e depois da 054). */
export const VINCULOS_INDIRETOS_054: readonly [string, string][] = [
  ["fechamentos (pelo pacote)", "SELECT count(*)::int AS n FROM fechamentos f JOIN pacotes p ON p.id = f.pacote_id WHERE p.empresa_id = $1::uuid"],
  ["clientes (pelos fechamentos)", "SELECT count(DISTINCT f.cliente_id)::int AS n FROM fechamentos f JOIN pacotes p ON p.id = f.pacote_id WHERE p.empresa_id = $1::uuid AND f.cliente_id IS NOT NULL"],
  ["contratos", "SELECT count(*)::int AS n FROM contratos c JOIN fechamentos f ON f.id = c.fechamento_id JOIN pacotes p ON p.id = f.pacote_id WHERE p.empresa_id = $1::uuid"],
  ["revisões", "SELECT count(*)::int AS n FROM fechamento_revisoes r JOIN fechamentos f ON f.id = r.fechamento_id JOIN pacotes p ON p.id = f.pacote_id WHERE p.empresa_id = $1::uuid"],
  ["pagamentos", `SELECT count(*)::int AS n FROM pagamentos g JOIN contrato_versoes v ON v.id = g.contrato_versao_id JOIN contratos c ON c.id = v.contrato_id
     JOIN fechamentos f ON f.id = c.fechamento_id JOIN pacotes p ON p.id = f.pacote_id WHERE p.empresa_id = $1::uuid`],
];
const identificador = (s: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`identificador inesperado no catálogo: ${s}`);
  return `"${s}"`;
};
/** Lista "origem=n" de cada vínculo existente (vazio = empresa sem nenhum vínculo). */
export async function vinculosDaEmpresa054(exec: Executor054, empresaId: string) {
  const achados: string[] = [];
  const fks = await exec.query<{ esquema: string; tabela: string; coluna: string }>(SQL_FKS_EMPRESA);
  if (!fks.rows.length) throw new Error("vínculos 054: nenhuma FK para empresas encontrada no catálogo (catálogo inesperado)");
  for (const fk of fks.rows) {
    const r = await exec.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${identificador(fk.esquema)}.${identificador(fk.tabela)} WHERE ${identificador(fk.coluna)} = $1::uuid`, [empresaId]);
    if (Number(r.rows[0]?.n ?? 0) > 0) achados.push(`${fk.tabela}.${fk.coluna}=${r.rows[0].n}`);
  }
  for (const [nome, sql] of VINCULOS_INDIRETOS_054) {
    const r = await exec.query<{ n: number }>(sql, [empresaId]);
    if (Number(r.rows[0]?.n ?? 0) > 0) achados.push(`${nome}=${r.rows[0].n}`);
  }
  return achados;
}

// ---------------------------------------------------------------------------------------------
// Empresa reservada: identidade inequívoca ou aborto.
// ---------------------------------------------------------------------------------------------
type LinhaEmpresa = { id: string; codigo: string; nome: string; status: string; desativado_em: string | null };
export async function empresaReservada054(exec: Executor054, papel: PapelReservado): Promise<string> {
  const esperado = EMPRESAS_RESERVADAS_054[papel];
  const porCodigo = await exec.query<LinhaEmpresa>(
    "SELECT id::text, codigo, nome, status, desativado_em::text FROM empresas WHERE codigo = $1", [esperado.codigo]);
  const porNome = await exec.query<LinhaEmpresa>(
    "SELECT id::text, codigo, nome, status, desativado_em::text FROM empresas WHERE nome = $1", [esperado.nome]);
  if (porCodigo.rows.length > 1 || porNome.rows.length > 1) throw new Error(`empresa reservada ${papel}: duplicidade (código ou nome).`);
  const linha = porCodigo.rows[0];
  if (!linha) {
    if (porNome.rows.length) throw new Error(`empresa reservada ${papel}: nome reservado usado por outra empresa (${porNome.rows[0].codigo}).`);
    const criada = await exec.query<{ id: string }>(
      "INSERT INTO empresas (codigo, nome, status) VALUES ($1, $2, 'PROVISIONAMENTO') RETURNING id::text AS id", [esperado.codigo, esperado.nome]);
    return criada.rows[0].id;
  }
  if (linha.nome !== esperado.nome || linha.status !== "PROVISIONAMENTO" || linha.desativado_em !== null
      || (porNome.rows[0] && porNome.rows[0].id !== linha.id)) {
    throw new Error(`empresa reservada ${papel}: atributos inesperados (nome, status ou desativação); não é reutilizada.`);
  }
  const vinculos = await vinculosDaEmpresa054(exec, linha.id);
  if (vinculos.length) throw new Error(`empresa reservada ${papel}: não está limpa (${vinculos.join(", ")}).`);
  return linha.id;
}

// ---------------------------------------------------------------------------------------------
// Resíduo antes da execução: qualquer coisa inesperada aborta SEM limpeza destrutiva.
// ---------------------------------------------------------------------------------------------
export const SQL_RESIDUO_054 = `SELECT
   (SELECT count(*)::int FROM pacotes WHERE nome LIKE $1) AS pacotes,
   (SELECT count(*)::int FROM tabelas_preco WHERE nome LIKE $1) AS tabelas,
   (SELECT count(*)::int FROM clientes WHERE nome_completo LIKE $1) AS clientes,
   (SELECT count(*)::int FROM configuracao_agenda WHERE nome LIKE $1) AS agendas,
   (SELECT count(*)::int FROM usuarios_administrativos WHERE nome LIKE $1) AS usuarios,
   (SELECT count(*)::int FROM empresas WHERE nome LIKE $1 AND codigo <> ALL($2::text[])
      AND (id::text, codigo) NOT IN (SELECT x.id, x.codigo FROM jsonb_to_recordset($3::jsonb) AS x(id text, codigo text))) AS empresas`;
/** Lança se houver resíduo não esperado; empresas reservadas/legadas precisam estar sem vínculo. Só lê. */
export async function exigirSemResiduo054(exec: Executor054) {
  const codigos = Object.values(EMPRESAS_RESERVADAS_054).map((e) => e.codigo);
  const r = await exec.query<Record<string, number>>(SQL_RESIDUO_054, [`${PREFIXO_054}%`, codigos, JSON.stringify(EMPRESAS_LEGADAS_054)]);
  const achados = Object.entries(r.rows[0] ?? {}).filter(([, n]) => Number(n) > 0).map(([t, n]) => `${t}=${n}`);
  const conhecidas = await exec.query<{ id: string; codigo: string }>(
    `SELECT id::text, codigo FROM empresas WHERE codigo = ANY($1::text[])
       OR (id::text, codigo) IN (SELECT x.id, x.codigo FROM jsonb_to_recordset($2::jsonb) AS x(id text, codigo text))`,
    [codigos, JSON.stringify(EMPRESAS_LEGADAS_054)]);
  for (const e of conhecidas.rows) {
    const vinculos = await vinculosDaEmpresa054(exec, e.id);
    if (vinculos.length) achados.push(`empresa ${e.codigo}: ${vinculos.join(", ")}`);
  }
  if (achados.length) throw new Error(`resíduo preexistente do harness 054 (${achados.join("; ")}): abortado sem limpeza destrutiva.`);
}

// ---------------------------------------------------------------------------------------------
// Orquestração: erro principal preservado; 053 só sai depois de comprovada a ausência da 054.
// ---------------------------------------------------------------------------------------------
export type Limpeza054 = {
  removerRegistrados: () => Promise<void>;
  instalada054: () => Promise<boolean>;
  down054: () => Promise<string | null>;
  /** Todos os objetos da 054 ausentes (funções, gatilhos, colunas, índices, FKs). */
  ausencia054: () => Promise<boolean>;
  down053: () => Promise<string | null>;
  verificarFinal: () => Promise<void>;
  encerrar: () => Promise<void>;
};
export type Estado054 = { instalou053: boolean; instalou054: boolean };
export type ErroComLimpeza = Error & { errosDeLimpeza?: string[] };

const mensagem = (erro: unknown) => (erro instanceof Error ? erro.message : String(erro));

/** Executa o ciclo e sempre a limpeza. Relança o erro principal (o mesmo objeto), com os de limpeza anexados. */
export async function executarComLimpeza054(ciclo: () => Promise<void>, estado: Estado054, limpeza: Limpeza054) {
  let principal: unknown = null;
  let falhou = false;
  try {
    await ciclo();
  } catch (erro) {
    principal = erro;
    falhou = true;
  }
  const erros: string[] = [];
  const passo = async <T>(nome: string, fn: () => Promise<T>): Promise<{ ok: true; valor: T } | { ok: false }> => {
    try {
      return { ok: true, valor: await fn() };
    } catch (erro) {
      erros.push(`${nome}: ${mensagem(erro)}`);
      return { ok: false };
    }
  };
  await passo("remover fixtures registradas", limpeza.removerRegistrados);
  if (estado.instalou054) {
    const instalada = await passo("consultar 054", limpeza.instalada054);
    if (!instalada.ok || instalada.valor) {
      const down = await passo("down 054", limpeza.down054);
      if (down.ok && down.valor !== null) erros.push(`down 054: ${down.valor}`);
    }
  }
  // 053 só sai se a ausência completa da 054 for comprovada; na dúvida, preserva a dependência.
  const ausente = await passo("comprovar ausência da 054", limpeza.ausencia054);
  const semA054 = ausente.ok && ausente.valor === true;
  if (!semA054) erros.push("recuperação pendente: a 054 não está comprovadamente ausente; a 053 foi preservada.");
  if (estado.instalou053 && semA054) {
    const down = await passo("down 053", limpeza.down053);
    if (down.ok && down.valor !== null) erros.push(`down 053: ${down.valor}`);
  }
  await passo("verificação final", limpeza.verificarFinal);
  await passo("encerrar conexão", limpeza.encerrar);
  if (falhou) {
    if (principal instanceof Error) {
      (principal as ErroComLimpeza).errosDeLimpeza = erros;
      throw principal;
    }
    const embrulho: ErroComLimpeza = new Error(mensagem(principal), { cause: principal });
    embrulho.errosDeLimpeza = erros;
    throw embrulho;
  }
  if (erros.length) throw new AggregateError(erros.map((e) => new Error(e)), `limpeza do ciclo 054 falhou: ${erros.join(" | ")}`);
}
