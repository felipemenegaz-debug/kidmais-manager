import { readFileSync, writeFileSync } from 'node:fs';
import { modelosBiblioteca, planetasModelo, svgModelo } from '../lib/convites/modelos.ts';
import { inicioConteudo } from '../lib/convites/domain.ts';

// Recursos locais e CC0; nunca consulta APIs ou dados de festas.
const planetas = planetasModelo.map(url => `data:image/webp;base64,${readFileSync(`public${url}`).toString('base64')}`);
for (const tema of modelosBiblioteca) {
  const c = { ...inicioConteudo({}), tema, nome: 'Lucas', idade: '5 anos', mensagem: 'Venha comemorar comigo!', data: '2027-04-20', horario: '15:00', local: 'Buffet KidMais', endereco: 'Asa Norte · Brasília' };
  writeFileSync(`public/convites/modelos/${tema}.svg`, svgModelo(c, { planetas, miniatura: tema !== 'planetas' }));
}
