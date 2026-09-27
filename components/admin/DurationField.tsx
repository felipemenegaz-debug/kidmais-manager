import { useId } from 'react';
import styles from './workspace.module.css';
import { AjudaCampo } from './AjudaCampo';

export function DurationField({ horas, minutos, onChange, ajuda }: { horas: string; minutos: string; ajuda?: string; onChange: (value: { horas: string; minutos: string }) => void }) {
  const id = useId();
  return <fieldset className={styles.duration}><legend>Duração da festa *</legend>{ajuda && <AjudaCampo texto={ajuda} />}<div>
    <label htmlFor={`${id}-h`}>Horas<input id={`${id}-h`} type="number" min="0" max="24" step="1" inputMode="numeric" value={horas} onChange={e => onChange({ horas: e.target.value, minutos })} placeholder="0" /></label>
    <label htmlFor={`${id}-m`}>Minutos<input id={`${id}-m`} type="number" min="0" max="59" step="1" inputMode="numeric" list={`${id}-opcoes`} value={minutos} onChange={e => onChange({ horas, minutos: e.target.value })} placeholder="00" /></label>
    <datalist id={`${id}-opcoes`}>{['00','15','30','45'].map(value => <option key={value} value={value} />)}</datalist>
  </div></fieldset>;
}
