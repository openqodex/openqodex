# The outside benchmark's image: openqodex at one exact version, installed as
# users install it, with every built-in scanner in /opt/openqodex/tools,
# each proved by its check case, and the Claude Code it reviews with. Its
# entrypoint is the ReviewBench adapter (reviewbench/entry.mjs). A review
# reaches the model's host, and semgrep and osv-scanner fetch their rules and
# advisories from theirs; any other host may be refused. linux/amd64 only.
# From the repository root:
#   docker build --platform linux/amd64 -f benchmark/outside/image/Dockerfile benchmark/outside
# image/check-build.sh builds it and checks that a build missing a runtime fails.
#
# WITH_GO, WITH_RUST and WITH_RUBY are 1; 0 leaves that runtime out, and the
# build then fails, naming the scanners that need it.

# node:22-bookworm, pinned by its index digest.
FROM node:22-bookworm@sha256:0e5f906573693feaa1e21057ebdcfdb5bd5021f050b2dc7c9deceb629c7da2a8

# The Go, Rust and scanner downloads below are amd64 builds.
RUN test "$(dpkg --print-architecture)" = amd64 || { echo "build this image with --platform linux/amd64" >&2; exit 1; }

# git reads the reviewed clones; xz and unzip unpack the scanner releases.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git xz-utils unzip \
 && rm -rf /var/lib/apt/lists/*

# ReviewBench mounts a clone owned by another user. Its contract marks it
# safe through GIT_CONFIG_* variables; this holds for a process that clears them.
RUN git config --system --add safe.directory '*'

WORKDIR /srv
COPY image/package.json image/package-lock.json ./
RUN npm ci --no-audit --no-fund && npm cache clean --force

# openqodex finds its scanners under OPENQODEX_HOME and never updates
# itself. Claude Code never updates itself and sends nothing but the review:
# the variables reach the processes the entrypoint starts, and the managed
# settings reach the reviewer, whose environment openqodex reduces to an
# allowlist.
ENV PATH=/srv/node_modules/.bin:$PATH \
    OPENQODEX_HOME=/opt/openqodex \
    OPENQODEX_AUTO_UPDATE=0 \
    DISABLE_AUTOUPDATER=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
RUN mkdir -p /etc/claude-code \
 && printf '%s\n' '{"env":{"DISABLE_AUTOUPDATER":"1","CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC":"1"}}' > /etc/claude-code/managed-settings.json \
 && claude --version

# Go for golangci: 1.26, the Go golangci-lint 2.12.2 is built with. The
# archive is checked against the sha256 go.dev publishes.
ARG WITH_GO=1
ARG GO_VERSION=1.26.9
ARG GO_SHA256=42d158b4d8f7b61ac0a830567c940a86098fb7aac52e467a5ebec03ef5cc2f8d
ENV PATH=/usr/local/go/bin:$PATH
RUN if [ "$WITH_GO" = 1 ]; then \
      curl -fsSLo /tmp/go.tar.gz "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" \
      && echo "${GO_SHA256}  /tmp/go.tar.gz" | sha256sum -c - \
      && tar -C /usr/local -xzf /tmp/go.tar.gz \
      && rm /tmp/go.tar.gz \
      && go version; \
    fi

# Rust for cargo-deny, which runs Cargo. rustup-init is checked against its
# published sha256; the toolchain is pinned by version. CARGO_HOME is also
# where a case's crates go before its review.
ARG WITH_RUST=1
ARG RUSTUP_VERSION=1.29.1
ARG RUSTUP_SHA256=dda7234360b7f578ca8b0ddcb80145646fa61a67c1720a5abc7051b35c9fcb71
ARG RUST_VERSION=1.98.0
ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo PATH=/usr/local/cargo/bin:$PATH
RUN if [ "$WITH_RUST" = 1 ]; then \
      curl -fsSLo /tmp/rustup-init "https://static.rust-lang.org/rustup/archive/${RUSTUP_VERSION}/x86_64-unknown-linux-gnu/rustup-init" \
      && echo "${RUSTUP_SHA256}  /tmp/rustup-init" | sha256sum -c - \
      && chmod +x /tmp/rustup-init \
      && /tmp/rustup-init -y --no-modify-path --profile minimal --default-toolchain "${RUST_VERSION}" \
      && rm /tmp/rustup-init \
      && cargo --version; \
    fi

# Ruby for brakeman and rubocop: Debian's Ruby 3.1, and ruby-dev to build
# the native parts of their gems.
ARG WITH_RUBY=1
RUN if [ "$WITH_RUBY" = 1 ]; then \
      apt-get update \
      && apt-get install -y --no-install-recommends ruby ruby-dev \
      && rm -rf /var/lib/apt/lists/* \
      && ruby --version; \
    fi

# Scanners are installed, and every review runs, as the base image's node
# user, never root. That user owns the install root and the Cargo home, where
# a case's crates go before its review. Go keeps a case's modules under
# /home/node/go; a review's scratch is under /tmp.
RUN mkdir -p /opt/openqodex /usr/local/cargo && chown node:node /opt/openqodex /usr/local/cargo
USER node

# Every built-in scanner installed and proved, as the node user a review
# runs as; the build fails, naming each scanner that is not ready. RubyGems
# keeps a copy of every gem archive in each gem install's cache folder; a
# gem never reads it once installed, so it goes in the same step.
COPY image/preinstall.mjs ./
RUN node preinstall.mjs \
 && find /opt/openqodex/tools -type f -path '*/cache/*.gem' -delete

# The entrypoint starts as root only to write the findings file into the
# folder ReviewBench mounts, which another user may own; it starts the
# review as the node user (reviewbench/entry.mjs).
COPY reviewbench/entry.mjs ./entry.mjs
USER root
ENTRYPOINT ["node", "/srv/entry.mjs"]
