import * as Schema from "effect/Schema";

/**
 * Wiki errors are deliberately distinct from the persistence errors —
 * we're reading a foreign SQLite file (`.almanac/index.db`) that
 * Almanac owns, and "not initialised" / "schema too new" are
 * recoverable UI states, not 500s.
 */

export class WikiNotInitializedError extends Schema.TaggedErrorClass<WikiNotInitializedError>()(
  "WikiNotInitializedError",
  {
    workspaceRoot: Schema.String,
  },
) {
  override get message(): string {
    return `No .t3/wiki/ under ${this.workspaceRoot}; tap "Initialise wiki here" in /wiki, or ask Claude to create the first page.`;
  }
}

export class WikiSchemaUnsupportedError extends Schema.TaggedErrorClass<WikiSchemaUnsupportedError>()(
  "WikiSchemaUnsupportedError",
  {
    workspaceRoot: Schema.String,
    schemaVersion: Schema.Number,
    supportedVersion: Schema.Number,
  },
) {
  override get message(): string {
    return `Almanac wiki at ${this.workspaceRoot} reports schema version ${this.schemaVersion}; T3 supports ${this.supportedVersion}. Upgrade T3 or downgrade Almanac.`;
  }
}

export class WikiReadError extends Schema.TaggedErrorClass<WikiReadError>()(
  "WikiReadError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Wiki read failed in ${this.operation}: ${this.detail}`;
  }
}

export class WikiProjectNotFoundError extends Schema.TaggedErrorClass<WikiProjectNotFoundError>()(
  "WikiProjectNotFoundError",
  {
    projectId: Schema.String,
  },
) {
  override get message(): string {
    return `No project ${this.projectId} in the projection.`;
  }
}

export type WikiReadFailure =
  | WikiNotInitializedError
  | WikiSchemaUnsupportedError
  | WikiReadError
  | WikiProjectNotFoundError;

export function toWikiReadError(operation: string) {
  return (cause: unknown): WikiReadError =>
    new WikiReadError({
      operation,
      detail: cause instanceof Error ? cause.message : String(cause),
      cause,
    });
}
