import type { TaskStatus } from "./contract.ts";
import type { Mode } from "./intake.ts";

export interface DelegateInput {
  project_path: string;
  role: string;
  request: string;
  objective: string;
  mode: Mode;
  constraints?: string[];
  source?: string;
  branch?: string;
  spec?: string;
  model?: string;
  tracker?: "github" | "plane" | "none";
  timeout_minutes?: number;
  // keep: perguntas operacionais que a tarefa pode gerar antes de o diálogo autônomo parar; omitido = PI_ORCH_DIALOGUE_BUDGET ou padrão.
  dialogue_budget?: number;
  acceptance?: string[];
  allowed_tools?: string[];
}

export interface WatchEvent {
  task_id: string;
  project_id: string;
  status: TaskStatus;
  result: string | null;
  question: string | null;
  artifacts: string[];
  error: string | null;
  correction?: string | null;
  // keep: aviso de pergunta operacional do worker; a tarefa segue running e não entra no inbox de decisão.
  kind?: "ask";
  ask_id?: string;
  hint?: string | null;
}
