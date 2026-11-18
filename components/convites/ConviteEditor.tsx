'use client';
// As imagens privadas já são normalizadas pelo servidor; não usar cache público do otimizador Next.
/* eslint-disable @next/next/no-img-element */
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { adminFetch } from '@/lib/http/admin-fetch';
import { localDoConvite, temas, type Conteudo } from '@/lib/convites/domain';
import { baseNeutra, modeloBiblioteca, modeloComFoto, modelosBiblioteca } from '@/lib/convites/modelos';
import ConviteArte, { baixarConvite, dataBonita } from './ConviteArte';
import PromptComCorretor from './PromptComCorretor';
import ConviteVisual from './ConviteVisual';
import ConvitePresencas from './ConvitePresencas';
import { avisoSemGeracao, comUnidade, creditosDisponiveisDaEmpresa, geracaoDoConviteEmCurso, textoReserva } from './creditos-texto';
import ConviteFamilias, { type ResultadoFamilia } from './ConviteFamilias';
import ConviteAutorizacaoIA, { ConfirmacaoImagensIA, type AutorizacaoIATela } from './ConviteAutorizacaoIA';
import type { ComandoFamilia, Familia } from '@/lib/convites/familias-domain';
import { extrairPaleta, visualPadrao } from '@/lib/convites/visual';
import styles from './convites.module.css';
import adminStyles from './editor-admin.module.css';
import { modelosAcervo, sugestaoAcervo } from '@/lib/convites/acervo';
import { aplicarModoArteLocal, selecionarArte, semArte } from './arte-local';
import SeletorComposicao from './SeletorComposicao';
import { opcoesComposicao } from './composicao';
import { conferirPrompt, alinharPrompt, conflitoDeEstilo, estilosDoEditor, type EstiloEditor } from '@/lib/convites/conferencia-prompt';
import { acharPersonagemProtegido, type MencaoProtegida } from '@/lib/convites/personagens-protegidos';
import { exemplosPedido } from './exemplos-pedido';
import VincularFesta from './VincularFesta';
import { useLogoNoConvite, type LogoNoConvite } from './LogoNoConvite';
import { confirmadosDasFilas } from '@/lib/convites/fila-logo';
import { AVISO_FALHA_LEITURA_LOGO, controleDeCarga, FALHA_CARGA_CONVITE, LeituraCancelada, lerComRecuperacao, TEXTO_ESPERANDO_LOGO, TEXTO_LOGO_NAO_SALVA } from './logo-editor';
type Arte = { id: string; url: string; origem: string; completo?: boolean };
// Situação simples de um pedido de geração; pendências técnicas ficam com o operador da plataforma.
type SituacaoGeracao = { chave: string; estado: 'EM_ANDAMENTO' | 'CONCLUIDA' | 'VERIFICANDO' | 'NAO_INICIADA' | 'ENCERRADA' | 'DEVOLVIDA'; arteId?: string | null; completo?: boolean; acompanhando?: boolean };
type Confirmacao = { titulo: string; texto?: string; acao: string; confirmar: () => void | Promise<void> };
const CHAVE_TUTORIAL = 'convites:tutorial-fechado';
const MENSAGEM_VERIFICANDO = 'Estamos verificando sua geração. Você não precisa tentar novamente.';
const ROTULOS_HISTORICO: Record<string, string> = { IA_RESERVADA: 'geração de arte solicitada', IA_CONCLUIDA: 'arte gerada', IA_EM_VERIFICACAO: 'geração em verificação',
  IA_NAO_INICIADA: 'geração não iniciada; crédito devolvido', IA_VERIFICACAO_CONCLUIDA: 'verificação da geração concluída',
  AUTORIZACAO_IA_REGISTRADA: 'autorização de IA do responsável registrada', AUTORIZACAO_IA_REVOGADA: 'autorização de IA revogada', LOGO_BUFFET: 'logo do buffet no convite alterada' };
const rotuloHistorico = (h: { acao: string; ator: string }) => `${h.ator === 'CLIENTE' ? 'Cliente' : h.ator === 'PLATAFORMA' ? 'iA.Fest' : 'Buffet'} · ${ROTULOS_HISTORICO[h.acao] ?? h.acao.toLowerCase().replaceAll('_', ' ')}`;
const MENSAGEM_GERANDO = 'Gerando sua arte. Você pode aguardar nesta tela; não é preciso clicar de novo.';
// Resumo curto da assinatura do pedido (pode conter a foto) para lembrar a chave nesta aba sem guardar o conteúdo.
function resumoPedido(texto: string) { let h = 0x811c9dc5; for (let i = 0; i < texto.length; i++) { h ^= texto.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(16) + ':' + texto.length; }
type Dados = { festaId?: string | null; laboratorioLocal?: boolean; conteudo: Conteudo; avisoLocal?: string | null; revisao: number; publicado: boolean; desatualizado: boolean; linkPublico: string; clienteHabilitado: boolean; editor_expira_em?: string | null; convidadosContratados?: number | null; familias?: Familia[];
  disponiveis: number; iaDisponivel: boolean; completoDisponivel?: boolean; autorizacaoIA?: AutorizacaoIATela | null; geracaoIncerta?: boolean; geracaoEmAndamento?: string | null; id?: string; cotas: { festa: number; festaUsado: number; cliente: number; clienteUsado: number; empresa?: number; empresaUsado?: number };
  creditos?: { motor: 'LEGADO' } | { motor: 'CREDITOS'; disponivel: number; reservado: number; consumoAtivo: boolean } | null;
  geradoresLocais?: { id: string; nome: string; disponivel: boolean; pago: boolean }[];
  trabalhosLocais?: { id: string; estado: string; tipo: string; criadoEm: string; erro?: string }[];
  logoBuffet?: { mostrar: boolean; logoDataUrl: string | null } | null;
  /** Etapa 3 (só o buffet): id da arte publicada, para o aviso ao desligar a logo. */
  publicadoArteId?: string | null;
  artes: Arte[]; respostas: { nome: string; presenca: boolean; adultos: number; criancas: number }[]; historico: { acao: string; ator: string; criado_em: string }[] };
// Biblioteca de molduras temporariamente desativada no editor; modelos e convites existentes continuam renderizando.
const MOLDURAS_NO_EDITOR = false;
// Campos da logo vêm do servidor e são gravados só pela fila da logo; não contam como alteração do rascunho.
const semCamposLogo = (c: Conteudo) => { const { logoBuffet: _b, logoPosicoes: _p, logoSemNome: _s, ...resto } = c as Conteudo & { logoPosicoes?: unknown; logoSemNome?: unknown }; void _b; void _p; void _s; return resto; };
const campos = [['nome', 'Nome do aniversariante'], ['idade', 'Idade ou celebração'], ['data', 'Data'], ['horario', 'Horário'], ['local', 'Local da festa'], ['endereco', 'Endereço']] as const;
export default function ConviteEditor({ festaId, conviteId }: { festaId?: string; conviteId?: string }) {
  const admin = !!(festaId || conviteId);
  const ui = admin ? { ...styles, ...adminStyles } : styles;
  const [dados, setDados] = useState<Dados | null>(null), [conteudoBase, setConteudo] = useState<Conteudo | null>(null);
  // Convites completos (textos na imagem) abrem em modo "completa"; modos já salvos nunca são rebaixados ao carregar.
  const conteudo = conteudoBase ? aplicarModoArteLocal(conteudoBase, dados?.artes.find(a => a.id === conteudoBase.arteId), !!dados?.laboratorioLocal) : null;
  const [carregando, setCarregando] = useState(true), [busy, setBusy] = useState(false), [erro, setErro] = useState(''), [aviso, setAviso] = useState('');
  // r4 (Astra r3, P2): a primeira carga falhou (tempo, servidor ou resposta sem a logo): aviso com "Tentar de novo".
  const [falhaCarga, setFalhaCarga] = useState('');
  const [prompt, setPrompt] = useState(''), [referencias, setReferencias] = useState<string[]>([]), [linkCliente, setLinkCliente] = useState('');
  const [preparado, setPreparado] = useState<{ pedido: string; tema: string; promptArte: string } | null>(null);
  const [etapaLocal, setEtapaLocal] = useState(''), [jobLocal, setJobLocal] = useState('');
  const [, setRelatorioLocal] = useState('');
  const [geradorLocal, setGeradorLocal] = useState('openai');
  const [conviteCompleto, setConviteCompleto] = useState(true);
  const [qualidade, setQualidade] = useState('xhigh');
  const [estilo, setEstilo] = useState<EstiloEditor>('cartoon3d');
  const [avatarPronto, setAvatarPronto] = useState(false);
  const [foto, setFoto] = useState(''), [autorizacaoFoto, setAutorizacaoFoto] = useState(false);
  const [conflitoPrompt, setConflitoPrompt] = useState(false);
  const [avisoProtegido, setAvisoProtegido] = useState<{ mencao: MencaoProtegida; avatarOnly: boolean } | null>(null);
  const pedidoLiberado = useRef<string | null>(null);
  const [estiloNoPedido, setEstiloNoPedido] = useState('');
  const [manterEstilo, setManterEstilo] = useState(false);
  const [modoArte, setModoArte] = useState<'ia' | 'propria' | null>(null);
  const [tutorialAberto, setTutorialAberto] = useState<boolean | null>(null);
  const [confirmacao, setConfirmacao] = useState<Confirmacao | null>(null);
  const fotoArquivo = useRef<HTMLInputElement>(null), fotoCamera = useRef<HTMLInputElement>(null);
  async function lerFoto(arquivo?: File) {
    if (!arquivo) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(arquivo.type) || arquivo.size > 5_000_000) { setErro('Use uma foto PNG, JPEG ou WebP de até 5 MB.'); return; }
    const reader = new FileReader();
    reader.onload = () => { setFoto(String(reader.result)); setAutorizacaoFoto(false); setErro(''); };
    reader.onerror = () => setErro('Não foi possível ler a foto.');
    reader.readAsDataURL(arquivo);
  }
  const [cotaFesta, setCotaFesta] = useState(3), [cotaCliente, setCotaCliente] = useState(3);
  const [categoriaModelo, setCategoriaModelo] = useState<'todos' | 'neutros' | 'temas' | 'fotos' | 'abertos'>('todos');
  const [acervoAutomatico] = useState(true);
  const [paginaModelo, setPaginaModelo] = useState(1);
  const [paginaArte, setPaginaArte] = useState(1);
  const [colunasGaleria, setColunasGaleria] = useState(3);
  useEffect(() => {
    const tela = window.matchMedia('(max-width: 600px)');
    const ajustar = () => setColunasGaleria(tela.matches ? 2 : 3);
    ajustar(); tela.addEventListener('change', ajustar);
    return () => tela.removeEventListener('change', ajustar);
  }, []);
  const [acompanhando, setAcompanhando] = useState(''), acompanhamento = useRef('');
  useEffect(() => () => { acompanhamento.current = ''; }, []);
  const [arteExcluir, setArteExcluir] = useState<Arte | null>(null);
  const dialogo = useRef<HTMLDialogElement>(null);
  const painelIA = useRef<HTMLDivElement>(null);
  const escolhaArte = useRef<HTMLDivElement>(null);
  const dialogoConfirmacao = useRef<HTMLDialogElement>(null);

  function semIA() {
    setModoArte('propria');
    escolhaArte.current?.querySelector<HTMLButtonElement>('[data-arte-propria]')?.focus();
  }

  function tutorial(aberto: boolean) {
    setTutorialAberto(aberto);
    try {
      if (aberto) localStorage.removeItem(CHAVE_TUTORIAL);
      else localStorage.setItem(CHAVE_TUTORIAL, '1');
    } catch { /* O estado da tela continua disponível. */ }
  }

  useEffect(() => {
    if (!admin) {
      let aberto = true;
      try { aberto = localStorage.getItem(CHAVE_TUTORIAL) !== '1'; } catch { /* Exibe a ajuda por padrão. */ }
      queueMicrotask(() => setTutorialAberto(aberto));
    }
  }, [admin]);
  useEffect(() => {
    const modal = dialogoConfirmacao.current;
    if (confirmacao && modal && !modal.open) modal.showModal();
    else if (!confirmacao && modal?.open) modal.close();
  }, [confirmacao]);
  useEffect(() => { if (arteExcluir) dialogo.current?.showModal(); else dialogo.current?.close(); }, [arteExcluir]);
  const token = useRef(''), pedido = useRef<{ assinatura: string; chave: string; seed?: number } | null>(null);
  const endpoint = admin ? `/api/admin/convites?${conviteId ? `conviteId=${conviteId}` : `festaId=${festaId}`}` : '/api/convites/cliente';
  const api = useCallback(async (body?: object, consulta?: string, sinal?: AbortSignal) => {
    const init: RequestInit = { ...(sinal ? { signal: sinal } : {}), method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(!admin ? { Authorization: `Bearer ${token.current}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), cache: 'no-store' };
    const url = consulta ? `${endpoint}${admin ? '&' : '?'}${consulta}` : endpoint;
    const r = await (admin ? adminFetch(url, init) : fetch(url, init));
    // r5 (Astra r4, P2): o status vale mesmo com corpo vazio ou HTML; um 404 assim não é repetido.
    const j = await r.json().catch(() => null);
    if (!r.ok || !j) throw Object.assign(new Error(j?.erro || 'Não foi possível concluir.'), r.ok ? {} : { status: r.status });
    return j.data;
  }, [admin, endpoint]);
  // Logo do buffet (etapa 3): ref para a leitura não depender da fila, que só existe depois da primeira carga.
  const logoRef = useRef<LogoNoConvite | null>(null);
  // r5 (Astra r4, P2): cargas em série (nenhuma cancela outra; aplicam na ordem do pedido); sair do editor encerra.
  // Trocar de convite remonta o editor (key nas páginas). Leitura com limite (o fetch é abortado), uma nova tentativa
  // e a logo conferida antes de ativar o painel.
  const carga = useRef(controleDeCarga());
  const carregar = useCallback((criar = false, preservar = false) => carga.current.executar(async sinal => {
    // Foto das confirmações no início do pedido: as que chegarem depois entram por cima da leitura.
    const antes = confirmadosDasFilas();
    let d: Dados;
    try {
      // Criar é escrita: sem limite nem repetição (o servidor pode já ter criado); as leituras têm os dois.
      d = criar ? await api({ acao: 'criar' }) as Dados : await lerComRecuperacao(async s => {
        const lido = await api(undefined, undefined, s) as Dados;
        if (admin && lido?.id && !lido.laboratorioLocal && !lido.logoBuffet) throw new Error(AVISO_FALHA_LEITURA_LOGO);
        return lido;
      }, { externo: sinal, repetir: e => { const st = (e as { status?: number }).status; return !(st && st >= 400 && st < 500); } });
    } catch (e) {
      if (e instanceof LeituraCancelada || sinal.aborted) return;
      throw e;
    }
    if (sinal.aborted) return;
    logoRef.current?.aplicarLeitura(d, antes);
    setDados(d); if (!preservar) setConteudo(d.conteudo); setCotaFesta(d.cotas.festa); setCotaCliente(d.cotas.cliente);
  }), [admin, api, setCotaFesta, setCotaCliente]);
  const primeiraCarga = useCallback(async (ativo: () => boolean) => {
    try { await carregar(); setFalhaCarga(''); }
    catch (e) {
      if (!ativo()) return;
      // 404 = convite ainda não criado: segue o painel de criação; o resto é falha da carga.
      if ((e as { status?: number }).status === 404) setErro((e as Error).message); else setFalhaCarga(FALHA_CARGA_CONVITE);
    } finally { if (ativo()) setCarregando(false); }
  }, [carregar]);
  useEffect(() => {
    let ativo = true;
    const controle = carga.current; controle.abrir();
    token.current = window.location.hash.slice(1);
    // Token só no fragmento e memória desta aba; nunca em query string ou armazenamento persistente.
    void Promise.resolve().then(() => { if (ativo) void primeiraCarga(() => ativo); });
    return () => { ativo = false; controle.encerrar(); };
  }, [primeiraCarga]);
  const alterado = !!dados && !!conteudo && JSON.stringify(semCamposLogo(conteudo)) !== JSON.stringify(semCamposLogo(dados.conteudo));
  const logo = useLogoNoConvite({
    ativo: admin && !!dados?.logoBuffet && !dados.laboratorioLocal && !!dados.id, conviteId: dados?.id,
    logoDataUrl: dados?.logoBuffet?.logoDataUrl ?? null, publicado: !!dados?.publicado, conteudo, arteUrl: dados?.artes.find(a => a.id === conteudo?.arteId)?.url,
    busy, ui,
  });
  useEffect(() => { logoRef.current = logo; });
  // Convite completo (arte + textos numa chamada): no produto, quando o servidor tem o provedor configurado.
  // Desligar a IA bloqueia o envio, mas mantém os controles do convite completo para comparação.
  const completoAtivo = dados?.laboratorioLocal ? conviteCompleto && geradorLocal === 'openai' : !!dados?.completoDisponivel || dados?.iaDisponivel === false;
  // 088: sem autorização vigente do responsável, o botão fica desabilitado (o servidor também recusa).
  const autorizacaoIA = dados?.laboratorioLocal ? null : dados?.autorizacaoIA ?? null;
  // P2-3: a fotografia e as imagens da galeria são confirmadas a cada geração, só depois de escolhidas (autorizacaoFoto).
  const imagensSelecionadas = completoAtivo ? !!foto : referencias.length > 0;
  const fotoLiberada = autorizacaoFoto;
  const faltaAutorizacao = !!autorizacaoIA && (!autorizacaoIA.vigente || autorizacaoIA.precisaRenovar || !!autorizacaoIA.indisponivel);
  const avisoGeracao = dados ? avisoSemGeracao({ disponiveis: dados.disponiveis, creditos: dados.creditos, laboratorio: !!dados.laboratorioLocal, avulso: dados.festaId === null, geracaoEmCurso: geracaoDoConviteEmCurso({ busy, acompanhando, geracaoIncerta: dados.geracaoIncerta, geracaoEmAndamento: dados.geracaoEmAndamento }) }) : null;
  const imagensSemAutorizacao = !dados?.laboratorioLocal && imagensSelecionadas && !autorizacaoFoto;
  const geracaoBloqueada = !dados || busy || !!acompanhando || !dados.iaDisponivel || !!dados.geracaoIncerta
    || faltaAutorizacao || imagensSemAutorizacao
    || (dados.laboratorioLocal && !!dados.geradoresLocais && !dados.geradoresLocais.find(g => g.id === geradorLocal)?.disponivel)
    || (!dados.laboratorioLocal && dados.disponiveis < 1) || prompt.trim().length < 5;
  const avatarBloqueado = busy || !foto || avatarPronto || !autorizacaoFoto || !['cartoon3d', 'cartoon2d'].includes(estilo);
  const confirmacaoImagens = !dados?.laboratorioLocal && autorizacaoIA && imagensSelecionadas && autorizacaoFoto
    ? { autorizacaoImagens: { versao: autorizacaoIA.versao, textoHash: autorizacaoIA.hashes.imagens } } : {};
  useEffect(() => { const sair = (e: BeforeUnloadEvent) => { if (alterado) e.preventDefault(); }; window.addEventListener('beforeunload', sair); return () => window.removeEventListener('beforeunload', sair); }, [alterado]);
  async function executar(body: object, mensagem: string, preservar = false) {
    setBusy(true); setErro(''); setAviso('');
    try { const r = await api(body); await carregar(false, preservar); setAviso(mensagem); return r; }
    catch (e) { setErro((e as Error).message); return null; } finally { setBusy(false); }
  }
  function campo<K extends keyof Conteudo>(k: K, value: Conteudo[K]) { setConteudo(c => c ? { ...c, [k]: value } : c); }
  async function extrairCores() {
    if (!arte || !conteudo) return;
    const arteId = conteudo.arteId; setBusy(true); setErro('');
    try {
      const cores = await extrairPaleta(arte);
      setConteudo(c => c?.arteId === arteId ? { ...c, visual: { ...(c.visual ?? visualPadrao), cores } } : c);
      setAviso('Cores extraídas. Confira a prévia e publique para atualizar a página. Nenhum crédito foi usado.');
    } catch (e) { setErro((e as Error).message); } finally { setBusy(false); }
  }
  async function atualizarPresencas() {
    setBusy(true); setErro('');
    try {
      const atual = await api() as Dados;
      // Não avança a revisão do rascunho: outra aba pode ter editado o convite.
      setDados(d => d ? { ...d, respostas: atual.respostas, familias: atual.familias, convidadosContratados: atual.convidadosContratados } : d);
      setAviso('Confirmações atualizadas. Suas alterações no editor foram preservadas.');
    }
    catch (e) { setErro((e as Error).message); } finally { setBusy(false); }
  }
  async function executarFamilia(cmd: ComandoFamilia): Promise<ResultadoFamilia | null> {
    setBusy(true); setErro(''); setAviso('');
    try {
      const r = await api(cmd) as ResultadoFamilia;
      const atual = await api() as Dados;
      setDados(d => d ? { ...d, familias: atual.familias, respostas: atual.respostas, historico: atual.historico, convidadosContratados: atual.convidadosContratados } : d);
      return r;
    } catch (e) { setErro((e as Error).message); return null; } finally { setBusy(false); }
  }
  async function upload(file?: File) {
    if (!file) return;
    if (file.size > 5_000_000 || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) { setErro('Envie PNG, JPEG ou WebP de até 5 MB.'); return; }
    try {
      const imagem = await new Promise<string>((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = reject; r.readAsDataURL(file); });
      const dica = !dados?.laboratorioLocal && conteudo && !modeloComFoto(conteudo.tema) ? ' Sua imagem já tem os dados da festa? Escolha “Convite pronto”.' : '';
      const r = await executar({ acao: 'upload', imagem }, `Arte enviada. Salve ou publique para aplicar.${dica}`, true);
      if (r?.arteId) setConteudo(c => c ? selecionarArte(c, r.arteId, false) : c);
    } catch { setErro('Não foi possível ler o arquivo.'); }
  }
  async function preparar() {
    const r = await executar({ acao: 'preparar', prompt }, 'Dados identificados. Confira nome, idade e data; preencha horário, local e endereço no editor antes de finalizar.', true);
    if (r) {
      setConteudo(c => c ? { ...c, ...r.campos, ...(dados?.laboratorioLocal && acervoAutomatico ? { tema: sugestaoAcervo(r.tema), visual: { ...visualPadrao, posicao: 'topo' as const } } : {}) } : c);
      setPreparado({ pedido: prompt, tema: r.tema, promptArte: r.promptImagem });
    }
    return r;
  }
  function mudarPrompt(texto: string) {
    setPrompt(texto);
    setConflitoPrompt(false);
    if (texto !== prompt) pedidoLiberado.current = null;
    setAvisoProtegido(null);
    setEstiloNoPedido('');
    setManterEstilo(false);
  }

  function mudarEstilo(valor: EstiloEditor) {
    setEstilo(valor);
    setEstiloNoPedido('');
    setManterEstilo(false);
  }

  function usarExemplo(texto: string) {
    if (texto === prompt) return;
    if (prompt.trim()) {
      setConfirmacao({ titulo: 'Substituir seu pedido pelo exemplo?', acao: 'Usar exemplo', confirmar: () => mudarPrompt(texto) });
    } else {
      mudarPrompt(texto);
      painelIA.current?.querySelector('textarea')?.focus();
    }
  }

  function removerFoto() {
    setFoto('');
    setAvatarPronto(false);
    setAutorizacaoFoto(false);
  }

  function removerReferencia(id: string) {
    setReferencias(refs => refs.filter(r => r !== id));
    setAutorizacaoFoto(false);
  }

  async function gerar(avatarOnly = false, liberarMencao = false) {
    if (avatarOnly ? avatarBloqueado : geracaoBloqueada) return;
    if (liberarMencao) {
      pedidoLiberado.current = prompt;
      setAvisoProtegido(null);
    } else if (pedidoLiberado.current !== prompt) {
      const mencao = acharPersonagemProtegido(prompt);
      if (mencao) { setAvisoProtegido({ mencao, avatarOnly }); return; }
    }

    const completo = completoAtivo;
    const conflitoEstilo = completo && !manterEstilo ? conflitoDeEstilo(prompt, estilo) : undefined;
    if (conflitoEstilo) { setEstiloNoPedido(conflitoEstilo); return; }
    if (completo && conteudo) {
      if (conferirPrompt(prompt, conteudo).conflito) { setConflitoPrompt(true); return; }
      if (foto && !fotoLiberada) { setErro(dados?.laboratorioLocal ? 'Confirme a autorização para usar a foto.' : 'Confirme o envio da fotografia e das imagens da galeria selecionadas para esta geração.'); return; }
    }
    // O servidor usa os dados salvos da festa: salvar antes evita gerar com textos diferentes da tela.
    if (!dados?.laboratorioLocal && completo && alterado && dados && conteudo && !await executar({ acao: 'salvar', revisao: dados.revisao, conteudo }, 'Rascunho salvo.')) return;
    if (dados?.laboratorioLocal && !completo && preparado?.pedido !== prompt && !await preparar()) return;
    const assinatura = JSON.stringify({ prompt, referencias, ...(avatarOnly ? { avatarOnly } : {}), ...(dados?.laboratorioLocal ? { tipo: 'imagem', provedor: geradorLocal, completo, ...(completo ? { campos: conteudo, qualidade, estilo, foto } : {}) } : completo ? { completo, estilo, foto, ...(qualidade !== 'xhigh' ? { qualidade } : {}), campos: conteudo && { nome: conteudo.nome, idade: conteudo.idade, data: conteudo.data, horario: conteudo.horario, local: conteudo.local, endereco: conteudo.endereco, mensagem: conteudo.mensagem } } : {}) });
    if (!pedido.current || pedido.current.assinatura !== assinatura) pedido.current = pedidoSalvo(assinatura) ?? { assinatura, chave: crypto.randomUUID(), ...(dados?.laboratorioLocal ? { seed: crypto.getRandomValues(new Uint32Array(1))[0] } : {}) };
    if (dados?.laboratorioLocal) {
      setBusy(true); setErro(''); setRelatorioLocal(''); setEtapaLocal('Preparando workflow…');
      try {
        const inicio = await api({ acao: 'gerar', chave: pedido.current.chave, prompt, referencias: [], tipo: 'imagem', provedor: geradorLocal, completo, ...(avatarOnly ? { avatarOnly } : {}), ...(completo ? { campos: conteudo, qualidade, estilo, ...(foto ? { foto, autorizacaoFoto } : {}) } : {}), seed: pedido.current.seed });
        setJobLocal(inicio.jobId);
        // Executado pelo clique de geração, nunca durante o render.
        // eslint-disable-next-line react-hooks/purity -- Prazo do polling no handler de clique.
        const limite = Date.now() + 31 * 60 * 1000;
        // eslint-disable-next-line react-hooks/purity -- Polling assíncrono iniciado pelo usuário.
        while (Date.now() < limite) {
          const job = await api({ acao: 'trabalho', jobId: inicio.jobId });
          setEtapaLocal(({ PREPARANDO: 'Verificando gerador…', GERANDO: 'Gerando a imagem…', REVISANDO: 'Preparando a imagem para o editor…', CANCELADO: 'Resultado descartado.', CONCLUIDO: 'Arte pronta para conferência.', FALHOU: 'Geração interrompida.' } as Record<string, string>)[job.estado] ?? job.estado);
          if (job.estado === 'FALHOU') { pedido.current = null; throw new Error(job.erro || 'Confira o Console do ComfyUI. O pedido não será reenviado.'); }
          if (job.estado === 'CANCELADO') { pedido.current = null; break; }
          if (job.estado === 'CONCLUIDO') {
            if (avatarOnly) {
              const resposta = await fetch(`/laboratorio/arte/${job.arteId}`);
              if (!resposta.ok) throw new Error('Avatar criado, mas não foi possível carregá-lo. Confira a galeria; não gere novamente.');
              const blob = await resposta.blob();
              const dataUrl = await new Promise<string>((resolve, reject) => { const leitor = new FileReader(); leitor.onload = () => resolve(String(leitor.result)); leitor.onerror = () => reject(new Error('Não foi possível abrir o avatar.')); leitor.readAsDataURL(blob); });
              setFoto(dataUrl); setAvatarPronto(true); setAutorizacaoFoto(false);
              setEtapaLocal('Avatar pronto. Confira a imagem, confirme a autorização e clique em Gerar convite completo para a segunda chamada.');
              pedido.current = null; await carregar(false, true); break;
            }
            await carregar(false, true);
            setConteudo(c => c ? { ...c, arteId: job.arteId, visual: { ...(c.visual ?? visualPadrao), modo: job.completo ? 'completa' : 'modelo', posicao: 'topo', ...(job.completo ? { ajuste: 'conter' as const } : {}) } } : c);
            setRelatorioLocal(`${job.plano?.motivo} ${job.completo ? 'Textos gravados na imagem. Alterar os campos não altera a arte; confira a escrita e os dados antes de usar.' : 'Imagem preservada; moldura e textos são montados pelo editor.'} OCR não executado.`);
            pedido.current = null; break;
          }
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
        if (pedido.current) throw new Error('Espera encerrada. Confira a fila do ComfyUI antes de iniciar outro pedido; nenhum reenvio automático foi feito.');
      } catch (e) { setErro((e as Error).message); }
      finally { setBusy(false); setJobLocal(''); }
      return;
    }
    const comando = completo
      ? { acao: 'gerar', chave: pedido.current.chave, prompt, referencias: [], completo: true, estilo, qualidade, ...(foto && fotoLiberada ? { foto, ...confirmacaoImagens } : {}) }
      : { acao: 'gerar', chave: pedido.current.chave, prompt, referencias, ...confirmacaoImagens };
    // §4: o buffet espera o "Mostrar a logo" pendente (até 5 s); a família sempre envia false (o servidor não confere).
    let logoLigada = false;
    if (admin && dados?.logoBuffet) {
      setBusy(true); setErro('');
      const valor = await logo.logoLigada(() => setAviso(TEXTO_ESPERANDO_LOGO));
      setBusy(false);
      if (valor === null) { setAviso(''); setErro(TEXTO_LOGO_NAO_SALVA); return; }
      logoLigada = valor;
    }
    const chave = pedido.current.chave, pronta = completo ? 'Convite pronto. Confira a escrita de todos os textos e dados antes de publicar.' : 'Confira a arte e publique quando estiver pronta.';
    guardarPedido(pedido.current);
    // Uso único: a confirmação das imagens vale só para este pedido; a próxima geração pede de novo.
    if (!dados?.laboratorioLocal) setAutorizacaoFoto(false);
    setBusy(true); setErro(''); setAviso(MENSAGEM_GERANDO);
    let r: SituacaoGeracao;
    try { r = await api({ ...comando, logoLigada }) as SituacaoGeracao; }
    catch (e) {
      const status = (e as { status?: number }).status;
      setBusy(false);
      // Resposta definitiva do servidor (validação, créditos, geração não iniciada): mostra e para.
      // Antes de esquecer a chave, confere se um envio anterior dela (conexão perdida) já existe: nesse caso acompanha
      // esse pedido em vez de liberar uma nova chave paga.
      if (status && (status < 500 || status === 503)) {
        const mensagem = (e as Error).message;
        try { await api(undefined, `geracao=${chave}`); void acompanhar(chave); return; }
        catch { /* 404 ou indisponível: nenhum pedido ficou com esta chave */ }
        setAviso(''); setErro(mensagem); esquecerPedido(); return;
      }
      // Conexão perdida, timeout ou resultado indefinido: acompanha o MESMO pedido, sem reenviar.
      void acompanhar(chave); return;
    }
    setBusy(false);
    // Outra aba já gerando: acompanha sem trocar a arte deste rascunho (a de outra pessoa vai só para a galeria).
    if (r.estado === 'EM_ANDAMENTO') { if (r.chave !== chave) esquecerPedido(); void acompanhar(r.chave, r.chave === chave); return; }
    if (r.estado === 'CONCLUIDA') { try { await carregar(false, true); } catch { /* a arte já está salva; a próxima leitura mostra */ } }
    aplicarSituacao(r, pronta);
  }
  function chavePedido() { return dados?.id && !dados.laboratorioLocal ? `convite-pedido:${dados.id}` : ''; }
  function pedidoSalvo(assinatura: string) {
    try {
      const salvo = JSON.parse(sessionStorage.getItem(chavePedido()) || 'null') as { assinatura?: string; chave?: string } | null;
      return chavePedido() && salvo?.chave && salvo.assinatura === resumoPedido(assinatura) ? { assinatura, chave: salvo.chave } : null;
    } catch { return null; }
  }
  function guardarPedido(p: { assinatura: string; chave: string }) { try { if (chavePedido()) sessionStorage.setItem(chavePedido(), JSON.stringify({ assinatura: resumoPedido(p.assinatura), chave: p.chave })); } catch { /* sem armazenamento: a chave segue só em memória */ } }
  function esquecerPedido() { pedido.current = null; try { if (chavePedido()) sessionStorage.removeItem(chavePedido()); } catch { /* nada guardado */ } }
  // selecionar=false: geração de outra pessoa acompanhada ao abrir o editor; a arte vai para a galeria, sem mudar a prévia.
  function aplicarSituacao(r: SituacaoGeracao, pronta = 'Arte pronta. Confira e publique quando quiser.', selecionar = true) {
    if (r.estado === 'CONCLUIDA' && r.arteId && !selecionar) { setErro(''); setAviso('A arte gerada já está nas imagens da festa.'); return; }
    if (r.estado === 'CONCLUIDA' && r.arteId) { const arteId = r.arteId; setConteudo(c => c ? selecionarArte(c, arteId, !!r.completo) : c); esquecerPedido(); setErro(''); setAviso(pronta); return; }
    if (r.estado === 'VERIFICANDO') { setErro(''); setAviso(MENSAGEM_VERIFICANDO); void carregar(false, true).catch(() => undefined); return; }
    esquecerPedido(); setAviso('');
    if (r.estado === 'NAO_INICIADA') setErro('Não foi possível iniciar a geração. Nenhum crédito foi usado; você pode tentar novamente.');
    else setAviso(r.estado === 'DEVOLVIDA' ? 'A geração anterior não foi concluída e o crédito foi devolvido.' : 'A geração anterior não foi concluída.');
    void carregar(false, true).catch(() => undefined);
  }
  // Acompanha um pedido já enviado (outra aba, recarga, conexão perdida) só por leitura; nunca envia outra geração.
  async function acompanhar(chave: string, selecionar = true) {
    if (acompanhamento.current === chave) return;
    acompanhamento.current = chave; setAcompanhando(chave); setErro(''); setAviso(MENSAGEM_GERANDO);
    // eslint-disable-next-line react-hooks/purity -- Prazo do acompanhamento iniciado por clique ou pela carga do convite.
    const limite = Date.now() + 15 * 60 * 1000;
    let ausente = 0;
    try {
      while (acompanhamento.current === chave && Date.now() < limite) {
        try {
          const r = await api(undefined, `geracao=${chave}`) as SituacaoGeracao;
          if (acompanhamento.current !== chave) return;
          if (r.estado !== 'EM_ANDAMENTO') { if (r.estado === 'CONCLUIDA') { try { await carregar(false, true); } catch { /* a arte já está salva */ } } aplicarSituacao(r, undefined, selecionar); return; }
          ausente = 0;
        } catch (e) {
          // Pedido ainda não registrado (envio lento ou perdido): a chave é mantida; repetir o clique não cobra duas vezes.
          if ((e as { status?: number }).status === 404 && ++ausente >= 4) { setAviso(''); setErro('Não encontramos este pedido. Se tentar de novo, o mesmo pedido será usado, sem cobrança duplicada.'); return; }
        }
        await new Promise(resolve => setTimeout(resolve, 4000));
      }
      if (acompanhamento.current === chave) setAviso(MENSAGEM_VERIFICANDO);
    } finally { if (acompanhamento.current === chave) { acompanhamento.current = ''; setAcompanhando(''); } }
  }
  // Ao abrir (ou recarregar) o editor: retoma o pedido desta aba ou a geração em andamento da festa.
  useEffect(() => {
    if (carregando || !dados?.id || dados.laboratorioLocal) return;
    let salva = '';
    try { salva = (JSON.parse(sessionStorage.getItem(`convite-pedido:${dados.id}`) || 'null') as { chave?: string } | null)?.chave ?? ''; } catch { /* sem armazenamento */ }
    // O pedido desta aba seleciona a arte ao concluir; uma geração de outra pessoa só é acompanhada.
    const chave = salva || dados.geracaoEmAndamento;
    if (chave) void Promise.resolve().then(() => acompanhar(chave, !!salva));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Só na primeira carga de cada convite; acompanhar lê o estado atual.
  }, [carregando, dados?.id]);
  async function copiar(link: string) { try { await navigator.clipboard.writeText(new URL(link, window.location.origin).href); setAviso('Link copiado.'); } catch { setErro('Não foi possível copiar. Selecione o link para copiar manualmente.'); } }
  async function whatsAppConvidados(link: string) {
    const janela = window.open('', '_blank');
    if (!janela) { setErro('Permita abrir uma nova aba ou copie o link para compartilhar.'); return; }
    janela.opener = null;
    setErro('');
    try {
      const url = new URL(link, window.location.origin);
      const resposta = await fetch(`/api/convites/publico/${url.pathname.split('/').at(-1)}`, { cache: 'no-store' });
      if (!resposta.ok) throw new Error();
      const { data: { conteudo: publicado } } = await resposta.json() as { data: { conteudo: Conteudo } };
      const nome = publicado.nome.trim(), data = publicado.data.trim(), hora = publicado.horario.trim();
      const mensagem = `Você está convidado para a festa${nome ? ` de ${nome}` : ''}${data ? `, dia ${dataBonita(data)}` : ''}${hora ? ` às ${hora}` : ''}. Abra o convite e confirme presença: ${url.href}`;
      janela.location.replace(`https://wa.me/?text=${encodeURIComponent(mensagem)}`);
    } catch {
      janela.close();
      setErro('Não foi possível abrir o WhatsApp. Confira o convite publicado e tente de novo.');
    }
  }

  async function criarLinkCliente() {
    const r = await executar({ acao: 'acesso', habilitado: true }, 'Link de edição criado.', true);
    if (r?.linkCliente) setLinkCliente(new URL(r.linkCliente, window.location.origin).href);
  }

  async function excluirArte() {
    if (!arteExcluir || !dados) return;
    const id = arteExcluir.id;
    const r = await executar({ acao: 'excluir_arte', arteId: id, revisao: dados.revisao }, 'Imagem excluída da galeria. As demais alterações no editor foram preservadas.', true);
    if (r) {
      logo.esquecerArte(id);
      setConteudo(c => c?.arteId === id ? semArte(c) : c);
      if (referencias.includes(id)) removerReferencia(id);
      setArteExcluir(null);
    }
  }
  const arte = dados?.artes.find(a => a.id === conteudo?.arteId)?.url;
  const arteCompletaIA = dados?.artes.find(a => a.id === conteudo?.arteId)?.completo === true;
  const opcoesPosicao = conteudo ? opcoesComposicao({ temArte: !!arte, comFoto: modeloComFoto(conteudo.tema), arteCompletaIA, laboratorio: !!dados?.laboratorioLocal }) : [];
  const conviteProprioPronto = !!arte && !arteCompletaIA && conteudo?.visual?.modo === 'completa';
  const quando = conteudo ? [conteudo.data ? dataBonita(conteudo.data) : '', conteudo.horario ? `às ${conteudo.horario}` : ''].filter(Boolean).join(' ') : '';
  // Salão contratado (blocoLocal) + complemento, a mesma linha da arte e da página pública.
  const dadosConferencia = [quando, conteudo ? localDoConvite(conteudo) : ''].filter(Boolean).join(', ');
  const modelosFiltrados = modelosBiblioteca.filter(id => (dados?.laboratorioLocal || !(modelosAcervo as readonly string[]).includes(id)) && (categoriaModelo === 'todos' || (categoriaModelo === 'abertos' ? (modelosAcervo as readonly string[]).includes(id) : categoriaModelo === 'fotos' ? modeloComFoto(id) : categoriaModelo === 'neutros' ? baseNeutra(id) : !baseNeutra(id) && !modeloComFoto(id))));
  const totalPaginas = Math.max(1, Math.ceil(modelosFiltrados.length / 9));
  const paginaAtual = Math.min(paginaModelo, totalPaginas);
  const modelosDaPagina = modelosFiltrados.slice((paginaAtual - 1) * 9, paginaAtual * 9);
  const conferencia = conteudo ? conferirPrompt(prompt, conteudo) : null;
  const rotuloEstilo = estilosDoEditor.find(([id]) => id === estilo)?.[1] ?? estilo;
  const tamanhoPaginaArte = colunasGaleria * 3;
  const paginasArte = Math.max(1, Math.ceil((dados?.artes.length ?? 0) / tamanhoPaginaArte));
  const paginaArteAtual = Math.min(paginaArte, paginasArte);
  const inicioArte = (paginaArteAtual - 1) * tamanhoPaginaArte;
  const artesVisiveis = dados?.artes.slice(inicioArte, inicioArte + tamanhoPaginaArte);
  const galeriaArtes = dados && conteudo && dados.artes.length > 0 && <><div className={ui.galeria}>{artesVisiveis?.map((a, indice) => { const n = indice + inicioArte; return <div key={a.id} className={ui.arteItem}><button className={ui.arteSelecionar} type="button" aria-label={`Selecionar imagem ${n + 1}`} aria-pressed={conteudo.arteId === a.id} onClick={() => setConteudo(c => c ? selecionarArte(c, a.id, !!a.completo) : c)}><img src={a.url} alt={`Imagem ${n + 1} da festa`} /><span>{conteudo.arteId === a.id ? 'Selecionada' : 'Usar imagem'}</span></button><button type="button" disabled={busy} className={ui.excluir} aria-label={`Excluir imagem ${n + 1}`} onClick={() => { setErro(''); setArteExcluir(a); }}>Excluir imagem</button></div>; })}</div>{paginasArte > 1 && <nav className={ui.paginacaoArtes} aria-label="Páginas das imagens da festa"><button type="button" disabled={busy || paginaArteAtual === 1} onClick={() => setPaginaArte(paginaArteAtual - 1)}>← Anterior</button><span aria-live="polite">Página {paginaArteAtual} de {paginasArte}</span><button type="button" disabled={busy || paginaArteAtual === paginasArte} onClick={() => setPaginaArte(paginaArteAtual + 1)}>Próxima →</button></nav>}{conteudo.arteId && <button type="button" className={ui.linkBotao} onClick={() => { setConteudo(c => c ? semArte(c) : c); setAviso('Imagem removida da composição. Salve o rascunho ou publique para aplicar.'); }}>Remover imagem do convite</button>}<small>{dados.laboratorioLocal ? 'Remover do convite mantém a imagem na galeria. Excluir retira da galeria local e preserva o arquivo original.' : 'Remover do convite mantém o arquivo na galeria. Excluir imagem apaga o arquivo desta festa.'}</small></>;
  const conteudoGeracao = dados && conteudo ? (<>
          <h3>Como você imagina a arte?</h3>
          <p id="orientacao-arte">Diga o tema, as cores e o que aparece na cena.<br />Não escreva nome, idade nem data: eles vêm dos dados da festa.</p>
          <p id="titulo-exemplos"><strong>Comece por um exemplo</strong></p>
          <div role="group" aria-labelledby="titulo-exemplos" className={styles.exemplosPedido}>
            {exemplosPedido.map(([titulo, texto]) => <button key={titulo} type="button" disabled={busy} onClick={() => usarExemplo(texto)}>{titulo}</button>)}
          </div>
          <PromptComCorretor habilitado corrigir={mudarPrompt} lang="pt-BR" spellCheck autoCorrect="on" autoCapitalize="sentences"
            title="Clique com o botão direito sobre uma palavra para ver sugestões de escrita." aria-label="Descreva a arte do convite"
            aria-describedby="orientacao-arte" rows={4} maxLength={3000} value={prompt} onChange={e => mudarPrompt(e.target.value)} disabled={busy} />
          <small>O exemplo é só um começo. Troque as cores e os elementos como quiser.</small>
          {avisoProtegido && <section className={`${ui.conferenciaPrompt} ${styles.avisoProtegido}`} role="alert">
            {avisoProtegido.mencao.tipo === 'marca'
              ? <p>{avisoProtegido.mencao.termo} é uma marca protegida. Não podemos reproduzir seus personagens nem o logotipo. Podemos criar uma arte original com o mesmo clima.</p>
              : <p>{avisoProtegido.mencao.termo} é um personagem protegido. Não podemos reproduzi-lo. Podemos criar uma arte original com o mesmo clima, sem o personagem.</p>}
            <div className={ui.acoes}>
              <button type="button" onClick={() => painelIA.current?.querySelector('textarea')?.focus()}>Editar meu pedido</button>
              <button type="button" onClick={semIA}>Enviar uma imagem minha</button>
            </div>
            <button type="button" className={styles.continuarPedido} disabled={avisoProtegido.avatarOnly ? avatarBloqueado : geracaoBloqueada}
              onClick={() => void gerar(avisoProtegido.avatarOnly, true)}>Meu pedido não é sobre {avisoProtegido.mencao.termo}</button>
          </section>}
          {estiloNoPedido && <section className={ui.conferenciaPrompt} role="alert">
            <p>Seu pedido fala em {estiloNoPedido}, mas o estilo escolhido é {rotuloEstilo}.</p>
            <div className={ui.acoes}>
              <button type="button" onClick={() => mudarEstilo('pedido')}>Usar o estilo do meu pedido</button>
              <button type="button" onClick={() => { setEstiloNoPedido(''); setManterEstilo(true); }}>Manter {rotuloEstilo}</button>
            </div>
          </section>}
          {completoAtivo && <>
            <details className={ui.fotoReferencia}><summary>Foto do aniversariante · opcional</summary>
              <p>Use uma foto com o rosto visível. Quando o estilo escolhido tem referência aprovada, ela é incluída automaticamente na mesma geração. A semelhança pode variar.</p>
              <input hidden ref={fotoArquivo} type="file" accept="image/png,image/jpeg,image/webp" onChange={e => { setAvatarPronto(false); void lerFoto(e.target.files?.[0]); e.target.value = ''; }} />
              <input hidden ref={fotoCamera} type="file" accept="image/*" capture="user" onChange={e => { setAvatarPronto(false); void lerFoto(e.target.files?.[0]); e.target.value = ''; }} />
              <div className={ui.acoes}><button type="button" disabled={busy} onClick={() => fotoArquivo.current?.click()}>Escolher foto</button><button type="button" disabled={busy} onClick={() => fotoCamera.current?.click()}>Tirar foto</button></div>
              {dados.laboratorioLocal && foto && <><img className={ui.miniaturaFoto} src={foto} alt="Foto de referência do aniversariante" /><button type="button" disabled={busy} onClick={removerFoto}>Remover foto</button>{dados.laboratorioLocal ? <label className={ui.check}><input type="checkbox" checked={autorizacaoFoto} disabled={busy} onChange={e => setAutorizacaoFoto(e.target.checked)} />Tenho autorização para enviar esta foto à OpenAI; sou responsável ou tenho autorização do responsável.</label> : null}</>}
              {dados.laboratorioLocal && foto && !avatarPronto && <button type="button" disabled={avatarBloqueado} onClick={() => void gerar(true)}>1. Criar avatar cartoon · 1 chamada paga</button>}
              {avatarPronto && <p role="status">Avatar selecionado como referência. Confira antes de gerar o convite.</p>}
              {dados.laboratorioLocal && <small>Gere o convite diretamente para usar uma chamada. Criar avatar antes é um teste opcional e custa uma chamada adicional.</small>}
              <small>PNG, JPEG ou WebP, até 5 MB. A foto não fica salva no convite; ela é enviada {dados.laboratorioLocal ? 'à OpenAI' : autorizacaoIA ? `ao provedor indicado (${autorizacaoIA.provedorNome})` : 'ao provedor de IA'} somente ao gerar e com a autorização da fotografia.</small>
            </details>
            {conflitoPrompt && conferencia && <section className={ui.conferenciaPrompt} role="alert"><strong>Confira o nome e a idade antes de gerar</strong><p>Na festa: {conteudo.nome || 'sem nome'} · {conteudo.idade || 'sem idade'}. No pedido: {conferencia.nomes.join(', ') || 'nome não informado'} · {conferencia.idades.join(', ') || 'idade não informada'}.</p><div className={ui.acoes}><button type="button" onClick={() => { mudarPrompt(alinharPrompt(prompt, conteudo)); }}>Usar dados da festa</button><button type="button" disabled={conferencia.ambiguo} onClick={() => { setConteudo({ ...conteudo, ...(conferencia.nomes[0] ? { nome: conferencia.nomes[0] } : {}), ...(conferencia.idades[0] ? { idade: `${conferencia.idades[0]} anos` } : {}) }); setConflitoPrompt(false); }}>Usar dados do pedido</button></div><small>Depois da escolha, confira os campos e clique em gerar. Nenhum teste foi consumido.</small></section>}
          </>}
          {autorizacaoIA && <ConviteAutorizacaoIA ia={autorizacaoIA} busy={busy || !!acompanhando} ui={ui} semIA={semIA} executar={(body, mensagem) => executar(body, mensagem, true)} />}
          <div className={ui.controlesIA}>
            {completoAtivo && <div className={ui.qualidade}><span>Estilo</span><SeletorArte nome="Estilo da arte" valor={estilo} desativado={busy} mudar={mudarEstilo} opcoes={estilosDoEditor} ui={ui} /><small>Sem estilo no pedido, usamos cartoon 3D.</small></div>}
            {completoAtivo && <div className={ui.qualidade}><span>Qualidade</span><SeletorArte nome="Qualidade da imagem" valor={qualidade} desativado={busy || !!acompanhando} mudar={setQualidade} opcoes={[["high", "Alta"], ["xhigh", "Muito alta"], ["max", "Máxima"]]} ui={ui} /><small>Maior qualidade pode aumentar o custo e o tempo.</small></div>}
          </div>
          {!dados.laboratorioLocal && !completoAtivo && !!dados.artes.length && <><p>Referências: escolha até duas artes anexadas.</p><div className={ui.artes}>{dados.artes.map(a => <button key={a.id} disabled={busy || (!referencias.includes(a.id) && referencias.length >= 2)} type="button" aria-label="Usar arte como referência" aria-pressed={referencias.includes(a.id)} onClick={() => { setAutorizacaoFoto(false); setReferencias(refs => refs.includes(a.id) ? refs.filter(id => id !== a.id) : [...refs, a.id]); }}><img src={a.url} alt="Referência" /></button>)}</div></>}
          {!dados.laboratorioLocal && imagensSelecionadas && <section className={ui.confirmacaoImagens} aria-label="Imagens para esta geração">
            <h3>Vai ser enviado a {autorizacaoIA?.provedorNome ?? 'um provedor de IA'} nesta geração</h3>
            <div className={styles.imagensDaGeracao}>
              {foto && completoAtivo && <div>
                <img className={ui.miniaturaFoto} src={foto} alt="Foto de referência do aniversariante" />
                <button type="button" disabled={busy} onClick={removerFoto}>Remover</button>
              </div>}
              {!completoAtivo && dados.artes.filter(a => referencias.includes(a.id)).map(a => <div key={a.id}>
                <img className={ui.miniaturaFoto} src={a.url} alt="Imagem de referência da festa" />
                <button type="button" disabled={busy} onClick={() => removerReferencia(a.id)}>Remover</button>
              </div>)}
            </div>
            {autorizacaoIA && !autorizacaoIA.indisponivel && <ConfirmacaoImagensIA ia={autorizacaoIA} marcado={autorizacaoFoto} mudar={setAutorizacaoFoto} busy={busy || !!acompanhando} ui={ui} />}
          </section>}
          <div className={styles.gerarArte}>
            <button type="button" className={ui.primario} disabled={geracaoBloqueada} onClick={() => void gerar()}>{busy ? 'Processando…' : dados.laboratorioLocal ? (conviteCompleto && geradorLocal === 'openai' ? 'Gerar convite completo' : 'Gerar imagem') : completoAtivo ? 'Gerar convite completo · 1 crédito' : 'Gerar arte · 1 crédito'}</button>
          </div>
          {dados.laboratorioLocal && <>
            <small>Confira os dados antes de gerar. {geradorLocal === 'comfy' ? 'Geração na sua GPU.' : 'Uma chamada paga.'} Sem repetição automática.</small>
            <details><summary>Opções avançadas</summary>
              {geradorLocal === 'openai' && <label className={ui.check}><input type="checkbox" checked={conviteCompleto} disabled={busy} onChange={e => setConviteCompleto(e.target.checked)} />Convite completo</label>}
              {dados.geradoresLocais && <label>Gerador<select value={geradorLocal} disabled={busy} onChange={e => setGeradorLocal(e.target.value)}>{dados.geradoresLocais.map(g => <option key={g.id} value={g.id}>{g.id === 'openai' && conviteCompleto ? 'OpenAI · Sunburst' : g.nome}{!g.disponivel ? ' · indisponível' : ''}</option>)}</select></label>}
            </details>
            {etapaLocal && <p role="status">{etapaLocal}</p>}
            {jobLocal && <><button type="button" onClick={() => { void api({ acao: 'cancelar', jobId: jobLocal }).then(() => setEtapaLocal('Cancelamento solicitado.')).catch(e => setErro(e.message)); }}>Descartar resultado</button><small>A solicitação já enviada pode ser cobrada mesmo ao descartar.</small></>}
          </>}
          {faltaAutorizacao && !autorizacaoIA?.indisponivel && <p role="status"><small>Registre a autorização do responsável legal para gerar com IA, ou use uma arte própria.</small></p>}
          {avisoGeracao && <p role="status"><small>{avisoGeracao}</small></p>}
          {!faltaAutorizacao && imagensSemAutorizacao && <p role="status"><small>Confirme o envio da fotografia e das imagens da galeria selecionadas, ou remova-as, para gerar.</small></p>}
          <small>{dados.laboratorioLocal ? conteudo.visual?.modo === 'completa' ? 'Textos incorporados na imagem: editar os campos não altera a arte pronta.' : 'A moldura e os dados da festa são montados pelo editor.' : !dados.iaDisponivel ? 'O buffet ainda não habilitou a IA. Você pode enviar sua própria arte.' : completoAtivo ? 'Uma chamada por convite: arte e textos da festa juntos. Cada geração usa 1 crédito, sem repetição automática. Confira a escrita antes de publicar.' : 'Cada nova geração ou edição por IA usa 1 crédito. Downloads não usam créditos.'}</small>
        </>) : null;
  const painelArte = <section className={ui.painel} aria-labelledby="titulo-arte">
    <h2 id="titulo-arte">Arte do convite</h2>
    <div ref={escolhaArte} className={styles.escolhaArte}>
      <button type="button" className={ui.primario} aria-expanded={modoArte === 'ia'} aria-controls="painel-arte-ia" onClick={() => setModoArte(modoArte === 'ia' ? null : 'ia')}>Criar com IA</button>
      {!dados?.laboratorioLocal && <button type="button" data-arte-propria aria-expanded={modoArte === 'propria'} aria-controls="painel-arte-propria" onClick={() => setModoArte(modoArte === 'propria' ? null : 'propria')}>Usar imagem minha</button>}
    </div>
    <div ref={painelIA} id="painel-arte-ia" hidden={modoArte !== 'ia'}>{modoArte === 'ia' && conteudoGeracao}</div>
    {!dados?.laboratorioLocal && <div id="painel-arte-propria" hidden={modoArte !== 'propria'}>
      {modoArte === 'propria' && conteudo && <label className={ui.upload}>{modeloComFoto(conteudo.tema) ? 'Adicionar sua foto' : 'Usar uma arte própria'}
        <input type="file" accept="image/png,image/jpeg,image/webp" disabled={busy} onChange={e => { void upload(e.target.files?.[0]); e.target.value = ''; }} />
        <small>PNG, JPEG ou WebP · até 5 MB · sem créditos de IA</small>
      </label>}
    </div>}
  </section>;
  const painelConvidados = dados && !dados.laboratorioLocal && (dados.publicado || dados.desatualizado) && <section className={`${ui.painel} ${styles.conviteConvidados}${admin ? ` ${adminStyles.conviteConvidados}` : ''}`} aria-labelledby="titulo-convite-convidados">
        <h2 id="titulo-convite-convidados">Convite para os convidados</h2>
        {dados.desatualizado ? <p>O link dos convidados está suspenso. Confira data, horário e local e publique de novo.</p>
          : <>
            <p>Quem receber abre o convite e confirma presença.</p>
            <div className={styles.acoesConvite}>
              <button type="button" className={ui.primario} onClick={() => void whatsAppConvidados(dados.linkPublico)}>Enviar pelo WhatsApp</button>
              <button type="button" onClick={() => void copiar(dados.linkPublico)}>Copiar link</button>
              <a href={dados.linkPublico} target="_blank" rel="noreferrer">Abrir convite</a>
            </div>
          </>}
      </section>;
  const controlesLimites = dados && <div className={styles.controlesLimites}>
    {dados.creditos?.motor === 'CREDITOS'
      ? <p data-creditos-empresa>Créditos da empresa: {dados.creditos.disponivel} {comUnidade(dados.creditos.disponivel, 'disponível', 'disponíveis')}{textoReserva(dados.creditos.reservado)}{dados.creditos.consumoAtivo ? '' : ' · geração com créditos em manutenção'}. <Link href="/admin/configuracoes/creditos">Ver créditos</Link>. A festa já usou {dados.cotas.festaUsado}, sendo {dados.cotas.clienteUsado} pelo cliente.</p>
      : <p>Franquia mensal: {dados.cotas.empresaUsado ?? 0} de {dados.cotas.empresa ?? 0} usados. A festa já usou {dados.cotas.festaUsado}, sendo {dados.cotas.clienteUsado} pelo cliente.</p>}
    <div className={ui.campos}><label>{dados.festaId === null ? "Limite deste convite" : "Limite total da festa"}<input type="number" min={dados.cotas.festaUsado} max={100} value={cotaFesta} onChange={e => setCotaFesta(Number(e.target.value))} /></label><label>Limite do cliente<input type="number" min={dados.cotas.clienteUsado} max={cotaFesta} value={cotaCliente} onChange={e => setCotaCliente(Number(e.target.value))} /></label></div><button disabled={busy} onClick={() => void executar({ acao: 'cotas', festa: cotaFesta, cliente: cotaCliente }, 'Limites atualizados.', true)}>Aplicar limites</button><small>Os limites da festa são compartilhados. Somente a gestão pode aumentá-los. O saldo mensal da empresa continua sendo o teto.</small>
  </div>;
  return <main className={ui.editor} data-editor={admin ? 'buffet' : 'cliente'}>
    <header className={ui.cabecalho}><div><p className={ui.sobretitulo}>{admin ? 'FESTAS · CONVITE VIRTUAL' : 'CONVITES'}</p><h1>{admin ? (dados?.festaId === null ? 'Convite avulso' : 'Convite da festa') : <>Uma festa começa<br />com um convite.</>}</h1><p>{admin ? 'Personalize o convite, compartilhe com o cliente e acompanhe as confirmações.' : 'Escolha um tema, dê seu toque e compartilhe esse momento.'}</p></div>{admin && <div className={ui.acoesCabecalho}><Link className={ui.voltar} href={festaId ? `/admin/festas/${festaId}` : "/admin/convites"}>{festaId ? "← Voltar à festa" : "← Meus convites"}</Link></div>}</header>
    {admin && conviteId && dados?.festaId === null && <VincularFesta conviteId={conviteId} revisao={dados.revisao} bloqueado={busy || alterado || !!dados.geracaoEmAndamento || !!dados.geracaoIncerta} onVinculado={async () => { await carregar(); setAviso("Festa vinculada. Confira os dados e publique o convite."); }} />}
    {erro && <p className={ui.erro} role="alert">{erro}</p>}{(aviso || dados?.geracaoIncerta) && <p className={ui.aviso} role="status">{aviso || MENSAGEM_VERIFICANDO}</p>}
    {carregando ? <p>Preparando seu convite…</p> : falhaCarga && !dados ? <section className={ui.painel} data-falha-carga><p className={ui.erro} role="alert">{falhaCarga}</p><button type="button" className={ui.primario} onClick={() => { setFalhaCarga(''); setCarregando(true); void primeiraCarga(() => true); }}>Tentar de novo</button></section> : !dados || !conteudo ? <section className={ui.painel}><h2>Seu convite começa aqui</h2><p>Modelos prontos e arte própria não consomem créditos de IA.</p>{admin && <button disabled={busy} className={ui.primario} onClick={() => { setBusy(true); void carregar(true).then(() => setErro('')).catch(e => setErro(e.message)).finally(() => setBusy(false)); }}>Criar convite da festa</button>}</section> : <>
      <div className={ui.barra}><span>{dados.publicado ? '● Publicado' : '○ Rascunho'}{alterado ? ' · Alterações não salvas' : ''}</span><span>{dados.laboratorioLocal ? 'Teste local' : dados.creditos?.motor === 'CREDITOS'
        ? <><strong>{dados.disponiveis}</strong> {comUnidade(dados.disponiveis, 'geração restante', 'gerações restantes')} neste convite · <strong>{dados.creditos.disponivel}</strong> {creditosDisponiveisDaEmpresa(dados.creditos.disponivel)}</>
        : <><strong>{dados.disponiveis}</strong> {comUnidade(dados.disponiveis, 'crédito de imagem disponível', 'créditos de imagem disponíveis')}</>}</span></div>
      {painelConvidados}
      {!admin && tutorialAberto !== null && (tutorialAberto ? <section className={`${ui.painel} ${styles.tutorial}`} aria-labelledby="titulo-tutorial">
        <div className={styles.cabecalhoTutorial}>
          <h2 id="titulo-tutorial" tabIndex={-1}>Como fazer, em 3 passos</h2>
          <button type="button" onClick={() => {
            tutorial(false);
            requestAnimationFrame(() => document.getElementById('reabrir-tutorial')?.focus());
          }}>Fechar</button>
        </div>
        <ol>
          <li>Confira os dados da festa. Eles já vêm do contrato.</li>
          <li>Crie a arte: descreva o que imagina ou envie uma imagem sua.</li>
          <li>Publique e envie o link aos convidados.</li>
        </ol>
        <p>Você pode salvar e voltar depois por este mesmo link.</p>
      </section> : <p className={styles.reabrirTutorial}><button type="button" id="reabrir-tutorial" className={ui.linkBotao} onClick={() => {
        tutorial(true);
        requestAnimationFrame(() => document.getElementById('titulo-tutorial')?.focus());
      }}>Como fazer?</button></p>)}
      <div className={`${ui.colunas} ${ui.colunaUnica}`}><div className={ui.configuracao}>
        {MOLDURAS_NO_EDITOR && <fieldset disabled={busy} className={ui.painel}><legend>{dados.laboratorioLocal ? 'Biblioteca de molduras e imagens' : '01 · Escolha o visual'}</legend><details open={!dados.laboratorioLocal || undefined}><summary>Escolher moldura ou imagem</summary>
          {!(dados.laboratorioLocal && conteudo.visual?.modo === 'completa') && <><div className={styles.filtrosModelos} role="group" aria-label="Filtrar modelos">{([['todos', 'Todos'], ['neutros', 'Bases neutras'], ['fotos', 'Com foto'], ['temas', 'Temas']] as const).map(([id, nome]) => <button key={id} type="button" aria-pressed={categoriaModelo === id} onClick={() => { setCategoriaModelo(id); setPaginaModelo(1); }}>{nome}</button>)}</div>
          {dados.laboratorioLocal && <div className={styles.filtrosModelos}><button type="button" aria-pressed={categoriaModelo === 'abertos'} onClick={() => { setCategoriaModelo('abertos'); setPaginaModelo(1); }}>Coleção aberta</button><small>3 molduras prontas · elementos Tabler / MIT · sem créditos</small></div>}
          <div className={styles.modelosBiblioteca}>{modelosDaPagina.map(id => <button key={id} type="button" aria-pressed={conteudo.tema === id} onClick={() => setConteudo(c => c && (c.tema === id ? c : { ...c, tema: id, visual: { ...visualPadrao, posicao: c.visual?.posicao }, arteId: c.arteId }))}><img src={`/convites/modelos/${id}.svg`} alt="" /><strong>{temas[id].nome}</strong><small>{modeloComFoto(id) ? 'Sua foto em destaque' : baseNeutra(id) ? 'Base neutra · vários temas' : 'Tema espacial'}</small></button>)}</div>
          {totalPaginas > 1 && <nav className={styles.paginacaoModelos} aria-label="Páginas da biblioteca"><button type="button" disabled={paginaAtual === 1} onClick={() => setPaginaModelo(p => Math.max(1, p - 1))}>Anterior</button><span role="status">Página {paginaAtual} de {totalPaginas}</span><button type="button" disabled={paginaAtual === totalPaginas} onClick={() => setPaginaModelo(p => Math.min(totalPaginas, p + 1))}>Próxima</button></nav>}
          {(categoriaModelo === 'todos' || categoriaModelo === 'temas') && <details className={styles.modelosAnteriores}><summary>Mais modelos</summary><div className={ui.temas}>{Object.entries(temas).filter(([id]) => !modeloBiblioteca(id as Conteudo['tema'])).map(([id, t]) => <button key={id} type="button" aria-pressed={conteudo.tema === id} onClick={() => campo('tema', id as Conteudo['tema'])} style={{ background: t.fundo, color: t.tinta }}><span>{t.simbolo}</span>{t.nome}</button>)}</div></details>}
          {!dados.laboratorioLocal && <label className={ui.upload}>{modeloComFoto(conteudo.tema) ? 'Adicionar sua foto' : 'Usar uma arte própria'}<input type="file" accept="image/png,image/jpeg,image/webp" onChange={e => { void upload(e.target.files?.[0]); e.target.value = ''; }} /><small>PNG, JPEG ou WebP · até 5 MB · sem créditos de IA</small></label>}
          {modeloComFoto(conteudo.tema) && <small>{arte ? 'A foto aparece inteira. Você pode trocá-la ou removê-la abaixo.' : 'Envie uma foto ou escolha uma imagem da festa para completar o modelo.'}</small>}
          </>}
          {galeriaArtes}
          {!(dados.laboratorioLocal && conteudo.visual?.modo === 'completa') && <ConviteVisual conteudo={conteudo} arte={arte} ui={ui} busy={busy} opcoesPosicao={dados.laboratorioLocal ? [] : opcoesPosicao} mudar={v => campo('visual', v)} extrair={() => void extrairCores()} />}</details>
        </fieldset>}
        <fieldset disabled={busy} className={`${ui.painel} ${ui.dadosCompactos}`} aria-label="Dados da festa">
          <h2 className={ui.tituloEtapa}>Dados da festa</h2>
          {/* D-LIB-3/5: bloco "Local" do contrato, somente leitura; o servidor o recalcula ao publicar. */}
          {conteudo.blocoLocal && <p className={ui.blocoLocal} data-bloco-local={conteudo.blocoLocal.origem}><strong>Local (do contrato)</strong> {conteudo.blocoLocal.nome}{conteudo.blocoLocal.endereco ? ` — ${conteudo.blocoLocal.endereco}` : ''}{dados.avisoLocal ? <small>{dados.avisoLocal}</small> : null}</p>}
          <div className={ui.campos}>
            {campos.map(([k, label]) => (
              <label key={k}>
                {k === 'local' && conteudo.blocoLocal ? 'Complemento do local (opcional)' : label}
                <input
                  type={k === 'data' ? 'date' : k === 'horario' ? 'time' : 'text'}
                  value={conteudo[k]}
                  maxLength={k === 'endereco' ? 240 : k === 'local' ? 120 : k === 'idade' ? 20 : 80}
                  onChange={e => campo(k, e.target.value)}
                />
              </label>
            ))}
          </div>
          <label>
            Mensagem
            <textarea rows={1} maxLength={400} value={conteudo.mensagem} onChange={e => campo('mensagem', e.target.value)} />
          </label>
          <label className={ui.check}>
            <input type="checkbox" checked={conteudo.confirmarPresenca} onChange={e => campo('confirmarPresenca', e.target.checked)} />
            Receber confirmações de presença
          </label>
          <small>{conviteProprioPronto ? 'Sua imagem aparece como está. Os dados abaixo continuam valendo para a página do convite e a confirmação de presença.' : conteudo.visual?.modo === 'completa' ? 'Os textos já estão na arte: alterações aqui valem para a próxima geração e para a página do convite.' : 'Alterar os textos não consome créditos.'}</small>
        </fieldset>
      </div><aside className={`${ui.preview} ${ui.previewLocal}`}><p className={ui.sobretitulo}>É ASSIM QUE SEU CONVITE VAI FICAR</p><ConviteArte conteudo={conteudo} arte={arte} sobre={logo.sobre} />
        {admin && dados.logoBuffet && logo.painel}
        {opcoesPosicao.length > 0 && <div className={ui.posicaoImagem}><SeletorComposicao conteudo={conteudo} opcoes={opcoesPosicao} busy={busy} className={ui.seletorCriacao} mudar={v => campo('visual', v)} />
          {conviteProprioPronto && <p role="status" data-conferencia-convite><small>Confira se a sua imagem tem os mesmos dados da festa{dadosConferencia ? `: ${dadosConferencia}` : ''}.</small></p>}</div>}
        <div className={ui.acoes}><button disabled={busy} onClick={() => void baixarConvite(conteudo, arte, logo.baixar.logo, logo.baixar.sobre).catch(() => setErro('Não foi possível baixar. Tente novamente.'))}>Baixar imagem</button></div>
        {painelArte}
        <div className={ui.acoes} role="group" aria-label="Publicação do convite">
          <button disabled={busy} onClick={() => void executar({ acao: 'salvar', revisao: dados.revisao, conteudo }, 'Rascunho salvo.')}>Salvar rascunho</button>
          {!dados.laboratorioLocal && <button disabled={busy} className={ui.primario} onClick={() => void executar({ acao: 'publicar', revisao: dados.revisao, conteudo }, 'Convite publicado. Agora você pode compartilhar.')}>Publicar convite</button>}
          {!dados.laboratorioLocal && !dados.publicado && !dados.desatualizado && <p className={styles.avisoPublicar}>Publique o convite para liberar o link dos convidados.</p>}
        </div>
        {dados.publicado && !dados.laboratorioLocal && <button type="button" className={ui.linkBotao} disabled={busy} onClick={() => setConfirmacao({
          titulo: 'Despublicar convite?', texto: 'O link dos convidados ficará indisponível até você publicar de novo.',
          acao: 'Despublicar', confirmar: async () => { await executar({ acao: 'despublicar', revisao: dados.revisao }, 'Convite despublicado.', true); },
        })}>Despublicar</button>}
      </aside></div>
      {(dados.artes.length > 0 || !dados.laboratorioLocal) && <details className={`${ui.painel} ${ui.galeriaLocal}`}>
        <summary>Imagens da festa</summary>
        <fieldset disabled={busy} className={ui.formulario}>{galeriaArtes || <p>As imagens enviadas e geradas aparecem aqui.</p>}</fieldset>
      </details>}
      {!dados.laboratorioLocal && <div className={ui.colunaInferior}>
        {admin && (dados.festaId === null ? <details className={ui.painel}>
          <summary>Limite deste convite</summary>
          {controlesLimites}
        </details> : <details className={ui.painel}>
          <summary>Edição pelo cliente</summary>
          {dados.clienteHabilitado ? <>
            <p>{dados.editor_expira_em ? `Ativo até ${new Date(dados.editor_expira_em).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })}.` : 'Acesso ativo.'} Só para quem contratou a festa.</p>
            <div className={styles.acoesConvite}>
              <span>Perdeu o link?</span>
              <button type="button" disabled={busy} onClick={() => setConfirmacao({
                titulo: 'Criar outro link de edição?',
                texto: 'O link atual para de funcionar. Se o cliente estiver editando agora, perde o que ainda não salvou.',
                acao: 'Criar outro link',
                confirmar: criarLinkCliente,
              })}>Criar outro link</button>
            </div>
          </> : <><p>O cliente quer montar o convite?</p><button type="button" disabled={busy} onClick={() => void criarLinkCliente()}>Liberar edição</button></>}
          {linkCliente && dados.clienteHabilitado && <div className={styles.linkEdicao}>
            <label>Link de edição · só para quem contratou a festa<input readOnly value={linkCliente} onFocus={e => e.target.select()} /></label>
            <div className={styles.acoesConvite}>
              <button type="button" className={ui.primario} onClick={() => window.open(
                `https://wa.me/?text=${encodeURIComponent(`Este é o link para você montar o convite da festa${dados.conteudo.nome.trim() ? ` de ${dados.conteudo.nome.trim()}` : ''}. Ele é só seu: não envie aos convidados. ${linkCliente}`)}`,
                '_blank', 'noopener,noreferrer',
              )}>Enviar ao cliente pelo WhatsApp</button>
              <button type="button" onClick={() => void copiar(linkCliente)}>Copiar</button>
            </div>
            <p>Este endereço aparece só agora. Se sair desta tela, crie outro.</p>
          </div>}
          <details className={styles.gerenciarAcesso}>
            <summary>Gerenciar acesso</summary>
            {dados.clienteHabilitado && <button type="button" disabled={busy} onClick={() => setConfirmacao({
              titulo: 'Revogar acesso do cliente?',
              texto: 'O link de edição para de funcionar.',
              acao: 'Revogar acesso',
              confirmar: async () => { if (await executar({ acao: 'acesso', habilitado: false }, 'Acesso revogado.', true)) setLinkCliente(''); },
            })}>Revogar acesso</button>}
            {controlesLimites}
          </details>
        </details>)}
        <ConviteFamilias familias={dados.familias ?? []} publicado={dados.publicado && !dados.desatualizado} busy={busy} erro={erro} ui={ui} executar={executarFamilia} />
        <ConvitePresencas respostas={dados.respostas} contratados={dados.convidadosContratados ?? null} ui={ui} busy={busy} atualizar={() => void atualizarPresencas()} />
        <details className={ui.painel}><summary>Histórico do convite</summary><ul>{dados.historico.map((h, n) => <li key={n}>{new Date(h.criado_em).toLocaleString('pt-BR')} · {rotuloHistorico(h)}</li>)}</ul></details>
      </div>}
      {dados.laboratorioLocal && <details className={ui.painel}><summary>Histórico do convite</summary><ul>{dados.historico.map((h, n) => <li key={n}>{new Date(h.criado_em).toLocaleString('pt-BR')} · {rotuloHistorico(h)}</li>)}</ul></details>}
    </>}
    <dialog ref={dialogoConfirmacao} className={ui.dialogo} aria-labelledby="titulo-confirmacao" onClose={() => setConfirmacao(null)}>
      <h2 id="titulo-confirmacao">{confirmacao?.titulo}</h2>
      {confirmacao?.texto && <p>{confirmacao.texto}</p>}
      <div className={ui.acoes}>
        <button type="button" autoFocus onClick={() => setConfirmacao(null)}>Cancelar</button>
        <button type="button" className={ui.primario} disabled={busy} onClick={() => {
          const acao = confirmacao?.confirmar;
          setConfirmacao(null);
          void acao?.();
        }}>{confirmacao?.acao}</button>
      </div>
    </dialog>
    <dialog ref={dialogo} className={ui.dialogo} aria-labelledby="titulo-excluir-imagem" onCancel={e => { if (busy) e.preventDefault(); else setArteExcluir(null); }} onClose={() => setArteExcluir(null)}>
      <h2 id="titulo-excluir-imagem">Excluir imagem da galeria?</h2>
      <p>{dados?.laboratorioLocal ? 'A imagem será retirada da galeria local. O arquivo original permanece no laboratório para recuperação.' : 'O arquivo será excluído desta festa. Essa ação não pode ser desfeita e não devolve créditos de IA.'}</p>
      <p>Se a imagem estiver no convite publicado, remova ou substitua a imagem e publique antes de excluí-la.</p>
      {erro && <p className={ui.erro} role="alert">{erro}</p>}
      <div className={ui.acoes}><button type="button" autoFocus disabled={busy} onClick={() => setArteExcluir(null)}>Cancelar</button><button type="button" className={ui.excluir} disabled={busy} onClick={() => void excluirArte()}>{busy ? 'Excluindo…' : 'Confirmar exclusão'}</button></div>
    </dialog>
  </main>;
}

function SeletorArte<T extends string>({ nome, valor, desativado, mudar, opcoes, ui }: { nome: string; valor: T; desativado: boolean; mudar: (valor: T) => void; opcoes: readonly (readonly [T, string])[]; ui: Record<string, string> }) {
  const [aberto, setAberto] = useState(false);
  const raiz = useRef<HTMLDivElement>(null);
  const gatilho = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const fechar = (e: PointerEvent) => { if (!raiz.current?.contains(e.target as Node)) setAberto(false); };
    document.addEventListener('pointerdown', fechar);
    return () => document.removeEventListener('pointerdown', fechar);
  }, []);
  useEffect(() => { if (aberto) raiz.current?.querySelector<HTMLButtonElement>('[role="option"][aria-selected="true"]')?.focus(); }, [aberto]);
  return <div ref={raiz} className={ui.seletorArte} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setAberto(false); }} onKeyDown={e => {
    if (e.key === 'Escape') { e.preventDefault(); setAberto(false); gatilho.current?.focus(); }
    if (aberto && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      e.preventDefault(); const itens = Array.from(raiz.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []);
      const atual = itens.indexOf(document.activeElement as HTMLButtonElement);
      const proximo = e.key === 'Home' ? 0 : e.key === 'End' ? itens.length - 1 : (atual + (e.key === 'ArrowDown' ? 1 : -1) + itens.length) % itens.length;
      itens[proximo]?.focus();
    }
  }}>
    <button ref={gatilho} type="button" aria-label={nome} aria-haspopup="listbox" aria-expanded={aberto && !desativado} disabled={desativado} onClick={() => setAberto(!aberto)} onKeyDown={e => { if (['ArrowDown', 'ArrowUp'].includes(e.key)) { e.preventDefault(); setAberto(true); } }}>{opcoes.find(([id]) => id === valor)?.[1]}<span aria-hidden="true">⌄</span></button>
    {aberto && !desativado && <div className={ui.menuArte} role="listbox" aria-label={nome}>{opcoes.map(([id, titulo]) => <button key={id} type="button" role="option" aria-selected={id === valor} tabIndex={-1} onClick={() => { mudar(id); setAberto(false); gatilho.current?.focus(); }}>{titulo}</button>)}</div>}
  </div>;
}
