import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { withTransaction } from '../db/postgres';
import type { DbExecutor } from '../db/contracts';
import type { SessaoAdmin } from '../autenticacao/service';
import { provarTenant, revalidarTenant, type TenantComprovado } from '../saas/provar-tenant';
import { provarEstabelecimento } from '../saas/provar-estabelecimento';
import { lerEstadoComercial } from '../assinatura/estado';
import { contrato } from '../festas/repository';
import { exigir, inicioConteudo, type Conteudo } from './domain';
import { habilitado } from './service';
import { revogarAutorizacao } from './consentimento';

export const consultaBiblioteca = z.object({ filtro: z.enum(['todos', 'avulsos', 'vinculados']).default('todos'), pagina: z.coerce.number().int().min(1).max(10000).default(1) });
export const comandoBiblioteca = z.discriminatedUnion('acao', [
  z.object({ acao: z.literal('criar'), id: z.uuid() }).strict(),
  z.object({ acao: z.literal('vincular'), conviteId: z.uuid(), festaId: z.uuid(), revisao: z.int().positive(), usarDadosFesta: z.boolean() }).strict(),
]);

async function autorizado<T>(sessao: SessaoAdmin, escrita: boolean, fn: (tx: DbExecutor, tenant: TenantComprovado) => Promise<T>) {
  habilitado();
  return withTransaction(async tx => {
    const t = await provarTenant(tx, sessao);
    exigir((await tx.query(`SELECT id FROM festa_membership_capacidades WHERE empresa_id=$1 AND membership_id=$2
      AND capacidade=$3 AND revogado_em IS NULL`, [t.empresaComprovada, t.membershipId, escrita ? 'FESTA_OPERAR' : 'FESTA_CONSULTAR'])).rows.length, 'Sem permissão para acessar os convites.', 403);
    const comercial = await lerEstadoComercial(tx, t.empresaComprovada);
    exigir(comercial.acesso.nivel === 'COMPLETO' || (!escrita && comercial.acesso.nivel === 'SOMENTE_LEITURA'), 'O buffet precisa regularizar o acesso ao sistema.', 402);
    const r = await fn(tx, t);
    await revalidarTenant(tx, t);
    return r;
  });
}

// A listagem respeita a mesma unidade autorizada do editor. Nunca amplia acesso por conhecer o UUID.
const unidadeVisivel = (alias: string) => `(${alias}.estabelecimento_id IS NULL OR EXISTS (
  SELECT 1 FROM membership_estabelecimentos me JOIN estabelecimentos e ON e.id=me.estabelecimento_id
  WHERE me.empresa_id=$1 AND e.empresa_id=$1 AND me.membership_id=$2 AND me.estabelecimento_id=${alias}.estabelecimento_id
    AND e.status='ATIVO' AND me.status='ATIVA' AND me.vigente_desde<=clock_timestamp()
    AND (me.vigente_ate IS NULL OR me.vigente_ate>clock_timestamp())))`;

export function listarConvites(sessao: SessaoAdmin, raw: unknown) {
  const i = consultaBiblioteca.parse(raw);
  return autorizado(sessao, false, async (tx, t) => {
    const r = await tx.query<{ id: string; festaId: string | null; nome: string; data: string; publicado: boolean; temArte: boolean }>(`
      SELECT c.id,c.festa_id AS "festaId",c.rascunho->>'nome' AS nome,c.rascunho->>'data' AS data,
        c.publicado IS NOT NULL AS publicado,
        EXISTS(SELECT 1 FROM convite_artes a WHERE a.convite_id=c.id AND a.id::text=c.rascunho->>'arteId') AS "temArte"
      FROM convites c WHERE c.empresa_id=$1 AND ${unidadeVisivel('c')}
        AND ($3='todos' OR ($3='avulsos' AND c.festa_id IS NULL) OR ($3='vinculados' AND c.festa_id IS NOT NULL))
      ORDER BY c.atualizado_em DESC,c.id LIMIT 13 OFFSET $4`, [t.empresaComprovada, t.membershipId, i.filtro, (i.pagina - 1) * 12]);
    return { itens: r.rows.slice(0, 12), proxima: r.rows.length > 12, pagina: i.pagina };
  });
}

export function listarFestasParaConvite(sessao: SessaoAdmin, busca: string) {
  return autorizado(sessao, false, async (tx, t) => {
    return (await tx.query<{ id: string; nome: string; data: string; conviteId: string | null }>(`
      SELECT f.id,v.snapshot->'aniversariante'->>'nome' AS nome,v.snapshot->'evento'->>'data' AS data,c.id AS "conviteId"
      FROM festas f JOIN contratos co ON co.id=f.contrato_id JOIN fechamentos fe ON fe.id=co.fechamento_id
      JOIN contrato_fluxos cf ON cf.contrato_id=co.id JOIN contrato_versoes v ON v.id=cf.versao_vigente_id
      LEFT JOIN convites c ON c.festa_id=f.id AND c.empresa_id=fe.empresa_id
      WHERE fe.empresa_id=$1 AND ${unidadeVisivel('fe')} AND f.invalidada_em IS NULL AND co.status<>'CANCELADO'
        AND (v.snapshot->'aniversariante'->>'nome' ILIKE '%' || $3 || '%' OR v.snapshot->'evento'->>'data' LIKE '%' || $3 || '%')
      ORDER BY v.snapshot->'evento'->>'data' DESC,f.id LIMIT 50`, [t.empresaComprovada, t.membershipId, busca.slice(0, 80)])).rows;
  });
}

export function miniaturaConvite(sessao: SessaoAdmin, conviteId: string) {
  z.uuid().parse(conviteId);
  return autorizado(sessao, false, async (tx, t) => {
    const r = await tx.query<{ imagem: Buffer }>(`SELECT a.imagem FROM convites c JOIN convite_artes a
      ON a.convite_id=c.id AND a.empresa_id=c.empresa_id AND a.id::text=c.rascunho->>'arteId'
      WHERE c.id=$3 AND c.empresa_id=$1 AND ${unidadeVisivel('c')}`, [t.empresaComprovada, t.membershipId, conviteId]);
    exigir(r.rows[0], 'Imagem não encontrada.', 404);
    return r.rows[0].imagem;
  });
}

export function operarBiblioteca(sessao: SessaoAdmin, raw: unknown) {
  const i = comandoBiblioteca.parse(raw);
  return autorizado(sessao, true, async (tx, t) => {
    if (i.acao === 'criar') {
      // UUID da intenção: reclick ou resposta perdida não cria outro convite. Não reserva créditos.
      const existente = (await tx.query<{ id: string }>('SELECT id FROM convites WHERE id=$1 AND empresa_id=$2', [i.id, t.empresaComprovada])).rows[0];
      if (existente) return existente;
      exigir(Number((await tx.query<{ n: string }>('SELECT count(*) n FROM convites WHERE empresa_id=$1 AND festa_id IS NULL', [t.empresaComprovada])).rows[0].n) < 1000, 'Limite de convites avulsos atingido.', 409);
      await tx.query(`INSERT INTO convites(id,empresa_id,publico_token,rascunho,limite_festa,limite_cliente)
        VALUES($1,$2,$3,$4,3,2)`, [i.id, t.empresaComprovada, randomBytes(32).toString('base64url'), inicioConteudo(null)]);
      await tx.query(`INSERT INTO convite_eventos(convite_id,ator,acao) VALUES($1,$2,'CONVITE_AVULSO_CRIADO')`, [i.id, `USUARIO:${sessao.usuario_id}`]);
      return { id: i.id };
    }
    // Contrato → festa → convite: mesma ordem de locks do editor e das alterações contratuais.
    const l = (await tx.query<{ contrato_id: string; cliente_id: string; estabelecimento_id: string | null }>(`
      SELECT f.contrato_id,fe.cliente_id,fe.estabelecimento_id FROM festas f JOIN contratos co ON co.id=f.contrato_id
      JOIN fechamentos fe ON fe.id=co.fechamento_id WHERE f.id=$1 AND fe.empresa_id=$2`, [i.festaId, t.empresaComprovada])).rows[0];
    exigir(l, 'Festa não encontrada.', 404);
    if (l.estabelecimento_id) await provarEstabelecimento(tx, t, l.estabelecimento_id);
    const co = await contrato(tx, l.contrato_id, true);
    const f = (await tx.query<{ invalidada_em: Date | null }>('SELECT invalidada_em FROM festas WHERE id=$1 FOR UPDATE', [i.festaId])).rows[0];
    exigir(f && !f.invalidada_em && co && co.status !== 'CANCELADO', 'Esta festa não está disponível.', 409);
    const c = (await tx.query<{ id: string; empresa_id: string; festa_id: string | null; revisao: number; rascunho: Conteudo }>(
      'SELECT id,empresa_id,festa_id,revisao,rascunho FROM convites WHERE id=$1 AND empresa_id=$2 FOR UPDATE', [i.conviteId, t.empresaComprovada])).rows[0];
    exigir(c, 'Convite não encontrado.', 404);
    if (c.festa_id === i.festaId) return { id: c.id }; // repetição da mesma vinculação
    exigir(!c.festa_id, 'Este convite já está vinculado a uma festa.', 409);
    exigir(c.revisao === i.revisao, 'O convite foi alterado. Recarregue antes de vincular.', 409);
    exigir(!(await tx.query('SELECT id FROM convites WHERE festa_id=$1', [i.festaId])).rows.length, 'A festa já tem um convite. Abra o convite existente.', 409);
    exigir(!(await tx.query("SELECT id FROM convite_geracoes WHERE convite_id=$1 AND estado IN ('RESERVADA','INCERTA')", [c.id])).rows.length, 'Aguarde a conclusão da geração antes de vincular.', 409);
    const dadosFesta = inicioConteudo(co.snapshot);
    const conteudo = i.usarDadosFesta ? { ...c.rascunho, nome: dadosFesta.nome, idade: dadosFesta.idade, data: dadosFesta.data, horario: dadosFesta.horario } : c.rascunho;
    // O responsável/evento pode mudar. Preserva evidências antigas e exige nova autorização para futuras gerações.
    await revogarAutorizacao(tx, c, `USUARIO:${sessao.usuario_id}`);
    await tx.query(`UPDATE convites SET festa_id=$3,cliente_id=$4,estabelecimento_id=$5,versao_contrato_id=$6,
      rascunho=$7,publicado=NULL,revisao=revisao+1,atualizado_em=now() WHERE id=$1 AND empresa_id=$2`,
    [c.id, t.empresaComprovada, i.festaId, l.cliente_id, l.estabelecimento_id, co.versao_id, conteudo]);
    await tx.query(`INSERT INTO convite_eventos(convite_id,ator,acao,detalhe) VALUES($1,$2,'FESTA_VINCULADA',$3)`,
      [c.id, `USUARIO:${sessao.usuario_id}`, { festaId: i.festaId, dadosAtualizados: i.usarDadosFesta }]);
    return { id: c.id };
  });
}
