import type { ChangedFile } from "../../src/shared/merge-policy.ts";
import { authorizedPolicy, type Scenario } from "./engine.ts";

const edit = (path: string): ChangedFile => ({ path, kind: "modified", additions: 4, deletions: 1 });
const L0 = [edit("docs/pipeline.md")];
const L1 = [edit("src/orchestrator/fix-loop.ts")];
const OK = { verdict: "approve", blocking: 0 } as const;
const REJECT = { verdict: "request_changes", blocking: 1 } as const;

export const BUG_TDD: Scenario = {
  id: "bug-tdd",
  title: "bug localizado: teste vermelho antes, verde depois, PR revisada",
  expectMerge: true,
  files: L1,
  ci: ["SUCCESS"],
  reviews: [OK],
};

export const REVIEW_DEFECT_FIXED: Scenario = {
  id: "review-defect-fixed",
  title: "reviewer encontra defeito real; worker corrige na mesma branch",
  expectMerge: true,
  files: L1,
  ci: ["SUCCESS"],
  reviews: [REJECT, OK],
};

export const REVIEW_EXHAUSTED: Scenario = {
  id: "review-exhausted",
  title: "reviewer reprova sempre; limite de ciclos bloqueia",
  expectMerge: false,
  files: L1,
  ci: ["SUCCESS"],
  reviews: [REJECT],
  maxAttempts: 2,
};

export const CI_BUG_FIXED: Scenario = {
  id: "ci-bug-fixed",
  title: "CI vermelho por bug; worker corrige e CI fica verde",
  expectMerge: true,
  files: L1,
  ci: ["FAILURE", "SUCCESS"],
  reviews: [OK],
};

export const CI_INFRA_BOUNDED: Scenario = {
  id: "ci-infra-bounded",
  title: "CI vermelho por infraestrutura; loop limitado sem merge",
  expectMerge: false,
  files: L1,
  ci: ["TIMED_OUT"],
  reviews: [OK],
  maxAttempts: 2,
};

export const L0_AUTO_MERGE: Scenario = {
  id: "l0-auto-merge",
  title: "L0 com auto-merge autorizado",
  expectMerge: true,
  files: L0,
  ci: ["SUCCESS"],
  reviews: [OK],
};

export const L2_MANUAL: Scenario = {
  id: "l2-manual",
  title: "L2 (dependência) exige aprovação humana",
  expectMerge: false,
  files: [edit("package.json")],
  ci: ["SUCCESS"],
  reviews: [OK],
  allowedPaths: ["package.json"],
};

export const L3_MANUAL: Scenario = {
  id: "l3-manual",
  title: "L3 (CI e permissões) exige aprovação humana",
  expectMerge: false,
  files: [edit(".github/workflows/ci.yml")],
  ci: ["SUCCESS"],
  reviews: [OK],
  allowedPaths: [".github/"],
};

export const NO_POLICY: Scenario = {
  id: "no-policy",
  title: "política de merge ausente bloqueia",
  expectMerge: false,
  files: L0,
  ci: ["SUCCESS"],
  reviews: [OK],
  policy: null,
};

export const NO_AUTHORIZATION: Scenario = {
  id: "no-authorization",
  title: "auto-merge desligado e sem autorização do usuário",
  expectMerge: false,
  files: L0,
  ci: ["SUCCESS"],
  reviews: [OK],
  policy: { ...authorizedPolicy(), auto_merge: false, authorization: { granted_by: null, ticket_id: null } },
};

export const DUPLICATE_APPROVAL: Scenario = {
  id: "duplicate-approval",
  title: "aprovação e pedido de merge duplicados",
  expectMerge: true,
  files: L0,
  ci: ["SUCCESS"],
  reviews: [OK],
  duplicateEvent: true,
};

export const MERGE_FAILED_RETRY: Scenario = {
  id: "merge-failed-retry",
  title: "merge recusado pelo GitHub e nova tentativa no mesmo head",
  expectMerge: false,
  files: L0,
  ci: ["SUCCESS"],
  reviews: [OK],
  failMerge: true,
  duplicateEvent: true,
};

export const MERGE_RACE: Scenario = {
  id: "merge-race",
  title: "head muda entre a análise e o merge",
  expectMerge: false,
  files: L0,
  ci: ["SUCCESS"],
  reviews: [OK],
  raceHeadOnMerge: true,
};

export const PLAN_A_TO_B: Scenario = {
  id: "plan-a-to-b",
  title: "item A mergeado no GitHub libera o item B",
  expectMerge: true,
  files: L0,
  ci: ["SUCCESS"],
  reviews: [OK],
  withPlan: true,
  mergeDelayTicks: 2,
};

export const PLAN_MERGE_PENDING: Scenario = {
  id: "plan-merge-pending",
  title: "merge pedido e nunca confirmado não libera o item B",
  expectMerge: false,
  files: L0,
  ci: ["SUCCESS"],
  reviews: [OK],
  withPlan: true,
  mergeDelayTicks: 99,
};

export const SCOPE_DRIFT: Scenario = {
  id: "scope-drift",
  title: "arquivo fora do escopo do ticket bloqueia",
  expectMerge: false,
  files: [edit("src/other/x.ts")],
  ci: ["SUCCESS"],
  reviews: [OK],
  allowedPaths: ["src/orchestrator/", "test/"],
};

export const REVIEW_UNVERIFIED: Scenario = {
  id: "review-unverified",
  title: "revisor sem veredito conclusivo não vira aprovação",
  expectMerge: false,
  files: L0,
  ci: ["SUCCESS"],
  reviews: [{ verdict: "unverified", blocking: 0 }],
};

export const ALL_SCENARIOS: Scenario[] = [
  BUG_TDD,
  REVIEW_DEFECT_FIXED,
  REVIEW_EXHAUSTED,
  CI_BUG_FIXED,
  CI_INFRA_BOUNDED,
  L0_AUTO_MERGE,
  L2_MANUAL,
  L3_MANUAL,
  NO_POLICY,
  NO_AUTHORIZATION,
  DUPLICATE_APPROVAL,
  MERGE_FAILED_RETRY,
  MERGE_RACE,
  PLAN_A_TO_B,
  PLAN_MERGE_PENDING,
  SCOPE_DRIFT,
  REVIEW_UNVERIFIED,
];
