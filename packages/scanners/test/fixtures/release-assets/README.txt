Asset name lists of the latest release of each repo, saved 2026-10-02 with:
  gh api repos/<owner>/<repo>/releases/latest --jq '{repo: "<owner>/<repo>", tag: .tag_name, assets: [.assets[].name]}'
Unchanged output. The asset matcher test reads only the names.

freebsd-tool.json is not a real release: it is a made up tool with a macOS, a
FreeBSD and a Linux asset, so the matcher can be proved on FreeBSD without
asking a network for anything.
