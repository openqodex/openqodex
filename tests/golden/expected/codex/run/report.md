# Passed with warnings: 17 findings \(7 major, 10 minor\)

Change 597352237e51 against HEAD, 11 files, +45 -16

Summary: Reviewed the fixed planted change.

Blast radius: risk low \(2 symbols touched, 0 callers in 0 files\)

Counts: 17 findings \(7 major, 10 minor\), 0 scanner candidates dropped, 7 below the severity threshold

## Findings \(17\)

### 1. Major bug: Planted problem number 1

- **Where:** app/config.py:2
- **Problem:** This changed line introduces an unsafe operation.
- **Why it matters:** The affected behavior can fail when this path runs.
- **Fix:** Correct the flagged operation before using this change.
- **Source:** gitleaks:stripe-access-token

### 2. Major bug: Planted problem number 2

- **Where:** .github/workflows/ci.yml:17
- **Problem:** This changed line introduces an unsafe operation.
- **Why it matters:** The affected behavior can fail when this path runs.
- **Fix:** Correct the flagged operation before using this change.
- **Source:** actionlint:expression

### 3. Major bug: Planted problem number 3

- **Where:** Dockerfile:6
- **Problem:** This changed line introduces an unsafe operation.
- **Why it matters:** The affected behavior can fail when this path runs.
- **Fix:** Correct the flagged operation before using this change.
- **Source:** hadolint:DL3020

### 4. Major bug: Planted problem number 4

- **Where:** infra/main.tf:28
- **Problem:** This changed line introduces an unsafe operation.
- **Why it matters:** The affected behavior can fail when this path runs.
- **Fix:** Correct the flagged operation before using this change.
- **Source:** trivy:AWS-0107

### 5. Major bug: Planted problem number 5

- **Where:** deploy/deployment.yaml:42
- **Problem:** This changed line introduces an unsafe operation.
- **Why it matters:** The affected behavior can fail when this path runs.
- **Fix:** Correct the flagged operation before using this change.
- **Source:** kube-linter:privileged-container

### 6. Major bug: Planted problem number 6

- **Where:** deploy/deployment.yaml:43
- **Problem:** This changed line introduces an unsafe operation.
- **Why it matters:** The affected behavior can fail when this path runs.
- **Fix:** Correct the flagged operation before using this change.
- **Source:** kube-linter:privilege-escalation-container

### 7. Major bug: Planted problem number 7

- **Where:** scripts/deploy.sh:11
- **Problem:** This changed line introduces an unsafe operation.
- **Why it matters:** The affected behavior can fail when this path runs.
- **Fix:** Correct the flagged operation before using this change.
- **Source:** shellcheck:SC2045

### 8. Minor bug: Planted problem number 8

- **Where:** db/migrations/002\_index\_item\_names.sql:2
- **Problem:** This changed line introduces an unsafe operation.
- **Why it matters:** The affected behavior can fail when this path runs.
- **Fix:** Correct the flagged operation before using this change.
- **Source:** squawk:require-concurrent-index-creation

### 9. Minor bug: Planted problem number 9

- **Where:** Dockerfile:1
- **Problem:** This changed line introduces an unsafe operation.
- **Why it matters:** The affected behavior can fail when this path runs.
- **Fix:** Correct the flagged operation before using this change.
- **Source:** hadolint:DL3007

### 10. Minor bug: Planted problem number 10

- **Where:** Dockerfile:3
- **Problem:** This changed line introduces an unsafe operation.
- **Why it matters:** The affected behavior can fail when this path runs.
- **Fix:** Correct the flagged operation before using this change.
- **Source:** hadolint:DL3008

### 11. Minor bug: Planted problem number 11

- **Where:** Dockerfile:3
- **Problem:** This changed line introduces an unsafe operation.
- **Why it matters:** The affected behavior can fail when this path runs.
- **Fix:** Correct the flagged operation before using this change.
- **Source:** hadolint:DL3014

### 12. Minor bug: Planted problem number 12

- **Where:** Dockerfile:7
- **Problem:** This changed line introduces an unsafe operation.
- **Why it matters:** The affected behavior can fail when this path runs.
- **Fix:** Correct the flagged operation before using this change.
- **Source:** hadolint:DL3042

### 13. Minor bug: Planted problem number 13

- **Where:** deploy/deployment.yaml:42
- **Problem:** This changed line introduces an unsafe operation.
- **Why it matters:** The affected behavior can fail when this path runs.
- **Fix:** Correct the flagged operation before using this change.
- **Source:** checkov:CKV\_K8S\_16

### 14. Minor bug: Planted problem number 14

- **Where:** deploy/deployment.yaml:43
- **Problem:** This changed line introduces an unsafe operation.
- **Why it matters:** The affected behavior can fail when this path runs.
- **Fix:** Correct the flagged operation before using this change.
- **Source:** checkov:CKV\_K8S\_20

### 15. Minor bug: Planted problem number 15

- **Where:** infra/main.tf:28
- **Problem:** This changed line introduces an unsafe operation.
- **Why it matters:** The affected behavior can fail when this path runs.
- **Fix:** Correct the flagged operation before using this change.
- **Source:** checkov:CKV\_AWS\_24

### 16. Minor bug: Planted problem number 16

- **Where:** scripts/deploy.sh:7
- **Problem:** This changed line introduces an unsafe operation.
- **Why it matters:** The affected behavior can fail when this path runs.
- **Fix:** Correct the flagged operation before using this change.
- **Source:** shellcheck:SC2115

### 17. Minor bug: Planted problem number 17

- **Where:** app/search.py:14
- **Problem:** This changed line introduces an unsafe operation.
- **Why it matters:** The affected behavior can fail when this path runs.
- **Fix:** Correct the flagged operation before using this change.
- **Source:** bandit:B608

## Coverage

- **Files the reviewer opened:** not recorded by Codex
- **Reads outside the snapshot:** not recorded by Codex
- **Changed ranges given to the reviewer:** 18 of 18
Scanners: 15 scanners ran, 5 had nothing to check

Reviewer: codex 0.160.0, <SECONDS> s, 1 turn, 1,000 tokens in, 500 out

Made by Qodex: review on every pull request at https://qodex.ai
