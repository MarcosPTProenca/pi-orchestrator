# Baseline real de uso (Pi + provedor)

Medição de `scripts/usage-real-pi.ts` com processos Pi reais e provedor real. Registra a #102.

## Ambiente

- Pi `1.5.2`; provedor `claude-bridge/claude-haiku-5-5` (`pi-claude-bridge` 0.12.0). Credencial Claude em arquivo; `quota-axi auth` reporta `available`. Nenhum segredo foi lido.
- Comando: `node --import tsx scripts/usage-real-pi.ts --real --real-ext <pi-claude-bridge>/src/index.ts --json-out <arquivo>`.
- Código medido: `fix/c1-worker-hang` (PR #211) sobre `master` com a PR #210 integrada.

## Resultado da rodada completa (11/11)

| Passo                                 | Exit  | Duração    |
| ------------------------------------- | ----- | ---------- |
| A1 consulta de status (sessão nova)   | 0     | 8,9 s      |
| A2 continuação (processo novo)        | 0     | 9,5 s      |
| A3a rajada: conclusão 1 (concorrente) | 0     | 13,7 s     |
| A3b rajada: conclusão 2 (concorrente) | 0     | 13,5 s     |
| B1 fork de A                          | 0     | 8,6 s      |
| B2 reinício no fork                   | 0     | 12,3 s     |
| D1 sessão ociosa: início              | 0     | 7,1 s      |
| D2 retomada após 10 s ociosa          | 0     | 12,7 s     |
| **C1 delegação (worker)**             | **0** | **73,9 s** |
| E1 orquestrador: consulta             | 0     | 37,1 s     |
| E2 orquestrador: continuação          | 0     | 15,3 s     |

C1: `usage.json` gravado; relatório `done` por `orch_report` (não por fallback); 3 turnos do worker (`ferramenta` 2, `extensao:ai-memory-handoff` 1). Tempo de modelo somado: 38,8 s. O restante do wall é startup do processo `pi` com as extensões globais e espera antes de a query começar (no log, intervalo de 25 s antes de `streamClaudeAgentSdk`).

Agregados (de-duplicados por `responseId`):

- Turnos: 13, falhas 0, tempo de modelo somado 140,4 s. Gatilho: `mensagem-de-usuario` 9, `ferramenta` 2, `extensao:ai-memory-handoff` 1, `indisponivel` 1.
- Entradas de assistant nos JSONL: 17; respostas únicas: 13. Soma sem de-duplicar: 202.092 tokens; de-duplicada: **185.168**.
- Totais de-duplicados: input 26, output 3.190, cacheRead 126.026, cacheWrite 55.926.
- Taxa de acerto de cache: `cacheRead / (input + cacheRead + cacheWrite)` = 126.026 / 181.978 = **69,3 %**.
- Custo: **não reportado** pelo `claude-bridge` (`costFromProvider: false`). Não estimado.
- Sessão ociosa: 0 turnos adicionados enquanto ociosa; 1 turno antes, 2 depois da retomada.
- Orquestrador: origem **indisponível**; 2 turnos; `totalTokens` 8.279.

## Variabilidade entre rodadas

Cache e latência variam muito entre rodadas. Por isso, a taxa de cache não deve ser lida como número único.

| Rodada | Código           | Passos com exit 0         | C1     | Cache hit | Total de-duplicado |
| ------ | ---------------- | ------------------------- | ------ | --------- | ------------------ |
| 1      | antes da PR #210 | 11/11                     | 15,0 s | 95,3 %    | 259.845            |
| 2      | com PR #210      | 10/11 (E2 estourou 180 s) | 16,5 s | 94,4 %    | 262.458            |
| 3      | com PR #210      | 11/11                     | 73,9 s | 69,3 %    | 185.168            |

Na rodada 2, o E2 (continuação do orquestrador) passou do timeout de 180 s. Não há log do bridge dessa execução (debug não estava ligado). Reproduzido de forma isolada (E1 + E2, 3 execuções) e na rodada 3: passou nos 4 casos, em 11 a 21 s. Causa não identificada. Hipótese, não confirmada: uma classe A (stream parado) no caminho do orquestrador, que não tem watchdog. Ver pendências.

## Semântica dos campos (`claude-bridge`)

- `input`: entrada não cacheada.
- `cacheRead`: entrada lida do cache do provedor.
- `cacheWrite`: entrada gravada no cache.
- `output`: tokens gerados.
- `totalTokens` = `input + output + cacheRead + cacheWrite`. Confirmado na rodada 3: 26 + 3.190 + 126.026 + 55.926 = 185.168.
- `cost`: não reportado por este provedor. Demais provedores não foram medidos.

## Causa do exit 124 no C1

A hipótese da versão anterior deste doc (o `worker-ext` reescreve o prompt em `before_agent_start` e trava) está **refutada**: o controle sem `worker-ext` também trava.

Foram observados quatro modos de falha:

| Classe                                         | Sinal observado                                                                                                                                      | Causa                                                                                       | Tratamento                                                                                   |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| A. Stream parado                               | Só o primeiro chunk chega, depois nada: nenhum texto gerado e nenhum `message_update` seguinte. Ocorre com e sem `worker-ext`.                       | `claude-bridge` não tem timeout de inatividade.                                             | Watchdog em `src/worker/stall-watchdog.ts`, só no worker.                                    |
| B. Marcação de ferramenta em loop              | `<parameter_type>` repetido 3.677 vezes (~70 mil caracteres). Só com `--no-tools`.                                                                   | O harness tirava `read`, `bash` e `orch_report`, mas o prompt pedia essas ferramentas.      | Harness usa lançamento de produção.                                                          |
| C. Trabalho fora do brief ou comando bloqueado | O modelo rodou `npm run quality` em outro repositório; ou `lavish-axi poll`, que espera humano.                                                      | Mensagem genérica "Execute a tarefa do brief." deixa o modelo procurar contexto de memória. | Mensagem de produção (`src/shared/launch.ts`); `bash` do worker tem timeout padrão de 900 s. |
| D. Processo não sai                            | Relatório gravado e turno concluído, mas o `pi` continuou vivo além do timeout. Também há `pi` que não sai com SIGTERM enquanto um turno está preso. | Não identificado.                                                                           | **Não corrigido.** Ver pendências.                                                           |

### Taxas por configuração

| Configuração                                          | Execuções | Exit 124 |
| ----------------------------------------------------- | --------- | -------- |
| Sem `worker-ext` (controle), `--no-tools`             | 8         | 2        |
| `worker-ext` original, `--no-tools`                   | 17        | 2        |
| `worker-ext` com watchdog, `--no-tools`               | 15        | 4        |
| Produção, mensagem genérica (antes da correção do C1) | 24        | 5        |
| **Produção, mensagem de lançamento de produção**      | **20**    | **0**    |

Em "Produção, mensagem genérica", as 5 falhas são: 2 de classe C (`lavish-axi poll`; `npm run quality` em outro repositório), 1 de classe D (relatório gravado, processo não saiu), 1 não classificada (nenhum turno; o debug do bridge não estava ligado nessa rodada), 1 de classe C com debug ligado.

Em "Produção, mensagem de lançamento de produção", as 20 execuções foram feitas com a mensagem de produção, de 11 a 30 s, todas com relatório `orch_report`.

Nota: as rodadas de produção não usaram a mesma versão do código. O timeout do `bash` e o reenvio pela `agent_settled` entraram no meio delas. A versão final foi revalidada pelo teste E2E de stall e pelas rodadas completas acima. A limpeza de lint que veio depois não muda comportamento.

## Watchdog de stream (classe A), verificado de ponta a ponta

Servidor local compatível com OpenAI, que trava depois do primeiro chunk. Worker real (`pi` + `worker-ext`).

- **Uma trava:** `stall.log` registra `retry=1` após ~90 s. O servidor vê o cliente fechar (abort observado). Retomada: requisição 2 respondida. Lembrete de `orch_report`: requisição 3. Exit 0 em 91 s (e 96 s na versão final, com a master integrada).
- **Trava em todas as tentativas:** `retry=1`, `retry=2` e `exhausted retries=2`, em 290 s. Relatório `failed` por fallback. Exit 1, sem travamento.

Durante a verificação apareceu um bug, corrigido: reenviar a retomada dentro de `agent_end` falha com "Agent is already processing". O reenvio agora ocorre em `agent_settled`, com o agente ocioso.

Limite conhecido: o watchdog aborta um turno que fica mais de 90 s sem nenhum `message_update`. Não há evidência de turno legítimo nessa situação; um turno assim seria abortado e retomado. O watchdog não cobre o orquestrador (classe A no E2, ver pendências).

## Timeout padrão do `bash` do worker (classe C)

`tool_call` define `input.timeout = 900` quando o modelo não informa. Verificado por três testes unitários (`test/worker-bash-timeout.test.ts`). Não foi exercido de ponta a ponta com um comando bloqueado de verdade.

## Acceptance da #102

| Critério                                                                         | Estado                                                                                                             |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Semântica de `input`, `cacheRead`, `cacheWrite`, `output`, `totalTokens`, `cost` | Feito para `claude-bridge`. Outros provedores não medidos.                                                         |
| Registro por turno e agregação por tarefa e sessão                               | Feito (13 turnos, por gatilho e modelo).                                                                           |
| Eventos de cache warming                                                         | **Não disponível** nesta medição: nenhum evento desse tipo apareceu no provedor.                                   |
| De-duplicação após fork e reinício                                               | Feito: 17 entradas viram 13.                                                                                       |
| Relatório com totais, cache hit ratio, custo e turnos automáticos                | Feito. Custo: não reportado pelo provedor. Cache: varia entre rodadas (69 % a 95 %).                               |
| Baseline: status, delegação, continuação, rajada, ociosa                         | **Parcial.** C1 fecha em todas as rodadas. Passos de sessão comum travam em ~15 % das queries; ver "Estabilidade". |
| Testes com fixtures (cache 0, campos ausentes, fork, reinício)                   | Já existem em `test/usage.test.ts` (38 testes), não alterados aqui.                                                |

## Estabilidade em rodadas sobre `master` 9386647

Rodadas feitas depois do merge da PR #211, sem alterar código. Cada rodada é o baseline completo com `CLAUDE_BRIDGE_DEBUG=1`.

| Rodada | Passos com exit 0 | Passos com timeout (180 s)       | C1                    | Cache hit | Total de-duplicado |
| ------ | ----------------- | -------------------------------- | --------------------- | --------- | ------------------ |
| 1      | 9/11              | A3a, A3b (rajada)                | 30,9 s, `orch_report` | 95,4 %    | 250.595            |
| 2      | 11/11             | nenhum                           | 23,0 s, `orch_report` | 94,9 %    | 261.949            |
| 3      | 8/11              | B1, B2 (fork), E2 (orquestrador) | 72,0 s, `orch_report` | 75,6 %    | 175.698            |

**C1 (worker, com `worker-ext`):** 3 de 3 rodadas completas e 10 de 10 execuções na forma de produção fecharam com `orch_report`. Nenhuma query do worker travou.

**Travamentos (5 de 33 queries de sessão comum):** em todos, a query recebe o primeiro chunk e não recebe mais nada. O bridge registra `fresh query` sem `for-await loop exited`. A rajada da rodada 1 travou nas duas queries ao mesmo tempo. Num caso, o CLI do Claude só registrou `Mid-stream server error after 1 block(s) yielded` cerca de 200 s depois do primeiro chunk. Nas sessões comuns não existe watchdog: a proteção de 90 s vale só para o worker.

**Vazamento de processo:** depois que o timeout encerrou o `pi`, um processo `claude` filho continuou vivo, reparentado ao `init`, por mais de 3 min. Ele começou no mesmo instante da query travada da rodada 3 (E2). Não está no repositório: vem do `pi-claude-bridge` 0.12.0. Este é o mesmo vazamento da classe D.

**Decisão pendente:** aplicar o watchdog também às sessões comuns (orquestrador e `pi` interativo). Isso aborta e retoma o turno do usuário, então muda comportamento visível. Não foi feito sem aprovação.

## Pendências

- Classe D: processo que não sai após o turno, ou que não sai com SIGTERM enquanto um turno está preso. Não corrigido.
- E2 intermitente (rodada 2): causa não identificada. Sem watchdog no orquestrador.
- Outros provedores (kiro, antigravity): não medidos.
- Cache warming real: depende de o provedor expor o evento.

## Como reproduzir

```bash
node --import tsx scripts/usage-real-pi.ts --real \
  --real-ext ~/.pi/agent/npm/node_modules/pi-claude-bridge/src/index.ts \
  --json-out /tmp/usage-real.json
```

Sem `--real`, o mesmo script roda com um servidor HTTP local simulado, sem gasto de cota. Serve para validar o contrato, não como medição de provedor.
