# ---- LLM provider: gemini | anthropic | openai ----
LLM_PROVIDER=nvidia
LLM_MODEL=nvidia/nemotron-3-super-120b-a12b
NVIDIA_API_KEY=key

# ---- Admin console login (change both) ----
ADMIN_USERNAME=admin
ADMIN_PASSWORD=jay

# ---- Timing (seconds) ----
BUFFER_WINDOW_SECONDS=20
DECISION_INTERVAL_SECONDS=20
FEEDBACK_WINDOW_SECONDS=30

# ---- Simulation size ----
NUM_REGIONS=5
SERVERS_PER_REGION=3
CHIPSETS_PER_SERVER=4

# ---- Agent thresholds ----
TEMP_THRESHOLD_C=68
UTIL_IMBALANCE_THRESHOLD=0.35
MIN_NET_PROFIT=0.0

# ---- Public /api/ask rate limit (per IP per minute) ----
ASK_RATE_LIMIT_PER_MINUTE=6