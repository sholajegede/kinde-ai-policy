/** Thrown when a policy or option is invalid. Lists every problem found. */
export class PolicyConfigError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`Invalid kinde-ai-policy configuration:\n- ${problems.join("\n- ")}`);
    this.name = "PolicyConfigError";
    this.problems = problems;
  }
}
