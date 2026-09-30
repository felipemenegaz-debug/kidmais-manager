import type { Categoria } from './conversa';
import styles from './inteligencia.module.css';

/**
 * Selo da natureza de cada resposta, sempre em texto (nunca só cor) e sem nenhum número de certeza do modelo:
 * o operador precisa saber se está vendo um dado do sistema, uma sugestão para revisar, algo que só acontece
 * com o clique dele ou um erro.
 */
export const ROTULOS_CATEGORIA: Readonly<Record<Categoria, string>> = {
  informacao: 'Informação',
  sugestao: 'Sugestão · revise antes de usar',
  confirmacao: 'Exige sua confirmação',
  erro: 'Não foi possível',
};

export default function SeloCategoria({ categoria }: { categoria: Categoria }) {
  return <span className={styles.categoria} data-categoria={categoria}>{ROTULOS_CATEGORIA[categoria]}</span>;
}
