# Write path on a writable MySQL connection

A user points `sql-mcp` at a MySQL connection with `read_only: false` and runs a write through
`execute_sql`. The result must say what the database did, not merely that nothing failed: the
affected-row count, the generated id, and the driver's note. A read must keep its old shape, and a
read-only connection must still refuse the same statement before the driver sees it.

## Sub-features

- `write-insert` returns `affected_rows: 2` and an `info` note for a two-row `INSERT`.
- `write-update` returns the matched-row count, and `write-noop` keeps `affected_rows: 0` instead of
  dropping the field.
- `write-ddl` returns a header with `affected_rows: 0` and no empty `info`.
- `write-tab-execute` returns the execution result from `manage_query_tab` with `execute: true`.
- `write-read-shape` leaves a read's `columns`/`rows` envelope free of write fields.
- `write-refusal` is still enforced on a read-only connection, and the refused row is absent.
- `write-no-existing-mutation` leaves the `departments` fingerprint unchanged.

## How to get to it (user POV)

- Call `execute_sql` with a DML or DDL statement on a connection whose `read_only` is `false`.
- Call `manage_query_tab` with `execute: true`; the response carries `result`.
- Call `list_connections` and read the `read_only` flag to choose the connection.

## Driving it with the MCP client

Preconditions:

- `config.json` has a MySQL connection with `read_only: false`. The drive defaults to `eosys`; set
  `SQL_MCP_VERIFY_MYSQL_WRITE_CONNECTION` to another name.
- The connection's schema has the `departments` table, which the drive reads for its fingerprint.
  It never writes to it.
- Run one drive at a time.

```powershell
node .agents/skills/verify-sql-mcp/scripts/mysql-write-drive.mjs --run <dir>
```

- **Create.** `execute_sql` with `CREATE TABLE sql_mcp_wp_<time>_<pid> (...)`. Expect no error and
  `affected_rows: 0`.
- **Insert.** `execute_sql` with two `VALUES` rows. Expect `affected_rows: 2`,
  `info` matching `Records: 2`, and a direct `SELECT COUNT(*)` that returns `2`.
- **Update.** `execute_sql` with `SET name = 'aa' WHERE id = 1`. Expect `affected_rows: 1` and a
  direct read that returns `aa`.
- **No-op update.** `execute_sql` with `WHERE id = 99`. Expect `affected_rows: 0` present in the
  result, not an error.
- **Tab execute.** `manage_query_tab` with `execute: true` and a `DELETE` of one row. Expect
  `result.affected_rows: 1` and a direct count that dropped by one.
- **Read back.** `execute_sql` with a `SELECT`. Expect `columns`/`rows`, no `affected_rows`.
- **Refusal.** A second server process runs against a generated read-only clone in the run
  directory. Its `INSERT` must fail with `Read-only connections reject "INSERT" statements.`, and a
  direct read must show the refused row absent.
- **Drop and compare.** `execute_sql` with `DROP TABLE`. Expect no error, the table absent from
  `information_schema`, the `departments` fingerprint identical, and the `config.json` hash
  identical.
- **Proof.** Keep `mysql-write-drive.json` and both `frames-*-raw.jsonl` files. Every check ID
  above is recorded there.

## Gotchas

- **Session state is not a capability.** Sequential calls usually reuse one pooled connection, so a
  `TEMPORARY` table or transaction can appear to work. Two calls in flight take different
  connections and the state disappears. Do not write a drive that depends on it.
- **`affected_rows` is the matched count, not the changed count.** An `UPDATE` that sets a column to
  its current value reports the row as affected. DDL and `TRUNCATE` report `0` by protocol.
- **`info` is absent when the driver sends an empty string.** Assert the fields that matter, not a
  fixed key list.
- **`CALL` returns one set.** A procedure with several result sets yields the last set that carries
  rows plus the trailing header's count. If a procedure's only output is an earlier set, the drive
  sees the later one.
- **Never aim the scratch table at a real name.** The drive uses a unique `sql_mcp_wp_` prefix and
  drops it in a `finally`. If a run is killed, drop any leftover `sql_mcp_wp_%` table by hand.
- **The read-only clone is a file in the evidence directory, not a config edit.** It carries env
  var names only. The real `config.json` is hashed before and after.
