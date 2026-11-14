# Preview a table

A user asks to "open" a table the way a GUI would. Over stdio there is no window, so the server
returns a bounded preview of the rows instead, and says so in its result. This is the documented
intentional difference from DB Atelier.

## Sub-features

- `open-preview` returns up to 100 rows for a table or view.
- `open-identity` echoes the connection, schema, and table it previewed.
- `open-note` states that a stdio server cannot open a GUI window.
- `open-missing` returns a clear error for a table that does not exist.
- `open-unsafe-name` rejects a table name that is not a plain identifier.

## How to get to it (user POV)

- Call the `open_table` tool with `{ connection, schema, table }`.

## Driving it with the MCP client

Preconditions:

- `doctor.mjs` reported `readOnly: true`.
- `dbo._DIM_BranchGroup` exists and holds 2 rows.

- **Preview the table.** Call `open_table` with
  `{ connection: "prod", schema: "dbo", table: "_DIM_BranchGroup" }`. The result JSON has
  `opened: true`, a `note` explaining the non-GUI behaviour, and a `preview` object with
  `columns`, `row_count`, and `rows`.
- **Check the bound.** `preview.row_count` is at most 100 and equals `preview.rows.length`. A
  preview of a table holding more rows than the bound returns `row_count: 100`, and `truncated` is
  still absent: the row bound does not set it, only the byte cap does. See Gotchas.
- **Check a missing table.** Call `open_table` with `table: "verify_probe_absent"`. The result has
  `isError: true` and text containing `Invalid object name`.
- **Check an unsafe name.** Call `open_table` with `table: "_DIM_BranchGroup; DROP TABLE x"`. The
  result has `isError: true` and text containing
  `Invalid table "_DIM_BranchGroup; DROP TABLE x".` (the full text is prefixed by
  `Tool open_table failed: `). The identifier guard runs before any SQL is sent.
- **Proof.** Keep the frames and the parsed results.

## Gotchas

- `open_table` issues `SELECT TOP (100) *` internally. That is the tool's own statement, not yours;
  do not copy the `SELECT *` pattern into your own probes.
- The same `arrayRowMode` column-shape defect that affected `execute_sql` affected `preview`,
  because both build their columns the same way. Both were fixed together on 2026-10-23. `preview`
  now returns `Id`/`Name`/`IsEnable` with rows `[[1,"BBM1",1],[2,"BBM2",1]]`. The live path is
  `DatabaseManager.query` → `clampResult`, with `columnDescriptors` in the dialect's `runQuery`;
  `normalizeResult` is exercised only by `scripts/check-safety-gaps.mjs` and the tests.
- `preview.truncated` appears only when the byte cap (`max_result_bytes`) dropped a row. A preview
  cut by the 100-row bound reports `false` from `clampResult` — it compares the row count against a
  list that `TOP (100)` already shortened — and the handler's `result.truncated || marker.truncated`
  then drops the key, so it is absent rather than `false`. `execute_sql` always reports a boolean.
  This is a product inconsistency: the drive records the absent flag as an INFO note and asserts
  only that a row-cut preview is never `truncated: true`.
- The drive previews `dbo.DIM_BPSKelurahan` (83k rows, narrow) as its row-cut case. If that table
  ever holds 100 rows or fewer, the drive records an INFO skip instead of failing.
- `open_table` takes no `database` argument. It always reads the connection's configured database.
- The unsafe-name probe must never reach SQL. If it returns a SQL error instead of an identifier
  error, the quoting guard regressed — report that.
