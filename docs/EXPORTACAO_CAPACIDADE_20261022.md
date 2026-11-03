# Exportação em blocos e capacidade — 22/10/2026

Estado: implementação e ensaios locais; revisão independente APROVADO com ressalvas P3, fechadas localmente (seção final) e aguardando conferência do revisor; homologação pendente. Branch `codex/exportacao-blocos-capacidade-20261022`, base `326895eaef59eb926e34397220df333cdf754b4e`. Sem migration, push, deploy ou upgrade de RAM.

## Alteração

Os PDFs atravessam o driver PostgreSQL em blocos de até 1 MiB, usando `substring(bytea)` e gravador temporário incremental. Cada consulta mantém o filtro da empresa e a mesma transação REPEATABLE READ. Tamanho final e SHA-256 precisam conferir com o inventário. PDF vazio não existe no banco (`CHECK tamanho_bytes>0 AND tamanho_bytes=octet_length(conteudo_pdf)`, migration 013); o caminho de 0 bytes, sem nenhuma consulta de bloco, só é exercido pelo executor falso dos unitários. Bloco ausente, truncado ou adulterado recusa o pacote inteiro. O gravador trata escritas parciais no arquivo (testado com escrita de metade e de 1 byte por chamada). ZIP e formato externo permanecem compatíveis.

Isso limita o buffer de cada leitura, não a memória total do Next/Node. O PostgreSQL pode ter custo adicional de consultas e descompressão TOAST. O ensaio anterior de 430 MB era outro processo/cenário; não serve como controle direto para calcular uma porcentagem de melhoria.

## Método

Cluster sintético exclusivo PostgreSQL 18, porta 55831; servidor `next start` em 127.0.0.1:35831, build de produção. Uma empresa, 1.000 clientes iniciais, quatro PDFs aleatórios de 35 MiB cada. Sessões distintas já autenticadas: 5/10/20/40 usuários, 30 segundos por rodada, pausa de 500 ms após cada requisição. Aproximadamente 10% de cadastros de clientes; restante clientes, dashboard, contratos, festas e assinatura. Uma exportação iniciada aos 3 segundos em cada rodada correspondente.

Sonda no processo web amostra RSS a cada 200 ms e bloqueia conexões não loopback. Cliente de carga consome o download por fluxo. Métricas excluem PostgreSQL e gerador de carga, que são processos separados. As rodadas compartilham o mesmo processo web; GC e caches tornam os picos não lineares. O p95 considera as requisições comuns da rodada inteira, não somente a janela de exportação.

Windows local, CPU livre, sem limite rígido de 512 MiB e sem simulação de 0,5 CPU. Node 24.20.0 disponível, diferente do 22.23.2 declarado no projeto. Os resultados não homologam Render nem definem número máximo de usuários cadastrados/empresas.

## Verificações

- Unitários de exportação: 13/13; PostgreSQL real: duas suítes, 10 testes, modelo 089. Incluem identidade byte a byte, hashes, isolamento, fotografia concorrente, limites e limpeza em falha.
- Regressão estática: 3.265 testes e 103 testes do harness passaram; TypeScript passou; lint sem erros, um aviso preexistente em FinalidadeSkill.
- O build no sandbox foi interrompido por travamento de Turbopack/loopback; o build de produção separado fora do sandbox passou, assim como a verificação do PDF worker. Não registrar o comando agregado interrompido como PASS integral.
- Nenhum banco real ou serviço externo usado. Scripts e provas locais ficam neste checkout e em `../ambientes-locais/pg-descartavel-capacidade-20261022-relatorios`.

## Reprodução e próximos testes

Scripts: `scripts/pg-descartavel-capacidade-20261022.cjs` (ciclo exclusivo do cluster), `scripts/capacidade-local-20261022.cjs` (fixture e carga) e `scripts/capacidade-local-sonda.cjs` (RSS/rede). Exigem as autorizações literais e as portas declaradas nos próprios arquivos. Nova execução de banco segue a política operacional; não adaptar para banco real.

Antes de concluir que 512 MB atende produção: repetir em Linux/Node 22 com limite real de 512 MB e 0,5 CPU, testar duas exportações concorrentes, rajadas de login/cadastro/recuperação de senha, geração de PDF e carga prolongada com múltiplas empresas. O scrypt de senha usa N=131072 e r=8 (~128 MiB por operação); sessões pré-autenticadas não exercitam esse custo. Não diminuir segurança de senha para caber na memória.

Revisão independente do delta e homologação continuam pendentes. Decisão de upgrade deve considerar o pico combinado, erros/reinícios e latência sob o limite real, não um número arbitrário de contas.

## Resultados medidos

| Usuários | Exportação | Requisições | Pico RSS MiB | p95 ms | Exportação ms |
|---:|:---:|---:|---:|---:|---:|
| 5 | não | 285 | 197 | 61 | — |
| 5 | sim | 289 | 235 | 45 | 2503 |
| 10 | não | 580 | 261 | 40 | — |
| 10 | sim | 580 | 340 | 46 | 2434 |
| 20 | não | 1160 | 270 | 38 | — |
| 20 | sim | 1150 | 274 | 52 | 2453 |
| 40 | não | 2308 | 307 | 46 | — |
| 40 | sim | 2291 | 377 | 54 | 2255 |

Todas as 8643 requisições comuns concluíram sem erros; quatro exportações HTTP 200. Maior pico: 377 MiB. ZIPs de 146.915.003 a 147.233.130 bytes.

Evidência bruta: `.local-capacidade-2026-10-22T06-16-03-121Z/resultado.json`, `memoria.jsonl` e `next.log`; log `.local-capacidade-carga.log`. O processo web encerrou ao fim. Cluster sintético encerrado e removido, relatórios preservados em 22/10 às 06:20 UTC.

## Revisão independente — 22/10/2026

Adendo do revisor, sem alterar código. Parecer completo e provas: `../ambientes-locais/revisao-exportacao-blocos-20261022/PARECER.md`.

- **Delta de código: APROVADO**, com ressalvas P3. A suíte PG não prova semanticamente o filtro por empresa em cada bloco (mutante sem filtro morto só pela asserção textual do unitário); o laço de escrita parcial não tem teste. Correção do texto acima: PDF vazio não existe no banco (`CHECK tamanho_bytes>0`).
- Controle direto, mesmo processo e massa (4×35 MiB): acréscimo de RSS por exportação **+341–344 MiB na base `326895e` → +59–66 MiB em blocos**.
- Validações da revisão: unitários 13/13, PG 10/10 + 3/3 próprios (limites exatos, troca de empresa no bloco, adulteração), `check:v1:static` PASS com build, mutação 5/8. Tudo em Node 24.20.0.
- **Capacidade em 512 MiB: INCONCLUSIVA.** Não há Linux com cgroup autorizado: o WSL existente é do R.E.A e não foi usado. Carga local sem limite, 4 empresas e 40 sessões (25 por login real): pico **498 MiB** num login sobre a carga mista; 24 HTTP 500 por esgotamento do pool (10 conexões/5 s); p99 3,1 s; ZIPs íntegros e isolados; download cancelado limpo.
- Preexistente, P2: o limite de ORIGEM do login é **global** (`ip = null` na rota). 30 tentativas em 300 s bloqueiam todos os logins (provado: 31ª pessoa → 429).
- Validação só local; homologação e publicação não feitas.

## Ensaio sob limite real 512 MiB / 0,5 CPU — 22/10/2026

Autorizado por Felipe. Distro WSL2 dedicada (Ubuntu 24.04, kernel 6.18, cgroup v2), Node 22.23.2, PostgreSQL 18.6 fora do limite. App inteiro (`init-staging-data && npm start`) num serviço systemd com `MemoryMax=512M`, sem swap, `CPUQuota=50%`, `OOMPolicy=kill`, reinício automático e rede só loopback. Com Node 22: `check:v1:static` PASS e suítes PG de exportação PASS. A distro foi removida ao final.

- **Massa e roteiro:** 4 empresas e 40 pessoas, todas com **login real**. Degraus de 5/10/20/40 pessoas e 32 min de carga mista (leituras, 10% cadastros, 5% PDF de contrato), com exportações de 4×35 MiB, duas simultâneas, logins junto com exportação e SIGKILL seguido de recuperação.
- **Memória: zero OOM.** No pior caso (exportação + 10 logins + 40 pessoas), o cgroup chegou a 512 MiB e o kernel recuperou o cache de página 80 vezes. A memória não recuperável (anon) chegou a **299 MiB**. Exportações íntegras e isoladas.
- **CPU/pool:** com 40 pessoas, **0,44–1,6% de 5xx** (pool de 10 conexões, espera de 5 s), p99 de 5–13 s e logins com p95 de até 12 s. Com 5/10/20 pessoas, nenhum 5xx; p99 de 3–5 s.
- **Conclusão:** a memória de 512 MiB está comprovada só nos cenários medidos. A CPU de 0,5 com o pool atual é insuficiente para 40 pessoas ativas. Validação só local, não é homologação. Parecer: `../ambientes-locais/revisao-exportacao-blocos-20261022/PARECER.md` (adendo).

## Ressalvas P3 da revisão — fechamento local (22/10/2026)

Delta sobre o mesmo checkout, ainda sem commit; nada publicado. Aguarda a conferência do revisor.

| Id | Tratamento | Prova |
|---|---|---|
| P3-1 | Teste PG novo com duas empresas: o id do bloco 1 ou 2 da empresa A é trocado pelo PDF de mesmo tamanho da B. Com o filtro, o pacote é recusado (`bloco de PDF ausente`) e **nenhum byte da B atravessa**. Controle positivo na mesma rotina: a consulta do bloco sem o filtro devolve o bloco inteiro da B (1 MiB ou 99 bytes), que só o hash barra. Sem a troca, a A exporta normalmente. | Mutante M1 (filtro removido) agora **morto na suíte PG** pela asserção semântica (`bloco 1, filtro true`); mutante com `OR` no lugar do `AND` também morto. |
| P3-2 | `Gravador` exportado só para testes (construtor público). FileHandle falso que grava metade (10 chamadas para 1.000 bytes) e 1 byte por chamada: bytes, SHA-256, CRC-32 e tamanho exatos. 0 bytes → `escrita temporária sem progresso`, nada contabilizado; progresso parcial seguido de 0 também recusa. | M6 (uma escrita só) e M6b (0 bytes vira `break`) mortos. |
| P3-3 | `pacote.ts:382`: teste com tamanho -1, 1,5, `'14'` (texto), NaN e 2^53 no cursor → `tamanho de PDF inválido` antes de qualquer consulta de bloco, sem temporários. `pacote.ts:402` (tamanho final): **justificado, sem teste**. É inalcançável pelo banco, porque cada bloco já precisa ter exatamente o tamanho pedido e os blocos somam `tamanho`; só falharia por defeito no `Gravador`. Fica como defesa em profundidade, com comentário no código. | M7 morto; M8 sobrevive, como esperado. |
| P3-4 | O `fechar()` do gravador de PDF segue o mesmo padrão do `CLOSE` do cursor: depois de um erro de bloco, a falha do `close` é engolida e a causa original sobe; sem erro anterior, a falha do `close` é lançada. | Teste com `close` que fecha de verdade e depois falha: com erro no 2º bloco sobe `falha sintética no segundo bloco`; sem erro sobe `close sintético`; pasta e cursores limpos nos dois casos. A versão anterior (sem o `.catch`) falha o teste. |
| P3-5 | Texto da seção Alteração corrigido (acima). | — |
| X-5 | **Decidido: manter a limpeza por idade (1 h).** Sem marcador de dono, a idade é o único critério seguro: o `tmpdir()` pode ser compartilhado por outro processo da mesma máquina (dois `next start`, dev + start, ensaios), e apagar no início do processo poderia remover a pasta de uma exportação viva alheia. A sobra é limitada: no máximo uma pasta por queda (`MAXIMO_SIMULTANEAS = 1`), de até ~280 MiB nos 150 MB de dados. A guarda de disco (507 `semEspaco`) impede que ela vire pacote parcial, e a próxima exportação depois de 1 h a remove. Se um dia a sobra pesar, o caminho é um marcador de dono (pid + início do processo) na pasta, e não a limpeza cega. | — |

Observação fora das ressalvas (base `326895e`, não alterada): o `fechar()` do gravador de **CSV** (`finally` do laço de entidades) tem o mesmo padrão que P3-4 corrigiu no de PDF. Registrado para a próxima rodada, sem mudança aqui para não ampliar o delta revisado.

Validações desta rodada (Windows, Node 24.20.0):

- Unitários de exportação: **16/16**.
- PostgreSQL 18.6 real, cluster sintético próprio `127.0.0.1:55831`, diretório novo e porta livre conferidos antes: **11/11** (5 + 6), código 0. Relatório: `../ambientes-locais/pg-descartavel-capacidade-20261022-relatorios/2026-10-22T08-53-41-538Z-check-v1-postgres.log`. Os relatórios de 08:55 (M1 e M1b) são as rodadas de mutação, que falharam como esperado.
- Cluster encerrado (`pg_ctl status` 3), diretório removido e porta 55831 livre.
- `check:v1:static`: **PASS**, código 0. Foram 3.268 unitários e 103 do harness; ESLint sem erros, com 1 aviso preexistente; TypeScript, build e PDF worker passaram. Log: `../ambientes-locais/pg-descartavel-capacidade-20261022-relatorios/2026-10-22-p3-check-v1-static-2.log`. A 1ª execução (`…-static.log`, código 2) apontou um erro de tipo no novo teste P3-3, que foi corrigido só no arquivo de teste e não afeta `pacote.ts` nem a suíte PG.
- Ainda não foi feito: rodar com Node 22.23.2 e conferência do revisor.

## Conferência das ressalvas P3 — 22/10/2026

Revisão independente: **APROVADO**. P3-1 a P3-5 estão fechadas e a decisão X-5 foi aceita.
- Unitários 16/16 e PG 11/11, num cluster próprio.
- `check:v1:static` PASS.
- Mutação 10/11: o mutante sem filtro de empresa e a variante com `OR` agora morrem na suíte PG. Só sobrevive a conferência redundante do tamanho final, como estava documentado.
- Fica para a próxima rodada: o mesmo padrão do P3-4 no `fechar()` do CSV.

Validação local. Parecer: `../ambientes-locais/revisao-p3-login-20261022/PARECER.md`.
