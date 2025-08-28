"""Core JSON to XML conversion logic."""

import json
import re
from typing import Any, Dict, List, Optional, Union
from lxml import etree
from .formatting import format_decimal
from .mapping import resolve_mapping_placeholders, MappingError


class ConversionError(Exception):
    """Raised when JSON to XML conversion fails."""
    pass


def parse_jsonpath(path: str, data: Dict[str, Any]) -> Any:
    """Simple JSONPath parser supporting basic selectors like $.field and $.array[*]."""
    if not path.startswith('$'):
        raise ConversionError(f"JSONPath must start with '$': {path}")
    
    # Remove leading '$.'
    path = path[1:]
    if path.startswith('.'):
        path = path[1:]
    
    if not path:
        return data
    
    current = data
    parts = path.split('.')
    
    for part in parts:
        if '[*]' in part:
            # Handle array access like "items[*]"
            field_name = part.replace('[*]', '')
            if field_name and field_name in current:
                current = current[field_name]
            if isinstance(current, list):
                return current
            else:
                raise ConversionError(f"Expected array at path {path}, got {type(current)}")
        else:
            if isinstance(current, dict) and part in current:
                current = current[part]
            else:
                return None
    
    return current


def format_field_value(value: Any, format_config: Optional[Dict[str, Any]] = None) -> str:
    """Format field value according to format configuration."""
    if value is None:
        return ""
    
    if format_config is None:
        return str(value)
    
    format_type = format_config.get('type', 'string')
    
    if format_type == 'decimal':
        scale = format_config.get('scale', 2)
        return format_decimal(value, scale)
    else:
        return str(value)


def compute_value(computation_name: str, value: Any, computations: Dict[str, str]) -> str:
    """Execute computed value transformation."""
    if computation_name not in computations:
        raise ConversionError(f"Unknown computation: {computation_name}")
    
    computation = computations[computation_name]
    
    # Simple built-in computations for invoice data
    if computation_name == "hs_code_to_full":
        return str(value) + "00"
    elif computation_name == "other_tax_base":
        return format_decimal(float(value) / 12 * 11, 2)
    elif computation_name == "vat_amount":
        return format_decimal(float(value) * 0.11, 2)
    else:
        # For safety, only allow predefined computations
        raise ConversionError(f"Unsupported computation: {computation_name}")


def process_structure(
    structure: Union[str, Dict[str, Any], List[Any]], 
    parent: etree.Element, 
    data: Dict[str, Any],
    computations: Dict[str, str]
) -> None:
    """Recursively process structure definition to build XML."""
    
    if isinstance(structure, str):
        # String value - could be literal or JSONPath
        if structure.startswith('$'):
            # JSONPath reference
            value = parse_jsonpath(structure, data)
            parent.text = str(value) if value is not None else ""
        else:
            # Literal value
            parent.text = structure
    
    elif isinstance(structure, dict):
        # Dictionary structure - process each key-value pair
        for key, value in structure.items():
            if key == "_array":
                # Special array processing indicator
                continue
            elif key == "_computed":
                # Special computed value indicator
                continue
            elif isinstance(value, dict) and "_array" in value:
                # This is an array container
                array_path = value["_array"]
                array_data = parse_jsonpath(array_path, data)
                
                if array_data and isinstance(array_data, list):
                    # Create container element
                    container = etree.SubElement(parent, key)
                    
                    # Find the item structure (should be the other key besides _array)
                    item_structure = None
                    item_tag = None
                    for item_key, item_value in value.items():
                        if item_key != "_array":
                            item_tag = item_key
                            item_structure = item_value
                            break
                    
                    if item_structure:
                        # Process each array item
                        for item_data in array_data:
                            item_element = etree.SubElement(container, item_tag)
                            process_structure(item_structure, item_element, item_data, computations)
            
            elif isinstance(value, dict) and ("_computed" in value or "format" in value or "path" in value):
                # Field with special processing
                child = etree.SubElement(parent, key)
                
                if "_computed" in value:
                    # Computed field
                    computation_name = value["_computed"]
                    source_path = value["path"]
                    source_value = parse_jsonpath(source_path, data)
                    computed_value = compute_value(computation_name, source_value, computations)
                    child.text = computed_value
                
                elif "path" in value:
                    # Field with JSONPath and optional formatting
                    field_path = value["path"]
                    format_config = value.get("format")
                    field_value = parse_jsonpath(field_path, data)
                    formatted_value = format_field_value(field_value, format_config)
                    child.text = formatted_value
                
                else:
                    # Regular field processing
                    process_structure(value, child, data, computations)
            
            elif isinstance(value, dict):
                # Nested structure
                child = etree.SubElement(parent, key)
                process_structure(value, child, data, computations)
            
            else:
                # Simple field
                child = etree.SubElement(parent, key)
                process_structure(value, child, data, computations)


def convert_json_to_xml(
    json_data: Union[str, Dict[str, Any]], 
    mapping: Dict[str, Any], 
    params: Optional[Dict[str, str]] = None,
    pretty: bool = False
) -> bytes:
    """Convert JSON to XML using mapping configuration."""
    
    # Parse JSON if string
    if isinstance(json_data, str):
        try:
            data = json.loads(json_data)
        except json.JSONDecodeError as e:
            raise ConversionError(f"Invalid JSON: {e}")
    else:
        data = json_data
    
    # Resolve placeholders in mapping
    resolved_mapping = resolve_mapping_placeholders(mapping, params)
    
    # Get root configuration
    root_config = resolved_mapping['root']
    root_tag = root_config['tag']
    root_nsmap = root_config.get('nsmap', {})
    
    # Create root element
    if root_nsmap:
        root_element = etree.Element(root_tag, nsmap=root_nsmap)
    else:
        root_element = etree.Element(root_tag)
    
    # Get structure definition and computations
    structure = resolved_mapping.get('structure', {})
    computations = resolved_mapping.get('computations', {})
    
    # Process structure
    process_structure(structure, root_element, data, computations)
    
    # Convert to bytes
    if pretty:
        etree.indent(root_element, space="  ")
        xml_bytes = etree.tostring(
            root_element, 
            encoding='utf-8', 
            xml_declaration=True, 
            pretty_print=True
        )
    else:
        xml_bytes = etree.tostring(
            root_element,
            encoding='utf-8',
            xml_declaration=True,
            pretty_print=False
        )
    
    return xml_bytes