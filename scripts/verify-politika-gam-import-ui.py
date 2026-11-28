"""Compatibility entry for the shared GAM CSV workspace verifier."""
from pathlib import Path
import runpy
runpy.run_path(str(Path(__file__).with_name("verify-gam-csv-import-ui.py")),run_name="__main__")
