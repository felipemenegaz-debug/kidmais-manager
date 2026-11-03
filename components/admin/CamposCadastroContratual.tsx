'use client';
import {
  CAMPOS_CADASTRO, CAMPOS_ENDERECO, CAMPOS_ENDERECO_EXIGIDOS, CAMPOS_IDENTIFICACAO, CAMPOS_OBRIGATORIOS, enderecoInformado, type CadastroContratual,
} from '@/lib/clientes/cadastro-contratual';
import ui from './importacao/integracao.module.css';
import { propsCampo } from '@/lib/ui/erros-formulario';

type Campo = keyof CadastroContratual;
const TIPO: Partial<Record<Campo, string>> = { email: 'email', whatsapp: 'tel' };
const NUMERICO: ReadonlyArray<Campo> = ['cpf', 'whatsapp', 'cep'];
const AUTOCOMPLETE: Partial<Record<Campo, string>> = {
  nomeCompleto: 'name', whatsapp: 'tel', email: 'email', cep: 'postal-code', logradouro: 'address-line1', complemento: 'address-line2',
  cidade: 'address-level2', uf: 'address-level1',
};
const DICA: Partial<Record<Campo, string>> = {
  whatsapp: 'Com DDD. É o contato usado nas confirmações do contrato.',
  uf: 'Duas letras, ex.: DF.',
};
const inclui = (lista: ReadonlyArray<Campo>, k: Campo) => lista.includes(k);

/**
 * Dados do contratante na conferência de contrato histórico. Mesmas classes dos demais campos do assistente
 * (integracao.module.css). O telefone fixo não aparece: confundia com o WhatsApp e o valor já cadastrado é preservado.
 * `invalidos` traz a mensagem por campo (do schema) para marcar o input e ligar a descrição acessível.
 */
export default function CamposCadastroContratual({ value, onChange, cpfProtegido = false, invalidos = {}, pessoaJuridica = null }: {
  value: CadastroContratual; onChange(value: CadastroContratual): void; cpfProtegido?: boolean;
  invalidos?: Partial<Record<Campo, string>>;
  /** Entrega B: cliente PJ. CPF e RG não aparecem; o nome é a razão social; CNPJ e representante só são exibidos. */
  pessoaJuridica?: { cnpj: string; nomeFantasia: string | null; representante: string | null } | null;
}) {
  // Endereço: o bloco inteiro é opcional, mas, informado qualquer campo, logradouro/número/bairro/cidade/UF passam a ser exigidos.
  const comEndereco = enderecoInformado(value);
  const identificacao = pessoaJuridica ? CAMPOS_IDENTIFICACAO.filter(k => k !== 'cpf' && k !== 'rg') : CAMPOS_IDENTIFICACAO;
  const opcional = (k: Campo) => inclui(CAMPOS_OBRIGATORIOS, k) ? false : inclui(CAMPOS_ENDERECO_EXIGIDOS, k) ? !comEndereco : true;
  const campo = (k: Campo) => {
    const erro = invalidos[k];
    const dica = k === 'cpf' && cpfProtegido ? 'CPF já cadastrado no cliente; não pode ser substituído aqui.' : DICA[k];
    // ID estável (N1/N2): `cadastro-<campo>`; a mensagem de erro fica logo abaixo e a dica continua descrita.
    const id = `cadastro-${k}`;
    const dicaId = dica ? `${id}-dica` : undefined;
    return <label key={k} className={ui.campo}>
      <span>{k === 'nomeCompleto' && pessoaJuridica ? 'Razão social' : CAMPOS_CADASTRO[k]}{opcional(k) ? ' (opcional)' : ''}</span>
      <input {...propsCampo(id, erro, dicaId)} type={TIPO[k] ?? 'text'} inputMode={inclui(NUMERICO, k) ? 'numeric' : undefined} autoComplete={AUTOCOMPLETE[k]}
        maxLength={k === 'uf' ? 2 : 200} value={value[k]} disabled={k === 'cpf' && cpfProtegido} required={!opcional(k)}
        onChange={e => onChange({ ...value, [k]: e.target.value })} />
      {erro && <small id={`${id}-erro`} className={ui.campoErro}>{erro}</small>}
      {dica && <small id={dicaId}>{dica}</small>}
    </label>;
  };
  return <fieldset className={ui.grupo}>
    <legend>Dados do contratante</legend>
    <p className={ui.ajuda}>{pessoaJuridica ? 'Confira razão social e WhatsApp.' : 'Confira nome, CPF e WhatsApp.'} E-mail e endereço são opcionais; se informar o endereço, complete-o. Ao concluir, estes dados também são salvos no cadastro do cliente.</p>
    <p className={ui.subtitulo}>Identificação e contato</p>
    {pessoaJuridica && <dl className={ui.resumo}>
      <div><dt>Tipo</dt><dd>Pessoa jurídica</dd></div>
      <div><dt>CNPJ</dt><dd>{pessoaJuridica.cnpj}</dd></div>
      {pessoaJuridica.nomeFantasia && <div><dt>Nome fantasia</dt><dd>{pessoaJuridica.nomeFantasia}</dd></div>}
      <div><dt>Representante</dt><dd>{pessoaJuridica.representante ?? 'Não informado'}</dd></div>
    </dl>}
    {pessoaJuridica && <p className={ui.ajuda}>CNPJ e representante vêm do cadastro do cliente e não são alterados aqui.</p>}
    <div className={ui.grade}>{identificacao.map(campo)}</div>
    <p className={ui.subtitulo}>Endereço <span>{comEndereco ? 'complete os campos marcados' : 'opcional'}</span></p>
    {/* D-IMP-3: na importação o endereço não bloqueia, mas a falta dele é sempre avisada. */}
    {!comEndereco && <p className={ui.alerta} role="status">Contrato sem endereço do contratante. Você pode concluir assim, mas o cadastro do cliente ficará incompleto até o endereço ser informado.</p>}
    <div className={ui.grade}>{CAMPOS_ENDERECO.map(campo)}</div>
  </fieldset>;
}
