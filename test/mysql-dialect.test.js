import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { DatabaseManager } from '../src/database.js';
import {
  TYPE_NAMES,
  assertReadOnlyQuery,
  createMysqlDialect,
  quoteIdentifier,
} from '../src/dialects/mysql.js';

const require = createRequire(import.meta.url);

function fakeDatabase({ rows = [], fields = [], readOnly = true } = {}) {
  const calls = [];
  class FakePool {
    constructor(config) {
      this.config = config;
    }

    async query(options) {
      if (typeof options === 'string') {
        calls.push(['ready', options]);
        return [[{ ping: 1 }], []];
      }
      calls.push(['query', options.sql, options.values, options.timeout]);
      return [rows, fields];
    }

    async end() {
      calls.push(['end']);
    }
  }

  const database = new DatabaseManager(
    {
      connections: [{
        name: 'laragon',
        db_type: 'mysql',
        host: '127.0.0.1',
        port: 3306,
        database: 'eosys',
        username: 'eosys',
        password: '',
        read_only: readOnly,
        max_row_limit: 500,
        max_result_bytes: 262_144,
        query_timeout_ms: 1000,
        connection_timeout_ms: 1000,
        options: {},
      }],
    },
    { dialects: { mysql: createMysqlDialect({ driver: { createPool: (config) => new FakePool(config) } }) } },
  );
  database.calls = calls;
  return database;
}

test('mysql guard — hidden writes — rejects the forms MySQL accepts but a read does not', () => {
  for (const sql of [
    'SELECT * FROM t INTO OUTFILE \'/tmp/leak\';',
    'SELECT * FROM t INTO DUMPFILE \'/tmp/leak\';',
    'SELECT 1 INTO @v;',
    'SELECT * FROM t FOR UPDATE;',
    'SELECT * FROM t LOCK IN SHARE MODE;',
    'WITH c AS (SELECT 1) UPDATE t SET a = 1;',
    'WITH c AS (SELECT 1) DELETE FROM t;',
    'EXPLAIN ANALYZE UPDATE t SET a = 1;',
    // The body of an executable comment runs on the server, so it cannot be stripped as a comment.
    'SELECT /*!50000 INTO OUTFILE \'/tmp/leak\' */ 1;',
    'REPLACE INTO t VALUES (1);',
    'LOAD DATA INFILE \'/tmp/x\' INTO TABLE t;',
    'CALL do_something();',
    'SELECT 1; DELETE FROM t;',
  ]) {
    assert.throws(() => assertReadOnlyQuery(sql), /Read-only connections/, sql);
  }
});

test('mysql guard — read syntax — allows comments, quoting and the plans the tools send', () => {
  for (const sql of [
    'SELECT 1 # a hash comment',
    'SELECT 1 -- a dash comment',
    'SELECT 1--1',
    'SELECT /*!50000 1 */',
    'SELECT `delete` FROM `eosys`.`t`',
    "SELECT 'it\\'s; DROP TABLE t'",
    "SELECT 'it''s; DROP TABLE t'",
    'SHOW TABLES',
    'DESCRIBE departments',
    'TABLE departments',
    'SELECT * FROM `eosys`.`departments` LIMIT 100;',
  ]) {
    assert.doesNotThrow(() => assertReadOnlyQuery(sql), sql);
  }
});

test('mysql guard — dash without whitespace — is arithmetic, not a comment', () => {
  // `SELECT 1--2` is 1 - (-2) on MySQL, so a guard that stripped it would hide what follows.
  assert.throws(() => assertReadOnlyQuery('SELECT 1--2 INTO @v'), /Read-only connections/);
});

test('mysql catalog — bound values — follow the placeholder order the plan emits', () => {
  const dialect = createMysqlDialect();
  const plan = dialect.catalogPlan(
    { schema: 'eosys' },
    { table: 'departments', pattern: 'name', tables: ['departments', 'alarms'] },
  );
  assert.deepEqual(plan.values, ['eosys', 'departments', '%name%', 'departments', 'alarms']);
  assert.equal(plan.sql.split('?').length - 1, plan.values.length);
  assert.doesNotMatch(plan.sql, /sys\./);
});

test('mysql catalog — foreign keys — windowed so a column in two keys reports one pair', () => {
  const dialect = createMysqlDialect();
  const plan = dialect.catalogPlan({ schema: 'eosys' });
  assert.match(plan.sql, /ROW_NUMBER\(\) OVER/);
  assert.match(plan.sql, /AND k\.rn = 1/);
  assert.match(plan.sql, /ORDER BY CONSTRAINT_NAME/);
});

test('mysql objects — list_tables — asks for objects, never for columns', () => {
  const dialect = createMysqlDialect();
  const plan = dialect.objectsPlan({ schema: 'eosys' });
  assert.deepEqual(plan.values, ['eosys']);
  assert.doesNotMatch(plan.sql, /information_schema\.COLUMNS/);
  assert.doesNotMatch(plan.sql, /KEY_COLUMN_USAGE/);
});

test('mysql catalog — mapping — turns YES/NO and 1/0 into real booleans', () => {
  const dialect = createMysqlDialect();
  const [row] = dialect.mapCatalogRows([{
    schema_name: 'eosys',
    object_name: 'departments',
    object_type: 'BASE TABLE',
    column_name: 'name',
    data_type: 'varchar',
    max_length: 255,
    is_nullable: 'NO',
    default_definition: null,
    is_primary_key: 1,
    is_foreign_key: 0,
    referenced_schema_name: null,
    referenced_object_name: null,
    referenced_column_name: null,
  }]);
  assert.equal(row.is_nullable, false);
  assert.equal(row.is_primary_key, true);
  assert.equal(row.is_foreign_key, false);
  // Boolean('NO') is true, which is the trap this mapping exists to close.
  assert.equal(Boolean(row.is_nullable), false);
});

test('mysql type names — every driver type id is named', () => {
  const { Types } = require('mysql2');
  const driverIds = [...new Set(Object.values(Types).filter((value) => typeof value === 'number'))].sort(
    (left, right) => left - right,
  );
  assert.deepEqual(Object.keys(TYPE_NAMES).map(Number).sort((left, right) => left - right), driverIds);
});

test('mysql scope — schema is the database — one name fills both levels', () => {
  const dialect = createMysqlDialect();
  const connection = { name: 'laragon', database: 'eosys' };
  assert.deepEqual(dialect.resolveScope(connection, {}), { database: 'eosys', schema: 'eosys' });
  assert.deepEqual(dialect.resolveScope(connection, { schema: 'other' }), { database: 'other', schema: 'other' });
  assert.deepEqual(dialect.resolveScope(connection, { database: 'other' }), { database: 'other', schema: 'other' });
  assert.equal(dialect.defaultSchema(connection), 'eosys');
  // A MySQL schema is a database, so the two arguments name the same thing and the first one wins
  // rather than the call failing.
  assert.deepEqual(
    dialect.resolveScope(connection, { database: 'eosys', schema: 'dbo' }),
    { database: 'eosys', schema: 'eosys' },
  );
});

test('mysql identifier — quoting — escapes nothing because it admits nothing', () => {
  assert.equal(quoteIdentifier('departments'), '`departments`');
  assert.throws(() => quoteIdentifier('t`; DROP TABLE t; --'), /Invalid identifier/);
});

test('mysql manager — describe_table — reads the catalog and keeps the schema equal to the database', async () => {
  const database = fakeDatabase({
    rows: [{
      schema_name: 'eosys',
      object_name: 'departments',
      object_type: 'BASE TABLE',
      column_name: 'id',
      data_type: 'bigint',
      max_length: null,
      is_nullable: 'NO',
      default_definition: null,
      is_primary_key: 1,
      is_foreign_key: 0,
      referenced_schema_name: null,
      referenced_object_name: null,
      referenced_column_name: null,
    }],
  });
  const { rows } = await database.describeCatalog({ connection: 'laragon', table: 'departments' });
  assert.equal(rows[0].is_nullable, false);
  assert.deepEqual(database.calls[0], ['ready', 'SELECT 1']);
  assert.deepEqual(database.calls[1][2], ['eosys', 'departments']);
  await database.close();
  assert.deepEqual(database.calls.at(-1), ['end']);
});

test('mysql manager — query — sends the row cap, the values and the connection timeout', async () => {
  const database = fakeDatabase({ rows: [[1], [2]], fields: [{ name: 'v', columnType: 8, flags: 1 }] });
  const result = await database.query('laragon', 'SELECT 1 AS v', { rowLimit: 10 });
  assert.deepEqual(result.columns, [{
    name: 'v',
    data_type: 'bigint',
    default_value: null,
    is_nullable: false,
    is_primary_key: false,
    is_foreign_key: false,
  }]);
  assert.deepEqual(result.rows, [[1], [2]]);
  assert.equal(result.truncated, false);
  const last = database.calls.at(-1);
  assert.equal(last[1], 'SELECT 1 AS v');
  assert.equal(last[2], undefined);
  assert.equal(last[3], 1000);
});

test('mysql manager — query — applies the row cap to what the caller receives', async () => {
  const database = fakeDatabase({ rows: [[1], [2], [3]], fields: [{ name: 'v', columnType: 8, flags: 1 }] });
  const result = await database.query('laragon', 'SELECT 1 AS v', { rowLimit: 1 });
  assert.deepEqual(result.rows, [[1]]);
  assert.equal(result.row_count, 1);
  assert.equal(result.truncated, true);
});

test('mysql manager — list_connections details — reports read_only beside the databases', async () => {
  const database = fakeDatabase({ rows: [{ name: 'eosys' }], readOnly: false });
  const details = await database.listConnectionDetails();
  assert.equal(details[0].read_only, false);
  assert.deepEqual(details[0].available_databases, ['eosys']);
  await database.close();
});

test('mysql manager — read-only — refuses a write before the pool opens', async () => {
  const database = fakeDatabase();
  await assert.rejects(() => database.query('laragon', 'DELETE FROM departments'), /Read-only connections/);
  assert.deepEqual(database.calls, []);
});

test('mysql manager — write on a writable connection — reports what the driver reported', async () => {
  const database = fakeDatabase({
    rows: {
      fieldCount: 0,
      affectedRows: 2,
      insertId: 0,
      info: 'Records: 2  Duplicates: 0  Warnings: 0',
    },
    fields: undefined,
    readOnly: false,
  });
  const result = await database.query('laragon', "INSERT INTO departments (name) VALUES ('a'), ('b')");
  assert.deepEqual(result.columns, []);
  assert.deepEqual(result.rows, []);
  assert.equal(result.row_count, 0);
  assert.equal(result.affected_rows, 2);
  assert.equal(result.insert_id, 0);
  assert.equal(result.info, 'Records: 2  Duplicates: 0  Warnings: 0');
  assert.equal(result.truncated, false);
});

test('mysql manager — write — keeps a zero affected-row count instead of dropping it', async () => {
  const database = fakeDatabase({
    rows: { fieldCount: 0, affectedRows: 0, insertId: 0, info: 'Rows matched: 0  Changed: 0  Warnings: 0' },
    fields: undefined,
    readOnly: false,
  });
  const result = await database.query('laragon', "UPDATE departments SET name = 'x' WHERE 1 = 0");
  assert.equal(result.affected_rows, 0);
  assert.match(result.info, /Rows matched: 0/);
});

test('mysql manager — DDL — reports the header without an empty info field', async () => {
  const database = fakeDatabase({
    rows: { fieldCount: 0, affectedRows: 0, insertId: 0, info: '' },
    fields: undefined,
    readOnly: false,
  });
  const result = await database.query('laragon', 'CREATE TEMPORARY TABLE probe (id int)');
  assert.equal(result.affected_rows, 0);
  assert.equal('info' in result, false);
});

test('mysql manager — CALL — returns the last row set and the trailing header count', async () => {
  const fields = [{ name: 'id', columnType: 3, flags: 1 }];
  const header = { fieldCount: 0, affectedRows: 1, insertId: 0, info: '' };
  const database = fakeDatabase({
    rows: [[[7]], header],
    fields: [fields, undefined],
    readOnly: false,
  });
  const result = await database.query('laragon', 'CALL refresh_and_list()');
  assert.deepEqual(result.columns.map((column) => column.name), ['id']);
  assert.deepEqual(result.rows, [[7]]);
  assert.equal(result.affected_rows, 1);
});

test('mysql manager — CALL with no row set — reports the last header as the write', async () => {
  const first = { fieldCount: 0, affectedRows: 3, insertId: 0, info: 'first' };
  const last = { fieldCount: 0, affectedRows: 1, insertId: 0, info: 'last' };
  const database = fakeDatabase({ rows: [first, last], fields: [undefined, undefined], readOnly: false });
  const result = await database.query('laragon', 'CALL touch_rows()');
  assert.deepEqual(result.rows, []);
  assert.equal(result.affected_rows, 1);
  assert.equal(result.info, 'last');
});

test('mysql manager — writable connection — sends DDL and CALL to the driver unguarded', async () => {
  const database = fakeDatabase({
    rows: { fieldCount: 0, affectedRows: 0, insertId: 0, info: '' },
    fields: undefined,
    readOnly: false,
  });
  await database.query('laragon', 'DROP TEMPORARY TABLE probe');
  await database.query('laragon', 'CALL do_something()');
  assert.deepEqual(database.calls.filter((call) => call[0] === 'query').map((call) => call[1]), [
    'DROP TEMPORARY TABLE probe',
    'CALL do_something()',
  ]);
});

test('mysql manager — writable connection — keeps multipleStatements off in the pool config', () => {
  // A writable connection is still one statement per call; the driver is the second enforcement
  // point, so the option must stay fixed regardless of read_only.
  const dialect = createMysqlDialect();
  const config = dialect.buildPoolConfig({
    host: '127.0.0.1',
    port: 3306,
    username: 'u',
    password: '',
    database: 'd',
    connection_timeout_ms: 1000,
    options: {},
  }, null);
  assert.equal(config.multipleStatements, false);
});
