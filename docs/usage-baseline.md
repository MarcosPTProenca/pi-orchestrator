# Baseline real de uso (Pi + provedor)

Medição de `scripts/usage-real-pi.ts` com processos Pi reais e provedor real. Fecha a #102.

## Ambiente

- Pi `1.5.2`; provedor `claude-bridge/claude-haiku-5-5` (`pi-claude-bridge` 0.12.0). Credencial Claude em arquivo; `quota-axi auth` reporta `available`. Nenhum segredo foi lido.
- Comando: `node --import tsx scripts/usage-real-pi.ts --real --real-ext <pi-claude-bridge>/src/index.ts --json-out <arquivo>`.
- Código medido: este PR, sobre `master` @ `11b7fd0`.

## Resultado (versão corrigida)

| Passo                                 | Exit  | Duração    |
| ------------------------------------- | ----- | ---------- |
| A1 consulta de status (sessão nova)   | 0     | 7,5 s      |
| A2 continuação (processo novo)        | 0     | 5,4 s      |
| A3a rajada: conclusão 1 (concorrente) | 0     | 9,2 s      |
| A3b rajada: conclusão 2 (concorrente) | 0     | 9,8 s      |
| B1 fork de A                          | 0     | 7,0 s      |
| B2 reinício no fork                   | 0     | 7,7 s      |
| D1 sessão ociosa: início              | 0     | 6,7 s      |
| D2 retomada após 10 s ociosa          | 0     | 5,6 s      |
| **C1 delegação (worker)**             | **0** | **15,0 s** |
| E1 orquestrador: consulta             | 0     | 5,3 s      |
| E2 orquestrador: continuação          | 0     | 5,0 s      |

C1: `usage.json` gravado; relatório `done` por `orch_report` (não por fallback); 3 turnos do worker, disparados por `ferramenta` (2) e `extensao:ai-memory-handoff` (1).

Agregados (de-duplicados por `responseId`):

- Turnos: 13, falhas 0, duração somada 62,5 s. Gatilho: `mensagem-de-usuario` 9, `ferramenta` 2, `extensao:ai-memory-handoff` 1, `indisponivel` 1.
- Entradas de assistant nos JSONL: 17; respostas únicas: 13. Soma sem de-duplicar: 277.463 tokens; de-duplicada: **259.845**.
- Totais de-duplicados: input 26, output 3.862, cacheRead 244.023, cacheWrite 11.934.
- Taxa de acerto de cache: `cacheRead / (input + cacheRead + cacheWrite)` = 244.023 / 255.983 = **95,3 %**.
- Custo: **não reportado** pelo `claude-bridge` (`costFromProvider: false`). Não estimado.
- Sessão ociosa: 0 turnos adicionados enquanto ociosa; 1 turno antes, 2 depois da retomada.
- Orquestrador: origem **indisponível** (sem rastro de origem no JSONL); 2 turnos; `totalTokens` 7.973.

A medição anterior (mesmo provedor, antes da correção) deu 10 turnos e cache de 71,8 %. A taxa subiu porque o contexto de sessão cresceu (hook do ambiente injeta memória). Isto é inferência, não medido separadamente.

## Semântica dos campos (`claude-bridge`)

- `input`: entrada não cacheada.
- `cacheRead`: entrada lida do cache do provedor.
- `cacheWrite`: entrada gravada no cache.
- `output`: tokens gerados.
- `totalTokens` = `input + output + cacheRead + cacheWrite`. Confirmado: 26 + 3.862 + 244.023 + 11.934 = 259.845.
- `cost`: não reportado por este provedor. Demais provedores não foram medidos.

## Causa do exit 124 no C1

A hipótese da versão anterior deste doc (o `worker-ext` reescreve o prompt em `before_agent_start` e trava) está **refutada**: o controle sem `worker-ext` também trava.

Foram observados quatro modos de falha:

| Classe                                         | Sinal observado                                                                                                                                      | Causa                                                                                       | Tratamento                                                                                   |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| A. Stream parado                               | Só o primeiro chunk chega, depois nada: nenhum texto gerado e nenhum `message_update` seguinte. Ocorre com e sem `worker-ext`.                       | `claude-bridge` não tem timeout de inatividade.                                             | Watchdog em `src/worker/stall-watchdog.ts`.                                                  |
| B. Marcação de ferramenta em loop              | `<parameter_type>` repetido 3.677 vezes (~70 mil caracteres). Só com `--no-tools`.                                                                   | O harness tirava `read`, `bash` e `orch_report`, mas o prompt pedia essas ferramentas.      | Harness usa lançamento de produção.                                                          |
| C. Trabalho fora do brief ou comando bloqueado | O modelo rodou `npm run quality` em outro repositório; ou `lavish-axi poll`, que espera humano.                                                      | Mensagem genérica "Execute a tarefa do brief." deixa o modelo procurar contexto de memória. | Mensagem de produção (`src/shared/launch.ts`); `bash` do worker tem timeout padrão de 900 s. |
| D. Processo não sai                            | Relatório gravado e turno concluído, mas o `pi` continuou vivo além do timeout. Também há `pi` que não sai com SIGTERM enquanto um turno está preso. | Não identificado.                                                                           | **Não corrigido.** Ver pendências.                                                           |

### Taxas

| Configuração                                                    | Execuções | Exit 124 |
| --------------------------------------------------------------- | --------- | -------- |
| Sem `worker-ext` (controle), `--no-tools`                       | 8         | 2        |
| `worker-ext` original, `--no-tools`                             | 17        | 2        |
| `worker-ext` com watchdog, `--no-tools`                         | 15        | 4        |
| Produção, mensagem genérica (antes da correção do C1)           | 24        | 5        |
| **Produção, mensagem de lançamento de produção (versão final)** | **20**    | **0**    |

Em "Produção, mensagem genérica", as 5 falhas são: 2 de classe C (`lavish-axi poll`; `npm run quality` em outro repo), 1 de classe D (relatório gravado, processo não saiu), 1 não classificada (nenhum turno; o debug do bridge não estava ligado nessa rodada), 1 de classe C com debug ligado.

Em "Produção, mensagem de lançamento de produção", as 20 execuções foram feitas com a mensagem de produção, de 11 a 30 s, todas com relatório `orch_report`.

Nota: as rodadas de produção não usaram a mesma versão do código. O timeout do `bash` e o reenvio pela `agent_settled` entraram no meio delas. A versão final foi revalidada pelo teste E2E de stall e pelo baseline real completo, descritos acima; a limpeza de lint que veio depois não muda comportamento.

## Watchdog de stream (classe A), verificado de ponta a ponta

Servidor local compatível com OpenAI, que trava depois do primeiro chunk. Worker real (`pi` + `worker-ext`).

- **Uma trava:** `stall.log` registra `retry=1` após ~90 s. O servidor vê o cliente fechar (abort observado). Retomada: requisição 2 respondida. Lembrete de `orch_report`: requisição 3. Exit 0 em 91 s.
- **Trava em todas as tentativas:** `retry=1`, `retry=2` e `exhausted retries=2`, em 290 s. Relatório `failed` por fallback. Exit 1, sem travamento.

Durante a verificação apareceu um bug, corrigido: reenviar a retomada dentro de `agent_end` falha com "Agent is already processing". O reenvio agora ocorre em `agent_settled`, com o agente ocioso.

Limite conhecido: o watchdog aborta um turno que fica mais de 90 s sem nenhum `message_update`. Não há evidência de turno legítimo nessa situação; um turno assim seria abortado e retomado.

## Timeout padrão do `bash` do worker (classe C)

`tool_call` define `input.timeout = 900` quando o modelo não informa. Verificado por três testes unitários (`test/worker-bash-timeout.test.ts`). Não foi exercido de ponta a ponta com um comando bloqueado de verdade.

## Acceptance da #102

| Critério                                                                         | Estado                                                                           |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Semântica de `input`, `cacheRead`, `cacheWrite`, `output`, `totalTokens`, `cost` | Feito para `claude-bridge`. Outros provedores não medidos.                       |
| Registro por turno e agregação por tarefa e sessão                               | Feito (13 turnos, por gatilho e modelo).                                         |
| Eventos de cache warming                                                         | **Não disponível** nesta medição: nenhum evento desse tipo apareceu no provedor. |
| De-duplicação após fork e reinício                                               | Feito: 17 entradas viram 13.                                                     |
| Relatório com totais, cache hit ratio, custo e turnos automáticos                | Feito. Custo: não reportado pelo provedor.                                       |
| Baseline: status, delegação, continuação, rajada, ociosa                         | Feito, com provedor real.                                                        |
| Testes com fixtures (cache 0, campos ausentes, fork, reinício)                   | Já existem em `test/usage.test.ts` (38 testes), não alterados aqui.              |

## Pendências

- Classe D: processo que não sai após o turno, ou que não sai com SIGTERM enquanto um turno está preso. Não corrigido.
- Outros provedores (kiro, antigravity): não medidos.
- Cache warming real: depende de o provedor expor o evento.

## Como reproduzir

```bash
node --import tsx scripts/usage-real-pi.ts --real \
  --real-ext ~/.pi/agent/npm/node_modules/pi-claude-bridge/src/index.ts \
  --json-out /tmp/usage-real.json
```

Sem `--real`, o mesmo script roda com um servidor HTTP local simulado, sem gasto de cota. Serve para validar o contrato, não como medição de provedor.
