# Critical Monitoring

## What is it?

**Monitoring** is the continuous observation of PostgreSQL's health, performance, and resource usage. Effective monitoring helps detect problems before they impact users, understand performance trends, and troubleshoot issues quickly.

PostgreSQL provides built-in statistics views, logging capabilities, and metrics that expose the database's internal state.

### Core Concepts

#### Statistics Collector

PostgreSQL's **statistics collector** is a background process that gathers information about server activity:

- Query execution statistics (pg_stat_statements)
- Table and index access patterns (pg_stat_user_tables, pg_stat_user_indexes)
- Database-level statistics (pg_stat_database)
- Background process activity (pg_stat_bgwriter, pg_stat_wal)
- Replication status (pg_stat_replication)

**Key setting:**
```sql
-- Must be enabled (default: on)
SHOW track_activities;
SHOW track_counts;
```

#### pg_stat_statements Extension

**pg_stat_statements** is a PostgreSQL extension that tracks execution statistics for all SQL statements executed on the server.

> [!IMPORTANT]
> pg_stat_statements comes included with PostgreSQL but requires the **contrib package** to be installed:
> - **Debian/Ubuntu**: `apt install postgresql-contrib`
> - **RHEL/CentOS**: `dnf install postgresql-contrib` or `postgresql15-contrib`
> - **Docker official images**: Already included

**Critical for:**
- Identifying slow queries (see [pg_stat_statements: Query Performance](#pg_stat_statements-query-performance))
- Finding queries that consume most resources (CPU, I/O, memory)
- Analyzing query patterns and frequency
- Query optimization priorities

**Enable pg_stat_statements:**
```sql
-- Add to postgresql.conf
shared_preload_libraries = 'pg_stat_statements'
pg_stat_statements.track = all

-- After restart, create extension
CREATE EXTENSION pg_stat_statements;
```

#### Logging Configuration

PostgreSQL logging captures events, errors, slow queries, and connections for troubleshooting and auditing.

##### Why logs are your first line of defense

Logs are the most straightforward place to find problems in PostgreSQL. Unlike metrics that require interpretation or queries that need expertise, **logs explicitly tell you what's wrong**:

- **Connection failures**: `FATAL: password authentication failed for user "app_user"`
- **Deadlocks**: `ERROR: deadlock detected` with full query details
- **Lock waits**: `LOG: process 12345 still waiting for ShareLock on transaction 67890`
- **Out of memory**: `ERROR: out of memory` with allocation details
- **Checkpoint warnings**: `LOG: checkpoints are occurring too frequently`
- **Replication issues**: `FATAL: could not connect to the primary server`
- **Slow queries**: Automatic logging with `log_min_duration_statement`
- **Configuration errors**: `FATAL: unrecognized configuration parameter`

PostgreSQL is **extremely vocal** when something goes wrong. Before diving into complex metrics analysis or query debugging, **check the logs first** - the answer is usually there, clearly stated.

> [!TIP]
> When troubleshooting any PostgreSQL issue, always start by tailing the logs:
> ```bash
> tail -f /var/log/postgresql/postgresql-*.log
> ```
> Most problems announce themselves immediately in the logs.

**pgBadger-optimized logging configuration:**

[pgBadger](https://pgbadger.darold.net/) is a fast PostgreSQL log analyzer that generates detailed HTML reports with query statistics, performance graphs, and recommendations. The configuration below optimizes logging for pgBadger analysis:

```
# Logging configuration for pgBadger
logging_collector = on
log_checkpoints = on
log_connections = on
log_disconnections = on
log_lock_waits = on
log_temp_files = 0
lc_messages = 'C'

# Adjust the minimum time to collect the data
log_min_duration_statement = '10s'
log_autovacuum_min_duration = 0

# CSV format (recommended for pgBadger)
# Options: 'stderr', 'csvlog' (recommended), 'jsonlog' (PG 15+)
log_destination = 'csvlog'
log_directory = '/var/log/postgresql'
log_filename = 'postgresql-%Y-%m-%d_%H%M%S.log'

# Log rotation
log_rotation_age = 1d
log_rotation_size = 100MB
log_truncate_on_rotation = off
```

> [!NOTE]
> **About `log_min_duration_statement = '10s'`:**
> This value depends on your workload and tolerance for logging overhead:
> - **10s may be too high** for OLTP systems where a 2-3 second query is already problematic
> - **10s may be too low** for analytics workloads with expected long-running queries
>
> **Recommendations by workload:**
> - **OLTP/web apps**: `1s` - `3s` (catch slow transactions early)
> - **Analytics/reporting**: `30s` - `60s` (only log truly slow queries)
> - **Development**: `100ms` - `500ms` (aggressive, find all optimization opportunities)
>
> Start conservative (higher value) and lower it if you're missing slow queries. Too low = excessive log volume.

**Generate pgBadger report:**
```bash
# Analyze single log file
pgbadger /var/log/postgresql/postgresql-2025-01-15.log -o report.html

# Analyze multiple days
pgbadger /var/log/postgresql/postgresql-2025-01-*.log -o weekly-report.html

# Incremental mode (for continuous analysis)
pgbadger --incremental --outdir /var/www/pgbadger/ /var/log/postgresql/postgresql-*.log
```

**Further reading:** [PostgreSQL 17 log analysis made easy: Complete guide to setting up and using pgBadger](https://medium.com/@jramcloud1/postgresql-17-log-analysis-made-easy-complete-guide-to-setting-up-and-using-pgbadger-befb8e453433)

#### Host Metrics (OS-Level Monitoring)

PostgreSQL's internal statistics show *what the database is doing*, but many performance issues originate at the OS level. **PostgreSQL cannot report on system resources it doesn't directly manage** - CPU steal time, disk queue depth, network packet loss, and memory pressure from other processes are invisible to pg_stat_* views.

> [!IMPORTANT]
> Always monitor host metrics alongside PostgreSQL metrics. Problems like high VM steal time, disk I/O saturation, or network congestion will severely impact PostgreSQL performance but won't appear in database statistics.

See [Host Metrics Monitoring](#host-metrics-monitoring) section for detailed metrics and tools.

## Why it matters

### Proactive Problem Detection

**Identify issues before users complain:**
- Replication lag growing
- Disk space running low
- Connection pool exhaustion approaching
- Query performance degrading
- Autovacuum falling behind

### Performance Optimization

**Data-driven decisions:**
- Which queries to optimize first (biggest impact)
- Index effectiveness (used vs unused indexes)
- Cache hit ratios (shared_buffers tuning)
- VACUUM effectiveness (dead tuple monitoring)

### Capacity Planning

**Predict resource needs:**
- Database growth rate
- Connection usage trends
- I/O patterns and bottlenecks
- Memory utilization

### Troubleshooting

**Faster incident response:**
- Correlate errors with specific queries
- Identify blocking queries and lock contention
- Trace slow transactions
- Analyze connection patterns during incidents

## How to monitor

### Essential Views

#### pg_stat_activity: Current Activity

**This is your first stop when something is wrong.** When the database is slow, connections are hanging, or users are complaining, pg_stat_activity shows you exactly what's happening right now: which queries are running, which are blocked, who's connected, and what they're waiting for.

Shows currently executing queries and sessions in real-time.

```sql
SELECT
    pid,
    usename,
    application_name,
    client_addr,
    backend_start,
    state,
    wait_event_type,
    wait_event,
    query_start,
    state_change,
    LEFT(query, 60) AS query
FROM pg_stat_activity
WHERE state != 'idle'
  AND pid != pg_backend_pid()
ORDER BY query_start;
```

**Example output:**
```
  pid  | usename  | application_name | client_addr |      backend_start      | state  | wait_event_type | wait_event |      query_start        |      state_change       |                            query
-------+----------+------------------+-------------+-------------------------+--------+-----------------+------------+-------------------------+-------------------------+--------------------------------------------------------------
 12345 | app_user | myapp            | 10.0.1.5    | 2025-01-15 10:23:45+00  | active | IO              | DataFileRead| 2025-01-15 10:25:12+00 | 2025-01-15 10:25:12+00 | SELECT * FROM large_table WHERE created_at > '2024-01-01'
 12346 | app_user | myapp            | 10.0.1.6    | 2025-01-15 10:24:01+00  | active | Lock            | tuple      | 2025-01-15 10:25:15+00 | 2025-01-15 10:25:15+00 | UPDATE users SET status = 'active' WHERE id = 123
```

**What to look for:**
- `state = 'active'` with old `query_start`: Long-running queries
- `wait_event_type = 'Lock'`: Queries blocked by locks
- `wait_event_type = 'IO'`: Queries waiting on disk I/O
- `state = 'idle in transaction'` with old `state_change`: Forgotten transactions holding locks

**Interactive alternative: pg_activity**

[pg_activity](https://github.com/dalibo/pg_activity) is a top-like interactive tool that combines PostgreSQL activity (from pg_stat_activity) with system metrics in a single real-time view.

**Features:**
- **Real-time view** of running queries (refreshes automatically)
- **System metrics** (CPU, memory, I/O) alongside database activity
- **Query details**: Full query text, duration, wait events
- **Process management**: Kill queries directly from the interface
- **Blocking queries**: Highlight blocked and blocking sessions
- **Color-coded states**: Easy visual identification of query states

**Installation:**
```bash
# Debian/Ubuntu
apt install pg-activity

# RHEL/CentOS
dnf install pg_activity

# Python pip
pip install pg-activity
```

**Usage:**
```bash
# Connect to local database
pg_activity -U postgres

# Connect to remote database
pg_activity -h db-host -U postgres -d mydb

# Refresh every 2 seconds
pg_activity -U postgres --refresh 2
```

> [!IMPORTANT]
> **Run pg_activity on the database host** (not remotely) whenever possible. When running locally, pg_activity can read OS-level metrics from `/proc` (CPU, memory, disk I/O) and combine them with PostgreSQL activity, giving you a complete picture.
>
> **No root required**: pg_activity can read system metrics as a regular user (e.g., postgres user) since `/proc` files are readable by all users. Remote connections only show PostgreSQL metrics without system context.

**Why use pg_activity:**
- Much easier to read than raw SQL queries
- See system resource usage impact in real-time
- Quickly identify and kill problematic queries
- No need to remember complex pg_stat_activity queries
- Perfect for troubleshooting performance issues interactively

> [!TIP]
> Use pg_activity for interactive troubleshooting and pg_stat_activity queries for automation/scripting. pg_activity shows the same data but in a more human-friendly format with system context.

#### pg_stat_statements: Query Performance

```sql
-- Top 10 slowest queries by average execution time
SELECT
    LEFT(query, 80) AS short_query,
    calls,
    ROUND(total_exec_time::numeric, 2) AS total_time_ms,
    ROUND(mean_exec_time::numeric, 2) AS mean_time_ms,
    ROUND(max_exec_time::numeric, 2) AS max_time_ms,
    ROUND(stddev_exec_time::numeric, 2) AS stddev_time_ms,
    ROUND(100.0 * shared_blks_hit / NULLIF(shared_blks_hit + shared_blks_read, 0), 2) AS cache_hit_pct
FROM pg_stat_statements
ORDER BY mean_exec_time DESC
LIMIT 10;
```

**Example output:**
```
                short_query                 | calls | total_time_ms | mean_time_ms | max_time_ms | stddev_time_ms | cache_hit_pct
--------------------------------------------+-------+---------------+--------------+-------------+----------------+---------------
 SELECT * FROM events WHERE user_id = $1... |  1523 |      45623.45 |        29.95 |      456.78 |          45.23 |         85.34
 UPDATE orders SET status = $1 WHERE id = $2|  8934 |      38912.12 |         4.36 |       89.23 |          12.45 |         99.12
```

**What to look for:**
- High `mean_exec_time`: Slow queries needing optimization
- Low `cache_hit_pct` (<95%): Query needs more shared_buffers or better indexes
- High `calls` with moderate `mean_exec_time`: High-frequency queries worth optimizing
- High `stddev_exec_time`: Inconsistent performance (investigate)

#### pg_stat_database: Database-Level Statistics

```sql
SELECT
    datname,
    numbackends AS connections,
    xact_commit,
    xact_rollback,
    blks_read,
    blks_hit,
    ROUND(100.0 * blks_hit / NULLIF(blks_hit + blks_read, 0), 2) AS cache_hit_ratio,
    tup_returned,
    tup_fetched,
    tup_inserted,
    tup_updated,
    tup_deleted,
    conflicts,
    temp_files,
    pg_size_pretty(temp_bytes) AS temp_size,
    deadlocks
FROM pg_stat_database
WHERE datname NOT IN ('template0', 'template1')
ORDER BY datname;
```

**Example output:**
```
  datname   | connections | xact_commit | xact_rollback | blks_read | blks_hit  | cache_hit_ratio | tup_returned | tup_fetched | tup_inserted | tup_updated | tup_deleted | conflicts | temp_files | temp_size | deadlocks
------------+-------------+-------------+---------------+-----------+-----------+-----------------+--------------+-------------+--------------+-------------+-------------+-----------+------------+-----------+-----------
 production |          45 |     8234561 |          1234 |    456789 | 123456789 |           99.63 |   8765432100 |   123456789 |      1234567 |     2345678 |      123456 |         0 |         12 | 1024 MB   |         2
```

**What to look for:**
- `cache_hit_ratio < 99%`: Consider increasing shared_buffers
- High `temp_files` / `temp_bytes`: work_mem too small, queries spilling to disk
- `conflicts > 0`: Hot standby conflicts (on standby servers)
- `deadlocks > 0`: Application logic issues causing deadlocks

#### pg_stat_user_tables: Table Statistics

```sql
SELECT
    schemaname,
    relname,
    seq_scan,
    seq_tup_read,
    idx_scan,
    idx_tup_fetch,
    n_tup_ins,
    n_tup_upd,
    n_tup_del,
    n_live_tup,
    n_dead_tup,
    ROUND(100.0 * n_dead_tup / NULLIF(n_live_tup + n_dead_tup, 0), 2) AS dead_pct,
    last_vacuum,
    last_autovacuum,
    last_analyze,
    last_autoanalyze
FROM pg_stat_user_tables
ORDER BY n_dead_tup DESC
LIMIT 10;
```

**Example output:**
```
 schemaname | relname       | seq_scan | seq_tup_read | idx_scan | idx_tup_fetch | n_tup_ins | n_tup_upd | n_tup_del | n_live_tup | n_dead_tup | dead_pct | last_vacuum | last_autovacuum     | last_analyze | last_autoanalyze
------------+---------------+----------+--------------+----------+---------------+-----------+-----------+-----------+------------+------------+----------+-------------+---------------------+--------------+-----------------
 public     | events        |       12 |      1234567 |   345678 |       2345678 |    123456 |    234567 |     12345 |    8765432 |     234567 |     2.61 |             | 2025-01-15 08:23:45 |              | 2025-01-15 09:12:34
 public     | user_activity |      456 |     45678901 |    12345 |        123456 |     23456 |     34567 |      2345 |    1234567 |      45678 |     3.57 |             | 2025-01-15 07:45:12 |              | 2025-01-15 08:34:23
```

**What to look for:**
- High `seq_scan` on large tables: Missing indexes (queries doing full table scans)
- High `dead_pct` (>5-10%): VACUUM not keeping up, tune autovacuum
- `last_autovacuum` / `last_autoanalyze` NULL or old: Autovacuum disabled or not running
- High `n_tup_upd` with high `dead_pct`: Frequent updates causing bloat

#### pg_stat_user_indexes: Index Usage

```sql
SELECT
    schemaname,
    tablename,
    indexname,
    idx_scan,
    idx_tup_read,
    idx_tup_fetch,
    pg_size_pretty(pg_relation_size(indexrelid)) AS index_size
FROM pg_stat_user_indexes
ORDER BY idx_scan ASC, pg_relation_size(indexrelid) DESC
LIMIT 20;
```

**Example output:**
```
 schemaname | tablename | indexname                  | idx_scan | idx_tup_read | idx_tup_fetch | index_size
------------+-----------+----------------------------+----------+--------------+---------------+------------
 public     | events    | events_unused_column_idx   |        0 |            0 |             0 | 128 MB
 public     | users     | users_old_status_idx       |        2 |            5 |             5 | 64 MB
 public     | orders    | orders_created_at_idx      |   123456 |      1234567 |       1234567 | 256 MB
```

**What to look for:**
- `idx_scan = 0` with large `index_size`: Unused indexes wasting space and slowing writes
- Consider dropping unused indexes (but verify first with longer time period)

#### pg_stat_bgwriter: Background Writer Statistics

```sql
SELECT
    checkpoints_timed,
    checkpoints_req,
    checkpoint_write_time,
    checkpoint_sync_time,
    buffers_checkpoint,
    buffers_clean,
    buffers_backend,
    buffers_alloc
FROM pg_stat_bgwriter;
```

**Example output:**
```
 checkpoints_timed | checkpoints_req | checkpoint_write_time | checkpoint_sync_time | buffers_checkpoint | buffers_clean | buffers_backend | buffers_alloc
-------------------+-----------------+-----------------------+----------------------+--------------------+---------------+-----------------+---------------
              1234 |              45 |             12345678  |              234567  |           12345678 |        123456 |          234567 |      45678901
```

**What to look for:**
- `checkpoints_req > checkpoints_timed`: Increase `max_wal_size` or `checkpoint_timeout`
- High `checkpoint_write_time`: Checkpoint I/O taking too long (tune checkpoint_completion_target)
- High `buffers_backend`: Backend processes writing directly (increase shared_buffers or bgwriter efficiency)

### Statistics Management

PostgreSQL statistics accumulate over time since the last reset or server restart. Understanding when statistics were last reset helps interpret the data correctly.

#### Check When Statistics Were Last Reset

**Database-level statistics:**
```sql
SELECT
    datname,
    stats_reset,
    NOW() - stats_reset AS stats_age
FROM pg_stat_database
WHERE datname = current_database();
```

**Example output:**
```
  datname   |         stats_reset         |    stats_age
------------+-----------------------------+-----------------
 production | 2025-01-10 08:30:00.123456  | 5 days 14:23:12
```

**What this tells you:**
- All cumulative counters (like `xact_commit`, `blks_read`, `tup_inserted`) have been accumulating since `stats_reset`
- Rate calculations (queries per second, etc.) should consider this timeframe
- After restart or manual reset, counters start from zero

**Check pg_stat_statements reset time:**
```sql
-- PostgreSQL 14+
SELECT stats_reset FROM pg_stat_statements_info;

-- Or check when oldest query was first seen
SELECT min(stats_since) AS oldest_stat FROM pg_stat_statements;
```

#### Reset Statistics

> [!WARNING]
> Resetting statistics loses historical data. Do this intentionally, not accidentally. All cumulative counters return to zero.

**Reset all database statistics:**
```sql
-- Reset stats for current database
SELECT pg_stat_reset();

-- Reset stats for specific database (requires superuser)
SELECT pg_stat_reset_single_table_counters(oid)
FROM pg_database WHERE datname = 'mydb';
```

**Reset pg_stat_statements:**
```sql
-- Clear all query statistics
SELECT pg_stat_statements_reset();

-- PostgreSQL 14+: Reset specific query
SELECT pg_stat_statements_reset(userid, dbid, queryid);
```

**Reset shared statistics (cluster-wide):**
```sql
-- Reset bgwriter/checkpointer stats
SELECT pg_stat_reset_shared('bgwriter');

-- Reset WAL stats (PG 14+)
SELECT pg_stat_reset_shared('wal');

-- Reset archiver stats
SELECT pg_stat_reset_shared('archiver');
```

**Reset table/index statistics:**
```sql
-- Reset single table stats
SELECT pg_stat_reset_single_table_counters('public.users'::regclass);

-- Reset single index stats
SELECT pg_stat_reset_single_function_counters('public.calculate_total'::regproc);
```

**For more reset functions:**

PostgreSQL provides additional statistics reset functions for specific subsystems (I/O, replication slots, SLRU, etc.). See the [Statistics Functions documentation](https://www.postgresql.org/docs/current/monitoring-stats.html#MONITORING-STATS-FUNCTIONS) for the complete list of reset functions including:
- `pg_stat_reset_slru()` - Reset SLRU statistics
- `pg_stat_reset_replication_slot()` - Reset replication slot statistics
- And others introduced in recent PostgreSQL versions

#### When to Reset Statistics

**Good reasons to reset:**
1. **After major maintenance**: After pg_upgrade, major schema changes
2. **Performance testing**: Reset before test run to measure clean metrics
3. **After configuration changes**: Reset to measure impact of new settings
4. **Troubleshooting**: Reset to see fresh accumulation of specific metrics
5. **Long-running server**: Stats so old they're not representative anymore

**Bad reasons to reset:**
1. **"Just because"**: You lose historical trend data
2. **Regular scheduled resets**: Breaks long-term trend analysis
3. **To "clean up"**: Statistics don't consume significant resources

> [!TIP]
> Instead of resetting, consider:
> - Taking snapshots of statistics into a monitoring system (Prometheus, Datadog)
> - Recording `stats_reset` timestamp with your metrics for context
> - Using external monitoring that tracks deltas over time

**Example: Measure query performance after tuning**
```sql
-- 1. Note current stats_reset time
SELECT stats_reset FROM pg_stat_database WHERE datname = current_database();

-- 2. Reset pg_stat_statements
SELECT pg_stat_statements_reset();

-- 3. Run your workload / wait for production traffic

-- 4. Analyze fresh statistics
SELECT
    query,
    calls,
    mean_exec_time,
    total_exec_time
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 10;
```

### Connection Monitoring

#### Current Connection Count

**Client connections only (excludes system processes):**
```sql
SELECT
    datname,
    count(*) AS connections,
    count(*) FILTER (WHERE state = 'active') AS active,
    count(*) FILTER (WHERE state = 'idle') AS idle,
    count(*) FILTER (WHERE state = 'idle in transaction') AS idle_in_transaction
FROM pg_stat_activity
WHERE backend_type = 'client backend'  -- Only client connections, not system processes
GROUP BY datname
ORDER BY connections DESC;
```

**Example output:**
```
  datname   | connections | active | idle | idle_in_transaction
------------+-------------+--------+------+--------------------
 production |          85 |     12 |   70 |                   3
 staging    |          15 |      2 |   13 |                   0
```

**System processes vs client connections:**
```sql
SELECT
    backend_type,
    count(*) AS count
FROM pg_stat_activity
GROUP BY backend_type
ORDER BY count DESC;
```

**Example output:**
```
      backend_type            | count
------------------------------+-------
 client backend               |   100
 autovacuum worker            |     3
 logical replication launcher |     1
 walwriter                    |     1
 checkpointer                 |     1
 background writer            |     1
```

**What to look for:**
- `client backend`: Actual user/application connections
- `autovacuum worker`: Number of autovacuum processes running
- Other types are typically one per type (system processes)

#### Connection Pool Utilization

```sql
-- Check against max_connections
SELECT
    (SELECT count(*) FROM pg_stat_activity) AS current_connections,
    (SELECT setting::int FROM pg_settings WHERE name = 'max_connections') AS max_connections,
    ROUND(100.0 * (SELECT count(*) FROM pg_stat_activity) /
          (SELECT setting::int FROM pg_settings WHERE name = 'max_connections'), 2) AS utilization_pct;
```

**Example output:**
```
 current_connections | max_connections | utilization_pct
--------------------+-----------------+----------------
                 85 |             100 |          85.00
```

**What to look for:**
- Utilization > 80%: Risk of connection exhaustion
- Many `idle in transaction`: Application not closing transactions properly

### Lock Monitoring

#### Blocking Queries

```sql
SELECT
    blocked_locks.pid AS blocked_pid,
    blocked_activity.usename AS blocked_user,
    blocking_locks.pid AS blocking_pid,
    blocking_activity.usename AS blocking_user,
    blocked_activity.query AS blocked_statement,
    blocking_activity.query AS blocking_statement,
    blocked_activity.application_name AS blocked_app
FROM pg_catalog.pg_locks blocked_locks
JOIN pg_catalog.pg_stat_activity blocked_activity ON blocked_activity.pid = blocked_locks.pid
JOIN pg_catalog.pg_locks blocking_locks
    ON blocking_locks.locktype = blocked_locks.locktype
    AND blocking_locks.database IS NOT DISTINCT FROM blocked_locks.database
    AND blocking_locks.relation IS NOT DISTINCT FROM blocked_locks.relation
    AND blocking_locks.page IS NOT DISTINCT FROM blocked_locks.page
    AND blocking_locks.tuple IS NOT DISTINCT FROM blocked_locks.tuple
    AND blocking_locks.virtualxid IS NOT DISTINCT FROM blocked_locks.virtualxid
    AND blocking_locks.transactionid IS NOT DISTINCT FROM blocked_locks.transactionid
    AND blocking_locks.classid IS NOT DISTINCT FROM blocked_locks.classid
    AND blocking_locks.objid IS NOT DISTINCT FROM blocked_locks.objid
    AND blocking_locks.objsubid IS NOT DISTINCT FROM blocked_locks.objsubid
    AND blocking_locks.pid != blocked_locks.pid
JOIN pg_catalog.pg_stat_activity blocking_activity ON blocking_activity.pid = blocking_locks.pid
WHERE NOT blocked_locks.granted;
```

**What to look for:**
- Long-running blocking queries: Investigate why blocking query is slow
- `idle in transaction` blocking active queries: Application not closing transactions

**Additional lock monitoring resources:**
- [pgx_scripts Lock Queries](https://github.com/pgexperts/pgx_scripts/tree/master/locks) - Collection of lock monitoring queries
- [PostgreSQL Wiki: Lock Monitoring](https://wiki.postgresql.org/wiki/Lock_Monitoring) - Comprehensive guide to understanding and monitoring locks

### Replication Monitoring

See [Chapter 5: Replication - How to monitor](05-replication.md#how-to-monitor) for detailed replication monitoring queries.

### Host Metrics Monitoring

PostgreSQL performance depends heavily on underlying system resources. Monitor these OS-level metrics to detect bottlenecks that won't appear in PostgreSQL statistics.

#### CPU Metrics

**What to monitor:**
- **CPU usage per core**: PostgreSQL spreads across cores (multi-process, not multi-threaded)
- **Context switches**: High switching indicates system thrashing
- **Steal time** (VMs/containers): CPU stolen by hypervisor for other VMs/containers
- **Load average**: Queue depth of runnable processes (rule of thumb: load > number of cores = overloaded)

**Command-line tools:**
```bash
# Overall CPU usage and per-process breakdown
top
htop

# Per-CPU core statistics
mpstat -P ALL 1

# Context switches
vmstat 1

# Load average
uptime
```

**What to look for:**
- **High steal time (>10%)**: VM neighbor consuming hypervisor resources
- **High load average**: More processes waiting than CPUs available
- **Context switches >100k/sec**: System thrashing, too many processes competing

#### Memory Metrics

**What to monitor:**
- **Available memory**: Not just "free" - Linux uses memory for cache (this is good)
- **Swap usage**: Any swap usage = performance degradation
- **Dirty pages**: Pending writes to disk (OS buffer cache)
- **OOM killer activity**: Check for killed PostgreSQL processes

**Command-line tools:**
```bash
# Memory overview
free -h

# Detailed memory statistics
vmstat 1

# Per-process memory usage
top, htop

# Check for OOM kills
dmesg -T | grep -i "killed process"
journalctl -k | grep -i "out of memory"
```

**What to look for:**
- **Swap usage > 0**: Memory pressure, performance degradation imminent
- **Available memory < 10%**: Risk of OOM kills
- **OOM killer active**: PostgreSQL processes being killed

#### Disk I/O Metrics

**What to monitor:**
- **IOPS** (reads/writes per second): Operations hitting limits
- **Throughput** (MB/s): Bandwidth saturation
- **Latency** (await time): Time waiting for I/O completion
- **Queue depth**: Pending I/O operations
- **Disk utilization %**: 100% = saturated (adding load increases latency)

**Command-line tools:**
```bash
# Detailed I/O statistics per device
iostat -x 1

# Per-process I/O usage
iotop

# I/O wait time
vmstat 1  # Check 'wa' column
```

**Example iostat output:**
```bash
$ iostat -x 1
Device  r/s   w/s  rkB/s  wkB/s  await  %util
sda    123.4  45.6  4567   2345   12.3   85.2
```

**What to look for:**
- **%util = 100%**: Disk saturated, adding load increases latency
- **await > 10ms**: High I/O latency (depends on storage type: SSD vs HDD)
- **High r/s or w/s**: Approaching IOPS limits

#### Disk Space Metrics

**What to monitor:**
- **Free space** on PGDATA filesystem
- **Free space** on WAL filesystem (if separate)
- **Inode usage**: Can run out even with free space
- **Filesystem mount status**: Detect read-only remounts

**Command-line tools:**
```bash
# Disk space usage
df -h

# Inode usage
df -i

# Check specific directories
du -sh /var/lib/postgresql/data
du -sh /var/lib/postgresql/data/pg_wal
```

**What to look for:**
- **Usage > 90%**: Critical - VACUUM may fail, writes may fail
- **Inode usage > 90%**: Can't create new files even with free space
- **Filesystem read-only**: Check `mount` output or dmesg for errors

#### Network Metrics

**What to monitor:**
- **Throughput** (sent/received MB/s): Bandwidth usage
- **Packet loss**: Dropped packets indicate network issues
- **Connection errors**: Failed TCP connections
- **Replication network lag** (primary to standby bandwidth)

**Command-line tools:**
```bash
# Network interface statistics
ifconfig, ip -s link

# Real-time bandwidth usage
iftop
nethogs

# Connection statistics
ss -s
netstat -s | grep -i error
```

**What to look for:**
- **Packet loss > 0%**: Network congestion or hardware issues
- **High retransmits**: Network instability
- **Bandwidth saturation**: Approaching NIC limits

#### Monitoring Systems Integration

**Prometheus + Node Exporter:**
```bash
# Install node_exporter on PostgreSQL host
wget https://github.com/prometheus/node_exporter/releases/download/v1.7.0/node_exporter-1.7.0.linux-amd64.tar.gz
tar xvfz node_exporter-1.7.0.linux-amd64.tar.gz
cd node_exporter-1.7.0.linux-amd64
./node_exporter

# Configure Prometheus to scrape node_exporter
# Add to prometheus.yml:
# - job_name: 'node'
#   static_configs:
#     - targets: ['localhost:9100']
```

**Telegraf (InfluxDB):**
```bash
# Install telegraf
apt install telegraf  # Debian/Ubuntu
yum install telegraf  # RHEL/CentOS

# Configure inputs in /etc/telegraf/telegraf.conf
[[inputs.cpu]]
[[inputs.mem]]
[[inputs.disk]]
[[inputs.diskio]]
[[inputs.net]]
```

**Cloud provider monitoring:**
- **AWS CloudWatch**: CPU, Disk I/O, Network metrics for EC2/RDS
- **GCP Cloud Monitoring**: VM and disk metrics
- **Azure Monitor**: VM insights and metrics

## Common problems

### Problem: pg_stat_statements not showing queries

**Symptom**: `SELECT * FROM pg_stat_statements` returns empty or very few rows

**Diagnosis:**
```sql
-- Check if extension is installed
SELECT * FROM pg_extension WHERE extname = 'pg_stat_statements';

-- Check if library is loaded
SHOW shared_preload_libraries;

-- Check tracking settings
SHOW pg_stat_statements.track;
```

**Causes:**
- Extension not created: `CREATE EXTENSION pg_stat_statements;`
- Library not in `shared_preload_libraries` (requires restart)
- `pg_stat_statements.track` set to wrong value

**Solutions:**
1. **Add to postgresql.conf** and restart:
   ```
   shared_preload_libraries = 'pg_stat_statements'
   pg_stat_statements.track = all
   ```

2. **Create extension** (after restart):
   ```sql
   CREATE EXTENSION pg_stat_statements;
   ```

3. **Verify**:
   ```sql
   SELECT count(*) FROM pg_stat_statements;
   ```

### Problem: High idle in transaction connections

**Symptom**: Many connections in `idle in transaction` state for extended periods

> [!IMPORTANT]
> **Transactions should be as fast as possible.** Long-running transactions (even idle ones) have serious impacts:
> - Block VACUUM from cleaning dead tuples (causes bloat)
> - Hold locks on tables/rows (blocks other transactions)
> - Prevent transaction ID wraparound protection
> - Consume connection slots
>
> Best practice: BEGIN → execute queries → COMMIT/ROLLBACK immediately. Avoid application logic between BEGIN and COMMIT.

**Diagnosis:**
```sql
SELECT
    pid,
    usename,
    application_name,
    state,
    state_change,
    NOW() - state_change AS idle_duration,
    query
FROM pg_stat_activity
WHERE state = 'idle in transaction'
ORDER BY state_change;
```

**Causes:**
- Application not committing or rolling back transactions
- Connection pool holding transactions open
- Application crash/timeout without proper cleanup

**Why this matters for performance:**

When queries are blocked waiting for locks held by idle transactions, **waiting consumes CPU time** - the system continuously checks if the resource has become available. This wastes CPU cycles that could be used for productive work.

**Solutions:**
1. **Set statement timeout** to auto-close long transactions:
   ```sql
   ALTER DATABASE mydb SET idle_in_transaction_session_timeout = '5min';
   ```

2. **Cancel problematic queries** (less aggressive):
   ```sql
   -- Cancel the current query but keep the connection alive
   SELECT pg_cancel_backend(pid)
   FROM pg_stat_activity
   WHERE state = 'idle in transaction'
     AND NOW() - state_change > interval '10 minutes';
   ```
   - Use this first - it's safer
   - Cancels the query, returns error to client
   - Connection remains open, application can retry

3. **Terminate stuck connections** (more extreme):
   ```sql
   -- Force disconnect the client connection
   SELECT pg_terminate_backend(pid)
   FROM pg_stat_activity
   WHERE state = 'idle in transaction'
     AND NOW() - state_change > interval '10 minutes';
   ```
   - Use when pg_cancel_backend doesn't work
   - Terminates the entire connection
   - Client loses connection, must reconnect
   - **More disruptive** but guarantees the lock is released

**When to use each:**
- **pg_cancel_backend**: First attempt - less disruptive, connection survives
- **pg_terminate_backend**: Last resort - when query won't cancel or connection is truly stuck

4. **Fix application**: Ensure proper transaction handling (BEGIN/COMMIT/ROLLBACK)

### Problem: Logs growing too large

**Symptom**: Log directory filling disk, log files growing rapidly

**Diagnosis:**
```bash
# Check log size
du -sh /var/log/postgresql/

# Check largest log files
ls -lhS /var/log/postgresql/ | head -10
```

**Causes:**
- `log_statement = 'all'` logging every query
- `log_min_duration_statement = 0` logging all queries with duration
- Very high query volume
- No log rotation configured

**Solutions:**
1. **Configure log rotation**:
   ```
   log_rotation_age = 1d
   log_rotation_size = 100MB
   log_truncate_on_rotation = on  # Overwrite old logs
   ```

2. **Reduce logging verbosity**:
   ```
   log_statement = 'none'  # Or 'ddl' to log only DDL
   log_min_duration_statement = 1000  # Only log queries > 1s
   ```

3. **External log rotation** (logrotate):
   > [!NOTE]
   > External log rotation is an option but not always available in all environments (e.g., containers with ephemeral filesystems, cloud-managed databases, Kubernetes pods). Prefer PostgreSQL's built-in log rotation (#1 above) for portability.

   ```
   # /etc/logrotate.d/postgresql
   /var/log/postgresql/*.log {
       daily
       rotate 7
       compress
       delaycompress
       missingok
       notifempty
   }
   ```

### Problem: Can't identify slow query source

**Symptom**: pg_stat_statements shows slow query but can't trace to application

**Diagnosis:**
```sql
-- Enable application_name tracking in connection string
-- Example: psql "postgresql://user:pass@host/db?application_name=myapp"

-- Check current application names
SELECT DISTINCT application_name FROM pg_stat_activity;

-- Find queries by application
SELECT
    application_name,
    LEFT(query, 100) AS query,
    calls,
    mean_exec_time
FROM pg_stat_statements pss
JOIN pg_stat_activity psa ON psa.pid = pss.queryid % 100000  -- Approximate join
WHERE application_name IS NOT NULL
ORDER BY mean_exec_time DESC;
```

**Solutions:**
1. **Set application_name** in connection string:
   ```python
   # Python psycopg2 example
   conn = psycopg2.connect(
       "postgresql://user:pass@host/db?application_name=api-server"
   )
   ```

2. **Enable query logging** with application context:
   ```
   log_line_prefix = '%m [%p] %u@%d %a '
   ```
   This logs: timestamp, PID, user, database, application_name

3. **Use connection pooler labels** (PgBouncer, pgcat):
   Configure application_name per pool

### Problem: Queries slow but PostgreSQL metrics look normal

**Symptom**: Queries suddenly slow, but pg_stat_statements shows normal execution plans, cache hit ratio is good, no blocking locks

**Diagnosis:**
```bash
# Check CPU steal time (VMs)
top  # Look for '%st' (steal time)

# Check disk I/O saturation
iostat -x 1  # Look for %util = 100%, high await

# Check memory pressure
free -h  # Look for swap usage
vmstat 1  # Look for 'si' and 'so' (swap in/out)
```

**Common causes:**
- **High VM steal time**: Hypervisor allocating CPU to other VMs
- **Disk I/O saturation**: Disk at 100% utilization, high latency
- **Memory swap**: System swapping due to memory pressure
- **Network congestion**: High packet loss or retransmits

**Solutions:**
1. **High steal time**: Migrate to different VM host or upgrade instance type
2. **Disk saturation**: Upgrade storage (more IOPS), move hot data to faster storage
3. **Swap usage**: Increase system memory, reduce PostgreSQL memory settings
4. **Network issues**: Investigate network infrastructure, check MTU settings

### Problem: Autovacuum falling behind but settings look correct

**Symptom**: Dead tuples accumulating, autovacuum not keeping up, but autovacuum settings are reasonable

**Diagnosis:**
```bash
# Check disk I/O - autovacuum is I/O intensive
iostat -x 1

# Check if other processes competing for I/O
iotop
```

**Causes:**
- **Disk I/O saturation**: Autovacuum can't get enough I/O bandwidth
- **Other processes**: Backups, application writes saturating disk
- **Slow storage**: Insufficient IOPS for workload + autovacuum

**Solutions:**
1. **Increase autovacuum_vacuum_cost_limit**: Give autovacuum more I/O budget
   ```sql
   ALTER SYSTEM SET autovacuum_vacuum_cost_limit = 2000;  -- Default: 200
   ```
2. **Upgrade storage**: More IOPS to handle workload + autovacuum
3. **Schedule manual VACUUM**: During off-peak hours
4. **Separate WAL to faster storage**: Reduce I/O contention

### Problem: Connection failures but PostgreSQL is responsive

**Symptom**: Applications reporting connection timeouts or failures, but PostgreSQL responds to local connections

**Diagnosis:**
```bash
# Check network packet loss
netstat -s | grep -i error
ss -s

# Test connectivity from application host
psql -h db-host -U user -d database

# Check firewall/network
telnet db-host 5432
```

**Causes:**
- **Network congestion**: High packet loss between app and database
- **Firewall rules**: Dropping connections
- **max_connections reached**: But application can't connect to check
- **DNS issues**: Hostname resolution failing

**Solutions:**
1. **Network issues**: Work with network team to diagnose packet loss
2. **Firewall**: Verify security group/firewall rules
3. **Connection pooling**: Reduce connection churn
4. **Health check queries**: Monitor connectivity from application side

### Problem: Out of memory kills (OOM) despite PostgreSQL limits

**Symptom**: PostgreSQL processes killed by OOM killer, but shared_buffers and work_mem seem reasonable

**Diagnosis:**
```bash
# Check for OOM kills
dmesg -T | grep -i "killed process"
journalctl -k | grep -i "out of memory"

# Check total system memory usage
free -h
ps aux --sort=-%mem | head -20

# Check other processes competing for memory
top
```

**Causes:**
- **Other processes**: Non-PostgreSQL processes consuming memory
- **work_mem multiplication**: Many concurrent queries each using work_mem
- **Memory leaks**: In extensions or application
- **Insufficient system memory**: Under-provisioned for workload

**Solutions:**
1. **Identify memory hogs**: Kill or limit other processes
2. **Reduce work_mem**: Lower per-query memory limit
3. **Add memory**: Upgrade instance/server
4. **Connection pooling**: Limit concurrent connections (reduces total work_mem usage)
5. **Set memory limits**: Use cgroups/systemd limits to prevent OOM

## References

1. [PostgreSQL Documentation: Monitoring Database Activity](https://www.postgresql.org/docs/current/monitoring-stats.html)
2. [PostgreSQL Documentation: The Statistics Collector](https://www.postgresql.org/docs/current/monitoring-stats.html#MONITORING-STATS-SETUP)
3. [PostgreSQL Documentation: pg_stat_statements](https://www.postgresql.org/docs/current/pgstatstatements.html)
4. [PostgreSQL Documentation: Error Reporting and Logging](https://www.postgresql.org/docs/current/runtime-config-logging.html)
5. [PostgreSQL Documentation: Lock Monitoring](https://www.postgresql.org/docs/current/explicit-locking.html)
6. [State of PostgreSQL 2022—13 Tools That Aren't psql](https://www.tigerdata.com/blog/state-of-postgresql-2022-13-tools-that-arent-psql)
