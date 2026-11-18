# Integrate the verified release into main

## Observed ancestry

Before integration on 18 November 2026, `main` pointed to `574a454` and `codex/milestone-2-phase-3` pointed to the verified release `0ade47c950f5097abf5c6274bf21a3564c960042`. The feature tip was 20 commits ahead with no divergence. The intermediate `stretch-features` and Phase 1 and Phase 2 tips are ancestors of the verified release.

## Integration checks

1. Confirm the canonical GitHub repository and compare its current `main` and feature refs. The checkout's `origin` still uses the previous repository name. Recheck ancestry with `git rev-list --left-right --count origin/main...HEAD` after fetching. If the remote base moved, inspect the added commits and revalidate an integration branch against the new base.
2. On a dedicated portfolio branch based on the verified release, stage the reviewed documentation and screenshot files explicitly. Check `git diff --cached --check` and inspect the staged file list and patch. Keep local lab artifacts, environment files, production notes, and raw captures outside the change.
3. Inspect the full incoming range, including historical content, before publishing to the default branch. The tracked AWS runbook previously contained instance-specific identifiers. The current runbook uses placeholders. Prior revisions remain in history.
4. Push the reviewed portfolio branch after authorization and open one PR to `main`. Confirm the release SHA is an ancestor of the proposed head. Review the full diff and GitHub's rendered diagram and screenshots. Require green pull-request CI, including the disposable Linux hosting scenario, and record the separate Playwright results and any fixture requirements.
5. Use a history-preserving merge after approval. A GitHub merge commit preserves the exact verified release SHA and its ancestry. If repository policy provides a reviewed fast-forward, it can preserve the same history while keeping a linear branch. Recheck `main` ancestry and render the default-branch README after the merge.

The repository workflow checks code and runs tests. The checked-in CI does not deploy to AWS. Keep the accepted EC2 release independent of this Git integration.
