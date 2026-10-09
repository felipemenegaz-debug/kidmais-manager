import styles from './site.module.css';
export const cx = (...nomes: string[]) => nomes.flatMap(nome => nome.split(/\s+/)).filter(Boolean).map(nome => styles[nome]).filter(Boolean).join(' ');
