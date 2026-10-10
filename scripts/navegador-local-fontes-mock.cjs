// Respostas simuladas do next/font/google para o servidor local de navegador (docs/NAVEGADOR_LOCAL_20261010.md).
// O Next (inclusive o Turbopack, que avalia este arquivo isolado: nada de require) lê NEXT_FONT_GOOGLE_MOCKED_RESPONSES
// e usa mockFile[url] no lugar de buscar o CSS em fonts.googleapis.com; os arquivos de fonte só seriam buscados se o CSS
// os citasse. Aqui o CSS só declara src: local(...): nenhuma url(), nenhuma chamada externa; as páginas usam fonte do
// sistema. O @font-face é obrigatório no modo webpack ("Font loaders must return one or more @font-face's").
// Chaves = URLs exatas das fontes declaradas no app (app/layout.tsx, components/site/fonte.ts, components/admin/fonte.ts),
// conferidas no teste contra getFontAxes/getGoogleFontsUrl do próprio Next. Fonte nova no app = acrescentar aqui.
const CSS = "/* fontes remotas desligadas no teste local */\n@font-face { font-family: 'Fonte Local'; font-style: normal; font-weight: 400; src: local('Arial'); }\n";
module.exports = {
    'https://fonts.googleapis.com/css2?family=Geist:wght@100..900&display=swap': CSS,
    'https://fonts.googleapis.com/css2?family=Geist+Mono:wght@100..900&display=swap': CSS,
    'https://fonts.googleapis.com/css2?family=Inter:wght@100..900&display=swap': CSS,
    'https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,200..800&display=swap': CSS,
    'https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600&display=swap': CSS,
};
