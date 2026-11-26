# Baseline de relançamento: fork-with-history × fresh-with-handoff

Medição real do critério 5 da issue #106: tokens e taxa de sucesso dos dois
contextos de relançamento definidos em `src/orchestrator/relaunch-context.ts`.

## Decisão

**Nenhuma mudança no padrão.** `fork-with-history` continua sendo o relançamento
quando a sessão anterior está em disco. Os dados não mostram diferença
mensurável de custo nem de sucesso neste cenário. Com N=3, o teste não tem
poder para afirmar que um contexto é melhor que o outro.

## Cenário

- **Tarefa de teste:** ler `README.md` (três fatos: versão, licença, banco) e
  escrever `summary.md` com esses fatos. Sucesso = `summary.md` existe e contém
  `2.3`, `MIT` e `postgres`.
- **Tentativa anterior (sessão A):** dois turnos reais que leem o README, listam
  os fatos e não escrevem o arquivo. Esse é o "histórico" disponível para o fork.
- **Relatório da tentativa:** a saída final da sessão A, usada como trecho do
  handoff no braço `fresh`.
- **Mensagem de relançamento:** gerada por `relaunchNotice()` do código real, com
  o mesmo texto para os dois braços; só o contexto muda.
- **Braço `fork-with-history`:** `pi --fork <sessão A> -p <mensagem>`.
- **Braço `fresh-with-handoff`:** `pi -p <mensagem>`, sem sessão anterior.
- **Modelo e provedor:** `claude-bridge/claude-haiku-5-5`, com cota real.
- **Execução:** sequencial (fork e fresh alternados), para não misturar efeito de
  cache entre execuções concorrentes.
- **Tokens:** somente respostas novas de cada execução. No fork, as respostas
  copiadas da sessão A são excluídas pelo `responseId`.

## Resultado (N=3 por braço)

| Métrica                                                            | fork-with-history | fresh-with-handoff |
| ------------------------------------------------------------------ | ----------------- | ------------------ |
| Sucesso                                                            | 3/3               | 3/3                |
| Tokens de entrada totais (input + cache read + cache write), média | 18.975 (dp 75)    | 19.728 (dp 4.134)  |
| Tokens de saída, média                                             | 585               | 504                |
| Tokens totais (entrada + saída), média                             | 19.560            | 20.232             |
| Turnos novos por execução                                          | 3, 3, 3           | 3, 4, 3            |
| Tempo médio (ms)                                                   | 8.603             | 9.837              |

Dados brutos: `results.json` no diretório de trabalho da tarefa
(`~/.pi/orchestrator/tasks/t-82e429a6/ab/results.json`, fora do repositório).

Por execução (entrada total / saída):

- fork: 18.895 / 587; 19.043 / 568; 18.986 / 601
- fresh: 17.391 / 416; 24.501 / 762; 17.292 / 333

## Leitura dos dados

- A diferença de médias nos tokens totais é de 672 (fresh +3,4%). Sobre os
  tokens de entrada, a diferença é de 753 e a estatística t fica perto de 0,3,
  por causa do desvio do braço fresh (uma execução com 4 turnos e 24.501 de
  entrada). Não é diferença significativa.
- Os dois braços tiveram 100% de sucesso. A verificação não separa os contextos
  neste cenário.
- O braço fresh teve variância maior por causa de um turno extra em uma das
  execuções. Não há evidência de que isso ocorra de forma sistemática.

## Limites

- **Tarefa trivial e histórico curto:** a sessão A tinha quatro turnos. O fork
  copia pouco contexto, então a vantagem ou desvantagem de custo é pequena por
  construção. Um histórico longo, com decisões não consolidadas, pode mudar o
  resultado. Este cenário não cobre esse caso.
- **N=3:** pequeno para detectar diferenças de poucos por cento. Um N maior exige
  mais cota real.
- **Verificação binária:** o critério de sucesso checa só a presença de três
  fatos. Não mede qualidade do trabalho nem repetição de comandos com efeito
  externo.
- **Um provedor, um modelo:** os resultados valem para `claude-haiku-5-5`
  via `claude-bridge`.

## Como reproduzir

1. Criar `README.md` com os três fatos em um diretório de teste.
2. Rodar `pi -p` com a tarefa da sessão A, depois `--session` com a continuação.
3. Para cada braço, gerar a mensagem com `relaunchNotice()` e rodar o `pi` como
   descrito acima, medindo os `usage` das linhas `assistant` do JSONL.

Quando houver histórico longo ou tarefa real, repetir com N maior antes de mudar
o padrão.
