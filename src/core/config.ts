import { readFileSync } from "node:fs";
import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/** Schema for a single metric spec within a project config. */
export const MetricSpecSchema = Type.Object(
  {
    key: Type.String({ minLength: 1 }),
    label: Type.String({ minLength: 1 }),
    direction: Type.Union([Type.Literal("maximize"), Type.Literal("minimize")]),
    unit: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** Schema for `recurse.config.json`. */
export const RecurseConfigSchema = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    repoUrl: Type.String({ minLength: 1 }),
    defaultBranch: Type.String({ default: "main" }),
    objective: Type.String({ minLength: 1 }),
    evalCommand: Type.String({ minLength: 1 }),
    metrics: Type.Array(MetricSpecSchema, { minItems: 1 }),
    concurrency: Type.Integer({ minimum: 1, default: 2 }),
    ideaIntervalMinutes: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

export type RecurseConfig = Static<typeof RecurseConfigSchema>;

/** Parse + validate raw config data, applying defaults. Throws on invalid input. */
export function parseConfig(data: unknown): RecurseConfig {
  const withDefaults = Value.Default(RecurseConfigSchema, data);
  const errors = [...Value.Errors(RecurseConfigSchema, withDefaults)];
  if (errors.length > 0) {
    const details = errors.map((e) => `  - ${e.path || "/"}: ${e.message}`).join("\n");
    throw new Error(`Invalid recurse config:\n${details}`);
  }
  return Value.Decode(RecurseConfigSchema, withDefaults);
}

/** Read, parse, and validate a `recurse.config.json` from disk. */
export function loadConfig(path: string): RecurseConfig {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (cause) {
    throw new Error(`Could not read config at ${path}`, { cause });
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`Config at ${path} is not valid JSON`, { cause });
  }

  return parseConfig(data);
}
