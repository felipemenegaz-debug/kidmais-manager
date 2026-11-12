/**
 * Salvar manual do rascunho do modelo de contrato (plano modelo de contrato v3, D6 e rev. 10), sem React e sem rede:
 * fetch, relógio e gerador de envioId são injetados (testes com promessas controladas e relógio simulado).
 *   - Um envio por vez; marca salvo só se não houve edição durante o envio (revisaoLocal enviada = atual).
 *   - Prazo de 15 s para a operação inteira (confirmações de sessão + requisição + corpo); estourou ou falhou a rede →
 *     estado INCERTO, texto mantido, envioId guardado como pendente. Nada é cancelado no servidor.
 *   - Conferir (GET): situação encerrada (publicada/descartada em outra aba) → para tudo; envioId pendente no servidor →
 *     chegou; mesma versão → ainda não confirmado; versão maior → conflito.
 *   - 409 depois de envio incerto: confere; se o pendente chegou, adota e reenvia UMA vez; segundo 409 → conflito.
 *   - Respostas antigas (de Salvar ou Conferir que não são mais os correntes) são ignoradas.
 */
export const PRAZO_MS = 15_000;

export type RevisaoEnviada = { conteudo: unknown; avisos: string[] };
export type RascunhoServidor = {
  id: string;
  situacao: string;
  versao: number;
  revisao: { conteudo: unknown; avisos: string[]; envioId?: string } | null;
  [outro: string]: unknown;
};
export type RespostaServidor = { ok: true; data: RascunhoServidor } | { ok: false; status: number; erro: string };
export type DependenciasSalvamento = {
  /** Não lança para respostas HTTP (devolve ok:false); lança em falha de rede ou de confirmação de sessão. */
  patch(corpo: { versao: number; revisao: RevisaoEnviada & { envioId: string } }): Promise<RespostaServidor>;
  get(): Promise<RespostaServidor>;
  definirPrazo(fn: () => void, ms: number): unknown;
  limparPrazo(id: unknown): void;
  novoEnvioId(): string;
  agora(): Date;
};

export type EstadoSalvamento = {
  versao: number;
  revisaoLocal: number;
  revisaoSalva: number;
  enviando: boolean;
  conferindo: boolean;
  /** Envios sem resposta (podem ou não ter sido gravados). */
  pendentes: Array<{ envioId: string; revisaoLocal: number }>;
  /** Conferido: o servidor segue na versão conhecida e sem o envio pendente (ainda pode chegar). */
  naoConfirmado: boolean;
  falhaConferir: boolean;
  conflito: boolean;
  encerrado: null | { situacao: string; pendenteChegou: boolean };
  salvoEm: Date | null;
  motivo: string | null;
};

export type ResultadoConferir = "chegou" | "nao_confirmado" | "conflito" | "encerrado" | "falha" | "ignorada";
/** ignorada: resposta de um envio que não é mais o corrente (reiniciado ou descartado); quem chama não aplica nada. */
export type ResultadoSalvar = { ok: true; rascunho: RascunhoServidor } | { ok: false; motivo: string; incerto?: boolean; ignorada?: true };

type ComPrazo<T> = { tipo: "ok"; valor: T } | { tipo: "prazo" } | { tipo: "falha"; erro: string };

export const MENSAGEM_INCERTO = "O salvamento não foi confirmado. Ele pode ou não ter sido gravado, e ainda pode ser concluído.";
export const MENSAGEM_NAO_CONFIRMADO = "O salvamento ainda não foi confirmado no servidor. Ele ainda pode chegar.";
export const MENSAGEM_FALHA_CONFERIR = "Não foi possível conferir o salvamento.";
export const MENSAGEM_CONFLITO = "Este rascunho foi alterado em outra aba ou por outra pessoa.";

export function mensagemEncerrado(e: { situacao: string; pendenteChegou: boolean }) {
  const qual = e.situacao === "PUBLICADA" ? "publicado" : "descartado";
  return `Este rascunho foi ${qual} em outra aba. As alterações desta aba não foram salvas.${e.pendenteChegou ? ` O último salvamento desta aba chegou antes de ele ser ${qual}.` : ""}`;
}

export function criarControleSalvamento(deps: DependenciasSalvamento, inicial: { versao: number }) {
  let e: EstadoSalvamento = novoEstado(inicial.versao);
  let seqSalvar = 0;
  let seqConferir = 0;
  let descartado = false;
  const ouvintes = new Set<() => void>();

  function novoEstado(versao: number): EstadoSalvamento {
    return { versao, revisaoLocal: 0, revisaoSalva: 0, enviando: false, conferindo: false, pendentes: [], naoConfirmado: false, falhaConferir: false, conflito: false, encerrado: null, salvoEm: null, motivo: null };
  }
  function mudar(parcial: Partial<EstadoSalvamento>) { e = { ...e, ...parcial }; for (const o of ouvintes) o(); }

  function comPrazo<T>(trabalho: () => Promise<T>): Promise<ComPrazo<T>> {
    return new Promise((resolver) => {
      let feito = false;
      const fim = (r: ComPrazo<T>) => { if (!feito) { feito = true; deps.limparPrazo(id); resolver(r); } };
      const id = deps.definirPrazo(() => fim({ tipo: "prazo" }), PRAZO_MS);
      let p: Promise<T>;
      try { p = trabalho(); } catch (erro) { fim({ tipo: "falha", erro: (erro as Error).message }); return; }
      p.then((valor) => fim({ tipo: "ok", valor }), (erro: unknown) => fim({ tipo: "falha", erro: (erro as Error)?.message ?? "Falha de rede." }));
    });
  }

  function adotar(d: RascunhoServidor, revisaoDoEnvio: number) {
    const salvo = e.revisaoLocal === revisaoDoEnvio;
    mudar({ versao: d.versao, revisaoSalva: salvo ? revisaoDoEnvio : e.revisaoSalva, salvoEm: salvo ? deps.agora() : e.salvoEm, pendentes: [], naoConfirmado: false, falhaConferir: false, motivo: null });
  }

  async function conferir(): Promise<ResultadoConferir> {
    if (e.encerrado) return "encerrado";
    const meu = ++seqConferir;
    mudar({ conferindo: true, falhaConferir: false });
    const r = await comPrazo(() => deps.get());
    if (meu !== seqConferir || descartado) return "ignorada";
    if (r.tipo !== "ok" || !r.valor.ok) {
      mudar({ conferindo: false, falhaConferir: true, motivo: MENSAGEM_FALHA_CONFERIR });
      return "falha";
    }
    const d = r.valor.data;
    const envio = e.pendentes.find((p) => p.envioId === d.revisao?.envioId);
    if (d.situacao !== "RASCUNHO") {
      mudar({ conferindo: false, encerrado: { situacao: d.situacao, pendenteChegou: Boolean(envio) } });
      return "encerrado";
    }
    if (envio) { mudar({ conferindo: false }); adotar(d, envio.revisaoLocal); return "chegou"; }
    if (d.versao === e.versao) { mudar({ conferindo: false, naoConfirmado: e.pendentes.length > 0, motivo: e.pendentes.length ? MENSAGEM_NAO_CONFIRMADO : null }); return "nao_confirmado"; }
    mudar({ conferindo: false, conflito: true, motivo: MENSAGEM_CONFLITO });
    return "conflito";
  }

  async function salvar(obter: () => RevisaoEnviada): Promise<ResultadoSalvar> {
    if (descartado) return { ok: false, motivo: "Rascunho fechado.", ignorada: true };
    if (e.enviando || e.conferindo) return { ok: false, motivo: "Aguarde o salvamento em andamento." };
    if (e.encerrado) return { ok: false, motivo: mensagemEncerrado(e.encerrado) };
    if (e.conflito) return { ok: false, motivo: MENSAGEM_CONFLITO };
    if (e.pendentes.length && !e.naoConfirmado) {
      // Envio incerto ainda não conferido: confere antes de repetir.
      const c = await conferir();
      if (c === "ignorada") return { ok: false, motivo: "Resposta antiga ignorada.", ignorada: true };
      if (c !== "chegou" && c !== "nao_confirmado") return { ok: false, motivo: e.encerrado ? mensagemEncerrado(e.encerrado) : e.motivo ?? MENSAGEM_FALHA_CONFERIR };
    }
    let reenviou = false;
    for (;;) {
      const envioId = deps.novoEnvioId();
      const revisaoDoEnvio = e.revisaoLocal;
      const corpo = { versao: e.versao, revisao: { ...obter(), envioId } };
      const meu = ++seqSalvar;
      mudar({ enviando: true, motivo: null });
      const r = await comPrazo(() => deps.patch(corpo));
      if (meu !== seqSalvar || descartado) return { ok: false, motivo: "Resposta antiga ignorada.", ignorada: true };
      if (r.tipo !== "ok") {
        mudar({ enviando: false, pendentes: [...e.pendentes, { envioId, revisaoLocal: revisaoDoEnvio }], naoConfirmado: false, motivo: MENSAGEM_INCERTO });
        return { ok: false, motivo: MENSAGEM_INCERTO, incerto: true };
      }
      mudar({ enviando: false });
      if (r.valor.ok) { adotar(r.valor.data, revisaoDoEnvio); return { ok: true, rascunho: r.valor.data }; }
      if (r.valor.status === 409 && e.pendentes.length && !reenviou) {
        // Pode ser o envio incerto chegando agora: confere antes de mostrar conflito; reenvio único.
        const c = await conferir();
        if (c === "ignorada") return { ok: false, motivo: "Resposta antiga ignorada.", ignorada: true };
        if (c === "chegou") { reenviou = true; continue; }
        return { ok: false, motivo: e.encerrado ? mensagemEncerrado(e.encerrado) : e.motivo ?? MENSAGEM_CONFLITO };
      }
      if (r.valor.status === 409) { mudar({ conflito: true, motivo: MENSAGEM_CONFLITO }); return { ok: false, motivo: MENSAGEM_CONFLITO }; }
      mudar({ motivo: r.valor.erro });
      return { ok: false, motivo: r.valor.erro };
    }
  }

  return {
    estado: () => e,
    assinar(fn: () => void) { ouvintes.add(fn); return () => { ouvintes.delete(fn); }; },
    /** Toda alteração do texto na tela. */
    editar() { mudar({ revisaoLocal: e.revisaoLocal + 1 }); },
    alterado: () => e.revisaoLocal !== e.revisaoSalva,
    /** Envio em andamento ou sem confirmação (a pergunta de saída avisa). */
    envioNaoConfirmado: () => e.enviando || e.pendentes.length > 0,
    salvar,
    conferir,
    /** Publicar: salva antes se preciso (mesmas regras) e só devolve a versão confirmada. */
    async prepararPublicacao(obter: () => RevisaoEnviada): Promise<{ ok: true; versao: number } | { ok: false; motivo: string; ignorada?: true }> {
      if (descartado) return { ok: false, motivo: "Rascunho fechado.", ignorada: true };
      if (e.enviando || e.conferindo) return { ok: false, motivo: "Aguarde o salvamento em andamento." };
      if (e.encerrado) return { ok: false, motivo: mensagemEncerrado(e.encerrado) };
      if (e.conflito) return { ok: false, motivo: MENSAGEM_CONFLITO };
      if (e.revisaoLocal !== e.revisaoSalva || e.pendentes.length) {
        const r = await salvar(obter);
        if (!r.ok) return r.ignorada ? r : { ok: false, motivo: `Não publicado: ${r.motivo}` };
        if (e.revisaoLocal !== e.revisaoSalva) return { ok: false, motivo: "Não publicado: o texto mudou durante o salvamento. Salve e publique de novo." };
      }
      return { ok: true, versao: e.versao };
    },
    /**
     * Fechar este rascunho (abrir outro, voltar à lista, recarregar): respostas em voo deixam de valer e de avisar a tela.
     * Não cancela nada no servidor: um envio já feito pode ainda ser gravado.
     */
    descartar() { descartado = true; seqSalvar++; seqConferir++; ouvintes.clear(); },
    /** Abrir outro rascunho ou recarregar: zera pendências e ignora respostas em voo. */
    reiniciar(versao: number) { seqSalvar++; seqConferir++; e = novoEstado(versao); for (const o of ouvintes) o(); },
  };
}

export type ControleSalvamento = ReturnType<typeof criarControleSalvamento>;
