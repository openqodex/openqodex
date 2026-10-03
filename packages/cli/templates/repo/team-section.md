<!-- openqodex:start -->
## Review with OpenQodex before you push
- Before any `git push`, run `npx -y openqodex@{{VERSION}} review --agent` from the repository root and follow the brief it prints to the end, including the finalize command it names.
- Run that review in a separate subagent when your agent has one: the agent that wrote the code does not judge its own work.
- Do not push on a blocked verdict unless the developer says so after seeing the findings.
- The report is in `.openqodex/reviews/`.
<!-- openqodex:end -->
