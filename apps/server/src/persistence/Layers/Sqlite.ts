import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { migrationEntries, runMigrations } from "../Migrations.ts";
import { ServerConfig } from "../../config.ts";

type RuntimeSqliteLayerConfig = {
  readonly filename: string;
  readonly spanAttributes?: Record<string, unknown>;
};

type Loader = {
  layer: (config: RuntimeSqliteLayerConfig) => Layer.Layer<SqlClient.SqlClient>;
};
const defaultSqliteClientLoaders = {
  bun: () => import("@effect/sql-sqlite-bun/SqliteClient"),
  node: () => import("../NodeSqliteClient.ts"),
} satisfies Record<string, () => Promise<Loader>>;

const makeRuntimeSqliteLayer = Effect.fn("makeRuntimeSqliteLayer")(function* (
  config: RuntimeSqliteLayerConfig,
) {
  const runtime = process.versions.bun !== undefined ? "bun" : "node";
  const loader = defaultSqliteClientLoaders[runtime];
  const clientModule = yield* Effect.promise<Loader>(loader);
  return clientModule.layer(config);
}, Layer.unwrap);

/**
 * Maximum migration id the current binary knows about. Computed once
 * from the static `migrationEntries` registry. Used to detect when a
 * user starts an older `t3` binary against a database that was
 * migrated by a newer one — that's a downgrade and we refuse to run
 * rather than risk dropping columns we don't know how to recreate.
 */
const KNOWN_MIGRATION_HEAD = migrationEntries.reduce(
  (max, entry) => (entry[0] > max ? entry[0] : max),
  0,
);

/**
 * Inspect the migrator's tracking table to detect a downgrade attempt
 * before running any migrations. The table is named
 * `effect_sql_migrations` and stores rows like `{id, name, …}` with the
 * format `${id}_${name}`. We parse the id back out of every row's
 * `name` column and compare against this binary's max known id.
 */
const ensureNoDowngrade = Effect.fn("ensureNoDowngrade")(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Tracking table is created lazily by the migrator the first time it
  // runs. Quietly succeed when the table is missing — that's the
  // first-ever boot.
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name = 'effect_sql_migrations'
  `.pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<{ name: string }>)));
  if (tables.length === 0) return;
  const rows = yield* sql<{ readonly name: string }>`
    SELECT name FROM effect_sql_migrations
  `.pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<{ name: string }>)));
  let appliedHead = 0;
  for (const row of rows) {
    const match = /^(\d+)_/.exec(row.name);
    if (match) {
      const n = Number(match[1]);
      if (Number.isFinite(n) && n > appliedHead) appliedHead = n;
    }
  }
  if (appliedHead > KNOWN_MIGRATION_HEAD) {
    return yield* Effect.die(
      new Error(
        `Refusing to start: the SQLite database is at migration ${appliedHead}, ` +
          `but this binary only knows migrations up to ${KNOWN_MIGRATION_HEAD}. ` +
          `This usually means a newer version of \`t3\` ran first and applied a ` +
          `schema your current binary can't read. Upgrade with \`npm i -g t3@latest\`, ` +
          `or restore the most recent \`state.sqlite.backup-*\` snapshot to roll back.`,
      ),
    );
  }
});

/**
 * Copy `<dbPath>` to `<dbPath>.backup-<ms>` before each migration run
 * when there's an existing on-disk database. Cheap insurance: SQLite
 * hot-copies in a few hundred ms even on a 1GB database, and a single
 * restorable file is the difference between "rolled back" and "wrote a
 * support ticket". Failures here are non-fatal — we log and proceed
 * rather than block startup over an inability to write a backup.
 *
 * Skipped for `":memory:"` databases (tests).
 */
const backupBeforeMigrationsAt = (dbPath: string) =>
  Effect.gen(function* () {
    if (!dbPath || dbPath === ":memory:") return;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (!(yield* fs.exists(dbPath).pipe(Effect.catch(() => Effect.succeed(false))))) {
      return; // First boot — no existing file to back up.
    }
    const nowMs = yield* Clock.currentTimeMillis;
    const target = path.join(
      path.dirname(dbPath),
      `${path.basename(dbPath)}.backup-${nowMs}`,
    );
    yield* fs
      .copyFile(dbPath, target)
      .pipe(
        Effect.tap(() => Effect.log(`Wrote pre-migration backup → ${target}`)),
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to write pre-migration DB backup", { cause, target }),
        ),
      );
  });

/**
 * Setup layer — only needs the SQL client. Pre-flight (backup,
 * directory creation, anything filesystem-flavoured) runs eagerly in
 * `makeSqlitePersistenceLive` BEFORE this layer is built, so test
 * layers using `SqlitePersistenceMemory` don't have to provide
 * FileSystem / Path just to spin up an in-memory database.
 */
const setupCore = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`PRAGMA journal_mode = WAL;`;
    yield* sql`PRAGMA foreign_keys = ON;`;
    yield* ensureNoDowngrade();
    yield* runMigrations();
  }),
);

export const makeSqlitePersistenceLive = Effect.fn("makeSqlitePersistenceLive")(function* (
  dbPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });
  // Backup eagerly here so the published Layer has no FS / Path
  // requirement. Safe because both this and `runMigrations` run
  // before any application code touches the database.
  yield* backupBeforeMigrationsAt(dbPath);

  return Layer.provideMerge(
    setupCore,
    makeRuntimeSqliteLayer({
      filename: dbPath,
      spanAttributes: {
        "db.name": path.basename(dbPath),
        "service.name": "t3-server",
      },
    }),
  );
}, Layer.unwrap);

export const SqlitePersistenceMemory = Layer.provideMerge(
  setupCore,
  makeRuntimeSqliteLayer({ filename: ":memory:" }),
);

export const layerConfig = Layer.unwrap(
  Effect.map(Effect.service(ServerConfig), ({ dbPath }) => makeSqlitePersistenceLive(dbPath)),
);
