---
"openqodex": minor
---

`openqodex init --agent goose` now sets up Goose: it adds a review line to Goose's hints file and an openqodex skill in Goose's own folders, and `init` finds Goose by its config folder (`~/.config/goose`, or under `XDG_CONFIG_HOME` when that is set).
