/** Uma linha ao iniciar o processo com o estado da troca de host (plano D4), sem o valor de nenhuma variável. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { linhaDeLogDoEndereco } = await import('./lib/enderecos/diagnostico');
  console.info(linhaDeLogDoEndereco(process.env));
}
