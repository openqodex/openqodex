---
"openqodex": patch
---

- Scanner candidates now get the same ids on every run and every machine. They are ordered by severity, then scanner, file, line, rule and message, whatever order a scanner printed its findings in. Before, Checkov on Linux printed its Terraform, CloudFormation and Kubernetes results in the order they finished, so one change could number its candidates differently from run to run. The numbering of candidates with the same severity changes once with this release.
