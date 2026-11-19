import { ITEM_DE_ESCOLHA_SQL } from "../../comercial/itens-de-escolha";
import { faltaEscolha } from '../../comercial/limites-escolhas';
import type { DbExecutor } from '../../db/contracts';
import { FechamentoServiceError } from './errors';
import { catalogoBuffetPorEmpresa } from '../../comercial/catalogo-buffet-estrutura';

type Escolha = { categoria: string; categoriaId: string; categoriaNome: string; itemId: string; itemNome: string };

/** Resolve uma única vez: texto contratual e trilha de escolhas usam os mesmos nomes do servidor. */
export async function resolverEscolhasBuffet(tx: DbExecutor, pacoteId: string, escolhas: Record<string, string[]> | undefined, status?: string) {
  const entradas = Object.entries(escolhas ?? {}).flatMap(([categoria, ids]) => ids.map(id => ({ categoria, id })));
  if (status !== 'DEFINIDO' && !entradas.length) return null;
  const ids = entradas.map(e => e.id);
  // O editor aceita até 40 categorias, cada uma com até 30 escolhas.
  if (status !== 'DEFINIDO' || ids.length > 40 * 30 || new Set(ids).size !== ids.length)
    throw new FechamentoServiceError('BUFFET_INVALIDO', 'Escolhas do buffet inválidas.', 400);
  const porEmpresa = await catalogoBuffetPorEmpresa(tx);
  const regras = await tx.query<{ categoria_id: string; codigo: string; nome: string; min: number; max: number; item_id: string | null; item_nome: string | null }>(`
    SELECT c.id AS categoria_id, c.codigo, c.nome, r.escolhas_min AS min, r.escolhas_max AS max,
           i.id AS item_id, i.nome AS item_nome
      FROM pacote_buffet_categorias r
      JOIN pacotes p ON p.id = r.pacote_id
      JOIN buffet_categorias c ON c.id = r.categoria_id AND c.ativo
      LEFT JOIN buffet_itens i ON i.categoria_id = c.id AND i.ativo AND i.id = ANY($2::uuid[])
        ${porEmpresa ? 'AND i.empresa_id = p.empresa_id' : ''}
        AND ${ITEM_DE_ESCOLHA_SQL}
     WHERE p.id = $1 AND r.ativo ${porEmpresa ? 'AND c.empresa_id = p.empresa_id' : ''}
     ORDER BY c.ordem_exibicao, c.nome`, [pacoteId, ids]);
  const disponiveis = new Map(regras.rows.map(item => [item.item_id, item]));
  const aplicadas: Escolha[] = entradas.map(escolha => {
    const item = disponiveis.get(escolha.id);
    if (!item?.item_nome || item.codigo !== escolha.categoria || (escolhas?.[item.codigo]?.length ?? 0) > item.max)
      throw new FechamentoServiceError('BUFFET_INVALIDO', 'Opção de buffet indisponível para este pacote.', 409);
    return { categoria: item.codigo, categoriaId: item.categoria_id, categoriaNome: item.nome, itemId: escolha.id, itemNome: item.item_nome };
  });
  const pendencia = faltaEscolha(regras.rows, escolhas);
  if (pendencia) throw new FechamentoServiceError('BUFFET_INVALIDO', pendencia, 409);
  if (!entradas.length) return null;
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
