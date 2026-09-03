# Mnemosyne memory sidecar.
#
# A small Python image that runs mnemosyne-oss over its MCP "streamable HTTP"
# transport, which the Next.js app calls from app/lib/ai/mnemosyne.ts. The
# `[all]` extra pulls in the vector-search stack (sqlite-vec + a local embedding
# model) and the MCP server dependencies (starlette + uvicorn).
#
# The default embedding model (BAAI/bge-small-en-v1.5) is fetched on first use;
# point MNEMOSYNE_EMBEDDING_API_URL at an OpenAI-compatible endpoint to embed
# remotely instead.
FROM python:3.12-slim

# Pin at build time so the sidecar image is reproducible; bump deliberately.
ARG MNEMOSYNE_VERSION=""
RUN pip install --no-cache-dir "mnemosyne-memory[all]${MNEMOSYNE_VERSION:+==${MNEMOSYNE_VERSION}}"

# The SQLite store (one file, per-bank rows) lives here; mount a volume on it.
ENV MNEMOSYNE_DATA_DIR=/data
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
