'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { AdminPrimaryButton } from '@/components/admin/AdminPrimaryButton';
import { adminFetch, reautenticarSessao } from '@/lib/http/admin-fetch';
import { corpoConfiguracao, type ConfiguracaoPreReserva } from '@/lib/pre-reserva/apresentacao-admin';
import styles from '@/components/admin/workspace.module.css';

const url = '/api/admin/configuracoes/pre-reserva';

async function buscar(): Promise<ConfiguracaoPreReserva> {
  const resposta = await adminFetch(url, { cache: 'no-store' });
  const json = await resposta.json();
  if (!resposta.ok) throw new Error(json.erro ?? 'Não foi possível carregar a configuração.');
  return json.data;
}

export default function Page() {
  const [config, setConfig] = useState<ConfiguracaoPreReserva | null>(null);
  const [habilitada, setHabilitada] = useState(false);
  const [valor, setValor] = useState('');
  const [senha, setSenha] = useState('');
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState('');
  const [mensagem, setMensagem] = useState('');

  function aplicar(dados: ConfiguracaoPreReserva) {
    setConfig(dados);
    setHabilitada(dados.habilitada);
    setValor((dados.sinalCentavos / 100).toFixed(2).replace('.', ','));
  }

  useEffect(() => {
    let ativo = true;
    void buscar().then((dados) => { if (ativo) aplicar(dados); })
      .catch((e: Error) => { if (ativo) setErro(e.message); });
    return () => { ativo = false; };
  }, []);

  async function salvar(evento: FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    if (!config || salvando) return;
    setSalvando(true);
    setErro('');
    setMensagem('');
    try {
      const corpo = corpoConfiguracao(habilitada, valor, config.versao);
      const auth = await reautenticarSessao(senha);
      if (!auth.ok) throw new Error(auth.erro);
      const resposta = await adminFetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo),
      });
      const json = await resposta.json();
      if (!resposta.ok) {
        if (resposta.status === 409 || json.codigo === 'RECURSO_FORA_DO_PLANO') {
          try { aplicar(await buscar()); }
          catch { setConfig(null); }
        }
        throw new Error(json.erro ?? 'Não foi possível salvar a configuração.');
      }
      aplicar({ ...config, ...json.data });
      setMensagem(json.data.habilitada ? 'Piloto de pré-reserva ligado.' : 'Piloto de pré-reserva desligado.');
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Não foi possível salvar a configuração.');
    } finally {
      setSenha('');
      setSalvando(false);
    }
  }

  const podeLigar = Boolean(config?.orcamentoOnline && config.recebedorPix);

  return <main className={styles.page} data-admin-workspace>
    <header className={styles.header}><h1>Pré-reserva</h1></header>
    <div className={styles.content}>
      {erro && <p role="alert">{erro}</p>}
      {mensagem && <p role="status">{mensagem}</p>}
      {!config && !erro && <p role="status">Carregando configuração…</p>}
      {config && <section className={styles.card}>
        <h2>Piloto de pré-reserva</h2>
        <p>O piloto começa desligado. Desligar impede novas ofertas e preserva as devoluções pendentes.</p>
        {!podeLigar && <p role="alert">
          {!config.orcamentoOnline && 'Para ligar o piloto, o plano precisa incluir orçamento online. '}
          {!config.recebedorPix && 'Cadastre um recebedor Pix em Perfil da empresa para ligar o piloto.'}
        </p>}
        <form onSubmit={salvar}>
          <label><input type="checkbox" checked={habilitada} disabled={salvando || (!podeLigar && !habilitada)}
            onChange={(e) => setHabilitada(e.target.checked)} /> Piloto ligado</label>
          <label>Valor do sinal (R$)
            <input inputMode="decimal" value={valor} required disabled={salvando}
              onChange={(e) => setValor(e.target.value)} />
          </label>
          <p className={styles.muted}>De R$ 10 a R$ 500. Valor padrão de R$ 100, limitado ao preço aceito.</p>
          <label>Sua senha para salvar
            <input type="password" autoComplete="current-password" value={senha} required disabled={salvando}
              onChange={(e) => setSenha(e.target.value)} />
          </label>
          <AdminPrimaryButton type="submit" carregando={salvando} disabled={habilitada && !podeLigar}>Salvar configuração</AdminPrimaryButton>
        </form>
      </section>}
    </div>
  </main>;
}
