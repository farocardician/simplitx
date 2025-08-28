"""Decimal formatting utilities for deterministic output."""

from decimal import Decimal, ROUND_HALF_UP, Context


def create_decimal_context(scale: int = 2) -> Context:
    """Create decimal context with ROUND_HALF_UP for deterministic formatting."""
    return Context(
        prec=28,  # High precision for intermediate calculations
        rounding=ROUND_HALF_UP,
        traps=[]
    )


def format_decimal(value, scale: int = 2) -> str:
    """Format decimal value with specified scale using ROUND_HALF_UP."""
    if value is None:
        return ""
    
    ctx = create_decimal_context(scale)
    decimal_val = ctx.create_decimal(str(value))
    
    # Round to specified decimal places
    quantizer = Decimal('0.1') ** scale if scale > 0 else Decimal('1')
    formatted = decimal_val.quantize(quantizer, context=ctx)
    
    # Convert to string, ensuring no scientific notation
    return str(formatted)


def format_currency(value, scale: int = 2) -> str:
    """Format currency value - same as decimal but explicit naming."""
    return format_decimal(value, scale)