'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { AdminPrimaryButton } from '@/components/admin/AdminPrimaryButton';
import { formatarMoeda } from '@/lib/contratos/documento/formatters';
import { adminFetch } from '@/lib/http/admin-fetch';
import { corpoBaixa, formatarInstanteSP, rotuloDestino, rotuloMotivo, type DevolucaoPreReserva } from '@/lib/pre-reserva/apresentacao-admin';
import styles from '@/components/admin/workspace.module.css';

const url = '/api/admin/pre-reserva/devolucoes';

async function buscar(historico: boolean): Promise<DevolucaoPreReserva[]> {
  const resposta = await adminFetch(historico ? `${url}?historico=1` : url, { cache: 'no-store' });
  const json = await resposta.json();
  if (!resposta.ok) throw new Error(json.erro ?? 'Não foi possível carregar as devoluções.');
  return json.data;
}

export default function Page() {
  const [fila, setFila] = useState<DevolucaoPreReserva[] | null>(null);
  const [historico, setHistorico] = useState(false);
  const [baixando, setBaixando] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [erro, setErro] = useState('');
  const [mensagem, setMensagem] = useState('');

  useEffect(() => {
    let ativo = true;
    void buscar(historico).then((dados) => { if (ativo) setFila(dados); })
      .catch((e: Error) => { if (ativo) setErro(e.message); });
    return () => { ativo = false; };
  }, [historico]);

  function abrir(exibirHistorico: boolean) {
    if (historico === exibirHistorico) return;
    setHistorico(exibirHistorico);
    setFila(null);
    setBaixando(null);
    setErro('');
    setMensagem('');
  }

  async function atualizarFila() {
    try { setFila(await buscar(false)); }
    catch {
      setFila(null);
      setBaixando(null);
      throw new Error('Atualize a página para conferir a fila.');
    }
  }

  async function enviar(movimento: DevolucaoPreReserva, acao: 'assumir' | 'baixar', campos?: FormData) {
    if (ocupado) return;
    setOcupado(movimento.end_to_end_id);
    setErro('');
    setMensagem('');
    try {
      const corpo = campos
        ? corpoBaixa(movimento.end_to_end_id, String(campos.get('referencia')), String(campos.get('valor')),
          movimento.valor_centavos, String(campos.get('data')), String(campos.get('hora')), campos.has('extrato'))
        : { referencia: movimento.end_to_end_id };
      const resposta = await adminFetch(`${url}/${acao}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo),
      });
      const json = await resposta.json();
      if (!resposta.ok) {
        const aviso = json.codigo === 'DADOS_INVALIDOS'
          ? 'Confira a referência, o valor integral, a data e a hora da saída no extrato.'
          : json.erro ?? 'Confira os dados da transferência.';
        if (resposta.status === 409) {
          setBaixando(null);
          try { await atualizarFila(); }
          catch { throw new Error(`${aviso} Atualize a página para conferir a fila.`); }
        }
        throw new Error(aviso);
      }
      setBaixando(null);
      setMensagem(acao === 'assumir' ? 'Devolução assumida.' : 'Baixa registrada. Consulte a devolução no histórico.');
      await atualizarFila();
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Não foi possível registrar a devolução.');
    } finally {
      setOcupado(null);
    }
  }

  function baixar(evento: FormEvent<HTMLFormElement>, movimento: DevolucaoPreReserva) {
    evento.preventDefault();
    void enviar(movimento, 'baixar', new FormData(evento.currentTarget));
  }

  return <main className={styles.page} data-admin-workspace>
    <header className={styles.header}><h1>Devoluções de pré-reserva</h1></header>
    <div className={styles.content}>
      <p>A Gestão deve devolver em até 2 dias úteis. Dê baixa depois de fazer a transferência e conferir a saída no extrato.</p>
      <div className={styles.filters}>
        <button type="button" disabled={Boolean(ocupado)} aria-pressed={!historico} onClick={() => abrir(false)}>Pendentes</button>
        <button type="button" disabled={Boolean(ocupado)} aria-pressed={historico} onClick={() => abrir(true)}>Histórico</button>
      </div>
      {erro && <p role="alert">{erro}</p>}
      {mensagem && <p role="status">{mensagem}</p>}
      {!fila && !erro && <p role="status">Carregando devoluções…</p>}
      {fila?.length === 0 && <p className={styles.empty}>{historico ? 'Nenhuma devolução baixada.' : 'Nenhuma devolução de pré-reserva pendente.'}</p>}
      {fila?.map((movimento) => {
        const { fechamento_id: pedido, end_to_end_id: referencia, situacao } = movimento;
        return <section key={referencia} className={styles.card} style={{ overflowWrap: 'anywhere' }}>
          <h2>{rotuloDestino(situacao)}</h2>
          <p>Pedido <a href={`/admin/fechamentos/${encodeURIComponent(pedido)}/revisao`}>{pedido}</a></p>
          <p><strong>{formatarMoeda(Number(movimento.valor_centavos) / 100)}</strong> · {rotuloMotivo(movimento.motivo)}</p>
          <p>Pix recebido {referencia}</p>
          <p>Assumiu {movimento.responsavel_nome ?? movimento.responsavel ?? '—'}
            {movimento.devolucao_assumida_em && <> em {formatarInstanteSP(movimento.devolucao_assumida_em)}</>}
          </p>
          {historico && <p>Baixou {movimento.devolvido_por_nome ?? movimento.devolvido_por ?? '—'}
            {movimento.devolvido_em && <> em {formatarInstanteSP(movimento.devolvido_em)}</>}
          </p>}
          {!historico && situacao === 'A_DEVOLVER' &&
            <AdminPrimaryButton disabled={Boolean(ocupado)} carregando={ocupado === referencia}
              onClick={() => void enviar(movimento, 'assumir')}>Assumir</AdminPrimaryButton>}
          {!historico && situacao === 'EM_DEVOLUCAO' && (baixando === referencia
            ? <form onSubmit={(e) => baixar(e, movimento)}>
              <label>Referência da saída no extrato<input name="referencia" required disabled={Boolean(ocupado)} /></label>
              <label>Valor integral da saída (R$)<input name="valor" required inputMode="decimal" disabled={Boolean(ocupado)} /></label>
              <div className={styles.grid}>
                <label>Data da saída<input name="data" required type="date" disabled={Boolean(ocupado)} /></label>
                <label>Hora da saída (São Paulo)<input name="hora" required type="time" step="1" disabled={Boolean(ocupado)} /></label>
              </div>
              <label><input name="extrato" required type="checkbox" disabled={Boolean(ocupado)} /> Conferi a saída no extrato</label>
              <div className={styles.actions}>
                <AdminPrimaryButton type="submit" disabled={Boolean(ocupado)} carregando={ocupado === referencia}>Registrar baixa</AdminPrimaryButton>
                <button type="button" disabled={Boolean(ocupado)} onClick={() => setBaixando(null)}>Cancelar</button>
              </div>
            </form>
            : <button type="button" disabled={Boolean(ocupado)} onClick={() => { setErro(''); setBaixando(referencia); }}>Dar baixa</button>)}
        </section>;
      })}
    </div>
  </main>;
}
