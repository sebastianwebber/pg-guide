# Claude Code Instructions

Documentation guide for PostgreSQL operational concepts targeting platform engineers and developers.

## Document Structure

```markdown
# Topic Name

## What is it?
## Why it matters
## How to monitor (with example outputs + "What to look for")
## Common problems
## References
```

## GitHub Alert Syntax

```markdown
> [!NOTE]
> General information, context, clarifications

> [!TIP]
> Helpful shortcuts, best practices

> [!IMPORTANT]
> Critical information for success (requires restart, package needed)

> [!WARNING]
> Risk of data loss or operational problems

> [!CAUTION]
> Negative consequences of an action
```

## Key Terminology

**PostgreSQL cluster** = One instance, one PGDATA, multiple databases
**HA cluster** = Multiple instances (primary + standbys)

**backend_type = 'client backend'** filters actual user connections (not system processes)

## Critical Technical Details

**Memory:**
- work_mem = MAXIMUM limit (not fixed allocation)
- hash_mem_multiplier (default 2.0) multiplies work_mem for hash ops
- No limit on allocations per query
- Worst-case: work_mem × operations × workers × connections

**WAL:**
- WAL records written for ALL changes (including uncommitted)
- Dirty pages = modified in shared_buffers, not yet on disk
- Always show wal_buffers in flow diagrams
- Checkpoint duration = checkpoint_timeout × checkpoint_completion_target

**VACUUM:**
- HOT updates prevent index bloat when applicable
- VACUUM marks space reusable (doesn't return to OS)
- Dead tuples affect sequential scans (read and discard overhead)

**Replication:**
- Replication slots prevent WAL recycling (but can fill disk)
- Logical replication = only native cross-version method
- pg_rewind requires wal_log_hints = on

## Diagrams

Use Unicode box-drawing: ┌ ┐ └ ┘ ├ ┤ │ ─ ▼ ↓ → (not ASCII +/-/|)

## Common Corrections

1. work_mem: Always clarify it's maximum, not fixed
2. hash_mem_multiplier: Mention when discussing memory
3. shared_buffers: Reference pgconfig.io (no hardcoded limits)
4. Cluster terminology: Clarify early
5. Backend types: Filter 'client backend' for connections
6. Transactions: Emphasize fast execution
7. Host metrics: Always mention alongside PG metrics

## Commit Format

Follow `~/.claude/tigerdata.md`:

```
docs: <subject max 50 chars>

<body wrapped at 80 cols, focus on WHY>
```

Always use `-s` flag. No AI attribution.

## What to Avoid

- Emojis (unless requested)
- Hardcoded config values (reference pgconfig.io)
- ASCII art diagrams (use Unicode)
- Duplicate content (link to other chapters)
- Skip "What to look for" in examples
- Missing contrib package mentions for extensions
