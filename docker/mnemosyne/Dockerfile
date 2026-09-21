# Mnemosyne memory sidecar.
#
# A small Python image that runs mnemosyne-oss over its MCP "streamable HTTP"
# transport, which the Next.js app calls from app/lib/ai/mnemosyne.ts.
#
# Why a pinned git commit and not a PyPI release: the streamable-HTTP transport
# (single /mcp route, --json-response) and the per-call `bank` argument this
# integration relies on live on `main` and are NOT in the latest release
# (3.15.1 only offers --transport stdio|sse). We pin an exact commit so the
# build stays reproducible; bump MNEMOSYNE_REF deliberately when adopting fixes.
#
# We install only the extras we use — `embeddings` (fastembed + onnxruntime +
# sqlite-vec, the semantic recall stack) and `mcp` (the server) — plus starlette
# and uvicorn for the HTTP transport. Deliberately NOT the `[all]`/`llm` extra:
# it pulls in llama-cpp-python (local LLM inference we never invoke), whose wheel
# must be compiled from C++ and fails on this compiler-less slim image. Every
# package below ships a prebuilt wheel, so no build toolchain is needed — only
# git, for the source install itself.
#
# The default embedding model (BAAI/bge-small-en-v1.5) is fetched on first use;
# point MNEMOSYNE_EMBEDDING_API_URL at an OpenAI-compatible endpoint to embed
# remotely instead.
FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

# Exact mnemosyne-oss commit on main that ships the streamable-HTTP transport.
ARG MNEMOSYNE_REF=8078a55c3648ff0bb1f4a355afb199796bc8fba4
RUN pip install --no-cache-dir \
      "mnemosyne-memory[embeddings,mcp] @ git+https://github.com/mnemosyne-oss/mnemosyne.git@${MNEMOSYNE_REF}" \
      "starlette" "uvicorn"

# The SQLite store (one file, per-bank rows) lives here; mount a volume on it.
ENV MNEMOSYNE_DATA_DIR=/data
ENV MNEMOSYNE_AUTO_SLEEP_ENABLED=false
RUN mkdir -p /data

EXPOSE 8787

# --json-response keeps replies plain JSON (no SSE framing), which is all the
# Node client needs. Binding 0.0.0.0 is a non-loopback bind, so the server
# fail-closes unless MNEMOSYNE_MCP_TOKEN and MNEMOSYNE_MCP_ALLOWED_HOSTS are
# set — both are supplied by docker-compose.
CMD ["mnemosyne", "mcp", \
     "--transport", "streamable-http", \
     "--host", "0.0.0.0", \
     "--port", "8787", \
     "--path", "/mcp", \
     "--json-response"]
