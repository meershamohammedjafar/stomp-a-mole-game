"""Make the project root importable, as it is when the game runs with ``python -m stomp_the_mole``."""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
