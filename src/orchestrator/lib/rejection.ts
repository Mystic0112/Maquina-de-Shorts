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

/**
 * A stage failed but produced results worth keeping (e.g. publishing: one platform failed, another
 * succeeded). executeStage persists `ctx` instead of the stage's input context, then the run fails.
 */
export class StageFailedError extends Error {
  constructor(
    message: string,
    readonly ctx: RunContext,
  ) {
    super(message);
    this.name = "StageFailedError";
  }
}
