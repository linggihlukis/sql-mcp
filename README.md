# sql-mcp

A local stdio MCP server that gives an MCP client read access to Microsoft SQL Server and MySQL.
Browse connections, databases, tables, and columns, run bounded queries, and keep saved queries and
tabs in a local workspace.

Both dialects work through the same twelve tools, and one `config.json` can hold connections of
either kind side by side. It runs as a child process of your MCP client. There is no HTTP port, no
bearer token, and no GUI.

## What you get

- Twelve MCP tools for schema discovery, bounded queries, and a local query workspace, listed under
  [Tools](#tools).
- A read-only guard that rejects a write before it reaches the server, on by default.
- A row cap on query results and a byte cap on every database tool result, so a wide table cannot
  stall your client.
- A local workspace for saved queries, folders, and tabs, stored as one JSON file.

If you need to write to a database, this server is not the tool for you. A connection can opt into
writes with `read_only: false`, but the project is built around read access.

## Requirements

- Node.js 18.19 or newer. The `mssql` driver requires it.
- Network access to a SQL Server or MySQL instance, and a login for it.
- An MCP client that can launch a local process.

## Quick start

The whole setup is five steps. You supply the repository URL, the host, the database, and the
credentials. Everything else is a placeholder in the examples below.

### 1. Clone and install

```bash
git clone <repository-url> sql-mcp
cd sql-mcp
npm ci
```

### 2. Create the configuration files

```bash
cp config.example.json config.json
cp .env.example .env
```

On Windows PowerShell, use `Copy-Item config.example.json config.json` and
`Copy-Item .env.example .env`.

Both files are ignored by Git. Do not commit them.

### 3. Edit `config.json`

The example file ships two entries, one SQL Server and one MySQL. Delete the entry you do not need
rather than leaving it in place, because `list_connections` opens a pool for every configured
connection and one unreachable entry fails the whole call. Then set `host`, `database`, and the two
environment variable names. The SQL Server entry looks like this:

```json
{
  "connections": [
    {
      "name": "sqlserver",
      "db_type": "mssql",
      "host": "127.0.0.1",
      "port": 1433,
      "database": "YourDatabase",
      "username_env": "SQL_MCP_USERNAME",
      "password_env": "SQL_MCP_PASSWORD",
      "read_only": true,
      "max_row_limit": 500,
      "query_timeout_ms": 60000,
      "connection_timeout_ms": 10000,
      "options": {
        "encrypt": false,
        "trustServerCertificate": true,
        "enableArithAbort": true
      }
    }
  ]
}
```

Every field is described under [Configuration](#configuration). Leave `read_only` at `true` unless
you have a reason to change it.

### 4. Put the credentials in `.env`

The variable names must match `username_env` and `password_env` in `config.json`.

```dotenv
SQL_MCP_USERNAME=your-sql-login
SQL_MCP_PASSWORD=your-real-password
```

If you kept the MySQL entry, set `MYSQL_USERNAME` and `MYSQL_PASSWORD` too. `.env.example` already
lists all four names.

The server reads `.env` from beside `config.json`. You do not need to copy it into your client's
`env` block.

### 5. Point your client at the server

Use an absolute path for `SQL_MCP_CONFIG`. The server resolves its defaults against the working
directory, and a client usually launches it from somewhere else.

```json
{
  "mcpServers": {
    "sql-mcp": {
      "command": "node",
      "args": ["/path/to/sql-mcp/src/index.js"],
      "env": {
        "SQL_MCP_CONFIG": "/path/to/sql-mcp/config.json",
        "SQL_MCP_DATA_DIR": "/path/to/sql-mcp/data"
      }
    }
  }
}
```

On Windows, write the paths with forward slashes, as in `C:/path/to/sql-mcp/src/index.js`.

Restart the MCP server in your client, then call `list_connections`. A working setup returns one
entry per configured connection with the databases each one can see. That call opens a pool for
every connection, so it also proves the credentials work.

A server that starts cleanly has not proven anything yet. The server connects lazily and does not
touch the database until the first database tool runs.

## How it works

The client launches the server as a child process and talks JSON-RPC over stdin and stdout.

```text
MCP client -> stdio -> sql-mcp -> TCP -> SQL Server or MySQL
```

Nothing listens on a port. The process exits when its stdin closes, so a client that disconnects
does not leave a server running. Diagnostics go to stderr, and stdout carries protocol frames only.

Pools open on the first tool call that needs a database, one pool per connection and database pair.
The SQL Server pool holds at most five connections and closes idle ones after 30 seconds.

## Connect your client

Every client below launches the same `src/index.js` with the same two environment variables. Only
the file and the key name change.

### Claude Desktop

Claude Desktop reads `claude_desktop_config.json`. On Windows that is
`%APPDATA%\Claude\claude_desktop_config.json`. On macOS it is
`~/Library/Application Support/Claude/claude_desktop_config.json`. Use the `mcpServers` shape shown
in step 5.

### Claude Code

Claude Code reads a project `.mcp.json` with the same `mcpServers` shape. Add `"type": "stdio"` to
the entry, or use the CLI:

```bash
claude mcp add sql-mcp --env SQL_MCP_CONFIG=/path/to/sql-mcp/config.json --env SQL_MCP_DATA_DIR=/path/to/sql-mcp/data -- node /path/to/sql-mcp/src/index.js
```

### VS Code

VS Code reads `.vscode/mcp.json` with a `servers` key, and requires `"type": "stdio"`:

```json
{
  "servers": {
    "sql-mcp": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/sql-mcp/src/index.js"],
      "env": {
        "SQL_MCP_CONFIG": "/path/to/sql-mcp/config.json",
        "SQL_MCP_DATA_DIR": "/path/to/sql-mcp/data"
      }
    }
  }
}
```

VS Code also reads a portable `.mcp.json` at the workspace root, which uses `mcpServers` and needs
no `type`.

### Cursor

Cursor reads `.cursor/mcp.json` in the project, or `~/.cursor/mcp.json` for every project, using the
`mcpServers` shape.

### Zed

Zed reads `context_servers` in its settings file. Add the entry under that existing key:

```json
{
  "context_servers": {
    "sql-mcp": {
      "command": "node",
      "args": ["/path/to/sql-mcp/src/index.js"],
      "env": {
        "SQL_MCP_CONFIG": "/path/to/sql-mcp/config.json",
        "SQL_MCP_DATA_DIR": "/path/to/sql-mcp/data"
      }
    }
  }
}
```

### Codex

Codex reads `~/.codex/config.toml`, or `.codex/config.toml` in a trusted project:

```toml
[mcp_servers.sql-mcp]
command = "node"
args = ["/path/to/sql-mcp/src/index.js"]
env = { SQL_MCP_CONFIG = "/path/to/sql-mcp/config.json", SQL_MCP_DATA_DIR = "/path/to/sql-mcp/data" }
```

Or add it from the shell:

```bash
codex mcp add sql-mcp --env SQL_MCP_CONFIG=/path/to/sql-mcp/config.json --env SQL_MCP_DATA_DIR=/path/to/sql-mcp/data -- node /path/to/sql-mcp/src/index.js
```

## Configuration

`config.json` holds a `connections` array. Each entry describes one database.

| Field | Default | Purpose |
| --- | --- | --- |
| `name` | required | Name the tools use to select this connection. Must be unique. |
| `db_type` | `mssql` | `mssql` or `mysql`. Any other value fails at startup. |
| `host` | required | Server address. |
| `port` | `1433` for mssql, `3306` for mysql | Server port. |
| `database` | required | Default database for this connection. |
| `username_env` | one of these two | Environment variable name that holds the login. |
| `username` | one of these two | The login written directly in the file. |
| `password_env` | one of these two | Environment variable name that holds the password. |
| `password` | one of these two | The password written directly in the file. |
| `read_only` | `true` | Reject write statements before they reach the server. Must be a literal `true` or `false`. |
| `max_row_limit` | `500` | Upper bound on rows a tool may return. |
| `max_result_bytes` | `262144` | Upper bound on the size of one tool result, in bytes. |
| `query_timeout_ms` | `60000` | Per-request timeout. |
| `connection_timeout_ms` | `10000` | Connect timeout. |
| `options` | per dialect | Driver options, filtered by dialect. |

Name the password through `password_env` and keep it out of `config.json`. A literal `password` key
works, but the file is then a secret you must not commit.

A variable named by `username_env` or `password_env` that is not set at all is an error. A typo in
the variable name cannot silently become an empty login.

### MySQL

The same shape, with `db_type: "mysql"`. This is one entry in the `connections` array:

```json
{
  "name": "mysql",
  "db_type": "mysql",
  "host": "127.0.0.1",
  "port": 3306,
  "database": "YourDatabase",
  "username_env": "MYSQL_USERNAME",
  "password_env": "MYSQL_PASSWORD",
  "read_only": true,
  "options": { "charset": "utf8mb4" }
}
```

Three things differ from SQL Server.

- **A schema is a database.** MySQL has no second namespace level, so `schema` and `database` name
  the same thing on every tool. A call that names both uses the database, and a call that names
  only a schema reads that schema as the database.
- **An empty password is accepted.** A local MySQL account may have none, so `password: ""` and
  `MYSQL_PASSWORD=` both load. A password variable that is not set at all is still an error.
- **`options` belong to a dialect.** `charset`, `timezone`, and `ssl` are MySQL's. `encrypt`,
  `trustServerCertificate`, and `enableArithAbort` are SQL Server's. A key from the other dialect
  is rejected at startup instead of being passed to a driver that would ignore it. A key no dialect
  owns is passed through.

`multipleStatements` is always `false` and is not configurable. A second statement is what the
read-only guard exists to stop, so the driver refuses it too.

`query_timeout_ms` maps to mysql2's `timeout`, which is an inactivity timeout rather than SQL
Server's per-request deadline. A query that keeps the connection busy past the limit is still
bounded, but the two dialects measure it differently.

### Dialect support

| | SQL Server (`mssql`) | MySQL (`mysql`) |
| --- | --- | --- |
| Catalog source | `sys.objects`, `sys.columns` | `information_schema` |
| Identifier quoting | `[name]` | `` `name` `` |
| Default schema | `dbo` | the connection's database |
| Preview | `SELECT TOP (n) *` | `SELECT * ... LIMIT n` |
| Read-only enforcement | guard, plus the login's permissions | guard, plus `multipleStatements: false` |
| Big integers | driver's `bigint` mapping | exact strings above 2^53 (`supportBigNumbers`) |

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `SQL_MCP_CONFIG` | `./config.json` | Path to the configuration file. |
| `SQL_MCP_DATA_DIR` | `./data` | Where saved queries, folders, and tabs persist. |
| `SQL_MCP_DOTENV` | `.env` beside `config.json` | Path to the dotenv file. |

Defaults resolve against the process working directory, so set `SQL_MCP_CONFIG` to an absolute path
when the client does not launch the server from the repository root.

Explicit process environment variables win over `.env`. The dotenv reader accepts `export` prefixes,
single or double quotes, and trailing `#` comments.

### Use a least-privilege login

Give the server a dedicated login that holds only what the tools need. A login with `SELECT` and no
write permission is the safest configuration, because a write attempt then fails at the server even
if the read-only guard has a bug. Do not use `sa`.

## Tools

The server provides twelve tools.

| Tool | Purpose |
| --- | --- |
| `list_connections` | List configured connections with the databases each one can see. |
| `list_databases` | List every database on a connection. |
| `list_tables` | List tables and views in a schema. |
| `describe_table` | Column names, types, nullability, keys, and defaults. |
| `execute_sql` | Run a SQL query and return bounded rows. |
| `search_columns` | Find columns by name substring across a schema. |
| `get_schema_summary` | Every table in a schema with its column count. |
| `get_erd` | Tables, columns, and foreign-key relationships. |
| `open_table` | Bounded preview of a table or view. |
| `manage_saved_queries` | Create, list, get, update, or delete saved queries. |
| `manage_query_folders` | Create, rename, delete, or list folders. |
| `manage_query_tab` | Create, open, update, or close editor tabs. |

Every tool except `list_connections` takes `connection`, the `name` from `config.json`, unless the
action works from an id alone. The schema tools also take an optional `database` and `schema`, which
default to the connection's configured database and its default schema. `open_table` takes `schema`
but not `database`. The rest of the `manage_*` arguments are described under
[Workspace tools](#workspace-tools).

### Discovery tools

`list_connections` takes no arguments. It returns one entry per connection with `name`, `db_type`,
`database`, and `available_databases`. It opens a pool for every configured connection, so one
unreachable connection fails the whole call.

`list_databases` returns `current` and `databases`.

`list_tables` returns a bare array of `{ name, type }`, where `type` is `table` or `view`. When the
result is cut by the byte cap, it returns an object with `items`, `total_count`, and
`truncated: true` instead, so a partial list cannot be mistaken for a complete one.

`describe_table` takes `table` and returns `schema`, `table`, and `columns`. Each column has `name`,
`type`, `nullable`, `primary_key`, and `default` when the column has one. A table that does not
exist returns an error rather than an empty list.

`search_columns` takes `pattern`, a substring matched with `LIKE %pattern%`, and returns `count` and
`matches`. Each match has `column`, `table`, `type`, `nullable`, and `primary_key`.

`get_schema_summary` returns `schema`, `tables`, and `total_tables`. Each table has `name`, `type`,
and `column_count`.

`get_erd` returns `schema`, `tables`, `relationships`, `total_tables`, and `total_relationships`.
Each relationship has `from_table`, `from_column`, `to_table`, and `to_column`. Pass `tables` to
limit the graph to a list of table names. An empty `tables` array returns an empty graph without
opening a pool.

`open_table` takes `schema` and `table`, and returns up to 100 rows. It has no `database` argument
and always reads the connection's configured database. The result carries `connection`, `schema`,
`table`, `preview`, and `opened: true`. A stdio server cannot open a GUI window, so the tool returns
the data instead.

### `execute_sql`

`execute_sql` takes `sql` and an optional `row_limit`. The limit is clamped to the connection's
`max_row_limit`, and a call that omits it gets `max_row_limit` rows.

The result has `columns`, `row_count`, `rows`, and `truncated`. Rows are arrays of values in column
order, not objects. `truncated` is `true` when the server sent more rows than the result holds.

### Workspace tools

The three `manage_*` tools write local state under `SQL_MCP_DATA_DIR`, in a file named
`workspace.json`. They never write to the database, with one exception. `manage_query_tab` with
`execute: true` runs the tab's SQL through the same guard as `execute_sql`.

`manage_saved_queries` takes `action`, one of `create`, `list`, `get`, `update`, or `delete`.
`create` needs `connection` and takes `title`, `content`, and `folderId`. `list` needs `connection`
and takes `database`. `get`, `update`, and `delete` need `queryId`.

`manage_query_folders` takes `action`, one of `list`, `create`, `rename`, or `delete`. `create` needs
`connection` and `name`, and takes `parentId`. `rename` and `delete` need `folderId`. Deleting a
folder deletes its subfolders and the queries inside them, and reports how many subfolders went with
it.

`manage_query_tab` takes `action`, one of `create`, `open`, `update`, or `close`. `create` needs
`connection` and takes `title`, `sql`, `folderId`, and `execute`. It also saves the SQL as a query,
and the tab and the query share one id. `open` needs `queryId` or `tabId`. `update` and `close` need
`tabId`.

## Read-only connections

`read_only` defaults to `true`. A connection that omits the key, or copies an example without it,
cannot write. A connection opts into writes by setting `read_only: false` explicitly. The value must
be a real boolean, so a string like `"false"` fails at startup instead of silently picking a mode.

When a connection is read-only, the server rejects a statement before it reaches the server unless
it is a single read statement. Writes, DDL, `EXEC`, and multi-statement payloads fail with a
read-only error, and the rejection happens before a pool opens.

The guard is a small lexer, not a regex, and each dialect supplies its own lexical rules. That
matters where a read can still write or lock.

On MySQL the server refuses `INTO OUTFILE` and `INTO DUMPFILE` (a file write), `INTO @var`,
`FOR UPDATE`, `FOR SHARE`, and `LOCK IN SHARE MODE` (row locks), a write hidden inside an executable
comment such as `/*!50000 ... */` (MySQL runs those), and `EXPLAIN ANALYZE UPDATE` (which executes
the update it describes).

On SQL Server the server refuses `INTO`, `OPENROWSET`, `OPENDATASOURCE`, and `USE`.

Both dialects refuse a statement whose only comment-free reading is a write, and both refuse more
than one statement per call. Both accept a statement that starts with `SELECT`, `VALUES`, `TABLE`,
`EXPLAIN`, `SHOW`, `DESCRIBE`, or `DESC`. A statement that starts with `WITH` is accepted only when
it contains no banned word anywhere, because a common table expression can lead into an `UPDATE` or
a `DELETE`.

### Failure modes

The guard is a safety net, not the only one. The stronger configuration is a login that cannot write
at all.

- **A writable connection has no guard.** With `read_only: false`, the server passes the statement
  to the driver unchanged. Permissions are the only limit.
- **The guard reads text, not intent.** It rejects a statement it cannot prove is a read. A read
  written in a form the lexer does not recognize is refused, and the error names the word that
  caused it.
- **A guard bug is a write.** If the lexer misses a form, the statement reaches the server. Only the
  login's permissions stop it then.
- **A write transaction is not a safety net.** Do not wrap a write in `BEGIN TRAN ... ROLLBACK` to
  test the guard. A write transaction on a production table blocks other users.

## Result limits

Query results are bounded twice, by rows and by bytes. Every database tool result is bounded by
bytes. The workspace tools are bounded by bytes only for their list actions and for `open_table`.

`execute_sql` stops storing rows at the row limit. On SQL Server the driver streams, so a statement
with no bound of its own cannot exhaust the process's memory, and the row count stays exact. On
MySQL the driver returns the full result first and the server trims it, so a very large result costs
memory before the cap applies.

Every capped result is bounded by `max_result_bytes`, default 262144 bytes. The cap measures the
JSON text the client receives, indentation included, because that is what crosses the wire.

A result that would exceed the cap keeps the longest prefix of its record list that fits, and adds
`truncated: true` and `total_count` so a caller can tell a partial answer from a complete one.
`get_erd` drops any relationship whose source table was cut, so the graph never refers to a table
the caller did not receive. A result that fits is returned unchanged, with no extra fields.

A tool that reports on every connection takes the strictest cap among them, because the result
covers all of them.

A result with no record list that overflows is replaced by a notice naming the cap and the fix,
rather than being sent oversized.

`manage_saved_queries` with `action: "get"` returns the stored SQL with no byte cap, because the
stored text is what the caller asked for. A saved query larger than `max_result_bytes` is returned
whole.

Set `max_result_bytes` higher if you routinely read wide text columns and the truncation gets in the
way. The cap exists because a multi-megabyte result stalls an agent's context, not because the
database cannot return it.

## Develop

```bash
npm ci
npm test
npm run lint
node scripts/check-result-caps.mjs
node scripts/check-safety-gaps.mjs
```

`npm test` runs the Node test runner over `test/`. It needs no database, because every database call
is a fake or an in-memory driver. One test spawns the real server as a subprocess and checks the
stdio handshake, so the suite needs permission to start child processes. A sandbox that blocks
`spawn` fails the suite with `EPERM` before any assertion runs.

`npm run lint` syntax-checks every file under `src/`. It exits non-zero if any file fails to parse.

`check-result-caps.mjs` drives the nine database-facing tools through a fake pool and proves each
result stays within `max_result_bytes`. It needs no database.

`check-safety-gaps.mjs` proves three properties. `read_only` defaults to `true`, a result is bounded
in bytes and not only in rows, and closing stdin exits the process. It reads `config.json`, so
create that file first. Without it the script stalls and then fails on an unsettled await.

One more script measures catalog query cost and needs a reachable SQL Server:

```bash
node scripts/bench-list-tables.mjs
```

### Layout

`src/index.js` registers the tools and owns process lifecycle. `src/config.js` validates
`config.json`, `.env`, and defaults. `src/database.js` owns pools, the row and byte caps, and the
guard call. `src/dialects/` holds one module per `db_type` plus `syntax.js`, the shared read-only
scanner. `src/tools/` holds the handlers, their zod schemas, and `tool-result.js`.
`src/workspace-store.js` persists saved queries and tabs as one JSON file.

`test/` mirrors those modules and needs no database.

Adding a dialect means one entry in `src/dialects/index.js` and its lexical rules in its own syntax
descriptor. Nothing in `src/tools/` names a dialect.

### Verify against a real database

The test suite proves behaviour without a database. To prove the server works against a real
instance, drive it with an MCP client. This repository ships a verification skill for that. The
skill expects a connection named `prod` and a read-only login, so edit
`.agents/skills/verify-sql-mcp/scripts/lib.mjs` and your `config.json` before the first run. The
commands below are the shape, not a working setup:

```bash
node .agents/skills/verify-sql-mcp/scripts/doctor.mjs
node .agents/skills/verify-sql-mcp/scripts/drive.mjs --run <run dir from doctor>
node .agents/skills/verify-sql-mcp/scripts/cleanup.mjs --run <run dir>
```

The doctor proves the login is read-only before anything is driven. The drive records every JSON-RPC
frame, a read result checked against a second independent session, and a write attempt refused by
both the guard and the server. See `.agents/skills/verify-sql-mcp/SKILL.md`.

MySQL has its own pair, because the safety argument is different. A local MySQL login usually holds
write permission, so the guard is what refuses a write, and the doctor proves the guard statement by
statement instead of proving the login is powerless.

```bash
node .agents/skills/verify-sql-mcp/scripts/mysql-doctor.mjs
node .agents/skills/verify-sql-mcp/scripts/mysql-drive.mjs --run <run dir from doctor>
```

The skill targets one specific instance. Change the expected login and database in
`.agents/skills/verify-sql-mcp/scripts/lib.mjs` before pointing it at a different server. It also
assumes a read-only login, so `doctor.mjs` reports blocked and refuses to drive against a login that
holds write permissions. That refusal is the point, not a bug. The MySQL helpers read their target
from `.agents/skills/verify-sql-mcp/scripts/mysql-lib.mjs`, so change that file too.

### Live checks are read-only

If you drive the server against a real database by hand, use read-only SQL such as `SELECT 1` and
never run a destructive statement. Rely on permissions rather than on a transaction you intend to
roll back.

## Contributing

Keep a change to one concern, and run the full gate before you open a pull request:

```bash
npm test
npm run lint
node scripts/check-result-caps.mjs
node scripts/check-safety-gaps.mjs
```

Paste the real output in the pull request. A change that touches results, caps, config defaults, or
shutdown also needs both check scripts to pass.

Nothing may write to stdout. stdout carries JSON-RPC only, and diagnostics go to stderr. A test
checks this against a real subprocess. `AGENTS.md` holds the short version of these commands for an
agent changing the code.

## License

MIT. No `LICENSE` file is committed yet, so add one before you rely on this in a project that needs
a license file on disk.
