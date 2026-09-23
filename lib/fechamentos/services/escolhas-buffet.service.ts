import type { DbExecutor } from '../../db/contracts';
import { FechamentoServiceError } from './errors';

type Escolha = { categoria: string; categoriaId: string; categoriaNome: string; itemId: string; itemNome: string };

/** Resolve uma única vez: texto contratual e trilha de escolhas usam os mesmos nomes do servidor. */
export async function resolverEscolhasBuffet(tx: DbExecutor, pacoteId: string, escolhas: Record<string, string[]> | undefined, status?: string) {
  const entradas = Object.entries(escolhas ?? {}).flatMap(([categoria, ids]) => ids.map(id => ({ categoria, id })));
  if (!entradas.length) return null; // Preserva fechamento legado/administrativo com texto livre.
  if (status !== 'DEFINIDO' || entradas.length > 60 || new Set(entradas.map(e => e.id)).size !== entradas.length)
    throw new FechamentoServiceError('BUFFET_INVALIDO', 'Escolhas do buffet inválidas.', 400);
  const aplicadas: Escolha[] = [];
  for (const escolha of entradas) {
    const item = (await tx.query<{ categoria_id: string; categoria_nome: string; item_nome: string; escolhas_max: number }>(`
      SELECT c.id categoria_id,c.nome categoria_nome,i.nome item_nome,r.escolhas_max
      FROM pacote_buffet_categorias r JOIN buffet_categorias c ON c.id=r.categoria_id AND c.ativo
      JOIN buffet_itens i ON i.categoria_id=c.id AND i.ativo
      WHERE r.pacote_id=$1 AND r.ativo AND c.codigo=$2 AND i.id=$3
        AND (r.modo_itens='TODOS_ATIVOS' OR EXISTS
          (SELECT 1 FROM pacote_buffet_itens x WHERE x.pacote_id=r.pacote_id AND x.categoria_id=c.id AND x.item_id=i.id))`,
    [pacoteId, escolha.categoria, escolha.id])).rows[0];
    if (!item || (escolhas?.[escolha.categoria]?.length ?? 0) > item.escolhas_max)
      throw new FechamentoServiceError('BUFFET_INVALIDO', 'Opção de buffet indisponível para este pacote.', 409);
    aplicadas.push({ categoria: escolha.categoria, categoriaId: item.categoria_id, categoriaNome: item.categoria_nome, itemId: escolha.id, itemNome: item.item_nome });
  }
  const nomes = (codigo: string) => aplicadas.filter(e => e.categoria === codigo).map(e => e.itemNome).join(', ') || null;
  const conhecidos = ['SALGADOS', 'BEBIDAS', 'DOCES', 'MASSA_BOLO', 'RECHEIO_BOLO', 'LEMBRANCINHAS', 'EMPRATADOS', 'BOMBONS'];
  const outros = [...new Set(aplicadas.filter(e => !conhecidos.includes(e.categoria)).map(e => e.categoria))]
    .map(codigo => `${aplicadas.find(e => e.categoria === codigo)!.categoriaNome}: ${nomes(codigo)}`).join('; ');
  return { aplicadas, campos: {
    buffetSalgados: nomes('SALGADOS'), buffetDoces: nomes('DOCES'),
    buffetBolo: [nomes('MASSA_BOLO') && `Massa: ${nomes('MASSA_BOLO')}`, nomes('RECHEIO_BOLO') && `Recheio: ${nomes('RECHEIO_BOLO')}`].filter(Boolean).join('; ') || null,
    buffetLembrancinha: nomes('LEMBRANCINHAS'), buffetEmpratado: nomes('EMPRATADOS'), buffetBombom: nomes('BOMBONS'),
    // Bebidas/outros podem conter instruções livres no formulário atual.
    ...(nomes('BEBIDAS') ? { buffetBebidas: nomes('BEBIDAS') } : {}),
  }, outros };
}

export async function gravarEscolhasBuffet(tx: DbExecutor, fechamentoId: string, escolhas: NonNullable<Awaited<ReturnType<typeof resolverEscolhasBuffet>>>) {
  const snapshot = (await tx.query<{ id: string }>('INSERT INTO fechamento_buffet_snapshots (fechamento_id) VALUES ($1) RETURNING id', [fechamentoId])).rows[0];
  for (const [indice, item] of escolhas.aplicadas.entries()) {
    await tx.query(`INSERT INTO fechamento_buffet_escolhas
      (snapshot_id,categoria_id,item_id,categoria_nome_aplicado,item_nome_aplicado,ordem_aplicada)
      VALUES ($1,$2,$3,$4,$5,$6)`, [snapshot.id, item.categoriaId, item.itemId, item.categoriaNome, item.itemNome, indice + 1]);
  }
}
