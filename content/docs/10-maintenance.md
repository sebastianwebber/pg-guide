---
title: "Maintenance"
weight: 10
---

# Maintenance

## What is it?

PostgreSQL requires periodic maintenance tasks to keep the database healthy, performant, and safe from data corruption. These tasks are not optional — skipping them leads to table bloat, degraded query performance, increased disk usage, and in extreme cases, database shutdown to prevent data loss.

### VACUUM

**VACUUM** is PostgreSQL's process for reclaiming space occupied by dead tuples. Because MVCC never modifies rows in place — every UPDATE creates a new version, every DELETE only marks a row as dead — old row versions accumulate and must be cleaned up.

**How dead tuples accumulate and get reclaimed:**

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Step 1: INSERT                                                          │
│                                                                          │
│  INSERT INTO users (name) VALUES ('Alice');   (xid=100)                  │
│                                                                          │
│  Page:                                                                   │
│  ┌────────────────────────────────────────┐                              │
│  │ Alice  xmin=100  xmax=NULL  (live)     │                              │
│  │ [free space]                           │                              │
│  │ [free space]                           │                              │
│  └────────────────────────────────────────┘                              │
│                                                                          │
├──────────────────────────────────────────────────────────────────────────┤
│  Step 2: UPDATE                                                          │
│                                                                          │
│  UPDATE users SET name = 'Alice B.' WHERE name = 'Alice';   (xid=200)   │
│                                                                          │
│  PostgreSQL does NOT modify the original row.                            │
│  It creates a NEW version and marks the old one for deletion:            │
│                                                                          │
│  Page:                                                                   │
│  ┌────────────────────────────────────────┐                              │
│  │ Alice    xmin=100  xmax=200  (dead)    │ ◄── old version, marked      │
│  │ Alice B. xmin=200  xmax=NULL (live)    │ ◄── new version              │
│  │ [free space]                           │                              │
│  └────────────────────────────────────────┘                              │
│                                                                          │
├──────────────────────────────────────────────────────────────────────────┤
│  Step 3: More activity                                                   │
│                                                                          │
│  UPDATE users SET name = 'Alice C.' WHERE name = 'Alice B.';  (xid=300) │
│  INSERT INTO users (name) VALUES ('Bob');                      (xid=301) │
│                                                                          │
│  Page:                                                                   │
│  ┌────────────────────────────────────────┐                              │
│  │ Alice    xmin=100  xmax=200  (dead)    │                              │
│  │ Alice B. xmin=200  xmax=300  (dead)    │                              │
│  │ Alice C. xmin=300  xmax=NULL (live)    │                              │
│  │ Bob      xmin=301  xmax=NULL (live)    │                              │
│  └────────────────────────────────────────┘                              │
│                                                                          │
│  2 live tuples, 2 dead tuples — 50% wasted space                        │
│  Sequential scan reads ALL 4 tuples, discards 2                          │
│                                                                          │
├──────────────────────────────────────────────────────────────────────────┤
│  Step 4: VACUUM (regular — see modes below)                              │
│                                                                          │
│  VACUUM users;                                                           │
│                                                                          │
│  Page:                                                                   │
│  ┌────────────────────────────────────────┐                              │
│  │ [free space]                           │ ◄── was Alice (dead)         │
│  │ [free space]                           │ ◄── was Alice B. (dead)      │
│  │ Alice C. xmin=300  xmax=NULL (live)    │                              │
│  │ Bob      xmin=301  xmax=NULL (live)    │                              │
│  └────────────────────────────────────────┘                              │
│                                                                          │
│  Dead tuples removed, space available for reuse                          │
│  File size unchanged — space NOT returned to OS                          │
│                                                                          │
├──────────────────────────────────────────────────────────────────────────┤
│  Step 5: Reuse                                                           │
│                                                                          │
│  INSERT INTO users (name) VALUES ('Eve');   (xid=400)                    │
│                                                                          │
│  Page:                                                                   │
│  ┌────────────────────────────────────────┐                              │
│  │ Eve      xmin=400  xmax=NULL (live)    │ ◄── reused free space        │
│  │ [free space]                           │                              │
│  │ Alice C. xmin=300  xmax=NULL (live)    │                              │
│  │ Bob      xmin=301  xmax=NULL (live)    │                              │
│  └────────────────────────────────────────┘                              │
│                                                                          │
│  New row fills reclaimed space — table doesn't grow                      │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

#### VACUUM modes

##### Regular

Marks dead tuples as reusable space within existing pages. This is the standard operation — it runs **without blocking reads or writes**. Equivalent to running `VACUUM` with no additional options.

```sql
VACUUM table_name;
```

What it does:
1. Scans the table for dead tuples (using the visibility map to skip all-visible pages)
2. Removes dead tuple pointers from indexes
3. Marks dead tuple space as available for reuse in the Free Space Map (`$PGDATA/base/<db_oid>/<table_oid>_fsm`)
4. Updates the visibility map (`$PGDATA/base/<db_oid>/<table_oid>_vm`)
5. Advances the table's frozen xid horizon when possible (see [VACUUM FREEZE in MVCC and Transactions]({{< ref "03-mvcc-transactions#the-solution-vacuum-freeze" >}}))

What it does **not** do:
- Does not return space to the operating system (file size stays the same)
- Does not reorder rows or compact pages
- Does not require an exclusive lock

##### Freeze

A regular `VACUUM` that also **freezes old transaction IDs**. Rows with xids older than `vacuum_freeze_min_age` get their xids replaced with FrozenXID, making them immune to wraparound.

```sql
VACUUM FREEZE table_name;
```

> [!WARNING]
> `VACUUM FREEZE` rewrites tuple headers on every page that contains rows needing freezing. On large tables, this generates **heavy sustained I/O** — both reads (scanning all pages) and writes (rewriting headers + WAL). Schedule during low-traffic windows, or tune `vacuum_cost_delay` and `vacuum_cost_limit` to throttle I/O:
> ```sql
> -- Throttle manual VACUUM to reduce I/O impact
> SET vacuum_cost_delay = '20ms';
> SET vacuum_cost_limit = 200;
> VACUUM FREEZE table_name;
> ```
> Autovacuum uses its own throttle settings: `autovacuum_vacuum_cost_delay` (default: 2ms) and `autovacuum_vacuum_cost_limit` (default: -1, uses `vacuum_cost_limit`).

When it runs automatically:
- Autovacuum freezes tuples older than `vacuum_freeze_min_age` (default: 50 million transactions) during regular runs
- **Aggressive autovacuum** triggers when table age reaches `autovacuum_freeze_max_age` (default: 200 million) — this scans the entire table, ignoring the visibility map
- The same applies to MultiXact IDs with their own set of parameters (`vacuum_multixact_freeze_min_age`, `autovacuum_multixact_freeze_max_age`)

##### Full

Regular `VACUUM` marks space as reusable but never returns it to the operating system — the table file stays the same size. `VACUUM FULL` is the **only built-in way to actually shrink a table on disk**. It creates a new copy of the table containing only live tuples, then replaces the old file.

```sql
VACUUM FULL table_name;
```

> [!IMPORTANT]
> `VACUUM FULL` acquires an **ACCESS EXCLUSIVE lock** on the table — this blocks ALL operations including SELECT. On a 100GB table, this can take hours. Your application will be completely blocked for the entire duration.

> [!WARNING]
> `VACUUM FULL` is **not in-place**. It writes a complete new copy of the table before dropping the old one. A 100GB table needs at least 100GB of free disk space to run. If disk is already near full, VACUUM FULL will fail — and that's usually exactly when you want to run it. Plan ahead.

When to use it:
- Table has extreme bloat (e.g., 90% dead space) and regular `VACUUM` is not enough
- Disk space is critically low and you need to reclaim space to the OS
- During a planned maintenance window with application downtime

**Prefer alternatives to `VACUUM FULL` in production:**

- **[pg_repack](https://github.com/reorg/pg_repack)** — Rewrites the table online without exclusive lock (takes a brief lock only at the end to swap files). Well-established, widely used in production
- **[pg_squeeze](https://github.com/cybertec-postgresql/pg_squeeze)** — Similar to pg_repack but with automatic scheduling. Monitors bloat and triggers compaction based on configurable thresholds

> [!NOTE]
> Both pg_repack and pg_squeeze require the `contrib` package to be installed and the extension to be created in the database.

#### Autovacuum

Autovacuum is a background process that runs `VACUUM` (and `ANALYZE`) automatically. It monitors dead tuple counts and triggers `VACUUM` when a table exceeds a threshold.

**When it triggers:**

```
threshold = autovacuum_vacuum_threshold + (autovacuum_vacuum_scale_factor × number of live tuples)
```

With defaults (`threshold=50`, `scale_factor=0.2`): a table with 10,000 rows triggers autovacuum after 2,050 dead tuples (50 + 0.2 × 10,000).

**Key settings:**

| Parameter | Default | Description |
|-----------|---------|-------------|
| `autovacuum` | on | Master switch — never disable this |
| `autovacuum_vacuum_threshold` | 50 | Minimum dead tuples before triggering |
| `autovacuum_vacuum_scale_factor` | 0.2 | Fraction of table size to add to threshold |
| `autovacuum_vacuum_cost_delay` | 2ms | I/O throttle delay between cost units |
| `autovacuum_vacuum_cost_limit` | -1 | Cost limit per round (-1 uses `vacuum_cost_limit`) |
| `autovacuum_max_workers` | 3 | Maximum concurrent autovacuum workers |
| `autovacuum_freeze_max_age` | 200M | Forces aggressive vacuum to prevent xid wraparound |
| `autovacuum_multixact_freeze_max_age` | 400M | Same for MultiXact ID wraparound |

**Per-table tuning** for high-churn tables:

```sql
ALTER TABLE hot_table SET (
    autovacuum_vacuum_scale_factor = 0.05,
    autovacuum_vacuum_threshold = 1000
);
```

> [!TIP]
> Large tables with default `scale_factor=0.2` may accumulate millions of dead tuples before autovacuum triggers. Lower the scale factor or use a fixed threshold for tables with millions of rows.

## Why it matters

### VACUUM

- **Tables grow indefinitely** without `VACUUM` — dead tuples accumulate, wasting disk space
- **Queries slow down** — sequential scans read and discard dead tuples, wasting I/O and CPU
- **Indexes bloat** — index entries pointing to dead tuples cause useless heap lookups. HOT[^1] updates avoid this when the UPDATE doesn't change indexed columns and the new version fits in the same page, but when HOT doesn't apply, index bloat accumulates until `VACUUM` cleans it
- **Transaction ID wraparound** — without freezing old xids, the database eventually shuts down to prevent data corruption (see [MVCC and Transactions]({{< ref "03-mvcc-transactions" >}}))
- **`VACUUM FREEZE` generates heavy I/O** — both manual runs and aggressive autovacuum can saturate disk, impacting production queries
- **`VACUUM FULL` blocks everything** — using it in production without alternatives like pg_repack/pg_squeeze causes application downtime

## How to monitor

### VACUUM

#### Check running VACUUM operations

```sql
SELECT
    pid,
    datname,
    relid::regclass AS table_name,
    phase,
    heap_blks_total,
    heap_blks_scanned,
    heap_blks_vacuumed,
    ROUND(100.0 * heap_blks_vacuumed / NULLIF(heap_blks_total, 0), 2) AS pct_complete
FROM pg_stat_progress_vacuum;
```

#### Check when autovacuum last ran

```sql
SELECT
    schemaname,
    relname,
    n_dead_tup,
    n_live_tup,
    last_vacuum,
    last_autovacuum,
    autovacuum_count,
    vacuum_count
FROM pg_stat_user_tables
WHERE n_dead_tup > 0
ORDER BY n_dead_tup DESC
LIMIT 10;
```

#### Estimate table bloat

```sql
SELECT
    schemaname,
    relname,
    pg_size_pretty(pg_total_relation_size(schemaname || '.' || relname)) AS total_size,
    n_dead_tup,
    n_live_tup,
    ROUND(100.0 * n_dead_tup / NULLIF(n_live_tup + n_dead_tup, 0), 2) AS dead_pct
FROM pg_stat_user_tables
WHERE n_dead_tup > 1000
ORDER BY n_dead_tup DESC;
```

**What to look for:**
- `dead_pct > 20%`: Autovacuum may be falling behind — check if long-running transactions are blocking it
- `last_autovacuum` is NULL or very old: Autovacuum might not be reaching this table
- High `n_dead_tup` with recent `last_autovacuum`: Autovacuum runs but can't keep up — lower the scale factor

## Common problems

### Problem: Autovacuum not keeping up with dead tuple growth

**Symptom**: `n_dead_tup` keeps growing, `last_autovacuum` runs frequently but dead tuples remain high

**Cause**:
- Default thresholds too high for large tables
- `autovacuum_max_workers` too low for the number of active tables
- I/O throttle too aggressive (`autovacuum_vacuum_cost_delay` too high)

**Solutions**:
1. Lower per-table thresholds for high-churn tables:
   ```sql
   ALTER TABLE hot_table SET (autovacuum_vacuum_scale_factor = 0.01);
   ```
2. Increase `autovacuum_max_workers` if many tables need vacuuming concurrently
3. Lower `autovacuum_vacuum_cost_delay` to let autovacuum work faster (at the cost of more I/O)

### Problem: Long-running transactions blocking VACUUM

**Symptom**: `VACUUM` runs but can't remove dead tuples, `n_dead_tup` keeps growing

**Cause**: A single open transaction (even `idle in transaction`) prevents `VACUUM` from cleaning any dead tuples created after that transaction started — this affects the **entire database**, not just the tables that transaction touches

**Solutions**:
1. Find and terminate the blocking transaction:
   ```sql
   SELECT pid, now() - xact_start AS duration, state, query
   FROM pg_stat_activity
   WHERE xact_start IS NOT NULL
   ORDER BY xact_start LIMIT 5;
   ```
2. Set `idle_in_transaction_session_timeout` to auto-kill idle transactions:
   ```sql
   ALTER DATABASE mydb SET idle_in_transaction_session_timeout = '10min';
   ```

### Problem: `VACUUM FULL` needed but can't afford downtime

**Symptom**: Table has extreme bloat, regular `VACUUM` reclaims space but file size never shrinks

**Solutions**:
1. Use pg_repack for online table compaction:
   ```sql
   -- Install once
   CREATE EXTENSION pg_repack;
   ```
   ```bash
   # Run from command line
   pg_repack -d mydb -t bloated_table
   ```
2. Use pg_squeeze for automatic bloat management:
   ```sql
   CREATE EXTENSION pg_squeeze;
   SELECT squeeze.start_worker();
   ```

## References

1. [PostgreSQL Documentation: Routine Vacuuming](https://www.postgresql.org/docs/current/routine-vacuuming.html)
2. [PostgreSQL Documentation: VACUUM](https://www.postgresql.org/docs/current/sql-vacuum.html)
3. [PostgreSQL Documentation: Autovacuum](https://www.postgresql.org/docs/current/routine-vacuuming.html#AUTOVACUUM)
4. [pg_repack](https://github.com/reorg/pg_repack)
5. [pg_squeeze](https://github.com/cybertec-postgresql/pg_squeeze)
6. [PostgreSQL Documentation: Cost-Based Vacuum Delay](https://www.postgresql.org/docs/current/runtime-config-resource.html#RUNTIME-CONFIG-RESOURCE-VACUUM-COST)

[^1]: [Heap-Only Tuples (HOT)](https://www.postgresql.org/docs/current/storage-hot.html) — optimization that avoids creating new index entries when an UPDATE doesn't modify any indexed column and the new tuple fits in the same heap page.
