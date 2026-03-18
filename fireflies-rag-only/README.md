# Fireflies RAG Only

Minimal local app that provides only:

- Fireflies transcript sync
- Local RAG retrieval/query
- Small web UI

## Privacy Lockdown

To force strict on-device behavior (no outbound HTTP/S except optional Fireflies pull, and no cloud model fallback):

```bash
LOCAL_ONLY_MODE=1
ALLOW_FIREFLIES_PULL=0
TRANSFORMERS_OFFLINE=1
HF_HUB_OFFLINE=1
HF_DATASETS_OFFLINE=1
HF_HUB_DISABLE_TELEMETRY=1
OPENAI_API_KEY=
FIREFLIES_API_KEY=
```

With `LOCAL_ONLY_MODE=1`, the app blocks non-local HTTP(S) at runtime.
Set `ALLOW_FIREFLIES_PULL=1` to allow outbound requests only to `https://api.fireflies.ai/graphql` for inbound sync.
Set `ALLOW_MICROSOFT_TODO_SYNC=1` to also allow Microsoft To-Do OAuth/Graph endpoints for todo sync.
You can still query already-synced local data.

macOS OS firewall hardening (root required):

```bash
sudo APP_USER=firefliesrag bash scripts/create_fireflies_app_user_macos.sh
sudo APP_USER=firefliesrag bash scripts/run_fireflies_rag_as_user_macos.sh
sudo TARGET_USER=firefliesrag ALLOW_FIREFLIES_PULL=1 bash scripts/enable_local_only_firewall_macos.sh
sudo TARGET_UID=$(id -u firefliesrag) bash scripts/status_local_only_firewall_macos.sh
# rollback:
sudo TARGET_USER=firefliesrag bash scripts/disable_local_only_firewall_macos.sh
sudo APP_USER=firefliesrag bash scripts/stop_fireflies_rag_as_user_macos.sh
```

Note: with this flow, PF rules apply to the dedicated `firefliesrag` user only (app-only isolation), not your normal login account.
`ALLOW_FIREFLIES_PULL=1` allows DNS + `api.fireflies.ai:443` and blocks other non-loopback outbound traffic for that app user.

## Run

Background:

```bash
bash scripts/run_fireflies_rag.sh
```

Foreground:

```bash
cp fireflies-rag-only/.env.example fireflies-rag-only/.env
# edit FIREFLIES_API_KEY
bash scripts/run_fireflies_rag_only.sh
```

Open:

- `http://127.0.0.1:8788`

## Local LLM (Ollama)

Install runtime:

```bash
bash scripts/install_local_ollama.sh
```

Start/stop/status:

```bash
bash scripts/run_local_ollama_bg.sh
bash scripts/status_local_ollama_bg.sh
bash scripts/stop_local_ollama_bg.sh
```

Model pull (optional, first-time only):

```bash
OLLAMA_PULL_MODEL=1 bash scripts/run_local_ollama_bg.sh
```

If your network blocks Ollama registry blob downloads, bootstrap from local GGUF instead:

```bash
mkdir -p .local/models
curl -L -o .local/models/qwen2.5-3b-instruct-q4_k_m.gguf \
  "https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf"
bash scripts/create_local_ollama_model.sh fireflies-local .local/models/qwen2.5-3b-instruct-q4_k_m.gguf
```

Reasoning config is in `fireflies-rag-only/.env`:

- `RAG_REASONING_PROVIDER=ollama`
- `OLLAMA_BASE_URL=http://127.0.0.1:11434`
- `RAG_REASONING_MODEL=fireflies-local:latest`
- `OLLAMA_MODEL=fireflies-local:latest`
- `OLLAMA_FALLBACK_TO_OPENAI=0`
- `OLLAMA_NO_CLOUD=1`
- `OLLAMA_REGISTRY_MAXSTREAMS=1`
- `OLLAMA_NUM_CTX=8192`
- `OLLAMA_TOP_P=0.9`
- `OLLAMA_TOP_K=40`
- `OLLAMA_REPEAT_PENALTY=1.15`
- `OLLAMA_REPEAT_LAST_N=128`

Sync behavior:
- Default sync uses `limit=0` (unlimited catch-up).
- UI includes "Catch Up All Missing" and shows last refresh + corpus depth/scale metrics.
- Last refresh falls back to last sync attempt time when the most recent run failed.
- Raw JSON status dump is hidden from the UI.
- Fireflies-native summary/task fields are pulled and stored when transcript details are fetched.
- Summary/action-item chunks are indexed for better follow-up and task questions.
- If embedding dimensions changed (for example after switching embedding providers/models), sync auto-repairs the Fireflies vector index and re-runs full catch-up.

TLS note:
- If sync fails with `SELF_SIGNED_CERT_IN_CHAIN`, set `FIREFLIES_ALLOW_INSECURE_TLS=1` in `fireflies-rag-only/.env` and restart.

Rate-limit note:
- If Fireflies quota is hit, sync now reports `fireflies_rate_limited` with a concrete `retryAt` timestamp.
