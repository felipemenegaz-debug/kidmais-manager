const fs=require('node:fs'),path=require('node:path');
const workspace='D:/glass/KidMais Manager';
const vault=path.join(workspace,'Kidmais-Manager-Second-Brain');
function acrescentar(p,texto){const antes=fs.readFileSync(p,'utf8');const eol=antes.includes('\r\n')?'\r\n':'\n';const linhas=texto.replace(/\r\n/g,'\n').replace(/\n/g,eol);if(antes.includes('<!-- FUNIL-EXTRA-INDEPENDENTE-20261114 -->'))throw Error('registro já existente: '+p);fs.appendFileSync(p,eol+linhas+eol);}
const parecer='<D:/glass/KidMais Manager/kidmais-manager-funil-oportunidades-20261114/docs/PARECER_ASTRA_FUNIL_EXTRA_INDEPENDENTE_20261114.md>';
acrescentar(path.join(vault,'02 - Kidmais Manager SaaS/07 - Roadmap/Funil de oportunidades proposta 20261114.md'),`<!-- FUNIL-EXTRA-INDEPENDENTE-20261114 -->
## Conferência extra independente — Codex — 14/11/2026, 19:16 UTC

**APROVADO LOCALMENTE no escopo P2-R2-1 e regressão em conversão/atribuição: zero P1/P2 e nenhum novo P3.** Esta conversa não participou da implementação/correção. O parecer extra das 18:58, feito no mesmo chat do implementador, foi excluído como evidência e permanece apenas histórico. Autoria desta revisão: Codex em conversa independente; não atribuir a outro agente/modelo. É a única conferência extra restrita autorizada por Felipe após o teto, sem nova rodada automática.

Provas próprias: PostgreSQL 18 novo em 127.0.0.1:55834, somente filho marcado em E:/kidmais-pg-descartavel/funil-oportunidades, receita e conector oficiais. Runner canônico cinco arquivos/44 testes PASS nos modelos 086 e 122; 26 testes sem banco e TypeScript PASS. Nove grupos próprios PASS, incluindo controle com fonte R2 cujo hash confere com manifesto anterior (vínculo sem atribuição), herança completa para novo/recorrente, primeira origem e origem própria preservadas, painelMarketing real na campanha correta, COMMIT, idempotência sem escritas, recusas409/404 e rollback de falhas controladas em atribuição/histórico. Não repetidos build/static completo, suíte PG inteira, navegador, carga, concorrência, mutantes ou Node 22 declarado; runtime Node 24.20.0.

Integridade: 56/56 arquivos e 77/77 evidências conferidos; 13 intocados continuam iguais, fotografias dos 3.221 arquivos de código iguais ao fim. Produto intacto, sem commit/push/PR/operação real. Intercorrências restritas ao sandbox e à montagem inicial da fixture própria, corrigidas somente nas provas; logs preservados. Cluster parado/apagado às 19:13 UTC; dependências próprias removidas pela rotina oficial (0,42 GB); guardas brutas preservadas e temporário próprio retirado. [Parecer independente](${parecer}), provas em docs/evidencias/funil-extra-independente-20261114.

Próximo: organizador considerar este parecer independente no mesmo item da fila; reconciliação futura com a frente de simplificações continua pendência de integração conhecida. Área da família antes do Funil. Nada publicado e nenhuma autorização operacional inferida.`);
acrescentar(path.join(vault,'02 - Kidmais Manager SaaS/07 - Roadmap/Fila unica 20261111.md'),`<!-- FUNIL-EXTRA-INDEPENDENTE-20261114 -->
**14/11/2026, 19:16 UTC — Funil, conferência extra independente concluída (Codex): APROVADO LOCAL no escopo P2-R2-1/conversão/atribuição, zero P1/P2/novo P3.** Provas novas44 PG + 26 sem banco + 9 grupos próprios e TypeScript PASS; código intacto, cluster/dependências próprios limpos. Conversa independente, parecer extra anterior excluído como evidência. [[Funil de oportunidades proposta 20261114#Conferência extra independente — Codex — 14/11/2026, 19:16 UTC|Parecer, provas e limites]]. Mesmo item, sem nova frente/rodada/commit/publicação; Área antes do Funil.`);
acrescentar(path.join(vault,'02 - Kidmais Manager SaaS/07 - Roadmap/SaaS - Roadmap.md'),`<!-- FUNIL-EXTRA-INDEPENDENTE-20261114 -->
> **14/11, 19:16 UTC — Funil, extra independente Codex: APROVADO LOCAL**, P2-R2-1 encerrado; zero P1/P2/novo P3. Provas próprias 44 PG + 26 sem banco + 9 grupos, TypeScript e integridade PASS. [[Funil de oportunidades proposta 20261114#Conferência extra independente — Codex — 14/11/2026, 19:16 UTC|Parecer e limites]]. Sem commit/publicação; Área antes do Funil; nenhuma nova rodada.`);
const home=path.join(vault,'02 - Kidmais Manager SaaS/Kidmais Manager SaaS - Home.md');
const antes=fs.readFileSync(home,'utf8');
const antiga='- [[Funil de oportunidades proposta 20261114]] — PROPOSTA 14/11/2026: funil com próxima ação e motivo de perda; aguarda D-FU-1..4 de Felipe; nada implementado.';
if(!antes.includes(antiga))throw Error('índice divergiu; conferir antes de editar');
fs.writeFileSync(home,antes.replace(antiga,'- [[Funil de oportunidades proposta 20261114]] — IMPLEMENTADO LOCAL, sem commit/publicação. Conferência extra independente Codex em 14/11/2026, 19:16 UTC APROVADA no escopo P2-R2-1/conversão/atribuição, zero P1/P2/novo P3; provas próprias. Área da família vem antes para integração.'));
const relato=path.join(workspace,'orquestracao/relatos.md');
const eol=fs.readFileSync(relato,'utf8').includes('\r\n')?'\r\n':'\n';
const linhas=[
'2026-11-14 19:16 UTC | Codex | Funil | Mudou: parecer EXTRA INDEPENDENTE aprovado localmente no P2-R2-1/conversão/atribuição; produto intacto, vault/índices atualizados.',
'Testado: 44 PG em 5 arquivos/modelos 086 e 122; 26 sem banco; 9 grupos próprios com controle R2, COMMIT, idempotência, recusas e rollback; TS; hashes 56+77 e 3.221 arquivos iguais.',
'Falhou: DNS/loopback no sandbox e fixture própria incompleta nas primeiras tentativas; só provas ajustadas, repetição final PASS; zero P1/P2/novo P3.',
'Falta: integração conforme fila e reconciliação futura do módulo homônimo; limpeza própria concluída (cluster 55834, temporário e 0,42 GB de dependências); sem nova rodada.',
'Precisa de Felipe: nenhuma ação para encerrar esta conferência; commit/PR/publicação continuam fora da autorização; Área da família antes do Funil.'
];fs.appendFileSync(relato,eol+linhas.join(eol)+eol);
console.log('Nota, fila, índices e relato de cinco linhas atualizados; finais de linha preservados.');
