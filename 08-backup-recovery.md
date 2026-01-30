# Backup and Recovery

## What is it?

PostgreSQL backup and recovery is the practice of creating copies of your database and being able to restore them when needed. The fundamental principle: **backups are useless until you've successfully tested recovery**.

### Core Concepts

> [!IMPORTANT]
> PostgreSQL backups (pg_dump and pg_basebackup) reflect the database state at **backup completion**, not start. The database continues accepting writes during backup. Example: backup runs 10:00 AM → 2:00 PM → restored data will be as of 2:00 PM.

#### Backup Types

##### Logical Backups (pg_dump)
- Export database as SQL statements or custom format
- Platform-independent (works across PostgreSQL versions, architectures)
- Slower for large databases (must replay all SQL)
- Good for: migrations, selective restore, smaller databases

**pg_dump formats:**

| Format | Flag | Characteristics | Best for |
|--------|------|----------------|----------|
| **Plain** | `-Fp` | SQL text, human-readable | Version control, manual editing |
| **Custom** | `-Fc` | Compressed binary, selective restore | General purpose, single-threaded |
| **Directory** | `-Fd` | Multiple files, parallel dump/restore | Large databases, faster backups |
| **Tar** | `-Ft` | Tar archive, no compression | Archiving, but use custom instead |

> [!TIP]
> Use directory format (-Fd) with -j flag for parallel backup on large databases. Example: `pg_dump -Fd -j 4` uses 4 parallel workers, significantly faster than single-threaded custom format.

##### Physical Backups (pg_basebackup)
- Copy of raw data files (PGDATA directory)
- Faster for large databases (file-level copy)
- Same PostgreSQL major version required (e.g., 15.x → 15.y)
- Same platform required (Linux → Linux, not Linux → Windows)
- Architecture: x86_64 ↔ ARM64 works (both little-endian, 64-bit)
- Includes all databases in the cluster
- Good for: large databases, PITR, production systems

> [!NOTE]
> Physical backups can be restored between compatible architectures on the same platform. Linux x86_64 → Linux ARM64 works because both are little-endian[^1] 64-bit. Cross-platform (Linux → Windows) or cross-endianness (x86 → SPARC) does not work.

**pg_basebackup is not required:**

pg_basebackup is a convenient wrapper, but you can create physical backups manually:

```sql
-- Method 1: Using pg_basebackup
pg_basebackup -D /backup -Ft -z -P -X stream

-- Method 2: Manual backup (more control)
-- Step 1: Mark backup start
SELECT pg_backup_start('manual_backup_label');

-- Step 2: Copy PGDATA with any tool (in a separate shell)
rsync -av --exclude='pg_wal' /var/lib/postgresql/data/ /backup/
-- OR: tar czf /backup/base.tar.gz -C /var/lib/postgresql/data .
-- OR: filesystem snapshot (LVM, ZFS, etc)

-- Step 3: Mark backup complete and get WAL info
SELECT * FROM pg_backup_stop();
```

**WAL handling during backup:**

| Method | WAL during backup | Requires archive_mode? |
|--------|-------------------|------------------------|
| `pg_basebackup -X stream` | Streamed and included in backup | No (for backup itself) |
| `pg_basebackup -X fetch` | Fetched at end, included in backup | No (for backup itself) |
| Manual (pg_backup_start/stop) | Must archive WAL separately | **Yes (required)** |

> [!IMPORTANT]
> All methods require WAL archiving (`archive_mode = on`) for **PITR** - to restore to a point in time AFTER the backup. The backup itself contains WAL only during the backup period. For recovery to any later point, you need archived WAL files.

**When to use manual method:**
- Filesystem snapshots (LVM, ZFS, Btrfs)
- Cloud provider snapshots (EBS, persistent disk)
- Enterprise backup software integration
- Custom backup orchestration

#### Point-in-Time Recovery (PITR)

**What is PITR?**

PITR allows restoring a database to any specific moment in time, not just the backup time. This requires:

1. **Base backup** (physical backup via pg_basebackup)
2. **WAL archive** (continuous archiving of WAL files)
3. **Recovery target** (timestamp, transaction ID, or named restore point)

**How it works:**

```
┌─────────────────────────────────────────────────────────────────────┐
│                          TIMELINE                                   │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  10:00 AM          12:00 PM          2:00 PM          2:30 PM       │
│     │                 │                 │                │          │
│     ▼                 │                 ▼                ▼          │
│  [Backup]             │           [Want this!]    [Corruption]      │
│   taken               │                                             │
│     │                 │                 ▲                           │
│     │                 │                 │                           │
│     │  ┌──────────────┴─────────────────┘                           │
│     │  │  Continuous WAL archiving                                  │
│     │  │                                                            │
│     ▼  ▼                                                            │
│  ┌─────────┐      ┌─────────────────────────────┐                   │
│  │ Base    │      │ Archived WAL files          │                   │
│  │ Backup  │      │ 10:00 → 10:15 → 10:30 → ... │                   │
│  │         │      │ ... → 1:45 → 2:00 → 2:15    │                   │
│  │ State:  │      └─────────────────────────────┘                   │
│  │ 10:00AM │                                                        │
│  └─────────┘                                                        │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘

RECOVERY PROCESS:

Step 1: Restore base backup
┌─────────────────────────┐
│ Database state: 10:00AM │
└─────────────────────────┘

Step 2: Replay WAL files (10:00 AM → 2:00 PM)
┌─────────────────────────┐
│ Apply: 10:15 WAL        │
│ Apply: 10:30 WAL        │
│ Apply: 10:45 WAL        │
│ ...                     │
│ Apply: 1:45 WAL         │
│ Apply: 2:00 WAL ← STOP  │
└─────────────────────────┘

Step 3: Result
┌──────────────────────────────────────┐
│ ✓ Database state: exactly 2:00 PM   │
│ ✓ All data up to corruption point   │
│ ✓ Zero data loss (10 AM → 2 PM)     │
└──────────────────────────────────────┘

WITHOUT PITR (backup only):
┌──────────────────────────────────────┐
│ ✗ Can only restore to 10:00 AM      │
│ ✗ Lose 4 hours of data (10AM → 2PM) │
└──────────────────────────────────────┘
```

**Recovery targets:**

```sql
-- Recover to specific timestamp
recovery_target_time = '2026-01-27 14:00:00'

-- Recover to specific transaction
recovery_target_xid = '12345678'

-- Recover to named restore point
recovery_target_name = 'before_migration'

-- Recover to end of available WAL (default)
recovery_target = 'immediate'
```

#### WAL Archiving

**archive_command** copies WAL files to safe storage before they're recycled:

```ini
# postgresql.conf
wal_level = replica                    # Minimum for archiving (see below)
archive_mode = on                      # Enable archiving
archive_command = 'cp %p /mnt/archive/%f'  # Copy to archive location
```

**wal_level values:**

| Level | WAL Information | Use case | Can archive? |
|-------|----------------|----------|--------------|
| `minimal` | Crash recovery only | Single instance, no backups | No |
| `replica` | + streaming replication, archiving | **Production default** | Yes |
| `logical` | + logical replication decoding | Logical replication needed | Yes |

> [!TIP]
> Use `wal_level = replica` for production systems. It enables archiving, PITR, and streaming replication with minimal overhead. Only use `logical` if you need logical replication (e.g., cross-version replication, selective table replication).

**Archive command variables:**
- `%p` = Full path of file to archive
- `%f` = File name only

**Archive destinations:**
- Local mount (NFS, SMB)
- Object storage (S3, GCS, Azure Blob)
- Remote server (rsync, scp)

> [!IMPORTANT]
> archive_command must return 0 (success) only when the file is safely stored. Returning 0 prematurely causes data loss risk. PostgreSQL will retry failed archives until success.

#### Backup Tools Comparison

| Tool | Type | Best for | Pros | Cons |
|------|------|----------|------|------|
| **pg_dump** | Logical | Small DBs, migrations | Portable, selective | Slow for large DBs |
| **pg_basebackup** | Physical | Basic PITR | Built-in, simple | Manual WAL management |
| **pgBackRest** | Physical | Production systems | Parallel backup/restore, compression, S3 support | Learning curve |
| **Barman** | Physical | Enterprise | Full PITR, retention policies | Python dependency |
| **WAL-G** | Physical | Cloud-native | S3/GCS/Azure native, compression | Less mature |

### Recovery Point Objective (RPO) vs Recovery Time Objective (RTO)

**RPO (Recovery Point Objective)**: How much data loss is acceptable?
- Logical backup only: RPO = time since last backup (could be 24 hours)
- PITR with WAL archiving: RPO = ~minutes (only lose uncommitted transactions)
- Synchronous replication: RPO = 0 (zero data loss)

**RTO (Recovery Time Objective)**: How long can recovery take?
- Small database (< 100 GB): Minutes to hours
- Large database (> 1 TB): Hours to days (without streaming restore)
- With standby server: Seconds (failover)

## Why it matters

### Data Loss Prevention

**Human error:**
- Accidental `DROP TABLE` or `DELETE` without `WHERE`
- Wrong data in migration script
- Application bug corrupting data

**Hardware failure:**
- Disk failure (RAID isn't backup)
- Complete server failure
- Datacenter disaster

**Malicious activity:**
- Ransomware encryption
- Malicious DELETE/UPDATE
- Compromised credentials

### Compliance Requirements

Many industries require:
- Retention period (7 years for financial data)
- Point-in-time recovery capability
- Verified restore procedures
- Off-site backups (geographic redundancy)

### Operational Confidence

Tested backups enable:
- Major schema migrations (can rollback via PITR)
- Application deployments (restore if bad code corrupts data)
- Testing environments (restore production to staging)
- Analysis without affecting production

## How to monitor

### Check Archiving Status

```sql
-- Check if archiving is enabled
SHOW archive_mode;
SHOW archive_command;

-- Check archiver process activity
SELECT
    archived_count,
    last_archived_wal,
    last_archived_time,
    failed_count,
    last_failed_wal,
    last_failed_time,
    stats_reset
FROM pg_stat_archiver;
```

**Example output:**
```
 archived_count |     last_archived_wal      |       last_archived_time       | failed_count | last_failed_wal | last_failed_time | stats_reset
----------------+----------------------------+--------------------------------+--------------+-----------------+------------------+-------------
         245623 | 0000000100000A2B0000004C   | 2026-01-27 14:23:45.678+00     |            0 |                 |                  |
```

**What to look for:**
- `failed_count > 0`: Archive command failing (check logs)
- `last_archived_time` old: Archiving stuck or slow
- `archived_count` not increasing: No WAL being generated (idle system) or archiving broken

### Verify Archive Directory

```bash
# Check archive directory exists and has recent files
ls -lht /mnt/archive/ | head -20

# Count archived WAL files
ls -1 /mnt/archive/ | wc -l

# Check disk usage
du -sh /mnt/archive/

# Find oldest and newest archived files
ls -lt /mnt/archive/ | tail -1  # oldest
ls -lt /mnt/archive/ | head -2  # newest
```

**What to look for:**
- No recent files: Archiving stopped
- Disk full: Archive destination out of space
- Gaps in sequence: Missing WAL files (data loss risk)

> [!NOTE]
> Archive command failures are also logged to PostgreSQL logs. Check with `grep "archive command failed" /var/log/postgresql/postgresql-*.log` for detailed error messages.

### Monitor Backup Age

```bash
# Check age of last pg_basebackup
ls -lht /backups/base/ | head -5

# Check backup size trends
du -sh /backups/base/* | sort -h
```

```sql
-- Create monitoring table (run once)
CREATE TABLE IF NOT EXISTS backup_history (
    backup_id SERIAL PRIMARY KEY,
    backup_type TEXT,
    backup_start TIMESTAMP,
    backup_end TIMESTAMP,
    backup_size_bytes BIGINT,
    wal_start_lsn PG_LSN,
    wal_end_lsn PG_LSN
);

-- Example: Record pg_dump backup
INSERT INTO backup_history (
    backup_type,
    backup_start,
    backup_end,
    backup_size_bytes,
    wal_start_lsn,
    wal_end_lsn
) VALUES (
    'pg_dump',
    '2026-01-27 10:00:00',
    '2026-01-27 10:15:00',
    5368709120,  -- Size of dump file in bytes
    NULL,        -- pg_dump doesn't use LSN
    NULL
);

-- Example: Record pg_basebackup (capture LSN before/after)
-- Step 1: Before backup
SELECT pg_current_wal_lsn() AS start_lsn, now() AS start_time \gset

-- Step 2: Run pg_basebackup (in shell)
-- pg_basebackup -D /backup/base_20260127 -Ft -z -P

-- Step 3: After backup, record it
INSERT INTO backup_history (
    backup_type,
    backup_start,
    backup_end,
    backup_size_bytes,
    wal_start_lsn,
    wal_end_lsn
) VALUES (
    'pg_basebackup',
    :'start_time',
    now(),
    (SELECT pg_size_bytes(pg_tablespace_size('pg_default'))),
    :'start_lsn',
    pg_current_wal_lsn()
);

-- Query backup history
SELECT
    backup_type,
    backup_start,
    backup_end,
    backup_end - backup_start AS duration,
    pg_size_pretty(backup_size_bytes) AS size,
    NOW() - backup_end AS age
FROM backup_history
ORDER BY backup_start DESC
LIMIT 10;
```

**Automated tracking with script:**

```bash
#!/bin/bash
# backup_with_tracking.sh

DB_HOST=localhost
DB_NAME=mydb
BACKUP_DIR=/backups
BACKUP_FILE="${BACKUP_DIR}/mydb_$(date +%Y%m%d_%H%M%S).dump"

# Capture start time and LSN
START_TIME=$(date -Iseconds)
START_LSN=$(psql -h $DB_HOST -d $DB_NAME -tAc "SELECT pg_current_wal_lsn()")

# Run backup
pg_dump -h $DB_HOST -Fc -f $BACKUP_FILE $DB_NAME

# Capture end time and size
END_TIME=$(date -Iseconds)
BACKUP_SIZE=$(stat -f%z "$BACKUP_FILE" 2>/dev/null || stat -c%s "$BACKUP_FILE")

# Record in database
psql -h $DB_HOST -d $DB_NAME <<EOF
INSERT INTO backup_history (
    backup_type, backup_start, backup_end,
    backup_size_bytes, wal_start_lsn, wal_end_lsn
) VALUES (
    'pg_dump',
    '$START_TIME'::timestamp,
    '$END_TIME'::timestamp,
    $BACKUP_SIZE,
    NULL, NULL
);
EOF

echo "✓ Backup completed and recorded: $BACKUP_FILE"
```

### Test Recovery (Critical!)

> [!CAUTION]
> **Never assume backups work**. Schedule regular recovery tests to verify:
> - Backup files are not corrupted
> - Archive command is storing files correctly
> - Recovery procedures are documented and work
> - RTO meets business requirements

**Test recovery checklist:**

1. **Monthly**: Restore latest backup to test environment
2. **Quarterly**: Full PITR test with specific recovery target
3. **After major changes**: Test restore after PostgreSQL upgrades or config changes
4. **Document**: Record time taken, issues encountered, procedure updates

## Common backup strategies

### Strategy 1: Logical Backups Only (Small Databases)

**Best for:** Development, staging, databases < 50 GB

```bash
# Single-threaded backup (custom format)
pg_dump -h localhost -U postgres -Fc -f /backups/mydb_$(date +%Y%m%d).dump mydb

# Parallel backup (directory format) - faster for larger DBs
pg_dump -h localhost -U postgres -Fd -j 4 -f /backups/mydb_$(date +%Y%m%d) mydb

# Plain SQL format (human-readable, version control)
pg_dump -h localhost -U postgres -Fp -f /backups/mydb_$(date +%Y%m%d).sql mydb

# Keep last 7 days
find /backups/ -name "mydb_*" -mtime +7 -delete

# Restore from custom format
pg_restore -h localhost -U postgres -d mydb_restored /backups/mydb_20260127.dump

# Restore from directory format (parallel)
pg_restore -h localhost -U postgres -j 4 -d mydb_restored /backups/mydb_20260127/

# Restore specific table only
pg_restore -h localhost -U postgres -d mydb_restored -t users /backups/mydb_20260127.dump

# Restore from plain SQL
psql -h localhost -U postgres -d mydb_restored -f /backups/mydb_20260127.sql
```

**Directory format structure:**
```bash
$ ls -lh /backups/mydb_20260127/
total 2.5G
-rw------- 1 postgres postgres  127 Jan 27 10:00 toc.dat        # Table of contents
-rw------- 1 postgres postgres  850M Jan 27 10:02 3456.dat.gz   # Table data (compressed)
-rw------- 1 postgres postgres  420M Jan 27 10:03 3457.dat.gz   # Another table
-rw------- 1 postgres postgres  1.2G Jan 27 10:05 3458.dat.gz   # Large table
```

**Pros:**
- Simple, no WAL archiving needed
- Portable across versions
- Can restore specific tables
- Directory format: parallel dump/restore (faster)

**Cons:**
- No PITR (only restore to backup time)
- Slow for large databases (even with parallelization)
- RPO = backup frequency (typically 24 hours)

### Strategy 2: Physical Backup + WAL Archiving (PITR)

**Best for:** Production systems, databases > 50 GB

```bash
# 1. Enable WAL archiving (postgresql.conf)
wal_level = replica
archive_mode = on
archive_command = 'test ! -f /mnt/archive/%f && cp %p /mnt/archive/%f'

# 2. Weekly base backup
pg_basebackup -h localhost -U replication -D /backups/base_$(date +%Y%m%d) -Ft -z -P

# 3. WAL files archived continuously by PostgreSQL

# 4. PITR restore
# - Restore base backup
# - Create recovery.signal file
# - Configure recovery.conf or postgresql.conf
# - Start PostgreSQL (replays WAL to target time)
```

**Pros:**
- PITR capability (restore to any point)
- RPO in minutes
- Faster restore than logical backups

**Cons:**
- Requires WAL archiving setup
- More complex to manage
- Needs monitoring

### Strategy 3: Modern Tools (pgBackRest/Barman)

**Best for:** Large production systems, multiple databases

**pgBackRest example:**

```bash
# Configure pgbackrest.conf
[global]
repo1-path=/var/lib/pgbackrest
repo1-retention-full=4
repo1-retention-diff=4
process-max=4

[main]
pg1-path=/var/lib/postgresql/data
pg1-port=5432

# Create full backup
pgbackrest --stanza=main backup --type=full

# Create differential backup (faster, based on last full)
pgbackrest --stanza=main backup --type=diff

# Restore to specific time
pgbackrest --stanza=main restore --type=time --target="2026-01-27 14:00:00"
```

**Pros:**
- Parallel backup/restore (faster)
- Incremental backups
- Automatic retention management
- Built-in compression and encryption
- S3/GCS/Azure support

**Cons:**
- Additional tool to learn and maintain
- Configuration complexity

### Strategy 4: Continuous Protection (Streaming Replication)

**Best for:** Critical systems requiring near-zero downtime

```
Primary ───(streaming replication)──> Standby
  │                                      │
  ├─> WAL Archive ───────────────────────┤
  │                                      │
  └─> pg_basebackup (weekly)             └─> Promoted on failover
```

**Characteristics:**
- RPO ≈ 0 (with synchronous replication)
- RTO = seconds to minutes (promote standby)
- Combines replication with PITR backups
- Standby can be used for backups (offload from primary)

> [!TIP]
> Take backups from standby server to avoid impacting primary performance. Use `pg_basebackup -h standby-host` or configure backup tools to connect to standby.

## Common problems

### Problem: Archive command failing

**Symptom:** `pg_stat_archiver` shows `failed_count > 0`, logs show archive errors

**Diagnosis:**

```sql
SELECT failed_count, last_failed_wal, last_failed_time
FROM pg_stat_archiver;
```

```bash
# Check PostgreSQL logs
grep "archive command failed" /var/log/postgresql/postgresql-*.log
```

**Common causes:**
- Archive destination disk full
- Permission denied (postgres user can't write)
- Network mount disconnected
- Archive command syntax error

**Solutions:**

1. **Fix disk space:**
   ```bash
   df -h /mnt/archive/
   # Clean old archives or expand storage
   ```

2. **Fix permissions:**
   ```bash
   chown -R postgres:postgres /mnt/archive/
   chmod 755 /mnt/archive/
   ```

3. **Test archive command manually:**
   ```bash
   su - postgres
   cp /var/lib/postgresql/data/pg_wal/000000010000000000000001 /mnt/archive/
   ```

> [!CAUTION]
> Always test archive commands as the `postgres` user, not as `root`. Permission issues that work as root may fail when PostgreSQL (running as postgres) tries to execute the same command. Use `su - postgres` before testing.

4. **Check archive_command syntax:**
   ```sql
   SHOW archive_command;
   -- Common mistake: missing 'test ! -f' check
   -- Correct: test ! -f /mnt/archive/%f && cp %p /mnt/archive/%f
   ```

### Problem: pg_basebackup taking too long

**Symptom:** Backup takes hours, impacts production performance

**Diagnosis:**

```bash
# Monitor backup progress
pg_basebackup -D /backup -P  # -P shows progress

# Check I/O wait on server
iostat -x 5
```

**Solutions:**

1. **Take backup from standby** (offload primary):
   ```bash
   pg_basebackup -h standby-host -D /backup -P
   ```

2. **Use compression** (reduce I/O if network is bottleneck):
   ```bash
   pg_basebackup -D /backup -Ft -z -P  # gzip compression
   ```

3. **Use modern tools** with parallel processing:
   ```bash
   pgbackrest --stanza=main backup --type=full  # parallel by default
   ```

4. **Schedule during low-traffic periods:**
   ```bash
   # Cron: 2 AM Sunday
   0 2 * * 0 /usr/bin/pg_basebackup -D /backup/$(date +\%Y\%m\%d) -P
   ```

### Problem: Cannot restore - "requested timeline is not in this server's history"

**Symptom:** PITR restore fails with timeline error

**Cause:** WAL archive contains files from multiple timelines (after previous recovery/promotion)

**Diagnosis:**

```bash
# Check timeline in backup label
cat /backup/backup_label
# Look for: START TIMELINE: 1

# Check available WAL files and their timelines
ls -1 /mnt/archive/ | head -20
# Format: 00000001... = timeline 1
# Format: 00000002... = timeline 2
```

**Solution:**

1. **Ensure recovery_target_timeline is set:**
   ```ini
   # recovery.conf or postgresql.conf
   recovery_target_timeline = 'latest'  # Follow timeline history
   ```

2. **Clean old timeline files** if needed (CAREFUL - can cause data loss):
   ```bash
   # Only remove if you're certain they're from old, unwanted timelines
   ```

3. **Use restore_command** that understands timeline files:
   ```ini
   restore_command = 'cp /mnt/archive/%f %p'
   # Ensure timeline history files (.history) are also archived
   ```

### Problem: Recovery stopping before target time

**Symptom:** PITR stops earlier than `recovery_target_time`, missing recent transactions

**Diagnosis:**

```bash
# Check available WAL files
ls -lt /mnt/archive/ | head -20

# Check PostgreSQL recovery logs
grep "recovery stopping" /var/log/postgresql/postgresql-*.log
```

**Causes:**
- Missing WAL files (gaps in archive)
- `recovery_target_action = 'pause'` (stops but doesn't promote)
- Archive incomplete at recovery time

**Solutions:**

1. **Verify WAL continuity:**
   ```bash
   # Check for gaps in WAL sequence
   ls -1 /mnt/archive/ | sort | awk '
     NR==1 {prev=$0; next}
     {
       split(prev, a, ""); split($0, b, "")
       # Compare sequence numbers (simplified)
       if ($0 != prev) print "Gap: " prev " -> " $0
       prev=$0
     }
   '
   ```

2. **Check recovery_target_action:**
   ```ini
   recovery_target_action = 'promote'  # Auto-promote at target
   # NOT 'pause' (requires manual promotion)
   ```

3. **Ensure archive_command completed** before failure:
   ```sql
   -- On original server (if accessible)
   SELECT last_archived_wal FROM pg_stat_archiver;
   ```

### Problem: Backup files corrupted or unusable

**Symptom:** Restore fails with "invalid backup" or corruption errors

**Prevention:**

1. **Verify backups after creation:**
   ```bash
   # Test pg_dump backups
   pg_restore -l /backups/mydb_20260127.dump > /dev/null

   # Verify basebackup integrity
   tar -tzf /backups/base.tar.gz > /dev/null

   # Use checksums
   sha256sum /backups/mydb_20260127.dump > /backups/mydb_20260127.dump.sha256
   ```

2. **Test recovery regularly:**
   ```bash
   # Automated monthly recovery test
   #!/bin/bash
   BACKUP=/backups/latest.dump
   TEST_DB=restore_test_$(date +%Y%m%d)

   dropdb --if-exists $TEST_DB
   createdb $TEST_DB
   pg_restore -d $TEST_DB $BACKUP

   if [ $? -eq 0 ]; then
     echo "✓ Backup verified successfully"
     dropdb $TEST_DB
   else
     echo "✗ Backup verification FAILED - investigate!"
     exit 1
   fi
   ```

3. **Store backups redundantly:**
   - Local disk + remote location
   - Multiple cloud regions
   - Different storage classes (S3 + Glacier)

### Problem: Backup retention filling disk

**Symptom:** Backup directory filling disk, old backups never deleted

**Solution:**

1. **Implement retention policy:**
   ```bash
   # Keep 7 daily, 4 weekly, 12 monthly

   # Daily: delete older than 7 days
   find /backups/daily/ -name "*.dump" -mtime +7 -delete

   # Weekly: delete older than 28 days
   find /backups/weekly/ -name "*.dump" -mtime +28 -delete

   # Monthly: delete older than 365 days
   find /backups/monthly/ -name "*.dump" -mtime +365 -delete
   ```

2. **Use backup tools with built-in retention:**
   ```ini
   # pgBackRest
   repo1-retention-full=4      # Keep 4 full backups
   repo1-retention-diff=4      # Keep 4 differential per full

   # Barman
   retention_policy = 'RECOVERY WINDOW OF 30 DAYS'
   ```

3. **Monitor archive growth:**
   ```bash
   # Alert if archive directory > 80% full
   df -h /mnt/archive/ | awk 'NR==2 {if ($5+0 > 80) print "ALERT: Archive disk usage " $5}'
   ```

## References

1. [PostgreSQL Documentation: Backup and Restore](https://www.postgresql.org/docs/current/backup.html)
2. [PostgreSQL Documentation: Continuous Archiving and Point-in-Time Recovery (PITR)](https://www.postgresql.org/docs/current/continuous-archiving.html)
3. [PostgreSQL Documentation: pg_basebackup](https://www.postgresql.org/docs/current/app-pgbasebackup.html)
4. [PostgreSQL Documentation: pg_dump](https://www.postgresql.org/docs/current/app-pgdump.html)
5. [pgBackRest Documentation](https://pgbackrest.org/user-guide.html)
6. [Barman Documentation](https://docs.pgbarman.org/)
7. [WAL-G GitHub](https://github.com/wal-g/wal-g)

[^1]: [Wikipedia: Endianness](https://en.wikipedia.org/wiki/Endianness) - Byte order in computer memory. Little-endian stores least significant byte first (x86, ARM). Big-endian stores most significant byte first (SPARC, PowerPC). Physical backups cannot be restored between different endianness.
