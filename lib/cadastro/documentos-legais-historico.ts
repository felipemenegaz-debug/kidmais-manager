/**
 * Catálogo das versões PUBLICADAS dos documentos legais anteriores às vigentes (grupo B, revisão 00cecac, P2-B2): texto
 * canônico e SHA-256 de cada versão, reconstruídos do histórico do Git da base staging 326895e com o módulo de cada
 * commit (gerado; não editar à mão), mais as vigentes do staging fc3e857f (commit d9bf69ff), substituídas pela R-5, e as R-5 2026-11-15 (commit b4997343, LIVE em staging 16/11/2026), substituídas pelas 2026-11-17. Permite recuperar o texto exato de aceites antigos, conferido pelo hash. Versões
 * locais nunca publicadas ficam fora. Versão sem texto aqui nem no banco é lacuna explícita (404), nunca trocada.
 */
import { VERSOES_DPA } from './documentos-legais-historico-dpa.ts';
import { VERSOES_PRIVACIDADE } from './documentos-legais-historico-privacidade.ts';
import { VERSOES_TERMOS_USO } from './documentos-legais-historico-termos.ts';

export type VersaoPublicada = { documento: 'TERMOS_USO' | 'PRIVACIDADE' | 'DPA'; versao: string; hash: string; commit: string; conteudo: string };
/**
 * Ordem por documento e versão (DPA, PRIVACIDADE, TERMOS_USO), a do gerador. O texto fica em um arquivo por documento
 * (18/11/2026): o arquivo único passou de 32 KB comprimido e não cabia numa parte da entrega do B-14
 * (scripts/bloco-shell-recuperacao-b14.cjs), que não divide arquivos.
 */
export const VERSOES_PUBLICADAS: readonly VersaoPublicada[] = [...VERSOES_DPA, ...VERSOES_PRIVACIDADE, ...VERSOES_TERMOS_USO];
