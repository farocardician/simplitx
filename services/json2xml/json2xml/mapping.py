"""Mapping file loading and placeholder handling."""

import json
import os
import re
from typing import Any, Dict, List, Optional
from pathlib import Path


class MappingError(Exception):
    """Raised when mapping file is invalid or cannot be loaded."""
    pass


def load_mapping(mapping_path: str) -> Dict[str, Any]:
    """Load and validate mapping configuration from JSON file."""
    try:
        with open(mapping_path, 'r', encoding='utf-8') as f:
            mapping = json.load(f)
    except FileNotFoundError:
        raise MappingError(f"Mapping file not found: {mapping_path}")
    except json.JSONDecodeError as e:
        raise MappingError(f"Invalid JSON in mapping file {mapping_path}: {e}")
    
    # Validate required sections
    required_keys = ['root']
    for key in required_keys:
        if key not in mapping:
            raise MappingError(f"Missing required section '{key}' in mapping")
    
    if 'tag' not in mapping['root']:
        raise MappingError("Missing 'tag' in root section")
    
    # Must have either 'fields' (old format) or 'structure' (new format)
    if 'fields' not in mapping and 'structure' not in mapping:
        raise MappingError("Mapping must have either 'fields' or 'structure' section")

    computations = mapping.get('computations')
    if computations is not None:
        if not isinstance(computations, dict):
            raise MappingError("'computations' section must be an object")
        for name, definition in computations.items():
            if not isinstance(definition, dict):
                raise MappingError(f"Computation '{name}' must be an object")
            expression = definition.get('expression')
            if not isinstance(expression, str) or not expression.strip():
                raise MappingError(f"Computation '{name}' must define a non-empty 'expression'")
    
    return mapping


def resolve_placeholders(text: str, params: Optional[Dict[str, str]] = None) -> str:
    """Resolve placeholder values in format {NAME|DEFAULT}."""
    if not isinstance(text, str):
        return text
    
    params = params or {}
    
    # Pattern matches {NAME|DEFAULT}
    pattern = r'\{([^}|]+)\|([^}]*)\}'
    
    def replace_placeholder(match):
        name = match.group(1)
        default = match.group(2)
        
        # Check CLI params first, then environment, then default
        if name in params:
            return params[name]
        elif name in os.environ:
            return os.environ[name]
        else:
            return default
    
    return re.sub(pattern, replace_placeholder, text)


def resolve_mapping_placeholders(mapping: Dict[str, Any], params: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    """Recursively resolve all placeholders in mapping configuration."""
    if isinstance(mapping, dict):
        return {k: resolve_mapping_placeholders(v, params) for k, v in mapping.items()}
    elif isinstance(mapping, list):
        return [resolve_mapping_placeholders(item, params) for item in mapping]
    elif isinstance(mapping, str):
        return resolve_placeholders(mapping, params)
    else:
        return mapping
