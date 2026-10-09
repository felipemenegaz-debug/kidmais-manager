// Simulação SEM banco do caminho de uma conversa no atendimento, com as funções do CÓDIGO AVALIADO (passadas em `m`):
//   recepção — espelho de service.receberEntrada: entrada nova sobe a versão; PARAR (comandoDireto) bloqueia de vez
//              (ENCERRADA + nao_contatar; com reclamação junto, AGUARDANDO_HUMANO + nao_contatar + registro para a equipe,
//              rodada 18, quando o código avaliado tem registroDoBloqueio); com a equipe ou bloqueada, nada é automático;
//   worker   — só a tarefa válida (worker.mensagemAindaValida) chega ao Wall-e;
//   Wall-e   — entender (regras ou modelo revalidado) → sinais (locais + triagem do JEV, como a porta) → resolver;
//              sem saída ou falha ⇒ encaminhamento fixo para a equipe; passagem ⇒ AGUARDANDO_HUMANO.
// Só a transição da recepção é espelhada (não importada); a prova no banco real está em walle-worker.postgres.test.ts.

/** Detalhe de erro do provedor, saneado: só status numérico e identificadores curtos (nada de mensagem, chave ou texto). */
const ID = /^[a-z0-9_.-]{1,60}$/i;
export function detalheSaneado(d) {
  if (!d || typeof d !== 'object') return null;
  const id = (v) => (typeof v === 'string' && ID.test(v) ? v : null);
  return { status: Number.isInteger(d.status) ? d.status : null, tipo: id(d.tipo), codigo: id(d.codigo), parametro: id(d.parametro) };
}
/** Intenções no vocabulário do corpus: as do entendimento + alergia + sinais + PARAR. */
const INTENCAO = { DUVIDA: 'DUVIDA_FAQ', OUTRO: 'FORA_DO_ESCOPO', EXTERNO: 'FORA_DO_ESCOPO' };
const TURNO = { TURNO_1: 'ALMOCO', TURNO_2: 'NOITE' };
const UNIDADE = { 'u-asa-sul': 'ASA_SUL', 'u-aguas-claras': 'AGUAS_CLARAS' };
function intencoesPrevistas(entendimento, sinais, parar) {
  const s = new Set();
  if (parar) s.add('PARAR');
  for (const i of entendimento?.intencoes ?? []) s.add(INTENCAO[i.tipo] ?? i.tipo);
  if (entendimento?.alergia) s.add('ALERGIA');
  if (sinais?.reclamacao) s.add('RECLAMACAO');
  if (sinais?.pagamento || sinais?.pagamentoAcao) s.add('PAGAMENTO');
  if (sinais?.instrucao) s.add('INSTRUCAO');
  return [...s].sort();
}
const entidadesPrevistas = (e) => (e ? { data: e.data, convidados: e.convidados, turno: TURNO[e.turno] ?? null, pacotes: [...e.pacotes].sort(), unidade: UNIDADE[e.unidade] ?? null, tema: e.tema } : null);

/**
 * Uma sequência (mensagem avulsa ou conversa, na ordem). `entender(texto, contexto)` devolve o entendimento JÁ
 * revalidado (regras, ou modelo + revalidarEntendimento); `usos()` (opcional) devolve os usos de modelo registrados.
 */
export async function simularSequencia(m, itens, { catalogos, config, fontes, agora, entender, usos = () => [], rotulos = {} }) {
  // Rodada 32: `contexto.semAutomatico` da conversa (075) — a marca persistente da pausa, gravada pelo worker quando o
  // Wall-e passa em silêncio um pedido de parar sem bloqueio (PARAR_A_CONFIRMAR). Com ela, nada é automático: nem
  // entrada processada (worker.mensagemAindaValida do código avaliado lê a marca), nem reabertura depois do encerramento,
  // nem "Devolver ao Wall-e" (recusado: ATENDIMENTO_PAUSA_PEDIDA).
  let conversa = { estado: 'IA', nao_contatar: false, versao: 0, ultima_entrada_em: agora, contexto: {} };
  const pausada = (c) => !!c.contexto?.semAutomatico && typeof c.contexto.semAutomatico === 'object';
  let contexto = {};
  const linhas = [];
  for (const item of itens) {
    const t0 = performance.now();
    const usosAntes = usos().length;
    // Rodada 32: ação da equipe ANTES desta mensagem (item.equipe: 'retomar' | 'encerrar' | 'assumir'), espelho de
    // service.controlarAtendimento: "retomar" com a marca de pausa é recusado; os demais mudam o estado.
    let acaoEquipe = null;
    if (item.equipe) {
      if (item.equipe === 'retomar' && pausada(conversa)) acaoEquipe = 'RECUSADA_PAUSA_PEDIDA';
      else { conversa = { ...conversa, estado: item.equipe === 'retomar' ? 'IA' : item.equipe === 'encerrar' ? 'ENCERRADA' : 'HUMANO', versao: conversa.versao + 1 }; acaoEquipe = item.equipe.toUpperCase(); }
    }
    // Recepção (encerrada pela equipe reabre no automático só sem a marca de pausa; com ela, vai para a equipe)
    conversa = { ...conversa, versao: conversa.versao + 1, ultima_entrada_em: agora };
    if (conversa.estado === 'ENCERRADA' && !conversa.nao_contatar) conversa.estado = pausada(conversa) ? 'AGUARDANDO_HUMANO' : 'IA';
    if (conversa.estado === 'IA' && pausada(conversa)) conversa.estado = 'AGUARDANDO_HUMANO';
    const automatico = !conversa.nao_contatar && !pausada(conversa) && conversa.estado === 'IA';
    const mensagem = { direcao: 'ENTRADA', versao_conversa: conversa.versao, criada_em: agora, autor_usuario_id: null };
    const parar = m.comandoDireto(item.texto)?.intencao === 'PARAR';
    const registroRecepcao = parar && m.registroDoBloqueio ? m.registroDoBloqueio(item.texto, agora) : null;
    if (parar) conversa = { ...conversa, estado: registroRecepcao ? 'AGUARDANDO_HUMANO' : 'ENCERRADA', nao_contatar: true, versao: conversa.versao + 1 };
    // Rodada 47: espelho da recepção — pedido de pausa numa mensagem que o Wall-e não processa (conversa com a equipe)
    // grava a marca persistente (só no código avaliado que tem m.pausaPedidaNaRecepcao; o antigo não registrava).
    const pausaNaRecepcao = !automatico && !parar && !conversa.nao_contatar && !pausada(conversa) && !!m.pausaPedidaNaRecepcao?.(item.texto);
    if (pausaNaRecepcao) conversa = { ...conversa, contexto: { ...conversa.contexto, semAutomatico: { motivo: 'PARAR_A_CONFIRMAR', em: agora, origem: 'RECEPCAO' } }, versao: conversa.versao + 1 };
    // Worker
    const valida = automatico && m.mensagemAindaValida(mensagem, conversa, new Date(agora));
    const r = { decisao: null, motivos: [], saidas: [], pendente: [], pendentePara: null, entendimento: null, sinais: null, falha: null, msEntender: 0 };
    if (!valida) {
      r.decisao = parar ? 'PARAR' : conversa.nao_contatar ? 'SEM_RESPOSTA' : 'EQUIPE';
      r.motivos = [parar ? 'PARAR' : conversa.nao_contatar ? 'BLOQUEADA' : 'COM_A_EQUIPE', ...(!parar && !conversa.nao_contatar && pausada(conversa) ? ['PAUSA_PEDIDA'] : []), ...(registroRecepcao?.motivos ?? [])];
    } else {
      const ctx = m.lerContexto(contexto);
      // Rodada 20: o que a conversa já tinha antes desta mensagem (para a régua de perguntas desnecessárias).
      r.contextoAntes = { data: ctx.data ?? null, turno: ctx.turno ?? null, convidados: ctx.convidados ?? null, pacote: ctx.pacote ?? null, unidade: ctx.unidade ?? null, tema: ctx.tema ?? null };
      const te = performance.now();
      try { r.entendimento = await entender(item.texto, ctx); } catch (erro) { r.falha = String(erro?.message ?? erro).slice(0, 80); }
      r.msEntender = performance.now() - te;
      if (r.entendimento) {
        const jev = m.sinaisJev(item.texto);
        r.entendimento.sinais = m.juntarSinais ? m.juntarSinais(r.entendimento.sinais, jev, item.texto) : jev;
        r.sinais = r.entendimento.sinais;
        // Rodada 23: as consultas feitas às fontes oficiais nesta mensagem (agenda, preço, pacotes, materiais…).
        r.consultas = [];
        // Rodada 25: e os argumentos (a data usada na agenda e no cálculo).
        r.consultasDetalhe = [];
        const registradas = Object.fromEntries(Object.entries(fontes).map(([k, f]) => [k, typeof f === 'function' ? (...a) => { r.consultas.push(k); r.consultasDetalhe.push({ fonte: k, args: a.slice(0, 4) }); return f(...a); } : f]));
        const res = await m.resolverWallE({ texto: item.texto, entendimento: r.entendimento, contexto: ctx, config, catalogos, agora }, registradas);
        r.saidas = res.saidas;
        r.cuidadosAfastados = res.cuidadosAfastados ?? [];
        // Worker (espelho de responderWallE): pedido de parar do Wall-e bloqueia como a recepção; ambíguo passa em silêncio.
        if (res.parar) { r.decisao = 'PARAR'; r.motivos = ['PARAR_WALLE', ...(res.passagem?.motivos ?? [])]; conversa = { ...conversa, estado: res.passagem ? 'AGUARDANDO_HUMANO' : 'ENCERRADA', nao_contatar: true, versao: conversa.versao + 1 }; }
        else if (res.silencio && res.passagem) {
          r.decisao = 'EQUIPE'; r.motivos = res.passagem.motivos; conversa.estado = 'AGUARDANDO_HUMANO';
          // Espelho de worker.passarEmSilencio: a pausa grava a marca persistente na conversa.
          if (res.passagem.motivos.includes('PARAR_A_CONFIRMAR')) conversa = { ...conversa, contexto: { ...conversa.contexto, semAutomatico: { motivo: 'PARAR_A_CONFIRMAR', em: res.passagem.em } } };
        }
        else if (!res.saidas.length) { r.decisao = 'EQUIPE'; r.motivos = ['FALHA_SEM_SAIDA']; conversa.estado = 'AGUARDANDO_HUMANO'; }
        else {
          const c = { ...res.contexto }; delete c.ultimoEntendimento; contexto = c;
          conversa.estado = res.passagem ? 'AGUARDANDO_HUMANO' : 'IA';
          r.decisao = res.passagem ? 'EQUIPE' : res.contexto.pendente && !res.contexto.pendente.opcional ? 'PERGUNTAR' : 'RESPONDER';
          r.motivos = res.passagem?.motivos ?? [];
          r.pendente = res.contexto.pendente?.campos ?? [];
          r.pendentePara = res.contexto.pendente?.para ?? null;
          // Rodada 27: o contexto comercial depois da resposta (alteração indevida em festa contratada).
          r.contextoDepois = { data: res.contexto.data ?? null, turno: res.contexto.turno ?? null, convidados: res.contexto.convidados ?? null, pacote: res.contexto.pacote ?? null, unidade: res.contexto.unidade ?? null, tema: res.contexto.tema ?? null };
        }
      } else { r.decisao = 'EQUIPE'; r.motivos = ['FALHA']; conversa.estado = 'AGUARDANDO_HUMANO'; }
    }
    linhas.push({
      id: item.id, conversa: item.conversa ?? null, ordem: item.ordem ?? null, texto: item.texto,
      // Rótulo revisado pelas fontes disponíveis (rotulos-revisados.json), quando houver; o original fica registrado.
      esperado: { decisao: rotulos[item.id]?.decisao ?? (item.intencoes.includes('PARAR') && !['SEM_RESPOSTA', 'PARAR_MISTO'].includes(item.decisao) ? 'PARAR' : item.decisao), intencoes: [...item.intencoes].sort(), entidades: item.entidades, ...(rotulos[item.id] ? { revisado: rotulos[item.id], original: item.decisao } : {}) },
      decisao: r.decisao, motivos: r.motivos, bloqueada: conversa.nao_contatar, estadoDepois: conversa.estado,
      // Rodada 32: a marca persistente de pausa depois desta mensagem, a ação da equipe antes dela e os cuidados só do
      // modelo afastados por consulta comum (política de combinação, com o critério).
      semAutomatico: pausada(conversa), ...(acaoEquipe ? { acaoEquipe } : {}), ...(r.cuidadosAfastados?.length ? { cuidadosAfastados: r.cuidadosAfastados } : {}),
      pendente: r.pendente, pendentePara: r.pendentePara, contextoAntes: r.contextoAntes ?? null, contextoDepois: r.contextoDepois ?? null, consultas: r.consultas ?? [], consultasDetalhe: r.consultasDetalhe ?? [], opcional: !!contexto.pendente?.opcional && r.decisao === 'RESPONDER',
      saidas: r.saidas.map((s) => ({ texto: s.texto, anexo: s.anexo?.prontaId ?? null, fontes: s.fontes })),
      resposta: r.saidas.map((s) => (s.anexo ? `[anexo ${s.anexo.prontaId}]` : s.texto)).join(' | '), // Rodada 36: a resposta inteira (o corte em 700 escondia o fim da resposta da régua e do relatório).
      intencoes: intencoesPrevistas(r.entendimento, r.sinais, parar), entidades: entidadesPrevistas(r.entendimento?.entidades),
      semFonte: r.entendimento?.semFonte ?? [], falha: r.falha,
      ms: { entender: +r.msEntender.toFixed(2), total: +(performance.now() - t0).toFixed(2) },
      // Rodada 31: em falha, o detalhe SANEADO do provedor (status HTTP e identificadores tipo/código/parâmetro) — nunca a
      // chave, a mensagem do provedor ou o conteúdo; identificador fora de [a-z0-9_.-] vira null.
      modelo: usos().slice(usosAntes).map((u) => ({ sucesso: u.sucesso, erro: u.erro, tokensEntrada: u.tokensEntrada, tokensSaida: u.tokensSaida, tokensCache: u.tokensCache, custoMicros: u.custoEstimadoMicros, duracaoMs: u.duracaoMs, detalheErro: detalheSaneado(u.detalheErro) })),
    });
  }
  return linhas;
}

/** Sequências do corpus: avulsas sozinhas; conversas na ordem. */
export function sequenciasDoCorpus(itens) {
  const seqs = [];
  for (const item of itens) {
    if (!item.conversa) { seqs.push([item]); continue; }
    let s = seqs.find((q) => q[0].conversa === item.conversa);
    if (!s) seqs.push((s = []));
    s.push(item);
  }
  for (const s of seqs) s.sort((a, b) => (a.ordem ?? 0) - (b.ordem ?? 0));
  return seqs;
}
