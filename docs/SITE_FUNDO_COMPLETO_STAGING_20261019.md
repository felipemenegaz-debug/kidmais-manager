# Fundo em todas as seções do site de venda — 19/10/2026

Pedido de Felipe: estender os efeitos das duas primeiras seções às demais partes de `/conheca`, continuando a publicação em staging.

## Alteração

- Dez regiões decorativas cobrem abertura/antes-depois, diferenciais, recursos, Wall-e, convite, como funciona, confiança, planos, dúvidas e contato final.
- Mesmo gradiente, raios suaves e corações ao clique. Até três figuras esparsas por nova região no desktop e duas no celular; omite quando não há espaço. A abertura mantém o limite anterior.
- Caixas, textos, links e controles protegidos no posicionamento. Abas, FAQ e ciclo dos planos recalculam os espaços livres.
- Cada região tem pausa. Só regiões a até 160 px da tela inicializam o renderer. Ao sair, remove listeners/observers, libera programa e contexto WebGL e remove o canvas GPU; reentrada cria um novo. Canvas 2D fora da tela reduzido a 1×1.
- Conteúdo, regras, links e preços preservados. `/planos` independente, páginas administrativas, bancos, variáveis, cron e produção não são alterados.

## Base e validação

Integrado `origin/staging` `bd9bd674fbb9744532c87b9ab4fa8149ec8535a5` sem conflitos, preservando atualizações anteriores. LIVE antes desta rodada: `b6c5698`, deploy `dep-dbb3rpafngtc739q4ng0`. O delta remoto ainda não publicado contém somente CI, documentação e scripts manuais de migrations; nenhum código runtime adicional e nenhum desses scripts é executado pelo start/build desta operação.

- Testes pertinentes: 11/11 (site 8 e geometria 3).
- TypeScript, lint dos arquivos tocados e build final: passaram (76 páginas).
- Revisão independente: P2 sobre retenção de contextos corrigido; revisão final aprovada.
- Navegador local com build de produção: desktop 1280 px e mobile 390 px sem overflow e sem erros; Recursos, aba Financeiro e FAQ expandida conferidos. Ida à seção Dúvidas e retorno ao topo: dois canvases GPU perto de Dúvidas, um WebGL recriado no topo, sem acúmulo das dez regiões.
- Figuras reduzidas após inspeção para manter o aspecto esparso; build final repetido e mobile Recursos conferido.
- Sem envio de formulários nem testes em banco. Redução de movimento e fallback revisados, não simulados nesta rodada.

Publicação: somente web staging `srv-daif418ae00c73e8k2gg`, auto-deploy OFF, workspace `tea-daidbj95efls73d2bcf0`. Produção em branch production e cron com auto-deploy OFF. Resultado do deploy será registrado após LIVE e health.
