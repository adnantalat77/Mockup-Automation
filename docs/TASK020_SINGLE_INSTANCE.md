# Task 020: Windows single-instance ownership

## Architecture

The executable API startup path acquires exclusive ownership of the configured data directory before `AssetStore`, `BatchService`, or `PublishingService` is constructed. Those initializers can create asset directories, recover batch metadata, and append recovery checkpoints, so a process that loses acquisition exits before any of them runs. The lock covers all state below `DATA_DIR`, not only publication records.

The startup audit identified these protected mutations:

- `AssetStore.init()` creates upload and generated-preview directories; later route handlers write image bytes and metadata there.
- `BatchService.init()` creates the batch directory and rewrites an interrupted running batch to a durable partial record.
- `PublishingService.init()` creates the publication directory and appends recovery checkpoints for interrupted creation, deletion, publication, or rollback intents.
- Runtime batch generation, upload, publication, rollback, abandonment, and finalization handlers all write below the same root.

`PublishingService`'s existing in-memory product set remains in place to serialize same-product operations after the owning process starts.

On Windows, ownership is a named-pipe listener whose name contains the SHA-256 digest of the canonical data-directory identity. `net.Server.listen()` is the atomic acquisition operation: exactly one process can own the pipe. The open server handle remains in the actual API process for its lifetime. This is not a PID-file check and there is no check-then-create race, remote unlock endpoint, or force-unlock command.

## Canonical directory identity

Startup resolves the configured spelling to an absolute path, creates the directory if it does not exist, calls `realpath`, normalizes separators and trailing separators, and folds Windows case before hashing. Canonical directory creation is therefore the one filesystem change that can occur before exclusive acquisition; no asset folders, batch records, publication checkpoints, recovery repairs, or other mutable application-state initialization may occur before the lock is owned. Relative and absolute spellings, trailing separators, paths with spaces, case-only differences, and aliases resolved by `realpath` converge on one identity.

Local NTFS paths are the supported deployment. Junctions and symlinks are handled when Windows `realpath` resolves them to the same final path. Network shares, filesystem aliases that `realpath` cannot unify, and filesystems with uncertain naming or locking semantics are not approved; startup should be treated as failed closed rather than running multiple owners.

## Lifecycle and recovery

The lock is acquired before mutable application initialization and before the loopback HTTP listener accepts requests. If initialization or HTTP binding fails, startup releases the acquired handle only after confirming that no HTTP listener remains active. On `SIGINT` or `SIGTERM`, the HTTP server first stops accepting requests and waits for active requests to finish; only then is ownership released. Concurrent shutdown callers share the same attempt. A failed close retains ownership and remains retryable; forced process termination closes the Windows kernel handle automatically, so a later process can acquire ownership without deleting metadata.

Duplicate startup reports:

> Mockup Automation is already running against this data directory.

The diagnostic includes only the canonical local path. It contains no Shopify token, credential, authorization secret, or environment dump.

The implementation creates no lock metadata file. A stale file left by an older build or an operator does not establish ownership and is neither trusted nor deleted. Safe recovery is to confirm the original API process has exited and start the API normally. Never delete a named pipe or terminate another process as an unlock technique.

## Development workflow

`npm run dev` starts the API through `tsx watch`; the actual API child owns the handle. The React/Vite process does not import the API runtime and never acquires it. During a watch restart, the former child's kernel handle is released on exit. A genuinely overlapping replacement fails closed instead of initializing shared state concurrently.

`createApp()` remains an unbound application factory for isolated tests. Production and development executable startup use `startApi()`, which owns acquisition, initialization, binding, and shutdown ordering.

## Test coverage

The focused suite launches real independent Node.js child processes and covers first-owner success, duplicate rejection, no losing-process initialization marker, graceful release, forced termination and restart, relative/absolute/trailing/spaced paths, stale metadata, and simultaneous acquisition with one winner. Additional tests cover Windows identity normalization, newly created directory identity, and startup-failure release. The full regression suite continues to cover in-process product locking, interrupted publication recovery, Task 018 checkpoint compatibility, and Task 019 provenance enforcement.
