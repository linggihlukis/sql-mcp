// mysql-write-drive.mjs — one serialized drive of the writable MySQL path.
//
// What "done" requires, and where each piece is proven:
//   1. the connection is configured writable ................... config.json, resolved
//   2. a scratch table is created, written and dropped ......... session A (raw JSON-RPC frames)
//   3. every affected_rows matches the database ................ a direct mysql2 witness, no MCP
//   4. manage_query_tab execute returns its result ............. session A, witness on the rows
//   5. a read-only clone refuses the same write ................ session B (raw frames), witness
//   6. no existing data moved .................................. fingerprint of departments, direct
//   7. the real config was never edited ........................ sha256 before and after
//
// Safety rules this file enforces, not merely documents:
//   * The only table it creates is `sql_mcp_wp_<base36 time>_<base36 pid>`, and it is dropped in a
//     finally block. It never writes to an existing table; `departments` is read only, for the
//     fingerprint.
//   * Session B runs against a generated read-only clone of the same connection in the run
//     directory. That file holds env var NAMES only; the values travel in the child's environment.
//     config.json is hashed before and after and is never written.
//   * One process at a time; drives are serialized. No BEGIN/COMMIT, no transaction safety net.
//
// Usage:
//   node .agents/skills/verify-sql-mcp/scripts/mysql-write-drive.mjs [--run <dir>]

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import mysql from 'mysql2/promise';
import {
  CONFIG_PATH,
  MYSQL_FINGERPRINT_SQL,
  RawSession,
  createReport,
  createRunDir,
  makeRedactor,
  mysqlDirectQuery,
  parseArgs,
  parseToolJson,
  printChecks,
  readRawConfig,
  resolveMysqlConnection,
  resolveRunDir,
  toolText,
  writeJson,
} from './mysql-lib.mjs';

export const WRITE_CONNECTION_NAME = process.env.SQL_MCP_VERIFY_MYSQL_WRITE_CONNECTION || 'eosys';

function configHash() {
  return crypto.createHash('sha256').update(fs.readFileSync(CONFIG_PATH)).digest('hex');
}

function scratchTableName() {
  return `sql_mcp_wp_${Date.now().toString(36)}_${process.pid.toString(36)}`;
}

async function callTool(session, name, args) {
  const response = await session.request('tools/call', { name, arguments: args });
  return {
    response,
    value: parseToolJson(response.result),
    text: toolText(response.result) ?? '',
    isError: response.result?.isError === true,
  };
}

/**
 * A read-only clone of the writable connection, written beside the evidence rather than over the
 * real config. Only env var names go in the file; the resolved values go in the child environment.
 */
function writeReadOnlyClone(runDir, connection) {
  const raw = (readRawConfig().connections || []).find((entry) => entry.name === connection.name);
  if (!raw) throw new Error(`Connection "${connection.name}" disappeared from ${CONFIG_PATH}.`);
  const cloneName = `${connection.name}_read_only_clone`;
  const clone = {
    ...raw,
    name: cloneName,
    read_only: true,
    username_env: 'SQL_MCP_VERIFY_CLONE_USERNAME',
    password_env: 'SQL_MCP_VERIFY_CLONE_PASSWORD',
  };
  delete clone.username;
  delete clone.password;
  const filePath = path.join(runDir, 'mysql-write-readonly-clone.json');
  fs.writeFileSync(filePath, `${JSON.stringify({ connections: [clone] }, null, 2)}\n`);
  return {
    filePath,
    connectionName: cloneName,
    env: {
      SQL_MCP_DOTENV: path.join(path.dirname(CONFIG_PATH), '.env'),
      SQL_MCP_VERIFY_CLONE_USERNAME: connection.username,
      SQL_MCP_VERIFY_CLONE_PASSWORD: connection.password,
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  let connection;
  try {
    connection = resolveMysqlConnection(WRITE_CONNECTION_NAME);
  } catch (error) {
    process.stdout.write(`BLOCKED  preconditions.connection ${error.message}\n`);
    process.stdout.write(
      '\nBLOCKED: no writable MySQL connection to drive. Set SQL_MCP_VERIFY_MYSQL_WRITE_CONNECTION.\n',
    );
    process.exitCode = 2;
    return;
  }
  if (connection.read_only) {
    process.stdout.write(
      `BLOCKED  preconditions.connection "${connection.name}" is read_only: true.\n`,
    );
    process.stdout.write('\nBLOCKED: the write drive needs a connection with read_only: false.\n');
    process.exitCode = 2;
    return;
  }

  const runDir = args.run ? resolveRunDir(args.run) : createRunDir();
  const redact = makeRedactor([connection.password]);
  const report = createReport();
  const table = scratchTableName();
  const hashBefore = configHash();
  const results = {
    runDir,
    startedAt: new Date().toISOString(),
    db_type: 'mysql',
    connection: connection.name,
    scratch_table: table,
    configHash: hashBefore,
  };
  const sessions = [];

  report.note('config.path', CONFIG_PATH);
  report.note('config.sha256', hashBefore);
  report.check('preconditions.connection', connection.raw.db_type === 'mysql', {
    name: connection.name,
    db_type: connection.raw.db_type,
    database: connection.database,
    read_only: connection.read_only,
  });
  report.check('preconditions.connection-writable', connection.read_only === false, {
    read_only: connection.read_only,
  });

  const pool = mysql.createPool({
    host: connection.host,
    port: connection.port,
    user: connection.username,
    password: connection.password,
    database: connection.database,
    connectTimeout: 10_000,
    supportBigNumbers: true,
    multipleStatements: false,
    ...connection.options,
  });
  const direct = (text) => mysqlDirectQuery(pool, text);
  const scalar = async (text) => {
    const [rows] = await pool.query({ sql: text, rowsAsArray: true });
    return rows[0]?.[0];
  };

  try {
    const before = await pool.query({ sql: MYSQL_FINGERPRINT_SQL, rowsAsArray: true });
    const [[baselineCount, baselineFingerprint]] = before[0];
    results.baseline = { row_count: baselineCount, row_fingerprint: String(baselineFingerprint) };
    report.check(
      'preconditions.scratch-table-absent',
      Number(await scalar(
        `SELECT COUNT(*) FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${table}'`,
      )) === 0,
      { table },
    );

    // ---------------------------------------------------------------- session A: writable
    const sessionA = new RawSession({ label: 'A-write-raw', runDir, redact });
    sessions.push(sessionA);
    await sessionA.start();
    const initA = await sessionA.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'verify-write-raw', version: '1.0.0' },
    });
    report.check('mcp.initialize', initA.result?.serverInfo?.name === 'sql-mcp', initA.result);
    sessionA.notify('notifications/initialized', {});
    const listA = await sessionA.request('tools/list', {});
    report.check(
      'mcp.tools-list',
      (listA.result?.tools ?? []).length === 12,
      { count: (listA.result?.tools ?? []).length },
    );

    const listed = await callTool(sessionA, 'list_connections', {});
    const entries = Array.isArray(listed.value) ? listed.value : listed.value?.connections ?? [];
    const selected = entries.find((entry) => entry?.name === connection.name);
    report.check('connections.read-only-flag', selected?.read_only === false, selected);

    const create = await callTool(sessionA, 'execute_sql', {
      connection: connection.name,
      sql: `CREATE TABLE \`${table}\` (\`id\` int PRIMARY KEY, \`name\` varchar(32))`,
    });
    report.check(
      'write.create-header',
      !create.isError && create.value?.affected_rows === 0 && Array.isArray(create.value?.rows),
      create.value ?? create.text,
    );

    const insert = await callTool(sessionA, 'execute_sql', {
      connection: connection.name,
      sql: `INSERT INTO \`${table}\` (\`id\`, \`name\`) VALUES (1, 'a'), (2, 'b')`,
    });
    const witnessInserted = Number(await scalar(`SELECT COUNT(*) FROM \`${table}\``));
    report.check(
      'write.insert-affected-rows',
      insert.value?.affected_rows === 2 && /Records: 2/.test(insert.value?.info ?? ''),
      insert.value ?? insert.text,
    );
    report.check('write.insert-witness', witnessInserted === 2, { witness_rows: witnessInserted });

    const update = await callTool(sessionA, 'execute_sql', {
      connection: connection.name,
      sql: `UPDATE \`${table}\` SET \`name\` = 'aa' WHERE \`id\` = 1`,
    });
    const witnessName = await scalar(`SELECT \`name\` FROM \`${table}\` WHERE \`id\` = 1`);
    report.check(
      'write.update-affected-rows',
      update.value?.affected_rows === 1 && /Rows matched: 1/.test(update.value?.info ?? ''),
      update.value ?? update.text,
    );
    report.check('write.update-witness', witnessName === 'aa', { witness_name: witnessName });

    const noop = await callTool(sessionA, 'execute_sql', {
      connection: connection.name,
      sql: `UPDATE \`${table}\` SET \`name\` = 'zz' WHERE \`id\` = 99`,
    });
    report.check(
      'write.noop-update-zero',
      noop.value?.affected_rows === 0 && 'affected_rows' in (noop.value ?? {}),
      noop.value ?? noop.text,
    );

    const tab = await callTool(sessionA, 'manage_query_tab', {
      action: 'create',
      connection: connection.name,
      sql: `DELETE FROM \`${table}\` WHERE \`id\` = 2`,
      execute: true,
      title: 'verify write path',
    });
    const witnessAfterTab = Number(await scalar(`SELECT COUNT(*) FROM \`${table}\``));
    report.check(
      'write.tab-execute-result',
      tab.value?.result?.affected_rows === 1,
      tab.value ?? tab.text,
    );
    report.check('write.tab-witness', witnessAfterTab === 1, { witness_rows: witnessAfterTab });

    const readBack = await callTool(sessionA, 'execute_sql', {
      connection: connection.name,
      sql: `SELECT \`id\`, \`name\` FROM \`${table}\` ORDER BY \`id\``,
    });
    report.check(
      'write.read-shape-unchanged',
      !readBack.isError &&
        JSON.stringify(readBack.value?.rows) === JSON.stringify([[1, 'aa']]) &&
        readBack.value?.affected_rows === undefined,
      readBack.value ?? readBack.text,
    );

    // ---------------------------------------------------------------- session B: read-only clone
    const clone = writeReadOnlyClone(runDir, connection);
    const sessionB = new RawSession({
      label: 'B-readonly-raw',
      runDir,
      redact,
      configPath: clone.filePath,
      extraEnv: clone.env,
    });
    sessions.push(sessionB);
    await sessionB.start();
    const initB = await sessionB.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'verify-write-readonly', version: '1.0.0' },
    });
    report.check('read-only.initialize', initB.result?.serverInfo?.name === 'sql-mcp', initB.result);
    sessionB.notify('notifications/initialized', {});
    const refused = await callTool(sessionB, 'execute_sql', {
      connection: clone.connectionName,
      sql: `INSERT INTO \`${table}\` (\`id\`, \`name\`) VALUES (99, 'refused')`,
    });
    const witnessRefused = Number(await scalar(`SELECT COUNT(*) FROM \`${table}\` WHERE \`id\` = 99`));
    report.check(
      'read-only.refusal',
      refused.isError && /Read-only connections reject "INSERT"/.test(refused.text),
      refused.text,
    );
    report.check('read-only.witness-unchanged', witnessRefused === 0, { witness_rows: witnessRefused });

    const drop = await callTool(sessionA, 'execute_sql', {
      connection: connection.name,
      sql: `DROP TABLE \`${table}\``,
    });
    report.check('write.drop-header', !drop.isError, drop.value ?? drop.text);
    const tablesLeft = Number(await scalar(
      `SELECT COUNT(*) FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${table}'`,
    ));
    report.check('write.scratch-table-gone', tablesLeft === 0, { tables_left: tablesLeft });

    const after = await direct(MYSQL_FINGERPRINT_SQL);
    report.check(
      'safety.fingerprint-unchanged',
      JSON.stringify([Number(after.rows[0][0]), String(after.rows[0][1])]) ===
        JSON.stringify([Number(baselineCount), String(baselineFingerprint)]),
      { before: [Number(baselineCount), String(baselineFingerprint)], after: after.rows[0] },
    );
    report.check('config.unchanged', configHash() === hashBefore, {
      before: hashBefore,
      after: configHash(),
    });

    for (const session of sessions) {
      results[`session.${session.label}`] = await session.close();
    }
  } finally {
    await pool.query({ sql: `DROP TABLE IF EXISTS \`${table}\`` }).catch(() => {});
    await pool.end().catch(() => {});
  }

  const verdict = report.verdict;
  results.verdict = verdict;
  results.checks = report.checks;
  writeJson(runDir, 'mysql-write-drive.json', results);
  printChecks(report);
  process.stdout.write(`\n${verdict.toUpperCase()}  ${runDir}\n`);
  if (verdict !== 'pass') process.exitCode = 1;
}

main().catch((error) => {
  process.stdout.write(`FAIL  drive.crashed ${error.message}\n`);
  process.exitCode = 1;
});
