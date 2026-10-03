import type { RunContext } from "../types.js";

/**
 * Thrown by a stage that judged the run unpublishable on quality grounds (e.g. the fact-check could not
 * make the script accurate). It carries the context to persist (with the stage's findings) so the
 * dashboard can show why; runPipeline treats it like a failed quality gate and retries with a new topic.
 */
export class RunRejectedError extends Error {
  constructor(
    message: string,
    readonly ctx: RunContext,
  ) {
    super(message);
    this.name = "RunRejectedError";
  }
}
