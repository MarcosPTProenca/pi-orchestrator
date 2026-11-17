/** Forma mínima de um evento de worker usada pelos cenários (espelha WatchEvent de src/orchestrator.ts). */
import { modelMessageFor as realModelMessageFor } from "../src/index.ts";
import type { WatchEvent } from "../src/orchestrator.ts";

export type WatchEventLike = WatchEvent;

/** Texto exato que a extensão envia ao orquestrador para um evento. */
export function modelMessageFor(e: WatchEventLike): string {
  return realModelMessageFor(e);
}
