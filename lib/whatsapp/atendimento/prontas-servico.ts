import { createHash, randomBytes } from 'node:crypto';
import type { DbExecutor } from '../../db/contracts.ts';
import type { SessaoParaTenant } from '../../saas/provar-tenant.ts';
import { buscarClientesPorContatoExato } from '../../clientes/repositories/cliente.repository.ts';
import { listarContratacoes } from '../../fechamentos/contratacoes.ts';
import { ambienteAtendimento } from './configuracao.ts';
import { acessoAtendimento, tem082, temMidia } from './service.ts';
import { ATALHOS_081, comporRascunho, ehAnexo, ehMidia, linkSeguro, midiaSegura, prontaEntradaSchema, usaRecursos082, type ArquivoPronta, type Pronta, type TipoAnexo, type TipoMidia } from './prontas.ts';
import { EXPLICACAO_SEM_LINK, resolverLinkFechamento } from './prontas-link.ts';
import { ARQUIVO_DISPONIVEL_SQL, caminhoPublicoArquivo, validarArquivo, type TipoArquivo } from './arquivos.ts';

/**
 * Serviço da biblioteca de mensagens prontas (080; fotos, vídeos e atalhos novos com a 081; PDF, arquivos próprios,
 * estados, finalidade, vínculos e envio automático autorizado com a 082). Mesma porta de acesso do atendimento: empresa
 * comprovada pela sessão e papel ADMINISTRATIVO ou REPRESENTANTE_AUTORIZADO; cadastrar, publicar, arquivar e enviar
 * arquivo só o representante. Nada aqui envia mensagem: o rascunho volta para a tela e o envio continua sendo a ação
 * "enviar" do atendente (ou o Wall-e, só com conteúdo PUBLICADO e autorizado, pelo worker).
 */
const colunas = (midia: boolean, r082: boolean) => [
  'p.id,p.titulo,p.categoria,p.tipo,p.texto,p.link', midia ? 'p.midia_url' : 'NULL::text AS midia_url', 'p.atalho,p.versao,p.atualizada_em',
  r082 ? `p.estado,p.envio_automatico,p.finalidade,p.pacote_codigo,p.estabelecimento_id,p.arquivo_id,a.tipo AS arquivo_tipo,a.nome AS arquivo_nome,a.tamanho_bytes AS arquivo_tamanho,a.token AS arquivo_token`
    : `'PUBLICADA'::text AS estado,false AS envio_automatico,NULL::text AS finalidade,NULL::text AS pacote_codigo,NULL::uuid AS estabelecimento_id,NULL::uuid AS arquivo_id`,
].join(',');
// D3: arquivo revogado ou vencido não aparece (a pronta fica sem anexo e não é usada).
const deProntas = (r082: boolean) => `whatsapp_atendimento_mensagens_prontas p${r082 ? ` LEFT JOIN whatsapp_atendimento_arquivos a ON a.id=p.arquivo_id AND a.empresa_id=p.empresa_id AND a.ambiente=p.ambiente AND ${ARQUIVO_DISPONIVEL_SQL}` : ''}`;
type LinhaPronta = Pronta & { arquivo_id?: string | null; arquivo_tipo?: TipoAnexo | null; arquivo_nome?: string | null; arquivo_tamanho?: number | null; arquivo_token?: string | null };
function paraPronta({ arquivo_id, arquivo_tipo, arquivo_nome, arquivo_tamanho, arquivo_token, ...p }: LinhaPronta): Pronta {
  const arquivo: ArquivoPronta | null = arquivo_id && arquivo_tipo && arquivo_nome && arquivo_token
    ? { id: arquivo_id, tipo: arquivo_tipo, nome: arquivo_nome, tamanho: Number(arquivo_tamanho), caminho: caminhoPublicoArquivo(arquivo_id, arquivo_token, arquivo_nome) } : null;
  return { ...p, versao: Number(p.versao), arquivo };
}

/** Sem a 080 a biblioteca fica indisponível, sem derrubar o atendimento; conflitos e vínculos viram mensagens claras. */
function traduzir(erro: unknown) {
  const e = erro as { code?: string; constraint?: string };
  if (e?.code === '42P01') return new Error('ATENDIMENTO_PRONTAS_INDISPONIVEL');
  if (e?.code === '23505' && e.constraint === 'whatsapp_prontas_atalho_unico') return new Error('ATENDIMENTO_PRONTA_ATALHO_EM_USO');
  if (e?.code === '23505' && e.constraint === 'whatsapp_prontas_titulo_unico') return new Error('ATENDIMENTO_PRONTA_TITULO_EM_USO');
  if (e?.code === '23503' && e.constraint === 'whatsapp_prontas_arquivo') return new Error('ATENDIMENTO_ARQUIVO_INVALIDO');
  if (e?.code === '23503' && e.constraint === 'whatsapp_prontas_estabelecimento') return new Error('ATENDIMENTO_UNIDADE_NAO_ENCONTRADA');
  return erro;
}
async function comBiblioteca<T>(sessao: SessaoParaTenant, work: (tx: DbExecutor, empresa: string, papel: string, ambiente: string) => Promise<T>) {
  try { return await acessoAtendimento(sessao, (tx, empresa, papel) => work(tx, empresa, papel, ambienteAtendimento())); }
  catch (erro) { throw traduzir(erro); }
}
const representante = (papel: string) => { if (papel !== 'REPRESENTANTE_AUTORIZADO') throw new Error('ATENDIMENTO_ACESSO_NEGADO'); };

/**
 * `gerenciar`: tela da biblioteca (todos os estados, arquivadas no fim, mais unidades e pacotes vigentes para os
 * vínculos). Sem ela: painel do atendente, só PUBLICADAS (rascunho e arquivada nunca aparecem para uso).
 */
export async function listarProntas(sessao: SessaoParaTenant, opcoes: { gerenciar?: boolean } = {}) {
  return comBiblioteca(sessao, async (tx, empresa, papel, ambiente) => {
    const midia = await temMidia(tx), r082 = await tem082(tx);
    const filtro = opcoes.gerenciar ? '' : r082 ? " AND p.ativa AND p.estado='PUBLICADA'" : ' AND p.ativa';
    const prontas = (await tx.query<LinhaPronta>(`SELECT ${colunas(midia, r082)} FROM ${deProntas(r082)} WHERE p.empresa_id=$1 AND p.ambiente=$2${filtro}
      ORDER BY p.ativa DESC, p.atalho NULLS LAST, p.categoria, p.titulo LIMIT 500`, [empresa, ambiente])).rows.map(paraPronta);
    const favoritas = (await tx.query<{ id: string }>(`SELECT f.mensagem_pronta_id AS id FROM whatsapp_atendimento_mensagens_prontas_favoritas f JOIN whatsapp_atendimento_mensagens_prontas p ON p.id=f.mensagem_pronta_id AND p.empresa_id=f.empresa_id AND p.ambiente=f.ambiente AND p.ativa${r082 ? " AND p.estado='PUBLICADA'" : ''} WHERE f.usuario_id=$1 AND f.empresa_id=$2 AND f.ambiente=$3`, [sessao.usuario_id, empresa, ambiente])).rows.map(r => r.id);
    const vinculos = opcoes.gerenciar && r082 ? {
      unidades: (await tx.query<{ id: string; nome: string }>("SELECT id,nome FROM estabelecimentos WHERE empresa_id=$1 AND status<>'DESATIVADO' ORDER BY nome", [empresa])).rows,
      pacotes: (await tx.query<{ codigo: string; nome: string }>('SELECT codigo,nome FROM pacotes WHERE empresa_id=$1 AND ativo AND vigente AND arquivado_em IS NULL ORDER BY ordem_exibicao,nome', [empresa])).rows,
    } : { unidades: [], pacotes: [] };
    // recursos081: fotos, vídeos e atalhos novos; recursos082: PDF, arquivos próprios, estados e envio automático.
    return { prontas, favoritas, podeGerenciar: papel === 'REPRESENTANTE_AUTORIZADO', recursos081: midia, recursos082: r082, ...vinculos };
  });
}

export async function salvarPronta(sessao: SessaoParaTenant, valor: unknown) {
  const p = prontaEntradaSchema.parse(valor);
  const link = p.tipo === 'LINK' ? linkSeguro(p.link ?? '') : null;
  const midiaUrl = ehMidia(p.tipo) && !p.arquivoId ? midiaSegura(p.tipo as TipoMidia, p.midiaUrl ?? '') : null;
  return comBiblioteca(sessao, async (tx, empresa, papel, ambiente) => {
    representante(papel);
    const midia = await temMidia(tx), r082 = await tem082(tx);
    // Sem a 081/082 o banco recusaria; a mensagem diz o que falta em vez de um erro genérico.
    if (!midia && (ehMidia(p.tipo) || (p.atalho && ATALHOS_081.includes(p.atalho)))) throw new Error('ATENDIMENTO_MIDIA_INDISPONIVEL');
    if (!r082 && usaRecursos082(p)) throw new Error('ATENDIMENTO_RECURSO_082_INDISPONIVEL');
    // Pacote por CÓDIGO (estável entre revisões): precisa existir vigente nesta empresa.
    if (p.pacoteCodigo && !(await tx.query('SELECT 1 FROM pacotes WHERE empresa_id=$1 AND codigo=$2 AND ativo AND vigente AND arquivado_em IS NULL', [empresa, p.pacoteCodigo])).rows.length) throw new Error('ATENDIMENTO_PACOTE_NAO_ENCONTRADO');
    if (!p.id) {
      const r = r082
        ? await tx.query<{ id: string }>(`INSERT INTO whatsapp_atendimento_mensagens_prontas(empresa_id,ambiente,titulo,categoria,tipo,texto,link,midia_url,atalho,estado,envio_automatico,finalidade,pacote_codigo,estabelecimento_id,arquivo_id,criada_por,atualizada_por)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16) RETURNING id`, [empresa, ambiente, p.titulo, p.categoria, p.tipo, p.texto, link, midiaUrl, p.atalho, p.estado, p.envioAutomatico, p.finalidade, p.pacoteCodigo, p.estabelecimentoId, p.arquivoId, sessao.usuario_id])
        : midia
          ? await tx.query<{ id: string }>(`INSERT INTO whatsapp_atendimento_mensagens_prontas(empresa_id,ambiente,titulo,categoria,tipo,texto,link,midia_url,atalho,criada_por,atualizada_por)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) RETURNING id`, [empresa, ambiente, p.titulo, p.categoria, p.tipo, p.texto, link, midiaUrl, p.atalho, sessao.usuario_id])
          : await tx.query<{ id: string }>(`INSERT INTO whatsapp_atendimento_mensagens_prontas(empresa_id,ambiente,titulo,categoria,tipo,texto,link,atalho,criada_por,atualizada_por)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING id`, [empresa, ambiente, p.titulo, p.categoria, p.tipo, p.texto, link, p.atalho, sessao.usuario_id]);
      return { id: r.rows[0].id };
    }
    // Editar cria nova versão: o envio preso à prévia recusa a versão antiga; o Wall-e passa a usar a vigente.
    const r = r082
      ? await tx.query<{ id: string }>(`UPDATE whatsapp_atendimento_mensagens_prontas SET titulo=$5,categoria=$6,tipo=$7,texto=$8,link=$9,midia_url=$10,atalho=$11,estado=$12,envio_automatico=$13,finalidade=$14,pacote_codigo=$15,estabelecimento_id=$16,arquivo_id=$17,atualizada_por=$18,versao=versao+1,atualizada_em=clock_timestamp()
        WHERE id=$1 AND empresa_id=$2 AND ambiente=$3 AND versao=$4 AND ativa RETURNING id`, [p.id, empresa, ambiente, p.versao ?? -1, p.titulo, p.categoria, p.tipo, p.texto, link, midiaUrl, p.atalho, p.estado, p.envioAutomatico, p.finalidade, p.pacoteCodigo, p.estabelecimentoId, p.arquivoId, sessao.usuario_id])
      : midia
        ? await tx.query<{ id: string }>(`UPDATE whatsapp_atendimento_mensagens_prontas SET titulo=$5,categoria=$6,tipo=$7,texto=$8,link=$9,midia_url=$10,atalho=$11,atualizada_por=$12,versao=versao+1,atualizada_em=clock_timestamp()
          WHERE id=$1 AND empresa_id=$2 AND ambiente=$3 AND versao=$4 AND ativa RETURNING id`, [p.id, empresa, ambiente, p.versao ?? -1, p.titulo, p.categoria, p.tipo, p.texto, link, midiaUrl, p.atalho, sessao.usuario_id])
        : await tx.query<{ id: string }>(`UPDATE whatsapp_atendimento_mensagens_prontas SET titulo=$5,categoria=$6,tipo=$7,texto=$8,link=$9,atalho=$10,atualizada_por=$11,versao=versao+1,atualizada_em=clock_timestamp()
          WHERE id=$1 AND empresa_id=$2 AND ambiente=$3 AND versao=$4 AND ativa RETURNING id`, [p.id, empresa, ambiente, p.versao ?? -1, p.titulo, p.categoria, p.tipo, p.texto, link, p.atalho, sessao.usuario_id]);
    if (!r.rows.length) throw new Error('ATENDIMENTO_PRONTA_DESATUALIZADA');
    return { id: p.id };
  });
}

/** Publicar (vira a versão vigente para uso e, se autorizada, para o Wall-e) ou voltar a rascunho. Nova versão. */
export async function publicarPronta(sessao: SessaoParaTenant, pedido: { id: string; versao: number; publicar: boolean }) {
  return comBiblioteca(sessao, async (tx, empresa, papel, ambiente) => {
    representante(papel);
    if (!(await tem082(tx))) throw new Error('ATENDIMENTO_RECURSO_082_INDISPONIVEL');
    const r = await tx.query(`UPDATE whatsapp_atendimento_mensagens_prontas SET estado=$5,atualizada_por=$6,versao=versao+1,atualizada_em=clock_timestamp()
      WHERE id=$1 AND empresa_id=$2 AND ambiente=$3 AND versao=$4 AND ativa RETURNING id`, [pedido.id, empresa, ambiente, pedido.versao, pedido.publicar ? 'PUBLICADA' : 'RASCUNHO', sessao.usuario_id]);
    if (!r.rows.length) throw new Error('ATENDIMENTO_PRONTA_DESATUALIZADA');
  });
}

export async function arquivarPronta(sessao: SessaoParaTenant, pedido: { id: string; versao: number }) {
  return comBiblioteca(sessao, async (tx, empresa, papel, ambiente) => {
    representante(papel);
    // Remoção lógica: conversas e histórico não dependem desta linha; favoritas deixam de aparecer; novos usos (pela
    // equipe e pelo Wall-e) param; o que já foi enviado continua no histórico.
    const r = await tx.query(`UPDATE whatsapp_atendimento_mensagens_prontas SET ativa=false,atalho=NULL,${(await tem082(tx)) ? "estado='ARQUIVADA'," : ''}atualizada_por=$5,versao=versao+1,atualizada_em=clock_timestamp()
      WHERE id=$1 AND empresa_id=$2 AND ambiente=$3 AND versao=$4 AND ativa RETURNING id`, [pedido.id, empresa, ambiente, pedido.versao, sessao.usuario_id]);
    if (!r.rows.length) throw new Error('ATENDIMENTO_PRONTA_DESATUALIZADA');
  });
}

export async function favoritarPronta(sessao: SessaoParaTenant, pedido: { id: string; favorita: boolean }) {
  return comBiblioteca(sessao, async (tx, empresa, _papel, ambiente) => {
    if (!pedido.favorita) {
      await tx.query('DELETE FROM whatsapp_atendimento_mensagens_prontas_favoritas WHERE usuario_id=$1 AND mensagem_pronta_id=$2 AND empresa_id=$3 AND ambiente=$4', [sessao.usuario_id, pedido.id, empresa, ambiente]);
      return;
    }
    const existe = (await tx.query(`SELECT id FROM whatsapp_atendimento_mensagens_prontas WHERE id=$1 AND empresa_id=$2 AND ambiente=$3 AND ativa${(await tem082(tx)) ? " AND estado='PUBLICADA'" : ''}`, [pedido.id, empresa, ambiente])).rows.length;
    if (!existe) throw new Error('ATENDIMENTO_PRONTA_NAO_ENCONTRADA');
    await tx.query('INSERT INTO whatsapp_atendimento_mensagens_prontas_favoritas(usuario_id,mensagem_pronta_id,empresa_id,ambiente) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [sessao.usuario_id, pedido.id, empresa, ambiente]);
  });
}

/**
 * Arquivo próprio da biblioteca (082): validado pelos primeiros bytes (tipo real), limite por tipo, hash conferido pelo
 * banco, token aleatório para a URL pública. Só inserção. Fica disponível para ser usado numa pronta da mesma empresa.
 */
/** Pré-conferência de papel (antes de ler um upload): só o representante gerencia a biblioteca e envia arquivos. */
export async function exigirGestaoBiblioteca(sessao: SessaoParaTenant) {
  return comBiblioteca(sessao, async (_tx, _empresa, papel) => { representante(papel); });
}
export async function salvarArquivo(sessao: SessaoParaTenant, entrada: { nome: string; bytes: Uint8Array; tipoEsperado?: TipoArquivo }) {
  const arquivo = validarArquivo(entrada.nome, entrada.bytes, entrada.tipoEsperado);
  return comBiblioteca(sessao, async (tx, empresa, papel, ambiente) => {
    representante(papel);
    if (!(await tem082(tx))) throw new Error('ATENDIMENTO_RECURSO_082_INDISPONIVEL');
    const conteudo = Buffer.from(entrada.bytes.buffer, entrada.bytes.byteOffset, entrada.bytes.byteLength);
    const token = randomBytes(32).toString('base64url');
    const r = await tx.query<{ id: string }>(`INSERT INTO whatsapp_atendimento_arquivos(empresa_id,ambiente,tipo,mime,nome,tamanho_bytes,sha256,conteudo,token,criado_por)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, [empresa, ambiente, arquivo.tipo, arquivo.mime, arquivo.nome, arquivo.tamanho, createHash('sha256').update(conteudo).digest('hex'), conteudo, token, sessao.usuario_id]);
    const id = r.rows[0].id;
    return { id, tipo: arquivo.tipo, nome: arquivo.nome, tamanho: arquivo.tamanho, caminho: caminhoPublicoArquivo(id, token, arquivo.nome) } satisfies ArquivoPronta;
  });
}

/**
 * Rascunho para a conversa aberta: só leitura e só de conteúdo PUBLICADO. O link individual de fechamento só é
 * preenchido com vínculo inequívoco (empresa comprovada → conversa da empresa → um único cliente da empresa com o
 * telefone → um único contrato aguardando a assinatura dele, pelo fluxo de contratações). O telefone não volta para a tela.
 */
export async function prepararRascunho(sessao: SessaoParaTenant, pedido: { conversaId: string; id: string }) {
  return comBiblioteca(sessao, async (tx, empresa, _papel, ambiente) => {
    const conversa = (await tx.query<{ contato: string }>('SELECT contato FROM whatsapp_atendimento_conversas WHERE id=$1 AND empresa_id=$2 AND ambiente=$3', [pedido.conversaId, empresa, ambiente])).rows[0];
    if (!conversa) throw new Error('ATENDIMENTO_NAO_ENCONTRADO');
    const r082 = await tem082(tx);
    const linha = (await tx.query<LinhaPronta>(`SELECT ${colunas(await temMidia(tx), r082)} FROM ${deProntas(r082)} WHERE p.id=$1 AND p.empresa_id=$2 AND p.ambiente=$3 AND p.ativa${r082 ? " AND p.estado='PUBLICADA'" : ''}`, [pedido.id, empresa, ambiente])).rows[0];
    if (!linha) throw new Error('ATENDIMENTO_PRONTA_NAO_ENCONTRADA');
    const pronta = paraPronta(linha);
    // Foto, vídeo ou PDF: a prévia leva a legenda editável e o anexo para conferência; no envio vão o id e a VERSÃO desta
    // mensagem (o envio é recusado se ela mudar até lá: o anexo enviado é sempre o que foi visto).
    if (ehAnexo(pronta.tipo) && (pronta.midia_url || pronta.arquivo)) {
      return { titulo: pronta.titulo, texto: pronta.texto, linkIndividual: null, aviso: null,
        midia: { tipo: pronta.tipo, url: pronta.arquivo?.caminho ?? pronta.midia_url!, ...(pronta.arquivo ? { nome: pronta.arquivo.nome } : {}), prontaId: pronta.id, versao: pronta.versao } };
    }
    if (pronta.tipo !== 'LINK_FECHAMENTO_INDIVIDUAL') return { titulo: pronta.titulo, texto: comporRascunho(pronta.texto, pronta.link), linkIndividual: null, aviso: null };
    const link = await resolverLinkFechamento(empresa, conversa.contato, {
      clientesPorTelefone: telefone => buscarClientesPorContatoExato(telefone, empresa, tx),
      contratacoesDoCliente: clienteId => listarContratacoes(tx, empresa, clienteId),
      origemPublica: process.env.ADMIN_AUTH_ORIGIN,
    });
    return link.ok
      ? { titulo: pronta.titulo, texto: comporRascunho(pronta.texto, link.link), linkIndividual: 'PREENCHIDO' as const, aviso: null }
      : { titulo: pronta.titulo, texto: pronta.texto, linkIndividual: 'NAO_PREENCHIDO' as const, aviso: EXPLICACAO_SEM_LINK[link.motivo] };
  });
}
