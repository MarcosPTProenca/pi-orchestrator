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

| Tool | Função | Usa LLM? |
|---|---|---|
| `orch_delegate(project_path, role, brief, timeout_minutes?)` | Cria (ou reutiliza) o workspace do projeto, abre uma tab para a tarefa e inicia um worker Pi com o brief. | Não |
| `orch_status()` | Lista tarefas e estados do estado local. | Não |
| `orch_inbox()` | Decisões abertas (`blocked`) e conclusões ou falhas ainda não avisadas. | Não |
| `orch_answer(task_id, answer)` | Envia a resposta ao worker bloqueado, que continua. | Só o worker |
| `orch_fix_red_prs(repo_path, concurrency?)` | Lista PRs com CI vermelho e lança correções com no máximo N workers ao mesmo tempo. | Não |
| `orch_cancel(task_id)` | Fecha a tab da tarefa, se ela ainda for do orquestrador. | Não |

O worker recebe a tool `orch_report(status, result, question?, artifacts?)`. Ele a chama
uma vez no fim, com `done`, `failed` ou `blocked`.

## Como funciona

- **Layout:** um workspace Herdr por projeto (rótulo = nome do diretório). Cada tarefa
  é uma tab nesse workspace. A tab criada junto com o workspace fica como âncora, para o
  agrupamento não sumir.
- **Aviso de conclusão (sem LLM):** o worker grava `report.json` e faz POST no webhook local do
  orquestrador. Como o webhook só vale com a sessão aberta e pode se perder (reinício, endereço velho),
  há também uma varredura a cada 20 s (`PI_ORCH_SWEEP_MS`) que lê os relatórios em disco. Os dois usam
  o mesmo caminho (`noticeFor`), então cada resultado é avisado uma vez, como turno novo do orquestrador. Avisos que chegam dentro de uma janela de 5 s (`PI_ORCH_NOTICE_WINDOW_MS`) viram um turno só, com um bloco por tarefa.
- **Sem duplicidade:** não há duas tarefas ativas para a mesma PR (`source`) ou a mesma branch no mesmo projeto. Um lote com item repetido é recusado inteiro; `orch_fix_red_prs` pula as PRs que já têm tarefa ativa e informa quantas pulou.
- **Relatório tardio:** um relatório novo atualiza a tarefa em qualquer estado, exceto `cancelled`.
  Um worker que falhou por erro transitório do modelo e seguiu depois não fica preso em `failed`.
- **Worktrees:** ao cancelar ou perder uma tarefa, a worktree arrendada por ela volta ao pool só se a árvore estiver limpa e o HEAD existir em algum remoto. Caso contrário fica no lugar, e a nota diz o caminho e o motivo (`worktree_note`). Nunca usa `--force`. Ao abrir, lista as worktrees que ainda estão arrendadas por tarefas terminais, sem devolver nada.
- **Prazo:** só existe se você passar `timeout_minutes`; ao vencer, a tarefa vira `timeout` e o worker segue rodando.
- **Lançamento:** assíncrono. O comando `pi` é digitado no pane e o orquestrador segue sem esperar o agente subir.
- **Dono:** o orquestrador só fecha panes cujo `pane_id` e `terminal_id` batem com o
  registro. Se não baterem, não fecha nada.
- **Reinício:** `reconcile` confere as tarefas ativas com o Herdr e os relatórios em disco.

## Estado e arquivos

- Estado: `~/.pi/orchestrator/state.json` (troque com `PI_ORCH_STATE_DIR`).
- Posse: `owner.json` no diretório de estado. Uma sessão do orquestrador por diretório; a segunda sessão viva fica em modo somente leitura (consulta sim, lança/responde/cancela/avisa não). Posse de processo morto é retomada.
- Tarefas: `~/.pi/orchestrator/tasks/<task_id>/` com `brief.md` e `report.json`.
- Sem limite de tarefas simultâneas. Cada tarefa tem sua tab no workspace do projeto.

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
