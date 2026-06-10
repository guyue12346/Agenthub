FROM node:25-bookworm-slim

WORKDIR /workspace
ARG INSTALL_CODEX_COMMAND="npm install -g @openai/codex"
ARG INSTALL_OPENCODE_COMMAND="npm install -g opencode-ai"
RUN apt-get update \
  && apt-get install -y --no-install-recommends bash git ca-certificates curl ripgrep \
  && rm -rf /var/lib/apt/lists/*
RUN if [ -n "$INSTALL_CODEX_COMMAND" ]; then sh -lc "$INSTALL_CODEX_COMMAND"; fi \
  && if [ -n "$INSTALL_OPENCODE_COMMAND" ]; then sh -lc "$INSTALL_OPENCODE_COMMAND"; fi
RUN mkdir -p /workspace /runner-home/.codex /runner-home/.config /runner-home/.cache /runner-home/.local/share /runner-home/.local/state \
  && chmod -R 0777 /workspace /runner-home

ENV NODE_ENV=production
ENV HOME=/runner-home
ENV CODEX_HOME=/runner-home/.codex
ENV XDG_CONFIG_HOME=/runner-home/.config
ENV XDG_CACHE_HOME=/runner-home/.cache
ENV XDG_DATA_HOME=/runner-home/.local/share
ENV XDG_STATE_HOME=/runner-home/.local/state
ENV PATH="/runner-home/.opencode/bin:/root/.opencode/bin:/usr/local/bin:${PATH}"
CMD ["bash"]
