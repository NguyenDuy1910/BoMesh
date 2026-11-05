"""Suite-wide test environment."""

import os
import sys
from pathlib import Path

# Tests that enter the FastAPI lifespan must not start sandbox containers in
# the developer's Docker; sandbox tests build their own DockerSandbox.
os.environ.setdefault("BOMESH_SANDBOX_ENABLED", "false")
# The API harness modules (``fakes``, ``harness``) are importable from every test.
sys.path.insert(0, str(Path(__file__).resolve().parent / "v1"))
