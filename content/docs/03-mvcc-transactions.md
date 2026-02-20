---
title: "MVCC and Transactions"
weight: 3
---

# MVCC and Transactions

## What is it?

**MVCC (Multi-Version Concurrency Control)** is PostgreSQL's fundamental mechanism for handling concurrent transactions. Instead of using locks to manage concurrent access, PostgreSQL creates multiple versions of rows, allowing readers and writers to operate without blocking each other.

### Key Concepts

#### Row Versions (Tuples)

- Every UPDATE creates a **new version** of the row, keeping the old version
- DELETE marks a row as deleted but doesn't physically remove it immediately
- Each row version has visibility information (transaction IDs) determining who can see it
- Old versions become "dead tuples" after no transaction needs them

#### Transaction IDs (xid)

- Every transaction gets a unique transaction ID (32-bit integer)
- Transaction IDs are used to determine row visibility
- **xid wraparound**: After ~4 billion transactions, IDs wrap around (autovacuum prevents issues)

#### Row-Level Lock Modes

PostgreSQL has 4 row-level lock modes, ordered from lightest to heaviest. They exist to separate **primary key protection** from **full row protection**, which allows foreign key checks to run without blocking unrelated updates.

**`FOR KEY SHARE`** — "I just need to make sure this **primary key still exists**"
- Acquired implicitly by foreign key checks. When you `INSERT INTO order_items (order_id, ...)`, PostgreSQL locks the parent `orders` row with `FOR KEY SHARE` to guarantee it won't be deleted or have its PK changed mid-flight
- Lightest lock — allows UPDATEs on non-key columns and coexists with almost everything

**`FOR SHARE`** — "I'm reading this row and **nothing should change** until I'm done"
- Acquired explicitly via `SELECT ... FOR SHARE`
- Blocks any UPDATE or DELETE, but allows other `FOR SHARE` readers

**`FOR NO KEY UPDATE`** — "I'm going to **modify this row, but not the primary key**"
- Acquired implicitly by most UPDATEs (e.g., `UPDATE orders SET price = 10` — PK untouched)
- Blocks other writers, but still allows `FOR KEY SHARE` — so FK checks on this row are **not blocked**

**`FOR KEY UPDATE`** — "I'm going to **change the primary key or delete this row**"
- Acquired implicitly by `DELETE` or `UPDATE` on PK/unique columns
- Heaviest lock — exclusive, blocks everything

**Compatibility matrix** (✓ = can coexist on the same row):

```
                      FOR KEY SHARE   FOR SHARE   FOR NO KEY UPDATE   FOR KEY UPDATE
FOR KEY SHARE               ✓              ✓              ✓                  ✗
FOR SHARE                   ✓              ✓              ✗                  ✗
FOR NO KEY UPDATE           ✓              ✗              ✗                  ✗
FOR KEY UPDATE              ✗              ✗              ✗                  ✗
```

The key insight: `FOR NO KEY UPDATE` (most UPDATEs) is compatible with `FOR KEY SHARE` (FK checks). Without this separation, every `UPDATE SET price = 10` would block concurrent `INSERT INTO order_items` — making foreign key-heavy schemas much slower.

**Visual example: how lock modes interact with foreign keys**

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Table: orders (parent)           Table: order_items (child)            │
│  ┌─────────────────────┐          ┌──────────────────────────┐          │
│  │ id │ price │ status │          │ id │ order_id │ product  │          │
│  │  1 │ 99.90 │ open   │          │    │    FK ───┼──→ orders.id        │
│  └─────────────────────┘          └──────────────────────────┘          │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Session A:  UPDATE orders SET price = 79.90 WHERE id = 1;              │
│              → acquires FOR NO KEY UPDATE on orders(id=1)               │
│              → PK not changed, just price                               │
│                                                                         │
│  Session B:  INSERT INTO order_items (order_id, product)                │
│              VALUES (1, 'widget');                                      │
│              → acquires FOR KEY SHARE on orders(id=1) to validate FK    │
│                                                                         │
│  ┌─────────────────────────────────────────────────┐                    │
│  │ orders row (id=1)                               │                    │
│  │                                                 │                    │
│  │   Session A: FOR NO KEY UPDATE  ──┐             │                    │
│  │                                   ├─ compatible │                    │
│  │   Session B: FOR KEY SHARE  ──────┘    (✓)      │                    │
│  │                                                 │                    │
│  │   Both proceed without blocking!                │                    │
│  └─────────────────────────────────────────────────┘                    │
│                                                                         │
├─────────────────────────────────────────────────────────────────────────┤
│  What if Session A was DELETE instead?                                  │
│                                                                         │
│  Session A:  DELETE FROM orders WHERE id = 1;                           │
│              → acquires FOR KEY UPDATE on orders(id=1)                  │
│              → PK will be removed                                       │
│                                                                         │
│  Session B:  INSERT INTO order_items (order_id, product)                │
│              VALUES (1, 'widget');                                      │
│              → needs FOR KEY SHARE on orders(id=1)                      │
│                                                                         │
│  ┌─────────────────────────────────────────────────┐                    │
│  │ orders row (id=1)                               │                    │
│  │                                                 │                    │
│  │   Session A: FOR KEY UPDATE  ─────┐             │                    │
│  │                                   ├─ conflict!  │                    │
│  │   Session B: FOR KEY SHARE  ──────┘    (✗)      │                    │
│  │                                                 │                    │
│  │   Session B WAITS until Session A commits       │                    │
│  │   or rolls back                                 │                    │
│  └─────────────────────────────────────────────────┘                    │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

> [!NOTE]
> `FOR KEY SHARE` and `FOR NO KEY UPDATE` are the most common locks in practice. You rarely see `FOR SHARE` or `FOR KEY UPDATE` unless the application uses them explicitly or modifies primary key columns.

#### MultiXact IDs

When two or more compatible locks coexist on the same row, PostgreSQL needs to record all of them. But the tuple header only has one `xmax` field — space for a single transaction ID. The solution: a **MultiXact ID**, a single value stored in `xmax` that points to a list of transactions and their lock modes in `pg_multixact/`.

**When are MultiXact IDs created?**

Any combination of compatible locks from the matrix above generates a MultiXact. In practice, the dominant case is:

- **Foreign key checks**: Each `INSERT INTO child_table` acquires `FOR KEY SHARE` on the parent row. With concurrent inserts referencing the same parent, multiple `FOR KEY SHARE` locks coexist → MultiXact
- Multiple `SELECT ... FOR SHARE` on the same row
- `FOR KEY SHARE` (FK check) coexisting with `FOR NO KEY UPDATE` (UPDATE on non-key columns)

**How it works:**

```
┌──────────────────────────────────────────────────────────────────────┐
│ Two transactions lock the same row with FOR SHARE                    │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  [A] SELECT * FROM orders WHERE id=1 FOR SHARE;  (xid=500)           │
│  [B] SELECT * FROM orders WHERE id=1 FOR SHARE;  (xid=501)           │
│                                                                      │
│  Tuple header can only hold ONE xmax value:                          │
│                                                                      │
│  ┌─────────────────────────────────────┐                             │
│  │ orders row (id=1)                   │                             │
│  │   xmin = 100                        │                             │
│  │   xmax = MultiXactId(42)  ◄─────────┼── single ID for the group   │
│  └─────────────────────────────────────┘                             │
│                                                                      │
│  pg_multixact/ maps MultiXactId(42) to:                              │
│  ┌──────────────────────────────────────┐                            │
│  │ offsets/  → MultiXact 42 has 2 members                            │
│  │ members/  → xid=500 (share), xid=501 (share)                      │
│  └──────────────────────────────────────┘                            │
│                                                                      │
│  Common in workloads with foreign keys:                              │
│  INSERT INTO order_items (order_id, ...) VALUES (1, ...);            │
│  → acquires FOR KEY SHARE on orders(id=1)                            │
│  → with concurrent inserts, this creates MultiXact IDs               │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

**MultiXact IDs have the same wraparound problem as transaction IDs** — they use a 32-bit counter and require VACUUM to freeze old values. PostgreSQL tracks MultiXact age separately with dedicated parameters (`vacuum_multixact_freeze_min_age`, `vacuum_multixact_freeze_table_age`, `autovacuum_multixact_freeze_max_age`). Freezing MultiXact IDs has the same I/O cost as freezing xids — see [Maintenance: VACUUM Freeze]({{< ref "10-maintenance#freeze" >}}).

> [!IMPORTANT]
> Workloads with heavy foreign key usage or shared row locks can generate MultiXact IDs much faster than regular transaction IDs. Monitor both `age(datfrozenxid)` and `mxid_age(datminmxid)` to avoid wraparound.

#### Visibility Rules

- Each transaction sees a consistent snapshot of the database
- Transactions only see rows committed before the transaction started (in READ COMMITTED) or before the snapshot was taken (in REPEATABLE READ/SERIALIZABLE)
- Concurrent transactions can modify different rows without blocking each other

**Visual Example: How MVCC Works**

```
┌────────────────────────────────┬──────────────────────────────────────┐
│       TRANSACTIONS             │      ROW VERSIONS (DISK)             │
├────────────────────────────────┼──────────────────────────────────────┤
│ Initial state                  │                                      │
│                                │  ┌────────────────────────────────┐  │
│                                │  │ v1: value=10                   │  │
│                                │  │     xmin=50, xmax=NULL         │  │
│                                │  │     (visible to all)           │  │
│                                │  └────────────────────────────────┘  │
├────────────────────────────────┼──────────────────────────────────────┤
│ [A] BEGIN (xid=100) ────┐      │                                      │
│     Snapshot: xmax=99   │      │  Same v1 above                       │
│                         │      │                                      │
│ [A] SELECT value ───────┼──────┼──> reads v1 (xmin=50 < 99)           │
│     returns 10          │      │      → returns 10                    │
│                         │      │                                      │
├─────────────────────────┼──────┼──────────────────────────────────────┤
│ [B] BEGIN (xid=101)     │      │                                      │
│                         │      │                                      │
│ [B] UPDATE value=20 ────┼──────┼──>┌────────────────────────────────┐ │
│                         │      │   │ v1: value=10                   │ │
│                         │      │   │     xmin=50, xmax=101   ◄──────┼─┼─ marked for deletion
│                         │      │   ├────────────────────────────────┤ │
│                         │      │   │ v2: value=20                   │ │
│                         │      │   │     xmin=101, xmax=NULL ◄──────┼─┼─ new version (not visible yet)
│                         │      │   └────────────────────────────────┘ │
│                         │      │                                      │
├─────────────────────────┼──────┼──────────────────────────────────────┤
│ [B] COMMIT              │      │                                      │
│                         │      │   v2 now visible to new snapshots    │
│                         │      │                                      │
├─────────────────────────┼──────┼──────────────────────────────────────┤
│ [A] SELECT value        │      │                                      │
│                         │      │                                      │
│  READ COMMITTED mode:   │      │                                      │
│    Takes NEW snapshot ──┼──────┼──> sees v2 (xmin=101 committed)      │
│    returns 20           │      │      → returns 20                    │
│                         │      │                                      │
│  REPEATABLE READ mode:  │      │                                      │
│    Uses OLD snapshot ───┼──────┼──> sees v1 (xmin=50, xmax=101>100)   │
│    (xmax=99)            │      │      → returns 10                    │
│                         │      │                                      │
├─────────────────────────┼──────┼──────────────────────────────────────┤
│ [A] COMMIT              │      │                                      │
│                         │      │                                      │
│                         │      │   v1 becomes DEAD TUPLE              │
│                         │      │   (needs VACUUM to reclaim space)    │
└─────────────────────────┴──────┴──────────────────────────────────────┘

Key concepts illustrated:
• xmin: transaction that created this row version
• xmax: transaction that deleted/updated this row version (NULL = current)
• Snapshot determines which xids are visible
• READ COMMITTED: new snapshot per statement
• REPEATABLE READ: one snapshot for entire transaction
• Dead tuples require VACUUM to reclaim space
```

#### Transaction Isolation Levels

PostgreSQL supports four isolation levels defined by the SQL standard:

**READ UNCOMMITTED** (treated as READ COMMITTED in PostgreSQL)
- PostgreSQL doesn't support true dirty reads
- Behaves identically to READ COMMITTED

**READ COMMITTED** (default)
- Each statement sees a fresh snapshot of committed data
- Can see different data within the same transaction
- Most common isolation level, good balance of consistency and performance

**REPEATABLE READ**
- Snapshot taken at start of first query in transaction
- All queries in the transaction see the same data
- Prevents non-repeatable reads and phantom reads
- Can cause serialization errors on write conflicts

**SERIALIZABLE**
- Strongest isolation level
- Transactions appear to execute serially
- Prevents all concurrency anomalies
- Can cause more serialization errors requiring retry logic

## Why it matters

### Performance Benefits

**Non-blocking reads**
- Readers never block writers
- Writers never block readers
- Only writers block other writers (on the same row)
- Enables high concurrency without lock contention

**No lock escalation**
- PostgreSQL doesn't escalate row locks to table locks
- Thousands of row locks don't degrade to table lock
- Predictable locking behavior

### Operational Impact

**VACUUM requirement**
- Dead tuples must be cleaned up by VACUUM
- Without VACUUM, tables bloat indefinitely
- **Performance impact of dead tuples**:
  - **Sequential scans**: Read blocks containing dead tuples from disk/cache, process them, then discard - wasted I/O and CPU
  - **Index scans**: Index entries can point to dead tuples, causing useless heap lookups
  - **Cache pollution**: Dead tuples occupy shared_buffers and OS page cache, reducing space for live data
  - **Larger physical size**: More disk blocks to read, slower backups, longer checkpoint times
  - **Index bloat**: Only when HOT (Heap-Only Tuple) updates don't apply - if UPDATEs modify indexed columns or page has no space, indexes grow with new entries. HOT updates avoid index bloat by keeping updates in the same heap page.

**Long-running transactions are dangerous**
- Block VACUUM from removing dead tuples
- Can cause severe table bloat
- Increase database size and slow down queries
- **Critical**: A single long-running transaction affects the ENTIRE database

**Transaction ID wraparound**
- Must vacuum regularly to prevent xid wraparound
- If wraparound occurs, database shuts down to prevent data loss
- Autovacuum has special aggressive mode to prevent this

### Concurrency Challenges

**UPDATE conflicts**
- Two transactions updating the same row: second one waits or fails
- In REPEATABLE READ/SERIALIZABLE: can cause serialization errors

**Serialization errors**
- Application must handle `ERROR: could not serialize access`
- Requires retry logic in application code
- More common in REPEATABLE READ and SERIALIZABLE

## How to monitor

### Check for Long-Running Transactions

Long-running transactions are the #1 cause of operational issues with MVCC.

```sql
SELECT
    pid,
    usename,
    application_name,
    state,
    now() - xact_start AS transaction_duration,
    now() - query_start AS query_duration,
    query
FROM pg_stat_activity
WHERE xact_start IS NOT NULL
ORDER BY xact_start
LIMIT 10;
```

**Example output:**
```
  pid  | usename  | application_name |        state        | transaction_duration | query_duration |           query
-------+----------+------------------+---------------------+----------------------+----------------+---------------------------
 12345 | app_user | myapp            | idle in transaction | 02:15:32.456789      | 02:15:32.456789| BEGIN;
 12346 | app_user | myapp            | active              | 00:05:23.123456      | 00:00:02.345678| SELECT * FROM orders...
 12347 | etl_user | data_pipeline    | active              | 00:45:12.987654      | 00:45:12.987654| INSERT INTO events...
```

**What to look for:**
- `transaction_duration > 1 hour`: **Critical** - likely blocking VACUUM
- `state = 'idle in transaction'`: Transaction open but not doing anything - connection leak or forgotten BEGIN
- Long transactions from batch jobs/ETL: Should be broken into smaller transactions

### Monitor Dead Tuples and Bloat

Dead tuples accumulate when VACUUM can't clean them up (usually due to long transactions).

```sql
SELECT
    schemaname,
    relname,
    n_live_tup,
    n_dead_tup,
    ROUND(100.0 * n_dead_tup / NULLIF(n_live_tup + n_dead_tup, 0), 2) AS dead_tup_pct,
    last_vacuum,
    last_autovacuum
FROM pg_stat_user_tables
WHERE n_dead_tup > 0
ORDER BY n_dead_tup DESC
LIMIT 10;
```

**For detailed bloat analysis**, use community scripts:
- [pgx_scripts: table_bloat_check.sql](https://github.com/pgexperts/pgx_scripts/blob/master/bloat/table_bloat_check.sql) - More accurate bloat estimation
- [PostgreSQL Wiki: Show database bloat](https://wiki.postgresql.org/wiki/Show_database_bloat) - Multiple bloat queries for tables and indexes

**Example output:**
```
 schemaname | relname  | n_live_tup | n_dead_tup | dead_tup_pct |        last_vacuum        |      last_autovacuum
------------+----------+------------+------------+--------------+---------------------------+--------------------------
 public     | orders   |   5000000  |    450000  |         8.26 | 2026-01-20 10:00:00+00    | 2026-01-22 14:23:45+00
 public     | events   |  10000000  |    200000  |         1.96 |                           | 2026-01-22 15:00:12+00
 public     | users    |    500000  |    150000  |        23.08 | 2026-01-21 03:00:00+00    | 2026-01-22 15:30:00+00
```

**What to look for:**
- `dead_tup_pct > 10%`: Table needs vacuuming
- `dead_tup_pct > 20%`: **Concerning** - check for long transactions or autovacuum issues
- High `n_dead_tup` with recent `last_autovacuum`: Long transaction preventing cleanup
- No recent vacuum activity: Autovacuum may be disabled or overwhelmed

### Check Transaction ID Age (xid wraparound risk)

> [!CAUTION]
> Transaction ID wraparound is one of the most severe operational issues in PostgreSQL. Understanding it is essential.

#### What is xid wraparound?

PostgreSQL uses 32-bit transaction IDs (xids), which wrap around after ~4 billion transactions (2^31). Without proper vacuuming, old transaction IDs can appear "in the future" due to wraparound, causing **data visibility corruption**.

#### The solution: VACUUM FREEZE

**What is VACUUM FREEZE?**

VACUUM FREEZE is a special operation that replaces old transaction IDs (xids) with a special value called **FrozenXID** (typically `2`). This special xid is treated as "always in the past" - meaning it's visible to all transactions, regardless of the current xid counter.

**How it works:**

1. **Normal row**: `xmin=3,999,999,995` - visible only to transactions with xid > 3,999,999,995
2. **After VACUUM FREEZE**: `xmin=2 (FrozenXID)` - visible to ALL transactions, forever

**When does it happen?**

- **Autovacuum** automatically freezes tuples older than `vacuum_freeze_min_age` (default: 50 million transactions)
- **Aggressive autovacuum** runs when database age reaches `autovacuum_freeze_max_age` (default: 200 million transactions)
- **Manual VACUUM FREEZE** can be run explicitly: `VACUUM FREEZE table_name;`

> [!NOTE]
> VACUUM FREEZE also freezes old **MultiXact IDs**, not just transaction IDs. The same process applies with its own set of parameters (`vacuum_multixact_freeze_min_age`, `autovacuum_multixact_freeze_max_age`). See [Maintenance]({{< ref "10-maintenance#freeze" >}}) for details on the I/O impact of freeze operations.

**Why it prevents wraparound:**

By replacing old xids with FrozenXID, rows become immune to the wraparound problem. After wraparound, when current xid resets to 3, frozen rows (xmin=2) are still considered "in the past" and remain visible.

**Visual example of wraparound corruption:**

```
┌────────────────────────────────┬──────────────────────────────────────┐
│      TRANSACTION STATE         │      TABLE DATA (users table)        │
├────────────────────────────────┼──────────────────────────────────────┤
│ BEFORE WRAPAROUND              │                                      │
│                                │                                      │
│ Current xid: 4,000,000,000     │  ┌────────────────────────────────┐  │
│                                │  │ Row 1: 'Alice'   xmin=3,999,995│  │
│ New transaction starts:        │  │ Row 2: 'Bob'     xmin=3,999,996│  │
│ → Gets xid=4,000,000,001       │  │ Row 3: 'Charlie' xmin=3,999,997│  │
│                                │  │ Row 4: 'Diana'   xmin=3,999,998│  │
│ SELECT * FROM users;           │  │ Row 5: 'Eve'     xmin=3,999,999│  │
│                                │  └────────────────────────────────┘  │
│ Visibility check:              │                                      │
│ xmin < current_xid?            │  ✓ All 5 rows visible                │
│ 3,999,995 < 4,000,000,001      │                                      │
│ → YES, visible                 │  Query returns: 5 rows               │
│                                │                                      │
├────────────────────────────────┼──────────────────────────────────────┤
│ 🔴 AFTER WRAPAROUND            │                                      │
│    (WITHOUT VACUUM)            │                                      │
│                                │                                      │
│ xid counter wraps:             │  ┌────────────────────────────────┐  │
│ 4,294,967,295 → 3              │  │ Row 1: 'Alice'   xmin=3,999,995│  │
│                                │  │ Row 2: 'Bob'     xmin=3,999,996│  │
│ Current xid: 3                 │  │ Row 3: 'Charlie' xmin=3,999,997│  │
│                                │  │ Row 4: 'Diana'   xmin=3,999,998│  │
│ New transaction starts:        │  │ Row 5: 'Eve'     xmin=3,999,999│  │
│ → Gets xid=4                   │  └────────────────────────────────┘  │
│                                │                                      │
│ SELECT * FROM users;           │  ✗ ALL ROWS INVISIBLE!               │
│                                │                                      │
│ Visibility check:              │  PostgreSQL logic:                   │
│ xmin < current_xid?            │  "xmin=3,999,995 is HUGE number!"    │
│ 3,999,995 < 4                  │  "Must be in the FUTURE!"            │
│ → NO! (wraparound!)            │                                      │
│                                │  Query returns: 0 rows               │
│ Result: DATA VANISHES          │  (Data physically exists on disk,    │
│                                │   but invisible to all queries)      │
│                                │                                      │
├────────────────────────────────┼──────────────────────────────────────┤
│ ✅ WITH VACUUM FREEZE          │                                      │
│    (PROPER OPERATION)          │                                      │
│                                │                                      │
│ Before wraparound,             │  ┌────────────────────────────────┐  │
│ VACUUM FREEZE runs:            │  │ Row 1: 'Alice'   xmin=2 (FROZ) │  │
│                                │  │ Row 2: 'Bob'     xmin=2 (FROZ) │  │
│ → Replaces old xids with       │  │ Row 3: 'Charlie' xmin=2 (FROZ) │  │
│   FrozenXID (special value=2)  │  │ Row 4: 'Diana'   xmin=2 (FROZ) │  │
│                                │  │ Row 5: 'Eve'     xmin=2 (FROZ) │  │
│ After wraparound:              │  └────────────────────────────────┘  │
│ Current xid: 4                 │                                      │
│                                │  ✓ All rows still visible!           │
│ SELECT * FROM users;           │                                      │
│                                │  FrozenXID is special:               │
│ Visibility check:              │  "xmin=2 (FrozenXID) is ALWAYS       │
│ FrozenXID=2 is ALWAYS visible  │   visible to ANY transaction"        │
│                                │                                      │
│                                │  Query returns: 5 rows               │
│                                │  (Immune to wraparound)              │
└────────────────────────────────┴──────────────────────────────────────┘

Key insight: Without VACUUM FREEZE, old xids become "future" xids after
wraparound, making ALL old data invisible. This looks like complete data
loss to the application, even though data physically exists on disk.
```

#### What actually happens during wraparound emergency?

**Stage 1: Warnings (starts at ~1.4 billion xids old)**
```
WARNING: database "mydb" must be vacuumed within 10000000 transactions
HINT: To avoid a database shutdown, execute a database-wide VACUUM in that database.
```

**Stage 2: Shutdown Protection (at ~2 billion xids old)**
```
ERROR: database is not accepting commands to avoid wraparound data loss in database "mydb"
HINT: Stop the postmaster and vacuum that database in single-user mode.
```

**At this point:**
- **Database becomes COMPLETELY INACCESSIBLE** to all applications
- Only superuser in single-user mode can connect
- **Your application is DOWN** until VACUUM completes
- VACUUM must process the **entire database** - can take **hours to days** on large databases
- No way to speed it up - it must scan every table

#### The real danger: Data visibility corruption

If PostgreSQL didn't shut down, the wraparound would cause:

1. **Old rows become invisible**: Rows with old xids appear as "in the future", becoming invisible to queries
2. **Data appears to vanish**: SELECT queries return incomplete results
3. **Logical corruption**: Data physically exists but is invisible - looks like data loss to application
4. **No recovery**: Once visibility is corrupted, you need PITR restore or data is permanently invisible

**PostgreSQL shuts down preemptively to prevent this catastrophic scenario.**

#### Monitoring query

```sql
SELECT
    datname,
    age(datfrozenxid) AS xid_age,
    2147483648 - age(datfrozenxid) AS xids_until_wraparound,
    ROUND(100.0 * age(datfrozenxid) / 2147483648, 2) AS pct_toward_wraparound,
    CASE
        WHEN age(datfrozenxid) > 2000000000 THEN '🔴 EMERGENCY - DB WILL SHUT DOWN'
        WHEN age(datfrozenxid) > 1500000000 THEN '🟠 CRITICAL - Immediate action required'
        WHEN age(datfrozenxid) > 1000000000 THEN '🟡 WARNING - Schedule aggressive vacuum'
        ELSE '🟢 OK'
    END AS status
FROM pg_database
ORDER BY age(datfrozenxid) DESC;
```

**Example output:**
```
  datname  | xid_age    | xids_until_wraparound | pct_toward_wraparound | status
-----------+------------+-----------------------+-----------------------+----------------------------------
 myapp_db  | 1800000000 |             347483648 |                 83.82 | 🟠 CRITICAL - Immediate action
 postgres  |   10000000 |            2137483648 |                  0.47 | 🟢 OK
 template1 |    5000000 |            2142483648 |                  0.23 | 🟢 OK
```

**What to look for:**
- `pct_toward_wraparound > 90%`: **🔴 EMERGENCY** - Database shutdown imminent (hours away)
- `pct_toward_wraparound > 70%`: **🟠 CRITICAL** - Immediate action required (days away from shutdown)
- `pct_toward_wraparound > 50%`: **🟡 WARNING** - Schedule aggressive vacuum soon
- `pct_toward_wraparound < 10%`: **🟢 OK** - Autovacuum handling it normally

**Key thresholds:**
- Autovacuum aggressive mode: 200 million xids (`autovacuum_freeze_max_age`)
- Warning messages start: ~1.4 billion xids
- Emergency shutdown: 2 billion xids (`2^31`)

#### Prevention is critical

- **Monitor xid age regularly** - alert at 40-50%
- **Never disable autovacuum** - it's your protection against this
- **Don't ignore autovacuum warnings** in logs
- **Long-running transactions prevent vacuum** from advancing frozenxid
- Test your monitoring - this is a **preventable disaster**

### Check MultiXact ID Age (multixact wraparound risk)

> [!CAUTION]
> MultiXact ID wraparound follows the same 32-bit counter logic as xid wraparound. Workloads with foreign keys and shared locks can hit this limit much faster than expected.

MultiXact IDs require separate monitoring because they have their own freeze cycle, independent from transaction ID freezing.

```sql
SELECT
    datname,
    mxid_age(datminmxid) AS multixact_age,
    2147483648 - mxid_age(datminmxid) AS mxids_until_wraparound,
    ROUND(100.0 * mxid_age(datminmxid) / 2147483648, 2) AS pct_toward_wraparound,
    CASE
        WHEN mxid_age(datminmxid) > 2000000000 THEN 'EMERGENCY - DB WILL SHUT DOWN'
        WHEN mxid_age(datminmxid) > 1500000000 THEN 'CRITICAL - Immediate action required'
        WHEN mxid_age(datminmxid) > 1000000000 THEN 'WARNING - Schedule aggressive vacuum'
        ELSE 'OK'
    END AS status
FROM pg_database
ORDER BY mxid_age(datminmxid) DESC;
```

**Example output:**
```
  datname  | multixact_age | mxids_until_wraparound | pct_toward_wraparound | status
-----------+---------------+------------------------+-----------------------+--------
 myapp_db  |     180000000 |             1967483648 |                  8.38 | OK
 postgres  |       1000000 |             2146483648 |                  0.05 | OK
```

**What to look for:**
- Same thresholds as xid wraparound apply (alert at 40-50%)
- Compare `mxid_age(datminmxid)` against `age(datfrozenxid)` — if multixact age is growing faster, your workload generates shared locks heavily
- Tables with the highest multixact age may need manual `VACUUM FREEZE`

**Per-table monitoring:**

```sql
SELECT
    schemaname,
    relname,
    mxid_age(relminmxid) AS multixact_age,
    age(relfrozenxid) AS xid_age
FROM pg_class
WHERE relkind = 'r'
ORDER BY mxid_age(relminmxid) DESC
LIMIT 10;
```

**What to look for:**
- Tables where `multixact_age` is much higher than `xid_age` — these are your foreign key / shared lock hotspots
- If `multixact_age` is approaching `autovacuum_multixact_freeze_max_age` (default: 400 million), autovacuum will trigger aggressive freezing

**Key parameters:**
- `vacuum_multixact_freeze_min_age` (default: 5 million): minimum age before freezing multixact IDs
- `vacuum_multixact_freeze_table_age` (default: 150 million): triggers full-table scan for multixact freezing
- `autovacuum_multixact_freeze_max_age` (default: 400 million): forces aggressive autovacuum

### Monitor for Serialization Errors

If using REPEATABLE READ or SERIALIZABLE isolation levels:

```sql
SELECT
    datname,
    conflicts
FROM pg_stat_database_conflicts
WHERE conflicts > 0;
```

Check application logs for:
```
ERROR: could not serialize access due to concurrent update
ERROR: could not serialize access due to read/write dependencies
```

### Check Current Isolation Levels in Use

```sql
SELECT
    pid,
    usename,
    application_name,
    state,
    wait_event,
    query
FROM pg_stat_activity
WHERE state = 'active'
  AND pid != pg_backend_pid();
```

Note: Isolation level isn't directly visible in pg_stat_activity, but you can check your application's default:

```sql
SHOW default_transaction_isolation;
```

## Common problems

### Problem: Long-running "idle in transaction"

**Symptom**: Connection in `idle in transaction` state for hours, table bloat increasing

**Cause**:
- Application opens transaction with `BEGIN` but never commits/rolls back
- Connection pooler not properly closing transactions
- Application crash leaving transaction open

**Investigation**:
```sql
-- Find idle in transaction connections
SELECT
    pid,
    usename,
    application_name,
    now() - xact_start AS duration,
    state,
    query
FROM pg_stat_activity
WHERE state = 'idle in transaction'
ORDER BY xact_start;
```

**Solutions**:
1. **Immediate fix**: Terminate the connection
   ```sql
   SELECT pg_terminate_backend(12345);
   ```
2. Set `idle_in_transaction_session_timeout` to auto-kill idle transactions:
   ```sql
   ALTER DATABASE mydb SET idle_in_transaction_session_timeout = '10min';
   ```
3. Fix application code to ensure transactions are closed
4. Configure connection pooler (PgBouncer) in transaction mode

### Problem: Table bloat despite regular autovacuum

**Symptom**: Tables growing much larger than expected, queries slowing down

**Cause**: Long-running transaction preventing VACUUM from cleaning dead tuples

**Investigation**:
```sql
-- Check oldest running transaction
SELECT
    pid,
    usename,
    application_name,
    now() - xact_start AS age,
    state,
    query
FROM pg_stat_activity
WHERE xact_start IS NOT NULL
ORDER BY xact_start
LIMIT 1;
```

**Solutions**:
1. Identify and terminate long transactions (see above)
2. Break long ETL/batch jobs into smaller transactions
3. Use `VACUUM FULL` as last resort (requires exclusive lock, rewrites table)
4. Consider partitioning large tables to limit bloat impact

### Problem: Transaction ID wraparound approaching

**Symptom**: Warnings in PostgreSQL logs about xid wraparound, autovacuum running aggressively

**Log messages**:
```
WARNING: database "mydb" must be vacuumed within 10000000 transactions
ERROR: database is not accepting commands to avoid wraparound data loss in database "mydb"
```

**Cause**:
- Database hasn't been vacuumed in a very long time
- Long-running transactions preventing vacuum
- Autovacuum disabled or misconfigured

**Investigation**:
```sql
-- Check databases approaching wraparound
SELECT
    datname,
    age(datfrozenxid) AS xid_age,
    2147483648 - age(datfrozenxid) AS xids_remaining
FROM pg_database
ORDER BY age(datfrozenxid) DESC;
```

**Solutions**:
1. **Emergency**: Run manual VACUUM on affected databases immediately
   ```sql
   VACUUM FREEZE;  -- in each database
   ```
2. Terminate any long-running transactions
3. Ensure autovacuum is enabled and tuned appropriately
4. Monitor xid age regularly (alert at 40%)

### Problem: MultiXact exhaustion on FK-heavy workloads

**Symptom**: Autovacuum running aggressively on tables with foreign keys, warnings about multixact wraparound in logs, or standby crashes during WAL replay of multixact truncation records

**Cause**:
- Workloads with heavy foreign key usage generate MultiXact IDs on every child row insert (parent row gets `FOR KEY SHARE` lock)
- Concurrent transactions locking the same rows with `SELECT ... FOR SHARE`
- VACUUM not running frequently enough to freeze old MultiXact IDs

**Investigation**:
```sql
-- Check database-level multixact age
SELECT
    datname,
    mxid_age(datminmxid) AS multixact_age,
    age(datfrozenxid) AS xid_age
FROM pg_database
ORDER BY mxid_age(datminmxid) DESC;

-- Find tables driving multixact growth
SELECT
    schemaname,
    relname,
    mxid_age(relminmxid) AS multixact_age,
    age(relfrozenxid) AS xid_age,
    last_autovacuum
FROM pg_class
JOIN pg_stat_user_tables USING (relname)
WHERE relkind = 'r'
ORDER BY mxid_age(relminmxid) DESC
LIMIT 10;
```

**Solutions**:
1. **Immediate**: Run VACUUM FREEZE on tables with highest multixact age
   ```sql
   VACUUM FREEZE table_name;
   ```
2. Lower `autovacuum_multixact_freeze_max_age` for affected tables:
   ```sql
   ALTER TABLE parent_table SET (autovacuum_multixact_freeze_max_age = 200000000);
   ```
3. Review schema design — tables referenced by many foreign keys are multixact hotspots
4. Monitor `mxid_age(datminmxid)` alongside `age(datfrozenxid)` in your alerting

> [!WARNING]
> **Known bug in PostgreSQL 17.8**: A regression (commit `8ba61bc063`) causes standbys to crash during WAL replay of `MultiXact/TRUNCATE_ID` records when streaming from an older minor version (e.g., 17.5 primary → 17.8 standby). The crash manifests as:
> ```
> FATAL: could not access status of transaction NNNN
> DETAIL: Could not read from file "pg_multixact/offsets/XXXX" at offset YYYY: read too few bytes.
> ```
> The root cause was a backward-compatibility check that incorrectly reset `latest_page_number` during multixact truncation replay. A fix was committed by Heikki Linnakangas ([discussion](https://www.postgresql.org/message-id/CACV2tSw3VYS7d27ftO_cs%2BaF3M54%2BJwWBbqSGLcKoG9cvyb6EA%40mail.gmail.com)). When upgrading minor versions in a replication cluster, upgrade standbys and primary together to avoid this class of issue.

### Problem: Serialization errors in application

**Symptom**: Application receiving `could not serialize access` errors

**Cause**: Using REPEATABLE READ or SERIALIZABLE with concurrent writes

**Investigation**:
```sql
-- Check application's isolation level
SHOW default_transaction_isolation;

-- Look for conflicting transactions
SELECT * FROM pg_stat_activity WHERE state = 'active';
```

**Solutions**:
1. Implement retry logic in application (required for SERIALIZABLE)
2. Consider using READ COMMITTED if strong consistency isn't required
3. Redesign transactions to reduce conflicts (smaller, faster transactions)
4. Add explicit locking (`SELECT ... FOR UPDATE`) where appropriate

### Problem: VACUUM taking too long or blocking operations

**Symptom**: Manual VACUUM running for hours, blocking other operations

**Cause**:
- Table is extremely bloated
- Insufficient `maintenance_work_mem`
- Using `VACUUM FULL` (requires exclusive lock)

**Investigation**:
```sql
-- Check currently running vacuum
SELECT
    pid,
    now() - query_start AS duration,
    query
FROM pg_stat_activity
WHERE query LIKE '%VACUUM%';
```

**Solutions**:
1. Don't use `VACUUM FULL` in production - use regular `VACUUM` instead
2. Increase `maintenance_work_mem` for faster vacuum:
   ```sql
   SET maintenance_work_mem = '2GB';
   VACUUM table_name;
   ```
3. Use extensions for online table rewrites (no exclusive lock):
   - **[pg_squeeze](https://github.com/cybertec-postgresql/pg_squeeze)** - Newer extension with automatic scheduling capabilities
   - **[pg_repack](https://github.com/reorg/pg_repack)** - Well-established extension for manual table reorganization
4. Consider partitioning to make vacuum operations smaller and faster
5. Prevent bloat proactively by tuning autovacuum

## References

1. [PostgreSQL Documentation: MVCC Introduction](https://www.postgresql.org/docs/current/mvcc-intro.html)
2. [PostgreSQL Documentation: Transaction Isolation](https://www.postgresql.org/docs/current/transaction-iso.html)
3. [PostgreSQL Documentation: Routine Vacuuming](https://www.postgresql.org/docs/current/routine-vacuuming.html)
4. [PostgreSQL Documentation: Heap-Only Tuples (HOT)](https://www.postgresql.org/docs/current/storage-hot.html)
5. [The Internals of PostgreSQL: Concurrency Control](https://www.interdb.jp/pg/pgsql05.html)
6. [How to Reduce Your PostgreSQL Database Size](https://www.tigerdata.com/blog/how-to-reduce-your-postgresql-database-size)
7. [PostgreSQL Documentation: MultiXact](https://www.postgresql.org/docs/current/routine-vacuuming.html#VACUUM-FOR-MULTIXACT-WRAPAROUND)
8. [PostgreSQL 17.8 Standby Crash Bug (MultiXact TRUNCATE_ID replay)](https://www.postgresql.org/message-id/CACV2tSw3VYS7d27ftO_cs%2BaF3M54%2BJwWBbqSGLcKoG9cvyb6EA%40mail.gmail.com)
