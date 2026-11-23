"""REQUIRE_NUMPY=1 (set by CI) turns a missing numpy/PIL into a collection failure instead of a silent skip, so the
beauty/overrides tests cannot quietly stop running."""
import os
if os.environ.get("REQUIRE_NUMPY") == "1":
    import numpy, PIL  # noqa: F401  (ImportError here fails the run)
