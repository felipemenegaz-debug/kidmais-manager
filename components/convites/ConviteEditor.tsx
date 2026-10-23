'use client';
// As imagens privadas já são normalizadas pelo servidor; não usar cache público do otimizador Next.
/* eslint-disable @next/next/no-img-element */
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { adminFetch } from '@/lib/http/admin-fetch';
import { temas, type Conteudo } from '@/lib/convites/domain';
import { baseNeutra, modeloBiblioteca, modeloComFoto, modelosBiblioteca } from '@/lib/convites/modelos';
import ConviteArte, { baixarConvite } from './ConviteArte';
import PromptComCorretor from './PromptComCorretor';
import ConviteVisual from './ConviteVisual';
import ConvitePresencas from './ConvitePresencas';
import ConviteFamilias, { type ResultadoFamilia } from './ConviteFamilias';
import ConviteAutorizacaoIA, { ConfirmacaoImagensIA, type AutorizacaoIATela } from './ConviteAutorizacaoIA';
import type { ComandoFamilia, Familia } from '@/lib/convites/familias-domain';
import { extrairPaleta, visualPadrao } from '@/lib/convites/visual';
import styles from './convites.module.css';
import adminStyles from './editor-admin.module.css';
import { modelosAcervo, sugestaoAcervo } from '@/lib/convites/acervo';
import { aplicarModoArteLocal, selecionarArte } from './arte-local';
import { conferirPrompt, alinharPrompt } from '@/lib/convites/conferencia-prompt';
type Arte = { id: string; url: string; origem: string; completo?: boolean };
// Situação simples de um pedido de geração; pendências técnicas ficam com o operador da plataforma.
type SituacaoGeracao = { chave: string; estado: 'EM_ANDAMENTO' | 'CONCLUIDA' | 'VERIFICANDO' | 'NAO_INICIADA' | 'ENCERRADA' | 'DEVOLVIDA'; arteId?: string | null; completo?: boolean; acompanhando?: boolean };
const MENSAGEM_VERIFICANDO = 'Estamos verificando sua geração. Você não precisa tentar novamente.';
const ROTULOS_HISTORICO: Record<string, string> = { IA_RESERVADA: 'geração de arte solicitada', IA_CONCLUIDA: 'arte gerada', IA_EM_VERIFICACAO: 'geração em verificação',
  IA_NAO_INICIADA: 'geração não iniciada; crédito devolvido', IA_VERIFICACAO_CONCLUIDA: 'verificação da geração concluída',
  AUTORIZACAO_IA_REGISTRADA: 'autorização de IA do responsável registrada', AUTORIZACAO_IA_REVOGADA: 'autorização de IA revogada' };
const rotuloHistorico = (h: { acao: string; ator: string }) => `${h.ator === 'CLIENTE' ? 'Cliente' : h.ator === 'PLATAFORMA' ? 'Kidmais' : 'Buffet'} · ${ROTULOS_HISTORICO[h.acao] ?? h.acao.toLowerCase().replaceAll('_', ' ')}`;
const MENSAGEM_GERANDO = 'Gerando sua arte. Você pode aguardar nesta tela; não é preciso clicar de novo.';
// Resumo curto da assinatura do pedido (pode conter a foto) para lembrar a chave nesta aba sem guardar o conteúdo.
function resumoPedido(texto: string) { let h = 0x811c9dc5; for (let i = 0; i < texto.length; i++) { h ^= texto.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(16) + ':' + texto.length; }
type Dados = { laboratorioLocal?: boolean; conteudo: Conteudo; revisao: number; publicado: boolean; desatualizado: boolean; linkPublico: string; clienteHabilitado: boolean; convidadosContratados?: number | null; familias?: Familia[];
  disponiveis: number; iaDisponivel: boolean; completoDisponivel?: boolean; autorizacaoIA?: AutorizacaoIATela | null; geracaoIncerta?: boolean; geracaoEmAndamento?: string | null; id?: string; cotas: { festa: number; festaUsado: number; cliente: number; clienteUsado: number; empresa?: number; empresaUsado?: number };
  creditos?: { motor: 'LEGADO' } | { motor: 'CREDITOS'; disponivel: number; reservado: number; consumoAtivo: boolean } | null;
  geradoresLocais?: { id: string; nome: string; disponivel: boolean; pago: boolean }[];
  trabalhosLocais?: { id: string; estado: string; tipo: string; criadoEm: string; erro?: string }[];
  artes: Arte[]; respostas: { nome: string; presenca: boolean; adultos: number; criancas: number }[]; historico: { acao: string; ator: string; criado_em: string }[] };
// Biblioteca de molduras temporariamente desativada no editor; modelos e convites existentes continuam renderizando.
const MOLDURAS_NO_EDITOR = false;
const campos = [['nome', 'Nome do aniversariante'], ['idade', 'Idade ou celebração'], ['data', 'Data'], ['horario', 'Horário'], ['local', 'Local da festa'], ['endereco', 'Endereço']] as const;
export default function ConviteEditor({ festaId }: { festaId?: string }) {
  const admin = !!festaId;
  const ui = admin ? { ...styles, ...adminStyles } : styles;
  const [dados, setDados] = useState<Dados | null>(null), [conteudoBase, setConteudo] = useState<Conteudo | null>(null);
  // Convites completos (textos na imagem) abrem em modo "completa"; modos já salvos nunca são rebaixados ao carregar.
  const conteudo = conteudoBase ? aplicarModoArteLocal(conteudoBase, dados?.artes.find(a => a.id === conteudoBase.arteId), !!dados?.laboratorioLocal) : null;
  const [carregando, setCarregando] = useState(true), [busy, setBusy] = useState(false), [erro, setErro] = useState(''), [aviso, setAviso] = useState('');
  const [prompt, setPrompt] = useState(''), [referencias, setReferencias] = useState<string[]>([]), [linkCliente, setLinkCliente] = useState('');
  const [preparado, setPreparado] = useState<{ pedido: string; tema: string; promptArte: string } | null>(null);
  const [etapaLocal, setEtapaLocal] = useState(''), [jobLocal, setJobLocal] = useState('');
  const [, setRelatorioLocal] = useState('');
  const [geradorLocal, setGeradorLocal] = useState('openai');
  const [conviteCompleto, setConviteCompleto] = useState(true);
  const [qualidade, setQualidade] = useState('xhigh');
  const [estilo, setEstilo] = useState('cartoon3d');
  const [avatarPronto, setAvatarPronto] = useState(false);
  const [foto, setFoto] = useState(''), [autorizacaoFoto, setAutorizacaoFoto] = useState(false);
  const [conflitoPrompt, setConflitoPrompt] = useState(false);
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
  const painelIA = useRef<HTMLElement>(null);
  const galeriaRef = useRef<HTMLDetailsElement>(null);
  // Alternativa sem IA: abre o envio de arte própria (nada vai a provedores de IA).
  function semIA() {
    if (!galeriaRef.current) return;
    galeriaRef.current.open = true;
    galeriaRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  function abrirIA() {
    if (!painelIA.current) return;
    painelIA.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    painelIA.current.querySelector('textarea')?.focus({ preventScroll: true });
  }
  useEffect(() => { if (arteExcluir) dialogo.current?.showModal(); else dialogo.current?.close(); }, [arteExcluir]);
  const token = useRef(''), pedido = useRef<{ assinatura: string; chave: string; seed?: number } | null>(null);
  const endpoint = admin ? `/api/admin/convites?festaId=${festaId}` : '/api/convites/cliente';
  const api = useCallback(async (body?: object, consulta?: string) => {
    const init: RequestInit = { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(!admin ? { Authorization: `Bearer ${token.current}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), cache: 'no-store' };
    const url = consulta ? `${endpoint}${admin ? '&' : '?'}${consulta}` : endpoint;
    const r = await (admin ? adminFetch(url, init) : fetch(url, init));
    const j = await r.json(); if (!r.ok) throw Object.assign(new Error(j.erro || 'Não foi possível concluir.'), { status: r.status }); return j.data;
  }, [admin, endpoint]);
  const carregar = useCallback(async (criar = false, preservar = false) => {
    const d = await api(criar ? { acao: 'criar' } : undefined) as Dados;
    setDados(d); if (!preservar) setConteudo(d.conteudo); setCotaFesta(d.cotas.festa); setCotaCliente(d.cotas.cliente);
  }, [api, setCotaFesta, setCotaCliente]);
  useEffect(() => {
    let ativo = true;
    token.current = window.location.hash.slice(1);
    // Token só no fragmento e memória desta aba; nunca em query string ou armazenamento persistente.
    void Promise.resolve().then(async () => { if (ativo) { try { await carregar(); } catch (e) { if (ativo) setErro((e as Error).message); } finally { if (ativo) setCarregando(false); } } });
    return () => { ativo = false; };
  }, [carregar]);
  const alterado = !!dados && !!conteudo && JSON.stringify(conteudo) !== JSON.stringify(dados.conteudo);
  // Convite completo (arte + textos numa chamada): no produto, quando o servidor tem o provedor configurado.
  // Desligar a IA bloqueia o envio, mas mantém os controles do convite completo para comparação.
  const completoAtivo = dados?.laboratorioLocal ? conviteCompleto && geradorLocal === 'openai' : !!dados?.completoDisponivel || dados?.iaDisponivel === false;
  // 088: sem autorização vigente do responsável, o botão fica desabilitado (o servidor também recusa).
  const autorizacaoIA = dados?.laboratorioLocal ? null : dados?.autorizacaoIA ?? null;
  // P2-3: a fotografia e as imagens da galeria são confirmadas a cada geração, só depois de escolhidas (autorizacaoFoto).
  const imagensSelecionadas = !!foto || (!completoAtivo && referencias.length > 0);
  const fotoLiberada = autorizacaoFoto;
  const faltaAutorizacao = !!autorizacaoIA && !autorizacaoIA.vigente;
  const imagensSemAutorizacao = !dados?.laboratorioLocal && imagensSelecionadas && !autorizacaoFoto;
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
      const r = await executar({ acao: 'upload', imagem }, 'Arte enviada. Salve ou publique para aplicar.', true);
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
  async function gerar(avatarOnly = false) {
    const completo = completoAtivo;
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
    const chave = pedido.current.chave, pronta = completo ? 'Convite pronto. Confira a escrita de todos os textos e dados antes de publicar.' : 'Confira a arte e publique quando estiver pronta.';
    guardarPedido(pedido.current);
    // Uso único: a confirmação das imagens vale só para este pedido; a próxima geração pede de novo.
    if (!dados?.laboratorioLocal) setAutorizacaoFoto(false);
    setBusy(true); setErro(''); setAviso(MENSAGEM_GERANDO);
    let r: SituacaoGeracao;
    try { r = await api(comando) as SituacaoGeracao; }
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
  async function excluirArte() {
    if (!arteExcluir || !dados) return;
    const id = arteExcluir.id;
    const r = await executar({ acao: 'excluir_arte', arteId: id, revisao: dados.revisao }, 'Imagem excluída da galeria. As demais alterações no editor foram preservadas.', true);
    if (r) {
      setConteudo(c => c?.arteId === id ? { ...c, arteId: null } : c);
      setReferencias(refs => refs.filter(ref => ref !== id));
      setArteExcluir(null);
    }
  }
  const arte = dados?.artes.find(a => a.id === conteudo?.arteId)?.url;
  const modelosFiltrados = modelosBiblioteca.filter(id => (dados?.laboratorioLocal || !(modelosAcervo as readonly string[]).includes(id)) && (categoriaModelo === 'todos' || (categoriaModelo === 'abertos' ? (modelosAcervo as readonly string[]).includes(id) : categoriaModelo === 'fotos' ? modeloComFoto(id) : categoriaModelo === 'neutros' ? baseNeutra(id) : !baseNeutra(id) && !modeloComFoto(id))));
  const totalPaginas = Math.max(1, Math.ceil(modelosFiltrados.length / 9));
  const paginaAtual = Math.min(paginaModelo, totalPaginas);
  const modelosDaPagina = modelosFiltrados.slice((paginaAtual - 1) * 9, paginaAtual * 9);
  const conferencia = conteudo ? conferirPrompt(prompt, conteudo) : null;
  const tamanhoPaginaArte = colunasGaleria * 3;
  const paginasArte = Math.max(1, Math.ceil((dados?.artes.length ?? 0) / tamanhoPaginaArte));
  const paginaArteAtual = Math.min(paginaArte, paginasArte);
  const inicioArte = (paginaArteAtual - 1) * tamanhoPaginaArte;
  const artesVisiveis = dados?.artes.slice(inicioArte, inicioArte + tamanhoPaginaArte);
  const galeriaArtes = dados && conteudo && dados.artes.length > 0 && <><p>Imagens da festa</p><div className={ui.galeria}>{artesVisiveis?.map((a, indice) => { const n = indice + inicioArte; return <div key={a.id} className={ui.arteItem}><button className={ui.arteSelecionar} type="button" aria-label={`Selecionar imagem ${n + 1}`} aria-pressed={conteudo.arteId === a.id} onClick={() => setConteudo(c => c ? selecionarArte(c, a.id, !!a.completo) : c)}><img src={a.url} alt={`Imagem ${n + 1} da festa`} /><span>{conteudo.arteId === a.id ? 'Selecionada' : 'Usar imagem'}</span></button><button type="button" disabled={busy} className={ui.excluir} aria-label={`Excluir imagem ${n + 1}`} onClick={() => { setErro(''); setArteExcluir(a); }}>Excluir imagem</button></div>; })}</div>{paginasArte > 1 && <nav className={ui.paginacaoArtes} aria-label="Páginas das imagens anteriores"><button type="button" disabled={busy || paginaArteAtual === 1} onClick={() => setPaginaArte(paginaArteAtual - 1)}>← Anterior</button><span aria-live="polite">Página {paginaArteAtual} de {paginasArte}</span><button type="button" disabled={busy || paginaArteAtual === paginasArte} onClick={() => setPaginaArte(paginaArteAtual + 1)}>Próxima →</button></nav>}{conteudo.arteId && <button type="button" className={ui.linkBotao} onClick={() => { campo('arteId', null); setAviso('Imagem removida da composição. Salve o rascunho ou publique para aplicar.'); }}>Remover imagem do convite</button>}<small>{dados.laboratorioLocal ? 'Remover do convite mantém a imagem na galeria. Excluir retira da galeria local e preserva o arquivo original.' : 'Remover do convite mantém o arquivo na galeria. Excluir imagem apaga o arquivo desta festa.'}</small></>;
  const conteudoGeracao = dados && conteudo ? (<><h3>Como você imagina a arte?</h3><p id="orientacao-arte">Diga o tema, as cores e o que gostaria de ver na cena.</p><p><small>Tema · Cores · Estilo · Elementos da cena</small></p><PromptComCorretor habilitado corrigir={texto => { setPrompt(texto); setConflitoPrompt(false); }} lang="pt-BR" spellCheck autoCorrect="on" autoCapitalize="sentences" title="Clique com o botão direito sobre uma palavra para ver sugestões de escrita." aria-label="Descreva a arte do convite" aria-describedby="orientacao-arte" rows={4} maxLength={3000} value={prompt} onChange={e => { setPrompt(e.target.value); setConflitoPrompt(false); }} placeholder="Uma aventura espacial em cartoon 3D, com uma pequena astronauta, planetas e estrelas. Cores azul, lilás e dourado. Cena alegre e delicada." disabled={busy} />
          {completoAtivo && <>
            <details className={ui.fotoReferencia}><summary>Foto do aniversariante · opcional</summary>
              <p>Use uma foto com o rosto visível. Quando o estilo escolhido tem referência aprovada, ela é incluída automaticamente na mesma geração. A semelhança pode variar.</p>
              <input hidden ref={fotoArquivo} type="file" accept="image/png,image/jpeg,image/webp" onChange={e => { setAvatarPronto(false); void lerFoto(e.target.files?.[0]); e.target.value = ''; }} />
              <input hidden ref={fotoCamera} type="file" accept="image/*" capture="user" onChange={e => { setAvatarPronto(false); void lerFoto(e.target.files?.[0]); e.target.value = ''; }} />
              <div className={ui.acoes}><button type="button" disabled={busy} onClick={() => fotoArquivo.current?.click()}>Escolher foto</button><button type="button" disabled={busy} onClick={() => fotoCamera.current?.click()}>Tirar foto</button></div>
              {foto && <><img className={ui.miniaturaFoto} src={foto} alt="Foto de referência do aniversariante" /><button type="button" disabled={busy} onClick={() => { setFoto(''); setAvatarPronto(false); setAutorizacaoFoto(false); }}>Remover foto</button>{dados.laboratorioLocal ? <label className={ui.check}><input type="checkbox" checked={autorizacaoFoto} disabled={busy} onChange={e => setAutorizacaoFoto(e.target.checked)} />Tenho autorização para enviar esta foto à OpenAI; sou responsável ou tenho autorização do responsável.</label> : null}</>}
              {dados.laboratorioLocal && foto && !avatarPronto && <button type="button" disabled={busy || !autorizacaoFoto || !['cartoon3d', 'cartoon2d'].includes(estilo)} onClick={() => void gerar(true)}>1. Criar avatar cartoon · 1 chamada paga</button>}
              {avatarPronto && <p role="status">Avatar selecionado como referência. Confira antes de gerar o convite.</p>}
              {dados.laboratorioLocal && <small>Gere o convite diretamente para usar uma chamada. Criar avatar antes é um teste opcional e custa uma chamada adicional.</small>}
              <small>PNG, JPEG ou WebP, até 5 MB. A foto não fica salva no convite; ela é enviada {dados.laboratorioLocal ? 'à OpenAI' : autorizacaoIA ? `ao provedor indicado (${autorizacaoIA.provedorNome})` : 'ao provedor de IA'} somente ao gerar e com a autorização da fotografia.</small>
            </details>
            {conflitoPrompt && conferencia && <section className={ui.conferenciaPrompt} role="alert"><strong>Confira o nome e a idade antes de gerar</strong><p>Na festa: {conteudo.nome || 'sem nome'} · {conteudo.idade || 'sem idade'}. No pedido: {conferencia.nomes.join(', ') || 'nome não informado'} · {conferencia.idades.join(', ') || 'idade não informada'}.</p><div className={ui.acoes}><button type="button" onClick={() => { setPrompt(alinharPrompt(prompt, conteudo)); setConflitoPrompt(false); }}>Usar dados da festa</button><button type="button" disabled={conferencia.ambiguo} onClick={() => { setConteudo({ ...conteudo, ...(conferencia.nomes[0] ? { nome: conferencia.nomes[0] } : {}), ...(conferencia.idades[0] ? { idade: `${conferencia.idades[0]} anos` } : {}) }); setConflitoPrompt(false); }}>Usar dados do pedido</button></div><small>Depois da escolha, confira os campos e clique em gerar. Nenhum teste foi consumido.</small></section>}
          </>}
          {autorizacaoIA && <ConviteAutorizacaoIA ia={autorizacaoIA} busy={busy || !!acompanhando} ui={ui} semIA={semIA} executar={(body, mensagem) => executar(body, mensagem, true)} />}
          {autorizacaoIA && !autorizacaoIA.indisponivel && imagensSelecionadas && <ConfirmacaoImagensIA ia={autorizacaoIA} marcado={autorizacaoFoto} mudar={setAutorizacaoFoto} busy={busy || !!acompanhando} ui={ui} />}
          <div className={ui.controlesIA}>
            {completoAtivo && <div className={ui.qualidade}><span>Estilo</span><SeletorArte nome="Estilo da arte" valor={estilo} desativado={busy} mudar={setEstilo} opcoes={[["pedido", "Conforme pedido"], ["cartoon3d", "Cartoon 3D"], ["cartoon2d", "Desenho 2D"], ["realista", "Realista"]]} ui={ui} /><small>Sem estilo no pedido, usamos cartoon 3D.</small></div>}
            {completoAtivo && <div className={ui.qualidade}><span>Qualidade</span><SeletorArte nome="Qualidade da imagem" valor={qualidade} desativado={busy || !!acompanhando} mudar={setQualidade} opcoes={[["high", "Alta"], ["xhigh", "Muito alta"], ["max", "Máxima"]]} ui={ui} /><small>Maior qualidade pode aumentar o custo e o tempo.</small></div>}
            <button type="button" className={ui.primario} disabled={busy || !!acompanhando || !dados.iaDisponivel || !!dados.geracaoIncerta || faltaAutorizacao || imagensSemAutorizacao || (dados.laboratorioLocal && !!dados.geradoresLocais && !dados.geradoresLocais.find(g => g.id === geradorLocal)?.disponivel) || (!dados.laboratorioLocal && dados.disponiveis < 1) || prompt.trim().length < 5} onClick={() => void gerar()}>{busy ? 'Processando…' : dados.laboratorioLocal ? (conviteCompleto && geradorLocal === 'openai' ? 'Gerar convite completo' : 'Gerar imagem') : completoAtivo ? 'Gerar convite completo · 1 crédito' : 'Gerar arte · 1 crédito'}</button>
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
          {!dados.laboratorioLocal && !completoAtivo && !!dados.artes.length && <><p>Referências: escolha até duas artes anexadas.</p><div className={ui.artes}>{dados.artes.map(a => <button key={a.id} disabled={busy || (!referencias.includes(a.id) && referencias.length >= 2)} type="button" aria-label="Usar arte como referência" aria-pressed={referencias.includes(a.id)} onClick={() => { setAutorizacaoFoto(false); setReferencias(refs => refs.includes(a.id) ? refs.filter(id => id !== a.id) : [...refs, a.id]); }}><img src={a.url} alt="Referência" /></button>)}</div></>}
          {faltaAutorizacao && !autorizacaoIA?.indisponivel && <p role="status"><small>Registre a autorização do responsável legal para gerar com IA, ou use uma arte própria.</small></p>}
          {!faltaAutorizacao && imagensSemAutorizacao && <p role="status"><small>Confirme o envio da fotografia e das imagens da galeria selecionadas, ou remova-as, para gerar.</small></p>}
          <small>{dados.laboratorioLocal ? conteudo.visual?.modo === 'completa' ? 'Textos incorporados na imagem: editar os campos não altera a arte pronta.' : 'A moldura e os dados da festa são montados pelo editor.' : dados.geracaoIncerta ? MENSAGEM_VERIFICANDO : acompanhando ? MENSAGEM_GERANDO : !dados.iaDisponivel ? 'O buffet ainda não habilitou a IA. Você pode enviar sua própria arte.' : completoAtivo ? 'Uma chamada por convite: arte e textos da festa juntos. Cada geração usa 1 crédito, sem repetição automática. Confira a escrita antes de publicar.' : 'Cada nova geração ou edição por IA usa 1 crédito. Downloads não usam créditos.'}</small>
        </>) : null;
  const painelGeracao = <section ref={painelIA} className={ui.painel} aria-labelledby="titulo-criar-arte"><h2 id="titulo-criar-arte">Crie uma arte com IA</h2>{conteudoGeracao}</section>;
  return <main className={ui.editor} data-editor={admin ? 'buffet' : 'cliente'}>
    <header className={ui.cabecalho}><div><p className={ui.sobretitulo}>{admin ? 'FESTAS · CONVITE VIRTUAL' : 'KIDMAIS · CONVITES'}</p><h1>{admin ? 'Convite da festa' : <>Uma festa começa<br />com um convite.</>}</h1><p>{admin ? 'Personalize o convite, compartilhe com o cliente e acompanhe as confirmações.' : 'Escolha um tema, dê seu toque e compartilhe esse momento.'}</p></div>{admin && <div className={ui.acoesCabecalho}>{!dados?.laboratorioLocal && <button type="button" className={ui.primario} disabled={busy || !dados} onClick={abrirIA}>Crie uma arte com IA</button>}<Link className={ui.voltar} href={`/admin/festas/${festaId}`}>← Voltar à festa</Link></div>}</header>
    {erro && <p className={ui.erro} role="alert">{erro}</p>}{aviso && <p className={ui.aviso} role="status">{aviso}</p>}
    {carregando ? <p>Preparando seu convite…</p> : !dados || !conteudo ? <section className={ui.painel}><h2>Seu convite começa aqui</h2><p>Modelos prontos e arte própria não consomem créditos de IA.</p>{admin && <button disabled={busy} className={ui.primario} onClick={() => { setBusy(true); void carregar(true).then(() => setErro('')).catch(e => setErro(e.message)).finally(() => setBusy(false)); }}>Criar convite da festa</button>}</section> : <>
      <div className={ui.barra}><span>{dados.publicado ? '● Publicado' : '○ Rascunho'}{alterado ? ' · Alterações não salvas' : ''}</span><span>{dados.laboratorioLocal ? 'Teste local' : <><strong>{dados.disponiveis}</strong> créditos de imagem disponíveis</>}</span></div>
      {dados.desatualizado && <p className={ui.erro}>A contratação foi atualizada e o link público está suspenso. Confira data, horário e local e publique novamente.</p>}
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
          {!(dados.laboratorioLocal && conteudo.visual?.modo === 'completa') && <ConviteVisual conteudo={conteudo} arte={arte} ui={ui} busy={busy} mostrarPosicao={!dados.laboratorioLocal} mudar={v => campo('visual', v)} extrair={() => void extrairCores()} />}</details>
        </fieldset>}
        <fieldset disabled={busy} className={`${ui.painel} ${ui.dadosCompactos}`} aria-label="Dados da festa">
          <h2 className={ui.tituloEtapa}>Dados da festa</h2>
          <div className={ui.campos}>
            {campos.map(([k, label]) => (
              <label key={k}>
                {label}
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
          <small>{conteudo.visual?.modo === 'completa' ? 'Os textos já estão na arte: alterações aqui valem para a próxima geração e para a página do convite.' : 'Alterar os textos não consome créditos.'}</small>
        </fieldset>
      </div><aside className={`${ui.preview} ${ui.previewLocal}`}><p className={ui.sobretitulo}>É ASSIM QUE SEU CONVITE VAI FICAR</p><ConviteArte conteudo={conteudo} arte={arte} />
        {arte && conteudo.visual?.modo !== 'completa' && !modeloComFoto(conteudo.tema) && <div className={ui.posicaoImagem}><div className={ui.seletorCriacao} role="group" aria-label="Posição da imagem">{(['fundo', 'topo'] as const).map(posicao => <button key={posicao} type="button" disabled={busy} aria-pressed={(conteudo.visual?.posicao ?? 'fundo') === posicao} onClick={() => campo('visual', { ...visualPadrao, ...conteudo.visual, modo: 'modelo', posicao })}>{posicao === 'fundo' ? 'Imagem como fundo' : 'Imagem no topo'}</button>)}</div></div>}
        <div className={ui.acoes}><button disabled={busy} onClick={() => void baixarConvite(conteudo, arte).catch(() => setErro('Não foi possível baixar. Tente novamente.'))}>Baixar imagem</button></div>
        {painelGeracao}<div className={ui.acoes}><button disabled={busy} onClick={() => void executar({ acao: 'salvar', revisao: dados.revisao, conteudo }, 'Rascunho salvo.')}>Salvar rascunho</button>{!dados.laboratorioLocal && <button disabled={busy} className={ui.primario} onClick={() => void executar({ acao: 'publicar', revisao: dados.revisao, conteudo }, 'Convite publicado. Agora você pode compartilhar!')}>Publicar convite</button>}</div>
        {dados.publicado && <div className={ui.painel}><a href={dados.linkPublico} target="_blank" rel="noreferrer">Abrir convite publicado ↗</a><div className={ui.acoes}><button onClick={() => void copiar(dados.linkPublico)}>Copiar link público</button><button onClick={() => { const url = new URL(dados.linkPublico, window.location.origin).href; window.open(`https://wa.me/?text=${encodeURIComponent(`Você está convidado! ${url}`)}`, '_blank', 'noopener,noreferrer'); }}>Compartilhar no WhatsApp</button><button disabled={busy} onClick={() => void executar({ acao: 'despublicar', revisao: dados.revisao }, 'Convite despublicado.', true)}>Despublicar</button></div></div>}
      </aside></div>
      {(dados.artes.length > 0 || !dados.laboratorioLocal) && <details ref={galeriaRef} className={`${ui.painel} ${ui.galeriaLocal}`}><summary>Imagens anteriores</summary><fieldset disabled={busy} className={ui.formulario}>{galeriaArtes}{!dados.laboratorioLocal && <label className={ui.upload}>{modeloComFoto(conteudo.tema) ? 'Adicionar sua foto' : 'Usar uma arte própria'}<input type="file" accept="image/png,image/jpeg,image/webp" onChange={e => { void upload(e.target.files?.[0]); e.target.value = ''; }} /><small>PNG, JPEG ou WebP · até 5 MB · sem créditos de IA</small></label>}</fieldset></details>}
      {!dados.laboratorioLocal && <div className={ui.colunaInferior}>
        {admin && <details className={ui.painel}><summary>Acesso do cliente e limites</summary><p>{dados.clienteHabilitado ? 'O cliente já pode criar o convite.' : 'Libere um link exclusivo para o cliente criar o convite.'}</p><button disabled={busy} onClick={async () => { const r = await executar({ acao: 'acesso', habilitado: true }, 'Novo acesso criado. O link anterior foi revogado.', true); if (r?.linkCliente) setLinkCliente(new URL(r.linkCliente, window.location.origin).href); }}>Gerar novo link do cliente</button>{dados.clienteHabilitado && <button disabled={busy} onClick={async () => { const r = await executar({ acao: 'acesso', habilitado: false }, 'Acesso revogado.', true); if (r) setLinkCliente(''); }}>Revogar acesso</button>}
          {linkCliente && <label>Link exclusivo de edição<input readOnly value={linkCliente} onFocus={e => e.target.select()} /><button onClick={() => void copiar(linkCliente)}>Copiar link do cliente</button></label>}
          {dados.creditos?.motor === 'CREDITOS'
            ? <p data-creditos-empresa>Créditos da empresa: {dados.creditos.disponivel} disponíveis{dados.creditos.reservado > 0 ? ` (${dados.creditos.reservado} reservados em geração)` : ''}{dados.creditos.consumoAtivo ? '' : ' · geração com créditos em manutenção'}. <Link href="/admin/configuracoes/creditos">Ver créditos</Link>. A festa já usou {dados.cotas.festaUsado}, sendo {dados.cotas.clienteUsado} pelo cliente.</p>
            : <p>Franquia mensal: {dados.cotas.empresaUsado ?? 0} de {dados.cotas.empresa ?? 0} usados. A festa já usou {dados.cotas.festaUsado}, sendo {dados.cotas.clienteUsado} pelo cliente.</p>}
          <div className={ui.campos}><label>Limite total da festa<input type="number" min={dados.cotas.festaUsado} max={100} value={cotaFesta} onChange={e => setCotaFesta(Number(e.target.value))} /></label><label>Limite do cliente<input type="number" min={dados.cotas.clienteUsado} max={cotaFesta} value={cotaCliente} onChange={e => setCotaCliente(Number(e.target.value))} /></label></div><button disabled={busy} onClick={() => void executar({ acao: 'cotas', festa: cotaFesta, cliente: cotaCliente }, 'Limites atualizados.', true)}>Aplicar limites</button><small>Os limites da festa são compartilhados. Somente a gestão pode aumentá-los. O saldo mensal da empresa continua sendo o teto.</small>
        </details>}
        <ConviteFamilias familias={dados.familias ?? []} publicado={dados.publicado && !dados.desatualizado} busy={busy} erro={erro} ui={ui} executar={executarFamilia} />
        <ConvitePresencas respostas={dados.respostas} contratados={dados.convidadosContratados ?? null} ui={ui} busy={busy} atualizar={() => void atualizarPresencas()} />
        <details className={ui.painel}><summary>Histórico do convite</summary><ul>{dados.historico.map((h, n) => <li key={n}>{new Date(h.criado_em).toLocaleString('pt-BR')} · {rotuloHistorico(h)}</li>)}</ul></details>
      </div>}
      {dados.laboratorioLocal && <details className={ui.painel}><summary>Histórico do convite</summary><ul>{dados.historico.map((h, n) => <li key={n}>{new Date(h.criado_em).toLocaleString('pt-BR')} · {rotuloHistorico(h)}</li>)}</ul></details>}
    </>}
    <dialog ref={dialogo} className={ui.dialogo} aria-labelledby="titulo-excluir-imagem" onCancel={e => { if (busy) e.preventDefault(); else setArteExcluir(null); }} onClose={() => setArteExcluir(null)}>
      <h2 id="titulo-excluir-imagem">Excluir imagem da galeria?</h2>
      <p>{dados?.laboratorioLocal ? 'A imagem será retirada da galeria local. O arquivo original permanece no laboratório para recuperação.' : 'O arquivo será excluído desta festa. Essa ação não pode ser desfeita e não devolve créditos de IA.'}</p>
      <p>Se a imagem estiver no convite publicado, remova ou substitua a imagem e publique antes de excluí-la.</p>
      {erro && <p className={ui.erro} role="alert">{erro}</p>}
      <div className={ui.acoes}><button type="button" autoFocus disabled={busy} onClick={() => setArteExcluir(null)}>Cancelar</button><button type="button" className={ui.excluir} disabled={busy} onClick={() => void excluirArte()}>{busy ? 'Excluindo…' : 'Confirmar exclusão'}</button></div>
    </dialog>
  </main>;
}

function SeletorArte({ nome, valor, desativado, mudar, opcoes, ui }: { nome: string; valor: string; desativado: boolean; mudar: (valor: string) => void; opcoes: string[][]; ui: Record<string, string> }) {
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
