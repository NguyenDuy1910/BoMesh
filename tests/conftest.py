"""Suite-wide test environment."""

import os

# Tests that enter the FastAPI lifespan must not start sandbox containers in
# the developer's Docker; sandbox tests build their own DockerSandbox.
os.environ.setdefault("BOMESH_SANDBOX_ENABLED", "false")
