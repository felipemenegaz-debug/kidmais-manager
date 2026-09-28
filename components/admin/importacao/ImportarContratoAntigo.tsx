'use client';
import { useEffect, useReducer, useRef, useState } from 'react';
import Link from 'next/link';
import { demoContractExtraction } from '@/lib/importacao-contrato/demo-extracao';
import type { ArquivoSelecionado, CampoExtraido, EstadoCampo } from '@/lib/importacao-contrato/modelo';
import {
  ACEITE_ARQUIVO, ETAPAS_ANALISE, FLUXO_INICIAL, contagemEstados, criarFluxoImportacao, formatoArquivo,
  pendencias, podeConfirmar, resumoConfirmacao, tamanhoLegivel,
} from '@/lib/importacao-contrato/revisao';
import styles from './importacao.module.css';

/**
 * Importação de contrato histórico — DEMO.
 * Sem rede e sem persistência: o arquivo não é lido nem enviado, a extração vem do
 * `demoContractExtraction` (dados fixos de exemplo) e o Human Gate termina num estado visual.
 */
const fluxoImportacao = criarFluxoImportacao(demoContractExtraction);
const INTERVALO_ANALISE_MS = 750;
const PASSOS = ['Enviar', 'Simular análise', 'Revisar', 'Confirmar'] as const;
const ROTULO_ESTADO: Record<EstadoCampo | 'REVISADO', string> = {
  ENCONTRADO: 'Encontrado',
  PRECISA_REVISAO: 'Precisa revisão',
  NAO_ENCONTRADO: 'Não encontrado',
  REVISADO: 'Revisado',
};
const FOCAVEIS = 'a[href], button:not([disabled])';

function paraArquivo(arquivo: File): ArquivoSelecionado {
  return { nome: arquivo.name, tipo: arquivo.type, tamanhoBytes: arquivo.size };
}

function plural(n: number, singular: string, pluralTexto: string) {
  return `${n} ${n === 1 ? singular : pluralTexto}`;
}

function Resumo({ linhas }: { linhas: ReadonlyArray<{ rotulo: string; valor: string }> }) {
  return <dl className={styles.resumo}>
    {linhas.map((linha) => <div key={linha.rotulo}><dt>{linha.rotulo}</dt><dd>{linha.valor}</dd></div>)}
  </dl>;
}

export default function ImportarContratoAntigo() {
  const [fluxo, despachar] = useReducer(fluxoImportacao, FLUXO_INICIAL);
  const [arrastando, setArrastando] = useState(false);
  const tituloRef = useRef<HTMLHeadingElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const gatilhoModalRef = useRef<HTMLButtonElement>(null);
  const confirmando = fluxo.etapa === 'revisao' && fluxo.confirmando;

  useEffect(() => {
    if (fluxo.etapa !== 'analisando') return;
    const timer = window.setTimeout(() => despachar({ tipo: 'avancar' }), INTERVALO_ANALISE_MS);
    return () => window.clearTimeout(timer);
  }, [fluxo]);

  useEffect(() => {
    if (fluxo.etapa !== 'upload') tituloRef.current?.focus();
  }, [fluxo.etapa]);

  useEffect(() => {
    if (!confirmando) return;
    const gatilho = gatilhoModalRef.current;
    modalRef.current?.querySelector<HTMLElement>(FOCAVEIS)?.focus();
    function tecla(evento: KeyboardEvent) {
      if (evento.key === 'Escape') {
        evento.preventDefault();
        despachar({ tipo: 'fecharConfirmacao' });
        return;
      }
      if (evento.key !== 'Tab') return;
      const controles = Array.from(modalRef.current?.querySelectorAll<HTMLElement>(FOCAVEIS) ?? []);
      const primeiro = controles[0];
      const ultimo = controles[controles.length - 1];
      if (!primeiro || !ultimo) return;
      if (evento.shiftKey && document.activeElement === primeiro) { evento.preventDefault(); ultimo.focus(); }
      else if (!evento.shiftKey && document.activeElement === ultimo) { evento.preventDefault(); primeiro.focus(); }
    }
    document.addEventListener('keydown', tecla);
    return () => {
      document.removeEventListener('keydown', tecla);
      gatilho?.focus();
    };
  }, [confirmando]);

  function selecionar(lista: FileList | null | undefined) {
    const arquivo = lista?.[0];
    if (arquivo) despachar({ tipo: 'selecionar', arquivo: paraArquivo(arquivo) });
  }

  const passoAtual = fluxo.etapa === 'upload' ? 0 : fluxo.etapa === 'analisando' ? 1 : fluxo.etapa === 'revisao' ? (confirmando ? 3 : 2) : 4;

  return <main className={styles.pagina}>
    <Link className={styles.voltar} href="/admin/contratos">← Contratos</Link>
    <header className={styles.topo}>
      <div className={styles.tituloLinha}>
        <h1>Importar contrato antigo</h1>
        <span className={styles.seloModo}>Modo demonstração</span>
      </div>
      <p><strong>Demonstração da importação inteligente.</strong> Selecione um PDF, JPG ou PNG para visualizar como será o fluxo de análise e revisão de contratos históricos.</p>
    </header>

    <ol className={styles.passos} aria-label="Etapas da importação">
      {PASSOS.map((passo, indice) => <li key={passo} data-estado={indice < passoAtual ? 'feito' : indice === passoAtual ? 'atual' : 'pendente'}
        aria-current={indice === passoAtual ? 'step' : undefined}><span aria-hidden="true">{indice + 1}</span>{passo}</li>)}
    </ol>

    {fluxo.etapa === 'upload' && <section className={styles.painel} aria-labelledby="importacao-envio">
      <h2 id="importacao-envio" className={styles.oculto}>Enviar contrato</h2>
      <div className={styles.zona} data-arrastando={arrastando}
        onDragOver={(evento) => { evento.preventDefault(); setArrastando(true); }}
        onDragLeave={() => setArrastando(false)}
        onDrop={(evento) => { evento.preventDefault(); setArrastando(false); selecionar(evento.dataTransfer?.files); }}>
        <span className={styles.icone} aria-hidden="true">↥</span>
        <p className={styles.zonaTitulo}>Arraste o contrato para cá</p>
        <p className={styles.zonaDica}>PDF, JPG ou PNG · até 15 MB</p>
        <label className={styles.selecionar}>
          Selecionar arquivo
          <input className={styles.oculto} type="file" accept={ACEITE_ARQUIVO} onChange={(evento) => { selecionar(evento.target.files); evento.target.value = ''; }} />
        </label>
        {fluxo.erro && <p className={styles.erro} role="alert">{fluxo.erro}</p>}
      </div>
      <p className={styles.garantia}>Nesta versão de demonstração, o arquivo não é enviado nem analisado. A revisão usa dados fictícios para apresentar a experiência.</p>
    </section>}

    {fluxo.etapa === 'analisando' && <section className={styles.painel} aria-busy="true">
      <h2 ref={tituloRef} tabIndex={-1} className={styles.titulo}>Simulando a análise</h2>
      <p className={styles.arquivo}><strong>{fluxo.arquivo.nome}</strong> · {formatoArquivo(fluxo.arquivo)} · {tamanhoLegivel(fluxo.arquivo.tamanhoBytes)} · não enviado</p>
      <div className={styles.barra} aria-hidden="true"><span style={{ width: `${((fluxo.passo + 1) / ETAPAS_ANALISE.length) * 100}%` }} /></div>
      <ol className={styles.etapas} aria-live="polite">
        {ETAPAS_ANALISE.map((etapa, indice) => <li key={etapa} data-estado={indice < fluxo.passo ? 'feito' : indice === fluxo.passo ? 'atual' : 'pendente'}>{etapa}</li>)}
      </ol>
      <button type="button" className={styles.fantasma} onClick={() => despachar({ tipo: 'cancelar' })}>Cancelar</button>
    </section>}

    {fluxo.etapa === 'revisao' && (() => {
      const { extracao, revisados } = fluxo;
      const contagem = contagemEstados(extracao);
      const { revisar, naoEncontrados } = pendencias(extracao, revisados);
      const liberado = podeConfirmar(extracao, revisados);
      const resumo = resumoConfirmacao(extracao);
      const campoRevisavel = (campo: CampoExtraido) => campo.estado === 'PRECISA_REVISAO';
      return <>
        <div className={styles.revisao}>
          <div className={styles.principal}>
            <div className={styles.cabecalhoRevisao}>
              <div>
                <h2 ref={tituloRef} tabIndex={-1} className={styles.titulo}>Revisão inteligente</h2>
                <p className={styles.arquivo}>{extracao.arquivo.nome} · {formatoArquivo(extracao.arquivo)} · {tamanhoLegivel(extracao.arquivo.tamanhoBytes)}</p>
              </div>
              {extracao.fonte === 'DEMONSTRACAO' && <span className={styles.seloDemo}>Dados de exemplo</span>}
            </div>
            {extracao.fonte === 'DEMONSTRACAO' && <p className={styles.avisoDemo}>Demonstração: os dados abaixo são um exemplo fixo para apresentar a revisão. O arquivo selecionado não foi lido nem enviado.</p>}
            <p className={styles.contagem}>
              <span data-estado="ENCONTRADO">{plural(contagem.ENCONTRADO, 'encontrado', 'encontrados')}</span>
              <span data-estado="PRECISA_REVISAO">{plural(contagem.PRECISA_REVISAO, 'precisa revisão', 'precisam revisão')}</span>
              <span data-estado="NAO_ENCONTRADO">{plural(contagem.NAO_ENCONTRADO, 'não encontrado', 'não encontrados')}</span>
            </p>

            <div className={styles.secoes}>
              {extracao.secoes.map((secao) => <section key={secao.id} className={styles.secao} aria-labelledby={`secao-${secao.id}`}>
                <h3 id={`secao-${secao.id}`}>{secao.titulo}</h3>
                {secao.nota && <p className={styles.nota}>{secao.nota}</p>}
                <dl className={styles.campos}>
                  {secao.campos.map((campo) => {
                    const revisado = revisados.includes(campo.id);
                    const estadoVisual = revisado ? 'REVISADO' : campo.estado;
                    return <div key={campo.id} className={styles.campo} data-estado={estadoVisual}>
                      <dt>{campo.rotulo}</dt>
                      <dd className={styles.valorCampo}>
                        <span className={campo.valor ? styles.valor : styles.valorAusente}>{campo.valor ?? 'Não localizado no contrato'}</span>
                        {campo.origem && <small>{campo.origem}</small>}
                        {campo.motivo && !revisado && <small className={styles.motivo}>{campo.motivo}</small>}
                      </dd>
                      <dd className={styles.estadoCampo}>
                        <span className={styles.selo} data-estado={estadoVisual}>{ROTULO_ESTADO[estadoVisual]}</span>
                        {campoRevisavel(campo) && <button type="button" className={styles.confirmarCampo} aria-pressed={revisado}
                          aria-label={`${revisado ? 'Desfazer confirmação de' : 'Confirmar leitura de'} ${campo.rotulo}`}
                          onClick={() => despachar({ tipo: 'alternarRevisado', campoId: campo.id })}>{revisado ? 'Desfazer' : 'Confirmar leitura'}</button>}
                      </dd>
                    </div>;
                  })}
                </dl>
              </section>)}
            </div>

            <details className={styles.evidencias}>
              <summary>Evidências</summary>
              <div>
                <h4>Dados encontrados no contrato</h4>
                <p>{plural(contagem.ENCONTRADO + contagem.PRECISA_REVISAO, 'campo de exemplo', 'campos de exemplo')}, cada um com página e cláusula de origem ilustrativas. Com o Import Engine, estas referências apontarão para o documento enviado.</p>
                <h4>Dados do sistema utilizados</h4>
                <p>Nenhum. Pacote, itens e valores ficam como no contrato original, sem recálculo com o catálogo ou a tabela de preços atual.</p>
                <h4>Campos que precisam revisão humana</h4>
                <ul>{todosRevisaveis(extracao.secoes).map((campo) => <li key={campo.id}>{campo.rotulo}{revisados.includes(campo.id) ? ' — revisado' : ''}</li>)}</ul>
              </div>
            </details>
          </div>

          <aside className={styles.gate} aria-labelledby="gate-titulo">
            <h2 id="gate-titulo">Confirmação humana</h2>
            {extracao.fonte === 'DEMONSTRACAO' && <p className={styles.discreto}>Resumo dos dados de exemplo. O arquivo não foi processado.</p>}
            <Resumo linhas={resumo} />
            <div className={styles.pendencias}>
              <h3>Pendências</h3>
              {revisar.length > 0
                ? <ul>{revisar.map((campo) => <li key={campo.id}>Confirmar {campo.rotulo.toLowerCase()}</li>)}</ul>
                : <p className={styles.ok}>Todos os campos marcados foram revisados.</p>}
              {naoEncontrados.length > 0 && <ul className={styles.discreto}>{naoEncontrados.map((campo) => <li key={campo.id}>{campo.rotulo}: não encontrado</li>)}</ul>}
            </div>
            <button ref={gatilhoModalRef} type="button" className={styles.primario} disabled={!liberado} onClick={() => despachar({ tipo: 'abrirConfirmacao' })}>Confirmar importação</button>
            {!liberado && <p className={styles.dica}>Confirme {plural(revisar.length, 'campo marcado', 'campos marcados')} como “Precisa revisão” para continuar.</p>}
            <p className={styles.garantia}>Nada é gravado sem a sua confirmação.</p>
            <button type="button" className={styles.linkBotao} onClick={() => despachar({ tipo: 'recomecar' })}>Trocar arquivo</button>
          </aside>
        </div>

        {fluxo.confirmando && <div className={styles.camadaModal}>
          <div className={styles.cortina} aria-hidden="true" onClick={() => despachar({ tipo: 'fecharConfirmacao' })} />
          <div ref={modalRef} className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="confirmar-titulo" aria-describedby="confirmar-aviso">
            <h2 id="confirmar-titulo">Confirmar importação</h2>
            <Resumo linhas={resumo} />
            {naoEncontrados.length > 0 && <p className={styles.discreto}>{plural(naoEncontrados.length, 'campo não encontrado ficará', 'campos não encontrados ficarão')} em branco para completar depois.</p>}
            <p id="confirmar-aviso" className={styles.aviso}>Modo demonstração: o arquivo não foi processado e o resumo usa dados de exemplo. Nada é gravado: cliente, contrato, festa e pagamentos continuam como estão. A persistência definitiva será habilitada após validação do Import Engine.</p>
            <div className={styles.acoesModal}>
              <button type="button" className={styles.fantasma} onClick={() => despachar({ tipo: 'fecharConfirmacao' })}>Voltar à revisão</button>
              <button type="button" className={styles.primario} onClick={() => despachar({ tipo: 'marcarPronto' })}>Marcar como pronto</button>
            </div>
          </div>
        </div>}
      </>;
    })()}

    {fluxo.etapa === 'pronto' && <section className={styles.painel}>
      <span className={styles.seloPronto}>Pronto para importar após validação</span>
      <h2 ref={tituloRef} tabIndex={-1} className={styles.titulo}>Revisão concluída</h2>
      <p className={styles.texto}>Modo demonstração: os dados de exemplo foram revisados, mas o arquivo não foi processado e nenhum cliente, contrato, festa ou pagamento foi criado.</p>
      <Resumo linhas={resumoConfirmacao(fluxo.extracao)} />
      <p className={styles.aviso}>A persistência definitiva será habilitada após validação do Import Engine.</p>
      <div className={styles.acoesFinais}>
        <button type="button" className={styles.primario} onClick={() => despachar({ tipo: 'recomecar' })}>Importar outro contrato</button>
        <Link className={styles.fantasma} href="/admin/contratos">Voltar para Contratos</Link>
      </div>
    </section>}
  </main>;
}

function todosRevisaveis(secoes: ReadonlyArray<{ campos: CampoExtraido[] }>) {
  return secoes.flatMap((secao) => secao.campos).filter((campo) => campo.estado === 'PRECISA_REVISAO');
}
