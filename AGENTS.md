# AGENTS.md

A stdio MCP server giving an MCP client read access to SQL Server and MySQL. 12 tools, one
`config.json`, no port and no GUI. `README.md` is the user manual; this is the short version for an
agent changing the code.

## Commands

```bash
npm ci                               # install; package-lock.json is committed
cp config.example.json config.json   # gitignored; check-safety-gaps.mjs needs it
cp .env.example .env                 # gitignored; the example config reads these names
npm test                             # node --test over test/; no database needed
npm run lint                         # node --check on every file under src/
node scripts/check-result-caps.mjs   # every tool stays within max_result_bytes
node scripts/check-safety-gaps.mjs   # read_only default, byte cap, stdin-close exit
```

Done means `npm test` and `npm run lint` both exit 0, plus both check scripts for a change touching
results, caps, config defaults, or shutdown. Paste the real output.

The two copies are a precondition. Without `config.json`, `check-safety-gaps.mjs` stalls eight
seconds and dies on an unsettled await, without naming the check that failed. `npm test` also spawns
a real server, so a sandbox that blocks `spawn` fails it with `EPERM` before any assertion runs.
There is no TypeScript, no build step, and no CI config. Those commands are the whole gate.

## Layout

`src/index.js` registers the tools and owns process lifecycle. `src/config.js` validates
`config.json`, `.env`, and defaults. `src/database.js` owns pools, the row and byte caps, and the
guard call. `src/dialects/` holds one module per `db_type` plus `syntax.js`, the shared read-only
scanner. `src/tools/` holds the handlers, their zod schemas, and `tool-result.js`.
`src/workspace-store.js` persists saved queries and tabs as one JSON file.

`test/` mirrors those modules and needs no database. `.agents/skills/verify-sql-mcp/` drives the
real server with an MCP client; read its `SKILL.md` before pointing anything at a live instance.

Adding a dialect means one entry in `src/dialects/index.js` and its lexical rules in its own syntax
descriptor. Nothing in `src/tools/` names a dialect.

## Config and environment

Credentials are named indirectly through `username_env` and `password_env`. A password variable that
is unset at all is an error; an empty value is accepted for MySQL. `SQL_MCP_CONFIG` defaults to
`./config.json` and `SQL_MCP_DATA_DIR` to `./data`, both resolved against the working directory. The
server connects lazily on the first database tool call, so a clean startup proves nothing about
credentials.

## Invariants and traps

Every tool result is capped twice. `execute_sql` streams rows and stops storing at `max_row_limit`,
and `toolResult` and `listResult` keep the longest prefix that fits `max_result_bytes`, measured on
the pretty-printed JSON the client receives. A new tool must route through `listResult` with its
record list named, or an oversized result is replaced by a notice instead of truncated.

`read_only` defaults to `true` and must be a real boolean. The guard rejects a statement before a
pool opens, so a write that reaches the driver is already a bug. It is a lexer, not a regex, and each
dialect supplies its own banned words and sequences, so a new lexical rule belongs in the dialect's
syntax descriptor and never in the shared scanner.

Nothing may write to stdout. stdout carries JSON-RPC only and diagnostics go to stderr, and a test
checks this against a real subprocess. `npm run lint` checks syntax only, so nothing enforces
formatting, imports, or unused code.
