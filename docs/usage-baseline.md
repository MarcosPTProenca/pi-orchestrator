# Baseline real de uso (Pi + provedor)

Medição do `scripts/usage-real-pi.ts` com processos Pi reais e provedor real.
Status: **parcial**. A delegação do worker (C1) não completou; ver "Lacuna aberta".

## Ambiente

- Pi `1.5.2` (`pi --version`).
- Provedor: `claude-bridge/claude-haiku-5-5` (`pi-claude-bridge` 0.12.0). Credencial Claude
  presente em arquivo (`quota-axi auth --provider claude`: `available`). Nenhum segredo foi lido.
- Comando: `node --import tsx scripts/usage-real-pi.ts --real --real-ext <pi-claude-bridge>/src/index.ts --json-out <arquivo>`.
- Saída bruta fora do repo (`/tmp/t-ff930344-out/real.json`), com sessões JSONL de sandbox removidas pelo script.
- Commit medido: `master` @ `11b7fd0`, mesmo código de `scripts/usage-real-pi.ts`.

## Semântica dos campos (verificada nesta medição)

| Campo         | Significado observado                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `input`       | Tokens de entrada não cacheados.                                                                                                      |
| `cacheRead`   | Tokens de entrada lidos do cache do provedor.                                                                                         |
| `cacheWrite`  | Tokens de entrada gravados no cache.                                                                                                  |
| `output`      | Tokens gerados.                                                                                                                       |
| `totalTokens` | Soma de `input + output + cacheRead + cacheWrite` (confirmado: 20+3670+26609+10427 = 40726). Inclui cache.                            |
| `cost`        | **Não reportado** pelo `claude-bridge` (`costFromProvider: false`, custo 0). Custo real **não disponível** nesta fonte; não estimado. |

Taxa de acerto de cache (cache hit ratio) = `cacheRead / (input + cacheRead + cacheWrite)`.

## Resultados (provedor real, claude-haiku-5-5)

Passos executados (todos exit 0, exceto C1):

| Passo                                 | Exit                   | Duração |
| ------------------------------------- | ---------------------- | ------- |
| A1 consulta de status (sessão nova)   | 0                      | 36,7 s  |
| A2 continuação (processo novo)        | 0                      | 21,2 s  |
| A3a rajada: conclusão 1 (concorrente) | 0                      | 45,8 s  |
| A3b rajada: conclusão 2 (concorrente) | 0                      | 46,1 s  |
| B1 fork de A                          | 0                      | 20,1 s  |
| B2 reinício no fork                   | 0                      | 16,7 s  |
| D1 sessão ociosa: início              | 0                      | 15,6 s  |
| D2 retomada após 10 s ociosa          | 0                      | 15,1 s  |
| **C1 delegação (worker)**             | **-1 (timeout 180 s)** | —       |
| E1 orquestrador: consulta             | 0                      | 10,8 s  |
| E2 orquestrador: continuação          | 0                      | 5,8 s   |

Agregado por sessão (de-duplicado, `responseId`):

- Entradas de assistant nos JSONL: **14**; respostas únicas: **10**. Soma ingênua
  (sem de-duplicar) inflaria: `totalTokens` 54888 contra **40726** real.
- Totais de-duplicados = ground truth: input 20, output 3670, cacheRead 26609, cacheWrite 10427.
- Taxa de acerto de cache: 26609 / (20 + 26609 + 10427) = **71,8 %**.
- Turnos: 10, falhas 0, duração total 169,9 s; por gatilho: `mensagem-de-usuario` 9, `indisponivel` 1.
- Sessão ociosa: 0 turnos adicionados enquanto ociosa; retomada gerou o turno esperado.

Orquestrador (`orchestratorUsage`): origem **indisponível** (não há rastro de origem no
JSONL do Pi); 2 turnos, `totalTokens` 8249, cache lido 5741, cache gravado 1928.

## Lacuna aberta: C1 (delegação do worker) não completa

- Na medição: `usage.json` não foi gravado (`usage_json_written: false`); o processo
  estourou 180 s.
- Reproduzido sozinho, com timeout de 300 s: exit 124. A sessão tem o prompt do usuário e
  **nenhuma** resposta do assistant.
- Controle, mesmo provedor e mesmo prompt, **sem** `src/worker/worker-ext.ts`: exit 0 em 10 s.
- Conclusão: o travamento está na combinação `worker-ext` + `claude-bridge`, não no
  provedor. Inferência, não confirmada: `worker-ext` reescreve o prompt em
  `before_agent_start`, e o `claude-bridge` tem histórico de `prompt_capture_unresolved`
  com essa situação (`~/.pi/agent/claude-bridge-diag.log`, entradas de 16/11 e 24/11).

Sem C1 não há baseline de delegação com dado real.

## Critérios da #102 (estado)

- [x] Semântica dos campos documentada (provedor `claude-bridge`; demais provedores não medidos).
- [x] Registro por turno com provedor, gatilho, duração, falha; agregação por sessão.
- [ ] Cache warming como evento: não medido nesta rodada.
- [x] De-duplicação após fork e reinício (14 → 10 entradas).
- [x] Cenários status, continuação, rajada, fork, sessão ociosa com provedor real.
- [ ] Delegação de worker (C1): bloqueada pelo travamento acima.
- [ ] Custo reportado: indisponível para `claude-bridge`.

## Como reproduzir

```bash
node --import tsx scripts/usage-real-pi.ts --real \
  --real-ext ~/.pi/agent/npm/node_modules/pi-claude-bridge/src/index.ts \
  --json-out /tmp/usage-real.json
```

Modo simulado (sem gasto de cota, `pi` local com HTTP falso): sem `--real`. Todos os passos
passam; é verificação de contrato, não medição de provedor.
