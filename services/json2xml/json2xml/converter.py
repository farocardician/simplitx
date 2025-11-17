"""Core JSON to XML conversion logic."""

import ast
import json
import operator
from decimal import Decimal
from typing import Any, Dict, List, Optional, Union
from lxml import etree
from .formatting import format_decimal
from .mapping import resolve_mapping_placeholders
from .party_resolver import get_buyer_field
from .uom_resolver import resolve_uom


class ConversionError(Exception):
    """Raised when JSON to XML conversion fails."""
    pass


ALLOWED_BINARY_OPERATORS = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.Mod: operator.mod,
    ast.Pow: operator.pow,
}

ALLOWED_UNARY_OPERATORS = {
    ast.UAdd: operator.pos,
    ast.USub: operator.neg,
}

SAFE_FUNCTIONS = {
    "str": str,
    "float": float,
    "int": int,
    "round": round,
    "Decimal": Decimal,
    "abs": abs,
}


def parse_jsonpath(path: str, data: Any) -> Any:
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


def _evaluate_expression(expression: str, context: Dict[str, Any]) -> Any:
    """Safely evaluate a limited arithmetic/string expression."""
    try:
        parsed = ast.parse(expression, mode="eval")
    except SyntaxError as exc:
        raise ConversionError(f"Invalid expression '{expression}': {exc}") from exc

    def _eval(node: ast.AST) -> Any:
        if isinstance(node, ast.Expression):
            return _eval(node.body)
        if isinstance(node, ast.Constant):
            return node.value
        if isinstance(node, ast.Num):  # pragma: no cover - legacy for <3.8 ast
            return node.n
        if isinstance(node, ast.BinOp):
            op_type = type(node.op)
            if op_type not in ALLOWED_BINARY_OPERATORS:
                raise ConversionError(f"Unsupported binary operator: {ast.dump(node.op)}")
            left = _eval(node.left)
            right = _eval(node.right)
            return ALLOWED_BINARY_OPERATORS[op_type](left, right)
        if isinstance(node, ast.UnaryOp):
            op_type = type(node.op)
            if op_type not in ALLOWED_UNARY_OPERATORS:
                raise ConversionError(f"Unsupported unary operator: {ast.dump(node.op)}")
            operand = _eval(node.operand)
            return ALLOWED_UNARY_OPERATORS[op_type](operand)
        if isinstance(node, ast.Name):
            if node.id in context:
                return context[node.id]
            if node.id in SAFE_FUNCTIONS:
                return SAFE_FUNCTIONS[node.id]
            raise ConversionError(f"Unknown identifier '{node.id}' in expression '{expression}'")
        if isinstance(node, ast.Call):
            func = _eval(node.func)
            if func not in SAFE_FUNCTIONS.values():
                raise ConversionError(f"Unsupported function call in expression '{expression}'")
            args = [_eval(arg) for arg in node.args]
            kwargs = {kw.arg: _eval(kw.value) for kw in node.keywords}
            return func(*args, **kwargs)
        raise ConversionError(f"Unsupported expression component: {ast.dump(node)}")

    return _eval(parsed)


def _resolve_input_spec(
    spec: Any,
    current_data: Any,
    root_data: Any,
    field_value: Any
) -> Any:
    """Resolve an input specification for computations."""
    if isinstance(spec, dict):
        source = spec.get("source")
        if source == "field":
            return field_value
        if "value" in spec:
            return spec["value"]
        context = spec.get("context", "current")
        target = root_data if context == "root" else current_data
        if "path" in spec:
            return parse_jsonpath(spec["path"], target)
    elif isinstance(spec, str):
        if spec == "field":
            return field_value
        if spec.startswith("$"):
            return parse_jsonpath(spec, current_data)
    return spec


def compute_field_value(
    field_config: Dict[str, Any],
    current_data: Dict[str, Any],
    root_data: Dict[str, Any],
    computations: Dict[str, Any]
) -> str:
    """Compute a derived field value using mapping-provided instructions."""

    computation_name = field_config.get("compute")
    if not computation_name:
        raise ConversionError("Field configuration missing 'compute' key")

    computation = computations.get(computation_name)
    if computation is None:
        raise ConversionError(f"Unknown computation '{computation_name}'")

    # Check for builtin function (special handling for party resolution, etc.)
    builtin = computation.get("builtin")
    if builtin:
        if builtin == "resolve_buyer_field":
            # Special handling for buyer party resolution
            # Extract buyer_name from path
            if "path" in field_config:
                buyer_name = parse_jsonpath(field_config["path"], current_data)
            elif "value" in field_config:
                buyer_name = field_config["value"]
            else:
                buyer_name = None

            if not buyer_name:
                return ""

            # Get field name from parameters
            field_name = field_config.get("parameters", {}).get("field") or computation.get("parameters", {}).get("field")
            if not field_name:
                raise ConversionError(f"resolve_buyer_field requires 'field' parameter")

            try:
                result = get_buyer_field(str(buyer_name), field_name)
                return result or ""
            except Exception as exc:
                raise ConversionError(f"Buyer field resolution failed: {exc}") from exc
        elif builtin == "resolve_uom":
            # Special handling for UOM resolution (name/alias to canonical code)
            # Extract UOM value from path
            if "path" in field_config:
                uom_input = parse_jsonpath(field_config["path"], current_data)
            elif "value" in field_config:
                uom_input = field_config["value"]
            else:
                uom_input = None

            if not uom_input:
                return ""

            try:
                resolved_code = resolve_uom(str(uom_input))
                # Return resolved code if found, otherwise return original (fallback)
                return resolved_code or str(uom_input)
            except Exception as exc:
                # Log warning but don't fail conversion
                print(f"Warning: UOM resolution failed for '{uom_input}': {exc}")
                return str(uom_input)
        else:
            raise ConversionError(f"Unknown builtin function '{builtin}'")

    # Determine base field value (from path or literal)
    if "path" in field_config:
        field_value = parse_jsonpath(field_config["path"], current_data)
    elif "value" in field_config:
        field_value = field_config["value"]
    else:
        field_value = None

    context: Dict[str, Any] = {}

    # Merge computation-level inputs with field-level overrides
    comp_inputs = computation.get("inputs", {})
    field_inputs = field_config.get("inputs", {})
    for key in set(comp_inputs.keys()) | set(field_inputs.keys()):
        if key in field_inputs:
            spec = field_inputs[key]
        else:
            spec = comp_inputs[key]
        context[key] = _resolve_input_spec(spec, current_data, root_data, field_value)

    if "value" not in context and field_value is not None:
        context["value"] = field_value

    # Add parameters (constants)
    for params_source in (computation.get("parameters", {}), field_config.get("parameters", {})):
        if params_source:
            context.update(params_source)

    expression = computation.get("expression")
    if not expression:
        # For builtin functions, expression is not required
        if not computation.get("builtin"):
            raise ConversionError(f"Computation '{computation_name}' missing expression definition")
        return ""

    try:
        result = _evaluate_expression(expression, context)
    except ConversionError as exc:
        raise ConversionError(f"Computation '{computation_name}' failed: {exc}") from exc

    if result is None:
        return ""

    format_cfg = field_config.get("format") or computation.get("format")
    if format_cfg:
        return format_field_value(result, format_cfg)
    return str(result)


def _is_field_definition(value: Dict[str, Any]) -> bool:
    field_keys = {"path", "value", "compute", "format", "inputs", "parameters"}
    return any(key in value for key in field_keys)


def process_structure(
    structure: Union[str, Dict[str, Any], List[Any]], 
    parent: etree.Element, 
    data: Dict[str, Any],
    root_data: Dict[str, Any],
    computations: Dict[str, Any]
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
                continue

            if isinstance(value, dict) and "_array" in value:
                array_spec = value["_array"]
                array_data = _resolve_input_spec(array_spec, data, root_data, None)

                if array_data and isinstance(array_data, list):
                    container = etree.SubElement(parent, key)

                    item_structure = None
                    item_tag = None
                    for item_key, item_value in value.items():
                        if item_key != "_array":
                            item_tag = item_key
                            item_structure = item_value
                            break

                    if item_structure and item_tag:
                        for item_data in array_data:
                            item_element = etree.SubElement(container, item_tag)
                            process_structure(item_structure, item_element, item_data, root_data, computations)
                continue

            if isinstance(value, dict) and _is_field_definition(value):
                child = etree.SubElement(parent, key)
                if value.get("compute"):
                    child.text = compute_field_value(value, data, root_data, computations)
                else:
                    if "path" in value:
                        raw_value = parse_jsonpath(value["path"], data)
                    elif "value" in value:
                        raw_value = value["value"]
                    else:
                        raw_value = None
                    if value.get("format"):
                        child.text = format_field_value(raw_value, value.get("format"))
                    else:
                        child.text = "" if raw_value is None else str(raw_value)
                continue

            if isinstance(value, dict):
                child = etree.SubElement(parent, key)
                process_structure(value, child, data, root_data, computations)
            else:
                child = etree.SubElement(parent, key)
                if isinstance(value, str) and value.startswith('$'):
                    resolved = parse_jsonpath(value, data)
                    child.text = "" if resolved is None else str(resolved)
                else:
                    child.text = "" if value is None else str(value)


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
    process_structure(structure, root_element, data, data, computations)
    
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
