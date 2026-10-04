# Conferência visual curta — "Voltar às conversas" no celular e no teclado

**Situação:** preparada; **não executada**. Precisa de autorização explícita do Felipe ([OPERACAO_AGENTES.md](OPERACAO_AGENTES.md)) porque recria uma base sintética local.

| Fora de escopo | Motivo |
| --- | --- |
| Suítes PostgreSQL | Nada no banco mudou desde `78ed9d8` (4/4 e 39/39) |
| A 065 (V2b) | O título longo vem do cadastro |
| HTTPS | — |

Nada em staging, produção, Render ou Gupshup, nem no banco real `kidmais_manager`.

**O que confere:** a correção `9145e1d`. Até 760px, o título que vem depois do botão para a 120 px, e o botão (44 px + 8 px) fica abaixo do menu fixo (até 54 px). O teste estático `layout-celular.test.ts` cobre a conta; esta rodada mede a tela real.

## Alvo

| Item | Valor |
| --- | --- |
| HEAD | O commit que traz este documento (informado no pedido de autorização). Código = `9145e1d`; nenhum arquivo de código mudou depois |
| Base | `C:\Users\Glass\AppData\Local\Temp\kidmais-val-prontas-20261004-cd655b`. Hoje **não existe**; `vp.ps1 -Acao verificar` a aceita (só leitura) |
| Banco | `127.0.0.1:55502`, banco `kidmais_pacotes_v1_descartavel`, cluster próprio registrado pelo `vp.ps1` |
| Tela | `http://localhost:3050` (`next dev`), sem HTTPS |
| Login | Representante sintético de A (credencial gerada pelo `preparar`, fora do Git, nunca repetida em respostas) |
| Protegidos | Base da demo (`…-4b6271`, **parada**: não reiniciar nem tocar no `postmaster.pid`), `kidmais-pg-demo-atendimento`, `kidmais-pg-063`, `kidmais-pg-060` e o cluster da outra sessão em `D:\glass\KidMais Manager\ambientes-locais\pg-painel-multi-codex-20261004` (listagem com hashes antes e depois, só leitura) |

**Scripts** (fora do Git, `.local-ux/val-prontas/`; SHA-256 também na seção 7 do `MANIFESTO.txt`):

```
f0187dc0b88b2662bbe80655f881fda7f6cbe1763f2fbc2a9b5691652448db09 *vp.ps1
da4e01b19186ba4ac368ce99f47a3d30b9e98ef187980f821e9ebda417a44567 *guardas.ps1
c07a1bc10278320004174549754699e0c9f60164a374244e83f91d722440724c *processos.ps1
5f7d5d9e6dc4a841d35acb48fe2b9b07490e36f50f4bd929fbf551d64fda04e4 *preparar.mjs
a1ff73a1fff82c5a6bbc1be86531076a1392d5b1df11cf3b94bbaec0b1fea490 *voltar-medicao.js
5a8a8978cd75fad32a33005a3f475c98f4869761f94f8b8c91b28d4c044a04af *teste-offline.ps1
```

| Script | Mudança em relação à rodada `78ed9d8` |
| --- | --- |
| `vp.ps1`, `guardas.ps1`, `processos.ps1` | **Idênticos** |
| `preparar.mjs` | Só o comentário e o resumo final, que agora lê as contagens do banco (4 `SELECT count`, só leitura). Esse resumo roda pela primeira vez nesta rodada: se falhar, a rodada **para** e é reportada; não se corrige no meio |
| `voltar-medicao.js` | Novo. Só lê o DOM; o teste offline confere que não clica, foca, digita, chama a rede nem escreve. **Autoteste** numa página estática (`.local-ux/val-prontas/autoteste-voltar/`): com 72 px detectou o botão a 20 px com 1224 px² sob o menu; com 120 px, a 68 px e sem sobreposição |
| `teste-offline.ps1` | 54/54 |

## Operações (só estas)

| # | Comando | Efeito |
| --- | --- | --- |
| V0 | `vp.ps1 -Acao verificar -Base <base>` + conferência de HEAD, hashes, portas e protegidos | Só leitura |
| V1 | `vp.ps1 -Acao subir -Base <base>` | `initdb` + cluster em 55502 com id registrado |
| V2 | `vp.ps1 -Acao preparar` | Migrations até a 064 + dados sintéticos (sem a 065) |
| V3 | `vp.ps1 -Acao iniciar` | `next dev` em 3050 |
| V3c | `vp.ps1 -Acao conferir`, antes e depois dos casos | Só leitura; precisa dar `saidas_total = 0` |
| V4 | `vp.ps1 -Acao encerrar` | Para o Next e o cluster; remove **só** a base registrada |

**Regras:**
- nenhuma conversa é assumida e nenhuma resposta é enviada;
- antes de **cada** tecla roda `voltar-medicao.js`, que precisa devolver `envioBloqueado = true`; se não devolver, a tecla não é enviada e o caso para;
- divergência de HEAD, hash, porta ou identidade = parar e reportar, sem retomar com script alterado.

## Casos

A medição (colar `voltar-medicao.js` no `javascript_tool`) é a evidência. As capturas ilustram; se uma captura vier com a rolagem atrasada, repete-se depois de uma espera.

| Caso | Viewport e ação | Esperado |
| --- | --- | --- |
| C1 celular, toque | 375×812; tocar no cartão **0106** (título longo) | Foco no título; `titulo.topo` ≈ 120; `voltar.topo` ≥ 62 (fim do menu 54 + 8); `sobreposicaoMenuPx = 0`; `voltarCortadoNoTopo = false`; sem rolagem horizontal; captura |
| C2 celular, teclado | 375×812; Tab até o cartão **0105**, Enter; depois Shift+Tab; depois Enter no "Voltar" | 1. Enter: igual ao C1, com o foco no título. 2. Shift+Tab: foco no "Voltar às conversas", visível e sem sobreposição. 3. Enter no Voltar: foco de volta ao cartão 0105, visível. Captura em cada passo |
| C3 faixa intermediária | 780×900; abrir o 0106 | Botão **oculto**; `titulo.topo` ≈ 72 (regra antiga, inalterada); título abaixo do menu; sem rolagem horizontal |
| C4 desktop | 1280×800; abrir o 0106 | Botão oculto; menu não fixo; nada muda |
| C5 saídas | V3c depois dos casos | `saidas_total = 0`; Next sem chamadas de envio, erros nem 5xx |

Tempo estimado: 20 minutos.
