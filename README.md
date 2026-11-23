# pi-orchestrator

Orquestração mínima de sessões Pi independentes pelo Herdr (MVP). Um orquestrador
conversacional delega tarefas a workers Pi em panes do Herdr, acompanha sem usar LLM
e avisa só quando há decisão, bloqueio ou conclusão.

Não altera `~/.pi/agent`. A extensão é carregada só pelo launcher `bin/pi-orch`.

## Requisitos

- Herdr 0.9.x com a CLI `herdr` no `PATH`.
- Pi (`pi`) instalado; testado com 1.5.2.
- Node.js 22 e npm (para os testes).

## Instalar

```bash
cd ~/github/pi-orchestrator
npm install        # só devDependencies: tsx, typescript, @types/node, todas com versão fixa
npm test           # testes com Herdr simulado (sem efeitos reais)
node_modules/.bin/tsc -p tsconfig.json   # checagem de tipos
```

## Iniciar

Dentro de um pane do Herdr:

```bash
~/github/pi-orchestrator/bin/pi-orch
```

O launcher recusa rodar fora do Herdr (`HERDR_ENV=1` e `HERDR_PANE_ID` obrigatórios).

## Tools do orquestrador

| Tool                                                         | Função                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Usa LLM?    |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `orch_delegate(project_path, role, brief, timeout_minutes?)` | Cria (ou reutiliza) o workspace do projeto, abre uma tab para a tarefa e inicia um worker Pi com o brief.                                                                                                                                                                                                                                                                                                                                                                                                           | Não         |
| `orch_status(all?, project_id?, task_id?, detail?)`          | Saída compacta por projeto: contagem por estado, tarefas abertas (ativas ou bloqueadas, bloqueadas primeiro) até 50 por projeto (`omitted_open` informa o resto) e até 10 terminais recentes (`omitted_terminal` informa o resto), resultado em 120 caracteres. `task_id` ou `detail=true` devolvem as linhas completas, com o resultado inteiro. Canceladas e terminais antigas (mais de 24 h; `PI_ORCH_OLD_HOURS` muda o limite, e `0` esconde todas as terminais na hora) ficam de fora; `all=true` mostra tudo. | Não         |
| `orch_inbox(consume?)`                                       | Decisões abertas (`blocked`) e conclusões ou falhas ainda não avisadas. `consume=false` só lê, sem marcar o aviso como entregue. Devolve `{ items, omitted }`: no máximo 40 itens, decisões primeiro; só os exibidos são marcados como entregues e `omitted` conta os que ficam para a próxima leitura. Resultado truncado a 300 caracteres (`result_truncated`); `links` traz as URLs do texto completo, que também sai via `orch_status(task_id)`.                                                                | Não         |
| `orch_send(task_id, text)`                                   | Mensagem ao worker em execução ou bloqueado; também retoma tarefa concluída quando o mesmo painel contém o Pi ocioso. Não interrompe o turno atual.                                                                                                                                                                                                                                                                                                                                                                 | Só o worker |
| `orch_answer(task_id, answer)`                               | Envia a resposta ao worker bloqueado, que continua.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Só o worker |
| `orch_fix_red_prs(repo_path, concurrency?)`                  | Lista PRs com CI vermelho e lança correções com no máximo N workers ao mesmo tempo.                                                                                                                                                                                                                                                                                                                                                                                                                                 | Não         |
| `orch_logs(task_id, lines?)`                                 | Últimas linhas do terminal do worker (padrão 40, máximo 200). Só lê se o painel ainda for da tarefa; mascara segredos óbvios. A saída fica limitada a 8000 caracteres, mantendo a cauda (`truncated`).                                                                                                                                                                                                                                                                                                              | Não         |
| `orch_relaunch(task_id, model?)`                             | Relança uma tarefa falha como tarefa nova ligada à anterior: recebe o relatório completo e um fork da conversa anterior (ver abaixo). Falha por cota exige modelo diferente do que esgotou. Só quando você pede.                                                                                                                                                                                                                                                                                                    | Não         |
| `orch_cancel(task_id)`                                       | Fecha a tab da tarefa, se ela ainda for do orquestrador.                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Não         |

O worker recebe a tool `orch_report(status, result, question?, artifacts?)`. Ele a chama
uma vez no fim, com `done`, `failed` ou `blocked`.

## Como funciona

- **Layout:** um workspace Herdr por projeto (rótulo = nome do diretório). Cada tarefa
  é uma tab nesse workspace. A tab criada junto com o workspace fica como âncora, para o
  agrupamento não sumir.
- **Modo opcional, workspace por tarefa (`PI_ORCH_PRESENTATION_SPACES=1`):** cada tarefa ganha um workspace
  Herdr próprio, como os presentation spaces do FirstMate, e não uma tab no workspace do projeto. Padrão desligado.
  Exige Herdr 0.8.0 ou mais (`herdr --version`); abaixo disso a tarefa não é lançada. Cancelar ou fechar a tarefa
  fecha o workspace inteiro. Como o workspace não recebe variáveis de ambiente, o worker não recebe o token do
  webhook: o aviso de conclusão chega pela varredura de 20 s, não na hora. Tarefa perdida (pane fechado fora do
  orquestrador) não fecha o workspace sozinha.
- **Aviso de conclusão (sem LLM):** o worker grava `report.json` e faz POST no webhook local do
  orquestrador. Como o webhook só vale com a sessão aberta e pode se perder (reinício, endereço velho),
  há também uma varredura a cada 20 s (`PI_ORCH_SWEEP_MS`) que lê os relatórios em disco. Os dois usam
  o mesmo caminho (`noticeFor`), então cada resultado é avisado uma vez, como turno novo do orquestrador. Avisos que chegam dentro de uma janela de 5 s (`PI_ORCH_NOTICE_WINDOW_MS`) viram um turno só, com um bloco por tarefa.
- **Sem duplicidade:** não há duas tarefas ativas para a mesma PR (`source`) ou a mesma branch no mesmo projeto. Um lote com item repetido é recusado inteiro; `orch_fix_red_prs` pula as PRs que já têm tarefa ativa e informa quantas pulou.
- **Relatório tardio:** um relatório novo atualiza a tarefa em qualquer estado, exceto `cancelled`.
  Um worker que falhou por erro transitório do modelo e seguiu depois não fica preso em `failed`.
- **Relançamento:** `orch_relaunch` nunca retoma a sessão original; ele faz um fork dela. O Herdr só
  controla panes e não guarda conversa de agente. A conversa vive no Pi, em arquivo JSONL
  (`~/.pi/agent/sessions/`), e `pi --fork <arquivo>` copia o histórico para uma sessão nova
  (o original não muda). O worker grava o caminho da própria sessão em `session.txt` na pasta da tarefa.
  Se o arquivo não existir mais, o relançamento inicia sessão nova. Em qualquer caso o novo worker recebe
  o relatório completo (resultado e erro) da tentativa anterior, sem corte. A worktree não é reaproveitada:
  o novo worker arrenda a sua.
- **Worktrees:** ao cancelar ou perder uma tarefa, a worktree arrendada por ela volta ao pool só se a árvore estiver limpa e o HEAD existir em algum remoto. Caso contrário fica no lugar, e a nota diz o caminho e o motivo (`worktree_note`). Nunca usa `--force`. Ao abrir, lista as worktrees que ainda estão arrendadas por tarefas terminais, sem devolver nada.
- **Conclusão verificada:** o relatório `done` do worker é conferido sem LLM antes de ser apresentado como concluído. `direct-pr`: precisa de PR em `artifacts`, verificada no GitHub (mergeável, checks verdes). `report`: artefatos com caminho absoluto têm de existir. O resultado fica em `verification` (aprovada, reprovada, não aplicável ou não verificada), separado do relatório. Falha ao conferir nunca vira aprovada.
- **Notificação do Herdr:** bloqueio, conclusão e falha disparam `herdr notification show`, uma vez por evento. `PI_ORCH_NOTIFY=0` desliga. Falha ao notificar não afeta o orquestrador.
- **Teto de workers:** no máximo `PI_ORCH_MAX_ACTIVE` (padrão 6) tarefas ativas (starting, running, blocked), somando `orch_delegate` e `orch_fix_red_prs`. Lote que estoura é recusado inteiro, sem lançar nada. A fila de PRs espera vaga e avança quando qualquer tarefa termina.
- **Prazo:** só existe se você passar `timeout_minutes`; ao vencer, a tarefa vira `timeout` e o worker segue rodando.
- **Lançamento:** assíncrono. O comando `pi` é digitado no pane e o orquestrador segue sem esperar o agente subir.
- **Dono:** o orquestrador só fecha panes cujo `pane_id` e `terminal_id` batem com o
  registro. Se não baterem, não fecha nada.
- **Reinício:** `reconcile` confere as tarefas ativas com o Herdr e os relatórios em disco.

## Quem abre issues e PRs

- **Orquestrador:** abre issue de processo ou relato (por exemplo, uma regra que o worker não seguiu) diretamente, com `gh`, sem lançar worker para isso. Pesquisa e levantamento para criar issue ou card não são feitos por ele: aciona os subagents `researcher` (fatos externos) e `log-researcher` (logs) e monta a issue a partir do relatório deles. Pedido claro dentro desse papel é executado sem pausa; se falhar, relata a tentativa e o erro exato. Mesmo critério da #43 (issue de processo aberta diretamente) e da #52 (discovery por subagents, pedido claro executado).
- **Worker:** só comenta ou publica em issue/PR quando o pedido do usuário disser isso para aquela tarefa (regra 6 do brief, `src/intake.ts`).
- **Exceção:** o orquestrador delega a abertura de issue a um worker só quando o usuário pede explicitamente _e_ a issue exige investigação de código que o orquestrador não tem contexto para fazer (por exemplo, localizar o `arquivo:linha` da causa raiz).

## Organização do código

```
src/
  index.ts        entrypoint do orquestrador (reexporta orchestrator/extension.ts)
  worker-ext.ts   entrypoint do worker (reexporta worker/worker-ext.ts)
  orchestrator/   coordenação: ferramentas orch_*, watchers, planos, avisos, ciclo de vida
  worker/         extensão do worker: orch_report, bloqueio de AskUserQuestion, usage, fallback
  shared/         contratos de tarefa e de relatório, estado e locks, adapters (Herdr, Treehouse, GitHub, quota, usage, brief)
  policy/         regras puras: eventos, falhas, capacidade, notificação, exposição de ferramentas
```

Dependências permitidas: `orchestrator` → `orchestrator`, `shared`, `policy`; `worker` → `worker`, `shared`, `policy`; `policy` → `shared` (só tipos de evento); `shared` → `shared`. `orchestrator` e `worker` não se importam em nenhum sentido; `shared` e `policy` não dependem das duas camadas de aplicação. `test/module-boundaries.test.ts` verifica essas regras.

## Estado e arquivos

- Estado: `~/.pi/orchestrator/state.json` (troque com `PI_ORCH_STATE_DIR`).
- Posse: uma sessão do orquestrador por projeto (raiz do repositório git, ou o próprio diretório fora de git), em `owners/<chave>/owner.json` dentro do diretório de estado. Projetos diferentes rodam ao mesmo tempo; a segunda sessão viva do mesmo projeto fica em modo somente leitura (consulta sim, lança/responde/cancela/avisa não). Posse de processo morto é retomada.
- Tarefas: cada tarefa guarda `owner_key` (escopo de quem a lançou). Cada sessão avisa, varre e altera só as próprias; tarefas legadas sem dono são adotadas ao iniciar pela sessão do projeto delas; uma sessão numa pasta-pai (fora de git) também adota as de repos dentro dela, desde que o repo não tenha sessão viva. O teto `PI_ORCH_MAX_ACTIVE` continua global, somando todos os escopos.
- Escrita: `state.json` é gravado sob trava de diretório (`state.json.lock`), para que duas sessões não percam atualizações uma da outra. Trava abandonada há mais de 10 s é removida.
- Tarefas: `~/.pi/orchestrator/tasks/<task_id>/` com `brief.md` e `report.json`.
- Arquivamento de tarefas antigas: adiado. O estado de 25 tarefas (43 KB) carrega em cerca de 0,1 ms; reavaliar quando passar de ~500 tarefas.
- Sem limite de tarefas simultâneas. No modo padrão, cada tarefa tem sua tab no workspace do projeto; no modo opcional, seu próprio workspace.

## Tokens, cache e custo

Os números vêm do `usage` que o próprio Pi grava em cada mensagem de assistant (`pi-ai`, tipo `Usage`). Campos disjuntos, somados sem dupla contagem:

- `input`: prompt não lido do cache. `cacheRead`: prompt lido do cache. `cacheWrite`: prompt gravado no cache.
- `output`: saída; já inclui `reasoning`, que é subconjunto (não somar de novo). `cacheWrite1h` também é subconjunto de `cacheWrite`.
- `totalTokens`: total informado pelo provedor, não soma livre dos campos.
- `cost`: custo informado pelo provedor quando disponível; sem isso, é estimativa do Pi. Não é cobrança.
- Taxa de acerto do cache (`cache_hit_ratio` no `orch_status`): `cacheRead / (input + cacheRead + cacheWrite)`; sem denominador, fica `null`.
- Aquecimento de cache: o Pi o regrava como entrada `usage` com `kind: "cache_warm"`, separada das mensagens de assistant. O orquestrador soma essas entradas à parte (`cache_warm_cost_usd`). Só dispara com economia prevista de pelo menos US$ 0,05 e modo `idle` (padrão) ou `streaming`.
- Evidência real do aquecimento (2026-11-21, Pi SDK sem extensões, provedor Anthropic direto, `claude-sonnet-5-5`): primeira requisição com 211.121 tokens gravados no cache (US$ 0,528); refresh em ~270 s leu 211.121 tokens do cache (`cacheRead`), com `kind: "cache_warm"`, 1 token de saída e custo de US$ 0,0211. Só dispara com economia prevista de pelo menos US$ 0,05.
- Limitação observada: com extensões ativas que injetam mensagens customizadas, o Pi não arma o aquecimento. A verificação de identidade das mensagens (`isCurrent`, `sdk.js`) falha logo após o turno, porque a mensagem customizada é recriada na reconstrução do contexto. Em `claude-bridge` (custo reportado zero) o aquecimento fica desativado por custo indisponível.
- Origem do turno (usuário, automático, retry): não disponível. As mensagens de usuário do Pi têm só `role`, `content` e `timestamp`; o orquestrador não tenta inferir a origem.
- Gatilho observado por turno (`trigger`): `mensagem-de-usuario` (mensagem de usuário anterior), `ferramenta` (resultado de ferramenta anterior), `extensao:<customType>` (mensagem injetada por extensão, entrada `custom_message`) ou `indisponivel`. Não é a origem: o gatilho diz o que veio antes, não por que o turno foi pedido.
- Turnos por tarefa: a visão compacta do `orch_status` traz `turns` (contagem, falhas, duração e gatilhos) para cada tarefa, inclusive em execução. Atualiza a cada fim de turno do worker, não durante o turno.
- Orquestrador: `orch_status` com `usage: true` devolve `orquestrador` com tokens, custo, aquecimento e turnos da sessão do orquestrador, com `origin: "indisponivel"` explícito.

### Semântica por provedor (código do `pi-ai`, versão 1.5.2 do Pi)

| API do Pi                                                 | `input`                                  | `cacheRead`                                  | `cacheWrite`                                                | `output`                                 | `reasoning`                                 | `totalTokens`                                                                           |
| --------------------------------------------------------- | ---------------------------------------- | -------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------- |
| `anthropic-messages`                                      | `input_tokens`, sem o cache              | `cache_read_input_tokens`                    | `cache_creation_input_tokens`; `cacheWrite1h` é subconjunto | `output_tokens`                          | não reportado                               | calculado pelo Pi: `input + output + cacheRead + cacheWrite`                            |
| `openai-completions` (OpenAI, OpenRouter, DeepSeek, Kimi) | `prompt_tokens − cacheRead − cacheWrite` | `cached_tokens` ou `prompt_cache_hit_tokens` | escrita de cache do provedor                                | `completion_tokens`, já inclui reasoning | `reasoning_tokens`, subconjunto de `output` | calculado pelo Pi: `input + output + cacheRead + cacheWrite`                            |
| `openai-responses`                                        | `input_tokens − cacheRead − cacheWrite`  | `input_tokens_details`                       | escrita de cache do provedor                                | `output_tokens`, já inclui reasoning     | `reasoning_tokens`, subconjunto de `output` | vem da resposta do provedor; não recalculado e **não verificado de forma independente** |

Regra de soma: `input`, `cacheRead` e `cacheWrite` são disjuntos em todos os provedores acima; `reasoning` e `cacheWrite1h` nunca são somados de novo. Taxa de acerto do cache = `cacheRead / (input + cacheRead + cacheWrite)`, nula sem denominador.

### Relatório de linha de comando

`npm run usage:report -- <sessao.jsonl> [mais sessões...]` imprime JSON com turnos (por origem `automatico`/`usuario`/`indisponivel`, falhas, duração, custo), tokens, taxa de acerto do cache com o denominador, custo informado e aquecimento. Duplicatas entre arquivos (fork, reload) são contadas uma vez. Não imprime conteúdo de prompt.

Limites: `usuario` é toda mensagem de usuário do Pi, inclusive prompts enviados por automação pelo terminal; `automatico` é mensagem de extensão ou continuação após ferramenta. Origem real (quem pediu o turno) não é exposta pelo Pi.

## Smoke test real

Cria workspace, tabs e workers Pi reais em um projeto descartável, com estado isolado.
Cobre conclusão, bloqueio com resposta e cancelamento. Consome tokens do modelo do worker.

```bash
node --import tsx scripts/smoke-herdr.ts
```

## Remover

Apague o diretório do repositório e `~/.pi/orchestrator/`. Nada foi instalado em
`~/.pi/agent`. Para fechar workspaces criados, use `herdr workspace close <id>`.

## Fora do escopo do MVP

Software Factory, DAG de desenvolvimento, worktrees (fica com o treehouse), agendamento,
dashboard, memória própria, múltiplos orquestradores e notificações externas.
