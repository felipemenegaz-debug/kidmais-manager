'use client';
import { useCallback, useEffect, useState } from 'react';
import { adminFetch, reautenticarSessao } from '@/lib/http/admin-fetch';
import { AdminIcon } from './AdminIcon';
import styles from './perfil-empresa.module.css';

type Tipo = 'CPF' | 'CNPJ' | 'EMAIL' | 'TELEFONE' | 'ALEATORIA';
type Configuracao = { tipoChave: Tipo; chaveMascarada: string; versao: number };
type Dados = { instalado: boolean; configuracao: Configuracao | null; podeEditar: boolean; recebedor: { nome: string; cidade: string } | null };
type Etapa = 'editar' | 'confirmar';

const TIPOS: Array<[Tipo, string, string]> = [
  ['CNPJ', 'CNPJ', '00.000.000/0000-00'],
  ['CPF', 'CPF', '000.000.000-00'],
  ['EMAIL', 'E-mail', 'financeiro@empresa.com.br'],
  ['TELEFONE', 'Celular', '(11) 99999-0000'],
  ['ALEATORIA', 'Chave aleatória', '123e4567-e89b-12d3-a456-426614174000'],
];
const rotuloTipo = (t: Tipo) => TIPOS.find(([v]) => v === t)?.[1] ?? t;

async function buscar(): Promise<{ dados: Dados } | { erro: string }> {
  try {
    const resposta = await adminFetch('/api/admin/configuracoes/pix');
    const corpo = await resposta.json();
    return corpo.ok ? { dados: corpo.data as Dados } : { erro: corpo.erro ?? 'Não foi possível carregar a chave Pix.' };
  } catch {
    return { erro: 'Não foi possível carregar a chave Pix. Verifique a conexão.' };
  }
}

/**
 * Seção "Recebimento por Pix" do Perfil da empresa (066). Independente do rascunho do Perfil: salva na hora, com senha.
 * Só tipo e chave; nome e cidade do recebedor vêm do Perfil (nome comercial e cidade da sede). A senha só aparece no
 * segundo passo, para o navegador não preencher a chave com o e-mail de login.
 */
export function PerfilRecebimentoPix() {
  const [dados, setDados] = useState<Dados | null>(null);
  const [erro, setErro] = useState('');
  const [sucesso, setSucesso] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const [etapa, setEtapa] = useState<Etapa>('editar');
  const [acao, setAcao] = useState<'salvar' | 'remover'>('salvar');
  const [tipo, setTipo] = useState<Tipo>('CNPJ');
  const [chave, setChave] = useState('');
  const [senha, setSenha] = useState('');

  const aplicar = useCallback((r: { dados: Dados } | { erro: string }) => {
    if ('erro' in r) { setErro(r.erro); return; }
    setDados(r.dados);
    setTipo(r.dados.configuracao?.tipoChave ?? 'CNPJ');
    setChave('');
  }, []);

  useEffect(() => {
    let ativo = true;
    void buscar().then((r) => { if (ativo) aplicar(r); });
    return () => { ativo = false; };
  }, [aplicar]);

  function pedirSenha(proxima: 'salvar' | 'remover') {
    setErro(''); setSucesso(''); setSenha(''); setAcao(proxima); setEtapa('confirmar');
  }

  async function confirmar() {
    if (!dados) return;
    setOcupado(true); setErro(''); setSucesso('');
    try {
      const auth = await reautenticarSessao(senha);
      if (!auth.ok) { setErro(auth.senhaIncorreta ? 'Senha incorreta. Nada foi alterado.' : auth.erro); return; }
      const corpo = acao === 'remover'
        ? { acao: 'remover', versao: dados.configuracao?.versao, confirmar: true }
        : { acao: 'salvar', tipoChave: tipo, chave, versao: dados.configuracao?.versao ?? null };
      const resposta = await adminFetch('/api/admin/configuracoes/pix', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
      const json = await resposta.json();
      if (!json.ok) { setErro(json.erro ?? 'Não foi possível salvar. Nada foi alterado.'); setEtapa('editar'); return; }
      setSucesso(acao === 'remover' ? 'Chave Pix removida. As parcelas deixam de mostrar o Pix até uma nova chave ser cadastrada.' : 'Chave Pix salva. Os próximos Pix das parcelas já usam esta chave.');
      setEtapa('editar');
      aplicar(await buscar());
    } catch {
      setErro('Não foi possível confirmar a operação. Atualize a página e confira antes de repetir.');
    } finally {
      setSenha('');
      setOcupado(false);
    }
  }

  const atual = dados?.configuracao ?? null;
  const podeEditar = Boolean(dados?.instalado && dados.podeEditar);
  const placeholder = TIPOS.find(([t]) => t === tipo)?.[2] ?? '';
  const semCidade = Boolean(dados?.recebedor && !dados.recebedor.cidade);

  return <section className={styles.card} id="recebimento-pix" aria-labelledby="recebimento-pix-titulo">
    <h2 className={styles.titulo} id="recebimento-pix-titulo"><AdminIcon name="contact" size={12} />Recebimento por Pix</h2>
    {!dados && !erro && <p className={styles.pixResumo} role="status">Carregando.</p>}
    {dados && !dados.instalado && <p className={styles.pixResumo}>O recebimento por Pix ainda não está disponível neste ambiente.</p>}
    {dados?.instalado && <>
      <p className={styles.pixResumo}>
        {atual
          ? <>Chave cadastrada: <strong>{rotuloTipo(atual.tipoChave)} {atual.chaveMascarada}</strong>.</>
          : <>Nenhuma chave cadastrada. Sem ela, o botão Pix das parcelas avisa que falta configurar.</>}
        {dados.recebedor && <> O QR Code mostra o recebedor <strong>{dados.recebedor.nome || '—'}</strong>{dados.recebedor.cidade ? <> ({dados.recebedor.cidade})</> : null}, a partir do nome comercial e da cidade da sede deste Perfil.</>}
      </p>
      {semCidade && <p className={styles.erro} role="alert">Preencha e aplique a cidade da sede neste Perfil: ela é obrigatória no QR Code Pix.</p>}
      {!dados.podeEditar && <p className={styles.pixResumo}>Somente a Gestão desta empresa altera a chave Pix.</p>}
      {podeEditar && etapa === 'editar' && <>
        <div className={styles.grade}>
          <label className={styles.campo}><span className={styles.rotulo}>Tipo de chave</span>
            <select aria-label="Tipo de chave Pix" name="pix-tipo" value={tipo} disabled={ocupado} onChange={(e) => setTipo(e.target.value as Tipo)}>
              {TIPOS.map(([t, rotulo]) => <option key={t} value={t}>{rotulo}</option>)}
            </select>
          </label>
          <label className={styles.campo}><span className={styles.rotulo}>{atual ? 'Nova chave Pix' : 'Chave Pix'}</span>
            <input aria-label="Chave Pix" name="pix-chave-recebimento" placeholder={placeholder} value={chave} disabled={ocupado}
              autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} data-lpignore="true" data-1p-ignore="true" data-form-type="other"
              onChange={(e) => setChave(e.target.value)} />
            <small>Use uma chave da conta da empresa. Confira com um Pix de teste de baixo valor antes de enviar aos clientes.</small>
          </label>
        </div>
        <div className={styles.pixAcoes}>
          <button type="button" className={styles.primario} disabled={!chave.trim() || ocupado || semCidade} onClick={() => pedirSenha('salvar')}>{atual ? 'Trocar chave' : 'Salvar chave'}</button>
          {atual && <button type="button" className={styles.secundario} disabled={ocupado} onClick={() => pedirSenha('remover')}>Remover chave</button>}
        </div>
      </>}
      {podeEditar && etapa === 'confirmar' && <>
        <p className={styles.pixResumo}>
          {acao === 'remover'
            ? <>Confirme sua senha para <strong>remover</strong> a chave Pix.</>
            : <>Confirme sua senha para salvar a chave <strong>{rotuloTipo(tipo)} {chave.trim()}</strong>. A chave define para onde vai o dinheiro dos clientes.</>}
        </p>
        <div className={styles.grade}>
          <label className={styles.campo}><span className={styles.rotulo}>Sua senha</span>
            <input aria-label="Sua senha" type="password" name="senha-confirmacao-pix" autoComplete="current-password" value={senha} disabled={ocupado}
              onChange={(e) => setSenha(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (senha) void confirmar(); } }} />
          </label>
        </div>
        <div className={styles.pixAcoes}>
          <button type="button" className={styles.primario} disabled={!senha || ocupado} onClick={() => void confirmar()}>{ocupado ? 'Confirmando…' : 'Confirmar'}</button>
          <button type="button" className={styles.secundario} disabled={ocupado} onClick={() => { setEtapa('editar'); setSenha(''); }}>Voltar</button>
        </div>
      </>}
    </>}
    {erro && <p className={styles.erro} role="alert">{erro}</p>}
    {sucesso && <p className={styles.sucesso} role="status">{sucesso}</p>}
  </section>;
}
