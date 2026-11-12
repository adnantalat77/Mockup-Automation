# Phase 1 dependency audit

Audit date: 2026-11-12

`npm audit --json` reported eight vulnerabilities: seven moderate and one high. No compatible, nonbreaking automatic fix was available, so no dependency versions were forced or downgraded.

| Package/path | Severity | Advisory | Current action |
|---|---:|---|---|
| `sharp` / bundled libvips | High | GHSA-f88m-g3jw-g9cj, GHSA-rgj7-g3m4-5g8c, GHSA-wq5f-xc86-pv6w | npm proposes Sharp 0.35.5 and labels it SemVer-major from the current 0.34 line. Deferred pending compatibility testing. Phase 1 accepts only locally supplied JPEG/PNG and imposes byte and pixel limits, but the risk is not considered resolved. |
| `minimatch` through `@typescript-eslint/typescript-estree` | Moderate | GHSA-g3hv-75wg-m249 | Development tooling only. npm proposes a SemVer-major `typescript-eslint` change. Deferred. |
| `typescript-eslint` | Moderate | Inherits affected parser/plugin utilities | Development tooling only. npm's proposed remediation is labeled SemVer-major and unexpectedly targets an older 8.36.0 release. Deferred rather than forcing a downgrade. |
| `@typescript-eslint/eslint-plugin` | Moderate | Through `type-utils` and `utils` | Same transitive development-tooling chain; deferred. |
| `@typescript-eslint/parser` | Moderate | Through `typescript-estree` | Same transitive development-tooling chain; deferred. |
| `@typescript-eslint/type-utils` | Moderate | Through `typescript-estree` and `utils` | Same transitive development-tooling chain; deferred. |
| `@typescript-eslint/typescript-estree` | Moderate | Through vulnerable `minimatch` | Same transitive development-tooling chain; deferred. |
| `@typescript-eslint/utils` | Moderate | Through `typescript-estree` | Same transitive development-tooling chain; deferred. |

Re-run `npm audit` before release and evaluate Sharp 0.35.x in a dedicated compatibility change. Do not use `npm audit fix --force` for this Phase 1 hardening task.
