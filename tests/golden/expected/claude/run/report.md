# Passed with warnings: 27 findings \(14 major, 13 minor\)

Change 597352237e51 against HEAD, 11 files, +45 -16

Summary: Reviewed units u1. The planted operation changes here.

Blast radius: risk low \(2 symbols touched, 0 callers in 0 files\)

Counts: 27 findings \(14 major, 13 minor\), 0 scanner candidates dropped

## Findings \(27\)

### 1. Major security: Planted problem number 1

- **Where:** app/config.py:2
- **Problem:** This changed line introduces an unsafe operation.
- **Why it matters:** The affected behavior can fail when this path runs.
- **Fix:** Correct the flagged operation before using this change.
- **Source:** gitleaks:stripe-access-token

### 2. Major maintainability: Planted problem number 2

- **Where:** .github/workflows/ci.yml:17
- **Problem:** This changed line introduces an unsafe operation.
- **Why it matters:** The affected behavior can fail when this path runs.
- **Fix:** Correct the flagged operation before using this change.
- **Source:** actionlint:expression

### 3. Major maintainability: Planted problem number 3

- **Where:** Dockerfile:6
- **Problem:** This changed line introduces an unsafe operation.
- **Why it matters:** The affected behavior can fail when this path runs.
- **Fix:** Correct the flagged operation before using this change.
- **Source:** hadolint:DL3020

### 4. Major bug: Planted docker-root problem

- **Where:** Dockerfile:10-11
- **Problem:** This changed line introduces an unsafe operation.
- **Why it matters:** The affected behavior can fail when this path runs.
- **Fix:** Correct the operation before using this change.
- **Source:** the reviewer

### 5. Major maintainability: Planted problem number 4

- **Where:** infra/main.tf:28
- **Problem:** This changed line introduces an unsafe operation.
- **Why it matters:** The affected behavior can fail when this path runs.
- **Fix:** Correct the flagged operation before using this change.
- **Source:** trivy:AWS-0107

### 6. Major maintainability: Planted problem number 4

- **Where:** infra/main.tf:28
- **Problem:** This changed line introduces an unsafe operation.
- **Why it matters:** The affected behavior can fail when this path runs.
- **Fix:** Correct the flagged operation before using this change.
- **Source:** checkov:CKV\_AWS\_24

### 7. Major maintainability: Planted problem number 5

- **Where:** deploy/deployment.yaml:42
- **Problem:** This changed line introduces an unsafe operation.
- **Why it matters:** The affected behavior can fail when this path runs.
- **Fix:** Correct the flagged operation before using this change.
- **Source:** kube-linter:privileged-container

### 8. Major maintainability: Planted problem number 5

- **Where:** deploy/deployment.yaml:42
- **Problem:** This changed line introduces an unsafe operation.
- **Why it matters:** The affected behavior can fail when this path runs.
- **Fix:** Correct the flagged operation before using this change.
- **Source:** checkov:CKV\_K8S\_16

### 9. Major maintainability: Planted problem number 6

- **Where:** deploy/deployment.yaml:43
- **Problem:** This changed line introduces an unsafe operation.
- **Why it matters:** The affected behavior can fail when this path runs.
- **Fix:** Correct the flagged operation before using this change.
- **Source:** kube-linter:privilege-escalation-container

### 10. Major maintainability: Planted problem number 6

- **Where:** deploy/deployment.yaml:43
- **Problem:** This changed line introduces an unsafe operation.
- **Why it matters:** The affected behavior can fail when this path runs.
- **Fix:** Correct the flagged operation before using this change.
- **Source:** checkov:CKV\_K8S\_20

### 11. Major maintainability: Planted problem number 7

- **Where:** scripts/deploy.sh:11
- **Problem:** This changed line introduces an unsafe operation.
- **Why it matters:** The affected behavior can fail when this path runs.
- **Fix:** Correct the flagged operation before using this change.
- **Source:** shellcheck:SC2045

### 12. Major maintainability: Planted problem number 7

- **Where:** scripts/deploy.sh:11
- **Problem:** This changed line introduces an unsafe operation.
- **Why it matters:** The affected behavior can fail when this path runs.
- **Fix:** Correct the flagged operation before using this change.
- **Source:** shellcheck:SC2086

### 13. Major bug: Planted vulnerable-lodash problem

- **Where:** package-lock.json:11
- **Problem:** This changed line introduces an unsafe operation.
- **Why it matters:** The affected behavior can fail when this path runs.
- **Fix:** Correct the operation before using this change.
- **Source:** the reviewer

### 14. Major bug: Planted pagination-off-by-one problem

- **Where:** app/server.py:23
- **Problem:** This changed line introduces an unsafe operation.
- **Why it matters:** The affected behavior can fail when this path runs.
- **Fix:** Correct the operation before using this change.
- **Source:** the reviewer

### 15. Minor maintainability: Planted problem number 9

- **Where:** Dockerfile:1
- **Problem:** This changed line introduces an unsafe operation.
- **Why it matters:** The affected behavior can fail when this path runs.
- **Fix:** Correct the flagged operation before using this change.
- **Source:** hadolint:DL3007

### 16. Minor maintainability: Planted problem number 10

- **Where:** Dockerfile:3
- **Problem:** This changed line introduces an unsafe operation.
- **Why it matters:** The affected behavior can fail when this path runs.
- **Fix:** Correct the flagged operation before using this change.
- **Source:** hadolint:DL3008

### 17. Minor maintainability: Planted problem number 10

- **Where:** Dockerfile:3
- **Problem:** This changed line introduces an unsafe operation.
- **Why it matters:** The affected behavior can fail when this path runs.
- **Fix:** Correct the flagged operation before using this change.
- **Source:** hadolint:DL3014

### 18. Minor maintainability: Planted problem number 10

- **Where:** Dockerfile:3
- **Problem:** This changed line introduces an unsafe operation.
- **Why it matters:** The affected behavior can fail when this path runs.
- **Fix:** Correct the flagged operation before using this change.
- **Source:** hadolint:DL3009

### 19. Minor maintainability: Planted problem number 10

- **Where:** Dockerfile:3
- **Problem:** This changed line introduces an unsafe operation.
- **Why it matters:** The affected behavior can fail when this path runs.
- **Fix:** Correct the flagged operation before using this change.
- **Source:** hadolint:DL3015

### 20. Minor maintainability: Planted problem number 12

- **Where:** Dockerfile:7
- **Problem:** This changed line introduces an unsafe operation.
- **Why it matters:** The affected behavior can fail when this path runs.
- **Fix:** Correct the flagged operation before using this change.
- **Source:** hadolint:DL3042

### 21. Minor maintainability: Planted problem number 16

- **Where:** scripts/deploy.sh:7
- **Problem:** This changed line introduces an unsafe operation.
- **Why it matters:** The affected behavior can fail when this path runs.
- **Fix:** Correct the flagged operation before using this change.
- **Source:** shellcheck:SC2115

### 22. Minor maintainability: Planted problem number 16

- **Where:** scripts/deploy.sh:7
- **Problem:** This changed line introduces an unsafe operation.
- **Why it matters:** The affected behavior can fail when this path runs.
- **Fix:** Correct the flagged operation before using this change.
- **Source:** shellcheck:SC2086

### 23. Minor maintainability: Planted problem number 8

- **Where:** db/migrations/002\_index\_item\_names.sql:2
- **Problem:** This changed line introduces an unsafe operation.
- **Why it matters:** The affected behavior can fail when this path runs.
- **Fix:** Correct the flagged operation before using this change.
- **Source:** squawk:require-concurrent-index-creation

### 24. Minor maintainability: Planted problem number 8

- **Where:** db/migrations/002\_index\_item\_names.sql:2
- **Problem:** This changed line introduces an unsafe operation.
- **Why it matters:** The affected behavior can fail when this path runs.
- **Fix:** Correct the flagged operation before using this change.
- **Source:** squawk:prefer-robust-stmts

### 25. Minor maintainability: Planted problem number 8

- **Where:** db/migrations/002\_index\_item\_names.sql:2
- **Problem:** This changed line introduces an unsafe operation.
- **Why it matters:** The affected behavior can fail when this path runs.
- **Fix:** Correct the flagged operation before using this change.
- **Source:** squawk:require-lock-timeout

### 26. Minor maintainability: Planted problem number 8

- **Where:** db/migrations/002\_index\_item\_names.sql:2
- **Problem:** This changed line introduces an unsafe operation.
- **Why it matters:** The affected behavior can fail when this path runs.
- **Fix:** Correct the flagged operation before using this change.
- **Source:** squawk:require-statement-timeout

### 27. Minor security: Planted problem number 17

- **Where:** app/search.py:14
- **Problem:** This changed line introduces an unsafe operation.
- **Why it matters:** The affected behavior can fail when this path runs.
- **Fix:** Correct the flagged operation before using this change.
- **Source:** bandit:B608

## Coverage

- **Files the reviewer opened:** app/server.py
- **Files not opened (their changed lines were in the brief):** .github/workflows/ci.yml, Dockerfile, app/config.py, app/search.py, db/migrations/002\_index\_item\_names.sql, deploy/deployment.yaml, infra/main.tf, package-lock.json, package.json, scripts/deploy.sh
- **Changed ranges given to the reviewer:** 18 of 18

.github/workflows/ci.yml: 16-17 brief

Dockerfile: 1 brief, 3 brief, 5-7 brief, 9-10 \(deletion Dockerfile\#0, old lines 10-10\) brief

app/config.py: 1-3 brief

app/search.py: 1-17 brief

app/server.py: 5-6 brief, 8 brief, 23 brief

db/migrations/002\_index\_item\_names.sql: 1-2 brief

deploy/deployment.yaml: 41-43 brief

infra/main.tf: 27-28 brief

package-lock.json: 11 brief, 15-17 brief

package.json: 7 brief

scripts/deploy.sh: 7 brief, 11 brief

Scanners: 15 scanners ran, 5 had nothing to check

Reviewer: claude 2.1.289, <SECONDS> s, 13 turns, 12 correction rounds, $0.13

Made by Qodex: review on every pull request at https://qodex.ai
