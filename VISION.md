# Vision

Pi Factory exists so that a developer can turn software development objectives into verified deliveries through autonomous coordination of specialized agents.

It serves developers who define goals, constraints, and relevant decisions while delegating discovery, planning, implementation, verification, and integration.

It owns exactly one thing: the coordination of agent-driven software delivery from an authorized objective to a verified result.

## 1. Autonomous coordination, not autonomous authority

The orchestrator is the user's primary interface and coordinates the work performed by independent Pi agents.

It autonomously investigates repositories, researches alternatives, prepares specifications, and decomposes work into verifiable tickets.

The user approves relevant product and architectural decisions and authorizes execution scope before implementation begins.

Workers execute delegated tasks and communicate with the orchestrator rather than directly with the user.

Approved work progresses autonomously until completion, a meaningful decision, or a genuine blocker requires human intervention.

Automatic integration is permitted only with prior authorization, an acceptable risk classification, and all applicable gates passing for the exact change being integrated.

High-risk changes, unauthorized scope expansion, and consequential decisions outside granted authority require human approval.

## 2. Deterministic guarantees, adaptive execution

The delivery workflow has predefined stages, explicit contracts, and verifiable completion criteria.

Stages and mandatory gates are deterministic, but agent behavior within those boundaries is adaptive.

The orchestrator and workers may exchange information, investigate failures, change strategies, and repeat attempts to fulfill the authorized ticket.

The system does not prescribe every action or require central approval for ordinary implementation decisions.

Recoverable failures trigger autonomous diagnosis and correction, including independent review when useful.

Recovery is bounded by explicit resource limits and evidence of progress, rather than unlimited repetition of unsuccessful strategies.

A task is not complete merely because an agent reports success.

## 3. Quality is verified and non-regressive

Deliveries are evaluated against ticket acceptance criteria, automated tests, deterministic quality gates, and applicable independent reviews.

Static analysis and automated checks prevent new or aggravated violations of established quality policies.

Existing technical debt may remain in an explicit baseline, but changes to that baseline require justification and human approval.

Critical security failures and functional failures cannot be waived merely because a baseline exists.

Local hooks provide early feedback but do not replace required integration checks.

Semantic reviews complement deterministic verification without becoming its sole authority.

Workers autonomously correct defects introduced by their changes without being required to refactor unrelated legacy code.

Synthetic tests and real-world execution evidence remain distinguishable.

## 4. Parallel work without losing control

Independent tickets may execute concurrently when their dependencies and resource constraints permit.

Workers operate in isolated worktrees, while the orchestrator coordinates their progress and integration.

Known conflicts and unmet dependencies prevent unsafe execution or advancement.

Parallelism improves delivery throughput without authorizing speculative work outside approved plans.

The factory maintains a single persistent source of truth for plans, tasks, permissions, decisions, and execution outcomes.

## 5. Specialized, reproducible, terminal-first

Pi Agent and Herdr are the native execution environment, and GitHub remains the integration platform.

The factory reuses these systems rather than building universal harness compatibility or duplicating existing capabilities.

The essential workflow, dependencies, permissions, and quality controls are reproducible from the repository in a clean environment.

Personal skills, hooks, and extensions may improve the experience but cannot replace essential product guarantees.

The terminal remains the primary interface for interaction and execution.

Optional Herdr integrations and terminal user interfaces may visualize plans, workers, dependencies, blockers, and gates without introducing another source of truth.

The factory does not require a dedicated web frontend, hosted backend, or additional infrastructure to operate.

## 6. Efficiency and evolution require evidence

Tokens, context, latency, execution resources, and rework are managed explicitly.

Efficiency improvements require reproducible measurements and must preserve accepted quality and reliability guarantees.

The system distinguishes meaningful progress toward ticket completion from repeated activity without results.

New techniques from autonomous software engineering projects are evaluated as potential internal improvements, not as reasons to expand the product into a universal agent platform.

New capabilities are adopted incrementally when they demonstrate measurable benefits over existing mechanisms.

Architectural changes preserve established contracts or provide explicit, tested migration paths and rollback options.

Popularity or novelty alone is not grounds for introducing dependencies or replacing proven behavior.

## Scope and acceptance

Pi Factory is not an IDE, a language model, a general-purpose workflow platform, a multi-harness compatibility layer, or a web project management application.

It does not take ownership of the implementation work delegated to agents, the code-hosting responsibilities of GitHub, or the user's product decisions.

A change aligns when it demonstrably improves the autonomous delivery of authorized tickets while preserving verifiable quality, bounded authority, reproducibility, and operational simplicity.

A change should be resisted when it bypasses required gates, obscures ownership or state, expands agent authority without permission, introduces unverified complexity, or sacrifices established reliability for speculative capabilities.
