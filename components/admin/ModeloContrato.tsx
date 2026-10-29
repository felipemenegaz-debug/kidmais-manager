'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { adminFetch } from '@/lib/http/admin-fetch';
import { diagnosticoModelo, opcionaisNaoUsados, problemasDoConteudo, type ConteudoModelo } from '@/lib/contratos/modelo-empresa/conteudo';
import { conferidaDe, type ContratadaEfetiva } from '@/lib/contratos/modelo-empresa/contratada';
import {
  adicionarClausula, alterarTexto, comIds, destinoDoInserir, inserirCampo, moverClausula, removerClausula, semIds, trocarPorCampo,
  type ConteudoTela, type Cursor, type Destino, type Resultado,
} from '@/lib/contratos/modelo-empresa/edicao';
import { detectarValoresFixos, versaoTexto, type ValorFixo } from '@/lib/contratos/modelo-empresa/valores-fixos';
import { criarControleSalvamento, mensagemEncerrado, MENSAGEM_CONFLITO, type ControleSalvamento, type EstadoSalvamento as EstadoDoSalvamento, type RespostaServidor } from './modelo-contrato/controleSalvamento';
import { PERGUNTA_SAIDA, PERGUNTA_SAIDA_ENVIO, deveConfirmarSaida, registrarPerguntaDasAbas } from './modelo-contrato/protegerSaida';
import { BlocoIdentificacao, ClausulaLeitura, ContadorPublicar, EstadoSalvamento, ListaValoresFixos, PainelObrigatorios } from './modelo-contrato/partes';
import styles from './workspace.module.css';
import imp from './importacao-tabela.module.css';
import mc from './modelo-contrato.module.css';
import { AdminPrimaryButton } from './AdminPrimaryButton';
import { mensagemAviso } from './importacao-tabela';

type Campo = { chave: string; rotulo: string; grupo: string; exemplo: string };
type Origem = { origem: string; perfilVersao: number | null };
type Painel = {
  migracaoPendente: boolean;
  ativo: { id: string; versao: number; aprovadoEm: string; conteudo: ConteudoModelo & { contratadaOrigem?: Origem } } | null;
  versoes: Array<{ versao: number; situacao: string; aprovadoEm: string }>;
  rascunhos: Array<{ id: string; arquivoNome: string; criadoEm: string }>;
  campos: Campo[];
  identificacao: string[];
  perfilVersaoAtual: number | null;
};
type Rascunho = {
  id: string; situacao: string; arquivoNome: string; versao: number; avisos: string[];
  revisao: { conteudo: ConteudoModelo; avisos: string[]; envioId?: string } | null;
  contratadaEfetiva: ContratadaEfetiva | null;
};
/** Saída pedida enquanto há alteração não salva: um link/aba interno ou "Voltar à lista". */
type Saida = { destino: string } | { lista: true };

const API = '/api/admin/configuracoes/modelo-contrato';
const API_LEITURA = '/api/admin/inteligencia/modelo-contrato';

async function lerJson(resposta: Response) {
  const body = await resposta.json().catch(() => ({}));
  if (!resposta.ok || body.ok === false) throw Error(body.erro || 'Não foi possível concluir.');
  return body.data;
}

/** Resposta do PATCH/GET para o controle de salvamento: recusa HTTP volta como dado; rede e sessão lançam. */
async function resposta(r: Response): Promise<RespostaServidor> {
  const body = await r.json().catch(() => ({}));
  if (r.ok && body.ok !== false) return { ok: true, data: body.data };
  return { ok: false, status: r.status, erro: body.erro || 'Não foi possível salvar.' };
}

const novoId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
const hora = (d: Date | null) => (d ? d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : null);

export function origemPublicada(o: Origem | undefined) {
  if (!o) return 'Origem dos dados da empresa não registrada (publicado antes desta versão).';
  if (o.origem === 'PERFIL') return `Dados da empresa do Perfil, versão ${o.perfilVersao}.`;
  if (o.origem === 'MODELO_INCOMPLETO') return 'Dados da empresa do modelo (o Perfil estava incompleto).';
  return 'Dados da empresa do modelo (a empresa não tinha Perfil).';
}

export default function ModeloContrato() {
  const router = useRouter();
  const [painel, setPainel] = useState<Painel | null>(null);
  const [rascunho, setRascunho] = useState<Rascunho | null>(null);
  const [conteudo, setConteudo] = useState<ConteudoTela | null>(null);
  const [contratada, setContratada] = useState<ContratadaEfetiva | null>(null);
  const [arquivo, setArquivo] = useState<File | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [publicando, setPublicando] = useState(false);
  const [erro, setErro] = useState('');
  const [aviso, setAviso] = useState('');
  const [confirmando, setConfirmando] = useState(false);
  const [revisado, setRevisado] = useState(false);
  const [cursor, setCursor] = useState<Cursor | null>(null);
  const [editando, setEditando] = useState<string | null>(null);
  const [escolhaInserir, setEscolhaInserir] = useState<string | null>(null);
  const [troca, setTroca] = useState<ValorFixo | null>(null);
  const [saida, setSaida] = useState<Saida | null>(null);
  // Controle do salvamento (sem React) e o retrato do estado dele, atualizado pela assinatura.
  const [controle, setControle] = useState<ControleSalvamento | null>(null);
  const [est, setEst] = useState<EstadoDoSalvamento | null>(null);
  // Texto atual para quem salva depois de uma espera (reenvio único): lido só em handlers, nunca no render.
  const conteudoRef = useRef<ConteudoTela | null>(null);
  const rascunhoRef = useRef<Rascunho | null>(null);
  // Cada abertura de rascunho tem um número; resultado de operação de outra abertura não é aplicado (revisão Astra P2-1).
  const aberturaRef = useRef(0);
  // Pedidos de abertura (abrir, ler, reler) numerados NO CLIQUE: só o último pedido abre, qualquer que seja a ordem das respostas
  // (revisão Astra R3); abrir() também o avança, então abrir ou fechar outro rascunho cancela pedido pendente.
  const pedidoAberturaRef = useRef(0);
  const operacoesRef = useRef(0);
  const controleAtualRef = useRef<ControleSalvamento | null>(null);
  useEffect(() => { conteudoRef.current = conteudo; rascunhoRef.current = rascunho; }, [conteudo, rascunho]);

  async function carregarPainel() { setPainel(await lerJson(await adminFetch(API))); }
  useEffect(() => {
    let vivo = true;
    adminFetch(API).then(lerJson).then((d) => { if (vivo) setPainel(d); }).catch((e) => { if (vivo) setErro(e.message); });
    return () => { vivo = false; };
  }, []);

  function controleDe(r: Rascunho, abertura: number) {
    const controle = criarControleSalvamento({
      patch: async (corpo) => resposta(await adminFetch(`${API}/${r.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) })),
      get: async () => resposta(await adminFetch(`${API}/${r.id}`)),
      definirPrazo: (fn, ms) => setTimeout(fn, ms),
      limparPrazo: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
      novoEnvioId: novoId,
      agora: () => new Date(),
    }, { versao: r.versao });
    controle.assinar(() => { if (aberturaRef.current === abertura) setEst(controle.estado()); });
    return controle;
  }

  function abrir(r: Rascunho | null) {
    // Fecha a abertura anterior: respostas em voo dela deixam de valer (o servidor ainda pode gravar um envio já feito).
    controleAtualRef.current?.descartar();
    const abertura = ++aberturaRef.current;
    pedidoAberturaRef.current++;
    setRascunho(r);
    setConteudo(r?.revisao ? comIds(r.revisao.conteudo, novoId) : null);
    setContratada(r?.contratadaEfetiva ?? null);
    const novo = r ? controleDe(r, abertura) : null;
    controleAtualRef.current = novo;
    setControle(novo);
    setEst(novo?.estado() ?? null);
    setCursor(null); setEditando(null); setTroca(null); setEscolhaInserir(null); setSaida(null); setConfirmando(false); setRevisado(false); setErro('');
  }

  /**
   * Toda operação assíncrona da tela captura a abertura ANTES da primeira espera e só aplica resultado (estado, erro,
   * navegação) se ela continuar vigente: resposta tardia de outro rascunho não mexe no aberto agora (revisão Astra R2).
   */
  function capturarAbertura() {
    const abertura = aberturaRef.current;
    return () => abertura === aberturaRef.current;
  }
  async function executar<T>(trabalho: (vigente: () => boolean) => Promise<T>) {
    const vigente = capturarAbertura();
    // Conta as operações em andamento: a que termina primeiro não libera a tela enquanto outra segue pendente (revisão Astra R4, P3).
    operacoesRef.current++;
    setOcupado(true); setErro('');
    try { return await trabalho(vigente); } catch (e) { if (vigente()) setErro((e as Error).message); return undefined; } finally {
      operacoesRef.current--;
      if (operacoesRef.current === 0) setOcupado(false);
    }
  }

  /** Novo pedido de abertura, numerado agora (no clique): vale só enquanto for o último pedido e a abertura não mudou. */
  function pedirAbertura(vigente: () => boolean) {
    const pedido = ++pedidoAberturaRef.current;
    return () => vigente() && pedido === pedidoAberturaRef.current;
  }

  const ler = () => executar(async (vigente) => {
    if (!arquivo) return;
    const vale = pedirAbertura(vigente);
    const form = new FormData();
    form.set('arquivo', arquivo);
    const lido: Rascunho = await lerJson(await adminFetch(API_LEITURA, { method: 'POST', body: form }));
    if (vale()) await abrirLido(lido, vale);
  });
  const reler = () => executar(async (vigente) => {
    if (!rascunho) return;
    const vale = pedirAbertura(vigente);
    const lido: Rascunho = await lerJson(await adminFetch(`${API_LEITURA}?id=${rascunho.id}`, { method: 'POST' }));
    if (vale()) await abrirLido(lido, vale);
  });
  /** A leitura pela IA não traz a contratada efetiva: abre pelo GET do rascunho, que compõe (Gestão) (revisão Astra P2-2). */
  async function abrirLido(lido: Rascunho, vale: () => boolean) {
    const completo: Rascunho = lido.revisao ? await lerJson(await adminFetch(`${API}/${lido.id}`)) : lido;
    if (vale()) abrir(completo);
  }
  const abrirRascunho = (id: string) => executar(async (vigente) => {
    const vale = pedirAbertura(vigente);
    const r: Rascunho = await lerJson(await adminFetch(`${API}/${id}`));
    if (vale()) abrir(r);
  });

  const alterado = Boolean(est && est.revisaoLocal !== est.revisaoSalva);
  const envioNaoConfirmado = Boolean(est && (est.enviando || est.pendentes.length > 0));
  const encerrado = est?.encerrado ?? null;
  const conflito = Boolean(est?.conflito);
  // Durante a publicação, num conflito ou com o rascunho encerrado, nada do texto pode mudar (só leitura).
  const bloqueado = publicando || conflito || Boolean(encerrado);
  const obter = () => ({ conteudo: semIds(conteudoRef.current!), avisos: rascunhoRef.current?.revisao?.avisos ?? [] });

  async function salvar() {
    if (!controle || !conteudoRef.current) return;
    const abertura = aberturaRef.current;
    setErro(''); setAviso('');
    const r = await controle.salvar(obter);
    if (abertura !== aberturaRef.current || (!r.ok && r.ignorada)) return;
    if (r.ok) {
      const d = r.rascunho as unknown as Rascunho;
      setRascunho(d);
      if (d.contratadaEfetiva) setContratada(d.contratadaEfetiva);
    } else if (!r.incerto) setErro(r.motivo);
  }
  async function conferir() {
    if (!controle) return;
    await controle.conferir();
  }

  function mudar(r: Resultado) {
    if (!r.ok) { setAviso(r.motivo); return false; }
    setConteudo(r.conteudo);
    controle?.editar();
    if (r.cursor) setCursor(r.cursor);
    return true;
  }
  function mudarConteudo(m: (c: ConteudoTela) => ConteudoTela) {
    if (!conteudo || bloqueado) return;
    setConteudo(m(conteudo));
    controle?.editar();
  }

  /** "Inserir": no cursor válido (edição) ou, sem cursor, pergunta a cláusula e insere no fim dela. */
  function inserir(chave: string) {
    if (!conteudo || bloqueado) return;
    // Só a seleção da cláusula em edição vale; fora disso, pergunta a cláusula (revisão Astra P2-3).
    const destino = destinoDoInserir(conteudo, cursor, editando);
    if (destino) { mudar(inserirCampo(conteudo, destino, chave)); return; }
    setCursor(null);
    setEscolhaInserir(chave);
  }
  function inserirNoFim(idClausula: string) {
    if (!conteudo || !escolhaInserir) return;
    const destino: Destino = { tipo: 'fim', idClausula };
    const numero = conteudo.clausulas.findIndex((c) => c.id === idClausula) + 1;
    if (mudar(inserirCampo(conteudo, destino, escolhaInserir))) setAviso(`Campo inserido no fim da Cláusula ${numero}. Ajuste a posição se precisar.`);
    setEscolhaInserir(null);
  }
  function confirmarTroca() {
    if (!conteudo || !troca) return;
    mudar(trocarPorCampo(conteudo, troca));
    setTroca(null);
  }
  const lembrar = (idClausula: string) => (e: { currentTarget: HTMLTextAreaElement }) => {
    const t = e.currentTarget;
    setCursor({ idClausula, inicio: t.selectionStart ?? t.value.length, fim: t.selectionEnd ?? t.value.length, versaoTexto: versaoTexto(t.value) });
  };

  const previa = () => executar(async (vigente) => {
    if (!rascunho || !conteudo) return;
    const id = rascunho.id;
    const r = await adminFetch(`${API}/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ acao: 'previa', conteudo: semIds(conteudo) }) });
    if (!r.ok) { const b = await r.json().catch(() => ({})); throw Error(b.erro || 'Não foi possível gerar a prévia.'); }
    const pdf = await r.blob();
    if (!vigente()) return; // prévia de um rascunho que já não está aberto: não abre nem atualiza nada
    const sha = r.headers.get('X-Contratada-Sha256');
    if (sha && sha !== contratada?.sha256) {
      await atualizarContratada(id, vigente);
      if (!vigente()) return;
      setAviso('Os dados da empresa mudaram desde que a tela abriu. A identificação foi atualizada; confira antes de publicar.');
    }
    window.open(URL.createObjectURL(pdf), '_blank', 'noopener');
  });
  /** Relê a contratada do rascunho `id`, capturado por quem chamou, e aplica só se a mesma abertura continuar vigente. */
  async function atualizarContratada(id: string, vigente: () => boolean) {
    const d: Rascunho = await lerJson(await adminFetch(`${API}/${id}`));
    if (vigente() && d.id === id) setContratada(d.contratadaEfetiva);
  }

  async function publicar() {
    if (!rascunho || !controle) return;
    const vista = contratada ? conferidaDe(contratada) : null;
    if (!vista) { setErro('Os dados da empresa não puderam ser conferidos. Atualize e tente de novo.'); return; }
    const id = rascunho.id;
    const vigente = capturarAbertura();
    setPublicando(true); setErro('');
    try {
      const pronto = await controle.prepararPublicacao(obter);
      if (!vigente() || (!pronto.ok && pronto.ignorada)) return;
      if (!pronto.ok) { setErro(pronto.motivo); return; }
      const data = await lerJson(await adminFetch(`${API}/${id}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ acao: 'publicar', versao: pronto.versao, revisadoPorPessoa: true, contratadaConferida: vista }),
      }));
      if (vigente()) {
        abrir(null);
        setAviso(`Modelo publicado (versão ${data.versao}). Os próximos contratos gerados no admin seguem este padrão.`);
      }
      await carregarPainel();
    } catch (e) {
      if (!vigente()) return;
      setErro((e as Error).message);
      // Dados da empresa mudaram desde a prévia: mostra os novos para a pessoa conferir antes de publicar de novo.
      if (/dados da empresa mudaram/.test((e as Error).message)) { setConfirmando(false); await atualizarContratada(id, vigente).catch(() => undefined); }
    } finally {
      setPublicando(false);
    }
  }
  const descartar = () => executar(async (vigente) => {
    if (!rascunho) return;
    if (!window.confirm('Este rascunho será descartado e não poderá ser publicado. O registro continua guardado no sistema. Descartar?')) return;
    await lerJson(await adminFetch(`${API}/${rascunho.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ acao: 'descartar' }) }));
    // Se a pessoa já abriu outro rascunho, o descarte deste não fecha o que está aberto agora.
    if (vigente()) { abrir(null); setAviso('Rascunho descartado.'); }
    await carregarPainel();
  });
  const recarregar = () => executar(async (vigente) => {
    if (!rascunho) return;
    const vale = pedirAbertura(vigente);
    const r: Rascunho = await lerJson(await adminFetch(`${API}/${rascunho.id}`));
    if (!vale()) return;
    abrir(r);
    setAviso(`Recarregado da versão salva às ${hora(new Date())}.`);
  });
  function voltarLista() {
    if (alterado) { setSaida({ lista: true }); return; }
    abrir(null);
  }
  function sairSemSalvar() {
    const s = saida;
    setSaida(null);
    if (!s) return;
    // Não inicia nem cancela salvamento já pedido; se a navegação não acontecer, o editor segue normal.
    if ('lista' in s) abrir(null);
    else router.push(s.destino);
  }

  // Saídas controladas: links internos (captura antes do Link do Next), abas por callback e fechar/recarregar.
  useEffect(() => {
    if (!alterado) return;
    const aoClicar = (ev: MouseEvent) => {
      const a = (ev.target as Element | null)?.closest?.('a');
      const destino = deveConfirmarSaida({
        defaultPrevented: ev.defaultPrevented, button: ev.button, ctrlKey: ev.ctrlKey, metaKey: ev.metaKey, shiftKey: ev.shiftKey, altKey: ev.altKey,
        ancora: a ? { href: a.getAttribute('href') ?? '', target: a.getAttribute('target') ?? '', download: a.hasAttribute('download'), semProtecao: a.closest('[data-sem-protecao]') != null } : null,
      }, true, window.location);
      if (!destino) return;
      ev.preventDefault();
      ev.stopPropagation();
      setSaida({ destino });
    };
    const aoSair = (ev: BeforeUnloadEvent) => { ev.preventDefault(); ev.returnValue = ''; };
    document.addEventListener('click', aoClicar, true);
    window.addEventListener('beforeunload', aoSair);
    return () => { document.removeEventListener('click', aoClicar, true); window.removeEventListener('beforeunload', aoSair); };
  }, [alterado]);
  useEffect(() => {
    registrarPerguntaDasAbas(alterado ? (destino) => { setSaida({ destino }); return true; } : null);
    return () => registrarPerguntaDasAbas(null);
  }, [alterado]);

  const servidor = useMemo(() => (conteudo ? semIds(conteudo) : null), [conteudo]);
  const problemas = useMemo(() => (servidor ? problemasDoConteudo(servidor) : []), [servidor]);
  const diagnostico = useMemo(() => (conteudo ? diagnosticoModelo(conteudo) : null), [conteudo]);
  const fixos = useMemo(() => (conteudo ? detectarValoresFixos(conteudo.clausulas) : []), [conteudo]);
  const opcionais = useMemo(() => (conteudo ? opcionaisNaoUsados(conteudo) : []), [conteudo]);
  const rotulos = useMemo(() => Object.fromEntries((painel?.campos ?? []).map((c) => [c.chave, c.rotulo])), [painel]);
  const grupos = useMemo(() => {
    const m = new Map<string, Campo[]>();
    for (const c of painel?.campos ?? []) m.set(c.grupo, [...(m.get(c.grupo) ?? []), c]);
    return [...m.entries()];
  }, [painel]);
  const outrosProblemas = problemas.filter((p) => !p.startsWith('Falta nas cláusulas:')).length;
  const podePublicar = Boolean(diagnostico && diagnostico.incluidos === diagnostico.total && !problemas.length && contratada && contratada.estado !== 'ERRO' && !bloqueado && !ocupado);

  const perguntaSaida = saida && <div className={imp.overlay} role="dialog" aria-label="Sair sem salvar">
    <div className={imp.dialogo}>
      <h2>{PERGUNTA_SAIDA}</h2>
      {envioNaoConfirmado && <p>{PERGUNTA_SAIDA_ENVIO}</p>}
      <div className={styles.actions}>
        <AdminPrimaryButton onClick={() => setSaida(null)}>Ficar</AdminPrimaryButton>
        <button type="button" onClick={sairSemSalvar}>{envioNaoConfirmado ? 'Sair sem salvar o resto' : 'Sair sem salvar'}</button>
      </div>
    </div>
  </div>;

  // ── Painel ────────────────────────────────────────────────────────────────
  if (!rascunho) {
    const origem = painel?.ativo?.conteudo.contratadaOrigem;
    const perfilMudou = painel?.perfilVersaoAtual != null && origem && painel.perfilVersaoAtual !== origem.perfilVersao;
    return <main className={styles.page} data-admin-workspace aria-busy={ocupado}>
      <header className={styles.header}><h1>Modelo de contrato</h1></header>
      <div className={styles.content}>
        <p role="alert">{erro}</p>
        {aviso && <p role="status">{aviso}</p>}
        {painel?.migracaoPendente && <section className={imp.alerta}>A atualização do banco para modelos de contrato (071 e 072) ainda não foi aplicada.</section>}
        <section className={imp.card}>
          <h2>Modelo em uso</h2>
          {painel?.ativo
            ? <>
              <p>Versão {painel.ativo.versao}, aprovada em {new Date(painel.ativo.aprovadoEm).toLocaleString('pt-BR')}. Os contratos gerados no admin desta empresa usam este texto, com os dados de cada festa.</p>
              <p className={imp.ajuda}>{origemPublicada(origem)}{!origem && ' Publicado pela regra anterior: para republicar, o texto precisa dos 7 dados da festa e do valor.'}</p>
              {perfilMudou && <p className={imp.alerta}>! O Perfil da empresa mudou depois da publicação. Publique de novo para atualizar os dados da empresa nos próximos contratos.</p>}
            </>
            : <p>Esta empresa ainda não tem modelo próprio. Envie o contrato que a loja já usa para gerar os contratos no padrão dela.</p>}
          {painel && painel.versoes.length > 1 && <p className={imp.ajuda}>Versões anteriores: {painel.versoes.filter((v) => v.situacao !== 'ATIVO').map((v) => v.versao).join(', ')}. Contratos já gerados guardam o próprio PDF e não mudam.</p>}
        </section>
        <div className={imp.colunas}>
          <section className={imp.card}>
            <h2>Importar o contrato da loja</h2>
            <label className={imp.envio}>
              <span>Escolha o contrato em PDF (até 15 MB). Pode ser um contrato já preenchido: os dados do cliente viram campos automáticos.</span>
              <input type="file" accept="application/pdf" onChange={(e) => setArquivo(e.target.files?.[0] ?? null)} />
            </label>
            <AdminPrimaryButton disabled={!arquivo || ocupado} carregando={ocupado} onClick={() => void ler()}>Ler contrato</AdminPrimaryButton>
            {ocupado && <p role="status">Lendo o contrato com IA. Pode levar até 2 minutos; não feche esta tela.</p>}
          </section>
          <section className={imp.card}>
            <h2>Como funciona</h2>
            <ul className={imp.lista}>
              <li>A IA copia as cláusulas e troca os dados de cada festa por campos (data, horário, convidados, valor…).</li>
              <li>Você confere os 7 dados da festa e do valor, revisa o texto, vê a prévia em PDF e aprova.</li>
              <li>Só depois da aprovação o modelo passa a valer para os contratos novos.</li>
            </ul>
            <p className={imp.ajuda}>O PDF vai ao provedor de IA (OpenAI) só para leitura. A revisão jurídica do texto é responsabilidade da empresa.</p>
          </section>
        </div>
        {(painel?.rascunhos.length ?? 0) > 0 && <section className={imp.card}>
          <h2>Rascunhos em revisão</h2>
          {painel!.rascunhos.map((r) => <div key={r.id} className={imp.linhaLista}>
            <span>{r.arquivoNome} · {new Date(r.criadoEm).toLocaleString('pt-BR')}</span>
            <button type="button" onClick={() => void abrirRascunho(r.id)}>Continuar revisão</button>
          </div>)}
        </section>}
      </div>
    </main>;
  }

  // ── Leitura sem resultado ────────────────────────────────────────────────
  if (!conteudo || !diagnostico || !est) {
    return <main className={styles.page} data-admin-workspace aria-busy={ocupado}>
      <header className={styles.header}><h1>Leitura não concluída</h1></header>
      <div className={styles.content}>
        <p role="alert">{erro}</p>
        <section className={imp.alerta}>{(rascunho.avisos.length ? rascunho.avisos : ['MODELO_INESPERADO']).map((a) => <p key={a}>{mensagemAviso(a)}</p>)}</section>
        <div className={styles.actions}>
          <AdminPrimaryButton carregando={ocupado} onClick={() => void reler()}>Ler de novo</AdminPrimaryButton>
          <button type="button" onClick={() => void descartar()}>Descartar</button>
          <button type="button" onClick={() => abrir(null)}>Voltar</button>
        </div>
      </div>
    </main>;
  }

  // ── Revisão ───────────────────────────────────────────────────────────────
  return <main className={styles.page} data-admin-workspace aria-busy={ocupado || publicando}>
    <header className={styles.header}><h1>Revise o modelo de contrato</h1><span className={styles.badge}>{rascunho.arquivoNome}</span></header>
    <div className={styles.content}>
      <div className={mc.topo}>
        <ContadorPublicar incluidos={diagnostico.incluidos} total={diagnostico.total} outrosProblemas={outrosProblemas} contratadaErro={contratada?.estado === 'ERRO'} semPerfil={!contratada} />
        <div className={styles.actions}>
          <button type="button" disabled={ocupado || publicando} onClick={() => void previa()}>Prévia em PDF</button>
          <AdminPrimaryButton disabled={!podePublicar} onClick={() => setConfirmando(true)}>Publicar modelo</AdminPrimaryButton>
        </div>
      </div>
      <p role="alert">{erro}</p>
      {aviso && <p role="status">{aviso}</p>}
      {encerrado && <section className={imp.alerta} role="alert">
        <strong>✕ {mensagemEncerrado(encerrado)}</strong> O texto abaixo fica só para consulta.
        <div className={styles.actions}><button type="button" onClick={() => abrir(null)}>Voltar à lista</button></div>
      </section>}
      {conflito && !encerrado && <section className={imp.alerta} role="alert">
        <strong>✕ {MENSAGEM_CONFLITO}</strong> Nada foi sobrescrito.
        <div className={styles.actions}>
          <button type="button" onClick={() => void recarregar()}>Recarregar a versão salva</button>
          <button type="button" onClick={() => setAviso('Suas alterações estão abaixo, só para leitura. Copie o que precisar antes de recarregar.')}>Ver minhas alterações (só leitura)</button>
        </div>
      </section>}
      <div className={mc.grade}>
        <div className={mc.editor}>
          <BlocoIdentificacao contratada={contratada} modelo={conteudo.contratada} rotulos={rotulos} identificacao={painel?.identificacao ?? []} bloqueado={bloqueado}
            onCampo={(campo, valor) => mudarConteudo((c) => ({ ...c, contratada: { ...c.contratada, [campo]: valor } }))}
            onAtualizar={() => { const id = rascunho.id; void executar((vigente) => atualizarContratada(id, vigente)); }} />
          <PainelObrigatorios itens={diagnostico.itens} sugestoes={fixos} bloqueado={bloqueado} onTrocar={setTroca} onInserir={inserir} />
          <section className={mc.secao} aria-labelledby="clausulas-titulo">
            <h2 id="clausulas-titulo">3. Cláusulas · {conteudo.clausulas.length}</h2>
            {conteudo.clausulas.map((cl, i) => <div key={cl.id} className={mc.clausula}>
              <div className={mc.clausulaTopo}>
                <strong>Cláusula {i + 1}{cl.titulo ? ` · ${cl.titulo}` : ''}</strong>
                <div className={mc.botoes}>
                  <button type="button" disabled={bloqueado} onClick={() => { setCursor(null); setEditando(editando === cl.id ? null : cl.id); }}>{editando === cl.id ? 'Concluir' : 'Editar'}</button>
                  <button type="button" aria-label={`Subir cláusula ${i + 1}`} disabled={bloqueado || i === 0} onClick={() => { setCursor(null); mudar(moverClausula(conteudo, cl.id, -1)); }}>↑</button>
                  <button type="button" aria-label={`Descer cláusula ${i + 1}`} disabled={bloqueado || i === conteudo.clausulas.length - 1} onClick={() => { setCursor(null); mudar(moverClausula(conteudo, cl.id, 1)); }}>↓</button>
                  <button type="button" aria-label={`Remover cláusula ${i + 1}`} disabled={bloqueado} onClick={() => { setCursor(null); mudar(removerClausula(conteudo, cl.id)); }}>×</button>
                </div>
              </div>
              {editando === cl.id && !bloqueado
                ? <>
                  <label>Título (opcional)<input value={cl.titulo ?? ''} onChange={(e) => mudar(alterarTexto(conteudo, cl.id, 'titulo', e.target.value))} /></label>
                  <textarea aria-label={`Texto da cláusula ${i + 1}`} rows={Math.min(12, Math.max(3, Math.ceil(cl.texto.length / 90)))} value={cl.texto}
                    onFocus={lembrar(cl.id)} onSelect={lembrar(cl.id)} onChange={(e) => mudar(alterarTexto(conteudo, cl.id, 'texto', e.target.value))} />
                </>
                : <ClausulaLeitura clausula={cl} valoresFixos={fixos} rotulos={rotulos} />}
            </div>)}
            <button type="button" disabled={bloqueado} onClick={() => mudar(adicionarClausula(conteudo, novoId))}>+ Adicionar cláusula</button>
          </section>
          <section className={imp.card}>
            <h2>Outros textos</h2>
            <label>Título<input value={conteudo.titulo} disabled={bloqueado} onChange={(e) => mudarConteudo((c) => ({ ...c, titulo: e.target.value }))} /></label>
            {conteudo.preambulo.map((t, i) => <label key={`p${i}`}>Preâmbulo<textarea rows={3} value={t} disabled={bloqueado} onChange={(e) => mudarConteudo((c) => ({ ...c, preambulo: c.preambulo.map((x, k) => (k === i ? e.target.value : x)) }))} /></label>)}
            {conteudo.observacoes.map((t, i) => <label key={`o${i}`}>Observação {i + 1}<textarea rows={2} value={t} disabled={bloqueado} onChange={(e) => mudarConteudo((c) => ({ ...c, observacoes: c.observacoes.map((x, k) => (k === i ? e.target.value : x)) }))} /></label>)}
            <label>Cidade da assinatura<input value={conteudo.cidadeAssinatura} disabled={bloqueado} onChange={(e) => mudarConteudo((c) => ({ ...c, cidadeAssinatura: e.target.value }))} /></label>
          </section>
        </div>
        <aside className={mc.lateral}>
          <section className={imp.card}>
            <h2>Campos automáticos</h2>
            <p className={imp.ajuda}>No modo edição, clique no texto e depois no campo. Fora dele, você escolhe a cláusula e o campo entra no fim dela.</p>
            {grupos.map(([grupo, campos]) => <div key={grupo}>
              <h3>{grupo}</h3>
              <div className={mc.chips}>{campos.map((c) => <button key={c.chave} type="button" disabled={bloqueado} title={`Ex.: ${c.exemplo}`} onClick={() => inserir(c.chave)}>{c.rotulo}</button>)}</div>
            </div>)}
          </section>
          {problemas.length > 0 && <section className={imp.alerta} aria-live="polite"><strong>! Antes de publicar:</strong><ul>{problemas.map((p) => <li key={p}>{p}</li>)}</ul></section>}
          <ListaValoresFixos valoresFixos={fixos} />
          {opcionais.length > 0 && <p className={imp.ajuda}>Opcionais não usados nas cláusulas: {opcionais.map((o) => o.rotulo).join(', ')}.</p>}
          {(rascunho.revisao?.avisos.length ?? 0) > 0 && <section className={imp.card}>
            <h2>Avisos da leitura</h2>
            <ul className={imp.lista}>{rascunho.revisao!.avisos.map((a) => <li key={a}>{a}</li>)}</ul>
          </section>}
        </aside>
      </div>
      <div className={imp.rodape}>
        <EstadoSalvamento alterado={alterado} enviando={est.enviando || est.conferindo} incerto={est.pendentes.length > 0 && !est.naoConfirmado}
          naoConfirmado={est.naoConfirmado} falhaConferir={est.falhaConferir} salvoEm={hora(est.salvoEm)} onConferir={() => void conferir()} />
        <div className={styles.actions}>
          <button type="button" data-sem-protecao onClick={voltarLista}>Voltar à lista</button>
          <button type="button" disabled={bloqueado || ocupado} onClick={() => void descartar()}>Descartar rascunho</button>
          <button type="button" disabled={!alterado || est.enviando || est.conferindo || bloqueado} aria-busy={est.enviando || undefined} onClick={() => void salvar()}>Salvar rascunho</button>
        </div>
      </div>
    </div>
    {troca && <div className={imp.overlay} role="dialog" aria-label="Trocar valor fixo por campo">
      <div className={imp.dialogo}>
        <h2>Trocar {troca.trecho} por {troca.rotulo} na Cláusula {troca.numero}?</h2>
        <p>«…{troca.antes}<mark>{troca.trecho}</mark>{troca.depois}…»</p>
        <div className={styles.actions}>
          <button type="button" onClick={() => setTroca(null)}>Cancelar</button>
          <AdminPrimaryButton onClick={confirmarTroca}>Trocar</AdminPrimaryButton>
        </div>
      </div>
    </div>}
    {escolhaInserir && <div className={imp.overlay} role="dialog" aria-label="Escolher a cláusula">
      <div className={imp.dialogo}>
        <h2>Em qual cláusula inserir {rotulos[escolhaInserir] ?? escolhaInserir}?</h2>
        <p className={imp.ajuda}>O campo entra no fim da cláusula escolhida. Para outra posição, use Editar e clique no texto.</p>
        {conteudo.clausulas.map((cl, i) => <button key={cl.id} type="button" onClick={() => inserirNoFim(cl.id)}>Cláusula {i + 1}{cl.titulo ? ` · ${cl.titulo}` : ''}</button>)}
        <button type="button" onClick={() => setEscolhaInserir(null)}>Cancelar</button>
      </div>
    </div>}
    {confirmando && <div className={imp.overlay} role="dialog" aria-label="Publicar modelo de contrato">
      <div className={imp.dialogo}>
        <h2>Publicar o modelo de contrato?</h2>
        <p>Os próximos contratos gerados no admin desta empresa usarão este texto. Contratos já gerados não mudam.</p>
        <label className={imp.marcar}><input type="checkbox" checked={revisado} disabled={publicando} onChange={(e) => setRevisado(e.target.checked)} />Revisei o texto deste contrato e aprovo seu uso com os clientes desta empresa.</label>
        <div className={styles.actions}>
          <button type="button" disabled={publicando} onClick={() => setConfirmando(false)}>Voltar</button>
          <AdminPrimaryButton disabled={!revisado} carregando={publicando} onClick={() => void publicar()}>Publicar modelo</AdminPrimaryButton>
        </div>
      </div>
    </div>}
    {perguntaSaida}
  </main>;
}
