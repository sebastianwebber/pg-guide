# PostgreSQL Core Concepts and Operations Guide

This project is now a website: https://sebastianwebber.github.io/pg-guide/

## Purpose

This guide is designed to help platform engineers, software developers, Kubernetes specialists, and network engineers understand the essential PostgreSQL concepts and architecture that affect day-to-day operations.

## Target Audience

- Platform engineers
- Kubernetes/Infrastructure specialists
- Software developers
- Network engineers
- Anyone operating PostgreSQL in production environments

## Topics

### 1. [Process Architecture](content/docs/01-process-architecture.md)
Understanding PostgreSQL's process model, backend processes, auxiliary processes, and connection management.

### 2. [Memory Management](content/docs/02-memory-management.md)
Shared buffers, work memory, maintenance work memory, and how PostgreSQL uses memory.

### 3. [MVCC and Transactions](content/docs/03-mvcc-transactions.md)
Multi-Version Concurrency Control, transaction isolation levels, visibility, row-level locks, and MultiXact IDs.

### 4. [WAL (Write-Ahead Log)](content/docs/04-wal.md)
Write-Ahead Logging, checkpoints, durability, and crash recovery.

### 5. [Replication](content/docs/05-replication.md)
Streaming replication, replication slots, synchronous vs asynchronous replication, failover concepts.

### 6. [Tablespaces and Storage](content/docs/06-tablespaces-storage.md)
Physical layout, PGDATA directory structure, configuration file management, TOAST, fillfactor, and storage management.

### 7. [Critical Monitoring](content/docs/07-monitoring.md)
Essential views, key metrics, and logging configuration for production operations.

### 8. [Backup and Recovery](content/docs/08-backup-recovery.md)
Backup strategies, PITR, modern tools, and disaster recovery concepts.

### 9. Upgrade *(planned)*
pg_upgrade, logical replication for upgrades, extension management, and version policies.

### 10. [Maintenance](content/docs/10-maintenance.md)
Maintenance tasks such as VACUUM, REINDEX, and others.

### 11. Configuration and Tuning *(planned)*
Critical postgresql.conf parameters, authentication, and workload-specific tuning.

### 12. Common Troubleshooting *(planned)*
Practical solutions for replication lag, connection issues, and disk space problems.

### 13. Operational Security *(planned)*
Roles, privileges, SSL/TLS, audit logging, and row-level security.

### 14. TimescaleDB Specific *(planned)*
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

## TODO
- [ ] expand patroni session into a whole chapter
- [ ] add page layout explanation to tablespaces and storage chapter (PageHeader, line pointers, tuple headers)
- [ ] expand maintenance chapter with CLUSTER, REINDEX
