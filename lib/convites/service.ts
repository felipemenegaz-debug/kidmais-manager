import { createHash, randomBytes } from 'node:crypto';
import { db, withTransaction } from '../db/postgres';
import type { DbExecutor } from '../db/contracts';
import type { SessaoAdmin } from '../autenticacao/service';
import { provarTenant, revalidarTenant } from '../saas/provar-tenant';
import { provarEstabelecimento } from '../saas/provar-estabelecimento';
import { contrato } from '../festas/repository';
import { lerEstadoComercial } from '../assinatura/estado';
import { comandoSchema, conteudoSchema, ConviteError, disponiveis, exigir, inicioConteudo, concluirGeracaoSchema, resolucaoGeracaoSchema, respostaSchema, validarCredito, type Conteudo, type Cotas } from './domain';
import { FalhaProvedorImagem, gerarImagem, iaConfigurada, normalizarImagem, modeloImagem, completoDisponivel, gerarConviteCompletoOpenAI, armazenarConviteCompleto, imagemDaResposta, processarImagemRecebida, provedorImagem, destinoDoProvedor, MODELO_COMPLETO, QUALIDADE_COMPLETO } from './imagem';
import { AUTORIZACAO_AINDA_VIGENTE, autorizacaoVigente, conferirImagens, MENSAGEM_088_AUSENTE, registrarAutorizacao, resumoAutorizacao, revogarAutorizacao, tabelaAusente, textosParaTela } from './consentimento';
import { ehProvedorIA, VERSAO_TEXTOS_IA, type ProvedorIA } from './consentimento-textos';
import { adicionarReferenciaEstilo, orientacaoFoto, prepararConviteCompleto, type ConviteCompletoPreparado } from './estilos';
import { dadosFamiliaPublica, listarFamilias, operarFamilia, validarFamilia } from './familias';
import { disponivelConvites, encerrarGeracao, infoCreditosConvites, motorConvites, reservarGeracao } from '../creditos/convites.ts';
import { flagsCreditos } from '../creditos/config.ts';

export type Acesso = { tipo: 'admin'; sessao: SessaoAdmin; festaId: string } | { tipo: 'cliente'; token: string };
type Convite = { id: string; empresa_id: string; festa_id: string; cliente_id: string; estabelecimento_id: string | null;
  publico_token: string; editor_hash: string | null; editor_expira_em: Date | null; rascunho: Conteudo; publicado: Conteudo | null;
  versao_contrato_id: string; limite_festa: number; limite_cliente: number; usado_festa: number; usado_cliente: number; revisao: number };
type Ligacao = { empresa_id: string; cliente_id: string; estabelecimento_id: string | null; contrato_id: string; invalidada_em: Date | null };
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const ator = (a: Acesso, c: Convite) => a.tipo === 'admin' ? `USUARIO:${a.sessao.usuario_id}` : `CLIENTE:${c.cliente_id}`;
// Provedor REAL que será chamado (configuração do servidor); null quando a IA não está habilitada.
function provedorAtual(): ProvedorIA | null { const p = provedorImagem(); return iaConfigurada() && ehProvedorIA(p) ? p : null; }
const operadorIA = (a: Acesso) => a.tipo === 'admin' ? 'BUFFET' as const : 'CLIENTE' as const;
export const MENSAGEM_CREDITOS_MANUTENCAO = 'A geração com créditos está em manutenção. Você pode seguir sem IA: modelos, upload e download continuam disponíveis.';
export const MENSAGEM_SEM_SALDO_CREDITOS = 'Os créditos de Convites da empresa acabaram. A Gestão pode comprar mais em Assinatura → Créditos de IA, ou você pode seguir sem IA.';
export const MENSAGEM_SEM_AUTORIZACAO ='Para gerar com IA, registre antes a autorização específica do responsável legal pela criança. Você também pode seguir sem IA.';
export function habilitado() { exigir(process.env.CONVITES_ENABLED === 'true', 'Convites ainda não estão disponíveis neste ambiente.', 503); }
const ligacaoSql = `SELECT fe.empresa_id,fe.cliente_id,fe.estabelecimento_id,f.contrato_id,f.invalidada_em
 FROM festas f JOIN contratos co ON co.id=f.contrato_id JOIN fechamentos fe ON fe.id=co.fechamento_id`;

async function comConvite<T>(a: Acesso, escrever: boolean, fn: (tx: DbExecutor, c: Convite, versao: string, convidados: number | null, podeAdministrar: boolean) => Promise<T>): Promise<T> {
  habilitado();
  return withTransaction(async tx => {
    let empresa: string, festa: string;
    let tenant: Awaited<ReturnType<typeof provarTenant>> | undefined;
    let podeAdministrar = false;
    if (a.tipo === 'admin') {
      tenant = await provarTenant(tx, a.sessao);
      empresa = tenant.empresaComprovada; festa = a.festaId;
      const cap = escrever ? 'FESTA_OPERAR' : 'FESTA_CONSULTAR';
      const capacidade = await tx.query(`SELECT id FROM festa_membership_capacidades WHERE empresa_id=$1 AND membership_id=$2 AND capacidade=$3 AND revogado_em IS NULL`, [empresa, tenant.membershipId, cap]);
      exigir(capacidade.rows.length, 'Sem permissão para administrar o convite.', 403);
      podeAdministrar = escrever;
      if (!escrever) podeAdministrar = (await tx.query(`SELECT id FROM festa_membership_capacidades WHERE empresa_id=$1 AND membership_id=$2 AND capacidade='FESTA_OPERAR' AND revogado_em IS NULL`, [empresa, tenant.membershipId])).rows.length > 0;
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
      // O cliente pode consumir no máximo duas gerações; a terceira fica reservada
      // para o buffet ajustar a arte final, se necessário.
      c = (await tx.query<Convite>(`INSERT INTO convites(empresa_id,festa_id,cliente_id,estabelecimento_id,publico_token,rascunho,versao_contrato_id,limite_festa,limite_cliente)
        VALUES($1,$2,$3,$4,$5,$6,$7,3,2) RETURNING *`, [empresa, festa, l.cliente_id, l.estabelecimento_id, token(), inicioConteudo(co.snapshot), co.versao_id])).rows[0];
      await evento(tx, c, a, 'CONVITE_CRIADO');
    }
    exigir(c, 'Crie o convite para começar.', 404);
    if (a.tipo === 'cliente') exigir(c.editor_hash === hash(a.token) && c.editor_expira_em && c.editor_expira_em > new Date(), 'Acesso ao convite indisponível.', 404);
    const quantidade = co.snapshot?.evento?.convidados;
    const r = await fn(tx, c, co.versao_id, Number.isSafeInteger(quantidade) && quantidade >= 0 ? quantidade : null, podeAdministrar);
    if (tenant) await revalidarTenant(tx, tenant);
    return r;
  });
}

const HISTORICO_PUBLICO: Record<string, string> = { IA_INCERTA: 'IA_EM_VERIFICACAO', IA_NAO_ENVIADA: 'IA_NAO_INICIADA', IA_RECUPERACAO_MANUAL: 'IA_VERIFICACAO_CONCLUIDA' };
// Evidência para a revisão manual de geração incerta: só identificador, etapa e categorias da moderação, revalidados
// contra listas fechadas (nunca mensagem livre, prompt ou foto). Sem detalhes válidos, nada é acrescentado.
const ETAPAS_MODERACAO = ['input', 'output', 'unknown'];
const CATEGORIAS_MODERACAO = ['harassment', 'hate', 'self-harm', 'sexual', 'violence', 'illicit', 'other'];
function detalhesFalha(erro: unknown): { requestId?: string; etapa?: string; categorias?: string[] } | undefined {
  if (typeof FalhaProvedorImagem === 'undefined' || !(erro instanceof FalhaProvedorImagem) || !erro.detalhes) return undefined;
  const d = erro.detalhes, r: { requestId?: string; etapa?: string; categorias?: string[] } = {};
  if (typeof d.requestId === 'string' && /^req_[a-zA-Z0-9_-]{1,128}$/.test(d.requestId)) r.requestId = d.requestId;
  if (typeof d.etapa === 'string' && ETAPAS_MODERACAO.includes(d.etapa)) r.etapa = d.etapa;
  if (Array.isArray(d.categorias)) {
    const categorias = [...new Set(d.categorias.filter(x => typeof x === 'string' && CATEGORIAS_MODERACAO.includes(x)))];
    if (categorias.length) r.categorias = categorias;
  }
  return Object.keys(r).length ? r : undefined;
}
// Mesmas listas fechadas para exibir ao operador evidência já gravada (coluna falha_detalhes ou evento IA_INCERTA).
export function evidenciaSanitizada(d: unknown) {
  const v = (d && typeof d === 'object' ? d : {}) as Record<string, unknown>;
  const r: { diagnostico?: string; requestId?: string; etapa?: string; categorias?: string[] } = {};
  if (typeof v.diagnostico === 'string' && /^[a-zA-Z0-9_[\]]{1,120}$/.test(v.diagnostico)) r.diagnostico = v.diagnostico;
  if (typeof v.requestId === 'string' && /^req_[a-zA-Z0-9_-]{1,128}$/.test(v.requestId)) r.requestId = v.requestId;
  if (typeof v.etapa === 'string' && ETAPAS_MODERACAO.includes(v.etapa)) r.etapa = v.etapa;
  if (Array.isArray(v.categorias)) {
    const categorias = [...new Set(v.categorias.filter(x => typeof x === 'string' && CATEGORIAS_MODERACAO.includes(x)))] as string[];
    if (categorias.length) r.categorias = categorias;
  }
  return r;
}
// Sem a 088 aplicada (ordem de deploy invertida), o editor continua abrindo e a geração com IA fica bloqueada: a
// consulta da autorização falha num savepoint e a tela recebe "indisponível"; gerar continua falhando fechado.
async function resumoTolerante(tx: DbExecutor, c: Convite, provedor: ProvedorIA) {
  await tx.query('SAVEPOINT autorizacao_ia');
  try { const r = await resumoAutorizacao(tx, c, provedor); await tx.query('RELEASE SAVEPOINT autorizacao_ia'); return { ...r, indisponivel: false }; }
  catch (e) {
    if (!tabelaAusente(e) && !(e instanceof ConviteError)) console.error('[convites] Falha ao ler a autorização de IA.');
    await tx.query('ROLLBACK TO SAVEPOINT autorizacao_ia');
    console.error('[convites] Autorização de IA indisponível; geração bloqueada.');
    return { vigente: null, precisaRenovar: false, indisponivel: true, mensagemIndisponivel: MENSAGEM_088_AUSENTE };
  }
}
async function evento(tx: DbExecutor, c: Convite, a: Acesso, acao: string, detalhe: object = {}) {
  await tx.query('INSERT INTO convite_eventos(convite_id,ator,acao,detalhe) VALUES($1,$2,$3,$4)', [c.id, ator(a, c), acao, detalhe]);
}
async function cotas(tx: DbExecutor, c: Convite): Promise<Cotas> {
  // Empresa migrada para os créditos (090): o teto da empresa é o disponível da carteira nova; festa e cliente não mudam.
  if (await motorConvites(tx, c.empresa_id) === 'CREDITOS')
    return { empresa: await disponivelConvites(tx, c.empresa_id), empresaUsado: 0, festa: c.limite_festa, festaUsado: c.usado_festa, cliente: c.limite_cliente, clienteUsado: c.usado_cliente };
  const w =(await tx.query<{ limite: number; usado: number }>(`SELECT CASE WHEN w.ativo THEN w.limite_mensal ELSE 0 END limite,COALESCE(u.usado,0)::int usado
    FROM convite_carteiras w LEFT JOIN convite_consumos u ON u.empresa_id=w.empresa_id AND u.mes=date_trunc('month',now() AT TIME ZONE 'America/Sao_Paulo')::date WHERE w.empresa_id=$1`, [c.empresa_id])).rows[0];
  return { empresa: w?.limite ?? 0, empresaUsado: w?.usado ?? 0, festa: c.limite_festa, festaUsado: c.usado_festa, cliente: c.limite_cliente, clienteUsado: c.usado_cliente };
}
export async function consultar(a: Acesso, criar = false) {
  return comConvite(a, criar, async (tx, c, versao, convidadosContratados) => {
    // Antes de ler cotas: uma geração interrompida pode ter devolvido a reserva ou concluído com a imagem guardada.
    await reconciliarNaTransacao(tx, c);
    const limite = await cotas(tx, c);
    // Convite completo (textos na arte) é identificado pela geração que o criou; sem coluna nova.
    const artes = (await tx.query<{ id: string; imagem: Buffer; origem: string; completo: boolean }>(`SELECT a.id,a.imagem,a.origem,EXISTS(SELECT 1 FROM convite_geracoes g
      WHERE g.arte_id=a.id AND g.convite_id=a.convite_id AND g.modelo=$3) completo FROM convite_artes a WHERE a.convite_id=$1 AND a.empresa_id=$2 ORDER BY a.criado_em DESC`,
    [c.id, c.empresa_id, MODELO_COMPLETO])).rows.map(r => ({ id: r.id, origem: r.origem, completo: !!r.completo, url: `data:image/webp;base64,${r.imagem.toString('base64')}` }));
    const familias = await listarFamilias(tx, c);
    const respostas = (await tx.query<{ nome: string; presenca: boolean; adultos: number; criancas: number; familiaId: string | null }>(`SELECT r.nome,r.presenca,r.adultos,r.criancas,r.familia_id "familiaId" FROM convite_respostas r
      LEFT JOIN convite_familias f ON f.id=r.familia_id AND f.convite_id=r.convite_id
      WHERE r.convite_id=$1 AND (r.familia_id IS NULL OR f.ativa=true) ORDER BY r.atualizado_em DESC LIMIT 2000`, [c.id])).rows;
    // Buffet e cliente veem a verificação em linguagem simples; atos do sistema e do operador aparecem como da plataforma.
    const historico = (await tx.query<{ acao: string; ator: string; criado_em: string }>('SELECT acao,split_part(ator,\':\',1) ator,criado_em FROM convite_eventos WHERE convite_id=$1 ORDER BY id DESC LIMIT 20', [c.id])).rows
      .map(h => ({ ...h, acao: HISTORICO_PUBLICO[h.acao] ?? h.acao, ator: ['SISTEMA', 'OPERADOR'].includes(h.ator) ? 'PLATAFORMA' : h.ator }));
    // Pendências técnicas ficam com o operador da plataforma: aqui só a situação simples, sem ids do provedor,
    // evidências ou decisões financeiras (buffet e cliente veem "verificando", nunca a revisão).
    const abertas = (await tx.query<{ id: string; estado: string }>(`SELECT id,estado FROM convite_geracoes
      WHERE convite_id=$1 AND empresa_id=$2 AND estado IN ('RESERVADA','INCERTA') ORDER BY criado_em`, [c.id, c.empresa_id])).rows;
    // Aviso e autorização (088): textos com o provedor real, hashes do texto exibido e situação, sem o nome do responsável.
    const provedor = provedorAtual();
    const autorizacaoIA = provedor ? { ...textosParaTela(provedor, operadorIA(a)), ...await resumoTolerante(tx, c, provedor) } : null;
    return { id: c.id, conteudo: c.rascunho, revisao: c.revisao, publicado: !!c.publicado, desatualizado: c.versao_contrato_id !== versao, convidadosContratados,
      linkPublico: `/convite/${c.publico_token}`, clienteHabilitado: !!c.editor_hash && !!c.editor_expira_em && c.editor_expira_em > new Date(),
      cotas: a.tipo === 'admin' ? limite : { festa: limite.festa, festaUsado: limite.festaUsado, cliente: limite.cliente, clienteUsado: limite.clienteUsado },
      disponiveis: disponiveis(limite, a.tipo === 'cliente'), iaDisponivel: iaConfigurada(), completoDisponivel: completoDisponivel(),
      // Saldo empresarial do motor novo (só para o buffet; o cliente da festa vê apenas o limite pertinente).
      creditos: a.tipo === 'admin' ? await infoCreditosConvites(tx, c.empresa_id) : null,
      geracaoIncerta: abertas.some(g => g.estado === 'INCERTA'), geracaoEmAndamento: abertas.find(g => g.estado === 'RESERVADA')?.id ?? null,
      autorizacaoIA, artes, respostas, familias, historico };
  });
}

// Situação de uma geração para quem acompanha o pedido (outra aba, recarga, conexão perdida): leitura leve, sem imagens.
export async function situacaoGeracao(a: Acesso, chave: string) {
  return comConvite(a, false, async (tx, c) => {
    await reconciliarNaTransacao(tx, c);
    const g = (await tx.query<{ estado: string; arte_id: string | null; modelo: string }>(
      'SELECT estado,arte_id,modelo FROM convite_geracoes WHERE id=$1 AND convite_id=$2 AND empresa_id=$3', [chave, c.id, c.empresa_id])).rows[0];
    exigir(g, 'Geração não encontrada neste convite.', 404);
    return { chave, estado: situacao(g.estado), arteId: g.estado === 'CONCLUIDA' ? g.arte_id : null, ...(g.modelo === MODELO_COMPLETO ? { completo: true } : {}) };
  });
}

async function limitarArtes(tx: DbExecutor, c: Convite) {
  exigir(Number((await tx.query<{ n: string }>(`SELECT (SELECT count(*) n FROM convite_artes WHERE convite_id=$1)
    +(SELECT count(*) FROM convite_geracoes WHERE convite_id=$1 AND estado='RESERVADA') AS n`, [c.id])).rows[0].n) < 20, 'Limite de 20 artes por festa atingido. Reutilize uma arte do histórico.', 409);
}
async function guardarArte(tx: DbExecutor, c: Pick<Convite, 'id' | 'empresa_id'>, imagem: Buffer, origem: 'IA' | 'UPLOAD') {
  return (await tx.query<{ id: string }>('INSERT INTO convite_artes(convite_id,empresa_id,imagem,origem) VALUES($1,$2,$3,$4) RETURNING id', [c.id, c.empresa_id, imagem, origem])).rows[0].id;
}
export async function comandar(a: Acesso, raw: unknown): Promise<object> {
  const i = comandoSchema.parse(raw);
  if (i.acao === 'gerar') return gerar(a, i);
  if (i.acao === 'autorizar_ia') return comConvite(a, true, async (tx, c) => {
    const provedor = provedorAtual();
    exigir(provedor, 'A geração com IA ainda não foi habilitada pelo buffet.', 503);
    const operador = a.tipo === 'admin' ? { tipo: 'BUFFET' as const, usuarioId: a.sessao.usuario_id } : { tipo: 'CLIENTE' as const, clienteId: c.cliente_id };
    const r = await registrarAutorizacao(tx, c, operador, ator(a, c), provedor, i);
    // Auditoria sem dados pessoais: identificador, provedor, versão e manifestação sobre a foto.
    await evento(tx, c, a, 'AUTORIZACAO_IA_REGISTRADA', { autorizacao: r.id, provedor, versao: VERSAO_TEXTOS_IA, ...(r.substituiu ? { substituiu: r.substituiu } : {}) });
    return { autorizacaoId: r.id, provedor };
  });
  // Revogar não depende de permissão de edição nem de acesso comercial completo: vale para usos futuros.
  if (i.acao === 'revogar_autorizacao_ia') return comConvite(a, false, async (tx, c) => {
    const revogada = await revogarAutorizacao(tx, c, ator(a, c));
    if (revogada) await evento(tx, c, a, 'AUTORIZACAO_IA_REVOGADA', { autorizacao: revogada });
    return { revogada: !!revogada };
  });
  // Reencoding fora da transação; só após autenticação da rota (cliente revalidado abaixo).
  if (i.acao === 'upload') await comConvite(a, true, async () => undefined);
  const imagem = i.acao === 'upload' ? await normalizarImagem(i.imagem) : null;
  return comConvite(a, true, async (tx, c, versao) => {
    if (i.acao === 'familia_adicionar' || i.acao === 'familia_editar' || i.acao === 'familia_link' || i.acao === 'familia_status') {
      const resultado = await operarFamilia(tx, c, i);
      if (!('repetida' in resultado && resultado.repetida)) await evento(tx, c, a, i.acao.toUpperCase(), { familiaId: i.id, ...('habilitado' in i ? { habilitado: i.habilitado } : {}), ...('ativa' in i ? { ativa: i.ativa } : {}) });
      return resultado;
    }
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
      exigir(i.festa >= c.usado_festa && i.cliente >= c.usado_cliente && i.cliente <= i.festa, 'A cota não pode ser menor que o uso nem a cota do cliente maior que a da festa.');
      // Cotas são tetos, não reservas do saldo mensal. O saldo da empresa é
      // validado novamente em cada geração; não bloqueie ajustes de limites.
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

// --- Geração com IA: um pedido, uma chamada paga, resultado durável -------------------------------------------------
// Proteção é a mesma desde a 073: chave do pedido = id da geração; reserva, créditos e orçamento numa transação; no
// máximo uma RESERVADA por festa (índice parcial). A 084 acrescenta as etapas duráveis: enviado_em é gravado e
// confirmado ANTES da chamada (sem ele não há envio) e a imagem recebida é guardada antes do processamento local.
// Limites documentados do provedor (Images API, 18/10/2026): sem chave de idempotência, sem consulta de status ou
// recuperação da imagem e sem cobrança por requisição. Por isso nada aqui reenvia, consulta ou devolve créditos por
// tempo decorrido: só "não enviado" devolve reservas automaticamente e só "imagem recebida" conclui sozinha.
export const MENSAGEM_VERIFICANDO = 'Estamos verificando sua geração. Você não precisa tentar novamente.';
const SITUACAO: Record<string, string> = { RESERVADA: 'EM_ANDAMENTO', CONCLUIDA: 'CONCLUIDA', INCERTA: 'VERIFICANDO',
  RESOLVIDA_COBRADA: 'ENCERRADA', RESOLVIDA_SEM_COBRANCA: 'DEVOLVIDA', NAO_ENVIADA: 'NAO_INICIADA' };
const situacao = (estado: string) => SITUACAO[estado] ?? 'VERIFICANDO';
const ATOR_SISTEMA = 'SISTEMA:reconciliacao';
type GeracaoAberta = { id: string; convite_id: string; empresa_id: string; ator: string; reserva_microusd: number | string; modelo: string };
type Etapas = { enviou: boolean; recebeu: boolean };
type ClasseFalha = 'PRE_ENVIO' | 'RESPOSTA_PROVEDOR' | 'DESCONHECIDA' | 'ARMAZENAMENTO' | 'DEVOLUCAO_FALHOU';
const esperar = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
// Coluna aceita só [a-z0-9_]: parâmetros do provedor como "image[]" viram "image__".
const codigoDiagnostico = (d: string) => d.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 120) || 'falha_interna';

async function registrarEvento(tx: DbExecutor, conviteId: string, autor: string, acao: string, detalhe: object) {
  await tx.query('INSERT INTO convite_eventos(convite_id,ator,acao,detalhe) VALUES($1,$2,$3,$4)', [conviteId, autor, acao, detalhe]);
}
// Evidência nunca muda o desfecho: falha ao gravar o evento não desfaz a transição já feita na mesma transação.
async function registrarEventoTolerante(tx: DbExecutor, conviteId: string, autor: string, acao: string, detalhe: object) {
  await tx.query('SAVEPOINT evento_geracao');
  try { await registrarEvento(tx, conviteId, autor, acao, detalhe); await tx.query('RELEASE SAVEPOINT evento_geracao'); }
  catch { await tx.query('ROLLBACK TO SAVEPOINT evento_geracao'); console.error(`[convites] Evento ${acao} não registrado.`); }
}

// Devolve, uma única vez, as reservas originais (festa, cliente, mês e dia civis de São Paulo da reserva). Mesma ordem
// de travas da reserva (convite já travado → carteira → orçamento do dia → consumo do mês): sem deadlock entre elas.
async function devolverReservas(tx: DbExecutor, g: GeracaoAberta) {
  // Reserva feita no motor de créditos (090): libera lá (aos lotes de origem) e não toca o consumo mensal legado.
  const motorNovo = await encerrarGeracao(tx, g.empresa_id, g.id, false, 'SISTEMA');
  if (!motorNovo) await tx.query('SELECT empresa_id FROM convite_carteiras WHERE empresa_id=$1 FOR UPDATE', [g.empresa_id]);
  const festa = await tx.query(`UPDATE convites SET usado_festa=usado_festa-1,
    usado_cliente=usado_cliente-CASE WHEN $2 THEN 1 ELSE 0 END
    WHERE id=$1 AND empresa_id=$3 AND usado_festa>0 AND (NOT $2 OR usado_cliente>0) RETURNING id`,
  [g.convite_id, g.ator.startsWith('CLIENTE:'), g.empresa_id]);
  exigir(festa.rowCount === 1, 'Não foi possível liberar as cotas da festa com segurança.', 409);
  const global = await tx.query(`UPDATE convite_orcamento_global SET reservado_microusd=reservado_microusd-$2
    WHERE dia=(SELECT (criado_em AT TIME ZONE 'America/Sao_Paulo')::date FROM convite_geracoes WHERE id=$1)
      AND reservado_microusd >= $2 RETURNING dia`, [g.id, g.reserva_microusd]);
  exigir(global.rowCount === 1, 'Não foi possível localizar a reserva diária original; nenhuma cota foi liberada.', 409);
  if (motorNovo) return;
  const mensal = await tx.query(`UPDATE convite_consumos SET usado=usado-1 WHERE empresa_id=$2 AND usado>0 AND mes=(
    SELECT date_trunc('month',criado_em AT TIME ZONE 'America/Sao_Paulo')::date FROM convite_geracoes WHERE id=$1
  ) RETURNING empresa_id`, [g.id, g.empresa_id]);
  exigir(mensal.rowCount === 1, 'Não foi possível localizar a reserva mensal original; nenhuma cota foi liberada.', 409);
}

// Envio comprovadamente não iniciado: só gerações do código novo (etapas_registradas) com enviado_em nunca gravado.
// Única devolução automática. Se a devolução não fecha (contadores inconsistentes), a geração vai para o operador
// em vez de ficar parada como "em andamento".
async function encerrarNaoEnviada(tx: DbExecutor, g: GeracaoAberta, diagnostico: string, autor: string): Promise<'NAO_ENVIADA' | 'INCERTA' | null> {
  await tx.query('SAVEPOINT devolucao_geracao');
  try {
    const r = await tx.query(`UPDATE convite_geracoes SET estado='NAO_ENVIADA',falha_classe='PRE_ENVIO',falha_diagnostico=$2
      WHERE id=$1 AND estado='RESERVADA' AND etapas_registradas AND enviado_em IS NULL RETURNING id`, [g.id, codigoDiagnostico(diagnostico)]);
    if (r.rowCount !== 1) { await tx.query('RELEASE SAVEPOINT devolucao_geracao'); return null; }
    await devolverReservas(tx, g);
    await tx.query('RELEASE SAVEPOINT devolucao_geracao');
  } catch (erro) {
    await tx.query('ROLLBACK TO SAVEPOINT devolucao_geracao');
    // Só a recusa de devolver com segurança (contadores divergentes) vai para o operador; falha passageira de banco
    // (deadlock, lock_timeout) sobe e a reconciliação tenta de novo depois.
    if (!(erro instanceof ConviteError)) throw erro;
    console.error('[convites] Devolução automática não fechou; geração vai para o operador.');
    return await marcarIncerta(tx, g, 'DEVOLUCAO_FALHOU', 'devolucao_automatica_falhou', undefined, autor) ? 'INCERTA' : null;
  }
  await registrarEventoTolerante(tx, g.convite_id, autor, 'IA_NAO_ENVIADA', { geracao: g.id, diagnostico: codigoDiagnostico(diagnostico), liberouReserva: true });
  return 'NAO_ENVIADA';
}
// Possível envio sem resultado utilizável: reserva mantida, protege a festa e entra na fila do operador.
async function marcarIncerta(tx: DbExecutor, g: GeracaoAberta, classe: Exclude<ClasseFalha, 'PRE_ENVIO'>, diagnostico: string,
  detalhes: ReturnType<typeof detalhesFalha>, autor: string) {
  const r = await tx.query(`UPDATE convite_geracoes SET estado='INCERTA',falha_classe=$2,falha_diagnostico=$3,falha_detalhes=$4
    WHERE id=$1 AND estado='RESERVADA' RETURNING id`, [g.id, classe, codigoDiagnostico(diagnostico), detalhes ?? null]);
  if (r.rowCount !== 1) return false;
  await registrarEventoTolerante(tx, g.convite_id, autor, 'IA_INCERTA', { geracao: g.id, diagnostico, classe, ...(detalhes ?? {}) });
  return true;
}
// Imagem disponível (recebida agora ou guardada antes): grava a arte uma única vez. Também conclui uma INCERTA,
// porque a imagem recebida é evidência de sucesso; nunca reabre uma decisão do operador nem uma NAO_ENVIADA.
async function concluirGeracao(tx: DbExecutor, g: Pick<GeracaoAberta, 'id' | 'convite_id' | 'empresa_id' | 'modelo'>, imagem: Buffer,
  uso: unknown, autor: string, recuperada: boolean) {
  await tx.query('SELECT id FROM convites WHERE id=$1 FOR UPDATE', [g.convite_id]);
  const atual = (await tx.query<{ estado: string; arte_id: string | null }>('SELECT estado,arte_id FROM convite_geracoes WHERE id=$1 FOR UPDATE', [g.id])).rows[0];
  if (atual?.estado === 'CONCLUIDA') return atual.arte_id;
  if (atual?.estado !== 'RESERVADA' && atual?.estado !== 'INCERTA') return null;
  const arteId = await guardarArte(tx, { id: g.convite_id, empresa_id: g.empresa_id }, imagem, 'IA');
  await tx.query("UPDATE convite_geracoes SET estado='CONCLUIDA',arte_id=$2,uso=COALESCE($3,uso),resultado_pendente=NULL WHERE id=$1 AND estado IN ('RESERVADA','INCERTA')",
    [g.id, arteId, uso ?? null]);
  // Geração concluída = 1 crédito consumido no motor novo (sem reserva lá, nada muda: motor legado).
  await encerrarGeracao(tx, g.empresa_id, g.id, true, 'SISTEMA');
  await registrarEvento(tx, g.convite_id, autor, 'IA_CONCLUIDA', { geracao: g.id, arteId, ...(g.modelo === MODELO_COMPLETO ? { completo: true } : {}),
    ...(recuperada ? { recuperada: true } : {}), ...(atual.estado === 'INCERTA' ? { aposVerificacao: true } : {}) });
  return arteId;
}

// Reconciliação sem provedor, dentro da transação que já trava o convite (consulta, situação, nova geração, fila do
// operador). Do código novo: interrupção entre reserva e envio → NAO_ENVIADA; enviada sem registro de resposta por
// 10 min → INCERTA; imagem guardada há 30 s (a geração em curso já teve a chance de gravá-la) → arte. Reservas do código
// anterior (sem etapas registradas: enviado_em nulo não prova nada) → INCERTA depois de 10 min, nunca devolvidas aqui.
// Falha de banco aqui é adiada (savepoint) e nunca impede a leitura do convite.
const CONDICAO_PARADA = `estado='RESERVADA' AND ((resultado_pendente IS NOT NULL AND recebido_em < now() - interval '30 seconds')
  OR (etapas_registradas AND enviado_em IS NULL AND criado_em < now() - interval '2 minutes')
  OR (enviado_em IS NOT NULL AND enviado_em < now() - interval '10 minutes')
  OR (NOT etapas_registradas AND criado_em < now() - interval '10 minutes'))`;
async function reconciliarNaTransacao(tx: DbExecutor, c: Pick<Convite, 'id' | 'empresa_id'>) {
  const abertas = (await tx.query<GeracaoAberta & { enviado_em: Date | null; imagem_guardada: boolean; etapas_registradas: boolean }>(
    `SELECT id,convite_id,empresa_id,ator,reserva_microusd,modelo,enviado_em,etapas_registradas,(resultado_pendente IS NOT NULL) imagem_guardada
     FROM convite_geracoes WHERE convite_id=$1 AND empresa_id=$2 AND ${CONDICAO_PARADA}
     ORDER BY criado_em FOR UPDATE SKIP LOCKED`, [c.id, c.empresa_id])).rows;
  for (const g of abertas) {
    await tx.query('SAVEPOINT reconciliar_geracao');
    try {
      if (g.imagem_guardada) {
        const bytes = (await tx.query<{ resultado_pendente: Buffer }>('SELECT resultado_pendente FROM convite_geracoes WHERE id=$1', [g.id])).rows[0]?.resultado_pendente;
        let imagem: Buffer | null = null;
        try { if (bytes) imagem = await processarImagemRecebida(bytes, g.modelo === MODELO_COMPLETO); }
        catch { console.error('[convites] Imagem guardada não pôde ser processada; geração vai para verificação.'); }
        if (imagem) await concluirGeracao(tx, g, imagem, null, ATOR_SISTEMA, true);
        else await marcarIncerta(tx, g, 'ARMAZENAMENTO', 'processamento_local', undefined, ATOR_SISTEMA);
      } else if (!g.etapas_registradas) await marcarIncerta(tx, g, 'DESCONHECIDA', 'legado_sem_registro', undefined, ATOR_SISTEMA);
      else if (!g.enviado_em) await encerrarNaoEnviada(tx, g, 'interrompida_antes_do_envio', ATOR_SISTEMA);
      else await marcarIncerta(tx, g, 'DESCONHECIDA', 'sem_resposta_registrada', undefined, ATOR_SISTEMA);
      await tx.query('RELEASE SAVEPOINT reconciliar_geracao');
    } catch {
      await tx.query('ROLLBACK TO SAVEPOINT reconciliar_geracao');
      console.error('[convites] Reconciliação de geração adiada.');
    }
  }
}
// Fila do operador: reconcilia convites com geração parada, um por transação (mesma ordem de travas da geração).
export async function reconciliarGeracoesParadas(limite = 20) {
  // Mais antigas primeiro; as que não fecham saem de RESERVADA (INCERTA), então não ocupam o lote para sempre.
  const convites = (await db().query<{ convite_id: string; empresa_id: string }>(`SELECT convite_id,empresa_id FROM convite_geracoes
    WHERE ${CONDICAO_PARADA} GROUP BY convite_id,empresa_id ORDER BY min(criado_em) LIMIT $1`, [limite])).rows;
  for (const c of convites) {
    try {
      await withTransaction(async tx => {
        await tx.query('SELECT id FROM convites WHERE id=$1 AND empresa_id=$2 FOR UPDATE', [c.convite_id, c.empresa_id]);
        await reconciliarNaTransacao(tx, { id: c.convite_id, empresa_id: c.empresa_id });
      });
    } catch { console.error('[convites] Reconciliação de convite adiada.'); }
  }
  return convites.length;
}

// Envio único com registro durável. A chamada só sai depois de enviado_em confirmado no banco; uma segunda tentativa
// na mesma geração é recusada. A imagem de uma resposta 2xx é guardada antes do processamento local.
function enviarComRegistro(chave: string, etapas: Etapas, provedor: ProvedorIA, autorizacaoId: string, base: typeof fetch = globalThis.fetch): typeof fetch {
  return (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    exigir(!etapas.enviou, 'Envio repetido recusado.', 500);
    const destino = typeof url === 'string' ? url : String((url as { href?: string; url?: string }).href ?? (url as { url?: string }).url ?? '');
    // Provedor exibido = provedor chamado: outro destino é recusado antes do marcador (nada sai; crédito devolvido).
    exigir(destinoDoProvedor(provedor, destino), 'Envio a um provedor diferente do autorizado foi recusado.', 409);
    const marcado = await db().query(`UPDATE convite_geracoes SET enviado_em=clock_timestamp() WHERE id=$1 AND estado='RESERVADA' AND etapas_registradas AND enviado_em IS NULL
      AND ${AUTORIZACAO_AINDA_VIGENTE} RETURNING id`, [chave, autorizacaoId]);
    exigir(marcado.rows.length === 1, 'A reserva desta geração ou a autorização do responsável não está mais ativa.', 409);
    etapas.enviou = true;
    // Nosso identificador (a chave) só ajuda o suporte do provedor a localizar o pedido; não deduplica nem recupera.
    const headers = destino.startsWith('https://api.openai.com/') ? { ...(init?.headers as Record<string, string> | undefined), 'X-Client-Request-Id': chave } : init?.headers;
    const resposta = await base(url, { ...init, headers });
    if (resposta.ok) {
      try {
        const corpo = await resposta.clone().json() as { usage?: unknown } | null;
        const bytes = imagemDaResposta(destino, corpo);
        if (bytes && bytes.length <= 16_000_000) {
          const uso = corpo && typeof corpo.usage === 'object' ? corpo.usage : null;
          const guardado = await db().query(`UPDATE convite_geracoes SET recebido_em=clock_timestamp(),resultado_pendente=$2,uso=$3
            WHERE id=$1 AND estado IN ('RESERVADA','INCERTA') AND arte_id IS NULL RETURNING id`, [chave, bytes, uso]);
          etapas.recebeu = guardado.rows.length === 1;
        }
      } catch { console.error('[convites] Imagem recebida não foi guardada antes do processamento.'); }
    }
    return resposta;
  }) as typeof fetch;
}

// Classifica pela etapa comprovada, não pelo tipo de erro nem pelo tempo: sem enviado_em → pré-envio; com imagem
// guardada → armazenamento; resposta HTTP do provedor → explícita (moderation_blocked não prova ausência de cobrança);
// o resto (timeout, rede, corpo inválido) → desconhecida. Só a primeira devolve créditos.
async function registrarFalha(a: Acesso, c: Convite, chave: string, etapas: Etapas, erro: unknown) {
  const diagnostico = typeof FalhaProvedorImagem !== 'undefined' && erro instanceof FalhaProvedorImagem ? erro.diagnostico
    : erro instanceof Error && erro.name === 'TimeoutError' ? 'timeout'
      : erro instanceof Error && erro.name === 'AbortError' ? 'abortado' : 'falha_interna';
  const detalhes = detalhesFalha(erro);
  const classe: ClasseFalha = !etapas.enviou ? 'PRE_ENVIO' : etapas.recebeu ? 'ARMAZENAMENTO'
    : /^http_\d{3}/.test(diagnostico) && erro instanceof FalhaProvedorImagem ? 'RESPOSTA_PROVEDOR' : 'DESCONHECIDA';
  console.error('[convites] Geração sem resultado:', classe, diagnostico, ...(detalhes ? [JSON.stringify(detalhes)] : []));
  let final: { estado: string; arteId: string | null } | null = null;
  try {
    final = await withTransaction(async tx => {
      await tx.query('SELECT id FROM convites WHERE id=$1 FOR UPDATE', [c.id]);
      const g = (await tx.query<GeracaoAberta & { estado: string; arte_id: string | null; enviado_em: Date | null }>(
        'SELECT id,convite_id,empresa_id,ator,reserva_microusd,modelo,estado,arte_id,enviado_em FROM convite_geracoes WHERE id=$1 FOR UPDATE', [chave])).rows[0];
      if (!g || g.estado !== 'RESERVADA') return g ? { estado: g.estado, arteId: g.arte_id } : null;
      if (classe === 'PRE_ENVIO' && !g.enviado_em) {
        const desfecho = await encerrarNaoEnviada(tx, g, diagnostico, ator(a, c));
        if (desfecho) return { estado: desfecho, arteId: null };
      }
      // Marcador confirmado no banco sem retorno ao processo: possível envio.
      await marcarIncerta(tx, g, classe === 'PRE_ENVIO' ? 'DESCONHECIDA' : classe, diagnostico, detalhes, ator(a, c));
      return { estado: 'INCERTA', arteId: null };
    });
  } catch { console.error('[convites] Falha da geração não registrada; a reconciliação classifica depois.'); }
  if (final?.estado === 'NAO_ENVIADA') throw new ConviteError('Não foi possível iniciar a geração. Nenhum crédito foi usado; tente novamente em instantes.', 503);
  if (final?.estado === 'CONCLUIDA' && final.arteId) return { chave, estado: 'CONCLUIDA', arteId: final.arteId };
  return { chave, estado: 'VERIFICANDO', mensagem: MENSAGEM_VERIFICANDO };
}

/**
 * Decisão do operador da plataforma sobre uma geração INCERTA (painel do desenvolvedor; a rota confere concessão e
 * senha recente). Mesma transição única da 079: cobrança confirmada mantém tudo; sem cobrança devolve uma vez as
 * reservas originais. A imagem retida, se houver, é descartada com a decisão.
 */
export async function resolverGeracaoIncerta(tx: DbExecutor, operadorId: string, raw: unknown) {
  const i = resolucaoGeracaoSchema.parse(raw);
  const alvo = (await tx.query<{ convite_id: string }>('SELECT convite_id FROM convite_geracoes WHERE id=$1', [i.geracaoId])).rows[0];
  exigir(alvo, 'Geração não encontrada.', 404);
  await tx.query('SELECT id FROM convites WHERE id=$1 FOR UPDATE', [alvo.convite_id]);
  const g = (await tx.query<GeracaoAberta & { estado: string }>(`SELECT id,convite_id,empresa_id,ator,reserva_microusd,modelo,estado FROM convite_geracoes
    WHERE id=$1 AND convite_id=$2 FOR UPDATE`, [i.geracaoId, alvo.convite_id])).rows[0];
  exigir(g?.estado === 'INCERTA', 'Esta geração já foi resolvida ou não está pendente.', 409);
  const estado = i.resultado === 'COBRANCA_CONFIRMADA' ? 'RESOLVIDA_COBRADA' : 'RESOLVIDA_SEM_COBRANCA';
  const transicao = await tx.query(`UPDATE convite_geracoes SET estado=$2,resolucao_resultado=$3,resolucao_por=$4,
    resolucao_em=now(),resolucao_evidencia=$5,resultado_pendente=NULL WHERE id=$1 AND estado='INCERTA' RETURNING id`,
  [g.id, estado, i.resultado, operadorId, i.evidencia]);
  exigir(transicao.rowCount === 1, 'A geração já foi resolvida por outra sessão. Atualize a página.', 409);
  const liberouReserva = i.resultado === 'SEM_COBRANCA';
  if (liberouReserva) await devolverReservas(tx, g);
  else await encerrarGeracao(tx, g.empresa_id, g.id, true, 'PLATAFORMA');
  // O histórico do convite registra a decisão sem a evidência (que fica só na geração, para o operador).
  await registrarEvento(tx, g.convite_id, `OPERADOR:${operadorId}`, 'IA_RECUPERACAO_MANUAL', { geracao: g.id, resultado: i.resultado, liberouReserva });
  return { resolvida: true, estado, liberouReserva, geracaoId: g.id, conviteId: g.convite_id, empresaId: g.empresa_id };
}

/**
 * Operador conclui uma geração INCERTA que tem a imagem recebida retida (ex.: processamento local que falhou por motivo
 * passageiro): reprocessa a imagem já paga, sem chamar o provedor; o crédito continua consumido. Se a imagem não
 * processa, nada muda e a decisão volta a ser a financeira.
 */
export async function concluirGeracaoComImagem(tx: DbExecutor, operadorId: string, raw: unknown) {
  const i = concluirGeracaoSchema.parse(raw);
  const alvo = (await tx.query<{ convite_id: string }>('SELECT convite_id FROM convite_geracoes WHERE id=$1', [i.geracaoId])).rows[0];
  exigir(alvo, 'Geração não encontrada.', 404);
  await tx.query('SELECT id FROM convites WHERE id=$1 FOR UPDATE', [alvo.convite_id]);
  const g = (await tx.query<GeracaoAberta & { estado: string; resultado_pendente: Buffer | null }>(`SELECT id,convite_id,empresa_id,ator,reserva_microusd,modelo,estado,resultado_pendente
    FROM convite_geracoes WHERE id=$1 AND convite_id=$2 FOR UPDATE`, [i.geracaoId, alvo.convite_id])).rows[0];
  exigir(g?.estado === 'INCERTA', 'Esta geração já foi resolvida ou não está pendente.', 409);
  exigir(g.resultado_pendente, 'Esta geração não tem imagem recebida retida.', 409);
  let imagem: Buffer;
  try { imagem = await processarImagemRecebida(g.resultado_pendente, g.modelo === MODELO_COMPLETO); }
  catch { throw new ConviteError('A imagem retida não pôde ser processada. Decida a cobrança com evidência.', 409); }
  const arteId = await concluirGeracao(tx, g, imagem, null, `OPERADOR:${operadorId}`, true);
  exigir(arteId, 'A geração mudou de situação. Atualize a página.', 409);
  return { concluida: true, estado: 'CONCLUIDA', liberouReserva: false, geracaoId: g.id, conviteId: g.convite_id, empresaId: g.empresa_id };
}

async function gerar(a: Acesso, i: Extract<ReturnType<typeof comandoSchema.parse>, { acao: 'gerar' }>) {
  exigir(iaConfigurada(), 'A geração com IA ainda não foi habilitada pelo buffet.', 503);
  const provedor = provedorAtual();
  exigir(provedor, 'A geração com IA ainda não foi habilitada pelo buffet.', 503);
  const completo = i.completo === true, estilo = i.estilo ?? 'pedido', qualidade = i.qualidade ?? QUALIDADE_COMPLETO;
  exigir(completo || (i.estilo === undefined && i.qualidade === undefined && i.foto === undefined), 'Estilo, qualidade e foto valem somente para o convite completo.', 400);
  if (completo) {
    exigir(completoDisponivel(), 'O convite completo ainda não está disponível neste ambiente.', 503);
    exigir(!i.referencias.length, 'O convite completo não usa imagens da galeria como referência.', 400);
  }
  // Pedido simples mantém o hash anterior; o completo inclui estilo, o hash da foto (a foto nunca é salva)
  // e os dados oficiais da festa no momento da reserva: textos alterados exigem nova chave.
  const conteudoPayload = (c: Convite) => completo
    ? { prompt: i.prompt, referencias: i.referencias, completo, estilo, ...(i.foto ? { foto: hash(i.foto) } : {}),
      // O padrão xhigh mantém o hash anterior: pedidos enviados antes do deploy continuam idempotentes.
      ...(qualidade !== QUALIDADE_COMPLETO ? { qualidade } : {}),
      campos: ['nome', 'idade', 'data', 'horario', 'local', 'endereco', 'mensagem'].map(k => String((c.rascunho as Record<string, unknown>)[k] ?? '').trim()) }
    : { prompt: i.prompt, referencias: i.referencias };
  let foto: Buffer | undefined;
  if (i.foto !== undefined) {
    // Reencoding (sem metadados) só após autenticação, como no upload; validação antes de qualquer reserva.
    await comConvite(a, true, async () => undefined);
    foto = await normalizarImagem(i.foto);
  }
  const reserva = await comConvite(a, true, async (tx, c) => {
    await reconciliarNaTransacao(tx, c);
    const payload = hash(JSON.stringify(conteudoPayload(c)));
    const anterior = (await tx.query<{ estado: string; arte_id: string | null; payload_hash: string; ator: string; convite_id: string; modelo: string }>('SELECT * FROM convite_geracoes WHERE id=$1', [i.chave])).rows[0];
    if (anterior) {
      exigir(anterior.convite_id === c.id && anterior.ator === ator(a, c) && anterior.payload_hash === payload, 'Chave de geração já utilizada.', 409);
      // Mesmo pedido (clique duplo, recarga, reconexão): devolve a situação da geração original, sem nova chamada.
      return { repetida: true as const, chave: i.chave, estado: situacao(anterior.estado), arteId: anterior.estado === 'CONCLUIDA' ? anterior.arte_id : null,
        ...(anterior.modelo === MODELO_COMPLETO ? { completo: true } : {}) };
    }
    // Outra aba ou outro pedido da festa já em andamento: acompanha a mesma geração em vez de reservar outra.
    const emAndamento = (await tx.query<{ id: string }>("SELECT id FROM convite_geracoes WHERE convite_id=$1 AND estado='RESERVADA'", [c.id])).rows[0];
    if (emAndamento) return { repetida: true as const, chave: emAndamento.id, estado: 'EM_ANDAMENTO', arteId: null, acompanhando: true };
    exigir(!(await tx.query("SELECT id FROM convite_geracoes WHERE convite_id=$1 AND estado='INCERTA' LIMIT 1", [c.id])).rows.length,
      'Estamos verificando a geração anterior desta festa. Você não precisa tentar novamente.', 409);
    // 088: o servidor não confia na tela. Sem autorização vigente para esta festa, este provedor e esta versão do texto,
    // nada é reservado nem enviado. Foto e imagens da galeria (podem mostrar a criança) exigem, além disso, a confirmação
    // desta geração (uso único), conferida abaixo com as imagens que de fato serão enviadas.
    const autorizacao = await autorizacaoVigente(tx, c, provedor);
    exigir(autorizacao, MENSAGEM_SEM_AUTORIZACAO, 403);
    // Dados oficiais = rascunho salvo no servidor; conflito com o pedido falha antes de reservar créditos.
    let preparado: ConviteCompletoPreparado | null = null;
    if (completo) {
      preparado = prepararConviteCompleto(i.prompt, c.rascunho, estilo);
      if (foto) preparado = await adicionarReferenciaEstilo({ ...preparado, foto, promptImagem: preparado.promptImagem + orientacaoFoto(estilo) });
    }
    await limitarArtes(tx, c);
    const refs: Buffer[] = [];
    for (const id of i.referencias) {
      const ref = (await tx.query<{ imagem: Buffer }>('SELECT imagem FROM convite_artes WHERE id=$1 AND convite_id=$2 AND empresa_id=$3', [id, c.id, c.empresa_id])).rows[0];
      exigir(ref, 'Referência não pertence à festa.', 400); refs.push(ref.imagem);
    }
    // Imagens pessoais que sairão nesta geração (a referência fixa do estilo é um arquivo do servidor, não da festa).
    const imagens = conferirImagens(provedor, operadorIA(a), i.autorizacaoImagens, [...(foto ? [foto] : []), ...refs]);
    // Carteira + consumo mensal + convite travados; cliente não escolhe modelo, custo ou empresa.
    // Um único motor autoriza a empresa (090): com corte registrado, só a carteira nova; sem corte, só o legado.
    const motor = await motorConvites(tx, c.empresa_id);
    if (motor === 'CREDITOS') exigir(flagsCreditos().consumoConvites, MENSAGEM_CREDITOS_MANUTENCAO, 503);
    else {
      await tx.query('SELECT empresa_id FROM convite_carteiras WHERE empresa_id=$1 FOR UPDATE', [c.empresa_id]);
      // Defesa em profundidade: a trava da empresa (início desta transação; o corte a pega antes de convite_carteiras)
      // já serializa geração e corte nas duas ordens (provado no PG). Se um caminho futuro pular essa trava, isto impede
      // debitar o legado depois de um corte.
      exigir(await motorConvites(tx, c.empresa_id) === 'LEGADO', 'Os créditos desta empresa acabaram de ser atualizados. Tente gerar novamente.', 409);
    }
    const limites = await cotas(tx, c);
    // Motor novo: festa e cliente aqui; o saldo da empresa é decidido pela reserva (carteira travada, lotes em ordem).
    validarCredito(motor === 'CREDITOS' ? { ...limites, empresa: 1, empresaUsado: 0 } : limites, a.tipo === 'cliente');
    const teto = Number(process.env.CONVITES_IA_TETO_DIARIO_MICROUSD);
    exigir(Number.isSafeInteger(teto) && teto >= 300000, 'Orçamento de IA não configurado.', 503);
    if (motor === 'CREDITOS') exigir(await reservarGeracao(tx, c.empresa_id, i.chave, a.tipo === 'cliente' ? 'CLIENTE' : 'EQUIPE'), MENSAGEM_SEM_SALDO_CREDITOS, 402);
    // Reserva conservadora por pedido; não é medição de faturamento do provedor.
    const global = await tx.query(`INSERT INTO convite_orcamento_global(dia,reservado_microusd) VALUES((now() AT TIME ZONE 'America/Sao_Paulo')::date,300000)
      ON CONFLICT(dia) DO UPDATE SET reservado_microusd=convite_orcamento_global.reservado_microusd+300000
      WHERE convite_orcamento_global.reservado_microusd+300000 <= $1 RETURNING dia`, [teto]);
    exigir(global.rows.length, 'O limite diário de geração foi atingido. Tente outro dia.', 402);
    if (motor === 'LEGADO') await tx.query(`INSERT INTO convite_consumos(empresa_id,mes,usado) VALUES($1,date_trunc('month',now() AT TIME ZONE 'America/Sao_Paulo')::date,1)
      ON CONFLICT(empresa_id,mes) DO UPDATE SET usado=convite_consumos.usado+1`, [c.empresa_id]);
    await tx.query('UPDATE convites SET usado_festa=usado_festa+1,usado_cliente=usado_cliente+$2 WHERE id=$1', [c.id, a.tipo === 'cliente' ? 1 : 0]);
    // etapas_registradas=true: só gerações deste código podem ser devolvidas automaticamente (ver 084).
    await tx.query('INSERT INTO convite_geracoes(id,convite_id,empresa_id,ator,payload_hash,modelo,etapas_registradas) VALUES($1,$2,$3,$4,$5,$6,true)', [i.chave, c.id, c.empresa_id, ator(a, c), payload, completo ? MODELO_COMPLETO : modeloImagem()]);
    await evento(tx, c, a, 'IA_RESERVADA', { geracao: i.chave, autorizacao: autorizacao.id, provedor, ...(imagens ? { imagens } : {}), ...(preparado ? { completo: true, estilo, foto: !!foto, referencia: preparado.referenciaEstiloId ?? null } : {}) });
    return { repetida: false as const, c, refs, preparado, autorizacaoId: autorizacao.id };
  });
  if (reserva.repetida) return reserva;
  const etapas: Etapas = { enviou: false, recebeu: false };
  const enviar = enviarComRegistro(i.chave, etapas, provedor, reserva.autorizacaoId);
  const p = reserva.preparado;
  let resultado: { imagem: Buffer; uso: unknown };
  try {
    // Uma única chamada: foto (imagem 1) e referência do estilo (imagem 2), sem retry nem troca de modelo.
    const r = p
      ? await gerarConviteCompletoOpenAI(p.promptImagem, enviar, process.env, qualidade, p.foto ? [p.foto, ...(p.referenciaEstilo ? [p.referenciaEstilo] : [])] : [])
      : await gerarImagem(i.prompt, reserva.refs, enviar, process.env, provedor);
    resultado = { imagem: p ? await armazenarConviteCompleto(r.imagem) : r.imagem, uso: r.uso };
  } catch (erro) {
    return registrarFalha(a, reserva.c, i.chave, etapas, erro);
  }
  const alvo = { id: i.chave, convite_id: reserva.c.id, empresa_id: reserva.c.empresa_id, modelo: p ? MODELO_COMPLETO : modeloImagem() };
  // Retentativas só da gravação local (nunca da chamada paga).
  for (let tentativa = 0; tentativa < 3; tentativa++) {
    if (tentativa) await esperar(400 * 2 ** tentativa);
    try {
      const arteId = await withTransaction(tx => concluirGeracao(tx, alvo, resultado.imagem, resultado.uso, ator(a, reserva.c), false));
      if (arteId) return { arteId, estado: 'CONCLUIDA', chave: i.chave, ...(p ? { completo: true } : {}) };
      return { chave: i.chave, estado: 'VERIFICANDO', mensagem: MENSAGEM_VERIFICANDO };
    } catch { console.error('[convites] Gravação da arte falhou; nova tentativa local.'); }
  }
  // Imagem guardada: a próxima leitura (desta ou de outra aba) conclui sem chamada. Sem ela, vai para verificação.
  if (etapas.recebeu) return { chave: i.chave, estado: 'EM_ANDAMENTO' };
  try {
    await withTransaction(async tx => {
      await tx.query('SELECT id FROM convites WHERE id=$1 FOR UPDATE', [reserva.c.id]);
      const g = (await tx.query<GeracaoAberta>('SELECT id,convite_id,empresa_id,ator,reserva_microusd,modelo FROM convite_geracoes WHERE id=$1 FOR UPDATE', [i.chave])).rows[0];
      if (g) await marcarIncerta(tx, g, 'ARMAZENAMENTO', 'gravacao_local', undefined, ator(a, reserva.c));
    });
  } catch { console.error('[convites] Falha de gravação não registrada; a reconciliação classifica depois.'); }
  return { chave: i.chave, estado: 'VERIFICANDO', mensagem: MENSAGEM_VERIFICANDO };
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
export async function consultarPublico(tokenPublico: string, tokenFamilia: string | null) {
  const { c, conteudo } = await publico(tokenPublico);
  return { conteudo, familia: tokenFamilia == null ? null : await dadosFamiliaPublica(db(), c, tokenFamilia) };
}
export async function confirmar(tokenPublico: string, raw: unknown, tokenFamilia: string | null = null) {
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
    // A chave de uma família vem do servidor; nunca confiamos no UUID enviado pelo visitante.
    const familia = tokenFamilia == null ? null : await validarFamilia(tx, atual, tokenFamilia);
    const chave = familia?.id ?? i.chave;
    if (!familia) exigir(!(await tx.query('SELECT id FROM convite_familias WHERE convite_id=$1 AND id=$2', [c.id, chave])).rows.length, 'Esta resposta exige o link individual da família.', 403);
    const repeticao = (await tx.query('SELECT chave FROM convite_respostas WHERE convite_id=$1 AND chave=$2', [c.id, chave])).rows.length;
    if (!repeticao) exigir(Number((await tx.query<{ n: string }>('SELECT count(*) n FROM convite_respostas WHERE convite_id=$1', [c.id])).rows[0].n) < 2000, 'Limite de respostas atingido. Contate o organizador.');
    const escrita = await tx.query(`INSERT INTO convite_respostas(convite_id,chave,nome,presenca,adultos,criancas,familia_id) VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT(convite_id,chave) DO UPDATE SET nome=excluded.nome,presenca=excluded.presenca,adultos=excluded.adultos,criancas=excluded.criancas,atualizado_em=now()
      WHERE convite_respostas.familia_id IS NOT DISTINCT FROM excluded.familia_id RETURNING chave`, [c.id, chave, familia?.nome ?? i.nome, i.presenca, i.presenca ? i.adultos : 0, i.presenca ? i.criancas : 0, familia?.id ?? null]);
    exigir(escrita.rows.length, 'Esta resposta exige o link individual da família.', 403);
    return { confirmado: true };
  });
}

export async function limitarHttp(chave: string, limite: number) {
  const r = await db().query(`INSERT INTO convite_limites_http(chave,janela) VALUES($1,date_trunc('hour',now()))
    ON CONFLICT(chave,janela) DO UPDATE SET usado=convite_limites_http.usado+1 WHERE convite_limites_http.usado < $2 RETURNING usado`, [hash(chave), limite]);
  exigir(r.rows.length, 'Muitas solicitações. Tente novamente mais tarde.', 429);
}
