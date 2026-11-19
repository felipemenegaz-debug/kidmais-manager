'use client';
import { useEffect, useState } from 'react';
import { numeroParaMoeda } from '@/components/fechamento/calculos';
import { EstadoCarga, enviarMarketing, useMarketing } from '@/components/admin/marketing/comum';
import { DIAS_SEMANA_ISO, NOME_CURTO_DIA, rascunhoDoEstado, type RascunhoDia, rotuloDias, TETO_DESCONTO_DIA } from '@/lib/comercial/descontos-dia';
import type { EstadoDescontoDia, RegraDia } from '@/lib/comercial/descontos-dia-admin';
import styles from './descontos-pagamento.module.css';

const URL_API = '/api/admin/configuracoes/descontos/dia';
type Disponivel = Extract<EstadoDescontoDia, { disponivel: true }>;
type Rascunho = RascunhoDia;
type Aviso = { tipo: 'ok' | 'erro'; texto: string };

const dataBr = (iso: string) => iso.split('-').reverse().join('/');
const dataHora = (iso: string) => new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(new Date(iso));

/** Mesmas regras do servidor (lib/comercial/descontos-dia-admin.ts); o servidor continua sendo quem decide. */
export function conferirDia(r: Rascunho, hoje: string): { pct: number | null; erros: Partial<Record<'percentual' | 'dias' | 'pacotes' | 'inicio', string>> } {
  const erros: Partial<Record<'percentual' | 'dias' | 'pacotes' | 'inicio', string>> = {};
  const t = r.percentual.trim();
  const n = Number(t);
  if (t === '' || !Number.isFinite(n)) erros.percentual = `Informe o desconto (0 a ${TETO_DESCONTO_DIA}). Use 0 para desligar.`;
  else if (!Number.isInteger(n)) erros.percentual = 'Use número inteiro, sem casas decimais.';
  else if (n < 0) erros.percentual = 'O desconto não pode ser negativo.';
  else if (n > TETO_DESCONTO_DIA) erros.percentual = `Passa do limite de ${TETO_DESCONTO_DIA}%. Confira se não houve erro de digitação.`;
  if (n > 0 && r.dias.length === 0) erros.dias = 'Escolha pelo menos um dia da semana.';
  if (n > 0 && r.pacoteIds.length === 0) erros.pacotes = 'Escolha pelo menos um pacote.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(r.inicio)) erros.inicio = 'Informe a data a partir da qual vale.';
  else if (r.inicio < hoje) erros.inicio = 'A data não pode ser antes de hoje.';
  return { pct: Object.keys(erros).length ? null : n, erros };
}

function resumoRegra(r: RegraDia, totalPacotes: number) {
  const pacotes = r.pacoteIds.length === totalPacotes ? 'todos os pacotes' : r.pacoteIds.length === 1 ? '1 pacote' : `${r.pacoteIds.length} pacotes`;
  return `${r.percentual}% ${rotuloDias(r.dias)} · ${pacotes} · festas a partir de ${dataBr(r.inicio)}${r.fim ? ` até ${dataBr(r.fim)}` : ''}`;
}

/**
 * D3 (18/11/2026): seção "Desconto por dia da semana". `aoMudarPrevia` informa o percentual que a soma de exemplo deve
 * usar (o do rascunho válido, senão o que vale hoje).
 */
export default function DescontoDiaSemana({ numero, aoMudarPrevia }: { numero: number; aoMudarPrevia: (pct: number, dias: number[]) => void }) {
  const { dados, falha, carregando, recarregar, setDados } = useMarketing<EstadoDescontoDia>(URL_API);
  const [aviso, setAviso] = useState<Aviso | null>(null);
  return <section className={styles.cartao} aria-labelledby="desc-dia">
    <h2 id="desc-dia">{numero}. Desconto por dia da semana</h2>
    <EstadoCarga carregando={carregando && !dados} falha={falha} aoTentar={recarregar} />
    {dados && !dados.disponivel && <p className={styles.muted} role="status">
      As regras de desconto por dia deste buffet foram montadas pela equipe do sistema e não cabem nesta tela. Elas continuam valendo. Para mudar, fale com o suporte.
    </p>}
    {dados && dados.disponivel && <FormularioDia key={dados.versao} estado={dados} aoSalvar={setDados} aviso={aviso} setAviso={setAviso} aoMudarPrevia={aoMudarPrevia} />}
  </section>;
}

function FormularioDia({ estado, aoSalvar, aviso, setAviso, aoMudarPrevia }: { estado: Disponivel; aoSalvar: (e: EstadoDescontoDia) => void; aviso: Aviso | null; setAviso: (a: Aviso | null) => void; aoMudarPrevia: (pct: number, dias: number[]) => void }) {
  const [r, setR] = useState<Rascunho>(() => rascunhoDoEstado(estado));
  const [enviando, setEnviando] = useState(false);
  const { pct, erros } = conferirDia(r, estado.hoje);
  const pacotesNovos = estado.pacotes.filter((p) => (estado.agendada ?? estado.vigente) && !(estado.agendada ?? estado.vigente)!.pacoteIds.includes(p.id));
  const previaPct = pct ?? estado.vigente?.percentual ?? 0;
  const previaDias = pct !== null ? r.dias : estado.vigente?.dias ?? [];
  useEffect(() => { aoMudarPrevia(previaPct, previaDias); }, [previaPct, previaDias.join(','), aoMudarPrevia]); // eslint-disable-line react-hooks/exhaustive-deps

  const mudar = (p: Partial<Rascunho>) => { setR((a) => ({ ...a, ...p })); setAviso(null); };
  const alternar = (lista: readonly (string | number)[], v: string | number) => (lista.includes(v) ? lista.filter((x) => x !== v) : [...lista, v]);

  async function salvar() {
    if (pct === null || enviando) return;
    setEnviando(true);
    setAviso(null);
    try {
      const novo = await enviarMarketing<EstadoDescontoDia>(URL_API, { dias: r.dias, percentual: pct, pacoteIds: r.pacoteIds, inicio: r.inicio, versao: estado.versao });
      aoSalvar(novo);
      // Mesma versão = o servidor não gravou nada (o pedido já era o que vale): não dizer "Salvo".
      if (novo.disponivel && novo.versao === estado.versao) setAviso({ tipo: 'ok', texto: 'Nada mudou: isso já é o que vale. Nada foi gravado.' });
      else setAviso({ tipo: 'ok', texto: pct === 0 ? `Desligado para festas a partir de ${dataBr(r.inicio)}. Festas já fechadas não mudam.` : `Salvo. Vale para festas a partir de ${dataBr(r.inicio)}. Festas já fechadas não mudam.` });
    } catch (e) {
      setAviso({ tipo: 'erro', texto: e instanceof Error ? e.message : 'Não foi possível salvar.' });
    } finally {
      setEnviando(false);
    }
  }

  return <>
    <p className={styles.muted}>Um desconto sobre o valor do pacote em dias escolhidos. O cliente vê o desconto no calendário ao escolher a data.</p>
    <ul className={styles.lista} aria-label="Situação do desconto por dia">
      <li><span>Valendo hoje</span><span>{estado.vigente ? resumoRegra(estado.vigente, estado.pacotes.length) : 'Nenhum desconto por dia'}</span></li>
      {estado.agendada && <li><span>Agendado</span><span>{resumoRegra(estado.agendada, estado.pacotes.length)}</span></li>}
      {estado.desligaEm && <li><span>Agendado</span><span>Desligado para festas a partir de {dataBr(estado.desligaEm)}</span></li>}
    </ul>
    {estado.outrasRegras > 0 && <p className={styles.alerta} role="note">Há {estado.outrasRegras === 1 ? '1 outro desconto' : `${estado.outrasRegras} outros descontos`} por dia cadastrado nos pacotes (fora desta tela). {estado.outrasRegras === 1 ? 'Ele continua' : 'Eles continuam'} valendo.</p>}
    <form onSubmit={(e) => { e.preventDefault(); void salvar(); }} noValidate aria-busy={enviando}>
      <fieldset className={styles.grupo} disabled={enviando} aria-describedby={erros.dias ? 'dia-dias-erro' : undefined}>
        <legend>Dias da semana</legend>
        <div className={styles.chips}>
          {DIAS_SEMANA_ISO.map((d) => <label key={d} className={styles.chip}>
            <input type="checkbox" checked={r.dias.includes(d)} onChange={() => mudar({ dias: (alternar(r.dias, d) as number[]).sort((a, b) => a - b) })} />
            <span>{NOME_CURTO_DIA[d]}</span>
          </label>)}
        </div>
        {erros.dias && <span className={styles.erroCampo} id="dia-dias-erro">{erros.dias}</span>}
      </fieldset>
      <div className={styles.campos}>
        <label className={styles.campo} htmlFor="dia-pct">
          Desconto sobre o pacote (%)
          <input id="dia-pct" type="number" inputMode="numeric" min={0} max={TETO_DESCONTO_DIA} step={1} readOnly={enviando} value={r.percentual}
            aria-invalid={erros.percentual ? true : undefined} aria-describedby={erros.percentual ? 'dia-pct-erro' : undefined}
            onChange={(e) => mudar({ percentual: e.target.value })} />
          {erros.percentual && <span className={styles.erroCampo} id="dia-pct-erro">{erros.percentual}</span>}
        </label>
        <label className={styles.campo} htmlFor="dia-inicio">
          Vale para festas a partir de
          <input id="dia-inicio" type="date" min={estado.hoje} readOnly={enviando} value={r.inicio}
            aria-invalid={erros.inicio ? true : undefined} aria-describedby={erros.inicio ? 'dia-inicio-erro' : undefined}
            onChange={(e) => mudar({ inicio: e.target.value })} />
          {erros.inicio && <span className={styles.erroCampo} id="dia-inicio-erro">{erros.inicio}</span>}
        </label>
      </div>
      <fieldset className={styles.grupo} disabled={enviando} aria-describedby={erros.pacotes ? 'dia-pac-erro' : undefined}>
        <legend>Pacotes com desconto</legend>
        {estado.pacotes.length === 0 ? <p className={styles.muted}>Nenhum pacote ativo. Cadastre um pacote antes.</p>
          : <div className={styles.chips}>
              {estado.pacotes.map((p) => <label key={p.id} className={styles.chip}>
                <input type="checkbox" checked={r.pacoteIds.includes(p.id)} onChange={() => mudar({ pacoteIds: alternar(r.pacoteIds, p.id) as string[] })} />
                <span>{p.nome}</span>
              </label>)}
            </div>}
        {pacotesNovos.length > 0 && <small className={styles.muted}>Fora do desconto atual: {pacotesNovos.map((p) => p.nome).join(', ')}. Marque se quiser incluir.</small>}
        {erros.pacotes && <span className={styles.erroCampo} id="dia-pac-erro">{erros.pacotes}</span>}
      </fieldset>
      <p className={styles.muted}>
        {pct !== null && pct > 0 ? <>O cliente vai ver: <b>{pct}% de desconto {rotuloDias(r.dias)}</b>. Numa festa de {numeroParaMoeda(5000)}, o pacote cai {numeroParaMoeda(Math.round(5000 * pct) / 100)}.</>
          : pct === 0 ? <>Com 0%, o desconto por dia fica <b>desligado</b> para festas a partir da data escolhida.</> : null}
        {' '}O limite é {TETO_DESCONTO_DIA}%. Festas já fechadas não mudam.
      </p>
      <div className={styles.acoes}>
        <button type="submit" className={styles.primario} disabled={pct === null || enviando}>{enviando ? 'Salvando…' : 'Salvar desconto por dia'}</button>
      </div>
      <div aria-live="polite">{aviso && <p className={aviso.tipo === 'ok' ? styles.ok : styles.erro} role={aviso.tipo === 'erro' ? 'alert' : undefined}>{aviso.texto}</p>}</div>
    </form>
    <h3 className={styles.subtitulo}>Histórico do desconto por dia</h3>
    {estado.historico.length === 0 ? <p className={styles.muted}>Nenhuma alteração feita por esta tela ainda.</p>
      : <ul className={styles.lista}>{estado.historico.map((h, i) => <li key={`${h.em}-${i}`}>
          <span>{dataHora(h.em)} · {h.por ?? 'Sistema'}</span>
          <span>{h.texto}</span>
        </li>)}</ul>}
  </>;
}
