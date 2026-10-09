import { createHash, randomBytes } from 'node:crypto';
import { db, withTransaction } from '../db/postgres';
import type { DbExecutor } from '../db/contracts';
import type { SessaoAdmin } from '../autenticacao/service';
import { provarTenant, revalidarTenant } from '../saas/provar-tenant';
import { provarEstabelecimento } from '../saas/provar-estabelecimento';
import { contrato } from '../festas/repository';
import { lerEstadoComercial } from '../assinatura/estado';
import { comandoSchema, conteudoSchema, ConviteError, disponiveis, exigir, inicioConteudo, respostaSchema, validarCredito, type Conteudo, type Cotas } from './domain';
import { gerarImagem, iaConfigurada, normalizarImagem, MODELO } from './imagem';

export type Acesso = { tipo: 'admin'; sessao: SessaoAdmin; festaId: string } | { tipo: 'cliente'; token: string };
type Convite = { id: string; empresa_id: string; festa_id: string; cliente_id: string; estabelecimento_id: string | null;
  publico_token: string; editor_hash: string | null; editor_expira_em: Date | null; rascunho: Conteudo; publicado: Conteudo | null;
  versao_contrato_id: string; limite_festa: number; limite_cliente: number; usado_festa: number; usado_cliente: number; revisao: number };
type Ligacao = { empresa_id: string; cliente_id: string; estabelecimento_id: string | null; contrato_id: string; invalidada_em: Date | null };
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const ator = (a: Acesso, c: Convite) => a.tipo === 'admin' ? `USUARIO:${a.sessao.usuario_id}` : `CLIENTE:${c.cliente_id}`;
export function habilitado() { exigir(process.env.CONVITES_ENABLED === 'true', 'Convites ainda não estão disponíveis neste ambiente.', 503); }
const ligacaoSql = `SELECT fe.empresa_id,fe.cliente_id,fe.estabelecimento_id,f.contrato_id,f.invalidada_em
 FROM festas f JOIN contratos co ON co.id=f.contrato_id JOIN fechamentos fe ON fe.id=co.fechamento_id`;

async function comConvite<T>(a: Acesso, escrever: boolean, fn: (tx: DbExecutor, c: Convite, versao: string) => Promise<T>): Promise<T> {
  habilitado();
  return withTransaction(async tx => {
    let empresa: string, festa: string;
    let tenant: Awaited<ReturnType<typeof provarTenant>> | undefined;
    if (a.tipo === 'admin') {
      tenant = await provarTenant(tx, a.sessao);
      empresa = tenant.empresaComprovada; festa = a.festaId;
      const cap = escrever ? 'FESTA_OPERAR' : 'FESTA_CONSULTAR';
      exigir((await tx.query(`SELECT id FROM festa_membership_capacidades WHERE empresa_id=$1 AND membership_id=$2 AND capacidade=$3 AND revogado_em IS NULL`, [empresa, tenant.membershipId, cap])).rows.length, 'Sem permissão para administrar o convite.', 403);
    } else {
      exigir(/^[\w-]{43}$/.test(a.token), 'Acesso ao convite indisponível.', 404);
      const pre = (await tx.query<Convite>('SELECT * FROM convites WHERE editor_hash=$1 AND editor_expira_em>now()', [hash(a.token)])).rows[0];
      exigir(pre, 'Acesso ao convite indisponível.', 404);
      empresa = pre.empresa_id; festa = pre.festa_id;
      exigir((await tx.query("SELECT id FROM empresas WHERE id=$1 AND status='ATIVA' FOR UPDATE", [empresa])).rows.length, 'Acesso ao convite indisponível.', 404);
    }
    const comercial = await lerEstadoComercial(tx, empresa);
    exigir(comercial.acesso.nivel === 'COMPLETO' || (!escrever && comercial.acesso.nivel === 'SOMENTE_LEITURA'), 'O buffet precisa regularizar o acesso ao sistema.', 402);
    const l = (await tx.query<Ligacao>(`${ligacaoSql} WHERE f.id=$1 AND fe.empresa_id=$2`, [festa, empresa])).rows[0];
    exigir(l, 'Festa não encontrada.', 404);
    if (tenant && l.estabelecimento_id) await provarEstabelecimento(tx, tenant, l.estabelecimento_id);
    const co = await contrato(tx, l.contrato_id, true);
    const f = (await tx.query<{ invalidada_em: Date | null }>('SELECT invalidada_em FROM festas WHERE id=$1 FOR UPDATE', [festa])).rows[0];
    exigir(f && !f.invalidada_em && co && co.status !== 'CANCELADO', 'Esta festa não está disponível para convites.', 409);
    let c = (await tx.query<Convite>('SELECT * FROM convites WHERE festa_id=$1 AND empresa_id=$2 FOR UPDATE', [festa, empresa])).rows[0];
    // Abertura administrativa cria só o rascunho; nunca publica nem libera o cliente automaticamente.
    if (!c && a.tipo === 'admin' && escrever) {
      c = (await tx.query<Convite>(`INSERT INTO convites(empresa_id,festa_id,cliente_id,estabelecimento_id,publico_token,rascunho,versao_contrato_id)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [empresa, festa, l.cliente_id, l.estabelecimento_id, token(), inicioConteudo(co.snapshot), co.versao_id])).rows[0];
      await evento(tx, c, a, 'CONVITE_CRIADO');
    }
    exigir(c, 'Crie o convite para começar.', 404);
    if (a.tipo === 'cliente') exigir(c.editor_hash === hash(a.token) && c.editor_expira_em && c.editor_expira_em > new Date(), 'Acesso ao convite indisponível.', 404);
    const r = await fn(tx, c, co.versao_id);
    if (tenant) await revalidarTenant(tx, tenant);
    return r;
  });
}

async function evento(tx: DbExecutor, c: Convite, a: Acesso, acao: string, detalhe: object = {}) {
  await tx.query('INSERT INTO convite_eventos(convite_id,ator,acao,detalhe) VALUES($1,$2,$3,$4)', [c.id, ator(a, c), acao, detalhe]);
}
async function cotas(tx: DbExecutor, c: Convite): Promise<Cotas> {
  const w = (await tx.query<{ limite: number; usado: number }>(`SELECT CASE WHEN w.ativo THEN w.limite_mensal ELSE 0 END limite,COALESCE(u.usado,0)::int usado
    FROM convite_carteiras w LEFT JOIN convite_consumos u ON u.empresa_id=w.empresa_id AND u.mes=date_trunc('month',now() AT TIME ZONE 'America/Sao_Paulo')::date WHERE w.empresa_id=$1`, [c.empresa_id])).rows[0];
  return { empresa: w?.limite ?? 0, empresaUsado: w?.usado ?? 0, festa: c.limite_festa, festaUsado: c.usado_festa, cliente: c.limite_cliente, clienteUsado: c.usado_cliente };
}
export async function consultar(a: Acesso, criar = false) {
  return comConvite(a, criar, async (tx, c, versao) => {
    const limite = await cotas(tx, c);
    const artes = (await tx.query<{ id: string; imagem: Buffer; origem: string }>('SELECT id,imagem,origem FROM convite_artes WHERE convite_id=$1 AND empresa_id=$2 ORDER BY criado_em DESC', [c.id, c.empresa_id])).rows.map(r => ({ id: r.id, origem: r.origem, url: `data:image/webp;base64,${r.imagem.toString('base64')}` }));
    const respostas = (await tx.query<{ nome: string; presenca: boolean; adultos: number; criancas: number }>('SELECT nome,presenca,adultos,criancas FROM convite_respostas WHERE convite_id=$1 ORDER BY atualizado_em DESC LIMIT 2000', [c.id])).rows;
    const historico = (await tx.query<{ acao: string; ator: string; criado_em: string }>('SELECT acao,split_part(ator,\':\',1) ator,criado_em FROM convite_eventos WHERE convite_id=$1 ORDER BY id DESC LIMIT 20', [c.id])).rows;
    return { id: c.id, conteudo: c.rascunho, revisao: c.revisao, publicado: !!c.publicado, desatualizado: c.versao_contrato_id !== versao,
      linkPublico: `/convite/${c.publico_token}`, clienteHabilitado: !!c.editor_hash && !!c.editor_expira_em && c.editor_expira_em > new Date(),
      cotas: a.tipo === 'admin' ? limite : { festa: limite.festa, festaUsado: limite.festaUsado, cliente: limite.cliente, clienteUsado: limite.clienteUsado },
      disponiveis: disponiveis(limite, a.tipo === 'cliente'), iaDisponivel: iaConfigurada(), artes, respostas, historico };
  });
}

async function limitarArtes(tx: DbExecutor, c: Convite) {
  exigir(Number((await tx.query<{ n: string }>(`SELECT (SELECT count(*) n FROM convite_artes WHERE convite_id=$1)
    +(SELECT count(*) FROM convite_geracoes WHERE convite_id=$1 AND estado='RESERVADA') AS n`, [c.id])).rows[0].n) < 20, 'Limite de 20 artes por festa atingido. Reutilize uma arte do histórico.', 409);
}
async function guardarArte(tx: DbExecutor, c: Convite, imagem: Buffer, origem: 'IA' | 'UPLOAD') {
  return (await tx.query<{ id: string }>('INSERT INTO convite_artes(convite_id,empresa_id,imagem,origem) VALUES($1,$2,$3,$4) RETURNING id', [c.id, c.empresa_id, imagem, origem])).rows[0].id;
}
export async function comandar(a: Acesso, raw: unknown): Promise<object> {
  const i = comandoSchema.parse(raw);
  if (i.acao === 'gerar') return gerar(a, i);
  // Reencoding fora da transação; só após autenticação da rota (cliente revalidado abaixo).
  if (i.acao === 'upload') await comConvite(a, true, async () => undefined);
  const imagem = i.acao === 'upload' ? await normalizarImagem(i.imagem) : null;
  return comConvite(a, true, async (tx, c, versao) => {
    if (i.acao === 'acesso') {
      exigir(a.tipo === 'admin', 'Somente o buffet pode liberar acesso.', 403);
      const novo = i.habilitado ? token() : null;
      await tx.query("UPDATE convites SET editor_hash=$2,editor_expira_em=CASE WHEN $2::text IS NULL THEN NULL ELSE now()+interval '180 days' END WHERE id=$1", [c.id, novo ? hash(novo) : null]);
      await evento(tx, c, a, i.habilitado ? 'ACESSO_RENOVADO' : 'ACESSO_REVOGADO');
      return { linkCliente: novo ? `/convites/criar#${novo}` : null };
    }
    if (i.acao === 'cotas') {
      exigir(a.tipo === 'admin', 'Somente o buffet pode distribuir créditos.', 403);
      const tenant = await provarTenant(tx, a.sessao);
      exigir(tenant.papelAtual === 'REPRESENTANTE_AUTORIZADO', 'Somente a gestão pode alterar cotas.', 403);
      const limite = await cotas(tx, c);
      exigir(i.festa >= c.usado_festa && i.cliente >= c.usado_cliente && i.cliente <= i.festa, 'A cota não pode ser menor que o uso nem a cota do cliente maior que a da festa.');
      exigir(i.festa - c.usado_festa <= Math.max(0, limite.empresa - limite.empresaUsado), 'A empresa não tem esse saldo disponível.');
      await tx.query('UPDATE convites SET limite_festa=$2,limite_cliente=$3 WHERE id=$1', [c.id, i.festa, i.cliente]);
    } else if (i.acao === 'upload') {
      await limitarArtes(tx, c);
      const arteId = await guardarArte(tx, c, imagem!, 'UPLOAD');
      await evento(tx, c, a, 'ARTE_ENVIADA', { arteId }); return { arteId };
    } else {
      exigir(i.revisao === c.revisao, 'O convite foi alterado por outra pessoa. Recarregue antes de salvar.');
      if (i.acao === 'excluir_arte') {
        exigir((await tx.query('SELECT id FROM convite_artes WHERE id=$1 AND convite_id=$2 AND empresa_id=$3', [i.arteId, c.id, c.empresa_id])).rows.length, 'Imagem não encontrada neste convite.', 404);
        exigir(c.publicado?.arteId !== i.arteId, 'Esta imagem está no convite publicado. Remova ou substitua a imagem e publique a alteração antes de excluí-la da galeria.');
        // O histórico e o consumo permanecem; só desfazemos o vínculo com o arquivo excluído.
        await tx.query('UPDATE convite_geracoes SET arte_id=NULL WHERE arte_id=$1 AND convite_id=$2 AND empresa_id=$3', [i.arteId, c.id, c.empresa_id]);
        await tx.query('DELETE FROM convite_artes WHERE id=$1 AND convite_id=$2 AND empresa_id=$3', [i.arteId, c.id, c.empresa_id]);
        const rascunho = c.rascunho.arteId === i.arteId ? { ...c.rascunho, arteId: null } : c.rascunho;
        await tx.query('UPDATE convites SET rascunho=$2,revisao=revisao+1,atualizado_em=now() WHERE id=$1', [c.id, rascunho]);
        await evento(tx, c, a, 'ARTE_EXCLUIDA', { arteId: i.arteId });
        return { excluida: true };
      }
      if (i.acao === 'despublicar') await tx.query('UPDATE convites SET publicado=NULL,revisao=revisao+1,atualizado_em=now() WHERE id=$1', [c.id]);
      else {
        if (i.conteudo.arteId) exigir((await tx.query('SELECT id FROM convite_artes WHERE id=$1 AND convite_id=$2 AND empresa_id=$3', [i.conteudo.arteId, c.id, c.empresa_id])).rows.length, 'Arte não pertence a este convite.', 400);
        await tx.query(`UPDATE convites SET rascunho=$2,publicado=CASE WHEN $3 THEN $2::jsonb ELSE publicado END,
          versao_contrato_id=CASE WHEN $3 THEN $4::uuid ELSE versao_contrato_id END,revisao=revisao+1,atualizado_em=now() WHERE id=$1`, [c.id, i.conteudo, i.acao === 'publicar', versao]);
      }
    }
    await evento(tx, c, a, i.acao.toUpperCase(), i.acao === 'cotas' ? { festa: i.festa, cliente: i.cliente } : {});
    return { salvo: true };
  });
}

async function gerar(a: Acesso, i: Extract<ReturnType<typeof comandoSchema.parse>, { acao: 'gerar' }>) {
  exigir(iaConfigurada(), 'A geração com IA ainda não foi habilitada pelo buffet.', 503);
  const payload = hash(JSON.stringify({ prompt: i.prompt, referencias: i.referencias }));
  const reserva = await comConvite(a, true, async (tx, c) => {
    const anterior = (await tx.query<{ estado: string; arte_id: string | null; payload_hash: string; ator: string; convite_id: string }>('SELECT * FROM convite_geracoes WHERE id=$1', [i.chave])).rows[0];
    if (anterior) {
      exigir(anterior.convite_id === c.id && anterior.ator === ator(a, c) && anterior.payload_hash === payload, 'Chave de geração já utilizada.', 409);
      return { repetida: true as const, estado: anterior.estado, arteId: anterior.arte_id };
    }
    await limitarArtes(tx, c);
    exigir(!(await tx.query("SELECT id FROM convite_geracoes WHERE convite_id=$1 AND estado='RESERVADA'", [c.id])).rows.length, 'Já existe uma geração em andamento para esta festa.', 409);
    const refs: Buffer[] = [];
    for (const id of i.referencias) {
      const ref = (await tx.query<{ imagem: Buffer }>('SELECT imagem FROM convite_artes WHERE id=$1 AND convite_id=$2 AND empresa_id=$3', [id, c.id, c.empresa_id])).rows[0];
      exigir(ref, 'Referência não pertence à festa.', 400); refs.push(ref.imagem);
    }
    // Carteira + consumo mensal + convite travados; cliente não escolhe modelo, custo ou empresa.
    await tx.query('SELECT empresa_id FROM convite_carteiras WHERE empresa_id=$1 FOR UPDATE', [c.empresa_id]);
    const limites = await cotas(tx, c); validarCredito(limites, a.tipo === 'cliente');
    const teto = Number(process.env.CONVITES_IA_TETO_DIARIO_MICROUSD);
    exigir(Number.isSafeInteger(teto) && teto >= 300000, 'Orçamento de IA não configurado.', 503);
    // Reserva conservadora por pedido; não é medição de faturamento do provedor.
    const global = await tx.query(`INSERT INTO convite_orcamento_global(dia,reservado_microusd) VALUES((now() AT TIME ZONE 'America/Sao_Paulo')::date,300000)
      ON CONFLICT(dia) DO UPDATE SET reservado_microusd=convite_orcamento_global.reservado_microusd+300000
      WHERE convite_orcamento_global.reservado_microusd+300000 <= $1 RETURNING dia`, [teto]);
    exigir(global.rows.length, 'O limite diário de geração foi atingido. Tente outro dia.', 402);
    await tx.query(`INSERT INTO convite_consumos(empresa_id,mes,usado) VALUES($1,date_trunc('month',now() AT TIME ZONE 'America/Sao_Paulo')::date,1)
      ON CONFLICT(empresa_id,mes) DO UPDATE SET usado=convite_consumos.usado+1`, [c.empresa_id]);
    await tx.query('UPDATE convites SET usado_festa=usado_festa+1,usado_cliente=usado_cliente+$2 WHERE id=$1', [c.id, a.tipo === 'cliente' ? 1 : 0]);
    await tx.query('INSERT INTO convite_geracoes(id,convite_id,empresa_id,ator,payload_hash,modelo) VALUES($1,$2,$3,$4,$5,$6)', [i.chave, c.id, c.empresa_id, ator(a, c), payload, MODELO]);
    await evento(tx, c, a, 'IA_RESERVADA', { geracao: i.chave });
    return { repetida: false as const, c, refs };
  });
  if (reserva.repetida) return reserva;
  try {
    const resultado = await gerarImagem(i.prompt, reserva.refs);
    const arteId = await withTransaction(async tx => {
      await tx.query('SELECT id FROM convites WHERE id=$1 FOR UPDATE', [reserva.c.id]);
      const id = await guardarArte(tx, reserva.c, resultado.imagem, 'IA');
      await tx.query("UPDATE convite_geracoes SET estado='CONCLUIDA',arte_id=$2,uso=$3 WHERE id=$1 AND estado='RESERVADA'", [i.chave, id, resultado.uso]);
      await evento(tx, reserva.c, a, 'IA_CONCLUIDA', { geracao: i.chave, arteId: id }); return id;
    });
    return { arteId, estado: 'CONCLUIDA' };
  } catch {
    // Timeout não comprova ausência de cobrança. Não reenvia nem devolve saldo automaticamente.
    await db().query("UPDATE convite_geracoes SET estado='INCERTA' WHERE id=$1 AND estado='RESERVADA'", [i.chave]);
    throw new ConviteError('Não foi possível confirmar a geração. O crédito ficou reservado para conferência pelo buffet; não repetimos o pedido.', 502);
  }
}

export async function publico(tokenPublico: string, executor: DbExecutor = db()) {
  habilitado(); exigir(/^[\w-]{43}$/.test(tokenPublico), 'Convite indisponível.', 404);
  const c = (await executor.query<Convite>(`SELECT ci.* FROM convites ci JOIN festas f ON f.id=ci.festa_id
    JOIN contratos co ON co.id=f.contrato_id JOIN contrato_fluxos cf ON cf.contrato_id=co.id
    JOIN empresas e ON e.id=ci.empresa_id WHERE ci.publico_token=$1 AND ci.publicado IS NOT NULL
      AND f.invalidada_em IS NULL AND co.status<>'CANCELADO' AND e.status='ATIVA' AND cf.versao_vigente_id=ci.versao_contrato_id`, [tokenPublico])).rows[0];
  exigir(c, 'Convite indisponível. Solicite o link atualizado ao organizador.', 404);
  const conteudo = conteudoSchema.parse(c.publicado);
  return { c, conteudo };
}
export async function artePublica(tokenPublico: string) {
  const { c, conteudo } = await publico(tokenPublico);
  exigir(conteudo.arteId, 'Arte não encontrada.', 404);
  const arte = (await db().query<{ imagem: Buffer }>('SELECT imagem FROM convite_artes WHERE id=$1 AND convite_id=$2 AND empresa_id=$3', [conteudo.arteId, c.id, c.empresa_id])).rows[0];
  exigir(arte, 'Arte não encontrada.', 404); return arte.imagem;
}
export async function confirmar(tokenPublico: string, raw: unknown) {
  const i = respostaSchema.parse(raw);
  exigir(i.site === '', 'Não foi possível confirmar.', 400);
  const { c, conteudo } = await publico(tokenPublico);
  exigir(conteudo.confirmarPresenca, 'As confirmações estão encerradas.');
  const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  exigir(conteudo.data >= hoje, 'As confirmações desta festa estão encerradas.');
  return withTransaction(async tx => {
    // Mesma ordem das alterações contratuais; cancelamento/reagendamento não pode disputar a confirmação.
    const l = (await tx.query<Ligacao>(`${ligacaoSql} WHERE f.id=$1 AND fe.empresa_id=$2`, [c.festa_id, c.empresa_id])).rows[0];
    exigir(l, 'Convite indisponível.', 404);
    await contrato(tx, l.contrato_id, true);
    await tx.query('SELECT id FROM festas WHERE id=$1 FOR UPDATE', [c.festa_id]);
    const vigente = await publico(tokenPublico, tx);
    // O organizador pode ter alterado a data enquanto esta resposta aguardava o lock.
    const hojeVigente = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    exigir(vigente.conteudo.data >= hojeVigente, 'As confirmações desta festa estão encerradas.');
    const atual = (await tx.query<Convite>('SELECT * FROM convites WHERE id=$1 FOR UPDATE', [c.id])).rows[0];
    exigir(atual.publicado?.confirmarPresenca, 'As confirmações estão encerradas.');
    const repeticao = (await tx.query('SELECT chave FROM convite_respostas WHERE convite_id=$1 AND chave=$2', [c.id, i.chave])).rows.length;
    if (!repeticao) exigir(Number((await tx.query<{ n: string }>('SELECT count(*) n FROM convite_respostas WHERE convite_id=$1', [c.id])).rows[0].n) < 2000, 'Limite de respostas atingido. Contate o organizador.');
    await tx.query(`INSERT INTO convite_respostas(convite_id,chave,nome,presenca,adultos,criancas) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(convite_id,chave) DO UPDATE SET nome=excluded.nome,presenca=excluded.presenca,adultos=excluded.adultos,criancas=excluded.criancas,atualizado_em=now()`, [c.id, i.chave, i.nome, i.presenca, i.presenca ? i.adultos : 0, i.presenca ? i.criancas : 0]);
    return { confirmado: true };
  });
}

export async function limitarHttp(chave: string, limite: number) {
  const r = await db().query(`INSERT INTO convite_limites_http(chave,janela) VALUES($1,date_trunc('hour',now()))
    ON CONFLICT(chave,janela) DO UPDATE SET usado=convite_limites_http.usado+1 WHERE convite_limites_http.usado < $2 RETURNING usado`, [hash(chave), limite]);
  exigir(r.rows.length, 'Muitas solicitações. Tente novamente mais tarde.', 429);
}
