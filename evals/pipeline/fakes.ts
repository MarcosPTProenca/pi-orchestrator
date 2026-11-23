import type {
  CheckRunFact,
  MergeGithub,
  MergeSnapshot,
  PrSnapshot,
  Protection,
  RepoFacts,
  TrustedReviewer,
} from "../../src/shared/merge-gate.ts";
import type { ChangedFile } from "../../src/shared/merge-policy.ts";

export const REPO = "MarcosPTProenca/pi-orchestrator";
export const PR_NUMBER = 900;
export const PR_URL = `https://github.com/${REPO}/pull/${PR_NUMBER}`;
export const BRANCH = "feat/issue-148-harness";
export const REVIEWER: TrustedReviewer = { app_slug: "pi-reviewer-app", check_name: "pi-review" };

export const sha = (n: number): string => n.toString(16).padStart(40, "0");

export class FakeGithub implements MergeGithub {
  readonly mergeCalls: string[][] = [];
  readonly repo: RepoFacts = { allow_auto_merge: true, default_branch: "master" };
  readonly protection: Protection = { status: "protected", required_contexts: ["test"] };
  pr: PrSnapshot;
  mergeDelayTicks = 1;
  failNextMerge = false;
  raceHeadOnMerge: string | null = null;
  private ticks = 0;

  constructor(head: string, files: ChangedFile[]) {
    this.pr = {
      repo: REPO,
      number: PR_NUMBER,
      state: "OPEN",
      is_draft: false,
      head_ref: BRANCH,
      head_sha: head,
      base_ref: "master",
      mergeable: "MERGEABLE",
      merge_state_status: "CLEAN",
      auto_merge_enabled: false,
      linked_issue: 148,
      changed_files: files.length,
      files,
      check_runs: [],
    };
  }

  pushHead(head: string, files: ChangedFile[]): void {
    Object.assign(this.pr, { head_sha: head, files, changed_files: files.length, auto_merge_enabled: false });
    this.ticks = 0;
  }

  setCheck(run: CheckRunFact): void {
    this.pr.check_runs.push(run);
  }

  snapshot(): Promise<MergeSnapshot> {
    return Promise.resolve({
      pr: structuredClone(this.pr),
      repo: { ...this.repo },
      protection: structuredClone(this.protection),
    });
  }

  merge(args: string[]): Promise<string> {
    try {
      return Promise.resolve(this.applyMerge(args));
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private applyMerge(args: string[]): string {
    this.mergeCalls.push(args);
    if (this.raceHeadOnMerge !== null) {
      this.pr.head_sha = this.raceHeadOnMerge;
      this.raceHeadOnMerge = null;
    }
    const expected = args[args.indexOf("--match-head-commit") + 1];
    if (expected !== this.pr.head_sha) {
      throw new Error(`head mudou antes do merge: esperado ${expected}, atual ${this.pr.head_sha}`);
    }
    if (this.failNextMerge) {
      this.failNextMerge = false;
      throw new Error("gh: falha simulada na chamada de merge");
    }
    this.pr.auto_merge_enabled = true;
    this.ticks = 0;
    return "auto-merge habilitado (simulado)";
  }

  tick(): void {
    if (!this.pr.auto_merge_enabled || this.pr.state !== "OPEN") return;
    this.ticks++;
    if (this.ticks < this.mergeDelayTicks) return;
    if (this.requiredGreen()) this.pr.state = "MERGED";
  }

  private requiredGreen(): boolean {
    const onHead = this.pr.check_runs.filter((c) => c.head_sha === this.pr.head_sha);
    const ci = onHead.some((c) => c.name === "test" && c.app_slug === "github-actions" && c.conclusion === "SUCCESS");
    const review = onHead.some(
      (c) => c.name === REVIEWER.check_name && c.app_slug === REVIEWER.app_slug && c.conclusion === "SUCCESS",
    );
    return ci && review;
  }
}
