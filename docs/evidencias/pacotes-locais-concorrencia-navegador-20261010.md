# Evidência — pacotes locais de concorrência e navegador (10/10/2026)

Autorização de Felipe: pacotes locais de concorrência e navegador para a candidata `23a203ac34c831cd8fe662503768f468aad9d5a2`, PostgreSQL descartável em 55480/55481 e servidor em `localhost:3481`; só dados sintéticos; sem banco real, Render ou serviços externos; parar os processos e **preservar** clusters e evidências (sem remover as pastas). Pacote 3, push e staging não autorizados.

## Pré-condições (as duas frentes)

`HEAD` = candidata; `git diff --name-only 6acdb60 HEAD` só `docs/`; árvore limpa; nenhum `.env*`; nenhuma `DATABASE_URL`/`PG*`/`ASSINATURA_*_DIAS` no ambiente; PostgreSQL 18.6 em `C:/Program Files/PostgreSQL/18/bin`; portas 55480, 55481 e 3481 livres; planos offline `confere: true` (79 migrations, impressão `8a9a97477eac…3cfb`); testes offline 18/18 (navegador).

## Concorrência (C1–C5; C6 não executado por decisão de Felipe)

| Passo | Resultado |
|---|---|
| C1 criar | `.local-concorrencia-pg-5611eee035c1436c8966306858497f3d` |
| C2 iniciar | `INICIADO`, `127.0.0.1:55480` |
| C3 conferir | `CONFERE`, versão 180006, `cluster_name kidmais_concorrencia`, bancos `[]` |
| C4 executor | **exit 2 — `INCOMPLETO`**: schema aplicado (79 migrations / 201 arquivos, impressão conferida), falha no grupo `a` antes de qualquer verificação: `ERR_OUT_OF_RANGE` (`readUIntBE` com 7 bytes; o máximo é 6) no gerador de documento sintético das fixtures |
| C4b conferir | `CONFERE`, só o banco `kidmais_concorrencia_vagas_20261010` |
| C5 parar | `PARADO` |

Parada pelo critério do pacote (S2). Nenhuma matriz foi avaliada; nada a concluir sobre concorrência. A pasta (cluster parado, `resultado.json`, `progresso.log`, logs do servidor) está preservada para revisão.

## Navegador (0, A1, A2; A3 e A4 não executados)

| Passo | Resultado |
|---|---|
| A1 criar/iniciar/conferir | `.local-navegador-pg-5d5bd5cb8ca44e97b0d91f0ee6152239`, `127.0.0.1:55481`, `CONFERE`, bancos `[]` |
| A2 seed | **exit 2 — `INCOMPLETO`** na etapa `fixtures`: mesmo `ERR_OUT_OF_RANGE` (gerador de documento sintético). Schema aplicado (79/201, impressão conferida). **Nenhuma credencial gravada** (`.local-navegador/` não existe) |
| conferir + parar | só o banco `kidmais_navegador_20261010`; `PARADO` |
| A3 servidor / A4 navegador | **não executados**: o `next dev` buscaria fontes em `fonts.googleapis.com` (`next/font/google`, exceção registrada no §7 do pacote), serviço externo não autorizado; e o seed não concluiu |

Pasta preservada (cluster parado, `seed-resultado.json`, `seed-progresso.log`, logs).

## Correção preparada (não executada; exige nova aprovação)

- Gerador de documento sintético com 6 bytes nos dois scripts (`scripts/concorrencia-vagas-isolado.cjs`, `scripts/navegador-local-seed.cjs`); testes de regressão.
- Fontes sem rede: `scripts/navegador-local-fontes-mock.cjs` (objeto literal com as 5 URLs exatas das fontes do app, CSS sem fonte remota) e `NEXT_FONT_GOOGLE_MOCKED_RESPONSES` na lista fechada de variáveis do servidor, exigida pela autoverificação. Teste confere as chaves contra `getFontAxes`/`getGoogleFontsUrl` do próprio Next. Comprovado localmente: `next build` com o mock compila e gera as 61 páginas (uma URL ausente falha com `url not found`, o que aconteceu com a primeira versão do mock — nenhuma chamada externa ocorreu).
- Para a nova execução: os clusters atuais têm banco parcial; o pacote exige cluster novo (sem bancos). Remover as pastas atuais depende de autorização (C6/limpeza) ou usar novas pastas, mantendo as atuais.
