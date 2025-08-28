"""JSON to XML converter library."""

__version__ = "1.0.0"

from .converter import convert_json_to_xml
from .mapping import load_mapping

__all__ = ["convert_json_to_xml", "load_mapping"]