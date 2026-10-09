import { createHash, randomBytes } from 'node:crypto';
import type { DbExecutor } from '../db/contracts';
import { exigir } from './domain';
import type { ComandoFamilia, Familia, FamiliaPublica } from './familias-domain';
type ConviteFamilia = { id: string; empresa_id: string; publico_token: string };
type Linha = { id: string; nome: string; adultos_previstos: number; criancas_previstas: number; ativa: boolean; revisao: number; token_hash: string | null };
const hash = (token: string) => createHash('sha256').update(token).digest('hex');

export async function listarFamilias(tx: DbExecutor, c: ConviteFamilia): Promise<Familia[]> {
  return (await tx.query<Familia>(`SELECT f.id,f.nome,f.adultos_previstos adultos,f.criancas_previstas criancas,f.ativa,f.revisao,
    (f.token_hash IS NOT NULL) "linkAtivo",r.presenca,r.adultos "adultosConfirmados",r.criancas "criancasConfirmadas"
    FROM convite_familias f LEFT JOIN convite_respostas r ON r.familia_id=f.id AND r.convite_id=f.convite_id
    WHERE f.convite_id=$1 AND f.empresa_id=$2 ORDER BY f.criado_em,f.id LIMIT 500`, [c.id, c.empresa_id])).rows;
}

/** Chamado com o convite travado e o acesso de escrita comprovado. Token em claro só na resposta. */
export async function operarFamilia(tx: DbExecutor, c: ConviteFamilia, i: ComandoFamilia) {
  if (i.acao === 'familia_adicionar') {
    const anterior = (await tx.query<Linha>('SELECT * FROM convite_familias WHERE id=$1 FOR UPDATE', [i.id])).rows[0] as (Linha & { convite_id: string; empresa_id: string }) | undefined;
    if (anterior) {
      exigir(anterior.convite_id === c.id && anterior.empresa_id === c.empresa_id && anterior.nome === i.nome && anterior.adultos_previstos === i.adultos && anterior.criancas_previstas === i.criancas, 'Identificador de família já utilizado.');
      return { id: anterior.id, revisao: anterior.revisao, linkFamilia: null, repetida: true };
    }
    exigir(Number((await tx.query<{ n: string }>('SELECT count(*) n FROM convite_familias WHERE convite_id=$1', [c.id])).rows[0].n) < 500, 'Limite de 500 famílias por convite atingido.');
    const token = randomBytes(32).toString('base64url');
    await tx.query(`INSERT INTO convite_familias(id,convite_id,empresa_id,nome,adultos_previstos,criancas_previstas,token_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7)`, [i.id, c.id, c.empresa_id, i.nome, i.adultos, i.criancas, hash(token)]);
    return { id: i.id, revisao: 1, linkFamilia: `/convite/${c.publico_token}#familia=${token}`, repetida: false };
  }
  const f = (await tx.query<Linha>('SELECT * FROM convite_familias WHERE id=$1 AND convite_id=$2 AND empresa_id=$3 FOR UPDATE', [i.id, c.id, c.empresa_id])).rows[0];
  exigir(f, 'Família não encontrada neste convite.', 404);
  exigir(f.revisao === i.revisao, 'A família foi alterada por outra pessoa. Atualize a lista e tente novamente.');
  if (i.acao === 'familia_editar') {
    exigir(f.ativa, 'Restaure a família antes de editar.');
    await tx.query('UPDATE convite_familias SET nome=$2,adultos_previstos=$3,criancas_previstas=$4,revisao=revisao+1,atualizado_em=now() WHERE id=$1', [f.id, i.nome, i.adultos, i.criancas]);
  } else if (i.acao === 'familia_status') {
    await tx.query('UPDATE convite_familias SET ativa=$2,token_hash=NULL,revisao=revisao+1,atualizado_em=now() WHERE id=$1', [f.id, i.ativa]);
  } else {
    exigir(f.ativa, 'Restaure a família antes de gerar um link.');
    const token = i.habilitado ? randomBytes(32).toString('base64url') : null;
    await tx.query('UPDATE convite_familias SET token_hash=$2,revisao=revisao+1,atualizado_em=now() WHERE id=$1', [f.id, token ? hash(token) : null]);
    return { id: f.id, revisao: f.revisao + 1, linkFamilia: token ? `/convite/${c.publico_token}#familia=${token}` : null };
  }
  return { id: f.id, revisao: f.revisao + 1, salvo: true };
}

export async function validarFamilia(tx: DbExecutor, c: ConviteFamilia, token: string) {
  exigir(/^[\w-]{43}$/.test(token), 'Link da família indisponível. Solicite um novo ao organizador.', 404);
  const f = (await tx.query<Linha>(`SELECT * FROM convite_familias WHERE convite_id=$1 AND empresa_id=$2 AND token_hash=$3 AND ativa=true`, [c.id, c.empresa_id, hash(token)])).rows[0];
  exigir(f, 'Link da família indisponível. Solicite um novo ao organizador.', 404); return f;
}
export async function dadosFamiliaPublica(tx: DbExecutor, c: ConviteFamilia, token: string): Promise<FamiliaPublica> {
  const f = await validarFamilia(tx, c, token);
  const r = (await tx.query<{ presenca: boolean; adultos: number; criancas: number }>('SELECT presenca,adultos,criancas FROM convite_respostas WHERE convite_id=$1 AND familia_id=$2', [c.id, f.id])).rows[0];
  return { nome: f.nome, presenca: r?.presenca ?? null, adultos: r?.adultos ?? f.adultos_previstos, criancas: r?.criancas ?? f.criancas_previstas };
}
