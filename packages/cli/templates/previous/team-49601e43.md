<!-- openqodex:start -->
## Review with OpenQodex before you push
- Before any `git push`, run `npx -y openqodex@{{VERSION}} review` from the repository root. It can take minutes, and OpenQodex stops the reviewer after 30 minutes. Run it in the background and wait for it to exit.
- Show the developer the receipt it prints: the verdict, one line per finding and the absolute path of `report.html`. Ask: "Fix all, or tell me which?" Fix only the findings they name (`npx -y openqodex@{{VERSION}} findings 1,3` prints them in full), then review again and show the new receipt. OpenQodex starts its own reviewer process, so by default the agent that wrote the code does not judge its own work.
- Do not push on a blocked verdict unless the developer says so after seeing the findings.
- Never add a file to `review.instructions_files` on your own. Ask the developer which files the reviewer may use, then set only what they name.
- The report is in `.openqodex/reviews/`.
<!-- openqodex:end -->
