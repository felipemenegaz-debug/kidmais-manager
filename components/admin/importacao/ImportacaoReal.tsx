'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { adminFetch } from '@/lib/http/admin-fetch';
import type { CampoExtraido, EstadoCampo } from '@/lib/importacao-contrato/modelo';
import { decidirOperacao, type RascunhoPublico } from '@/components/admin/inteligencia/cliente-inteligencia';
import { PreviewAcao } from '@/components/admin/inteligencia/AcaoKidmais';
import { ACEITE_ARQUIVO, formatoArquivo, tamanhoLegivel } from '@/lib/importacao-contrato/revisao';
import { agirNaImportacao, enviarContrato, type AcaoImportacao, type ImportacaoPublica, type PlanoPublico, type RespostaImportacao } from './cliente-importacao';
import styles from './importacao.module.css';
import real from './importacao-real.module.css';

/**
 * Importação de contrato histórico — modo real.
 * O arquivo é enviado ao servidor, fica privado e é lido lá. Nada vai para o cadastro até o clique em
 * "Confirmar" no preview do Human Gate; pagamentos entram só como previstos.
 */
type Etapa =
  | { etapa: 'upload'; erro: string | null }
  | { etapa: 'lendo'; nome: string }
  | { etapa: 'revisao'; importacao: ImportacaoPublica; plano: PlanoPublico | null; avisos: string[]; ocupado: boolean; erro: string | null }
  | { etapa: 'confirmacao'; importacao: ImportacaoPublica; plano: PlanoPublico | null; rascunho: RascunhoPublico; decidindo: boolean; erro: string | null }
  | { etapa: 'cancelada' }
  /** `contratoDestino`: o contrato importado em Contratos (registro criado); `destino`: o cliente vinculado. */
  | { etapa: 'concluida'; mensagem: string; destino?: string; contratoDestino: string };

const PASSOS = ['Enviar', 'Ler', 'Revisar', 'Confirmar'] as const;
const ROTULO: Record<EstadoCampo | 'REVISADO', string> = { ENCONTRADO: 'Encontrado', PRECISA_REVISAO: 'Precisa revisão', NAO_ENCONTRADO: 'Não encontrado', REVISADO: 'Revisado' };
const AVISOS: Readonly<Record<string, string>> = {
  ENVIO_EXTERNO_NAO_AUTORIZADO: 'Leitura feita só no servidor do Kidmais, por regras. Confira os campos com atenção.',
  SEM_TEXTO_NATIVO: 'O PDF não tem texto (parece escaneado). Preencha os campos na revisão.',
  SEM_VISAO_DISPONIVEL: 'Leitura automática de imagem indisponível. Preencha os campos na revisão.',
  DOCUMENTO_JA_ENVIADO: 'Este arquivo já tinha sido enviado. Continuamos de onde parou.',
};

function campos(i: ImportacaoPublica) {
  return i.extracao.secoes.flatMap((s) => s.campos);
}

export type EtapaImportacao = Etapa;

/** Registro criado pela confirmação: o contrato importado, consultado em Contratos pela URL. */
export const contratoImportadoUrl = (importacaoId: string) => `/admin/contratos?importacaoId=${importacaoId}`;

/** Reenvio e atualização de outra aba respeitam o estado terminal devolvido pelo servidor. */
function etapaDaResposta(dados: RespostaImportacao): Etapa {
  const i = dados.importacao;
  if (i.status === 'IMPORTADA') return { etapa: 'concluida', mensagem: 'Este contrato já foi importado.', destino: i.resultado?.destino, contratoDestino: contratoImportadoUrl(i.id) };
  if (i.status === 'DESCARTADA') return { etapa: 'cancelada' };
  return { etapa: 'revisao', importacao: i, plano: dados.plano ?? null, avisos: dados.avisos ?? [], ocupado: false, erro: null };
}

/** `vitrine`: estado inicial estático para /preview-ux (sem sessão e sem rede). */
export default function ImportacaoReal({ vitrine }: { vitrine?: Etapa } = {}) {
  const [estado, setEstado] = useState<Etapa>(vitrine ?? { etapa: 'upload', erro: null });
  const [editando, setEditando] = useState<{ id: string; valor: string } | null>(null);
  const [arrastando, setArrastando] = useState(false);
  const [cancelando, setCancelando] = useState(false);
  const dialogo = useRef<HTMLDialogElement>(null);
  const decidindoCancelamento = (estado.etapa === 'confirmacao' && estado.decidindo) || (estado.etapa === 'revisao' && estado.ocupado);
  useEffect(() => { if (cancelando) dialogo.current?.showModal(); else dialogo.current?.close(); }, [cancelando]);

  async function cancelarImportacao() {
    if ((estado.etapa === 'revisao' && estado.ocupado) || (estado.etapa === 'confirmacao' && estado.decidindo)) return;
    if (estado.etapa === 'revisao') setEstado({ ...estado, ocupado: true, erro: null });
    if (estado.etapa === 'confirmacao') {
      setEstado({ ...estado, decidindo: true, erro: null });
      const gate = await decidirOperacao(adminFetch, estado.rascunho, 'cancelar');
      if (gate.tipo !== 'ok') { setEstado({ ...estado, decidindo: false, erro: gate.mensagem }); setCancelando(false); return; }
    }
    if (estado.etapa !== 'revisao' && estado.etapa !== 'confirmacao') return;
    const resposta = await agirNaImportacao(adminFetch, estado.importacao, { acao: 'descartar' });
    if (!resposta.ok) {
      setEstado({ etapa: 'revisao', importacao: estado.importacao, plano: estado.plano, avisos: [], ocupado: false, erro: resposta.mensagem });
    } else { setEstado({ etapa: 'upload', erro: null }); setEditando(null); }
    setCancelando(false);
  }

  async function enviar(arquivo: File | undefined) {
    if (!arquivo) return;
    setEstado({ etapa: 'lendo', nome: arquivo.name });
    const enviado = await enviarContrato(adminFetch, arquivo);
    if (!enviado.ok) { setEstado({ etapa: 'upload', erro: enviado.mensagem }); return; }
    setEditando(null);
    setEstado(etapaDaResposta(enviado.dados));
  }

  async function agir(acao: AcaoImportacao) {
    if (estado.etapa !== 'revisao' || estado.ocupado) return;
    setEstado({ ...estado, ocupado: true, erro: null });
    const r = await agirNaImportacao(adminFetch, estado.importacao, acao);
    if (!r.ok) {
      if (r.codigo === 'IMPORTACAO_ENCERRADA') {
        const atual = await agirNaImportacao(adminFetch, estado.importacao, { acao: 'ler' });
        if (atual.ok) { setEditando(null); setEstado(etapaDaResposta(atual.dados)); return; }
      }
      setEstado({ ...estado, ocupado: false, erro: r.mensagem }); return;
    }
    setEditando(null);
    if (acao.acao === 'descartar') { setEstado({ etapa: 'upload', erro: null }); return; }
    const rascunho = r.dados.gate?.tipo === 'preview' ? r.dados.gate.rascunho : undefined;
    if (rascunho) { setEstado({ etapa: 'confirmacao', importacao: r.dados.importacao, plano: r.dados.plano ?? null, rascunho, decidindo: false, erro: null }); return; }
    setEstado({ ...estado, importacao: r.dados.importacao, plano: r.dados.plano ?? estado.plano, ocupado: false, erro: null });
  }

  async function decidir(rascunho: RascunhoPublico, decisao: 'confirmar' | 'cancelar') {
    if (estado.etapa !== 'confirmacao' || estado.decidindo) return;
    setEstado({ ...estado, decidindo: true, erro: null });
    const r = await decidirOperacao(adminFetch, rascunho, decisao);
    if (r.tipo !== 'ok') { setEstado({ ...estado, decidindo: false, erro: r.mensagem }); return; }
    if (decisao === 'cancelar') { setEstado({ etapa: 'revisao', importacao: estado.importacao, plano: estado.plano, avisos: [], ocupado: false, erro: null }); return; }
    const resposta = r.resposta;
    if (resposta.tipo === 'resultado_acao') setEstado({ etapa: 'concluida', mensagem: resposta.mensagem, destino: resposta.destino, contratoDestino: contratoImportadoUrl(estado.importacao.id) });
    else setEstado({ ...estado, decidindo: false, erro: 'Resposta inesperada. Confira de novo: repetir a confirmação não duplica a importação.' });
  }

  const passo = estado.etapa === 'upload' ? 0 : estado.etapa === 'lendo' ? 1 : estado.etapa === 'revisao' ? 2 : 3;

  return <main className={styles.pagina}>
    <Link className={styles.voltar} href="/admin/contratos">← Contratos</Link>
    <header className={styles.topo}>
      <div className={styles.tituloLinha}><h1>Importar contrato antigo</h1></div>
      <p>Envie o contrato em PDF, JPG ou PNG. O Kidmais lê, você revisa e só depois confirma a importação.</p>
    </header>
    <ol className={styles.passos} aria-label="Etapas da importação">
      {PASSOS.map((p, i) => <li key={p} data-estado={i < passo ? 'feito' : i === passo ? 'atual' : 'pendente'} aria-current={i === passo ? 'step' : undefined}><span aria-hidden="true">{i + 1}</span>{p}</li>)}
    </ol>

    {estado.etapa === 'upload' && <section className={styles.painel} aria-labelledby="envio-real">
      <h2 id="envio-real" className={styles.oculto}>Enviar contrato</h2>
      <div className={styles.zona} data-arrastando={arrastando}
        onDragOver={(e) => { e.preventDefault(); setArrastando(true); }}
        onDragLeave={() => setArrastando(false)}
        onDrop={(e) => { e.preventDefault(); setArrastando(false); void enviar(e.dataTransfer?.files?.[0]); }}>
        <span className={styles.icone} aria-hidden="true">↥</span>
        <p className={styles.zonaTitulo}>Arraste o contrato para cá</p>
        <p className={styles.zonaDica}>PDF, JPG ou PNG</p>
        <label className={styles.selecionar}>
          Selecionar arquivo
          <input className={styles.oculto} type="file" accept={ACEITE_ARQUIVO} onChange={(e) => { void enviar(e.target.files?.[0]); e.target.value = ''; }} />
        </label>
        {estado.erro && <p className={styles.erro} role="alert">{estado.erro}</p>}
      </div>
      <p className={styles.garantia}>O arquivo fica guardado de forma privada nesta empresa. Nenhum cadastro é criado ou alterado sem a sua confirmação.</p>
    </section>}

    {estado.etapa === 'lendo' && <section className={styles.painel} aria-busy="true" aria-live="polite">
      <h2 className={styles.titulo}>Lendo o contrato</h2>
      <p className={styles.arquivo}><strong>{estado.nome}</strong></p>
      <div className={real.carregando}><span /><span /></div>
      <p className={styles.texto}>Extraindo o texto, conferindo CPF, datas e valores e localizando cada dado no documento…</p>
    </section>}

    {estado.etapa === 'revisao' && (() => {
      const lista = campos(estado.importacao);
      const revisados = estado.importacao.revisados;
      const contagem = { ENCONTRADO: 0, PRECISA_REVISAO: 0, NAO_ENCONTRADO: 0 };
      for (const c of lista) contagem[c.estado] += 1;
      const match = estado.plano?.match;
      return <div className={`${styles.revisao} ${real.revisao}`}>
        <div className={styles.principal}>
          <div className={styles.cabecalhoRevisao}>
            <div>
              <h2 className={styles.titulo}>Revisão</h2>
              <p className={styles.arquivo}>{estado.importacao.extracao.arquivo.nome} · {formatoArquivo(estado.importacao.extracao.arquivo)} · {tamanhoLegivel(estado.importacao.extracao.arquivo.tamanhoBytes)}</p>
            </div>
          </div>
          {estado.avisos.filter((a) => AVISOS[a]).map((a) => <p key={a} className={styles.aviso}>{AVISOS[a]}</p>)}
          <p className={styles.contagem}>
            <span data-estado="ENCONTRADO">{contagem.ENCONTRADO} encontrados</span>
            <span data-estado="PRECISA_REVISAO">{contagem.PRECISA_REVISAO} precisam revisão</span>
            <span data-estado="NAO_ENCONTRADO">{contagem.NAO_ENCONTRADO} não encontrados</span>
          </p>
          <div className={styles.secoes}>
            {estado.importacao.extracao.secoes.map((secao) => <section key={secao.id} className={styles.secao} aria-labelledby={`real-${secao.id}`}>
              <h3 id={`real-${secao.id}`}>{secao.titulo}</h3>
              {secao.nota && <p className={styles.nota}>{secao.nota}</p>}
              <dl className={styles.campos}>
                {secao.campos.map((campo) => <Campo key={campo.id} campo={campo} revisado={revisados.includes(campo.id)} ocupado={estado.ocupado}
                  editando={editando?.id === campo.id ? editando.valor : null}
                  onEditar={(valor) => setEditando(valor === null ? null : { id: campo.id, valor })}
                  onAgir={(acao) => void agir(acao)} />)}
              </dl>
            </section>)}
          </div>
        </div>

        <aside className={styles.gate} aria-labelledby="gate-real">
          <h2 id="gate-real">Confirmação humana</h2>
          {match && <div className={real.cliente}>
            <h3>Cliente</h3>
            <p>{match.motivo}</p>
            {match.estado === 'POSSIVEL_MATCH' && <div className={real.opcoes} role="radiogroup" aria-label="Escolha do cliente">
              {match.candidatos.map((c) => <button key={c.clienteId} type="button" role="radio" disabled={estado.ocupado}
                aria-checked={estado.importacao.decisaoCliente?.tipo === 'VINCULAR' && estado.importacao.decisaoCliente.clienteId === c.clienteId}
                onClick={() => void agir({ acao: 'cliente', decisao: { tipo: 'VINCULAR', clienteId: c.clienteId } })}>Vincular a {c.nome}</button>)}
              <button type="button" role="radio" disabled={estado.ocupado} aria-checked={estado.importacao.decisaoCliente?.tipo === 'CRIAR'}
                onClick={() => void agir({ acao: 'cliente', decisao: { tipo: 'CRIAR' } })}>Criar novo cliente</button>
            </div>}
          </div>}
          {estado.plano && <div className={styles.pendencias}>
            <h3>Pendências</h3>
            {estado.plano.bloqueios.length ? <ul>{estado.plano.bloqueios.map((b) => <li key={b}>{b}</li>)}</ul> : <p className={styles.ok}>Pronto para preparar a importação.</p>}
            {estado.plano.avisos.length > 0 && <ul className={styles.discreto}>{estado.plano.avisos.map((a) => <li key={a}>{a}</li>)}</ul>}
          </div>}
          {estado.erro && <p className={styles.erro} role="alert">{estado.erro}</p>}
          <button type="button" className={styles.primario} disabled={estado.ocupado || !estado.plano?.pronto} onClick={() => void agir({ acao: 'preparar' })}>{estado.ocupado ? 'Aguarde…' : 'Revisar importação'}</button>
          <p className={styles.garantia}>Nenhum cadastro é criado ou alterado sem a sua confirmação. Pagamentos entram como previstos, nunca como pagos.</p>
          <button type="button" className={styles.fantasma} disabled={estado.ocupado} onClick={() => setCancelando(true)}>Cancelar importação</button>
        </aside>
      </div>;
    })()}

    {estado.etapa === 'confirmacao' && <section className={styles.painel} aria-labelledby="confirmar-real">
      <h2 id="confirmar-real" className={styles.titulo}>Confirmar importação</h2>
      <div className={styles.acoesFinais}><button type="button" className={styles.fantasma} disabled={estado.decidindo} onClick={() => void decidir(estado.rascunho, 'cancelar')}>Voltar e corrigir</button><button type="button" className={styles.fantasma} disabled={estado.decidindo} onClick={() => setCancelando(true)}>Cancelar importação</button></div>
      <PreviewAcao rascunho={estado.rascunho} decidindo={estado.decidindo} erro={estado.erro} onDecidir={(r, d) => void decidir(r, d)} />
    </section>}

    {estado.etapa === 'concluida' && <section className={styles.painel} role="status">
      <span className={styles.seloPronto}>Importado</span>
      <h2 className={styles.titulo}>{estado.mensagem}</h2>
      <p className={styles.texto}>Contrato histórico registrado em Contratos, com o documento original e os pagamentos como previstos. Nenhuma Festa operacional, reserva de agenda, cobrança ou pagamento foi criado. Não é necessário importar o arquivo novamente.</p>
      <div className={styles.acoesFinais}>
        <Link className={styles.primario} href={estado.contratoDestino}>Abrir contrato</Link>
        {estado.destino && <Link className={styles.fantasma} href={estado.destino}>Abrir cliente</Link>}
        <button type="button" className={styles.fantasma} onClick={() => setEstado({ etapa: 'upload', erro: null })}>Importar outro contrato</button>
      </div>
    </section>}
    {estado.etapa === 'cancelada' && <section className={styles.painel} role="status">
      <h2 className={styles.titulo}>Esta revisão foi cancelada.</h2>
      <p className={styles.texto}>Envie o contrato novamente para iniciar uma nova revisão.</p>
      <button type="button" className={styles.primario} onClick={() => setEstado({ etapa: 'upload', erro: null })}>Enviar contrato novamente</button>
    </section>}
    <dialog ref={dialogo} className={`${styles.painel} ${real.cancelarDialogo}`} aria-labelledby="cancelar-importacao" onCancel={e => { e.preventDefault(); if (!decidindoCancelamento) setCancelando(false); }}><h2 id="cancelar-importacao">Descartar esta revisão?</h2><p>Nenhum cliente ou contrato será criado. O documento privado continuará sujeito à política de retenção do sistema.</p><div className={styles.acoesFinais}><button type="button" className={styles.fantasma} onClick={() => setCancelando(false)} disabled={decidindoCancelamento}>Continuar revisão</button><button type="button" className={styles.primario} onClick={() => void cancelarImportacao()} disabled={decidindoCancelamento}>Sim, cancelar importação</button></div></dialog>
  </main>;
}

function Campo({ campo, revisado, ocupado, editando, onEditar, onAgir }: {
  campo: CampoExtraido;
  revisado: boolean;
  ocupado: boolean;
  editando: string | null;
  onEditar(valor: string | null): void;
  onAgir(acao: AcaoImportacao): void;
}) {
  const visual = revisado ? 'REVISADO' : campo.estado;
  const editavel = campo.id !== 'pagamentos.realizados';
  // Valor recusado pelo validador (inválido, ambíguo, não representável) só sai corrigido ou removido.
  const recusado = campo.validacao === 'INVALIDO' || campo.validacao === 'AMBIGUO' || campo.validacao === 'NAO_REPRESENTAVEL';
  const confirmavel = campo.estado === 'PRECISA_REVISAO' && !recusado;
  return <div className={`${styles.campo} ${real.campo}`} data-estado={visual}>
    <dt>{campo.rotulo}</dt>
    <dd className={styles.valorCampo}>
      {editando !== null
        ? <form className={real.edicao} onSubmit={(e) => { e.preventDefault(); onAgir({ acao: 'revisar', campoId: campo.id, valor: editando }); }}>
          <label className={styles.oculto} htmlFor={`editar-${campo.id}`}>{campo.rotulo}</label>
          <input id={`editar-${campo.id}`} value={editando} maxLength={500} autoFocus disabled={ocupado} onChange={(e) => onEditar(e.target.value)} />
          <div className={real.acoesEdicao}>
            <button type="submit" className={styles.confirmarCampo} disabled={ocupado}>Salvar</button>
            <button type="button" className={styles.linkBotao} disabled={ocupado} onClick={() => onEditar(null)}>Cancelar</button>
          </div>
          {campo.valor && <button type="button" className={real.removerValor} disabled={ocupado} onClick={() => onAgir({ acao: 'revisar', campoId: campo.id, valor: '' })}>Não consta no documento</button>}
        </form>
        : <span className={campo.valor ? styles.valor : styles.valorAusente}>{campo.valor ?? 'Não localizado no contrato'}</span>}
      {campo.evidencia && <details className={real.fonte} open={campo.estado === 'PRECISA_REVISAO' && !revisado}>
        <summary>Ver trecho do contrato</summary>
        <small className={real.evidencia} data-conferida={campo.evidencia.conferida}>
          {campo.evidencia.pagina ? `Página ${campo.evidencia.pagina} · ` : ''}“{campo.evidencia.trecho}”{campo.evidencia.conferida ? '' : ' · trecho não localizado'}
        </small>
        {campo.bruto && campo.normalizado && campo.bruto !== campo.normalizado && <small>Lido como “{campo.bruto}”</small>}
      </details>}
      {campo.origem && !campo.evidencia && <small>{campo.origem}</small>}
      {!campo.evidencia && campo.bruto && campo.normalizado && campo.bruto !== campo.normalizado && <small>Lido como “{campo.bruto}”</small>}
      {campo.motivo && !revisado && <small className={styles.motivo}>{campo.motivo}</small>}
    </dd>
    <dd className={styles.estadoCampo}>
      <span className={styles.selo} data-estado={visual}>{ROTULO[visual]}</span>
      {confirmavel && !revisado && editando === null && <button type="button" className={styles.confirmarCampo} disabled={ocupado}
        aria-label={campo.conflito ? `Confirmar que o contrato traz ${campo.rotulo} assim` : `Confirmar leitura de ${campo.rotulo}`}
        onClick={() => onAgir(campo.conflito ? { acao: 'revisar', campoId: campo.id, confirmarDivergencia: true } : { acao: 'revisar', campoId: campo.id })}>
        {campo.conflito ? 'O contrato diz isso' : 'Confirmar leitura'}</button>}
      {editavel && editando === null && <button type="button" className={styles.linkBotao} disabled={ocupado}
        aria-label={`Corrigir ${campo.rotulo}`} onClick={() => onEditar(campo.valor ?? '')}>Corrigir</button>}
    </dd>
  </div>;
}
