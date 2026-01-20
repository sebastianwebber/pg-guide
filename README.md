# PostgreSQL Core Concepts and Operations Guide

## Purpose

This guide is designed to help platform engineers, software developers, Kubernetes specialists, and network engineers understand the essential PostgreSQL concepts and architecture that affect day-to-day operations.

## Target Audience

- Platform engineers
- Kubernetes/Infrastructure specialists
- Software developers
- Network engineers
- Anyone operating PostgreSQL in production environments

## Topics

### 1. [Process Architecture](01-process-architecture.md)
Understanding PostgreSQL's process model, backend processes, auxiliary processes, and connection management.

### 2. [Memory Management](02-memory-management.md)
Shared buffers, work memory, maintenance work memory, and how PostgreSQL uses memory.

### 3. [MVCC and Transactions](03-mvcc-transactions.md)
Multi-Version Concurrency Control, transaction isolation levels, and visibility.

### 4. [VACUUM and Bloat](04-vacuum-bloat.md)
Autovacuum, dead tuple management, bloat identification and prevention.

### 5. [WAL (Write-Ahead Log)](05-wal.md)
Write-Ahead Logging, checkpoints, durability, and crash recovery.

### 6. [Replication](06-replication.md)
Streaming replication, replication slots, synchronous vs asynchronous replication, failover concepts.

### 7. [Tablespaces and Storage](07-tablespaces-storage.md)
Physical layout, TOAST, fillfactor, and storage management.

### 8. [Critical Monitoring](08-monitoring.md)
Essential views, key metrics, and logging configuration for production operations.

### 9. [Backup and Recovery](09-backup-recovery.md)
Backup strategies, PITR, modern tools, and disaster recovery concepts.

### 10. [Upgrade and Maintenance](10-upgrade-maintenance.md)
pg_upgrade, logical replication for upgrades, extension management, and version policies.

### 11. [Configuration and Tuning](11-configuration-tuning.md)
Critical postgresql.conf parameters, authentication, and workload-specific tuning.

### 12. [Common Troubleshooting](12-troubleshooting.md)
Practical solutions for bloat recovery, replication lag, connection issues, and disk space problems.

### 13. [Operational Security](13-security.md)
Roles, privileges, SSL/TLS, audit logging, and row-level security.

### 14. [TimescaleDB Specific](14-timescaledb.md)
Hypertables, chunks, compression, continuous aggregates, and operational considerations.

## How to Use This Guide

Each topic is structured as follows:
- **What is it?** - Core concepts explained
- **Why it matters** - Operational impact and importance
- **How to monitor** - Practical queries and metrics
- **Common problems** - Symptoms and solutions
- **References** - Official documentation and resources

Start with topics relevant to your current challenges, or read sequentially for comprehensive understanding.

## Contributing

This is a living document. If you find gaps, errors, or have suggestions for improvement, please contribute.
