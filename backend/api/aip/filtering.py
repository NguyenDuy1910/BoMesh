"""AIP-160 filtering: parse a filter into an AST, compile it to SQLAlchemy.

Supported subset:

- comparisons ``= != < <= > >=`` and the has operator ``:`` on repeated fields;
- ``AND``, ``OR``, ``NOT``, ``-`` and parentheses (``OR`` binds tighter than
  ``AND``, and juxtaposed terms are ANDed, as in AIP-160);
- string (quoted), number, ``true``/``false``, ``null`` and RFC 3339 timestamp
  literals; bare words such as enum values; dotted field paths.

Each List method declares a :class:`FilterSchema` naming the fields it accepts.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Iterable, Iterator, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import Enum, StrEnum
from typing import Any

from sqlalchemy import ColumnElement, any_, literal, true
from sqlalchemy import and_ as sql_and
from sqlalchemy import not_ as sql_not
from sqlalchemy import or_ as sql_or

from bomesh.errors import FieldViolation, InvalidArgument

from .messages import INT64_MAX, INT64_MIN

MAX_FILTER_LENGTH = 4096
MAX_NESTING = 32

_FIELD_PATH = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$")
_INTEGER = re.compile(r"^-?\d+$")
_TOKEN = re.compile(
    r"""
    (?P<ws>\s+)
    | (?P<string>"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')
    | (?P<op><=|>=|!=|=|<|>|:)
    | (?P<lparen>\()
    | (?P<rparen>\))
    | (?P<minus>-)
    | (?P<word>[A-Za-z0-9_][A-Za-z0-9_.\-]*)
    """,
    re.VERBOSE,
)
_KEYWORDS = frozenset({"AND", "OR", "NOT"})


class Operator(StrEnum):
    EQ = "="
    NE = "!="
    LT = "<"
    LE = "<="
    GT = ">"
    GE = ">="
    HAS = ":"


_ORDERING = frozenset({Operator.LT, Operator.LE, Operator.GT, Operator.GE})
_EQUALITY = frozenset({Operator.EQ, Operator.NE})


# --- AST -------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Value:
    """A literal as written; its type is decided by the field it is compared with."""

    text: str
    quoted: bool

    @property
    def is_null(self) -> bool:
        return not self.quoted and self.text == "null"


@dataclass(frozen=True, slots=True)
class Restriction:
    field: str
    operator: Operator
    value: Value


@dataclass(frozen=True, slots=True)
class And:
    operands: tuple[Node, ...]


@dataclass(frozen=True, slots=True)
class Or:
    operands: tuple[Node, ...]


@dataclass(frozen=True, slots=True)
class Not:
    operand: Node


type Node = Restriction | And | Or | Not


def restrictions(node: Node | None) -> Iterator[Restriction]:
    """Every comparison in ``node``, e.g. to authorize the resource names a filter names."""
    if node is None:
        return
    if isinstance(node, Restriction):
        yield node
    elif isinstance(node, Not):
        yield from restrictions(node.operand)
    else:
        for operand in node.operands:
            yield from restrictions(operand)


# --- Parsing ---------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class _Token:
    kind: str
    text: str
    position: int


def parse(text: str | None, *, field: str = "filter") -> Node | None:
    """The AST of ``text``, or ``None`` for an empty filter."""
    if text is None or not text.strip():
        return None
    if len(text) > MAX_FILTER_LENGTH:
        raise filter_error(
            f"filter is longer than {MAX_FILTER_LENGTH} characters", field
        )
    return _Parser(_tokenize(text, field), field).parse()


def _tokenize(text: str, field: str) -> list[_Token]:
    tokens: list[_Token] = []
    position = 0
    while position < len(text):
        match = _TOKEN.match(text, position)
        if match is None:
            raise filter_error(
                f"unexpected character {text[position]!r} at {position}", field
            )
        kind = match.lastgroup
        assert kind is not None
        if kind != "ws":
            token_text = match.group()
            if kind == "word" and token_text in _KEYWORDS:
                kind = token_text
            tokens.append(_Token(kind, token_text, position))
        position = match.end()
    tokens.append(_Token("end", "", len(text)))
    return tokens


class _Parser:
    def __init__(self, tokens: list[_Token], field: str) -> None:
        self._tokens = tokens
        self._index = 0
        self._depth = 0
        self._field = field

    def parse(self) -> Node:
        node = self._expression()
        if self._peek().kind != "end":
            raise self._unexpected()
        return node

    # expression := sequence { AND sequence }
    def _expression(self) -> Node:
        operands = [self._sequence()]
        while self._accept("AND"):
            operands.append(self._sequence())
        return operands[0] if len(operands) == 1 else And(tuple(operands))

    # sequence := factor { factor }   (implicit AND)
    def _sequence(self) -> Node:
        operands = [self._factor()]
        while self._peek().kind in {"word", "string", "lparen", "minus", "NOT"}:
            operands.append(self._factor())
        return operands[0] if len(operands) == 1 else And(tuple(operands))

    # factor := term { OR term }
    def _factor(self) -> Node:
        operands = [self._term()]
        while self._accept("OR"):
            operands.append(self._term())
        return operands[0] if len(operands) == 1 else Or(tuple(operands))

    # term := [ NOT | "-" ] simple
    def _term(self) -> Node:
        if self._accept("NOT") or self._accept("minus"):
            return Not(self._simple())
        return self._simple()

    # simple := "(" expression ")" | restriction
    def _simple(self) -> Node:
        if self._accept("lparen"):
            self._depth += 1
            if self._depth > MAX_NESTING:
                raise filter_error(
                    f"filter nests deeper than {MAX_NESTING} levels", self._field
                )
            node = self._expression()
            if not self._accept("rparen"):
                raise self._unexpected()
            self._depth -= 1
            return node
        return self._restriction()

    # restriction := field comparator value
    def _restriction(self) -> Node:
        token = self._next()
        if token.kind != "word" or not _FIELD_PATH.match(token.text):
            raise self._unexpected(token)
        operator_token = self._next()
        if operator_token.kind != "op":
            raise filter_error(
                f"expected a comparison after {token.text!r} at {token.position}; "
                "free-text filters are not supported",
                self._field,
            )
        return Restriction(token.text, Operator(operator_token.text), self._value())

    def _value(self) -> Value:
        token = self._next()
        if token.kind == "string":
            return Value(_unquote(token.text), quoted=True)
        if token.kind == "word":
            return Value(token.text, quoted=False)
        if token.kind == "minus":
            number = self._next()
            if (
                number.kind == "word"
                and _INTEGER.match(number.text)
                and number.position == token.position + 1
            ):
                return Value(f"-{number.text}", quoted=False)
            raise self._unexpected(number)
        raise self._unexpected(token)

    def _peek(self) -> _Token:
        return self._tokens[self._index]

    def _next(self) -> _Token:
        token = self._tokens[self._index]
        if token.kind != "end":
            self._index += 1
        return token

    def _accept(self, kind: str) -> bool:
        if self._peek().kind == kind:
            self._index += 1
            return True
        return False

    def _unexpected(self, token: _Token | None = None) -> InvalidArgument:
        token = token or self._peek()
        if token.kind == "end":
            return filter_error("filter ends unexpectedly", self._field)
        return filter_error(
            f"unexpected {token.text!r} at {token.position}", self._field
        )


def _unquote(text: str) -> str:
    return re.sub(r"\\(.)", r"\1", text[1:-1])


# --- Compilation -----------------------------------------------------------


class FieldType(Enum):
    STRING = "string"
    INT = "int"
    BOOL = "bool"
    TIMESTAMP = "timestamp"
    ENUM = "enum"
    RESOURCE_NAME = "resource name"


type HasCompiler = Callable[[Any], ColumnElement[bool]]


@dataclass(frozen=True, slots=True)
class FilterField:
    """How one filter path maps to SQL.

    ``expression`` is the column (or SQL expression) the path reads. A repeated
    field only supports ``:``; ``has`` builds its condition from the converted
    element value and defaults to ``value = ANY(expression)``.
    """

    expression: ColumnElement[Any]
    type: FieldType
    values: frozenset[str] = frozenset()
    converter: Callable[[str], Any] | None = None
    repeated: bool = False
    has: HasCompiler | None = None


def string(expression: ColumnElement[Any]) -> FilterField:
    return FilterField(expression, FieldType.STRING)


def integer(expression: ColumnElement[Any]) -> FilterField:
    return FilterField(expression, FieldType.INT)


def boolean(expression: ColumnElement[Any]) -> FilterField:
    return FilterField(expression, FieldType.BOOL)


def timestamp(expression: ColumnElement[Any]) -> FilterField:
    return FilterField(expression, FieldType.TIMESTAMP)


def enum(expression: ColumnElement[Any], values: Iterable[str]) -> FilterField:
    return FilterField(expression, FieldType.ENUM, values=frozenset(values))


def resource_name(
    expression: ColumnElement[Any], converter: Callable[[str], Any]
) -> FilterField:
    """A reference compared by name; ``converter`` maps the name to the stored value.

    The converter may return ``None`` (e.g. for ``""``) to match an empty reference,
    and may raise :class:`InvalidArgument` or ``ValueError`` for a malformed name.
    """
    return FilterField(expression, FieldType.RESOURCE_NAME, converter=converter)


def repeated(element: FilterField, *, has: HasCompiler | None = None) -> FilterField:
    """A repeated field of ``element``'s type, filtered with ``field:value``."""
    return FilterField(
        element.expression,
        element.type,
        values=element.values,
        converter=element.converter,
        repeated=True,
        has=has,
    )


class FilterSchema:
    """The filter fields one List method accepts, keyed by lowerCamelCase path."""

    def __init__(
        self, fields: Mapping[str, FilterField], *, field: str = "filter"
    ) -> None:
        self.fields = dict(fields)
        self.field = field

    def compile(self, filter: str | Node | None) -> ColumnElement[bool]:
        """A WHERE condition for ``filter``; an empty filter matches everything."""
        node = (
            parse(filter, field=self.field)
            if filter is None or isinstance(filter, str)
            else filter
        )
        if node is None:
            return true()
        return self._compile(node)

    def _compile(self, node: Node) -> ColumnElement[bool]:
        if isinstance(node, And):
            return sql_and(*(self._compile(operand) for operand in node.operands))
        if isinstance(node, Or):
            return sql_or(*(self._compile(operand) for operand in node.operands))
        if isinstance(node, Not):
            return sql_not(self._compile(node.operand))
        return self._restriction(node)

    def _restriction(self, restriction: Restriction) -> ColumnElement[bool]:
        spec = self.fields.get(restriction.field)
        if spec is None:
            allowed = ", ".join(sorted(self.fields)) or "none"
            raise self._error(
                f"unknown filter field {restriction.field!r}; allowed: {allowed}"
            )
        operator, raw = restriction.operator, restriction.value
        if spec.repeated:
            if operator is not Operator.HAS:
                raise self._error(
                    f"{restriction.field} is repeated; filter it with '{restriction.field}:value'"
                )
            value = self._convert(spec, restriction.field, raw)
            if spec.has is not None:
                return spec.has(value)
            return literal(value) == any_(spec.expression)
        if operator is Operator.HAS:
            raise self._error(
                f"':' applies only to repeated fields, not {restriction.field}"
            )
        if raw.is_null:
            return self._null(spec, restriction.field, operator)
        if operator in _ORDERING and spec.type not in _ORDERED_TYPES:
            raise self._error(f"{restriction.field} only supports '=' and '!='")
        value = self._convert(spec, restriction.field, raw)
        if value is None:
            return self._null(spec, restriction.field, operator)
        return _COMPARE[operator](spec.expression, value)

    def _null(
        self, spec: FilterField, path: str, operator: Operator
    ) -> ColumnElement[bool]:
        if operator is Operator.EQ:
            return spec.expression.is_(None)
        if operator is Operator.NE:
            return spec.expression.is_not(None)
        raise self._error(f"{path} can only be compared with null using '=' or '!='")

    def _convert(self, spec: FilterField, path: str, value: Value) -> Any:
        try:
            return _CONVERTERS[spec.type](spec, value)
        except (InvalidArgument, ValueError) as exc:
            detail = exc.message if isinstance(exc, InvalidArgument) else str(exc)
            raise self._error(f"invalid value for {path}: {detail}") from None

    def _error(self, description: str) -> InvalidArgument:
        return filter_error(description, self.field)


def filter_error(description: str, field: str = "filter") -> InvalidArgument:
    return InvalidArgument(
        f"Invalid {field}: {description}",
        field_violations=(FieldViolation(field, description),),
    )


_ORDERED_TYPES = frozenset({FieldType.STRING, FieldType.INT, FieldType.TIMESTAMP})

_COMPARE: Mapping[
    Operator, Callable[[ColumnElement[Any], Any], ColumnElement[bool]]
] = {
    Operator.EQ: lambda column, value: column == value,
    # Unset (NULL) fields differ from every value, as unset proto fields do.
    Operator.NE: lambda column, value: column.is_distinct_from(value),
    Operator.LT: lambda column, value: column < value,
    Operator.LE: lambda column, value: column <= value,
    Operator.GT: lambda column, value: column > value,
    Operator.GE: lambda column, value: column >= value,
}


def _to_string(_: FilterField, value: Value) -> str:
    return value.text


def _to_int(_: FilterField, value: Value) -> int:
    if not _INTEGER.match(value.text):
        raise ValueError(f"expected an integer, got {value.text!r}")
    number = int(value.text)
    if not INT64_MIN <= number <= INT64_MAX:
        raise ValueError("integer is out of the int64 range")
    return number


def _to_bool(_: FilterField, value: Value) -> bool:
    if value.quoted or value.text not in {"true", "false"}:
        raise ValueError(f"expected true or false, got {value.text!r}")
    return value.text == "true"


def _to_timestamp(_: FilterField, value: Value) -> datetime:
    try:
        parsed = datetime.fromisoformat(value.text)
    except ValueError:
        raise ValueError(
            f"expected an RFC 3339 timestamp, got {value.text!r}"
        ) from None
    if parsed.tzinfo is None:
        raise ValueError(f"timestamp {value.text!r} must carry a UTC offset")
    return parsed.astimezone(UTC)


def _to_enum(spec: FilterField, value: Value) -> str:
    if value.text not in spec.values:
        raise ValueError(
            f"expected one of {', '.join(sorted(spec.values))}, got {value.text!r}"
        )
    return value.text


def _to_reference(spec: FilterField, value: Value) -> Any:
    assert spec.converter is not None
    return spec.converter(value.text)


_CONVERTERS: Mapping[FieldType, Callable[[FilterField, Value], Any]] = {
    FieldType.STRING: _to_string,
    FieldType.INT: _to_int,
    FieldType.BOOL: _to_bool,
    FieldType.TIMESTAMP: _to_timestamp,
    FieldType.ENUM: _to_enum,
    FieldType.RESOURCE_NAME: _to_reference,
}
